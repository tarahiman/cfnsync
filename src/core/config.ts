/**
 * cfnsync.yaml の読込・検証(FR-11, FR-13, FR-7 の設定部分)。
 *
 * design.md §4.2 のスキーマを zod で表現し、(テンプレート × リージョン)単位への
 * 展開(§4.1 のスタックキー)は resolveTargets が担う。AWS SDK には依存しない
 * 純粋ロジック(CLAUDE.md の `src/core/` 制約)。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { makeStackKey, type StackKey } from './types.js';
import { ConfigError } from './errors.js';

/** deploy 時に残存していると検証エラーになるプレースホルダ(design.md §8.2)。 */
const REQUIRED_PLACEHOLDER = '__REQUIRED__';

// ---------------------------------------------------------------------------
// zod スキーマ(design.md §4.2)
// ---------------------------------------------------------------------------

/**
 * パラメータ・タグの値。YAML は数値・真偽値をそのまま解釈しうるため、
 * CloudFormation が要求する文字列へ正規化する(実装仕様: パラメータ値の文字列化)。
 */
const stringValueSchema = z
  .union([z.string(), z.number(), z.boolean()])
  .transform((value) => String(value));

const stringRecordSchema = z.record(z.string(), stringValueSchema);

const s3StateSchema = z.object({
  bucket: z.string().min(1),
  key: z.string().min(1),
  region: z.string().min(1),
});

/** FR-11-2: `state` 省略時は local。`backend: s3` は bucket/key/region が必須。 */
const stateSchema = z
  .discriminatedUnion('backend', [
    z.object({ backend: z.literal('local') }),
    z.object({ backend: z.literal('s3'), s3: s3StateSchema }),
  ])
  .default({ backend: 'local' });

const regionOverrideSchema = z.object({
  parameters: stringRecordSchema.optional(),
  tags: stringRecordSchema.optional(),
});

const stackEntrySchema = z.object({
  stackName: z.string().min(1).optional(),
  regions: z.array(z.string().min(1)).optional(),
  parameters: stringRecordSchema.optional(),
  tags: stringRecordSchema.optional(),
  capabilities: z.array(z.string().min(1)).optional(),
  dependsOn: z.array(z.string().min(1)).optional(),
  regionOverrides: z.record(z.string(), regionOverrideSchema).optional(),
});

const rawConfigSchema = z.object({
  version: z.literal(1),
  // FR-7-5(前半): allowedAccounts / allowedRegions はスキーマに存在し読み取れる。
  // 必須化(検証の強制)は T-12(usecase/guard)の責務なのでここでは optional。
  allowedAccounts: z.array(z.string().min(1)).optional(),
  allowedRegions: z.array(z.string().min(1)).optional(),
  defaultRegion: z.string().min(1),
  stackNamePrefix: z.string().optional(),
  state: stateSchema,
  stacks: z.record(z.string(), stackEntrySchema),
});

type RawConfig = z.infer<typeof rawConfigSchema>;

// ---------------------------------------------------------------------------
// 公開型(下流タスクの契約)
// ---------------------------------------------------------------------------

export interface S3StateConfig {
  bucket: string;
  key: string;
  region: string;
}

export interface StateConfig {
  backend: 'local' | 's3';
  s3?: S3StateConfig;
}

export interface RegionOverrideConfig {
  parameters: Record<string, string>;
  tags: Record<string, string>;
}

export interface StackConfigEntry {
  stackName?: string;
  regions?: string[];
  parameters: Record<string, string>;
  tags: Record<string, string>;
  capabilities: string[];
  dependsOn: string[];
  regionOverrides: Record<string, RegionOverrideConfig>;
}

export interface CfnSyncConfig {
  version: 1;
  allowedAccounts?: string[];
  allowedRegions?: string[];
  defaultRegion: string;
  stackNamePrefix?: string;
  state: StateConfig;
  /** キーはテンプレートの(設定ファイルのディレクトリを基準とした)相対パス。 */
  stacks: Record<string, StackConfigEntry>;
}

export interface ResolvedStackTarget {
  stackKey: StackKey;
  templatePath: string;
  stackName: string;
  region: string;
  parameters: Record<string, string>;
  tags: Record<string, string>;
  capabilities: string[];
  dependsOn: string[];
}

export interface ValidateConfigOptions {
  /** configPath のディレクトリを基準とした相対パスでテンプレートの存在を判定する。 */
  templateExists: (relativeTemplatePath: string) => boolean;
}

// ---------------------------------------------------------------------------
// 検証本体
// ---------------------------------------------------------------------------

/**
 * zod でパースした RawConfig を、下流タスクが扱いやすいよう既定値を埋めた
 * CfnSyncConfig に正規化する。
 */
