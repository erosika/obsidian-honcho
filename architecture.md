# obsidian-honcho: Architecture

> How the act of writing becomes identity. A bidirectional bridge between Obsidian's structural knowledge and Honcho's memory platform.

**Repository:** erosika/obsidian-honcho
**Stack:** TypeScript / Obsidian Plugin
**Version:** 0.1.0
**Date:** February 2026

---

## Contents

01. [Data Flow & Core Thesis](#data-flow--core-thesis)
02. [Ingestion & Structural Signals](#ingestion--structural-signals)
04. [Observation & Dreaming](#observation--dreaming)
05. [Peer Architecture](#peer-architecture)
06. [Sync Intelligence](#sync-intelligence)
07. [Feedback Loop](#feedback-loop)
08. [Streaming Chat](#streaming-chat)
09. [Sidebar & Rendering](#sidebar--rendering)
10. [Session Lifecycle](#session-lifecycle)
11. [Configuration](#configuration)
12. [File Structure](#file-structure)
13. [Progress](#progress)
14. [Demo: First Note to Identity](#demo-first-note-to-identity)
15. [CLI & MCP Server](#cli--mcp-server)
16. [P.S. -- API Surface](#ps----api-surface)

---

## Data Flow & Core Thesis

Every note, tag, link, and folder is a signal about who you are and how you think. The plugin makes that signal legible to Honcho -- and Honcho feeds back consolidated identity. Two ingestion paths: the **plugin** runs inside Obsidian's runtime via REST API calls; the **MCP server** (`mcp/`) runs as a standalone Bun process, wrapping the Obsidian CLI for external agents. Both feed the same Honcho workspace.

```
Vault --strip + hash--> Sessions --> Observe + Dream --> Conclusions --> Represent --sync back--> Vault
                                                              |                         ^
                                                              +------- feedback --------+
                                                                                    Represent <--> Chat
```

### Vault -> Honcho

- **Strip** -- `stripForIngestion()` removes frontmatter + any existing `## Honcho` feedback section before hashing or sending
- **Hash** -- FNV-1a (8 hex chars) on the stripped body. Unchanged content is skipped
- **Preamble** -- structural context (tags, links, backlinks, graph position, headings, dates, custom properties) as the first session message
- **Chunk** -- markdown split at heading/paragraph/sentence boundaries (~2000 chars), each as a message
- **Session** -- deterministic ID `obsidian:file:{path}`. Re-ingest deletes and recreates the session fresh

### Honcho -> Vault

- **Frontmatter** -- `honcho_synced`, `honcho_session_id`, `honcho_message_count`, `honcho_content_hash` written atomically
- **Identity notes** -- peer card + representation as vault documents, tagged `#honcho/identity`
- **Conclusions notes** -- all observations pulled into a document, tagged `#honcho/conclusions`
- **Feedback section** -- `## Honcho` appended to ingested notes with relevant conclusions
- **Chat** -- streaming dialectic grounded in vault-derived identity, saveable as notes or appended to the daily note

---


## Ingestion & Structural Signals

Every ingested note begins with a structural preamble -- a machine-readable summary of the note's position in the knowledge graph. This grounds every subsequent content chunk in context.

### Preamble format

```
[Note: Core Values]
Aliases: core-values, CV
Folder: identity/core
Tags: #identity, #philosophy, #values
status: active
Structure: # Core Values > ## Integrity > ## Curiosity
Links to: Stoicism, Marcus Aurelius
Referenced by: Daily Notes/2026-02-01, Vision Document
Backlink count: 7
Graph position: hub
Created: 2025-11-15
Modified: 2026-02-09
```

### Signals extracted

| Signal | Source |
|--------|--------|
| Tags | `metadataCache.tags` + frontmatter |
| Aliases, custom properties | All frontmatter keys minus internal keys |
| Headings | `cache.headings[]` |
| Outgoing links | `cache.links[]` |
| Backlinks + count | Inverted `resolvedLinks` |
| Graph position | Computed: `hub` / `orphan` / `dead-end` / `isolated` / `connected` |
| Unresolved links | Wiki-links with no target file |
| Folder, created, modified | `file.parent.path`, `file.stat` |

### Graph-aware traversal

"Ingest + linked notes" does BFS over outgoing wiki-links up to configurable depth (1--3). Links resolved via `getFirstLinkpathDest()`; only `.md` files followed. Each file respects sync status -- unchanged files skipped. A dream is scheduled after traversal completes.

### Batch ingestion

Folder and tag ingestion use `partitionByStatus()` to classify all files upfront (new / modified / unchanged), then only process files that need sync. Batched 5 at a time with progress reporting.

---

## Observation & Dreaming

Once messages land in Honcho, the observation pipeline takes over (no plugin code involved).

```
Messages --> Batch + Derive --> Conclusions --"> 50"--> Dream --> Peer Card
```

The queue manager batches messages by tokens (threshold: 1024). The deriver generates observations with structural preambles as context. When conclusions exceed 50, dreaming fires: surprisal sampling -> deduction (up to 12 iterations) -> induction (up to 10 iterations) -> peer card update.

> **Automatic dream scheduling.** After bulk ingestion (folder, tag, or linked-note traversal), the plugin calls `scheduleDream()` to bypass the idle timeout. Also available as a manual command.

Each ingestion session enables `reasoning`, `dream`, and `summary` in its configuration.

---

## Peer Architecture

Honcho uses an observer/observed model: the **observer** is the tool sending material, the **observed** is the person whose identity is being built. All note content is attributed to the observed peer -- your writing becomes *their* signal.

| Role | Peer | Flags | What it does |
|------|------|-------|-------------|
| Observer | `obsidian` | `observe_others: true` | The plugin -- sends notes, schedules dreams, reads back identity |
| Observed | `obsidian` (default) or configured name | `observe_me: true` | The person -- whose identity Honcho builds from the notes |

In the default configuration, both roles use the same peer name (`obsidian`). This is the simplest setup -- one vault, one identity. If you set **Observed peer** to a different name in settings, the vault becomes a dedicated observer feeding material into that peer's identity. Multiple observers (different vaults, apps, or agents) can all contribute to the same observed peer.

Peers are initialized lazily via `ensureInitialized()` before the first operation. Both `getOrCreateWorkspace()` and `getOrCreatePeer()` are idempotent.

---

## Sync Intelligence

Content is never re-ingested unless it has actually changed. Multiple layers prevent redundant API calls.

### Content hashing & stripping

`stripForIngestion()` chains `stripFrontmatter()` + `stripHonchoSection()`, then FNV-1a hashes the result. The hash is stored as `honcho_content_hash`. This means: (a) Honcho never sees its own feedback output; (b) hashes are stable regardless of feedback state; (c) frontmatter-only changes don't trigger re-ingestion.

### Sync status

| Status | Condition | Action |
|--------|-----------|--------|
| `new` | No `honcho_synced` | Ingest |
| `modified` | Hash differs from stored | Ingest |
| `unchanged` | Hash matches | Skip |

### Auto-sync queue

A centralized `SyncQueue` replaces naive per-file debounce timers:

- 5s debounce per file; priority by backlink count (hubs first) + new-file bonus
- 3 concurrent; retry up to 2x with priority decay
- Tag/folder filter matching via `matchesSyncFilters()`
- File renames and deletes clear pending queue entries

### Stale notes

"Show stale notes" scans the vault for notes where `honcho_content_hash` doesn't match the current hash. Results shown in a modal with batch re-ingest.

---

## Feedback Loop

Off by default. When enabled, derived conclusions are written back as a `## Honcho` section at the bottom of ingested notes. Opt-in globally via settings, override per note via frontmatter.

### Resolution

- `honcho_generated` in frontmatter -> always skip (plugin-created notes)
- `honcho_feedback: false` -> disabled (even if global on)
- `honcho_feedback: true` -> enabled (even if global off)
- Absent -> falls through to global `feedbackLoop` setting

### Fetching

Session-scoped first (`listConclusions` by session ID, up to 20). If empty, falls back to semantic search (`queryConclusions` by note title, top 10).

### Format

First conclusion as blockquote, rest as list items, with an ISO timestamp for staleness checking. Written atomically via `vault.process()` which strips any existing section then appends the new one.

### Triggers

1. **Explicit** -- "Update Honcho feedback" command or file menu item
2. **Lazy on file open** -- 2s delay, only if section missing or stale (>1 hour)
3. **Post-ingest deferred** -- 60s after ingest, checks if observation queue is clear

### Guard rails

Two independent layers: `writingFeedbackPaths` guard set (parallel to `ingestingPaths`) prevents re-entrant modify events; `stripForIngestion()` ensures the section is always removed before content reaches Honcho.

---

## Streaming Chat

SSE streaming via native `fetch()` (bypasses `requestUrl`'s lack of streaming support). Each delta re-renders markdown via `MarkdownRenderer.render()`. Falls back to non-streaming if SSE fails. `AbortController` for cancellation.

### Reasoning levels

`minimal` / `low` / `medium` (default) / `high` / `max` -- controls depth of dialectic reasoning.

### Contextual mode

"Chat about this note" pre-seeds with title, tags, headings, links, backlinks, properties, and a content excerpt (~500 chars). If the note is ingested, the session ID grounds the dialectic in the note's specific content. Conversations are saveable as vault notes or appendable to the daily note.

---

## Sidebar & Rendering

### Identity sidebar

Uses `getPeerContext` (single API call for card + representation). Tracks active note via `active-leaf-change` -- when viewing a markdown file, shows a focused representation using the note's title, tags, and headings as `search_query`. Debounced to avoid API spam. Connection test cached 60s; stale count cached 30s.

### Conclusion explorer

Newest/Oldest sort chips, live text filter, count display ("12 of 47"), pagination (20 per page).

### Inline code blocks

A `honcho` code block processor renders live data in reading view:

| Block | Renders |
|-------|---------|
| `search: values` + `limit: 5` | Semantic search results with dates |
| `card` | Peer card as bullets |
| `representation` | Full representation as markdown |
| `conclusions 10` | N most recent conclusions |

### Peer card authorship

"Push note as peer card" parses bullet points from a note and PUTs them via `setPeerCard`. Direct identity authorship -- no pipeline intermediary.

---

## Session Lifecycle

Sessions use deterministic IDs: `obsidian:file:{relative_path}`. Re-ingestion deletes and recreates the session to prevent message accumulation.

- **Rename** -- catches `vault.rename`, updates session metadata (`file_path`, `file_name`, `folder`, `renamed_from`, `renamed_at`), clears sync queue
- **Delete** -- catches `vault.delete`, soft-marks session (`deleted_from_vault: true`) to preserve conclusions, clears sync queue
- **Daily notes** -- when `autoSyncDailyNotes` is on, opening a daily note auto-enqueues it. Detected via the internal `daily-notes` plugin configuration (folder + date format length match)
- **Session manager** -- modal with queue progress bar, session list with pagination, re-ingest/delete/dream buttons

---

## Configuration

### Settings (13)

| Setting | Default | Description |
|---------|---------|-------------|
| `apiKey` | -- | Honcho API key (masked) |
| `baseUrl` | `https://api.honcho.dev` | API endpoint |
| `apiVersion` | `v3` | API version prefix |
| `workspaceName` | (vault name) | Workspace ID |
| `peerName` | `obsidian` | Observer peer |
| `observedPeerName` | (= observer) | Observed peer |
| `linkDepth` | `1` | Graph traversal depth (1--3) |
| `autoSync` | `false` | Auto-ingest on save |
| `autoSyncTags` | `[]` | Tag filter |
| `autoSyncFolders` | `[]` | Folder filter |
| `autoSyncDailyNotes` | `false` | Auto-ingest daily notes on open |
| `trackFrontmatter` | `true` | Write sync metadata to notes |
| `feedbackLoop` | `false` | Write ## Honcho section |

### Frontmatter

| Field | Written by | Description |
|-------|------------|-------------|
| `honcho_synced` | Plugin | Last ingestion timestamp |
| `honcho_session_id` | Plugin | Session ID |
| `honcho_message_count` | Plugin | Messages sent |
| `honcho_content_hash` | Plugin | FNV-1a body hash |
| `honcho_feedback` | User | Per-note feedback override |
| `honcho_generated` | Plugin | Marks plugin-created notes |

### Commands (15)

| Command | Context |
|---------|---------|
| Open Honcho sidebar | Global |
| Ingest current note | Active file |
| Ingest current note + linked notes | Active file |
| Ingest folder | Global (picker) |
| Ingest notes by tag | Global (picker) |
| Chat with Honcho | Global |
| Chat with Honcho about this note | Active file |
| Search Honcho memory | Global |
| Manage sessions | Global |
| Generate identity note | Global |
| Pull conclusions into vault | Global |
| Push note as peer card | Active file |
| Schedule Honcho dream | Global |
| Show stale notes | Global |
| Update Honcho feedback | Active file |

---

## File Structure

```
src/
├── main.ts                # Plugin lifecycle, 15 commands, events, guard sets
├── settings.ts            # Settings interface + tab
├── honcho-client.ts       # REST client with retry, streaming, dreams
├── views/
│   ├── sidebar-view.ts    # Identity sidebar + conclusion explorer
│   ├── chat-modal.ts      # Streaming dialectic chat
│   ├── session-manager.ts # Session list + queue status
│   ├── stale-notes-modal.ts # Stale notes + batch re-ingest
│   └── post-processor.ts  # honcho code block renderer
├── commands/
│   ├── ingest.ts          # Structural ingestion + graph traversal
│   ├── sync.ts            # Pull identity/conclusions, push peer card
│   ├── search.ts          # Unified search (conclusions + messages)
│   └── feedback.ts        # Conclusion fetching + atomic writing
└── utils/
    ├── chunker.ts         # Markdown splitting (2000-char target)
    ├── frontmatter.ts     # Frontmatter read/write/filter
    ├── sync-status.ts     # Hashing, stripping, stale detection
    └── sync-queue.ts      # Priority queue with debounce + retry

mcp/                           # Standalone MCP server (Bun)
├── server.ts              # Entry point + 9-tool dispatch
├── cli.ts                 # Obsidian CLI via Bun.spawn() (array args, no shell)
├── chunk.ts               # Markdown chunking + stripForIngestion + FNV-1a hash
├── honcho.ts              # HonchoService: lazy init, session CRUD, messages, dreams
├── types.ts               # Errors, config, 9 tool schemas
└── tools/
    ├── vault.ts           # vault_read, vault_search, vault_info, vault_list, vault_graph
    ├── write.ts           # vault_write (create/append/prepend/move/delete/properties)
    └── integrate.ts       # vault_ingest, vault_contextualize, vault_status
```

---

## Progress

- [x] REST client with retry (3x exponential backoff) + SSE streaming
- [x] Structural ingestion: tags, links, backlinks, graph intelligence, aliases, custom properties
- [x] Graph-aware BFS traversal with configurable depth
- [x] Content hashing (FNV-1a) + stripping pipeline
- [x] Priority sync queue (debounce, backlink priority, batch, retry)
- [x] Batch partitioning + stale notes detection
- [x] Session lifecycle: rename tracking, delete handling, deterministic IDs
- [x] Streaming chat with reasoning levels + contextual mode
- [x] Sidebar: peer context, conclusion explorer, contextual representation
- [x] `honcho` code block processor (search, card, representation, conclusions)
- [x] Bidirectional sync: identity notes, conclusions, peer card authorship
- [x] Feedback loop (## Honcho section, per-note override, 3 triggers, guard rails)
- [x] Daily note integration (auto-sync on open, append to daily)
- [x] Dream scheduling (auto after bulk + manual command)
- [x] Unified search (conclusions + messages with source links)
- [x] MCP server: 9 tools (6 vault + 3 bridge), staleness via session metadata hash
- [ ] EditorSuggest integration (inline autocomplete)
- [ ] Status bar sync indicator
- [ ] Bases views integration (1.10.0+)

---

## Demo: First Note to Identity

End-to-end walkthrough of a single note's lifecycle.

### The note

```markdown
---
tags: [philosophy, stoicism]
aliases: [stoic-practice]
---

# Daily Stoic Practice

Morning journaling is where I process decisions before the day starts.
I write about what I can control and release what I can't.

## Why This Matters

It's not about suppressing emotion. It's about clarity under pressure.
[[Marcus Aurelius]] called it the "inner citadel."
Links to my [[Core Values]] and [[Decision Framework]].
```

### What the plugin sends

Session `obsidian:file:philosophy/Daily Stoic Practice.md` receives two messages, both attributed to the observed peer:

```
# Message 1: structural preamble
[Note: Daily Stoic Practice]
Aliases: stoic-practice
Folder: philosophy
Tags: #philosophy, #stoicism
Structure: # Daily Stoic Practice > ## Why This Matters
Links to: Marcus Aurelius, Core Values, Decision Framework
Referenced by: Morning Routine, Reading List
Backlink count: 2 | Graph position: connected
Created: 2026-01-15 | Modified: 2026-02-18

# Message 2: note body (frontmatter stripped, hash a3f1c802)
```

### What Honcho returns

Observation derives conclusions. After enough accumulate, dreaming consolidates into the peer card.

| Stage | Output |
|-------|--------|
| Conclusions | *"Uses morning journaling as a pre-decision processing tool"* |
| Conclusions | *"Draws on Stoic philosophy for emotional regulation -- clarity, not suppression"* |
| Conclusions | *"References Marcus Aurelius' 'inner citadel' as a personal anchor"* |
| Peer card | *"Practices Stoic philosophy as daily discipline, not intellectual exercise"* |

### What the vault gets back

Frontmatter is updated with sync metadata. If `feedbackLoop` is enabled (off by default), the note also receives:

```markdown
## Honcho

> Uses morning journaling as a pre-decision processing tool

- Draws on Stoic philosophy for emotional regulation
- References Marcus Aurelius' "inner citadel" as personal anchor

*Last updated: 2026-02-18T11:05:00Z*
```

On re-edit, the `## Honcho` section is stripped before hashing -- a changed body produces a new hash, triggers re-ingestion. The feedback section is never sent to Honcho.

---

## CLI & MCP Server

The plugin runs inside Obsidian's plugin runtime using internal JS APIs. External agents access the vault through the **MCP server** (`mcp/`) -- a standalone Bun process that wraps the Obsidian CLI into 9 structured tools, 6 pure vault and 3 that bridge vault + Honcho.

### MCP tools (9)

| Tool | Type | What it does |
|------|------|-------------|
| `vault_read` | Vault | Read raw note content |
| `vault_write` | Vault | Create, append, prepend, move, delete, properties, bookmark, daily append |
| `vault_search` | Vault | Keyword search via CLI (semantic search at `mcp.honcho.dev`) |
| `vault_info` | Vault | 7 parallel CLI calls: metadata, backlinks, links, outline, properties, tags, aliases |
| `vault_list` | Vault | List files with folder/ext/total filters |
| `vault_graph` | Vault | Orphans, deadends, unresolved, tags, recents, tasks in parallel |
| `vault_ingest` | Bridge | Full pipeline: strip, hash, staleness check, preamble, chunk, session, messages, dream. Modes: file, folder (batch 5), linked (BFS), smart (diff vault vs sessions) |
| `vault_contextualize` | Bridge | 7 CLI + 3 Honcho calls in parallel: structural position + semantic perspective + ingestion status |
| `vault_status` | Bridge | Vault file counts + Honcho sessions + coverage % + queue progress |

> **Vault tools need no API key.** The 6 pure vault tools work with just `OBSIDIAN_VAULT`. The 3 bridge tools additionally require `HONCHO_API_KEY` and lazy-initialize workspace + peers on first use.

### Architecture

```
Agent (Claude, script) --MCP--> MCP Server (9 tools) --Bun.spawn()--> Obsidian CLI --> Vault
                                       |                                                |
                                       +---fetch()---> Honcho API <---REST--- Plugin <---+
                                                                              (vault.modify event)
```

The MCP server and the Obsidian plugin are independent. The server uses `Bun.spawn()` with array args (no shell) for CLI calls and native `fetch()` for Honcho. The plugin uses Obsidian's internal APIs. When both run simultaneously, they compose: the MCP server writes notes the plugin auto-ingests, and the plugin's pipeline feeds the same Honcho identity the server reads back.

### Staleness in the MCP server

The MCP server doesn't write frontmatter (it can't modify notes without going through the CLI). Instead, it stores `content_hash` in Honcho session metadata. On re-ingest, it compares the hash of the stripped content against the session's stored hash. Same hash = skip. Different hash = delete session, recreate, re-ingest.

### Environment

```
HONCHO_API_KEY=hc_...                    # Required for bridge tools
HONCHO_BASE_URL=https://api.honcho.dev   # Default
HONCHO_WORKSPACE=my-vault                # Default: auto-detected from CLI
HONCHO_OBSERVER=obsidian                 # Default
HONCHO_OBSERVED=obsidian                 # Default: same as observer
OBSIDIAN_VAULT=my-vault                  # Optional: active vault if unset
```

### Running

```bash
# Start the server (stdio transport for MCP)
bun run mcp/server.ts

# Claude Desktop config
{
  "mcpServers": {
    "honcho-vault": {
      "command": "bun",
      "args": ["run", "/path/to/obsidian-honcho/mcp/server.ts"],
      "env": { "HONCHO_API_KEY": "hc_..." }
    }
  }
}
```

### Obsidian CLI reference

The CLI (`obsidian <command>`) provides 80+ commands. The MCP server wraps a focused subset; the full CLI is always available for direct use.

| Category | Commands |
|----------|----------|
| Read / write | `read`, `create`, `append`, `prepend`, `delete`, `move` |
| Search | `search query=<text>` with path, limit, format (text/json) |
| Structure | `links`, `backlinks`, `orphans`, `deadends`, `unresolved`, `tags`, `aliases` |
| Properties | `property:read`, `property:set`, `property:remove`, `properties` |
| Daily notes | `daily`, `daily:read`, `daily:append`, `daily:prepend` |
| Files | `files`, `folders`, `file` (metadata), `outline`, `wordcount` |
| Plugin control | `plugin:enable`, `plugin:disable`, `plugin:reload`, `command id=<id>` |

### Design decisions

- **Why not `mcp.honcho.dev` for everything?** -- `mcp.honcho.dev` has 30 Honcho tools but zero vault access. The MCP server fills the vault gap and bridges both.
- **Why 9 tools, not 14?** -- The original MCP server (commit `7fa0c0e`, removed in `38828c8`) had 14 tools. 5 were pure Honcho tools (`vault_memory`, `vault_dream`, `vault_chat`, `vault_sync`, `vault_analyze`) redundant with `mcp.honcho.dev` or composable by the LLM. Removed.
- **Why a separate process?** -- Obsidian plugins can't expose MCP servers. The server runs as a Bun process alongside Obsidian, using the CLI as its vault interface.
- **The meta container pattern.** -- Agent ecosystems are converging on plugins as meta containers: install "figma" and get all the figma tools. This MCP server is how Honcho gets inserted into that system -- it's the meta container that gives every other plugin persistent identity context.

---

## P.S. -- API Surface

### Currently used

| Capability | Used by |
|-----------|---------|
| `getPeerContext` | Sidebar (combined card + representation) |
| `search_query` on representation | Contextual representation + chat |
| `setPeerCard` (PUT) | Push note as peer card |
| `peerChatStream` (SSE) | Chat modal |
| `getQueueStatus` | Session manager + deferred feedback |
| `scheduleDream` | Post-bulk-ingest + manual command |
| `queryConclusions` | Search + feedback semantic fallback |
| `listConclusions` | Explorer + feedback session-scoped |

### Proposals

The vault-to-identity pipeline is simulated through conversational primitives. These would make it native.

| Proposal | Why |
|----------|-----|
| SSE event stream for pipeline events | Auto-refresh on conclusion arrival and dream completion. Obsidian can't do webhooks |
| Temporal filters on conclusions (`created_after`, `session_id`) | "What's new since last sync" without pulling everything |
| Bulk ingestion endpoint | 100 notes = ~300 requests. Collapse to 1 |
| Document Ingestion API | First-class vault-shaped data -- links, tags as metadata, replace mode native |
