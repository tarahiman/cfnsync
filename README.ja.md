[English](./README.md) | 日本語

# cfnsync

> ディレクトリ内の生の AWS CloudFormation テンプレートをスタックへ同期する CLI。変更を検知し、Change Set の差分表示・実行を行い、依存順にデプロイします。

[![npm version](https://img.shields.io/npm/v/cfnsync.svg)](https://www.npmjs.com/package/cfnsync)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

`cfnsync` は、手書きの CloudFormation で稼働するレガシー製品を運用するチーム向けの、最小限の CLI です。生のテンプレート（YAML / JSON）のディレクトリをスタックへ同期します。テンプレートの追加・変更・削除を検知し、Change Set の作成と差分表示を行い、依存順にスタックを作成・更新・削除します。非対話の CI（特に GitHub Actions）での実行を想定しています。

新しい IaC 抽象化レイヤーでは **ありません**。CDK / SAM 相当のテンプレート生成、Lint、ドリフト修復、複数アカウント一括デプロイ、GUI は対象外です。

## なぜ cfnsync か

- **テンプレートをそのまま** — 生の CloudFormation を対象とし、書き換えや移行は不要です。
- **安全な Change Set** — すべてのデプロイは、実行前に差分を確認できる Change Set を経由します。
- **依存関係を解決** — `Export` / `Fn::ImportValue` と明示的な `dependsOn` から順序を解決し、デプロイ・削除に反映します。
- **CI ファースト** — 非対話で、CI が分岐に使える安定した[終了コード契約](#終了コード)を持ちます。
- **Fail-closed** — 変更系操作は STS で照合するアカウント / リージョンの許可リストを要求し、検証できない状況は続行せず中断します。
- **ロック付きステート** — Terraform 型のステート（`local` / `s3`）に compare-and-swap と CI 向けの分散ロックを備えます。

## 動作要件

- Node.js **24 以上**
- AWS SDK 標準クレデンシャルチェーン経由の AWS 認証（共有プロファイル、環境変数、GitHub Actions OIDC など）。cfnsync 自身はクレデンシャルを保存しません。

## インストール

`npx` でそのまま実行（インストール不要）するか、dev 依存として追加します。

```sh
npx cfnsync --help
# または
npm install --save-dev cfnsync
```

## クイックスタート

1. テンプレートの隣に `cfnsync.yaml` を作成します。

   ```yaml
   version: 1
   allowedAccounts: ["123456789012"]
   allowedRegions: [ap-northeast-1]
   defaultRegion: ap-northeast-1

   stacks:
     network.yaml:
       stackName: prod-network
     app.yaml:
       stackName: prod-app
       dependsOn: [network.yaml]
   ```

2. 変更内容を確認し、差分をレビューしてからデプロイします。

   ```sh
   npx cfnsync status   # added / modified / deleted / unchanged
   npx cfnsync plan     # Change Set を作成し差分を表示（差分ありなら終了コード 2）
   npx cfnsync deploy   # 依存順に実行
   ```

## コマンド

全サブコマンドで共通オプション `--config <path>`（既定 `./cfnsync.yaml`）、`--profile <name>`、`--region <region>`、`--output <text|json>` を使えます。

| コマンド | 説明 |
|---|---|
| `status` | ステートとローカルのテンプレートを比較し、`added` / `modified` / `deleted` / `unchanged` を表示します。 |
| `plan` | Change Set を作成して差分を表示し、実行せず終了します。差分があると終了コードは `2`。 |
| `deploy` | 変更検知・順序解決・Change Set の作成/差分/実行を非対話で行います。 |
| `graph` | Export/Import と `dependsOn` から得たリージョンごとの依存グラフを表示します。 |
| `import` | 既存スタックを設定・テンプレート・ステートへ取り込みます（AWS へは読み取り専用）。 |
| `force-unlock <runId>` | 指定した実行 ID が所有する残存 S3 ステートロックを条件付きで解除します。 |

主な `deploy` フラグ: `--dry-run`（作成と差分表示のみ）、`--allow-delete`（削除対象スタックの実削除を許可。省略時は表示のみ）、`--on-failure <stop|continue>`（既定 `stop`）、`--confirm`（TTY で実行前に確認）。全フラグは `cfnsync <command> --help` を参照してください。

## 設定

`cfnsync.yaml`（既定ではカレントディレクトリ）がすべてを制御します。`allowedAccounts` / `allowedRegions` は変更系操作の fail-closed ガードです。`regions` は省略時 `defaultRegion`、`stackName` は省略時 `stackNamePrefix` + ファイル名から導出されます。`defaultTags` とリージョン別の `regionOverrides` に対応します。

全パラメータのリファレンスは [`docs/config-reference.md`](./docs/config-reference.md)、コメント付きのサンプルは [`docs/examples/cfnsync.sample.yaml`](./docs/examples/cfnsync.sample.yaml) を参照してください。

ステートは既定で `local` バックエンド（設定の隣に `cfnsync.state.json`）です。CI や複数ランナーの構成では `s3` バックエンド（条件付き書き込みロック + compare-and-swap）を使用してください。S3 バケットのバージョニング有効化を推奨します。

## CI での利用（GitHub Actions）

`s3` バックエンドを使用し、ステートを Git へ書き戻さないでください。環境ごとに `concurrency.group` と S3 の state key を分離し、並行トリガーを競合ではなく待機にします。

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

実行ロールには `sts:GetCallerIdentity`、CloudFormation の Change Set / スタック / テンプレート系 Action、（`s3` バックエンド時）state / lock キーへの `s3:GetObject` / `PutObject` / `DeleteObject` が必要です。テンプレートが作成するリソースに応じて追加権限（例: `iam:PassRole`）が必要になる場合があります。詳細は [`docs/config-reference.md`](./docs/config-reference.md) と [`docs/spec/design.md`](./docs/spec/design.md) を参照してください。

### 終了コード

CI はこれらに依存します。

| コード | 意味 |
|---|---|
| `0` | 成功（変更なしを含む） |
| `1` | エラー（検証・ガード・AWS 操作の失敗） |
| `2` | 差分あり（`plan` / `--dry-run` 時のみ） |

## Claude Code プラグイン

cfnsync は [Claude Code](https://claude.com/claude-code) プラグイン（skill）を同梱しています。Claude が cfnsync を安全に操作・解釈するための手引き（サブコマンドの使い分け、終了コードの読み方、fail-closed・ロック・Change Set 所有権の不変条件）です。本リポジトリの marketplace からインストールします。

```
/plugin marketplace add tarahiman/cfnsync
/plugin install cfnsync@cfnsync
```

その後、`cfnsync.yaml` のあるリポジトリで cfnsync の操作を Claude に依頼してください。プラグインマニフェストは [`.claude-plugin/plugin.json`](./.claude-plugin/plugin.json)、skill 本体は [`skills/using-cfnsync/SKILL.md`](./skills/using-cfnsync/SKILL.md) です。

## Codex プラグイン

cfnsync は同じ skill を使った [Codex CLI](https://developers.openai.com/codex/) プラグインも同梱しています。本リポジトリの marketplace からインストールします。

```
codex plugin marketplace add tarahiman/cfnsync
codex plugin add cfnsync@cfnsync
```

その後、`cfnsync.yaml` のあるリポジトリで cfnsync の操作を Codex に依頼してください。プラグインマニフェストは [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json)、marketplace マニフェストは [`.agents/plugins/marketplace.json`](./.agents/plugins/marketplace.json) で、同じ skill を参照しています: [`skills/using-cfnsync/SKILL.md`](./skills/using-cfnsync/SKILL.md)。

## 安全性モデル

いくつかの不変条件は反復的な敵対的レビューから導かれた load-bearing なもので、弱めないでください。

- 変更系操作は fail-closed です。`allowedAccounts` / `allowedRegions` と STS の ID 一致を要求し、ステートは単一の AWS アカウントに束縛されます。
- ステートの一貫性は compare-and-swap（S3 の `If-Match`）が保証し、競合した側の保存を失敗させます。同一スタックへの同時操作は `*_IN_PROGRESS` ガードと CloudFormation 自身の進行中拒否により安全に失敗します。
- 所有権 fencing（各副作用前の再検証）は**ベストエフォート**です。競合窓を狭めますが、CloudFormation API 上で完全には排除できません。IAM でも cfnsync の操作主体を分離してください。
- 管理対象スタックに他主体の Change Set があると実行を停止します（Change Set 実行は他の Change Set を暗黙削除するため）。上書きせず fail-closed で止まります。

cfnsync 管理対象スタックへ、手動または他ツールで Change Set を作成しないでください。詳細な根拠は [`docs/spec/design.md`](./docs/spec/design.md) と [`docs/spec/requirements.md`](./docs/spec/requirements.md) にあります。

## コントリビュート

TypeScript / pnpm / Biome / Vitest で構築し、spec-driven TDD に従っています。[CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。

## ライセンス

[MIT](./LICENSE) © tarahiman
