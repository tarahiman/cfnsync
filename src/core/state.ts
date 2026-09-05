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

/**
 * FR-1-16 / §4.3: 削除待ち(pending deletion)1 件。`stacks` から外れたが AWS 上に
 * まだ存在しうる物理スタックの記録であり、FR-6 の安全装置が必要とする情報と由来だけを持つ。
 * `templateHash` / `inputsHash` / `lastAction` を持たないのは、削除以外の操作対象に
 * ならないためである(偽の値を `inputsHash` 判定へ持ち込まない)。
 */
const PendingDeletionSchema = z.object({
  stackName: z.string().min(1),
  /** v1 由来の未移行エントリからの記録だけ null。null なら削除は fail-closed に拒否される。 */
  stackId: z.string().min(1).nullable(),
  region: z.string().min(1),
  exports: z.array(z.string()),
  imports: z.array(z.string()),
  /** v1 由来で明示依存が unknown だった場合は null(FR-6-5 の拒否対象)。 */
  dependsOn: z.array(z.string()).nullable(),
  dependencyAnalysisIncomplete: z.boolean(),
  /** 記録の由来となったスタックキー(リネーム元)。 */
  originStackKey: z.string().min(1),
  /** 未知の値は fail-closed に拒否する(将来の追加は schema 変更として扱う)。 */
  reason: z.enum(['rename']),
  recordedAt: z.string().min(1),
});

const CfnSyncStateV3Schema = z.object({
  schemaVersion: z.literal(3),
  accountId: z.string().nullable(),
  generation: z.number().int().nonnegative(),
  stacks: z.record(z.string(), StackEntrySchema),
  pendingDeletions: z.record(z.string(), PendingDeletionSchema),
});

/** design.md §4.3 のステートスキーマから導出したスタックエントリの型。 */
export type StackEntry = z.infer<typeof StackEntrySchema>;

/** FR-1-16 / §4.3: 削除待ちの記録。 */
export type PendingDeletionEntry = z.infer<typeof PendingDeletionSchema>;

/**
 * FR-6 の削除安全装置が必要とする最小の記録(`StackEntry` と `PendingDeletionEntry` の
 * 共通部分)。`usecase/delete` はこの構造だけに依存し、削除待ちと通常エントリを
 * 同一の安全装置へ通す。
 */
export interface DeletableStackRecord {
  stackName: string;
  stackId: string | null;
  region: string;
  exports: string[];
  imports: string[];
  dependsOn: string[] | null;
  dependencyAnalysisIncomplete: boolean;
}

/** design.md §4.3 のステートスキーマから導出したステート全体の型。 */
export type CfnSyncState = z.infer<typeof CfnSyncStateV3Schema> & {
  stacks: Record<StackKey, StackEntry>;
};

/**
 * FR-1-21 / §4.4: 削除待ちを変更検知・実行計画へ載せるためのスタックキーの予約
 * プレフィックス。設定検証が `cfnsync:` で始まるテンプレートパスを拒否する
 * (FR-11-11)ため、設定由来のスタックキーと決して衝突しない。
 */
export const PENDING_DELETION_STACK_KEY_PREFIX = 'cfnsync:pending/';

/**
 * FR-1-16: 削除待ちの ID。同一リージョン内でスタック名は物理スタックの一意識別子
 * であり、CloudFormation のスタック名は `@` を含められないため曖昧さがない。
 */
export function pendingDeletionId(region: string, stackName: string): string {
  return `${stackName}@${region}`;
}

