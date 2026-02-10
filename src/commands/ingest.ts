import { type App, Notice, TFile, TFolder } from "obsidian";
import type { HonchoClient, MessageResponse, SessionConfiguration } from "../honcho-client";
import { chunkMarkdown } from "../utils/chunker";
import { writeHonchoFrontmatter } from "../utils/frontmatter";

export interface IngestContext {
	app: App;
	client: HonchoClient;
	workspaceId: string;
	observerPeerId: string;
	observedPeerId: string;
	trackFrontmatter: boolean;
}

/**
 * Deterministic session IDs scoped by source type.
 */
function sessionIdForFile(file: TFile): string {
	return `obsidian:file:${file.path}`;
}

// ---------------------------------------------------------------------------
// Structural context extraction
// ---------------------------------------------------------------------------

interface StructuralContext {
	tags: string[];
	headings: string[];
	outgoingLinks: string[];
	backlinks: string[];
	folder: string;
	created: string;
	modified: string;
}

function extractStructuralContext(app: App, file: TFile): StructuralContext {
	const cache = app.metadataCache.getFileCache(file);

	// Tags from both inline and frontmatter
	const inlineTags = (cache?.tags ?? []).map((t) => t.tag);
	const fmTags = ((cache?.frontmatter?.tags as string[]) ?? []).map(
		(t) => (t.startsWith("#") ? t : "#" + t)
	);
	const tags = [...new Set([...inlineTags, ...fmTags])];

	// Heading hierarchy
	const headings = (cache?.headings ?? []).map(
		(h) => `${"#".repeat(h.level)} ${h.heading}`
	);

	// Outgoing links from this file
	const outgoingLinks = (cache?.links ?? []).map((l) => l.link);

	// Backlinks: invert resolvedLinks
	const backlinks: string[] = [];
	const resolved = app.metadataCache.resolvedLinks;
	if (resolved) {
		for (const [sourcePath, targets] of Object.entries(resolved)) {
			if (file.path in (targets as Record<string, number>)) {
				backlinks.push(sourcePath.replace(/\.md$/, ""));
			}
		}
	}

	// Folder path
	const folder = file.parent?.path ?? "/";

	// Temporal context
	const created = new Date(file.stat.ctime).toISOString();
	const modified = new Date(file.stat.mtime).toISOString();

	return { tags, headings, outgoingLinks, backlinks, folder, created, modified };
}

/**
 * Build a structural preamble that precedes the content chunks.
 * Gives Honcho's observation pipeline context about the note's
 * position in the vault's knowledge graph.
 */
