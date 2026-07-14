import pytest

from vgcbench.records import append_row, h2h, load_rows, standings
from vgcbench.report import write_report


def row(p1, p2, winner):
    return {"players": {"p1": p1, "p2": p2}, "winner": winner, "games": []}


def test_standings_elo_and_ties():
    table = {item["spec"]: item for item in standings([row("a", "b", "a"), row("a", "b", None)])}
    assert table["a"]["w"] == 1
    assert table["a"]["t"] == 1
    assert table["a"]["winrate"] == pytest.approx(0.75)
    assert table["a"]["elo"] == pytest.approx(1011.172385, rel=1e-5)
    assert table["b"]["elo"] == pytest.approx(988.827615, rel=1e-5)


def test_h2h_is_from_each_models_perspective():
    matrix = h2h([row("a", "b", "a"), row("b", "a", None), row("b", "a", "b")])
    assert matrix["a"]["b"] == (1, 1, 1)
    assert matrix["b"]["a"] == (1, 1, 1)


def test_self_play_does_not_move_elo():
    table = standings([row("a", "a", "a")])
    assert table[0]["elo"] == 1000
    assert table[0]["series"] == 2
    assert h2h([row("a", "a", "a")])["a"]["a"] == (1, 1, 0)


def test_elo_uses_scheduled_order_not_completion_order():
    scheduled = [
        {**row("a", "b", "a"), "run_id": "run", "series_index": 0},
        {**row("a", "b", "b"), "run_id": "run", "series_index": 1},
        {**row("a", "c", "a"), "run_id": "run", "series_index": 2},
    ]
    assert standings(scheduled) == standings(list(reversed(scheduled)))


def test_every_ledger_row_is_rated_as_one_series():
    rows = [row("a", "b", "a"), row("a", "b", "b")]
    table = {item["spec"]: item for item in standings(rows)}
    assert table["a"]["series"] == 2
    assert table["a"]["w"] == 1
    assert table["a"]["l"] == 1
    assert table["b"]["w"] == 1
    assert h2h(rows)["a"]["b"] == (1, 1, 0)


def test_report_renders_series_and_their_nested_games(tmp_path):
    result = {
        **row("a", "b", "a"),
        "timestamp": "2026-07-14T12:00:00+00:00",
        "series_id": "series-1",
        "winner_side": "p1",
        "teams": {"p1": "team-a", "p2": "team-b"},
        "score": {"p1": 2, "p2": 0},
        "turns": 12,
        "games": [
            {"number": 1, "winner": "a", "winner_side": "p1", "turns": 5, "log": "game-1.log"},
            {"number": 2, "winner": "a", "winner_side": "p1", "turns": 7, "log": "game-2.log"},
        ],
    }
    records = tmp_path / "results.jsonl"
    append_row(records, result)

    report = write_report(records, tmp_path / "report.html").read_text()

    assert "1 completed series" in report
    assert "Recent series" in report
    assert "series-1" in report
    assert "game-1.log" in report
    assert "game-2.log" in report
