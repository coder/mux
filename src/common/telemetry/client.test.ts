// Mock posthog-js to avoid import issues in test environment
jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    init: jest.fn(),
    capture: jest.fn(),
    reset: jest.fn(),
  },
}));

// Ensure NODE_ENV is set to test for telemetry detection
// Must be set before importing the client module
process.env.NODE_ENV = "test";

import { initTelemetry, trackEvent, isTelemetryInitialized } from "./client";

describe("Telemetry", () => {
  describe("in test environment", () => {
    beforeAll(() => {
      process.env.NODE_ENV = "test";
    });

    it("should not initialize PostHog", () => {
      initTelemetry();
      expect(isTelemetryInitialized()).toBe(false);
    });

    it("should silently ignore track events", () => {
      // Should not throw even though not initialized
      expect(() => {
        trackEvent({
          event: "workspace_switched",
          properties: {
            version: "1.0.0",
            platform: "darwin",
            electronVersion: "28.0.0",
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
