// Status of a browser session lifecycle
export type BrowserSessionStatus = "starting" | "live" | "paused" | "error" | "ended";

// Who initiated/owns the session
export type BrowserSessionOwnership = "agent" | "user" | "shared";

// A single recorded browser action
export interface BrowserAction {
  id: string;
  type: "navigate" | "click" | "fill" | "screenshot" | "custom";
  description: string;
  timestamp: string; // ISO
  metadata?: Record<string, unknown>;
}

// The full session state snapshot
export interface BrowserSession {
  id: string;
  workspaceId: string;
  status: BrowserSessionStatus;
  ownership: BrowserSessionOwnership;
  currentUrl: string | null;
  title: string | null;
  lastScreenshotBase64: string | null; // JPEG base64
  lastError: string | null;
  startedAt: string; // ISO
  updatedAt: string; // ISO
}

// Events emitted through the ORPC subscribe stream
export type BrowserSessionEvent =
  | { type: "snapshot"; session: BrowserSession | null; recentActions: BrowserAction[] }
  | { type: "session-updated"; session: BrowserSession }
  | { type: "action"; action: BrowserAction }
  | { type: "session-ended"; workspaceId: string }
  | { type: "error"; workspaceId: string; error: string };
