/**
 * T-22 usecase/deploy — 「差分表示 → 承認 → 実行」の 2 フェーズ承認フロー。
 *
 * tasks.md §9 T-22 の受け入れ基準 → テストケース対応表を正本とし、各テスト名に対応 ID
 * を明記する。既存の `deploy.test.ts` のハーネスは承認フロー以前からある非承認テストの
 * 互換のために `autoApprove: true` を既定にしているが、**本ファイルは `autoApprove` を
 * 立てず `approve` fake を注入して既定の承認経路そのものを通す**。
 *
 * 検証の要点(design.md §10 の承認フロー節):
 * - 承認は実行全体で高々 1 回であること
 * - `approve` 呼び出し**時点**で全対象の `CreateChangeSet` が完了し、
 *   `ExecuteChangeSet` / `DeleteStack` / 実行成功記録の `save` が 0 回であること
 * - 承認拒否で事前作成した変更セットが**全件**削除され、不可逆な副作用がゼロであること
 * - 承認待ちの間もステートロックが保持されていること
 */

import { describe, expect, it } from 'vitest';
import {
  type CfnSyncConfig,
  resolveTargets,
  validateConfig,
  validateEffectiveConfig,
} from '../../src/core/config.js';
import { resolveDependsOnKey } from '../../src/core/dependency.js';
import {
  computeInputsHash,
  computeTemplateHash,
} from '../../src/core/detect.js';
import {
  AwsError,
  ConfigError,
  StateConflictError,
} from '../../src/core/errors.js';
import {
  type CfnSyncState,
  createInitialState,
  upsertStackEntry,
  withAccountId,
} from '../../src/core/state.js';
import { analyzeTemplate } from '../../src/core/template.js';
import type {
  ChangeSetDetail,
  CloudFormationGateway,
} from '../../src/ports/index.js';
import {
  type ApprovalRequest,
  buildApprovalSummary,
  buildStackDiff,
  type DeployReport,
  renderApprovalSummary,
  renderJson,
  renderText,
} from '../../src/report/index.js';
import { type DeployDeps, deploy } from '../../src/usecase/deploy.js';
import { MANAGEMENT_TAG_KEY } from '../../src/usecase/executor.js';
import {
  FakeCloudFormationGateway,
  FakeStateBackend,
  makeChangeSetDetail,
  makeChangeSetSummary,
  makeStackSummary,
} from './fakes.js';

const ACCOUNT = '123456789012';
const REGION = 'ap-northeast-1';
const REGION_2 = 'us-west-2';
const REGION_3 = 'eu-central-1';
const STATE_ID = 'aabbccddeeff';
const RUN_ID = 'run22';
const FIXED_NOW = () => new Date('2026-07-20T12:00:00.000Z');

/** Export を持つ provider。 */
const TEMPLATE_A = `
AWSTemplateFormatVersion: '2010-09-09'
Resources:
  BucketA:
    Type: AWS::S3::Bucket
Outputs:
  Shared:
    Value: value
    Export:
      Name: SharedValue
`;

/** TEMPLATE_A の Export を ImportValue する consumer。 */
const TEMPLATE_B = `
AWSTemplateFormatVersion: '2010-09-09'
Resources:
  BucketB:
    Type: AWS::S3::Bucket
    Properties:
      BucketName:
        Fn::ImportValue: SharedValue
`;

/** 依存を持たない独立スタック。 */
const TEMPLATE_C = `
AWSTemplateFormatVersion: '2010-09-09'
Resources:
  QueueC:
    Type: AWS::SQS::Queue
`;

const TEMPLATE_SECRET = `
AWSTemplateFormatVersion: '2010-09-09'
Parameters:
  Secret:
    Type: String
    NoEcho: true
Resources:
  Bucket:
    Type: AWS::S3::Bucket
`;

const NO_CHANGE_REASON =
  "The submitted information didn't contain changes. Submit different information to create a change set.";

function configOf(
  stacks: Record<string, unknown>,
  allowedRegions = [REGION],
  extra: Record<string, unknown> = {},
): CfnSyncConfig {
  return validateConfig({
    version: 1,
    defaultRegion: allowedRegions[0],
    allowedAccounts: [ACCOUNT],
    allowedRegions,
    stacks,
    ...extra,
  });
}

function templatesOf(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

function stackIdOf(region: string, stackName: string): string {
  return `arn:aws:cloudformation:${region}:${ACCOUNT}:stack/${stackName}/managed`;
}

/** 全対象を「デプロイ済み」として記録した state を作る(`modified` で差分ありにする)。 */
function recordedState(
  config: CfnSyncConfig,
  templates: Map<string, string>,
  opts: { modified?: boolean } = {},
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
    state = upsertStackEntry(state, target.stackKey, {
      stackName: target.stackName,
      stackId: stackIdOf(target.region, target.stackName),
      region: target.region,
      templateHash: computeTemplateHash(source),
      inputsHash: opts.modified
        ? `sha256:old-${target.stackKey}`
        : computeInputsHash({
            templateHash: computeTemplateHash(source),
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
      dependencyAnalysisIncomplete:
        analysis.warnings.length > 0 && target.dependsOn.length === 0,
      lastAction: 'UPDATE',
      lastSuccessAt: '2026-07-19T00:00:00.000Z',
    });
  }
  return state;
}

/** リソース差分 1 件の変更セット詳細(既定)。 */
function changedDetail() {
  return makeChangeSetDetail({
    changes: [
      {
        action: 'Modify',
        logicalResourceId: 'Resource',
        resourceType: 'AWS::S3::Bucket',
        replacement: 'False',
        scope: ['Properties'],
        details: [{ target: { attribute: 'Properties', name: 'Tags' } }],
      },
    ],
  });
}

type ProgressEventForTest = {
  stackKey: string;
  region: string;
  phase: string;
  message: string;
};

/** `approve` が呼ばれた**時点**の観測値。承認前後の副作用の有無を強く固定する。 */
interface ApproveObservation {
  /** 承認時点までに作成された変更セットの対象スタック名(全リージョン合算・時系列)。 */
  createdChangeSets: string[];
  executeChangeSet: number;
  deleteStack: number;
  deleteChangeSet: number;
  /** 承認時点までの `StateBackend.save` 呼び出し回数。 */
  saveCalls: number;
  /** 承認時点までの `releaseLock` 呼び出し回数(FR-5-14a: 0 でなければロック解放済み)。 */
  releaseCalls: number;
  timeline: string[];
}

function setup(
  config: CfnSyncConfig,
  templates: Map<string, string>,
  state?: CfnSyncState,
) {
  const timeline: string[] = [];
  const progress: ProgressEventForTest[] = [];
  const backend = new FakeStateBackend(timeline, state, STATE_ID);
  const gateways = new Map<string, FakeCloudFormationGateway>();
  const cfnFactory = (region: string): CloudFormationGateway => {
    let gateway = gateways.get(region);
    if (!gateway) {
      gateway = new FakeCloudFormationGateway(timeline, `cfn:${region}`);
      gateway.defaultChangeSetDetail = changedDetail();
      gateways.set(region, gateway);
    }
    return gateway;
  };
  const sts = {
    calls: 0,
    async getCallerIdentity() {
      this.calls += 1;
      timeline.push('sts.getCallerIdentity');
      return { accountId: ACCOUNT, arn: `arn:aws:iam::${ACCOUNT}:role/test` };
    },
  };

  const countAll = (method: string): number =>
    [...gateways.values()].reduce(
      (total, gateway) => total + gateway.callsOf(method).length,
      0,
    );
  const createdChangeSetStacks = (): string[] =>
    [...gateways.values()].flatMap((gateway) =>
      gateway
        .callsOf('createChangeSet')
        .map((call) => (call.args[0] as { stackName: string }).stackName),
    );
  const observe = (): ApproveObservation => ({
    createdChangeSets: createdChangeSetStacks(),
    executeChangeSet: countAll('executeChangeSet'),
    deleteStack: countAll('deleteStack'),
    deleteChangeSet: countAll('deleteChangeSet'),
    saveCalls: backend.saveCalls.length,
    releaseCalls: backend.releaseCalls,
    timeline: [...timeline],
  });

  const control = {
    /** approve の戻り値(既定は承認)。 */
    decision: true,
    /** 承認待ちの間に他主体の変更を注入するフック(FR-5-17 の競合窓)。 */
    onApprove: undefined as
      | undefined
      | ((request: ApprovalRequest) => void | Promise<void>),
  };
  const approvals: ApprovalRequest[] = [];
  const observations: ApproveObservation[] = [];

  const approve = async (request: ApprovalRequest): Promise<boolean> => {
    timeline.push('approve');
    approvals.push(request);
    observations.push(observe());
    await control.onApprove?.(request);
    return control.decision;
  };

  const run = (
    options: {
      dryRun?: boolean;
      allowDelete?: boolean;
      onFailure?: 'stop' | 'continue';
      autoApprove?: boolean;
      collectEvents?: boolean;
    } = {},
    depsOverride: Partial<DeployDeps> = {},
  ) =>
    deploy({
      config,
      templates,
      deps: {
        cfnFactory,
        sts,
        backend,
        now: FIXED_NOW,
        runId: () => RUN_ID,
        onProgress: (event) => progress.push(event),
        approve,
        ...depsOverride,
      },
      options,
    });

  return {
    timeline,
    progress,
    backend,
    gateways,
    cfnFactory,
    sts,
    control,
    approvals,
    observations,
    countAll,
    createdChangeSetStacks,
    run,
  };
}

type Harness = ReturnType<typeof setup>;

function gatewayFor(s: Harness, region = REGION): FakeCloudFormationGateway {
  s.cfnFactory(region);
  return s.gateways.get(region) as FakeCloudFormationGateway;
}

/** 対象 config の全スタックを「実在・UPDATE 可能」として fake へ登録する。 */
function setExistingStacks(
  config: CfnSyncConfig,
  fake: FakeCloudFormationGateway,
  region = REGION,
): void {
  for (const target of resolveTargets(config).filter(
    (item) => item.region === region,
  )) {
    fake.stacks.set(
      target.stackName,
      makeStackSummary({
        stackName: target.stackName,
        stackId: stackIdOf(target.region, target.stackName),
        status: 'UPDATE_COMPLETE',
      }),
    );
  }
}

/** createChangeSet / executeChangeSet / deleteStack の時系列(順序検証用)。 */
function mutationOrder(fake: FakeCloudFormationGateway): string[] {
  return fake.calls
    .filter((call) =>
      ['createChangeSet', 'executeChangeSet', 'deleteStack'].includes(
        call.method,
      ),
    )
    .map((call) => {
      if (call.method === 'createChangeSet')
        return `create:${(call.args[0] as { stackName: string }).stackName}`;
      if (call.method === 'executeChangeSet')
        return `execute:${String(call.args[0])}`;
      return `deleteStack:${String(call.args[0])}`;
    });
}

/** timeline 上で `approve` の直前・直後を判定するための索引補助。 */
function indexOfCall(timeline: string[], suffix: string): number {
  return timeline.findIndex(
    (entry) => entry === suffix || entry.endsWith(`.${suffix}`),
  );
}

function lastIndexOfCall(timeline: string[], suffix: string): number {
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const entry = timeline[i];
    if (entry === suffix || entry.endsWith(`.${suffix}`)) return i;
  }
  return -1;
}

function phasesOf(s: Harness, stackKey: string): string[] {
  return s.progress
    .filter((event) => event.stackKey === stackKey)
    .map((event) => event.phase);
}

// ===========================================================================
// FR-5-1 / FR-5-2 / FR-5-3 / FR-5-4: 承認を挟む一連のフロー
// ===========================================================================

describe('T-22 承認フロー — 一連の流れと承認回数', () => {
  it('FR-5-1: 依存のある 2 スタックが承認を挟んで全工程を依存順に通る', async () => {
    const config = configOf({
      'a.yaml': { stackName: 'A' },
      'b.yaml': { stackName: 'B' },
    });
    const templates = templatesOf({
      'a.yaml': TEMPLATE_A,
      'b.yaml': TEMPLATE_B,
    });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    // 変更検知 → 順序解決 → 変更セット作成(全件)→ 承認 → 実行(依存順)。
    expect(s.approvals).toHaveLength(1);
    expect(mutationOrder(fake)).toEqual([
      'create:A',
      'create:B',
      'execute:A',
      'execute:B',
    ]);
    // approve は全 createChangeSet の後・全 executeChangeSet の前に位置する。
    const approveIndex = indexOfCall(s.timeline, 'approve');
    expect(approveIndex).toBeGreaterThan(
      lastIndexOfCall(s.timeline, 'createChangeSet'),
    );
    expect(approveIndex).toBeLessThan(
      indexOfCall(s.timeline, 'executeChangeSet'),
    );
    expect(result.report.result?.stacks.map((stack) => stack.outcome)).toEqual([
      'succeeded',
      'succeeded',
    ]);
  });

  it('FR-5-2a: 3 スタックの実行で approve がちょうど 1 回だけ呼ばれ、承認後に全件が依存順で実行される', async () => {
    const config = configOf({
      'a.yaml': { stackName: 'A' },
      'b.yaml': { stackName: 'B' },
      'c.yaml': { stackName: 'C' },
    });
    const templates = templatesOf({
      'a.yaml': TEMPLATE_A,
      'b.yaml': TEMPLATE_B,
      'c.yaml': TEMPLATE_C,
    });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    // FR-5-2a: 対象スタックごとの個別承認ではなく、実行全体で 1 回。
    expect(s.approvals).toHaveLength(1);
    expect(s.timeline.filter((entry) => entry === 'approve')).toHaveLength(1);
    expect(mutationOrder(fake)).toEqual([
      'create:A',
      'create:B',
      'create:C',
      'execute:A',
      'execute:B',
      'execute:C',
    ]);
  });

  it('FR-5-2b: --auto-approve では approve が呼ばれずそのまま実行される', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);

    const result = await s.run({ autoApprove: true });

    expect(result.exitCode).toBe(0);
    // approve は注入されているが、--auto-approve では一切呼ばれない。
    expect(s.approvals).toHaveLength(0);
    expect(s.timeline).not.toContain('approve');
    expect(fake.callsOf('executeChangeSet')).toHaveLength(1);
  });

  it('FR-5-3: --dry-run は ExecuteChangeSet を呼ばずに差分を出して終了する', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);

    const result = await s.run({ dryRun: true });

    expect(result).toMatchObject({ exitCode: 2, hasDiff: true });
    expect(fake.callsOf('executeChangeSet')).toHaveLength(0);
    expect(fake.callsOf('deleteStack')).toHaveLength(0);
    expect(result.report.diffs).toContainEqual(
      expect.objectContaining({ stackName: 'A', operation: 'update' }),
    );
  });

  it('FR-5-4: 2 スタックの承認フローで各スタックの phase 順序が維持され、全 diff-ready が最初の execute-start に先行する', async () => {
    const config = configOf({
      'a.yaml': { stackName: 'A' },
      'b.yaml': { stackName: 'B' },
    });
    const templates = templatesOf({
      'a.yaml': TEMPLATE_A,
      'b.yaml': TEMPLATE_B,
    });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    setExistingStacks(config, gatewayFor(s));

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    // スタック単位の相対順序は 2 フェーズ化後も不変。
    expect(phasesOf(s, `a.yaml@${REGION}`)).toEqual([
      'changeset-create-start',
      'diff-ready',
      'execute-start',
      'done',
    ]);
    expect(phasesOf(s, `b.yaml@${REGION}`)).toEqual([
      'changeset-create-start',
      'diff-ready',
      'execute-start',
      'done',
    ]);
    // 全対象の diff-ready が最初の execute-start に先行する(2 フェーズ化の本質)。
    const phases = s.progress.map((event) => event.phase);
    const lastDiffReady = phases.lastIndexOf('diff-ready');
    const firstExecuteStart = phases.indexOf('execute-start');
    expect(lastDiffReady).toBeGreaterThanOrEqual(0);
    expect(firstExecuteStart).toBeGreaterThan(lastDiffReady);
    // 承認そのものは ProgressEvent を持たない(design §5.3: スタック単位の契約を汚さない)。
    expect(phases).not.toContain('approve');
  });
});

