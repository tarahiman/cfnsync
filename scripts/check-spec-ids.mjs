import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const requirementsPath = resolve(process.cwd(), 'docs/spec/requirements.md');
const requirements = readFileSync(requirementsPath, 'utf8');
const designPath = resolve(process.cwd(), 'docs/spec/design.md');
const design = readFileSync(designPath, 'utf8');
const failures = [];

function checkContiguousSequence(label, values) {
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

function checkTopLevelSequence(kind, expectedLast) {
  const ids = [
    ...requirements.matchAll(new RegExp(`^### ${kind}-(\\d+):`, 'gm')),
  ].map((match) => Number(match[1]));
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

function parseCriterionId(id) {
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
function compareCriterionIds(left, right) {
  const kind = left.kind.localeCompare(right.kind);
  if (kind !== 0) return kind;
  const requirement = left.requirement - right.requirement;
  if (requirement !== 0) return requirement;
  const criterion = left.criterion - right.criterion;
  if (criterion !== 0) return criterion;
  return collator.compare(left.suffix, right.suffix);
}

checkTopLevelSequence('FR', 13);
checkTopLevelSequence('NFR', 7);
checkContiguousSequence(
  'requirements sections',
  [...requirements.matchAll(/^## (\d+)\./gm)].map((match) => Number(match[1])),
);
checkContiguousSequence(
  'design sections',
  [...design.matchAll(/^## (\d+)\./gm)].map((match) => Number(match[1])),
);

for (const level of [3, 4]) {
  const groups = new Map();
  const hashes = '#'.repeat(level);
  const pattern =
    level === 3
      ? new RegExp(`^${hashes} (\\d+)\\.(\\d+) `, 'gm')
      : new RegExp(`^${hashes} (\\d+\\.\\d+)\\.(\\d+) `, 'gm');
  for (const match of design.matchAll(pattern)) {
    const values = groups.get(match[1]) ?? [];
    values.push(Number(match[2]));
    groups.set(match[1], values);
  }
  for (const [parent, values] of groups) {
    checkContiguousSequence(`design subsections under ${parent}`, values);
  }
}

const definitions = [];
const requirementHeadings = [
  ...requirements.matchAll(/^### (FR|NFR)-(\d+):/gm),
].map((match) => ({
  index: match.index,
  kind: match[1],
  requirement: Number(match[2]),
}));
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

if (failures.length > 0) {
  console.error('Invalid normative document structure:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Checked normative section numbering, FR-1..FR-13, NFR-1..NFR-7, and ${definitions.length} explicit acceptance IDs.`,
  );
}
