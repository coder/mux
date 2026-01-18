import type { ParsedCommand } from "./types";

export function getCommandKeyFromParsed(parsed: ParsedCommand): string | null {
  if (!parsed) return null;

  switch (parsed.type) {
    case "providers-set":
    case "providers-help":
    case "providers-invalid-subcommand":
    case "providers-missing-args":
      return "providers";

    case "model-set":
    case "model-help":
      return "model";

    case "vim-toggle":
      return "vim";

    case "init":
      return "init";

    case "clear":
      return "clear";

    case "truncate":
      return "truncate";

    case "compact":
      return "compact";

    case "fork":
    case "fork-help":
      return "fork";

    case "new":
      return "new";

    case "plan-show":
    case "plan-open":
      return "plan";

    case "mcp-add":
    case "mcp-edit":
    case "mcp-remove":
    case "mcp-open":
      return "mcp";

    case "idle-compaction":
      return "idle";

    case "debug-llm-request":
      return "debug-llm-request";

    case "unknown-command":
      return null;

    default:
      return null;
  }
}
