import { describe, expect, test } from "bun:test";
import { SHUX_PRODUCT_NAME, SHUX_PRODUCT_SLUG } from "@/common/constants/product";
import { getElectronAppIdentity } from "./electronAppIdentity";

describe("getElectronAppIdentity", () => {
  test("keeps Linux desktop identity on the lowercase slug", () => {
    const identity = getElectronAppIdentity("linux");

    expect(identity.appName).toBe(SHUX_PRODUCT_SLUG);
    expect(identity.appName).toBe(identity.userDataDirName);
    expect(identity.chromeDesktop).toBe(`${identity.appName}.desktop`);
  });

  test("keeps macOS and Windows app.getName() display-cased", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const identity = getElectronAppIdentity(platform);

      expect(identity.appName).toBe(SHUX_PRODUCT_NAME);
      expect(identity.appName).not.toBe(identity.userDataDirName);
      expect(identity.chromeDesktop).toBeUndefined();
    }
  });

  test("does not let display-cased app names fork the userData directory", () => {
    const platforms: NodeJS.Platform[] = ["linux", "darwin", "win32"];
    const userDataDirNames = platforms.map(
      (platform) => getElectronAppIdentity(platform).userDataDirName
    );

    expect(new Set(userDataDirNames)).toEqual(new Set([SHUX_PRODUCT_SLUG]));
    expect(getElectronAppIdentity("darwin").userDataDirName).not.toBe(
      getElectronAppIdentity("darwin").appName
    );
  });
});
