/**
 * T-14 usecase/deploy — plan と deploy を統合するオーケストレーション。
 */
import {
  type CfnSyncConfig,
  findRequiredPlaceholders,
  resolveTargets,
} from '../../core/config.js';
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
  type ConnectionInfo,
  type DeployReport,
  type ReconciliationRecord,
  redactReportMessages,
  type StackResult,
} from '../../report/index.js';
import { newRunId } from '../executor.js';
import { withFencedLock } from '../fencing.js';
import {
  assertAccountAllowed,
  assertMutationAllowed,
  assertRegionsAllowed,
  connectionHeader,
  resolveConnection,
  verifyStateAccount,
} from '../guard.js';
import { identityRedactor } from '../redactor.js';
import {
  executeApprovedChangeSet,
  planCreateOrUpdate,
} from './changeSetPhase.js';
import { deleteApprovedStack, planDeletion } from './deletePhase.js';
import {
  findPhysicalStackConflicts,
  findUnsafeDeleteKeys,
  prepareExecutionPlan,
  unique,
} from './planning.js';
import {
  appendDeployFailure,
  cleanupCreatedChangeSets,
  emitProgress,
  failedBeforeLock,
  failedOperationResult,
  failureResult,
  markUnprocessedAsSkipped,
  publicErrorMessage,
  requiredResults,
  resultForOperation,
  stackResult,
} from './results.js';
import { now } from './statePersistence.js';
import type {
  CreatedChangeSet,
  DeployDeps,
  DeployOptions,
  DeployResult,
  LockedRunContext,
  PendingAction,
} from './types.js';

export type { DeployDeps, DeployOptions, DeployResult } from './types.js';

export async function deploy(input: {
  config: CfnSyncConfig;
  templates: Map<string, string>;
  deps: DeployDeps;
  options: DeployOptions;
}): Promise<DeployResult> {
  const { config, templates, deps, options } = input;
  const targets = resolveTargets(config);
  const targetRegions = unique(targets.map((target) => target.region));
  const required = new Map<StackKey, string[]>();
  for (const target of targets) {
    const placeholders = findRequiredPlaceholders(target);
    if (placeholders.length > 0) required.set(target.stackKey, placeholders);
  }

  let connection: ConnectionInfo = {
    accountId: '(unresolved)',
    regions: targetRegions,
  };

  // FR-5-13 / design §5.3.4: 承認が必要なのに承認手段が注入されていない場合、
  // STS・ステートバックエンド・CloudFormation へ一切アクセスせず fail-closed に停止する。
  // CLI 境界の非 TTY チェック(§9)と重複するが、埋め込み利用も守る多層防御。
  if (
    options.dryRun !== true &&
    options.autoApprove !== true &&
    deps.approve === undefined
  ) {
    return failedBeforeLock(
      connection,
      required,
      targets,
      new GuardError(
        'Cannot run deploy because no approval mechanism is provided. ' +
          'In a non-interactive environment, specify --auto-approve, or use cfnsync plan to only check the diff',
      ),
    );
  }

  // design §5.3 / guard JSDoc: ロック前に 1 → 2 → account → regions の順で fail-closed。
  try {
    assertMutationAllowed(config);
    const resolved = await resolveConnection(deps.sts);
    connection = connectionHeader({
      accountId: resolved.accountId,
      regions: targetRegions,
    });
    assertAccountAllowed(config, resolved.accountId);
    assertRegionsAllowed(config, targetRegions);
  } catch (error) {
    return failedBeforeLock(connection, required, targets, error);
  }

  const runId = (deps.runId ?? newRunId)();
  try {
    return await withFencedLock({
      backend: deps.backend,
      info: {
        runId,
        startedAt: now(deps).toISOString(),
        owner: process.env.USER ?? process.env.LOGNAME ?? 'cfnsync',
      },
      run: async ({ lock, backend }) => {
        try {
          const state = await verifyStateAccount({
            backend,
            accountId: connection.accountId,
          });
          return await runLocked({
            config,
            templates,
            deps,
            options,
            targets,
            connection,
            lock,
            runId,
            state,
            required,
          });
        } catch (error) {
          return failureResult(
            connection,
            requiredResults(required, targets),
            error,
          );
        }
      },
      onReleaseError: (result, error) => appendDeployFailure(result, error),
    });
  } catch (error) {
    return failedBeforeLock(connection, required, targets, error);
  }
}

// ===========================================================================
// ロック配下の本体
// ===========================================================================

/**
 * design §5.3: deploy 本体。承認を境に Phase A(全対象の差分確定)と
 * Phase B(依存順の一括実行)へ分割する。Phase A は `ExecuteChangeSet` /
 * `DeleteStack` を一切行わず(FR-5-5a)、承認は実行全体で 1 回だけ求める(FR-5-2a)。
 */
