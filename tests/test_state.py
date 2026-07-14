from pathlib import Path

from vgcbench.engines import RandomEngine
from vgcbench.sim import SimBattle
from vgcbench.state import BattleState
from vgcbench.teams import load_pool


ROOT = Path(__file__).parents[1]
PS = ROOT / "pokemon-showdown"
NODE = Path.home() / ".local/bin/node"


def test_state_consumes_recorded_pov_and_renders_revealed_foe():
    pool = load_pool()
    teams = pool.teams
    battle = SimBattle(
        pool.format,
        {"name": "A", "team": teams[0].packed},
        {"name": "B", "team": teams[1].packed},
        [31, 32, 33, 34],
        PS,
        NODE,
    )
    outcome = battle.run({"p1": RandomEngine("p1", 1), "p2": RandomEngine("p2", 2)})
    state = BattleState("p1", "gen9championsvgc2026regmb")
    state.feed(outcome["pov"]["p1"])
    assert state.turn == outcome["turns"]
    assert any(mon.hp is not None for mon in state.sides["p2"].mons.values())
    rendered = state.render({})
    assert "Opponent side" in rendered
    assert "HP " in rendered


def test_showteam_sheet():
    state = BattleState("p1", "gen9championsvgc2026regmb")
    state.feed(["|showteam|p2|Incineroar||SafetyGoggles|Intimidate|fakeout,partingshot|Careful|||||50]Urshifu|UrshifuRapidStrike|MysticWater|UnseenFist|surgingstrikes,protect|Adamant|||||50"])
    assert state.sides["p2"].showteam
    rendered = state.render({})
    assert "Incineroar" in rendered
    assert "SafetyGoggles" in rendered
    assert "Intimidate" in rendered
    assert "fakeout" in rendered
    assert "stat alignment Careful" in rendered
    assert "stat alignment Adamant" in rendered


def test_own_request_renders_known_set_information():
    import json

    request = json.loads((ROOT / "tests" / "data" / "showdown_requests" / "turn.json").read_text())
    state = BattleState("p1", "gen9championsvgc2026regmb")
    rendered = state.render(request)
    first = request["side"]["pokemon"][0]
    assert f"item {first['item']}" in rendered
    assert f"ability {first['ability']}" in rendered
    assert first["moves"][0] in rendered
    assert f"stats atk {first['stats']['atk']}" in rendered


def test_showteam_data_follows_an_active_nickname():
    state = BattleState("p1", "gen9championsvgc2026regmb")
    state.feed(
        [
            "|showteam|p2|Ground God|ArceusGround|EarthPlate|Multitype|Earthquake,Recover|||||||50|,,,,,Ground",
            "|switch|p2a: Ground God|Arceus-Ground, L50|100/100",
        ]
    )
    rendered = state.render({})
    assert "item EarthPlate" in rendered
    assert "ability Multitype" in rendered
    assert "Earthquake" in rendered
    assert "Tera Ground" not in rendered


def test_mega_event_preserves_the_forme_from_detailschange():
    state = BattleState("p1", "gen9championsvgc2026regmb")
    state.feed(
        [
            "|showteam|p1|Gengar||Gengarite|CursedBody|shadowball,protect|Timid|||||50",
            "|switch|p1a: Gengar|Gengar, L50|135/135",
            "|detailschange|p1a: Gengar|Gengar-Mega, L50",
            "|-mega|p1a: Gengar|Gengar|Gengarite",
        ]
    )

    rendered = state.render({})
    assert "Gengar-Mega" in rendered
    assert "base Spe 130; forme Mega" in rendered
    assert "Mega Evolved" in rendered


def test_structured_state_does_not_repeat_raw_protocol_lines():
    state = BattleState("p1", "gen9championsvgc2026regmb")
    state.feed(["|message|RAW_SENTINEL", "|turn|3"])

    rendered = state.render({})

    assert "Turn: 3" in rendered
    assert "RAW_SENTINEL" not in rendered
