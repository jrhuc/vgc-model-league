#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const POLICY =
  'repo policy: comments only for constraints the code cannot express, written as /** doc */ blocks; // narration is rejected';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const violations = [];

for (const root of ['src', 'tools', 'tests']) {
  for (const entry of fs.readdirSync(path.join(repoRoot, root), { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.(ts|tsx|mjs)$/.test(entry.name)) continue;
    checkFile(path.join(entry.parentPath, entry.name));
  }
}

if (violations.length > 0) {
  for (const violation of violations) console.error(violation);
  console.error(`\n${violations.length} comment${violations.length === 1 ? '' : 's'} rejected. ${POLICY}`);
  process.exit(1);
}

function checkFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const relative = path.relative(repoRoot, file);
  let ast;
  try {
    ast = parse(text, {
      sourceType: 'unambiguous',
      plugins: file.endsWith('.mjs') ? [] : ['typescript', ...(file.endsWith('.tsx') ? ['jsx'] : [])],
      errorRecovery: true,
    });
  } catch (error) {
    violations.push(`${relative}: could not parse (${error.message.split('\n')[0]})`);
    return;
  }
  for (const comment of ast.comments ?? []) {
    const value = comment.value;
    if (comment.type === 'CommentLine' && !/^[/!]?\s*(@ts-|eslint|biome-ignore|#!|<reference)/.test(value)) {
      violations.push(`${relative}:${comment.loc.start.line}: //${value.trim().slice(0, 90)}`);
    } else if (comment.type === 'CommentBlock' && !value.startsWith('*') && !/^\s*biome-ignore/.test(value)) {
      violations.push(`${relative}:${comment.loc.start.line}: /*${value.trim().split('\n')[0].slice(0, 90)}`);
    }
  }
}
