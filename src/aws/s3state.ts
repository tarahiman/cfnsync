/**
 * T-10 aws/s3state — `StateBackend`(ports)の `s3` 実装。
 *
 * design.md §4.5(バックエンドと排他制御)に対応する。CI・チーム利用向けに、
 * S3 の条件付き書き込み(`If-Match` / `If-None-Match`)で CAS(FR-1-6 s3)と
 * ロックオブジェクト(FR-1-7,8,9,10)を実現する。
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  PutObjectCommand,
  type PutObjectCommandOutput,
  S3Client,
} from '@aws-sdk/client-s3';
import { z } from 'zod';
import { AwsError, LockError, StateConflictError } from '../core/errors.js';
import {
  type CfnSyncState,
  parseState,
  serializeState,
  shortStateId,
} from '../core/state.js';
import type {
  LockHandle,
  LockInfo,
  StateBackend,
  StateVersion,
} from '../ports/index.js';
import { awsClientConfig } from './clientConfig.js';
import { errorName, httpStatus, toAwsError } from './errors.js';

/** `S3StateBackend` のコンストラクタオプション。 */
export interface S3StateBackendOptions {
  bucket: string;
  key: string;
  region: string;
  /** `~/.aws/config` のプロファイル(FR-7-1)。指定時のみ既定クレデンシャルチェーンに適用。 */
  profile?: string;
  /** SDK クライアントの maxAttempts(NFR-3)。既定 10。 */
  maxAttempts?: number;
}

const lockInfoSchema = z.object({
  runId: z.string().min(1),
  startedAt: z.string().min(1),
  owner: z.string().min(1),
});

const GET_LOCK_OPERATION = 'S3 GetObject(lock)';

