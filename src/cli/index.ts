import { readFileSync } from 'node:fs';

import { Command, Option } from 'commander';

import { renderCliError } from '../usecase/cliBoundary.js';
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

// package.json はビルド後も dist/cli/index.js の 2 階層上に位置し、
// npm 公開物にも常に含まれる。JSON import は rootDir(src) 外のため使わない。
function readPackageVersion(): string {
  try {
    const url = new URL('../../package.json', import.meta.url);
    const pkg: unknown = JSON.parse(readFileSync(url, 'utf8'));
    if (
      typeof pkg === 'object' &&
      pkg !== null &&
      'version' in pkg &&
      typeof pkg.version === 'string'
    ) {
      return pkg.version;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

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
  jsonRequested: boolean;
  errorEmitted: boolean;
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

export function deriveValueOptions(program: Command): Set<string> {
  return new Set(
    [
      ...program.options,
      ...program.commands.flatMap((command) => command.options),
    ]
      .filter((option) => option.required || option.optional)
      .map((option) => option.long)
      .filter((long): long is string => long !== undefined),
  );
}

function detectJsonOutput(
  argv: string[],
  valueOptions: ReadonlySet<string>,
): boolean {
  let jsonRequested = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') break;
    if (valueOptions.has(arg)) {
      if (arg === '--output') {
        jsonRequested = argv[index + 1] === 'json';
      }
      index += 1;
      continue;
    }
    const equals = arg.indexOf('=');
    if (equals === -1) continue;
    const option = arg.slice(0, equals);
    if (!valueOptions.has(option)) continue;
    if (option === '--output') {
      jsonRequested = arg.slice(equals + 1) === 'json';
    }
  }
  return jsonRequested;
}

function writeError(
  runtime: Runtime,
  error: unknown,
  options: { type?: 'CliUsageError'; emitText?: boolean } = {},
): void {
  if (runtime.errorEmitted) return;
  runtime.errorEmitted = true;
  if (runtime.jsonRequested) {
    runtime.io.stdout(`${renderCliError(error, options.type)}\n`);
    return;
  }
  if (options.emitText ?? options.type !== 'CliUsageError') {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`error: ${message}\n`);
  }
}

async function run(
  runtime: Runtime,
  action: () => Promise<ExitCode>,
): Promise<void> {
  try {
    runtime.exitCode = await action();
  } catch (error) {
    runtime.exitCode = 1;
    writeError(runtime, error);
  }
}

function addCommonOptions(program: Command): void {
  program
    .option('--config <path>', 'Path to the config file', './cfnsync.yaml')
    .option('--profile <name>', 'AWS profile')
    .option('--region <region>', 'Override the default region')
    .addOption(
      new Option('--output <format>', 'Output format')
        .choices(['text', 'json'])
        .default('text'),
    );
}

export function createCliProgram(
  deps: CliDependencies = defaultCliDependencies,
  runtimeOverrides: Omit<RunCliOptions, 'deps'> = {},
): { program: Command; runtime: Runtime } {
  const runtime: Runtime = {
    deps,
    io: runtimeOverrides.io ?? defaultIo,
    env: runtimeOverrides.env ?? process.env,
    isTTY:
      runtimeOverrides.isTTY ??
      Boolean(process.stdin.isTTY && process.stderr.isTTY),
    prompt: runtimeOverrides.prompt ?? defaultConfirm,
    exitCode: 0,
    jsonRequested: false,
    errorEmitted: false,
  };
  const program = new Command()
    .name('cfnsync')
    .description('CloudFormation template synchronization CLI')
    .version(readPackageVersion(), '-v, --version', 'Show version')
    .configureHelp({ showGlobalOptions: true })
    .showHelpAfterError()
    .exitOverride();
  addCommonOptions(program);

  program
    .command('status')
    .description('Show locally detected changes')
    .action((_opts, command) =>
      run(runtime, () => runStatus(runtime, commonOptions(command))),
    );

  // FR-5-20a: 差分確認を提供する公開コマンドは plan だけ。deploy に同じ目的の
  // オプション(--dry-run)は置かない(FR-12-8d)。dryRun は plan 経路を表す
  // 内部フラグであり、利用者はどの引数からも true にできない(design §5.3.5)。
  program
    .command('plan')
    .description('Create change sets and show the diff')
    .option('--no-color', 'Disable ANSI colors in the diff')
    .action((local: { color?: boolean }, command) =>
      run(runtime, () =>
        runDeployment(runtime, {
          ...commonOptions(command),
          ...local,
          dryRun: true,
        }),
      ),
    );

  program
    .command('deploy')
    .description('Deploy changes')
    .option('--allow-delete', 'Allow deletion of stacks')
    .addOption(
      new Option('--on-failure <mode>', 'Behavior on failure')
        .choices(['stop', 'continue'])
        .default('stop'),
    )
    .option('-y, --auto-approve', 'Skip the approval prompt and apply directly')
    .option('--no-color', 'Disable ANSI colors in the diff')
    .action(
      (
        local: {
          allowDelete?: boolean;
          onFailure: 'stop' | 'continue';
          autoApprove?: boolean;
          color?: boolean;
        },
        command,
      ) =>
        run(runtime, async () => {
          // FR-12-3b: 承認を求められない非 TTY で --auto-approve がない deploy は、
          // AWS・ステートバックエンドへ一切アクセスする前に CLI 境界で拒否する
          // (fail-closed)。差分確認だけを行いたい場合は plan を使う(FR-5-20a)。
          if (local.autoApprove !== true && !runtime.isTTY) {
            const message =
              'deploy shows the diff and asks for approval by default, but this environment has no TTY. ' +
              'In non-interactive environments such as CI, specify --auto-approve (-y)';
            writeError(runtime, new Error(message), {
              type: 'CliUsageError',
              emitText: true,
            });
            return 1;
          }
          return runDeployment(runtime, {
            ...commonOptions(command),
            ...local,
            prompt: runtime.prompt,
          });
        }),
    );

  program
    .command('graph')
    .description('Show the dependency graph')
    .action((_opts, command) =>
      run(runtime, () => runGraph(runtime, commonOptions(command))),
    );

  program
    .command('import')
    .description('Import existing stacks')
    .addOption(
      new Option(
        '--reconcile <source>',
        'Source to resolve template diffs from',
      ).choices(['remote', 'local']),
    )
    .option('--write-template', 'Write out local templates that do not exist')
    .action(
      (
        local: { reconcile?: 'remote' | 'local'; writeTemplate?: boolean },
        command,
      ) =>
        run(runtime, () =>
          runImporter(runtime, { ...commonOptions(command), ...local }),
        ),
    );

  program
    .command('force-unlock <runId>')
    .description('Manually release a stale state lock')
    .action((runId: string, _local: unknown, command: Command) =>
      run(runtime, () =>
        runForceUnlock(runtime, commonOptions(command), runId),
      ),
    );

  return { program, runtime };
}

export async function runCli(
  argv: string[],
  options: RunCliOptions = {},
): Promise<ExitCode> {
  const { program, runtime } = createCliProgram(
    options.deps ?? defaultCliDependencies,
    options,
  );
  runtime.jsonRequested = detectJsonOutput(argv, deriveValueOptions(program));
  program.configureOutput({
    writeOut: runtime.io.stdout,
    writeErr: runtime.io.stderr,
  });
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'exitCode' in error &&
      error.exitCode === 0
    )
      return 0;
    runtime.exitCode = 1;
    writeError(runtime, error, { type: 'CliUsageError' });
  }
  return runtime.exitCode;
}
