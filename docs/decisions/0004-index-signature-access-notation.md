# ADR-0004: 索引シグネチャへのアクセス記法の選択

- Status: Accepted
- Date: 2026-09-06
- Related requirements: なし（外部から観測可能な振る舞いを変更しない）
- Related proposal / issue: #24 / #26
- Supersedes: なし
- Superseded by: なし

## Context

Biome の `complexity/useLiteralKeys` は、文字列リテラルで表せるプロパティへのアクセスに
ドット記法を要求する。一方、TypeScript の `noPropertyAccessFromIndexSignature` は、索引シグネチャから
得られるプロパティにブラケット記法を要求する。この 2 つは同じアクセスに反対の記法を要求するため、
同時には採用できない。

本リポジトリで `Record<string, unknown>` を扱う主な箇所は CloudFormation テンプレートのパース結果であり、
既知の `Parameters`、`Outputs`、`Export` などを読み取る。動的キーとの区別は型と変数名から判断でき、
既知のキーにはドット記法のほうが読みやすい。

## Decision

Biome 2.3.13 の `complexity/useLiteralKeys` を採用し、既知の文字列キーへのアクセスにドット記法を使う。
TypeScript の `noPropertyAccessFromIndexSignature` は、`useLiteralKeys` と相互排他であるため、現在も将来も
採用しない。動的に決まるキーへのブラケット記法は引き続き許容する。

## Alternatives considered

- `noPropertyAccessFromIndexSignature` を採用してブラケット記法へ統一する案: CloudFormation の既知キーを
  読む箇所が冗長になり、Biome の `useLiteralKeys` と両立しないため採用しない。
- 両方を無効にして混在を許す案: 記法の選択がレビューごとに揺れ、機械的に退行を防げないため採用しない。

## Consequences

- 既知キーへのアクセスが簡潔になり、Biome が記法を機械的に統一する。
- 索引シグネチャに存在しないキーのタイプミスを TypeScript オプションでは検出しない。パース結果の検証と
  既存の型ガードを維持する。
- 方針を変更する場合は `useLiteralKeys` と本 ADR を同時に supersede する必要がある。

## Evidence

- `env -u AWS_PROFILE pnpm exec biome lint --only=complexity/useLiteralKeys --reporter=json src test scripts`
  により、変更前は `src/core/template.ts` に 5 件、`test/` に 12 件を確認した。
- TypeScript 5.9.3 の `noPropertyAccessFromIndexSignature` と Biome 2.3.13 の
  `complexity/useLiteralKeys` の要求を、対象となる `Record<string, unknown>` のアクセスで比較した。
