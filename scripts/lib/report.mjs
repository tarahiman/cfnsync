// @ts-check

/**
 * Reports the outcome of a verification command.
 *
 * @param {string} header
 * @param {string[]} failures
 * @param {string} successSummary
 */
export function reportFailures(header, failures, successSummary) {
  if (failures.length > 0) {
    console.error(header);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(successSummary);
}
