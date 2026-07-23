/** CLI が core/report の内部配置へ依存しないための application 公開境界。 */
import { type CfnSyncConfig, validateEffectiveConfig } from '../core/config.js';
import {
  AwsError,
  CfnSyncError,
  ConfigError,
  DependencyCycleError,
  GuardError,
  InvariantError,
  LockError,
  StackStateError,
  StateConflictError,
  StateCorruptionError,
  StatePersistenceError,
  TemplateParseError,
} from '../core/errors.js';
import type { RegionGraph } from '../core/graph.js';
import {
  type DeployReport,
  renderGraphJson,
  renderGraphText,
  renderJson,
  renderText,
} from '../report/index.js';
import type { StatusEntry } from './status.js';

export type { CfnSyncConfig };
export { validateEffectiveConfig };

export type CliErrorType =
  | 'ConfigError'
  | 'GuardError'
  | 'StateConflictError'
  | 'StatePersistenceError'
  | 'StateCorruptionError'
  | 'InvariantError'
  | 'DependencyCycleError'
  | 'StackStateError'
  | 'AwsError'
  | 'LockError'
  | 'TemplateParseError'
  | 'CliUsageError'
  | 'Error';

export interface CliErrorPayload {
  ok: false;
  exitCode: 1;
  error: {
    type: CliErrorType;
    message: string;
    stackKey?: string;
    region?: string;
  };
}

function cliErrorType(error: unknown): CliErrorType {
  if (error instanceof ConfigError) return 'ConfigError';
  if (error instanceof GuardError) return 'GuardError';
  if (error instanceof StateConflictError) return 'StateConflictError';
  if (error instanceof StatePersistenceError) return 'StatePersistenceError';
  if (error instanceof StateCorruptionError) return 'StateCorruptionError';
  if (error instanceof InvariantError) return 'InvariantError';
  if (error instanceof DependencyCycleError) return 'DependencyCycleError';
  if (error instanceof StackStateError) return 'StackStateError';
  if (error instanceof AwsError) return 'AwsError';
  if (error instanceof LockError) return 'LockError';
  if (error instanceof TemplateParseError) return 'TemplateParseError';
  return 'Error';
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * CfnSyncError は text 診断用 message に cause を保持する既存契約を持つ。
 * 機械可読な共通エラーでは末尾の cause 表現だけを除外し、cause 自体も serialize しない。
 */
function safeCfnSyncMessage(error: CfnSyncError): string {
  if (error.cause === undefined) return error.message;
  const suffix = ` (cause: ${causeMessage(error.cause)})`;
  return error.message.endsWith(suffix)
    ? error.message.slice(0, -suffix.length)
    : error.message;
}

export function createCliErrorPayload(
  error: unknown,
  typeOverride?: 'CliUsageError',
): CliErrorPayload {
  const isUsageError = typeOverride === 'CliUsageError';
  const message = isUsageError
    ? error instanceof Error
      ? error.message
      : String(error)
    : error instanceof CfnSyncError
      ? safeCfnSyncMessage(error)
      : '予期しないエラーが発生しました';
  const context =
    error instanceof CfnSyncError
      ? {
          ...(error.stackKey === undefined ? {} : { stackKey: error.stackKey }),
          ...(error.region === undefined ? {} : { region: error.region }),
        }
      : {};
  return {
    ok: false,
    exitCode: 1,
    error: {
      type: typeOverride ?? cliErrorType(error),
      message,
      ...context,
    },
  };
}

export function renderCliError(
  error: unknown,
  typeOverride?: 'CliUsageError',
): string {
  return JSON.stringify(createCliErrorPayload(error, typeOverride), null, 2);
}

export function renderStatus(entries: StatusEntry[], json: boolean): string {
  if (json) return JSON.stringify({ entries }, null, 2);
  const lines = ['CHANGE    REGION                STACK KEY'];
  for (const entry of entries) {
    lines.push(
      `${entry.changeType.padEnd(10)}${entry.region.padEnd(22)}${entry.stackKey}`,
    );
  }
  return lines.join('\n');
}

export function renderGraph(
  graphs: Map<string, RegionGraph>,
  json: boolean,
): string {
  return json ? renderGraphJson(graphs) : renderGraphText(graphs);
}

export function renderDeploy(report: DeployReport, json: boolean): string {
  return json ? renderJson(report) : renderText(report);
}
