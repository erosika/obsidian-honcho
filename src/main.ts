import { Notice, Plugin, TFile, TFolder, type WorkspaceLeaf } from "obsidian";
import { HonchoClient } from "./honcho-client";
import { DEFAULT_SETTINGS, HonchoSettingTab, type HonchoPluginSettings } from "./settings";
import { HONCHO_VIEW_TYPE, HonchoSidebarView } from "./views/sidebar-view";
import { HonchoChatModal } from "./views/chat-modal";
import { SessionManagerModal } from "./views/session-manager";
import { StaleNotesModal } from "./views/stale-notes-modal";
import { HonchoSearchModal } from "./commands/search";
import { createIngestContext, ingestNote, ingestFolder, ingestByTag, ingestLinked } from "./commands/ingest";
import { createSyncContext, generateIdentityNote, pullConclusions, pushPeerCardFromNote } from "./commands/sync";
import type { NoteContext } from "./views/chat-modal";
import { matchesSyncFilters, normalizeFrontmatterTags, readHonchoFrontmatter } from "./utils/frontmatter";
import { registerHonchoCodeBlock } from "./views/post-processor";
import { SyncQueue } from "./utils/sync-queue";

export default class HonchoPlugin extends Plugin {
	settings: HonchoPluginSettings = DEFAULT_SETTINGS;
	private client: HonchoClient | null = null;
	private syncQueue: SyncQueue | null = null;
	private initialized = false;
	private workspaceId = "";
	private peerId = "";
	private observedPeerId = "";

	async onload(): Promise<void> {
		await this.loadSettings();

		// Register the sidebar view
		this.registerView(HONCHO_VIEW_TYPE, (leaf) => new HonchoSidebarView(leaf, this));

		// -- Commands --

		this.addCommand({
			id: "open-sidebar",
			name: "Open Honcho sidebar",
			callback: () => this.activateSidebar(),
		});

		this.addCommand({
			id: "ingest-note",
			name: "Ingest current note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (checking) return true;
				this.runIngest(file);
				return true;
			},
		});

