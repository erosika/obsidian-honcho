import { App, Modal, Setting } from "obsidian";
import type { HonchoClient, ConclusionResponse } from "../honcho-client";

export class HonchoSearchModal extends Modal {
	private client: HonchoClient;
	private workspaceId: string;
	private peerId: string;
	private resultsEl: HTMLElement;

	constructor(
		app: App,
		client: HonchoClient,
		workspaceId: string,
		peerId: string
	) {
		super(app);
		this.client = client;
		this.workspaceId = workspaceId;
		this.peerId = peerId;
		this.resultsEl = createEl("div");
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("honcho-search-modal");

		contentEl.createEl("h2", { text: "Search Honcho Memory" });

		let query = "";

		new Setting(contentEl)
			.setName("Query")
			.addText((text) => {
				text.setPlaceholder("What do you want to find?");
				text.inputEl.style.width = "100%";
				text.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						this.doSearch(query);
					}
				});
				text.onChange((value) => {
					query = value;
				});
				// Auto-focus
				setTimeout(() => text.inputEl.focus(), 50);
			});

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("Search").setCta().onClick(() => {
					this.doSearch(query);
				})
			);

		this.resultsEl = contentEl.createDiv({ cls: "honcho-search-results" });
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async doSearch(query: string): Promise<void> {
		if (!query.trim()) return;

		this.resultsEl.empty();
		this.resultsEl.createEl("p", { text: "Searching...", cls: "honcho-search-loading" });

		try {
			const results = await this.client.searchConclusions(
				this.workspaceId,
				query,
				{
					top_k: 20,
					filters: {
						observer_id: this.peerId,
						observed_id: this.peerId,
					},
				}
			);

			this.resultsEl.empty();

			if (results.length === 0) {
				this.resultsEl.createEl("p", {
					text: "No results found.",
					cls: "honcho-search-empty",
				});
				return;
			}

			this.resultsEl.createEl("p", {
				text: `${results.length} result${results.length !== 1 ? "s" : ""}`,
				cls: "honcho-search-count",
			});

			for (const r of results) {
				const card = this.resultsEl.createDiv({ cls: "honcho-result-card" });
				const date = new Date(r.created_at).toLocaleString();
				card.createEl("div", { text: date, cls: "honcho-result-date" });
				card.createEl("div", { text: r.content, cls: "honcho-result-content" });
			}
		} catch (err) {
			this.resultsEl.empty();
			this.resultsEl.createEl("p", {
				text: `Error: ${err instanceof Error ? err.message : String(err)}`,
				cls: "honcho-search-error",
			});
		}
	}
}
