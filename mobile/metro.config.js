const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "..");
/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot);

const sharedAliases = {
  "@/": path.resolve(monorepoRoot, "src"),
};
const BACKEND_BASE_URL_MODULE = "@/browser/utils/backendBaseUrl";
const BACKEND_BASE_URL_WEB_SHIM = path.resolve(projectRoot, "src/shims/backendBaseUrl");

// Add the monorepo root to the watch folders
config.watchFolders = [monorepoRoot];

// Resolve modules from the monorepo root
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(monorepoRoot, "node_modules"),
];

// Add alias support for shared imports
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  ...sharedAliases,
};
config.resolver.alias = {
  ...(config.resolver.alias ?? {}),
  ...sharedAliases,
};

// Enhance resolver to properly handle aliases with TypeScript extensions
config.resolver.resolverMainFields = ["react-native", "browser", "main"];
config.resolver.platforms = ["ios", "android", "web"];

// Explicitly set source extensions order (TypeScript first)
if (!config.resolver.sourceExts) {
  config.resolver.sourceExts = [];
}
const sourceExts = config.resolver.sourceExts;
if (!sourceExts.includes("ts")) {
  sourceExts.unshift("ts");
}
if (!sourceExts.includes("tsx")) {
  sourceExts.unshift("tsx");
}

// Expo web bundles run as classic scripts, so shared Vite helpers that access
// `import.meta.env` must be replaced before Metro resolves modules for web.
const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const isBackendBaseUrlModule =
    moduleName === BACKEND_BASE_URL_MODULE || moduleName === `${BACKEND_BASE_URL_MODULE}.ts`;

  if (platform === "web" && isBackendBaseUrlModule) {
    return context.resolveRequest(context, BACKEND_BASE_URL_WEB_SHIM, platform);
  }

  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }

  return context.resolveRequest(context, moduleName, platform);
};
module.exports = config;
