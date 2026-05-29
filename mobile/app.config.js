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

function readOptionalEnv(name) {
  const rawValue = process.env[name];
  if (rawValue === undefined) {
    return undefined;
  }

  if (typeof rawValue !== "string") {
    throw new Error(`Expected ${name} to be a string`);
  }

  const trimmed = rawValue.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * User rationale: `EXPO_PUBLIC_BACKEND_URL` / `EXPO_PUBLIC_AUTH_TOKEN` should
 * define mobile defaults in one command so agents do not have to open Settings
 * manually before the first successful connection.
 */
function withMuxEnvDefaults(expoConfig) {
  const envBaseUrl = readOptionalEnv("EXPO_PUBLIC_BACKEND_URL");
  const envAuthToken = readOptionalEnv("EXPO_PUBLIC_AUTH_TOKEN");

  if (!envBaseUrl && !envAuthToken) {
    return expoConfig;
  }

  const existingExtra = expoConfig.extra ?? {};
  if (!existingExtra || typeof existingExtra !== "object" || Array.isArray(existingExtra)) {
    throw new Error("Expected expo.extra to be an object");
  }

  const existingMux = existingExtra.mux;
  if (existingMux != null && (typeof existingMux !== "object" || Array.isArray(existingMux))) {
    throw new Error("Expected expo.extra.mux to be an object when provided");
  }

  return {
    ...expoConfig,
    extra: {
      ...existingExtra,
      mux: {
        ...(existingMux ?? {}),
        ...(envBaseUrl ? { baseUrl: envBaseUrl } : {}),
        ...(envAuthToken ? { authToken: envAuthToken } : {}),
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
  const configWithNetworkingPolicy = allowInsecureHttp ? withDevAtsException(expoConfig) : expoConfig;

  return withMuxEnvDefaults(configWithNetworkingPolicy);
};
