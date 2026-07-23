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
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
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

function detectJsonOutput(argv: string[]): boolean {
  const valueOptions = new Set([
    '--config',
    '--profile',
    '--region',
    '--output',
    '--on-failure',
    '--reconcile',
  ]);
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
  usageError = false,
): void {
  if (runtime.errorEmitted) return;
  runtime.errorEmitted = true;
  if (runtime.jsonRequested) {
    runtime.io.stdout(
      `${renderCliError(error, usageError ? 'CliUsageError' : undefined)}\n`,
    );
    return;
  }
  if (!usageError) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`error: ${message}\n`);
  }
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
      writeError(runtime, error);
    }
  };
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
      invoke(runtime, () => runStatus(runtime, commonOptions(command)))(),
    );

  program
    .command('plan')
    .description('Create change sets and show the diff')
    .action((_opts, command) =>
      invoke(runtime, () =>
        runDeployment(runtime, { ...commonOptions(command), dryRun: true }),
      )(),
    );

  program
    .command('deploy')
    .description('Deploy changes')
    .option('--dry-run', 'Only create change sets and show the diff')
    .option('--allow-delete', 'Allow deletion of stacks')
    .addOption(
      new Option('--on-failure <mode>', 'Behavior on failure')
        .choices(['stop', 'continue'])
        .default('stop'),
    )
    .option('--confirm', 'Prompt for confirmation before running (TTY only)')
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
            !(await runtime.prompt('Proceed with the deployment?'))
          ) {
            const message = 'Deployment cancelled.';
            if (runtime.jsonRequested) {
              runtime.io.stdout(
                `${JSON.stringify(
                  { exitCode: 0, cancelled: true, message },
                  null,
                  2,
                )}\n`,
              );
            } else {
              runtime.io.stderr(`${message}\n`);
            }
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
    .description('Show the dependency graph')
    .action((_opts, command) =>
      invoke(runtime, () => runGraph(runtime, commonOptions(command)))(),
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
        invoke(runtime, () =>
          runImporter(runtime, { ...commonOptions(command), ...local }),
        )(),
    );

  program
    .command('force-unlock <runId>')
    .description('Manually release a stale state lock')
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
  runtime.jsonRequested = detectJsonOutput(argv);
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
    writeError(runtime, error, true);
  }
  return runtime.exitCode;
}
