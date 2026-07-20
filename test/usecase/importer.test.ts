/**
 * T-16 usecase/importer — 既存スタックのインポートのテスト(tasks.md §6 T-16 の対応表)。
 *
 * 対応 ID: FR-10-1〜FR-10-11 / FR-1-9(import) / FR-13-9。
 * ゲートウェイ(CloudFormationGateway / StsGateway / StateBackend)とファイル IO は
 * すべて本ファイル内のインメモリフェイクに差し替え、実 AWS・実ファイルには一切
 * 触れない(design.md §10)。フェイクは **呼び出しを共有 timeline に時系列記録**し、
 * FR-10-8(acquireLock → load の順)や FR-1-9(各書き込み直前の verifyLock 配置)の
 * 順序検証に使う。`test/usecase/fakes.ts` は並行タスクが編集中のため使用しない。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parse as parseYaml } from 'yaml';
import { validateConfig, resolveTargets, type CfnSyncConfig } from '../../src/core/config.js';
import { computeInputsHash, computeTemplateHash, detectChanges } from '../../src/core/detect.js';
import { LockError, StateConflictError } from '../../src/core/errors.js';
import { createInitialState, withAccountId, type CfnSyncState } from '../../src/core/state.js';
import { parseCfnTemplate } from '../../src/core/template.js';
import type {
  ChangeSetDetail,
  CloudFormationGateway,
  CreateChangeSetInput,
  LockHandle,
  LockInfo,
  StackSummary,
  StateBackend,
  StateVersion,
  StsGateway,
  TemplateStage,
} from '../../src/ports/index.js';
import { MANAGEMENT_TAG_KEY } from '../../src/usecase/executor.js';
import {
  runImport,
  type ImportDeps,
  type ImportFileSystem,
  type ImportOptions,
} from '../../src/usecase/importer.js';

// ---------------------------------------------------------------------------
// fixture(コメント・キー順つき cfnsync.yaml と CFN テンプレート)
// ---------------------------------------------------------------------------

const FIXTURES = new URL('../fixtures/import/', import.meta.url);
const NETWORK_TEMPLATE = readFileSync(new URL('network.yaml', FIXTURES), 'utf8');
const APP_TEMPLATE = readFileSync(new URL('app.yaml', FIXTURES), 'utf8');
const CONFIG_TEXT = readFileSync(new URL('cfnsync.yaml', FIXTURES), 'utf8');

/** デプロイ済みが JSON 形式(書式・キー順が異なるがパース後同値)のバリエーション(FR-10-3)。 */
const DEPLOYED_JSON = JSON.stringify(parseCfnTemplate(NETWORK_TEMPLATE), null, 2);

/** デプロイ済みがローカルと実質差分を持つバリエーション(FR-10-4)。 */
const DEPLOYED_DIFFERENT = NETWORK_TEMPLATE.replace('CidrBlock: !Ref VpcCidr', 'CidrBlock: 10.99.0.0/16');

const ACCOUNT = '123456789012';
const OTHER_ACCOUNT = '999999999999';
const REGION = 'ap-northeast-1';
const REGION2 = 'us-east-1';
const CONFIG_PATH = '/project/cfnsync.yaml';
const NETWORK_ABS = '/project/network.yaml';
const APP_ABS = '/project/app.yaml';
const NET_KEY = `network.yaml@${REGION}`;

const TWO_STACK_CONFIG = `version: 1
defaultRegion: ap-northeast-1
stacks:
  network.yaml:
    stackName: prod-network
  app.yaml:
    stackName: prod-app
`;

const MULTI_REGION_CONFIG = `version: 1
defaultRegion: ap-northeast-1
stacks:
  network.yaml:
    stackName: prod-network
    regions: [ap-northeast-1, us-east-1]
`;

// ---------------------------------------------------------------------------
// インメモリフェイク(呼び出し時系列記録付き)
// ---------------------------------------------------------------------------

/** DescribeStacks 要約のヘルパー。NoEcho の DbPassword は AWS 同様 `****` でマスクされている。 */
function makeSummary(overrides: Partial<StackSummary> = {}): StackSummary {
  return {
    stackName: 'prod-network',
    stackId: `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/prod-network/x`,
    status: 'UPDATE_COMPLETE',
    parameters: { VpcCidr: '10.0.0.0/16', DbPassword: '****' },
    tags: { Project: 'legacy-app', [MANAGEMENT_TAG_KEY]: 'aabbccddeeff' },
    capabilities: ['CAPABILITY_NAMED_IAM'],
    outputs: {},
    terminationProtection: false,
    ...overrides,
  };
}

function emptyDetail(): ChangeSetDetail {
  return { status: 'CREATE_COMPLETE', changes: [], parameters: {}, tags: {}, capabilities: [] };
}

