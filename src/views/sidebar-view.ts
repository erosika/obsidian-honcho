import { ItemView, MarkdownRenderer, TFile, type EventRef, type WorkspaceLeaf } from "obsidian";
import type HonchoPlugin from "../main";
import type { ConclusionResponse, MessageResponse } from "../honcho-client";
import { findStaleNotes } from "../utils/sync-status";

export const HONCHO_VIEW_TYPE = "honcho-sidebar";

type ConclusionSort = "newest" | "oldest";

export class HonchoSidebarView extends ItemView {
	private plugin: HonchoPlugin;
	private containerDiv: HTMLElement | null = null;

	// Conclusion explorer state
	private allConclusions: ConclusionResponse[] = [];
	private conclusionSort: ConclusionSort = "newest";
	private conclusionFilter = "";
	private conclusionPage = 1;
	private readonly pageSize = 20;

	// Active note tracking
	private activeNoteRef: EventRef | null = null;
	private activeFile: TFile | null = null;

	// Stale notes cache (30s TTL)
	private staleCountCache: { count: number; ts: number } | null = null;
	private static readonly STALE_CACHE_TTL = 30_000;

	// Connection status cache (60s TTL)
	private connectionCache: { ok: boolean; ts: number } | null = null;
	private static readonly CONN_CACHE_TTL = 60_000;

	// Contextual representation debounce
	private contextualRequestId = 0;
	private contextualDebounceTimer: ReturnType<typeof setTimeout> | null = null;

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

		// Track active file changes for contextual representation (debounced)
		this.activeNoteRef = this.app.workspace.on("active-leaf-change", () => {
			const file = this.app.workspace.getActiveFile();
			if (file !== this.activeFile) {
				this.activeFile = file;
				if (this.contextualDebounceTimer) clearTimeout(this.contextualDebounceTimer);
				this.contextualDebounceTimer = setTimeout(() => {
					this.contextualDebounceTimer = null;
					this.updateContextualSection();
				}, 300);
			}
		});
		this.activeFile = this.app.workspace.getActiveFile();

