/**
 * T-06 core/graph — 依存関係グラフ(design.md §6, FR-8 / FR-9 / FR-6-4 / FR-13-6)。
 *
 * fs / AWS SDK は import しない純粋ロジック。テンプレート解析(core/template)
 * および設定(core/config)から得た `StackNode[]` を入力に、リージョンごとに
 * 独立したグラフを構築し、トポロジカルソート・新旧グラフの統合を提供する。
 */

import { DependencyCycleError } from './errors.js';
import { resolveManagedDependsOn, type StackKey } from './types.js';

/**
 * グラフ構築の入力単位。1 スタックキー(テンプレート×リージョン)に対応する。
 * `explicitDependsOn` は設定ファイルの `dependsOn`(テンプレートパスまたは
 * スタックキーのいずれかの形式)をそのまま保持する — 同一リージョン内の
 * スタックキーへの解決は `buildGraphs` が行う。
 */
export interface StackNode {
  stackKey: StackKey;
  region: string;
  exports: string[];
  imports: string[];
  explicitDependsOn: StackKey[];
}

/**
 * リージョン単位の依存グラフ。`edges` の `from` は依存される側(提供側)、
 * `to` は依存する側 — `from` が `to` より先にデプロイされる必要がある。
 */
export interface RegionGraph {
  region: string;
  nodes: StackKey[];
  edges: Array<{ from: StackKey; to: StackKey }>;
}

type GraphEdge = RegionGraph['edges'][number];

function pushInto<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values === undefined) map.set(key, [value]);
  else values.push(value);
}

export function adjacencyOf(
  edges: RegionGraph['edges'],
  direction: 'forward' | 'reverse',
): Map<StackKey, StackKey[]> {
  const adjacency = new Map<StackKey, StackKey[]>();
  for (const edge of edges) {
    const from = direction === 'forward' ? edge.from : edge.to;
    const to = direction === 'forward' ? edge.to : edge.from;
    pushInto(adjacency, from, to);
  }
  return adjacency;
}

function createEdgeCollector(): {
  edges: GraphEdge[];
  addEdge: (edge: GraphEdge) => void;
} {
  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();
  const addEdge = (edge: GraphEdge): void => {
    const dedupeKey = `${edge.from}\0${edge.to}`;
    if (seenEdges.has(dedupeKey)) return;
    seenEdges.add(dedupeKey);
    edges.push(edge);
  };
  return { edges, addEdge };
}

/**
 * `dependsOn` の値(テンプレートパス、またはスタックキー)を、
 * `node` と同一リージョンのスタックキーに解決する(FR-8-2)。スタックキー
 * 形式で与えられた場合でも、埋め込まれたリージョンは無視し、常に `region`
 * 引数のリージョンへ解決する — 「同一リージョン内のスタックキーに解決」の
 * 仕様どおり、依存元スタックのリージョン内でのみ解決対象を探すため。
 */
function buildRegionGraph(
  region: string,
  regionNodes: StackNode[],
): RegionGraph {
  const nodeKeys = regionNodes.map((n) => n.stackKey);
  const nodeKeySet = new Set(nodeKeys);

  // FR-8-1: export 名 → 提供スタックキーの索引(同一リージョン内のみ)。
  // 同名 export が複数存在する場合は先勝ち(決定的)とする — CloudFormation
  // 自体が account+region 内でのユニーク性を強制するため通常は発生しない。
  const exportIndex = new Map<string, StackKey>();
  for (const n of regionNodes) {
    for (const exportName of n.exports) {
      if (!exportIndex.has(exportName)) {
        exportIndex.set(exportName, n.stackKey);
      }
    }
  }

  const { edges, addEdge } = createEdgeCollector();

  for (const n of regionNodes) {
    // FR-8-1: import → export の自動解析。提供者がいない import はエラーに
    // せず辺なし(リージョン外・未管理スタックの export の可能性があるため)。
    for (const importName of n.imports) {
      const provider = exportIndex.get(importName);
      if (provider !== undefined) {
        addEdge({ from: provider, to: n.stackKey });
      }
    }

    // FR-8-2: 設定ファイルの明示依存を自動解析結果とマージ。解決先がグラフに
    // 存在しない/自己参照は core 単独利用でも無言で破棄しない。
    for (const raw of n.explicitDependsOn) {
      const resolved = resolveManagedDependsOn(
        raw,
        n.stackKey,
        n.region,
        nodeKeySet,
      );
      addEdge({ from: resolved, to: n.stackKey });
    }
  }

  return { region, nodes: nodeKeys, edges };
}

/**
 * `StackNode[]` からリージョンごとに独立したグラフを構築する(FR-13-6)。
 * Export/ImportValue の参照はリージョンをまたがないため、export 名の索引は
 * リージョンごとに個別に構築する。
 */
export function buildGraphs(nodes: StackNode[]): Map<string, RegionGraph> {
  const byRegion = new Map<string, StackNode[]>();
  for (const n of nodes) {
    pushInto(byRegion, n.region, n);
  }

  const graphs = new Map<string, RegionGraph>();
  for (const [region, regionNodes] of byRegion) {
    graphs.set(region, buildRegionGraph(region, regionNodes));
  }
  return graphs;
}

/**
 * `remaining`(未出力のノード)の中から循環を 1 つ検出し、そのメンバー全員を
 * `nodeOrder`(= 元の nodes 配列)の出現順で探索して返す(FR-8-4)。
 */
