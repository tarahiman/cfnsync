import { describe, expect, it } from 'vitest';
import type { DetectedEntry, DetectionResult } from '../../src/core/detect.js';
import type { RegionGraph } from '../../src/core/graph.js';
import { buildPlan, computeSkips, type ExecutionPlan, type PlannedOperation } from '../../src/core/plan.js';
import { makeStackKey, type ChangeType, type StackKey } from '../../src/core/types.js';

const REGION_A = 'ap-northeast-1';
const REGION_B = 'us-east-1';

// ---------------------------------------------------------------------------
// テスト用ビルダー
// ---------------------------------------------------------------------------

/** DetectedEntry は plan.ts にとって opaque(stackKey / changeType のみ見る)なので最小構成で足りる。 */
function entry(stackKey: StackKey, changeType: ChangeType): DetectedEntry {
  return { stackKey, changeType };
}

function graph(region: string, nodes: StackKey[], edges: Array<[StackKey, StackKey]> = []): RegionGraph {
  return { region, nodes, edges: edges.map(([from, to]) => ({ from, to })) };
}

function kinds(plan: ExecutionPlan): Array<{ region: string; stackKey: StackKey; kind: PlannedOperation['kind'] }> {
  return plan.regions.flatMap((r) => r.operations.map((op) => ({ region: r.region, stackKey: op.stackKey, kind: op.kind })));
}

describe('core/plan — FR-9-1: 作成・更新はトポロジカル順、削除は統合グラフの逆順', () => {
  it('FR-9-1: 作成/更新は現行グラフのトポロジカル順に並ぶ(検知結果の入力順には依存しない)', () => {
    const network = makeStackKey('network.yaml', REGION_A);
    const database = makeStackKey('database.yaml', REGION_A);
    const app = makeStackKey('app.yaml', REGION_A);

    const detection: DetectionResult = {
      // わざと依存順とは逆に並べて入力する。
      entries: [entry(app, 'modified'), entry(database, 'added'), entry(network, 'added')],
    };

    const currentGraph = graph(
      REGION_A,
      [network, database, app],
      [
        [network, database],
        [database, app],
      ],
    );

    const plan = buildPlan({
      detection,
      graphs: new Map([[REGION_A, currentGraph]]),
      mergedGraphs: new Map([[REGION_A, currentGraph]]),
      regionOrder: [REGION_A],
    });

    expect(plan.regions).toHaveLength(1);
    expect(plan.regions[0].operations.map((op) => op.stackKey)).toEqual([network, database, app]);
    expect(plan.regions[0].operations.map((op) => op.kind)).toEqual(['create', 'create', 'update']);
  });

  it('FR-9-1: 削除は統合グラフ(新旧統合)の逆トポロジカル順に並ぶ', () => {
    const network = makeStackKey('network.yaml', REGION_A);
    const database = makeStackKey('database.yaml', REGION_A);

    // network, database ともにテンプレート削除済み → current には現れず、
    // mergedGraphs(新旧統合)にのみノードが存在する。
    const detection: DetectionResult = {
      entries: [entry(network, 'deleted'), entry(database, 'deleted')],
    };

    const merged = graph(REGION_A, [network, database], [[network, database]]);

    const plan = buildPlan({
      detection,
      graphs: new Map(),
      mergedGraphs: new Map([[REGION_A, merged]]),
      regionOrder: [REGION_A],
    });

    // トポロジカル順は [network, database]、削除はその逆順: database を先に、network を後に。
    expect(plan.regions[0].operations.map((op) => op.stackKey)).toEqual([database, network]);
    expect(plan.regions[0].operations.every((op) => op.kind === 'delete')).toBe(true);
  });

  it('FR-9-1: 同一リージョン内で削除は作成・更新の後に配置される', () => {
    const created = makeStackKey('new.yaml', REGION_A);
    const deleted = makeStackKey('old.yaml', REGION_A);

    const detection: DetectionResult = {
      entries: [entry(deleted, 'deleted'), entry(created, 'added')],
    };

    const currentGraph = graph(REGION_A, [created]);
    const merged = graph(REGION_A, [created, deleted]);

    const plan = buildPlan({
      detection,
      graphs: new Map([[REGION_A, currentGraph]]),
      mergedGraphs: new Map([[REGION_A, merged]]),
      regionOrder: [REGION_A],
    });

    expect(kinds(plan)).toEqual([
      { region: REGION_A, stackKey: created, kind: 'create' },
      { region: REGION_A, stackKey: deleted, kind: 'delete' },
    ]);
  });

  it('FR-9-1: unchanged は operations に含めない', () => {
    const kept = makeStackKey('kept.yaml', REGION_A);
    const changed = makeStackKey('changed.yaml', REGION_A);

    const detection: DetectionResult = {
      entries: [entry(kept, 'unchanged'), entry(changed, 'modified')],
    };

    const currentGraph = graph(REGION_A, [kept, changed]);

    const plan = buildPlan({
      detection,
      graphs: new Map([[REGION_A, currentGraph]]),
      mergedGraphs: new Map([[REGION_A, currentGraph]]),
      regionOrder: [REGION_A],
    });

    expect(plan.regions[0].operations.map((op) => op.stackKey)).toEqual([changed]);
  });
});

