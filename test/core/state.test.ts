import { describe, expect, it } from 'vitest';
import { StateCorruptionError } from '../../src/core/errors.js';
import {
  type CfnSyncState,
  createInitialState,
  matchAccount,
  parseState,
  prepareSave,
  removeStackEntry,
  type StackEntry,
  serializeState,
  sha256Hex,
  upsertStackEntry,
  withAccountId,
} from '../../src/core/state.js';

// design.md §4.3 のステート例そのままの妥当な JSON。
const validStateJson = JSON.stringify({
  schemaVersion: 2,
  accountId: '123456789012',
  generation: 42,
  stacks: {
    'network.yaml@ap-northeast-1': {
      stackName: 'prod-network',
      stackId:
        'arn:aws:cloudformation:ap-northeast-1:123456789012:stack/prod-network/id',
      region: 'ap-northeast-1',
      templateHash: 'sha256:abc',
      inputsHash: 'sha256:def',
      exports: ['prod-network-VpcId'],
      imports: [],
      dependsOn: [],
      dependencyAnalysisIncomplete: false,
      lastAction: 'UPDATE',
      lastSuccessAt: '2026-07-19T00:00:00Z',
    },
  },
});

function makeEntry(overrides: Partial<StackEntry> = {}): StackEntry {
  return {
    stackName: 'prod-network',
    stackId:
      'arn:aws:cloudformation:ap-northeast-1:123456789012:stack/prod-network/id',
    region: 'ap-northeast-1',
    templateHash: 'sha256:abc',
    inputsHash: 'sha256:def',
    exports: ['prod-network-VpcId'],
    imports: ['other-Export'],
    dependsOn: [],
    dependencyAnalysisIncomplete: false,
    lastAction: 'UPDATE',
    lastSuccessAt: '2026-07-19T00:00:00Z',
    ...overrides,
  };
}

describe('core/state — §4.3 ステートスキーマ', () => {
  it('§4.3: design.md §4.3 の形をそのまま受理する', () => {
    const state = parseState(validStateJson);
    expect(state.schemaVersion).toBe(2);
    expect(state.accountId).toBe('123456789012');
    expect(state.generation).toBe(42);
    expect(state.stacks['network.yaml@ap-northeast-1']).toEqual({
      stackName: 'prod-network',
      stackId:
        'arn:aws:cloudformation:ap-northeast-1:123456789012:stack/prod-network/id',
      region: 'ap-northeast-1',
      templateHash: 'sha256:abc',
      inputsHash: 'sha256:def',
      exports: ['prod-network-VpcId'],
      imports: [],
      dependsOn: [],
      dependencyAnalysisIncomplete: false,
      lastAction: 'UPDATE',
      lastSuccessAt: '2026-07-19T00:00:00Z',
    });
  });

  it('§4.3: 必須トップレベル項目(generation)の欠落を拒否する', () => {
    const missingGeneration = JSON.stringify({
      schemaVersion: 2,
      accountId: null,
      stacks: {},
    });
    expect(() => parseState(missingGeneration)).toThrow(StateCorruptionError);
  });

  it('§4.3: スタックエントリの必須項目(exports)欠落を拒否する', () => {
    const missingExports = JSON.stringify({
      schemaVersion: 1,
      accountId: null,
      generation: 0,
      stacks: {
        'network.yaml@ap-northeast-1': {
          stackName: 'prod-network',
          region: 'ap-northeast-1',
          templateHash: 'sha256:abc',
          inputsHash: 'sha256:def',
          imports: [],
          lastAction: 'UPDATE',
          lastSuccessAt: '2026-07-19T00:00:00Z',
        },
      },
    });
    expect(() => parseState(missingExports)).toThrow(StateCorruptionError);
  });

  it('§4.3: 不正な schemaVersion(3 等)を拒否する', () => {
    const wrongVersion = JSON.stringify({
      schemaVersion: 3,
      accountId: null,
      generation: 0,
      stacks: {},
    });
    expect(() => parseState(wrongVersion)).toThrow(StateCorruptionError);
  });

  it('§4.3(再レビュー⑥): v1 dependsOn 欠落を unknown(null)へ移行し、次回保存は v2 に正規化する', () => {
    const migrated = parseState(
      JSON.stringify({
        schemaVersion: 1,
        accountId: '123456789012',
        generation: 7,
        stacks: {
          'legacy.yaml@ap-northeast-1': {
            stackName: 'legacy',
            region: 'ap-northeast-1',
            templateHash: 'sha256:legacy',
            inputsHash: 'sha256:legacy-inputs',
            exports: [],
            imports: [],
            lastAction: 'UPDATE',
            lastSuccessAt: '2026-07-19T00:00:00Z',
          },
        },
      }),
    );

    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.stacks['legacy.yaml@ap-northeast-1'].dependsOn).toBeNull();
    expect(migrated.stacks['legacy.yaml@ap-northeast-1'].stackId).toBeNull();
    expect(JSON.parse(serializeState(migrated)).schemaVersion).toBe(2);
  });

  it('§4.3: serializeState → parseState のラウンドトリップで内容が保持される', () => {
    const state = parseState(validStateJson);
    const roundTripped = parseState(serializeState(state));
    expect(roundTripped).toEqual(state);
  });

  it('§4.3: serializeState は安定した(スタックキー順が固定な)整形 JSON を返す', () => {
    const base = createInitialState();
    const stateA = upsertStackEntry(
      upsertStackEntry(
        base,
        'b.yaml@ap-northeast-1',
        makeEntry({ stackName: 'b' }),
      ),
      'a.yaml@ap-northeast-1',
      makeEntry({ stackName: 'a' }),
    );
    const stateB = upsertStackEntry(
      upsertStackEntry(
        base,
        'a.yaml@ap-northeast-1',
        makeEntry({ stackName: 'a' }),
      ),
      'b.yaml@ap-northeast-1',
      makeEntry({ stackName: 'b' }),
    );
    expect(serializeState(stateA)).toBe(serializeState(stateB));
  });
});

