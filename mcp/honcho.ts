/**
 * Honcho API service for the Obsidian-Honcho MCP server.
 *
 * Single-peer model: one peer who sends messages and gets
 * observed. Aligns with the plugin's collapsed peer architecture.
 *
 * Lazy initialization: workspace + peer created on first Honcho tool use.
 * Uses native fetch (not Obsidian's requestUrl).
 */

// ---------------------------------------------------------------------------
// Response types
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
	metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface HonchoServiceConfig {
	apiKey: string;
	baseUrl: string;
	apiVersion: string;
	workspace: string;
	peer: string;
}

export class HonchoService {
	private apiKey: string;
	private baseUrl: string;
	private apiVersion: string;
	readonly workspace: string;
	readonly peer: string;
	private initialized = false;

	constructor(config: HonchoServiceConfig) {
		this.apiKey = config.apiKey;
		this.baseUrl = config.baseUrl.replace(/\/+$/, "");
		this.apiVersion = config.apiVersion;
		this.workspace = config.workspace;
		this.peer = config.peer;
	}

	// -----------------------------------------------------------------------
	// HTTP layer
	// -----------------------------------------------------------------------

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
			throw new Error(`Honcho API ${resp.status}: ${await resp.text()}`);
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

	// -----------------------------------------------------------------------
	// Lazy initialization
	// -----------------------------------------------------------------------

	/**
	 * Ensure workspace and peer exist. Called once on first Honcho tool use.
	 * Single peer model: one peer with observe_me: true.
	 */
	async ensureInitialized(): Promise<void> {
		if (this.initialized) return;

		await this.post("/workspaces", { id: this.workspace });
		await this.post(`/workspaces/${this.workspace}/peers`, {
			id: this.peer,
			configuration: { observe_me: true },
		});

		this.initialized = true;
	}

	// -----------------------------------------------------------------------
	// Sessions
	// -----------------------------------------------------------------------

	async listSessions(
		filters?: Record<string, unknown>,
		page = 1,
		size = 50
	): Promise<PageResponse<SessionResponse>> {
		return this.post<PageResponse<SessionResponse>>(
			`/workspaces/${this.workspace}/sessions/list`,
			{ filters },
			{ page, size }
		);
	}

	// -----------------------------------------------------------------------
	// Conclusions
	// -----------------------------------------------------------------------

	async queryConclusions(
		query: string,
		opts?: { top_k?: number; filters?: Record<string, unknown> }
	): Promise<ConclusionResponse[]> {
		return this.post<ConclusionResponse[]>(
			`/workspaces/${this.workspace}/conclusions/query`,
			{ query, ...opts }
		);
	}

	async listConclusions(
		filters?: Record<string, unknown>,
		page = 1,
		size = 50
	): Promise<PageResponse<ConclusionResponse>> {
		return this.post<PageResponse<ConclusionResponse>>(
			`/workspaces/${this.workspace}/conclusions/list`,
			{ filters },
			{ page, size }
		);
	}

	// -----------------------------------------------------------------------
	// Representation
	// -----------------------------------------------------------------------

	async getPeerRepresentation(
		opts?: { search_query?: string; search_top_k?: number }
	): Promise<RepresentationResponse> {
		return this.post<RepresentationResponse>(
			`/workspaces/${this.workspace}/peers/${this.peer}/representation`,
			opts ?? {}
		);
	}

	// -----------------------------------------------------------------------
	// Chat (peerChat)
	// -----------------------------------------------------------------------

	/**
	 * Send a message to peerChat on the obsidian workspace.
	 * Uses an existing session (from ingestion) so Honcho has full note context.
	 */
	async peerChat(
		sessionId: string,
		message: string
	): Promise<ChatResponse> {
		return this.post<ChatResponse>(
			`/workspaces/${this.workspace}/peers/${this.peer}/chat`,
			{
				session_id: sessionId,
				messages: [{ role: "user", content: message }],
			}
		);
	}

	// -----------------------------------------------------------------------
	// Queue
	// -----------------------------------------------------------------------

	async getQueueStatus(): Promise<QueueStatusResponse> {
		return this.get<QueueStatusResponse>(
			`/workspaces/${this.workspace}/queue/status`,
			{ peer_id: this.peer }
		);
	}

	// -----------------------------------------------------------------------
	// Dream
	// -----------------------------------------------------------------------

	async scheduleDream(opts?: { session_id?: string }): Promise<void> {
		await this.post(
			`/workspaces/${this.workspace}/schedule_dream`,
			{
				observer: this.peer,
				observed: this.peer,
				dream_type: "omni",
				session_id: opts?.session_id,
			}
		);
	}
}