/** 全メソッド呼び出しを記録する CloudFormationGateway フェイク(読み取り以外も記録して FR-10-7 を検証)。 */
class FakeCfn implements CloudFormationGateway {
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly stacks = new Map<string, StackSummary>();
  readonly templates = new Map<string, string>();

  constructor(readonly region: string) {}

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  async describeStack(stackName: string): Promise<StackSummary | undefined> {
    this.record('describeStack', stackName);
    return this.stacks.get(stackName);
  }
  async listChangeSets(stackName: string) {
    this.record('listChangeSets', stackName);
    return [];
  }
  async createChangeSet(input: CreateChangeSetInput): Promise<{ id: string }> {
    this.record('createChangeSet', input);
    return { id: 'cs' };
  }
  async describeChangeSet(stackName: string, changeSetName: string): Promise<ChangeSetDetail> {
    this.record('describeChangeSet', stackName, changeSetName);
    return emptyDetail();
  }
  async waitForChangeSet(stackName: string, changeSetName: string): Promise<ChangeSetDetail> {
    this.record('waitForChangeSet', stackName, changeSetName);
    return emptyDetail();
  }
  async deleteChangeSet(stackName: string, changeSetName: string): Promise<void> {
    this.record('deleteChangeSet', stackName, changeSetName);
  }
  async executeChangeSet(stackName: string, changeSetName: string): Promise<void> {
    this.record('executeChangeSet', stackName, changeSetName);
  }
  async deleteStack(stackName: string): Promise<void> {
    this.record('deleteStack', stackName);
  }
  async describeStackEvents(stackName: string) {
    this.record('describeStackEvents', stackName);
    return [];
  }
  async getTemplate(stackName: string, stage: TemplateStage): Promise<string> {
    this.record('getTemplate', stackName, stage);
    return this.templates.get(stackName) ?? '';
  }
  async waitForStack(stackName: string): Promise<StackSummary> {
    this.record('waitForStack', stackName);
    return this.stacks.get(stackName) ?? makeSummary({ stackName });
  }
}

/** STS フェイク。timeline に記録する。 */
class FakeSts implements StsGateway {
  constructor(
    private readonly accountId: string,
    private readonly timeline: string[],
  ) {}

  async getCallerIdentity(): Promise<{ accountId: string; arn: string }> {
    this.timeline.push('sts.getCallerIdentity');
    return { accountId: this.accountId, arn: `arn:aws:iam::${this.accountId}:role/import` };
  }
}

/**
 * StateBackend フェイク。generation 比較の簡易 CAS。ロック関連・load/save を
 * すべて timeline に記録し、`verifyLockPlan` で fencing の障害注入を行う。
 */
class FakeBackend implements StateBackend {
  stored: { state: CfnSyncState; version: StateVersion } | undefined;
  readonly saveCalls: { state: CfnSyncState; expected: StateVersion | undefined }[] = [];
  /** verifyLock の応答列(先頭から消費。空になったら常に true)。 */
  verifyLockPlan: boolean[] = [];
  failAcquire = false;
  releaseCalls = 0;

  constructor(
    private readonly timeline: string[],
    initial?: CfnSyncState,
  ) {
    if (initial) {
      this.stored = { state: initial, version: { generation: initial.generation } };
    }
  }

  async load(): Promise<{ state: CfnSyncState; version: StateVersion } | undefined> {
    this.timeline.push('backend.load');
    return this.stored ? { state: this.stored.state, version: this.stored.version } : undefined;
  }

  async save(state: CfnSyncState, expected: StateVersion | undefined): Promise<StateVersion> {
    this.timeline.push('backend.save');
    this.saveCalls.push({ state, expected });
    if (expected?.generation !== this.stored?.version.generation) {
      throw new StateConflictError('世代不一致(fake CAS)');
    }
    const version: StateVersion = { generation: state.generation };
    this.stored = { state, version };
    return version;
  }

  async acquireLock(info: LockInfo): Promise<LockHandle> {
    this.timeline.push('backend.acquireLock');
    if (this.failAcquire) {
      throw new LockError('別の実行がロックを保持しています(fake)');
    }
    return { runId: info.runId };
  }

  async verifyLock(_handle: LockHandle): Promise<boolean> {
    this.timeline.push('backend.verifyLock');
    return this.verifyLockPlan.length > 0 ? (this.verifyLockPlan.shift() as boolean) : true;
  }

  async releaseLock(_handle: LockHandle): Promise<{ released: boolean; reason?: string }> {
    this.timeline.push('backend.releaseLock');
    this.releaseCalls++;
    return { released: true };
  }

