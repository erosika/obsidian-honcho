import { type App, Notice, TFile, normalizePath } from "obsidian";
import type { HonchoClient } from "../honcho-client";

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

	const existing = ctx.app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		await ctx.app.vault.modify(existing, lines.join("\n"));
		new Notice(`Updated ${fileName}`);
		return existing;
	}

	const file = await ctx.app.vault.create(path, lines.join("\n"));
	new Notice(`Created ${fileName}`);
	return file;
}

/**
 * Pull recent conclusions into a vault note with nested Honcho tags.
 */
export async function pullConclusions(
	ctx: SyncContext,
	count = 50
): Promise<TFile> {
	const resp = await ctx.client.listConclusions(
		ctx.workspaceId,
		{ observer_id: ctx.peerId, observed_id: ctx.peerId },
		1,
		count
	);

	const lines: string[] = [
		"---",
		`honcho_generated: ${new Date().toISOString()}`,
		`honcho_peer: ${ctx.peerId}`,
		`honcho_count: ${resp.items.length}`,
		"tags:",
		"  - honcho",
		"  - honcho/conclusions",
		"---",
		"",
		"## Conclusions",
		"",
	];

	if (resp.items.length === 0) {
		lines.push("*No conclusions yet.*");
	} else {
		for (const item of resp.items) {
			const date = new Date(item.created_at).toLocaleDateString();
			lines.push(`- **${date}**: ${item.content}`);
		}
	}
	lines.push("");

	const fileName = `Honcho Conclusions -- ${ctx.peerId}`;
	const path = normalizePath(`${fileName}.md`);

	const existing = ctx.app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		await ctx.app.vault.modify(existing, lines.join("\n"));
		new Notice(`Updated ${fileName} (${resp.items.length} conclusions)`);
		return existing;
	}

	const file = await ctx.app.vault.create(path, lines.join("\n"));
	new Notice(`Created ${fileName} (${resp.items.length} conclusions)`);
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