// ===========================================================================
// FR-5-5a / FR-5-5c: Phase A では不可逆な副作用も成功記録もしない
// ===========================================================================

describe('T-22 承認フロー — Phase A の境界', () => {
  it('FR-5-5a: approve 呼び出し時点で全対象の CreateChangeSet が完了し ExecuteChangeSet・DeleteStack が 0 回', async () => {
    const config = configOf({
      'a.yaml': { stackName: 'A' },
      'b.yaml': { stackName: 'B' },
      'c.yaml': { stackName: 'C' },
    });
    const templates = templatesOf({
      'a.yaml': TEMPLATE_A,
      'b.yaml': TEMPLATE_B,
      'c.yaml': TEMPLATE_C,
    });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    setExistingStacks(config, gatewayFor(s));

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    const observed = s.observations[0];
    // 全対象の変更セットが承認前に作成済みであること(件数ではなく対象の同一性で固定)。
    expect(observed.createdChangeSets).toEqual(['A', 'B', 'C']);
    // Phase A で許される AWS の変更操作は変更セットの作成・削除と残存回収だけ。
    expect(observed.executeChangeSet).toBe(0);
    expect(observed.deleteStack).toBe(0);
  });

  it('FR-5-5c: ExecuteChangeSet の成功記録は approve 前に保存されず承認後に保存される', async () => {
    const config = configOf({
      'a.yaml': { stackName: 'A' },
      'b.yaml': { stackName: 'B' },
    });
    const templates = templatesOf({
      'a.yaml': TEMPLATE_A,
      'b.yaml': TEMPLATE_B,
    });
    const initial = recordedState(config, templates, { modified: true });
    const oldHashA = initial.stacks[`a.yaml@${REGION}`].inputsHash;
    const s = setup(config, templates, initial);
    setExistingStacks(config, gatewayFor(s));

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    // 承認時点では実行の成功記録が 1 件も保存されていない。
    expect(s.observations[0].saveCalls).toBe(0);
    expect(
      s.observations[0].timeline.filter((entry) => entry === 'backend.save'),
    ).toHaveLength(0);
    // 承認後に 2 件(A / B)の成功記録が保存される。
    expect(s.backend.saveCalls).toHaveLength(2);
    expect(
      s.backend.stored?.state.stacks[`a.yaml@${REGION}`].inputsHash,
    ).not.toBe(oldHashA);
    expect(lastIndexOfCall(s.timeline, 'save')).toBeGreaterThan(
      indexOfCall(s.timeline, 'approve'),
    );
  });
});

// ===========================================================================
// FR-5-5b: Phase A で保存してよい「既成事実の再同期」
// ===========================================================================

/**
 * スタックごとに変更セット詳細を差し替える。フェイクの変更セット名・ARN は
 * (stateId, runId, now) から決まるため同一実行内では全スタックで同一になる。
 * 実行対象ごとに空変更セット・成功変更セットを作り分けるには stackName で分岐させる。
 */
function overrideChangeSetDetail(
  fake: FakeCloudFormationGateway,
  byStackName: Record<string, Partial<ChangeSetDetail>>,
): void {
  const base = fake.waitForChangeSet.bind(fake);
  fake.waitForChangeSet = async (stackName, changeSetName) => {
    const detail = await base(stackName, changeSetName);
    const override = byStackName[stackName];
    return override ? { ...detail, ...override } : detail;
  };
}

/** 空変更セット(FR-2 の既知の「変更なし」定型文で FAILED)。 */
const EMPTY_CHANGE_SET: Partial<ChangeSetDetail> = {
  status: 'FAILED',
  statusReason: NO_CHANGE_REASON,
  changes: [],
};

