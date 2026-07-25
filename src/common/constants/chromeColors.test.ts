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

  // The static meta value is what a cold load shows before the boot script runs, and what
  // survives when the script's catch path fires (blocked storage), where it falls back to dark.
  it("starts from the dark chrome color before any script runs", () => {
    const html = readFileSync(path.join(process.cwd(), "index.html"), "utf8");

    const meta = /<meta name="theme-color" content="(#[0-9a-fA-F]{3,8})"/.exec(html);
    if (!meta) {
      throw new Error("Could not find the theme-color meta tag in index.html");
    }

    expect(meta[1]).toBe(CHROME_COLORS.dark);
  });
});
