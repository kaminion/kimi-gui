'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const sourceRoots = ['main', 'renderer/js', 'scripts', 'test'];

function javascriptFiles(relativeDir) {
  const absoluteDir = path.join(projectRoot, relativeDir);
  if (!fs.existsSync(absoluteDir)) return [];
  return fs.readdirSync(absoluteDir, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(relativeDir, entry.name);
    return entry.isDirectory()
      ? javascriptFiles(relativePath)
      : (entry.isFile() && entry.name.endsWith('.js') ? [relativePath] : []);
  });
}

const files = sourceRoots.flatMap(javascriptFiles).sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

console.log(`Syntax check passed (${files.length} JavaScript files).`);

const testFiles = files.filter((file) => (
  file.startsWith(`test${path.sep}`) && file.endsWith('.test.js')
));
const tests = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: projectRoot,
  encoding: 'utf8',
});
process.stdout.write(tests.stdout);
process.stderr.write(tests.stderr);
process.exit(tests.status ?? 1);
