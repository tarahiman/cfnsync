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
        `スタック '${target.entry.stackName}' の依存情報(exports/imports)が state にありません。` +
        `安全な削除順を復元できないため削除を拒否します。手動対応してください`,
    };
  }

  if (!Array.isArray(target.entry.dependsOn)) {
    return refused(
      input,
      `スタック '${target.entry.stackName}' の明示依存 dependsOn が旧 state で unknown です。` +
        `安全な削除順を復元できないため削除を拒否します。cfnsync import または state 移行を実行してください`,
    );
  }

  if (target.entry.dependencyAnalysisIncomplete) {
    return refused(
      input,
      `スタック '${target.entry.stackName}' は依存解析が不完全です。` +
        `明示 dependsOn で解消して再同期するか、手動対応してください`,
    );
  }

  // FR-6-8: 削除待ちの明示依存が統合グラフへ解決できない場合、安全な削除順を
  // 復元できないため FR-6-5 に従って当該対象の削除を拒否する。
  if (input.unresolvedDependsOn && input.unresolvedDependsOn.length > 0) {
    return refused(
      input,
      `スタック '${target.entry.stackName}' の明示依存 ` +
        `${input.unresolvedDependsOn.join(', ')} を依存グラフ上の管理対象へ解決できません。` +
        `安全な削除順を復元できないため削除を拒否します。手動対応してください`,
    );
  }

  if (!target.entry.stackId) {
    return refused(
      input,
      `スタック '${target.entry.stackName}' の state に stackId(ARN) が記録されていません。` +
        `同名スタックの差し替えを検証できないため削除を拒否します。cfnsync import または state 移行を実行してください`,
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
      `スタック '${target.entry.stackName}' の stackId(ARN) が state と一致しません。` +
        `同名スタックが差し替えられた可能性があるため DeleteStack を拒否します。cfnsync import を実行してください`,
    );
  }

  if (summary.status === 'REVIEW_IN_PROGRESS') {
    return refused(
      input,
      `スタック '${target.entry.stackName}' は REVIEW_IN_PROGRESS 状態です。` +
        `変更セット未実行の空スタックに DeleteStack は実行できないため削除を拒否します`,
    );
  }

  // fail-closed: 削除を許可する既知の安全な終端ステータスの allowlist。
  // 空・未知(将来 AWS が追加する状態)・進行中はすべて削除を拒否する。
  if (!DELETABLE_STACK_STATUSES.has(summary.status)) {
    return refused(
      input,
      `スタック '${target.entry.stackName}' は ${summary.status || '(不明)'} 状態です。` +
        `削除可能な安全な状態と確認できないため削除を拒否します。状態確認後に再実行してください`,
    );
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
  await assertFenced(backend, lock);
  await cfn.deleteStack(summary.stackId);

  // §8.3: CloudFormation がスタック不存在を DELETE_COMPLETE に正規化するまで待つ。
  const final = await cfn.waitForStack(summary.stackId);
  if (final.status !== 'DELETE_COMPLETE') {
    throw new StackStateError(
      `スタック '${target.entry.stackName}' の削除が完了しませんでした(final status: ${final.status})`,
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
      `スタック '${target.entry.stackName}' は削除済みですが state の CAS 保存に失敗しました。` +
        `後続削除を中断し、再実行で復旧してください`,
      { stackKey: target.stackKey, region: target.region, cause },
    );
  }

  return { outcome: 'deleted', state: nextState, version: nextVersion };
}
