/**
 * T-13 usecase/executor — 変更セットライフサイクルのテスト。
 *
 * 対応表: tasks.md §6 T-13(FR-2-1〜FR-2-11)。各 it の先頭に受け入れ基準 ID を明記する。
 * ゲートウェイは `FakeCloudFormationGateway`(呼び出し記録付きインメモリフェイク)に
 * 差し替える(design.md §10)。実 AWS には一切接続しない。
 *
 * 安全性の中核:
 * - FR-2-10: `REVIEW_IN_PROGRESS` に対して DeleteStack が **一切呼ばれない**ことを固定。
 * - FR-2-11(Codex 承認条件): 実行直前再検査(listChangeSets)が ExecuteChangeSet の
 *   **直前**に配置されること、他主体検出時に ExecuteChangeSet が呼ばれないことを固定。
 */

import { describe, expect, it } from 'vitest';
import {
  type ResolvedStackTarget,
  resolveTargets,
  validateConfig,
} from '../../src/core/config.js';
import { StackStateError } from '../../src/core/errors.js';
import { makeStackKey } from '../../src/core/types.js';
import {
  type CreatedChangeSetRef,
  changeSetName,
  createManagedChangeSet,
  type ExecutorContext,
  executeWithReinspection,
  MANAGEMENT_TAG_KEY,
  newRunId,
  parseChangeSetName,
  prepareStack,
  reclaimStaleChangeSets,
} from '../../src/usecase/executor.js';
import {
  FakeCloudFormationGateway,
  makeChangeSetDetail,
  makeChangeSetSummary,
  makeStackSummary,
} from './fakes.js';

const STATE_ID = 'abc123def456';
const RUN_ID = '0123456789abcdef';
const STACK = 'my-network';
const FIXED_NOW = () => new Date('2026-07-20T13:45:01.123Z');

function makeCtx(
  fake: FakeCloudFormationGateway,
  overrides: Partial<ExecutorContext> = {},
): ExecutorContext {
  return {
    cfn: fake,
    target: {
      stackKey: makeStackKey('network.yaml', 'ap-northeast-1'),
      region: 'ap-northeast-1',
    },
    stateId: STATE_ID,
    runId: RUN_ID,
    now: FIXED_NOW,
    ...overrides,
  };
}

function makeTarget(
  overrides: Partial<ResolvedStackTarget> = {},
): ResolvedStackTarget {
  return {
    stackKey: makeStackKey('network.yaml', 'ap-northeast-1'),
    templatePath: 'network.yaml',
    stackName: STACK,
    region: 'ap-northeast-1',
    parameters: {},
    tags: {},
    capabilities: [],
    dependsOn: [],
    ...overrides,
  };
}

/** 自ステート ID の変更セット名(過去実行の残骸を模す)。 */
function ownChangeSetName(runId = 'fedcba9876543210'): string {
  return changeSetName({ stateId: STATE_ID, runId, now: FIXED_NOW });
}

// ===========================================================================
// FR-2-6: 命名規則 / 所有権判定
// ===========================================================================