function findCycleMembers(
  nodeOrder: StackKey[],
  remaining: Set<StackKey>,
  adjacency: Map<StackKey, StackKey[]>,
): StackKey[] {
  const visited = new Set<StackKey>();
  const onStack = new Set<StackKey>();
  const stack: StackKey[] = [];

  const dfs = (current: StackKey): StackKey[] | undefined => {
    visited.add(current);
    onStack.add(current);
    stack.push(current);

    for (const next of adjacency.get(current) ?? []) {
      if (!remaining.has(next)) continue;
      if (!visited.has(next)) {
        const found = dfs(next);
        if (found) return found;
      } else if (onStack.has(next)) {
        const startIndex = stack.indexOf(next);
        return stack.slice(startIndex);
      }
    }

    stack.pop();
    onStack.delete(current);
    return undefined;
  };

  for (const key of nodeOrder) {
    if (remaining.has(key) && !visited.has(key)) {
      const found = dfs(key);
      if (found) return found;
    }
  }

  // 到達しないはず(呼び出し側は remaining が非空かつ Kahn 法が行き詰まった
  // ときのみ呼ぶ)。フォールバックとして残りノード全部を返す。
  return [...remaining];
}

/**
 * Kahn 法によるトポロジカルソート。同順位(入次数が同時に 0 になる)の
 * ノードは `graph.nodes` の出現順で安定に並べる(FR-9-1)。循環が残った場合は
 * `DependencyCycleError` にそのメンバー全員を列挙して投げる(FR-8-4)。
 */
export function topologicalOrder(graph: RegionGraph): StackKey[] {
  const inDegree = new Map<StackKey, number>();
  for (const key of graph.nodes) {
    inDegree.set(key, 0);
  }
  for (const edge of graph.edges) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }
  const adjacency = adjacencyOf(graph.edges, 'forward');

  const remaining = new Set(graph.nodes);
  const result: StackKey[] = [];

  while (remaining.size > 0) {
    const next = graph.nodes.find(
      (key) => remaining.has(key) && (inDegree.get(key) ?? 0) === 0,
    );

    if (next === undefined) {
      const cycle = findCycleMembers(graph.nodes, remaining, adjacency);
      throw new DependencyCycleError(cycle, { region: graph.region });
    }

    result.push(next);
    remaining.delete(next);
    for (const neighbor of adjacency.get(next) ?? []) {
      if (remaining.has(neighbor)) {
        const nextDegree = (inDegree.get(neighbor) ?? 0) - 1;
        inDegree.set(neighbor, nextDegree);
      }
    }
  }

  return result;
}

/**
 * 新旧グラフを統合する(FR-6-4)。ノード・辺の和集合を取り、重複辺は排除する。
 * `current` のノード順を優先し、`old` にのみ存在するノードを末尾に追加する
 * — 削除対象スタック(ファイルが削除済み)の旧依存辺を統合するための API。
 */
export function mergeGraphs(
  current: RegionGraph,
  old: RegionGraph,
): RegionGraph {
  const nodes: StackKey[] = [...current.nodes];
  const nodeSet = new Set(nodes);
  for (const key of old.nodes) {
    if (!nodeSet.has(key)) {
      nodes.push(key);
      nodeSet.add(key);
    }
  }

  const { edges, addEdge } = createEdgeCollector();
  for (const edge of current.edges) addEdge(edge);
  for (const edge of old.edges) addEdge(edge);

  return { region: current.region, nodes, edges };
}

/**
 * トポロジカル順序に基づく階層(レベル)を算出する(FR-8-6)。各ノードのレベルは
 * 「入力辺を持つ先行ノードの最大レベル+1」(先行ノードなしは 0)。同一レベル内の
 * スタックは互いに直接の辺を持たない(= 並列デプロイ可能)ことがレベルの定義から
 * 保証される。循環がある場合は内部で呼ぶ `topologicalOrder` がそのまま
 * `DependencyCycleError` を投げる(FR-8-4。レベル分割より前に fail-closed で停止し、
 * 部分的なレベル分割を返すことはない)。
 *
 * `levels[i]` の内部順序は topo 順ではなく `graph.nodes`(宣言順)を保つ —
 * 表示の決定性・設定順との対応のため。この算出はテキスト表示専用であり、
 * `core/plan.ts` の実行順序決定には使用しない(FR-9-3: 実行は引き続き直列)。
 */
export function computeLevels(graph: RegionGraph): StackKey[][] {
  const order = topologicalOrder(graph);

  const predecessors = adjacencyOf(graph.edges, 'reverse');

  const level = new Map<StackKey, number>();
  for (const key of order) {
    const preds = predecessors.get(key) ?? [];
    let lvl = 0;
    for (const pred of preds) {
      const predLevel = level.get(pred) ?? 0;
      if (predLevel + 1 > lvl) lvl = predLevel + 1;
    }
    level.set(key, lvl);
  }

  const levels: StackKey[][] = [];
  for (const key of graph.nodes) {
    const lvl = level.get(key) ?? 0;
    while (levels.length <= lvl) levels.push([]);
    levels[lvl].push(key);
  }

  return levels;
}

/** 削除用の逆順ヘルパ。引数を変更せず新しい配列を返す。 */
export function reverseOrder(order: StackKey[]): StackKey[] {
  return [...order].reverse();
}
