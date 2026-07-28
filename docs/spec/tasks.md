# cfnsync 実装タスク分解(TDD)

対応する仕様: [requirements.md](./requirements.md) / [design.md](./design.md)

## 1. 進め方

- **red → green → refactor**。各タスクはまず対応表のテストを書き、失敗を確認してから実装する。
- **受け入れ基準 ID の規約**: requirements.md で明示 ID がある受け入れ基準はその ID を参照し、明示 ID のない受け入れ基準は従来どおり各要件内の出現順を `FR-X-n` として参照する。現時点で明示 ID がある要件は FR-3、FR-4、FR-5、FR-8-7、FR-11-10、FR-12 である。箇条書きの挿入・並べ替えによって、明示 ID および既存の出現順 ID の意味を変更しない。
- **1 基準 = 1 主張**: 複数の主張を 1 つの基準へ詰め込まない。複数主張を含む基準はサブ ID(`FR-5-6a` / `FR-5-6b` …)へ分割し、requirements.md の基準と各タスクの対応表の行を真に 1:1 にする。

#### 1.1 T-22 による受け入れ基準 ID の移行表

T-22(deploy 承認フロー)は既存 ID の**意味を変える**変更を含む。下表が正本であり、「意味は変わらない」とみなしてはならない。

| 旧 ID | 旧 ID の内容 | 新 ID | 変化 |
|---|---|---|---|
| FR-5-1 | 変更検知 → 順序解決 → 変更セット作成 → 差分表示 → 実行 | FR-5-1 | **拡張**(「承認」が工程に加わる)。既存テストは `--auto-approve` 前提へ更新が必要 |
| FR-5-2 | 既定で**非対話**完走。確認プロンプトはオプトイン | FR-5-2a / FR-5-2b | **意味が反転**。既定が「1 回承認」になり、非対話は `--auto-approve` のオプトインになった |
| FR-5-3 | `--dry-run` は差分表示までで停止 | FR-5-3 | 変更なし。ただし変更セットライフサイクルの規定を FR-5-9b として新設 |
| FR-5-4 | 進捗をスタックキー付きで stderr へ逐次出力 | FR-5-4 | **追記**(承認を挟んでもスタックごとの段階の相対順序を変えない、という条項を追加) |
| (なし) | — | FR-5-5a〜c / FR-5-6a〜g / FR-5-7a〜d / FR-5-8a〜b / FR-5-9a〜b / FR-5-10a〜c / FR-5-11 / FR-5-12a〜c / FR-5-13 / FR-5-14a〜b / FR-5-15a〜b / FR-5-16 / FR-5-17a〜d | 新設 |
| (なし) | — | FR-3-7a / FR-3-7b | 新設(承認要約の色・出力先) |
| (なし) | — | FR-11-10a / FR-11-10b | 新設((リージョン, スタック名)の一意性) |
| FR-12-3 | すべてのコマンドは TTY なしで動作する | FR-12-3a | **意味を保存**(FR-12-3a が旧 FR-12-3 と同義) |
| (なし) | — | FR-12-3b / FR-12-3c | 新設(非 TTY の `deploy` は `--auto-approve` 必須。変更 0 件でもエラー) |
| FR-12-6c | 拒否は専用キャンセル payload を stdout へ 1 個、exit 0 | FR-12-6c1 / FR-12-6c2 / FR-12-6c3 | **契約が置換**。payload が deploy report + `cancelled: true` になり、`exitCode` / `message` フィールドは消滅 |
| (なし) | — | FR-12-8a〜c | 新設(`--auto-approve` の提供範囲と `--confirm` の廃止) |
- 各タスクの表が design.md §10 の「受け入れ基準 → テストケース対応表」の実体である。**1 受け入れ基準 = 1 行以上**。仕様の変更が生じた場合は requirements.md / design.md を先に更新し、この表を追随させる。
- テストは実 AWS に接続しない(§10): `core/` は純粋単体テスト、`aws/` / `backend/` は `aws-sdk-client-mock` とテンポラリファイル、`usecase/` はゲートウェイをインメモリフェイクに差し替えたシナリオテスト。
- タスクの完了条件: 対応表のテストがすべて green、かつ既存テスト全体(`vitest run`)が green。
- 種別 `ドキュメント` の基準はテストではなく M5 の成果物(README 等)で満たす。§10 にドキュメント側の一覧をまとめる。

## 2. マイルストーン

| MS | 内容 | タスク | 主な要件 |
|---|---|---|---|
| M0 | スキャフォールド | T-01 | NFR-2, NFR-6 |
| M1 | core(純粋ロジック) | T-02〜T-07 | FR-1, FR-8, FR-9, FR-11, FR-13 |
| M2 | ports + アダプタ(aws / backend)+ report | T-08〜T-11 | FR-1, FR-2, FR-3, NFR-3, NFR-4 |
| M3 | usecase(guard / executor / importer) | T-12〜T-18 | FR-2, FR-4〜FR-7, FR-10 |
| M4 | cli | T-19 | FR-12, NFR-1 |
| M5 | ドキュメント・パッケージング | T-20〜T-21 | FR-1-5, NFR-4, §11 |
| M6 | deploy 承認フロー(仕様変更) | T-22 | FR-5-1〜FR-5-17, FR-3-7, FR-11-10, FR-12-3, FR-12-6c, FR-12-8 |

依存方向(`cli → usecase → core / ports / report`、`aws` / `backend` は `ports` を実装)に従い、**usecase が依存する契約(ports / report)を usecase より先に固定する**。M0 → M5 の順、ミルストーン内も記載順を推奨する(後続タスクが前のタスクの型・fixture を使う)。

## 3. M0: スキャフォールド

### T-01 プロジェクト初期化

