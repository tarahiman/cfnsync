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
import {
  CfnSyncError,
  type ErrorContext,
  StateConflictError,
} from './errors.js';
import type { StackKey } from './types.js';

/** 破損したステート(不完全 JSON・スキーマ不一致)を検出した際のエラー(FR-1-12, fail-closed)。 */
export class StateCorruptionError extends CfnSyncError {}

const StackEntrySchema = z.object({
  stackName: z.string().min(1),
  region: z.string().min(1),
  templateHash: z.string().min(1),
  inputsHash: z.string().min(1),
  exports: z.array(z.string()),
  imports: z.array(z.string()),
  lastAction: z.enum(['CREATE', 'UPDATE', 'IMPORT', 'SYNC']),
  lastSuccessAt: z.string().min(1),
});

const CfnSyncStateSchema = z.object({
  schemaVersion: z.literal(1),
  accountId: z.string().nullable(),
  generation: z.number().int().nonnegative(),
  stacks: z.record(z.string(), StackEntrySchema),
});

/** design.md §4.3 のステートスキーマから導出したスタックエントリの型。 */
export type StackEntry = z.infer<typeof StackEntrySchema>;

/** design.md §4.3 のステートスキーマから導出したステート全体の型。 */
export type CfnSyncState = z.infer<typeof CfnSyncStateSchema> & {
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

  const result = CfnSyncStateSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new StateCorruptionError('ステートのスキーマが不正です', {
      ...context,
      cause: result.error,
    });
  }

  return result.data as CfnSyncState;
}

/** ステート未存在(初回実行)時に使う空ステート(FR-1-15)。 */
export function createInitialState(): CfnSyncState {
  return {
    schemaVersion: 1,
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
      region: entry.region,
      templateHash: entry.templateHash,
      inputsHash: entry.inputsHash,
      exports: entry.exports,
      imports: entry.imports,
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
    generation: state.generation + 1,
  };
}

/**
 * 読込時点の世代(`loadedGeneration`)と現在の世代(`currentGeneration`)を
 * 比較し、不一致であれば `StateConflictError` を投げる(FR-1-6)。
 */
export function assertGeneration(
  loadedGeneration: number,
  currentGeneration: number,
  context: ErrorContext = {},
): void {
  if (loadedGeneration !== currentGeneration) {
    throw new StateConflictError(
      `ステートの世代が一致しません(読込時: ${loadedGeneration}, 現在: ${currentGeneration})。他の実行によって変更されている可能性があります`,
      context,
    );
  }
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
