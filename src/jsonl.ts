import fs from 'node:fs';
import path from 'node:path';

import type { JsonObject } from './types.js';
import { isRecord } from './value.js';

function parseJsonlObjects(file: string, contents: string): JsonObject[] {
  const lines = contents.split('\n');
  const hasUnterminatedTail = !contents.endsWith('\n');
  let lastNonempty = -1;
  for (const [index, line] of lines.entries()) {
    if (line.trim()) lastNonempty = index;
  }
  const rows: JsonObject[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      if (hasUnterminatedTail && index === lastNonempty) continue;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid JSONL line ${index + 1} in ${file}: ${detail}`, { cause: error });
    }
    if (!isRecord(parsed)) throw new Error(`invalid JSONL line ${index + 1} in ${file}: expected a JSON object`);
    rows.push(parsed);
  }
  return rows;
}

export function readJsonlObjects(file: string): JsonObject[] {
  let contents: string;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return parseJsonlObjects(file, contents);
}

function appendSeparator(file: string): string {
  let contents: string;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
  if (!contents) return '';
  if (contents.endsWith('\n')) {
    parseJsonlObjects(file, contents);
    return '';
  }
  const tailStart = contents.lastIndexOf('\n') + 1;
  const committedPrefix = contents.slice(0, tailStart);
  if (committedPrefix) parseJsonlObjects(file, committedPrefix);
  const tail = contents.slice(tailStart);
  if (tail.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(tail);
    } catch {
      fs.truncateSync(file, Buffer.byteLength(contents.slice(0, tailStart), 'utf8'));
      return '';
    }
    if (!isRecord(parsed)) throw new Error(`invalid unterminated JSONL tail in ${file}: expected a JSON object`);
    return '\n';
  }
  fs.truncateSync(file, Buffer.byteLength(contents.slice(0, tailStart), 'utf8'));
  return '';
}

export function appendJsonlObject(file: string, row: JsonObject): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const separator = appendSeparator(file);
  fs.appendFileSync(file, `${separator}${JSON.stringify(row)}\n`, 'utf8');
}
