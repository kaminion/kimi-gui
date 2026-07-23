'use strict';

/**
 * Small, shell-free Git facade used by the new-chat project controls.
 *
 * Every command is executed with an argv array (never through a shell).
 * Branch switching is limited to a branch returned by `listInfo()` for the
 * same worktree, so renderer input cannot be interpreted as an option or an
 * arbitrary refspec.
 */

const path = require('node:path');
const { execFile } = require('node:child_process');

const COMMAND_TIMEOUT_MS = 5000;
const MAX_BUFFER = 1024 * 1024;

function runGit(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || '').trim(),
          error,
        });
      },
    );
  });
}

function validCwd(cwd) {
  return typeof cwd === 'string' && cwd.trim() && path.isAbsolute(cwd);
}

async function listInfo(cwd) {
  if (!validCwd(cwd)) {
    return { isRepository: false, current: null, branches: [] };
  }

  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout !== 'true') {
    return { isRepository: false, current: null, branches: [] };
  }

  const [currentResult, branchesResult] = await Promise.all([
    runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    runGit(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
  ]);
  const branches = branchesResult.ok
    ? branchesResult.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean)
    : [];

  return {
    isRepository: true,
    current: currentResult.ok && currentResult.stdout ? currentResult.stdout : null,
    branches,
  };
}

async function checkout(cwd, branch) {
  const info = await listInfo(cwd);
  const wanted = typeof branch === 'string' ? branch.trim() : '';
  if (!info.isRepository) throw new Error('선택한 프로젝트는 Git 저장소가 아닙니다.');
  if (!wanted || !info.branches.includes(wanted)) {
    throw new Error('선택한 브랜치를 이 프로젝트에서 찾을 수 없습니다.');
  }
  if (info.current === wanted) return { ...info, changed: false };

  // `git switch` gives clearer safety errors. Older Git versions fall back to
  // checkout; neither command uses --force, so local work is never overwritten.
  let result = await runGit(cwd, ['switch', wanted]);
  if (!result.ok && /not a git command|unknown subcommand/i.test(`${result.stderr}\n${result.stdout}`)) {
    result = await runGit(cwd, ['checkout', wanted]);
  }
  if (!result.ok) {
    throw new Error(result.stderr || result.stdout || '브랜치를 전환하지 못했습니다.');
  }
  const updated = await listInfo(cwd);
  return { ...updated, changed: true };
}

module.exports = { listInfo, checkout };
