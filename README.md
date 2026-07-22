# cfnsync

`cfnsync` は、ディレクトリ内の生の AWS CloudFormation テンプレート（YAML / JSON）とスタックを同期する、Node.js 24 以上向けの CLI です。テンプレートとデプロイ入力の追加・変更・削除を検知し、Change Set の作成、差分表示、依存順のデプロイ、既存スタックのインポートを行います。CI/CD、特に GitHub Actions からの非対話実行を想定しています。

## スコープ

対象は、生の CloudFormation テンプレートの変更検知、Change Set によるスタックの作成・更新・削除、Export / `Fn::ImportValue` と明示指定による依存関係の解析、依存順のデプロイです。

テンプレートの生成や抽象化（CDK / SAM 相当）、Lint、ドリフト検出・修復、StackSets 相当の複数アカウント一括デプロイ、GUI は対象外です。

## インストールと実行

Node.js 24 以上が必要です。インストールせずに npm から実行できます。

```sh
npx cfnsync --help
npx cfnsync status
npx cfnsync plan
npx cfnsync deploy
```

AWS 認証には AWS SDK の標準クレデンシャルチェーンを使います。`--profile` または `AWS_PROFILE` で共有設定のプロファイルを選択でき、GitHub Actions の OIDC で設定された一時クレデンシャルも利用できます。cfnsync 自身はクレデンシャルを保存しません。

## 設定

既定ではカレントディレクトリの `cfnsync.yaml` を読み込みます。次は S3 ステートとリージョン別上書きを含む設定例です。

```yaml
version: 1
allowedAccounts: ["123456789012"]
allowedRegions: [ap-northeast-1, us-east-1]
defaultRegion: ap-northeast-1
stackNamePrefix: legacy-app-

defaultTags:
  ManagedBy: cfnsync

state:
  backend: s3
  s3:
    bucket: my-cfnsync-state
    key: prod/cfnsync.state.json
    region: ap-northeast-1

stacks:
  network.yaml:
    stackName: prod-network
    regions: [ap-northeast-1, us-east-1]
    parameters:
      VpcCidr: 10.0.0.0/16
      DbPassword: __REQUIRED__
    tags:
      Project: legacy-app
    capabilities: [CAPABILITY_NAMED_IAM]
    dependsOn: []
    regionOverrides:
      us-east-1:
        parameters:
          VpcCidr: 10.1.0.0/16
```

`allowedAccounts` と `allowedRegions` は変更系操作の fail-closed ガードです。`regions` を省略すると `defaultRegion` が使われ、`stackName` を省略すると `stackNamePrefix` とテンプレートのファイル名から導出されます。`regionOverrides` のパラメータとタグは共通値へ浅くマージされます。`defaultTags` はすべての管理対象スタックへ既定で付与するタグで、実効タグは `defaultTags` < `tags` < `regionOverrides.<region>.tags` の順に浅くマージされます(後勝ち。同名キーの重複はエラーにはならず、より狭いスコープが優先されます)。`NoEcho` パラメータの `__REQUIRED__` は実値に置き換えるまで deploy が拒否されます。

設定ファイルの全パラメータのリファレンスは [`docs/config-reference.md`](./docs/config-reference.md)、コメント付きのサンプル設定ファイルは [`docs/examples/cfnsync.sample.yaml`](./docs/examples/cfnsync.sample.yaml) を参照してください。

`state` を省略した場合は `local` バックエンドとなり、設定ファイルと同じディレクトリに `cfnsync.state.json` を保存します。local 保存は `<state>.lock` の排他作成でプロセス間競合を即時拒否しますが、複数の実行環境（CI ランナー等）から利用する場合は、分散ロックと条件付き書き込みを備えた `s3` バックエンドを使用してください。S3 バケットはバージョニングの有効化を推奨します。

## コマンド

全サブコマンドで次の共通オプションを使用できます。

| オプション | 説明 |
|---|---|
| `--config <path>` | 設定ファイル。既定は `./cfnsync.yaml` |
| `--profile <name>` | AWS profile。未指定時は `AWS_PROFILE` または標準クレデンシャルチェーン |
| `--region <region>` | 既定リージョンを上書き。未指定時は `AWS_REGION`、`AWS_DEFAULT_REGION`、設定値の順 |
| `--output <text\|json>` | 出力形式。既定は `text` |

### `status`

ステートと現在のテンプレートを比較し、`added` / `modified` / `deleted` / `unchanged` を表示します。

```sh
npx cfnsync status --config ./cfnsync.yaml --output json
```

### `plan`

変更セットを作成して差分を表示し、実行せずに終了します。差分がある場合の終了コードは `2` です。

```sh
npx cfnsync plan --profile production
```

### `deploy`

