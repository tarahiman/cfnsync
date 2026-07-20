/**
 * T-16 usecase/importer — 既存スタックのインポート(初期同期。FR-10 / design.md §5.4)。
 *
 * インポートは「実環境を正」として既存デプロイ済みスタックを cfnsync の管理下に置く。
 * **AWS へは読み取り専用**(DescribeStacks / GetTemplate のみ)であり、書き込むのは
 * ローカルの設定ファイル(cfnsync.yaml)・テンプレートファイル・ステートに限る(FR-10-7)。
 *
 * design.md §5.4 の手順(順序が受け入れ基準):
 *   1. STS で接続先を解決 → **ステートロックを取得**(FR-10-9。取得失敗 → 一切の書き込み
 *      なしでエラー)。
 *   2. ロック配下で `verifyStateAccount`(**ロック後に再読込したステート**に対する照合。
 *      FR-10-8)。不一致 → 設定・ステート・テンプレートのいずれにも書き込みゼロで終了。
 *      未記録(初回)→ 同一ロック区間の CAS 保存でアカウント ID を記録。
 *   3. config の stacks × regions ごとに DescribeStacks + GetTemplate(Original)(読み取りのみ)。
 *   4. スタック名・パラメータ・タグ・Capabilities を `cfnsync.yaml` に **AST 編集**で書き戻す
 *      (`yaml` の Document API。コメント・キー順を保持。FR-10-1)。NoEcho は `__REQUIRED__` を
 *      記録し `****` を実値として書かない(FR-10-2)。
 *   5. デプロイ済みテンプレートとローカルの **パース後同値比較**(FR-10-3)。差分の扱いは
 *      `--reconcile remote|local` / `--write-template`(FR-10-4 / FR-10-5)。
 *   6. ステートには **デプロイ済み内容に基づく** templateHash / inputsHash と依存辺
 *      (exports / imports)を記録する(FR-10-6 / FR-10-11)。lastAction は `IMPORT`。
 *   7. 対応するスタックが存在しないテンプレートはステートに記録しない(次回 detect で
 *      `added`。FR-10-10)。
 *   8. **fencing(FR-1-9(import))**: 各ローカル書き込み(cfnsync.yaml・テンプレートファイル・
 *      ステート保存)の直前ごとに `backend.verifyLock`。喪失 → 残りの書き込みを行わず中断。
 *   9. 終了時 `releaseLock`(正常・異常とも)。
 *
 * `guard.ts` の契約(`verifyStateAccount` はロック取得後に呼ぶ)・`ports` は変更しない。
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseDocument } from 'yaml';

import type { CfnSyncConfig, ResolvedStackTarget } from '../core/config.js';
import {
  resolveDependsOnKey,
  resolveTargets,
  resolveTemplatePathWithinConfig,
} from '../core/config.js';
import { computeInputsHash, computeTemplateHash } from '../core/detect.js';
import { GuardError, LockError } from '../core/errors.js';
import {
  type CfnSyncState,
  prepareSave,
  type StackEntry,
  upsertStackEntry,
} from '../core/state.js';
import { analyzeTemplate, templatesEquivalent } from '../core/template.js';
import type { StackKey } from '../core/types.js';
import type {
  CloudFormationGateway,
  LockHandle,
  StateBackend,
  StateVersion,
  StsGateway,
} from '../ports/index.js';
import type { ConnectionInfo } from '../report/index.js';
import { MANAGEMENT_TAG_KEY, newRunId } from './executor.js';
import { fencedBackend } from './fencing.js';
import {
  connectionHeader,
  resolveConnection,
  verifyStateAccount,
} from './guard.js';

// ===========================================================================
// 公開 API(T-19 cli への契約)
// ===========================================================================

/** import が書き込むローカルファイル IO。テストで注入して書き込みを記録・検証する。 */
export interface ImportFileSystem {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  realpath(path: string): string;
}

export interface ImportDeps {
  /** リージョンごとの CloudFormationGateway を生成する(FR-13)。 */
  cfnFactory: (region: string) => CloudFormationGateway;
  sts: StsGateway;
  backend: StateBackend;
  /** 省略時は node:fs 実装(`defaultFileSystem`)。 */
  fs?: ImportFileSystem;
}