成果物: `package.json`(Node.js 24+, npm)、`tsconfig.json`、vitest 設定、design.md §10 のディレクトリ骨格、プレースホルダテスト。

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
| FR-11-5 | 設定不備は実行前検証で、対象キーを一度だけ含む単一の人間可読な `ConfigError` として具体的エラーを報告し、zod issue 配列を露出しない | 存在しないテンプレートへの参照 / 必須項目欠落 / 不正な型 → 対象キーを含む `ConfigError` / `FR-11-5: zod 検証失敗は対象キーを一度だけ含む人間向け ConfigError で issue JSON を露出しない` |
| FR-11-8 | トップレベル `defaultTags` を設定でき、`defaultTags` < `tags` < `regionOverrides.<region>.tags` の順に浅くマージされる(キー重複はエラーにしない) | 独自 `tags` なしスタックへそのまま適用 / 別キーはマージ / 同名キーは `tags` が優先 / 同名キーは `regionOverrides.tags` が優先 / 三者混在の優先順位 / 数値・真偽値の文字列正規化 / 省略時は付与なし / 複数リージョンの全ターゲットへ適用 |
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
| FR-8-7(解決) | `String` / `Number` Parameter の `Ref` と文字列形式 `Fn::Sub` を実効値で解決する | Export / Import の双方について `Ref`、複数変数を含む `Fn::Sub`、`${!Literal}` のリテラルエスケープ、数値の文字列化を検証する。値は scalar Default < 共通 parameters < region override の優先順位で、空文字の明示値も Default より優先する |
| FR-8-7(未解決) | 未確定・秘匿・未対応の候補だけを除外して警告し、他の依存解析は継続する | Default/明示値なし、`__REQUIRED__`(Default へフォールバックしない)、NoEcho、非 scalar Default、List/SSM/未対応型、リソース `Ref`、変数マップ形式 `Fn::Sub`、未対応 intrinsic は対象位置・理由付き warning。NoEcho 実値は warning に含めず、同一テンプレート内の静的候補は引き続き抽出される |
| NFR-4(準備) | NoEcho パラメータの抽出 | `Parameters` から `NoEcho: true` のキー一覧を抽出する(マスク適用は T-11) |
| FR-1-11(a)準備 | scalar な Parameter Default を復旧比較用に文字列化して抽出し、Default なしは含めない | `FR-1-11(a)準備: Parameters Default を文字列化して抽出し Default なしは含めない` |
| FR-1-11(a) fail-closed | object・array・intrinsic Default を実効値として推測または黙示無視しない | `FR-1-11(a) fail-closed: 非 scalar Default を実効値として推測しない` |

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
| FR-11-9 | `defaultTags` の変更は、付与先スタックの変更検知に反映される | `resolveTargets` 経由で `defaultTags` のみを変えた target は `modified` として検知される(変更なしは `unchanged` のままの対照実験も含む) |
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
| FR-8-6 | レベル(並列デプロイ可能な階層)を算出する | `computeLevels` は独立ノードを `Lv0` に、diamond 依存で複数ノードから共有される依存先の下流ノードたちを同一 `Lv1`(依存の記述を重複させず)にまとめる / 循環時は `topologicalOrder` 経由で `DependencyCycleError`(レベル分割前に fail-closed) |

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
| NFR-5(待機) | ポーリング API 数を抑制 | 変更セット待機中は先頭ページのみ・終端時に全ページ取得 / イベント 5 秒・スタック状態 5→10→15 秒 |
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
| FR-3-4 | plan / deploy の text 差分は実行環境によらず既定で色付き | report renderer が Add=緑・Modify=黄・Remove=赤・Replacement=太字赤の ANSI SGR を付与する / 非 TTY の plan と deploy でも既定で同じ ANSI 色を stdout へ出す |
| FR-3-5 | `--no-color` または `NO_COLOR` の存在は既定色を無効化 | plan / deploy の両方で各指定時に ANSI が一切出ない / 空の `NO_COLOR` も存在として扱う |
| FR-3-6 | JSON は色設定にかかわらず ANSI なしの単一 document | plan / deploy の `--output json` を JSON parse でき、ANSI が混入せず既存 schema を維持する |
| NFR-4 | NoEcho 値をマスクする。ただし予約済み `REQUIRED_PLACEHOLDER` との完全一致だけは非秘匿 sentinel として置換候補から除外する | 差分・ログ・JSON のすべてで NoEcho パラメータ値が `****` になる(実値がどの出力にも現れない) / `NFR-4: NoEcho 実効値が __REQUIRED__ の場合は予約 sentinel を誤マスクしない` / `NFR-4: 明示値は template Default より優先して redactor の実効値になる` |
| FR-13-7 | 出力に対象リージョンを明示 | 差分・ログ・JSON にスタックキー(リージョン込み)が含まれる |
| FR-8-3 | 依存マッピングをテキストツリー / JSON で出力 | `renderGraphText` は `computeLevels` の結果を `Lv0`, `Lv1`, ... の見出しでグループ化した人間可読出力を返す(diamond 依存でも記述は重複しない)/ `renderGraphJson` のノード・辺構造(既存の JSON 契約)は変更されない |
| FR-5-4(契約) | 進捗マイルストーンの型を定義する | `ProgressEvent`(stackKey・region・phase・message)/ `ProgressPhase` の union 型が report/index.ts で定義され、usecase が依存する出力契約に含まれる |
| FR-3(値差分) | CloudFormation が返すプロパティ値差分をそのまま表示する | 全 `DescribeChangeSet` ページに `IncludePropertyValues=true` を渡す / `Target` の path・before/after・由来・変更種別等を正規化する / text と JSON に前後値を出力する / CloudFormation が省略した値は補完しない / NoEcho 由来値と context はマスクする |
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
| FR-7-8 | 解決した接続先をログ・JSON に含め、STS 後の guard 拒否でも解決値を保持する(秘匿情報は含めない) | 出力の先頭にアカウント ID・リージョンが含まれ、クレデンシャル文字列が含まれない / `FR-7-8: STS 解決後の allowedAccounts 不一致でも report.connection は解決済み accountId` / `FR-7-8: STS 解決失敗時だけ connection.accountId は (unresolved)` |

### T-13 usecase/executor — 変更セットライフサイクル

成果物: `src/usecase/executor.ts`, `test/usecase/executor.test.ts`

