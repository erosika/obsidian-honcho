import { type App, type TFile } from "obsidian";
import { countBacklinks } from "../commands/ingest";

export type IngestHandler = (file: TFile) => Promise<void>;

interface QueueEntry {
	file: TFile;
	enqueuedAt: number;
	priority: number;
	retryCount: number;
}

const DEBOUNCE_MS = 5000;
const BATCH_SIZE = 3;
const NEW_FILE_BONUS = 50;
const MAX_QUEUE_RETRIES = 2;
const RETRY_PRIORITY_DECAY = 10;

/**
 * Priority-based auto-sync queue.
 * Replaces the naive per-file debounce timers with a centralized queue that:
 *   - Debounces internally (same 5s window per file)
 *   - Processes in priority order: backlink count + new-file bonus
 *   - Batches to avoid API hammering
 *   - Reschedules if entries remain after a flush
 */
export class SyncQueue {
	private pending = new Map<string, QueueEntry>();
	private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private processing = false;
	private app: App;
	private handler: IngestHandler;

	constructor(app: App, handler: IngestHandler) {
		this.app = app;
		this.handler = handler;
	}

	enqueue(file: TFile): void {
		// Clear existing debounce for this file
		const existing = this.debounceTimers.get(file.path);
		if (existing) clearTimeout(existing);

		const timer = setTimeout(() => {
			this.debounceTimers.delete(file.path);
			this.addToPending(file);
		}, DEBOUNCE_MS);

		this.debounceTimers.set(file.path, timer);
	}

	private addToPending(file: TFile, retryCount = 0, priorityOverride?: number): void {
		const priority = priorityOverride ?? this.computePriority(file);
		this.pending.set(file.path, {
			file,
			enqueuedAt: Date.now(),
			priority,
			retryCount,
		});
		this.scheduleFlush();
	}

	private computePriority(file: TFile): number {
		let priority = countBacklinks(this.app, file);

		// New file bonus: files not yet synced get prioritized
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter;
		if (!fm?.honcho_synced) {
			priority += NEW_FILE_BONUS;
		}

		return priority;
	}

	private scheduleFlush(): void {
		if (this.flushTimer || this.processing) return;
		// Flush on next tick to batch concurrent enqueues
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			this.flush();
		}, 100);
	}

	private async flush(): Promise<void> {
		if (this.processing || this.pending.size === 0) return;
		this.processing = true;

		try {
			// Sort by priority descending, take a batch
			const entries = Array.from(this.pending.values())
				.sort((a, b) => b.priority - a.priority);

			const batch = entries.slice(0, BATCH_SIZE);

			for (const entry of batch) {
				this.pending.delete(entry.file.path);
			}

			// Process batch concurrently
			const results = await Promise.allSettled(
				batch.map((entry) => this.handler(entry.file))
			);

			// Re-enqueue failures with decayed priority
			for (let i = 0; i < results.length; i++) {
				if (results[i].status === "rejected") {
					const entry = batch[i];
					const nextRetry = entry.retryCount + 1;
					if (nextRetry <= MAX_QUEUE_RETRIES) {
						this.addToPending(
							entry.file,
							nextRetry,
							entry.priority - RETRY_PRIORITY_DECAY
						);
					}
					// else: dropped after max retries (HTTP layer already retried 3x per attempt)
				}
			}
		} finally {
			this.processing = false;
		}

		// Reschedule if entries remain
		if (this.pending.size > 0) {
			this.scheduleFlush();
		}
	}

	/** Remove a file from all queue stages (debounce + pending). */
	remove(path: string): void {
		const timer = this.debounceTimers.get(path);
		if (timer) {
			clearTimeout(timer);
			this.debounceTimers.delete(path);
		}
		this.pending.delete(path);
	}

	get size(): number {
		return this.pending.size + this.debounceTimers.size;
	}

	clear(): void {
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();
		this.pending.clear();
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
	}
}
