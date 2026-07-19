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
} from '../../src/ports/index.js';

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

  /**
   * listChangeSets の呼び出し直前(結果を組み立てる前)に発火するフック。
   * (stackName, その stack に対する呼び出し回数)を受け取る。並行追加シナリオ
   * (FR-2-11 横断 / T-18)で「再検査の直前に他主体の変更セットを注入」するのに使う。
   */
  onListChangeSets?: (stackName: string, callCount: number) => void;

  private readonly listCallCounts = new Map<string, number>();

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
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
    return this.stacks.get(stackName) ?? makeStackSummary({ stackName, status: 'CREATE_COMPLETE' });
  }
}