describe('core/state — FR-1-6(判定): 世代管理', () => {
  it('FR-1-6: prepareSave は generation をインクリメントする', () => {
    const state: CfnSyncState = { ...createInitialState(), generation: 5 };
    const saved = prepareSave(state);
    expect(saved.generation).toBe(6);
  });

  it('FR-1-6: prepareSave は元のステートを変更しない(イミュータブル)', () => {
    const state: CfnSyncState = { ...createInitialState(), generation: 5 };
    prepareSave(state);
    expect(state.generation).toBe(5);
  });
});

describe('core/state — FR-1-12(検出): 破損検出は fail-closed', () => {
  it('FR-1-12: 不完全な JSON(構文エラー)は StateCorruptionError になる', () => {
    const truncated =
      '{ "schemaVersion": 1, "accountId": null, "generation": 0, "stacks": {';
    expect(() => parseState(truncated)).toThrow(StateCorruptionError);
  });

  it('FR-1-12: スキーマ不一致(generation が文字列)は StateCorruptionError になる', () => {
    const wrongType = JSON.stringify({
      schemaVersion: 1,
      accountId: null,
      generation: 'not-a-number',
      stacks: {},
    });
    expect(() => parseState(wrongType)).toThrow(StateCorruptionError);
  });

  it('FR-1-12: StateCorruptionError は CfnSyncError を継承する(fail-closed のエラー分類に載る)', () => {
    try {
      parseState('not json');
      expect.unreachable('parseState は例外を投げるはず');
    } catch (err) {
      expect(err).toBeInstanceOf(StateCorruptionError);
      expect((err as Error).name).toBe('StateCorruptionError');
    }
  });
});

describe('core/state — FR-1-13(前半): アカウント照合', () => {
  it('FR-1-13: accountId が null(未記録)の場合は unrecorded', () => {
    const state = createInitialState();
    expect(matchAccount(state, '123456789012')).toBe('unrecorded');
  });

  it('FR-1-13: accountId が一致する場合は match', () => {
    const state = withAccountId(createInitialState(), '123456789012');
    expect(matchAccount(state, '123456789012')).toBe('match');
  });

  it('FR-1-13: accountId が不一致の場合は mismatch', () => {
    const state = withAccountId(createInitialState(), '123456789012');
    expect(matchAccount(state, '999999999999')).toBe('mismatch');
  });

  it('FR-1-13: withAccountId は元のステートを変更せず新しいステートを返す', () => {
    const original = createInitialState();
    const recorded = withAccountId(original, '123456789012');
    expect(original.accountId).toBeNull();
    expect(recorded.accountId).toBe('123456789012');
  });
});

