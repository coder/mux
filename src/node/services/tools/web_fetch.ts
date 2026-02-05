import { tool } from "ai";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { WebFetchToolResult } from "@/common/types/tools";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import {
  WEB_FETCH_TIMEOUT_SECS,
  WEB_FETCH_MAX_OUTPUT_BYTES,
  WEB_FETCH_MAX_HTML_BYTES,
} from "@/common/constants/toolLimits";
import { execBuffered } from "@/node/utils/runtime/helpers";
import {
  downloadFromMuxMd,
  getMuxMdAllowedHosts,
  isMuxMdUrl,
  parseMuxMdUrl,
} from "@/common/lib/muxMd";

const USER_AGENT = "Mux/1.0 (https://github.com/coder/mux; web-fetch tool)";

/** Parse curl -i output into headers and body */
function parseResponse(output: string): { headers: string; body: string; statusCode: string } {
  // Find the last HTTP status line (after redirects) and its headers
  // curl -i with -L shows all redirect responses, we want the final one
  const httpMatches = [...output.matchAll(/HTTP\/[\d.]+ (\d{3})[^\r\n]*/g)];
  const lastStatusMatch = httpMatches.length > 0 ? httpMatches[httpMatches.length - 1] : null;
  const statusCode = lastStatusMatch ? lastStatusMatch[1] : "";

  // Headers end with \r\n\r\n (or \n\n for some servers)
  const headerEndIndex = output.indexOf("\r\n\r\n");
  const altHeaderEndIndex = output.indexOf("\n\n");
  const splitIndex =
    headerEndIndex !== -1
      ? headerEndIndex + 4
      : altHeaderEndIndex !== -1
        ? altHeaderEndIndex + 2
        : 0;

  const headers = splitIndex > 0 ? output.slice(0, splitIndex).toLowerCase() : "";
  const body = splitIndex > 0 ? output.slice(splitIndex) : output;

  return { headers, body, statusCode };
}

/** Detect if error response is a Cloudflare challenge page */
function isCloudflareChallenge(headers: string, body: string): boolean {
  return (
    headers.includes("cf-mitigated") ||
    (body.includes("Just a moment") && body.includes("Enable JavaScript"))
  );
}

/** Try to extract readable content from HTML, returns null on failure */
function tryExtractContent(
  body: string,
  url: string,
  maxBytes: number
): { title: string; content: string } | null {
  try {
    const dom = new JSDOM(body, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article?.content) return null;

    const turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });
    let content = turndown.turndown(article.content);
    if (content.length > maxBytes) {
      content = content.slice(0, maxBytes) + "\n\n[Content truncated]";
    }
    return { title: article.title ?? "Untitled", content };
  } catch {
    return null;
  }
}

function isAllowedMuxMdHost(url: string): boolean {
  try {
    return getMuxMdAllowedHosts().includes(new URL(url).host);
  } catch {
    return false;
  }
}

/**
 * Web fetch tool factory for AI assistant
 * Creates a tool that fetches web pages and extracts readable content as markdown
 * Uses curl via Runtime to respect workspace network context
 * @param config Required configuration including runtime
 */
