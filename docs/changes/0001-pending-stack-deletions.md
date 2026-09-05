# 変更提案 0001: 削除待ちスタック(pending deletion)のステート追跡

- Status: Accepted
- Owner: cfnsync maintainers
- Issue: [#16](https://github.com/tarahiman/cfnsync/issues/16) — stackName リネームで旧スタック削除失敗後に旧スタックが state から脱落する
- Target release: Unreleased
- Affected requirements: FR-1 / FR-5 / FR-6 / FR-11 / NFR-3

## Problem

FR-1-14 は「`stackName` の設定変更」を「旧スタック名のスタックの削除 + 新スタック名のスタックの新規作成」として
扱うと定めている。`core/detect` は同一スタックキーに対し `deleted`(旧名)と `added`(新名)の対を生成し、
`core/plan` は create を先、delete を後に並べる。

しかし現在のステート(`schemaVersion: 2`)は 1 スタックキーにつき 1 エントリしか持てない。新名の作成成功を
同じスタックキーへ保存すると、旧スタック名の情報はその時点でステートから失われる。旧名の削除は
「同一スタックキーの create が保存した新エントリを消さない」ために `preserveStateEntry: true` で処理され、
削除が完了しなかった場合に再試行するための記録がどこにも残らない。

その結果、次の経路で**管理対象が黙ってステートから脱落する**。

1. `a.yaml@ap-northeast-1` を `stackName: Old` でデプロイする。
2. 同じ設定エントリの `stackName` を `New` に変更する。
3. 次のいずれかで `deploy` する。
   - `--allow-delete` を指定しない(Phase A で旧名削除は `skipped`、Phase B で新名 create は成功する)。
   - 旧名スタックの削除保護(Termination Protection)が有効で `--allow-delete` を指定した。
   - `DeleteStack`、完了待機、または削除後のステート保存(CAS)が失敗した。
4. 新名スタックの作成は成功し、ステートの同一キーが `stackName: New` で上書きされる。
5. 旧名スタックは AWS 上に残るが、次回の `status` / `plan` / `deploy` では config も state も新名を指すため
   `unchanged` となり、削除候補に**二度と現れない**。

影響: 旧名スタックが AWS 上に孤児化し、課金・リソース・Export が残存する。利用者は通常の再実行だけでは
残存を検知・削除できない。FR-1 の変更検知、FR-6 の削除安全装置、NFR-3 の「途中失敗後の再実行で自動収束」に反する。

## Goals / non-goals

### Goals

- 旧名スタックが実際に削除されるまで、以後の実行でも削除候補として追跡され続けること。
- 削除の拒否・失敗・`--allow-delete` 未指定のいずれによっても、管理対象が黙ってステートから脱落しないこと。
- 中断・並行実行の後の再実行が安全に収束すること(NFR-3)。
- 削除待ちの削除が、通常の削除とまったく同じ安全装置(`--allow-delete`、統合依存グラフの逆順、依存情報を
  復元できない場合の拒否、削除保護、`REVIEW_IN_PROGRESS` 保護、`stackId` 照合、fencing、CAS)を通ること。

### Non-goals

- 削除待ちを解消する専用サブコマンド(`cfnsync prune` 等)の新設。既存の `deploy --allow-delete` で収束させる。
- `graph` へのステート由来ノードの追加(下記「Proposed behavior」の 7 を参照)。
- テンプレートパス変更(スタックキー自体の変更)によるリネーム移行の自動化。これは FR-11-10b が
  現在も fail-closed で拒否しており、本提案の対象外である。
- 削除待ちを利用者が手動編集で消すための CLI。ステートの手動復旧は既存の運用手順に従う。

## Proposed behavior

### 1. ステート `schemaVersion: 3` と削除待ち記録

ステートに `stacks` とは独立した `pendingDeletions` を追加する。キーは削除対象の物理スタックを一意に識別する
`<スタック名>@<リージョン>`(同一リージョン内でスタック名は物理スタックの一意識別子)。値は FR-6 の安全装置が
必要とする情報と由来を持つ。

```json
{
  "schemaVersion": 3,
  "accountId": "123456789012",
  "generation": 43,
  "stacks": {
    "network.yaml@ap-northeast-1": { "stackName": "prod-network-v2", "...": "..." }
  },
  "pendingDeletions": {
    "prod-network@ap-northeast-1": {
      "stackName": "prod-network",
      "stackId": "arn:aws:cloudformation:ap-northeast-1:123456789012:stack/prod-network/0123",
      "region": "ap-northeast-1",
      "exports": ["prod-network-VpcId"],
      "imports": [],
      "dependsOn": [],
      "dependencyAnalysisIncomplete": false,
      "originStackKey": "network.yaml@ap-northeast-1",
      "reason": "rename",
      "recordedAt": "2026-09-05T00:00:00.000Z"
    }
  }
}
```

`schemaVersion: 1` / `2` は従来どおり読み込み、削除待ちなし(`pendingDeletions: {}`)として補完する。
既存の v1 移行規則(`stackId` / `dependsOn` の unknown 化、`dependencyAnalysisIncomplete` の fail-closed 補完)は
変更しない。次回の成功保存で `schemaVersion: 3` へ正規化する。

### 2. 削除待ちの記録は新エントリの保存と同一の compare-and-swap で行う

リネームによる新スタック名の作成成功をステートへ記録する保存操作(Phase B の実行成功記録、Phase A の
CREATE 復旧による再同期のいずれも)は、**同じ保存ペイロード**に旧スタック名の削除待ち記録を含める。
2 回の保存に分けると、その間のクラッシュで同じ脱落が再発するためである。

### 3. 削除待ちは変更検知の出力に `deleted` として現れる

`detectChanges` は削除待ち 1 件につき `deleted` 分類の対象を 1 件生成する。スタックキーは予約プレフィックスを
用いた `cfnsync:pending/<スタック名>@<リージョン>` とし、設定由来のスタックキーと決して衝突しないよう、
`cfnsync:` で始まるテンプレートパスを設定検証で拒否する。

これにより `status` / `plan` / `deploy` の既存の削除経路がそのまま削除待ちに適用され、削除順序(統合依存
グラフの逆順)、`--allow-delete`、依存情報の復元可否、削除保護、`stackId` 照合の安全装置をすべて通る。

### 4. 削除待ちは「実際に削除されたことを確認するまで」残る

- `--allow-delete` 未指定 → 差分に削除プレビューとして現れ、`skipped`。記録は残る。
- 削除保護・依存情報欠落 → `refused`(結果は `failed`)。記録は残る。
- `DeleteStack` 失敗・完了待機失敗 → `failed`。記録は残る。
- `DeleteStack` は成功したがステート保存が CAS 競合で失敗 → 記録は残る。次回実行の Phase A が
  `DescribeStacks` でスタックの不在を確認し、既成事実の再同期(FR-5-5b2 と同種)として記録を除去する。
- 承認拒否 → Phase B へ進まないため記録は残る。

### 5. リネーム対の削除は「対の create の成功記録」を前提とする

同一実行内でリネーム対の旧スタックを削除する場合、`DeleteStack` の直前に、対となる新スタックの作成成功が
ステートへ記録済みである(= 当該削除待ち記録が存在する)ことを確認する。記録がない場合は削除を拒否する
(fail-closed)。新スタックが作成されていない状態で旧スタックだけを削除する経路
(`--on-failure continue` で create が失敗した場合)を塞ぐ。

### 6. 削除待ちと新しい設定エントリの物理スタック衝突

削除待ちの (リージョン, スタック名) を、設定由来の create / update 対象が同時に指す場合(例: `Old` → `New` の
リネーム後に削除待ち `Old` を残したまま `New` → `Old` へ戻した場合)、FR-11-10b と同一の物理識別子判定により
AWS への副作用の前に fail-closed で拒否する。

### 7. 表示

- `status`: 削除待ちは `deleted` として、スタックキー `cfnsync:pending/<名前>@<リージョン>` と旧スタック名で現れる。
  出力 schema にフィールドを追加しない。
- `plan` / `deploy`: 操作種別 `delete` の差分として現れ、`StackDiff.warnings` に由来(元のスタックキー)を含む警告を
  追加する。deploy report の JSON に新しいフィールドは追加しない(FR-5-16 を維持)。再同期の開示は既存の
  `deleted-absent` 種別を再利用する。
- `graph`: **現在のテンプレート群から構築した依存グラフだけを出力し、削除待ちを含めない。** `graph` は
  ステートを一切読まないローカル専用コマンド(NFR-5)であり、削除済み・削除予定のスタックを従来から
  表示していない。削除待ちのためだけにステート読み取りを導入するとコマンドの性質と性能特性が変わるため、
  削除待ちの可視化は `status` / `plan` / `deploy` が担う。

## Safety and compatibility

### 影響する FR / NFR と現在の失敗モード

| 要件 | 現在の失敗モード |
|---|---|
| FR-1(変更検知・ステート) | リネーム後、旧名スタックがステートから脱落し `unchanged` になる |
| FR-1-14(スタック名変更) | 「削除 + 新規作成」の対のうち削除だけが失われても検知できない |
| FR-6(削除安全装置) | 削除されなかった対象が削除候補から消える。`--allow-delete` を後から付けても復帰しない |
| FR-11-10b(物理スタック衝突) | 削除待ちが存在しないため、リネームを戻したときの衝突を検出できない |
| NFR-3(冪等・自動収束) | 削除が完了しなかった実行の再実行が収束しない(孤児化したまま) |

### 保護を弱めないことを示す異常系・並行系の受入基準

- CREATE 成功後・ステート保存前の中断からの CREATE 復旧(FR-1 / FR-5-5b3)でも、リネーム由来なら削除待ちを
  同一保存で記録する(FR-1-18)。管理タグ `cfnsync:state-id` による由来確認と検証不能入力の fail-closed
  (ADR-0002)は一切緩和しない。
- 削除待ちの削除は `--allow-delete` を要求し、統合依存グラフの逆順で、依存情報を復元できない場合は拒否する
  (FR-6-7 / FR-6-8)。削除保護の自動解除は行わない。`REVIEW_IN_PROGRESS` のスタックへ `DeleteStack` を
  行わない。`stackId`(ARN)が記録と一致しない場合は拒否する。
- `DeleteStack` 直前とステート保存直前の fencing を通す。fencing は**ベストエフォート**のままであり、
  正本の一貫性は CAS とスタック単位の `*_IN_PROGRESS` ガードが担う — この位置づけを変更しない。
- 削除待ちの除去は必ず compare-and-swap で保存する。競合した側の保存は失敗し、記録は残る(= 収束は次回)。
- 削除待ちのリージョンも `allowedRegions` 照合(FR-13-8)の対象に含める。許可されないリージョンの削除待ちが
  ある実行は fail-closed で停止する。

### AWS 副作用より前に停止する境界と、残る TOCTOU 競合窓

AWS 副作用より前に停止する境界:

- 予約プレフィックス `cfnsync:` のテンプレートパス拒否(設定検証。AWS・ステートバックエンドへのアクセス前)。
- 削除待ちと create / update の物理スタック衝突(FR-6-10 / FR-11-10b。変更検知の後・AWS 副作用の前)。
- 削除待ちの依存情報が復元できない場合の削除バッチ停止(§8.3 の既存判定を削除待ちへ拡張)。

残る TOCTOU 競合窓(新設しない・狭めもしない既存の窓):

- `DescribeStacks`(状態・`stackId` 確認)から `DeleteStack` までの窓。CloudFormation に条件付き削除がないため
  原理的に排除できない。削除待ちでも同じであり、これ以上の保証を主張しない。
- fencing の検証から副作用までの窓(§4.5 の記述どおりベストエフォート)。
- Phase A の削除プレビュー(`DescribeStacks`)から Phase B の `DeleteStack` までの承認待ち窓。既存の
  `DeleteStack` 直前の再検証に一本化されており、削除待ちも同じ経路を通る。

本提案が**新たに導入する競合窓はない**。削除待ちの記録・除去はいずれも既存の CAS 保存経路に載る。

### 互換性破壊と移行手順

- ステート schema が `3` へ上がる。**新しい cfnsync が一度でも保存したステートは、古い cfnsync では
  `StateCorruptionError` になり読めない**(古い実装は `schemaVersion` 1 / 2 だけを受理するため)。
- 移行手順: 特別な操作は不要。`schemaVersion: 1` / `2` のステートはそのまま読め、最初の成功保存で
  `3` へ正規化される。`s3` バックエンドではバージョニングを有効にしておけば旧世代へ戻せる。
- `cfnsync:` で始まるテンプレートパスを設定に持つ利用者は改名が必要(実在しうるが極めて考えにくい)。
- deploy report / status の JSON schema は変更しない。削除待ちは既存の `delete` / `deleted` として現れる。

### ロールバック方法

- 実装のロールバック: 本変更を revert する。ただし `schemaVersion: 3` で保存済みのステートは古い実装で
  読めないため、`s3` のバージョニングまたは `local` の `.bak` から旧世代を復元するか、`schemaVersion` を
  `2` に書き換えて `pendingDeletions` を削除する(その場合、追跡していた削除待ちは失われ、Issue #16 の
  孤児化が再発する)。
- 部分的な緩和は行わない。削除待ちを「警告して継続」へ緩める運用フラグは設けない。

## Alternatives

### A. 旧名の削除が完了するまで新名のステート確定を遅延する(不採用)

create 成功後もステートを旧名のまま保ち、旧名の削除が成功した時点で初めて新エントリへ差し替える案。

不採用の理由: 新名 create の成功がステートに残らないため、その直後に中断すると「AWS 上に新名スタックが
存在するのにステートは旧名を指す」という別の不整合が生じる。この状態からの復旧は CREATE 復旧(管理タグに
よる由来確認 + 全入力の完全一致)に完全に依存するが、ADR-0002 のとおり `NoEcho` パラメータまたは
`dependsOn` を持つスタックでは復旧が fail-closed で拒否され、利用者は手動の秘密値復元を伴う import 手順を
踏まざるを得なくなる。**成功した AWS 操作を記録しない設計は NFR-3 の自動収束を弱める。**

### B. 旧名を `stacks` 内の別スタックキーへ退避する(不採用)

`network.yaml@ap-northeast-1` の旧名を `network.yaml#old@ap-northeast-1` のような合成キーで `stacks` に
残す案。不採用の理由: `stacks` のキーは「テンプレート相対パス@リージョン」という管理単位の定義
(§4.1)そのものであり、実在しないテンプレートパスを混ぜると変更検知(設定にあるか/ステートにあるか)の
判定表が崩れる。`templateHash` / `inputsHash` / `lastAction` など削除にとって無意味なフィールドの
偽値を持たせる必要も生じる。

### C. 削除待ち専用サブコマンドを新設する(不採用・将来検討)

`cfnsync prune` のような専用コマンドで削除待ちだけを処理する案。不採用の理由: 削除順序は他の管理対象との
統合依存グラフに依存するため、結局 `deploy` と同じ計画・承認・実行経路が必要になる。公開コマンドの
重複は FR-5-20a と同じ問題(承認の要否・終了コード・削除プレビューの意味の分岐)を招く。

## Specification and evidence plan

| 要件 ID | design の変更箇所 | 受入テスト | 利用者文書 |
|---|---|---|---|
| FR-1-16 / FR-1-17 | §4.3 | `test/core/state.test.ts` | CHANGELOG |
| FR-1-18 / FR-1-19 | §4.4, §5.3, §7 | `test/usecase/pendingDeletion.test.ts` | README / CHANGELOG |
| FR-1-20 | §5.3, §7 | `test/usecase/pendingDeletion.test.ts` | CHANGELOG |
| FR-1-21 / FR-1-22 / FR-1-23 | §4.4 | `test/core/detect.test.ts`, `test/usecase/status-graph.test.ts` | README |
| FR-5-5b7 / FR-5-18e | §5.3 | `test/usecase/pendingDeletion.test.ts` | CHANGELOG |
| FR-6-7 / FR-6-8 / FR-6-9 / FR-6-10 | §8.3 | `test/usecase/pendingDeletion.test.ts`, `test/usecase/delete.test.ts` | README / skills |
| FR-6-11 / FR-6-12 | §5.2, §5.5, §8.3 | `test/usecase/pendingDeletion.test.ts`, `test/usecase/status-graph.test.ts` | README |
| FR-11-11 | §4.2 | `test/core/config.test.ts` | config reference |

判断理由は [ADR-0003](../decisions/0003-pending-stack-deletions.md) に記録する。

## Delivery

- Issue: [#16](https://github.com/tarahiman/cfnsync/issues/16)

## Open questions

- なし(方針確定済み)。将来、削除待ちが長期間残留する運用を検出したい場合は、`status` の終了コードや
  専用の警告閾値を別 Issue として検討する。
