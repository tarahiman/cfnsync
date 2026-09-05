# ADR-0002: 検証不能入力がある CREATE 復旧は fail-closed にする

- Status: Accepted
- Date: 2026-07-30
- Related requirements: FR-1, FR-5-5b3, FR-5-5b4
- Related proposal / issue: T-22
- Supersedes: 検証不能入力を比較から除外し、警告付きで再同期する方式
- Superseded by: なし

## Context

CREATE が AWS 上で成功した後、state 保存前に実行が中断すると、次回はローカルで `added` と判定される一方、
同名スタックが既に存在する。以前の復旧方式は、AWS から値を取得できない NoEcho パラメータと、実スタックから
照合できない `dependsOn` を比較から除外し、管理タグ等が一致すればローカルの希望値を state に記録していた。

この方式には変更喪失経路がある。CREATE 時の NoEcho 値が S1、保存前中断後にローカル値が S2 へ変わった場合、
S2 を AWS へ適用せず「適用済み」として state に保存できる。その後の変更検知は `unchanged` となり、S2 の変更が
永久に適用されない。

## Decision

`added` だが同名スタックが存在する CREATE 復旧は、次のすべてを検証でき、一致する場合だけ自動再同期する。

- 自 state ID の管理タグ
- 正規化したテンプレート
- 実効パラメータ
- タグ
- Capabilities
- 検証不能入力が存在しないこと

テンプレートに NoEcho パラメータが宣言されている場合、明示 `dependsOn` が 1 件以上ある場合、非 scalar Default 等で
実効値を決定できない場合は state を保存せず、fail-closed に停止して import を案内する。管理タグは作成主体を示すが、
どの入力で作成したかまでは証明しない。

現在の詳細な規範は [requirements.md の FR-1](../spec/requirements.md#fr-1-変更検知とステート管理)と
[design.md §7](../spec/design.md#7-変更セットのライフサイクルusecaseexecutor)を参照する。

## Alternatives considered

- **検証不能入力を除外して警告付きで再同期する**: 未適用の希望値を適用済みと記録できるため不採用。
- **管理タグだけで復旧する**: タグは入力値を証明しないため不採用。
- **import で NoEcho の希望値を自動保持する**: AWS から実値を取得できず、既存 import 契約を大きく変えるため不採用。

## Consequences

- 影響範囲は、NoEcho または `dependsOn` を持つスタックで CREATE 成功後・state 保存前に中断した復旧経路に限られる。
- 復旧には次の手動手順が必要になる。

  1. `cfnsync.yaml` を退避する。
  2. `cfnsync import --reconcile local` を実行する。
  3. import が `__REQUIRED__` にした NoEcho 値を、退避した希望値へ戻す。
  4. `cfnsync plan` で差分を確認する。
  5. `cfnsync deploy` を実行する。

- AWS が NoEcho 実値を返さないため、秘密値の復元は自動化できない。

利用者向けの移行・復旧手順は [CHANGELOG の該当項目](../../CHANGELOG.md#5-検証不能な-create-復旧の-fail-closed-化)を参照する。

## Evidence

- 詳細な受入テスト対応: [tasks.md T-22](../spec/tasks.md#t-22-deploy-を差分表示-承認-実行へ変更する)
- 主なシナリオ: `test/usecase/recovery.test.ts`, `test/usecase/approval.test.ts`
