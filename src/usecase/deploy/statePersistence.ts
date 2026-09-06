import { resolveDependsOnKey } from '../../core/dependency.js';
import type { DetectedEntry } from '../../core/detect.js';
import {
  InvariantError,
  StackStateError,
  StatePersistenceError,
} from '../../core/errors.js';
import {
  type CfnSyncState,
  type PendingDeletionEntry,
  pendingDeletionId,
  prepareSave,
  type StackEntry,
  upsertPendingDeletion,
  upsertStackEntry,
} from '../../core/state.js';
import type { TemplateAnalysis } from '../../core/template.js';
import type { StackKey } from '../../core/types.js';
import type { StateVersion } from '../../ports/index.js';
import { assertFenced } from '../fencing.js';
import type { DeployDeps, LockedRunContext } from './types.js';

export async function saveSuccessfulEntry(
  ctx: LockedRunContext,
  detected: DetectedEntry,
  analysis: TemplateAnalysis,
  lastAction: StackEntry['lastAction'],
  stackId: string,
): Promise<void> {
  const target = detected.target;
  if (!target || !detected.templateHash || !detected.inputsHash) {
    throw new InvariantError(
      `Internal error: missing success-state input for ${detected.stackKey}`,
      { stackKey: detected.stackKey },
    );
  }
  if (!stackId) {
    throw new StackStateError(
      `Cannot confirm the stackId (ARN) of stack '${target.stackName}', so the success state cannot be saved. Run cfnsync import`,
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

export async function saveState(
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
      'Aborting subsequent processing because the compare-and-swap state save failed',
      { cause },
    );
  }
  ctx.state.state = payload;
  ctx.state.version = version;
}

export function now(deps: DeployDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

/** 同一リージョン内で物理スタックを一意に識別するキー(stackName が物理識別子)。 */
