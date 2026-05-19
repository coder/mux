import { describe, expect, test } from "bun:test";
import {
  normalizeGlobalExtensionState,
  GLOBAL_EXTENSION_STATE_SCHEMA_VERSION,
} from "./globalExtensionState";

const NOW = 1_700_000_000_000;

describe("normalizeGlobalExtensionState", () => {
  test("missing/undefined block normalizes to empty state with no diagnostics", () => {
    const { state, diagnostics } = normalizeGlobalExtensionState(undefined, { now: NOW });
    expect(state).toEqual({
      schemaVersion: GLOBAL_EXTENSION_STATE_SCHEMA_VERSION,
      extensions: {},
    });
    expect(diagnostics).toEqual([]);
  });

  test("malformed (non-object) block normalizes to empty state with info diagnostic", () => {
    const { state, diagnostics, schemaVersionMismatch } = normalizeGlobalExtensionState(42, {
      now: NOW,
    });
    expect(state).toEqual({
      schemaVersion: GLOBAL_EXTENSION_STATE_SCHEMA_VERSION,
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

  test("valid schemaVersion=1 block round-trips approval records unchanged", () => {
    const raw = {
      schemaVersion: 1,
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
    const { state, diagnostics, schemaVersionMismatch } = normalizeGlobalExtensionState(raw, {
      now: NOW,
    });
    expect(diagnostics).toEqual([]);
    expect(schemaVersionMismatch).toBe(false);
    expect(state).toEqual({
      schemaVersion: 1,
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

  test("legacy grant records normalize to approval records without source identity", () => {
    const raw = {
      schemaVersion: 1,
      extensions: {
        "publisher.beta": {
          grant: {
            grantedPermissions: ["skill.register"],
            approvedDistributionIdentity: { name: "@pub/beta", version: "1.2.3" },
            requestedPermissionsHash: "abc123",
          },
        },
      },
    };

    const { state, diagnostics } = normalizeGlobalExtensionState(raw, { now: NOW });

    expect(diagnostics).toEqual([]);
    expect(state.extensions["publisher.beta"]).toEqual({
      approval: {
        grantedPermissions: ["skill.register"],
        requestedPermissionsHash: "abc123",
      },
    });
  });

  test("unknown future schemaVersion → empty runtime state with info diagnostic and mismatch flag", () => {
    const raw = {
      schemaVersion: 99,
      extensions: { "publisher.alpha": { enabled: true } },
    };
    const { state, diagnostics, schemaVersionMismatch } = normalizeGlobalExtensionState(raw, {
      now: NOW,
    });
    expect(state).toEqual({
      schemaVersion: GLOBAL_EXTENSION_STATE_SCHEMA_VERSION,
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
      extensions: {
        "publisher.good": { enabled: true },
        "publisher.bad": { enabled: "yes" }, // invalid: enabled must be boolean
        "Bad..ID": { enabled: true }, // invalid identity
      },
    };
    const { state, diagnostics } = normalizeGlobalExtensionState(raw, { now: NOW });
    expect(state.extensions).toEqual({ "publisher.good": { enabled: true } });
    expect(diagnostics).toHaveLength(2);
    for (const d of diagnostics) {
      expect(d.code).toBe("extension.state.record.invalid");
      expect(d.severity).toBe("info");
      expect(d.occurredAt).toBe(NOW);
    }
  });
});