/** FR-1-21: 削除待ちの ID から、実行計画で用いる予約スタックキーを導出する。 */
export function pendingDeletionStackKey(id: string): StackKey {
  return `${PENDING_DELETION_STACK_KEY_PREFIX}${id}`;
}

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

  const v3Result = CfnSyncStateV3Schema.safeParse(parsedJson);
  if (v3Result.success) {
    const state = v3Result.data as CfnSyncState;
    assertStateConsistency(state, context);
    return state;
  }

  // FR-1-17: v2 は削除待ちなしとして受理し、v3 の形へ移行する。
  const v2Result = CfnSyncStateV2Schema.safeParse(parsedJson);
  if (v2Result.success) {
    const state = {
      schemaVersion: 3,
      accountId: v2Result.data.accountId,
      generation: v2Result.data.generation,
      stacks: v2Result.data.stacks,
      pendingDeletions: {},
    } as CfnSyncState;
    assertStateConsistency(state, context);
    return state;
  }

  const v1Result = CfnSyncStateV1Schema.safeParse(parsedJson);
  if (!v1Result.success) {
    throw new StateCorruptionError('ステートのスキーマが不正です', {
      ...context,
      cause: v3Result.error,
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
    schemaVersion: 3,
    accountId: v1Result.data.accountId,
    generation: v1Result.data.generation,
    stacks,
    // FR-1-17: v1 にも削除待ちは存在しない。
    pendingDeletions: {},
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
    assertStackIdArn(state, entry, `スタックキー '${key}'`, key, context);
  }

  // FR-1-16: 削除待ちも同じ内部整合性検証を通す。キーは物理スタックの一意識別子
  // であり、ここが崩れると誤ったスタックへ DeleteStack を送りうる。
  for (const [id, pending] of Object.entries(state.pendingDeletions)) {
    const label = `削除待ち '${id}'`;
    const pendingKey = pendingDeletionStackKey(id);
    if (id !== pendingDeletionId(pending.region, pending.stackName)) {
      throw new StateCorruptionError(
        `ステートの${label}のキーが stackName '${pending.stackName}' / region '${pending.region}' と一致しません`,
        { ...context, stackKey: pendingKey },
      );
    }
    let originRegion: string;
    try {
      originRegion = parseStackKey(pending.originStackKey).region;
    } catch (cause) {
      throw new StateCorruptionError(
        `ステートの${label}の originStackKey '${pending.originStackKey}' が不正な形式です`,
        { ...context, cause, stackKey: pendingKey },
      );
    }
    if (originRegion !== pending.region) {
      throw new StateCorruptionError(
        `ステートの${label}の originStackKey '${pending.originStackKey}' のリージョンが region '${pending.region}' と一致しません`,
        { ...context, stackKey: pendingKey },
      );
    }
    assertStackIdArn(state, pending, label, pendingKey, context);
  }
}

/** `stackId` が CloudFormation ARN 形式の場合のリージョン・アカウント照合(fail-closed)。 */
function assertStackIdArn(
  state: CfnSyncState,
  record: { stackId: string | null; region: string },
  label: string,
  stackKey: string,
  context: ErrorContext,
): void {
  if (record.stackId === null) return;
  const arn = STACK_ARN_PATTERN.exec(record.stackId);
  if (arn === null) return;
  if (arn[1] !== record.region) {
    throw new StateCorruptionError(
      `ステートの${label} の stackId ARN のリージョン '${arn[1]}' がエントリの region と一致しません`,
      { ...context, stackKey },
    );
  }
  if (state.accountId !== null && arn[2] !== state.accountId) {
    throw new StateCorruptionError(
      `ステートの${label} の stackId ARN のアカウントがステートの accountId と一致しません`,
      { ...context, stackKey },
    );
  }
}

/** ステート未存在(初回実行)時に使う空ステート(FR-1-15)。 */
export function createInitialState(): CfnSyncState {
  return {
    schemaVersion: 3,
    accountId: null,
    generation: 0,
    stacks: {},
    pendingDeletions: {},
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

  // FR-1-16: 削除待ちもキー順・フィールド順を固定して保存内容を決定的にする。
  const sortedPendingDeletions: Record<string, PendingDeletionEntry> = {};
  for (const id of Object.keys(state.pendingDeletions).sort()) {
    const pending = state.pendingDeletions[id];
    sortedPendingDeletions[id] = {
      stackName: pending.stackName,
      stackId: pending.stackId,
      region: pending.region,
      exports: pending.exports,
      imports: pending.imports,
      dependsOn: pending.dependsOn,
      dependencyAnalysisIncomplete: pending.dependencyAnalysisIncomplete,
      originStackKey: pending.originStackKey,
      reason: pending.reason,
      recordedAt: pending.recordedAt,
    };
  }

  const ordered = {
    schemaVersion: state.schemaVersion,
    accountId: state.accountId,
    generation: state.generation,
    stacks: sortedStacks,
    pendingDeletions: sortedPendingDeletions,
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
    // FR-1-17: v1 / v2 から読み込んだステートも保存時に v3 へ正規化する。
    schemaVersion: 3,
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

/**
 * FR-1-16 / FR-1-18: 削除待ちを追加または更新した新しいステートを返す(イミュータブル)。
 * 呼び出し側は、リネームの新エントリ保存と**同一の保存ペイロード**へこの結果を渡すこと。
 */
export function upsertPendingDeletion(
  state: CfnSyncState,
  id: string,
  entry: PendingDeletionEntry,
): CfnSyncState {
  return {
    ...state,
    pendingDeletions: {
      ...state.pendingDeletions,
      [id]: entry,
    },
  };
}

/** FR-1-20: 削除待ちを除去した新しいステートを返す(イミュータブル)。 */
export function removePendingDeletion(
  state: CfnSyncState,
  id: string,
): CfnSyncState {
  const pendingDeletions = { ...state.pendingDeletions };
  delete pendingDeletions[id];
  return {
    ...state,
    pendingDeletions,
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
