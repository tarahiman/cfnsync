/**
 * usecase レイヤ用のインメモリフェイク(ports レベル)。
 *
 * `aws-sdk-client-mock` は `aws/` 実装のテスト専用であり、usecase のシナリオテストは
 * ports の契約(`CloudFormationGateway` 等)を満たすインメモリフェイクに差し替えて
 * 行う(design.md §10)。このフェイクは **全メソッド呼び出しを時系列で記録**するため、
 * FR-2-11(実行直前再検査が ExecuteChangeSet の直前に配置されること)や
 * FR-2-10(REVIEW_IN_PROGRESS で DeleteStack が一切呼ばれないこと)のような
 * 呼び出し順序・呼び出し有無の検証に使える。T-14 以降でも再利用する想定。
 */

import { LockError, StateConflictError } from '../../src/core/errors.js';
import type { CfnSyncState } from '../../src/core/state.js';
import type {
  ChangeSetDetail,
  ChangeSetSummary,
  CloudFormationGateway,
  CreateChangeSetInput,
  LockHandle,
  LockInfo,
  StackEvent,
  StackSummary,
  StateBackend,
  StateVersion,
  StsGateway,
  TemplateStage,
  WaitForStackOptions,
} from '../../src/ports/index.js';

/** フェイクが記録する 1 回分のゲートウェイ呼び出し。 */
export interface CallRecord {
  method: string;
  args: unknown[];
}

/** 成功・失敗を関数注入できる STS フェイク。 */
export class FakeStsGateway implements StsGateway {
  calls = 0;

  constructor(
    private readonly resolveFn: () => Promise<{
      accountId: string;
      arn: string;
    }>,
    private readonly timeline?: string[],
  ) {}

  async getCallerIdentity(): Promise<{ accountId: string; arn: string }> {
    this.calls += 1;
    this.timeline?.push('sts.getCallerIdentity');
    return this.resolveFn();
  }
}

export function makeStackSummary(
  overrides: Partial<StackSummary> & Pick<StackSummary, 'status'>,
): StackSummary {
  return {
    stackName: 'stack',
    stackId: 'arn:aws:cloudformation:stack/stack',
    parameters: {},
    tags: {},
    capabilities: [],
    outputs: {},
    terminationProtection: false,
    ...overrides,
  };
}

export function makeChangeSetSummary(
  name: string,
  overrides: Partial<ChangeSetSummary> = {},
): ChangeSetSummary {
  return {
    name,
    id: `arn:aws:cloudformation:changeSet/${name}`,
    status: 'CREATE_COMPLETE',
    ...overrides,
  };
}

export function makeChangeSetDetail(
  overrides: Partial<ChangeSetDetail> = {},
): ChangeSetDetail {
  return {
    status: 'CREATE_COMPLETE',
    changes: [],
    parameters: {},
    tags: {},
    capabilities: [],
    ...overrides,
  };
}

/**
 * 呼び出し記録付きの `CloudFormationGateway` フェイク。状態はプレーンな Map で保持し、
 * テストが直接読み書きして初期状態やシナリオを構成する。
 */
export class FakeCloudFormationGateway implements CloudFormationGateway {
  /** 時系列の全呼び出し記録(順序検証に使う)。 */
  readonly calls: CallRecord[] = [];

  /** DeleteStack 呼び出し時点で REVIEW_IN_PROGRESS だったスタック(T-18 横断不変条件)。 */
  readonly reviewInProgressDeleteCalls: string[] = [];

  /** stackName → 要約。未登録の stackName は「スタックなし」(describeStack が undefined を返す)。 */
  readonly stacks = new Map<string, StackSummary>();

  /** stackName → listChangeSets が返す未実行変更セット。テストが直接構成する。 */
  readonly changeSets = new Map<string, ChangeSetSummary[]>();

  /** 変更セット名 → waitForChangeSet が返す詳細(未登録は default)。 */
  readonly changeSetDetails = new Map<string, ChangeSetDetail>();

  /** 個別登録のない変更セットに対する既定の詳細。 */
  defaultChangeSetDetail: ChangeSetDetail = makeChangeSetDetail();

  /** stackName → getTemplate が返すテンプレート本文。 */
  readonly templates = new Map<string, string>();

  /** stackName → describeStackEvents が返すイベント列(古い順)。 */
  readonly events = new Map<string, StackEvent[]>();

  /** 明示設定時だけ waitForStack の onEvent へ流すイベント列(T-14 用)。 */
  readonly waitEvents = new Map<string, StackEvent[]>();

