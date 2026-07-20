import { describe, expect, it } from 'vitest';
import { ConfigError, DependencyCycleError } from '../../src/core/errors.js';
import {
  buildGraphs,
  mergeGraphs,
  type RegionGraph,
  reverseOrder,
  type StackNode,
  topologicalOrder,
} from '../../src/core/graph.js';
import { makeStackKey, type StackKey } from '../../src/core/types.js';

const REGION_A = 'ap-northeast-1';
const REGION_B = 'us-east-1';

function node(
  overrides: Partial<StackNode> & Pick<StackNode, 'stackKey' | 'region'>,
): StackNode {
  return {
    exports: [],
    imports: [],
    explicitDependsOn: [],
    ...overrides,
  };
}

/** region 内のグラフを取得するヘルパ(存在しなければテストを失敗させる)。 */
function graphFor(
  graphs: Map<string, RegionGraph>,
  region: string,
): RegionGraph {
  const graph = graphs.get(region);
  if (!graph) {
    throw new Error(`region ${region} のグラフが見つかりません`);
  }
  return graph;
}

function edgeSet(graph: RegionGraph): Set<string> {
  return new Set(graph.edges.map((e) => `${e.from}=>${e.to}`));
}

describe('core/graph — FR-8-1(構築): Export/ImportValue からの辺の構築', () => {
  it('FR-8-1: export 名 → 提供スタックキーの索引から辺が張られる(提供側 from → 依存側 to)', () => {
    const network = node({
      stackKey: makeStackKey('network.yaml', REGION_A),
      region: REGION_A,
      exports: ['prod-network-VpcId'],
    });
    const database = node({
      stackKey: makeStackKey('database.yaml', REGION_A),
      region: REGION_A,
      imports: ['prod-network-VpcId'],
    });

    const graphs = buildGraphs([network, database]);
    const graph = graphFor(graphs, REGION_A);

    expect(graph.nodes).toEqual([network.stackKey, database.stackKey]);
    expect(edgeSet(graph)).toEqual(
      new Set([`${network.stackKey}=>${database.stackKey}`]),
    );
  });

  it('FR-8-1: 提供者のいない import 名はエラーにせず辺を張らない(リージョン外・未管理スタックの可能性)', () => {
    const database = node({
      stackKey: makeStackKey('database.yaml', REGION_A),
      region: REGION_A,
      imports: ['no-such-export'],
    });

    const graphs = buildGraphs([database]);
    const graph = graphFor(graphs, REGION_A);

    expect(graph.edges).toEqual([]);
  });

  it('FR-8-1: 同一 import 名を複数スタックが参照しても、それぞれ提供側からの辺になる', () => {
    const network = node({
      stackKey: makeStackKey('network.yaml', REGION_A),
      region: REGION_A,
      exports: ['shared-VpcId'],
    });
    const app1 = node({
      stackKey: makeStackKey('app1.yaml', REGION_A),
      region: REGION_A,
      imports: ['shared-VpcId'],
    });
    const app2 = node({
      stackKey: makeStackKey('app2.yaml', REGION_A),
      region: REGION_A,
      imports: ['shared-VpcId'],
    });

    const graph = graphFor(buildGraphs([network, app1, app2]), REGION_A);

    expect(edgeSet(graph)).toEqual(
      new Set([
        `${network.stackKey}=>${app1.stackKey}`,
        `${network.stackKey}=>${app2.stackKey}`,
      ]),
    );
  });
});

