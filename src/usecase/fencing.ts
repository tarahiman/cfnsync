/** StateBackend の保存副作用に fencing を付与する共通 decorator(FR-1-9)。 */

import { LockError } from '../core/errors.js';
import type { LockHandle, StateBackend } from '../ports/index.js';

export async function assertFenced(
  backend: StateBackend,
  lock: LockHandle,
): Promise<void> {
  if (!(await backend.verifyLock(lock))) {
    throw new LockError(
      'ステートロックの所有権を失いました。以降の副作用を中断します(fencing)',
    );
  }
}

/**
 * `save` の直前にロック所有権を再検証する StateBackend decorator。
 * 読み取り・ロック管理操作は元 backend へそのまま委譲する。
 */
export function fencedBackend(
  backend: StateBackend,
  lock: LockHandle,
): StateBackend {
  return {
    load: () => backend.load(),
    acquireLock: (info) => backend.acquireLock(info),
    verifyLock: (handle) => backend.verifyLock(handle),
    releaseLock: (handle) => backend.releaseLock(handle),
    readLock: () => backend.readLock(),
    forceUnlock: (runId) => backend.forceUnlock(runId),
    stateId: () => backend.stateId(),
    async save(state, expected) {
      await assertFenced(backend, lock);
      return backend.save(state, expected);
    },
  };
}
