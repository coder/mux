// Canonical Coder-related constants shared across mux.
// The ".mux--coder" suffix ensures mux's SSH config block never
// collides with user-managed or Coder CLI-managed SSH entries.

export const MUX_CODER_HOST_SUFFIX = "mux--coder";

/** Build the SSH hostname for a Coder workspace (e.g. `my-ws.mux--coder`). */
export function toMuxCoderHost(workspaceName: string): string {
  return `${workspaceName}.${MUX_CODER_HOST_SUFFIX}`;
}

/**
 * Resolve the canonical SSH host for a Coder workspace.
 * If workspaceName is provided, returns `<name>.mux--coder`;
 * otherwise falls back to the raw host (non-Coder SSH or already-normalized).
 */
export function resolveCoderSSHHost(host: string, workspaceName?: string): string {
  const name = workspaceName?.trim();
  return name ? toMuxCoderHost(name) : host;
}

export const MUX_CODER_SSH_BLOCK_START = "# --- START MUX CODER SSH ---";
export const MUX_CODER_SSH_BLOCK_END = "# --- END MUX CODER SSH ---";
