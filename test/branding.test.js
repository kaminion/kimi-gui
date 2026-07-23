'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { APP_NAME, APP_ID } = require('../main/branding');

const projectRoot = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');

test('runtime and packaging surfaces use the Kimi-GUI brand', () => {
  const pkg = JSON.parse(read('package.json'));
  const builder = read('electron-builder.yml');
  const main = read('main/main.js');
  const html = read('renderer/index.html');

  assert.equal(APP_NAME, 'Kimi-GUI');
  assert.equal(APP_ID, 'com.kimi.gui');
  assert.equal(pkg.productName, APP_NAME);
  assert.match(builder, /^appId: com\.kimi\.gui$/m);
  assert.match(builder, /^productName: "Kimi-GUI"$/m);
  assert.match(builder, /^  executableName: Kimi-GUI$/m);
  assert.match(builder, /^  shortcutName: Kimi-GUI$/m);
  assert.match(builder, /^  uninstallDisplayName: Kimi-GUI$/m);
  assert.match(main, /app\.setName\(APP_NAME\)/);
  assert.match(main, /app\.setAppUserModelId\(APP_ID\)/);
  assert.match(html, /<title>Kimi-GUI<\/title>/);
});
