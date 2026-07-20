/**
 * T-11 report — 差分表示・出力(design.md §8.1 / §8.2, requirements.md FR-3 /
 * FR-7-8 / FR-8-3 / FR-13-7 / NFR-4)。
 *
 * usecase(M3, 未実装)が依存する出力契約(構造化された差分・イベント・接続先情報の
 * 型)をここで確定する(依存方向 `cli → usecase → core / ports / report` の遵守。
 * report は core の型を読み取り専用で参照してよいが、逆方向の依存は発生しない)。
 *
 * NoEcho マスク(NFR-4)は差分・ログ・JSON のすべてが対象。`StackDiff` はそもそも
 * パラメータ実値を保持できる構造になっていない(`ChangeSetDetail.parameters` を
 * 取り込まない)ため、構造的に実値が紛れ込まない。`renderText` / `renderJson` は
 * さらに、渡された `DeployReport` から契約に定義されたフィールドのみを明示的に
 * 再構築して出力する(呼び出し側が誤って秘匿情報を余剰フィールドとして紛れ込ませても
 * 出力には現れない、多層防御)。
 */

import type { RegionGraph } from '../core/graph.js';
import type { StackKey } from '../core/types.js';
import type { ChangeSetDetail, ResourceChange } from '../ports/index.js';

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
  changedProperties: string[];
}

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

