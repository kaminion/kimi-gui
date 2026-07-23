'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Skills has a first-class main navigation entry and focused manager', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/js/app.js');
  const settings = read('renderer/js/settings.js');

  assert.ok(html.indexOf('id="skills-btn"') < html.indexOf('id="settings-btn"'));
  assert.match(app, /window\.Settings\?\.openSkills\?\.\(\)/);
  assert.match(settings, /function openSkills\(\)/);
  assert.match(settings, /open\('skills', \{ focused: true \}\)/);
  assert.doesNotMatch(
    settings.slice(settings.indexOf('function sections()'), settings.indexOf('function buildRow')),
    /\{ id: 'skills'/,
  );
});

test('Ask Kimi starts a new chat with a scope-aware Skill template', () => {
  const app = read('renderer/js/app.js');
  const chat = read('renderer/js/chat.js');
  const settings = read('renderer/js/settings.js');
  const i18n = read('renderer/js/i18n.js');

  assert.match(settings, /window\.App\?\.startSkillDraft\?\.\(selectedScope\)/);
  assert.match(app, /startSkillDraft\(scope = 'project'\)/);
  assert.match(app, /App\.startNewChat\(\)/);
  assert.match(app, /window\.Chat\?\.setComposerText\?\.\(template\)/);
  assert.match(chat, /function setComposerText\(text/);
  assert.match(i18n, /settings\.skills\.scope_user': '모든 프로젝트'/);
  assert.match(i18n, /settings\.skills\.scope_project': '현재 프로젝트'/);
  assert.match(i18n, /\.agents\/skills\/<skill-name>\/SKILL\.md/);
});