| ID | 受け入れ基準(要約) | テストケース |
|---|---|---|
| FR-2-1 | `modified` → `UPDATE` 型変更セット | 既存スタックへの変更で `ChangeSetType: UPDATE` |
| FR-2-2 | `added` → `CREATE` 型変更セット | スタック不存在で `ChangeSetType: CREATE` |
| FR-2-3 | 空変更セットは「変更なし」としてスキップ | Status `FAILED` + StatusReason が `didn't contain changes` / `No updates are to be performed` → エラーにせず変更セット削除+変更なし扱い。それ以外の FAILED は通常エラー |
| FR-2-4 | デプロイ不能ステータスは対処方法つきエラー | `ROLLBACK_COMPLETE` → `StackStateError`(スタック削除の必要性を含むメッセージ) |
| FR-2-5 | Capability を指定できる | 設定の `capabilities` が CreateChangeSet に渡る |
| FR-2-6 | ツール由来と実行単位を識別できる命名 | 変更セット名が `cfnsync-<stateId:12hex>-<runId:16hex>-<UTC:YYYYMMDDTHHmmssSSS>` に完全一致。形式不一致は所有権判定不能として停止 |
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
| FR-5-2b | `--auto-approve` 指定時は承認を求めない | `--auto-approve` 指定時は `approve` が呼ばれずプロンプト・stdin 読み取りなしで完了する(承認フロー本体の検証は T-22) |
| FR-5-3 | `--dry-run` は差分表示までで停止 | `ExecuteChangeSet` が呼ばれず、describe 後に変更セットが削除される(§5.2) |
| FR-4-1 | 完了まで待機しイベントを逐次出力 | イベントポーリングの逐次出力と完了待機を検証 |
| FR-4-2 | 失敗時は原因リソースとメッセージを出力し非ゼロ終了 | 失敗イベントから `ResourceStatusReason` が抽出され、終了コード 1 |
| FR-4-3 | ExecuteChangeSet 後に観測した明示 rollback status だけでロールバックの発生と結果を報告 | `UPDATE_ROLLBACK_COMPLETE` への遷移が報告に含まれる / `FR-4-3: ROLLBACK_IN_PROGRESS 観測後に wait が例外終了しても rolledBack true を保持し state 未更新・lock 解放` / `FR-4-3(否定): ExecuteChangeSet 前の ROLLBACK_COMPLETE guard 拒否は rolledBack false` / `FR-4-3(否定): rollback を観測しない UPDATE_FAILED は reason に ROLLBACK が含まれても false` / `FR-4-3(否定): allowlist 外の *_ROLLBACK_* 類似 status は rolledBack false` / `FR-4-3(JSON): failed StackResult の rolledBack true/false を boolean として保持する` |
| FR-4-2 / NFR-4(公開本文) | deploy report / progress は未装飾の公開本文だけを使い、cause・NoEcho 実値・stackKey / region 装飾を本文へ昇格させない。分類不能例外は固定文言にする | `FR-4-2/NFR-4 / FR-4-3: ROLLBACK_IN_PROGRESS 観測後の wait 例外は公開本文だけを報告し cause・NoEcho 実値を秘匿する` / `FR-4-2(安全境界): 分類不能な wait 例外は固定の公開文言へ置換する` |
| FR-1-3 | 成功したスタックのみステート更新 | スタック A 成功・B 失敗 → A のみステート更新、B は前回のまま |
| **NFR-3(継続)** | **途中失敗後の再実行は成功済みをスキップし、失敗地点から継続** | A 成功・B 失敗の直後の状態からそのまま再実行 → A は `unchanged` となり **A への CreateChangeSet / ExecuteChangeSet が一切呼ばれない**、B から処理が再開して収束する。変種: B の失敗実行が残した変更セットが FR-2-7 の残存回収で処理されること |
| **FR-13-4** | **テンプレート変更時、設定された全対象リージョンに変更セットを作成** | 2 リージョン設定のテンプレートを変更 → 各リージョンに CreateChangeSet が**ちょうど 1 回ずつ**、リージョン別の実効パラメータ・タグで呼ばれ、設定順に直列実行される |
| FR-1-9 | 各副作用の直前に fencing 検証。喪失時は中断 | 副作用(変更セット作成・実行・削除、ステート保存)の直前ごとにロック検証が呼ばれる(呼び出し順序検証)/ 完了待機後・CAS 保存直前の検証で所有権喪失 → 保存せず中断 |
| FR-5-4 | 一括実行の各段階で進捗をスタックキー付きで通知する | CREATE 成功シナリオで `onProgress` が ['changeset-create-start','diff-ready','execute-start','done'] の順に、対象スタックキー付きで呼ばれる / 空変更セットでは ['changeset-create-start','no-change'] で止まる / `--dry-run` では ['changeset-create-start','diff-ready'] で止まり、正常な停止を skipped として通知せず execute-start/done も呼ばれない |
| FR-5-4(失敗) | 失敗時の progress メッセージは report と同じ redactor 適用済み文字列を再利用する | NoEcho を含む StatusReason で失敗させた場合、`onProgress` の 'failed' メッセージに実値が含まれない(report.result の errorMessage と同一文字列であることを確認) |
| NFR-4(Default) | 設定で省略した NoEcho の scalar template Default も redactor の実効値に含める。`inputsHash` は補完しない | `NFR-4(Default/event): NoEcho template Default をイベントと failed progress/report の格納前にマスクする` / `NFR-4(Default/change set): NoEcho template Default を変更セット失敗の report/progress 格納前にマスクする` / `NFR-4(Default/final status): NoEcho template Default を最終 status failure の report/progress 格納前にマスクする` |
| FR-5-4(スキップ) | 依存失敗によるスキップも通知する | A 失敗・B が A に依存 → B の `onProgress` に phase 'skipped' が呼ばれる |
| NFR-1(進捗) | 進捗は標準エラーのみに出力し、`--output json` の標準出力を汚さない | CLI 統合テストで `--output json` 実行中に `onProgress` を複数回発火させても stdout が単一の有効な JSON のままであることを確認(cli.test.ts 側) |
| FR-9-2 | 失敗時: 依存下流は中止、独立は `--on-failure stop|continue`(**Phase B の失敗にのみ適用**。FR-5-12b) | B(Aに依存)は中止 / 独立の C は `stop` で中止・`continue` で続行(いずれも承認後の実行中に失敗させるシナリオ) |
| FR-1-7(統合) | ロックは正常・異常を問わず終了時に解放 | 成功時・途中エラー時の双方で解放される(所有権喪失時は解放試行が条件不成立で無害) |
| NFR-3(冪等) | 再実行で成功済みはスキップ | plan → deploy → 再 deploy で全スタック「変更なし」(空変更セット)、終了コード 0 |
| §8.2 | `__REQUIRED__` 残存スタックの deploy 拒否。診断は literal sentinel と対象名を保持する。この失敗は Phase A で確定するため FR-5-12b により実行全体を中断する | プレースホルダ残存 → 当該スタックは検証エラーで実行されない / `§8.2/NFR-4: __REQUIRED__ 拒否の errorMessage は literal sentinel と対象名を保持し AWS 副作用ゼロ` / (T-22 で更新) `FR-9-2(__REQUIRED__): 必須値不足は Phase A の失敗として承認を求めず実行全体を中断する` |
| FR-8-7(deploy統合) | target ごとの実効パラメータで依存候補を解決し、成功時の state へ記録する | 共通値と region override で異なる Export / Import 名を解決し、依存順と保存済み exports/imports がリージョン別に一致する / parameter変更後は新しい依存名を保存する |
| FR-6-5 / FR-8-7(不完全解析) | 明示 `dependsOn` により解析警告を補完できる | 動的依存警告のみなら `dependencyAnalysisIncomplete: true` / 明示 dependsOn が1件以上あれば false / 警告なしなら false |

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
| FR-8-7(import統合) | デプロイ済みスタックの実効パラメータで依存名を解決して記録する | DescribeStacks の非 NoEcho パラメータを Default より優先して Export / Import を解決し state へ記録する / NoEcho は `__REQUIRED__` のため未解決 warning と incomplete を保持する |
| FR-6-5 / FR-8-7(import不完全解析) | import でも明示 `dependsOn` により解析警告を補完できる | 動的依存警告のみなら `dependencyAnalysisIncomplete: true` / 明示 dependsOn が1件以上あれば false |
| FR-13-9 | リージョンごとにインポートできる | 2 リージョンの既存スタックがそれぞれのスタックキーで取り込まれる |
| NFR-4(import warning) | import report の warning は `CfnSyncError.publicMessage` または固定の安全な文言だけを使い、text 専用診断とは分離する | `NFR-4(import warning): ロック取得・解放エラーの cause を JSON warnings に含めない` / `NFR-4(import warning): 分類不能なロック解放例外は固定文言に置換する` |

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
| FR-1-11(a) Default 補完 | 希望 template Default を明示設定値より低い優先度で復旧比較にだけ補完する | `FR-1-11(a): 設定省略パラメータをテンプレート Default で補完し CREATE 復旧に成功する` / `FR-1-11(a) 優先順: 明示的な空文字は template Default より優先し実 stack と不一致なら再同期しない` |
| FR-1-11(a) Default 不一致 | Default 補完後の実効 parameters が実 stack と不一致なら再同期しない | `FR-1-11(a) fail-closed: Default 補完後の実効値が実 stack と不一致なら再同期しない` |
| FR-1-11(a) Default 比較不能 | 非 scalar Default は deploy 統合経路でも例外を黙殺せず state を保存しない | `FR-1-11(a) fail-closed(統合): 非 scalar Default は再同期せず state を保存しない` |
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
| FR-12-2 | 終了コード: 0 = 成功・変更なし / 1 = エラー / 2 = 差分あり |
| FR-12-4 | `--version`(短縮形 `-v`)で `package.json` の version を表示し終了コード 0 | `FR-12(JSON契約外): --version は text を出して exit 0`(exit 0 と非 JSON の text 出力を固定)。**短縮形 `-v` と、出力が `package.json` の version と一致することは未検証**(下記の穴埋めを T-22 で行う) | plan 差分あり → 2 / plan 差分なし → 0 / 検証エラー → 1 / deploy 成功 → 0 / deploy 失敗 → 1(§9 の表と 1:1) |
| FR-12-3a | TTY なしで全コマンドが動作する | 非 TTY 環境で `status` / `plan` / `graph` / `import` / `force-unlock` / `deploy --auto-approve` がプロンプトなしに完走する(`--auto-approve` なしの拒否は T-22 の FR-12-3b / FR-12-3c) |
| FR-12-5 | 各サブコマンドの `--help` に共通オプションを表示 | `status`/`plan`/`deploy`/`graph`/`import`/`force-unlock` それぞれの `--help` 出力に `--config`/`--profile`/`--region`/`--output` が「Global Options」として含まれる(全 6 サブコマンド) |
| FR-11-5(統合) | filesystem adapter は設定検証の `ConfigError` を再ラップせず、本文・stackKey・cause を増幅しない | `FR-11-5(統合): 設定検証エラーを再ラップせず本文と stackKey を各1回だけ出す` |
| FR-12-6a(JSONエラー) | 有効な JSON 指定では result 生成前の例外を stdout の単一共通エラー JSON として exit 1 で返し、message は未装飾の公開本文だけにする | `FR-12(JSONエラー): 設定読込・設定検証・graph循環は stdout の単一 CliErrorPayload で exit 1` / `FR-12(JSONエラー): --on-failure 不正値と未知サブコマンドも stdout の単一 CliUsageError で exit 1` / `FR-12(JSON安全性): AwsError の SDK cause と CfnSyncError の装飾を公開 message に含めない` |
| FR-12-6a / FR-12-6b(import診断) | import の JSON warning は安全な本文、text warning は `CfnSyncError.message` の装飾済み診断を使う | `FR-12(import JSON診断): ロック warning の内部 cause を出力しない` / `FR-12(import text診断): ロック warning の装飾済み cause を出力する` |
| FR-12-6b(JSON出力先) | コマンド固有 result は exitCode によらず既存 schema の単一 JSON を stdout へ出す | `FR-12(JSON出力先): force-unlock の結果が exit 1 でも JSON は stdout のみに出す` |
| FR-12-6c1 | deploy の承認拒否は `cancelled: true` 付きの deploy report を stdout へ 1 個出し exit 0 | (T-22 で更新) `FR-12-6c1: 承認拒否は cancelled:true 付き deploy report を stdout に 1 個出して exit 0(diffs と skipped を保持)` |
| FR-12-6d(JSON記法) | `--output json` と `--output=json` の両記法を認識 | `FR-12(JSON選択): --output json と --output=json の両記法を認識する` |
| FR-12-6e(JSON配置) | `--output` はサブコマンドの前後どちらでも有効 | `FR-12(JSON選択): --output はサブコマンドの前後どちらでも有効` |
| FR-12-6f(JSON最後勝ち) | 複数の `--output` 指定は最後を採用 | `FR-12(JSON選択): 複数指定は最後の --output を採用する` |
| FR-12-6g(JSON誤検出防止) | 他の値付きオプションの値として消費された `--output=json` は JSON 選択ではない | `FR-12(JSON選択): 他オプションの値 --output=json を JSON 指定として扱わない` |
| FR-12-6h(JSON契約外) | `--help` / `--version` は JSON 指定と同時でも text・exit 0 | `FR-12(JSON契約外): --help と --version は text を出して exit 0` |
| FR-12-7 | plan / deploy だけが `--no-color` を提供 | plan / deploy の help に `--no-color` があり、他サブコマンドの help にはない |
| FR-7-1〜3 | `--profile` / `AWS_PROFILE` / リージョン指定 | CLI オプション・環境変数がクライアント設定に伝播する |
| FR-12-8a / FR-12-8b / FR-12-8c | `deploy` だけが `--auto-approve`(`-y`)を提供し、`--confirm` は廃止 | (T-22 で検証) `FR-12-8a` / `FR-12-8b` / `FR-12-8c` の各テスト |
| NFR-5 | status / graph は AWS を呼ばない | 両コマンド実行で AWS クライアントが一切呼ばれない |
| NFR-1 | 進捗・結果を stdout / stderr に構造的に出力。有効な JSON 指定の stdout は成功・失敗・キャンセルとも単一 JSON document とし、共通エラーには装飾済み context / cause / stack trace / zod issue / credential を含めない | 結果は stdout、診断・進捗・承認要約は stderr に分離される / `FR-12(JSONエラー): 設定読込・設定検証・graph循環は stdout の単一 CliErrorPayload で exit 1` / `FR-12(JSONエラー): --on-failure 不正値と未知サブコマンドも stdout の単一 CliUsageError で exit 1` / `FR-12(JSON安全性): AwsError の SDK cause と CfnSyncError の装飾を公開 message に含めない` / (T-22) `FR-3-7b: 承認要約は --output json でも stderr へ出し stdout の単一 JSON を汚さない` |

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
| FR-5-2a / FR-12-3b / FR-12-3c / FR-12-8c | `deploy` の既定は「差分表示 → 承認 → 実行」。CI(非 TTY)では `--auto-approve` が必須で、変更 0 件の実行も未指定ではエラーになること。`--confirm` 廃止と承認拒否時の出力契約の置換を含む破壊的変更の一覧(リリースノートにも掲載) |
| FR-1 / FR-5-5b(iii) | **CREATE 復旧の fail-closed 化**。NoEcho パラメータまたは `dependsOn` を持つスタックは、CREATE 成功後・ステート保存前の中断から自動復旧せず `cfnsync import` が必要になること。従来は警告のうえ再同期していたこと(README・リリースノート双方の必須記載事項) |
| FR-5-18 | 承認拒否時にも再同期によりステートが変わりうること。`reconciliations` フィールドで何が変わったかを確認できること |
| FR-5-12b | **`--on-failure` の適用範囲を計画段階から取り除く互換性破壊**。従来は `__REQUIRED__` 残存等の計画上の失敗でも独立スタックは `--on-failure continue` に従って実行された(変更前 design.md §8.2)。今後は Phase A の失敗を値にかかわらず実行全体の中断とすること(README・リリースノート双方の必須記載事項) |
| FR-5-14a / FR-5-14b / §5.3 | 人間の承認を待つ間ステートロックを保持し続けること。承認時点の差分と実行時点の実状態の一致は保証されず、防御は FR-5-17 の実行直前再検査(変更セット再検査・stackId 再照合・`*_IN_PROGRESS` ガード・fencing)に限ること |
| FR-5-15b / §5.3.1 | 既知の性質: **この実行で新規作成される Export** を参照するプロパティは承認時点で最終値が確定せず `{{changeSet:KNOWN_AFTER_APPLY}}` と表示されること(terraform の "known after apply" と同じ)。既存 Export を参照するプロパティは作成時に実値へ解決されること。AWS 公式文書はこの挙動を契約として保証しておらず、実測に基づく設計判断であること |
| §5.3.1(殻) | 承認拒否・plan で `REVIEW_IN_PROGRESS` の殻が残ること。次回実行で自動回収され、`DeleteStack` は行わないこと |

