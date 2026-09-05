import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { renderApprovalSummary } from '../report/index.js';
import {
  type CfnSyncConfig,
  renderDeploy,
  renderGraph,
  renderStatus,
  validateEffectiveConfig,
} from '../usecase/cliBoundary.js';
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

/**
 * FR-7-9a〜FR-7-9d / design §3: 対象リージョンは `--region` と設定の `defaultRegion`
 * だけで決まる。`AWS_REGION` / `AWS_DEFAULT_REGION` は読まない — 環境変数を既定リージョンへ
 * 暗黙に反映すると、同じ設定ファイルでも実行環境によって管理単位のスタックキー
 * `<template>@<region>` が変わり、変更検知が旧リージョンを `deleted`、新リージョンを
 * `added` と分類してしまうためである(FR-7-9c)。これらの環境変数は AWS SDK 側の既定
 * リージョン解決にのみ影響し、cfnsync は解決済みリージョンを常に明示的に渡す(FR-7-9d)。
 */
function effectiveRegion(
  options: CommonOptions,
  config: CfnSyncConfig,
): string {
  return options.region ?? config.defaultRegion;
}

function loadBaseInputs(
  ctx: CommandContext,
  options: CommonOptions,
  loadOptions: {
    allowMissingTemplates?: boolean;
    validateTemplateFiles?: boolean;
  } = {},
): {
  config: CfnSyncConfig;
  configPath: string;
  configDir: string;
  profile?: string;
  region: string;
} {
  const configPath = resolve(options.config);
  const configDir = dirname(configPath);
  const loaded =
    Object.keys(loadOptions).length === 0
      ? ctx.deps.loadConfig(options.config)
      : ctx.deps.loadConfig(options.config, loadOptions);
  const region = effectiveRegion(options, loaded);
  const config =
    region === loaded.defaultRegion
      ? loaded
      : { ...loaded, defaultRegion: region };
  validateEffectiveConfig(config);
  return {
    config,
    configPath,
    configDir,
    profile: effectiveProfile(options, ctx.env),
    region,
  };
}

function loadInputs(ctx: CommandContext, options: CommonOptions) {
  const input = loadBaseInputs(ctx, options);
  return {
    ...input,
    templates: ctx.deps.readTemplates(input.config, input.configDir),
  };
}

function cachedCfnFactory(
  create: (region: string) => ReturnType<CliDependencies['createCfn']>,
) {
  const byRegion = new Map<string, ReturnType<CliDependencies['createCfn']>>();
  return (region: string) => {
    let gateway = byRegion.get(region);
    if (gateway === undefined) {
      gateway = create(region);
      byRegion.set(region, gateway);
    }
    return gateway;
  };
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
  const output = renderStatus(result.entries, options.output === 'json');
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
    renderGraph(result.graphs, options.output === 'json'),
  );
  return 0;
}

function deploymentDeps(
  ctx: CommandContext,
  input: ReturnType<typeof loadInputs>,
) {
  const cfnFactory = cachedCfnFactory((region) =>
    ctx.deps.createCfn({ region, profile: input.profile }),
  );
  return {
    cfnFactory,
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
    onProgress: (event: { stackKey: string; message: string }) => {
      writeLine(ctx.io.stderr, `[${event.stackKey}] ${event.message}`);
    },
  };
}

