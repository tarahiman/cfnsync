/**
 * Issue #16 — stackName リネームで旧スタックが state から脱落する不具合の回帰テスト。
 *
 * requirements.md FR-1-16〜FR-1-22 / FR-5-5b7 / FR-5-18e / FR-6-7〜FR-6-11、
 * design.md §4.3 / §4.4 / §5.3 / §7 / §8.3、[ADR-0003](docs/decisions/0003-pending-stack-deletions.md)。
 *
 * 検証の要点:
 * - Issue の再現手順そのもの(`--allow-delete` なしでリネーム → 次回実行で旧名がまだ削除候補に出る)
 * - 削除待ちの記録・除去がいずれも単一の compare-and-swap で行われること
 * - 削除待ちの削除が通常の削除とまったく同じ安全装置を通ること
 */

import { describe, expect, it } from 'vitest';
import {
  type CfnSyncConfig,
  resolveTargets,
  validateConfig,
} from '../../src/core/config.js';
import { resolveDependsOnKey } from '../../src/core/dependency.js';
import {
  computeInputsHash,
  computeTemplateHash,
} from '../../src/core/detect.js';
import { StateConflictError } from '../../src/core/errors.js';
import {
  type CfnSyncState,
  createInitialState,
  type PendingDeletionEntry,
  upsertPendingDeletion,
  upsertStackEntry,
  withAccountId,
} from '../../src/core/state.js';
import { analyzeTemplate } from '../../src/core/template.js';
import type { CloudFormationGateway } from '../../src/ports/index.js';
import { type ApprovalRequest, renderJson } from '../../src/report/index.js';
import { deploy } from '../../src/usecase/deploy.js';
import { MANAGEMENT_TAG_KEY } from '../../src/usecase/executor.js';
import { getStatus } from '../../src/usecase/status.js';
import {
  FakeCloudFormationGateway,
  FakeStateBackend,
  makeStackSummary,
} from './fakes.js';

const ACCOUNT = '123456789012';
const REGION = 'ap-northeast-1';
const STATE_ID = 'aabbccddeeff';
const FIXED_NOW = () => new Date('2026-07-20T12:00:00.000Z');
const PENDING_OLD = `Old@${REGION}`;
const PENDING_OLD_KEY = `cfnsync:pending/Old@${REGION}`;

const TEMPLATE = `
AWSTemplateFormatVersion: '2010-09-09'
Resources:
  Bucket:
    Type: AWS::S3::Bucket
`;

function configOf(stacks: Record<string, unknown>): CfnSyncConfig {
  return validateConfig({
    version: 1,
    defaultRegion: REGION,
    allowedAccounts: [ACCOUNT],
    allowedRegions: [REGION],
    stacks,
  });
}

function stackIdOf(stackName: string): string {
  return `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${stackName}/managed`;
}

/** 設定どおりに「デプロイ済み」として記録した state。 */
function recordedState(
  config: CfnSyncConfig,
  templates: Map<string, string>,
): CfnSyncState {
  let state = withAccountId(createInitialState(), ACCOUNT);
  for (const target of resolveTargets(config)) {
    const source = templates.get(target.templatePath);
    if (source === undefined)
      throw new Error(`missing test template: ${target.templatePath}`);
    const analysis = analyzeTemplate(source, {
      stackName: target.stackName,
      region: target.region,
      parameters: target.parameters,
    });
    const templateHash = computeTemplateHash(source);
    state = upsertStackEntry(state, target.stackKey, {
      stackName: target.stackName,
      stackId: stackIdOf(target.stackName),
      region: target.region,
      templateHash,
      inputsHash: computeInputsHash({
        templateHash,
        stackName: target.stackName,
        parameters: target.parameters,
        tags: target.tags,
        capabilities: target.capabilities,
        dependsOn: target.dependsOn,
      }),
      exports: analysis.exports,
      imports: analysis.imports,
      dependsOn: target.dependsOn.map((raw) =>
        resolveDependsOnKey(raw, target.region),
      ),
      dependencyAnalysisIncomplete: false,
      lastAction: 'UPDATE',
      lastSuccessAt: '2026-07-19T00:00:00.000Z',
    });
  }
  return state;
}

