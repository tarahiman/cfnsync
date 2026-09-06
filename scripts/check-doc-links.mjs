// @ts-check

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { runAsScript } from './lib/cli.mjs';
import { filesUnder } from './lib/fs.mjs';
import { extractMarkdownHeadings } from './lib/markdown.mjs';
import { reportFailures } from './lib/report.mjs';

/** @param {string} value */
function githubSlug(value) {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\p{Mark}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

/** @param {string} path */
function anchorsFor(path) {
  const anchors = new Set();
  const counts = new Map();
  const markdown = readFileSync(path, 'utf8');
  for (const heading of extractMarkdownHeadings(markdown)) {
    const base = githubSlug(heading.text);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

export function main() {
  const root = process.cwd();
  const failures = [];
  const markdownFiles = [
    ...readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => resolve(root, entry.name)),
    ...filesUnder(resolve(root, 'docs'), (path) => path.endsWith('.md')),
    ...filesUnder(resolve(root, 'skills'), (path) => path.endsWith('.md')),
  ];
  /** @type {Map<string, Set<string>>} */
  const anchorsByPath = new Map();
  const linkPattern = /!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+['"][^)]*['"])?\)/g;

  for (const source of markdownFiles) {
    const markdown = readFileSync(source, 'utf8');
    for (const match of markdown.matchAll(linkPattern)) {
      const rawTarget = match[1].replace(/^<|>$/g, '');
      if (/^(?:[a-z][a-z+.-]*:|\/\/)/i.test(rawTarget)) continue;

      const [rawPath, rawFragment] = rawTarget.split('#', 2);
      const target =
        rawPath === ''
          ? source
          : resolve(dirname(source), decodeURIComponent(rawPath));
      const display = `${relative(root, source)} -> ${rawTarget}`;

      if (!existsSync(target)) {
        failures.push(`${display}: target does not exist`);
        continue;
      }
      if (statSync(target).isDirectory()) continue;
      if (rawFragment === undefined || rawFragment === '') continue;

      let anchors = anchorsByPath.get(target);
      if (anchors === undefined) {
        anchors = anchorsFor(target);
        anchorsByPath.set(target, anchors);
      }
      const fragment = decodeURIComponent(rawFragment).toLowerCase();
      if (!anchors.has(fragment)) {
        failures.push(`${display}: heading anchor not found`);
      }
    }
  }

  reportFailures(
    'Broken local Markdown links:',
    failures,
    `Checked ${markdownFiles.length} Markdown files: local links are valid.`,
  );
}

runAsScript(import.meta.url, main);
