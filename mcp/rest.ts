/**
 * REST transport -- Obsidian Local REST API via fetch().
 *
 * Fallback when CLI is unavailable. Maps CLI commands to HTTP calls.
 * Requires Local REST API plugin.
 *
 * Environment variables:
 *   OBSIDIAN_REST_URL - Default: http://127.0.0.1:27123
 *   OBSIDIAN_REST_KEY - API key from Local REST API plugin settings
 */

import { ObsidianNotRunningError } from "./types.ts";

const REST_TIMEOUT = 10_000;

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

function getRestConfig() {
	const baseUrl = (process.env.OBSIDIAN_REST_URL ?? "http://127.0.0.1:27123").replace(/\/+$/, "");
	const apiKey = process.env.OBSIDIAN_REST_KEY ?? "";
	return { baseUrl, apiKey };
}

async function restFetch(path: string, options: RequestInit = {}): Promise<Response> {
	const { baseUrl, apiKey } = getRestConfig();
	const headers: Record<string, string> = {
		...(options.headers as Record<string, string> || {}),
	};
	if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REST_TIMEOUT);

	try {
		const resp = await fetch(`${baseUrl}${path}`, {
			...options,
			headers,
			signal: controller.signal,
		});
		if (!resp.ok) {
			if (resp.status >= 500) throw new ObsidianNotRunningError();
			throw new Error(`REST ${resp.status}: ${await resp.text()}`);
		}
		return resp;
	} catch (err) {
		if (err instanceof ObsidianNotRunningError) throw err;
		if (err instanceof Error && (err.name === "AbortError" || err.message.includes("fetch"))) {
			throw new ObsidianNotRunningError();
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse encoded CLI args ("key=value": true) into clean key-value pairs */
function parseArgs(args: Record<string, string | number | boolean | undefined>): Record<string, string> {
	const parsed: Record<string, string> = {};
	for (const [key, value] of Object.entries(args)) {
		if (value === undefined || value === null || value === false) continue;
		const eqIdx = key.indexOf("=");
		if (eqIdx > 0 && value === true) {
			parsed[key.slice(0, eqIdx)] = key.slice(eqIdx + 1);
		} else if (value === true) {
			parsed[key] = "true";
		} else {
			parsed[key] = String(value);
		}
	}
	return parsed;
}

/** Encode vault path -- encode each segment, ensure .md extension */
function vaultPath(file: string): string {
	const path = file.endsWith(".md") ? file : `${file}.md`;
	return path.split("/").map(encodeURIComponent).join("/");
}

/** Extract [[wikilinks]] from markdown content */
function extractWikilinks(content: string): string[] {
	const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
	const links = new Set<string>();
	let match;
	while ((match = re.exec(content)) !== null) links.add(match[1]);
	return [...links];
}

interface NoteJson {
	content: string;
	frontmatter: Record<string, unknown>;
	tags: string[];
	path: string;
	stat: { ctime: number; mtime: number; size: number };
}

async function getNoteJson(file: string): Promise<NoteJson> {
	const resp = await restFetch(`/vault/${vaultPath(file)}`, {
		headers: { Accept: "application/vnd.olrapi.note+json" },
	});
	return resp.json();
}

async function getDocMap(file: string): Promise<{ headings: string[]; blocks: string[] }> {
	const resp = await restFetch(`/vault/${vaultPath(file)}`, {
		headers: { Accept: "application/vnd.olrapi.document-map+json" },
	});
	return resp.json();
}

async function listAllFiles(): Promise<string[]> {
	const resp = await restFetch("/vault/");
	const data = (await resp.json()) as { files: string[] };
	return data.files ?? [];
}

async function readMarkdown(file: string): Promise<string> {
	const resp = await restFetch(`/vault/${vaultPath(file)}`, {
		headers: { Accept: "text/markdown" },
	});
	return resp.text();
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

/**
 * Execute an Obsidian command via Local REST API.
 * Maps CLI commands to HTTP calls, returns equivalent string output.
 */
export async function execRest(
	command: string,
	args: Record<string, string | number | boolean | undefined> = {},
	_vaultName?: string
): Promise<string> {
	const p = parseArgs(args);

	switch (command) {
		// ---- Read ----

		case "read": {
			const file = p.file || p.path;
			if (!file) throw new Error("file is required");
			return (await readMarkdown(file)).trim();
		}

		case "file": {
			const file = p.file || p.path;
			if (!file) throw new Error("file is required");
			const note = await getNoteJson(file);
			const folder = note.path.includes("/") ? note.path.split("/").slice(0, -1).join("/") : "/";
			return [
				`path: ${note.path}`,
				`name: ${file}`,
				`folder: ${folder}`,
				`size: ${note.stat.size}`,
				`created: ${new Date(note.stat.ctime).toISOString()}`,
				`modified: ${new Date(note.stat.mtime).toISOString()}`,
			].join("\n");
		}

		case "files": {
			let files = await listAllFiles();
			if (p.folder) files = files.filter((f) => f.startsWith(p.folder + "/") || f === p.folder);
			if (p.ext) files = files.filter((f) => f.endsWith(`.${p.ext}`));
			if (p.total === "true") return String(files.length);
			return files.join("\n");
		}

		case "search": {
			const query = p.query;
			if (!query) throw new Error("query is required");
			const limit = parseInt(p.limit ?? "10", 10);
			const resp = await restFetch(
				`/search/simple/?query=${encodeURIComponent(query)}&contextLength=200`,
				{ method: "POST" }
			);
			const results = (await resp.json()) as Array<{
				filename: string;
				matches: Array<{ context: string }>;
				score: number;
			}>;
			if (p.format === "json") {
				return JSON.stringify(
					results.slice(0, limit).map((r) => ({
						file: r.filename,
						matches: r.matches.map((m) => ({ content: m.context })),
					}))
				);
			}
			return results
				.slice(0, limit)
				.map((r) => r.filename)
				.join("\n");
		}

		case "vault": {
			const resp = await restFetch("/");
			const info = (await resp.json()) as { versions: { obsidian: string } };
			const files = await listAllFiles();
			return `Obsidian v${info.versions.obsidian}\n${files.length} files`;
		}

		// ---- Graph / link ----

		case "backlinks": {
			const file = p.file;
			if (!file) throw new Error("file is required");
			const resp = await restFetch(
				`/search/simple/?query=${encodeURIComponent(`[[${file}]]`)}&contextLength=0`,
				{ method: "POST" }
			);
			const results = (await resp.json()) as Array<{ filename: string }>;
			const backlinks = results.map((r) => r.filename.replace(/\.md$/, ""));
			if (p.counts === "true") {
				return backlinks.length > 0 ? backlinks.map((b) => `${b}\t1`).join("\n") : "";
			}
			return backlinks.join("\n");
		}

		case "links": {
			const file = p.file;
			if (!file) throw new Error("file is required");
			const content = await readMarkdown(file);
			return extractWikilinks(content).join("\n");
		}

		case "tags": {
			const file = p.file;
			if (file) {
				const note = await getNoteJson(file);
				return (note.tags ?? []).join("\n");
			}
			// Vault-wide tags: sample up to 50 files
			const mdFiles = (await listAllFiles()).filter((f) => f.endsWith(".md"));
			const tagCounts = new Map<string, number>();
			await Promise.all(
				mdFiles.slice(0, 50).map(async (f) => {
					try {
						const note = await getNoteJson(f.replace(/\.md$/, ""));
						for (const tag of note.tags ?? []) {
							tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
						}
					} catch {
						/* skip */
					}
				})
			);
			const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
			if (p.counts === "true") return sorted.map(([t, c]) => `${t}\t${c}`).join("\n");
			return sorted.map(([t]) => t).join("\n");
		}

		case "outline": {
			const file = p.file;
			if (!file) throw new Error("file is required");
			const docMap = await getDocMap(file);
			return (docMap.headings ?? []).join("\n");
		}

		case "properties": {
			const file = p.file;
			if (!file) throw new Error("file is required");
			const note = await getNoteJson(file);
			const fm = note.frontmatter ?? {};
			if (p.format === "yaml") {
				const lines = ["---"];
				for (const [key, value] of Object.entries(fm)) {
					if (Array.isArray(value)) {
						lines.push(`${key}:`);
						for (const v of value) lines.push(`  - ${v}`);
					} else {
						lines.push(`${key}: ${value}`);
					}
				}
				lines.push("---");
				return lines.join("\n");
			}
			return Object.entries(fm)
				.map(([k, v]) => `${k}: ${v}`)
				.join("\n");
		}

		case "aliases": {
			const file = p.file;
			if (!file) throw new Error("file is required");
			const note = await getNoteJson(file);
			const aliases = (note.frontmatter?.aliases ?? []) as string[];
			return Array.isArray(aliases) ? aliases.join("\n") : "";
		}

		// ---- Graph health (vault-wide scan) ----

		case "orphans": {
			const mdFiles = (await listAllFiles()).filter((f) => f.endsWith(".md"));
			const linked = new Set<string>();
			await Promise.all(
				mdFiles.slice(0, 100).map(async (f) => {
					try {
						const content = await readMarkdown(f.replace(/\.md$/, ""));
						for (const link of extractWikilinks(content)) {
							linked.add(link);
							linked.add(link + ".md");
						}
					} catch {
						/* skip */
					}
				})
			);
			return mdFiles
				.filter((f) => !linked.has(f.replace(/\.md$/, "")) && !linked.has(f))
				.map((f) => f.replace(/\.md$/, ""))
				.join("\n");
		}

		case "deadends": {
			const mdFiles = (await listAllFiles()).filter((f) => f.endsWith(".md"));
			const deadends: string[] = [];
			await Promise.all(
				mdFiles.slice(0, 100).map(async (f) => {
					try {
						const content = await readMarkdown(f.replace(/\.md$/, ""));
						if (extractWikilinks(content).length === 0) deadends.push(f.replace(/\.md$/, ""));
					} catch {
						/* skip */
					}
				})
			);
			return deadends.join("\n");
		}

		case "unresolved": {
			const allFiles = await listAllFiles();
			const fileNames = new Set(allFiles.map((f) => f.replace(/\.md$/, "")));
			const unresolvedCounts = new Map<string, number>();
			await Promise.all(
				allFiles
					.filter((f) => f.endsWith(".md"))
					.slice(0, 100)
					.map(async (f) => {
						try {
							const content = await readMarkdown(f.replace(/\.md$/, ""));
							for (const link of extractWikilinks(content)) {
								if (!fileNames.has(link)) {
									unresolvedCounts.set(link, (unresolvedCounts.get(link) ?? 0) + 1);
								}
							}
						} catch {
							/* skip */
						}
					})
			);
			if (p.counts === "true") {
				return [...unresolvedCounts.entries()]
					.sort((a, b) => b[1] - a[1])
					.map(([link, count]) => `${link}\t${count}`)
					.join("\n");
			}
			return [...unresolvedCounts.keys()].join("\n");
		}

		case "recents": {
			const mdFiles = (await listAllFiles()).filter((f) => f.endsWith(".md"));
			const withMtime: Array<{ file: string; mtime: number }> = [];
			await Promise.all(
				mdFiles.slice(0, 50).map(async (f) => {
					try {
						const note = await getNoteJson(f.replace(/\.md$/, ""));
						withMtime.push({ file: f.replace(/\.md$/, ""), mtime: note.stat.mtime });
					} catch {
						/* skip */
					}
				})
			);
			withMtime.sort((a, b) => b.mtime - a.mtime);
			return withMtime
				.slice(0, 10)
				.map((f) => f.file)
				.join("\n");
		}

		case "tasks": {
			const resp = await restFetch(
				`/search/simple/?query=${encodeURIComponent("- [ ]")}&contextLength=200`,
				{ method: "POST" }
			);
			const results = (await resp.json()) as Array<{
				filename: string;
				matches: Array<{ context: string }>;
			}>;
			const lines: string[] = [];
			for (const r of results) {
				for (const m of r.matches) {
					const taskMatch = m.context.match(/- \[ \] .+/);
					if (taskMatch) lines.push(`${r.filename}: ${taskMatch[0]}`);
				}
			}
			return lines.join("\n");
		}

		// ---- Write ----

		case "create": {
			const name = p.name || p.file;
			if (!name) throw new Error("name is required");
			await restFetch(`/vault/${vaultPath(name)}`, {
				method: "PUT",
				headers: { "Content-Type": "text/markdown" },
				body: p.content ?? "",
			});
			return "";
		}

		case "append": {
			const file = p.file;
			if (!file) throw new Error("file is required");
			await restFetch(`/vault/${vaultPath(file)}`, {
				method: "POST",
				headers: { "Content-Type": "text/markdown" },
				body: p.content ?? "",
			});
			return "";
		}

		case "prepend": {
			const file = p.file;
			if (!file) throw new Error("file is required");
			await restFetch(`/vault/${vaultPath(file)}`, {
				method: "PATCH",
				headers: { "Content-Type": "text/markdown", Operation: "prepend" },
				body: p.content ?? "",
			});
			return "";
		}

		case "property:set": {
			const file = p.file;
			if (!file) throw new Error("file is required");
			if (!p.name) throw new Error("name is required");
			await restFetch(`/vault/${vaultPath(file)}`, {
				method: "PATCH",
				headers: {
					"Content-Type": "application/json",
					Operation: "replace",
					"Target-Type": "frontmatter",
				},
				body: JSON.stringify({ [p.name]: p.value }),
			});
			return "";
		}

		case "property:remove": {
			const file = p.file;
			if (!file) throw new Error("file is required");
			if (!p.name) throw new Error("name is required");
			const note = await getNoteJson(file);
			const fm = { ...(note.frontmatter ?? {}) };
			delete fm[p.name];
			await restFetch(`/vault/${vaultPath(file)}`, {
				method: "PATCH",
				headers: {
					"Content-Type": "application/json",
					Operation: "replace",
					"Target-Type": "frontmatter",
				},
				body: JSON.stringify(fm),
			});
			return "";
		}

		case "move": {
			const file = p.file;
			const to = p.to;
			if (!file || !to) throw new Error("file and to are required");
			const content = await readMarkdown(file);
			await restFetch(`/vault/${vaultPath(to)}`, {
				method: "PUT",
				headers: { "Content-Type": "text/markdown" },
				body: content,
			});
			await restFetch(`/vault/${vaultPath(file)}`, { method: "DELETE" });
			return "";
		}

		case "delete": {
			const file = p.file;
			if (!file) throw new Error("file is required");
			await restFetch(`/vault/${vaultPath(file)}`, { method: "DELETE" });
			return "";
		}

		case "bookmark": {
			throw new Error("Bookmark not available via REST fallback (requires CLI)");
		}

		case "daily:append": {
			await restFetch("/periodic/daily/", {
				method: "POST",
				headers: { "Content-Type": "text/markdown" },
				body: p.content ?? "",
			});
			return "";
		}

		default:
			throw new Error(`Command "${command}" not supported via REST fallback`);
	}
}
