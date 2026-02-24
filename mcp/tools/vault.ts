/**
 * Vault Intelligence tools -- pure CLI, no Honcho dependency.
 *
 * vault_search, vault_read, vault_info, vault_list, vault_graph
 */

import { execObsidian, execParallel, getResult, parseLines, parseJSON } from "../api.ts";
import {
	ToolInputError,
	type VaultSearchInput,
	type VaultReadInput,
	type VaultInfoInput,
	type VaultListInput,
	type VaultGraphInput,
} from "../types.ts";

// ---------------------------------------------------------------------------
// vault_search -- CLI keyword only (semantic search at mcp.honcho.dev)
// ---------------------------------------------------------------------------

export async function vaultSearch(input: VaultSearchInput): Promise<string> {
	const { query, limit = 10 } = input;
	if (!query) throw new ToolInputError("query is required");

	const parts: string[] = ["## Vault (keyword index)"];

	try {
		const raw = await execObsidian("search", {
			[`query=${query}`]: true,
			[`limit=${limit}`]: true,
			"format=json": true,
		});
		try {
			const results = parseJSON<Array<{ file: string; matches?: Array<{ content: string }> }>>(raw);
			if (results.length === 0) {
				parts.push("No matches.");
			} else {
				for (const r of results.slice(0, limit)) {
					const preview = r.matches?.[0]?.content?.slice(0, 200) ?? "";
					parts.push(`- **${r.file}**${preview ? ": " + preview : ""}`);
				}
			}
		} catch {
			// Non-JSON output -- render as-is
			const lines = raw.split("\n").slice(0, limit * 2);
			for (const line of lines) {
				if (line.trim()) parts.push(`- ${line.trim()}`);
			}
		}
	} catch (err) {
		parts.push(`Unavailable: ${err instanceof Error ? err.message : String(err)}`);
	}

	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// vault_read
// ---------------------------------------------------------------------------

export async function vaultRead(input: VaultReadInput): Promise<string> {
	if (!input.file) throw new ToolInputError("file is required");
	return execObsidian("read", { [`file=${input.file}`]: true });
}

// ---------------------------------------------------------------------------
// vault_info
// ---------------------------------------------------------------------------

export async function vaultInfo(input: VaultInfoInput): Promise<string> {
	if (!input.file) throw new ToolInputError("file is required");
	const file = input.file;

	// 7 CLI calls in parallel
	const results = await execParallel([
		{ key: "metadata", fn: () => execObsidian("file", { [`file=${file}`]: true }) },
		{ key: "backlinks", fn: () => execObsidian("backlinks", { [`file=${file}`]: true, counts: true }) },
		{ key: "links", fn: () => execObsidian("links", { [`file=${file}`]: true }) },
		{ key: "outline", fn: () => execObsidian("outline", { [`file=${file}`]: true, "format=tree": true }) },
		{ key: "properties", fn: () => execObsidian("properties", { [`file=${file}`]: true, "format=yaml": true }) },
		{ key: "tags", fn: () => execObsidian("tags", { [`file=${file}`]: true }) },
		{ key: "aliases", fn: () => execObsidian("aliases", { [`file=${file}`]: true }) },
	]);

	const parts: string[] = [`## ${file}`];

	const meta = getResult(results, "metadata", "");
	if (meta) {
		parts.push("### Metadata");
		parts.push(meta);
	}

	const backlinks = getResult(results, "backlinks", "");
	const links = getResult(results, "links", "");
	if (backlinks || links) {
		parts.push("### Graph Position");
		if (backlinks) {
			parts.push("**Backlinks:**");
			parts.push(backlinks);
		}
		if (links) {
			parts.push("**Outgoing Links:**");
			parts.push(links);
		}
	}

	const outline = getResult(results, "outline", "");
	if (outline) {
		parts.push("### Structure");
		parts.push(outline);
	}

	const properties = getResult(results, "properties", "");
	if (properties) {
		parts.push("### Properties");
		parts.push(properties);
	}

	const tags = getResult(results, "tags", "");
	if (tags) {
		parts.push("### Tags");
		parts.push(tags);
	}

	const aliases = getResult(results, "aliases", "");
	if (aliases) {
		parts.push("### Aliases");
		parts.push(aliases);
	}

	for (const [key, result] of results) {
		if (result.status === "rejected") {
			parts.push(`\n*${key}: unavailable -- ${result.reason}*`);
		}
	}

	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// vault_list
// ---------------------------------------------------------------------------

export async function vaultList(input: VaultListInput): Promise<string> {
	const args: Record<string, string | boolean | undefined> = {};

	if (input.folder) args[`folder=${input.folder}`] = true;
	if (input.ext) args[`ext=${input.ext}`] = true;
	if (input.total) args.total = true;

	const raw = await execObsidian("files", args);
	return raw || "No files found.";
}

// ---------------------------------------------------------------------------
// vault_graph
// ---------------------------------------------------------------------------

export async function vaultGraph(input: VaultGraphInput): Promise<string> {
	const include = input.include ?? ["orphans", "deadends", "unresolved", "tags", "recents", "tasks"];

	const calls: Array<{ key: string; fn: () => Promise<string> }> = [];

	if (include.includes("orphans")) {
		calls.push({ key: "orphans", fn: () => execObsidian("orphans", {}) });
	}
	if (include.includes("deadends")) {
		calls.push({ key: "deadends", fn: () => execObsidian("deadends", {}) });
	}
	if (include.includes("unresolved")) {
		calls.push({ key: "unresolved", fn: () => execObsidian("unresolved", { counts: true }) });
	}
	if (include.includes("tags")) {
		calls.push({ key: "tags", fn: () => execObsidian("tags", { all: true, counts: true, "sort=count": true }) });
	}
	if (include.includes("recents")) {
		calls.push({ key: "recents", fn: () => execObsidian("recents", {}) });
	}
	if (include.includes("tasks")) {
		calls.push({ key: "tasks", fn: () => execObsidian("tasks", { all: true, todo: true }) });
	}

	// Always get vault info
	calls.push({ key: "files", fn: () => execObsidian("vault", {}) });

	const results = await execParallel(calls);
	const parts: string[] = ["## Vault Graph Health"];

	const vaultInfo = getResult(results, "files", "");
	if (vaultInfo) {
		parts.push("### Vault");
		parts.push(vaultInfo);
	}

	if (include.includes("orphans")) {
		const orphans = getResult(results, "orphans", "");
		parts.push("### Orphans (no incoming links)");
		parts.push(orphans || "*None*");
	}

	if (include.includes("deadends")) {
		const deadends = getResult(results, "deadends", "");
		parts.push("### Dead Ends (no outgoing links)");
		parts.push(deadends || "*None*");
	}

	if (include.includes("unresolved")) {
		const unresolved = getResult(results, "unresolved", "");
		parts.push("### Unresolved Links");
		parts.push(unresolved || "*None*");
	}

	if (include.includes("tags")) {
		const tags = getResult(results, "tags", "");
		parts.push("### Tag Distribution");
		parts.push(tags || "*No tags*");
	}

	if (include.includes("recents")) {
		const recents = getResult(results, "recents", "");
		parts.push("### Recent Files");
		parts.push(recents || "*None*");
	}

	if (include.includes("tasks")) {
		const tasks = getResult(results, "tasks", "");
		parts.push("### Pending Tasks");
		parts.push(tasks || "*None*");
	}

	for (const [key, result] of results) {
		if (result.status === "rejected") {
			parts.push(`\n*${key}: unavailable -- ${result.reason}*`);
		}
	}

	return parts.join("\n");
}