### T-21 npm パッケージング

- `package.json` の `name`(`@tarahi/cfnsync`)・`bin`(`cfnsync`)・`files`・`engines`(node >= 24)整備、`npx @tarahi/cfnsync --help` の動作確認。
- 将来の GitHub Action 化(§2)を妨げない構成であることを確認(ビルド成果物が単一ディレクトリに収まる)。

## 9. M6: deploy 承認フロー(仕様変更)

### T-22 deploy を「差分表示 → 承認 → 実行」へ変更する

`deploy` の既定挙動を `terraform apply` 相当にする(requirements.md FR-5 / design.md §5.3)。**既存の T-01〜T-21 の実装を再構築せず、`runLocked` の 2 フェーズ化として拡張する。**

成果物:

- `src/core/config.ts`((リージョン, スタック名)の一意性検証), `test/core/config.test.ts`
- `src/report/index.ts`(`ApprovalRequest` / `ApprovalSummary` / `renderApprovalSummary`、`DeployReport.cancelled` / `DeployReport.reconciliations` / `ReconciliationRecord`、`renderJson` の whitelist へ `cancelled` と `reconciliations` を追加、リソース差分 0 件の表示), `test/report/report.test.ts`
- `src/usecase/deploy.ts`(`DeployDeps.approve` / `DeployOptions.autoApprove`、Phase A / Phase B 分割、実行直前再検査、拒否時クリーンアップ), `test/usecase/deploy.test.ts`, `test/usecase/approval.test.ts`(新規)
- `src/cli/index.ts` / `src/cli/commands.ts`(`--auto-approve`(`-y`)追加、`--confirm` 削除、非 TTY ガード、承認要約の stderr 出力とプロンプト注入), `test/cli/cli.test.ts`
- README の更新(T-20 の再実行。承認フロー・CI での `--auto-approve` 必須・承認待ち中のロック保持・`KNOWN_AFTER_APPLY` の既知の性質)
- **リリースノート(破壊的変更の一覧と移行例)**。FR-12-6c3 / FR-12-3c により、CI 利用者は必ず影響を受けるため必須成果物とする

