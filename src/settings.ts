import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type HonchoPlugin from "./main";

type SuggestionReasoningLevel = "low" | "medium" | "high" | "max";

export interface HonchoPluginSettings {
	apiKey: string;
	baseUrl: string;
	apiVersion: string;
	workspaceName: string;
	peerName: string;
	autoSync: boolean;
	autoSyncTags: string[];
	autoSyncFolders: string[];
	autoSyncDailyNotes: boolean;
	minSyncInterval: number; // minutes
	trackFrontmatter: boolean;
	autoSuggestFrontmatterOnOpen: boolean;
	frontmatterSuggestionReasoning: SuggestionReasoningLevel;
	feedbackLoop: boolean;
	linkDepth: number;
}

export const DEFAULT_SETTINGS: HonchoPluginSettings = {
	apiKey: "",
	baseUrl: "https://api.honcho.dev",
	apiVersion: "v3",
	workspaceName: "",
	peerName: "",
	autoSync: false,
	autoSyncTags: [],
	autoSyncFolders: [],
	autoSyncDailyNotes: false,
	minSyncInterval: 5,
	trackFrontmatter: true,
	autoSuggestFrontmatterOnOpen: false,
	frontmatterSuggestionReasoning: "low",
	feedbackLoop: false,
	linkDepth: 1,
};

export class HonchoSettingTab extends PluginSettingTab {
	plugin: HonchoPlugin;
	private dirty = false;
	private saveBtn: HTMLButtonElement | null = null;

	constructor(app: App, plugin: HonchoPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	hide(): void {
		// Auto-save on close so changes are never lost
		if (this.dirty) {
			void this.plugin.saveSettings();
			this.dirty = false;
		}
	}

	private markDirty(): void {
		this.dirty = true;
		if (this.saveBtn) {
			this.saveBtn.textContent = "Save";
			this.saveBtn.disabled = false;
			this.saveBtn.removeClass("honcho-save-done");
		}
	}

	private filterSettings(container: HTMLElement, query: string): void {
		const q = query.toLowerCase().trim();

		let currentHeader: HTMLElement | null = null;
		let headerHasVisibleItems = false;

		for (const child of Array.from(container.children)) {
			if (!(child instanceof HTMLElement)) continue;

			// Skip non-setting elements (h2, search bar, save bar)
			if (child.classList.contains("honcho-settings-search") ||
				child.classList.contains("honcho-settings-save") ||
				child.tagName === "H2") {
				continue;
			}

			if (child.tagName === "H3") {
				// Flush previous section
				if (currentHeader) {
					currentHeader.style.display = headerHasVisibleItems || !q ? "" : "none";
				}
				currentHeader = child;
				headerHasVisibleItems = false;
				continue;
			}

			if (child.classList.contains("setting-item")) {
				const text = child.textContent?.toLowerCase() ?? "";
				const sectionText = currentHeader?.textContent?.toLowerCase() ?? "";
				const matches = !q || text.includes(q) || sectionText.includes(q);
				child.style.display = matches ? "" : "none";
				if (matches) headerHasVisibleItems = true;
			}
		}

		// Flush last section
		if (currentHeader) {
			currentHeader.style.display = headerHasVisibleItems || !q ? "" : "none";
		}
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Honcho" });

		// -- Search --
		const searchBar = containerEl.createDiv({ cls: "honcho-settings-search" });
		const searchInput = searchBar.createEl("input", {
			type: "text",
			placeholder: "Search settings\u2026",
			cls: "honcho-settings-search-input",
		});
		searchInput.addEventListener("input", () => {
			this.filterSettings(containerEl, searchInput.value);
		});

		// -- Connection --
		containerEl.createEl("h3", { text: "Connection" });

		new Setting(containerEl)
			.setName("API key")
			.setDesc("Your Honcho API key")
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.style.width = "100%";
				text
					.setPlaceholder("Enter your API key")
					.setValue(this.plugin.settings.apiKey)
					.onChange((value) => {
						this.plugin.settings.apiKey = value;
						this.markDirty();
					});
			});

		const PRESET_URLS: Record<string, string> = {
			production: "https://api.honcho.dev",
			local: "http://localhost:8000",
		};
		const getPresetKey = (url: string) =>
			url === PRESET_URLS.production ? "production"
			: url === PRESET_URLS.local ? "local"
			: "custom";

