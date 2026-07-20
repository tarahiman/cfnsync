/**
 * core/template — CloudFormation テンプレートの解析(design.md §6, requirements.md FR-8 / NFR-4)。
 *
 * - `yaml` パッケージの customTags で CFN 短縮タグ(`!Ref` 等)を登録し、YAML / JSON の
 *   いずれも完全形(`Fn::X` 形式。`Ref` は `Ref`、`Condition` は `Condition` — CloudFormation
 *   の実際の完全形どおり `Fn::` 接頭辞を付けない)の JS オブジェクトへ解決する。
 * - `Outputs.*.Export.Name`(export)と `Fn::ImportValue`(import)を静的解析し、
 *   スタック間の依存辺を抽出する(design.md §6)。動的で解決不能な合成は警告として報告する。
 * - `Parameters` の `NoEcho: true` パラメータ名を抽出する(NFR-4 のマスク処理の準備。
 *   マスクの適用自体は T-11 report が担う)。
 *
 * 本モジュールは純粋ロジックのみで、AWS SDK には依存しない(CLAUDE.md の `src/core/` 規約)。
 */

import type { CollectionTag, ScalarTag } from 'yaml';
import { parse as parseYaml } from 'yaml';

/** `analyzeTemplate` に渡す文脈。Export の `Fn::Sub` 解決に用いる。 */
export interface TemplateAnalysisContext {
  stackName: string;
  region: string;
}

/** `analyzeTemplate` の解析結果(design.md §6)。 */
export interface TemplateAnalysis {
  /** 他スタックから import している Export 名(静的に解決できたもののみ、出現順・重複排除)。 */
  imports: string[];
  /** このテンプレートが公開する Export 名(静的またはスタック名/リージョンのみで解決できた `Fn::Sub`。出現順・重複排除)。 */
  exports: string[];
  /** 解決不能だった動的な `Export.Name` / `Fn::ImportValue` などの警告メッセージ。 */
  warnings: string[];
  /** `NoEcho: true`(文字列 `"true"` も含む)のパラメータ名(出現順)。 */
  noEchoParams: string[];
}

/** AST 全走査をテンプレートごとに一度だけ行ったリージョン非依存の中間結果。 */
export interface StaticTemplateAnalysis {
  exportCandidates: Array<{ outputName: string; nameValue: unknown }>;
  imports: string[];
  warnings: string[];
  noEchoParams: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dedupePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// CFN 短縮タグ → 完全形への解決(design.md §6)
// ---------------------------------------------------------------------------

/**
 * `!GetAtt` スカラー短縮形("A.B" / "A.B.C")の分解。CloudFormation は最初のドットのみで
 * 分割する(例: ネストスタックの `!GetAtt Stack.Outputs.Name` → `[Stack, "Outputs.Name"]`)。
 */
function splitGetAtt(value: string): [string, string] {
  const idx = value.indexOf('.');
  if (idx === -1) return [value, ''];
  return [value.slice(0, idx), value.slice(idx + 1)];
}

function scalarTag(
  tag: string,
  resolve: (value: string) => unknown,
): ScalarTag {
  return { tag, resolve: (value) => resolve(value) };
}

function collectionTag(
  tag: string,
  collection: 'seq' | 'map',
  wrap: (value: unknown) => unknown,
): CollectionTag {
  return {
    tag,
    collection,
    resolve: (node) => wrap(node.toJSON()),
  };
}

/**
 * CFN 短縮タグの完全一覧(design.md §6)。`Ref` は `{ Ref: ... }`、`Condition` は
 * `{ Condition: ... }`(いずれも CloudFormation の完全形に `Fn::` 接頭辞は付かない)。
 * それ以外はすべて `{ 'Fn::X': ... }` に解決する。
 */
const CFN_CUSTOM_TAGS: (ScalarTag | CollectionTag)[] = [
  scalarTag('!Ref', (v) => ({ Ref: v })),
  scalarTag('!Condition', (v) => ({ Condition: v })),

  scalarTag('!GetAtt', (v) => {
    const [logicalId, attribute] = splitGetAtt(v);
    return { 'Fn::GetAtt': [logicalId, attribute] };
  }),
  collectionTag('!GetAtt', 'seq', (v) => ({ 'Fn::GetAtt': v })),

  scalarTag('!ImportValue', (v) => ({ 'Fn::ImportValue': v })),
  collectionTag('!ImportValue', 'map', (v) => ({ 'Fn::ImportValue': v })),

  scalarTag('!Sub', (v) => ({ 'Fn::Sub': v })),
  collectionTag('!Sub', 'seq', (v) => ({ 'Fn::Sub': v })),

  scalarTag('!Base64', (v) => ({ 'Fn::Base64': v })),
  scalarTag('!GetAZs', (v) => ({ 'Fn::GetAZs': v })),

  collectionTag('!Join', 'seq', (v) => ({ 'Fn::Join': v })),
  collectionTag('!Select', 'seq', (v) => ({ 'Fn::Select': v })),
  collectionTag('!Split', 'seq', (v) => ({ 'Fn::Split': v })),
  collectionTag('!FindInMap', 'seq', (v) => ({ 'Fn::FindInMap': v })),
  collectionTag('!Cidr', 'seq', (v) => ({ 'Fn::Cidr': v })),
  collectionTag('!If', 'seq', (v) => ({ 'Fn::If': v })),
  collectionTag('!Not', 'seq', (v) => ({ 'Fn::Not': v })),
  collectionTag('!And', 'seq', (v) => ({ 'Fn::And': v })),
  collectionTag('!Or', 'seq', (v) => ({ 'Fn::Or': v })),
  collectionTag('!Equals', 'seq', (v) => ({ 'Fn::Equals': v })),
];

/**
 * テンプレートソース(YAML の CFN 短縮タグ入り、または JSON)を完全形の JS オブジェクトへ
 * パースする。YAML は JSON の上位互換であるため同一パーサ経路で両方を処理し、結果が
 * 一致することを保証する(FR-8-1)。
 */
export function parseCfnTemplate(source: string): unknown {
  return parseYaml(source, { customTags: CFN_CUSTOM_TAGS });
}

// ---------------------------------------------------------------------------
// 深い同値比較(CREATE 復旧・import 比較。パーサ後の構造比較でキー順・書式差を無視)
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (key, i) => key === bKeys[i] && deepEqual(a[key], b[key]),
    );
  }

  return false;
}

