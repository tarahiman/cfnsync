import type { ResolvedStackTarget } from '../../core/config.js';
import { InvariantError, StackStateError } from '../../core/errors.js';
import type { PlannedOperation } from '../../core/plan.js';
import type { StackEntry } from '../../core/state.js';
import type { CloudFormationGateway } from '../../ports/index.js';
import {
  buildStackDiff,
  type DeployReport,
  type ReconciliationRecord,
  type StackEventLine,
  type StackResult,
} from '../../report/index.js';
import {
  createManagedChangeSet,
  type ExecutorContext,
  executeWithReinspection,
  prepareStack,
  reclaimStaleChangeSets,
} from '../executor.js';
import { fencedGateway } from '../fencing.js';
import { identityRedactor } from '../redactor.js';
import { requiredTemplate } from './planning.js';
import { recoverExistingCreate } from './recovery.js';
import { emitProgress, publicErrorMessage, stackResult } from './results.js';
import { saveSuccessfulEntry } from './statePersistence.js';
import {
  type CreatedChangeSet,
  type LockedRunContext,
  type OperationResult,
  type PendingChangeSetExecution,
  type PhaseAResult,
  type PreparedPlan,
  StackExecutionFailure,
  UPDATE_EXECUTABLE_STATUSES,
} from './types.js';

