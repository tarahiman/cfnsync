import { describe, expect, it } from 'vitest';
import { findNonAsciiLiterals } from '../../scripts/check-message-language.mjs';

describe('NFR-7: findNonAsciiLiterals', () => {
  it('flags a plain non-ASCII string literal', () => {
    const violations = findNonAsciiLiterals(
      "const a = '失敗しました';",
      'x.ts',
    );
    expect(violations).toEqual([{ line: 1, text: '失敗しました' }]);
  });

  it('flags non-ASCII inside a URL-shaped literal (// must not be treated as a comment)', () => {
    const violations = findNonAsciiLiterals(
      "const a = 'https://example.invalid/日本語エラー';",
      'x.ts',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].text).toContain('日本語エラー');
  });

  it('flags a string literal whose content merely looks like a block comment', () => {
    const violations = findNonAsciiLiterals(
      "const a = '/* 日本語エラー */';",
      'x.ts',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].text).toBe('/* 日本語エラー */');
  });

  it('flags Latin-1 supplement characters outside the plain-ASCII range', () => {
    const violations = findNonAsciiLiterals("const a = 'café';", 'x.ts');
    expect(violations).toEqual([{ line: 1, text: 'café' }]);
  });

  it('does not flag a genuine line comment containing non-ASCII text', () => {
    const violations = findNonAsciiLiterals(
      "// 日本語コメント\nconst a = 'ok';",
      'x.ts',
    );
    expect(violations).toEqual([]);
  });

  it('does not flag a genuine block comment containing non-ASCII text', () => {
    const violations = findNonAsciiLiterals(
      "/* 日本語ブロックコメント */\nconst a = 'ok';",
      'x.ts',
    );
    expect(violations).toEqual([]);
  });

  it('does not flag a JSDoc comment containing non-ASCII text', () => {
    const violations = findNonAsciiLiterals(
      '/**\n * 日本語の説明\n */\nfunction f(): void {}',
      'x.ts',
    );
    expect(violations).toEqual([]);
  });

  it('only checks the static quasis of a template literal, not interpolated expressions', () => {
    const violations = findNonAsciiLiterals(
      "const name = 'ok';\nconst a = `Stack '${name}' failed`;",
      'x.ts',
    );
    expect(violations).toEqual([]);
  });

  it('flags non-ASCII text inside the static part of a template literal', () => {
    const violations = findNonAsciiLiterals(
      "const name = 'X';\nconst a = `スタック '${name}' に失敗`;",
      'x.ts',
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.text.includes('スタック'))).toBe(true);
  });

  it('reports the 1-indexed line of the violation in multi-line source', () => {
    const violations = findNonAsciiLiterals(
      "const a = 'ok';\nconst b = 'ok';\nconst c = '失敗';\n",
      'x.ts',
    );
    expect(violations).toEqual([{ line: 3, text: '失敗' }]);
  });

  it('does not flag plain ASCII-only source', () => {
    const violations = findNonAsciiLiterals(
      "const a = 'ASCII only, no problem here.';",
      'x.ts',
    );
    expect(violations).toEqual([]);
  });
});