  /** 明示設定時だけ waitForStack が先頭から返す終端要約列(T-14 の失敗・再実行用)。 */
  readonly waitResults = new Map<string, StackSummary[]>();

  /**
   * waitForStack が呼ばれた直後、終端結果を返す前に発火する任意フック。
   * T-18 で長時間待機を停止したり、待機中の force-unlock を注入したりする。
   */
  onWaitForStack?: (stackName: string) => void | Promise<void>;

  /**
   * listChangeSets の呼び出し直前(結果を組み立てる前)に発火するフック。
   * (stackName, その stack に対する呼び出し回数)を受け取る。並行追加シナリオ
   * (FR-2-11 横断 / T-18)で「再検査の直前に他主体の変更セットを注入」するのに使う。
   */
  onListChangeSets?: (stackName: string, callCount: number) => void;

  /**
   * true の場合、`listChangeSets` は `stacks` に未登録のスタック名に対して実 AWS の
   * `ListChangeSets`(実際には `ValidationError: Stack [...] does not exist`)を模した
   * 例外を投げる。既定は false(既存テストの非破壊のため)。真の新規 CREATE(スタックが
   * CloudFormation に一切存在しない)経路の回帰テストで使う。
   */
  strictStackExistence = false;

  private readonly listCallCounts = new Map<string, number>();

