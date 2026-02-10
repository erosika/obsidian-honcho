import { type App, Notice, TFile, TFolder, type FuzzyMatch } from "obsidian";
import type { HonchoClient, ConclusionResponse } from "../honcho-client";
import { chunkMarkdown } from "../utils/chunker";
import { writeHonchoFrontmatter } from "../utils/frontmatter";

interface IngestContext {
	app: App;
	client: HonchoClient;
	workspaceId: string;
	peerId: string;
	trackFrontmatter: boolean;
}

/**
 * Ingest a single note: chunk its content and create conclusions.
 */
export async function ingestNote(
	ctx: IngestContext,
	file: TFile
): Promise<ConclusionResponse[]> {
	const content = await ctx.app.vault.cachedRead(file);
	const chunks = chunkMarkdown(content);

	if (chunks.length === 0) {
		new Notice(`Nothing to ingest from ${file.basename}`);
		return [];
	}

	const conclusions = chunks.map((chunk) => ({
		content: `[${file.basename}] ${chunk}`,
		observer_id: ctx.peerId,
		observed_id: ctx.peerId,
		session_id: null,
	}));

	const created = await ctx.client.createConclusions(ctx.workspaceId, conclusions);

	if (ctx.trackFrontmatter) {
		await writeHonchoFrontmatter(ctx.app, file, {
			honcho_synced: new Date().toISOString(),
			honcho_conclusion_ids: created.map((c) => c.id),
		});
	}

	return created;
}

/**
 * Ingest all markdown files in a folder.
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
	peerId: string,
	trackFrontmatter: boolean
): IngestContext {
	return { app, client, workspaceId, peerId, trackFrontmatter };
}
