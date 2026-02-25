import { App, Modal, Notice, TFile } from "obsidian";
import type { IngestContext } from "../commands/ingest";
import { ingestNote } from "../commands/ingest";
import { findStaleNotes, type StalenessInfo } from "../utils/sync-status";

export class StaleNotesModal extends Modal {
	private ctx: IngestContext;
	private bodyEl: HTMLElement | null = null;
	private staleNotes: StalenessInfo[] = [];

	constructor(app: App, ctx: IngestContext) {
		super(app);
		this.ctx = ctx;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("honcho-stale-modal");

		const header = contentEl.createDiv({ cls: "honcho-session-header" });
		header.createEl("h2", { text: "Stale Notes" });

		this.bodyEl = contentEl.createDiv({ cls: "honcho-session-body" });
		this.bodyEl.createEl("p", { text: "Scanning vault...", cls: "honcho-loading" });

		this.loadStaleNotes();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async loadStaleNotes(): Promise<void> {
		if (!this.bodyEl) return;

		try {
			this.staleNotes = await findStaleNotes(this.app);
			this.renderList();
		} catch (err) {
			this.bodyEl.empty();
			this.bodyEl.createEl("p", {
				text: `Failed: ${err instanceof Error ? err.message : String(err)}`,
				cls: "honcho-error",
			});
		}
	}

	private renderList(): void {
		if (!this.bodyEl) return;
		this.bodyEl.empty();

		if (this.staleNotes.length === 0) {
			this.bodyEl.createEl("p", {
				text: "All ingested notes are up to date.",
				cls: "honcho-sidebar-empty",
			});
			return;
		}

		// Summary + re-ingest all
		const summary = this.bodyEl.createDiv({ cls: "honcho-stale-summary" });
		summary.createSpan({
			text: `${this.staleNotes.length} note${this.staleNotes.length !== 1 ? "s" : ""} modified since last sync`,
		});

		const reingestAllBtn = summary.createEl("button", {
			text: "Re-ingest all",
			cls: "honcho-btn-small",
		});
		reingestAllBtn.addEventListener("click", () => this.reingestAll(reingestAllBtn));

		// List
		const list = this.bodyEl.createDiv({ cls: "honcho-session-list" });

		for (const info of this.staleNotes) {
			const card = list.createDiv({ cls: "honcho-session-card" });
			const infoDiv = card.createDiv({ cls: "honcho-session-info" });

			infoDiv.createEl("div", { text: info.file.basename, cls: "honcho-session-name" });

			const syncedDate = new Date(info.lastSynced).toLocaleDateString();
			const modifiedDate = new Date(info.lastModified).toLocaleDateString();
			infoDiv.createEl("div", {
				text: `Synced: ${syncedDate} \u00B7 Modified: ${modifiedDate}`,
				cls: "honcho-session-details",
			});

			const actions = card.createDiv({ cls: "honcho-session-actions" });
			const btn = actions.createEl("button", {
				text: "Re-ingest",
				cls: "honcho-btn-small",
			});
			btn.addEventListener("click", () => this.reingestOne(info, btn));
		}
	}

	private async reingestOne(info: StalenessInfo, btn: HTMLButtonElement): Promise<void> {
		btn.disabled = true;
		btn.setText("Ingesting...");

		try {
			const result = await ingestNote(this.ctx, info.file, { force: true });
			const n = result.messages.length;
			new Notice(`Re-ingested ${info.file.basename}: ${n} message${n !== 1 ? "s" : ""}`);
			// Remove from list
			this.staleNotes = this.staleNotes.filter((s) => s.file.path !== info.file.path);
			this.renderList();
		} catch (err) {
			btn.disabled = false;
			btn.setText("Re-ingest");
			new Notice(`Failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async reingestAll(btn: HTMLButtonElement): Promise<void> {
		btn.disabled = true;
		btn.setText("Ingesting...");

		let ingested = 0;
		let failed = 0;

		for (const info of [...this.staleNotes]) {
			try {
				await ingestNote(this.ctx, info.file, { force: true });
				ingested++;
			} catch {
				failed++;
			}
		}

		new Notice(`Re-ingested ${ingested} note${ingested !== 1 ? "s" : ""}${failed > 0 ? `, ${failed} failed` : ""}`);

		// Refresh
		this.staleNotes = await findStaleNotes(this.app);
		this.renderList();
	}
}
