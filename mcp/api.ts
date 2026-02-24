/**
 * Unified Obsidian API -- routes through CLI, REST, or filesystem.
 *
 * All tools import from this module. The transport is auto-detected on first
 * call and cached. Priority: CLI > REST > filesystem.
 *
 * Force a transport via OBSIDIAN_TRANSPORT=cli|rest|fs (default: auto).
 *
 * Environment variables:
 *   OBSIDIAN_TRANSPORT    - auto|cli|rest|fs. Default: auto.
 *   OBSIDIAN_VAULT_PATH   - Absolute path to vault directory (required for fs fallback).
 *   OBSIDIAN_REST_URL     - Default: http://127.0.0.1:27123
 *   OBSIDIAN_REST_KEY     - API key from Local REST API plugin.
 */

import { execCli } from "./cli.ts";
import { execRest } from "./rest.ts";
import { execFs, probeFs, setVaultPath } from "./fs.ts";
import { ObsidianNotRunningError } from "./types.ts";

// ---------------------------------------------------------------------------
// Transport detection
// ---------------------------------------------------------------------------

type Transport = "auto" | "cli" | "rest" | "fs";

let transport: Transport = (process.env.OBSIDIAN_TRANSPORT as Transport) || "auto";
let resolved: "cli" | "rest" | "fs" | null = null;

const CLI_PROBE_TIMEOUT = 5_000;

/**
 * Probe CLI availability by running `obsidian version` with a short timeout.
 */
async function probeCli(): Promise<boolean> {
	try {
		const result = await execCli("version", {}, undefined, CLI_PROBE_TIMEOUT);
		if (result && !result.includes("Loading updated app package")) {
			return true;
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * Probe REST availability by hitting GET /.
 */
async function probeRest(): Promise<boolean> {
	try {
		await execRest("vault", {});
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolve which transport to use. Called once, result cached.
 */
async function resolveTransport(): Promise<"cli" | "rest" | "fs"> {
	if (resolved) return resolved;

	// Initialize filesystem path if provided
	const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
	if (vaultPath) setVaultPath(vaultPath);

	// Explicit transport override
	if (transport === "cli") { resolved = "cli"; return resolved; }
	if (transport === "rest") { resolved = "rest"; return resolved; }
	if (transport === "fs") {
		if (await probeFs()) {
			resolved = "fs";
			console.error("[obsidian-honcho] Transport: filesystem");
			return resolved;
		}
		throw new Error("Filesystem transport requested but vault path is invalid or unset. Set OBSIDIAN_VAULT_PATH.");
	}

	// Auto: CLI > REST > filesystem
	if (await probeCli()) {
		resolved = "cli";
		console.error("[obsidian-honcho] Transport: CLI");
		return resolved;
	}

	if (await probeRest()) {
		resolved = "rest";
		console.error("[obsidian-honcho] Transport: REST (CLI unavailable)");
		return resolved;
	}

	if (await probeFs()) {
		resolved = "fs";
		console.error("[obsidian-honcho] Transport: filesystem (CLI and REST unavailable)");
		return resolved;
	}

	throw new ObsidianNotRunningError();
}

// ---------------------------------------------------------------------------
// Unified execution
// ---------------------------------------------------------------------------

/**
 * Execute an Obsidian command. Routes to CLI, REST, or filesystem.
 */
export async function execObsidian(
	command: string,
	args: Record<string, string | number | boolean | undefined> = {},
	vaultName?: string
): Promise<string> {
	const t = await resolveTransport();

	if (t === "cli") {
		try {
			return await execCli(command, args, vaultName);
		} catch (err) {
			// If CLI breaks mid-session, try fallbacks
			if (err instanceof ObsidianNotRunningError && transport === "auto") {
				const restOk = await probeRest();
				if (restOk) {
					resolved = "rest";
					console.error("[obsidian-honcho] CLI failed mid-session, switching to REST");
					return execRest(command, args, vaultName);
				}
				const fsOk = await probeFs();
				if (fsOk) {
					resolved = "fs";
					console.error("[obsidian-honcho] CLI failed mid-session, switching to filesystem");
					return execFs(command, args, vaultName);
				}
			}
			throw err;
		}
	}

	if (t === "rest") {
		try {
			return await execRest(command, args, vaultName);
		} catch (err) {
			// If REST breaks mid-session, try filesystem
			if (err instanceof ObsidianNotRunningError && transport === "auto") {
				const fsOk = await probeFs();
				if (fsOk) {
					resolved = "fs";
					console.error("[obsidian-honcho] REST failed mid-session, switching to filesystem");
					return execFs(command, args, vaultName);
				}
			}
			throw err;
		}
	}

	return execFs(command, args, vaultName);
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/** Parse newline-separated list output */
export function parseLines(stdout: string): string[] {
	if (!stdout.trim()) return [];
	return stdout
		.trim()
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

/** Parse tab-separated or colon-separated key=value output */
export function parseTabKV(stdout: string): Record<string, string> {
	const result: Record<string, string> = {};
	if (!stdout.trim()) return result;
	for (const line of stdout.trim().split("\n")) {
		const tabIdx = line.indexOf("\t");
		if (tabIdx > 0) {
			result[line.slice(0, tabIdx).trim()] = line.slice(tabIdx + 1).trim();
			continue;
		}
		const colonIdx = line.indexOf(":");
		if (colonIdx > 0) {
			result[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
			continue;
		}
	}
	return result;
}

/** Parse a single number from stdout */
export function parseCount(stdout: string): number {
	const n = parseInt(stdout.trim(), 10);
	return isNaN(n) ? 0 : n;
}

/** Parse JSON output */
export function parseJSON<T>(stdout: string): T {
	return JSON.parse(stdout) as T;
}

// ---------------------------------------------------------------------------
// Parallel execution
// ---------------------------------------------------------------------------

export interface ParallelResult<T> {
	key: string;
	status: "fulfilled" | "rejected";
	value?: T;
	reason?: string;
}

/**
 * Execute multiple calls in parallel using Promise.allSettled().
 */
export async function execParallel<T>(
	calls: Array<{ key: string; fn: () => Promise<T> }>
): Promise<Map<string, ParallelResult<T>>> {
	const results = await Promise.allSettled(calls.map((c) => c.fn()));
	const map = new Map<string, ParallelResult<T>>();

	for (let i = 0; i < calls.length; i++) {
		const settled = results[i];
		if (settled.status === "fulfilled") {
			map.set(calls[i].key, {
				key: calls[i].key,
				status: "fulfilled",
				value: settled.value,
			});
		} else {
			map.set(calls[i].key, {
				key: calls[i].key,
				status: "rejected",
				reason:
					settled.reason instanceof Error
						? settled.reason.message
						: String(settled.reason),
			});
		}
	}

	return map;
}

/** Helper to get a fulfilled value from parallel results, or a fallback. */
export function getResult<T>(
	results: Map<string, ParallelResult<T>>,
	key: string,
	fallback: T
): T {
	const r = results.get(key);
	if (r?.status === "fulfilled" && r.value !== undefined) return r.value;
	return fallback;
}