export interface ImportOptions {
  /** テンプレート差分時の解決方針(FR-10-4)。 */
  reconcile?: 'remote' | 'local';
  /** ローカルにテンプレートがない場合にデプロイ済みテンプレートを書き出す(FR-10-5)。 */
  writeTemplate?: boolean;
}

/** スタックキー単位のインポート結果(レポート)。 */
export interface ImportStackReport {
  stackKey: string;
  region: string;
  templatePath: string;
  /** デプロイ済みスタック名(存在した場合)。 */
  stackName?: string;
  status: 'imported' | 'not-found' | 'template-mismatch' | 'template-missing';
  /** テンプレート比較結果(スタックが存在した場合)。 */
  templateComparison?: 'match' | 'differs' | 'local-missing';
  /** 差分解決に用いた reconcile 方針。 */
  reconcile?: 'remote' | 'local';
  /** デプロイ済みテンプレートをローカルへ書き出したか。 */
  wroteTemplate?: boolean;
  /** ステートに記録したか(FR-10-6)。not-found / blocked は false。 */
  recorded: boolean;
  /** `__REQUIRED__` を記録した NoEcho パラメータ名(FR-10-2)。 */
  noEchoPlaceholders: string[];
  message?: string;
}

export interface ImportReport {
  /** FR-7-8: 解決した接続先(秘匿情報は含めない)。 */
  connection: ConnectionInfo;
  stacks: ImportStackReport[];
  /** cfnsync.yaml に書き戻したか(FR-10-1)。 */
  configWritten: boolean;
  /** ステートを保存したか(FR-10-6)。 */
  stateSaved: boolean;
  /**
   * 中断・失敗の理由。
   * - `lock-unavailable`: ロック取得失敗(FR-10-9)
   * - `account-mismatch`: ステートアカウント不一致(FR-10-8)
   * - `template-blocking`: 差分 + reconcile 未指定 / ローカル欠如 + write-template 未指定(FR-10-4/5)
   * - `ownership-lost`: 書き込み直前 fencing で所有権喪失(FR-1-9)
   */
  aborted?:
    | 'lock-unavailable'
    | 'account-mismatch'
    | 'template-blocking'
    | 'ownership-lost';
  warnings: string[];
}

export interface ImportResult {
  exitCode: 0 | 1;
  report: ImportReport;
}

/** node:fs による既定のファイル IO(本番経路)。 */
export const defaultFileSystem: ImportFileSystem = {
  readFile: (path) => readFileSync(path, 'utf8'),
  writeFile: (path, content) => writeFileSync(path, content),
  exists: (path) => existsSync(path),
  realpath: (path) => realpathSync(path),
};

// ===========================================================================
// runImport 本体
// ===========================================================================

