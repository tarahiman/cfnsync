import type { CfnSyncConfig } from '../core/config.js';
import { resolveTargets } from '../core/config.js';
import { computeTemplateHash, detectChanges } from '../core/detect.js';
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
  const templateHashes = new Map(
    [...input.templates].map(([path, source]) => [
      path,
      computeTemplateHash(source),
    ]),
  );
  const detection = detectChanges({
    targets: resolveTargets(input.config),
    templates: input.templates,
    state: loaded?.state ?? createInitialState(),
    templateHashes,
  });
  return {
    // FR-1-23: 削除待ちは stacks のエントリを持たないため、pendingDeletion から
    // リージョンと旧スタック名を解決する。出力 schema にフィールドは追加しない。
    entries: detection.entries.map((entry) => ({
      stackKey: entry.stackKey,
      region:
        entry.target?.region ??
        entry.stateEntry?.region ??
        entry.pendingDeletion?.entry.region ??
        '',
      stackName:
        entry.target?.stackName ??
        entry.stateEntry?.stackName ??
        entry.pendingDeletion?.entry.stackName ??
        '',
      changeType: entry.changeType,
    })),
  };
}
