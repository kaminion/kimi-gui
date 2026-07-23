#!/usr/bin/env node
/**
 * postinstall.js — dev-mode branding for the vendored Electron binary.
 *
 * In dev (`npm start`), macOS derives the menu-bar app menu and the Dock label
 * from the .app bundle's CFBundleName/CFBundleDisplayName — which is "Electron"
 * out of the box. Packaged builds are branded by electron-builder from
 * productName, so this patch is dev-only and idempotent: it sets the two name
 * keys inside node_modules' Electron.app without renaming anything (path.txt
 * and the binary keep working untouched). No-op on non-macOS platforms and
 * when the plist is already patched or missing.
 */
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

if (process.platform !== 'darwin') process.exit(0);

const APP_NAME = 'Kimi-GUI';
const plist = path.join(
  __dirname,
  '..',
  'node_modules',
  'electron',
  'dist',
  'Electron.app',
  'Contents',
  'Info.plist'
);

function plistPrint(key) {
  return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], {
    encoding: 'utf8',
  }).trim();
}

function plistSet(key, value) {
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
}

try {
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    let current = '';
    try {
      current = plistPrint(key);
    } catch {
      // key absent — fall through and set it
    }
    if (current !== APP_NAME) plistSet(key, APP_NAME);
  }
  console.log(`[postinstall] dev Electron.app branded as ${APP_NAME}`);
} catch (err) {
  // Never fail an install over cosmetic branding.
  console.warn(`[postinstall] branding skipped: ${err.message}`);
}
