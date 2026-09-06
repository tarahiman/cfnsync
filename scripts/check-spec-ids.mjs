// @ts-check

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runAsScript } from './lib/cli.mjs';
import { filesUnder } from './lib/fs.mjs';
import { extractMarkdownHeadings } from './lib/markdown.mjs';
import { reportFailures } from './lib/report.mjs';

/**
 * @typedef {{ kind: string, requirement: number, criterion: number, suffix: string }} CriterionId
 */

/** @param {string[]} failures @param {string} label @param {number[]} values */
function checkContiguousSequence(failures, label, values) {
  if (values.length === 0) {
    failures.push(`${label} are missing`);
    return;
  }
  const expected = Array.from(
    { length: Math.max(...values) },
    (_, index) => index + 1,
  );
  if (values.join(',') !== expected.join(',')) {
    failures.push(
      `${label} must be contiguous and ordered (${expected.join(', ')}); found ${values.join(', ')}`,
    );
  }
}

/**
 * @param {string[]} failures
 * @param {string} requirements
 * @param {string} kind
 * @param {number} expectedLast
 */
function checkTopLevelSequence(failures, requirements, kind, expectedLast) {
  const ids = extractMarkdownHeadings(requirements)
    .filter((heading) => heading.level === 3)
    .map((heading) => new RegExp(`^${kind}-(\\d+):`).exec(heading.text))
    .filter((match) => match !== null)
    .map((match) => Number(match[1]));
  const expected = Array.from(
    { length: expectedLast },
    (_, index) => index + 1,
  );
  if (ids.join(',') !== expected.join(',')) {
    failures.push(
      `${kind} headings must be ${expected.join(', ')} in order; found ${ids.join(', ')}`,
    );
  }
}

/** @param {string} id @returns {CriterionId | undefined} */
export function parseCriterionId(id) {
  const match = /^(FR|NFR)-(\d+)-(\d+)([a-z]\d*)?$/.exec(id);
  if (match === null) return undefined;
  return {
    kind: match[1],
    requirement: Number(match[2]),
    criterion: Number(match[3]),
    suffix: match[4] ?? '',
  };
}

const collator = new Intl.Collator('en', { numeric: true });
/** @param {CriterionId} left @param {CriterionId} right */
function compareCriterionIds(left, right) {
  const kind = left.kind.localeCompare(right.kind);
  if (kind !== 0) return kind;
  const requirement = left.requirement - right.requirement;
  if (requirement !== 0) return requirement;
  const criterion = left.criterion - right.criterion;
  if (criterion !== 0) return criterion;
  return collator.compare(left.suffix, right.suffix);
}

// Any `FR-<n>` / `NFR-<n>` token, optionally followed by `-<criterion>` and an
// `a`/`b`/... sub-suffix (e.g. `FR-5-14b`). Bare requirement-level tokens
// (e.g. `NFR-1`) are matched too so a tasks.md row can name a whole
// requirement, even though no bare requirement ID can ever equal an explicit
// criterion ID and therefore match anything below.
const ID_TOKEN_PATTERN = /(?:FR|NFR)-\d+(?:-\d+[a-z]?\d*)?/g;

/**
 * docs/spec/README.md's "ID の安定性" section designates
 * tasks.md's "テスト対象外(ドキュメント・構造で満たす)受け入れ基準の一覧" table as the
 * record of acceptance criteria that are intentionally *not* proven by a
 * `test/**\/*.ts` occurrence of their ID (structural requirements, guaranteed
 * by code review, or by a separate structural check script). This reads that
 * table dynamically so the exception list is never hardcoded in this script.
 * @param {string} tasksText
 * @returns {string[]}
 */
export function extractExemptIds(tasksText) {
  const headingMatch = /^## \d+\.\s.*テスト対象外.*$/m.exec(tasksText);
  if (headingMatch === null) return [];

  const afterHeading = tasksText.slice(
    headingMatch.index + headingMatch[0].length,
  );
  const nextHeadingMatch = /^## /m.exec(afterHeading);
  const tableText =
    nextHeadingMatch === null
      ? afterHeading
      : afterHeading.slice(0, nextHeadingMatch.index);

  const ids = new Set();
  for (const line of tableText.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    for (const match of line.matchAll(ID_TOKEN_PATTERN)) ids.add(match[0]);
  }
  return [...ids];
}

/**
 * Strips full-line `//` and `/*` comments from source text so that an ID
 * mentioned only in a comment (documentation of intent, not proof of
 * coverage) does not count as a test occurrence. Only whole comment lines
 * are removed (not trailing inline comments after code) to avoid mangling
 * string literals that happen to contain `//` (e.g. a URL fixture).
 * @param {string} text
 */
function stripFullLineComments(text) {
  return text
    .split('\n')
    .map((line) => (/^\s*(?:\/\/|\/\*)/.test(line) ? '' : line))
    .join('\n');
}

/** @param {string} text */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether `id` occurs in `corpus` as its own token, not merely as a
 * substring of a longer sibling ID (`FR-5-1` inside `FR-5-10a`) or of a
 * same-numbered `NFR-*` counterpart (`FR-7-1` inside `NFR-7-1`).
 * @param {string} corpus
 * @param {string} id
 */
function containsIdToken(corpus, id) {
  const pattern = new RegExp(
    `(?<![A-Za-z0-9])${escapeRegExp(id)}(?![A-Za-z0-9])`,
  );
  return pattern.test(corpus);
}

