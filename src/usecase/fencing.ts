/** StateBackend の保存副作用に fencing を付与する共通 decorator(FR-1-9)。 */

import { LockError } from '../core/errors.js';
import type {
  CloudFormationGateway,
  LockHandle,
  LockInfo,
  StateBackend,
} from '../ports/index.js';

export interface FencedLockScope {
  lock: LockHandle;
  /** save の直前に所有権を検証する decorator 済み backend。 */
  backend: StateBackend;
}

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

/** CloudFormation の変更 API だけを副作用直前の fencing で包む decorator。 */
export function fencedGateway(
  gateway: CloudFormationGateway,
  backend: StateBackend,
  lock: LockHandle,
): CloudFormationGateway {
  return {
    describeStack: (stackName) => gateway.describeStack(stackName),
    listChangeSets: (stackName) => gateway.listChangeSets(stackName),
    describeChangeSet: (stackName, changeSetName) =>
      gateway.describeChangeSet(stackName, changeSetName),
    waitForChangeSet: (stackName, changeSetName) =>
      gateway.waitForChangeSet(stackName, changeSetName),
    describeStackEvents: (stackName, seen, after) =>
      gateway.describeStackEvents(stackName, seen, after),
    getStackEventCursor: (stackName) => gateway.getStackEventCursor(stackName),
    getTemplate: (stackName, stage) => gateway.getTemplate(stackName, stage),
    waitForStack: (stackName, options) =>
      gateway.waitForStack(stackName, options),
    async createChangeSet(input) {
      await assertFenced(backend, lock);
      return gateway.createChangeSet(input);
    },
    async deleteChangeSet(stackName, changeSetName) {
      await assertFenced(backend, lock);
      return gateway.deleteChangeSet(stackName, changeSetName);
    },
    async executeChangeSet(stackName, changeSetName) {
      await assertFenced(backend, lock);
      return gateway.executeChangeSet(stackName, changeSetName);
    },
    async deleteStack(stackName) {
      await assertFenced(backend, lock);
      return gateway.deleteStack(stackName);
    },
  };
}

/** ロックの acquire → fenced scope → release を一箇所に固定する共通 runner。 */
export async function withFencedLock<T>(input: {
  backend: StateBackend;
  info: LockInfo;
  run: (scope: FencedLockScope) => Promise<T>;
  onReleaseError?: (result: T, error: unknown) => T | Promise<T>;
}): Promise<T> {
  const lock = await input.backend.acquireLock(input.info);
  let result: T;
  try {
    result = await input.run({
      lock,
      backend: fencedBackend(input.backend, lock),
    });
  } catch (error) {
    try {
      await input.backend.releaseLock(lock);
    } catch {
      // 本体の失敗を優先する。解除失敗は元エラーの cause を覆わない。
    }
    throw error;
  }

  try {
    const release = await input.backend.releaseLock(lock);
    if (!release.released) {
      throw new LockError(
        `ステートロックを解放できませんでした: ${release.reason ?? '所有権が一致しません'}`,
      );
    }
    return result;
  } catch (error) {
    if (input.onReleaseError) return input.onReleaseError(result, error);
    throw error;
  }
}