export async function planCreateOrUpdate(
  ctx: LockedRunContext,
  operation: PlannedOperation,
  prepared: PreparedPlan,
  report: DeployReport,
  resultByOperation: Map<PlannedOperation, StackResult>,
  reconciliations: ReconciliationRecord[],
  createdChangeSets: Set<CreatedChangeSet>,
): Promise<PhaseAResult> {
  const target = operation.entry.target;
  if (!target)
    throw new InvariantError(
      `Internal error: no target for ${operation.stackKey}`,
      { stackKey: operation.stackKey, region: operation.region },
    );
  const source = requiredTemplate(ctx.templates, target.templatePath);
  const analysis = prepared.analyses.get(operation.stackKey);
  if (!analysis)
    throw new InvariantError(
      `Internal error: no template analysis result for ${operation.stackKey}`,
      { stackKey: operation.stackKey, region: operation.region },
    );
  const redact = prepared.redactors.get(operation.stackKey) ?? identityRedactor;

  const rawCfn = ctx.deps.cfnFactory(operation.region);
  const cfn = fencedGateway(rawCfn, ctx.deps.backend, ctx.lock);
  let knownSummary:
    | { summary: Awaited<ReturnType<CloudFormationGateway['describeStack']>> }
    | undefined;

  // design §7: added だが完成済みの同名スタックがある場合は CREATE 復旧比較へ分岐。
  if (operation.kind === 'create') {
    const existing = await cfn.describeStack(target.stackName);
    knownSummary = { summary: existing };
    if (existing && existing.status !== 'REVIEW_IN_PROGRESS') {
      if (existing.status === 'ROLLBACK_COMPLETE') {
        throw new StackStateError(
          `Stack '${target.stackName}' is in ROLLBACK_COMPLETE state. Delete it and re-run`,
          { stackKey: target.stackKey, region: target.region },
        );
      }
      if (existing.status.endsWith('_IN_PROGRESS')) {
        throw new StackStateError(
          `Stack '${target.stackName}' is in ${existing.status} state. Re-run after the in-progress operation completes`,
          { stackKey: target.stackKey, region: target.region },
        );
      }
      await recoverExistingCreate(
        ctx,
        target,
        source,
        prepared.parsedTemplates.get(target.templatePath),
        analysis,
        operation.entry.templateHash,
        operation.entry.inputsHash,
        operation.entry.renamedFrom,
        existing,
        cfn,
        report,
        reconciliations,
      );
      resultByOperation.set(operation, stackResult(target, 'no-change'));
      return { hasDiff: false };
    }
  }

  const executor: ExecutorContext = {
    cfn,
    target: { stackKey: target.stackKey, region: target.region },
    stateId: ctx.deps.backend.stateId(),
    runId: ctx.runId,
    now: ctx.deps.now,
    redact,
  };
  const stack = await prepareStack(executor, target.stackName, knownSummary);
  if (stack.kind === 'update') {
    await requireManagedStackIdentity(cfn, target, operation.entry.stateEntry);
  }
  // REVIEW_IN_PROGRESS は prepareStack 内で回収済み。
  // スタックが実在しない(真の新規 CREATE)場合、ListChangeSets 自体が CloudFormation の
  // 実エラー("Stack ... does not exist")を返すため呼んではならない。stack.stackStatus は
  // DescribeStacks が結果を返した(＝スタックが実在する)場合のみ設定される。
  // 実在し REVIEW_IN_PROGRESS でもない通常パス(update)のみ明示回収する。
  if (stack.stackStatus !== undefined && !stack.reviewInProgress)
    await reclaimStaleChangeSets(executor, target.stackName);

  // UPDATE の副作用(CreateChangeSet)直前にも再取得し、同名差し替えを fail-closed にする。
  if (stack.kind === 'update') {
    await requireManagedStackIdentity(cfn, target, operation.entry.stateEntry);
  }

  emitProgress(
    ctx.deps,
    { stackKey: operation.stackKey, region: operation.region },
    'changeset-create-start',
    'Creating change set',
  );
  // FR-5-12c: CreateChangeSet が ARN を返した直後に回収対象へ登録する。以降の待機例外・
  // name/ARN 不一致・非空 FAILED はいずれも「AWS 上に変更セットが実在する」状態で throw
  // されるため、成功復帰を待って登録すると回収漏れになる。
  let createdChangeSet: CreatedChangeSet | undefined;
  const created = await createManagedChangeSet(executor, {
    target,
    templateBody: source,
    kind: stack.kind,
    onCreated: (ref) => {
      createdChangeSet = {
        operation,
        cfn,
        stackName: target.stackName,
        name: ref.name,
        id: ref.id,
      };
      createdChangeSets.add(createdChangeSet);
    },
  });
  // 作成済みの変更セットは以後 createdChangeSet 経由でのみ追跡する(登録漏れを型で防ぐ)。
  if (createdChangeSet === undefined) {
    throw new InvariantError(
      `Internal error: failed to track the created change set for ${operation.stackKey}`,
      { stackKey: operation.stackKey, region: operation.region },
    );
  }
  const changeSet: CreatedChangeSet = createdChangeSet;

  if (created.noChanges) {
    // 空変更セットは createManagedChangeSet が削除済み(FR-2-3)。回収対象から外す。
    createdChangeSets.delete(changeSet);
    const diff = buildStackDiff({
      stackKey: operation.stackKey,
      region: operation.region,
      stackName: target.stackName,
      operation: 'no-change',
      noEchoParams: analysis.noEchoParams,
    });
    diff.warnings.push(...analysis.warnings);
    report.diffs.push(diff);
    resultByOperation.set(operation, stackResult(target, 'no-change'));
    emitProgress(
      ctx.deps,
      { stackKey: operation.stackKey, region: operation.region },
      'no-change',
      'Treating as no changes because the change set is empty',
    );
    const stackId =
      stack.kind === 'update'
        ? (
            await requireManagedStackIdentity(
              cfn,
              target,
              operation.entry.stateEntry,
            )
          ).stackId
        : await requireExistingStackId(cfn, target);
    // FR-5-5b1: CloudFormation 自身が実パラメータ(NoEcho 含む)で比較した結果であり、
    // 既成事実の記録として承認前に保存してよい。
    await saveSuccessfulEntry(
      ctx,
      operation.entry,
      analysis,
      stack.kind === 'create' ? 'CREATE' : 'UPDATE',
      stackId,
    );
    reconciliations.push({
      stackKey: operation.stackKey,
      region: operation.region,
      kind: 'empty-change-set',
      stateUpdated: true,
    });
    return { hasDiff: false };
  }

  const diff = buildStackDiff({
    stackKey: operation.stackKey,
    region: operation.region,
    stackName: target.stackName,
    operation: stack.kind,
    detail: created.detail,
    noEchoParams: analysis.noEchoParams,
    redact,
  });
  diff.warnings.push(...analysis.warnings);
  report.diffs.push(diff);
  emitProgress(
    ctx.deps,
    { stackKey: operation.stackKey, region: operation.region },
    'diff-ready',
    `Diff finalized (${diff.resources.length} resource(s))`,
  );

  if (ctx.options.dryRun) {
    // FR-5-20c: plan は describe 直後に自身の変更セットを削除し、保持経路を用いない。
    await cfn.deleteChangeSet(target.stackName, created.id);
    createdChangeSets.delete(changeSet);
    resultByOperation.set(operation, stackResult(target, 'skipped'));
    return { hasDiff: true };
  }

  // FR-5-17b / FR-5-17c2: 承認待ちを挟んだ実行直前に照合する対象スタックの不変 ARN を
  // ここで確定させる。update は state の記録(requireManagedStackIdentity が実スタックとの
  // 一致を確認済み)、create は CreateChangeSet が作った REVIEW_IN_PROGRESS の殻の ARN。
  // 殻の ARN を確定できなければ「自身の変更セットに対応する殻」を照合できないため
  // fail-closed に中断する(作成済みの変更セットは Phase A の後始末で回収される)。
  const expectedStackId =
    stack.kind === 'update'
      ? operation.entry.stateEntry?.stackId
      : (created.stackId ??
        (await cfn.describeStack(target.stackName))?.stackId);
  if (!expectedStackId) {
    throw new StackStateError(
      `Cannot determine the stackId (ARN) of stack '${target.stackName}', ` +
        `so the target stack's identity cannot be re-verified immediately before execution after approval. Aborting without executing`,
      { stackKey: operation.stackKey, region: operation.region },
    );
  }

  return {
    hasDiff: true,
    pending: {
      kind: 'execute',
      operation,
      target,
      entry: operation.entry,
      analysis,
      cfn,
      executor,
      changeSetKind: stack.kind,
      changeSet,
      expectedStackId,
    },
  };
}

