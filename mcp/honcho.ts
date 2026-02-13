/**
 * Honcho API client for the MCP server.
 *
 * Direct port of src/honcho-client.ts with Obsidian's requestUrl
 * replaced by native fetch. All type interfaces and method signatures
 * are preserved.
 */

import { HonchoApiError } from "./types.ts";

// ---------------------------------------------------------------------------
// Types (mirrored from src/honcho-client.ts)
// ---------------------------------------------------------------------------

export interface PageResponse<T> {
	items: T[];
	page: number;
	size: number;
	total: number;
	pages: number;
}

export interface WorkspaceResponse {
	id: string;
	metadata: Record<string, unknown>;
	configuration: Record<string, unknown>;
	created_at: string;
}

export interface PeerResponse {
	id: string;
	workspace_id: string;
	metadata: Record<string, unknown>;
	configuration: Record<string, unknown>;
	created_at: string;
}

export interface SessionResponse {
	id: string;
	workspace_id: string;
	is_active: boolean;
	metadata: Record<string, unknown>;
	configuration: Record<string, unknown>;
	created_at: string;
}

export interface MessageResponse {
	id: string;
	content: string;
	peer_id: string;
	session_id: string;
	workspace_id: string;
	metadata: Record<string, unknown>;
	created_at: string;
	token_count: number;
}

export interface ConclusionResponse {
	id: string;
	content: string;
	observer_id: string;
	observed_id: string;
	session_id: string | null;
	created_at: string;
}

export interface PeerCardResponse {
	peer_card: string[] | null;
}

export interface RepresentationResponse {
	representation: string;
}

export interface PeerContextResponse {
	peer_id: string;
	target_id: string;
	representation: string | null;
	peer_card: string[] | null;
}

export interface PeerChatResponse {
	content: string | null;
}

export interface QueueStatusResponse {
	total_work_units: number;
	completed_work_units: number;
	in_progress_work_units: number;
	pending_work_units: number;
	sessions?: Record<string, {
		session_id: string | null;
		total_work_units: number;
		completed_work_units: number;
		in_progress_work_units: number;
		pending_work_units: number;
	}>;
}

export interface SessionPeerConfig {
	observe_me?: boolean;
	observe_others?: boolean;
}

export interface SessionConfiguration {
	reasoning?: { enabled?: boolean } | null;
	peer_card?: { enabled?: boolean } | null;
	summary?: { enabled?: boolean } | null;
	dream?: { enabled?: boolean } | null;
}

export interface SessionSummaryResponse {
	short_summary: string | null;
	long_summary: string | null;
	last_message_id: string | null;
}

export interface SessionContextResponse {
	messages: MessageResponse[];
	summary: string | null;
	representation: string | null;
	peer_card: string[] | null;
}

export type ReasoningLevel = "minimal" | "low" | "medium" | "high" | "max";
export type DreamType = "omni";

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface HonchoClientConfig {
	apiKey: string;
	baseUrl: string;
	apiVersion: string;
}

export class HonchoClient {
	private apiKey: string;
	private baseUrl: string;
	private apiVersion: string;

	constructor(config: HonchoClientConfig) {
		this.apiKey = config.apiKey;
		this.baseUrl = config.baseUrl.replace(/\/+$/, "");
		this.apiVersion = config.apiVersion;
	}

