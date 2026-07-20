/**
 * T-13 usecase/executor — 変更セットのライフサイクル(FR-2 / design.md §7)。
 *
 * ここは安全性の中核であり、Codex レビュー承認条件(実行直前再検査を
 * `ExecuteChangeSet` の直前に固定)を実装する。仕様の保証を弱めないこと:
 * - **変更セット所有権**: 名前 `cfnsync-<stateID>-<runID>-<timestamp>` で判定し、
 *   回収してよいのは自ステート ID の変更セットのみ。他主体(別ステート / 非 cfnsync /
 *   命名から判定不能)は削除せず fail-closed に中断する(FR-2-7)。
 * - **REVIEW_IN_PROGRESS**: スタック自体の `DeleteStack` は絶対に行わず、自ステートの
 *   変更セットのみ個別に破棄して `CREATE` 型を再作成して続行する(FR-2-10)。
 * - **実行直前再検査**: `ExecuteChangeSet` は同一スタックの他の変更セットを暗黙削除する
 *   ため、実行の直前に `ListChangeSets` で再検査し、自変更セット以外が 1 つでもあれば
 *   実行せず中断する(FR-2-11)。再検査から実行までの競合窓はベストエフォート(§7)。
 *
 * `CloudFormationGateway`(ports)を介してのみ AWS を操作し、SDK には依存しない。
 */

import { randomBytes } from 'node:crypto';
import type { ResolvedStackTarget } from '../core/config.js';
import { StackStateError } from '../core/errors.js';
import type {
  ChangeSetDetail,
  CloudFormationGateway,
  StackSummary,
} from '../ports/index.js';
import { identityRedactor, type TextRedactor } from './redactor.js';

/** 管理タグのキー(§8.4)。値は stateId。CreateChangeSet の Tags に常時マージする(FR-2-9)。 */
export const MANAGEMENT_TAG_KEY = 'cfnsync:state-id';

/** ツール由来を示すプレフィックス(§7 命名規則)。 */
const CHANGESET_PREFIX = 'cfnsync';

/** AWS が空変更セットに返す既知の定型文。先頭一致のみ許可する(FR-2-3)。 */
const NO_CHANGE_REASONS = [
  "The submitted information didn't contain changes. Submit different information to create a change set.",
  'No updates are to be performed.',
] as const;

/**
 * executor 系関数が共有する実行文脈。`stateId` はバックエンド識別子の短縮ハッシュ、
 * `runId` は実行単位の識別子(`newRunId()`)。`now` はテスト用に注入可能。
 */
export interface ExecutorContext {
  cfn: CloudFormationGateway;
  target: { stackKey: string; region: string };
  stateId: string;
  runId: string;
  now?: () => Date;
  /** 対象スタックの NoEcho 実効値を AWS 由来テキストから除去する。 */
  redact?: TextRedactor;
}

function targetContext(ctx: ExecutorContext): {
  stackKey: string;
  region: string;
} {
  return ctx.target;
}

// ===========================================================================
// 命名規則 / 所有権判定(FR-2-6 / FR-2-7)
// ===========================================================================