/**
 * `ids` not found as their own token in `testCorpus` (the concatenated,
 * comment-stripped text of every `test/**\/*.ts` file) and not present in
 * `exemptIds`. Comments are excluded so that an ID merely annotated in a
 * `// FR-x-y: ...` note — without actually appearing in a test/assertion —
 * is not mistaken for real coverage.
 * @param {string[]} ids
 * @param {string} testCorpus
 * @param {string[]} exemptIds
 * @returns {string[]}
 */
export function findIdsMissingTestCoverage(ids, testCorpus, exemptIds) {
  const exempt = new Set(exemptIds);
  const corpus = stripFullLineComments(testCorpus);
  return ids.filter((id) => !exempt.has(id) && !containsIdToken(corpus, id));
}

export function main() {
  const requirements = readFileSync(
    resolve(process.cwd(), 'docs/spec/requirements.md'),
    'utf8',
  );
  const design = readFileSync(
    resolve(process.cwd(), 'docs/spec/design.md'),
    'utf8',
  );
  const tasks = readFileSync(
    resolve(process.cwd(), 'docs/spec/tasks.md'),
    'utf8',
  );
  /** @type {string[]} */
  const failures = [];

  checkTopLevelSequence(failures, requirements, 'FR', 13);
  checkTopLevelSequence(failures, requirements, 'NFR', 7);
  checkContiguousSequence(
    failures,
    'requirements sections',
    extractMarkdownHeadings(requirements)
      .filter((heading) => heading.level === 2)
      .map((heading) => /^(\d+)\./.exec(heading.text))
      .filter((match) => match !== null)
      .map((match) => Number(match[1])),
  );
  checkContiguousSequence(
    failures,
    'design sections',
    extractMarkdownHeadings(design)
      .filter((heading) => heading.level === 2)
      .map((heading) => /^(\d+)\./.exec(heading.text))
      .filter((match) => match !== null)
      .map((match) => Number(match[1])),
  );

  const designHeadings = extractMarkdownHeadings(design);
  for (const level of [3, 4]) {
    /** @type {Map<string, number[]>} */
    const groups = new Map();
    const pattern = level === 3 ? /^(\d+)\.(\d+) / : /^(\d+\.\d+)\.(\d+) /;
    for (const heading of designHeadings) {
      if (heading.level !== level) continue;
      const match = pattern.exec(heading.text);
      if (match === null) continue;
      const values = groups.get(match[1]) ?? [];
      values.push(Number(match[2]));
      groups.set(match[1], values);
    }
    for (const [parent, values] of groups) {
      checkContiguousSequence(
        failures,
        `design subsections under ${parent}`,
        values,
      );
    }
  }

  /** @type {{ id: string, line: number, parsed: CriterionId }[]} */
  const definitions = [];
  const requirementHeadings = extractMarkdownHeadings(requirements).flatMap(
    (heading) => {
      if (heading.level !== 3) return [];
      const match = /^(FR|NFR)-(\d+):/.exec(heading.text);
      return match === null
        ? []
        : [
            {
              index: heading.index,
              kind: match[1],
              requirement: Number(match[2]),
            },
          ];
    },
  );
  for (const match of requirements.matchAll(/^- \*\*([^:*]+):\*\*/gm)) {
    const label = match[1].trim();
    if (!label.startsWith('FR-') && !label.startsWith('NFR-')) continue;

    const parsed = parseCriterionId(label);
    const line = requirements.slice(0, match.index).split('\n').length;
    if (parsed === undefined) {
      failures.push(
        `line ${line}: criterion definition must contain exactly one explicit ID, found "${label}"`,
      );
      continue;
    }

    const heading = requirementHeadings.findLast(
      (candidate) => candidate.index < match.index,
    );
    if (
      heading === undefined ||
      heading.kind !== parsed.kind ||
      heading.requirement !== parsed.requirement
    ) {
      const expected =
        heading === undefined
          ? 'a matching requirement heading'
          : `${heading.kind}-${heading.requirement}`;
      failures.push(`line ${line}: ${label} is defined under ${expected}`);
    }
    definitions.push({ id: label, line, parsed });
  }

  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const definition of definitions) {
    const previous = seen.get(definition.id);
    if (previous !== undefined) {
      failures.push(
        `line ${definition.line}: duplicate criterion ${definition.id} (first defined on line ${previous})`,
      );
    } else {
      seen.set(definition.id, definition.line);
    }
  }

  for (let index = 1; index < definitions.length; index += 1) {
    const previous = definitions[index - 1];
    const current = definitions[index];
    if (compareCriterionIds(previous.parsed, current.parsed) > 0) {
      failures.push(
        `line ${current.line}: ${current.id} is out of order after ${previous.id} (line ${previous.line})`,
      );
    }
  }

  const testFiles = filesUnder(resolve(process.cwd(), 'test'), (path) =>
    path.endsWith('.ts'),
  );
  const testCorpus = testFiles
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
  const exemptIds = extractExemptIds(tasks);
  const missingIds = findIdsMissingTestCoverage(
    definitions.map((definition) => definition.id),
    testCorpus,
    exemptIds,
  );
  for (const id of missingIds) {
    failures.push(
      `${id}: not found in any test/**/*.ts test name, and not listed in tasks.md's "テスト対象外" table`,
    );
  }

  const exemptedCount = definitions.filter((definition) =>
    exemptIds.includes(definition.id),
  ).length;
  reportFailures(
    'Invalid normative document structure:',
    failures,
    `Checked normative section numbering, FR-1..FR-13, NFR-1..NFR-7, and ${definitions.length} explicit acceptance IDs: each is referenced in test/**/*.ts or listed in tasks.md's "テスト対象外" table (${exemptedCount} exempted).`,
  );
}

runAsScript(import.meta.url, main);