async function runLocked(ctx: LockedRunContext): Promise<DeployResult> {
  const prepared = prepareExecutionPlan(ctx);

  // deleted の旧リージョンも含め、実計画で触れる全リージョンを AWS 読み取り前に再照合する。
  const plannedRegions = prepared.plan.regions.map((region) => region.region);
  assertRegionsAllowed(ctx.config, plannedRegions);
  ctx.connection.regions = unique([
    ...ctx.connection.regions,
    ...plannedRegions,
  ]);

  const report: DeployReport = {
    connection: ctx.connection,
    diffs: [],
    ...(ctx.options.collectEvents !== false ? { events: [] } : {}),
  };
  const requiredStacks = requiredResults(ctx.required, ctx.targets);
  const unchangedStacks: StackResult[] = [];
  /** スタック操作に紐づかない付帯的な失敗(変更セットの後始末失敗等)。 */
  const extraStacks: StackResult[] = [];
  // FR-5-16: result.stacks の要素順を 2 フェーズ化で変えないため、操作ごとの結果を
  // 計画順の索引として保持し、最後に [必須値不足 → unchanged → 計画順] で組み立てる。
  const resultByOperation = new Map<PlannedOperation, StackResult>();
  const reconciliations: ReconciliationRecord[] = [];
  const redact = (stackKey: string, text: string): string =>
    (prepared.redactors.get(stackKey) ?? identityRedactor)(text);

  const finalize = (exitCode: 0 | 1 | 2, hasDiff: boolean): DeployResult => {
    report.result = {
      stacks: [
        ...requiredStacks,
        ...unchangedStacks,
        ...prepared.plan.index.flattened
          .map((operation) => resultByOperation.get(operation))
          .filter((result): result is StackResult => result !== undefined),
        ...extraStacks,
      ],
    };
    // FR-5-18c: 再同期が 0 件の実行には開示フィールドを追加しない。
    if (reconciliations.length > 0) report.reconciliations = reconciliations;
    return {
      exitCode,
      report: redactReportMessages(report, redact),
      hasDiff,
    };
  };

  // detect 段階で unchanged のスタックは CloudFormation に一切触れず明示的に報告する。
  for (const entry of prepared.detection.entries) {
    if (
      entry.changeType !== 'unchanged' ||
      !entry.target ||
      ctx.required.has(entry.stackKey)
    )
      continue;
    report.diffs.push(
      buildStackDiff({
        stackKey: entry.stackKey,
        region: entry.target.region,
        stackName: entry.target.stackName,
        operation: 'no-change',
        noEchoParams: prepared.analyses.get(entry.stackKey)?.noEchoParams ?? [],
      }),
    );
    unchangedStacks.push(stackResult(entry.target, 'no-change'));
    emitProgress(
      ctx.deps,
      { stackKey: entry.stackKey, region: entry.target.region },
      'no-change',
      'No changes (already detected)',
    );
  }

  // ---------------------------------------------------------------------
  // 計画段階の失敗(AWS 副作用ゼロ。FR-5-12a / FR-9-2 / FR-11-10b)
  // ---------------------------------------------------------------------
  const planningFailures = findPhysicalStackConflicts(ctx, prepared.plan);
  if (planningFailures.size > 0 || ctx.required.size > 0) {
    for (const operation of prepared.plan.index.flattened) {
      const message = planningFailures.get(operation.stackKey);
      if (message === undefined) {
        resultByOperation.set(
          operation,
          resultForOperation(operation, 'skipped'),
        );
        emitProgress(
          ctx.deps,
          { stackKey: operation.stackKey, region: operation.region },
          'skipped',
          'Aborted the entire run due to a planning-stage failure',
        );
        continue;
      }
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
    }
    return finalize(1, false);
  }

  // ---------------------------------------------------------------------
  // Phase A(承認前): 全対象の差分を確定させる。変更セットは保持する。
  // ---------------------------------------------------------------------
  const pending: PendingAction[] = [];
  // FR-5-12c: AWS 上に作成済みで未回収の自変更セット。作成の直後に登録されるため、
  // 作成後の待機・検証で失敗した対象(PendingAction にならない対象)もここに載る。
  const createdChangeSets = new Set<CreatedChangeSet>();
  let hasDiff = false;
  let phaseAFailed = false;
  // §8.3 / FR-6-5: 依存メタデータ自体が unknown/incomplete の削除は provider を特定できない。
  // その対象より前に並んだ削除も含め、同じ削除バッチの他対象を副作用前に止める。
  const unsafeDeleteKeys = findUnsafeDeleteKeys(ctx, prepared);

  for (const operation of prepared.plan.index.flattened) {
    if (
      operation.kind === 'delete' &&
      unsafeDeleteKeys.size > 0 &&
      !unsafeDeleteKeys.has(operation.stackKey)
    ) {
      resultByOperation.set(
        operation,
        resultForOperation(operation, 'skipped'),
      );
      emitProgress(
        ctx.deps,
        { stackKey: operation.stackKey, region: operation.region },
        'skipped',
        'Skipped due to a dependency failure',
      );
      continue;
    }
    try {
      const outcome =
        operation.kind === 'delete'
          ? await planDeletion(
              ctx,
              operation,
              prepared,
              report,
              resultByOperation,
              reconciliations,
            )
          : await planCreateOrUpdate(
              ctx,
              operation,
              prepared,
              report,
              resultByOperation,
              reconciliations,
              createdChangeSets,
            );
      hasDiff ||= outcome.hasDiff;
      if (outcome.pending) pending.push(outcome.pending);
    } catch (error) {
      // NFR-4: failedOperationResult が構成した redactor 適用済み errorMessage を
      // そのまま progress へ再利用する(独立に redact し直さない = 単一の redaction 経路)。
      const failure = failedOperationResult(
        operation,
        error,
        prepared.redactors.get(operation.stackKey),
      );
      resultByOperation.set(operation, failure);
      emitProgress(
        ctx.deps,
        { stackKey: operation.stackKey, region: operation.region },
        'failed',
        failure.errorMessage ?? 'Failed',
      );
      phaseAFailed = true;
      break;
    }
  }

  hasDiff ||= report.diffs.some((diff) => diff.operation !== 'no-change');

  if (phaseAFailed) {
    // FR-5-12a / FR-5-12b: --on-failure の値にかかわらず承認を求めず実行全体を中断する。
    markUnprocessedAsSkipped(
      ctx,
      prepared,
      resultByOperation,
      'Aborted the entire run due to a planning-stage failure',
    );
    // FR-5-12c: 事前作成した自身の変更セットをすべて削除する。失敗した対象自身が
    // 作成済みの変更セット(待機・検証で失敗したもの)も createdChangeSets に載っている。
    await cleanupCreatedChangeSets(ctx, createdChangeSets, extraStacks, redact);
    return finalize(1, hasDiff);
  }

  // ---------------------------------------------------------------------
  // 承認(FR-5-2a): Phase B に実行予定がある場合にだけ 1 回だけ求める。
  // ---------------------------------------------------------------------
  if (pending.length > 0 && ctx.options.autoApprove !== true) {
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
        createdChangeSets,
        extraStacks,
        redact,
      );
      for (const action of pending) {
        resultByOperation.set(
          action.operation,
          resultForOperation(action.operation, 'skipped'),
        );
        emitProgress(
          ctx.deps,
          {
            stackKey: action.operation.stackKey,
            region: action.operation.region,
          },
          'skipped',
          'Not executed because approval processing failed',
        );
      }
      return finalize(1, hasDiff);
    }
    if (!approved) {
      // FR-5-10a〜c: 変更セットを全削除し、未実行は skipped、終了コードは 0。
      report.cancelled = true;
      for (const action of pending) {
        resultByOperation.set(
          action.operation,
          resultForOperation(action.operation, 'skipped'),
        );
        emitProgress(
          ctx.deps,
          {
            stackKey: action.operation.stackKey,
            region: action.operation.region,
          },
          'skipped',
          'Not executed because approval was not granted',
        );
      }
      const cleanupFailed = await cleanupCreatedChangeSets(
        ctx,
        createdChangeSets,
        extraStacks,
        redact,
      );
      // FR-5-11: クリーンアップ失敗のみ exit 1(残存は次回の残存回収で収束する)。
      return finalize(cleanupFailed ? 1 : 0, hasDiff);
    }
  }

  // ---------------------------------------------------------------------
  // Phase B(承認後): 依存順に実行する。
  // ---------------------------------------------------------------------
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

  for (const action of pending) {
    const operation = action.operation;
    if (skipped.has(operation.stackKey)) {
      resultByOperation.set(
        operation,
        resultForOperation(operation, 'skipped'),
      );
      emitProgress(
        ctx.deps,
        { stackKey: operation.stackKey, region: operation.region },
        'skipped',
        'Skipped due to a dependency failure',
      );
      continue;
    }

    // design §5.3: 回収集合からの除外は「ExecuteChangeSet を送信した(かもしれない)」
    // 時点で executeApprovedChangeSet が行う。実行前の fail-closed 拒否
    // (状態不一致・変更セット差し替え・他主体検出)では未実行の自変更セットが
    // 残るため、ここでは外さない。
    try {
      const outcome =
        action.kind === 'execute'
          ? await executeApprovedChangeSet(
              ctx,
              action,
              report,
              resultByOperation,
              createdChangeSets,
            )
          : await deleteApprovedStack(ctx, action, resultByOperation);
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
      resultByOperation.set(operation, failure);
      emitProgress(
        ctx.deps,
        { stackKey: operation.stackKey, region: operation.region },
        'failed',
        failure.errorMessage ?? 'Failed',
      );

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

  markUnprocessedAsSkipped(
    ctx,
    prepared,
    resultByOperation,
    ownershipLost
      ? 'Aborted subsequent processing because lock ownership was lost'
      : 'Skipped due to a dependency failure',
  );

  // design §5.3: 失敗・スキップで実行されなかった対象の変更セットも後始末する。
  // 所有権を失った場合は副作用を行わない(次回実行の残存回収に委ねる)。
  if (!ownershipLost && createdChangeSets.size > 0) {
    const cleanupFailed = await cleanupCreatedChangeSets(
      ctx,
      createdChangeSets,
      extraStacks,
      redact,
    );
    hasError ||= cleanupFailed;
  }

  const exitCode: 0 | 1 | 2 = hasError
    ? 1
    : ctx.options.dryRun && hasDiff
      ? 2
      : 0;
  return finalize(exitCode, hasDiff);
}
