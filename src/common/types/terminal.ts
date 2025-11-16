/**
 * Terminal session types
 */

export interface TerminalSession {
  sessionId: string;
  workspaceId: string;
  cols: number;
  rows: number;
}

export interface TerminalCreateParams {
  workspaceId: string;
  cols: number;
  rows: number;
}

export interface TerminalResizeParams {
  sessionId: string;
  cols: number;
  rows: number;
}
