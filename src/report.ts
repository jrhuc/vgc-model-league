import fs from 'node:fs';
import path from 'node:path';

import type { SeriesRecord } from './records.js';

import { h2h, loadRows, standings } from './records.js';
import { asRecord } from './value.js';

const CSS = `
:root { color-scheme: light dark; --line: #8884; --accent: #d33682; }
body { font-family: system-ui, sans-serif; max-width: 72rem; margin: 2rem auto; padding: 0 1rem; }
h1 { letter-spacing: 0.02em; }
h2 { border-bottom: 2px solid var(--accent); padding-bottom: 0.2rem; margin-top: 2.5rem; }
table { border-collapse: collapse; margin: 1rem 0; font-size: 0.92rem; }
th, td { border: 1px solid var(--line); padding: 0.35rem 0.7rem; text-align: left; }
th { background: #8881; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.winner-a td.a, tr.winner-b td.b { font-weight: 700; color: var(--accent); }
.meta { opacity: 0.7; font-size: 0.85rem; }
.wrap { overflow-x: auto; }
`;

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
}

function standingsTable(rows: SeriesRecord[]): string {
  const head = '<tr><th>Model</th><th>Series</th><th>W</th><th>L</th><th>T</th><th>Win rate</th><th>Elo</th></tr>';
  const body = standings(rows)
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.spec)}</td><td class=num>${item.series}</td><td class=num>${item.w}</td><td class=num>${item.l}</td><td class=num>${item.t}</td><td class=num>${(100 * item.winrate).toFixed(1)}%</td><td class=num>${item.elo.toFixed(1)}</td></tr>`,
    )
    .join('');
  return `<div class=wrap><table>${head}${body}</table></div>`;
}

function h2hTable(rows: SeriesRecord[]): string {
  const matrix = h2h(rows);
  const specs = Object.keys(matrix);
  if (specs.length < 2) return '';
  const head = `<tr><th>W-L-T</th>${specs.map((spec) => `<th>${escapeHtml(spec)}</th>`).join('')}</tr>`;
  const body = specs
    .map(
      (a) =>
        `<tr><th>${escapeHtml(a)}</th>${specs.map((b) => (a === b ? '<td class=num>-</td>' : `<td class=num>${matrix[a]![b]!.join('-')}</td>`)).join('')}</tr>`,
    )
    .join('');
  return `<h3>Head-to-head</h3><div class=wrap><table>${head}${body}</table></div>`;
}

function seriesTable(rows: SeriesRecord[], limit = 40): string {
  const head =
    '<tr><th>When (UTC)</th><th>p1</th><th>p2</th><th>Teams</th><th>Score</th><th>Winner</th><th>Games</th><th>Turns</th></tr>';
  const body = rows
    .slice(-limit)
    .reverse()
    .map((row) => {
      const teams = asRecord(row.teams);
      const score = asRecord(row.score);
      const games = Array.isArray(row.games) ? row.games : [];
      const side = row.winner_side === 'p1' || row.winner_side === 'p2' ? row.winner_side : '';
      return `<tr class='${side === 'p1' ? 'winner-a' : side === 'p2' ? 'winner-b' : ''}'><td>${escapeHtml(String(row.timestamp ?? '').slice(0, 19))}</td><td class=a>${escapeHtml(row.players.p1)}</td><td class=b>${escapeHtml(row.players.p2)}</td><td>${escapeHtml(`${teams.p1 ?? '—'} vs ${teams.p2 ?? '—'}`)}</td><td class=num>${escapeHtml(`${score.p1 ?? '?'}-${score.p2 ?? '?'}`)}</td><td>${escapeHtml(row.winner ?? 'tie')}</td><td class=num>${games.length}</td><td class=num>${escapeHtml(row.turns ?? '?')}</td></tr>`;
    })
    .join('');
  return `<h3>Recent series</h3><div class=wrap><table>${head}${body}</table></div>`;
}

function gamesTable(rows: SeriesRecord[], limit = 80): string {
  const head = '<tr><th>Series</th><th>Game</th><th>p1</th><th>p2</th><th>Winner</th><th>Turns</th><th>Log</th></tr>';
  const games = rows.flatMap((series) =>
    Array.isArray(series.games) ? series.games.map((game) => ({ series, game: asRecord(game) })) : [],
  );
  const body = games
    .slice(-limit)
    .reverse()
    .map(({ series, game }) => {
      const side = game.winner_side;
      return `<tr class='${side === 'p1' ? 'winner-a' : side === 'p2' ? 'winner-b' : ''}'><td class=meta>${escapeHtml(series.series_id)}</td><td class=num>${escapeHtml(game.number ?? '?')}</td><td class=a>${escapeHtml(series.players.p1)}</td><td class=b>${escapeHtml(series.players.p2)}</td><td>${escapeHtml(game.winner ?? 'tie')}</td><td class=num>${escapeHtml(game.turns ?? '?')}</td><td class=meta>${escapeHtml(game.log)}</td></tr>`;
    })
    .join('');
  return `<h3>Games</h3><div class=wrap><table>${head}${body}</table></div>`;
}

export function writeReport(recordsPath: string, outPath: string, pool?: string): string {
  const rows = loadRows(recordsPath).filter((row) => pool === undefined || row.pool === pool);
  const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(),
  );
  const poolText = pool === undefined ? '' : ` for pool ${escapeHtml(pool)}`;
  const document = `<!doctype html><meta charset=utf-8><title>VGC Model League records</title><style>${CSS}</style><h1>VGC Model League records</h1><p class=meta>${rows.length} completed series${poolText} — generated ${stamp} UTC</p>${standingsTable(rows)}${h2hTable(rows)}${seriesTable(rows)}${gamesTable(rows)}`;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, document, 'utf8');
  return outPath;
}
