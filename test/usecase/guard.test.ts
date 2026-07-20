/**
 * T-12 usecase/guard — AccountGuard のテスト(tasks.md §6 T-12 の対応表)。
 *
 * design.md §8.1 の 6 ステップ(1: 許可設定の存在 / 2: STS 解決+アカウント照合 /
 * 3: ロック取得後のステートアカウント照合 / 4: 許可リージョン照合 / 5: 接続先の
 * 出力先頭表示 / 6: 読み取り専用操作の対象外化)に対応する。
 *
 * ゲートウェイ(StsGateway / StateBackend)はいずれも自作のインメモリフェイクに
 * 差し替え、実 AWS には一切接続しない(§10)。各 describe/it の先頭に対応する
 * 受け入れ基準 ID を明記する。
 */

import { describe, expect, it } from 'vitest';
import type { CfnSyncConfig } from '../../src/core/config.js';
import { GuardError } from '../../src/core/errors.js';
import {
  type CfnSyncState,
  createInitialState,
  withAccountId,
} from '../../src/core/state.js';
import type {
  LockHandle,
  LockInfo,
  StateBackend,
  StateVersion,
  StsGateway,
} from '../../src/ports/index.js';
import { type DeployReport, renderText } from '../../src/report/index.js';
import {
  assertAccountAllowed,
  assertMutationAllowed,
  assertRegionsAllowed,
  connectionHeader,
  guardMutation,
  resolveConnection,
  verifyStateAccount,
} from '../../src/usecase/guard.js';

// ---------------------------------------------------------------------------
// インメモリフェイク
// ---------------------------------------------------------------------------

/** STS GetCallerIdentity のフェイク。呼び出し回数を記録する。 */
class FakeStsGateway implements StsGateway {
  calls = 0;
  constructor(
    private readonly resolveFn: () => Promise<{
      accountId: string;
      arn: string;
    }>,
  ) {}

  async getCallerIdentity(): Promise<{ accountId: string; arn: string }> {
    this.calls++;
    return this.resolveFn();
  }
}

/**
 * StateBackend のフェイク。実装は簡易 CAS(generation 比較)で、load/save の
 * 呼び出しを記録する(「拒否ケースで backend.save が一切発生しないこと」の検証用)。
 */
class FakeStateBackend implements StateBackend {
  private stored: { state: CfnSyncState; version: StateVersion } | undefined;
  loadCalls = 0;
  saveCalls: Array<{
    state: CfnSyncState;
    expected: StateVersion | undefined;
  }> = [];

  constructor(initial?: CfnSyncState) {
    if (initial) {
      this.stored = {
        state: initial,
        version: { generation: initial.generation },
      };
    }
  }

  async load(): Promise<
    { state: CfnSyncState; version: StateVersion } | undefined
  > {
    this.loadCalls++;
    return this.stored
      ? { state: this.stored.state, version: this.stored.version }
      : undefined;
  }

  async save(
    state: CfnSyncState,
    expected: StateVersion | undefined,
  ): Promise<StateVersion> {
    this.saveCalls.push({ state, expected });
    const currentGeneration = this.stored?.version.generation;
    const expectedGeneration = expected?.generation;
    if (expectedGeneration !== currentGeneration) {
      throw new Error('conflict (fake CAS)');
    }
    const newVersion: StateVersion = { generation: state.generation };
    this.stored = { state, version: newVersion };
    return newVersion;
  }

  async acquireLock(info: LockInfo): Promise<LockHandle> {
    return { runId: info.runId };
  }

  async verifyLock(): Promise<boolean> {
    return true;
  }

  async releaseLock(): Promise<{ released: boolean }> {
    return { released: true };
  }

  async readLock(): Promise<LockInfo | undefined> {
    return undefined;
  }

  async forceUnlock(): Promise<{ released: boolean }> {
    return { released: false };
  }

  stateId(): string {
    return 'fake-state-id';
  }
}

// ---------------------------------------------------------------------------
// テストデータのヘルパー
// ---------------------------------------------------------------------------

const REGION = 'ap-northeast-1';
const ACCOUNT = '123456789012';
const OTHER_ACCOUNT = '999999999999';

