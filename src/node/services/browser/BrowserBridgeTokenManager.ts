import { randomBytes } from "node:crypto";
import { assert } from "@/common/utils/assert";
import { log } from "@/node/services/log";

export interface BrowserBridgeTokenPayload {
  workspaceId: string;
  sessionName: string;
  streamPort: number;
  allowOtherWorkspaceSession: boolean;
}

// TokenRecord = the validated payload plus the TTL deadline; extending the
// payload type keeps the field list in one place so a future payload addition
// (e.g. a new scoping flag) cannot drift between the stored record, the mint
// input, and the validate-time rebuild below.
interface TokenRecord extends BrowserBridgeTokenPayload {
  expiresAtMs: number;
}

interface BrowserBridgeTokenMintOptions {
  allowOtherWorkspaceSession?: boolean;
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

  mint(
    workspaceId: string,
    sessionName: string,
    streamPort: number,
    options?: BrowserBridgeTokenMintOptions
  ): string {
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
      allowOtherWorkspaceSession: options?.allowOtherWorkspaceSession === true,
      expiresAtMs: Date.now() + BROWSER_BRIDGE_TOKEN_TTL_MS,
    });

    return token;
  }

  validate(token: string): BrowserBridgeTokenPayload | null {
    const record = this.tokens.get(token);
    if (!record) {
      return null;
    }

    this.tokens.delete(token);

    if (Date.now() > record.expiresAtMs) {
      log.debug("BrowserBridgeTokenManager: token expired", { tokenPrefix: token.slice(0, 8) });
      return null;
    }

    // Strip the TTL deadline; rest-spread keeps the payload field list driven
    // by BrowserBridgeTokenPayload so adding a payload field doesn't require a
    // matching edit here.
    const { expiresAtMs, ...payload } = record;
    return payload;
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
