import { describe, expect, test } from "bun:test";
import {
  normalizeProjectExtensionState,
  PROJECT_EXTENSION_STATE_SCHEMA_VERSION,
} from "./projectExtensionState";

const NOW = 1_700_000_000_000;

describe("normalizeProjectExtensionState", () => {
  test("missing/undefined block normalizes to empty state with no diagnostics", () => {
    const { state, diagnostics, schemaVersionMismatch } = normalizeProjectExtensionState(
      undefined,
      { now: NOW }
    );
    expect(state).toEqual({
      schemaVersion: PROJECT_EXTENSION_STATE_SCHEMA_VERSION,
      rootTrusted: false,
      extensions: {},
    });
    expect(diagnostics).toEqual([]);
    expect(schemaVersionMismatch).toBe(false);
  });

  test("malformed (non-object) block normalizes to empty state with info diagnostic", () => {
    const { state, diagnostics, schemaVersionMismatch } = normalizeProjectExtensionState(42, {
      now: NOW,
    });
    expect(state).toEqual({
      schemaVersion: PROJECT_EXTENSION_STATE_SCHEMA_VERSION,
      rootTrusted: false,
      extensions: {},
    });
    expect(schemaVersionMismatch).toBe(false);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "extension.state.malformed",
      severity: "info",
      occurredAt: NOW,
    });
  });

  test("valid schemaVersion=1 block round-trips records and rootTrusted unchanged", () => {
    const raw = {
      schemaVersion: 1,
      rootTrusted: true,
      extensions: {
        "publisher.alpha": { enabled: true },
        "publisher.beta": {
          enabled: false,
          approval: {
            grantedPermissions: ["network", "skill.register"],
            requestedPermissionsHash: "abc123",
          },
        },
      },
    };
    const { state, diagnostics, schemaVersionMismatch } = normalizeProjectExtensionState(raw, {
      now: NOW,
    });
    expect(diagnostics).toEqual([]);
    expect(schemaVersionMismatch).toBe(false);
    expect(state).toEqual({
      schemaVersion: 1,
      rootTrusted: true,
      extensions: {
        "publisher.alpha": { enabled: true },
        "publisher.beta": {
          enabled: false,
          approval: {
            grantedPermissions: ["network", "skill.register"],
            requestedPermissionsHash: "abc123",
          },
        },
      },
    });
  });

  test("rootTrusted defaults to false when omitted; true survives round-trip", () => {
    const blockWithoutTrust = { schemaVersion: 1, extensions: {} };
    expect(normalizeProjectExtensionState(blockWithoutTrust, { now: NOW }).state.rootTrusted).toBe(
      false
    );

    const blockTrusted = { schemaVersion: 1, rootTrusted: true, extensions: {} };
    expect(normalizeProjectExtensionState(blockTrusted, { now: NOW }).state.rootTrusted).toBe(true);
  });

  test("unknown future schemaVersion → empty runtime state with info diagnostic and mismatch flag", () => {
    const raw = {
      schemaVersion: 99,
      rootTrusted: true,
      extensions: { "publisher.alpha": { enabled: true } },
    };
    const { state, diagnostics, schemaVersionMismatch } = normalizeProjectExtensionState(raw, {
      now: NOW,
    });
    expect(state).toEqual({
      schemaVersion: PROJECT_EXTENSION_STATE_SCHEMA_VERSION,
      rootTrusted: false,
      extensions: {},
    });
    expect(schemaVersionMismatch).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "extension.state.schema_version.unsupported",
      severity: "info",
      occurredAt: NOW,
    });
  });

  test("per-record validation failure drops only the bad record with info diagnostic", () => {
    const raw = {
      schemaVersion: 1,
      rootTrusted: true,
      extensions: {
        "publisher.good": { enabled: true },
        "publisher.bad": { enabled: "yes" }, // invalid: enabled must be boolean
        "Bad..ID": { enabled: true }, // invalid identity
      },
    };
    const { state, diagnostics } = normalizeProjectExtensionState(raw, { now: NOW });
    expect(state.rootTrusted).toBe(true);
    expect(state.extensions).toEqual({ "publisher.good": { enabled: true } });
    expect(diagnostics).toHaveLength(2);
    for (const d of diagnostics) {
      expect(d.code).toBe("extension.state.record.invalid");
      expect(d.severity).toBe("info");
      expect(d.occurredAt).toBe(NOW);
    }
  });

  test("non-boolean rootTrusted is rejected at the schema gate; falls back to false", () => {
    const raw = {
      schemaVersion: 1,
      rootTrusted: "yes",
      extensions: { "publisher.alpha": { enabled: true } },
    };
    const { state, diagnostics } = normalizeProjectExtensionState(raw, { now: NOW });
    expect(state.rootTrusted).toBe(false);
    // The whole block is treated as malformed (not just the rootTrusted field)
    // since the top-level schema is .strict() and rootTrusted is the gate.
    expect(diagnostics.some((d) => d.code === "extension.state.malformed")).toBe(true);
  });
});
