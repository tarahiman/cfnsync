import { describe, expect, it } from 'vitest';
import { findCoreGraphValueImports } from '../../scripts/check-report-core-graph-import.mjs';

// All fixtures below are analyzed as if they lived at src/report/index.ts, so
// '../core/graph.js' is the real one-hop-up relative path to src/core/graph.
const FILE_PATH = 'src/report/index.ts';

describe('PR #45 finding #1: check-report-core-graph-import', () => {
  it('flags a plain value import of computeLevels from core/graph', () => {
    const violations = findCoreGraphValueImports(
      "import { computeLevels } from '../core/graph.js';\n",
      FILE_PATH,
    );
    expect(violations).toEqual([{ line: 1, specifier: '../core/graph.js' }]);
  });

  it('permits a type-only import of the same module', () => {
    const violations = findCoreGraphValueImports(
      "import type { RegionGraph } from '../core/graph.js';\n",
      FILE_PATH,
    );
    expect(violations).toEqual([]);
  });

  it('permits a named import with an inline `type` modifier', () => {
    const violations = findCoreGraphValueImports(
      "import { type RegionGraph } from '../core/graph.js';\n",
      FILE_PATH,
    );
    expect(violations).toEqual([]);
  });

  it('flags a mixed clause where only one specifier is type-only', () => {
    const violations = findCoreGraphValueImports(
      "import { type RegionGraph, computeLevels } from '../core/graph.js';\n",
      FILE_PATH,
    );
    expect(violations).toEqual([{ line: 1, specifier: '../core/graph.js' }]);
  });

  it('flags a default value import from core/graph', () => {
    const violations = findCoreGraphValueImports(
      "import computeLevels from '../core/graph.js';\n",
      FILE_PATH,
    );
    expect(violations).toEqual([{ line: 1, specifier: '../core/graph.js' }]);
  });

  it('flags a namespace value import from core/graph', () => {
    const violations = findCoreGraphValueImports(
      "import * as graph from '../core/graph.js';\n",
      FILE_PATH,
    );
    expect(violations).toEqual([{ line: 1, specifier: '../core/graph.js' }]);
  });

  it('flags a value re-export from core/graph', () => {
    const violations = findCoreGraphValueImports(
      "export { computeLevels } from '../core/graph.js';\n",
      FILE_PATH,
    );
    expect(violations).toEqual([{ line: 1, specifier: '../core/graph.js' }]);
  });

  it('permits a type-only re-export from core/graph', () => {
    const violations = findCoreGraphValueImports(
      "export type { RegionGraph } from '../core/graph.js';\n",
      FILE_PATH,
    );
    expect(violations).toEqual([]);
  });

  it('resolves relative depth correctly and ignores unrelated modules', () => {
    const violations = findCoreGraphValueImports(
      [
        "import type { ResourceChangeDetail } from '../ports/index.js';",
        "import { MASK } from '../core/constants.js';",
        "import { readFileSync } from 'node:fs';",
      ].join('\n'),
      FILE_PATH,
    );
    expect(violations).toEqual([]);
  });

  it('resolves a deeper relative path (../../core/graph.js) for a nested report file', () => {
    const violations = findCoreGraphValueImports(
      "import { computeLevels } from '../../core/graph.js';\n",
      'src/report/nested/format.ts',
    );
    expect(violations).toEqual([{ line: 1, specifier: '../../core/graph.js' }]);
  });

  it('reports the 1-indexed line of the violation in multi-line source', () => {
    const violations = findCoreGraphValueImports(
      [
        "import type { RegionGraph } from '../core/graph.js';",
        "import { MASK } from '../core/constants.js';",
        "import { computeLevels } from '../core/graph.js';",
      ].join('\n'),
      FILE_PATH,
    );
    expect(violations).toEqual([{ line: 3, specifier: '../core/graph.js' }]);
  });
});