		this.addCommand({
			id: "ingest-linked",
			name: "Ingest current note + linked notes",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (checking) return true;
				this.runIngestLinked(file);
				return true;
			},
		});

		this.addCommand({
			id: "ingest-folder",
			name: "Ingest folder",
			callback: () => this.runIngestFolderPicker(),
		});

		this.addCommand({
			id: "ingest-by-tag",
			name: "Ingest notes by tag",
			callback: () => this.runIngestByTagPicker(),
		});

		this.addCommand({
			id: "search-memory",
			name: "Search Honcho memory",
			callback: () => this.openSearch(),
		});

		this.addCommand({
			id: "chat",
			name: "Chat with Honcho",
			callback: () => this.openChat(),
		});

		this.addCommand({
			id: "manage-sessions",
			name: "Manage sessions",
			callback: () => this.openSessionManager(),
		});

		this.addCommand({
			id: "generate-identity-note",
			name: "Generate identity note",
			callback: () => this.runGenerateIdentity(),
		});

		this.addCommand({
			id: "pull-conclusions",
			name: "Pull conclusions into vault",
			callback: () => this.runPullConclusions(),
		});

		this.addCommand({
			id: "schedule-dream",
			name: "Schedule Honcho dream",
			callback: () => this.runScheduleDream(),
		});

		this.addCommand({
			id: "chat-about-note",
			name: "Chat with Honcho about this note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (checking) return true;
				this.openContextualChat(file);
				return true;
			},
		});

		this.addCommand({
			id: "push-peer-card",
			name: "Push note as peer card",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (checking) return true;
				this.runPushPeerCard(file);
				return true;
			},
		});

		this.addCommand({
			id: "show-stale-notes",
			name: "Show stale notes",
			callback: () => this.openStaleNotes(),
		});

		// -- Settings tab --
		this.addSettingTab(new HonchoSettingTab(this.app, this));

		// -- Code block processor --
		registerHonchoCodeBlock(this);

		// -- Ribbon icon --
		this.addRibbonIcon("brain", "Open Honcho", () => this.activateSidebar());

		// -- File menu --
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFile && file.extension === "md") {
					menu.addItem((item) => {
						item.setTitle("Ingest into Honcho")
							.setIcon("upload")
							.onClick(() => this.runIngest(file));
					});
					menu.addItem((item) => {
						item.setTitle("Ingest + linked notes")
							.setIcon("git-branch")
							.onClick(() => this.runIngestLinked(file));
					});
					menu.addItem((item) => {
						item.setTitle("Chat about this note")
							.setIcon("message-circle")
							.onClick(() => this.openContextualChat(file));
					});
					menu.addItem((item) => {
						item.setTitle("Push as peer card")
							.setIcon("user-check")
							.onClick(() => this.runPushPeerCard(file));
					});
				}
				if (file instanceof TFolder) {
					menu.addItem((item) => {
						item.setTitle("Ingest folder into Honcho")
							.setIcon("upload")
							.onClick(() => this.runIngestFolder(file));
					});
				}
			})
		);

		// -- Auto-sync on save --
		this.syncQueue = new SyncQueue(this.app, (file) => this.runIngest(file, true));

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (
					!this.settings.autoSync ||
					!(file instanceof TFile) ||
					file.extension !== "md"
				) {
					return;
				}
				if (!matchesSyncFilters(
					this.app,
					file,
					this.settings.autoSyncTags,
					this.settings.autoSyncFolders
				)) {
					return;
				}

				this.syncQueue?.enqueue(file);
			})
		);

		// -- Auto-ingest on file creation --
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (
					!this.settings.autoSync ||
					!(file instanceof TFile) ||
					file.extension !== "md"
				) {
					return;
				}
				if (!matchesSyncFilters(
					this.app,
					file,
					this.settings.autoSyncTags,
					this.settings.autoSyncFolders
				)) {
					return;
				}

				this.syncQueue?.enqueue(file);
			})
		);

		// -- Session lifecycle: rename --
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				this.handleFileRename(file, oldPath);
			})
		);

		// -- Session lifecycle: delete --
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				this.handleFileDelete(file.path);
			})
		);
	}

	onunload(): void {
		this.syncQueue?.clear();
	}

	// -----------------------------------------------------------------------
	// Settings
	// -----------------------------------------------------------------------

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.client = null; // rebuild on next access
		this.initialized = false;
	}

	// -----------------------------------------------------------------------
	// Client + lazy init
	// -----------------------------------------------------------------------

	getClient(): HonchoClient | null {
		if (!this.settings.apiKey) return null;

		if (!this.client) {
			this.client = new HonchoClient({
				apiKey: this.settings.apiKey,
				baseUrl: this.settings.baseUrl,
				apiVersion: this.settings.apiVersion,
			});
		}
		return this.client;
	}

	getWorkspaceId(): string {
		return this.settings.workspaceName || this.app.vault.getName();
	}

	getPeerId(): string {
		return this.settings.peerName || "obsidian";
	}

	getObservedPeerId(): string {
		return this.settings.observedPeerName || this.getPeerId();
	}

	/**
	 * Ensure workspace + peer exist in Honcho. Called lazily before operations.
	 */
	private async ensureInitialized(): Promise<{
		client: HonchoClient;
		workspaceId: string;
		peerId: string;
		observedPeerId: string;
	}> {
		const client = this.getClient();
		if (!client) throw new Error("Configure your API key in Honcho settings");

		const workspaceId = this.getWorkspaceId();
		const peerId = this.getPeerId();
		const observedPeerId = this.getObservedPeerId();

		if (!this.initialized) {
			await client.getOrCreateWorkspace(workspaceId);
			await client.getOrCreatePeer(workspaceId, peerId, { observe_me: peerId === observedPeerId });
			if (observedPeerId !== peerId) {
				await client.getOrCreatePeer(workspaceId, observedPeerId, { observe_me: true });
			}
			this.workspaceId = workspaceId;
			this.peerId = peerId;
			this.observedPeerId = observedPeerId;
			this.initialized = true;
		}

		return { client, workspaceId: this.workspaceId, peerId: this.peerId, observedPeerId: this.observedPeerId };
	}

	// -----------------------------------------------------------------------
	// Sidebar
	// -----------------------------------------------------------------------

	private async activateSidebar(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(HONCHO_VIEW_TYPE);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: HONCHO_VIEW_TYPE, active: true });
			this.app.workspace.revealLeaf(leaf);
		}
	}

	// -----------------------------------------------------------------------
	// Ingest
	// -----------------------------------------------------------------------

	private async runIngest(file: TFile, silent = false): Promise<void> {
		try {
			const { client, workspaceId, peerId, observedPeerId } = await this.ensureInitialized();
			const ctx = createIngestContext(
				this.app, client, workspaceId, peerId, observedPeerId, this.settings.trackFrontmatter
			);
			const result = await ingestNote(ctx, file);
			if (!silent) {
				if (result.skipped) {
					new Notice(`${file.basename}: skipped (${result.reason ?? "unchanged"})`);
				} else {
					const n = result.messages.length;
					new Notice(`Ingested ${file.basename}: ${n} message${n !== 1 ? "s" : ""}`);
				}
			}
		} catch (err) {
			new Notice(`Ingest failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async runIngestLinked(file: TFile): Promise<void> {
		try {
			const { client, workspaceId, peerId, observedPeerId } = await this.ensureInitialized();
			const ctx = createIngestContext(
				this.app, client, workspaceId, peerId, observedPeerId, this.settings.trackFrontmatter
			);
			const result = await ingestLinked(ctx, file, this.settings.linkDepth);
			const parts = [`${result.ingested} ingested`];
			if (result.skipped > 0) parts.push(`${result.skipped} unchanged`);
			new Notice(`${file.basename} + linked: ${parts.join(", ")}`);
		} catch (err) {
			new Notice(`Ingest failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async runIngestFolder(folder: TFolder): Promise<void> {
		try {
			const { client, workspaceId, peerId, observedPeerId } = await this.ensureInitialized();
			const ctx = createIngestContext(
				this.app, client, workspaceId, peerId, observedPeerId, this.settings.trackFrontmatter
			);
			const progressNotice = new Notice(`${folder.name}: scanning...`, 0);
			const result = await ingestFolder(ctx, folder, (done, total) => {
				progressNotice.setMessage(`${folder.name}: ${done}/${total} ingested...`);
			});
			progressNotice.hide();
			const { counts } = result;
			const parts: string[] = [];
			if (counts.new > 0) parts.push(`${counts.new} new`);
			if (counts.modified > 0) parts.push(`${counts.modified} modified`);
			if (counts.unchanged > 0) parts.push(`${counts.unchanged} unchanged`);
			new Notice(`${folder.name}: ${parts.join(", ")}`);
		} catch (err) {
			new Notice(`Ingest failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private runIngestFolderPicker(): void {
		const folders = this.app.vault.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && f.path !== "/");

		if (folders.length === 0) {
			new Notice("No folders found");
			return;
		}

		const { FuzzySuggestModal } = require("obsidian") as typeof import("obsidian");

		class FolderPicker extends FuzzySuggestModal<TFolder> {
			private onSelect: (folder: TFolder) => void;

			constructor(app: import("obsidian").App, folders: TFolder[], onSelect: (f: TFolder) => void) {
				super(app);
				this.onSelect = onSelect;
			}

			getItems(): TFolder[] {
				return folders;
			}

			getItemText(item: TFolder): string {
				return item.path;
			}

			onChooseItem(item: TFolder): void {
				this.onSelect(item);
			}
		}

		new FolderPicker(this.app, folders, (folder) => this.runIngestFolder(folder)).open();
	}

	private runIngestByTagPicker(): void {
		const tagSet = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			for (const t of cache.tags ?? []) {
				tagSet.add(t.tag);
			}
			for (const t of normalizeFrontmatterTags(cache.frontmatter?.tags)) {
				tagSet.add(t.startsWith("#") ? t : "#" + t);
			}
		}

		const tags = Array.from(tagSet).sort();
		if (tags.length === 0) {
			new Notice("No tags found in vault");
			return;
		}

		const { FuzzySuggestModal } = require("obsidian") as typeof import("obsidian");

		class TagPicker extends FuzzySuggestModal<string> {
			private onSelect: (tag: string) => void;

			constructor(app: import("obsidian").App, tags: string[], onSelect: (t: string) => void) {
				super(app);
				this.onSelect = onSelect;
			}

			getItems(): string[] {
				return tags;
			}

			getItemText(item: string): string {
				return item;
			}

			onChooseItem(item: string): void {
				this.onSelect(item);
			}
		}

		new TagPicker(this.app, tags, async (tag) => {
			try {
				const { client, workspaceId, peerId, observedPeerId } = await this.ensureInitialized();
				const ctx = createIngestContext(
					this.app, client, workspaceId, peerId, observedPeerId, this.settings.trackFrontmatter
				);
				const progressNotice = new Notice(`${tag}: scanning...`, 0);
				const result = await ingestByTag(ctx, tag, (done, total) => {
					progressNotice.setMessage(`${tag}: ${done}/${total} ingested...`);
				});
				progressNotice.hide();
				const { counts } = result;
				const parts: string[] = [];
				if (counts.new > 0) parts.push(`${counts.new} new`);
				if (counts.modified > 0) parts.push(`${counts.modified} modified`);
				if (counts.unchanged > 0) parts.push(`${counts.unchanged} unchanged`);
				new Notice(`${tag}: ${parts.join(", ")}`);
			} catch (err) {
				new Notice(`Ingest failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}).open();
	}

	// -----------------------------------------------------------------------
	// Search
	// -----------------------------------------------------------------------

	private async openSearch(): Promise<void> {
		try {
			const { client, workspaceId, peerId, observedPeerId } = await this.ensureInitialized();
			new HonchoSearchModal(this.app, client, workspaceId, observedPeerId).open();
		} catch (err) {
			new Notice(`${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// -----------------------------------------------------------------------
	// Chat
	// -----------------------------------------------------------------------

	private async openChat(): Promise<void> {
		try {
			const { client, workspaceId, observedPeerId } = await this.ensureInitialized();
			new HonchoChatModal(this.app, client, workspaceId, observedPeerId).open();
		} catch (err) {
			new Notice(`${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async openContextualChat(file: TFile): Promise<void> {
		try {
			const { client, workspaceId, observedPeerId } = await this.ensureInitialized();
			const cache = this.app.metadataCache.getFileCache(file);
			const noteContext: NoteContext = {
				title: file.basename,
				tags: (cache?.tags ?? []).map((t) => t.tag),
				headings: (cache?.headings ?? []).map((h) => h.heading),
			};
			// Pass session ID if the note has been ingested, grounding chat in its content
			const fm = readHonchoFrontmatter(this.app, file);
			new HonchoChatModal(this.app, client, workspaceId, observedPeerId, noteContext, fm.honcho_session_id).open();
		} catch (err) {
			new Notice(`${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// -----------------------------------------------------------------------
	// Stale Notes
	// -----------------------------------------------------------------------

	private async openStaleNotes(): Promise<void> {
		try {
			const { client, workspaceId, peerId, observedPeerId } = await this.ensureInitialized();
			const ctx = createIngestContext(
				this.app, client, workspaceId, peerId, observedPeerId, this.settings.trackFrontmatter
			);
			new StaleNotesModal(this.app, ctx).open();
		} catch (err) {
			new Notice(`${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// -----------------------------------------------------------------------
	// Peer Card
	// -----------------------------------------------------------------------

	private async runPushPeerCard(file: TFile): Promise<void> {
		try {
			const { client, workspaceId, observedPeerId } = await this.ensureInitialized();
			const ctx = createSyncContext(this.app, client, workspaceId, observedPeerId);
			await pushPeerCardFromNote(ctx, file);
		} catch (err) {
			new Notice(`Failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// -----------------------------------------------------------------------
	// Session Manager
	// -----------------------------------------------------------------------

	private async openSessionManager(): Promise<void> {
		try {
			const { client, workspaceId, peerId, observedPeerId } = await this.ensureInitialized();
			new SessionManagerModal(
				this.app,
				client,
				workspaceId,
				peerId,
				observedPeerId,
				this.settings.trackFrontmatter
			).open();
		} catch (err) {
			new Notice(`${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// -----------------------------------------------------------------------
	// Dream
	// -----------------------------------------------------------------------

	private async runScheduleDream(): Promise<void> {
		try {
			const { client, workspaceId, peerId, observedPeerId } = await this.ensureInitialized();
			await client.scheduleDream(workspaceId, peerId, { observed: observedPeerId });
			new Notice("Dream scheduled -- Honcho will process ingested material");
		} catch (err) {
			new Notice(`Failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// -----------------------------------------------------------------------
	// Sync
	// -----------------------------------------------------------------------

	private async runGenerateIdentity(): Promise<void> {
		try {
			const { client, workspaceId, observedPeerId } = await this.ensureInitialized();
			const ctx = createSyncContext(this.app, client, workspaceId, observedPeerId);
			const file = await generateIdentityNote(ctx);
			this.app.workspace.getLeaf().openFile(file);
		} catch (err) {
			new Notice(`Failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async runPullConclusions(): Promise<void> {
		try {
			const { client, workspaceId, observedPeerId } = await this.ensureInitialized();
			const ctx = createSyncContext(this.app, client, workspaceId, observedPeerId);
			const file = await pullConclusions(ctx);
			this.app.workspace.getLeaf().openFile(file);
		} catch (err) {
			new Notice(`Failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// -----------------------------------------------------------------------
	// Session lifecycle (rename / delete)
	// -----------------------------------------------------------------------

	private async handleFileRename(file: TFile, oldPath: string): Promise<void> {
		try {
			const { client, workspaceId } = await this.ensureInitialized();
			const oldSessionId = `obsidian:file:${oldPath}`;

			// Try to find the old session and update its metadata
			const sessions = await client.listSessions(workspaceId, {
				source: "obsidian",
				file_path: oldPath,
			}, 1, 1);

			if (sessions.items.length > 0) {
				const session = sessions.items[0];
				await client.updateSession(workspaceId, session.id, {
					metadata: {
						...session.metadata,
						file_path: file.path,
						file_name: file.basename,
						folder: file.parent?.path ?? "/",
						renamed_from: oldPath,
						renamed_at: new Date().toISOString(),
					},
				});
			}
		} catch {
			// Best-effort: don't disrupt the user's rename operation
		}
	}

	private async handleFileDelete(filePath: string): Promise<void> {
		try {
			const { client, workspaceId } = await this.ensureInitialized();

			const sessions = await client.listSessions(workspaceId, {
				source: "obsidian",
				file_path: filePath,
			}, 1, 1);

			if (sessions.items.length > 0) {
				const session = sessions.items[0];
				// Mark as inactive rather than deleting -- preserves derived conclusions
				await client.updateSession(workspaceId, session.id, {
					metadata: {
						...session.metadata,
						deleted_from_vault: true,
						deleted_at: new Date().toISOString(),
					},
				});
			}
		} catch {
			// Best-effort: don't disrupt the user's delete operation
		}
	}
}
