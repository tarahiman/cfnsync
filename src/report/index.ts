/**
 * T-11 report — 差分表示・出力(design.md §8.1 / §8.2, requirements.md FR-3 /
 * FR-7-8 / FR-8-3 / FR-13-7 / NFR-4)。
 *
 * usecase(M3, 未実装)が依存する出力契約(構造化された差分・イベント・接続先情報の
 * 型)をここで確定する(依存方向 `cli → usecase → core / ports / report` の遵守。
 * report は core の型を読み取り専用で参照してよいが、逆方向の依存は発生しない)。
 *
 * NoEcho マスク(NFR-4)は差分・ログ・JSON のすべてが対象。`ChangeSetDetail.parameters`
 * の実効パラメータ一覧は取り込まない一方、CloudFormation が変更詳細として返した
 * BeforeValue / AfterValue / context は共通 redactor と causingEntity 判定でマスクする。
 * `renderText` / `renderJson` は、渡された `DeployReport` から契約に定義された
 * フィールドのみを明示的に再構築して出力する(呼び出し側が誤って秘匿情報を余剰
 * フィールドとして紛れ込ませても出力には現れない、多層防御)。
 */

import { MASK } from '../core/constants.js';
import type { RegionGraph } from '../core/graph.js';
import type {
  ChangeSetDetail,
  ResourceChange,
  ResourceChangeDetail,
} from '../ports/index.js';

const CONNECTION_FIELDS = ['accountId', 'regions'] as const;
const DIFF_FIELDS = ['stackKey', 'region', 'stackName', 'operation'] as const;
const RESOURCE_FIELDS = [
  'action',
  'logicalResourceId',
  'resourceType',
  'replacement',
  'replacementType',
  'physicalResourceId',
  'scope',
  'changedProperties',
  'details',
  'beforeContext',
  'afterContext',
  'containsNoEchoChange',
] as const;
const DETAIL_FIELDS = ['evaluation', 'changeSource', 'causingEntity'] as const;
const TARGET_FIELDS = [
  'attribute',
  'name',
  'requiresRecreation',
  'path',
  'beforeValue',
  'afterValue',
  'beforeValueFrom',
  'afterValueFrom',
  'attributeChangeType',
] as const;
const EVENT_FIELDS = [
  'stackKey',
  'region',
  'timestamp',
  'logicalResourceId',
  'resourceType',
  'resourceStatus',
  'resourceStatusReason',
] as const;
const RESULT_FIELDS = [
  'stackKey',
  'region',
  'stackName',
  'outcome',
  'errorMessage',
  'rolledBack',
] as const;
const RECONCILIATION_FIELDS = [
  'stackKey',
  'region',
  'kind',
  'stateUpdated',
] as const;

function pick<T, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as Pick<T, K>;
}

function mapDefined<T>(
  value: T | undefined,
  map: (defined: T) => T,
): T | undefined {
  return value === undefined ? undefined : map(value);
}

function maskOrRedact(
  value: string | undefined,
  forceMask: boolean,
  redact: (text: string) => string,
): string | undefined {
  return mapDefined(value, (text) => (forceMask ? MASK : redact(text)));
}

// ===========================================================================
// 型(usecase が依存する出力契約)
// ===========================================================================

/** 解決した接続先(FR-7-8)。クレデンシャル等の秘匿情報は含めない。 */
export interface ConnectionInfo {
  accountId: string;
  regions: string[];
}

/** リソース単位の差分 1 行分(FR-3-1 / FR-3-2)。 */
export interface ResourceDiffLine {
  /** `Add` / `Modify` / `Remove` / `Import` / `Dynamic`(CloudFormation の Action をそのまま保持)。 */
  action: string;
  logicalResourceId: string;
  resourceType: string;
  /** `Replacement: True` または `Conditional` のとき true(FR-3-2: いずれも警告扱い)。 */
  replacement: boolean;
  /** CloudFormation が返した Replacement の生値。 */
  replacementType?: string;
  physicalResourceId?: string;
  scope: string[];
  changedProperties: string[];
  details: ResourceDiffDetail[];
  /** CloudFormation が返した encoded JSON。独自補完はしない。 */
  beforeContext?: string;
  afterContext?: string;
  /** report 再マスク時にも context 全体の秘匿を維持する内部フラグ。JSON には出力しない。 */
  containsNoEchoChange: boolean;
}

