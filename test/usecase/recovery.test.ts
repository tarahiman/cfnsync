/**
 * T-18 障害注入・復旧シナリオ。
 * tasks.md §6 T-18 の表を正本とし、テスト名に対応 ID を明記する。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { resolveTargets, validateConfig, type CfnSyncConfig } from '../../src/core/config.js';
import { computeInputsHash, computeTemplateHash } from '../../src/core/detect.js';
import {
  createInitialState,
  upsertStackEntry,
  withAccountId,
  type CfnSyncState,
} from '../../src/core/state.js';
import { analyzeTemplate } from '../../src/core/template.js';
import type { CloudFormationGateway, CreateChangeSetInput, StackSummary } from '../../src/ports/index.js';
import { deploy } from '../../src/usecase/deploy.js';
import { MANAGEMENT_TAG_KEY } from '../../src/usecase/executor.js';
import { forceUnlock } from '../../src/usecase/forceUnlock.js';
import {
  FakeCloudFormationGateway,
  FakeStateBackend,
  makeChangeSetDetail,
  makeStackSummary,
} from './fakes.js';

const ACCOUNT = '123456789012';
const REGION = 'ap-northeast-1';
const STATE_ID = 'aabbccddeeff';
const FIXED_NOW = () => new Date('2026-07-20T12:00:00.000Z');
const scenarioGateways: FakeCloudFormationGateway[] = [];

const TEMPLATE = `
AWSTemplateFormatVersion: '2010-09-09'
Parameters:
  Environment:
    Type: String
Resources:
  Bucket:
    Type: AWS::S3::Bucket
`;

// キー順・表現形式が異なるが、パース後は TEMPLATE と同値。
const EQUIVALENT_TEMPLATE = JSON.stringify({
  Resources: { Bucket: { Type: 'AWS::S3::Bucket' } },
  Parameters: { Environment: { Type: 'String' } },
  AWSTemplateFormatVersion: '2010-09-09',
});

const SECRET_TEMPLATE = `
AWSTemplateFormatVersion: '2010-09-09'
Parameters:
  Secret:
    Type: String
    NoEcho: true
Resources:
  Bucket:
    Type: AWS::S3::Bucket
`;

function configOf(stack: Record<string, unknown> | undefined): CfnSyncConfig {
  return validateConfig(
    {
      version: 1,
      defaultRegion: REGION,
      allowedAccounts: [ACCOUNT],
      allowedRegions: [REGION],
      stacks: stack ? { 'stack.yaml': stack } : {},
    },
    { templateExists: () => true },
  );
}

function recordedState(
  config: CfnSyncConfig,
  templates: Map<string, string>,
  options: { staleInputs?: boolean } = {},
): CfnSyncState {
  let state = withAccountId(createInitialState(), ACCOUNT);
  for (const target of resolveTargets(config)) {
    const source = templates.get(target.templatePath);
    if (source === undefined) throw new Error(`missing test template: ${target.templatePath}`);
    const analysis = analyzeTemplate(source, { stackName: target.stackName, region: target.region });
    state = upsertStackEntry(state, target.stackKey, {
      stackName: target.stackName,
      region: target.region,
      templateHash: computeTemplateHash(source),
      inputsHash: options.staleInputs
        ? 'sha256:before-aws-success'
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
      lastAction: 'UPDATE',
      lastSuccessAt: '2026-07-19T00:00:00.000Z',
    });
  }
  return state;
}

function setup(config: CfnSyncConfig, templates: Map<string, string>, initial: CfnSyncState) {
  const timeline: string[] = [];
  const backend = new FakeStateBackend(timeline, initial, STATE_ID);
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
  let runNumber = 0;
  const run = (options: { allowDelete?: boolean } = {}) =>
    deploy({
      config,
      configDir: '/repo',
      templates,
      deps: {
        cfnFactory: (): CloudFormationGateway => cfn,
        sts: {
          async getCallerIdentity() {
            return { accountId: ACCOUNT, arn: `arn:aws:iam::${ACCOUNT}:role/test` };
          },
        },
        backend,
        now: FIXED_NOW,
        runId: () => `recovery${++runNumber}`,
      },
      options,
    });
  return { backend, cfn, run, timeline };
}

function desiredInputsHash(config: CfnSyncConfig, templates: Map<string, string>): string {
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

function installExisting(
  cfn: FakeCloudFormationGateway,
  overrides: Partial<StackSummary> = {},
  deployedTemplate = EQUIVALENT_TEMPLATE,
): void {
  cfn.stacks.set(
    'ManagedStack',
    makeStackSummary({
      stackName: 'ManagedStack',
      status: 'CREATE_COMPLETE',
      parameters: { Environment: 'dev' },
      tags: { Team: 'platform', [MANAGEMENT_TAG_KEY]: STATE_ID },
      capabilities: ['CAPABILITY_IAM'],
      ...overrides,
    }),
  );
  cfn.templates.set('ManagedStack', deployedTemplate);
}

function createConfig(): CfnSyncConfig {
  return configOf({
    stackName: 'ManagedStack',
    parameters: { Environment: 'dev' },
    tags: { Team: 'platform' },
    capabilities: ['CAPABILITY_IAM'],
  });
}

function reportErrors(result: Awaited<ReturnType<typeof deploy>>): string {
  return (result.report.result?.stacks ?? []).map((stack) => stack.errorMessage ?? '').join('\n');
}

afterEach(() => {
  // FR-2-10(横断): T-18 の全復旧シナリオで REVIEW_IN_PROGRESS への DeleteStack を禁止する。
  for (const cfn of scenarioGateways) expect(cfn.reviewInProgressDeleteCalls).toEqual([]);
  scenarioGateways.length = 0;
});

describe('T-18 recovery', () => {
  it('FR-1-11(a): CREATE 成功+保存失敗後、全入力と管理タグが一致すれば再同期して state に記録する', async () => {
    const config = createConfig();
    const templates = new Map([['stack.yaml', TEMPLATE]]);
    const s = setup(config, templates, withAccountId(createInitialState(), ACCOUNT));
    s.backend.saveError = new Error('injected: CREATE succeeded but state save failed');

    const interrupted = await s.run();

    expect(interrupted.exitCode).toBe(1);
    expect(s.cfn.callsOf('executeChangeSet')).toHaveLength(1);
    expect(s.backend.stored?.state.stacks['stack.yaml@ap-northeast-1']).toBeUndefined();
    const createInput = s.cfn.callsOf('createChangeSet')[0].args[0] as CreateChangeSetInput;
    installExisting(
      s.cfn,
      {
        parameters: createInput.parameters,
        tags: createInput.tags,
        capabilities: createInput.capabilities,
      },
      EQUIVALENT_TEMPLATE,
    );
    s.backend.saveError = undefined;

    const recovered = await s.run();

    expect(recovered.exitCode).toBe(0);
    expect(s.cfn.callsOf('createChangeSet')).toHaveLength(1);
    expect(s.cfn.callsOf('getTemplate').at(-1)?.args).toEqual(['ManagedStack', 'Original']);
    expect(s.backend.stored?.state.stacks['stack.yaml@ap-northeast-1']).toMatchObject({
      lastAction: 'SYNC',
      inputsHash: desiredInputsHash(config, templates),
    });
  });

  it.each([
    ['管理タグ欠如', { Team: 'platform' }],
    ['別 state ID', { Team: 'platform', [MANAGEMENT_TAG_KEY]: 'another-state' }],
  ])('FR-1-11(a) 管理タグ fail-closed: %s は再同期せず import を案内する', async (_label, tags) => {
    const config = createConfig();
    const templates = new Map([['stack.yaml', TEMPLATE]]);
    const s = setup(config, templates, withAccountId(createInitialState(), ACCOUNT));
    installExisting(s.cfn, { tags });

    const result = await s.run();

    expect(result.exitCode).toBe(1);
    expect(reportErrors(result)).toContain('cfnsync import');
    expect(s.backend.saveCalls).toHaveLength(0);
    expect(s.cfn.callsOf('createChangeSet')).toHaveLength(0);
  });

  it('FR-1-11(a) 検証不能入力: dependsOn/NoEcho を比較から除外し、希望 inputsHash と warnings を残す', async () => {
    const config = configOf({
      stackName: 'ManagedStack',
      parameters: { Secret: 'local-desired-secret' },
      tags: { Team: 'platform' },
      dependsOn: ['external.yaml'],
    });
    const templates = new Map([['stack.yaml', SECRET_TEMPLATE]]);
    const s = setup(config, templates, withAccountId(createInitialState(), ACCOUNT));
    installExisting(
      s.cfn,
      {
        parameters: { Secret: '****different-unverifiable-value****' },
        tags: { Team: 'platform', [MANAGEMENT_TAG_KEY]: STATE_ID },
        capabilities: [],
      },
      SECRET_TEMPLATE,
    );

    const result = await s.run();

    expect(result.exitCode).toBe(0);
    expect(s.backend.stored?.state.stacks['stack.yaml@ap-northeast-1'].inputsHash).toBe(
      desiredInputsHash(config, templates),
    );
    expect(result.report.diffs[0].warnings.join('\n')).toMatch(/NoEcho.*Secret|Secret.*NoEcho/);
    expect(result.report.diffs[0].warnings.join('\n')).toMatch(/dependsOn.*external\.yaml/);
  });

  it.each(['tags', 'capabilities', 'noecho-unmanaged'] as const)(
    'FR-1-11(a) 不一致(%s): 命名衝突として再同期せず import を案内する',
    async (variant) => {
      const secret = variant === 'noecho-unmanaged';
      const config = secret
        ? configOf({ stackName: 'ManagedStack', parameters: { Secret: 'local-secret' } })
        : createConfig();
      const source = secret ? SECRET_TEMPLATE : TEMPLATE;
      const templates = new Map([['stack.yaml', source]]);
      const s = setup(config, templates, withAccountId(createInitialState(), ACCOUNT));

      if (variant === 'tags') {
        installExisting(s.cfn, { tags: { Team: 'other', [MANAGEMENT_TAG_KEY]: STATE_ID } });
      } else if (variant === 'capabilities') {
        installExisting(s.cfn, { capabilities: [] });
      } else {
        installExisting(
          s.cfn,
          { parameters: { Secret: 'different' }, tags: {}, capabilities: [] },
          SECRET_TEMPLATE,
        );
      }

      const result = await s.run();

      expect(result.exitCode).toBe(1);
      expect(reportErrors(result)).toContain('cfnsync import');
      expect(s.backend.saveCalls).toHaveLength(0);
      expect(s.cfn.callsOf('createChangeSet')).toHaveLength(0);
      expect(s.cfn.callsOf('executeChangeSet')).toHaveLength(0);
    },
  );

  it('FR-1-11(b): DELETE 成功+保存失敗後、再実行は不存在を確認して state から除去する', async () => {
    const oldConfig = configOf({ stackName: 'ManagedStack' });
    const oldTemplates = new Map([['stack.yaml', TEMPLATE]]);
    const initial = recordedState(oldConfig, oldTemplates);
    const s = setup(configOf(undefined), new Map(), initial);
    s.cfn.stacks.set('ManagedStack', makeStackSummary({ stackName: 'ManagedStack', status: 'CREATE_COMPLETE' }));
    s.cfn.waitResults.set(
      'ManagedStack',
      [makeStackSummary({ stackName: 'ManagedStack', status: 'DELETE_COMPLETE' })],
    );
    s.backend.saveError = new Error('injected: DELETE succeeded but state save failed');

    const interrupted = await s.run({ allowDelete: true });

    expect(interrupted.exitCode).toBe(1);
    expect(s.cfn.callsOf('deleteStack').map((call) => call.args[0])).toEqual(['ManagedStack']);
    expect(s.backend.stored?.state.stacks['stack.yaml@ap-northeast-1']).toBeDefined();
    s.cfn.stacks.delete('ManagedStack');
    s.backend.saveError = undefined;

    const recovered = await s.run({ allowDelete: true });

    expect(recovered.exitCode).toBe(0);
    expect(s.cfn.callsOf('deleteStack')).toHaveLength(1);
    expect(s.backend.stored?.state.stacks['stack.yaml@ap-northeast-1']).toBeUndefined();
  });

  it('FR-1-11(c): UPDATE 成功+保存失敗後、空変更セットを変更なしとして state を再同期する', async () => {
    const config = configOf({ stackName: 'ManagedStack', tags: { Version: 'new' } });
    const templates = new Map([['stack.yaml', TEMPLATE]]);
    const initial = recordedState(config, templates, { staleInputs: true });
    const s = setup(config, templates, initial);
    s.cfn.stacks.set('ManagedStack', makeStackSummary({ stackName: 'ManagedStack', status: 'UPDATE_COMPLETE' }));
    s.backend.saveError = new Error('injected: UPDATE succeeded but state save failed');

    expect((await s.run()).exitCode).toBe(1);
    expect(s.cfn.callsOf('executeChangeSet')).toHaveLength(1);
    expect(s.backend.stored?.state.stacks['stack.yaml@ap-northeast-1'].inputsHash).toBe(
      'sha256:before-aws-success',
    );
    s.backend.saveError = undefined;
    s.cfn.defaultChangeSetDetail = makeChangeSetDetail({
      status: 'FAILED',
      statusReason: "The submitted information didn't contain changes",
    });

    const recovered = await s.run();

    expect(recovered.exitCode).toBe(0);
    expect(recovered.report.diffs.at(-1)?.operation).toBe('no-change');
    expect(s.cfn.callsOf('createChangeSet')).toHaveLength(2);
    expect(s.cfn.callsOf('executeChangeSet')).toHaveLength(1);
    expect(s.backend.stored?.state.stacks['stack.yaml@ap-northeast-1'].inputsHash).toBe(
      desiredInputsHash(config, templates),
    );
  });

  it('FR-1-10(復旧): force-unlock 後の再実行が変更検知と変更セット再作成で冪等収束する', async () => {
    const config = configOf({ stackName: 'ManagedStack', tags: { Version: 'new' } });
    const templates = new Map([['stack.yaml', TEMPLATE]]);
    const s = setup(config, templates, recordedState(config, templates, { staleInputs: true }));
    s.cfn.stacks.set('ManagedStack', makeStackSummary({ stackName: 'ManagedStack', status: 'UPDATE_COMPLETE' }));
    s.backend.saveError = new Error('injected crash before state save');

    expect((await s.run()).exitCode).toBe(1);
    await s.backend.acquireLock({
      runId: 'abandoned-run',
      startedAt: '2026-07-20T12:01:00.000Z',
      owner: 'crashed-ci',
    });
    const unlocked = await forceUnlock({ backend: s.backend, runId: 'abandoned-run' });
    expect(unlocked).toMatchObject({ exitCode: 0, released: true });
    s.backend.saveError = undefined;
    s.cfn.defaultChangeSetDetail = makeChangeSetDetail({
      status: 'FAILED',
      statusReason: 'No updates are to be performed',
    });

    const recovered = await s.run();

    expect(recovered.exitCode).toBe(0);
    expect(s.cfn.callsOf('createChangeSet')).toHaveLength(2);
    expect(s.cfn.callsOf('executeChangeSet')).toHaveLength(1);
    expect(s.backend.stored?.state.stacks['stack.yaml@ap-northeast-1'].inputsHash).toBe(
      desiredInputsHash(config, templates),
    );
  });
});
