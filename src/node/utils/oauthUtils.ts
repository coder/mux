import type http from "node:http";

/**
 * Shared OAuth utility functions extracted from the individual OAuth service files.
 *
 * These are verbatim-duplicated across codexOauthService, copilotOauthService,
 * muxGatewayOauthService, muxGovernorOauthService, and mcpOauthService.
 */

/** A deferred promise with an externally-accessible `resolve` handle. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

/** Create a deferred promise that can be resolved externally. */
export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Gracefully close an HTTP server, resolving when all connections are drained. */
export function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/** Escape HTML special characters to prevent XSS in rendered callback pages. */
export function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface RenderOAuthCallbackHtmlOptions {
  /** Page and heading title. */
  title: string;
  /** Body message shown below the title. */
  message: string;
  /** When true, the page auto-closes via `window.close()`. */
  success: boolean;
  /** Optional extra content injected into `<head>` (e.g. an external CSS link). */
  extraHead?: string;
}

/**
 * Render the HTML page returned to the browser after an OAuth callback.
 *
 * All four loopback-based services (Gateway, Governor, Codex, MCP) return an
 * HTML page with a title, message, and auto-close script on success. The
 * structure mirrors the common pattern found across those services:
 *
 * - `<!doctype html>` with basic inline styling (centered, system font)
 * - Title in `<h1>`, message in `<p>`
 * - Auto-close `<script>` that calls `window.close()` on success
 * - Support for `extraHead` for provider-specific customization (e.g.
 *   Gateway uses an external CSS link)
 */
export function renderOAuthCallbackHtml(options: RenderOAuthCallbackHtmlOptions): string {
  const title = escapeHtml(options.title);
  const message = escapeHtml(options.message);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark light" />
    <title>${title}</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 600px; margin: 4rem auto; padding: 1rem; }
      h1 { margin-bottom: 1rem; }
      .muted { color: #666; }
    </style>${options.extraHead ? `\n    ${options.extraHead}` : ""}
  </head>
  <body>
    <h1>${title}</h1>
    <p>${message}</p>
    ${
      options.success
        ? '<p class="muted">Mux should now be in the foreground. You can close this tab.</p>'
        : '<p class="muted">You can close this tab.</p>'
    }
    <script>
      (() => {
        const ok = ${options.success ? "true" : "false"};
        if (!ok) return;
        try { window.close(); } catch {}
        setTimeout(() => { try { window.close(); } catch {} }, 50);
      })();
    </script>
  </body>
</html>`;
}
