/**
 * T-10 aws/s3state — S3StateBackend のテスト(tasks.md §5 T-10 の対応表)。
 *
 * 実 AWS には接続せず `aws-sdk-client-mock` で `send` をスタブする(§10)。
 * PutObject / DeleteObject の入力に IfMatch / IfNoneMatch が正しく渡ることを
 * `commandCalls` で検証する。各 it の先頭に対応する受け入れ基準 ID を明記する。
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { S3StateBackend } from '../../src/aws/s3state.js';
import {
  AwsError,
  LockError,
  StateConflictError,
} from '../../src/core/errors.js';
import {
  type CfnSyncState,
  createInitialState,
  serializeState,
} from '../../src/core/state.js';
import type { LockInfo } from '../../src/ports/index.js';

const s3Mock = mockClient(S3Client);

const BUCKET = 'my-cfnsync-state';
const KEY = 'prod/cfnsync.state.json';
const LOCK_KEY = `${KEY}.lock`;

beforeEach(() => {
  s3Mock.reset();
});

function makeBackend(): S3StateBackend {
  return new S3StateBackend({
    bucket: BUCKET,
    key: KEY,
    region: 'ap-northeast-1',
  });
}

function stateWith(
  generation: number,
  accountId = '123456789012',
): CfnSyncState {
  return { ...createInitialState(), accountId, generation };
}

/** GetObject の Body(SDK は transformToString を提供する)を模す。 */
function bodyOf(text: string): { transformToString: () => Promise<string> } {
  return { transformToString: async () => text };
}

function preconditionFailed(): Error {
  return Object.assign(
    new Error('At least one of the preconditions you specified did not hold'),
    {
      name: 'PreconditionFailed',
      $metadata: { httpStatusCode: 412 },
    },
  );
}

function conditionalConflict(): Error {
  return Object.assign(new Error('conditional request conflict'), {
    name: 'ConditionalRequestConflict',
    $metadata: { httpStatusCode: 409 },
  });
}

function noSuchKey(): Error {
  return Object.assign(new Error('The specified key does not exist.'), {
    name: 'NoSuchKey',
    $metadata: { httpStatusCode: 404 },
  });
}

const LOCK_INFO: LockInfo = {
  runId: 'run-1',
  startedAt: '2026-07-19T00:00:00Z',
  owner: 'ci@github',
};

describe('S3StateBackend load/save (FR-1-6 s3)', () => {
  it('load: NoSuchKey は undefined、それ以外は ETag を version に保持する', async () => {
    s3Mock.on(GetObjectCommand, { Key: KEY }).rejects(noSuchKey());
    expect(await makeBackend().load()).toBeUndefined();

    s3Mock.reset();
    s3Mock.on(GetObjectCommand, { Key: KEY }).resolves({
      Body: bodyOf(serializeState(stateWith(4))),
      ETag: '"etag-4"',
    } as never);
    const loaded = await makeBackend().load();
    expect(loaded?.state.generation).toBe(4);
    expect(loaded?.version).toEqual({ generation: 4, etag: '"etag-4"' });
  });

  it('FR-1-6(s3): 既存版の保存は PutObject If-Match: <読込時 ETag> で行い、新 ETag を返す', async () => {
    s3Mock.on(PutObjectCommand, { Key: KEY }).resolves({ ETag: '"etag-5"' });
    const version = await makeBackend().save(stateWith(5), {
      generation: 4,
      etag: '"etag-4"',
    });

    expect(version).toEqual({ generation: 5, etag: '"etag-5"' });
    const call = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
    expect(call.IfMatch).toBe('"etag-4"');
    expect(call.IfNoneMatch).toBeUndefined();
  });

  it('FR-1-6(s3): 初回保存(expected undefined)は If-None-Match: * で新規作成する', async () => {
    s3Mock.on(PutObjectCommand, { Key: KEY }).resolves({ ETag: '"etag-1"' });
    await makeBackend().save(stateWith(1), undefined);

    const call = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
    expect(call.IfNoneMatch).toBe('*');
    expect(call.IfMatch).toBeUndefined();
  });

  it('FR-1-6(s3): PreconditionFailed(412)→ StateConflictError(上書きされない)', async () => {
    s3Mock.on(PutObjectCommand, { Key: KEY }).rejects(preconditionFailed());
    await expect(
      makeBackend().save(stateWith(5), { generation: 4, etag: '"etag-4"' }),
    ).rejects.toBeInstanceOf(StateConflictError);
  });

  it('FR-1-6(s3): ConditionalRequestConflict(409)も競合として StateConflictError', async () => {
    s3Mock.on(PutObjectCommand, { Key: KEY }).rejects(conditionalConflict());
    await expect(
      makeBackend().save(stateWith(2), undefined),
    ).rejects.toBeInstanceOf(StateConflictError);
  });
});