export async function runImport(input: {
  config: CfnSyncConfig;
  configPath: string;
  deps: ImportDeps;
  options: ImportOptions;
}): Promise<ImportResult> {
  const { config, configPath, deps, options } = input;
  const fs = deps.fs ?? defaultFileSystem;
  const configDir = dirname(resolve(configPath));
  const templatePaths = new Map(
    Object.keys(config.stacks).map((templatePath) => [
      templatePath,
      resolveTemplatePathWithinConfig(configDir, templatePath, fs),
    ]),
  );

  // FR-7-7 / FR-10-8: import は許可設定なしで実行できるが、STS 解決とアカウント照合は必須。
  const connection = await resolveConnection(deps.sts);
  const header = connectionHeader({
    accountId: connection.accountId,
    regions: uniqueRegions(config),
  });

  // 1. ステートロックの取得(FR-10-9)。取得失敗 → 一切の書き込みなしでエラー。
  let lock: LockHandle;
  try {
    lock = await deps.backend.acquireLock({
      runId: newRunId(),
      startedAt: new Date().toISOString(),
      owner: process.env.USER ?? process.env.LOGNAME ?? 'cfnsync',
    });
  } catch (err) {
    if (err instanceof LockError) {
      return {
        exitCode: 1,
        report: emptyReport(
          header,
          'lock-unavailable',
          `ステートロックを取得できませんでした: ${err.message}`,
        ),
      };
    }
    throw err;
  }

  try {
    // 2. ロック配下でステートを再読込し accountId を照合(FR-10-8)。
    //    不一致 → GuardError(書き込みゼロ)/ 未記録 → 同一ロック区間の CAS 保存で記録。
    let stateCtx: { state: CfnSyncState; version: StateVersion | undefined };
    try {
      stateCtx = await verifyStateAccount({
        backend: fencedBackend(deps.backend, lock),
        accountId: connection.accountId,
      });
    } catch (err) {
      if (err instanceof GuardError) {
        return {
          exitCode: 1,
          report: emptyReport(header, 'account-mismatch', err.message),
        };
      }
      if (err instanceof LockError) {
        return {
          exitCode: 1,
          report: emptyReport(header, 'ownership-lost', err.message),
        };
      }
      throw err;
    }

    // 3〜7. AWS からの読み取りと書き込み計画の立案(この段では一切書き込まない)。
    const plan = await buildImportPlan({
      config,
      configPath,
      options,
      fs,
      deps,
      templatePaths,
    });

    // FR-10-4 / FR-10-5: 解決不能な差分・欠如がある場合は fail-closed(書き込みゼロ)。
    if (plan.blocked) {
      return {
        exitCode: 1,
        report: {
          connection: header,
          stacks: plan.stacks,
          configWritten: false,
          stateSaved: false,
          aborted: 'template-blocking',
          warnings: plan.warnings,
        },
      };
    }

    // 8. 各ローカル書き込みの直前ごとに fencing 検証(FR-1-9(import))。
    let configWritten = false;
    let stateSaved = false;
    let ownershipLost = false;

    // 4. cfnsync.yaml への書き戻し(コメント・キー順保持。FR-10-1)。
    if (plan.reflect.size > 0) {
      const doc = parseDocument(fs.readFile(configPath));
      for (const [templatePath, reflect] of plan.reflect) {
        applyReflect(doc, templatePath, reflect);
      }
      const nextConfigText = doc.toString();
      if (await deps.backend.verifyLock(lock)) {
        fs.writeFile(configPath, nextConfigText);
        configWritten = true;
      } else {
        ownershipLost = true;
      }
    }

    // 5. テンプレートファイルの書き出し(reconcile remote / write-template。FR-10-4/5)。
    if (!ownershipLost) {
      for (const write of plan.templateWrites) {
        if (!(await deps.backend.verifyLock(lock))) {
          ownershipLost = true;
          break;
        }
        const safePath = resolveTemplatePathWithinConfig(
          configDir,
          write.templatePath,
          fs,
        );
        fs.writeFile(safePath, write.content);
      }
    }

    // 6. ステート保存(CAS。FR-10-6)。
    if (!ownershipLost && plan.entries.length > 0) {
      if (await deps.backend.verifyLock(lock)) {
        let nextState = stateCtx.state;
        for (const { key, entry } of plan.entries) {
          nextState = upsertStackEntry(nextState, key, entry);
        }
        await deps.backend.save(prepareSave(nextState), stateCtx.version);
        stateSaved = true;
      } else {
        ownershipLost = true;
      }
    }

    return {
      exitCode: ownershipLost ? 1 : 0,
      report: {
        connection: header,
        stacks: plan.stacks,
        configWritten,
        stateSaved,
        aborted: ownershipLost ? 'ownership-lost' : undefined,
        warnings: plan.warnings,
      },
    };
  } finally {
    // 9. ロックの解放(正常・異常とも)。所有権喪失時は条件不成立で無害に失敗する。
    await deps.backend.releaseLock(lock);
  }
}

// ===========================================================================
// 計画立案(AWS 読み取り + 書き込み内容の決定。ここでは書き込みを行わない)
// ===========================================================================

