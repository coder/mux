import { Command } from "commander";
import { getParseOptions } from "./argv";

const program = new Command();

program
  .name("mux acp")
  .description("ACP (Agent-Client Protocol) stdio interface for editor integration")
  .option("--server-url <url>", "URL of a running mux server")
  .option("--auth-token <token>", "Auth token for server connection")
  .action(async (options: Record<string, unknown>) => {
    const { connectToServer } = await import("../node/acp/serverConnection");
    const { runAcpAdapter } = await import("../node/acp/adapter");

    const serverUrl = typeof options.serverUrl === "string" ? options.serverUrl : undefined;
    const authToken = typeof options.authToken === "string" ? options.authToken : undefined;

    const connection = await connectToServer({
      serverUrl: serverUrl ?? process.env.MUX_SERVER_URL,
      authToken: authToken ?? process.env.MUX_SERVER_AUTH_TOKEN,
    });

    await runAcpAdapter(connection);
  });

void program.parseAsync(process.argv, getParseOptions()).catch((error: unknown) => {
  console.error("Failed to start ACP adapter:", error);
  process.exit(1);
});
