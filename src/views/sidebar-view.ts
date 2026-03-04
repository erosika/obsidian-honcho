import { ItemView, MarkdownRenderer, Notice, TFile, type WorkspaceLeaf } from "obsidian";
import type HonchoPlugin from "../main";
import { findStaleNotes } from "../utils/sync-status";
import { normalizeFrontmatterTags, readHonchoFrontmatter } from "../utils/frontmatter";

export const HONCHO_VIEW_TYPE = "honcho-sidebar";

// ---------------------------------------------------------------------------
// Peer card item grouping
// ---------------------------------------------------------------------------

interface CardGroup {
	key: string;
	label: string;
	items: string[];
	cls: string;
	collapsed: boolean;
}

interface ChatMessage {
	role: "user" | "assistant";
	content: string;
}

interface RepresentationEntry {
	ts: string | null;
	body: string;
}

interface FrontmatterSuggestion {
	tags: Array<{ value: string; confidence: ConfidenceLevel }>;
	aliases: Array<{ value: string; confidence: ConfidenceLevel }>;
	properties: Array<{ key: string; value: unknown; confidence: ConfidenceLevel }>;
}

type ConfidenceLevel = "high" | "medium" | "low";

const CARD_PREFIXES: Array<{ prefix: string; key: string; label: string; cls: string }> = [
	{ prefix: "PATTERN:", key: "pattern", label: "Patterns", cls: "honcho-group-pattern" },
	{ prefix: "TRAIT:", key: "trait", label: "Traits", cls: "honcho-group-trait" },
	{ prefix: "PREFERENCE:", key: "preference", label: "Preferences", cls: "honcho-group-preference" },
];

// Items starting with these prefixes are system directives for the AI -- not
// useful to reflect back to the user as profile information.
const HIDDEN_PREFIXES = ["INSTRUCTION:"];

function groupCardItems(items: string[]): CardGroup[] {
	const groups: Map<string, CardGroup> = new Map();

	// General group for items without a prefix
	groups.set("general", {
		key: "general",
		label: "Identity",
		items: [],
		cls: "honcho-group-general",
		collapsed: false,
	});

	for (const { key, label, cls } of CARD_PREFIXES) {
		groups.set(key, { key, label, items: [], cls, collapsed: true });
	}

	for (const item of items) {
		// Skip system directives
		if (HIDDEN_PREFIXES.some((p) => item.startsWith(p))) continue;

		let matched = false;
		for (const { prefix, key } of CARD_PREFIXES) {
			if (item.startsWith(prefix)) {
				groups.get(key)!.items.push(item.slice(prefix.length).trim());
				matched = true;
				break;
			}
		}
		if (!matched) {
			groups.get("general")!.items.push(item);
		}
	}

	// Return only non-empty groups, general first
	return Array.from(groups.values()).filter((g) => g.items.length > 0);
}

// ---------------------------------------------------------------------------
// Sidebar View
// ---------------------------------------------------------------------------

export class HonchoSidebarView extends ItemView {
	private plugin: HonchoPlugin;
	private containerDiv: HTMLElement | null = null;

	// Stale notes cache (30s TTL)
	private staleCountCache: { count: number; ts: number } | null = null;
	private static readonly STALE_CACHE_TTL = 30_000;

	// Connection status cache (60s TTL)
	private connectionCache: { ok: boolean; ts: number } | null = null;
	private static readonly CONN_CACHE_TTL = 60_000;

	// Active file context
	private activeFile: TFile | null = null;
	private briefingEl: HTMLElement | null = null;
	private frontmatterEl: HTMLElement | null = null;
	private briefingTimer: ReturnType<typeof setTimeout> | null = null;
	private briefingCache: Map<string, { rep: string; ts: number }> = new Map();
	private static readonly BRIEFING_CACHE_TTL = 5 * 60 * 1000;
	private frontmatterCache: Map<string, { suggestion: FrontmatterSuggestion; ts: number }> = new Map();
	private frontmatterLoadingPath: string | null = null;
	private frontmatterApplyingPath: string | null = null;
	private frontmatterAutoSuggestedPaths: Set<string> = new Set();
	private frontmatterDismissedPaths: Set<string> = new Set();
	private frontmatterCollapsed = false;
	private frontmatterSelectionState: Map<string, Map<string, boolean>> = new Map();
	private frontmatterAppliedState: Map<
		string,
		{ tags: Set<string>; aliases: Set<string>; properties: Set<string> }
	> = new Map();
	private static readonly FRONTMATTER_CACHE_TTL = 10 * 60 * 1000;

	// Peer card editing state
	private peerCardItems: string[] = [];
	private peerCardHiddenItems: string[] = [];
	private peerCardEditMode = false;
	private peerCardDraft = "";
	private peerCardSaving = false;

	// Chat state (persists across re-renders)
	private chatMessages: ChatMessage[] = [];
	private chatSending = false;
	private chatAbortController: AbortController | null = null;
	private chatEl: HTMLElement | null = null;
	private chatInputEl: HTMLTextAreaElement | null = null;

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