describe('changeSetName / parseChangeSetName / newRunId (FR-2-6)', () => {
  it('FR-2-6: 変更セット名は cfnsync-<stateId>-<runId>-<UTCタイムスタンプ> 形式', () => {
    const name = changeSetName({
      stateId: STATE_ID,
      runId: RUN_ID,
      now: FIXED_NOW,
    });
    expect(name).toBe(
      'cfnsync-abc123def456-0123456789abcdef-20260720T134501123',
    );
  });

  it('FR-2-6: 名前は CloudFormation 制約(先頭英字・英数字とハイフン・128 文字以内)を満たす', () => {
    const name = changeSetName({
      stateId: STATE_ID,
      runId: RUN_ID,
      now: FIXED_NOW,
    });
    expect(name.length).toBeLessThanOrEqual(128);
    expect(name).toMatch(/^[A-Za-z][A-Za-z0-9-]*$/);
  });

  it('FR-2-6: parseChangeSetName は自ツール由来の変更セットを一意にパースする', () => {
    const name = changeSetName({
      stateId: STATE_ID,
      runId: RUN_ID,
      now: FIXED_NOW,
    });
    expect(parseChangeSetName(name)).toEqual({
      tool: true,
      stateId: STATE_ID,
      runId: RUN_ID,
    });
  });

  it('FR-2-6: 非 cfnsync- 名は tool:false(人手・他ツール由来)', () => {
    expect(parseChangeSetName('my-manual-changeset')).toEqual({ tool: false });
    expect(parseChangeSetName('cdk-deploy-123')).toEqual({ tool: false });
  });

  it('FR-2-6: cfnsync- だが形式不正な名は tool:true・stateId 判定不能', () => {
    // パーツ不足 / 過剰 / 空パーツ → 所有権を判定できない。
    expect(parseChangeSetName('cfnsync-onlyone')).toEqual({ tool: true });
    expect(parseChangeSetName('cfnsync-a-b-c-d')).toEqual({ tool: true });
    expect(parseChangeSetName('cfnsync-')).toEqual({ tool: true });
    expect(
      parseChangeSetName('cfnsync-abc123def456-not16hex-20260720T134501123'),
    ).toEqual({ tool: true });
    expect(
      parseChangeSetName(
        'cfnsync-abc123def456-0123456789abcdef-20260720T13450112Z',
      ),
    ).toEqual({ tool: true });
    expect(
      parseChangeSetName(
        'cfnsync-ABC123DEF456-0123456789abcdef-20260720T134501123',
      ),
    ).toEqual({ tool: true });
    expect(
      parseChangeSetName(
        'cfnsync-abc123def456-0123456789abcdef-20261320T254501123',
      ),
    ).toEqual({ tool: true });
  });

  it('FR-2-6: newRunId は英数字のみで、呼び出しごとに異なる', () => {
    const a = newRunId();
    const b = newRunId();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(b).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    // 生成された runId を名前に埋め込んでも再パース可能であること。
    expect(
      parseChangeSetName(
        changeSetName({ stateId: STATE_ID, runId: a, now: FIXED_NOW }),
      ),
    ).toEqual({
      tool: true,
      stateId: STATE_ID,
      runId: a,
    });
  });
});

// ===========================================================================
// prepareStack: スタック状態ガード(FR-2-1 / FR-2-2 / FR-2-4 / FR-2-8)
// ===========================================================================

describe('prepareStack — スタック状態ガード', () => {
  it('FR-2-2: スタック不存在 → CREATE', async () => {
    const fake = new FakeCloudFormationGateway();
    const result = await prepareStack(makeCtx(fake), STACK);
    expect(result.kind).toBe('create');
    expect(result.reviewInProgress).toBe(false);
  });

  it('FR-2-1: 完了系(CREATE_COMPLETE)スタック → UPDATE', async () => {
    const fake = new FakeCloudFormationGateway();
    fake.stacks.set(
      STACK,
      makeStackSummary({ stackName: STACK, status: 'CREATE_COMPLETE' }),
    );
    const result = await prepareStack(makeCtx(fake), STACK);
    expect(result.kind).toBe('update');
    expect(result.stackStatus).toBe('CREATE_COMPLETE');
  });

  it('FR-2-1: UPDATE_COMPLETE / UPDATE_ROLLBACK_COMPLETE も UPDATE', async () => {
    for (const status of [
      'UPDATE_COMPLETE',
      'UPDATE_ROLLBACK_COMPLETE',
      'IMPORT_COMPLETE',
    ]) {
      const fake = new FakeCloudFormationGateway();
      fake.stacks.set(STACK, makeStackSummary({ stackName: STACK, status }));
      const result = await prepareStack(makeCtx(fake), STACK);
      expect(result.kind).toBe('update');
    }
  });

  it('FR-2-4: ROLLBACK_COMPLETE → StackStateError(スタック削除の必要性を含むメッセージ)', async () => {
    const fake = new FakeCloudFormationGateway();
    fake.stacks.set(
      STACK,
      makeStackSummary({ stackName: STACK, status: 'ROLLBACK_COMPLETE' }),
    );
    await expect(prepareStack(makeCtx(fake), STACK)).rejects.toBeInstanceOf(
      StackStateError,
    );
    await expect(prepareStack(makeCtx(fake), STACK)).rejects.toThrow(/削除/);
    // 変更セット作成には進まない。
    expect(fake.callsOf('createChangeSet')).toHaveLength(0);
  });

  it('FR-2-8: *_IN_PROGRESS → StackStateError(並行操作)。変更セットを作成しない', async () => {
    const fake = new FakeCloudFormationGateway();
    fake.stacks.set(
      STACK,
      makeStackSummary({ stackName: STACK, status: 'UPDATE_IN_PROGRESS' }),
    );
    await expect(prepareStack(makeCtx(fake), STACK)).rejects.toBeInstanceOf(
      StackStateError,
    );
    expect(fake.callsOf('createChangeSet')).toHaveLength(0);
    expect(fake.callsOf('deleteStack')).toHaveLength(0);
  });
});

