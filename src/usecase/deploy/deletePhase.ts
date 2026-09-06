import type { DetectedEntry } from '../../core/detect.js';
import { InvariantError } from '../../core/errors.js';
import type { PlannedOperation } from '../../core/plan.js';
import {
  type DeletableStackRecord,
  pendingDeletionId,
  removePendingDeletion,
  removeStackEntry,
} from '../../core/state.js';
import {
  buildStackDiff,
  type DeployReport,
  type ReconciliationRecord,
  type StackResult,
} from '../../report/index.js';
import { deleteManagedStack } from '../delete.js';
import { emitProgress, resultForOperation } from './results.js';
import { saveState } from './statePersistence.js';
import type {
  LockedRunContext,
  OperationResult,
  PendingStackDeletion,
  PhaseAResult,
  PreparedPlan,
} from './types.js';

export function deletableRecord(
  entry: DetectedEntry,
): DeletableStackRecord | undefined {
  return entry.stateEntry ?? entry.pendingDeletion?.entry;
}

export async function planDeletion(
  ctx: LockedRunContext,
  operation: PlannedOperation,
  prepared: PreparedPlan,
  report: DeployReport,
  resultByOperation: Map<PlannedOperation, StackResult>,
  reconciliations: ReconciliationRecord[],
): Promise<PhaseAResult> {
  const record = deletableRecord(operation.entry);
  if (!record)
    throw new InvariantError(
      `Internal error: no deletion record for ${operation.stackKey}`,
      { stackKey: operation.stackKey, region: operation.region },
    );

  // 同一物理スタックを指す削除と作成/更新の衝突は findPhysicalStackConflicts が
  // AWS 副作用前に fail-closed で止めるため、ここには到達しない(FR-11-10b / FR-6-10)。
  const rename = operation.entry.renamedTo;
  const detectedPending = operation.entry.pendingDeletion;
  // FR-1-20 / FR-6-7: 削除成功時に除去する削除待ちの ID。リネーム対の旧スタックは
  // 対の create が同一 CAS で記録した削除待ちを指す(FR-1-18)。
  const pendingId =
    detectedPending?.id ??
    (rename === undefined
      ? undefined
      : pendingDeletionId(operation.region, record.stackName));
  const cfn = ctx.deps.cfnFactory(operation.region);
  const diff = buildStackDiff({
    stackKey: operation.stackKey,
    region: operation.region,
    stackName: record.stackName,
    operation: 'delete',
    noEchoParams: [],
  });
  if (detectedPending !== undefined) {
    // FR-6-11: 通常の削除対象と区別できるよう、由来を警告として明示する。
    diff.warnings.push(
      `The pre-rename old stack has not been deleted and is pending deletion (original stack key: ${detectedPending.entry.originStackKey})`,
    );
  }
  report.diffs.push(diff);

  const existing = await cfn.describeStack(record.stackName);
  if (!existing || existing.status === 'DELETE_COMPLETE') {
    // design §7 / FR-5-5b2 / FR-5-5b7: DELETE 成功後・state 保存前の中断からの再同期。
    // 実スタックの不在は DescribeStacks が返さないという事実であり、承認前に保存してよい。
    // 削除待ち(リネーム対を含む)は pendingDeletions の当該記録だけを除去する。
    // `stacks` のエントリを除去すると、同一スタックキーの新スタックの記録まで消える。
    const stateUpdated = await reconcileAbsentDeletion(
      ctx,
      operation,
      pendingId,
    );
    reconciliations.push({
      stackKey: operation.stackKey,
      region: operation.region,
      kind: 'deleted-absent',
      stateUpdated,
    });
    resultByOperation.set(
      operation,
      resultForOperation(operation, 'succeeded'),
    );
    emitProgress(
      ctx.deps,
      { stackKey: operation.stackKey, region: operation.region },
      'done',
      'The stack no longer exists; synced as already deleted',
    );
    return { hasDiff: true };
  }

  if (!ctx.options.allowDelete || ctx.options.dryRun) {
    // FR-5-20e / FR-5-20f: plan は変更を一切実行しない(FR-5-20b)ため、削除対象にだけ
    // 実行可否を注記しない。注記すると、同じく実行されない create / update と扱いが
    // 不整合になり、--output json の warnings にも定型のノイズが入る。削除対象である
    // ことの判別は FR-5-7e の表示が、削除待ちの由来は FR-6-11 の警告が担う。
    // 進捗も同様に出さない(plan が意図どおり実行しないことはスキップではない)。
    if (!ctx.options.dryRun) {
      const message =
        'Marked for deletion. --allow-delete is required to actually delete it';
      diff.warnings.push(message);
      emitProgress(
        ctx.deps,
        { stackKey: operation.stackKey, region: operation.region },
        'skipped',
        message,
      );
    }
    resultByOperation.set(operation, resultForOperation(operation, 'skipped'));
    return { hasDiff: true };
  }

  const unresolvedDependsOn = prepared.unresolvedPendingDependsOn.get(
    operation.stackKey,
  );
  return {
    hasDiff: true,
    pending: {
      kind: 'delete',
      operation,
      record,
      diff,
      cfn,
      pendingDeletionId: pendingId,
      // FR-6-9: リネーム対の旧スタックは、対の create の成功記録がある場合にだけ削除する。
      requiresPairedCreate: rename !== undefined,
      ...(unresolvedDependsOn ? { unresolvedDependsOn } : {}),
    },
  };
}

/**
 * FR-5-5b2 / FR-5-5b7 / FR-1-20: 削除対象スタックの不在という既成事実を state へ再同期する。
 * 削除待ちなら当該記録を、通常の削除対象なら `stacks` のエントリを除去する。
 * 戻り値は「state を実際に更新したか」(FR-5-18a の開示に使う)。
 */
