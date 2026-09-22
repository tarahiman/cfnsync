import type { ResolvedStackTarget } from '../../core/config.js';
import {
  computeTemplateHash,
  type DetectionResult,
  detectChanges,
} from '../../core/detect.js';
import { ConfigError, InvariantError } from '../../core/errors.js';
import {
  buildGraphs,
  mergeGraphs,
  type RegionGraph,
  type StackNode,
} from '../../core/graph.js';
import {
  buildPlan,
  type ExecutionPlan,
  type PlannedOperation,
} from '../../core/plan.js';
import {
  analyzeStaticTemplate,
  extractScalarParameterDefaults,
  parseCfnTemplate,
  resolveStaticTemplateAnalysis,
  type StaticTemplateAnalysis,
  type TemplateAnalysis,
} from '../../core/template.js';
import type { StackKey } from '../../core/types.js';
import { createNoEchoRedactor, type TextRedactor } from '../redactor.js';
import { deletableRecord, hasUnsafeDependencyMetadata } from './deletePhase.js';
import type { LockedRunContext, PreparedPlan } from './types.js';

export function findPhysicalStackConflicts(
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
          `Stack '${pending.entry.stackName}' (${operation.region}) is pending deletion, but ` +
            `'${conflicting.stackKey}' in the configuration is trying to create/update the same physical stack. ` +
            `Aborting without any AWS side effects. First resolve the pending deletion with ` +
            `cfnsync deploy --allow-delete, or use a different stack name`,
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
        `Stack '${stateEntry.stackName}' (${operation.region}) is still managed under a different ` +
          `template path '${surviving.stackKey}'. This run includes both a delete and a create/update ` +
          `targeting the same physical stack, so aborting without any AWS side effects. ` +
          `Handle the template path change (rename) as a state migration`,
      );
      continue;
    }

    const target = operation.entry.target;
    if (!target) continue;
    const key = physicalId(operation.region, target.stackName);
    const previous = mutationByPhysicalId.get(key);
    if (previous !== undefined) {
      const message =
        `Stack '${target.stackName}' (${operation.region}) is targeted for create/update by both ` +
        `'${previous.stackKey}' and '${operation.stackKey}'. ` +
        `Aborting without any AWS side effects to avoid a duplicate operation on the same physical stack`;
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
export function findUnsafeDeleteKeys(
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
/** まだ結果の付いていない計画上の操作を skipped として記録する。 */
export function prepareExecutionPlan(ctx: LockedRunContext): PreparedPlan {
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
        `No static template analysis result for: ${target.templatePath}`,
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

export function requiredTemplate(
  templates: Map<string, string>,
  path: string,
): string {
  const source = templates.get(path);
  if (source === undefined)
    throw new ConfigError(`Template content not found: ${path}`, {
      stackKey: path,
    });
  return source;
}

function physicalId(region: string, stackName: string): string {
  return `${region}\u0000${stackName}`;
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
