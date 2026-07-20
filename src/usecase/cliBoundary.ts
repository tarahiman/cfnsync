/** CLI が core/report の内部配置へ依存しないための application 公開境界。 */
import { type CfnSyncConfig, validateEffectiveConfig } from '../core/config.js';
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
