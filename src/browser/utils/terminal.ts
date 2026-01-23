/**
 * Terminal utilities for managing terminal sessions.
 */

import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";

type APIClient = RouterClient<AppRouter>;

/** Default terminal size used when creating sessions before the terminal is mounted */

export interface TerminalSessionCreateOptions {
  /** Optional command to run immediately after terminal creation */
  initialCommand?: string;
}
export const DEFAULT_TERMINAL_SIZE = { cols: 80, rows: 24 };

/**
 * Create a new terminal session with default size.
 *
 * @param api - The API client
 * @param workspaceId - Workspace ID
 * @returns The created session with sessionId
 */
export async function createTerminalSession(
  api: APIClient,
  workspaceId: string,
  options?: TerminalSessionCreateOptions
): Promise<{ sessionId: string; workspaceId: string; cols: number; rows: number }> {
  return api.terminal.create({
    workspaceId,
    cols: DEFAULT_TERMINAL_SIZE.cols,
    rows: DEFAULT_TERMINAL_SIZE.rows,
    initialCommand: options?.initialCommand,
  });
}
