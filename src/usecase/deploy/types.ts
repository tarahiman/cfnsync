import type { CfnSyncConfig, ResolvedStackTarget } from '../../core/config.js';
import type { DetectedEntry, DetectionResult } from '../../core/detect.js';
import { StackStateError } from '../../core/errors.js';
import type { RegionGraph } from '../../core/graph.js';
import type { ExecutionPlan, PlannedOperation } from '../../core/plan.js';
import type { CfnSyncState, DeletableStackRecord } from '../../core/state.js';
import type { TemplateAnalysis } from '../../core/template.js';
import type { StackKey } from '../../core/types.js';
import type {
  CloudFormationGateway,
  LockHandle,
  StateBackend,
  StateVersion,
  StsGateway,
} from '../../ports/index.js';
import type {
  ApprovalRequest,
  ConnectionInfo,
  DeployReport,
  ProgressEvent,
  ProgressPhase,
  ReconciliationRecord,
  StackDiff,
  StackEventLine,
  StackResult,
} from '../../report/index.js';
import type { ExecutorContext } from '../executor.js';
import type { TextRedactor } from '../redactor.js';

export interface DeployDeps {
  cfnFactory: (region: string) => CloudFormationGateway;
  sts: StsGateway;
  backend: StateBackend;
  /** テスト用の時計。変更セット名・ロック開始時刻・成功時刻に共通利用する。 */
  now?: () => Date;
  /** テスト用の run ID 生成器。省略時は executor.newRunId。 */
  runId?: () => string;
  /** FR-4-1: 待機中イベントの逐次出力先。 */
  onEvent?: (event: StackEventLine) => void;
  /** FR-5-4: スタック単位の進捗マイルストーンの逐次出力先(標準エラー想定)。 */
  onProgress?: (event: ProgressEvent) => void;
  /** FR-5-2a: 実行全体で最大 1 回だけ呼ばれる承認ポート。true = 承認。 */
  approve?: (request: ApprovalRequest) => Promise<boolean>;
}

export interface DeployOptions {
  dryRun?: boolean;
  allowDelete?: boolean;
  onFailure?: 'stop' | 'continue';
  collectEvents?: boolean;
  autoApprove?: boolean;
}

export interface DeployResult {
  exitCode: 0 | 1 | 2;
  report: DeployReport;
  hasDiff: boolean;
}

export interface MutableStateContext {
  state: CfnSyncState;
  version: StateVersion | undefined;
}

export interface LockedRunContext {
  config: CfnSyncConfig;
  templates: Map<string, string>;
  deps: DeployDeps;
  options: DeployOptions;
  targets: ResolvedStackTarget[];
  connection: ConnectionInfo;
  lock: LockHandle;
  runId: string;
  state: MutableStateContext;
  required: Map<StackKey, string[]>;
}

export interface PreparedPlan {
  detection: DetectionResult;
  analyses: Map<StackKey, TemplateAnalysis>;
  graphs: Map<string, RegionGraph>;
  mergedGraphs: Map<string, RegionGraph>;
  plan: ExecutionPlan;
  redactors: Map<StackKey, TextRedactor>;
  globalRedactor: TextRedactor;
  parsedTemplates: Map<string, unknown>;
  unresolvedPendingDependsOn: Map<StackKey, string[]>;
}

export interface OperationResult {
  hasDiff: boolean;
  failed?: boolean;
}

export interface PhaseAResult {
  hasDiff: boolean;
  pending?: PendingAction;
}

export interface CreatedChangeSet {
  operation: PlannedOperation;
  cfn: CloudFormationGateway;
  stackName: string;
  name: string;
  id: string;
}

export interface PendingChangeSetExecution {
  kind: 'execute';
  operation: PlannedOperation;
  target: ResolvedStackTarget;
  entry: DetectedEntry;
  analysis: TemplateAnalysis;
  cfn: CloudFormationGateway;
  executor: ExecutorContext;
  changeSetKind: 'create' | 'update';
  changeSet: CreatedChangeSet;
  expectedStackId: string;
}

export interface PendingStackDeletion {
  kind: 'delete';
  operation: PlannedOperation;
  record: DeletableStackRecord;
  diff: StackDiff;
  cfn: CloudFormationGateway;
  pendingDeletionId?: string;
  requiresPairedCreate: boolean;
  unresolvedDependsOn?: string[];
}

export type PendingAction = PendingChangeSetExecution | PendingStackDeletion;

export const UPDATE_EXECUTABLE_STATUSES = new Set([
  'CREATE_COMPLETE',
  'UPDATE_COMPLETE',
  'UPDATE_ROLLBACK_COMPLETE',
  'IMPORT_COMPLETE',
  'IMPORT_ROLLBACK_COMPLETE',
]);

export class StackExecutionFailure extends StackStateError {
  constructor(
    message: string,
    readonly rolledBack: boolean,
    context: { stackKey?: string; region?: string; cause?: unknown } = {},
  ) {
    super(message, context);
  }
}

export interface RunAccumulator {
  report: DeployReport;
  unchangedStacks: StackResult[];
  extraStacks: StackResult[];
  resultByOperation: Map<PlannedOperation, StackResult>;
  reconciliations: ReconciliationRecord[];
  createdChangeSets: Set<CreatedChangeSet>;
  pending: PendingAction[];
  redact: (stackKey: string, text: string) => string;
  notify: (
    ref: { stackKey: string; region: string },
    phase: ProgressPhase,
    message: string,
  ) => void;
}
