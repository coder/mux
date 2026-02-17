import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { MuxAgent } from "./agent";
import type { ServerConnection } from "./serverConnection";

/**
 * ACP framing is sent over process.stdout. Any non-protocol output to stdout
 * (e.g., from mux's logger at info/debug level, or from an in-process server)
 * would corrupt the NDJSON stream seen by editors.
 *
 * Redirect `console.log` to stderr so that only ACP protocol messages appear
 * on stdout.  `console.error`/`console.warn` already target stderr.
 */
function isolateStdoutForAcp(): void {
  console.log = console.error;
}

export async function runAcpAdapter(server: ServerConnection): Promise<void> {
  assert(server != null, "runAcpAdapter: server connection is required");

  // Redirect all console.log output to stderr before creating the ACP
  // stream so that logger info/debug messages do not corrupt the protocol.
  isolateStdoutForAcp();

  // ACP SDK expects Web streams; process stdio is Node stream instances.
  const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const stream = ndJsonStream(output, input);

  const connection = new AgentSideConnection((conn) => new MuxAgent(conn, server), stream);

  try {
    await connection.closed;
  } finally {
    await server.close();
  }
}