describe('T-22 承認フロー — Phase A の再同期(FR-5-5b)', () => {
  it('FR-5-5b1: 空変更セットの変更なし確認が Phase A で state へ再同期される', async () => {
    // A は空変更セット(再同期のみ)、C は実差分あり(承認対象)。
    const config = configOf({
      'a.yaml': { stackName: 'A' },
      'c.yaml': { stackName: 'C' },
    });
    const templates = templatesOf({
      'a.yaml': TEMPLATE_A,
      'c.yaml': TEMPLATE_C,
    });
    const initial = recordedState(config, templates, { modified: true });
    const s = setup(config, templates, initial);
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    overrideChangeSetDetail(fake, { A: EMPTY_CHANGE_SET });

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    // 承認時点で A の再同期だけが保存済み(実行の成功記録はまだ 0 件)。
    expect(s.approvals).toHaveLength(1);
    expect(s.observations[0].saveCalls).toBe(1);
    expect(s.observations[0].executeChangeSet).toBe(0);
    expect(
      s.backend.saveCalls[0].state.stacks[`a.yaml@${REGION}`].inputsHash,
    ).toBe(
      computeInputsHash({
        templateHash: computeTemplateHash(TEMPLATE_A),
        stackName: 'A',
        parameters: {},
        tags: {},
        capabilities: [],
        dependsOn: [],
      }),
    );
    expect(result.report.reconciliations).toContainEqual({
      stackKey: `a.yaml@${REGION}`,
      region: REGION,
      kind: 'empty-change-set',
      stateUpdated: true,
    });
  });

  it('FR-5-5b2: 既に存在しない削除対象の state エントリ除去が Phase A で保存される', async () => {
    // 旧 state に old.yaml(実スタックは既に不存在)と c.yaml、新 config には c.yaml のみ。
    const oldConfig = configOf({
      'c.yaml': { stackName: 'C' },
      'old.yaml': { stackName: 'Old' },
    });
    const oldTemplates = templatesOf({
      'c.yaml': TEMPLATE_C,
      'old.yaml': TEMPLATE_C,
    });
    const config = configOf({ 'c.yaml': { stackName: 'C' } });
    const templates = templatesOf({ 'c.yaml': TEMPLATE_C });
    const state = recordedState(oldConfig, oldTemplates, { modified: true });
    const s = setup(config, templates, state);
    const fake = gatewayFor(s);
    // C は実在(update 対象)。Old は fake へ登録しない = 実スタックが既に不在。
    setExistingStacks(config, fake);

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    expect(s.approvals).toHaveLength(1);
    // 承認時点で削除済み同期だけが保存済み。DeleteStack は 1 度も呼ばない。
    expect(s.observations[0].saveCalls).toBe(1);
    expect(s.observations[0].deleteStack).toBe(0);
    expect(fake.callsOf('deleteStack')).toHaveLength(0);
    expect(
      s.backend.saveCalls[0].state.stacks[`old.yaml@${REGION}`],
    ).toBeUndefined();
    expect(result.report.reconciliations).toContainEqual({
      stackKey: `old.yaml@${REGION}`,
      region: REGION,
      kind: 'deleted-absent',
      stateUpdated: true,
    });
  });

  it('FR-5-5b3: NoEcho なし・dependsOn 空の CREATE 復旧は Phase A で再同期される', async () => {
    const config = configOf({
      'a.yaml': { stackName: 'A' },
      'c.yaml': { stackName: 'C' },
    });
    const templates = templatesOf({
      'a.yaml': TEMPLATE_A,
      'c.yaml': TEMPLATE_C,
    });
    const initial = recordedState(config, templates, { modified: true });
    // a.yaml は state 未記録(added)だが、同名スタックが実在し全入力が一致する状況。
    delete initial.stacks[`a.yaml@${REGION}`];
    const s = setup(config, templates, initial);
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    fake.stacks.set(
      'A',
      makeStackSummary({
        stackName: 'A',
        stackId: stackIdOf(REGION, 'A'),
        status: 'CREATE_COMPLETE',
        tags: { [MANAGEMENT_TAG_KEY]: STATE_ID },
      }),
    );
    fake.templates.set('A', TEMPLATE_A);

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    expect(s.approvals).toHaveLength(1);
    // A の CREATE 復旧は承認前に保存済み、C の変更セット作成も承認前に完了している。
    expect(s.observations[0].saveCalls).toBe(1);
    expect(s.observations[0].createdChangeSets).toEqual(['C']);
    expect(s.observations[0].executeChangeSet).toBe(0);
    expect(
      s.backend.saveCalls[0].state.stacks[`a.yaml@${REGION}`].lastAction,
    ).toBe('SYNC');
    expect(result.report.reconciliations).toContainEqual({
      stackKey: `a.yaml@${REGION}`,
      region: REGION,
      kind: 'create-recovery',
      stateUpdated: true,
    });
  });

  it('FR-5-5b4: NoEcho を持つスタックの CREATE 復旧は state を保存せず import を案内して失敗する', async () => {
    const config = configOf({
      'secret.yaml': {
        stackName: 'SecretStack',
        parameters: { Secret: 'desired-secret-value' },
      },
    });
    const templates = templatesOf({ 'secret.yaml': TEMPLATE_SECRET });
    const s = setup(
      config,
      templates,
      withAccountId(createInitialState(), ACCOUNT),
    );
    const fake = gatewayFor(s);
    fake.stacks.set(
      'SecretStack',
      makeStackSummary({
        stackName: 'SecretStack',
        stackId: stackIdOf(REGION, 'SecretStack'),
        status: 'CREATE_COMPLETE',
        parameters: { Secret: '****' },
        tags: { [MANAGEMENT_TAG_KEY]: STATE_ID },
      }),
    );
    fake.templates.set('SecretStack', TEMPLATE_SECRET);

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    // 検証不能な入力が残るため保存しない。Phase A の失敗なので承認も求めない。
    expect(s.approvals).toHaveLength(0);
    expect(s.backend.saveCalls).toHaveLength(0);
    expect(result.report.reconciliations).toBeUndefined();
    const failure = result.report.result?.stacks[0];
    expect(failure?.outcome).toBe('failed');
    expect(failure?.errorMessage).toContain('入力同一性を証明できない');
    expect(failure?.errorMessage).toContain('--reconcile local');
    expect(failure?.errorMessage).not.toContain('desired-secret-value');
  });

  it('FR-5-5b4: dependsOn を持つスタックの CREATE 復旧も同様に失敗する', async () => {
    const config = configOf({
      'c.yaml': { stackName: 'C' },
      'a.yaml': { stackName: 'A', dependsOn: ['c.yaml'] },
    });
    const templates = templatesOf({
      'c.yaml': TEMPLATE_C,
      'a.yaml': TEMPLATE_A,
    });
    const initial = recordedState(config, templates);
    delete initial.stacks[`a.yaml@${REGION}`];
    const s = setup(config, templates, initial);
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    fake.stacks.set(
      'A',
      makeStackSummary({
        stackName: 'A',
        stackId: stackIdOf(REGION, 'A'),
        status: 'CREATE_COMPLETE',
        tags: { [MANAGEMENT_TAG_KEY]: STATE_ID },
      }),
    );
    fake.templates.set('A', TEMPLATE_A);

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    expect(s.approvals).toHaveLength(0);
    expect(s.backend.saveCalls).toHaveLength(0);
    expect(
      result.report.result?.stacks.find(
        (stack) => stack.stackKey === `a.yaml@${REGION}`,
      )?.errorMessage,
    ).toContain('dependsOn');
  });

  it('FR-5-5b5: 再同期の保存直前に fencing 検証が呼ばれ、所有権喪失時は保存されない', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });

    // (1) 正常系: 再同期の保存の**直前**に fencing 検証が入る(間に他の呼び出しがない)。
    const ok = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const okFake = gatewayFor(ok);
    setExistingStacks(config, okFake);
    overrideChangeSetDetail(okFake, { A: EMPTY_CHANGE_SET });

    expect((await ok.run()).exitCode).toBe(0);
    const saveIndex = ok.timeline.indexOf('backend.save');
    expect(saveIndex).toBeGreaterThan(0);
    expect(ok.timeline[saveIndex - 1]).toBe('backend.verifyLock');

    // (2) 異常系: その fencing 検証が所有権喪失を返したら保存しない。
    const initial = recordedState(config, templates, { modified: true });
    const oldHash = initial.stacks[`a.yaml@${REGION}`].inputsHash;
    const s = setup(config, templates, initial);
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    overrideChangeSetDetail(fake, { A: EMPTY_CHANGE_SET });
    // createChangeSet → 空変更セットの deleteChangeSet → 再同期保存 の 3 回目で所有権を失う。
    s.backend.verifyLockPlan = [true, true, false];

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    expect(s.backend.callsOf('verifyLock')).toHaveLength(3);
    // fencing に失敗した以上、再同期は保存されない。
    expect(s.backend.saveCalls).toHaveLength(0);
    expect(s.backend.stored?.state.stacks[`a.yaml@${REGION}`].inputsHash).toBe(
      oldHash,
    );
    expect(s.approvals).toHaveLength(0);
    expect(result.report.result?.stacks[0].errorMessage).toContain('所有権');
  });

  it('FR-5-5b6: 再同期の保存が CAS で行われ、世代競合時は保存されず StateConflictError になる', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const initial = recordedState(config, templates, { modified: true });
    const oldHash = initial.stacks[`a.yaml@${REGION}`].inputsHash;
    const s = setup(config, templates, initial);
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    overrideChangeSetDetail(fake, { A: EMPTY_CHANGE_SET });
    // 再同期の保存直前(fencing 3 回目)に、他実行が正本を書き換えた状況を作る。
    s.backend.onVerifyLock = async (_handle, count, verified) => {
      if (count !== 3 || !verified) return;
      const current = s.backend.stored;
      if (!current) return;
      const authoritative: CfnSyncState = {
        ...current.state,
        generation: current.state.generation + 1,
      };
      s.backend.stored = {
        state: authoritative,
        version: { backend: 'local', generation: authoritative.generation },
      };
    };

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    // CAS の expected 世代と正本の世代が食い違い、上書きせずエラーになる。
    expect(s.backend.saveCalls).toHaveLength(1);
    expect(s.backend.saveErrors).toHaveLength(1);
    expect(s.backend.saveErrors[0]).toBeInstanceOf(StateConflictError);
    expect(s.backend.stored?.state.stacks[`a.yaml@${REGION}`].inputsHash).toBe(
      oldHash,
    );
    expect(s.approvals).toHaveLength(0);
    expect(result.report.result?.stacks[0].errorMessage).toContain('CAS');
  });
});

// ===========================================================================
// FR-5-8: 実行予定が 0 件なら承認を求めない
// ===========================================================================

describe('T-22 承認フロー — 実行予定 0 件(FR-5-8)', () => {
  it('FR-5-8a: 全対象が変更なしの再実行では approve が呼ばれない', async () => {
    const config = configOf({
      'a.yaml': { stackName: 'A' },
      'b.yaml': { stackName: 'B' },
    });
    const templates = templatesOf({
      'a.yaml': TEMPLATE_A,
      'b.yaml': TEMPLATE_B,
    });
    const s = setup(config, templates, recordedState(config, templates));
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);

    const result = await s.run();

    expect(result).toMatchObject({ exitCode: 0, hasDiff: false });
    // NFR-3: 冪等な再実行は承認も AWS 変更も一切要求しない。
    expect(s.approvals).toHaveLength(0);
    expect(fake.callsOf('createChangeSet')).toHaveLength(0);
    expect(fake.callsOf('executeChangeSet')).toHaveLength(0);
    expect(s.backend.saveCalls).toHaveLength(0);
    expect(
      result.report.result?.stacks.every(
        (stack) => stack.outcome === 'no-change',
      ),
    ).toBe(true);
  });

  it('FR-5-8b: 再同期のみ必要な実行は approve なしで state を同期して exit 0', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    overrideChangeSetDetail(fake, { A: EMPTY_CHANGE_SET });

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    // 実行予定が 0 件なので承認は求めないが、既成事実の再同期は行う。
    expect(s.approvals).toHaveLength(0);
    expect(fake.callsOf('executeChangeSet')).toHaveLength(0);
    expect(s.backend.saveCalls).toHaveLength(1);
    expect(result.report.reconciliations).toEqual([
      {
        stackKey: `a.yaml@${REGION}`,
        region: REGION,
        kind: 'empty-change-set',
        stateUpdated: true,
      },
    ]);
  });
});

// ===========================================================================
// FR-5-6: 承認要求の中身
// ===========================================================================

/** 置換(Replacement: True)を伴うリソース変更。 */
const REPLACEMENT_DETAIL: Partial<ChangeSetDetail> = {
  changes: [
    {
      action: 'Modify',
      logicalResourceId: 'BucketA',
      resourceType: 'AWS::S3::Bucket',
      replacement: 'True',
      scope: ['Properties'],
      details: [{ target: { attribute: 'Properties', name: 'BucketName' } }],
    },
  ],
};

/**
 * update(A)+ create(New)+ delete(Old)の 3 操作を 1 実行に含む承認シナリオ。
 * 承認要求が操作種別・リソース差分・削除対象をすべて含むことの検証に使う。
 */
function setupMixedOperations() {
  const config = configOf({
    'a.yaml': { stackName: 'A' },
    'new.yaml': { stackName: 'New' },
  });
  const templates = templatesOf({
    'a.yaml': TEMPLATE_A,
    'new.yaml': TEMPLATE_C,
  });
  const oldConfig = configOf({
    'a.yaml': { stackName: 'A' },
    'old.yaml': { stackName: 'Old' },
  });
  const oldTemplates = templatesOf({
    'a.yaml': TEMPLATE_A,
    'old.yaml': TEMPLATE_C,
  });
  const s = setup(
    config,
    templates,
    recordedState(oldConfig, oldTemplates, { modified: true }),
  );
  const fake = gatewayFor(s);
  // 実 AWS 同様、CREATE 型変更セットの作成で REVIEW_IN_PROGRESS の殻が生まれるようにする。
  fake.strictStackExistence = true;
  setExistingStacks(config, fake);
  fake.stacks.delete('New');
  fake.stacks.set(
    'Old',
    makeStackSummary({
      stackName: 'Old',
      stackId: stackIdOf(REGION, 'Old'),
      status: 'CREATE_COMPLETE',
    }),
  );
  fake.waitResults.set('Old', [
    makeStackSummary({ stackName: 'Old', status: 'DELETE_COMPLETE' }),
  ]);
  return { s, fake };
}