TDD 手順(red → green → refactor):

1. `core/config.ts` の (リージョン, スタック名) 一意性検証をテスト・実装する(AWS 非依存。FR-11-10a)。
2. `report` の型と `renderApprovalSummary` / `renderJson` の whitelist 追加、リソース差分 0 件の表示をテスト・実装する(usecase が依存する出力契約を先に固定する — §3 の依存方向)。
3. `usecase/deploy.ts` を Phase A / Phase B へ分割する。**まず `--auto-approve` 経路で既存の `test/usecase/deploy.test.ts` 全件が green に戻ることを確認**してから、承認・拒否・Phase A 失敗・実行直前再検査のテストを追加する。
4. `cli` のオプションと非 TTY ガードをテスト・実装する。
5. `pnpm run quality:check` を通す。
6. QA が `templates/.qa-baseline/` に記録した `--output json` のベースラインと突き合わせ、`connection` / `diffs` / `events` / `result` に非回帰であることを確認する(FR-5-16)。**テキスト出力は FR-5-7b により意図的に変わる**ため、非回帰判定の対象は JSON に限る。
7. 実機検証(QA)で、**新規 Export を参照する対象を含む実行を `ExecuteChangeSet` まで通す**。design §5.3.1 の限界 1 のとおり、保留値(`{{changeSet:KNOWN_AFTER_APPLY}}`)を持つ変更セットの実行は未実測であり、依存順(FR-9)によりその経路へ到達しないという設計上の理屈しか裏付けがない。ここで実測を得る。

`core/plan.ts` は変更しない。当初検討していた deferred(遅延変更セット)機構は**採用しない**。その出発点だった「依存先の Export が未作成だと Phase A の変更セット作成が失敗する」という前提は、生 AWS CLI による独立検証(cfnsync 非経由)で否定された — スタックも Export も存在しない状態で `--change-set-type CREATE` を実行しても `Status: CREATE_COMPLETE` / `ExecutionStatus: AVAILABLE` となり、プロパティ値は `{{changeSet:KNOWN_AFTER_APPLY}}` として保留される(design.md §5.3.1)。したがって `computeDeferred`・`StackDiff.deferred`・`plan` の挙動変更はいずれも不要であり、**`plan` の挙動は FR-5-7b のテキスト表示を除いて無変更**である。`CreateChangeSet` が別の理由で失敗した場合は FR-5-12a の Phase A 失敗として fail-closed に中断する。

破壊的変更(0.x のため許容。README・リリースノートに明記すること):

- `--confirm` の削除と `--auto-approve`(`-y`)の新設(FR-12-8c)
- 非 TTY での `deploy`(非 dry-run)は `--auto-approve` 必須。未指定はエラー(FR-12-3b)。**変更が 1 件もない実行も同様にエラーになる**(FR-12-3c)
- 承認拒否時の出力契約の置換。JSON は専用 payload から `cancelled: true` 付き deploy report へ、text は「stderr のキャンセル文のみ」から「stderr のキャンセル文 + stdout の deploy report」へ(FR-12-6c3)
- **`--on-failure` の適用範囲を計画段階から取り除く互換性破壊**(FR-5-12b)。従来は `__REQUIRED__` 残存等の計画上の失敗でも、依存下流を skipped としたうえで独立スタックは `--on-failure continue` に従って実行された(変更前 design.md §8.2 の「独立スタックだけを `--on-failure` に従わせる」を今回削除)。今後は Phase A の失敗を `--on-failure` の値にかかわらず実行全体の中断とする
- リソース差分 0 件の `create` / `update` のテキスト表示が `(変更なし)` から変わる(FR-5-7b)
- 同一リージョンで同一スタック名へ解決される設定が `ConfigError` になる(FR-11-10a)
- **CREATE 復旧の fail-closed 化**(FR-1 / FR-5-5b(iii))。従来は NoEcho・`dependsOn` を比較から除外し、警告のうえローカルの希望値で再同期していた。今後は検証不能な入力が 1 つでも残る場合(テンプレートに NoEcho パラメータがある、または `dependsOn` が空でない)は再同期せず失敗させ、`cfnsync import` を案内する。従来の挙動には、未適用の NoEcho 値を「適用済み」として記録し変更を永久に失う経路があった

