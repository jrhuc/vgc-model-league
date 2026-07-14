import json
from pathlib import Path

import pytest

from vgcbench.engines import LLMEngine, RandomEngine
from vgcbench.sim import SimBattle
from vgcbench.teams import load_pool


ROOT = Path(__file__).parents[1]
PS = ROOT / "pokemon-showdown"
NODE = Path.home() / ".local/bin/node"


def request(active_count=1):
    active = []
    pokemon = []
    for slot in range(active_count):
        active.append(
            {
                "moves": [
                    {"move": "First", "id": "first", "pp": 10, "maxpp": 10, "target": "self", "disabled": False},
                    {"move": "Second", "id": "second", "pp": 10, "maxpp": 10, "target": "self", "disabled": False},
                ]
            }
        )
        pokemon.append(
            {
                "ident": f"p1: Mon{slot + 1}",
                "details": f"Pikachu, L50",
                "condition": "100/100",
                "active": True,
                "stats": {"atk": 1, "def": 1, "spa": 1, "spd": 1, "spe": 1},
                "moves": ["first", "second"],
                "ability": "static",
                "item": "",
            }
        )
    return {"active": active, "side": {"name": "P1", "id": "p1", "pokemon": pokemon}}


class ScriptedProvider:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    def complete(self, system, user, *, max_tokens, temperature, timeout=None):
        self.calls.append((system, user, max_tokens, temperature, timeout))
        return next(self.responses), {"input_tokens": 10, "output_tokens": 2}


class FailingProvider:
    def complete(self, system, user, *, max_tokens, temperature, timeout=None):
        raise RuntimeError("bad credentials")


class MenuAwareProvider:
    def complete(self, system, user, *, max_tokens, temperature, timeout=None):
        slots = user.count("\nSlot ")
        if not slots and "Choose for " in user:
            slots = 1
        return json.dumps({"choices": [0] * slots, "notes": ""}), {}


@pytest.mark.parametrize(
    "responses,expected,fallback,calls",
    [
        ([r'{"choices":[1],"notes":"remember speed"}'], "move 2", False, 1),
        ([r'I choose this: {"choices":[1],"notes":"x"}.'], "move 2", False, 1),
        ([r'{"choices":[0]} then {"choices":[1]}'], "move 2", False, 1),
        (["invalid", r'{"choices":[1]}'], "move 2", False, 2),
        (["invalid", r'{"choices":[9]}'], "move 1", True, 2),
    ],
)
def test_llm_joint_choices(responses, expected, fallback, calls):
    provider = ScriptedProvider(responses)
    decisions = []
    engine = LLMEngine("p1", "scripted", provider=provider, decision_log=decisions)
    choice = engine.act(request(), {"pov_lines": ["|turn|1"], "error": None})
    assert choice == expected
    assert decisions[0]["fallback"] is fallback
    assert engine.decision_stats() == {"decisions": 1, "fallbacks": int(fallback)}
    assert len(provider.calls) == calls
    if calls == 2:
        assert responses[0] in provider.calls[1][1]


def test_showdown_timer_is_in_prompt_and_bounds_provider_call():
    provider = ScriptedProvider(['{"choices":[0]}'])
    engine = LLMEngine("p1", "scripted", provider=provider, decision_log=[])
    timed_request = request()
    timed_request["timer"] = {"turnSeconds": 55, "seconds": 420}

    assert engine.act(timed_request, {"pov_lines": [], "error": None}) == "move 1"

    assert "Showdown timer: 55 seconds for this decision" in provider.calls[0][1]
    assert 55 < provider.calls[0][4] <= 56


