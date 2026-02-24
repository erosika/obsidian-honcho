import { type App, type TFile } from "obsidian";
import type { HonchoClient, ConclusionResponse } from "../honcho-client";
import { readHonchoFrontmatter } from "../utils/frontmatter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeedbackContext {
	app: App;
	client: HonchoClient;
	workspaceId: string;
	peerId: string;
	feedbackEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Resolution: should feedback be written for this file?
// ---------------------------------------------------------------------------

const HONCHO_SECTION_RE = /\n## Honcho\n[\s\S]*$/;

/**
 * Determine whether feedback should be written for a given file.
 *
 * - `honcho_feedback: false` in frontmatter  -> disabled (even if global on)
 * - `honcho_feedback: true`  in frontmatter  -> enabled  (even if global off)
 * - Absent                                    -> falls through to global setting
 * - `honcho_generated` in frontmatter         -> always skip (plugin-created notes)
 */
export function isFeedbackEnabled(
	app: App,
	file: TFile,
	globalEnabled: boolean
): boolean {
	const cache = app.metadataCache.getFileCache(file);
	const fm = cache?.frontmatter;

	// Never write feedback into plugin-generated notes
	if (fm?.honcho_generated) return false;

	const honchoFm = readHonchoFrontmatter(app, file);

	// Per-note override
	if (honchoFm.feedback === false) return false;
	if (honchoFm.feedback === true) return true;

	return globalEnabled;
}

/**
 * Check whether the existing ## Honcho section is stale (older than 1 hour).
 * Returns true if the section is missing or its timestamp is older than 1 hour.
 */
export function isFeedbackStale(content: string): boolean {
	const match = content.match(HONCHO_SECTION_RE);
	if (!match) return true;

	const tsMatch = match[0].match(/\*Last updated: (.+)\*/);
	if (!tsMatch) return true;

	const updated = new Date(tsMatch[1]).getTime();
	if (isNaN(updated)) return true;

	return Date.now() - updated > 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Conclusion fetching
// ---------------------------------------------------------------------------

/**
 * Fetch conclusions relevant to a note.
 * First tries session-scoped listing, then falls back to semantic search.
 */
async function fetchConclusions(
	ctx: FeedbackContext,
	file: TFile
): Promise<ConclusionResponse[]> {
	const fm = readHonchoFrontmatter(ctx.app, file);

	// Try session-scoped conclusions first
	if (fm.session) {
		const resp = await ctx.client.listConclusions(
			ctx.workspaceId,
			{ session_id: fm.session },
			1,
			20
		);
		if (resp.items.length > 0) return resp.items;
	}

	// Fall back to semantic search by note title
	const results = await ctx.client.queryConclusions(
		ctx.workspaceId,
		file.basename,
		{ top_k: 10 }
	);
	return results;
}

// ---------------------------------------------------------------------------
// Section formatting
// ---------------------------------------------------------------------------

function formatFeedbackSection(conclusions: ConclusionResponse[]): string {
	const lines: string[] = ["", "## Honcho", ""];

	if (conclusions.length === 0) {
		lines.push("*No conclusions yet.*");
	} else {
		// First conclusion as blockquote
		lines.push(`> ${conclusions[0].content}`);

		// Rest as list items
		for (let i = 1; i < conclusions.length; i++) {
			lines.push(`- ${conclusions[i].content}`);
		}
	}

	lines.push("");
	lines.push(`*Last updated: ${new Date().toISOString()}*`);
	lines.push("");

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

/**
 * Fetch conclusions and write the ## Honcho section into a note.
 * Uses `vault.process` for atomic read-transform-write.
 *
 * @param guardSet  The writingFeedbackPaths set from main.ts -- the caller
 *                  must add/remove the path to prevent re-entrant modify events.
 */
export async function writeFeedback(
	ctx: FeedbackContext,
	file: TFile,
	guardSet: Set<string>
): Promise<boolean> {
	const conclusions = await fetchConclusions(ctx, file);

	guardSet.add(file.path);
	try {
		await ctx.app.vault.process(file, (content) => {
			const stripped = content.replace(HONCHO_SECTION_RE, "");
			return stripped + formatFeedbackSection(conclusions);
		});
	} finally {
		// Delayed cleanup so the async modify event fires while guard is still active
		setTimeout(() => guardSet.delete(file.path), 1000);
	}

	return conclusions.length > 0;
}

export function createFeedbackContext(
	app: App,
	client: HonchoClient,
	workspaceId: string,
	peerId: string,
	feedbackEnabled: boolean
): FeedbackContext {
	return { app, client, workspaceId, peerId, feedbackEnabled };
}
