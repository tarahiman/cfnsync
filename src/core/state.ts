/**
 * T-04 core/state — ステートのスキーマと世代管理(純粋ロジック)。
 *
 * design.md §4.3(ステートファイル `cfnsync.state.json`)/ §4.5(バックエンドと
 * 排他制御)に対応するスキーマ定義と判定ロジックのみを持つ。ファイル・S3 への
 * 実際の読み書きは `StateBackend`(ports、T-10)が担うため、このモジュールは
 * fs / AWS SDK を import しない。
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { type ErrorContext, StateCorruptionError } from './errors.js';
import { parseStackKey, type StackKey } from './types.js';

/** 破損したステート(不完全 JSON・スキーマ不一致)を検出した際のエラー(FR-1-12, fail-closed)。 */
const StackEntryBaseSchema = z.object({
  stackName: z.string().min(1),
  region: z.string().min(1),
  templateHash: z.string().min(1),
  inputsHash: z.string().min(1),
  exports: z.array(z.string()),
  imports: z.array(z.string()),
  lastAction: z.enum(['CREATE', 'UPDATE', 'IMPORT', 'SYNC']),
  lastSuccessAt: z.string().min(1),
});

const StackEntrySchema = StackEntryBaseSchema.extend({
  /** v1 由来の未移行エントリだけ null。新規成功保存では必ず ARN。 */
  stackId: z.string().min(1).nullable(),
  /** v1 で欠落していた明示依存情報を空配列と区別する unknown。 */
  dependsOn: z.array(z.string()).nullable(),
  dependencyAnalysisIncomplete: z.boolean(),
});

const V1StackEntrySchema = StackEntryBaseSchema.extend({
  stackId: z.string().min(1).optional(),
  dependsOn: z.array(z.string()).optional(),
  dependencyAnalysisIncomplete: z.boolean().optional(),
});

const CfnSyncStateV1Schema = z.object({
  schemaVersion: z.literal(1),
  accountId: z.string().nullable(),
  generation: z.number().int().nonnegative(),
  stacks: z.record(z.string(), V1StackEntrySchema),
});

const CfnSyncStateV2Schema = z.object({
  schemaVersion: z.literal(2),
  accountId: z.string().nullable(),
  generation: z.number().int().nonnegative(),
  stacks: z.record(z.string(), StackEntrySchema),
});

/** design.md §4.3 のステートスキーマから導出したスタックエントリの型。 */
export type StackEntry = z.infer<typeof StackEntrySchema>;

/** design.md §4.3 のステートスキーマから導出したステート全体の型。 */
export type CfnSyncState = z.infer<typeof CfnSyncStateV2Schema> & {
  stacks: Record<StackKey, StackEntry>;
};

/**
 * ステート JSON テキストをパース + zod 検証する(§4.3, FR-1-12)。
 * 不完全な JSON・スキーマ不一致はいずれも `StateCorruptionError` として
 * fail-closed に扱う。
 */
export function parseState(
  text: string,
  context: ErrorContext = {},
): CfnSyncState {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (cause) {
    throw new StateCorruptionError(
      'ステートの JSON 解析に失敗しました(不完全な JSON の可能性があります)',
      {
        ...context,
        cause,
      },
    );
  }

  const v2Result = CfnSyncStateV2Schema.safeParse(parsedJson);
  if (v2Result.success) {
    const state = v2Result.data as CfnSyncState;
    assertStateConsistency(state, context);
    return state;
  }

  const v1Result = CfnSyncStateV1Schema.safeParse(parsedJson);
  if (!v1Result.success) {
    throw new StateCorruptionError('ステートのスキーマが不正です', {
      ...context,
      cause: v2Result.error,
    });
  }

  const stacks: Record<string, StackEntry> = {};
  for (const [key, entry] of Object.entries(v1Result.data.stacks)) {
    stacks[key] = {
      ...entry,
      stackId: entry.stackId ?? null,
      dependsOn: entry.dependsOn ?? null,
      // v1 で欠落した解析完全性は fail-closed に「不完全」として移行する。
      // false(完全)へ倒すと、動的依存の警告を含むまま作られた旧エントリの
      // 削除を誤って許可してしまう。
      dependencyAnalysisIncomplete: entry.dependencyAnalysisIncomplete ?? true,
    };
  }
  const migrated = {
    schemaVersion: 2,
    accountId: v1Result.data.accountId,
    generation: v1Result.data.generation,
    stacks,
  } as CfnSyncState;
  assertStateConsistency(migrated, context);
  return migrated;
}

const STACK_ARN_PATTERN =
  /^arn:[^:]+:cloudformation:([^:]+):(\d{12}):stack\/.+/;

/**
 * ステートの内部整合性を検証する(fail-closed)。
 * - スタックキー末尾のリージョンとエントリの `region` の一致(削除計画は
 *   キー側、旧グラフはエントリ側を使うため、不一致は誤リージョンでの
 *   「スタックなし → state 除去」を引き起こす)。
 * - `stackId` が CloudFormation ARN 形式の場合、ARN のリージョン・アカウント
 *   とエントリ・ステートの記録の一致。
 */
