/**
 * T-15 usecase/delete — 既存スタックの安全な削除(FR-6 / design §8.3)。
 *
 * 呼び出し側は AccountGuard と state lock を通過済みであること。ここでは 1 スタックの
 * 実削除について、依存情報・削除保護を fail-closed に検証し、DeleteStack と state CAS
 * 保存のそれぞれの直前に fencing を置く。fencing はベストエフォートであり、state 正本の
 * 一貫性は StateBackend.save の CAS が担う。
 *
 * FR-6-7: 削除待ち(design §4.3 `pendingDeletions`)の削除もこの同一経路・同一安全装置を
 * 通す。違いは削除成功時に state のどこを更新するか(`stacks` か `pendingDeletions` か)だけである。
 */

import { StackStateError, StatePersistenceError } from '../core/errors.js';
import {
  type CfnSyncState,
  type DeletableStackRecord,
  prepareSave,
  removePendingDeletion,
  removeStackEntry,
} from '../core/state.js';
import type { StackKey } from '../core/types.js';
import type {
  CloudFormationGateway,
  LockHandle,
  StackSummary,
  StateBackend,
  StateVersion,
} from '../ports/index.js';
import { assertFenced } from './fencing.js';

/**
 * 削除を許可する既知の安全な終端スタックステータス(allowlist)。
 * これ以外(空文字・進行中・レビュー中・未知の将来ステータス)はすべて
 * fail-closed で削除を拒否する。
 */
const DELETABLE_STACK_STATUSES = new Set<string>([
  'CREATE_COMPLETE',
  'UPDATE_COMPLETE',
  'UPDATE_ROLLBACK_COMPLETE',
  'ROLLBACK_COMPLETE',
  'IMPORT_COMPLETE',
  'IMPORT_ROLLBACK_COMPLETE',
  'DELETE_FAILED',
  'ROLLBACK_FAILED',
  'UPDATE_ROLLBACK_FAILED',
  'UPDATE_FAILED',
]);

export interface ManagedDeleteTarget {
  stackKey: StackKey;
  region: string;
  /** 通常の `StackEntry` と削除待ち(`PendingDeletionEntry`)の共通部分だけを使う。 */
  entry: DeletableStackRecord;
}

export interface DeleteManagedStackInput {
  target: ManagedDeleteTarget;
  cfn: CloudFormationGateway;
  backend: StateBackend;
  lock: LockHandle;
  state: CfnSyncState;
  version: StateVersion | undefined;
  /** 呼び出し直前に取得済みの同一スタック要約。重複 DescribeStacks を避ける。 */
  knownSummary?: StackSummary;
  /**
   * FR-1-20 / FR-6-7: 削除待ち(リネーム対の旧スタック・過去実行の積み残し)の削除では、
   * `stacks` のエントリではなくこの ID の削除待ち記録を除去して保存する。
   * リネーム対では同一スタックキーの create が保存した新エントリを維持する必要があるため、
   * `stacks` には触れない。
   */
  pendingDeletionId?: string;
  /**
   * FR-6-8: 削除待ちの `dependsOn` のうち、統合依存グラフ上のノードへ解決できなかったもの。
   * 1 件でもあれば安全な削除順を復元できないため、副作用の前に削除を拒否する(FR-6-5)。
   */
  unresolvedDependsOn?: string[];
}

export interface DeleteManagedStackResult {
  outcome: 'deleted' | 'refused';
  state: CfnSyncState;
  version: StateVersion | undefined;
  errorMessage?: string;
}

/**
 * 1 スタックを削除し、成功直後に state から除去して CAS 保存する。
 *
 * `refused` はその対象だけの安全な拒否(依存情報欠落・削除保護)。LockError、
 * StatePersistenceError、DeleteStack/waitForStack の失敗は例外として伝播し、呼び出し側が
 * 後続副作用を停止または失敗方針に従って処理する。
 */