describe('T-22 承認フロー — 承認要求の内容(FR-5-6)', () => {
  it('FR-5-6a: ApprovalRequest.connection に accountId と regions が入る', async () => {
    const config = configOf(
      {
        'a.yaml': { stackName: 'A', regions: [REGION, REGION_2] },
      },
      [REGION, REGION_2],
    );
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    for (const region of [REGION, REGION_2]) {
      setExistingStacks(config, gatewayFor(s, region), region);
    }

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    expect(s.approvals[0].connection).toEqual({
      accountId: ACCOUNT,
      regions: [REGION, REGION_2],
    });
  });

  it('FR-5-6b: ApprovalRequest.diffs の各要素が create/update/delete の operation を持つ', async () => {
    const { s } = setupMixedOperations();

    const result = await s.run({ allowDelete: true });

    expect(result.exitCode).toBe(0);
    const request = s.approvals[0];
    expect(
      request.diffs.map((diff) => [diff.stackName, diff.operation]),
    ).toEqual([
      ['A', 'update'],
      ['New', 'create'],
      ['Old', 'delete'],
    ]);
    expect(request.summary).toMatchObject({
      create: 1,
      update: 1,
      delete: 1,
    });
  });

  it('FR-5-6c: ApprovalRequest.diffs の resources に Phase A で確定したリソース変更が入る', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    setExistingStacks(config, gatewayFor(s));

    await s.run();

    const [diff] = s.approvals[0].diffs;
    // Phase A の DescribeChangeSet が返したリソース単位の変更がそのまま載る。
    expect(diff.resources).toHaveLength(1);
    expect(diff.resources[0]).toMatchObject({
      action: 'Modify',
      logicalResourceId: 'Resource',
      resourceType: 'AWS::S3::Bucket',
      changedProperties: ['Tags'],
    });
  });

  it('FR-5-6d: Replacement: True のリソースが ApprovalRequest の警告と summary.replacements に現れる', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    overrideChangeSetDetail(fake, { A: REPLACEMENT_DETAIL });

    await s.run();

    const request = s.approvals[0];
    expect(request.summary.replacements).toBe(1);
    expect(request.diffs[0].resources[0].replacement).toBe(true);
    const summaryText = renderApprovalSummary(request, { color: false });
    expect(summaryText).toContain('[REPLACEMENT]');
    expect(summaryText).toContain('リソース置換(Replacement)が 1 件');
  });

  it('FR-5-6e: --allow-delete あり/なしで削除対象の提示が「削除する」/「警告のみ」と区別される', async () => {
    const withDelete = setupMixedOperations();
    await withDelete.s.run({ allowDelete: true });
    const allowed = renderApprovalSummary(withDelete.s.approvals[0], {
      color: false,
    });

    const withoutDelete = setupMixedOperations();
    await withoutDelete.s.run();
    const refused = renderApprovalSummary(withoutDelete.s.approvals[0], {
      color: false,
    });

    expect(withDelete.s.approvals[0].allowDelete).toBe(true);
    expect(allowed).toContain('削除します');
    expect(allowed).toContain('--allow-delete 指定あり');
    expect(withoutDelete.s.approvals[0].allowDelete).toBe(false);
    expect(refused).toContain(
      '--allow-delete 未指定のため削除しません(警告のみ)',
    );
    expect(refused).not.toContain('— 削除します');
    // 削除しない場合でも削除対象は要約に現れる(利用者が判断できること)。
    expect(refused).toContain('[delete]');
    expect(withoutDelete.fake.callsOf('deleteStack')).toHaveLength(0);
  });

  it('FR-5-6g: NoEcho 実値を含む差分でも ApprovalRequest.diffs と承認要約に実値が現れない', async () => {
    const secret = 'super-secret-value';
    const config = configOf({
      'secret.yaml': {
        stackName: 'SecretStack',
        parameters: { Secret: secret },
      },
    });
    const templates = templatesOf({ 'secret.yaml': TEMPLATE_SECRET });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    overrideChangeSetDetail(fake, {
      SecretStack: {
        changes: [
          {
            action: 'Modify',
            logicalResourceId: 'Bucket',
            resourceType: 'AWS::S3::Bucket',
            replacement: 'False',
            scope: ['Properties'],
            // causingEntity が NoEcho パラメータ名でない経路(redactor による実値一致マスク)。
            details: [
              {
                target: {
                  attribute: 'Properties',
                  name: 'Tags',
                  beforeValue: 'old',
                  afterValue: `tag=${secret}`,
                },
                causingEntity: 'SomeOtherThing',
              },
            ],
            beforeContext: `{"env":"${secret}"}`,
            afterContext: `{"env":"${secret}"}`,
          },
        ],
      },
    });

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    const request = s.approvals[0];
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('****');
    expect(renderApprovalSummary(request, { color: false })).not.toContain(
      secret,
    );
    // report 側と同一の redactor が適用されていること(単一経路)。
    expect(JSON.stringify(result.report)).not.toContain(secret);
  });
});

// ===========================================================================
// FR-5-7: リソース差分 0 件で成功した変更セット
// ===========================================================================

/** リソース差分 0 件だが成功した変更セット(Outputs / Export のみの変更)。 */
const RESOURCELESS_CHANGE_SET: Partial<ChangeSetDetail> = {
  status: 'CREATE_COMPLETE',
  changes: [],
};

describe('T-22 承認フロー — リソース差分 0 件(FR-5-7)', () => {
  it('FR-5-7a: Outputs のみ変更したスタックの 0 件変更セットは ExecuteChangeSet され Export が作成される', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const initial = recordedState(config, templates, { modified: true });
    // 旧 state には Export が無く、この実行で Export が作られる。
    initial.stacks[`a.yaml@${REGION}`].exports = [];
    const s = setup(config, templates, initial);
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    overrideChangeSetDetail(fake, { A: RESOURCELESS_CHANGE_SET });

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    // 「変更なし」扱いにせず承認対象に含め、実行する(実行しないと Export が作られない)。
    expect(s.approvals).toHaveLength(1);
    expect(s.approvals[0].diffs[0].operation).toBe('update');
    expect(fake.callsOf('executeChangeSet')).toHaveLength(1);
    expect(s.backend.stored?.state.stacks[`a.yaml@${REGION}`].exports).toEqual([
      'SharedValue',
    ]);
    // 承認要約でも create / update の件数へ算入し、注記対象として別に数える。
    expect(s.approvals[0].summary).toMatchObject({
      update: 1,
      resourcelessChanges: 1,
    });
  });

  it('FR-5-7b: 0 件の update は「変更あり」かつ「CloudFormation リソース差分 0 件」と表示され no-change 表示と一致しない', async () => {
    // A はリソース差分 0 件の update、B は真の変更なし(空変更セット)。
    const config = configOf({
      'a.yaml': { stackName: 'A' },
      'b.yaml': { stackName: 'B' },
    });
    const templates = templatesOf({
      'a.yaml': TEMPLATE_A,
      'b.yaml': TEMPLATE_B,
    });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    overrideChangeSetDetail(fake, {
      A: RESOURCELESS_CHANGE_SET,
      B: EMPTY_CHANGE_SET,
    });

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    const text = renderText(result.report, { color: false });
    const lines = text.split('\n');
    const noteIndex = lines.findIndex((line) =>
      line.includes('CloudFormation リソース差分 0 件'),
    );
    const unchangedIndex = lines.findIndex((line) =>
      line.includes('(変更なし)'),
    );
    expect(noteIndex).toBeGreaterThanOrEqual(0);
    expect(unchangedIndex).toBeGreaterThanOrEqual(0);
    // 0 件 update の注記行と no-change の表示は同一文言ではない。
    expect(lines[noteIndex]).not.toBe(lines[unchangedIndex]);
    expect(lines[noteIndex - 1]).toContain(`[update] a.yaml@${REGION}`);
    expect(lines[unchangedIndex - 1]).toContain(`[no-change] b.yaml@${REGION}`);
    // 承認要約でも同じ判別表示を使う。
    expect(renderApprovalSummary(s.approvals[0], { color: false })).toContain(
      'CloudFormation リソース差分 0 件',
    );
  });

  it('FR-5-7c: delete プレビュー(resources 空)は 0 件注記の対象にならない', async () => {
    const { s } = setupMixedOperations();

    const result = await s.run({ allowDelete: true });

    expect(result.exitCode).toBe(0);
    const deleteDiff = result.report.diffs.find(
      (diff) => diff.operation === 'delete',
    );
    expect(deleteDiff?.resources).toEqual([]);
    // 削除プレビューはリソース差分を持たないのが正常であり、注記の対象にしない。
    expect(s.approvals[0].summary.resourcelessChanges).toBe(0);
    const summaryText = renderApprovalSummary(s.approvals[0], { color: false });
    const deleteLineIndex = summaryText
      .split('\n')
      .findIndex((line) => line.startsWith('[delete]'));
    expect(deleteLineIndex).toBeGreaterThanOrEqual(0);
    // FR-5-7e: 0 件注記の対象外であることは維持しつつ、削除専用の表示を出す。
    const deleteDiffLine = summaryText.split('\n')[deleteLineIndex + 1];
    expect(deleteDiffLine).not.toContain('CloudFormation リソース差分 0 件');
    expect(deleteDiffLine).not.toBe('  (変更なし)');
    expect(deleteDiffLine).toContain('削除対象');
    expect(summaryText).not.toContain(
      '注記: CloudFormation リソース差分が 0 件の create / update',
    );
  });

  it('FR-5-7d: 0 件 update の JSON は warnings 空・operation update のままベースラインと一致し、text 出力だけが変わる', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    overrideChangeSetDetail(fake, { A: RESOURCELESS_CHANGE_SET });

    const result = await s.run();

    // FR-5-7d: 判別はレンダラだけで行い、DeployReport のデータは変えない。
    const json = JSON.parse(renderJson(result.report)) as {
      diffs: Array<{
        operation: string;
        resources: unknown[];
        warnings: string[];
      }>;
    };
    expect(json.diffs[0].operation).toBe('update');
    expect(json.diffs[0].resources).toEqual([]);
    expect(json.diffs[0].warnings).toEqual([]);
    // JSON には注記文言が一切現れない(データ側で区別していない証拠)。
    expect(JSON.stringify(json)).not.toContain('リソース差分 0 件');
    // text 出力だけが変わる。
    expect(renderText(result.report, { color: false })).toContain(
      'CloudFormation リソース差分 0 件',
    );
  });
});

// ===========================================================================
// FR-5-9: dry-run は承認を求めず plan と同一の変更セットライフサイクル
// ===========================================================================

describe('T-22 承認フロー — dry-run(FR-5-9)', () => {
  it('FR-5-9a: deploy --dry-run と plan では approve が呼ばれない', async () => {
    // plan は CLI が deploy --dry-run と同一経路へ委譲する(§5.2 / FR-5-9b)。
    const config = configOf({
      'a.yaml': { stackName: 'A' },
      'b.yaml': { stackName: 'B' },
    });
    const templates = templatesOf({
      'a.yaml': TEMPLATE_A,
      'b.yaml': TEMPLATE_B,
    });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);

    const result = await s.run({ dryRun: true });

    expect(result.exitCode).toBe(2);
    expect(s.approvals).toHaveLength(0);
    expect(s.timeline).not.toContain('approve');
    expect(fake.callsOf('executeChangeSet')).toHaveLength(0);
  });

  it('FR-5-9b: --dry-run は describe 直後に自身の変更セットを削除し、Phase A の保持経路を通らない', async () => {
    const config = configOf({
      'a.yaml': { stackName: 'A' },
      'b.yaml': { stackName: 'B' },
    });
    const templates = templatesOf({
      'a.yaml': TEMPLATE_A,
      'b.yaml': TEMPLATE_B,
    });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);

    const result = await s.run({ dryRun: true });

    expect(result.exitCode).toBe(2);
    // 保持経路(全件作成 → まとめて後始末)ではなく、対象ごとに作成 → describe → 削除。
    const changeSetOps = fake.calls
      .filter((call) =>
        ['createChangeSet', 'waitForChangeSet', 'deleteChangeSet'].includes(
          call.method,
        ),
      )
      .map((call) => call.method);
    expect(changeSetOps).toEqual([
      'createChangeSet',
      'waitForChangeSet',
      'deleteChangeSet',
      'createChangeSet',
      'waitForChangeSet',
      'deleteChangeSet',
    ]);
    expect(fake.callsOf('deleteChangeSet')).toHaveLength(2);
  });
});

// ===========================================================================
// FR-5-10 / FR-5-11: 承認拒否とクリーンアップ
// ===========================================================================

