from pathlib import Path
from threading import Barrier

from vgcbench.arena import run_benchmark
from vgcbench.engines import RandomEngine
from vgcbench.sim import SimBattle
from vgcbench.teams import load_pool


ROOT = Path(__file__).parents[1]
PS = ROOT.parent / "pokemon-showdown"
NODE = Path.home() / ".local/bin/node"


def test_seeded_random_vgc_game():
    pool = load_pool()
    packed = [team.packed for team in pool.teams[:2]]
    battle = SimBattle(
        pool.format,
        {"name": "A-random", "team": packed[0]},
        {"name": "B-random", "team": packed[1]},
        [1, 2, 3, 4],
        PS,
        NODE,
    )
    outcome = battle.run({"p1": RandomEngine("p1", 10), "p2": RandomEngine("p2", 20)})
    assert outcome["winner"] in {"A-random", "B-random", None}
    assert outcome["turns"] > 0
    assert outcome["errors"] == {"p1": 0, "p2": 0}
    assert not any(line.startswith("|split|") for line in outcome["pov"]["p1"] + outcome["pov"]["p2"])


def test_players_can_think_concurrently():
    barrier = Barrier(2, timeout=2)

    class BarrierEngine(RandomEngine):
        def __init__(self, pid, seed):
            super().__init__(pid, seed)
            self.first = True

        def act(self, request, ctx):
            if self.first:
                self.first = False
                barrier.wait()
            return super().act(request, ctx)

    pool = load_pool()
    packed = [team.packed for team in pool.teams[:2]]
    battle = SimBattle(
        pool.format,
        {"name": "A-random", "team": packed[0]},
        {"name": "B-random", "team": packed[1]},
        [5, 6, 7, 8],
        PS,
        NODE,
    )

    outcome = battle.run({"p1": BarrierEngine("p1", 1), "p2": BarrierEngine("p2", 2)})

    assert outcome["turns"] > 0


def test_arena_random(tmp_path):
    rows = run_benchmark(
        ["random", "random"],
        1,
        tmp_path / "run",
        seed=1,
        concurrency=1,
        records_path=tmp_path / "rows.jsonl",
    )
    assert len(rows) == 1
    assert rows[0]["run_seed"] == 1
    assert rows[0]["series_index"] == 0
    assert 2 <= len(rows[0]["games"]) <= 3
    assert set(rows[0]["engine_seeds"]) == {"p1", "p2"}
