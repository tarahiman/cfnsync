import { describe, expect, it } from 'vitest';
import {
  renderForceUnlock,
  renderImport,
} from '../../src/usecase/cliBoundary.js';
import type { ForceUnlockResult } from '../../src/usecase/forceUnlock.js';
import type { ImportReport, ImportResult } from '../../src/usecase/importer.js';

/**
 * PR #45 finding #3: `renderImport` / `renderForceUnlock` had no direct
 * tests. The existing CLI tests mostly `JSON.parse(...).toEqual(...)`, which
 * cannot detect byte-level regressions (key order, indentation, trailing
 * newline) — exactly the non-regression FR-12-6a / FR-12-6b claims. These
 * tests call the two boundary functions directly and compare raw strings.
 */

const FULL_IMPORT_REPORT: ImportReport = {
  connection: {
    accountId: '111122223333',
    regions: ['us-east-1', 'us-west-2'],
  },
  stacks: [
    {
      stackKey: 'app.yaml@us-east-1',
      region: 'us-east-1',
      templatePath: 'app.yaml',
      stackName: 'app-stack',
      status: 'imported',
      templateComparison: 'match',
      reconcile: 'remote',
      wroteTemplate: true,
      recorded: true,
      noEchoPlaceholders: ['DbPassword'],
      message: 'Imported successfully',
    },
    {
      stackKey: 'other.yaml@us-west-2',
      region: 'us-west-2',
      templatePath: 'other.yaml',
      status: 'not-found',
      recorded: false,
      noEchoPlaceholders: [],
    },
  ],
  configWritten: true,
  stateSaved: true,
  accountStateInitialized: false,
  importEntriesSaved: true,
  warnings: ['warn one', 'warn two'],
};

const FULL_IMPORT_RESULT: ImportResult = {
  exitCode: 0,
  report: FULL_IMPORT_REPORT,
};

describe('FR-12-6a/FR-12-6b (PR #45 finding #3): renderImport', () => {
  it('produces byte-exact JSON in the field-table order (key order, indentation, no trailing newline)', () => {
    const expectedJson = JSON.stringify(
      {
        connection: {
          accountId: '111122223333',
          regions: ['us-east-1', 'us-west-2'],
        },
        stacks: [
          {
            stackKey: 'app.yaml@us-east-1',
            region: 'us-east-1',
            templatePath: 'app.yaml',
            stackName: 'app-stack',
            status: 'imported',
            templateComparison: 'match',
            reconcile: 'remote',
            wroteTemplate: true,
            recorded: true,
            noEchoPlaceholders: ['DbPassword'],
            message: 'Imported successfully',
          },
          {
            stackKey: 'other.yaml@us-west-2',
            region: 'us-west-2',
            templatePath: 'other.yaml',
            status: 'not-found',
            recorded: false,
            noEchoPlaceholders: [],
          },
        ],
        configWritten: true,
        stateSaved: true,
        accountStateInitialized: false,
        importEntriesSaved: true,
        warnings: ['warn one', 'warn two'],
      },
      null,
      2,
    );

    expect(renderImport(FULL_IMPORT_RESULT, true)).toBe(expectedJson);
  });

  it('omits optional fields entirely rather than emitting null when absent', () => {
    const parsed = JSON.parse(renderImport(FULL_IMPORT_RESULT, true));
    expect(Object.keys(parsed.stacks[1])).toEqual([
      'stackKey',
      'region',
      'templatePath',
      'status',
      'recorded',
      'noEchoPlaceholders',
    ]);
    expect(parsed.aborted).toBeUndefined();
    expect('aborted' in parsed).toBe(false);
  });

  it('does not leak a field injected outside the projected whitelist (top-level, connection, and stack level)', () => {
    const leakyReport = {
      ...FULL_IMPORT_REPORT,
      secretTopLevel: 'TOP-LEVEL-LEAK-MARKER',
      connection: {
        ...FULL_IMPORT_REPORT.connection,
        secretConnectionField: 'CONNECTION-LEAK-MARKER',
      },
      stacks: FULL_IMPORT_REPORT.stacks.map((stack) => ({
        ...stack,
        secretStackField: 'STACK-LEVEL-LEAK-MARKER',
      })),
    } as unknown as ImportReport;

    const out = renderImport({ exitCode: 0, report: leakyReport }, true);
    expect(out).not.toContain('LEAK-MARKER');
  });

  it('renders text mode as one "status: stackKey" line per stack', () => {
    expect(renderImport(FULL_IMPORT_RESULT, false)).toBe(
      'imported: app.yaml@us-east-1\nnot-found: other.yaml@us-west-2',
    );
  });

  it('renders "No stacks to import." in text mode when stacks is empty', () => {
    const empty: ImportResult = {
      exitCode: 0,
      report: { ...FULL_IMPORT_REPORT, stacks: [] },
    };
    expect(renderImport(empty, false)).toBe('No stacks to import.');
  });
});

const FULL_FORCE_UNLOCK_RESULT: ForceUnlockResult = {
  exitCode: 0,
  released: true,
  lock: {
    runId: 'run-123',
    startedAt: '2026-01-01T00:00:00.000Z',
    owner: 'ci-runner',
  },
  message: 'Lock released.',
};

describe('FR-12-6b (PR #45 finding #3): renderForceUnlock', () => {
  it('produces byte-exact JSON in the field-table order (key order, indentation, no trailing newline)', () => {
    const expectedJson = JSON.stringify(
      {
        exitCode: 0,
        released: true,
        lock: {
          runId: 'run-123',
          startedAt: '2026-01-01T00:00:00.000Z',
          owner: 'ci-runner',
        },
        message: 'Lock released.',
      },
      null,
      2,
    );

    expect(renderForceUnlock(FULL_FORCE_UNLOCK_RESULT, true)).toBe(
      expectedJson,
    );
  });

  it('omits lock entirely rather than emitting null when there was nothing to release', () => {
    const noLock: ForceUnlockResult = {
      exitCode: 0,
      released: false,
      message: 'No lock to release.',
    };
    const expectedJson = JSON.stringify(
      { exitCode: 0, released: false, message: 'No lock to release.' },
      null,
      2,
    );

    expect(renderForceUnlock(noLock, true)).toBe(expectedJson);
    expect('lock' in JSON.parse(renderForceUnlock(noLock, true))).toBe(false);
  });

  it('does not leak a field injected outside the projected whitelist (top-level and lock level)', () => {
    const leaky = {
      ...FULL_FORCE_UNLOCK_RESULT,
      secretTopLevel: 'TOP-LEVEL-LEAK-MARKER',
      lock: {
        ...FULL_FORCE_UNLOCK_RESULT.lock,
        secretLockField: 'LOCK-LEVEL-LEAK-MARKER',
      },
    } as unknown as ForceUnlockResult;

    const out = renderForceUnlock(leaky, true);
    expect(out).not.toContain('LEAK-MARKER');
  });

  it('renders text mode as the human-readable message only', () => {
    expect(renderForceUnlock(FULL_FORCE_UNLOCK_RESULT, false)).toBe(
      'Lock released.',
    );
  });
});
