# `cfnsync.yaml` 設定リファレンス

`cfnsync` の設定ファイル(既定では実行ディレクトリの `cfnsync.yaml`)のパラメータ一覧です。実装は `src/core/config.ts`(zod スキーマ)、`src/core/dependency.ts`(`dependsOn` の解決)、`src/core/templatePath.ts`(テンプレートパスの安全性検証)にあり、本書はそれらに基づく人間向けリファレンスです。サンプルは [`examples/cfnsync.sample.yaml`](./examples/cfnsync.sample.yaml) を参照してください。

## トップレベル

| キー | 型 | 必須/任意 | 既定値 | 備考 |
|---|---|---|---|---|
| `version` | `1`(リテラル) | 必須 | - | 現状 `1` 固定。将来のスキーマ変更に備えたバージョンタグ |
| `allowedAccounts` | `string[]` | 任意(**変更系操作は事実上必須**) | なし | STS `GetCallerIdentity` で解決した接続先アカウント ID と照合する。未設定または空配列の場合、`deploy`/`import` 等の変更系操作は fail-closed で拒否される |
| `allowedRegions` | `string[]` | 任意(**変更系操作は事実上必須**) | なし | 実行計画中の全対象リージョンがこの集合に含まれるか照合する。未設定または対象リージョンが集合外の場合は拒否される |
| `defaultRegion` | `string` | 必須 | - | `stacks.<templatePath>.regions` を省略したスタックのデプロイ先リージョン |
| `stackNamePrefix` | `string` | 任意 | なし(空文字相当) | `stackName` を省略したスタックの名前接頭辞 |
| `defaultTags` | `Record<string, string \| number \| boolean>` | 任意 | `{}` | すべての管理対象スタックへ既定で付与するタグ。値の扱いは `stacks.<templatePath>.tags` と同様に文字列へ正規化される。実効タグへのマージ順は `defaultTags` < `tags` < `regionOverrides.<region>.tags`(後勝ち)で、同名キーの重複は設定エラーにならず、より狭いスコープの値が優先される。`defaultTags` の変更はそれを付与される全スタックの変更検知(`inputsHash`)に反映され、`modified` として検知される |
| `state` | object | 任意 | `{ backend: local }` | ステートバックエンドの設定。詳細は下記「`state`」参照 |
| `stacks` | `Record<templatePath, entry>` | 必須 | - | キーは設定ファイルのあるディレクトリからの相対パス。値は下記「`stacks.<templatePath>` エントリ」参照 |

## `state`

`backend` で判別する discriminated union です。

- `backend: local`(既定) — 追加フィールドなし。設定ファイルと同じディレクトリに `cfnsync.state.json` を保存する。単一プロセス・単一ホストでの利用を想定
- `backend: s3` — 以下がすべて必須:

  | キー | 型 | 備考 |
  |---|---|---|
  | `s3.bucket` | `string`(1文字以上) | ステートを保存する S3 バケット |
  | `s3.key` | `string`(1文字以上) | オブジェクトキー |
  | `s3.region` | `string`(1文字以上) | バケットのリージョン |

  CI など複数の実行環境から共有する場合は `s3` バックエンドを使用してください。S3 の条件付き書き込み(ETag/`If-Match`)による CAS とロックにより、並行実行時の競合を検出します。

## `stacks.<templatePath>` エントリ

`templatePath` は設定ファイルのディレクトリを基準とした相対パスで、1 テンプレート = 1 エントリです(制約は後述)。

| キー | 型 | 必須/任意 | 既定値 | 備考 |
|---|---|---|---|---|
| `stackName` | `string`(1文字以上) | 任意 | ファイル名から拡張子(`.yaml`/`.yml`/`.json`、大小文字無視)を除いたもの + `stackNamePrefix` | |
| `regions` | `string[]` | 任意 | `[defaultRegion]` | **記載順が実行順の正本**。同一テンプレートを複数リージョンへ展開する場合に使う |
| `parameters` | `Record<string, string \| number \| boolean>` | 任意 | `{}` | CloudFormation スタックパラメータ。値は文字列へ変換される(数値・真偽値をそのまま書ける)。`NoEcho` パラメータなど値を未確定のままコミットしたい場合は `__REQUIRED__` を書く(実値に置き換えるまで `deploy` が拒否する) |
| `tags` | `Record<string, string \| number \| boolean>` | 任意 | `{}` | スタックタグ。値の扱いは `parameters` と同様。トップレベルの `defaultTags` と同名キーがある場合はこちらの値が優先される(`defaultTags` < `tags`) |
| `capabilities` | `('CAPABILITY_IAM' \| 'CAPABILITY_NAMED_IAM' \| 'CAPABILITY_AUTO_EXPAND')[]` | 任意 | `[]` | CloudFormation が受理する値の閉集合。IAM リソースや Macro/Transform を含むテンプレートで必要 |
| `dependsOn` | `string[]` | 任意 | `[]` | 明示的な依存関係。要素は `templatePath` または `templatePath@region` の形式で書けるが、**`@` 以降は実装上無視され、依存元と常に同一リージョンのスタックへ解決される**。自己参照、および `stacks` に存在しないテンプレートパスへの参照は設定検証エラーになる |
| `regionOverrides` | `Record<region, { parameters, tags }>` | 任意 | `{}` | 対象リージョンの `parameters`/`tags` を共通値へ**浅くマージ**する(同名キーのみ上書き、他のキーは共通値を維持)。`capabilities`/`dependsOn`/`stackName`/`regions` はリージョン単位で上書きできない。`regionOverrides.<region>.tags` はタグの実効値マージにおいて最も優先度が高い(`defaultTags` < `tags` < `regionOverrides.<region>.tags`) |

### テンプレートパスの制約

`templatePath` は設定ファイルのディレクトリを基準とした相対パスのみ許可されます。以下は検証時に `ConfigError` として拒否されます:

- 絶対パス(`/...` または `C:/...` のようなドライブレター付きパス)
- NUL 文字を含むパス
- 正規化後に親ディレクトリを脱出するもの(`../` の連続などで基準ディレクトリの外に出るもの)
- 正規化後に空文字列になるもの(例: `.` や空文字)

これらはコンパイル時ではなく `cfnsync` 実行時にエラーとして検出されます。加えて、シンボリックリンクを経由したディレクトリ脱出は CLI 側のファイルシステム adapter が realpath 検証で別途拒否します(こちらは `src/core/` の純粋ロジックの範囲外)。

## 依存関係解決の注意点

- 暗黙の依存関係(テンプレート内の `Export`/`Fn::ImportValue`)と、この `dependsOn` による明示的な依存関係は、実行時にマージされて依存グラフが構築されます。デプロイは依存先→依存元の順(トポロジカル順)、削除は逆順で実行されます
- `dependsOn` はリージョンをまたげません。マルチリージョンでテンプレート間の依存を表現したい場合も、依存先エントリの `regions` に同じリージョンを含めておく必要があります
