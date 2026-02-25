/**
 * Filesystem transport -- direct vault access via Bun file APIs.
 *
 * Final fallback when neither CLI nor REST is available.
 * Always works if the vault path is known (OBSIDIAN_VAULT_PATH).
 *
 * Capabilities vs CLI/REST:
 *   read, files, file, tags, links, properties, aliases, outline -- full
 *   search -- basic (grep-style, no ranking)
 *   backlinks -- full (but requires scanning all files)
 *   orphans, deadends, unresolved -- full (derived from scanning)
 *   recents -- full (from mtime)
 *   tasks -- full (grep for "- [ ]")
 *   create, append, prepend, property:set, property:remove, delete, move -- full
 *   bookmark, daily:append -- not available
 *   vault -- partial (file count only, no Obsidian version)
 */

import { readdir, stat } from "node:fs/promises";
import { join, relative, basename, dirname, extname } from "node:path";

// ---------------------------------------------------------------------------
// Vault path resolution
// ---------------------------------------------------------------------------

let vaultPath: string | null = null;

export function setVaultPath(path: string): void {
	vaultPath = path;
}

function getVaultPath(): string {
	if (!vaultPath) {
		throw new Error(
			"Vault path not set. Set OBSIDIAN_VAULT_PATH environment variable " +
			"or ensure Obsidian CLI/REST is available."
		);
	}
	return vaultPath;
}

function resolvePath(file: string): string {
	const vault = getVaultPath();
	const normalized = file.endsWith(".md") ? file : `${file}.md`;
	return join(vault, normalized);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively list all files in a directory */
async function walkDir(dir: string): Promise<string[]> {
	const files: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.name.startsWith(".")) continue; // skip hidden dirs (.obsidian, .trash)
		if (entry.isDirectory()) {
			files.push(...await walkDir(fullPath));
		} else {
			files.push(fullPath);
		}
	}
	return files;
}

/** Parse YAML frontmatter from markdown content */
function parseFrontmatter(content: string): Record<string, unknown> {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return {};

	const yaml = match[1];
	const result: Record<string, unknown> = {};

	let currentKey = "";
	let currentArray: string[] | null = null;

	for (const line of yaml.split("\n")) {
		// Array item
		if (line.match(/^\s+-\s+/)) {
			const value = line.replace(/^\s+-\s+/, "").trim();
			if (currentArray) {
				currentArray.push(value);
			}
			continue;
		}

		// Flush previous array
		if (currentArray && currentKey) {
			result[currentKey] = currentArray;
			currentArray = null;
		}

		const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)/);
		if (kvMatch) {
			currentKey = kvMatch[1];
			const value = kvMatch[2].trim();

			if (value === "") {
				// Could be start of array
				currentArray = [];
			} else if (value === "true") {
				result[currentKey] = true;
			} else if (value === "false") {
				result[currentKey] = false;
			} else if (/^-?\d+(\.\d+)?$/.test(value)) {
				result[currentKey] = Number(value);
			} else {
				result[currentKey] = value;
			}
		}
	}

	// Flush final array
	if (currentArray && currentKey) {
		result[currentKey] = currentArray;
	}

	return result;
}

/** Strip YAML frontmatter from content */
function stripFrontmatter(content: string): string {
	return content.replace(/^---[\s\S]*?---\n*/, "");
}

/** Extract [[wikilinks]] from markdown content */
function extractWikilinks(content: string): string[] {
	const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
	const links = new Set<string>();
	let match;
	while ((match = re.exec(content)) !== null) links.add(match[1]);
	return [...links];
}

/** Extract #tags from content (both inline and frontmatter) */
function extractTags(content: string, frontmatter: Record<string, unknown>): string[] {
	const tags = new Set<string>();

	// Frontmatter tags
	const fmTags = frontmatter.tags;
	if (Array.isArray(fmTags)) {
		for (const t of fmTags) {
			const tag = String(t);
			tags.add(tag.startsWith("#") ? tag : `#${tag}`);
		}
	} else if (typeof fmTags === "string") {
		tags.add(fmTags.startsWith("#") ? fmTags : `#${fmTags}`);
	}

	// Inline tags (not inside code blocks or frontmatter)
	const body = stripFrontmatter(content);
	const tagRe = /(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)/g;
	let tagMatch;
	while ((tagMatch = tagRe.exec(body)) !== null) {
		tags.add(`#${tagMatch[1]}`);
	}

	return [...tags];
}

