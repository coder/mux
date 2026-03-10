import { tool } from "ai";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import * as net from "node:net";
import type { WebFetchToolResult } from "@/common/types/tools";
import { shellQuote } from "@/common/utils/shell";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import {
  WEB_FETCH_TIMEOUT_SECS,
  WEB_FETCH_MAX_OUTPUT_BYTES,
  WEB_FETCH_MAX_HTML_BYTES,
} from "@/common/constants/toolLimits";
import * as runtimeHelpers from "@/node/utils/runtime/helpers";
import {
  downloadFromMuxMd,
  getMuxMdAllowedHosts,
  isMuxMdUrl,
  parseMuxMdUrl,
} from "@/common/lib/muxMd";
import { getErrorMessage } from "@/common/utils/errors";

const USER_AGENT = "Mux/1.0 (https://github.com/coder/mux; web-fetch tool)";
const WEB_FETCH_MAX_REDIRECTS = 10;
const WEB_FETCH_RESOLVE_TIMEOUT_SECS = 5;
const WEB_FETCH_ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const WEB_FETCH_BLOCKED_TARGET_ERROR =
  "Blocked URL: web_fetch cannot access loopback, private, link-local, or internal network targets";
const WEB_FETCH_RESOLVE_ERROR = "Failed to fetch URL: Could not resolve host";
const WEB_FETCH_BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "host.docker.internal",
  "gateway.docker.internal",
  "kubernetes.default.svc",
]);

class WebFetchValidationError extends Error {}

/**
 * Strip <style> and <script> blocks from HTML before JSDOM parsing.
 * JSDOM's CSS parser scans minified CSS character-by-character for line
 * terminators; pages like Google Cloud's pricing ship MB of newline-free
 * CSS that pins the CPU for minutes. Readability only needs DOM structure
 * and visible text, so these blocks are dead weight.
 */
function stripHeavyTags(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
}

function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim();
  const withoutBrackets =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return withoutBrackets.replace(/\.$/, "").toLowerCase();
}

function parseIpv4Octets(address: string): number[] | null {
  if (net.isIP(address) !== 4) {
    return null;
  }

  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  if (
    octets.length !== 4 ||
    octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)
  ) {
    return null;
  }

  return octets;
}

function parseIpv6Segments(address: string): number[] | null {
  let normalized = address.trim().toLowerCase();
  const zoneIndex = normalized.indexOf("%");
  if (zoneIndex !== -1) {
    normalized = normalized.slice(0, zoneIndex);
  }
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  if (net.isIP(normalized) !== 6) {
    return null;
  }

  if (normalized.includes(".")) {
    const lastColonIndex = normalized.lastIndexOf(":");
    if (lastColonIndex === -1) {
      return null;
    }

    const ipv4Octets = parseIpv4Octets(normalized.slice(lastColonIndex + 1));
    if (!ipv4Octets) {
      return null;
    }

    normalized = `${normalized.slice(0, lastColonIndex)}:${((ipv4Octets[0] << 8) | ipv4Octets[1]).toString(16)}:${((ipv4Octets[2] << 8) | ipv4Octets[3]).toString(16)}`;
  }

  const pieces = normalized.split("::");
  if (pieces.length > 2) {
    return null;
  }

  const head = pieces[0] ? pieces[0].split(":") : [];
  const tail = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
  if (pieces.length === 1 && head.length !== 8) {
    return null;
  }

  const missingSegmentCount = 8 - head.length - tail.length;
  if (missingSegmentCount < 0) {
    return null;
  }

  const rawSegments =
    pieces.length === 2
      ? [...head, ...Array.from({ length: missingSegmentCount }, () => "0"), ...tail]
      : head;
  if (rawSegments.length !== 8) {
    return null;
  }

  const segments: number[] = [];
  for (const segment of rawSegments) {
    if (!/^[0-9a-f]{1,4}$/i.test(segment)) {
      return null;
    }
    segments.push(Number.parseInt(segment, 16));
  }

  return segments;
}

