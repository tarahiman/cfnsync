/**
 * T-08 ports 定義 — 下流(usecase / backend / aws)が依存する契約(NFR-2)。
 *
 * design.md §3(依存方向 `cli → usecase → core / ports / report`、`aws` / `backend`
 * は `ports` を実装)に従い、AWS API とステート保存をインターフェースとして
 * 抽象化する。ここには型・シグネチャのみを置き、実装(SDK 呼び出し・ファイル /
 * S3 I/O)は `aws/` / `backend/` に置く。
 *
 * ports は型としてのみ `core/state`(純粋モジュール)の `CfnSyncState` を参照する
 * (StateBackend の load/save の対象)。これは型依存に限られ、実行時依存は持たない。
 */

import type { Capability } from '../core/config.js';
import type { CfnSyncState } from '../core/state.js';

// ===========================================================================
// CloudFormationGateway(FR-2 / FR-4 / FR-6 / §7)
// ===========================================================================

/**
 * `DescribeStacks` の 1 スタック分を正規化した要約。
 * パラメータ・タグ・Outputs は配列ではなく Record に整形する(下流が扱いやすい形)。
 */
export interface StackSummary {
  stackName: string;
  stackId: string;
  /** CloudFormation の StackStatus(例: `CREATE_COMPLETE` / `ROLLBACK_COMPLETE` / `REVIEW_IN_PROGRESS`)。 */
  status: string;
  statusReason?: string;
  /** ParameterKey → ParameterValue(NoEcho は AWS 側で `****`。マスク判定は report(T-11))。 */
  parameters: Record<string, string>;
  /** タグ Key → Value。管理タグ `cfnsync:state-id=<stateID>` の由来確認に用いる(§8.4)。 */
  tags: Record<string, string>;
  capabilities: Capability[];
  /** OutputKey → OutputValue。 */
  outputs: Record<string, string>;
  terminationProtection: boolean;
}

/** `ListChangeSets` の Summaries 1 件分(残存回収・実行直前再検査で所有権判定に使う)。 */
export interface ChangeSetSummary {
  /** ChangeSetName。命名規則 `cfnsync-<stateID>-<runID>-<timestamp>` の所有権判定に使う(§7)。 */
  name: string;
  /** ChangeSetId(ARN)。 */
  id: string;
  /** 変更セットのステータス(`CREATE_COMPLETE` / `FAILED` 等)。 */
  status: string;
  statusReason?: string;
  /** `UNAVAILABLE` / `AVAILABLE` / `EXECUTE_*` / `OBSOLETE`。 */
  executionStatus?: string;
  /** ISO8601 文字列。 */
  creationTime?: string;
}

/** `DescribeChangeSet` の Changes[] を正規化したリソース変更(report(T-11)が種別・プロパティを整形する)。 */
export interface ResourceChange {
  /** `Add` / `Modify` / `Remove` / `Import` / `Dynamic`。 */
  action: string;
  logicalResourceId: string;
  physicalResourceId?: string;
  resourceType: string;
  /** `True` / `False` / `Conditional`。`True`/`Conditional` は置換警告の対象(FR-3-2)。 */
  replacement?: string;
  scope: string[];
  details: ResourceChangeDetail[];
}

/** `ResourceChange.Details[]` の 1 件(変更されたプロパティの特定に使う)。 */
export interface ResourceChangeDetail {
  target?: {
    attribute?: string;
    name?: string;
    requiresRecreation?: string;
  };
  evaluation?: string;
  changeSource?: string;
  causingEntity?: string;
}

/**
 * `DescribeChangeSet` を全ページ結合して正規化した詳細。
 * `changes` は NextToken を辿って全ページ結合済み。空変更セット判定(FR-2-3)は
 * `status === 'FAILED'`、既知の `statusReason` 定型文、`changes.length === 0` の
 * すべてを満たす場合だけ行う(usecase/executor(T-13))。
 */
export interface ChangeSetDetail {
  name?: string;
  id?: string;
  stackId?: string;
  /** `CREATE_PENDING` / `CREATE_IN_PROGRESS` / `CREATE_COMPLETE` / `DELETE_*` / `FAILED`。 */
  status: string;
  statusReason?: string;
  /** `UNAVAILABLE` / `AVAILABLE` / `EXECUTE_*` / `OBSOLETE`。 */
  executionStatus?: string;
  /** 全ページ結合済みのリソース変更一覧。 */
  changes: ResourceChange[];
  parameters: Record<string, string>;
  tags: Record<string, string>;
  capabilities: Capability[];
}

