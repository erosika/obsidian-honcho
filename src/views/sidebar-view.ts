import { ItemView, MarkdownRenderer, TFile, type WorkspaceLeaf } from "obsidian";
import type HonchoPlugin from "../main";
import { findStaleNotes } from "../utils/sync-status";

export const HONCHO_VIEW_TYPE = "honcho-sidebar";

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

		// Connection status
		const statusEl = header.createDiv({ cls: "honcho-status" });
		statusEl.createSpan({ text: "Checking...", cls: "honcho-status-text" });

		// Refresh button
		const refreshBtn = header.createEl("button", {
			text: "Refresh",
			cls: "honcho-refresh-btn",
		});
		refreshBtn.addEventListener("click", () => {
			this.connectionCache = null;
			this.staleCountCache = null;
			this.render();
		});

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

			// Single API call for card + representation
			const contextResp = await client.getPeerContext(workspaceId, peerId).catch(() => ({
				peer_id: peerId,
				target_id: peerId,
				representation: null,
				peer_card: null,
			}));

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

			// Representation section (static, loaded once)
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

			// Sync status section
			this.renderSyncStatus(body);

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