/**
 * FR-5-17b / FR-5-17c: 承認待ちの間に対象スタックが差し替えられていないか、実行不能な状態へ
 * 遷移していないかを `ExecuteChangeSet` の前に確認する(FR-5-17e 手順 1)。
 * `stackId`(ARN)の照合と状態の確認をこの 1 回の `DescribeStacks` に集約する —
 * FR-5-17e は手順 (2) `ListChangeSets` と (3) fencing の間に別の AWS 呼び出しを挟むことを
 * 許さないため、UPDATE の ARN 再照合を実行直前へ二重に置くことはできない。
 * `*_IN_PROGRESS` の否定だけでは `ROLLBACK_COMPLETE` 等を通してしまうため allowlist で判定する。
 */
async function assertExecutableStackState(
  action: PendingChangeSetExecution,
): Promise<void> {
  const { target, cfn, operation } = action;
  const summary = await cfn.describeStack(target.stackName);
  const context = { stackKey: operation.stackKey, region: operation.region };

  if (action.changeSetKind === 'update') {
    // FR-5-17b: 不変 ARN の再照合。expectedStackId 未確定のまま通過させない(fail-closed)。
    if (!summary || summary.stackId !== action.expectedStackId) {
      throw new StackStateError(
        `The stackId (ARN) of stack '${target.stackName}' no longer matches the value from before approval. ` +
          `A stack with the same name may have been replaced, so aborting execution. Run cfnsync import`,
        context,
      );
    }
    // FR-5-17c1: 実行可能な終端状態の allowlist。
    if (!UPDATE_EXECUTABLE_STATUSES.has(summary.status)) {
      throw new StackStateError(
        `Stack '${target.stackName}' transitioned to ${summary.status} after approval. ` +
          `Aborting execution because it is not in an executable state (${[...UPDATE_EXECUTABLE_STATUSES].join(' / ')})`,
        context,
      );
    }
    return;
  }

  // FR-5-17c2: CREATE は「未作成」または「**自身の変更セットに対応する** REVIEW_IN_PROGRESS の殻」。
  // スタックが実在するなら、状態が殻であることに加えて ARN が Phase A で作成した殻と完全一致
  // することまで確認する。同名の別スタックへ差し替えられた場合はここで fail-closed に止める。
  if (summary === undefined) {
    // 殻ごと消えている場合、自変更セットも道連れに消えているため、続く FR-5-17e 手順 2 の
    // ListChangeSets(スタック不存在ならエラー、存在しても自変更セットなし)が実行を止める。
    return;
  }
  if (summary.status !== 'REVIEW_IN_PROGRESS') {
    throw new StackStateError(
      `Stack '${target.stackName}' exists with status ${summary.status} after approval. ` +
        `Aborting execution because it is not in the expected state for a CREATE target (not-yet-created or REVIEW_IN_PROGRESS)`,
      context,
    );
  }
  if (summary.stackId !== action.expectedStackId) {
    throw new StackStateError(
      `The REVIEW_IN_PROGRESS shell of stack '${target.stackName}' is not the shell on which its own ` +
        `change set was created before approval (stackId mismatch). A stack with the same name may have ` +
        `been replaced, so aborting execution. Run cfnsync import`,
      context,
    );
  }
}

