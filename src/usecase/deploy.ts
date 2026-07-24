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
  prepareSave,
  removeStackEntry,
  type StackEntry,
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
  buildStackDiff,
  type ConnectionInfo,
  type DeployReport,
  type ProgressEvent,
  type ProgressPhase,
  redactReportMessages,
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
}

export interface DeployOptions {
  dryRun?: boolean;
  allowDelete?: boolean;
  onFailure?: 'stop' | 'continue';
  /** JSON 出力など、最終 report にイベント列を含める場合だけ true。既定 true。 */
  collectEvents?: boolean;
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
  parsedTemplates: Map<string, unknown>;
}

interface OperationResult {
  hasDiff: boolean;
  /** 対象だけを fail-closed に拒否し、独立した他対象は継続できる検証エラー。 */
  failed?: boolean;
}

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

async function runLocked(ctx: LockedRunContext): Promise<DeployResult> {
  const prepared = prepareExecutionPlan(ctx);

  // deleted の旧リージョンも含め、実計画で触れる全リージョンを AWS 読み取り前に再照合する。
  const plannedRegions = prepared.plan.regions.map((region) => region.region);
  assertRegionsAllowed(ctx.config, plannedRegions);
  ctx.connection.regions = unique([
    ...ctx.connection.regions,
    ...plannedRegions,
  ]);

  // 同一物理スタック(同一リージョン内では stackName が物理的な一意識別子)を
  // 現在も管理し続ける対象の集合。パス変更や別テンプレートによる衝突で、
  // まだ管理対象のスタックが `deleted` 側から削除されるのを防ぐ(fail-closed)。
  const survivingPhysicalIds = new Set<string>();
  for (const target of ctx.targets) {
    survivingPhysicalIds.add(physicalId(target.region, target.stackName));
  }

  const resultStacks = requiredResults(ctx.required, ctx.targets);
  const report: DeployReport = {
    connection: ctx.connection,
    diffs: [],
    ...(ctx.options.collectEvents !== false ? { events: [] } : {}),
    result: { stacks: resultStacks },
  };
  const results = resultStacks;
  let hasDiff = false;
  let hasError = ctx.required.size > 0;
  let ownershipLost = false;
  const skipped = new Set<StackKey>();

  // FR-9-2: __REQUIRED__ は AWS 副作用前に確定した計画上の失敗として伝播する。
  for (const failedStackKey of ctx.required.keys()) {
    const decision = computeSkips({
      plan: prepared.plan,
      failedStackKey,
      mergedGraphs: prepared.mergedGraphs,
      onFailure: ctx.options.onFailure ?? 'stop',
      failureKind: 'deploy',
      collectContinued: false,
    });
    for (const key of decision.skipped) skipped.add(key);
  }

  // FR-6-5: 依存メタデータ自体が unknown/incomplete の削除は、provider を特定できない。
  // その対象より前に並んだ削除も含め、同じ削除バッチの他対象を事前に止める。
  if (ctx.options.allowDelete && !ctx.options.dryRun) {
    const deleteOperations = prepared.plan.regions.flatMap((region) =>
      region.operations.filter((operation) => operation.kind === 'delete'),
    );
    const unsafeDependencyKeys = new Set(
      deleteOperations
        .filter((operation) =>
          hasUnsafeDependencyMetadata(operation.entry.stateEntry),
        )
        .map((operation) => operation.stackKey),
    );
    if (unsafeDependencyKeys.size > 0) {
      for (const operation of deleteOperations) {
        if (!unsafeDependencyKeys.has(operation.stackKey)) {
          skipped.add(operation.stackKey);
        }
      }
    }
  }

  // 将来並列化メモ: AWS ワーカーは state delta / report fragment を返し、このループの
  // 単一コミットキューが直列マージしてスタックごとに CAS 保存する形へ分離する。
  // 現状は fencing・失敗スキップ・即時 CAS の境界が密結合なため、挙動を変えない本バッチでは
  // 共有 state/report への書き込み分離を大改修せず、直列実行とスタックごとの保存を維持する。

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
    results.push(stackResult(entry.target, 'no-change'));
    emitProgress(
      ctx.deps,
      entry.stackKey,
      entry.target.region,
      'no-change',
      '変更なし(検知済み)',
    );
  }

  for (const regionPlan of prepared.plan.regions) {
    for (const operation of regionPlan.operations) {
      if (skipped.has(operation.stackKey)) {
        results.push(resultForOperation(operation, 'skipped'));
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
        const operationResult =
          operation.kind === 'delete'
            ? await processDeleted(ctx, operation, report, survivingPhysicalIds)
            : await processCreateOrUpdate(
                ctx,
                operation,
                prepared.analyses,
                prepared.redactors,
                prepared.parsedTemplates,
                report,
              );
        hasDiff ||= operationResult.hasDiff;
        hasError ||= operationResult.failed === true;
        if (operationResult.failed) {
          const skipDecision = computeSkips({
            plan: prepared.plan,
            failedStackKey: operation.stackKey,
            mergedGraphs: prepared.mergedGraphs,
            onFailure: ctx.options.onFailure ?? 'stop',
            failureKind: operation.kind === 'delete' ? 'delete' : 'deploy',
            collectContinued: false,
          });
          for (const key of skipDecision.skipped) skipped.add(key);
        }
      } catch (error) {
        hasError = true;
        // NFR-4: failedOperationResult が構成した redactor 適用済み errorMessage を
        // そのまま progress へ再利用する(独立に redact し直さない = 単一の redaction 経路)。
        const failure = failedOperationResult(
          operation,
          error,
          prepared.redactors.get(operation.stackKey),
        );
        results.push(failure);
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

        const skipDecision = computeSkips({
          plan: prepared.plan,
          failedStackKey: operation.stackKey,
          mergedGraphs: prepared.mergedGraphs,
          onFailure: ctx.options.onFailure ?? 'stop',
          failureKind: operation.kind === 'delete' ? 'delete' : 'deploy',
          collectContinued: false,
        });
        for (const key of skipDecision.skipped) skipped.add(key);
      }
    }
    if (ownershipLost) break;
  }

  hasDiff ||= report.diffs.some((diff) => diff.operation !== 'no-change');
  const exitCode: 0 | 1 | 2 = hasError
    ? 1
    : ctx.options.dryRun && hasDiff
      ? 2
      : 0;
  const redactedReport = redactReportMessages(report, (stackKey, text) =>
    (prepared.redactors.get(stackKey) ?? identityRedactor)(text),
  );
  return { exitCode, report: redactedReport, hasDiff };
}

