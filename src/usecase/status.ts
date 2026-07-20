import type { CfnSyncConfig } from '../core/config.js';
import { resolveTargets } from '../core/config.js';
import { detectChanges } from '../core/detect.js';
import { createInitialState } from '../core/state.js';
import type { ChangeType } from '../core/types.js';
import type { StateBackend } from '../ports/index.js';

export interface StatusEntry {
  stackKey: string;
  region: string;
  stackName: string;
  changeType: ChangeType;
}

export interface StatusResult {
  entries: StatusEntry[];
}

/** state とローカル入力だけで変更を分類し、render 非依存の構造化結果を返す。 */
export async function getStatus(input: {
  config: CfnSyncConfig;
  templates: Map<string, string>;
  backend: StateBackend;
}): Promise<StatusResult> {
  const loaded = await input.backend.load();
  const detection = detectChanges({
    targets: resolveTargets(input.config),
    templates: input.templates,
    state: loaded?.state ?? createInitialState(),
  });
  return {
    entries: detection.entries.map((entry) => ({
      stackKey: entry.stackKey,
      region: entry.target?.region ?? entry.stateEntry?.region ?? '',
      stackName: entry.target?.stackName ?? entry.stateEntry?.stackName ?? '',
      changeType: entry.changeType,
    })),
  };
}