**更新が必要な既存テスト**(新設計と矛盾するもの):

| ファイル・テスト名 | 理由 |
|---|---|
| `test/usecase/deploy.test.ts` `FR-5-2: 変更検知から実行まで依存順に非対話で一括実行する` | 既定が承認フローになったため `--auto-approve` を渡す形へ更新(FR-5-1 / FR-5-2b) |
| `test/usecase/deploy.test.ts` `FR-5-3: dry-run は差分 describe 後に変更セットを削除し、実行しない` | FR-5-9b により経路が `plan` 統一。意図は不変だが、Phase A の保持経路を通らないことの確認を追加 |
| `test/usecase/deploy.test.ts` `FR-5-4: *`(6 件) | 2 フェーズ化後もスタックごとの相対順序が不変であることの確認へ更新 |
| `test/usecase/deploy.test.ts` `FR-9-2(__REQUIRED__再レビュー⑥)` | FR-5-12b により `--on-failure continue` でも独立スタックを実行しない |
| `test/usecase/deploy.test.ts` の `--on-failure continue` 系 | Phase A ではなく **Phase B で失敗させる**シナリオへ組み替える |
| `test/cli/cli.test.ts` `FR-12-3: 非 TTY は --confirm 指定時もプロンプトなしで完走する` | 削除。FR-12-3a / FR-12-3b / FR-12-3c へ置換 |
| `test/cli/cli.test.ts` `FR-5-2: --confirm 指定かつ TTY の場合だけ確認する` | 削除。FR-12-8a / FR-12-8c へ置換 |
| `test/cli/cli.test.ts` `FR-12(JSONキャンセル)` / `FR-12(textキャンセル)` | FR-12-6c1 / FR-12-6c2 / FR-12-6c3 の新契約へ書き換え |
| `test/report/report.test.ts` のテキスト差分ゴールデン | FR-5-7b により 0 件 `create` / `update` の文言が変わる |
| `test/usecase/executor.test.ts` `FR-2-11: 再検査(listChangeSets)が ExecuteChangeSet の直前に配置される` | FR-5-17e により規範順序が DescribeStacks → ListChangeSets → fencing → Execute になる。順序アサーションの更新が必要 |
| `test/usecase/executor.test.ts` `FR-2-11(ARN再レビュー⑥): 同名でも ARN が差し替わっていれば実行を拒否する` | FR-5-17a(ARN)として維持。承認待ちを挟むシナリオを追加 |
| `test/usecase/recovery.test.ts` `FR-1-11(a) 検証不能入力: dependsOn/NoEcho を比較から除外し、希望 inputsHash と warnings を残す` | **意味が反転**。FR-1 / FR-5-5b(iii) により再同期せず fail-closed で失敗するテストへ書き換える |
| `test/usecase/recovery.test.ts` `FR-1-11(a): CREATE 成功+保存失敗後、全入力と管理タグが一致すれば再同期して state に記録する` | NoEcho / `dependsOn` を持たない fixture であることを明示し、検証可能な入力のみのケースとして維持 |
| `test/usecase/recovery.test.ts` の Default 補完系 3 件 | 対象が NoEcho / `dependsOn` を持たないことを前提として維持(持つ場合は fail-closed 側へ移す) |