/** CloudFormation `ResourceChange.Details[]` の表示用コピー(FR-3-1)。 */
export type ResourceDiffDetail = ResourceChangeDetail;

/** スタック単位の差分(FR-13-7: リージョン込みのスタックキーを常に含む)。 */
export interface StackDiff {
  stackKey: string;
  region: string;
  stackName: string;
  operation: 'create' | 'update' | 'delete' | 'no-change';
  resources: ResourceDiffLine[];
  /** 置換警告等(FR-3-2)。リソース非依存の警告(将来拡張)もここに集約する。 */
  warnings: string[];
}

/** FR-4-1: 完了待機中に逐次出力するスタックイベント 1 行分。 */
export interface StackEventLine {
  stackKey: string;
  region: string;
  /** ISO8601 文字列。 */
  timestamp: string;
  logicalResourceId: string;
  resourceType: string;
  resourceStatus: string;
  resourceStatusReason?: string;
}

/** FR-5-4: スタック単位の進捗マイルストーンの段階。 */
export type ProgressPhase =
  | 'changeset-create-start'
  | 'diff-ready'
  | 'no-change'
  | 'execute-start'
  | 'delete-start'
  | 'done'
  | 'skipped'
  | 'failed';

/** FR-5-4: スタック単位の進捗マイルストーン。CFN リソースイベント(StackEventLine)とは独立したチャネル。
 *  DeployReport には含めない — onProgress でのみ配送する(JSON 出力契約を変えないため)。 */
export interface ProgressEvent {
  stackKey: string;
  region: string;
  phase: ProgressPhase;
  message: string;
}

/** スタック単位の最終結果(FR-1-3 / FR-4-2 / FR-4-3)。 */
export type StackOutcome = 'succeeded' | 'failed' | 'skipped' | 'no-change';

export interface StackResult {
  stackKey: string;
  region: string;
  stackName: string;
  outcome: StackOutcome;
  /** FR-4-2: 失敗時、原因リソースを含むメッセージ。 */
  errorMessage?: string;
  /** FR-4-3: ロールバックが発生したか。 */
  rolledBack?: boolean;
}

/** FR-5-18a: Phase A で保存した既成事実の再同期(design §5.3 / FR-5-5b)1 件分。 */
export interface ReconciliationRecord {
  stackKey: string;
  region: string;
  /** FR-5-5b の 3 種別。 */
  kind: 'empty-change-set' | 'deleted-absent' | 'create-recovery';
  /** ステートを実際に更新したか(fencing 喪失・CAS 競合で保存に至らなければ false)。 */
  stateUpdated: boolean;
}

/** deploy 一括実行のレポート全体(FR-7-8: connection を先頭に含む)。 */
export interface DeployReport {
  connection: ConnectionInfo;
  diffs: StackDiff[];
  /** FR-4-1(usecase/deploy 側で逐次収集して渡す想定)。 */
  events?: StackEventLine[];
  /** FR-1-3 / FR-4-2 / FR-4-3(usecase/deploy 側で完了後に確定させる想定)。 */
  result?: { stacks: StackResult[] };
  /** FR-5-10 / FR-12-6c1: 承認が拒否された実行にだけ true を付与する。 */
  cancelled?: true;
  /** FR-5-18a / FR-5-18c: 再同期が 1 件以上発生した実行にだけ含める。 */
  reconciliations?: ReconciliationRecord[];
}

/** FR-5-6a〜e: 承認要求の集計(承認要求専用。DeployReport の JSON には現れない)。 */
export interface ApprovalSummary {
  create: number;
  update: number;
  delete: number;
  /** 置換(Replacement)が発生するリソースの総数。 */
  replacements: number;
  /** create / update のうち CloudFormation リソース差分が 0 件のもの(FR-5-7b)。
   *  create / update の件数にも算入済みで、注記の対象数を表す。 */
  resourcelessChanges: number;
}

/** FR-5-2a: 実行全体で 1 回だけ提示する承認要求。 */
export interface ApprovalRequest {
  connection: ConnectionInfo;
  /** Phase A で確定した全差分。redaction 適用済み(NFR-4 / FR-5-6g)。 */
  diffs: StackDiff[];
  summary: ApprovalSummary;
  /** FR-5-6e: `--allow-delete` の指定有無。削除対象を「実際に削除する」と
   *  「警告のみで削除しない」のどちらとして提示するかを決める。 */
  allowDelete: boolean;
}

