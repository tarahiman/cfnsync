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
 * `StateBackend` はこのファイル内に定義したインメモリフェイクに差し替え、実 AWS には
 * 一切接続しない(§10)。呼び出し記録により「runId 不一致時に backend.forceUnlock が
 * 呼ばれないこと」を検証する。
 */

import { describe, expect, it } from 'vitest';
import type { CfnSyncState } from '../../src/core/state.js';
import type { LockHandle, LockInfo, StateBackend, StateVersion } from '../../src/ports/index.js';
import { forceUnlock } from '../../src/usecase/forceUnlock.js';

// ---------------------------------------------------------------------------
// インメモリフェイク(このファイル専用。test/usecase/fakes.ts は変更しない)
// ---------------------------------------------------------------------------

/**
 * `StateBackend` のフェイク。`readLock` / `forceUnlock` の呼び出しを記録する。
 * `simulateRaceOnForceUnlock` を true にすると、`readLock` 時点では runId が一致して
 * いても、`forceUnlock` 呼び出し時には所有者交代(If-Match 不成立)が起きたことを
 * シミュレートし、`released: false` を返す(FR-1-8 の競合窓シナリオ)。
 */
class FakeStateBackendForUnlock implements StateBackend {
  lock: LockInfo | undefined;
  readLockCalls = 0;
  forceUnlockCalls: string[] = [];
  simulateRaceOnForceUnlock = false;

  constructor(initialLock?: LockInfo) {
    this.lock = initialLock;
  }

  async load(): Promise<{ state: CfnSyncState; version: StateVersion } | undefined> {
    throw new Error('not used by forceUnlock');
  }

  async save(): Promise<StateVersion> {
    throw new Error('not used by forceUnlock');
  }

  async acquireLock(info: LockInfo): Promise<LockHandle> {
    return { runId: info.runId };
  }

  async verifyLock(): Promise<boolean> {
    return true;
  }

  async releaseLock(): Promise<{ released: boolean; reason?: string }> {
    return { released: true };
  }

  async readLock(): Promise<LockInfo | undefined> {
    this.readLockCalls++;
    return this.lock;
  }

  async forceUnlock(runId: string): Promise<{ released: boolean; reason?: string }> {
    this.forceUnlockCalls.push(runId);
    if (this.simulateRaceOnForceUnlock) {
      return {
        released: false,
        reason: '読み取り後にロックの所有者が交代したため解放しませんでした',
      };
    }
    if (this.lock?.runId !== runId) {
      return {
        released: false,
        reason: `指定された実行 ID(${runId})は現在のロック(${this.lock?.runId ?? '不明'})と一致しません`,
      };
    }
    this.lock = undefined;
    return { released: true };
  }

  stateId(): string {
    return 'fake-state-id';
  }
}

const LOCK: LockInfo = { runId: 'run-1', startedAt: '2026-07-19T00:00:00Z', owner: 'ci@github' };

// ===========================================================================
// FR-1-7(手動解除): 残存ロックを手動解除する手段を提供
// ===========================================================================

describe('FR-1-7(手動解除): 残存ロックを手動解除する手段を提供', () => {
  it('FR-1-7: 実行 ID 指定でロックが解除される', async () => {
    const backend = new FakeStateBackendForUnlock(LOCK);

    const result = await forceUnlock({ backend, runId: 'run-1' });

    expect(result.released).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(backend.forceUnlockCalls).toEqual(['run-1']);
    expect(backend.lock).toBeUndefined();
  });

  it('FR-1-7: ロックが存在しない場合は「解除対象なし」を報告する(released: false, exitCode 0)', async () => {
    const backend = new FakeStateBackendForUnlock(undefined);

    const result = await forceUnlock({ backend, runId: 'run-1' });

    expect(result.released).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.lock).toBeUndefined();
    // ロックが存在しないので forceUnlock(条件付き削除)は呼ばれない。
    expect(backend.forceUnlockCalls).toEqual([]);
    expect(backend.readLockCalls).toBe(1);
  });
});

// ===========================================================================
// FR-1-8: 解除は対象検証つきの条件付き操作
// ===========================================================================

describe('FR-1-8: 解除は対象検証つきの条件付き操作', () => {
  it('FR-1-8(変種1): 指定実行 ID と現在のロックが不一致 → 解除しない。backend.forceUnlock は呼ばれない', async () => {
    const backend = new FakeStateBackendForUnlock(LOCK);

    const result = await forceUnlock({ backend, runId: 'run-DIFFERENT' });

    expect(result.released).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.lock).toEqual(LOCK);
    // 不一致の時点で解除を試みない — 誤って他実行のロックを条件付き削除に回さない。
    expect(backend.forceUnlockCalls).toEqual([]);
    // ロックは奪われないまま残る。
    expect(backend.lock).toEqual(LOCK);
  });

  it('FR-1-8(変種2): 読み取りから削除までの間に所有者交代(If-Match 不成立)→ 削除せずその事実を報告する', async () => {
    const backend = new FakeStateBackendForUnlock(LOCK);
    backend.simulateRaceOnForceUnlock = true;

    const result = await forceUnlock({ backend, runId: 'run-1' });

    expect(result.released).toBe(false);
    expect(result.exitCode).toBe(1);
    // runId は一致していたので forceUnlock 自体は試みられる。
    expect(backend.forceUnlockCalls).toEqual(['run-1']);
    expect(result.message).toContain('所有者が交代');
  });
});

// ===========================================================================
// FR-1-10: ロック内容(実行 ID・開始時刻・実行者)と警告を表示
// ===========================================================================

describe('FR-1-10: ロック内容(実行 ID・開始時刻・実行者)と警告を表示', () => {
  it('FR-1-10: 出力にロックの実行 ID・開始時刻・実行者、および解除前の確認を促す警告文が含まれる', async () => {
    const backend = new FakeStateBackendForUnlock(LOCK);

    const result = await forceUnlock({ backend, runId: 'run-1' });

    expect(result.lock).toEqual(LOCK);
    expect(result.message).toContain(LOCK.runId);
    expect(result.message).toContain(LOCK.startedAt);
    expect(result.message).toContain(LOCK.owner);
    // 「保持していた実行が終了していることを確認した場合にのみ解除してよい」旨の警告(FR-1-10)。
    expect(result.message).toContain('終了していること');
    expect(result.message).toContain('確認');
  });

  it('FR-1-10: runId 不一致で解除しない場合も、ロック内容と警告が出力に含まれる', async () => {
    const backend = new FakeStateBackendForUnlock(LOCK);

    const result = await forceUnlock({ backend, runId: 'run-OTHER' });

    expect(result.message).toContain(LOCK.runId);
    expect(result.message).toContain(LOCK.startedAt);
    expect(result.message).toContain(LOCK.owner);
    expect(result.message).toContain('確認');
  });
});
