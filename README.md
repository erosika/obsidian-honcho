# obsidian-honcho

Persistent identity for your Obsidian vault. The vault is the brain; Honcho is the memory.

Each note becomes a Honcho session with a pair of linked messages -- document context (metadata, graph position, tags, links) and the full body. Honcho observes and derives conclusions about your thinking over time.

Two setups: the **plugin alone** gives your vault a memory layer. Add the **MCP server** and external agents get direct access to both the vault and the identity Honcho has built from it.

See [obsidian-honcho-spec.md](obsidian-honcho-spec.md) for the full specification.

## Install

### From source (development)

```sh
git clone https://github.com/plastic-labs/obsidian-honcho
cd obsidian-honcho
bun install
bun run build
```

Symlink into your vault's plugin directory so builds are immediately available:

```sh
ln -s "$(pwd)" "/path/to/your/vault/.obsidian/plugins/honcho"
```

Open Obsidian, go to **Settings > Community Plugins**, and enable **Honcho**.

After any code change:

```sh
bun run build
# Then in Obsidian: Cmd+Shift+P > "Reload app without saving"
```

### Manual install (no symlink)

```sh
git clone https://github.com/plastic-labs/obsidian-honcho
cd obsidian-honcho
bun install
bun run build
```

Copy the required files into your vault:

```sh
mkdir -p "/path/to/your/vault/.obsidian/plugins/honcho"
cp main.js manifest.json styles.css "/path/to/your/vault/.obsidian/plugins/honcho/"
```

Enable the plugin in **Settings > Community Plugins**. Re-copy after each build.

## Configure

### Option A: Global config (shared across Honcho plugins)

If you use [cursor-honcho](https://github.com/plastic-labs/cursor-honcho) or [claude-honcho](https://github.com/plastic-labs/claude-honcho), add an `obsidian` host to `~/.honcho/config.json`:

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

The plugin reads this automatically. Obsidian settings override global values.

### Option B: Plugin settings only

1. Open **Settings > Honcho > Connection**
2. Enter your Honcho API key
3. Test connection (green dot in sidebar)

## Usage

- **Ingest a note**: Right-click > Ingest to Honcho
- **Batch ingest**: Command palette > "Ingest all notes" / "Ingest folder" / "Ingest by tag"
- **Auto-sync**: Enable in Settings > Honcho > Auto-sync (10s debounce, 5min per-file cooldown)
- **Chat**: Open the Honcho sidebar, click a note, and chat about what Honcho has observed
- **Search conclusions**: Command palette > "Search Honcho conclusions"

## MCP Server

The MCP server exposes 9 tools (6 vault + 3 Honcho bridge) to external agents.

```sh
cd mcp
bun install
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

The MCP server auto-detects transport (CLI > REST > filesystem). Set `OBSIDIAN_TRANSPORT=fs` to force filesystem mode when Obsidian is not running.

## Stack

- **Plugin**: TypeScript, esbuild, Obsidian API
- **MCP**: TypeScript, Bun, `@modelcontextprotocol/sdk`
- **Build**: `bun run build`