  async readLock(): Promise<LockInfo | undefined> {
    return undefined;
  }

  async forceUnlock(): Promise<{ released: boolean; reason?: string }> {
    return { released: false };
  }

  stateId(): string {
    return 'aabbccddeeff';
  }
}

/** インメモリのファイル IO。書き込みを timeline と writes に記録する。 */
class FakeFs implements ImportFileSystem {
  readonly files = new Map<string, string>();
  readonly writes: { path: string; content: string }[] = [];

  constructor(private readonly timeline: string[]) {}

  readFile(path: string): string {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }

  writeFile(path: string, content: string): void {
    this.timeline.push(`fs.write:${path}`);
    this.writes.push({ path, content });
    this.files.set(path, content);
  }

  exists(path: string): boolean {
    return this.files.has(path);
  }
}

// ---------------------------------------------------------------------------
// シナリオ構築ヘルパー
// ---------------------------------------------------------------------------

function parseConfig(text: string): CfnSyncConfig {
  return validateConfig(parseYaml(text), { templateExists: () => true });
}

/** アカウント記録済みのステート(FR-10-8 の照合を素通りする前提状態)。 */
function recordedState(): CfnSyncState {
  return withAccountId(createInitialState(), ACCOUNT);
}

interface SetupOptions {
  configText?: string;
  /** 'none' = ステート未存在(初回)。省略時はアカウント記録済みステート。 */
  initialState?: CfnSyncState | 'none';
  /** 絶対パス → 内容。省略時は network.yaml のみ配置。 */
  files?: Record<string, string>;
  regions?: string[];
  stsAccount?: string;
}

function setup(opts: SetupOptions = {}) {
  const timeline: string[] = [];
  const fs = new FakeFs(timeline);
  const configText = opts.configText ?? CONFIG_TEXT;
  fs.files.set(CONFIG_PATH, configText);
  for (const [path, content] of Object.entries(opts.files ?? { [NETWORK_ABS]: NETWORK_TEMPLATE })) {
    fs.files.set(path, content);
  }

  const backend = new FakeBackend(
    timeline,
    opts.initialState === 'none' ? undefined : (opts.initialState ?? recordedState()),
  );
  const sts = new FakeSts(opts.stsAccount ?? ACCOUNT, timeline);

  const cfns = new Map<string, FakeCfn>();
  for (const region of opts.regions ?? [REGION]) {
    cfns.set(region, new FakeCfn(region));
  }
  const cfnFactory = (region: string): CloudFormationGateway => {
    let cfn = cfns.get(region);
    if (!cfn) {
      cfn = new FakeCfn(region);
      cfns.set(region, cfn);
    }
    return cfn;
  };

  const deps: ImportDeps = { cfnFactory, sts, backend, fs };
  const config = parseConfig(configText);
  return { timeline, fs, backend, sts, cfns, deps, config };
}

function run(s: ReturnType<typeof setup>, options: ImportOptions = {}) {
  return runImport({ config: s.config, configPath: CONFIG_PATH, deps: s.deps, options });
}

/** デプロイ済みの prod-network を単一リージョンに配置する。 */
function deployNetwork(s: ReturnType<typeof setup>, template: string, overrides: Partial<StackSummary> = {}): void {
  const cfn = s.cfns.get(REGION)!;
  cfn.stacks.set('prod-network', makeSummary(overrides));
  cfn.templates.set('prod-network', template);
}

/** 書き込み済み cfnsync.yaml から検証済み config を再構築する(次回 plan の再現)。 */
function configFromWritten(fs: FakeFs): CfnSyncConfig {
  return parseConfig(fs.files.get(CONFIG_PATH)!);
}

/**
 * FR-1-9(import): timeline 上のすべてのローカル書き込み(fs.write / backend.save)の
 * 直前イベントが backend.verifyLock であることを検証する。
 */
function expectFencedWrites(timeline: string[]): void {
  timeline.forEach((event, index) => {
    if (event.startsWith('fs.write:') || event === 'backend.save') {
      expect(timeline[index - 1], `書き込み ${event}(index ${index})の直前は verifyLock であること`).toBe(
        'backend.verifyLock',
      );
    }
  });
}

// ===========================================================================
// FR-10-1: スタック名・パラメータ・タグ・Capabilities を設定ファイルに反映
// ===========================================================================