/** 1 テンプレートを cfnsync.yaml に反映するためのデータ。 */
interface ReflectData {
  stackName: string;
  capabilities: string[];
  /** 設定上のリージョン数が 2 以上か(FR-13: 2 以上は regionOverrides に書き分ける)。 */
  multiRegion: boolean;
  regions: {
    region: string;
    parameters: Record<string, string>;
    tags: Record<string, string>;
  }[];
}

interface TemplateWrite {
  templatePath: string;
  content: string;
}

interface ImportPlan {
  stacks: ImportStackReport[];
  warnings: string[];
  /** ステートに upsert するエントリ(FR-10-6/11)。 */
  entries: { key: StackKey; entry: StackEntry }[];
  /** templatePath → 設定反映データ(FR-10-1)。 */
  reflect: Map<string, ReflectData>;
  /** 書き出すテンプレートファイル(templatePath 単位で重複排除)。 */
  templateWrites: TemplateWrite[];
  /** 解決不能な差分・欠如を検出したか(fail-closed。書き込みを行わない)。 */
  blocked: boolean;
}

async function buildImportPlan(args: {
  config: CfnSyncConfig;
  configPath: string;
  options: ImportOptions;
  fs: ImportFileSystem;
  deps: ImportDeps;
  templatePaths: Map<string, string>;
}): Promise<ImportPlan> {
  const { config, options, fs, deps, templatePaths } = args;
  const targets = resolveTargets(config);

  const regionCountByTemplate = new Map<string, number>();
  for (const target of targets) {
    regionCountByTemplate.set(
      target.templatePath,
      (regionCountByTemplate.get(target.templatePath) ?? 0) + 1,
    );
  }

  const stacks: ImportStackReport[] = [];
  const warnings: string[] = [];
  const entries: { key: StackKey; entry: StackEntry }[] = [];
  const reflect = new Map<string, ReflectData>();
  const templateWritesByPath = new Map<string, TemplateWrite>();
  let blocked = false;

  for (const target of targets) {
    const cfn = deps.cfnFactory(target.region);

    // FR-10-7: DescribeStacks(読み取り)。不存在は undefined。
    const summary = await cfn.describeStack(target.stackName);
    if (summary === undefined) {
      // FR-10-10: 対応するスタックが存在しない → ステートに記録しない(次回 detect で added)。
      stacks.push({
        stackKey: target.stackKey,
        region: target.region,
        templatePath: target.templatePath,
        status: 'not-found',
        recorded: false,
        noEchoPlaceholders: [],
      });
      continue;
    }

    // FR-10-7: GetTemplate(Original)(読み取り)。
    const deployedTemplate = await cfn.getTemplate(
      target.stackName,
      'Original',
    );
    const deployedAnalysis = analyzeTemplate(deployedTemplate, {
      stackName: summary.stackName,
      region: target.region,
    });

    const configParameters = toConfigParameters(
      summary.parameters,
      deployedAnalysis.noEchoParams,
    );
    const configTags = toConfigTags(summary.tags);
    const noEchoPlaceholders = Object.keys(configParameters).filter(
      (key) => configParameters[key] === REQUIRED_PLACEHOLDER,
    );

    const templateAbsPath = templatePaths.get(target.templatePath);
    if (templateAbsPath === undefined) {
      throw new Error(
        `内部エラー: ${target.templatePath} の安全な実パスがありません`,
      );
    }
    const localExists = fs.exists(templateAbsPath);

    // FR-10-3/4/5: テンプレート比較 → 記録に使う基準内容(baseline)と書き出し内容を決める。
    let comparison: 'match' | 'differs' | 'local-missing';
    let baseline: string;
    let writeContent: string | undefined;
    let reconcileUsed: 'remote' | 'local' | undefined;

    if (!localExists) {
      comparison = 'local-missing';
      if (options.writeTemplate) {
        // FR-10-5: デプロイ済みテンプレートをローカルへ書き出す。
        baseline = deployedTemplate;
        writeContent = deployedTemplate;
      } else {
        blocked = true;
        stacks.push({
          stackKey: target.stackKey,
          region: target.region,
          templatePath: target.templatePath,
          stackName: summary.stackName,
          status: 'template-missing',
          templateComparison: 'local-missing',
          recorded: false,
          noEchoPlaceholders,
          message:
            'ローカルにテンプレートファイルが存在しません。--write-template を指定して書き出してください',
        });
        continue;
      }
    } else {
      const localContent = fs.readFile(templateAbsPath);
      if (templatesEquivalent(localContent, deployedTemplate)) {
        // FR-10-3: 一致 → ローカル(= デプロイ済みと同値)を基準に記録。次回 plan は unchanged。
        comparison = 'match';
        baseline = localContent;
      } else if (options.reconcile === 'remote') {
        // FR-10-4(a): デプロイ済みでローカルを上書き。
        comparison = 'differs';
        reconcileUsed = 'remote';
        baseline = deployedTemplate;
        writeContent = deployedTemplate;
      } else if (options.reconcile === 'local') {
        // FR-10-4(b): ローカルを維持し、ステートにはデプロイ済み側のハッシュを記録
        //             → 次回 plan で modified として顕在化する。
        comparison = 'differs';
        reconcileUsed = 'local';
        baseline = deployedTemplate;
      } else {
        // FR-10-4: 差分 + オプションなし → fail-closed。
        blocked = true;
        stacks.push({
          stackKey: target.stackKey,
          region: target.region,
          templatePath: target.templatePath,
          stackName: summary.stackName,
          status: 'template-mismatch',
          templateComparison: 'differs',
          recorded: false,
          noEchoPlaceholders,
          message:
            'デプロイ済みテンプレートとローカルに差分があります。--reconcile remote|local を指定してください',
        });
        continue;
      }
    }

    // FR-10-6 / FR-10-11: デプロイ済み内容(baseline)に基づくハッシュ・依存辺を記録する。
    const baselineAnalysis = analyzeTemplate(baseline, {
      stackName: summary.stackName,
      region: target.region,
    });
    entries.push({
      key: target.stackKey,
      entry: {
        stackName: summary.stackName,
        region: target.region,
        templateHash: computeTemplateHash(baseline),
        inputsHash: computeInputsHash({
          templateContent: baseline,
          stackName: summary.stackName,
          parameters: configParameters,
          tags: configTags,
          capabilities: summary.capabilities,
          // dependsOn は実スタックから検証できないため、ローカルの希望値を記録する(§7)。
          dependsOn: target.dependsOn,
        }),
        exports: baselineAnalysis.exports,
        imports: baselineAnalysis.imports,
        dependsOn: target.dependsOn.map((raw) =>
          resolveDependsOnKey(raw, target.region),
        ),
        lastAction: 'IMPORT',
        lastSuccessAt: new Date().toISOString(),
      },
    });
    if (baselineAnalysis.warnings.length > 0) {
      warnings.push(...baselineAnalysis.warnings);
    }

    // FR-10-1: cfnsync.yaml への反映データを集約(templatePath 単位)。
    const existing = reflect.get(target.templatePath);
    const reflectData: ReflectData = existing ?? {
      stackName: summary.stackName,
      capabilities: summary.capabilities,
      multiRegion: (regionCountByTemplate.get(target.templatePath) ?? 1) > 1,
      regions: [],
    };
    reflectData.regions.push({
      region: target.region,
      parameters: configParameters,
      tags: configTags,
    });
    reflect.set(target.templatePath, reflectData);

    // テンプレート書き出しは templatePath 単位で 1 回(最初に決まった内容)。
    if (
      writeContent !== undefined &&
      !templateWritesByPath.has(target.templatePath)
    ) {
      templateWritesByPath.set(target.templatePath, {
        templatePath: target.templatePath,
        content: writeContent,
      });
    }

    stacks.push({
      stackKey: target.stackKey,
      region: target.region,
      templatePath: target.templatePath,
      stackName: summary.stackName,
      status: 'imported',
      templateComparison: comparison,
      reconcile: reconcileUsed,
      wroteTemplate: writeContent !== undefined,
      recorded: true,
      noEchoPlaceholders,
    });
  }

  return {
    stacks,
    warnings,
    entries,
    reflect,
    templateWrites: [...templateWritesByPath.values()],
    blocked,
  };
}

