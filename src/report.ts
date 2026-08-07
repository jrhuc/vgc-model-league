import fs from 'node:fs';
import path from 'node:path';

import type { SeriesRecord } from './records.js';

import { loadRows, scopeRows, TEST_POOL } from './records.js';
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

function seriesTable(rows: SeriesRecord[], limit = 100): string {
  const head =
    '<tr><th>When (UTC)</th><th>Mode</th><th>Pool</th><th>Clock</th><th>Scaffold</th><th>p1</th><th>p2</th><th>Teams</th><th>Score</th><th>Winner</th><th>Games</th><th>Turns</th></tr>';
  const body = rows
    .slice(-limit)
    .reverse()
    .map((row) => {
      const teams = asRecord(row.teams);
      const score = asRecord(row.score);
      const games = Array.isArray(row.games) ? row.games : [];
      const side = row.winner_side === 'p1' || row.winner_side === 'p2' ? row.winner_side : '';
      const clock = row.timer_scale === 'off' ? 'off' : `${row.timer_scale ?? 1}x`;
      return `<tr class='${side === 'p1' ? 'winner-a' : side === 'p2' ? 'winner-b' : ''}'><td>${escapeHtml(String(row.timestamp ?? '').slice(0, 19))}</td><td>${escapeHtml(row.mode ?? 'legacy')}</td><td>${escapeHtml(row.pool ?? 'unrecorded')}</td><td>${escapeHtml(clock)}</td><td class=meta>${escapeHtml(row.scaffold ?? 'unrecorded')}</td><td class=a>${escapeHtml(row.players.p1)}</td><td class=b>${escapeHtml(row.players.p2)}</td><td>${escapeHtml(`${teams.p1 ?? 'not recorded'} vs ${teams.p2 ?? 'not recorded'}`)}</td><td class=num>${escapeHtml(`${score.p1 ?? '?'}-${score.p2 ?? '?'}`)}</td><td>${escapeHtml(row.winner ?? 'tie')}</td><td class=num>${games.length}</td><td class=num>${escapeHtml(row.turns ?? '?')}</td></tr>`;
    })
    .join('');
  return `<h2>Recorded series</h2><div class=wrap><table>${head}${body}</table></div>`;
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
  const rows = scopeRows(loadRows(recordsPath), pool);
  const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(),
  );
  const poolText =
    pool === undefined ? ` across all pools (pool ${escapeHtml(TEST_POOL)} excluded)` : ` for pool ${escapeHtml(pool)}`;
  const document = `<!doctype html><meta charset=utf-8><title>VGC Model League records</title><style>${CSS}</style><h1>VGC Model League records</h1><p class=meta>${rows.length} completed series${poolText}. These are per-series outcomes from heterogeneous recorded contexts, not an aggregate model ranking. Pool, clock, scaffold, opponents, and sample size remain attached to each row. Generated ${stamp} UTC.</p>${seriesTable(rows)}${gamesTable(rows)}`;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, document, 'utf8');
  return outPath;
}
