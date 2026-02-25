import { App, MarkdownRenderer, Modal, Notice, Setting, normalizePath, TFile } from "obsidian";
import type { HonchoClient, ReasoningLevel } from "../honcho-client";

export interface NoteContext {
	title: string;
	tags: string[];
	headings: string[];
}

interface ChatMessage {
	role: "user" | "assistant";
	content: string;
}

export class HonchoChatModal extends Modal {
	private client: HonchoClient;
	private workspaceId: string;
	private peerId: string;
	private noteContext: NoteContext | null;
	private sessionId: string | undefined;
	private messages: ChatMessage[] = [];
	private reasoningLevel: ReasoningLevel = "medium";
	private chatEl: HTMLElement | null = null;
	private inputEl: HTMLTextAreaElement | null = null;
	private sending = false;
	private abortController: AbortController | null = null;

	constructor(
		app: App,
		client: HonchoClient,
		workspaceId: string,
		peerId: string,
		noteContext?: NoteContext,
		sessionId?: string
	) {
		super(app);
		this.client = client;
		this.workspaceId = workspaceId;
		this.peerId = peerId;
		this.noteContext = noteContext ?? null;
		this.sessionId = sessionId;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("honcho-chat-modal");

		// Header
		const header = contentEl.createDiv({ cls: "honcho-chat-header" });
		if (this.noteContext) {
			header.createEl("h2", { text: `Ask Honcho \u2014 ${this.noteContext.title}` });
			if (this.noteContext.tags.length > 0) {
				const tagBar = header.createDiv({ cls: "honcho-chat-context-tags" });
				for (const tag of this.noteContext.tags.slice(0, 6)) {
					tagBar.createEl("span", { text: tag, cls: "honcho-context-tag" });
				}
			}
		} else {
			header.createEl("h2", { text: "Ask Honcho" });
		}

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
			placeholder: this.noteContext
				? `Ask about "${this.noteContext.title}" or your identity...`
				: "Ask something about your identity...",
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

		const dailyBtn = btnRow.createEl("button", {
			text: "Append to daily note",
			cls: "honcho-chat-daily",
		});
		dailyBtn.addEventListener("click", () => this.appendToDailyNote());

		// Focus input
		setTimeout(() => this.inputEl?.focus(), 50);
	}

	onClose(): void {
		this.abortController?.abort();
		this.abortController = null;
		this.contentEl.empty();
	}

	/**
	 * Build a search_query from note context to focus
	 * the chat's representation on relevant material.
	 */
	private buildSearchQuery(): string | undefined {
		if (!this.noteContext) return undefined;
		return [
			this.noteContext.title,
			...this.noteContext.tags,
			...this.noteContext.headings.slice(0, 3),
		].join(" ");
	}

	private async sendMessage(): Promise<void> {
		if (!this.inputEl || !this.chatEl || this.sending) return;
		const query = this.inputEl.value.trim();
		if (!query) return;

		this.sending = true;
		this.inputEl.value = "";
		this.messages.push({ role: "user", content: query });
		this.renderMessages();

		// Create streaming response bubble
		const bubble = this.chatEl.createDiv({
			cls: "honcho-chat-bubble honcho-chat-assistant honcho-chat-streaming",
		});
		const contentEl = bubble.createDiv({ cls: "honcho-chat-stream-content" });
		contentEl.setText("...");
		this.chatEl.scrollTop = this.chatEl.scrollHeight;

		let accumulated = "";

		// Build the actual query: if we have note context, prepend it
		const contextualQuery = this.noteContext
			? `[Context: viewing "${this.noteContext.title}"${this.noteContext.tags.length > 0 ? `, tags: ${this.noteContext.tags.join(", ")}` : ""}]\n\n${query}`
			: query;

		// Create AbortController for this request
		this.abortController = new AbortController();

		try {
			const stream = this.client.peerChatStream(
				this.workspaceId,
				this.peerId,
				contextualQuery,
				{ reasoning_level: this.reasoningLevel, session_id: this.sessionId },
				this.abortController.signal
			);

			for await (const event of stream) {
				if (event.done) break;
				if (event.delta?.content) {
					accumulated += event.delta.content;
					contentEl.empty();
					await MarkdownRenderer.render(
						this.app,
						accumulated,
						contentEl,
						"",
						this
					);
					this.chatEl!.scrollTop = this.chatEl!.scrollHeight;
				}
			}
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") {
				// User closed modal mid-stream -- keep partial content
				if (accumulated) {
					accumulated += "\n\n*[Response interrupted]*";
				}
			} else if (!accumulated) {
				// Streaming failed entirely -- fall back to non-streaming
				try {
					const resp = await this.client.peerChat(
						this.workspaceId,
						this.peerId,
						contextualQuery,
						{ reasoning_level: this.reasoningLevel, session_id: this.sessionId }
					);
					accumulated = resp.content ?? "No response.";
				} catch (fallbackErr) {
					accumulated = `Error: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`;
				}
			} else {
				// Stream broke mid-response -- mark as truncated
				accumulated += "\n\n*[Response interrupted]*";
			}
		} finally {
			this.abortController = null;
		}

