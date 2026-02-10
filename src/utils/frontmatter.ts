import { type App, type TFile } from "obsidian";

export interface HonchoFrontmatter {
	honcho_synced?: string;
	honcho_conclusion_ids?: string[];
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
		honcho_conclusion_ids: fm.honcho_conclusion_ids as string[] | undefined,
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
		if (data.honcho_conclusion_ids !== undefined) {
			fm.honcho_conclusion_ids = data.honcho_conclusion_ids;
		}
	});
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
		const fmTags = ((cache?.frontmatter?.tags as string[]) ?? []).map(
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