  constructor(
    private readonly timeline?: string[],
    private readonly timelineLabel = 'cfn',
  ) {}

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    this.timeline?.push(`${this.timelineLabel}.${method}`);
  }

  /** 記録された特定メソッドの呼び出しのみを抽出する補助。 */
  callsOf(method: string): CallRecord[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** 記録された呼び出しをメソッド名の時系列配列にする補助(順序検証用)。 */
  methodSequence(): string[] {
    return this.calls.map((c) => c.method);
  }

  private detailFor(identifier: string): ChangeSetDetail {
    const summary = [...this.changeSets.values()]
      .flat()
      .find((item) => item.id === identifier || item.name === identifier);
    const name = summary?.name ?? identifier.split('/').at(-1) ?? identifier;
    const id = summary?.id ?? identifier;
    const detail =
      this.changeSetDetails.get(identifier) ??
      this.changeSetDetails.get(name) ??
      this.defaultChangeSetDetail;
    return { ...detail, name: detail.name ?? name, id: detail.id ?? id };
  }

  async describeStack(stackName: string): Promise<StackSummary | undefined> {
    this.record('describeStack', stackName);
    return this.stacks.get(stackName);
  }

  async listChangeSets(stackName: string): Promise<ChangeSetSummary[]> {
    if (this.strictStackExistence && !this.stacks.has(stackName)) {
      this.record('listChangeSets', stackName);
      throw new Error(
        `CloudFormation ListChangeSets に失敗しました: Stack [${stackName}] does not exist`,
      );
    }
    const callCount = (this.listCallCounts.get(stackName) ?? 0) + 1;
    this.listCallCounts.set(stackName, callCount);
    this.onListChangeSets?.(stackName, callCount);
    this.record('listChangeSets', stackName);
    return [...(this.changeSets.get(stackName) ?? [])];
  }

  async createChangeSet(
    input: CreateChangeSetInput,
  ): Promise<{ id: string; stackId?: string }> {
    this.record('createChangeSet', input);
    const id = `arn:aws:cloudformation:changeSet/${input.changeSetName}`;
    const existing = this.changeSets.get(input.stackName) ?? [];
    this.changeSets.set(input.stackName, [
      ...existing,
      makeChangeSetSummary(input.changeSetName, { id }),
    ]);
    // 実 AWS の CreateChangeSet は変更セット ARN(Id)と対象スタックの StackId を返す。
    // CREATE 型では、この呼び出し自体が REVIEW_IN_PROGRESS の殻を作りその ARN を返す。
    // 実行直前再検査(FR-5-17c2)がこの値と DescribeStacks の stackId を照合するため、
    // フェイクも「既存スタックがあればその ARN、なければ殻の ARN」を返す。
    const shell =
      this.stacks.get(input.stackName) ??
      makeStackSummary({
        stackName: input.stackName,
        status: 'REVIEW_IN_PROGRESS',
      });
    if (
      this.strictStackExistence &&
      input.changeSetType === 'CREATE' &&
      !this.stacks.has(input.stackName)
    ) {
      // 実 AWS は CREATE 型の CreateChangeSet でスタックを REVIEW_IN_PROGRESS として
      // 新規作成する。strictStackExistence 下ではこれ以降の存在チェックを実体に合わせる。
      this.stacks.set(input.stackName, shell);
    }
    return { id, stackId: shell.stackId };
  }

  async waitForChangeSet(
    stackName: string,
    changeSetName: string,
  ): Promise<ChangeSetDetail> {
    this.record('waitForChangeSet', stackName, changeSetName);
    return this.detailFor(changeSetName);
  }

  async deleteChangeSet(
    stackName: string,
    changeSetName: string,
  ): Promise<void> {
    this.record('deleteChangeSet', stackName, changeSetName);
    const list = this.changeSets.get(stackName);
    if (list) {
      this.changeSets.set(
        stackName,
        list.filter(
          (cs) => cs.name !== changeSetName && cs.id !== changeSetName,
        ),
      );
    }
  }

  async executeChangeSet(
    stackName: string,
    changeSetName: string,
  ): Promise<void> {
    this.record('executeChangeSet', stackName, changeSetName);
    const list = this.changeSets.get(stackName);
    if (list) {
      this.changeSets.set(
        stackName,
        list.filter(
          (changeSet) =>
            changeSet.id !== changeSetName && changeSet.name !== changeSetName,
        ),
      );
    }
    if (this.strictStackExistence) {
      // 実 AWS では ExecuteChangeSet が REVIEW_IN_PROGRESS のスタックの実体作成を開始し、
      // 完了すると CREATE_COMPLETE へ遷移する。waitForStack が古い REVIEW_IN_PROGRESS を
      // 返し続けないよう、CREATE 型実行の成功をここで模す(個別の waitResults 設定があれば
      // そちらが優先される)。
      const current = this.stacks.get(stackName);
      if (current?.status === 'REVIEW_IN_PROGRESS') {
        this.stacks.set(stackName, { ...current, status: 'CREATE_COMPLETE' });
      }
    }
  }

  async deleteStack(stackName: string): Promise<void> {
    const stack =
      this.stacks.get(stackName) ??
      [...this.stacks.values()].find((item) => item.stackId === stackName);
    if (stack?.status === 'REVIEW_IN_PROGRESS') {
      this.reviewInProgressDeleteCalls.push(stackName);
    }
    this.record('deleteStack', stackName);
  }

  async describeStackEvents(
    stackName: string,
    seenEventIds?: Set<string>,
  ): Promise<StackEvent[]> {
    this.record('describeStackEvents', stackName, seenEventIds);
    const all = this.events.get(stackName) ?? [];
    return seenEventIds
      ? all.filter((e) => !seenEventIds.has(e.eventId))
      : [...all];
  }

  async getStackEventCursor(stackName: string) {
    this.record('getStackEventCursor', stackName);
    const latest = (this.events.get(stackName) ?? []).at(-1);
    return {
      eventId: latest?.eventId,
      timestamp: latest?.timestamp ?? new Date(0).toISOString(),
    };
  }

  async getTemplate(stackName: string, stage: TemplateStage): Promise<string> {
    this.record('getTemplate', stackName, stage);
    return this.templates.get(stackName) ?? '';
  }

  async waitForStack(
    stackName: string,
    opts?: WaitForStackOptions,
  ): Promise<StackSummary> {
    this.record('waitForStack', stackName, opts);
    const resolvedName =
      this.stacks.get(stackName)?.stackName ??
      [...this.stacks.values()].find((item) => item.stackId === stackName)
        ?.stackName ??
      stackName;
    await this.onWaitForStack?.(resolvedName);
    for (const event of this.waitEvents.get(resolvedName) ?? []) {
      opts?.onEvent?.(event);
    }
    const queued = this.waitResults.get(resolvedName);
    if (queued && queued.length > 0) {
      return queued.shift() as StackSummary;
    }
    return (
      this.stacks.get(resolvedName) ??
      makeStackSummary({ stackName: resolvedName, status: 'CREATE_COMPLETE' })
    );
  }
}

/**
 * T-14 以降で再利用する StateBackend フェイク。
 * 全呼び出しを共有 timeline に記録し、verifyLock 応答・CAS 競合・ロック取得失敗を
 * 決定的に注入できる。既存フェイクのメソッド挙動には影響しない追記実装。
 */