function ipv4FromMappedIpv6Segments(segments: number[]): string | null {
  if (
    segments.length !== 8 ||
    !segments.slice(0, 5).every((segment) => segment === 0) ||
    segments[5] !== 0xffff
  ) {
    return null;
  }

  return [segments[6] >> 8, segments[6] & 0xff, segments[7] >> 8, segments[7] & 0xff].join(".");
}

function isBlockedIpv4Address(address: string): boolean {
  const octets = parseIpv4Octets(address);
  if (!octets) {
    return false;
  }

  const [first, second] = octets;
  if (first === 0 || first === 10 || first === 127) {
    return true;
  }
  if (first === 100 && second >= 64 && second <= 127) {
    return true;
  }
  if (first === 169 && second === 254) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  if (first === 192 && second === 168) {
    return true;
  }
  if (first === 198 && (second === 18 || second === 19)) {
    return true;
  }
  if (first >= 224) {
    return true;
  }

  return false;
}

function isBlockedIpv6Address(address: string): boolean {
  const segments = parseIpv6Segments(address);
  if (!segments) {
    return false;
  }

  const mappedIpv4 = ipv4FromMappedIpv6Segments(segments);
  if (mappedIpv4) {
    return isBlockedIpAddress(mappedIpv4);
  }

  if (segments.every((segment) => segment === 0)) {
    return true;
  }
  if (segments.slice(0, 7).every((segment) => segment === 0) && segments[7] === 1) {
    return true;
  }

  const firstSegment = segments[0];
  if ((firstSegment & 0xfe00) === 0xfc00) {
    return true;
  }
  if ((firstSegment & 0xffc0) === 0xfe80) {
    return true;
  }
  if ((firstSegment & 0xffc0) === 0xfec0) {
    return true;
  }
  if ((firstSegment & 0xff00) === 0xff00) {
    return true;
  }

  return false;
}

function isBlockedIpAddress(address: string): boolean {
  return isBlockedIpv4Address(address) || isBlockedIpv6Address(address);
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    return true;
  }

  return (
    WEB_FETCH_BLOCKED_HOSTNAMES.has(normalized) ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  );
}

function assertSupportedWebFetchProtocol(url: URL): void {
  if (!WEB_FETCH_ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new WebFetchValidationError(
      "Blocked URL: web_fetch only supports http:// and https:// destinations"
    );
  }
}

function buildResolveHostnameCommand(hostname: string): string {
  const resolverScript = [
    "import json",
    "import socket",
    "import sys",
    "addresses = []",
    "seen = set()",
    "for entry in socket.getaddrinfo(sys.argv[1], None, proto=socket.IPPROTO_TCP):",
    "    address = entry[4][0]",
    "    if address not in seen:",
    "        seen.add(address)",
    "        addresses.append(address)",
    "print(json.dumps(addresses))",
  ].join("\n");
  const runResolver = (pythonExecutable: string) =>
    `${pythonExecutable} -c ${shellQuote(resolverScript)} ${shellQuote(hostname)}`;

  return [
    "if command -v python3 >/dev/null 2>&1; then",
    `  ${runResolver("python3")}`,
    "elif command -v python >/dev/null 2>&1; then",
    `  ${runResolver("python")}`,
    "else",
    "  exit 1",
    "fi",
  ].join("\n");
}

function parseResolvedAddresses(output: string): string[] {
  const trimmedOutput = output.trim();
  if (!trimmedOutput) {
    throw new WebFetchValidationError(WEB_FETCH_RESOLVE_ERROR);
  }

  let parsedOutput: unknown;
  try {
    parsedOutput = JSON.parse(trimmedOutput);
  } catch {
    throw new WebFetchValidationError(WEB_FETCH_RESOLVE_ERROR);
  }

  if (!Array.isArray(parsedOutput) || parsedOutput.length === 0) {
    throw new WebFetchValidationError(WEB_FETCH_RESOLVE_ERROR);
  }

  const resolvedAddresses = parsedOutput.map((value) => {
    if (typeof value !== "string") {
      throw new WebFetchValidationError(WEB_FETCH_RESOLVE_ERROR);
    }

    const normalizedAddress = normalizeHostname(value);
    if (net.isIP(normalizedAddress) === 0) {
      throw new WebFetchValidationError(WEB_FETCH_RESOLVE_ERROR);
    }

    return normalizedAddress;
  });

  return [...new Set(resolvedAddresses)];
}

