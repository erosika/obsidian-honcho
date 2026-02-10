import { ItemView, MarkdownRenderer, type WorkspaceLeaf } from "obsidian";
import type HonchoPlugin from "../main";

export const HONCHO_VIEW_TYPE = "honcho-sidebar";

export class HonchoSidebarView extends ItemView {
	private plugin: HonchoPlugin;
	private containerDiv: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: HonchoPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return HONCHO_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Honcho";
	}

	getIcon(): string {
		return "brain";
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("honcho-sidebar");

		this.containerDiv = container;
		await this.render();
	}

	async onClose(): Promise<void> {
		// cleanup
	}

	async render(): Promise<void> {
		if (!this.containerDiv) return;
		const el = this.containerDiv;
		el.empty();

		// Header
		const header = el.createDiv({ cls: "honcho-sidebar-header" });
		header.createEl("h3", { text: "Honcho" });

		const client = this.plugin.getClient();
		if (!client) {
			el.createEl("p", {
				text: "Configure your API key in settings to get started.",
				cls: "honcho-sidebar-empty",
			});
			return;
		}

		// Connection status
		const statusEl = header.createDiv({ cls: "honcho-status" });
		statusEl.createSpan({ text: "Checking...", cls: "honcho-status-text" });

		// Refresh button
		const refreshBtn = header.createEl("button", {
			text: "Refresh",
			cls: "honcho-refresh-btn",
		});
		refreshBtn.addEventListener("click", () => this.render());

		// Search bar
		const searchBar = el.createDiv({ cls: "honcho-sidebar-search" });
		const searchInput = searchBar.createEl("input", {
			type: "text",
			placeholder: "Search memory...",
			cls: "honcho-search-input",
		});
		searchInput.addEventListener("keydown", async (e) => {
			if (e.key === "Enter") {
				await this.doSidebarSearch(searchInput.value, searchResultsEl);
			}
		});
		const searchResultsEl = el.createDiv({ cls: "honcho-sidebar-search-results" });

		// Body
		const body = el.createDiv({ cls: "honcho-sidebar-body" });
		body.createEl("p", { text: "Loading...", cls: "honcho-loading" });

		try {
			const workspaceId = this.plugin.getWorkspaceId();
			const peerId = this.plugin.getPeerId();

			// Test connection
			const ok = await client.testConnection();
			statusEl.empty();
			const dot = statusEl.createSpan({ cls: ok ? "honcho-dot-ok" : "honcho-dot-err" });
			dot.setText(ok ? "\u25CF" : "\u25CF");
			statusEl.createSpan({
				text: ok ? " Connected" : " Disconnected",
				cls: "honcho-status-text",
			});

			if (!ok) {
				body.empty();
				body.createEl("p", { text: "Cannot reach Honcho API.", cls: "honcho-error" });
				return;
			}

			// Ensure workspace + peer exist
			await client.getOrCreateWorkspace(workspaceId);
			await client.getOrCreatePeer(workspaceId, peerId, { observe_me: true });

			// Peer card
			const [cardResp, repResp, conclusionsResp] = await Promise.all([
				client.getPeerCard(workspaceId, peerId),
				client.getPeerRepresentation(workspaceId, peerId).catch(() => ({ representation: "" })),
				client.listConclusions(
					workspaceId,
					{ observer_id: peerId, observed_id: peerId },
					1,
					20
				),
			]);

			body.empty();

			// Peer card section
			if (cardResp.peer_card && cardResp.peer_card.length > 0) {
				const cardSection = body.createDiv({ cls: "honcho-section" });
				cardSection.createEl("h4", { text: "Peer Card" });
				const cardList = cardSection.createEl("ul", { cls: "honcho-card-list" });
				for (const item of cardResp.peer_card) {
					cardList.createEl("li", { text: item });
				}
			}

			// Representation section
			if (repResp.representation) {
				const repSection = body.createDiv({ cls: "honcho-section" });
				repSection.createEl("h4", { text: "Representation" });
				const repContent = repSection.createDiv({ cls: "honcho-representation" });
				await MarkdownRenderer.render(
					this.app,
					repResp.representation,
					repContent,
					"",
					this
				);
			}

			// Recent conclusions
			if (conclusionsResp.items.length > 0) {
				const concSection = body.createDiv({ cls: "honcho-section" });
				concSection.createEl("h4", { text: "Recent Conclusions" });
				const concList = concSection.createDiv({ cls: "honcho-conclusions-list" });
				for (const c of conclusionsResp.items) {
					const item = concList.createDiv({ cls: "honcho-conclusion-item" });
					const date = new Date(c.created_at).toLocaleDateString();
					item.createEl("span", { text: date, cls: "honcho-conclusion-date" });
					item.createEl("span", { text: c.content, cls: "honcho-conclusion-text" });
				}
			}

			if (
				(!cardResp.peer_card || cardResp.peer_card.length === 0) &&
				!repResp.representation &&
				conclusionsResp.items.length === 0
			) {
				body.createEl("p", {
					text: "No data yet. Ingest some notes to build your identity.",
					cls: "honcho-sidebar-empty",
				});
			}
		} catch (err) {
			body.empty();
			body.createEl("p", {
				text: `Error: ${err instanceof Error ? err.message : String(err)}`,
				cls: "honcho-error",
			});
		}
	}

	private async doSidebarSearch(query: string, resultsEl: HTMLElement): Promise<void> {
		if (!query.trim()) return;

		const client = this.plugin.getClient();
		if (!client) return;

		resultsEl.empty();
		resultsEl.createEl("p", { text: "Searching...", cls: "honcho-loading" });

		try {
			const workspaceId = this.plugin.getWorkspaceId();
			const peerId = this.plugin.getPeerId();
			const results = await client.searchConclusions(workspaceId, query, {
				top_k: 10,
				filters: { observer_id: peerId, observed_id: peerId },
			});

			resultsEl.empty();
			if (results.length === 0) {
				resultsEl.createEl("p", { text: "No results.", cls: "honcho-sidebar-empty" });
				return;
			}

			for (const r of results) {
				const card = resultsEl.createDiv({ cls: "honcho-result-card" });
				card.createEl("div", {
					text: r.content,
					cls: "honcho-result-content",
				});
			}
		} catch (err) {
			resultsEl.empty();
			resultsEl.createEl("p", {
				text: `Search error: ${err instanceof Error ? err.message : String(err)}`,
				cls: "honcho-error",
			});
		}
	}
}
