# コーディング規約

この文書は規範文書ではない。利用者から観測可能な振る舞いは
[要件定義](./spec/requirements.md)、それを実現する現在の構造は
[設計書](./spec/design.md)を正とする。この文書には本リポジトリ固有の実装規約と、
リンタでは表現できない反復的なレビュー観点を置く。

各項目には **機械強制** または **レビュー観点** を明記する。規約をリンタで表現できるように
なった場合は `biome.json` または TypeScript 設定へ移し、機械強制へ変更する。

## 1. 層の依存方向

- **機械強制**: 依存方向は `cli → usecase → core / ports / report` とし、`aws` と
  `backend` は `ports` を実装する。`biome.json` のレイヤー別
  `style/noRestrictedImports` override で強制する。規約を変える場合は同じ変更で override も
  更新する。
- **機械強制**: `src/core/` は AWS SDK と外側の層を import しない。
  `style/noRestrictedImports` で強制する。
- **レビュー観点**: `src/core/` は `node:fs` やプロセス状態にも依存せず、純粋なロジックに
  限る。Biome では副作用の有無まで判定できないためレビューする。

## 2. モジュール分割の閾値

- **機械強制**: `src/` の現状壁は、認知的複雑度 64、1 関数 365 行、1 ファイル
  2233 行とする。`biome.json` の `complexity/noExcessiveCognitiveComplexity`、
  `complexity/noExcessiveLinesPerFunction`、`nursery/noExcessiveLinesPerFile` で強制する。
- **レビュー観点**: 目標値は認知的複雑度をまず 25、最終的に 15、1 関数 50 行、
  1 ファイル 300 行とする。壁に当たったらコードを分割し、閾値は決して上げない。
  リファクタリングのたびに、違反ゼロを保てる最小値まで壁を下げる。
- **レビュー観点**: `src/usecase/deploy.ts` は既知の負債であり、#27 / #28 で分割する。
  純粋な判定・整形は `core/`、AWS 副作用を含む処理は `usecase/` に置き、SDK 呼び出しは
  `ports` 越しにする。各 issue の受入条件に、対応する閾値を下げることを含める。
- **機械強制**: 構造の異なる `test/**` には、認知的複雑度 9、1 関数 1575 行、
  1 ファイル 2863 行の別壁を適用する。既存の受入テスト構成を一括変更せず、悪化を防ぐための
  ラチェットとして `biome.json` の test override で強制する。3 壁とも「今日ゼロ違反になる
  最小値」を実測した値であり(`test/usecase/recovery.test.ts` の複雑度 9、
  `test/usecase/deploy.test.ts` の関数行数 1575、`test/usecase/approval.test.ts` の
  ファイル行数 2863)、Biome の組み込み既定値をそのまま採用した箇所はない。

### 壁とラチェット issue の対応表

壁は、対応する分割 issue が完了して実測値が下がるたびに、その新しい実測値まで下げる。
下表は「どの issue が完了したら、どの壁を再測定すべきか」の対応であり、Issue 側の
受け入れ条件チェックボックスを本 PR が更新するわけではない(次段落参照)。

| 壁 | 現状値 | 主な違反ファイル | 完了で再測定すべき issue |
|---|---:|---|---|
| `src` 認知的複雑度 | 64 | `usecase/deploy.ts`(`runLocked`) | #27 / #28 |
| `src` 認知的複雑度(その他上位) | 64 | `report/index.ts`、`usecase/importer.ts`、`aws/cloudformation.ts`、`core/graph.ts` | #30、#27、#34、#33 |
| `src` 1 関数の行数 | 365 | `usecase/deploy.ts` | #27 / #28 |
| `src` 1 ファイルの行数 | 2233 | `usecase/deploy.ts`(2,321 行) | #27 / #28 |
| `test` 認知的複雑度 | 9 | `test/usecase/recovery.test.ts`(`deploy` の CREATE 復旧シナリオ) | `usecase/deploy.ts` を分割する #27 / #28 |
| `test` 1 関数の行数 | 1575 | `test/usecase/deploy.test.ts` | #27 / #28(分割後にテストも追随して分割された場合) |
| `test` 1 ファイルの行数 | 2863 | `test/usecase/approval.test.ts` | 現時点で対応する分割 issue なし(新規 issue が必要) |

**Issue 側の受け入れ条件は本 PR では更新していない。** #25 自身の受け入れ条件は
「各リファクタ issue の受け入れ条件に『閾値を下げる』が含まれている」ことを求めるが、
2026-09 時点で `gh issue view` を確認したところ、この文言があるのは #27 のみで、
#28 / #30 / #32 / #33 / #34 / #35 / #36 の受け入れ条件には含まれていない。GitHub Issue
の編集はコードレビューの対象である PR の変更範囲外であり、この PR から 7 件の Issue 本文を
書き換えることはしない。したがって #25 のこの受け入れ条件は **未達のまま**であることを
明記する。上表がその代替の記録であり、各分割 PR のレビュー時にここを参照して壁を
下げることを運用で徹底する。

