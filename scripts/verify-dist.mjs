// @ts-check

import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { runAsScript } from './lib/cli.mjs';
import { filesUnder } from './lib/fs.mjs';
import { reportFailures } from './lib/report.mjs';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const src = join(root, 'src');

export function main() {
  const builtFiles = filesUnder(
    dist,
    (path) => path.endsWith('.js') || path.endsWith('.d.ts'),
  );
  const stale = builtFiles
    .filter((path) => {
      const outputPath = relative(dist, path);
      const sourcePath = outputPath
        .replace(/\.d\.ts$/, '.ts')
        .replace(/\.js$/, '.ts');
      return !existsSync(join(src, sourcePath));
    })
    .map((path) => relative(root, path));

  reportFailures(
    'Stale dist files without corresponding source files:',
    stale,
    `Checked ${builtFiles.length} dist files: no stale output found.`,
  );
}

runAsScript(import.meta.url, main);
