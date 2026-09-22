/**
 * #27 Phase 2 — `runLocked` の各段階(未変更報告・計画段階失敗・Phase A・承認・Phase B)。
 * Phase A/B の順序、承認の呼び出し回数(実行全体で 1 回)、fencing の位置は
 * `runLocked`(`index.ts`)側で固定されており、ここでは動かさない。
 */
import {
  GuardError,
  LockError,
  StatePersistenceError,
} from '../../core/errors.js';
import { computeSkips, type PlannedOperation } from '../../core/plan.js';
import type { StackKey } from '../../core/types.js';
import {
  buildApprovalSummary,
  buildStackDiff,
  redactReportMessages,
} from '../../report/index.js';
import {
  executeApprovedChangeSet,
  planCreateOrUpdate,
} from './changeSetPhase.js';
import { deleteApprovedStack, planDeletion } from './deletePhase.js';
import {
  findPhysicalStackConflicts,
  findUnsafeDeleteKeys,
} from './planning.js';
import {
  cleanupCreatedChangeSets,
  failedOperationResult,
  publicErrorMessage,
  recordFailed,
  recordSkipped,
  stackResult,
} from './results.js';
import type {
  LockedRunContext,
  PreparedPlan,
  RunAccumulator,
} from './types.js';

/** detect 段階で unchanged のスタックは CloudFormation に一切触れず明示的に報告する。 */
export function emitUnchangedDiffs(
  ctx: LockedRunContext,
  prepared: PreparedPlan,
  run: RunAccumulator,
): void {
  for (const entry of prepared.detection.entries) {
    if (
      entry.changeType !== 'unchanged' ||
      !entry.target ||
      ctx.required.has(entry.stackKey)
    )
      continue;
    run.report.diffs.push(
      buildStackDiff({
        stackKey: entry.stackKey,
        region: entry.target.region,
        stackName: entry.target.stackName,
        operation: 'no-change',
        noEchoParams: prepared.analyses.get(entry.stackKey)?.noEchoParams ?? [],
      }),
    );
    run.unchangedStacks.push(stackResult(entry.target, 'no-change'));
    run.notify(
      { stackKey: entry.stackKey, region: entry.target.region },
      'no-change',
      'No changes (already detected)',
    );
  }
}

/**
 * AWS 副作用ゼロの計画段階失敗(物理スタック衝突・必須値未充足)を記録する。
 * FR-5-12a / FR-9-2 / FR-11-10b。戻り値は「実行全体を中断すべきか」。
 */
export function reportPlanningFailures(
  ctx: LockedRunContext,
  prepared: PreparedPlan,
  run: RunAccumulator,
): boolean {
  const planningFailures = findPhysicalStackConflicts(ctx, prepared.plan);
  if (planningFailures.size === 0 && ctx.required.size === 0) return false;

  for (const operation of prepared.plan.index.flattened) {
    const message = planningFailures.get(operation.stackKey);
    if (message === undefined) {
      recordSkipped(
        run,
        operation,
        'Aborted the entire run due to a planning-stage failure',
      );
      continue;
    }
    recordFailed(run, operation, message);
  }
  return true;
}

/**
 * Phase A(承認前): 全対象の差分を確定させる。変更セットは保持する(`ExecuteChangeSet` /
 * `DeleteStack` は一切行わない。FR-5-5a)。
 */
export async function runPhaseA(
  ctx: LockedRunContext,
  prepared: PreparedPlan,
  run: RunAccumulator,
): Promise<{ hasDiff: boolean; failed: boolean }> {
  let hasDiff = false;
  // §8.3 / FR-6-5: 依存メタデータ自体が unknown/incomplete の削除は provider を特定できない。
  // その対象より前に並んだ削除も含め、同じ削除バッチの他対象を副作用前に止める。
  const unsafeDeleteKeys = findUnsafeDeleteKeys(ctx, prepared);

  for (const operation of prepared.plan.index.flattened) {
    if (
      operation.kind === 'delete' &&
      unsafeDeleteKeys.size > 0 &&
      !unsafeDeleteKeys.has(operation.stackKey)
    ) {
      recordSkipped(run, operation, 'Skipped due to a dependency failure');
      continue;
    }
    try {
      const outcome =
        operation.kind === 'delete'
          ? await planDeletion(ctx, operation, prepared, run)
          : await planCreateOrUpdate(ctx, operation, prepared, run);
      hasDiff ||= outcome.hasDiff;
      if (outcome.pending) run.pending.push(outcome.pending);
    } catch (error) {
      // NFR-4: failedOperationResult が構成した redactor 適用済み errorMessage を
      // そのまま progress へ再利用する(独立に redact し直さない = 単一の redaction 経路)。
      const failure = failedOperationResult(
        operation,
        error,
        prepared.redactors.get(operation.stackKey),
      );
      recordFailed(run, operation, failure.errorMessage ?? 'Failed', {
        rolledBack: failure.rolledBack,
      });
      return { hasDiff, failed: true };
    }
  }
  return { hasDiff, failed: false };
}

/**
 * 承認(FR-5-2a): Phase B に実行予定がある場合にだけ実行全体で 1 回だけ求める。
 * 拒否・承認ポート自体の失敗はいずれも作成済み変更セットを回収してから中断する。
 */