function makePending(
  overrides: Partial<PendingDeletionEntry> = {},
): PendingDeletionEntry {
  const stackName = overrides.stackName ?? 'Old';
  return {
    stackName,
    stackId: stackIdOf(stackName),
    region: REGION,
    exports: [],
    imports: [],
    dependsOn: [],
    dependencyAnalysisIncomplete: false,
    originStackKey: `a.yaml@${REGION}`,
    reason: 'rename',
    recordedAt: '2026-07-19T00:00:00.000Z',
    ...overrides,
  };
}

function setup(
  config: CfnSyncConfig,
  templates: Map<string, string>,
  state?: CfnSyncState,
) {
  const timeline: string[] = [];
  const backend = new FakeStateBackend(timeline, state, STATE_ID);
  const cfn = new FakeCloudFormationGateway(timeline, 'cfn');
  cfn.strictStackExistence = true;
  const cfnFactory = (_region: string): CloudFormationGateway => cfn;
  const sts = {
    async getCallerIdentity() {
      timeline.push('sts.getCallerIdentity');
      return { accountId: ACCOUNT, arn: `arn:aws:iam::${ACCOUNT}:role/test` };
    },
  };
  const approvals: ApprovalRequest[] = [];
  const control = { decision: true };
  const run = (
    options: {
      allowDelete?: boolean;
      dryRun?: boolean;
      onFailure?: 'stop' | 'continue';
      autoApprove?: boolean;
    } = {},
  ) =>
    deploy({
      config,
      templates,
      deps: {
        cfnFactory,
        sts,
        backend,
        now: FIXED_NOW,
        runId: () => 'run16',
        approve: async (request) => {
          approvals.push(request);
          return control.decision;
        },
      },
      options: { autoApprove: true, ...options },
    });
  return { timeline, backend, cfn, cfnFactory, approvals, control, run };
}

/** 既に存在する物理スタックを fake へ登録する。 */
function existingStack(
  cfn: FakeCloudFormationGateway,
  stackName: string,
  overrides: Parameters<typeof makeStackSummary>[0] = {
    status: 'CREATE_COMPLETE',
  },
): void {
  cfn.stacks.set(
    stackName,
    makeStackSummary({
      stackName,
      stackId: stackIdOf(stackName),
      status: 'CREATE_COMPLETE',
      ...overrides,
    }),
  );
  cfn.waitResults.set(stackName, [
    makeStackSummary({ stackName, status: 'DELETE_COMPLETE' }),
  ]);
}

// ===========================================================================
// Issue #16 の再現手順そのものの回帰テスト
// ===========================================================================

