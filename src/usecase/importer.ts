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

import { parseDocument } from 'yaml';

import type { Capability, CfnSyncConfig } from '../core/config.js';
import { resolveTargets } from '../core/config.js';
import { REQUIRED_PLACEHOLDER } from '../core/constants.js';
import { resolveDependsOnKey } from '../core/dependency.js';
import { computeInputsHash, computeTemplateHash } from '../core/detect.js';
import {
  CfnSyncError,
  GuardError,
  InvariantError,
  LockError,
  StackStateError,
  StatePersistenceError,
} from '../core/errors.js';
import {
  type CfnSyncState,
  prepareSave,
  type StackEntry,
} from '../core/state.js';
import {
  analyzeStaticTemplate,
  parseCfnTemplate,
  parsedTemplatesEquivalent,
  resolveStaticTemplateAnalysis,
  type StaticTemplateAnalysis,
} from '../core/template.js';
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
import { withFencedLock } from './fencing.js';
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
  isFile(path: string): boolean;
}

export interface ImportDeps {
  /** リージョンごとの CloudFormationGateway を生成する(FR-13)。 */
  cfnFactory: (region: string) => CloudFormationGateway;
  sts: StsGateway;
  backend: StateBackend;
  fs: ImportFileSystem;
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
  /** 初回 accountId の state 保存を行ったか。 */
  accountStateInitialized: boolean;
  /** import entry の state 保存を行ったか。 */
  importEntriesSaved: boolean;
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
  /**
   * text 出力専用の診断。JSON に直列化する report から内部 cause を分離する。
   * 省略時は report.warnings をそのまま text warning として使用する。
   */
  textDiagnostics?: string[];
}

// ===========================================================================
// runImport 本体
// ===========================================================================

export async function runImport(input: {
  config: CfnSyncConfig;
  configPath: string;
  templatePaths: Map<string, string>;
  deps: ImportDeps;
  options: ImportOptions;
}): Promise<ImportResult> {
  const { config, configPath, templatePaths, deps, options } = input;
  const fs = deps.fs;

  // FR-7-7 / FR-10-8: import は許可設定なしで実行できるが、STS 解決とアカウント照合は必須。
  const connection = await resolveConnection(deps.sts);
  const header = connectionHeader({
    accountId: connection.accountId,
    regions: uniqueRegions(config),
  });

  // 1. 共通 runner でロック取得・fenced scope・条件付き解放を固定する。
  try {
    return await withFencedLock({
      backend: deps.backend,
      info: {
        runId: newRunId(),
        startedAt: new Date().toISOString(),
        owner: process.env.USER ?? process.env.LOGNAME ?? 'cfnsync',
      },
      run: async ({ lock, backend: fenced }) => {
        // 2. ロック配下でステートを再読込し accountId を照合(FR-10-8)。
        //    不一致 → GuardError(書き込みゼロ)/ 未記録 → 同一ロック区間の CAS 保存で記録。
        let stateCtx: {
          state: CfnSyncState;
          version: StateVersion | undefined;
          accountStateInitialized: boolean;
        };
        try {
          stateCtx = await verifyStateAccount({
            backend: fenced,
            accountId: connection.accountId,
          });
        } catch (err) {
          if (err instanceof GuardError) {
            return {
              exitCode: 1,
              report: emptyReport(
                header,
                'account-mismatch',
                err.publicMessage,
              ),
            };
          }
          if (err instanceof LockError) {
            return {
              exitCode: 1,
              report: emptyReport(header, 'ownership-lost', err.publicMessage),
            };
          }
          throw err;
        }

        return runImportLocked({
          config,
          configPath,
          deps,
          fs,
          options,
          header,
          templatePaths,
          lock,
          stateCtx,
        });
      },
      onReleaseError: (result, error) => ({
        exitCode: 1,
        report: {
          ...result.report,
          warnings: [
            ...result.report.warnings,
            `ロック解放に失敗しました: ${publicWarningMessage(error)}`,
          ],
        },
        textDiagnostics: [
          ...(result.textDiagnostics ?? result.report.warnings),
          `ロック解放に失敗しました: ${textDiagnosticMessage(error)}`,
        ],
      }),
    });
  } catch (err) {
    if (err instanceof LockError) {
      return {
        exitCode: 1,
        report: emptyReport(
          header,
          'lock-unavailable',
          `ステートロックを取得できませんでした: ${err.publicMessage}`,
        ),
        textDiagnostics: [
          `ステートロックを取得できませんでした: ${err.message}`,
        ],
      };
    }
    throw err;
  }
}

