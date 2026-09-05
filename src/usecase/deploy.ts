/**
 * T-14 usecase/deploy — plan と deploy を統合するオーケストレーション。
 *
 * 安全性の要点:
 * - 許可アカウント・リージョンの検証はロック取得前、state account 照合は取得後。
 * - CloudFormation の全副作用は fencing 付き gateway を経由し、executor 内部の
 *   残存回収・空変更セット削除も実 API 呼び出し直前に verifyLock される。
 * - 成功・空変更・復旧の state 保存は完了待機後に再度 fencing し、CAS で保存する。
 * - fencing はベストエフォートであり、正本の一貫性は StateBackend の CAS が担う。
 */

import {
  type CfnSyncConfig,
  findRequiredPlaceholders,
  type ResolvedStackTarget,
  resolveTargets,
} from '../core/config.js';
import { resolveDependsOnKey } from '../core/dependency.js';
import {
  computeTemplateHash,
  type DetectedEntry,
  type DetectionResult,
  detectChanges,
} from '../core/detect.js';
import {
  CfnSyncError,
  ConfigError,
  GuardError,
  InvariantError,
  LockError,
  StackStateError,
  StatePersistenceError,
} from '../core/errors.js';
import {
  buildGraphs,
  mergeGraphs,
  type RegionGraph,
  type StackNode,
} from '../core/graph.js';
import {
  buildPlan,
  computeSkips,
  type ExecutionPlan,
  type PlannedOperation,
} from '../core/plan.js';
import {
  type CfnSyncState,
  type DeletableStackRecord,
  type PendingDeletionEntry,
  pendingDeletionId,
  prepareSave,
  removePendingDeletion,
  removeStackEntry,
  type StackEntry,
  upsertPendingDeletion,
  upsertStackEntry,
} from '../core/state.js';
import {
  analyzeStaticTemplate,
  extractParameterDefaults,
  extractScalarParameterDefaults,
  parseCfnTemplate,
  parsedTemplatesEquivalent,
  resolveStaticTemplateAnalysis,
  type StaticTemplateAnalysis,
  type TemplateAnalysis,
} from '../core/template.js';
import { parseStackKey, type StackKey } from '../core/types.js';
import type {
  CloudFormationGateway,
  LockHandle,
  StateBackend,
  StateVersion,
  StsGateway,
} from '../ports/index.js';
import {
  type ApprovalRequest,
  buildApprovalSummary,
  buildStackDiff,
  type ConnectionInfo,
  type DeployReport,
  type ProgressEvent,
  type ProgressPhase,
  type ReconciliationRecord,
  redactReportMessages,
  type StackDiff,
  type StackEventLine,
  type StackResult,
} from '../report/index.js';
import { deleteManagedStack } from './delete.js';
import {
  createManagedChangeSet,
  type ExecutorContext,
  executeWithReinspection,
  MANAGEMENT_TAG_KEY,
  newRunId,
  prepareStack,
  reclaimStaleChangeSets,
} from './executor.js';
import { assertFenced, fencedGateway, withFencedLock } from './fencing.js';
import {
  assertAccountAllowed,
  assertMutationAllowed,
  assertRegionsAllowed,
  connectionHeader,
  resolveConnection,
  verifyStateAccount,
} from './guard.js';
import {
  createNoEchoRedactor,
  identityRedactor,
  type TextRedactor,
} from './redactor.js';

// ===========================================================================
// 公開 API(T-15 / T-19 が利用する固定契約)
// ===========================================================================

export interface DeployDeps {
  cfnFactory: (region: string) => CloudFormationGateway;
  sts: StsGateway;
  backend: StateBackend;
  /** テスト用の時計。変更セット名・ロック開始時刻・成功時刻に共通利用する。 */
  now?: () => Date;
  /** テスト用の run ID 生成器。省略時は executor.newRunId。 */
  runId?: () => string;
  /** FR-4-1: 待機中イベントの逐次出力先。 */
  onEvent?: (event: StackEventLine) => void;
  /** FR-5-4: スタック単位の進捗マイルストーンの逐次出力先(標準エラー想定)。
   *  最終 report(標準出力)には一切含めない独立チャネル。 */
  onProgress?: (event: ProgressEvent) => void;
  /** FR-5-2a: 実行全体で最大 1 回だけ呼ばれる承認ポート。true = 承認。
   *  usecase は TTY・プロンプト・入力ストリームを一切知らない(design §5.3.2)。 */
  approve?: (request: ApprovalRequest) => Promise<boolean>;
}

export interface DeployOptions {
  /** FR-5-20a〜FR-5-20d / design §5.3.5: `plan` 経路を表す内部フラグ。
   *  true なら差分確定の直後に自身の変更セットを削除して停止し、承認・実行へ進まない。
   *  公開 CLI オプションとしては提供しない(旧 `deploy --dry-run` は FR-12-8d で廃止)。 */
  dryRun?: boolean;
  allowDelete?: boolean;
  onFailure?: 'stop' | 'continue';
  /** JSON 出力など、最終 report にイベント列を含める場合だけ true。既定 true。 */
  collectEvents?: boolean;
  /** FR-5-2b: true なら approve を呼ばずに実行する。 */
  autoApprove?: boolean;
}

export interface DeployResult {
  exitCode: 0 | 1 | 2;
  report: DeployReport;
  hasDiff: boolean;
}

interface MutableStateContext {
  state: CfnSyncState;
  version: StateVersion | undefined;
}