describe('usecase/deploy — Issue #16 再現手順の回帰(FR-1-18 / FR-1-19)', () => {
  const oldConfig = configOf({ 'a.yaml': { stackName: 'Old' } });
  const newConfig = configOf({ 'a.yaml': { stackName: 'New' } });
  const templates = new Map([['a.yaml', TEMPLATE]]);

  it('FR-1-18 / FR-1-19(Issue #16): --allow-delete なしでリネームすると、旧スタックが削除待ちとして state に残る', async () => {
    const s = setup(newConfig, templates, recordedState(oldConfig, templates));
    existingStack(s.cfn, 'Old');

    const result = await s.run();

    // 新スタックの作成は成功する。
    expect(result.exitCode).toBe(0);
    expect(s.cfn.callsOf('executeChangeSet')).toHaveLength(1);
    // 旧スタックは削除されない(--allow-delete なし)。
    expect(s.cfn.callsOf('deleteStack')).toHaveLength(0);

    const stored = s.backend.stored?.state as CfnSyncState;
    expect(stored.stacks[`a.yaml@${REGION}`].stackName).toBe('New');
    // 旧スタック名は state から脱落せず、削除待ちとして残る。
    expect(stored.pendingDeletions[PENDING_OLD]).toEqual(
      expect.objectContaining({
        stackName: 'Old',
        stackId: stackIdOf('Old'),
        region: REGION,
        originStackKey: `a.yaml@${REGION}`,
        reason: 'rename',
      }),
    );
  });

  it('FR-1-18(Issue #16): 新エントリの保存と削除待ちの記録は単一の compare-and-swap で行われる', async () => {
    const s = setup(newConfig, templates, recordedState(oldConfig, templates));
    existingStack(s.cfn, 'Old');

    await s.run();

    // 「新名を保存したが削除待ちがない」中間状態を一度も永続化しない。
    for (const call of s.backend.saveCalls) {
      const saved = call.state;
      if (saved.stacks[`a.yaml@${REGION}`]?.stackName !== 'New') continue;
      expect(saved.pendingDeletions[PENDING_OLD]).toBeDefined();
    }
    const renameSaves = s.backend.saveCalls.filter(
      (call) => call.state.stacks[`a.yaml@${REGION}`]?.stackName === 'New',
    );
    expect(renameSaves).toHaveLength(1);
  });

  it('FR-1-21(Issue #16): 次回の status で旧スタックが削除候補として再登場する', async () => {
    const s = setup(newConfig, templates, recordedState(oldConfig, templates));
    existingStack(s.cfn, 'Old');
    await s.run();

    const status = await getStatus({
      config: newConfig,
      templates,
      backend: s.backend,
    });

    expect(status.entries).toContainEqual({
      stackKey: PENDING_OLD_KEY,
      region: REGION,
      stackName: 'Old',
      changeType: 'deleted',
    });
    // 設定側のスタックは変更なしのままである(Issue の「unchanged になる」経路)。
    expect(
      status.entries.find((entry) => entry.stackKey === `a.yaml@${REGION}`)
        ?.changeType,
    ).toBe('unchanged');
  });

  it('FR-1-19 / FR-6-7(Issue #16): 次回の deploy --allow-delete で旧スタックが削除され削除待ちが消える', async () => {
    const first = setup(
      newConfig,
      templates,
      recordedState(oldConfig, templates),
    );
    existingStack(first.cfn, 'Old');
    await first.run();

    const second = setup(
      newConfig,
      templates,
      first.backend.stored?.state as CfnSyncState,
    );
    existingStack(second.cfn, 'Old');

    const result = await second.run({ allowDelete: true });

    expect(result.exitCode).toBe(0);
    expect(
      second.cfn.callsOf('deleteStack').map((call) => call.args[0]),
    ).toEqual([stackIdOf('Old')]);
    const stored = second.backend.stored?.state as CfnSyncState;
    expect(stored.pendingDeletions).toEqual({});
    // 新スタックのエントリは削除で消えない。
    expect(stored.stacks[`a.yaml@${REGION}`].stackName).toBe('New');
  });
});

// ===========================================================================
// 異常系 1: CREATE 成功後・state 保存前の中断からの復旧
// ===========================================================================

