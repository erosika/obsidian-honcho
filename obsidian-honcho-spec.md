# obsidian-honcho

> Persistent identity for your knowledge base. The vault is the brain; Honcho is the memory.

**Repository:** plastic-labs/obsidian-honcho
**Stack:** TypeScript / Bun
**Date:** 2026-02-24

---

## Contents

1. [Concept](#concept)
2. [Architecture](#architecture)
3. [Standalone Plugin](#setup-1-standalone-plugin)
4. [Agentic Integration](#setup-2-agentic-integration)
5. [MCP Tool Reference](#mcp-tool-reference)
6. [Data Flow](#data-flow)
7. [Setup Guide](#setup-guide)
8. [Demo & Autonomous Examples](#demo--autonomous-examples)
9. [Current Status](#current-status)

---

## Concept

Your vault is the highest-fidelity signal of who you are. Not chat logs, not browsing history -- the things you deliberately write down and organize. Honcho turns that signal into persistent identity.

The plugin is the bridge. Each note becomes a Honcho session with a pair of linked messages -- one for document context (metadata, graph position, tags, links), one for the full body. Honcho observes and derives conclusions about your thinking over time. Those conclusions accumulate, compound, and become available to anything downstream.

Two setups, and they compose. The plugin alone gives your vault a memory layer -- identity that persists and deepens as you write. Add the MCP server and external agents get direct access to both the vault and the identity Honcho has built from it. Your knowledge base becomes an autonomous resource, not a passive archive.

> **Key distinction** -- There are two Honcho MCPs. The **generic Honcho MCP** (`mcp.honcho.dev`) handles workspace-agnostic operations: semantic search, chat, conclusions. The **Obsidian-Honcho MCP** handles vault access and obsidian-workspace-specific Honcho operations. They are designed to run alongside each other.

---

## Architecture

```
                    ┌─────────────────────────┐
                    │    Agent (Claude, etc.)  │
                    └──────┬──────────┬───────┘
                           │          │
            vault + bridge │          │ search, chat, conclude
                   tools   │          │
                           ▼          ▼
              ┌────────────────┐  ┌──────────────────┐
              │ Obsidian-Honcho│  │  Generic Honcho   │
              │   MCP Server   │  │  MCP (honcho.dev) │
              │ 6 vault +      │  └────────┬─────────┘
              │ 3 bridge tools │           │
              └───┬────────┬───┘           │
                  │        │               │
   CLI/REST/fs    │        │ classify,     │
                  │        │ reflect       │
                  ▼        ▼               ▼
  ┌──────────────────┐  ┌──────────────────────────────┐
  │  Obsidian Vault   │  │          Honcho API           │
  │  markdown, front-  │  │                              │
  │  matter, wikilinks │  │  Sessions ──→ Conclusions    │
  └────────┬──────────┘  │  (1 per note,   (derived     │
           │              │   2 linked      observations) │
           │              │   messages)        │          │
           ▼              │                    ▼          │
  ┌──────────────────┐   │                 Dreams        │
  │  Obsidian Plugin  │   │           (cross-session     │
  │  ingestion, sync, │──▶│            synthesis)        │
  │  chat             │   └──────────────────────────────┘
  └──────────────────┘
```

### Components

| Component | Role | Runs Where |
|-----------|------|------------|
| **Obsidian Vault** | The knowledge base. Markdown files with frontmatter, wikilinks, tags, folder hierarchy. | Local filesystem |
| **Obsidian Plugin** | Ingestion bridge. Reads vault notes, creates Honcho sessions, tracks sync status. Chat sidebar for direct conversation with Honcho. | Inside Obsidian |
| **Honcho API** | Persistent identity engine. Observes messages, derives conclusions, builds representations, processes dreams. | Cloud (`api.honcho.dev`) |
| **Obsidian-Honcho MCP** | 9 tools: 6 vault access + 3 workspace-specific Honcho operations. External agents use this to interact with your vault and its Honcho workspace. | Local process (Bun) |
| **Generic Honcho MCP** | Workspace-agnostic Honcho operations: semantic search, conversational chat, direct conclusion creation. | Cloud (`mcp.honcho.dev`) |

### Single-Peer Model

The system collapses Honcho's observer/observed peer architecture to a single peer. You are the peer. Each note becomes its own session with a pair of linked messages -- document context and body -- attributed to you. Honcho observes those messages and derives conclusions about your thinking, knowledge structure, and patterns. The peer configuration is `{ observe_me: true }` -- Honcho watches what you write and builds understanding from it.

---

## Setup 1: Standalone Plugin

**What you need:** Obsidian + the plugin + a Honcho API key.

The plugin alone turns your vault into a persistent identity source. No agents, no MCP servers, no CLI tools. You write notes in Obsidian. The plugin sends them to Honcho. Honcho learns.

### Installation

- **Community plugins (coming soon):** Settings > Community Plugins > Browse > search "Honcho" > Install > Enable.
- **Manual install:** Clone [plastic-labs/obsidian-honcho](https://github.com/plastic-labs/obsidian-honcho), run `bun install && bun run build`, then copy `main.js`, `manifest.json`, and `styles.css` into your vault's `.obsidian/plugins/obsidian-honcho/` directory. Restart Obsidian and enable the plugin under Settings > Community Plugins.

### What the Plugin Does

- **Ingestion.** Each note becomes a Honcho session with exactly 2 messages: a document context message (metadata, graph position, tags, links, folder, properties) and the full note body. The pair is linked by a shared `turn_id` -- an 8-character hex hash, like a short git commit hash -- so the context and content are always queryable as a unit. Deterministic session IDs (`obsidian-file-{slug}`) so re-ingesting updates rather than duplicates.
- **Sync tracking.** FNV-1a content hashing detects changes. Frontmatter fields (`synced`, `session`, `hash`) track what has been sent. Unchanged notes are skipped automatically.
- **Auto-sync.** Optionally re-ingests notes on save with configurable debounce (10s) and per-file cooldown (default 5 minutes). Tag and folder filters let you scope which notes auto-sync.
- **Chat.** Sidebar chat grounded in the current note's Honcho session. Conversation with Honcho about what it has observed.
- **Batch operations.** Ingest entire folders, all notes matching a tag, or a note plus its linked neighborhood (configurable depth).

### What Honcho Provides

- **Conclusions.** Honcho's observation pipeline derives atomic insights from your notes -- patterns in your thinking, connections between ideas, knowledge gaps, recurring themes. These are persistent and searchable.
- **Representations.** A synthesized model of you, focused through any search query. Ask Honcho to represent you through the lens of a specific topic and it constructs a view from relevant conclusions.
- **Dreams.** Scheduled processing that synthesizes across sessions, finding deeper patterns that span multiple notes. Triggered automatically after batch ingestion.
- **Accumulation.** Every note you ingest adds signal. Over time, Honcho's model of your thinking becomes increasingly refined. The vault is the input; the identity is the output.

> **The value proposition** -- Your notes already represent your thinking. The plugin makes that representation machine-readable and persistent. Honcho turns it into something any system can reason over.

---

## Setup 2: Agentic Integration

The agentic layer turns your vault from a passive knowledge store into an active resource that external agents can consult, reason over, and extend. An agent with vault access and Honcho's accumulated identity model can ground its responses in your actual documented thinking -- not just the current conversation window, but the full history of what you've written, organized, and refined.

**What you need:** Everything from Setup 1, plus the Obsidian-Honcho MCP server, and optionally the generic Honcho MCP.

The MCP server exposes your vault and its Honcho workspace to external agents. Claude, or any MCP-capable system, can read your notes, write new ones, search your vault, analyze its structure, and tap into the identity Honcho has built from your ingested content.

### What the MCP Server Adds

#### Vault Access (6 tools)

Direct read/write/search access to Obsidian's vault. These tools work independently of Honcho -- they are pure vault operations routed through whichever transport is available.

- `vault_read` -- Read a note's raw content
- `vault_write` -- Create, append, prepend, set/remove properties, move, delete, bookmark, daily note append
- `vault_search` -- Keyword search across the vault
- `vault_info` -- Complete note intelligence: metadata, graph position, structure, properties, tags, aliases (7 parallel queries)
- `vault_list` -- List files, optionally by folder or extension
- `vault_graph` -- Vault-wide structural health: orphans, dead-ends, unresolved links, tag distribution, recent files, pending tasks

#### Workspace Bridge (3 tools)

These tools operate on the **obsidian workspace** in Honcho -- the workspace where your ingested vault content lives. They combine vault data with Honcho's accumulated understanding.

- `vault_classify` -- Ask Honcho to suggest tags, title improvements, or connections for a note based on accumulated vault knowledge. Uses `peerChat` on the note's ingestion session.
- `vault_reflect` -- Get Honcho's perspective on a note: direct conclusions from that session, semantically related conclusions from across the vault, and a representation focused through the note's content.
- `vault_status` -- Workspace overview: vault file counts, ingested sessions, coverage percentage, conclusion totals, processing queue state.

### Combined with the Generic Honcho MCP

Adding `mcp.honcho.dev` alongside the Obsidian-Honcho MCP gives agents full Honcho access beyond the obsidian workspace:

- **Semantic search** across all workspaces and conclusions
- **Conversational chat** in any session context
- **Direct conclusion creation** -- agents can write observations back to Honcho

The two MCPs do not overlap. The Obsidian-Honcho MCP handles vault access and workspace-specific operations. The generic Honcho MCP handles everything else.

### What This Makes Possible

An agent with both MCPs can:

- Read your notes to understand context before responding
- Search your vault for relevant prior work
- Check what Honcho has concluded about your thinking patterns
- Suggest organizational improvements based on accumulated knowledge
- Create new notes or append to existing ones
- Audit your vault's structural health (orphans, dead-ends, unresolved links)
- Ground its responses in your actual documented knowledge, not just the current conversation

> **The plugin is the bridge, not the brain** -- Ingestion is the plugin's job. Intelligence is the agent's job. The plugin is deliberately minimal: it reads vault content, sends it to Honcho, and tracks what has been sent. Everything else -- classification, reflection, search, reasoning -- happens at the MCP/agent layer where it belongs.

---

## MCP Tool Reference

| Tool | Type | Description | Key Parameters |
|------|------|-------------|----------------|
| `vault_read` | Vault | Read raw note content | `file` (required) |
| `vault_write` | Vault | 9 write actions: create, append, prepend, property set/remove, move, delete, bookmark, daily append | `action` (required), `file`, `content`, etc. |
| `vault_search` | Vault | Keyword search. Semantic search lives at `mcp.honcho.dev`. | `query` (required), `limit` |
| `vault_info` | Vault | Complete note intelligence (7 parallel queries) | `file` (required) |
| `vault_list` | Vault | List vault files | `folder`, `ext`, `total` |
| `vault_graph` | Vault | Vault structural health report (6 parallel analyses) | `include` (array of analyses) |
| `vault_classify` | Bridge | Honcho-powered tag/title/connection suggestions | `file` (required), `scope` |
| `vault_reflect` | Bridge | Conclusions + representation for a note | `file` (required) |
| `vault_status` | Bridge | Workspace coverage and queue state | (none) |

---

## Data Flow

### Ingestion Pipeline (Plugin)

```
Vault Note
    │
    ▼
Compute content hash (FNV-1a on stripped body)
    │
    ▼
Hash changed? ─── No ──→ Skip (unchanged)
    │
    Yes
    │
    ├──→ Build document context (metadata, graph position, tags, links, properties)
    ├──→ Strip frontmatter (raw body content)
    │
    ▼
Get/create Honcho session (obsidian-file-{slug})
    │
    ├──→ Message 1: Document context
    ├──→ Message 2: Full body
    │
    ▼
Update frontmatter (synced, session, hash)
    │
    ▼ (batch only)
Schedule dream
```

### Transport Chain (MCP Server)

The MCP server accesses the vault through a three-tier fallback chain. Each transport provides the same command interface; the server auto-detects which is available.

| Priority | Transport | Requires | Capabilities |
|----------|-----------|----------|--------------|
| 1 | **CLI** | Obsidian 1.12+ with CLI enabled | Full: all commands including bookmark, daily append |
| 2 | **REST** | Local REST API plugin | Full: all commands via HTTP |
| 3 | **Filesystem** | `OBSIDIAN_VAULT_PATH` env var | Most commands. No bookmark or daily append (requires Obsidian internals). |

The filesystem transport parses markdown directly -- frontmatter, wikilinks, tags, headings -- so the MCP server works even when Obsidian is not running. Override with `OBSIDIAN_TRANSPORT=cli|rest|fs`.

---

## Setup Guide

### Plugin Only (Setup 1)

#### Option A: Global config (shared with Cursor / Claude Code)

If you already use [cursor-honcho](https://github.com/plastic-labs/cursor-honcho) or [claude-honcho](https://github.com/plastic-labs/claude-honcho), you have a `~/.honcho/config.json`. Add an `obsidian` host block:

```json
{
  "apiKey": "hch-your-key-here",
  "peerName": "your-name",
  "hosts": {
    "cursor":     { "workspace": "cursor", "aiPeer": "cursor" },
    "claude_code": { "workspace": "claude_code", "aiPeer": "claude" },
    "obsidian":    { "workspace": "obsidian" }
  }
}
```

The plugin reads this file automatically. Your API key, peer name, and workspace are shared across all three surfaces. Obsidian's settings UI still works as a local override.

#### Option B: Plugin settings only

1. Install the plugin in Obsidian
2. Enter your Honcho API key in Settings > Honcho > Connection
3. Test connection (green dot in sidebar)
4. Ingest notes manually (right-click > Ingest to Honcho) or enable auto-sync
5. Open the chat sidebar to converse with Honcho about ingested content

> **Config layering** -- Defaults < `~/.honcho/config.json` < Obsidian plugin settings. The global config provides shared values; anything set in Obsidian's settings UI takes precedence.

### Plugin + Obsidian-Honcho MCP (Setup 2)

1. Complete Setup 1
2. Register the MCP server with your agent platform

#### Claude Desktop configuration

```json
{
  "mcpServers": {
    "obsidian-honcho": {
      "command": "bun",
      "args": ["run", "/path/to/obsidian-honcho/mcp/server.ts"],
      "env": {
        "HONCHO_API_KEY": "your-key",
        "HONCHO_WORKSPACE": "obsidian",
        "HONCHO_PEER": "your-name",
        "OBSIDIAN_VAULT_PATH": "/path/to/your/vault"
      }
    }
  }
}
```

#### Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HONCHO_API_KEY` | Yes | | Honcho API key |
| `HONCHO_BASE_URL` | | `https://api.honcho.dev` | Honcho API endpoint |
| `HONCHO_WORKSPACE` | | Vault name | Honcho workspace ID. Should match the plugin's workspace. |
| `HONCHO_PEER` | Yes | | Your identity in Honcho (same as peerName in plugin/global config) |
| `OBSIDIAN_VAULT_PATH` | | | Absolute path to vault. Required for filesystem transport. |
| `OBSIDIAN_TRANSPORT` | | `auto` | `auto`, `cli`, `rest`, or `fs` |
| `OBSIDIAN_REST_URL` | | `http://127.0.0.1:27123` | Local REST API plugin URL |
| `OBSIDIAN_REST_KEY` | | | Local REST API plugin key |

### Full Stack (Setup 2 + Generic Honcho MCP)

Add the generic Honcho MCP alongside the Obsidian-Honcho MCP in your agent's configuration. The generic MCP is available at `mcp.honcho.dev` and provides workspace-agnostic operations: semantic search, chat, and conclusion creation.

---

## Demo & Autonomous Examples

### Basic Demo: Ingest > Observe > Query

You have a note called `design-philosophy.md`:

```markdown
---
tags: [design, principles]
aliases: [aesthetic framework]
---

# Design Philosophy

I believe interfaces should be honest. No decoration pretending to be function.
Precision is non-negotiable -- if something is 2px off, it's wrong. I prefer
sustained attention over novelty: build for the hundredth session, not the first.

Typography hierarchy matters. Monospace for structure, serif for prose.
Dark-first. Low contrast, high legibility. Sharp edges communicate precision.
```

Right-click > **Ingest to Honcho**. The plugin sends 2 messages to session `obsidian-file-design-philosophy`:

**Message 1: Document Context**
```
[Document Observation]
Title: design-philosophy
Folder: /
Tags: design, principles
Aliases: aesthetic framework
Links to: (none)
Referenced by: ui-components, portfolio
Graph position: connected
Backlink count: 2
Structure: # Design Philosophy
Modified: 2026-02-24
```

**Message 2: Full Body**
```
I believe interfaces should be honest. No decoration pretending
to be function. Precision is non-negotiable -- if something is
2px off, it's wrong...

(full note content, frontmatter and ## Honcho sections stripped)
```

Honcho observes. Over time -- and especially after dreaming -- it derives conclusions:

```
// Example conclusions Honcho might derive:

"User has a strong preference for honest interfaces -- no decoration
 that pretends to be function. This is a core design principle, not
 a situational preference."

"User enforces precision at the pixel level. 2px tolerance. This
 suggests engineering-grade attention to visual detail."

"User's typography system is structural: monospace = hierarchy and
 navigation, serif = dense readable content. This is a deliberate
 cognitive mapping, not arbitrary font choice."
```

Now any agent with Honcho access -- in Cursor, Claude Code, or through the MCP -- can query these conclusions. The identity follows you across surfaces.

---

### Autonomous Examples

These are real workflows the MCP tools support. Each one is an agent operating autonomously over your vault and Honcho identity.

#### 1. Knowledge Gardening

An agent audits your vault's structural health and fixes it.

```
// Step 1: Survey the vault
vault_graph({ include: ["orphans", "dead_ends", "unresolved"] })

// Discovers:
//   12 orphan notes (no incoming or outgoing links)
//   8 dead-end notes (linked to, but link to nothing)
//   23 unresolved wikilinks (references to notes that don't exist)

// Step 2: Check Honcho's understanding of each orphan
vault_reflect({ file: "orphaned-note.md" })

// Honcho returns conclusions about this note's content and
// semantically related conclusions from other sessions --
// revealing connections the vault's link structure missed.

// Step 3: Create an index note that bridges the gaps
vault_write({
  action: "create",
  file: "maps/design-system-map.md",
  content: "# Design System Map\n\n- [[design-philosophy]] -- core principles\n..."
})

// Step 4: Suggest tags for unclassified notes
vault_classify({ file: "orphaned-note.md", scope: "tags" })
```

> **What makes this autonomous** -- The agent doesn't just list problems. It uses Honcho's semantic understanding to discover connections that aren't explicit in the vault's link graph, then makes structural changes to surface them.

#### 2. Cross-Surface Intelligence

You write about an idea in Obsidian. Later, an agent in a completely different context already knows your thinking.

```
// In Obsidian, you write a note about state management:
//
//   "I prefer explicit state machines over implicit state.
//    Redux is too much ceremony. Context API loses traceability.
//    XState hits the sweet spot -- formal enough to reason about,
//    practical enough to ship."
//
// Plugin auto-syncs. Honcho observes and concludes.

// Three days later, in Cursor, you're building a checkout flow.
// The Cursor agent (cursor-honcho) queries your identity:

honcho.chat("What does this user prefer for state management?")

// Response:
// "Based on their documented thinking: explicit state machines,
//  specifically XState. They find Redux too ceremonial and
//  Context API insufficiently traceable."

// The agent writes XState-based checkout logic without asking.
// Your vault note became a persistent engineering preference.
```

#### 3. Reflective Synthesis

An agent reads your recent daily notes and synthesizes patterns you haven't explicitly connected.

```
// Step 1: Read the last 7 daily notes
vault_list({ folder: "daily" })

// Step 2: For each, get Honcho's accumulated perspective
vault_reflect({ file: "daily/2026-02-24.md" })

// Step 3: Query cross-session patterns via generic Honcho MCP
honcho.search("recurring themes from the past week")

// Honcho surfaces:
// "Three of seven daily notes reference 'simplification' in different
//  contexts -- codebase architecture, personal workflow, and a book
//  note about essentialism. This pattern suggests the user is in an
//  active phase of stripping complexity across multiple domains."

// Step 4: Append a synthesis to today's daily note
vault_write({
  action: "append",
  file: "daily/2026-02-24.md",
  content: "\n## Weekly Pattern\n\nSimplification is the throughline..."
})
```

#### 4. Identity-Grounded Code Review

An agent reviews a PR, but grounds its feedback in your documented standards -- not generic best practices.

```
// Agent receives a diff for review. Before commenting, it checks
// your identity for relevant preferences:

honcho.chat("What are this user's CSS and UI standards?")

// Honcho returns conclusions derived from your vault notes:
// "Never use Tailwind arbitrary color values. Always CSS custom
//  properties. 0px border-radius on structural elements. Dark-first.
//  8px base spacing unit. No decorative shadows."

// The agent flags:
// "Line 42 uses bg-[#1a1a1a] -- your documented standard requires
//  CSS variables. Should be bg-surface or similar."
//
// "Line 87 uses border-radius: 8px on a card -- your design
//  philosophy specifies 0px on structural elements."
//
// This isn't generic lint. It's YOUR standards, enforced.
```

#### 5. Autonomous Research Assistant

You start writing a note. An agent notices and proactively surfaces relevant context from your own prior thinking.

```
// You create a new note: "agent-memory-architecture.md"
// You write the first paragraph. Auto-sync triggers.

// Step 1: Read what you've written so far
vault_read({ file: "agent-memory-architecture.md" })

// Step 2: Search your vault for related prior work
vault_search({ query: "memory architecture persistent context" })
// Finds: honcho-notes.md, context-window-limits.md, identity-systems.md

// Step 3: Get Honcho's cross-session understanding
honcho.search("user's thinking about agent memory and persistence")

// Step 4: Check graph connections
vault_info({ file: "agent-memory-architecture.md" })
// Graph position: orphan (no links yet)

// Step 5: Write a research brief into the note
vault_write({
  action: "append",
  file: "agent-memory-architecture.md",
  content: "\n## Prior Work in This Vault\n\n- [[honcho-notes]]...\n"
})
```

> **The pattern across all of these** -- The vault provides structure. Honcho provides understanding. The agent provides action. None of them work this well alone. Together, the agent has access to your actual thinking, not a blank slate and not a generic persona -- *your* documented knowledge, *your* derived patterns, *your* organizational structure.

---

## Current Status

- [x] Plugin: 2-message ingestion (document context + body)
- [x] Plugin: FNV-1a content hashing and sync tracking
- [x] Plugin: Auto-sync with debounce + per-file cooldown
- [x] Plugin: Batch ingestion (folder, tag, linked neighborhood)
- [x] Plugin: Chat sidebar grounded in note context
- [x] Plugin: Frontmatter cleanup (dropped `honcho_` prefix)
- [x] Plugin: Single-peer model (collapsed observer/observed)
- [x] MCP: 9 tools (6 vault + 3 bridge)
- [x] MCP: Three-tier transport (CLI > REST > filesystem)
- [x] MCP: Filesystem transport (vault access without Obsidian running)
- [x] MCP: Lazy Honcho initialization (bridge tools only)
- [ ] MCP: End-to-end testing with Claude Desktop
- [ ] MCP: Publish as standalone package
- [ ] Plugin: Community plugin submission

### Build Artifacts

| Artifact | Size | Entry |
|----------|------|-------|
| Obsidian Plugin | ~109 KB | `main.js` |
| MCP Server | ~540 KB | `mcp/server.ts` |

### File Structure

```
obsidian-honcho/
  src/                        # Obsidian plugin source
    commands/
      ingest.ts               # 2-message ingestion pipeline
      sync.ts                 # Manual sync commands
      feedback.ts             # Experimental: conclusion feedback
      search.ts               # Conclusion search modal
    utils/
      frontmatter.ts          # Read/write sync tracking fields
      sync-status.ts          # Content hashing, staleness detection
      sync-queue.ts           # Debounced auto-sync queue
    views/
      chat-modal.ts           # Chat sidebar
      sidebar-view.ts         # Status + peer card
    honcho-client.ts          # Plugin's Honcho API client
    settings.ts               # Plugin settings UI
    main.ts                   # Plugin entry point
  mcp/                        # Standalone MCP server
    server.ts                 # MCP entry point (9-tool dispatch)
    api.ts                    # Unified transport (CLI/REST/fs)
    cli.ts                    # Obsidian CLI transport
    rest.ts                   # Local REST API transport
    fs.ts                     # Filesystem transport
    honcho.ts                 # Honcho API service (single-peer)
    types.ts                  # Tool schemas + config
    tools/
      vault.ts                # 5 vault tools
      write.ts                # vault_write
      bridge.ts               # 3 workspace bridge tools
```
