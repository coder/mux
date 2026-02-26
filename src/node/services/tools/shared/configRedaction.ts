import type { ConfigFileKey } from "@/common/config/schemaRegistry";
import { deepClone, isObjectRecord } from "@/node/services/tools/shared/configToolUtils";

// Config read tools can surface file contents to chat, so secret-like values must be
// scrubbed before responses are returned.
export const REDACTED_SECRET_VALUE = "[REDACTED]";

const PROVIDER_SECRET_KEYS = new Set([
  "apiKey",
  "bearerToken",
  "accessKeyId",
  "secretAccessKey",
  "couponCode",
  "voucher",
  "codexOauth",
]);

const APP_SECRET_KEYS = new Set(["muxGovernorToken"]);

const AUTH_HEADER_NAME_PATTERN = /(authorization|api[-_]?key|token|secret|password|cookie)/i;

export function redactConfigDocument(fileKey: ConfigFileKey, document: unknown): unknown {
  if (fileKey === "providers") {
    return redactProvidersConfig(document);
  }

  return redactAppConfig(document);
}

export function redactProvidersConfig(document: unknown): unknown {
  const cloned = deepClone(document);
  redactSecretsRecursively(cloned, PROVIDER_SECRET_KEYS);
  return cloned;
}

export function redactAppConfig(document: unknown): unknown {
  const cloned = deepClone(document);
  redactSecretsRecursively(cloned, APP_SECRET_KEYS);
  return cloned;
}

function redactSecretsRecursively(node: unknown, secretKeys: ReadonlySet<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      redactSecretsRecursively(item, secretKeys);
    }
    return;
  }

  if (!isObjectRecord(node)) {
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === "headers" && isObjectRecord(value)) {
      redactSensitiveHeaders(value);
      continue;
    }

    if (secretKeys.has(key) && shouldRedactValue(value)) {
      node[key] = REDACTED_SECRET_VALUE;
      continue;
    }

    redactSecretsRecursively(value, secretKeys);
  }
}

function redactSensitiveHeaders(headers: Record<string, unknown>): void {
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (AUTH_HEADER_NAME_PATTERN.test(headerName) && shouldRedactValue(headerValue)) {
      headers[headerName] = REDACTED_SECRET_VALUE;
    }
  }
}

function shouldRedactValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  return value !== null && value !== undefined;
}