async function runImportLocked(input: {
  config: CfnSyncConfig;
  configPath: string;
  deps: ImportDeps;
  fs: ImportFileSystem;
  options: ImportOptions;
  header: ConnectionInfo;
  templatePaths: Map<string, string>;
  lock: LockHandle;
  stateCtx: {
    state: CfnSyncState;
    version: StateVersion | undefined;
    accountStateInitialized: boolean;
  };
}): Promise<ImportResult> {
  const {
    config,
    configPath,
    deps,
    fs,
    options,
    header,
    templatePaths,
    lock,
    stateCtx,
  } = input;
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
        stateSaved: stateCtx.accountStateInitialized,
        accountStateInitialized: stateCtx.accountStateInitialized,
        importEntriesSaved: false,
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
      const safePath = templatePaths.get(write.templatePath);
      if (safePath === undefined) {
        throw new InvariantError(
          `テンプレートの検証済み実パスがありません: ${write.templatePath}`,
          { stackKey: write.templatePath },
        );
      }
      fs.writeFile(safePath, write.content);
    }
  }

  // 6. ステート保存(CAS。FR-10-6)。
  if (!ownershipLost && plan.entries.length > 0) {
    if (await deps.backend.verifyLock(lock)) {
      const importedEntries = Object.fromEntries(
        plan.entries.map(({ key, entry }) => [key, entry]),
      );
      const nextState: CfnSyncState = {
        ...stateCtx.state,
        stacks: { ...stateCtx.state.stacks, ...importedEntries },
      };
      try {
        await deps.backend.save(prepareSave(nextState), stateCtx.version);
      } catch (cause) {
        throw new StatePersistenceError(
          'import 結果のステート保存に失敗しました',
          { cause },
        );
      }
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
      stateSaved: stateCtx.accountStateInitialized || stateSaved,
      accountStateInitialized: stateCtx.accountStateInitialized,
      importEntriesSaved: stateSaved,
      aborted: ownershipLost ? 'ownership-lost' : undefined,
      warnings: plan.warnings,
    },
  };
}

// ===========================================================================
// 計画立案(AWS 読み取り + 書き込み内容の決定。ここでは書き込みを行わない)
// ===========================================================================

/** 1 テンプレートを cfnsync.yaml に反映するためのデータ。 */
interface ReflectData {
  stackName: string;
  capabilities: Capability[];
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
  const localTemplates = new Map<
    string,
    { content: string; parsed: unknown; hash: string }
  >();
  const representableByTemplate = new Map<
    string,
    {
      parsed: unknown;
      staticAnalysis: StaticTemplateAnalysis;
      capabilities: Capability[];
      regions: string[];
    }
  >();
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
    if (!summary.stackId) {
      throw new StackStateError(
        `スタック '${target.stackName}' の stackId(ARN) を確認できないため import を拒否します`,
        { stackKey: target.stackKey, region: target.region },
      );
    }

    // FR-10-7: GetTemplate(Original)(読み取り)。
    const deployedTemplate = await cfn.getTemplate(
      target.stackName,
      'Original',
    );
    const deployedParsed = parseCfnTemplate(deployedTemplate);
    const deployedHash = computeTemplateHash(deployedTemplate);

    const representation = representableByTemplate.get(target.templatePath);
    let staticAnalysis: StaticTemplateAnalysis;
    if (representation === undefined) {
      staticAnalysis = analyzeStaticTemplate(deployedParsed);
      representableByTemplate.set(target.templatePath, {
        parsed: deployedParsed,
        staticAnalysis,
        capabilities: [...summary.capabilities],
        regions: [target.region],
      });
    } else {
      representation.regions.push(target.region);
      const sameTemplate = parsedTemplatesEquivalent(
        representation.parsed,
        deployedParsed,
      );
      const sameCapabilities =
        JSON.stringify([...representation.capabilities].sort()) ===
        JSON.stringify([...summary.capabilities].sort());
      if (!sameTemplate || !sameCapabilities) {
        blocked = true;
        const regions = representation.regions.join(', ');
        const differences = [
          !sameTemplate ? 'テンプレート' : undefined,
          !sameCapabilities ? 'Capabilities' : undefined,
        ].filter((value): value is string => value !== undefined);
        const message = `同一 templatePath '${target.templatePath}' の ${differences.join(' / ')} がリージョン間で一致せず、設定では表現できません: ${regions}`;
        warnings.push(message);
        stacks.push({
          stackKey: target.stackKey,
          region: target.region,
          templatePath: target.templatePath,
          stackName: summary.stackName,
          status: 'template-mismatch',
          recorded: false,
          noEchoPlaceholders: [],
          message,
        });
        continue;
      }
      staticAnalysis = representation.staticAnalysis;
    }
    const configParameters = toConfigParameters(
      summary.parameters,
      staticAnalysis.noEchoParams,
    );
    const deployedAnalysis = resolveStaticTemplateAnalysis(staticAnalysis, {
      stackName: summary.stackName,
      region: target.region,
      parameters: configParameters,
    });
    const configTags = toConfigTags(summary.tags);
    const noEchoPlaceholders = Object.keys(configParameters).filter(
      (key) => configParameters[key] === REQUIRED_PLACEHOLDER,
    );

