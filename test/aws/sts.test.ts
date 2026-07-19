/**
 * T-09 aws/StsGateway のテスト(tasks.md §5 T-09 の対応表)。
 *
 * 実 AWS には接続せず `aws-sdk-client-mock` で `send` をスタブする(§10)。
 * 各 it の先頭に対応する受け入れ基準 ID を明記する。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';

// FR-7-1〜3(オプション伝播): profile 指定時に `defaultProvider` が呼ばれることを
// 検証するためのモック。`src/aws/cloudformation.ts` と同じ流儀(profile 指定時のみ
// 既定クレデンシャルチェーンに profile を適用)を `sts.ts` が踏襲しているかを確認する。
const defaultProviderMock = vi.fn(() => async () => ({
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret',
}));
vi.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: (...args: unknown[]) => defaultProviderMock(...args),
}));

const { StsGatewayImpl } = await import('../../src/aws/sts.js');
import type { StsGateway } from '../../src/ports/index.js';

const stsMock = mockClient(STSClient);

beforeEach(() => {
  stsMock.reset();
  defaultProviderMock.mockClear();
});

function callerIdentityOutput(overrides: Partial<{ Account: string; Arn: string; UserId: string }> = {}) {
  return {
    Account: '123456789012',
    Arn: 'arn:aws:iam::123456789012:role/deploy',
    UserId: 'AROAEXAMPLE:session',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// FR-7-6(基盤): STS GetCallerIdentity で接続先アカウントを解決
// ---------------------------------------------------------------------------

describe('FR-7-6(基盤): GetCallerIdentity による接続先解決', () => {
  it('FR-7-6: getCallerIdentity は accountId・arn を返す', async () => {
    stsMock.on(GetCallerIdentityCommand).resolves(callerIdentityOutput());
    const gateway = new StsGatewayImpl({ region: 'ap-northeast-1' });

    const identity = await gateway.getCallerIdentity();

    expect(identity).toEqual({
      accountId: '123456789012',
      arn: 'arn:aws:iam::123456789012:role/deploy',
    });
    expect(stsMock.commandCalls(GetCallerIdentityCommand)).toHaveLength(1);
    expect(stsMock.commandCalls(GetCallerIdentityCommand)[0].args[0].input).toEqual({});
  });

  it('FR-7-6: 解決失敗(認証エラー)は例外としてそのまま伝播する', async () => {
    stsMock
      .on(GetCallerIdentityCommand)
      .rejects(Object.assign(new Error('The security token included in the request is invalid'), {
        name: 'InvalidClientTokenId',
      }));
    const gateway = new StsGatewayImpl({ region: 'ap-northeast-1' });

    await expect(gateway.getCallerIdentity()).rejects.toThrow(
      /security token included in the request is invalid/,
    );
  });
});

// ---------------------------------------------------------------------------
// FR-7-1〜3(オプション伝播): region / profile がクライアント生成時に渡ること
// ---------------------------------------------------------------------------

describe('FR-7-1〜3(オプション伝播): クライアント生成オプション', () => {
  it('FR-7-3: region オプションが STSClient の config に渡る', async () => {
    const gateway = new StsGatewayImpl({ region: 'eu-west-1' });
    const regionProvider = gateway.client.config.region;
    const resolvedRegion = typeof regionProvider === 'function' ? await regionProvider() : regionProvider;
    expect(resolvedRegion).toBe('eu-west-1');
  });

  it('FR-7-1: profile 指定時に defaultProvider({ profile }) が呼ばれ、クレデンシャルとして適用される', () => {
    new StsGatewayImpl({ region: 'ap-northeast-1', profile: 'my-profile' });
    expect(defaultProviderMock).toHaveBeenCalledWith({ profile: 'my-profile' });
  });

  it('FR-7-2: profile 未指定時は defaultProvider を呼ばず、SDK 標準クレデンシャルチェーンに委ねる', () => {
    new StsGatewayImpl({ region: 'ap-northeast-1' });
    expect(defaultProviderMock).not.toHaveBeenCalled();
  });

  it('FR-7-1〜3: region・profile を省略してもインスタンス化できる(SDK 標準チェーンに委ねる)', () => {
    expect(() => new StsGatewayImpl()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 型適合(NFR-2 と整合): StsGatewayImpl は StsGateway 契約を満たす
// ---------------------------------------------------------------------------

describe('型適合', () => {
  it('StsGatewayImpl は StsGateway 型に適合する', () => {
    const gateway: StsGateway = new StsGatewayImpl({ region: 'us-east-1' });
    expect(typeof gateway.getCallerIdentity).toBe('function');
  });
});
