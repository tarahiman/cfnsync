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
import { InvariantError } from './errors.js';
import {
  type CfnSyncState,
  type PendingDeletionEntry,
  pendingDeletionStackKey,
  type StackEntry,
  sha256Hex,
} from './state.js';
import type { ChangeType, StackKey } from './types.js';

// ---------------------------------------------------------------------------
// 公開型(下流タスクの契約)
// ---------------------------------------------------------------------------

/** FR-1-14: スタック名変更で `added` になったエントリが持つ、旧スタック名の記録。 */
export interface RenamedFrom {
  oldStackName: string;
  /** FR-1-18: 新エントリ保存と同一の CAS で削除待ちを記録するための旧ステートエントリ。 */
  oldEntry: StackEntry;
}

/** FR-1-21: 削除待ち(pending deletion)由来の `deleted` 対象が持つ記録。 */
export interface DetectedPendingDeletion {
  /** ステートの `pendingDeletions` のキー(`<スタック名>@<リージョン>`)。 */
  id: string;
  entry: PendingDeletionEntry;
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
  /** FR-1-14: リネームによる `deleted`(旧名側)の場合のみ、新スタック名を保持する。
   * 同一スタックキーの create と対をなす複合操作であることを示す。 */
  renamedTo?: { newStackName: string };
  /** FR-1-21: 削除待ち由来の `deleted` の場合のみ設定する(`stateEntry` は持たない)。 */
  pendingDeletion?: DetectedPendingDeletion;
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
  templateHash: string;
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
 * §4.3: テンプレートハッシュ + スタック名 + 実効パラメータ + タグ + Capabilities +
 * 明示依存(dependsOn)の複合ハッシュ。パラメータ・タグはキーでソートしてから
 * 連結するため、オブジェクトのキー順には依存しない決定的な結果になる。
 * JSON.stringify を挟むことでフィールド境界の曖昧さ(値に区切り文字が
 * 含まれる場合の衝突)を避ける。
 */
export function computeInputsHash(input: ComputeInputsHashInput): string {
  const canonical = JSON.stringify({
    templateHash: input.templateHash,
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
    throw new InvariantError(`Template content not found: ${templatePath}`, {
      stackKey: templatePath,
    });
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
 * FR-1-21: ステートの削除待ち(`pendingDeletions`)も 1 件につき 1 つの `deleted`
 * として生成する。スタックキーは予約プレフィックス付きの
 * `cfnsync:pending/<スタック名>@<リージョン>` であり、設定・ステートのスタックキーと
 * 衝突しない(FR-11-11 が `cfnsync:` で始まるテンプレートパスを拒否する)。
 *
 * entries の順序は決定的: targets の順(= 設定記載順)を基本とし、targets に
 * 対応が一切ない純粋な `deleted`(ファイル削除・リージョン除外)はステートの
 * キー順(文字列昇順)で付加する。リネームで生じる `deleted` はその対象
 * target の処理順に含まれるため、後方には回さない。削除待ちはさらにその後へ
 * ID の昇順で並べる。
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
      templateHash,
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
        renamedTo: { newStackName: target.stackName },
      });
      entries.push({
        stackKey: target.stackKey,
        changeType: 'added',
        target,
        templateHash,
        inputsHash,
        renamedFrom: {
          oldStackName: stateEntry.stackName,
          oldEntry: stateEntry,
        },
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

  // FR-1-21: 削除待ちは 1 件につき `deleted` を 1 件生成する。設定・ステートの
  // スタックキーとは衝突しない予約キーを与え、既存の削除経路(FR-6)へそのまま載せる。
  for (const id of Object.keys(state.pendingDeletions).sort()) {
    entries.push({
      stackKey: pendingDeletionStackKey(id),
      changeType: 'deleted',
      pendingDeletion: { id, entry: state.pendingDeletions[id] },
    });
  }

  return { entries };
}
