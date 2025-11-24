import { parseCommand } from "../src/browser/utils/slashCommands/parser";

try {
  const result = parseCommand("/providers");
  console.log("Parsing /providers:", JSON.stringify(result, null, 2));

  const result2 = parseCommand("/providers set anthropic apiKey 123");
  console.log("Parsing /providers set:", JSON.stringify(result2, null, 2));

  const result4 = parseCommand("/providers ");
  console.log("Parsing /providers (space):", JSON.stringify(result4, null, 2));
} catch (e) {
  console.error("Error:", e);
}