    const templateAbsPath = templatePaths.get(target.templatePath);
    if (templateAbsPath === undefined) {
      throw new InvariantError(
        `内部エラー: ${target.templatePath} の安全な実パスがありません`,
        { stackKey: target.stackKey, region: target.region },
      );
    }
    const localExists = fs.exists(templateAbsPath);

    // FR-10-3/4/5: テンプレート比較 → 記録に使う基準内容(baseline)と書き出し内容を決める。
    let comparison: 'match' | 'differs' | 'local-missing';
    let baselineHash: string;
    let writeContent: string | undefined;
    let reconcileUsed: 'remote' | 'local' | undefined;

    if (!localExists) {
      comparison = 'local-missing';
      if (options.writeTemplate) {
        // FR-10-5: デプロイ済みテンプレートをローカルへ書き出す。
        baselineHash = deployedHash;
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
      let local = localTemplates.get(target.templatePath);
      if (local === undefined) {
        const content = fs.readFile(templateAbsPath);
        local = {
          content,
          parsed: parseCfnTemplate(content),
          hash: computeTemplateHash(content),
        };
        localTemplates.set(target.templatePath, local);
      }
      if (parsedTemplatesEquivalent(local.parsed, deployedParsed)) {
        // FR-10-3: テンプレート内容が一致 → ローカル(= デプロイ済みと同値)を基準に記録。
        // テンプレート・パラメータ・タグ・Capabilities・dependsOn がすべて実スタックの
        // 記録値と一致する限り次回 plan は unchanged になるが、design.md §4.2 の通り
        // defaultTags が実スタックに未付与のキーを追加する場合はタグが一致しないため
        // 対象外(その場合は次回 modified として検知され、意図した挙動)。
        comparison = 'match';
        baselineHash = local.hash;
      } else if (options.reconcile === 'remote') {
        // FR-10-4(a): デプロイ済みでローカルを上書き。
        comparison = 'differs';
        reconcileUsed = 'remote';
        baselineHash = deployedHash;
        writeContent = deployedTemplate;
      } else if (options.reconcile === 'local') {
        // FR-10-4(b): ローカルを維持し、ステートにはデプロイ済み側のハッシュを記録
        //             → 次回 plan で modified として顕在化する。
        comparison = 'differs';
        reconcileUsed = 'local';
        baselineHash = deployedHash;
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
    const baselineAnalysis = deployedAnalysis;
    entries.push({
      key: target.stackKey,
      entry: {
        stackName: summary.stackName,
        stackId: summary.stackId,
        region: target.region,
        templateHash: baselineHash,
        inputsHash: computeInputsHash({
          templateHash: baselineHash,
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
        dependencyAnalysisIncomplete:
          baselineAnalysis.warnings.length > 0 && target.dependsOn.length === 0,
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
  doc.setIn(
    ['stacks', templatePath, 'capabilities'],
    [...reflect.capabilities],
  );

  if (reflect.multiRegion) {
    doc.setIn(['stacks', templatePath, 'parameters'], {});
    doc.setIn(['stacks', templatePath, 'tags'], {});
    const overrides: Record<
      string,
      { parameters: Record<string, string>; tags: Record<string, string> }
    > = {};
    for (const region of reflect.regions) {
      overrides[region.region] = {
        parameters: { ...region.parameters },
        tags: { ...region.tags },
      };
    }
    doc.setIn(['stacks', templatePath, 'regionOverrides'], overrides);
    return;
  }

  const single = reflect.regions[0];
  if (single === undefined) return;
  doc.setIn(['stacks', templatePath, 'parameters'], {
    ...single.parameters,
  });
  doc.setIn(['stacks', templatePath, 'tags'], { ...single.tags });
  doc.setIn(['stacks', templatePath, 'regionOverrides'], {});
}

// ===========================================================================
// 補助
// ===========================================================================

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
    accountStateInitialized: false,
    importEntriesSaved: false,
    aborted,
    warnings: [message],
  };
}

function publicWarningMessage(error: unknown): string {
  return error instanceof CfnSyncError
    ? error.publicMessage
    : '予期しないエラーが発生しました';
}

function textDiagnosticMessage(error: unknown): string {
  return error instanceof CfnSyncError
    ? error.message
    : '予期しないエラーが発生しました';
}
