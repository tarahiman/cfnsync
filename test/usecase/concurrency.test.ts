/**
 * T-18 並行・競合窓シナリオ。
 * ロック、CAS、待機後 fencing、変更セット実行直前再検査を決定的に障害注入する。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  type CfnSyncConfig,
  resolveTargets,
  validateConfig,
} from '../../src/core/config.js';
import {
  computeInputsHash,
  computeTemplateHash,
} from '../../src/core/detect.js';
import { StateConflictError } from '../../src/core/errors.js';
import {
  type CfnSyncState,
  createInitialState,
  upsertStackEntry,
  withAccountId,
} from '../../src/core/state.js';
import { analyzeTemplate } from '../../src/core/template.js';
import type { CloudFormationGateway } from '../../src/ports/index.js';
import { deploy } from '../../src/usecase/deploy.js';
import { forceUnlock } from '../../src/usecase/forceUnlock.js';
import {
  FakeCloudFormationGateway,
  FakeStateBackend,
  makeChangeSetDetail,
  makeChangeSetSummary,
  makeStackSummary,
} from './fakes.js';

const ACCOUNT = '123456789012';
const REGION = 'ap-northeast-1';
const STATE_ID = 'aabbccddeeff';
const FIXED_NOW = () => new Date('2026-07-20T12:00:00.000Z');
const scenarioGateways: FakeCloudFormationGateway[] = [];

const TEMPLATE = `
AWSTemplateFormatVersion: '2010-09-09'
Resources:
  Bucket:
    Type: AWS::S3::Bucket
`;

function configOf(): CfnSyncConfig {
  return validateConfig(
    {
      version: 1,
      defaultRegion: REGION,
      allowedAccounts: [ACCOUNT],
      allowedRegions: [REGION],
      stacks: {
        'stack.yaml': { stackName: 'ManagedStack', tags: { Version: 'new' } },
      },
    },
    { templateExists: () => true },
  );
}

function modifiedState(
  config: CfnSyncConfig,
  templates: Map<string, string>,
): CfnSyncState {
  const target = resolveTargets(config)[0];
  const source = templates.get(target.templatePath) as string;
  const analysis = analyzeTemplate(source, {
    stackName: target.stackName,
    region: target.region,
  });
  return upsertStackEntry(
    withAccountId(createInitialState(), ACCOUNT),
    target.stackKey,
    {
      stackName: target.stackName,
      region: target.region,
      templateHash: computeTemplateHash(source),
      inputsHash: 'sha256:old-inputs',
      exports: analysis.exports,
      imports: analysis.imports,
      lastAction: 'UPDATE',
      lastSuccessAt: '2026-07-19T00:00:00.000Z',
    },
  );
}

function desiredInputsHash(
  config: CfnSyncConfig,
  templates: Map<string, string>,
): string {
  const target = resolveTargets(config)[0];
  const source = templates.get(target.templatePath) as string;
  return computeInputsHash({
    templateContent: source,
    stackName: target.stackName,
    parameters: target.parameters,
    tags: target.tags,
    capabilities: target.capabilities,
    dependsOn: target.dependsOn,
  });
}

function setup(initial?: CfnSyncState) {
  const config = configOf();
  const templates = new Map([['stack.yaml', TEMPLATE]]);
  const timeline: string[] = [];
  const backend = new FakeStateBackend(
    timeline,
    initial ?? withAccountId(createInitialState(), ACCOUNT),
    STATE_ID,
  );
  const cfn = new FakeCloudFormationGateway(timeline);
  scenarioGateways.push(cfn);
  cfn.defaultChangeSetDetail = makeChangeSetDetail({
    changes: [
      {
        action: 'Modify',
        logicalResourceId: 'Bucket',
        resourceType: 'AWS::S3::Bucket',
        scope: ['Properties'],
        details: [],
      },
    ],
  });
  let nextRun = 0;
  const run = () =>
    deploy({
      config,
      configDir: '/repo',
      templates,
      deps: {
        cfnFactory: (): CloudFormationGateway => cfn,
        sts: {
          async getCallerIdentity() {
            return {
              accountId: ACCOUNT,
              arn: `arn:aws:iam::${ACCOUNT}:role/test`,
            };
          },
        },
        backend,
        now: FIXED_NOW,
        runId: () => `run${++nextRun}`,
      },
      options: {},
    });
  return { config, templates, timeline, backend, cfn, run };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mutationCount(cfn: FakeCloudFormationGateway): number {
  return cfn.calls.filter((call) =>
    [
      'createChangeSet',
      'deleteChangeSet',
      'executeChangeSet',
      'deleteStack',
    ].includes(call.method),
  ).length;
}

function reportErrors(result: Awaited<ReturnType<typeof deploy>>): string {
  return (result.report.result?.stacks ?? [])
    .map((stack) => stack.errorMessage ?? '')
    .join('\n');
}

afterEach(() => {
  // FR-2-10(横断): T-18 の全並行シナリオで REVIEW_IN_PROGRESS への DeleteStack を禁止する。
  for (const cfn of scenarioGateways)
    expect(cfn.reviewInProgressDeleteCalls).toEqual([]);
  scenarioGateways.length = 0;
});

describe('T-18 concurrency', () => {
  it('NFR-3 並行実行: 同時開始の後発は LockError、AWS 変更ゼロで state を傷つけない', async () => {
    const config = configOf();
    const templates = new Map([['stack.yaml', TEMPLATE]]);
    const s = setup(modifiedState(config, templates));
    s.backend.rejectConcurrentAcquire = true;
    s.cfn.stacks.set(
      'ManagedStack',
      makeStackSummary({
        stackName: 'ManagedStack',
        status: 'UPDATE_COMPLETE',
      }),
    );
    s.cfn.waitResults.set('ManagedStack', [
      makeStackSummary({
        stackName: 'ManagedStack',
        status: 'UPDATE_COMPLETE',
      }),
    ]);
    const enteredWait = deferred();
    const finishWait = deferred();
    s.cfn.onWaitForStack = async () => {
      enteredWait.resolve();
      await finishWait.promise;
    };

    const firstPromise = s.run();
    await enteredWait.promise;
    const beforeSecond = mutationCount(s.cfn);
    const stateBeforeSecond = s.backend.stored?.state;
    const second = await s.run();

    expect(second.exitCode).toBe(1);
    expect(reportErrors(second)).toContain('別の実行がロックを保持');
    expect(mutationCount(s.cfn)).toBe(beforeSecond);
    expect(s.backend.stored?.state).toBe(stateBeforeSecond);
    expect(s.backend.saveCalls).toHaveLength(0);

    finishWait.resolve();
    const first = await firstPromise;
    expect(first.exitCode).toBe(0);
    expect(s.backend.saveCalls).toHaveLength(1);
    expect(
      s.backend.stored?.state.stacks['stack.yaml@ap-northeast-1'].inputsHash,
    ).toBe(desiredInputsHash(config, templates));
  });

  it('NFR-3 / §4.5 CAS 正本保護: verify=true 直後の所有権交代でも旧実行の保存は StateConflictError', async () => {
    const config = configOf();
    const templates = new Map([['stack.yaml', TEMPLATE]]);
    const initial = modifiedState(config, templates);
    const s = setup(initial);
    s.cfn.stacks.set(
      'ManagedStack',
      makeStackSummary({
        stackName: 'ManagedStack',
        status: 'UPDATE_COMPLETE',
      }),
    );
    const authoritative: CfnSyncState = {
      ...initial,
      generation: initial.generation + 1,
      stacks: {
        ...initial.stacks,
        'stack.yaml@ap-northeast-1': {
          ...initial.stacks['stack.yaml@ap-northeast-1'],
          inputsHash: 'sha256:new-run-authoritative',
          lastSuccessAt: '2026-07-20T12:00:30.000Z',
        },
      },
    };
    s.backend.onVerifyLock = async (handle, count, verified) => {
      // create / execute の fencing に続く、state save 直前の 3 回目で競合窓を作る。
      if (count !== 3 || !verified) return;
      expect(handle.runId).toBe('run1');
      expect(await s.backend.forceUnlock('run1')).toMatchObject({
        released: true,
      });
      s.backend.stored = {
        state: authoritative,
        version: { generation: authoritative.generation },
      };
      await s.backend.acquireLock({
        runId: 'run2-new-owner',
        startedAt: '2026-07-20T12:00:20.000Z',
        owner: 'new-run',
      });
    };

    const oldRun = await s.run();

    expect(oldRun.exitCode).toBe(1);
    expect(s.backend.saveCalls).toHaveLength(1);
    expect(s.backend.saveErrors).toHaveLength(1);
    expect(s.backend.saveErrors[0]).toBeInstanceOf(StateConflictError);
    expect(s.backend.stored?.state).toBe(authoritative);
    expect(
      s.backend.stored?.state.stacks['stack.yaml@ap-northeast-1'].inputsHash,
    ).toBe('sha256:new-run-authoritative');
    expect((await s.backend.readLock())?.runId).toBe('run2-new-owner');
  });

  it('NFR-3 完了待機中の force-unlock: 所有者交代を待機後 fencing が検出し、保存しない', async () => {
    const config = configOf();
    const templates = new Map([['stack.yaml', TEMPLATE]]);
    const s = setup(modifiedState(config, templates));
    s.cfn.stacks.set(
      'ManagedStack',
      makeStackSummary({
        stackName: 'ManagedStack',
        status: 'UPDATE_COMPLETE',
      }),
    );
    s.cfn.waitResults.set('ManagedStack', [
      makeStackSummary({
        stackName: 'ManagedStack',
        status: 'UPDATE_COMPLETE',
      }),
    ]);
    s.cfn.onWaitForStack = async () => {
      const unlocked = await forceUnlock({ backend: s.backend, runId: 'run1' });
      expect(unlocked).toMatchObject({ exitCode: 0, released: true });
      await s.backend.acquireLock({
        runId: 'replacement-owner',
        startedAt: '2026-07-20T12:01:00.000Z',
        owner: 'replacement-ci',
      });
    };

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    expect(reportErrors(result)).toContain('所有権を失いました');
    expect(s.cfn.callsOf('waitForStack')).toHaveLength(1);
    expect(s.backend.saveCalls).toHaveLength(0);
    expect(
      s.backend.stored?.state.stacks['stack.yaml@ap-northeast-1'].inputsHash,
    ).toBe('sha256:old-inputs');
    expect((await s.backend.readLock())?.runId).toBe('replacement-owner');
  });

  it('FR-2-10(横断): REVIEW_IN_PROGRESS は自変更セットだけ回収し、DeleteStack を呼ばない', async () => {
    const s = setup();
    s.cfn.stacks.set(
      'ManagedStack',
      makeStackSummary({
        stackName: 'ManagedStack',
        status: 'REVIEW_IN_PROGRESS',
      }),
    );
    s.cfn.changeSets.set('ManagedStack', [
      makeChangeSetSummary(`cfnsync-${STATE_ID}-oldrun-20260720T110000000`),
    ]);
    s.cfn.waitResults.set('ManagedStack', [
      makeStackSummary({
        stackName: 'ManagedStack',
        status: 'CREATE_COMPLETE',
      }),
    ]);

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    expect(s.cfn.callsOf('deleteChangeSet')).toHaveLength(1);
    expect(s.cfn.callsOf('createChangeSet')).toHaveLength(1);
    expect(s.cfn.callsOf('deleteStack')).toHaveLength(0);
  });

  it('FR-2-11(横断): 残存回収後の並行追加を実行直前再検査で検出し、ExecuteChangeSet を呼ばない', async () => {
    const config = configOf();
    const templates = new Map([['stack.yaml', TEMPLATE]]);
    const s = setup(modifiedState(config, templates));
    s.cfn.stacks.set(
      'ManagedStack',
      makeStackSummary({
        stackName: 'ManagedStack',
        status: 'UPDATE_COMPLETE',
      }),
    );
    s.cfn.onListChangeSets = (stackName, callCount) => {
      if (callCount === 2) {
        s.cfn.changeSets.set(stackName, [
          makeChangeSetSummary('human-raced-change-set'),
        ]);
      }
    };

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    expect(reportErrors(result)).toContain('実行直前の再検査');
    expect(s.cfn.callsOf('listChangeSets')).toHaveLength(2);
    expect(s.cfn.callsOf('executeChangeSet')).toHaveLength(0);
    expect(s.backend.saveCalls).toHaveLength(0);
    expect(s.cfn.callsOf('deleteStack')).toHaveLength(0);
  });
});