function baseConfig(overrides: Partial<CfnSyncConfig> = {}): CfnSyncConfig {
  return {
    version: 1,
    allowedAccounts: [ACCOUNT],
    allowedRegions: [REGION],
    defaultRegion: REGION,
    state: { backend: 'local' },
    stacks: {},
    ...overrides,
  };
}

function okSts(
  accountId = ACCOUNT,
  arn = `arn:aws:iam::${accountId}:role/deploy`,
): FakeStsGateway {
  return new FakeStsGateway(async () => ({ accountId, arn }));
}

// ===========================================================================
// FR-7-5: 許可設定はすべての変更系操作の前提(fail-closed)
// ===========================================================================

describe('FR-7-5: allowedAccounts / allowedRegions 未設定は変更系操作の前提条件違反', () => {
  it('FR-7-5: allowedAccounts 未設定 → GuardError', () => {
    const config = baseConfig({ allowedAccounts: undefined });
    expect(() => assertMutationAllowed(config)).toThrow(GuardError);
  });

  it('FR-7-5: allowedRegions 未設定 → GuardError', () => {
    const config = baseConfig({ allowedRegions: undefined });
    expect(() => assertMutationAllowed(config)).toThrow(GuardError);
  });

  it('FR-7-5: allowedAccounts が空配列(実質未指定)→ GuardError', () => {
    const config = baseConfig({ allowedAccounts: [] });
    expect(() => assertMutationAllowed(config)).toThrow(GuardError);
  });

  it('FR-7-5: allowedAccounts / allowedRegions がともに設定済みなら何も投げない', () => {
    expect(() => assertMutationAllowed(baseConfig())).not.toThrow();
  });

  it('FR-7-5: 変更セット作成前に必ず失敗する — guardMutation は STS・StateBackend に一切触れない', async () => {
    const config = baseConfig({ allowedAccounts: undefined });
    const sts = okSts();
    const backend = new FakeStateBackend();

    await expect(
      guardMutation({ config, sts, backend, targetRegions: [REGION] }),
    ).rejects.toBeInstanceOf(GuardError);

    expect(sts.calls).toBe(0);
    expect(backend.loadCalls).toBe(0);
    expect(backend.saveCalls).toHaveLength(0);
  });
});

// ===========================================================================
// FR-7-6: STS で解決し照合。未設定・不一致・解決不能はすべて拒否
// ===========================================================================

describe('FR-7-6: STS 解決結果の照合(不一致・解決不能は拒否)', () => {
  it('FR-7-6: 接続先アカウントが allowedAccounts に含まれない → GuardError', async () => {
    const config = baseConfig();
    const sts = okSts(OTHER_ACCOUNT);
    const connection = await resolveConnection(sts);
    expect(() => assertAccountAllowed(config, connection.accountId)).toThrow(
      GuardError,
    );
  });

  it('FR-7-6: 接続先アカウントが allowedAccounts に含まれる → 何も投げない', async () => {
    const config = baseConfig();
    const sts = okSts(ACCOUNT);
    const connection = await resolveConnection(sts);
    expect(() =>
      assertAccountAllowed(config, connection.accountId),
    ).not.toThrow();
  });

  it('FR-7-6: STS 解決失敗はそのまま伝播する(呼び出し側で fail-closed)', async () => {
    const failure = new Error(
      'The security token included in the request is invalid',
    );
    const sts = new FakeStsGateway(async () => {
      throw failure;
    });
    await expect(resolveConnection(sts)).rejects.toBe(failure);
  });

  it('FR-7-6: guardMutation はアカウント不一致で拒否し、AWS への変更呼び出し・backend.save が一切発生しない', async () => {
    const config = baseConfig();
    const sts = okSts(OTHER_ACCOUNT);
    const backend = new FakeStateBackend();

    await expect(
      guardMutation({ config, sts, backend, targetRegions: [REGION] }),
    ).rejects.toBeInstanceOf(GuardError);

    expect(sts.calls).toBe(1); // STS 自体は呼ばれるが、以降の状態照合・保存には進まない。
    expect(backend.loadCalls).toBe(0);
    expect(backend.saveCalls).toHaveLength(0);
  });

  it('FR-7-6: guardMutation は STS 解決失敗で拒否し、backend.save が一切発生しない', async () => {
    const config = baseConfig();
    const failure = new Error('network error resolving STS identity');
    const sts = new FakeStsGateway(async () => {
      throw failure;
    });
    const backend = new FakeStateBackend();

    await expect(
      guardMutation({ config, sts, backend, targetRegions: [REGION] }),
    ).rejects.toBe(failure);

    expect(backend.loadCalls).toBe(0);
    expect(backend.saveCalls).toHaveLength(0);
  });
});

