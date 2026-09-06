# cfnsync ドキュメントガイド

このディレクトリは、現行仕様、設計判断、検証証跡、変更履歴を役割ごとに分けて管理する。
仕様変更に着手するときは、まず [仕様管理ガイド](./spec/README.md) を参照すること。

## 読み手別の入口

| 読み手・目的 | 参照先 | 役割 |
|---|---|---|
| cfnsync を使う | [README](../README.md), [設定リファレンス](./config-reference.md) | コマンド、設定、運用、安全上の注意 |
| 現在の振る舞いを確認する | [要件定義](./spec/requirements.md) | 外部から観測可能な振る舞いと制約の規範 SoT |
| 現在の実現方法を確認する | [設計書](./spec/design.md) | 要件を満たす構造、アルゴリズム、安全設計の規範 SoT |
| 要件から実装・テストを追う | [トレーサビリティ](./spec/traceability.md) | 要件 → 設計 → 受入テストの索引 |
| コードの書き方とレビュー基準を確認する | [コーディング規約](./coding-standards.md) | 機械強制とレビュー観点を区別した実装規約 |
| 過去の判断理由を確認する | [ADR](./decisions/README.md) | 採用案、代替案、トレードオフの記録 |
| リリース間の変更を確認する | [CHANGELOG](../CHANGELOG.md) | 利用者向けの変更履歴と移行手順 |
| 仕様変更を提案する | [変更提案ガイド](./changes/README.md) | 未確定の提案、影響分析、実装への引き継ぎ |

## 文書の区分

- **現行仕様**: `docs/spec/requirements.md` と `docs/spec/design.md`。現在形だけを記述する。
- **検証証跡**: `docs/spec/traceability.md`、受入テスト、`docs/spec/tasks.md`。仕様を上書きしない。
- **実装規約**: `docs/coding-standards.md`。コードの書き方とレビュー基準を扱い、現行仕様を定義しない。
- **意思決定履歴**: `docs/decisions/`。なぜその設計を選んだかを残すが、現行仕様の定義には使わない。
- **変更履歴**: `CHANGELOG.md` / `CHANGELOG.en.md`。リリース間の差分と移行方法を利用者向けに残す。
- **変更提案・作業**: GitHub Issue / PR と `docs/changes/`。採用・マージされるまでは仕様ではない。

文書間で矛盾した場合の優先順位と、変更時に同時更新すべき成果物は
[仕様管理ガイド](./spec/README.md) に定義する。
