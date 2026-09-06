// @ts-check

import { readFileSync } from 'node:fs';
import ts from 'typescript';

import { runAsScript } from './lib/cli.mjs';
import { filesUnder } from './lib/fs.mjs';
import { reportFailures } from './lib/report.mjs';

/** @param {string} text */
function hasNonAscii(text) {
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 0x7f) return true;
  }
  return false;
}

/**
 * NFR-7: find string/template literal segments in TypeScript source whose
 * literal text (not the surrounding code) contains a non-ASCII character.
 *
 * Uses the TypeScript compiler API to parse `source` into a real AST, so
 * only the decoded text of actual literal nodes is checked. Comments (line
 * or block) are trivia attached between tokens, not literal nodes, so they
 * are never visited — this can't be defeated by a string that merely looks
 * like a comment (e.g. `'/* not a comment *\/'` or a URL containing `//`).
 * Template literal expressions (the `${...}` parts) are separate
 * expression nodes, not text, so only their static quasi segments are
 * checked.
 *
 * @param {string} source
 * @param {string} [fileName]
 */
export function findNonAsciiLiterals(source, fileName = 'input.ts') {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  /** @type {{ line: number, text: string }[]} */
  const violations = [];

  /** @param {import('typescript').Node} node */
  const isLiteralWithText = (node) =>
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node);

  /** @param {import('typescript').Node} node */
  const visit = (node) => {
    if (isLiteralWithText(node) && hasNonAscii(node.text)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      violations.push({ line: line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

export function main() {
  const violations = [];
  const sourceFiles = filesUnder('src', (path) => path.endsWith('.ts'));
  for (const path of sourceFiles) {
    const source = readFileSync(path, 'utf8');
    for (const violation of findNonAsciiLiterals(source, path)) {
      violations.push(`${path}:${violation.line}: ${violation.text}`);
    }
  }

  reportFailures(
    'NFR-7: CLI message output must be English with no multi-byte characters:',
    violations,
    `Checked ${sourceFiles.length} TypeScript source files: CLI message literals are English.`,
  );
}

runAsScript(import.meta.url, main);