function normalize(data: RawConfig): CfnSyncConfig {
  const stacks: Record<string, StackConfigEntry> = {};

  for (const [templatePath, entry] of Object.entries(data.stacks)) {
    const regionOverrides: Record<string, RegionOverrideConfig> = {};
    for (const [region, override] of Object.entries(entry.regionOverrides ?? {})) {
      regionOverrides[region] = {
        parameters: override.parameters ?? {},
        tags: override.tags ?? {},
      };
    }

    stacks[templatePath] = {
      stackName: entry.stackName,
      regions: entry.regions,
      parameters: entry.parameters ?? {},
      tags: entry.tags ?? {},
      capabilities: entry.capabilities ?? [],
      dependsOn: entry.dependsOn ?? [],
      regionOverrides,
    };
  }

  return {
    version: data.version,
    allowedAccounts: data.allowedAccounts,
    allowedRegions: data.allowedRegions,
    defaultRegion: data.defaultRegion,
    stackNamePrefix: data.stackNamePrefix,
    state: data.state,
    stacks,
  };
}

/** zod のエラーを「対象キーを含む」ConfigError に変換する(FR-11-5)。 */
function toConfigError(error: z.ZodError): ConfigError {
  const issue = error.issues[0];
  const keyPath = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  // stacks.<templatePath>.* 配下のエラーはテンプレートパスを stackKey 文脈として付与する。
  const stackKey =
    issue.path[0] === 'stacks' && typeof issue.path[1] === 'string' ? issue.path[1] : undefined;
  return new ConfigError(`設定ファイルの検証に失敗しました: ${keyPath}: ${issue.message}`, {
    stackKey,
    cause: error,
  });
}

/**
 * 設定内容(YAML パース済みの生オブジェクト)を検証し、型付きの CfnSyncConfig を返す。
 * ファイル I/O を含まない純粋関数(テスト容易性のため loadConfig から分離)。
 */
export function validateConfig(raw: unknown, opts: ValidateConfigOptions): CfnSyncConfig {
  const result = rawConfigSchema.safeParse(raw);
  if (!result.success) {
    throw toConfigError(result.error);
  }

  const config = normalize(result.data);

  // FR-11-5: 存在しないテンプレートへの参照を検出する。
  for (const templatePath of Object.keys(config.stacks)) {
    if (!opts.templateExists(templatePath)) {
      throw new ConfigError(`参照先のテンプレートファイルが存在しません: ${templatePath}`, {
        stackKey: templatePath,
      });
    }
  }

  return config;
}

/**
 * cfnsync.yaml を読み込み、検証済みの CfnSyncConfig を返す。
 * テンプレートの存在チェックは configPath のディレクトリを基準とした相対パスで行う。
 */
export function loadConfig(configPath: string): CfnSyncConfig {
  const absConfigPath = resolve(configPath);

  let content: string;
  try {
    content = readFileSync(absConfigPath, 'utf-8');
  } catch (cause) {
    throw new ConfigError(`設定ファイルを読み込めません: ${configPath}`, { cause });
  }

  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (cause) {
    throw new ConfigError(`設定ファイルの YAML 解析に失敗しました: ${configPath}`, { cause });
  }

  const baseDir = dirname(absConfigPath);
  return validateConfig(raw, {
    templateExists: (relativeTemplatePath) => existsSync(resolve(baseDir, relativeTemplatePath)),
  });
}

// ---------------------------------------------------------------------------
// (テンプレート × リージョン)への展開
// ---------------------------------------------------------------------------

function deriveStackName(prefix: string | undefined, templatePath: string): string {
  const fileName = templatePath.split('/').pop() ?? templatePath;
  const baseName = fileName.replace(/\.(ya?ml|json)$/i, '');
  return `${prefix ?? ''}${baseName}`;
}

/**
 * CfnSyncConfig を(テンプレート × リージョン)単位の ResolvedStackTarget に展開する。
 * 設定ファイルの記載順(stacks の順、regions の順)を保持する — 後続の直列実行順の正本。
 */
export function resolveTargets(config: CfnSyncConfig): ResolvedStackTarget[] {
  const targets: ResolvedStackTarget[] = [];

  for (const [templatePath, entry] of Object.entries(config.stacks)) {
    const regions = entry.regions && entry.regions.length > 0 ? entry.regions : [config.defaultRegion];
    const stackName = entry.stackName ?? deriveStackName(config.stackNamePrefix, templatePath);

    for (const region of regions) {
      const override = entry.regionOverrides[region];
      targets.push({
        stackKey: makeStackKey(templatePath, region),
        templatePath,
        stackName,
        region,
        // FR-13-3: 共通値に regionOverrides.<region> を浅くマージ。
        parameters: { ...entry.parameters, ...(override?.parameters ?? {}) },
        tags: { ...entry.tags, ...(override?.tags ?? {}) },
        capabilities: [...entry.capabilities],
        dependsOn: [...entry.dependsOn],
      });
    }
  }

  return targets;
}

/** design.md §8.2: 値が __REQUIRED__ のままのパラメータ名を列挙する。 */
export function findRequiredPlaceholders(target: ResolvedStackTarget): string[] {
  return Object.entries(target.parameters)
    .filter(([, value]) => value === REQUIRED_PLACEHOLDER)
    .map(([key]) => key);
}
