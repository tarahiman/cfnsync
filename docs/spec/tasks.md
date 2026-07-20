# cfnsync 実装タスク分解(TDD)

対応する仕様: [requirements.md](./requirements.md) / [design.md](./design.md)

## 1. 進め方

- **red → green → refactor**。各タスクはまず対応表のテストを書き、失敗を確認してから実装する。
- **受け入れ基準 ID の規約**: `FR-X-n` = requirements.md の FR-X 内の箇条書きの出現順 n 番目。requirements.md 側は変更しない(tasks.md がこの採番の正本)。
- 各タスクの表が design.md §10 の「受け入れ基準 → テストケース対応表」の実体である。**1 受け入れ基準 = 1 行以上**。仕様の変更が生じた場合は requirements.md / design.md を先に更新し、この表を追随させる。
- テストは実 AWS に接続しない(§10): `core/` は純粋単体テスト、`aws/` / `backend/` は `aws-sdk-client-mock` とテンポラリファイル、`usecase/` はゲートウェイをインメモリフェイクに差し替えたシナリオテスト。
- タスクの完了条件: 対応表のテストがすべて green、かつ既存テスト全体(`vitest run`)が green。
- 種別 `ドキュメント` の基準はテストではなく M5 の成果物(README 等)で満たす。§9 にドキュメント側の一覧をまとめる。

## 2. マイルストーン

| MS | 内容 | タスク | 主な要件 |
|---|---|---|---|
| M0 | スキャフォールド | T-01 | NFR-2, NFR-6 |
| M1 | core(純粋ロジック) | T-02〜T-07 | FR-1, FR-8, FR-9, FR-11, FR-13 |
| M2 | ports + アダプタ(aws / backend)+ report | T-08〜T-11 | FR-1, FR-2, FR-3, NFR-3, NFR-4 |
| M3 | usecase(guard / executor / importer) | T-12〜T-18 | FR-2, FR-4〜FR-7, FR-10 |
| M4 | cli | T-19 | FR-12, NFR-1 |
| M5 | ドキュメント・パッケージング | T-20〜T-21 | FR-1-5, NFR-4, §11 |

依存方向(`cli → usecase → core / ports / report`、`aws` / `backend` は `ports` を実装)に従い、**usecase が依存する契約(ports / report)を usecase より先に固定する**。M0 → M5 の順、ミルストーン内も記載順を推奨する(後続タスクが前のタスクの型・fixture を使う)。

## 3. M0: スキャフォールド

### T-01 プロジェクト初期化

成果物: `package.json`(Node.js 20+, npm)、`tsconfig.json`、vitest 設定、design.md §10 のディレクトリ骨格、プレースホルダテスト。

- 依存パッケージ: `commander` / `yaml` / `zod` / `@aws-sdk/client-cloudformation` / `@aws-sdk/client-sts` / `@aws-sdk/client-s3`、dev: `vitest` / `aws-sdk-client-mock` / `typescript`。
- 完了条件: `vitest run` が green。`npm run build`(tsc)が通る。

## 4. M1: core(純粋ロジック)

### T-02 core/config — 設定ファイルの読込と検証

成果物: `src/core/config.ts`, `test/core/config.test.ts`, `test/fixtures/config/*`

| ID | 受け入れ基準(要約) | テストケース |
|---|---|---|
| FR-11-1 | テンプレートごとにスタック名・リージョン・パラメータ・タグ・Capabilities・明示依存・リージョン別上書きを設定できる | 全項目を含む cfnsync.yaml が zod 検証を通過し、型付きの設定オブジェクトになる |
| FR-11-2 | ステートバックエンド(`local` / `s3`)を設定できる | `state` 省略時は `local`、`backend: s3` 時は bucket/key/region が必須で欠落はエラー |
| FR-11-3 | スタック名未設定時の導出規約 | `stackName` 省略時に `stackNamePrefix + ファイル名(拡張子除去)` が導出される |
| FR-11-4 | コミット可能なテキスト形式 | (構造的に満足: YAML 採用。テスト対象外) |
| FR-11-5 | 設定不備は実行前検証で具体的エラー | 存在しないテンプレートへの参照 / 必須項目欠落 / 不正な型 → 対象キーを含む `ConfigError` |
| FR-13-1 | テンプレートごとに複数リージョンを指定できる。未指定は既定リージョン 1 つ | `regions` 指定が保持される / 省略時 `[defaultRegion]` になる |
| FR-13-3 | パラメータ・タグの共通値+リージョン別上書き | `regionOverrides` の浅いマージで実効パラメータ・タグが決まる(上書きなしリージョンは共通値のみ) |
| FR-7-5(前半) | 許可アカウント・許可リージョンを設定ファイルで指定する | `allowedAccounts` / `allowedRegions` がスキーマに存在し読み取れる(検証の実施は T-12) |
| §8.2 | `__REQUIRED__` プレースホルダ残存の検出 | プレースホルダが残るスタックを検証関数が検出し、対象パラメータ名を報告する(deploy での拒否は T-14) |

