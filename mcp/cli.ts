/**
 * CLI transport -- Obsidian CLI via Bun.spawn().
 *
 * Array args (no shell) to prevent injection.
 * Primary transport; REST is the fallback.
 */

import { ObsidianNotRunningError, ObsidianCliError } from "./types.ts";

const NOT_RUNNING_PATTERNS = [
	"obsidian is not running",
	"could not connect",
	"no running instance",
	"not running",
];

/**
 * Execute an Obsidian CLI command via Bun.spawn(). Returns stdout trimmed.
 */
export async function execCli(
	command: string,
	args: Record<string, string | number | boolean | undefined> = {},
	vaultName?: string,
	timeout = 15_000
): Promise<string> {
	const vault = vaultName ?? process.env.OBSIDIAN_VAULT;
	const cmdArgs = ["obsidian", command];

	if (vault) cmdArgs.push(`vault=${vault}`);

	for (const [key, value] of Object.entries(args)) {
		if (value === undefined || value === null) continue;
		if (value === true) {
			cmdArgs.push(key);
		} else if (value !== false) {
			cmdArgs.push(`${key}=${String(value)}`);
		}
	}

	const proc = Bun.spawn(cmdArgs, {
		stdout: "pipe",
		stderr: "pipe",
	});

	const timer = setTimeout(() => proc.kill(), timeout);

	try {
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			const combined = (stderr + stdout).toLowerCase();
			for (const pattern of NOT_RUNNING_PATTERNS) {
				if (combined.includes(pattern)) {
					throw new ObsidianNotRunningError();
				}
			}
			throw new ObsidianCliError(
				`${command} ${Object.entries(args).map(([k, v]) => v === true ? k : `${k}=${v}`).join(" ")}`.trim(),
				stderr || stdout
			);
		}

		return stdout.trim();
	} finally {
		clearTimeout(timer);
	}
}
