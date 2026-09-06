// @ts-check

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { runAsScript, VerificationError } from './lib/cli.mjs';

const projectRoot = resolve(import.meta.dirname, '..');
// The canonical config reference ends with links that only exist in this
// repository. Preserve the source document and remove that final section only
// from the skill-distributed copy.
const REPOSITORY_ONLY_SECTION = '\n## 関連ドキュメント\n';

export const SKILL_REFERENCE_FILES = [
  {
    source: 'docs/config-reference.md',
    target: 'skills/using-cfnsync/references/config-reference.md',
    transform: 'remove-repository-only-related-documents',
  },
  {
    source: 'docs/examples/cfnsync.sample.yaml',
    target: 'skills/using-cfnsync/references/examples/cfnsync.sample.yaml',
  },
];

/**
 * @param {string} root
 * @param {{ source: string, target: string, transform?: string }} reference
 */
export function renderSkillReference(root, reference) {
  const source = readFileSync(join(root, reference.source));
  if (reference.transform === undefined) {
    return source;
  }
  if (reference.transform === 'remove-repository-only-related-documents') {
    const content = source.toString('utf8');
    const sectionStart = content.indexOf(REPOSITORY_ONLY_SECTION);
    if (sectionStart === -1) {
      throw new Error(
        `${reference.source} does not contain the expected repository-only related documents section`,
      );
    }
    const nextSection = content.indexOf(
      '\n## ',
      sectionStart + REPOSITORY_ONLY_SECTION.length,
    );
    if (nextSection !== -1) {
      throw new Error(
        `${reference.source} must keep the repository-only related documents section as its final H2 section`,
      );
    }
    return Buffer.from(`${content.slice(0, sectionStart).trimEnd()}\n`);
  }

  throw new Error(`Unknown skill reference transform: ${reference.transform}`);
}

/** @param {string} [root] */
export function findOutOfSyncSkillReferences(root = projectRoot) {
  return SKILL_REFERENCE_FILES.filter((reference) => {
    const targetPath = join(root, reference.target);
    const rendered = renderSkillReference(root, reference);

    return (
      !existsSync(targetPath) || !rendered.equals(readFileSync(targetPath))
    );
  });
}

/** @param {string} [root] */
export function syncSkillReferences(root = projectRoot) {
  for (const reference of SKILL_REFERENCE_FILES) {
    const targetPath = join(root, reference.target);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, renderSkillReference(root, reference));
  }
}

/** @param {string} [root] */
export function checkSkillReferences(root = projectRoot) {
  const outOfSync = findOutOfSyncSkillReferences(root);
  if (outOfSync.length === 0) {
    return;
  }

  const targets = outOfSync
    .map(({ target }) => relative(root, join(root, target)))
    .join('\n');
  throw new VerificationError(
    `Skill references are out of sync:\n${targets}\nRun "pnpm run sync:skill-references" and commit the result.`,
  );
}

/** @param {string[]} [args] */
export function main(args = process.argv.slice(2)) {
  if (args.length === 0) {
    syncSkillReferences();
    process.stdout.write('Skill references synchronized.\n');
    return;
  }
  if (args.length === 1 && args[0] === '--check') {
    checkSkillReferences();
    process.stdout.write('Skill references are synchronized.\n');
    return;
  }

  throw new Error('usage: node scripts/sync-skill-references.mjs [--check]');
}

runAsScript(import.meta.url, main);