/** `DescribeStackEvents` の 1 イベントを正規化(FR-4-1。イベント逐次出力・失敗原因抽出に使う)。 */
export interface StackEvent {
  eventId: string;
  /** ISO8601 文字列。 */
  timestamp: string;
  logicalResourceId: string;
  resourceType: string;
  resourceStatus: string;
  resourceStatusReason?: string;
}

/** スタック操作開始前の最新イベント位置。以後のイベントだけを逐次取得する境界に使う。 */
export interface StackEventCursor {
  /** 境界イベントが存在する場合の EventId。スタック未作成時は省略する。 */
  eventId?: string;
  /** 境界取得時刻、または境界イベントの Timestamp(ISO8601)。 */
  timestamp: string;
}

/** `CreateChangeSet` の入力(usecase/executor(T-13)が ResolvedStackTarget から組み立てる)。 */
export interface CreateChangeSetInput {
  stackName: string;
  changeSetName: string;
  /** `added` → `CREATE`、`modified` → `UPDATE`(§7 / FR-2-1,2)。 */
  changeSetType: 'CREATE' | 'UPDATE';
  templateBody: string;
  /** ParameterKey → ParameterValue。 */
  parameters: Record<string, string>;
  capabilities: Capability[];
  /** タグ Key → Value(管理タグ `cfnsync:state-id` はここにマージ済みで渡す想定。FR-2-9)。 */
  tags: Record<string, string>;
  description?: string;
}

/** `GetTemplate` の取得ステージ。CREATE 復旧比較・import は `Original`(§7 / FR-10-3)。 */
export type TemplateStage = 'Original' | 'Processed';

/** `waitForStack` のオプション。ポーリング間隔・タイムアウトは注入可能(テストで 0ms 短縮)。 */
export interface WaitForStackOptions {
  /** ポーリング間隔(ms)。省略時はゲートウェイ既定値。 */
  intervalMs?: number;
  /** 全体タイムアウト(ms)。 */
  timeoutMs?: number;
  /** FR-4-1: 待機中に観測した新着イベントを古い順に逐次通知する。 */
  onEvent?: (event: StackEvent) => void;
  /** 操作開始前に取得したイベント境界。省略時は waitForStack 開始時に取得する。 */
  eventCursor?: StackEventCursor;
}

/**
 * CloudFormation 操作のゲートウェイ(§7 の変更セットライフサイクルを過不足なく表現)。
 * 実 AWS 呼び出しは `aws/cloudformation.ts` が SDK v3 で実装し、スロットリングリトライ
 * (NFR-3)をゲートウェイ層で吸収する。
 */
export interface CloudFormationGateway {
  /** `DescribeStacks`。スタック不存在(ValidationError)は `undefined` に吸収する(§7 スタック状態ガード)。 */
  describeStack(stackName: string): Promise<StackSummary | undefined>;

  /** `ListChangeSets` を **NextToken で全ページ走査**して返す(§7 Codex 承認条件)。 */
  listChangeSets(stackName: string): Promise<ChangeSetSummary[]>;

  /** `CreateChangeSet`。生成された ChangeSetId を返す(FR-2-1,2,5,9)。 */
  createChangeSet(input: CreateChangeSetInput): Promise<{ id: string }>;

  /** `DescribeChangeSet` を Changes の NextToken で全ページ結合して返す(FR-2 / FR-3)。 */
  describeChangeSet(
    stackName: string,
    changeSetName: string,
  ): Promise<ChangeSetDetail>;

  /** `DescribeChangeSet` を終端(`CREATE_COMPLETE` / `FAILED` 等)までポーリングして返す。 */
  waitForChangeSet(
    stackName: string,
    changeSetName: string,
  ): Promise<ChangeSetDetail>;

  /** `DeleteChangeSet`(残存回収・空変更セット破棄・plan の後始末。FR-2-3,7)。 */
  deleteChangeSet(stackName: string, changeSetName: string): Promise<void>;

  /** `ExecuteChangeSet`(実行直前再検査は呼び出し側の責務。§7 / FR-2-11)。 */
  executeChangeSet(stackName: string, changeSetName: string): Promise<void>;

  /** `DeleteStack`(§8.3。`REVIEW_IN_PROGRESS` には呼ばないのは呼び出し側の責務。FR-2-10)。 */
  deleteStack(stackName: string): Promise<void>;

