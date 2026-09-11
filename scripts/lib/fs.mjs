// @ts-check

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Recursively lists files below `directory`.
 *
 * @param {string} directory
 * @param {(path: string) => boolean} [filter]
 * @returns {string[]}
 */
export function filesUnder(directory, filter = () => true) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? filesUnder(path, filter)
      : filter(path)
        ? [path]
        : [];
  });
}
