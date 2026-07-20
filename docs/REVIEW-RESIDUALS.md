# レビュー残課題(既知の制約・将来対応)

複数観点(セキュリティ / 保守性・一貫性 / 性能)の反復レビューと修正(修正①〜⑦+再レビュー 2 の Critical/High)を経た時点で、**未対応として意図的に残している項目**の一覧。優先度と対応方針を明記する。Critical / High はすべて対応済み。

## セキュリティ(Medium / Low の残り)

| 項目 | 現状 | 方針 |
|---|---|---|
| 残存変更セット回収の名前依存 | 実行対象は作成 ARN に固定済み(confused-deputy は解消)。回収(削除)の所有権判定は命名規則に依存 | ロック配下の「回収台帳」に作成 ARN を記録し、記録済みのみ自動削除する設計を将来導入。現状は運用規約(§運用規約)で管理対象スタックへの手動変更セット作成を禁止し多層防御 |
| force-unlock の ETag ピン止め | readLock で表示した内容と forceUnlock の削除が別々の読み取りを使う。同一 runId での置換窓が理論上残る | `readLock` が ETag 付きハンドルを返し、表示時の ETag で `If-Match` 削除する契約変更を将来実施。force-unlock は旧実行の終了確認を前提とする人手操作であり、窓は狭い |
| import 書き込み時の TOCTOU | 静的な symlink 脱出は拒否済み。検証〜書き込み間の競合置換は未対策 | 書き込み時に `O_NOFOLLOW` 相当で開き、fd の realpath を再検証する強化を将来実施 |
| NoEcho の Default 値・UPDATE 再利用値 | 設定に実値がある NoEcho はマスク済み。テンプレート Default や UPDATE 再利用で設定に実値がない場合はマスク候補に入らない | NoEcho Default も解析してマスク候補に含める、または NoEcho を持つスタックの自由形式 AWS 理由を固定文へ置換する fail-closed 強化を将来実施 |
| 配布物の再現性(transitive) | 直接依存は完全固定・stale dist は clean 済み | `npm-shrinkwrap.json` の版管理 or `pnpm-lock.yaml` からの決定的生成、SBOM/provenance をリリースゲート化(パッケージング工程の課題) |

## 保守性(Medium / Low の残り)

- マルチリージョン import の書式差ハッシュ: パース後同値なら許可するが、記録ハッシュ基準の統一が未完(書式のみ差のリージョンが import 直後に modified になり得る)。
- テンプレート構文エラーの分類統一: `TemplateParseError` は導入したが、全 usecase 経路で stackKey/region 文脈を一律付与する共通入口化は未完。
- ports の必須識別情報の adapter 検証: `stackId`/`accountId`/`arn` の空文字ガードは一部のみ。adapter 境界での形式検証を全面化する余地。
- cli → usecase 境界: `commands.ts` の core/report 直接依存は解消済み。`dependencies.ts` / `filesystem.ts` が core/ports 型を参照する点は composition root として許容範囲だが、依存方向の機械検査(lint ルール)は未導入。
- 受け入れ基準 ID の 1:1 トレーサビリティ: primary/regression のラベル分離は部分的。

## 性能(Medium / Low の残り)

- 並列化の delta 分離: **意図的に見送り**。独立スタックの並列化は fencing・スタックごと即時 CAS・失敗伝播の安全境界を同時に変更する大改修になるため、初期リリースは直列実行(FR-9-3)を維持。`deploy.ts` に単一コミットキューへの移行方針を構造メモとして残置。
- ポーリング周期の細分化・失敗時隣接表の再構築・import 本文保持: いずれも数十〜百テンプレート規模では実用性を阻害しないため Low として据え置き。

これらは要件(FR/NFR)の充足を損なうものではなく、いずれも「より強い保証・より高速」への上積み、または本質的にベストエフォートな層(fencing・回収)の残余リスクである。実運用では README の運用規約(手動変更セットの禁止、force-unlock の終了確認前提)が多層防御を補完する。
