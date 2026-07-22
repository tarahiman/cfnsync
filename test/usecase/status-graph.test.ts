import { describe, expect, it } from 'vitest';
import type { CfnSyncConfig } from '../../src/core/config.js';
import { createInitialState } from '../../src/core/state.js';
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
});
