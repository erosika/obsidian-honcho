import { type App, Notice, TFile, normalizePath } from "obsidian";
import type { HonchoClient, ConclusionResponse } from "../honcho-client";

interface SyncContext {
	app: App;
	client: HonchoClient;
	workspaceId: string;
	peerId: string;
}

/**
 * Generate a full identity note from the peer card + representation.
 * Uses getPeerContext for a single API call instead of two separate requests.
 */
export async function generateIdentityNote(ctx: SyncContext): Promise<TFile> {
	const contextResp = await ctx.client.getPeerContext(ctx.workspaceId, ctx.peerId);

	const lines: string[] = [
		"---",
		`honcho_generated: ${new Date().toISOString()}`,
		`honcho_peer: ${ctx.peerId}`,
		"tags:",
		"  - honcho",
		"  - honcho/identity",
		"---",
		"",
	];

	if (contextResp.peer_card && contextResp.peer_card.length > 0) {
		lines.push("## Peer Card", "");
		for (const item of contextResp.peer_card) {
			lines.push(`- ${item}`);
		}
		lines.push("");
	}

	if (contextResp.representation) {
		lines.push("## Representation", "");
		lines.push(contextResp.representation);
		lines.push("");
	}

	const fileName = `Honcho Identity -- ${ctx.peerId}`;
	const path = normalizePath(`${fileName}.md`);
	const content = lines.join("\n");

	const existing = ctx.app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		// Check if user has edited the file since it was last generated
		const cache = ctx.app.metadataCache.getFileCache(existing);
		const generatedAt = cache?.frontmatter?.honcho_generated as string | undefined;
		const generatedTime = generatedAt ? new Date(generatedAt).getTime() : 0;
		const userEdited = existing.stat.mtime > generatedTime + 2000; // 2s grace for write propagation

		if (userEdited) {
			// Don't overwrite user edits -- create a timestamped version
			const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
			const newPath = normalizePath(`${fileName} ${ts}.md`);
			const file = await ctx.app.vault.create(newPath, content);
			new Notice(`Created new ${fileName} (existing file has user edits)`);
			return file;
		}

		await ctx.app.vault.modify(existing, content);
		new Notice(`Updated ${fileName}`);
		return existing;
	}

	const file = await ctx.app.vault.create(path, content);
	new Notice(`Created ${fileName}`);
	return file;
}

/**
 * Pull recent conclusions into a vault note with nested Honcho tags.
 */
export async function pullConclusions(
	ctx: SyncContext,
	pageSize = 50
): Promise<TFile> {
	// Paginate through all conclusions
	const allItems: ConclusionResponse[] = [];
	let page = 1;
	let totalPages = 1;

	do {
		const resp = await ctx.client.listConclusions(
			ctx.workspaceId,
			{ observer_id: ctx.peerId, observed_id: ctx.peerId },
			page,
			pageSize
		);
		allItems.push(...resp.items);
		totalPages = resp.pages;
		page++;
	} while (page <= totalPages);

	const lines: string[] = [
		"---",
		`honcho_generated: ${new Date().toISOString()}`,
		`honcho_peer: ${ctx.peerId}`,
		`honcho_count: ${allItems.length}`,
		"tags:",
		"  - honcho",
		"  - honcho/conclusions",
		"---",
		"",
		"## Conclusions",
		"",
	];

	if (allItems.length === 0) {
		lines.push("*No conclusions yet.*");
	} else {
		for (const item of allItems) {
			const date = new Date(item.created_at).toLocaleDateString();
			lines.push(`- **${date}**: ${item.content}`);
		}
	}
	lines.push("");

	const fileName = `Honcho Conclusions -- ${ctx.peerId}`;
	const path = normalizePath(`${fileName}.md`);
	const content = lines.join("\n");

	const existing = ctx.app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		const cache = ctx.app.metadataCache.getFileCache(existing);
		const generatedAt = cache?.frontmatter?.honcho_generated as string | undefined;
		const generatedTime = generatedAt ? new Date(generatedAt).getTime() : 0;
		const userEdited = existing.stat.mtime > generatedTime + 2000;

		if (userEdited) {
			const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
			const newPath = normalizePath(`${fileName} ${ts}.md`);
			const file = await ctx.app.vault.create(newPath, content);
			new Notice(`Created new ${fileName} (existing file has user edits)`);
			return file;
		}

		await ctx.app.vault.modify(existing, content);
		new Notice(`Updated ${fileName} (${allItems.length} conclusions)`);
		return existing;
	}

	const file = await ctx.app.vault.create(path, content);
	new Notice(`Created ${fileName} (${allItems.length} conclusions)`);
	return file;
}

/**
 * Push a vault note's content as the peer card.
 * Parses the note as a list of items (one per line or bullet point).
 */
export async function pushPeerCardFromNote(ctx: SyncContext, file: TFile): Promise<void> {
	const content = await ctx.app.vault.cachedRead(file);

	// Strip frontmatter
	let body = content;
	const fmMatch = body.match(/^---\n[\s\S]*?\n---\n?/);
	if (fmMatch) {
		body = body.slice(fmMatch[0].length);
	}

	// Parse lines: treat bullet points as card items, skip empty lines and headings
	const items: string[] = [];
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith("#")) continue; // skip headings

		// Strip bullet point prefix
		const cleaned = trimmed.replace(/^[-*+]\s+/, "").trim();
		if (cleaned) {
			items.push(cleaned);
		}
	}

	if (items.length === 0) {
		new Notice("No card items found in note. Use bullet points for each card entry.");
		return;
	}

	await ctx.client.setPeerCard(ctx.workspaceId, ctx.peerId, items);
	new Notice(`Pushed ${items.length} items to peer card`);
}

/**
 * Pull session summaries for a given session and return them.
 */
export async function getSessionSummary(
	ctx: SyncContext,
	sessionId: string
): Promise<{ short: string | null; long: string | null }> {
	const resp = await ctx.client.getSessionSummaries(ctx.workspaceId, sessionId);
	return {
		short: resp.short_summary,
		long: resp.long_summary,
	};
}

export function createSyncContext(
	app: App,
	client: HonchoClient,
	workspaceId: string,
	peerId: string
): SyncContext {
	return { app, client, workspaceId, peerId };
}