describe('T-22 承認フロー — 承認拒否(FR-5-10 / FR-5-11)', () => {
  it('FR-5-10a: 承認拒否で Phase A の全変更セットが ARN 指定で DeleteChangeSet される', async () => {
    const config = configOf({
      'a.yaml': { stackName: 'A' },
      'b.yaml': { stackName: 'B' },
      'c.yaml': { stackName: 'C' },
    });
    const templates = templatesOf({
      'a.yaml': TEMPLATE_A,
      'b.yaml': TEMPLATE_B,
      'c.yaml': TEMPLATE_C,
    });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    s.control.decision = false;

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    expect(s.approvals).toHaveLength(1);
    // 事前作成した 3 件すべてを、作成時に保持した ARN で削除する。
    const deleted = fake
      .callsOf('deleteChangeSet')
      .map((call) => [String(call.args[0]), String(call.args[1])]);
    expect(deleted.map(([stackName]) => stackName)).toEqual(['A', 'B', 'C']);
    for (const [, identifier] of deleted) {
      expect(identifier).toMatch(/^arn:aws:cloudformation:changeSet\//);
    }
    expect(fake.changeSets.get('A') ?? []).toEqual([]);
    expect(fake.changeSets.get('B') ?? []).toEqual([]);
    expect(fake.changeSets.get('C') ?? []).toEqual([]);
  });

  it('FR-5-10b: 承認拒否で ExecuteChangeSet と DeleteStack が 0 回(変更セットの作成・削除と再同期保存は発生しうる)', async () => {
    const { s, fake } = setupMixedOperations();
    s.control.decision = false;

    const result = await s.run({ allowDelete: true });

    expect(result.exitCode).toBe(0);
    // 承認の対象であった変更操作はゼロ。
    expect(fake.callsOf('executeChangeSet')).toHaveLength(0);
    expect(fake.callsOf('deleteStack')).toHaveLength(0);
    expect(s.backend.saveCalls).toHaveLength(0);
    // 「AWS 副作用ゼロ」ではない: 変更セットの作成・削除は発生している。
    expect(fake.callsOf('createChangeSet').length).toBeGreaterThan(0);
    expect(fake.callsOf('deleteChangeSet').length).toBeGreaterThan(0);
  });

  it('FR-5-10c: 承認拒否で未実行スタックの outcome が skipped、exit 0', async () => {
    const { s } = setupMixedOperations();
    s.control.decision = false;

    const result = await s.run({ allowDelete: true });

    // 拒否は利用者の明示的な意思による正常終了であり、失敗ではない。
    expect(result.exitCode).toBe(0);
    expect(result.report.cancelled).toBe(true);
    expect(
      result.report.result?.stacks.map((stack) => [
        stack.stackName,
        stack.outcome,
      ]),
    ).toEqual([
      ['A', 'skipped'],
      ['New', 'skipped'],
      ['Old', 'skipped'],
    ]);
    // Phase A で確定した差分は失われない(FR-12-6c1)。
    expect(result.report.diffs.map((diff) => diff.operation)).toEqual([
      'update',
      'create',
      'delete',
    ]);
    expect(
      s.progress
        .filter((event) => event.phase === 'skipped')
        .map((event) => event.message),
    ).toContain('承認が得られなかったため実行しませんでした');
  });

  it('FR-5-11: 拒否後の DeleteChangeSet が失敗したら警告を報告し exit 1(次回の残存回収に委ねる)', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    s.control.decision = false;
    fake.deleteChangeSet = async () => {
      throw new Error('injected DeleteChangeSet failure');
    };

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    // 拒否そのものは維持しつつ、後始末の失敗を報告する。
    expect(result.report.cancelled).toBe(true);
    const cleanup = result.report.result?.stacks.find(
      (stack) => stack.stackKey === '(cleanup)',
    );
    expect(cleanup?.outcome).toBe('failed');
    expect(cleanup?.errorMessage).toContain(
      '事前作成した変更セットの削除に失敗しました',
    );
    expect(cleanup?.errorMessage).toContain('次回実行の残存回収');
    expect(fake.callsOf('executeChangeSet')).toHaveLength(0);
  });
});

// ===========================================================================
// FR-5-19: 承認ポートが reject / throw した場合の fail-closed 回収
// ===========================================================================

function injectApprovalFailure(s: Harness, error: unknown): void {
  s.control.onApprove = () => {
    throw error;
  };
}

describe('承認フロー — 承認処理の失敗(FR-5-19)', () => {
  it('FR-5-19a: approve の reject 後に skipped 進捗通知も throw しても全変更セットを先に ARN 回収する', async () => {
    const config = configOf({
      'a.yaml': { stackName: 'A' },
      'b.yaml': { stackName: 'B' },
      'c.yaml': { stackName: 'C' },
    });
    const templates = templatesOf({
      'a.yaml': TEMPLATE_A,
      'b.yaml': TEMPLATE_B,
      'c.yaml': TEMPLATE_C,
    });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    injectApprovalFailure(s, new Error('injected approval failure'));

    let progressFailureObserved = false;
    const result = await s.run(
      {},
      {
        onProgress: (event) => {
          // CLI の approve と onProgress は同じ stderr に書き込みうる。承認要約の
          // 書き込み失敗後、skipped 通知も同じ故障で throw する実経路を固定する。
          if (event.phase === 'skipped') {
            progressFailureObserved = true;
            throw new Error('injected progress stderr failure');
          }
        },
      },
    );

    const deleted = fake
      .callsOf('deleteChangeSet')
      .map((call) => [String(call.args[0]), String(call.args[1])]);
    expect(deleted.map(([stackName]) => stackName)).toEqual(['A', 'B', 'C']);
    expect(
      deleted.every(([, id]) =>
        id.startsWith('arn:aws:cloudformation:changeSet/'),
      ),
    ).toBe(true);
    expect(progressFailureObserved).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(
      result.report.result?.stacks
        .filter((stack) => !stack.stackKey.startsWith('('))
        .map((stack) => [stack.stackName, stack.outcome]),
    ).toEqual([
      ['A', 'skipped'],
      ['B', 'skipped'],
      ['C', 'skipped'],
    ]);
    expect(
      result.report.result?.stacks.find(
        (stack) => stack.stackKey === '(approval)',
      ),
    ).toMatchObject({ outcome: 'failed' });
  });

  it('FR-5-19b: approve の reject 後に ExecuteChangeSet を行わない', async () => {
    const { s, fake } = setupMixedOperations();
    injectApprovalFailure(s, new Error('injected approval failure'));

    await s.run({ allowDelete: true });

    expect(fake.callsOf('executeChangeSet')).toHaveLength(0);
  });

  it('FR-5-19c: approve の reject 後に DeleteStack を行わない', async () => {
    const { s, fake } = setupMixedOperations();
    injectApprovalFailure(s, new Error('injected approval failure'));

    await s.run({ allowDelete: true });

    expect(fake.callsOf('deleteStack')).toHaveLength(0);
  });

  it('FR-5-19d: approve の reject で Phase B の全実行予定対象を skipped として報告する', async () => {
    const { s } = setupMixedOperations();
    injectApprovalFailure(s, new Error('injected approval failure'));

    const result = await s.run({ allowDelete: true });

    expect(
      result.report.result?.stacks
        .filter((stack) => !stack.stackKey.startsWith('('))
        .map((stack) => [stack.stackName, stack.outcome]),
    ).toEqual([
      ['A', 'skipped'],
      ['New', 'skipped'],
      ['Old', 'skipped'],
    ]);
  });

  it('FR-5-19e: approve の reject を承認処理の failed 結果として report に含める', async () => {
    const { s } = setupMixedOperations();
    injectApprovalFailure(s, new Error('injected approval failure'));

    const result = await s.run({ allowDelete: true });

    expect(
      result.report.result?.stacks.find(
        (stack) => stack.stackKey === '(approval)',
      ),
    ).toMatchObject({ outcome: 'failed' });
  });

  it('FR-5-19f: approve の reject は exit 1 で終了する', async () => {
    const { s } = setupMixedOperations();
    injectApprovalFailure(s, new Error('injected approval failure'));

    const result = await s.run({ allowDelete: true });

    expect(result.exitCode).toBe(1);
  });

  it('FR-5-19g: approve 失敗後の変更セット削除失敗を report し次回の残存回収を案内する', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    injectApprovalFailure(s, new Error('injected approval failure'));
    fake.deleteChangeSet = async () => {
      throw new Error('injected DeleteChangeSet failure');
    };

    let progressFailureObserved = false;
    const result = await s.run(
      {},
      {
        onProgress: (event) => {
          if (event.phase === 'skipped') {
            progressFailureObserved = true;
            throw new Error('injected progress stderr failure');
          }
        },
      },
    );

    expect(progressFailureObserved).toBe(true);
    expect(
      result.report.result?.stacks.find(
        (stack) => stack.stackKey === '(cleanup)',
      ),
    ).toMatchObject({
      outcome: 'failed',
      errorMessage: expect.stringContaining('次回実行の残存回収'),
    });
  });

  it('FR-5-19h: approve の CfnSyncError は全 NoEcho redactor を通し内部 cause を公開しない', async () => {
    // 値に包含関係を持たせ、スタック別 redactor の単純な順次適用で
    // `****-bravo` のような suffix が残る退行も検出する。
    const secretA = 'approval-secret';
    const secretB = 'approval-secret-bravo';
    const config = configOf({
      'secret-a.yaml': {
        stackName: 'SecretA',
        parameters: { Secret: secretA },
      },
      'secret-b.yaml': {
        stackName: 'SecretB',
        parameters: { Secret: secretB },
      },
    });
    const templates = templatesOf({
      'secret-a.yaml': TEMPLATE_SECRET,
      'secret-b.yaml': TEMPLATE_SECRET,
    });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    setExistingStacks(config, gatewayFor(s));
    injectApprovalFailure(
      s,
      new AwsError(`承認ポートが ${secretA} / ${secretB} を返しました`, {
        cause: new Error(`internal-cause:${secretA}:${secretB}`),
      }),
    );

    const result = await s.run();
    const rendered = renderJson(result.report);
    const approvalFailure = result.report.result?.stacks.find(
      (stack) => stack.stackKey === '(approval)',
    );

    expect(approvalFailure?.errorMessage).toBe(
      '承認処理に失敗しました: 承認ポートが **** / **** を返しました',
    );
    expect(rendered).toContain('****');
    expect(rendered).not.toContain(secretA);
    expect(rendered).not.toContain(secretB);
    expect(rendered).not.toContain('internal-cause');
  });

  it('FR-5-19i: approve の分類不能な例外は生メッセージを固定の安全な文言へ置換する', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    setExistingStacks(config, gatewayFor(s));
    injectApprovalFailure(s, new Error('raw approval transport failure'));

    const result = await s.run();
    const approvalFailure = result.report.result?.stacks.find(
      (stack) => stack.stackKey === '(approval)',
    );

    expect(approvalFailure?.errorMessage).toBe(
      '承認処理に失敗しました: 予期しないエラーが発生しました',
    );
  });
});

// ===========================================================================
// FR-5-12: Phase A の失敗は承認を求めず中断する
// ===========================================================================

/** 変更セット作成が失敗する詳細(空変更セットの定型文ではない FAILED)。 */
const FAILED_CHANGE_SET: Partial<ChangeSetDetail> = {
  status: 'FAILED',
  statusReason: 'Template format error: unsupported structure',
  changes: [],
};

