/**
 * Obsidian CLI execution layer.
 *
 * All vault access goes through `obsidian <command>` subprocess calls.
 * No filesystem access -- if Obsidian isn't running, the server fails
 * with a clear message.
 *
 * Uses Bun.spawn() with array args (no shell) to prevent injection.
 */

import {
	ObsidianNotRunningError,
	ObsidianCliError,
	type CliFileMetadata,
	type CliSearchResult,
} from "./types.ts";

const CLI_TIMEOUT = 15_000;
const NOT_RUNNING_PATTERNS = [
	"obsidian is not running",
	"could not connect",
	"no running instance",
	"not running",
];

// ---------------------------------------------------------------------------
// Core execution
// ---------------------------------------------------------------------------

/**
 * Execute an Obsidian CLI command. Returns stdout as a string.
 *
 * @param command - CLI command (e.g. "search", "read", "files")
 * @param args - Key-value args assembled into `key=value` pairs.
 *               Boolean `true` produces just `key` (flag).
 *               Undefined/null values are skipped.
 * @param vaultName - Override vault name (defaults to env OBSIDIAN_VAULT)
 */
export async function execObsidian(
	command: string,
	args: Record<string, string | number | boolean | undefined> = {},
	vaultName?: string
): Promise<string> {
	const vault = vaultName ?? process.env.OBSIDIAN_VAULT;
	const cmdArgs = ["obsidian", command];

	// Prepend vault= when set
	if (vault) {
		cmdArgs.push(`vault=${vault}`);
	}

	// Build arg list
	for (const [key, value] of Object.entries(args)) {
		if (value === undefined || value === null) continue;
		if (value === true) {
			cmdArgs.push(key);
		} else if (value !== false) {
			cmdArgs.push(`${key}=${String(value)}`);
		}
	}

	const proc = Bun.spawn(cmdArgs, {
		stdout: "pipe",
		stderr: "pipe",
	});

	const timeout = setTimeout(() => {
		proc.kill();
	}, CLI_TIMEOUT);

	try {
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			const combined = (stderr + stdout).toLowerCase();
			for (const pattern of NOT_RUNNING_PATTERNS) {
				if (combined.includes(pattern)) {
					throw new ObsidianNotRunningError();
				}
			}
			throw new ObsidianCliError(
				`${command} ${Object.entries(args).map(([k, v]) => v === true ? k : `${k}=${v}`).join(" ")}`.trim(),
				stderr || stdout
			);
		}

		// Return stdout, trimmed. Stderr is discarded on success
		// (CLI emits log lines there on every invocation).
		return stdout.trim();
	} finally {
		clearTimeout(timeout);
	}
}

// ---------------------------------------------------------------------------
// Typed parsers
// ---------------------------------------------------------------------------

/**
 * Parse newline-separated list output (files, orphans, backlinks, etc.)
 */
export function parseLines(stdout: string): string[] {
	if (!stdout.trim()) return [];
	return stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * Parse tab-separated key=value output (file metadata).
 * Handles both `key\tvalue` and `key: value` formats.
 */
export function parseTabKV(stdout: string): Record<string, string> {
	const result: Record<string, string> = {};
	if (!stdout.trim()) return result;

	for (const line of stdout.trim().split("\n")) {
		// Try tab-separated first
		const tabIdx = line.indexOf("\t");
		if (tabIdx > 0) {
			result[line.slice(0, tabIdx).trim()] = line.slice(tabIdx + 1).trim();
			continue;
		}
		// Try colon-separated
		const colonIdx = line.indexOf(":");
		if (colonIdx > 0) {
			result[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
			continue;
		}
	}
	return result;
}

/**
 * Parse a single number from stdout (total counts).
 */
export function parseCount(stdout: string): number {
	const n = parseInt(stdout.trim(), 10);
	return isNaN(n) ? 0 : n;
}

/**
 * Parse JSON output (search results with format=json).
 */
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
 * Execute multiple CLI calls in parallel using Promise.allSettled().
 * Critical for compound tools that make 5-7 calls -- wall time stays ~3s.
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
				reason: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
			});
		}
	}

	return map;
}

/**
 * Helper to get a fulfilled value from parallel results, or a fallback.
 */
export function getResult<T>(
	results: Map<string, ParallelResult<T>>,
	key: string,
	fallback: T
): T {
	const r = results.get(key);
	if (r?.status === "fulfilled" && r.value !== undefined) return r.value;
	return fallback;
}
