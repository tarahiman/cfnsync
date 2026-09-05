import { describe, expect, it } from 'vitest';
import {
  type ResolvedStackTarget,
  resolveTargets,
  validateConfig,
} from '../../src/core/config.js';
import {
  computeInputsHash,
  computeTemplateHash,
  detectChanges,
} from '../../src/core/detect.js';
import {
  type CfnSyncState,
  createInitialState,
  type PendingDeletionEntry,
  pendingDeletionStackKey,
  type StackEntry,
  upsertPendingDeletion,
  upsertStackEntry,
} from '../../src/core/state.js';
import { makeStackKey } from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// テスト用ビルダー
// ---------------------------------------------------------------------------

function makeTarget(
  overrides: Partial<ResolvedStackTarget> = {},
): ResolvedStackTarget {
  const templatePath = overrides.templatePath ?? 'network.yaml';
  const region = overrides.region ?? 'ap-northeast-1';
  const base: ResolvedStackTarget = {
    stackKey: makeStackKey(templatePath, region),
    templatePath,
    stackName: 'prod-network',
    region,
    parameters: { VpcCidr: '10.0.0.0/16' },
    tags: { Project: 'legacy-app' },
    capabilities: [],
    dependsOn: [],
  };
  return { ...base, ...overrides };
}

function makeStateEntry(overrides: Partial<StackEntry> = {}): StackEntry {
  return {
    stackName: 'prod-network',
    region: 'ap-northeast-1',
    templateHash: 'sha256:placeholder-template',
    inputsHash: 'sha256:placeholder-inputs',
    exports: [],
    imports: [],
    dependsOn: [],
    lastAction: 'UPDATE',
    lastSuccessAt: '2026-07-19T00:00:00Z',
    ...overrides,
  };
}

/** target と content から、実際に一致する templateHash/inputsHash を持つステートを組み立てる。 */
function stateEntryFor(
  target: ResolvedStackTarget,
  content: string,
  overrides: Partial<StackEntry> = {},
): StackEntry {
  return makeStateEntry({
    stackName: target.stackName,
    region: target.region,
    templateHash: computeTemplateHash(content),
    inputsHash: computeInputsHash({
      templateHash: computeTemplateHash(content),
      stackName: target.stackName,
      parameters: target.parameters,
      tags: target.tags,
      capabilities: target.capabilities,
      dependsOn: target.dependsOn,
    }),
    ...overrides,
  });
}

function stateWith(entries: Record<string, StackEntry>): CfnSyncState {
  let state = createInitialState();
  for (const [key, entry] of Object.entries(entries)) {
    state = upsertStackEntry(state, key, entry);
  }
  return state;
}

const BASE_CONTENT = 'Resources:\n  Vpc:\n    Type: AWS::EC2::VPC\n';

// ---------------------------------------------------------------------------
// §4.3: computeInputsHash の複合ハッシュ(単体: 6 構成要素それぞれへの感度)
// ---------------------------------------------------------------------------