interface LockedRunContext {
  config: CfnSyncConfig;
  templates: Map<string, string>;
  deps: DeployDeps;
  options: DeployOptions;
  targets: ResolvedStackTarget[];
  connection: ConnectionInfo;
  lock: LockHandle;
  runId: string;
  state: MutableStateContext;
  required: Map<StackKey, string[]>;
}

interface PreparedPlan {
  detection: DetectionResult;
  analyses: Map<StackKey, TemplateAnalysis>;
  graphs: Map<string, RegionGraph>;
  mergedGraphs: Map<string, RegionGraph>;
  plan: ExecutionPlan;
  redactors: Map<StackKey, TextRedactor>;
  /** FR-5-19h: スタックを特定できない実行全体の診断へ適用する全対象 redactor。 */
  globalRedactor: TextRedactor;
  parsedTemplates: Map<string, unknown>;
  /** FR-6-8: 削除待ちのスタックキー → 統合グラフへ解決できなかった明示依存。 */
  unresolvedPendingDependsOn: Map<StackKey, string[]>;
}

interface OperationResult {
  hasDiff: boolean;
  /** 対象だけを fail-closed に拒否し、独立した他対象は継続できる検証エラー。 */
  failed?: boolean;
}

/** Phase A の結果。承認後(Phase B)に実行する副作用があれば `pending` に載せる。 */
interface PhaseAResult {
  hasDiff: boolean;
  pending?: PendingAction;
}

/**
 * FR-5-12c / design §5.3.3: Phase A が AWS 上に作成し、まだ実行も削除もしていない自変更セット。
 * `CreateChangeSet` が ARN を返した**直後**に登録し、削除できた時点・`ExecuteChangeSet` の
 * 送信を試みた時点で外す。これにより「作成済みなのに回収されない変更セット」を作らない。
 */
interface CreatedChangeSet {
  operation: PlannedOperation;
  /** fencing 付き gateway。回収の副作用もこれを経由する。 */
  cfn: CloudFormationGateway;
  stackName: string;
  name: string;
  id: string;
}

/** 承認後に `ExecuteChangeSet` するために Phase A が保持した変更セット(FR-5-5a)。 */
interface PendingChangeSetExecution {
  kind: 'execute';
  operation: PlannedOperation;
  target: ResolvedStackTarget;
  entry: DetectedEntry;
  analysis: TemplateAnalysis;
  /** fencing 付き gateway。Phase B の副作用もこれを経由する。 */
  cfn: CloudFormationGateway;
  executor: ExecutorContext;
  changeSetKind: 'create' | 'update';
  /** Phase A が作成した自変更セット(回収集合の同一エントリを共有する)。 */
  changeSet: CreatedChangeSet;
  /**
   * FR-5-17b / FR-5-17c2: 実行直前に照合する対象スタックの不変 ARN。
   * `update` は state の記録、`create` は `CreateChangeSet` が作った
   * `REVIEW_IN_PROGRESS` の殻の ARN。いずれも Phase A で確定できなければ fail-closed。
   */
  expectedStackId: string;
}

/** 承認後に `DeleteStack` する削除対象(FR-5-5a)。 */
interface PendingStackDeletion {
  kind: 'delete';
  operation: PlannedOperation;
  /** 通常エントリと削除待ちの共通部分だけを削除の安全装置へ渡す(FR-6-7)。 */
  record: DeletableStackRecord;
  diff: StackDiff;
  cfn: CloudFormationGateway;
  /**
   * FR-1-20 / FR-6-7: 削除成功時に除去する削除待ちの ID。
   * リネーム対の旧スタック削除と、過去実行から積み残された削除待ちの双方で設定する。
   * undefined の場合だけ `stacks` のエントリを除去する。
   */
  pendingDeletionId?: string;
  /** FR-6-9: リネーム対の旧スタック削除では、対の create の成功記録を実行直前に確認する。 */
  requiresPairedCreate: boolean;
  /** FR-6-8: 統合依存グラフへ解決できなかった明示依存(1 件でもあれば削除を拒否する)。 */
  unresolvedDependsOn?: string[];
}

type PendingAction = PendingChangeSetExecution | PendingStackDeletion;

/** FR-5-17c1: 承認待ちを挟んだ後に UPDATE を実行してよい終端ステータスの allowlist。 */
const UPDATE_EXECUTABLE_STATUSES = new Set([
  'CREATE_COMPLETE',
  'UPDATE_COMPLETE',
  'UPDATE_ROLLBACK_COMPLETE',
  'IMPORT_COMPLETE',
  'IMPORT_ROLLBACK_COMPLETE',
]);

/** ExecuteChangeSet 後に観測した構造化 rollback 情報を report 境界まで保持する。 */
class StackExecutionFailure extends StackStateError {
  constructor(
    message: string,
    readonly rolledBack: boolean,
    context: { stackKey?: string; region?: string; cause?: unknown } = {},
  ) {
    super(message, context);
  }
}

