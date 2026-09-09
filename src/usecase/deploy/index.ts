/**
 * T-14 usecase/deploy — plan と deploy を統合するオーケストレーション。
 */
import {
  type CfnSyncConfig,
  findRequiredPlaceholders,
  targetRegions as resolveTargetRegions,
  resolveTargets,
} from '../../core/config.js';
import { GuardError } from '../../core/errors.js';
import type { PlannedOperation } from '../../core/plan.js';
import type { StackKey } from '../../core/types.js';
import {
  type ConnectionInfo,
  type DeployReport,
  redactReportMessages,
  type StackResult,
} from '../../report/index.js';
import { newRunId } from '../executor.js';
import { makeLockInfo, withFencedLock } from '../fencing.js';
import {
  assertAccountAllowed,
  assertMutationAllowed,
  assertRegionsAllowed,
  connectionHeader,
  resolveConnection,
  verifyStateAccount,
} from '../guard.js';
import { identityRedactor } from '../redactor.js';
import { prepareExecutionPlan, unique } from './planning.js';
import {
  appendDeployFailure,
  cleanupCreatedChangeSets,
  emitProgress,
  failedBeforeLock,
  failureResult,
  markUnprocessedAsSkipped,
  requiredResults,
} from './results.js';
import {
  emitUnchangedDiffs,
  reportPlanningFailures,
  requestApproval,
  runPhaseA,
  runPhaseB,
} from './runPhases.js';
import { now } from './statePersistence.js';
import type {
  CreatedChangeSet,
  DeployDeps,
  DeployOptions,
  DeployResult,
  LockedRunContext,
  RunAccumulator,
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
  const targetRegions = resolveTargetRegions(config);
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
      info: makeLockInfo(runId, now(deps).toISOString()),
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
  const redact = (stackKey: string, text: string): string =>
    (prepared.redactors.get(stackKey) ?? identityRedactor)(text);
  const run: RunAccumulator = {
    report,
    unchangedStacks: [],
    extraStacks: [],
    // FR-5-16: result.stacks の要素順を 2 フェーズ化で変えないため、操作ごとの結果を
    // 計画順の索引として保持し、最後に [必須値不足 → unchanged → 計画順] で組み立てる。
    resultByOperation: new Map<PlannedOperation, StackResult>(),
    reconciliations: [],
    createdChangeSets: new Set<CreatedChangeSet>(),
    pending: [],
    redact,
    notify: (ref, phase, message) =>
      emitProgress(ctx.deps, ref, phase, message),
  };

  const finalize = (exitCode: 0 | 1 | 2, hasDiff: boolean): DeployResult => {
    report.result = {
      stacks: [
        ...requiredStacks,
        ...run.unchangedStacks,
        ...prepared.plan.index.flattened
          .map((operation) => run.resultByOperation.get(operation))
          .filter((result): result is StackResult => result !== undefined),
        ...run.extraStacks,
      ],
    };
    // FR-5-18c: 再同期が 0 件の実行には開示フィールドを追加しない。
    if (run.reconciliations.length > 0) {
      report.reconciliations = run.reconciliations;
    }
    return {
      exitCode,
      report: redactReportMessages(report, redact),
      hasDiff,
    };
  };

  emitUnchangedDiffs(ctx, prepared, run);

  // 計画段階の失敗(AWS 副作用ゼロ。FR-5-12a / FR-9-2 / FR-11-10b)
  if (reportPlanningFailures(ctx, prepared, run)) return finalize(1, false);

  // Phase A(承認前): 全対象の差分を確定させる。変更セットは保持する。
  const phaseA = await runPhaseA(ctx, prepared, run);
  const hasDiff =
    phaseA.hasDiff ||
    report.diffs.some((diff) => diff.operation !== 'no-change');

  if (phaseA.failed) {
    // FR-5-12a / FR-5-12b: --on-failure の値にかかわらず承認を求めず実行全体を中断する。
    markUnprocessedAsSkipped(
      run,
      prepared,
      'Aborted the entire run due to a planning-stage failure',
    );
    // FR-5-12c: 事前作成した自身の変更セットをすべて削除する。失敗した対象自身が
    // 作成済みの変更セット(待機・検証で失敗したもの)も createdChangeSets に載っている。
    await cleanupCreatedChangeSets(
      ctx,
      run.createdChangeSets,
      run.extraStacks,
      redact,
    );
    return finalize(1, hasDiff);
  }

  // 承認(FR-5-2a): Phase B に実行予定がある場合にだけ 1 回だけ求める。
  const approval = await requestApproval(ctx, prepared, run);
  if (approval.outcome === 'abort') return finalize(approval.exitCode, hasDiff);

  // Phase B(承認後): 依存順に実行する。
  const phaseB = await runPhaseB(ctx, prepared, run);

  markUnprocessedAsSkipped(
    run,
    prepared,
    phaseB.ownershipLost
      ? 'Aborted subsequent processing because lock ownership was lost'
      : 'Skipped due to a dependency failure',
  );

  // design §5.3: 失敗・スキップで実行されなかった対象の変更セットも後始末する。
  // 所有権を失った場合は副作用を行わない(次回実行の残存回収に委ねる)。
  let hasError = phaseB.hasError;
  if (!phaseB.ownershipLost && run.createdChangeSets.size > 0) {
    const cleanupFailed = await cleanupCreatedChangeSets(
      ctx,
      run.createdChangeSets,
      run.extraStacks,
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