### T-03 core/template — テンプレート解析

成果物: `src/core/template.ts`, `test/core/template.test.ts`, `test/fixtures/templates/*`

| ID | 受け入れ基準(要約) | テストケース |
|---|---|---|
| FR-8-1(解析) | `Export`(Outputs)と `Fn::ImportValue` を解析する | YAML 短縮タグ(`!ImportValue` / `!Sub` / `!Ref` / `!GetAtt`)入りテンプレートから import / export 名を抽出する。JSON テンプレートも同結果 |
| §6 | 静的 Export 名と解決可能な `Fn::Sub`(`${AWS::StackName}` 等)は解決して export とする | `!Sub "${AWS::StackName}-VpcId"` がスタック名で解決される |
| §6 | 解決不能な動的合成は警告 | 動的パラメータを含む `Fn::Sub` の Export → export 扱いせず警告を返す |
| NFR-4(準備) | NoEcho パラメータの抽出 | `Parameters` から `NoEcho: true` のキー一覧を抽出する(マスク適用は T-11) |

### T-04 core/state — ステートのスキーマと世代管理(純粋ロジック)

成果物: `src/core/state.ts`, `test/core/state.test.ts`

ファイル・S3 への読み書きは `StateBackend`(ports、実装は T-10)が担う。ここはスキーマと判定ロジックのみ。

| ID | 受け入れ基準(要約) | テストケース |
|---|---|---|
| §4.3 | ステートスキーマ(schemaVersion / accountId / generation / stacks) | zod スキーマが正しい形を受理し、必須項目欠落を拒否する |
| FR-1-6(判定) | 世代情報を持ち、保存時に読込時点からの変更を検証 | 保存ペイロード生成で generation がインクリメントされる / 読込時世代と現在世代の不一致を `StateConflictError` と判定する(条件付き書き込みの実施は T-10) |
| FR-1-12(検出) | 破損検出時は変更系操作を拒否(fail-closed) | 不完全 JSON・スキーマ不一致の内容 → fail-closed エラー判定(原子的書き込みは T-10) |
| FR-1-13(前半) | ステートは単一アカウントに紐付く | 照合ロジックが一致 / 不一致 / 未記録(初回)を判別する(実行時の拒否は T-12) |
| FR-1-15 | ステート未存在(初回)は全テンプレート `added` 扱いまたは初期同期を案内 | ステートなし → 空ステート+「初回」フラグが返り、detect が全件 `added` にする(T-05 と結合) |
| FR-8-5(記録) | 成功時に依存辺(exports / imports)をステートへ保存 | スタックエントリ更新で `exports` / `imports` が記録される(保存タイミングは T-14) |

### T-05 core/detect — 変更分類

成果物: `src/core/detect.ts`, `test/core/detect.test.ts`

| ID | 受け入れ基準(要約) | テストケース |
|---|---|---|
| FR-1-1 | ステートと現在のファイル群を比較し `added` / `modified` / `deleted` / `unchanged` に分類 | §4.4 の 4 分類がそれぞれ判定される |
| FR-1-2 | 比較はコンテンツハッシュ。タイムスタンプのみの変更は変更なし | 同一内容で mtime のみ異なる → `unchanged` |
| §4.3 | `inputsHash` は テンプレート+スタック名+実効パラメータ+タグ+Capabilities+dependsOn の複合 | 各構成要素を 1 つずつ変えると `modified` になる(6 ケース)。設定ファイルのみの変更も検知される |
| FR-1-14 | スタック名変更 = 旧名の削除 + 新名の新規作成 | スタック名を変更 → 同一スタックキーに対し `deleted`(旧名)+`added`(新名)の対が計画される |
| FR-1-15 | 初回はすべて `added` | 空ステート → 全スタックキーが `added` |
| FR-13-2 | (テンプレート × リージョン)単位で管理 | 2 リージョン設定のテンプレート変更 → 両リージョンのスタックキーが独立に `modified`(全リージョンへの変更セット作成の統合検証は T-14 の FR-13-4) |
| FR-13-5 | リージョン追加 → `added`、リージョン削除 → 削除対象 | `regions` への追加 → 当該キーのみ `added` / 除外 → 当該キーのみ `deleted` |

### T-06 core/graph — 依存グラフ

成果物: `src/core/graph.ts`, `test/core/graph.test.ts`

