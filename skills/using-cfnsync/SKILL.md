---
name: using-cfnsync
description: cfnsync CLI(生の CloudFormation テンプレートのディレクトリをスタックへ同期するツール)を操作・調査するときに使う。status/plan/deploy/graph/import/force-unlock の使い分け、終了コード(0/1/2)の解釈、deploy 前後の安全確認、fail-closed・ロック・change set 所有権まわりのトラブル対応が必要な場面や、cfnsync.yaml の設定作業を支援する場面で有効。
---

# cfnsync の使い方

`cfnsync` は、ディレクトリ内の生の CloudFormation テンプレート(YAML/JSON)と AWS スタックを同期する CLI です。テンプレートの追加・変更・削除を検知し、change set の作成・差分表示・実行、スタックの作成・更新・削除を依存関係の順序で行います。CI(GitHub Actions)での非対話実行が主眼で、CDK のようなテンプレート生成・抽象化レイヤーは持ちません。

このスキルは、cfnsync のサブコマンドを Claude Code から適切に選択・実行し、出力(終了コード・diff・エラー)を正しく解釈するためのガイドです。

## 設定ファイルの書き方

`cfnsync.yaml` のパラメータ一覧とサンプルは、このリポジトリの以下のドキュメントを正とします(本スキル内では重複説明しません。設定ファイルを読み書きするときは必ず参照してください):

- パラメータリファレンス: [`../../docs/config-reference.md`](../../docs/config-reference.md)
- コメント付きサンプル: [`../../docs/examples/cfnsync.sample.yaml`](../../docs/examples/cfnsync.sample.yaml)

## サブコマンドの使い分け

すべてのサブコマンドは `--config <path>`(既定 `./cfnsync.yaml`)、`--profile`、`--region`、`--output <text|json>` を共通で受け付けます。機械可読な出力が欲しい場合は `--output json` を使ってください。

| コマンド | 用途 | AWS への副作用 |
|---|---|---|
| `status` | ステートと現在のテンプレートを比較し、`added`/`modified`/`deleted`/`unchanged` を表示する | なし(読み取りのみ) |
| `plan` | change set を作成して差分を表示し、実行せずに終了する | change set の作成のみ(実行はしない) |
| `deploy` | 変更検知・依存順序解決・change set 作成・差分表示・実行を非対話で行う | あり。`--dry-run` で作成と差分表示のみに抑制できる |
| `graph` | テンプレートの Export/`Fn::ImportValue` と `dependsOn` から依存グラフを表示する | なし(読み取りのみ) |
| `import` | 既存スタックの設定・テンプレート・ステートを取り込む | AWS へは読み取りのみ。ローカルの設定・テンプレート・ステートは書き換わりうる |
| `force-unlock <runId>` | S3 ステートに残存したロックを、指定した実行 ID が一致する場合だけ条件付きで解除する | ロック解除のみ(条件不一致なら何もしない) |

### 典型ワークフロー

1. **状況確認**: `cfnsync status --output json` でテンプレートとステートの差分種別を確認する。
2. **事前確認**: `cfnsync plan` で change set の Add/Modify/Remove、置換(replacement)警告を確認する。破壊的変更(置換・削除)がないか必ず見る。
3. **実行**: 問題なければ `cfnsync deploy`(必要に応じ `--allow-delete`)を実行する。CI では通常フラグ操作は行わず、リポジトリ側で固定したコマンドを実行させる。
4. **依存関係の把握**: 複数テンプレート間の依存やデプロイ順序が疑わしい場合は `cfnsync graph --output json` で確認する。
5. **既存スタックの取り込み**: 手動作成済み・他ツール管理のスタックを cfnsync 管理下に置きたい場合は `cfnsync import` を使う(`--reconcile remote|local` でテンプレート差分の解決方向を指定、`--write-template` でローカルにテンプレートを書き出す)。
6. **ロック残存への対応**: `deploy`/`import` が異常終了しロックが残った場合、**ロックを保持していた旧実行(CI ジョブを含む)が完全に終了していることを確認してから**、表示された実行 ID を使い `cfnsync force-unlock <runId>` を実行し、その後で再実行する。稼働中の実行に対して解除してはならない。

