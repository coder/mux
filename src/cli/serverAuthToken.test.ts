import { describe, expect, test } from "bun:test";
import { resolveServerAuthToken } from "./serverAuthToken";

describe("resolveServerAuthToken", () => {
  test("returns disabled mode when noAuth is true regardless of other values", () => {
    expect(
      resolveServerAuthToken({
        noAuth: true,
        cliToken: "abc",
        envToken: "env-token",
      })
    ).toEqual({ mode: "disabled", token: "" });
  });

  test("uses cliToken when provided", () => {
    expect(
      resolveServerAuthToken({
        noAuth: false,
        cliToken: "abc",
        envToken: "env-token",
      })
    ).toEqual({ mode: "enabled", token: "abc", source: "cli" });
  });

  test("trims cliToken", () => {
    expect(
      resolveServerAuthToken({
        noAuth: false,
        cliToken: "  abc  ",
        envToken: "env-token",
      })
    ).toEqual({ mode: "enabled", token: "abc", source: "cli" });
  });

  test("falls through to envToken when cliToken is empty", () => {
    expect(
      resolveServerAuthToken({
        noAuth: false,
        cliToken: "",
        envToken: "env-token",
      })
    ).toEqual({ mode: "enabled", token: "env-token", source: "env" });
  });

  test("falls through to envToken when cliToken is whitespace only", () => {
    expect(
      resolveServerAuthToken({
        noAuth: false,
        cliToken: "   ",
        envToken: "env-token",
      })
    ).toEqual({ mode: "enabled", token: "env-token", source: "env" });
  });

  test("uses envToken when cliToken is not provided", () => {
    expect(
      resolveServerAuthToken({
        noAuth: false,
        cliToken: undefined,
        envToken: "env-token",
      })
    ).toEqual({ mode: "enabled", token: "env-token", source: "env" });
  });

  test("trims envToken", () => {
    expect(
      resolveServerAuthToken({
        noAuth: false,
        cliToken: undefined,
        envToken: "  env-token  ",
      })
    ).toEqual({ mode: "enabled", token: "env-token", source: "env" });
  });

  test("uses generated token when neither cliToken nor envToken is provided", () => {
    const generated = resolveServerAuthToken({
      noAuth: false,
      cliToken: undefined,
      envToken: undefined,
      randomBytesFn: () => Buffer.from("a".repeat(32)),
    });

    expect(generated).toEqual({
      mode: "enabled",
      token: Buffer.from("a".repeat(32)).toString("hex"),
      source: "generated",
    });
  });

  test("noAuth still wins when cliToken is set", () => {
    expect(
      resolveServerAuthToken({
        noAuth: true,
        cliToken: "abc",
        envToken: undefined,
      })
    ).toEqual({ mode: "disabled", token: "" });
  });
});
