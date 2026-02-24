import { type App, type TFile } from "obsidian";

export interface HonchoFrontmatter {
	synced?: string;
	session?: string;
	hash?: string;
	feedback?: boolean;
}

/** Legacy key names used before the rename. Reader accepts both. */
const LEGACY_KEYS: Record<string, keyof HonchoFrontmatter> = {
	honcho_synced: "synced",
	honcho_session_id: "session",
	honcho_content_hash: "hash",
	honcho_feedback: "feedback",
};

/**
 * Read Honcho-specific frontmatter from a note.
 * Accepts both new keys (synced, session, hash, feedback) and legacy
 * honcho_* keys for migration. New keys take precedence.
 */
export function readHonchoFrontmatter(app: App, file: TFile): HonchoFrontmatter {
	const cache = app.metadataCache.getFileCache(file);
	const fm = cache?.frontmatter;
	if (!fm) return {};

	return {
		synced: (fm.synced ?? fm.honcho_synced) as string | undefined,
		session: (fm.session ?? fm.honcho_session_id) as string | undefined,
		hash: (fm.hash ?? fm.honcho_content_hash) as string | undefined,
		feedback: typeof fm.feedback === "boolean" ? fm.feedback
			: typeof fm.honcho_feedback === "boolean" ? fm.honcho_feedback
			: undefined,
	};
}

/**
 * Write Honcho tracking data into note frontmatter.
 * Writes new keys and removes legacy honcho_* keys if present.
 */
export async function writeHonchoFrontmatter(
	app: App,
	file: TFile,
	data: HonchoFrontmatter
): Promise<void> {
	await app.fileManager.processFrontMatter(file, (fm) => {
		if (data.synced !== undefined) fm.synced = data.synced;
		if (data.session !== undefined) fm.session = data.session;
		if (data.hash !== undefined) fm.hash = data.hash;

		// Clean up legacy keys
		delete fm.honcho_synced;
		delete fm.honcho_session_id;
		delete fm.honcho_message_count;
		delete fm.honcho_content_hash;
		delete fm.honcho_feedback;
	});
}

/**
 * Safely coerce frontmatter tags to a string array.
 * Obsidian allows `tags: foo` (string) or `tags: [foo, bar]` (array).
 */
export function normalizeFrontmatterTags(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.map(String);
	if (typeof raw === "string") return [raw];
	return [];
}

/**
 * Check whether a file's tags or folder match the auto-sync filters.
 */
export function matchesSyncFilters(
	app: App,
	file: TFile,
	tags: string[],
	folders: string[]
): boolean {
	// If no filters configured, everything matches
	if (tags.length === 0 && folders.length === 0) return true;

	// Check folder (strip trailing slashes to handle user input like "notes/")
	if (folders.length > 0) {
		const inFolder = folders.some((f) => {
			const normalized = f.replace(/\/+$/, "");
			return normalized && file.path.startsWith(normalized + "/");
		});
		if (inFolder) return true;
	}

	// Check tags
	if (tags.length > 0) {
		const cache = app.metadataCache.getFileCache(file);
		const fileTags = (cache?.tags ?? []).map((t) => t.tag.toLowerCase());
		const fmTags = normalizeFrontmatterTags(cache?.frontmatter?.tags).map(
			(t) => (t.startsWith("#") ? t : "#" + t).toLowerCase()
		);
		const allTags = [...fileTags, ...fmTags];
		const matchTag = tags.some((t) => {
			const normalized = (t.startsWith("#") ? t : "#" + t).toLowerCase();
			return allTags.includes(normalized);
		});
		if (matchTag) return true;
	}

	return false;
}