/** usecase が対象スタックごとに構成した NoEcho redactor の report 側契約。 */
export type ReportTextRedactor = (stackKey: string, text: string) => string;

type ReportMessageMapper = (
  stackKey: string,
  text: string,
  forceMask: boolean,
) => string;

/** DeployReport の公開契約フィールドだけを再構築し、自由記述文字列を変換する。 */
function projectReport(
  report: DeployReport,
  mapMessage: ReportMessageMapper,
): DeployReport {
  return {
    connection: {
      ...pick(report.connection, CONNECTION_FIELDS),
      regions: [...report.connection.regions],
    },
    ...(report.cancelled === true ? { cancelled: true as const } : {}),
    diffs: report.diffs.map((diff) => ({
      ...pick(diff, DIFF_FIELDS),
      resources: diff.resources.map((resource) => ({
        ...pick(resource, RESOURCE_FIELDS),
        scope: [...resource.scope],
        changedProperties: [...resource.changedProperties],
        details: resource.details.map((detail) => ({
          target:
            detail.target === undefined
              ? undefined
              : {
                  ...pick(detail.target, TARGET_FIELDS),
                  beforeValue: mapDefined(detail.target.beforeValue, (text) =>
                    mapMessage(diff.stackKey, text, false),
                  ),
                  afterValue: mapDefined(detail.target.afterValue, (text) =>
                    mapMessage(diff.stackKey, text, false),
                  ),
                },
          ...pick(detail, DETAIL_FIELDS),
        })),
        beforeContext: mapDefined(resource.beforeContext, (text) =>
          mapMessage(diff.stackKey, text, resource.containsNoEchoChange),
        ),
        afterContext: mapDefined(resource.afterContext, (text) =>
          mapMessage(diff.stackKey, text, resource.containsNoEchoChange),
        ),
      })),
      warnings: diff.warnings.map((warning) =>
        mapMessage(diff.stackKey, warning, false),
      ),
    })),
    ...(report.events
      ? {
          events: report.events.map((event) => ({
            ...pick(event, EVENT_FIELDS),
            resourceStatusReason: mapDefined(
              event.resourceStatusReason,
              (text) => mapMessage(event.stackKey, text, false),
            ),
          })),
        }
      : {}),
    ...(report.result
      ? {
          result: {
            stacks: report.result.stacks.map((stack) => ({
              ...pick(stack, RESULT_FIELDS),
              errorMessage: mapDefined(stack.errorMessage, (text) =>
                mapMessage(stack.stackKey, text, false),
              ),
            })),
          },
        }
      : {}),
    ...(report.reconciliations && report.reconciliations.length > 0
      ? {
          reconciliations: report.reconciliations.map((record) =>
            pick(record, RECONCILIATION_FIELDS),
          ),
        }
      : {}),
  };
}

/**
 * AWS 由来の自由記述文字列を出力直前にも再度マスクする多層防御(NFR-4)。
 * redactor 自体は usecase が実効パラメータから構成し、秘匿値を report に保持しない。
 */
export function redactReportMessages(
  report: DeployReport,
  redact: ReportTextRedactor,
): DeployReport {
  return projectReport(report, (stackKey, text, forceMask) =>
    forceMask ? MASK : redact(stackKey, text),
  );
}

// ===========================================================================
// buildStackDiff(FR-3-1 / FR-3-2 / FR-13-7 / NFR-4)
// ===========================================================================

/** `ResourceChange.details[]` から変更されたプロパティ名(またはアトリビュート名)を重複なく抽出する。 */
function extractChangedProperties(change: ResourceChange): string[] {
  const seen = new Set<string>();
  const props: string[] = [];
  for (const detail of change.details) {
    const label = detail.target?.name ?? detail.target?.attribute;
    if (label !== undefined && !seen.has(label)) {
      seen.add(label);
      props.push(label);
    }
  }
  return props;
}

