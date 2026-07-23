'use strict';

/**
 * Runtime brand identifiers. Packaging copies the same values into
 * package.json and electron-builder.yml; test/branding.test.js keeps those
 * non-JavaScript configuration surfaces synchronized.
 */
const APP_NAME = 'Kimi-GUI';
const APP_ID = 'com.kimi.gui';

module.exports = { APP_NAME, APP_ID };
