import { Command, Option } from 'commander';

import {
  type CliIo,
  type CommonOptions,
  defaultConfirm,
  type OutputFormat,
  runDeployment,
  runForceUnlock,
  runGraph,
  runImporter,
  runStatus,
} from './commands.js';
import {
  type CliDependencies,
  defaultCliDependencies,
} from './dependencies.js';

export type { CliDependencies } from './dependencies.js';

type ExitCode = 0 | 1 | 2;

export interface RunCliOptions {
  deps?: CliDependencies;
  io?: CliIo;
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  prompt?: (question: string) => Promise<boolean>;
}

interface Runtime extends Required<Omit<RunCliOptions, 'deps' | 'env'>> {
  deps: CliDependencies;
  env: NodeJS.ProcessEnv;
  exitCode: ExitCode;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

function commonOptions(command: Command): CommonOptions {
  const options = command.optsWithGlobals<{
    config: string;
    profile?: string;
    region?: string;
    output: OutputFormat;
  }>();
  return options;
}

function invoke(
  runtime: Runtime,
  action: () => Promise<ExitCode>,
): () => Promise<void> {
  return async () => {
    try {
      runtime.exitCode = await action();
    } catch (error) {
      runtime.exitCode = 1;
      const message = error instanceof Error ? error.message : String(error);
      runtime.io.stderr(`error: ${message}\n`);
    }
  };
}

function addCommonOptions(program: Command): void {
  program
    .option('--config <path>', '設定ファイル', './cfnsync.yaml')
    .option('--profile <name>', 'AWS profile')
    .option('--region <region>', '既定リージョンを上書き')
    .addOption(
      new Option('--output <format>', '出力形式')
        .choices(['text', 'json'])
        .default('text'),
    );
}

export function createCliProgram(
  deps: CliDependencies = defaultCliDependencies,
  runtimeOverrides: Omit<RunCliOptions, 'deps'> = {},
): Command {
  const runtime: Runtime = {
    deps,
    io: runtimeOverrides.io ?? defaultIo,
    env: runtimeOverrides.env ?? process.env,
    isTTY:
      runtimeOverrides.isTTY ??
      Boolean(process.stdin.isTTY && process.stderr.isTTY),
    prompt: runtimeOverrides.prompt ?? defaultConfirm,
    exitCode: 0,
  };
  const program = new Command()
    .name('cfnsync')
    .description('CloudFormation template synchronization CLI')
    .showHelpAfterError()
    .exitOverride();
  addCommonOptions(program);

  program
    .command('status')
    .description('ローカルの変更検知結果を表示')
    .action((_opts, command) =>
      invoke(runtime, () => runStatus(runtime, commonOptions(command)))(),
    );

  program
    .command('plan')
    .description('変更セットを作成して差分を表示')
    .action((_opts, command) =>
      invoke(runtime, () =>
        runDeployment(runtime, { ...commonOptions(command), dryRun: true }),
      )(),
    );

  program
    .command('deploy')
    .description('変更をデプロイ')
    .option('--dry-run', '変更セットの作成と差分表示のみ')
    .option('--allow-delete', '削除を許可')
    .addOption(
      new Option('--on-failure <mode>', '失敗時の動作')
        .choices(['stop', 'continue'])
        .default('stop'),
    )
    .option('--confirm', 'TTY で実行前に確認')
    .action(
      (
        local: {
          dryRun?: boolean;
          allowDelete?: boolean;
          onFailure: 'stop' | 'continue';
          confirm?: boolean;
        },
        command,
      ) =>
        invoke(runtime, async () => {
          if (
            local.confirm === true &&
            runtime.isTTY &&
            !(await runtime.prompt('デプロイを実行しますか?'))
          ) {
            runtime.io.stderr('デプロイをキャンセルしました。\n');
            return 0;
          }
          return runDeployment(runtime, {
            ...commonOptions(command),
            ...local,
          });
        })(),
    );

  program
    .command('graph')
    .description('依存関係グラフを表示')
    .action((_opts, command) =>
      invoke(runtime, () => runGraph(runtime, commonOptions(command)))(),
    );

  program
    .command('import')
    .description('既存スタックをインポート')
    .addOption(
      new Option('--reconcile <source>', 'テンプレート差分の解決元').choices([
        'remote',
        'local',
      ]),
    )
    .option('--write-template', '存在しないローカルテンプレートを書き出す')
    .action(
      (
        local: { reconcile?: 'remote' | 'local'; writeTemplate?: boolean },
        command,
      ) =>
        invoke(runtime, () =>
          runImporter(runtime, { ...commonOptions(command), ...local }),
        )(),
    );

  program
    .command('force-unlock <runId>')
    .description('残存ステートロックを手動解除')
    .action((runId: string, _local: unknown, command: Command) =>
      invoke(runtime, () =>
        runForceUnlock(runtime, commonOptions(command), runId),
      )(),
    );

  Object.defineProperty(program, '__cfnsyncRuntime', { value: runtime });
  return program;
}

export async function runCli(
  argv: string[],
  options: RunCliOptions = {},
): Promise<ExitCode> {
  const program = createCliProgram(
    options.deps ?? defaultCliDependencies,
    options,
  );
  const runtime = (program as Command & { __cfnsyncRuntime: Runtime })
    .__cfnsyncRuntime;
  program.configureOutput({
    writeOut: runtime.io.stdout,
    writeErr: runtime.io.stderr,
  });
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    const commanderError = error as { exitCode?: number; message?: string };
    if (commanderError.exitCode === 0) return 0;
    runtime.exitCode = 1;
  }
  return runtime.exitCode;
}
