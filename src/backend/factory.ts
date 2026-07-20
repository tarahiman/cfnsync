/**
 * T-10 backend/factory — 設定に応じた `StateBackend` の選択(FR-1-4)。
 *
 * design.md §4.5 の通り、`local` は設定ファイルと同階層の `cfnsync.state.json`、
 * `s3` は `state.s3` で指定したバケット/キーを対象にする。依存方向(`aws` /
 * `backend` は `ports` を実装)に従い、返り値は `StateBackend` 抽象で扱う。
 */

import { resolve } from 'node:path';
import { S3StateBackend } from '../aws/s3state.js';
import type { StateConfig } from '../core/config.js';
import { ConfigError } from '../core/errors.js';
import type { StateBackend } from '../ports/index.js';
import { LocalStateBackend } from './local.js';

/** `local` バックエンドのステートファイル名(設定ファイルと同階層)。 */
export const LOCAL_STATE_FILENAME = 'cfnsync.state.json';

export interface CreateStateBackendOptions {
  stateConfig: StateConfig;
  /** 設定ファイル(cfnsync.yaml)のディレクトリ。`local` のステート配置基準。 */
  configDir: string;
  /** `~/.aws/config` のプロファイル(s3 のみ利用。FR-7-1)。 */
  profile?: string;
}

/** 設定に応じて対応する `StateBackend` 実装を生成する(FR-1-4)。 */
export function createStateBackend(
  options: CreateStateBackendOptions,
): StateBackend {
  const { stateConfig, configDir, profile } = options;

  if (stateConfig.backend === 'local') {
    return new LocalStateBackend(resolve(configDir, LOCAL_STATE_FILENAME));
  }

  // backend === 's3'
  if (stateConfig.s3 === undefined) {
    // 通常は config の zod スキーマ(discriminatedUnion)で保証されるが、防御的に確認する。
    throw new ConfigError(
      'state.backend が s3 ですが、state.s3(bucket/key/region)が未設定です',
    );
  }
  return new S3StateBackend({
    bucket: stateConfig.s3.bucket,
    key: stateConfig.s3.key,
    region: stateConfig.s3.region,
    profile,
  });
}