describe('core/graph — FR-8-2: 明示依存(dependsOn)のマージ', () => {
  it('FR-8-2: explicitDependsOn(テンプレートパス形式)が自動解析結果とマージされる', () => {
    const network = node({
      stackKey: makeStackKey('network.yaml', REGION_A),
      region: REGION_A,
    });
    const app = node({
      stackKey: makeStackKey('app.yaml', REGION_A),
      region: REGION_A,
      // 自動解析(export/import)では検出できないパラメータ経由の依存を明示宣言。
      explicitDependsOn: ['network.yaml'],
    });

    const graph = graphFor(buildGraphs([network, app]), REGION_A);

    expect(edgeSet(graph)).toEqual(
      new Set([`${network.stackKey}=>${app.stackKey}`]),
    );
  });

  it('FR-8-2: explicitDependsOn(スタックキー形式)も同一リージョン内のスタックキーに解決される', () => {
    const network = node({
      stackKey: makeStackKey('network.yaml', REGION_A),
      region: REGION_A,
    });
    const app = node({
      stackKey: makeStackKey('app.yaml', REGION_A),
      region: REGION_A,
      explicitDependsOn: [makeStackKey('network.yaml', REGION_A)],
    });

    const graph = graphFor(buildGraphs([network, app]), REGION_A);

    expect(edgeSet(graph)).toEqual(
      new Set([`${network.stackKey}=>${app.stackKey}`]),
    );
  });

  it('FR-8-2: 自動解析の辺と明示依存の辺が同一の場合は重複させない', () => {
    const network = node({
      stackKey: makeStackKey('network.yaml', REGION_A),
      region: REGION_A,
      exports: ['prod-network-VpcId'],
    });
    const database = node({
      stackKey: makeStackKey('database.yaml', REGION_A),
      region: REGION_A,
      imports: ['prod-network-VpcId'],
      explicitDependsOn: ['network.yaml'],
    });

    const graph = graphFor(buildGraphs([network, database]), REGION_A);

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toEqual({
      from: network.stackKey,
      to: database.stackKey,
    });
  });

  it('FR-8-2: 解決先がグラフに存在しない明示依存を fail-closed で拒否する', () => {
    const app = node({
      stackKey: makeStackKey('app.yaml', REGION_A),
      region: REGION_A,
      explicitDependsOn: ['not-in-graph.yaml'],
    });

    expect(() => buildGraphs([app])).toThrow(ConfigError);
  });
});