| ID | 受け入れ基準(要約) | テストケース |
|---|---|---|
| FR-5-1 | 変更検知 → 順序解決 → 変更セット作成 → 差分表示 → 承認 → 実行を一連で行う | `FR-5-1: 依存のある 2 スタックが承認を挟んで全工程を依存順に通る` |
| FR-5-2a | 実行全体につき 1 回だけ承認を求め、承認後にだけ実行へ進む | `FR-5-2a: 3 スタックの実行で approve がちょうど 1 回だけ呼ばれ、承認後に全件が依存順で実行される` |
| FR-5-2b | `--auto-approve` は承認を求めずに実行する | `FR-5-2b: --auto-approve では approve が呼ばれずそのまま実行される` |
| FR-5-3 | `--dry-run` は差分表示までで停止する | `FR-5-3: --dry-run は ExecuteChangeSet を呼ばずに差分を出して終了する` |
| FR-5-4 | 進捗をスタックキー付きで stderr へ逐次出力し、承認を挟んでも相対順序を変えない | `FR-5-4: 2 スタックの承認フローで各スタックの phase 順序が維持され、全 diff-ready が最初の execute-start に先行する` |
| FR-5-5a | Phase A では `ExecuteChangeSet` / `DeleteStack` を行わない | `FR-5-5a: approve 呼び出し時点で全対象の CreateChangeSet が完了し ExecuteChangeSet・DeleteStack が 0 回` |
| FR-5-5b(i) | 空変更セットの再同期を Phase A で保存する | `FR-5-5b(i): 空変更セットの変更なし確認が Phase A で state へ再同期される` |
| FR-5-5b(ii) | 削除済みスタックの不在確認を Phase A で保存する | `FR-5-5b(ii): 既に存在しない削除対象の state エントリ除去が Phase A で保存される` |
| FR-5-5b(iii) | CREATE 復旧は検証不能な入力が無い場合にだけ Phase A で保存する | `FR-5-5b(iii): NoEcho なし・dependsOn 空の CREATE 復旧は Phase A で再同期される` |
| FR-5-5b(iii) fail-closed | NoEcho または dependsOn がある CREATE 復旧は保存せず失敗させる | `FR-5-5b(iii) fail-closed: NoEcho を持つスタックの CREATE 復旧は state を保存せず import を案内して失敗する` / `FR-5-5b(iii) fail-closed: dependsOn を持つスタックの CREATE 復旧も同様に失敗する` |
| FR-5-5b(fencing) | 再同期の保存も fencing 検証を経る | `FR-5-5b: 再同期の保存直前に fencing 検証が呼ばれ、所有権喪失時は保存されない` |
| FR-5-5b(CAS) | 再同期の保存も CAS を使う | `FR-5-5b: 再同期の保存が CAS で行われ、世代競合時は保存されず StateConflictError になる` |
| FR-5-5c | 実行の成功記録は Phase B でのみ保存する | `FR-5-5c: ExecuteChangeSet の成功記録は approve 前に保存されず承認後に保存される` |
| FR-5-6a | 承認要求に接続先を含める | `FR-5-6a: ApprovalRequest.connection に accountId と regions が入る` |
| FR-5-6b | 承認要求に操作種別を含める | `FR-5-6b: ApprovalRequest.diffs の各要素が create/update/delete の operation を持つ` |
| FR-5-6c | 承認要求にリソース単位の差分を含める | `FR-5-6c: ApprovalRequest.diffs の resources に Phase A で確定したリソース変更が入る` |
| FR-5-6d | 承認要求に Replacement 警告を含める | `FR-5-6d: Replacement: True のリソースが ApprovalRequest の警告と summary.replacements に現れる` |
| FR-5-6e | 承認要求に削除対象を `--allow-delete` の有無を明示して含める | `FR-5-6e: --allow-delete あり/なしで削除対象の提示が「削除する」/「警告のみ」と区別される` |
| FR-5-6f | 承認要約とプロンプト(入力エコー含む)は stderr へ出す | `FR-5-6f: 承認要約・プロンプト・入力エコーが stderr へ出力され stdout に現れない` |
| FR-5-6g | 承認要約にも report と同一の redactor を適用する | `FR-5-6g: NoEcho 実値を含む差分でも ApprovalRequest.diffs と承認要約に実値が現れない` |
| FR-5-7a | リソース差分 0 件で成功した変更セットを「変更なし」扱いにせず実行する | `FR-5-7a: Outputs のみ変更したスタックの 0 件変更セットは ExecuteChangeSet され Export が作成される` |
| FR-5-7b | 0 件であることが分かる表示にし、`no-change` と区別する | `FR-5-7b: 0 件の update は「変更あり」かつ「CloudFormation リソース差分 0 件」と表示され no-change 表示と一致しない` |
| FR-5-7c | 判別表示は create / update に限定し、削除プレビューを誤分類しない | `FR-5-7c: delete プレビュー(resources 空)は 0 件注記の対象にならない` / `FR-5-7c: plan / deploy の create/update/delete/no-change × 空 resources の境界で表示が正しい` |
| FR-5-7d | 判別はレンダラのみで行い `DeployReport` のデータを変えない | `FR-5-7d: 0 件 update の JSON は warnings 空・operation update のままベースラインと一致し、text 出力だけが変わる` |
| FR-5-8a | 実行予定が 0 件なら承認を求めない | `FR-5-8a: 全対象が変更なしの再実行では approve が呼ばれない`(NFR-3 冪等性の維持) |
| FR-5-8b | その場合も再同期を行い exit 0 で終了する | `FR-5-8b: 再同期のみ必要な実行は approve なしで state を同期して exit 0` |
| FR-5-9a | `--dry-run` / `plan` は承認を求めない | `FR-5-9a: deploy --dry-run と plan では approve が呼ばれない` |
| FR-5-9b | `--dry-run` は `plan` と同一の変更セットライフサイクルに従う | `FR-5-9b: --dry-run は describe 直後に自身の変更セットを削除し、Phase A の保持経路を通らない` |
| FR-5-10a | 拒否で事前作成した変更セットを全削除する | `FR-5-10a: 承認拒否で Phase A の全変更セットが ARN 指定で DeleteChangeSet される` |
| FR-5-10b | 拒否で承認対象の AWS 変更操作を 1 件も行わない | `FR-5-10b: 承認拒否で ExecuteChangeSet と DeleteStack が 0 回(変更セットの作成・削除と再同期保存は発生しうる)` |
| FR-5-10c | 拒否で未実行を `skipped` として報告し exit 0 | `FR-5-10c: 承認拒否で未実行スタックの outcome が skipped、exit 0` |
| FR-5-11 | 拒否後のクリーンアップ失敗は報告して exit 1 | `FR-5-11: 拒否後の DeleteChangeSet が失敗したら警告を報告し exit 1(次回の残存回収に委ねる)` |
| FR-5-12a | Phase A 失敗は承認を求めず中断し exit 1 | `FR-5-12a: Phase A の 1 件が失敗したら approve が呼ばれず exit 1` |
| FR-5-12b | `--on-failure continue` でも Phase A 失敗では Phase B へ進まない | `FR-5-12b: --on-failure continue でも Phase A 失敗では独立スタックを実行しない` / `FR-9-2(__REQUIRED__): 必須値不足は Phase A の失敗として実行全体を中断する` |
| FR-5-12c | 中断時に作成済み変更セットを全削除する | `FR-5-12c: Phase A 失敗で作成済みの変更セットが全削除される` |
| FR-5-13 | 承認手段がなければ AWS アクセス前に fail-closed | `FR-5-13: approve 未注入かつ --auto-approve なしは STS・backend・CFN を 1 度も呼ばず GuardError で exit 1` |
| FR-5-14a | 承認待ちの間ステートロックを保持する | `FR-5-14a: approve 呼び出し中にロックが保持されており release がまだ呼ばれていない` |
| FR-5-14b | 承認時点の差分と実行時点の実状態の一致を保証しない | (仕様明記 + FR-5-17 の防御で担保。FR-5-17a〜d の各テストが実体) |
| FR-5-15a | 依存先がこの実行で新規作成される場合も Phase A で変更セットを作成する | `FR-5-15a: この実行で create される依存先の Export を参照する対象も Phase A で CreateChangeSet され、承認は 1 回で済む` |
| FR-5-15b | `{{changeSet:KNOWN_AFTER_APPLY}}` はそのまま提示し独自解決しない | `FR-5-15b: 保留値 {{changeSet:KNOWN_AFTER_APPLY}} を承認要約と差分出力へそのまま出し、cfnsync 側で解決・補完しない` |
| FR-5-18 | 再同期の発生を deploy report へ機械可読に開示する | `FR-5-18: 再同期が発生した実行の JSON に stackKey・種別・stateUpdated を持つ reconciliations が現れる` / `FR-5-18: 承認拒否時も発生した再同期が JSON から復元できる` |
| FR-5-18(非発生) | 再同期が 0 件の実行には開示フィールドを含めない | `FR-5-18: 再同期が発生しない実行の JSON に reconciliations フィールドが存在しない` |
| FR-5-18(境界) | 初回 accountId 記録は開示の対象外 | `FR-5-18: 初回 accountId binding は reconciliations に現れない` |
| FR-5-16 | 2 フェーズ化で JSON の既存フィールドの構造・順序を変えない | `FR-5-16: --auto-approve の deploy JSON が 2 フェーズ化前のベースラインと connection/diffs/events/result で一致する` |
| FR-5-17a(name) | 実行直前に自変更セットの name 一致を再検査する | `FR-5-17a: 承認後に自変更セットの name が差し替わっていたら ExecuteChangeSet を呼ばず停止する` |
| FR-5-17a(ARN) | 実行直前に自変更セットの ARN 一致を再検査する | `FR-5-17a: 承認後に同名で ARN が差し替わっていたら ExecuteChangeSet を呼ばず停止する` |
| FR-5-17a(他主体) | 実行直前に他主体の変更セットが存在しないことを再検査する | `FR-5-17a: 承認後・実行前に他主体の変更セットが現れたら ExecuteChangeSet を呼ばず停止する` |
| FR-5-17b | 実行直前に `stackId` を state と再照合する | `FR-5-17b: 承認待ち中にスタックが差し替えられ stackId が変わったら UPDATE を実行せず停止する` |
| FR-5-17c(UPDATE) | UPDATE は allowlist の実行可能終端状態であることを必須とする | `FR-5-17c: 承認待ち中に対象スタックが UPDATE_IN_PROGRESS になったら実行せず停止する` / `FR-5-17c: 承認待ち中に ROLLBACK_COMPLETE へ遷移したら allowlist 外として実行せず停止する` |
| FR-5-17c(CREATE) | CREATE は自変更セットに対応する `REVIEW_IN_PROGRESS` の殻であることを必須とする | `FR-5-17c: 承認待ち中に CREATE の殻が別スタックへ差し替えられたら実行せず停止する` |
| FR-5-17e | 再検査は DescribeStacks → ListChangeSets → fencing → ExecuteChangeSet の順で行う | `FR-5-17e: 実行直前の呼び出し順序が DescribeStacks → ListChangeSets → verifyLock → ExecuteChangeSet に固定される` |
| FR-5-17d | 実行直前にロック所有権を再検証する | `FR-5-17d: 承認待ち中に force-unlock され所有権を失ったら以降の副作用を行わず中断する` |
| FR-3-7a | 承認要約は差分本体と同じ色付け・無色化の規則に従う | `FR-3-7a: 承認要約は既定で ANSI 色付き、--no-color / NO_COLOR で無色化される` |
| FR-3-7b | `--output json` でも承認要約は stderr へ出し stdout の JSON を変えない | `FR-3-7b: 承認要約は --output json でも stderr へ出し stdout の単一 JSON を汚さない` |
| FR-11-10a | 同一 (リージョン, スタック名) へ解決される設定を AWS アクセス前に `ConfigError` で拒否する | `FR-11-10a: 同一リージョンで同じ stackName に解決される 2 スタックは対象キーを含む ConfigError で拒否される(AWS 呼び出し 0 回)` |
| FR-11-10b(delete+create) | delete と create が同一物理スタックを指す場合に拒否する | `FR-11-10b: テンプレートパス変更で delete(旧 state)+create(新 config)が同一 (region, stackName) を指す場合、AWS 副作用前に fail-closed で拒否しリネーム移行を案内する` |
| FR-11-10b(正常系: 異名) | 異なるスタック名へのリネームは拒否しない | `FR-11-10b(正常系): 異名リネーム(delete 旧名 + create 新名)は拒否されない` |
| FR-11-10b(正常系: 多region) | 同一スタック名を複数リージョンへ配る構成は拒否しない | `FR-11-10b(正常系): 同一 stackName を 3 リージョンへ配る構成は拒否されない` |
| FR-11-10b(正常系: override) | `--region` 上書き後の再検証で正常系を誤判定しない | `FR-11-10b(正常系): --region による既定リージョン上書き後も正常な構成は拒否されない` |
| FR-11-10b(正常系: prefix) | `stackNamePrefix` 由来の導出でも正常系を誤判定しない | `FR-11-10b(正常系): stackNamePrefix から導出した異なるスタック名は拒否されない` |
| FR-12-3a | すべてのコマンドが TTY なしで動作する | `FR-12-3a: 非 TTY で status / plan / graph / import / force-unlock / deploy --auto-approve が完走する` |
| FR-12-3b | 非 TTY + `--auto-approve` なしの deploy は AWS 前に `CliUsageError` で exit 1 | `FR-12-3b: 非 TTY の deploy(--auto-approve なし)は AWS クライアントを 1 度も生成せず CliUsageError で exit 1` / `FR-12-3b: 非 TTY でも deploy --dry-run と plan はエラーにならない` |
| FR-12-3c | 変更 0 件の非 TTY 実行も同様にエラーになる | `FR-12-3c: 変更が 1 件もない非 TTY の deploy も --auto-approve なしでは CliUsageError で exit 1` |
| FR-12-6c1 | JSON 選択の拒否は `cancelled: true` 付き deploy report を stdout へ 1 個、exit 0 | `FR-12-6c1: 承認拒否は cancelled:true 付き deploy report を stdout に 1 個出して exit 0(diffs と skipped を保持)` |
| FR-12-6c2 | text 選択の拒否は stderr にキャンセル文 + stdout に deploy report、exit 0 | `FR-12-6c2: text 選択では stderr に Deployment cancelled. を出し stdout に report を出して exit 0` |
| FR-12-6c3 | 旧専用 payload の `exitCode` / `message` は拒否 result に存在しない | `FR-12-6c3: 拒否実行の JSON に exitCode と message フィールドが存在しない` |
| FR-5-16(cancelled) | 拒否していない実行の JSON に `cancelled` を含めない | `FR-5-16: 成功した deploy の JSON に cancelled フィールドが存在しない(既存 schema 互換)` |
| FR-12-8a | `deploy --help` に `--auto-approve`(`-y`)を含める | `FR-12-8a: deploy の help に --auto-approve と -y が表示される` |
| FR-12-8b | `--auto-approve` を他サブコマンドへ提供しない | `FR-12-8b: plan を含む他サブコマンドの help に --auto-approve がない` |
| FR-12-8c | `--confirm` は廃止し `CliUsageError` にする | `FR-12-8c: --confirm は CliUsageError で exit 1` |
| FR-12-4(穴埋め) | `-v` / `--version` が `package.json` の version を表示し exit 0(T-19 で未検証だった短縮形と値の一致) | `FR-12-4: -v と --version が package.json の version を表示して exit 0` |
| §5.3.1(殻) | 承認拒否で残る `REVIEW_IN_PROGRESS` の殻へ `DeleteStack` を呼ばない | `§5.3.1: CREATE 対象の承認拒否後も DeleteStack が呼ばれず、次回実行の prepareStack が殻を回収して収束する` |
| §5.3.3(収束) | 承認拒否を挟んでも再同期による自動収束が完了する | `§5.3.3: AWS 操作成功・state 保存失敗の状態から、承認拒否を挟む実行でも再同期が保存され次回実行が unchanged になる` |

