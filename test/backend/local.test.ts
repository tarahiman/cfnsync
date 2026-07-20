/**
 * T-10 backend/local — LocalStateBackend のテスト(tasks.md §5 T-10 の対応表)。
 *
 * 実ファイルをテンポラリディレクトリ(`fs.mkdtempSync`)で操作し、実 AWS には
 * 接続しない(§10)。各 it の先頭に対応する受け入れ基準 ID を明記する。
 */

import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { S3StateBackend } from '../../src/aws/s3state.js';
import { LocalStateBackend } from '../../src/backend/local.js';
import { defaultCliDependencies } from '../../src/cli/dependencies.js';
import type { CfnSyncConfig } from '../../src/core/config.js';
import { StateConflictError } from '../../src/core/errors.js';
import {
  type CfnSyncState,
  createInitialState,
  parseState,
  StateCorruptionError,
  serializeState,
} from '../../src/core/state.js';

const STATE_FILE = 'cfnsync.state.json';

let dir: string;
let statePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cfnsync-local-'));
  statePath = join(dir, STATE_FILE);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 世代 generation を持つ空ステートを作る。 */
function stateWith(
  generation: number,
  accountId = '123456789012',
): CfnSyncState {
  return { ...createInitialState(), accountId, generation };
}

describe('LocalStateBackend', () => {
  it('FR-1-4: load はファイル未存在なら undefined を返す', async () => {
    const backend = new LocalStateBackend(statePath);
    expect(await backend.load()).toBeUndefined();
  });

  it('FR-1-4: load/save で保存したステートを読み戻せる(version は generation)', async () => {
    const backend = new LocalStateBackend(statePath);
    const version = await backend.save(stateWith(1), undefined);
    expect(version).toEqual({ generation: 1 });

    const loaded = await backend.load();
    expect(loaded?.state.generation).toBe(1);
    expect(loaded?.version).toEqual({ generation: 1 });
  });

  it('FR-1-6(local): 保存直前の再読込で世代不一致 → StateConflictError、ファイルは書き換わらない', async () => {
    const backend = new LocalStateBackend(statePath);
    await backend.save(stateWith(1), undefined);
    const loaded = await backend.load();
    expect(loaded?.version).toEqual({ generation: 1 });

    // 別プロセスを模して外部から世代 2 で上書きする。
    const externalText = serializeState(stateWith(2));
    writeFileSync(statePath, externalText);

    // 読込時点(generation 1)に基づく保存は、再読込した世代 2 と不一致で競合する。
    await expect(
      backend.save(stateWith(9), loaded!.version),
    ).rejects.toBeInstanceOf(StateConflictError);

    // 競合時はファイルが書き換わらない(外部が書いた世代 2 のまま)。
    expect(readFileSync(statePath, 'utf8')).toBe(externalText);
  });

  it('FR-1-6(local): 初回保存(expected undefined)で既にファイルがあれば競合', async () => {
    writeFileSync(statePath, serializeState(stateWith(3)));
    const backend = new LocalStateBackend(statePath);
    await expect(backend.save(stateWith(1), undefined)).rejects.toBeInstanceOf(
      StateConflictError,
    );
  });

  it('FR-1-6(local再レビュー⑥): 並行する2プロセス相当の save は O_EXCL mutex により一方が必ず StateConflictError', async () => {
    const seed = new LocalStateBackend(statePath);
    await seed.save(stateWith(1), undefined);
    const loaded = await seed.load();
    let releaseRename!: () => void;
    const renameGate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    let reachedRename!: () => void;
    const renameReached = new Promise<void>((resolve) => {
      reachedRename = resolve;
    });
    const first = new LocalStateBackend(statePath, {
      onBeforeRename: async () => {
        reachedRename();
        await renameGate;
      },
    });
    const second = new LocalStateBackend(statePath);

    const firstSave = first.save(stateWith(2), loaded!.version);
    await renameReached;
    await expect(
      second.save(stateWith(3), loaded!.version),
    ).rejects.toBeInstanceOf(StateConflictError);
    releaseRename();
    await expect(firstSave).resolves.toEqual({ generation: 2 });
  });

  it('FR-1-12(local): 原子的置換で .bak に直前の内容が残る', async () => {
    const backend = new LocalStateBackend(statePath);
    await backend.save(stateWith(1), undefined); // 初回: 置換対象なし → .bak なし
    const loaded = await backend.load();

    await backend.save(stateWith(2), loaded!.version);

    // 現行は世代 2、直前(世代 1)は .bak に保持される。
    expect(parseState(readFileSync(statePath, 'utf8')).generation).toBe(2);
    expect(
      parseState(readFileSync(`${statePath}.bak`, 'utf8')).generation,
    ).toBe(1);
  });

  it('FR-1-12(local): rename 直前に中断しても元ファイルが無傷で、一時ファイルだけが残る', async () => {
    const seed = new LocalStateBackend(statePath);
    await seed.save(stateWith(1), undefined);
    const loaded = await seed.load();

    // rename の直前に例外を注入して「書き込み途中の中断」を模す。
    const backend = new LocalStateBackend(statePath, {
      onBeforeRename: () => {
        throw new Error('injected crash before rename');
      },
    });
    await expect(backend.save(stateWith(2), loaded!.version)).rejects.toThrow(
      'injected crash before rename',
    );

    // 元ファイルは無傷(世代 1)。
    expect(parseState(readFileSync(statePath, 'utf8')).generation).toBe(1);
    // rename されなかった一時ファイルがディレクトリに残る。
    const strays = readdirSync(dir).filter(
      (f) => f !== STATE_FILE && f.includes('.tmp'),
    );
    expect(strays.length).toBeGreaterThan(0);
  });

  it('FR-1-12(local): 破損ファイルの読込は fail-closed(StateCorruptionError)', async () => {
    writeFileSync(statePath, '{ this is not valid json');
    const backend = new LocalStateBackend(statePath);
    await expect(backend.load()).rejects.toBeInstanceOf(StateCorruptionError);
  });

  it('FR-1-7: local はロックを持たず取得は常に成功・検証は常に true', async () => {
    const backend = new LocalStateBackend(statePath);
    const handle = await backend.acquireLock({
      runId: 'r1',
      startedAt: '2026-07-19T00:00:00Z',
      owner: 'ci',
    });
    expect(handle.runId).toBe('r1');
    expect(await backend.verifyLock(handle)).toBe(true);
    expect(await backend.releaseLock(handle)).toEqual({ released: true });
    expect(await backend.readLock()).toBeUndefined();
    expect(await backend.forceUnlock('r1')).toEqual({
      released: false,
      reason: 'local backend has no lock',
    });
  });

  it('internal: stateId はステートファイル絶対パスから安定な短縮ハッシュを導出する', async () => {
    const a = new LocalStateBackend(statePath).stateId();
    const b = new LocalStateBackend(statePath).stateId();
    const other = new LocalStateBackend(
      join(dir, 'other.state.json'),
    ).stateId();
    expect(a).toMatch(/^[0-9a-f]{8,16}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(other);
  });
});

describe('createStateBackend (FR-1-4)', () => {
  it('FR-1-4: backend: local → LocalStateBackend が選択される', () => {
    const config: CfnSyncConfig = {
      version: 1,
      defaultRegion: 'ap-northeast-1',
      state: { backend: 'local' },
      stacks: {},
    };
    const backend = defaultCliDependencies.createBackend({
      config,
      configDir: dir,
    });
    expect(backend).toBeInstanceOf(LocalStateBackend);
  });

  it('FR-1-4: backend: s3 → S3StateBackend が選択される', () => {
    const config: CfnSyncConfig = {
      version: 1,
      defaultRegion: 'ap-northeast-1',
      state: {
        backend: 's3',
        s3: {
          bucket: 'my-state',
          key: 'prod/cfnsync.state.json',
          region: 'ap-northeast-1',
        },
      },
      stacks: {},
    };
    const backend = defaultCliDependencies.createBackend({
      config,
      configDir: dir,
    });
    expect(backend).toBeInstanceOf(S3StateBackend);
  });
});