| ID | 受け入れ基準(要約) | テストケース |
|---|---|---|
| FR-8-1(構築) | Export / ImportValue からスタック間依存グラフを構築 | export 名 → 提供スタックキーの索引から辺が張られる |
| FR-8-2 | 設定ファイルの明示依存(`dependsOn`)を宣言できる | 明示依存が自動解析結果とマージされる |
| FR-8-4 | 循環はスタックを明示してエラー | A→B→C→A → `DependencyCycleError` に循環メンバー全員が列挙される |
| FR-9-1(順序) | 依存されるスタックが先 | Kahn 法トポロジカルソートの順序検証(決定的順序) |
| FR-6-4(統合) | 削除順は新旧グラフの統合から決定 | ファイル削除済みスタックの旧依存辺(ステートの exports / imports)が統合され、逆順が正しく出る |
| FR-13-6 | グラフはリージョンごとに独立 | 別リージョンの同名 Export が辺を張らない。リージョンごとに独立したグラフが返る |

### T-07 core/plan — 実行計画

成果物: `src/core/plan.ts`, `test/core/plan.test.ts`

| ID | 受け入れ基準(要約) | テストケース |
|---|---|---|
| FR-9-1 | 複数スタックは依存順にデプロイ | 分類+グラフ → 作成・更新はトポロジカル順、削除は統合グラフの逆順に並ぶ |
| FR-9-2(判定) | 失敗時: 依存する後続は中止、独立スタックは `stop` / `continue` を選択 | 失敗スタックを与えると、依存下流のみがスキップ対象になる / `stop` では独立スタックも中止、`continue` では継続対象になる(純粋な判定ロジック。実行時挙動は T-14) |
| FR-9-3 | 初期リリースは直列(並列化を妨げない構造) | 計画は順序付き列として出力される(構造の確認のみ) |
| FR-13-6(順序) | リージョン間は設定順の直列 | 2 リージョン計画で region の出現順が設定順になる |

## 5. M2: ports + アダプタ + report

usecase(M3)が依存する契約と実装をここで固定する。

### T-08 ports 定義 + aws/CloudFormationGateway

成果物: `src/ports/index.ts`(`CloudFormationGateway` / `StsGateway` / `StateBackend`), `src/aws/cloudformation.ts`, `test/aws/cloudformation.test.ts`(aws-sdk-client-mock)

| ID | 受け入れ基準(要約) | テストケース |
|---|---|---|
| NFR-2 | AWS API・ステート保存はインターフェースとして抽象化 | ports の 3 インターフェースに対し実装が適合する(型テスト+実装テスト)。`StateBackend` の所有は ports に一本化(core は判定のみ: T-04) |
| FR-2(基盤) | 変更セットの作成・記述・削除・実行の SDK 呼び出し | CreateChangeSet / DescribeChangeSet / DeleteChangeSet / ExecuteChangeSet のパラメータマッピング検証 |
| §7(Codex 承認条件) | **ListChangeSets は全ページを走査する** | NextToken 付き 2 ページ応答をスタブし、全変更セットが列挙されることを検証 |
| §7 | スタック状態の取得 | DescribeStacks のステータス取得 / スタック不存在(ValidationError)→「スタックなし」判定 |
| FR-4-1(基盤) | スタックイベントの取得 | DescribeStackEvents のページング・新着イベントの差分取得 |
| §7(復旧基盤) | `GetTemplate`(`Original` ステージ)取得 | CREATE 復旧比較用のテンプレート取得を検証 |
| NFR-3(リトライ) | スロットリングにリトライ(指数バックオフ) | SDK クライアントが adaptive retry mode で構成されている / Throttling 応答後の再試行で成功する |

### T-09 aws/StsGateway

成果物: `src/aws/sts.ts`, `test/aws/sts.test.ts`

| ID | 受け入れ基準(要約) | テストケース |
|---|---|---|
| FR-7-6(基盤) | STS `GetCallerIdentity` で接続先アカウントを解決 | アカウント ID が返る / 解決失敗(認証エラー)は例外として伝播する |

FR-7-1 / FR-7-2 / FR-7-3(プロファイル・クレデンシャルチェーン・リージョン指定)は SDK の標準機構をそのまま使う。テストはクライアント生成時に profile / region オプションが渡ることの確認に留め、チェーン自体の動作は SDK に委ねる。FR-7-4(クレデンシャルを保存しない)は構造的要件としてコードレビューで担保する(独自の保存コードを持たない)。

### T-10 ステートバックエンド実装 — backend/local + aws/s3

成果物: `src/backend/local.ts`, `src/aws/s3state.ts`, `test/backend/local.test.ts`(テンポラリディレクトリ), `test/aws/s3state.test.ts`(aws-sdk-client-mock)

