import { App, Modal, Setting, normalizePath, TFile } from "obsidian";
import type { HonchoClient, ReasoningLevel } from "../honcho-client";

interface ChatMessage {
	role: "user" | "assistant";
	content: string;
}

export class HonchoChatModal extends Modal {
	private client: HonchoClient;
	private workspaceId: string;
	private peerId: string;
	private messages: ChatMessage[] = [];
	private reasoningLevel: ReasoningLevel = "medium";
	private chatEl: HTMLElement | null = null;
	private inputEl: HTMLTextAreaElement | null = null;

	constructor(
		app: App,
		client: HonchoClient,
		workspaceId: string,
		peerId: string
	) {
		super(app);
		this.client = client;
		this.workspaceId = workspaceId;
		this.peerId = peerId;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("honcho-chat-modal");

		// Header
		const header = contentEl.createDiv({ cls: "honcho-chat-header" });
		header.createEl("h2", { text: "Ask Honcho" });

		// Reasoning level
		new Setting(header)
			.setName("Reasoning")
			.addDropdown((dd) => {
				dd.addOption("minimal", "Minimal");
				dd.addOption("low", "Low");
				dd.addOption("medium", "Medium");
				dd.addOption("high", "High");
				dd.addOption("max", "Max");
				dd.setValue(this.reasoningLevel);
				dd.onChange((value) => {
					this.reasoningLevel = value as ReasoningLevel;
				});
			});

		// Chat area
		this.chatEl = contentEl.createDiv({ cls: "honcho-chat-messages" });

		// Input area
		const inputArea = contentEl.createDiv({ cls: "honcho-chat-input-area" });
		this.inputEl = inputArea.createEl("textarea", {
			cls: "honcho-chat-input",
			placeholder: "Ask something about your identity...",
		} as DomElementInfo & { placeholder: string });
		this.inputEl.rows = 3;

		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.sendMessage();
			}
		});

		const btnRow = inputArea.createDiv({ cls: "honcho-chat-buttons" });

		const sendBtn = btnRow.createEl("button", {
			text: "Send",
			cls: "honcho-chat-send",
		});
		sendBtn.addClass("mod-cta");
		sendBtn.addEventListener("click", () => this.sendMessage());

		const saveBtn = btnRow.createEl("button", {
			text: "Save as note",
			cls: "honcho-chat-save",
		});
		saveBtn.addEventListener("click", () => this.saveConversation());

		// Focus input
		setTimeout(() => this.inputEl?.focus(), 50);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async sendMessage(): Promise<void> {
		if (!this.inputEl || !this.chatEl) return;
		const query = this.inputEl.value.trim();
		if (!query) return;

		this.inputEl.value = "";
		this.messages.push({ role: "user", content: query });
		this.renderMessages();

		// Show loading
		const loadingEl = this.chatEl.createDiv({ cls: "honcho-chat-loading" });
		loadingEl.setText("Thinking...");
		this.chatEl.scrollTop = this.chatEl.scrollHeight;

		try {
			const resp = await this.client.peerChat(
				this.workspaceId,
				this.peerId,
				query,
				{ reasoning_level: this.reasoningLevel }
			);

			loadingEl.remove();
			const content = resp.content ?? "No response.";
			this.messages.push({ role: "assistant", content });
			this.renderMessages();
		} catch (err) {
			loadingEl.remove();
			const errMsg = err instanceof Error ? err.message : String(err);
			this.messages.push({ role: "assistant", content: `Error: ${errMsg}` });
			this.renderMessages();
		}
	}

	private renderMessages(): void {
		if (!this.chatEl) return;
		this.chatEl.empty();

		for (const msg of this.messages) {
			const bubble = this.chatEl.createDiv({
				cls: `honcho-chat-bubble honcho-chat-${msg.role}`,
			});
			bubble.setText(msg.content);
		}

		this.chatEl.scrollTop = this.chatEl.scrollHeight;
	}

	private async saveConversation(): Promise<void> {
		if (this.messages.length === 0) return;

		const lines: string[] = [
			"---",
			`honcho_chat: ${new Date().toISOString()}`,
			`honcho_peer: ${this.peerId}`,
			`reasoning_level: ${this.reasoningLevel}`,
			"---",
			"",
			"## Honcho Conversation",
			"",
		];

		for (const msg of this.messages) {
			const label = msg.role === "user" ? "**You**" : "**Honcho**";
			lines.push(`${label}: ${msg.content}`, "");
		}

		const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const fileName = `Honcho Chat ${ts}`;
		const path = normalizePath(`${fileName}.md`);

		await this.app.vault.create(path, lines.join("\n"));
		this.close();
	}
}
