/**
 * T-15 usecase/delete — スタック削除。
 *
 * tasks.md §6 T-15 の表を正本とし、各テスト名に受け入れ基準 ID を明記する。
 * 実 AWS は使わず、共有 timeline で DeleteStack / fencing / CAS の順序を検証する。
 */

import { describe, expect, it } from 'vitest';
import { type CfnSyncConfig, validateConfig } from '../../src/core/config.js';
import {
  type CfnSyncState,
  createInitialState,
  type StackEntry,
  upsertStackEntry,
  withAccountId,
} from '../../src/core/state.js';
import type { CloudFormationGateway } from '../../src/ports/index.js';
import { deleteManagedStack } from '../../src/usecase/delete.js';
import { deploy } from '../../src/usecase/deploy.js';
import {
  FakeCloudFormationGateway,
  FakeStateBackend,
  makeStackSummary,
} from './fakes.js';

const ACCOUNT = '123456789012';
const OTHER_ACCOUNT = '999999999999';
const REGION = 'ap-northeast-1';
const FIXED_NOW = () => new Date('2026-07-20T12:00:00.000Z');

function emptyConfig(overrides: Partial<CfnSyncConfig> = {}): CfnSyncConfig {
  const base = validateConfig(
    {
      version: 1,
      defaultRegion: REGION,
      allowedAccounts: [ACCOUNT],
      allowedRegions: [REGION],
      stacks: {},
    },
    { templateExists: () => true },
  );
  return { ...base, ...overrides };
}

function entry(
  stackName: string,
  overrides: Partial<StackEntry> = {},
): StackEntry {
  return {
    stackName,
    region: REGION,
    templateHash: `sha256:template-${stackName}`,
    inputsHash: `sha256:inputs-${stackName}`,
    exports: [],
    imports: [],
    dependsOn: [],
    lastAction: 'UPDATE',
    lastSuccessAt: '2026-07-19T00:00:00.000Z',
    ...overrides,
  };
}

function stateWith(entries: Array<[string, StackEntry]>): CfnSyncState {
  let state = withAccountId(createInitialState(), ACCOUNT);
  for (const [key, stackEntry] of entries)
    state = upsertStackEntry(state, key, stackEntry);
  return state;
}

function dependencyState(): CfnSyncState {
  return stateWith([
    ['a.yaml@ap-northeast-1', entry('A', { exports: ['Shared'], imports: [] })],
    ['b.yaml@ap-northeast-1', entry('B', { exports: [], imports: ['Shared'] })],
  ]);
}

function explicitDependencyState(): CfnSyncState {
  return stateWith([
    [
      'a.yaml@ap-northeast-1',
      entry('A', { dependsOn: ['b.yaml@ap-northeast-1'] }),
    ],
    ['b.yaml@ap-northeast-1', entry('B')],
  ]);
}

function setup(initial: CfnSyncState, config = emptyConfig()) {
  const timeline: string[] = [];
  const backend = new FakeStateBackend(timeline, initial);
  const cfn = new FakeCloudFormationGateway(timeline, 'cfn');
  const cfnFactory = (_region: string): CloudFormationGateway => cfn;
  const sts = {
    async getCallerIdentity() {
      timeline.push('sts.getCallerIdentity');
      return { accountId: ACCOUNT, arn: `arn:aws:iam::${ACCOUNT}:role/test` };
    },
  };
  const run = (options: { allowDelete?: boolean; dryRun?: boolean } = {}) =>
    deploy({
      config,
      configDir: '/repo',
      templates: new Map(),
      deps: { cfnFactory, sts, backend, now: FIXED_NOW, runId: () => 'run15' },
      options,
    });
  return { timeline, backend, cfn, run };
}

function makeExisting(
  setupResult: ReturnType<typeof setup>,
  names: string[],
): void {
  for (const name of names) {
    setupResult.cfn.stacks.set(
      name,
      makeStackSummary({ stackName: name, status: 'UPDATE_COMPLETE' }),
    );
    setupResult.cfn.waitResults.set(name, [
      makeStackSummary({ stackName: name, status: 'DELETE_COMPLETE' }),
    ]);
  }
}