describe('S3StateBackend lock (FR-1-7 / FR-1-8 / FR-1-9 / FR-1-10)', () => {
  it('FR-1-7 / FR-1-10: acquireLock は <key>.lock を If-None-Match: * で作成し、内容に runId/startedAt/owner を書く', async () => {
    s3Mock
      .on(PutObjectCommand, { Key: LOCK_KEY })
      .resolves({ ETag: '"lock-1"' });
    const handle = await makeBackend().acquireLock(LOCK_INFO);

    expect(handle).toEqual({ runId: 'run-1', etag: '"lock-1"' });
    const call = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
    expect(call.Key).toBe(LOCK_KEY);
    expect(call.IfNoneMatch).toBe('*');
    expect(JSON.parse(call.Body as string)).toEqual({
      runId: 'run-1',
      startedAt: '2026-07-19T00:00:00Z',
      owner: 'ci@github',
    });
  });

  it('FR-1-7: 既存ロックあり(PreconditionFailed)→ LockError、他の書き込みは発生しない', async () => {
    s3Mock
      .on(PutObjectCommand, { Key: LOCK_KEY })
      .rejects(preconditionFailed());
    await expect(makeBackend().acquireLock(LOCK_INFO)).rejects.toBeInstanceOf(
      LockError,
    );

    // ロック取得失敗時にステート保存等の他の PutObject が発生しないこと。
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  it('FR-1-8: acquireLock のレスポンスに ETag がなければ fail-closed で失敗する', async () => {
    s3Mock.on(PutObjectCommand, { Key: LOCK_KEY }).resolves({});

    await expect(makeBackend().acquireLock(LOCK_INFO)).rejects.toBeInstanceOf(
      AwsError,
    );
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  it('FR-1-8: releaseLock は DeleteObject If-Match: <取得時 ETag> で解放する', async () => {
    s3Mock.on(DeleteObjectCommand, { Key: LOCK_KEY }).resolves({});
    const result = await makeBackend().releaseLock({
      runId: 'run-1',
      etag: '"lock-1"',
    });

    expect(result).toEqual({ released: true });
    const call = s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input;
    expect(call.Key).toBe(LOCK_KEY);
    expect(call.IfMatch).toBe('"lock-1"');
  });

  it('FR-1-8: ETag のない handle は解放を拒否し DeleteObject を呼ばない', async () => {
    const result = await makeBackend().releaseLock({ runId: 'run-1' });

    expect(result.released).toBe(false);
    expect(result.reason).toMatch(/ETag/);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  it('FR-1-8: 条件不成立(所有者交代・412)→ 削除せず released:false を報告する', async () => {
    s3Mock
      .on(DeleteObjectCommand, { Key: LOCK_KEY })
      .rejects(preconditionFailed());
    const result = await makeBackend().releaseLock({
      runId: 'run-1',
      etag: '"lock-1"',
    });

    expect(result.released).toBe(false);
    expect(result.reason).toBeTruthy();
    // DeleteObject は「呼ばれたが条件不成立」。
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  });

  it('FR-1-7(冪等): releaseLock を 2 回呼んでもエラーにならない', async () => {
    s3Mock
      .on(DeleteObjectCommand, { Key: LOCK_KEY })
      .resolvesOnce({})
      .rejects(noSuchKey());
    const backend = makeBackend();
    const first = await backend.releaseLock({
      runId: 'run-1',
      etag: '"lock-1"',
    });
    const second = await backend.releaseLock({
      runId: 'run-1',
      etag: '"lock-1"',
    });
    expect(first.released).toBe(true);
    expect(second.released).toBe(false);
  });

  it('FR-1-10: readLock はロックオブジェクトの内容を返す(未ロックは undefined)', async () => {
    s3Mock.on(GetObjectCommand, { Key: LOCK_KEY }).rejects(noSuchKey());
    expect(await makeBackend().readLock()).toBeUndefined();

    s3Mock.reset();
    s3Mock.on(GetObjectCommand, { Key: LOCK_KEY }).resolves({
      Body: bodyOf(JSON.stringify(LOCK_INFO)),
      ETag: '"lock-1"',
    } as never);
    expect(await makeBackend().readLock()).toEqual(LOCK_INFO);
  });

  it('FR-1-9(基盤): verifyLock は runId・ETag が一致すれば true、不一致・消失は false', async () => {
    const handle = { runId: 'run-1', etag: '"lock-1"' };

    // 一致 → true。
    s3Mock.on(GetObjectCommand, { Key: LOCK_KEY }).resolves({
      Body: bodyOf(JSON.stringify(LOCK_INFO)),
      ETag: '"lock-1"',
    } as never);
    expect(await makeBackend().verifyLock(handle)).toBe(true);

    // runId 不一致 → false。
    s3Mock.reset();
    s3Mock.on(GetObjectCommand, { Key: LOCK_KEY }).resolves({
      Body: bodyOf(JSON.stringify({ ...LOCK_INFO, runId: 'run-2' })),
      ETag: '"lock-1"',
    } as never);
    expect(await makeBackend().verifyLock(handle)).toBe(false);

    // ETag 不一致(所有者交代)→ false。
    s3Mock.reset();
    s3Mock.on(GetObjectCommand, { Key: LOCK_KEY }).resolves({
      Body: bodyOf(JSON.stringify(LOCK_INFO)),
      ETag: '"lock-2"',
    } as never);
    expect(await makeBackend().verifyLock(handle)).toBe(false);

    // ロック消失 → false。
    s3Mock.reset();
    s3Mock.on(GetObjectCommand, { Key: LOCK_KEY }).rejects(noSuchKey());
    expect(await makeBackend().verifyLock(handle)).toBe(false);
  });
});

describe('S3StateBackend forceUnlock (FR-1-8, T-17 基盤)', () => {
  it('runId 一致 → 読み取り時 ETag による If-Match 条件付き削除で解放する', async () => {
    s3Mock.on(GetObjectCommand, { Key: LOCK_KEY }).resolves({
      Body: bodyOf(JSON.stringify(LOCK_INFO)),
      ETag: '"lock-1"',
    } as never);
    s3Mock.on(DeleteObjectCommand, { Key: LOCK_KEY }).resolves({});

    const result = await makeBackend().forceUnlock('run-1');
    expect(result).toEqual({ released: true });
    const call = s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input;
    expect(call.IfMatch).toBe('"lock-1"');
  });

  it('runId 不一致 → DeleteObject 自体が呼ばれない', async () => {
    s3Mock.on(GetObjectCommand, { Key: LOCK_KEY }).resolves({
      Body: bodyOf(JSON.stringify(LOCK_INFO)),
      ETag: '"lock-1"',
    } as never);

    const result = await makeBackend().forceUnlock('other-run');
    expect(result.released).toBe(false);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  it('読み取りレスポンスに ETag がなければ fail-closed で失敗し DeleteObject を呼ばない', async () => {
    s3Mock.on(GetObjectCommand, { Key: LOCK_KEY }).resolves({
      Body: bodyOf(JSON.stringify(LOCK_INFO)),
    } as never);

    await expect(makeBackend().forceUnlock('run-1')).rejects.toBeInstanceOf(
      AwsError,
    );
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  it('読み取り〜削除間の所有者交代(412)→ 削除せず報告する', async () => {
    s3Mock.on(GetObjectCommand, { Key: LOCK_KEY }).resolves({
      Body: bodyOf(JSON.stringify(LOCK_INFO)),
      ETag: '"lock-1"',
    } as never);
    s3Mock
      .on(DeleteObjectCommand, { Key: LOCK_KEY })
      .rejects(preconditionFailed());

    const result = await makeBackend().forceUnlock('run-1');
    expect(result.released).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe('S3StateBackend stateId', () => {
  it('bucket/key から安定な短縮ハッシュを導出する', () => {
    const a = new S3StateBackend({
      bucket: BUCKET,
      key: KEY,
      region: 'ap-northeast-1',
    }).stateId();
    const b = new S3StateBackend({
      bucket: BUCKET,
      key: KEY,
      region: 'us-east-1',
    }).stateId();
    const c = new S3StateBackend({
      bucket: BUCKET,
      key: 'other.json',
      region: 'ap-northeast-1',
    }).stateId();
    expect(a).toMatch(/^[0-9a-f]{8,16}$/);
    expect(a).toBe(b); // region はステート識別子に含めない(bucket + key のみ)。
    expect(a).not.toBe(c);
  });
});
