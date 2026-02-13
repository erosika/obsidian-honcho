/**
 * Compound Intelligence tools -- reason across CLI + Honcho simultaneously.
 *
 * vault_chat, vault_sync, vault_contextualize, vault_analyze
 */

import { execObsidian, execParallel, getResult, parseLines } from "../cli.ts";
import type { HonchoClient, SessionResponse } from "../honcho.ts";
import {
	ToolInputError,
	type VaultChatInput,
	type VaultSyncInput,
	type VaultContextualizeInput,
} from "../types.ts";

interface CompoundConfig {
	workspace: string;
	observer: string;
	observed: string;
}

// ---------------------------------------------------------------------------
// vault_chat
// ---------------------------------------------------------------------------

export async function vaultChat(
	input: VaultChatInput,
	honcho: HonchoClient,
	config: CompoundConfig
): Promise<string> {
	const { query, reasoning_level = "medium", context_file } = input;
	if (!query) throw new ToolInputError("query is required");

	const contextParts: string[] = [];

	// Step 1: Search vault via CLI for relevant context
	const searchCalls: Array<{ key: string; fn: () => Promise<string> }> = [
		{
			key: "search",
			fn: () => execObsidian("search", {
				[`query=${query.split(" ").slice(0, 5).join(" ")}`]: true,
				"limit=5": true,
				"format=json": true,
			}),
		},
	];

	// Step 2: If context_file, gather note metadata
	if (context_file) {
		searchCalls.push(
			{ key: "ctx_tags", fn: () => execObsidian("tags", { [`file=${context_file}`]: true }) },
			{ key: "ctx_outline", fn: () => execObsidian("outline", { [`file=${context_file}`]: true, "format=tree": true }) },
			{ key: "ctx_links", fn: () => execObsidian("links", { [`file=${context_file}`]: true }) },
			{ key: "ctx_backlinks", fn: () => execObsidian("backlinks", { [`file=${context_file}`]: true }) },
			{ key: "ctx_content", fn: () => execObsidian("read", { [`file=${context_file}`]: true }) },
		);
	}

	const results = await execParallel(searchCalls);

	// Build vault context prefix
	const searchRaw = getResult(results, "search", "");
	if (searchRaw) {
		try {
			const searchResults = JSON.parse(searchRaw) as Array<{ file: string; matches?: Array<{ content: string }> }>;
			if (searchResults.length > 0) {
				contextParts.push("[Vault Search Matches]");
				for (const r of searchResults.slice(0, 5)) {
					const preview = r.matches?.[0]?.content?.slice(0, 150) ?? "";
					contextParts.push(`- ${r.file}${preview ? ": " + preview : ""}`);
				}
			}
		} catch {
			// Non-JSON search output
			if (searchRaw.trim()) {
				contextParts.push("[Vault Search]");
				contextParts.push(searchRaw.split("\n").slice(0, 10).join("\n"));
			}
		}
	}

	if (context_file) {
		contextParts.push(`\n[Context Note: ${context_file}]`);

		const ctxTags = getResult(results, "ctx_tags", "");
		if (ctxTags) contextParts.push(`Tags: ${ctxTags}`);

		const ctxOutline = getResult(results, "ctx_outline", "");
		if (ctxOutline) contextParts.push(`Outline:\n${ctxOutline}`);

		const ctxLinks = getResult(results, "ctx_links", "");
		if (ctxLinks) contextParts.push(`Links to: ${ctxLinks}`);

		const ctxBacklinks = getResult(results, "ctx_backlinks", "");
		if (ctxBacklinks) contextParts.push(`Referenced by: ${ctxBacklinks}`);

		const ctxContent = getResult(results, "ctx_content", "");
		if (ctxContent) {
			// Include first ~1000 chars of note content
			const truncated = ctxContent.slice(0, 1000);
			contextParts.push(`Content:\n${truncated}${ctxContent.length > 1000 ? "\n..." : ""}`);
		}
	}

	// Step 3: Build augmented query and send to Honcho
	const augmentedQuery = contextParts.length > 0
		? `${contextParts.join("\n")}\n\n---\n\n${query}`
		: query;

	const resp = await honcho.peerChat(config.workspace, config.observed, augmentedQuery, {
		reasoning_level: reasoning_level as "minimal" | "low" | "medium" | "high" | "max",
	});

	const response = resp.content ?? "No response.";

	// Annotate with context used
	if (contextParts.length > 0) {
		return `${response}\n\n---\n*Context used: ${context_file ? `note "${context_file}" + ` : ""}vault search*`;
	}

	return response;
}

// ---------------------------------------------------------------------------
// vault_sync
// ---------------------------------------------------------------------------

