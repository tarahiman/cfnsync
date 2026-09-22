import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const temporaryRepositories: string[] = [];

afterEach(() => {
  for (const repository of temporaryRepositories.splice(0)) {
    rmSync(repository, { force: true, recursive: true });
  }
});

function git(repository: string, args: string[]) {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
  });
}

function createHookRepository() {
  const repository = mkdtempSync(join(tmpdir(), 'cfnsync-hook-test-'));
  temporaryRepositories.push(repository);
  const scriptsDirectory = join(repository, 'scripts');
  const hooksDirectory = join(repository, '.githooks');
  const fakeBinDirectory = join(repository, 'fake-bin');
  const scriptsLibDirectory = join(scriptsDirectory, 'lib');
  const localToolsDirectory = join(repository, '.tools', 'bin');
  const hookLog = join(repository, 'hook.log');

  mkdirSync(join(repository, 'src'), { recursive: true });
  mkdirSync(join(repository, 'node_modules'));
  mkdirSync(scriptsDirectory);
  mkdirSync(scriptsLibDirectory);
  mkdirSync(hooksDirectory);
  mkdirSync(fakeBinDirectory);
  mkdirSync(localToolsDirectory, { recursive: true });

  cpSync(
    join(projectRoot, '.githooks', 'pre-commit'),
    join(hooksDirectory, 'pre-commit'),
  );
  cpSync(
    join(projectRoot, 'scripts', 'has-code-changes.mjs'),
    join(scriptsDirectory, 'has-code-changes.mjs'),
  );
  cpSync(
    join(projectRoot, 'scripts', 'lib', 'cli.mjs'),
    join(scriptsLibDirectory, 'cli.mjs'),
  );
  cpSync(
    join(projectRoot, 'scripts', 'run-staged-quality-checks.sh'),
    join(scriptsDirectory, 'run-staged-quality-checks.sh'),
  );

  const pathGitleaks = join(fakeBinDirectory, 'gitleaks');
  writeFileSync(
    pathGitleaks,
    [
      '#!/bin/sh',
      `printf 'gitleaks:path:%s\\n' "$*" >> "$HOOK_LOG"`,
      'exit 99',
      '',
    ].join('\n'),
  );
  chmodSync(pathGitleaks, 0o755);

  const localGitleaks = join(localToolsDirectory, 'gitleaks');
  writeFileSync(
    localGitleaks,
    [
      '#!/bin/sh',
      `printf 'gitleaks:local:%s\\n' "$*" >> "$HOOK_LOG"`,
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(localGitleaks, 0o755);

  const fakeNpm = join(fakeBinDirectory, 'npm');
  writeFileSync(
    fakeNpm,
    [
      '#!/bin/sh',
      `printf 'npm:%s\\n' "$*" >> "$HOOK_LOG"`,
      "if grep -q '^STAGED_VALID$' src/example.ts; then",
      '  exit 0',
      'fi',
      'exit 23',
      '',
    ].join('\n'),
  );
  chmodSync(fakeNpm, 0o755);

  writeFileSync(join(repository, 'package.json'), '{"private":true}\n');
  writeFileSync(join(repository, 'src', 'example.ts'), 'BASE\n');

  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'user.name', 'Hook Test']);
  git(repository, ['config', 'user.email', 'hook-test@example.invalid']);
  git(repository, ['add', '.']);
  git(repository, ['commit', '--quiet', '-m', 'baseline']);
  git(repository, ['config', 'core.hooksPath', '.githooks']);

  return {
    fakeBinDirectory,
    hookLog,
    repository,
  };
}

function commitWithHook(
  repository: string,
  fakeBinDirectory: string,
  hookLog: string,
) {
  return spawnSync('git', ['-C', repository, 'commit', '-m', 'test change'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITLEAKS_BIN: '',
      HOOK_LOG: hookLog,
      PATH: `${fakeBinDirectory}:${process.env.PATH ?? ''}`,
    },
  });
}

describe('pre-commit staged snapshot isolation', () => {
  it('accepts valid staged code even when the working tree is invalid', () => {
    const { fakeBinDirectory, hookLog, repository } = createHookRepository();
    const sourcePath = join(repository, 'src', 'example.ts');

    writeFileSync(sourcePath, 'STAGED_VALID\n');
    git(repository, ['add', 'src/example.ts']);
    writeFileSync(sourcePath, 'WORKTREE_INVALID\n');

    const commit = commitWithHook(repository, fakeBinDirectory, hookLog);

    expect(commit.status, commit.stderr).toBe(0);
    expect(git(repository, ['show', 'HEAD:src/example.ts'])).toBe(
      'STAGED_VALID\n',
    );
    expect(readFileSync(sourcePath, 'utf8')).toBe('WORKTREE_INVALID\n');
    expect(readFileSync(hookLog, 'utf8').trim().split('\n')).toEqual([
      'gitleaks:local:git --pre-commit --staged --redact --no-banner',
      'npm:run quality:check',
    ]);
  });

  it('rejects invalid staged code even when the working tree is valid', () => {
    const { fakeBinDirectory, hookLog, repository } = createHookRepository();
    const sourcePath = join(repository, 'src', 'example.ts');

    writeFileSync(sourcePath, 'STAGED_INVALID\n');
    git(repository, ['add', 'src/example.ts']);
    writeFileSync(sourcePath, 'STAGED_VALID\n');

    const commit = commitWithHook(repository, fakeBinDirectory, hookLog);

    expect(commit.status).not.toBe(0);
    expect(git(repository, ['show', ':src/example.ts'])).toBe(
      'STAGED_INVALID\n',
    );
    expect(readFileSync(sourcePath, 'utf8')).toBe('STAGED_VALID\n');
  });
});

describe('staged quality gate invocability', () => {
  // The two tests above replace npm with a stub, so they only prove that the
  // hook asks for "npm run quality:check" — not that the script it names can
  // actually run there. The hook runs it inside a snapshot whose node_modules
  // is a symlink to the contributor's real one, and pnpm refuses to run in
  // that layout: it aborts with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY,
  // and on a terminal it follows the symlink and reinstalls the real
  // node_modules from scratch. So "quality:check" must not re-enter pnpm.
  it('defines quality:check without re-entering pnpm', () => {
    const manifest = JSON.parse(
      readFileSync(join(projectRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    expect(manifest.scripts['quality:check']).not.toMatch(/\bpnpm\b/);
  });

  it('runs every quality:check step through a runner that leaves node_modules alone', () => {
    const manifest = JSON.parse(
      readFileSync(join(projectRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    const gate = manifest.scripts['quality:check'] ?? '';
    const steps = gate.split('&&').map((step) => step.trim());

    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) expect(step).toMatch(/^npm (run |test\b)/);
  });
});