		// Seed active file from whatever is open right now
		this.activeFile = this.app.workspace.getActiveFile();
		await this.render();
	}

	async onClose(): Promise<void> {
		this.chatAbortController?.abort();
		this.chatAbortController = null;
		if (this.briefingTimer) clearTimeout(this.briefingTimer);
		this.briefingTimer = null;
	}

	/** Called by main.ts on every file-open event. */
	setActiveFile(file: TFile | null): void {
		this.activeFile = file;
		// Debounce: ignore rapid tab switching
		if (this.briefingTimer) clearTimeout(this.briefingTimer);
		this.briefingTimer = setTimeout(() => {
			this.briefingTimer = null;
			void this.refreshFrontmatterSuggestions();
			if (file && this.plugin.settings.autoSuggestFrontmatterOnOpen) {
				void this.maybeAutoSuggestFrontmatter(file);
			}
		}, 400);
	}

	private async refreshBriefing(): Promise<void> {
		const el = this.briefingEl;
		if (!el) return;
		el.empty();

		const file = this.activeFile;
		if (!file) return;

		const client = this.plugin.getClient();
		if (!client) return;

		// Serve from cache when fresh
		const cached = this.briefingCache.get(file.path);
		if (cached && Date.now() - cached.ts < HonchoSidebarView.BRIEFING_CACHE_TTL) {
			if (cached.rep) {
				const repContent = el.createDiv({ cls: "honcho-briefing-content honcho-representation" });
				await MarkdownRenderer.render(this.app, cached.rep, repContent, "", this);
				this.postProcessRepresentation(repContent);
			}
			return;
		}

		const loadEl = el.createEl("p", { text: "fetching context\u2026", cls: "honcho-loading" });

		try {
			const cache = this.app.metadataCache.getFileCache(file);
			const tags = (cache?.tags ?? []).map((t) => t.tag).join(" ");
			const headings = (cache?.headings ?? []).map((h) => h.heading).slice(0, 3).join(" ");
			const searchQuery = [file.basename, tags, headings].filter(Boolean).join(" ");

			const rep = await client.getPeerRepresentation(
				this.plugin.getWorkspaceId(),
				this.plugin.getPeerId(),
				{ search_query: searchQuery, search_top_k: 5 }
			);

			loadEl.remove();

			this.briefingCache.set(file.path, {
				rep: rep.representation ?? "",
				ts: Date.now(),
			});

			if (rep.representation?.trim()) {
				const repContent = el.createDiv({ cls: "honcho-briefing-content honcho-representation" });
				await MarkdownRenderer.render(this.app, rep.representation, repContent, "", this);
				this.postProcessRepresentation(repContent);
			}
		} catch {
			loadEl.remove();
			// Fail silently -- briefing is best-effort
		}
	}

	async render(): Promise<void> {
		if (!this.containerDiv) return;
		const el = this.containerDiv;
		el.empty();

		// Invalidate element refs -- will be reassigned below
		this.chatEl = null;
		this.chatInputEl = null;
		this.briefingEl = null;
		this.frontmatterEl = null;

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

		// Connection status + refresh
		const headerRight = header.createDiv({ cls: "honcho-header-right" });
		const statusEl = headerRight.createDiv({ cls: "honcho-status" });
		statusEl.createSpan({ text: "Checking\u2026", cls: "honcho-status-text" });

		const refreshBtn = headerRight.createEl("button", {
			cls: "honcho-refresh-btn clickable-icon",
			attr: { "aria-label": "Refresh" },
		});
		refreshBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`;
		refreshBtn.addEventListener("click", () => {
			this.connectionCache = null;
			this.staleCountCache = null;
			this.frontmatterCache.clear();
			this.frontmatterAutoSuggestedPaths.clear();
			this.frontmatterDismissedPaths.clear();
			this.frontmatterSelectionState.clear();
			this.render();
		});

		// Body
		const body = el.createDiv({ cls: "honcho-sidebar-body" });
		body.createEl("p", { text: "Loading\u2026", cls: "honcho-loading" });

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
			statusEl.createSpan({
				cls: ok ? "honcho-dot-ok" : "honcho-dot-err",
				text: "\u25CF",
			});
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

			// Fetch peer card only (observations are intentionally hidden in sidebar)
			const cardResp = await client.getPeerCard(workspaceId, peerId).catch(() => ({
				peer_card: null as string[] | null,
			}));
			this.peerCardItems = cardResp.peer_card ?? [];
			const { visibleItems, hiddenItems } = this.splitPeerCardItems(this.peerCardItems);
			this.peerCardHiddenItems = hiddenItems;
			if (!this.peerCardEditMode) {
				this.peerCardDraft = this.formatPeerCardDraft(visibleItems);
			}

			body.empty();

			// Sync status
			await this.renderSyncStatus(body);

			// Suggested frontmatter for active note
			this.renderFrontmatterSection(body);

			// Chat
			this.renderChat(body);

			// Identity + peer card (unified section)
			const groups = groupCardItems(visibleItems);
			const identityGroup = groups.find((g) => g.key === "general");
			this.renderIdentityCard(body, identityGroup?.items ?? []);
			for (const group of groups) {
				if (group.key === "general") continue;
				this.renderCardGroup(body, group);
			}

		} catch (err) {
			body.empty();
			body.createEl("p", {
				text: `Error: ${err instanceof Error ? err.message : String(err)}`,
				cls: "honcho-error",
			});
		}
	}

	private renderIdentityCard(parent: HTMLElement, items: string[]): void {
		const section = parent.createDiv({ cls: "honcho-section honcho-card-group honcho-group-general" });
		const details = section.createEl("details", { attr: { open: "" } });
		const summary = details.createEl("summary", { cls: "honcho-group-summary" });
		summary.createEl("h4", { text: "Identity" });
		summary.createSpan({ text: String(items.length), cls: "honcho-group-count" });

		const actions = summary.createDiv({ cls: "honcho-group-actions" });
		if (!this.peerCardEditMode) {
			const editBtn = actions.createEl("button", {
				text: "Edit",
				cls: "honcho-btn-small",
			});
			editBtn.addEventListener("click", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				this.peerCardEditMode = true;
				this.peerCardDraft = this.formatPeerCardDraft(items);
				void this.render();
			});
		} else {
			const cancelBtn = actions.createEl("button", {
				text: "Cancel",
				cls: "honcho-btn-small",
			});
			cancelBtn.disabled = this.peerCardSaving;
			cancelBtn.addEventListener("click", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				this.cancelIdentityEdits();
			});

			const saveBtn = actions.createEl("button", {
				text: this.peerCardSaving ? "Saving..." : "Save",
				cls: "honcho-btn-small mod-cta",
			});
			saveBtn.disabled = this.peerCardSaving;
			saveBtn.addEventListener("click", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				void this.saveIdentityEdits();
			});
		}

		if (this.peerCardEditMode) {
			const input = details.createEl("textarea", {
				cls: "honcho-identity-editor-input",
				attr: {
					rows: "8",
					placeholder: "- One peer card item per line",
				},
			});
			input.value = this.peerCardDraft;
			input.addEventListener("input", () => {
				this.peerCardDraft = input.value;
			});

			details.createEl("p", {
				text: "One item per line. Use PATTERN:, TRAIT:, or PREFERENCE: prefixes to control grouping.",
				cls: "honcho-frontmatter-note",
			});
			return;
		}

		if (items.length === 0) {
			details.createEl("p", {
				text: "No peer card yet. Click Edit to add identity items.",
				cls: "honcho-sidebar-empty",
			});
			return;
		}

		const list = details.createEl("ul", { cls: "honcho-card-list" });
		for (const item of items) {
			this.renderCardItem(list, {
				key: "general",
				label: "Identity",
				items: [],
				cls: "honcho-group-general",
				collapsed: false,
			}, item);
		}
	}

	private splitPeerCardItems(items: string[]): {
		visibleItems: string[];
		hiddenItems: string[];
	} {
		const visibleItems: string[] = [];
		const hiddenItems: string[] = [];
		for (const item of items) {
			if (HIDDEN_PREFIXES.some((prefix) => item.startsWith(prefix))) {
				hiddenItems.push(item);
			} else {
				visibleItems.push(item);
			}
		}
		return { visibleItems, hiddenItems };
	}

	private formatPeerCardDraft(items: string[]): string {
		return items.map((item) => `- ${item}`).join("\n");
	}

	private parsePeerCardDraft(draft: string): string[] {
		return Array.from(
			new Set(
				draft
					.split("\n")
					.map((line) => line.trim())
					.map((line) => line.replace(/^[-*+]\s+/, "").trim())
					.filter((line) => line.length > 0)
			)
		);
	}

	private cancelIdentityEdits(): void {
		this.peerCardEditMode = false;
		const { visibleItems } = this.splitPeerCardItems(this.peerCardItems);
		this.peerCardDraft = this.formatPeerCardDraft(visibleItems);
		void this.render();
	}

	private async saveIdentityEdits(): Promise<void> {
		if (this.peerCardSaving) return;
		const client = this.plugin.getClient();
		if (!client) return;

		this.peerCardSaving = true;
		await this.render();
		try {
			const editedItems = this.parsePeerCardDraft(this.peerCardDraft);
			const nextCard = [...this.peerCardHiddenItems, ...editedItems];
			await client.setPeerCard(
				this.plugin.getWorkspaceId(),
				this.plugin.getPeerId(),
				nextCard
			);

			this.peerCardItems = nextCard;
			this.peerCardEditMode = false;
			this.peerCardDraft = this.formatPeerCardDraft(editedItems);
			new Notice(`Saved identity peer card (${editedItems.length} items)`);
		} catch (err) {
			new Notice(`Failed to save peer card: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this.peerCardSaving = false;
			await this.render();
		}
	}

	private renderFrontmatterSection(parent: HTMLElement): void {
		const section = parent.createDiv({ cls: "honcho-section honcho-frontmatter-section" });
		this.frontmatterEl = section;
		void this.refreshFrontmatterSuggestions();
	}

	private async refreshFrontmatterSuggestions(): Promise<void> {
		const section = this.frontmatterEl;
		if (!section) return;
		section.empty();

		const header = section.createDiv({ cls: "honcho-section-header" });
		const titleToggle = header.createDiv({ cls: "honcho-section-toggle" });
		titleToggle.setAttribute("role", "button");
		titleToggle.setAttribute("tabindex", "0");
		titleToggle.createSpan({ text: "Suggested Frontmatter" });
		titleToggle.addClass(this.frontmatterCollapsed ? "is-collapsed" : "is-expanded");
		const toggle = () => {
			this.frontmatterCollapsed = !this.frontmatterCollapsed;
			void this.refreshFrontmatterSuggestions();
		};
		titleToggle.addEventListener("click", toggle);
		titleToggle.addEventListener("keydown", (evt) => {
			if (evt.key !== "Enter" && evt.key !== " ") return;
			evt.preventDefault();
			toggle();
		});

		const file = this.activeFile;
		const cached = file ? this.frontmatterCache.get(file.path) : null;
		const hasCachedSuggestion = !!cached;
		const headerActions = header.createDiv({ cls: "honcho-inline-actions" });
		const refreshBtn = headerActions.createEl("button", {
			cls: "honcho-icon-btn clickable-icon",
			attr: {
				"aria-label": file && hasCachedSuggestion ? "Refresh suggestions" : "Suggest frontmatter",
				title: file && hasCachedSuggestion ? "Refresh suggestions" : "Generate suggestions",
			},
		});
		refreshBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.13-3.36L23 10"></path><path d="M20.49 15a9 9 0 0 1-14.13 3.36L1 14"></path></svg>`;

		const infoBtn = headerActions.createEl("button", {
			cls: "honcho-icon-btn clickable-icon",
			attr: {
				"aria-label": "How suggestions work",
				title: "Suggestions combine this note context (title, tags, headings, links, excerpt) with existing Honcho memory. As more notes are ingested, suggestion quality usually improves.",
			},
		});
		infoBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
		infoBtn.addEventListener("click", () => this.showFrontmatterInfo());

		const settingsBtn = headerActions.createEl("button", {
			cls: "honcho-icon-btn clickable-icon",
			attr: { "aria-label": "Frontmatter settings", title: "Open Honcho settings" },
		});
		settingsBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1.2 1.83l-.16.07a2 2 0 0 1-2.16-.35l-.13-.13a2 2 0 0 0-2.83 0l-.31.31a2 2 0 0 0 0 2.83l.13.13a2 2 0 0 1 .35 2.16l-.07.16A2 2 0 0 1 2 12.78V13.22a2 2 0 0 0 2 2h.18a2 2 0 0 1 1.83 1.2l.07.16a2 2 0 0 1-.35 2.16l-.13.13a2 2 0 0 0 0 2.83l.31.31a2 2 0 0 0 2.83 0l.13-.13a2 2 0 0 1 2.16-.35l.16.07a2 2 0 0 1 1.2 1.83V22a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1.2-1.83l.16-.07a2 2 0 0 1 2.16.35l.13.13a2 2 0 0 0 2.83 0l.31-.31a2 2 0 0 0 0-2.83l-.13-.13a2 2 0 0 1-.35-2.16l.07-.16A2 2 0 0 1 22 13.22v-.44a2 2 0 0 0-2-2h-.18a2 2 0 0 1-1.83-1.2l-.07-.16a2 2 0 0 1 .35-2.16l.13-.13a2 2 0 0 0 0-2.83l-.31-.31a2 2 0 0 0-2.83 0l-.13.13a2 2 0 0 1-2.16.35l-.16-.07a2 2 0 0 1-1.2-1.83V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
		settingsBtn.addEventListener("click", () => this.openFrontmatterSettings());

		const fileCache = file ? this.app.metadataCache.getFileCache(file) : null;
		const isHonchoGenerated = !!fileCache?.frontmatter?.honcho_generated;
		refreshBtn.disabled = !file || this.frontmatterLoadingPath === file.path || isHonchoGenerated;
		if (file && !isHonchoGenerated) {
			refreshBtn.addEventListener("click", () => {
				void this.generateFrontmatterSuggestion(file);
			});
		}

		if (this.frontmatterCollapsed) return;

		const controls = section.createDiv({ cls: "honcho-frontmatter-actions" });

		if (!file) {
			section.createEl("p", {
				text: "Open a note to generate frontmatter suggestions.",
				cls: "honcho-sidebar-empty",
			});
			return;
		}

		if (isHonchoGenerated) {
			section.createEl("p", {
				text: "Suggestions are hidden for Honcho-generated notes.",
				cls: "honcho-sidebar-empty",
			});
			return;
		}

		if (this.frontmatterDismissedPaths.has(file.path)) {
			refreshBtn.disabled = true;
			const showBtn = controls.createEl("button", {
				text: "Show",
				cls: "honcho-btn-small",
			});
			showBtn.addEventListener("click", () => {
				this.frontmatterDismissedPaths.delete(file.path);
				void this.refreshFrontmatterSuggestions();
			});
			section.createEl("p", {
				text: "Suggestions dismissed for this note.",
				cls: "honcho-sidebar-empty",
			});
			return;
		}

		const dismissBtn = controls.createEl("button", {
			text: "Dismiss",
			cls: "honcho-btn-small",
		});
		dismissBtn.addEventListener("click", () => {
			this.frontmatterDismissedPaths.add(file.path);
			void this.refreshFrontmatterSuggestions();
		});

		section.createEl("p", {
			text: `Active note: ${file.basename}`,
			cls: "honcho-frontmatter-note",
		});

		const isFresh = !!cached && Date.now() - cached.ts < HonchoSidebarView.FRONTMATTER_CACHE_TTL;
		const suggestion = isFresh ? cached.suggestion : null;
		const existing = this.getExistingFrontmatterState(file);
		const isApplying = this.frontmatterApplyingPath === file.path;

		if (!suggestion) {
			if (this.plugin.settings.autoSuggestFrontmatterOnOpen && this.frontmatterLoadingPath !== file.path) {
				void this.maybeAutoSuggestFrontmatter(file);
			}
			if (this.frontmatterLoadingPath === file.path) {
				section.createEl("p", { text: "Generating suggestions...", cls: "honcho-loading" });
			} else {
				section.createEl("p", {
					text: "Generate suggestions based on this note and your Honcho identity.",
					cls: "honcho-sidebar-empty",
				});
			}
			return;
		}

		if (suggestion.tags.length === 0 && suggestion.aliases.length === 0 && suggestion.properties.length === 0) {
			section.createEl("p", {
				text: "No useful frontmatter suggestions right now.",
				cls: "honcho-sidebar-empty",
			});
			return;
		}

		const selectableIds = new Set<string>();
		for (const tag of suggestion.tags) {
			if (!existing.tags.has(tag.value)) selectableIds.add(`tag:${tag.value}`);
		}
		for (const alias of suggestion.aliases) {
			if (!existing.aliases.has(alias.value)) selectableIds.add(`alias:${alias.value}`);
		}
		for (const prop of suggestion.properties) {
			if (!existing.properties.has(prop.key)) selectableIds.add(`prop:${prop.key}`);
		}
		const selection = this.syncFrontmatterSelectionState(file.path, selectableIds);
		const selectedCount = Array.from(selectableIds).reduce(
			(count, id) => count + (selection.get(id) ? 1 : 0),
			0
		);

		const selectAllBtn = controls.createEl("button", {
			text: "Select all",
			cls: "honcho-btn-small",
		});
		selectAllBtn.disabled = selectableIds.size === 0 || isApplying;
		selectAllBtn.addEventListener("click", () => {
			const state = this.getFrontmatterSelectionState(file.path);
			for (const id of selectableIds) state.set(id, true);
			void this.refreshFrontmatterSuggestions();
		});

		const clearBtn = controls.createEl("button", {
			text: "Clear",
			cls: "honcho-btn-small",
		});
		clearBtn.disabled = selectableIds.size === 0 || isApplying;
		clearBtn.addEventListener("click", () => {
			const state = this.getFrontmatterSelectionState(file.path);
			for (const id of selectableIds) state.set(id, false);
			void this.refreshFrontmatterSuggestions();
		});

		const applyBtn = controls.createEl("button", {
			text: selectedCount > 0 ? `Apply selected (${selectedCount})` : "Apply selected",
			cls: "honcho-btn-small mod-cta",
		});
		applyBtn.disabled = isApplying || selectedCount === 0;
		applyBtn.addEventListener("click", () => {
			void this.applySelectedFrontmatterSuggestion(file, suggestion, selection);
		});

		const list = section.createDiv({ cls: "honcho-frontmatter-list" });

		if (suggestion.tags.length > 0) {
			for (const tag of suggestion.tags) {
				const row = list.createDiv({ cls: "honcho-frontmatter-row" });
				const id = `tag:${tag.value}`;
				const exists = existing.tags.has(tag.value);
				const selected = selection.get(id) === true;

				const check = row.createEl("input", {
					cls: "honcho-fm-check",
					attr: { type: "checkbox", "aria-label": `Select tag ${tag.value}` },
				}) as HTMLInputElement;
				check.checked = selected;
				check.disabled = exists || isApplying;
				check.addEventListener("change", () => {
					this.getFrontmatterSelectionState(file.path).set(id, check.checked);
					void this.refreshFrontmatterSuggestions();
				});

				row.createSpan({ cls: "honcho-frontmatter-key", text: "tag" });
				const valueWrap = row.createDiv({ cls: "honcho-frontmatter-value-wrap" });
				valueWrap.createSpan({
					cls: `honcho-frontmatter-value honcho-frontmatter-confidence-${tag.confidence}`,
					text: `#${tag.value}`,
					attr: { title: `Confidence: ${tag.confidence}` },
				});
				row.createSpan({
					cls: "honcho-frontmatter-status",
					text: exists ? "Added" : selected ? "Selected" : "Skipped",
				});
			}
		}

		if (suggestion.aliases.length > 0) {
			for (const alias of suggestion.aliases) {
				const row = list.createDiv({ cls: "honcho-frontmatter-row" });
				const id = `alias:${alias.value}`;
				const exists = existing.aliases.has(alias.value);
				const selected = selection.get(id) === true;
				const check = row.createEl("input", {
					cls: "honcho-fm-check",
					attr: { type: "checkbox", "aria-label": `Select alias ${alias.value}` },
				}) as HTMLInputElement;
				check.checked = selected;
				check.disabled = exists || isApplying;
				check.addEventListener("change", () => {
					this.getFrontmatterSelectionState(file.path).set(id, check.checked);
					void this.refreshFrontmatterSuggestions();
				});

				row.createSpan({ cls: "honcho-frontmatter-key", text: "alias" });
				const valueWrap = row.createDiv({ cls: "honcho-frontmatter-value-wrap" });
				valueWrap.createSpan({
					cls: `honcho-frontmatter-value honcho-frontmatter-confidence-${alias.confidence}`,
					text: alias.value,
					attr: { title: `Confidence: ${alias.confidence}` },
				});
				row.createSpan({
					cls: "honcho-frontmatter-status",
					text: exists ? "Added" : selected ? "Selected" : "Skipped",
				});
			}
		}

		if (suggestion.properties.length > 0) {
			for (const prop of suggestion.properties) {
				const row = list.createDiv({ cls: "honcho-frontmatter-row" });
				const id = `prop:${prop.key}`;
				const exists = existing.properties.has(prop.key);
				const selected = selection.get(id) === true;
				const check = row.createEl("input", {
					cls: "honcho-fm-check",
					attr: { type: "checkbox", "aria-label": `Select property ${prop.key}` },
				}) as HTMLInputElement;
				check.checked = selected;
				check.disabled = exists || isApplying;
				check.addEventListener("change", () => {
					this.getFrontmatterSelectionState(file.path).set(id, check.checked);
					void this.refreshFrontmatterSuggestions();
				});

				row.createSpan({ cls: "honcho-frontmatter-key", text: prop.key });
				const valueWrap = row.createDiv({ cls: "honcho-frontmatter-value-wrap" });
				valueWrap.createSpan({
					cls: `honcho-frontmatter-value honcho-frontmatter-confidence-${prop.confidence}`,
					text: this.stringifySuggestionValue(prop.value),
					attr: { title: `Confidence: ${prop.confidence}` },
				});
				row.createSpan({
					cls: "honcho-frontmatter-status",
					text: exists ? "Added" : selected ? "Selected" : "Skipped",
				});
			}
		}
	}

	private showFrontmatterInfo(): void {
		new Notice(
			"Suggestions use active note context + existing Honcho memory. More/high-quality ingested notes generally improve suggestion quality.",
			7000
		);
	}

	private openFrontmatterSettings(): void {
		this.app.setting.open();
		this.app.setting.openTabById(this.plugin.manifest.id);

		// Apply a focused search so the Frontmatter section is immediately visible.
		window.setTimeout(() => {
			const searchInput = this.app.setting.tabContentEl.querySelector<HTMLInputElement>(
				".honcho-settings-search-input"
			);
			if (!searchInput) return;
			searchInput.value = "frontmatter";
			searchInput.dispatchEvent(new Event("input"));
			searchInput.focus();
		}, 25);
	}

	private getFrontmatterSelectionState(path: string): Map<string, boolean> {
		if (!this.frontmatterSelectionState.has(path)) {
			this.frontmatterSelectionState.set(path, new Map());
		}
		return this.frontmatterSelectionState.get(path)!;
	}

	private syncFrontmatterSelectionState(path: string, selectableIds: Set<string>): Map<string, boolean> {
		const state = this.getFrontmatterSelectionState(path);
		for (const id of selectableIds) {
			if (!state.has(id)) state.set(id, true);
		}
		for (const id of Array.from(state.keys())) {
			if (!selectableIds.has(id)) state.delete(id);
		}
		return state;
	}

	private async applySelectedFrontmatterSuggestion(
		file: TFile,
		suggestion: FrontmatterSuggestion,
		selection: Map<string, boolean>
	): Promise<void> {
		if (this.frontmatterApplyingPath) return;
		this.frontmatterApplyingPath = file.path;
		await this.refreshFrontmatterSuggestions();

		let tagsAdded = 0;
		let aliasesAdded = 0;
		let propertiesAdded = 0;

		try {
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				const currentTags = normalizeFrontmatterTags(fm.tags).map((t) => this.normalizeTag(t));
				const mergedTags = new Set(currentTags);
				for (const tag of suggestion.tags) {
					const id = `tag:${tag.value}`;
					if (selection.get(id) !== true) continue;
					if (mergedTags.has(tag.value)) continue;
					mergedTags.add(tag.value);
					tagsAdded++;
					this.markFrontmatterApplied(file.path, "tag", tag.value);
				}
				if (mergedTags.size > 0) fm.tags = Array.from(mergedTags);

				const rawAliases = fm.aliases;
				const currentAliases = Array.isArray(rawAliases)
					? rawAliases.map(String)
					: typeof rawAliases === "string"
						? [rawAliases]
						: [];
				const mergedAliases = new Set(currentAliases);
				for (const alias of suggestion.aliases) {
					const id = `alias:${alias.value}`;
					if (selection.get(id) !== true) continue;
					if (mergedAliases.has(alias.value)) continue;
					mergedAliases.add(alias.value);
					aliasesAdded++;
					this.markFrontmatterApplied(file.path, "alias", alias.value);
				}
				if (mergedAliases.size > 0) fm.aliases = Array.from(mergedAliases);

				for (const prop of suggestion.properties) {
					const id = `prop:${prop.key}`;
					if (selection.get(id) !== true) continue;
					if (this.isReservedFrontmatterKey(prop.key)) continue;
					const existing = fm[prop.key];
					const empty = existing === undefined || existing === null || existing === "";
					if (!empty) continue;
					fm[prop.key] = prop.value;
					propertiesAdded++;
					this.markFrontmatterApplied(file.path, "property", prop.key);
				}
			});

			new Notice(
				`Applied selected suggestions: ${tagsAdded} tags, ${aliasesAdded} aliases, ${propertiesAdded} properties`
			);
		} finally {
			this.frontmatterApplyingPath = null;
			await this.refreshFrontmatterSuggestions();
		}
	}

	private async generateFrontmatterSuggestion(file: TFile): Promise<void> {
		const client = this.plugin.getClient();
		if (!client) return;

		if (this.frontmatterLoadingPath) return;
		this.frontmatterDismissedPaths.delete(file.path);
		this.frontmatterLoadingPath = file.path;
		await this.refreshFrontmatterSuggestions();

		try {
			const content = await this.app.vault.cachedRead(file);
			const cache = this.app.metadataCache.getFileCache(file);
			const inlineTags = (cache?.tags ?? []).map((t) => t.tag);
			const fmTags = normalizeFrontmatterTags(cache?.frontmatter?.tags).map(
				(t) => (t.startsWith("#") ? t : "#" + t)
			);
			const tags = [...new Set([...inlineTags, ...fmTags])];
			const headings = (cache?.headings ?? []).map((h) => h.heading).slice(0, 8);
			const links = (cache?.links ?? []).map((l) => l.link).slice(0, 20);

			const prompt = [
				"You are generating Obsidian YAML frontmatter suggestions for a single note.",
				"Return ONLY valid JSON with this exact shape:",
				'{"tags":[{"value":"...","confidence":"high|medium|low"}],"aliases":[{"value":"...","confidence":"high|medium|low"}],"properties":[{"key":"...","value":"...","confidence":"high|medium|low"}]}',
				"",
				"Rules:",
				"- Keep tags short and lowercase (kebab-case).",
				"- Suggest at most 8 tags and at most 8 properties.",
				"- Do not include Honcho tracking keys (synced, session, hash, feedback, honcho_*).",
				"- Only include properties that are directly useful for this note.",
				"- Use confidence=high only when strongly supported by note content.",
				"",
				`Title: ${file.basename}`,
				`Folder: ${file.parent?.path ?? "/"}`,
				`Existing tags: ${tags.join(", ") || "(none)"}`,
				`Headings: ${headings.join(" | ") || "(none)"}`,
				`Outgoing links: ${links.join(", ") || "(none)"}`,
				"",
				"Note excerpt:",
				content.replace(/^---[\s\S]*?---\n*/, "").trim().slice(0, 1400) || "(empty)",
			].join("\n");

			const fm = readHonchoFrontmatter(this.app, file);
			const resp = await client.peerChat(
				this.plugin.getWorkspaceId(),
				this.plugin.getPeerId(),
				prompt,
				{
					reasoning_level: this.plugin.settings.frontmatterSuggestionReasoning,
					session_id: fm.session,
				}
			);
			const parsed = this.parseFrontmatterSuggestion(resp.content ?? "");

			if (!parsed) {
				new Notice("Could not parse frontmatter suggestions");
				return;
			}

			this.frontmatterCache.set(file.path, {
				suggestion: parsed,
				ts: Date.now(),
			});
		} catch (err) {
			new Notice(`Suggestion failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this.frontmatterLoadingPath = null;
			await this.refreshFrontmatterSuggestions();
		}
	}

	private parseFrontmatterSuggestion(raw: string): FrontmatterSuggestion | null {
		const candidates: string[] = [];
		const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
		if (fenced?.[1]) candidates.push(fenced[1].trim());
		candidates.push(raw.trim());

		const firstBrace = raw.indexOf("{");
		const lastBrace = raw.lastIndexOf("}");
		if (firstBrace >= 0 && lastBrace > firstBrace) {
			candidates.push(raw.slice(firstBrace, lastBrace + 1).trim());
		}

		for (const text of candidates) {
			if (!text) continue;
			try {
				const parsed = JSON.parse(text) as unknown;
				const normalized = this.normalizeFrontmatterSuggestion(parsed);
				if (normalized) return normalized;
			} catch {
				// Try next candidate
			}
		}
		return null;
	}

	private normalizeFrontmatterSuggestion(input: unknown): FrontmatterSuggestion | null {
		if (!input || typeof input !== "object" || Array.isArray(input)) return null;
		const obj = input as Record<string, unknown>;

		const tags: Array<{ value: string; confidence: ConfidenceLevel }> = [];
		const seenTags = new Set<string>();
		if (Array.isArray(obj.tags)) {
			for (const tagItem of obj.tags) {
				if (typeof tagItem === "string") {
					const value = this.normalizeTag(tagItem);
					if (value && !seenTags.has(value)) {
						seenTags.add(value);
						tags.push({ value, confidence: "medium" });
					}
					continue;
				}
				if (!tagItem || typeof tagItem !== "object" || Array.isArray(tagItem)) continue;
				const rec = tagItem as Record<string, unknown>;
				const value = this.normalizeTag(
					typeof rec.value === "string" ? rec.value
						: typeof rec.tag === "string" ? rec.tag
						: ""
				);
				if (!value || seenTags.has(value)) continue;
				seenTags.add(value);
				tags.push({
					value,
					confidence: this.normalizeConfidence(rec.confidence),
				});
			}
		}

		const aliases: Array<{ value: string; confidence: ConfidenceLevel }> = [];
		const seenAliases = new Set<string>();
		if (Array.isArray(obj.aliases)) {
			for (const aliasItem of obj.aliases) {
				if (typeof aliasItem === "string") {
					const value = aliasItem.trim();
					if (value && !seenAliases.has(value)) {
						seenAliases.add(value);
						aliases.push({ value, confidence: "medium" });
					}
					continue;
				}
				if (!aliasItem || typeof aliasItem !== "object" || Array.isArray(aliasItem)) continue;
				const rec = aliasItem as Record<string, unknown>;
				const value = (
					typeof rec.value === "string" ? rec.value
						: typeof rec.alias === "string" ? rec.alias
						: ""
				).trim();
				if (!value || seenAliases.has(value)) continue;
				seenAliases.add(value);
				aliases.push({
					value,
					confidence: this.normalizeConfidence(rec.confidence),
				});
			}
		}

		const properties: Array<{ key: string; value: unknown; confidence: ConfidenceLevel }> = [];
		const seenProperties = new Set<string>();
		if (Array.isArray(obj.properties)) {
			for (const propItem of obj.properties) {
				if (!propItem || typeof propItem !== "object" || Array.isArray(propItem)) continue;
				const rec = propItem as Record<string, unknown>;
				const key = (
					typeof rec.key === "string" ? rec.key
						: typeof rec.name === "string" ? rec.name
						: ""
				).trim();
				if (!key || seenProperties.has(key) || this.isReservedFrontmatterKey(key)) continue;
				const normalizedValue = this.normalizeSuggestionValue(rec.value);
				if (normalizedValue === undefined) continue;
				seenProperties.add(key);
				properties.push({
					key,
					value: normalizedValue,
					confidence: this.normalizeConfidence(rec.confidence),
				});
			}
		} else if (obj.properties && typeof obj.properties === "object" && !Array.isArray(obj.properties)) {
			for (const [rawKey, rawValue] of Object.entries(obj.properties as Record<string, unknown>)) {
				const key = rawKey.trim();
				if (!key || seenProperties.has(key) || this.isReservedFrontmatterKey(key)) continue;
				const normalizedValue = this.normalizeSuggestionValue(rawValue);
				if (normalizedValue === undefined) continue;
				seenProperties.add(key);
				properties.push({
					key,
					value: normalizedValue,
					confidence: "medium",
				});
			}
		}

		return { tags, aliases, properties };
	}

	private normalizeConfidence(input: unknown): ConfidenceLevel {
		if (typeof input !== "string") return "medium";
		const normalized = input.trim().toLowerCase();
		if (normalized === "high" || normalized === "medium" || normalized === "low") {
			return normalized;
		}
		return "medium";
	}

	private normalizeTag(tag: string): string {
		return tag.trim().replace(/^#/, "").toLowerCase();
	}

	private isReservedFrontmatterKey(key: string): boolean {
		const normalized = key.trim().toLowerCase();
		if (normalized.startsWith("honcho_")) return true;
		return [
			// Honcho tracking keys
			"synced", "session", "hash", "feedback",
			"honcho_synced", "honcho_session_id", "honcho_content_hash", "honcho_feedback",
			// Structural/meta keys that are usually not useful as user-authored frontmatter
			"title", "peer", "generated", "modified", "graph_position", "backlink_count",
			"file_path", "file_name", "source", "source_type", "ingested_at",
			"created", "created_at", "updated_at", "last_modified", "last_synced",
			"workspace", "workspace_id", "session_id", "observer_id", "observed_id",
			"message_type", "turn_id", "tags", "aliases",
		].includes(normalized);
	}

	private normalizeSuggestionValue(value: unknown): unknown {
		if (typeof value === "string") {
			const text = value.trim();
			return text.length > 0 ? text : undefined;
		}
		if (typeof value === "number" || typeof value === "boolean") {
			return value;
		}
		if (Array.isArray(value)) {
			const arr = value
				.map((v) => this.normalizeSuggestionValue(v))
				.filter((v) => v !== undefined);
			return arr.length > 0 ? arr : undefined;
		}
		return undefined;
	}

	private getExistingFrontmatterState(file: TFile): {
		tags: Set<string>;
		aliases: Set<string>;
		properties: Set<string>;
	} {
		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter;

		const tags = new Set<string>();
		for (const tag of normalizeFrontmatterTags(frontmatter?.tags)) {
			tags.add(this.normalizeTag(tag));
		}

		const aliases = new Set<string>();
		const rawAliases = frontmatter?.aliases;
		if (Array.isArray(rawAliases)) {
			for (const alias of rawAliases) aliases.add(String(alias).trim());
		} else if (typeof rawAliases === "string") {
			aliases.add(rawAliases.trim());
		}

		const properties = new Set<string>();
		if (frontmatter) {
			for (const key of Object.keys(frontmatter)) {
				if (key === "tags" || key === "aliases" || this.isReservedFrontmatterKey(key)) continue;
				properties.add(key);
			}
		}

		const local = this.frontmatterAppliedState.get(file.path);
		if (local) {
			for (const tag of local.tags) tags.add(tag);
			for (const alias of local.aliases) aliases.add(alias);
			for (const prop of local.properties) properties.add(prop);
		}

		return { tags, aliases, properties };
	}

	private markFrontmatterApplied(path: string, kind: "tag" | "alias" | "property", value: string): void {
		if (!this.frontmatterAppliedState.has(path)) {
			this.frontmatterAppliedState.set(path, {
				tags: new Set(),
				aliases: new Set(),
				properties: new Set(),
			});
		}
		const state = this.frontmatterAppliedState.get(path)!;
		if (kind === "tag") state.tags.add(value);
		if (kind === "alias") state.aliases.add(value);
		if (kind === "property") state.properties.add(value);
	}

	private async maybeAutoSuggestFrontmatter(file: TFile): Promise<void> {
		if (this.frontmatterLoadingPath || this.frontmatterApplyingPath) return;
		if (this.frontmatterDismissedPaths.has(file.path)) return;
		const cache = this.app.metadataCache.getFileCache(file);
		if (cache?.frontmatter?.honcho_generated) return;
		if (this.frontmatterAutoSuggestedPaths.has(file.path)) return;
		const cached = this.frontmatterCache.get(file.path);
		const isFresh = !!cached && Date.now() - cached.ts < HonchoSidebarView.FRONTMATTER_CACHE_TTL;
		if (isFresh) return;
		this.frontmatterAutoSuggestedPaths.add(file.path);
		await this.generateFrontmatterSuggestion(file);
	}

	private stringifySuggestionValue(value: unknown): string {
		if (Array.isArray(value)) {
			return value.map((v) => String(v)).join(", ");
		}
		return String(value);
	}

	// ---------------------------------------------------------------------------
	// Card group rendering
	// ---------------------------------------------------------------------------

	private static readonly MAX_LIST_ITEMS = 5;

	private renderCardGroup(parent: HTMLElement, group: CardGroup): void {
		const section = parent.createDiv({ cls: `honcho-section honcho-card-group ${group.cls}` });

		// All groups use <details>; general/identity starts open, others start closed
		const details = group.collapsed
			? section.createEl("details")
			: section.createEl("details", { attr: { open: "" } });

		const summary = details.createEl("summary", { cls: "honcho-group-summary" });
		summary.createEl("h4", { text: group.label });
		summary.createSpan({
			text: String(group.items.length),
			cls: "honcho-group-count",
		});

		const visible = group.items.slice(0, HonchoSidebarView.MAX_LIST_ITEMS);
		const hidden = group.items.slice(HonchoSidebarView.MAX_LIST_ITEMS);

		const list = details.createEl("ul", { cls: "honcho-card-list" });
		for (const item of visible) {
			this.renderCardItem(list, group, item);
		}

		if (hidden.length > 0) {
			const expandBtn = details.createEl("button", {
				text: `Show ${hidden.length} more`,
				cls: "honcho-expand-btn",
			});
			expandBtn.addEventListener("click", () => {
				for (const item of hidden) {
					this.renderCardItem(list, group, item);
				}
				expandBtn.remove();
			});
		}
	}

	private renderCardItem(list: HTMLElement, group: CardGroup, item: string): void {
		const li = list.createEl("li");

		// Identity/general card rows often arrive as "Label: Value".
		// Split those into key/value spans so they scan quickly.
		if (group.key !== "general") {
			li.setText(item);
			return;
		}

		const kvMatch = /^([^:]{1,40}):\s*(.+)$/.exec(item);
		if (!kvMatch) {
			li.setText(item);
			return;
		}

		li.addClass("honcho-card-kv-item");
		li.createSpan({ cls: "honcho-card-kv-key", text: kvMatch[1].trim() });
		li.createSpan({ cls: "honcho-card-kv-value", text: kvMatch[2].trim() });
	}

	// ---------------------------------------------------------------------------
	// Representation post-processing
	// ---------------------------------------------------------------------------

	private postProcessRepresentation(el: HTMLElement): void {
		const bareTsRegex = /^(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?)$/;
		let pendingTimestamp: string | null = null;

		for (const p of Array.from(el.querySelectorAll("p"))) {
			const text = p.textContent?.trim() ?? "";
			if (!text) continue;

			// Hide "Premises:" labels and the list that follows -- these are
			// internal reasoning scaffolding, not useful to the user.
			if (text === "Premises:") {
				const next = p.nextElementSibling;
				if (next?.tagName === "UL") next.addClass("honcho-rep-hidden");
				p.addClass("honcho-rep-hidden");
				continue;
			}

			// Some model responses emit bare timestamp lines followed by text.
			// Cache the timestamp and apply it to the next body paragraph.
			const bareTsMatch = bareTsRegex.exec(text);
			if (bareTsMatch) {
				pendingTimestamp = bareTsMatch[1];
				p.addClass("honcho-rep-hidden");
				continue;
			}

			const entries: RepresentationEntry[] = [];
			const matches = Array.from(
				text.matchAll(/\[(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?)\]\s*/g)
			);

			if (matches.length > 0) {
				let cursor = 0;

				for (let i = 0; i < matches.length; i++) {
					const match = matches[i];
					const ts = match[1];
					const matchStart = match.index ?? 0;
					const matchEnd = matchStart + match[0].length;
					const nextStart = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;

					// Preserve lead text before an inline timestamp as its own entry.
					const leadText = text.slice(cursor, matchStart).trim();
					if (leadText) {
						entries.push({
							ts: i === 0 ? pendingTimestamp : null,
							body: leadText,
						});
						pendingTimestamp = null;
					}

					const bodyText = text.slice(matchEnd, nextStart).trim();
					if (bodyText) {
						entries.push({ ts, body: bodyText });
					}

					cursor = nextStart;
				}

				pendingTimestamp = null;
			} else if (pendingTimestamp) {
				entries.push({ ts: pendingTimestamp, body: text });
				pendingTimestamp = null;
			}

			if (entries.length === 0) {
				pendingTimestamp = null;
				continue;
			}

			const list = document.createElement("div");
			list.addClass("honcho-rep-entry-list");

			for (const entry of entries) {
				const row = list.createDiv({
					cls: `honcho-rep-entry${entry.ts ? "" : " honcho-rep-entry-untimed"}`,
				});
				if (entry.ts) {
					row.createSpan({ cls: "honcho-rep-ts", text: entry.ts });
				}
				row.createSpan({ cls: "honcho-rep-body", text: entry.body });
			}

			p.replaceWith(list);
		}
	}

	// ---------------------------------------------------------------------------
	// Sidebar chat
	// ---------------------------------------------------------------------------

	private renderChat(parent: HTMLElement): void {
		const section = parent.createDiv({ cls: "honcho-section honcho-sidebar-chat-section" });
		const header = section.createDiv({ cls: "honcho-section-header" });
		header.createEl("h4", { text: "Chat" });
		header.createEl("span", {
			text: "Ask about your notes or identity.",
			cls: "honcho-chat-header-hint",
		});

		if (this.chatMessages.length > 0) {
			const clearBtn = header.createEl("button", {
				text: "Clear",
				cls: "honcho-btn-small",
			});
			clearBtn.addEventListener("click", () => {
				this.chatMessages = [];
				this.renderChatMessages();
			});
		}

		const messagesEl = section.createDiv({ cls: "honcho-sidebar-chat-messages" });
		this.chatEl = messagesEl;
		this.renderChatMessages();

		const inputArea = section.createDiv({ cls: "honcho-sidebar-chat-input-area" });
		const inputEl = inputArea.createEl("textarea", {
			cls: "honcho-sidebar-chat-input",
			attr: { placeholder: "Ask Honcho\u2026", rows: "2" },
		});
		this.chatInputEl = inputEl as HTMLTextAreaElement;

		inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.sendChatMessage();
			}
		});

		const sendBtn = inputArea.createEl("button", {
			text: "Send",
			cls: "honcho-btn-small honcho-chat-send-btn mod-cta",
		});
		sendBtn.addEventListener("click", () => this.sendChatMessage());
	}

	private renderChatMessages(): void {
		const el = this.chatEl;
		if (!el) return;
		el.empty();
		el.toggleClass("honcho-chat-messages-hidden", this.chatMessages.length === 0);
		if (this.chatMessages.length === 0) return;

		for (const msg of this.chatMessages) {
			const bubble = el.createDiv({
				cls: `honcho-chat-bubble honcho-chat-${msg.role}`,
			});
			if (msg.role === "assistant") {
				const contentDiv = bubble.createDiv();
				MarkdownRenderer.render(this.app, msg.content, contentDiv, "", this);
			} else {
				bubble.setText(msg.content);
			}
		}

		el.scrollTop = el.scrollHeight;
	}

	private async sendChatMessage(): Promise<void> {
		if (!this.chatInputEl || !this.chatEl || this.chatSending) return;
		const client = this.plugin.getClient();
		if (!client) return;

		const query = this.chatInputEl.value.trim();
		if (!query) return;

		this.chatSending = true;
		this.chatInputEl.value = "";
		this.chatMessages.push({ role: "user", content: query });
		this.renderChatMessages();

		// Streaming bubble
		const bubble = this.chatEl.createDiv({
			cls: "honcho-chat-bubble honcho-chat-assistant honcho-chat-streaming",
		});
		const contentEl = bubble.createDiv({ cls: "honcho-chat-stream-content" });
		contentEl.setText("\u2026");
		this.chatEl.scrollTop = this.chatEl.scrollHeight;

		// Prepend active note context so the LLM can ground its answer
		const contextualQuery = this.activeFile
			? `[Context: viewing "${this.activeFile.basename}"]\n\n${query}`
			: query;

		let accumulated = "";
		this.chatAbortController = new AbortController();

		try {
			const stream = client.peerChatStream(
				this.plugin.getWorkspaceId(),
				this.plugin.getPeerId(),
				contextualQuery,
				{ reasoning_level: "medium" },
				this.chatAbortController.signal
			);

			for await (const event of stream) {
				if (event.done) break;
				if (event.delta?.content) {
					accumulated += event.delta.content;
					contentEl.empty();
					await MarkdownRenderer.render(this.app, accumulated, contentEl, "", this);
					this.chatEl!.scrollTop = this.chatEl!.scrollHeight;
				}
			}
		} catch (err) {
			if (!(err instanceof DOMException && err.name === "AbortError")) {
				if (!accumulated) {
					try {
						const resp = await client.peerChat(
							this.plugin.getWorkspaceId(),
							this.plugin.getPeerId(),
							contextualQuery,
							{ reasoning_level: "medium" }
						);
						accumulated = resp.content ?? "No response.";
					} catch {
						accumulated = "Could not reach Honcho.";
					}
				}
			}
		} finally {
			this.chatAbortController = null;
		}

		bubble.removeClass("honcho-chat-streaming");
		const content = accumulated || "No response.";
		this.chatMessages.push({ role: "assistant", content });
		this.renderChatMessages();
		this.chatSending = false;
	}

	// ---------------------------------------------------------------------------
	// Sync status
	// ---------------------------------------------------------------------------

	private async renderSyncStatus(parent: HTMLElement): Promise<void> {
		const section = parent.createDiv({ cls: "honcho-section honcho-sync-status-section" });
		const header = section.createDiv({ cls: "honcho-section-header" });
		header.createEl("h4", { text: "Sync Status" });
		const headerActions = header.createDiv({ cls: "honcho-inline-actions" });
		const reingestBtn = headerActions.createEl("button", {
			text: "Re-ingest current",
			cls: "honcho-btn-small",
		});
		reingestBtn.disabled = !this.activeFile;
		reingestBtn.addEventListener("click", () => {
			this.app.commands.executeCommandById("honcho:reingest-note");
		});
		const statusEl = section.createDiv({ cls: "honcho-sync-status-body" });

		try {
			// Always compute fresh status to avoid stale-count mismatch.
			statusEl.createSpan({ text: "Checking\u2026", cls: "honcho-loading" });
			const stale = await findStaleNotes(this.app);
			const count = stale.length;
			this.staleCountCache = { count, ts: Date.now() };
			statusEl.empty();

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
					this.staleCountCache = null;
					this.app.commands.executeCommandById("honcho:show-stale-notes");
				});
			}
		} catch {
			statusEl.empty();
			statusEl.createSpan({ text: "Could not check sync status", cls: "honcho-text-muted" });
		}
	}
}
