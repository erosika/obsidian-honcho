/**
 * Shared types, tool schemas, configuration, and error classes
 * for the Unified Intelligence MCP Server.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ObsidianNotRunningError extends Error {
	constructor() {
		super("Obsidian is not running. Start Obsidian and try again.");
		this.name = "ObsidianNotRunningError";
	}
}

export class ObsidianCliError extends Error {
	constructor(command: string, stderr: string) {
		super(`obsidian ${command} failed: ${stderr}`);
		this.name = "ObsidianCliError";
	}
}

export class HonchoApiError extends Error {
	constructor(status: number, body: string) {
		super(`Honcho API ${status}: ${body}`);
		this.name = "HonchoApiError";
	}
}

export class ToolInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolInputError";
	}
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ServerConfig {
	honcho: {
		apiKey: string;
		baseUrl: string;
		apiVersion: string;
		workspace: string;
		observer: string;
		observed: string;
	};
	obsidian: {
		vault: string | undefined;
	};
}

export function loadConfig(): ServerConfig {
	const apiKey = process.env.HONCHO_API_KEY ?? "";
	if (!apiKey) {
		throw new Error("HONCHO_API_KEY environment variable is required");
	}

	return {
		honcho: {
			apiKey,
			baseUrl: (process.env.HONCHO_BASE_URL ?? "https://api.honcho.dev").replace(/\/+$/, ""),
			apiVersion: "v3",
			workspace: process.env.HONCHO_WORKSPACE ?? "",
			observer: process.env.HONCHO_OBSERVER ?? "obsidian",
			observed: process.env.HONCHO_OBSERVED ?? process.env.HONCHO_OBSERVER ?? "obsidian",
		},
		obsidian: {
			vault: process.env.OBSIDIAN_VAULT || undefined,
		},
	};
}

// ---------------------------------------------------------------------------
// CLI output types
// ---------------------------------------------------------------------------

export interface CliFileMetadata {
	name: string;
	path: string;
	folder: string;
	ext: string;
	size: number;
	created: string;
	modified: string;
	[key: string]: string | number;
}

export interface CliSearchResult {
	file: string;
	matches: Array<{
		line: number;
		content: string;
	}>;
}

// ---------------------------------------------------------------------------
// Tool input types
// ---------------------------------------------------------------------------

export interface VaultSearchInput {
	query: string;
	limit?: number;
	source?: "both" | "vault" | "honcho";
}

export interface VaultReadInput {
	file: string;
}

export interface VaultInfoInput {
	file: string;
}

export interface VaultListInput {
	folder?: string;
	ext?: string;
	total?: boolean;
}

export interface VaultGraphInput {
	include?: Array<"orphans" | "deadends" | "unresolved" | "tags" | "recents" | "tasks">;
}

export interface VaultIngestInput {
	mode?: "file" | "folder" | "linked" | "smart";
	target?: string;
	depth?: number;
	limit?: number;
	dream?: boolean;
}

export interface VaultMemoryInput {
	action: "search" | "conclusions" | "representation" | "card" | "context";
	query?: string;
	limit?: number;
}

export interface VaultStatusInput {}

export interface VaultDreamInput {
	session_id?: string;
}

export interface VaultChatInput {
	query: string;
	reasoning_level?: "minimal" | "low" | "medium" | "high" | "max";
	context_file?: string;
}

export interface VaultSyncInput {
	direction?: "pull" | "push" | "both";
	push_file?: string;
}

export interface VaultContextualizeInput {
	file: string;
}

export interface VaultAnalyzeInput {}

export interface VaultWriteInput {
	action: "create" | "append" | "prepend" | "property_set" | "property_remove" | "move" | "delete" | "bookmark" | "daily_append";
	file?: string;
	content?: string;
	template?: string;
	overwrite?: boolean;
	name?: string;
	value?: string;
	property_type?: string;
	to?: string;
	permanent?: boolean;
	inline?: boolean;
}

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

export const TOOL_SCHEMAS = [
	{
		name: "vault_search",
		description:
			"Combined search across Obsidian's keyword index and Honcho's semantic memory. " +
			"Returns vault keyword matches, semantic message matches, and related conclusions in parallel.",
		inputSchema: {
			type: "object" as const,
			properties: {
				query: { type: "string", description: "Search query" },
				limit: { type: "number", description: "Max results per source. Default: 10" },
				source: {
					type: "string",
					enum: ["both", "vault", "honcho"],
					description: "Search source. Default: both",
				},
			},
			required: ["query"],
		},
	},
	{
		name: "vault_read",
		description: "Read the raw content of a note from the vault via Obsidian CLI.",
		inputSchema: {
			type: "object" as const,
			properties: {
				file: { type: "string", description: "Note name or path (without .md extension)" },
			},
			required: ["file"],
		},
	},
	{
		name: "vault_info",
		description:
			"Complete note intelligence: metadata, graph position (backlinks, outgoing links), " +
			"structure (outline, headings), properties, tags, and aliases. 7 CLI calls in parallel.",
		inputSchema: {
			type: "object" as const,
			properties: {
				file: { type: "string", description: "Note name or path" },
			},
			required: ["file"],
		},
	},
	{
		name: "vault_list",
		description: "List files in the vault, optionally filtered by folder or extension.",
		inputSchema: {
			type: "object" as const,
			properties: {
				folder: { type: "string", description: "Folder path to list" },
				ext: { type: "string", description: "File extension filter (e.g. 'md')" },
				total: { type: "boolean", description: "Return only the total count" },
			},
		},
	},
	{
		name: "vault_graph",
		description:
			"Vault-wide structural health report. Selected analyses in parallel: orphans, deadends, " +
			"unresolved links, tag distribution, recent files, pending tasks, file counts.",
		inputSchema: {
			type: "object" as const,
			properties: {
				include: {
					type: "array",
					items: {
						type: "string",
						enum: ["orphans", "deadends", "unresolved", "tags", "recents", "tasks"],
					},
					description: "Analyses to include. Default: all.",
				},
			},
		},
	},
	{
		name: "vault_ingest",
		description:
			"CLI-enriched ingestion into Honcho. Modes: file (single note), folder (all .md in folder), " +
			"linked (BFS through outgoing links), smart (diff vault vs Honcho, prioritize un-ingested/stale).",
		inputSchema: {
			type: "object" as const,
			properties: {
				mode: {
					type: "string",
					enum: ["file", "folder", "linked", "smart"],
					description: "Ingestion mode. Default: file",
				},
				target: { type: "string", description: "File or folder name to ingest" },
				depth: { type: "number", description: "Link traversal depth for mode=linked. Default: 1" },
				limit: { type: "number", description: "Max files for mode=smart. Default: 20" },
				dream: { type: "boolean", description: "Schedule dream after ingestion. Default: true" },
			},
		},
	},
	{
		name: "vault_memory",
		description:
			"Direct access to Honcho memory: search conclusions, list conclusions, get peer representation, " +
			"get peer card, or get full peer context.",
		inputSchema: {
			type: "object" as const,
			properties: {
				action: {
					type: "string",
					enum: ["search", "conclusions", "representation", "card", "context"],
					description: "Memory action to perform",
				},
				query: { type: "string", description: "Search query (required for action=search)" },
				limit: { type: "number", description: "Max results. Default: 10" },
			},
			required: ["action"],
		},
	},
	{
		name: "vault_status",
		description:
			"Overview of workspace state: Honcho sessions, queue progress, vault info, and file counts.",
		inputSchema: {
			type: "object" as const,
			properties: {},
		},
	},
	{
		name: "vault_dream",
		description:
			"Trigger Honcho's dream process to consolidate observations into higher-order conclusions. " +
			"Optionally scope to a specific session.",
		inputSchema: {
			type: "object" as const,
			properties: {
				session_id: { type: "string", description: "Optional session ID to scope the dream" },
			},
		},
	},
	{
		name: "vault_chat",
		description:
			"Auto-contextualized chat: searches the vault via CLI for relevant context, " +
			"augments the query with vault metadata, and sends to Honcho's dialectic reasoning. " +
			"Optionally scoped to a specific note for deeper context.",
		inputSchema: {
			type: "object" as const,
			properties: {
				query: { type: "string", description: "Question or prompt" },
				reasoning_level: {
					type: "string",
					enum: ["minimal", "low", "medium", "high", "max"],
					description: "Reasoning depth. Default: medium",
				},
				context_file: { type: "string", description: "Note to use as primary context" },
			},
			required: ["query"],
		},
	},
	{
		name: "vault_sync",
		description:
			"Sync between vault and Honcho. Pull: writes identity + conclusions notes to vault via CLI. " +
			"Push: reads a note and sets it as the peer card. Both: pull then push.",
		inputSchema: {
			type: "object" as const,
			properties: {
				direction: {
					type: "string",
					enum: ["pull", "push", "both"],
					description: "Sync direction. Default: pull",
				},
				push_file: { type: "string", description: "Note to push as peer card (required for push/both)" },
			},
		},
	},
	{
		name: "vault_contextualize",
		description:
			"Compound view of a note: structural position (CLI metadata, backlinks, links, outline, " +
			"properties, tags) + semantic perspective (Honcho representation, conclusions, ingestion status). " +
			"10 calls in parallel across CLI and Honcho API.",
		inputSchema: {
			type: "object" as const,
			properties: {
				file: { type: "string", description: "Note name or path" },
			},
			required: ["file"],
		},
	},
	{
		name: "vault_analyze",
		description:
			"Full intelligence report: vault graph health (orphans, deadends, unresolved), " +
			"knowledge coverage (ingested vs un-ingested), tag distribution, queue status. " +
			"Parallel CLI + Honcho API calls.",
		inputSchema: {
			type: "object" as const,
			properties: {},
		},
	},
	{
		name: "vault_write",
		description:
			"Write operations via Obsidian CLI: create, append, prepend, set/remove properties, " +
			"move, delete, bookmark, or append to daily note. Uses safe subprocess execution.",
		inputSchema: {
			type: "object" as const,
			properties: {
				action: {
					type: "string",
					enum: ["create", "append", "prepend", "property_set", "property_remove", "move", "delete", "bookmark", "daily_append"],
					description: "Write action to perform",
				},
				file: { type: "string", description: "Target file name or path" },
				content: { type: "string", description: "Content for create/append/prepend/daily_append" },
				template: { type: "string", description: "Template name for create" },
				overwrite: { type: "boolean", description: "Overwrite existing file on create" },
				name: { type: "string", description: "Property name for property_set/property_remove" },
				value: { type: "string", description: "Property value for property_set" },
				property_type: { type: "string", description: "Property type for property_set (text, number, date, etc.)" },
				to: { type: "string", description: "Destination path for move" },
				permanent: { type: "boolean", description: "Permanently delete (bypass trash) for delete" },
				inline: { type: "boolean", description: "Insert inline (no newline) for append/prepend" },
			},
			required: ["action"],
		},
	},
] as const;