| ID | 受け入れ基準(要約) | テストケース |
|---|---|---|
| FR-1-4 | バックエンドとして `local` / `s3` を選択できる | 設定に応じて対応する `StateBackend` 実装が選択される |
| FR-1-5 | `local` は単一環境用と明記 | (ドキュメント: T-20) |
| FR-1-6(local) | CAS: 読み込み時点から変更されていないことを検証し、競合は上書きせずエラー | 保存直前の再読込で世代不一致 → `StateConflictError`、ファイルは書き換わらない |
| FR-1-6(s3) | S3 条件付き書き込みで CAS | `PutObject If-Match: <読込時 ETag>` で保存 / `PreconditionFailed` → `StateConflictError`、上書きされない |
| FR-1-12(local) | 原子的保存 | 一時ファイル+fsync+rename で置換され `.bak` が残る / 書き込み途中で中断しても元ファイルが無傷 |
| FR-1-7 | ロック取得。取得失敗は変更なしで即エラー。終了時解放 | `<key>.lock` を `If-None-Match: *` で作成 / 既存ロックあり(PreconditionFailed)→ ロックエラー、他の書き込みが発生しない / 正常・異常終了の双方で解放が呼ばれる |
| FR-1-8 | ロック解放は自身のロックであることの条件付き操作 | `DeleteObject If-Match: <取得時 ETag>` で解放 / 条件不成立(所有者交代)→ 削除せず、その事実を報告する |
| FR-1-10(内容) | ロックに実行 ID・開始時刻・実行者を記録 | ロックオブジェクトの内容検証(force-unlock での表示は T-17) |
| FR-1-9(基盤) | fencing 用のロック再読込・所有権検証 | ロック再読込で実行 ID・ETag が自分と一致 → 続行 / 不一致・消失 → 所有権喪失を返す(副作用直前の配置は T-14〜T-16) |

### T-11 report — 差分表示・出力

成果物: `src/report/*.ts`, `test/report/report.test.ts`

usecase が依存する出力契約(構造化された差分・イベント・接続先情報の型)をここで確定する(依存方向 `usecase → report` の遵守)。

| ID | 受け入れ基準(要約) | テストケース |
|---|---|---|
| FR-3-1 | リソース単位の Add / Modify / Remove と変更プロパティを表示 | DescribeChangeSet の Changes から種別・プロパティ一覧が整形される |
| FR-3-2 | Replacement は警告として強調 | `Replacement: True` のリソースが警告表示になる(テキスト・JSON 双方にフラグ) |
| FR-3-3 | テキストに加え JSON を選択できる | `--output json` で機械可読 JSON(スキーマ検証)が出る |
| NFR-4 | NoEcho 値をマスク | 差分・ログ・JSON のすべてで NoEcho パラメータ値が `****` になる(実値がどの出力にも現れない) |
| FR-13-7 | 出力に対象リージョンを明示 | 差分・ログ・JSON にスタックキー(リージョン込み)が含まれる |
| FR-8-3 | 依存マッピングをテキストツリー / JSON で出力 | graph のツリー表示と JSON 表示 |
| FR-7-8(出力) | 接続先を出力の先頭に含める | レポート先頭にアカウント ID・リージョン |

## 6. M3: usecase

### T-12 usecase/guard — AccountGuard

成果物: `src/usecase/guard.ts`, `test/usecase/guard.test.ts`(インメモリフェイク)

| ID | 受け入れ基準(要約) | テストケース |
|---|---|---|
| FR-7-5 | 許可設定はすべての変更系操作の前提 | `allowedAccounts` / `allowedRegions` 未設定で変更系操作 → 変更セット作成前に `GuardError`(fail-closed) |
| FR-7-6 | STS で解決し照合。未設定・不一致・解決不能はすべて拒否 | 不一致アカウント → 拒否 / STS 解決失敗 → 拒否。いずれも AWS への変更呼び出しゼロ |
| FR-1-13 | ステートのアカウント ID と接続先の一致を検証 | ロック取得後に再読込したステートの `accountId` 不一致 → 実行拒否 / 初回(未記録)→ 解決したアカウント ID が同一ロック区間の CAS 保存で記録される |
| FR-13-8 | 対象リージョンは許可リージョンに含まれる | 計画中に `allowedRegions` 外のリージョン → fail-closed エラー |
| FR-7-7 | 読み取り専用操作は許可設定なしで実行可。接続先を出力 | status / graph は許可設定なしで動作(AWS 呼び出し自体なし: NFR-5)/ import は許可設定なしで動作するがアカウント照合+ロックは必須(T-16) |
| FR-7-8 | 解決した接続先をログ・JSON に含める(秘匿情報は含めない) | 出力の先頭にアカウント ID・リージョンが含まれ、クレデンシャル文字列が含まれない |

### T-13 usecase/executor — 変更セットライフサイクル

成果物: `src/usecase/executor.ts`, `test/usecase/executor.test.ts`

