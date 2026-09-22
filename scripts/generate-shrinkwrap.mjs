// @ts-check

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runAsScript } from './lib/cli.mjs';

// 公開物に npm-shrinkwrap.json を同梱し、利用者側の依存ツリーを固定する。
// このリポジトリは pnpm 管理のため、npm を作業ディレクトリで直接動かすと
// node_modules/.pnpm 配下(依存パッケージ自身の devDependencies を含む)を
// ツリーとして解釈して ERESOLVE で失敗する。package.json だけを置いた
// 一時ディレクトリで解決させ、生成物のみを持ち帰る。
export function main() {
  const root = resolve(import.meta.dirname, '..');
  const workspace = mkdtempSync(join(tmpdir(), 'cfnsync-shrinkwrap-'));

  try {
    copyFileSync(join(root, 'package.json'), join(workspace, 'package.json'));
    execFileSync(
      'npm',
      ['install', '--package-lock-only', '--ignore-scripts'],
      {
        cwd: workspace,
        stdio: 'inherit',
      },
    );
    execFileSync('npm', ['shrinkwrap'], { cwd: workspace, stdio: 'inherit' });
    copyFileSync(
      join(workspace, 'npm-shrinkwrap.json'),
      join(root, 'npm-shrinkwrap.json'),
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

runAsScript(import.meta.url, main);