function buildResourceDiffLine(
  change: ResourceChange,
  noEchoSet: ReadonlySet<string>,
  redact: (text: string) => string,
): ResourceDiffLine {
  const containsNoEchoChange = change.details.some(
    (detail) =>
      detail.causingEntity !== undefined && noEchoSet.has(detail.causingEntity),
  );
  return {
    action: change.action,
    logicalResourceId: change.logicalResourceId,
    resourceType: change.resourceType,
    // FR-3-2: True(通常の置換)・Conditional(条件次第で置換されうる)のいずれも警告対象とする。
    replacement:
      change.replacement === 'True' || change.replacement === 'Conditional',
    replacementType: change.replacement,
    physicalResourceId: change.physicalResourceId,
    scope: [...change.scope],
    changedProperties: extractChangedProperties(change),
    details: change.details.map((detail) => {
      const noEcho =
        detail.causingEntity !== undefined &&
        noEchoSet.has(detail.causingEntity);
      return {
        ...detail,
        target: detail.target
          ? {
              ...detail.target,
              beforeValue: maskOrRedact(
                detail.target.beforeValue,
                noEcho,
                redact,
              ),
              afterValue: maskOrRedact(
                detail.target.afterValue,
                noEcho,
                redact,
              ),
            }
          : undefined,
      };
    }),
    beforeContext: maskOrRedact(
      change.beforeContext,
      containsNoEchoChange,
      redact,
    ),
    afterContext: maskOrRedact(
      change.afterContext,
      containsNoEchoChange,
      redact,
    ),
    containsNoEchoChange,
  };
}

/**
 * `DescribeChangeSet` 結果(`ChangeSetDetail`)から人間可読・機械可読双方の元になる
 * `StackDiff` を組み立てる(FR-3-1)。`detail` 省略時(削除等、変更セットを介さない
 * 操作)は空の差分になる。
 *
 * NFR-4: `detail.parameters`(実効パラメータの値)は意図的に一切読み取らない。
 * CloudFormation が返す前後値は `redact` を通し、`causingEntity` が NoEcho
 * パラメータなら値そのものとの一致にかかわらず `****` とする。
 */
export function buildStackDiff(input: {
  stackKey: string;
  region: string;
  stackName: string;
  operation: 'create' | 'update' | 'delete' | 'no-change';
  detail?: ChangeSetDetail;
  noEchoParams: string[];
  redact?: (text: string) => string;
}): StackDiff {
  const noEchoSet = new Set(input.noEchoParams);
  const changes = input.detail?.changes ?? [];
  const redact = input.redact ?? ((text: string) => text);
  const resources = changes.map((change) =>
    buildResourceDiffLine(change, noEchoSet, redact),
  );
  const warnings: string[] = [];

  changes.forEach((change, index) => {
    const line = resources[index];
    if (line.replacement) {
      warnings.push(
        `${line.logicalResourceId} (${line.resourceType}) will be replaced`,
      );
    }
    for (const detail of change.details) {
      if (
        detail.causingEntity !== undefined &&
        noEchoSet.has(detail.causingEntity)
      ) {
        const property =
          detail.target?.name ??
          detail.target?.attribute ??
          '(unknown property)';
        warnings.push(
          `${line.logicalResourceId}'s ${property} is a change originating from the NoEcho parameter "${detail.causingEntity}" (value not shown)`,
        );
      }
    }
  });

  return {
    stackKey: input.stackKey,
    region: input.region,
    stackName: input.stackName,
    operation: input.operation,
    resources,
    warnings,
  };
}

// ===========================================================================
// renderText / renderJson(FR-3-2 / FR-3-3 / FR-7-8)
// ===========================================================================

const ACTION_SYMBOLS: Record<string, string> = {
  Add: '+',
  Modify: '~',
  Remove: '-',
  Import: 'i',
  Dynamic: '?',
};

const ACTION_COLOR_CODES: Record<string, string> = {
  Add: '32',
  Modify: '33',
  Remove: '31',
};

function actionSymbol(action: string): string {
  return ACTION_SYMBOLS[action] ?? '?';
}

function colorize(text: string, code: string, color: boolean): string {
  return color ? `\x1b[${code}m${text}\x1b[0m` : text;
}

/**
 * FR-5-7b / FR-5-7c: 「変更セットの作成に成功したが CloudFormation リソース差分が
 * 0 件」の対象か。判別条件は `(create | update) かつ resources 0 件` に固定する
 * (`operation !== 'no-change'` では削除プレビューまで巻き込む)。
 * FR-5-7d: この判別はレンダラ限定であり、`DeployReport` のデータは変更しない。
 */
