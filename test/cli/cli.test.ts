import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toAwsError } from '../../src/aws/errors.js';
import { defaultConfirm } from '../../src/cli/commands.js';
import { defaultCliDependencies } from '../../src/cli/dependencies.js';
import {
  type CliDependencies,
  createCliProgram,
  runCli,
} from '../../src/cli/index.js';
import { type CfnSyncConfig, validateConfig } from '../../src/core/config.js';
import { ConfigError } from '../../src/core/errors.js';
import { createInitialState } from '../../src/core/state.js';
import type {
  CloudFormationGateway,
  StateBackend,
  StsGateway,
} from '../../src/ports/index.js';
import type { ApprovalRequest, DeployReport } from '../../src/report/index.js';
import { getGraph } from '../../src/usecase/graph.js';
import { getStatus } from '../../src/usecase/status.js';

const config: CfnSyncConfig = {
  version: 1,
  defaultRegion: 'ap-northeast-1',
  defaultTags: {},
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

const colorReport: DeployReport = {
  connection: report.connection,
  diffs: [
    {
      stackKey: 'app.yaml@ap-northeast-1',
      region: 'ap-northeast-1',
      stackName: 'app',
      operation: 'update',
      resources: [
        {
          action: 'Add',
          logicalResourceId: 'AppBucket',
          resourceType: 'AWS::S3::Bucket',
          replacement: false,
          scope: ['Properties'],
          changedProperties: ['BucketName'],
          details: [],
          containsNoEchoChange: false,
        },
      ],
      warnings: [],
    },
  ],
};

/**
 * FR-3-7a: 承認要約で色付けされる要素をすべて含む承認要求。
 * Add=緑(32) / Modify=黄(33) / Remove=赤(31) / `[REPLACEMENT]`=太字赤(1;31) /
 * スタック警告=黄(33) / 置換の合計警告=太字赤(1;31)。
 */
const approvalRequest: ApprovalRequest = {
  connection: report.connection,
  diffs: [
    {
      stackKey: 'app.yaml@ap-northeast-1',
      region: 'ap-northeast-1',
      stackName: 'app',
      operation: 'update',
      resources: [
        {
          action: 'Add',
          logicalResourceId: 'AppBucket',
          resourceType: 'AWS::S3::Bucket',
          replacement: false,
          scope: ['Properties'],
          changedProperties: ['BucketName'],
          details: [],
          containsNoEchoChange: false,
        },
        {
          action: 'Modify',
          logicalResourceId: 'AppQueue',
          resourceType: 'AWS::SQS::Queue',
          replacement: true,
          scope: ['Properties'],
          changedProperties: ['QueueName'],
          details: [],
          containsNoEchoChange: false,
        },
        {
          action: 'Remove',
          logicalResourceId: 'AppTopic',
          resourceType: 'AWS::SNS::Topic',
          replacement: false,
          scope: ['Properties'],
          changedProperties: [],
          details: [],
          containsNoEchoChange: false,
        },
      ],
      warnings: ['AppQueue は置換されます'],
    },
  ],
  summary: {
    create: 0,
    update: 1,
    delete: 0,
    replacements: 1,
    resourcelessChanges: 0,
  },
  allowDelete: false,
};

function backend(): StateBackend {
  return {
    load: vi.fn(async () => ({
      state: createInitialState(),
      version: { backend: 'local', generation: 0 },
    })),
    save: vi.fn(),
    acquireLock: vi.fn(),
    verifyLock: vi.fn(),
    releaseLock: vi.fn(),
    readLock: vi.fn(),
    forceUnlock: vi.fn(),
    stateId: vi.fn(() => 'state-id'),
  } as unknown as StateBackend;
}

function gateway(): CloudFormationGateway {
  return {} as CloudFormationGateway;
}

function dependencies(
  overrides: Partial<CliDependencies> = {},
): CliDependencies {
  return {
    loadConfig: vi.fn(() => config),
    readTemplates: vi.fn(() => new Map([['app.yaml', 'Resources: {}\n']])),
    resolveTemplatePaths: vi.fn(
      () => new Map([['app.yaml', '/project/app.yaml']]),
    ),
    createBackend: vi.fn(() => backend()),
    createCfn: vi.fn(() => gateway()),
    createSts: vi.fn(
      () => ({ getCallerIdentity: vi.fn() }) as unknown as StsGateway,
    ),
    deploy: vi.fn(async () => ({
      exitCode: 0 as const,
      report,
      hasDiff: false,
    })),
    runImport: vi.fn(async () => ({
      exitCode: 0 as const,
      report: {
        connection: report.connection,
        stacks: [],
        configWritten: false,
        stateSaved: false,
        accountStateInitialized: false,
        importEntriesSaved: false,
        warnings: [],
      },
    })),
    forceUnlock: vi.fn(async () => ({
      exitCode: 0 as const,
      released: true,
      message: 'ロックを解除しました。',
    })),
    getStatus: vi.fn(getStatus),
    getGraph: vi.fn(getGraph),
    ...overrides,
  };
}

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

/** 承認プロンプトのキー入力。実制御文字は書かずエスケープで表す。 */
const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const ENTER = '\r';

/**
 * 実 TTY を模した入力ストリーム。readline がキー単位で解釈する terminal モードへ
 * 入るには `isTTY` と `setRawMode` が要る。readline が読み始めた時点で keys を
 * 一度だけ流すので、プロンプト出力との競合が起きない。
 */
function fakeTtyInput(keys: string[]): NodeJS.ReadableStream {
  let sent = false;
  const stream = new Readable({
    read() {
      if (sent) return;
      sent = true;
      for (const key of keys) this.push(key);
    },
  }) as Readable & { isTTY: boolean; setRawMode: (mode: boolean) => unknown };
  stream.isTTY = true;
  stream.setRawMode = () => stream;
  return stream as unknown as NodeJS.ReadableStream;
}

/**
 * 実 TTY を模した出力。readline は `output.isTTY` で terminal(キー単位の解釈)
 * モードを決めるため、Ctrl 系キーの検証にはこれが要る。実運用でも
 * `defaultConfirm` へ到達するのは stdin・stderr がともに TTY のときだけ
 * (FR-12-3b の非 TTY ガード)なので、terminal モードは production と同条件。
 */
function fakeTtyOutput(onWrite?: (chunk: string) => void) {
  let written = '';
  const sink = {
    write: (chunk: string) => {
      onWrite?.(chunk);
      written += chunk;
      return true;
    },
    isTTY: true,
    columns: 80,
    rows: 24,
    on: () => sink,
    off: () => sink,
    once: () => sink,
    emit: () => false,
    removeListener: () => sink,
    end: () => sink,
  };
  return {
    stream: sink as unknown as NodeJS.WritableStream,
    written: () => written,
  };
}

/** `defaultConfirm` を実 stdin / stderr に触れずに 1 回実行する。 */
async function confirmWith(
  keys: string[],
): Promise<{ answered: boolean; prompt: string }> {
  const output = fakeTtyOutput();
  const answered = await defaultConfirm(
    'Do you want to perform these actions?',
    { input: fakeTtyInput(keys), output: output.stream },
  );
  return {
    answered,
    prompt: stripVTControlCharacters(output.written()),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('T-19 cli', () => {
  it('FR-12-1: 6 サブコマンドを定義する', () => {
    const names = createCliProgram(dependencies()).commands.map((command) =>
      command.name(),
    );
    expect(names).toEqual([
      'status',
      'plan',
      'deploy',
      'graph',
      'import',
      'force-unlock',
    ]);
  });

  it.each([
    ['plan 差分あり', 2, true, 2],
    ['plan 差分なし', 0, false, 0],
  ] as const)('FR-12-2 / FR-5-20d: %s は exit %i', async (_label, usecaseCode, hasDiff, expected) => {
    const deps = dependencies({
      deploy: vi.fn(async () => ({ exitCode: usecaseCode, report, hasDiff })),
    });
    expect(await runCli(['plan'], { deps })).toBe(expected);
    expect(deps.deploy).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ dryRun: true }),
      }),
    );
  });

  it('FR-12-2: 検証エラーは exit 1', async () => {
    const out = capture();
    const deps = dependencies({
      loadConfig: vi.fn(() => {
        throw new Error('invalid config');
      }),
    });
    expect(await runCli(['status'], { deps, io: out.io })).toBe(1);
    expect(out.stderr()).toContain('invalid config');
  });

  it.each([
    ['成功', 0],
    ['失敗', 1],
  ] as const)('FR-12-2: deploy %s は exit %i', async (_label, code) => {
    const deps = dependencies({
      deploy: vi.fn(async () => ({ exitCode: code, report, hasDiff: false })),
    });
    expect(await runCli(['deploy', '--auto-approve'], { deps })).toBe(code);
  });

  it('FR-12-3a: 非 TTY で status / plan / graph / import / force-unlock / deploy --auto-approve が完走する', async () => {
    // FR-12-3b の非 TTY ガードが他コマンドを巻き込んでいないことの検証でもあるため、
    // 「exit 0」だけでなく「対応 usecase まで到達した」ことも観測する。
    const cases = [
      { name: 'status', argv: ['status'], usecase: 'getStatus' },
      { name: 'plan', argv: ['plan'], usecase: 'deploy' },
      { name: 'graph', argv: ['graph'], usecase: 'getGraph' },
      { name: 'import', argv: ['import'], usecase: 'runImport' },
      {
        name: 'force-unlock',
        argv: ['force-unlock', 'run-123'],
        usecase: 'forceUnlock',
      },
      {
        name: 'deploy --auto-approve',
        argv: ['deploy', '--auto-approve'],
        usecase: 'deploy',
      },
    ] as const;

    const observed: Record<string, unknown> = {};
    for (const testCase of cases) {
      const deps = dependencies();
      const prompt = vi.fn(async () => true);
      const out = capture();
      const exitCode = await runCli([...testCase.argv], {
        deps,
        io: out.io,
        env: {},
        isTTY: false,
        prompt,
      });
      const usecase = deps[testCase.usecase] as ReturnType<typeof vi.fn>;
      observed[testCase.name] = {
        exitCode,
        usecaseCalls: usecase.mock.calls.length,
        // 完走 = 結果を標準出力へ出し終えている(途中でガードに落ちていない)。
        producedResult: out.stdout().length > 0,
        errorDiagnostics: out.stderr(),
        prompted: prompt.mock.calls.length > 0,
      };
    }

    expect(observed).toEqual(
      Object.fromEntries(
        cases.map((testCase) => [
          testCase.name,
          {
            exitCode: 0,
            usecaseCalls: 1,
            producedResult: true,
            errorDiagnostics: '',
            // 非 TTY なのでどのコマンドもプロンプトへ到達してはならない。
            prompted: false,
          },
        ]),
      ),
    );
  });

  it('FR-12-3b: 非 TTY の deploy(--auto-approve なし)は AWS クライアントを 1 度も生成せず CliUsageError で exit 1', async () => {
    const deps = dependencies();
    const prompt = vi.fn(async () => true);
    const out = capture();

    expect(
      await runCli(['deploy'], { deps, io: out.io, isTTY: false, prompt }),
    ).toBe(1);
    // config 読込より前に CLI 境界で止めるため、usecase へも AWS クライアント生成へも到達しない。
    expect(deps.deploy).not.toHaveBeenCalled();
    expect(deps.createSts).not.toHaveBeenCalled();
    expect(deps.createCfn).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(out.stderr()).toContain('--auto-approve');
  });

  it('FR-12-3b(JSON): 非 TTY の deploy 拒否は stdout の単一 CliUsageError で exit 1', async () => {
    const out = capture();

    expect(
      await runCli(['deploy', '--output', 'json'], {
        deps: dependencies(),
        io: out.io,
        isTTY: false,
      }),
    ).toBe(1);
    expect(JSON.parse(out.stdout())).toEqual({
      ok: false,
      exitCode: 1,
      error: {
        type: 'CliUsageError',
        message: expect.stringContaining('--auto-approve'),
      },
    });
  });

  it('FR-12-3b / FR-5-9a: 非 TTY でも plan はエラーにならない', async () => {
    // 差分確認は plan だけが提供する(FR-5-20a)。deploy には非 TTY の例外経路がない。
    const deps = dependencies({
      deploy: vi.fn(async () => ({
        exitCode: 2 as const,
        report,
        hasDiff: true,
      })),
    });
    expect(await runCli(['plan'], { deps, isTTY: false })).toBe(2);
    expect(deps.deploy).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ dryRun: true }),
      }),
    );
  });

  it('FR-12-3c: 変更が 1 件もない非 TTY の deploy も --auto-approve なしでは CliUsageError で exit 1', async () => {
    // 変更 0 件(差分なし)を返す usecase を用意しても、判定は変更検知より前に
    // 行われるため結果は変わらない。
    const deps = dependencies({
      deploy: vi.fn(async () => ({
        exitCode: 0 as const,
        report,
        hasDiff: false,
      })),
    });
    const out = capture();

    expect(await runCli(['deploy'], { deps, io: out.io, isTTY: false })).toBe(
      1,
    );
    // 変更の有無を知り得ない位置で止まっている証拠: 設定読込・テンプレート読込に
    // すら到達していない。
    expect(deps.loadConfig).not.toHaveBeenCalled();
    expect(deps.readTemplates).not.toHaveBeenCalled();
    expect(deps.createBackend).not.toHaveBeenCalled();
    expect(deps.deploy).not.toHaveBeenCalled();
    expect(out.stdout()).toBe('');
    expect(out.stderr()).toContain('--auto-approve');
  });

  it('FR-7-1 / FR-7-9a / FR-7-9d: CLI の --profile / --region を AWS 依存へ明示的に伝播する', async () => {
    const deps = dependencies();
    (deps.deploy as ReturnType<typeof vi.fn>).mockImplementation(
      async (input) => {
        input.deps.cfnFactory(input.config.defaultRegion);
        return { exitCode: 0, report, hasDiff: false };
      },
    );
    await runCli(
      [
        'deploy',
        '--auto-approve',
        '--profile',
        'work',
        '--region',
        'us-west-2',
      ],
      {
        deps,
      },
    );
    expect(deps.createCfn).toHaveBeenCalledWith({
      region: 'us-west-2',
      profile: 'work',
    });
    expect(deps.createSts).toHaveBeenCalledWith({
      region: 'us-west-2',
      profile: 'work',
    });
    expect(deps.loadConfig).toHaveBeenCalledWith('./cfnsync.yaml');
  });

  it('FR-8-2: --region 適用後に消える明示依存を usecase 呼出前に拒否する', async () => {
    const overridden: CfnSyncConfig = {
      ...config,
      stacks: {
        'network.yaml': {
          ...config.stacks['app.yaml'],
          stackName: 'network',
          regions: ['ap-northeast-1'],
        },
        'app.yaml': {
          ...config.stacks['app.yaml'],
          dependsOn: ['network.yaml'],
        },
      },
    };
    const deps = dependencies({ loadConfig: vi.fn(() => overridden) });
    const out = capture();
    expect(
      await runCli(['deploy', '--auto-approve', '--region', 'us-east-1'], {
        deps,
        io: out.io,
      }),
    ).toBe(1);
    expect(out.stderr()).toContain('network.yaml@us-east-1');
    expect(deps.deploy).not.toHaveBeenCalled();
  });

  it('NFR-5: deploy の cfnFactory は同一リージョンのゲートウェイを再利用する', async () => {
    const deps = dependencies();
    (deps.deploy as ReturnType<typeof vi.fn>).mockImplementation(
      async (input) => {
        const first = input.deps.cfnFactory('ap-northeast-1');
        const second = input.deps.cfnFactory('ap-northeast-1');
        expect(second).toBe(first);
        return { exitCode: 0, report, hasDiff: false };
      },
    );
    await runCli(['deploy', '--auto-approve'], { deps });
    expect(deps.createCfn).toHaveBeenCalledTimes(1);
  });

  it('FR-7-1 / FR-7-9c: AWS_PROFILE は伝播するが AWS_REGION / AWS_DEFAULT_REGION はリージョン決定に使わない', async () => {
    vi.stubEnv('AWS_PROFILE', 'environment-profile');
    vi.stubEnv('AWS_REGION', 'eu-west-1');
    vi.stubEnv('AWS_DEFAULT_REGION', 'us-east-1');
    const deps = dependencies();
    (deps.deploy as ReturnType<typeof vi.fn>).mockImplementation(
      async (input) => {
        input.deps.cfnFactory(input.config.defaultRegion);
        return { exitCode: 0, report, hasDiff: false };
      },
    );
    await runCli(['deploy', '--auto-approve'], { deps });
    // FR-7-9c: 環境変数は設定ファイルの defaultRegion を上書きしない。
    expect(deps.createCfn).toHaveBeenCalledWith({
      region: 'ap-northeast-1',
      profile: 'environment-profile',
    });
    expect(deps.createSts).toHaveBeenCalledWith({
      region: 'ap-northeast-1',
      profile: 'environment-profile',
    });
  });

  it('FR-7-9b: --region 未指定なら設定ファイルの defaultRegion を採用する', async () => {
    const deps = dependencies();
    (deps.deploy as ReturnType<typeof vi.fn>).mockImplementation(
      async (input) => {
        input.deps.cfnFactory(input.config.defaultRegion);
        return { exitCode: 0, report, hasDiff: false };
      },
    );
    await runCli(['deploy', '--auto-approve'], { deps });
    expect(deps.createCfn).toHaveBeenCalledWith({
      region: 'ap-northeast-1',
      profile: undefined,
    });
    expect(deps.createSts).toHaveBeenCalledWith({
      region: 'ap-northeast-1',
      profile: undefined,
    });
  });

  it('FR-7-9a / FR-7-9c: --region は環境変数より優先し、環境変数だけではスタックキーが変わらない', async () => {
    vi.stubEnv('AWS_REGION', 'eu-west-1');
    vi.stubEnv('AWS_DEFAULT_REGION', 'eu-central-1');
    const withEnv = capture();
    const deps = dependencies();
    expect(
      await runCli(['status', '--output', 'json'], { deps, io: withEnv.io }),
    ).toBe(0);
    // FR-7-9c: 管理単位のスタックキーは設定ファイルの defaultRegion のまま。
    expect(JSON.parse(withEnv.stdout()).entries).toEqual([
      expect.objectContaining({
        stackKey: 'app.yaml@ap-northeast-1',
        region: 'ap-northeast-1',
      }),
    ]);

    // FR-7-9a: 明示した --region だけがスタックキーを移す。
    const withOption = capture();
    expect(
      await runCli(['status', '--output', 'json', '--region', 'us-east-1'], {
        deps: dependencies(),
        io: withOption.io,
      }),
    ).toBe(0);
    expect(JSON.parse(withOption.stdout()).entries).toEqual([
      expect.objectContaining({
        stackKey: 'app.yaml@us-east-1',
        region: 'us-east-1',
      }),
    ]);
  });

  it('FR-5-2a: TTY の deploy は approve を注入し、承認要約を stderr へ出してプロンプトする', async () => {
    const deps = dependencies();
    const prompt = vi.fn(async () => true);
    const out = capture();
    (deps.deploy as ReturnType<typeof vi.fn>).mockImplementation(
      async (input) => {
        // usecase 側が承認を求める経路を模す(実行全体で 1 回)。
        await input.deps.approve({
          connection: report.connection,
          diffs: report.diffs,
          summary: {
            create: 1,
            update: 0,
            delete: 0,
            replacements: 0,
            resourcelessChanges: 0,
          },
          allowDelete: false,
        });
        return { exitCode: 0 as const, report, hasDiff: true };
      },
    );

    expect(
      await runCli(['deploy'], { deps, io: out.io, isTTY: true, prompt }),
    ).toBe(0);
    expect(prompt).toHaveBeenCalledTimes(1);
    // FR-3-7b / FR-5-6f: 承認要約は標準エラーへ出し、標準出力を汚さない。
    expect(out.stderr()).toContain('== 実行内容の確認 ==');
    expect(deps.deploy).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ autoApprove: false }),
      }),
    );
  });

  it('FR-5-2b: --auto-approve は autoApprove を立ててプロンプトしない', async () => {
    const deps = dependencies();
    const prompt = vi.fn(async () => true);

    expect(
      await runCli(['deploy', '--auto-approve'], { deps, isTTY: true, prompt }),
    ).toBe(0);
    expect(prompt).not.toHaveBeenCalled();
    expect(deps.deploy).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ autoApprove: true }),
      }),
    );
  });

  it('§5.3.2(EOF): 承認プロンプトは Ctrl-D(EOF)と Ctrl-C を No として扱い例外を送出しない', async () => {
    // Node の readline は空行での Ctrl-D と Ctrl-C を AbortError で reject する。
    // これを送出すると usecase の承認拒否パスを迂回して最上位の汎用エラー処理へ
    // 落ち、Phase A で作成済みの変更セットが回収されず AWS に残る(FR-5-10a)。
    // 承認が得られていない以上、空入力・不正入力と同じ No へ倒す(fail-closed)。
    const eof = await confirmWith([CTRL_D]);
    const interrupt = await confirmWith([CTRL_C]);

    expect({ eof: eof.answered, interrupt: interrupt.answered }).toEqual({
      eof: false,
      interrupt: false,
    });
    // プロンプトを出したうえでの No であること(問う前に落ちていない)。
    expect(eof.prompt).toContain('Do you want to perform these actions? [y/N]');
  });

  it('§5.3.2(EOF): 中断以外のプロンプト失敗は No へ握りつぶさずそのまま送出する', async () => {
    // 中断の握り潰しが「プロンプトで起きた例外は全部 No」に広がっていないこと。
    const failure = new Error('stderr is broken');
    const broken = fakeTtyOutput(() => {
      throw failure;
    });

    await expect(
      defaultConfirm('Do you want to perform these actions?', {
        input: fakeTtyInput([ENTER]),
        output: broken.stream,
      }),
    ).rejects.toBe(failure);
  });

  it('§5.3.2: 承認プロンプトは y / yes だけを承認とし、空入力・不正入力は No', async () => {
    const cases: [string, string[]][] = [
      ['空入力', [ENTER]],
      ['y', [`y${ENTER}`]],
      ['Y', [`Y${ENTER}`]],
      ['yes', [`yes${ENTER}`]],
      ['YES', [`YES${ENTER}`]],
      ['YeS', [`YeS${ENTER}`]],
      ['前後に空白のある y', [` y ${ENTER}`]],
      ['n', [`n${ENTER}`]],
      ['no', [`no${ENTER}`]],
      ['ye', [`ye${ENTER}`]],
      ['yep', [`yep${ENTER}`]],
      ['yes please', [`yes please${ENTER}`]],
      ['無関係な文字列', [`deploy${ENTER}`]],
    ];

    const observed: Record<string, boolean> = {};
    for (const [label, keys] of cases) {
      observed[label] = (await confirmWith(keys)).answered;
    }

    expect(observed).toEqual({
      空入力: false,
      y: true,
      Y: true,
      yes: true,
      YES: true,
      YeS: true,
      '前後に空白のある y': true,
      n: false,
      no: false,
      ye: false,
      yep: false,
      'yes please': false,
      無関係な文字列: false,
    });
  });

  it('FR-12-8c: --confirm は CliUsageError で exit 1', async () => {
    // isTTY: true・--auto-approve 併記のいずれも与え、exit 1 の理由が FR-12-3b の
    // 非 TTY ガードや承認不足へすり替わらないようにする。
    const textDeps = dependencies();
    const textOut = capture();
    expect(
      await runCli(['deploy', '--confirm'], {
        deps: textDeps,
        io: textOut.io,
        isTTY: true,
      }),
    ).toBe(1);
    expect(textDeps.deploy).not.toHaveBeenCalled();
    // 引数検証で止まるため設定読込にも到達しない。
    expect(textDeps.loadConfig).not.toHaveBeenCalled();
    expect(textOut.stdout()).toBe('');
    expect(textOut.stderr()).toContain("unknown option '--confirm'");

    // FR-12-6a/b: JSON 選択時は共通エラー schema を stdout へちょうど 1 個。
    const jsonDeps = dependencies();
    const jsonOut = capture();
    expect(
      await runCli(['deploy', '--auto-approve', '--confirm', '--output=json'], {
        deps: jsonDeps,
        io: jsonOut.io,
        isTTY: true,
      }),
    ).toBe(1);
    expect(JSON.parse(jsonOut.stdout())).toEqual({
      ok: false,
      exitCode: 1,
      error: {
        type: 'CliUsageError',
        message: expect.stringContaining('--confirm'),
      },
    });
    expect(jsonDeps.deploy).not.toHaveBeenCalled();
  });

  it('FR-12-8d: deploy --dry-run は CliUsageError で exit 1', async () => {
    // isTTY: true・--auto-approve 併記のいずれも与え、exit 1 の理由が FR-12-3b の
    // 非 TTY ガードや承認不足へすり替わらないようにする。
    const textDeps = dependencies();
    const textOut = capture();
    expect(
      await runCli(['deploy', '--dry-run'], {
        deps: textDeps,
        io: textOut.io,
        isTTY: true,
      }),
    ).toBe(1);
    expect(textDeps.deploy).not.toHaveBeenCalled();
    // 引数検証で止まるため設定読込にも到達しない。
    expect(textDeps.loadConfig).not.toHaveBeenCalled();
    expect(textOut.stdout()).toBe('');
    expect(textOut.stderr()).toContain("unknown option '--dry-run'");

    // FR-12-6a/b: JSON 選択時は共通エラー schema を stdout へちょうど 1 個。
    const jsonDeps = dependencies();
    const jsonOut = capture();
    expect(
      await runCli(['deploy', '--auto-approve', '--dry-run', '--output=json'], {
        deps: jsonDeps,
        io: jsonOut.io,
        isTTY: true,
      }),
    ).toBe(1);
    expect(JSON.parse(jsonOut.stdout())).toEqual({
      ok: false,
      exitCode: 1,
      error: {
        type: 'CliUsageError',
        message: expect.stringContaining('--dry-run'),
      },
    });
    expect(jsonDeps.deploy).not.toHaveBeenCalled();
  });

  it('FR-5-2 / FR-5-20a: deploy オプションを usecase に渡す(dryRun は常に false)', async () => {
    const deps = dependencies();
    // isTTY: true は FR-12-3b の非 TTY ガードを避けるためだけに与える。
    await runCli(['deploy', '--allow-delete', '--on-failure', 'continue'], {
      deps,
      isTTY: true,
      prompt: async () => true,
    });
    expect(deps.deploy).toHaveBeenCalledWith(
      expect.objectContaining({
        options: {
          dryRun: false,
          allowDelete: true,
          onFailure: 'continue',
          collectEvents: false,
          autoApprove: false,
        },
      }),
    );
  });

  // deploy は非 TTY では --auto-approve が必須(FR-12-3b)。plan は対象外(FR-12-3c)。
  const withApproval = (command: 'plan' | 'deploy'): string[] =>
    command === 'deploy' ? [command, '--auto-approve'] : [command];

  it.each([
    'plan',
    'deploy',
  ] as const)('FR-3-4: 非 TTY の %s でも text 差分は既定で ANSI 色付き', async (command) => {
    const deps = dependencies({
      deploy: vi.fn(async () => ({
        exitCode: command === 'plan' ? (2 as const) : (0 as const),
        report: colorReport,
        hasDiff: true,
      })),
    });
    const out = capture();

    await runCli(withApproval(command), {
      deps,
      io: out.io,
      env: {},
      isTTY: false,
    });

    expect(out.stdout()).toContain('\x1b[32m+ Add');
  });

  it.each([
    ['plan --no-color', ['plan', '--no-color'], {}],
    ['deploy --no-color', ['deploy', '--auto-approve', '--no-color'], {}],
    ['plan NO_COLOR', ['plan'], { NO_COLOR: '1' }],
    ['deploy 空 NO_COLOR', ['deploy', '--auto-approve'], { NO_COLOR: '' }],
  ] as const)('FR-3-5: %s は text 差分の ANSI 色を無効化する', async (_label, args, env) => {
    const deps = dependencies({
      deploy: vi.fn(async () => ({
        exitCode: args[0] === 'plan' ? (2 as const) : (0 as const),
        report: colorReport,
        hasDiff: true,
      })),
    });
    const out = capture();

    await runCli([...args], { deps, io: out.io, env });

    expect(out.stdout()).not.toContain('\x1b[');
    expect(out.stdout()).toContain('+ Add');
  });

  it.each([
    'plan',
    'deploy',
  ] as const)('FR-3-6: %s --output json は ANSI なしの単一 JSON document', async (command) => {
    const deps = dependencies({
      deploy: vi.fn(async () => ({
        exitCode: command === 'plan' ? (2 as const) : (0 as const),
        report: colorReport,
        hasDiff: true,
      })),
    });
    const out = capture();

    await runCli([...withApproval(command), '--output', 'json'], {
      deps,
      io: out.io,
      env: {},
    });

    expect(out.stdout()).not.toContain('\x1b[');
    expect(JSON.parse(out.stdout()).diffs[0].resources[0].action).toBe('Add');
  });

  it('FR-3-7a: 承認要約は既定で ANSI 色付き、--no-color / NO_COLOR で無色化される', async () => {
    /** deploy を 1 回動かし、標準エラーへ出た承認要約だけを取り出す。 */
    const approvalSummary = async (
      argv: string[],
      env: NodeJS.ProcessEnv,
    ): Promise<string> => {
      const deps = dependencies({
        deploy: vi.fn(
          async (input: Parameters<CliDependencies['deploy']>[0]) => {
            await input.deps.approve?.(approvalRequest);
            // report 側は差分空にしておき、標準エラーの ANSI が承認要約由来である
            // ことを保証する(差分本体の色付けは FR-3-4 / FR-3-5 で別途検証)。
            return { exitCode: 0 as const, report, hasDiff: true };
          },
        ),
      });
      const prompt = vi.fn(async () => true);
      const out = capture();
      expect(
        await runCli(argv, { deps, io: out.io, env, isTTY: true, prompt }),
      ).toBe(0);
      expect(prompt).toHaveBeenCalledTimes(1);
      const stderr = out.stderr();
      const start = stderr.indexOf('== 実行内容の確認 ==');
      expect(start).toBeGreaterThanOrEqual(0);
      return stderr.slice(start);
    };

    // FR-3-4 と同じ既定: TTY / パイプの別によらず色を付ける。
    const colored = await approvalSummary(['deploy'], {});
    expect(colored).toContain('\x1b[32m+ Add');
    expect(colored).toContain('\x1b[33m~ Modify');
    expect(colored).toContain('\x1b[31m- Remove');
    expect(colored).toContain('\x1b[1;31m [REPLACEMENT]\x1b[0m');
    expect(colored).toContain('\x1b[33mAppQueue は置換されます\x1b[0m');
    expect(colored).toContain('\x1b[1;31m警告: リソース置換');

    // FR-3-5 と同じ無色化規則。空文字の NO_COLOR も「存在する」ため無色化する。
    const noColor = {
      option: await approvalSummary(['deploy', '--no-color'], {}),
      env: await approvalSummary(['deploy'], { NO_COLOR: '1' }),
      emptyEnv: await approvalSummary(['deploy'], { NO_COLOR: '' }),
    };
    expect(noColor.env).toBe(noColor.option);
    expect(noColor.emptyEnv).toBe(noColor.option);

    const plain = noColor.option;
    expect(plain).not.toContain('\x1b[');
    // 無色化は「色を落とす」であって「内容を落とす」ではない。色付き出力から
    // ANSI を除いたものと完全一致することで、判断材料の欠落も検出する。
    expect(plain).toBe(stripVTControlCharacters(colored));
    expect(plain).toContain('+ Add');
    expect(plain).toContain('~ Modify');
    expect(plain).toContain('- Remove');
    expect(plain).toContain(' [REPLACEMENT]');
    expect(plain).toContain('AppQueue は置換されます');
    expect(plain).toContain('警告: リソース置換(Replacement)が 1 件あります');
  });

  it('FR-3-7b: 承認要約は --output json でも stderr へ出し stdout の単一 JSON を汚さない', async () => {
    const runDeploy = async (argv: string[]) => {
      const deps = dependencies({
        deploy: vi.fn(
          async (input: Parameters<CliDependencies['deploy']>[0]) => {
            // 実 usecase と同じく --auto-approve では承認を求めない(FR-5-2b)。
            if (input.options.autoApprove !== true) {
              await input.deps.approve?.(approvalRequest);
            }
            return { exitCode: 0 as const, report: colorReport, hasDiff: true };
          },
        ),
      });
      const out = capture();
      expect(
        await runCli(argv, {
          deps,
          io: out.io,
          env: {},
          isTTY: true,
          prompt: vi.fn(async () => true),
        }),
      ).toBe(0);
      return { stdout: out.stdout(), stderr: out.stderr() };
    };

    const approved = await runDeploy(['deploy', '--output', 'json']);
    const autoApproved = await runDeploy([
      'deploy',
      '--auto-approve',
      '--output',
      'json',
    ]);

    // 要約は標準エラーだけに出る。
    expect(approved.stderr).toContain('== 実行内容の確認 ==');
    expect(approved.stderr).toContain('AppQueue');
    expect(autoApproved.stderr).toBe('');
    // 標準出力は要約の有無で 1 バイトも変わらず、ちょうど 1 個の JSON document。
    expect(approved.stdout).toBe(autoApproved.stdout);
    expect(() => JSON.parse(approved.stdout)).not.toThrow();
    expect(JSON.parse(approved.stdout).diffs[0].resources[0].action).toBe(
      'Add',
    );
    expect(approved.stdout).not.toContain('実行内容の確認');
    // AppQueue は承認要約にしか現れない識別子(report 側は AppBucket のみ)。
    expect(approved.stdout).not.toContain('AppQueue');
  });

  it('FR-12-1: import と force-unlock を対応 usecase に渡す', async () => {
    const deps = dependencies();
    await runCli(['import', '--reconcile', 'remote', '--write-template'], {
      deps,
    });
    await runCli(['force-unlock', 'run-123'], { deps });
    expect(deps.runImport).toHaveBeenCalledWith(
      expect.objectContaining({
        options: { reconcile: 'remote', writeTemplate: true },
      }),
    );
    expect(deps.forceUnlock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-123' }),
    );
    expect(deps.readTemplates).not.toHaveBeenCalled();
  });

  it('FR-12-6b(import JSON診断): ロック warning の内部 cause を出力しない', async () => {
    const cause = 'AccessDenied: request id import diagnostic';
    const deps = dependencies({
      runImport: vi.fn(async () => ({
        exitCode: 1 as const,
        report: {
          connection: report.connection,
          stacks: [],
          configWritten: false,
          stateSaved: false,
          accountStateInitialized: false,
          importEntriesSaved: false,
          aborted: 'lock-unavailable' as const,
          warnings: [
            'ステートロックを取得できませんでした: ロック取得に失敗しました',
          ],
        },
        textDiagnostics: [
          `ステートロックを取得できませんでした: ロック取得に失敗しました (cause: ${cause})`,
        ],
      })),
    });
    const out = capture();

    expect(
      await runCli(['import', '--output', 'json'], { deps, io: out.io }),
    ).toBe(1);
    expect(JSON.parse(out.stdout()).warnings).toEqual([
      'ステートロックを取得できませんでした: ロック取得に失敗しました',
    ]);
    expect(out.stdout()).not.toContain(cause);
    expect(out.stderr()).not.toContain(cause);
    expect(out.stderr()).toContain('ロック取得に失敗しました');
  });

  it('FR-12-6b(import text診断): ロック warning の装飾済み cause を出力する', async () => {
    const cause = 'AccessDenied: request id import diagnostic';
    const deps = dependencies({
      runImport: vi.fn(async () => ({
        exitCode: 1 as const,
        report: {
          connection: report.connection,
          stacks: [],
          configWritten: false,
          stateSaved: false,
          accountStateInitialized: false,
          importEntriesSaved: false,
          aborted: 'lock-unavailable' as const,
          warnings: [
            'ステートロックを取得できませんでした: ロック取得に失敗しました',
          ],
        },
        textDiagnostics: [
          `ステートロックを取得できませんでした: ロック取得に失敗しました (cause: ${cause})`,
        ],
      })),
    });
    const out = capture();

    expect(await runCli(['import'], { deps, io: out.io })).toBe(1);
    expect(out.stderr()).toContain(`(cause: ${cause})`);
    expect(out.stdout()).not.toContain(cause);
  });

  it('FR-10-5(統合): import --write-template は既定 loader で不存在テンプレートへ到達して作成する', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfnsync-import-'));
    const configPath = join(dir, 'cfnsync.yaml');
    const templatePath = join(dir, 'missing.yaml');
    writeFileSync(
      configPath,
      'version: 1\ndefaultRegion: ap-northeast-1\nstacks:\n  missing.yaml:\n    stackName: existing\n',
    );
    const cfn = {
      describeStack: vi.fn(async () => ({
        stackName: 'existing',
        stackId:
          'arn:aws:cloudformation:ap-northeast-1:123456789012:stack/existing/id',
        status: 'UPDATE_COMPLETE',
        parameters: {},
        tags: {},
        capabilities: [],
        outputs: {},
        terminationProtection: false,
      })),
      getTemplate: vi.fn(async () => 'Resources: {}\n'),
    } as unknown as CloudFormationGateway;
    const deps: CliDependencies = {
      ...defaultCliDependencies,
      createCfn: vi.fn(() => cfn),
      createSts: vi.fn(
        () =>
          ({
            getCallerIdentity: vi.fn(async () => ({
              accountId: '123456789012',
              arn: 'arn:aws:iam::123456789012:role/test',
            })),
          }) as StsGateway,
      ),
    };
    try {
      expect(
        await runCli(['import', '--config', configPath, '--write-template'], {
          deps,
          io: capture().io,
        }),
      ).toBe(0);
      expect(readFileSync(templatePath, 'utf8')).toBe('Resources: {}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FR-11-5(統合): テンプレートパスがディレクトリなら通常ファイル契約で拒否する', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfnsync-config-'));
    const configPath = join(dir, 'cfnsync.yaml');
    mkdirSync(join(dir, 'templates'));
    writeFileSync(
      configPath,
      'version: 1\ndefaultRegion: ap-northeast-1\nstacks:\n  templates:\n    stackName: invalid\n',
    );
    const out = capture();
    try {
      expect(
        await runCli(['status', '--config', configPath], {
          deps: defaultCliDependencies,
          io: out.io,
        }),
      ).toBe(1);
      expect(out.stderr()).toContain('通常ファイル');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FR-11-5(統合): 設定検証エラーを再ラップせず本文と stackKey を各1回だけ出す', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfnsync-config-'));
    const configPath = join(dir, 'cfnsync.yaml');
    writeFileSync(
      configPath,
      'version: 1\ndefaultRegion: ap-northeast-1\nstacks:\n  app.yaml:\n    regions: ap-northeast-1\n',
    );
    const out = capture();
    try {
      expect(
        await runCli(['status', '--config', configPath], {
          deps: defaultCliDependencies,
          io: out.io,
        }),
      ).toBe(1);
      expect(out.stderr().split('stacks.app.yaml.regions')).toHaveLength(2);
      expect(out.stderr().split('(stackKey: app.yaml)')).toHaveLength(2);
      expect(out.stderr()).not.toContain('"code"');
      expect(out.stderr()).not.toContain('invalid_type');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FR-12-6a(JSON安全性): AwsError の SDK cause と CfnSyncError の装飾を公開 message に含めない', async () => {
    const secretCause =
      'credential=AKIAEXAMPLE NoEchoActualValue=super-secret-value';
    const deps = dependencies({
      loadConfig: vi.fn(() => {
        throw toAwsError(
          'CloudFormation DescribeStacks',
          new Error(secretCause),
          {
            stackKey: 'app.yaml@ap-northeast-1',
            region: 'ap-northeast-1',
          },
        );
      }),
    });
    const out = capture();

    expect(
      await runCli(['status', '--output', 'json'], { deps, io: out.io }),
    ).toBe(1);
    expect(JSON.parse(out.stdout())).toEqual({
      ok: false,
      exitCode: 1,
      error: {
        type: 'AwsError',
        message: 'CloudFormation DescribeStacks に失敗しました',
        stackKey: 'app.yaml@ap-northeast-1',
        region: 'ap-northeast-1',
      },
    });
    expect(out.stdout()).not.toContain(secretCause);
    expect(out.stdout()).not.toContain('(stackKey:');
    expect(out.stdout()).not.toContain('(region:');
    expect(out.stdout()).not.toContain('(cause:');
  });

  it('FR-12(text診断): AwsError は SDK cause を従来どおり stderr の診断に含める', async () => {
    const cause = 'AccessDenied: request id diagnostic';
    const deps = dependencies({
      loadConfig: vi.fn(() => {
        throw toAwsError('CloudFormation DescribeStacks', new Error(cause), {
          stackKey: 'app.yaml@ap-northeast-1',
          region: 'ap-northeast-1',
        });
      }),
    });
    const out = capture();

    expect(await runCli(['status'], { deps, io: out.io })).toBe(1);
    expect(out.stdout()).toBe('');
    expect(out.stderr()).toContain(
      'error: CloudFormation DescribeStacks に失敗しました',
    );
    expect(out.stderr()).toContain('(stackKey: app.yaml@ap-northeast-1)');
    expect(out.stderr()).toContain('(region: ap-northeast-1)');
    expect(out.stderr()).toContain(`(cause: ${cause})`);
  });

  /** 承認が拒否された usecase の戻り値を模す(FR-5-10 / FR-12-6c1)。 */
  const cancelledDeploy = () =>
    vi.fn(async (input: Parameters<CliDependencies['deploy']>[0]) => {
      await input.deps.approve?.({
        connection: report.connection,
        diffs: report.diffs,
        summary: {
          create: 1,
          update: 0,
          delete: 0,
          replacements: 0,
          resourcelessChanges: 0,
        },
        allowDelete: false,
      });
      return {
        exitCode: 0 as const,
        report: { ...report, cancelled: true as const },
        hasDiff: true,
      };
    });

  it('FR-12-6c1(JSONキャンセル): 承認拒否は cancelled 付き deploy report を stdout に 1 個出して exit 0', async () => {
    const deps = dependencies({ deploy: cancelledDeploy() });
    const prompt = vi.fn(async () => false);
    const out = capture();

    expect(
      await runCli(['deploy', '--output', 'json'], {
        deps,
        io: out.io,
        isTTY: true,
        prompt,
      }),
    ).toBe(0);
    const payload = JSON.parse(out.stdout());
    // 旧専用ペイロード({exitCode,cancelled,message})は廃止。差分と結果を保持した
    // deploy report の既存 schema に cancelled: true を足す(破壊的変更)。
    expect(payload.cancelled).toBe(true);
    expect(payload.exitCode).toBeUndefined();
    expect(payload.message).toBeUndefined();
    expect(payload.connection).toBeDefined();
    expect(payload.diffs).toBeDefined();
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('FR-12-6c2(textキャンセル): 承認拒否は stderr に診断を出し stdout に report を出して exit 0', async () => {
    const deps = dependencies({ deploy: cancelledDeploy() });
    const prompt = vi.fn(async () => false);
    const out = capture();

    expect(
      await runCli(['deploy'], { deps, io: out.io, isTTY: true, prompt }),
    ).toBe(0);
    expect(out.stderr()).toContain('Deployment cancelled.');
    expect(out.stdout()).toContain('== 接続先 ==');
  });

  it.each([
    ['分離記法', ['status', '--output', 'json']],
    ['equals 記法', ['status', '--output=json']],
  ] as const)('FR-12-6d(JSON選択): --output json と --output=json の両記法を認識する（%s）', async (_label, args) => {
    const out = capture();
    const deps = dependencies({
      loadConfig: vi.fn(() => {
        throw new ConfigError('JSON selection error');
      }),
    });

    expect(await runCli([...args], { deps, io: out.io })).toBe(1);
    expect(JSON.parse(out.stdout()).error.type).toBe('ConfigError');
  });

  it.each([
    ['サブコマンド前', ['--output', 'json', 'status']],
    ['サブコマンド後', ['status', '--output', 'json']],
  ] as const)('FR-12-6e(JSON選択): --output はサブコマンドの前後どちらでも有効（%s）', async (_label, args) => {
    const out = capture();
    const deps = dependencies({
      loadConfig: vi.fn(() => {
        throw new ConfigError('JSON placement error');
      }),
    });

    expect(await runCli([...args], { deps, io: out.io })).toBe(1);
    expect(JSON.parse(out.stdout()).error.type).toBe('ConfigError');
  });

  it.each([
    ['最後が text', ['status', '--output', 'json', '--output', 'text'], false],
    ['最後が json', ['status', '--output', 'text', '--output=json'], true],
  ] as const)('FR-12-6f(JSON選択): 複数指定は最後の --output を採用する（%s）', async (_label, args, jsonExpected) => {
    const out = capture();
    const deps = dependencies({
      loadConfig: vi.fn(() => {
        throw new ConfigError('last output wins');
      }),
    });

    expect(await runCli([...args], { deps, io: out.io })).toBe(1);
    if (jsonExpected) {
      expect(JSON.parse(out.stdout()).error.type).toBe('ConfigError');
      expect(out.stderr()).toBe('');
    } else {
      expect(out.stdout()).toBe('');
      expect(out.stderr()).toContain('last output wins');
    }
  });

  it.each([
    ['--config', ['status', '--config', '--output=json']],
    ['--profile', ['status', '--profile', '--output=json']],
    ['--region', ['status', '--region', '--output=json']],
    ['--output', ['status', '--output', '--output=json']],
    ['--on-failure', ['deploy', '--on-failure', '--output=json']],
    ['--reconcile', ['import', '--reconcile', '--output=json']],
  ] as const)('FR-12-6g(JSON選択): 他オプション %s の値 --output=json を JSON 指定として扱わない', async (_option, args) => {
    const out = capture();
    const deps = dependencies({
      loadConfig: vi.fn(() => {
        throw new ConfigError('text selection error');
      }),
    });

    expect(await runCli([...args], { deps, io: out.io })).toBe(1);
    expect(out.stdout()).toBe('');
    expect(out.stderr()).not.toBe('');
  });

  it.each([
    ['--help', ['status', '--output', 'json', '--help'], 'Usage:'],
    ['--version', ['--output=json', '--version'], undefined],
  ] as const)('FR-12-6h(JSON契約外): %s は text を出して exit 0', async (_option, args, expectedText) => {
    const out = capture();

    expect(await runCli([...args], { deps: dependencies(), io: out.io })).toBe(
      0,
    );
    expect(out.stdout()).not.toBe('');
    if (expectedText !== undefined) {
      expect(out.stdout()).toContain(expectedText);
    }
    expect(() => JSON.parse(out.stdout())).toThrow();
    expect(out.stderr()).toBe('');
  });

  it('NFR-5: status は state backend を読むが CloudFormation / STS factory を呼ばない', async () => {
    const deps = dependencies();
    const out = capture();
    expect(
      await runCli(['status', '--output', 'json'], { deps, io: out.io }),
    ).toBe(0);
    expect(JSON.parse(out.stdout()).entries[0].changeType).toBe('added');
    expect(deps.createCfn).not.toHaveBeenCalled();
    expect(deps.createSts).not.toHaveBeenCalled();
    expect(deps.createBackend).toHaveBeenCalledTimes(1);
    expect(deps.getStatus).toHaveBeenCalledTimes(1);
  });

  it('NFR-5: graph はテンプレート解析のみで CloudFormation / STS factory を呼ばない', async () => {
    const deps = dependencies();
    const out = capture();
    expect(
      await runCli(['graph', '--output', 'json'], { deps, io: out.io }),
    ).toBe(0);
    expect(JSON.parse(out.stdout()).regions[0].nodes).toEqual([
      'app.yaml@ap-northeast-1',
    ]);
    expect(deps.createCfn).not.toHaveBeenCalled();
    expect(deps.createSts).not.toHaveBeenCalled();
    expect(deps.createBackend).not.toHaveBeenCalled();
    expect(deps.getGraph).toHaveBeenCalledTimes(1);
  });

  it('FR-8-4 / §9: graph の循環は診断を stderr に出して exit 1', async () => {
    const cyclic: CfnSyncConfig = {
      ...config,
      stacks: {
        'a.yaml': {
          ...config.stacks['app.yaml'],
          stackName: 'a',
          dependsOn: ['b.yaml'],
        },
        'b.yaml': {
          ...config.stacks['app.yaml'],
          stackName: 'b',
          dependsOn: ['a.yaml'],
        },
      },
    };
    const deps = dependencies({
      loadConfig: vi.fn(() => cyclic),
      readTemplates: vi.fn(
        () =>
          new Map([
            ['a.yaml', 'Resources: {}'],
            ['b.yaml', 'Resources: {}'],
          ]),
      ),
    });
    const out = capture();
    expect(await runCli(['graph'], { deps, io: out.io })).toBe(1);
    expect(out.stderr()).toContain('a.yaml@ap-northeast-1');
    expect(out.stdout()).toBe('');
  });

  it('FR-12-6a(JSONエラー): 設定読込・設定検証・graph循環は stdout の単一 CliErrorPayload で exit 1', async () => {
    const cyclic: CfnSyncConfig = {
      ...config,
      stacks: {
        'a.yaml': {
          ...config.stacks['app.yaml'],
          stackName: 'a',
          dependsOn: ['b.yaml'],
        },
        'b.yaml': {
          ...config.stacks['app.yaml'],
          stackName: 'b',
          dependsOn: ['a.yaml'],
        },
      },
    };
    const scenarios: {
      args: string[];
      deps: CliDependencies;
      type: string;
      stackKey?: string;
      region?: string;
    }[] = [
      {
        args: ['status', '--output', 'json'],
        deps: dependencies({
          loadConfig: vi.fn(() => {
            throw new ConfigError('設定ファイルを読み込めません', {
              cause: new Error('ENOENT credential-do-not-leak'),
            });
          }),
        }),
        type: 'ConfigError',
      },
      {
        args: ['status', '--output=json'],
        deps: dependencies({
          loadConfig: vi.fn(() =>
            validateConfig({
              version: 1,
              defaultRegion: 'ap-northeast-1',
              stacks: {
                'app.yaml': { regions: 'ap-northeast-1' },
              },
            }),
          ),
        }),
        type: 'ConfigError',
        stackKey: 'app.yaml',
      },
      {
        args: ['graph', '--output', 'json'],
        deps: dependencies({
          loadConfig: vi.fn(() => cyclic),
          readTemplates: vi.fn(
            () =>
              new Map([
                ['a.yaml', 'Resources: {}'],
                ['b.yaml', 'Resources: {}'],
              ]),
          ),
        }),
        type: 'DependencyCycleError',
        region: 'ap-northeast-1',
      },
    ];

    for (const scenario of scenarios) {
      const out = capture();
      expect(
        await runCli(scenario.args, { deps: scenario.deps, io: out.io }),
      ).toBe(1);
      const payload = JSON.parse(out.stdout()) as {
        ok: boolean;
        exitCode: number;
        error: Record<string, unknown>;
      };
      expect(payload).toEqual({
        ok: false,
        exitCode: 1,
        error: {
          type: scenario.type,
          message: expect.any(String),
          ...(scenario.stackKey === undefined
            ? {}
            : { stackKey: scenario.stackKey }),
          ...(scenario.region === undefined ? {} : { region: scenario.region }),
        },
      });
      expect(out.stdout()).not.toContain('credential-do-not-leak');
      expect(out.stdout()).not.toContain('"code"');
      expect(out.stdout()).not.toContain('invalid_type');
      expect(out.stdout()).not.toContain('"cause"');
      expect(out.stdout()).not.toContain('"stack"');
    }
  });

  it('FR-12-6a(JSONエラー): --on-failure 不正値と未知サブコマンドも stdout の単一 CliUsageError で exit 1', async () => {
    for (const args of [
      ['deploy', '--on-failure', 'bogus', '--output', 'json'],
      ['unknown-command', '--output=json'],
    ]) {
      const out = capture();
      expect(await runCli(args, { deps: dependencies(), io: out.io })).toBe(1);
      expect(JSON.parse(out.stdout())).toEqual({
        ok: false,
        exitCode: 1,
        error: {
          type: 'CliUsageError',
          message: expect.any(String),
        },
      });
      expect(out.stderr()).toContain('error:');
    }
  });

  it('FR-12-6b(JSON出力先): force-unlock の結果が exit 1 でも JSON は stdout のみに出す', async () => {
    const result = {
      exitCode: 1 as const,
      released: false,
      message: '指定した実行 ID は現在のロックと一致しません。',
    };
    const deps = dependencies({
      forceUnlock: vi.fn(async () => result),
    });
    const out = capture();

    expect(
      await runCli(['force-unlock', 'run-123', '--output', 'json'], {
        deps,
        io: out.io,
      }),
    ).toBe(1);
    expect(JSON.parse(out.stdout())).toEqual(result);
    expect(out.stderr()).toBe('');
  });

  it.each([
    'status',
    'plan',
    'deploy',
    'graph',
    'import',
    'force-unlock',
  ] as const)('FR-12-5: %s の --help に共通オプションを表示する', async (name) => {
    const out = capture();
    expect(
      await runCli([name, '--help'], { deps: dependencies(), io: out.io }),
    ).toBe(0);
    expect(out.stdout()).toContain('Global Options:');
    expect(out.stdout()).toContain('--config');
    expect(out.stdout()).toContain('--profile');
    expect(out.stdout()).toContain('--region');
    expect(out.stdout()).toContain('--output');
  });

  it.each([
    'plan',
    'deploy',
  ] as const)('FR-12-7: %s の --help に --no-color を表示する', async (name) => {
    const out = capture();
    expect(
      await runCli([name, '--help'], {
        deps: dependencies(),
        io: out.io,
      }),
    ).toBe(0);
    expect(out.stdout()).toContain('--no-color');
  });

  it.each([
    'status',
    'graph',
    'import',
    'force-unlock',
  ] as const)('FR-12-7: %s の --help には --no-color を表示しない', async (name) => {
    const out = capture();
    expect(
      await runCli([name, '--help'], {
        deps: dependencies(),
        io: out.io,
      }),
    ).toBe(0);
    expect(out.stdout()).not.toContain('--no-color');
  });

  it('FR-12-8a: deploy の help に --auto-approve と -y が表示される', async () => {
    const out = capture();
    expect(
      await runCli(['deploy', '--help'], { deps: dependencies(), io: out.io }),
    ).toBe(0);
    // 長形式・短縮形の両方が同じ行に出ることまで固定する(短縮形の欠落を防ぐ)。
    expect(out.stdout()).toContain('-y, --auto-approve');
    expect(out.stdout()).toContain(
      '-y, --auto-approve   Skip the approval prompt and apply directly',
    );
    expect(out.stderr()).toBe('');
  });

  it('FR-12-8b: plan を含む他サブコマンドの help に --auto-approve がない', async () => {
    const observed: Record<string, unknown> = {};
    for (const name of ['plan', 'status', 'graph', 'import', 'force-unlock']) {
      const out = capture();
      const exitCode = await runCli([name, '--help'], {
        deps: dependencies(),
        io: out.io,
      });
      const stdout = out.stdout();
      observed[name] = {
        exitCode,
        // help 自体が出ていることを確かめ、空出力による偽陰性を防ぐ。
        showsUsage: stdout.includes(`Usage: cfnsync ${name}`),
        hasAutoApprove: stdout.includes('--auto-approve'),
        hasShortFlag: /(^|\s)-y[,\s]/m.test(stdout),
      };
    }

    expect(observed).toEqual(
      Object.fromEntries(
        ['plan', 'status', 'graph', 'import', 'force-unlock'].map((name) => [
          name,
          {
            exitCode: 0,
            showsUsage: true,
            hasAutoApprove: false,
            hasShortFlag: false,
          },
        ]),
      ),
    );
  });

  it('FR-12-8d: どのサブコマンドの help にも --dry-run がない', async () => {
    const observed: Record<string, unknown> = {};
    for (const name of [
      'status',
      'plan',
      'deploy',
      'graph',
      'import',
      'force-unlock',
    ]) {
      const out = capture();
      const exitCode = await runCli([name, '--help'], {
        deps: dependencies(),
        io: out.io,
      });
      const stdout = out.stdout();
      observed[name] = {
        exitCode,
        // help 自体が出ていることを確かめ、空出力による偽陰性を防ぐ。
        showsUsage: stdout.includes(`Usage: cfnsync ${name}`),
        hasDryRun: stdout.includes('--dry-run'),
      };
    }

    expect(observed).toEqual(
      Object.fromEntries(
        ['status', 'plan', 'deploy', 'graph', 'import', 'force-unlock'].map(
          (name) => [name, { exitCode: 0, showsUsage: true, hasDryRun: false }],
        ),
      ),
    );
  });

  it('FR-12-4: -v と --version が package.json の version を表示して exit 0', async () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    // 'unknown' フォールバック(package.json を読めない場合)を version と誤認しない。
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);

    const observed: Record<string, unknown> = {};
    for (const flag of ['-v', '--version']) {
      const out = capture();
      const exitCode = await runCli([flag], {
        deps: dependencies(),
        io: out.io,
      });
      observed[flag] = {
        exitCode,
        stdout: out.stdout().trim(),
        stderr: out.stderr(),
      };
    }

    const expected = { exitCode: 0, stdout: pkg.version, stderr: '' };
    expect(observed).toEqual({ '-v': expected, '--version': expected });
  });

  it('FR-12-5: ルートの --help は従来どおり Options: の下に共通オプションを表示する', async () => {
    const out = capture();
    expect(await runCli(['--help'], { deps: dependencies(), io: out.io })).toBe(
      0,
    );
    expect(out.stdout()).toContain('Options:');
    expect(out.stdout()).not.toContain('Global Options:');
    expect(out.stdout()).toContain('--config');
    expect(out.stdout()).toContain('--profile');
    expect(out.stdout()).toContain('--region');
    expect(out.stdout()).toContain('--output');
  });

  it('NFR-1: 結果は stdout、進捗イベントは stderr に分離する', async () => {
    const deps = dependencies({
      deploy: vi.fn(async (input) => {
        input.deps.onEvent?.({
          stackKey: 'app.yaml@ap-northeast-1',
          region: 'ap-northeast-1',
          timestamp: '2026-01-01T00:00:00Z',
          logicalResourceId: 'App',
          resourceType: 'AWS::S3::Bucket',
          resourceStatus: 'CREATE_IN_PROGRESS',
        });
        return { exitCode: 0 as const, report, hasDiff: false };
      }),
    });
    const out = capture();
    await runCli(['deploy', '--auto-approve', '--output', 'json'], {
      deps,
      io: out.io,
    });
    expect(JSON.parse(out.stdout()).connection.accountId).toBe('123456789012');
    expect(out.stderr()).toContain('CREATE_IN_PROGRESS');
    expect(out.stdout()).not.toContain('CREATE_IN_PROGRESS');
  });

  it('FR-5-4: 進捗は標準エラーへ出力され --output json の標準出力を汚さない', async () => {
    const deps = dependencies({
      deploy: vi.fn(async (input) => {
        input.deps.onProgress?.({
          stackKey: 'app.yaml@ap-northeast-1',
          region: 'ap-northeast-1',
          phase: 'changeset-create-start',
          message: '変更セットを作成しています',
        });
        input.deps.onProgress?.({
          stackKey: 'app.yaml@ap-northeast-1',
          region: 'ap-northeast-1',
          phase: 'execute-start',
          message: '変更セットを実行しています',
        });
        input.deps.onProgress?.({
          stackKey: 'app.yaml@ap-northeast-1',
          region: 'ap-northeast-1',
          phase: 'done',
          message: 'デプロイが完了しました',
        });
        return { exitCode: 0 as const, report, hasDiff: false };
      }),
    });
    const out = capture();
    await runCli(['deploy', '--auto-approve', '--output', 'json'], {
      deps,
      io: out.io,
    });
    // stdout は最終 report の JSON のみ(進捗が混入しない)。
    expect(() => JSON.parse(out.stdout())).not.toThrow();
    expect(JSON.parse(out.stdout()).connection.accountId).toBe('123456789012');
    expect(out.stdout()).not.toContain('変更セットを作成しています');
    // 進捗は stderr に `[stackKey] message` 形式で出る。
    expect(out.stderr()).toContain(
      '[app.yaml@ap-northeast-1] 変更セットを作成しています',
    );
    expect(out.stderr()).toContain(
      '[app.yaml@ap-northeast-1] デプロイが完了しました',
    );
  });

  it('FR-5-4: plan でも進捗が標準エラーへ出力される', async () => {
    const deps = dependencies({
      deploy: vi.fn(async (input) => {
        input.deps.onProgress?.({
          stackKey: 'app.yaml@ap-northeast-1',
          region: 'ap-northeast-1',
          phase: 'diff-ready',
          message: '差分を確定しました(リソース 1 件)',
        });
        return { exitCode: 0 as const, report, hasDiff: false };
      }),
    });
    const out = capture();
    await runCli(['plan', '--output', 'json'], { deps, io: out.io });
    expect(deps.deploy).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ dryRun: true }),
      }),
    );
    expect(() => JSON.parse(out.stdout())).not.toThrow();
    expect(out.stderr()).toContain(
      '[app.yaml@ap-northeast-1] 差分を確定しました(リソース 1 件)',
    );
    expect(out.stdout()).not.toContain('差分を確定しました');
  });
});
