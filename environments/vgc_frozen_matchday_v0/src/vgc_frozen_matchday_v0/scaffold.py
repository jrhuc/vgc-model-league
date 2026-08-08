from __future__ import annotations

import json
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from typing import Any


NOTEBOOK_REPLACEMENT_LIMIT = 20_000
NOTEBOOK_EVIDENCE_DIAGNOSTIC = "invalid_notebook_evidence_retained_v0"


class ScaffoldError(ValueError):
    """A prompt input or required model reply violates the authorized scaffold."""


@dataclass(frozen=True)
class PlayingReply:
    choice: int
    rationale: str | None = None


@dataclass(frozen=True)
class BetweenGamesReply:
    notebook_supplied: bool
    notebook: str | None = None
    diagnostic: str | None = None


class _ObjectPairs(list[tuple[str, Any]]):
    pass


def _reject_constant(value: str) -> None:
    raise ScaffoldError(f"invalid JSON constant {value}")


def _bare_pairs(text: str) -> _ObjectPairs:
    if not isinstance(text, str):
        raise ScaffoldError("model reply must be text")
    try:
        value = json.loads(
            text,
            object_pairs_hook=_ObjectPairs,
            parse_constant=_reject_constant,
        )
    except (json.JSONDecodeError, RecursionError, ValueError) as exc:
        if isinstance(exc, ScaffoldError):
            raise
        raise ScaffoldError(f"model reply must be one bare JSON object: {exc}") from exc
    if not isinstance(value, _ObjectPairs):
        raise ScaffoldError("model reply must be one bare JSON object")
    return value


def _menu(actions: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    menu: list[dict[str, Any]] = []
    seen: set[int] = set()
    for action in actions:
        number = action.get("number")
        label = action.get("label")
        if isinstance(number, bool) or not isinstance(number, int):
            raise ScaffoldError("referee action number must be an integer")
        if number in seen:
            raise ScaffoldError(f"duplicate referee action number {number}")
        if not isinstance(label, str):
            raise ScaffoldError("referee action label must be text")
        seen.add(number)
        menu.append({"number": number, "label": label})
    if not menu:
        raise ScaffoldError("a requested seat must have at least one referee action")
    return menu


def _public_header(
    observation: Mapping[str, Any], expected_phase: str
) -> dict[str, Any]:
    if not isinstance(observation, Mapping):
        raise ScaffoldError("observation must be a JSON object")
    phase = observation.get("phase")
    if phase != expected_phase:
        raise ScaffoldError(f"observation phase must be {expected_phase!r}")
    game_number = observation.get("gameNumber")
    if isinstance(game_number, bool) or not isinstance(game_number, int) or game_number < 1:
        raise ScaffoldError("observation gameNumber must be a positive integer")
    score = observation.get("score")
    if not isinstance(score, Mapping):
        raise ScaffoldError("observation score must be a JSON object")
    return {
        "phase": phase,
        "gameNumber": game_number,
        "score": dict(score),
    }


def _render(instruction: str, body: dict[str, Any]) -> str:
    try:
        encoded = json.dumps(
            body,
            ensure_ascii=False,
            allow_nan=False,
            indent=2,
        )
    except (TypeError, ValueError) as exc:
        raise ScaffoldError(f"referee view is not JSON data: {exc}") from exc
    return f"{instruction}\n\n{encoded}"


def render_playing_prompt(
    *,
    observation: Mapping[str, Any],
    request: Mapping[str, Any],
    history: Sequence[str],
    current_notebook: str,
    actions: Sequence[Mapping[str, Any]],
) -> str:
    """Render a seat-only decision prompt without the controller observation."""

    public = _public_header(observation, "playing")
    if not isinstance(request, Mapping):
        raise ScaffoldError("request must be a JSON object")
    if not all(isinstance(line, str) for line in history):
        raise ScaffoldError("history must contain only text lines")
    if not isinstance(current_notebook, str):
        raise ScaffoldError("current notebook must be text")
    return _render(
        'Return exactly one bare JSON object with an in-menu integer choice, for '
        'example {"choice": 3}. You may add a string "rationale"; all other '
        "evidence is ignored. Include no wrapper or prose.",
        {
            **public,
            "povHistory": list(history),
            "request": dict(request),
            "currentNotebook": current_notebook,
            "menu": _menu(actions),
        },
    )


def render_between_games_prompt(
    *,
    observation: Mapping[str, Any],
    history: Sequence[str],
    current_notebook: str,
) -> str:
    """Render the completed game's seat-only interval view."""

    public = _public_header(observation, "between-games")
    if public["gameNumber"] < 2:
        raise ScaffoldError("between-games gameNumber must identify an upcoming game")
    if not all(isinstance(line, str) for line in history):
        raise ScaffoldError("history must contain only text lines")
    if not isinstance(current_notebook, str):
        raise ScaffoldError("current notebook must be text")
    return _render(
        'Game play is paused. Return exactly one bare JSON object: {} retains the '
        'current notebook, or {"notebook": string} replaces it. An empty string '
        f"clears it. The native replacement limit is {NOTEBOOK_REPLACEMENT_LIMIT:,} "
        "characters; text is never truncated or repaired. Include no wrapper or prose.",
        {
            "phase": public["phase"],
            "completedGameNumber": public["gameNumber"] - 1,
            "score": public["score"],
            "povHistory": list(history),
            "currentNotebook": current_notebook,
        },
    )


def parse_playing_reply(text: str, action_numbers: Collection[int]) -> PlayingReply:
    pairs = _bare_pairs(text)
    choices = [item for key, item in pairs if key == "choice"]
    if len(choices) != 1:
        raise ScaffoldError("playing reply must contain exactly one choice")
    choice = choices[0]
    if isinstance(choice, bool) or not isinstance(choice, int):
        raise ScaffoldError("choice must be an integer, not a boolean")
    allowed = set(action_numbers)
    if choice not in allowed:
        raise ScaffoldError(f"choice {choice} is not in the referee action set")
    rationale = next(
        (item for key, item in pairs if key == "rationale" and isinstance(item, str)),
        None,
    )
    return PlayingReply(choice=choice, rationale=rationale)


def parse_between_games_reply(text: str) -> BetweenGamesReply:
    """Parse optional evidence; malformed evidence is an omitted replacement."""

    try:
        pairs = _bare_pairs(text)
        if any(key != "notebook" for key, _item in pairs):
            raise ScaffoldError("between-games reply may contain only notebook")
        notebooks = [item for key, item in pairs if key == "notebook"]
        if not notebooks:
            return BetweenGamesReply(notebook_supplied=False)
        if len(notebooks) != 1 or not isinstance(notebooks[0], str):
            raise ScaffoldError("notebook must occur once and be a string")
        return BetweenGamesReply(notebook_supplied=True, notebook=notebooks[0])
    except ScaffoldError:
        return BetweenGamesReply(
            notebook_supplied=False,
            diagnostic=NOTEBOOK_EVIDENCE_DIAGNOSTIC,
        )


def select_action(
    actions: Sequence[Mapping[str, Any]], choice: int
) -> Mapping[str, Any]:
    """Return the exact authoritative entry object; never rebuild an action."""

    if isinstance(choice, bool) or not isinstance(choice, int):
        raise ScaffoldError("choice must be an integer")
    selected = [action for action in actions if action.get("number") == choice]
    if len(selected) != 1:
        raise ScaffoldError(f"choice {choice} does not select exactly one referee action")
    return selected[0]
