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
  '@shared': path.resolve(__dirname, '../../src'),
};

module.exports = config;
