/**
 * T-07 core/plan — 実行計画(design.md §5.3, FR-9 / FR-5 / FR-13-6)。
 *
 * core/detect の変更分類(`DetectionResult`)と core/graph の依存グラフから、
 * 「どのスタックキーに対してどの操作(create/update/delete)を、どの順序で
 * 実行するか」を表す `ExecutionPlan` を組み立てる純粋ロジック。fs / AWS SDK
 * には依存しない(CLAUDE.md の `src/core/` 制約)。
 *
 * 実行そのもの(変更セット作成・差分表示・ExecuteChangeSet 等)は usecase 側
 * (T-14 以降)の責務であり、ここでは「何をどの順で行うか」の計画と、
 * 「失敗時に何をスキップ/継続すべきか」の純粋な判定のみを提供する。
 */

import type { DetectedEntry, DetectionResult } from './detect.js';
import { InvariantError } from './errors.js';
import {
  adjacencyOf,
  type RegionGraph,
  reverseOrder,
  topologicalOrder,
} from './graph.js';
import { parseStackKey, type StackKey } from './types.js';

// ---------------------------------------------------------------------------
// 公開型(下流タスクの契約)
// ---------------------------------------------------------------------------

export interface PlannedOperation {
  stackKey: StackKey;
  region: string;
  kind: 'create' | 'update' | 'delete';
  entry: DetectedEntry;
}

/** リージョン単位の操作列。create/update はトポロジカル順、delete は統合グラフの
 * 逆トポロジカル順で create/update の後に続く(FR-9-1)。 */
export interface RegionPlan {
  region: string;
  operations: PlannedOperation[];
}

/** リージョンの出現順は `regionOrder`(設定記載順)に従う(FR-13-6)。 */
export interface ExecutionPlan {
  regions: RegionPlan[];
  /** computeSkips が失敗ごとに全計画を再構築しないための内部索引。 */
  index: {
    flattened: PlannedOperation[];
    firstByStackKey: Map<StackKey, number>;
  };
}

export interface BuildPlanInput {
  detection: DetectionResult;
  /** 現行(新)グラフ。create/update の順序決定に使う。 */
  graphs: Map<string, RegionGraph>;
  /** 新旧統合グラフ。削除順序決定の正本(FR-6-4)。 */
  mergedGraphs: Map<string, RegionGraph>;
  /** リージョンの出現順(設定記載順、FR-13-6)。 */
  regionOrder: string[];
}

export interface ComputeSkipsInput {
  plan: ExecutionPlan;
  failedStackKey: StackKey;
  /** 依存関係の再構成に使う新旧統合グラフ(区切りなく参照可能な正本)。 */
  mergedGraphs: Map<string, RegionGraph>;
  onFailure: 'stop' | 'continue';
  /** delete 失敗では辺を逆向きに辿り、残存 dependent が必要とする provider を保護する。 */
  failureKind?: 'deploy' | 'delete';
  /** 実行側は skipped のみ必要なため false にして continue 列の全走査を省略する。 */
  collectContinued?: boolean;
}

export interface ComputeSkipsResult {
  /** 失敗スタックに(推移的に)依存する下流、および `stop` 時の独立スタック。 */
  skipped: StackKey[];
  /** `continue` 時に実行を継続する独立スタック。 */
  continued: StackKey[];
}

// ---------------------------------------------------------------------------
// buildPlan(design.md §5.3 手順 2: 変更分類 → 依存グラフ → 実行計画)
// ---------------------------------------------------------------------------

interface RegionBuckets {
  createUpdate: Map<StackKey, DetectedEntry>;
  delete: Map<StackKey, DetectedEntry>;
}

function bucketFor(
  byRegion: Map<string, RegionBuckets>,
  region: string,
): RegionBuckets {
  let buckets = byRegion.get(region);
  if (buckets === undefined) {
    buckets = { createUpdate: new Map(), delete: new Map() };
    byRegion.set(region, buckets);
  }
  return buckets;
}