/** 英数字のみの実行 ID を生成する(§7。ハイフンを含まない前提で命名に埋め込む)。 */
export function newRunId(): string {
  return randomBytes(8).toString('hex');
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * 変更セット名 `cfnsync-<stateID>-<runID>-<UTCタイムスタンプ>` を生成する(FR-2-6)。
 * タイムスタンプは UTC の `YYYYMMDDTHHmmssSSS`(英数字のみ・ハイフンなし)。stateId(12hex)・
 * runId(16hex)にハイフンを含まない前提で、`parseChangeSetName` が一意にパースできる。
 * 結果は CloudFormation の制約(先頭英字・英数字とハイフン・128 文字以内)を満たす。
 */
export function changeSetName(ctx: {
  stateId: string;
  runId: string;
  now?: () => Date;
}): string {
  const d = (ctx.now ?? (() => new Date()))();
  const timestamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}` +
    `T${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}${pad(d.getUTCSeconds(), 2)}${pad(d.getUTCMilliseconds(), 3)}`;
  return `${CHANGESET_PREFIX}-${ctx.stateId}-${ctx.runId}-${timestamp}`;
}

/** `parseChangeSetName` の結果。`tool` は cfnsync 由来か、`stateId`/`runId` は判定できた場合のみ。 */
export interface ParsedChangeSetName {
  /** `cfnsync-` プレフィックスを持つ(ツール由来)か。 */
  tool: boolean;
  /** 命名規則を満たす場合のステート ID(判定不能なら undefined)。 */
  stateId?: string;
  /** 命名規則を満たす場合の実行 ID(判定不能なら undefined)。 */
  runId?: string;
}

const CHANGESET_NAME_PATTERN =
  /^cfnsync-([0-9a-f]{12})-([0-9a-f]{16})-(\d{4}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3])[0-5]\d[0-5]\d\d{3})$/;

/**
 * 変更セット名から所有権を判定する(FR-2-7 / §7)。
 * - 非 `cfnsync-` → `{ tool: false }`(人手・他ツール由来)。
 * - stateId(12hex)・runId(16hex)・UTC timestamp(`YYYYMMDDTHHmmssSSS`)へ完全一致
 *   → `{ tool: true, stateId, runId }`。
 * - `cfnsync-` だが形式不正 → `{ tool: true }`(判定不能)。
 */
export function parseChangeSetName(name: string): ParsedChangeSetName {
  if (!name.startsWith(`${CHANGESET_PREFIX}-`)) {
    return { tool: false };
  }
  const match = CHANGESET_NAME_PATTERN.exec(name);
  if (!match) return { tool: true };
  return { tool: true, stateId: match[1], runId: match[2] };
}

/** 自ステートが所有する(=回収してよい)変更セットか。名前が命名規則を満たし stateId が一致する場合のみ真。 */
function isOwnChangeSet(name: string, stateId: string): boolean {
  const parsed = parseChangeSetName(name);
  return parsed.tool && parsed.stateId === stateId;
}

// ===========================================================================
// スタック状態ガード(FR-2-1 / 2 / 4 / 8 / 10)
// ===========================================================================

/** `prepareStack` の結果。スタック状態から決めた変更セット型と、REVIEW_IN_PROGRESS 由来かを持つ。 */
export interface PrepareResult {
  /** `added`(不存在 / REVIEW_IN_PROGRESS)→ `create`、既存の完了系 → `update`。 */
  kind: 'create' | 'update';
  /** `DescribeStacks` が返したステータス。スタック不存在時は undefined。 */
  stackStatus?: string;
  /** 空スタック(REVIEW_IN_PROGRESS)上に CREATE 型を再作成するケースか(FR-2-10。回収済みを示す)。 */
  reviewInProgress: boolean;
}

/**
 * 変更セット作成前のスタック状態ガード(design.md §7)。
 * - 不存在 → `CREATE`
 * - `REVIEW_IN_PROGRESS` → 残存変更セットを回収(自ステートのみ削除・他主体は中断)後 `CREATE`。
 *   **`DeleteStack` は決して呼ばない**(FR-2-10)。
 * - `ROLLBACK_COMPLETE` → `StackStateError`(スタック削除の必要性を案内。FR-2-4)
 * - `*_IN_PROGRESS` → `StackStateError`(並行操作。FR-2-8)
 * - その他の完了系 → `UPDATE`
 */
export async function prepareStack(
  ctx: ExecutorContext,
  stackName: string,
  known?: { summary: StackSummary | undefined },
): Promise<PrepareResult> {
  const summary = known
    ? known.summary
    : await ctx.cfn.describeStack(stackName);

  if (summary === undefined) {
    return { kind: 'create', reviewInProgress: false };
  }

  const status = summary.status;

  // REVIEW_IN_PROGRESS は `_IN_PROGRESS` で終わるため、汎用ガードより先に判定する。
  if (status === 'REVIEW_IN_PROGRESS') {
    // §7 / FR-2-10: スタック自体は削除せず、自ステートの変更セットのみ回収して CREATE を再作成する。
    // 他主体の変更セットがあれば reclaimStaleChangeSets が fail-closed に中断する。
    await reclaimStaleChangeSets(ctx, stackName);
    return { kind: 'create', stackStatus: status, reviewInProgress: true };
  }

  if (status === 'ROLLBACK_COMPLETE') {
    throw new StackStateError(
      `スタック '${stackName}' は ${status} 状態のためデプロイできません(CREATE 失敗後の残骸です)。` +
        `対処: 当該スタックを削除してから再実行してください`,
      targetContext(ctx),
    );
  }

  if (status.endsWith('_IN_PROGRESS')) {
    throw new StackStateError(
      `スタック '${stackName}' は ${status} 状態です。別の操作が進行中の可能性があるため、変更セットを作成せず中断します`,
      targetContext(ctx),
    );
  }

  return { kind: 'update', stackStatus: status, reviewInProgress: false };
}

// ===========================================================================
// 残存変更セットの回収(FR-2-7)
// ===========================================================================

/**
 * 対象スタックの未実行変更セットを `ListChangeSets`(ゲートウェイが全ページ走査)で列挙し、
 * 所有権を判定して処理する(FR-2-7 / §7)。
 * - 自ステート ID の `cfnsync-` → `DeleteChangeSet` で回収して続行。
 * - 他主体(別ステート ID の `cfnsync-` / 非 `cfnsync-` / 命名から判定不能)が **1 つでも**あれば、
 *   何も削除せず `StackStateError` で中断する(fail-closed)。後続の `ExecuteChangeSet` が
 *   他の変更セットを暗黙削除してしまうため、解決後の再実行を案内する。
 */
export async function reclaimStaleChangeSets(
  ctx: ExecutorContext,
  stackName: string,
): Promise<void> {
  const summaries = await ctx.cfn.listChangeSets(stackName);

  const own: Array<{ name: string; id: string }> = [];
  const foreign: string[] = [];
  for (const summary of summaries) {
    if (isOwnChangeSet(summary.name, ctx.stateId)) {
      own.push({ name: summary.name, id: summary.id });
    } else {
      foreign.push(summary.name);
    }
  }

  // 他主体が存在する場合は、自ステートの変更セットにも触れずに中断する(削除の前に判定する)。
  if (foreign.length > 0) {
    throw new StackStateError(
      `スタック '${stackName}' に cfnsync(このステート)が所有しない未実行の変更セットが残存しています: ` +
        `${foreign.join(', ')}。同一スタックが別のステート設定・他ツール・人手から操作されている可能性があります。` +
        `手動で解決(当該変更セットの実行または削除)してから再実行してください`,
      targetContext(ctx),
    );
  }

  for (const changeSet of own) {
    // 過去形式で ARN が記録されていない残骸も、自 stateId の名前なら従来どおり回収する。
    await ctx.cfn.deleteChangeSet(stackName, changeSet.id || changeSet.name);
  }
}

// ===========================================================================
// 変更セットの作成(FR-2-1 / 2 / 3 / 5 / 9)
// ===========================================================================

function isNoChangeReason(reason: string | undefined): boolean {
  if (!reason) return false;
  const normalized = reason.trim();
  return NO_CHANGE_REASONS.some((pattern) => normalized === pattern);
}

/** `createManagedChangeSet` の入力。`ResolvedStackTarget` からスタック名・入力を取り出す。 */
export interface CreateManagedChangeSetInput {
  target: ResolvedStackTarget;
  templateBody: string;
  /** `prepareStack` の判定に対応。`create` → `CREATE`、`update` → `UPDATE`。 */
  kind: 'create' | 'update';
}

/** `createManagedChangeSet` の結果。`noChanges` が真なら空変更セット(削除済み)。 */
export interface CreateManagedChangeSetResult {
  /** 作成した変更セット名(実行直前再検査で自変更セットの識別に使う)。 */
  name: string;
  /** CreateChangeSet が返した固有 ARN。以後の全操作をこの値へ固定する。 */
  id: string;
  /** 完了までポーリングした変更セット詳細(差分表示に使う)。 */
  detail: ChangeSetDetail;
  /** 空変更セット(実質差分なし)として削除・スキップしたか(FR-2-3)。 */
  noChanges: boolean;
}

/**
 * 管理タグ付きで変更セットを作成し、完了まで待機して空変更セット判定を行う(FR-2)。
 * - 管理タグ `cfnsync:state-id=<stateId>` を Tags にマージ(ユーザータグと共存。FR-2-9)。
 * - `waitForChangeSet` の結果が `FAILED`、既知の「変更なし」定型文へ先頭一致、
 *   `changes.length === 0` の全条件を満たす場合だけ変更セットを削除し
 *   `noChanges: true` を返す(FR-2-3)。それ以外の `FAILED` は `StackStateError`。
 */
export async function createManagedChangeSet(
  ctx: ExecutorContext,
  input: CreateManagedChangeSetInput,
): Promise<CreateManagedChangeSetResult> {
  const { target } = input;
  const name = changeSetName({
    stateId: ctx.stateId,
    runId: ctx.runId,
    now: ctx.now,
  });
  const tags = { ...target.tags, [MANAGEMENT_TAG_KEY]: ctx.stateId };

  const created = await ctx.cfn.createChangeSet({
    stackName: target.stackName,
    changeSetName: name,
    changeSetType: input.kind === 'create' ? 'CREATE' : 'UPDATE',
    templateBody: input.templateBody,
    parameters: target.parameters,
    capabilities: target.capabilities,
    tags,
    description: `cfnsync ${input.kind} (${ctx.runId})`,
  });
  if (!created.id) {
    throw new StackStateError(
      `スタック '${target.stackName}' の CreateChangeSet が変更セット ARN を返しませんでした。実行対象を固定できないため中断します`,
      { stackKey: target.stackKey, region: target.region },
    );
  }

  const rawDetail = await ctx.cfn.waitForChangeSet(
    target.stackName,
    created.id,
  );
  if (rawDetail.name !== name || rawDetail.id !== created.id) {
    throw new StackStateError(
      `スタック '${target.stackName}' の変更セット待機結果が作成対象と一致しません(name/ARN mismatch)。差し替えの可能性があるため中断します`,
      { stackKey: target.stackKey, region: target.region },
    );
  }
  const redact = ctx.redact ?? identityRedactor;
  const detail: ChangeSetDetail = {
    ...rawDetail,
    statusReason:
      rawDetail.statusReason === undefined
        ? undefined
        : redact(rawDetail.statusReason),
  };

  if (detail.status === 'FAILED') {
    if (
      detail.changes.length === 0 &&
      isNoChangeReason(rawDetail.statusReason)
    ) {
      // 空変更セットはエラーではなく「変更なし」。作成された空の変更セットを削除する。
      await ctx.cfn.deleteChangeSet(target.stackName, created.id);
      return { name, id: created.id, detail, noChanges: true };
    }
    throw new StackStateError(
      `スタック '${target.stackName}' の変更セット作成に失敗しました: ${detail.statusReason ?? '(理由不明)'}`,
      { stackKey: target.stackKey, region: target.region },
    );
  }

  return { name, id: created.id, detail, noChanges: false };
}

// ===========================================================================
// 実行直前再検査つきの実行(FR-2-11 / Codex 承認条件)
// ===========================================================================

/**
 * `ExecuteChangeSet` の **直前**に `ListChangeSets` で再検査し、自変更セット以外が 1 つでも
 * 存在する場合は実行せず `StackStateError` で中断する(FR-2-11 / §7)。
 * `ExecuteChangeSet` は同一スタックの他の変更セットを暗黙に削除するため、他主体(他ツール・
 * 別ステート・命名から判定不能)の変更セットを巻き込まないための最終防衛線。
 * 再検査から実行までの競合窓は原理的に排除できないベストエフォート(§7、README に運用規約)。
 */
export async function executeWithReinspection(
  ctx: ExecutorContext,
  stackName: string,
  ownChangeSetName: string,
  ownChangeSetId: string,
  beforeExecute?: () => Promise<void>,
): Promise<void> {
  const summaries = await ctx.cfn.listChangeSets(stackName);
  const own = summaries.filter(
    (summary) =>
      summary.name === ownChangeSetName && summary.id === ownChangeSetId,
  );
  const others = summaries.filter(
    (summary) =>
      summary.name !== ownChangeSetName || summary.id !== ownChangeSetId,
  );

  if (own.length !== 1 || others.length > 0 || summaries.length !== 1) {
    throw new StackStateError(
      `実行直前の再検査で、自変更セット '${ownChangeSetName}' (${ownChangeSetId}) の名前と ARN を一意に確認できませんでした: ` +
        `${summaries.map((summary) => `${summary.name} (${summary.id})`).join(', ') || '(対象なし)'}。` +
        `ExecuteChangeSet は同一スタックの他の変更セットを暗黙削除するため、実行を中止します`,
      targetContext(ctx),
    );
  }

  await beforeExecute?.();
  await ctx.cfn.executeChangeSet(stackName, ownChangeSetId);
}
