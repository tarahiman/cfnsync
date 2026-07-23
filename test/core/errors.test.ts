import { describe, expect, it } from 'vitest';
import { AwsError, StatePersistenceError } from '../../src/core/errors.js';

describe('core/errors', () => {
  it('internal: stackKey・region・cause を同時にメッセージと Error.cause へ保持する', () => {
    const cause = new Error('sdk failure');
    const error = new AwsError('AWS 操作失敗', {
      stackKey: 'app.yaml@ap-northeast-1',
      region: 'ap-northeast-1',
      cause,
    });

    expect(error.message).toContain('stackKey: app.yaml@ap-northeast-1');
    expect(error.message).toContain('region: ap-northeast-1');
    expect(error.message).toContain('cause: sdk failure');
    expect(error.publicMessage).toBe('AWS 操作失敗');
    expect(error.cause).toBe(cause);
  });

  it('internal: ステート永続化失敗は共通 StatePersistenceError で分類できる', () => {
    expect(new StatePersistenceError('save failed')).toBeInstanceOf(
      StatePersistenceError,
    );
  });
});
