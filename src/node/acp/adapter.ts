import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { MuxAgent } from "./agent";
import type { ServerConnection } from "./serverConnection";

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
