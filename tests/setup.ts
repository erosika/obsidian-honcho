/**
 * Preload: runs before every test file.
 * Mocks the "obsidian" module so tests can import plugin source
 * files without being inside Electron/Obsidian.
 */
import { mock } from "bun:test";

mock.module("obsidian", () => {
	const requestUrl = mock(async (_req: unknown) => ({
		status: 200,
		json: {},
		text: "",
	}));

	class TFile {
		path: string;
		name: string;
		basename: string;
		extension = "md";
		stat = { mtime: Date.now(), ctime: Date.now(), size: 0 };

		constructor(path: string) {
			this.path = path;
			this.name = path.split("/").pop() ?? path;
			this.basename = this.name.replace(/\.[^.]+$/, "");
		}
	}

	class TFolder {
		path: string;
		name: string;
		children: unknown[] = [];

		constructor(path: string) {
			this.path = path;
			this.name = path.split("/").pop() ?? path;
		}
	}

	class Notice {
		constructor(_message: string, _timeout?: number) {}
	}

	return { requestUrl, TFile, TFolder, Notice };
});
