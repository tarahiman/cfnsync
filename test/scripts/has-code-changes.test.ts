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
    'package.json',
    'pnpm-lock.yaml',
    './tsconfig.json',
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
