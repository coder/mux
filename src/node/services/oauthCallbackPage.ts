/**
 * Shared HTML rendering for all OAuth callback pages (desktop and web mode).
 *
 * All callback pages use the same branded layout (external site.css from
 * gateway.mux.coder.com) so users see a consistent "mux" experience
 * regardless of which OAuth provider they authenticated with.
 */

// -- Escape helpers ----------------------------------------------------------

/** Escape HTML special characters to prevent XSS in interpolated strings. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * JSON-serialize a value and escape `</script>` sequences so the output
 * is safe to embed inside an HTML `<script>` block.
 */
export function escapeJsonForHtmlScript(value: unknown): string {
  // Prevent `</script>` injection when embedding untrusted strings in an inline <script>.
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

// -- Page rendering ----------------------------------------------------------

type CallbackMode =
  /** Desktop: auto-close the tab on success. */
  | { type: "desktop" }
  /** Web: postMessage to opener + "Return to Mux" button. */
  | { type: "web"; payloadJson: string; returnUrl: string };

export interface CallbackPageOptions {
  title: string;
  /** Pre-escaped HTML description (caller is responsible for escaping). */
  description: string;
  success: boolean;
  mode: CallbackMode;
}

/** Generate a fully-styled callback result page. */
export function renderOAuthCallbackPage(opts: CallbackPageOptions): string {
  const { title, description, success, mode } = opts;

  const hintHtml = success
    ? mode.type === "web"
      ? '<p class="muted">This tab should close automatically.</p>'
      : '<p class="muted">Mux should now be in the foreground. You can close this tab.</p>'
    : '<p class="muted">You can close this tab.</p>';

  const returnBtnHtml =
    mode.type === "web"
      ? `<p><a class="btn primary" href="${mode.returnUrl}">Return to Mux</a></p>`
      : "";

  const scriptBody =
    mode.type === "web" ? buildWebScript(mode.payloadJson) : buildDesktopScript(success);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark light" />
    <meta name="theme-color" content="#0e0e0e" />
    <title>${title}</title>
    <link rel="stylesheet" href="https://gateway.mux.coder.com/static/css/site.css" />
  </head>
  <body>
    <div class="page">
      <header class="site-header">
        <div class="container">
          <div class="header-title">mux</div>
        </div>
      </header>

      <main class="site-main">
        <div class="container">
          <div class="content-surface">
            <h1>${title}</h1>
            <p>${description}</p>
            ${hintHtml}
            ${returnBtnHtml}
          </div>
        </div>
      </main>
    </div>

    <script>
      (() => {
${scriptBody}
      })();
    </script>
  </body>
</html>`;
}

function buildDesktopScript(success: boolean): string {
  return `        const ok = ${success ? "true" : "false"};
        if (!ok) return;
        try { window.close(); } catch {}
        setTimeout(() => { try { window.close(); } catch {} }, 50);`;
}

function buildWebScript(payloadJson: string): string {
  return `        const payload = ${payloadJson};
        const ok = payload.ok === true;

        try {
          if (window.opener && typeof window.opener.postMessage === "function") {
            window.opener.postMessage(payload, "*");
          }
        } catch {
          // Ignore postMessage failures.
        }

        if (!ok) {
          return;
        }

        try {
          if (window.opener && typeof window.opener.focus === "function") {
            window.opener.focus();
          }
        } catch {
          // Ignore focus failures.
        }

        try {
          window.close();
        } catch {
          // Ignore close failures.
        }

        setTimeout(() => {
          try {
            window.close();
          } catch {
            // Ignore close failures.
          }
        }, 50);

        setTimeout(() => {
          try {
            window.location.replace("/");
          } catch {
            // Ignore navigation failures.
          }
        }, 150);`;
}