describe('core/detect — §4.3: computeInputsHash の複合ハッシュ感度', () => {
  const baseInput = {
    templateHash: computeTemplateHash(BASE_CONTENT),
    stackName: 'prod-network',
    parameters: { VpcCidr: '10.0.0.0/16' },
    tags: { Project: 'legacy-app' },
    capabilities: ['CAPABILITY_IAM'],
    dependsOn: ['other.yaml'],
  };

  it('§4.3: ベースラインは決定的(同一入力で同一ハッシュ)', () => {
    expect(computeInputsHash(baseInput)).toBe(
      computeInputsHash({ ...baseInput }),
    );
  });

  it('§4.3(1/6 テンプレート): templateHash のみ変えるとハッシュが変わる', () => {
    const changed = {
      ...baseInput,
      templateHash: computeTemplateHash(
        'Resources:\n  Vpc2:\n    Type: AWS::EC2::VPC\n',
      ),
    };
    expect(computeInputsHash(changed)).not.toBe(computeInputsHash(baseInput));
  });

  it('§4.3(2/6 スタック名): stackName のみ変えるとハッシュが変わる', () => {
    const changed = { ...baseInput, stackName: 'prod-network-v2' };
    expect(computeInputsHash(changed)).not.toBe(computeInputsHash(baseInput));
  });

  it('§4.3(3/6 実効パラメータ): parameters のみ変えるとハッシュが変わる', () => {
    const changed = { ...baseInput, parameters: { VpcCidr: '10.1.0.0/16' } };
    expect(computeInputsHash(changed)).not.toBe(computeInputsHash(baseInput));
  });

  it('§4.3(4/6 タグ): tags のみ変えるとハッシュが変わる', () => {
    const changed = { ...baseInput, tags: { Project: 'other-app' } };
    expect(computeInputsHash(changed)).not.toBe(computeInputsHash(baseInput));
  });

  it('§4.3(5/6 Capabilities): capabilities のみ変えるとハッシュが変わる', () => {
    const changed = { ...baseInput, capabilities: ['CAPABILITY_NAMED_IAM'] };
    expect(computeInputsHash(changed)).not.toBe(computeInputsHash(baseInput));
  });

  it('§4.3(6/6 dependsOn): dependsOn のみ変えるとハッシュが変わる', () => {
    const changed = { ...baseInput, dependsOn: ['another.yaml'] };
    expect(computeInputsHash(changed)).not.toBe(computeInputsHash(baseInput));
  });

  it('§4.3: パラメータのキー順に依存しない(オブジェクトのキー順を入れ替えても同一ハッシュ)', () => {
    const a = { ...baseInput, parameters: { A: '1', B: '2' } };
    const b = { ...baseInput, parameters: { B: '2', A: '1' } };
    expect(computeInputsHash(a)).toBe(computeInputsHash(b));
  });

  it('§4.3: タグのキー順に依存しない(オブジェクトのキー順を入れ替えても同一ハッシュ)', () => {
    const a = { ...baseInput, tags: { X: 'x', Y: 'y' } };
    const b = { ...baseInput, tags: { Y: 'y', X: 'x' } };
    expect(computeInputsHash(a)).toBe(computeInputsHash(b));
  });
});

