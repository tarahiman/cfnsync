/**
 * T-10 backend/local — `StateBackend`(ports)の `local` 実装。
 *
 * design.md §4.5(バックエンドと排他制御)に対応する。`local` は単一環境前提で
 * ロックを持たず、CAS は「保存直前の再読込による世代比較」で行う(FR-1-6 local)。
 * 保存は同一ディレクトリの一時ファイル + fsync + rename による原子的置換で行い、
 * 直前の内容を `.bak` として保持する(FR-1-12 local)。破損の検出は `parseState`
 * が `StateCorruptionError` を投げることで fail-closed になる(FR-1-12)。
 */

import { existsSync } from 'node:fs';
import { copyFile, open, readFile, rename } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { StateConflictError } from '../core/errors.js';
import {
  parseState,
  serializeState,
  sha256Hex,
  type CfnSyncState,
} from '../core/state.js';
import type { LockHandle, LockInfo, StateBackend, StateVersion } from '../ports/index.js';

/** テスト用の注入点。実運用では未指定(既定 no-op)。 */
export interface LocalStateBackendOptions {
  /**
   * 原子的置換の rename 直前に呼ばれるフック。テストで「書き込み途中の中断」を
   * 模すために例外を注入する(FR-1-12。design §10 の障害注入)。
   */
  onBeforeRename?: () => void | Promise<void>;
}

/** バックエンド識別子から変更セット命名用の短縮ハッシュを導出する(§7)。 */
function shortStateId(identifier: string): string {
  return sha256Hex(identifier).replace(/^sha256:/, '').slice(0, 12);
}

export class LocalStateBackend implements StateBackend {
  /** ステートファイルの絶対パス(stateId・原子的置換の基準)。 */
  private readonly statePath: string;
  private readonly onBeforeRename?: () => void | Promise<void>;

  constructor(statePath: string, options: LocalStateBackendOptions = {}) {
    this.statePath = resolve(statePath);
    this.onBeforeRename = options.onBeforeRename;
  }

  async load(): Promise<{ state: CfnSyncState; version: StateVersion } | undefined> {
    let text: string;
    try {
      text = await readFile(this.statePath, 'utf8');
    } catch (err) {
      if (isFileNotFound(err)) return undefined;
      throw err;
    }
    // 破損(不完全 JSON・スキーマ不一致)は StateCorruptionError が伝播 = fail-closed。
    const state = parseState(text);
    return { state, version: { generation: state.generation } };
  }

  async save(state: CfnSyncState, expected: StateVersion | undefined): Promise<StateVersion> {
    // FR-1-6(local): 保存直前に再読込して世代を比較し、競合は上書きせずエラーとする。
    const current = await this.readCurrentGeneration();

    if (expected === undefined) {
      // 初回作成: 不存在時のみ成立(既にあれば他者が作成済み = 競合)。
      if (current !== undefined) {
        throw new StateConflictError(
          'ステートが既に存在します(初回作成の前提が崩れています)。他の実行が作成した可能性があります',
        );
      }
    } else {
      // 読込時点の世代と一致しなければ競合。ファイル消失も検証不能として競合扱い。
      if (current === undefined || current !== expected.generation) {
        throw new StateConflictError(
          `ステートの世代が読込時点(${expected.generation})から変化しています(現在: ${
            current ?? '不明(消失)'
          })。他の実行によって変更された可能性があります`,
        );
      }
    }

    await this.writeAtomic(serializeState(state));
    return { generation: state.generation };
  }

  // ---- ロック(local は単一環境前提でロックを持たない。design §4.5) ------------

  async acquireLock(info: LockInfo): Promise<LockHandle> {
    return { runId: info.runId };
  }

  async verifyLock(_handle: LockHandle): Promise<boolean> {
    return true;
  }

  async releaseLock(_handle: LockHandle): Promise<{ released: boolean; reason?: string }> {
    return { released: true };
  }

  async readLock(): Promise<LockInfo | undefined> {
    return undefined;
  }

  async forceUnlock(_runId: string): Promise<{ released: boolean; reason?: string }> {
    return { released: false, reason: 'local backend has no lock' };
  }

  stateId(): string {
    return shortStateId(this.statePath);
  }

  // ---- 内部ヘルパ ----------------------------------------------------------

  /** 現在ディスク上のステートの世代を返す(未存在は undefined)。破損は伝播(fail-closed)。 */
  private async readCurrentGeneration(): Promise<number | undefined> {
    let text: string;
    try {
      text = await readFile(this.statePath, 'utf8');
    } catch (err) {
      if (isFileNotFound(err)) return undefined;
      throw err;
    }
    return parseState(text).generation;
  }

  /**
   * 一時ファイル + fsync + rename による原子的置換(FR-1-12)。直前の内容を `.bak`
   * として保持する。rename の直前で中断(onBeforeRename 例外)しても、元ファイルは
   * 無傷で一時ファイルだけが残る。
   */
  private async writeAtomic(content: string): Promise<void> {
    const dir = dirname(this.statePath);
    const tmpPath = join(dir, `.${basename(this.statePath)}.tmp.${randomBytes(6).toString('hex')}`);

    // 一時ファイルへ書き込み、fsync してからクローズする。
    const handle = await open(tmpPath, 'w');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    // 障害注入点: ここで中断すると元ファイルは無傷・一時ファイルだけが残る。
    if (this.onBeforeRename) await this.onBeforeRename();

    // 直前の内容を .bak として保持(置換対象が存在する場合のみ)。
    if (existsSync(this.statePath)) {
      await copyFile(this.statePath, `${this.statePath}.bak`);
    }

    // 原子的置換。
    await rename(tmpPath, this.statePath);
  }
}

function isFileNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
