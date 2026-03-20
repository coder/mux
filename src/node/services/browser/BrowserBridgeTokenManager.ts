import { randomBytes } from "node:crypto";
import { assert } from "@/common/utils/assert";
import { log } from "@/node/services/log";

interface TokenRecord {
  workspaceId: string;
  sessionName: string;
  streamPort: number;
  expiresAtMs: number;
}

const BROWSER_BRIDGE_TOKEN_TTL_MS = 30_000;
const CLEANUP_INTERVAL_MS = 60_000;

export class BrowserBridgeTokenManager {
  private readonly tokens = new Map<string, TokenRecord>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  mint(workspaceId: string, sessionName: string, streamPort: number): string {
    assert(workspaceId.length > 0, "BrowserBridgeTokenManager.mint requires non-empty workspaceId");
    assert(sessionName.length > 0, "BrowserBridgeTokenManager.mint requires non-empty sessionName");
    assert(
      Number.isInteger(streamPort),
      "BrowserBridgeTokenManager.mint requires integer streamPort"
    );
    assert(streamPort > 0, "BrowserBridgeTokenManager.mint requires positive streamPort");

    let token = "";
    do {
      token = randomBytes(32).toString("hex");
    } while (this.tokens.has(token));

    this.tokens.set(token, {
      workspaceId,
      sessionName,
      streamPort,
      expiresAtMs: Date.now() + BROWSER_BRIDGE_TOKEN_TTL_MS,
    });

    return token;
  }

  validate(token: string): { workspaceId: string; sessionName: string; streamPort: number } | null {
    const record = this.tokens.get(token);
    if (!record) {
      return null;
    }

    this.tokens.delete(token);

    if (Date.now() > record.expiresAtMs) {
      log.debug("BrowserBridgeTokenManager: token expired", { tokenPrefix: token.slice(0, 8) });
      return null;
    }

    return {
      workspaceId: record.workspaceId,
      sessionName: record.sessionName,
      streamPort: record.streamPort,
    };
  }

  private cleanupExpired(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [token, record] of this.tokens) {
      if (now > record.expiresAtMs) {
        this.tokens.delete(token);
        cleaned += 1;
      }
    }

    if (cleaned > 0) {
      log.debug("BrowserBridgeTokenManager: cleaned up expired tokens", { count: cleaned });
    }
  }

  dispose(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.tokens.clear();
  }
}