// ===========================================================================
// cfnsync.yaml の AST 編集(コメント・キー順保持。FR-10-1 / design.md §4.2)
// ===========================================================================

/**
 * `parseDocument` で得た Document に対し、1 テンプレート分のインポート結果を `setIn` で
 * 反映する。未変更ノードのコメント・キー順は yaml パッケージが保持する。
 * 設定上のリージョンが 2 以上の場合はパラメータ・タグを `regionOverrides.<region>` に書き分ける
 * (FR-13-3。リージョン依存の値に対応)。
 */
function applyReflect(
  doc: ReturnType<typeof parseDocument>,
  templatePath: string,
  reflect: ReflectData,
): void {
  doc.setIn(['stacks', templatePath, 'stackName'], reflect.stackName);
  if (reflect.capabilities.length > 0) {
    doc.setIn(
      ['stacks', templatePath, 'capabilities'],
      [...reflect.capabilities],
    );
  }

  if (reflect.multiRegion) {
    for (const region of reflect.regions) {
      for (const [key, value] of Object.entries(region.parameters)) {
        doc.setIn(
          [
            'stacks',
            templatePath,
            'regionOverrides',
            region.region,
            'parameters',
            key,
          ],
          value,
        );
      }
      for (const [key, value] of Object.entries(region.tags)) {
        doc.setIn(
          [
            'stacks',
            templatePath,
            'regionOverrides',
            region.region,
            'tags',
            key,
          ],
          value,
        );
      }
    }
    return;
  }

  const single = reflect.regions[0];
  if (single === undefined) return;
  for (const [key, value] of Object.entries(single.parameters)) {
    doc.setIn(['stacks', templatePath, 'parameters', key], value);
  }
  for (const [key, value] of Object.entries(single.tags)) {
    doc.setIn(['stacks', templatePath, 'tags', key], value);
  }
}

