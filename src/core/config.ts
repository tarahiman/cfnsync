/**
 * cfnsync.yaml の読込・検証(FR-11, FR-13, FR-7 の設定部分)。
 *
 * design.md §4.2 のスキーマを zod で表現し、(テンプレート × リージョン)単位への
 * 展開(§4.1 のスタックキー)は resolveTargets が担う。AWS SDK には依存しない
 * 純粋ロジック(CLAUDE.md の `src/core/` 制約)。
 */

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { REQUIRED_PLACEHOLDER } from './constants.js';
import { resolveDependsOnKey } from './dependency.js';
import { ConfigError } from './errors.js';
import {
  assertSafeTemplatePath,
  normalizeTemplatePath,
} from './templatePath.js';
import { makeStackKey, type StackKey } from './types.js';

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

/** CloudFormation が受理する Capabilities の閉じた集合。 */
export const capabilitySchema = z.enum([
  'CAPABILITY_IAM',
  'CAPABILITY_NAMED_IAM',
  'CAPABILITY_AUTO_EXPAND',
]);
export type Capability = z.infer<typeof capabilitySchema>;

const s3StateSchema = z
  .object({
    bucket: z.string().min(1),
    key: z.string().min(1),
    region: z.string().min(1),
  })
  .strict();

/** FR-11-2: `state` 省略時は local。`backend: s3` は bucket/key/region が必須。 */
const stateSchema = z
  .discriminatedUnion('backend', [
    z.object({ backend: z.literal('local') }).strict(),
    z.object({ backend: z.literal('s3'), s3: s3StateSchema }).strict(),
  ])
  .default({ backend: 'local' });

const regionOverrideSchema = z
  .object({
    parameters: stringRecordSchema.default({}),
    tags: stringRecordSchema.default({}),
  })
  .strict();

const stackEntrySchema = z
  .object({
    stackName: z.string().min(1).optional(),
    regions: z.array(z.string().min(1)).optional(),
    parameters: stringRecordSchema.default({}),
    tags: stringRecordSchema.default({}),
    capabilities: z.array(capabilitySchema).default([]),
    dependsOn: z.array(z.string().min(1)).default([]),
    regionOverrides: z.record(z.string(), regionOverrideSchema).default({}),
  })
  .strict();

const rawConfigSchema = z
  .object({
    version: z.literal(1),
    // FR-7-5(前半): allowedAccounts / allowedRegions はスキーマに存在し読み取れる。
    // 必須化(検証の強制)は T-12(usecase/guard)の責務なのでここでは optional。
    allowedAccounts: z.array(z.string().min(1)).optional(),
    allowedRegions: z.array(z.string().min(1)).optional(),
    defaultRegion: z.string().min(1),
    stackNamePrefix: z.string().optional(),
    // FR-11: 全管理対象スタックへ既定付与するタグ。resolveTargets での
    // マージ(defaultTags < tags < regionOverrides.tags)により実効タグへ反映される。
    defaultTags: stringRecordSchema.default({}),
    state: stateSchema,
    stacks: z.record(z.string(), stackEntrySchema),
  })
  .strict();

/** 正規化済み設定型は zod の出力型から一意に導出する。 */
export type CfnSyncConfig = z.infer<typeof rawConfigSchema>;
export type StateConfig = CfnSyncConfig['state'];
export type S3StateConfig = Extract<StateConfig, { backend: 's3' }>['s3'];
export type StackConfigEntry = CfnSyncConfig['stacks'][string];
export type RegionOverrideConfig = StackConfigEntry['regionOverrides'][string];

export interface ResolvedStackTarget {
  stackKey: StackKey;
  templatePath: string;
  stackName: string;
  region: string;
  parameters: Record<string, string>;
  tags: Record<string, string>;
  capabilities: Capability[];
  dependsOn: string[];
}

// ---------------------------------------------------------------------------
// 検証本体
// ---------------------------------------------------------------------------

/** zod のエラーを「対象キーを含む」ConfigError に変換する(FR-11-5)。 */
function toConfigError(error: z.ZodError): ConfigError {
  const issue = error.issues[0];
  const keyPath = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  // stacks.<templatePath>.* 配下のエラーはテンプレートパスを stackKey 文脈として付与する。
  const stackKey =
    issue.path[0] === 'stacks' && typeof issue.path[1] === 'string'
      ? issue.path[1]
      : undefined;
  return new ConfigError(
    `設定ファイルの検証に失敗しました: ${keyPath}: ${issue.message}`,
    {
      stackKey,
      cause: error,
    },
  );
}

