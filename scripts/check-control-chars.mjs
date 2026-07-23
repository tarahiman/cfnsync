import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

const violations = [];
for (const path of filesUnder('src')) {
  const content = readFileSync(path);
  for (const byte of [0x00, 0x1b]) {
    if (content.includes(byte))
      violations.push(`${path}: 0x${byte.toString(16)}`);
  }
}
if (violations.length > 0) {
  throw new Error(`ソースに実制御文字があります:\n${violations.join('\n')}`);
}
