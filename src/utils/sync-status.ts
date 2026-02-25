import { type App, type TFile } from "obsidian";
import { readHonchoFrontmatter } from "./frontmatter";

// ---------------------------------------------------------------------------
// FNV-1a hash (fast, no deps, 8 hex chars)
// ---------------------------------------------------------------------------

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function computeContentHash(content: string): string {
	let hash = FNV_OFFSET;
	for (let i = 0; i < content.length; i++) {
		hash ^= content.charCodeAt(i);
		hash = Math.imul(hash, FNV_PRIME);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Generate an 8-char hex turn ID for linking message pairs.
 * Each ingestion turn (document context + body) shares a turn_id
 * so the pair is queryable as a unit.
 */
export function generateTurnId(sessionId: string): string {
	const seed = `${sessionId}:${Date.now()}`;
	return computeContentHash(seed);
}

/**
 * Strip YAML frontmatter from markdown content.
 * Returns only the body so hash is stable across frontmatter-only edits.
 */
export function stripFrontmatter(content: string): string {
	return content.replace(/^---[\s\S]*?---\n*/, "");
}

const HONCHO_SECTION_RE = /\n## Honcho\n[\s\S]*$/;

/**
 * Strip the `## Honcho` feedback section from note content.
 */
export function stripHonchoSection(content: string): string {
	return content.replace(HONCHO_SECTION_RE, "");
}

/**
 * Strip both frontmatter and the Honcho feedback section.
 * Use this everywhere content is prepared for ingestion or hashing
 * so Honcho never sees its own output and hashes are stable.
 */
export function stripForIngestion(content: string): string {
	return stripHonchoSection(stripFrontmatter(content));
}

// ---------------------------------------------------------------------------
// Sync status
// ---------------------------------------------------------------------------

export type SyncReason = "new" | "modified" | "unchanged";

export interface SyncStatus {
	needsSync: boolean;
	reason: SyncReason;
	contentHash: string;
	mtime: number;
}

export interface StalenessInfo {
	file: TFile;
	lastSynced: string;
	lastModified: number;
	contentHash: string;
	storedHash: string;
}

/**
 * Compare a file's current state against its stored sync metadata.
 * Hash is computed on body AFTER stripping frontmatter and the Honcho
 * feedback section, preventing re-ingestion from either write path.
 */
export async function checkSyncStatus(app: App, file: TFile): Promise<SyncStatus> {
	const fm = readHonchoFrontmatter(app, file);
	const rawContent = await app.vault.cachedRead(file);
	const body = stripForIngestion(rawContent);
	const contentHash = computeContentHash(body);

	if (!fm.synced) {
		return { needsSync: true, reason: "new", contentHash, mtime: file.stat.mtime };
	}

	if (fm.hash && fm.hash !== contentHash) {
		return { needsSync: true, reason: "modified", contentHash, mtime: file.stat.mtime };
	}

	if (!fm.hash) {
		const syncedTime = new Date(fm.synced).getTime();
		if (file.stat.mtime > syncedTime) {
			return { needsSync: true, reason: "modified", contentHash, mtime: file.stat.mtime };
		}
	}

	return { needsSync: false, reason: "unchanged", contentHash, mtime: file.stat.mtime };
}

// ---------------------------------------------------------------------------
// Batch operations
// ---------------------------------------------------------------------------

export interface PartitionResult {
	needsSync: Array<{ file: TFile; status: SyncStatus }>;
	skipped: Array<{ file: TFile; status: SyncStatus }>;
	counts: { new: number; modified: number; unchanged: number };
}

export async function partitionByStatus(app: App, files: TFile[]): Promise<PartitionResult> {
	const needsSync: Array<{ file: TFile; status: SyncStatus }> = [];
	const skipped: Array<{ file: TFile; status: SyncStatus }> = [];
	const counts = { new: 0, modified: 0, unchanged: 0 };

	for (const file of files) {
		const status = await checkSyncStatus(app, file);
		counts[status.reason]++;
		if (status.needsSync) {
			needsSync.push({ file, status });
		} else {
			skipped.push({ file, status });
		}
	}

	return { needsSync, skipped, counts };
}

/**
 * Find all notes in the vault that have been ingested but modified since.
 */
export async function findStaleNotes(app: App): Promise<StalenessInfo[]> {
	const stale: StalenessInfo[] = [];

	for (const file of app.vault.getMarkdownFiles()) {
		const fm = readHonchoFrontmatter(app, file);
		if (!fm.synced) continue;

		const rawContent = await app.vault.cachedRead(file);
		const body = stripForIngestion(rawContent);
		const contentHash = computeContentHash(body);

		let isStale = false;

		if (fm.hash) {
			isStale = fm.hash !== contentHash;
		} else {
			const syncedTime = new Date(fm.synced).getTime();
			isStale = file.stat.mtime > syncedTime;
		}

		if (isStale) {
			stale.push({
				file,
				lastSynced: fm.synced,
				lastModified: file.stat.mtime,
				contentHash,
				storedHash: fm.hash ?? "",
			});
		}
	}

	return stale;
}
