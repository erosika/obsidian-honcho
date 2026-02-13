#!/usr/bin/env bun
/**
 * Unified Intelligence MCP Server
 *
 * Combines Obsidian CLI-powered vault access with Honcho's semantic
 * memory API. Compound tools reason across both systems simultaneously:
 * the vault's structural graph AND Honcho's learned understanding.
 *
 * No filesystem access. Everything goes through CLI or Honcho API.
 *
 * Environment variables:
 *   HONCHO_API_KEY     - Required. Honcho API key.
 *   HONCHO_BASE_URL    - Optional. Default: https://api.honcho.dev
 *   HONCHO_WORKSPACE   - Optional. Default: vault name from CLI.
 *   HONCHO_OBSERVER    - Optional. Default: obsidian.
 *   HONCHO_OBSERVED    - Optional. Default: same as observer.
 *   OBSIDIAN_VAULT     - Optional. Active vault if unset.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { execObsidian } from "./cli.ts";
import { HonchoClient } from "./honcho.ts";
import {
	loadConfig,
	TOOL_SCHEMAS,
	ObsidianNotRunningError,
	ToolInputError,
	type ServerConfig,
	type VaultSearchInput,
	type VaultReadInput,
	type VaultInfoInput,
	type VaultListInput,
	type VaultGraphInput,
	type VaultIngestInput,
	type VaultMemoryInput,
	type VaultDreamInput,
	type VaultChatInput,
	type VaultSyncInput,
	type VaultContextualizeInput,
	type VaultWriteInput,
} from "./types.ts";

// Tools
import { vaultSearch, vaultRead, vaultInfo, vaultList, vaultGraph } from "./tools/vault.ts";
import { vaultWrite } from "./tools/write.ts";
import { vaultIngest, vaultMemory, vaultStatus, vaultDream } from "./tools/memory.ts";
import { vaultChat, vaultSync, vaultContextualize, vaultAnalyze } from "./tools/compound.ts";

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

let config: ServerConfig;
let honcho: HonchoClient;
let initialized = false;

function ingestConfig() {
	return {
		workspace: config.honcho.workspace,
		observer: config.honcho.observer,
		observed: config.honcho.observed,
	};
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

async function ensureInitialized(): Promise<void> {
	if (initialized) return;

	// Resolve workspace name from CLI if not set
	if (!config.honcho.workspace) {
		const vaultInfo = await execObsidian("vault", {});
		// Parse vault name from output
		const nameMatch = vaultInfo.match(/^(.+?)[\t\n]/);
		config.honcho.workspace = nameMatch?.[1]?.trim() || vaultInfo.split("\n")[0]?.trim() || "default";
	}

	// Initialize Honcho workspace and peers
	await honcho.getOrCreateWorkspace(config.honcho.workspace);
	await honcho.getOrCreatePeer(
		config.honcho.workspace,
		config.honcho.observer,
		{ observe_me: config.honcho.observer === config.honcho.observed }
	);
	if (config.honcho.observed !== config.honcho.observer) {
		await honcho.getOrCreatePeer(
			config.honcho.workspace,
			config.honcho.observed,
			{ observe_me: true }
		);
	}

	initialized = true;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
	{
		name: "honcho-vault",
		version: "0.2.0",
	},
	{
		capabilities: {
			tools: {},
		},
	}
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [...TOOL_SCHEMAS],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const { name, arguments: args } = request.params;

	try {
		await ensureInitialized();

		let result: string;
		const ws = config.honcho.workspace;

		switch (name) {
			case "vault_search":
				result = await vaultSearch(args as VaultSearchInput, honcho, ws);
				break;
			case "vault_read":
				result = await vaultRead(args as VaultReadInput);
				break;
			case "vault_info":
				result = await vaultInfo(args as VaultInfoInput);
				break;
			case "vault_list":
				result = await vaultList(args as VaultListInput);
				break;
			case "vault_graph":
				result = await vaultGraph(args as VaultGraphInput);
				break;
			case "vault_ingest":
				result = await vaultIngest(args as VaultIngestInput, honcho, ingestConfig());
				break;
			case "vault_memory":
				result = await vaultMemory(
					args as VaultMemoryInput,
					honcho,
					ws,
					config.honcho.observed
				);
				break;
			case "vault_status":
				result = await vaultStatus(honcho, ingestConfig());
				break;
			case "vault_dream":
				result = await vaultDream(args as VaultDreamInput, honcho, ingestConfig());
				break;
			case "vault_chat":
				result = await vaultChat(args as VaultChatInput, honcho, ingestConfig());
				break;
			case "vault_sync":
				result = await vaultSync(args as VaultSyncInput, honcho, ingestConfig());
				break;
			case "vault_contextualize":
				result = await vaultContextualize(
					args as VaultContextualizeInput,
					honcho,
					ingestConfig()
				);
				break;
			case "vault_analyze":
				result = await vaultAnalyze(honcho, ingestConfig());
				break;
			case "vault_write":
				result = await vaultWrite(args as VaultWriteInput);
				break;
			default:
				result = `Unknown tool: ${name}`;
		}

		return {
			content: [{ type: "text" as const, text: result }],
		};
	} catch (err) {
		// User-friendly error messages, never raw stack traces
		let message: string;

		if (err instanceof ObsidianNotRunningError) {
			message = err.message;
		} else if (err instanceof ToolInputError) {
			message = `Invalid input: ${err.message}`;
		} else if (err instanceof Error) {
			message = err.message;
		} else {
			message = String(err);
		}

		return {
			content: [{ type: "text" as const, text: `Error: ${message}` }],
			isError: true,
		};
	}
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
	config = loadConfig();

	honcho = new HonchoClient({
		apiKey: config.honcho.apiKey,
		baseUrl: config.honcho.baseUrl,
		apiVersion: config.honcho.apiVersion,
	});

	// Verify Obsidian is running
	try {
		await execObsidian("vault", {});
	} catch (err) {
		if (err instanceof ObsidianNotRunningError) {
			console.error(err.message);
			process.exit(1);
		}
		// Other errors might be OK (e.g. vault name parsing)
	}

	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main();
