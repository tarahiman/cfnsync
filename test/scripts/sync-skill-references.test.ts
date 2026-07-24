import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkSkillReferences,
  findOutOfSyncSkillReferences,
  SKILL_REFERENCE_FILES,
  syncSkillReferences,
} from '../../scripts/sync-skill-references.mjs';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'cfnsync-skill-references-'));
  temporaryDirectories.push(root);

  const configReference = join(root, SKILL_REFERENCE_FILES[0].source);
  mkdirSync(dirname(configReference), { recursive: true });
  writeFileSync(
    configReference,
    [
      '# Config reference',
      '',
      'See [`examples/cfnsync.sample.yaml`](./examples/cfnsync.sample.yaml).',
      '',
      '## 関連ドキュメント',
      '',
      '- [`README.md`](../README.md)',
      '- [`design.md`](./spec/design.md)',
      '',
    ].join('\n'),
  );

  const sample = join(root, SKILL_REFERENCE_FILES[1].source);
  mkdirSync(dirname(sample), { recursive: true });
  writeFileSync(
    sample,
    '# Complete reference: ../config-reference.md\nversion: 1\n',
  );

  return root;
}

describe('skill reference synchronization', () => {
  it('creates self-contained references without modifying canonical documents', () => {
    const root = createFixture();
    const canonicalBefore = SKILL_REFERENCE_FILES.map(({ source }) =>
      readFileSync(join(root, source)),
    );

    expect(findOutOfSyncSkillReferences(root)).toEqual(SKILL_REFERENCE_FILES);

    syncSkillReferences(root);

    expect(findOutOfSyncSkillReferences(root)).toEqual([]);
    for (const [index, { source }] of SKILL_REFERENCE_FILES.entries()) {
      expect(readFileSync(join(root, source))).toEqual(canonicalBefore[index]);
    }

    const distributedConfig = readFileSync(
      join(root, SKILL_REFERENCE_FILES[0].target),
      'utf8',
    );
    expect(distributedConfig).toContain(
      '[`examples/cfnsync.sample.yaml`](./examples/cfnsync.sample.yaml)',
    );
    expect(distributedConfig).not.toContain('## 関連ドキュメント');
    expect(distributedConfig).not.toContain('README.md');

    expect(
      readFileSync(join(root, SKILL_REFERENCE_FILES[1].target), 'utf8'),
    ).toContain('../config-reference.md');
  });

  it('fails closed when the repository-only section cannot be transformed', () => {
    const root = createFixture();
    writeFileSync(
      join(root, SKILL_REFERENCE_FILES[0].source),
      '# Missing expected section\n',
    );

    expect(() => syncSkillReferences(root)).toThrow(
      /expected repository-only related documents section/,
    );
  });

  it('fails closed when another H2 section follows the repository-only section', () => {
    const root = createFixture();
    const configReference = join(root, SKILL_REFERENCE_FILES[0].source);
    writeFileSync(
      configReference,
      `${readFileSync(configReference, 'utf8')}\n## New canonical section\n\nMust not be dropped.\n`,
    );

    expect(() => syncSkillReferences(root)).toThrow(
      /must keep the repository-only related documents section as its final H2 section/,
    );
    expect(() => checkSkillReferences(root)).toThrow(
      /must keep the repository-only related documents section as its final H2 section/,
    );
  });

  it('fails the check without modifying stale references or sources', () => {
    const root = createFixture();
    syncSkillReferences(root);
    const target = join(root, SKILL_REFERENCE_FILES[0].target);
    const sourcesBefore = SKILL_REFERENCE_FILES.map(({ source }) =>
      readFileSync(join(root, source)),
    );
    writeFileSync(target, 'stale\n');

    expect(() => checkSkillReferences(root)).toThrow(
      /pnpm run sync:skill-references/,
    );
    expect(readFileSync(target, 'utf8')).toBe('stale\n');
    for (const [index, { source }] of SKILL_REFERENCE_FILES.entries()) {
      expect(readFileSync(join(root, source))).toEqual(sourcesBefore[index]);
    }
  });
});
