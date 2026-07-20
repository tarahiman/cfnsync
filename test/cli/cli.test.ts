import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CfnSyncConfig } from '../../src/core/config.js';
import { createInitialState } from '../../src/core/state.js';
import type { CloudFormationGateway, StateBackend, StsGateway } from '../../src/ports/index.js';
import type { DeployReport } from '../../src/report/index.js';
import { createCliProgram, runCli, type CliDependencies } from '../../src/cli/index.js';

const config: CfnSyncConfig = {
  version: 1,
  defaultRegion: 'ap-northeast-1',
  state: { backend: 'local' },
  stacks: {
    'app.yaml': {
      stackName: 'app',
      parameters: {},
      tags: {},
      capabilities: [],
      dependsOn: [],
      regionOverrides: {},
    },
  },
};

const report: DeployReport = {
  connection: { accountId: '123456789012', regions: ['ap-northeast-1'] },
  diffs: [],
};

function backend(): StateBackend {
  return {
    load: vi.fn(async () => ({ state: createInitialState(), version: { generation: 0 } })),
    save: vi.fn(), acquireLock: vi.fn(), verifyLock: vi.fn(), releaseLock: vi.fn(),
    readLock: vi.fn(), forceUnlock: vi.fn(), stateId: vi.fn(() => 'state-id'),
  } as unknown as StateBackend;
}

function gateway(): CloudFormationGateway {
  return {} as CloudFormationGateway;
}

