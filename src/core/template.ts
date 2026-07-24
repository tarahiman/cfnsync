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
import { REQUIRED_PLACEHOLDER } from './constants.js';
import { TemplateParseError } from './errors.js';

/** ターゲット単位の依存名解決文脈。parameters はリージョン上書き反映済み。 */
export interface TemplateAnalysisContext {
  stackName: string;
  region: string;
  parameters?: Record<string, string>;
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
  exportCandidates: DependencyNameCandidate[];
  importCandidates: DependencyNameCandidate[];
  parameterDeclarations: Record<string, ParameterDeclaration>;
  noEchoParams: string[];
}

interface DependencyNameCandidate {
  path: string;
  value: unknown;
}

interface ParameterDeclaration {
  type: unknown;
  noEcho: boolean;
  hasDefault: boolean;
  defaultValue: unknown;
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
  try {
    // logLevel: 'silent' でパーサ由来の警告(未知タグ等、NoEcho 実値を含みうる
    // ソース断片)が診断として直接 stderr へ漏れるのを防ぐ(NFR-4)。
    return parseYaml(source, {
      customTags: CFN_CUSTOM_TAGS,
      logLevel: 'silent',
    });
  } catch (cause) {
    // ソース断片を含む可能性のある元例外メッセージは surface せず固定文に正規化する。
    throw new TemplateParseError(
      'テンプレートの解析に失敗しました(構文またはサポート外のタグ)',
      { cause },
    );
  }
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

/**
 * CREATE 復旧比較に用いる Parameter Default を文字列値へ正規化する。
 * CloudFormation が実効値として返す scalar だけを扱い、構造値・intrinsic は
 * 推測せず例外にして呼び出し側を fail-closed にする(FR-1-11(a))。
 */
export function extractParameterDefaults(
  parsedTemplate: unknown,
): Record<string, string> {
  if (!isRecord(parsedTemplate)) return {};
  const parameters = parsedTemplate.Parameters;
  if (parameters === undefined) return {};
  if (!isRecord(parameters)) {
    throw new TemplateParseError(
      'テンプレートの Parameters が object ではないため Default を比較できません',
    );
  }

  const defaults: Record<string, string> = {};
  for (const [name, definition] of Object.entries(parameters)) {
    if (!isRecord(definition)) {
      throw new TemplateParseError(
        `Parameter '${name}' の定義が object ではないため Default を比較できません`,
      );
    }
    if (!Object.hasOwn(definition, 'Default')) continue;

    const value = definition.Default;
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      throw new TemplateParseError(
        `Parameter '${name}' の Default は scalar ではないため比較できません`,
      );
    }
    defaults[name] = String(value);
  }
  return defaults;
}

/**
 * redaction 用に scalar な Parameter Default だけを文字列化して抽出する。
 *
 * 復旧比較用の extractParameterDefaults と異なり、非 scalar 値は比較判定に使わず
 * 無視する。redactor は literal な実値だけを置換できるためであり、設定や
 * inputsHash のパラメータ契約には影響させない(NFR-4)。
 */
export function extractScalarParameterDefaults(
  parsedTemplate: unknown,
): Record<string, string> {
  if (!isRecord(parsedTemplate) || !isRecord(parsedTemplate.Parameters)) {
    return {};
  }

  const defaults: Record<string, string> = {};
  for (const [name, definition] of Object.entries(parsedTemplate.Parameters)) {
    if (!isRecord(definition) || !Object.hasOwn(definition, 'Default')) {
      continue;
    }
    const value = definition.Default;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      defaults[name] = String(value);
    }
  }
  return defaults;
}

// ---------------------------------------------------------------------------
// Export / Import / NoEcho の抽出(design.md §6, NFR-4)
// ---------------------------------------------------------------------------

/** `${AWS::StackName}` / `${AWS::Region}` プレースホルダの置換パターン。 */
const SUB_VAR_PATTERN = /\$\{([^}]*)\}/g;

type NameResolution =
  | { resolved: true; value: string }
  | { resolved: false; reason: string };

function unresolved(reason: string): NameResolution {
  return { resolved: false, reason };
}

function resolveParameter(
  name: string,
  analysis: StaticTemplateAnalysis,
  ctx: TemplateAnalysisContext,
): NameResolution {
  const declaration = analysis.parameterDeclarations[name];
  if (declaration === undefined) {
    return unresolved(
      `Ref '${name}' はテンプレートの Parameters に宣言されたパラメータではありません`,
    );
  }
  if (declaration.type !== 'String' && declaration.type !== 'Number') {
    return unresolved(
      `Parameter '${name}' の Type '${String(declaration.type)}' は対応範囲外です`,
    );
  }
  if (declaration.noEcho) {
    return unresolved(`Parameter '${name}' は NoEcho のため解決しません`);
  }

  const parameters = ctx.parameters ?? {};
  if (Object.hasOwn(parameters, name)) {
    const value = parameters[name];
    if (value === REQUIRED_PLACEHOLDER) {
      return unresolved(
        `Parameter '${name}' の明示値が ${REQUIRED_PLACEHOLDER} のため値が確定できません`,
      );
    }
    return { resolved: true, value };
  }

  if (!declaration.hasDefault) {
    return unresolved(`Parameter '${name}' に明示値も Default 値もありません`);
  }
  const value = declaration.defaultValue;
  if (
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'boolean'
  ) {
    return unresolved(
      `Parameter '${name}' の Default は scalar ではありません`,
    );
  }
  return { resolved: true, value: String(value) };
}