describe('usecase/deploy — FR-1-18: CREATE 復旧でも削除待ちを同一保存で記録する', () => {
  it('FR-1-18: 新名スタックが既に実在する CREATE 復旧の再同期に旧名の削除待ちが含まれる', async () => {
    const oldConfig = configOf({ 'a.yaml': { stackName: 'Old' } });
    const newConfig = configOf({ 'a.yaml': { stackName: 'New' } });
    const templates = new Map([['a.yaml', TEMPLATE]]);
    const s = setup(newConfig, templates, recordedState(oldConfig, templates));

    // 前回実行が CreateStack に成功した直後に落ちた状況: New が管理タグつきで実在する。
    s.cfn.stacks.set(
      'New',
      makeStackSummary({
        stackName: 'New',
        stackId: stackIdOf('New'),
        status: 'CREATE_COMPLETE',
        tags: { [MANAGEMENT_TAG_KEY]: STATE_ID },
      }),
    );
    s.cfn.templates.set('New', TEMPLATE);
    existingStack(s.cfn, 'Old');

    const result = await s.run({ allowDelete: true });

    expect(result.exitCode).toBe(0);
    // 復旧なので変更セットは作らない。
    expect(s.cfn.callsOf('createChangeSet')).toHaveLength(0);
    expect(result.report.reconciliations).toContainEqual({
      stackKey: `a.yaml@${REGION}`,
      region: REGION,
      kind: 'create-recovery',
      stateUpdated: true,
    });

    const recoverySave = s.backend.saveCalls.find(
      (call) => call.state.stacks[`a.yaml@${REGION}`]?.stackName === 'New',
    );
    expect(recoverySave?.state.pendingDeletions[PENDING_OLD]).toBeDefined();

    // 同じ実行内で旧スタックの削除まで進み、削除待ちも消える。
    expect(s.cfn.callsOf('deleteStack').map((call) => call.args[0])).toEqual([
      stackIdOf('Old'),
    ]);
    expect((s.backend.stored?.state as CfnSyncState).pendingDeletions).toEqual(
      {},
    );
  });
});

// ===========================================================================
// 異常系 2: 削除の拒否(削除保護・--allow-delete 未指定・承認拒否)
// ===========================================================================

describe('usecase/deploy — FR-1-19 / FR-6-7: 削除の拒否では削除待ちを消さない', () => {
  const config = configOf({ 'a.yaml': { stackName: 'New' } });
  const templates = new Map([['a.yaml', TEMPLATE]]);

  function pendingState(): CfnSyncState {
    return upsertPendingDeletion(
      recordedState(config, templates),
      PENDING_OLD,
      makePending(),
    );
  }

  it('FR-6-7: 削除待ちの削除も --allow-delete を要求し、指定がなければ DeleteStack を呼ばない', async () => {
    const s = setup(config, templates, pendingState());
    existingStack(s.cfn, 'Old');

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    expect(s.cfn.callsOf('deleteStack')).toHaveLength(0);
    expect(result.report.diffs).toContainEqual(
      expect.objectContaining({
        stackKey: PENDING_OLD_KEY,
        stackName: 'Old',
        operation: 'delete',
        warnings: expect.arrayContaining([
          expect.stringContaining('--allow-delete'),
        ]),
      }),
    );
    // 保存自体が起きないため、state 上の削除待ちは残ったままである。
    expect(s.backend.saveCalls).toHaveLength(0);
    expect(s.backend.stored?.state.pendingDeletions[PENDING_OLD]).toBeDefined();
  });

  it('FR-1-19 / FR-6-7: 削除保護が有効なら自動解除せず失敗し、削除待ちを残す', async () => {
    const s = setup(config, templates, pendingState());
    existingStack(s.cfn, 'Old', {
      status: 'CREATE_COMPLETE',
      terminationProtection: true,
    });

    const result = await s.run({ allowDelete: true });

    expect(result.exitCode).toBe(1);
    expect(s.cfn.callsOf('deleteStack')).toHaveLength(0);
    expect(result.report.result?.stacks).toContainEqual(
      expect.objectContaining({
        stackKey: PENDING_OLD_KEY,
        outcome: 'failed',
        errorMessage: expect.stringContaining('削除保護'),
      }),
    );
    // 保存自体が起きないため、state 上の削除待ちは残ったままである。
    expect(s.backend.saveCalls).toHaveLength(0);
  });

  it('FR-1-19: 承認を拒否した場合も削除待ちを残し DeleteStack を行わない', async () => {
    const s = setup(config, templates, pendingState());
    existingStack(s.cfn, 'Old');
    s.control.decision = false;

    const result = await s.run({ allowDelete: true, autoApprove: false });

    expect(result.exitCode).toBe(0);
    expect(result.report.cancelled).toBe(true);
    expect(s.approvals).toHaveLength(1);
    expect(s.cfn.callsOf('deleteStack')).toHaveLength(0);
    expect(s.backend.saveCalls).toHaveLength(0);
  });

  it('FR-6-7: 削除待ちの stackId が実スタックと一致しない場合は DeleteStack を拒否する', async () => {
    const s = setup(config, templates, pendingState());
    s.cfn.stacks.set(
      'Old',
      makeStackSummary({
        stackName: 'Old',
        stackId: `${stackIdOf('Old')}-replaced`,
        status: 'CREATE_COMPLETE',
      }),
    );

    const result = await s.run({ allowDelete: true });

    expect(result.exitCode).toBe(1);
    expect(s.cfn.callsOf('deleteStack')).toHaveLength(0);
    expect(result.report.result?.stacks).toContainEqual(
      expect.objectContaining({
        stackKey: PENDING_OLD_KEY,
        outcome: 'failed',
        errorMessage: expect.stringContaining('stackId'),
      }),
    );
  });

  it('FR-6-7: 削除待ちが REVIEW_IN_PROGRESS なら DeleteStack を一切呼ばない', async () => {
    const s = setup(config, templates, pendingState());
    s.cfn.stacks.set(
      'Old',
      makeStackSummary({
        stackName: 'Old',
        stackId: stackIdOf('Old'),
        status: 'REVIEW_IN_PROGRESS',
      }),
    );

    const result = await s.run({ allowDelete: true });

    expect(result.exitCode).toBe(1);
    expect(s.cfn.callsOf('deleteStack')).toHaveLength(0);
    expect(s.cfn.reviewInProgressDeleteCalls).toEqual([]);
  });

  it('FR-6-7 / FR-6-5: 依存解析が不完全な削除待ちは自動削除を拒否する', async () => {
    const s = setup(
      config,
      templates,
      upsertPendingDeletion(
        recordedState(config, templates),
        PENDING_OLD,
        makePending({ dependencyAnalysisIncomplete: true }),
      ),
    );
    existingStack(s.cfn, 'Old');

    const result = await s.run({ allowDelete: true });

    expect(result.exitCode).toBe(1);
    expect(s.cfn.callsOf('deleteStack')).toHaveLength(0);
  });
});