// ===========================================================================
// 補助
// ===========================================================================

/** deploy 時に残存していると検証エラーになる NoEcho プレースホルダ(design.md §8.2)。 */
const REQUIRED_PLACEHOLDER = '__REQUIRED__';

/**
 * DescribeStacks のパラメータを設定ファイルへ書き戻す値に変換する。NoEcho パラメータ
 * (テンプレート由来、または AWS が `****` でマスクした値)は実値の代わりに `__REQUIRED__`
 * を記録する(FR-10-2。マスク値 `****` を実値として書かない)。
 */
function toConfigParameters(
  deployedParameters: Record<string, string>,
  noEchoParams: string[],
): Record<string, string> {
  const noEchoSet = new Set(noEchoParams);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(deployedParameters)) {
    result[key] =
      noEchoSet.has(key) || value === '****' ? REQUIRED_PLACEHOLDER : value;
  }
  return result;
}

/** 管理タグ(`cfnsync:state-id`)は自動付与されるため設定ファイルへは書き戻さない(§8.4)。 */
function toConfigTags(
  deployedTags: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(deployedTags)) {
    if (key === MANAGEMENT_TAG_KEY) continue;
    result[key] = value;
  }
  return result;
}

/** 設定上の対象リージョンを出現順・重複排除で返す(接続先ヘッダ用。FR-7-8)。 */
function uniqueRegions(config: CfnSyncConfig): string[] {
  const seen = new Set<string>();
  const regions: string[] = [];
  for (const target of resolveTargets(config)) {
    if (!seen.has(target.region)) {
      seen.add(target.region);
      regions.push(target.region);
    }
  }
  return regions;
}

function emptyReport(
  connection: ConnectionInfo,
  aborted: ImportReport['aborted'],
  message: string,
): ImportReport {
  return {
    connection,
    stacks: [],
    configWritten: false,
    stateSaved: false,
    aborted,
    warnings: [message],
  };
}

// ResolvedStackTarget は buildImportPlan の型に用いる(resolveTargets の戻り値)。
export type { ResolvedStackTarget };
