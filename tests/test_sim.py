import time
from threading import Barrier

from vgcbench.arena import run_benchmark
from vgcbench.engines import RandomEngine
from vgcbench.sim import SimBattle, default_node, default_ps_dir, route_update_lines
from vgcbench.teams import load_pool


PS = default_ps_dir()
NODE = default_node()


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


def test_showdown_timer_autochooses_for_a_slow_player():
    class SlowOnceEngine(RandomEngine):
        def __init__(self, pid, seed):
            super().__init__(pid, seed)
            self.slow = True

        def act(self, request, ctx):
            if self.slow:
                self.slow = False
                time.sleep(11)
            return super().act(request, ctx)

    pool = load_pool()
    packed = [team.packed for team in pool.teams[:2]]
    format_id = pool.format + "@@@!!timermaxfirstturn=10,!!timermaxperturn=10"
    battle = SimBattle(
        format_id,
        {"name": "A-slow", "team": packed[0]},
        {"name": "B-random", "team": packed[1]},
        [9, 10, 11, 12],
        PS,
        NODE,
    )

    outcome = battle.run({"p1": SlowOnceEngine("p1", 1), "p2": RandomEngine("p2", 2)})

    assert outcome["fallbacks"]["p1"] >= 1
    assert "|timer|autodefault" in outcome["pov"]["p1"]


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

def test_empty_public_split_half_is_consumed_without_leaking():
    pov = {"p1": [], "p2": []}
    log: list[str] = []
    pending: list[str] = []
    route_update_lines(
        ["|foo", "|split|p1", "|p1a: Foo|123/200", "", "|bar"],
        pov=pov,
        log=log,
        pending_split=pending,
        winner=None,
        turns=0,
    )
    assert pov["p1"] == ["|foo", "|p1a: Foo|123/200", "|bar"]
    assert pov["p2"] == ["|foo", "|bar"]
    assert pending == []


def test_incomplete_split_is_buffered_until_public_half_arrives():
    pov = {"p1": [], "p2": []}
    log: list[str] = []
    pending: list[str] = []
    route_update_lines(
        ["|split|p1", "|secret"],
        pov=pov,
        log=log,
        pending_split=pending,
        winner=None,
        turns=0,
    )
    assert pending == ["|split|p1", "|secret"]
    route_update_lines(
        ["|public", "|after"],
        pov=pov,
        log=log,
        pending_split=pending,
        winner=None,
        turns=0,
    )
    assert pov["p1"] == ["|secret", "|after"]
    assert pov["p2"] == ["|public", "|after"]
    assert pending == []

