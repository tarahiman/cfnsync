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

import type {
  ChangeSetDetail,
  ChangeSetSummary,
  CloudFormationGateway,
  CreateChangeSetInput,
  StackEvent,
  StackSummary,
  TemplateStage,
  WaitForStackOptions,
  LockHandle,
  LockInfo,
  StateBackend,
  StateVersion,
} from '../../src/ports/index.js';
import { LockError, StateConflictError } from '../../src/core/errors.js';
import type { CfnSyncState } from '../../src/core/state.js';

/** フェイクが記録する 1 回分のゲートウェイ呼び出し。 */
export interface CallRecord {
  method: string;
  args: unknown[];
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

export function makeChangeSetDetail(overrides: Partial<ChangeSetDetail> = {}): ChangeSetDetail {
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

  /** stackName → 要約。未登録の stackName は「スタックなし」(describeStack が undefined を返す)。 */
  readonly stacks = new Map<string, StackSummary>();

  /** stackName → listChangeSets が返す未実行変更セット。テストが直接構成する。 */
  readonly changeSets = new Map<string, ChangeSetSummary[]>();

  /** 変更セット名 → waitForChangeSet / describeChangeSet が返す詳細(未登録は default)。 */
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
   * listChangeSets の呼び出し直前(結果を組み立てる前)に発火するフック。
   * (stackName, その stack に対する呼び出し回数)を受け取る。並行追加シナリオ
   * (FR-2-11 横断 / T-18)で「再検査の直前に他主体の変更セットを注入」するのに使う。
   */
  onListChangeSets?: (stackName: string, callCount: number) => void;

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

  private detailFor(changeSetName: string): ChangeSetDetail {
    return this.changeSetDetails.get(changeSetName) ?? this.defaultChangeSetDetail;
  }

  async describeStack(stackName: string): Promise<StackSummary | undefined> {
    this.record('describeStack', stackName);
    return this.stacks.get(stackName);
  }

  async listChangeSets(stackName: string): Promise<ChangeSetSummary[]> {
    const callCount = (this.listCallCounts.get(stackName) ?? 0) + 1;
    this.listCallCounts.set(stackName, callCount);
    this.onListChangeSets?.(stackName, callCount);
    this.record('listChangeSets', stackName);
    return [...(this.changeSets.get(stackName) ?? [])];
  }

  async createChangeSet(input: CreateChangeSetInput): Promise<{ id: string }> {
    this.record('createChangeSet', input);
    return { id: `arn:aws:cloudformation:changeSet/${input.changeSetName}` };
  }

  async describeChangeSet(stackName: string, changeSetName: string): Promise<ChangeSetDetail> {
    this.record('describeChangeSet', stackName, changeSetName);
    return this.detailFor(changeSetName);
  }

  async waitForChangeSet(stackName: string, changeSetName: string): Promise<ChangeSetDetail> {
    this.record('waitForChangeSet', stackName, changeSetName);
    return this.detailFor(changeSetName);
  }

  async deleteChangeSet(stackName: string, changeSetName: string): Promise<void> {
    this.record('deleteChangeSet', stackName, changeSetName);
    const list = this.changeSets.get(stackName);
    if (list) {
      this.changeSets.set(
        stackName,
        list.filter((cs) => cs.name !== changeSetName),
      );
    }
  }

  async executeChangeSet(stackName: string, changeSetName: string): Promise<void> {
    this.record('executeChangeSet', stackName, changeSetName);
  }

  async deleteStack(stackName: string): Promise<void> {
    this.record('deleteStack', stackName);
  }

  async describeStackEvents(
    stackName: string,
    seenEventIds?: Set<string>,
  ): Promise<StackEvent[]> {
    this.record('describeStackEvents', stackName, seenEventIds);
    const all = this.events.get(stackName) ?? [];
    return seenEventIds ? all.filter((e) => !seenEventIds.has(e.eventId)) : [...all];
  }

  async getTemplate(stackName: string, stage: TemplateStage): Promise<string> {
    this.record('getTemplate', stackName, stage);
    return this.templates.get(stackName) ?? '';
  }

  async waitForStack(stackName: string, opts?: WaitForStackOptions): Promise<StackSummary> {
    this.record('waitForStack', stackName, opts);
    for (const event of this.waitEvents.get(stackName) ?? []) {
      opts?.onEvent?.(event);
    }
    const queued = this.waitResults.get(stackName);
    if (queued && queued.length > 0) {
      return queued.shift() as StackSummary;
    }
    return this.stacks.get(stackName) ?? makeStackSummary({ stackName, status: 'CREATE_COMPLETE' });
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
  readonly saveCalls: Array<{ state: CfnSyncState; expected: StateVersion | undefined }> = [];
  verifyLockPlan: boolean[] = [];
  failAcquire = false;
  saveError: Error | undefined;
  releaseCalls = 0;
  private lock: LockHandle | undefined;

  constructor(
    private readonly timeline: string[] = [],
    initial?: CfnSyncState,
    private readonly backendStateId = 'aabbccddeeff',
  ) {
    if (initial) {
      this.stored = { state: initial, version: { generation: initial.generation } };
    }
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    this.timeline.push(`backend.${method}`);
  }

  callsOf(method: string): CallRecord[] {
    return this.calls.filter((call) => call.method === method);
  }

  async load(): Promise<{ state: CfnSyncState; version: StateVersion } | undefined> {
    this.record('load');
    return this.stored ? { state: this.stored.state, version: this.stored.version } : undefined;
  }

  async save(state: CfnSyncState, expected: StateVersion | undefined): Promise<StateVersion> {
    this.record('save', state, expected);
    this.saveCalls.push({ state, expected });
    if (this.saveError) throw this.saveError;
    const currentGeneration = this.stored?.version.generation;
    if (
      (expected === undefined && this.stored !== undefined) ||
      (expected !== undefined && expected.generation !== currentGeneration)
    ) {
      throw new StateConflictError('世代不一致(fake CAS)');
    }
    const version: StateVersion = { generation: state.generation };
    this.stored = { state, version };
    return version;
  }

  async acquireLock(info: LockInfo): Promise<LockHandle> {
    this.record('acquireLock', info);
    if (this.failAcquire) throw new LockError('別の実行がロックを保持しています(fake)');
    this.lock = { runId: info.runId, etag: 'fake-lock-etag' };
    return this.lock;
  }

  async verifyLock(handle: LockHandle): Promise<boolean> {
    this.record('verifyLock', handle);
    if (this.verifyLockPlan.length > 0) return this.verifyLockPlan.shift() as boolean;
    return this.lock?.runId === handle.runId;
  }

  async releaseLock(handle: LockHandle): Promise<{ released: boolean; reason?: string }> {
    this.record('releaseLock', handle);
    this.releaseCalls += 1;
    if (this.lock?.runId !== handle.runId) return { released: false, reason: 'owner changed(fake)' };
    this.lock = undefined;
    return { released: true };
  }

  async readLock(): Promise<LockInfo | undefined> {
    this.record('readLock');
    return this.lock
      ? { runId: this.lock.runId, startedAt: '2026-07-20T00:00:00.000Z', owner: 'fake' }
      : undefined;
  }

  async forceUnlock(runId: string): Promise<{ released: boolean; reason?: string }> {
    this.record('forceUnlock', runId);
    if (this.lock?.runId !== runId) return { released: false, reason: 'runId mismatch(fake)' };
    this.lock = undefined;
    return { released: true };
  }

  stateId(): string {
    this.record('stateId');
    return this.backendStateId;
  }
}