// ===========================================================================
// FR-2-10: REVIEW_IN_PROGRESS — DeleteStack を一切呼ばない
// ===========================================================================

describe('prepareStack — REVIEW_IN_PROGRESS (FR-2-10)', () => {
  it('FR-2-10: 自ステートの変更セットのみ個別削除し CREATE 続行。DeleteStack を一切呼ばない', async () => {
    const fake = new FakeCloudFormationGateway();
    fake.stacks.set(
      STACK,
      makeStackSummary({ stackName: STACK, status: 'REVIEW_IN_PROGRESS' }),
    );
    const stale = ownChangeSetName('1111111111111111');
    fake.changeSets.set(STACK, [
      makeChangeSetSummary(stale, { status: 'CREATE_COMPLETE' }),
    ]);

    const result = await prepareStack(makeCtx(fake), STACK);

    expect(result.kind).toBe('create');
    expect(result.reviewInProgress).toBe(true);
    // 自変更セットは個別に破棄される。
    expect(fake.callsOf('deleteChangeSet').map((c) => c.args[1])).toEqual([
      makeChangeSetSummary(stale).id,
    ]);
    // **DeleteStack が一切呼ばれないことの明示的アサーション(FR-2-10 の中核)。**
    expect(fake.callsOf('deleteStack')).toHaveLength(0);
  });

  it('FR-2-10: 他主体の変更セットが存在 → fail-closed 停止。DeleteStack も CreateChangeSet も呼ばない', async () => {
    const fake = new FakeCloudFormationGateway();
    fake.stacks.set(
      STACK,
      makeStackSummary({ stackName: STACK, status: 'REVIEW_IN_PROGRESS' }),
    );
    fake.changeSets.set(STACK, [
      makeChangeSetSummary('human-created-changeset'),
    ]);

    await expect(prepareStack(makeCtx(fake), STACK)).rejects.toBeInstanceOf(
      StackStateError,
    );
    expect(fake.callsOf('deleteStack')).toHaveLength(0);
    expect(fake.callsOf('deleteChangeSet')).toHaveLength(0);
    expect(fake.callsOf('createChangeSet')).toHaveLength(0);
  });

  it('FR-2-10: 別ステート ID の cfnsync- 変更セットが存在 → 停止。DeleteStack を呼ばない', async () => {
    const fake = new FakeCloudFormationGateway();
    fake.stacks.set(
      STACK,
      makeStackSummary({ stackName: STACK, status: 'REVIEW_IN_PROGRESS' }),
    );
    fake.changeSets.set(STACK, [
      makeChangeSetSummary('cfnsync-otherstate99-runX-20260101T000000000'),
    ]);

    await expect(prepareStack(makeCtx(fake), STACK)).rejects.toBeInstanceOf(
      StackStateError,
    );
    expect(fake.callsOf('deleteStack')).toHaveLength(0);
    expect(fake.callsOf('deleteChangeSet')).toHaveLength(0);
  });
});

// ===========================================================================
// FR-2-7: 残存変更セットの所有権判定つき回収
// ===========================================================================

