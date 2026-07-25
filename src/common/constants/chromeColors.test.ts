import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { CHROME_COLORS } from "./chromeColors";

// index.html sets theme-color synchronously, before any bundle loads, so it carries its own copy
// of this palette. If the two drift, cold loads paint the browser chrome one color and then flip.
describe("boot theme palette", () => {
  it("matches the shared chrome palette", () => {
    const html = readFileSync(path.join(process.cwd(), "index.html"), "utf8");

    const block = /const THEME_COLORS = \{([^}]*)\}/.exec(html);
    if (!block) {
      throw new Error("Could not find THEME_COLORS in index.html's boot script");
    }

    const bootColors = Object.fromEntries(
      [...block[1].matchAll(/"?([\w-]+)"?:\s*"(#[0-9a-fA-F]{3,8})"/g)].map((m) => [m[1], m[2]])
    );

    expect(bootColors).toEqual({ ...CHROME_COLORS });
  });
});