		// Finalize: replace streaming bubble with rendered content
		bubble.removeClass("honcho-chat-streaming");
		const content = accumulated || "No response.";
		this.messages.push({ role: "assistant", content });
		this.renderMessages();
		this.sending = false;
	}

	private renderMessages(): void {
		if (!this.chatEl) return;
		this.chatEl.empty();

		for (const msg of this.messages) {
			const bubble = this.chatEl.createDiv({
				cls: `honcho-chat-bubble honcho-chat-${msg.role}`,
			});
			if (msg.role === "assistant") {
				// Render assistant messages as markdown
				const contentDiv = bubble.createDiv();
				MarkdownRenderer.render(
					this.app,
					msg.content,
					contentDiv,
					"",
					this
				);
			} else {
				bubble.setText(msg.content);
			}
		}

		this.chatEl.scrollTop = this.chatEl.scrollHeight;
	}

	private async appendToDailyNote(): Promise<void> {
		if (this.messages.length === 0) return;

		const dailyPlugin = (this.app as any).internalPlugins?.plugins?.["daily-notes"];
		if (!dailyPlugin?.enabled) {
			new Notice("Daily notes plugin is not enabled");
			return;
		}

		const config = dailyPlugin.instance?.options ?? {};
		const folder = config.folder ?? "";
		const format = config.format ?? "YYYY-MM-DD";

		// Build today's filename using the configured format
		const now = new Date();
		const dateStr = format
			.replace("YYYY", String(now.getFullYear()))
			.replace("MM", String(now.getMonth() + 1).padStart(2, "0"))
			.replace("DD", String(now.getDate()).padStart(2, "0"));

		const dailyPath = normalizePath(
			folder ? `${folder}/${dateStr}.md` : `${dateStr}.md`
		);

		// Build conversation markdown
		const lines: string[] = [
			"",
			`## Honcho Chat \u2014 ${now.toLocaleTimeString()}`,
			"",
		];

		if (this.noteContext) {
			lines.push(`*Context: ${this.noteContext.title}*`, "");
		}

		for (const msg of this.messages) {
			const label = msg.role === "user" ? "**You**" : "**Honcho**";
			lines.push(`${label}: ${msg.content}`, "");
		}

		const text = lines.join("\n");

		// Append to existing daily note or create it
		const existing = this.app.vault.getAbstractFileByPath(dailyPath);
		if (existing instanceof TFile) {
			await this.app.vault.append(existing, text);
		} else {
			await this.app.vault.create(dailyPath, text.trimStart());
		}

		new Notice(`Appended conversation to ${dateStr}`);
	}

	private async saveConversation(): Promise<void> {
		if (this.messages.length === 0) return;

		const lines: string[] = [
			"---",
			`honcho_chat: ${new Date().toISOString()}`,
			`honcho_peer: ${this.peerId}`,
			`reasoning_level: ${this.reasoningLevel}`,
		];

		if (this.noteContext) {
			lines.push(`honcho_context_note: "${this.noteContext.title}"`);
		}

		lines.push("---", "", "## Honcho Conversation", "");

		if (this.noteContext) {
			lines.push(`*Context: ${this.noteContext.title}*`, "");
		}

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
