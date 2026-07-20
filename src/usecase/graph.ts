import type { CfnSyncConfig } from '../core/config.js';
import { resolveTargets } from '../core/config.js';
import {
  buildGraphs,
  type RegionGraph,
  type StackNode,
  topologicalOrder,
} from '../core/graph.js';
import { analyzeTemplate } from '../core/template.js';

export interface GraphResult {
  graphs: Map<string, RegionGraph>;
  warnings: string[];
}

/** テンプレート群からリージョン別グラフを構築し、循環も usecase 内で検証する。 */
export function getGraph(input: {
  config: CfnSyncConfig;
  templates: Map<string, string>;
}): GraphResult {
  const nodes: StackNode[] = [];
  const warnings: string[] = [];
  for (const target of resolveTargets(input.config)) {
    const source = input.templates.get(target.templatePath);
    if (source === undefined) {
      throw new Error(
        `テンプレート内容が見つかりません: ${target.templatePath}`,
      );
    }
    const analysis = analyzeTemplate(source, {
      stackName: target.stackName,
      region: target.region,
    });
    warnings.push(...analysis.warnings);
    nodes.push({
      stackKey: target.stackKey,
      region: target.region,
      exports: analysis.exports,
      imports: analysis.imports,
      explicitDependsOn: target.dependsOn,
    });
  }
  const graphs = buildGraphs(nodes);
  for (const graph of graphs.values()) topologicalOrder(graph);
  return { graphs, warnings };
}
