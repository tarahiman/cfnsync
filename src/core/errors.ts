/**
 * design.md §9 のエラー分類。すべてスタックキー・リージョン・原因を
 * メッセージに含められるよう、共通の文脈フィールドを持つ。
 */

export interface ErrorContext {
  stackKey?: string;
  region?: string;
  cause?: unknown;
}

export class CfnSyncError extends Error {
  readonly stackKey?: string;
  readonly region?: string;

  constructor(message: string, context: ErrorContext = {}) {
    const parts = [message];
    if (context.stackKey !== undefined) parts.push(`(stackKey: ${context.stackKey})`);
    else if (context.region !== undefined) parts.push(`(region: ${context.region})`);
    super(parts.join(' '), context.cause !== undefined ? { cause: context.cause } : undefined);
    this.name = new.target.name;
    this.stackKey = context.stackKey;
    this.region = context.region;
  }
}

/** 設定ファイルの不備(FR-11)。対象キーをメッセージに含める。 */
export class ConfigError extends CfnSyncError {}

/** 接続先検証の失敗(FR-7, fail-closed)。 */
export class GuardError extends CfnSyncError {}

/** ステートの世代不一致・CAS 競合(FR-1)。 */
export class StateConflictError extends CfnSyncError {}

/** 依存グラフの循環(FR-8)。循環メンバーを保持する。 */
export class DependencyCycleError extends CfnSyncError {
  readonly cycle: string[];

  constructor(cycle: string[], context: ErrorContext = {}) {
    super(`依存関係に循環があります: ${cycle.join(' -> ')}`, context);
    this.cycle = cycle;
  }
}

/** デプロイ不能なスタック状態・並行操作(FR-2)。 */
export class StackStateError extends CfnSyncError {}

/** AWS API 呼び出しの失敗。 */
export class AwsError extends CfnSyncError {}

/** ステートロックの取得失敗・所有権喪失(FR-1)。 */
export class LockError extends CfnSyncError {}
