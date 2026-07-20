/**
 * T-08 aws/CloudFormationGateway のテスト(tasks.md §5 T-08 の対応表)。
 *
 * 実 AWS には接続せず `aws-sdk-client-mock` で `send` をスタブする(§10)。
 * 各 it の先頭に対応する受け入れ基準 ID を明記する。
 */

import {
  CloudFormationClient,
  CreateChangeSetCommand,
  DeleteChangeSetCommand,
  DeleteStackCommand,
  DescribeChangeSetCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
  GetTemplateCommand,
  ListChangeSetsCommand,
} from '@aws-sdk/client-cloudformation';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CloudFormationGatewayImpl,
  type CloudFormationGatewayOptions,
} from '../../src/aws/cloudformation.js';
import type {
  CloudFormationGateway,
  StateBackend,
  StsGateway,
} from '../../src/ports/index.js';

const cfnMock = mockClient(CloudFormationClient);

beforeEach(() => {
  cfnMock.reset();
});

/** テスト用ゲートウェイ。ポーリング間隔・sleep を潰して 0ms 化する。 */
function makeGateway(
  overrides: Partial<CloudFormationGatewayOptions> = {},
): CloudFormationGatewayImpl {
  return new CloudFormationGatewayImpl({
    region: 'ap-northeast-1',
    maxAttempts: 10,
    pollIntervalMs: 0,
    pollTimeoutMs: 60_000,
    sleep: async () => {},
    ...overrides,
  });
}

function makeChange(logicalId: string) {
  return {
    Type: 'Resource',
    ResourceChange: {
      Action: 'Modify',
      LogicalResourceId: logicalId,
      PhysicalResourceId: `phys-${logicalId}`,
      ResourceType: 'AWS::EC2::VPC',
      Replacement: 'True',
      Scope: ['Properties'],
      Details: [
        {
          Target: {
            Attribute: 'Properties',
            Name: 'CidrBlock',
            RequiresRecreation: 'Always',
          },
          Evaluation: 'Static',
          ChangeSource: 'DirectModification',
        },
      ],
    },
  };
}

function makeSummary(name: string) {
  return {
    ChangeSetId: `arn:aws:cloudformation:changeSet/${name}`,
    ChangeSetName: name,
    Status: 'CREATE_COMPLETE',
    StatusReason: 'ready',
    ExecutionStatus: 'AVAILABLE',
    CreationTime: new Date('2026-07-19T00:00:00Z'),
  };
}

function makeEvent(eventId: string, timestamp = '2026-07-19T00:00:00Z') {
  return {
    EventId: eventId,
    Timestamp: new Date(timestamp),
    LogicalResourceId: 'Vpc',
    ResourceType: 'AWS::EC2::VPC',
    ResourceStatus: 'CREATE_COMPLETE',
  };
}

function notExistError(stackName: string): Error {
  return Object.assign(new Error(`Stack with id ${stackName} does not exist`), {
    name: 'ValidationError',
  });
}

function throttlingError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

// ---------------------------------------------------------------------------
// NFR-2: ports の 3 インターフェースに実装が適合する(型テスト + 実装テスト)
// ---------------------------------------------------------------------------

describe('NFR-2: ports インターフェース適合', () => {
  it('NFR-2: CloudFormationGatewayImpl は CloudFormationGateway 型に適合する', () => {
    // 型テスト: 代入が通ればシグネチャ適合。
    const gateway: CloudFormationGateway = makeGateway();
    for (const method of [
      'describeStack',
      'listChangeSets',
      'createChangeSet',
      'describeChangeSet',
      'waitForChangeSet',
      'deleteChangeSet',
      'executeChangeSet',
      'deleteStack',
      'describeStackEvents',
      'getTemplate',
      'waitForStack',
    ] as const) {
      expect(typeof gateway[method]).toBe('function');
    }
  });

  it('NFR-2: StsGateway インターフェースは実装可能な形である(型テスト)', () => {
    const sts: StsGateway = {
      async getCallerIdentity() {
        return {
          accountId: '123456789012',
          arn: 'arn:aws:iam::123456789012:role/x',
        };
      },
    };
    expect(typeof sts.getCallerIdentity).toBe('function');
  });

  it('NFR-2: StateBackend インターフェースは実装可能な形である(型テスト。ports に一本化)', () => {
    const backend: StateBackend = {
      async load() {
        return undefined;
      },
      async save() {
        return { backend: 'local', generation: 1 };
      },
      async acquireLock() {
        return { backend: 'local', runId: 'run-1' };
      },
      async verifyLock() {
        return true;
      },
      async releaseLock() {
        return { released: true };
      },
      async readLock() {
        return undefined;
      },
      async forceUnlock() {
        return { released: true };
      },
      stateId() {
        return 'abcd1234';
      },
    };
    expect(typeof backend.save).toBe('function');
    expect(backend.stateId()).toBe('abcd1234');
  });
});

