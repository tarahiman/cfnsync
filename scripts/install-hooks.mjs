// @ts-check

import { spawnSync } from 'node:child_process';

import { runAsScript } from './lib/cli.mjs';

const HOOKS_PATH = '.githooks';

/** @param {string[]} args */
function runGit(args) {
  return spawnSync('git', args, {
    encoding: 'utf8',
  });
}

export function main() {
  const existing = runGit(['config', '--local', '--get', 'core.hooksPath']);
  if (existing.error) {
    throw existing.error;
  }
  if (existing.status !== 0 && existing.status !== 1) {
    throw new Error(existing.stderr.trim() || 'unable to read core.hooksPath');
  }

  const currentPath = existing.stdout.trim();
  if (currentPath && currentPath !== HOOKS_PATH) {
    throw new Error(
      `core.hooksPath is already set to "${currentPath}". ` +
        `Move any required hooks into ${HOOKS_PATH}, then remove the existing ` +
        'setting before retrying.',
    );
  }

  const configured = runGit([
    'config',
    '--local',
    'core.hooksPath',
    HOOKS_PATH,
  ]);
  if (configured.error) {
    throw configured.error;
  }
  if (configured.status !== 0) {
    throw new Error(configured.stderr.trim() || 'unable to configure hooks');
  }

  console.log(`Configured core.hooksPath=${HOOKS_PATH} for this clone.`);
}

runAsScript(import.meta.url, main);