export async function deleteManagedStack(
  input: DeleteManagedStackInput,
): Promise<DeleteManagedStackResult> {
  const { target, cfn, backend, lock } = input;

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
        `Stack '${target.entry.stackName}' has no dependency information (exports/imports) in the state. ` +
        `Refusing to delete because a safe delete order cannot be reconstructed. Handle it manually`,
    };
  }

  if (!Array.isArray(target.entry.dependsOn)) {
    return refused(
      input,
      `The explicit dependsOn for stack '${target.entry.stackName}' is unknown in the legacy state. ` +
        `Refusing to delete because a safe delete order cannot be reconstructed. Run cfnsync import or a state migration`,
    );
  }

  if (target.entry.dependencyAnalysisIncomplete) {
    return refused(
      input,
      `Dependency analysis for stack '${target.entry.stackName}' is incomplete. ` +
        `Resolve it with an explicit dependsOn and re-sync, or handle it manually`,
    );
  }

  // FR-6-8: 削除待ちの明示依存が統合グラフへ解決できない場合、安全な削除順を
  // 復元できないため FR-6-5 に従って当該対象の削除を拒否する。
  if (input.unresolvedDependsOn && input.unresolvedDependsOn.length > 0) {
    return refused(
      input,
      `Cannot resolve the explicit dependsOn ` +
        `${input.unresolvedDependsOn.join(', ')} of stack '${target.entry.stackName}' to a managed node in the dependency graph. ` +
        `Refusing to delete because a safe delete order cannot be reconstructed. Handle it manually`,
    );
  }

  if (!target.entry.stackId) {
    return refused(
      input,
      `The state for stack '${target.entry.stackName}' has no recorded stackId (ARN). ` +
        `Refusing to delete because a same-named stack replacement cannot be verified. Run cfnsync import or a state migration`,
    );
  }

  // FR-6-9(敵対的レビュー指摘): 削除待ちの ID は (region, stackName) だけで決まるため、
  // 無関係な過去のリネーム・import による再取り込みと衝突しうる。削除対象と同じ
  // stackId(ARN) を、現在 `stacks` の別キーが指している場合、その物理スタックは
  // いま生きた管理対象として追跡されているということであり、削除待ちの由来
  // (今回のリネームか、過去の積み残しか)にかかわらず削除してはならない。
  const liveOwner = Object.entries(input.state.stacks).find(
    ([key, entry]) =>
      key !== target.stackKey && entry.stackId === target.entry.stackId,
  );
  if (liveOwner) {
    return refused(
      input,
      `The physical stack for '${target.entry.stackName}' is currently tracked as managed under ` +
        `template path '${liveOwner[0]}'. Refusing to delete to avoid deleting a live managed stack ` +
        `by mistake`,
    );
  }

  // FR-2 / FR-2-10: DeleteStack の直前に実状態を再取得し、並行操作と
  // REVIEW_IN_PROGRESS を fail-closed に拒否する。競合で既に消えた場合は復旧成功扱い。
  const summary =
    input.knownSummary ?? (await cfn.describeStack(target.entry.stackName));
  if (summary === undefined || summary.status === 'DELETE_COMPLETE') {
    return saveDeletedState(input);
  }

  if (summary.stackId !== target.entry.stackId) {
    return refused(
      input,
      `The stackId (ARN) of stack '${target.entry.stackName}' does not match the state. ` +
        `A stack with the same name may have been replaced, so refusing DeleteStack. Run cfnsync import`,
    );
  }

  if (summary.status === 'REVIEW_IN_PROGRESS') {
    return refused(
      input,
      `Stack '${target.entry.stackName}' is in REVIEW_IN_PROGRESS state. ` +
        `Refusing to delete because DeleteStack cannot be run on an empty stack with no executed change set`,
    );
  }

  // fail-closed: 削除を許可する既知の安全な終端ステータスの allowlist。
  // 空・未知(将来 AWS が追加する状態)・進行中はすべて削除を拒否する。
  if (!DELETABLE_STACK_STATUSES.has(summary.status)) {
    return refused(
      input,
      `Stack '${target.entry.stackName}' is in ${summary.status || '(unknown)'} state. ` +
        `Refusing to delete because it could not be confirmed as a safe, deletable state. Check the state and re-run`,
    );
  }

  // FR-6-3: 削除保護は自動解除しない。解除 API 自体を ports 契約に持たない。
  if (summary.terminationProtection) {
    return {
      outcome: 'refused',
      state: input.state,
      version: input.version,
      errorMessage:
        `Stack '${target.entry.stackName}' has termination protection enabled. ` +
        `Refusing to delete without automatically disabling it`,
    };
  }

  // FR-1-9(削除): DeleteStack の実 API 呼び出し直前に fencing。
  await assertFenced(backend, lock);
  await cfn.deleteStack(summary.stackId);

  // §8.3: CloudFormation がスタック不存在を DELETE_COMPLETE に正規化するまで待つ。
  const final = await cfn.waitForStack(summary.stackId);
  if (final.status !== 'DELETE_COMPLETE') {
    throw new StackStateError(
      `Deletion of stack '${target.entry.stackName}' did not complete (final status: ${final.status})`,
      { stackKey: target.stackKey, region: target.region },
    );
  }

  return saveDeletedState(input);
}

function refused(
  input: DeleteManagedStackInput,
  errorMessage: string,
): DeleteManagedStackResult {
  return {
    outcome: 'refused',
    state: input.state,
    version: input.version,
    errorMessage,
  };
}

async function saveDeletedState(
  input: DeleteManagedStackInput,
): Promise<DeleteManagedStackResult> {
  const { target, backend, lock } = input;
  // §8.3 / FR-1-9: 削除完了(不存在復旧を含む)後、state CAS 保存の直前に fencing。
  await assertFenced(backend, lock);
  // FR-1-20 / FR-6-7: 削除待ちの削除は pendingDeletions の当該記録だけを除去し、
  // `stacks`(リネーム対では新スタック名のエントリ)には触れない。
  const nextState = prepareSave(
    input.pendingDeletionId === undefined
      ? removeStackEntry(input.state, target.stackKey)
      : removePendingDeletion(input.state, input.pendingDeletionId),
  );
  let nextVersion: StateVersion;
  try {
    nextVersion = await backend.save(nextState, input.version);
  } catch (cause) {
    throw new StatePersistenceError(
      `Stack '${target.entry.stackName}' was deleted, but the compare-and-swap state save failed. ` +
        `Aborting subsequent deletions; recover by re-running`,
      { stackKey: target.stackKey, region: target.region, cause },
    );
  }

  return { outcome: 'deleted', state: nextState, version: nextVersion };
}
