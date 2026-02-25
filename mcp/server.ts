#!/usr/bin/env bun
/**
 * Obsidian-Honcho MCP Server
 *
 * 9 tools: 6 pure vault + 3 bridge (obsidian workspace specific).
 * No filesystem access. Everything goes through CLI/REST or Honcho API.
 *
 * The generic Honcho MCP (mcp.honcho.dev) handles workspace-agnostic
 * operations (search, chat, create_conclusion). This server handles
 * vault access and obsidian-workspace-specific Honcho operations.
 *
 * Transport: CLI primary (Obsidian 1.12+), REST fallback (Local REST API plugin).
 * Auto-detected on first call. Override with OBSIDIAN_TRANSPORT=cli|rest.
 *
 * Environment variables:
 *   HONCHO_API_KEY       - Required. Honcho API key.
 *   HONCHO_BASE_URL      - Optional. Default: https://api.honcho.dev
 *   HONCHO_WORKSPACE     - Optional. Default: vault name.
 *   HONCHO_PEER          - Optional. Default: eri.
 *   OBSIDIAN_VAULT       - Optional. Active vault if unset.
 *   OBSIDIAN_TRANSPORT   - Optional. auto|cli|rest. Default: auto.
 *   OBSIDIAN_REST_URL    - Optional. Default: http://127.0.0.1:27123
 *   OBSIDIAN_REST_KEY    - Optional. Local REST API plugin key.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { execObsidian } from "./api.ts";
import { HonchoService } from "./honcho.ts";
import {
	loadConfig,
	TOOL_SCHEMAS,
	ObsidianNotRunningError,
	ToolInputError,
	type ServerConfig,
	type VaultReadInput,
	type VaultWriteInput,
	type VaultSearchInput,
	type VaultInfoInput,
	type VaultListInput,
	type VaultGraphInput,
	type VaultClassifyInput,
	type VaultReflectInput,
} from "./types.ts";

// Pure vault tools
import { vaultSearch, vaultRead, vaultInfo, vaultList, vaultGraph } from "./tools/vault.ts";
import { vaultWrite } from "./tools/write.ts";

// Bridge tools (obsidian workspace specific)
import { vaultClassify, vaultReflect, vaultStatus } from "./tools/bridge.ts";

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

let config: ServerConfig;
let honcho: HonchoService;

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
	{
		name: "obsidian-honcho",
		version: "0.4.0",
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
		let result: string;

		switch (name) {
			// Pure vault tools -- no Honcho dependency
			case "vault_read":
				result = await vaultRead(args as VaultReadInput);
				break;
			case "vault_write":
				result = await vaultWrite(args as VaultWriteInput);
				break;
			case "vault_search":
				result = await vaultSearch(args as VaultSearchInput);
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

			// Bridge tools -- obsidian workspace specific, lazy Honcho init
			case "vault_classify":
				await honcho.ensureInitialized();
				result = await vaultClassify(args as VaultClassifyInput, honcho);
				break;
			case "vault_reflect":
				await honcho.ensureInitialized();
				result = await vaultReflect(args as VaultReflectInput, honcho);
				break;
			case "vault_status":
				await honcho.ensureInitialized();
				result = await vaultStatus(honcho);
				break;

			default:
				result = `Unknown tool: ${name}`;
		}

		return {
			content: [{ type: "text" as const, text: result }],
		};
	} catch (err) {
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

	// Resolve workspace from CLI if not set
	if (!config.honcho.workspace) {
		try {
			const vaultInfo = await execObsidian("vault", {});
			const nameMatch = vaultInfo.match(/^(.+?)[\t\n]/);
			config.honcho.workspace = nameMatch?.[1]?.trim() || vaultInfo.split("\n")[0]?.trim() || "default";
		} catch {
			config.honcho.workspace = "default";
		}
	}

	honcho = new HonchoService({
		apiKey: config.honcho.apiKey,
		baseUrl: config.honcho.baseUrl,
		apiVersion: config.honcho.apiVersion,
		workspace: config.honcho.workspace,
		peer: config.honcho.peer,
	});

	// Verify Obsidian is running
	try {
		await execObsidian("vault", {});
	} catch (err) {
		if (err instanceof ObsidianNotRunningError) {
			console.error(err.message);
			process.exit(1);
		}
	}

	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main();