function dependencies(overrides: Partial<CliDependencies> = {}): CliDependencies {
  return {
    loadConfig: vi.fn(() => config),
    readTemplates: vi.fn(() => new Map([['app.yaml', 'Resources: {}\n']])),
    createBackend: vi.fn(() => backend()),
    createCfn: vi.fn(() => gateway()),
    createSts: vi.fn(() => ({ getCallerIdentity: vi.fn() }) as unknown as StsGateway),
    deploy: vi.fn(async () => ({ exitCode: 0 as const, report, hasDiff: false })),
    runImport: vi.fn(async () => ({
      exitCode: 0 as const,
      report: { connection: report.connection, stacks: [], configWritten: false, stateSaved: false, warnings: [] },
    })),
    forceUnlock: vi.fn(async () => ({ exitCode: 0 as const, released: true, message: 'ロックを解除しました。' })),
    ...overrides,
  };
}

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    io: { stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; } },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('T-19 cli', () => {
  it('FR-12-1: 6 サブコマンドを定義する', () => {
    const names = createCliProgram(dependencies()).commands.map((command) => command.name());
    expect(names).toEqual(['status', 'plan', 'deploy', 'graph', 'import', 'force-unlock']);
  });

  it.each([
    ['plan 差分あり', 2, true, 2],
    ['plan 差分なし', 0, false, 0],
  ] as const)('FR-12-2: %s は exit %i', async (_label, usecaseCode, hasDiff, expected) => {
    const deps = dependencies({ deploy: vi.fn(async () => ({ exitCode: usecaseCode, report, hasDiff })) });
    expect(await runCli(['plan'], { deps })).toBe(expected);
    expect(deps.deploy).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ dryRun: true }) }));
  });

  it('FR-12-2: 検証エラーは exit 1', async () => {
    const out = capture();
    const deps = dependencies({ loadConfig: vi.fn(() => { throw new Error('invalid config'); }) });
    expect(await runCli(['status'], { deps, io: out.io })).toBe(1);
    expect(out.stderr()).toContain('invalid config');
  });

  it.each([['成功', 0], ['失敗', 1]] as const)('FR-12-2: deploy %s は exit %i', async (_label, code) => {
    const deps = dependencies({ deploy: vi.fn(async () => ({ exitCode: code, report, hasDiff: false })) });
    expect(await runCli(['deploy'], { deps })).toBe(code);
  });

  it('FR-12-3: 非 TTY は --confirm 指定時もプロンプトなしで完走する', async () => {
    const prompt = vi.fn(async () => true);
    expect(await runCli(['deploy', '--confirm'], { deps: dependencies(), isTTY: false, prompt })).toBe(0);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('FR-7-1〜3: CLI の profile/region を AWS 依存へ伝播する', async () => {
    const deps = dependencies();
    (deps.deploy as ReturnType<typeof vi.fn>).mockImplementation(async (input) => {
      input.deps.cfnFactory(input.config.defaultRegion);
      return { exitCode: 0, report, hasDiff: false };
    });
    await runCli(['deploy', '--profile', 'work', '--region', 'us-west-2'], { deps });
    expect(deps.createCfn).toHaveBeenCalledWith({ region: 'us-west-2', profile: 'work' });
    expect(deps.createSts).toHaveBeenCalledWith({ region: 'us-west-2', profile: 'work' });
    expect(deps.loadConfig).toHaveBeenCalledWith('./cfnsync.yaml');
  });

  it('FR-7-1〜3: AWS_PROFILE/AWS_REGION を明示オプション未指定時に伝播する', async () => {
    vi.stubEnv('AWS_PROFILE', 'environment-profile');
    vi.stubEnv('AWS_REGION', 'eu-west-1');
    const deps = dependencies();
    (deps.deploy as ReturnType<typeof vi.fn>).mockImplementation(async (input) => {
      input.deps.cfnFactory(input.config.defaultRegion);
      return { exitCode: 0, report, hasDiff: false };
    });
    await runCli(['deploy'], { deps });
    expect(deps.createCfn).toHaveBeenCalledWith({ region: 'eu-west-1', profile: 'environment-profile' });
    expect(deps.createSts).toHaveBeenCalledWith({ region: 'eu-west-1', profile: 'environment-profile' });
  });

  it('FR-5-2: --confirm 指定かつ TTY の場合だけ確認する', async () => {
    const prompt = vi.fn(async () => true);
    await runCli(['deploy'], { deps: dependencies(), isTTY: true, prompt });
    await runCli(['deploy', '--confirm'], { deps: dependencies(), isTTY: true, prompt });
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('FR-5-2: deploy オプションを usecase に渡す', async () => {
    const deps = dependencies();
    await runCli(['deploy', '--dry-run', '--allow-delete', '--on-failure', 'continue'], { deps });
    expect(deps.deploy).toHaveBeenCalledWith(expect.objectContaining({
      options: { dryRun: true, allowDelete: true, onFailure: 'continue' },
    }));
  });

  it('FR-12-1: import と force-unlock を対応 usecase に渡す', async () => {
    const deps = dependencies();
    await runCli(['import', '--reconcile', 'remote', '--write-template'], { deps });
    await runCli(['force-unlock', 'run-123'], { deps });
    expect(deps.runImport).toHaveBeenCalledWith(expect.objectContaining({
      options: { reconcile: 'remote', writeTemplate: true },
    }));
    expect(deps.forceUnlock).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-123' }));
  });

  it('NFR-5: status はローカルのみで変更検知し AWS factory を呼ばない', async () => {
    const deps = dependencies();
    const out = capture();
    expect(await runCli(['status', '--output', 'json'], { deps, io: out.io })).toBe(0);
    expect(JSON.parse(out.stdout()).entries[0].changeType).toBe('added');
    expect(deps.createCfn).not.toHaveBeenCalled();
    expect(deps.createSts).not.toHaveBeenCalled();
  });

  it('NFR-5: graph はテンプレート解析のみで AWS factory を呼ばない', async () => {
    const deps = dependencies();
    const out = capture();
    expect(await runCli(['graph', '--output', 'json'], { deps, io: out.io })).toBe(0);
    expect(JSON.parse(out.stdout()).regions[0].nodes).toEqual(['app.yaml@ap-northeast-1']);
    expect(deps.createCfn).not.toHaveBeenCalled();
    expect(deps.createSts).not.toHaveBeenCalled();
  });

  it('FR-8-4 / §9: graph の循環は診断を stderr に出して exit 1', async () => {
    const cyclic: CfnSyncConfig = {
      ...config,
      stacks: {
        'a.yaml': { ...config.stacks['app.yaml'], stackName: 'a', dependsOn: ['b.yaml'] },
        'b.yaml': { ...config.stacks['app.yaml'], stackName: 'b', dependsOn: ['a.yaml'] },
      },
    };
    const deps = dependencies({
      loadConfig: vi.fn(() => cyclic),
      readTemplates: vi.fn(() => new Map([['a.yaml', 'Resources: {}'], ['b.yaml', 'Resources: {}']])),
    });
    const out = capture();
    expect(await runCli(['graph'], { deps, io: out.io })).toBe(1);
    expect(out.stderr()).toContain('a.yaml@ap-northeast-1');
    expect(out.stdout()).toBe('');
  });

  it('NFR-1: 結果は stdout、進捗イベントは stderr に分離する', async () => {
    const deps = dependencies({
      deploy: vi.fn(async (input) => {
        input.deps.onEvent?.({
          stackKey: 'app.yaml@ap-northeast-1', region: 'ap-northeast-1', timestamp: '2026-01-01T00:00:00Z',
          logicalResourceId: 'App', resourceType: 'AWS::S3::Bucket', resourceStatus: 'CREATE_IN_PROGRESS',
        });
        return { exitCode: 0 as const, report, hasDiff: false };
      }),
    });
    const out = capture();
    await runCli(['deploy', '--output', 'json'], { deps, io: out.io });
    expect(JSON.parse(out.stdout()).connection.accountId).toBe('123456789012');
    expect(out.stderr()).toContain('CREATE_IN_PROGRESS');
    expect(out.stdout()).not.toContain('CREATE_IN_PROGRESS');
  });
});
