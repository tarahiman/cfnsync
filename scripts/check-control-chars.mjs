// @ts-check

import { readFileSync } from 'node:fs';

import { runAsScript } from './lib/cli.mjs';
import { filesUnder } from './lib/fs.mjs';
import { reportFailures } from './lib/report.mjs';

export function main() {
  const sourceFiles = filesUnder('src');
  const violations = [];
  for (const path of sourceFiles) {
    const content = readFileSync(path);
    for (const byte of [0x00, 0x1b]) {
      if (content.includes(byte)) {
        violations.push(`${path}: 0x${byte.toString(16)}`);
      }
    }
  }

  reportFailures(
    'Source files contain forbidden control characters:',
    violations,
    `Checked ${sourceFiles.length} source files: no forbidden control characters found.`,
  );
}

runAsScript(import.meta.url, main);
