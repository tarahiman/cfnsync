import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type CfnSyncConfig,
  findRequiredPlaceholders,
  loadConfig,
  resolveTargets,
  validateConfig,
} from '../../src/core/config.js';
import { ConfigError } from '../../src/core/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '../fixtures/config');

/** validateConfig 用の最小限に有効な raw 設定(必要な項目のみ上書きして使う)。 */
function minimalRaw(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    defaultRegion: 'ap-northeast-1',
    stacks: {},
    ...overrides,
  };
}

const alwaysExists = { templateExists: () => true };

describe('core/config', () => {
  describe('loadConfig / validateConfig — FR-11-1: 全項目を含む cfnsync.yaml', () => {
    it('zod 検証を通過し、型付きの設定オブジェクトになる', () => {
      const config = loadConfig(
        resolve(fixturesDir, 'valid-full.cfnsync.yaml'),
      );

      expect(config.version).toBe(1);
      expect(config.allowedAccounts).toEqual(['123456789012']);
      expect(config.allowedRegions).toEqual(['ap-northeast-1', 'us-east-1']);
      expect(config.defaultRegion).toBe('ap-northeast-1');
      expect(config.stackNamePrefix).toBe('legacy-app-');

      const network = config.stacks['templates/network.yaml'];
      expect(network).toBeDefined();
      expect(network.stackName).toBe('prod-network');
      expect(network.regions).toEqual(['us-east-1', 'ap-northeast-1']);
      expect(network.tags).toEqual({ Project: 'legacy-app' });
      expect(network.capabilities).toEqual(['CAPABILITY_NAMED_IAM']);
      expect(network.dependsOn).toEqual([]);
      expect(network.regionOverrides['us-east-1']).toEqual({
        parameters: { VpcCidr: '10.1.0.0/16' },
        tags: { Region: 'us' },
      });

      const database = config.stacks['templates/database.yaml'];
      expect(database).toBeDefined();
      expect(database.dependsOn).toEqual(['templates/network.yaml']);
      // 省略された項目には既定値が埋まる。
      expect(database.parameters).toEqual({});
      expect(database.tags).toEqual({});
      expect(database.capabilities).toEqual([]);
      expect(database.regionOverrides).toEqual({});
    });

    it('(実装仕様) パラメータ値の数値・真偽値を文字列へ正規化する', () => {
      const config = loadConfig(
        resolve(fixturesDir, 'valid-full.cfnsync.yaml'),
      );
      const network = config.stacks['templates/network.yaml'];
      expect(network.parameters.InstanceCount).toBe('3');
      expect(network.parameters.EnableNat).toBe('true');
      expect(network.parameters.VpcCidr).toBe('10.0.0.0/16');
    });
  });

  describe('FR-11-2: ステートバックエンド', () => {
    it('state 省略時は backend: local になる', () => {
      const config = validateConfig(minimalRaw(), alwaysExists);
      expect(config.state).toEqual({ backend: 'local' });
    });

    it('backend: s3 で bucket/key/region が揃っていれば通過する', () => {
      const config = validateConfig(
        minimalRaw({
          state: {
            backend: 's3',
            s3: {
              bucket: 'my-bucket',
              key: 'state.json',
              region: 'ap-northeast-1',
            },
          },
        }),
        alwaysExists,
      );
      expect(config.state).toEqual({
        backend: 's3',
        s3: {
          bucket: 'my-bucket',
          key: 'state.json',
          region: 'ap-northeast-1',
        },
      });
    });

    it('backend: s3 で bucket が欠落しているとエラーになる', () => {
      expect(() =>
        validateConfig(
          minimalRaw({
            state: {
              backend: 's3',
              s3: { key: 'state.json', region: 'ap-northeast-1' },
            },
          }),
          alwaysExists,
        ),
      ).toThrow(ConfigError);

      try {
        validateConfig(
          minimalRaw({
            state: {
              backend: 's3',
              s3: { key: 'state.json', region: 'ap-northeast-1' },
            },
          }),
          alwaysExists,
        );
        expect.unreachable('ConfigError が送出されるはず');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as Error).message).toContain('bucket');
      }
    });
  });

  describe('FR-11-3: スタック名未設定時の導出規約', () => {
    it('stackName 省略時に stackNamePrefix + ファイル名(拡張子除去)が導出される', () => {
      const config = validateConfig(
        minimalRaw({
          stackNamePrefix: 'legacy-app-',
          stacks: { 'network.yaml': {} },
        }),
        alwaysExists,
      );
      const [target] = resolveTargets(config);
      expect(target.stackName).toBe('legacy-app-network');
    });

    it('stackNamePrefix 未設定ならファイル名のみが使われる', () => {
      const config = validateConfig(
        minimalRaw({ stacks: { 'network.yaml': {} } }),
        alwaysExists,
      );
      const [target] = resolveTargets(config);
      expect(target.stackName).toBe('network');
    });
  });

  describe('FR-11-5: 設定不備の実行前検証', () => {
    it('存在しないテンプレートへの参照は ConfigError になる(対象パスを含む)', () => {
      expect(() =>
        loadConfig(resolve(fixturesDir, 'missing-template.cfnsync.yaml')),
      ).toThrow(ConfigError);

      try {
        loadConfig(resolve(fixturesDir, 'missing-template.cfnsync.yaml'));
        expect.unreachable('ConfigError が送出されるはず');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as Error).message).toContain(
          'templates/does-not-exist.yaml',
        );
      }
    });

    it('必須項目(defaultRegion)の欠落は ConfigError になる(対象キーを含む)', () => {
      const raw = { version: 1, stacks: {} };
      expect(() => validateConfig(raw, alwaysExists)).toThrow(ConfigError);
      try {
        validateConfig(raw, alwaysExists);
        expect.unreachable('ConfigError が送出されるはず');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as Error).message).toContain('defaultRegion');
      }
    });

    it('不正な型(regions が配列でない)は ConfigError になる(対象キーを含む)', () => {
      const raw = minimalRaw({
        stacks: { 'network.yaml': { regions: 'ap-northeast-1' } },
      });
      expect(() => validateConfig(raw, alwaysExists)).toThrow(ConfigError);
      try {
        validateConfig(raw, alwaysExists);
        expect.unreachable('ConfigError が送出されるはず');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        const message = (err as Error).message;
        expect(message).toContain('network.yaml');
        expect(message).toContain('regions');
      }
    });
  });

  describe('FR-13-1: マルチリージョン指定', () => {
    it('regions 指定はその内容(順序含む)が保持される', () => {
      const config = validateConfig(
        minimalRaw({
          stacks: {
            'network.yaml': { regions: ['us-east-1', 'ap-northeast-1'] },
          },
        }),
        alwaysExists,
      );
      const targets = resolveTargets(config);
      expect(targets.map((t) => t.region)).toEqual([
        'us-east-1',
        'ap-northeast-1',
      ]);
    });

    it('regions 省略時は [defaultRegion] になる', () => {
      const config = validateConfig(
        minimalRaw({
          defaultRegion: 'ap-northeast-1',
          stacks: { 'network.yaml': {} },
        }),
        alwaysExists,
      );
      const targets = resolveTargets(config);
      expect(targets).toHaveLength(1);
      expect(targets[0].region).toBe('ap-northeast-1');
    });
  });

  describe('FR-13-3: パラメータ・タグのリージョン別上書き', () => {
    let config: CfnSyncConfig;

    beforeEach(() => {
      config = validateConfig(
        minimalRaw({
          defaultRegion: 'ap-northeast-1',
          stacks: {
            'network.yaml': {
              regions: ['ap-northeast-1', 'us-east-1'],
              parameters: { VpcCidr: '10.0.0.0/16' },
              tags: { Project: 'legacy-app' },
              regionOverrides: {
                'us-east-1': {
                  parameters: { VpcCidr: '10.1.0.0/16' },
                  tags: { Region: 'us' },
                },
              },
            },
          },
        }),
        alwaysExists,
      );
    });

    it('regionOverrides のあるリージョンは浅いマージで実効値が決まる', () => {
      const targets = resolveTargets(config);
      const usEast1 = targets.find((t) => t.region === 'us-east-1')!;
      expect(usEast1.parameters).toEqual({ VpcCidr: '10.1.0.0/16' });
      expect(usEast1.tags).toEqual({ Project: 'legacy-app', Region: 'us' });
    });

    it('regionOverrides のないリージョンは共通値のみになる', () => {
      const targets = resolveTargets(config);
      const apNortheast1 = targets.find((t) => t.region === 'ap-northeast-1')!;
      expect(apNortheast1.parameters).toEqual({ VpcCidr: '10.0.0.0/16' });
      expect(apNortheast1.tags).toEqual({ Project: 'legacy-app' });
    });
  });

  describe('FR-7-5(前半): 許可アカウント・許可リージョン', () => {
    it('allowedAccounts / allowedRegions が設定ファイルから読み取れる', () => {
      const config = validateConfig(
        minimalRaw({
          allowedAccounts: ['123456789012'],
          allowedRegions: ['ap-northeast-1'],
        }),
        alwaysExists,
      );
      expect(config.allowedAccounts).toEqual(['123456789012']);
      expect(config.allowedRegions).toEqual(['ap-northeast-1']);
    });

    it('allowedAccounts / allowedRegions は省略可能(検証の強制は T-12)', () => {
      const config = validateConfig(minimalRaw(), alwaysExists);
      expect(config.allowedAccounts).toBeUndefined();
      expect(config.allowedRegions).toBeUndefined();
    });
  });

  describe('§8.2: __REQUIRED__ プレースホルダの検出', () => {
    it('値が __REQUIRED__ のパラメータ名を列挙する', () => {
      const config = validateConfig(
        minimalRaw({
          stacks: {
            'network.yaml': {
              parameters: {
                VpcCidr: '10.0.0.0/16',
                DbPassword: '__REQUIRED__',
              },
            },
          },
        }),
        alwaysExists,
      );
      const [target] = resolveTargets(config);
      expect(findRequiredPlaceholders(target)).toEqual(['DbPassword']);
    });

    it('プレースホルダが残っていなければ空配列になる', () => {
      const config = validateConfig(
        minimalRaw({
          stacks: {
            'network.yaml': { parameters: { VpcCidr: '10.0.0.0/16' } },
          },
        }),
        alwaysExists,
      );
      const [target] = resolveTargets(config);
      expect(findRequiredPlaceholders(target)).toEqual([]);
    });
  });

  describe('resolveTargets の記載順保持契約', () => {
    it('stacks の記載順・regions の記載順を保持して展開する', () => {
      const config = loadConfig(
        resolve(fixturesDir, 'valid-full.cfnsync.yaml'),
      );
      const targets = resolveTargets(config);
      expect(targets.map((t) => t.stackKey)).toEqual([
        'templates/network.yaml@us-east-1',
        'templates/network.yaml@ap-northeast-1',
        'templates/database.yaml@ap-northeast-1',
      ]);
    });
  });
});