describe('FR-10-1: DescribeStacks の結果を cfnsync.yaml へ書き戻す(コメント・キー順保持)', () => {
  it('FR-10-1: stacks 配下に反映され、既存のコメント・キー順が保持される', async () => {
    const s = setup();
    deployNetwork(s, NETWORK_TEMPLATE);

    const result = await run(s);

    expect(result.exitCode).toBe(0);
    expect(result.report.configWritten).toBe(true);

    const text = s.fs.files.get(CONFIG_PATH)!;

    // 既存コメントの保持(YAML AST 編集。テキスト再生成では消えるため AST 編集の証跡)。
    expect(text).toContain('# 誤接続防止(FR-7): 許可アカウントとリージョン');
    expect(text).toContain('# ネットワーク層のスタック(運用者コメント: このブロックは手編集で残すこと)');

    // 既存キー順の保持(version → allowedAccounts → ... → stacks)。
    const idx = (needle: string) => text.indexOf(needle);
    expect(idx('version:')).toBeGreaterThanOrEqual(0);
    expect(idx('version:')).toBeLessThan(idx('allowedAccounts:'));
    expect(idx('allowedAccounts:')).toBeLessThan(idx('allowedRegions:'));
    expect(idx('allowedRegions:')).toBeLessThan(idx('defaultRegion:'));
    expect(idx('defaultRegion:')).toBeLessThan(idx('stackNamePrefix:'));
    expect(idx('stackNamePrefix:')).toBeLessThan(idx('state:'));
    expect(idx('state:')).toBeLessThan(idx('stacks:'));
    // stacks.network.yaml 内も既存キー(stackName → regions)の順が保たれる。
    expect(idx('stackName:')).toBeLessThan(idx('regions:'));

    // 反映内容: スタック名・パラメータ・タグ・Capabilities(FR-10-1)。
    const written = parseYaml(text) as {
      stacks: Record<string, Record<string, unknown>>;
    };
    const entry = written.stacks['network.yaml'];
    expect(entry['stackName']).toBe('prod-network');
    expect(entry['parameters']).toEqual({ VpcCidr: '10.0.0.0/16', DbPassword: '__REQUIRED__' });
    expect(entry['tags']).toEqual({ Project: 'legacy-app' }); // 管理タグは書き戻さない(§8.4)
    expect(entry['capabilities']).toEqual(['CAPABILITY_NAMED_IAM']);
    expect(text).not.toContain(MANAGEMENT_TAG_KEY);
  });
});

// ===========================================================================
// FR-10-2: NoEcho はプレースホルダを記録。マスク値を実値として書かない
// ===========================================================================

describe('FR-10-2: NoEcho パラメータのプレースホルダ記録', () => {
  it('FR-10-2: NoEcho パラメータは __REQUIRED__ が記録され、**** が書き込まれない', async () => {
    const s = setup();
    deployNetwork(s, NETWORK_TEMPLATE);

    const result = await run(s);

    expect(result.exitCode).toBe(0);
    const text = s.fs.files.get(CONFIG_PATH)!;
    expect(text).toContain('DbPassword: __REQUIRED__');
    expect(text).not.toContain('****');

    // レポートにも対象パラメータ名が挙がる。
    expect(result.report.stacks[0].noEchoPlaceholders).toEqual(['DbPassword']);
  });
});

// ===========================================================================
// FR-10-3: デプロイ済みテンプレートとローカルのパース後同値比較
// ===========================================================================

describe('FR-10-3: テンプレートのパース後同値比較', () => {
  it('FR-10-3: 書式・キー順が異なっても(YAML vs JSON)パース後同値なら一致として取り込み、次回 detect は unchanged', async () => {
    const s = setup();
    deployNetwork(s, DEPLOYED_JSON); // デプロイ済みは JSON 形式(テキストとしては別物)

    const result = await run(s);

    expect(result.exitCode).toBe(0);
    expect(result.report.stacks[0].status).toBe('imported');
    expect(result.report.stacks[0].templateComparison).toBe('match');
    expect(result.report.stateSaved).toBe(true);

    // 一致 → 次回 plan(detect)で unchanged になる(検証済み対応の記録)。
    const detection = detectChanges({
      targets: resolveTargets(configFromWritten(s.fs)),
      templates: new Map([['network.yaml', NETWORK_TEMPLATE]]),
      state: s.backend.stored!.state,
    });
    const entry = detection.entries.find((e) => e.stackKey === NET_KEY);
    expect(entry?.changeType).toBe('unchanged');
  });
});

// ===========================================================================
// FR-10-4: 差分はデフォルトエラー。--reconcile remote / --reconcile local
// ===========================================================================