function parseLockInfo(text: string, operation: string): LockInfo {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new AwsError(`Cannot parse the lock JSON for S3 ${operation}`, {
      cause,
    });
  }
  const parsed = lockInfoSchema.safeParse(json);
  if (!parsed.success) {
    throw new AwsError(`The lock JSON for S3 ${operation} is invalid`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** CAS / ロックの条件不成立(If-Match / If-None-Match 不成立)。HTTP 412。 */
function isPreconditionFailed(err: unknown): boolean {
  return errorName(err) === 'PreconditionFailed' || httpStatus(err) === 412;
}

/** 並行する条件付き書き込みの競合。HTTP 409。 */
function isConditionalConflict(err: unknown): boolean {
  return (
    errorName(err) === 'ConditionalRequestConflict' || httpStatus(err) === 409
  );
}

/** オブジェクト不存在。`NoSuchKey` / `NotFound` / HTTP 404。 */
function isNotFound(err: unknown): boolean {
  const name = errorName(err);
  return name === 'NoSuchKey' || name === 'NotFound' || httpStatus(err) === 404;
}

function requireEtag(etag: string | undefined, operation: string): string {
  if (etag === undefined || etag.length === 0) {
    throw new AwsError(
      `The S3 ${operation} response has no ETag. Aborting because the safety of the conditional operation cannot be confirmed (fail-closed)`,
    );
  }
  return etag;
}

export class S3StateBackend implements StateBackend {
  /** テスト・診断のために公開(retryMode / region の確認に使える)。 */
  readonly client: S3Client;

  private readonly bucket: string;
  private readonly key: string;
  private readonly lockKey: string;

  constructor(options: S3StateBackendOptions) {
    this.bucket = options.bucket;
    this.key = options.key;
    this.lockKey = `${options.key}.lock`;
    this.client = new S3Client(awsClientConfig(options));
  }

  private async getObject(
    key: string,
    operation: string,
  ): Promise<GetObjectCommandOutput | undefined> {
    try {
      return await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw toAwsError(operation, err);
    }
  }

  private async deleteLockIfMatch(
    etag: string,
    ownerChangedReason: string,
  ): Promise<{ released: boolean; reason?: string }> {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: this.lockKey,
          IfMatch: etag,
        }),
      );
      return { released: true };
    } catch (err) {
      if (isPreconditionFailed(err)) {
        return { released: false, reason: ownerChangedReason };
      }
      if (isNotFound(err)) {
        return { released: false, reason: 'The lock is already released' };
      }
      throw toAwsError('S3 DeleteObject(lock)', err);
    }
  }

  async load(): Promise<
    { state: CfnSyncState; version: StateVersion } | undefined
  > {
    const output = await this.getObject(this.key, 'S3 GetObject(state)');
    if (output === undefined) return undefined; // 初回(NoSuchKey)。
    const etag = requireEtag(output.ETag, 'GetObject(state)');
    const text = await output.Body?.transformToString();
    if (text === undefined) return undefined;
    // 破損(不完全 JSON・スキーマ不一致)は StateCorruptionError が伝播 = fail-closed。
    const state = parseState(text);
    return {
      state,
      version: { backend: 's3', generation: state.generation, etag },
    };
  }

  async save(
    state: CfnSyncState,
    expected: StateVersion | undefined,
  ): Promise<StateVersion> {
    // FR-1-6(s3): 既存版は If-Match、初回(ETag なし)は If-None-Match: * で作成する。
    if (expected?.backend === 'local') {
      throw new StateConflictError(
        'Cannot use a local backend state version for an S3 save',
      );
    }
    const condition = expected
      ? { IfMatch: expected.etag }
      : { IfNoneMatch: '*' };

    let output: PutObjectCommandOutput;
    try {
      output = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key,
          Body: serializeState(state),
          ContentType: 'application/json',
          ...condition,
        }),
      );
    } catch (err) {
      if (isPreconditionFailed(err) || isConditionalConflict(err)) {
        throw new StateConflictError(
          'The state has changed since it was read (an S3 conditional write conflicted). Aborting without overwriting',
          { cause: err },
        );
      }
      throw toAwsError('S3 PutObject(state)', err);
    }
    return {
      backend: 's3',
      generation: state.generation,
      etag: requireEtag(output.ETag, 'PutObject(state)'),
    };
  }

  async acquireLock(info: LockInfo): Promise<LockHandle> {
    // FR-1-7 / FR-1-10: <key>.lock を If-None-Match: * で作成し、内容に runId/startedAt/owner を書く。
    const body = JSON.stringify({
      runId: info.runId,
      startedAt: info.startedAt,
      owner: info.owner,
    });
    let output: PutObjectCommandOutput;
    try {
      output = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.lockKey,
          Body: body,
          ContentType: 'application/json',
          IfNoneMatch: '*',
        }),
      );
    } catch (err) {
      // 既存ロックあり(条件不成立)→ 他の書き込みを一切行わず即エラー。
      if (isPreconditionFailed(err) || isConditionalConflict(err)) {
        throw new LockError(
          'Could not acquire the state lock (another run holds it). Aborting',
          { cause: err },
        );
      }
      throw toAwsError('S3 PutObject(lock)', err);
    }
    return {
      backend: 's3',
      runId: info.runId,
      etag: requireEtag(output.ETag, 'PutObject(lock)'),
    };
  }

  async verifyLock(handle: LockHandle): Promise<boolean> {
    if (handle.backend !== 's3') return false;
    // FR-1-9: ロックを再読込し runId・ETag が自分と一致すれば所有権あり。消失・不一致は喪失。
    const output = await this.getObject(this.lockKey, GET_LOCK_OPERATION);
    if (output === undefined) return false;
    const etag = requireEtag(output.ETag, 'GetObject(lock)');
    const text = await output.Body?.transformToString();
    if (text === undefined) return false;
    try {
      const parsed = parseLockInfo(text, 'GetObject(lock)');
      return parsed.runId === handle.runId && etag === handle.etag;
    } catch {
      return false;
    }
  }

  async releaseLock(
    handle: LockHandle,
  ): Promise<{ released: boolean; reason?: string }> {
    // FR-1-8: DeleteObject If-Match: <取得時 ETag> による条件付き解放。
    if (handle.backend !== 's3' || handle.etag.length === 0) {
      return {
        released: false,
        reason:
          'Not performing a conditional release because the lock handle has no ETag (fail-closed)',
      };
    }
    return this.deleteLockIfMatch(
      handle.etag,
      'Did not release because the lock owner has changed',
    );
  }

  async readLock(): Promise<LockInfo | undefined> {
    const output = await this.getObject(this.lockKey, GET_LOCK_OPERATION);
    if (output === undefined) return undefined;
    requireEtag(output.ETag, 'GetObject(lock)');
    const text = await output.Body?.transformToString();
    if (text === undefined) return undefined;
    return parseLockInfo(text, 'GetObject(lock)');
  }

  async forceUnlock(
    runId: string,
  ): Promise<{ released: boolean; reason?: string }> {
    // FR-1-8 / §5.6: ロックを読み、記録された runId が一致する場合のみ、読み取り時の ETag による
    // If-Match 条件付き削除で解放する。不一致なら DeleteObject を一切呼ばない。
    const output = await this.getObject(this.lockKey, GET_LOCK_OPERATION);
    if (output === undefined)
      return { released: false, reason: 'The lock does not exist' };
    const etag = requireEtag(output.ETag, 'GetObject(lock)');
    const text = await output.Body?.transformToString();
    if (text === undefined)
      return { released: false, reason: 'The lock does not exist' };

    let parsed: LockInfo;
    try {
      parsed = parseLockInfo(text, 'GetObject(lock)');
    } catch {
      return { released: false, reason: 'Cannot parse the lock contents' };
    }
    if (parsed.runId !== runId) {
      return {
        released: false,
        reason: `The specified run ID (${runId}) does not match the current lock (${parsed.runId ?? '(unknown)'})`,
      };
    }

    return this.deleteLockIfMatch(
      etag,
      'Did not release because the lock owner changed after it was read',
    );
  }

  stateId(): string {
    // §7: s3 のステート識別子は bucket + key(リージョンは含めない)。
    return shortStateId(`${this.bucket}/${this.key}`);
  }
}