describe('T-22 承認フロー — Phase A の失敗(FR-5-12)', () => {
  it('FR-5-12a: Phase A の 1 件が失敗したら approve が呼ばれず exit 1', async () => {
    const config = configOf({
      'a.yaml': { stackName: 'A' },
      'b.yaml': { stackName: 'B' },
    });
    const templates = templatesOf({
      'a.yaml': TEMPLATE_A,
      'b.yaml': TEMPLATE_B,
    });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    overrideChangeSetDetail(fake, { B: FAILED_CHANGE_SET });

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    // 差分が不完全な計画に対して不可逆な操作の承認を求めない。
    expect(s.approvals).toHaveLength(0);
    expect(s.timeline).not.toContain('approve');
    expect(fake.callsOf('executeChangeSet')).toHaveLength(0);
    expect(fake.callsOf('deleteStack')).toHaveLength(0);
    expect(s.backend.saveCalls).toHaveLength(0);
    expect(
      result.report.result?.stacks.find((stack) => stack.stackName === 'B')
        ?.outcome,
    ).toBe('failed');
  });

  it('FR-5-12b: --on-failure continue でも Phase A 失敗では独立スタックを実行しない', async () => {
    // A(失敗)と C(A に依存しない独立スタック)。
    const config = configOf({
      'a.yaml': { stackName: 'A' },
      'c.yaml': { stackName: 'C' },
    });
    const templates = templatesOf({
      'a.yaml': TEMPLATE_A,
      'c.yaml': TEMPLATE_C,
    });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    overrideChangeSetDetail(fake, { A: FAILED_CHANGE_SET });

    const result = await s.run({ onFailure: 'continue' });

    expect(result.exitCode).toBe(1);
    expect(s.approvals).toHaveLength(0);
    // --on-failure の適用範囲は Phase B に限られる(互換性破壊)。
    expect(fake.callsOf('executeChangeSet')).toHaveLength(0);
    expect(
      result.report.result?.stacks.find((stack) => stack.stackName === 'C')
        ?.outcome,
    ).toBe('skipped');
  });

  it('FR-9-2(__REQUIRED__): 必須値不足は Phase A の失敗として実行全体を中断する', async () => {
    const config = configOf({
      'secret.yaml': {
        stackName: 'SecretStack',
        parameters: { Secret: '__REQUIRED__' },
      },
      'c.yaml': { stackName: 'C' },
    });
    const templates = templatesOf({
      'secret.yaml': TEMPLATE_SECRET,
      'c.yaml': TEMPLATE_C,
    });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);

    const result = await s.run({ onFailure: 'continue' });

    expect(result.exitCode).toBe(1);
    expect(s.approvals).toHaveLength(0);
    // AWS 副作用ゼロで中断する(独立スタック C も実行しない)。
    expect(fake.callsOf('createChangeSet')).toHaveLength(0);
    expect(fake.callsOf('executeChangeSet')).toHaveLength(0);
    const failure = result.report.result?.stacks.find(
      (stack) => stack.stackName === 'SecretStack',
    );
    expect(failure?.outcome).toBe('failed');
    expect(failure?.errorMessage).toContain('__REQUIRED__');
    expect(
      result.report.result?.stacks.find((stack) => stack.stackName === 'C')
        ?.outcome,
    ).toBe('skipped');
  });

  it('FR-5-12c: Phase A 失敗で作成済みの変更セットが全削除される', async () => {
    // A は変更セット作成に成功、B は自身の変更セットを作る前に stackId 不一致で失敗する。
    const config = configOf({
      'a.yaml': { stackName: 'A' },
      'b.yaml': { stackName: 'B' },
    });
    const templates = templatesOf({
      'a.yaml': TEMPLATE_A,
      'b.yaml': TEMPLATE_B,
    });
    const initial = recordedState(config, templates, { modified: true });
    initial.stacks[`b.yaml@${REGION}`].stackId =
      'arn:aws:cloudformation:replaced-stack';
    const s = setup(config, templates, initial);
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    expect(s.approvals).toHaveLength(0);
    // A の変更セットだけが作成され、中断時に ARN 指定で削除される。
    expect(
      fake
        .callsOf('createChangeSet')
        .map((call) => (call.args[0] as { stackName: string }).stackName),
    ).toEqual(['A']);
    const deleted = fake.callsOf('deleteChangeSet');
    expect(deleted).toHaveLength(1);
    expect(String(deleted[0].args[0])).toBe('A');
    expect(String(deleted[0].args[1])).toMatch(
      /^arn:aws:cloudformation:changeSet\//,
    );
    expect(fake.changeSets.get('A') ?? []).toEqual([]);
    expect(fake.callsOf('executeChangeSet')).toHaveLength(0);
  });
});

// ===========================================================================
// FR-5-13 / FR-5-14a: 承認手段の検証と承認待ち中のロック
// ===========================================================================

describe('T-22 承認フロー — 承認手段とロック(FR-5-13 / FR-5-14)', () => {
  it('FR-5-13: approve 未注入かつ --auto-approve なしは STS・backend・CFN を 1 度も呼ばず GuardError で exit 1', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );

    const result = await s.run({}, { approve: undefined });

    expect(result.exitCode).toBe(1);
    // AWS・ステートバックエンドへの一切のアクセスの前に fail-closed で停止する。
    expect(s.sts.calls).toBe(0);
    expect(s.backend.calls).toHaveLength(0);
    // CloudFormation ゲートウェイの生成すら行われない。
    expect(s.gateways.size).toBe(0);
    expect(s.timeline).toEqual([]);
    const failure = result.report.result?.stacks[0];
    expect(failure?.outcome).toBe('failed');
    expect(failure?.errorMessage).toContain('承認手段が与えられていない');
    expect(failure?.errorMessage).toContain('--auto-approve');
  });

  it('FR-5-14a: approve 呼び出し中にロックが保持されており release がまだ呼ばれていない', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    setExistingStacks(config, gatewayFor(s));
    let lockDuringApproval: string | undefined;
    s.control.onApprove = async () => {
      lockDuringApproval = (await s.backend.readLock())?.runId;
    };

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    // 承認待ちの間もロックは保持され続ける。
    expect(lockDuringApproval).toBe(RUN_ID);
    expect(s.observations[0].releaseCalls).toBe(0);
    expect(s.observations[0].timeline).not.toContain('backend.releaseLock');
    // 解放は実行完了後(承認より後)に 1 回だけ。
    expect(s.backend.releaseCalls).toBe(1);
    expect(lastIndexOfCall(s.timeline, 'releaseLock')).toBeGreaterThan(
      indexOfCall(s.timeline, 'approve'),
    );
  });
});

// ===========================================================================
// FR-5-15: この実行で作られる Export を参照する対象
// ===========================================================================

const KNOWN_AFTER_APPLY = '{{changeSet:KNOWN_AFTER_APPLY}}';

/** 新規 CREATE 2 件(provider → consumer)の承認シナリオ。実 AWS 同様に殻を作る。 */
function setupNewExportChain() {
  const config = configOf({
    'a.yaml': { stackName: 'A' },
    'b.yaml': { stackName: 'B' },
  });
  const templates = templatesOf({
    'a.yaml': TEMPLATE_A,
    'b.yaml': TEMPLATE_B,
  });
  const s = setup(
    config,
    templates,
    withAccountId(createInitialState(), ACCOUNT),
  );
  const fake = gatewayFor(s);
  // CREATE 型 CreateChangeSet が REVIEW_IN_PROGRESS の殻を作る実挙動を模す。
  fake.strictStackExistence = true;
  return { s, fake };
}

describe('T-22 承認フロー — 新規 Export への依存(FR-5-15)', () => {
  it('FR-5-15a: この実行で create される依存先の Export を参照する対象も Phase A で CreateChangeSet され、承認は 1 回で済む', async () => {
    const { s, fake } = setupNewExportChain();

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    // 依存先 A がまだ存在しなくても B の変更セットを Phase A で作成できる
    // (CreateChangeSet は Export の実在を要求しない。design §5.3.1 の実測)。
    expect(s.approvals).toHaveLength(1);
    expect(s.observations[0].createdChangeSets).toEqual(['A', 'B']);
    expect(s.observations[0].executeChangeSet).toBe(0);
    expect(mutationOrder(fake)).toEqual([
      'create:A',
      'create:B',
      'execute:A',
      'execute:B',
    ]);
    // 事前判定・遅延実行(deferred)の機構は持たない = 保留のまま承認へ進む。
    expect(s.approvals[0].diffs.map((diff) => diff.operation)).toEqual([
      'create',
      'create',
    ]);
  });

  it('FR-5-15b: 保留値 {{changeSet:KNOWN_AFTER_APPLY}} を承認要約と差分出力へそのまま出し、cfnsync 側で解決・補完しない', async () => {
    const { s, fake } = setupNewExportChain();
    overrideChangeSetDetail(fake, {
      B: {
        changes: [
          {
            action: 'Add',
            logicalResourceId: 'BucketB',
            resourceType: 'AWS::S3::Bucket',
            replacement: 'False',
            scope: ['Properties'],
            details: [
              {
                target: {
                  attribute: 'Properties',
                  name: 'BucketName',
                  afterValue: KNOWN_AFTER_APPLY,
                },
                evaluation: 'Dynamic',
              },
            ],
          },
        ],
      },
    });

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    const consumerDiff = s.approvals[0].diffs.find(
      (diff) => diff.stackName === 'B',
    );
    // CloudFormation が返した値をそのまま提示する(独自解決・補完をしない)。
    expect(consumerDiff?.resources[0].details[0].target?.afterValue).toBe(
      KNOWN_AFTER_APPLY,
    );
    expect(renderApprovalSummary(s.approvals[0], { color: false })).toContain(
      KNOWN_AFTER_APPLY,
    );
    expect(renderText(result.report, { color: false })).toContain(
      KNOWN_AFTER_APPLY,
    );
  });
});

// ===========================================================================
// FR-5-17: 実行直前の再検査(承認待ちは任意長の競合窓)
// ===========================================================================

/** update 1 件の承認シナリオ。承認待ち中に競合を注入するための共通土台。 */
function setupSingleUpdate() {
  const config = configOf({ 'a.yaml': { stackName: 'A' } });
  const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
  const s = setup(
    config,
    templates,
    recordedState(config, templates, { modified: true }),
  );
  const fake = gatewayFor(s);
  setExistingStacks(config, fake);
  const ownChangeSet = () => {
    const call = fake.callsOf('createChangeSet')[0];
    const input = call.args[0] as { changeSetName: string };
    return {
      name: input.changeSetName,
      id: `arn:aws:cloudformation:changeSet/${input.changeSetName}`,
    };
  };
  return { s, fake, ownChangeSet };
}

