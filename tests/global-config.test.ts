import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { loadGlobalDefaults, saveGlobalConfig } from "../src/global-config";

let tmpDir: string;
let configFile: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "honcho-test-"));
	configFile = path.join(tmpDir, "config.json");
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadGlobalDefaults", () => {
	test("returns empty object when config file does not exist", () => {
		expect(loadGlobalDefaults(path.join(tmpDir, "nonexistent.json"))).toEqual({});
	});

	test("reads apiKey and peerName", () => {
		fs.writeFileSync(configFile, JSON.stringify({ apiKey: "test-key", peerName: "alice" }));
		const result = loadGlobalDefaults(configFile);
		expect(result.apiKey).toBe("test-key");
		expect(result.peerName).toBe("alice");
	});

	test("reads workspace from obsidian host block", () => {
		fs.writeFileSync(
			configFile,
			JSON.stringify({ hosts: { obsidian: { workspace: "my-vault" } } })
		);
		expect(loadGlobalDefaults(configFile).workspace).toBe("my-vault");
	});

	test("resolves baseUrl from explicit baseUrl (strips /v3 suffix)", () => {
		fs.writeFileSync(
			configFile,
			JSON.stringify({ endpoint: { baseUrl: "http://localhost:8000/v3" } })
		);
		expect(loadGlobalDefaults(configFile).baseUrl).toBe("http://localhost:8000");
	});

	test("resolves baseUrl to localhost when environment is local", () => {
		fs.writeFileSync(configFile, JSON.stringify({ endpoint: { environment: "local" } }));
		expect(loadGlobalDefaults(configFile).baseUrl).toBe("http://localhost:8000");
	});

	test("returns empty object on corrupt JSON", () => {
		fs.writeFileSync(configFile, "{ invalid json }");
		expect(loadGlobalDefaults(configFile)).toEqual({});
	});

	test("ignores undefined optional fields", () => {
		// No apiKey / peerName in the JSON
		fs.writeFileSync(configFile, JSON.stringify({ hosts: {} }));
		const result = loadGlobalDefaults(configFile);
		expect(result.apiKey).toBeUndefined();
		expect(result.peerName).toBeUndefined();
	});
});

describe("saveGlobalConfig", () => {
	test("creates config file if absent", () => {
		saveGlobalConfig({ apiKey: "key1", peerName: "bob", workspace: "vault1" }, configFile);

		expect(fs.existsSync(configFile)).toBe(true);
		const saved = JSON.parse(fs.readFileSync(configFile, "utf-8"));
		expect(saved.apiKey).toBe("key1");
		expect(saved.peerName).toBe("bob");
		expect(saved.hosts?.obsidian?.workspace).toBe("vault1");
	});

	test("preserves other hosts blocks on re-save", () => {
		fs.writeFileSync(
			configFile,
			JSON.stringify({ apiKey: "old", hosts: { cursor: { workspace: "cursor-ws" } } })
		);

		saveGlobalConfig({ apiKey: "new", peerName: "carol", workspace: "ws2" }, configFile);

		const saved = JSON.parse(fs.readFileSync(configFile, "utf-8"));
		expect(saved.hosts?.cursor?.workspace).toBe("cursor-ws");
		expect(saved.hosts?.obsidian?.workspace).toBe("ws2");
	});

	test("writes custom baseUrl to endpoint block", () => {
		saveGlobalConfig(
			{ apiKey: "k", peerName: "p", workspace: "w", baseUrl: "http://localhost:8000" },
			configFile
		);
		const saved = JSON.parse(fs.readFileSync(configFile, "utf-8"));
		expect(saved.endpoint?.baseUrl).toBe("http://localhost:8000");
	});

	test("does not write endpoint block for default production URL", () => {
		saveGlobalConfig(
			{ apiKey: "k", peerName: "p", workspace: "w", baseUrl: "https://api.honcho.dev" },
			configFile
		);
		const saved = JSON.parse(fs.readFileSync(configFile, "utf-8"));
		expect(saved.endpoint?.baseUrl).toBeUndefined();
	});

	test("round-trips: save then load returns the same values", () => {
		saveGlobalConfig(
			{ apiKey: "mykey", peerName: "dave", workspace: "myvault" },
			configFile
		);
		const loaded = loadGlobalDefaults(configFile);
		expect(loaded.apiKey).toBe("mykey");
		expect(loaded.peerName).toBe("dave");
		expect(loaded.workspace).toBe("myvault");
	});
});