// ---------------------------------------------------------------------------
// FR-2(基盤): 変更セットの作成・記述・削除・実行のパラメータマッピング
// ---------------------------------------------------------------------------

describe('FR-2(基盤): 変更セット SDK 呼び出しのパラメータマッピング', () => {
  it('FR-2: createChangeSet が全フィールド(StackName/ChangeSetName/ChangeSetType/TemplateBody/Parameters/Capabilities/Tags/Description)をマッピングする', async () => {
    cfnMock
      .on(CreateChangeSetCommand)
      .resolves({ Id: 'arn:aws:cloudformation:changeSet/abc' });
    const gateway = makeGateway();

    const res = await gateway.createChangeSet({
      stackName: 'prod-network',
      changeSetName: 'cfnsync-abcd-run1-20260719',
      changeSetType: 'UPDATE',
      templateBody: 'Resources: {}',
      parameters: { VpcCidr: '10.0.0.0/16', DbPassword: 'secret' },
      capabilities: ['CAPABILITY_NAMED_IAM'],
      tags: { Project: 'legacy-app', 'cfnsync:state-id': 'abcd' },
      description: 'cfnsync change set',
    });

    expect(res.id).toBe('arn:aws:cloudformation:changeSet/abc');
    const input = cfnMock.commandCalls(CreateChangeSetCommand)[0].args[0].input;
    expect(input.StackName).toBe('prod-network');
    expect(input.ChangeSetName).toBe('cfnsync-abcd-run1-20260719');
    expect(input.ChangeSetType).toBe('UPDATE');
    expect(input.TemplateBody).toBe('Resources: {}');
    expect(input.Capabilities).toEqual(['CAPABILITY_NAMED_IAM']);
    expect(input.Description).toBe('cfnsync change set');
    expect(input.Parameters).toEqual([
      { ParameterKey: 'VpcCidr', ParameterValue: '10.0.0.0/16' },
      { ParameterKey: 'DbPassword', ParameterValue: 'secret' },
    ]);
    expect(input.Tags).toEqual([
      { Key: 'Project', Value: 'legacy-app' },
      { Key: 'cfnsync:state-id', Value: 'abcd' },
    ]);
  });

  it('FR-2: createChangeSet は CREATE 型もそのまま渡す', async () => {
    cfnMock.on(CreateChangeSetCommand).resolves({ Id: 'arn:cs/create' });
    const gateway = makeGateway();
    await gateway.createChangeSet({
      stackName: 'stk',
      changeSetName: 'cs',
      changeSetType: 'CREATE',
      templateBody: 'x',
      parameters: {},
      capabilities: [],
      tags: {},
    });
    const input = cfnMock.commandCalls(CreateChangeSetCommand)[0].args[0].input;
    expect(input.ChangeSetType).toBe('CREATE');
    // 空パラメータ・空タグは空配列で渡る(あるいは省略)。実値マッピングのみ検証。
    expect(input.Parameters ?? []).toEqual([]);
    expect(input.Tags ?? []).toEqual([]);
  });

  it('FR-2: describeChangeSet は StackName/ChangeSetName を渡し、Changes を正規化しつつ全ページ結合する', async () => {
    cfnMock
      .on(DescribeChangeSetCommand)
      .resolvesOnce({
        ChangeSetName: 'cs',
        ChangeSetId: 'arn:cs/1',
        Status: 'CREATE_COMPLETE',
        ExecutionStatus: 'AVAILABLE',
        Changes: [makeChange('A')],
        Parameters: [{ ParameterKey: 'K', ParameterValue: 'V' }],
        Tags: [{ Key: 'T', Value: 'v' }],
        Capabilities: ['CAPABILITY_IAM'],
        NextToken: 'page2',
      })
      .resolvesOnce({ Status: 'CREATE_COMPLETE', Changes: [makeChange('B')] });

    const gateway = makeGateway();
    const detail = await gateway.describeChangeSet('stk', 'cs');

    expect(detail.status).toBe('CREATE_COMPLETE');
    expect(detail.executionStatus).toBe('AVAILABLE');
    expect(detail.changes.map((c) => c.logicalResourceId)).toEqual(['A', 'B']);
    expect(detail.changes[0]).toMatchObject({
      action: 'Modify',
      logicalResourceId: 'A',
      resourceType: 'AWS::EC2::VPC',
      replacement: 'True',
      scope: ['Properties'],
    });
    expect(detail.changes[0].details[0].target?.name).toBe('CidrBlock');
    expect(detail.parameters).toEqual({ K: 'V' });
    expect(detail.tags).toEqual({ T: 'v' });
    expect(detail.capabilities).toEqual(['CAPABILITY_IAM']);

    const calls = cfnMock.commandCalls(DescribeChangeSetCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0].args[0].input).toMatchObject({
      StackName: 'stk',
      ChangeSetName: 'cs',
    });
    expect(calls[1].args[0].input.NextToken).toBe('page2');
  });

  it('FR-2: deleteChangeSet / executeChangeSet が StackName/ChangeSetName を渡す', async () => {
    cfnMock.on(DeleteChangeSetCommand).resolves({});
    cfnMock.on(ExecuteChangeSetCommand).resolves({});
    const gateway = makeGateway();

    await gateway.deleteChangeSet('stk', 'cs-del');
    await gateway.executeChangeSet('stk', 'cs-exec');

    expect(
      cfnMock.commandCalls(DeleteChangeSetCommand)[0].args[0].input,
    ).toMatchObject({
      StackName: 'stk',
      ChangeSetName: 'cs-del',
    });
    expect(
      cfnMock.commandCalls(ExecuteChangeSetCommand)[0].args[0].input,
    ).toMatchObject({
      StackName: 'stk',
      ChangeSetName: 'cs-exec',
    });
  });

  it('FR-2: deleteStack が StackName を渡す', async () => {
    cfnMock.on(DeleteStackCommand).resolves({});
    const gateway = makeGateway();
    await gateway.deleteStack('stk');
    expect(
      cfnMock.commandCalls(DeleteStackCommand)[0].args[0].input,
    ).toMatchObject({ StackName: 'stk' });
  });
});

