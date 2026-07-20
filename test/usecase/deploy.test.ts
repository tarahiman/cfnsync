/**
 * T-14 usecase/deploy — デプロイフロー統合。
 *
 * tasks.md §6 T-14 の表を正本とし、各テスト名に対応 ID を明記する。
 * 実 AWS は使わず、共有 timeline 付きインメモリフェイクで fencing / CAS / 直列順を固定する。
 */

import { describe, expect, it } from 'vitest';
import {
  type CfnSyncConfig,
  resolveDependsOnKey,
  resolveTargets,
  validateConfig,
} from '../../src/core/config.js';
import {
  computeInputsHash,
  computeTemplateHash,
} from '../../src/core/detect.js';
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

function configOf(
  stacks: Record<string, unknown>,
  allowedRegions = [REGION],
): CfnSyncConfig {
  return validateConfig(
    {
      version: 1,
      defaultRegion: allowedRegions[0],
      allowedAccounts: [ACCOUNT],
      allowedRegions,
      stacks,
    },
    { templateExists: () => true },
  );
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
    });
    state = upsertStackEntry(state, target.stackKey, {
      stackName: target.stackName,
      region: target.region,
      templateHash: computeTemplateHash(source),
      inputsHash: opts.modified
        ? `sha256:old-${target.stackKey}`
        : computeInputsHash({
            templateContent: source,
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
      },
      options,
    });
  return { timeline, emitted, backend, gateways, cfnFactory, run };
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
  it('FR-5-1 / FR-5-2: 変更検知から実行まで依存順に非対話で一括実行する', async () => {
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
    expect(mutationOrder(fake)).toEqual([
      'create:A',
      'execute:A',
      'create:B',
      'execute:B',
    ]);
    expect(result.report.diffs.map((diff) => diff.stackName)).toEqual([
      'A',
      'B',
    ]);
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
    const stale = 'cfnsync-aabbccddeeff-oldrun-20260720T110000000';
    fake.changeSets.set('B', [makeChangeSetSummary(stale)]);
    fake.waitResults.set('B', [
      makeStackSummary({ stackName: 'B', status: 'UPDATE_COMPLETE' }),
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
    ).toContain(stale);
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
    const created = fake
      .callsOf('createChangeSet')
      .map((call) => (call.args[0] as { stackName: string }).stackName);

    expect(result.exitCode).toBe(1);
    expect(created).not.toContain('B');
    expect(created.includes('C')).toBe(executesC);
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
    const created = fake
      .callsOf('createChangeSet')
      .map((call) => (call.args[0] as { stackName: string }).stackName);

    expect(result.exitCode).toBe(1);
    expect(created).toEqual(['A']);
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

  it('§8.2: __REQUIRED__ 残存スタックだけを検証エラーで除外し、他スタックは実行する', async () => {
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

    expect(result.exitCode).toBe(1);
    expect(created).toEqual(['C']);
    expect(result.report.result?.stacks).toContainEqual(
      expect.objectContaining({
        stackName: 'A',
        outcome: 'failed',
        errorMessage: expect.stringContaining('Secret'),
      }),
    );
  });

  it('§7 CREATE 復旧: added 既存スタックが完全一致なら NoEcho/dependsOn 除外を警告し SYNC 保存する', async () => {
    const config = configOf({
      'secret.yaml': {
        stackName: 'SecretStack',
        parameters: { Secret: 'desired' },
        tags: { Env: 'dev' },
        capabilities: ['CAPABILITY_IAM'],
        dependsOn: ['external.yaml'],
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
        status: 'CREATE_COMPLETE',
        parameters: { Secret: '****' },
        tags: { Env: 'dev', [MANAGEMENT_TAG_KEY]: STATE_ID },
        capabilities: ['CAPABILITY_IAM'],
      }),
    );
    fake.templates.set('SecretStack', TEMPLATE_SECRET);

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    expect(fake.callsOf('createChangeSet')).toHaveLength(0);
    expect(
      s.backend.stored?.state.stacks['secret.yaml@ap-northeast-1'].lastAction,
    ).toBe('SYNC');
    expect(
      s.backend.stored?.state.stacks['secret.yaml@ap-northeast-1'].dependsOn,
    ).toEqual(['external.yaml@ap-northeast-1']);
    expect(result.report.diffs[0].warnings.join('\n')).toMatch(
      /Secret|dependsOn/,
    );
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
    const s = setup(config, new Map(), recordedState(oldConfig, oldTemplates));
    const fake = gatewayFor(s);
    fake.stacks.set(
      'Old',
      makeStackSummary({ stackName: 'Old', status: 'CREATE_COMPLETE' }),
    );
    fake.waitResults.set('Old', [
      makeStackSummary({ stackName: 'Old', status: 'DELETE_COMPLETE' }),
    ]);

    const result = await s.run({ allowDelete: true });

    expect(result.report.diffs).toContainEqual(
      expect.objectContaining({ stackName: 'Old', operation: 'delete' }),
    );
    expect(fake.callsOf('deleteStack').map((call) => call.args[0])).toEqual([
      'Old',
    ]);
  });
});
