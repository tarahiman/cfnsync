import { defaultProvider } from '@aws-sdk/credential-provider-node';

export const DEFAULT_MAX_ATTEMPTS = 10;

/** AWS SDK クライアントに共通する接続・リトライ設定。 */
export function awsClientConfig(options: {
  region?: string;
  profile?: string;
  maxAttempts?: number;
}) {
  return {
    region: options.region,
    // NFR-3: スロットリングは SDK の adaptive retry + 指数バックオフで吸収する。
    retryMode: 'adaptive' as const,
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    // FR-7-1: profile 指定時のみ既定クレデンシャルチェーンに profile を適用する。
    // 未指定時は SDK 標準チェーン(環境変数 → プロファイル → IAM ロール)に委ねる(FR-7-2)。
    ...(options.profile !== undefined
      ? { credentials: defaultProvider({ profile: options.profile }) }
      : {}),
  };
}