function assertStateConsistency(
  state: CfnSyncState,
  context: ErrorContext,
): void {
  for (const [key, entry] of Object.entries(state.stacks)) {
    let keyRegion: string;
    try {
      keyRegion = parseStackKey(key).region;
    } catch (cause) {
      throw new StateCorruptionError(
        `ステートのスタックキー '${key}' が不正な形式です`,
        { ...context, cause },
      );
    }
    if (keyRegion !== entry.region) {
      throw new StateCorruptionError(
        `ステートのスタックキー '${key}' のリージョンとエントリの region '${entry.region}' が一致しません`,
        { ...context, stackKey: key },
      );
    }
    if (entry.stackId !== null) {
      const arn = STACK_ARN_PATTERN.exec(entry.stackId);
      if (arn !== null) {
        if (arn[1] !== entry.region) {
          throw new StateCorruptionError(
            `ステートのスタックキー '${key}' の stackId ARN のリージョン '${arn[1]}' がエントリの region と一致しません`,
            { ...context, stackKey: key },
          );
        }
        if (state.accountId !== null && arn[2] !== state.accountId) {
          throw new StateCorruptionError(
            `ステートのスタックキー '${key}' の stackId ARN のアカウントがステートの accountId と一致しません`,
            { ...context, stackKey: key },
          );
        }
      }
    }
  }
}

/** ステート未存在(初回実行)時に使う空ステート(FR-1-15)。 */
export function createInitialState(): CfnSyncState {
  return {
    schemaVersion: 2,
    accountId: null,
    generation: 0,
    stacks: {},
  };
}

/**
 * 安定した整形 JSON にシリアライズする。フィールド順・スタックキーの並びを
 * 固定することで、保存内容が入力オブジェクトの構築順に依存しないようにする。
 */
export function serializeState(state: CfnSyncState): string {
  const sortedStacks: Record<string, StackEntry> = {};
  for (const key of Object.keys(state.stacks).sort()) {
    const entry = state.stacks[key];
    sortedStacks[key] = {
      stackName: entry.stackName,
      stackId: entry.stackId,
      region: entry.region,
      templateHash: entry.templateHash,
      inputsHash: entry.inputsHash,
      exports: entry.exports,
      imports: entry.imports,
      dependsOn: entry.dependsOn,
      dependencyAnalysisIncomplete: entry.dependencyAnalysisIncomplete,
      lastAction: entry.lastAction,
      lastSuccessAt: entry.lastSuccessAt,
    };
  }

  const ordered = {
    schemaVersion: state.schemaVersion,
    accountId: state.accountId,
    generation: state.generation,
    stacks: sortedStacks,
  };

  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * 保存用ペイロードを生成する。世代をインクリメントするのみで、それ以外は
 * イミュータブルに複製する(FR-1-6)。実際の compare-and-swap 書き込みは
 * `StateBackend`(T-10)が担う。
 */
export function prepareSave(state: CfnSyncState): CfnSyncState {
  return {
    ...state,
    schemaVersion: 2,
    generation: state.generation + 1,
  };
}

/**
 * ステートに記録された `accountId` と接続先アカウント ID を照合する
 * (FR-1-13 前半)。実行時の拒否判定自体は usecase/guard(T-12)が行う。
 */
export function matchAccount(
  state: CfnSyncState,
  resolvedAccountId: string,
): 'match' | 'mismatch' | 'unrecorded' {
  if (state.accountId === null) {
    return 'unrecorded';
  }
  return state.accountId === resolvedAccountId ? 'match' : 'mismatch';
}

/** `accountId` を記録した新しいステートを返す(イミュータブル)。 */
export function withAccountId(
  state: CfnSyncState,
  accountId: string,
): CfnSyncState {
  return {
    ...state,
    accountId,
  };
}

/**
 * スタックエントリを追加または更新した新しいステートを返す(イミュータブル、
 * FR-8-5)。`entry.exports` / `entry.imports` がそのまま記録される。
 */
export function upsertStackEntry(
  state: CfnSyncState,
  key: StackKey,
  entry: StackEntry,
): CfnSyncState {
  return {
    ...state,
    stacks: {
      ...state.stacks,
      [key]: entry,
    },
  };
}

/** スタックエントリを削除した新しいステートを返す(イミュータブル)。 */
export function removeStackEntry(
  state: CfnSyncState,
  key: StackKey,
): CfnSyncState {
  const stacks = { ...state.stacks };
  delete stacks[key];
  return {
    ...state,
    stacks,
  };
}

/**
 * `sha256:<hex>` 形式のハッシュを計算する(§4.3 の `templateHash` /
 * `inputsHash` 表記)。後続タスク(core/detect 等)が再利用する。
 */
export function sha256Hex(data: string): string {
  return `sha256:${createHash('sha256').update(data, 'utf8').digest('hex')}`;
}

/** バックエンド識別子から変更セット命名用の短縮ハッシュを導出する。 */
export function shortStateId(identifier: string): string {
  return sha256Hex(identifier)
    .replace(/^sha256:/, '')
    .slice(0, 12);
}
