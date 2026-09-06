import type { ResolvedStackTarget } from '../../core/config.js';
import type { DetectedEntry } from '../../core/detect.js';
import { InvariantError, StackStateError } from '../../core/errors.js';
import {
  extractParameterDefaults,
  parseCfnTemplate,
  parsedTemplatesEquivalent,
  type TemplateAnalysis,
} from '../../core/template.js';
import type { CloudFormationGateway } from '../../ports/index.js';
import {
  buildStackDiff,
  type DeployReport,
  type ReconciliationRecord,
} from '../../report/index.js';
import { MANAGEMENT_TAG_KEY } from '../executor.js';
import { emitProgress } from './results.js';
import { saveSuccessfulEntry } from './statePersistence.js';
import type { LockedRunContext } from './types.js';

export async function recoverExistingCreate(
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
  report.diffs.push(diff);

  if (!templateHash || !inputsHash) {
    throw new InvariantError(`Internal error: no hash for ${target.stackKey}`, {
      stackKey: target.stackKey,
      region: target.region,
    });
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

function arraysEqual(a: string[], b: string[]): boolean {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

/**
 * FR-5-4: 進捗マイルストーンを onProgress へ fire-and-forget で通知する。
 * 純粋に観測用であり、exitCode / hasDiff / スキップ判定など制御フローには一切影響しない。
 * message は cfnsync 由来の静的文字列か、'failed' 段階に限り report の errorMessage に
 * 格納するのと同一の redactor 適用済み文字列(NFR-4)であること。
 */