| ID | 受け入れ基準(要約) | テストケース |
|---|---|---|
| FR-2-1 | `modified` → `UPDATE` 型変更セット | 既存スタックへの変更で `ChangeSetType: UPDATE` |
| FR-2-2 | `added` → `CREATE` 型変更セット | スタック不存在で `ChangeSetType: CREATE` |
| FR-2-3 | 空変更セットは「変更なし」としてスキップ | Status `FAILED` + StatusReason が `didn't contain changes` / `No updates are to be performed` → エラーにせず変更セット削除+変更なし扱い。それ以外の FAILED は通常エラー |
| FR-2-4 | デプロイ不能ステータスは対処方法つきエラー | `ROLLBACK_COMPLETE` → `StackStateError`(スタック削除の必要性を含むメッセージ) |
| FR-2-5 | Capability を指定できる | 設定の `capabilities` が CreateChangeSet に渡る |
| FR-2-6 | ツール由来と実行単位を識別できる命名 | 変更セット名が `cfnsync-<ステートID>-<実行ID>-<UTCタイムスタンプ>` 形式。ステート ID はバックエンド識別子の短縮ハッシュ |
| FR-2-7 | 残存変更セットは所有権を検証して回収。他者のものは触れず中断 | 自ステート ID の残存 → 削除して続行 / 別ステート ID の `cfnsync-` → 削除せず中断 / 非 `cfnsync-`(人手・他ツール)→ 削除せず中断 / 命名から判定不能 → 中断 |
| FR-2-8 | `*_IN_PROGRESS` は並行操作エラー | `UPDATE_IN_PROGRESS` 等で変更セットを作成せずエラー |
| FR-2-9 | 管理タグを自動付与 | すべての CreateChangeSet の Tags に `cfnsync:state-id=<ステートID>` がマージされる(ユーザータグと共存) |
| FR-2-10 | `REVIEW_IN_PROGRESS` にスタック削除を行わない | **`DeleteStack` が一切呼ばれないことを検証** / 自変更セットのみ個別削除 → `CREATE` 型を再作成して続行 / 他主体の変更セットが存在 → 作成せず fail-closed 停止 |
| FR-2-11 | **実行直前の再検査**(Codex 承認条件) | 呼び出し順序を記録し、再検査(ListChangeSets)が `ExecuteChangeSet` の**直前**に配置されることを検証 / 再検査で他主体の変更セットを検出 → `ExecuteChangeSet` を呼ばず停止(暗黙削除を発生させない) |

### T-14 usecase/deploy — デプロイフロー統合

成果物: `src/usecase/deploy.ts`, `test/usecase/deploy.test.ts`

| ID | 受け入れ基準(要約) | テストケース |
|---|---|---|
| FR-5-1 | 変更検知 → 依存順解決 → 変更セット作成 → 差分表示 → 実行を一連で実行 | 2 スタック(依存あり)の一括実行で全工程が依存順に呼ばれる |
| FR-5-2 | デフォルトで非対話完走 | プロンプト・stdin 読み取りなしで完了する |
| FR-5-3 | `--dry-run` は差分表示までで停止 | `ExecuteChangeSet` が呼ばれず、describe 後に変更セットが削除される(§5.2) |
| FR-4-1 | 完了まで待機しイベントを逐次出力 | イベントポーリングの逐次出力と完了待機を検証 |
| FR-4-2 | 失敗時は原因リソースとメッセージを出力し非ゼロ終了 | 失敗イベントから `ResourceStatusReason` が抽出され、終了コード 1 |
| FR-4-3 | ロールバックの発生と結果を報告 | `UPDATE_ROLLBACK_COMPLETE` への遷移が報告に含まれる |
| FR-1-3 | 成功したスタックのみステート更新 | スタック A 成功・B 失敗 → A のみステート更新、B は前回のまま |
| **NFR-3(継続)** | **途中失敗後の再実行は成功済みをスキップし、失敗地点から継続** | A 成功・B 失敗の直後の状態からそのまま再実行 → A は `unchanged` となり **A への CreateChangeSet / ExecuteChangeSet が一切呼ばれない**、B から処理が再開して収束する。変種: B の失敗実行が残した変更セットが FR-2-7 の残存回収で処理されること |
| **FR-13-4** | **テンプレート変更時、設定された全対象リージョンに変更セットを作成** | 2 リージョン設定のテンプレートを変更 → 各リージョンに CreateChangeSet が**ちょうど 1 回ずつ**、リージョン別の実効パラメータ・タグで呼ばれ、設定順に直列実行される |
| FR-1-9 | 各副作用の直前に fencing 検証。喪失時は中断 | 副作用(変更セット作成・実行・削除、ステート保存)の直前ごとにロック検証が呼ばれる(呼び出し順序検証)/ 完了待機後・CAS 保存直前の検証で所有権喪失 → 保存せず中断 |
| FR-9-2 | 失敗時: 依存下流は中止、独立は `--on-failure stop|continue` | B(Aに依存)は中止 / 独立の C は `stop` で中止・`continue` で続行 |
| FR-1-7(統合) | ロックは正常・異常を問わず終了時に解放 | 成功時・途中エラー時の双方で解放される(所有権喪失時は解放試行が条件不成立で無害) |
| NFR-3(冪等) | 再実行で成功済みはスキップ | plan → deploy → 再 deploy で全スタック「変更なし」(空変更セット)、終了コード 0 |
| §8.2 | `__REQUIRED__` 残存スタックの deploy 拒否 | プレースホルダ残存 → 当該スタックは検証エラーで実行されない |