// ===========================================================================
// 異常系 3: DeleteStack 成功後の CAS 失敗と、その後の収束
// ===========================================================================

describe('usecase/deploy — FR-1-20 / FR-5-5b7: 削除成功後の CAS 失敗からの収束', () => {
  const config = configOf({ 'a.yaml': { stackName: 'New' } });
  const templates = new Map([['a.yaml', TEMPLATE]]);

  it('FR-1-19: DeleteStack は成功したが state 保存に失敗した場合、削除待ちは残る', async () => {
    const state = upsertPendingDeletion(
      recordedState(config, templates),
      PENDING_OLD,
      makePending(),
    );
    const s = setup(config, templates, state);
    existingStack(s.cfn, 'Old');
    s.backend.saveError = new StateConflictError('世代不一致(注入)');

    const result = await s.run({ allowDelete: true });

    expect(result.exitCode).toBe(1);
    expect(s.cfn.callsOf('deleteStack')).toHaveLength(1);
    // 保存に失敗したので、正本の削除待ちはそのまま残る。
    expect(s.backend.stored?.state.pendingDeletions[PENDING_OLD]).toBeDefined();
  });

  it('FR-1-20 / FR-5-5b7: 次回実行はスタックの不在を確認して削除待ちを除去する(既成事実の再同期)', async () => {
    const state = upsertPendingDeletion(
      recordedState(config, templates),
      PENDING_OLD,
      makePending(),
    );
    const s = setup(config, templates, state);
    // 前回実行の DeleteStack は成功しているため、実スタックはもう存在しない。

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    expect(s.cfn.callsOf('deleteStack')).toHaveLength(0);
    expect((s.backend.stored?.state as CfnSyncState).pendingDeletions).toEqual(
      {},
    );
  });

  it('FR-5-18e: 削除待ちの不在確認は既存の deleted-absent 種別で開示される', async () => {
    const state = upsertPendingDeletion(
      recordedState(config, templates),
      PENDING_OLD,
      makePending(),
    );
    const s = setup(config, templates, state);

    const result = await s.run();

    expect(result.report.reconciliations).toContainEqual({
      stackKey: PENDING_OLD_KEY,
      region: REGION,
      kind: 'deleted-absent',
      stateUpdated: true,
    });
    // 開示の種別は既存の 3 種から増やさない(FR-5-16)。
    const kinds = (result.report.reconciliations ?? []).map(
      (record) => record.kind,
    );
    for (const kind of kinds) {
      expect([
        'empty-change-set',
        'deleted-absent',
        'create-recovery',
      ]).toContain(kind);
    }
  });
});

