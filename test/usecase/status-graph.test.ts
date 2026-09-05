import { describe, expect, it } from 'vitest';
import type { CfnSyncConfig } from '../../src/core/config.js';
import {
  createInitialState,
  upsertPendingDeletion,
} from '../../src/core/state.js';
import { getGraph } from '../../src/usecase/graph.js';
import { getStatus } from '../../src/usecase/status.js';
import { FakeStateBackend } from './fakes.js';

const config: CfnSyncConfig = {
  version: 1,
  defaultRegion: 'ap-northeast-1',
  defaultTags: {},
  state: { backend: 'local' },
  stacks: {
    'network.yaml': {
      stackName: 'network',
      parameters: {},
      tags: {},
      capabilities: [],
      dependsOn: [],
      regionOverrides: {},
    },
    'app.yaml': {
      stackName: 'app',
      parameters: {},
      tags: {},
      capabilities: [],
      dependsOn: ['network.yaml'],
      regionOverrides: {},
    },
  },
};

const templates = new Map([
  ['network.yaml', 'Resources: {}\n'],
  ['app.yaml', 'Resources: {}\n'],
]);

describe('usecase/status・graph', () => {
  it('NFR-5: status は state backend の読取とローカル変更分類だけを行う', async () => {
    const backend = new FakeStateBackend([], createInitialState());
    const result = await getStatus({ config, templates, backend });

    expect(result.entries.map((entry) => entry.changeType)).toEqual([
      'added',
      'added',
    ]);
    expect(backend.calls.map((call) => call.method)).toEqual(['load']);
  });

  it('FR-1-23: status は削除待ちを deleted 分類として、スタックキーと旧スタック名つきで提示する', async () => {
    const state = upsertPendingDeletion(
      createInitialState(),
      'network-old@ap-northeast-1',
      {
        stackName: 'network-old',
        stackId: null,
        region: 'ap-northeast-1',
        exports: [],
        imports: [],
        dependsOn: [],
        dependencyAnalysisIncomplete: false,
        originStackKey: 'network.yaml@ap-northeast-1',
        reason: 'rename',
        recordedAt: '2026-07-19T00:00:00.000Z',
      },
    );
    const backend = new FakeStateBackend([], state);
    const result = await getStatus({ config, templates, backend });

    const pending = result.entries.find((entry) =>
      entry.stackKey.startsWith('cfnsync:pending/'),
    );
    expect(pending).toEqual({
      stackKey: 'cfnsync:pending/network-old@ap-northeast-1',
      region: 'ap-northeast-1',
      stackName: 'network-old',
      changeType: 'deleted',
    });
    // FR-1-23: 既存の status 出力 schema へフィールドを追加しない。
    expect(Object.keys(pending ?? {}).sort()).toEqual([
      'changeType',
      'region',
      'stackKey',
      'stackName',
    ]);
  });

  it('FR-6-12: graph は削除待ちを含めず、ステートを一切読まない', () => {
    const result = getGraph({ config, templates });
    const graph = result.graphs.get('ap-northeast-1');

    expect(graph?.nodes).toEqual([
      'network.yaml@ap-northeast-1',
      'app.yaml@ap-northeast-1',
    ]);
    expect(
      graph?.nodes.some((node) => node.startsWith('cfnsync:pending/')),
    ).toBe(false);
    // getGraph は StateBackend を引数に取らない(ステート非依存の構造的証跡)。
    expect(getGraph.length).toBe(1);
  });

  it('FR-8-2: graph は明示依存を含む構造化グラフを返す', () => {
    const result = getGraph({ config, templates });
    const graph = result.graphs.get('ap-northeast-1');

    expect(graph?.edges).toEqual([
      {
        from: 'network.yaml@ap-northeast-1',
        to: 'app.yaml@ap-northeast-1',
      },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('FR-8-7(解決): graph は共通 parameters < region override の実効値でリージョン別に依存名を解決する', () => {
    const regions = ['ap-northeast-1', 'us-east-1'];
    const dynamicConfig: CfnSyncConfig = {
      ...config,
      stacks: {
        'provider.yaml': {
          stackName: 'provider',
          regions,
          parameters: { Namespace: 'common' },
          tags: {},
          capabilities: [],
          dependsOn: [],
          regionOverrides: {
            'us-east-1': {
              parameters: { Namespace: 'east' },
              tags: {},
            },
          },
        },
        'consumer.yaml': {
          stackName: 'consumer',
          regions,
          parameters: { Namespace: 'common' },
          tags: {},
          capabilities: [],
          dependsOn: [],
          regionOverrides: {
            'us-east-1': {
              parameters: { Namespace: 'east' },
              tags: {},
            },
          },
        },
      },
    };
    const provider = `
Parameters:
  Namespace:
    Type: String
    Default: default
Resources: {}
Outputs:
  Shared:
    Value: value
    Export:
      Name: !Sub '\${Namespace}-\${AWS::Region}'
`;
    const consumer = `
Parameters:
  Namespace:
    Type: String
    Default: default
Resources:
  Consumer:
    Type: Custom::Consumer
    Properties:
      Value:
        Fn::ImportValue:
          Fn::Sub: '\${Namespace}-\${AWS::Region}'
`;

    const result = getGraph({
      config: dynamicConfig,
      templates: new Map([
        ['provider.yaml', provider],
        ['consumer.yaml', consumer],
      ]),
    });

    expect(result.graphs.get('ap-northeast-1')?.edges).toEqual([
      {
        from: 'provider.yaml@ap-northeast-1',
        to: 'consumer.yaml@ap-northeast-1',
      },
    ]);
    expect(result.graphs.get('us-east-1')?.edges).toEqual([
      {
        from: 'provider.yaml@us-east-1',
        to: 'consumer.yaml@us-east-1',
      },
    ]);
    expect(result.warnings).toEqual([]);
  });
});