/** deploy 一括実行のレポート全体(FR-7-8: connection を先頭に含む)。 */
export interface DeployReport {
  connection: ConnectionInfo;
  diffs: StackDiff[];
  /** FR-4-1(usecase/deploy 側で逐次収集して渡す想定)。 */
  events?: StackEventLine[];
  /** FR-1-3 / FR-4-2 / FR-4-3(usecase/deploy 側で完了後に確定させる想定)。 */
  result?: { stacks: StackResult[] };
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

function buildResourceDiffLine(change: ResourceChange): ResourceDiffLine {
  return {
    action: change.action,
    logicalResourceId: change.logicalResourceId,
    resourceType: change.resourceType,
    // FR-3-2: True(通常の置換)・Conditional(条件次第で置換されうる)のいずれも警告対象とする。
    replacement:
      change.replacement === 'True' || change.replacement === 'Conditional',
    changedProperties: extractChangedProperties(change),
  };
}

/**
 * `DescribeChangeSet` 結果(`ChangeSetDetail`)から人間可読・機械可読双方の元になる
 * `StackDiff` を組み立てる(FR-3-1)。`detail` 省略時(削除等、変更セットを介さない
 * 操作)は空の差分になる。
 *
 * NFR-4: `detail.parameters`(実効パラメータの値)は意図的に一切読み取らない —
 * `StackDiff` にパラメータ実値を持ち込まない設計そのものが NoEcho マスクの構造的
 * 保証になる。`noEchoParams` は、変更理由(`causingEntity`)が NoEcho パラメータで
 * あることを警告として明示するためだけに用いる(値そのものは常にどの入力にも
 * 現れない)。
 */
export function buildStackDiff(input: {
  stackKey: string;
  region: string;
  stackName: string;
  operation: 'create' | 'update' | 'delete' | 'no-change';
  detail?: ChangeSetDetail;
  noEchoParams: string[];
}): StackDiff {
  const noEchoSet = new Set(input.noEchoParams);
  const changes = input.detail?.changes ?? [];
  const resources = changes.map(buildResourceDiffLine);
  const warnings: string[] = [];

  changes.forEach((change, index) => {
    const line = resources[index];
    if (line.replacement) {
      warnings.push(
        `${line.logicalResourceId} (${line.resourceType}) は置換されます`,
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
          '(不明なプロパティ)';
        warnings.push(
          `${line.logicalResourceId} の ${property} は NoEcho パラメータ「${detail.causingEntity}」に由来する変更です(値は表示されません)`,
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
// maskNoEcho(NFR-4)
// ===========================================================================

/** `noEchoParams` に含まれるキーの値を `****` に置換する(NFR-4)。それ以外は変更しない。 */
export function maskNoEcho(
  parameters: Record<string, string>,
  noEchoParams: string[],
): Record<string, string> {
  const noEchoSet = new Set(noEchoParams);
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(parameters)) {
    masked[key] = noEchoSet.has(key) ? '****' : value;
  }
  return masked;
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

function actionSymbol(action: string): string {
  return ACTION_SYMBOLS[action] ?? '?';
}

function colorize(text: string, code: string, color: boolean): string {
  return color ? `[${code}m${text}[0m` : text;
}

/**
 * `DeployReport` を人間可読なテキストへ整形する(FR-3-3)。先頭に接続先(FR-7-8)、
 * 各スタックの差分(置換は警告強調。FR-3-2)、任意でイベント・結果セクションを
 * 続ける。`opts.color` 未指定時は ANSI エスケープを含めない(CI ログ想定)。
 */
export function renderText(
  report: DeployReport,
  opts: { color?: boolean } = {},
): string {
  const color = opts.color === true;
  const lines: string[] = [];

  // FR-7-8: 接続先を出力の先頭に含める。クレデンシャルは connection に存在しないため漏れない。
  lines.push('== 接続先 ==');
  lines.push(`account: ${report.connection.accountId}`);
  lines.push(`regions: ${report.connection.regions.join(', ')}`);
  lines.push('');

  for (const diff of report.diffs) {
    // FR-13-7: スタックキー(リージョン込み)を明示する。
    lines.push(
      `[${diff.operation}] ${diff.stackKey} (stack: ${diff.stackName})`,
    );
    if (diff.resources.length === 0) {
      lines.push('  (変更なし)');
    }
    for (const resource of diff.resources) {
      const flag = resource.replacement
        ? colorize(' [REPLACEMENT]', '33', color)
        : '';
      const props =
        resource.changedProperties.length > 0
          ? resource.changedProperties.join(', ')
          : '-';
      const label = `${actionSymbol(resource.action)} ${resource.action.padEnd(7)} ${resource.logicalResourceId} (${resource.resourceType})`;
      lines.push(`  ${label}${flag} properties: ${props}`);
    }
    if (diff.warnings.length > 0) {
      lines.push('  警告:');
      for (const warning of diff.warnings) {
        lines.push(`    - ${colorize(warning, '33', color)}`);
      }
    }
    lines.push('');
  }

  if (report.events && report.events.length > 0) {
    lines.push('== イベント ==');
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
    lines.push('== 結果 ==');
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
  const payload = {
    connection: {
      accountId: report.connection.accountId,
      regions: [...report.connection.regions],
    },
    diffs: report.diffs.map((diff) => ({
      stackKey: diff.stackKey,
      region: diff.region,
      stackName: diff.stackName,
      operation: diff.operation,
      resources: diff.resources.map((resource) => ({
        action: resource.action,
        logicalResourceId: resource.logicalResourceId,
        resourceType: resource.resourceType,
        replacement: resource.replacement,
        changedProperties: [...resource.changedProperties],
      })),
      warnings: [...diff.warnings],
    })),
    ...(report.events
      ? {
          events: report.events.map((event) => ({
            stackKey: event.stackKey,
            region: event.region,
            timestamp: event.timestamp,
            logicalResourceId: event.logicalResourceId,
            resourceType: event.resourceType,
            resourceStatus: event.resourceStatus,
            resourceStatusReason: event.resourceStatusReason,
          })),
        }
      : {}),
    ...(report.result
      ? {
          result: {
            stacks: report.result.stacks.map((stackResult) => ({
              stackKey: stackResult.stackKey,
              region: stackResult.region,
              stackName: stackResult.stackName,
              outcome: stackResult.outcome,
              errorMessage: stackResult.errorMessage,
              rolledBack: stackResult.rolledBack,
            })),
          },
        }
      : {}),
  };
  return JSON.stringify(payload, null, 2);
}

// ===========================================================================
// renderGraphText / renderGraphJson(FR-8-3)
// ===========================================================================

/** `edge.to` → 依存先(`edge.from`)一覧の索引を作る。 */
function buildDependencyIndex(graph: RegionGraph): Map<StackKey, StackKey[]> {
  const index = new Map<StackKey, StackKey[]>();
  for (const edge of graph.edges) {
    const list = index.get(edge.to);
    if (list) {
      list.push(edge.from);
    } else {
      index.set(edge.to, [edge.from]);
    }
  }
  return index;
}

/**
 * リージョンごとの依存グラフをテキストツリーとして出力する(FR-8-3)。各ノードの
 * 直下に「依存先」(そのノードが依存するスタック)を列挙する。
 */
export function renderGraphText(graphs: Map<string, RegionGraph>): string {
  const lines: string[] = [];
  for (const [region, graph] of graphs) {
    lines.push(`region: ${region}`);
    const dependencyIndex = buildDependencyIndex(graph);
    for (const node of graph.nodes) {
      lines.push(`  ${node}`);
      for (const dependency of dependencyIndex.get(node) ?? []) {
        lines.push(`    depends on: ${dependency}`);
      }
    }
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
