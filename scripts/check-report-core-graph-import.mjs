import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * PR #45 finding #1 (issue #30-4): `src/report/**` may read `src/core/graph`
 * *types* (`import type`) but must never depend on it at the value level —
 * that value dependency (`computeLevels`) used to let `report` re-run
 * topological sort and become the only renderer able to throw the domain
 * exception `DependencyCycleError` (design.md §3 layering; `usecase/graph.ts`
 * now owns cycle detection).
 *
 * `biome.json`'s `src/report/**` `noRestrictedImports` override cannot express
 * this: it bans whole module groups (e.g. `../usecase/**`), but
 * `noRestrictedImports` does not distinguish `import type` from a value
 * import, and `src/report/index.ts` has a legitimate
 * `import type { RegionGraph } from '../core/graph.js'`. A blanket ban on the
 * module path would also flag that. This script fills the gap Biome cannot
 * express: it resolves every relative import in `src/report/**` and fails
 * only when one resolving to `src/core/graph` carries a *value* binding.
 */

const CORE_GRAPH_TARGET = resolve(process.cwd(), 'src/core/graph');

function stripKnownExtension(path) {
  return path.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

/**
 * Whether an import clause carries at least one binding that is a *value*
 * (as opposed to being wholly `import type { ... }` or `import { type X }`).
 */
function hasValueBinding(importClause) {
  if (importClause === undefined) return false; // side-effect-only import
  if (importClause.isTypeOnly) return false; // `import type ...`
  if (importClause.name !== undefined) return true; // default import is a value
  const bindings = importClause.namedBindings;
  if (bindings === undefined) return false;
  if (ts.isNamespaceImport(bindings)) return true; // `import * as ns`
  return bindings.elements.some((element) => !element.isTypeOnly);
}

/**
 * Value imports/re-exports in `source` (file at `filePath`) that resolve to
 * `src/core/graph`. `import type` and `export type` are ignored; a mixed
 * clause (e.g. `{ type RegionGraph, computeLevels }`) is flagged because
 * `computeLevels` is a value binding.
 */
export function findCoreGraphValueImports(source, filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations = [];

  for (const statement of sourceFile.statements) {
    const isImport = ts.isImportDeclaration(statement);
    const isExportFrom =
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined;
    if (!isImport && !isExportFrom) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;

    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue; // only relative imports resolve into src/

    const resolved = stripKnownExtension(resolve(dirname(filePath), specifier));
    if (resolved !== CORE_GRAPH_TARGET) continue;

    const isValue = isImport
      ? hasValueBinding(statement.importClause)
      : !statement.isTypeOnly &&
        (statement.exportClause === undefined ||
          !ts.isNamedExports(statement.exportClause) ||
          statement.exportClause.elements.some(
            (element) => !element.isTypeOnly,
          ));
    if (!isValue) continue;

    const { line } = sourceFile.getLineAndCharacterOfPosition(
      statement.getStart(sourceFile),
    );
    violations.push({ line: line + 1, specifier });
  }

  return violations;
}

export function main() {
  const violations = [];
  let checked = 0;
  const reportDir = resolve(process.cwd(), 'src/report');
  for (const path of filesUnder(reportDir)) {
    if (!path.endsWith('.ts') && !path.endsWith('.tsx')) continue;
    checked += 1;
    const source = readFileSync(path, 'utf8');
    for (const violation of findCoreGraphValueImports(source, path)) {
      violations.push(
        `${path}:${violation.line}: value import of '${violation.specifier}' resolves to src/core/graph — only 'import type' may cross this boundary (design.md §3; PR #45 finding #1)`,
      );
    }
  }

  if (violations.length > 0) {
    // 終了コード規約: 1 = 検証失敗。スタックトレースは開発者向けノイズなので出さない。
    console.error(
      `src/report must not depend on src/core/graph as a value:\n${violations.join('\n')}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `Checked ${checked} TypeScript files under src/report: no value import of src/core/graph.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