describe('reclaimStaleChangeSets (FR-2-7)', () => {
  it('FR-2-7: 自ステート ID の残存 → deleteChangeSet で回収して続行', async () => {
    const fake = new FakeCloudFormationGateway();
    const stale = ownChangeSetName('1111111111111111');
    fake.changeSets.set(STACK, [makeChangeSetSummary(stale)]);

    await expect(
      reclaimStaleChangeSets(makeCtx(fake), STACK),
    ).resolves.toBeUndefined();
    expect(fake.callsOf('deleteChangeSet').map((c) => c.args[1])).toEqual([
      makeChangeSetSummary(stale).id,
    ]);
  });

  it('FR-2-7: 別ステート ID の cfnsync- → 削除せず中断', async () => {
    const fake = new FakeCloudFormationGateway();
    fake.changeSets.set(STACK, [
      makeChangeSetSummary('cfnsync-otherstate99-runX-20260101T000000000'),
    ]);

    await expect(
      reclaimStaleChangeSets(makeCtx(fake), STACK),
    ).rejects.toBeInstanceOf(StackStateError);
    expect(fake.callsOf('deleteChangeSet')).toHaveLength(0);
  });

  it('FR-2-7: 非 cfnsync-(人手・他ツール)→ 削除せず中断', async () => {
    const fake = new FakeCloudFormationGateway();
    fake.changeSets.set(STACK, [
      makeChangeSetSummary('human-created-changeset'),
    ]);

    await expect(
      reclaimStaleChangeSets(makeCtx(fake), STACK),
    ).rejects.toBeInstanceOf(StackStateError);
    expect(fake.callsOf('deleteChangeSet')).toHaveLength(0);
  });

  it('FR-2-7: 命名から判定不能(cfnsync- だが形式不正)→ 中断', async () => {
    const fake = new FakeCloudFormationGateway();
    fake.changeSets.set(STACK, [makeChangeSetSummary('cfnsync-malformed')]);

    await expect(
      reclaimStaleChangeSets(makeCtx(fake), STACK),
    ).rejects.toBeInstanceOf(StackStateError);
    expect(fake.callsOf('deleteChangeSet')).toHaveLength(0);
  });

  it('FR-2-7: stateId が一致しても runId・UTC timestamp が厳密形式でなければ削除せず中断', async () => {
    for (const malformed of [
      `cfnsync-${STATE_ID}-x-20260720T134501123`,
      `cfnsync-${STATE_ID}-0123456789abcdef-not-a-timestamp`,
    ]) {
      const fake = new FakeCloudFormationGateway();
      fake.changeSets.set(STACK, [makeChangeSetSummary(malformed)]);
      await expect(
        reclaimStaleChangeSets(makeCtx(fake), STACK),
      ).rejects.toBeInstanceOf(StackStateError);
      expect(fake.callsOf('deleteChangeSet')).toHaveLength(0);
    }
  });

  it('FR-2-7: 他主体が 1 つでもあれば自ステートの変更セットも削除しない(fail-closed の順序)', async () => {
    const fake = new FakeCloudFormationGateway();
    const stale = ownChangeSetName('1111111111111111');
    fake.changeSets.set(STACK, [
      makeChangeSetSummary(stale),
      makeChangeSetSummary('human-created-changeset'),
    ]);

    await expect(
      reclaimStaleChangeSets(makeCtx(fake), STACK),
    ).rejects.toBeInstanceOf(StackStateError);
    // 他主体が存在する時点で、自変更セットにも触れずに中断する。
    expect(fake.callsOf('deleteChangeSet')).toHaveLength(0);
  });

  it('FR-2-7: 残存なし → 何も削除せず正常終了', async () => {
    const fake = new FakeCloudFormationGateway();
    await expect(
      reclaimStaleChangeSets(makeCtx(fake), STACK),
    ).resolves.toBeUndefined();
    expect(fake.callsOf('deleteChangeSet')).toHaveLength(0);
  });
});

// ===========================================================================
// createManagedChangeSet: 型 / Capability / 管理タグ / 空変更セット
// ===========================================================================

