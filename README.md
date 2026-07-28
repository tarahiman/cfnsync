日本語 | [English](./README.en.md)

# cfnsync

> ディレクトリ内の生の AWS CloudFormation テンプレートをスタックへ同期する CLI。変更を検知し、Change Set の差分表示・実行を行い、依存順にデプロイします。

[![npm version](https://img.shields.io/npm/v/@tarahi/cfnsync.svg)](https://www.npmjs.com/package/@tarahi/cfnsync)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

`cfnsync` は、手書きの CloudFormation で稼働するレガシー製品を運用するチーム向けの、最小限の CLI です。生のテンプレート（YAML / JSON）のディレクトリをスタックへ同期します。テンプレートの追加・変更・削除を検知し、Change Set の作成と差分表示を行い、依存順にスタックを作成・更新・削除します。非対話の CI（特に GitHub Actions）での実行を想定しています。

新しい IaC 抽象化レイヤーでは **ありません**。CDK / SAM 相当のテンプレート生成、Lint、ドリフト修復、複数アカウント一括デプロイ、GUI は対象外です。

## なぜ cfnsync か

- **テンプレートをそのまま** — 生の CloudFormation を対象とし、書き換えや移行は不要です。
- **設定値まで確認できる安全な Change Set** — すべてのデプロイは Change Set を経由し、CloudFormation が返すプロパティの変更前後値を実行前に確認できます。`deploy` は全差分を提示してから 1 回の承認を求め、承認後にだけ実行します（`terraform apply` 相当）。
- **依存関係を解決** — `Export` / `Fn::ImportValue` と明示的な `dependsOn` から順序を解決し、デプロイ・削除に反映します。
- **CI ファースト** — 非対話で、CI が分岐に使える安定した[終了コード契約](#終了コード)を持ちます。
- **Fail-closed** — 変更系操作は STS で照合するアカウント / リージョンの許可リストを要求し、検証できない状況は続行せず中断します。
- **ロック付きステート** — Terraform 型のステート（`local` / `s3`）に compare-and-swap と CI 向けの分散ロックを備えます。

## 動作要件

- Node.js **24 以上**
- AWS SDK 標準クレデンシャルチェーン経由の AWS 認証（共有プロファイル、環境変数、GitHub Actions OIDC など）。cfnsync 自身はクレデンシャルを保存しません。

## インストール

使用するパッケージマネージャーに合わせて、グローバルにインストールします。

```sh
npm install --global @tarahi/cfnsync
# または pnpm の場合
pnpm add --global @tarahi/cfnsync
```

npm 上のパッケージ名はスコープ付きの `@tarahi/cfnsync` ですが、インストール後のコマンド名は `cfnsync` です。

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
   cfnsync status   # added / modified / deleted / unchanged
   cfnsync plan     # Change Set を作成し差分を表示（差分ありなら終了コード 2）
   cfnsync deploy   # 全差分を表示し、1 回の承認を経て依存順に実行
   ```

## コマンド

全サブコマンドで共通オプション `--config <path>`（既定 `./cfnsync.yaml`）、`--profile <name>`、`--region <region>`、`--output <text|json>` を使えます。

| コマンド | 説明 |
|---|---|
| `status` | ステートとローカルのテンプレートを比較し、`added` / `modified` / `deleted` / `unchanged` を表示します。 |
| `plan` | Change Set を作成して差分を表示し、実行せず終了します。差分があると終了コードは `2`。 |
| `deploy` | 変更検知・順序解決を行い、全対象の Change Set を作成して差分を表示し、1 回の承認を経て依存順に実行します。CI では `--auto-approve` が必須です。 |
| `graph` | Export/Import と `dependsOn` から得たリージョンごとの依存グラフを表示します。 |
| `import` | 既存スタックを設定・テンプレート・ステートへ取り込みます（AWS へは読み取り専用）。 |
| `force-unlock <runId>` | 指定した実行 ID が所有する残存 S3 ステートロックを条件付きで解除します。 |

`plan` / `deploy` の人間向け差分は、CI やリダイレクトを含めて既定で ANSI 色付きです。Add は緑、Modify は黄、Remove は赤、置換は太字の赤で表示します。色を無効にするには `--no-color` を指定するか、`NO_COLOR` 環境変数を設定してください（空文字も設定済みとして扱います）。JSON 出力は常に無色です。

主な `deploy` フラグ: `--dry-run`（作成と差分表示のみ）、`--auto-approve` / `-y`（承認プロンプトを省略してそのまま実行。**CI では必須**）、`--allow-delete`（削除対象スタックの実削除を許可。省略時は表示のみ）、`--on-failure <stop|continue>`（既定 `stop`。**実行段階の失敗にのみ適用**）、`--no-color`（ANSI 差分色を無効化。`plan` でも使用可）。全フラグは `cfnsync <command> --help` を参照してください。

### `deploy` の承認フロー

`deploy` は既定で「全差分の確定 → 1 回の承認 → 一括実行」で動作します。

1. **計画段階** — 実行対象すべてについて Change Set を作成し、差分を確定します。この段階では `ExecuteChangeSet` も `DeleteStack` も行いません。
2. **承認** — 接続先（アカウント・リージョン）と全差分の要約を標準エラーへ表示し、**実行全体で 1 回だけ** `Do you want to perform these actions? [y/N]` と尋ねます。`y` / `yes` 以外はすべて拒否です。
3. **実行段階** — 承認された場合にだけ、依存順に Change Set を実行します。

実行予定が 0 件（全対象が変更なし）の場合は承認を求めません。承認を拒否した場合は、計画段階で作成した Change Set をすべて削除し、未実行のスタックを `skipped` として報告して終了コード `0` で終了します。

計画段階で 1 件でも失敗した場合は、承認を求めずに実行全体を中断します（終了コード `1`）。`--on-failure continue` は**実行段階の失敗にのみ**適用され、計画段階の失敗には効きません。

`--auto-approve`（`-y`）を指定すると承認を求めずに実行します。**TTY のない環境（CI など）では必須**で、指定せずに `deploy` を実行すると AWS へ一切アクセスせずエラー（終了コード `1`）になります。**変更が 1 件もない実行でも同じくエラー**になります（TTY の判定を変更検知より前に行うためです）。`deploy --dry-run` と `plan` は承認を求めないため対象外です。

#### 承認フローの運用上の注意

- **承認待ちの間、ステートロックを保持し続けます。** `s3` バックエンドでは、その間ほかの実行はブロックされます。つまりロックの保持時間が実行時間ではなく人間の応答時間に依存します（承認待ちのタイムアウトはありません）。対話的な承認を伴う運用ではこの点に注意してください。
- **承認時点の差分と、実行時点の実状態が一致することは保証しません。** Change Set は作成時点のスナップショットであり、承認待ちの間に他の主体がスタックを変更しうるためです。防御は実行直前の再検査（自 Change Set の name / ARN 一致と他主体の Change Set 不在、`stackId` の再照合、スタック状態の allowlist 検査、ロック所有権の再検証）に限られます。これらは競合窓を狭めますが排除はせず、cfnsync はそれ以上の保証を主張しません。
- **この実行で新規作成される Export を参照するプロパティは、承認時点で最終値が確定しません。** `Fn::ImportValue` は Change Set の作成時に解決されず、`{{changeSet:KNOWN_AFTER_APPLY}}` として保留されます（既に存在する Export を参照する場合は作成時に実値へ解決されます）。cfnsync はこの保留値をそのまま提示し、独自に解決・補完しません。terraform の "known after apply" と同じ性質です。

## 設定

`cfnsync.yaml`（既定ではカレントディレクトリ）がすべてを制御します。`allowedAccounts` / `allowedRegions` は変更系操作の fail-closed ガードです。`regions` は省略時 `defaultRegion`、`stackName` は省略時 `stackNamePrefix` + ファイル名から導出されます。`defaultTags` とリージョン別の `regionOverrides` に対応します。

全パラメータのリファレンスは [`docs/config-reference.md`](./docs/config-reference.md)、コメント付きのサンプルは [`docs/examples/cfnsync.sample.yaml`](./docs/examples/cfnsync.sample.yaml) を参照してください。

ステートは既定で `local` バックエンド（設定の隣に `cfnsync.state.json`）です。CI や複数ランナーの構成では `s3` バックエンド（条件付き書き込みロック + compare-and-swap）を使用してください。S3 バケットのバージョニング有効化を推奨します。

## CI での利用（GitHub Actions）

`s3` バックエンドを使用し、ステートを Git へ書き戻さないでください。環境ごとに `concurrency.group` と S3 の state key を分離し、並行トリガーを競合ではなく待機にします。CI には TTY がないため、`deploy` には **`--auto-approve` が必須**です（指定しないと承認できないままエラーで停止します）。

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
      - run: npx @tarahi/cfnsync deploy --auto-approve --no-color
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

## 変更履歴

破壊的変更と移行手順を含む全リリースの履歴は [CHANGELOG.md](./CHANGELOG.md) にあります。`deploy` の既定挙動を承認フローへ変更した際の破壊的変更（`--confirm` の廃止、非 TTY での `--auto-approve` 必須化、承認拒否時の JSON 契約、`--on-failure` の適用範囲、CREATE 復旧の fail-closed 化）は、**アップグレード前に必ず確認してください**。

## コントリビュート

TypeScript / pnpm / Biome / Vitest で構築し、spec-driven TDD に従っています。[CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。

## ライセンス

[MIT](./LICENSE) © tarahiman
