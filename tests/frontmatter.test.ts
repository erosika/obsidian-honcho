import { describe, test, expect } from "bun:test";
import { normalizeFrontmatterTags, matchesSyncFilters, readHonchoFrontmatter } from "../src/utils/frontmatter";

// ---------------------------------------------------------------------------
// Minimal App / TFile stubs
// ---------------------------------------------------------------------------

function makeFile(path: string, mtime = Date.now()) {
	return {
		path,
		name: path.split("/").pop() ?? path,
		stat: { mtime, ctime: mtime, size: 0 },
	} as unknown as import("obsidian").TFile;
}

function makeApp(opts: {
	frontmatter?: Record<string, unknown>;
	tags?: Array<{ tag: string; position: unknown }>;
	resolvedLinks?: Record<string, Record<string, number>>;
}) {
	return {
		metadataCache: {
			getFileCache: (_file: unknown) => ({
				frontmatter: opts.frontmatter,
				tags: opts.tags ?? [],
			}),
			resolvedLinks: opts.resolvedLinks ?? {},
		},
	} as unknown as import("obsidian").App;
}

// ---------------------------------------------------------------------------
// normalizeFrontmatterTags
// ---------------------------------------------------------------------------

describe("normalizeFrontmatterTags", () => {
	test("returns array when input is an array", () => {
		expect(normalizeFrontmatterTags(["foo", "bar"])).toEqual(["foo", "bar"]);
	});

	test("wraps a plain string in an array", () => {
		expect(normalizeFrontmatterTags("single")).toEqual(["single"]);
	});

	test("returns empty array for null", () => {
		expect(normalizeFrontmatterTags(null)).toEqual([]);
	});

	test("returns empty array for undefined", () => {
		expect(normalizeFrontmatterTags(undefined)).toEqual([]);
	});

	test("returns empty array for a number", () => {
		expect(normalizeFrontmatterTags(42)).toEqual([]);
	});

	test("coerces array elements to strings", () => {
		expect(normalizeFrontmatterTags([1, true, "tag"])).toEqual(["1", "true", "tag"]);
	});
});

// ---------------------------------------------------------------------------
// readHonchoFrontmatter
// ---------------------------------------------------------------------------

describe("readHonchoFrontmatter", () => {
	test("reads new keys", () => {
		const app = makeApp({
			frontmatter: { synced: "2024-01-01", session: "s1", hash: "abc12345", feedback: true },
		});
		const result = readHonchoFrontmatter(app, makeFile("note.md"));
		expect(result).toEqual({ synced: "2024-01-01", session: "s1", hash: "abc12345", feedback: true });
	});

	test("falls back to legacy honcho_* keys", () => {
		const app = makeApp({
			frontmatter: {
				honcho_synced: "2023-06-01",
				honcho_session_id: "legacy-session",
				honcho_content_hash: "deadbeef",
				honcho_feedback: false,
			},
		});
		const result = readHonchoFrontmatter(app, makeFile("note.md"));
		expect(result.synced).toBe("2023-06-01");
		expect(result.session).toBe("legacy-session");
		expect(result.hash).toBe("deadbeef");
		expect(result.feedback).toBe(false);
	});

	test("new keys take precedence over legacy keys", () => {
		const app = makeApp({
			frontmatter: {
				synced: "2024-01-01",
				honcho_synced: "2020-01-01",
			},
		});
		expect(readHonchoFrontmatter(app, makeFile("note.md")).synced).toBe("2024-01-01");
	});

	test("returns empty object when no frontmatter", () => {
		const app = makeApp({ frontmatter: undefined });
		expect(readHonchoFrontmatter(app, makeFile("note.md"))).toEqual({});
	});

	test("feedback is undefined when neither key is a boolean", () => {
		const app = makeApp({ frontmatter: { feedback: "yes" } });
		expect(readHonchoFrontmatter(app, makeFile("note.md")).feedback).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// matchesSyncFilters
// ---------------------------------------------------------------------------

describe("matchesSyncFilters", () => {
	test("matches everything when both filters are empty", () => {
		const app = makeApp({});
		expect(matchesSyncFilters(app, makeFile("notes/foo.md"), [], [])).toBe(true);
	});

	test("matches by folder prefix", () => {
		const app = makeApp({});
		const file = makeFile("journal/2024-01-01.md");
		expect(matchesSyncFilters(app, file, [], ["journal"])).toBe(true);
	});

	test("does not match file outside folder filter", () => {
		const app = makeApp({});
		const file = makeFile("work/meeting.md");
		expect(matchesSyncFilters(app, file, [], ["personal"])).toBe(false);
	});

	test("strips trailing slash from folder filter", () => {
		const app = makeApp({});
		const file = makeFile("journal/entry.md");
		expect(matchesSyncFilters(app, file, [], ["journal/"])).toBe(true);
	});

	test("matches by inline tag (with # prefix)", () => {
		const app = makeApp({ tags: [{ tag: "#honcho", position: null }] });
		const file = makeFile("note.md");
		expect(matchesSyncFilters(app, file, ["#honcho"], [])).toBe(true);
	});

	test("matches by inline tag (without # prefix in filter)", () => {
		const app = makeApp({ tags: [{ tag: "#honcho", position: null }] });
		const file = makeFile("note.md");
		expect(matchesSyncFilters(app, file, ["honcho"], [])).toBe(true);
	});

	test("matches by frontmatter tag", () => {
		const app = makeApp({ frontmatter: { tags: ["honcho", "journal"] } });
		const file = makeFile("note.md");
		expect(matchesSyncFilters(app, file, ["honcho"], [])).toBe(true);
	});

	test("tag matching is case-insensitive", () => {
		const app = makeApp({ tags: [{ tag: "#Honcho", position: null }] });
		const file = makeFile("note.md");
		expect(matchesSyncFilters(app, file, ["honcho"], [])).toBe(true);
	});

	test("does not match when tag filter set but no matching tags", () => {
		const app = makeApp({ tags: [{ tag: "#other", position: null }] });
		const file = makeFile("note.md");
		expect(matchesSyncFilters(app, file, ["honcho"], [])).toBe(false);
	});

	test("matches if either folder OR tag matches", () => {
		// File is in wrong folder but has matching tag
		const app = makeApp({ tags: [{ tag: "#honcho", position: null }] });
		const file = makeFile("anywhere/note.md");
		expect(matchesSyncFilters(app, file, ["honcho"], ["journal"])).toBe(true);
	});
});