/**
 * Phase B(承認後): Phase A が保持した変更セットを実行し、完了まで待機してステートを保存する。
 * 副作用の直前に FR-5-17e の順序で再検査する:
 * (1) DescribeStacks による存在・stackId・状態の確認 → (2) ListChangeSets 全ページによる
 * 自変更セットの一意性確認 → (3) fencing(fencedGateway) → (4) ExecuteChangeSet。
 */
export async function executeApprovedChangeSet(
  ctx: LockedRunContext,
  action: PendingChangeSetExecution,
  report: DeployReport,
  resultByOperation: Map<PlannedOperation, StackResult>,
  createdChangeSets: Set<CreatedChangeSet>,
): Promise<OperationResult> {
  const { operation, target, cfn, executor, analysis } = action;
  const redact = executor.redact ?? identityRedactor;

  // ExecuteChangeSet 前の最新イベントを境界にし、長期運用スタックの過去履歴を待機へ持ち込まない。
  // FR-5-17e の再検査 (1)〜(4) は連続していなければならないため、その**前**に取得する。
  const eventCursor = await cfn.getStackEventCursor(target.stackName);
  let latestFailure: StackEventLine | undefined;
  let rollbackObserved = false;

  // FR-5-17e 手順 1: DescribeStacks による存在・stackId・状態の確認。
  await assertExecutableStackState(action);

  emitProgress(
    ctx.deps,
    { stackKey: operation.stackKey, region: operation.region },
    'execute-start',
    'Executing change set',
  );
  // FR-5-17e 手順 2〜4: ListChangeSets 再検査 → fencing(fencedGateway の verifyLock)
  // → ExecuteChangeSet。この 3 つの間に AWS 呼び出しを挟んではならない。
  await executeWithReinspection(
    executor,
    target.stackName,
    action.changeSet.name,
    action.changeSet.id,
    () => {
      // ここから先は ExecuteChangeSet を送信済みかどうかが確定しない(タイムアウト・
      // 接続断でも AWS 側で受理されうる)。送信済みかもしれない変更セットを後始末で
      // 削除しないよう、この時点で回収対象から外す(design §5.3)。
      createdChangeSets.delete(action.changeSet);
    },
  );
  let final: Awaited<ReturnType<CloudFormationGateway['waitForStack']>>;
  try {
    final = await cfn.waitForStack(target.stackName, {
      eventCursor,
      onEvent: (event) => {
        if (isRollbackStatus(event.resourceStatus)) rollbackObserved = true;
        const line: StackEventLine = {
          stackKey: operation.stackKey,
          region: operation.region,
          timestamp: event.timestamp,
          logicalResourceId: event.logicalResourceId,
          resourceType: event.resourceType,
          resourceStatus: event.resourceStatus,
          resourceStatusReason:
            event.resourceStatusReason === undefined
              ? undefined
              : redact(event.resourceStatusReason),
        };
        if (event.resourceStatus.endsWith('_FAILED')) latestFailure = line;
        report.events?.push(line);
        ctx.deps.onEvent?.(line);
      },
    });
  } catch (cause) {
    throw new StackExecutionFailure(
      redact(
        publicErrorMessage(
          cause,
          'Failed while waiting for the CloudFormation stack to complete',
        ),
      ),
      rollbackObserved,
      {
        stackKey: operation.stackKey,
        region: operation.region,
        cause,
      },
    );
  }

  if (!isSuccessfulTerminal(final.status)) {
    const cause = latestFailure;
    const reason =
      cause?.resourceStatusReason ??
      (final.statusReason === undefined
        ? final.status
        : redact(final.statusReason));
    const resource = cause ? `${cause.logicalResourceId}: ` : '';
    throw new StackExecutionFailure(
      `${resource}${reason} (final status: ${final.status})`,
      rollbackObserved || isRollbackStatus(final.status),
      {
        stackKey: operation.stackKey,
        region: operation.region,
      },
    );
  }

  if (!final.stackId) {
    throw new StackStateError(
      `The success result for stack '${target.stackName}' has no stackId (ARN). Not updating state; requesting import/migration`,
      { stackKey: target.stackKey, region: target.region },
    );
  }
  if (
    action.changeSetKind === 'update' &&
    action.entry.stateEntry?.stackId !== final.stackId
  ) {
    throw new StackStateError(
      `The stackId (ARN) of stack '${target.stackName}' changed during UPDATE. Not updating state; recommending cfnsync import`,
      { stackKey: target.stackKey, region: target.region },
    );
  }

  // FR-1-9: waitForStack 完了後、CAS 保存直前に saveSuccessfulEntry が再 fencing する。
  await saveSuccessfulEntry(
    ctx,
    action.entry,
    analysis,
    action.changeSetKind === 'create' ? 'CREATE' : 'UPDATE',
    final.stackId,
  );
  resultByOperation.set(operation, stackResult(target, 'succeeded'));
  emitProgress(
    ctx.deps,
    { stackKey: operation.stackKey, region: operation.region },
    'done',
    'Deployment completed',
  );
  return { hasDiff: true };
}

