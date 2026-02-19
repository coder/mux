/**
 * Canonical SSH endpoint identity for dedupe purposes.
 * IPv6-safe: wraps bare IPv6 addresses in brackets.
 */
export function formatSshEndpoint(host: string, port: number): string {
  const needsBrackets = host.includes(":") && !host.startsWith("[") && !host.endsWith("]");
  const normalizedHost = needsBrackets ? `[${host}]` : host;
  return `${normalizedHost}:${port}`;
}