## 3. ヘルパーを抽出する条件

- **レビュー観点**: 同じ判定が 3 箇所以上に現れたときに抽出する。2 箇所の重複は許容する。
- **レビュー観点**: テストから直接呼びたくなったことは、テスト容易性を高める分割の根拠とする。
- **レビュー観点**: 1 箇所からしか呼ばれない薄いラッパーは作らない。

次の処理は重複に見えても、それぞれ異なる安全条件または出力契約を守るため統合・削除しない。

- **レビュー観点**: `requireManagedStackIdentity` の 3 回の呼び出しは、それぞれ別の副作用を
  保護する（設計書 §4.3）。
- **レビュー観点**: CFN ステータスの `UPDATE_EXECUTABLE`、`DELETABLE`、`ROLLBACK`、
  成功終端の 4 集合は統合しない。和集合は削除・実行の安全条件を緩める。
- **レビュー観点**: importer の `publicWarningMessage` と `textDiagnosticMessage` は統合しない。
  FR-12-6b が JSON と text に異なる本文を要求する。
- **レビュー観点**: `assertRegionsAllowed` のロック前と計画後の 2 回の呼び出しは削らない。
  後者は `deleted` の旧リージョンを再照合する（FR-13-8）。
- **レビュー観点**: `emitProgress` が例外を握り潰すのは FR-5-4 の意図的な設計である
  (`onProgress` は観測専用ポートであり、配送障害で AWS 操作・クリーンアップ・最終 report の
  制御フローを変えないため。`src/usecase/deploy.ts` の `emitProgress` 自身の doc comment も
  FR-5-4 を引用する。FR-5-19a は `DeployDeps.approve` が reject/throw した場合の変更セット
  削除という別要件であり、本項とは無関係)。

## 4. エラー処理

