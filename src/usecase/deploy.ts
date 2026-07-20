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
  resolveDependsOnKey,
  resolveTargets,
} from '../core/config.js';
import {
  type DetectedEntry,
  type DetectionResult,
  detectChanges,
} from '../core/detect.js';
import { LockError, StackStateError } from '../core/errors.js';
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
  analyzeTemplate,
  type TemplateAnalysis,
  templatesEquivalent,
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
  redactReportMessages,
  type StackEventLine,
  type StackResult,
} from '../report/index.js';
import { DeleteStateSaveError, deleteManagedStack } from './delete.js';
import {
  createManagedChangeSet,
  type ExecutorContext,
  executeWithReinspection,
  MANAGEMENT_TAG_KEY,
  newRunId,
  prepareStack,
  reclaimStaleChangeSets,
} from './executor.js';
import { assertFenced, fencedBackend } from './fencing.js';
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
  /** FR-4-1: 待機中イベントの逐次出力先。report.events にも同時に蓄積する。 */
  onEvent?: (event: StackEventLine) => void;
}

export interface DeployOptions {
  dryRun?: boolean;
  allowDelete?: boolean;
  onFailure?: 'stop' | 'continue';
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
}

interface OperationResult {
  hasDiff: boolean;
  /** 対象だけを fail-closed に拒否し、独立した他対象は継続できる検証エラー。 */
  failed?: boolean;
}

/** AWS 成功後の state 永続化失敗は後続スタックへ進めない全体停止条件。 */
class StateSaveError extends Error {}

// ===========================================================================
// deploy 公開入口
// ===========================================================================

