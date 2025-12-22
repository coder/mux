import { describe, expect, test } from "bun:test";
import { mcpHeaderRowsToRecord, mcpHeadersRecordToRows, type MCPHeaderRow } from "./mcpHeaders";

describe("mcpHeaders", () => {
  test("round-trips record → rows → record", () => {
    const record = {
      Authorization: "Bearer abc",
      "X-Token": { secret: "MCP_TOKEN" },
    };

    const rows = mcpHeadersRecordToRows(record);
    const { headers, validation } = mcpHeaderRowsToRecord(rows, {
      knownSecretKeys: new Set(["MCP_TOKEN"]),
    });

    expect(validation.errors).toEqual([]);
    expect(headers).toEqual(record);
  });

  test("detects duplicate header names case-insensitively", () => {
    const rows: MCPHeaderRow[] = [
      { id: "1", name: "Authorization", kind: "text", value: "a" },
      { id: "2", name: "authorization", kind: "text", value: "b" },
    ];

    const { validation } = mcpHeaderRowsToRecord(rows);
    expect(validation.errors.length).toBe(1);
    expect(validation.errors[0]).toContain("Duplicate header");
  });

  test("rejects newline characters in header values", () => {
    const rows: MCPHeaderRow[] = [{ id: "1", name: "X-Test", kind: "text", value: "hello\nworld" }];

    const { validation } = mcpHeaderRowsToRecord(rows);
    expect(validation.errors).toEqual(["Header 'X-Test' value must not contain newlines"]);
  });

  test("ignores fully-empty rows but errors on value without name", () => {
    const emptyRow: MCPHeaderRow = { id: "1", name: "", kind: "text", value: "" };
    const { headers: emptyHeaders, validation: emptyValidation } = mcpHeaderRowsToRecord([
      emptyRow,
    ]);
    expect(emptyHeaders).toBeUndefined();
    expect(emptyValidation.errors).toEqual([]);

    const badRow: MCPHeaderRow = { id: "2", name: "", kind: "text", value: "x" };
    const { validation: badValidation } = mcpHeaderRowsToRecord([badRow]);
    expect(badValidation.errors).toEqual(["Header name is required"]);
  });

  test("secret rows are trimmed and warn when secret key is missing", () => {
    const rows: MCPHeaderRow[] = [
      { id: "1", name: "Authorization", kind: "secret", value: " MCP_TOKEN " },
    ];

    const { headers, validation } = mcpHeaderRowsToRecord(rows, {
      knownSecretKeys: new Set(["OTHER"]),
    });

    expect(validation.errors).toEqual([]);
    expect(validation.warnings).toEqual(["Secret 'MCP_TOKEN' is not defined in this project"]);
    expect(headers).toEqual({ Authorization: { secret: "MCP_TOKEN" } });
  });
});
