import * as net from "node:net";
import { assert } from "@/common/utils/assert";

export class BrowserSessionStreamPortRegistry {
  private readonly reservations = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<number>>();
  private readonly reserveEpoch = new Map<string, number>();

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

    const pending = this.inFlight.get(workspaceId);
    if (pending != null) {
      return pending;
    }

    const epoch = (this.reserveEpoch.get(workspaceId) ?? 0) + 1;
    this.reserveEpoch.set(workspaceId, epoch);
    const promise = this.reservePortInternal(workspaceId, epoch);
    this.inFlight.set(workspaceId, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(workspaceId) === promise) {
        this.inFlight.delete(workspaceId);
      }
    }
  }

  private async reservePortInternal(workspaceId: string, epoch: number): Promise<number> {
    const maxRetries = 5;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const port = await findFreePort();
      assert(Number.isFinite(port) && port > 0, `Invalid port allocated: ${port}`);

      let collision = false;
      for (const reservedPort of this.reservations.values()) {
        if (reservedPort === port) {
          collision = true;
          break;
        }
      }

      if (!collision) {
        if (this.reserveEpoch.get(workspaceId) !== epoch) {
          throw new Error(`Port reservation for workspace ${workspaceId} was cancelled`);
        }
        this.reservations.set(workspaceId, port);
        return port;
      }
    }

    throw new Error(
      `Failed to reserve a unique port for workspace ${workspaceId} after ${maxRetries} attempts`
    );
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
    this.reserveEpoch.set(workspaceId, (this.reserveEpoch.get(workspaceId) ?? 0) + 1);
    this.inFlight.delete(workspaceId);
    this.reservations.delete(workspaceId);
  }

  /** Check if a port is reserved for a given workspace */
  isReservedPort(workspaceId: string, port: number): boolean {
    assert(workspaceId.trim().length > 0, "workspaceId must not be empty");
    assert(Number.isFinite(port) && port > 0, `Invalid port lookup: ${port}`);
    return this.reservations.get(workspaceId) === port;
  }

  dispose(): void {
    this.inFlight.clear();
    this.reservations.clear();
    this.reserveEpoch.clear();
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
