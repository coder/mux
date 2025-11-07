// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Add the monorepo root to the watch folders
config.watchFolders = [
  path.resolve(__dirname, '../../'),
];

// Resolve modules from the monorepo root
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(__dirname, '../../node_modules'),
];

// Add alias support for @shared imports
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  '@shared': path.resolve(__dirname, '../../src'),
};
config.resolver.alias = {
  ...(config.resolver.alias ?? {}),
  '@shared': path.resolve(__dirname, '../../src'),
};

// Enhance resolver to properly handle @shared alias with TypeScript extensions
// This ensures Metro's early resolver phase applies extensions to aliased imports
config.resolver.resolverMainFields = ['react-native', 'browser', 'main'];
config.resolver.platforms = ['ios', 'android'];

// Explicitly set source extensions order (TypeScript first)
// This helps Metro's resolver find .ts/.tsx files for @shared imports
if (!config.resolver.sourceExts) {
  config.resolver.sourceExts = [];
}
// Ensure .ts and .tsx are prioritized
const sourceExts = config.resolver.sourceExts;
if (!sourceExts.includes('ts')) {
  sourceExts.unshift('ts');
}
if (!sourceExts.includes('tsx')) {
  sourceExts.unshift('tsx');
}

module.exports = config;
