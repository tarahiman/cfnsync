/**
 * T-08 aws/CloudFormationGateway — `CloudFormationGateway`(ports)の SDK v3 実装。
 *
 * design.md §7(変更セットライフサイクル)/ §9(リトライ)/ NFR-3 に対応する。
 *
 * リトライについての注意(scratchpad/api-notes.md):
 *   `aws-sdk-client-mock` は `send` をスタブするため SDK 内部のリトライミドルウェアは
 *   モックでは動かない。そこで (a) クライアントを `retryMode: 'adaptive'` で構成しつつ、
 *   (b) スロットリング応答に対してはゲートウェイ層の薄いリトライヘルパ(`withRetry`)で
 *   指数バックオフ再試行する。ポーリング間隔・sleep はコンストラクタ注入でテスト短縮可能。
 */

import {
  type Capability,
  CloudFormationClient,
  CreateChangeSetCommand,
  DeleteChangeSetCommand,
  DeleteStackCommand,
  DescribeChangeSetCommand,
  type DescribeChangeSetCommandOutput,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  type DescribeStacksCommandOutput,
  ExecuteChangeSetCommand,
  GetTemplateCommand,
  ListChangeSetsCommand,
} from '@aws-sdk/client-cloudformation';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { AwsError } from '../core/errors.js';
import type {
  ChangeSetDetail,
  ChangeSetSummary,
  CloudFormationGateway,
  CreateChangeSetInput,
  ResourceChange,
  StackEvent,
  StackSummary,
  TemplateStage,
  WaitForStackOptions,
} from '../ports/index.js';

/** `CloudFormationGatewayImpl` のコンストラクタオプション。 */
export interface CloudFormationGatewayOptions {
  region: string;
  /** `~/.aws/config` のプロファイル(FR-7-1)。指定時は既定クレデンシャルチェーンに profile を適用。 */
  profile?: string;
  /** SDK クライアントの maxAttempts(NFR-3)。既定 10。 */
  maxAttempts?: number;
  /** ゲートウェイ層スロットリングリトライの最大再試行回数。既定 10。 */
  maxRetries?: number;
  /** スロットリングリトライの基底バックオフ(ms)。既定 100。 */
  baseDelayMs?: number;
  /** 待機ポーリング間隔(ms)。既定 5000。テストで 0 を注入。 */
  pollIntervalMs?: number;
  /** 待機タイムアウト(ms)。既定 30 分。 */
  pollTimeoutMs?: number;
  /** バックオフ・ポーリングの sleep。既定は setTimeout。テストで no-op を注入。 */
  sleep?: (ms: number) => Promise<void>;
}

/** スロットリングとして再試行するエラー名(api-notes.md の 3 種 + 一般的な throttle 名)。 */
const THROTTLING_ERROR_NAMES = new Set([
  'ThrottlingException',
  'Throttling',
  'TooManyRequestsException',
  'RequestLimitExceeded',
  'ProvisionedThroughputExceededException',
]);