変更検知、依存順序の解決、変更セット作成、差分表示、実行を非対話で行います。

```sh
npx cfnsync deploy --allow-delete --on-failure stop
npx cfnsync deploy --dry-run --output json
npx cfnsync deploy --confirm
```

| オプション | 説明 |
|---|---|
| `--dry-run` | 変更セットの作成と差分表示だけを行う |
| `--allow-delete` | 削除対象スタックの実削除を許可する |
| `--on-failure <stop\|continue>` | 失敗時の動作。既定は `stop` |
| `--confirm` | TTY の場合に実行前の確認を求める |

`--allow-delete` を省略すると削除対象は表示されますが削除されません。削除保護は自動解除されません。

### `graph`

テンプレートの Export / Import と `dependsOn` から、リージョンごとの依存関係グラフを表示します。

```sh
npx cfnsync graph --output json
```

### `import`

既存スタックの設定、テンプレート、ステートを取り込みます。AWS に対しては読み取り専用ですが、ローカル設定・テンプレートとステートを書き換える場合があります。

```sh
npx cfnsync import --reconcile remote --write-template
npx cfnsync import --reconcile local
```

| オプション | 説明 |
|---|---|
| `--reconcile <remote\|local>` | テンプレート差分を実環境またはローカルのどちらで解決するか指定する |
| `--write-template` | 存在しないローカルテンプレートを書き出す |

### `force-unlock <runId>`

S3 に残存したステートロックを読み取り、指定した 16 桁 hex の実行 ID（`runId`）が一致する場合だけ、読み取り時の ETag を `If-Match` に指定して条件付きで解除します。読み取り後にロックが交代していれば解除しません。

```sh
npx cfnsync force-unlock a1b2c3d4e5f60718
```

このコマンドは、ロックを保持していた旧実行が終了していることを確認した後にだけ使用してください。

## 安全性と運用規約

S3 ロックの fencing（各副作用直前の所有権再検証）と、変更セット実行直前の再検査は、check-before-write から実際の副作用までの競合窓を原理的に排除できないベストエフォートです。CloudFormation は fencing token や条件付き Change Set 実行を提供しません。これらの検査は競合窓を最小化する層であり、保証を担う層ではありません。

厳密な保証は多層防御にあります。ステート正本の一貫性は compare-and-swap（S3 では `If-Match`）が保証し、競合した側の保存を失敗させます。同一スタックへの同時操作は、実行直前の `*_IN_PROGRESS` ガードと CloudFormation 自身の進行中操作拒否により、競合した側を安全に失敗させます。

cfnsync の管理対象スタックに、手動または他ツールで変更セットを作成しないでください。他主体の変更セットが存在すると、cfnsync は Change Set 実行による暗黙削除を避けるため fail-closed で停止します。既存の変更セットを適切に実行または削除してから再実行してください。

cfnsync は作成時の変更セット ARN を待機・再検査・実行まで固定し、名前と ARN の差し替えを拒否します。再検査直後の競合窓は CloudFormation API 上なくせないため、IAM でも cfnsync の操作主体を分離してください。

schemaVersion 1 の state は読み込めますが、`dependsOn` 未記録エントリは自動削除を、stack ARN 未記録エントリは自動削除と更新を拒否します。`cfnsync import` で対応関係を再検証して v2 state へ移行してください。

## GitHub Actions

本番環境ごとに同じ `concurrency.group` を使うと、並行トリガーを S3 ロック競合エラーではなく待機にできます。これは運用上の推奨構成です。排他と正本保護は cfnsync の S3 ロックと CAS が担います。

```yaml
name: cfnsync deploy
on:
  push:
    branches: [main]
concurrency:
  group: cfnsync-prod
  cancel-in-progress: false
permissions:
  id-token: write
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/cfnsync-deploy
          aws-region: ap-northeast-1
      - run: npx cfnsync deploy
        working-directory: templates
```

ワークフローでは `s3` バックエンドを使用し、ステートを Git に書き戻さないでください。環境ごとに `concurrency.group` と S3 の state key を分離します。

## IAM 権限

実行する機能に応じ、対象スタックとステート用バケットに次の最小権限を付与してください。

| サービス | Action |
|---|---|
| CloudFormation | `cloudformation:DescribeStacks` |
| CloudFormation | `cloudformation:CreateChangeSet` |
| CloudFormation | `cloudformation:DescribeChangeSet` |
| CloudFormation | `cloudformation:ListChangeSets` |
| CloudFormation | `cloudformation:DeleteChangeSet` |
| CloudFormation | `cloudformation:ExecuteChangeSet` |
| CloudFormation | `cloudformation:DeleteStack` |
| CloudFormation | `cloudformation:DescribeStackEvents` |
| CloudFormation | `cloudformation:GetTemplate` |
| STS | `sts:GetCallerIdentity` |
| S3（`s3` バックエンド時） | `s3:GetObject` |
| S3（`s3` バックエンド時） | `s3:PutObject` |
| S3（`s3` バックエンド時） | `s3:DeleteObject` |

