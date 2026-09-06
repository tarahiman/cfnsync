import type { ResolvedStackTarget } from '../../core/config.js';
import { CfnSyncError } from '../../core/errors.js';
import type { PlannedOperation } from '../../core/plan.js';
import { parseStackKey, type StackKey } from '../../core/types.js';
import type {
  ConnectionInfo,
  ProgressPhase,
  StackResult,
} from '../../report/index.js';
import { identityRedactor, type TextRedactor } from '../redactor.js';
import {
  type CreatedChangeSet,
  type DeployDeps,
  type DeployResult,
  type LockedRunContext,
  type PreparedPlan,
  type RunAccumulator,
  StackExecutionFailure,
} from './types.js';

export function markUnprocessedAsSkipped(
  ctx: LockedRunContext,
  prepared: PreparedPlan,
  resultByOperation: Map<PlannedOperation, StackResult>,
  message: string,
): void {
  for (const operation of prepared.plan.index.flattened) {
    if (resultByOperation.has(operation)) continue;
    resultByOperation.set(operation, resultForOperation(operation, 'skipped'));
    emitProgress(
      ctx.deps,
      { stackKey: operation.stackKey, region: operation.region },
      'skipped',
      message,
    );
  }
}

/**
 * §5.3.3 / FR-5-12c: 事前作成した**自身の**変更セットを、作成時に保持した ARN で削除する。
 * 対象は「AWS 上に作成済みで、まだ実行も削除もしていない」もの全件であり、`PendingAction`
 * にならなかった対象(作成後の待機・検証で失敗したもの)も含む。他主体・別ステートの
 * 変更セットには触れない。失敗は警告として報告し(FR-5-11)、残存は次回実行の残存回収(§7)
 * へ委ねる。戻り値は「削除に失敗したものがあるか」。
 */
export async function cleanupCreatedChangeSets(
  ctx: LockedRunContext,
  createdChangeSets: Set<CreatedChangeSet>,
  extraStacks: StackResult[],
  redact: (stackKey: string, text: string) => string,
): Promise<boolean> {
  const failures: string[] = [];
  for (const changeSet of [...createdChangeSets]) {
    try {
      await changeSet.cfn.deleteChangeSet(changeSet.stackName, changeSet.id);
      createdChangeSets.delete(changeSet);
    } catch (error) {
      failures.push(
        `${changeSet.operation.stackKey}: ${redact(
          changeSet.operation.stackKey,
          publicErrorMessage(error, 'Failed to delete the change set'),
        )}`,
      );
    }
  }
  if (failures.length === 0) return false;

  extraStacks.push({
    stackKey: '(cleanup)',
    region: ctx.connection.regions[0] ?? '(none)',
    stackName: '(cleanup)',
    outcome: 'failed',
    errorMessage:
      `Failed to delete pre-created change sets: ${failures.join(' / ')}. ` +
      `Remaining change sets will be reclaimed on the next run`,
    rolledBack: false,
  });
  return true;
}

/**
 * FR-5-4: 進捗マイルストーンを onProgress へ fire-and-forget で通知する。
 * 純粋に観測用であり、exitCode / hasDiff / スキップ判定など制御フローには一切影響しない。
 */
export function emitProgress(
  deps: DeployDeps,
  ref: { stackKey: string; region: string },
  phase: ProgressPhase,
  message: string,
): void {
  try {
    deps.onProgress?.({ ...ref, phase, message });
  } catch {
    // ProgressEvent は観測専用ポートであり、stderr 等の配送障害によって
    // AWS 操作・クリーンアップ・最終 report の制御フローを置換させない。
  }
}

export function recordSkipped(
  run: RunAccumulator,
  operation: PlannedOperation,
  message: string,
): void {
  run.resultByOperation.set(
    operation,
    resultForOperation(operation, 'skipped'),
  );
  run.notify(operation, 'skipped', message);
}

export function recordFailed(
  run: RunAccumulator,
  operation: PlannedOperation,
  message: string,
  options: { rolledBack?: boolean } = {},
): void {
  const result = resultForOperation(operation, 'failed');
  result.errorMessage = message;
  result.rolledBack = options.rolledBack ?? false;
  run.resultByOperation.set(operation, result);
  run.notify(operation, 'failed', message);
}

export function recordDone(
  run: RunAccumulator,
  operation: PlannedOperation,
  result: StackResult,
  message: string,
): void {
  run.resultByOperation.set(operation, result);
  run.notify(operation, 'done', message);
}

export function stackResult(
  target: ResolvedStackTarget,
  outcome: StackResult['outcome'],
): StackResult {
  return {
    stackKey: target.stackKey,
    region: target.region,
    stackName: target.stackName,
    outcome,
  };
}

export function resultForOperation(
  operation: PlannedOperation,
  outcome: StackResult['outcome'],
): StackResult {
  const target = operation.entry.target;
  const stateEntry = operation.entry.stateEntry;
  return {
    stackKey: operation.stackKey,
    region: operation.region,
    stackName:
      target?.stackName ??
      stateEntry?.stackName ??
      operation.entry.pendingDeletion?.entry.stackName ??
      operation.stackKey,
    outcome,
  };
}

export function failedOperationResult(
  operation: PlannedOperation,
  error: unknown,
  redact: TextRedactor = identityRedactor,
): StackResult {
  const result = resultForOperation(operation, 'failed');
  result.errorMessage = redact(publicErrorMessage(error));
  result.rolledBack =
    error instanceof StackExecutionFailure ? error.rolledBack : false;
  return result;
}

export function requiredResults(
  required: Map<StackKey, string[]>,
  targets: ResolvedStackTarget[],
): StackResult[] {
  const byKey = new Map(targets.map((target) => [target.stackKey, target]));
  return [...required].map(([stackKey, names]) => {
    const target = byKey.get(stackKey);
    const parsed = parseStackKey(stackKey);
    return {
      stackKey,
      region: target?.region ?? parsed.region,
      stackName: target?.stackName ?? stackKey,
      outcome: 'failed',
      errorMessage: `Required parameters still contain __REQUIRED__: ${names.join(', ')}`,
      rolledBack: false,
    };
  });
}

export function failedBeforeLock(
  connection: ConnectionInfo,
  required: Map<StackKey, string[]>,
  targets: ResolvedStackTarget[],
  error: unknown,
): DeployResult {
  return failureResult(connection, requiredResults(required, targets), error);
}

export function failureResult(
  connection: ConnectionInfo,
  existing: StackResult[],
  error: unknown,
): DeployResult {
  return {
    exitCode: 1,
    hasDiff: false,
    report: {
      connection,
      diffs: [],
      events: [],
      result: {
        stacks: [
          ...existing,
          {
            stackKey: '(deploy)',
            region: connection.regions[0] ?? '(none)',
            stackName: '(deploy)',
            outcome: 'failed',
            errorMessage: publicErrorMessage(error),
            rolledBack: false,
          },
        ],
      },
    },
  };
}

export function appendDeployFailure(
  result: DeployResult,
  error: unknown,
): DeployResult {
  const stacks = result.report.result?.stacks ?? [];
  stacks.push({
    stackKey: '(deploy)',
    region: result.report.connection.regions[0] ?? '(none)',
    stackName: '(deploy)',
    outcome: 'failed',
    errorMessage: `Failed to release the lock: ${publicErrorMessage(error)}`,
    rolledBack: false,
  });
  result.report.result = { stacks };
  result.exitCode = 1;
  return result;
}

export function publicErrorMessage(
  error: unknown,
  fallback = 'An unexpected error occurred',
): string {
  return error instanceof CfnSyncError ? error.publicMessage : fallback;
}
