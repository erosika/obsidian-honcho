/**
 * Honcho Memory tools -- CLI-enriched ingestion + direct API access.
 *
 * vault_ingest, vault_memory, vault_status, vault_dream
 */

import { execObsidian, execParallel, getResult, parseLines } from "../cli.ts";
import type { HonchoClient, SessionResponse } from "../honcho.ts";
import { chunkMarkdown } from "../chunk.ts";
import {
	ToolInputError,
	type VaultIngestInput,
	type VaultMemoryInput,
	type VaultDreamInput,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface IngestConfig {
	workspace: string;
	observer: string;
	observed: string;
}

/**
 * Ingest a single file using CLI-enriched metadata.
 */
async function ingestSingleFile(
	fileName: string,
	honcho: HonchoClient,
	config: IngestConfig
): Promise<string> {
	// Parallel CLI calls for rich metadata
	const results = await execParallel([
		{ key: "content", fn: () => execObsidian("read", { [`file=${fileName}`]: true }) },
		{ key: "metadata", fn: () => execObsidian("file", { [`file=${fileName}`]: true }) },
		{ key: "backlinks", fn: () => execObsidian("backlinks", { [`file=${fileName}`]: true }) },
		{ key: "links", fn: () => execObsidian("links", { [`file=${fileName}`]: true }) },
		{ key: "tags", fn: () => execObsidian("tags", { [`file=${fileName}`]: true }) },
		{ key: "outline", fn: () => execObsidian("outline", { [`file=${fileName}`]: true, "format=md": true }) },
	]);

	const content = getResult(results, "content", "");
	if (!content.trim()) return `${fileName}: empty or unreadable`;

	const chunks = chunkMarkdown(content);
	if (chunks.length === 0) return `${fileName}: no content to ingest`;

	// Parse metadata for session
	const backlinks = parseLines(getResult(results, "backlinks", ""));
	const links = parseLines(getResult(results, "links", ""));
	const tags = parseLines(getResult(results, "tags", ""));
	const outline = getResult(results, "outline", "");
	const rawMeta = getResult(results, "metadata", "");

	// Extract path from metadata if available
	const pathMatch = rawMeta.match(/path[:\t]\s*(.+)/i);
	const filePath = pathMatch?.[1]?.trim() ?? fileName;
	const folderMatch = rawMeta.match(/folder[:\t]\s*(.+)/i);
	const folder = folderMatch?.[1]?.trim() ?? "/";
	const createdMatch = rawMeta.match(/created[:\t]\s*(.+)/i);
	const created = createdMatch?.[1]?.trim() ?? new Date().toISOString();
	const modifiedMatch = rawMeta.match(/modified[:\t]\s*(.+)/i);
	const modified = modifiedMatch?.[1]?.trim() ?? new Date().toISOString();

	const sessionId = `obsidian:file:${filePath}`;

	// Get or create session
	const session = await honcho.getOrCreateSession(
		config.workspace,
		sessionId,
		{
			[config.observer]: { observe_me: false, observe_others: true },
			[config.observed]: { observe_me: true, observe_others: false },
		}
	);

	// Update session metadata
	await honcho.updateSession(config.workspace, session.id, {
		metadata: {
			source: "obsidian",
			source_type: "file",
			file_path: filePath,
			file_name: fileName,
			folder,
			tags,
			outgoing_links: links,
			backlinks,
			heading_count: outline.split("\n").filter((l) => l.trim()).length,
			created_at: created,
			modified_at: modified,
			ingested_at: new Date().toISOString(),
		},
		configuration: {
			reasoning: { enabled: true },
			dream: { enabled: true },
			summary: { enabled: true },
		},
	});

	// Build structural preamble from CLI data
	const preambleParts: string[] = [`[Note: ${fileName}]`];
	if (folder !== "/") preambleParts.push(`Folder: ${folder}`);
	if (tags.length > 0) preambleParts.push(`Tags: ${tags.join(", ")}`);
	if (outline) preambleParts.push(`Structure: ${outline.split("\n").filter((l) => l.trim()).join(" > ")}`);
	if (links.length > 0) preambleParts.push(`Links to: ${links.join(", ")}`);
	if (backlinks.length > 0) preambleParts.push(`Referenced by: ${backlinks.join(", ")}`);
	preambleParts.push(`Created: ${created.split("T")[0]}`);
	preambleParts.push(`Modified: ${modified.split("T")[0]}`);

	const messages: Array<{
		peer_id: string;
		content: string;
		metadata?: Record<string, unknown>;
		created_at?: string;
	}> = [
		{
			peer_id: config.observed,
			content: preambleParts.join("\n"),
			metadata: { source_file: filePath, message_type: "structural_context" },
			created_at: created,
		},
		...chunks.map((chunk, i) => ({
			peer_id: config.observed,
			content: chunk,
			metadata: {
				source_file: filePath,
				source_name: fileName,
				chunk_index: i,
				chunk_total: chunks.length,
				message_type: "content" as const,
			},
			created_at: modified,
		})),
	];

	const created_msgs = await honcho.addMessages(config.workspace, session.id, messages);
	return `${fileName}: ${created_msgs.length} messages into session ${session.id}`;
}

// ---------------------------------------------------------------------------
// vault_ingest
// ---------------------------------------------------------------------------

export async function vaultIngest(
	input: VaultIngestInput,
	honcho: HonchoClient,
	config: IngestConfig
): Promise<string> {
	const mode = input.mode ?? "file";
	const dream = input.dream ?? true;
	const results: string[] = [];

	switch (mode) {
		case "file": {
			if (!input.target) throw new ToolInputError("target is required for mode=file");
			const result = await ingestSingleFile(input.target, honcho, config);
			results.push(result);
			break;
		}

		case "folder": {
			if (!input.target) throw new ToolInputError("target is required for mode=folder");
			const raw = await execObsidian("files", { [`folder=${input.target}`]: true, "ext=md": true });
			const files = parseLines(raw);
			if (files.length === 0) {
				return `No markdown files in ${input.target}`;
			}

			// Batch ingest (5 at a time)
			for (let i = 0; i < files.length; i += 5) {
				const batch = files.slice(i, i + 5);
				const batchResults = await Promise.all(
					batch.map((f) => ingestSingleFile(f, honcho, config).catch((e) => `${f}: error -- ${e.message}`))
				);
				results.push(...batchResults);
			}
			break;
		}

		case "linked": {
			if (!input.target) throw new ToolInputError("target is required for mode=linked");
			const depth = input.depth ?? 1;
			const visited = new Set<string>();
			const queue: Array<{ file: string; currentDepth: number }> = [
				{ file: input.target, currentDepth: 0 },
			];

			while (queue.length > 0) {
				const item = queue.shift()!;
				if (visited.has(item.file)) continue;
				visited.add(item.file);

				const result = await ingestSingleFile(item.file, honcho, config).catch(
					(e) => `${item.file}: error -- ${e.message}`
				);
				results.push(result);

				// Follow links if below max depth
				if (item.currentDepth < depth) {
					try {
						const raw = await execObsidian("links", { [`file=${item.file}`]: true });
						const links = parseLines(raw);
						for (const link of links) {
							if (!visited.has(link)) {
								queue.push({ file: link, currentDepth: item.currentDepth + 1 });
							}
						}
					} catch {
						// Skip link traversal on error
					}
				}
			}
			break;
		}

		case "smart": {
			const limit = input.limit ?? 20;

			// Get vault file list and Honcho session list in parallel
			const [vaultRaw, sessionsResp] = await Promise.all([
				execObsidian("files", { "ext=md": true }),
				honcho.listSessions(config.workspace, { source: "obsidian" }, 1, 100),
			]);

			const vaultFiles = parseLines(vaultRaw);
			const ingestedPaths = new Set(
				sessionsResp.items
					.filter((s) => s.metadata?.source === "obsidian")
					.map((s) => (s.metadata?.file_name as string) || s.id.replace("obsidian:file:", ""))
			);

			// Prioritize un-ingested files
			const unIngested = vaultFiles.filter((f) => !ingestedPaths.has(f));

			// TODO: could also check modified dates for stale files, but that
			// requires per-file metadata calls. Keep it simple for now.

			const toIngest = unIngested.slice(0, limit);
			if (toIngest.length === 0) {
				return `All ${vaultFiles.length} vault files are already ingested.`;
			}

			results.push(`Smart ingest: ${toIngest.length} un-ingested files (of ${vaultFiles.length} total)`);

			for (let i = 0; i < toIngest.length; i += 5) {
				const batch = toIngest.slice(i, i + 5);
				const batchResults = await Promise.all(
					batch.map((f) => ingestSingleFile(f, honcho, config).catch((e) => `${f}: error -- ${e.message}`))
				);
				results.push(...batchResults);
			}
			break;
		}

		default:
			throw new ToolInputError(`Unknown ingest mode: ${mode}`);
	}

	// Schedule dream after ingestion
	if (dream && results.length > 0) {
		try {
			await honcho.scheduleDream(config.workspace, config.observer, {
				observed: config.observed,
			});
			results.push("Dream scheduled for post-ingestion processing.");
		} catch {
			// best effort
		}
	}

	return results.join("\n");
}

// ---------------------------------------------------------------------------
// vault_memory
// ---------------------------------------------------------------------------

export async function vaultMemory(
	input: VaultMemoryInput,
	honcho: HonchoClient,
	workspace: string,
	observed: string
): Promise<string> {
	const { action, limit = 10 } = input;

	switch (action) {
		case "search": {
			if (!input.query) throw new ToolInputError("query is required for action=search");
			const conclusions = await honcho.queryConclusions(workspace, input.query, { top_k: limit });
			if (conclusions.length === 0) return "No matching conclusions.";
			const lines = conclusions.map((c) => `- ${c.content}`);
			return `## Conclusions matching "${input.query}"\n${lines.join("\n")}`;
		}

		case "conclusions": {
			const resp = await honcho.listConclusions(workspace, {}, 1, limit);
			if (resp.items.length === 0) return "No conclusions yet.";
			const lines = resp.items.map((c) => {
				const date = new Date(c.created_at).toLocaleDateString();
				return `- **${date}**: ${c.content}`;
			});
			return `## Conclusions (${resp.total} total)\n${lines.join("\n")}`;
		}

		case "representation": {
			const resp = await honcho.getPeerRepresentation(workspace, observed, {
				search_query: input.query,
			});
			return resp.representation || "No representation available.";
		}

		case "card": {
			const resp = await honcho.getPeerCard(workspace, observed);
			if (!resp.peer_card || resp.peer_card.length === 0) return "No peer card set.";
			const lines = resp.peer_card.map((item) => `- ${item}`);
			return `## Peer Card\n${lines.join("\n")}`;
		}

		case "context": {
			const resp = await honcho.getPeerContext(workspace, observed);
			const parts: string[] = [];
			if (resp.peer_card && resp.peer_card.length > 0) {
				parts.push("## Peer Card");
				parts.push(...resp.peer_card.map((item) => `- ${item}`));
			}
			if (resp.representation) {
				parts.push("## Representation");
				parts.push(resp.representation);
			}
			return parts.length > 0 ? parts.join("\n") : "No context available.";
		}

		default:
			throw new ToolInputError(`Unknown memory action: ${action}`);
	}
}

// ---------------------------------------------------------------------------
// vault_status
// ---------------------------------------------------------------------------

export async function vaultStatus(
	honcho: HonchoClient,
	config: IngestConfig
): Promise<string> {
	// Parallel: Honcho sessions + queue + CLI vault info + file count
	const results = await execParallel([
		{
			key: "sessions",
			fn: () => honcho.listSessions(config.workspace, { source: "obsidian" }, 1, 10) as Promise<unknown> as Promise<string>,
		},
		{
			key: "queue",
			fn: () => honcho.getQueueStatus(config.workspace, { observer_id: config.observer }) as Promise<unknown> as Promise<string>,
		},
		{
			key: "vault",
			fn: () => execObsidian("vault", {}),
		},
		{
			key: "total",
			fn: () => execObsidian("files", { total: true }),
		},
	]);

	const parts: string[] = [
		`Workspace: ${config.workspace}`,
		`Observer: ${config.observer}`,
		`Observed: ${config.observed}`,
	];

	// Vault info
	const vaultInfo = getResult(results, "vault", "");
	if (vaultInfo) {
		parts.push("", "## Vault");
		parts.push(vaultInfo);
	}

	const total = getResult(results, "total", "");
	if (total) {
		parts.push(`Total files: ${total}`);
	}

	// Sessions
	const sessionsResult = results.get("sessions");
	if (sessionsResult?.status === "fulfilled") {
		const sessions = sessionsResult.value as unknown as { items: SessionResponse[]; total: number };
		parts.push("", `## Sessions (${sessions.total} total)`);
		for (const s of sessions.items) {
			const name = (s.metadata?.file_name as string) || s.id;
			const status = s.is_active ? "active" : "inactive";
			parts.push(`- ${name} [${status}]`);
		}
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
		parts.push(
			"",
			"## Queue",
			`Total: ${q.total_work_units}`,
			`Completed: ${q.completed_work_units}`,
			`In progress: ${q.in_progress_work_units}`,
			`Pending: ${q.pending_work_units}`
		);
	}

	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// vault_dream
// ---------------------------------------------------------------------------

export async function vaultDream(
	input: VaultDreamInput,
	honcho: HonchoClient,
	config: IngestConfig
): Promise<string> {
	await honcho.scheduleDream(config.workspace, config.observer, {
		observed: config.observed,
		session_id: input.session_id,
	});
	return input.session_id
		? `Dream scheduled for session ${input.session_id}.`
		: "Dream scheduled. Honcho will consolidate observations into higher-order conclusions.";
}