function prepareExecutionPlan(ctx: LockedRunContext): PreparedPlan {
  const analyses = new Map<StackKey, TemplateAnalysis>();
  const redactors = new Map<StackKey, TextRedactor>();
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
    redactors.set(
      target.stackKey,
      createNoEchoRedactor(
        target.parameters,
        analysis.noEchoParams,
        extractScalarParameterDefaults(parsed),
      ),
    );
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
    parsedTemplates,
  };
}

// ===========================================================================
// 1 スタックの処理
// ===========================================================================

async function processCreateOrUpdate(
  ctx: LockedRunContext,
  operation: PlannedOperation,
  analyses: Map<StackKey, TemplateAnalysis>,
  redactors: Map<StackKey, TextRedactor>,
  parsedTemplates: Map<string, unknown>,
  report: DeployReport,
): Promise<OperationResult> {
  const target = operation.entry.target;
  if (!target)
    throw new InvariantError(
      `内部エラー: ${operation.stackKey} の target がありません`,
      { stackKey: operation.stackKey, region: operation.region },
    );
  const source = requiredTemplate(ctx.templates, target.templatePath);
  const analysis = analyses.get(operation.stackKey);
  if (!analysis)
    throw new InvariantError(
      `内部エラー: ${operation.stackKey} のテンプレート解析結果がありません`,
      { stackKey: operation.stackKey, region: operation.region },
    );
  const redact = redactors.get(operation.stackKey) ?? identityRedactor;

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
        parsedTemplates.get(target.templatePath),
        analysis,
        operation.entry.templateHash,
        operation.entry.inputsHash,
        existing,
        cfn,
        report,
      );
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
  const prepared = await prepareStack(executor, target.stackName, knownSummary);
  if (prepared.kind === 'update') {
    await requireManagedStackIdentity(cfn, target, operation.entry.stateEntry);
  }
  // REVIEW_IN_PROGRESS は prepareStack 内で回収済み。
  // スタックが実在しない(真の新規 CREATE)場合、ListChangeSets 自体が CloudFormation の
  // 実エラー("Stack ... does not exist")を返すため呼んではならない。prepared.stackStatus は
  // DescribeStacks が結果を返した(＝スタックが実在する)場合のみ設定される。
  // 実在し REVIEW_IN_PROGRESS でもない通常パス(update)のみ明示回収する。
  if (prepared.stackStatus !== undefined && !prepared.reviewInProgress)
    await reclaimStaleChangeSets(executor, target.stackName);

  // UPDATE の副作用(CreateChangeSet)直前にも再取得し、同名差し替えを fail-closed にする。
  if (prepared.kind === 'update') {
    await requireManagedStackIdentity(cfn, target, operation.entry.stateEntry);
  }

  emitProgress(
    ctx.deps,
    operation.stackKey,
    operation.region,
    'changeset-create-start',
    '変更セットを作成しています',
  );
  const created = await createManagedChangeSet(executor, {
    target,
    templateBody: source,
    kind: prepared.kind,
  });

  if (created.noChanges) {
    const diff = buildStackDiff({
      stackKey: operation.stackKey,
      region: operation.region,
      stackName: target.stackName,
      operation: 'no-change',
      noEchoParams: analysis.noEchoParams,
    });
    diff.warnings.push(...analysis.warnings);
    report.diffs.push(diff);
    report.result?.stacks.push(stackResult(target, 'no-change'));
    emitProgress(
      ctx.deps,
      operation.stackKey,
      operation.region,
      'no-change',
      '変更セットが空のため変更なしとして扱います',
    );
    const stackId =
      prepared.kind === 'update'
        ? (
            await requireManagedStackIdentity(
              cfn,
              target,
              operation.entry.stateEntry,
            )
          ).stackId
        : await requireExistingStackId(cfn, target);
    await saveSuccessfulEntry(
      ctx,
      operation.entry,
      analysis,
      prepared.kind === 'create' ? 'CREATE' : 'UPDATE',
      stackId,
    );
    return { hasDiff: false };
  }

  const diff = buildStackDiff({
    stackKey: operation.stackKey,
    region: operation.region,
    stackName: target.stackName,
    operation: prepared.kind,
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
    // design §5.2: DescribeChangeSet 済みの変更セットを後始末する。proxy が直前 fencing を担う。
    await cfn.deleteChangeSet(target.stackName, created.id);
    report.result?.stacks.push(stackResult(target, 'skipped'));
    return { hasDiff: true };
  }

  // ExecuteChangeSet 前の最新イベントを境界にし、長期運用スタックの過去履歴を待機へ持ち込まない。
  const eventCursor = await cfn.getStackEventCursor(target.stackName);
  let latestFailure: StackEventLine | undefined;
  let rollbackObserved = false;
  emitProgress(
    ctx.deps,
    operation.stackKey,
    operation.region,
    'execute-start',
    '変更セットを実行しています',
  );
  await executeWithReinspection(
    executor,
    target.stackName,
    created.name,
    created.id,
    prepared.kind === 'update'
      ? async () => {
          // UPDATE の実副作用直前: 変更セット再検査後にも不変 ARN を再照合する。
          await requireManagedStackIdentity(
            cfn,
            target,
            operation.entry.stateEntry,
          );
        }
      : undefined,
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
    prepared.kind === 'update' &&
    operation.entry.stateEntry?.stackId !== final.stackId
  ) {
    throw new StackStateError(
      `スタック '${target.stackName}' の stackId(ARN) が UPDATE 中に変化しました。state を更新せず cfnsync import を案内します`,
      { stackKey: target.stackKey, region: target.region },
    );
  }

  // FR-1-9: waitForStack 完了後、CAS 保存直前に saveSuccessfulEntry が再 fencing する。
  await saveSuccessfulEntry(
    ctx,
    operation.entry,
    analysis,
    prepared.kind === 'create' ? 'CREATE' : 'UPDATE',
    final.stackId,
  );
  report.result?.stacks.push(stackResult(target, 'succeeded'));
  emitProgress(
    ctx.deps,
    operation.stackKey,
    operation.region,
    'done',
    'デプロイが完了しました',
  );
  return { hasDiff: true };
}