- **レビュー観点（導入延期）**: 例外を再 throw するときは `cause` を保持する。
  `nursery/useErrorCause` は現状の違反ファイルの一部が本 batch の変更対象外にあるため
  有効化しない。詳細な内訳と正確な担当は [§8](#8-意図的に採用しないルール) を参照。
- **機械強制**: `Error` 以外を throw しない。`style/useThrowOnlyError` で強制する。
- **レビュー観点**: 「警告して継続」は安全不変条件の緩和である。
  [仕様管理ガイド](./spec/README.md#安全不変条件の変更)の手続きなしに導入しない。

## 5. 出力

- **機械強制**: CLI メッセージは英語とする（NFR-7）。
  `scripts/check-message-language.mjs` で強制する。
- **機械強制**: `src/` で `console.*` を使わない。出力は `src/cli/index.ts` の
  stdout / stderr ポート経由に集約し、`suspicious/noConsole` で強制する。
- **機械強制**: 実制御文字をソースに埋め込まない。
  `scripts/check-control-chars.mjs` で強制する。
- **レビュー観点**: NoEcho の秘匿は `src/report` の whitelist 再構築で担保する。
  レポート型へフィールドを追加した場合は `renderText` と `renderJson` の両方を更新する。

## 6. 型とアクセス記法

- **機械強制**: `Record<string, unknown>` の既知の文字列キーへのアクセスはドット記法に統一する。
  `complexity/useLiteralKeys` を採用し、相互排他となる TypeScript の
  `noPropertyAccessFromIndexSignature` は採用しない。判断理由は
  [ADR-0004](./decisions/0004-index-signature-access-notation.md)に記録する。
- **機械強制**: 型のみの import は `import type` を使う。TypeScript の
  `verbatimModuleSyntax` で強制する。
- **機械強制**: 非 null アサーション `!` は `src/` では使わない。
  `style/noNonNullAssertion` で強制し、テストに限って override する。

## 7. テスト

- **機械強制**: 受入基準 ID を対応するテスト名に含める。
  `scripts/check-spec-ids.mjs` で強制する。
- **機械強制**: テストも `tsconfig.test.json` で型検査し、実 AWS へアクセスしない。
  前者は `quality:check` で強制し、後者は fake / mock によるテスト構成で強制する。
- **レビュー観点**: AWS SDK の部分モックは共通の partial helper を使い、テストごとの
  `as` キャストを増やさない。
- **レビュー観点**: `StackSummary`、`ChangeSetDetail`、`StackEntry`、`CfnSyncConfig` を
  テスト内で直接リテラル生成せず、`test/support/builders.ts` を使う。
- **レビュー観点**: ports の fake はテストファイル内のオブジェクトリテラルで実装しない。

## 8. 意図的に採用しないルール

- **レビュー観点（不採用）**: `performance/noAwaitInLoops` は採用しない。
  CloudFormation の依存順に逐次実行することが要件であり、機械的な並列化は安全不変条件に反する。
以下は、各ルールの現在の違反ファイルを実測し、2026-09 時点でオープン中の分割 PR
(#43 → #33 / #44 → #34 / #45 → #30・#35 / #46 → #36 / #47 → #27・#28)の実際の diff
(`gh pr diff <n> --name-only`)と突き合わせて記録した、ルールごとの正確な内訳である。
「違反箇所がすべて他 PR の所有ファイルにある」という一括の説明は不正確だったため、
ルールごとに分けて記載する。

> [!NOTE]
> **以下の PR 番号による帰属は、この文書を書いた時点のスナップショットである。**
> 分割 PR は互いに進行中であり、レビュー対応で新しいファイルが diff に入ることがある
> (実例: PR #44 はレビュー指摘への対応で `src/core/errors.ts` と `src/backend/local.ts` を
> 後から diff に加えた)。恒久的な根拠は**担当 issue 番号**の側であり、PR 番号は着手時に
> `gh pr diff <n> --name-only` で再確認すること。
> なおファイルが他 PR の diff に**入る**方向のドリフトは衝突リスクを増やすだけなので、
> 「見送る」という判断自体が覆ることはない。

- **レビュー観点（導入延期）**: `nursery/noShadow` は違反が `src/usecase/deploy.ts`
  (PR #47, #27 / #28)と `src/cli/commands.ts`(PR #45, #35)にあり、いずれも現在オープン中の
  PR の実際の diff に含まれる。両 PR のマージ後に再測定して有効化する。
- **レビュー観点（導入延期）**: `style/noExportedImports` は違反が `src/usecase/cliBoundary.ts`
  (PR #45, #35)にのみあり、同 PR の diff に含まれる。マージ後に有効化する。
- **レビュー観点（導入延期・要修正）**: `nursery/noUnnecessaryConditions` の違反は
  `src/usecase/executor.ts:155` の 1 件のみだが、この行は #43〜#47 のどの PR の diff にも
  含まれていない。Issue #32 が対象として言及しているが、#32 に対応する PR はまだ存在しない。
  つまり「他 PR が所有している」のではなく、単に着手前で本 batch のファイル所有権
  (`biome.json` / `docs/**` / `CONTRIBUTING.md` / `src/core/template.ts`)の外にあるため
  この PR からは直せない。
- **レビュー観点（導入延期・要修正）**: `nursery/noExcessiveClassesPerFile` の違反は
  `src/core/errors.ts:6` の 1 件のみだが、この行も #43〜#47 のどの PR の diff にも
  含まれていない。ファイル分割が必要という記載のみで、対応する issue 番号は未採番。
  上記と同じ理由で本 PR からは直せない。
- **レビュー観点（導入延期）**: `nursery/useErrorCause` の違反 15 件のうち、
  `core/config.ts` / `core/state.ts`(PR #43, #33)、`usecase/deploy.ts`(PR #47, #27 / #28)、
  `aws/s3state.ts`(PR #44, #34)は現在オープン中の PR の diff に含まれる。残る
  `core/template.ts` / `backend/local.ts` / `cli/filesystem.ts`(2 件)/ `usecase/delete.ts` / `usecase/guard.ts` /
  `usecase/importer.ts` は、#43〜#47 のどの PR の diff にも含まれておらず、対応する
  follow-up issue も未採番である。これらについてのみ「他 PR の所有ファイル」という
  説明は成立せず、新規 issue が必要な状態のまま残っている。
  なお有効化を検討する際は、**Biome 2.3.13 の当該ルールがショートハンドの `{ cause }` を
  「cause 未指定」と誤検知する**(明示形 `{ cause: cause }` は通る)ことに注意する。
  ルールのバグ回避のために本番コードを冗長な書き方へ変えるべきではないので、
  有効化は Biome 側の修正を確認してから行う。
- **レビュー観点（導入延期）**: `nursery/useMaxParams` の違反のうち、`core/state.ts:272`
  (PR #43, #33)と `usecase/deploy.ts` の 6 件(PR #47, #27 / #28)は現在オープン中の PR の
  diff に含まれる。`usecase/executor.ts:382` の 1 件は、`noUnnecessaryConditions` と同じ
  理由でどの PR の diff にも含まれておらず、この PR からは直せない。
- **レビュー観点（導入延期）**: `nursery/noUselessUndefined` の違反のうち、
  `aws/cloudformation.ts` / `aws/s3state.ts`(PR #44, #34)と `core/graph.ts`(PR #43, #33)は
  現在オープン中の PR の diff に含まれる。`aws/errors.ts` と `backend/local.ts` は、
  上記と同じ理由でどの PR の diff にも含まれておらず、この PR からは直せない。

## 9. この文書の運用

- **レビュー観点**: 同じ指摘を 2 回したら、この文書へ追加する。
- **レビュー観点**: 追加時に、機械強制できるかを確認する。機械強制できる規約は設定も同時に
  変更し、この文書には強制手段を記す。
- **レビュー観点**: この文書は規範仕様を暗黙に上書きしない。外部挙動または設計を変える場合は
  [仕様変更の流れ](./spec/README.md#仕様変更の流れ)に従う。
