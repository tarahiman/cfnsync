# 仕様変更提案

このディレクトリは、複数の要件・設計・移行へまたがる変更を実装前に整理するために使う。
軽量なバグ報告や単一箇所の修正は GitHub Issue だけでよい。

変更提案は**未確定**であり、[要件定義](../spec/requirements.md)や[設計書](../spec/design.md)を上書きしない。
採用後は要件・設計を更新し、長期的な判断理由がある場合だけ [ADR](../decisions/README.md)を追加する。

## 使う条件

- 外部から観測可能な振る舞い、CLI、設定 schema、JSON 出力、state schema が変わる
- 複数の FR / NFR または安全不変条件へ影響する
- 代替案、段階移行、互換性破壊、ロールバックをレビューする必要がある
- 複数 PR に分割するが、全体として 1 つの仕様変更である

## ライフサイクル

1. [template.md](./template.md)から `NNNN-short-title.md` を作り、Status を `Proposed` にする。
2. Issue と相互リンクし、影響する要件 ID、非目標、安全性、移行を明示する。
3. 方針承認後に Status を `Accepted` にし、要件 → 設計 → トレーサビリティの順で更新する。
4. 実装・検証・利用者文書・CHANGELOG を同じ変更単位で追随させる。
5. 完了後は Status を `Implemented` にし、実装 PR と必要な ADR をリンクする。
6. 採用しなかった提案は `Rejected`、別案へ置換した提案は `Superseded` として理由を残す。

進捗の正本は GitHub Issue / PR とし、このディレクトリにチェックリストだけを複製しない。
