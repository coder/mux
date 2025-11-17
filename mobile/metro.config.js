const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "..");
/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot);

const sharedAliases = {
  "@/": path.resolve(monorepoRoot, "src"),
};

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
config.resolver.platforms = ["ios", "android"];

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

module.exports = config;
