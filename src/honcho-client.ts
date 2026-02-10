import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";

// ---------------------------------------------------------------------------
// Types
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

export type ReasoningLevel = "minimal" | "low" | "medium" | "high" | "max";

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

		const req: RequestUrlParam = {
			url: fullUrl,
			method,
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				"Content-Type": "application/json",
			},
			body: body ? JSON.stringify(body) : undefined,
		};

		const resp: RequestUrlResponse = await requestUrl(req);

		if (resp.status >= 400) {
			throw new Error(
				`Honcho API error ${resp.status}: ${resp.text}`
			);
		}

		return resp.json as T;
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
			const resp = await requestUrl({
				url: `${this.baseUrl}/health`,
				method: "GET",
				headers: { Authorization: `Bearer ${this.apiKey}` },
			});
			return resp.status >= 200 && resp.status < 300;
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
		return this.post<PeerCardResponse>(
			`/workspaces/${workspaceId}/peers/${peerId}/card`,
			{ target }
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
		return this.post<PeerContextResponse>(
			`/workspaces/${workspaceId}/peers/${peerId}/context`,
			opts ?? {}
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

	// -----------------------------------------------------------------------
	// Session
	// -----------------------------------------------------------------------

	async getOrCreateSession(
		workspaceId: string,
		id: string,
		peers?: Record<string, { observe_me?: boolean; observe_others?: boolean }>
	): Promise<SessionResponse> {
		return this.post<SessionResponse>(`/workspaces/${workspaceId}/sessions`, {
			id,
			peers,
		});
	}

	// -----------------------------------------------------------------------
	// Messages
	// -----------------------------------------------------------------------

	async addMessages(
		workspaceId: string,
		sessionId: string,
		messages: Array<{ peer_id: string; content: string; metadata?: Record<string, unknown> }>
	): Promise<MessageResponse[]> {
		return this.post<MessageResponse[]>(
			`/workspaces/${workspaceId}/sessions/${sessionId}/messages`,
			{ messages }
		);
	}

	// -----------------------------------------------------------------------
	// Conclusions
	// -----------------------------------------------------------------------

	async createConclusions(
		workspaceId: string,
		conclusions: Array<{
			content: string;
			observer_id: string;
			observed_id: string;
			session_id: string | null;
		}>
	): Promise<ConclusionResponse[]> {
		return this.post<ConclusionResponse[]>(
			`/workspaces/${workspaceId}/conclusions`,
			{ conclusions }
		);
	}

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

	async deleteConclusion(workspaceId: string, conclusionId: string): Promise<void> {
		await this.del(`/workspaces/${workspaceId}/conclusions/${conclusionId}`);
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

	async searchConclusions(
		workspaceId: string,
		query: string,
		opts?: { top_k?: number; filters?: Record<string, unknown> }
	): Promise<ConclusionResponse[]> {
		return this.post<ConclusionResponse[]>(
			`/workspaces/${workspaceId}/conclusions/query`,
			{ query, ...opts }
		);
	}
}
