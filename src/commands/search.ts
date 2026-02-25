import { App, Modal, Setting, TFile } from "obsidian";
import type { HonchoClient, ConclusionResponse, MessageResponse } from "../honcho-client";

type SearchMode = "all" | "conclusions" | "messages";

export class HonchoSearchModal extends Modal {
	private client: HonchoClient;
	private workspaceId: string;
	private peerId: string;
	private resultsEl: HTMLElement;
	private searchMode: SearchMode = "all";

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
			.setName("Search in")
			.addDropdown((dd) => {
				dd.addOption("all", "All");
				dd.addOption("conclusions", "Conclusions");
				dd.addOption("messages", "Messages");
				dd.setValue(this.searchMode);
				dd.onChange((value) => {
					this.searchMode = value as SearchMode;
				});
			})
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
			const searchConclusions = this.searchMode === "all" || this.searchMode === "conclusions";
			const searchMessages = this.searchMode === "all" || this.searchMode === "messages";

			const [conclusions, messages] = await Promise.all([
				searchConclusions
					? this.client.searchConclusions(this.workspaceId, query, {
						top_k: 20,
						filters: {
							observer_id: this.peerId,
							observed_id: this.peerId,
						},
					})
					: Promise.resolve([] as ConclusionResponse[]),
				searchMessages
					? this.client.searchWorkspace(this.workspaceId, query, { limit: 20 })
					: Promise.resolve([] as MessageResponse[]),
			]);

			this.resultsEl.empty();

			const totalResults = conclusions.length + messages.length;
			if (totalResults === 0) {
				this.resultsEl.createEl("p", {
					text: "No results found.",
					cls: "honcho-search-empty",
				});
				return;
			}

			this.resultsEl.createEl("p", {
				text: `${totalResults} result${totalResults !== 1 ? "s" : ""}`,
				cls: "honcho-search-count",
			});

			// Conclusions section
			if (conclusions.length > 0) {
				const section = this.resultsEl.createDiv({ cls: "honcho-search-section" });
				section.createEl("h4", { text: "Conclusions" });
				for (const r of conclusions) {
					const card = section.createDiv({ cls: "honcho-result-card" });
					const date = new Date(r.created_at).toLocaleString();
					card.createEl("div", { text: date, cls: "honcho-result-date" });
					card.createEl("div", { text: r.content, cls: "honcho-result-content" });
				}
			}

			// Messages section
			if (messages.length > 0) {
				const section = this.resultsEl.createDiv({ cls: "honcho-search-section" });
				section.createEl("h4", { text: "Messages" });
				for (const m of messages) {
					const card = section.createDiv({ cls: "honcho-result-card" });
					const date = new Date(m.created_at).toLocaleString();
					card.createEl("div", { text: date, cls: "honcho-result-date" });
					card.createEl("div", { text: m.content, cls: "honcho-result-content" });

					// Source file link from metadata
					const sourceFile = m.metadata?.source_file as string | undefined;
					if (sourceFile) {
						const link = card.createEl("a", {
							text: sourceFile,
							cls: "honcho-result-source",
							href: "#",
						});
						link.addEventListener("click", (e) => {
							e.preventDefault();
							const file = this.app.vault.getAbstractFileByPath(sourceFile);
							if (file instanceof TFile) {
								this.app.workspace.getLeaf().openFile(file);
								this.close();
							}
						});
					}
				}
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