### T-15 usecase/delete — スタック削除

成果物: `src/usecase/delete.ts`(deploy フローの一部), `test/usecase/delete.test.ts`

| ID | 受け入れ基準(要約) | テストケース |
|---|---|---|
| FR-6-1 | `deleted` は差分表示に常に含める | `--allow-delete` なしでも削除対象が差分出力に載る |
| FR-6-2 | 削除は `--allow-delete` 指定時のみ。デフォルトは警告のみ | オプションなし → `DeleteStack` が呼ばれず警告報告 / あり → 削除実行 |
| FR-6-3 | 削除保護は自動解除せずエラー | Termination Protection 有効 → `UpdateTerminationProtection` を呼ばずエラー |
| FR-6-4 | 統合グラフの逆順で削除 | 削除済みテンプレートの旧依存辺を含む統合グラフの逆トポロジカル順で `DeleteStack` が呼ばれる |
| FR-6-5 | 依存情報が復元できない場合は削除拒否 | ステートに `exports` / `imports` がない削除対象 → 削除せず手動対応を案内 |
| FR-6-6 | 削除は接続先検証の対象 | AccountGuard 不通過時は `--allow-delete` があっても削除されない |
| **FR-1-9(削除)** | **各 DeleteStack の直前に fencing 検証** | `DeleteStack` 呼び出しごとの直前にロック所有権検証が配置される(呼び出し順序検証)/ 2 件削除の 1 件目完了後に所有権喪失 → **以降の `DeleteStack` 呼び出しゼロ**、ステート保存も行われない |
| §8.3 | 削除成功のたびにステートから除去して CAS 保存 | 2 件削除で 1 件目成功後に保存が走り、2 件目失敗でも 1 件目は除去済み |

### T-16 usecase/importer — インポート

成果物: `src/usecase/importer.ts`, `test/usecase/importer.test.ts`

| ID | 受け入れ基準(要約) | テストケース |
|---|---|---|
| FR-10-1 | スタック名・パラメータ・タグ・Capabilities を設定ファイルに反映 | DescribeStacks の結果が `cfnsync.yaml` の `stacks` 配下に書き戻される。**既存のコメント・キー順が保持される**(YAML AST 編集) |
| FR-10-2 | NoEcho はプレースホルダを記録。マスク値を実値として書かない | NoEcho パラメータ → `__REQUIRED__` が記録され、`****` が書き込まれない |
| FR-10-3 | デプロイ済みテンプレートとローカルを比較 | `GetTemplate` 結果とローカルファイルのパース後同値比較が行われる |
| FR-10-4 | 差分はデフォルトエラー。`--reconcile remote` / `--reconcile local` | 差分あり+オプションなし → エラー / `remote` → ローカル上書き / `local` → ローカル維持+ステートにはデプロイ済み側ハッシュ(次回 plan で `modified` になることまで検証) |
| FR-10-5 | ローカルにないスタックはテンプレートを書き出せる | `--write-template` でデプロイ済みテンプレートがローカルファイル化される |
| FR-10-6 | 検証済みの対応とデプロイ済み内容のハッシュを記録 | ステートの `templateHash` / `inputsHash` がデプロイ済み内容に基づく。未デプロイのローカル内容が「デプロイ済み」として記録されない |
| FR-10-7 | AWS へは読み取り専用 | 変更系 API(CreateChangeSet / DeleteStack 等)が一切呼ばれないことを検証 |
| FR-10-8 | アカウント照合はロック取得後に再読込したステートに対して行う | 照合がロック後の再読込ステートで行われる(呼び出し順検証)/ 不一致 → 設定・ステート・テンプレートのいずれにも書き込みゼロで終了 / 初回 → アカウント ID を同一ロック区間の CAS 保存で記録 |
| FR-10-9 | インポートはロックを取得する | ロック取得失敗 → 一切の書き込みなしでエラー |
| **FR-1-9(import)** | **設定・テンプレート・ステートの各書き込み直前に fencing 検証** | 各ローカル書き込み(cfnsync.yaml・テンプレートファイル・ステート保存)の直前ごとに所有権検証が配置される(呼び出し順序検証)/ 障害注入: 設定ファイル書き込み後に所有権喪失 → **残りの書き込み(テンプレート・ステート)が行われない** |
| FR-10-10 | スタックが存在しないテンプレートは `added` 扱い | 対応スタックなし → ステートに記録されず、次回 detect で `added` |
| FR-10-11 | 依存辺の記録 | インポート成功時に exports / imports がステートに記録される(FR-8-5) |
| FR-13-9 | リージョンごとにインポートできる | 2 リージョンの既存スタックがそれぞれのスタックキーで取り込まれる |

