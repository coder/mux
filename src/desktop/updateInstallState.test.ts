import { describe, it, expect, beforeEach } from "bun:test";
import {
  clearUpdateInstallInProgress,
  isUpdateInstallInProgress,
  markUpdateInstallInProgress,
} from "./updateInstallState";

describe("updateInstallState", () => {
  beforeEach(() => {
    clearUpdateInstallInProgress();
  });

  it("should start with install flag unset", () => {
    expect(isUpdateInstallInProgress()).toBe(false);
  });

  it("should mark and clear update install progress", () => {
    markUpdateInstallInProgress();
    expect(isUpdateInstallInProgress()).toBe(true);

    clearUpdateInstallInProgress();
    expect(isUpdateInstallInProgress()).toBe(false);
  });
});