function isResourcelessChange(diff: StackDiff): boolean {
  return (
    (diff.operation === 'create' || diff.operation === 'update') &&
    diff.resources.length === 0
  );
}

const RESOURCELESS_CHANGE_NOTE =
  '  (0 CloudFormation resource diffs -- may include non-resource changes such as Outputs. Included in execution)';

/**
 * FR-5-7e: 削除プレビューの対象か。削除は変更セットを介さず `DeleteStack` を直接
 * 呼ぶため `resources` は常に空であり、しかも FR-5-7c により 0 件注記の対象から
 * 外れる。0 件を理由に `(変更なし)` へ落とすと、これから消えるスタックに
 * 「変更なし」と出て承認判断を誤らせる。判別条件は `delete かつ resources 0 件`
 * に固定し、`no-change`(`(変更なし)` が正しい表示)には及ばない。
 * FR-5-7d と同一の制約に従い、この判別もレンダラ限定であって
 * `DeployReport` のデータ(`warnings` / `operation`)は変更しない。
 */
function isDeletePreview(diff: StackDiff): boolean {
  return diff.operation === 'delete' && diff.resources.length === 0;
}

/**
 * FR-5-7e: 削除対象の専用表示。`renderText` は `--allow-delete` を知らない
 * (当該情報は `DeployReport` になく `ApprovalRequest.allowDelete` だけが持つ)
 * ため、文言は「削除対象である」ことに留め、実行の可否を断定しない。実際に削除
 * するのか警告に留まるのかは、承認要約では FR-5-6e の見出し注記が、text 差分では
 * `StackDiff.warnings` が担う。
 */
const DELETE_PREVIEW_NOTE =
  '  (the entire stack is targeted for deletion -- deletion bypasses change sets, so there is no per-resource diff)';

/** 1 スタック分のリソース差分行(renderText / renderApprovalSummary で共有する)。 */
function resourceDiffLines(diff: StackDiff, color: boolean): string[] {
  const lines: string[] = [];
  if (diff.resources.length === 0) {
    // 3 者(0 件注記 / 削除対象 / 真の変更なし)は同一の出力に混在しうるため、
    // それぞれ区別できる文言を出す(FR-5-7b / FR-5-7e)。
    if (isResourcelessChange(diff)) lines.push(RESOURCELESS_CHANGE_NOTE);
    else if (isDeletePreview(diff)) lines.push(DELETE_PREVIEW_NOTE);
    else lines.push('  (no changes)');
  }
  for (const resource of diff.resources) {
    const flag = resource.replacement
      ? colorize(' [REPLACEMENT]', '1;31', color)
      : '';
    const props =
      resource.changedProperties.length > 0
        ? resource.changedProperties.join(', ')
        : '-';
    const label = `${actionSymbol(resource.action)} ${resource.action.padEnd(7)} ${resource.logicalResourceId} (${resource.resourceType})`;
    const actionColor = ACTION_COLOR_CODES[resource.action];
    const coloredLabel =
      actionColor === undefined ? label : colorize(label, actionColor, color);
    lines.push(`  ${coloredLabel}${flag} properties: ${props}`);
    for (const detail of resource.details) {
      const target = detail.target;
      if (!target) continue;
      const path =
        target.path ||
        [target.attribute, target.name].filter(Boolean).join('.') ||
        '(unknown)';
      const metadata = [
        target.attributeChangeType,
        detail.evaluation,
        detail.changeSource,
        target.requiresRecreation
          ? `recreation: ${target.requiresRecreation}`
          : undefined,
      ].filter((value): value is string => value !== undefined);
      lines.push(
        `    ${path}${metadata.length > 0 ? ` [${metadata.join(', ')}]` : ''}`,
      );
      if (target.beforeValue !== undefined) {
        const source = target.beforeValueFrom
          ? ` (${target.beforeValueFrom})`
          : '';
        lines.push(
          `      before${source}: ${JSON.stringify(target.beforeValue)}`,
        );
      }
      if (target.afterValue !== undefined) {
        const source = target.afterValueFrom
          ? ` (${target.afterValueFrom})`
          : '';
        lines.push(
          `      after${source}:  ${JSON.stringify(target.afterValue)}`,
        );
      }
    }
  }
  if (diff.warnings.length > 0) {
    lines.push('  Warnings:');
    for (const warning of diff.warnings) {
      lines.push(`    - ${colorize(warning, '33', color)}`);
    }
  }
  return lines;
}

