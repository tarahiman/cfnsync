/**
 * T-11 report のテスト(tasks.md §5 T-11 の対応表)。
 *
 * usecase(未実装)が依存する出力契約をここで固定する。実 AWS には接続しない
 * 純粋関数のテスト。各 it の先頭に対応する受け入れ基準 ID を明記する。
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RegionGraph } from '../../src/core/graph.js';
import { makeStackKey } from '../../src/core/types.js';
import type { ChangeSetDetail, ResourceChange } from '../../src/ports/index.js';
import {
  buildApprovalSummary,
  buildStackDiff,
  type ConnectionInfo,
  type DeployReport,
  maskNoEcho,
  renderApprovalSummary,
  renderGraphJson,
  renderGraphText,
  renderJson,
  renderText,
  type StackDiff,
} from '../../src/report/index.js';

const REGION = 'ap-northeast-1';
const REGION_B = 'us-east-1';

function change(
  overrides: Partial<ResourceChange> &
    Pick<ResourceChange, 'logicalResourceId'>,
): ResourceChange {
  return {
    action: 'Modify',
    resourceType: 'AWS::EC2::VPC',
    scope: ['Properties'],
    details: [],
    ...overrides,
  };
}

function connection(overrides: Partial<ConnectionInfo> = {}): ConnectionInfo {
  return { accountId: '123456789012', regions: [REGION], ...overrides };
}

function report(
  diffs: StackDiff[],
  overrides: Partial<DeployReport> = {},
): DeployReport {
  return { connection: connection(), diffs, ...overrides };
}

// ---------------------------------------------------------------------------
// FR-3-1: リソース単位の Add / Modify / Remove と変更プロパティを表示
// ---------------------------------------------------------------------------

describe('FR-3-1: リソース単位の変更種別・変更プロパティの整形', () => {
  it('FR-3-1: DescribeChangeSet の Changes から action・logicalResourceId・resourceType・変更プロパティが整形される', () => {
    const detail: ChangeSetDetail = {
      status: 'CREATE_COMPLETE',
      changes: [
        change({
          logicalResourceId: 'Vpc',
          action: 'Modify',
          resourceType: 'AWS::EC2::VPC',
          details: [
            {
              target: { attribute: 'Properties', name: 'CidrBlock' },
              evaluation: 'Static',
            },
            {
              target: { attribute: 'Properties', name: 'Tags' },
              evaluation: 'Static',
            },
          ],
        }),
        change({
          logicalResourceId: 'Subnet',
          action: 'Add',
          resourceType: 'AWS::EC2::Subnet',
        }),
        change({
          logicalResourceId: 'Old',
          action: 'Remove',
          resourceType: 'AWS::EC2::RouteTable',
        }),
      ],
      parameters: {},
      tags: {},
      capabilities: [],
    };

    const diff = buildStackDiff({
      stackKey: makeStackKey('network.yaml', REGION),
      region: REGION,
      stackName: 'prod-network',
      operation: 'update',
      detail,
      noEchoParams: [],
    });

    expect(diff.resources).toHaveLength(3);
    expect(diff.resources[0]).toMatchObject({
      action: 'Modify',
      logicalResourceId: 'Vpc',
      resourceType: 'AWS::EC2::VPC',
      changedProperties: ['CidrBlock', 'Tags'],
    });
    expect(diff.resources[1]).toMatchObject({
      action: 'Add',
      logicalResourceId: 'Subnet',
    });
    expect(diff.resources[2]).toMatchObject({
      action: 'Remove',
      logicalResourceId: 'Old',
    });
  });

  it('FR-3-1: renderText はリソース単位の変更種別・変更プロパティを含める', () => {
    const detail: ChangeSetDetail = {
      status: 'CREATE_COMPLETE',
      changes: [
        change({
          logicalResourceId: 'Vpc',
          action: 'Modify',
          resourceType: 'AWS::EC2::VPC',
          details: [{ target: { attribute: 'Properties', name: 'CidrBlock' } }],
        }),
      ],
      parameters: {},
      tags: {},
      capabilities: [],
    };
    const diff = buildStackDiff({
      stackKey: makeStackKey('network.yaml', REGION),
      region: REGION,
      stackName: 'prod-network',
      operation: 'update',
      detail,
      noEchoParams: [],
    });

    const text = renderText(report([diff]));
    expect(text).toContain('Modify');
    expect(text).toContain('Vpc');
    expect(text).toContain('AWS::EC2::VPC');
    expect(text).toContain('CidrBlock');
  });

  it('FR-3-1(値差分): CloudFormation が返したプロパティ前後値とメタデータを text / JSON にそのまま含める', () => {
    const detail: ChangeSetDetail = {
      status: 'CREATE_COMPLETE',
      changes: [
        change({
          logicalResourceId: 'Vpc',
          beforeContext: '{"Properties":{"CidrBlock":"10.0.0.0/16"}}',
          afterContext: '{"Properties":{"CidrBlock":"10.1.0.0/16"}}',
          details: [
            {
              target: {
                attribute: 'Properties',
                name: 'CidrBlock',
                path: '/Properties/CidrBlock',
                beforeValue: '10.0.0.0/16',
                afterValue: '10.1.0.0/16',
                beforeValueFrom: 'PREVIOUS_DEPLOYMENT_STATE',
                afterValueFrom: 'TEMPLATE',
                attributeChangeType: 'Modify',
                requiresRecreation: 'Never',
              },
              evaluation: 'Static',
              changeSource: 'DirectModification',
            },
          ],
        }),
      ],
      parameters: {},
      tags: {},
      capabilities: [],
    };
    const diff = buildStackDiff({
      stackKey: makeStackKey('network.yaml', REGION),
      region: REGION,
      stackName: 'prod-network',
      operation: 'update',
      detail,
      noEchoParams: [],
    });

    const text = renderText(report([diff]));
    expect(text).toContain('/Properties/CidrBlock');
    expect(text).toContain('10.0.0.0/16');
    expect(text).toContain('10.1.0.0/16');
    expect(text).toContain('DirectModification');
    expect(text).toContain('PREVIOUS_DEPLOYMENT_STATE');
    expect(text).toContain('TEMPLATE');

    const json = JSON.parse(renderJson(report([diff])));
    expect(json.diffs[0].resources[0]).toMatchObject({
      beforeContext: '{"Properties":{"CidrBlock":"10.0.0.0/16"}}',
      afterContext: '{"Properties":{"CidrBlock":"10.1.0.0/16"}}',
      details: [
        {
          target: {
            path: '/Properties/CidrBlock',
            beforeValue: '10.0.0.0/16',
            afterValue: '10.1.0.0/16',
            beforeValueFrom: 'PREVIOUS_DEPLOYMENT_STATE',
            afterValueFrom: 'TEMPLATE',
            attributeChangeType: 'Modify',
          },
          evaluation: 'Static',
          changeSource: 'DirectModification',
        },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// FR-3-2: Replacement は警告として強調(テキスト・JSON 双方にフラグ)
// ---------------------------------------------------------------------------

describe('FR-3-2: Replacement の警告強調', () => {
  it('FR-3-2: Replacement: True のリソースは resources[].replacement === true になる', () => {
    const detail: ChangeSetDetail = {
      status: 'CREATE_COMPLETE',
      changes: [change({ logicalResourceId: 'Vpc', replacement: 'True' })],
      parameters: {},
      tags: {},
      capabilities: [],
    };
    const diff = buildStackDiff({
      stackKey: makeStackKey('network.yaml', REGION),
      region: REGION,
      stackName: 'prod-network',
      operation: 'update',
      detail,
      noEchoParams: [],
    });

    expect(diff.resources[0].replacement).toBe(true);
  });

  it('FR-3-2: Replacement: Conditional も警告扱い(replacement: true)になる', () => {
    const detail: ChangeSetDetail = {
      status: 'CREATE_COMPLETE',
      changes: [
        change({ logicalResourceId: 'Vpc', replacement: 'Conditional' }),
      ],
      parameters: {},
      tags: {},
      capabilities: [],
    };
    const diff = buildStackDiff({
      stackKey: makeStackKey('network.yaml', REGION),
      region: REGION,
      stackName: 'prod-network',
      operation: 'update',
      detail,
      noEchoParams: [],
    });

    expect(diff.resources[0].replacement).toBe(true);
  });

  it('FR-3-2: Replacement: False は replacement: false になる', () => {
    const detail: ChangeSetDetail = {
      status: 'CREATE_COMPLETE',
      changes: [change({ logicalResourceId: 'Vpc', replacement: 'False' })],
      parameters: {},
      tags: {},
      capabilities: [],
    };
    const diff = buildStackDiff({
      stackKey: makeStackKey('network.yaml', REGION),
      region: REGION,
      stackName: 'prod-network',
      operation: 'update',
      detail,
      noEchoParams: [],
    });

    expect(diff.resources[0].replacement).toBe(false);
  });

  it('FR-3-2: renderText は置換対象を警告として強調表示する([REPLACEMENT] 等のフラグを含む)', () => {
    const detail: ChangeSetDetail = {
      status: 'CREATE_COMPLETE',
      changes: [change({ logicalResourceId: 'Vpc', replacement: 'True' })],
      parameters: {},
      tags: {},
      capabilities: [],
    };
    const diff = buildStackDiff({
      stackKey: makeStackKey('network.yaml', REGION),
      region: REGION,
      stackName: 'prod-network',
      operation: 'update',
      detail,
      noEchoParams: [],
    });

    const text = renderText(report([diff]));
    expect(text).toMatch(/REPLACEMENT/i);
    // 警告セクションにも置換対象が明示される。
    expect(diff.warnings.some((w) => w.includes('Vpc'))).toBe(true);
  });

  it('FR-3-2: renderJson は置換対象に replacement: true フラグを含める', () => {
    const detail: ChangeSetDetail = {
      status: 'CREATE_COMPLETE',
      changes: [change({ logicalResourceId: 'Vpc', replacement: 'True' })],
      parameters: {},
      tags: {},
      capabilities: [],
    };
    const diff = buildStackDiff({
      stackKey: makeStackKey('network.yaml', REGION),
      region: REGION,
      stackName: 'prod-network',
      operation: 'update',
      detail,
      noEchoParams: [],
    });

    const parsed = JSON.parse(renderJson(report([diff])));
    expect(parsed.diffs[0].resources[0].replacement).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FR-3-3: テキストに加え JSON を選択できる(機械可読・スキーマ検証)
// ---------------------------------------------------------------------------

const ResourceDiffLineSchema = z.object({
  action: z.string(),
  logicalResourceId: z.string(),
  resourceType: z.string(),
  replacement: z.boolean(),
  replacementType: z.string().optional(),
  physicalResourceId: z.string().optional(),
  scope: z.array(z.string()),
  changedProperties: z.array(z.string()),
  details: z.array(z.unknown()),
  beforeContext: z.string().optional(),
  afterContext: z.string().optional(),
});

const StackDiffSchema = z.object({
  stackKey: z.string(),
  region: z.string(),
  stackName: z.string(),
  operation: z.enum(['create', 'update', 'delete', 'no-change']),
  resources: z.array(ResourceDiffLineSchema),
  warnings: z.array(z.string()),
});

const DeployReportJsonSchema = z.object({
  connection: z.object({ accountId: z.string(), regions: z.array(z.string()) }),
  diffs: z.array(StackDiffSchema),
  events: z.array(z.unknown()).optional(),
  result: z.unknown().optional(),
});

describe('FR-3-3: テキスト・JSON 両方の出力を選択できる', () => {
  it('FR-3-3: renderText は人間可読な文字列を返す', () => {
    const diff = buildStackDiff({
      stackKey: makeStackKey('network.yaml', REGION),
      region: REGION,
      stackName: 'prod-network',
      operation: 'create',
      noEchoParams: [],
    });
    const text = renderText(report([diff]));
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });

  it('FR-3-3: renderJson は zod スキーマで自己検証できる機械可読 JSON を返す', () => {
    const diff = buildStackDiff({
      stackKey: makeStackKey('network.yaml', REGION),
      region: REGION,
      stackName: 'prod-network',
      operation: 'create',
      noEchoParams: [],
    });
    const json = renderJson(report([diff]));
    const parsed = JSON.parse(json);
    const result = DeployReportJsonSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });
});

describe('FR-3-4 / FR-3-5: text 差分の ANSI カラー', () => {
  const colorDiff = buildStackDiff({
    stackKey: makeStackKey('network.yaml', REGION),
    region: REGION,
    stackName: 'prod-network',
    operation: 'update',
    detail: {
      status: 'CREATE_COMPLETE',
      changes: [
        change({
          logicalResourceId: 'AddedSubnet',
          action: 'Add',
          resourceType: 'AWS::EC2::Subnet',
        }),
        change({
          logicalResourceId: 'ModifiedVpc',
          action: 'Modify',
          replacement: 'True',
        }),
        change({
          logicalResourceId: 'RemovedRoute',
          action: 'Remove',
          resourceType: 'AWS::EC2::Route',
        }),
      ],
      parameters: {},
      tags: {},
      capabilities: [],
    },
    noEchoParams: [],
  });

  it('FR-3-4: Add=緑・Modify=黄・Remove=赤・Replacement=太字赤の ANSI SGR を付与する', () => {
    const text = renderText(report([colorDiff]), { color: true });

    expect(text).toContain('\x1b[32m+ Add');
    expect(text).toContain('\x1b[33m~ Modify');
    expect(text).toContain('\x1b[31m- Remove');
    expect(text).toContain('\x1b[1;31m [REPLACEMENT]\x1b[0m');
  });

  it('FR-3-5: color=false では警告・結果を含むすべての ANSI 装飾を無効化する', () => {
    const text = renderText(
      report([colorDiff], {
        result: {
          stacks: [
            {
              stackKey: makeStackKey('network.yaml', REGION),
              region: REGION,
              stackName: 'prod-network',
              outcome: 'failed',
            },
          ],
        },
      }),
      { color: false },
    );

    expect(text).not.toContain('\x1b[');
    expect(text).toContain('+ Add');
    expect(text).toContain('~ Modify');
    expect(text).toContain('- Remove');
    expect(text).toContain('[REPLACEMENT]');
  });
});

// ---------------------------------------------------------------------------
// NFR-4: NoEcho 値をマスク(差分・ログ・JSON のすべてで実値が現れない)
// ---------------------------------------------------------------------------

describe('NFR-4: NoEcho マスク', () => {
  const SECRET = 'S3cr3t-Raw-Value-Do-Not-Leak';

  it('NFR-4: maskNoEcho は NoEcho キーの値のみ **** に置換する', () => {
    const masked = maskNoEcho({ DbPassword: SECRET, Other: 'plain' }, [
      'DbPassword',
    ]);
    expect(masked).toEqual({ DbPassword: '****', Other: 'plain' });
  });

  it('NFR-4: maskNoEcho は noEchoParams に無いキーを変更しない', () => {
    const masked = maskNoEcho({ A: '1', B: '2' }, []);
    expect(masked).toEqual({ A: '1', B: '2' });
  });

  it('NFR-4: buildStackDiff は ChangeSetDetail.parameters の実値を StackDiff に持ち込まない(構造的保証)', () => {
    const detail: ChangeSetDetail = {
      status: 'CREATE_COMPLETE',
      changes: [change({ logicalResourceId: 'Db' })],
      parameters: { DbPassword: SECRET },
      tags: {},
      capabilities: [],
    };
    const diff = buildStackDiff({
      stackKey: makeStackKey('database.yaml', REGION),
      region: REGION,
      stackName: 'prod-db',
      operation: 'update',
      detail,
      noEchoParams: ['DbPassword'],
    });

    expect(JSON.stringify(diff)).not.toContain(SECRET);
  });

  it('NFR-4: renderText・renderJson のいずれにも NoEcho 実値が一切現れない', () => {
    const detail: ChangeSetDetail = {
      status: 'CREATE_COMPLETE',
      changes: [
        change({
          logicalResourceId: 'Db',
          details: [
            {
              target: { attribute: 'Properties', name: 'MasterUserPassword' },
              causingEntity: 'DbPassword',
            },
          ],
        }),
      ],
      parameters: { DbPassword: SECRET },
      tags: {},
      capabilities: [],
    };
    const diff = buildStackDiff({
      stackKey: makeStackKey('database.yaml', REGION),
      region: REGION,
      stackName: 'prod-db',
      operation: 'update',
      detail,
      noEchoParams: ['DbPassword'],
    });
    const rep = report([diff]);

    expect(renderText(rep)).not.toContain(SECRET);
    expect(renderJson(rep)).not.toContain(SECRET);
  });

  it('NFR-4(値差分): NoEcho 由来の before/after と context を text / JSON 格納前にマスクする', () => {
    const OLD_SECRET = 'old';
    const detail: ChangeSetDetail = {
      status: 'CREATE_COMPLETE',
      changes: [
        change({
          logicalResourceId: 'Db',
          beforeContext: `{"password":"${OLD_SECRET}"}`,
          afterContext: `{"password":"next-${SECRET}"}`,
          details: [
            {
              target: {
                attribute: 'Properties',
                name: 'MasterUserPassword',
                beforeValue: OLD_SECRET,
                afterValue: `next-${SECRET}`,
              },
              causingEntity: 'DbPassword',
            },
          ],
        }),
      ],
      parameters: { DbPassword: SECRET },
      tags: {},
      capabilities: [],
    };
    const diff = buildStackDiff({
      stackKey: makeStackKey('database.yaml', REGION),
      region: REGION,
      stackName: 'prod-db',
      operation: 'update',
      detail,
      noEchoParams: ['DbPassword'],
      redact: (text) => text.replaceAll(SECRET, '****'),
    });
    const rep = report([diff]);

    expect(diff.resources[0].details[0].target).toMatchObject({
      beforeValue: '****',
      afterValue: '****',
    });
    expect(diff.resources[0]).toMatchObject({
      beforeContext: '****',
      afterContext: '****',
    });
    expect(renderText(rep)).not.toContain(OLD_SECRET);
    expect(renderJson(rep)).not.toContain(OLD_SECRET);
    expect(renderText(rep)).not.toContain(SECRET);
    expect(renderJson(rep)).not.toContain(SECRET);
    expect(renderJson(rep)).toContain('****');
  });
});

// ---------------------------------------------------------------------------
// FR-13-7: 出力に対象リージョンを明示(スタックキーにリージョン込み)
// ---------------------------------------------------------------------------

describe('FR-13-7: 出力へのリージョン明示(スタックキー込み)', () => {
  it('FR-13-7: StackDiff にリージョン込みのスタックキーが含まれる', () => {
    const diff = buildStackDiff({
      stackKey: makeStackKey('network.yaml', REGION),
      region: REGION,
      stackName: 'prod-network',
      operation: 'create',
      noEchoParams: [],
    });
    expect(diff.stackKey).toBe(`network.yaml@${REGION}`);
    expect(diff.region).toBe(REGION);
  });

  it('FR-13-7: renderText / renderJson の両方にスタックキー(リージョン込み)が現れる', () => {
    const diff = buildStackDiff({
      stackKey: makeStackKey('network.yaml', REGION),
      region: REGION,
      stackName: 'prod-network',
      operation: 'create',
      noEchoParams: [],
    });
    const rep = report([diff]);
    expect(renderText(rep)).toContain(`network.yaml@${REGION}`);
    const parsed = JSON.parse(renderJson(rep));
    expect(parsed.diffs[0].stackKey).toBe(`network.yaml@${REGION}`);
  });

  it('FR-13-7: 複数リージョンの StackDiff がそれぞれのスタックキーで区別される', () => {
    const diffA = buildStackDiff({
      stackKey: makeStackKey('network.yaml', REGION),
      region: REGION,
      stackName: 'prod-network',
      operation: 'create',
      noEchoParams: [],
    });
    const diffB = buildStackDiff({
      stackKey: makeStackKey('network.yaml', REGION_B),
      region: REGION_B,
      stackName: 'prod-network',
      operation: 'create',
      noEchoParams: [],
    });
    const text = renderText(
      report([diffA, diffB], {
        connection: connection({ regions: [REGION, REGION_B] }),
      }),
    );
    expect(text).toContain(`network.yaml@${REGION}`);
    expect(text).toContain(`network.yaml@${REGION_B}`);
  });
});

// ---------------------------------------------------------------------------
// FR-8-3: 依存マッピングをテキストツリー / JSON で出力
// ---------------------------------------------------------------------------

describe('FR-8-3: 依存マッピングの出力', () => {
  function makeGraphs(): Map<string, RegionGraph> {
    const network = makeStackKey('network.yaml', REGION);
    const database = makeStackKey('database.yaml', REGION);
    const graph: RegionGraph = {
      region: REGION,
      nodes: [network, database],
      edges: [{ from: network, to: database }],
    };
    return new Map([[REGION, graph]]);
  }

  it('FR-8-3/FR-8-6: renderGraphText は依存関係をリージョンごとのレベル(Lv0, Lv1, ...)として出力する', () => {
    const text = renderGraphText(makeGraphs());
    const lv0Index = text.indexOf('Lv0:');
    const lv1Index = text.indexOf('Lv1:');
    expect(lv0Index).toBeGreaterThanOrEqual(0);
    expect(lv1Index).toBeGreaterThan(lv0Index);

    // network は依存元(Lv0)、database はそれに依存する側(Lv1)。
    const networkIndex = text.indexOf('network.yaml@' + REGION);
    const databaseIndex = text.indexOf('database.yaml@' + REGION);
    expect(networkIndex).toBeGreaterThan(lv0Index);
    expect(networkIndex).toBeLessThan(lv1Index);
    expect(databaseIndex).toBeGreaterThan(lv1Index);
  });

  it('FR-8-6: diamond 依存でも依存関係の記述は重複しない(db1/db2 は同一 Lv1 にまとまる)', () => {
    const network = makeStackKey('network.yaml', REGION);
    const db1 = makeStackKey('db1.yaml', REGION);
    const db2 = makeStackKey('db2.yaml', REGION);
    const app = makeStackKey('app.yaml', REGION);
    const graph: RegionGraph = {
      region: REGION,
      nodes: [network, db1, db2, app],
      edges: [
        { from: network, to: db1 },
        { from: network, to: db2 },
        { from: db1, to: app },
        { from: db2, to: app },
      ],
    };

    const text = renderGraphText(new Map([[REGION, graph]]));

    // db1/db2 はそれぞれちょうど 1 回だけ出現する(下流参照ごとに重複しない)。
    const countOccurrences = (needle: string): number =>
      text.split(needle).length - 1;
    expect(countOccurrences('db1.yaml@' + REGION)).toBe(1);
    expect(countOccurrences('db2.yaml@' + REGION)).toBe(1);

    const lv1Index = text.indexOf('Lv1:');
    const lv2Index = text.indexOf('Lv2:');
    expect(lv1Index).toBeGreaterThanOrEqual(0);
    expect(lv2Index).toBeGreaterThan(lv1Index);
    const db1Index = text.indexOf('db1.yaml@' + REGION);
    const db2Index = text.indexOf('db2.yaml@' + REGION);
    expect(db1Index).toBeGreaterThan(lv1Index);
    expect(db1Index).toBeLessThan(lv2Index);
    expect(db2Index).toBeGreaterThan(lv1Index);
    expect(db2Index).toBeLessThan(lv2Index);
  });

  it('FR-8-3: renderGraphJson はリージョンごとのノード・辺を機械可読 JSON として出力する', () => {
    const json = renderGraphJson(makeGraphs());
    const parsed = JSON.parse(json);
    expect(parsed.regions).toHaveLength(1);
    expect(parsed.regions[0].region).toBe(REGION);
    expect(parsed.regions[0].nodes).toEqual([
      'network.yaml@' + REGION,
      'database.yaml@' + REGION,
    ]);
    expect(parsed.regions[0].edges).toEqual([
      { from: 'network.yaml@' + REGION, to: 'database.yaml@' + REGION },
    ]);
  });

  it('FR-8-6: renderGraphJson には levels キーは追加されない(JSON 契約は不変)', () => {
    const network = makeStackKey('network.yaml', REGION);
    const db1 = makeStackKey('db1.yaml', REGION);
    const db2 = makeStackKey('db2.yaml', REGION);
    const app = makeStackKey('app.yaml', REGION);
    const graph: RegionGraph = {
      region: REGION,
      nodes: [network, db1, db2, app],
      edges: [
        { from: network, to: db1 },
        { from: network, to: db2 },
        { from: db1, to: app },
        { from: db2, to: app },
      ],
    };

    const parsed = JSON.parse(renderGraphJson(new Map([[REGION, graph]])));

    expect(Object.keys(parsed)).toEqual(['regions']);
    expect(Object.keys(parsed.regions[0])).toEqual([
      'region',
      'nodes',
      'edges',
    ]);
    expect(parsed.regions[0]).not.toHaveProperty('levels');
    expect(JSON.stringify(parsed)).not.toContain('levels');
  });

  it('FR-8-3/FR-8-6: renderGraphText / renderGraphJson は複数リージョンを独立に出力する', () => {
    const graphs = makeGraphs();
    const soloKey = makeStackKey('solo.yaml', REGION_B);
    graphs.set(REGION_B, { region: REGION_B, nodes: [soloKey], edges: [] });

    const text = renderGraphText(graphs);
    expect(text).toContain(REGION_B);
    expect(text).toContain('solo.yaml@' + REGION_B);

    const parsed = JSON.parse(renderGraphJson(graphs));
    expect(parsed.regions).toHaveLength(2);
    expect(parsed.regions.map((r: { region: string }) => r.region)).toEqual([
      REGION,
      REGION_B,
    ]);
  });

  it('FR-8-6: 各リージョンのレベル見出しは Lv0 から独立に再開する', () => {
    const graphs = makeGraphs();
    const soloKey = makeStackKey('solo.yaml', REGION_B);
    graphs.set(REGION_B, { region: REGION_B, nodes: [soloKey], edges: [] });

    const text = renderGraphText(graphs);

    // REGION ブロック: Lv0(network) → Lv1(database)。
    const regionAHeaderIndex = text.indexOf(`region: ${REGION}\n`);
    const regionBHeaderIndex = text.indexOf(`region: ${REGION_B}\n`);
    expect(regionAHeaderIndex).toBeGreaterThanOrEqual(0);
    expect(regionBHeaderIndex).toBeGreaterThan(regionAHeaderIndex);

    const regionABlock = text.slice(regionAHeaderIndex, regionBHeaderIndex);
    const regionBBlock = text.slice(regionBHeaderIndex);

    expect(regionABlock).toContain('Lv0:');
    expect(regionABlock).toContain('Lv1:');
    // REGION_B は独立ノードのみなので Lv0 のみで再開する(Lv1 は存在しない)。
    expect(regionBBlock).toContain('Lv0:');
    expect(regionBBlock).not.toContain('Lv1:');
  });
});

// ---------------------------------------------------------------------------
// FR-7-8(出力): 接続先を出力の先頭に含める。クレデンシャルは含めない
// ---------------------------------------------------------------------------

describe('FR-7-8(出力): 接続先の先頭表示', () => {
  it('FR-7-8: renderText の先頭にアカウント ID・リージョンが含まれる', () => {
    const text = renderText(
      report([], {
        connection: connection({
          accountId: '999999999999',
          regions: [REGION, REGION_B],
        }),
      }),
    );
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    const headerBlock = lines.slice(0, 4).join('\n');
    expect(headerBlock).toContain('999999999999');
    expect(headerBlock).toContain(REGION);
    expect(headerBlock).toContain(REGION_B);
  });

  it('FR-7-8: renderJson の connection フィールドにアカウント ID・リージョンが含まれる', () => {
    const parsed = JSON.parse(
      renderJson(
        report([], {
          connection: connection({
            accountId: '999999999999',
            regions: [REGION],
          }),
        }),
      ),
    );
    expect(parsed.connection).toEqual({
      accountId: '999999999999',
      regions: [REGION],
    });
  });

  it('FR-7-8: DeployReport に不正に付与されたクレデンシャルらしき余剰フィールドは renderText / renderJson の出力に一切現れない', () => {
    const rep = report([]) as DeployReport & { credentials?: unknown };
    // usecase 側の実装ミスを想定した防御的テスト: 契約にない秘匿情報が紛れ込んでも出力に漏れないこと。
    rep.credentials = {
      accessKeyId: 'AKIAFAKEEXAMPLE',
      secretAccessKey: 'super-secret-leak-marker',
    };

    expect(renderText(rep)).not.toContain('super-secret-leak-marker');
    expect(renderJson(rep)).not.toContain('super-secret-leak-marker');
    expect(renderJson(rep)).not.toContain('AKIAFAKEEXAMPLE');
  });
});

describe('FR-4-3: rollback 結果の JSON 表現', () => {
  it('FR-4-3(JSON): failed StackResult の rolledBack true/false を boolean として保持する', () => {
    const parsed = JSON.parse(
      renderJson(
        report([], {
          result: {
            stacks: [
              {
                stackKey: `a.yaml@${REGION}`,
                region: REGION,
                stackName: 'A',
                outcome: 'failed',
                errorMessage: 'rollback observed',
                rolledBack: true,
              },
              {
                stackKey: `b.yaml@${REGION}`,
                region: REGION,
                stackName: 'B',
                outcome: 'failed',
                errorMessage: 'failed before rollback',
                rolledBack: false,
              },
            ],
          },
        }),
      ),
    );

    expect(
      parsed.result.stacks.map(
        (stack: { rolledBack: boolean }) => stack.rolledBack,
      ),
    ).toEqual([true, false]);
    expect(
      parsed.result.stacks.every(
        (stack: { rolledBack: unknown }) =>
          typeof stack.rolledBack === 'boolean',
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FR-5-7e: 削除プレビューの表示(レンダラ限定)
// ---------------------------------------------------------------------------

/** 差分行(見出しの次の行)を取り出す。 */
function diffLineOf(text: string, header: string): string {
  const lines = text.split('\n');
  const index = lines.findIndex((line) => line.startsWith(header));
  expect(index).toBeGreaterThanOrEqual(0);
  return lines[index + 1];
}

