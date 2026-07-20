/**
 * T-05 core/detect — 変更分類(design.md §4.4)。
 *
 * ステート(前回成功時点の記録)と現在の設定 + テンプレート内容を比較し、
 * 各スタックキーを `added` / `modified` / `deleted` / `unchanged` に分類する。
 * fs / AWS SDK には依存しない純粋ロジック(CLAUDE.md の `src/core/` 制約)。
 * テンプレート内容の読み込みは呼び出し側(usecase)が担い、ここには
 * `templatePath → content` の Map として渡す。
 */

import type { ResolvedStackTarget } from './config.js';
import { type CfnSyncState, type StackEntry, sha256Hex } from './state.js';
import type { ChangeType, StackKey } from './types.js';

// ---------------------------------------------------------------------------
// 公開型(下流タスクの契約)
// ---------------------------------------------------------------------------

/** FR-1-14: スタック名変更で `added` になったエントリが持つ、旧スタック名の記録。 */
export interface RenamedFrom {
  oldStackName: string;
}

export interface DetectedEntry {
  stackKey: StackKey;
  changeType: ChangeType;
  /** 設定側の情報。`deleted`(削除・リージョン除外・リネームの旧名側)では undefined。 */
  target?: ResolvedStackTarget;
  /** ステート側の記録。`added`(新規・リネームの新名側)では undefined。 */
  stateEntry?: StackEntry;
  /** target がある場合の現時点でのテンプレートハッシュ。 */
  templateHash?: string;
  /** target がある場合の現時点での複合入力ハッシュ(§4.3)。 */
  inputsHash?: string;
  /** FR-1-14: リネームによる `added` の場合のみ、旧スタック名を保持する。 */
  renamedFrom?: RenamedFrom;
}

export interface DetectionResult {
  entries: DetectedEntry[];
}

export interface DetectChangesInput {
  targets: ResolvedStackTarget[];
  /** templatePath → テンプレートファイルの内容。targets に登場するすべての templatePath を含むこと。 */
  templates: Map<string, string>;
  /** 呼び出し側でテンプレートパス単位に計算済みの hash。inputsHash の構成は変更しない。 */
  templateHashes?: Map<string, string>;
  state: CfnSyncState;
}

// ---------------------------------------------------------------------------
// ハッシュ計算(design.md §4.3)
// ---------------------------------------------------------------------------

/** テンプレートファイル内容のハッシュ(§4.3 の `templateHash`)。 */
export function computeTemplateHash(templateContent: string): string {
  return sha256Hex(templateContent);
}

export interface ComputeInputsHashInput {
  templateContent: string;
  stackName: string;
  parameters: Record<string, string>;
  tags: Record<string, string>;
  capabilities: string[];
  dependsOn: string[];
}

/** キー順に依存しない決定的な `[key, value][]` 表現(パラメータ・タグ用)。 */
function sortedEntries(record: Record<string, string>): [string, string][] {
  return Object.keys(record)
    .sort()
    .map((key): [string, string] => [key, record[key]]);
}

/**
 * §4.3: テンプレート内容 + スタック名 + 実効パラメータ + タグ + Capabilities +
 * 明示依存(dependsOn)の複合ハッシュ。パラメータ・タグはキーでソートしてから
 * 連結するため、オブジェクトのキー順には依存しない決定的な結果になる。
 * JSON.stringify を挟むことでフィールド境界の曖昧さ(値に区切り文字が
 * 含まれる場合の衝突)を避ける。
 */
export function computeInputsHash(input: ComputeInputsHashInput): string {
  const canonical = JSON.stringify({
    templateContent: input.templateContent,
    stackName: input.stackName,
    parameters: sortedEntries(input.parameters),
    tags: sortedEntries(input.tags),
    capabilities: input.capabilities,
    dependsOn: input.dependsOn,
  });
  return sha256Hex(canonical);
}

// ---------------------------------------------------------------------------
// 変更分類本体(design.md §4.4)
// ---------------------------------------------------------------------------

function getTemplateContent(
  templates: Map<string, string>,
  templatePath: string,
): string {
  const content = templates.get(templatePath);
  if (content === undefined) {
    throw new Error(`テンプレート内容が見つかりません: ${templatePath}`);
  }
  return content;
}

/**
 * §4.4 の変更分類表を実装する:
 * - 設定にありステートになし → `added`
 * - 双方にあり inputsHash 不一致 → `modified`
 * - 双方にあり inputsHash 一致 → `unchanged`
 * - ステートにあり設定になし → `deleted`
 *
 * FR-1-14: 同一スタックキーで設定導出スタック名とステート記録の stackName が
 * 不一致の場合、上記の modified/unchanged 判定より優先して「旧名の deleted」+
 * 「新名の added」の対を計画する。
 *
 * entries の順序は決定的: targets の順(= 設定記載順)を基本とし、targets に
 * 対応が一切ない純粋な `deleted`(ファイル削除・リージョン除外)はステートの
 * キー順(文字列昇順)で末尾に付加する。リネームで生じる `deleted` はその対象
 * target の処理順に含まれるため、末尾には回さない。
 */
export function detectChanges(input: DetectChangesInput): DetectionResult {
  const { targets, templates, state } = input;
  const entries: DetectedEntry[] = [];
  const targetStackKeys = new Set(targets.map((target) => target.stackKey));

  for (const target of targets) {
    const content = getTemplateContent(templates, target.templatePath);
    const templateHash =
      input.templateHashes?.get(target.templatePath) ??
      computeTemplateHash(content);
    const inputsHash = computeInputsHash({
      templateContent: content,
      stackName: target.stackName,
      parameters: target.parameters,
      tags: target.tags,
      capabilities: target.capabilities,
      dependsOn: target.dependsOn,
    });
    const stateEntry = state.stacks[target.stackKey];

    if (stateEntry === undefined) {
      // 設定にありステートになし(新テンプレート or 新リージョン)。
      entries.push({
        stackKey: target.stackKey,
        changeType: 'added',
        target,
        templateHash,
        inputsHash,
      });
      continue;
    }

    if (stateEntry.stackName !== target.stackName) {
      // FR-1-14: スタック名変更 = 旧名の削除 + 新名の新規作成(対で計画する)。
      entries.push({
        stackKey: target.stackKey,
        changeType: 'deleted',
        stateEntry,
      });
      entries.push({
        stackKey: target.stackKey,
        changeType: 'added',
        target,
        templateHash,
        inputsHash,
        renamedFrom: { oldStackName: stateEntry.stackName },
      });
      continue;
    }

    if (stateEntry.inputsHash !== inputsHash) {
      entries.push({
        stackKey: target.stackKey,
        changeType: 'modified',
        target,
        stateEntry,
        templateHash,
        inputsHash,
      });
    } else {
      entries.push({
        stackKey: target.stackKey,
        changeType: 'unchanged',
        target,
        stateEntry,
        templateHash,
        inputsHash,
      });
    }
  }

  // ステートにあり設定にない(ファイル削除 or リージョン除外)純粋な deleted。
  const deletedKeys = Object.keys(state.stacks)
    .filter((key) => !targetStackKeys.has(key))
    .sort();
  for (const key of deletedKeys) {
    entries.push({
      stackKey: key,
      changeType: 'deleted',
      stateEntry: state.stacks[key],
    });
  }

  return { entries };
}