### T-17 usecase/force-unlock

成果物: `src/usecase/forceUnlock.ts`, `test/usecase/forceUnlock.test.ts`

| ID | 受け入れ基準(要約) | テストケース |
|---|---|---|
| FR-1-7(手動解除) | 残存ロックを手動解除する手段を提供 | 実行 ID 指定でロックが解除される |
| FR-1-8 | 解除は対象検証つきの条件付き操作 | 指定実行 ID と現在のロックが不一致 → 解除しない / 読み取りから削除までの間に所有者交代(`If-Match` 不成立)→ 削除せず報告 |
| FR-1-10 | ロック内容(実行 ID・開始時刻・実行者)と警告を表示 | 出力にロック内容と警告文が含まれる |

### T-18 障害注入・並行シナリオ(横断)

成果物: `test/usecase/recovery.test.ts`, `test/usecase/concurrency.test.ts`(design.md §10 の障害注入シナリオ)

| ID | 受け入れ基準(要約) | テストケース |
|---|---|---|
| FR-1-11(a) | CREATE 成功+ステート保存失敗 → 再実行で全一致なら再同期 | 保存直前で中断 → 再実行: テンプレート(パース後同値)・実効パラメータ・タグ・Capabilities・**管理タグ**がすべて一致 → デプロイ成功として再同期 |
| FR-1-11(a) | 管理タグ由来確認は fail-closed | 他が全一致でも管理タグ欠如 → 再同期せずエラー / 別ステート ID の管理タグ → エラー。いずれもインポート案内つき |
| FR-1-11(a) | 検証不能入力は一致条件から除外し希望値を記録 | dependsOn / NoEcho 実値は比較されず、ローカル希望値が `inputsHash` に記録され、除外項目が出力に明示される |
| FR-1-11(a) | 不一致は命名衝突としてエラー+インポート案内 | 「タグのみ異なる同名管理外スタック」「Capabilities のみ異なる」「NoEcho 実値のみ異なる(管理タグなし)」の 3 変種 → いずれも再同期されず停止(§10) |
| FR-1-11(b) | DELETE 成功+保存失敗 → 再実行で収束 | 削除後保存前に中断 → 再実行: スタック不存在を確認しステートから除去 |
| FR-1-11(c) | UPDATE は空変更セットで再同期 | 更新後保存前に中断 → 再実行: 空変更セット → 変更なしとしてステート更新 |
| FR-1-10(復旧) | 手動解除後の再実行で乖離が解消(冪等復旧) | force-unlock 後の再実行が変更検知+変更セット再作成で収束する |
| NFR-3 | 並行実行はロックで安全に停止 | 2 実行の同時開始 → 後発はロック取得失敗、AWS への変更呼び出しゼロ、ステート無傷 |
| NFR-3 / §4.5 | CAS により正本が分岐しない | fencing 検証と副作用の間で所有権交代が起きる競合窓シナリオ → 旧実行のステート保存は CAS で必ず失敗し、正本は新実行側のまま |
| NFR-3 | 完了待機中の force-unlock → 保存直前 fencing で中断 | 長時間待機中に所有者交代 → 待機完了後の検証で中断、保存されない |
| FR-2-10(横断) | `REVIEW_IN_PROGRESS` に `DeleteStack` が呼ばれない | 全シナリオを通じて `DeleteStack` の呼び出し先に `REVIEW_IN_PROGRESS` スタックが含まれないことを検証 |
| FR-2-11(横断) | 所有権確認直後の並行追加も実行直前再検査で防ぐ | 残存回収の後・実行の前に他主体の変更セットを注入 → 再検査が検出し `ExecuteChangeSet` が呼ばれない |

## 7. M4: cli

### T-19 cli — コマンド定義と終了コード

成果物: `src/cli/*.ts`, `bin` エントリ, `test/cli/cli.test.ts`