// ===========================================================================
// FR-1-13: ステートのアカウント ID と接続先の一致を検証(ロック取得後の再読込)
// ===========================================================================

describe('FR-1-13: ステートアカウントの照合(ロック取得後に再読込した前提)', () => {
  it('FR-1-13: ステートの accountId が不一致 → GuardError、backend.save は呼ばれない', async () => {
    const existing = withAccountId(createInitialState(), OTHER_ACCOUNT);
    const backend = new FakeStateBackend(existing);

    await expect(
      verifyStateAccount({ backend, accountId: ACCOUNT }),
    ).rejects.toBeInstanceOf(GuardError);
    expect(backend.loadCalls).toBe(1);
    expect(backend.saveCalls).toHaveLength(0);
  });

  it('FR-1-13: 初回(未記録)→ 解決したアカウント ID が同一区間の CAS 保存で記録される', async () => {
    const backend = new FakeStateBackend(); // 未存在(初回実行)
    const result = await verifyStateAccount({ backend, accountId: ACCOUNT });

    expect(result.state.accountId).toBe(ACCOUNT);
    expect(backend.saveCalls).toHaveLength(1);
    // load 時点の version(未存在なので undefined)を expected として CAS 保存している。
    expect(backend.saveCalls[0].expected).toBeUndefined();
    expect(backend.saveCalls[0].state.accountId).toBe(ACCOUNT);
    expect(result.version).toEqual({ generation: 1 });
  });

  it('FR-1-13: ステートは存在するが accountId が null(未記録)の場合も同一区間の CAS 保存で記録される', async () => {
    const existing = createInitialState();
    const backend = new FakeStateBackend(existing);
    const result = await verifyStateAccount({ backend, accountId: ACCOUNT });

    expect(result.state.accountId).toBe(ACCOUNT);
    expect(backend.saveCalls).toHaveLength(1);
    expect(backend.saveCalls[0].expected).toEqual({ generation: 0 });
  });

  it('FR-1-13: 一致する場合はそのまま返し、backend.save は呼ばれない', async () => {
    const existing = withAccountId(createInitialState(), ACCOUNT);
    const backend = new FakeStateBackend(existing);
    const result = await verifyStateAccount({ backend, accountId: ACCOUNT });

    expect(result.state.accountId).toBe(ACCOUNT);
    expect(backend.saveCalls).toHaveLength(0);
  });

  it('FR-1-13: verifyStateAccount は毎回 backend.load() で再読込する(ロック取得前に読んだ内容を使い回さない)', async () => {
    const existing = withAccountId(createInitialState(), ACCOUNT);
    const backend = new FakeStateBackend(existing);
    await verifyStateAccount({ backend, accountId: ACCOUNT });
    expect(backend.loadCalls).toBe(1);
  });

  it('FR-1-13: guardMutation は許可設定・STS・リージョンをすべて通過した場合にステート照合まで到達する', async () => {
    const config = baseConfig();
    const sts = okSts(ACCOUNT);
    const backend = new FakeStateBackend(); // 初回

    const result = await guardMutation({
      config,
      sts,
      backend,
      targetRegions: [REGION],
    });

    expect(result.connection.accountId).toBe(ACCOUNT);
    expect(backend.saveCalls).toHaveLength(1); // 初回記録
  });
});

// ===========================================================================
// FR-13-8: 対象リージョンは許可リージョンに含まれる
// ===========================================================================