describe('FR-10-4: テンプレート差分の扱い', () => {
  it('FR-10-4: 差分あり + オプションなし → エラー(設定・ステート・テンプレートへの書き込みゼロ)', async () => {
    const s = setup();
    deployNetwork(s, DEPLOYED_DIFFERENT);

    const result = await run(s);

    expect(result.exitCode).toBe(1);
    expect(result.report.aborted).toBe('template-blocking');
    expect(result.report.stacks[0].status).toBe('template-mismatch');
    expect(result.report.configWritten).toBe(false);
    expect(result.report.stateSaved).toBe(false);
    expect(s.fs.writes).toHaveLength(0);
    expect(s.backend.saveCalls).toHaveLength(0);
    // ロックは異常時も解放される。
    expect(s.backend.releaseCalls).toBe(1);
  });

  it('FR-10-4: --reconcile remote → デプロイ済みテンプレートでローカルを上書きする', async () => {
    const s = setup();
    deployNetwork(s, DEPLOYED_DIFFERENT);

    const result = await run(s, { reconcile: 'remote' });

    expect(result.exitCode).toBe(0);
    expect(result.report.stacks[0].reconcile).toBe('remote');
    expect(s.fs.files.get(NETWORK_ABS)).toBe(DEPLOYED_DIFFERENT);
    expect(result.report.stateSaved).toBe(true);
  });

  it('FR-10-4: --reconcile local → ローカル維持 + ステートにはデプロイ済み側ハッシュ → 次回 plan で modified', async () => {
    const s = setup();
    deployNetwork(s, DEPLOYED_DIFFERENT);

    const result = await run(s, { reconcile: 'local' });

    expect(result.exitCode).toBe(0);
    expect(result.report.stacks[0].reconcile).toBe('local');
    // ローカルファイルは維持される。
    expect(s.fs.files.get(NETWORK_ABS)).toBe(NETWORK_TEMPLATE);
    // ステートにはデプロイ済み側のハッシュが記録される。
    const entry = s.backend.stored!.state.stacks[NET_KEY];
    expect(entry.templateHash).toBe(computeTemplateHash(DEPLOYED_DIFFERENT));

    // 差分が次回 plan(detect)で modified として顕在化することまで検証する。
    const detection = detectChanges({
      targets: resolveTargets(configFromWritten(s.fs)),
      templates: new Map([['network.yaml', NETWORK_TEMPLATE]]), // ローカルは維持されたまま
      state: s.backend.stored!.state,
    });
    const detected = detection.entries.find((e) => e.stackKey === NET_KEY);
    expect(detected?.changeType).toBe('modified');
  });
});

// ===========================================================================
// FR-10-5: ローカルにないスタックはテンプレートを書き出せる
// ===========================================================================

describe('FR-10-5: デプロイ済みテンプレートの書き出し', () => {
  it('FR-10-5: --write-template でデプロイ済みテンプレートがローカルファイル化される', async () => {
    const s = setup({ files: {} }); // ローカルにテンプレートなし
    deployNetwork(s, NETWORK_TEMPLATE);

    const result = await run(s, { writeTemplate: true });

    expect(result.exitCode).toBe(0);
    expect(result.report.stacks[0].status).toBe('imported');
    expect(result.report.stacks[0].templateComparison).toBe('local-missing');
    expect(result.report.stacks[0].wroteTemplate).toBe(true);
    expect(s.fs.files.get(NETWORK_ABS)).toBe(NETWORK_TEMPLATE);
    expect(result.report.stateSaved).toBe(true);
  });

  it('FR-10-5: オプションなし + ローカル欠如 → エラー(書き込みゼロ)', async () => {
    const s = setup({ files: {} });
    deployNetwork(s, NETWORK_TEMPLATE);

    const result = await run(s);

    expect(result.exitCode).toBe(1);
    expect(result.report.aborted).toBe('template-blocking');
    expect(result.report.stacks[0].status).toBe('template-missing');
    expect(s.fs.writes).toHaveLength(0);
    expect(s.backend.saveCalls).toHaveLength(0);
  });
});

// ===========================================================================
// FR-10-6: ステートはデプロイ済み内容のハッシュを記録する
// ===========================================================================

describe('FR-10-6: templateHash / inputsHash はデプロイ済み内容に基づく', () => {
  it('FR-10-6: reconcile local でも未デプロイのローカル内容が「デプロイ済み」として記録されない', async () => {
    const s = setup();
    deployNetwork(s, DEPLOYED_DIFFERENT);

    await run(s, { reconcile: 'local' });

    const entry = s.backend.stored!.state.stacks[NET_KEY];
    // デプロイ済み内容(GetTemplate 本文)のハッシュであること。
    expect(entry.templateHash).toBe(computeTemplateHash(DEPLOYED_DIFFERENT));
    // ローカル(未デプロイ)内容のハッシュではないこと。
    expect(entry.templateHash).not.toBe(computeTemplateHash(NETWORK_TEMPLATE));
    // inputsHash も DescribeStacks の実パラメータ(NoEcho は __REQUIRED__)・タグ・
    // Capabilities +デプロイ済みテンプレート本文に基づく。
    expect(entry.inputsHash).toBe(
      computeInputsHash({
        templateContent: DEPLOYED_DIFFERENT,
        stackName: 'prod-network',
        parameters: { VpcCidr: '10.0.0.0/16', DbPassword: '__REQUIRED__' },
        tags: { Project: 'legacy-app' },
        capabilities: ['CAPABILITY_NAMED_IAM'],
        dependsOn: [],
      }),
    );
    expect(entry.lastAction).toBe('IMPORT');
  });
});

