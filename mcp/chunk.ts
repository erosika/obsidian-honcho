/**
 * Chunk markdown text at heading and paragraph boundaries.
 * Each chunk is a self-contained section suitable for ingestion.
 *
 * Strategy:
 *   1. Split on headings (any level).
 *   2. If a section exceeds maxLen, split further on double-newlines (paragraphs).
 *   3. If a paragraph still exceeds maxLen, hard-split on sentence boundaries.
 *
 * Copied from src/utils/chunker.ts for standalone MCP server use.
 */

const HEADING_RE = /^#{1,6}\s/m;
const MAX_CHUNK_LEN = 2000;

export function chunkMarkdown(text: string, maxLen = MAX_CHUNK_LEN): string[] {
	const stripped = text.replace(/^---[\s\S]*?---\n*/, "");
	if (stripped.trim().length === 0) return [];

	const sections = splitOnHeadings(stripped);
	const chunks: string[] = [];

	for (const section of sections) {
		if (section.length <= maxLen) {
			chunks.push(section.trim());
			continue;
		}
		const paragraphs = section.split(/\n{2,}/);
		let buf = "";
		for (const para of paragraphs) {
			if (buf.length + para.length + 2 > maxLen && buf.length > 0) {
				chunks.push(buf.trim());
				buf = "";
			}
			if (para.length > maxLen) {
				if (buf.length > 0) {
					chunks.push(buf.trim());
					buf = "";
				}
				for (const sentence of splitSentences(para, maxLen)) {
					chunks.push(sentence.trim());
				}
			} else {
				buf += (buf ? "\n\n" : "") + para;
			}
		}
		if (buf.trim().length > 0) chunks.push(buf.trim());
	}

	return chunks.filter((c) => c.length > 0);
}

function splitOnHeadings(text: string): string[] {
	const parts: string[] = [];
	const lines = text.split("\n");
	let current = "";

	for (const line of lines) {
		if (HEADING_RE.test(line) && current.trim().length > 0) {
			parts.push(current);
			current = line + "\n";
		} else {
			current += line + "\n";
		}
	}
	if (current.trim().length > 0) parts.push(current);

	return parts;
}

function splitSentences(text: string, maxLen: number): string[] {
	const sentences = text.match(/[^.!?]+[.!?]+\s*/g) || [text];
	const out: string[] = [];
	let buf = "";

	for (const s of sentences) {
		if (buf.length + s.length > maxLen && buf.length > 0) {
			out.push(buf);
			buf = "";
		}
		buf += s;
	}
	if (buf.length > 0) out.push(buf);

	return out;
}
