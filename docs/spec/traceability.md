# 要件トレーサビリティ

本書は、[要件定義](./requirements.md)から[設計](./design.md)、実装、受入テストへ辿るための**索引**である。
要件や設計を新たに定義する規範文書ではない。詳細な T-01〜T-22 の受入基準→テストケース対応表は
[実装記録](./tasks.md)に保存しており、本書からその証跡を失わず参照できる。

## 現行トレーサビリティ

| 要件 | 主な設計箇所 | 主な実装 | 主な受入テスト・証跡 |
|---|---|---|---|
| FR-1 変更検知・ステート | §4.3〜§4.5, §7 | `core/detect`, `core/state`, `backend/local`, `aws/s3state`, `usecase/deploy` | `test/core/detect.test.ts`, `test/core/state.test.ts`, `test/backend/local.test.ts`, `test/aws/s3state.test.ts`, `test/usecase/recovery.test.ts`, `test/usecase/concurrency.test.ts` |
| FR-2 変更セット作成 | §7, §8.4 | `usecase/executor`, `aws/cloudformation` | `test/usecase/executor.test.ts`, `test/aws/cloudformation.test.ts`, `test/usecase/concurrency.test.ts` |
| FR-3 差分表示 | §5.2, §9 | `report`, `usecase/deploy` | `test/report/report.test.ts`, `test/usecase/approval.test.ts`, `test/cli/cli.test.ts` |
| FR-4 デプロイ実行 | §5.3, §7, §9 | `usecase/deploy`, `usecase/executor`, `report` | `test/usecase/deploy.test.ts`, `test/usecase/executor.test.ts`, `test/report/report.test.ts` |
| FR-5 一括実行・承認 | §5.3〜§5.3.4 | `usecase/deploy`, `ports`, `report`, `cli` | `test/usecase/approval.test.ts`, `test/usecase/deploy.test.ts`, `test/cli/cli.test.ts` |
| FR-5-19 承認処理失敗 | §5.3, §5.3.3 | `usecase/deploy` | `test/usecase/approval.test.ts` (`FR-5-19a`〜`FR-5-19i`) |
| FR-5-20 差分確認の `plan` 一本化 | §3, §5.2, §5.3.5 | `cli/index`(`plan` / `deploy` のオプション定義), `usecase/deploy`(内部 `DeployOptions.dryRun`) | `test/cli/cli.test.ts` (`FR-12-8d`), `test/usecase/deploy.test.ts` (`FR-5-20b`〜`FR-5-20d`), `test/usecase/approval.test.ts` (`FR-5-20b`, `FR-5-20c`) |
| FR-6 削除 | §5.3, §8.3 | `core/graph`, `usecase/delete`, `usecase/deploy` | `test/core/graph.test.ts`, `test/usecase/delete.test.ts`, `test/usecase/approval.test.ts` |
| FR-7 認証・接続 | §8.1 | `usecase/guard`, `aws/sts` | `test/usecase/guard.test.ts`, `test/aws/sts.test.ts` |
| FR-7-9 リージョン解決 | §3, §4.2, §11 | `cli/commands`(`effectiveRegion`), `aws/sts`, `aws/cloudformation` | `test/cli/cli.test.ts` (`FR-7-9a`〜`FR-7-9d`), `test/aws/sts.test.ts` (`FR-7-9d`) |
| FR-8 依存マッピング | §5.5, §6 | `core/template`, `core/graph`, `usecase/status-graph` | `test/core/template.test.ts`, `test/core/graph.test.ts`, `test/usecase/status-graph.test.ts` |
| FR-9 依存順デプロイ | §5.3, §6 | `core/plan`, `usecase/deploy` | `test/core/plan.test.ts`, `test/usecase/deploy.test.ts`, `test/usecase/approval.test.ts` |
| FR-10 インポート | §5.4 | `usecase/importer` | `test/usecase/importer.test.ts`, `test/cli/cli.test.ts` |
| FR-11 設定ファイル | §4.2 | `core/config`, `core/dependency`, `core/templatePath` | `test/core/config.test.ts`, `test/usecase/deploy.test.ts`, `test/usecase/importer.test.ts` |
| FR-12 CLI | §3, §5, §9 | `cli`, `report`, `usecase/cliBoundary` | `test/cli/cli.test.ts`, `test/core/errors.test.ts` |
| FR-13 マルチリージョン | §4.1, §4.2, §5, §6 | `core/config`, `core/detect`, `core/graph`, `core/plan`, `usecase/deploy` | `test/core/config.test.ts`, `test/core/detect.test.ts`, `test/core/graph.test.ts`, `test/core/plan.test.ts`, `test/usecase/deploy.test.ts` |
| NFR-1 CI/CD | §3, §9, §11 | `cli`, `report` | `test/cli/cli.test.ts`, `test/report/report.test.ts`, README / GitHub Actions 例 |
| NFR-2 テスト容易性 | §3, §10 | `core`, `ports`, adapters | AWS 非接続の全 Vitest suite、ports の型境界 |
| NFR-3 信頼性・冪等性 | §4.3〜§4.5, §7, §9 | state backends, `usecase/deploy`, `usecase/executor` | `test/usecase/recovery.test.ts`, `test/usecase/concurrency.test.ts`, backend / AWS adapter tests |
| NFR-4 セキュリティ | §8.1, §8.2, §9 | `usecase/redactor`, `report`, `usecase/guard` | `test/usecase/redactor.test.ts`, `test/report/report.test.ts`, `test/usecase/guard.test.ts`, `test/cli/cli.test.ts` |
| NFR-5 パフォーマンス | §7, §9, §10 | `aws/cloudformation`, local-only status / graph path | `test/aws/cloudformation.test.ts`, `test/usecase/status-graph.test.ts`, CI での suite 実行時間観測 |
| NFR-6 保守性 | §3, §10 | ports & adapters の依存境界 | ディレクトリ構造・依存レビュー、`pnpm run build` |

設計節番号は [design.md](./design.md) を指す。テストファイル内では、個々の `it(...)` 名に `FR-*` / `NFR-*`
または設計節 ID を含め、サブ基準単位の証跡を検索できるようにする。

```sh
rg -n "FR-5-17|NFR-4" docs/spec src test
```

## 詳細対応表と例外

- T-01〜T-22 の成果物、受入基準ごとのテストケース名、文書・構造で満たす基準は
  [tasks.md](./tasks.md) に残す。これは**過去の実装記録と詳細証跡**であり、振る舞いの規範 SoT ではない。
- 自動テストにできない運用規約・構造的要件は、`tasks.md` の
  「テスト対象外(ドキュメント・構造で満たす)受け入れ基準の一覧」で検証方法を確認する。
- テストと要件が矛盾した場合、「テストが green だから現行仕様」と解釈しない。
  [仕様管理ガイド](./README.md)の優先順位に従い、要件・設計を確認してから不一致を修正する。

## 更新ルール

仕様追加・変更では、同じ PR で次を更新する。

1. `requirements.md` の安定 ID 付き受入基準
2. `design.md` の実現箇所
3. 本書の索引行または対象ファイル
4. ID を含む受入テスト
5. 自動化できない場合の検証方法

新規の実装計画や進捗チェックリストを `tasks.md` へ追記しない。作業は Issue / PR で管理し、複数段階の
仕様変更では [変更提案](../changes/README.md)を用いる。