// ---------------------------------------------------------------------------
// §7(Codex 承認条件): ListChangeSets は全ページを走査する
// ---------------------------------------------------------------------------

describe('§7: ListChangeSets 全ページ走査', () => {
  it('§7: listChangeSets は NextToken 付き 2 ページ応答を全件列挙する', async () => {
    cfnMock
      .on(ListChangeSetsCommand, { StackName: 'stk' })
      .resolvesOnce({
        Summaries: [makeSummary('cs1'), makeSummary('cs2')],
        NextToken: 'page2',
      })
      .resolvesOnce({ Summaries: [makeSummary('cs3')] });

    const gateway = makeGateway();
    const list = await gateway.listChangeSets('stk');

    expect(list.map((c) => c.name)).toEqual(['cs1', 'cs2', 'cs3']);
    const calls = cfnMock.commandCalls(ListChangeSetsCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1].args[0].input.NextToken).toBe('page2');
  });

  it('§7: listChangeSets は Summaries を正規化する(name/id/status/executionStatus/creationTime)', async () => {
    cfnMock
      .on(ListChangeSetsCommand)
      .resolves({ Summaries: [makeSummary('cs1')] });
    const gateway = makeGateway();
    const [cs] = await gateway.listChangeSets('stk');
    expect(cs).toMatchObject({
      name: 'cs1',
      id: 'arn:aws:cloudformation:changeSet/cs1',
      status: 'CREATE_COMPLETE',
      statusReason: 'ready',
      executionStatus: 'AVAILABLE',
    });
    expect(cs.creationTime).toBe('2026-07-19T00:00:00.000Z');
  });

  it('§7: listChangeSets は変更セットが無い場合に空配列を返す', async () => {
    cfnMock.on(ListChangeSetsCommand).resolves({});
    const gateway = makeGateway();
    expect(await gateway.listChangeSets('stk')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §7: スタック状態の取得(DescribeStacks / 不存在判定)
// ---------------------------------------------------------------------------

describe('§7: スタック状態取得', () => {
  it('§7: describeStack は StackStatus・パラメータ・タグ・Capabilities・Outputs・削除保護を正規化する', async () => {
    cfnMock.on(DescribeStacksCommand, { StackName: 'stk' }).resolves({
      Stacks: [
        {
          StackName: 'stk',
          StackId: 'arn:aws:cloudformation:stack/stk',
          StackStatus: 'ROLLBACK_COMPLETE',
          StackStatusReason: 'create failed',
          Parameters: [{ ParameterKey: 'K', ParameterValue: 'V' }],
          Tags: [{ Key: 'cfnsync:state-id', Value: 'abcd' }],
          Capabilities: ['CAPABILITY_IAM'],
          Outputs: [
            {
              OutputKey: 'VpcId',
              OutputValue: 'vpc-123',
              ExportName: 'stk-VpcId',
            },
          ],
          EnableTerminationProtection: true,
          CreationTime: new Date('2026-07-19T00:00:00Z'),
        },
      ],
    });

    const gateway = makeGateway();
    const summary = await gateway.describeStack('stk');

    expect(summary).toBeDefined();
    expect(summary).toMatchObject({
      stackName: 'stk',
      stackId: 'arn:aws:cloudformation:stack/stk',
      status: 'ROLLBACK_COMPLETE',
      statusReason: 'create failed',
      parameters: { K: 'V' },
      tags: { 'cfnsync:state-id': 'abcd' },
      capabilities: ['CAPABILITY_IAM'],
      outputs: { VpcId: 'vpc-123' },
      terminationProtection: true,
    });
  });

  it('§7: describeStack は削除保護未指定を false に正規化する', async () => {
    cfnMock.on(DescribeStacksCommand).resolves({
      Stacks: [
        { StackName: 'stk', StackId: 'id', StackStatus: 'CREATE_COMPLETE' },
      ],
    });
    const gateway = makeGateway();
    const summary = await gateway.describeStack('stk');
    expect(summary?.terminationProtection).toBe(false);
    expect(summary?.parameters).toEqual({});
    expect(summary?.tags).toEqual({});
    expect(summary?.outputs).toEqual({});
    expect(summary?.capabilities).toEqual([]);
  });

  it('§7: describeStack はスタック不存在(ValidationError)を undefined に吸収する', async () => {
    cfnMock.on(DescribeStacksCommand).rejects(notExistError('stk'));
    const gateway = makeGateway();
    expect(await gateway.describeStack('stk')).toBeUndefined();
  });

  it('§7: describeStack は不存在以外の SDK エラーを AwsError に変換する', async () => {
    cfnMock
      .on(DescribeStacksCommand)
      .rejects(
        Object.assign(new Error('not authorized'), { name: 'AccessDenied' }),
      );
    const gateway = makeGateway();
    await expect(gateway.describeStack('stk')).rejects.toMatchObject({
      name: 'AwsError',
      message: expect.stringMatching(/not authorized/),
    });
  });
});

// ---------------------------------------------------------------------------
// FR-4-1(基盤): スタックイベントの取得(ページング・新着差分)
// ---------------------------------------------------------------------------

describe('FR-4-1(基盤): スタックイベント取得', () => {
  it('FR-4-1: describeStackEvents は全ページを走査し、seenEventIds を除いた新着のみを古い順で返す', async () => {
    // AWS は新しい順に返す。page1: e3(newest), e2 / page2: e1(oldest)。
    cfnMock
      .on(DescribeStackEventsCommand, { StackName: 'stk' })
      .resolvesOnce({
        StackEvents: [makeEvent('e3'), makeEvent('e2')],
        NextToken: 'page2',
      })
      .resolvesOnce({ StackEvents: [makeEvent('e1')] });

    const gateway = makeGateway();
    const seen = new Set(['e1']); // e1 は既読
    const events = await gateway.describeStackEvents('stk', seen);

    // 新着のみ(e1 除外)を古い順(oldest-first)で。
    expect(events.map((e) => e.eventId)).toEqual(['e2', 'e3']);
    const calls = cfnMock.commandCalls(DescribeStackEventsCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1].args[0].input.NextToken).toBe('page2');
  });

  it('FR-4-1: describeStackEvents は seenEventIds 省略時に全イベントを古い順で返す', async () => {
    cfnMock.on(DescribeStackEventsCommand).resolves({
      StackEvents: [makeEvent('e2'), makeEvent('e1')], // newest-first
    });
    const gateway = makeGateway();
    const events = await gateway.describeStackEvents('stk');
    expect(events.map((e) => e.eventId)).toEqual(['e1', 'e2']);
    expect(events[0]).toMatchObject({
      eventId: 'e1',
      logicalResourceId: 'Vpc',
      resourceType: 'AWS::EC2::VPC',
      resourceStatus: 'CREATE_COMPLETE',
    });
    expect(events[0].timestamp).toBe('2026-07-19T00:00:00.000Z');
  });

  it('FR-4-1 / NFR-5: 開始境界に到達したページで走査を打ち切り、過去 2 ページ分を読み込まない', async () => {
    cfnMock.on(DescribeStackEventsCommand, { StackName: 'stk' }).resolvesOnce({
      StackEvents: [
        makeEvent('new-2', '2026-07-20T00:02:00Z'),
        makeEvent('new-1', '2026-07-20T00:01:00Z'),
        makeEvent('boundary', '2026-07-20T00:00:00Z'),
        makeEvent('old-page-1', '2026-07-19T23:59:00Z'),
      ],
      NextToken: 'historical-page-2',
    });

    const gateway = makeGateway();
    const events = await gateway.describeStackEvents('stk', new Set(), {
      eventId: 'boundary',
      timestamp: '2026-07-20T00:00:00.000Z',
    });

    expect(events.map((event) => event.eventId)).toEqual(['new-1', 'new-2']);
    expect(cfnMock.commandCalls(DescribeStackEventsCommand)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §7(復旧基盤): GetTemplate(Original ステージ)
// ---------------------------------------------------------------------------

describe('§7: GetTemplate(復旧比較・import 基盤)', () => {
  it('§7: getTemplate は TemplateStage を渡し TemplateBody を返す', async () => {
    cfnMock
      .on(GetTemplateCommand)
      .resolves({ TemplateBody: 'Resources:\n  Vpc: {}' });
    const gateway = makeGateway();

    const body = await gateway.getTemplate('stk', 'Original');
    expect(body).toBe('Resources:\n  Vpc: {}');
    expect(
      cfnMock.commandCalls(GetTemplateCommand)[0].args[0].input,
    ).toMatchObject({
      StackName: 'stk',
      TemplateStage: 'Original',
    });
  });

  it('§7: getTemplate は Processed ステージも渡せる', async () => {
    cfnMock.on(GetTemplateCommand).resolves({ TemplateBody: '{}' });
    const gateway = makeGateway();
    await gateway.getTemplate('stk', 'Processed');
    expect(
      cfnMock.commandCalls(GetTemplateCommand)[0].args[0].input.TemplateStage,
    ).toBe('Processed');
  });
});

// ---------------------------------------------------------------------------
// 待機(ポーリング間隔注入・終端判定)
// ---------------------------------------------------------------------------

describe('待機(ポーリング間隔は注入で 0ms)', () => {
  it('internal: waitForChangeSet は CREATE_COMPLETE までポーリングして詳細を返す', async () => {
    cfnMock
      .on(DescribeChangeSetCommand)
      .resolvesOnce({ Status: 'CREATE_IN_PROGRESS', Changes: [] })
      .resolvesOnce({ Status: 'CREATE_COMPLETE', Changes: [makeChange('A')] });

    const gateway = makeGateway();
    const detail = await gateway.waitForChangeSet('stk', 'cs');

    expect(detail.status).toBe('CREATE_COMPLETE');
    expect(detail.changes.map((c) => c.logicalResourceId)).toEqual(['A']);
    expect(
      cfnMock.commandCalls(DescribeChangeSetCommand).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('internal: waitForChangeSet は FAILED(空変更セット)でも終端として返す', async () => {
    cfnMock.on(DescribeChangeSetCommand).resolves({
      Status: 'FAILED',
      StatusReason: "The submitted information didn't contain changes.",
      Changes: [],
    });
    const gateway = makeGateway();
    const detail = await gateway.waitForChangeSet('stk', 'cs');
    expect(detail.status).toBe('FAILED');
    expect(detail.statusReason).toMatch(/didn't contain changes/);
  });

  it('NFR-5: waitForChangeSet は待機中に先頭ページだけ確認し、終端到達時だけ残りページを取得する', async () => {
    cfnMock
      .on(DescribeChangeSetCommand)
      .resolvesOnce({
        Status: 'CREATE_IN_PROGRESS',
        Changes: [makeChange('pending')],
        NextToken: 'pending-page-2',
      })
      .resolvesOnce({
        Status: 'CREATE_COMPLETE',
        Changes: [makeChange('A')],
        NextToken: 'terminal-page-2',
      })
      .resolvesOnce({ Changes: [makeChange('B')] });

    const detail = await makeGateway().waitForChangeSet('stk', 'cs');
    expect(detail.changes.map((change) => change.logicalResourceId)).toEqual([
      'A',
      'B',
    ]);
    const calls = cfnMock.commandCalls(DescribeChangeSetCommand);
    expect(calls.map((call) => call.args[0].input.NextToken)).toEqual([
      undefined,
      undefined,
      'terminal-page-2',
    ]);
  });

  it('NFR-5: waitForStack はイベントを5秒ごと、スタック状態を5→10→15秒の上限付きバックオフで確認する', async () => {
    cfnMock
      .on(DescribeStacksCommand)
      .resolvesOnce({
        Stacks: [{ StackName: 'stk', StackStatus: 'UPDATE_IN_PROGRESS' }],
      })
      .resolvesOnce({
        Stacks: [{ StackName: 'stk', StackStatus: 'UPDATE_IN_PROGRESS' }],
      })
      .resolvesOnce({
        Stacks: [{ StackName: 'stk', StackStatus: 'UPDATE_IN_PROGRESS' }],
      })
      .resolvesOnce({
        Stacks: [{ StackName: 'stk', StackStatus: 'UPDATE_COMPLETE' }],
      });
    cfnMock.on(DescribeStackEventsCommand).resolves({ StackEvents: [] });
    const sleep = vi.fn(async () => {});

    await makeGateway({ pollIntervalMs: 5_000, sleep }).waitForStack('stk', {
      onEvent: () => {},
    });

    expect(cfnMock.commandCalls(DescribeStacksCommand)).toHaveLength(4);
    expect(cfnMock.commandCalls(DescribeStackEventsCommand)).toHaveLength(8);
    expect(sleep.mock.calls).toEqual(Array.from({ length: 6 }, () => [5_000]));
  });

  it('FR-4-1: waitForStack は終端まで待機し、新着イベントを古い順で onEvent 通知する(重複なし)', async () => {
    cfnMock
      .on(DescribeStacksCommand)
      .resolvesOnce({
        Stacks: [
          {
            StackName: 'stk',
            StackId: 'id',
            StackStatus: 'UPDATE_IN_PROGRESS',
          },
        ],
      })
      .resolvesOnce({
        Stacks: [
          { StackName: 'stk', StackId: 'id', StackStatus: 'UPDATE_COMPLETE' },
        ],
      });
    cfnMock
      .on(DescribeStackEventsCommand)
      // wait 開始時の境界取得。過去履歴の最新は e0。
      .resolvesOnce({ StackEvents: [makeEvent('e0')] })
      .resolvesOnce({ StackEvents: [makeEvent('e1'), makeEvent('e0')] })
      .resolvesOnce({
        StackEvents: [makeEvent('e2'), makeEvent('e1'), makeEvent('e0')],
      });

    const streamed: string[] = [];
    const gateway = makeGateway();
    const summary = await gateway.waitForStack('stk', {
      intervalMs: 0,
      onEvent: (e) => streamed.push(e.eventId),
    });

    expect(summary.status).toBe('UPDATE_COMPLETE');
    // 古い順で通知され、ポーリング間で重複しない。
    expect(streamed).toEqual(['e1', 'e2']);
    expect(cfnMock.commandCalls(DescribeStackEventsCommand)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// NFR-3(リトライ): クライアント adaptive 構成 + Throttling 再試行
// ---------------------------------------------------------------------------

describe('NFR-3(リトライ): スロットリング対応', () => {
  it('NFR-3: クライアントが adaptive retry mode / maxAttempts で構成される', async () => {
    const gateway = makeGateway({ maxAttempts: 10 });
    const rm = gateway.client.config.retryMode;
    const resolvedRm = typeof rm === 'function' ? await rm() : rm;
    expect(resolvedRm).toBe('adaptive');

    const ma = gateway.client.config.maxAttempts;
    const resolvedMa = typeof ma === 'function' ? await ma() : ma;
    expect(resolvedMa).toBe(10);
  });

  it.each([
    'ThrottlingException',
    'Throttling',
    'TooManyRequestsException',
  ])('NFR-3: %s 応答後にリトライして成功する', async (name) => {
    const sleep = vi.fn(async () => {});
    cfnMock
      .on(GetTemplateCommand)
      .rejectsOnce(throttlingError(name))
      .resolves({ TemplateBody: 'ok' });

    const gateway = makeGateway({ sleep, maxRetries: 1 });
    expect(await gateway.getTemplate('stk', 'Original')).toBe('ok');
    // 初回 + リトライ = 2 回 send。
    expect(cfnMock.commandCalls(GetTemplateCommand)).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('NFR-3: テスト用外側 retry は明示指定時だけ full jitter を使う', async () => {
    const sleep = vi.fn(async () => {});
    cfnMock
      .on(ExecuteChangeSetCommand)
      .rejects(throttlingError('ThrottlingException'));

    const gateway = makeGateway({
      sleep,
      random: () => 0.5,
      maxRetries: 2,
    });
    await expect(gateway.executeChangeSet('stk', 'cs')).rejects.toThrow(
      /ThrottlingException/,
    );
    // 初回 + 2 リトライ = 3 回 send、sleep は 2 回。
    expect(cfnMock.commandCalls(ExecuteChangeSetCommand)).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls).toEqual([[50], [100]]);
  });

  it('NFR-3: 総経過時間上限に達した後は sleep も次の attempt も行わない', async () => {
    let elapsed = 0;
    const sleep = vi.fn(async (ms: number) => {
      elapsed += ms;
    });
    const retryNow = vi.fn(() => elapsed);
    cfnMock
      .on(ExecuteChangeSetCommand)
      .rejects(throttlingError('ThrottlingException'));

    const gateway = makeGateway({
      sleep,
      retryNow,
      baseDelayMs: 100_000,
      random: () => 1,
      maxRetryElapsedMs: 60_000,
      maxRetries: 2,
    });
    await expect(gateway.executeChangeSet('stk', 'cs')).rejects.toThrow(
      /ThrottlingException/,
    );
    expect(cfnMock.commandCalls(ExecuteChangeSetCommand)).toHaveLength(1);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(60_000);
  });

  it('NFR-3: スロットリング以外のエラーはリトライせず即伝播する', async () => {
    const sleep = vi.fn(async () => {});
    cfnMock
      .on(ExecuteChangeSetCommand)
      .rejects(Object.assign(new Error('boom'), { name: 'ValidationError' }));
    const gateway = makeGateway({ sleep });
    await expect(gateway.executeChangeSet('stk', 'cs')).rejects.toThrow(/boom/);
    expect(cfnMock.commandCalls(ExecuteChangeSetCommand)).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
