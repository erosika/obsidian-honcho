import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type HonchoPlugin from "./main";

export interface HonchoPluginSettings {
	apiKey: string;
	baseUrl: string;
	apiVersion: string;
	workspaceName: string;
	peerName: string;
	observedPeerName: string;
	autoSync: boolean;
	autoSyncTags: string[];
	autoSyncFolders: string[];
	autoSyncDailyNotes: boolean;
	trackFrontmatter: boolean;
	linkDepth: number;
}

export const DEFAULT_SETTINGS: HonchoPluginSettings = {
	apiKey: "",
	baseUrl: "https://api.honcho.dev",
	apiVersion: "v3",
	workspaceName: "",
	peerName: "obsidian",
	observedPeerName: "",
	autoSync: false,
	autoSyncTags: [],
	autoSyncFolders: [],
	autoSyncDailyNotes: false,
	trackFrontmatter: true,
	linkDepth: 1,
};

export class HonchoSettingTab extends PluginSettingTab {
	plugin: HonchoPlugin;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(app: App, plugin: HonchoPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private debouncedSave(): void {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(async () => {
			this.saveTimer = null;
			await this.plugin.saveSettings();
		}, 500);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Honcho" });

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
						this.debouncedSave();
					});
			});

		new Setting(containerEl)
			.setName("Base URL")
			.setDesc("Honcho API base URL")
			.addText((text) =>
				text
					.setPlaceholder("https://api.honcho.dev")
					.setValue(this.plugin.settings.baseUrl)
					.onChange((value) => {
						this.plugin.settings.baseUrl = value;
						this.debouncedSave();
					})
			);

		new Setting(containerEl)
			.setName("API version")
			.setDesc("API version prefix (e.g. v3)")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.apiVersion)
					.onChange((value) => {
						this.plugin.settings.apiVersion = value;
						this.debouncedSave();
					})
			);

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Verify your API key and endpoint are working")
			.addButton((btn) =>
				btn.setButtonText("Test").setCta().onClick(async () => {
					const client = this.plugin.getClient();
					if (!client) {
						new Notice("Configure an API key first");
						return;
					}
					const ok = await client.testConnection();
					new Notice(ok ? "Connected to Honcho" : "Connection failed -- check your API key and URL");
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
						this.debouncedSave();
					})
			);

		new Setting(containerEl)
			.setName("Observer peer")
			.setDesc("The peer that represents this vault. This is who sends messages when you ingest notes.")
			.addText((text) =>
				text
					.setPlaceholder("obsidian")
					.setValue(this.plugin.settings.peerName)
					.onChange((value) => {
						this.plugin.settings.peerName = value;
						this.debouncedSave();
					})
			);

		new Setting(containerEl)
			.setName("Observed peer")
			.setDesc("The peer being observed. Ingested content builds this peer's representation. Leave empty to observe self (observer = observed).")
			.addText((text) =>
				text
					.setPlaceholder("Same as observer")
					.setValue(this.plugin.settings.observedPeerName)
					.onChange((value) => {
						this.plugin.settings.observedPeerName = value;
						this.debouncedSave();
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
					.onChange(async (value) => {
						this.plugin.settings.linkDepth = value;
						await this.plugin.saveSettings();
					})
			);

		// -- Auto-sync --
		containerEl.createEl("h3", { text: "Auto-sync" });

		new Setting(containerEl)
			.setName("Auto-sync on save")
			.setDesc("Automatically send notes to Honcho when they are saved")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
					this.plugin.settings.autoSync = value;
					await this.plugin.saveSettings();
				})
			);

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
						this.debouncedSave();
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
						this.debouncedSave();
					})
			);

		// -- Daily Notes --
		containerEl.createEl("h3", { text: "Daily Notes" });

		new Setting(containerEl)
			.setName("Auto-sync daily notes")
			.setDesc("Automatically sync daily notes to Honcho when opened")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoSyncDailyNotes).onChange(async (value) => {
					this.plugin.settings.autoSyncDailyNotes = value;
					await this.plugin.saveSettings();
				})
			);

		// -- Frontmatter --
		containerEl.createEl("h3", { text: "Frontmatter" });

		new Setting(containerEl)
			.setName("Track ingestion in frontmatter")
			.setDesc("Add honcho_synced, honcho_session_id, and honcho_message_count to ingested notes")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.trackFrontmatter).onChange(async (value) => {
					this.plugin.settings.trackFrontmatter = value;
					await this.plugin.saveSettings();
				})
			);
	}
}