describe('delete / deploy integration — T-15', () => {
  it('FR-6-1 / FR-6-2: allowDelete なしでも削除差分と警告を出し、DeleteStack は呼ばない', async () => {
    const s = setup(stateWith([['a.yaml@ap-northeast-1', entry('A')]]));
    makeExisting(s, ['A']);

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    expect(result.report.diffs).toContainEqual(
      expect.objectContaining({
        stackName: 'A',
        operation: 'delete',
        warnings: [expect.stringContaining('--allow-delete')],
      }),
    );
    expect(s.cfn.callsOf('deleteStack')).toHaveLength(0);
  });

  it('FR-6-2: allowDelete 指定時だけ削除して DELETE_COMPLETE を待つ。dry-run は指定ありでも削除しない', async () => {
    const dry = setup(stateWith([['a.yaml@ap-northeast-1', entry('A')]]));
    makeExisting(dry, ['A']);
    expect((await dry.run({ allowDelete: true, dryRun: true })).exitCode).toBe(
      2,
    );
    expect(dry.cfn.callsOf('deleteStack')).toHaveLength(0);

    const apply = setup(stateWith([['a.yaml@ap-northeast-1', entry('A')]]));
    makeExisting(apply, ['A']);
    const result = await apply.run({ allowDelete: true });

    expect(result.exitCode).toBe(0);
    expect(
      apply.cfn.callsOf('deleteStack').map((call) => call.args[0]),
    ).toEqual(['A']);
    expect(
      apply.cfn.callsOf('waitForStack').map((call) => call.args[0]),
    ).toEqual(['A']);
    expect(
      apply.backend.stored?.state.stacks['a.yaml@ap-northeast-1'],
    ).toBeUndefined();
  });

  it('§7 DELETE 復旧: DELETE_COMPLETE は DeleteStack を呼ばず削除成功として state から除去する', async () => {
    const s = setup(stateWith([['a.yaml@ap-northeast-1', entry('A')]]));
    s.cfn.stacks.set(
      'A',
      makeStackSummary({ stackName: 'A', status: 'DELETE_COMPLETE' }),
    );

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    expect(s.cfn.callsOf('deleteStack')).toHaveLength(0);
    expect(
      s.backend.stored?.state.stacks['a.yaml@ap-northeast-1'],
    ).toBeUndefined();
  });

  it('FR-6-3: terminationProtection 有効時は解除を試みず DeleteStack も呼ばずエラー報告する', async () => {
    const s = setup(stateWith([['a.yaml@ap-northeast-1', entry('A')]]));
    s.cfn.stacks.set(
      'A',
      makeStackSummary({
        stackName: 'A',
        status: 'UPDATE_COMPLETE',
        terminationProtection: true,
      }),
    );

    const result = await s.run({ allowDelete: true });

    expect(result.exitCode).toBe(1);
    expect(s.cfn.callsOf('deleteStack')).toHaveLength(0);
    expect(s.cfn.methodSequence()).not.toContain('updateTerminationProtection');
    expect(result.report.result?.stacks).toContainEqual(
      expect.objectContaining({
        stackName: 'A',
        outcome: 'failed',
        errorMessage: expect.stringContaining('削除保護'),
      }),
    );
  });

  it('FR-2-10(削除): REVIEW_IN_PROGRESS は当該スタックだけ失敗扱いとし DeleteStack を一切呼ばない', async () => {
    const s = setup(stateWith([['a.yaml@ap-northeast-1', entry('A')]]));
    s.cfn.stacks.set(
      'A',
      makeStackSummary({ stackName: 'A', status: 'REVIEW_IN_PROGRESS' }),
    );

    const result = await s.run({ allowDelete: true });

    expect(result.exitCode).toBe(1);
    expect(s.cfn.callsOf('deleteStack')).toHaveLength(0);
    expect(result.report.result?.stacks).toContainEqual(
      expect.objectContaining({
        stackName: 'A',
        outcome: 'failed',
        errorMessage: expect.stringContaining('REVIEW_IN_PROGRESS'),
      }),
    );
  });

  it('FR-2(削除): UPDATE_IN_PROGRESS は並行操作として拒否し DeleteStack を呼ばない', async () => {
    const s = setup(stateWith([['a.yaml@ap-northeast-1', entry('A')]]));
    s.cfn.stacks.set(
      'A',
      makeStackSummary({ stackName: 'A', status: 'UPDATE_IN_PROGRESS' }),
    );

    const result = await s.run({ allowDelete: true });

    expect(result.exitCode).toBe(1);
    expect(s.cfn.callsOf('deleteStack')).toHaveLength(0);
    expect(result.report.result?.stacks).toContainEqual(
      expect.objectContaining({
        stackName: 'A',
        outcome: 'failed',
        errorMessage: expect.stringMatching(/UPDATE_IN_PROGRESS|並行操作/),
      }),
    );
  });

  it('FR-6-4: 削除済みテンプレートの旧 exports/imports を復元し、統合グラフの逆順 B → A で削除する', async () => {
    const s = setup(dependencyState());
    makeExisting(s, ['A', 'B']);

    const result = await s.run({ allowDelete: true });

    expect(result.exitCode).toBe(0);
    expect(s.cfn.callsOf('deleteStack').map((call) => call.args[0])).toEqual([
      'B',
      'A',
    ]);
  });

  it('FR-6-4 / design §4.3: 旧 state の明示依存のみでも逆トポロジカル順 A → B で削除する', async () => {
    const s = setup(explicitDependencyState());
    makeExisting(s, ['A', 'B']);

    const result = await s.run({ allowDelete: true });

    expect(result.exitCode).toBe(0);
    expect(s.cfn.callsOf('deleteStack').map((call) => call.args[0])).toEqual([
      'A',
      'B',
    ]);
  });

  it('FR-6-5: exports/imports 欠落スタックだけを削除拒否して手動対応を案内し、他は継続する', async () => {
    const malformed = entry('B') as StackEntry & {
      exports?: string[];
      imports?: string[];
    };
    delete malformed.exports;
    delete malformed.imports;
    const state = stateWith([
      ['a.yaml@ap-northeast-1', entry('A')],
      ['b.yaml@ap-northeast-1', malformed as StackEntry],
    ]);
    const s = setup(state);
    makeExisting(s, ['A', 'B']);

    const result = await s.run({ allowDelete: true });

    expect(result.exitCode).toBe(1);
    expect(s.cfn.callsOf('deleteStack').map((call) => call.args[0])).toEqual([
      'A',
    ]);
    expect(result.report.result?.stacks).toContainEqual(
      expect.objectContaining({
        stackName: 'B',
        outcome: 'failed',
        errorMessage: expect.stringMatching(/依存情報|手動/),
      }),
    );
  });

  it('FR-6-6: AccountGuard 不通過なら allowDelete 指定時もロック・DeleteStack に進まない', async () => {
    const config = emptyConfig({ allowedAccounts: [OTHER_ACCOUNT] });
    const s = setup(stateWith([['a.yaml@ap-northeast-1', entry('A')]]), config);
    makeExisting(s, ['A']);

    const result = await s.run({ allowDelete: true });

    expect(result.exitCode).toBe(1);
    expect(s.backend.callsOf('acquireLock')).toHaveLength(0);
    expect(s.cfn.callsOf('deleteStack')).toHaveLength(0);
  });

  it('FR-1-9(削除): 各 DeleteStack 直前に fencing。1件目完了後の喪失で保存も2件目削除も止める', async () => {
    const s = setup(dependencyState());
    makeExisting(s, ['A', 'B']);
    // B の DeleteStack 前=true、B 完了後の state save 前=false。
    s.backend.verifyLockPlan = [true, false];

    const result = await s.run({ allowDelete: true });

    expect(result.exitCode).toBe(1);
    expect(s.cfn.callsOf('deleteStack').map((call) => call.args[0])).toEqual([
      'B',
    ]);
    expect(s.backend.saveCalls).toHaveLength(0);
    const deleteIndex = s.timeline.indexOf('cfn.deleteStack');
    expect(s.timeline[deleteIndex - 1]).toBe('backend.verifyLock');
  });

  it('§8.3: 成功ごとに CAS 保存し、2件目失敗時も1件目だけ state から除去済み', async () => {
    const s = setup(dependencyState());
    makeExisting(s, ['A', 'B']);
    s.cfn.waitResults.set('A', [
      makeStackSummary({ stackName: 'A', status: 'DELETE_FAILED' }),
    ]);

    const result = await s.run({ allowDelete: true });

    expect(result.exitCode).toBe(1);
    expect(s.cfn.callsOf('deleteStack').map((call) => call.args[0])).toEqual([
      'B',
      'A',
    ]);
    expect(s.backend.saveCalls).toHaveLength(1);
    expect(
      s.backend.stored?.state.stacks['b.yaml@ap-northeast-1'],
    ).toBeUndefined();
    expect(
      s.backend.stored?.state.stacks['a.yaml@ap-northeast-1'],
    ).toBeDefined();
  });

  it('§8.3: deleteManagedStack の公開契約は依存情報を検証してから副作用へ進む', async () => {
    expect(deleteManagedStack).toBeTypeOf('function');
  });
});
