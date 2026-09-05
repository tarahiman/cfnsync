/**
 * T-08 aws/CloudFormationGateway — `CloudFormationGateway`(ports)の SDK v3 実装。
 *
 * design.md §7(変更セットライフサイクル)/ §9(リトライ)/ NFR-3 に対応する。
 *
 * 本番のリトライは SDK の adaptive retry へ一本化する。外側リトライは既定 0 で、
 * SDK middleware を通らないテストクライアントの障害注入時だけ明示的に有効化できる。
 */

import {
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
  StackEventCursor,
  StackSummary,
  TemplateStage,
  WaitForStackOptions,
} from '../ports/index.js';
import { errorMessage, errorName, toAwsError } from './errors.js';

/** `CloudFormationGatewayImpl` のコンストラクタオプション。 */
export interface CloudFormationGatewayOptions {
  region: string;
  /** `~/.aws/config` のプロファイル(FR-7-1)。指定時は既定クレデンシャルチェーンに profile を適用。 */
  profile?: string;
  /** SDK クライアントの maxAttempts(NFR-3)。既定 10。 */
  maxAttempts?: number;
  /** テスト用外側再試行回数。本番既定は 0。 */
  maxRetries?: number;
  /** スロットリングリトライの基底バックオフ(ms)。既定 100。 */
  baseDelayMs?: number;
  /** ゲートウェイ層リトライの総経過時間上限(ms)。既定 60 秒。 */
  maxRetryElapsedMs?: number;
  /** full jitter 用乱数。既定 Math.random。テストで固定値を注入。 */
  random?: () => number;
  /** リトライ経過時間を測る時計。既定 Date.now。テストで注入。 */
  retryNow?: () => number;
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
  private readonly maxRetryElapsedMs: number;
  private readonly random: () => number;
  private readonly retryNow: () => number;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: CloudFormationGatewayOptions) {
    this.maxRetries = options.maxRetries ?? 0;
    this.baseDelayMs = options.baseDelayMs ?? 100;
    this.maxRetryElapsedMs = options.maxRetryElapsedMs ?? 60_000;
    this.random = options.random ?? Math.random;
    this.retryNow = options.retryNow ?? Date.now;
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
  private async withRetry<T>(
    operation: string,
    fn: () => Promise<T>,
    passthrough?: (error: unknown) => boolean,
  ): Promise<T> {
    let attempt = 0;
    const startedAt = this.retryNow();
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (isThrottlingError(err) && attempt < this.maxRetries) {
          const elapsed = Math.max(0, this.retryNow() - startedAt);
          const remaining = this.maxRetryElapsedMs - elapsed;
          if (remaining > 0) {
            // Full jitter: [0, exponential cap)。上限までの残り時間を超えて待たない。
            const exponentialCap = this.baseDelayMs * 2 ** attempt;
            const delay = Math.min(
              Math.floor(this.random() * exponentialCap),
              remaining,
            );
            await this.sleep(delay);
            if (this.retryNow() - startedAt < this.maxRetryElapsedMs) {
              attempt += 1;
              continue;
            }
          }
        }
        if (passthrough?.(err)) throw err;
        throw toAwsError(`CloudFormation ${operation}`, err);
      }
    }
  }

  async describeStack(stackName: string): Promise<StackSummary | undefined> {
    let output: DescribeStacksCommandOutput;
    try {
      output = await this.withRetry(
        'DescribeStacks',
        () =>
          this.client.send(new DescribeStacksCommand({ StackName: stackName })),
        isStackNotExistError,
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
      const output = await this.withRetry('ListChangeSets', () =>
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

  async createChangeSet(
    input: CreateChangeSetInput,
  ): Promise<{ id: string; stackId?: string }> {
    const output = await this.withRetry('CreateChangeSet', () =>
      this.client.send(
        new CreateChangeSetCommand({
          StackName: input.stackName,
          ChangeSetName: input.changeSetName,
          ChangeSetType: input.changeSetType,
          TemplateBody: input.templateBody,
          Parameters: recordToParameters(input.parameters),
          Capabilities: input.capabilities,
          Tags: recordToTags(input.tags),
          Description: input.description,
        }),
      ),
    );
    // StackId は CREATE 型でこの呼び出しが作った REVIEW_IN_PROGRESS の殻の ARN。
    // 承認待ちを挟んだ実行直前再検査(FR-5-17c2)で「自身の変更セットに対応する殻か」を
    // 照合するため、そのまま持ち帰る。
    return { id: output.Id ?? '', stackId: output.StackId };
  }

  async describeChangeSet(
    stackName: string,
    changeSetName: string,
  ): Promise<ChangeSetDetail> {
    const firstPage = await this.fetchChangeSetPage(
      stackName,
      changeSetName,
      undefined,
    );
    return this.collectChangeSetPages(stackName, changeSetName, firstPage);
  }

  private async fetchChangeSetPage(
    stackName: string,
    changeSetName: string,
    nextToken: string | undefined,
  ): Promise<DescribeChangeSetCommandOutput> {
    return this.withRetry('DescribeChangeSet', () =>
      this.client.send(
        new DescribeChangeSetCommand({
          StackName: stackName,
          ChangeSetName: changeSetName,
          NextToken: nextToken,
          // FR-3: CloudFormation 自身が算出したプロパティ前後値を取得する。
          IncludePropertyValues: true,
        }),
      ),
    );
  }

  private async collectChangeSetPages(
    stackName: string,
    changeSetName: string,
    firstPage: DescribeChangeSetCommandOutput,
  ): Promise<ChangeSetDetail> {
    const changes: ResourceChange[] = [];
    let page = firstPage;

    // Changes の NextToken を辿って全ページ結合(FR-2 / FR-3)。
    for (;;) {
      for (const change of page.Changes ?? []) {
        changes.push(normalizeResourceChange(change));
      }
      if (!page.NextToken) break;
      page = await this.fetchChangeSetPage(
        stackName,
        changeSetName,
        page.NextToken,
      );
    }

    const first = firstPage;
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
      // 待機中は Status がある先頭ページだけを確認し、Changes の残りページは
      // 終端到達時に一度だけ取得する。大規模変更セットの q×c 再取得を避ける。
      const firstPage = await this.fetchChangeSetPage(
        stackName,
        changeSetName,
        undefined,
      );
      if (isChangeSetTerminal(firstPage.Status ?? '')) {
        return this.collectChangeSetPages(stackName, changeSetName, firstPage);
      }
      if (Date.now() >= deadline) {
        throw new AwsError(
          `Timed out waiting for the change set to complete: ${changeSetName}`,
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
    await this.withRetry('DeleteChangeSet', () =>
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
    await this.withRetry('ExecuteChangeSet', () =>
      this.client.send(
        new ExecuteChangeSetCommand({
          StackName: stackName,
          ChangeSetName: changeSetName,
        }),
      ),
    );
  }

  async deleteStack(stackName: string): Promise<void> {
    await this.withRetry('DeleteStack', () =>
      this.client.send(new DeleteStackCommand({ StackName: stackName })),
    );
  }

  async getStackEventCursor(stackName: string): Promise<StackEventCursor> {
    const capturedAt = new Date().toISOString();
    const output = await this.withRetry('DescribeStackEvents', () =>
      this.client.send(
        new DescribeStackEventsCommand({ StackName: stackName }),
      ),
    );
    const latest = output.StackEvents?.[0];
    return {
      eventId: latest?.EventId,
      timestamp: toIso(latest?.Timestamp) ?? capturedAt,
    };
  }

  async describeStackEvents(
    stackName: string,
    seenEventIds?: Set<string>,
    after?: StackEventCursor,
  ): Promise<StackEvent[]> {
    const seen = seenEventIds ?? new Set<string>();
    // AWS は新しい順に返す。ページ順(newest-first)で貯め、最後に反転して古い順にする。
    const collectedNewestFirst: StackEvent[] = [];
    let nextToken: string | undefined;

    do {
      const output = await this.withRetry('DescribeStackEvents', () =>
        this.client.send(
          new DescribeStackEventsCommand({
            StackName: stackName,
            NextToken: nextToken,
          }),
        ),
      );
      const pageEvents = output.StackEvents ?? [];
      let newInPage = 0;
      let reachedBoundary = false;
      for (const event of pageEvents) {
        const timestamp = toIso(event.Timestamp) ?? '';
        if (
          (after?.eventId !== undefined && event.EventId === after.eventId) ||
          (after?.eventId === undefined &&
            timestamp !== '' &&
            timestamp <= (after?.timestamp ?? '')) ||
          (after?.eventId !== undefined &&
            timestamp !== '' &&
            timestamp < after.timestamp)
        ) {
          reachedBoundary = true;
          break;
        }
        if (event.EventId !== undefined && seen.has(event.EventId)) continue;
        collectedNewestFirst.push({
          eventId: event.EventId ?? '',
          timestamp,
          logicalResourceId: event.LogicalResourceId ?? '',
          resourceType: event.ResourceType ?? '',
          resourceStatus: event.ResourceStatus ?? '',
          resourceStatusReason: event.ResourceStatusReason,
        });
        newInPage += 1;
      }
      nextToken = output.NextToken;
      if (reachedBoundary) break;
      // イベントは厳密に新しい順。ページ全体が既読なら、それより古いページも既読なので打ち切る。
      if (pageEvents.length > 0 && newInPage === 0) break;
    } while (nextToken);

    // 新着のみを古い順(oldest-first)で返す。
    return collectedNewestFirst.reverse();
  }

  async getTemplate(stackName: string, stage: TemplateStage): Promise<string> {
    const output = await this.withRetry('GetTemplate', () =>
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
    const eventCursor = opts.onEvent
      ? (opts.eventCursor ?? (await this.getStackEventCursor(stackName)))
      : undefined;
    let last: StackSummary | undefined;
    let statusDelay = interval;
    let untilStatusPoll = 0;

    for (;;) {
      let summary = last;
      if (untilStatusPoll <= 0) {
        summary = await this.describeStack(stackName);
        last = summary;
        untilStatusPoll = statusDelay;
        statusDelay = Math.min(15_000, statusDelay + interval);
      }

      // FR-4-1: 待機中の新着イベントを古い順で逐次通知する。
      if (opts.onEvent) {
        const events = await this.describeStackEvents(
          stackName,
          seen,
          eventCursor,
        );
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

      if (isStackTerminal(summary.status)) return summary;
      if (Date.now() >= deadline) {
        throw new AwsError(
          `Timed out waiting for the stack to complete: ${stackName}`,
          { stackKey: stackName },
        );
      }
      await this.sleep(interval);
      untilStatusPoll = Math.max(0, untilStatusPoll - interval);
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
    BeforeContext?: string;
    AfterContext?: string;
    Details?: {
      Target?: {
        Attribute?: string;
        Name?: string;
        RequiresRecreation?: string;
        Path?: string;
        BeforeValue?: string;
        AfterValue?: string;
        BeforeValueFrom?: string;
        AfterValueFrom?: string;
        AttributeChangeType?: string;
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
    beforeContext: rc.BeforeContext,
    afterContext: rc.AfterContext,
    details: (rc.Details ?? []).map((d) => ({
      target: d.Target
        ? {
            attribute: d.Target.Attribute,
            name: d.Target.Name,
            requiresRecreation: d.Target.RequiresRecreation,
            path: d.Target.Path,
            beforeValue: d.Target.BeforeValue,
            afterValue: d.Target.AfterValue,
            beforeValueFrom: d.Target.BeforeValueFrom,
            afterValueFrom: d.Target.AfterValueFrom,
            attributeChangeType: d.Target.AttributeChangeType,
          }
        : undefined,
      evaluation: d.Evaluation,
      changeSource: d.ChangeSource,
      causingEntity: d.CausingEntity,
    })),
  };
}