// ===========================================================================
// FR-10-7: AWS へは読み取り専用
// ===========================================================================

describe('FR-10-7: AWS への読み取り専用性', () => {
  it('FR-10-7: 変更系 API(CreateChangeSet / ExecuteChangeSet / DeleteStack / DeleteChangeSet 等)が一切呼ばれない', async () => {
    const s = setup();
    deployNetwork(s, DEPLOYED_DIFFERENT);

    // ローカル上書きまで行う最も書き込みの多い経路でも AWS へは読み取りのみ。
    const result = await run(s, { reconcile: 'remote' });
    expect(result.exitCode).toBe(0);

    for (const cfn of s.cfns.values()) {
      const methods = new Set(cfn.methods());
      expect(methods.has('createChangeSet')).toBe(false);
      expect(methods.has('executeChangeSet')).toBe(false);
      expect(methods.has('deleteChangeSet')).toBe(false);
      expect(methods.has('deleteStack')).toBe(false);
      // 呼ばれるのは読み取り(DescribeStacks / GetTemplate)のみ。
      for (const method of methods) {
        expect(['describeStack', 'getTemplate']).toContain(method);
      }
    }
  });
});

// ===========================================================================
// FR-10-8: アカウント照合はロック取得後に再読込したステートに対して行う
// ===========================================================================

describe('FR-10-8: ロック取得後のステート再読込に対するアカウント照合', () => {
  it('FR-10-8: 照合はロック後の再読込ステートに対して行われる(acquireLock → load の順)', async () => {
    const s = setup();
    deployNetwork(s, NETWORK_TEMPLATE);

    await run(s);

    const acquireIndex = s.timeline.indexOf('backend.acquireLock');
    const loadIndex = s.timeline.indexOf('backend.load');
    expect(acquireIndex).toBeGreaterThanOrEqual(0);
    expect(loadIndex).toBeGreaterThan(acquireIndex); // ロック取得前に読んだステートを判断に使わない
    expect(s.timeline.filter((event) => event === 'backend.load')).toHaveLength(1);
  });

  it('FR-10-8: ステートのアカウント不一致 → 設定・ステート・テンプレートのいずれにも書き込みゼロで終了', async () => {
    const s = setup({ initialState: withAccountId(createInitialState(), OTHER_ACCOUNT) });
    deployNetwork(s, NETWORK_TEMPLATE);

    const result = await run(s);

    expect(result.exitCode).toBe(1);
    expect(result.report.aborted).toBe('account-mismatch');
    expect(s.fs.writes).toHaveLength(0); // 設定・テンプレートへの書き込みゼロ
    expect(s.backend.saveCalls).toHaveLength(0); // ステートへの書き込みゼロ
    expect(s.backend.stored!.state.accountId).toBe(OTHER_ACCOUNT); // ステート無傷
    expect(s.backend.releaseCalls).toBe(1); // 異常時もロック解放
  });

  it('FR-10-8: 初回(未記録)→ アカウント ID が同一ロック区間の CAS 保存で記録される', async () => {
    const s = setup({ initialState: 'none' });
    deployNetwork(s, NETWORK_TEMPLATE);

    const result = await run(s);

    expect(result.exitCode).toBe(0);
    // 1 回目の保存 = アカウント ID の初回記録(expected は未存在 = undefined の CAS)。
    expect(s.backend.saveCalls.length).toBeGreaterThanOrEqual(1);
    expect(s.backend.saveCalls[0].state.accountId).toBe(ACCOUNT);
    expect(s.backend.saveCalls[0].expected).toBeUndefined();
    // 同一ロック区間内(acquireLock 後・releaseLock 前)であること。
    const firstSave = s.timeline.indexOf('backend.save');
    expect(firstSave).toBeGreaterThan(s.timeline.indexOf('backend.acquireLock'));
    expect(firstSave).toBeLessThan(s.timeline.indexOf('backend.releaseLock'));
    // 最終的なステートにもアカウント ID とインポート結果が記録されている。
    expect(s.backend.stored!.state.accountId).toBe(ACCOUNT);
    expect(s.backend.stored!.state.stacks[NET_KEY]).toBeDefined();
  });
});

