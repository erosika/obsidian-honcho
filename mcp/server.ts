#!/usr/bin/env bun
/**
 * Honcho Vault MCP Server
 *
 * A standalone MCP server that bridges an Obsidian vault on disk
 * with Honcho's identity/memory platform. Usable by any MCP client
 * (Claude Code, Claude Desktop, etc.).
 *
 * Environment variables:
 *   HONCHO_API_KEY     - Required. Honcho API key.
 *   HONCHO_BASE_URL    - Optional. Default: https://api.honcho.dev
 *   HONCHO_WORKSPACE   - Optional. Default: vault directory name.
 *   HONCHO_OBSERVER    - Optional. Observer peer. Default: obsidian.
 *   HONCHO_OBSERVED    - Optional. Observed peer. Default: same as observer.
 *   VAULT_PATH         - Required. Absolute path to the Obsidian vault.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HONCHO_API_KEY = process.env.HONCHO_API_KEY ?? "";
const HONCHO_BASE_URL = (process.env.HONCHO_BASE_URL ?? "https://api.honcho.dev").replace(/\/+$/, "");
const API_VERSION = "v3";
const VAULT_PATH = process.env.VAULT_PATH ?? "";
const WORKSPACE = process.env.HONCHO_WORKSPACE ?? (VAULT_PATH ? path.basename(VAULT_PATH) : "default");
const OBSERVER = process.env.HONCHO_OBSERVER ?? "obsidian";
const OBSERVED = process.env.HONCHO_OBSERVED ?? OBSERVER;

// ---------------------------------------------------------------------------
// Honcho HTTP helpers
// ---------------------------------------------------------------------------

async function honchoRequest<T>(
	method: string,
	apiPath: string,
	body?: unknown,
	query?: Record<string, string | number | undefined>
): Promise<T> {
	let url = `${HONCHO_BASE_URL}/${API_VERSION}${apiPath}`;

	if (query) {
		const params = new URLSearchParams();
		for (const [k, v] of Object.entries(query)) {
			if (v !== undefined) params.set(k, String(v));
		}
		const qs = params.toString();
		if (qs) url += `?${qs}`;
	}

	const resp = await fetch(url, {
		method,
		headers: {
			Authorization: `Bearer ${HONCHO_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: body ? JSON.stringify(body) : undefined,
	});

	if (!resp.ok) {
		throw new Error(`Honcho API ${resp.status}: ${await resp.text()}`);
	}

	if (resp.status === 204 || resp.headers.get("content-length") === "0") {
		return undefined as T;
	}

	return (await resp.json()) as T;
}

// ---------------------------------------------------------------------------
// Vault helpers
// ---------------------------------------------------------------------------

function getMarkdownFiles(dir: string, recursive = true): string[] {
	const results: string[] = [];
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory() && recursive && !entry.name.startsWith(".")) {
				results.push(...getMarkdownFiles(full, true));
			} else if (entry.isFile() && entry.name.endsWith(".md")) {
				results.push(full);
			}
		}
	} catch {
		// Skip inaccessible directories
	}
	return results;
}

interface Frontmatter {
	[key: string]: unknown;
}

function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
	const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) return { frontmatter: {}, body: content };

	const fm: Frontmatter = {};
	for (const line of match[1].split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx > 0) {
			const key = line.slice(0, colonIdx).trim();
			const value = line.slice(colonIdx + 1).trim();
			fm[key] = value;
		}
	}
	return { frontmatter: fm, body: match[2] };
}

function chunkText(text: string, maxLen = 2000): string[] {
	const stripped = text.replace(/^---[\s\S]*?---\n*/, "");
	if (stripped.trim().length === 0) return [];

	const sections = stripped.split(/(?=^#{1,6}\s)/m).filter((s) => s.trim());
	const chunks: string[] = [];

	for (const section of sections) {
		if (section.length <= maxLen) {
			chunks.push(section.trim());
		} else {
			const paragraphs = section.split(/\n{2,}/);
			let buf = "";
			for (const para of paragraphs) {
				if (buf.length + para.length + 2 > maxLen && buf) {
					chunks.push(buf.trim());
					buf = "";
				}
				buf += (buf ? "\n\n" : "") + para;
			}
			if (buf.trim()) chunks.push(buf.trim());
		}
	}

	return chunks.filter((c) => c.length > 0);
}

function relPath(filePath: string): string {
	return path.relative(VAULT_PATH, filePath);
}

function extractTags(content: string): string[] {
	const tags = new Set<string>();
	// Inline tags
	const inline = content.match(/#[a-zA-Z][\w/-]*/g) ?? [];
	for (const t of inline) tags.add(t);
	// Frontmatter tags
	const { frontmatter } = parseFrontmatter(content);
	const fmTags = frontmatter.tags;
	if (typeof fmTags === "string") {
		for (const t of fmTags.split(",").map((s: string) => s.trim())) {
			if (t) tags.add(t.startsWith("#") ? t : "#" + t);
		}
	}
	return [...tags];
}

function extractLinks(content: string): string[] {
	const links: string[] = [];
	const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
	let m;
	while ((m = re.exec(content)) !== null) {
		links.push(m[1]);
	}
	return links;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

async function ensureInitialized(): Promise<void> {
	await honchoRequest("POST", "/workspaces", { id: WORKSPACE });
	await honchoRequest("POST", `/workspaces/${WORKSPACE}/peers`, {
		id: OBSERVER,
		configuration: { observe_me: OBSERVER === OBSERVED },
	});
	if (OBSERVED !== OBSERVER) {
		await honchoRequest("POST", `/workspaces/${WORKSPACE}/peers`, {
			id: OBSERVED,
			configuration: { observe_me: true },
		});
	}
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function vaultIngest(filePath: string): Promise<string> {
	const fullPath = path.isAbsolute(filePath) ? filePath : path.join(VAULT_PATH, filePath);
	if (!fs.existsSync(fullPath)) return `File not found: ${filePath}`;

	const content = fs.readFileSync(fullPath, "utf-8");
	const chunks = chunkText(content);
	if (chunks.length === 0) return `Nothing to ingest from ${filePath}`;

	const rel = relPath(fullPath);
	const sessionId = `obsidian:file:${rel}`;
	const tags = extractTags(content);
	const links = extractLinks(content);

	// Get or create session
	const session = await honchoRequest<{ id: string }>(
		"POST",
		`/workspaces/${WORKSPACE}/sessions`,
		{
			id: sessionId,
			peers: {
				[OBSERVER]: { observe_me: false, observe_others: true },
				[OBSERVED]: { observe_me: true, observe_others: false },
			},
		}
	);

	// Update session metadata
	const stat = fs.statSync(fullPath);
	await honchoRequest("PUT", `/workspaces/${WORKSPACE}/sessions/${session.id}`, {
		metadata: {
			source: "obsidian",
			source_type: "file",
			file_path: rel,
			file_name: path.basename(fullPath, ".md"),
			folder: path.dirname(rel),
			tags,
			outgoing_links: links,
			created_at: stat.birthtime.toISOString(),
			modified_at: stat.mtime.toISOString(),
			ingested_at: new Date().toISOString(),
		},
		configuration: {
			reasoning: { enabled: true },
			dream: { enabled: true },
			summary: { enabled: true },
		},
	});

	// Build structural preamble
	const preamble = [
		`[Note: ${path.basename(fullPath, ".md")}]`,
		`Path: ${rel}`,
		tags.length > 0 ? `Tags: ${tags.join(", ")}` : null,
		links.length > 0 ? `Links to: ${links.join(", ")}` : null,
		`Created: ${stat.birthtime.toISOString().split("T")[0]}`,
		`Modified: ${stat.mtime.toISOString().split("T")[0]}`,
	]
		.filter(Boolean)
		.join("\n");

	const messages = [
		{
			peer_id: OBSERVED,
			content: preamble,
			metadata: { source_file: rel, message_type: "structural_context" },
			created_at: stat.birthtime.toISOString(),
		},
		...chunks.map((chunk, i) => ({
			peer_id: OBSERVED,
			content: chunk,
			metadata: {
				source_file: rel,
				message_type: "content",
				chunk_index: i,
				chunk_total: chunks.length,
			},
			created_at: stat.mtime.toISOString(),
		})),
	];

	const created = await honchoRequest<unknown[]>(
		"POST",
		`/workspaces/${WORKSPACE}/sessions/${session.id}/messages`,
		{ messages }
	);

	return `Ingested ${rel}: ${created.length} messages into session ${session.id}`;
}

async function vaultIngestFolder(folderPath: string): Promise<string> {
	const fullPath = path.isAbsolute(folderPath) ? folderPath : path.join(VAULT_PATH, folderPath);
	if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) {
		return `Folder not found: ${folderPath}`;
	}

	const files = getMarkdownFiles(fullPath, false);
	if (files.length === 0) return `No markdown files in ${folderPath}`;

	const results: string[] = [];
	for (const file of files) {
		const result = await vaultIngest(file);
		results.push(result);
	}

	// Schedule a dream after bulk ingestion
	try {
		await honchoRequest("POST", `/workspaces/${WORKSPACE}/schedule_dream`, {
			observer: OBSERVER,
			observed: OBSERVED,
			dream_type: "omni",
		});
		results.push("Dream scheduled for post-ingestion processing");
	} catch {
		// best effort
	}

	return results.join("\n");
}

async function vaultSearch(query: string): Promise<string> {
	// Search both messages and conclusions
	const [messages, conclusions] = await Promise.all([
		honchoRequest<Array<{ content: string; metadata: Record<string, unknown> }>>(
			"POST",
			`/workspaces/${WORKSPACE}/search`,
			{ query, limit: 10 }
		),
		honchoRequest<Array<{ content: string; created_at: string }>>(
			"POST",
			`/workspaces/${WORKSPACE}/conclusions/query`,
			{ query, top_k: 10 }
		),
	]);

	const parts: string[] = [];

	if (conclusions.length > 0) {
		parts.push("## Conclusions");
		for (const c of conclusions) {
			parts.push(`- ${c.content}`);
		}
	}

	if (messages.length > 0) {
		parts.push("## Messages");
		for (const m of messages) {
			const source = m.metadata?.source_file ?? "unknown";
			parts.push(`- [${source}] ${m.content.slice(0, 200)}${m.content.length > 200 ? "..." : ""}`);
		}
	}

	if (parts.length === 0) return "No results found.";
	return parts.join("\n");
}

async function vaultStatus(): Promise<string> {
	const [sessions, queueStatus] = await Promise.all([
		honchoRequest<{ items: Array<{ id: string; metadata: Record<string, unknown>; is_active: boolean }>; total: number }>(
			"POST",
			`/workspaces/${WORKSPACE}/sessions/list`,
			{ filters: { source: "obsidian" } },
			{ page: 1, size: 10 }
		),
		honchoRequest<{
			total_work_units: number;
			completed_work_units: number;
			in_progress_work_units: number;
			pending_work_units: number;
		}>(
			"GET",
			`/workspaces/${WORKSPACE}/queue/status`,
			undefined,
			{ observer_id: OBSERVER }
		).catch(() => null),
	]);

	const parts: string[] = [
		`Workspace: ${WORKSPACE}`,
		`Observer: ${OBSERVER}`,
		`Observed: ${OBSERVED}`,
		`Vault: ${VAULT_PATH}`,
		"",
		`## Sessions (${sessions.total} total)`,
	];

	for (const s of sessions.items) {
		const name = (s.metadata.file_name as string) || s.id;
		const status = s.is_active ? "active" : "inactive";
		parts.push(`- ${name} [${status}]`);
	}

	if (queueStatus) {
		parts.push(
			"",
			"## Queue",
			`Total: ${queueStatus.total_work_units}`,
			`Completed: ${queueStatus.completed_work_units}`,
			`In progress: ${queueStatus.in_progress_work_units}`,
			`Pending: ${queueStatus.pending_work_units}`
		);
	}

	return parts.join("\n");
}

async function vaultSync(): Promise<string> {
	// Pull representation and conclusions, write to vault files
	const [repResp, cardResp, conclusionsResp] = await Promise.all([
		honchoRequest<{ representation: string }>(
			"POST",
			`/workspaces/${WORKSPACE}/peers/${OBSERVED}/representation`,
			{}
		).catch(() => ({ representation: "" })),
		honchoRequest<{ peer_card: string[] | null }>(
			"GET",
			`/workspaces/${WORKSPACE}/peers/${OBSERVED}/card`
		).catch(() => ({ peer_card: null })),
		honchoRequest<{ items: Array<{ content: string; created_at: string }> }>(
			"POST",
			`/workspaces/${WORKSPACE}/conclusions/list`,
			{},
			{ page: 1, size: 50 }
		),
	]);

	const results: string[] = [];

	// Write identity note
	const identityLines: string[] = [
		"---",
		`honcho_generated: ${new Date().toISOString()}`,
		`honcho_peer: ${OBSERVED}`,
		"---",
		"",
	];

	if (cardResp.peer_card && cardResp.peer_card.length > 0) {
		identityLines.push("## Peer Card", "");
		for (const item of cardResp.peer_card) {
			identityLines.push(`- ${item}`);
		}
		identityLines.push("");
	}

	if (repResp.representation) {
		identityLines.push("## Representation", "");
		identityLines.push(repResp.representation, "");
	}

	const identityPath = path.join(VAULT_PATH, `Honcho Identity -- ${OBSERVED}.md`);
	fs.writeFileSync(identityPath, identityLines.join("\n"));
	results.push(`Written identity note: ${path.basename(identityPath)}`);

	// Write conclusions note
	const concLines: string[] = [
		"---",
		`honcho_generated: ${new Date().toISOString()}`,
		`honcho_peer: ${OBSERVED}`,
		`honcho_count: ${conclusionsResp.items.length}`,
		"---",
		"",
		"## Conclusions",
		"",
	];

	if (conclusionsResp.items.length === 0) {
		concLines.push("*No conclusions yet.*");
	} else {
		for (const c of conclusionsResp.items) {
			const date = new Date(c.created_at).toLocaleDateString();
			concLines.push(`- **${date}**: ${c.content}`);
		}
	}
	concLines.push("");

	const concPath = path.join(VAULT_PATH, `Honcho Conclusions -- ${OBSERVED}.md`);
	fs.writeFileSync(concPath, concLines.join("\n"));
	results.push(`Written conclusions note: ${path.basename(concPath)} (${conclusionsResp.items.length} conclusions)`);

	return results.join("\n");
}

async function vaultList(folderPath?: string): Promise<string> {
	const dir = folderPath
		? (path.isAbsolute(folderPath) ? folderPath : path.join(VAULT_PATH, folderPath))
		: VAULT_PATH;

	const files = getMarkdownFiles(dir, false);
	if (files.length === 0) return "No markdown files found.";

	const lines: string[] = [`## Notes in ${relPath(dir) || "/"}`, ""];

	for (const file of files.slice(0, 50)) {
		const rel = relPath(file);
		const content = fs.readFileSync(file, "utf-8");
		const { frontmatter } = parseFrontmatter(content);
		const synced = frontmatter.honcho_synced ? ` [synced: ${frontmatter.honcho_synced}]` : " [not synced]";
		const tags = extractTags(content);
		const tagStr = tags.length > 0 ? ` ${tags.join(" ")}` : "";
		lines.push(`- ${rel}${synced}${tagStr}`);
	}

	if (files.length > 50) {
		lines.push(`  ... and ${files.length - 50} more`);
	}

	return lines.join("\n");
}

async function vaultChat(query: string, reasoningLevel = "medium"): Promise<string> {
	const resp = await honchoRequest<{ content: string | null }>(
		"POST",
		`/workspaces/${WORKSPACE}/peers/${OBSERVED}/chat`,
		{
			query,
			stream: false,
			reasoning_level: reasoningLevel,
		}
	);
	return resp.content ?? "No response.";
}

async function scheduleDream(): Promise<string> {
	await honchoRequest("POST", `/workspaces/${WORKSPACE}/schedule_dream`, {
		observer: OBSERVER,
		observed: OBSERVED,
		dream_type: "omni",
	});
	return "Dream scheduled. Honcho will consolidate observations into higher-order conclusions.";
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
	{
		name: "honcho-vault",
		version: "0.1.0",
	},
	{
		capabilities: {
			tools: {},
		},
	}
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "vault_ingest",
			description:
				"Ingest a markdown note from the Obsidian vault into Honcho. " +
				"Creates a session with structural context (tags, links, headings, folder path) " +
				"and chunks the content into messages for Honcho's observation pipeline.",
			inputSchema: {
				type: "object" as const,
				properties: {
					file_path: {
						type: "string",
						description: "Path to the markdown file, relative to vault root",
					},
				},
				required: ["file_path"],
			},
		},
		{
			name: "vault_ingest_folder",
			description:
				"Ingest all markdown notes in a vault folder into Honcho. " +
				"Schedules a dream after bulk ingestion for memory consolidation.",
			inputSchema: {
				type: "object" as const,
				properties: {
					folder_path: {
						type: "string",
						description: "Path to the folder, relative to vault root",
					},
				},
				required: ["folder_path"],
			},
		},
		{
			name: "vault_search",
			description:
				"Search across both Honcho's processed conclusions and raw ingested messages. " +
				"Returns semantically relevant results from the vault's identity material.",
			inputSchema: {
				type: "object" as const,
				properties: {
					query: {
						type: "string",
						description: "Natural language search query",
					},
				},
				required: ["query"],
			},
		},
		{
			name: "vault_status",
			description:
				"Show the current state of the Honcho-vault integration: " +
				"workspace config, recent sessions, and observation queue progress.",
			inputSchema: {
				type: "object" as const,
				properties: {},
			},
		},
		{
			name: "vault_sync",
			description:
				"Pull Honcho's identity data back into the vault as markdown notes. " +
				"Creates/updates an identity note (peer card + representation) " +
				"and a conclusions note with recent observations.",
			inputSchema: {
				type: "object" as const,
				properties: {},
			},
		},
		{
			name: "vault_list",
			description:
				"List markdown notes in the vault with their Honcho sync status and tags.",
			inputSchema: {
				type: "object" as const,
				properties: {
					folder_path: {
						type: "string",
						description: "Optional folder path relative to vault root. Defaults to vault root.",
					},
				},
			},
		},
		{
			name: "vault_chat",
			description:
				"Ask Honcho a question using dialectic reasoning grounded in vault-derived identity. " +
				"Uses the observed peer's representation to answer questions about identity, preferences, and knowledge.",
			inputSchema: {
				type: "object" as const,
				properties: {
					query: {
						type: "string",
						description: "Natural language question about the user's identity or knowledge",
					},
					reasoning_level: {
						type: "string",
						enum: ["minimal", "low", "medium", "high", "max"],
						description: "Reasoning depth. Default: medium.",
					},
				},
				required: ["query"],
			},
		},
		{
			name: "schedule_dream",
			description:
				"Manually trigger Honcho's dream process to consolidate observations " +
				"into higher-order conclusions. Useful after bulk ingestion.",
			inputSchema: {
				type: "object" as const,
				properties: {},
			},
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const { name, arguments: args } = request.params;

	try {
		await ensureInitialized();

		let result: string;

		switch (name) {
			case "vault_ingest":
				result = await vaultIngest((args as { file_path: string }).file_path);
				break;
			case "vault_ingest_folder":
				result = await vaultIngestFolder((args as { folder_path: string }).folder_path);
				break;
			case "vault_search":
				result = await vaultSearch((args as { query: string }).query);
				break;
			case "vault_status":
				result = await vaultStatus();
				break;
			case "vault_sync":
				result = await vaultSync();
				break;
			case "vault_list":
				result = await vaultList((args as { folder_path?: string }).folder_path);
				break;
			case "vault_chat":
				result = await vaultChat(
					(args as { query: string; reasoning_level?: string }).query,
					(args as { reasoning_level?: string }).reasoning_level
				);
				break;
			case "schedule_dream":
				result = await scheduleDream();
				break;
			default:
				result = `Unknown tool: ${name}`;
		}

		return {
			content: [{ type: "text" as const, text: result }],
		};
	} catch (err) {
		return {
			content: [
				{
					type: "text" as const,
					text: `Error: ${err instanceof Error ? err.message : String(err)}`,
				},
			],
			isError: true,
		};
	}
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
	if (!HONCHO_API_KEY) {
		console.error("HONCHO_API_KEY environment variable is required");
		process.exit(1);
	}
	if (!VAULT_PATH) {
		console.error("VAULT_PATH environment variable is required");
		process.exit(1);
	}
	if (!fs.existsSync(VAULT_PATH)) {
		console.error(`Vault path does not exist: ${VAULT_PATH}`);
		process.exit(1);
	}

	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main();
