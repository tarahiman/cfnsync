/**
 * T-12 usecase/guard — AccountGuard(design.md §8.1, requirements.md FR-7 / FR-1-13 / FR-13-8)。
 *
 * すべての変更系フロー(deploy / delete / import)が最初に通過する誤接続防止の
 * 安全装置(fail-closed)。design.md §8.1 の 6 ステップに 1:1 対応する:
 *
 *   1. `assertMutationAllowed` — allowedAccounts / allowedRegions が設定に存在しない
 *      → 変更セット作成前に即エラー。
 *   2. `resolveConnection` — STS `GetCallerIdentity` で接続先を解決(解決不能はそのまま伝播)。
 *      `assertAccountAllowed` — 解決したアカウントが allowedAccounts に含まれるか照合。
 *   3. `verifyStateAccount` — **ロック取得後**に再読込したステートの `accountId` と照合
 *      (design §8.1-3: ロック取得前に読んだステートを判断に使わない)。未記録(初回)は
 *      同一ロック区間の CAS 保存でアカウント ID を記録する(FR-1-13)。
 *   4. `assertRegionsAllowed` — 実行計画中の全対象リージョンが allowedRegions に含まれるか照合(FR-13-8)。
 *   5. `connectionHeader` — 解決した接続先を report(T-11)の `ConnectionInfo` として
 *      出力の先頭に渡せる形にする(FR-7-8。クレデンシャル等の秘匿情報は含めない)。
 *   6. status / graph は AWS を呼ばないため対象外。import は許可設定なしでも実行できるが
 *      ステートを書き込むため `verifyStateAccount` とロック取得を必ず行う(呼び出し側の責務)。
 *
 * `guardMutation` は 1 → 2 → 4 → 3 の順(design §8.1 の記載順)にまとめた入口だが、
 * ステップ 3(`verifyStateAccount`)は「ロック取得後に呼ぶ」ことが前提条件であるため、
 * **`guardMutation` は呼び出し側が既にステートロックを取得済みであることを前提とする**。
 * 各サブ関数(`assertMutationAllowed` / `resolveConnection` / `assertAccountAllowed` /
 * `assertRegionsAllowed` / `verifyStateAccount`)は独立して呼び出し可能であり、ロック取得の
 * 前後で呼び分ける必要がある呼び出し側(T-14〜T-16)はそちらを直接使ってよい。
 *
 * 拒否ケース(許可設定未設定・アカウント不一致・STS 解決失敗・ステートアカウント不一致・
 * リージョン不許可)では、後続のステップに一切進まない — 特に `backend.save` は
 * ステップ 3 に到達し、かつ照合結果が `unrecorded` の場合のみ呼ばれる。
 */

import type { CfnSyncConfig } from '../core/config.js';
import { GuardError } from '../core/errors.js';
import {
  type CfnSyncState,
  createInitialState,
  matchAccount,
  prepareSave,
  withAccountId,
} from '../core/state.js';
import type { StateBackend, StateVersion, StsGateway } from '../ports/index.js';
import type { ConnectionInfo } from '../report/index.js';

// ===========================================================================
// ステップ 1: allowedAccounts / allowedRegions の存在確認(FR-7-5)
// ===========================================================================

/**
 * `allowedAccounts` / `allowedRegions` が設定されていることを確認する
 * (design §8.1-1, FR-7-5)。未設定・空配列(実質未指定)のいずれも fail-closed で拒否する。
 * この関数は変更系操作のすべての入口(guardMutation を含む)で最初に呼ばれ、
 * STS 解決やステート読み書きより前に失敗することを保証する。
 */
export function assertMutationAllowed(config: CfnSyncConfig): void {
  if (
    config.allowedAccounts === undefined ||
    config.allowedAccounts.length === 0
  ) {
    throw new GuardError(
      'allowedAccounts が設定されていません。変更系操作(変更セットの作成・実行・スタック削除)には許可アカウントの設定が前提条件です(fail-closed)',
    );
  }
  if (
    config.allowedRegions === undefined ||
    config.allowedRegions.length === 0
  ) {
    throw new GuardError(
      'allowedRegions が設定されていません。変更系操作(変更セットの作成・実行・スタック削除)には許可リージョンの設定が前提条件です(fail-closed)',
    );
  }
}