async function processDeleted(
  ctx: LockedRunContext,
  operation: PlannedOperation,
  report: DeployReport,
  survivingPhysicalIds: Set<string>,
): Promise<OperationResult> {
  const stateEntry = operation.entry.stateEntry;
  if (!stateEntry)
    throw new InvariantError(
      `内部エラー: ${operation.stackKey} の stateEntry がありません`,
      { stackKey: operation.stackKey, region: operation.region },
    );

  // 同一物理スタック(region + stackName)を現在も別スタックキーで管理し続ける
  // 場合(テンプレートのパス変更・別テンプレートによる衝突)、この削除は
  // 「まだ管理対象の実スタック」を破壊する。fail-closed で拒否しリネーム移行を案内する。
  const rename = operation.entry.renamedTo;
  if (
    rename === undefined &&
    survivingPhysicalIds.has(physicalId(operation.region, stateEntry.stackName))
  ) {
    const diff = buildStackDiff({
      stackKey: operation.stackKey,
      region: operation.region,
      stackName: stateEntry.stackName,
      operation: 'delete',
      noEchoParams: [],
    });
    diff.warnings.push(
      `スタック '${stateEntry.stackName}'(${operation.region})は別のテンプレートパスで現在も管理対象です。` +
        `同一物理スタックの削除を拒否します。テンプレートのパス変更(リネーム)は state 移行で扱ってください`,
    );
    report.diffs.push(diff);
    report.result?.stacks.push({
      stackKey: operation.stackKey,
      region: operation.region,
      stackName: stateEntry.stackName,
      outcome: 'failed',
      errorMessage: diff.warnings[diff.warnings.length - 1],
      rolledBack: false,
    });
    emitProgress(
      ctx.deps,
      operation.stackKey,
      operation.region,
      'failed',
      diff.warnings[diff.warnings.length - 1],
    );
    return { hasDiff: true, failed: true };
  }
  const cfn = ctx.deps.cfnFactory(operation.region);
  const diff = buildStackDiff({
    stackKey: operation.stackKey,
    region: operation.region,
    stackName: stateEntry.stackName,
    operation: 'delete',
    noEchoParams: [],
  });
  report.diffs.push(diff);
  emitProgress(
    ctx.deps,
    operation.stackKey,
    operation.region,
    'delete-start',
    'スタックを削除しています',
  );

  const existing = await cfn.describeStack(stateEntry.stackName);
  if (!existing || existing.status === 'DELETE_COMPLETE') {
    // design §7: DELETE 成功後・state 保存前の中断からの再同期。
    // リネーム対の削除では、同一スタックキーの create が既に新エントリを保存済み。
    // state からエントリを除去すると新スタックの記録まで消えるため保存しない。
    if (rename === undefined) {
      const next = removeStackEntry(ctx.state.state, operation.stackKey);
      await saveState(ctx, next);
    }
    report.result?.stacks.push({
      stackKey: operation.stackKey,
      region: operation.region,
      stackName: stateEntry.stackName,
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
    diff.warnings.push(
      ctx.options.dryRun
        ? 'dry-run のため削除を実行しません'
        : '削除対象です。実削除には --allow-delete が必要です',
    );
    report.result?.stacks.push({
      stackKey: operation.stackKey,
      region: operation.region,
      stackName: stateEntry.stackName,
      outcome: 'skipped',
    });
    emitProgress(
      ctx.deps,
      operation.stackKey,
      operation.region,
      'skipped',
      diff.warnings[diff.warnings.length - 1],
    );
    return { hasDiff: true };
  }

  const deleted = await deleteManagedStack({
    target: {
      stackKey: operation.stackKey,
      region: operation.region,
      entry: stateEntry,
    },
    cfn,
    backend: ctx.deps.backend,
    lock: ctx.lock,
    state: ctx.state.state,
    version: ctx.state.version,
    knownSummary: existing,
    // リネーム対の削除では state エントリを除去しない(create が新エントリを保存済み)。
    preserveStateEntry: rename !== undefined,
  });

  if (deleted.outcome === 'refused') {
    diff.warnings.push(
      deleted.errorMessage ?? '安全装置により削除を拒否しました',
    );
    report.result?.stacks.push({
      stackKey: operation.stackKey,
      region: operation.region,
      stackName: stateEntry.stackName,
      outcome: 'failed',
      errorMessage: deleted.errorMessage,
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
  report.result?.stacks.push({
    stackKey: operation.stackKey,
    region: operation.region,
    stackName: stateEntry.stackName,
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
  existing: NonNullable<
    Awaited<ReturnType<CloudFormationGateway['describeStack']>>
  >,
  cfn: CloudFormationGateway,
  report: DeployReport,
): Promise<void> {
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
  diff.warnings.push(...analysis.warnings);
  if (analysis.noEchoParams.length > 0) {
    diff.warnings.push(
      `CREATE 復旧の比較から除外した NoEcho パラメータ: ${analysis.noEchoParams.join(', ')}`,
    );
  }
  if (target.dependsOn.length > 0) {
    diff.warnings.push(
      `CREATE 復旧の比較から除外した dependsOn: ${target.dependsOn.join(', ')}`,
    );
  }
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
  };
  await saveSuccessfulEntry(ctx, entry, analysis, 'SYNC', existing.stackId);
  report.result?.stacks.push(stackResult(target, 'no-change'));
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
  await saveState(
    ctx,
    upsertStackEntry(ctx.state.state, detected.stackKey, entry),
  );
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

function hasUnsafeDependencyMetadata(entry: StackEntry | undefined): boolean {
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
  deps.onProgress?.({ stackKey, region, phase, message });
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
