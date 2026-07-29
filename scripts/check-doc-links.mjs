import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const root = process.cwd();
function collectMarkdownFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectMarkdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
  }
  return files;
}

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

function anchorsFor(path) {
  const anchors = new Set();
  const counts = new Map();
  const markdown = readFileSync(path, 'utf8');
  for (const match of markdown.matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = githubSlug(match[1]);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

const failures = [];
const markdownFiles = [
  ...readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => resolve(root, entry.name)),
  ...collectMarkdownFiles(resolve(root, 'docs')),
  ...collectMarkdownFiles(resolve(root, 'skills')),
];
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
    if (!anchors.has(fragment))
      failures.push(`${display}: heading anchor not found`);
  }
}

if (failures.length > 0) {
  console.error('Broken local Markdown links:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Checked ${markdownFiles.length} Markdown files: local links are valid.`,
  );
}
