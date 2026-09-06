import { describe, expect, it } from 'vitest';
import { createNoEchoRedactor } from '../../src/usecase/redactor.js';

describe('NoEcho usecase redactor', () => {
  it('NFR-4: maskNoEcho は NoEcho キーの値のみ **** に置換する', () => {
    const redact = createNoEchoRedactor(
      { DbPassword: 'S3cr3t-Raw-Value-Do-Not-Leak', Other: 'plain' },
      ['DbPassword'],
    );
    expect({
      DbPassword: redact('S3cr3t-Raw-Value-Do-Not-Leak'),
      Other: redact('plain'),
    }).toEqual({ DbPassword: '****', Other: 'plain' });
  });

  it('NFR-4: maskNoEcho は noEchoParams に無いキーを変更しない', () => {
    const redact = createNoEchoRedactor({ A: 'value-a', B: 'value-b' }, []);
    expect({ A: redact('value-a'), B: redact('value-b') }).toEqual({
      A: 'value-a',
      B: 'value-b',
    });
  });

  it('NFR-4: 対象 NoEcho パラメータの実効値を出現箇所すべてで **** に置換する', () => {
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
  ])('NFR-4: 空文字・4文字未満の値 %j は誤マスク防止のため置換しない', (shortValue) => {
    const redact = createNoEchoRedactor({ Secret: shortValue }, ['Secret']);
    expect(redact(`prefix ${shortValue} suffix`)).toBe(
      `prefix ${shortValue} suffix`,
    );
  });

  it('NFR-4(再レビュー⑥): JSON.stringify と encodeURIComponent の可逆表現も同時にマスクする', () => {
    const secret = 'line1\n"quoted"/値';
    const redact = createNoEchoRedactor({ Secret: secret }, ['Secret']);
    const jsonEscaped = JSON.stringify(secret).slice(1, -1);
    const uriEncoded = encodeURIComponent(secret);

    expect(redact(`raw=${secret} json=${jsonEscaped} uri=${uriEncoded}`)).toBe(
      'raw=**** json=**** uri=****',
    );
  });

  it('NFR-4: NoEcho 実効値が __REQUIRED__ の場合は予約 sentinel を誤マスクしない', () => {
    const sentinelRedactor = createNoEchoRedactor({ Secret: '__REQUIRED__' }, [
      'Secret',
    ]);
    const partialMatchRedactor = createNoEchoRedactor(
      { Secret: 'prefix__REQUIRED__suffix' },
      ['Secret'],
    );

    expect(
      sentinelRedactor('必須パラメータに __REQUIRED__ が残っています: Secret'),
    ).toBe('必須パラメータに __REQUIRED__ が残っています: Secret');
    expect(partialMatchRedactor('prefix__REQUIRED__suffix')).toBe('****');
  });

  it('NFR-4: 明示値は template Default より優先して redactor の実効値になる', () => {
    const redact = createNoEchoRedactor(
      { Secret: 'configured-secret' },
      ['Secret'],
      { Secret: 'default-secret' },
    );

    expect(redact('configured-secret / default-secret')).toBe(
      '**** / default-secret',
    );
  });
});