// ===========================================================================
// FR-10-9: インポートはロックを取得する
// ===========================================================================

describe('FR-10-9: ステートロックの取得', () => {
  it('FR-10-9: ロック取得失敗 → 一切の書き込みなしでエラー', async () => {
    const s = setup();
    deployNetwork(s, NETWORK_TEMPLATE);
    s.backend.failAcquire = true;

    const result = await run(s);

    expect(result.exitCode).toBe(1);
    expect(result.report.aborted).toBe('lock-unavailable');
    expect(s.fs.writes).toHaveLength(0);
    expect(s.backend.saveCalls).toHaveLength(0);
    // 取得できていないので解放も行われない(解放対象がない)。
    expect(s.backend.releaseCalls).toBe(0);
    // ステート読込にも進まない(ロック配下でのみ読む)。
    expect(s.timeline).not.toContain('backend.load');
  });
});

// ===========================================================================
// FR-1-9(import): 各ローカル書き込みの直前ごとに fencing 検証
// ===========================================================================

describe('FR-1-9(import): ローカル書き込み直前の所有権検証(fencing)', () => {
  it('FR-1-9(import): cfnsync.yaml・テンプレート・ステート保存の各書き込み直前ごとに verifyLock が配置される(時系列検証)', async () => {
    const s = setup();
    deployNetwork(s, DEPLOYED_DIFFERENT);

    // reconcile remote は「設定 + テンプレート + ステート」の 3 種すべてを書き込む経路。
    const result = await run(s, { reconcile: 'remote' });

    expect(result.exitCode).toBe(0);
    // 書き込みは 3 件(config / template / state save)発生している。
    expect(s.timeline.filter((e) => e.startsWith('fs.write:') || e === 'backend.save')).toHaveLength(3);
    // それぞれの直前イベントが verifyLock であること。
    expectFencedWrites(s.timeline);
    // 終了時にロックが解放される(タイムライン末尾)。
    expect(s.timeline[s.timeline.length - 1]).toBe('backend.releaseLock');
  });

  it('FR-1-9(import): 設定ファイル書き込み後に所有権喪失 → テンプレート・ステートの書き込みが行われない(障害注入)', async () => {
    const s = setup();
    deployNetwork(s, DEPLOYED_DIFFERENT);

    // 1 回目の verifyLock(config 書き込み前)は成功、2 回目(テンプレート書き込み前)で喪失。
    s.backend.verifyLockPlan = [true, false];

    const result = await run(s, { reconcile: 'remote' });

    expect(result.exitCode).toBe(1);
    expect(result.report.aborted).toBe('ownership-lost');
    expect(result.report.configWritten).toBe(true);
    expect(result.report.stateSaved).toBe(false);

    // 書き込まれたのは cfnsync.yaml のみ。テンプレート・ステートは書き込まれない。
    expect(s.fs.writes.map((w) => w.path)).toEqual([CONFIG_PATH]);
    expect(s.fs.files.get(NETWORK_ABS)).toBe(NETWORK_TEMPLATE); // ローカルテンプレート無傷
    expect(s.backend.saveCalls).toHaveLength(0); // ステート保存なし
    // 中断後もロック解放は試行される(所有権喪失時は条件不成立で無害)。
    expect(s.backend.releaseCalls).toBe(1);
  });
});

// ===========================================================================
// FR-10-10: スタックが存在しないテンプレートは added 扱い
// ===========================================================================

describe('FR-10-10: 対応するスタックが存在しないテンプレート', () => {
  it('FR-10-10: スタック不存在 → ステートに記録されず、次回 detect で added になる', async () => {
    const s = setup({
      configText: TWO_STACK_CONFIG,
      files: { [NETWORK_ABS]: NETWORK_TEMPLATE, [APP_ABS]: APP_TEMPLATE },
    });
    deployNetwork(s, NETWORK_TEMPLATE); // prod-app はデプロイされていない

    const result = await run(s);

    expect(result.exitCode).toBe(0);
    const appReport = result.report.stacks.find((r) => r.templatePath === 'app.yaml');
    expect(appReport?.status).toBe('not-found');
    expect(appReport?.recorded).toBe(false);

    // ステートには network のみ記録され、app は記録されない。
    const saved = s.backend.stored!.state;
    expect(saved.stacks[NET_KEY]).toBeDefined();
    expect(saved.stacks[`app.yaml@${REGION}`]).toBeUndefined();

    // 次回 detect で app が added になる。
    const detection = detectChanges({
      targets: resolveTargets(configFromWritten(s.fs)),
      templates: new Map([
        ['network.yaml', NETWORK_TEMPLATE],
        ['app.yaml', APP_TEMPLATE],
      ]),
      state: saved,
    });
    expect(detection.entries.find((e) => e.stackKey === `app.yaml@${REGION}`)?.changeType).toBe('added');
    expect(detection.entries.find((e) => e.stackKey === NET_KEY)?.changeType).toBe('unchanged');
  });
});

