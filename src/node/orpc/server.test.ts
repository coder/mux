import { describe, expect, test } from "bun:test";
import { createOrpcServer } from "./server";
import type { ORPCContext } from "./context";

function getErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  if (!("code" in error)) {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

describe("createOrpcServer", () => {
  test("brackets IPv6 hosts in returned URLs", async () => {
    // Minimal context stub - router won't be exercised by this test.
    const stubContext: Partial<ORPCContext> = {};

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "::1",
        port: 0,
        context: stubContext as ORPCContext,
        authToken: "test-token",
      });
    } catch (error) {
      const code = getErrorCode(error);

      // Some CI environments may not have IPv6 enabled.
      if (code === "EAFNOSUPPORT" || code === "EADDRNOTAVAIL") {
        return;
      }

      throw error;
    }

    try {
      expect(server.baseUrl).toMatch(/^http:\/\/\[::1\]:\d+$/);
      expect(server.wsUrl).toMatch(/^ws:\/\/\[::1\]:\d+\/orpc\/ws$/);
      expect(server.specUrl).toMatch(/^http:\/\/\[::1\]:\d+\/api\/spec\.json$/);
      expect(server.docsUrl).toMatch(/^http:\/\/\[::1\]:\d+\/api\/docs$/);
    } finally {
      await server.close();
    }
  });
});
