import { ItemView, MarkdownRenderer, type WorkspaceLeaf } from "obsidian";
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

const CARD_PREFIXES: Array<{ prefix: string; key: string; label: string; cls: string }> = [
	{ prefix: "PATTERN:", key: "pattern", label: "Patterns", cls: "honcho-group-pattern" },
	{ prefix: "TRAIT:", key: "trait", label: "Traits", cls: "honcho-group-trait" },
	{ prefix: "PREFERENCE:", key: "preference", label: "Preferences", cls: "honcho-group-preference" },
];

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
		// No active listeners to clean up
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

			// Sync status -- first, always visible
			await this.renderSyncStatus(body);

			// Peer card -- grouped by type
			if (contextResp.peer_card && contextResp.peer_card.length > 0) {
				const groups = groupCardItems(contextResp.peer_card);
				for (const group of groups) {
					this.renderCardGroup(body, group);
				}
			}

			// Representation section
			if (contextResp.representation) {
				const repSection = body.createDiv({ cls: "honcho-section" });
				const repHeader = repSection.createDiv({ cls: "honcho-section-header" });
				repHeader.createEl("h4", { text: "Representation" });
				const repContent = repSection.createDiv({ cls: "honcho-representation" });
				await MarkdownRenderer.render(
					this.app,
					contextResp.representation,
					repContent,
					"",
					this
				);
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

	private renderCardGroup(parent: HTMLElement, group: CardGroup): void {
		const section = parent.createDiv({ cls: `honcho-section honcho-card-group ${group.cls}` });

		if (group.collapsed) {
			// Collapsible group (patterns, traits, preferences)
			const details = section.createEl("details");
			const summary = details.createEl("summary", { cls: "honcho-group-summary" });
			summary.createEl("h4", { text: group.label });
			summary.createSpan({
				text: String(group.items.length),
				cls: "honcho-group-count",
			});
			const list = details.createEl("ul", { cls: "honcho-card-list" });
			for (const item of group.items) {
				list.createEl("li", { text: item });
			}
		} else {
			// Open group (general/identity)
			const header = section.createDiv({ cls: "honcho-section-header" });
			header.createEl("h4", { text: group.label });
			const list = section.createEl("ul", { cls: "honcho-card-list" });
			for (const item of group.items) {
				list.createEl("li", { text: item });
			}
		}
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
