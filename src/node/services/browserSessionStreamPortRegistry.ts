import * as net from "node:net";
import { assert } from "@/common/utils/assert";

export class BrowserSessionStreamPortRegistry {
  private readonly reservations = new Map<string, number>();

  /** Reserve (or return existing) free port for a workspace */
  async reservePort(workspaceId: string): Promise<number> {
    assert(workspaceId.trim().length > 0, "workspaceId must not be empty");
    const existing = this.reservations.get(workspaceId);
    if (existing != null) {
      assert(
        Number.isFinite(existing) && existing > 0,
        `Invalid reserved port for ${workspaceId}: ${existing}`
      );
      return existing;
    }

    const port = await findFreePort();
    assert(Number.isFinite(port) && port > 0, `Invalid port allocated: ${port}`);
    for (const [reservedWorkspaceId, reservedPort] of this.reservations) {
      assert(
        reservedPort !== port,
        `Port ${port} already reserved for workspace ${reservedWorkspaceId}`
      );
    }

    this.reservations.set(workspaceId, port);
    return port;
  }

  /** Get the reserved port without allocating */
  getReservedPort(workspaceId: string): number | null {
    assert(workspaceId.trim().length > 0, "workspaceId must not be empty");
    const reservedPort = this.reservations.get(workspaceId) ?? null;
    if (reservedPort !== null) {
      assert(
        Number.isFinite(reservedPort) && reservedPort > 0,
        `Invalid reserved port for ${workspaceId}: ${reservedPort}`
      );
    }
    return reservedPort;
  }

  /** Release the port reservation for a workspace */
  releasePort(workspaceId: string): void {
    assert(workspaceId.trim().length > 0, "workspaceId must not be empty");
    this.reservations.delete(workspaceId);
  }

  /** Check if a port is reserved for a given workspace */
  isReservedPort(workspaceId: string, port: number): boolean {
    assert(workspaceId.trim().length > 0, "workspaceId must not be empty");
    assert(Number.isFinite(port) && port > 0, `Invalid port lookup: ${port}`);
    return this.reservations.get(workspaceId) === port;
  }

  dispose(): void {
    this.reservations.clear();
  }
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address != null && typeof address === "object", "Expected address object");
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}
