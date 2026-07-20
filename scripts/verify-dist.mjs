import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const src = join(root, 'src');

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

const stale = filesUnder(dist)
  .filter((path) => path.endsWith('.js') || path.endsWith('.d.ts'))
  .filter((path) => {
    const outputPath = relative(dist, path);
    const sourcePath = outputPath
      .replace(/\.d\.ts$/, '.ts')
      .replace(/\.js$/, '.ts');
    return !existsSync(join(src, sourcePath));
  })
  .map((path) => relative(root, path));

if (stale.length > 0) {
  throw new Error(`source のない stale dist ファイルを検出しました:\n${stale.join('\n')}`);
}
