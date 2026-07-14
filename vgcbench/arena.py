from __future__ import annotations

import json
import random
import sys
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from itertools import combinations
from pathlib import Path

from .engines import LLMEngine, RandomEngine
from .records import append_row, ps_commit
from .sim import REPO_ROOT, SimBattle, _default_node, _default_ps_dir
from .teams import load_pool, validate_pool


def make_engine(
    pid: str,
    spec: str,
    seed: int,
    decision_log: Path,
    format_id: str,
    reasoning: str | None,
    ps_dir: Path,
    node: str,
):
    if spec == "random":
        return RandomEngine(pid, seed)

    from .providers import make_provider, parse_spec

    provider = make_provider(parse_spec(spec), reasoning=reasoning)
    return LLMEngine(
        pid,
        spec,
        provider=provider,
        decision_log=decision_log,
        format_id=format_id,
        ps_dir=ps_dir,
        node=node,
    )


def run_benchmark(
    models: list[str],
    series_per_pair: int,
    run_dir: str | Path,
    *,
    seed: int | None = None,
    concurrency: int = 2,
    records_path: str | Path | None = None,
    ps_dir: str | Path | None = None,
    node: str | None = None,
    reasoning: str | None = None,
    pool_name: str = "test",
) -> list[dict]:
    if len(models) < 2:
        raise ValueError("at least two models are required")
    if series_per_pair % 2:
        print(
            "warning: an odd --series-per-pair leaves each pair's last matchup unmirrored",
            file=sys.stderr,
        )

    from .providers import parse_spec, validate_reasoning

    for model in models:
        validate_reasoning(parse_spec(model), reasoning)

    run_dir = Path(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    records_path = Path(records_path) if records_path else REPO_ROOT / "records" / "results.jsonl"
    ps_dir = Path(ps_dir).expanduser() if ps_dir else _default_ps_dir()
    node = node or _default_node()
    pool = load_pool(pool_name)
    validate_pool(pool, ps_dir=ps_dir, node=node)

    effective_seed = seed if seed is not None else random.SystemRandom().randrange(2**63)
    rng = random.Random(effective_seed)
    plans = _make_plans(models, series_per_pair, pool.teams, rng)
    (run_dir / "config.json").write_text(
        json.dumps(
            {
                "models": models,
                "series_per_pair": series_per_pair,
                "seed": effective_seed,
                "concurrency": concurrency,
                "reasoning": reasoning,
                "pool": pool.id,
                "format": pool.format,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    records_lock = threading.Lock()

    def play(plan: dict) -> dict:
        row = _play_series(
            plan,
            run_dir=run_dir,
            pool=pool,
            run_seed=effective_seed,
            reasoning=reasoning,
            ps_dir=ps_dir,
            node=node,
        )
        with records_lock:
            append_row(records_path, row)
        return row

    if concurrency == 1:
        rows = [play(plan) for plan in plans]
    else:
        rows = [None] * len(plans)
        with ThreadPoolExecutor(max_workers=concurrency) as executor:
            futures = {executor.submit(play, plan): plan["index"] for plan in plans}
            for future in as_completed(futures):
                rows[futures[future]] = future.result()

    return [row for row in rows if row is not None]


def _make_plans(models, series_per_pair, teams, rng: random.Random) -> list[dict]:
    plans = []
    index = 0
    for model_a, model_b in combinations(models, 2):
        matchup = None
        for pair_index in range(series_per_pair):
            if pair_index % 2 == 0 or matchup is None:
                matchup = rng.sample(list(teams), 2)
            players = [model_a, model_b]
            selected = list(matchup)
            if pair_index % 2:
                players.reverse()
            plans.append(
                {
                    "index": index,
                    "players": {"p1": players[0], "p2": players[1]},
                    "teams": {"p1": selected[0], "p2": selected[1]},
                    "game_seeds": [
                        [rng.randrange(1, 0x10000) for _ in range(4)]
                        for _ in range(3)
                    ],
                    "engine_seeds": {"p1": rng.randrange(2**63), "p2": rng.randrange(2**63)},
                }
            )
            index += 1
    return plans


def _play_series(plan, *, run_dir, pool, run_seed, reasoning, ps_dir, node) -> dict:
    series_id = uuid.uuid4().hex[:12]
    series_dir = run_dir / "series" / series_id
    series_dir.mkdir(parents=True, exist_ok=True)
    players = plan["players"]
    team_ids = {pid: plan["teams"][pid].id for pid in ("p1", "p2")}
    names = {pid: f"{pid}-{players[pid]}" for pid in ("p1", "p2")}
    engines = {
        pid: make_engine(
            pid,
            players[pid],
            plan["engine_seeds"][pid],
            series_dir / f"{pid}-decisions.jsonl",
            pool.format,
            reasoning,
            ps_dir,
            node,
        )
        for pid in ("p1", "p2")
    }
    score = {"p1": 0, "p2": 0}
    games = []
    for game_number, game_seed in enumerate(plan["game_seeds"], 1):
        game_id = f"{series_id}-{game_number}"
        for engine in engines.values():
            engine.begin_game(
                game_id=game_id,
                game_number=game_number,
                series_id=series_id,
                series_score=dict(score),
            )

        battle = SimBattle(
            pool.format,
            {"name": names["p1"], "team": plan["teams"]["p1"].packed},
            {"name": names["p2"], "team": plan["teams"]["p2"].packed},
            game_seed,
            ps_dir,
            node,
        )
        outcome = battle.run(engines)
        winner_side = next((pid for pid, name in names.items() if name == outcome["winner"]), None)
        if winner_side:
            score[winner_side] += 1

        for pid, engine in engines.items():
            engine.end_game(
                outcome={
                    "winner": outcome["winner"],
                    "winner_side": winner_side,
                    "won": winner_side == pid,
                    "turns": outcome["turns"],
                    "pov_lines": outcome["pov"][pid],
                    "errors": outcome["errors"][pid],
                    "fallbacks": outcome["fallbacks"][pid],
                },
                game_number=game_number,
                series_score=dict(score),
            )

        log_path = series_dir / f"game-{game_number}.log"
        log_path.write_text("\n".join(outcome["log"]) + "\n", encoding="utf-8")
        games.append(
            {
                "number": game_number,
                "winner": players[winner_side] if winner_side else None,
                "winner_side": winner_side,
                "turns": outcome["turns"],
                "seed": game_seed,
                "errors": outcome["errors"],
                "fallbacks": outcome["fallbacks"],
                "log": _relative(log_path),
            }
        )
        if max(score.values()) == 2:
            break

    if score["p1"] != score["p2"]:
        winner_side = "p1" if score["p1"] > score["p2"] else "p2"
    else:
        winner_side = None
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "run_id": run_dir.name,
        "series_id": series_id,
        "series_index": plan["index"],
        "format": pool.format,
        "pool": pool.id,
        "players": players,
        "teams": team_ids,
        "winner": players[winner_side] if winner_side else None,
        "winner_side": winner_side,
        "score": score,
        "turns": sum(game["turns"] for game in games),
        "games": games,
        "run_seed": run_seed,
        "engine_seeds": plan["engine_seeds"],
        "reasoning": reasoning,
        "decision_stats": {pid: engine.decision_stats() for pid, engine in engines.items()},
        "ps_commit": ps_commit(str(ps_dir)),
    }


def _relative(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(path)