describe('core/plan — FR-9-3: 計画は順序付き列(直列実行前提だが並列化を妨げない構造)', () => {
  it('FR-9-3: ExecutionPlan はリージョンごとの操作列(配列)として出力され、同一入力からは常に同じ順序が再現される', () => {
    const a = makeStackKey('a.yaml', REGION_A);
    const b = makeStackKey('b.yaml', REGION_A);

    const detection: DetectionResult = { entries: [entry(a, 'added'), entry(b, 'added')] };
    const currentGraph = graph(REGION_A, [a, b]);

    const buildInput = {
      detection,
      graphs: new Map([[REGION_A, currentGraph]]),
      mergedGraphs: new Map([[REGION_A, currentGraph]]),
      regionOrder: [REGION_A],
    };

    const plan1 = buildPlan(buildInput);
    const plan2 = buildPlan(buildInput);

    expect(Array.isArray(plan1.regions)).toBe(true);
    expect(Array.isArray(plan1.regions[0].operations)).toBe(true);
    expect(plan1).toEqual(plan2);
  });
});

describe('core/plan — FR-13-6(順序): リージョン間は設定順の直列', () => {
  it('FR-13-6: 2 リージョン計画で region の出現順が regionOrder(設定記載順)になる', () => {
    const stackA = makeStackKey('app.yaml', REGION_A);
    const stackB = makeStackKey('app.yaml', REGION_B);

    // 検知結果の入力順は regionOrder とあえて逆にする。
    const detection: DetectionResult = { entries: [entry(stackB, 'added'), entry(stackA, 'added')] };

    const graphA = graph(REGION_A, [stackA]);
    const graphB = graph(REGION_B, [stackB]);

    const plan = buildPlan({
      detection,
      graphs: new Map([
        [REGION_B, graphB],
        [REGION_A, graphA],
      ]),
      mergedGraphs: new Map([
        [REGION_B, graphB],
        [REGION_A, graphA],
      ]),
      regionOrder: [REGION_A, REGION_B],
    });

    expect(plan.regions.map((r) => r.region)).toEqual([REGION_A, REGION_B]);
  });

  it('FR-13-6: regionOrder を逆にすると出力の region 順も逆になる', () => {
    const stackA = makeStackKey('app.yaml', REGION_A);
    const stackB = makeStackKey('app.yaml', REGION_B);

    const detection: DetectionResult = { entries: [entry(stackA, 'added'), entry(stackB, 'added')] };
    const graphA = graph(REGION_A, [stackA]);
    const graphB = graph(REGION_B, [stackB]);

    const plan = buildPlan({
      detection,
      graphs: new Map([
        [REGION_A, graphA],
        [REGION_B, graphB],
      ]),
      mergedGraphs: new Map([
        [REGION_A, graphA],
        [REGION_B, graphB],
      ]),
      regionOrder: [REGION_B, REGION_A],
    });

    expect(plan.regions.map((r) => r.region)).toEqual([REGION_B, REGION_A]);
  });
});