## 終了コードの意味

| 終了コード | 意味 |
|---|---|
| `0` | 成功(変更なし=diff なしを含む) |
| `1` | エラー(設定検証・fail-closed ガード・AWS 操作の失敗など) |
| `2` | 差分あり(`plan`、および `deploy --dry-run` 時のみ。実際の変更は行われていない) |

CI パイプラインはこれらの終了コードに依存して分岐しているため、`plan` が `2` を返すのは「異常」ではなく「差分がある」ことを表す正常系である点に注意してください。

## 安全性不変条件(要約)

cfnsync の変更系操作は、以下の多層防御を前提に設計されています。挙動を説明・提案するときにこれらを弱めて言い換えないでください。

- **fail-closed が全体方針**: `allowedAccounts`/`allowedRegions` が設定にない、STS `GetCallerIdentity` の結果と一致しない、接続先や対象リージョンを解決できない、といった状況では変更系操作(change set 作成・実行・スタック削除)を一切行わずエラー終了する。警告を出して続行することはない。加えて、ステートは初回の変更系実行時(ロック取得後)に接続先アカウント ID を `accountId` として記録し、以後の実行で STS の解決結果と不一致であれば(アカウント切り替え・ステートファイルの誤用等)一切の書き込みを行わず拒否する。これは `allowedAccounts` という設定レベルの許可リストとは別個の、ステート自体に紐づくガードである。
- **ステートバックエンド**は Terraform ライクな設計で、既定は `local`(単一プロセス想定)、CI 向けに `s3` がある。世代/ETag による compare-and-swap、S3 の条件付き書き込みによるロック、原子的なファイル置換で正本の一貫性を守る。各副作用の直前に所有権を再確認する fencing は**ベストエフォート**であり(CloudFormation 自体が fencing token を提供しないため競合窓を完全には排除できない)、厳密な保証は CAS とスタック単位の `*_IN_PROGRESS` ガードが担う。fencing を「厳密な排他制御」と説明しないこと。
- **change set の所有権管理**: change set 名は `cfnsync-<stateID>-<runID>-<timestamp>` の形式でエンコードされ、自分の stateID を持つ change set のみ自動的に回収(削除)してよい。他ツール・他人・他 state が作成した change set が存在する場合は実行をブロックする(fail-closed)。`ExecuteChangeSet` は同一スタック上の他の change set を暗黙的に削除する破壊的操作のため、実行直前に対象 change set を再確認する。
- **`REVIEW_IN_PROGRESS` 状態のスタックを `DeleteStack` してはならない**。この状態では、代わりに CREATE 型の change set を作り直して処理する。
- **管理タグ** `cfnsync:state-id=<stateID>` が全スタックに自動付与され、CREATE 系の回復処理(`added` 判定だがスタックが既に存在する場合)における provenance(所有権)確認に使われる。
- **スタック削除**は `--allow-delete` を明示指定した場合のみ実行され、新旧設定をマージした依存グラフの逆順(依存されている側を後に)で行われる。依存情報を state から復元できない場合は削除を拒否する。

## トラブルシューティングの手がかり

- `plan`/`deploy` が `1` で終了し「allowedAccounts」「allowedRegions」に言及するエラー: 設定不足または接続先アカウント/リージョンの不一致。fail-closed の正常な拒否なので、設定を直すか正しい `--profile`/`--region` で再実行する(値を緩めて回避しない)。
- 「他の change set が存在する」系のエラー: 手動または他ツールが対象スタックに change set を作成している。実行前に AWS 側でその change set の内容を確認し、実行または削除してから cfnsync を再実行する。
- ロック取得失敗: 通常は正しい動作(並行実行の防止)。旧実行が本当に終了しているか確認せずに `force-unlock` しない。
- `deploy` の途中失敗: 同じ設定で再実行してよい。成功済みスタックは変更なしとして自動的にスキップされる。

より詳しいコマンドオプション・GitHub Actions での使い方・手動検証手順はリポジトリの [`README.md`](../../README.md) を参照してください。