describe('FR-5-7e: 削除プレビューの表示', () => {
  /** 0 件注記(create/update) / 削除対象 / 真の変更なし が同一出力に混在する構成。 */
  function mixedReport(): DeployReport {
    const diffOf = (
      name: string,
      operation: 'update' | 'delete' | 'no-change',
    ): StackDiff =>
      buildStackDiff({
        stackKey: makeStackKey(`${name}.yaml`, REGION),
        region: REGION,
        stackName: name,
        operation,
        noEchoParams: [],
      });
    return report([
      diffOf('resourceless', 'update'),
      diffOf('old', 'delete'),
      diffOf('same', 'no-change'),
    ]);
  }

  it('FR-5-7e: delete の差分行が (変更なし) でも 0 件注記でもない、スタック全体が削除対象と分かる文言になる(text 差分・承認要約の両方)', () => {
    const deployReport = mixedReport();
    const text = renderText(deployReport, { color: false });

    const resourcelessLine = diffLineOf(
      text,
      `[update] resourceless.yaml@${REGION}`,
    );
    const deleteLine = diffLineOf(text, `[delete] old.yaml@${REGION}`);
    const noChangeLine = diffLineOf(text, `[no-change] same.yaml@${REGION}`);

    // 削除対象はスタック全体が消えることが分かる表示になる。
    expect(deleteLine).toContain('targeted for deletion');
    // 3 者は互いに区別できる(同一出力に混在しうる)。
    expect(new Set([resourcelessLine, deleteLine, noChangeLine]).size).toBe(3);
    expect(deleteLine).not.toBe('  (no changes)');
    expect(deleteLine).not.toContain('0 CloudFormation resource diffs');
    // 回帰防止: 真の変更なしは従来どおりの表示のままである。
    expect(noChangeLine).toBe('  (no changes)');
    expect(resourcelessLine).toContain('0 CloudFormation resource diffs');

    // 差分行は削除対象であることに留め、実行の可否を断定しない(--allow-delete を
    // renderText は知らない)。実行するか警告に留まるかは承認要約の見出し注記
    // (FR-5-6e)と warnings が担う。
    expect(deleteLine).not.toContain('will be deleted');

    // 承認要約でも同一の差分行を共有する(allow-delete の有無で変わらない)。
    for (const allowDelete of [true, false]) {
      const summaryText = renderApprovalSummary(
        {
          connection: deployReport.connection,
          diffs: deployReport.diffs,
          summary: buildApprovalSummary(deployReport.diffs),
          allowDelete,
        },
        { color: false },
      );
      expect(diffLineOf(summaryText, `[delete] old.yaml@${REGION}`)).toBe(
        deleteLine,
      );
      // 削除は 0 件注記の集計対象にならない(FR-5-7c は維持)。
      expect(summaryText).toContain(
        'Note: 1 create/update target(s) have 0 CloudFormation resource diffs',
      );
    }
  });

  it('FR-5-7e: 削除対象の JSON は operation delete・resources 空・warnings 不変のままで text 出力だけが変わる', () => {
    const diff = buildStackDiff({
      stackKey: makeStackKey('old.yaml', REGION),
      region: REGION,
      stackName: 'old',
      operation: 'delete',
      noEchoParams: [],
    });
    // deploy が削除対象へ積む警告(--allow-delete 未指定時)。レンダラはこれを
    // 増減させてはならない。
    diff.warnings.push(
      'Marked for deletion. --allow-delete is required to actually delete it',
    );
    const deployReport = report([diff]);
    const before = structuredClone(deployReport);

    const json = JSON.parse(renderJson(deployReport)) as {
      diffs: Array<{
        operation: string;
        resources: unknown[];
        warnings: string[];
      }>;
    };

    // FR-5-7d と同一の制約: 判別はレンダラ限定でデータ側は不変(FR-5-16)。
    expect(json.diffs[0].operation).toBe('delete');
    expect(json.diffs[0].resources).toEqual([]);
    expect(json.diffs[0].warnings).toEqual([
      'Marked for deletion. --allow-delete is required to actually delete it',
    ]);
    // JSON には削除プレビューの表示文言が一切現れない。
    expect(JSON.stringify(json)).not.toContain(
      'entire stack is targeted for deletion',
    );
    // text 出力だけが変わる。
    const text = renderText(deployReport, { color: false });
    expect(diffLineOf(text, `[delete] old.yaml@${REGION}`)).toContain(
      'targeted for deletion',
    );
    // レンダリングは DeployReport を書き換えない。
    expect(deployReport).toEqual(before);
  });
});
