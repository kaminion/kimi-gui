'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  BASE_SLASH_COMMANDS,
  filterSlashCommands,
  mergeSlashCommands,
} = require('../main/slash-commands');

test('matches the Kimi Code Web UI slash command registry', () => {
  assert.deepEqual(
    BASE_SLASH_COMMANDS.map((command) => command.name),
    [
      '/new', '/clear', '/login', '/plan', '/swarm',
      '/goal', '/btw', '/auto', '/yolo', '/thinking',
      '/compact', '/undo', '/fork', '/export', '/status',
    ],
  );
});

test('adds built-in and custom skills using Kimi command naming', () => {
  const commands = mergeSlashCommands([
    { name: 'kimi-cli-help', source: 'builtin', description: 'Help' },
    { name: 'code-review', source: 'project', description: 'Review code' },
  ]);
  assert.equal(commands.find((command) => command.name === '/kimi-cli-help').isSkill, true);
  assert.equal(commands.find((command) => command.name === '/skill:code-review').acceptsInput, true);
});

test('autocomplete ranks exact, prefix, substring, and fuzzy matches', () => {
  assert.equal(filterSlashCommands(BASE_SLASH_COMMANDS, '/sta')[0].name, '/status');
  assert.equal(filterSlashCommands(BASE_SLASH_COMMANDS, '/pact')[0].name, '/compact');
  assert.equal(filterSlashCommands(BASE_SLASH_COMMANDS, '/cmpct')[0].name, '/compact');
  assert.deepEqual(filterSlashCommands(BASE_SLASH_COMMANDS, '/does-not-exist'), []);
});

test('renderer wiring keeps completion accessible and ahead of chat initialization', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer/js/slash-autocomplete.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'renderer/styles/components.css'), 'utf8');

  assert.ok(html.indexOf('js/slash-autocomplete.js') < html.indexOf('js/chat.js'));
  assert.match(renderer, /role', 'listbox'/);
  assert.match(renderer, /aria-activedescendant/);
  assert.match(renderer, /event\.key === 'Tab'/);
  assert.match(renderer, /event\.key === 'Escape'/);
  assert.match(styles, /prefers-reduced-motion: reduce/);
});
