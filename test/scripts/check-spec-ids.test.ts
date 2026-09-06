import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  extractExemptIds,
  findIdsMissingTestCoverage,
} from '../../scripts/check-spec-ids.mjs';

describe('extractExemptIds', () => {
  it('reads IDs listed under the "テスト対象外" table, ignoring earlier and later sections', () => {
    const fixture = `## 9. Other section

Some unrelated text mentioning FR-9-9 that is not inside the table.

## 10. テスト対象外(ドキュメント・構造で満たす)受け入れ基準の一覧

| ID | 満たし方 |
|---|---|
| FR-7-4 | 構造的要件: クレデンシャル保存コードを持たない(コードレビューで担保) |

## 11. Next section

FR-11-1 mentioned here must not be picked up either.
`;

    expect(extractExemptIds(fixture)).toEqual(['FR-7-4']);
  });

  it('splits multiple "/"-separated IDs within one table cell', () => {
    const fixture = `## 10. テスト対象外(ドキュメント・構造で満たす)受け入れ基準の一覧

| ID | 満たし方 |
|---|---|
| NFR-1 / NFR-6 | アーキテクチャで構造的に満足 |
| FR-2-11(運用規約部分) / FR-1-9(仕様明記部分) | requirements.md / design.md に明記済み |
`;

    expect(extractExemptIds(fixture).sort()).toEqual(
      ['FR-1-9', 'FR-2-11', 'NFR-1', 'NFR-6'].sort(),
    );
  });

  it('extracts every "a"/"b"/... sub-suffixed ID in a cell, e.g. three fully-qualified criteria', () => {
    // tasks.md's real table does not currently have a row shaped exactly like
    // this (its multi-ID rows use bare requirement-level or parenthesised
    // IDs) -- this fixture exercises the same "/"-splitting on three
    // fully-qualified sub-criteria in one cell, using NFR-7-1..3 (output
    // language) as a realistic example of IDs that are one requirement's
    // related sub-criteria.
    const fixture = `## 10. テスト対象外(ドキュメント・構造で満たす)受け入れ基準の一覧

| ID | 満たし方 |
|---|---|
| NFR-7-1 / NFR-7-2 / NFR-7-3 | 構造的要件: scripts/check-message-language.mjs による構造検査 |
`;

    expect(extractExemptIds(fixture)).toEqual([
      'NFR-7-1',
      'NFR-7-2',
      'NFR-7-3',
    ]);
  });

  it('returns an empty list when the table heading is absent', () => {
    expect(extractExemptIds('## 1. Nothing relevant here\n')).toEqual([]);
  });

  it('ignores non-table lines inside the section (headers, prose, blank lines)', () => {
    const fixture = `## 10. テスト対象外(ドキュメント・構造で満たす)受け入れ基準の一覧

Prose mentioning FR-1-1 outside of the table must be ignored.

| ID | 満たし方 |
|---|---|
| FR-2-2 | 説明 |
`;

    expect(extractExemptIds(fixture)).toEqual(['FR-2-2']);
  });
});

describe('findIdsMissingTestCoverage', () => {
  it('reports an ID that is neither in the test corpus nor exempted', () => {
    const missing = findIdsMissingTestCoverage(
      ['FR-1-1', 'FR-1-2'],
      "it('FR-1-1: covered by a test name', () => {})",
      [],
    );
    expect(missing).toEqual(['FR-1-2']);
  });

  it('does not report an ID that is exempted even with zero test occurrences', () => {
    const missing = findIdsMissingTestCoverage(
      ['FR-7-4'],
      'no relevant substring here',
      ['FR-7-4'],
    );
    expect(missing).toEqual([]);
  });

  it('does not report an ID found as a plain substring anywhere in the corpus', () => {
    const missing = findIdsMissingTestCoverage(
      ['NFR-4'],
      '// referenced only in a comment: NFR-4 masking',
      [],
    );
    expect(missing).toEqual([]);
  });
});

describe('NFR-7-1 / NFR-7-2 / NFR-7-3 (output language) test-coverage exemption', () => {
  it('are enforced structurally by scripts/check-message-language.mjs via `pnpm run lint`, not by a dedicated behavior test', () => {
    // requirements.md's NFR-7-1..3 (English-only, no multi-byte fixed
    // literals, including JSON enum values) are satisfied by scanning every
    // literal under src/**/*.ts for non-ASCII text (see
    // scripts/check-message-language.mjs's findNonAsciiLiterals, unit-tested
    // in check-message-language.test.ts) rather than by a single
    // criterion-specific behavior assertion. This guards that the structural
    // check stays wired into the quality gate, which is what actually proves
    // these three criteria instead of a test/**/*.ts name.
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    );
    expect(packageJson.scripts.lint).toContain(
      'node scripts/check-message-language.mjs',
    );
  });
});