describe('core/plan — FR-9-2(判定): computeSkips の純粋判定ロジック', () => {
  it('FR-9-2: 失敗スタックに推移的に依存する下流は、onFailure の値によらず常に skipped になる', () => {
    const network = makeStackKey('network.yaml', REGION_A);
    const database = makeStackKey('database.yaml', REGION_A);
    const app = makeStackKey('app.yaml', REGION_A);

    const detection: DetectionResult = {
      entries: [entry(network, 'added'), entry(database, 'added'), entry(app, 'added')],
    };
    const currentGraph = graph(
      REGION_A,
      [network, database, app],
      [
        [network, database],
        [database, app],
      ],
    );

    const plan = buildPlan({
      detection,
      graphs: new Map([[REGION_A, currentGraph]]),
      mergedGraphs: new Map([[REGION_A, currentGraph]]),
      regionOrder: [REGION_A],
    });

    for (const onFailure of ['stop', 'continue'] as const) {
      const result = computeSkips({
        plan,
        failedStackKey: network,
        mergedGraphs: new Map([[REGION_A, currentGraph]]),
        onFailure,
      });

      expect(new Set(result.skipped)).toEqual(new Set([database, app]));
      expect(result.continued).toEqual([]);
    }
  });

  it('FR-9-2: onFailure=stop では、依存関係のない独立スタックも中止(skipped)になる', () => {
    const failed = makeStackKey('failed.yaml', REGION_A);
    const independent = makeStackKey('independent.yaml', REGION_A);

    const detection: DetectionResult = { entries: [entry(failed, 'added'), entry(independent, 'added')] };
    const currentGraph = graph(REGION_A, [failed, independent]); // 辺なし = 独立

    const plan = buildPlan({
      detection,
      graphs: new Map([[REGION_A, currentGraph]]),
      mergedGraphs: new Map([[REGION_A, currentGraph]]),
      regionOrder: [REGION_A],
    });

    const result = computeSkips({
      plan,
      failedStackKey: failed,
      mergedGraphs: new Map([[REGION_A, currentGraph]]),
      onFailure: 'stop',
    });

    expect(result.skipped).toEqual([independent]);
    expect(result.continued).toEqual([]);
  });

  it('FR-9-2: onFailure=continue では、依存関係のない独立スタックは継続対象(continued)になる', () => {
    const failed = makeStackKey('failed.yaml', REGION_A);
    const independent = makeStackKey('independent.yaml', REGION_A);

    const detection: DetectionResult = { entries: [entry(failed, 'added'), entry(independent, 'added')] };
    const currentGraph = graph(REGION_A, [failed, independent]);

    const plan = buildPlan({
      detection,
      graphs: new Map([[REGION_A, currentGraph]]),
      mergedGraphs: new Map([[REGION_A, currentGraph]]),
      regionOrder: [REGION_A],
    });

    const result = computeSkips({
      plan,
      failedStackKey: failed,
      mergedGraphs: new Map([[REGION_A, currentGraph]]),
      onFailure: 'continue',
    });

    expect(result.continued).toEqual([independent]);
    expect(result.skipped).toEqual([]);
  });

  it('FR-9-2: リージョンをまたぐ後続も対象 — stop では失敗以降の全リージョンが中止になる', () => {
    const failed = makeStackKey('app.yaml', REGION_A);
    const otherRegionStack = makeStackKey('app.yaml', REGION_B);

    const detection: DetectionResult = { entries: [entry(failed, 'added'), entry(otherRegionStack, 'added')] };
    const graphA = graph(REGION_A, [failed]);
    const graphB = graph(REGION_B, [otherRegionStack]);

    const plan = buildPlan({
      detection,
      graphs: new Map([
        [REGION_A, graphA],
        [REGION_B, graphB],
      ]),
      mergedGraphs: new Map([
        [REGION_A, graphA],
        [REGION_B, graphB],
      ]),
      regionOrder: [REGION_A, REGION_B],
    });

    const result = computeSkips({
      plan,
      failedStackKey: failed,
      mergedGraphs: new Map([
        [REGION_A, graphA],
        [REGION_B, graphB],
      ]),
      onFailure: 'stop',
    });

    // otherRegionStack は REGION_A の失敗スタックとは依存関係がない(別リージョンの独立グラフ)が、
    // stop 指定のため後続リージョン全体が中止対象になる。
    expect(result.skipped).toEqual([otherRegionStack]);
    expect(result.continued).toEqual([]);
  });

  it('FR-9-2: リージョンをまたぐ後続 — continue では別リージョンの独立スタックは継続対象になる', () => {
    const failed = makeStackKey('app.yaml', REGION_A);
    const otherRegionStack = makeStackKey('app.yaml', REGION_B);

    const detection: DetectionResult = { entries: [entry(failed, 'added'), entry(otherRegionStack, 'added')] };
    const graphA = graph(REGION_A, [failed]);
    const graphB = graph(REGION_B, [otherRegionStack]);

    const plan = buildPlan({
      detection,
      graphs: new Map([
        [REGION_A, graphA],
        [REGION_B, graphB],
      ]),
      mergedGraphs: new Map([
        [REGION_A, graphA],
        [REGION_B, graphB],
      ]),
      regionOrder: [REGION_A, REGION_B],
    });

    const result = computeSkips({
      plan,
      failedStackKey: failed,
      mergedGraphs: new Map([
        [REGION_A, graphA],
        [REGION_B, graphB],
      ]),
      onFailure: 'continue',
    });

    expect(result.continued).toEqual([otherRegionStack]);
    expect(result.skipped).toEqual([]);
  });

  it('FR-9-2: 失敗スタックより前(既に実行済み)の操作は skipped にも continued にも含めない', () => {
    const before = makeStackKey('before.yaml', REGION_A);
    const failed = makeStackKey('failed.yaml', REGION_A);
    const after = makeStackKey('after.yaml', REGION_A);

    const detection: DetectionResult = {
      entries: [entry(before, 'added'), entry(failed, 'added'), entry(after, 'added')],
    };
    const currentGraph = graph(REGION_A, [before, failed, after]); // すべて独立

    const plan = buildPlan({
      detection,
      graphs: new Map([[REGION_A, currentGraph]]),
      mergedGraphs: new Map([[REGION_A, currentGraph]]),
      regionOrder: [REGION_A],
    });

    const result = computeSkips({
      plan,
      failedStackKey: failed,
      mergedGraphs: new Map([[REGION_A, currentGraph]]),
      onFailure: 'stop',
    });

    expect(result.skipped).toEqual([after]);
    expect(result.skipped).not.toContain(before);
    expect(result.continued).toEqual([]);
  });
});
