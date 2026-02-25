import { type App, Notice, TFile, TFolder } from "obsidian";
import type { HonchoClient, MessageResponse, SessionConfiguration } from "../honcho-client";
import { writeHonchoFrontmatter, normalizeFrontmatterTags } from "../utils/frontmatter";
import { checkSyncStatus, partitionByStatus, stripForIngestion, computeContentHash, generateTurnId } from "../utils/sync-status";

export interface IngestContext {
	app: App;
	client: HonchoClient;
	workspaceId: string;
	peerId: string;
	trackFrontmatter: boolean;
}

export interface IngestOptions {
	force?: boolean;
}

export interface IngestResult {
	messages: MessageResponse[];
	skipped: boolean;
	reason?: string;
}

/**
 * Deterministic session IDs scoped by source type.
 * API requires ^[a-zA-Z0-9_-]+$ so we encode the path.
 */
function sessionIdForFile(file: TFile): string {
	// Replace non-alphanumeric chars with dashes, collapse runs, trim edges
	const slug = file.path
		.replace(/\.md$/, "")
		.replace(/[^a-zA-Z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `obsidian-file-${slug}`;
}

// ---------------------------------------------------------------------------
// Structural context extraction
// ---------------------------------------------------------------------------

interface StructuralContext {
	tags: string[];
	headings: string[];
	outgoingLinks: string[];
	backlinks: string[];
	backlinkCount: number;
	isOrphan: boolean;
	isDeadend: boolean;
	unresolvedLinks: string[];
	folder: string;
	created: string;
	modified: string;
	aliases: string[];
	/** Custom frontmatter properties (excludes Obsidian/Honcho internal keys) */
	properties: Record<string, unknown>;
}

function extractStructuralContext(app: App, file: TFile): StructuralContext {
	const cache = app.metadataCache.getFileCache(file);

	// Tags from both inline and frontmatter
	const inlineTags = (cache?.tags ?? []).map((t) => t.tag);
	const fmTags = normalizeFrontmatterTags(cache?.frontmatter?.tags).map(
		(t) => (t.startsWith("#") ? t : "#" + t)
	);
	const tags = [...new Set([...inlineTags, ...fmTags])];

	// Heading hierarchy
	const headings = (cache?.headings ?? []).map(
		(h) => `${"#".repeat(h.level)} ${h.heading}`
	);

	// Outgoing links from this file
	const outgoingLinks = (cache?.links ?? []).map((l) => l.link);

	// Backlinks: scan resolvedLinks for references to this file
	const backlinks: string[] = [];
	const resolved = app.metadataCache.resolvedLinks;
	if (resolved) {
		for (const sourcePath in resolved) {
			if (resolved[sourcePath]?.[file.path]) {
				backlinks.push(sourcePath.replace(/\.md$/, ""));
			}
		}
	}

	// Graph signals
	const backlinkCount = backlinks.length;
	const isOrphan = backlinkCount === 0;
	const isDeadend = outgoingLinks.length === 0;

	// Unresolved links: wikilinks that don't resolve to a file
	const unresolvedLinks: string[] = [];
	for (const link of cache?.links ?? []) {
		const dest = app.metadataCache.getFirstLinkpathDest(link.link, file.path);
		if (!dest) {
			unresolvedLinks.push(link.link);
		}
	}

	// Folder path
	const folder = file.parent?.path ?? "/";

	// Aliases
	const aliases: string[] = Array.isArray(cache?.frontmatter?.aliases)
		? cache!.frontmatter!.aliases.map(String)
		: typeof cache?.frontmatter?.aliases === "string"
			? [cache!.frontmatter!.aliases]
			: [];

	// Custom frontmatter properties (strip Obsidian internals + Honcho tracking keys)
	const INTERNAL_KEYS = new Set([
		"tags", "aliases", "cssclass", "cssclasses", "publish", "position",
		// Current keys
		"synced", "session", "hash", "feedback",
		// Legacy keys (migration)
		"honcho_synced", "honcho_session_id", "honcho_message_count",
		"honcho_content_hash", "honcho_feedback",
	]);
	const properties: Record<string, unknown> = {};
	if (cache?.frontmatter) {
		for (const [key, value] of Object.entries(cache.frontmatter)) {
			if (!INTERNAL_KEYS.has(key) && value !== undefined) {
				properties[key] = value;
			}
		}
	}

	// Temporal context
	const created = new Date(file.stat.ctime).toISOString();
	const modified = new Date(file.stat.mtime).toISOString();

	return { tags, headings, outgoingLinks, backlinks, backlinkCount, isOrphan, isDeadend, unresolvedLinks, folder, created, modified, aliases, properties };
}

/**
 * Build a document context message that gives Honcho's observation pipeline
 * structured metadata about the note's position in the vault's knowledge graph.
 */
function buildDocumentContext(file: TFile, ctx: StructuralContext): string {
	// Graph position label
	const graphPosition =
		ctx.isOrphan && ctx.isDeadend ? "isolated"
		: ctx.isOrphan ? "orphan"
		: ctx.isDeadend ? "dead-end"
		: ctx.backlinkCount >= 5 ? "hub"
		: "connected";

	const parts: string[] = [
		"[Document Observation]",
		`Title: ${file.basename}`,
		"Type: Obsidian vault note",
	];

	if (ctx.folder !== "/") {
		parts.push(`Folder: ${ctx.folder}`);
	}
	if (ctx.tags.length > 0) {
		parts.push(`Tags: ${ctx.tags.join(", ")}`);
	}
	if (ctx.aliases.length > 0) {
		parts.push(`Aliases: ${ctx.aliases.join(", ")}`);
	}
	if (ctx.outgoingLinks.length > 0) {
		parts.push(`Links to: ${ctx.outgoingLinks.join(", ")}`);
	}
	if (ctx.backlinks.length > 0) {
		parts.push(`Referenced by: ${ctx.backlinks.join(", ")}`);
	}
	parts.push(`Graph position: ${graphPosition}`);
	parts.push(`Backlink count: ${ctx.backlinkCount}`);

	// Custom frontmatter properties
	const propEntries = Object.entries(ctx.properties);
	if (propEntries.length > 0) {
		for (const [key, value] of propEntries) {
			const formatted = Array.isArray(value) ? value.join(", ") : String(value);
			parts.push(`${key}: ${formatted}`);
		}
	}

	if (ctx.headings.length > 0) {
		parts.push(`Structure: ${ctx.headings.join(" > ")}`);
	}

	parts.push(`Created: ${ctx.created.split("T")[0]}`);
	parts.push(`Modified: ${ctx.modified.split("T")[0]}`);

	parts.push("");
	parts.push(
		"This is a document from the user's personal knowledge base, not a conversational message.",
		"Observations should focus on the user's documented thinking, knowledge structure,",
		"and how this note relates to their broader information architecture."
	);

	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/** Prevents concurrent ingest of the same file path. */
const ingestLocks = new Set<string>();

/**
 * Session configuration for ingested content.
 * Enables observation + dreaming on the session.
 */
function ingestSessionConfig(): SessionConfiguration {
	return {
		reasoning: { enabled: true },
		dream: { enabled: true },
		summary: { enabled: true },
	};
}

/**
 * Ingest a single note as exactly 2 messages: document context + full body.
 * Creates a session per file. Checks sync status first -- returns early
 * if content is unchanged (unless force: true).
 */
export async function ingestNote(
	ctx: IngestContext,
	file: TFile,
	opts?: IngestOptions
): Promise<IngestResult> {
	// Per-file lock: prevents manual + auto-sync from racing on the same file
	if (ingestLocks.has(file.path)) {
		return { messages: [], skipped: true, reason: "in-progress" };
	}
	ingestLocks.add(file.path);
	try {
		return await doIngestNote(ctx, file, opts);
	} finally {
		ingestLocks.delete(file.path);
	}
}

async function doIngestNote(
	ctx: IngestContext,
	file: TFile,
	opts?: IngestOptions
): Promise<IngestResult> {
	// Gate: check if content has actually changed
	if (!opts?.force) {
		const status = await checkSyncStatus(ctx.app, file);
		if (!status.needsSync) {
			return { messages: [], skipped: true, reason: "unchanged" };
		}
	}

	const content = await ctx.app.vault.cachedRead(file);
	const body = stripForIngestion(content);

	if (body.trim().length === 0) {
		return { messages: [], skipped: true, reason: "empty" };
	}

	const contentHash = computeContentHash(body);
	const sessionId = sessionIdForFile(file);
	const structural = extractStructuralContext(ctx.app, file);

	// Idempotent: returns existing session or creates new.
	// No per-session peers -- observation config lives on workspace peers
	// (set in ensureInitialized). Messages accumulate on re-ingest; Honcho
	// sees the full history.
	const session = await ctx.client.getOrCreateSession(
		ctx.workspaceId, sessionId
	);

	// Graph position label
	const graphPosition =
		structural.isOrphan && structural.isDeadend ? "isolated"
		: structural.isOrphan ? "orphan"
		: structural.isDeadend ? "dead-end"
		: structural.backlinkCount >= 5 ? "hub"
		: "connected";

	// Trimmed session metadata
	const sessionMeta: Record<string, unknown> = {
		source: "obsidian",
		source_type: "file",
		file_path: file.path,
		file_name: file.basename,
		folder: structural.folder,
		tags: structural.tags,
		graph_position: graphPosition,
		backlink_count: structural.backlinkCount,
		ingested_at: new Date().toISOString(),
	};

	await ctx.client.updateSession(ctx.workspaceId, session.id, {
		metadata: sessionMeta,
		configuration: ingestSessionConfig(),
	});

	// Message 1: Document context (metadata + graph position)
	// Message 2: Full note body (no chunking)
	// Both share a turn_id so the pair is queryable as a unit.
	const documentContext = buildDocumentContext(file, structural);
	const turnId = generateTurnId(sessionId);

	// Messages come from the user peer. Honcho's observe_me derives conclusions
	// from messages sent by this peer. The document context helps classify
	// what kind of content this is (personal note vs reference data vs dataset).
	const messages: Array<{
		peer_id: string;
		content: string;
		metadata?: Record<string, unknown>;
	}> = [
		{
			peer_id: ctx.peerId,
			content: documentContext,
			metadata: {
				source_file: file.path,
				message_type: "document_context",
				turn_id: turnId,
			},
		},
		{
			peer_id: ctx.peerId,
			content: body,
			metadata: {
				source_file: file.path,
				source_name: file.basename,
				message_type: "content",
				turn_id: turnId,
			},
		},
	];

	const created = await ctx.client.addMessages(
		ctx.workspaceId,
		session.id,
		messages
	);

	if (ctx.trackFrontmatter) {
		await writeHonchoFrontmatter(ctx.app, file, {
			synced: new Date().toISOString(),
			session: session.id,
			hash: contentHash,
		});
	}

	return { messages: created, skipped: false };
}

export type ProgressCallback = (completed: number, total: number) => void;

export interface BatchIngestResult {
	totalMessages: number;
	counts: { new: number; modified: number; unchanged: number };
}

/**
 * Collect all markdown files in a folder recursively.
 */
function collectMarkdownFiles(folder: TFolder): TFile[] {
	const files: TFile[] = [];
	for (const child of folder.children) {
		if (child instanceof TFile && child.extension === "md") {
			files.push(child);
		} else if (child instanceof TFolder) {
			files.push(...collectMarkdownFiles(child));
		}
	}
	return files;
}

/**
 * Ingest all markdown files in a folder (recursive).
 * Partitions by sync status first so unchanged files are skipped.
 */
export async function ingestFolder(
	ctx: IngestContext,
	folder: TFolder,
	onProgress?: ProgressCallback
): Promise<BatchIngestResult> {
	const files = collectMarkdownFiles(folder);

	if (files.length === 0) {
		new Notice(`No markdown files in ${folder.name}`);
		return { totalMessages: 0, counts: { new: 0, modified: 0, unchanged: 0 } };
	}

	const partition = await partitionByStatus(ctx.app, files);

	if (partition.needsSync.length === 0) {
		new Notice(`${folder.name}: ${partition.counts.unchanged} unchanged, nothing to ingest`);
		return { totalMessages: 0, counts: partition.counts };
	}

	let totalMessages = 0;
	let completed = 0;
	const batchSize = 5;
	const toIngest = partition.needsSync.map((e) => e.file);
	const total = toIngest.length;

	for (let i = 0; i < toIngest.length; i += batchSize) {
		const batch = toIngest.slice(i, i + batchSize);
		const results = await Promise.all(batch.map((f) => ingestNote(ctx, f, { force: true })));
		totalMessages += results.reduce((sum, r) => sum + r.messages.length, 0);
		completed += batch.length;
		onProgress?.(completed, total);
	}

	// Schedule a dream after bulk ingestion
	if (totalMessages > 0) {
		try {
			await ctx.client.scheduleDream(
				ctx.workspaceId,
				ctx.peerId,
				{ observed: ctx.peerId }
			);
		} catch {
			// Dream scheduling is best-effort
		}
	}

	return { totalMessages, counts: partition.counts };
}

/**
 * Ingest all notes matching a specific tag across the vault.
 * Partitions by sync status first so unchanged files are skipped.
 */
export async function ingestByTag(
	ctx: IngestContext,
	tag: string,
	onProgress?: ProgressCallback
): Promise<BatchIngestResult> {
	const normalizedTag = (tag.startsWith("#") ? tag : "#" + tag).toLowerCase();
	const files: TFile[] = [];

	for (const file of ctx.app.vault.getMarkdownFiles()) {
		const cache = ctx.app.metadataCache.getFileCache(file);
		if (!cache) continue;

		const inlineTags = (cache.tags ?? []).map((t) => t.tag.toLowerCase());
		const fmTags = normalizeFrontmatterTags(cache.frontmatter?.tags).map(
			(t) => (t.startsWith("#") ? t : "#" + t).toLowerCase()
		);
		const allTags = [...inlineTags, ...fmTags];

		if (allTags.includes(normalizedTag)) {
			files.push(file);
		}
	}

	if (files.length === 0) {
		new Notice(`No notes found with tag ${tag}`);
		return { totalMessages: 0, counts: { new: 0, modified: 0, unchanged: 0 } };
	}

	const partition = await partitionByStatus(ctx.app, files);

	if (partition.needsSync.length === 0) {
		new Notice(`${tag}: ${partition.counts.unchanged} unchanged, nothing to ingest`);
		return { totalMessages: 0, counts: partition.counts };
	}

	let totalMessages = 0;
	let completed = 0;
	const batchSize = 5;
	const toIngest = partition.needsSync.map((e) => e.file);
	const total = toIngest.length;

	for (let i = 0; i < toIngest.length; i += batchSize) {
		const batch = toIngest.slice(i, i + batchSize);
		const results = await Promise.all(batch.map((f) => ingestNote(ctx, f, { force: true })));
		totalMessages += results.reduce((sum, r) => sum + r.messages.length, 0);
		completed += batch.length;
		onProgress?.(completed, total);
	}

	// Schedule a dream after bulk ingestion
	if (totalMessages > 0) {
		try {
			await ctx.client.scheduleDream(
				ctx.workspaceId,
				ctx.peerId,
				{ observed: ctx.peerId }
			);
		} catch {
			// Dream scheduling is best-effort
		}
	}

	return { totalMessages, counts: partition.counts };
}

/**
 * Ingest a note and all notes it links to (one level deep).
 * Follows outgoing links transitively up to the specified depth.
 * Respects sync status -- only ingests notes whose content has changed.
 */
export async function ingestLinked(
	ctx: IngestContext,
	file: TFile,
	depth = 1
): Promise<{ totalMessages: number; ingested: number; skipped: number }> {
	const visited = new Set<string>();
	const queue: Array<{ file: TFile; currentDepth: number }> = [
		{ file, currentDepth: 0 },
	];
	let totalMessages = 0;
	let ingested = 0;
	let skipped = 0;

	while (queue.length > 0) {
		const item = queue.shift()!;
		if (visited.has(item.file.path)) continue;
		visited.add(item.file.path);

		const result = await ingestNote(ctx, item.file);
		if (result.skipped) {
			skipped++;
		} else {
			totalMessages += result.messages.length;
			ingested++;
		}

		// Follow links if we haven't reached max depth
		if (item.currentDepth < depth) {
			const cache = ctx.app.metadataCache.getFileCache(item.file);
			for (const link of cache?.links ?? []) {
				const resolved = ctx.app.metadataCache.getFirstLinkpathDest(
					link.link,
					item.file.path
				);
				if (
					resolved instanceof TFile &&
					resolved.extension === "md" &&
					!visited.has(resolved.path)
				) {
					queue.push({
						file: resolved,
						currentDepth: item.currentDepth + 1,
					});
				}
			}
		}
	}

	// Schedule a dream after transitive ingestion
	if (totalMessages > 0) {
		try {
			await ctx.client.scheduleDream(
				ctx.workspaceId,
				ctx.peerId,
				{ observed: ctx.peerId }
			);
		} catch {
			// Dream scheduling is best-effort
		}
	}

	return { totalMessages, ingested, skipped };
}

/**
 * Count backlinks to a file from the metadata cache's resolved links.
 * Shared between ingestion and the SyncQueue priority computation.
 */
export function countBacklinks(app: App, file: TFile): number {
	let count = 0;
	const resolved = app.metadataCache.resolvedLinks;
	if (resolved) {
		for (const sourcePath in resolved) {
			if (resolved[sourcePath]?.[file.path]) {
				count++;
			}
		}
	}
	return count;
}

/**
 * Build an IngestContext from plugin state.
 */
export function createIngestContext(
	app: App,
	client: HonchoClient,
	workspaceId: string,
	peerId: string,
	trackFrontmatter: boolean
): IngestContext {
	return { app, client, workspaceId, peerId, trackFrontmatter };
}
