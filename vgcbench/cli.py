from __future__ import annotations

import argparse
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .arena import run_benchmark
from .providers import REASONING_LEVELS
from .records import h2h, load_rows, standings
from .sim import REPO_ROOT


RESULTS = REPO_ROOT / "records" / "results.jsonl"
RUNS = REPO_ROOT / "runs"


def _positive_int(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return number


def _run_dir() -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    path = RUNS / f"{stamp}-{uuid.uuid4().hex[:8]}"
    path.mkdir(parents=True)
    return path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="vgcbench")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("selfcheck")

    run = commands.add_parser("run")
    run.add_argument("--models", nargs="+", required=True)
    run.add_argument("--series-per-pair", type=_positive_int, default=1)
    run.add_argument("--pool", default="test")
    run.add_argument("--seed", type=int)
    run.add_argument("--concurrency", type=_positive_int, default=2)
    run.add_argument("--reasoning", choices=REASONING_LEVELS)

    commands.add_parser("standings")
    report = commands.add_parser("report")
    report.add_argument("--out", default=str(REPO_ROOT / "records" / "report.html"))
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "selfcheck":
        return selfcheck()
    if args.command == "run":
        if len(args.models) < 2:
            raise SystemExit("run requires at least two models")
        rows = run_benchmark(
            args.models,
            args.series_per_pair,
            _run_dir(),
            seed=args.seed,
            concurrency=args.concurrency,
            records_path=RESULTS,
            reasoning=args.reasoning,
            pool_name=args.pool,
        )
        _print_results(rows)
        return 0
    if args.command == "report":
        from .report import write_report

        print(write_report(RESULTS, args.out))
        return 0
    _print_standings(load_rows(RESULTS))
    return 0


def selfcheck() -> int:
    run_dir = _run_dir()
    try:
        rows = run_benchmark(
            ["random", "random"],
            1,
            run_dir,
            seed=1,
            concurrency=1,
            records_path=run_dir / "results.jsonl",
        )
    except Exception as exc:
        print(f"selfcheck failed: {exc}", file=sys.stderr)
        return 1
    _print_results(rows)
    return 0


def _print_results(rows: list[dict]) -> None:
    for row in rows:
        score = row["score"]
        print(
            f"{row['players']['p1']} vs {row['players']['p2']}: "
            f"{row['winner'] or 'tie'} ({score['p1']}-{score['p2']}, "
            f"{len(row['games'])} games, {row['turns']} turns)"
        )


def _print_standings(rows: list[dict]) -> None:
    from rich.console import Console
    from rich.table import Table

    table = Table(title="VGC BO3")
    for column in ("Model", "Series", "W", "L", "T", "Win rate", "Elo"):
        table.add_column(column)
    for item in standings(rows):
        table.add_row(
            item["spec"],
            str(item["series"]),
            str(item["w"]),
            str(item["l"]),
            str(item["t"]),
            f"{item['winrate']:.1%}",
            f"{item['elo']:.1f}",
        )
    console = Console()
    console.print(table)

    matrix = h2h(rows)
    if len(matrix) < 2:
        return
    head = Table(title="Head-to-head (W-L-T)")
    head.add_column("Model")
    specs = list(matrix)
    for spec in specs:
        head.add_column(spec)
    for a in specs:
        head.add_row(a, *("-" if a == b else "-".join(map(str, matrix[a][b])) for b in specs))
    console.print(head)