const RECONCILIATION_LABELS: Record<ReconciliationRecord['kind'], string> = {
  'empty-change-set': 'Empty change set (no-change confirmation)',
  'deleted-absent': 'Confirmed absence of deleted stack',
  'create-recovery': 'CREATE recovery',
};

/**
 * `DeployReport` を人間可読なテキストへ整形する(FR-3-3)。先頭に接続先(FR-7-8)、
 * 各スタックの差分(置換は警告強調。FR-3-2)、任意でイベント・結果セクションを
 * 続ける。ANSI 色の有効・無効は CLI 境界で決定し、`opts.color` で明示する。
 */
export function renderText(
  report: DeployReport,
  opts: { color?: boolean } = {},
): string {
  const color = opts.color === true;
  const lines: string[] = [];

  // FR-7-8: 接続先を出力の先頭に含める。クレデンシャルは connection に存在しないため漏れない。
  lines.push('== Connection ==');
  lines.push(`account: ${report.connection.accountId}`);
  lines.push(`regions: ${report.connection.regions.join(', ')}`);
  lines.push('');

  for (const diff of report.diffs) {
    // FR-13-7: スタックキー(リージョン込み)を明示する。
    lines.push(
      `[${diff.operation}] ${diff.stackKey} (stack: ${diff.stackName})`,
    );
    lines.push(...resourceDiffLines(diff, color));
    lines.push('');
  }

  // FR-5-18b: 再同期が 1 件以上ある実行にだけ専用セクションを追加する。
  if (report.reconciliations && report.reconciliations.length > 0) {
    lines.push('== Reconciliation (state) ==');
    for (const record of report.reconciliations) {
      lines.push(
        `  ${record.stackKey} (${record.region}): ${RECONCILIATION_LABELS[record.kind]} / state updated: ${
          record.stateUpdated ? 'yes' : 'no'
        }`,
      );
    }
    lines.push('');
  }

  if (report.events && report.events.length > 0) {
    lines.push('== Events ==');
    for (const event of report.events) {
      const reason = event.resourceStatusReason
        ? ` (${event.resourceStatusReason})`
        : '';
      lines.push(
        `  [${event.stackKey}] ${event.timestamp} ${event.logicalResourceId} ${event.resourceStatus}${reason}`,
      );
    }
    lines.push('');
  }

  if (report.result) {
    lines.push('== Result ==');
    for (const stackResult of report.result.stacks) {
      const flag =
        stackResult.outcome === 'failed'
          ? colorize(' [FAILED]', '31', color)
          : '';
      const errorPart = stackResult.errorMessage
        ? ` - ${stackResult.errorMessage}`
        : '';
      const rollbackPart = stackResult.rolledBack ? ' (rolled back)' : '';
      lines.push(
        `  ${stackResult.stackKey}: ${stackResult.outcome}${flag}${errorPart}${rollbackPart}`,
      );
    }
  }

  return lines.join('\n').replace(/\n+$/, '\n');
}

/**
 * `DeployReport` を機械可読な JSON へ整形する(FR-3-3)。契約に定義されたフィールドの
 * みを明示的に再構築するため、`report` に余剰フィールド(誤って紛れ込んだ秘匿情報等)
 * が付与されていても出力には一切現れない(NFR-4 / FR-7-8 の多層防御)。
 */
export function renderJson(report: DeployReport): string {
  const payload = projectReport(report, (_stackKey, text, forceMask) =>
    forceMask ? MASK : text,
  );
  return JSON.stringify(
    payload,
    (key, value) => (key === 'containsNoEchoChange' ? undefined : value),
    2,
  );
}

// ===========================================================================
// 承認要約(FR-5-6a〜g / FR-3-7a / design §5.3.2)
// ===========================================================================

