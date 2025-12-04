import { initTelemetry, trackEvent, shutdownTelemetry } from "./client";

describe("Telemetry client", () => {
  it("initTelemetry and shutdownTelemetry are no-ops", () => {
    // These are kept for API compatibility but do nothing
    expect(() => initTelemetry()).not.toThrow();
    expect(() => shutdownTelemetry()).not.toThrow();
  });

  it("trackEvent silently forwards to backend without throwing", () => {
    // In test environment, ORPC is not available, but trackEvent should not throw
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
});
