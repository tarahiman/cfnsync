import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfigFile } from '../../src/cli/filesystem.js';
import {
  type CfnSyncConfig,
  findRequiredPlaceholders,
  parseConfig,
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

function parseFixture(name: string): CfnSyncConfig {
  return parseConfig(readFileSync(resolve(fixturesDir, name), 'utf8'));
}

describe('core/config', () => {
  describe('loadConfig / validateConfig — FR-11-1: 全項目を含む cfnsync.yaml', () => {
    it('FR-11-1: zod 検証を通過し、型付きの設定オブジェクトになる', () => {
      const config = parseFixture('valid-full.cfnsync.yaml');

      expect(config.version).toBe(1);
      expect(config.allowedAccounts).toEqual(['123456789012']);
      expect(config.allowedRegions).toEqual(['ap-northeast-1', 'us-east-1']);
      expect(config.defaultRegion).toBe('ap-northeast-1');
      expect(config.stackNamePrefix).toBe('legacy-app-');
      expect(config.defaultTags).toEqual({ ManagedBy: 'cfnsync' });

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

    it('internal: パラメータ値の数値・真偽値を文字列へ正規化する', () => {
      const config = parseFixture('valid-full.cfnsync.yaml');
      const network = config.stacks['templates/network.yaml'];
      expect(network.parameters.InstanceCount).toBe('3');
      expect(network.parameters.EnableNat).toBe('true');
      expect(network.parameters.VpcCidr).toBe('10.0.0.0/16');
    });
  });

  describe('FR-11-2: ステートバックエンド', () => {
    it('FR-11-2: state 省略時は backend: local になる', () => {
      const config = validateConfig(minimalRaw());
      expect(config.state).toEqual({ backend: 'local' });
    });

    it('FR-11-2: backend: s3 で bucket/key/region が揃っていれば通過する', () => {
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

    it('FR-11-2: backend: s3 で bucket が欠落しているとエラーになる', () => {
      expect(() =>
        validateConfig(
          minimalRaw({
            state: {
              backend: 's3',
              s3: { key: 'state.json', region: 'ap-northeast-1' },
            },
          }),
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
        );
        expect.unreachable('ConfigError が送出されるはず');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as Error).message).toContain('bucket');
      }
    });
  });

  describe('FR-11-3: スタック名未設定時の導出規約', () => {
    it('FR-11-3: stackName 省略時に stackNamePrefix + ファイル名(拡張子除去)が導出される', () => {
      const config = validateConfig(
        minimalRaw({
          stackNamePrefix: 'legacy-app-',
          stacks: { 'network.yaml': {} },
        }),
      );
      const [target] = resolveTargets(config);
      expect(target.stackName).toBe('legacy-app-network');
    });

    it('FR-11-3: stackNamePrefix 未設定ならファイル名のみが使われる', () => {
      const config = validateConfig(
        minimalRaw({ stacks: { 'network.yaml': {} } }),
      );
      const [target] = resolveTargets(config);
      expect(target.stackName).toBe('network');
    });
  });

  describe('FR-11-5: 設定不備の実行前検証', () => {
    it.each([
      '../outside.yaml',
      'nested/../../outside.yaml',
      '/etc/x.yaml',
      'nested/stack.yaml\0outside',
    ])('FR-11-5: テンプレートパス %s は設定ディレクトリ外を指すため ConfigError になる(対象キーを含む)', (templatePath) => {
      try {
        validateConfig(minimalRaw({ stacks: { [templatePath]: {} } }));
        expect.unreachable('ConfigError が送出されるはず');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as Error).message).toContain(templatePath);
      }
    });

    it('security(再レビュー2): YAML 構文エラーは秘匿値を含むソース断片を surface しない(NFR-4)', () => {
      // 未終端の引用符に NoEcho 相当の秘密値を含める。
      const source = 'version: 1\nsecret: "supersecret-do-not-leak\n';
      let message = '';
      try {
        parseConfig(source);
        expect.unreachable('ConfigError が送出されるはず');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        message = (err as Error).message;
      }
      expect(message).not.toContain('supersecret-do-not-leak');
    });

    it('FR-11-5: サブディレクトリを含む正当な相対パスは引き続き許可する', () => {
      const config = validateConfig(
        minimalRaw({ stacks: { 'nested/stack.yaml': {} } }),
      );
      expect(config.stacks['nested/stack.yaml']).toBeDefined();
    });

    it('FR-11-5: 存在しないテンプレートへの参照は ConfigError になる(対象パスを含む)', () => {
      expect(() =>
        loadConfigFile(resolve(fixturesDir, 'missing-template.cfnsync.yaml')),
      ).toThrow(ConfigError);

      try {
        loadConfigFile(resolve(fixturesDir, 'missing-template.cfnsync.yaml'));
        expect.unreachable('ConfigError が送出されるはず');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as Error).message).toContain(
          'templates/does-not-exist.yaml',
        );
      }
    });

    it('FR-8-2: 自己依存は対象スタックキー付き ConfigError で拒否する', () => {
      expect(() =>
        validateConfig(
          minimalRaw({ stacks: { 'app.yaml': { dependsOn: ['app.yaml'] } } }),
        ),
      ).toThrowError(/自分自身.*app\.yaml@ap-northeast-1/);
    });

    it.each(['', '.', 'a/..'])('FR-11-5: 退化パス %j を拒否する', (path) => {
      expect(() =>
        validateConfig(minimalRaw({ stacks: { [path]: {} } })),
      ).toThrow(ConfigError);
    });

    it('FR-11-5: 未知キーと正規化後の重複パスを拒否する', () => {
      expect(() =>
        validateConfig(minimalRaw({ capabilites: [], stacks: {} })),
      ).toThrow(ConfigError);
      expect(() =>
        validateConfig(
          minimalRaw({ stacks: { 'x/../app.yaml': {}, 'app.yaml': {} } }),
        ),
      ).toThrow(/重複/);
    });

    it('FR-11-5: 必須項目(defaultRegion)の欠落は ConfigError になる(対象キーを含む)', () => {
      const raw = { version: 1, stacks: {} };
      expect(() => validateConfig(raw)).toThrow(ConfigError);
      try {
        validateConfig(raw);
        expect.unreachable('ConfigError が送出されるはず');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as Error).message).toContain('defaultRegion');
      }
    });

    it('FR-11-5: 不正な型(regions が配列でない)は ConfigError になる(対象キーを含む)', () => {
      const raw = minimalRaw({
        stacks: { 'network.yaml': { regions: 'ap-northeast-1' } },
      });
      expect(() => validateConfig(raw)).toThrow(ConfigError);
      try {
        validateConfig(raw);
        expect.unreachable('ConfigError が送出されるはず');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        const message = (err as Error).message;
        expect(message).toContain('network.yaml');
        expect(message).toContain('regions');
      }
    });

    it('FR-11-5: zod 検証失敗は対象キーを一度だけ含む人間向け ConfigError で issue JSON を露出しない', () => {
      const raw = minimalRaw({
        stacks: { 'network.yaml': { regions: 'ap-northeast-1' } },
      });

      try {
        validateConfig(raw);
        expect.unreachable('ConfigError が送出されるはず');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        const configError = err as ConfigError;
        expect(
          configError.message.split('stacks.network.yaml.regions'),
        ).toHaveLength(2);
        expect(
          configError.message.split('(stackKey: network.yaml)'),
        ).toHaveLength(2);
        expect(configError.message).not.toContain('"code"');
        expect(configError.message).not.toContain('invalid_type');
        expect(configError.cause).toBeUndefined();
      }
    });

    it('FR-8-2: 存在しない dependsOn は対象スタックキー付き ConfigError で拒否する', () => {
      expect(() =>
        validateConfig(
          minimalRaw({
            stacks: {
              'app.yaml': { dependsOn: ['missing.yaml'] },
            },
          }),
        ),
      ).toThrowError(/app\.yaml@ap-northeast-1.*region: ap-northeast-1/);
    });

    it('FR-8-2: 別リージョンにしか存在しない dependsOn も fail-closed で拒否する', () => {
      expect(() =>
        validateConfig(
          minimalRaw({
            stacks: {
              'network.yaml': { regions: ['us-east-1'] },
              'app.yaml': {
                regions: ['ap-northeast-1'],
                dependsOn: ['network.yaml'],
              },
            },
          }),
        ),
      ).toThrowError(/network\.yaml@ap-northeast-1/);
    });

    it('FR-2-5: 未知の capability は設定検証で拒否する', () => {
      expect(() =>
        validateConfig(
          minimalRaw({
            stacks: {
              'app.yaml': { capabilities: ['CAPABILITY_UNKNOWN'] },
            },
          }),
        ),
      ).toThrow(ConfigError);
    });
  });

  describe('FR-13-1: マルチリージョン指定', () => {
    it('FR-13-1: regions 指定はその内容(順序含む)が保持される', () => {
      const config = validateConfig(
        minimalRaw({
          stacks: {
            'network.yaml': { regions: ['us-east-1', 'ap-northeast-1'] },
          },
        }),
      );
      const targets = resolveTargets(config);
      expect(targets.map((t) => t.region)).toEqual([
        'us-east-1',
        'ap-northeast-1',
      ]);
    });

    it('FR-13-1: regions 省略時は [defaultRegion] になる', () => {
      const config = validateConfig(
        minimalRaw({
          defaultRegion: 'ap-northeast-1',
          stacks: { 'network.yaml': {} },
        }),
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
      );
    });

    it('FR-13-3: regionOverrides のあるリージョンは浅いマージで実効値が決まる', () => {
      const targets = resolveTargets(config);
      const usEast1 = targets.find((t) => t.region === 'us-east-1')!;
      expect(usEast1.parameters).toEqual({ VpcCidr: '10.1.0.0/16' });
      expect(usEast1.tags).toEqual({ Project: 'legacy-app', Region: 'us' });
    });

    it('FR-13-3: regionOverrides のないリージョンは共通値のみになる', () => {
      const targets = resolveTargets(config);
      const apNortheast1 = targets.find((t) => t.region === 'ap-northeast-1')!;
      expect(apNortheast1.parameters).toEqual({ VpcCidr: '10.0.0.0/16' });
      expect(apNortheast1.tags).toEqual({ Project: 'legacy-app' });
    });
  });

  describe('FR-11-8: defaultTags — 全管理対象スタックへの既定タグ', () => {
    it('FR-11-8: 独自の tags を持たないスタックへ defaultTags がそのまま適用される', () => {
      const config = validateConfig(
        minimalRaw({
          defaultTags: { ManagedBy: 'cfnsync' },
          stacks: { 'network.yaml': {} },
        }),
      );
      const [target] = resolveTargets(config);
      expect(target.tags).toEqual({ ManagedBy: 'cfnsync' });
    });

    it('FR-11-8: defaultTags とスタック独自の別キーの tags はマージされる', () => {
      const config = validateConfig(
        minimalRaw({
          defaultTags: { ManagedBy: 'cfnsync' },
          stacks: {
            'network.yaml': { tags: { Project: 'legacy-app' } },
          },
        }),
      );
      const [target] = resolveTargets(config);
      expect(target.tags).toEqual({
        ManagedBy: 'cfnsync',
        Project: 'legacy-app',
      });
    });

    it('FR-11-8: キー衝突時は stacks.<path>.tags の値が defaultTags より優先される(エラーにはしない)', () => {
      const config = validateConfig(
        minimalRaw({
          defaultTags: { Env: 'default-env' },
          stacks: {
            'network.yaml': { tags: { Env: 'prod' } },
          },
        }),
      );
      const [target] = resolveTargets(config);
      expect(target.tags).toEqual({ Env: 'prod' });
    });

    it('FR-11-8/FR-13-3: キー衝突時は regionOverrides.<region>.tags の値が defaultTags より優先される', () => {
      const config = validateConfig(
        minimalRaw({
          defaultRegion: 'ap-northeast-1',
          defaultTags: { Env: 'default-env' },
          stacks: {
            'network.yaml': {
              regionOverrides: {
                'ap-northeast-1': { tags: { Env: 'region-override' } },
              },
            },
          },
        }),
      );
      const [target] = resolveTargets(config);
      expect(target.tags).toEqual({ Env: 'region-override' });
    });

    it('FR-11-8/FR-13-3: 三者混在時の優先順位は defaultTags < tags < regionOverrides.tags', () => {
      const config = validateConfig(
        minimalRaw({
          defaultRegion: 'ap-northeast-1',
          defaultTags: { Level: 'default', Common: 'from-default' },
          stacks: {
            'network.yaml': {
              tags: { Level: 'stack', Project: 'legacy-app' },
              regionOverrides: {
                'ap-northeast-1': { tags: { Level: 'region' } },
              },
            },
          },
        }),
      );
      const [target] = resolveTargets(config);
      expect(target.tags).toEqual({
        Level: 'region',
        Common: 'from-default',
        Project: 'legacy-app',
      });
    });

    it('internal: defaultTags の数値・真偽値も文字列へ正規化される', () => {
      const config = validateConfig(
        minimalRaw({
          defaultTags: { RetentionDays: 30, Enabled: true },
          stacks: { 'network.yaml': {} },
        }),
      );
      expect(config.defaultTags).toEqual({
        RetentionDays: '30',
        Enabled: 'true',
      });
      const [target] = resolveTargets(config);
      expect(target.tags).toEqual({ RetentionDays: '30', Enabled: 'true' });
    });

    it('FR-11-8: defaultTags 省略時は従来どおりタグは付与されない', () => {
      const config = validateConfig(
        minimalRaw({
          stacks: { 'network.yaml': {} },
        }),
      );
      expect(config.defaultTags).toEqual({});
      const [target] = resolveTargets(config);
      expect(target.tags).toEqual({});
    });

    it('FR-11-8/FR-13: マルチリージョンの全リージョンへ defaultTags が適用される', () => {
      const config = validateConfig(
        minimalRaw({
          defaultTags: { ManagedBy: 'cfnsync' },
          stacks: {
            'network.yaml': { regions: ['ap-northeast-1', 'us-east-1'] },
          },
        }),
      );
      const targets = resolveTargets(config);
      expect(targets).toHaveLength(2);
      for (const target of targets) {
        expect(target.tags).toEqual({ ManagedBy: 'cfnsync' });
      }
    });
  });

  describe('FR-7-5(前半): 許可アカウント・許可リージョン', () => {
    it('FR-7-5: allowedAccounts / allowedRegions が設定ファイルから読み取れる', () => {
      const config = validateConfig(
        minimalRaw({
          allowedAccounts: ['123456789012'],
          allowedRegions: ['ap-northeast-1'],
        }),
      );
      expect(config.allowedAccounts).toEqual(['123456789012']);
      expect(config.allowedRegions).toEqual(['ap-northeast-1']);
    });

    it('FR-7-5: allowedAccounts / allowedRegions は省略可能(検証の強制は usecase)', () => {
      const config = validateConfig(minimalRaw());
      expect(config.allowedAccounts).toBeUndefined();
      expect(config.allowedRegions).toBeUndefined();
    });
  });

  describe('§8.2: __REQUIRED__ プレースホルダの検出', () => {
    it('§8.2: 値が __REQUIRED__ のパラメータ名を列挙する', () => {
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
      );
      const [target] = resolveTargets(config);
      expect(findRequiredPlaceholders(target)).toEqual(['DbPassword']);
    });

    it('§8.2: プレースホルダが残っていなければ空配列になる', () => {
      const config = validateConfig(
        minimalRaw({
          stacks: {
            'network.yaml': { parameters: { VpcCidr: '10.0.0.0/16' } },
          },
        }),
      );
      const [target] = resolveTargets(config);
      expect(findRequiredPlaceholders(target)).toEqual([]);
    });
  });

  describe('resolveTargets の記載順保持契約', () => {
    it('internal: stacks の記載順・regions の記載順を保持して展開する', () => {
      const config = parseFixture('valid-full.cfnsync.yaml');
      const targets = resolveTargets(config);
      expect(targets.map((t) => t.stackKey)).toEqual([
        'templates/network.yaml@us-east-1',
        'templates/network.yaml@ap-northeast-1',
        'templates/database.yaml@ap-northeast-1',
      ]);
    });
  });
});
