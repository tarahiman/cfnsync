/**
 * T-17 usecase/force-unlock — 残存ステートロックの手動解除
 * (design.md §5.6, requirements.md FR-1-7(手動解除) / FR-1-8 / FR-1-10)。
 *
 * 異常終了(プロセス強制終了・CI ジョブの中断等)で残存した `s3` バックエンドの
 * ステートロックを、実行 ID の指定を必須として手動で解放するコマンドの本体。
 *
 * design §5.6 のフロー:
 *   1. `backend.readLock()` でロック内容を取得。ロックなし → 「解除対象なし」を報告する
 *      (released: false, exitCode 0 — 解除すべきものが元々ない状態はエラーではない)。
 *   2. 出力には必ずロックの実行 ID・開始時刻・実行者、および「保持していた実行が終了
 *      していることを確認した場合にのみ使用してよい」旨の警告文を含める(FR-1-10)。
 *      これは解除の成否によらず、ロックが存在する限り常に表示する。
 *   3. 指定された runId と現在のロックの runId が不一致の場合、`backend.forceUnlock`
 *      を一切呼び出さずに解除を拒否する(released: false, exitCode 1)。別の実行の
 *      ロックを誤って条件付き削除に回さないための、usecase 層での事前検証(FR-1-8)。
 *   4. 一致する場合のみ `backend.forceUnlock(runId)` を呼ぶ。実装(aws/s3state.ts)は
 *      読み取り時の ETag による `If-Match` 条件付き削除を行うため、readLock からこの
 *      呼び出しまでの間に別実行が同じ runId でロックを再取得している競合窓では
 *      `released: false` が返る。その場合も削除は行われておらず、事実をそのまま
 *      報告する(released: false, exitCode 1)。
 */

import type { LockInfo, StateBackend } from '../ports/index.js';

/** `forceUnlock` の結果(T-19 cli が使う契約)。 */
export interface ForceUnlockResult {
  /** `0`: 解除成功、または解除対象のロックが元々存在しなかった。`1`: 解除に失敗した(エラー)。 */
  exitCode: 0 | 1;
  /** ロックが実際に解放されたか。 */
  released: boolean;
  /** 解除を試みた時点(readLock 直後)のロック内容。ロックが存在しなかった場合は undefined。 */
  lock?: LockInfo;
  /** 警告文+ロック内容(実行 ID・開始時刻・実行者)を含む人間可読メッセージ。 */
  message: string;
}

/**
 * ロックの内容(実行 ID・開始時刻・実行者)と、解除前に保持実行の終了を確認すべき旨の
 * 警告文を組み立てる(FR-1-10)。ロックが存在する限り、解除の成否によらず常に呼ぶ。
 */
function describeLock(lock: LockInfo): string {
  return [
    `ロック内容: 実行ID=${lock.runId}, 開始時刻=${lock.startedAt}, 実行者=${lock.owner}`,
    'このロックの手動解除は、保持していた実行(CI ジョブ・プロセス)が終了していることを利用者が確認した場合にのみ行ってください。実行中に解除すると、状態の不整合を招くおそれがあります。',
  ].join('\n');
}

/**
 * 指定された実行 ID のステートロックを手動で解除する(design §5.6)。
 *
 * `backend` はロック情報の読み取り(`readLock`)と条件付き強制解除(`forceUnlock`)の
 * 両方を提供する `StateBackend`(ports/index.ts)。`local` バックエンドはロックを
 * 持たないため、常に「解除対象なし」相当(`readLock` が undefined を返す)になる。
 */
export async function forceUnlock(input: {
  backend: StateBackend;
  runId: string;
}): Promise<ForceUnlockResult> {
  const { backend, runId } = input;

  // 1. 現在のロック内容を取得する。
  const lock = await backend.readLock();

  if (lock === undefined) {
    return {
      exitCode: 0,
      released: false,
      lock: undefined,
      message: '解除対象のロックは存在しません。',
    };
  }

  const lockDescription = describeLock(lock);

  // 3. 指定 runId と現在のロックが不一致 → backend.forceUnlock を呼ばずに拒否する(FR-1-8)。
  if (lock.runId !== runId) {
    return {
      exitCode: 1,
      released: false,
      lock,
      message: [
        `指定された実行 ID(${runId})は現在のロックの実行 ID(${lock.runId})と一致しないため、解除しません。`,
        lockDescription,
      ].join('\n'),
    };
  }

  // 4. 一致する場合のみ、条件付き削除(If-Match)を試みる。
  const result = await backend.forceUnlock(runId);

  if (!result.released) {
    return {
      exitCode: 1,
      released: false,
      lock,
      message: [
        `ロックを解除できませんでした${result.reason ? `(${result.reason})` : ''}。`,
        lockDescription,
      ].join('\n'),
    };
  }

  return {
    exitCode: 0,
    released: true,
    lock,
    message: ['ロックを解除しました。', lockDescription].join('\n'),
  };
}
