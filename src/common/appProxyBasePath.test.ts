import { describe, expect, test } from "bun:test";

import { getAppProxyBasePathFromPathname, stripAppProxyBasePath } from "./appProxyBasePath";

describe("appProxyBasePath", () => {
  test("detects the app proxy base path", () => {
    expect(getAppProxyBasePathFromPathname("/@u/ws/apps/mux/")).toBe("/@u/ws/apps/mux");
    expect(getAppProxyBasePathFromPathname("/@u/ws/apps/mux/settings/general")).toBe(
      "/@u/ws/apps/mux"
    );
    expect(getAppProxyBasePathFromPathname("/@u/ws.agent/apps/mux/")).toBe("/@u/ws.agent/apps/mux");
    expect(getAppProxyBasePathFromPathname("/@u/ws/agent/apps/mux/foo")).toBe(
      "/@u/ws/agent/apps/mux"
    );
    expect(getAppProxyBasePathFromPathname("/@u/ws/apps/mux")).toBe("/@u/ws/apps/mux");
  });

  test("rejects root routes and unanchored app segments", () => {
    expect(getAppProxyBasePathFromPathname("/projects/apps/other")).toBeNull();
    expect(getAppProxyBasePathFromPathname("/")).toBeNull();
    expect(getAppProxyBasePathFromPathname("/settings")).toBeNull();
    expect(getAppProxyBasePathFromPathname("//bad.example/@u/ws/apps/mux")).toBeNull();
  });

  test("strips the app proxy base path from prefix-only requests", () => {
    expect(stripAppProxyBasePath("/@u/ws/apps/mux/")).toEqual({
      basePath: "/@u/ws/apps/mux",
      routePathname: "/",
    });
    expect(stripAppProxyBasePath("/@u/ws/apps/mux")).toEqual({
      basePath: "/@u/ws/apps/mux",
      routePathname: "/",
    });
  });

  test("strips the app proxy base path and preserves the route suffix", () => {
    expect(stripAppProxyBasePath("/@u/ws/apps/mux/settings/general")).toEqual({
      basePath: "/@u/ws/apps/mux",
      routePathname: "/settings/general",
    });
    expect(stripAppProxyBasePath("/@u/ws.agent/apps/mux/")).toEqual({
      basePath: "/@u/ws.agent/apps/mux",
      routePathname: "/",
    });
    expect(stripAppProxyBasePath("/@u/ws/agent/apps/mux/foo")).toEqual({
      basePath: "/@u/ws/agent/apps/mux",
      routePathname: "/foo",
    });
  });

  test("returns the original pathname when no app proxy base path is present", () => {
    expect(stripAppProxyBasePath("/projects/apps/other")).toEqual({
      basePath: null,
      routePathname: "/projects/apps/other",
    });
    expect(stripAppProxyBasePath("/")).toEqual({ basePath: null, routePathname: "/" });
    expect(stripAppProxyBasePath("/settings")).toEqual({
      basePath: null,
      routePathname: "/settings",
    });
    expect(stripAppProxyBasePath("//bad.example/@u/ws/apps/mux")).toEqual({
      basePath: null,
      routePathname: "//bad.example/@u/ws/apps/mux",
    });
  });
});