describe('core/graph — FR-8-4: 循環検出', () => {
  it('FR-8-4: A→B→C→A の循環は DependencyCycleError となり循環メンバー全員が列挙される', () => {
    const a = node({
      stackKey: makeStackKey('a.yaml', REGION_A),
      region: REGION_A,
      exports: ['A-Out'],
      imports: ['C-Out'],
    });
    const b = node({
      stackKey: makeStackKey('b.yaml', REGION_A),
      region: REGION_A,
      exports: ['B-Out'],
      imports: ['A-Out'],
    });
    const c = node({
      stackKey: makeStackKey('c.yaml', REGION_A),
      region: REGION_A,
      exports: ['C-Out'],
      imports: ['B-Out'],
    });

    const graph = graphFor(buildGraphs([a, b, c]), REGION_A);

    let thrown: unknown;
    try {
      topologicalOrder(graph);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(DependencyCycleError);
    const cycle = (thrown as InstanceType<typeof DependencyCycleError>).cycle;
    expect(new Set(cycle)).toEqual(
      new Set([a.stackKey, b.stackKey, c.stackKey]),
    );
    expect(cycle).toHaveLength(3);
  });

  it('FR-8-4: 循環に含まれないスタックはエラーに巻き込まれない(循環メンバーのみを列挙)', () => {
    // d は独立(循環に依存しない)。循環は a<->b の直接相互依存。
    const a = node({
      stackKey: makeStackKey('a.yaml', REGION_A),
      region: REGION_A,
      exports: ['A-Out'],
      imports: ['B-Out'],
    });
    const b = node({
      stackKey: makeStackKey('b.yaml', REGION_A),
      region: REGION_A,
      exports: ['B-Out'],
      imports: ['A-Out'],
    });
    const d = node({
      stackKey: makeStackKey('d.yaml', REGION_A),
      region: REGION_A,
    });

    const graph = graphFor(buildGraphs([a, b, d]), REGION_A);

    try {
      topologicalOrder(graph);
      expect.unreachable('循環があるため例外が投げられるはず');
    } catch (err) {
      expect(err).toBeInstanceOf(DependencyCycleError);
      const cycle = (err as InstanceType<typeof DependencyCycleError>).cycle;
      expect(new Set(cycle)).toEqual(new Set([a.stackKey, b.stackKey]));
      expect(cycle).not.toContain(d.stackKey);
    }
  });
});

describe('core/graph — FR-9-1(順序): トポロジカルソートの決定的順序', () => {
  it('FR-9-1: 依存されるスタックが先、依存するスタックが後になる(単純な鎖)', () => {
    const network = node({
      stackKey: makeStackKey('network.yaml', REGION_A),
      region: REGION_A,
      exports: ['VpcId'],
    });
    const database = node({
      stackKey: makeStackKey('database.yaml', REGION_A),
      region: REGION_A,
      exports: ['DbEndpoint'],
      imports: ['VpcId'],
    });
    const app = node({
      stackKey: makeStackKey('app.yaml', REGION_A),
      region: REGION_A,
      imports: ['DbEndpoint'],
    });

    const graph = graphFor(buildGraphs([app, database, network]), REGION_A);
    const order = topologicalOrder(graph);

    expect(order).toEqual([network.stackKey, database.stackKey, app.stackKey]);
  });

  it('FR-9-1: 同順位(独立)のスタックは nodes 配列の出現順で安定する', () => {
    const network = node({
      stackKey: makeStackKey('network.yaml', REGION_A),
      region: REGION_A,
      exports: ['VpcId'],
    });
    // b, a の順で渡すが、どちらも network にのみ依存(相互に依存関係なし)。
    const b = node({
      stackKey: makeStackKey('b.yaml', REGION_A),
      region: REGION_A,
      imports: ['VpcId'],
    });
    const a = node({
      stackKey: makeStackKey('a.yaml', REGION_A),
      region: REGION_A,
      imports: ['VpcId'],
    });

    const graph = graphFor(buildGraphs([network, b, a]), REGION_A);
    const order = topologicalOrder(graph);

    // nodes 配列(= buildGraphs に渡した順)の出現順どおり、b が a より先。
    expect(order).toEqual([network.stackKey, b.stackKey, a.stackKey]);
  });

  it('FR-9-1: 辺のないグラフは nodes 配列の順序そのままを返す', () => {
    const x = node({
      stackKey: makeStackKey('x.yaml', REGION_A),
      region: REGION_A,
    });
    const y = node({
      stackKey: makeStackKey('y.yaml', REGION_A),
      region: REGION_A,
    });

    const graph = graphFor(buildGraphs([x, y]), REGION_A);
    expect(topologicalOrder(graph)).toEqual([x.stackKey, y.stackKey]);
  });
});

describe('core/graph — FR-6-4(統合): 新旧グラフの統合と削除順序', () => {
  it('FR-6-4: ファイル削除済みスタックの旧依存辺(ステートの exports/imports)を統合し、逆順が正しく出る', () => {
    const networkKey = makeStackKey('network.yaml', REGION_A);
    const databaseKey = makeStackKey('database.yaml', REGION_A);

    // 現在: network.yaml は削除済み(テンプレートが存在しない)ため current には database のみが残る。
    // database はまだ import 名を保持しているが、提供側が current に存在しないため辺は張られない。
    const currentDatabase = node({
      stackKey: databaseKey,
      region: REGION_A,
      imports: ['prod-network-VpcId'],
    });
    const current = graphFor(buildGraphs([currentDatabase]), REGION_A);
    expect(current.edges).toEqual([]);

    // 旧グラフ: ステートの StackEntry.exports/imports から StackNode を再構成する。
    const oldNetwork = node({
      stackKey: networkKey,
      region: REGION_A,
      exports: ['prod-network-VpcId'],
    });
    const oldDatabase = node({
      stackKey: databaseKey,
      region: REGION_A,
      imports: ['prod-network-VpcId'],
    });
    const old = graphFor(buildGraphs([oldNetwork, oldDatabase]), REGION_A);
    expect(edgeSet(old)).toEqual(new Set([`${networkKey}=>${databaseKey}`]));

    const merged = mergeGraphs(current, old);

    expect(new Set(merged.nodes)).toEqual(new Set([databaseKey, networkKey]));
    expect(edgeSet(merged)).toEqual(new Set([`${networkKey}=>${databaseKey}`]));

    const order = topologicalOrder(merged);
    expect(order).toEqual([networkKey, databaseKey]);

    // 削除は依存の逆順: database(依存する側)を先に、network(依存される側)を後に削除する。
    expect(reverseOrder(order)).toEqual([databaseKey, networkKey]);
  });

  it('FR-6-4: mergeGraphs はノード・辺の和集合を取り、current 側の辺も保持する', () => {
    const a = makeStackKey('a.yaml', REGION_A);
    const b = makeStackKey('b.yaml', REGION_A);
    const c = makeStackKey('c.yaml', REGION_A);

    const current: RegionGraph = {
      region: REGION_A,
      nodes: [a, b],
      edges: [{ from: a, to: b }],
    };
    const old: RegionGraph = {
      region: REGION_A,
      nodes: [b, c],
      edges: [{ from: c, to: b }],
    };

    const merged = mergeGraphs(current, old);

    expect(new Set(merged.nodes)).toEqual(new Set([a, b, c]));
    expect(edgeSet(merged)).toEqual(new Set([`${a}=>${b}`, `${c}=>${b}`]));
  });

  it('FR-6-4: mergeGraphs は重複する辺を排除する', () => {
    const a = makeStackKey('a.yaml', REGION_A);
    const b = makeStackKey('b.yaml', REGION_A);

    const current: RegionGraph = {
      region: REGION_A,
      nodes: [a, b],
      edges: [{ from: a, to: b }],
    };
    const old: RegionGraph = {
      region: REGION_A,
      nodes: [a, b],
      edges: [{ from: a, to: b }],
    };

    const merged = mergeGraphs(current, old);
    expect(merged.edges).toHaveLength(1);
  });

  it('internal: reverseOrder は入力配列を変更せず逆順の新しい配列を返す', () => {
    const order: StackKey[] = [
      makeStackKey('a.yaml', REGION_A),
      makeStackKey('b.yaml', REGION_A),
    ];
    const reversed = reverseOrder(order);
    expect(reversed).toEqual([order[1], order[0]]);
    expect(order).toEqual([
      makeStackKey('a.yaml', REGION_A),
      makeStackKey('b.yaml', REGION_A),
    ]);
  });
});

describe('core/graph — FR-13-6: グラフはリージョンごとに独立', () => {
  it('FR-13-6: 別リージョンの同名 Export は辺を張らない', () => {
    const networkA = node({
      stackKey: makeStackKey('network.yaml', REGION_A),
      region: REGION_A,
      exports: ['shared-VpcId'],
    });
    const databaseB = node({
      stackKey: makeStackKey('database.yaml', REGION_B),
      region: REGION_B,
      imports: ['shared-VpcId'],
    });

    const graphs = buildGraphs([networkA, databaseB]);

    expect(graphs.size).toBe(2);
    expect(graphFor(graphs, REGION_A).edges).toEqual([]);
    expect(graphFor(graphs, REGION_B).edges).toEqual([]);
  });

  it('FR-13-6: リージョンごとに独立したグラフが返り、それぞれの nodes は自リージョンのスタックのみを含む', () => {
    const networkA = node({
      stackKey: makeStackKey('network.yaml', REGION_A),
      region: REGION_A,
    });
    const appA = node({
      stackKey: makeStackKey('app.yaml', REGION_A),
      region: REGION_A,
    });
    const networkB = node({
      stackKey: makeStackKey('network.yaml', REGION_B),
      region: REGION_B,
    });

    const graphs = buildGraphs([networkA, appA, networkB]);

    expect(new Set(graphFor(graphs, REGION_A).nodes)).toEqual(
      new Set([networkA.stackKey, appA.stackKey]),
    );
    expect(graphFor(graphs, REGION_B).nodes).toEqual([networkB.stackKey]);
  });

  it('FR-13-6: 同一テンプレートパスの異なるリージョン向け explicitDependsOn(テンプレートパス形式)は自リージョン内で解決される', () => {
    const networkA = node({
      stackKey: makeStackKey('network.yaml', REGION_A),
      region: REGION_A,
    });
    const appA = node({
      stackKey: makeStackKey('app.yaml', REGION_A),
      region: REGION_A,
      explicitDependsOn: ['network.yaml'],
    });
    const networkB = node({
      stackKey: makeStackKey('network.yaml', REGION_B),
      region: REGION_B,
    });
    const appB = node({
      stackKey: makeStackKey('app.yaml', REGION_B),
      region: REGION_B,
      explicitDependsOn: ['network.yaml'],
    });

    const graphs = buildGraphs([networkA, appA, networkB, appB]);

    expect(edgeSet(graphFor(graphs, REGION_A))).toEqual(
      new Set([`${networkA.stackKey}=>${appA.stackKey}`]),
    );
    expect(edgeSet(graphFor(graphs, REGION_B))).toEqual(
      new Set([`${networkB.stackKey}=>${appB.stackKey}`]),
    );
  });
});