/** Extract headings from markdown */
function extractHeadings(content: string): string[] {
	const body = stripFrontmatter(content);
	const headings: string[] = [];
	for (const line of body.split("\n")) {
		const match = line.match(/^(#{1,6})\s+(.+)/);
		if (match) {
			headings.push(`${match[1]} ${match[2]}`);
		}
	}
	return headings;
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

/**
 * Execute an Obsidian command via direct filesystem access.
 * Maps CLI commands to file operations.
 */
export async function execFs(
	command: string,
	args: Record<string, string | number | boolean | undefined> = {},
	_vaultName?: string
): Promise<string> {
	const vault = getVaultPath();

	// Parse args the same way as REST transport
	const p: Record<string, string> = {};
	for (const [key, value] of Object.entries(args)) {
		if (value === undefined || value === null || value === false) continue;
		const eqIdx = key.indexOf("=");
		if (eqIdx > 0 && value === true) {
			p[key.slice(0, eqIdx)] = key.slice(eqIdx + 1);
		} else if (value === true) {
			p[key] = "true";
		} else {
			p[key] = String(value);
		}
	}

	switch (command) {
		// ---- Read ----

		case "read": {
			const file = p.file || p.path;
			if (!file) throw new Error("file is required");
			const content = await Bun.file(resolvePath(file)).text();
			return content.trim();
		}

		case "file": {
			const file = p.file || p.path;
			if (!file) throw new Error("file is required");
			const fullPath = resolvePath(file);
			const s = await stat(fullPath);
			const folder = dirname(relative(vault, fullPath));
			return [
				`path: ${relative(vault, fullPath)}`,
				`name: ${basename(fullPath, ".md")}`,
				`folder: ${folder === "." ? "/" : folder}`,
				`size: ${s.size}`,
				`created: ${new Date(s.birthtime).toISOString()}`,
				`modified: ${new Date(s.mtime).toISOString()}`,
			].join("\n");
		}

		case "files": {
			let files = await walkDir(vault);
			files = files.map((f) => relative(vault, f));

			if (p.folder) files = files.filter((f) => f.startsWith(p.folder + "/") || dirname(f) === p.folder);
			if (p.ext) files = files.filter((f) => extname(f) === `.${p.ext}`);
			if (p.total === "true") return String(files.length);
			return files.join("\n");
		}

		case "search": {
			const query = p.query;
			if (!query) throw new Error("query is required");
			const limit = parseInt(p.limit ?? "10", 10);
			const allFiles = await walkDir(vault);
			const mdFiles = allFiles.filter((f) => f.endsWith(".md"));
			const queryLower = query.toLowerCase();
			const matches: Array<{ file: string; preview: string }> = [];

			for (const fullPath of mdFiles) {
				if (matches.length >= limit) break;
				try {
					const content = await Bun.file(fullPath).text();
					const idx = content.toLowerCase().indexOf(queryLower);
					if (idx >= 0) {
						const start = Math.max(0, idx - 50);
						const end = Math.min(content.length, idx + query.length + 150);
						matches.push({
							file: relative(vault, fullPath),
							preview: content.slice(start, end).replace(/\n/g, " ").trim(),
						});
					}
				} catch { /* skip unreadable */ }
			}

			if (p.format === "json") {
				return JSON.stringify(matches.map((m) => ({
					file: m.file,
					matches: [{ content: m.preview }],
				})));
			}
			return matches.map((m) => m.file).join("\n");
		}

		case "vault": {
			const files = await walkDir(vault);
			return `${files.length} files`;
		}

		case "version": {
			return "filesystem-fallback";
		}

		// ---- Graph / link ----

		case "backlinks": {
			const file = p.file;
			if (!file) throw new Error("file is required");
			const allFiles = await walkDir(vault);
			const mdFiles = allFiles.filter((f) => f.endsWith(".md"));
			const target = file.replace(/\.md$/, "");
			const backlinks: string[] = [];

			for (const fullPath of mdFiles) {
				const relPath = relative(vault, fullPath);
				if (relPath.replace(/\.md$/, "") === target) continue;
				try {
					const content = await Bun.file(fullPath).text();
					const links = extractWikilinks(content);
					if (links.some((l) => l === target || l === file)) {
						backlinks.push(relPath.replace(/\.md$/, ""));
					}
				} catch { /* skip */ }
			}

			if (p.counts === "true") {
				return backlinks.map((b) => `${b}\t1`).join("\n");
			}
			return backlinks.join("\n");
		}

		case "links": {
			const file = p.file;
			if (!file) throw new Error("file is required");
			const content = await Bun.file(resolvePath(file)).text();
			return extractWikilinks(content).join("\n");
		}

		case "tags": {
			const file = p.file;
			if (file) {
				const content = await Bun.file(resolvePath(file)).text();
				const fm = parseFrontmatter(content);
				return extractTags(content, fm).join("\n");
			}
			// Vault-wide tags
			const allFiles = await walkDir(vault);
			const mdFiles = allFiles.filter((f) => f.endsWith(".md"));
			const tagCounts = new Map<string, number>();
			for (const fullPath of mdFiles) {
				try {
					const content = await Bun.file(fullPath).text();
					const fm = parseFrontmatter(content);
					for (const tag of extractTags(content, fm)) {
						tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
					}
				} catch { /* skip */ }
			}
			const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
			if (p.counts === "true") return sorted.map(([t, c]) => `${t}\t${c}`).join("\n");
			return sorted.map(([t]) => t).join("\n");
		}

		case "outline": {
			const file = p.file;
			if (!file) throw new Error("file is required");
			const content = await Bun.file(resolvePath(file)).text();
			const headings = extractHeadings(content);
			if (p.format === "tree") {
				return headings.map((h) => {
					const level = (h.match(/^#+/) ?? [""])[0].length;
					return "  ".repeat(level - 1) + h.replace(/^#+\s*/, "");
				}).join("\n");
			}
			return headings.join("\n");
		}

		case "properties": {
			const file = p.file;
			if (!file) throw new Error("file is required");
			const content = await Bun.file(resolvePath(file)).text();
			const fm = parseFrontmatter(content);
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
			return Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n");
		}

		case "aliases": {
			const file = p.file;
			if (!file) throw new Error("file is required");
			const content = await Bun.file(resolvePath(file)).text();
			const fm = parseFrontmatter(content);
			const aliases = fm.aliases;
			if (Array.isArray(aliases)) return aliases.map(String).join("\n");
			if (typeof aliases === "string") return aliases;
			return "";
		}

		// ---- Graph health ----

		case "orphans": {
			const allFiles = await walkDir(vault);
			const mdFiles = allFiles.filter((f) => f.endsWith(".md"));
			const linked = new Set<string>();
			for (const fullPath of mdFiles) {
				try {
					const content = await Bun.file(fullPath).text();
					for (const link of extractWikilinks(content)) {
						linked.add(link);
					}
				} catch { /* skip */ }
			}
			return mdFiles
				.map((f) => relative(vault, f).replace(/\.md$/, ""))
				.filter((f) => !linked.has(f) && !linked.has(basename(f)))
				.join("\n");
		}

		case "deadends": {
			const allFiles = await walkDir(vault);
			const mdFiles = allFiles.filter((f) => f.endsWith(".md"));
			const deadends: string[] = [];
			for (const fullPath of mdFiles) {
				try {
					const content = await Bun.file(fullPath).text();
					if (extractWikilinks(content).length === 0) {
						deadends.push(relative(vault, fullPath).replace(/\.md$/, ""));
					}
				} catch { /* skip */ }
			}
			return deadends.join("\n");
		}

		case "unresolved": {
			const allFiles = await walkDir(vault);
			const fileNames = new Set(
				allFiles.map((f) => relative(vault, f).replace(/\.md$/, ""))
			);
			const baseNames = new Set(
				allFiles.map((f) => basename(f, ".md"))
			);
			const unresolvedCounts = new Map<string, number>();
			const mdFiles = allFiles.filter((f) => f.endsWith(".md"));
			for (const fullPath of mdFiles) {
				try {
					const content = await Bun.file(fullPath).text();
					for (const link of extractWikilinks(content)) {
						if (!fileNames.has(link) && !baseNames.has(link)) {
							unresolvedCounts.set(link, (unresolvedCounts.get(link) ?? 0) + 1);
						}
					}
				} catch { /* skip */ }
			}
			if (p.counts === "true") {
				return [...unresolvedCounts.entries()]
					.sort((a, b) => b[1] - a[1])
					.map(([link, count]) => `${link}\t${count}`)
					.join("\n");
			}
			return [...unresolvedCounts.keys()].join("\n");
		}

		case "recents": {
			const allFiles = await walkDir(vault);
			const mdFiles = allFiles.filter((f) => f.endsWith(".md"));
			const withMtime: Array<{ file: string; mtime: number }> = [];
			for (const fullPath of mdFiles) {
				try {
					const s = await stat(fullPath);
					withMtime.push({
						file: relative(vault, fullPath).replace(/\.md$/, ""),
						mtime: s.mtime.getTime(),
					});
				} catch { /* skip */ }
			}
			withMtime.sort((a, b) => b.mtime - a.mtime);
			return withMtime.slice(0, 10).map((f) => f.file).join("\n");
		}

		case "tasks": {
			const allFiles = await walkDir(vault);
			const mdFiles = allFiles.filter((f) => f.endsWith(".md"));
			const lines: string[] = [];
			for (const fullPath of mdFiles) {
				try {
					const content = await Bun.file(fullPath).text();
					const relPath = relative(vault, fullPath).replace(/\.md$/, "");
					for (const line of content.split("\n")) {
						if (line.match(/^\s*- \[ \] /)) {
							lines.push(`${relPath}: ${line.trim()}`);
						}
					}
				} catch { /* skip */ }
			}
			return lines.join("\n");
		}

		// ---- Write ----

		case "create": {
			const name = p.name || p.file;
			if (!name) throw new Error("name is required");
			await Bun.write(resolvePath(name), p.content ?? "");
			return "";
		}

		case "append": {
			const file = p.file;
			if (!file) throw new Error("file is required");
			const fullPath = resolvePath(file);
			const existing = await Bun.file(fullPath).text();
			const separator = p.inline === "true" ? "" : "\n";
			await Bun.write(fullPath, existing + separator + (p.content ?? ""));
			return "";
		}

		case "prepend": {
			const file = p.file;
			if (!file) throw new Error("file is required");
			const fullPath = resolvePath(file);
			const existing = await Bun.file(fullPath).text();
			const separator = p.inline === "true" ? "" : "\n";
			// Prepend after frontmatter if present
			const fmMatch = existing.match(/^(---[\s\S]*?---\n)/);
			if (fmMatch) {
				await Bun.write(fullPath, fmMatch[1] + (p.content ?? "") + separator + existing.slice(fmMatch[1].length));
			} else {
				await Bun.write(fullPath, (p.content ?? "") + separator + existing);
			}
			return "";
		}

		case "property:set": {
			const file = p.file;
			if (!file) throw new Error("file is required");
			if (!p.name) throw new Error("name is required");
			const fullPath = resolvePath(file);
			const content = await Bun.file(fullPath).text();
			const fm = parseFrontmatter(content);
			fm[p.name] = p.value ?? "";

			// Rebuild frontmatter
			const fmLines = ["---"];
			for (const [key, value] of Object.entries(fm)) {
				if (Array.isArray(value)) {
					fmLines.push(`${key}:`);
					for (const v of value) fmLines.push(`  - ${v}`);
				} else {
					fmLines.push(`${key}: ${value}`);
				}
			}
			fmLines.push("---");

			const body = stripFrontmatter(content);
			await Bun.write(fullPath, fmLines.join("\n") + "\n" + body);
			return "";
		}

		case "property:remove": {
			const file = p.file;
			if (!file) throw new Error("file is required");
			if (!p.name) throw new Error("name is required");
			const fullPath = resolvePath(file);
			const content = await Bun.file(fullPath).text();
			const fm = parseFrontmatter(content);
			delete fm[p.name];

			const fmLines = ["---"];
			for (const [key, value] of Object.entries(fm)) {
				if (Array.isArray(value)) {
					fmLines.push(`${key}:`);
					for (const v of value) fmLines.push(`  - ${v}`);
				} else {
					fmLines.push(`${key}: ${value}`);
				}
			}
			fmLines.push("---");

			const body = stripFrontmatter(content);
			await Bun.write(fullPath, fmLines.join("\n") + "\n" + body);
			return "";
		}

		case "move": {
			const file = p.file;
			const to = p.to;
			if (!file || !to) throw new Error("file and to are required");
			const content = await Bun.file(resolvePath(file)).text();
			await Bun.write(resolvePath(to), content);
			const { unlink } = await import("node:fs/promises");
			await unlink(resolvePath(file));
			return "";
		}

		case "delete": {
			const file = p.file;
			if (!file) throw new Error("file is required");
			const { unlink } = await import("node:fs/promises");
			await unlink(resolvePath(file));
			return "";
		}

		case "bookmark":
			throw new Error("Bookmark not available via filesystem fallback (requires CLI)");

		case "daily:append":
			throw new Error("Daily note append not available via filesystem fallback (requires CLI or REST)");

		default:
			throw new Error(`Command "${command}" not supported via filesystem fallback`);
	}
}

/**
 * Probe filesystem availability by checking if the vault path exists
 * and contains at least one .md file.
 */
export async function probeFs(): Promise<boolean> {
	if (!vaultPath) return false;
	try {
		const s = await stat(vaultPath);
		if (!s.isDirectory()) return false;
		const entries = await readdir(vaultPath);
		return entries.some((e) => e.endsWith(".md") || !e.startsWith("."));
	} catch {
		return false;
	}
}
