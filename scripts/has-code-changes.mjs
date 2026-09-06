// @ts-check

import { spawnSync } from 'node:child_process';

import { runAsScript } from './lib/cli.mjs';

const CODE_DIRECTORIES = [
  '.github/workflows/',
  '.githooks/',
  'scripts/',
  'skills/',
  'src/',
  'test/',
];

const CODE_FILES = new Set([
  '.mcp.json',
  'biome.json',
  'docs/config-reference.md',
  'docs/examples/cfnsync.sample.yaml',
  'mise.toml',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.test.json',
  'vitest.config.ts',
]);

/** @param {string} filePath */
export function isCodeRelatedPath(filePath) {
  const normalizedPath = filePath.replaceAll('\\', '/').replace(/^\.\//, '');

  return (
    CODE_FILES.has(normalizedPath) ||
    CODE_DIRECTORIES.some((directory) => normalizedPath.startsWith(directory))
  );
}

/** @param {string[]} filePaths */
export function hasCodeRelatedPaths(filePaths) {
  return filePaths.some(isCodeRelatedPath);
}

/** @param {string[]} args */
function changedPaths(args) {
  const result = spawnSync(
    'git',
    ['diff', '--name-only', '--no-renames', '-z', ...args],
    {
      encoding: 'buffer',
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.toString('utf8').trim() || 'git diff failed');
  }

  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter((filePath) => filePath.length > 0);
}

/** @param {string[]} args */
function parseArguments(args) {
  if (args.length === 1 && args[0] === '--staged') {
    return ['--cached'];
  }
  if (args.length === 2 && args[0] === '--range' && args[1].length > 0) {
    return [args[1]];
  }

  throw new Error(
    'usage: node scripts/has-code-changes.mjs --staged | --range <git-range>',
  );
}

export function main(args = process.argv.slice(2)) {
  const diffArguments = parseArguments(args);
  process.stdout.write(
    `${hasCodeRelatedPaths(changedPaths(diffArguments)) ? 'true' : 'false'}\n`,
  );
}

function runMain() {
  try {
    main();
  } catch (error) {
    throw new Error(
      `Unable to determine whether code changed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

runAsScript(import.meta.url, runMain);
