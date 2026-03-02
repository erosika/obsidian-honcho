import { describe, test, expect } from "bun:test";
import {
	computeContentHash,
	stripFrontmatter,
	stripHonchoSection,
	stripForIngestion,
	generateTurnId,
} from "../src/utils/sync-status";

describe("computeContentHash", () => {
	test("returns 8 hex characters", () => {
		const hash = computeContentHash("hello world");
		expect(hash).toMatch(/^[0-9a-f]{8}$/);
	});

	test("is deterministic", () => {
		expect(computeContentHash("abc")).toBe(computeContentHash("abc"));
	});

	test("differs for different inputs", () => {
		expect(computeContentHash("abc")).not.toBe(computeContentHash("abd"));
	});

	test("handles empty string", () => {
		const hash = computeContentHash("");
		expect(hash).toMatch(/^[0-9a-f]{8}$/);
	});

	test("handles unicode", () => {
		const hash = computeContentHash("日本語テスト");
		expect(hash).toMatch(/^[0-9a-f]{8}$/);
	});
});

describe("stripFrontmatter", () => {
	test("removes YAML frontmatter block", () => {
		const input = "---\ntitle: Test\ndate: 2024-01-01\n---\n# Body";
		expect(stripFrontmatter(input)).toBe("# Body");
	});

	test("leaves content without frontmatter untouched", () => {
		const input = "# Just a heading\n\nsome text";
		expect(stripFrontmatter(input)).toBe(input);
	});

	test("handles frontmatter with trailing newlines", () => {
		// \n* in the regex strips all newlines after ---, so both \n chars are consumed.
		const input = "---\ntags: [foo]\n---\n\nParagraph";
		expect(stripFrontmatter(input)).toBe("Paragraph");
	});

	test("handles empty frontmatter", () => {
		const input = "---\n---\nBody";
		expect(stripFrontmatter(input)).toBe("Body");
	});

	test("does not strip mid-document ---", () => {
		const input = "# Heading\n\n---\n\nHorizontal rule";
		expect(stripFrontmatter(input)).toBe(input);
	});
});

describe("stripHonchoSection", () => {
	test("removes ## Honcho section and everything after", () => {
		// Regex matches \n## Honcho — with \n\n before, one \n stays in the output.
		// Use single \n before ## Honcho so nothing is left over.
		const input = "# Note\n\nSome content.\n## Honcho\n\nHoncho output here.";
		expect(stripHonchoSection(input)).toBe("# Note\n\nSome content.");
	});

	test("leaves content without Honcho section untouched", () => {
		const input = "# Note\n\nRegular content.";
		expect(stripHonchoSection(input)).toBe(input);
	});

	test("handles Honcho section at start of line (requires preceding newline)", () => {
		const input = "Body\n## Honcho\nextra";
		expect(stripHonchoSection(input)).toBe("Body");
	});

	test("does not strip inline ## Honcho", () => {
		// Without a leading newline, HONCHO_SECTION_RE won't match
		const input = "## Honcho at start";
		expect(stripHonchoSection(input)).toBe(input);
	});
});

describe("stripForIngestion", () => {
	test("strips both frontmatter and Honcho section", () => {
		// No blank line between body and ## Honcho so no trailing \n after strip.
		const input = [
			"---",
			"title: Test",
			"synced: 2024-01-01",
			"---",
			"",
			"Note body.",
			"## Honcho",
			"",
			"AI output",
		].join("\n");

		// stripFrontmatter consumes both newlines after ---; stripHonchoSection
		// removes \n## Honcho... leaving just "Note body."
		expect(stripForIngestion(input)).toBe("Note body.");
	});

	test("is stable: stripping twice equals stripping once", () => {
		const input = "---\nfoo: bar\n---\nBody\n## Honcho\noutput";
		expect(stripForIngestion(stripForIngestion(input))).toBe(stripForIngestion(input));
	});
});

describe("generateTurnId", () => {
	test("returns 8 hex characters", () => {
		const id = generateTurnId("session-123");
		expect(id).toMatch(/^[0-9a-f]{8}$/);
	});

	test("produces different IDs for different sessions (usually)", () => {
		// Two calls with different sessions are almost certainly different
		const a = generateTurnId("session-aaa");
		const b = generateTurnId("session-bbb");
		expect(a).not.toBe(b);
	});

	test("two calls at the same millisecond can match — that's fine, just check format", () => {
		// Both just need to be valid
		const id = generateTurnId("s");
		expect(id).toMatch(/^[0-9a-f]{8}$/);
	});
});
