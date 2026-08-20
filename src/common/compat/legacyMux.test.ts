import { describe, expect, test } from "bun:test";
import { SHUX_HOME_DIR_NAME } from "@/common/constants/product";
import {
  getLocalProductHomeTildeSuffix,
  getShuxHomeLegacyFallbackMarkerPath,
  installLegacyMuxEnvironmentAliases,
  LEGACY_CMUX_HOME_DIR_NAME,
  LEGACY_MUX_HOME_DIR_NAME,
  parseShuxHomeLegacyFallbackDirName,
  resolveLegacyMuxBuiltInSkillName,
  resolveShuxEnvironmentValue,
  SUPPORTED_SHUX_PROTOCOL_SCHEMES,
  withLegacyMuxEnvironmentAliases,
} from "./legacyMux";

describe("legacy mux environment compatibility", () => {
  test("promotes legacy values to canonical SHUX names", () => {
    const env = withLegacyMuxEnvironmentAliases({ MUX_SERVER_URL: "http://legacy" });

    expect(env.SHUX_SERVER_URL).toBe("http://legacy");
    expect(env.MUX_SERVER_URL).toBe("http://legacy");
  });

  test("canonical values win when both names are provided", () => {
    const env = withLegacyMuxEnvironmentAliases({
      SHUX_ROOT: "/canonical",
      MUX_ROOT: "/legacy",
    });

    expect(env.SHUX_ROOT).toBe("/canonical");
    expect(env.MUX_ROOT).toBe("/canonical");
    expect(resolveShuxEnvironmentValue("ROOT", env)).toBe("/canonical");
  });

  test("keeps the pre-mux multiple-instance spelling synchronized", () => {
    const env: Record<string, string | undefined> = { CMUX_ALLOW_MULTIPLE_INSTANCES: "1" };

    installLegacyMuxEnvironmentAliases(env);

    expect(env.SHUX_ALLOW_MULTIPLE_INSTANCES).toBe("1");
    expect(env.MUX_ALLOW_MULTIPLE_INSTANCES).toBe("1");
  });
});

describe("built-in skill compatibility", () => {
  test("maps old mux skill names to their canonical shux definitions", () => {
    expect(resolveLegacyMuxBuiltInSkillName("mux-docs")).toBe("shux-docs");
    expect(resolveLegacyMuxBuiltInSkillName("mux-diagram")).toBe("shux-diagram");
    expect(resolveLegacyMuxBuiltInSkillName("loop")).toBe("loop");
  });
});

describe("default-home leftover fallback markers", () => {
  test("accepts only leftover names for the same production or dev suffix", () => {
    expect(parseShuxHomeLegacyFallbackDirName(".mux\n")).toBe(".mux");
    expect(parseShuxHomeLegacyFallbackDirName(" .cmux ")).toBe(".cmux");
    expect(parseShuxHomeLegacyFallbackDirName(".mux-dev", "-dev")).toBe(".mux-dev");
    expect(parseShuxHomeLegacyFallbackDirName(".mux", "-dev")).toBeUndefined();
    expect(parseShuxHomeLegacyFallbackDirName(".cmux", "-dev")).toBeUndefined();
    expect(parseShuxHomeLegacyFallbackDirName("../.mux")).toBeUndefined();
    expect(parseShuxHomeLegacyFallbackDirName("/tmp/evil")).toBeUndefined();
    expect(getShuxHomeLegacyFallbackMarkerPath("/home/user", "-dev")).toBe(
      "/home/user/.shux-dev.legacy-fallback"
    );
  });

  test("does not import Node builtins so the VS Code webview can bundle it", async () => {
    const source = await Bun.file(new URL("./legacyMux.ts", import.meta.url)).text();
    expect(source).not.toMatch(/from ["']node:/);
  });
});

describe("local product-home tilde prefixes", () => {
  test("treats canonical and legacy local homes as the same prefix family", () => {
    for (const dirName of [
      SHUX_HOME_DIR_NAME,
      LEGACY_MUX_HOME_DIR_NAME,
      LEGACY_CMUX_HOME_DIR_NAME,
    ]) {
      expect(getLocalProductHomeTildeSuffix(`~/${dirName}`)).toBe("");
      expect(getLocalProductHomeTildeSuffix(`~/${dirName}/src/project`)).toBe("src/project");
      expect(getLocalProductHomeTildeSuffix(`~\\${dirName}\\src\\project`)).toBe("src\\project");
    }
  });

  test("does not treat lookalike or unrelated tilde paths as the product home", () => {
    expect(getLocalProductHomeTildeSuffix(`~/${SHUX_HOME_DIR_NAME}-dev`)).toBeUndefined();
    expect(getLocalProductHomeTildeSuffix(`~/${LEGACY_MUX_HOME_DIR_NAME}rc`)).toBeUndefined();
    expect(getLocalProductHomeTildeSuffix("~/projects")).toBeUndefined();
  });
});

describe("deep-link protocol compatibility", () => {
  test("prefers shux while retaining mux as an accepted alias", () => {
    expect(SUPPORTED_SHUX_PROTOCOL_SCHEMES).toEqual(["shux", "mux"]);
  });
});