/**
 * 2 つのテンプレートソースがパース後に深い同値であるかを判定する(YAML/JSON・書式差・
 * キー順差を無視)。CREATE 復旧(design.md §7)・import(FR-10)のテンプレート比較で使用。
 */
export function templatesEquivalent(a: string, b: string): boolean {
  return deepEqual(parseCfnTemplate(a), parseCfnTemplate(b));
}

/** 既にパース済みのテンプレート同士を比較する。呼び出し側のパス単位キャッシュ用。 */
export function parsedTemplatesEquivalent(a: unknown, b: unknown): boolean {
  return deepEqual(a, b);
}

// ---------------------------------------------------------------------------
// Export / Import / NoEcho の抽出(design.md §6, NFR-4)
// ---------------------------------------------------------------------------

/** `${AWS::StackName}` / `${AWS::Region}` プレースホルダの置換パターン。 */
const SUB_VAR_PATTERN = /\$\{([^}]*)\}/g;

/**
 * `Fn::Sub` の文字列テンプレートを、`${AWS::StackName}` / `${AWS::Region}` のみを
 * 擬似パラメータとして解決する。それ以外の変数(テンプレートパラメータ参照等)を
 * 含む場合は解決不能として `undefined` を返す(design.md §6)。
 */
function resolveSubTemplate(
  template: string,
  ctx: TemplateAnalysisContext,
): string | undefined {
  let resolvable = true;
  const resolved = template.replace(
    SUB_VAR_PATTERN,
    (_match, rawVarName: string) => {
      const varName = rawVarName.trim();
      if (varName === 'AWS::StackName') return ctx.stackName;
      if (varName === 'AWS::Region') return ctx.region;
      resolvable = false;
      return '';
    },
  );
  return resolvable ? resolved : undefined;
}

/**
 * `Outputs.*.Export.Name` を解決する。静的文字列はそのまま、`Fn::Sub` は擬似パラメータ
 * のみで構成される場合に解決する。それ以外(テンプレートパラメータ等の動的合成)は
 * `undefined` を返す。
 */
function resolveExportName(
  nameValue: unknown,
  ctx: TemplateAnalysisContext,
): string | undefined {
  if (typeof nameValue === 'string') return nameValue;
  if (isRecord(nameValue) && typeof nameValue['Fn::Sub'] === 'string') {
    return resolveSubTemplate(nameValue['Fn::Sub'], ctx);
  }
  return undefined;
}