/**
 * Phase A(承認前)の削除計画。`DescribeStacks` で実在を確認し、削除プレビューを差分へ積む。
 * 実スタックが既に存在しない場合の再同期(FR-5-5b2)だけは承認前に保存してよい。
 * `DeleteStack` は行わず `PendingAction` として返す。
 */
async function requireManagedStackIdentity(
  cfn: CloudFormationGateway,
  target: ResolvedStackTarget,
  stateEntry: StackEntry | undefined,
): Promise<
  NonNullable<Awaited<ReturnType<CloudFormationGateway['describeStack']>>>
> {
  if (!stateEntry?.stackId) {
    throw new StackStateError(
      `The state for stack '${target.stackName}' has no recorded stackId (ARN). Refusing automatic UPDATE. Run cfnsync import or a state migration`,
      { stackKey: target.stackKey, region: target.region },
    );
  }
  const summary = await cfn.describeStack(target.stackName);
  if (!summary || summary.stackId !== stateEntry.stackId) {
    throw new StackStateError(
      `The stackId (ARN) of stack '${target.stackName}' does not match the state. A stack with the same name may have been replaced, so refusing automatic UPDATE. Run cfnsync import`,
      { stackKey: target.stackKey, region: target.region },
    );
  }
  return summary;
}

async function requireExistingStackId(
  cfn: CloudFormationGateway,
  target: ResolvedStackTarget,
): Promise<string> {
  const summary = await cfn.describeStack(target.stackName);
  if (!summary?.stackId) {
    throw new StackStateError(
      `Cannot confirm the stackId (ARN) of stack '${target.stackName}'. Not saving success state; recommending cfnsync import`,
      { stackKey: target.stackKey, region: target.region },
    );
  }
  return summary.stackId;
}

function isSuccessfulTerminal(status: string): boolean {
  return (
    status === 'CREATE_COMPLETE' ||
    status === 'UPDATE_COMPLETE' ||
    status === 'IMPORT_COMPLETE'
  );
}

const ROLLBACK_STATUSES = new Set([
  'ROLLBACK_IN_PROGRESS',
  'ROLLBACK_COMPLETE',
  'ROLLBACK_FAILED',
  'UPDATE_ROLLBACK_IN_PROGRESS',
  'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS',
  'UPDATE_ROLLBACK_COMPLETE',
  'UPDATE_ROLLBACK_FAILED',
  'IMPORT_ROLLBACK_IN_PROGRESS',
  'IMPORT_ROLLBACK_COMPLETE',
  'IMPORT_ROLLBACK_FAILED',
]);

function isRollbackStatus(status: string): boolean {
  return ROLLBACK_STATUSES.has(status);
}