// ===========================================================================
// 異常系 4: 削除順序(統合依存グラフの逆順)
// ===========================================================================

describe('usecase/deploy — FR-6-8: 削除待ちは統合依存グラフの逆順で削除する', () => {
  it('FR-6-8: 削除待ちの exports / imports を復元し consumer → provider の順で削除する', async () => {
    const config = configOf({});
    const templates = new Map<string, string>();
    let state = withAccountId(createInitialState(), ACCOUNT);
    state = upsertPendingDeletion(
      state,
      `ProvOld@${REGION}`,
      makePending({ stackName: 'ProvOld', exports: ['SharedOld'] }),
    );
    state = upsertPendingDeletion(
      state,
      `ConsOld@${REGION}`,
      makePending({ stackName: 'ConsOld', imports: ['SharedOld'] }),
    );
    const s = setup(config, templates, state);
    existingStack(s.cfn, 'ProvOld');
    existingStack(s.cfn, 'ConsOld');

    const result = await s.run({ allowDelete: true });

    expect(result.exitCode).toBe(0);
    expect(s.cfn.callsOf('deleteStack').map((call) => call.args[0])).toEqual([
      stackIdOf('ConsOld'),
      stackIdOf('ProvOld'),
    ]);
    expect((s.backend.stored?.state as CfnSyncState).pendingDeletions).toEqual(
      {},
    );
  });

  it('FR-6-8 / FR-6-5: 削除待ちの dependsOn を統合グラフへ解決できない場合は削除を拒否する', async () => {
    const config = configOf({});
    const templates = new Map<string, string>();
    const state = upsertPendingDeletion(
      withAccountId(createInitialState(), ACCOUNT),
      PENDING_OLD,
      makePending({ dependsOn: [`gone.yaml@${REGION}`] }),
    );
    const s = setup(config, templates, state);
    existingStack(s.cfn, 'Old');

    const result = await s.run({ allowDelete: true });

    expect(result.exitCode).toBe(1);
    expect(s.cfn.callsOf('deleteStack')).toHaveLength(0);
    expect(result.report.result?.stacks).toContainEqual(
      expect.objectContaining({
        stackKey: PENDING_OLD_KEY,
        outcome: 'failed',
        errorMessage: expect.stringContaining(`gone.yaml@${REGION}`),
      }),
    );
  });
});

// ===========================================================================
// 異常系 5: 連続リネーム
// ===========================================================================