describe('createManagedChangeSet', () => {
  it('FR-2-2: kind create → ChangeSetType CREATE', async () => {
    const fake = new FakeCloudFormationGateway();
    await createManagedChangeSet(makeCtx(fake), {
      target: makeTarget(),
      templateBody: 'TEMPLATE',
      kind: 'create',
    });
    const input = fake.callsOf('createChangeSet')[0].args[0] as {
      changeSetType: string;
    };
    expect(input.changeSetType).toBe('CREATE');
  });

  it('FR-2-1: kind update → ChangeSetType UPDATE', async () => {
    const fake = new FakeCloudFormationGateway();
    await createManagedChangeSet(makeCtx(fake), {
      target: makeTarget(),
      templateBody: 'TEMPLATE',
      kind: 'update',
    });
    const input = fake.callsOf('createChangeSet')[0].args[0] as {
      changeSetType: string;
    };
    expect(input.changeSetType).toBe('UPDATE');
  });

  it('FR-2-5: 設定の capabilities が CreateChangeSet に渡る', async () => {
    const fake = new FakeCloudFormationGateway();
    await createManagedChangeSet(makeCtx(fake), {
      target: makeTarget({
        capabilities: ['CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
      }),
      templateBody: 'TEMPLATE',
      kind: 'update',
    });
    const input = fake.callsOf('createChangeSet')[0].args[0] as {
      capabilities: string[];
    };
    expect(input.capabilities).toEqual([
      'CAPABILITY_NAMED_IAM',
      'CAPABILITY_AUTO_EXPAND',
    ]);
  });

  it('FR-2-9: 管理タグ cfnsync:state-id=<stateId> が Tags にマージされ、ユーザータグと共存', async () => {
    const fake = new FakeCloudFormationGateway();
    await createManagedChangeSet(makeCtx(fake), {
      target: makeTarget({ tags: { Team: 'platform', Env: 'prod' } }),
      templateBody: 'TEMPLATE',
      kind: 'create',
    });
    const input = fake.callsOf('createChangeSet')[0].args[0] as {
      tags: Record<string, string>;
    };
    expect(input.tags).toEqual({
      Team: 'platform',
      Env: 'prod',
      [MANAGEMENT_TAG_KEY]: STATE_ID,
    });
  });

  it('FR-11-8/FR-2-9: config の defaultTags が resolveTargets を経由して変更セットの Tags まで届く', async () => {
    const config = validateConfig({
      version: 1,
      defaultRegion: 'ap-northeast-1',
      defaultTags: { ManagedBy: 'cfnsync' },
      stacks: {
        'network.yaml': {
          stackName: STACK,
          tags: { Team: 'platform' },
        },
      },
    });
    const [target] = resolveTargets(config);

    const fake = new FakeCloudFormationGateway();
    await createManagedChangeSet(makeCtx(fake), {
      target,
      templateBody: 'TEMPLATE',
      kind: 'create',
    });
    const input = fake.callsOf('createChangeSet')[0].args[0] as {
      tags: Record<string, string>;
    };
    // defaultTags(ManagedBy)+ スタック固有 tags(Team)+ 管理タグが共存する。
    expect(input.tags).toEqual({
      ManagedBy: 'cfnsync',
      Team: 'platform',
      [MANAGEMENT_TAG_KEY]: STATE_ID,
    });
  });

  it('FR-2-6: CreateChangeSet の名前は命名規則に従う', async () => {
    const fake = new FakeCloudFormationGateway();
    const { name } = await createManagedChangeSet(makeCtx(fake), {
      target: makeTarget(),
      templateBody: 'TEMPLATE',
      kind: 'create',
    });
    expect(name).toBe(
      'cfnsync-abc123def456-0123456789abcdef-20260720T134501123',
    );
    const input = fake.callsOf('createChangeSet')[0].args[0] as {
      changeSetName: string;
    };
    expect(input.changeSetName).toBe(name);
  });

  it('internal: createManagedChangeSet 成功(CREATE_COMPLETE)→ noChanges false・detail を返す', async () => {
    const fake = new FakeCloudFormationGateway();
    fake.defaultChangeSetDetail = makeChangeSetDetail({
      status: 'CREATE_COMPLETE',
    });
    const result = await createManagedChangeSet(makeCtx(fake), {
      target: makeTarget(),
      templateBody: 'TEMPLATE',
      kind: 'update',
    });
    expect(result.noChanges).toBe(false);
    expect(result.detail.status).toBe('CREATE_COMPLETE');
    expect(fake.callsOf('deleteChangeSet')).toHaveLength(0);
  });

  it('FR-5-12c: onCreated は CreateChangeSet 成功直後(待機より前)に name/ARN/stackId を通知する', async () => {
    const fake = new FakeCloudFormationGateway();
    fake.stacks.set(
      STACK,
      makeStackSummary({
        stackName: STACK,
        stackId: 'arn:aws:cloudformation:stack/my-network/live',
        status: 'UPDATE_COMPLETE',
      }),
    );
    const notified: Array<{ ref: CreatedChangeSetRef; seen: string[] }> = [];

    const result = await createManagedChangeSet(makeCtx(fake), {
      target: makeTarget(),
      templateBody: 'TEMPLATE',
      kind: 'update',
      onCreated: (ref) => notified.push({ ref, seen: fake.methodSequence() }),
    });

    expect(notified).toHaveLength(1);
    expect(notified[0].ref).toEqual({
      name: result.name,
      id: result.id,
      stackId: 'arn:aws:cloudformation:stack/my-network/live',
    });
    // 通知時点で待機はまだ始まっていない = 待機以降のどの失敗でも回収対象に載っている。
    expect(notified[0].seen).toEqual(['createChangeSet']);
  });

  it('FR-5-12c: 待機例外・name/ARN 不一致・非空 FAILED のどれで中断しても作成済み ARN を通知済みにする', async () => {
    const injections: Array<{
      label: string;
      inject: (fake: FakeCloudFormationGateway) => void;
    }> = [
      {
        label: '待機例外',
        inject: (fake) => {
          fake.waitForChangeSet = async () => {
            throw new Error('CloudFormation DescribeChangeSet に失敗しました');
          };
        },
      },
      {
        label: 'name/ARN 不一致',
        inject: (fake) => {
          fake.waitForChangeSet = async () =>
            makeChangeSetDetail({
              name: 'cfnsync-replaced-change-set',
              id: 'arn:aws:cloudformation:changeSet/replaced',
            });
        },
      },
      {
        label: '非空 FAILED',
        inject: (fake) => {
          fake.defaultChangeSetDetail = makeChangeSetDetail({
            status: 'FAILED',
            statusReason:
              'Template format error: Unresolved resource dependencies [Foo].',
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
        },
      },
    ];

    for (const { label, inject } of injections) {
      const fake = new FakeCloudFormationGateway();
      inject(fake);
      const notified: CreatedChangeSetRef[] = [];

      await expect(
        createManagedChangeSet(makeCtx(fake), {
          target: makeTarget(),
          templateBody: 'TEMPLATE',
          kind: 'update',
          onCreated: (ref) => notified.push(ref),
        }),
        label,
      ).rejects.toThrow();

      // 変更セットは AWS 上に作成済みなので、呼び出し側が回収できなければならない(FR-5-12c)。
      expect(notified, label).toHaveLength(1);
      expect(notified[0].id, label).toBe(
        `arn:aws:cloudformation:changeSet/${
          (
            fake.callsOf('createChangeSet')[0].args[0] as {
              changeSetName: string;
            }
          ).changeSetName
        }`,
      );
      // 回収そのものは呼び出し側の責務(この関数は削除しない)。
      expect(fake.callsOf('deleteChangeSet'), label).toHaveLength(0);
    }
  });

  it("FR-2-3: 空変更セット(didn't contain changes)→ 変更なし・変更セット削除・エラーにしない", async () => {
    const fake = new FakeCloudFormationGateway();
    fake.defaultChangeSetDetail = makeChangeSetDetail({
      status: 'FAILED',
      statusReason:
        "The submitted information didn't contain changes. Submit different information to create a change set.",
    });
    const result = await createManagedChangeSet(makeCtx(fake), {
      target: makeTarget(),
      templateBody: 'TEMPLATE',
      kind: 'update',
    });
    expect(result.noChanges).toBe(true);
    expect(fake.callsOf('deleteChangeSet')).toHaveLength(1);
  });

  it('FR-2-3: 空変更セット(No updates are to be performed)→ 変更なし', async () => {
    const fake = new FakeCloudFormationGateway();
    fake.defaultChangeSetDetail = makeChangeSetDetail({
      status: 'FAILED',
      statusReason: 'No updates are to be performed.',
    });
    const result = await createManagedChangeSet(makeCtx(fake), {
      target: makeTarget(),
      templateBody: 'TEMPLATE',
      kind: 'update',
    });
    expect(result.noChanges).toBe(true);
    expect(fake.callsOf('deleteChangeSet')).toHaveLength(1);
  });

  it('FR-2-3(再レビュー⑥): 既知文面を trim 後の完全一致だけ許可し suffix 付きは失敗にする', async () => {
    const accepted = new FakeCloudFormationGateway();
    accepted.defaultChangeSetDetail = makeChangeSetDetail({
      status: 'FAILED',
      statusReason: '  No updates are to be performed.\n',
    });
    await expect(
      createManagedChangeSet(makeCtx(accepted), {
        target: makeTarget(),
        templateBody: 'TEMPLATE',
        kind: 'update',
      }),
    ).resolves.toMatchObject({ noChanges: true });

    const suffixed = new FakeCloudFormationGateway();
    suffixed.defaultChangeSetDetail = makeChangeSetDetail({
      status: 'FAILED',
      statusReason: 'No updates are to be performed. Access denied afterwards',
      changes: [],
    });
    await expect(
      createManagedChangeSet(makeCtx(suffixed), {
        target: makeTarget(),
        templateBody: 'TEMPLATE',
        kind: 'update',
      }),
    ).rejects.toBeInstanceOf(StackStateError);
    expect(suffixed.callsOf('deleteChangeSet')).toHaveLength(0);
  });

  it('FR-2(ARN再レビュー⑥): CreateChangeSet の戻り ARN を待機・削除へ固定する', async () => {
    const fake = new FakeCloudFormationGateway();
    fake.defaultChangeSetDetail = makeChangeSetDetail({
      status: 'FAILED',
      statusReason: 'No updates are to be performed.',
    });
    const result = await createManagedChangeSet(makeCtx(fake), {
      target: makeTarget(),
      templateBody: 'TEMPLATE',
      kind: 'update',
    });

    expect(result.id).toMatch(/^arn:/);
    expect(fake.callsOf('waitForChangeSet')[0].args[1]).toBe(result.id);
    expect(fake.callsOf('deleteChangeSet')[0].args[1]).toBe(result.id);
  });

  it('FR-2-3: 「変更なし」以外の FAILED → StackStateError(変更セットは削除しない)', async () => {
    const fake = new FakeCloudFormationGateway();
    fake.defaultChangeSetDetail = makeChangeSetDetail({
      status: 'FAILED',
      statusReason:
        'Template format error: Unresolved resource dependencies [Foo].',
    });
    await expect(
      createManagedChangeSet(makeCtx(fake), {
        target: makeTarget(),
        templateBody: 'TEMPLATE',
        kind: 'update',
      }),
    ).rejects.toBeInstanceOf(StackStateError);
    expect(fake.callsOf('deleteChangeSet')).toHaveLength(0);
  });

  it("FR-2-3: Macro エラー中の didn't contain changes + changes 非空は空変更扱いしない", async () => {
    const fake = new FakeCloudFormationGateway();
    fake.defaultChangeSetDetail = makeChangeSetDetail({
      status: 'FAILED',
      statusReason:
        "Transform ExampleMacro failed: The submitted information didn't contain changes. Submit different information to create a change set.",
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

    await expect(
      createManagedChangeSet(makeCtx(fake), {
        target: makeTarget(),
        templateBody: 'TEMPLATE',
        kind: 'update',
      }),
    ).rejects.toBeInstanceOf(StackStateError);
    expect(fake.callsOf('deleteChangeSet')).toHaveLength(0);
  });

  it('NFR-4: 変更セット StatusReason は StackStateError へコピーする前に redactor を通す', async () => {
    const secret = 'executor-secret-value';
    const fake = new FakeCloudFormationGateway();
    fake.defaultChangeSetDetail = makeChangeSetDetail({
      status: 'FAILED',
      statusReason: `AWS rejected ${secret}`,
    });

    try {
      await createManagedChangeSet(
        makeCtx(fake, {
          redact: (text) => text.replaceAll(secret, '****'),
        }),
        {
          target: makeTarget(),
          templateBody: 'TEMPLATE',
          kind: 'update',
        },
      );
      expect.unreachable('StackStateError が送出されるはず');
    } catch (error) {
      expect(error).toBeInstanceOf(StackStateError);
      expect((error as Error).message).toContain('****');
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

// ===========================================================================
// FR-2-11: 実行直前の再検査(Codex 承認条件)
// ===========================================================================

describe('executeWithReinspection (FR-2-11)', () => {
  it('FR-2-11: 再検査(listChangeSets)が ExecuteChangeSet の直前に配置される', async () => {
    const fake = new FakeCloudFormationGateway();
    const own = ownChangeSetName(RUN_ID);
    // 自変更セットのみが残存(正常系)。
    fake.changeSets.set(STACK, [makeChangeSetSummary(own)]);

    const ownId = fake.changeSets.get(STACK)![0].id;
    await executeWithReinspection(makeCtx(fake), STACK, own, ownId);

    // 呼び出しは「listChangeSets → executeChangeSet」の 2 つのみで、隣接している。
    expect(fake.methodSequence()).toEqual([
      'listChangeSets',
      'executeChangeSet',
    ]);
    const execIdx = fake.calls.findIndex(
      (c) => c.method === 'executeChangeSet',
    );
    expect(execIdx).toBeGreaterThan(0);
    expect(fake.calls[execIdx - 1].method).toBe('listChangeSets');
    expect(fake.callsOf('executeChangeSet')[0].args).toEqual([STACK, ownId]);
  });

  it('FR-2-11: 再検査で他主体の変更セットを検出 → ExecuteChangeSet を呼ばず停止', async () => {
    const fake = new FakeCloudFormationGateway();
    const own = ownChangeSetName(RUN_ID);
    fake.changeSets.set(STACK, [
      makeChangeSetSummary(own),
      makeChangeSetSummary('human-injected-changeset'),
    ]);

    await expect(
      executeWithReinspection(
        makeCtx(fake),
        STACK,
        own,
        fake.changeSets.get(STACK)![0].id,
      ),
    ).rejects.toBeInstanceOf(StackStateError);
    // 暗黙削除を発生させないため、ExecuteChangeSet は呼ばれない。
    expect(fake.callsOf('executeChangeSet')).toHaveLength(0);
    expect(fake.callsOf('listChangeSets')).toHaveLength(1);
  });

  it('FR-2-11: 別ステート ID の変更セットも「自変更セット以外」として実行を止める', async () => {
    const fake = new FakeCloudFormationGateway();
    const own = ownChangeSetName(RUN_ID);
    fake.changeSets.set(STACK, [
      makeChangeSetSummary(own),
      makeChangeSetSummary('cfnsync-otherstate99-runX-20260101T000000000'),
    ]);

    await expect(
      executeWithReinspection(
        makeCtx(fake),
        STACK,
        own,
        fake.changeSets.get(STACK)![0].id,
      ),
    ).rejects.toBeInstanceOf(StackStateError);
    expect(fake.callsOf('executeChangeSet')).toHaveLength(0);
  });

  it('FR-2-11(横断準備): 再検査の直前に注入された他主体の変更セットも検出できる', async () => {
    // フェイクの onListChangeSets フックで、再検査呼び出しの直前に並行追加を注入する。
    const fake = new FakeCloudFormationGateway();
    const own = ownChangeSetName(RUN_ID);
    fake.changeSets.set(STACK, [makeChangeSetSummary(own)]);
    fake.onListChangeSets = () => {
      fake.changeSets.set(STACK, [
        makeChangeSetSummary(own),
        makeChangeSetSummary('late-injected-changeset'),
      ]);
    };

    await expect(
      executeWithReinspection(
        makeCtx(fake),
        STACK,
        own,
        fake.changeSets.get(STACK)![0].id,
      ),
    ).rejects.toBeInstanceOf(StackStateError);
    expect(fake.callsOf('executeChangeSet')).toHaveLength(0);
  });

  it('FR-2-11(ARN再レビュー⑥): 同名でも ARN が差し替わっていれば実行を拒否する', async () => {
    const fake = new FakeCloudFormationGateway();
    const own = ownChangeSetName(RUN_ID);
    const createdArn = `arn:aws:cloudformation:changeSet/${own}/created`;
    fake.changeSets.set(STACK, [
      makeChangeSetSummary(own, {
        id: `arn:aws:cloudformation:changeSet/${own}/attacker`,
      }),
    ]);

    await expect(
      executeWithReinspection(makeCtx(fake), STACK, own, createdArn),
    ).rejects.toBeInstanceOf(StackStateError);
    expect(fake.callsOf('executeChangeSet')).toHaveLength(0);
  });
});