// ===========================================================================
// FR-10-11: 依存辺の記録(FR-8-5)
// ===========================================================================

describe('FR-10-11: exports / imports のステート記録', () => {
  it('FR-10-11: インポート成功時に exports / imports がステートに記録される', async () => {
    const s = setup({
      configText: TWO_STACK_CONFIG,
      files: { [NETWORK_ABS]: NETWORK_TEMPLATE, [APP_ABS]: APP_TEMPLATE },
    });
    const cfn = s.cfns.get(REGION)!;
    cfn.stacks.set('prod-network', makeSummary());
    cfn.templates.set('prod-network', NETWORK_TEMPLATE);
    cfn.stacks.set(
      'prod-app',
      makeSummary({ stackName: 'prod-app', parameters: {}, tags: {}, capabilities: [] }),
    );
    cfn.templates.set('prod-app', APP_TEMPLATE);

    const result = await run(s);

    expect(result.exitCode).toBe(0);
    const saved = s.backend.stored!.state;
    // network.yaml の Export: !Sub '${AWS::StackName}-VpcId' がスタック名で解決される。
    expect(saved.stacks[NET_KEY].exports).toEqual(['prod-network-VpcId']);
    expect(saved.stacks[NET_KEY].imports).toEqual([]);
    // app.yaml の !ImportValue prod-network-VpcId が import として記録される。
    expect(saved.stacks[`app.yaml@${REGION}`].imports).toEqual(['prod-network-VpcId']);
    expect(saved.stacks[`app.yaml@${REGION}`].exports).toEqual([]);
  });
});

// ===========================================================================
// FR-13-9: リージョンごとにインポートできる
// ===========================================================================

describe('FR-13-9: マルチリージョンのインポート', () => {
  it('FR-13-9: 2 リージョンの既存スタックがそれぞれのスタックキーで取り込まれる', async () => {
    const s = setup({
      configText: MULTI_REGION_CONFIG,
      regions: [REGION, REGION2],
    });
    // 両リージョンにデプロイ済み(パラメータはリージョンごとに異なる)。
    const cfn1 = s.cfns.get(REGION)!;
    cfn1.stacks.set('prod-network', makeSummary());
    cfn1.templates.set('prod-network', NETWORK_TEMPLATE);
    const cfn2 = s.cfns.get(REGION2)!;
    cfn2.stacks.set(
      'prod-network',
      makeSummary({ parameters: { VpcCidr: '10.1.0.0/16', DbPassword: '****' } }),
    );
    cfn2.templates.set('prod-network', NETWORK_TEMPLATE);

    const result = await run(s);

    expect(result.exitCode).toBe(0);
    expect(result.report.stacks.map((r) => r.stackKey)).toEqual([
      `network.yaml@${REGION}`,
      `network.yaml@${REGION2}`,
    ]);

    // ステートには(テンプレート × リージョン)単位の独立したエントリが記録される。
    const saved = s.backend.stored!.state;
    expect(saved.stacks[`network.yaml@${REGION}`]).toBeDefined();
    expect(saved.stacks[`network.yaml@${REGION2}`]).toBeDefined();
    expect(saved.stacks[`network.yaml@${REGION}`].region).toBe(REGION);
    expect(saved.stacks[`network.yaml@${REGION2}`].region).toBe(REGION2);

    // 各リージョンのゲートウェイに対して読み取りが行われた(リージョンごとの実行)。
    expect(cfn1.methods()).toContain('describeStack');
    expect(cfn2.methods()).toContain('describeStack');

    // 設定にはリージョン別パラメータが regionOverrides として書き分けられる(FR-13-3)。
    const written = parseYaml(s.fs.files.get(CONFIG_PATH)!) as {
      stacks: Record<string, Record<string, never>>;
    };
    const entry = written.stacks['network.yaml'] as {
      regionOverrides?: Record<string, { parameters?: Record<string, string> }>;
    };
    expect(entry.regionOverrides?.[REGION]?.parameters?.['VpcCidr']).toBe('10.0.0.0/16');
    expect(entry.regionOverrides?.[REGION2]?.parameters?.['VpcCidr']).toBe('10.1.0.0/16');
    expect(entry.regionOverrides?.[REGION]?.parameters?.['DbPassword']).toBe('__REQUIRED__');
    expect(entry.regionOverrides?.[REGION2]?.parameters?.['DbPassword']).toBe('__REQUIRED__');
  });
});
