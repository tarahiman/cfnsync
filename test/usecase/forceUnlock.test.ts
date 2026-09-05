/**
 * T-17 usecase/force-unlock — 残存ロックの手動解除(tasks.md §6 T-17 の対応表)。
 *
 * design.md §5.6 のフロー:
 *   1. `backend.readLock()` でロック内容を取得。ロックなし → 「解除対象なし」を報告。
 *   2. 出力に必ずロック内容(実行 ID・開始時刻・実行者)と警告文を含める(FR-1-10)。
 *   3. 指定 runId と現在のロックの runId が不一致 → 解除しない(FR-1-8)。
 *   4. 一致 → `backend.forceUnlock(runId)`(実装側が If-Match 条件付き削除)。
 *      読み取り〜削除間の所有者交代 → released: false が返る → その事実を報告(FR-1-8)。
 *
 * `StateBackend` は共通インメモリフェイクに差し替え、実 AWS には
 * 一切接続しない(§10)。呼び出し記録により「runId 不一致時に backend.forceUnlock が
 * 呼ばれないこと」を検証する。
 */

import { describe, expect, it } from 'vitest';
import type { LockInfo } from '../../src/ports/index.js';
import { forceUnlock } from '../../src/usecase/forceUnlock.js';
import { FakeStateBackend } from './fakes.js';

const LOCK: LockInfo = {
  runId: 'run-1',
  startedAt: '2026-07-19T00:00:00Z',
  owner: 'ci@github',
};

function fakeBackend(lock?: LockInfo): FakeStateBackend {
  const backend = new FakeStateBackend();
  if (lock) backend.setLock(lock);
  return backend;
}

// ===========================================================================
// FR-1-7(手動解除): 残存ロックを手動解除する手段を提供
// ===========================================================================

describe('FR-1-7(手動解除): 残存ロックを手動解除する手段を提供', () => {
  it('FR-1-7: 実行 ID 指定でロックが解除される', async () => {
    const backend = fakeBackend(LOCK);

    const result = await forceUnlock({ backend, runId: 'run-1' });

    expect(result.released).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(backend.callsOf('forceUnlock')[0].args).toEqual(['run-1']);
    expect(await backend.readLock()).toBeUndefined();
  });

  it('FR-1-7: ロックが存在しない場合は「解除対象なし」を報告する(released: false, exitCode 0)', async () => {
    const backend = fakeBackend();

    const result = await forceUnlock({ backend, runId: 'run-1' });

    expect(result.released).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.lock).toBeUndefined();
    // ロックが存在しないので forceUnlock(条件付き削除)は呼ばれない。
    expect(backend.callsOf('forceUnlock')).toEqual([]);
    expect(backend.callsOf('readLock')).toHaveLength(1);
  });
});

// ===========================================================================
// FR-1-8: 解除は対象検証つきの条件付き操作
// ===========================================================================

describe('FR-1-8: 解除は対象検証つきの条件付き操作', () => {
  it('FR-1-8(変種1): 指定実行 ID と現在のロックが不一致 → 解除しない。backend.forceUnlock は呼ばれない', async () => {
    const backend = fakeBackend(LOCK);

    const result = await forceUnlock({ backend, runId: 'run-DIFFERENT' });

    expect(result.released).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.lock).toEqual(LOCK);
    // 不一致の時点で解除を試みない — 誤って他実行のロックを条件付き削除に回さない。
    expect(backend.callsOf('forceUnlock')).toEqual([]);
    // ロックは奪われないまま残る。
    expect(await backend.readLock()).toEqual(LOCK);
  });

  it('FR-1-8(変種2): 読み取りから削除までの間に所有者交代(If-Match 不成立)→ 削除せずその事実を報告する', async () => {
    const backend = fakeBackend(LOCK);
    backend.forceUnlockResult = {
      released: false,
      reason: '読み取り後にロックの所有者が交代したため解放しませんでした',
    };

    const result = await forceUnlock({ backend, runId: 'run-1' });

    expect(result.released).toBe(false);
    expect(result.exitCode).toBe(1);
    // runId は一致していたので forceUnlock 自体は試みられる。
    expect(backend.callsOf('forceUnlock')[0].args).toEqual(['run-1']);
    expect(result.message).toContain('所有者が交代');
  });
});

// ===========================================================================
// FR-1-10: ロック内容(実行 ID・開始時刻・実行者)と警告を表示
// ===========================================================================

describe('FR-1-10: ロック内容(実行 ID・開始時刻・実行者)と警告を表示', () => {
  it('FR-1-10: 出力にロックの実行 ID・開始時刻・実行者、および解除前の確認を促す警告文が含まれる', async () => {
    const backend = fakeBackend(LOCK);

    const result = await forceUnlock({ backend, runId: 'run-1' });

    expect(result.lock).toEqual(LOCK);
    expect(result.message).toContain(LOCK.runId);
    expect(result.message).toContain(LOCK.startedAt);
    expect(result.message).toContain(LOCK.owner);
    // 「保持していた実行が終了していることを確認した場合にのみ解除してよい」旨の警告(FR-1-10)。
    expect(result.message).toContain('has finished');
    expect(result.message).toContain('confirming');
  });

  it('FR-1-10: runId 不一致で解除しない場合も、ロック内容と警告が出力に含まれる', async () => {
    const backend = fakeBackend(LOCK);

    const result = await forceUnlock({ backend, runId: 'run-OTHER' });

    expect(result.message).toContain(LOCK.runId);
    expect(result.message).toContain(LOCK.startedAt);
    expect(result.message).toContain(LOCK.owner);
    expect(result.message).toContain('confirming');
  });
});