/**
 * `detection.entries` をリージョンごと・操作種別ごとに振り分ける。
 * `unchanged` は operations に含めないため、ここで除外する。
 */
function groupByRegion(detection: DetectionResult): Map<string, RegionBuckets> {
  const byRegion = new Map<string, RegionBuckets>();
  for (const entry of detection.entries) {
    if (entry.changeType === 'unchanged') continue;
    const { region } = parseStackKey(entry.stackKey);
    const buckets = bucketFor(byRegion, region);
    if (entry.changeType === 'deleted') {
      buckets.delete.set(entry.stackKey, entry);
    } else {
      // 'added' | 'modified'
      buckets.createUpdate.set(entry.stackKey, entry);
    }
  }
  return byRegion;
}

/**
 * `regionOrder`(設定記載順)に従い、実際に操作を持つリージョンだけを並べる。
 * `regionOrder` に含まれない(=対象リージョンが設定から完全に除外された)
 * リージョンで操作が残っている場合(削除のみ等)も、取りこぼさないよう
 * 末尾に決定的な順序(文字列昇順)で追加する。
 */
function orderRegions(
  byRegion: Map<string, RegionBuckets>,
  regionOrder: string[],
): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const region of regionOrder) {
    if (byRegion.has(region) && !seen.has(region)) {
      ordered.push(region);
      seen.add(region);
    }
  }
  const leftover = [...byRegion.keys()]
    .filter((region) => !seen.has(region))
    .sort();
  ordered.push(...leftover);
  return ordered;
}

/**
 * グラフのトポロジカル順(`orderFn` で加工済み)のうち、`targetKeys` に含まれる
 * ものだけを抽出する。グラフが与えられない場合(対象リージョンがそのグラフの
 * 元になった集合に一切登場しない等)は、操作を取りこぼさないよう `targetKeys`
 * の Map 反復順(挿入順)にフォールバックする。
 */
function orderedKeys(
  graph: RegionGraph | undefined,
  targetKeys: Map<StackKey, DetectedEntry>,
  orderFn: (g: RegionGraph) => StackKey[],
): StackKey[] {
  if (graph === undefined) {
    return [...targetKeys.keys()];
  }
  return orderFn(graph).filter((key) => targetKeys.has(key));
}

/**
 * FR-9-1 / FR-13-6: 変更分類+依存グラフから順序付きの実行計画を組み立てる。
 * - create/update: `graphs`(現行グラフ)のトポロジカル順。
 * - delete: `mergedGraphs`(新旧統合グラフ)の逆トポロジカル順で、
 *   同一リージョン内の create/update の後に配置する。
 * - リージョンの出現順は `regionOrder` に従う(FR-13-6)。
 */
export function buildPlan(input: BuildPlanInput): ExecutionPlan {
  const { detection, graphs, mergedGraphs, regionOrder } = input;
  const byRegion = groupByRegion(detection);
  const orderedRegions = orderRegions(byRegion, regionOrder);

  const regions: RegionPlan[] = orderedRegions.map((region) => {
    const buckets = byRegion.get(region);
    // orderRegions は byRegion のキーのみを返すため必ず存在する。
    if (buckets === undefined) {
      throw new InvariantError(
        `Internal error: no bucket found for region ${region}`,
      );
    }

    const operations: PlannedOperation[] = [];

    const createUpdateKeys = orderedKeys(
      graphs.get(region),
      buckets.createUpdate,
      topologicalOrder,
    );
    for (const stackKey of createUpdateKeys) {
      const entry = buckets.createUpdate.get(stackKey);
      if (entry === undefined) continue;
      operations.push({
        stackKey,
        region,
        kind: entry.changeType === 'added' ? 'create' : 'update',
        entry,
      });
    }

    const deleteKeys = orderedKeys(
      mergedGraphs.get(region),
      buckets.delete,
      (g) => reverseOrder(topologicalOrder(g)),
    );
    for (const stackKey of deleteKeys) {
      const entry = buckets.delete.get(stackKey);
      if (entry === undefined) continue;
      operations.push({ stackKey, region, kind: 'delete', entry });
    }

    return { region, operations };
  });

  const flattened = regions.flatMap((region) => region.operations);
  const firstByStackKey = new Map<StackKey, number>();
  for (const [index, operation] of flattened.entries()) {
    if (!firstByStackKey.has(operation.stackKey)) {
      firstByStackKey.set(operation.stackKey, index);
    }
  }
  return { regions, index: { flattened, firstByStackKey } };
}