	private url(path: string): string {
		return `${this.baseUrl}/${this.apiVersion}${path}`;
	}

	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
		query?: Record<string, string | number | undefined>
	): Promise<T> {
		let fullUrl = this.url(path);

		if (query) {
			const params = new URLSearchParams();
			for (const [k, v] of Object.entries(query)) {
				if (v !== undefined) params.set(k, String(v));
			}
			const qs = params.toString();
			if (qs) fullUrl += `?${qs}`;
		}

		const resp = await fetch(fullUrl, {
			method,
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				"Content-Type": "application/json",
			},
			body: body ? JSON.stringify(body) : undefined,
		});

		if (!resp.ok) {
			throw new HonchoApiError(resp.status, await resp.text());
		}

		if (resp.status === 204 || resp.headers.get("content-length") === "0") {
			return undefined as T;
		}

		return (await resp.json()) as T;
	}

	private post<T>(path: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<T> {
		return this.request<T>("POST", path, body, query);
	}

	private put<T>(path: string, body?: unknown): Promise<T> {
		return this.request<T>("PUT", path, body);
	}

	private get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
		return this.request<T>("GET", path, undefined, query);
	}

	private del<T>(path: string): Promise<T> {
		return this.request<T>("DELETE", path);
	}

	// -----------------------------------------------------------------------
	// Health
	// -----------------------------------------------------------------------

	async testConnection(): Promise<boolean> {
		try {
			const resp = await fetch(`${this.baseUrl}/health`, {
				method: "GET",
				headers: { Authorization: `Bearer ${this.apiKey}` },
			});
			return resp.ok;
		} catch {
			return false;
		}
	}

	// -----------------------------------------------------------------------
	// Workspace
	// -----------------------------------------------------------------------

	async getOrCreateWorkspace(id: string): Promise<WorkspaceResponse> {
		return this.post<WorkspaceResponse>("/workspaces", { id });
	}

	// -----------------------------------------------------------------------
	// Peer
	// -----------------------------------------------------------------------

	async getOrCreatePeer(workspaceId: string, id: string, config?: { observe_me?: boolean }): Promise<PeerResponse> {
		return this.post<PeerResponse>(`/workspaces/${workspaceId}/peers`, {
			id,
			configuration: config,
		});
	}

	async getPeerCard(workspaceId: string, peerId: string, target?: string): Promise<PeerCardResponse> {
		return this.get<PeerCardResponse>(
			`/workspaces/${workspaceId}/peers/${peerId}/card`,
			target ? { target } : undefined
		);
	}

	async setPeerCard(workspaceId: string, peerId: string, card: string[]): Promise<PeerCardResponse> {
		return this.put<PeerCardResponse>(
			`/workspaces/${workspaceId}/peers/${peerId}/card`,
			{ peer_card: card }
		);
	}

	async getPeerRepresentation(
		workspaceId: string,
		peerId: string,
		opts?: {
			target?: string;
			search_query?: string;
			search_top_k?: number;
			max_conclusions?: number;
			include_most_frequent?: boolean;
		}
	): Promise<RepresentationResponse> {
		return this.post<RepresentationResponse>(
			`/workspaces/${workspaceId}/peers/${peerId}/representation`,
			opts ?? {}
		);
	}

	async getPeerContext(
		workspaceId: string,
		peerId: string,
		opts?: { target?: string }
	): Promise<PeerContextResponse> {
		return this.get<PeerContextResponse>(
			`/workspaces/${workspaceId}/peers/${peerId}/context`,
			opts
		);
	}

	async peerChat(
		workspaceId: string,
		peerId: string,
		query: string,
		opts?: {
			reasoning_level?: ReasoningLevel;
			target?: string;
			session_id?: string;
		}
	): Promise<PeerChatResponse> {
		return this.post<PeerChatResponse>(
			`/workspaces/${workspaceId}/peers/${peerId}/chat`,
			{
				query,
				stream: false,
				...opts,
			}
		);
	}

	async searchPeer(
		workspaceId: string,
		peerId: string,
		query: string,
		opts?: { top_k?: number; filters?: Record<string, unknown> }
	): Promise<MessageResponse[]> {
		return this.post<MessageResponse[]>(
			`/workspaces/${workspaceId}/peers/${peerId}/search`,
			{ query, ...opts }
		);
	}

	// -----------------------------------------------------------------------
	// Session
	// -----------------------------------------------------------------------

	async getOrCreateSession(
		workspaceId: string,
		id: string,
		peers?: Record<string, SessionPeerConfig>
	): Promise<SessionResponse> {
		return this.post<SessionResponse>(`/workspaces/${workspaceId}/sessions`, {
			id,
			peers,
		});
	}

	async listSessions(
		workspaceId: string,
		filters?: Record<string, unknown>,
		page = 1,
		size = 50
	): Promise<PageResponse<SessionResponse>> {
		return this.post<PageResponse<SessionResponse>>(
			`/workspaces/${workspaceId}/sessions/list`,
			{ filters },
			{ page, size }
		);
	}

	async updateSession(
		workspaceId: string,
		sessionId: string,
		params: {
			metadata?: Record<string, unknown>;
			configuration?: SessionConfiguration;
		}
	): Promise<SessionResponse> {
		return this.put<SessionResponse>(
			`/workspaces/${workspaceId}/sessions/${sessionId}`,
			params
		);
	}

	async deleteSession(workspaceId: string, sessionId: string): Promise<void> {
		await this.del(`/workspaces/${workspaceId}/sessions/${sessionId}`);
	}

	async getSessionSummaries(
		workspaceId: string,
		sessionId: string
	): Promise<SessionSummaryResponse> {
		return this.get<SessionSummaryResponse>(
			`/workspaces/${workspaceId}/sessions/${sessionId}/summaries`
		);
	}

	async getSessionContext(
		workspaceId: string,
		sessionId: string,
		opts?: { token_budget?: number }
	): Promise<SessionContextResponse> {
		return this.get<SessionContextResponse>(
			`/workspaces/${workspaceId}/sessions/${sessionId}/context`,
			opts
		);
	}

	// -----------------------------------------------------------------------
	// Messages
	// -----------------------------------------------------------------------

	async addMessages(
		workspaceId: string,
		sessionId: string,
		messages: Array<{
			peer_id: string;
			content: string;
			metadata?: Record<string, unknown>;
			created_at?: string;
		}>
	): Promise<MessageResponse[]> {
		return this.post<MessageResponse[]>(
			`/workspaces/${workspaceId}/sessions/${sessionId}/messages`,
			{ messages }
		);
	}

	async listMessages(
		workspaceId: string,
		sessionId: string,
		filters?: Record<string, unknown>,
		page = 1,
		size = 50
	): Promise<PageResponse<MessageResponse>> {
		return this.post<PageResponse<MessageResponse>>(
			`/workspaces/${workspaceId}/sessions/${sessionId}/messages/list`,
			{ filters },
			{ page, size }
		);
	}

	// -----------------------------------------------------------------------
	// Conclusions
	// -----------------------------------------------------------------------

	async listConclusions(
		workspaceId: string,
		filters?: Record<string, unknown>,
		page = 1,
		size = 50
	): Promise<PageResponse<ConclusionResponse>> {
		return this.post<PageResponse<ConclusionResponse>>(
			`/workspaces/${workspaceId}/conclusions/list`,
			{ filters },
			{ page, size }
		);
	}

	async queryConclusions(
		workspaceId: string,
		query: string,
		opts?: {
			top_k?: number;
			distance?: number;
			filters?: Record<string, unknown>;
		}
	): Promise<ConclusionResponse[]> {
		return this.post<ConclusionResponse[]>(
			`/workspaces/${workspaceId}/conclusions/query`,
			{ query, ...opts }
		);
	}

	// -----------------------------------------------------------------------
	// Search
	// -----------------------------------------------------------------------

	async searchWorkspace(
		workspaceId: string,
		query: string,
		opts?: { filters?: Record<string, unknown>; limit?: number }
	): Promise<MessageResponse[]> {
		return this.post<MessageResponse[]>(
			`/workspaces/${workspaceId}/search`,
			{ query, ...opts }
		);
	}

	// -----------------------------------------------------------------------
	// Queue
	// -----------------------------------------------------------------------

	async getQueueStatus(
		workspaceId: string,
		opts?: {
			observer_id?: string;
			sender_id?: string;
			session_id?: string;
		}
	): Promise<QueueStatusResponse> {
		return this.get<QueueStatusResponse>(
			`/workspaces/${workspaceId}/queue/status`,
			opts
		);
	}

	// -----------------------------------------------------------------------
	// Dream
	// -----------------------------------------------------------------------

	async scheduleDream(
		workspaceId: string,
		observer: string,
		opts?: {
			observed?: string;
			dream_type?: DreamType;
			session_id?: string;
		}
	): Promise<void> {
		await this.post(
			`/workspaces/${workspaceId}/schedule_dream`,
			{
				observer,
				observed: opts?.observed,
				dream_type: opts?.dream_type ?? "omni",
				session_id: opts?.session_id,
			}
		);
	}
}
