/**
 * T-15 usecase/delete — 既存スタックの安全な削除(FR-6 / design §8.3)。
 *
 * 呼び出し側は AccountGuard と state lock を通過済みであること。ここでは 1 スタックの
 * 実削除について、依存情報・削除保護を fail-closed に検証し、DeleteStack と state CAS
 * 保存のそれぞれの直前に fencing を置く。fencing はベストエフォートであり、state 正本の
 * 一貫性は StateBackend.save の CAS が担う。
 */

import { LockError, StackStateError } from '../core/errors.js';
import {
  type CfnSyncState,
  prepareSave,
  removeStackEntry,
  type StackEntry,
} from '../core/state.js';
import type { StackKey } from '../core/types.js';
import type {
  CloudFormationGateway,
  LockHandle,
  StackSummary,
  StateBackend,
  StateVersion,
} from '../ports/index.js';

export interface ManagedDeleteTarget {
  stackKey: StackKey;
  region: string;
  entry: StackEntry;
}

export interface DeleteManagedStackInput {
  target: ManagedDeleteTarget;
  /** deploy が直前の describeStack で取得した存在中スタック。不存在復旧は deploy 側で処理済み。 */
  summary: StackSummary;
  cfn: CloudFormationGateway;
  backend: StateBackend;
  lock: LockHandle;
  state: CfnSyncState;
  version: StateVersion | undefined;
}

export interface DeleteManagedStackResult {
  outcome: 'deleted' | 'refused';
  state: CfnSyncState;
  version: StateVersion | undefined;
  errorMessage?: string;
}

/** DeleteStack 成功後の CAS 永続化失敗。後続削除へ進んではならない全体停止条件。 */
export class DeleteStateSaveError extends Error {}

/**
 * 1 スタックを削除し、成功直後に state から除去して CAS 保存する。
 *
 * `refused` はその対象だけの安全な拒否(依存情報欠落・削除保護)。LockError、
 * DeleteStateSaveError、DeleteStack/waitForStack の失敗は例外として伝播し、呼び出し側が
 * 後続副作用を停止または失敗方針に従って処理する。
 */
export async function deleteManagedStack(
  input: DeleteManagedStackInput,
): Promise<DeleteManagedStackResult> {
  const { target, summary, cfn, backend, lock } = input;

  // FR-6-5: exports/imports が欠落した state からは削除順を安全に復元できない。
  if (
    !Array.isArray(target.entry.exports) ||
    !Array.isArray(target.entry.imports)
  ) {
    return {
      outcome: 'refused',
      state: input.state,
      version: input.version,
      errorMessage:
        `スタック '${target.entry.stackName}' の依存情報(exports/imports)が state にありません。` +
        `安全な削除順を復元できないため削除を拒否します。手動対応してください`,
    };
  }

  // FR-6-3: 削除保護は自動解除しない。解除 API 自体を ports 契約に持たない。
  if (summary.terminationProtection) {
    return {
      outcome: 'refused',
      state: input.state,
      version: input.version,
      errorMessage:
        `スタック '${target.entry.stackName}' は削除保護(Termination Protection)が有効です。` +
        `自動解除せず削除を拒否します`,
    };
  }

  // FR-1-9(削除): DeleteStack の実 API 呼び出し直前に fencing。
  await assertDeleteFenced(backend, lock);
  await cfn.deleteStack(target.entry.stackName);

  // §8.3: CloudFormation がスタック不存在を DELETE_COMPLETE に正規化するまで待つ。
  const final = await cfn.waitForStack(target.entry.stackName);
  if (final.status !== 'DELETE_COMPLETE') {
    throw new StackStateError(
      `スタック '${target.entry.stackName}' の削除が完了しませんでした(final status: ${final.status})`,
      { stackKey: target.stackKey, region: target.region },
    );
  }

  // §8.3 / FR-1-9: 完了後、state CAS 保存の直前にも fencing を再検証する。
  await assertDeleteFenced(backend, lock);
  const nextState = prepareSave(removeStackEntry(input.state, target.stackKey));
  let nextVersion: StateVersion;
  try {
    nextVersion = await backend.save(nextState, input.version);
  } catch (cause) {
    throw new DeleteStateSaveError(
      `スタック '${target.entry.stackName}' は削除済みですが state の CAS 保存に失敗しました。` +
        `後続削除を中断し、再実行で復旧してください`,
      { cause },
    );
  }

  return { outcome: 'deleted', state: nextState, version: nextVersion };
}

async function assertDeleteFenced(
  backend: StateBackend,
  lock: LockHandle,
): Promise<void> {
  if (!(await backend.verifyLock(lock))) {
    throw new LockError(
      'ステートロックの所有権を失いました。以降の削除・保存を中断します(fencing)',
    );
  }
}
