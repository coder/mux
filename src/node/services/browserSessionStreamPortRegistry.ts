import * as net from "node:net";
import { getMuxBrowserSessionId } from "@/common/utils/browserSession";
import { assert } from "@/common/utils/assert";
import type { BrowserSessionAttachmentStore } from "@/node/services/browserSessionAttachmentStore";
import { log } from "@/node/services/log";

type BrowserSessionAttachmentStoreLike = Pick<
  BrowserSessionAttachmentStore,
  "getAttachment" | "writeAttachment" | "deleteAttachment"
>;

interface BrowserSessionStreamPortRegistryOptions {
  attachmentStore?: BrowserSessionAttachmentStoreLike | null;
}

export class BrowserSessionStreamPortRegistry {
  private readonly reservations = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<number>>();
  private readonly reserveEpoch = new Map<string, number>();
  private readonly attachmentStore: BrowserSessionAttachmentStoreLike | null;

  constructor(options?: BrowserSessionStreamPortRegistryOptions) {
    this.attachmentStore = options?.attachmentStore ?? null;
  }

  /** Reserve (or return existing) free port for a workspace */
  async reservePort(workspaceId: string): Promise<number> {
    assert(workspaceId.trim().length > 0, "workspaceId must not be empty");
    const existing = this.getCachedReservedPort(workspaceId);
    if (existing != null) {
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
    const knownPort = this.getKnownPort(workspaceId);
    if (knownPort != null) {
      this.assertWorkspaceReservationEpoch(workspaceId, epoch);
      this.reservations.set(workspaceId, knownPort);
      return knownPort;
    }

    const maxRetries = 5;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const port = await findFreePort();
      assert(Number.isFinite(port) && port > 0, `Invalid port allocated: ${port}`);

      if (this.isPortReservedByAnotherWorkspace(workspaceId, port)) {
        continue;
      }

      this.assertWorkspaceReservationEpoch(workspaceId, epoch);
      this.reservations.set(workspaceId, port);
      this.writeAttachmentBestEffort(workspaceId, port);
      return port;
    }

    throw new Error(
      `Failed to reserve a unique port for workspace ${workspaceId} after ${maxRetries} attempts`
    );
  }

  /** Get the reserved port without allocating */
  getReservedPort(workspaceId: string): number | null {
    assert(workspaceId.trim().length > 0, "workspaceId must not be empty");
    return this.getCachedReservedPort(workspaceId);
  }

  /** Return the reserved port, falling back to persisted attach metadata. */
  getKnownPort(workspaceId: string): number | null {
    assert(workspaceId.trim().length > 0, "workspaceId must not be empty");

    const cachedPort = this.getCachedReservedPort(workspaceId);
    if (cachedPort != null) {
      return cachedPort;
    }

    const attachment = this.attachmentStore?.getAttachment(workspaceId) ?? null;
    if (attachment == null) {
      return null;
    }

    assert(
      attachment.sessionId === getMuxBrowserSessionId(workspaceId),
      `Invalid persisted browser session attachment for ${workspaceId}: ${attachment.sessionId}`
    );
    assert(
      Number.isFinite(attachment.streamPort) && attachment.streamPort > 0,
      `Invalid persisted stream port for ${workspaceId}: ${attachment.streamPort}`
    );
    if (this.isPortReservedByAnotherWorkspace(workspaceId, attachment.streamPort)) {
      this.deleteAttachmentBestEffort(workspaceId);
      return null;
    }

    return attachment.streamPort;
  }

  /** Release the port reservation for a workspace */
  releasePort(workspaceId: string): void {
    assert(workspaceId.trim().length > 0, "workspaceId must not be empty");
    this.reserveEpoch.set(workspaceId, (this.reserveEpoch.get(workspaceId) ?? 0) + 1);
    this.inFlight.delete(workspaceId);
    this.reservations.delete(workspaceId);
    this.deleteAttachmentBestEffort(workspaceId);
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

  private getCachedReservedPort(workspaceId: string): number | null {
    const reservedPort = this.reservations.get(workspaceId) ?? null;
    if (reservedPort !== null) {
      assert(
        Number.isFinite(reservedPort) && reservedPort > 0,
        `Invalid reserved port for ${workspaceId}: ${reservedPort}`
      );
    }
    return reservedPort;
  }

  private assertWorkspaceReservationEpoch(workspaceId: string, epoch: number): void {
    if (this.reserveEpoch.get(workspaceId) !== epoch) {
      throw new Error(`Port reservation for workspace ${workspaceId} was cancelled`);
    }
  }

  private isPortReservedByAnotherWorkspace(workspaceId: string, port: number): boolean {
    for (const [otherWorkspaceId, reservedPort] of this.reservations.entries()) {
      if (otherWorkspaceId !== workspaceId && reservedPort === port) {
        return true;
      }
    }

    return false;
  }

  private writeAttachmentBestEffort(workspaceId: string, port: number): void {
    try {
      this.attachmentStore?.writeAttachment(workspaceId, port);
    } catch (error) {
      log.warn("Failed to persist browser session attachment", { workspaceId, port, error });
    }
  }

  private deleteAttachmentBestEffort(workspaceId: string): void {
    try {
      this.attachmentStore?.deleteAttachment(workspaceId);
    } catch (error) {
      log.warn("Failed to clear browser session attachment", { workspaceId, error });
    }
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