export async function deploy(input: {
  config: CfnSyncConfig;
  configDir: string;
  templates: Map<string, string>;
  deps: DeployDeps;
  options: DeployOptions;
}): Promise<DeployResult> {
  const { config, templates, deps, options } = input;
  void input.configDir;

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
    assertAccountAllowed(config, resolved.accountId);
    assertRegionsAllowed(config, targetRegions);
    connection = connectionHeader({
      accountId: resolved.accountId,
      regions: targetRegions,
    });
  } catch (error) {
    return failedBeforeLock(connection, required, targets, error);
  }

  const runId = (deps.runId ?? newRunId)();
  let lock: LockHandle;
  try {
    lock = await deps.backend.acquireLock({
      runId,
      startedAt: now(deps).toISOString(),
      owner: process.env.USER ?? process.env.LOGNAME ?? 'cfnsync',
    });
  } catch (error) {
    return failedBeforeLock(connection, required, targets, error);
  }

  let result: DeployResult;
  try {
    // verifyStateAccount の初回 accountId 保存も fencing 対象にするため proxy を渡す。
    const state = await verifyStateAccount({
      backend: fencedBackend(deps.backend, lock),
      accountId: connection.accountId,
    });
    result = await runLocked({
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
    result = failureResult(
      connection,
      requiredResults(required, targets),
      error,
    );
  }

  try {
    // FR-1-7: 正常・異常・所有権喪失を問わず条件付き解放を試みる。
    await deps.backend.releaseLock(lock);
  } catch (error) {
    result = appendDeployFailure(result, error);
  }
  return result;
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

  const resultStacks = requiredResults(ctx.required, ctx.targets);
  const report: DeployReport = {
    connection: ctx.connection,
    diffs: [],
    events: [],
    result: { stacks: resultStacks },
  };
  const results = resultStacks;
  let hasDiff = false;
  let hasError = ctx.required.size > 0;
  let ownershipLost = false;
  const skipped = new Set<StackKey>();

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
  }

  for (const regionPlan of prepared.plan.regions) {
    for (const operation of regionPlan.operations) {
      if (skipped.has(operation.stackKey)) {
        results.push(resultForOperation(operation, 'skipped'));
        continue;
      }

      try {
        const operationResult =
          operation.kind === 'delete'
            ? await processDeleted(ctx, operation, report)
            : await processCreateOrUpdate(
                ctx,
                operation,
                prepared.analyses,
                prepared.redactors,
                report,
              );
        hasDiff ||= operationResult.hasDiff;
        hasError ||= operationResult.failed === true;
      } catch (error) {
        hasError = true;
        results.push(
          failedOperationResult(
            operation,
            error,
            prepared.redactors.get(operation.stackKey),
          ),
        );

        // fencing 喪失は「当該副作用以降を実行しない」ため onFailure に関係なく即中断。
        if (
          error instanceof LockError ||
          error instanceof StateSaveError ||
          error instanceof DeleteStateSaveError
        ) {
          ownershipLost = true;
          break;
        }

        const skipDecision = computeSkips({
          plan: prepared.plan,
          failedStackKey: operation.stackKey,
          mergedGraphs: prepared.mergedGraphs,
          onFailure: ctx.options.onFailure ?? 'stop',
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
  const currentNodes: StackNode[] = [];
  for (const target of ctx.targets) {
    const source = requiredTemplate(ctx.templates, target.templatePath);
    const analysis = analyzeTemplate(source, {
      stackName: target.stackName,
      region: target.region,
    });
    analyses.set(target.stackKey, analysis);
    redactors.set(
      target.stackKey,
      createNoEchoRedactor(target.parameters, analysis.noEchoParams),
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
  return { detection, analyses, graphs, mergedGraphs, plan, redactors };
}

// ===========================================================================
// 1 スタックの処理
// ===========================================================================

async function processCreateOrUpdate(
  ctx: LockedRunContext,
  operation: PlannedOperation,
  analyses: Map<StackKey, TemplateAnalysis>,
  redactors: Map<StackKey, TextRedactor>,
  report: DeployReport,
): Promise<OperationResult> {
  const target = operation.entry.target;
  if (!target)
    throw new Error(`内部エラー: ${operation.stackKey} の target がありません`);
  const source = requiredTemplate(ctx.templates, target.templatePath);
  const analysis = analyses.get(operation.stackKey);
  if (!analysis)
    throw new Error(
      `内部エラー: ${operation.stackKey} のテンプレート解析結果がありません`,
    );
  const redact = redactors.get(operation.stackKey) ?? identityRedactor;

  const rawCfn = ctx.deps.cfnFactory(operation.region);
  const cfn = fencedGateway(rawCfn, ctx.deps.backend, ctx.lock);

  // design §7: added だが完成済みの同名スタックがある場合は CREATE 復旧比較へ分岐。
  if (operation.kind === 'create') {
    const existing = await cfn.describeStack(target.stackName);
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
        analysis,
        existing,
        cfn,
        report,
      );
      return { hasDiff: false };
    }
  }

  const executor: ExecutorContext = {
    cfn,
    stateId: ctx.deps.backend.stateId(),
    runId: ctx.runId,
    now: ctx.deps.now,
    redact,
  };
  const prepared = await prepareStack(executor, target.stackName);
  // REVIEW_IN_PROGRESS は prepareStack 内で回収済み。通常パスのみ明示回収する。
  if (!prepared.reviewInProgress)
    await reclaimStaleChangeSets(executor, target.stackName);

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
    await saveSuccessfulEntry(
      ctx,
      operation.entry,
      analysis,
      prepared.kind === 'create' ? 'CREATE' : 'UPDATE',
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
  });
  diff.warnings.push(...analysis.warnings);
  report.diffs.push(diff);

  if (ctx.options.dryRun) {
    // design §5.2: DescribeChangeSet 済みの変更セットを後始末する。proxy が直前 fencing を担う。
    await cfn.deleteChangeSet(target.stackName, created.name);
    report.result?.stacks.push(stackResult(target, 'skipped'));
    return { hasDiff: true };
  }

  await executeWithReinspection(executor, target.stackName, created.name);
  const final = await cfn.waitForStack(target.stackName, {
    onEvent: (event) => {
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
      report.events?.push(line);
      ctx.deps.onEvent?.(line);
    },
  });

  if (!isSuccessfulTerminal(final.status)) {
    const stackEvents = (report.events ?? []).filter(
      (event) => event.stackKey === operation.stackKey,
    );
    const cause = stackEvents.find((event) =>
      event.resourceStatus.endsWith('_FAILED'),
    );
    const reason =
      cause?.resourceStatusReason ??
      (final.statusReason === undefined
        ? final.status
        : redact(final.statusReason));
    const resource = cause ? `${cause.logicalResourceId}: ` : '';
    throw new StackStateError(
      `${resource}${reason} (final status: ${final.status})`,
      {
        stackKey: operation.stackKey,
        region: operation.region,
      },
    );
  }

  // FR-1-9: waitForStack 完了後、CAS 保存直前に saveSuccessfulEntry が再 fencing する。
  await saveSuccessfulEntry(
    ctx,
    operation.entry,
    analysis,
    prepared.kind === 'create' ? 'CREATE' : 'UPDATE',
  );
  report.result?.stacks.push(stackResult(target, 'succeeded'));
  return { hasDiff: true };
}

async function processDeleted(
  ctx: LockedRunContext,
  operation: PlannedOperation,
  report: DeployReport,
): Promise<OperationResult> {
  const stateEntry = operation.entry.stateEntry;
  if (!stateEntry)
    throw new Error(
      `内部エラー: ${operation.stackKey} の stateEntry がありません`,
    );
  const cfn = ctx.deps.cfnFactory(operation.region);
  const diff = buildStackDiff({
    stackKey: operation.stackKey,
    region: operation.region,
    stackName: stateEntry.stackName,
    operation: 'delete',
    noEchoParams: [],
  });
  report.diffs.push(diff);

  const existing = await cfn.describeStack(stateEntry.stackName);
  if (!existing || existing.status === 'DELETE_COMPLETE') {
    // design §7: DELETE 成功後・state 保存前の中断からの再同期。
    const next = removeStackEntry(ctx.state.state, operation.stackKey);
    await saveState(ctx, next);
    report.result?.stacks.push({
      stackKey: operation.stackKey,
      region: operation.region,
      stackName: stateEntry.stackName,
      outcome: 'succeeded',
    });
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
    });
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
  return { hasDiff: true };
}

// ===========================================================================
// 復旧・state 保存
// ===========================================================================

async function recoverExistingCreate(
  ctx: LockedRunContext,
  target: ResolvedStackTarget,
  source: string,
  analysis: TemplateAnalysis,
  existing: NonNullable<
    Awaited<ReturnType<CloudFormationGateway['describeStack']>>
  >,
  cfn: CloudFormationGateway,
  report: DeployReport,
): Promise<void> {
  const deployedTemplate = await cfn.getTemplate(target.stackName, 'Original');
  const stateId = ctx.deps.backend.stateId();
  const desiredTags = { ...target.tags, [MANAGEMENT_TAG_KEY]: stateId };
  const verifiableDesiredParameters = omitKeys(
    target.parameters,
    analysis.noEchoParams,
  );
  const verifiableActualParameters = omitKeys(
    existing.parameters,
    analysis.noEchoParams,
  );

  let templateMatches: boolean;
  try {
    templateMatches = templatesEquivalent(source, deployedTemplate);
  } catch (cause) {
    throw new StackStateError(
      `同名スタック '${target.stackName}' のテンプレート同値性を検証できません(fail-closed)。` +
        `cfnsync import を実行してください`,
      { stackKey: target.stackKey, region: target.region, cause },
    );
  }

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

  const entry: DetectedEntry = {
    stackKey: target.stackKey,
    changeType: 'added',
    target,
    templateHash: operationHashSource(ctx, target, 'template'),
    inputsHash: operationHashSource(ctx, target, 'inputs'),
  };
  await saveSuccessfulEntry(ctx, entry, analysis, 'SYNC');
  report.result?.stacks.push(stackResult(target, 'no-change'));
}

function operationHashSource(
  ctx: LockedRunContext,
  target: ResolvedStackTarget,
  kind: 'template' | 'inputs',
): string {
  const detected = detectChanges({
    targets: [target],
    templates: ctx.templates,
    state: ctx.state.state,
  }).entries.find((entry) => entry.target?.stackKey === target.stackKey);
  const value =
    kind === 'template' ? detected?.templateHash : detected?.inputsHash;
  if (!value)
    throw new Error(
      `内部エラー: ${target.stackKey} の ${kind} hash がありません`,
    );
  return value;
}

async function saveSuccessfulEntry(
  ctx: LockedRunContext,
  detected: DetectedEntry,
  analysis: TemplateAnalysis,
  lastAction: StackEntry['lastAction'],
): Promise<void> {
  const target = detected.target;
  if (!target || !detected.templateHash || !detected.inputsHash) {
    throw new Error(
      `内部エラー: ${detected.stackKey} の成功 state 入力が不足しています`,
    );
  }
  const entry: StackEntry = {
    stackName: target.stackName,
    region: target.region,
    templateHash: detected.templateHash,
    inputsHash: detected.inputsHash,
    exports: analysis.exports,
    imports: analysis.imports,
    dependsOn: target.dependsOn.map((raw) =>
      resolveDependsOnKey(raw, target.region),
    ),
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
    throw new StateSaveError(
      'ステートの CAS 保存に失敗したため、以降の処理を中断します',
      { cause },
    );
  }
  ctx.state.state = payload;
  ctx.state.version = version;
}

// ===========================================================================
// fencing proxy
// ===========================================================================

function fencedGateway(
  gateway: CloudFormationGateway,
  backend: StateBackend,
  lock: LockHandle,
): CloudFormationGateway {
  return {
    describeStack: (stackName) => gateway.describeStack(stackName),
    listChangeSets: (stackName) => gateway.listChangeSets(stackName),
    describeChangeSet: (stackName, changeSetName) =>
      gateway.describeChangeSet(stackName, changeSetName),
    waitForChangeSet: (stackName, changeSetName) =>
      gateway.waitForChangeSet(stackName, changeSetName),
    describeStackEvents: (stackName, seen) =>
      gateway.describeStackEvents(stackName, seen),
    getTemplate: (stackName, stage) => gateway.getTemplate(stackName, stage),
    waitForStack: (stackName, opts) => gateway.waitForStack(stackName, opts),
    async createChangeSet(changeSetInput) {
      await assertFenced(backend, lock);
      return gateway.createChangeSet(changeSetInput);
    },
    async deleteChangeSet(stackName, changeSetName) {
      await assertFenced(backend, lock);
      return gateway.deleteChangeSet(stackName, changeSetName);
    },
    async executeChangeSet(stackName, changeSetName) {
      await assertFenced(backend, lock);
      return gateway.executeChangeSet(stackName, changeSetName);
    },
    async deleteStack(stackName) {
      await assertFenced(backend, lock);
      return gateway.deleteStack(stackName);
    },
  };
}

// ===========================================================================
// 補助
// ===========================================================================

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
    throw new Error(`テンプレート内容が見つかりません: ${path}`);
  return source;
}

function isSuccessfulTerminal(status: string): boolean {
  return (
    status === 'CREATE_COMPLETE' ||
    status === 'UPDATE_COMPLETE' ||
    status === 'IMPORT_COMPLETE'
  );
}

function now(deps: DeployDeps): Date {
  return (deps.now ?? (() => new Date()))();
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
  result.errorMessage = redact(errorMessage(error));
  result.rolledBack = /ROLLBACK/i.test(result.errorMessage);
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
            errorMessage: errorMessage(error),
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
    errorMessage: `ロック解放に失敗しました: ${errorMessage(error)}`,
  });
  result.report.result = { stacks };
  result.exitCode = 1;
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