/**
 * テンプレート全体(Resources / Outputs / Conditions 等すべて)を再帰走査し、
 * `Fn::ImportValue` の値が静的文字列であれば import として記録する。動的
 * (解決不能な `Fn::Sub` 等)であれば警告とする(design.md §6)。
 */
function walkForImports(
  node: unknown,
  imports: string[],
  warnings: string[],
  path: Array<string | number>,
): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => {
      path.push(i);
      walkForImports(item, imports, warnings, path);
      path.pop();
    });
    return;
  }
  if (!isRecord(node)) return;

  for (const [key, value] of Object.entries(node)) {
    path.push(key);
    if (key === 'Fn::ImportValue') {
      if (typeof value === 'string') {
        imports.push(value);
      } else {
        warnings.push(
          `${formatTemplatePath(path)} を解決できません(動的な合成のため import として扱いません): ${JSON.stringify(value)}`,
        );
      }
    }
    walkForImports(value, imports, warnings, path);
    path.pop();
  }
}

function formatTemplatePath(path: Array<string | number>): string {
  return `$${path
    .map((segment) =>
      typeof segment === 'number' ? `[${segment}]` : `.${segment}`,
    )
    .join('')}`;
}

function extractNoEchoParams(template: Record<string, unknown>): string[] {
  const params = template['Parameters'];
  if (!isRecord(params)) return [];

  const noEchoParams: string[] = [];
  for (const [name, def] of Object.entries(params)) {
    if (!isRecord(def)) continue;
    const noEcho = def['NoEcho'];
    if (noEcho === true || noEcho === 'true') {
      noEchoParams.push(name);
    }
  }
  return noEchoParams;
}

/**
 * テンプレートソースを解析し、import / export の依存辺・警告・NoEcho パラメータを
 * 抽出する(design.md §6, requirements.md FR-8 / NFR-4)。
 */
export function analyzeTemplate(
  source: string,
  ctx: TemplateAnalysisContext,
): TemplateAnalysis {
  return analyzeParsedTemplate(parseCfnTemplate(source), ctx);
}

/** パース済み AST から対象依存部分だけを解決する(Export の stack/region 解決は対象ごと)。 */
export function analyzeParsedTemplate(
  parsed: unknown,
  ctx: TemplateAnalysisContext,
): TemplateAnalysis {
  return resolveStaticTemplateAnalysis(analyzeStaticTemplate(parsed), ctx);
}

/** imports / NoEcho / Export 候補を AST から一度だけ抽出する。 */
export function analyzeStaticTemplate(parsed: unknown): StaticTemplateAnalysis {
  const template = isRecord(parsed) ? parsed : {};
  const warnings: string[] = [];
  const imports: string[] = [];
  walkForImports(template, imports, warnings, []);
  const exportCandidates: StaticTemplateAnalysis['exportCandidates'] = [];
  const outputs = template['Outputs'];
  if (isRecord(outputs)) {
    for (const [outputName, outputDef] of Object.entries(outputs)) {
      if (!isRecord(outputDef)) continue;
      const exportDef = outputDef['Export'];
      if (!isRecord(exportDef)) continue;
      exportCandidates.push({ outputName, nameValue: exportDef['Name'] });
    }
  }

  return {
    exportCandidates,
    imports: dedupePreserveOrder(imports),
    warnings,
    noEchoParams: extractNoEchoParams(template),
  };
}

/** 中間結果の Export 候補だけを stack/region 文脈で解決する。 */
export function resolveStaticTemplateAnalysis(
  analysis: StaticTemplateAnalysis,
  ctx: TemplateAnalysisContext,
): TemplateAnalysis {
  const warnings = [...analysis.warnings];
  const exports: string[] = [];
  for (const candidate of analysis.exportCandidates) {
    const resolved = resolveExportName(candidate.nameValue, ctx);
    if (resolved !== undefined) exports.push(resolved);
    else {
      warnings.push(
        `Outputs.${candidate.outputName}.Export.Name を解決できません(動的な合成のため export として扱いません): ${JSON.stringify(candidate.nameValue)}`,
      );
    }
  }

  return {
    imports: analysis.imports,
    exports: dedupePreserveOrder(exports),
    warnings,
    noEchoParams: analysis.noEchoParams,
  };
}