def test_doubles_turn_is_one_call_and_previous_context_is_retained():
    provider = ScriptedProvider(
        [
            r'{"choices":[0,1],"notes":"Garchomp was faster"}',
            r'{"choices":[1,0],"notes":"keep the speed read"}',
        ]
    )
    engine = LLMEngine("p1", "scripted", provider=provider, decision_log=[])
    assert engine.act(request(2), {"pov_lines": ["|turn|1"], "error": None}) == "move 1, move 2"
    assert engine.act(request(2), {"pov_lines": ["|move|p2a: Garchomp|Rock Slide"], "error": None}) == "move 2, move 1"
    assert len(provider.calls) == 2
    second_prompt = provider.calls[1][1]
    assert "Garchomp was faster" in second_prompt
    assert "Chosen joint action: move 1, move 2" in second_prompt
    assert second_prompt.count("|move|p2a: Garchomp|Rock Slide") == 1
    assert second_prompt.count("Private notebook: Garchomp was faster") == 1
    assert "Private notebook after decision" not in second_prompt


def test_new_game_resets_state_but_keeps_match_memory_and_reference():
    engine = LLMEngine("p2", "scripted", provider=ScriptedProvider([]), decision_log=[])
    reference = engine.reference
    previous_state = engine.state
    engine._remember("Game 1 observation")
    engine.notebook = "retain this read"

    engine.begin_game(
        game_id="series-game-2",
        game_number=2,
        series_id="series",
        series_score={"p1": 1, "p2": 0},
    )

    assert engine.state is not previous_state
    assert engine.state.reference is reference
    assert engine.notebook == "retain this read"
    assert engine._transcript_lines() == [
        "Game 1 observation",
        "[Game 2 begins; series score p1 1, p2 0]",
    ]


def test_previous_games_are_compacted_at_the_next_game_boundary():
    engine = LLMEngine("p1", "scripted", provider=ScriptedProvider([]), decision_log=[])
    engine._remember(
        "Events from your point of view:\n|turn|1\nChosen joint action: move 1",
        brief="Chosen joint action: move 1",
    )
    engine._remember("[Game 1 ended; winner x; series score p1 1, p2 0]")

    engine.begin_game(game_id="s-2", game_number=2, series_id="s", series_score={"p1": 1, "p2": 0})
    engine._remember(
        "Events from your point of view:\n|turn|1\nChosen joint action: move 2",
        brief="Chosen joint action: move 2",
    )

    assert engine._transcript_lines() == [
        "Chosen joint action: move 1",
        "[Game 1 ended; winner x; series score p1 1, p2 0]",
        "[Game 2 begins; series score p1 1, p2 0]",
        "Events from your point of view:\n|turn|1\nChosen joint action: move 2",
    ]


def test_provider_failures_abort_instead_of_playing_first_action():
    engine = LLMEngine("p1", "broken", provider=FailingProvider(), decision_log=[])
    with pytest.raises(RuntimeError, match="bad credentials"):
        engine.act(request(), {"pov_lines": [], "error": None})
    assert engine.decision_stats() == {"decisions": 0, "fallbacks": 0}


def test_empty_provider_response_falls_back_to_first_legal_action():
    decisions = []
    engine = LLMEngine("p1", "empty", provider=ScriptedProvider([""]), decision_log=decisions)
    assert engine.act(request(), {"pov_lines": [], "error": None}) == "move 1"
    assert decisions[0]["fallback"] is True
    assert decisions[0]["error"] == "empty response"
    assert engine.decision_stats() == {"decisions": 1, "fallbacks": 1}


def test_full_llm_game_writes_joint_decisions(tmp_path):
    path = tmp_path / "decisions" / "scripted.jsonl"
    pool = load_pool()
    teams = pool.teams
    engine = LLMEngine(
        "p1",
        "scripted",
        provider=MenuAwareProvider(),
        decision_log=path,
        format_id=pool.format,
        ps_dir=PS,
        node=NODE,
    )
    battle = SimBattle(
        pool.format,
        {"name": "LLM", "team": teams[0].packed},
        {"name": "Random", "team": teams[1].packed},
        [21, 22, 23, 24],
        PS,
        NODE,
    )
    outcome = battle.run({"p1": engine, "p2": RandomEngine("p2", 20)})
    assert outcome["turns"] > 0
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    assert rows
    required = {
        "game_id", "turn", "pid", "menus", "choices", "parts", "notes",
        "fallback", "raw_response", "usage", "latency_ms",
    }
    assert all(required <= row.keys() for row in rows)
