import type { CfnSyncConfig } from '../core/config.js';
import { resolveTargets } from '../core/config.js';
import { ConfigError } from '../core/errors.js';
import {
  buildGraphs,
  computeLevels,
  type RegionGraph,
  type StackNode,
} from '../core/graph.js';
import {
  analyzeStaticTemplate,
  parseCfnTemplate,
  resolveStaticTemplateAnalysis,
  type StaticTemplateAnalysis,
} from '../core/template.js';
import type { StackKey } from '../core/types.js';

export interface GraphResult {
  graphs: Map<string, RegionGraph>;
  levels: Map<string, StackKey[][]>;
  warnings: string[];
}

/** テンプレート群からリージョン別グラフを構築し、循環も usecase 内で検証する。 */
export function getGraph(input: {
  config: CfnSyncConfig;
  templates: Map<string, string>;
}): GraphResult {
  const nodes: StackNode[] = [];
  const warnings: string[] = [];
  const staticAnalyses = new Map<string, StaticTemplateAnalysis>();
  for (const target of resolveTargets(input.config)) {
    const source = input.templates.get(target.templatePath);
    if (source === undefined) {
      throw new ConfigError(
        `Template content not found: ${target.templatePath}`,
        { stackKey: target.stackKey, region: target.region },
      );
    }
    let staticAnalysis = staticAnalyses.get(target.templatePath);
    if (staticAnalysis === undefined) {
      staticAnalysis = analyzeStaticTemplate(parseCfnTemplate(source));
      staticAnalyses.set(target.templatePath, staticAnalysis);
    }
    const analysis = resolveStaticTemplateAnalysis(staticAnalysis, {
      stackName: target.stackName,
      region: target.region,
      parameters: target.parameters,
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
  const levels = new Map<string, StackKey[][]>();
  for (const [region, graph] of graphs) {
    levels.set(region, computeLevels(graph));
  }
  return { graphs, levels, warnings };
}
