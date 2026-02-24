// ---------------------------------------------------------------------------
// Shared global config: ~/.honcho/config.json
// Same file used by cursor-honcho and claude-honcho.
// Obsidian reads from the "obsidian" host block.
//
// Uses dynamic require() for Node builtins -- Electron provides them at
// runtime but esbuild can't resolve them as static imports.
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require("fs") as typeof import("fs");
const nodePath = require("path") as typeof import("path");
const os = require("os") as typeof import("os");

const CONFIG_DIR = nodePath.join(os.homedir(), ".honcho");
const CONFIG_FILE = nodePath.join(CONFIG_DIR, "config.json");

interface HostBlock {
	workspace?: string;
	aiPeer?: string;
}

interface GlobalConfig {
	apiKey?: string;
	peerName?: string;
	hosts?: Record<string, HostBlock>;
	endpoint?: {
		environment?: "production" | "local";
		baseUrl?: string;
	};
	// Preserve any fields written by cursor-honcho / claude-honcho
	[key: string]: unknown;
}

export interface GlobalDefaults {
	apiKey?: string;
	peerName?: string;
	workspace?: string;
	baseUrl?: string;
}

/**
 * Read ~/.honcho/config.json and extract defaults for the obsidian host.
 * Returns only defined values -- caller merges over plugin defaults.
 * Never throws; returns empty object on any failure.
 */
export function loadGlobalDefaults(): GlobalDefaults {
	if (!fs.existsSync(CONFIG_FILE)) return {};

	try {
		const raw: GlobalConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
		const host = raw.hosts?.["obsidian"];
		const defaults: GlobalDefaults = {};

		if (raw.apiKey) defaults.apiKey = raw.apiKey;
		if (raw.peerName) defaults.peerName = raw.peerName;
		if (host?.workspace) defaults.workspace = host.workspace;

		// Resolve base URL from endpoint config
		if (raw.endpoint?.baseUrl) {
			defaults.baseUrl = raw.endpoint.baseUrl.replace(/\/v3\/?$/, "");
		} else if (raw.endpoint?.environment === "local") {
			defaults.baseUrl = "http://localhost:8000";
		}

		return defaults;
	} catch {
		return {};
	}
}

/**
 * Read-merge-write: reads existing ~/.honcho/config.json, merges in the
 * obsidian host block and shared fields, writes back. Creates the file
 * and directory if they don't exist.
 *
 * Same pattern as cursor-honcho's saveConfig() -- each plugin only
 * touches its own host block + shared fields. Other hosts' blocks are
 * preserved untouched.
 *
 * Never throws; silently fails on write errors.
 */
export function saveGlobalConfig(settings: {
	apiKey: string;
	peerName: string;
	workspace: string;
	baseUrl?: string;
}): void {
	try {
		// Ensure directory
		if (!fs.existsSync(CONFIG_DIR)) {
			fs.mkdirSync(CONFIG_DIR, { recursive: true });
		}

		// Read existing (preserves other hosts' blocks)
		let existing: GlobalConfig = {};
		if (fs.existsSync(CONFIG_FILE)) {
			try {
				existing = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
			} catch {
				// Corrupt file -- start fresh but don't clobber, merge below
			}
		}

		// Merge shared fields
		existing.apiKey = settings.apiKey;
		existing.peerName = settings.peerName;

		// Write obsidian host block (never touch cursor/claude_code blocks)
		if (!existing.hosts) existing.hosts = {};
		existing.hosts["obsidian"] = {
			workspace: settings.workspace,
		};

		// Sync endpoint if non-default
		if (settings.baseUrl && settings.baseUrl !== "https://api.honcho.dev") {
			if (!existing.endpoint) existing.endpoint = {};
			existing.endpoint.baseUrl = settings.baseUrl;
		}

		fs.writeFileSync(CONFIG_FILE, JSON.stringify(existing, null, 2));
	} catch {
		// Best-effort: don't break the plugin if filesystem write fails
	}
}