		await this.render();
	}

	async onClose(): Promise<void> {
		if (this.activeNoteRef) {
			this.app.workspace.offref(this.activeNoteRef);
			this.activeNoteRef = null;
		}
		if (this.contextualDebounceTimer) {
			clearTimeout(this.contextualDebounceTimer);
			this.contextualDebounceTimer = null;
		}
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
		refreshBtn.addEventListener("click", () => {
			this.connectionCache = null; // invalidate on explicit refresh
			this.staleCountCache = null;
			this.render();
		});

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

			// Test connection (cached)
			let ok: boolean;
			if (this.connectionCache && Date.now() - this.connectionCache.ts < HonchoSidebarView.CONN_CACHE_TTL) {
				ok = this.connectionCache.ok;
			} else {
				ok = await client.testConnection();
				this.connectionCache = { ok, ts: Date.now() };
			}
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

			// Use getPeerContext for combined card + representation (single call)
			const [contextResp, conclusionsResp] = await Promise.all([
				client.getPeerContext(workspaceId, peerId).catch(() => ({
					peer_id: peerId,
					target_id: peerId,
					representation: null,
					peer_card: null,
				})),
				client.listConclusions(
					workspaceId,
					{ observer_id: peerId, observed_id: peerId },
					1,
					50
				),
			]);

			body.empty();

			// Peer card section
			if (contextResp.peer_card && contextResp.peer_card.length > 0) {
				const cardSection = body.createDiv({ cls: "honcho-section" });
				cardSection.createEl("h4", { text: "Peer Card" });
				const cardList = cardSection.createEl("ul", { cls: "honcho-card-list" });
				for (const item of contextResp.peer_card) {
					cardList.createEl("li", { text: item });
				}
			}

			// Representation section
			if (contextResp.representation) {
				const repSection = body.createDiv({ cls: "honcho-section" });
				repSection.createEl("h4", { text: "Representation" });
				const repContent = repSection.createDiv({ cls: "honcho-representation" });
				await MarkdownRenderer.render(
					this.app,
					contextResp.representation,
					repContent,
					"",
					this
				);
			}

			// Contextual representation section (updates on active note change)
			const ctxSection = body.createDiv({ cls: "honcho-section honcho-contextual-section" });
			ctxSection.id = "honcho-contextual";
			// Will be populated by updateContextualSection()

			// Conclusion explorer
			this.allConclusions = conclusionsResp.items;
			this.renderConclusionExplorer(body);

			// Sync status section
			this.renderSyncStatus(body);

			if (
				(!contextResp.peer_card || contextResp.peer_card.length === 0) &&
				!contextResp.representation &&
				conclusionsResp.items.length === 0
			) {
				body.createEl("p", {
					text: "No data yet. Ingest some notes to build your identity.",
					cls: "honcho-sidebar-empty",
				});
			}

			// Trigger initial contextual update
			this.updateContextualSection();
		} catch (err) {
			body.empty();
			body.createEl("p", {
				text: `Error: ${err instanceof Error ? err.message : String(err)}`,
				cls: "honcho-error",
			});
		}
	}

	// ---------------------------------------------------------------------------
	// Conclusion Explorer
	// ---------------------------------------------------------------------------

	private renderConclusionExplorer(parent: HTMLElement): void {
		if (this.allConclusions.length === 0) return;

		const section = parent.createDiv({ cls: "honcho-section" });
		section.createEl("h4", { text: "Conclusions" });

		// Filter bar
		const filterBar = section.createDiv({ cls: "honcho-filter-bar" });

		// Sort chips
		const sortGroup = filterBar.createDiv({ cls: "honcho-chip-group" });
		const newestChip = sortGroup.createEl("button", {
			text: "Newest",
			cls: `honcho-filter-chip${this.conclusionSort === "newest" ? " active" : ""}`,
		});
		const oldestChip = sortGroup.createEl("button", {
			text: "Oldest",
			cls: `honcho-filter-chip${this.conclusionSort === "oldest" ? " active" : ""}`,
		});

		newestChip.addEventListener("click", () => {
			this.conclusionSort = "newest";
			this.conclusionPage = 1;
			this.refreshExplorer(section);
		});
		oldestChip.addEventListener("click", () => {
			this.conclusionSort = "oldest";
			this.conclusionPage = 1;
			this.refreshExplorer(section);
		});

		// Text filter
		const filterInput = filterBar.createEl("input", {
			type: "text",
			placeholder: "Filter conclusions...",
			cls: "honcho-filter-input",
		});
		filterInput.value = this.conclusionFilter;
		filterInput.addEventListener("input", () => {
			this.conclusionFilter = filterInput.value;
			this.conclusionPage = 1;
			this.refreshExplorerList(section);
		});

		// Count
		const countEl = section.createDiv({ cls: "honcho-conclusion-count" });
		this.updateCount(countEl);

		// Conclusion list
		const listEl = section.createDiv({ cls: "honcho-conclusions-list" });
		this.renderConclusionList(listEl);

		// Pagination
		const pagEl = section.createDiv({ cls: "honcho-explorer-pagination" });
		this.renderPagination(pagEl);
	}

	private getFilteredConclusions(): ConclusionResponse[] {
		let items = [...this.allConclusions];

		// Text filter
		if (this.conclusionFilter) {
			const q = this.conclusionFilter.toLowerCase();
			items = items.filter((c) => c.content.toLowerCase().includes(q));
		}

		// Sort
		items.sort((a, b) => {
			const da = new Date(a.created_at).getTime();
			const db = new Date(b.created_at).getTime();
			return this.conclusionSort === "newest" ? db - da : da - db;
		});

		return items;
	}

	private refreshExplorer(section: HTMLElement): void {
		// Update chip active states
		const chips = section.querySelectorAll(".honcho-filter-chip");
		chips.forEach((chip) => {
			const text = chip.textContent?.toLowerCase() ?? "";
			chip.classList.toggle("active", text === this.conclusionSort);
		});
		this.refreshExplorerList(section);
	}

	private refreshExplorerList(section: HTMLElement): void {
		const countEl = section.querySelector(".honcho-conclusion-count") as HTMLElement;
		const listEl = section.querySelector(".honcho-conclusions-list") as HTMLElement;
		const pagEl = section.querySelector(".honcho-explorer-pagination") as HTMLElement;

		if (countEl) this.updateCount(countEl);
		if (listEl) this.renderConclusionList(listEl);
		if (pagEl) this.renderPagination(pagEl);
	}

	private updateCount(el: HTMLElement): void {
		const filtered = this.getFilteredConclusions();
		const total = this.allConclusions.length;
		const shown = filtered.length;
		el.empty();
		el.setText(shown === total ? `${total} conclusions` : `${shown} of ${total} conclusions`);
	}

	private renderConclusionList(el: HTMLElement): void {
		el.empty();
		const items = this.getFilteredConclusions();
		const start = (this.conclusionPage - 1) * this.pageSize;
		const page = items.slice(start, start + this.pageSize);

		for (const c of page) {
			const item = el.createDiv({ cls: "honcho-conclusion-item" });
			const date = new Date(c.created_at).toLocaleDateString();
			item.createEl("span", { text: date, cls: "honcho-conclusion-date" });
			item.createEl("span", { text: c.content, cls: "honcho-conclusion-text" });
		}

		if (page.length === 0) {
			el.createEl("p", { text: "No matching conclusions.", cls: "honcho-sidebar-empty" });
		}
	}

	private renderPagination(el: HTMLElement): void {
		el.empty();
		const items = this.getFilteredConclusions();
		const totalPages = Math.ceil(items.length / this.pageSize);
		if (totalPages <= 1) return;

		const prevBtn = el.createEl("button", { text: "\u2190", cls: "honcho-btn-small" });
		prevBtn.disabled = this.conclusionPage <= 1;
		prevBtn.addEventListener("click", () => {
			if (this.conclusionPage > 1) {
				this.conclusionPage--;
				this.refreshExplorerList(el.parentElement!);
			}
		});

		el.createEl("span", {
			text: `${this.conclusionPage} / ${totalPages}`,
			cls: "honcho-page-label",
		});

		const nextBtn = el.createEl("button", { text: "\u2192", cls: "honcho-btn-small" });
		nextBtn.disabled = this.conclusionPage >= totalPages;
		nextBtn.addEventListener("click", () => {
			if (this.conclusionPage < totalPages) {
				this.conclusionPage++;
				this.refreshExplorerList(el.parentElement!);
			}
		});
	}

	// ---------------------------------------------------------------------------
	// Sync status
	// ---------------------------------------------------------------------------

	private async renderSyncStatus(parent: HTMLElement): Promise<void> {
		const section = parent.createDiv({ cls: "honcho-section honcho-sync-status-section" });
		section.createEl("h4", { text: "Sync Status" });
		const statusEl = section.createDiv({ cls: "honcho-sync-status-body" });

		try {
			// Use cached count if fresh enough
			let count: number;
			if (this.staleCountCache && Date.now() - this.staleCountCache.ts < HonchoSidebarView.STALE_CACHE_TTL) {
				count = this.staleCountCache.count;
			} else {
				statusEl.createSpan({ text: "Checking...", cls: "honcho-loading" });
				const stale = await findStaleNotes(this.app);
				count = stale.length;
				this.staleCountCache = { count, ts: Date.now() };
				statusEl.empty();
			}

			if (count === 0) {
				statusEl.createSpan({ text: "All notes up to date", cls: "honcho-text-muted" });
			} else {
				statusEl.createSpan({
					text: `${count} stale note${count !== 1 ? "s" : ""}`,
					cls: "honcho-text-accent",
				});

				const btn = statusEl.createEl("button", {
					text: "View",
					cls: "honcho-btn-small",
				});
				btn.addEventListener("click", () => {
					this.staleCountCache = null; // invalidate on user action
					this.app.commands.executeCommandById("honcho:show-stale-notes");
				});
			}
		} catch {
			statusEl.empty();
			statusEl.createSpan({ text: "Could not check sync status", cls: "honcho-text-muted" });
		}
	}

	// ---------------------------------------------------------------------------
	// Contextual representation (active note awareness)
	// ---------------------------------------------------------------------------

	private async updateContextualSection(): Promise<void> {
		const section = this.containerDiv?.querySelector("#honcho-contextual") as HTMLElement;
		if (!section) return;

		section.empty();

		if (!this.activeFile || this.activeFile.extension !== "md") return;

		const client = this.plugin.getClient();
		if (!client) return;

		// Increment request ID to discard stale responses
		const requestId = ++this.contextualRequestId;

		const workspaceId = this.plugin.getWorkspaceId();
		const peerId = this.plugin.getPeerId();

		// Extract note context for search_query
		const cache = this.app.metadataCache.getFileCache(this.activeFile);
		const tags = (cache?.tags ?? []).map((t) => t.tag);
		const headings = (cache?.headings ?? []).map((h) => h.heading);
		const searchQuery = [this.activeFile.basename, ...tags, ...headings.slice(0, 3)].join(" ");

		section.createEl("h4", { text: `Relevant to: ${this.activeFile.basename}` });
		const contextLabel = section.createDiv({ cls: "honcho-context-label" });
		contextLabel.setText("Loading contextual representation...");

		try {
			const rep = await client.getPeerRepresentation(workspaceId, peerId, {
				search_query: searchQuery,
				search_top_k: 10,
			});

			// Discard if a newer request has been issued
			if (requestId !== this.contextualRequestId) return;

			contextLabel.remove();

			if (rep.representation) {
				const repContent = section.createDiv({ cls: "honcho-representation" });
				await MarkdownRenderer.render(
					this.app,
					rep.representation,
					repContent,
					"",
					this
				);
			} else {
				section.createEl("p", {
					text: "No relevant context found.",
					cls: "honcho-sidebar-empty",
				});
			}
		} catch {
			if (requestId !== this.contextualRequestId) return;
			contextLabel.setText("Could not load contextual representation.");
			contextLabel.addClass("honcho-error");
		}
	}

	// ---------------------------------------------------------------------------
	// Search
	// ---------------------------------------------------------------------------

	private async doSidebarSearch(query: string, resultsEl: HTMLElement): Promise<void> {
		if (!query.trim()) return;

		const client = this.plugin.getClient();
		if (!client) return;

		resultsEl.empty();
		resultsEl.createEl("p", { text: "Searching...", cls: "honcho-loading" });

		try {
			const workspaceId = this.plugin.getWorkspaceId();
			const peerId = this.plugin.getPeerId();

			// Search both conclusions and workspace messages in parallel
			const [conclusions, messages] = await Promise.all([
				client.searchConclusions(workspaceId, query, {
					top_k: 5,
					filters: { observer_id: peerId, observed_id: peerId },
				}),
				client.searchWorkspace(workspaceId, query, { limit: 5 }),
			]);

			resultsEl.empty();

			if (conclusions.length === 0 && messages.length === 0) {
				resultsEl.createEl("p", { text: "No results.", cls: "honcho-sidebar-empty" });
				return;
			}

			// Conclusions
			for (const r of conclusions) {
				const card = resultsEl.createDiv({ cls: "honcho-result-card" });
				card.createEl("div", {
					text: r.content,
					cls: "honcho-result-content",
				});
			}

			// Messages with source file links
			for (const m of messages) {
				const card = resultsEl.createDiv({ cls: "honcho-result-card" });
				card.createEl("div", {
					text: m.content,
					cls: "honcho-result-content",
				});
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
						}
					});
				}
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
