import { Notice, Plugin, TFile, TFolder, type WorkspaceLeaf } from "obsidian";
import { HonchoClient } from "./honcho-client";
import { DEFAULT_SETTINGS, HonchoSettingTab, type HonchoPluginSettings } from "./settings";
import { HONCHO_VIEW_TYPE, HonchoSidebarView } from "./views/sidebar-view";
import { HonchoChatModal } from "./views/chat-modal";
import { HonchoSearchModal } from "./commands/search";
import { createIngestContext, ingestNote, ingestFolder, ingestByTag } from "./commands/ingest";
import { createSyncContext, generateIdentityNote, pullConclusions } from "./commands/sync";
import { matchesSyncFilters } from "./utils/frontmatter";

export default class HonchoPlugin extends Plugin {
	settings: HonchoPluginSettings = DEFAULT_SETTINGS;
	private client: HonchoClient | null = null;
	private saveDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
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
			id: "generate-identity-note",
			name: "Generate identity note",
			callback: () => this.runGenerateIdentity(),
		});

		this.addCommand({
			id: "pull-conclusions",
			name: "Pull conclusions into vault",
			callback: () => this.runPullConclusions(),
		});

		// -- Settings tab --
		this.addSettingTab(new HonchoSettingTab(this.app, this));

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

				// Debounce 5s per file
				const existing = this.saveDebounceTimers.get(file.path);
				if (existing) clearTimeout(existing);

				const timer = setTimeout(() => {
					this.saveDebounceTimers.delete(file.path);
					this.runIngest(file, true);
				}, 5000);
				this.saveDebounceTimers.set(file.path, timer);
			})
		);
	}

	onunload(): void {
		for (const timer of this.saveDebounceTimers.values()) {
			clearTimeout(timer);
		}
		this.saveDebounceTimers.clear();
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
			const created = await ingestNote(ctx, file);
			if (!silent) {
				new Notice(`Ingested ${file.basename}: ${created.length} message${created.length !== 1 ? "s" : ""}`);
			}
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
			const total = await ingestFolder(ctx, folder);
			new Notice(`Ingested ${folder.name}: ${total} message${total !== 1 ? "s" : ""}`);
		} catch (err) {
			new Notice(`Ingest failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private runIngestFolderPicker(): void {
		// Use a simple prompt - Obsidian doesn't have a native folder picker command
		const folders = this.app.vault.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && f.path !== "/");

		if (folders.length === 0) {
			new Notice("No folders found");
			return;
		}

		// Use the fuzzy suggest modal approach
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
		// Collect all tags from the vault
		const tagSet = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			for (const t of cache.tags ?? []) {
				tagSet.add(t.tag);
			}
			for (const t of (cache.frontmatter?.tags as string[]) ?? []) {
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
				const total = await ingestByTag(ctx, tag);
				new Notice(`Ingested ${tag}: ${total} message${total !== 1 ? "s" : ""}`);
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
			const { client, workspaceId, peerId, observedPeerId } = await this.ensureInitialized();
			new HonchoChatModal(this.app, client, workspaceId, observedPeerId).open();
		} catch (err) {
			new Notice(`${err instanceof Error ? err.message : String(err)}`);
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
}