describe('usecase/deploy — FR-1-22: 連続リネームは削除待ちを積み上げる', () => {
  it('FR-1-22: Old → New → Newer で 2 件の削除待ちが両方とも保持される', async () => {
    const templates = new Map([['a.yaml', TEMPLATE]]);
    const oldConfig = configOf({ 'a.yaml': { stackName: 'Old' } });
    const newConfig = configOf({ 'a.yaml': { stackName: 'New' } });
    const newerConfig = configOf({ 'a.yaml': { stackName: 'Newer' } });

    const first = setup(
      newConfig,
      templates,
      recordedState(oldConfig, templates),
    );
    existingStack(first.cfn, 'Old');
    await first.run();

    const second = setup(
      newerConfig,
      templates,
      first.backend.stored?.state as CfnSyncState,
    );
    existingStack(second.cfn, 'Old');
    existingStack(second.cfn, 'New');
    const result = await second.run();

    expect(result.exitCode).toBe(0);
    const stored = second.backend.stored?.state as CfnSyncState;
    expect(Object.keys(stored.pendingDeletions).sort()).toEqual([
      `New@${REGION}`,
      `Old@${REGION}`,
    ]);
    expect(stored.stacks[`a.yaml@${REGION}`].stackName).toBe('Newer');
  });
});

// ===========================================================================
// 異常系 6: 削除待ちと新しい設定エントリの物理スタック衝突
// ===========================================================================

describe('usecase/deploy — FR-6-10: 削除待ちと create/update の物理スタック衝突', () => {
  it('FR-6-10: 削除待ちの (リージョン, スタック名) を設定が指す場合、AWS 副作用の前に fail-closed で拒否する', async () => {
    const templates = new Map([['a.yaml', TEMPLATE]]);
    // 現在の state は New。設定は Old へ戻そうとしている(削除待ち Old は未解消)。
    const newConfig = configOf({ 'a.yaml': { stackName: 'New' } });
    const backConfig = configOf({ 'a.yaml': { stackName: 'Old' } });
    const state = upsertPendingDeletion(
      recordedState(newConfig, templates),
      PENDING_OLD,
      makePending(),
    );
    const s = setup(backConfig, templates, state);

    const result = await s.run({ allowDelete: true });

    expect(result.exitCode).toBe(1);
    // AWS へ一切アクセスしない。
    expect(s.cfn.calls).toHaveLength(0);
    expect(s.backend.saveCalls).toHaveLength(0);
    expect(s.approvals).toHaveLength(0);
    expect(result.report.result?.stacks).toContainEqual(
      expect.objectContaining({
        outcome: 'failed',
        errorMessage: expect.stringContaining('削除待ち'),
      }),
    );
  });
});

// ===========================================================================
// 異常系 7: 表示(status / plan / deploy / JSON 出力契約)
// ===========================================================================

describe('usecase/deploy — FR-6-11: 削除待ちの表示と JSON 出力契約', () => {
  const config = configOf({ 'a.yaml': { stackName: 'New' } });
  const templates = new Map([['a.yaml', TEMPLATE]]);

  it('FR-6-11: 削除待ちの差分は delete 操作として、由来のスタックキーを含む警告を伴う', async () => {
    const s = setup(
      config,
      templates,
      upsertPendingDeletion(
        recordedState(config, templates),
        PENDING_OLD,
        makePending(),
      ),
    );
    existingStack(s.cfn, 'Old');

    const result = await s.run({ dryRun: true });

    const diff = result.report.diffs.find(
      (item) => item.stackKey === PENDING_OLD_KEY,
    );
    expect(diff?.operation).toBe('delete');
    expect(diff?.stackName).toBe('Old');
    expect(diff?.warnings.join(' / ')).toContain(`a.yaml@${REGION}`);
    expect(diff?.warnings.join(' / ')).toContain('削除待ち');
  });

  it('FR-6-11 / FR-5-16: 削除待ちがある実行の JSON も既存フィールドだけを持つ', async () => {
    const s = setup(
      config,
      templates,
      upsertPendingDeletion(
        recordedState(config, templates),
        PENDING_OLD,
        makePending(),
      ),
    );
    existingStack(s.cfn, 'Old');

    const result = await s.run();
    const payload = JSON.parse(renderJson(result.report));

    expect(Object.keys(payload).sort()).toEqual([
      'connection',
      'diffs',
      'events',
      'result',
    ]);
    const diff = payload.diffs.find(
      (item: { stackKey: string }) => item.stackKey === PENDING_OLD_KEY,
    );
    expect(Object.keys(diff).sort()).toEqual([
      'operation',
      'region',
      'resources',
      'stackKey',
      'stackName',
      'warnings',
    ]);
  });
});

