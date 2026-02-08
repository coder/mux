/**
 * URL security utilities for hardening OAuth flows against
 * URL confusion attacks, SSRF, and redirect_uri injection.
 */

/**
 * Check if a socket remote address is a known loopback address.
 * Moved from codexOauthService.ts for reuse across desktop OAuth flows.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  // Node may normalize IPv4 loopback to an IPv6-mapped address.
  if (address === "::ffff:127.0.0.1") return true;
  return address === "127.0.0.1" || address === "::1";
}

/**
 * Throw if URL contains userinfo (username/password).
 * Prevents @-based URL confusion attacks like:
 * http://[0:0:0:0:0:ffff:128.168.1.0]@[0:0:0:0:0:ffff:127.168.1.0]@attacker.com/
 */
export function rejectUserinfo(url: URL): void {
  if (url.username || url.password) {
    throw new Error("URL must not contain userinfo (@-credentials)");
  }
}

/**
 * Validate and parse a redirect URI. Rejects userinfo, non-http(s) schemes.
 * Optionally checks hostname against an allowlist.
 */
export function validateRedirectUri(uri: string, opts?: { allowedHosts?: string[] }): URL {
  const url = new URL(uri);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }
  rejectUserinfo(url);
  if (opts?.allowedHosts?.length) {
    if (!opts.allowedHosts.includes(url.hostname)) {
      throw new Error(`Host not in allowlist: ${url.hostname}`);
    }
  }
  return url;
}

/**
 * Check whether a hostname is a private/internal address.
 * For SSRF protection before outbound fetches.
 *
 * Covers IPv4 private ranges, IPv6 loopback/link-local/ULA,
 * and IPv6-mapped IPv4 addresses (e.g. ::ffff:127.0.0.1).
 */
export function isPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  // Strip IPv6 brackets if present
  const bare = lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;

  // localhost
  if (bare === "localhost") return true;

  // IPv6-mapped IPv4 in dotted-decimal form (::ffff:x.x.x.x)
  const v4DottedMatch = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(bare);
  if (v4DottedMatch) {
    return isPrivateIPv4(v4DottedMatch[1]);
  }

  // IPv6-mapped IPv4 in hex form (::ffff:HHHH:HHHH) — Node's URL normalizes
  // dotted-decimal to this form (e.g. ::ffff:127.0.0.1 → ::ffff:7f00:1)
  const v4HexMatch = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (v4HexMatch) {
    const hi = parseInt(v4HexMatch[1], 16);
    const lo = parseInt(v4HexMatch[2], 16);
    const reconstructed = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateIPv4(reconstructed);
  }

  // Plain IPv4 private ranges
  if (isPrivateIPv4(bare)) return true;

  // IPv6 loopback
  if (bare === "::1") return true;
  // IPv6 link-local (fe80::/10 covers fe80:: through febf::)
  if (/^fe[89ab][0-9a-f]/.test(bare)) return true;
  // IPv6 Unique Local Address (fc00::/7 — covers fc00:: and fd00::)
  if (bare.startsWith("fc") || bare.startsWith("fd")) return true;

  return false;
}

/** Check an IPv4 address string against private/reserved ranges. */
function isPrivateIPv4(ip: string): boolean {
  const patterns = [
    /^127\./, // loopback
    /^10\./, // Class A private
    /^172\.(1[6-9]|2\d|3[01])\./, // Class B private
    /^192\.168\./, // Class C private
    /^169\.254\./, // link-local
    /^0\./, // "this" network
  ];
  return patterns.some((re) => re.test(ip));
}

/**
 * Validate a URL is safe for outbound server-side fetch (SSRF protection).
 * Rejects private IPs, non-http(s), and userinfo.
 */
export function validateOutboundUrl(urlStr: string): URL {
  const url = new URL(urlStr);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }
  rejectUserinfo(url);
  if (isPrivateHost(url.hostname)) {
    throw new Error(`Outbound requests to private addresses are not allowed: ${url.hostname}`);
  }
  return url;
}