// ---------------------------------------------------------------------------
// computeSkips(FR-9-2 の純粋判定ロジック。実行時挙動は T-14)
// ---------------------------------------------------------------------------

/**
 * `graph` の辺を指定方向へ辿り、`start` から到達可能なスタックキー全員の
 * 集合を返す(`start` 自身は含まない)。forward は dependent、reverse は
 * provider を辿る。
 */
function transitiveClosure(
  graph: RegionGraph,
  start: StackKey,
  direction: 'forward' | 'reverse',
): Set<StackKey> {
  const adjacency = adjacencyOf(graph.edges, direction);

  const visited = new Set<StackKey>();
  const toVisit = [...(adjacency.get(start) ?? [])];
  while (toVisit.length > 0) {
    const next = toVisit.pop();
    if (next === undefined || visited.has(next)) continue;
    visited.add(next);
    for (const neighbor of adjacency.get(next) ?? []) {
      if (!visited.has(neighbor)) {
        toVisit.push(neighbor);
      }
    }
  }
  return visited;
}

/**
 * FR-9-2(判定): 失敗スタック(`failedStackKey`)より後(`plan` をリージョン
 * 出現順・操作順で平坦化した列における後続)の操作について、以下のとおり
 * skipped / continued に分類する:
 * - 失敗スタックに(推移的に)依存する下流 → 常に `skipped`。
 * - それ以外(独立スタック、リージョンをまたぐ後続を含む) →
 *   `onFailure: 'stop'` なら `skipped`、`'continue'` なら `continued`。
 *
 * 失敗スタックより前(既に実行済みの操作)は対象外。`failedStackKey` が
 * `plan` にない事前検証失敗(__REQUIRED__ 等)では、計画先頭から分類する。
 * delete 失敗は `failureKind: delete` により辺を逆向きに辿って provider を保護する。
 */
export function computeSkips(input: ComputeSkipsInput): ComputeSkipsResult {
  const { plan, failedStackKey, mergedGraphs, onFailure } = input;

  const flattened = plan.index.flattened;
  const failedIndex = plan.index.firstByStackKey.get(failedStackKey) ?? -1;
  const failedRegion =
    failedIndex === -1
      ? parseStackKey(failedStackKey).region
      : flattened[failedIndex].region;
  const failedRegionGraph = mergedGraphs.get(failedRegion);
  const protectedByFailure = failedRegionGraph
    ? transitiveClosure(
        failedRegionGraph,
        failedStackKey,
        input.failureKind === 'delete' ? 'reverse' : 'forward',
      )
    : new Set<StackKey>();

  const skipped: StackKey[] = [];
  const continued: StackKey[] = [];

  if (onFailure === 'continue' && input.collectContinued === false) {
    for (const stackKey of protectedByFailure) {
      const index = plan.index.firstByStackKey.get(stackKey);
      if (index !== undefined && index > failedIndex) skipped.push(stackKey);
    }
    return { skipped, continued };
  }

  for (let i = failedIndex + 1; i < flattened.length; i += 1) {
    const stackKey = flattened[i].stackKey;
    if (protectedByFailure.has(stackKey)) {
      skipped.push(stackKey);
    } else if (onFailure === 'stop') {
      skipped.push(stackKey);
    } else {
      continued.push(stackKey);
    }
  }

  return { skipped, continued };
}