describe('FR-13-8: 対象リージョンの許可リージョン照合', () => {
  it('FR-13-8: allowedRegions に含まれないリージョンが対象に含まれる → GuardError', () => {
    const config = baseConfig({ allowedRegions: [REGION] });
    expect(() => assertRegionsAllowed(config, [REGION, 'us-east-1'])).toThrow(
      GuardError,
    );
  });

  it('FR-13-8: 対象リージョンがすべて allowedRegions に含まれる → 何も投げない', () => {
    const config = baseConfig({ allowedRegions: [REGION, 'us-east-1'] });
    expect(() =>
      assertRegionsAllowed(config, [REGION, 'us-east-1']),
    ).not.toThrow();
  });

  it('FR-13-8: guardMutation は許可されないリージョンで拒否し、ステート照合(backend.load)まで到達しない', async () => {
    const config = baseConfig({ allowedRegions: [REGION] });
    const sts = okSts(ACCOUNT);
    const backend = new FakeStateBackend();

    await expect(
      guardMutation({
        config,
        sts,
        backend,
        targetRegions: [REGION, 'us-east-1'],
      }),
    ).rejects.toBeInstanceOf(GuardError);

    expect(backend.loadCalls).toBe(0);
    expect(backend.saveCalls).toHaveLength(0);
  });
});

// ===========================================================================
// FR-7-7: 読み取り専用操作は許可設定なしで実行可(status / graph は AWS を呼ばない)
// ===========================================================================

describe('FR-7-7: 読み取り専用パスは変更系ガードを経由しない', () => {
  it('FR-7-7: resolveConnection は assertMutationAllowed を呼ばずに単体で動作する(読み取り専用操作に必要な最小限)', async () => {
    // status / graph が接続先表示(FR-7-8)のためだけに STS 解決を使う場合、
    // 変更系の前提条件(assertMutationAllowed)を経由する必要がないことの確認。
    const sts = okSts(ACCOUNT);
    const connection = await resolveConnection(sts);
    expect(connection).toEqual({
      accountId: ACCOUNT,
      arn: `arn:aws:iam::${ACCOUNT}:role/deploy`,
    });
    expect(sts.calls).toBe(1);
  });
});

// ===========================================================================
// FR-7-8: 解決した接続先をログ・JSON に含める(秘匿情報は含めない)
// ===========================================================================

describe('FR-7-8: 接続先情報の出力(秘匿情報は含めない)', () => {
  it('FR-7-8: connectionHeader はアカウント ID・リージョンを含む ConnectionInfo を返す', () => {
    const header = connectionHeader({
      accountId: ACCOUNT,
      regions: [REGION, 'us-east-1'],
    });
    expect(header).toEqual({
      accountId: ACCOUNT,
      regions: [REGION, 'us-east-1'],
    });
  });

  it('FR-7-8: STS 応答に紛れ込んだ秘匿情報(余剰フィールド)は resolveConnection の戻り値に含まれない', async () => {
    const leaky = new FakeStsGateway(async () => ({
      accountId: ACCOUNT,
      arn: `arn:aws:iam::${ACCOUNT}:role/deploy`,
      // フェイクが誤って秘匿情報を返してしまった想定(型としては StsGateway が要求しない余剰フィールド)。
      ...({ secretAccessKey: 'FAKE-SECRET-DO-NOT-LEAK' } as Record<
        string,
        unknown
      >),
    }));

    const connection = await resolveConnection(leaky);
    expect(Object.keys(connection).sort()).toEqual(['accountId', 'arn']);
    expect(JSON.stringify(connection)).not.toContain('FAKE-SECRET-DO-NOT-LEAK');
  });

  it('FR-7-8: guardMutation の結果を renderText に通しても、アカウント ID・リージョンは出力されクレデンシャル文字列は出力されない', async () => {
    const config = baseConfig();
    const secret = 'FAKE-SECRET-DO-NOT-LEAK';
    const leaky = new FakeStsGateway(async () => ({
      accountId: ACCOUNT,
      arn: `arn:aws:iam::${ACCOUNT}:role/deploy`,
      ...({ secretAccessKey: secret } as Record<string, unknown>),
    }));
    const backend = new FakeStateBackend();

    const result = await guardMutation({
      config,
      sts: leaky,
      backend,
      targetRegions: [REGION],
    });

    const report: DeployReport = { connection: result.connection, diffs: [] };
    const text = renderText(report);
    const json = JSON.stringify(result.connection);

    expect(text).toContain(ACCOUNT);
    expect(text).toContain(REGION);
    expect(text).not.toContain(secret);
    expect(json).not.toContain(secret);
  });
});
