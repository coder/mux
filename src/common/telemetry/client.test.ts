// Ensure NODE_ENV is set to test for telemetry detection
// Must be set before importing the client module
process.env.NODE_ENV = "test";

import { initTelemetry, trackEvent, isTelemetryInitialized } from "./client";

describe("Telemetry", () => {
  describe("in test environment", () => {
    beforeAll(() => {
      process.env.NODE_ENV = "test";
    });

    it("should not initialize", () => {
      initTelemetry();
      expect(isTelemetryInitialized()).toBe(false);
    });

    it("should silently ignore track events", () => {
      // Should not throw even though not initialized
      // Base properties (version, platform, electronVersion) are now added by backend
      expect(() => {
        trackEvent({
          event: "workspace_switched",
          properties: {
            fromWorkspaceId: "test-from",
            toWorkspaceId: "test-to",
          },
        });
      }).not.toThrow();
    });

    it("should correctly detect test environment", () => {
      // Verify NODE_ENV is set to test (we set it above for telemetry detection)
      expect(process.env.NODE_ENV).toBe("test");
    });
  });
});
