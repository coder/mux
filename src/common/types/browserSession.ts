// Status of a browser session lifecycle
export type BrowserSessionStatus = "starting" | "live" | "paused" | "error" | "ended";

// A single recorded browser action
export interface BrowserAction {
  id: string;
  type: "navigate" | "click" | "fill" | "screenshot" | "custom";
  description: string;
  timestamp: string; // ISO
  metadata?: Record<string, unknown>;
}

// Transport state for the streaming WebSocket bridge
export type BrowserStreamState =
  | "disconnected"
  | "connecting"
  | "live"
  | "restart_required"
  | "error";

// Frame metadata from the agent-browser streaming protocol
export interface BrowserFrameMetadata {
  deviceWidth: number;
  deviceHeight: number;
  pageScaleFactor: number;
  offsetTop: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
}

// Input event union for human interaction injection
export type BrowserInputEvent = BrowserMouseInput | BrowserKeyboardInput | BrowserTouchInput;

export interface BrowserMouseInput {
  kind: "mouse";
  eventType: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
  x: number;
  y: number;
  button?: "left" | "right" | "middle" | "none";
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  modifiers?: number;
}

export interface BrowserKeyboardInput {
  kind: "keyboard";
  eventType: "keyDown" | "keyUp" | "char";
  key?: string;
  code?: string;
  text?: string;
  modifiers?: number;
}

export interface BrowserTouchInput {
  kind: "touch";
  eventType: "touchStart" | "touchEnd" | "touchMove" | "touchCancel";
  touchPoints: Array<{ x: number; y: number; id?: number }>;
  modifiers?: number;
}

// The full session state snapshot
export interface BrowserSession {
  id: string;
  workspaceId: string;
  status: BrowserSessionStatus;
  currentUrl: string | null;
  title: string | null;
  lastScreenshotBase64: string | null; // JPEG base64
  lastError: string | null;
  streamState: BrowserStreamState | null;
  lastFrameMetadata: BrowserFrameMetadata | null;
  streamErrorMessage: string | null;
  startedAt: string; // ISO
  updatedAt: string; // ISO
}

// Events emitted through the ORPC subscribe stream
export type BrowserSessionEvent =
  | { type: "snapshot"; session: BrowserSession | null; recentActions: BrowserAction[] }
  | { type: "session-updated"; session: BrowserSession }
  | { type: "action"; action: BrowserAction }
  | { type: "heartbeat" }
  | { type: "session-ended"; workspaceId: string }
  | { type: "error"; workspaceId: string; error: string };
