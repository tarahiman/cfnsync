# Architecture Decision Records

ADR は、現在の要件・設計に至った**判断理由**とトレードオフを残す。現行の振る舞いは
[要件定義](../spec/requirements.md)、現在の実現方法は[設計書](../spec/design.md)が規範 SoT であり、
ADR だけでこれらを変更しない。

## 一覧

| ADR | 状態 | 判断 |
|---|---|---|
| [ADR-0001](./0001-deploy-approval-flow.md) | Accepted | `deploy` を全差分確定後の一括承認フローとし、計画失敗を fail-closed にする |
| [ADR-0002](./0002-create-recovery-fail-closed.md) | Accepted | 検証不能入力がある CREATE 復旧を自動再同期しない |
| [ADR-0003](./0003-pending-stack-deletions.md) | Accepted | リネームで残った旧スタックをステートの削除待ち(`pendingDeletions`)として追跡する |
| [ADR-0004](./0004-index-signature-access-notation.md) | Accepted | 既知の索引シグネチャキーにドット記法を採用し、相互排他の TypeScript オプションを採用しない |

## 運用

- 長期間維持する構造、安全性、互換性、運用上のトレードオフに ADR を使う。
- 単純なバグ修正、短期の実装メモ、リリース間差分だけなら ADR は不要である。
- 採用後の ADR 本文は判断時点の記録として書き換えず、判断を変える場合は新しい ADR で supersede する。
- ADR と要件・設計が矛盾した場合は、現行の要件・設計を優先し、ADR の状態・参照を更新する。
- 新規 ADR は [template.md](./template.md) を複製し、4 桁の連番を付ける。