export async function requestApproval(
  ctx: LockedRunContext,
  prepared: PreparedPlan,
  run: RunAccumulator,
): Promise<{ outcome: 'proceed' } | { outcome: 'abort'; exitCode: 0 | 1 }> {
  if (run.pending.length === 0 || ctx.options.autoApprove === true) {
    return { outcome: 'proceed' };
  }
  const { report, redact, extraStacks } = run;
  const approve = ctx.deps.approve;
  if (approve === undefined) {
    // FR-5-13(多層防御): 入口検証を通過していれば到達しない。
    throw new GuardError(
      'Cannot run because no approval mechanism is provided. Specify --auto-approve',
    );
  }
  let approved: boolean;
  try {
    approved = await approve({
      connection: report.connection,
      // FR-5-6g / NFR-4: report と同一の redactor を通してから承認手段へ渡す。
      diffs: redactReportMessages(
        { connection: report.connection, diffs: report.diffs },
        redact,
      ).diffs,
      summary: buildApprovalSummary(report.diffs),
      allowDelete: ctx.options.allowDelete === true,
    });
  } catch (error) {
    // FR-5-19: 承認ポート自体の失敗は拒否(false)とは区別するが、Phase B へ
    // 進めない点と作成済み変更セットの回収は同じ fail-closed 契約に従う。
    extraStacks.push({
      stackKey: '(approval)',
      region: ctx.connection.regions[0] ?? '(none)',
      stackName: '(approval)',
      outcome: 'failed',
      // 対象スタックを一意に決められないため、全対象の NoEcho 実効値をまとめて
      // マスクする。分類不能な例外は publicErrorMessage が固定文言へ置換する。
      errorMessage: `Approval processing failed: ${prepared.globalRedactor(
        publicErrorMessage(error),
      )}`,
      rolledBack: false,
    });
    // FR-5-19a: CLI の approve と onProgress は同じ stderr 故障で続けて
    // throw しうる。観測通知によって回収が妨げられないよう、必ず先に後始末する。
    await cleanupCreatedChangeSets(
      ctx,
      run.createdChangeSets,
      extraStacks,
      redact,
    );
    for (const action of run.pending) {
      recordSkipped(
        run,
        action.operation,
        'Not executed because approval processing failed',
      );
    }
    return { outcome: 'abort', exitCode: 1 };
  }
  if (!approved) {
    // FR-5-10a〜c: 変更セットを全削除し、未実行は skipped、終了コードは 0。
    report.cancelled = true;
    for (const action of run.pending) {
      recordSkipped(
        run,
        action.operation,
        'Not executed because approval was not granted',
      );
    }
    const cleanupFailed = await cleanupCreatedChangeSets(
      ctx,
      run.createdChangeSets,
      extraStacks,
      redact,
    );
    // FR-5-11: クリーンアップ失敗のみ exit 1(残存は次回の残存回収で収束する)。
    return { outcome: 'abort', exitCode: cleanupFailed ? 1 : 0 };
  }
  return { outcome: 'proceed' };
}

/** Phase B(承認後): 依存順に実行する。 */
export async function runPhaseB(
  ctx: LockedRunContext,
  prepared: PreparedPlan,
  run: RunAccumulator,
): Promise<{ hasError: boolean; ownershipLost: boolean }> {
  let hasError = false;
  let ownershipLost = false;
  const skipped = new Set<StackKey>();

  const propagateFailure = (operation: PlannedOperation): void => {
    const decision = computeSkips({
      plan: prepared.plan,
      failedStackKey: operation.stackKey,
      mergedGraphs: prepared.mergedGraphs,
      onFailure: ctx.options.onFailure ?? 'stop',
      failureKind: operation.kind === 'delete' ? 'delete' : 'deploy',
      collectContinued: false,
    });
    for (const key of decision.skipped) skipped.add(key);
  };

  for (const action of run.pending) {
    const operation = action.operation;
    if (skipped.has(operation.stackKey)) {
      recordSkipped(run, operation, 'Skipped due to a dependency failure');
      continue;
    }

    // design §5.3: 回収集合からの除外は「ExecuteChangeSet を送信した(かもしれない)」
    // 時点で executeApprovedChangeSet が行う。実行前の fail-closed 拒否
    // (状態不一致・変更セット差し替え・他主体検出)では未実行の自変更セットが
    // 残るため、ここでは外さない。
    try {
      const outcome =
        action.kind === 'execute'
          ? await executeApprovedChangeSet(ctx, action, run)
          : await deleteApprovedStack(ctx, action, run);
      if (outcome.failed === true) {
        hasError = true;
        propagateFailure(operation);
      }
    } catch (error) {
      hasError = true;
      const failure = failedOperationResult(
        operation,
        error,
        prepared.redactors.get(operation.stackKey),
      );
      recordFailed(run, operation, failure.errorMessage ?? 'Failed', {
        rolledBack: failure.rolledBack,
      });

      // fencing 喪失は「当該副作用以降を実行しない」ため onFailure に関係なく即中断。
      if (
        error instanceof LockError ||
        error instanceof StatePersistenceError
      ) {
        ownershipLost = true;
        break;
      }
      propagateFailure(operation);
    }
  }

  return { hasError, ownershipLost };
}
