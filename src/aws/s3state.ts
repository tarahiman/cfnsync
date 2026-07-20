/**
 * T-10 aws/s3state — `StateBackend`(ports)の `s3` 実装。
 *
 * design.md §4.5(バックエンドと排他制御)に対応する。CI・チーム利用向けに、
 * S3 の条件付き書き込み(`If-Match` / `If-None-Match`)で CAS(FR-1-6 s3)と
 * ロックオブジェクト(FR-1-7,8,9,10)を実現する。SDK クライアントは
 * cloudformation.ts と同じ流儀(retryMode adaptive)で構成する。
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  PutObjectCommand,
  type PutObjectCommandOutput,
  S3Client,
} from '@aws-sdk/client-s3';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { AwsError, LockError, StateConflictError } from '../core/errors.js';
import {
  type CfnSyncState,
  parseState,
  serializeState,
  sha256Hex,
} from '../core/state.js';
import type {
  LockHandle,
  LockInfo,
  StateBackend,
  StateVersion,
} from '../ports/index.js';

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

/** バックエンド識別子から変更セット命名用の短縮ハッシュを導出する(§7)。 */
function shortStateId(identifier: string): string {
  return sha256Hex(identifier)
    .replace(/^sha256:/, '')
    .slice(0, 12);
}

function errorName(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'name' in err
    ? ((err as { name?: unknown }).name as string | undefined)
    : undefined;
}

function httpStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && '$metadata' in err) {
    const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
    return meta?.httpStatusCode;
  }
  return undefined;
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
      `S3 ${operation} レスポンスに ETag がありません。条件付き操作の安全性を確認できないため中断します(fail-closed)`,
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
    this.client = new S3Client({
      region: options.region,
      // NFR-3: スロットリングに指数バックオフでリトライ(cloudformation.ts と同流儀)。
      retryMode: 'adaptive',
      maxAttempts: options.maxAttempts ?? 10,
      // FR-7-1: profile 指定時のみ既定クレデンシャルチェーンに profile を適用。
      ...(options.profile !== undefined
        ? { credentials: defaultProvider({ profile: options.profile }) }
        : {}),
    });
  }

  async load(): Promise<
    { state: CfnSyncState; version: StateVersion } | undefined
  > {
    let output: GetObjectCommandOutput;
    try {
      output = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key }),
      );
    } catch (err) {
      if (isNotFound(err)) return undefined; // 初回(NoSuchKey)。
      throw err;
    }
    const etag = requireEtag(output.ETag, 'GetObject(state)');
    const text = await output.Body?.transformToString();
    if (text === undefined) return undefined;
    // 破損(不完全 JSON・スキーマ不一致)は StateCorruptionError が伝播 = fail-closed。
    const state = parseState(text);
    return {
      state,
      version: { generation: state.generation, etag },
    };
  }

  async save(
    state: CfnSyncState,
    expected: StateVersion | undefined,
  ): Promise<StateVersion> {
    // FR-1-6(s3): 既存版は If-Match、初回(ETag なし)は If-None-Match: * で作成する。
    const condition = expected
      ? { IfMatch: requireEtag(expected.etag, 'state version') }
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
          'ステートが読込時点から変更されています(S3 条件付き書き込みが競合しました)。上書きせず中断します',
          { cause: err },
        );
      }
      throw err;
    }
    return {
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
          'ステートロックを取得できませんでした(他の実行が保持しています)。実行を中断します',
          { cause: err },
        );
      }
      throw err;
    }
    return {
      runId: info.runId,
      etag: requireEtag(output.ETag, 'PutObject(lock)'),
    };
  }

  async verifyLock(handle: LockHandle): Promise<boolean> {
    // FR-1-9: ロックを再読込し runId・ETag が自分と一致すれば所有権あり。消失・不一致は喪失。
    let output: GetObjectCommandOutput;
    try {
      output = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.lockKey }),
      );
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
    const etag = requireEtag(output.ETag, 'GetObject(lock)');
    const text = await output.Body?.transformToString();
    if (text === undefined) return false;
    let parsed: { runId?: string };
    try {
      parsed = JSON.parse(text) as { runId?: string };
    } catch {
      return false;
    }
    return parsed.runId === handle.runId && etag === handle.etag;
  }

  async releaseLock(
    handle: LockHandle,
  ): Promise<{ released: boolean; reason?: string }> {
    // FR-1-8: DeleteObject If-Match: <取得時 ETag> による条件付き解放。
    if (handle.etag === undefined || handle.etag.length === 0) {
      return {
        released: false,
        reason:
          'ロック handle に ETag がないため条件付き解放を実行しません(fail-closed)',
      };
    }
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: this.lockKey,
          IfMatch: handle.etag,
        }),
      );
      return { released: true };
    } catch (err) {
      if (isPreconditionFailed(err)) {
        return {
          released: false,
          reason: 'ロックの所有者が交代しているため解放しませんでした',
        };
      }
      if (isNotFound(err)) {
        // 冪等: 既に解放済み。エラーにしない。
        return { released: false, reason: 'ロックは既に解放済みです' };
      }
      throw err;
    }
  }

  async readLock(): Promise<LockInfo | undefined> {
    let output: GetObjectCommandOutput;
    try {
      output = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.lockKey }),
      );
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
    requireEtag(output.ETag, 'GetObject(lock)');
    const text = await output.Body?.transformToString();
    if (text === undefined) return undefined;
    const parsed = JSON.parse(text) as LockInfo;
    return {
      runId: parsed.runId,
      startedAt: parsed.startedAt,
      owner: parsed.owner,
    };
  }

  async forceUnlock(
    runId: string,
  ): Promise<{ released: boolean; reason?: string }> {
    // FR-1-8 / §5.6: ロックを読み、記録された runId が一致する場合のみ、読み取り時の ETag による
    // If-Match 条件付き削除で解放する。不一致なら DeleteObject を一切呼ばない。
    let output: GetObjectCommandOutput;
    try {
      output = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.lockKey }),
      );
    } catch (err) {
      if (isNotFound(err))
        return { released: false, reason: 'ロックは存在しません' };
      throw err;
    }
    const etag = requireEtag(output.ETag, 'GetObject(lock)');
    const text = await output.Body?.transformToString();
    if (text === undefined)
      return { released: false, reason: 'ロックは存在しません' };

    let parsed: { runId?: string };
    try {
      parsed = JSON.parse(text) as { runId?: string };
    } catch {
      return { released: false, reason: 'ロックの内容を解析できません' };
    }
    if (parsed.runId !== runId) {
      return {
        released: false,
        reason: `指定された実行 ID(${runId})は現在のロック(${parsed.runId ?? '不明'})と一致しません`,
      };
    }

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
        return {
          released: false,
          reason: '読み取り後にロックの所有者が交代したため解放しませんでした',
        };
      }
      if (isNotFound(err)) {
        return { released: false, reason: 'ロックは既に解放済みです' };
      }
      throw err;
    }
  }

  stateId(): string {
    // §7: s3 のステート識別子は bucket + key(リージョンは含めない)。
    return shortStateId(`${this.bucket}/${this.key}`);
  }
}
