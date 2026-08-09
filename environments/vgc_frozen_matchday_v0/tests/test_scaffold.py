from __future__ import annotations

import json

import pytest

from vgc_frozen_matchday_v0.scaffold import (
    FORMAT_AUTHORITY_NOTICE,
    NOTEBOOK_EVIDENCE_DIAGNOSTIC,
    NOTEBOOK_REPLACEMENT_LIMIT,
    ScaffoldError,
    parse_between_games_reply,
    parse_playing_reply,
    render_between_games_prompt,
    render_playing_prompt,
    select_action,
)


def test_seat_prompt_projections_and_remote_reply_parsers() -> None:
    playing = {
        "phase": "playing",
        "gameNumber": 2,
        "score": {"p1": 1, "p2": 0, "ties": 0},
        "pid": "p1",
        "stateHash": "controller-secret",
        "battle": {"private": "not projected"},
    }
    request = {"active": [{"moves": [{"move": "Protect"}]}], "rqid": 7}
    actions = [
        {"number": 3, "label": "Protect + Protect", "command": "move 1, move 1"},
        {"number": 8, "label": "Switch + Protect", "command": "switch 3, move 1"},
    ]
    prompt = render_playing_prompt(
        observation=playing,
        request=request,
        history=["|turn|1", "|private|p1"],
        current_notebook="role-private notebook",
        actions=actions,
    )
    notice, instruction, payload_text = prompt.split("\n\n", 2)
    payload = json.loads(payload_text)
    assert notice == FORMAT_AUTHORITY_NOTICE
    assert prompt.count(FORMAT_AUTHORITY_NOTICE) == 1
    assert "optional rationale" in instruction.lower()
    assert payload == {
        "phase": "playing",
        "gameNumber": 2,
        "score": {"p1": 1, "p2": 0, "ties": 0},
        "povHistory": ["|turn|1", "|private|p1"],
        "request": request,
        "currentNotebook": "role-private notebook",
        "menu": [
            {"number": 3, "label": "Protect + Protect"},
            {"number": 8, "label": "Switch + Protect"},
        ],
    }
    assert "controller-secret" not in prompt
    assert "move 1, move 1" not in prompt
    assert "not projected" not in prompt

    reply = parse_playing_reply(
        '{"rationale":"long untrusted prose","choice":8,"unknown":{"x":1}}',
        {3, 8},
    )
    assert reply.choice == 8
    assert not hasattr(reply, "rationale")
    assert select_action(actions, reply.choice) is actions[1]
    for invalid in (
        "3",
        "{}",
        '{"choice":true}',
        '{"choice":4}',
        '{"choice":3,"choice":8}',
        "not json",
    ):
        with pytest.raises(ScaffoldError):
            parse_playing_reply(invalid, {3, 8})

    between = render_between_games_prompt(
        observation={
            "phase": "between-games",
            "gameNumber": 3,
            "score": {"p1": 1, "p2": 1, "ties": 0},
            "privateControllerField": "hidden",
        },
        history=["|win|p2"],
        current_notebook="old notes",
    )
    notice, instruction, payload_text = between.split("\n\n", 2)
    assert notice == FORMAT_AUTHORITY_NOTICE
    assert f"{NOTEBOOK_REPLACEMENT_LIMIT:,}" in instruction
    assert json.loads(payload_text) == {
        "phase": "between-games",
        "completedGameNumber": 2,
        "score": {"p1": 1, "p2": 1, "ties": 0},
        "povHistory": ["|win|p2"],
        "currentNotebook": "old notes",
    }
    assert "hidden" not in between

    omitted = parse_between_games_reply("{}")
    cleared = parse_between_games_reply('{"notebook":""}')
    replaced = parse_between_games_reply(
        json.dumps({"notebook": "x" * NOTEBOOK_REPLACEMENT_LIMIT})
    )
    assert omitted.notebook_supplied is False and omitted.diagnostic is None
    assert cleared.notebook_supplied is True and cleared.notebook == ""
    assert replaced.notebook == "x" * NOTEBOOK_REPLACEMENT_LIMIT
    for invalid in (
        "not json",
        "[]",
        '{"notebook":1}',
        '{"notebook":"a","notebook":"b"}',
        '{"notebook":"a","extra":true}',
        json.dumps({"notebook": "x" * (NOTEBOOK_REPLACEMENT_LIMIT + 1)}),
        "[" * 2000,
    ):
        parsed = parse_between_games_reply(invalid)
        assert parsed.notebook_supplied is False
        assert parsed.notebook is None
        assert parsed.diagnostic == NOTEBOOK_EVIDENCE_DIAGNOSTIC
