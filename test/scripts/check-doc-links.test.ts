import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectMarkdownFiles } from '../../scripts/check-doc-links.mjs';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'cfnsync-doc-links-'));
  temporaryDirectories.push(root);
  mkdirSync(join(root, 'docs'));
  mkdirSync(join(root, 'skills'));
  writeFileSync(join(root, 'docs', 'real.md'), '# Real\n');
  return root;
}

describe('Markdown file collection', () => {
  it('excludes symlinked Markdown files under docs/ and skills/', () => {
    // Regression test: the pre-consolidation collectMarkdownFiles used
    // entry.isFile(), which is false for symlinks. The shared filesUnder
    // helper treats "not a directory" as a leaf, so without an explicit
    // filter a symlinked .md file would be picked up in addition to the
    // real file it points to.
    const root = createFixture();
    symlinkSync(join(root, 'docs', 'real.md'), join(root, 'docs', 'linked.md'));

    expect(collectMarkdownFiles(root)).toEqual([join(root, 'docs', 'real.md')]);
  });

  it('still collects real Markdown files under docs/, skills/, and the root', () => {
    const root = createFixture();
    writeFileSync(join(root, 'README.md'), '# Root\n');
    writeFileSync(join(root, 'skills', 'guide.md'), '# Guide\n');

    expect(collectMarkdownFiles(root).sort()).toEqual(
      [
        join(root, 'README.md'),
        join(root, 'docs', 'real.md'),
        join(root, 'skills', 'guide.md'),
      ].sort(),
    );
  });
});
