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
- **機械強制**: 構造の異なる `test/**` には、認知的複雑度 15、1 関数 1575 行、
  1 ファイル 2863 行の別壁を適用する。既存の受入テスト構成を一括変更せず、悪化を防ぐための
  ラチェットとして `biome.json` の test override で強制する。

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
- **レビュー観点**: `emitProgress` が例外を握り潰すのは FR-5-19a の意図的な設計である。

## 4. エラー処理

- **レビュー観点（導入延期）**: 例外を再 throw するときは `cause` を保持する。
  `nursery/useErrorCause` の既存違反が複数の並行変更対象にあるため、この batch では有効化しない。
  `deploy.ts` の違反は #27 / #28 で解消し、その他は対象ファイルごとの follow-up issue で扱う。
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
- **レビュー観点（導入延期）**: `nursery/noShadow` は #27 / #28 の `deploy.ts` と #35 の
  `commands.ts` の変更で解消する。
- **レビュー観点（導入延期）**: `style/noExportedImports` は #35 の `cliBoundary.ts` の変更で
  解消する。
- **レビュー観点（導入延期）**: `nursery/noUnnecessaryConditions` は #32 で
  `executor.ts` の死んだ防御条件を確認してから扱う。
- **レビュー観点（導入延期）**: `nursery/noExcessiveClassesPerFile` は `core/errors.ts` の責務を
  扱う follow-up issue で解消する。
- **レビュー観点（導入延期）**: `nursery/useErrorCause`、`nursery/useMaxParams`、
  `nursery/noUselessUndefined` は、#27 / #28 の `deploy.ts` 分割部分と、各残存ファイルを所有する
  follow-up issue で解消する。この batch では並行作業中のファイルを変更しない。

## 9. この文書の運用

- **レビュー観点**: 同じ指摘を 2 回したら、この文書へ追加する。
- **レビュー観点**: 追加時に、機械強制できるかを確認する。機械強制できる規約は設定も同時に
  変更し、この文書には強制手段を記す。
- **レビュー観点**: この文書は規範仕様を暗黙に上書きしない。外部挙動または設計を変える場合は
  [仕様変更の流れ](./spec/README.md#仕様変更の流れ)に従う。
