import html
from datetime import datetime, timezone
from pathlib import Path

from .records import h2h, load_rows, standings

_CSS = """
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
"""


def _standings_table(table: list[dict]) -> str:
    head = "<tr><th>Model</th><th>Series</th><th>W</th><th>L</th><th>T</th><th>Win rate</th><th>Elo</th></tr>"
    rows = [
        "<tr><td>{spec}</td><td class=num>{series}</td><td class=num>{w}</td><td class=num>{l}</td>"
        "<td class=num>{t}</td><td class=num>{winrate:.1%}</td><td class=num>{elo:.1f}</td></tr>".format(
            spec=html.escape(item["spec"]), **{k: item[k] for k in ("series", "w", "l", "t", "winrate", "elo")}
        )
        for item in table
    ]
    return f"<div class=wrap><table>{head}{''.join(rows)}</table></div>"


def _h2h_table(matrix: dict) -> str:
    specs = list(matrix)
    if len(specs) < 2:
        return ""
    head = "<tr><th>W-L-T</th>" + "".join(f"<th>{html.escape(spec)}</th>" for spec in specs) + "</tr>"
    rows = []
    for spec_a in specs:
        cells = "".join(
            "<td class=num>-</td>" if spec_a == spec_b else "<td class=num>{}-{}-{}</td>".format(*matrix[spec_a][spec_b])
            for spec_b in specs
        )
        rows.append(f"<tr><th>{html.escape(spec_a)}</th>{cells}</tr>")
    return f"<h3>Head-to-head</h3><div class=wrap><table>{head}{''.join(rows)}</table></div>"


def _series_table(rows: list[dict], limit: int = 40) -> str:
    head = (
        "<tr><th>When (UTC)</th><th>p1</th><th>p2</th><th>Teams</th><th>Score</th>"
        "<th>Winner</th><th>Games</th><th>Turns</th></tr>"
    )
    out = []
    for row in reversed(rows[-limit:]):
        side = row.get("winner_side")
        cls = {"p1": "winner-a", "p2": "winner-b"}.get(side or "", "")
        teams = row.get("teams", {})
        team_txt = " vs ".join(str(teams.get(pid) or "—") for pid in ("p1", "p2"))
        score = row.get("score", {})
        score_txt = f"{score.get('p1', '?')}-{score.get('p2', '?')}"
        winner = row.get("winner") or "tie"
        games = row.get("games", [])
        out.append(
            f"<tr class='{cls}'><td>{html.escape(str(row.get('timestamp', ''))[:19])}</td>"
            f"<td class=a>{html.escape(row['players']['p1'])}</td>"
            f"<td class=b>{html.escape(row['players']['p2'])}</td>"
            f"<td>{html.escape(team_txt)}</td><td class=num>{html.escape(score_txt)}</td>"
            f"<td>{html.escape(winner)}</td><td class=num>{len(games)}</td>"
            f"<td class=num>{row.get('turns', '?')}</td></tr>"
        )
    return f"<h3>Recent series</h3><div class=wrap><table>{head}{''.join(out)}</table></div>"


def _games_table(rows: list[dict], limit: int = 80) -> str:
    head = (
        "<tr><th>Series</th><th>Game</th><th>p1</th><th>p2</th><th>Winner</th>"
        "<th>Turns</th><th>Log</th></tr>"
    )
    games = [(series, game) for series in rows for game in series.get("games", [])]
    out = []
    for series, game in reversed(games[-limit:]):
        side = game.get("winner_side")
        cls = {"p1": "winner-a", "p2": "winner-b"}.get(side or "", "")
        players = series["players"]
        winner = game.get("winner") or "tie"
        out.append(
            f"<tr class='{cls}'><td class=meta>{html.escape(str(series.get('series_id', '')))}</td>"
            f"<td class=num>{game.get('number', '?')}</td>"
            f"<td class=a>{html.escape(players['p1'])}</td>"
            f"<td class=b>{html.escape(players['p2'])}</td>"
            f"<td>{html.escape(winner)}</td><td class=num>{game.get('turns', '?')}</td>"
            f"<td class=meta>{html.escape(str(game.get('log', '')))}</td></tr>"
        )
    return f"<h3>Games</h3><div class=wrap><table>{head}{''.join(out)}</table></div>"


def write_report(records_path, out_path) -> Path:
    rows = load_rows(records_path)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    doc = (
        "<!doctype html><meta charset=utf-8><title>vgcbench records</title>"
        f"<style>{_CSS}</style><h1>vgcbench records</h1>"
        f"<p class=meta>{len(rows)} completed series — generated {stamp}</p>"
        + _standings_table(standings(rows))
        + _h2h_table(h2h(rows))
        + _series_table(rows)
        + _games_table(rows)
    )
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(doc, encoding="utf-8")
    return out_path
