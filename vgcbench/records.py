import json
import subprocess
from functools import lru_cache
from pathlib import Path


def append_row(path, row: dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, separators=(",", ":"), ensure_ascii=False) + "\n")


def load_rows(path) -> list[dict]:
    path = Path(path)
    if not path.exists():
        return []
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


@lru_cache(maxsize=None)
def ps_commit(ps_dir) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(Path(ps_dir)), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        )
        return result.stdout.strip() or "unknown"
    except (OSError, subprocess.SubprocessError):
        return "unknown"


def _scheduled(rows: list[dict]) -> list[dict]:
    indexed = list(enumerate(rows))
    indexed.sort(
        key=lambda item: (
            str(item[1].get("run_id", "")),
            item[1].get("series_index")
            if isinstance(item[1].get("series_index"), int)
            else item[0],
            item[0],
        )
    )
    return [row for _, row in indexed]


def standings(rows: list[dict]) -> list[dict]:
    scheduled = _scheduled(rows)
    specs = sorted({spec for row in scheduled for spec in row.get("players", {}).values()})
    ratings = {spec: 1000.0 for spec in specs}
    totals = {spec: {"series": 0, "w": 0, "l": 0, "t": 0} for spec in specs}
    for row in scheduled:
        p1 = row["players"]["p1"]
        p2 = row["players"]["p2"]
        winner = row.get("winner")
        score1 = 0.5 if winner is None else float(winner == p1)
        score2 = 1.0 - score1
        if p1 != p2:
            expected1 = 1.0 / (1.0 + 10 ** ((ratings[p2] - ratings[p1]) / 400.0))
            expected2 = 1.0 - expected1
            old1, old2 = ratings[p1], ratings[p2]
            ratings[p1] = old1 + 24 * (score1 - expected1)
            ratings[p2] = old2 + 24 * (score2 - expected2)
        for spec in (p1, p2):
            totals[spec]["series"] += 1
        if winner is None:
            totals[p1]["t"] += 1
            totals[p2]["t"] += 1
        else:
            loser = p2 if winner == p1 else p1
            totals[winner]["w"] += 1
            totals[loser]["l"] += 1
    table = []
    for spec in specs:
        item = {"spec": spec, **totals[spec]}
        series = item["series"]
        item["winrate"] = (item["w"] + 0.5 * item["t"]) / series if series else 0.0
        item["elo"] = ratings[spec]
        table.append(item)
    return sorted(table, key=lambda item: (-item["elo"], item["spec"]))


def h2h(rows: list[dict]) -> dict[str, dict[str, tuple[int, int, int]]]:
    specs = sorted({spec for row in rows for spec in row.get("players", {}).values()})
    matrix = {a: {b: (0, 0, 0) for b in specs} for a in specs}
    for row in rows:
        p1, p2 = row["players"]["p1"], row["players"]["p2"]
        winner = row.get("winner")
        if p1 == p2:
            current = matrix[p1][p1]
            if winner is None:
                matrix[p1][p1] = (current[0], current[1], current[2] + 2)
            else:
                matrix[p1][p1] = (current[0] + 1, current[1] + 1, current[2])
            continue
        if winner is None:
            a = matrix[p1][p2]
            b = matrix[p2][p1]
            matrix[p1][p2] = (a[0], a[1], a[2] + 1)
            matrix[p2][p1] = (b[0], b[1], b[2] + 1)
        elif winner == p1:
            a = matrix[p1][p2]
            b = matrix[p2][p1]
            matrix[p1][p2] = (a[0] + 1, a[1], a[2])
            matrix[p2][p1] = (b[0], b[1] + 1, b[2])
        else:
            a = matrix[p1][p2]
            b = matrix[p2][p1]
            matrix[p1][p2] = (a[0], a[1] + 1, a[2])
            matrix[p2][p1] = (b[0] + 1, b[1], b[2])
    return matrix