## 10. テスト対象外(ドキュメント・構造で満たす)受け入れ基準の一覧

| ID | 満たし方 |
|---|---|
| FR-1-5 | T-20(README) |
| FR-7-4 | 構造的要件: クレデンシャル保存コードを持たない(コードレビューで担保) |
| FR-11-4 | 構造的要件: YAML 採用 |
| FR-9-3 | 設計制約: 直列実行+順序付き計画構造(T-07 で構造のみ確認) |
| FR-2-11(運用規約部分) / FR-1-9(仕様明記部分) | requirements.md / design.md に明記済み + T-20(README) |
| FR-5-14b(TOCTOU の仕様明記部分) | requirements.md FR-5-14b / design.md §5.3 に明記済み + T-20(README。承認待ち中のロック保持と残余リスク) |
| NFR-1 / NFR-6 | アーキテクチャ(§3)で構造的に満足。NFR-1 の出力分離のみ T-19 でテスト |
| NFR-5(規模) | 数十テンプレート規模の fixture で全体テストが実用時間内に完走することを CI で観測(専用テストは設けない) |

## 11. Codex レビュー承認時の実装条件との対応

| 指摘 | 対応タスク |
|---|---|
| `ListChangeSets` の全ページ走査を受け入れテストで固定 | T-08 |
| 再検査が必ず `ExecuteChangeSet` の直前に配置されることを受け入れテストで固定 | T-13(呼び出し順序の検証)+ T-18(並行追加シナリオ) |
| README に §11 の運用規約と手動検証手順を実装完了条件として反映 | T-20 |

## 12. 進捗チェックリスト

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
- [x] T-20 README・運用ドキュメント
- [x] T-21 npm パッケージング
- [ ] T-22 deploy 承認フロー(差分表示 → 承認 → 実行)
