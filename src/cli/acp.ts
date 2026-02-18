import { Command } from "commander";
import { isolateStdoutForAcp, runAcpAdapter } from "../node/acp/adapter";
import { connectToServer } from "../node/acp/serverConnection";
import { getParseOptions } from "./argv";

const program = new Command();

program
  .name("mux acp")
  .description("ACP (Agent-Client Protocol) stdio interface for editor integration")
  .option("--server-url <url>", "URL of a running mux server")
  .option("--auth-token <token>", "Auth token for server connection")
  .action(async (options: Record<string, unknown>) => {
    // Redirect console.log to stderr immediately — before any code that may
    // log to stdout (connectToServer can start an in-process server).
    isolateStdoutForAcp();

    const serverUrl = typeof options.serverUrl === "string" ? options.serverUrl : undefined;
    const authToken = typeof options.authToken === "string" ? options.authToken : undefined;

    console.error("[acp] Connecting to mux server…");
    const connection = await connectToServer({
      serverUrl: serverUrl ?? process.env.MUX_SERVER_URL,
      authToken: authToken ?? process.env.MUX_SERVER_AUTH_TOKEN,
    });
    console.error("[acp] Connected to server at", connection.baseUrl);

    console.error("[acp] Starting ACP adapter — reading stdin");
    await runAcpAdapter(connection);
  });

void program.parseAsync(process.argv, getParseOptions()).catch((error: unknown) => {
  console.error("Failed to start ACP adapter:", error);
  process.exit(1);
});