export class FakeStateBackend implements StateBackend {
  stored: { state: CfnSyncState; version: StateVersion } | undefined;
  readonly calls: CallRecord[] = [];
  readonly saveCalls: Array<{
    state: CfnSyncState;
    expected: StateVersion | undefined;
  }> = [];
  /** save が投げたエラーの記録(T-18 で CAS 競合の型まで検証する)。 */
  readonly saveErrors: Error[] = [];
  verifyLockPlan: boolean[] = [];
  failAcquire = false;
  /** true のとき、保持中ロックへの追加 acquire を LockError にする(T-18 並行開始用)。 */
  rejectConcurrentAcquire = false;
  saveError: Error | undefined;
  forceUnlockResult: { released: boolean; reason?: string } | undefined;
  releaseCalls = 0;
  /**
   * verifyLock の判定を確定した直後、呼び出し元へ返す前に発火する任意フック。
   * 判定と副作用の競合窓に所有権交代を注入できる。
   */
  onVerifyLock?: (
    handle: LockHandle,
    callCount: number,
    verified: boolean,
  ) => void | Promise<void>;
  private lock: LockHandle | undefined;
  private lockInfo: LockInfo | undefined;
  private verifyLockCalls = 0;

  constructor(
    private readonly timeline: string[] = [],
    initial?: CfnSyncState,
    private readonly backendStateId = 'aabbccddeeff',
  ) {
    if (initial) {
      this.stored = {
        state: initial,
        version: { backend: 'local', generation: initial.generation },
      };
    }
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    this.timeline.push(`backend.${method}`);
  }

  callsOf(method: string): CallRecord[] {
    return this.calls.filter((call) => call.method === method);
  }

  async load(): Promise<
    { state: CfnSyncState; version: StateVersion } | undefined
  > {
    this.record('load');
    return this.stored
      ? { state: this.stored.state, version: this.stored.version }
      : undefined;
  }

  async save(
    state: CfnSyncState,
    expected: StateVersion | undefined,
  ): Promise<StateVersion> {
    this.record('save', state, expected);
    this.saveCalls.push({ state, expected });
    if (this.saveError) {
      this.saveErrors.push(this.saveError);
      throw this.saveError;
    }
    const currentGeneration = this.stored?.version.generation;
    if (
      (expected === undefined && this.stored !== undefined) ||
      (expected !== undefined && expected.generation !== currentGeneration)
    ) {
      const error = new StateConflictError('世代不一致(fake CAS)');
      this.saveErrors.push(error);
      throw error;
    }
    const version: StateVersion = {
      backend: 'local',
      generation: state.generation,
    };
    this.stored = { state, version };
    return version;
  }

  async acquireLock(info: LockInfo): Promise<LockHandle> {
    this.record('acquireLock', info);
    if (
      this.failAcquire ||
      (this.rejectConcurrentAcquire && this.lock !== undefined)
    ) {
      throw new LockError('別の実行がロックを保持しています(fake)');
    }
    this.lock = {
      backend: 's3',
      runId: info.runId,
      etag: 'fake-lock-etag',
    };
    this.lockInfo = { ...info };
    return this.lock;
  }

  async verifyLock(handle: LockHandle): Promise<boolean> {
    this.record('verifyLock', handle);
    this.verifyLockCalls += 1;
    const verified =
      this.verifyLockPlan.length > 0
        ? (this.verifyLockPlan.shift() as boolean)
        : this.lock?.runId === handle.runId;
    await this.onVerifyLock?.(handle, this.verifyLockCalls, verified);
    return verified;
  }

  async releaseLock(
    handle: LockHandle,
  ): Promise<{ released: boolean; reason?: string }> {
    this.record('releaseLock', handle);
    this.releaseCalls += 1;
    if (this.lock?.runId !== handle.runId)
      return { released: false, reason: 'owner changed(fake)' };
    this.lock = undefined;
    this.lockInfo = undefined;
    return { released: true };
  }

  async readLock(): Promise<LockInfo | undefined> {
    this.record('readLock');
    return this.lockInfo ? { ...this.lockInfo } : undefined;
  }

  async forceUnlock(
    runId: string,
  ): Promise<{ released: boolean; reason?: string }> {
    this.record('forceUnlock', runId);
    if (this.forceUnlockResult) return this.forceUnlockResult;
    if (this.lock?.runId !== runId)
      return { released: false, reason: 'runId mismatch(fake)' };
    this.lock = undefined;
    this.lockInfo = undefined;
    return { released: true };
  }

  setLock(info: LockInfo): void {
    this.lock = {
      backend: 's3',
      runId: info.runId,
      etag: 'fake-lock-etag',
    };
    this.lockInfo = { ...info };
  }

  stateId(): string {
    this.record('stateId');
    return this.backendStateId;
  }
}
