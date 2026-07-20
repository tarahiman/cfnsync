import { describe, expect, it } from 'vitest';
import { createNoEchoRedactor } from '../../src/usecase/redactor.js';

describe('NoEcho usecase redactor', () => {
  it('対象 NoEcho パラメータの実効値を出現箇所すべてで **** に置換する', () => {
    const redact = createNoEchoRedactor(
      { Secret: 'sensitive-value', Plain: 'visible-value' },
      ['Secret'],
    );

    expect(redact('sensitive-value / sensitive-value / visible-value')).toBe(
      '**** / **** / visible-value',
    );
  });

  it.each([
    '',
    'a',
    'ab',
    'abc',
  ])('空文字・4文字未満の値 %j は誤マスク防止のため置換しない', (shortValue) => {
    const redact = createNoEchoRedactor({ Secret: shortValue }, ['Secret']);
    expect(redact(`prefix ${shortValue} suffix`)).toBe(
      `prefix ${shortValue} suffix`,
    );
  });
});
