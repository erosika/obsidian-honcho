/**
 * Honcho service for the Obsidian-Honcho MCP server.
 *
 * Thin wrapper around @honcho-ai/sdk. Single-peer model: one peer who sends
 * messages and gets observed. Aligns with the plugin's collapsed peer architecture.
 *
 * Lazy initialization: workspace + peer created on first Honcho tool use.
 */

import { Honcho, type Peer } from "@honcho-ai/sdk";

// ---------------------------------------------------------------------------
// Response types (kept for bridge.ts compatibility)
// ---------------------------------------------------------------------------

export interface PageResponse<T> {
	items: T[];
	page: number;
	size: number;
	total: number;
	pages: number;
}

export interface SessionResponse {
	id: string;
	workspace_id: string;
	is_active: boolean;
	metadata: Record<string, unknown>;
	configuration: Record<string, unknown>;
	created_at: string;
}

export interface ConclusionResponse {
	id: string;
	content: string;
	observer_id: string;
	observed_id: string;
	session_id: string | null;
	created_at: string;
}

export interface RepresentationResponse {
	representation: string;
}

export interface QueueStatusResponse {
	total_work_units: number;
	completed_work_units: number;
	in_progress_work_units: number;
	pending_work_units: number;
}

export interface ChatResponse {
	content: string;
	session_id: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface HonchoServiceConfig {
	apiKey: string;
	baseUrl: string;
	workspace: string;
	peer: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class HonchoService {
	private sdk: Honcho;
	private _peer: Peer | null = null;
	readonly workspace: string;
	readonly peer: string;
	private initialized = false;

	constructor(config: HonchoServiceConfig) {
		this.workspace = config.workspace;
		this.peer = config.peer;
		this.sdk = new Honcho({
			workspaceId: config.workspace,
			apiKey: config.apiKey,
			baseURL: config.baseUrl,
		});
	}

	async ensureInitialized(): Promise<void> {
		if (this.initialized) return;
		this._peer = await this.sdk.peer(this.peer);
		this.initialized = true;
	}

	private get hPeer(): Peer {
		if (!this._peer) throw new Error("Honcho not initialized — call ensureInitialized() first");
		return this._peer;
	}

	// -----------------------------------------------------------------------
	// Sessions
	// -----------------------------------------------------------------------

	async listSessions(
		_filters?: Record<string, unknown>,
		_page = 1,
		_size = 50
	): Promise<PageResponse<SessionResponse>> {
		const page = await this.hPeer.sessions();
		const items: SessionResponse[] = page.items.map((s) => ({
			id: s.id,
			workspace_id: s.workspaceId,
			is_active: true,
			metadata: s.metadata ?? {},
			configuration: s.configuration ?? {},
			created_at: "",
		}));
		return { items, page: 1, size: items.length, total: page.total, pages: page.pages };
	}

	// -----------------------------------------------------------------------
	// Conclusions
	// -----------------------------------------------------------------------

	async queryConclusions(
		query: string,
		opts?: { top_k?: number }
	): Promise<ConclusionResponse[]> {
		const results = await this.hPeer.conclusions.query(query, opts?.top_k);
		return results.map((c) => ({
			id: c.id,
			content: c.content,
			observer_id: c.observerId,
			observed_id: c.observedId,
			session_id: c.sessionId,
			created_at: c.createdAt,
		}));
	}

	async listConclusions(
		filters?: Record<string, unknown>,
		page = 1,
		size = 50
	): Promise<PageResponse<ConclusionResponse>> {
		const sessionId = filters?.session_id as string | undefined;
		const result = await this.hPeer.conclusions.list({ session: sessionId, page, size });
		const items: ConclusionResponse[] = result.items.map((c) => ({
			id: c.id,
			content: c.content,
			observer_id: c.observerId,
			observed_id: c.observedId,
			session_id: c.sessionId,
			created_at: c.createdAt,
		}));
		return { items, page: result.page, size: result.size, total: result.total, pages: result.pages };
	}

	// -----------------------------------------------------------------------
	// Representation
	// -----------------------------------------------------------------------

	async getPeerRepresentation(
		opts?: { search_query?: string; search_top_k?: number }
	): Promise<RepresentationResponse> {
		const representation = await this.hPeer.representation({
			searchQuery: opts?.search_query,
			searchTopK: opts?.search_top_k,
		});
		return { representation };
	}

	// -----------------------------------------------------------------------
	// Chat
	// -----------------------------------------------------------------------

	async peerChat(sessionId: string, message: string): Promise<ChatResponse> {
		const content = await this.hPeer.chat(message, { session: sessionId });
		return { content: content ?? "", session_id: sessionId };
	}

	// -----------------------------------------------------------------------
	// Queue
	// -----------------------------------------------------------------------

	async getQueueStatus(): Promise<QueueStatusResponse> {
		const status = await this.sdk.queueStatus({ observer: this.peer });
		return {
			total_work_units: status.totalWorkUnits,
			completed_work_units: status.completedWorkUnits,
			in_progress_work_units: status.inProgressWorkUnits,
			pending_work_units: status.pendingWorkUnits,
		};
	}

	// -----------------------------------------------------------------------
	// Dream
	// -----------------------------------------------------------------------

	async scheduleDream(opts?: { session_id?: string }): Promise<void> {
		await this.sdk.scheduleDream({
			observer: this.peer,
			observed: this.peer,
			session: opts?.session_id,
		});
	}
}