async function resolveHostnameInRuntime(
  config: ToolConfiguration,
  hostname: string,
  abortSignal?: AbortSignal
): Promise<string[]> {
  // Resolve hostnames inside the target runtime so DNS checks match the curl path,
  // including redirected hosts that may resolve differently from local Mux.
  const result = await runtimeHelpers.execBuffered(
    config.runtime,
    buildResolveHostnameCommand(hostname),
    {
      cwd: config.cwd,
      abortSignal,
      timeout: WEB_FETCH_RESOLVE_TIMEOUT_SECS,
    }
  );

  if (result.exitCode !== 0) {
    throw new WebFetchValidationError(WEB_FETCH_RESOLVE_ERROR);
  }

  return parseResolvedAddresses(result.stdout);
}

async function assertWebFetchTargetAllowed(
  config: ToolConfiguration,
  rawUrl: string,
  abortSignal?: AbortSignal
): Promise<URL> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new WebFetchValidationError("Invalid URL");
  }

  assertSupportedWebFetchProtocol(parsedUrl);

  const hostname = normalizeHostname(parsedUrl.hostname);
  if (isBlockedHostname(hostname)) {
    throw new WebFetchValidationError(WEB_FETCH_BLOCKED_TARGET_ERROR);
  }

  if (net.isIP(hostname) !== 0) {
    if (isBlockedIpAddress(hostname)) {
      throw new WebFetchValidationError(WEB_FETCH_BLOCKED_TARGET_ERROR);
    }
    return parsedUrl;
  }

  const resolvedAddresses = await resolveHostnameInRuntime(config, hostname, abortSignal);
  for (const resolvedAddress of resolvedAddresses) {
    if (isBlockedIpAddress(resolvedAddress)) {
      throw new WebFetchValidationError(WEB_FETCH_BLOCKED_TARGET_ERROR);
    }
  }

  return parsedUrl;
}

/** Parse curl -i output into headers and body */
function parseResponse(output: string): {
  headers: string;
  lowercaseHeaders: string;
  body: string;
  statusCode: string;
} {
  // HTTP headers are always at the start of curl -i output, well within the
  // first 64 KB even after a long redirect chain. Restrict the header search
  // to a small prefix so that regex/indexOf never scan through megabytes of
  // minified CSS/JS body (which caused a CPU-pinning hang on ConsString ropes).
  const HEADER_SEARCH_LIMIT = 65_536;

  // Headers end with \r\n\r\n (or \n\n for some servers).
  // Search only the prefix to avoid scanning the entire body.
  const prefix =
    output.length > HEADER_SEARCH_LIMIT ? output.slice(0, HEADER_SEARCH_LIMIT) : output;
  const headerEndIndex = prefix.indexOf("\r\n\r\n");
  const altHeaderEndIndex = prefix.indexOf("\n\n");
  const splitIndex =
    headerEndIndex !== -1
      ? headerEndIndex + 4
      : altHeaderEndIndex !== -1
        ? altHeaderEndIndex + 2
        : 0;

  // Find the last HTTP status line within the header region.
  const headerRegion = splitIndex > 0 ? output.slice(0, splitIndex) : prefix;
  const httpMatches = [...headerRegion.matchAll(/HTTP\/[\d.]+ (\d{3})[^\r\n]*/g)];
  const lastStatusMatch = httpMatches.length > 0 ? httpMatches[httpMatches.length - 1] : null;
  const statusCode = lastStatusMatch ? lastStatusMatch[1] : "";

  const headers = splitIndex > 0 ? output.slice(0, splitIndex) : "";
  const body = splitIndex > 0 ? output.slice(splitIndex) : output;

  return { headers, lowercaseHeaders: headers.toLowerCase(), body, statusCode };
}

