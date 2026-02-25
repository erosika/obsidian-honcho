/**
 * Shared types, tool schemas, configuration, and error classes
 * for the Obsidian-Honcho MCP Server.
 *
 * 9 tools: 6 pure vault + 3 bridge (obsidian workspace specific).
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ObsidianNotRunningError extends Error {
	constructor() {
		super(
			"No vault access available. Options: " +
			"(1) Start Obsidian with CLI support (1.12+), " +
			"(2) Enable Local REST API plugin, or " +
			"(3) Set OBSIDIAN_VAULT_PATH for direct filesystem access."
		);
		this.name = "ObsidianNotRunningError";
	}
}

export class ObsidianCliError extends Error {
	constructor(command: string, stderr: string) {
		super(`obsidian ${command} failed: ${stderr}`);
		this.name = "ObsidianCliError";
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
		peer: string;
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

	const peer = process.env.HONCHO_PEER ?? "";
	if (!peer) {
		throw new Error("HONCHO_PEER environment variable is required (your identity in Honcho)");
	}

	return {
		honcho: {
			apiKey,
			baseUrl: (process.env.HONCHO_BASE_URL ?? "https://api.honcho.dev").replace(/\/+$/, ""),
			apiVersion: "v3",
			workspace: process.env.HONCHO_WORKSPACE ?? "",
			peer,
		},
		obsidian: {
			vault: process.env.OBSIDIAN_VAULT || undefined,
		},
	};
}

// ---------------------------------------------------------------------------
// Tool input types
// ---------------------------------------------------------------------------

export interface VaultReadInput {
	file: string;
}

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

export interface VaultSearchInput {
	query: string;
	limit?: number;
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

export interface VaultClassifyInput {
	file: string;
	scope?: "tags" | "title" | "connections" | "full";
}

export interface VaultReflectInput {
	file: string;
}

// ---------------------------------------------------------------------------
// Tool schemas (9 tools)
// ---------------------------------------------------------------------------

export const TOOL_SCHEMAS = [
	// -- Pure vault tools (6) --
	{
		name: "vault_read",
		description: "Read the raw content of a note from the vault.",
		inputSchema: {
			type: "object" as const,
			properties: {
				file: { type: "string", description: "Note name or path (without .md extension)" },
			},
			required: ["file"],
		},
	},
	{
		name: "vault_write",
		description:
			"Write operations: create, append, prepend, set/remove properties, " +
			"move, delete, bookmark, or append to daily note.",
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
	{
		name: "vault_search",
		description: "Keyword search across the vault. For semantic search, use the Honcho MCP (mcp.honcho.dev).",
		inputSchema: {
			type: "object" as const,
			properties: {
				query: { type: "string", description: "Search query" },
				limit: { type: "number", description: "Max results. Default: 10" },
			},
			required: ["query"],
		},
	},
	{
		name: "vault_info",
		description:
			"Complete note intelligence: metadata, graph position (backlinks, outgoing links), " +
			"structure (outline, headings), properties, tags, and aliases. 7 calls in parallel.",
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

	// -- Bridge tools (3) -- obsidian workspace specific --
	{
		name: "vault_classify",
		description:
			"Ask Honcho to suggest tags, title, or connections for a vault note. " +
			"Uses peerChat on the obsidian workspace, so Honcho has the full context " +
			"of the user's ingested vault content. Requires the note to be ingested first.",
		inputSchema: {
			type: "object" as const,
			properties: {
				file: { type: "string", description: "Note name or path" },
				scope: {
					type: "string",
					enum: ["tags", "title", "connections", "full"],
					description: "What to classify. Default: tags",
				},
			},
			required: ["file"],
		},
	},
	{
		name: "vault_reflect",
		description:
			"Get Honcho's obsidian workspace perspective on a note: direct conclusions " +
			"from that note's session, semantically related conclusions from across " +
			"the vault, and a representation focused through the note's content.",
		inputSchema: {
			type: "object" as const,
			properties: {
				file: { type: "string", description: "Note name or path" },
			},
			required: ["file"],
		},
	},
	{
		name: "vault_status",
		description:
			"Overview of the obsidian workspace state in Honcho: vault file counts, " +
			"ingested session counts, coverage percentage, conclusion totals, " +
			"and processing queue status.",
		inputSchema: {
			type: "object" as const,
			properties: {},
		},
	},
] as const;
