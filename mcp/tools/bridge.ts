/**
 * Bridge tools -- obsidian workspace specific Honcho operations.
 *
 * These tools combine vault access with Honcho's obsidian workspace
 * intelligence. The generic Honcho MCP (mcp.honcho.dev) operates on
 * the Claude Code session; these operate on the obsidian workspace
 * where ingested vault content lives.
 *
 * vault_classify: peerChat-based tag/metadata suggestions
 * vault_reflect:  conclusions + representation for a specific note
 * vault_status:   obsidian workspace coverage and queue state
 */

import { execObsidian, execParallel, getResult, parseLines } from "../api.ts";
import type { HonchoService } from "../honcho.ts";
import { ToolInputError, type VaultClassifyInput, type VaultReflectInput } from "../types.ts";

// ---------------------------------------------------------------------------
// vault_classify
// ---------------------------------------------------------------------------

/**
 * Read a note's content and metadata, then ask Honcho's obsidian workspace
 * peerChat to suggest tags, title improvements, and connections based on
 * accumulated vault knowledge.
 */
export async function vaultClassify(
	input: VaultClassifyInput,
	honcho: HonchoService
): Promise<string> {
	if (!input.file) throw new ToolInputError("file is required");
	const file = input.file;
	const scope = input.scope ?? "tags";

	// Read note content + metadata in parallel
	const results = await execParallel([
		{ key: "content", fn: () => execObsidian("read", { [`file=${file}`]: true }) },
		{ key: "tags", fn: () => execObsidian("tags", { [`file=${file}`]: true }) },
		{ key: "properties", fn: () => execObsidian("properties", { [`file=${file}`]: true, "format=yaml": true }) },
		{ key: "backlinks", fn: () => execObsidian("backlinks", { [`file=${file}`]: true }) },
		{ key: "links", fn: () => execObsidian("links", { [`file=${file}`]: true }) },
	]);

	const content = getResult(results, "content", "");
	if (!content.trim()) return `${file}: empty or unreadable`;

	const currentTags = parseLines(getResult(results, "tags", ""));
	const backlinks = parseLines(getResult(results, "backlinks", ""));
	const links = parseLines(getResult(results, "links", ""));
	const properties = getResult(results, "properties", "");

	// Build the session ID matching the plugin's format
	const slug = file
		.replace(/\.md$/, "")
		.replace(/[^a-zA-Z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const sessionId = `obsidian-file-${slug}`;

	// Build the classification prompt
	const promptParts: string[] = [];

	if (scope === "tags" || scope === "full") {
		promptParts.push(
			"Based on this note's content and what you know about the user from their vault,",
			"suggest appropriate tags for categorization.",
			currentTags.length > 0
				? `Current tags: ${currentTags.join(", ")}. Suggest additions or replacements.`
				: "This note has no tags yet.",
			""
		);
	}

	if (scope === "title" || scope === "full") {
		promptParts.push(
			"Suggest a clear, descriptive title for this note if the current one could be improved.",
			`Current title: ${file.replace(/\.md$/, "")}`,
			""
		);
	}

	if (scope === "connections" || scope === "full") {
		promptParts.push(
			"Based on this note's content and other vault notes you've seen,",
			"suggest connections (wikilinks) to other notes that would be relevant.",
			links.length > 0 ? `Current outgoing links: ${links.join(", ")}` : "No outgoing links.",
			backlinks.length > 0 ? `Referenced by: ${backlinks.join(", ")}` : "No backlinks.",
			""
		);
	}

	promptParts.push(
		"Respond with concrete suggestions only. Be specific. Use the user's vocabulary",
		"and organizational patterns from their other notes.",
		"",
		"Note content:",
		"---",
		content.slice(0, 4000), // Limit to avoid token overflow
	);

	const prompt = promptParts.join("\n");

	try {
		const response = await honcho.peerChat(sessionId, prompt);
		const parts: string[] = [`## Classification: ${file}`];
		parts.push("");
		parts.push(response.content);

		if (currentTags.length > 0) {
			parts.push("");
			parts.push(`*Current tags: ${currentTags.join(", ")}*`);
		}
		if (properties) {
			parts.push("");
			parts.push("*Current properties:*");
			parts.push(properties);
		}

		return parts.join("\n");
	} catch (err) {
		// If session doesn't exist (note not ingested), fall back to a note
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("404") || message.includes("not found")) {
			return `${file}: not yet ingested into Honcho. Ingest the note first via the Obsidian plugin, then classify.`;
		}
		throw err;
	}
}

// ---------------------------------------------------------------------------
// vault_reflect
// ---------------------------------------------------------------------------

/**
 * Get Honcho's obsidian workspace perspective on a specific note:
 * session-scoped conclusions, semantic search conclusions, and
 * a representation focused on the note's content.
 */
export async function vaultReflect(
	input: VaultReflectInput,
	honcho: HonchoService
): Promise<string> {
	if (!input.file) throw new ToolInputError("file is required");
	const file = input.file;

	// Build the session ID matching the plugin's format
	const slug = file
		.replace(/\.md$/, "")
		.replace(/[^a-zA-Z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const sessionId = `obsidian-file-${slug}`;

	// Get note tags for search context
	let noteTags: string[] = [];
	try {
		const raw = await execObsidian("tags", { [`file=${file}`]: true });
		noteTags = parseLines(raw);
	} catch {
		// Tags are optional context
	}

	// 3 Honcho calls in parallel
	const honchoResults = await execParallel([
		{
			key: "session_conclusions",
			fn: async () => {
				const resp = await honcho.listConclusions(
					{ session_id: sessionId },
					1,
					20
				);
				return resp.items.map((c) => `- ${c.content}`).join("\n");
			},
		},
		{
			key: "semantic_conclusions",
			fn: async () => {
				const searchQuery = [file.replace(/\.md$/, ""), ...noteTags.slice(0, 3)].join(" ");
				const results = await honcho.queryConclusions(searchQuery, { top_k: 10 });
				return results.map((c) => `- ${c.content}`).join("\n");
			},
		},
		{
			key: "representation",
			fn: async () => {
				const searchQuery = [file.replace(/\.md$/, ""), ...noteTags.slice(0, 3)].join(" ");
				const resp = await honcho.getPeerRepresentation({ search_query: searchQuery });
				return resp.representation || "";
			},
		},
	]);

	const parts: string[] = [`## Honcho Reflection: ${file}`];

	// Session conclusions (direct observations from this note)
	const sessionConclusions = getResult(honchoResults, "session_conclusions", "");
	if (sessionConclusions) {
		parts.push("");
		parts.push("### Direct Observations");
		parts.push("*Conclusions derived from this note's content:*");
		parts.push(sessionConclusions);
	}

	// Semantic conclusions (related observations from across the vault)
	const semanticConclusions = getResult(honchoResults, "semantic_conclusions", "");
	if (semanticConclusions) {
		parts.push("");
		parts.push("### Related Observations");
		parts.push("*Semantically related conclusions from the vault:*");
		parts.push(semanticConclusions);
	}

	// Focused representation
	const representation = getResult(honchoResults, "representation", "");
	if (representation) {
		parts.push("");
		parts.push("### Representation");
		parts.push("*Honcho's understanding of the user, focused through this note:*");
		parts.push(representation);
	}

	if (!sessionConclusions && !semanticConclusions && !representation) {
		parts.push("");
		parts.push("*No Honcho data for this note yet. Ingest the note and wait for Honcho to process it.*");
	}

	// Note failures
	for (const [key, result] of honchoResults) {
		if (result.status === "rejected") {
			parts.push(`\n*${key}: unavailable -- ${result.reason}*`);
		}
	}

	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// vault_status
// ---------------------------------------------------------------------------

/**
 * Overview of obsidian workspace state: vault file counts, Honcho session
 * counts, coverage percentage, conclusion counts, and queue progress.
 */
export async function vaultStatus(honcho: HonchoService): Promise<string> {
	// 4 parallel fetches
	const results = await execParallel([
		{ key: "total", fn: () => execObsidian("files", { total: true, "ext=md": true }) },
		{
			key: "sessions",
			fn: () => honcho.listSessions({ source: "obsidian" }, 1, 100) as Promise<unknown> as Promise<string>,
		},
		{
			key: "conclusions",
			fn: () => honcho.listConclusions({}, 1, 1) as Promise<unknown> as Promise<string>,
		},
		{
			key: "queue",
			fn: () => honcho.getQueueStatus() as Promise<unknown> as Promise<string>,
		},
	]);

	const parts: string[] = [
		"## Obsidian-Honcho Status",
		"",
		`Workspace: ${honcho.workspace}`,
		`Peer: ${honcho.peer}`,
	];

	// Vault file count
	const totalRaw = getResult(results, "total", "");
	const totalFiles = totalRaw ? parseInt(totalRaw.trim(), 10) || 0 : 0;

	// Sessions + coverage
	const sessionsResult = results.get("sessions");
	if (sessionsResult?.status === "fulfilled") {
		const sessions = sessionsResult.value as unknown as { items: Array<{ id: string; metadata: Record<string, unknown>; is_active: boolean }>; total: number };
		const ingestedCount = sessions.items.filter((s) => s.metadata?.source === "obsidian").length;
		const coverage = totalFiles > 0 ? Math.round((ingestedCount / totalFiles) * 100) : 0;

		parts.push("");
		parts.push("### Coverage");
		parts.push(`Vault files: ${totalFiles}`);
		parts.push(`Ingested sessions: ${ingestedCount}`);
		parts.push(`Coverage: ${coverage}%`);

		if (sessions.items.length > 0) {
			parts.push("");
			parts.push("### Sessions");
			for (const s of sessions.items.slice(0, 15)) {
				const name = (s.metadata?.file_name as string) || s.id;
				const status = s.is_active ? "active" : "inactive";
				parts.push(`- ${name} [${status}]`);
			}
			if (sessions.items.length > 15) {
				parts.push(`... and ${sessions.items.length - 15} more`);
			}
		}
	}

	// Conclusions count
	const conclusionsResult = results.get("conclusions");
	if (conclusionsResult?.status === "fulfilled") {
		const conclusions = conclusionsResult.value as unknown as { total: number };
		parts.push("");
		parts.push(`### Conclusions: ${conclusions.total} total`);
	}

	// Queue
	const queueResult = results.get("queue");
	if (queueResult?.status === "fulfilled") {
		const q = queueResult.value as unknown as {
			total_work_units: number;
			completed_work_units: number;
			in_progress_work_units: number;
			pending_work_units: number;
		};
		if (q.total_work_units > 0) {
			parts.push("");
			parts.push("### Queue");
			parts.push(`Completed: ${q.completed_work_units} / ${q.total_work_units}`);
			if (q.in_progress_work_units > 0) parts.push(`In progress: ${q.in_progress_work_units}`);
			if (q.pending_work_units > 0) parts.push(`Pending: ${q.pending_work_units}`);
		}
	}

	return parts.join("\n");
}
