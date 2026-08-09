from __future__ import annotations

import json
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

FORMAT_AUTHORITY_NOTICE = (
    "Pokémon Champions and this regulation may postdate your training data. "
    "Treat the rules in this prompt and the pinned Pokémon Showdown simulator as "
    "authoritative. Do not import mechanics from other Pokémon games or formats. "
    "If a mechanic is absent from the rules and legal actions, treat it as unavailable "
    "rather than trying to correct the format."
)
NOTEBOOK_REPLACEMENT_LIMIT = 20_000
NOTEBOOK_EVIDENCE_DIAGNOSTIC = "invalid_notebook_evidence_retained_v0"


class ScaffoldError(ValueError):
    """A remote reply or referee projection violates the prompt boundary."""


@dataclass(frozen=True)
class PlayingReply:
    choice: int


@dataclass(frozen=True)
class BetweenGamesReply:
    notebook_supplied: bool
    notebook: str | None = None
    diagnostic: str | None = None


class _Pairs(list[tuple[str, Any]]):
    pass


def _pairs(text: str) -> _Pairs:
    if not isinstance(text, str):
        raise ScaffoldError("model reply must be text")
    try:
        value = json.loads(
            text,
            object_pairs_hook=_Pairs,
            parse_constant=lambda value: (_ for _ in ()).throw(
                ValueError(f"invalid JSON constant {value}")
            ),
        )
    except (json.JSONDecodeError, ValueError, RecursionError) as exc:
        raise ScaffoldError("model reply must be one bare JSON object") from exc
    if not isinstance(value, _Pairs):
        raise ScaffoldError("model reply must be one bare JSON object")
    return value


def _public(observation: Mapping[str, Any], phase: str) -> dict[str, Any]:
    if not isinstance(observation, Mapping) or observation.get("phase") != phase:
        raise ScaffoldError(f"observation must be a {phase} object")
    game = observation.get("gameNumber")
    score = observation.get("score")
    if isinstance(game, bool) or not isinstance(game, int) or game < 1:
        raise ScaffoldError("observation gameNumber must be positive")
    if not isinstance(score, Mapping):
        raise ScaffoldError("observation score must be an object")
    return {"phase": phase, "gameNumber": game, "score": dict(score)}


def _render(instruction: str, body: dict[str, Any]) -> str:
    try:
        payload = json.dumps(body, ensure_ascii=False, allow_nan=False, indent=2)
    except (TypeError, ValueError) as exc:
        raise ScaffoldError("referee projection is not JSON data") from exc
    return f"{FORMAT_AUTHORITY_NOTICE}\n\n{instruction}\n\n{payload}"


def _history(value: Sequence[str]) -> list[str]:
    if not all(isinstance(line, str) for line in value):
        raise ScaffoldError("POV history must contain text")
    return list(value)


def _menu(actions: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    menu: list[dict[str, Any]] = []
    for action in actions:
        number, label = action.get("number"), action.get("label")
        if isinstance(number, bool) or not isinstance(number, int):
            raise ScaffoldError("action number must be an integer")
        if not isinstance(label, str):
            raise ScaffoldError("action label must be text")
        menu.append({"number": number, "label": label})
    if not menu or len({item["number"] for item in menu}) != len(menu):
        raise ScaffoldError("action menu must be nonempty with unique numbers")
    return menu


def render_playing_prompt(
    *,
    observation: Mapping[str, Any],
    request: Mapping[str, Any],
    history: Sequence[str],
    current_notebook: str,
    actions: Sequence[Mapping[str, Any]],
) -> str:
    if not isinstance(request, Mapping) or not isinstance(current_notebook, str):
        raise ScaffoldError("playing request and notebook have invalid types")
    return _render(
        'Return one bare JSON object with an in-menu integer choice, for example '
        '{"choice":3}. Optional rationale and other evidence are ignored. Include no prose.',
        {
            **_public(observation, "playing"),
            "povHistory": _history(history),
            "request": dict(request),
            "currentNotebook": current_notebook,
            "menu": _menu(actions),
        },
    )


def render_between_games_prompt(
    *, observation: Mapping[str, Any], history: Sequence[str], current_notebook: str
) -> str:
    public = _public(observation, "between-games")
    if public["gameNumber"] < 2 or not isinstance(current_notebook, str):
        raise ScaffoldError("between-games view is invalid")
    return _render(
        'Game play is paused. Return {} to retain the current notebook, or '
        '{"notebook":string} to replace it; an empty string clears it. The native '
        f"replacement limit is {NOTEBOOK_REPLACEMENT_LIMIT:,} characters. Include no prose.",
        {
            "phase": "between-games",
            "completedGameNumber": public["gameNumber"] - 1,
            "score": public["score"],
            "povHistory": _history(history),
            "currentNotebook": current_notebook,
        },
    )


def parse_playing_reply(text: str, action_numbers: Collection[int]) -> PlayingReply:
    choices = [value for key, value in _pairs(text) if key == "choice"]
    if len(choices) != 1 or isinstance(choices[0], bool) or not isinstance(choices[0], int):
        raise ScaffoldError("playing reply must contain one integer choice")
    if choices[0] not in set(action_numbers):
        raise ScaffoldError("choice is outside the referee menu")
    return PlayingReply(choices[0])


def parse_between_games_reply(text: str) -> BetweenGamesReply:
    try:
        pairs = _pairs(text)
        if any(key != "notebook" for key, _ in pairs):
            raise ScaffoldError("unexpected notebook evidence")
        values = [value for key, value in pairs if key == "notebook"]
        if not values:
            return BetweenGamesReply(False)
        if len(values) != 1 or not isinstance(values[0], str):
            raise ScaffoldError("notebook must be one string")
        if len(values[0]) > NOTEBOOK_REPLACEMENT_LIMIT:
            raise ScaffoldError("notebook replacement exceeds the native limit")
        return BetweenGamesReply(True, values[0])
    except ScaffoldError:
        return BetweenGamesReply(False, diagnostic=NOTEBOOK_EVIDENCE_DIAGNOSTIC)


def select_action(
    actions: Sequence[Mapping[str, Any]], choice: int
) -> Mapping[str, Any]:
    selected = [action for action in actions if action.get("number") == choice]
    if len(selected) != 1:
        raise ScaffoldError("choice does not select one authoritative action")
    return selected[0]
