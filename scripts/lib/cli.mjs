// @ts-check

import { fileURLToPath } from 'node:url';

export class VerificationError extends Error {}

/**
 * @param {unknown} error
 */
function reportUnhandledError(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof VerificationError ? 1 : 2;
}

/**
 * Runs an imported module's entry point only when the module is the script
 * passed to Node. Expected verification failures use exit code 1; unexpected
 * failures that prevent verification from completing use exit code 2.
 *
 * @param {string} importMetaUrl
 * @param {() => void | Promise<void>} main
 */
export function runAsScript(importMetaUrl, main) {
  if (process.argv[1] !== fileURLToPath(importMetaUrl)) return;

  try {
    const result = main();
    if (result instanceof Promise) result.catch(reportUnhandledError);
  } catch (error) {
    reportUnhandledError(error);
  }
}