// ===========================================================================
// ステップ 2: STS 解決 + アカウント照合(FR-7-6)
// ===========================================================================

/**
 * STS `GetCallerIdentity` で接続先アカウントを解決する(design §8.1-2, FR-7-6)。
 * 解決不能(認証エラー等)はそのまま呼び出し側へ伝播させる — ここで握りつぶさないことが
 * fail-closed の一部(呼び出し側は例外を変更系操作の中断として扱う)。
 *
 * 戻り値は `accountId` / `arn` の 2 フィールドのみを明示的に再構築する。ゲートウェイの
 * 実装が誤って余剰フィールド(クレデンシャル等)を含む値を返した場合でも、それらは
 * ここで捨てられ、下流(report 等)へ伝播しない(多層防御。FR-7-8)。
 */
export async function resolveConnection(
  sts: StsGateway,
): Promise<{ accountId: string; arn: string }> {
  const identity = await sts.getCallerIdentity();
  return { accountId: identity.accountId, arn: identity.arn };
}

/**
 * 解決したアカウント ID が `allowedAccounts` に含まれることを照合する
 * (design §8.1-2, FR-7-6)。含まれなければ fail-closed で拒否する。
 */
export function assertAccountAllowed(
  config: CfnSyncConfig,
  accountId: string,
): void {
  const allowed = config.allowedAccounts ?? [];
  if (!allowed.includes(accountId)) {
    throw new GuardError(
      `接続先アカウント (${accountId}) は許可アカウント一覧(allowedAccounts)に含まれていません(fail-closed)`,
    );
  }
}

// ===========================================================================
// ステップ 4: 対象リージョンの許可リージョン照合(FR-13-8)
// ===========================================================================

/**
 * 実行計画中の全対象リージョンが `allowedRegions` に含まれることを照合する
 * (design §8.1-4, FR-13-8)。1 つでも含まれないリージョンがあれば fail-closed で拒否する。
 */
export function assertRegionsAllowed(
  config: CfnSyncConfig,
  regions: string[],
): void {
  const allowed = new Set(config.allowedRegions ?? []);
  const disallowed = regions.filter((region) => !allowed.has(region));
  if (disallowed.length > 0) {
    throw new GuardError(
      `許可されていないリージョンが対象に含まれています(allowedRegions 外): ${disallowed.join(', ')}(fail-closed)`,
    );
  }
}

// ===========================================================================
// ステップ 3: ロック取得後のステートアカウント照合(FR-1-13)
// ===========================================================================

/**
 * ステートのアカウント ID と接続先アカウントを照合する(design §8.1-3, FR-1-13)。
 *
 * **前提条件: 呼び出し側が既にステートロックを取得済みであること。** ここで行う
 * `backend.load()` はロック取得後の再読込でなければならない(ロック取得前に読んだ
 * ステートを判断に使ってはならない、という design §8.1-3 の制約は呼び出し側が担保する)。
 *
 * - 照合が `mismatch`(記録済みアカウントと不一致)→ `GuardError`(fail-closed)。
 *   `backend.save` は呼ばれない。
 * - 照合が `unrecorded`(ステート未存在、または存在するが `accountId` 未記録)→
 *   解決したアカウント ID を記録した上で、読込時点の版を expected とした CAS 保存
 *   (`backend.save`)を行う(同一ロック区間内の初回記録。FR-1-13)。
 * - 照合が `match` → そのまま(保存せず)返す。
 */
