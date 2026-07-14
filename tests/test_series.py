from vgcbench import arena
from vgcbench.records import load_rows
from vgcbench.teams import Team, TeamPool


class FakeEngine:
    def __init__(self):
        self.begins = []
        self.ends = []
        self.decisions = 0

    def begin_game(self, **context):
        self.begins.append(context)

    def end_game(self, **context):
        self.ends.append(context)

    def decision_stats(self):
        return {"decisions": self.decisions}


class FakeBattle:
    battles = []

    def __init__(self, format_id, p1, p2, seed, ps_dir, node):
        self.format_id = format_id
        self.players = {"p1": p1, "p2": p2}
        self.seed = seed
        self.__class__.battles.append(self)

    def run(self, engines):
        self.engines = dict(engines)
        for engine in engines.values():
            engine.decisions += 1
        winner = self.players["p1"]["name"]
        return {
            "winner": winner,
            "turns": 4,
            "log": ["|turn|1", f"|win|{winner}"],
            "pov": {"p1": ["p1-visible"], "p2": ["p2-visible"]},
            "errors": {"p1": 0, "p2": 0},
            "fallbacks": {"p1": 0, "p2": 0},
        }


def test_bo3_reuses_players_and_teams_and_writes_one_result(monkeypatch, tmp_path):
    engines = []
    pool = TeamPool("test", "gen9championsvgc2026regmbbo3", (
        Team("team-a", "packed-a"),
        Team("team-b", "packed-b"),
    ))

    def make_engine(*args, **kwargs):
        engine = FakeEngine()
        engines.append(engine)
        return engine

    FakeBattle.battles = []
    monkeypatch.setattr(arena, "make_engine", make_engine)
    monkeypatch.setattr(arena, "SimBattle", FakeBattle)
    monkeypatch.setattr(arena, "load_pool", lambda *args, **kwargs: pool)
    monkeypatch.setattr(arena, "validate_pool", lambda *args, **kwargs: None)
    monkeypatch.setattr(arena, "ps_commit", lambda _: "commit")
    records_path = tmp_path / "results.jsonl"

    rows = arena.run_benchmark(
        ["openai:model-a", "anthropic:model-b"],
        1,
        tmp_path / "run",
        seed=7,
        concurrency=1,
        records_path=records_path,
        ps_dir=tmp_path,
        node="node",
    )

    assert len(rows) == 1
    series = rows[0]
    assert series["score"] == {"p1": 2, "p2": 0}
    assert len(series["games"]) == 2
    assert len(FakeBattle.battles) == 2
    assert FakeBattle.battles[0].players == FakeBattle.battles[1].players
    assert FakeBattle.battles[0].engines == FakeBattle.battles[1].engines
    assert [item["game_number"] for item in engines[0].begins] == [1, 2]
    assert [item["series_score"] for item in engines[0].begins] == [
        {"p1": 0, "p2": 0},
        {"p1": 1, "p2": 0},
    ]
    assert engines[0].ends[0]["outcome"]["pov_lines"] == ["p1-visible"]
    assert engines[1].ends[0]["outcome"]["pov_lines"] == ["p2-visible"]
    assert series["decision_stats"] == {
        "p1": {"decisions": 2},
        "p2": {"decisions": 2},
    }
    assert load_rows(records_path) == [series]


def test_paired_series_swap_models_across_sides_and_teams():
    teams = [Team("a", "a"), Team("b", "b")]
    plans = arena._make_plans(["one", "two"], 2, teams, __import__("random").Random(1))

    assert plans[0]["players"] == {"p1": "one", "p2": "two"}
    assert plans[1]["players"] == {"p1": "two", "p2": "one"}
    assert plans[0]["teams"] == plans[1]["teams"]
