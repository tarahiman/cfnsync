日本語 | [English](./CHANGELOG.en.md)

# 変更履歴

本書の形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に、バージョンは [Semantic Versioning](https://semver.org/lang/ja/) に従います。**0.x の間は破壊的変更を許容します。**

## Unreleased

`deploy` の既定挙動を「全 Change Set の作成 → 全差分の表示 → 実行全体で 1 回の yes/no 承認 → 依存順で一括実行」へ変更しました（`terraform apply` 相当）。**CI 利用者は必ず影響を受けます。** 下記の破壊的変更 1 と 2 を先に確認してください。

### 破壊的変更

#### 1. `--confirm` の廃止（`--auto-approve` / `-y` の新設）

- **変更前**: 既定では確認せずに実行し、`--confirm` を指定したときだけ TTY で確認していました。
- **変更後**: 既定で承認を求めます。`--confirm` は未知のオプションとして `CliUsageError`（終了コード `1`）になります。承認を省略するには `--auto-approve`（短縮形 `-y`）を指定します。`--auto-approve` は `deploy` 専用で、他のサブコマンドには提供されません。

**移行**:

```sh
# 変更前: TTY で確認してから実行
cfnsync deploy --confirm
# 変更後: 承認は既定なのでフラグ不要
cfnsync deploy

# 変更前: 確認せずに実行（既定）
cfnsync deploy
# 変更後: 承認を省略する意思を明示する
cfnsync deploy --auto-approve
```

#### 2. 非 TTY の `deploy` は `--auto-approve` が必須

- **変更後**: TTY のない環境（CI など）で `--auto-approve` なしに `deploy` を実行すると、`CliUsageError`（終了コード `1`）で停止します。拒否は CLI 境界で行われ、AWS クライアントの生成・ステートバックエンドへのアクセスを含む副作用は一切発生しません。`--output json` を選択している場合、stdout には `CliUsageError` の payload が出ます。
- **変更が 1 件もない実行も同じくエラーになります。** TTY の判定を変更検知より前に行うためで、「差分がないから従来どおり終了コード `0` で通る」という前提は成り立ちません。
- `deploy --dry-run` と `plan` は承認を求めないため対象外です。従来どおり非 TTY で動作します。

**移行**: CI のワークフローで `deploy` に `--auto-approve` を追加してください。**これを忘れるとデプロイジョブが失敗します。**

```yaml
# 変更前
- run: npx @tarahi/cfnsync deploy --no-color
# 変更後
- run: npx @tarahi/cfnsync deploy --auto-approve --no-color
```

#### 3. 承認拒否時の出力契約の置換

- **変更前**: 承認を拒否すると、`--output json` では専用の payload `{"exitCode": 0, "cancelled": true, "message": "Deployment cancelled."}` を stdout へ出し、text では stderr に `Deployment cancelled.` を出すだけで stdout には何も出しませんでした。
- **変更後**: 拒否時も通常の deploy report を stdout へ 1 個出力し、その report に `cancelled: true` が加わります。**専用 payload の `exitCode` と `message` フィールドは消滅します。** text 出力では stderr の `Deployment cancelled.` に加えて stdout へ report を出します。終了コードは従来どおり `0` です。
- 拒否していない実行の JSON には `cancelled` フィールド自体が現れません（既存 schema と互換）。

**移行**: 拒否を検出しているスクリプトは、`.exitCode` / `.message` の参照をやめて `.cancelled` を見てください。未実行のスタックは deploy report の既存フィールドから復元できます（`stacks[].outcome` が `skipped`）。

#### 4. `--on-failure` の適用範囲を実行段階へ限定

- **変更前**: `__REQUIRED__` プレースホルダの残存のような**計画段階**の失敗でも、依存下流を `skipped` としたうえで、独立したスタックは `--on-failure continue` に従って実行されていました。
- **変更後**: 計画段階の失敗は `--on-failure` の値にかかわらず実行全体を中断します（終了コード `1`）。`--on-failure stop|continue` は**実行段階の失敗にのみ**適用されます。
- これは「もともと実行中の失敗だけが対象だったので、スコープを明示しただけ」ではありません。変更前の `docs/spec/design.md` §8.2 は、`__REQUIRED__` 残存を「計画上の失敗」「AWS 副作用前」と明記したうえで「独立スタックだけを `--on-failure` に従わせる」と規定していました。**公開オプションの意味を狭める互換性破壊です。**
- 変更の根拠は、差分が不完全な計画に対して不可逆な操作の承認を求めない、というものです。`--auto-approve` の場合も扱いを変えません（計画が不完全である危険は承認の有無と無関係のため）。

**移行**: `--on-failure continue` による部分的な前進に依存していた場合は、計画段階の失敗（`__REQUIRED__` の残存、Change Set 作成の失敗など）を先に解消してから再実行してください。実行単位を分けたい場合は設定ファイルを分割してください。縮退実行は将来的に別の明示オプションとして検討します（本リリースのスコープ外）。

#### 5. 検証不能な CREATE 復旧の fail-closed 化

対象は「過去の実行が `CreateStack` に成功した直後、ステートを保存する前に中断した」状態からの自動再同期経路（`added` と判定されたスタックが AWS 上に既に存在するケース）です。

- **変更前**: `NoEcho` パラメータと `dependsOn` を比較対象から除外し、警告を出したうえでローカルの希望値をステートへ記録して再同期していました。
- **変更後**: 対象テンプレートに `NoEcho` パラメータが宣言されている、または当該スタックに `dependsOn` が 1 件以上ある場合、再同期せず当該対象を失敗として扱います（終了コード `1`）。管理タグ・テンプレート・可視パラメータ・タグ・Capabilities がすべて一致していても再同期しません。
- **根拠**: `NoEcho` の実値は AWS から取得できず照合できません。中断後に利用者が NoEcho 値を変更していると、まだ適用されていない新しい値を「適用済み」としてステートへ記録し、次回の検知が `unchanged` になって**変更が永久に失われる**経路がありました。

**復旧手順**: `cfnsync import` を実行するだけでは回復しません。**import は設定ファイルの既存の NoEcho 値を無条件に `__REQUIRED__` へ書き換えるため、希望していた秘密値が失われ、次の `deploy` も `__REQUIRED__` 残存の検査で停止します。** 次の順序で復旧してください。

1. `cfnsync.yaml` を退避する（NoEcho パラメータの希望値が失われるため）
2. `cfnsync import --reconcile local` を実行する（ローカルのテンプレートを維持し、ステートにはデプロイ済み側のハッシュを記録する）
3. import が `__REQUIRED__` へ書き換えた NoEcho パラメータを、退避しておいた希望値へ戻す
4. `cfnsync plan` で差分を確認する
5. `cfnsync deploy` を実行する

**既知の制限**: この復旧には手動での秘密値の復元が必要です。AWS が `NoEcho` の実値を返さない（マスク値しか返さない）ことに起因する構造的な制約であり、自動化しません。

#### 6. 同一の（リージョン, スタック名）へ解決される設定を拒否

複数のテンプレートが同一リージョンで同じ `stackName` へ解決される設定は、AWS へアクセスする前に `ConfigError`（終了コード `1`）で拒否します。テンプレートパスの変更によって「旧ステートからの delete + 新設定からの create」が同一の（リージョン, スタック名）を指す場合も、AWS 副作用の前に fail-closed で拒否し、リネームによる移行を案内します。異なるスタック名へのリネーム、および同一 `stackName` を複数リージョンへ配る構成は従来どおり許容されます。

#### 7. リソース差分 0 件の text 表示の変更

Outputs / Export のみを変更した場合など、成功したが CloudFormation リソース差分が 0 件の Change Set の text 表示が `(変更なし)` から「CloudFormation リソース差分 0 件（Outputs 等の非リソース変更を含み得る）」旨の注記へ変わります。**この対象は従来どおり実行されます**（実行しないと Export が作成されず、それを `Fn::ImportValue` する後続スタックが失敗するため）。表示の変更はレンダラのみで行うため、**JSON 出力は変わりません**（`operation` は `update` のまま、`warnings` は空）。テキスト出力を回帰判定のベースラインに使っている場合は、この差分を許容してください。

### 追加

- `deploy` に `--auto-approve`（`-y`）を追加しました。
- 承認要約を標準エラーへ出力します（`--output json` でも標準出力の単一 JSON document を汚しません）。差分本体と同じ色付け規則に従い、`--no-color` / `NO_COLOR` で無色化できます。NoEcho の実値は差分と同じ redactor でマスクされます。
- deploy の JSON report に `reconciliations` を追加しました。再同期（空変更セットの確認、削除済みスタックの確認、CREATE 復旧）が発生した実行にだけ現れ、`stackKey` と種別、ステート更新の有無を機械可読に開示します。再同期が発生しない実行には現れないため、既存の消費側には影響しません。text 出力にも同じ内容を列挙します。

### 変更

- 承認待ちの間、ステートロックを保持し続けます。`s3` バックエンドでは、その間ほかの実行がブロックされます。ロックの保持時間が実行時間ではなく人間の応答時間に依存するため、対話的な承認を伴う運用では注意してください（承認待ちのタイムアウトは設けていません）。
- 実行直前の再検査の順序を `DescribeStacks` → `ListChangeSets` → ロック所有権の検証（fencing）→ `ExecuteChangeSet` に固定しました。承認待ちは任意長の競合窓になるため、計画段階の検査結果を再利用せず、対象ごとに実行直前へ再検査を置きます。`UPDATE` は実行可能な終端状態の allowlist に限定し、承認待ちの間に `ROLLBACK_COMPLETE` などへ遷移した場合も取りこぼしません。
- **承認時点の差分と実行時点の実状態の一致は保証しません。** Change Set は作成時点のスナップショットであり、上記の再検査が防御のすべてです。これらは競合窓を狭めますが排除はせず、cfnsync はそれ以上の保証を主張しません。
- 承認を拒否した場合、または計画段階で失敗した場合は、作成済みの Change Set をすべて削除します。ただし新規スタックに対する CREATE 型 Change Set の作成で生じた `REVIEW_IN_PROGRESS` のスタックの殻は AWS 上に残ります（安全不変条件により殻へ `DeleteStack` は呼びません）。殻は次回実行時に回収され、その上に CREATE 型 Change Set を再作成して収束します。既定が承認フローになったことで、この殻の発生頻度は上がります。

### 既知の性質

- **この実行で新規作成される Export を参照するプロパティは、承認時点で最終値が確定しません。** `Fn::ImportValue` は Change Set の作成時に解決されず、`{{changeSet:KNOWN_AFTER_APPLY}}` として保留されます（既に存在する Export を参照する場合は作成時に実値へ解決されます）。cfnsync はこの保留値をそのまま提示し、独自に解決・補完しません。terraform の "known after apply" と同じ性質です。

## 0.1.0 — 2026-07-26

最初のリリース。
