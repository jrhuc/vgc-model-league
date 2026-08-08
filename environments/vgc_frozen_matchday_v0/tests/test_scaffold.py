from __future__ import annotations

import json

import pytest

from vgc_frozen_matchday_v0.scaffold import (
    NOTEBOOK_EVIDENCE_DIAGNOSTIC,
    NOTEBOOK_REPLACEMENT_LIMIT,
    ScaffoldError,
    parse_between_games_reply,
    parse_playing_reply,
    render_between_games_prompt,
    render_playing_prompt,
    select_action,
)


def view() -> tuple[dict, dict, list[dict]]:
    request = {"active": [{"moves": [{"move": "Private Move"}]}]}
    observation = {
        "protocolVersion": 1,
        "battleProtocolVersion": 2,
        "pid": "p1",
        "phase": "playing",
        "gameNumber": 1,
        "score": {"p1": 0, "p2": 0, "ties": 0},
        "revision": 17,
        "stateHash": "outer-secret-controller-token",
        "povLines": ["duplicated-matchday-line"],
        "pendingSides": ["must-not-leak"],
        "battle": {
            "protocolVersion": 2,
            "pid": "p1",
            "revision": 9,
            "stateHash": "battle-secret-controller-token",
            "request": request,
            "povLines": ["duplicated-battle-line"],
            "terminal": False,
        },
        "terminal": False,
    }
    actions = [
        {
            "number": 4,
            "label": "Use the authoritative label",
            "command": "move 1 +2, move 2 +1",
            "choices": [0, 1],
            "tokens": {"revision": 9},
            "construction": "must-not-leak",
        }
    ]
    return observation, request, actions


def test_playing_prompt_is_minimal_seat_view_and_exact_numbered_labels() -> None:
    observation, request, actions = view()
    prompt = render_playing_prompt(
        observation=observation,
        request=request,
        history=["|seat-pov|p1"],
        current_notebook="my private notes",
        actions=actions,
    )
    instruction, body_text = prompt.split("\n\n", 1)
    assert "evidence is ignored" in instruction
    body = json.loads(body_text)
    assert body == {
        "phase": "playing",
        "gameNumber": 1,
        "score": {"p1": 0, "p2": 0, "ties": 0},
        "povHistory": ["|seat-pov|p1"],
        "request": request,
        "currentNotebook": "my private notes",
        "menu": [{"number": 4, "label": "Use the authoritative label"}],
    }
    for forbidden in (
        "pendingSides",
        "outer-secret-controller-token",
        "battle-secret-controller-token",
        "duplicated-matchday-line",
        "duplicated-battle-line",
        "move 1 +2",
        "must-not-leak",
        '"choices"',
    ):
        assert forbidden not in prompt
    assert prompt.count("Private Move") == 1
    assert "tera" not in prompt.lower()


def test_between_prompt_labels_completed_outer_minus_one_and_native_limit() -> None:
    observation = {
        "protocolVersion": 1,
        "pid": "p2",
        "phase": "between-games",
        "gameNumber": 2,
        "score": {"p1": 1, "p2": 0, "ties": 0},
        "revision": 99,
        "stateHash": "not-public",
        "povLines": ["duplicated-final"],
        "battle": None,
    }
    prompt = render_between_games_prompt(
        observation=observation,
        history=["p2-final-authorized"],
        current_notebook="p2-notebook",
    )
    instruction, body_text = prompt.split("\n\n", 1)
    assert f"{NOTEBOOK_REPLACEMENT_LIMIT:,} characters" in instruction
    assert json.loads(body_text) == {
        "phase": "between-games",
        "completedGameNumber": 1,
        "score": {"p1": 1, "p2": 0, "ties": 0},
        "povHistory": ["p2-final-authorized"],
        "currentNotebook": "p2-notebook",
    }
    assert "not-public" not in prompt
    assert "duplicated-final" not in prompt


@pytest.mark.parametrize(
    "reply",
    [
        "```json\n{\"choice\":4}\n```",
        '{"choice":4} trailing',
        "[4]",
        '{"choice":true}',
        '{"choice":4,"choice":4}',
        '{"choice":NaN}',
        '{"choice":3}',
        '{}',
    ],
)
def test_playing_parser_fails_only_without_one_valid_authoritative_choice(
    reply: str,
) -> None:
    with pytest.raises(ScaffoldError):
        parse_playing_reply(reply, {4})


@pytest.mark.parametrize(
    ("reply", "rationale"),
    [
        ('{"choice":4,"unknown":{"malformed":"evidence"}}', None),
        ('{"choice":4,"rationale":7}', None),
        ('{"choice":4,"rationale":"kept","other":false}', "kept"),
        ('{"rationale":7,"choice":4,"rationale":"later string"}', "later string"),
    ],
)
def test_playing_parser_ignores_optional_or_unknown_evidence(
    reply: str, rationale: str | None
) -> None:
    parsed = parse_playing_reply(reply, {4})
    assert parsed.choice == 4
    assert parsed.rationale == rationale


def test_playing_selection_returns_exact_authoritative_entry() -> None:
    _observation, _request, actions = view()
    parsed = parse_playing_reply('{"choice":4,"rationale":"because"}', {4})
    assert select_action(actions, parsed.choice) is actions[0]


@pytest.mark.parametrize(
    "reply",
    [
        '{"notebook":null}',
        '{"notebook":false}',
        '{"notebook":"x","extra":1}',
        'wrapper {"notebook":"x"}',
        "[]",
        '{"notebook":"x","notebook":"y"}',
    ],
)
def test_invalid_notebook_evidence_becomes_diagnostic_omission(reply: str) -> None:
    parsed = parse_between_games_reply(reply)
    assert parsed.notebook_supplied is False
    assert parsed.notebook is None
    assert parsed.diagnostic == NOTEBOOK_EVIDENCE_DIAGNOSTIC


def test_notebook_omission_retain_empty_clear_and_no_truncation() -> None:
    omitted = parse_between_games_reply("{}")
    cleared = parse_between_games_reply('{"notebook":""}')
    notebook = "x" * (NOTEBOOK_REPLACEMENT_LIMIT + 1)
    oversized = parse_between_games_reply(json.dumps({"notebook": notebook}))
    assert omitted.notebook_supplied is False and omitted.diagnostic is None
    assert cleared.notebook_supplied is True and cleared.notebook == ""
    assert oversized.notebook == notebook


def test_json_structural_exhaustion_is_optional_only_for_notebook_evidence() -> None:
    nesting = 2_000
    notebook_reply = '{"notebook":' + "[" * nesting + "0" + "]" * nesting + "}"
    parsed = parse_between_games_reply(notebook_reply)
    assert parsed.notebook_supplied is False
    assert parsed.notebook is None
    assert parsed.diagnostic == NOTEBOOK_EVIDENCE_DIAGNOSTIC

    action_reply = '{"choice":' + "[" * nesting + "4" + "]" * nesting + "}"
    with pytest.raises(ScaffoldError):
        parse_playing_reply(action_reply, {4})
