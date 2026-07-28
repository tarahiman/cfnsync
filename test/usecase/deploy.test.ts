/**
 * T-14 usecase/deploy — デプロイフロー統合。
 *
 * tasks.md §6 T-14 の表を正本とし、各テスト名に対応 ID を明記する。
 * 実 AWS は使わず、共有 timeline 付きインメモリフェイクで fencing / CAS / 直列順を固定する。
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
import { AwsError } from '../../src/core/errors.js';
import {
  type CfnSyncState,
  createInitialState,
  upsertStackEntry,
  withAccountId,
} from '../../src/core/state.js';
import { analyzeTemplate } from '../../src/core/template.js';
import type {
  CloudFormationGateway,
  StackEvent,
} from '../../src/ports/index.js';
import { renderJson, renderText } from '../../src/report/index.js';
import { deploy } from '../../src/usecase/deploy.js';
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
const STATE_ID = 'aabbccddeeff';
const RUN_ID = 'run14';
const FIXED_NOW = () => new Date('2026-07-20T12:00:00.000Z');

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

const TEMPLATE_B = `
AWSTemplateFormatVersion: '2010-09-09'
Resources:
  BucketB:
    Type: AWS::S3::Bucket
    Properties:
      BucketName:
        Fn::ImportValue: SharedValue
`;

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

const DEFAULT_SECRET = 'Default-NoEcho-Secret-Value';
const TEMPLATE_SECRET_DEFAULT = `
AWSTemplateFormatVersion: '2010-09-09'
Parameters:
  Secret:
    Type: String
    NoEcho: true
    Default: ${DEFAULT_SECRET}
Resources:
  Bucket:
    Type: AWS::S3::Bucket
`;

function configOf(
  stacks: Record<string, unknown>,
  allowedRegions = [REGION],
): CfnSyncConfig {
  return validateConfig({
    version: 1,
    defaultRegion: allowedRegions[0],
    allowedAccounts: [ACCOUNT],
    allowedRegions,
    stacks,
  });
}

function templatesOf(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

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
      stackId: `arn:aws:cloudformation:${target.region}:${ACCOUNT}:stack/${target.stackName}/managed`,
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

function setup(
  config: CfnSyncConfig,
  templates: Map<string, string>,
  state?: CfnSyncState,
) {
  const timeline: string[] = [];
  const emitted: StackEventLineForTest[] = [];
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
    async getCallerIdentity() {
      timeline.push('sts.getCallerIdentity');
      return { accountId: ACCOUNT, arn: `arn:aws:iam::${ACCOUNT}:role/test` };
    },
  };
  const run = (
    options: {
      dryRun?: boolean;
      allowDelete?: boolean;
      onFailure?: 'stop' | 'continue';
    } = {},
  ) =>
    deploy({
      config,
      configDir: '/repo',
      templates,
      deps: {
        cfnFactory,
        sts,
        backend,
        now: FIXED_NOW,
        runId: () => RUN_ID,
        onEvent: (event) => emitted.push(event),
        onProgress: (event) => progress.push(event),
      },
      options: { autoApprove: true, ...options },
    });
  return { timeline, emitted, progress, backend, gateways, cfnFactory, run };
}

type StackEventLineForTest = {
  stackKey: string;
  region: string;
  timestamp: string;
  logicalResourceId: string;
  resourceType: string;
  resourceStatus: string;
  resourceStatusReason?: string;
};

type ProgressEventForTest = {
  stackKey: string;
  region: string;
  phase: string;
  message: string;
};

function gatewayFor(
  setupResult: ReturnType<typeof setup>,
  region = REGION,
): FakeCloudFormationGateway {
  setupResult.cfnFactory(region);
  return setupResult.gateways.get(region) as FakeCloudFormationGateway;
}

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
        stackId: `arn:aws:cloudformation:${target.region}:${ACCOUNT}:stack/${target.stackName}/managed`,
        status: 'UPDATE_COMPLETE',
      }),
    );
  }
}

function mutationOrder(fake: FakeCloudFormationGateway): string[] {
  return fake.calls
    .filter(
      (call) =>
        call.method === 'createChangeSet' || call.method === 'executeChangeSet',
    )
    .map((call) => {
      if (call.method === 'createChangeSet') {
        return `create:${(call.args[0] as { stackName: string }).stackName}`;
      }
      return `execute:${String(call.args[0])}`;
    });
}

describe('deploy — T-14 integration', () => {
  it('FR-7-8: STS 解決後の allowedAccounts 不一致でも report.connection は解決済み accountId', async () => {
    const config = validateConfig({
      version: 1,
      defaultRegion: REGION,
      allowedAccounts: ['999999999999'],
      allowedRegions: [REGION],
      stacks: { 'a.yaml': { stackName: 'A' } },
    });
    const s = setup(config, templatesOf({ 'a.yaml': TEMPLATE_A }));

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    expect(result.report.connection.accountId).toBe(ACCOUNT);
    expect(s.backend.calls).toHaveLength(0);
    expect(s.gateways.size).toBe(0);
  });

  it('FR-7-8: STS 解決失敗時だけ connection.accountId は (unresolved)', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const backend = new FakeStateBackend([], undefined, STATE_ID);
    const cfn = new FakeCloudFormationGateway();

    const result = await deploy({
      config,
      templates: templatesOf({ 'a.yaml': TEMPLATE_A }),
      deps: {
        cfnFactory: () => cfn,
        sts: {
          async getCallerIdentity() {
            throw new Error('STS unavailable');
          },
        },
        backend,
      },
      options: {},
    });

    expect(result.exitCode).toBe(1);
    expect(result.report.connection.accountId).toBe('(unresolved)');
    expect(backend.calls).toHaveLength(0);
    expect(cfn.calls).toHaveLength(0);
  });

  it('NFR-5: added スタックの復旧判定で取得した DescribeStacks 結果を状態ガードへ引き渡す', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const s = setup(config, templatesOf({ 'a.yaml': TEMPLATE_A }));
    const fake = gatewayFor(s);

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    // Phase A の復旧判定で 1 回、Phase B の実行直前再検査(FR-5-17c)で 1 回。
    // Phase A 内で状態ガードへ結果を引き渡す(＝2 回呼ばない)ことが本テストの主旨。
    expect(fake.callsOf('describeStack')).toHaveLength(2);
  });

  it('回帰(実 AWS 疎通で判明): 真の新規 CREATE(スタック不存在)は ListChangeSets より先に CreateChangeSet へ進む', async () => {
    // 実 AWS では、CloudFormation が一度も認識していないスタック名に対する
    // ListChangeSets は ValidationError("Stack [...] does not exist") を返す。
    // strictStackExistence でこの実挙動を模し、prepareStack が「不存在」と
    // 「REVIEW_IN_PROGRESS 以外で実在」を混同して reclaimStaleChangeSets(→ListChangeSets)
    // を CreateChangeSet より先に呼んでしまう回帰を検出する
    // (修正前は本テストが ValidationError 相当で reject していた)。
    // CREATE 型 CreateChangeSet 成功後は実 AWS 同様スタックが REVIEW_IN_PROGRESS で
    // 生成されるため、実行直前再検査(FR-2-11)による ListChangeSets 呼び出し自体は
    // CreateChangeSet の**後**であれば正しく成功する。
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const s = setup(config, templatesOf({ 'a.yaml': TEMPLATE_A }));
    const fake = gatewayFor(s);
    fake.strictStackExistence = true;
    // 意図的に fake.stacks へ 'A' を登録しない = CloudFormation にスタックが一切存在しない。

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    const sequence = fake.methodSequence();
    const createIdx = sequence.indexOf('createChangeSet');
    expect(createIdx).toBeGreaterThanOrEqual(0);
    // CreateChangeSet より前に ListChangeSets(=不存在スタックへの ListChangeSets)が
    // 呼ばれていないこと。修正前は reclaimStaleChangeSets 経由でここに listChangeSets が
    // 入り込み、スタック不存在エラーで中断していた。
    expect(sequence.slice(0, createIdx)).not.toContain('listChangeSets');
    expect(
      (fake.callsOf('createChangeSet')[0].args[0] as { changeSetType: string })
        .changeSetType,
    ).toBe('CREATE');
  });

  it('FR-5-1 / FR-5-2a: 全変更セット作成が全実行に先行し、実行は依存順になる', async () => {
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
    // FR-5-5a: Phase A で全対象の変更セットを作成してから、Phase B で依存順に実行する。
    // 2 フェーズ化前は create:A → execute:A → create:B → execute:B の逐次だった。
    expect(mutationOrder(fake)).toEqual([
      'create:A',
      'create:B',
      'execute:A',
      'execute:B',
    ]);
    expect(result.report.diffs.map((diff) => diff.stackName)).toEqual([
      'A',
      'B',
    ]);
    expect(s.backend.stored?.state.stacks[`a.yaml@${REGION}`].stackId).toBe(
      `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/A/managed`,
    );
  });

  it('FR-8-7(deploy統合): リージョン別実効パラメータで依存順を決め、新しい依存名を state へ保存する', async () => {
    const parameterizedProvider = `
Parameters:
  Namespace:
    Type: String
    Default: default
Resources: {}
Outputs:
  Shared:
    Value: value
    Export:
      Name: !Sub '\${Namespace}-shared'
`;
    const parameterizedConsumer = `
Parameters:
  Namespace:
    Type: String
    Default: default
Resources:
  Consumer:
    Type: Custom::Consumer
    Properties:
      Value:
        Fn::ImportValue:
          Fn::Sub: '\${Namespace}-shared'
`;
    const config = configOf(
      {
        'provider.yaml': {
          stackName: 'Provider',
          regions: [REGION, REGION_2],
          parameters: { Namespace: 'common' },
          regionOverrides: {
            [REGION_2]: { parameters: { Namespace: 'west' } },
          },
        },
        'consumer.yaml': {
          stackName: 'Consumer',
          regions: [REGION, REGION_2],
          parameters: { Namespace: 'common' },
          regionOverrides: {
            [REGION_2]: { parameters: { Namespace: 'west' } },
          },
        },
      },
      [REGION, REGION_2],
    );
    const templates = templatesOf({
      'provider.yaml': parameterizedProvider,
      'consumer.yaml': parameterizedConsumer,
    });
    const previous = recordedState(config, templates, { modified: true });
    for (const entry of Object.values(previous.stacks)) {
      entry.exports = entry.exports.map(() => 'old-shared');
      entry.imports = entry.imports.map(() => 'old-shared');
    }
    const s = setup(config, templates, previous);
    for (const region of [REGION, REGION_2]) {
      setExistingStacks(config, gatewayFor(s, region), region);
    }

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    // FR-5-5a: Phase A で全変更セットを作成してから Phase B で依存順に実行する。
    expect(mutationOrder(gatewayFor(s, REGION))).toEqual([
      'create:Provider',
      'create:Consumer',
      'execute:Provider',
      'execute:Consumer',
    ]);
    expect(mutationOrder(gatewayFor(s, REGION_2))).toEqual([
      'create:Provider',
      'create:Consumer',
      'execute:Provider',
      'execute:Consumer',
    ]);
    expect(
      s.backend.stored?.state.stacks[`provider.yaml@${REGION}`].exports,
    ).toEqual(['common-shared']);
    expect(
      s.backend.stored?.state.stacks[`consumer.yaml@${REGION}`].imports,
    ).toEqual(['common-shared']);
    expect(
      s.backend.stored?.state.stacks[`provider.yaml@${REGION_2}`].exports,
    ).toEqual(['west-shared']);
    expect(
      s.backend.stored?.state.stacks[`consumer.yaml@${REGION_2}`].imports,
    ).toEqual(['west-shared']);
  });

  it('FR-5-3: dry-run は差分 describe 後に変更セットを削除し、実行しない', async () => {
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
    expect(fake.callsOf('deleteChangeSet')).toHaveLength(1);
    expect(fake.methodSequence().indexOf('deleteChangeSet')).toBeGreaterThan(
      fake.methodSequence().indexOf('waitForChangeSet'),
    );
  });

  it('FR-4-1 / FR-4-2 / FR-4-3 / FR-1-3: イベントを逐次収集し、失敗原因・rollback を報告して成功分だけ保存する', async () => {
    const config = configOf({
      'a.yaml': { stackName: 'A' },
      'b.yaml': { stackName: 'B' },
    });
    const templates = templatesOf({
      'a.yaml': TEMPLATE_A,
      'b.yaml': TEMPLATE_C,
    });
    const initial = recordedState(config, templates, { modified: true });
    const oldBHash = initial.stacks['b.yaml@ap-northeast-1'].inputsHash;
    const s = setup(config, templates, initial);
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    const failureEvent: StackEvent = {
      eventId: 'e1',
      timestamp: '2026-07-20T12:01:00.000Z',
      logicalResourceId: 'BucketB',
      resourceType: 'AWS::S3::Bucket',
      resourceStatus: 'UPDATE_FAILED',
      resourceStatusReason: 'bucket policy rejected',
    };
    const historicalEvent: StackEvent = {
      ...failureEvent,
      eventId: 'historical',
      timestamp: '2026-07-20T11:59:00.000Z',
      logicalResourceId: 'OldResource',
      resourceStatus: 'UPDATE_COMPLETE',
      resourceStatusReason: undefined,
    };
    fake.events.set('B', [historicalEvent]);
    fake.waitEvents.set('B', [failureEvent]);
    fake.waitResults.set('B', [
      makeStackSummary({
        stackName: 'B',
        status: 'UPDATE_ROLLBACK_COMPLETE',
        statusReason: 'rolled back',
      }),
    ]);

    const result = await s.run({ onFailure: 'stop' });

    expect(result.exitCode).toBe(1);
    expect(result.report.events).toEqual([
      expect.objectContaining({
        logicalResourceId: 'BucketB',
        resourceStatusReason: 'bucket policy rejected',
      }),
    ]);
    expect(s.emitted).toEqual(result.report.events);
    expect(result.report.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ logicalResourceId: 'OldResource' }),
      ]),
    );
    const cursorCall = fake.calls.findIndex(
      (call) => call.method === 'getStackEventCursor' && call.args[0] === 'B',
    );
    const executeCall = fake.calls.findIndex(
      (call) => call.method === 'executeChangeSet' && call.args[0] === 'B',
    );
    expect(cursorCall).toBeGreaterThanOrEqual(0);
    expect(cursorCall).toBeLessThan(executeCall);
    expect(result.report.result?.stacks).toContainEqual(
      expect.objectContaining({
        stackName: 'B',
        outcome: 'failed',
        rolledBack: true,
        errorMessage: expect.stringContaining('bucket policy rejected'),
      }),
    );
    expect(
      s.backend.stored?.state.stacks['a.yaml@ap-northeast-1'].inputsHash,
    ).not.toContain('old-');
    expect(
      s.backend.stored?.state.stacks['b.yaml@ap-northeast-1'].inputsHash,
    ).toBe(oldBHash);
  });

  it('FR-4-2/NFR-4 / FR-4-3: ROLLBACK_IN_PROGRESS 観測後の wait 例外は公開本文だけを報告し cause・NoEcho 実値を秘匿する', async () => {
    const secret = 'NoEcho-Actual-Value';
    const causeMarker = 'INTERNAL_CAUSE_MARKER';
    const config = configOf({
      'secret.yaml': {
        stackName: 'SecretStack',
        parameters: { Secret: secret },
      },
    });
    const templates = templatesOf({ 'secret.yaml': TEMPLATE_SECRET });
    const initial = recordedState(config, templates, { modified: true });
    const oldHash = initial.stacks[`secret.yaml@${REGION}`].inputsHash;
    const s = setup(config, templates, initial);
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    fake.waitEvents.set('SecretStack', [
      {
        eventId: 'rollback-started',
        timestamp: '2026-07-20T12:01:00.000Z',
        logicalResourceId: 'SecretStack',
        resourceType: 'AWS::CloudFormation::Stack',
        resourceStatus: 'ROLLBACK_IN_PROGRESS',
        resourceStatusReason: 'rollback started',
      },
    ]);
    const waitForStack = fake.waitForStack.bind(fake);
    fake.waitForStack = async (stackName, options) => {
      await waitForStack(stackName, options);
      throw new AwsError('CloudFormation DescribeStackEvents に失敗しました', {
        stackKey: `internal-secret.yaml@${REGION}`,
        region: REGION,
        cause: new Error(`${causeMarker}: credential=${secret}`),
      });
    };

    const result = await s.run();
    const failed = result.report.result?.stacks.find(
      (stack) => stack.stackName === 'SecretStack',
    );
    const json = renderJson(result.report);
    const text = renderText(result.report);
    const failedProgress = s.progress.find(
      (progress) =>
        progress.stackKey === `secret.yaml@${REGION}` &&
        progress.phase === 'failed',
    );

    expect(result.exitCode).toBe(1);
    expect(failed).toMatchObject({
      stackKey: `secret.yaml@${REGION}`,
      region: REGION,
      outcome: 'failed',
      errorMessage: 'CloudFormation DescribeStackEvents に失敗しました',
      rolledBack: true,
    });
    expect(failed?.errorMessage).not.toContain(causeMarker);
    expect(failed?.errorMessage).not.toContain(secret);
    expect(failed?.errorMessage).not.toContain('(stackKey:');
    expect(failed?.errorMessage).not.toContain('(region:');
    expect(json).not.toContain(causeMarker);
    expect(json).not.toContain(secret);
    expect(failedProgress?.message).toBe(failed?.errorMessage);
    expect(text).toContain(`secret.yaml@${REGION}`);
    expect(text).toContain('CloudFormation DescribeStackEvents に失敗しました');
    expect(text).toContain('ROLLBACK_IN_PROGRESS');
    expect(s.backend.saveCalls).toHaveLength(0);
    expect(
      s.backend.stored?.state.stacks[`secret.yaml@${REGION}`].inputsHash,
    ).toBe(oldHash);
    expect(s.backend.releaseCalls).toBe(1);
  });

  it('FR-4-2(安全境界): 分類不能な wait 例外は固定の公開文言へ置換する', async () => {
    const internalMarker = 'UNCLASSIFIED_INTERNAL_MARKER';
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    const waitForStack = fake.waitForStack.bind(fake);
    fake.waitForStack = async (stackName, options) => {
      await waitForStack(stackName, options);
      throw new Error(internalMarker);
    };

    const result = await s.run();
    const failed = result.report.result?.stacks.find(
      (stack) => stack.stackName === 'A',
    );

    expect(result.exitCode).toBe(1);
    expect(failed).toMatchObject({
      outcome: 'failed',
      errorMessage: 'CloudFormation スタックの完了待機に失敗しました',
      rolledBack: false,
    });
    expect(failed?.errorMessage).not.toContain(internalMarker);
    expect(s.backend.saveCalls).toHaveLength(0);
  });

  it('FR-4-3(否定): ExecuteChangeSet 前の ROLLBACK_COMPLETE guard 拒否は rolledBack false', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const s = setup(config, templatesOf({ 'a.yaml': TEMPLATE_A }));
    const fake = gatewayFor(s);
    fake.stacks.set(
      'A',
      makeStackSummary({
        stackName: 'A',
        status: 'ROLLBACK_COMPLETE',
      }),
    );

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    expect(result.report.result?.stacks).toContainEqual(
      expect.objectContaining({
        stackName: 'A',
        outcome: 'failed',
        rolledBack: false,
      }),
    );
    expect(fake.callsOf('executeChangeSet')).toHaveLength(0);
  });

  it('FR-4-3(否定): rollback を観測しない UPDATE_FAILED は reason に ROLLBACK が含まれても false', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    fake.waitEvents.set('A', [
      {
        eventId: 'failed-with-text',
        timestamp: '2026-07-20T12:01:00.000Z',
        logicalResourceId: 'BucketA',
        resourceType: 'AWS::S3::Bucket',
        resourceStatus: 'UPDATE_FAILED',
        resourceStatusReason:
          'ROLLBACK is mentioned only as troubleshooting guidance',
      },
    ]);
    fake.waitResults.set('A', [
      makeStackSummary({
        stackName: 'A',
        status: 'UPDATE_FAILED',
        statusReason: 'ROLLBACK was not observed',
      }),
    ]);

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    expect(result.report.result?.stacks).toContainEqual(
      expect.objectContaining({
        stackName: 'A',
        outcome: 'failed',
        rolledBack: false,
      }),
    );
    expect(fake.callsOf('executeChangeSet')).toHaveLength(1);
  });

  it('FR-4-3(否定): allowlist 外の *_ROLLBACK_* 類似 status は rolledBack false', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    fake.waitEvents.set('A', [
      {
        eventId: 'unknown-rollback-like-status',
        timestamp: '2026-07-20T12:01:00.000Z',
        logicalResourceId: 'A',
        resourceType: 'AWS::CloudFormation::Stack',
        resourceStatus: 'UPDATE_ROLLBACK_PAUSED',
        resourceStatusReason: 'unknown status must not imply rollback',
      },
    ]);
    fake.waitResults.set('A', [
      makeStackSummary({
        stackName: 'A',
        status: 'UPDATE_FAILED',
      }),
    ]);

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    expect(result.report.result?.stacks).toContainEqual(
      expect.objectContaining({
        stackName: 'A',
        outcome: 'failed',
        rolledBack: false,
      }),
    );
    expect(fake.callsOf('executeChangeSet')).toHaveLength(1);
  });

  it('NFR-4: ResourceStatusReason と最終 errorMessage の NoEcho 実値を text/JSON 格納前にマスクする', async () => {
    const secret = 'S3cr3t-Value-From-Config';
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
    fake.waitEvents.set('SecretStack', [
      {
        eventId: 'secret-failure',
        timestamp: '2026-07-20T12:01:00.000Z',
        logicalResourceId: 'Bucket',
        resourceType: 'AWS::S3::Bucket',
        resourceStatus: 'UPDATE_FAILED',
        resourceStatusReason: `custom resource rejected password ${secret}`,
      },
    ]);
    fake.waitResults.set('SecretStack', [
      makeStackSummary({
        stackName: 'SecretStack',
        status: 'UPDATE_ROLLBACK_COMPLETE',
        statusReason: `rollback after ${secret}`,
      }),
    ]);

    const result = await s.run();
    const text = renderText(result.report);
    const json = renderJson(result.report);

    expect(result.exitCode).toBe(1);
    expect(text).not.toContain(secret);
    expect(json).not.toContain(secret);
    expect(text).toContain('****');
    expect(json).toContain('****');
    expect(s.emitted[0].resourceStatusReason).toContain('****');
    expect(s.emitted[0].resourceStatusReason).not.toContain(secret);
  });

  it('NFR-4(Default/event): NoEcho template Default をイベントと failed progress/report の格納前にマスクする', async () => {
    const config = configOf({
      'secret.yaml': { stackName: 'SecretStack' },
    });
    const templates = templatesOf({
      'secret.yaml': TEMPLATE_SECRET_DEFAULT,
    });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    fake.waitEvents.set('SecretStack', [
      {
        eventId: 'default-secret-failure',
        timestamp: '2026-07-20T12:01:00.000Z',
        logicalResourceId: 'Bucket',
        resourceType: 'AWS::S3::Bucket',
        resourceStatus: 'UPDATE_FAILED',
        resourceStatusReason: `event rejected ${DEFAULT_SECRET}`,
      },
    ]);
    fake.waitResults.set('SecretStack', [
      makeStackSummary({
        stackName: 'SecretStack',
        status: 'UPDATE_ROLLBACK_COMPLETE',
      }),
    ]);

    const result = await s.run();
    const json = renderJson(result.report);
    const text = renderText(result.report);
    const failed = result.report.result?.stacks.find(
      (stack) => stack.outcome === 'failed',
    );
    const failedProgress = s.progress.find(
      (progress) => progress.phase === 'failed',
    );

    expect(result.exitCode).toBe(1);
    expect(s.emitted[0].resourceStatusReason).toContain('****');
    expect(s.emitted[0].resourceStatusReason).not.toContain(DEFAULT_SECRET);
    expect(failed?.errorMessage).toContain('****');
    expect(failedProgress?.message).toBe(failed?.errorMessage);
    expect(json).not.toContain(DEFAULT_SECRET);
    expect(text).not.toContain(DEFAULT_SECRET);
    expect(fake.callsOf('createChangeSet')[0].args[0]).toMatchObject({
      parameters: {},
    });
  });

  it('NFR-4(Default/change set): NoEcho template Default を変更セット失敗の report/progress 格納前にマスクする', async () => {
    const config = configOf({
      'secret.yaml': { stackName: 'SecretStack' },
    });
    const templates = templatesOf({
      'secret.yaml': TEMPLATE_SECRET_DEFAULT,
    });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    fake.defaultChangeSetDetail = makeChangeSetDetail({
      status: 'FAILED',
      statusReason: `change set rejected ${DEFAULT_SECRET}`,
      changes: [],
    });

    const result = await s.run();
    const failed = result.report.result?.stacks.find(
      (stack) => stack.outcome === 'failed',
    );
    const failedProgress = s.progress.find(
      (progress) => progress.phase === 'failed',
    );
    const json = renderJson(result.report);
    const text = renderText(result.report);

    expect(result.exitCode).toBe(1);
    expect(failed?.errorMessage).toContain('****');
    expect(failed?.errorMessage).not.toContain(DEFAULT_SECRET);
    expect(failedProgress?.message).toBe(failed?.errorMessage);
    expect(json).not.toContain(DEFAULT_SECRET);
    expect(text).not.toContain(DEFAULT_SECRET);
  });

  it('NFR-4(Default/final status): NoEcho template Default を最終 status failure の report/progress 格納前にマスクする', async () => {
    const config = configOf({
      'secret.yaml': { stackName: 'SecretStack' },
    });
    const templates = templatesOf({
      'secret.yaml': TEMPLATE_SECRET_DEFAULT,
    });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    fake.waitResults.set('SecretStack', [
      makeStackSummary({
        stackName: 'SecretStack',
        status: 'UPDATE_ROLLBACK_COMPLETE',
        statusReason: `final status rejected ${DEFAULT_SECRET}`,
      }),
    ]);

    const result = await s.run();
    const failed = result.report.result?.stacks.find(
      (stack) => stack.outcome === 'failed',
    );
    const failedProgress = s.progress.find(
      (progress) => progress.phase === 'failed',
    );
    const json = renderJson(result.report);
    const text = renderText(result.report);

    expect(result.exitCode).toBe(1);
    expect(failed?.errorMessage).toContain('****');
    expect(failed?.errorMessage).not.toContain(DEFAULT_SECRET);
    expect(failedProgress?.message).toBe(failed?.errorMessage);
    expect(json).not.toContain(DEFAULT_SECRET);
    expect(text).not.toContain(DEFAULT_SECRET);
  });

  it('NFR-3(継続): A 成功・B 失敗後の再実行は A を完全スキップし、B の自変更セットを回収して収束する', async () => {
    const config = configOf({
      'a.yaml': { stackName: 'A' },
      'b.yaml': { stackName: 'B' },
    });
    const templates = templatesOf({
      'a.yaml': TEMPLATE_A,
      'b.yaml': TEMPLATE_C,
    });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    fake.waitResults.set('B', [
      makeStackSummary({ stackName: 'B', status: 'UPDATE_ROLLBACK_COMPLETE' }),
    ]);
    expect((await s.run({ onFailure: 'stop' })).exitCode).toBe(1);

    fake.calls.length = 0;
    const stale = 'cfnsync-aabbccddeeff-fedcba9876543210-20260720T110000000';
    fake.changeSets.set('B', [makeChangeSetSummary(stale)]);
    fake.waitResults.set('B', [
      makeStackSummary({
        stackName: 'B',
        stackId:
          s.backend.stored?.state.stacks[`b.yaml@${REGION}`].stackId ?? '',
        status: 'UPDATE_COMPLETE',
      }),
    ]);
    const rerun = await s.run();

    expect(rerun.exitCode).toBe(0);
    expect(
      fake
        .callsOf('createChangeSet')
        .map((call) => (call.args[0] as { stackName: string }).stackName),
    ).toEqual(['B']);
    expect(
      fake.callsOf('executeChangeSet').map((call) => call.args[0]),
    ).toEqual(['B']);
    expect(
      fake.callsOf('deleteChangeSet').map((call) => call.args[1]),
    ).toContain(makeChangeSetSummary(stale).id);
    expect(
      fake.calls.filter(
        (call) =>
          call.args[0] === 'A' ||
          (call.args[0] as { stackName?: string })?.stackName === 'A',
      ),
    ).toHaveLength(0);
  });

  it('FR-13-4: 2 リージョンへ設定順直列で、各実効パラメータ・タグを 1 回ずつ渡す', async () => {
    const config = configOf(
      {
        'a.yaml': {
          stackName: 'A',
          regions: [REGION, REGION_2],
          parameters: { Env: 'common' },
          tags: { Team: 'core' },
          regionOverrides: {
            [REGION]: { parameters: { Env: 'jp' }, tags: { Zone: 'east' } },
            [REGION_2]: { parameters: { Env: 'us' }, tags: { Zone: 'west' } },
          },
        },
      },
      [REGION, REGION_2],
    );
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    for (const region of [REGION, REGION_2])
      setExistingStacks(config, gatewayFor(s, region), region);

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    const jp = gatewayFor(s, REGION).callsOf('createChangeSet');
    const us = gatewayFor(s, REGION_2).callsOf('createChangeSet');
    expect(jp).toHaveLength(1);
    expect(us).toHaveLength(1);
    expect(jp[0].args[0]).toMatchObject({
      parameters: { Env: 'jp' },
      tags: { Team: 'core', Zone: 'east' },
    });
    expect(us[0].args[0]).toMatchObject({
      parameters: { Env: 'us' },
      tags: { Team: 'core', Zone: 'west' },
    });
    expect(s.timeline.indexOf(`cfn:${REGION}.createChangeSet`)).toBeLessThan(
      s.timeline.indexOf(`cfn:${REGION_2}.createChangeSet`),
    );
  });

  it('FR-1-9: create / execute / deleteChangeSet / save の各副作用直前に fencing を置く', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);

    await s.run({ dryRun: true });

    const sideEffects = new Set([
      `cfn:${REGION}.createChangeSet`,
      `cfn:${REGION}.deleteChangeSet`,
      'backend.save',
    ]);
    s.timeline.forEach((item, index) => {
      if (sideEffects.has(item))
        expect(s.timeline[index - 1]).toBe('backend.verifyLock');
    });

    s.timeline.length = 0;
    fake.calls.length = 0;
    await s.run();
    for (const item of [
      `cfn:${REGION}.createChangeSet`,
      `cfn:${REGION}.executeChangeSet`,
      'backend.save',
    ]) {
      const index = s.timeline.indexOf(item);
      if (index >= 0) expect(s.timeline[index - 1]).toBe('backend.verifyLock');
    }
  });

  it('FR-1-9: 完了待機後の fencing 喪失では CAS 保存せず中断する', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    s.backend.verifyLockPlan = [true, true, false];

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    expect(s.backend.saveCalls).toHaveLength(0);
    expect(fake.callsOf('waitForStack')).toHaveLength(1);
  });

  it.each([
    ['stop' as const, false],
    ['continue' as const, true],
  ])('FR-9-2: A 失敗時は依存 B を中止し、独立 C は %s に従う', async (onFailure, executesC) => {
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
    fake.waitResults.set('A', [
      makeStackSummary({ stackName: 'A', status: 'UPDATE_ROLLBACK_COMPLETE' }),
    ]);

    const result = await s.run({ onFailure });
    // FR-5-5a: 変更セットは Phase A で全対象ぶん作成されるため、失敗伝播の観測対象は
    // 「実行されたか」(ExecuteChangeSet)であって「変更セットが作られたか」ではない。
    const executed = fake
      .callsOf('executeChangeSet')
      .map((call) => call.args[0] as string);

    expect(result.exitCode).toBe(1);
    expect(executed).not.toContain('B');
    expect(executed.includes('C')).toBe(executesC);
  });

  it('FR-1-7(統合): 正常終了でも途中エラーでも finally で releaseLock を呼ぶ', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const success = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    setExistingStacks(config, gatewayFor(success));
    expect((await success.run()).exitCode).toBe(0);
    expect(success.backend.releaseCalls).toBe(1);

    const failure = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    setExistingStacks(config, gatewayFor(failure));
    failure.backend.saveError = new Error('injected save failure');
    expect((await failure.run()).exitCode).toBe(1);
    expect(failure.backend.releaseCalls).toBe(1);
  });

  it('FR-1-8: releaseLock の released:false を警告付き失敗へ反映する', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(config, templates, recordedState(config, templates));
    s.backend.releaseLock = async () => ({
      released: false,
      reason: 'owner changed(fake)',
    });

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    expect(result.report.result?.stacks.at(-1)?.errorMessage).toContain(
      'owner changed(fake)',
    );
  });

  it('FR-1-3 / NFR-3: CAS 保存失敗は onFailure=continue でも後続 AWS 副作用を中断する', async () => {
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
    s.backend.saveError = new Error('injected CAS failure');

    const result = await s.run({ onFailure: 'continue' });
    // FR-5-5a: 変更セット作成は Phase A で全対象ぶん先に済む。CAS 保存失敗によって
    // 中断されるべき「後続 AWS 副作用」は ExecuteChangeSet 以降である。
    const executed = fake
      .callsOf('executeChangeSet')
      .map((call) => call.args[0] as string);

    expect(result.exitCode).toBe(1);
    expect(executed).toEqual(['A']);
    expect(s.backend.releaseCalls).toBe(1);
  });

  it('NFR-3(冪等): 空変更セットを同期した deploy の再実行は全スタック unchanged で AWS 変更なし', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    fake.defaultChangeSetDetail = makeChangeSetDetail({
      status: 'FAILED',
      statusReason:
        "The submitted information didn't contain changes. Submit different information to create a change set.",
    });
    expect((await s.run()).exitCode).toBe(0);

    fake.calls.length = 0;
    const second = await s.run();

    expect(second.exitCode).toBe(0);
    expect(second.hasDiff).toBe(false);
    expect(second.report.diffs).toContainEqual(
      expect.objectContaining({ stackName: 'A', operation: 'no-change' }),
    );
    expect(fake.callsOf('createChangeSet')).toHaveLength(0);
    expect(fake.callsOf('executeChangeSet')).toHaveLength(0);
  });

  it("FR-2-3: Macro エラー中の didn't contain changes + changes 非空では失敗し、state を保存しない", async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const initial = recordedState(config, templates, { modified: true });
    const oldHash = initial.stacks[`a.yaml@${REGION}`].inputsHash;
    const s = setup(config, templates, initial);
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    fake.defaultChangeSetDetail = makeChangeSetDetail({
      status: 'FAILED',
      statusReason:
        "Transform ExampleMacro failed because input didn't contain changes while expanding resources",
      changes: changedDetail().changes,
    });

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    expect(result.report.result?.stacks).toContainEqual(
      expect.objectContaining({ stackName: 'A', outcome: 'failed' }),
    );
    expect(s.backend.saveCalls).toHaveLength(0);
    expect(s.backend.stored?.state.stacks[`a.yaml@${REGION}`].inputsHash).toBe(
      oldHash,
    );
  });

  it('§8.2/NFR-4: __REQUIRED__ 拒否の errorMessage は literal sentinel と対象名を保持し AWS 副作用ゼロ', async () => {
    const config = configOf({
      'a.yaml': { stackName: 'A', parameters: { Secret: '__REQUIRED__' } },
      'c.yaml': { stackName: 'C' },
    });
    const templates = templatesOf({
      'a.yaml': TEMPLATE_SECRET,
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
    const created = fake
      .callsOf('createChangeSet')
      .map((call) => (call.args[0] as { stackName: string }).stackName);
    const failed = result.report.result?.stacks.find(
      (stack) => stack.stackName === 'A',
    );

    expect(result.exitCode).toBe(1);
    // FR-5-12b: 計画段階の失敗は --on-failure の値にかかわらず実行全体を中断する。
    // 2 フェーズ化前は独立スタック C だけが実行されていた(破壊的変更)。
    expect(created).toEqual([]);
    expect(failed).toEqual(
      expect.objectContaining({ stackName: 'A', outcome: 'failed' }),
    );
    expect(failed?.errorMessage).toContain('__REQUIRED__');
    expect(failed?.errorMessage).toContain('Secret');
    expect(failed?.errorMessage).not.toContain('****');
    expect(
      fake
        .callsOf('createChangeSet')
        .filter(
          (call) => (call.args[0] as { stackName: string }).stackName === 'A',
        ),
    ).toHaveLength(0);
    expect(
      fake.callsOf('executeChangeSet').filter((call) => call.args[0] === 'A'),
    ).toHaveLength(0);
  });

  it('FR-9-2(__REQUIRED__再レビュー⑥): 必須値不足を計画失敗として AWS 前に依存下流を skipped にする', async () => {
    const providerTemplate = `${TEMPLATE_SECRET}\nOutputs:\n  Shared:\n    Value: value\n    Export:\n      Name: SharedValue\n`;
    const config = configOf({
      'provider.yaml': {
        stackName: 'Provider',
        parameters: { Secret: '__REQUIRED__' },
      },
      'consumer.yaml': { stackName: 'Consumer' },
      'independent.yaml': { stackName: 'Independent' },
    });
    const templates = templatesOf({
      'provider.yaml': providerTemplate,
      'consumer.yaml': TEMPLATE_B,
      'independent.yaml': TEMPLATE_C,
    });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);

    const result = await s.run({ onFailure: 'continue' });
    const created = fake
      .callsOf('createChangeSet')
      .map((call) => (call.args[0] as { stackName: string }).stackName);

    expect(result.exitCode).toBe(1);
    // FR-5-12b: 計画段階の失敗では独立スタックも実行しない(破壊的変更)。
    expect(created).toEqual([]);
    expect(result.report.result?.stacks).toContainEqual(
      expect.objectContaining({ stackName: 'Consumer', outcome: 'skipped' }),
    );
    expect(result.report.result?.stacks).toContainEqual(
      expect.objectContaining({ stackName: 'Independent', outcome: 'skipped' }),
    );
  });

  it('§4.3(Stack ARN再レビュー⑥): UPDATE は state stackId 未記録・不一致なら変更セット作成前に拒否する', async () => {
    for (const stackId of [null, 'arn:aws:cloudformation:replaced-stack']) {
      const config = configOf({ 'a.yaml': { stackName: 'A' } });
      const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
      const initial = recordedState(config, templates, { modified: true });
      initial.stacks[`a.yaml@${REGION}`].stackId = stackId;
      const s = setup(config, templates, initial);
      const fake = gatewayFor(s);
      setExistingStacks(config, fake);

      const result = await s.run();

      expect(result.exitCode).toBe(1);
      expect(fake.callsOf('createChangeSet')).toHaveLength(0);
      expect(result.report.result?.stacks).toContainEqual(
        expect.objectContaining({
          errorMessage: expect.stringMatching(/stackId|ARN|import|移行/i),
        }),
      );
    }
  });

  it('§4.3(Stack ARN再レビュー⑥): UPDATE は ExecuteChangeSet 直前の stackId 差し替えも拒否する', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    const describeStack = fake.describeStack.bind(fake);
    fake.describeStack = async (stackName) => {
      const summary = await describeStack(stackName);
      if (fake.callsOf('createChangeSet').length > 0 && summary) {
        return {
          ...summary,
          stackId: 'arn:aws:cloudformation:replaced-before-execute',
        };
      }
      return summary;
    };

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    expect(fake.callsOf('createChangeSet')).toHaveLength(1);
    expect(fake.callsOf('executeChangeSet')).toHaveLength(0);
    expect(result.report.result?.stacks).toContainEqual(
      expect.objectContaining({
        errorMessage: expect.stringMatching(/stackId|ARN|import/i),
      }),
    );
  });

  it('FR-6-5 / FR-8-7(不完全解析): 明示 dependsOn があれば解析警告を解消済みとして保存する', async () => {
    const dynamic = `
Resources: {}
Outputs:
  Dynamic:
    Value: value
    Export:
      Name: !Sub '\${Prefix}-value'
`;
    const config = configOf({
      'provider.yaml': { stackName: 'Provider' },
      'dynamic.yaml': { stackName: 'Dynamic' },
      'covered.yaml': {
        stackName: 'Covered',
        dependsOn: ['provider.yaml'],
      },
    });
    const templates = templatesOf({
      'provider.yaml': TEMPLATE_C,
      'dynamic.yaml': dynamic,
      'covered.yaml': dynamic,
    });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);

    expect((await s.run()).exitCode).toBe(0);
    expect(
      s.backend.stored?.state.stacks[`dynamic.yaml@${REGION}`]
        .dependencyAnalysisIncomplete,
    ).toBe(true);
    expect(
      s.backend.stored?.state.stacks[`covered.yaml@${REGION}`]
        .dependencyAnalysisIncomplete,
    ).toBe(false);
  });

  it('FR-5-5b4: CREATE 復旧は NoEcho / dependsOn があると入力同一性を証明できず fail-closed になる', async () => {
    const config = configOf({
      'external.yaml': { stackName: 'ExternalStack' },
      'secret.yaml': {
        stackName: 'SecretStack',
        parameters: { Secret: 'desired' },
        tags: { Env: 'dev' },
        capabilities: ['CAPABILITY_IAM'],
        dependsOn: ['external.yaml'],
      },
    });
    const templates = templatesOf({
      'external.yaml': TEMPLATE_C,
      'secret.yaml': TEMPLATE_SECRET,
    });
    const initial = recordedState(config, templates);
    delete initial.stacks['secret.yaml@ap-northeast-1'];
    const s = setup(config, templates, initial);
    const fake = gatewayFor(s);
    fake.stacks.set(
      'SecretStack',
      makeStackSummary({
        stackName: 'SecretStack',
        status: 'CREATE_COMPLETE',
        parameters: { Secret: '****' },
        tags: { Env: 'dev', [MANAGEMENT_TAG_KEY]: STATE_ID },
        capabilities: ['CAPABILITY_IAM'],
      }),
    );
    fake.templates.set('SecretStack', TEMPLATE_SECRET);

    const result = await s.run();

    // 管理タグ・テンプレート・可視パラメータ・タグ・Capabilities はすべて一致するが、
    // NoEcho の実値と dependsOn は AWS 側と照合できない。これらを比較から除外したまま
    // 「適用済み」として state を保存すると、未適用の希望値を適用済みと記録して
    // 変更が失われる(虚偽収束)。2 フェーズ化前は警告して続行していた(破壊的変更)。
    expect(result.exitCode).toBe(1);
    expect(fake.callsOf('createChangeSet')).toHaveLength(0);
    expect(
      s.backend.stored?.state.stacks['secret.yaml@ap-northeast-1'],
    ).toBeUndefined();
    const failure = result.report.result?.stacks.find(
      (stack) => stack.stackKey === 'secret.yaml@ap-northeast-1',
    );
    expect(failure?.outcome).toBe('failed');
    expect(failure?.errorMessage).toContain('入力同一性を証明できない');
    // FR-5-5b4: 案内は「import を実行せよ」では不十分で、import が NoEcho を
    // __REQUIRED__ へ書き換えることまで含めた手順でなければならない。
    expect(failure?.errorMessage).toContain('--reconcile local');
    expect(failure?.errorMessage).toContain('__REQUIRED__');
    // NFR-4: NoEcho の実値を診断へ漏らさない。
    expect(failure?.errorMessage).not.toContain('desired');
  });

  it('FR-5-5b3: CREATE 復旧は NoEcho / dependsOn がなければ全入力を照合できるので SYNC 保存する', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const initial = recordedState(config, templates);
    delete initial.stacks[`a.yaml@${REGION}`];
    const s = setup(config, templates, initial);
    const fake = gatewayFor(s);
    fake.stacks.set(
      'A',
      makeStackSummary({
        stackName: 'A',
        status: 'CREATE_COMPLETE',
        tags: { [MANAGEMENT_TAG_KEY]: STATE_ID },
      }),
    );
    fake.templates.set('A', TEMPLATE_A);

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    expect(fake.callsOf('createChangeSet')).toHaveLength(0);
    expect(s.backend.stored?.state.stacks[`a.yaml@${REGION}`].lastAction).toBe(
      'SYNC',
    );
    // FR-5-18a: 承認前に保存した既成事実の再同期を report へ開示する。
    expect(result.report.reconciliations).toContainEqual({
      stackKey: `a.yaml@${REGION}`,
      region: REGION,
      kind: 'create-recovery',
      stateUpdated: true,
    });
  });

  it('§7 CREATE 復旧: 管理タグ欠如は他が一致しても fail-closed で import を案内する', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      withAccountId(createInitialState(), ACCOUNT),
    );
    const fake = gatewayFor(s);
    fake.stacks.set(
      'A',
      makeStackSummary({ stackName: 'A', status: 'CREATE_COMPLETE' }),
    );
    fake.templates.set('A', TEMPLATE_A);

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    expect(result.report.result?.stacks[0].errorMessage).toMatch(
      /cfnsync import/,
    );
    expect(s.backend.saveCalls).toHaveLength(0);
  });

  it('§7 DELETE 復旧: deleted だが実スタック不存在なら state entry を CAS 除去する', async () => {
    const oldConfig = configOf({ 'old.yaml': { stackName: 'Old' } });
    const oldTemplates = templatesOf({ 'old.yaml': TEMPLATE_C });
    const state = recordedState(oldConfig, oldTemplates);
    const config = configOf({});
    const s = setup(config, new Map(), state);

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    expect(
      s.backend.stored?.state.stacks['old.yaml@ap-northeast-1'],
    ).toBeUndefined();
    expect(s.backend.saveCalls).toHaveLength(1);
  });

  it('FR-6-1 / FR-6-2: deleted は常に差分へ含め、allowDelete 指定時は削除が実行される', async () => {
    const oldConfig = configOf({ 'old.yaml': { stackName: 'Old' } });
    const oldTemplates = templatesOf({ 'old.yaml': TEMPLATE_C });
    const config = configOf({});
    const state = recordedState(oldConfig, oldTemplates);
    const s = setup(config, new Map(), state);
    const fake = gatewayFor(s);
    fake.stacks.set(
      'Old',
      makeStackSummary({
        stackName: 'Old',
        stackId: state.stacks[`old.yaml@${REGION}`].stackId ?? '',
        status: 'CREATE_COMPLETE',
      }),
    );
    fake.waitResults.set('Old', [
      makeStackSummary({ stackName: 'Old', status: 'DELETE_COMPLETE' }),
    ]);

    const result = await s.run({ allowDelete: true });

    expect(result.report.diffs).toContainEqual(
      expect.objectContaining({ stackName: 'Old', operation: 'delete' }),
    );
    expect(fake.callsOf('deleteStack').map((call) => call.args[0])).toEqual([
      state.stacks[`old.yaml@${REGION}`].stackId,
    ]);
  });

  it('security(再レビュー2): テンプレートのパス変更で同一物理スタックを削除しない', async () => {
    // old.yaml(stackName: Shared)を new.yaml(stackName: Shared)へパス変更。
    // 旧キーは deleted、新キーは added だが同一 (region, stackName)。
    // 旧キーの DeleteStack は fail-closed で拒否されなければならない。
    const oldConfig = configOf({ 'old.yaml': { stackName: 'Shared' } });
    const oldTemplates = templatesOf({ 'old.yaml': TEMPLATE_C });
    const state = recordedState(oldConfig, oldTemplates);
    const newConfig = configOf({ 'new.yaml': { stackName: 'Shared' } });
    const s = setup(newConfig, templatesOf({ 'new.yaml': TEMPLATE_C }), state);
    const fake = gatewayFor(s);
    fake.stacks.set(
      'Shared',
      makeStackSummary({
        stackName: 'Shared',
        stackId: state.stacks[`old.yaml@${REGION}`].stackId ?? '',
        status: 'CREATE_COMPLETE',
      }),
    );

    // onFailure continue: new.yaml の CREATE 復旧が命名衝突で失敗しても、
    // 独立した old.yaml の削除処理まで到達させ、衝突ガードを発火させる。
    const result = await s.run({ allowDelete: true, onFailure: 'continue' });

    expect(fake.callsOf('deleteStack')).toHaveLength(0);
    expect(result.report.result?.stacks).toContainEqual(
      expect.objectContaining({
        stackKey: `old.yaml@${REGION}`,
        outcome: 'failed',
        errorMessage: expect.stringMatching(/管理対象|リネーム|パス変更/),
      }),
    );
  });

  it('security(再レビュー2): スタック名変更の削除は新名エントリを state から消さない', async () => {
    // 同一キー a.yaml で stackName を Old→New へ変更。detect は
    // deleted(Old) + added(New) の対を出す。New の create 成功後、
    // Old の削除で同一キーを除去すると New の記録まで消えるため保存しない。
    const oldConfig = configOf({ 'a.yaml': { stackName: 'Old' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const state = recordedState(oldConfig, templates);
    const config = configOf({ 'a.yaml': { stackName: 'New' } });
    const s = setup(config, templates, state);
    const fake = gatewayFor(s);
    // 旧名 Old は現存(削除対象)、新名 New は未作成(CREATE 対象)。
    fake.stacks.set(
      'Old',
      makeStackSummary({
        stackName: 'Old',
        stackId: state.stacks[`a.yaml@${REGION}`].stackId ?? '',
        status: 'CREATE_COMPLETE',
      }),
    );
    fake.waitResults.set('Old', [
      makeStackSummary({ stackName: 'Old', status: 'DELETE_COMPLETE' }),
    ]);

    const result = await s.run({ allowDelete: true });

    // 旧名 Old は削除される。新名 New の state エントリは残る(消えない)。
    expect(fake.callsOf('deleteStack').map((call) => call.args[0])).toContain(
      state.stacks[`a.yaml@${REGION}`].stackId,
    );
    expect(s.backend.stored?.state.stacks[`a.yaml@${REGION}`]?.stackName).toBe(
      'New',
    );
    expect(result.exitCode).toBe(0);
  });

  it('FR-5-4: CREATE 成功は changeset-create-start→diff-ready→execute-start→done を通知する', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const s = setup(config, templatesOf({ 'a.yaml': TEMPLATE_A }));

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    expect(
      s.progress
        .filter((p) => p.stackKey === `a.yaml@${REGION}`)
        .map((p) => p.phase),
    ).toEqual([
      'changeset-create-start',
      'diff-ready',
      'execute-start',
      'done',
    ]);
    // 全イベントが自スタックのキー・リージョンを保持する(将来並列化の属性付け)。
    for (const event of s.progress) {
      expect(event.stackKey).toBe(`a.yaml@${REGION}`);
      expect(event.region).toBe(REGION);
    }
  });

  it('FR-5-4: 空変更セットは changeset-create-start→no-change で止まり execute しない', async () => {
    const config = configOf({ 'a.yaml': { stackName: 'A' } });
    const templates = templatesOf({ 'a.yaml': TEMPLATE_A });
    const s = setup(
      config,
      templates,
      recordedState(config, templates, { modified: true }),
    );
    const fake = gatewayFor(s);
    setExistingStacks(config, fake);
    fake.defaultChangeSetDetail = makeChangeSetDetail({
      status: 'FAILED',
      statusReason:
        "The submitted information didn't contain changes. Submit different information to create a change set.",
    });

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    expect(
      s.progress
        .filter((p) => p.stackKey === `a.yaml@${REGION}`)
        .map((p) => p.phase),
    ).toEqual(['changeset-create-start', 'no-change']);
  });

  it('FR-5-4: dry-run は changeset-create-start→diff-ready で止まり正常停止を skipped 通知しない', async () => {
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

    expect(result.exitCode).toBe(2);
    const phases = s.progress
      .filter((p) => p.stackKey === `a.yaml@${REGION}`)
      .map((p) => p.phase);
    expect(phases).toEqual(['changeset-create-start', 'diff-ready']);
    expect(phases).not.toContain('skipped');
    expect(phases).not.toContain('execute-start');
    expect(phases).not.toContain('done');
  });

  it('FR-5-4(失敗): failed の progress メッセージは report の errorMessage と同一文字列で NoEcho をマスク済み', async () => {
    const secret = 'S3cr3t-Value-From-Config';
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
    fake.waitEvents.set('SecretStack', [
      {
        eventId: 'secret-failure',
        timestamp: '2026-07-20T12:01:00.000Z',
        logicalResourceId: 'Bucket',
        resourceType: 'AWS::S3::Bucket',
        resourceStatus: 'UPDATE_FAILED',
        resourceStatusReason: `custom resource rejected password ${secret}`,
      },
    ]);
    fake.waitResults.set('SecretStack', [
      makeStackSummary({
        stackName: 'SecretStack',
        status: 'UPDATE_ROLLBACK_COMPLETE',
        statusReason: `rollback after ${secret}`,
      }),
    ]);

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    const key = 'secret.yaml@ap-northeast-1';
    const stackProgress = s.progress.filter((p) => p.stackKey === key);
    const failedProgress = stackProgress.at(-1);
    expect(failedProgress?.phase).toBe('failed');
    const reportFailed = result.report.result?.stacks.find(
      (stack) => stack.stackKey === key && stack.outcome === 'failed',
    );
    // 単一の redaction 経路: progress の failed メッセージは report の errorMessage と同一文字列。
    expect(failedProgress?.message).toBe(reportFailed?.errorMessage);
    expect(failedProgress?.message).not.toContain(secret);
    expect(failedProgress?.message).toContain('****');
  });

  it('FR-5-4(スキップ): A 失敗で A に依存する B の progress に skipped が入る', async () => {
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
    fake.waitResults.set('A', [
      makeStackSummary({ stackName: 'A', status: 'UPDATE_ROLLBACK_COMPLETE' }),
    ]);

    const result = await s.run({ onFailure: 'continue' });

    expect(result.exitCode).toBe(1);
    const bPhases = s.progress
      .filter((p) => p.stackKey === `b.yaml@${REGION}`)
      .map((p) => p.phase);
    // FR-5-5a: 差分確定は承認前に全対象ぶん行われるため、B にも
    // changeset-create-start → diff-ready が出る。A の実行失敗を受けて
    // B は Phase B で実行されず skipped で終わる(相対順序は維持。FR-5-4)。
    expect(bPhases).toEqual([
      'changeset-create-start',
      'diff-ready',
      'skipped',
    ]);
    expect(bPhases).not.toContain('execute-start');
    expect(
      fake.callsOf('executeChangeSet').map((call) => call.args[0] as string),
    ).not.toContain('B');
  });

  it('FR-5-4: 削除は allowDelete 指定時だけ delete-start→done、未指定は skipped のみ通知する', async () => {
    const oldConfig = configOf({ 'old.yaml': { stackName: 'Old' } });
    const oldTemplates = templatesOf({ 'old.yaml': TEMPLATE_C });
    const config = configOf({});
    const key = `old.yaml@${REGION}`;

    const success = setup(
      config,
      new Map(),
      recordedState(oldConfig, oldTemplates),
    );
    const successFake = gatewayFor(success);
    successFake.stacks.set(
      'Old',
      makeStackSummary({
        stackName: 'Old',
        stackId:
          recordedState(oldConfig, oldTemplates).stacks[key].stackId ?? '',
        status: 'CREATE_COMPLETE',
      }),
    );
    successFake.waitResults.set('Old', [
      makeStackSummary({ stackName: 'Old', status: 'DELETE_COMPLETE' }),
    ]);
    await success.run({ allowDelete: true });
    expect(
      success.progress.filter((p) => p.stackKey === key).map((p) => p.phase),
    ).toEqual(['delete-start', 'done']);

    const skip = setup(
      config,
      new Map(),
      recordedState(oldConfig, oldTemplates),
    );
    const skipFake = gatewayFor(skip);
    skipFake.stacks.set(
      'Old',
      makeStackSummary({ stackName: 'Old', status: 'CREATE_COMPLETE' }),
    );
    await skip.run();
    // delete-start は「実行開始」の通知であり Phase B でのみ出す。--allow-delete が
    // ない場合は DeleteStack へ進まないため、開始を通知せず skipped だけを出す
    // (2 フェーズ化前は delete-start → skipped の順で出していた)。
    expect(
      skip.progress.filter((p) => p.stackKey === key).map((p) => p.phase),
    ).toEqual(['skipped']);
  });

  it('FR-5-4: 削除保護で拒否された削除は delete-start→failed を通知する', async () => {
    const oldConfig = configOf({ 'old.yaml': { stackName: 'Old' } });
    const oldTemplates = templatesOf({ 'old.yaml': TEMPLATE_C });
    const config = configOf({});
    const key = `old.yaml@${REGION}`;
    const state = recordedState(oldConfig, oldTemplates);
    const s = setup(config, new Map(), state);
    const fake = gatewayFor(s);
    fake.stacks.set(
      'Old',
      makeStackSummary({
        stackName: 'Old',
        stackId: state.stacks[key].stackId ?? '',
        status: 'CREATE_COMPLETE',
        terminationProtection: true,
      }),
    );

    const result = await s.run({ allowDelete: true });

    expect(result.exitCode).toBe(1);
    expect(fake.callsOf('deleteStack')).toHaveLength(0);
    expect(
      s.progress.filter((p) => p.stackKey === key).map((p) => p.phase),
    ).toEqual(['delete-start', 'failed']);
  });

  it('FR-5-4: マルチリージョンでも各 progress が自スタックのキー・リージョンを保持する', async () => {
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
    for (const region of [REGION, REGION_2])
      setExistingStacks(config, gatewayFor(s, region), region);

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    expect(s.progress.length).toBeGreaterThan(0);
    // stackKey は必ず `<path>@<region>` 形式で、region フィールドと一致する。
    for (const event of s.progress) {
      expect(event.stackKey.endsWith(`@${event.region}`)).toBe(true);
    }
    expect(s.progress.some((p) => p.stackKey === `a.yaml@${REGION}`)).toBe(
      true,
    );
    expect(s.progress.some((p) => p.stackKey === `a.yaml@${REGION_2}`)).toBe(
      true,
    );
  });
});
