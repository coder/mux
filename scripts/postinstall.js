#!/usr/bin/env node
/**
 * Conditional postinstall script for node-pty
 * 
 * Desktop mode (Electron present):
 *   - Rebuilds node-pty for Electron's ABI
 * 
 * Server mode (no Electron):
 *   - Uses Node.js prebuilt binaries (no rebuild needed)
 */

const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

// Check if electron is available (desktop mode)
const electronPath = path.join(__dirname, '..', 'node_modules', 'electron');
const hasElectron = fs.existsSync(electronPath);

if (hasElectron) {
  console.log('🔧 Electron detected - rebuilding node-pty for Electron...');
  try {
    execSync('npx @electron/rebuild -f -m . --only node-pty', {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..')
    });
    console.log('✅ Native modules rebuilt successfully');
  } catch (err) {
    console.error('⚠️  Failed to rebuild native modules:', err.message);
    console.error('   Terminal functionality may not work in desktop mode.');
    console.error('   Run "make rebuild-native" manually to fix.');
    process.exit(0); // Don't fail install, just warn
  }
} else {
  console.log('🌐 Server mode detected - using Node.js prebuilt binaries');
}