export async function verifyStateAccount(input: {
  backend: StateBackend;
  accountId: string;
}): Promise<{ state: CfnSyncState; version: StateVersion | undefined }> {
  const loaded = await input.backend.load();
  const state = loaded?.state ?? createInitialState();
  const version = loaded?.version;

  const result = matchAccount(state, input.accountId);

  if (result === 'mismatch') {
    throw new GuardError(
      `ステートに記録されたアカウント (${state.accountId}) と接続先アカウント (${input.accountId}) が一致しません(fail-closed)`,
    );
  }

  if (result === 'unrecorded') {
    const recorded = withAccountId(state, input.accountId);
    const toSave = prepareSave(recorded);
    const savedVersion = await input.backend.save(toSave, version);
    return { state: toSave, version: savedVersion };
  }

  return { state, version };
}

// ===========================================================================
// ステップ 5: 接続先の出力(FR-7-8)
// ===========================================================================

/**
 * 解決した接続先(アカウント ID・対象リージョン)を report(T-11)の `ConnectionInfo`
 * として組み立てる(design §8.1-5, FR-7-8)。`accountId` / `regions` の 2 フィールドの
 * みを明示的に再構築するため、呼び出し側が誤って余剰フィールド(クレデンシャル等)を
 * 引数に含めても出力には一切現れない(多層防御。report/index.ts の renderText /
 * renderJson と同じ設計)。
 */
export function connectionHeader(connection: {
  accountId: string;
  regions: string[];
}): ConnectionInfo {
  return {
    accountId: connection.accountId,
    regions: [...connection.regions],
  };
}

// ===========================================================================
// guardMutation — 変更系操作の統合入口
// ===========================================================================

/** `guardMutation` の結果(FR-7-8: 接続先を後続処理・出力へ引き渡すための最小限の情報)。 */
export interface GuardResult {
  /** report へそのまま渡せる接続先情報(FR-7-8)。 */
  connection: ConnectionInfo;
  /** ステップ 3 でロック取得後に再読込(必要なら CAS 保存)した最新のステート。 */
  state: CfnSyncState;
  /** 上記ステートの版(次の CAS 保存で expected として使う)。 */
  version: StateVersion | undefined;
}

/**
 * design.md §8.1 の AccountGuard を 1 → 2 → 4 → 3 の順にまとめた統合入口。
 *
 * **前提条件: 呼び出し側が既にステートロックを取得済みであること。** ステップ 3
 * (`verifyStateAccount`)がロック取得後の再読込を要求するため(FR-1-13)、この関数
 * 全体がその前提の上で動作する。ロック取得前に許可設定・STS・リージョンだけを
 * 先に検証したい呼び出し側は、`assertMutationAllowed` / `resolveConnection` /
 * `assertAccountAllowed` / `assertRegionsAllowed` を個別に呼び出せばよい。
 *
 * 各ステップは前段が成功した場合のみ実行される(fail-closed): 許可設定なし →
 * STS 未呼び出し。アカウント不一致・リージョン不許可 → ステート未読込
 * (`backend.load` 未呼び出し)。ステートアカウント不一致 → `backend.save` 未呼び出し。
 */
export async function guardMutation(input: {
  config: CfnSyncConfig;
  sts: StsGateway;
  backend: StateBackend;
  targetRegions: string[];
}): Promise<GuardResult> {
  // 1. 許可設定の存在確認(FR-7-5)。
  assertMutationAllowed(input.config);

  // 2. STS 解決 + アカウント照合(FR-7-6)。
  const connection = await resolveConnection(input.sts);
  assertAccountAllowed(input.config, connection.accountId);

  // 4. 対象リージョンの許可リージョン照合(FR-13-8)。
  assertRegionsAllowed(input.config, input.targetRegions);

  // 3. ロック取得後のステートアカウント照合(FR-1-13。呼び出し側が既にロック取得済みの前提)。
  const { state, version } = await verifyStateAccount({
    backend: input.backend,
    accountId: connection.accountId,
  });

  return {
    connection: connectionHeader({
      accountId: connection.accountId,
      regions: input.targetRegions,
    }),
    state,
    version,
  };
}