function parseRedirectLocation(headers: string): string | null {
  const locationMatch = /^location:\s*([^\r\n]+)/im.exec(headers);
  return locationMatch ? locationMatch[1].trim() : null;
}

function isRedirectStatusCode(statusCode: number): boolean {
  return (
    statusCode === 301 ||
    statusCode === 302 ||
    statusCode === 303 ||
    statusCode === 307 ||
    statusCode === 308
  );
}

function buildCurlCommand(url: string): string {
  return [
    "curl",
    "-sS", // Silent but show errors
    "-i", // Include headers in output
    "--fail-with-body", // Return exit code 22 for HTTP 4xx/5xx but still output body
    "--proto",
    shellQuote("=http,https"),
    "--proto-redir",
    shellQuote("=http,https"),
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
}

async function executeWebFetchRequest(
  config: ToolConfiguration,
  rawUrl: string,
  abortSignal?: AbortSignal
): Promise<{ result: runtimeHelpers.ExecResult; finalUrl: string }> {
  let currentUrl = await assertWebFetchTargetAllowed(config, rawUrl, abortSignal);

  for (let redirectCount = 0; redirectCount <= WEB_FETCH_MAX_REDIRECTS; redirectCount++) {
    const result = await runtimeHelpers.execBuffered(
      config.runtime,
      buildCurlCommand(currentUrl.toString()),
      {
        cwd: config.cwd,
        abortSignal,
        timeout: WEB_FETCH_TIMEOUT_SECS + 5, // Slightly longer than curl's timeout (seconds)
      }
    );

    if (result.exitCode !== 0) {
      return { result, finalUrl: currentUrl.toString() };
    }

    const response = parseResponse(result.stdout);
    const statusCode = Number.parseInt(response.statusCode, 10);
    if (!isRedirectStatusCode(statusCode)) {
      return { result, finalUrl: currentUrl.toString() };
    }

    const redirectLocation = parseRedirectLocation(response.headers);
    if (!redirectLocation) {
      return { result, finalUrl: currentUrl.toString() };
    }

    if (redirectCount === WEB_FETCH_MAX_REDIRECTS) {
      throw new WebFetchValidationError("Failed to fetch URL: Too many redirects");
    }

    currentUrl = await assertWebFetchTargetAllowed(
      config,
      new URL(redirectLocation, currentUrl).toString(),
      abortSignal
    );
  }

  throw new WebFetchValidationError("Failed to fetch URL: Too many redirects");
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
    const dom = new JSDOM(stripHeavyTags(body), { url });
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

        const { result, finalUrl } = await executeWebFetchRequest(config, url, abortSignal);

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
            const { lowercaseHeaders, body, statusCode } = parseResponse(result.stdout);
            const statusText = statusCode ? `HTTP ${statusCode}` : "HTTP error";

            // Detect Cloudflare challenge pages
            if (isCloudflareChallenge(lowercaseHeaders, body)) {
              return {
                success: false,
                error: `${statusText}: Cloudflare security challenge (page requires JavaScript)`,
              };
            }

            // Try to extract readable content from error page
            const extracted = tryExtractContent(body, finalUrl, WEB_FETCH_MAX_OUTPUT_BYTES);
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
        const { lowercaseHeaders, body } = parseResponse(result.stdout);

        if (!body || body.trim().length === 0) {
          return {
            success: false,
            error: "Empty response from URL",
          };
        }

        // Check content-type to determine processing strategy
        const contentTypeMatch = /content-type:\s*([^\r\n;]+)/.exec(lowercaseHeaders);
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

        // Parse HTML with JSDOM (runs locally in Mux, not over SSH).
        // Strip <style>/<script> first — JSDOM's CSS parser chokes on MB of
        // minified CSS and Readability doesn't need either for extraction.
        const dom = new JSDOM(stripHeavyTags(body), { url: finalUrl });

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
        if (error instanceof WebFetchValidationError) {
          return {
            success: false,
            error: error.message,
          };
        }

        const message = getErrorMessage(error);
        return {
          success: false,
          error: `web_fetch error: ${message}`,
        };
      }
    },
  });
};
