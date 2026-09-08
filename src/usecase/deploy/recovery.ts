import { arraysEqual } from '../../core/arrays.js';
import type { DetectedEntry } from '../../core/detect.js';
import { InvariantError, StackStateError } from '../../core/errors.js';
import type { PlannedOperation } from '../../core/plan.js';
import {
  extractParameterDefaults,
  parseCfnTemplate,
  parsedTemplatesEquivalent,
  type TemplateAnalysis,
} from '../../core/template.js';
import type { CloudFormationGateway, StackSummary } from '../../ports/index.js';
import { buildStackDiff } from '../../report/index.js';
import { MANAGEMENT_TAG_KEY } from '../executor.js';
import { saveSuccessfulEntry } from './statePersistence.js';
import type { LockedRunContext, RunAccumulator } from './types.js';

export async function recoverExistingCreate(
  ctx: LockedRunContext,
  run: RunAccumulator,
  args: {
    operation: PlannedOperation;
    source: string;
    parsed: unknown;
    analysis: TemplateAnalysis;
    existing: StackSummary;
    cfn: CloudFormationGateway;
  },
): Promise<void> {
  const {
    operation,
    source,
    parsed: desiredParsed,
    analysis,
    existing,
    cfn,
  } = args;
  const target = operation.entry.target;
  if (!target)
    throw new InvariantError(
      `Internal error: no target for ${operation.stackKey}`,
      { stackKey: operation.stackKey, region: operation.region },
    );

  // FR-5-5b4: 管理タグは「自ステート由来」であることしか証明せず、どの入力で作成された
  // かは証明しない。NoEcho の実値と dependsOn は AWS 側と照合できないため、これらが
  // 存在する対象を「事実確認済み」として再同期すると、未適用の希望値を適用済みとして
  // 記録し変更が失われる(虚偽収束)。入力同一性を証明できない場合は fail-closed とする。
  const unverifiable: string[] = [];
  if (analysis.noEchoParams.length > 0) {
    unverifiable.push(
      `The effective values of NoEcho parameters (${analysis.noEchoParams.join(', ')}) cannot be retrieved from AWS`,
    );
  }
  if (target.dependsOn.length > 0) {
    unverifiable.push(
      `Explicit dependsOn (${target.dependsOn.join(', ')}) cannot be verified against the live stack`,
    );
  }
  if (unverifiable.length > 0) {
    throw new StackStateError(
      `Cannot prove input equivalence for the same-named stack '${target.stackName}'; refusing to re-sync (fail-closed). ` +
        `${unverifiable.join(' / ')}. ` +
        `Recovery steps: back up the config file -> run cfnsync import --reconcile local -> ` +
        `restore the NoEcho parameters that import rewrote to __REQUIRED__ back to their intended values -> ` +
        `check the diff with cfnsync plan, then deploy`,
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
      `Cannot verify template equivalence or Parameter Default for the same-named stack '${target.stackName}' (fail-closed). ` +
        `Run cfnsync import`,
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
      `The same-named stack '${target.stackName}' does not exactly match the local desired values or management tag (fail-closed). ` +
        `This may be a naming collision; run cfnsync import`,
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
  run.report.diffs.push(diff);

  if (!operation.entry.templateHash || !operation.entry.inputsHash) {
    throw new InvariantError(`Internal error: no hash for ${target.stackKey}`, {
      stackKey: target.stackKey,
      region: target.region,
    });
  }
  // FR-1-18: 再同期は同一スタックキーを新スタック名で上書きするため、旧スタック名の
  // 削除待ち(renamedFrom があれば)も同じ保存に含めないと追跡が失われる(Issue #16)。
  // operation.entry は既に此の CREATE 対象の added エントリそのものであり、
  // target/templateHash/inputsHash/renamedFrom を個別の引数として渡し直す必要はない。
  const entry: DetectedEntry = { ...operation.entry, changeType: 'added' };
  await saveSuccessfulEntry(ctx, entry, analysis, 'SYNC', existing.stackId);
  run.reconciliations.push({
    stackKey: target.stackKey,
    region: target.region,
    kind: 'create-recovery',
    stateUpdated: true,
  });
  run.notify(
    { stackKey: target.stackKey, region: target.region },
    'no-change',
    'Re-synced as no changes via CREATE recovery',
  );
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