// ===========================================================================
// FR-6-9: リネーム対の削除は「対の create の成功記録」を前提とする
// ===========================================================================

describe('usecase/deploy — FR-6-9: 新スタックが作成されていなければ旧スタックを削除しない', () => {
  it('FR-6-9: --on-failure continue で create が失敗した場合も旧スタックへ DeleteStack を行わない', async () => {
    const templates = new Map([['a.yaml', TEMPLATE]]);
    const oldConfig = configOf({ 'a.yaml': { stackName: 'Old' } });
    const newConfig = configOf({ 'a.yaml': { stackName: 'New' } });
    const s = setup(newConfig, templates, recordedState(oldConfig, templates));
    existingStack(s.cfn, 'Old');
    // 新スタックの作成は失敗する。
    s.cfn.waitResults.set('New', [
      makeStackSummary({ stackName: 'New', status: 'CREATE_FAILED' }),
    ]);

    const result = await s.run({ allowDelete: true, onFailure: 'continue' });

    expect(result.exitCode).toBe(1);
    expect(s.cfn.callsOf('executeChangeSet')).toHaveLength(1);
    expect(s.cfn.callsOf('deleteStack')).toHaveLength(0);
    // 旧スタックの記録は state に残ったままである(create が成功していないため)。
    expect(
      (s.backend.stored?.state as CfnSyncState).stacks[`a.yaml@${REGION}`]
        .stackName,
    ).toBe('Old');
  });

  it('FR-6-9a(敵対的レビュー): 無関係な過去のリネーム由来の削除待ちを、今回の paired create 成功と誤認しない', async () => {
    // 過去、別のテンプレートキー(other.yaml)のリネームが同じスタック名 'Old' を
    // 削除待ちとして残していた(originStackKey が今回のリネームと異なる)。
    // pendingDeletionId は (region, stackName) だけで決まるため、今回 a.yaml を
    // Old -> New へリネームすると、この無関係な残骸と同じ ID('Old@REGION')を
    // 参照してしまう。「ID が存在する」だけでは「今回の対の create が成功した」
    // ことの証明にならない — originStackKey が一致して初めて自分自身の対だと言える。
    const templates = new Map([['a.yaml', TEMPLATE]]);
    const oldConfig = configOf({ 'a.yaml': { stackName: 'Old' } });
    const newConfig = configOf({ 'a.yaml': { stackName: 'New' } });
    const staleState = upsertPendingDeletion(
      recordedState(oldConfig, templates),
      PENDING_OLD,
      makePending({ originStackKey: `other.yaml@${REGION}` }),
    );
    const s = setup(newConfig, templates, staleState);
    existingStack(s.cfn, 'Old');
    // 新スタックの作成は失敗する。
    s.cfn.waitResults.set('New', [
      makeStackSummary({ stackName: 'New', status: 'CREATE_FAILED' }),
    ]);

    const result = await s.run({ allowDelete: true, onFailure: 'continue' });

    expect(result.exitCode).toBe(1);
    expect(s.cfn.callsOf('executeChangeSet')).toHaveLength(1);
    // 無関係な削除待ちの存在を「今回の paired create 成功」の証拠として扱ってはならない。
    expect(s.cfn.callsOf('deleteStack')).toHaveLength(0);
    expect(
      (s.backend.stored?.state as CfnSyncState).stacks[`a.yaml@${REGION}`]
        .stackName,
    ).toBe('Old');
    // 無関係な削除待ちの記録自体は変えない(それが指す物理スタックの削除可否とは無関係)。
    expect(
      (s.backend.stored?.state as CfnSyncState).pendingDeletions[PENDING_OLD],
    ).toBeDefined();
  });
});