		let customUrlInput: HTMLInputElement | null = null;

		new Setting(containerEl)
			.setName("Base URL")
			.setDesc("Honcho API base URL")
			.addDropdown((dd) => {
				dd.addOption("production", "Production \u2014 api.honcho.dev");
				dd.addOption("local", "Local \u2014 localhost:8000");
				dd.addOption("custom", "Custom");
				dd.setValue(getPresetKey(this.plugin.settings.baseUrl));
				dd.onChange((value) => {
					if (value === "custom") {
						if (customUrlInput) customUrlInput.style.display = "";
					} else {
						if (customUrlInput) customUrlInput.style.display = "none";
						this.plugin.settings.baseUrl = PRESET_URLS[value];
						this.markDirty();
					}
				});
			})
			.addText((text) => {
				customUrlInput = text.inputEl;
				const isCustom = getPresetKey(this.plugin.settings.baseUrl) === "custom";
				text.inputEl.style.display = isCustom ? "" : "none";
				text.inputEl.style.width = "200px";
				text
					.setPlaceholder("https://your-instance.example.com")
					.setValue(isCustom ? this.plugin.settings.baseUrl : "")
					.onChange((value) => {
						this.plugin.settings.baseUrl = value;
						this.markDirty();
					});
			});

		new Setting(containerEl)
			.setName("API version")
			.setDesc("API version prefix (e.g. v3)")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.apiVersion)
					.onChange((value) => {
						this.plugin.settings.apiVersion = value;
						this.markDirty();
					})
			);

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Verify your API key and endpoint are working")
			.addButton((btn) =>
				btn.setButtonText("Test").setCta().onClick(async () => {
					// Save first so the client picks up any pending changes
					if (this.dirty) {
						await this.plugin.saveSettings();
						this.dirty = false;
					}
					const client = this.plugin.getClient();
					if (!client) {
						new Notice("Configure an API key first");
						return;
					}
					const ok = await client.testConnection();
					new Notice(ok ? "Connected to Honcho" : "Connection failed \u2014 check your API key and URL");
				})
			);

		// -- Identity --
		containerEl.createEl("h3", { text: "Identity" });

		new Setting(containerEl)
			.setName("Workspace name")
			.setDesc("Honcho workspace ID. Defaults to vault name if empty.")
			.addText((text) =>
				text
					.setPlaceholder(this.app.vault.getName())
					.setValue(this.plugin.settings.workspaceName)
					.onChange((value) => {
						this.plugin.settings.workspaceName = value;
						this.markDirty();
					})
			);

		new Setting(containerEl)
			.setName("Peer name")
			.setDesc("Your identity in Honcho. Ingested content and conclusions are attributed to this peer.")
			.addText((text) =>
				text
					.setPlaceholder("your name")
					.setValue(this.plugin.settings.peerName)
					.onChange((value) => {
						this.plugin.settings.peerName = value;
						this.markDirty();
					})
			);

		// -- Ingestion --
		containerEl.createEl("h3", { text: "Ingestion" });

		new Setting(containerEl)
			.setName("Link traversal depth")
			.setDesc("How many levels of outgoing links to follow when using 'Ingest + linked notes'")
			.addSlider((slider) =>
				slider
					.setLimits(1, 3, 1)
					.setValue(this.plugin.settings.linkDepth)
					.setDynamicTooltip()
					.onChange((value) => {
						this.plugin.settings.linkDepth = value;
						this.markDirty();
					})
			);

		// -- Auto-sync --
		containerEl.createEl("h3", { text: "Auto-sync" });

		new Setting(containerEl)
			.setName("Auto-sync on save")
			.setDesc("Automatically send notes to Honcho when they are saved")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoSync).onChange((value) => {
					this.plugin.settings.autoSync = value;
					this.markDirty();
				})
			);

		new Setting(containerEl)
			.setName("Minimum sync interval")
			.setDesc("Minimum time between re-syncs of the same note (minutes)")
			.addDropdown((dd) => {
				dd.addOption("1", "1 minute");
				dd.addOption("2", "2 minutes");
				dd.addOption("5", "5 minutes (default)");
				dd.addOption("10", "10 minutes");
				dd.addOption("30", "30 minutes");
				dd.setValue(String(this.plugin.settings.minSyncInterval));
				dd.onChange((value) => {
					this.plugin.settings.minSyncInterval = parseInt(value, 10);
					this.markDirty();
				});
			});

		new Setting(containerEl)
			.setName("Auto-sync tags")
			.setDesc("Only auto-sync notes with these tags (comma-separated, e.g. #honcho,#identity). Leave empty for all.")
			.addText((text) =>
				text
					.setPlaceholder("#honcho, #identity")
					.setValue(this.plugin.settings.autoSyncTags.join(", "))
					.onChange((value) => {
						this.plugin.settings.autoSyncTags = value
							.split(",")
							.map((t) => t.trim())
							.filter((t) => t.length > 0);
						this.markDirty();
					})
			);

		new Setting(containerEl)
			.setName("Auto-sync folders")
			.setDesc("Only auto-sync notes in these folders (comma-separated). Leave empty for all.")
			.addText((text) =>
				text
					.setPlaceholder("identity, notes/honcho")
					.setValue(this.plugin.settings.autoSyncFolders.join(", "))
					.onChange((value) => {
						this.plugin.settings.autoSyncFolders = value
							.split(",")
							.map((f) => f.trim())
							.filter((f) => f.length > 0);
						this.markDirty();
					})
			);

		// -- Daily Notes --
		containerEl.createEl("h3", { text: "Daily Notes" });

		new Setting(containerEl)
			.setName("Auto-sync daily notes")
			.setDesc("Automatically sync daily notes to Honcho when opened")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoSyncDailyNotes).onChange((value) => {
					this.plugin.settings.autoSyncDailyNotes = value;
					this.markDirty();
				})
			);

		// -- Frontmatter --
		containerEl.createEl("h3", { text: "Frontmatter" });

		new Setting(containerEl)
			.setName("Track ingestion in frontmatter")
			.setDesc("Add synced, session, and hash fields to ingested notes")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.trackFrontmatter).onChange((value) => {
					this.plugin.settings.trackFrontmatter = value;
					this.markDirty();
				})
			);

		new Setting(containerEl)
			.setName("Auto-suggest frontmatter on file open")
			.setDesc("When the Honcho sidebar is open, automatically generate frontmatter suggestions for newly opened notes.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoSuggestFrontmatterOnOpen).onChange((value) => {
					this.plugin.settings.autoSuggestFrontmatterOnOpen = value;
					this.markDirty();
				})
			);

		new Setting(containerEl)
			.setName("Frontmatter suggestion reasoning")
			.setDesc("Reasoning depth used when generating frontmatter suggestions.")
			.addDropdown((dd) => {
				dd.addOption("low", "Low");
				dd.addOption("medium", "Medium");
				dd.addOption("high", "High");
				dd.addOption("max", "Max");
				dd.setValue(this.plugin.settings.frontmatterSuggestionReasoning);
				dd.onChange((value) => {
					this.plugin.settings.frontmatterSuggestionReasoning = value as SuggestionReasoningLevel;
					this.markDirty();
				});
			});

		// -- Experimental --
		containerEl.createEl("h3", { text: "Experimental" });

		new Setting(containerEl)
			.setName("Write Honcho feedback into notes")
			.setDesc("Append a ## Honcho section with conclusions to ingested notes. Manual command only \u2014 no automatic triggers. Per-note override via honcho_feedback frontmatter.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.feedbackLoop).onChange((value) => {
					this.plugin.settings.feedbackLoop = value;
					this.markDirty();
				})
			);

		// -- Save --
		const saveBar = containerEl.createDiv({ cls: "honcho-settings-save" });
		const saveBtn = saveBar.createEl("button", {
			text: "Save",
			cls: "honcho-settings-save-btn mod-cta",
		});
		saveBtn.disabled = true;
		this.saveBtn = saveBtn;

		saveBtn.addEventListener("click", async () => {
			await this.plugin.saveSettings();
			this.dirty = false;
			saveBtn.textContent = "Saved";
			saveBtn.disabled = true;
			saveBtn.addClass("honcho-save-done");
		});
	}
}
