import { ItemView, MarkdownRenderer, TFile, type WorkspaceLeaf } from "obsidian";
import type HonchoPlugin from "../main";
import { findStaleNotes } from "../utils/sync-status";

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
	private briefingTimer: ReturnType<typeof setTimeout> | null = null;
	private briefingCache: Map<string, { rep: string; ts: number }> = new Map();
	private static readonly BRIEFING_CACHE_TTL = 5 * 60 * 1000;

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
			void this.refreshBriefing();
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

		// Active note header
		const noteHeader = el.createDiv({ cls: "honcho-active-note" });
		noteHeader.createSpan({ cls: "honcho-active-note-label", text: "viewing" });
		noteHeader.createSpan({ cls: "honcho-active-note-title", text: file.basename });

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

			// Single API call for card + representation
			const contextResp = await client.getPeerContext(workspaceId, peerId).catch(() => ({
				peer_id: peerId,
				target_id: peerId,
				representation: null,
				peer_card: null,
			}));

			body.empty();

			// Sync status
			await this.renderSyncStatus(body);

			// Briefing zone: note-contextual, updates asynchronously on file switch
			const briefingZone = body.createDiv({ cls: "honcho-briefing-zone" });
			this.briefingEl = briefingZone;
			void this.refreshBriefing();

			// Chat -- above identity so it's immediately reachable
			this.renderChat(body);

			// Peer card -- grouped by type
			if (contextResp.peer_card && contextResp.peer_card.length > 0) {
				const groups = groupCardItems(contextResp.peer_card);
				for (const group of groups) {
					this.renderCardGroup(body, group);
				}
			}

			// Representation section -- collapsed by default; it's a log, not a profile
			if (contextResp.representation) {
				const repSection = body.createDiv({ cls: "honcho-section honcho-rep-section" });
				const repDetails = repSection.createEl("details");
				const repSummary = repDetails.createEl("summary", { cls: "honcho-group-summary" });
				repSummary.createEl("h4", { text: "Observations" });

				// Count bracketed timestamp entries as a proxy for observation count
				const entryCount = (contextResp.representation.match(/^\[/gm) ?? []).length;
				if (entryCount > 0) {
					repSummary.createSpan({ text: String(entryCount), cls: "honcho-group-count" });
				}

				const repContent = repDetails.createDiv({ cls: "honcho-representation" });
				await MarkdownRenderer.render(
					this.app,
					contextResp.representation,
					repContent,
					"",
					this
				);
				this.postProcessRepresentation(repContent);
			}

			if (
				(!contextResp.peer_card || contextResp.peer_card.length === 0) &&
				!contextResp.representation
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
			list.createEl("li", { text: item });
		}

		if (hidden.length > 0) {
			const expandBtn = details.createEl("button", {
				text: `+${hidden.length} more`,
				cls: "honcho-expand-btn",
			});
			expandBtn.addEventListener("click", () => {
				for (const item of hidden) {
					list.createEl("li", { text: item });
				}
				expandBtn.remove();
			});
		}
	}

	// ---------------------------------------------------------------------------
	// Representation post-processing
	// ---------------------------------------------------------------------------

	private postProcessRepresentation(el: HTMLElement): void {
		const tsRegex = /^\[(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?)\]\s*/;

		for (const p of Array.from(el.querySelectorAll("p"))) {
			const text = p.textContent?.trim() ?? "";

			// Hide "Premises:" labels and the list that follows -- these are
			// internal reasoning scaffolding, not useful to the user.
			if (text === "Premises:") {
				const next = p.nextElementSibling;
				if (next?.tagName === "UL") next.addClass("honcho-rep-hidden");
				p.addClass("honcho-rep-hidden");
				continue;
			}

			// Transform timestamped entries into structured rows
			const match = tsRegex.exec(text);
			if (!match) continue;
			const timestamp = match[1];
			const bodyText = text.slice(match[0].length).trim();
			p.addClass("honcho-rep-entry");
			p.empty();
			p.createSpan({ cls: "honcho-rep-ts", text: timestamp });
			p.createSpan({ cls: "honcho-rep-body", text: bodyText });
		}
	}

	// ---------------------------------------------------------------------------
	// Sidebar chat
	// ---------------------------------------------------------------------------

	private renderChat(parent: HTMLElement): void {
		const section = parent.createDiv({ cls: "honcho-section honcho-sidebar-chat-section" });
		const header = section.createDiv({ cls: "honcho-section-header" });
		header.createEl("h4", { text: "Chat" });

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

		if (this.chatMessages.length === 0) {
			el.createEl("p", {
				text: "Ask about your notes or identity.",
				cls: "honcho-sidebar-empty honcho-sidebar-chat-hint",
			});
			return;
		}

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
		const statusEl = section.createDiv({ cls: "honcho-sync-status-body" });

		try {
			// Use cached count if fresh enough
			let count: number;
			if (this.staleCountCache && Date.now() - this.staleCountCache.ts < HonchoSidebarView.STALE_CACHE_TTL) {
				count = this.staleCountCache.count;
			} else {
				statusEl.createSpan({ text: "Checking\u2026", cls: "honcho-loading" });
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