function buildStructuralPreamble(file: TFile, ctx: StructuralContext): string {
	const parts: string[] = [`[Note: ${file.basename}]`];

	if (ctx.folder !== "/") {
		parts.push(`Folder: ${ctx.folder}`);
	}
	if (ctx.tags.length > 0) {
		parts.push(`Tags: ${ctx.tags.join(", ")}`);
	}
	if (ctx.headings.length > 0) {
		parts.push(`Structure: ${ctx.headings.join(" > ")}`);
	}
	if (ctx.outgoingLinks.length > 0) {
		parts.push(`Links to: ${ctx.outgoingLinks.join(", ")}`);
	}
	if (ctx.backlinks.length > 0) {
		parts.push(`Referenced by: ${ctx.backlinks.join(", ")}`);
	}
	parts.push(`Created: ${ctx.created.split("T")[0]}`);
	parts.push(`Modified: ${ctx.modified.split("T")[0]}`);

	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

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
 * Ingest a single note with full structural context.
 * Creates a session per file, chunks content into messages with metadata,
 * and lets Honcho's observation pipeline derive conclusions.
 */
export async function ingestNote(
	ctx: IngestContext,
	file: TFile
): Promise<MessageResponse[]> {
	const content = await ctx.app.vault.cachedRead(file);
	const chunks = chunkMarkdown(content);

	if (chunks.length === 0) {
		return [];
	}

	const sessionId = sessionIdForFile(file);
	const structural = extractStructuralContext(ctx.app, file);

	// Get-or-create session with peer observation roles
	const session = await ctx.client.getOrCreateSession(
		ctx.workspaceId,
		sessionId,
		{
			[ctx.observerPeerId]: { observe_me: false, observe_others: true },
			[ctx.observedPeerId]: { observe_me: true, observe_others: false },
		}
	);

	// Update session metadata + configuration
	await ctx.client.updateSession(ctx.workspaceId, session.id, {
		metadata: {
			source: "obsidian",
			source_type: "file",
			file_path: file.path,
			file_name: file.basename,
			folder: structural.folder,
			tags: structural.tags,
			outgoing_links: structural.outgoingLinks,
			backlinks: structural.backlinks,
			heading_count: structural.headings.length,
			created_at: structural.created,
			modified_at: structural.modified,
			ingested_at: new Date().toISOString(),
		},
		configuration: ingestSessionConfig(),
	});

	// Build messages: structural preamble + content chunks
	const preamble = buildStructuralPreamble(file, structural);
	const messages: Array<{
		peer_id: string;
		content: string;
		metadata?: Record<string, unknown>;
		created_at?: string;
	}> = [];

	// First message: structural preamble
	messages.push({
		peer_id: ctx.observedPeerId,
		content: preamble,
		metadata: {
			source_file: file.path,
			message_type: "structural_context",
		},
		created_at: structural.created,
	});

	// Content chunks as messages from the observed peer
	for (let i = 0; i < chunks.length; i++) {
		messages.push({
			peer_id: ctx.observedPeerId,
			content: chunks[i],
			metadata: {
				source_file: file.path,
				source_name: file.basename,
				chunk_index: i,
				chunk_total: chunks.length,
				message_type: "content",
			},
			created_at: structural.modified,
		});
	}

	const created = await ctx.client.addMessages(
		ctx.workspaceId,
		session.id,
		messages
	);

	if (ctx.trackFrontmatter) {
		await writeHonchoFrontmatter(ctx.app, file, {
			honcho_synced: new Date().toISOString(),
			honcho_session_id: session.id,
			honcho_message_count: created.length,
		});
	}

	return created;
}

/**
 * Ingest all markdown files in a folder (non-recursive).
 */
export async function ingestFolder(
	ctx: IngestContext,
	folder: TFolder
): Promise<number> {
	const files = folder.children.filter(
		(f): f is TFile => f instanceof TFile && f.extension === "md"
	);

	if (files.length === 0) {
		new Notice(`No markdown files in ${folder.name}`);
		return 0;
	}

	let total = 0;
	const batchSize = 5;

	for (let i = 0; i < files.length; i += batchSize) {
		const batch = files.slice(i, i + batchSize);
		const results = await Promise.all(batch.map((f) => ingestNote(ctx, f)));
		total += results.reduce((sum, r) => sum + r.length, 0);
	}

	// Schedule a dream after bulk ingestion
	if (total > 0) {
		try {
			await ctx.client.scheduleDream(
				ctx.workspaceId,
				ctx.observerPeerId,
				{ observed: ctx.observedPeerId }
			);
		} catch {
			// Dream scheduling is best-effort
		}
	}

	return total;
}

/**
 * Ingest all notes matching a specific tag across the vault.
 */
export async function ingestByTag(
	ctx: IngestContext,
	tag: string
): Promise<number> {
	const normalizedTag = (tag.startsWith("#") ? tag : "#" + tag).toLowerCase();
	const files: TFile[] = [];

	for (const file of ctx.app.vault.getMarkdownFiles()) {
		const cache = ctx.app.metadataCache.getFileCache(file);
		if (!cache) continue;

		const inlineTags = (cache.tags ?? []).map((t) => t.tag.toLowerCase());
		const fmTags = ((cache.frontmatter?.tags as string[]) ?? []).map(
			(t) => (t.startsWith("#") ? t : "#" + t).toLowerCase()
		);
		const allTags = [...inlineTags, ...fmTags];

		if (allTags.includes(normalizedTag)) {
			files.push(file);
		}
	}

	if (files.length === 0) {
		new Notice(`No notes found with tag ${tag}`);
		return 0;
	}

	let total = 0;
	const batchSize = 5;

	for (let i = 0; i < files.length; i += batchSize) {
		const batch = files.slice(i, i + batchSize);
		const results = await Promise.all(batch.map((f) => ingestNote(ctx, f)));
		total += results.reduce((sum, r) => sum + r.length, 0);
	}

	// Schedule a dream after bulk ingestion
	if (total > 0) {
		try {
			await ctx.client.scheduleDream(
				ctx.workspaceId,
				ctx.observerPeerId,
				{ observed: ctx.observedPeerId }
			);
		} catch {
			// Dream scheduling is best-effort
		}
	}

	return total;
}

/**
 * Ingest a note and all notes it links to (one level deep).
 * Follows outgoing links transitively up to the specified depth.
 */
export async function ingestLinked(
	ctx: IngestContext,
	file: TFile,
	depth = 1
): Promise<number> {
	const visited = new Set<string>();
	const queue: Array<{ file: TFile; currentDepth: number }> = [
		{ file, currentDepth: 0 },
	];
	let total = 0;

	while (queue.length > 0) {
		const item = queue.shift()!;
		if (visited.has(item.file.path)) continue;
		visited.add(item.file.path);

		const results = await ingestNote(ctx, item.file);
		total += results.length;

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
	if (total > 0) {
		try {
			await ctx.client.scheduleDream(
				ctx.workspaceId,
				ctx.observerPeerId,
				{ observed: ctx.observedPeerId }
			);
		} catch {
			// Dream scheduling is best-effort
		}
	}

	return total;
}

/**
 * Build an IngestContext from plugin state.
 */
export function createIngestContext(
	app: App,
	client: HonchoClient,
	workspaceId: string,
	observerPeerId: string,
	observedPeerId: string,
	trackFrontmatter: boolean
): IngestContext {
	return { app, client, workspaceId, observerPeerId, observedPeerId, trackFrontmatter };
}
