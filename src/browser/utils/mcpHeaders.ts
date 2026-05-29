import assert from "@/common/utils/assert";
import type { MCPHeaderValue } from "@/common/types/mcp";

export type MCPHeaderRowKind = "text" | "secret";

export interface MCPHeaderRow {
  id: string;
  name: string;
  kind: MCPHeaderRowKind;
  /** For kind=text, the literal header value. For kind=secret, the secret key name. */
  value: string;
}

export interface MCPHeadersValidation {
  errors: string[];
  warnings: string[];
}

function createHeaderRowId(): string {
  const maybeCrypto = globalThis.crypto;
  if (maybeCrypto && typeof maybeCrypto.randomUUID === "function") {
    const id = maybeCrypto.randomUUID();
    assert(typeof id === "string" && id.length > 0, "randomUUID() must return a non-empty string");
    return id;
  }

  const id = `mcp_header_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  assert(id.length > 0, "generated id must be non-empty");
  return id;
}

export function createMCPHeaderRow(
  initial?: Partial<Omit<MCPHeaderRow, "id">> & { id?: string }
): MCPHeaderRow {
  const row: MCPHeaderRow = {
    id: initial?.id ?? createHeaderRowId(),
    name: initial?.name ?? "",
    kind: initial?.kind ?? "text",
    value: initial?.value ?? "",
  };

  assert(row.kind === "text" || row.kind === "secret", "row.kind must be text or secret");
  return row;
}

export function mcpHeadersRecordToRows(
  headers: Record<string, MCPHeaderValue> | undefined
): MCPHeaderRow[] {
  if (!headers) {
    return [];
  }

  return Object.entries(headers).map(([name, value]) => {
    if (typeof value === "string") {
      return createMCPHeaderRow({ name, kind: "text", value });
    }

    return createMCPHeaderRow({ name, kind: "secret", value: value.secret });
  });
}

function containsNewlines(value: string): boolean {
  return /[\r\n]/.test(value);
}

export function mcpHeaderRowsToRecord(
  rows: MCPHeaderRow[],
  options?: { knownSecretKeys?: ReadonlySet<string> }
): { headers: Record<string, MCPHeaderValue> | undefined; validation: MCPHeadersValidation } {
  assert(Array.isArray(rows), "rows must be an array");

  const errors: string[] = [];
  const warnings: string[] = [];

  const out: Record<string, MCPHeaderValue> = {};
  const seenLowerNames = new Map<string, string>();

  for (const row of rows) {
    assert(row && typeof row === "object", "row must be an object");
    assert(typeof row.name === "string", "row.name must be a string");
    assert(typeof row.value === "string", "row.value must be a string");
    assert(row.kind === "text" || row.kind === "secret", "row.kind must be text or secret");

    const nameTrimmed = row.name.trim();

    // Treat fully-empty rows as non-existent.
    const isEmptyRow = nameTrimmed === "" && row.value.trim() === "";
    if (isEmptyRow) {
      continue;
    }

    if (nameTrimmed === "") {
      errors.push("Header name is required");
      continue;
    }

    if (containsNewlines(nameTrimmed)) {
      errors.push(`Header name '${nameTrimmed}' must not contain newlines`);
      continue;
    }

    // People often paste header names with a trailing ':' (e.g. 'Authorization:').
    if (nameTrimmed.includes(":")) {
      errors.push(`Header name '${nameTrimmed}' must not include ':'`);
      continue;
    }

    const lower = nameTrimmed.toLowerCase();
    const prior = seenLowerNames.get(lower);
    if (prior) {
      errors.push(`Duplicate header '${nameTrimmed}' (conflicts with '${prior}')`);
      continue;
    }
    seenLowerNames.set(lower, nameTrimmed);

    if (row.kind === "text") {
      if (containsNewlines(row.value)) {
        errors.push(`Header '${nameTrimmed}' value must not contain newlines`);
        continue;
      }

      out[nameTrimmed] = row.value;
      continue;
    }

    // secret
    const secretName = row.value.trim();
    if (secretName === "") {
      errors.push(`Secret name is required for header '${nameTrimmed}'`);
      continue;
    }

    if (containsNewlines(secretName)) {
      errors.push(`Secret name '${secretName}' must not contain newlines`);
      continue;
    }

    out[nameTrimmed] = { secret: secretName };

    if (options?.knownSecretKeys && !options.knownSecretKeys.has(secretName)) {
      warnings.push(`Secret '${secretName}' is not defined in this project`);
    }
  }

  const headers = Object.keys(out).length === 0 ? undefined : out;
  return { headers, validation: { errors, warnings } };
}
