import { App, Modal, Notice, Setting, TFile } from "obsidian";
import type { HonchoClient, SessionResponse, QueueStatusResponse, PageResponse } from "../honcho-client";
import type { IngestContext } from "../commands/ingest";
import { ingestNote, createIngestContext } from "../commands/ingest";

export class SessionManagerModal extends Modal {
	private client: HonchoClient;
	private workspaceId: string;
	private observerPeerId: string;
	private observedPeerId: string;
	private bodyEl: HTMLElement | null = null;
	private sessions: SessionResponse[] = [];
	private currentPage = 1;
	private totalPages = 1;
	private pluginApp: App;
	private trackFrontmatter: boolean;

	constructor(
		app: App,
		client: HonchoClient,
		workspaceId: string,
		observerPeerId: string,
		observedPeerId: string,
		trackFrontmatter: boolean
	) {
		super(app);
		this.pluginApp = app;
		this.client = client;
		this.workspaceId = workspaceId;
		this.observerPeerId = observerPeerId;
		this.observedPeerId = observedPeerId;
		this.trackFrontmatter = trackFrontmatter;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("honcho-session-modal");

		// Header
		const header = contentEl.createDiv({ cls: "honcho-session-header" });
		header.createEl("h2", { text: "Session Manager" });

		// Queue status bar
		const statusBar = contentEl.createDiv({ cls: "honcho-queue-status" });
		statusBar.createSpan({ text: "Loading queue status...", cls: "honcho-queue-text" });

		// Body
		this.bodyEl = contentEl.createDiv({ cls: "honcho-session-body" });
		this.bodyEl.createEl("p", { text: "Loading sessions...", cls: "honcho-loading" });

		// Load both in parallel
		this.loadQueueStatus(statusBar);
		this.loadSessions();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async loadQueueStatus(statusBar: HTMLElement): Promise<void> {
		try {
			const status = await this.client.getQueueStatus(
				this.workspaceId,
				{ observer_id: this.observerPeerId }
			);
			statusBar.empty();
			this.renderQueueStatus(statusBar, status);
		} catch {
			statusBar.empty();
			statusBar.createSpan({ text: "Queue status unavailable", cls: "honcho-queue-text honcho-text-muted" });
		}
	}

	private renderQueueStatus(el: HTMLElement, status: QueueStatusResponse): void {
		const total = status.total_work_units;
		const completed = status.completed_work_units;
		const inProgress = status.in_progress_work_units;
		const pending = status.pending_work_units;

		if (total === 0) {
			el.createSpan({ text: "Queue idle", cls: "honcho-queue-text" });
			return;
		}

		const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

		const progressWrap = el.createDiv({ cls: "honcho-queue-progress" });

		const bar = progressWrap.createDiv({ cls: "honcho-progress-bar" });
		const fill = bar.createDiv({ cls: "honcho-progress-fill" });
		fill.style.width = `${pct}%`;

		progressWrap.createSpan({
			text: `${completed}/${total} processed`,
			cls: "honcho-queue-label",
		});

		if (inProgress > 0) {
			progressWrap.createSpan({
				text: `${inProgress} in progress`,
				cls: "honcho-queue-label honcho-text-accent",
			});
		}
		if (pending > 0) {
			progressWrap.createSpan({
				text: `${pending} pending`,
				cls: "honcho-queue-label honcho-text-muted",
			});
		}
	}

	private async loadSessions(): Promise<void> {
		if (!this.bodyEl) return;

		try {
			const resp = await this.client.listSessions(
				this.workspaceId,
				{ source: "obsidian" },
				this.currentPage,
				20
			);

			this.sessions = resp.items;
			this.totalPages = resp.pages;
			this.renderSessions();
		} catch (err) {
			this.bodyEl.empty();
			this.bodyEl.createEl("p", {
				text: `Failed to load sessions: ${err instanceof Error ? err.message : String(err)}`,
				cls: "honcho-error",
			});
		}
	}

	private renderSessions(): void {
		if (!this.bodyEl) return;
		this.bodyEl.empty();

		if (this.sessions.length === 0) {
			this.bodyEl.createEl("p", {
				text: "No ingested sessions found. Ingest some notes first.",
				cls: "honcho-sidebar-empty",
			});
			return;
		}

		const list = this.bodyEl.createDiv({ cls: "honcho-session-list" });

		for (const session of this.sessions) {
			const meta = session.metadata as Record<string, unknown>;
			const card = list.createDiv({ cls: "honcho-session-card" });

			// Session info
			const info = card.createDiv({ cls: "honcho-session-info" });

			const name = (meta.file_name as string) || session.id;
			info.createEl("div", { text: name, cls: "honcho-session-name" });

			const details: string[] = [];
			if (meta.file_path) details.push(meta.file_path as string);
			if (meta.tags && Array.isArray(meta.tags) && (meta.tags as string[]).length > 0) {
				details.push((meta.tags as string[]).join(", "));
			}
			if (meta.ingested_at) {
				details.push(new Date(meta.ingested_at as string).toLocaleDateString());
			}

			if (details.length > 0) {
				info.createEl("div", {
					text: details.join(" \u00B7 "),
					cls: "honcho-session-details",
				});
			}

			const statusBadge = info.createSpan({
				text: session.is_active ? "active" : "inactive",
				cls: `honcho-session-badge ${session.is_active ? "honcho-badge-active" : "honcho-badge-inactive"}`,
			});

			// Actions
			const actions = card.createDiv({ cls: "honcho-session-actions" });

			// Re-ingest button
			if (meta.file_path) {
				const reingestBtn = actions.createEl("button", {
					text: "Re-ingest",
					cls: "honcho-btn-small",
				});
				reingestBtn.addEventListener("click", async () => {
					await this.reIngestSession(meta.file_path as string);
				});
			}

			// Delete button
			const deleteBtn = actions.createEl("button", {
				text: "Delete",
				cls: "honcho-btn-small honcho-btn-danger",
			});
			deleteBtn.addEventListener("click", async () => {
				await this.deleteSession(session.id, name);
			});
		}

		// Pagination
		if (this.totalPages > 1) {
			const pagination = this.bodyEl.createDiv({ cls: "honcho-pagination" });

			const prevBtn = pagination.createEl("button", {
				text: "\u2190 Prev",
				cls: "honcho-btn-small",
			});
			prevBtn.disabled = this.currentPage <= 1;
			prevBtn.addEventListener("click", () => {
				if (this.currentPage > 1) {
					this.currentPage--;
					this.loadSessions();
				}
			});

			pagination.createSpan({
				text: `${this.currentPage} / ${this.totalPages}`,
				cls: "honcho-page-label",
			});

			const nextBtn = pagination.createEl("button", {
				text: "Next \u2192",
				cls: "honcho-btn-small",
			});
			nextBtn.disabled = this.currentPage >= this.totalPages;
			nextBtn.addEventListener("click", () => {
				if (this.currentPage < this.totalPages) {
					this.currentPage++;
					this.loadSessions();
				}
			});
		}

		// Dream button
		const dreamSection = this.bodyEl.createDiv({ cls: "honcho-dream-section" });
		const dreamBtn = dreamSection.createEl("button", {
			text: "Schedule Dream",
			cls: "honcho-btn-dream",
		});
		dreamBtn.addEventListener("click", async () => {
			try {
				await this.client.scheduleDream(
					this.workspaceId,
					this.observerPeerId,
					{ observed: this.observedPeerId }
				);
				new Notice("Dream scheduled");
			} catch (err) {
				new Notice(`Failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		});
	}

	private async reIngestSession(filePath: string): Promise<void> {
		const file = this.pluginApp.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) {
			new Notice(`File not found: ${filePath}`);
			return;
		}

		try {
			const ctx = createIngestContext(
				this.pluginApp,
				this.client,
				this.workspaceId,
				this.observerPeerId,
				this.observedPeerId,
				this.trackFrontmatter
			);
			const result = await ingestNote(ctx, file, { force: true });
			const n = result.messages.length;
			new Notice(`Re-ingested ${file.basename}: ${n} message${n !== 1 ? "s" : ""}`);
			await this.loadSessions();
		} catch (err) {
			new Notice(`Re-ingest failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private deleteSession(sessionId: string, name: string): void {
		const confirm = new ConfirmModal(
			this.pluginApp,
			`Delete session "${name}"? This cannot be undone.`,
			async () => {
				try {
					await this.client.deleteSession(this.workspaceId, sessionId);
					new Notice(`Deleted session: ${name}`);
					await this.loadSessions();
				} catch (err) {
					new Notice(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		);
		confirm.open();
	}
}

class ConfirmModal extends Modal {
	private message: string;
	private onConfirm: () => void;

	constructor(app: App, message: string, onConfirm: () => void) {
		super(app);
		this.message = message;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("p", { text: this.message });

		const btnRow = contentEl.createDiv({ cls: "honcho-confirm-actions" });
		const cancelBtn = btnRow.createEl("button", { text: "Cancel", cls: "honcho-btn-small" });
		cancelBtn.addEventListener("click", () => this.close());

		const confirmBtn = btnRow.createEl("button", {
			text: "Delete",
			cls: "honcho-btn-small honcho-btn-danger",
		});
		confirmBtn.addEventListener("click", () => {
			this.close();
			this.onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
