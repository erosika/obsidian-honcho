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
 */
export async function generateIdentityNote(ctx: SyncContext): Promise<TFile> {
	const [cardResp, repResp] = await Promise.all([
		ctx.client.getPeerCard(ctx.workspaceId, ctx.peerId),
		ctx.client.getPeerRepresentation(ctx.workspaceId, ctx.peerId),
	]);

	const lines: string[] = [
		"---",
		`honcho_generated: ${new Date().toISOString()}`,
		`honcho_peer: ${ctx.peerId}`,
		"---",
		"",
	];

	if (cardResp.peer_card && cardResp.peer_card.length > 0) {
		lines.push("## Peer Card", "");
		for (const item of cardResp.peer_card) {
			lines.push(`- ${item}`);
		}
		lines.push("");
	}

	if (repResp.representation) {
		lines.push("## Representation", "");
		lines.push(repResp.representation);
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
 * Pull recent conclusions into a vault note.
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

export function createSyncContext(
	app: App,
	client: HonchoClient,
	workspaceId: string,
	peerId: string
): SyncContext {
	return { app, client, workspaceId, peerId };
}