export const createWebFetchTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.web_fetch.description,
    inputSchema: TOOL_DEFINITIONS.web_fetch.schema,
    execute: async ({ url }, { abortSignal }): Promise<WebFetchToolResult> => {
      try {
        // Handle mux.md share links with client-side decryption.
        // Important: `parseMuxMdUrl` does not validate the host, so we must guard with `isMuxMdUrl`
        // to avoid treating arbitrary URLs (including those with `#fragment`) as share links.
        if (isMuxMdUrl(url)) {
          const muxMdParsed = parseMuxMdUrl(url);
          if (!muxMdParsed) {
            return { success: false, error: "Invalid mux.md URL format" };
          }

          const baseUrl = new URL(url).origin;

          try {
            const result = await downloadFromMuxMd(muxMdParsed.id, muxMdParsed.key, abortSignal, {
              baseUrl,
            });
            let content = result.content;
            if (content.length > WEB_FETCH_MAX_OUTPUT_BYTES) {
              content = content.slice(0, WEB_FETCH_MAX_OUTPUT_BYTES) + "\n\n[Content truncated]";
            }
            return {
              success: true,
              title: result.fileInfo?.name ?? "Shared Message",
              content,
              url,
              length: content.length,
            };
          } catch (err) {
            return {
              success: false,
              error: err instanceof Error ? err.message : "Failed to download from mux.md",
            };
          }
        }

        if (isAllowedMuxMdHost(url)) {
          return { success: false, error: "Invalid mux.md URL format" };
        }

        // Build curl command with safe defaults
        // Use shell quoting helper to escape values safely
        const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

        const curlCommand = [
          "curl",
          "-sS", // Silent but show errors
          "-L", // Follow redirects
          "-i", // Include headers in output
          "--fail-with-body", // Return exit code 22 for HTTP 4xx/5xx but still output body
          "--max-time",
          String(WEB_FETCH_TIMEOUT_SECS),
          "--max-filesize",
          String(WEB_FETCH_MAX_HTML_BYTES),
          "-A",
          shellQuote(USER_AGENT),
          "--compressed", // Accept gzip/deflate
          "-H",
          shellQuote(
            "Accept: text/markdown, text/x-markdown, text/plain, text/html, application/xhtml+xml"
          ),
          shellQuote(url),
        ].join(" ");

        // Execute via Runtime (respects workspace network context)
        const result = await execBuffered(config.runtime, curlCommand, {
          cwd: config.cwd,
          abortSignal,
          timeout: WEB_FETCH_TIMEOUT_SECS + 5, // Slightly longer than curl's timeout (seconds)
        });

        if (result.exitCode !== 0) {
          // curl exit codes: https://curl.se/docs/manpage.html
          const exitCodeMessages: Record<number, string> = {
            6: "Could not resolve host",
            7: "Failed to connect",
            28: "Operation timed out",
            35: "SSL/TLS handshake failed",
            56: "Network data receive error",
            63: "Maximum file size exceeded",
          };

          // For HTTP errors (exit 22), try to parse and include the error body
          if (result.exitCode === 22 && result.stdout) {
            const { headers, body, statusCode } = parseResponse(result.stdout);
            const statusText = statusCode ? `HTTP ${statusCode}` : "HTTP error";

            // Detect Cloudflare challenge pages
            if (isCloudflareChallenge(headers, body)) {
              return {
                success: false,
                error: `${statusText}: Cloudflare security challenge (page requires JavaScript)`,
              };
            }

            // Try to extract readable content from error page
            const extracted = tryExtractContent(body, url, WEB_FETCH_MAX_OUTPUT_BYTES);
            if (extracted) {
              return {
                success: false,
                error: statusText,
                content: extracted.content,
              };
            }

            return {
              success: false,
              error: statusText,
            };
          }

          const reason = exitCodeMessages[result.exitCode] || result.stderr || "Unknown error";
          return {
            success: false,
            error: `Failed to fetch URL: ${reason}`,
          };
        }

        // Parse headers and body from curl -i output
        const { headers, body } = parseResponse(result.stdout);

        if (!body || body.trim().length === 0) {
          return {
            success: false,
            error: "Empty response from URL",
          };
        }

        // Check content-type to determine processing strategy
        const contentTypeMatch = /content-type:\s*([^\r\n;]+)/.exec(headers);
        const contentType = contentTypeMatch ? contentTypeMatch[1].trim() : "";
        const isPlainText =
          contentType.includes("text/plain") ||
          contentType.includes("text/markdown") ||
          contentType.includes("text/x-markdown");

        // For plain text/markdown, return as-is without HTML processing
        if (isPlainText) {
          let content = body;
          if (content.length > WEB_FETCH_MAX_OUTPUT_BYTES) {
            content = content.slice(0, WEB_FETCH_MAX_OUTPUT_BYTES) + "\n\n[Content truncated]";
          }
          return {
            success: true,
            title: url,
            content,
            url,
            length: content.length,
          };
        }

        // Parse HTML with JSDOM (runs locally in Mux, not over SSH)
        const dom = new JSDOM(body, { url });

        // Extract article with Readability
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        if (!article) {
          return {
            success: false,
            error: "Could not extract readable content from page",
          };
        }

        // Convert to markdown
        const turndown = new TurndownService({
          headingStyle: "atx",
          codeBlockStyle: "fenced",
        });
        let content = turndown.turndown(article.content ?? "");

        // Truncate if needed
        if (content.length > WEB_FETCH_MAX_OUTPUT_BYTES) {
          content = content.slice(0, WEB_FETCH_MAX_OUTPUT_BYTES) + "\n\n[Content truncated]";
        }

        return {
          success: true,
          title: article.title ?? "Untitled",
          content,
          url,
          byline: article.byline ?? undefined,
          length: content.length,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          error: `web_fetch error: ${message}`,
        };
      }
    },
  });
};