export async function vaultSync(
	input: VaultSyncInput,
	honcho: HonchoClient,
	config: CompoundConfig
): Promise<string> {
	const direction = input.direction ?? "pull";
	const results: string[] = [];

	// Pull: write identity + conclusions notes to vault via CLI
	if (direction === "pull" || direction === "both") {
		const [contextResp, conclusionsResp] = await Promise.all([
			honcho.getPeerContext(config.workspace, config.observed),
			honcho.listConclusions(config.workspace, {}, 1, 50),
		]);

		// Build identity note content
		const identityLines: string[] = [
			"---",
			`honcho_generated: ${new Date().toISOString()}`,
			`honcho_peer: ${config.observed}`,
			"tags:",
			"  - honcho",
			"  - honcho/identity",
			"---",
			"",
		];

		if (contextResp.peer_card && contextResp.peer_card.length > 0) {
			identityLines.push("## Peer Card", "");
			for (const item of contextResp.peer_card) {
				identityLines.push(`- ${item}`);
			}
			identityLines.push("");
		}

		if (contextResp.representation) {
			identityLines.push("## Representation", "");
			identityLines.push(contextResp.representation, "");
		}

		// Write identity note via CLI
		const identityName = `Honcho Identity -- ${config.observed}`;
		try {
			await execObsidian("create", {
				[`name=${identityName}`]: true,
				[`content=${identityLines.join("\n")}`]: true,
				overwrite: true,
			});
			results.push(`Written: ${identityName}`);
		} catch (err) {
			results.push(`Failed to write ${identityName}: ${err instanceof Error ? err.message : String(err)}`);
		}

		// Set properties on identity note
		try {
			await execObsidian("property:set", {
				[`name=honcho_generated`]: true,
				[`value=${new Date().toISOString()}`]: true,
				[`file=${identityName}`]: true,
			});
		} catch {
			// best effort
		}

		// Build conclusions note content
		const concLines: string[] = [
			"---",
			`honcho_generated: ${new Date().toISOString()}`,
			`honcho_peer: ${config.observed}`,
			`honcho_count: ${conclusionsResp.items.length}`,
			"tags:",
			"  - honcho",
			"  - honcho/conclusions",
			"---",
			"",
			"## Conclusions",
			"",
		];

		if (conclusionsResp.items.length === 0) {
			concLines.push("*No conclusions yet.*");
		} else {
			for (const c of conclusionsResp.items) {
				const date = new Date(c.created_at).toLocaleDateString();
				concLines.push(`- **${date}**: ${c.content}`);
			}
		}
		concLines.push("");

		const concName = `Honcho Conclusions -- ${config.observed}`;
		try {
			await execObsidian("create", {
				[`name=${concName}`]: true,
				[`content=${concLines.join("\n")}`]: true,
				overwrite: true,
			});
			results.push(`Written: ${concName} (${conclusionsResp.items.length} conclusions)`);
		} catch (err) {
			results.push(`Failed to write ${concName}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// Push: read a note and set as peer card
	if (direction === "push" || direction === "both") {
		if (!input.push_file) {
			if (direction === "push") {
				throw new ToolInputError("push_file is required for direction=push");
			}
			// For "both", just skip push if no file specified
		} else {
			const content = await execObsidian("read", { [`file=${input.push_file}`]: true });

			// Strip frontmatter
			let body = content;
			const fmMatch = body.match(/^---\n[\s\S]*?\n---\n?/);
			if (fmMatch) {
				body = body.slice(fmMatch[0].length);
			}

			// Parse lines: treat bullet points as card items
			const items: string[] = [];
			for (const line of body.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith("#")) continue;
				const cleaned = trimmed.replace(/^[-*+]\s+/, "").trim();
				if (cleaned) items.push(cleaned);
			}

			if (items.length === 0) {
				results.push(`No card items found in ${input.push_file}. Use bullet points.`);
			} else {
				await honcho.setPeerCard(config.workspace, config.observed, items);
				results.push(`Pushed ${items.length} items from ${input.push_file} to peer card.`);
			}
		}
	}

	return results.join("\n");
}

// ---------------------------------------------------------------------------
// vault_contextualize
// ---------------------------------------------------------------------------

export async function vaultContextualize(
	input: VaultContextualizeInput,
	honcho: HonchoClient,
	config: CompoundConfig
): Promise<string> {
	if (!input.file) throw new ToolInputError("file is required");
	const file = input.file;

	// All calls in parallel: CLI (7) + Honcho (3)
	const cliCalls: Array<{ key: string; fn: () => Promise<string> }> = [
		{ key: "metadata", fn: () => execObsidian("file", { [`file=${file}`]: true }) },
		{ key: "backlinks", fn: () => execObsidian("backlinks", { [`file=${file}`]: true, counts: true }) },
		{ key: "links", fn: () => execObsidian("links", { [`file=${file}`]: true }) },
		{ key: "outline", fn: () => execObsidian("outline", { [`file=${file}`]: true, "format=tree": true }) },
		{ key: "properties", fn: () => execObsidian("properties", { [`file=${file}`]: true, "format=yaml": true }) },
		{ key: "tags", fn: () => execObsidian("tags", { [`file=${file}`]: true }) },
		{ key: "aliases", fn: () => execObsidian("aliases", { [`file=${file}`]: true }) },
	];

	const honchoCalls: Array<{ key: string; fn: () => Promise<string> }> = [
		{
			key: "representation",
			fn: async () => {
				const tags = await execObsidian("tags", { [`file=${file}`]: true }).catch(() => "");
				const searchQuery = [file, ...parseLines(tags).slice(0, 3)].join(" ");
				const resp = await honcho.getPeerRepresentation(config.workspace, config.observed, {
					search_query: searchQuery,
				});
				return resp.representation || "";
			},
		},
		{
			key: "conclusions",
			fn: async () => {
				const conclusions = await honcho.queryConclusions(config.workspace, file, { top_k: 5 });
				return conclusions.map((c) => `- ${c.content}`).join("\n");
			},
		},
		{
			key: "sessions",
			fn: async () => {
				const sessions = await honcho.listSessions(
					config.workspace,
					{ source: "obsidian", file_name: file },
					1,
					5
				);
				return sessions.items.map((s) => {
					const ingested = s.metadata?.ingested_at as string ?? "unknown";
					return `- ${s.id} (ingested: ${ingested})`;
				}).join("\n");
			},
		},
	];

	const [cliResults, honchoResults] = await Promise.all([
		execParallel(cliCalls),
		execParallel(honchoCalls),
	]);

	const parts: string[] = [`## ${file} -- Compound View`];

	// Structural Position
	parts.push("\n### Structural Position");

	const metadata = getResult(cliResults, "metadata", "");
	if (metadata) parts.push(metadata);

	const backlinks = getResult(cliResults, "backlinks", "");
	if (backlinks) {
		parts.push("**Backlinks:**");
		parts.push(backlinks);
	}

	const links = getResult(cliResults, "links", "");
	if (links) {
		parts.push("**Outgoing Links:**");
		parts.push(links);
	}

	const outline = getResult(cliResults, "outline", "");
	if (outline) {
		parts.push("**Outline:**");
		parts.push(outline);
	}

	const properties = getResult(cliResults, "properties", "");
	if (properties) {
		parts.push("**Properties:**");
		parts.push(properties);
	}

	const tags = getResult(cliResults, "tags", "");
	if (tags) {
		parts.push("**Tags:**");
		parts.push(tags);
	}

	const aliases = getResult(cliResults, "aliases", "");
	if (aliases) {
		parts.push("**Aliases:**");
		parts.push(aliases);
	}

	// Semantic Perspective
	parts.push("\n### Semantic Perspective (Honcho)");

	const representation = getResult(honchoResults, "representation", "");
	if (representation) {
		parts.push("**Representation:**");
		parts.push(representation);
	}

	const conclusions = getResult(honchoResults, "conclusions", "");
	if (conclusions) {
		parts.push("**Related Conclusions:**");
		parts.push(conclusions);
	}

	// Ingestion Status
	parts.push("\n### Ingestion Status");
	const sessions = getResult(honchoResults, "sessions", "");
	if (sessions) {
		parts.push(sessions);
	} else {
		parts.push("*Not yet ingested*");
	}

	// Note any failures
	for (const [key, result] of cliResults) {
		if (result.status === "rejected") {
			parts.push(`\n*${key}: unavailable -- ${result.reason}*`);
		}
	}
	for (const [key, result] of honchoResults) {
		if (result.status === "rejected") {
			parts.push(`\n*${key}: unavailable -- ${result.reason}*`);
		}
	}

	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// vault_analyze
// ---------------------------------------------------------------------------

export async function vaultAnalyze(
	honcho: HonchoClient,
	config: CompoundConfig
): Promise<string> {
	// All in parallel: CLI + Honcho
	const cliCalls: Array<{ key: string; fn: () => Promise<string> }> = [
		{ key: "files", fn: () => execObsidian("files", { "ext=md": true }) },
		{ key: "orphans", fn: () => execObsidian("orphans", {}) },
		{ key: "deadends", fn: () => execObsidian("deadends", {}) },
		{ key: "unresolved", fn: () => execObsidian("unresolved", { counts: true }) },
		{ key: "tags", fn: () => execObsidian("tags", { all: true, counts: true, "sort=count": true }) },
		{ key: "vault", fn: () => execObsidian("vault", {}) },
	];

	const honchoCalls: Array<{ key: string; fn: () => Promise<string> }> = [
		{
			key: "sessions",
			fn: async () => {
				const resp = await honcho.listSessions(config.workspace, { source: "obsidian" }, 1, 100);
				return JSON.stringify(resp);
			},
		},
		{
			key: "queue",
			fn: async () => {
				const resp = await honcho.getQueueStatus(config.workspace, { observer_id: config.observer });
				return JSON.stringify(resp);
			},
		},
	];

	const [cliResults, honchoResults] = await Promise.all([
		execParallel(cliCalls),
		execParallel(honchoCalls),
	]);

	const parts: string[] = ["## Vault Intelligence Report"];

	// Vault overview
	const vaultInfo = getResult(cliResults, "vault", "");
	if (vaultInfo) {
		parts.push("\n### Vault");
		parts.push(vaultInfo);
	}

	// Graph health
	parts.push("\n### Graph Health");

	const orphans = parseLines(getResult(cliResults, "orphans", ""));
	parts.push(`**Orphans** (no incoming links): ${orphans.length}`);
	if (orphans.length > 0 && orphans.length <= 20) {
		parts.push(orphans.map((o) => `  - ${o}`).join("\n"));
	}

	const deadends = parseLines(getResult(cliResults, "deadends", ""));
	parts.push(`**Dead Ends** (no outgoing links): ${deadends.length}`);
	if (deadends.length > 0 && deadends.length <= 20) {
		parts.push(deadends.map((d) => `  - ${d}`).join("\n"));
	}

	const unresolved = getResult(cliResults, "unresolved", "");
	if (unresolved) {
		parts.push("**Unresolved Links:**");
		parts.push(unresolved);
	}

	// Tag distribution
	const tags = getResult(cliResults, "tags", "");
	if (tags) {
		parts.push("\n### Tag Distribution");
		parts.push(tags);
	}

	// Knowledge coverage
	parts.push("\n### Knowledge Coverage");
	const vaultFiles = parseLines(getResult(cliResults, "files", ""));

	const sessionsRaw = getResult(honchoResults, "sessions", "{}");
	try {
		const sessions = JSON.parse(sessionsRaw) as { items: SessionResponse[]; total: number };
		const ingestedPaths = new Set(
			sessions.items
				.filter((s) => s.metadata?.source === "obsidian")
				.map((s) => (s.metadata?.file_name as string) || s.id.replace("obsidian:file:", ""))
		);

		const total = vaultFiles.length;
		const ingested = ingestedPaths.size;
		const coverage = total > 0 ? Math.round((ingested / total) * 100) : 0;

		parts.push(`Total vault files: ${total}`);
		parts.push(`Ingested into Honcho: ${ingested}`);
		parts.push(`Coverage: ${coverage}%`);

		const unIngested = vaultFiles.filter((f) => !ingestedPaths.has(f));
		if (unIngested.length > 0) {
			parts.push(`\n**Un-ingested files** (${unIngested.length}):`);
			for (const f of unIngested.slice(0, 20)) {
				parts.push(`  - ${f}`);
			}
			if (unIngested.length > 20) {
				parts.push(`  ... and ${unIngested.length - 20} more`);
			}
		}
	} catch {
		parts.push("Unable to calculate coverage (Honcho session list unavailable).");
	}

	// Queue status
	const queueRaw = getResult(honchoResults, "queue", "{}");
	try {
		const queue = JSON.parse(queueRaw) as {
			total_work_units: number;
			completed_work_units: number;
			in_progress_work_units: number;
			pending_work_units: number;
		};
		parts.push(
			"\n### Queue Status",
			`Total: ${queue.total_work_units}`,
			`Completed: ${queue.completed_work_units}`,
			`In progress: ${queue.in_progress_work_units}`,
			`Pending: ${queue.pending_work_units}`
		);
	} catch {
		parts.push("\n### Queue Status\nUnavailable");
	}

	// Note any failures
	for (const [key, result] of cliResults) {
		if (result.status === "rejected") {
			parts.push(`\n*${key}: unavailable -- ${result.reason}*`);
		}
	}
	for (const [key, result] of honchoResults) {
		if (result.status === "rejected") {
			parts.push(`\n*${key}: unavailable -- ${result.reason}*`);
		}
	}

	return parts.join("\n");
}
