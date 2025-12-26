// Dynamic Expo config.
//
// We intentionally keep iOS App Transport Security (ATS) strict for preview/production
// builds, but allow plain HTTP in *dev* builds so the app can talk to a local mux
// server (e.g. http://<lan-ip>:3000) without having to run TLS locally.
//
// EAS sets EAS_BUILD_PROFILE to the profile name (development|preview|production).

const appJson = require("./app.json");

/**
 * @param {unknown} value
 * @returns {asserts value is { expo: import("@expo/config-types").ExpoConfig }}
 */
function assertAppJson(value) {
  if (!value || typeof value !== "object") {
    throw new Error("Expected app.json to be an object");
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  if (!("expo" in value)) {
    throw new Error("Expected app.json to have an `expo` key");
  }
}

/**
 * @param {import("@expo/config-types").ExpoConfig} expoConfig
 */
function withDevAtsException(expoConfig) {
  const ios = expoConfig.ios ?? {};
  const infoPlist = ios.infoPlist ?? {};
  const ats = infoPlist.NSAppTransportSecurity ?? {};

  return {
    ...expoConfig,
    ios: {
      ...ios,
      infoPlist: {
        ...infoPlist,
        NSAppTransportSecurity: {
          ...ats,
          NSAllowsArbitraryLoads: true,
        },
      },
    },
  };
}

module.exports = () => {
  assertAppJson(appJson);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const expoConfig = appJson.expo;

  const buildProfile = process.env.EAS_BUILD_PROFILE;
  const allowInsecureHttp = !buildProfile || buildProfile === "development";

  return allowInsecureHttp ? withDevAtsException(expoConfig) : expoConfig;
};
