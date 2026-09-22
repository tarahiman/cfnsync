import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import {
  hasCodeRelatedPaths,
  isCodeRelatedPath,
} from '../../scripts/has-code-changes.mjs';

describe('code-related path detection', () => {
  it.each([
    'src/core/plan.ts',
    'test/core/plan.test.ts',
    'scripts/check-control-chars.mjs',
    '.githooks/pre-commit',
    '.github/workflows/pull-request.yml',
    'docs/config-reference.md',
    'docs/examples/cfnsync.sample.yaml',
    'skills/using-cfnsync/SKILL.md',
    'package.json',
    'pnpm-lock.yaml',
    './tsconfig.json',
    'tsconfig.test.json',
    'tsconfig.scripts.json',
  ])('treats %s as code-related', (filePath) => {
    expect(isCodeRelatedPath(filePath)).toBe(true);
  });

  it.each([
    'README.md',
    'CONTRIBUTING.md',
    'docs/spec/requirements.md',
    '.github/ISSUE_TEMPLATE/bug_report.yml',
  ])('treats %s as documentation or metadata', (filePath) => {
    expect(isCodeRelatedPath(filePath)).toBe(false);
  });

  it('treats any root-level tsconfig*.json file as code-related without hand-listing it', () => {
    // Regression test: tsconfig.scripts.json was introduced by this change
    // but omitted from the old hand-maintained CODE_FILES list, so a diff
    // touching only that file was silently classified as "no code changes"
    // and the quality gate was skipped entirely. Root-level tsconfig*.json
    // files are now matched by pattern so a future tsconfig variant cannot
    // fall through the same way.
    expect(isCodeRelatedPath('tsconfig.future-variant.json')).toBe(true);
  });

  it('does not widen the tsconfig pattern to nested or unrelated files', () => {
    expect(isCodeRelatedPath('packages/example/tsconfig.json')).toBe(false);
    expect(isCodeRelatedPath('tsconfig.json.bak')).toBe(false);
    expect(isCodeRelatedPath('tsconfigsomething.json')).toBe(false);
  });

  it('normalizes Windows path separators', () => {
    expect(isCodeRelatedPath('src\\core\\plan.ts')).toBe(true);
  });

  it('reports whether any path is code-related', () => {
    expect(hasCodeRelatedPaths(['README.md', 'src/core/plan.ts'])).toBe(true);
    expect(hasCodeRelatedPaths(['README.md', 'docs/spec/design.md'])).toBe(
      false,
    );
  });
});

describe('pull request documentation gate', () => {
  it('runs documentation validation before the conditional code-quality gate', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/pull-request.yml', import.meta.url),
      'utf8',
    );
    const documentationStep =
      '      - name: Validate documentation\n' +
      '        run: node scripts/check-doc-links.mjs && node scripts/check-spec-ids.mjs';

    expect(workflow).toContain(documentationStep);
    expect(workflow.indexOf(documentationStep)).toBeLessThan(
      workflow.indexOf('      - name: Detect code-related changes'),
    );
  });
});
