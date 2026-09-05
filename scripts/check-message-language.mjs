import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const multibyte = /[぀-ヿ㐀-鿿＀-￯]/;

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

const violations = [];
for (const path of filesUnder('src')) {
  if (!path.endsWith('.ts')) continue;
  const code = stripComments(readFileSync(path, 'utf8'));
  code.split('\n').forEach((line, index) => {
    if (multibyte.test(line)) {
      violations.push(`${path}:${index + 1}: ${line.trim()}`);
    }
  });
}

if (violations.length > 0) {
  throw new Error(
    `NFR-7: CLI message output must be English with no multi-byte characters:\n${violations.join('\n')}`,
  );
}