function errorName(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'name' in err
    ? ((err as { name?: unknown }).name as string | undefined)
    : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isThrottlingError(err: unknown): boolean {
  const name = errorName(err);
  return typeof name === 'string' && THROTTLING_ERROR_NAMES.has(name);
}

/** `DescribeStacks` の「スタック不存在」ValidationError を判定する(§7)。 */
function isStackNotExistError(err: unknown): boolean {
  return (
    errorName(err) === 'ValidationError' &&
    /does not exist/i.test(errorMessage(err))
  );
}

/** スタックのステータスが終端(進行中でない)か。`REVIEW_IN_PROGRESS` 等の `_IN_PROGRESS` は非終端。 */
function isStackTerminal(status: string): boolean {
  return (
    status !== '' &&
    !status.endsWith('_IN_PROGRESS') &&
    !status.endsWith('_PENDING')
  );
}

/** 変更セットのステータスが終端(`CREATE_COMPLETE` / `FAILED` / `DELETE_*` / `OBSOLETE`)か。 */
function isChangeSetTerminal(status: string): boolean {
  return (
    status !== '' &&
    !status.endsWith('_IN_PROGRESS') &&
    !status.endsWith('_PENDING')
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function pairsToRecord<T>(
  items: readonly T[] | undefined,
  key: (item: T) => string | undefined,
  val: (item: T) => string | undefined,
): Record<string, string> {
  const record: Record<string, string> = {};
  for (const item of items ?? []) {
    const k = key(item);
    if (k === undefined) continue;
    record[k] = val(item) ?? '';
  }
  return record;
}

function recordToParameters(
  record: Record<string, string>,
): { ParameterKey: string; ParameterValue: string }[] {
  return Object.entries(record).map(([ParameterKey, ParameterValue]) => ({
    ParameterKey,
    ParameterValue,
  }));
}

function recordToTags(
  record: Record<string, string>,
): { Key: string; Value: string }[] {
  return Object.entries(record).map(([Key, Value]) => ({ Key, Value }));
}

function toIso(value: Date | undefined): string | undefined {
  return value instanceof Date ? value.toISOString() : undefined;
}

export class CloudFormationGatewayImpl implements CloudFormationGateway {
  /** テスト・診断のために公開(config の retryMode / maxAttempts を確認できる)。 */
  readonly client: CloudFormationClient;

  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: CloudFormationGatewayOptions) {
    this.maxRetries = options.maxRetries ?? 10;
    this.baseDelayMs = options.baseDelayMs ?? 100;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 30 * 60 * 1_000;
    this.sleep = options.sleep ?? defaultSleep;

    this.client = new CloudFormationClient({
      region: options.region,
      // NFR-3: スロットリングに指数バックオフでリトライ。
      retryMode: 'adaptive',
      maxAttempts: options.maxAttempts ?? 10,
      // FR-7-1: profile 指定時のみ、既定クレデンシャルチェーンに profile を適用する。
      // 未指定時は SDK 標準チェーン(環境変数 → プロファイル → IAM ロール)に委ねる(FR-7-2)。
      ...(options.profile !== undefined
        ? { credentials: defaultProvider({ profile: options.profile }) }
        : {}),
    });
  }

  /**
   * SDK 呼び出しをスロットリングリトライで包む(NFR-3)。スロットリング名のエラーのみ
   * 指数バックオフ(注入 sleep)で再試行し、上限超過・非スロットリングは即伝播する。
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (isThrottlingError(err) && attempt < this.maxRetries) {
          await this.sleep(this.baseDelayMs * 2 ** attempt);
          attempt += 1;
          continue;
        }
        throw err;
      }
    }
  }

  async describeStack(stackName: string): Promise<StackSummary | undefined> {
    let output: DescribeStacksCommandOutput;
    try {
      output = await this.withRetry(() =>
        this.client.send(new DescribeStacksCommand({ StackName: stackName })),
      );
    } catch (err) {
      // §7: スタック不存在(ValidationError)は「スタックなし」= undefined に吸収。
      if (isStackNotExistError(err)) return undefined;
      throw err;
    }

    const stack = output.Stacks?.[0];
    if (!stack) return undefined;

    return {
      stackName: stack.StackName ?? stackName,
      stackId: stack.StackId ?? '',
      status: stack.StackStatus ?? '',
      statusReason: stack.StackStatusReason,
      parameters: pairsToRecord(
        stack.Parameters,
        (p) => p.ParameterKey,
        (p) => p.ParameterValue,
      ),
      tags: pairsToRecord(
        stack.Tags,
        (t) => t.Key,
        (t) => t.Value,
      ),
      capabilities: stack.Capabilities ?? [],
      outputs: pairsToRecord(
        stack.Outputs,
        (o) => o.OutputKey,
        (o) => o.OutputValue,
      ),
      terminationProtection: stack.EnableTerminationProtection ?? false,
    };
  }

  async listChangeSets(stackName: string): Promise<ChangeSetSummary[]> {
    const summaries: ChangeSetSummary[] = [];
    let nextToken: string | undefined;

    // §7(Codex 承認条件): NextToken を辿って全ページを走査する。
    do {
      const output = await this.withRetry(() =>
        this.client.send(
          new ListChangeSetsCommand({
            StackName: stackName,
            NextToken: nextToken,
          }),
        ),
      );
      for (const summary of output.Summaries ?? []) {
        summaries.push({
          name: summary.ChangeSetName ?? '',
          id: summary.ChangeSetId ?? '',
          status: summary.Status ?? '',
          statusReason: summary.StatusReason,
          executionStatus: summary.ExecutionStatus,
          creationTime: toIso(summary.CreationTime),
        });
      }
      nextToken = output.NextToken;
    } while (nextToken);

    return summaries;
  }

  async createChangeSet(input: CreateChangeSetInput): Promise<{ id: string }> {
    const output = await this.withRetry(() =>
      this.client.send(
        new CreateChangeSetCommand({
          StackName: input.stackName,
          ChangeSetName: input.changeSetName,
          ChangeSetType: input.changeSetType,
          TemplateBody: input.templateBody,
          Parameters: recordToParameters(input.parameters),
          // config は Capabilities を string[] で保持する。SDK の Capability 列挙へ境界でキャスト。
          Capabilities: input.capabilities as Capability[],
          Tags: recordToTags(input.tags),
          Description: input.description,
        }),
      ),
    );
    return { id: output.Id ?? '' };
  }

  async describeChangeSet(
    stackName: string,
    changeSetName: string,
  ): Promise<ChangeSetDetail> {
    const changes: ResourceChange[] = [];
    let nextToken: string | undefined;
    let firstPage: DescribeChangeSetCommandOutput | undefined;

    // Changes の NextToken を辿って全ページ結合(FR-2 / FR-3)。
    do {
      const output = await this.withRetry(() =>
        this.client.send(
          new DescribeChangeSetCommand({
            StackName: stackName,
            ChangeSetName: changeSetName,
            NextToken: nextToken,
          }),
        ),
      );
      if (firstPage === undefined) firstPage = output;
      for (const change of output.Changes ?? []) {
        changes.push(normalizeResourceChange(change));
      }
      nextToken = output.NextToken;
    } while (nextToken);

    const first = firstPage!;
    return {
      name: first.ChangeSetName,
      id: first.ChangeSetId,
      stackId: first.StackId,
      status: first.Status ?? '',
      statusReason: first.StatusReason,
      executionStatus: first.ExecutionStatus,
      changes,
      parameters: pairsToRecord(
        first.Parameters,
        (p) => p.ParameterKey,
        (p) => p.ParameterValue,
      ),
      tags: pairsToRecord(
        first.Tags,
        (t) => t.Key,
        (t) => t.Value,
      ),
      capabilities: first.Capabilities ?? [],
    };
  }

  async waitForChangeSet(
    stackName: string,
    changeSetName: string,
  ): Promise<ChangeSetDetail> {
    const deadline = Date.now() + this.pollTimeoutMs;
    for (;;) {
      const detail = await this.describeChangeSet(stackName, changeSetName);
      if (isChangeSetTerminal(detail.status)) return detail;
      if (Date.now() >= deadline) {
        throw new AwsError(
          `変更セットの完了待機がタイムアウトしました: ${changeSetName}`,
          {
            stackKey: stackName,
          },
        );
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  async deleteChangeSet(
    stackName: string,
    changeSetName: string,
  ): Promise<void> {
    await this.withRetry(() =>
      this.client.send(
        new DeleteChangeSetCommand({
          StackName: stackName,
          ChangeSetName: changeSetName,
        }),
      ),
    );
  }

  async executeChangeSet(
    stackName: string,
    changeSetName: string,
  ): Promise<void> {
    await this.withRetry(() =>
      this.client.send(
        new ExecuteChangeSetCommand({
          StackName: stackName,
          ChangeSetName: changeSetName,
        }),
      ),
    );
  }

  async deleteStack(stackName: string): Promise<void> {
    await this.withRetry(() =>
      this.client.send(new DeleteStackCommand({ StackName: stackName })),
    );
  }

  async describeStackEvents(
    stackName: string,
    seenEventIds?: Set<string>,
  ): Promise<StackEvent[]> {
    const seen = seenEventIds ?? new Set<string>();
    // AWS は新しい順に返す。ページ順(newest-first)で貯め、最後に反転して古い順にする。
    const collectedNewestFirst: StackEvent[] = [];
    let nextToken: string | undefined;

    do {
      const output = await this.withRetry(() =>
        this.client.send(
          new DescribeStackEventsCommand({
            StackName: stackName,
            NextToken: nextToken,
          }),
        ),
      );
      const pageEvents = output.StackEvents ?? [];
      let newInPage = 0;
      for (const event of pageEvents) {
        if (event.EventId !== undefined && seen.has(event.EventId)) continue;
        collectedNewestFirst.push({
          eventId: event.EventId ?? '',
          timestamp: toIso(event.Timestamp) ?? '',
          logicalResourceId: event.LogicalResourceId ?? '',
          resourceType: event.ResourceType ?? '',
          resourceStatus: event.ResourceStatus ?? '',
          resourceStatusReason: event.ResourceStatusReason,
        });
        newInPage += 1;
      }
      nextToken = output.NextToken;
      // イベントは厳密に新しい順。ページ全体が既読なら、それより古いページも既読なので打ち切る。
      if (pageEvents.length > 0 && newInPage === 0) break;
    } while (nextToken);

    // 新着のみを古い順(oldest-first)で返す。
    return collectedNewestFirst.reverse();
  }

  async getTemplate(stackName: string, stage: TemplateStage): Promise<string> {
    const output = await this.withRetry(() =>
      this.client.send(
        new GetTemplateCommand({ StackName: stackName, TemplateStage: stage }),
      ),
    );
    return output.TemplateBody ?? '';
  }

  async waitForStack(
    stackName: string,
    opts: WaitForStackOptions = {},
  ): Promise<StackSummary> {
    const interval = opts.intervalMs ?? this.pollIntervalMs;
    const timeout = opts.timeoutMs ?? this.pollTimeoutMs;
    const deadline = Date.now() + timeout;
    const seen = new Set<string>();
    let last: StackSummary | undefined;

    for (;;) {
      const summary = await this.describeStack(stackName);

      // FR-4-1: 待機中の新着イベントを古い順で逐次通知する。
      if (opts.onEvent) {
        const events = await this.describeStackEvents(stackName, seen);
        for (const event of events) {
          seen.add(event.eventId);
          opts.onEvent(event);
        }
      }

      if (!summary) {
        // スタックが消えた(DELETE 完了)。直前要約があればそれを DELETE_COMPLETE として返す。
        return last
          ? { ...last, status: 'DELETE_COMPLETE', statusReason: undefined }
          : {
              stackName,
              stackId: '',
              status: 'DELETE_COMPLETE',
              parameters: {},
              tags: {},
              capabilities: [],
              outputs: {},
              terminationProtection: false,
            };
      }

      last = summary;
      if (isStackTerminal(summary.status)) return summary;
      if (Date.now() >= deadline) {
        throw new AwsError(
          `スタックの完了待機がタイムアウトしました: ${stackName}`,
          { stackKey: stackName },
        );
      }
      await this.sleep(interval);
    }
  }
}

/** `DescribeChangeSet` の Change 要素を正規化する。 */
function normalizeResourceChange(change: {
  ResourceChange?: {
    Action?: string;
    LogicalResourceId?: string;
    PhysicalResourceId?: string;
    ResourceType?: string;
    Replacement?: string;
    Scope?: string[];
    Details?: {
      Target?: {
        Attribute?: string;
        Name?: string;
        RequiresRecreation?: string;
      };
      Evaluation?: string;
      ChangeSource?: string;
      CausingEntity?: string;
    }[];
  };
}): ResourceChange {
  const rc = change.ResourceChange ?? {};
  return {
    action: rc.Action ?? '',
    logicalResourceId: rc.LogicalResourceId ?? '',
    physicalResourceId: rc.PhysicalResourceId,
    resourceType: rc.ResourceType ?? '',
    replacement: rc.Replacement,
    scope: rc.Scope ?? [],
    details: (rc.Details ?? []).map((d) => ({
      target: d.Target
        ? {
            attribute: d.Target.Attribute,
            name: d.Target.Name,
            requiresRecreation: d.Target.RequiresRecreation,
          }
        : undefined,
      evaluation: d.Evaluation,
      changeSource: d.ChangeSource,
      causingEntity: d.CausingEntity,
    })),
  };
}