describe('core/state — FR-1-15: ステート未存在(初回)の扱い', () => {
  it('FR-1-15: createInitialState は accountId: null / generation: 0 / stacks: {} の空ステートを返す', () => {
    const state = createInitialState();
    expect(state).toEqual({
      schemaVersion: 2,
      accountId: null,
      generation: 0,
      stacks: {},
    });
  });

  it('FR-1-15: createInitialState の stacks は空であり、キーを 1 つも持たない(detect が全件 added にできる前段)', () => {
    const state = createInitialState();
    expect(Object.keys(state.stacks)).toHaveLength(0);
  });

  it('FR-1-15: createInitialState は呼び出しごとに独立したオブジェクトを返す', () => {
    const a = createInitialState();
    const b = upsertStackEntry(a, 'x.yaml@ap-northeast-1', makeEntry());
    expect(Object.keys(a.stacks)).toHaveLength(0);
    expect(Object.keys(b.stacks)).toHaveLength(1);
  });
});

describe('core/state — FR-8-5(記録): 依存辺(exports/imports)の記録', () => {
  it('FR-8-5: upsertStackEntry は exports / imports を含むエントリを記録する', () => {
    const state = createInitialState();
    const entry = makeEntry({
      exports: ['A-VpcId', 'A-SubnetId'],
      imports: ['B-Export'],
    });
    const updated = upsertStackEntry(state, 'a.yaml@ap-northeast-1', entry);
    expect(updated.stacks['a.yaml@ap-northeast-1'].exports).toEqual([
      'A-VpcId',
      'A-SubnetId',
    ]);
    expect(updated.stacks['a.yaml@ap-northeast-1'].imports).toEqual([
      'B-Export',
    ]);
  });

  it('FR-8-5: upsertStackEntry は元のステートを変更しない(イミュータブル)', () => {
    const state = createInitialState();
    const entry = makeEntry();
    const updated = upsertStackEntry(state, 'a.yaml@ap-northeast-1', entry);
    expect(state.stacks['a.yaml@ap-northeast-1']).toBeUndefined();
    expect(updated.stacks['a.yaml@ap-northeast-1']).toBeDefined();
  });

  it('FR-8-5: upsertStackEntry は既存エントリを上書きし、他のエントリには影響しない', () => {
    const state = upsertStackEntry(
      createInitialState(),
      'a.yaml@ap-northeast-1',
      makeEntry({ exports: ['old'] }),
    );
    const withB = upsertStackEntry(
      state,
      'b.yaml@ap-northeast-1',
      makeEntry({ exports: ['b-export'] }),
    );
    const updated = upsertStackEntry(
      withB,
      'a.yaml@ap-northeast-1',
      makeEntry({ exports: ['new'] }),
    );
    expect(updated.stacks['a.yaml@ap-northeast-1'].exports).toEqual(['new']);
    expect(updated.stacks['b.yaml@ap-northeast-1'].exports).toEqual([
      'b-export',
    ]);
  });

  it('FR-8-5: removeStackEntry はスタックエントリをステートから除去する(イミュータブル)', () => {
    const state = upsertStackEntry(
      createInitialState(),
      'a.yaml@ap-northeast-1',
      makeEntry(),
    );
    const removed = removeStackEntry(state, 'a.yaml@ap-northeast-1');
    expect(removed.stacks['a.yaml@ap-northeast-1']).toBeUndefined();
    expect(state.stacks['a.yaml@ap-northeast-1']).toBeDefined();
  });

  it('FR-8-5: removeStackEntry は存在しないキーを渡しても例外を投げない', () => {
    const state = createInitialState();
    expect(() =>
      removeStackEntry(state, 'missing.yaml@ap-northeast-1'),
    ).not.toThrow();
  });
});

describe('core/state — sha256Hex ユーティリティ(§4.3 の templateHash/inputsHash 表記)', () => {
  it('internal: sha256Hex は "sha256:<64桁hex>" 形式を返す', () => {
    const hash = sha256Hex('hello world');
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('internal: sha256Hex は同一入力に対して決定的である', () => {
    expect(sha256Hex('same input')).toBe(sha256Hex('same input'));
  });

  it('internal: sha256Hex は異なる入力に対して異なるハッシュを返す', () => {
    expect(sha256Hex('input-a')).not.toBe(sha256Hex('input-b'));
  });
});
