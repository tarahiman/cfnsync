/**
 * T-09 aws/StsGateway — `StsGateway`(ports)の SDK v3 実装。
 *
 * design.md §8.1(AccountGuard)/ requirements.md FR-7-6 に対応する。STS
 * `GetCallerIdentity` で接続先アカウントを解決するだけの薄いゲートウェイで、
 * 解決失敗(認証エラー等)はそのまま呼び出し元に伝播させる(§7 の記述どおり、
 * fail-closed 判定は usecase/guard(T-12)側の責務)。
 *
 * プロファイル・リージョンの扱いは `src/aws/cloudformation.ts` の流儀に合わせる:
 * `profile` 指定時のみ `@aws-sdk/credential-provider-node` の `defaultProvider`
 * を既定クレデンシャルチェーンに適用し、未指定時は SDK 標準チェーン(環境変数 →
 * プロファイル → IAM ロール)に委ねる(FR-7-1, FR-7-2)。`region` は CLI・環境変数・
 * 設定ファイルいずれの指定も許容するため任意とし、未指定時は SDK の標準解決に
 * 委ねる(FR-7-3)。
 */

import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import type { StsGateway } from '../ports/index.js';
import { toAwsError } from './errors.js';

/** `StsGatewayImpl` のコンストラクタオプション。 */
export interface StsGatewayOptions {
  region?: string;
  /** `~/.aws/config` のプロファイル(FR-7-1)。指定時は既定クレデンシャルチェーンに profile を適用。 */
  profile?: string;
}

export class StsGatewayImpl implements StsGateway {
  /** テスト・診断のために公開(region / credentials の伝播を確認できる)。 */
  readonly client: STSClient;

  constructor(options: StsGatewayOptions = {}) {
    this.client = new STSClient({
      region: options.region,
      // FR-7-1: profile 指定時のみ、既定クレデンシャルチェーンに profile を適用する。
      // 未指定時は SDK 標準チェーン(環境変数 → プロファイル → IAM ロール)に委ねる(FR-7-2)。
      ...(options.profile !== undefined
        ? { credentials: defaultProvider({ profile: options.profile }) }
        : {}),
    });
  }

  /** FR-7-6: 接続先アカウントを解決し、SDK 例外は AwsError へ分類する。 */
  async getCallerIdentity(): Promise<{ accountId: string; arn: string }> {
    try {
      const output = await this.client.send(new GetCallerIdentityCommand({}));
      return {
        accountId: output.Account ?? '',
        arn: output.Arn ?? '',
      };
    } catch (cause) {
      throw toAwsError('STS GetCallerIdentity', cause);
    }
  }
}