// ===========================================================================
// deploy 公開入口
// ===========================================================================

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
        '承認手段が与えられていないため deploy を実行できません。' +
          '非対話環境では --auto-approve を指定するか、cfnsync plan で差分確認だけを行ってください',
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
      entry.stackKey,
      entry.target.region,
      'no-change',
      '変更なし(検知済み)',
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
          operation.stackKey,
          operation.region,
          'skipped',
          '計画段階の失敗により実行全体を中断しました',
        );
        continue;
      }
      const failure = resultForOperation(operation, 'failed');
      failure.errorMessage = message;
      failure.rolledBack = false;
      resultByOperation.set(operation, failure);
      emitProgress(
        ctx.deps,
        operation.stackKey,
        operation.region,
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
        operation.stackKey,
        operation.region,
        'skipped',
        '依存関係の失敗によりスキップしました',
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
        operation.stackKey,
        operation.region,
        'failed',
        failure.errorMessage ?? '失敗しました',
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
      '計画段階の失敗により実行全体を中断しました',
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
        '承認手段が与えられていないため実行できません。--auto-approve を指定してください',
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
        errorMessage: `承認処理に失敗しました: ${prepared.globalRedactor(
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
          action.operation.stackKey,
          action.operation.region,
          'skipped',
          '承認処理に失敗したため実行しませんでした',
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
          action.operation.stackKey,
          action.operation.region,
          'skipped',
          '承認が得られなかったため実行しませんでした',
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
        operation.stackKey,
        operation.region,
        'skipped',
        '依存関係の失敗によりスキップしました',
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
        operation.stackKey,
        operation.region,
        'failed',
        failure.errorMessage ?? '失敗しました',
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
      ? 'ロックの所有権を失ったため以降の処理を中断しました'
      : '依存関係の失敗によりスキップしました',
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

/**
 * FR-11-10b / FR-6: 同一の (リージョン, スタック名) を指す操作の組を、AWS への
 * 副作用より前に fail-closed で拒否する。削除側は「現に管理対象である物理スタック」
 * との衝突(テンプレートのパス変更等)も対象とする。いずれも delete 同士や
 * 異なる物理スタックは拒否しない(FR-11-10c)。
 */
function findPhysicalStackConflicts(
  ctx: LockedRunContext,
  plan: ExecutionPlan,
): Map<StackKey, string> {
  const failures = new Map<StackKey, string>();
  const targetByPhysicalId = new Map<string, ResolvedStackTarget>();
  for (const target of ctx.targets) {
    targetByPhysicalId.set(physicalId(target.region, target.stackName), target);
  }

  const mutationByPhysicalId = new Map<string, PlannedOperation>();
  for (const operation of plan.index.flattened) {
    if (operation.kind === 'delete') {
      const pending = operation.entry.pendingDeletion;
      if (pending !== undefined) {
        // FR-6-10: 削除待ちの物理スタックを設定由来の create / update が指す構成
        // (リネームを元に戻した等)は、AWS 副作用の前に fail-closed で拒否する。
        const conflicting = targetByPhysicalId.get(
          physicalId(operation.region, pending.entry.stackName),
        );
        if (conflicting === undefined) continue;
        failures.set(
          operation.stackKey,
          `スタック '${pending.entry.stackName}'(${operation.region})は削除待ちですが、` +
            `設定の '${conflicting.stackKey}' が同一の物理スタックを作成/更新しようとしています。` +
            `AWS への副作用を行わず中断します。先に cfnsync deploy --allow-delete で削除待ちを` +
            `解消するか、別のスタック名へ変更してください`,
        );
        continue;
      }
      const stateEntry = operation.entry.stateEntry;
      // リネーム(同一スタックキーで stackName 変更)の削除は旧名を指すため衝突しない。
      if (!stateEntry || operation.entry.renamedTo !== undefined) continue;
      const surviving = targetByPhysicalId.get(
        physicalId(operation.region, stateEntry.stackName),
      );
      if (surviving === undefined || surviving.stackKey === operation.stackKey)
        continue;
      failures.set(
        operation.stackKey,
        `スタック '${stateEntry.stackName}'(${operation.region})は別のテンプレートパス ` +
          `'${surviving.stackKey}' で現在も管理対象です。同一物理スタックを指す削除と作成/更新が` +
          `同一実行に含まれるため、AWS への副作用を行わず中断します。` +
          `テンプレートのパス変更(リネーム)は state 移行で扱ってください`,
      );
      continue;
    }

    const target = operation.entry.target;
    if (!target) continue;
    const key = physicalId(operation.region, target.stackName);
    const previous = mutationByPhysicalId.get(key);
    if (previous !== undefined) {
      const message =
        `スタック '${target.stackName}'(${operation.region})を ` +
        `'${previous.stackKey}' と '${operation.stackKey}' の 2 つが作成/更新しようとしています。` +
        `同一物理スタックへの二重操作を避けるため、AWS への副作用を行わず中断します`;
      failures.set(previous.stackKey, message);
      failures.set(operation.stackKey, message);
      continue;
    }
    mutationByPhysicalId.set(key, operation);
  }

  return failures;
}

/**
 * §8.3 / FR-6-5: 依存メタデータが unknown / incomplete で provider を特定できない
 * 削除対象のスタックキー。1 件でもあれば、同じ削除バッチの他対象は副作用前に止める。
 */
function findUnsafeDeleteKeys(
  ctx: LockedRunContext,
  prepared: PreparedPlan,
): Set<StackKey> {
  if (!ctx.options.allowDelete || ctx.options.dryRun) return new Set();
  return new Set(
    prepared.plan.index.flattened
      .filter(
        (operation) =>
          operation.kind === 'delete' &&
          (hasUnsafeDependencyMetadata(deletableRecord(operation.entry)) ||
            // FR-6-8: 削除待ちの明示依存を統合グラフへ解決できない場合も
            // provider を特定できないため、同じ削除バッチを副作用前に止める。
            prepared.unresolvedPendingDependsOn.has(operation.stackKey)),
      )
      .map((operation) => operation.stackKey),
  );
}

/** FR-6-7: 削除の安全装置へ渡す記録を、通常エントリ・削除待ちのどちらからでも解決する。 */
function deletableRecord(
  entry: DetectedEntry,
): DeletableStackRecord | undefined {
  return entry.stateEntry ?? entry.pendingDeletion?.entry;
}

/** まだ結果の付いていない計画上の操作を skipped として記録する。 */
function markUnprocessedAsSkipped(
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
      operation.stackKey,
      operation.region,
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
async function cleanupCreatedChangeSets(
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
          publicErrorMessage(error, '変更セットの削除に失敗しました'),
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
      `事前作成した変更セットの削除に失敗しました: ${failures.join(' / ')}。` +
      `残存した変更セットは次回実行の残存回収で回収されます`,
    rolledBack: false,
  });
  return true;
}

function prepareExecutionPlan(ctx: LockedRunContext): PreparedPlan {
  const analyses = new Map<StackKey, TemplateAnalysis>();
  const redactors = new Map<StackKey, TextRedactor>();
  // FR-5-19h: スタック別 redactor の単純な順次適用は、秘密値に包含関係があると
  // 短い値の先行置換で長い値の suffix を残しうる。全対象の値を一度に渡し、
  // createNoEchoRedactor の長さ降順置換でまとめてマスクする。
  const globalNoEchoValues: Record<string, string> = {};
  const globalNoEchoNames: string[] = [];
  let globalNoEchoIndex = 0;
  const parsedTemplates = new Map<string, unknown>();
  const staticAnalyses = new Map<string, StaticTemplateAnalysis>();
  const templateHashes = new Map<string, string>();
  const currentNodes: StackNode[] = [];
  for (const target of ctx.targets) {
    const source = requiredTemplate(ctx.templates, target.templatePath);
    let parsed = parsedTemplates.get(target.templatePath);
    if (!parsedTemplates.has(target.templatePath)) {
      parsed = parseCfnTemplate(source);
      parsedTemplates.set(target.templatePath, parsed);
      staticAnalyses.set(target.templatePath, analyzeStaticTemplate(parsed));
      templateHashes.set(target.templatePath, computeTemplateHash(source));
    }
    const staticAnalysis = staticAnalyses.get(target.templatePath);
    if (staticAnalysis === undefined) {
      throw new InvariantError(
        `テンプレートの静的解析結果がありません: ${target.templatePath}`,
        { stackKey: target.stackKey, region: target.region },
      );
    }
    const analysis = resolveStaticTemplateAnalysis(staticAnalysis, {
      stackName: target.stackName,
      region: target.region,
      parameters: target.parameters,
    });
    analyses.set(target.stackKey, analysis);
    const templateDefaults = extractScalarParameterDefaults(parsed);
    redactors.set(
      target.stackKey,
      createNoEchoRedactor(
        target.parameters,
        analysis.noEchoParams,
        templateDefaults,
      ),
    );
    for (const parameterName of analysis.noEchoParams) {
      const value =
        target.parameters[parameterName] ?? templateDefaults[parameterName];
      if (value === undefined) continue;
      const globalName = `${globalNoEchoIndex}:${parameterName}`;
      globalNoEchoIndex += 1;
      globalNoEchoNames.push(globalName);
      globalNoEchoValues[globalName] = value;
    }
    currentNodes.push({
      stackKey: target.stackKey,
      region: target.region,
      exports: analysis.exports,
      imports: analysis.imports,
      explicitDependsOn: target.dependsOn,
    });
  }

  const detection = detectChanges({
    targets: ctx.targets,
    templates: ctx.templates,
    state: ctx.state.state,
    templateHashes,
  });
  // __REQUIRED__ の対象だけを実行計画から外す。target 自体は current graph に残し、
  // 他スタックを誤って deleted 扱いしたり依存辺を消したりしない。
  const executableDetection: DetectionResult = {
    entries: detection.entries.filter(
      (entry) => !ctx.required.has(entry.stackKey),
    ),
  };

  const graphs = buildGraphs(currentNodes);
  const oldNodes: StackNode[] = Object.entries(ctx.state.state.stacks).map(
    ([stackKey, entry]) => ({
      stackKey,
      region: entry.region,
      // FR-6-5: 欠落は delete usecase が対象だけ拒否する。ここでは安全な空辺として計画に残す。
      exports: Array.isArray(entry.exports) ? entry.exports : [],
      imports: Array.isArray(entry.imports) ? entry.imports : [],
      explicitDependsOn: Array.isArray(entry.dependsOn) ? entry.dependsOn : [],
    }),
  );
  // FR-6-8: 削除待ちも統合グラフのノードとして復元し、削除順序(逆トポロジカル順)へ載せる。
  // これを省くと buildPlan の順序付けで削除待ちの操作が取りこぼされる。
  const unresolvedPendingDependsOn = new Map<StackKey, string[]>();
  const knownNodeKeys = new Set([
    ...currentNodes.map((node) => node.stackKey),
    ...oldNodes.map((node) => node.stackKey),
  ]);
  for (const entry of detection.entries) {
    const pending = entry.pendingDeletion;
    if (pending === undefined) continue;
    const recorded = Array.isArray(pending.entry.dependsOn)
      ? pending.entry.dependsOn
      : [];
    // 解決できない明示依存は「安全な削除順を復元できない」証拠として記録し、
    // buildGraphs が ConfigError で実行全体を落とさないよう辺からは外す(FR-6-5)。
    const unresolved = recorded.filter((key) => !knownNodeKeys.has(key));
    if (unresolved.length > 0)
      unresolvedPendingDependsOn.set(entry.stackKey, unresolved);
    oldNodes.push({
      stackKey: entry.stackKey,
      region: pending.entry.region,
      exports: Array.isArray(pending.entry.exports)
        ? pending.entry.exports
        : [],
      imports: Array.isArray(pending.entry.imports)
        ? pending.entry.imports
        : [],
      explicitDependsOn: unresolved.length > 0 ? [] : recorded,
    });
  }
  const oldGraphs = buildGraphs(oldNodes);
  const mergedGraphs = mergeGraphMaps(graphs, oldGraphs);
  const regionOrder = unique(ctx.targets.map((target) => target.region));
  const plan = buildPlan({
    detection: executableDetection,
    graphs,
    mergedGraphs,
    regionOrder,
  });
  return {
    detection,
    analyses,
    graphs,
    mergedGraphs,
    plan,
    redactors,
    globalRedactor: createNoEchoRedactor(globalNoEchoValues, globalNoEchoNames),
    parsedTemplates,
    unresolvedPendingDependsOn,
  };
}

// ===========================================================================
// 1 スタックの処理
// ===========================================================================

/**
 * Phase A(承認前): 変更セットを作成して差分を確定させるところまで行う。
 * `ExecuteChangeSet` / `DeleteStack` は行わず、作成した変更セットは**削除せず保持**して
 * `PendingAction` として返す(FR-5-5a)。ステート保存は FR-5-5b の再同期に限る。
 */
async function planCreateOrUpdate(
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
      `内部エラー: ${operation.stackKey} の target がありません`,
      { stackKey: operation.stackKey, region: operation.region },
    );
  const source = requiredTemplate(ctx.templates, target.templatePath);
  const analysis = prepared.analyses.get(operation.stackKey);
  if (!analysis)
    throw new InvariantError(
      `内部エラー: ${operation.stackKey} のテンプレート解析結果がありません`,
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
          `スタック '${target.stackName}' は ROLLBACK_COMPLETE 状態です。削除してから再実行してください`,
          { stackKey: target.stackKey, region: target.region },
        );
      }
      if (existing.status.endsWith('_IN_PROGRESS')) {
        throw new StackStateError(
          `スタック '${target.stackName}' は ${existing.status} 状態です。進行中操作の完了後に再実行してください`,
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
    operation.stackKey,
    operation.region,
    'changeset-create-start',
    '変更セットを作成しています',
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
      `内部エラー: ${operation.stackKey} の作成済み変更セットを追跡できていません`,
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
      operation.stackKey,
      operation.region,
      'no-change',
      '変更セットが空のため変更なしとして扱います',
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
    operation.stackKey,
    operation.region,
    'diff-ready',
    `差分を確定しました(リソース ${diff.resources.length} 件)`,
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
      `スタック '${target.stackName}' の stackId(ARN) を確定できないため、` +
        `承認後の実行直前再検査で対象スタックの同一性を照合できません。実行せず中断します`,
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
        `スタック '${target.stackName}' の stackId(ARN) が承認前と一致しません。` +
          `同名スタックが差し替えられた可能性があるため実行を中止します。cfnsync import を実行してください`,
        context,
      );
    }
    // FR-5-17c1: 実行可能な終端状態の allowlist。
    if (!UPDATE_EXECUTABLE_STATUSES.has(summary.status)) {
      throw new StackStateError(
        `スタック '${target.stackName}' は承認後に ${summary.status} へ遷移しました。` +
          `実行可能な状態(${[...UPDATE_EXECUTABLE_STATUSES].join(' / ')})ではないため実行を中止します`,
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
      `スタック '${target.stackName}' は承認後に ${summary.status} で実在しています。` +
        `CREATE 対象として期待する状態(未作成または REVIEW_IN_PROGRESS)ではないため実行を中止します`,
      context,
    );
  }
  if (summary.stackId !== action.expectedStackId) {
    throw new StackStateError(
      `スタック '${target.stackName}' の REVIEW_IN_PROGRESS の殻が、承認前に自身の変更セットを` +
        `作成した殻(stackId が一致しない)ではありません。同名スタックが差し替えられた可能性が` +
        `あるため実行を中止します。cfnsync import を実行してください`,
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
async function executeApprovedChangeSet(
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
    operation.stackKey,
    operation.region,
    'execute-start',
    '変更セットを実行しています',
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
          'CloudFormation スタックの完了待機に失敗しました',
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
      `スタック '${target.stackName}' の成功結果に stackId(ARN) がありません。state を更新せず import/移行を要求します`,
      { stackKey: target.stackKey, region: target.region },
    );
  }
  if (
    action.changeSetKind === 'update' &&
    action.entry.stateEntry?.stackId !== final.stackId
  ) {
    throw new StackStateError(
      `スタック '${target.stackName}' の stackId(ARN) が UPDATE 中に変化しました。state を更新せず cfnsync import を案内します`,
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
    operation.stackKey,
    operation.region,
    'done',
    'デプロイが完了しました',
  );
  return { hasDiff: true };
}

/**
 * Phase A(承認前)の削除計画。`DescribeStacks` で実在を確認し、削除プレビューを差分へ積む。
 * 実スタックが既に存在しない場合の再同期(FR-5-5b2)だけは承認前に保存してよい。
 * `DeleteStack` は行わず `PendingAction` として返す。
 */
async function planDeletion(
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
      `内部エラー: ${operation.stackKey} の削除対象の記録がありません`,
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
      `リネーム前の旧スタックが未削除のため削除待ちです(元のスタックキー: ${detectedPending.entry.originStackKey})`,
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
    resultByOperation.set(operation, {
      stackKey: operation.stackKey,
      region: operation.region,
      stackName: record.stackName,
      outcome: 'succeeded',
    });
    emitProgress(
      ctx.deps,
      operation.stackKey,
      operation.region,
      'done',
      'スタックは既に存在しないため削除済みとして同期しました',
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
      const message = '削除対象です。実削除には --allow-delete が必要です';
      diff.warnings.push(message);
      emitProgress(
        ctx.deps,
        operation.stackKey,
        operation.region,
        'skipped',
        message,
      );
    }
    resultByOperation.set(operation, {
      stackKey: operation.stackKey,
      region: operation.region,
      stackName: record.stackName,
      outcome: 'skipped',
    });
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
async function deleteApprovedStack(
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
      `スタック '${record.stackName}' はリネーム対の旧スタックですが、` +
      `対となる新スタックの作成成功が state に記録されていません。` +
      `旧スタックだけを削除しないため DeleteStack を拒否します`;
    diff.warnings.push(message);
    resultByOperation.set(operation, {
      stackKey: operation.stackKey,
      region: operation.region,
      stackName: record.stackName,
      outcome: 'failed',
      errorMessage: message,
      rolledBack: false,
    });
    emitProgress(
      ctx.deps,
      operation.stackKey,
      operation.region,
      'failed',
      message,
    );
    return { hasDiff: true, failed: true };
  }

  emitProgress(
    ctx.deps,
    operation.stackKey,
    operation.region,
    'delete-start',
    'スタックを削除しています',
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
      deleted.errorMessage ?? '安全装置により削除を拒否しました',
    );
    resultByOperation.set(operation, {
      stackKey: operation.stackKey,
      region: operation.region,
      stackName: record.stackName,
      outcome: 'failed',
      errorMessage: deleted.errorMessage ?? '安全装置により削除を拒否しました',
      rolledBack: false,
    });
    emitProgress(
      ctx.deps,
      operation.stackKey,
      operation.region,
      'failed',
      deleted.errorMessage ?? '安全装置により削除を拒否しました',
    );
    return { hasDiff: true, failed: true };
  }

  ctx.state.state = deleted.state;
  ctx.state.version = deleted.version;
  resultByOperation.set(operation, {
    stackKey: operation.stackKey,
    region: operation.region,
    stackName: record.stackName,
    outcome: 'succeeded',
  });
  emitProgress(
    ctx.deps,
    operation.stackKey,
    operation.region,
    'done',
    'スタックを削除しました',
  );
  return { hasDiff: true };
}

// ===========================================================================
// 復旧・state 保存
// ===========================================================================

async function recoverExistingCreate(
  ctx: LockedRunContext,
  target: ResolvedStackTarget,
  source: string,
  desiredParsed: unknown,
  analysis: TemplateAnalysis,
  templateHash: string | undefined,
  inputsHash: string | undefined,
  /** FR-1-18: リネームの新名側なら、再同期と同一 CAS で旧名の削除待ちを記録する。 */
  renamedFrom: DetectedEntry['renamedFrom'],
  existing: NonNullable<
    Awaited<ReturnType<CloudFormationGateway['describeStack']>>
  >,
  cfn: CloudFormationGateway,
  report: DeployReport,
  reconciliations: ReconciliationRecord[],
): Promise<void> {
  // FR-5-5b4: 管理タグは「自ステート由来」であることしか証明せず、どの入力で作成された
  // かは証明しない。NoEcho の実値と dependsOn は AWS 側と照合できないため、これらが
  // 存在する対象を「事実確認済み」として再同期すると、未適用の希望値を適用済みとして
  // 記録し変更が失われる(虚偽収束)。入力同一性を証明できない場合は fail-closed とする。
  const unverifiable: string[] = [];
  if (analysis.noEchoParams.length > 0) {
    unverifiable.push(
      `NoEcho パラメータ(${analysis.noEchoParams.join(', ')})の実値は AWS から取得できません`,
    );
  }
  if (target.dependsOn.length > 0) {
    unverifiable.push(
      `明示 dependsOn(${target.dependsOn.join(', ')})は実スタックと照合できません`,
    );
  }
  if (unverifiable.length > 0) {
    throw new StackStateError(
      `同名スタック '${target.stackName}' の入力同一性を証明できないため、再同期を拒否します(fail-closed)。` +
        `${unverifiable.join(' / ')}。` +
        `復旧手順: 設定ファイルを退避 → cfnsync import --reconcile local を実行 → ` +
        `import が __REQUIRED__ へ書き換えた NoEcho パラメータを退避した希望値へ戻す → ` +
        `cfnsync plan で差分を確認して deploy`,
      { stackKey: target.stackKey, region: target.region },
    );
  }

  const deployedTemplate = await cfn.getTemplate(target.stackName, 'Original');
  const stateId = ctx.deps.backend.stateId();
  const desiredTags = { ...target.tags, [MANAGEMENT_TAG_KEY]: stateId };

  let templateMatches: boolean;
  let templateDefaults: Record<string, string>;
  try {
    const parsedDesired = desiredParsed ?? parseCfnTemplate(source);
    templateDefaults = extractParameterDefaults(parsedDesired);
    templateMatches = parsedTemplatesEquivalent(
      parsedDesired,
      parseCfnTemplate(deployedTemplate),
    );
  } catch (cause) {
    throw new StackStateError(
      `同名スタック '${target.stackName}' のテンプレート同値性または Parameter Default を検証できません(fail-closed)。` +
        `cfnsync import を実行してください`,
      { stackKey: target.stackKey, region: target.region, cause },
    );
  }
  const verifiableDesiredParameters = omitKeys(
    { ...templateDefaults, ...target.parameters },
    analysis.noEchoParams,
  );
  const verifiableActualParameters = omitKeys(
    existing.parameters,
    analysis.noEchoParams,
  );

  const matches =
    existing.tags[MANAGEMENT_TAG_KEY] === stateId &&
    templateMatches &&
    recordsEqual(verifiableDesiredParameters, verifiableActualParameters) &&
    recordsEqual(desiredTags, existing.tags) &&
    arraysEqual(target.capabilities, existing.capabilities);

  if (!matches) {
    throw new StackStateError(
      `同名スタック '${target.stackName}' はローカル希望値または管理タグと完全一致しません(fail-closed)。` +
        `命名衝突の可能性があるため cfnsync import を実行してください`,
      { stackKey: target.stackKey, region: target.region },
    );
  }

  const diff = buildStackDiff({
    stackKey: target.stackKey,
    region: target.region,
    stackName: target.stackName,
    operation: 'no-change',
    noEchoParams: analysis.noEchoParams,
  });
  // FR-5-5b3: ここへ到達するのは NoEcho も dependsOn も持たない対象だけであり、
  // inputsHash の全構成要素を AWS 側と照合できている(比較から除外した項目はない)。
  diff.warnings.push(...analysis.warnings);
  report.diffs.push(diff);

  if (!templateHash || !inputsHash) {
    throw new InvariantError(
      `内部エラー: ${target.stackKey} の hash がありません`,
      { stackKey: target.stackKey, region: target.region },
    );
  }
  const entry: DetectedEntry = {
    stackKey: target.stackKey,
    changeType: 'added',
    target,
    templateHash,
    inputsHash,
    // FR-1-18: 再同期は同一スタックキーを新スタック名で上書きするため、
    // 旧スタック名の削除待ちを同じ保存に含めないと追跡が失われる(Issue #16)。
    ...(renamedFrom ? { renamedFrom } : {}),
  };
  await saveSuccessfulEntry(ctx, entry, analysis, 'SYNC', existing.stackId);
  reconciliations.push({
    stackKey: target.stackKey,
    region: target.region,
    kind: 'create-recovery',
    stateUpdated: true,
  });
  emitProgress(
    ctx.deps,
    target.stackKey,
    target.region,
    'no-change',
    'CREATE 復旧により変更なしとして再同期しました',
  );
}

async function saveSuccessfulEntry(
  ctx: LockedRunContext,
  detected: DetectedEntry,
  analysis: TemplateAnalysis,
  lastAction: StackEntry['lastAction'],
  stackId: string,
): Promise<void> {
  const target = detected.target;
  if (!target || !detected.templateHash || !detected.inputsHash) {
    throw new InvariantError(
      `内部エラー: ${detected.stackKey} の成功 state 入力が不足しています`,
      { stackKey: detected.stackKey },
    );
  }
  if (!stackId) {
    throw new StackStateError(
      `スタック '${target.stackName}' の stackId(ARN) を確認できないため成功 state を保存できません。cfnsync import を実行してください`,
    );
  }
  const entry: StackEntry = {
    stackName: target.stackName,
    stackId,
    region: target.region,
    templateHash: detected.templateHash,
    inputsHash: detected.inputsHash,
    exports: analysis.exports,
    imports: analysis.imports,
    dependsOn: target.dependsOn.map((raw) =>
      resolveDependsOnKey(raw, target.region),
    ),
    dependencyAnalysisIncomplete:
      analysis.warnings.length > 0 && target.dependsOn.length === 0,
    lastAction,
    lastSuccessAt: now(ctx.deps).toISOString(),
  };
  // FR-1-18: リネームの新スタック名を保存する場合、旧スタック名の削除待ちを
  // **同一の保存ペイロード(単一の compare-and-swap)**へ含める。2 回の保存へ分けると、
  // その間の中断で旧スタック名が state から脱落する(Issue #16)。
  const next = upsertStackEntry(ctx.state.state, detected.stackKey, entry);
  await saveState(
    ctx,
    detected.renamedFrom === undefined
      ? next
      : upsertPendingDeletion(
          next,
          pendingDeletionId(target.region, detected.renamedFrom.oldStackName),
          pendingDeletionFor(detected.renamedFrom, detected.stackKey, ctx),
        ),
  );
}

/** FR-1-16 / FR-1-18: リネーム元の旧ステートエントリから削除待ちの記録を作る。 */
function pendingDeletionFor(
  renamedFrom: NonNullable<DetectedEntry['renamedFrom']>,
  stackKey: StackKey,
  ctx: LockedRunContext,
): PendingDeletionEntry {
  const old = renamedFrom.oldEntry;
  return {
    stackName: renamedFrom.oldStackName,
    stackId: old.stackId,
    region: old.region,
    exports: Array.isArray(old.exports) ? old.exports : [],
    imports: Array.isArray(old.imports) ? old.imports : [],
    dependsOn: Array.isArray(old.dependsOn) ? old.dependsOn : null,
    dependencyAnalysisIncomplete: old.dependencyAnalysisIncomplete,
    originStackKey: stackKey,
    reason: 'rename',
    recordedAt: now(ctx.deps).toISOString(),
  };
}

async function saveState(
  ctx: LockedRunContext,
  next: CfnSyncState,
): Promise<void> {
  await assertFenced(ctx.deps.backend, ctx.lock);
  const payload = prepareSave(next);
  let version: StateVersion;
  try {
    version = await ctx.deps.backend.save(payload, ctx.state.version);
  } catch (cause) {
    throw new StatePersistenceError(
      'ステートの CAS 保存に失敗したため、以降の処理を中断します',
      { cause },
    );
  }
  ctx.state.state = payload;
  ctx.state.version = version;
}

// ===========================================================================
// 補助
// ===========================================================================

async function requireManagedStackIdentity(
  cfn: CloudFormationGateway,
  target: ResolvedStackTarget,
  stateEntry: StackEntry | undefined,
): Promise<
  NonNullable<Awaited<ReturnType<CloudFormationGateway['describeStack']>>>
> {
  if (!stateEntry?.stackId) {
    throw new StackStateError(
      `スタック '${target.stackName}' の state に stackId(ARN) が記録されていません。自動 UPDATE を拒否します。cfnsync import または state 移行を実行してください`,
      { stackKey: target.stackKey, region: target.region },
    );
  }
  const summary = await cfn.describeStack(target.stackName);
  if (!summary || summary.stackId !== stateEntry.stackId) {
    throw new StackStateError(
      `スタック '${target.stackName}' の stackId(ARN) が state と一致しません。同名スタックが差し替えられた可能性があるため自動 UPDATE を拒否します。cfnsync import を実行してください`,
      { stackKey: target.stackKey, region: target.region },
    );
  }
  return summary;
}

function hasUnsafeDependencyMetadata(
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

async function requireExistingStackId(
  cfn: CloudFormationGateway,
  target: ResolvedStackTarget,
): Promise<string> {
  const summary = await cfn.describeStack(target.stackName);
  if (!summary?.stackId) {
    throw new StackStateError(
      `スタック '${target.stackName}' の stackId(ARN) を確認できません。成功 state を保存せず cfnsync import を案内します`,
      { stackKey: target.stackKey, region: target.region },
    );
  }
  return summary.stackId;
}

function mergeGraphMaps(
  current: Map<string, RegionGraph>,
  old: Map<string, RegionGraph>,
): Map<string, RegionGraph> {
  const merged = new Map<string, RegionGraph>();
  for (const region of unique([...current.keys(), ...old.keys()])) {
    const currentGraph = current.get(region) ?? {
      region,
      nodes: [],
      edges: [],
    };
    const oldGraph = old.get(region) ?? { region, nodes: [], edges: [] };
    merged.set(region, mergeGraphs(currentGraph, oldGraph));
  }
  return merged;
}

function requiredTemplate(
  templates: Map<string, string>,
  path: string,
): string {
  const source = templates.get(path);
  if (source === undefined)
    throw new ConfigError(`テンプレート内容が見つかりません: ${path}`, {
      stackKey: path,
    });
  return source;
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

function now(deps: DeployDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

/** 同一リージョン内で物理スタックを一意に識別するキー(stackName が物理識別子)。 */
function physicalId(region: string, stackName: string): string {
  return `${region}\u0000${stackName}`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function omitKeys(
  record: Record<string, string>,
  keys: string[],
): Record<string, string> {
  const excluded = new Set(keys);
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !excluded.has(key)),
  );
}

function recordsEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const aEntries = Object.entries(a).sort(([aKey], [bKey]) =>
    aKey.localeCompare(bKey),
  );
  const bEntries = Object.entries(b).sort(([aKey], [bKey]) =>
    aKey.localeCompare(bKey),
  );
  return JSON.stringify(aEntries) === JSON.stringify(bEntries);
}

function arraysEqual(a: string[], b: string[]): boolean {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

/**
 * FR-5-4: 進捗マイルストーンを onProgress へ fire-and-forget で通知する。
 * 純粋に観測用であり、exitCode / hasDiff / スキップ判定など制御フローには一切影響しない。
 * message は cfnsync 由来の静的文字列か、'failed' 段階に限り report の errorMessage に
 * 格納するのと同一の redactor 適用済み文字列(NFR-4)であること。
 */
function emitProgress(
  deps: DeployDeps,
  stackKey: string,
  region: string,
  phase: ProgressPhase,
  message: string,
): void {
  try {
    deps.onProgress?.({ stackKey, region, phase, message });
  } catch {
    // ProgressEvent は観測専用ポートであり、stderr 等の配送障害によって
    // AWS 操作・クリーンアップ・最終 report の制御フローを置換させない。
  }
}

function stackResult(
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

function resultForOperation(
  operation: PlannedOperation,
  outcome: StackResult['outcome'],
): StackResult {
  const target = operation.entry.target;
  const stateEntry = operation.entry.stateEntry;
  return {
    stackKey: operation.stackKey,
    region: operation.region,
    stackName: target?.stackName ?? stateEntry?.stackName ?? operation.stackKey,
    outcome,
  };
}

function failedOperationResult(
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

function requiredResults(
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
      errorMessage: `必須パラメータに __REQUIRED__ が残っています: ${names.join(', ')}`,
      rolledBack: false,
    };
  });
}

function failedBeforeLock(
  connection: ConnectionInfo,
  required: Map<StackKey, string[]>,
  targets: ResolvedStackTarget[],
  error: unknown,
): DeployResult {
  return failureResult(connection, requiredResults(required, targets), error);
}

function failureResult(
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

function appendDeployFailure(
  result: DeployResult,
  error: unknown,
): DeployResult {
  const stacks = result.report.result?.stacks ?? [];
  stacks.push({
    stackKey: '(deploy)',
    region: result.report.connection.regions[0] ?? '(none)',
    stackName: '(deploy)',
    outcome: 'failed',
    errorMessage: `ロック解放に失敗しました: ${publicErrorMessage(error)}`,
    rolledBack: false,
  });
  result.report.result = { stacks };
  result.exitCode = 1;
  return result;
}

function publicErrorMessage(
  error: unknown,
  fallback = '予期しないエラーが発生しました',
): string {
  return error instanceof CfnSyncError ? error.publicMessage : fallback;
}