| ID | 受け入れ基準(要約) | テストケース |
|---|---|---|
| FR-12-1 | status / plan / deploy / graph / import(+ force-unlock)を提供 | 各サブコマンドが定義され、対応する usecase が呼ばれる |
| FR-12-2 | 終了コード: 0 = 成功・変更なし / 1 = エラー / 2 = 差分あり | plan 差分あり → 2 / plan 差分なし → 0 / 検証エラー → 1 / deploy 成功 → 0 / deploy 失敗 → 1(§9 の表と 1:1) |
| FR-12-3 | TTY なしで動作 | 非 TTY 環境でプロンプトなしに完走する |
| FR-7-1〜3 | `--profile` / `AWS_PROFILE` / リージョン指定 | CLI オプション・環境変数がクライアント設定に伝播する |
| FR-5-2(オプション) | ローカル向け確認プロンプトはオプトイン | 確認オプション指定時のみプロンプト(既定は非対話) |
| NFR-5 | status / graph は AWS を呼ばない | 両コマンド実行で AWS クライアントが一切呼ばれない |
| NFR-1 | 進捗・結果を stdout / stderr に構造的に出力 | 結果は stdout、診断・進捗は stderr に分離される |

## 8. M5: ドキュメント・パッケージング

### T-20 README・運用ドキュメント

種別 `ドキュメント` の受け入れ基準をここで満たす(**実装完了条件**。Codex レビュー承認時の指摘事項を含む):

| ID | 記載事項 |
|---|---|
| FR-1-5 | `local` バックエンドは単一環境用。複数実行環境では `s3` を使用すること |
| FR-1-9 / FR-2-11 / §4.5 / §7 | fencing・実行直前再検査は競合窓を排除できないベストエフォートであること。厳密な保証は CAS + `*_IN_PROGRESS` ガードにあること |
| §11 運用規約 | cfnsync 管理対象スタックに手動・他ツールで変更セットを作成しないこと(存在時は fail-closed 停止) |
| §11 復旧手順 | 途中失敗 → 再実行 / ロック残存 → 旧実行の終了確認後に `force-unlock <実行ID>` / ステート破損 → `.bak` または S3 バージョニングから復元 |
| NFR-3 | GitHub Actions の `concurrency` グループ推奨構成(§11 のリファレンスワークフロー掲載) |
| NFR-4 | 実行に必要な最低限の IAM 権限一覧 |
| §10 | 実 AWS を使う手動検証手順(E2E はスコープ外のため) |
| FR-12-2 | 終了コード表 |

### T-21 npm パッケージング

- `package.json` の `bin`(`cfnsync`)・`files`・`engines`(node >= 20)整備、`npx cfnsync --help` の動作確認。
- 将来の GitHub Action 化(§2)を妨げない構成であることを確認(ビルド成果物が単一ディレクトリに収まる)。

## 9. テスト対象外(ドキュメント・構造で満たす)受け入れ基準の一覧

| ID | 満たし方 |
|---|---|
| FR-1-5 | T-20(README) |
| FR-7-4 | 構造的要件: クレデンシャル保存コードを持たない(コードレビューで担保) |
| FR-11-4 | 構造的要件: YAML 採用 |
| FR-9-3 | 設計制約: 直列実行+順序付き計画構造(T-07 で構造のみ確認) |
| FR-2-11(運用規約部分) / FR-1-9(仕様明記部分) | requirements.md / design.md に明記済み + T-20(README) |
| NFR-1 / NFR-6 | アーキテクチャ(§3)で構造的に満足。NFR-1 の出力分離のみ T-19 でテスト |
| NFR-5(規模) | 数十テンプレート規模の fixture で全体テストが実用時間内に完走することを CI で観測(専用テストは設けない) |

## 10. Codex レビュー承認時の実装条件との対応

| 指摘 | 対応タスク |
|---|---|
| `ListChangeSets` の全ページ走査を受け入れテストで固定 | T-08 |
| 再検査が必ず `ExecuteChangeSet` の直前に配置されることを受け入れテストで固定 | T-13(呼び出し順序の検証)+ T-18(並行追加シナリオ) |
| README に §11 の運用規約と手動検証手順を実装完了条件として反映 | T-20 |

## 11. 進捗チェックリスト

- [x] T-01 プロジェクト初期化
- [x] T-02 core/config
- [x] T-03 core/template
- [x] T-04 core/state(スキーマ・世代管理)
- [x] T-05 core/detect
- [x] T-06 core/graph
- [x] T-07 core/plan
- [x] T-08 ports + aws/CloudFormationGateway
- [x] T-09 aws/StsGateway
- [x] T-10 ステートバックエンド(backend/local + aws/s3)
- [x] T-11 report
- [x] T-12 usecase/guard
- [x] T-13 usecase/executor
- [x] T-14 usecase/deploy
- [x] T-15 usecase/delete
- [x] T-16 usecase/importer
- [x] T-17 usecase/force-unlock
- [x] T-18 障害注入・並行シナリオ
- [x] T-19 cli
- [ ] T-20 README・運用ドキュメント
- [ ] T-21 npm パッケージング
