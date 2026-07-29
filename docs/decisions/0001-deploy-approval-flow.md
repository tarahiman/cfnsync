# ADR-0001: `deploy` は全差分確定後に実行全体を一括承認する

- Status: Accepted
- Date: 2026-07-30
- Related requirements: FR-5, FR-12-3, FR-12-6c, FR-12-8
- Related proposal / issue: T-22
- Supersedes: 既定で非対話実行し、`--confirm` でのみ確認する方式
- Superseded by: なし

## Context

従来の `deploy` は既定で確認なしに完走し、任意の `--confirm` は差分表示より前に確認を求めていた。
利用者は実際の Change Set 全体を判断材料にできず、一般的な apply 操作として予測しにくかった。

一方、全対象の Change Set を事前作成して承認を待つ方式には、ロック保持時間の増加、承認待ち中の
実状態変更、計画段階の部分失敗、未実行 Change Set の後始末という新しい制約がある。

## Decision

- `deploy` は Phase A で全対象の Change Set と削除プレビューを確定し、実行全体で 1 回だけ承認を求める。
- 承認後の Phase B でのみ `ExecuteChangeSet` / `DeleteStack` を行う。
- 非 TTY では `--auto-approve` を必須とし、CLI 境界で AWS / state アクセス前に拒否する。
- `--confirm` は廃止し、`--auto-approve` は `deploy` だけに提供する。
- Phase A が 1 件でも失敗した場合は不完全な計画を承認対象にせず、`--on-failure` に関係なく全体を中断する。
  `--on-failure stop|continue` は Phase B の実行失敗伝播だけを制御する。
- 承認拒否または Phase A 失敗では、作成済みの自 Change Set を後始末する。`REVIEW_IN_PROGRESS` の
  スタック本体は削除しない。
- 承認待ちの間は state lock を保持し、Phase B の各副作用直前に実スタック、Change Set の name / ARN、
  スタック状態、lock 所有権を再検査する。ただし TOCTOU 競合窓が消えるとは主張しない。

現在の詳細な規範は [requirements.md の FR-5](../spec/requirements.md#fr-5-変更セット作成とデプロイの一括実行)と
[design.md §5.3](../spec/design.md#53-cfnsync-deploy)を参照する。

## Alternatives considered

- **従来の非対話を既定のまま維持する**: 差分確認を安全な既定にできないため不採用。
- **各スタックを作成→承認→実行する**: 実行全体の影響を一度に確認できず、承認回数も対象数に依存するため不採用。
- **Phase A で失敗した対象だけ除外して縮退実行する**: 同じ `--on-failure` に「不完全な計画を許容する」と
  「実行失敗を伝播する」の二つの意味を持たせ、不可逆操作を不完全な計画で承認することになるため不採用。
  将来必要なら別の明示オプションとして設計する。
- **新規 Export を使う consumer の Change Set 作成を Phase B まで遅延する**: 生 AWS での検証により、未作成
  Export は `{{changeSet:KNOWN_AFTER_APPLY}}` として Change Set 作成可能と分かったため不採用。

## Consequences

- CI は `deploy --auto-approve` へ移行する必要があり、変更が 0 件でも非 TTY の未指定実行は exit 1 になる。
- 承認拒否時の JSON は専用 payload ではなく `cancelled: true` 付き deploy report となる。
- 計画段階にも `--on-failure continue` を適用していた利用者にとって、適用範囲の限定は互換性破壊である。
- 承認待ちの応答時間だけ lock が長く保持され、他の実行が競合エラーになる可能性がある。
- Change Set は作成時点のスナップショットであり、承認時点と実行時点の実状態一致は保証しない。

利用者向けの差分と移行例は [CHANGELOG の Unreleased](../../CHANGELOG.md#unreleased)を参照する。

## Evidence

- 詳細な受入テスト対応: [tasks.md T-22](../spec/tasks.md#t-22-deploy-を差分表示-承認-実行へ変更する)
- 主なシナリオ: `test/usecase/approval.test.ts`, `test/cli/cli.test.ts`