/** FR-5-6b / FR-5-6d / FR-5-7b: 承認要求の集計を差分から求める。 */
export function buildApprovalSummary(diffs: StackDiff[]): ApprovalSummary {
  const summary: ApprovalSummary = {
    create: 0,
    update: 0,
    delete: 0,
    replacements: 0,
    resourcelessChanges: 0,
  };
  for (const diff of diffs) {
    if (diff.operation === 'create') summary.create += 1;
    else if (diff.operation === 'update') summary.update += 1;
    else if (diff.operation === 'delete') summary.delete += 1;
    summary.replacements += diff.resources.filter(
      (resource) => resource.replacement,
    ).length;
    // リソース差分 0 件の対象も create / update に算入済み。注記対象数だけを別に持つ。
    if (isResourcelessChange(diff)) summary.resourcelessChanges += 1;
  }
  return summary;
}

/**
 * FR-5-6a〜g / FR-3-7a: 承認要約を人間可読テキストへ整形する(標準エラーへ出す想定)。
 * 色付け・無色化の規則は差分本体(`renderText`)と同一で、判断材料の並びは
 * 接続先 → 対象ごとの操作種別とリソース差分 → 合計とする。
 */
export function renderApprovalSummary(
  request: ApprovalRequest,
  options: { color: boolean },
): string {
  const color = options.color;
  const lines: string[] = [];

  lines.push('== Confirm what will run ==');
  // FR-5-6a: 解決済みの接続先(アカウント ID・許可済みリージョン)。
  lines.push(`account: ${request.connection.accountId}`);
  lines.push(`regions: ${request.connection.regions.join(', ')}`);
  lines.push('');

  for (const diff of request.diffs) {
    if (diff.operation === 'no-change') continue;
    // FR-5-6e: 削除は --allow-delete の有無で提示を切り替える。
    const deleteNote =
      diff.operation === 'delete'
        ? request.allowDelete
          ? colorize(' -- will be deleted', '31', color)
          : ' -- targeted for deletion, but not deleted because --allow-delete is not set (warning only)'
        : '';
    lines.push(
      `[${diff.operation}] ${diff.stackKey} (stack: ${diff.stackName})${deleteNote}`,
    );
    lines.push(...resourceDiffLines(diff, color));
    lines.push('');
  }

  const { summary } = request;
  const deleteSuffix = request.allowDelete
    ? '(--allow-delete set: will actually delete)'
    : '(--allow-delete not set: will not delete)';
  lines.push(
    `Total: create ${summary.create} / update ${summary.update} / delete ${summary.delete} ${deleteSuffix}`,
  );
  if (summary.replacements > 0) {
    // FR-5-6d: 置換は要約でも警告として強調する。
    lines.push(
      colorize(
        `Warning: ${summary.replacements} resource replacement(s)`,
        '1;31',
        color,
      ),
    );
  }
  if (summary.resourcelessChanges > 0) {
    lines.push(
      `Note: ${summary.resourcelessChanges} create/update target(s) have 0 CloudFormation resource diffs (may include non-resource changes such as Outputs)`,
    );
  }

  return `${lines.join('\n')}\n`;
}

// ===========================================================================
// renderGraphText / renderGraphJson(FR-8-3)
// ===========================================================================

/**
 * リージョンごとの依存グラフをトポロジカル順序に基づく階層(レベル)としてテキスト
 * 出力する(FR-8-3 / FR-8-6)。同一レベル内のスタックは並列デプロイ可能であることを
 * 表し、diamond 依存でも依存関係の記述を重複させない。循環検出とレベル計算は
 * usecase 境界で完了しており、この関数は受け取ったレベルを整形するだけである。
 */
export function renderGraphText(
  graphs: Map<string, RegionGraph>,
  levels: Map<string, string[][]>,
): string {
  const lines: string[] = [];
  for (const [region] of graphs) {
    lines.push(`region: ${region}`);
    const regionLevels = levels.get(region) ?? [];
    regionLevels.forEach((nodes, index) => {
      lines.push(`  Lv${index}:`);
      for (const node of nodes) {
        lines.push(`    ${node}`);
      }
    });
    lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

/** リージョンごとの依存グラフを機械可読 JSON として出力する(FR-8-3)。 */
export function renderGraphJson(graphs: Map<string, RegionGraph>): string {
  const regions = [...graphs.values()].map((graph) => ({
    region: graph.region,
    nodes: [...graph.nodes],
    edges: graph.edges.map((edge) => ({ from: edge.from, to: edge.to })),
  }));
  return JSON.stringify({ regions }, null, 2);
}
