import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import type { CfnSyncConfig } from '../core/config.js';
import {
  renderGraphJson,
  renderGraphText,
  renderJson,
  renderText,
} from '../report/index.js';
import type { CliDependencies } from './dependencies.js';

export type OutputFormat = 'text' | 'json';

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface CommonOptions {
  config: string;
  profile?: string;
  region?: string;
  output: OutputFormat;
}

export interface CommandContext {
  deps: CliDependencies;
  io: CliIo;
  env: NodeJS.ProcessEnv;
}

function writeLine(write: (text: string) => void, text: string): void {
  write(text.endsWith('\n') ? text : `${text}\n`);
}

function effectiveProfile(
  options: CommonOptions,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return options.profile ?? env.AWS_PROFILE;
}

function effectiveRegion(
  options: CommonOptions,
  config: CfnSyncConfig,
  env: NodeJS.ProcessEnv,
): string {
  return (
    options.region ??
    env.AWS_REGION ??
    env.AWS_DEFAULT_REGION ??
    config.defaultRegion
  );
}

function loadInputs(
  ctx: CommandContext,
  options: CommonOptions,
): {
  config: CfnSyncConfig;
  configPath: string;
  configDir: string;
  templates: Map<string, string>;
  profile?: string;
  region: string;
} {
  const configPath = resolve(options.config);
  const configDir = dirname(configPath);
  const loaded = ctx.deps.loadConfig(options.config);
  const region = effectiveRegion(options, loaded, ctx.env);
  const config =
    region === loaded.defaultRegion
      ? loaded
      : { ...loaded, defaultRegion: region };
  return {
    config,
    configPath,
    configDir,
    templates: ctx.deps.readTemplates(config, configDir),
    profile: effectiveProfile(options, ctx.env),
    region,
  };
}

function renderStatusText(
  entries: Array<{
    stackKey: string;
    changeType: string;
    region: string;
  }>,
): string {
  const lines = ['CHANGE    REGION                STACK KEY'];
  for (const entry of entries) {
    lines.push(
      `${entry.changeType.padEnd(10)}${entry.region.padEnd(22)}${entry.stackKey}`,
    );
  }
  return lines.join('\n');
}

export async function runStatus(
  ctx: CommandContext,
  options: CommonOptions,
): Promise<0> {
  const input = loadInputs(ctx, options);
  const result = await ctx.deps.getStatus({
    config: input.config,
    templates: input.templates,
    backend: ctx.deps.createBackend({
      config: input.config,
      configDir: input.configDir,
      profile: input.profile,
    }),
  });
  const output =
    options.output === 'json'
      ? JSON.stringify(result, null, 2)
      : renderStatusText(result.entries);
  writeLine(ctx.io.stdout, output);
  return 0;
}

export async function runGraph(
  ctx: CommandContext,
  options: CommonOptions,
): Promise<0> {
  const input = loadInputs(ctx, options);
  const result = ctx.deps.getGraph({
    config: input.config,
    templates: input.templates,
  });
  for (const warning of result.warnings)
    writeLine(ctx.io.stderr, `warning: ${warning}`);
  writeLine(
    ctx.io.stdout,
    options.output === 'json'
      ? renderGraphJson(result.graphs)
      : renderGraphText(result.graphs),
  );
  return 0;
}

function deploymentDeps(
  ctx: CommandContext,
  input: ReturnType<typeof loadInputs>,
) {
  return {
    cfnFactory: (region: string) =>
      ctx.deps.createCfn({ region, profile: input.profile }),
    sts: ctx.deps.createSts({ region: input.region, profile: input.profile }),
    backend: ctx.deps.createBackend({
      config: input.config,
      configDir: input.configDir,
      profile: input.profile,
    }),
    onEvent: (event: {
      stackKey: string;
      resourceStatus: string;
      logicalResourceId: string;
    }) => {
      writeLine(
        ctx.io.stderr,
        `[${event.stackKey}] ${event.logicalResourceId} ${event.resourceStatus}`,
      );
    },
  };
}

export async function runDeployment(
  ctx: CommandContext,
  options: CommonOptions & {
    dryRun?: boolean;
    allowDelete?: boolean;
    onFailure?: 'stop' | 'continue';
  },
): Promise<0 | 1 | 2> {
  const input = loadInputs(ctx, options);
  const result = await ctx.deps.deploy({
    config: input.config,
    configDir: input.configDir,
    templates: input.templates,
    deps: deploymentDeps(ctx, input),
    options: {
      dryRun: options.dryRun === true,
      allowDelete: options.allowDelete === true,
      onFailure: options.onFailure ?? 'stop',
    },
  });
  writeLine(
    ctx.io.stdout,
    options.output === 'json'
      ? renderJson(result.report)
      : renderText(result.report),
  );
  return result.exitCode;
}

export async function runImporter(
  ctx: CommandContext,
  options: CommonOptions & {
    reconcile?: 'remote' | 'local';
    writeTemplate?: boolean;
  },
): Promise<0 | 1> {
  const input = loadInputs(ctx, options);
  const result = await ctx.deps.runImport({
    config: input.config,
    configPath: input.configPath,
    deps: {
      cfnFactory: (region) =>
        ctx.deps.createCfn({ region, profile: input.profile }),
      sts: ctx.deps.createSts({ region: input.region, profile: input.profile }),
      backend: ctx.deps.createBackend({
        config: input.config,
        configDir: input.configDir,
        profile: input.profile,
      }),
    },
    options: {
      reconcile: options.reconcile,
      writeTemplate: options.writeTemplate === true,
    },
  });
  for (const warning of result.report.warnings)
    writeLine(ctx.io.stderr, `warning: ${warning}`);
  writeLine(
    ctx.io.stdout,
    options.output === 'json'
      ? JSON.stringify(result.report, null, 2)
      : result.report.stacks
          .map((stack) => `${stack.status}: ${stack.stackKey}`)
          .join('\n') || 'import 対象はありません。',
  );
  return result.exitCode;
}

export async function runForceUnlock(
  ctx: CommandContext,
  options: CommonOptions,
  runId: string,
): Promise<0 | 1> {
  const input = loadInputs(ctx, options);
  const result = await ctx.deps.forceUnlock({
    backend: ctx.deps.createBackend({
      config: input.config,
      configDir: input.configDir,
      profile: input.profile,
    }),
    runId,
  });
  writeLine(
    result.exitCode === 0 ? ctx.io.stdout : ctx.io.stderr,
    options.output === 'json'
      ? JSON.stringify(result, null, 2)
      : result.message,
  );
  return result.exitCode;
}

export async function defaultConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