describe('T-22 承認フロー — 実行直前の再検査(FR-5-17)', () => {
  it('FR-5-17a1: 承認後に自変更セットの name が差し替わっていたら ExecuteChangeSet を呼ばず停止する', async () => {
    const { s, fake, ownChangeSet } = setupSingleUpdate();
    s.control.onApprove = () => {
      // ARN は同一だが name が別物へ差し替えられた状況。
      fake.changeSets.set('A', [
        makeChangeSetSummary('someone-elses-name', { id: ownChangeSet().id }),
      ]);
    };

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    expect(fake.callsOf('executeChangeSet')).toHaveLength(0);
    expect(s.backend.saveCalls).toHaveLength(0);
    expect(result.report.result?.stacks[0].errorMessage).toContain(
      '実行直前の再検査',
    );
  });

  it('FR-5-17a2: 承認後に同名で ARN が差し替わっていたら ExecuteChangeSet を呼ばず停止する', async () => {
    const { s, fake, ownChangeSet } = setupSingleUpdate();
    s.control.onApprove = () => {
      fake.changeSets.set('A', [
        makeChangeSetSummary(ownChangeSet().name, {
          id: 'arn:aws:cloudformation:changeSet/replaced-arn',
        }),
      ]);
    };

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    expect(fake.callsOf('executeChangeSet')).toHaveLength(0);
    expect(result.report.result?.stacks[0].errorMessage).toContain(
      '実行直前の再検査',
    );
  });

  it('FR-5-17a3: 承認後・実行前に他主体の変更セットが現れたら ExecuteChangeSet を呼ばず停止する', async () => {
    const { s, fake, ownChangeSet } = setupSingleUpdate();
    s.control.onApprove = () => {
      const own = ownChangeSet();
      fake.changeSets.set('A', [
        makeChangeSetSummary(own.name, { id: own.id }),
        makeChangeSetSummary('human-raced-change-set'),
      ]);
    };

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    // ExecuteChangeSet は同一スタックの他の変更セットを暗黙に削除するため実行しない。
    expect(fake.callsOf('executeChangeSet')).toHaveLength(0);
    expect(fake.callsOf('deleteStack')).toHaveLength(0);
    expect(result.report.result?.stacks[0].errorMessage).toContain(
      '実行直前の再検査',
    );
  });

  it('FR-5-17b: 承認待ち中にスタックが差し替えられ stackId が変わったら UPDATE を実行せず停止する', async () => {
    const { s, fake } = setupSingleUpdate();
    s.control.onApprove = () => {
      fake.stacks.set(
        'A',
        makeStackSummary({
          stackName: 'A',
          stackId: 'arn:aws:cloudformation:recreated-stack',
          status: 'UPDATE_COMPLETE',
        }),
      );
    };

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    expect(fake.callsOf('executeChangeSet')).toHaveLength(0);
    expect(s.backend.saveCalls).toHaveLength(0);
    expect(result.report.result?.stacks[0].errorMessage).toMatch(
      /stackId|ARN|import/,
    );
  });

  it('FR-5-17c1: 承認待ち中に対象スタックが UPDATE_IN_PROGRESS になったら実行せず停止する', async () => {
    const { s, fake } = setupSingleUpdate();
    s.control.onApprove = () => {
      fake.stacks.set(
        'A',
        makeStackSummary({
          stackName: 'A',
          stackId: stackIdOf(REGION, 'A'),
          status: 'UPDATE_IN_PROGRESS',
        }),
      );
    };

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    expect(fake.callsOf('executeChangeSet')).toHaveLength(0);
    expect(result.report.result?.stacks[0].errorMessage).toContain(
      'UPDATE_IN_PROGRESS',
    );
  });

  it('FR-5-17c1: 承認待ち中に ROLLBACK_COMPLETE へ遷移したら allowlist 外として実行せず停止する', async () => {
    const { s, fake } = setupSingleUpdate();
    s.control.onApprove = () => {
      // *_IN_PROGRESS ではないが実行不能な終端状態。allowlist でなければ取りこぼす。
      fake.stacks.set(
        'A',
        makeStackSummary({
          stackName: 'A',
          stackId: stackIdOf(REGION, 'A'),
          status: 'ROLLBACK_COMPLETE',
        }),
      );
    };

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    expect(fake.callsOf('executeChangeSet')).toHaveLength(0);
    expect(fake.callsOf('deleteStack')).toHaveLength(0);
    expect(result.report.result?.stacks[0].errorMessage).toContain(
      'ROLLBACK_COMPLETE',
    );
  });

  it('FR-5-17d: 承認待ち中に force-unlock され所有権を失ったら以降の副作用を行わず中断する', async () => {
    const { s, fake } = setupSingleUpdate();
    s.control.onApprove = async () => {
      expect(await s.backend.forceUnlock(RUN_ID)).toMatchObject({
        released: true,
      });
      await s.backend.acquireLock({
        runId: 'replacement-owner',
        startedAt: '2026-07-20T12:05:00.000Z',
        owner: 'replacement-ci',
      });
    };

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    // 副作用の直前 fencing が所有権喪失を検出する。
    expect(fake.callsOf('executeChangeSet')).toHaveLength(0);
    expect(fake.callsOf('deleteStack')).toHaveLength(0);
    expect(s.backend.saveCalls).toHaveLength(0);
    expect(
      (result.report.result?.stacks ?? [])
        .map((stack) => stack.errorMessage ?? '')
        .join('\n'),
    ).toContain('所有権');
    expect((await s.backend.readLock())?.runId).toBe('replacement-owner');
  });
});

// ===========================================================================
// FR-5-16 / FR-5-18 / FR-12-6c3: JSON 出力の非回帰と再同期の開示
// ===========================================================================

/** JSON のトップレベルキーを出現順に取り出す(FR-5-16 の構造・順序の非回帰用)。 */
function jsonKeys(report: DeployReport): string[] {
  return Object.keys(JSON.parse(renderJson(report)) as Record<string, unknown>);
}

/** 空変更セットの再同期 1 件と、承認対象 1 件を含む実行。 */
function setupReconciliationRun() {
  const config = configOf({
    'a.yaml': { stackName: 'A' },
    'c.yaml': { stackName: 'C' },
  });
  const templates = templatesOf({
    'a.yaml': TEMPLATE_A,
    'c.yaml': TEMPLATE_C,
  });
  const s = setup(
    config,
    templates,
    recordedState(config, templates, { modified: true }),
  );
  const fake = gatewayFor(s);
  setExistingStacks(config, fake);
  overrideChangeSetDetail(fake, { A: EMPTY_CHANGE_SET });
  return { s, fake };
}

describe('T-22 承認フロー — JSON 非回帰と再同期の開示(FR-5-16 / FR-5-18)', () => {
  it('FR-5-16: --auto-approve の deploy JSON が 2 フェーズ化前のベースラインと connection/diffs/events/result で一致', async () => {
    const config = configOf({
      'a.yaml': { stackName: 'A' },
      'b.yaml': { stackName: 'B' },
    });
    const templates = templatesOf({
      'a.yaml': TEMPLATE_A,
      'b.yaml': TEMPLATE_B,
    });
    const auto = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    setExistingStacks(config, gatewayFor(auto));
    const approved = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    setExistingStacks(config, gatewayFor(approved));

    const autoResult = await auto.run({ autoApprove: true });
    const approvedResult = await approved.run();

    expect(autoResult.exitCode).toBe(0);
    // 既存フィールドの構造と順序を 2 フェーズ化で変えない(追加フィールドも出さない)。
    expect(jsonKeys(autoResult.report)).toEqual([
      'connection',
      'diffs',
      'events',
      'result',
    ]);
    const json = JSON.parse(renderJson(autoResult.report)) as {
      connection: unknown;
      diffs: Array<{ stackKey: string; operation: string }>;
      events: unknown[];
      result: { stacks: Array<{ stackKey: string; outcome: string }> };
    };
    expect(json.connection).toEqual({ accountId: ACCOUNT, regions: [REGION] });
    expect(json.diffs.map((diff) => [diff.stackKey, diff.operation])).toEqual([
      [`a.yaml@${REGION}`, 'update'],
      [`b.yaml@${REGION}`, 'update'],
    ]);
    expect(json.events).toEqual([]);
    expect(
      json.result.stacks.map((stack) => [stack.stackKey, stack.outcome]),
    ).toEqual([
      [`a.yaml@${REGION}`, 'succeeded'],
      [`b.yaml@${REGION}`, 'succeeded'],
    ]);
    // 承認経路で JSON を分岐させない: 承認して実行した場合と完全一致する。
    expect(renderJson(approvedResult.report)).toBe(
      renderJson(autoResult.report),
    );
  });

  it('FR-5-16: 成功した deploy の JSON に cancelled フィールドが存在しない(既存 schema 互換)', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    setExistingStacks(config, gatewayFor(s));

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    expect(jsonKeys(result.report)).not.toContain('cancelled');
    expect(
      Object.hasOwn(
        JSON.parse(renderJson(result.report)) as Record<string, unknown>,
        'cancelled',
      ),
    ).toBe(false);
  });

  it('FR-12-6c3: 拒否実行の JSON に exitCode と message フィールドが存在しない', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    setExistingStacks(config, gatewayFor(s));
    s.control.decision = false;

    const result = await s.run();

    // 旧専用 payload({exitCode, message})ではなく cancelled 付き deploy report。
    const keys = jsonKeys(result.report);
    expect(keys).not.toContain('exitCode');
    expect(keys).not.toContain('message');
    expect(keys).toEqual([
      'connection',
      'cancelled',
      'diffs',
      'events',
      'result',
    ]);
    expect(result.exitCode).toBe(0);
  });

  it('FR-5-18a: 再同期が発生した実行の JSON に stackKey・種別・stateUpdated を持つ reconciliations が現れる', async () => {
    const { s } = setupReconciliationRun();

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    const json = JSON.parse(renderJson(result.report)) as {
      reconciliations: unknown[];
    };
    expect(json.reconciliations).toEqual([
      {
        stackKey: `a.yaml@${REGION}`,
        region: REGION,
        kind: 'empty-change-set',
        stateUpdated: true,
      },
    ]);
  });

  it('FR-5-18a: 承認拒否時も発生した再同期が JSON から復元できる', async () => {
    const { s } = setupReconciliationRun();
    s.control.decision = false;

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    const json = JSON.parse(renderJson(result.report)) as {
      cancelled: boolean;
      reconciliations: Array<{ kind: string; stateUpdated: boolean }>;
    };
    // 拒否でも永続ステートは変わりうるため、標準出力から「何が変わったか」を復元できる。
    expect(json.cancelled).toBe(true);
    expect(json.reconciliations).toEqual([
      {
        stackKey: `a.yaml@${REGION}`,
        region: REGION,
        kind: 'empty-change-set',
        stateUpdated: true,
      },
    ]);
  });

  it('FR-5-18b: 通常終了で再同期が発生した実行の text 出力に stackKey・種別・state 更新有無が列挙される', async () => {
    const { s } = setupReconciliationRun();

    const result = await s.run();

    const text = renderText(result.report, { color: false });
    expect(text).toContain('== 再同期(state) ==');
    expect(text).toContain(
      `  a.yaml@${REGION} (${REGION}): 空変更セット(変更なし確認) / state 更新: あり`,
    );
  });

  it('FR-5-18b: 承認拒否時の text 出力にも再同期が列挙される', async () => {
    const { s } = setupReconciliationRun();
    s.control.decision = false;

    const result = await s.run();

    const text = renderText(result.report, { color: false });
    expect(text).toContain('== 再同期(state) ==');
    expect(text).toContain(`  a.yaml@${REGION} (${REGION}): 空変更セット`);
  });

  it('FR-5-18c: 再同期が発生しない実行の JSON に reconciliations フィールドが存在しない', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    setExistingStacks(config, gatewayFor(s));

    const result = await s.run();

    expect(result.report.reconciliations).toBeUndefined();
    expect(jsonKeys(result.report)).not.toContain('reconciliations');
  });

  it('FR-5-18c: 再同期が発生しない実行の text 出力は従来と一致する', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    setExistingStacks(config, gatewayFor(s));

    const result = await s.run();

    const text = renderText(result.report, { color: false });
    expect(text).not.toContain('再同期');
    expect(text.split('\n')[0]).toBe('== 接続先 ==');
  });

  it('FR-5-18d: 初回 accountId binding は reconciliations にも text 開示にも現れない', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    // accountId 未記録(初回)の state。ロック配下で accountId が保存される。
    const initial = recordedState(config, templates, { modified: true });
    const s = setup(config, templates, { ...initial, accountId: null });
    setExistingStacks(config, gatewayFor(s));

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    expect(s.backend.stored?.state.accountId).toBe(ACCOUNT);
    // 初回 accountId 記録は FR-5-5b の再同期とは別種であり、開示の対象ではない。
    expect(result.report.reconciliations).toBeUndefined();
    expect(jsonKeys(result.report)).not.toContain('reconciliations');
    expect(renderText(result.report, { color: false })).not.toContain('再同期');
  });
});

// ===========================================================================
// §5.3.1 / FR-5-5b: 承認拒否後の収束
// ===========================================================================

