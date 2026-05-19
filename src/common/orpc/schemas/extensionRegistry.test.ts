import { describe, expect, test } from "bun:test";

import {
  DiscoveredExtensionSchema,
  UnavailableReasonSchema,
  extensions,
} from "./extensionRegistry";

describe("DiscoveredExtensionSchema", () => {
  test("uses Extension Module path fields instead of package source identity fields", () => {
    const parsed = DiscoveredExtensionSchema.parse({
      extensionId: "acme-review",
      rootId: "user-global",
      rootKind: "user-global",
      isCore: false,
      modulePath: "/tmp/acme-review",
      manifest: {
        manifestVersion: 1,
        id: "acme-review",
        requestedPermissions: [],
        contributions: [],
      },
      contributions: [],
      diagnostics: [],
      enabled: true,
      granted: true,
      activated: true,
    });

    expect(parsed.modulePath).toBe("/tmp/acme-review");
    expect("packagePath" in parsed).toBe(false);
    expect("packageName" in parsed).toBe(false);
    expect("packageVersion" in parsed).toBe(false);
  });
});

describe("UnavailableReasonSchema", () => {
  test("uses approval terminology for capability drift", () => {
    expect(UnavailableReasonSchema.safeParse("pending-reapproval").success).toBe(true);
    expect(UnavailableReasonSchema.safeParse("pending-regrant").success).toBe(false);
  });
});

describe("extensions approval routes", () => {
  test("uses approve/revokeApproval route names instead of grant/revoke", () => {
    const routeNames = Object.keys(extensions);

    expect(routeNames).toContain("approve");
    expect(routeNames).toContain("revokeApproval");
    expect(routeNames).not.toContain("grant");
    expect(routeNames).not.toContain("revoke");
  });
});
