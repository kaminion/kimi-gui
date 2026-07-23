'use strict';

/**
 * Slash commands exposed by the Kimi Code 0.28.x Web UI. This is deliberately
 * the web-compatible registry, not the larger terminal-only command list.
 */
const BASE_SLASH_COMMANDS = Object.freeze([
  { name: '/new', descriptionKey: 'slash.new', description: 'Start a new conversation' },
  { name: '/clear', descriptionKey: 'slash.clear', description: 'Clear the current conversation' },
  { name: '/login', descriptionKey: 'slash.login', description: 'Sign in to Kimi Code' },
  { name: '/plan', descriptionKey: 'slash.plan', description: 'Toggle plan mode' },
  { name: '/swarm', descriptionKey: 'slash.swarm', description: 'Toggle Swarm or start with instructions', acceptsInput: true },
  { name: '/goal', descriptionKey: 'slash.goal', description: 'Create or control a long-running goal', acceptsInput: true },
  { name: '/btw', descriptionKey: 'slash.btw', description: 'Ask a side question without interrupting work', acceptsInput: true },
  { name: '/auto', descriptionKey: 'slash.auto', description: 'Use automatic approvals' },
  { name: '/yolo', descriptionKey: 'slash.yolo', description: 'Approve all tool calls' },
  { name: '/thinking', descriptionKey: 'slash.thinking', description: 'Toggle thinking mode' },
  { name: '/compact', descriptionKey: 'slash.compact', description: 'Compact conversation context', acceptsInput: true },
  { name: '/undo', descriptionKey: 'slash.undo', description: 'Roll back the previous turn' },
  { name: '/fork', descriptionKey: 'slash.fork', description: 'Fork this conversation' },
  { name: '/export', descriptionKey: 'slash.export', description: 'Export this conversation' },
  { name: '/status', descriptionKey: 'slash.status', description: 'Show session status' },
]);

function commandForSkill(skill) {
  if (!skill || typeof skill.name !== 'string' || !skill.name.trim()) return null;
  const cleanName = skill.name.trim().replace(/^\/+/, '');
  return {
    name: skill.source === 'builtin' ? `/${cleanName}` : `/skill:${cleanName}`,
    descriptionKey: null,
    description: skill.description || 'Load Agent Skill',
    acceptsInput: true,
    isSkill: true,
    skillSource: skill.source || 'user',
  };
}

function mergeSlashCommands(skills = []) {
  const commands = BASE_SLASH_COMMANDS.map((command) => ({ ...command }));
  const names = new Set(commands.map((command) => command.name));
  for (const skill of skills) {
    const command = commandForSkill(skill);
    if (!command || names.has(command.name)) continue;
    names.add(command.name);
    commands.push(command);
  }
  return commands;
}

function fuzzyScore(commandName, input) {
  const haystack = String(commandName || '').toLowerCase().replace(/^\//, '');
  const needle = String(input || '').toLowerCase().trim().replace(/^\//, '');
  if (!needle) return 1;
  if (haystack === needle) return 1000;
  if (haystack.startsWith(needle)) return 700 - (haystack.length - needle.length);
  const contains = haystack.indexOf(needle);
  if (contains >= 0) return 500 - contains * 4 - (haystack.length - needle.length);

  let cursor = 0;
  let gaps = 0;
  let previous = -1;
  for (const char of needle) {
    const found = haystack.indexOf(char, cursor);
    if (found < 0) return 0;
    if (previous >= 0) gaps += found - previous - 1;
    previous = found;
    cursor = found + 1;
  }
  return 250 - gaps * 3 - (haystack.length - needle.length);
}

function filterSlashCommands(commands, input, limit = 10) {
  return (Array.isArray(commands) ? commands : [])
    .map((command, index) => ({ command, index, score: fuzzyScore(command.name, input) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((item) => item.command);
}

module.exports = {
  BASE_SLASH_COMMANDS,
  commandForSkill,
  filterSlashCommands,
  fuzzyScore,
  mergeSlashCommands,
};
