import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { MuxAgent } from "./agent";
import type { ServerConnection } from "./serverConnection";

/**
 * ACP framing is sent over process.stdout.  Any non-protocol output to stdout
 * (e.g., from mux's logger at info/debug level, or from an in-process server)
 * would corrupt the NDJSON stream seen by editors.
 *
 * Call this **before** any code that may log to stdout (including
 * `connectToServer`, which may start an in-process server).
 *
 * `console.error`/`console.warn` already target stderr and are unaffected.
 */
export function isolateStdoutForAcp(): void {
  console.log = console.error;
}

export async function runAcpAdapter(server: ServerConnection): Promise<void> {
  assert(server != null, "runAcpAdapter: server connection is required");

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
