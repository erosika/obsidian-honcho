import { type App, Notice, TFile, TFolder } from "obsidian";
import type { HonchoClient, MessageResponse } from "../honcho-client";
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
 * Build a deterministic session ID from the ingestion source.
 */
function sessionIdForFile(file: TFile): string {
	return `obsidian:file:${file.path}`;
}

function sessionIdForFolder(folder: TFolder): string {
	return `obsidian:folder:${folder.path}`;
}

function sessionIdForTag(tag: string): string {
	const normalized = tag.startsWith("#") ? tag.slice(1) : tag;
	return `obsidian:tag:${normalized}`;
}

/**
 * Ingest a single note: create a session, chunk content into messages.
 * Honcho's observation pipeline processes the messages and derives conclusions.
 */
export async function ingestNote(
	ctx: IngestContext,
	file: TFile
): Promise<MessageResponse[]> {
	const content = await ctx.app.vault.cachedRead(file);
	const chunks = chunkMarkdown(content);

	if (chunks.length === 0) {
		new Notice(`Nothing to ingest from ${file.basename}`);
		return [];
	}

	const sessionId = sessionIdForFile(file);

	// Get-or-create session with metadata about the source
	const cache = ctx.app.metadataCache.getFileCache(file);
	const fileTags = (cache?.tags ?? []).map((t) => t.tag);
	const fmTags = ((cache?.frontmatter?.tags as string[]) ?? []).map(
		(t) => (t.startsWith("#") ? t : "#" + t)
	);

	const session = await ctx.client.getOrCreateSession(
		ctx.workspaceId,
		sessionId,
		{
			[ctx.observerPeerId]: { observe_me: false, observe_others: true },
			[ctx.observedPeerId]: { observe_me: true, observe_others: false },
		}
	);

	// Update session metadata with source info
	await ctx.client.updateSession(ctx.workspaceId, session.id, {
		metadata: {
			source: "obsidian",
			source_type: "file",
			file_path: file.path,
			file_name: file.basename,
			tags: [...new Set([...fileTags, ...fmTags])],
			ingested_at: new Date().toISOString(),
		},
	});

	// Create messages from chunks
	const messages = chunks.map((chunk) => ({
		peer_id: ctx.observerPeerId,
		content: chunk,
		metadata: {
			source_file: file.path,
			source_name: file.basename,
		},
	}));

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
 * Ingest all markdown files in a folder.
 * Creates one session per file, all sharing folder metadata.
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