describe('core/detect — computeTemplateHash', () => {
  it('internal: sha256Hex 形式("sha256:<64桁hex>")を返す', () => {
    expect(computeTemplateHash(BASE_CONTENT)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('internal: 同一内容は同一ハッシュ、異なる内容は異なるハッシュになる', () => {
    expect(computeTemplateHash(BASE_CONTENT)).toBe(
      computeTemplateHash(BASE_CONTENT),
    );
    expect(computeTemplateHash(BASE_CONTENT)).not.toBe(
      computeTemplateHash(`${BASE_CONTENT}\n# comment`),
    );
  });
});

// ---------------------------------------------------------------------------
// FR-1-1: 4 分類の判定(統合)+ entries の順序
// ---------------------------------------------------------------------------

describe('core/detect — FR-1-1: added / modified / deleted / unchanged の 4 分類', () => {
  it('FR-1-1: 設定記載順を基本とし、純粋な deleted はステートのキー順で末尾に付加される', () => {
    const targetA = makeTarget({
      templatePath: 'a.yaml',
      stackKey: makeStackKey('a.yaml', 'ap-northeast-1'),
    });
    const targetB = makeTarget({
      templatePath: 'b.yaml',
      stackKey: makeStackKey('b.yaml', 'ap-northeast-1'),
    });
    const targetC = makeTarget({
      templatePath: 'c.yaml',
      stackKey: makeStackKey('c.yaml', 'ap-northeast-1'),
    });

    const bOldContent = 'Resources:\n  Old:\n    Type: AWS::S3::Bucket\n';
    const bNewContent = 'Resources:\n  New:\n    Type: AWS::S3::Bucket\n';
    const cContent = 'Resources:\n  Same:\n    Type: AWS::S3::Bucket\n';

    const state = stateWith({
      // b: 内容が変わる(modified)
      'b.yaml@ap-northeast-1': stateEntryFor(targetB, bOldContent),
      // c: 変化なし(unchanged)
      'c.yaml@ap-northeast-1': stateEntryFor(targetC, cContent),
      // d, z: targets に対応がなく削除対象(deleted)。z→d の逆順で登録し、
      // 出力ではキー順(d が先)になることを検証する。
      'z.yaml@ap-northeast-1': makeStateEntry({ stackName: 'z' }),
      'd.yaml@ap-northeast-1': makeStateEntry({ stackName: 'd' }),
    });

    const templates = new Map([
      ['a.yaml', 'Resources:\n  A:\n    Type: AWS::S3::Bucket\n'],
      ['b.yaml', bNewContent],
      ['c.yaml', cContent],
    ]);

    const result = detectChanges({
      targets: [targetA, targetB, targetC],
      templates,
      state,
    });

    expect(result.entries.map((e) => [e.stackKey, e.changeType])).toEqual([
      ['a.yaml@ap-northeast-1', 'added'],
      ['b.yaml@ap-northeast-1', 'modified'],
      ['c.yaml@ap-northeast-1', 'unchanged'],
      ['d.yaml@ap-northeast-1', 'deleted'],
      ['z.yaml@ap-northeast-1', 'deleted'],
    ]);

    // added: target を持ち stateEntry を持たない
    expect(result.entries[0].target).toBe(targetA);
    expect(result.entries[0].stateEntry).toBeUndefined();
    expect(result.entries[0].templateHash).toBeDefined();
    expect(result.entries[0].inputsHash).toBeDefined();

    // modified/unchanged: target と stateEntry の両方を持つ
    expect(result.entries[1].target).toBe(targetB);
    expect(result.entries[1].stateEntry).toBeDefined();
    expect(result.entries[2].target).toBe(targetC);
    expect(result.entries[2].stateEntry).toBeDefined();

    // deleted: target を持たず stateEntry のみを持つ
    expect(result.entries[3].target).toBeUndefined();
    expect(result.entries[3].stateEntry?.stackName).toBe('d');
    expect(result.entries[4].target).toBeUndefined();
    expect(result.entries[4].stateEntry?.stackName).toBe('z');
  });
});

// ---------------------------------------------------------------------------
// FR-1-2: タイムスタンプではなくコンテンツで比較する
// ---------------------------------------------------------------------------

describe('core/detect — FR-1-2: 比較はコンテンツハッシュに基づく(タイムスタンプは無関係)', () => {
  it('FR-1-2: 同一内容であれば(mtime という概念自体が入力に存在しないため)unchanged と判定される', () => {
    // detectChanges / computeTemplateHash / computeInputsHash の型シグネチャには
    // mtime やファイルの更新日時に相当するフィールドが一切存在しない
    // (テンプレート内容の文字列のみを受け取る)。そのため「ファイルの mtime だけ
    // 更新されたが内容は同じ」というシナリオは、同一の content 文字列を 2 回
    // 読み込んだ状況と区別がつかない。ここではそれを明示的に再現する。
    const target = makeTarget();
    const contentReadAtT1 = BASE_CONTENT;
    const contentReadAtT2 = BASE_CONTENT; // 内容は同一(mtime のみ異なる想定でも文字列としては同じ)

    const state = stateWith({
      [target.stackKey]: stateEntryFor(target, contentReadAtT1),
    });

    const result = detectChanges({
      targets: [target],
      templates: new Map([[target.templatePath, contentReadAtT2]]),
      state,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].changeType).toBe('unchanged');
  });
});

// ---------------------------------------------------------------------------
// §4.3(detectChanges 経由): 実運用経路での modified 検知
// ---------------------------------------------------------------------------

describe('core/detect — §4.3: detectChanges 経由での構成要素変更の検知', () => {
  function runWithChangedTarget(
    overrides: Partial<ResolvedStackTarget>,
    content = BASE_CONTENT,
  ) {
    const baseline = makeTarget();
    const changed = makeTarget(overrides);
    const state = stateWith({
      [baseline.stackKey]: stateEntryFor(baseline, content),
    });
    return detectChanges({
      targets: [changed],
      templates: new Map([[changed.templatePath, content]]),
      state,
    });
  }

  it('§4.3: テンプレート内容のみの変更(設定は同一)は modified になる', () => {
    const target = makeTarget();
    const oldContent = BASE_CONTENT;
    const newContent = `${BASE_CONTENT}\n# updated`;
    const state = stateWith({
      [target.stackKey]: stateEntryFor(target, oldContent),
    });
    const result = detectChanges({
      targets: [target],
      templates: new Map([[target.templatePath, newContent]]),
      state,
    });
    expect(result.entries[0].changeType).toBe('modified');
  });

  it('§4.3: 設定ファイルのみの変更(パラメータ変更、テンプレート内容は同一)も modified として検知される', () => {
    const result = runWithChangedTarget({
      parameters: { VpcCidr: '10.2.0.0/16' },
    });
    expect(result.entries[0].changeType).toBe('modified');
  });

  it('§4.3: タグのみの変更は modified として検知される', () => {
    const result = runWithChangedTarget({ tags: { Project: 'renamed-app' } });
    expect(result.entries[0].changeType).toBe('modified');
  });

  it('§4.3: Capabilities のみの変更は modified として検知される', () => {
    const result = runWithChangedTarget({
      capabilities: ['CAPABILITY_NAMED_IAM'],
    });
    expect(result.entries[0].changeType).toBe('modified');
  });

  it('§4.3: dependsOn のみの変更は modified として検知される', () => {
    const result = runWithChangedTarget({ dependsOn: ['other.yaml'] });
    expect(result.entries[0].changeType).toBe('modified');
  });
});

describe('core/detect — FR-11-9: defaultTags の変更検知(core/config の resolveTargets 経由)', () => {
  /** defaultTags のみが異なる config から実際に resolveTargets した target を作る。 */
  function targetWithDefaultTags(
    defaultTags: Record<string, string>,
  ): ResolvedStackTarget {
    const config = validateConfig({
      version: 1,
      defaultRegion: 'ap-northeast-1',
      defaultTags,
      stacks: { 'network.yaml': { stackName: 'prod-network' } },
    });
    return resolveTargets(config)[0];
  }

  it('FR-11-9: defaultTags のみの変更(スタック固有の tags・テンプレート内容は同一)は modified として検知される', () => {
    const before = targetWithDefaultTags({ ManagedBy: 'cfnsync' });
    const after = targetWithDefaultTags({ ManagedBy: 'cfnsync', Env: 'prod' });
    const state = stateWith({
      [before.stackKey]: stateEntryFor(before, BASE_CONTENT),
    });

    const result = detectChanges({
      targets: [after],
      templates: new Map([[after.templatePath, BASE_CONTENT]]),
      state,
    });

    expect(result.entries[0].changeType).toBe('modified');
  });

  it('FR-11-9: defaultTags が変わらなければ unchanged のままになる(対照実験)', () => {
    const before = targetWithDefaultTags({ ManagedBy: 'cfnsync' });
    const after = targetWithDefaultTags({ ManagedBy: 'cfnsync' });
    const state = stateWith({
      [before.stackKey]: stateEntryFor(before, BASE_CONTENT),
    });

    const result = detectChanges({
      targets: [after],
      templates: new Map([[after.templatePath, BASE_CONTENT]]),
      state,
    });

    expect(result.entries[0].changeType).toBe('unchanged');
  });
});

// ---------------------------------------------------------------------------
// FR-1-14: スタック名変更 = 削除 + 新規作成の対
// ---------------------------------------------------------------------------

describe('core/detect — FR-1-14: スタック名変更は「旧名の deleted」+「新名の added」の対になる', () => {
  it('FR-1-14: 同一スタックキーに対し deleted(旧名)と added(新名)の対が計画される', () => {
    const oldTarget = makeTarget({ stackName: 'prod-network' });
    const newTarget = makeTarget({ stackName: 'prod-network-renamed' });
    const state = stateWith({
      [oldTarget.stackKey]: stateEntryFor(oldTarget, BASE_CONTENT),
    });

    const result = detectChanges({
      targets: [newTarget],
      templates: new Map([[newTarget.templatePath, BASE_CONTENT]]),
      state,
    });

    expect(result.entries).toHaveLength(2);

    const [deletedEntry, addedEntry] = result.entries;
    expect(deletedEntry.stackKey).toBe(newTarget.stackKey);
    expect(deletedEntry.changeType).toBe('deleted');
    expect(deletedEntry.target).toBeUndefined();
    expect(deletedEntry.stateEntry?.stackName).toBe('prod-network');

    expect(addedEntry.stackKey).toBe(newTarget.stackKey);
    expect(addedEntry.changeType).toBe('added');
    expect(addedEntry.target).toBe(newTarget);
    // FR-1-18: 新エントリ保存と同一の CAS で削除待ちを記録できるよう、旧エントリを添える。
    expect(addedEntry.renamedFrom?.oldStackName).toBe('prod-network');
    expect(addedEntry.renamedFrom?.oldEntry).toBe(
      state.stacks[newTarget.stackKey],
    );
    expect(addedEntry.templateHash).toBeDefined();
    expect(addedEntry.inputsHash).toBeDefined();
  });

  it('FR-1-14: この対は末尾の deleted 集約とは別に、対象 target の処理順の位置に現れる', () => {
    const targetA = makeTarget({
      templatePath: 'a.yaml',
      stackKey: makeStackKey('a.yaml', 'ap-northeast-1'),
    });
    const renamedB = makeTarget({
      templatePath: 'b.yaml',
      stackKey: makeStackKey('b.yaml', 'ap-northeast-1'),
      stackName: 'renamed-b',
    });

    const state = stateWith({
      'b.yaml@ap-northeast-1': stateEntryFor(
        makeTarget({
          templatePath: 'b.yaml',
          stackKey: makeStackKey('b.yaml', 'ap-northeast-1'),
          stackName: 'old-b',
        }),
        BASE_CONTENT,
      ),
    });

    const result = detectChanges({
      targets: [targetA, renamedB],
      templates: new Map([
        ['a.yaml', BASE_CONTENT],
        ['b.yaml', BASE_CONTENT],
      ]),
      state,
    });

    expect(result.entries.map((e) => e.changeType)).toEqual([
      'added',
      'deleted',
      'added',
    ]);
    expect(result.entries[2].renamedFrom?.oldStackName).toBe('old-b');
  });
});

// ---------------------------------------------------------------------------
// FR-1-15: ステート未存在(初回)は全件 added
// ---------------------------------------------------------------------------

describe('core/detect — FR-1-15: 初回(空ステート)は全スタックキーが added', () => {
  it('FR-1-15: createInitialState() から始めるとすべての target が added になる', () => {
    const targetA = makeTarget({
      templatePath: 'a.yaml',
      stackKey: makeStackKey('a.yaml', 'ap-northeast-1'),
    });
    const targetB = makeTarget({
      templatePath: 'b.yaml',
      stackKey: makeStackKey('b.yaml', 'us-east-1'),
      region: 'us-east-1',
    });

    const result = detectChanges({
      targets: [targetA, targetB],
      templates: new Map([
        ['a.yaml', BASE_CONTENT],
        ['b.yaml', BASE_CONTENT],
      ]),
      state: createInitialState(),
    });

    expect(result.entries).toHaveLength(2);
    expect(result.entries.every((e) => e.changeType === 'added')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FR-13-2: (テンプレート × リージョン)単位での独立管理
// ---------------------------------------------------------------------------

describe('core/detect — FR-13-2: 2 リージョン設定のテンプレート変更は両リージョン独立に modified', () => {
  it('FR-13-2: 同一テンプレートの 2 リージョンがそれぞれ独立したスタックキーで modified になる', () => {
    const targetNe = makeTarget({
      region: 'ap-northeast-1',
      stackKey: makeStackKey('network.yaml', 'ap-northeast-1'),
    });
    const targetUs = makeTarget({
      region: 'us-east-1',
      stackKey: makeStackKey('network.yaml', 'us-east-1'),
    });

    const oldContent = BASE_CONTENT;
    const newContent = `${BASE_CONTENT}\n# changed`;

    const state = stateWith({
      [targetNe.stackKey]: stateEntryFor(targetNe, oldContent),
      [targetUs.stackKey]: stateEntryFor(targetUs, oldContent),
    });

    const result = detectChanges({
      targets: [targetNe, targetUs],
      templates: new Map([['network.yaml', newContent]]),
      state,
    });

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].stackKey).toBe('network.yaml@ap-northeast-1');
    expect(result.entries[0].changeType).toBe('modified');
    expect(result.entries[1].stackKey).toBe('network.yaml@us-east-1');
    expect(result.entries[1].changeType).toBe('modified');
  });
});

// ---------------------------------------------------------------------------
// FR-13-5: リージョン追加 → added、リージョン削除 → deleted
// ---------------------------------------------------------------------------

describe('core/detect — FR-13-5: リージョン追加/削除', () => {
  it('FR-13-5: リージョン追加 → 追加されたリージョンのキーのみ added、既存リージョンは unchanged', () => {
    const existing = makeTarget({
      region: 'ap-northeast-1',
      stackKey: makeStackKey('network.yaml', 'ap-northeast-1'),
    });
    const added = makeTarget({
      region: 'us-east-1',
      stackKey: makeStackKey('network.yaml', 'us-east-1'),
    });

    const state = stateWith({
      [existing.stackKey]: stateEntryFor(existing, BASE_CONTENT),
    });

    const result = detectChanges({
      targets: [existing, added],
      templates: new Map([['network.yaml', BASE_CONTENT]]),
      state,
    });

    expect(result.entries).toEqual([
      expect.objectContaining({
        stackKey: 'network.yaml@ap-northeast-1',
        changeType: 'unchanged',
      }),
      expect.objectContaining({
        stackKey: 'network.yaml@us-east-1',
        changeType: 'added',
      }),
    ]);
  });

  it('FR-13-5: リージョン削除 → 除外されたリージョンのキーのみ deleted、残るリージョンは unchanged', () => {
    const remaining = makeTarget({
      region: 'ap-northeast-1',
      stackKey: makeStackKey('network.yaml', 'ap-northeast-1'),
    });
    const removed = makeTarget({
      region: 'us-east-1',
      stackKey: makeStackKey('network.yaml', 'us-east-1'),
    });

    const state = stateWith({
      [remaining.stackKey]: stateEntryFor(remaining, BASE_CONTENT),
      [removed.stackKey]: stateEntryFor(removed, BASE_CONTENT),
    });

    // 設定からは us-east-1 が除外された(targets に remaining のみが渡る)。
    const result = detectChanges({
      targets: [remaining],
      templates: new Map([['network.yaml', BASE_CONTENT]]),
      state,
    });

    expect(result.entries).toEqual([
      expect.objectContaining({
        stackKey: 'network.yaml@ap-northeast-1',
        changeType: 'unchanged',
      }),
      expect.objectContaining({
        stackKey: 'network.yaml@us-east-1',
        changeType: 'deleted',
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// FR-1-21 / FR-1-22: 削除待ち(pending deletion)の検知
// ---------------------------------------------------------------------------

function makePendingEntry(
  overrides: Partial<PendingDeletionEntry> = {},
): PendingDeletionEntry {
  return {
    stackName: 'prod-network-old',
    stackId:
      'arn:aws:cloudformation:ap-northeast-1:123456789012:stack/prod-network-old/id',
    region: 'ap-northeast-1',
    exports: [],
    imports: [],
    dependsOn: [],
    dependencyAnalysisIncomplete: false,
    originStackKey: 'network.yaml@ap-northeast-1',
    reason: 'rename',
    recordedAt: '2026-07-19T00:00:00.000Z',
    ...overrides,
  };
}

describe('core/detect — FR-1-21: 削除待ちは deleted 分類として検知される', () => {
  it('FR-1-21: 削除待ち 1 件につき、予約スタックキーを持つ deleted 対象が 1 件生成される', () => {
    const target = makeTarget();
    const state = upsertPendingDeletion(
      stateWith({ [target.stackKey]: stateEntryFor(target, BASE_CONTENT) }),
      'prod-network-old@ap-northeast-1',
      makePendingEntry(),
    );

    const result = detectChanges({
      targets: [target],
      templates: new Map([[target.templatePath, BASE_CONTENT]]),
      state,
    });

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].changeType).toBe('unchanged');

    const pending = result.entries[1];
    expect(pending.changeType).toBe('deleted');
    expect(pending.stackKey).toBe(
      pendingDeletionStackKey('prod-network-old@ap-northeast-1'),
    );
    expect(pending.stackKey).toBe(
      'cfnsync:pending/prod-network-old@ap-northeast-1',
    );
    // 削除待ちは stacks のエントリを持たないため stateEntry ではなく pendingDeletion を持つ。
    expect(pending.stateEntry).toBeUndefined();
    expect(pending.pendingDeletion?.id).toBe('prod-network-old@ap-northeast-1');
    expect(pending.pendingDeletion?.entry).toEqual(makePendingEntry());
  });

  it('FR-1-21: 削除待ちのスタックキーは設定由来のスタックキーと衝突しない', () => {
    const target = makeTarget();
    const state = upsertPendingDeletion(
      stateWith({ [target.stackKey]: stateEntryFor(target, BASE_CONTENT) }),
      'prod-network-old@ap-northeast-1',
      makePendingEntry(),
    );

    const result = detectChanges({
      targets: [target],
      templates: new Map([[target.templatePath, BASE_CONTENT]]),
      state,
    });

    const keys = result.entries.map((entry) => entry.stackKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain(target.stackKey.replace('network.yaml', ''));
  });

  it('FR-1-21: 削除待ちは純粋な deleted の後に、キーの昇順で決定的に並ぶ', () => {
    const target = makeTarget();
    const removed = makeTarget({
      templatePath: 'removed.yaml',
      stackKey: makeStackKey('removed.yaml', 'ap-northeast-1'),
      stackName: 'removed',
    });
    let state = stateWith({
      [target.stackKey]: stateEntryFor(target, BASE_CONTENT),
      [removed.stackKey]: stateEntryFor(removed, BASE_CONTENT),
    });
    state = upsertPendingDeletion(
      state,
      'zzz-old@ap-northeast-1',
      makePendingEntry({ stackName: 'zzz-old', stackId: null }),
    );
    state = upsertPendingDeletion(
      state,
      'aaa-old@ap-northeast-1',
      makePendingEntry({ stackName: 'aaa-old', stackId: null }),
    );

    const result = detectChanges({
      targets: [target],
      templates: new Map([[target.templatePath, BASE_CONTENT]]),
      state,
    });

    expect(result.entries.map((entry) => entry.stackKey)).toEqual([
      target.stackKey,
      removed.stackKey,
      'cfnsync:pending/aaa-old@ap-northeast-1',
      'cfnsync:pending/zzz-old@ap-northeast-1',
    ]);
  });
});

describe('core/detect — FR-1-22: 連続したリネームは削除待ちを積み上げる', () => {
  it('FR-1-22: 2 件の削除待ちがどちらも deleted として現れ、互いに上書きしない', () => {
    const target = makeTarget({ stackName: 'prod-network-v3' });
    let state = stateWith({
      [target.stackKey]: stateEntryFor(target, BASE_CONTENT),
    });
    state = upsertPendingDeletion(
      state,
      'prod-network-v1@ap-northeast-1',
      makePendingEntry({ stackName: 'prod-network-v1', stackId: null }),
    );
    state = upsertPendingDeletion(
      state,
      'prod-network-v2@ap-northeast-1',
      makePendingEntry({ stackName: 'prod-network-v2', stackId: null }),
    );

    const result = detectChanges({
      targets: [target],
      templates: new Map([[target.templatePath, BASE_CONTENT]]),
      state,
    });

    const pendingNames = result.entries
      .filter((entry) => entry.pendingDeletion !== undefined)
      .map((entry) => entry.pendingDeletion?.entry.stackName);
    expect(pendingNames).toEqual(['prod-network-v1', 'prod-network-v2']);
  });
});
