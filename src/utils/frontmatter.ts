import { type App, type TFile } from "obsidian";

export interface HonchoFrontmatter {
	honcho_synced?: string;
	honcho_session_id?: string;
	honcho_message_count?: number;
	honcho_content_hash?: string;
}

/**
 * Read Honcho-specific frontmatter from a note.
 */
export function readHonchoFrontmatter(app: App, file: TFile): HonchoFrontmatter {
	const cache = app.metadataCache.getFileCache(file);
	const fm = cache?.frontmatter;
	if (!fm) return {};

	return {
		honcho_synced: fm.honcho_synced as string | undefined,
		honcho_session_id: fm.honcho_session_id as string | undefined,
		honcho_message_count: fm.honcho_message_count as number | undefined,
		honcho_content_hash: fm.honcho_content_hash as string | undefined,
	};
}

/**
 * Write Honcho tracking data into note frontmatter.
 */
export async function writeHonchoFrontmatter(
	app: App,
	file: TFile,
	data: HonchoFrontmatter
): Promise<void> {
	await app.fileManager.processFrontMatter(file, (fm) => {
		if (data.honcho_synced !== undefined) {
			fm.honcho_synced = data.honcho_synced;
		}
		if (data.honcho_session_id !== undefined) {
			fm.honcho_session_id = data.honcho_session_id;
		}
		if (data.honcho_message_count !== undefined) {
			fm.honcho_message_count = data.honcho_message_count;
		}
		if (data.honcho_content_hash !== undefined) {
			fm.honcho_content_hash = data.honcho_content_hash;
		}
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

	// Check folder
	if (folders.length > 0) {
		const inFolder = folders.some(
			(f) => file.path.startsWith(f + "/") || file.path === f
		);
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