describe('T-22 承認フロー — 拒否後の収束', () => {
  it('§5.3.1: CREATE 対象の承認拒否後も DeleteStack が呼ばれず、次回実行の prepareStack が殻を回収して収束する', async () => {
    const config = configOf({ 'new.yaml': { stackName: 'New' } });
    const templates = templatesOf({ 'new.yaml': TEMPLATE_C });
    const s = setup(
      config,
      templates,
      withAccountId(createInitialState(), ACCOUNT),
    );
    const fake = gatewayFor(s);
    // CREATE 型変更セットの作成で REVIEW_IN_PROGRESS の殻が生まれる実挙動を模す。
    fake.strictStackExistence = true;
    s.control.decision = false;

    const first = await s.run();

    expect(first.exitCode).toBe(0);
    expect(first.report.cancelled).toBe(true);
    // 殻は AWS 上に残るが、殻へ DeleteStack を呼んではならない(安全不変条件)。
    expect(fake.stacks.get('New')?.status).toBe('REVIEW_IN_PROGRESS');
    expect(fake.callsOf('deleteStack')).toHaveLength(0);
    expect(fake.reviewInProgressDeleteCalls).toEqual([]);
    expect(fake.changeSets.get('New') ?? []).toEqual([]);

    // 次回実行: prepareStack が殻を回収し、その上に CREATE 型変更セットを作り直す。
    fake.calls.length = 0;
    s.control.decision = true;
    const second = await s.run();

    expect(second.exitCode).toBe(0);
    expect(fake.callsOf('deleteStack')).toHaveLength(0);
    expect(fake.reviewInProgressDeleteCalls).toEqual([]);
    expect(
      (fake.callsOf('createChangeSet')[0].args[0] as { changeSetType: string })
        .changeSetType,
    ).toBe('CREATE');
    expect(fake.callsOf('executeChangeSet')).toHaveLength(1);
    expect(fake.stacks.get('New')?.status).toBe('CREATE_COMPLETE');
    expect(
      s.backend.stored?.state.stacks[`new.yaml@${REGION}`].lastAction,
    ).toBe('CREATE');
  });

  it('FR-5-5b: AWS 操作成功・state 保存失敗の状態から、承認拒否を挟む実行でも再同期が保存され次回実行が unchanged になる', async () => {
    const config = configOf({
      'a.yaml': { stackName: 'A' },
      'c.yaml': { stackName: 'C' },
    });
    const templates = templatesOf({
      'a.yaml': TEMPLATE_A,
      'c.yaml': TEMPLATE_C,
    });
    const initial = recordedState(config, templates, { modified: true });
    // CREATE は成功したが state 保存前に中断した状態(state に a.yaml がない)。
    delete initial.stacks[`a.yaml@${REGION}`];
    const s = setup(config, templates, initial);
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    fake.stacks.set(
      'A',
      makeStackSummary({
        stackName: 'A',
        stackId: stackIdOf(REGION, 'A'),
        status: 'CREATE_COMPLETE',
        tags: { [MANAGEMENT_TAG_KEY]: STATE_ID },
      }),
    );
    fake.templates.set('A', TEMPLATE_A);
    s.control.decision = false;

    const first = await s.run();

    expect(first.exitCode).toBe(0);
    expect(first.report.cancelled).toBe(true);
    // 拒否は既成事実の再同期を取り消さない(取り消すと自動収束が永久に完了しない)。
    expect(first.report.reconciliations).toContainEqual({
      stackKey: `a.yaml@${REGION}`,
      region: REGION,
      kind: 'create-recovery',
      stateUpdated: true,
    });
    expect(s.backend.stored?.state.stacks[`a.yaml@${REGION}`].lastAction).toBe(
      'SYNC',
    );

    // 次回実行では a.yaml は変更なしとして収束している。
    fake.calls.length = 0;
    s.control.decision = true;
    const second = await s.run();

    expect(second.exitCode).toBe(0);
    expect(second.report.diffs).toContainEqual(
      expect.objectContaining({ stackName: 'A', operation: 'no-change' }),
    );
    expect(
      fake
        .callsOf('createChangeSet')
        .map((call) => (call.args[0] as { stackName: string }).stackName),
    ).toEqual(['C']);
  });
});

// ===========================================================================
// FR-11-10: (リージョン, スタック名)の一意性
// ===========================================================================

describe('T-22 承認フロー — (リージョン, スタック名)の一意性(FR-11-10)', () => {
  it('FR-11-10a: 同一リージョンで同じ stackName に解決される 2 スタックは対象キーを含む ConfigError で拒否される(AWS 呼び出し 0 回)', () => {
    // 設定検証の段階で拒否するため、deploy(= AWS・ステートバックエンドへのアクセス)へ
    // 到達しない。Phase A が変更セットを事前作成する設計では、同一物理スタックを指す
    // 2 つのスタックキーが互いの未実行変更セットを残存回収で消してしまう。
    let error: unknown;
    try {
      configOf({
        'a.yaml': { stackName: 'Shared' },
        'b.yaml': { stackName: 'Shared' },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as ConfigError).message;
    expect(message).toContain('Shared');
    expect(message).toContain(REGION);
    expect(message).toContain(`a.yaml@${REGION}`);
    expect(message).toContain(`b.yaml@${REGION}`);
  });

  it('FR-11-10b: テンプレートパス変更で delete(旧 state)+create(新 config)が同一 (region, stackName) を指す場合、AWS 副作用前に fail-closed で拒否しリネーム移行を案内する', async () => {
    // old.yaml(stackName: Shared)→ new.yaml(stackName: Shared)へのパス変更。
    // 旧キーは deleted、新キーは added だが同一物理スタックを指す。
    const oldConfig = configOf({ 'old.yaml': { stackName: 'Shared' } });
    const oldTemplates = templatesOf({ 'old.yaml': TEMPLATE_C });
    const config = configOf({ 'new.yaml': { stackName: 'Shared' } });
    const templates = templatesOf({ 'new.yaml': TEMPLATE_C });
    const s = setup(config, templates, recordedState(oldConfig, oldTemplates));

    const result = await s.run({ allowDelete: true });

    expect(result.exitCode).toBe(1);
    // 承認も AWS 副作用も発生しない(CloudFormation ゲートウェイの生成すらしない)。
    expect(s.approvals).toHaveLength(0);
    expect(s.gateways.size).toBe(0);
    expect(s.backend.saveCalls).toHaveLength(0);
    const failure = (result.report.result?.stacks ?? []).find(
      (stack) => stack.outcome === 'failed',
    );
    expect(failure?.errorMessage).toMatch(/管理対象|リネーム|パス変更/);
  });

  it('FR-11-10c: 異名リネーム(delete 旧名 + create 新名)は拒否されない', async () => {
    const oldConfig = configOf({ 'old.yaml': { stackName: 'Old' } });
    const oldTemplates = templatesOf({ 'old.yaml': TEMPLATE_C });
    const config = configOf({ 'new.yaml': { stackName: 'New' } });
    const templates = templatesOf({ 'new.yaml': TEMPLATE_C });
    const s = setup(config, templates, recordedState(oldConfig, oldTemplates));
    const fake = gatewayFor(s);
    fake.strictStackExistence = true;
    fake.stacks.set(
      'Old',
      makeStackSummary({
        stackName: 'Old',
        stackId: stackIdOf(REGION, 'Old'),
        status: 'CREATE_COMPLETE',
      }),
    );
    fake.waitResults.set('Old', [
      makeStackSummary({ stackName: 'Old', status: 'DELETE_COMPLETE' }),
    ]);

    const result = await s.run({ allowDelete: true });

    expect(result.exitCode).toBe(0);
    expect(s.approvals).toHaveLength(1);
    expect(mutationOrder(fake)).toEqual([
      'create:New',
      'execute:New',
      `deleteStack:${stackIdOf(REGION, 'Old')}`,
    ]);
  });

  it('FR-11-10c: 同一 stackName を 3 リージョンへ配る構成は拒否されない', async () => {
    const regions = [REGION, REGION_2, REGION_3];
    const config = configOf(
      { 'a.yaml': { stackName: 'Shared', regions } },
      regions,
    );
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    for (const region of regions) {
      setExistingStacks(config, gatewayFor(s, region), region);
    }

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    // 同一スタック名でもリージョンが異なれば別の物理スタックであり正常。
    expect(s.approvals).toHaveLength(1);
    expect(s.observations[0].createdChangeSets).toEqual([
      'Shared',
      'Shared',
      'Shared',
    ]);
    for (const region of regions) {
      expect(gatewayFor(s, region).callsOf('executeChangeSet')).toHaveLength(1);
    }
  });

  it('FR-11-10c: --region による既定リージョン上書き後も正常な構成は拒否されない', async () => {
    // CLI の --region 相当(defaultRegion を差し替えて再検証する)。
    const loaded = configOf(
      {
        'a.yaml': { stackName: 'A' },
        'c.yaml': { stackName: 'C' },
      },
      [REGION, REGION_2],
    );
    const overridden = { ...loaded, defaultRegion: REGION_2 };
    const templates = templatesOf({
      'a.yaml': TEMPLATE_A,
      'c.yaml': TEMPLATE_C,
    });

    expect(() => validateEffectiveConfig(overridden)).not.toThrow();

    const s = setup(
      overridden,
      templates,
      recordedState(overridden, templates, { modified: true }),
    );
    setExistingStacks(overridden, gatewayFor(s, REGION_2), REGION_2);

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    expect(s.approvals).toHaveLength(1);
    expect(s.approvals[0].diffs.map((diff) => diff.stackKey)).toEqual([
      `a.yaml@${REGION_2}`,
      `c.yaml@${REGION_2}`,
    ]);
  });

  it('FR-11-10c: stackNamePrefix から導出した異なるスタック名は拒否されない', async () => {
    const config = configOf({ 'a.yaml': {}, 'c.yaml': {} }, [REGION], {
      stackNamePrefix: 'prod-',
    });
    const templates = templatesOf({
      'a.yaml': TEMPLATE_A,
      'c.yaml': TEMPLATE_C,
    });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    setExistingStacks(config, gatewayFor(s));

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    expect(s.approvals).toHaveLength(1);
    // 導出規約由来でも異なるスタック名なら正常。
    expect(s.observations[0].createdChangeSets).toEqual(['prod-a', 'prod-c']);
  });
});

// ===========================================================================
// FR-5-7c: 判別表示の境界(操作種別 × 空 resources)
// ===========================================================================

describe('T-22 承認フロー — 0 件注記の境界(FR-5-7c)', () => {
  it('FR-5-7c: plan / deploy の create/update/delete/no-change × 空 resources の境界で表示が正しい', () => {
    // 4 種の操作すべてが resources 空になりうる。注記は create / update に限る。
    const operations = ['create', 'update', 'delete', 'no-change'] as const;
    const report: DeployReport = {
      connection: { accountId: ACCOUNT, regions: [REGION] },
      diffs: operations.map((operation) =>
        buildStackDiff({
          stackKey: `${operation}.yaml@${REGION}`,
          region: REGION,
          stackName: operation,
          operation,
          noEchoParams: [],
        }),
      ),
    };

    const lines = renderText(report, { color: false }).split('\n');
    const noteFor = (operation: string): string => {
      const index = lines.findIndex((line) =>
        line.startsWith(`[${operation}] ${operation}.yaml@${REGION}`),
      );
      expect(index).toBeGreaterThanOrEqual(0);
      return lines[index + 1];
    };

    expect(noteFor('create')).toContain('CloudFormation リソース差分 0 件');
    expect(noteFor('update')).toContain('CloudFormation リソース差分 0 件');
    // 削除プレビューと no-change はリソース差分 0 件が正常であり、注記の対象にしない。
    // FR-5-7e: そのうえで削除は「変更なし」ではなく削除専用の表示にする。
    expect(noteFor('delete')).not.toContain('CloudFormation リソース差分 0 件');
    expect(noteFor('delete')).not.toBe('  (変更なし)');
    expect(noteFor('delete')).toContain('削除対象');
    expect(noteFor('no-change')).toBe('  (変更なし)');

    const summary = buildApprovalSummary(report.diffs);
    expect(summary).toMatchObject({
      create: 1,
      update: 1,
      delete: 1,
      resourcelessChanges: 2,
    });
    const summaryText = renderApprovalSummary(
      {
        connection: report.connection,
        diffs: report.diffs,
        summary,
        allowDelete: true,
      },
      { color: false },
    );
    // 承認要約でも同じ境界規則に従う(no-change は要約に出さない)。
    expect(summaryText).not.toContain('[no-change]');
    expect(
      summaryText
        .split('\n')
        .filter((line) => line.includes('CloudFormation リソース差分 0 件')),
    ).toHaveLength(2);
    expect(summaryText).toContain(
      '注記: CloudFormation リソース差分が 0 件の create / update が 2 件あります',
    );
  });
});