  /** 最新イベント 1 件だけから、操作開始前のイベント境界を取得する。 */
  getStackEventCursor(stackName: string): Promise<StackEventCursor>;

  /**
   * `DescribeStackEvents` を `after` 境界(省略時は末尾)までページ走査し、既読を除いた
   * 新着イベントのみを **古い順** で返す(FR-4-1)。
   */
  describeStackEvents(
    stackName: string,
    seenEventIds?: Set<string>,
    after?: StackEventCursor,
  ): Promise<StackEvent[]>;

  /** `GetTemplate`(`Original` は CREATE 復旧比較・import 用。§7 / FR-10-3)。TemplateBody 文字列を返す。 */
  getTemplate(stackName: string, stage: TemplateStage): Promise<string>;

  /** スタック操作が終端ステータスに達するまで待機し、最終要約を返す(FR-4-1)。 */
  waitForStack(
    stackName: string,
    opts?: WaitForStackOptions,
  ): Promise<StackSummary>;
}

// ===========================================================================
// StsGateway(FR-7-6。実装は aws/sts.ts(T-09))
// ===========================================================================

/** STS `GetCallerIdentity` で接続先を解決する(AccountGuard の基盤。FR-7-6)。 */
export interface StsGateway {
  getCallerIdentity(): Promise<{ accountId: string; arn: string }>;
}

// ===========================================================================
// StateBackend(FR-1。実装は backend/local.ts / aws/s3state.ts(T-10))
// ===========================================================================

/**
 * CAS のための世代情報。`local` は保存直前の再読込で `generation` を比較し、
 * `s3` は `etag`(`If-Match`)で条件付き書き込みを行う(§4.5)。
 * `etag` は local では省略可。S3 実装は入出力時に必須検証する。
 */
export type StateVersion = { generation: number; etag?: string };

/**
 * ロック取得結果。fencing の所有権検証と条件付き解放に用いる(§4.5)。
 * `etag` は local では省略可。S3 実装は条件付き解放の前提として必須検証する。
 */
export type LockHandle = { runId: string; etag?: string };

/** ロックオブジェクトの内容(FR-1-10。force-unlock で表示する)。 */
export interface LockInfo {
  runId: string;
  /** ISO8601 文字列。 */
  startedAt: string;
  owner: string;
}

/**
 * ステートの読み書きとロックを抽象化する(§4.5)。`local`(既定・ロックなし)と
 * `s3`(CAS + 条件付き書き込みロック)が実装する。`local` の `acquireLock` /
 * `verifyLock` は常に成功するダミーでよい(design §4.5: 単一環境前提)。
 */
export interface StateBackend {
  /** ステートを読み込む。未存在(初回)は `undefined`(FR-1-15)。 */
  load(): Promise<{ state: CfnSyncState; version: StateVersion } | undefined>;

  /**
   * compare-and-swap 保存(FR-1-6)。`expected` は load 時の版。読込時点から変更されていれば
   * 上書きせず `StateConflictError`。成功時は新しい `StateVersion` を返す。
   * `expected` が `undefined` の場合は新規作成(不存在時のみ成立)。
   */
  save(
    state: CfnSyncState,
    expected: StateVersion | undefined,
  ): Promise<StateVersion>;

  /** ロックを取得する(FR-1-7)。取得失敗(他実行が保持)は `LockError`。 */
  acquireLock(info: LockInfo): Promise<LockHandle>;

  /** fencing 用の所有権検証(FR-1-9)。ロックを再読込し runId / etag が一致すれば true。 */
  verifyLock(handle: LockHandle): Promise<boolean>;

  /**
   * 自身のロックであることを検証する条件付き解放(FR-1-8)。所有者交代等で条件不成立なら
   * 削除せず `{ released: false, reason }` を返す。
   */
  releaseLock(
    handle: LockHandle,
  ): Promise<{ released: boolean; reason?: string }>;

  /** 現在のロック内容を読む(force-unlock 表示用。FR-1-10)。未ロックは `undefined`。 */
  readLock(): Promise<LockInfo | undefined>;

  /** 指定 runId のロックを条件付きで強制解除する(FR-1-8。§5.6)。 */
  forceUnlock(runId: string): Promise<{ released: boolean; reason?: string }>;

  /**
   * バックエンド識別子の短縮ハッシュ(変更セット命名 `cfnsync-<stateID>-...` に使う。§7)。
   * `local`: ステートファイル絶対パス、`s3`: バケット + キー を基にした安定ハッシュ。
   */
  stateId(): string;
}