スタックテンプレートが IAM ロールを作成する場合など、CloudFormation がリソースを作成・更新するための権限や `iam:PassRole` はテンプレートと実行方式に応じて別途必要です。権限の `Resource` は対象スタック、変更セット、S3 バケットと state / lock キーへ絞ってください。

## 復旧手順

- デプロイの途中失敗: 同じ設定でそのまま再実行します。成功済みスタックは変更なしとしてスキップされ、CREATE / DELETE 成功後にステート保存だけ失敗した場合も実スタックとの突合で自動収束します。
- ロック残存: ロックを保持していた旧実行（CI ジョブを含む）が終了済みであることを確認してから、`cfnsync force-unlock <実行ID>` を実行し、その後 deploy を再実行します。稼働中の実行に対して解除してはいけません。
- ステート破損: 変更系操作は fail-closed で停止します。local バックエンドは `cfnsync.state.json.bak`（`.bak`）、S3 バックエンドは S3 バージョニングの直前版から復元し、再実行します。

## 実 AWS での手動検証

自動テストの E2E はスコープ外です。隔離した検証用 AWS アカウント、専用 S3 バケット、削除してよいスタック名を使い、次の手順でリリース前に手動検証してください。本番アカウントや既存スタックは使用しないでください。

1. S3 バケットのバージョニングを有効化し、上記の最小 IAM 権限を持つ一時ロールを用意する。`allowedAccounts` と `allowedRegions` を検証先だけに限定した `cfnsync.yaml` と、依存関係を持つ小さなテンプレート 2 個を用意する。
2. `npx cfnsync status` で両方が `added`、`npx cfnsync graph` で依存辺と順序が正しいことを確認する。これらの確認で CloudFormation リソースを変更しないことも確認する。
3. `npx cfnsync plan` を実行し、Change Set の Add / Modify / Remove、置換警告、終了コード `2` を確認する。Change Set は実行されていないことを AWS コンソールまたは CLI で確認する。
4. `npx cfnsync deploy` を実行し、依存されるスタックから順に作成され、イベントが表示され、終了コード `0` になることを確認する。再実行が変更なしで終了することも確認する。
5. テンプレートまたはパラメータを変更して plan と deploy を行い、更新差分、マスク対象値、ステート世代の更新を確認する。
6. 依存する側のテンプレートを設定から除外し、まず `npx cfnsync deploy` では削除対象の表示だけになること、次に `npx cfnsync deploy --allow-delete` で依存の逆順に削除されることを確認する。
7. 同じ S3 state key で deploy を並行起動し、後発がロック取得に失敗して AWS 変更を行わないことを確認する。停止させた実行がロックを残した場合は、旧実行の終了を確認してから表示された実行 ID を `force-unlock` に渡す。
8. テンプレート差分がある既存の検証用スタックを `import` し、未指定では停止すること、`--reconcile remote` と `--reconcile local` の各挙動、`NoEcho` の `__REQUIRED__` 化を確認する。
9. 検証用スタック、未実行 Change Set、S3 state / lock オブジェクトを確認してから削除し、検証環境を片付ける。

手動検証でも fencing と実行直前再検査が競合窓を完全には排除しない点は変わりません。並行シナリオの結果はベストエフォートの検査と CAS / `*_IN_PROGRESS` ガードの各層を区別して評価してください。

## 終了コード

| 終了コード | 意味 |
|---|---|
| `0` | 成功（変更なしを含む） |
| `1` | エラー（検証・ガード・AWS 操作の失敗） |
| `2` | 差分あり（plan / dry-run 時のみ） |

## Claude Code プラグイン

Claude Code から cfnsync を対話的に操作・解釈する際の手引きとして、Claude Code プラグイン（skill）を同梱しています。サブコマンドの使い分け、終了コードの意味、fail-closed・ロック・change set 所有権などの安全性不変条件をまとめてあります。

- プラグインマニフェスト: [`.claude-plugin/plugin.json`](./.claude-plugin/plugin.json)
- skill 本体: [`skills/using-cfnsync/SKILL.md`](./skills/using-cfnsync/SKILL.md)

`cfnsync.yaml` の書き方自体は skill 側では重複説明せず、上記の [`docs/config-reference.md`](./docs/config-reference.md) と [`docs/examples/cfnsync.sample.yaml`](./docs/examples/cfnsync.sample.yaml) を参照する構成になっています。

今後のリリース強化課題として、配布物の SBOM と provenance の生成・検証を追加します。
