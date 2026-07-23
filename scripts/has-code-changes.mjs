import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CODE_DIRECTORIES = [
  '.github/workflows/',
  '.githooks/',
  'scripts/',
  'src/',
  'test/',
];

const CODE_FILES = new Set([
  '.mcp.json',
  'biome.json',
  'mise.toml',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'vitest.config.ts',
]);

export function isCodeRelatedPath(filePath) {
  const normalizedPath = filePath.replaceAll('\\', '/').replace(/^\.\//, '');

  return (
    CODE_FILES.has(normalizedPath) ||
    CODE_DIRECTORIES.some((directory) => normalizedPath.startsWith(directory))
  );
}

export function hasCodeRelatedPaths(filePaths) {
  return filePaths.some(isCodeRelatedPath);
}

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      `Unable to determine whether code changed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 2;
  }
}