/** 文字列形式の `Fn::Sub` を擬似パラメータと確定済み Parameter で解決する。 */
function resolveSubTemplate(
  template: string,
  analysis: StaticTemplateAnalysis,
  ctx: TemplateAnalysisContext,
): NameResolution {
  let failureReason: string | undefined;
  const resolved = template.replace(
    SUB_VAR_PATTERN,
    (_match, rawVarName: string) => {
      const varName = rawVarName.trim();
      if (varName.startsWith('!')) {
        return `\${${varName.slice(1)}}`;
      }
      if (varName === 'AWS::StackName') return ctx.stackName;
      if (varName === 'AWS::Region') return ctx.region;
      const parameter = resolveParameter(varName, analysis, ctx);
      if (parameter.resolved) return parameter.value;
      failureReason ??= parameter.reason;
      return '';
    },
  );
  return failureReason === undefined
    ? { resolved: true, value: resolved }
    : unresolved(failureReason);
}

/** 対応範囲を静的文字列 / Parameter Ref / 文字列形式 Fn::Sub に限定して解決する。 */
function resolveDependencyName(
  value: unknown,
  analysis: StaticTemplateAnalysis,
  ctx: TemplateAnalysisContext,
): NameResolution {
  if (typeof value === 'string') return { resolved: true, value };
  if (!isRecord(value)) {
    return unresolved('依存名の式が対応範囲外です');
  }
  if (Object.hasOwn(value, 'Ref')) {
    return typeof value.Ref === 'string'
      ? resolveParameter(value.Ref, analysis, ctx)
      : unresolved('Ref の参照先が文字列ではありません');
  }
  if (Object.hasOwn(value, 'Fn::Sub')) {
    return typeof value['Fn::Sub'] === 'string'
      ? resolveSubTemplate(value['Fn::Sub'], analysis, ctx)
      : unresolved('変数マップ形式の Fn::Sub は対応範囲外です');
  }
  return unresolved('依存名の intrinsic 式が対応範囲外です');
}

/**
 * テンプレート全体(Resources / Outputs / Conditions 等すべて)を再帰走査し、
 * `Fn::ImportValue` の候補とテンプレート上の位置を抽出する。
 */
function walkForImports(
  node: unknown,
  candidates: DependencyNameCandidate[],
  path: Array<string | number>,
): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => {
      path.push(i);
      walkForImports(item, candidates, path);
      path.pop();
    });
    return;
  }
  if (!isRecord(node)) return;

  for (const [key, value] of Object.entries(node)) {
    path.push(key);
    if (key === 'Fn::ImportValue') {
      candidates.push({ path: formatTemplatePath(path), value });
    }
    walkForImports(value, candidates, path);
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

function extractParameterDeclarations(
  template: Record<string, unknown>,
): Record<string, ParameterDeclaration> {
  const declarations: Record<string, ParameterDeclaration> = {};
  const params = template.Parameters;
  if (!isRecord(params)) return declarations;
  for (const [name, definition] of Object.entries(params)) {
    if (!isRecord(definition)) continue;
    const noEcho = definition.NoEcho;
    declarations[name] = {
      type: definition.Type,
      noEcho: noEcho === true || noEcho === 'true',
      hasDefault: Object.hasOwn(definition, 'Default'),
      defaultValue: definition.Default,
    };
  }
  return declarations;
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
  const importCandidates: DependencyNameCandidate[] = [];
  walkForImports(template, importCandidates, []);
  const exportCandidates: StaticTemplateAnalysis['exportCandidates'] = [];
  const outputs = template['Outputs'];
  if (isRecord(outputs)) {
    for (const [outputName, outputDef] of Object.entries(outputs)) {
      if (!isRecord(outputDef)) continue;
      const exportDef = outputDef['Export'];
      if (!isRecord(exportDef)) continue;
      exportCandidates.push({
        path: `Outputs.${outputName}.Export.Name`,
        value: exportDef['Name'],
      });
    }
  }

  return {
    exportCandidates,
    importCandidates,
    parameterDeclarations: extractParameterDeclarations(template),
    noEchoParams: extractNoEchoParams(template),
  };
}

/** 中間結果の Export / Import 候補を target の実効パラメータ文脈で解決する。 */
export function resolveStaticTemplateAnalysis(
  analysis: StaticTemplateAnalysis,
  ctx: TemplateAnalysisContext,
): TemplateAnalysis {
  const warnings: string[] = [];
  const imports: string[] = [];
  const exports: string[] = [];
  for (const candidate of analysis.importCandidates) {
    const result = resolveDependencyName(candidate.value, analysis, ctx);
    if (result.resolved) imports.push(result.value);
    else {
      warnings.push(
        `${candidate.path} を解決できません(${result.reason}。この候補は import として扱いません)`,
      );
    }
  }
  for (const candidate of analysis.exportCandidates) {
    const result = resolveDependencyName(candidate.value, analysis, ctx);
    if (result.resolved) exports.push(result.value);
    else {
      warnings.push(
        `${candidate.path} を解決できません(${result.reason}。この候補は export として扱いません)`,
      );
    }
  }

  return {
    imports: dedupePreserveOrder(imports),
    exports: dedupePreserveOrder(exports),
    warnings,
    noEchoParams: analysis.noEchoParams,
  };
}
