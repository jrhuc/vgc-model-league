import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { marked } from 'marked';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(root, 'docs');
const out = path.join(root, 'dist', 'docs');
const pages = [
  ['index', 'Overview'],
  ['measurement', 'Measurement'],
  ['architecture', 'Architecture'],
  ['usage', 'Usage'],
  ['deployment', 'Deployment'],
  ['trade-window', 'Trade window'],
  ['season-review', 'Season review'],
];

function slug(value, counts) {
  const base = value
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, 'and')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const count = counts.get(base) ?? 0;
  counts.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function renderMarkdown(source) {
  const counts = new Map();
  return marked
    .parse(source)
    .replace(/href="([^"#]+)\.md(#[^"]*)?"/g, 'href="$1.html$2"')
    .replace(/<h([1-6])>(.*?)<\/h\1>/g, (_match, level, contents) => {
      const id = slug(contents, counts);
      return `<h${level} id="${id}"><a class="heading-anchor" href="#${id}" aria-label="Link to ${contents.replace(/<[^>]+>/g, '')}"></a>${contents}</h${level}>`;
    });
}

function pageLink(id) {
  return id === 'index' ? './' : `./${id}.html`;
}

function document(pageId, label, body) {
  const nav = pages
    .slice(0, 5)
    .map(([id, text]) => `<a href="${pageLink(id)}"${id === pageId ? ' aria-current="page"' : ''}>${text}</a>`)
    .join('');
  const sidebar = pages
    .map(([id, text]) => `<li><a href="${pageLink(id)}"${id === pageId ? ' aria-current="page"' : ''}>${text}</a></li>`)
    .join('');
  const title = pageId === 'index' ? 'VGC Model League' : `${label} · VGC Model League`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#f7f8f6">
<meta name="description" content="Technical documentation for the VGC Model League decision harness.">
<title>${title}</title>
<link rel="stylesheet" href="./site.css">
</head>
<body>
<a class="skip-link" href="#content">Skip to content</a>
<header class="site-header">
  <a class="wordmark" href="./">VGC Model League</a>
  <nav aria-label="Primary">${nav}</nav>
  <a class="spectator-link" href="https://github.com/jrhuc/ai-draft-league">Spectator site <span aria-hidden="true">↗</span></a>
</header>
<div class="docs-shell">
  <aside class="sidebar" aria-label="Documentation"><p>Harness</p><ul>${sidebar}</ul></aside>
  <main id="content" class="doc-content">${body}</main>
  <aside class="page-meta"><a href="https://github.com/jrhuc/vgc-model-league/blob/main/docs/${pageId}.md">View source <span aria-hidden="true">↗</span></a></aside>
</div>
<footer><span>The simulator decides outcomes. The record preserves decisions.</span><a href="https://github.com/jrhuc/vgc-model-league">GitHub <span aria-hidden="true">↗</span></a></footer>
</body>
</html>`;
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const [id, label] of pages) {
  const source = fs.readFileSync(path.join(docs, `${id}.md`), 'utf8');
  const target = id === 'index' ? 'index.html' : `${id}.html`;
  fs.writeFileSync(path.join(out, target), document(id, label, renderMarkdown(source)), 'utf8');
}
fs.copyFileSync(path.join(docs, 'site.css'), path.join(out, 'site.css'));
console.log(`documentation built into ${path.relative(root, out)}/`);