/**
 * 設定内容(YAML パース済みの生オブジェクト)を検証し、型付きの CfnSyncConfig を返す。
 * ファイル I/O を含まない純粋関数(テスト容易性のため loadConfig から分離)。
 */
export function validateConfig(raw: unknown): CfnSyncConfig {
  const result = rawConfigSchema.safeParse(raw);
  if (!result.success) {
    throw toConfigError(result.error);
  }

  const config = result.data;

  const normalizedPaths = new Map<string, string>();
  for (const templatePath of Object.keys(config.stacks)) {
    assertSafeTemplatePath(templatePath);
    const normalized = normalizeTemplatePath(templatePath);
    const previous = normalizedPaths.get(normalized);
    if (previous !== undefined) {
      throw new ConfigError(
        `正規化後のテンプレートパスが重複しています: ${previous}, ${templatePath} -> ${normalized}`,
        {
          stackKey: templatePath,
        },
      );
    }
    normalizedPaths.set(normalized, templatePath);
  }

  validateEffectiveConfig(config);
  return config;
}

/** CLI 上書きを含む実効設定のリージョン別依存を共通検証する。 */
export function validateEffectiveConfig(config: CfnSyncConfig): void {
  const targets = resolveTargets(config);
  const managed = new Set(targets.map((target) => target.stackKey));
  for (const target of targets) {
    for (const rawDependency of target.dependsOn) {
      const dependency = resolveDependsOnKey(rawDependency, target.region);
      if (dependency === target.stackKey) {
        throw new ConfigError(
          `明示依存 dependsOn '${rawDependency}' は自分自身を参照できません`,
          { stackKey: target.stackKey, region: target.region },
        );
      }
      if (!managed.has(dependency)) {
        throw new ConfigError(
          `明示依存 dependsOn '${rawDependency}' は同一リージョンの管理対象へ解決できません: ${dependency}`,
          { stackKey: target.stackKey, region: target.region },
        );
      }
    }
  }
}

/** YAML 文字列を解析・検証する core の純粋入口。ファイル読込は adapter が担う。 */
export function parseConfig(content: string): CfnSyncConfig {
  let raw: unknown;
  try {
    // logLevel: 'silent' で yaml パーサによる警告の直接 stderr 出力を抑止する。
    // 未知タグ(例 `!vault <secret>`)を strict に拒否し、秘匿値を含みうる
    // ソース断片が診断としてログへ漏れないようにする(NFR-4)。cause は保持せず
    // 固定文のみを surface する。
    raw = parseYaml(content, { logLevel: 'silent', strict: true });
  } catch {
    throw new ConfigError(
      '設定ファイルの YAML 解析に失敗しました(構文またはサポート外のタグ)',
    );
  }
  return validateConfig(raw);
}

// ---------------------------------------------------------------------------
// (テンプレート × リージョン)への展開
// ---------------------------------------------------------------------------

function deriveStackName(
  prefix: string | undefined,
  templatePath: string,
): string {
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
    const regions =
      entry.regions && entry.regions.length > 0
        ? entry.regions
        : [config.defaultRegion];
    const stackName =
      entry.stackName ?? deriveStackName(config.stackNamePrefix, templatePath);

    for (const region of regions) {
      const override = entry.regionOverrides[region];
      targets.push({
        stackKey: makeStackKey(templatePath, region),
        templatePath,
        stackName,
        region,
        // FR-13-3: 共通値に regionOverrides.<region> を浅くマージ。
        parameters: { ...entry.parameters, ...(override?.parameters ?? {}) },
        // FR-11/FR-13-3: タグは defaultTags < tags < regionOverrides.tags の
        // 順に浅くマージ(後勝ち)。重複キーはエラーとせず、より狭いスコープが優先される。
        tags: {
          ...config.defaultTags,
          ...entry.tags,
          ...(override?.tags ?? {}),
        },
        capabilities: [...entry.capabilities],
        dependsOn: [...entry.dependsOn],
      });
    }
  }

  return targets;
}

/** dependsOn のテンプレートパスを同一リージョンのスタックキーへ解決する。 */
/** design.md §8.2: 値が __REQUIRED__ のままのパラメータ名を列挙する。 */
export function findRequiredPlaceholders(
  target: ResolvedStackTarget,
): string[] {
  return Object.entries(target.parameters)
    .filter(([, value]) => value === REQUIRED_PLACEHOLDER)
    .map(([key]) => key);
}
