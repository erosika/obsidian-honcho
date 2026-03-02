import { describe, test, expect, mock } from "bun:test";
import { SyncQueue } from "../src/utils/sync-queue";

// Use a very short debounce so tests don't need fake timers.
const FAST_DEBOUNCE = 10; // ms
// Buffer on top of debounce + flush tick (100ms)
const SETTLE = FAST_DEBOUNCE + 200; // ms

function wait(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function makeFile(path: string) {
	return {
		path,
		name: path.split("/").pop() ?? path,
		stat: { mtime: Date.now(), ctime: Date.now(), size: 0 },
	} as unknown as import("obsidian").TFile;
}

function makeApp(opts: {
	resolvedLinks?: Record<string, Record<string, number>>;
	frontmatter?: Record<string, Record<string, unknown>>;
	fileContent?: Record<string, string>;
}) {
	return {
		metadataCache: {
			getFileCache: (file: { path: string }) => ({
				frontmatter: opts.frontmatter?.[file.path],
				tags: [],
			}),
			resolvedLinks: opts.resolvedLinks ?? {},
		},
		vault: {
			cachedRead: async (file: { path: string }) => opts.fileContent?.[file.path] ?? "",
		},
	} as unknown as import("obsidian").App;
}

// ---------------------------------------------------------------------------

describe("SyncQueue.size", () => {
	test("starts at zero", () => {
		const queue = new SyncQueue(makeApp({}), async () => {}, undefined, FAST_DEBOUNCE);
		expect(queue.size).toBe(0);
	});
});

describe("SyncQueue.clear", () => {
	test("resets to zero after enqueue", () => {
		const queue = new SyncQueue(makeApp({}), async () => {}, undefined, FAST_DEBOUNCE);
		queue.enqueue(makeFile("a.md"));
		queue.enqueue(makeFile("b.md"));
		queue.clear();
		expect(queue.size).toBe(0);
	});
});

describe("SyncQueue.remove", () => {
	test("removes a file while it's in the debounce stage", () => {
		const queue = new SyncQueue(makeApp({}), async () => {}, undefined, FAST_DEBOUNCE);
		const file = makeFile("note.md");
		queue.enqueue(file);
		expect(queue.size).toBe(1);
		queue.remove("note.md");
		expect(queue.size).toBe(0);
	});
});

describe("SyncQueue.enqueue + flush", () => {
	test("calls handler once after debounce fires", async () => {
		const handler = mock(async (_file: unknown) => {});
		const app = makeApp({ fileContent: { "note.md": "body" } });
		const queue = new SyncQueue(app, handler, undefined, FAST_DEBOUNCE);

		queue.enqueue(makeFile("note.md"));
		await wait(SETTLE);

		expect(handler).toHaveBeenCalledTimes(1);
	});

	test("debounces rapid re-enqueues — handler called once", async () => {
		const handler = mock(async (_file: unknown) => {});
		const app = makeApp({ fileContent: { "note.md": "body" } });
		const queue = new SyncQueue(app, handler, undefined, FAST_DEBOUNCE);

		queue.enqueue(makeFile("note.md"));
		queue.enqueue(makeFile("note.md"));
		queue.enqueue(makeFile("note.md"));

		await wait(SETTLE);

		expect(handler).toHaveBeenCalledTimes(1);
	});

	test("processes multiple distinct files", async () => {
		const handler = mock(async (_file: unknown) => {});
		const app = makeApp({
			fileContent: { "a.md": "body a", "b.md": "body b", "c.md": "body c" },
		});
		const queue = new SyncQueue(app, handler, undefined, FAST_DEBOUNCE);

		queue.enqueue(makeFile("a.md"));
		queue.enqueue(makeFile("b.md"));
		queue.enqueue(makeFile("c.md"));

		await wait(SETTLE);

		expect(handler).toHaveBeenCalledTimes(3);
	});

	test("skips file within minSyncInterval after it was just synced", async () => {
		const handler = mock(async (_file: unknown) => {});
		const app = makeApp({ fileContent: { "note.md": "body" } });
		// Large min interval — file should be skipped on second enqueue.
		const queue = new SyncQueue(app, handler, 60_000, FAST_DEBOUNCE);
		const file = makeFile("note.md");

		// First sync
		queue.enqueue(file);
		await wait(SETTLE);
		expect(handler).toHaveBeenCalledTimes(1);

		// Second enqueue within minSyncInterval — should be ignored
		queue.enqueue(file);
		await wait(SETTLE);
		expect(handler).toHaveBeenCalledTimes(1);
	});

	test("skips file whose content hash matches stored hash", async () => {
		const { computeContentHash } = await import("../src/utils/sync-status");
		const body = "unchanged body";
		const hash = computeContentHash(body);

		const handler = mock(async (_file: unknown) => {});
		const app = makeApp({
			fileContent: { "note.md": `---\nhash: ${hash}\n---\n${body}` },
			frontmatter: { "note.md": { hash, synced: "2024-01-01" } },
		});
		// Disable min sync interval so it's only the hash check that skips
		const queue = new SyncQueue(app, handler, 0, FAST_DEBOUNCE);

		queue.enqueue(makeFile("note.md"));
		await wait(SETTLE);

		expect(handler).toHaveBeenCalledTimes(0);
	});
});

describe("SyncQueue retry", () => {
	test("retries failed handler up to 2 times then drops", async () => {
		let callCount = 0;
		const handler = mock(async () => {
			callCount++;
			throw new Error("fail");
		});
		const app = makeApp({ fileContent: { "note.md": "body" } });
		const queue = new SyncQueue(app, handler, 0, FAST_DEBOUNCE);

		queue.enqueue(makeFile("note.md"));

		// Each retry goes back into pending and needs another flush cycle.
		// Allow enough time for 3 flush cycles (initial + 2 retries).
		await wait(SETTLE * 5);

		// 1 initial attempt + 2 retries = 3 total
		expect(callCount).toBe(3);
	});
});

describe("SyncQueue priority", () => {
	test("processes higher-backlink file before lower-backlink file", async () => {
		const order: string[] = [];
		const handler = mock(async (file: { path: string }) => {
			order.push(file.path);
		});

		const app = makeApp({
			fileContent: { "popular.md": "body", "obscure.md": "body" },
			resolvedLinks: {
				"other1.md": { "popular.md": 1 },
				"other2.md": { "popular.md": 1 },
				"other3.md": { "popular.md": 1 },
			},
			// Both already synced — no new-file bonus to skew priority
			frontmatter: {
				"popular.md": { synced: "2024-01-01" },
				"obscure.md": { synced: "2024-01-01" },
			},
		});

		const queue = new SyncQueue(app, handler, 0, FAST_DEBOUNCE);
		queue.enqueue(makeFile("obscure.md"));
		queue.enqueue(makeFile("popular.md"));

		await wait(SETTLE);

		// popular has 3 backlinks → higher priority → should be first
		expect(order[0]).toBe("popular.md");
	});
});
