import { describe, test, expect, beforeEach, mock } from "bun:test";

// requestUrl is mocked in setup.ts preload; import here to control it per test.
import { requestUrl } from "obsidian";
import { HonchoClient } from "../src/honcho-client";

const mockRequestUrl = requestUrl as ReturnType<typeof mock>;

function makeClient() {
	return new HonchoClient({
		apiKey: "test-key",
		baseUrl: "https://api.honcho.dev",
		apiVersion: "v3",
	});
}

beforeEach(() => {
	mockRequestUrl.mockClear();
});

describe("HonchoClient URL construction", () => {
	test("strips trailing slash from baseUrl", () => {
		const client = new HonchoClient({
			apiKey: "k",
			baseUrl: "https://api.honcho.dev/",
			apiVersion: "v3",
		});
		// Fire a request so we can inspect the URL passed to requestUrl
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { id: "ws1" }, text: "" });
		void client.getOrCreateWorkspace("ws1");
		const call = mockRequestUrl.mock.calls[0]?.[0] as { url: string };
		expect(call.url).toBe("https://api.honcho.dev/v3/workspaces");
	});

	test("builds correct URL for nested resources", async () => {
		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			json: { id: "p1", workspace_id: "ws1", metadata: {}, configuration: {}, created_at: "" },
			text: "",
		});
		await makeClient().getOrCreatePeer("ws1", "p1");
		const call = mockRequestUrl.mock.calls[0]?.[0] as { url: string };
		expect(call.url).toBe("https://api.honcho.dev/v3/workspaces/ws1/peers");
	});
});

describe("HonchoClient request headers", () => {
	test("sets Bearer auth header", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: {}, text: "" });
		await makeClient().getOrCreateWorkspace("ws1");
		const call = mockRequestUrl.mock.calls[0]?.[0] as { headers: Record<string, string> };
		expect(call.headers["Authorization"]).toBe("Bearer test-key");
	});

	test("sets Content-Type header", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: {}, text: "" });
		await makeClient().getOrCreateWorkspace("ws1");
		const call = mockRequestUrl.mock.calls[0]?.[0] as { headers: Record<string, string> };
		expect(call.headers["Content-Type"]).toBe("application/json");
	});
});

describe("HonchoClient query strings", () => {
	test("appends page and size as query params", async () => {
		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			json: { items: [], page: 1, size: 50, total: 0, pages: 0 },
			text: "",
		});
		await makeClient().listSessions("ws1", {}, 2, 25);
		const call = mockRequestUrl.mock.calls[0]?.[0] as { url: string };
		expect(call.url).toContain("page=2");
		expect(call.url).toContain("size=25");
	});
});

describe("HonchoClient error handling", () => {
	test("throws immediately on non-retryable 400 error", async () => {
		mockRequestUrl.mockResolvedValue({ status: 400, json: null, text: "Bad Request" });
		await expect(makeClient().getOrCreateWorkspace("ws1")).rejects.toThrow("400");
		// Should have only tried once (no retries for 4xx)
		expect(mockRequestUrl.mock.calls.length).toBe(1);
	});

	test("retries on 500 errors", async () => {
		// Fail twice then succeed
		mockRequestUrl
			.mockResolvedValueOnce({ status: 500, json: null, text: "Server Error" })
			.mockResolvedValueOnce({ status: 500, json: null, text: "Server Error" })
			.mockResolvedValueOnce({ status: 200, json: { id: "ws1" }, text: "" });

		// HonchoClient has exponential backoff — we override sleep by mocking timers.
		// For simplicity, just verify it succeeds after retries.
		const result = await makeClient().getOrCreateWorkspace("ws1");
		expect((result as { id: string }).id).toBe("ws1");
		expect(mockRequestUrl.mock.calls.length).toBe(3);
	}, 30000); // allow time for backoff

	test("throws after exhausting all retries", async () => {
		mockRequestUrl.mockResolvedValue({ status: 503, json: null, text: "Unavailable" });
		await expect(makeClient().getOrCreateWorkspace("ws1")).rejects.toThrow();
		// 1 initial + 3 retries = 4 total attempts
		expect(mockRequestUrl.mock.calls.length).toBe(4);
	}, 30000);
});

describe("HonchoClient methods", () => {
	test("getOrCreateWorkspace sends workspace id in body", async () => {
		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			json: { id: "my-ws", metadata: {}, configuration: {}, created_at: "" },
			text: "",
		});
		await makeClient().getOrCreateWorkspace("my-ws");
		const call = mockRequestUrl.mock.calls[0]?.[0] as { body: string };
		expect(JSON.parse(call.body)).toEqual({ id: "my-ws" });
	});

	test("addMessages sends messages array", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: [], text: "" });
		const msgs = [{ peer_id: "p1", content: "hello" }];
		await makeClient().addMessages("ws1", "session1", msgs);
		const call = mockRequestUrl.mock.calls[0]?.[0] as { body: string; url: string };
		expect(JSON.parse(call.body)).toEqual({ messages: msgs });
		expect(call.url).toContain("/sessions/session1/messages");
	});

	test("deleteSession uses DELETE method", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: {}, text: "" });
		await makeClient().deleteSession("ws1", "s1");
		const call = mockRequestUrl.mock.calls[0]?.[0] as { method: string };
		expect(call.method).toBe("DELETE");
	});
});
