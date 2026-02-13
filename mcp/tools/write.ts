/**
 * Write operations via Obsidian CLI.
 *
 * vault_write maps actions to CLI commands using Bun.spawn()
 * with array args for safe content passing.
 */

import { execObsidian } from "../cli.ts";
import { ToolInputError, type VaultWriteInput } from "../types.ts";

export async function vaultWrite(input: VaultWriteInput): Promise<string> {
	const { action } = input;

	switch (action) {
		case "create": {
			if (!input.file) throw new ToolInputError("file is required for create");
			const args: Record<string, string | boolean | undefined> = {
				[`name=${input.file}`]: true,
			};
			if (input.content) args[`content=${input.content}`] = true;
			if (input.template) args[`template=${input.template}`] = true;
			if (input.overwrite) args.overwrite = true;
			await execObsidian("create", args);
			return `Created: ${input.file}`;
		}

		case "append": {
			if (!input.file) throw new ToolInputError("file is required for append");
			if (!input.content) throw new ToolInputError("content is required for append");
			const args: Record<string, string | boolean | undefined> = {
				[`file=${input.file}`]: true,
				[`content=${input.content}`]: true,
			};
			if (input.inline) args.inline = true;
			await execObsidian("append", args);
			return `Appended to: ${input.file}`;
		}

		case "prepend": {
			if (!input.file) throw new ToolInputError("file is required for prepend");
			if (!input.content) throw new ToolInputError("content is required for prepend");
			const args: Record<string, string | boolean | undefined> = {
				[`file=${input.file}`]: true,
				[`content=${input.content}`]: true,
			};
			if (input.inline) args.inline = true;
			await execObsidian("prepend", args);
			return `Prepended to: ${input.file}`;
		}

		case "property_set": {
			if (!input.file) throw new ToolInputError("file is required for property_set");
			if (!input.name) throw new ToolInputError("name is required for property_set");
			if (input.value === undefined) throw new ToolInputError("value is required for property_set");
			const args: Record<string, string | boolean | undefined> = {
				[`name=${input.name}`]: true,
				[`value=${input.value}`]: true,
				[`file=${input.file}`]: true,
			};
			if (input.property_type) args[`type=${input.property_type}`] = true;
			await execObsidian("property:set", args);
			return `Set property ${input.name}=${input.value} on ${input.file}`;
		}

		case "property_remove": {
			if (!input.file) throw new ToolInputError("file is required for property_remove");
			if (!input.name) throw new ToolInputError("name is required for property_remove");
			await execObsidian("property:remove", {
				[`name=${input.name}`]: true,
				[`file=${input.file}`]: true,
			});
			return `Removed property ${input.name} from ${input.file}`;
		}

		case "move": {
			if (!input.file) throw new ToolInputError("file is required for move");
			if (!input.to) throw new ToolInputError("to is required for move");
			await execObsidian("move", {
				[`file=${input.file}`]: true,
				[`to=${input.to}`]: true,
			});
			return `Moved ${input.file} to ${input.to}`;
		}

		case "delete": {
			if (!input.file) throw new ToolInputError("file is required for delete");
			const args: Record<string, string | boolean | undefined> = {
				[`file=${input.file}`]: true,
			};
			if (input.permanent) args.permanent = true;
			await execObsidian("delete", args);
			return `Deleted: ${input.file}${input.permanent ? " (permanent)" : ""}`;
		}

		case "bookmark": {
			if (!input.file) throw new ToolInputError("file is required for bookmark");
			await execObsidian("bookmark", { [`file=${input.file}`]: true });
			return `Bookmarked: ${input.file}`;
		}

		case "daily_append": {
			if (!input.content) throw new ToolInputError("content is required for daily_append");
			await execObsidian("daily:append", { [`content=${input.content}`]: true });
			return "Appended to daily note";
		}

		default:
			throw new ToolInputError(`Unknown write action: ${action}`);
	}
}
