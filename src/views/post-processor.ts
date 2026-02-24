import { MarkdownRenderChild, MarkdownRenderer } from "obsidian";
import type HonchoPlugin from "../main";

/**
 * Registers a `honcho` code block processor.
 *
 * Usage in notes:
 *
 * ```honcho
 * search: values and priorities
 * limit: 5
 * ```
 *
 * ```honcho
 * card
 * ```
 *
 * ```honcho
 * representation
 * ```
 *
 * Supported commands:
 * - search: <query>       -- renders matching conclusions inline
 * - card                  -- renders the peer card
 * - representation        -- renders the representation
 * - conclusions [limit]   -- renders recent conclusions
 */
export function registerHonchoCodeBlock(plugin: HonchoPlugin): void {
	plugin.registerMarkdownCodeBlockProcessor("honcho", async (source, el, ctx) => {
		const child = new MarkdownRenderChild(el);
		ctx.addChild(child);

		const client = plugin.getClient();
		if (!client) {
			el.createEl("p", {
				text: "Honcho: configure API key in settings",
				cls: "honcho-block-error",
			});
			return;
		}

		const workspaceId = plugin.getWorkspaceId();
		const peerId = plugin.getPeerId();

		const lines = source.trim().split("\n").map((l) => l.trim()).filter((l) => l);
		if (lines.length === 0) return;

		const command = lines[0].toLowerCase();

		try {
			if (command.startsWith("search:")) {
				await renderSearch(client, workspaceId, peerId, lines, el, plugin);
			} else if (command === "card") {
				await renderCard(client, workspaceId, peerId, el);
			} else if (command === "representation") {
				await renderRepresentation(client, workspaceId, peerId, el, plugin);
			} else if (command.startsWith("conclusions")) {
				await renderConclusions(client, workspaceId, peerId, lines, el);
			} else {
				el.createEl("p", {
					text: `Honcho: unknown command "${command}". Use search:, card, representation, or conclusions.`,
					cls: "honcho-block-error",
				});
			}
		} catch (err) {
			el.createEl("p", {
				text: `Honcho error: ${err instanceof Error ? err.message : String(err)}`,
				cls: "honcho-block-error",
			});
		}
	});
}

function parseOption(lines: string[], key: string): string | undefined {
	for (const line of lines) {
		if (line.toLowerCase().startsWith(key + ":")) {
			return line.slice(key.length + 1).trim();
		}
	}
	return undefined;
}

async function renderSearch(
	client: ReturnType<HonchoPlugin["getClient"]> & object,
	workspaceId: string,
	peerId: string,
	lines: string[],
	el: HTMLElement,
	plugin: HonchoPlugin
): Promise<void> {
	const query = lines[0].slice(lines[0].indexOf(":") + 1).trim();
	const limitStr = parseOption(lines, "limit");
	const limit = limitStr ? parseInt(limitStr, 10) : 10;

	if (!query) {
		el.createEl("p", { text: "Honcho: search query is empty", cls: "honcho-block-error" });
		return;
	}

	const results = await client.queryConclusions(workspaceId, query, {
		top_k: limit,
		filters: { observer_id: peerId, observed_id: peerId },
	});

	if (results.length === 0) {
		el.createEl("p", { text: "No matching conclusions.", cls: "honcho-block-empty" });
		return;
	}

	const container = el.createDiv({ cls: "honcho-block-results" });
	for (const r of results) {
		const item = container.createDiv({ cls: "honcho-block-item" });
		const date = new Date(r.created_at).toLocaleDateString();
		item.createEl("span", { text: date, cls: "honcho-block-date" });
		item.createEl("span", { text: r.content, cls: "honcho-block-content" });
	}
}

async function renderCard(
	client: ReturnType<HonchoPlugin["getClient"]> & object,
	workspaceId: string,
	peerId: string,
	el: HTMLElement
): Promise<void> {
	const resp = await client.getPeerCard(workspaceId, peerId);

	if (!resp.peer_card || resp.peer_card.length === 0) {
		el.createEl("p", { text: "No peer card yet.", cls: "honcho-block-empty" });
		return;
	}

	const list = el.createEl("ul", { cls: "honcho-block-card-list" });
	for (const item of resp.peer_card) {
		list.createEl("li", { text: item });
	}
}

async function renderRepresentation(
	client: ReturnType<HonchoPlugin["getClient"]> & object,
	workspaceId: string,
	peerId: string,
	el: HTMLElement,
	plugin: HonchoPlugin
): Promise<void> {
	const resp = await client.getPeerRepresentation(workspaceId, peerId);

	if (!resp.representation) {
		el.createEl("p", { text: "No representation yet.", cls: "honcho-block-empty" });
		return;
	}

	const container = el.createDiv({ cls: "honcho-block-representation" });
	await MarkdownRenderer.render(
		plugin.app,
		resp.representation,
		container,
		"",
		plugin
	);
}

async function renderConclusions(
	client: ReturnType<HonchoPlugin["getClient"]> & object,
	workspaceId: string,
	peerId: string,
	lines: string[],
	el: HTMLElement
): Promise<void> {
	const parts = lines[0].split(/\s+/);
	const limit = parts.length > 1 ? parseInt(parts[1], 10) : 10;

	const resp = await client.listConclusions(
		workspaceId,
		{ observer_id: peerId, observed_id: peerId },
		1,
		limit
	);

	if (resp.items.length === 0) {
		el.createEl("p", { text: "No conclusions yet.", cls: "honcho-block-empty" });
		return;
	}

	const container = el.createDiv({ cls: "honcho-block-results" });
	for (const c of resp.items) {
		const item = container.createDiv({ cls: "honcho-block-item" });
		const date = new Date(c.created_at).toLocaleDateString();
		item.createEl("span", { text: date, cls: "honcho-block-date" });
		item.createEl("span", { text: c.content, cls: "honcho-block-content" });
	}
}