export async function runDeployment(
  ctx: CommandContext,
  options: CommonOptions & {
    /** FR-5-20a / design §5.3.5: plan 経路を表す内部フラグ。plan サブコマンドだけが
     *  設定し、公開 CLI オプション(旧 `deploy --dry-run`)としては提供しない。 */
    dryRun?: boolean;
    allowDelete?: boolean;
    onFailure?: 'stop' | 'continue';
    autoApprove?: boolean;
    color?: boolean;
    /** FR-5-2a: 承認プロンプト。TTY 実装は CLI 側で注入する(design §5.3.2)。 */
    prompt?: (question: string) => Promise<boolean>;
  },
): Promise<0 | 1 | 2> {
  const input = loadInputs(ctx, options);
  const color = options.color !== false && !Object.hasOwn(ctx.env, 'NO_COLOR');
  const prompt = options.prompt ?? defaultConfirm;
  const result = await ctx.deps.deploy({
    config: input.config,
    templates: input.templates,
    deps: {
      ...deploymentDeps(ctx, input),
      // FR-3-7b / FR-5-6f: 承認要約もプロンプトも標準エラーへ出し、
      // 標準出力の単一 JSON document 契約(FR-12-6a/b)を壊さない。
      approve: async (request) => {
        writeLine(ctx.io.stderr, renderApprovalSummary(request, { color }));
        return prompt('Do you want to perform these actions?');
      },
    },
    options: {
      dryRun: options.dryRun === true,
      allowDelete: options.allowDelete === true,
      onFailure: options.onFailure ?? 'stop',
      collectEvents: options.output === 'json',
      autoApprove: options.autoApprove === true,
    },
  });
  // FR-12-6c2: text 選択時は標準エラーへキャンセル診断を出し、report は従来どおり
  // 標準出力へ出す。JSON 選択時は report に cancelled: true が載るため診断は出さない
  // (標準出力の単一 JSON document 契約を保つ)。
  if (result.report.cancelled === true && options.output !== 'json') {
    writeLine(ctx.io.stderr, 'Deployment cancelled.');
  }
  writeLine(
    ctx.io.stdout,
    renderDeploy(result.report, options.output === 'json', color),
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
  const input = loadBaseInputs(ctx, options, {
    allowMissingTemplates: options.writeTemplate === true,
  });
  const cfnFactory = cachedCfnFactory((region) =>
    ctx.deps.createCfn({ region, profile: input.profile }),
  );
  const result = await ctx.deps.runImport({
    config: input.config,
    configPath: input.configPath,
    templatePaths: ctx.deps.resolveTemplatePaths(input.config, input.configDir),
    deps: {
      cfnFactory,
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
  const warnings =
    options.output === 'json'
      ? result.report.warnings
      : (result.textDiagnostics ?? result.report.warnings);
  for (const warning of warnings)
    writeLine(ctx.io.stderr, `warning: ${warning}`);
  writeLine(
    ctx.io.stdout,
    options.output === 'json'
      ? JSON.stringify(result.report, null, 2)
      : result.report.stacks
          .map((stack) => `${stack.status}: ${stack.stackKey}`)
          .join('\n') || 'No stacks to import.',
  );
  return result.exitCode;
}

export async function runForceUnlock(
  ctx: CommandContext,
  options: CommonOptions,
  runId: string,
): Promise<0 | 1> {
  const input = loadBaseInputs(ctx, options, { validateTemplateFiles: false });
  const result = await ctx.deps.forceUnlock({
    backend: ctx.deps.createBackend({
      config: input.config,
      configDir: input.configDir,
      profile: input.profile,
    }),
    runId,
  });
  writeLine(
    options.output === 'json' || result.exitCode === 0
      ? ctx.io.stdout
      : ctx.io.stderr,
    options.output === 'json'
      ? JSON.stringify(result, null, 2)
      : result.message,
  );
  return result.exitCode;
}

/**
 * 承認プロンプトが利用者の中断で終わったか。Node の readline は Ctrl-D(空行での
 * EOF)と Ctrl-C を `AbortError`(`code: 'ABORT_ERR'`)で reject する
 * (node:internal/readline/interface の Ctrl キー処理)。`rl.question` へ
 * `options.signal` を渡していないため AbortError の発生源はこの 2 経路しかなく、
 * stdin の破損等の予期しない失敗をここで No に倒して隠すことはない。
 */
function isPromptAborted(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      (error as { code?: unknown }).code === 'ABORT_ERR')
  );
}

/**
 * FR-5-2a / design §5.3.2: 承認プロンプト。`y` / `yes`(大文字小文字を問わない)
 * だけを承認とし、空入力・不正入力は No(fail-closed)とする。Ctrl-D(EOF)と
 * Ctrl-C も「承認が得られなかった」状態であり同じ No として扱う — 例外のまま
 * 送出すると usecase の承認拒否パスを迂回し、Phase A で作成済みの変更セットが
 * 回収されずに AWS へ残る(FR-5-10a)。
 */
export async function defaultConfirm(
  question: string,
  io: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
  } = {},
): Promise<boolean> {
  // readline は `output.isTTY` で terminal(キー単位の解釈)モードを決める。
  // 本関数へ到達するのは stdin・stderr がともに TTY のときだけ(FR-12-3b の
  // 非 TTY ガード)なので、実運用では常に terminal モードになる。
  const rl = createInterface({
    input: io.input ?? process.stdin,
    output: io.output ?? process.stderr,
  });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } catch (error) {
    if (!isPromptAborted(error)) throw error;
    return false;
  } finally {
    rl.close();
  }
}
