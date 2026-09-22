// @ts-check

/**
 * @typedef {object} MarkdownHeading
 * @property {number} level
 * @property {string} text
 * @property {number} index
 */

/**
 * Extracts ATX headings while preserving their source offsets.
 *
 * @param {string} markdown
 * @returns {MarkdownHeading[]}
 */
export function extractMarkdownHeadings(markdown) {
  return [...markdown.matchAll(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/gm)].map(
    (match) => ({
      level: match[1].length,
      text: match[2],
      index: match.index,
    }),
  );
}