async function reconcileAbsentDeletion(
  ctx: LockedRunContext,
  operation: PlannedOperation,
  pendingId: string | undefined,
): Promise<boolean> {
  if (pendingId === undefined) {
    await saveState(ctx, removeStackEntry(ctx.state.state, operation.stackKey));
    return true;
  }
  // リネーム対では、対の create がまだ削除待ちを記録していない場合がある
  // (Phase A で create が実行前のため)。その場合は保存すべき差分がない。
  if (ctx.state.state.pendingDeletions[pendingId] === undefined) return false;
  await saveState(ctx, removePendingDeletion(ctx.state.state, pendingId));
  return true;
}

/** Phase B(承認後)のスタック削除。削除保護・依存情報欠落の拒否は delete usecase が担う。 */
export async function deleteApprovedStack(
  ctx: LockedRunContext,
  action: PendingStackDeletion,
  resultByOperation: Map<PlannedOperation, StackResult>,
): Promise<OperationResult> {
  const { operation, record, diff, cfn } = action;

  // FR-6-9: リネーム対の旧スタックは、対となる新スタックの作成成功が state へ
  // 反映済みの場合にだけ削除する。create が失敗・中断した実行で旧スタックだけを
  // 削除しないための fail-closed ガードである。
  //
  // 敵対的レビュー指摘(1・2回目、FR-6-9a): 削除待ちの ID は (region, stackName) だけで
  // 決まり、originStackKey もテンプレートキーが同一である限り過去の実行と偶然一致
  // しうるため、「削除待ちレコードが存在し origin が一致する」だけでは「今回(または
  // 過去)の対の create が成功した」ことの証明にならない。証明となるのは
  // state.stacks[operation.stackKey] が実際に「削除しようとしている旧スタックとは
  // 異なる stackId」を保持していることだけである — リネーム対の added 側は常に
  // 旧名側と同一のスタックキーを持つ(FR-1-14)ため、このキーの stackId が変わり
  // うるのはこの対自身の create が成功した場合に限られる。
  //
  // 敵対的レビュー指摘(3回目、P2): 同一物理スタックへの削除は、削除待ち自身の
  // 削除アクション(requiresPairedCreate: false)とリネーム対側のアクションの
  // 2 件が計画に入りうる(いずれも同じ物理スタックを指す)。前者が先に成功すると
  // pendingDeletions からその記録が消えるため、削除待ちレコードの存在を必須条件に
  // すると、後者は「記録がない」という理由だけで誤って失敗扱いになる — 実際には
  // 対の create は成功しており、物理的な削除も既に完了した収束済みの状態である。
  // そのため削除待ちレコードの存在・origin を条件にせず、上記の stackId 不一致
  // だけを唯一の判定にする。この場合、後続の DeleteStack は対象が既に存在しない
  // ため通常の「不在からの再同期」(FR-5-5b2)として成功扱いで収束する。
  const currentEntryAtPairKey =
    ctx.state.state.stacks[action.operation.stackKey];
  if (
    action.requiresPairedCreate &&
    (currentEntryAtPairKey === undefined ||
      currentEntryAtPairKey.stackId === record.stackId)
  ) {
    const message =
      `Stack '${record.stackName}' is the old stack of a rename pair, but ` +
      `the state has no record of the paired new stack's create succeeding. ` +
      `Refusing DeleteStack to avoid deleting only the old stack`;
    diff.warnings.push(message);
    const failure = resultForOperation(operation, 'failed');
    failure.errorMessage = message;
    failure.rolledBack = false;
    resultByOperation.set(operation, failure);
    emitProgress(
      ctx.deps,
      { stackKey: operation.stackKey, region: operation.region },
      'failed',
      message,
    );
    return { hasDiff: true, failed: true };
  }

  emitProgress(
    ctx.deps,
    { stackKey: operation.stackKey, region: operation.region },
    'delete-start',
    'Deleting stack',
  );

  const deleted = await deleteManagedStack({
    target: {
      stackKey: operation.stackKey,
      region: operation.region,
      entry: record,
    },
    cfn,
    backend: ctx.deps.backend,
    lock: ctx.lock,
    state: ctx.state.state,
    version: ctx.state.version,
    ...(action.pendingDeletionId === undefined
      ? {}
      : { pendingDeletionId: action.pendingDeletionId }),
    ...(action.unresolvedDependsOn
      ? { unresolvedDependsOn: action.unresolvedDependsOn }
      : {}),
  });

  if (deleted.outcome === 'refused') {
    diff.warnings.push(
      deleted.errorMessage ?? 'Deletion refused by a safety guard',
    );
    const failure = resultForOperation(operation, 'failed');
    failure.errorMessage =
      deleted.errorMessage ?? 'Deletion refused by a safety guard';
    failure.rolledBack = false;
    resultByOperation.set(operation, failure);
    emitProgress(
      ctx.deps,
      { stackKey: operation.stackKey, region: operation.region },
      'failed',
      deleted.errorMessage ?? 'Deletion refused by a safety guard',
    );
    return { hasDiff: true, failed: true };
  }

  ctx.state.state = deleted.state;
  ctx.state.version = deleted.version;
  resultByOperation.set(operation, resultForOperation(operation, 'succeeded'));
  emitProgress(
    ctx.deps,
    { stackKey: operation.stackKey, region: operation.region },
    'done',
    'Stack deleted',
  );
  return { hasDiff: true };
}

export function hasUnsafeDependencyMetadata(
  entry: DeletableStackRecord | undefined,
): boolean {
  return (
    entry === undefined ||
    !Array.isArray(entry.exports) ||
    !Array.isArray(entry.imports) ||
    !Array.isArray(entry.dependsOn) ||
    entry.dependencyAnalysisIncomplete
  );
}
