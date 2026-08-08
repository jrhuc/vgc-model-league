from __future__ import annotations

import asyncio
import copy
import hashlib
import hmac
import json
import re
import secrets
import uuid
from collections import Counter
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import Field
from verifiers import v1 as vf

from .protocol import (
    DEFAULT_REFEREE_EXECUTABLE,
    DEFAULT_STDERR_TAIL_BYTES,
    BoundResponse,
    FrozenMatchdayProtocolClient,
    ProtocolBinding,
    ProtocolError,
)
from .scaffold import (
    NOTEBOOK_EVIDENCE_DIAGNOSTIC,
    BetweenGamesReply,
    PlayingReply,
    ScaffoldError,
    parse_between_games_reply,
    parse_playing_reply,
    render_between_games_prompt,
    render_playing_prompt,
    select_action,
)
from .taskset import (
    FrozenMatchdayData,
    FrozenMatchdayTask,
    FrozenMatchdayTaskConfig,
)


_NULL_HARNESS = vf.HarnessConfig(id="null")
_NULL_HARNESS_TYPE = type(vf.AgentConfig(harness=_NULL_HARNESS).harness)
_NO_RETRIES = vf.RetryConfig(max_retries=0)
_PID_ROLE = {"p1": "entrant", "p2": "opponent"}
_RUNTIME_ROLES = ("entrant", "opponent", "referee")
_RESERVED_METRICS = {"matchday_games_v0", "matchday_result_v0"}
_EPISODE_EVIDENCE_DOMAIN = b"vgc-frozen-matchday-v0/complete-episode-evidence"
_EPISODE_MANIFEST_VERSION = "vgc-frozen-matchday-complete-evidence-v0"
_SAFE_ENV_VAR = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class FrozenMatchdayEnvConfig(vf.EnvConfig):
    entrant: vf.AgentConfig = vf.AgentConfig(
        harness=_NULL_HARNESS, retries=_NO_RETRIES
    )
    opponent: vf.AgentConfig = vf.AgentConfig(
        harness=_NULL_HARNESS, retries=_NO_RETRIES
    )
    referee: vf.AgentConfig = vf.AgentConfig(
        harness=_NULL_HARNESS, retries=_NO_RETRIES
    )
    opponent_condition: Literal["self_play", "pinned_opponent"] = "self_play"
    referee_executable: str = DEFAULT_REFEREE_EXECUTABLE
    referee_stderr_tail_bytes: int = Field(DEFAULT_STDERR_TAIL_BYTES, ge=0)
    referee_shutdown_timeout: float = Field(5.0, gt=0)
    debug_allow_subprocess: bool = False


@dataclass
class _Seat:
    role: str
    pid: str
    agent: Any
    runtime: Any
    history: list[str] = field(default_factory=list)
    active_game_number: int | None = None
    current_notebook: str = ""
    traces: list[Any] = field(default_factory=list)
    carrier_declared: bool = False


@dataclass(frozen=True)
class _IdentityStamps:
    entrant: str
    opponent: str
    referee: str

    def as_dict(self) -> dict[str, str]:
        return {
            "entrant": self.entrant,
            "opponent": self.opponent,
            "referee": self.referee,
        }


@dataclass(frozen=True)
class _PendingAction:
    seat: _Seat
    observation: dict[str, Any]
    legal: dict[str, Any]
    legal_request_id: int
    prompt: str


@dataclass(frozen=True)
class _ChosenAction:
    pending: _PendingAction
    trace: Any
    reply: PlayingReply
    entry: dict[str, Any]


@dataclass(frozen=True)
class _NotebookDecision:
    seat: _Seat
    trace: Any
    reply: BetweenGamesReply
    expected_notebook: str


def _integer(value: Any, name: str, *, nonnegative: bool = True) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ProtocolError(f"{name} must be an integer")
    if nonnegative and value < 0:
        raise ProtocolError(f"{name} must be non-negative")
    return value


def _text(value: Any, name: str, *, nonempty: bool = False) -> str:
    if not isinstance(value, str) or (nonempty and not value):
        qualifier = "nonempty " if nonempty else ""
        raise ProtocolError(f"{name} must be {qualifier}text")
    return value


def _object(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ProtocolError(f"{name} must be a JSON object")
    return value


def _list(value: Any, name: str) -> list[Any]:
    if not isinstance(value, list):
        raise ProtocolError(f"{name} must be a JSON array")
    return value


def _exact_json_equal(left: Any, right: Any) -> bool:
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return set(left) == set(right) and all(
            _exact_json_equal(left[key], right[key]) for key in left
        )
    if isinstance(left, list):
        return len(left) == len(right) and all(
            _exact_json_equal(a, b) for a, b in zip(left, right)
        )
    return left == right


def _score(value: Any, name: str) -> dict[str, int]:
    score = _object(value, name)
    if set(score) != {"p1", "p2", "ties"}:
        raise ProtocolError(f"{name} must have exactly p1, p2, and ties")
    for key in ("p1", "p2", "ties"):
        _integer(score[key], f"{name} {key}")
    return score


def _advanced(value: Any, method: str) -> bool:
    result = _object(value, f"{method} result")
    advanced = result.get("advanced")
    if not isinstance(advanced, bool):
        raise ProtocolError(f"{method} result advanced must be boolean")
    for name in ("gameNumber", "revision"):
        _integer(result.get(name), f"{method} result {name}")
    _text(result.get("stateHash"), f"{method} result stateHash", nonempty=True)
    _score(result.get("score"), f"{method} result score")
    if result.get("phase") not in {"playing", "between-games", "terminal"}:
        raise ProtocolError(f"{method} result has an invalid phase")
    if not isinstance(result.get("terminal"), bool):
        raise ProtocolError(f"{method} result terminal must be boolean")
    return advanced


def _text_lines(value: Any, name: str) -> list[str]:
    lines = _list(value, name)
    if not all(isinstance(line, str) for line in lines):
        raise ProtocolError(f"{name} must contain only text")
    return lines


def _validate_observation(
    value: Any, pid: str, data: FrozenMatchdayData
) -> dict[str, Any]:
    observation = _object(value, f"{pid} observation")
    if (
        type(observation.get("protocolVersion")) is not int
        or observation.get("protocolVersion") != data.matchday_protocol_version
    ):
        raise ProtocolError(f"{pid} observation matchday protocol version mismatch")
    if (
        type(observation.get("battleProtocolVersion")) is not int
        or observation.get("battleProtocolVersion") != data.battle_protocol_version
    ):
        raise ProtocolError(f"{pid} observation battle protocol version mismatch")
    if observation.get("pid") != pid:
        raise ProtocolError(f"{pid} observation is bound to another seat")
    phase = observation.get("phase")
    if phase not in {"playing", "between-games", "terminal"}:
        raise ProtocolError(f"{pid} observation has invalid phase {phase!r}")
    game_number = _integer(observation.get("gameNumber"), f"{pid} gameNumber")
    if game_number < 1:
        raise ProtocolError(f"{pid} gameNumber must be positive")
    _integer(observation.get("revision"), f"{pid} revision")
    _text(observation.get("stateHash"), f"{pid} stateHash", nonempty=True)
    _score(observation.get("score"), f"{pid} score")
    _text_lines(observation.get("povLines"), f"{pid} matchday povLines")
    if not isinstance(observation.get("terminal"), bool):
        raise ProtocolError(f"{pid} terminal flag must be boolean")
    if observation["terminal"] != (phase == "terminal"):
        raise ProtocolError(f"{pid} terminal flag and phase disagree")
    battle = observation.get("battle")
    if phase == "playing":
        battle = _object(battle, f"{pid} battle observation")
        if (
            type(battle.get("protocolVersion")) is not int
            or battle.get("protocolVersion") != data.battle_protocol_version
        ):
            raise ProtocolError(f"{pid} battle protocol version mismatch")
        if battle.get("pid") != pid:
            raise ProtocolError(f"{pid} battle observation is bound to another seat")
        _integer(battle.get("revision"), f"{pid} battle revision")
        _text(battle.get("stateHash"), f"{pid} battle stateHash", nonempty=True)
        _text_lines(battle.get("povLines"), f"{pid} battle povLines")
        request = battle.get("request")
        if request is not None and not isinstance(request, dict):
            raise ProtocolError(f"{pid} request must be a JSON object or null")
        if not isinstance(battle.get("terminal"), bool):
            raise ProtocolError(f"{pid} battle terminal must be boolean")
    elif battle is not None:
        raise ProtocolError(f"{pid} non-playing observation must have battle:null")
    return observation


def _common_observations(
    p1: dict[str, Any], p2: dict[str, Any]
) -> tuple[str, int, int, str, dict[str, Any]]:
    keys = ("phase", "gameNumber", "revision", "stateHash", "score")
    for key in keys:
        if not _exact_json_equal(p1.get(key), p2.get(key)):
            raise ProtocolError(f"seat observations disagree on {key}")
    return (
        p1["phase"],
        p1["gameNumber"],
        p1["revision"],
        p1["stateHash"],
        p1["score"],
    )


def _update_history(seat: _Seat, observation: dict[str, Any]) -> None:
    if observation["phase"] == "playing":
        game_number = observation["gameNumber"]
        if seat.active_game_number is None or game_number > seat.active_game_number:
            seat.active_game_number = game_number
            seat.history.clear()
        elif game_number < seat.active_game_number:
            raise ProtocolError("active battle game number moved backwards")
    seat.history.extend(observation["povLines"])
    battle = observation.get("battle")
    if isinstance(battle, dict):
        seat.history.extend(battle["povLines"])


def _private_evidence(value: Any, pid: str) -> dict[str, Any]:
    evidence = _object(value, f"{pid} private evidence")
    if evidence.get("pid") != pid:
        raise ProtocolError(f"{pid} received another seat's private evidence")
    _text(evidence.get("currentNotebook"), f"{pid} currentNotebook")
    intervals = _list(evidence.get("intervals"), f"{pid} private intervals")
    if not all(isinstance(interval, dict) for interval in intervals):
        raise ProtocolError(f"{pid} private intervals must be JSON objects")
    return evidence


def _is_pending(observation: dict[str, Any]) -> bool:
    request = observation["battle"]["request"]
    if request is None:
        return False
    if "wait" in request and not isinstance(request["wait"], bool):
        raise ProtocolError("request wait must be boolean when supplied")
    return request.get("wait") is not True


def _legal_actions(
    value: Any,
    *,
    observation: dict[str, Any],
    data: FrozenMatchdayData,
) -> dict[str, Any]:
    legal = _object(value, "legal_actions result")
    battle = observation["battle"]
    if (
        type(legal.get("protocolVersion")) is not int
        or legal.get("protocolVersion") != data.matchday_protocol_version
    ):
        raise ProtocolError("legal_actions matchday protocol version mismatch")
    expected = {
        "gameNumber": observation["gameNumber"],
        "revision": observation["revision"],
        "stateHash": observation["stateHash"],
        "battleRevision": battle["revision"],
        "battleStateHash": battle["stateHash"],
    }
    for key, item in expected.items():
        if type(legal.get(key)) is not type(item) or legal.get(key) != item:
            raise ProtocolError(f"legal_actions {key} does not match observation")
    actions = _list(legal.get("actions"), "legal_actions actions")
    if not actions:
        raise ProtocolError("requested seat has no legal actions")
    seen: set[int] = set()
    for item in actions:
        action = _object(item, "legal action")
        number = _integer(action.get("number"), "legal action number")
        if number in seen:
            raise ProtocolError(f"duplicate legal action number {number}")
        seen.add(number)
        _text(action.get("label"), "legal action label")
        _text(action.get("command"), "legal action command", nonempty=True)
    return legal


def _exact_terminal_object(value: Any, name: str, fields: set[str]) -> dict[str, Any]:
    if type(value) is not dict or set(value) != fields:
        raise ProtocolError(f"{name} must have exactly {', '.join(sorted(fields))}")
    return value


def _exact_terminal_list(value: Any, name: str) -> list[Any]:
    if type(value) is not list:
        raise ProtocolError(f"{name} must be a JSON array")
    return value


def _exact_terminal_text(value: Any, name: str, *, nonempty: bool = False) -> str:
    if type(value) is not str or (nonempty and not value):
        qualifier = "nonempty " if nonempty else ""
        raise ProtocolError(f"{name} must be {qualifier}text")
    return value


def _exact_terminal_integer(value: Any, name: str) -> int:
    if type(value) is not int or value < 0:
        raise ProtocolError(f"{name} must be a non-negative integer")
    return value


def _terminal_seed_part(value: Any, name: str) -> int:
    part = _exact_terminal_integer(value, name)
    if part > 0xFFFF:
        raise ProtocolError(f"{name} must be an unsigned 16-bit integer")
    return part


def _terminal_score(value: Any, name: str) -> dict[str, int]:
    score = _exact_terminal_object(value, name, {"p1", "p2", "ties"})
    return {
        pid: _exact_terminal_integer(score[pid], f"{name} {pid}")
        for pid in ("p1", "p2", "ties")
    }


def _terminal_result(value: Any, name: str = "terminal result") -> dict[str, Any]:
    result = _exact_terminal_object(value, name, {"type", "winner"})
    if type(result["type"]) is not str:
        raise ProtocolError(f"{name} type must be text")
    if result["type"] == "tie":
        if result["winner"] is not None:
            raise ProtocolError(f"tie {name} must have winner:null")
        return {"type": "tie"}
    if result["type"] != "win":
        raise ProtocolError(f"{name} type must be win or tie")
    winner = _exact_terminal_object(
        result["winner"], f"{name} winner", {"pid", "name"}
    )
    if type(winner["pid"]) is not str or winner["pid"] not in {"p1", "p2"}:
        raise ProtocolError(f"{name} winner pid must be p1 or p2")
    _exact_terminal_text(winner["name"], f"{name} winner name", nonempty=True)
    return {"type": "win", "winner": {"pid": winner["pid"]}}


def _minimal_terminal_result(value: Any, name: str) -> dict[str, Any]:
    if type(value) is not dict or type(value.get("type")) is not str:
        raise ProtocolError(f"{name} is not a minimal result identity")
    if value["type"] == "tie":
        if set(value) != {"type"}:
            raise ProtocolError(f"tie {name} must contain only type")
        return {"type": "tie"}
    if value["type"] != "win" or set(value) != {"type", "winner"}:
        raise ProtocolError(f"{name} is not a minimal win result identity")
    winner = value["winner"]
    if (
        type(winner) is not dict
        or set(winner) != {"pid"}
        or type(winner["pid"]) is not str
        or winner["pid"] not in {"p1", "p2"}
    ):
        raise ProtocolError(f"{name} winner must contain only a fixed pid")
    return {"type": "win", "winner": {"pid": winner["pid"]}}


def _validate_outcome_redundancy(
    *,
    score: Any,
    result: Any,
    games_count: Any,
    game_results: Any,
) -> None:
    if type(score) is not dict or set(score) != {"p1", "p2", "ties"}:
        raise ProtocolError("terminal summary score is not the minimal exact score")
    clean_score = {
        pid: _exact_terminal_integer(score[pid], f"terminal summary score {pid}")
        for pid in ("p1", "p2", "ties")
    }
    clean_result = _minimal_terminal_result(result, "terminal summary result")
    if type(games_count) is not int or games_count not in {2, 3}:
        raise ProtocolError("terminal summary games_count must be two or three")
    if type(game_results) is not list or len(game_results) != games_count:
        raise ProtocolError("terminal per-game result count does not match games_count")

    folded = {"p1": 0, "p2": 0, "ties": 0}
    for expected_game, raw_game in enumerate(game_results, start=1):
        if type(raw_game) is not dict or set(raw_game) != {"game", "result"}:
            raise ProtocolError("terminal per-game result is not the minimal schema")
        if type(raw_game["game"]) is not int or raw_game["game"] != expected_game:
            raise ProtocolError("terminal per-game result numbers must be consecutive")
        if expected_game > 1 and (
            folded["p1"] >= 2 or folded["p2"] >= 2 or expected_game - 1 >= 3
        ):
            raise ProtocolError("terminal games continue after the match already ended")
        game_result = _minimal_terminal_result(
            raw_game["result"], f"terminal game {expected_game} result"
        )
        if game_result["type"] == "tie":
            folded["ties"] += 1
        else:
            folded[game_result["winner"]["pid"]] += 1

    if folded != clean_score:
        raise ProtocolError("terminal score does not equal the folded per-game results")
    if not (folded["p1"] >= 2 or folded["p2"] >= 2 or games_count >= 3):
        raise ProtocolError("terminal match is not first-to-two or complete at three games")
    expected_winner: str | None
    if folded["p1"] == folded["p2"]:
        expected_winner = None
    else:
        expected_winner = "p1" if folded["p1"] > folded["p2"] else "p2"
    actual_winner = (
        None if clean_result["type"] == "tie" else clean_result["winner"]["pid"]
    )
    if actual_winner != expected_winner:
        raise ProtocolError("terminal top result contradicts the folded score")


def _sanitize_terminal(value: Any, data: FrozenMatchdayData) -> dict[str, Any]:
    terminal_fields = {
        "protocolVersion",
        "battleProtocolVersion",
        "showdownRevision",
        "format",
        "configDigest",
        "registrations",
        "gameSeeds",
        "score",
        "result",
        "games",
        "notebookReceipts",
    }
    terminal = _exact_terminal_object(value, "terminal evidence", terminal_fields)
    expected = {
        "protocolVersion": data.matchday_protocol_version,
        "battleProtocolVersion": data.battle_protocol_version,
        "showdownRevision": data.showdown_revision,
        "format": data.format,
        "configDigest": data.expected_config_digest,
    }
    for key, item in expected.items():
        if type(terminal[key]) is not type(item) or terminal[key] != item:
            raise ProtocolError(f"terminal evidence {key} mismatch")

    registrations = _exact_terminal_list(
        terminal["registrations"], "terminal registrations"
    )
    if len(registrations) != 2:
        raise ProtocolError("terminal registrations must cover both fixed pids")
    registration_pids: list[str] = []
    for index, raw_registration in enumerate(registrations, start=1):
        registration = _exact_terminal_object(
            raw_registration,
            f"terminal registration {index}",
            {"pid", "name", "teamSha256", "constructionSha256"},
        )
        pid = registration["pid"]
        if type(pid) is not str or pid not in {"p1", "p2"}:
            raise ProtocolError("terminal registration pid must be p1 or p2")
        registration_pids.append(pid)
        for field in ("name", "teamSha256", "constructionSha256"):
            _exact_terminal_text(
                registration[field],
                f"terminal registration {pid} {field}",
                nonempty=True,
            )
    if registration_pids != ["p1", "p2"]:
        raise ProtocolError("terminal registrations must be ordered p1 then p2")

    game_seeds = _exact_terminal_list(terminal["gameSeeds"], "terminal gameSeeds")
    if len(game_seeds) != 3:
        raise ProtocolError("terminal gameSeeds must contain exactly three seeds")
    for number, raw_seed in enumerate(game_seeds, start=1):
        seed = _exact_terminal_list(raw_seed, f"terminal game seed {number}")
        if len(seed) != 4:
            raise ProtocolError("each terminal game seed must contain four integers")
        for index, part in enumerate(seed):
            _terminal_seed_part(part, f"terminal game seed {number} part {index}")

    score = _terminal_score(terminal["score"], "terminal score")
    result = _terminal_result(terminal["result"])
    games = _exact_terminal_list(terminal["games"], "terminal games")
    if len(games) not in {2, 3}:
        raise ProtocolError("terminal evidence must contain two or three games")
    accepted_actions: list[dict[str, Any]] = []
    game_results: list[dict[str, Any]] = []
    game_fields = {
        "protocolVersion",
        "format",
        "seed",
        "seats",
        "result",
        "turns",
        "authoritativeLog",
        "submittedActions",
    }
    for game_number, raw_game in enumerate(games, start=1):
        game = _exact_terminal_object(
            raw_game, f"terminal game {game_number}", game_fields
        )
        if (
            type(game["protocolVersion"]) is not int
            or game["protocolVersion"] != data.battle_protocol_version
        ):
            raise ProtocolError(f"terminal game {game_number} protocol version mismatch")
        if type(game["format"]) is not str or game["format"] != data.format:
            raise ProtocolError(f"terminal game {game_number} format mismatch")
        seed = _exact_terminal_list(game["seed"], f"terminal game {game_number} seed")
        if len(seed) != 4:
            raise ProtocolError(f"terminal game {game_number} seed must have four integers")
        for index, part in enumerate(seed):
            _terminal_seed_part(
                part, f"terminal game {game_number} seed part {index}"
            )
        raw_seats = _exact_terminal_list(
            game["seats"], f"terminal game {game_number} seats"
        )
        if len(raw_seats) != 2:
            raise ProtocolError(f"terminal game {game_number} must have two seats")
        game_pids: list[str] = []
        for raw_seat in raw_seats:
            game_seat = _exact_terminal_object(
                raw_seat, f"terminal game {game_number} seat", {"pid", "name"}
            )
            pid = game_seat["pid"]
            if type(pid) is not str or pid not in {"p1", "p2"}:
                raise ProtocolError(f"terminal game {game_number} seat pid is invalid")
            game_pids.append(pid)
            _exact_terminal_text(
                game_seat["name"],
                f"terminal game {game_number} {pid} name",
                nonempty=True,
            )
        if game_pids != ["p1", "p2"]:
            raise ProtocolError(
                f"terminal game {game_number} seats must be ordered p1 then p2"
            )
        game_result = _terminal_result(
            game["result"], f"terminal game {game_number} result"
        )
        game_results.append({"game": game_number, "result": game_result})
        _exact_terminal_integer(game["turns"], f"terminal game {game_number} turns")
        log = _exact_terminal_list(
            game["authoritativeLog"], f"terminal game {game_number} authoritativeLog"
        )
        if any(type(line) is not str for line in log):
            raise ProtocolError(
                f"terminal game {game_number} authoritativeLog must contain only text"
            )
        for raw_action in _exact_terminal_list(
            game["submittedActions"],
            f"terminal game {game_number} submittedActions",
        ):
            action = _exact_terminal_object(
                raw_action,
                "terminal submitted action",
                {"decisionRevision", "stateHash", "pid", "command"},
            )
            pid = action["pid"]
            if type(pid) is not str or pid not in {"p1", "p2"}:
                raise ProtocolError("terminal submitted action has invalid pid")
            accepted_actions.append(
                {
                    "game": game_number,
                    "pid": pid,
                    "battle_revision": _exact_terminal_integer(
                        action["decisionRevision"],
                        "terminal submitted action decisionRevision",
                    ),
                    "battle_state_hash": _exact_terminal_text(
                        action["stateHash"],
                        "terminal submitted action stateHash",
                        nonempty=True,
                    ),
                    "command": _exact_terminal_text(
                        action["command"],
                        "terminal submitted action command",
                        nonempty=True,
                    ),
                }
            )

    notebook_receipts: list[dict[str, Any]] = []
    receipt_seats = _exact_terminal_list(
        terminal["notebookReceipts"], "terminal notebookReceipts"
    )
    if len(receipt_seats) != 2:
        raise ProtocolError("terminal notebook receipts must cover both fixed pids")
    seen_receipt_pids: list[str] = []
    for raw_seat in receipt_seats:
        seat = _exact_terminal_object(
            raw_seat, "terminal notebook receipts seat", {"pid", "intervals"}
        )
        pid = seat["pid"]
        if type(pid) is not str or pid not in {"p1", "p2"}:
            raise ProtocolError("terminal notebook receipts have invalid fixed pids")
        seen_receipt_pids.append(pid)
        for raw_receipt in _exact_terminal_list(
            seat["intervals"], "terminal notebook receipt intervals"
        ):
            receipt = _exact_terminal_object(
                raw_receipt,
                "terminal notebook receipt",
                {"gameNumber", "supplied", "notebookSha256"},
            )
            supplied = receipt["supplied"]
            if type(supplied) is not bool:
                raise ProtocolError("terminal notebook receipt supplied must be boolean")
            notebook_receipts.append(
                {
                    "pid": pid,
                    "game": _exact_terminal_integer(
                        receipt["gameNumber"],
                        "terminal notebook receipt gameNumber",
                    ),
                    "supplied": supplied,
                    "notebook_sha256": _exact_terminal_text(
                        receipt["notebookSha256"],
                        "terminal notebook receipt hash",
                        nonempty=True,
                    ),
                }
            )
    if seen_receipt_pids != ["p1", "p2"]:
        raise ProtocolError("terminal notebook receipts must be ordered p1 then p2")
    expected_intervals = Counter(
        (pid, game)
        for pid in ("p1", "p2")
        for game in range(1, len(games))
    )
    actual_intervals = Counter(
        (receipt["pid"], receipt["game"]) for receipt in notebook_receipts
    )
    if actual_intervals != expected_intervals:
        raise ProtocolError("terminal notebook receipts do not cover every interval")

    summary = {
        "protocol_version": terminal["protocolVersion"],
        "battle_protocol_version": terminal["battleProtocolVersion"],
        "showdown_revision": terminal["showdownRevision"],
        "format": terminal["format"],
        "config_digest": terminal["configDigest"],
        "score": score,
        "result": result,
        "games_count": len(games),
        "game_results": game_results,
        "accepted_actions": accepted_actions,
        "notebook_receipts": notebook_receipts,
    }
    _validate_outcome_redundancy(
        score=summary["score"],
        result=summary["result"],
        games_count=summary["games_count"],
        game_results=summary["game_results"],
    )
    return summary


def _runtime_type(runtime: Any) -> str | None:
    config = getattr(runtime, "config", None)
    return getattr(config, "type", getattr(runtime, "type", None))


def _runtime_checks(
    runtimes: dict[str, Any], *, allow_subprocess: bool
) -> tuple[str, dict[str, str], dict[str, str]]:
    if type(runtimes) is not dict or set(runtimes) != set(_RUNTIME_ROLES):
        raise ProtocolError("runtime roles must be entrant, opponent, and referee")
    if len({id(runtime) for runtime in runtimes.values()}) != len(runtimes):
        raise ProtocolError("entrant, opponent, and referee runtimes must be distinct")
    runtime_ids: dict[str, str] = {}
    runtime_types: dict[str, str] = {}
    for role in _RUNTIME_ROLES:
        runtime_id = getattr(getattr(runtimes[role], "info", None), "id", None)
        if type(runtime_id) is not str or not runtime_id:
            raise ProtocolError(f"{role} runtime must have a nonempty runtime info id")
        runtime_type = _runtime_type(runtimes[role])
        if type(runtime_type) is not str or not runtime_type:
            raise ProtocolError(f"{role} runtime must have a nonempty concrete type")
        runtime_ids[role] = runtime_id
        runtime_types[role] = runtime_type
    if len(set(runtime_ids.values())) != len(runtime_ids):
        raise ProtocolError("role runtimes resolve to a shared runtime id")
    if len(set(runtime_types.values())) != 1:
        raise ProtocolError(
            "heterogeneous role runtime types are unsupported by the v0 transport policy"
        )
    unsupported = [
        role
        for role, runtime in runtimes.items()
        if not getattr(runtime, "supports_live_processes", False)
    ]
    if unsupported:
        raise ProtocolError(
            f"all role runtimes must support live processes; unsupported={unsupported}"
        )
    runtime_type = next(iter(runtime_types.values()))
    if runtime_type == "subprocess" and not allow_subprocess:
        raise ProtocolError(
            "subprocess runtimes are debug/test-only; set debug_allow_subprocess=true explicitly"
        )
    label = (
        "debug-subprocess"
        if runtime_type == "subprocess"
        else "distinct-non-subprocess-runtime"
    )
    return label, runtime_ids, runtime_types


def _require_exact_model_state(value: Any, expected_type: type, name: str) -> None:
    if type(value) is not expected_type:
        raise TypeError(f"{name} must have its exact supported v0.3 concrete type")
    if (
        type(value.__dict__) is not dict
        or set(value.__dict__) != set(expected_type.model_fields)
    ):
        raise ValueError(f"{name} contains unexpected copied state")
    if getattr(value, "__pydantic_extra__", None):
        raise ValueError(f"{name} contains unexpected extra state")
    if getattr(value, "__pydantic_private__", None):
        raise ValueError(f"{name} contains unexpected private state")


def _is_exact_null_harness(config: Any) -> bool:
    if type(config) is not _NULL_HARNESS_TYPE:
        return False
    try:
        _require_exact_model_state(config, _NULL_HARNESS_TYPE, "null harness")
    except (TypeError, ValueError):
        return False
    return config.model_dump(mode="python") == _NULL_HARNESS.model_dump(mode="python")


def _validate_eval_client(client: Any, name: str) -> dict[str, Any]:
    _require_exact_model_state(client, vf.EvalClientConfig, name)
    base_url = client.base_url
    api_key_var = client.api_key_var
    headers = client.headers
    if type(base_url) is not str or not base_url:
        raise ValueError(f"{name} base_url must be exact nonempty text")
    split = urlsplit(base_url)
    if (
        split.scheme not in {"http", "https"}
        or not split.netloc
        or split.username is not None
        or split.password is not None
        or split.query
        or split.fragment
    ):
        raise ValueError(
            f"{name} base_url must be a credential-free http(s) endpoint without query or fragment"
        )
    if type(api_key_var) is not str or not _SAFE_ENV_VAR.fullmatch(api_key_var):
        raise ValueError(
            f"{name} api_key_var must name a provider credential environment variable"
        )
    if type(headers) is not dict or headers:
        raise ValueError(
            f"{name} headers must be the exact empty built-in dict; serialized custom authentication is unsupported"
        )
    dumped = client.model_dump(mode="json")
    expected = {
        "base_url": base_url,
        "api_key_var": api_key_var,
        "headers": {},
        "type": "eval",
    }
    if type(dumped) is not dict or not _exact_json_equal(dumped, expected):
        raise ValueError(f"{name} does not have the exact safe v0.3 serialization")
    return dumped


def _validate_agent_config(
    config: Any, name: str, *, require_resolved: bool
) -> None:
    _require_exact_model_state(config, vf.AgentConfig, name)
    _require_exact_model_state(config.retries, vf.RetryConfig, f"{name} retries")
    if config.harness is not None and type(config.harness) is not _NULL_HARNESS_TYPE:
        raise TypeError(f"{name} harness must have its exact supported null concrete type")
    model = config.model
    client = config.client
    if require_resolved:
        if type(model) is not str or not model:
            raise ValueError(f"{name} model must be resolved to exact nonempty text")
        if client is None:
            raise ValueError(f"{name} client must be resolved")
    elif model is not None and (type(model) is not str or not model):
        raise ValueError(f"{name} model must be exact nonempty text when configured")
    if client is not None:
        _validate_eval_client(client, f"{name} client")


def _model_json_value(value: Any, name: str) -> Any:
    if value is None or not hasattr(value, "model_dump"):
        raise ValueError(f"{name} must be a resolved v0.3 configuration")
    try:
        dumped = value.model_dump(mode="json")
    except Exception as exc:
        raise ValueError(f"{name} cannot be stably dumped") from exc
    if type(dumped) is not dict:
        raise ValueError(f"{name} must dump to an exact JSON object")
    return dumped


def _canonical_json(value: Any, name: str) -> bytes:
    try:
        encoded = json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} cannot be canonicalized as JSON") from exc
    return encoded.encode("utf-8")


def _hmac_stamp(key: bytes, domain: bytes, value: Any, name: str) -> str:
    payload = domain + b"\x00" + _canonical_json(value, name)
    digest = hmac.new(key, payload, hashlib.sha256).hexdigest()
    return f"hmac-sha256-v0:{digest}"


def _identity_value(config: Any, name: str) -> dict[str, Any]:
    if type(config) is vf.AgentConfig:
        _validate_agent_config(config, name, require_resolved=True)
    elif type(config) is vf.ModelContext:
        if set(config.__dict__) != {"model", "client", "sampling"}:
            raise ValueError(f"{name} model context contains unexpected state")
    else:
        raise TypeError(
            f"{name} must be the exact v0.3 AgentConfig or ModelContext concrete type"
        )
    model = config.model
    if type(model) is not str or not model:
        raise ValueError(f"{name} model must be resolved to exact nonempty text")
    client = _validate_eval_client(config.client, f"{name} client")
    return {"model": model, "client": client}


def _config_identity_stamp(config: Any, key: bytes, name: str) -> str:
    return _hmac_stamp(
        key,
        b"vgc-frozen-matchday-v0/model-client-identity",
        _identity_value(config, name),
        f"{name} identity",
    )


def _agent_identity_stamp(agent: Any, role: str, key: bytes) -> str:
    config_stamp = _config_identity_stamp(agent.config, key, f"{role} agent")
    context = getattr(agent, "ctx", None)
    if type(context) is not vf.ModelContext:
        raise TypeError(
            f"{role} agent must expose the exact v0.3 ModelContext concrete type"
        )
    context_stamp = _config_identity_stamp(context, key, f"{role} model context")
    if not hmac.compare_digest(config_stamp, context_stamp):
        raise ValueError(f"{role} agent config and live model context identity disagree")
    return config_stamp


def _validate_condition_stamps(
    stamps: _IdentityStamps,
    *,
    opponent_condition: str,
    pinned_opponent_stamp: str | None,
) -> None:
    if opponent_condition == "self_play":
        if not hmac.compare_digest(stamps.entrant, stamps.opponent):
            raise ValueError(
                "self_play requires actual resolved entrant and opponent model/client identities to match"
            )
        return
    if pinned_opponent_stamp is None or not hmac.compare_digest(
        stamps.opponent, pinned_opponent_stamp
    ):
        raise ValueError(
            "pinned_opponent actual resolved opponent identity differs from its constructor pin"
        )


def _identity_stamps_from_dict(value: Any) -> _IdentityStamps:
    if type(value) is not dict or set(value) != set(_RUNTIME_ROLES):
        raise ValueError("trace identity stamps must cover exactly all runtime roles")
    for role, stamp in value.items():
        if (
            type(stamp) is not str
            or not stamp.startswith("hmac-sha256-v0:")
            or len(stamp) != len("hmac-sha256-v0:") + 64
        ):
            raise ValueError(f"trace {role} identity stamp is malformed")
        try:
            int(stamp.removeprefix("hmac-sha256-v0:"), 16)
        except ValueError as exc:
            raise ValueError(f"trace {role} identity stamp is malformed") from exc
    return _IdentityStamps(**value)


def _identity_evidence_seal(
    key: bytes, opponent_condition: str, stamps: _IdentityStamps
) -> str:
    return _hmac_stamp(
        key,
        b"vgc-frozen-matchday-v0/controller-identity-evidence",
        {"opponent_condition": opponent_condition, "stamps": stamps.as_dict()},
        "controller identity evidence",
    )


def _validate_control_config_types(config: Any) -> None:
    _require_exact_model_state(
        config, FrozenMatchdayEnvConfig, "frozen matchday environment configuration"
    )
    _require_exact_model_state(config.retries, vf.RetryConfig, "episode retries")
    for role in _RUNTIME_ROLES:
        agent_config = getattr(config, role)
        _require_exact_model_state(
            agent_config, vf.AgentConfig, f"configured {role} agent"
        )
        _require_exact_model_state(
            agent_config.retries, vf.RetryConfig, f"configured {role} agent retries"
        )
        if agent_config.client is not None and type(agent_config.client) is not vf.EvalClientConfig:
            raise TypeError(
                f"configured {role} agent client must have its exact supported v0.3 concrete type"
            )


def _validate_control_config(config: FrozenMatchdayEnvConfig) -> None:
    _validate_control_config_types(config)
    for role in _RUNTIME_ROLES:
        _validate_agent_config(
            getattr(config, role), f"configured {role} agent", require_resolved=False
        )
    retry_counts = {
        "episode": config.retries.max_retries,
        "entrant": config.entrant.retries.max_retries,
        "opponent": config.opponent.retries.max_retries,
        "referee": config.referee.retries.max_retries,
    }
    nonzero = {name: count for name, count in retry_counts.items() if count != 0}
    if nonzero:
        raise ValueError(f"frozen matchday retry counts must all be zero: {nonzero}")
    for role in _RUNTIME_ROLES:
        if not _is_exact_null_harness(getattr(config, role).harness):
            raise ValueError(
                f"{role} must use the exact built-in tool-less null harness configuration"
            )
    inherited = config.opponent.model is None and config.opponent.client is None
    pinned = config.opponent.model is not None and config.opponent.client is not None
    if config.opponent_condition == "self_play" and not inherited:
        raise ValueError("self_play requires the opponent model and client to inherit")
    if config.opponent_condition == "pinned_opponent" and not pinned:
        raise ValueError(
            "pinned_opponent requires an explicitly pinned opponent model and client"
        )


def _control_policy_stamp(config: FrozenMatchdayEnvConfig, key: bytes) -> str:
    dumped = _model_json_value(config, "frozen matchday environment configuration")
    if type(dumped) is not dict:
        raise ValueError("frozen matchday environment configuration must dump to an object")
    return _hmac_stamp(
        key,
        b"vgc-frozen-matchday-v0/constructor-policy",
        dumped,
        "frozen matchday environment configuration",
    )


def _agent_role(agent: Any) -> Any:
    return getattr(agent, "_name", getattr(agent, "role", None))


def _validate_run_agents(
    agents: vf.Agents,
    *,
    key: bytes,
    opponent_condition: str,
    pinned_opponent_stamp: str | None,
    expected: _IdentityStamps | None = None,
) -> _IdentityStamps:
    captured: dict[str, str] = {}
    for role in _RUNTIME_ROLES:
        agent = getattr(agents, role)
        if _agent_role(agent) != role:
            raise ValueError(f"{role} agent has the wrong resolved role")
        resolved = getattr(agent, "config", None)
        _validate_agent_config(
            resolved, f"resolved {role} agent", require_resolved=True
        )
        if resolved.retries.max_retries != 0:
            raise ValueError(f"{role} agent retries must remain zero")
        if not _is_exact_null_harness(resolved.harness):
            raise ValueError(f"{role} agent must use the exact null harness")
        if agent.trainable:
            raise ValueError(f"{role} agent must be nontrainable before matchday run")
        captured[role] = _agent_identity_stamp(agent, role, key)
    stamps = _IdentityStamps(**captured)
    _validate_condition_stamps(
        stamps,
        opponent_condition=opponent_condition,
        pinned_opponent_stamp=pinned_opponent_stamp,
    )
    if expected is not None:
        for role in _RUNTIME_ROLES:
            if not hmac.compare_digest(
                getattr(stamps, role), getattr(expected, role)
            ):
                raise ValueError(
                    f"{role} resolved model/client identity changed during matchday run"
                )
    return stamps


def _validate_runtime_placements(
    agents: vf.Agents, runtimes: dict[str, Any]
) -> None:
    for role in _RUNTIME_ROLES:
        configured_type = getattr(
            getattr(getattr(agents, role).config, "runtime", None), "type", None
        )
        live_type = _runtime_type(runtimes[role])
        if type(configured_type) is not str or configured_type != live_type:
            raise ProtocolError(
                f"{role} resolved runtime policy type contradicts its live runtime"
            )


def _trace_info(
    trace: Any,
    *,
    seat: _Seat,
    kind: Literal["action", "notebook"],
    binding: ProtocolBinding,
    transport: str,
    runtime_ids: dict[str, str],
    runtime_types: dict[str, str],
    opponent_condition: str,
    identity_stamps: _IdentityStamps,
    identity_evidence_seal: str,
    controller_policy_seal: str,
) -> None:
    if type(trace) is not vf.Trace:
        raise TypeError("matchday interactions must emit the exact v0.3 Trace type")
    if type(trace.info) is not dict:
        raise TypeError("matchday Trace info must be the exact built-in dict")
    carrier = kind == "action" and not seat.carrier_declared
    if carrier:
        seat.carrier_declared = True
    trace.info.update(
        {
            "referee_pid": seat.pid,
            "referee_kind": kind,
            "referee_transport": transport,
            "referee_runtime_ids": copy.deepcopy(runtime_ids),
            "referee_runtime_types": copy.deepcopy(runtime_types),
            "opponent_condition": opponent_condition,
            "agent_identity_stamps": identity_stamps.as_dict(),
            "agent_identity_evidence_seal": identity_evidence_seal,
            "controller_policy_seal": controller_policy_seal,
            "referee_binding": copy.deepcopy(binding.to_wire()),
            "referee_join": None,
            "matchday_reward_carrier": carrier,
        }
    )
    seat.traces.append(trace)


def _public_terminal_summary(summary: dict[str, Any]) -> dict[str, Any]:
    fields = (
        "protocol_version",
        "battle_protocol_version",
        "showdown_revision",
        "format",
        "config_digest",
        "score",
        "result",
        "games_count",
        "game_results",
    )
    if type(summary) is not dict or set(summary) != {
        *fields,
        "accepted_actions",
        "notebook_receipts",
    }:
        raise ValueError("sanitized terminal summary has an unexpected schema")
    return {field: copy.deepcopy(summary[field]) for field in fields}


def _role_partition(summary: dict[str, Any], pid: str) -> dict[str, Any]:
    if pid not in {"p1", "p2"}:
        raise ValueError("episode evidence partition has an invalid fixed pid")
    return {
        "pid": pid,
        "expected_actions": [
            copy.deepcopy(action)
            for action in summary["accepted_actions"]
            if action.get("pid") == pid
        ],
        "expected_notebook_receipts": [
            copy.deepcopy(receipt)
            for receipt in summary["notebook_receipts"]
            if receipt.get("pid") == pid
        ],
    }


def _task_manifest(task: FrozenMatchdayTask) -> dict[str, Any]:
    data = task.data
    return {
        "idx": data.idx,
        "case_id": data.case_id,
        "condition_digest": data.condition_digest,
        "expected_config_digest": data.expected_config_digest,
        "showdown_revision": data.showdown_revision,
        "format": data.format,
        "jsonl_protocol_version": data.jsonl_protocol_version,
        "matchday_protocol_version": data.matchday_protocol_version,
        "battle_protocol_version": data.battle_protocol_version,
    }


def _agent_config_evidence_stamp(key: bytes, config: Any, name: str) -> str:
    _validate_agent_config(config, name, require_resolved=True)
    return _hmac_stamp(
        key,
        b"vgc-frozen-matchday-v0/trace-agent-configuration",
        _model_json_value(config, name),
        name,
    )


def _trace_manifest_record(trace: vf.Trace, key: bytes) -> dict[str, Any]:
    if type(trace) is not vf.Trace:
        raise TypeError("episode evidence requires exact v0.3 Trace artifacts")
    if type(trace.id) is not str or not trace.id:
        raise ValueError("episode evidence Trace id must be exact nonempty text")
    info = trace.info
    if type(info) is not dict:
        raise TypeError("episode evidence Trace info must be the exact built-in dict")
    runtime = trace.agent.runtime
    if runtime is None:
        raise ValueError("episode evidence Trace lacks a framework runtime stamp")
    return {
        "trace_id": trace.id,
        "role": trace.agent.name,
        "agent_config_stamp": _agent_config_evidence_stamp(
            key, trace.agent.config, f"Trace {trace.id} agent configuration"
        ),
        "pid": info.get("referee_pid"),
        "kind": info.get("referee_kind"),
        "join": copy.deepcopy(info.get("referee_join")),
        "runtime": {
            "id": runtime.id,
            "type": runtime.type,
            "borrowed": runtime.borrowed,
        },
        "reward_carrier": info.get("matchday_reward_carrier"),
        "notebook_diagnostic": info.get("notebook_evidence_diagnostic"),
    }


def _episode_evidence_manifest(
    *,
    key: bytes,
    task: FrozenMatchdayTask,
    binding: dict[str, Any],
    public_summary: dict[str, Any],
    partitions: dict[str, dict[str, Any]],
    runtime_ids: dict[str, str],
    runtime_types: dict[str, str],
    transport: str,
    opponent_condition: str,
    identity_stamps: dict[str, str],
    identity_evidence_seal: str,
    controller_policy_seal: str,
    traces: list[vf.Trace],
) -> dict[str, Any]:
    records = [_trace_manifest_record(trace, key) for trace in traces]
    trace_ids = [record["trace_id"] for record in records]
    if len(set(trace_ids)) != len(trace_ids):
        raise ValueError("episode evidence Trace ids must be unique")
    records.sort(key=lambda record: record["trace_id"])
    return {
        "version": _EPISODE_MANIFEST_VERSION,
        "referee_episode_id": binding.get("episodeId"),
        "task": _task_manifest(task),
        "protocol_binding": copy.deepcopy(binding),
        "opponent": {
            "condition": opponent_condition,
            "role_identity_stamps": copy.deepcopy(identity_stamps),
            "identity_evidence_seal": identity_evidence_seal,
            "controller_policy_seal": controller_policy_seal,
        },
        "runtime": {
            "ids": copy.deepcopy(runtime_ids),
            "types": copy.deepcopy(runtime_types),
            "transport": transport,
        },
        "outcome": copy.deepcopy(public_summary),
        "authoritative_partitions": {
            pid: copy.deepcopy(partitions[pid]) for pid in ("p1", "p2")
        },
        "traces": records,
        "designated_carriers": {
            pid: sorted(
                record["trace_id"]
                for record in records
                if record["pid"] == pid and record["reward_carrier"] is True
            )
            for pid in ("p1", "p2")
        },
    }


def _episode_evidence_seal(key: bytes, manifest: dict[str, Any]) -> str:
    return _hmac_stamp(
        key,
        _EPISODE_EVIDENCE_DOMAIN,
        manifest,
        "complete matchday episode evidence",
    )


def _trusted_task_options(task: Any) -> dict[str, Any]:
    if type(task) is not FrozenMatchdayTask:
        raise TypeError("FrozenMatchdayEnv requires exact FrozenMatchdayTask")
    if type(task.__dict__) is not dict or set(task.__dict__) != {"data", "config"}:
        raise ValueError("frozen matchday task contains unexpected instance state")
    data = task.__dict__["data"]
    config = task.__dict__["config"]
    if type(data) is not FrozenMatchdayData:
        raise TypeError("FrozenMatchdayEnv requires exact FrozenMatchdayData")
    if type(config) is not FrozenMatchdayTaskConfig:
        raise TypeError("FrozenMatchdayEnv requires exact FrozenMatchdayTaskConfig")
    return FrozenMatchdayTaskConfig.options_for(config, data)


class FrozenMatchdayEnv(vf.Env[FrozenMatchdayEnvConfig]):
    def __init__(self, config: FrozenMatchdayEnvConfig) -> None:
        _validate_control_config(config)
        super().__init__(config)
        self._capture_constructor_seals()

    def _capture_constructor_seals(self) -> None:
        self._identity_hmac_key = secrets.token_bytes(32)
        self._consumed_referee_episode_ids: set[str] = set()
        self._constructor_policy_seal = _control_policy_stamp(
            self.config, self._identity_hmac_key
        )
        self._constructor_opponent_condition = self.config.opponent_condition
        self._constructor_pinned_opponent_stamp = (
            _config_identity_stamp(
                self.config.opponent,
                self._identity_hmac_key,
                "constructor-pinned opponent",
            )
            if self.config.opponent_condition == "pinned_opponent"
            else None
        )

    def _validate_constructor_seal(self) -> None:
        _validate_control_config_types(self.config)
        current = _control_policy_stamp(self.config, self._identity_hmac_key)
        if not hmac.compare_digest(current, self._constructor_policy_seal):
            raise ValueError(
                "frozen matchday environment policy changed after construction"
            )

    def _validate_agents(
        self,
        agents: vf.Agents,
        *,
        expected: _IdentityStamps | None = None,
    ) -> _IdentityStamps:
        return _validate_run_agents(
            agents,
            key=self._identity_hmac_key,
            opponent_condition=self._constructor_opponent_condition,
            pinned_opponent_stamp=self._constructor_pinned_opponent_stamp,
            expected=expected,
        )

    def _seal_episode_traces(
        self,
        *,
        task: FrozenMatchdayTask,
        binding: ProtocolBinding,
        terminal_summary: dict[str, Any],
        seats: dict[str, _Seat],
        transport: str,
        runtime_ids: dict[str, str],
        runtime_types: dict[str, str],
        identity_stamps: _IdentityStamps,
        identity_evidence_seal: str,
    ) -> None:
        public_summary = _public_terminal_summary(terminal_summary)
        partitions = {
            pid: _role_partition(terminal_summary, pid) for pid in ("p1", "p2")
        }
        traces = [
            trace
            for pid in ("p1", "p2")
            for trace in seats[pid].traces
        ]
        binding_wire = binding.to_wire()
        for pid in ("p1", "p2"):
            for trace in seats[pid].traces:
                trace.info["referee_terminal_summary"] = copy.deepcopy(public_summary)
                trace.info["referee_role_partition"] = copy.deepcopy(partitions[pid])
        manifest = _episode_evidence_manifest(
            key=self._identity_hmac_key,
            task=task,
            binding=binding_wire,
            public_summary=public_summary,
            partitions=partitions,
            runtime_ids=runtime_ids,
            runtime_types=runtime_types,
            transport=transport,
            opponent_condition=self._constructor_opponent_condition,
            identity_stamps=identity_stamps.as_dict(),
            identity_evidence_seal=identity_evidence_seal,
            controller_policy_seal=self._constructor_policy_seal,
            traces=traces,
        )
        seal = _episode_evidence_seal(self._identity_hmac_key, manifest)
        for trace in traces:
            trace.info["episode_evidence_seal"] = seal

    async def setup(self, agents: vf.Agents) -> None:
        agents.entrant.trainable = False
        agents.opponent.trainable = False
        agents.referee.trainable = False

    async def run(self, task: vf.Task, agents: vf.Agents) -> None:
        options = _trusted_task_options(task)
        self._validate_constructor_seal()
        _validate_control_config(self.config)
        identity_stamps = self._validate_agents(agents)
        identity_evidence_seal = _identity_evidence_seal(
            self._identity_hmac_key,
            self._constructor_opponent_condition,
            identity_stamps,
        )
        episode_id = uuid.uuid4().hex
        runtimes: dict[str, Any] | None = None
        transport: str | None = None
        runtime_ids: dict[str, str] | None = None
        runtime_types: dict[str, str] | None = None
        try:
            async with AsyncExitStack() as stack:
                runtimes = {
                    "entrant": await stack.enter_async_context(
                        agents.entrant.provision(task)
                    ),
                    "opponent": await stack.enter_async_context(
                        agents.opponent.provision(task)
                    ),
                    "referee": await stack.enter_async_context(
                        agents.referee.provision(task)
                    ),
                }
                self._validate_constructor_seal()
                _validate_control_config(self.config)
                self._validate_agents(agents, expected=identity_stamps)
                _validate_runtime_placements(agents, runtimes)
                transport, runtime_ids, runtime_types = _runtime_checks(
                    runtimes, allow_subprocess=self.config.debug_allow_subprocess
                )
                client = await FrozenMatchdayProtocolClient.launch(
                    runtimes["referee"],
                    executable=self.config.referee_executable,
                    showdown_revision=task.data.showdown_revision,
                    jsonl_protocol_version=task.data.jsonl_protocol_version,
                    matchday_protocol_version=task.data.matchday_protocol_version,
                    battle_protocol_version=task.data.battle_protocol_version,
                    stderr_tail_bytes=self.config.referee_stderr_tail_bytes,
                    shutdown_timeout=self.config.referee_shutdown_timeout,
                )
                await stack.enter_async_context(client)
                started = await client.start(
                    episode_id=episode_id,
                    condition_digest=task.data.condition_digest,
                    expected_config_digest=task.data.expected_config_digest,
                    showdown_revision=task.data.showdown_revision,
                    options=options,
                    matchday_protocol_version=task.data.matchday_protocol_version,
                    battle_protocol_version=task.data.battle_protocol_version,
                )
                start_value = _object(started.value, "start result")
                if start_value.get("started") is not True:
                    raise ProtocolError("referee did not confirm a fresh start")
                _integer(start_value.get("revision"), "start revision")
                _text(start_value.get("stateHash"), "start stateHash", nonempty=True)
                binding = client.binding
                if binding is None:
                    raise ProtocolError("start returned without a binding")
                seats = {
                    "p1": _Seat(
                        "entrant", "p1", agents.entrant, runtimes["entrant"]
                    ),
                    "p2": _Seat(
                        "opponent", "p2", agents.opponent, runtimes["opponent"]
                    ),
                }
                terminal_summary = await self._play(
                    task,
                    client,
                    seats,
                    transport=transport,
                    runtime_ids=runtime_ids,
                    runtime_types=runtime_types,
                    identity_stamps=identity_stamps,
                    identity_evidence_seal=identity_evidence_seal,
                )
                self._validate_constructor_seal()
                _validate_control_config(self.config)
                self._validate_agents(agents, expected=identity_stamps)
                self._seal_episode_traces(
                    task=task,
                    binding=binding,
                    terminal_summary=terminal_summary,
                    seats=seats,
                    transport=transport,
                    runtime_ids=runtime_ids,
                    runtime_types=runtime_types,
                    identity_stamps=identity_stamps,
                    identity_evidence_seal=identity_evidence_seal,
                )
        finally:
            self._validate_constructor_seal()
            _validate_control_config(self.config)
            self._validate_agents(agents, expected=identity_stamps)
            if (
                runtimes is not None
                and transport is not None
                and runtime_ids is not None
                and runtime_types is not None
            ):
                _validate_runtime_placements(agents, runtimes)
                final_transport, final_runtime_ids, final_runtime_types = _runtime_checks(
                    runtimes, allow_subprocess=self.config.debug_allow_subprocess
                )
                if final_transport != transport or not _exact_json_equal(
                    final_runtime_ids, runtime_ids
                ) or not _exact_json_equal(final_runtime_types, runtime_types):
                    raise ProtocolError(
                        "live role runtime identity changed during matchday run"
                    )

    async def _play(
        self,
        task: FrozenMatchdayTask,
        client: FrozenMatchdayProtocolClient,
        seats: dict[str, _Seat],
        *,
        transport: str,
        runtime_ids: dict[str, str],
        runtime_types: dict[str, str],
        identity_stamps: _IdentityStamps,
        identity_evidence_seal: str,
    ) -> dict[str, Any]:
        data = task.data
        binding = client.binding
        if binding is None:
            raise ProtocolError("referee binding disappeared")
        while True:
            observed: dict[str, dict[str, Any]] = {}
            for pid in ("p1", "p2"):
                response = await client.call("observe", {"pid": pid})
                observed[pid] = _validate_observation(response.value, pid, data)
            phase, game_number, revision, state_hash, _current_score = (
                _common_observations(observed["p1"], observed["p2"])
            )
            for pid, seat in seats.items():
                _update_history(seat, observed[pid])
            if phase == "terminal":
                terminal_response = await client.call("terminal")
                if terminal_response.value is None:
                    raise ProtocolError("terminal phase lacks terminal evidence")
                return _sanitize_terminal(terminal_response.value, data)
            if phase == "playing":
                await self._playing_turn(
                    task,
                    client,
                    binding,
                    seats,
                    observed,
                    game_number,
                    revision,
                    state_hash,
                    transport,
                    runtime_ids,
                    runtime_types,
                    identity_stamps,
                    identity_evidence_seal,
                )
                continue
            if phase == "between-games":
                await self._between_games_turn(
                    task,
                    client,
                    binding,
                    seats,
                    observed,
                    game_number,
                    revision,
                    state_hash,
                    transport,
                    runtime_ids,
                    runtime_types,
                    identity_stamps,
                    identity_evidence_seal,
                )
                continue
            raise ProtocolError(f"unsupported phase {phase!r}")

    async def _playing_turn(
        self,
        task: FrozenMatchdayTask,
        client: FrozenMatchdayProtocolClient,
        binding: ProtocolBinding,
        seats: dict[str, _Seat],
        observed: dict[str, dict[str, Any]],
        game_number: int,
        revision: int,
        state_hash: str,
        transport: str,
        runtime_ids: dict[str, str],
        runtime_types: dict[str, str],
        identity_stamps: _IdentityStamps,
        identity_evidence_seal: str,
    ) -> None:
        pending: list[_PendingAction] = []
        for pid in ("p1", "p2"):
            observation = observed[pid]
            if not _is_pending(observation):
                continue
            seat = seats[pid]
            private = _private_evidence(
                (await client.call("private_evidence", {"pid": pid})).value, pid
            )
            seat.current_notebook = private["currentNotebook"]
            legal_response = await client.call("legal_actions", {"pid": pid})
            legal = _legal_actions(
                legal_response.value, observation=observation, data=task.data
            )
            prompt = render_playing_prompt(
                observation=observation,
                request=observation["battle"]["request"],
                history=seat.history,
                current_notebook=seat.current_notebook,
                actions=legal["actions"],
            )
            pending.append(
                _PendingAction(
                    seat=seat,
                    observation=observation,
                    legal=legal,
                    legal_request_id=legal_response.request_id,
                    prompt=prompt,
                )
            )
        if not pending:
            raise ProtocolError("playing phase has no requested non-wait seat")

        chosen: list[_ChosenAction] = []
        async with AsyncExitStack() as interactions:
            active: list[tuple[_PendingAction, Any, Any]] = []
            for item in pending:
                interaction = await interactions.enter_async_context(
                    item.seat.agent.interaction(task, runtime=item.seat.runtime)
                )
                trace = interaction.trace
                _trace_info(
                    trace,
                    seat=item.seat,
                    kind="action",
                    binding=binding,
                    transport=transport,
                    runtime_ids=runtime_ids,
                    runtime_types=runtime_types,
                    opponent_condition=self._constructor_opponent_condition,
                    identity_stamps=identity_stamps,
                    identity_evidence_seal=identity_evidence_seal,
                    controller_policy_seal=self._constructor_policy_seal,
                )
                active.append((item, interaction, trace))
            segments = await asyncio.gather(
                *(interaction.turn(item.prompt) for item, interaction, _trace in active)
            )
            for (item, _interaction, trace), segment in zip(active, segments):
                if segment.terminated:
                    raise ScaffoldError(
                        f"{item.seat.role} interaction terminated before replying"
                    )
                if trace.num_turns != 1:
                    raise ScaffoldError("each playing interaction must have one model turn")
                actions = item.legal["actions"]
                reply = parse_playing_reply(
                    segment.last_reply, [action["number"] for action in actions]
                )
                entry = select_action(actions, reply.choice)
                if not isinstance(entry, dict):
                    raise ProtocolError(
                        "selected referee action entry is not a JSON object"
                    )
                chosen.append(_ChosenAction(item, trace, reply, entry))

        ordered = sorted(chosen, key=lambda item: item.pending.seat.pid)
        for index, item in enumerate(ordered):
            seat = item.pending.seat
            response = await client.call(
                "submit",
                {
                    "pid": seat.pid,
                    "command": item.entry["command"],
                    "expectedRevision": revision,
                    "expectedStateHash": state_hash,
                },
            )
            advanced = _advanced(response.value, "submit")
            should_advance = index == len(ordered) - 1
            if advanced != should_advance:
                if advanced:
                    raise ProtocolError(
                        "referee advanced before every collected action was submitted"
                    )
                raise ProtocolError(
                    "referee did not advance after every pending action was submitted"
                )
            item.trace.info["referee_join"] = {
                "kind": "action",
                "episode_id": binding.episode_id,
                "config_digest": binding.config_digest,
                "game": game_number,
                "pid": seat.pid,
                "battle_revision": item.pending.legal["battleRevision"],
                "battle_state_hash": item.pending.legal["battleStateHash"],
                "command": item.entry["command"],
            }

    async def _between_games_turn(
        self,
        task: FrozenMatchdayTask,
        client: FrozenMatchdayProtocolClient,
        binding: ProtocolBinding,
        seats: dict[str, _Seat],
        observed: dict[str, dict[str, Any]],
        game_number: int,
        revision: int,
        state_hash: str,
        transport: str,
        runtime_ids: dict[str, str],
        runtime_types: dict[str, str],
        identity_stamps: _IdentityStamps,
        identity_evidence_seal: str,
    ) -> None:
        completed_game_number = game_number - 1
        if completed_game_number < 1:
            raise ProtocolError("between-games observation does not identify a completed game")
        prompts: list[tuple[_Seat, str, str]] = []
        for pid in ("p1", "p2"):
            seat = seats[pid]
            private = _private_evidence(
                (await client.call("private_evidence", {"pid": pid})).value, pid
            )
            seat.current_notebook = private["currentNotebook"]
            prompts.append(
                (
                    seat,
                    render_between_games_prompt(
                        observation=observed[pid],
                        history=seat.history,
                        current_notebook=seat.current_notebook,
                    ),
                    seat.current_notebook,
                )
            )

        decisions: dict[str, _NotebookDecision] = {}
        async with AsyncExitStack() as interactions:
            active: list[tuple[_Seat, str, str, Any, Any]] = []
            for seat, prompt, old_notebook in prompts:
                interaction = await interactions.enter_async_context(
                    seat.agent.interaction(task, runtime=seat.runtime)
                )
                trace = interaction.trace
                _trace_info(
                    trace,
                    seat=seat,
                    kind="notebook",
                    binding=binding,
                    transport=transport,
                    runtime_ids=runtime_ids,
                    runtime_types=runtime_types,
                    opponent_condition=self._constructor_opponent_condition,
                    identity_stamps=identity_stamps,
                    identity_evidence_seal=identity_evidence_seal,
                    controller_policy_seal=self._constructor_policy_seal,
                )
                active.append((seat, prompt, old_notebook, interaction, trace))
            segments = await asyncio.gather(
                *(
                    interaction.turn(prompt)
                    for _seat, prompt, _old, interaction, _trace in active
                ),
                return_exceptions=True,
            )

        interaction_failures: list[BaseException] = []
        for (seat, _prompt, old_notebook, _interaction, trace), segment in zip(
            active, segments
        ):
            if isinstance(segment, BaseException):
                interaction_failures.append(segment)
                continue
            if segment.terminated:
                interaction_failures.append(
                    ScaffoldError(
                        f"{seat.role} optional notebook interaction terminated; "
                        "verifiers v0.3 retains failed interaction traces in the "
                        "Episode, so the whole episode must fail rather than claim "
                        "a clean notebook omission"
                    )
                )
                continue
            if trace.num_turns != 1:
                interaction_failures.append(
                    ScaffoldError("each notebook interaction must have one model turn")
                )
                continue
            reply = parse_between_games_reply(segment.last_reply)
            if reply.diagnostic is not None:
                trace.info["notebook_evidence_diagnostic"] = reply.diagnostic
            expected_notebook = (
                reply.notebook if reply.notebook_supplied else old_notebook
            )
            if not isinstance(expected_notebook, str):
                interaction_failures.append(
                    ScaffoldError("supplied notebook evidence must be text")
                )
                continue
            decisions[seat.pid] = _NotebookDecision(
                seat, trace, reply, expected_notebook
            )
        if interaction_failures:
            raise interaction_failures[0]

        ready_responses: dict[str, BoundResponse] = {}
        for index, pid in enumerate(("p1", "p2")):
            decision = decisions[pid]
            params: dict[str, Any] = {
                "pid": pid,
                "expectedRevision": revision,
                "expectedStateHash": state_hash,
            }
            if decision.reply.notebook_supplied:
                params["notebookReplacement"] = decision.reply.notebook
            response = await client.call("ready_next_game", params)
            advanced = _advanced(response.value, "ready_next_game")
            should_advance = index == 1
            if advanced != should_advance:
                if advanced:
                    raise ProtocolError(
                        "referee advanced before both between-games replies were submitted"
                    )
                raise ProtocolError(
                    "referee did not advance after both between-games replies"
                )
            ready_responses[pid] = response

        for pid in ("p1", "p2"):
            decision = decisions[pid]
            evidence = _private_evidence(
                (await client.call("private_evidence", {"pid": pid})).value, pid
            )
            if not _exact_json_equal(
                evidence["currentNotebook"], decision.expected_notebook
            ):
                raise ProtocolError(f"{pid} current notebook differs from the submitted evidence")
            receipts = [
                interval
                for interval in evidence["intervals"]
                if interval.get("gameNumber") == completed_game_number
            ]
            if len(receipts) != 1:
                raise ProtocolError(
                    f"{pid} private evidence lacks one receipt for completed game "
                    f"{completed_game_number}"
                )
            receipt = receipts[0]
            if type(receipt.get("gameNumber")) is not int:
                raise ProtocolError(f"{pid} notebook receipt gameNumber is invalid")
            supplied = receipt.get("supplied")
            if (
                not isinstance(supplied, bool)
                or supplied != decision.reply.notebook_supplied
            ):
                raise ProtocolError(f"{pid} notebook receipt supplied flag mismatch")
            if not _exact_json_equal(
                receipt.get("notebook"), decision.expected_notebook
            ):
                raise ProtocolError(f"{pid} notebook receipt raw value mismatch")
            notebook_hash = _text(
                receipt.get("notebookSha256"),
                f"{pid} notebook receipt hash",
                nonempty=True,
            )
            decision.seat.current_notebook = evidence["currentNotebook"]
            decision.trace.info["referee_join"] = {
                "kind": "notebook",
                "episode_id": binding.episode_id,
                "config_digest": binding.config_digest,
                "pid": pid,
                "game": completed_game_number,
                "notebook_sha256": notebook_hash,
                "supplied": supplied,
            }

    def _validate_trace_identity_stamp(
        self, trace: Any, role: str
    ) -> _IdentityStamps:
        if type(trace) is not vf.Trace:
            raise TypeError("identity evidence requires the exact v0.3 Trace type")
        stamps = _identity_stamps_from_dict(trace.info.get("agent_identity_stamps"))
        condition = trace.info.get("opponent_condition")
        if condition != self._constructor_opponent_condition:
            raise ValueError("trace opponent condition does not match constructor seal")
        evidence_seal = trace.info.get("agent_identity_evidence_seal")
        expected_seal = _identity_evidence_seal(
            self._identity_hmac_key, condition, stamps
        )
        if type(evidence_seal) is not str or not hmac.compare_digest(
            evidence_seal, expected_seal
        ):
            raise ValueError("trace controller identity evidence seal is invalid")
        actual = _config_identity_stamp(
            trace.agent.config, self._identity_hmac_key, f"{role} trace"
        )
        if not hmac.compare_digest(actual, getattr(stamps, role)):
            raise ValueError(
                f"{role} framework-stamped Trace identity differs from its pre-rollout stamp"
            )
        return stamps

    async def finalize(self, task: vf.Task, episode: vf.Episode) -> None:
        _trusted_task_options(task)
        _validate_control_config_types(self.config)
        if type(episode) is not vf.Episode:
            raise TypeError("FrozenMatchdayEnv requires the exact v0.3 Episode type")
        episode_traces = episode.traces
        if type(episode_traces) is not list or not episode_traces:
            raise ValueError("matchday episode must contain an exact decision Trace list")
        if any(type(trace) is not vf.Trace for trace in episode_traces):
            raise TypeError("matchday Episode requires exact v0.3 Trace artifacts")
        FrozenMatchdayEnv._validate_trace_destinations(episode_traces)
        by_role: dict[str, list[vf.Trace]] = {}
        for trace in episode_traces:
            by_role.setdefault(trace.agent.name, []).append(trace)
        if set(by_role) != {"entrant", "opponent"}:
            raise ValueError(
                "matchday episode must contain entrant/opponent and no referee trace"
            )

        traces_by_pid = {"p1": by_role["entrant"], "p2": by_role["opponent"]}
        common_binding: dict[str, Any] | None = None
        common_summary: dict[str, Any] | None = None
        common_runtime_ids: dict[str, str] | None = None
        common_runtime_types: dict[str, str] | None = None
        common_transport: str | None = None
        common_identity_stamps: dict[str, str] | None = None
        common_identity_evidence_seal: str | None = None
        common_controller_policy_seal: str | None = None
        common_episode_evidence_seal: str | None = None
        partitions: dict[str, dict[str, Any]] = {}
        actual_actions: list[tuple[Any, ...]] = []
        actual_notebooks: list[tuple[Any, ...]] = []
        carriers: dict[str, list[vf.Trace]] = {"p1": [], "p2": []}
        action_counts = Counter()
        role_identity_stamps: dict[str, str] = {}

        for pid, traces in traces_by_pid.items():
            if type(traces) is not list or not traces:
                raise ValueError(f"{pid} has no exact Trace list")
            for trace in traces:
                self._validate_trace_base(trace, task, pid)
                role = _PID_ROLE[pid]
                stamped = self._validate_trace_identity_stamp(trace, role)
                role_stamp = getattr(stamped, role)
                if role not in role_identity_stamps:
                    role_identity_stamps[role] = role_stamp
                elif not hmac.compare_digest(role_identity_stamps[role], role_stamp):
                    raise ValueError(
                        f"all {role} traces must carry the original pre-rollout identity stamp"
                    )
                info = trace.info
                binding = info["referee_binding"]
                summary = info["referee_terminal_summary"]
                runtime_ids = info["referee_runtime_ids"]
                runtime_types = info["referee_runtime_types"]
                transport = info["referee_transport"]
                identity_stamp_dict = info["agent_identity_stamps"]
                identity_evidence_seal = info["agent_identity_evidence_seal"]
                controller_policy_seal = info["controller_policy_seal"]
                episode_evidence_seal = info["episode_evidence_seal"]
                partition = info["referee_role_partition"]
                if (
                    type(partition) is not dict
                    or set(partition)
                    != {"pid", "expected_actions", "expected_notebook_receipts"}
                    or partition["pid"] != pid
                    or type(partition["expected_actions"]) is not list
                    or type(partition["expected_notebook_receipts"]) is not list
                ):
                    raise ValueError(f"{pid} Trace carries an invalid private role partition")
                if pid not in partitions:
                    partitions[pid] = partition
                elif not _exact_json_equal(partitions[pid], partition):
                    raise ValueError(f"all {pid} traces must carry one authorized role partition")
                if common_binding is None:
                    common_binding = binding
                    common_summary = summary
                    common_runtime_ids = runtime_ids
                    common_runtime_types = runtime_types
                    common_transport = transport
                    common_identity_stamps = identity_stamp_dict
                    common_identity_evidence_seal = identity_evidence_seal
                    common_controller_policy_seal = controller_policy_seal
                    common_episode_evidence_seal = episode_evidence_seal
                elif (
                    not _exact_json_equal(common_binding, binding)
                    or not _exact_json_equal(common_summary, summary)
                    or not _exact_json_equal(common_runtime_ids, runtime_ids)
                    or not _exact_json_equal(common_runtime_types, runtime_types)
                    or common_transport != transport
                    or not _exact_json_equal(
                        common_identity_stamps, identity_stamp_dict
                    )
                    or common_identity_evidence_seal != identity_evidence_seal
                    or common_controller_policy_seal != controller_policy_seal
                    or common_episode_evidence_seal != episode_evidence_seal
                ):
                    raise ValueError(
                        "all decision traces must carry one common public matchday evidence bundle"
                    )
                join = info["referee_join"]
                kind = info["referee_kind"]
                if kind == "action":
                    actual_actions.append(self._action_join_key(join, pid, binding))
                    action_counts[pid] += 1
                else:
                    actual_notebooks.append(
                        self._notebook_join_key(join, pid, binding)
                    )
                    diagnostic = info.get("notebook_evidence_diagnostic")
                    if diagnostic is not None and join["supplied"]:
                        raise ValueError(
                            "invalid notebook evidence must be retained as omitted"
                        )
                if info["matchday_reward_carrier"]:
                    if kind != "action":
                        raise ValueError("a notebook trace cannot be a reward carrier")
                    carriers[pid].append(trace)

        if (
            common_binding is None
            or common_summary is None
            or common_runtime_ids is None
            or common_runtime_types is None
            or common_transport is None
            or common_identity_stamps is None
            or common_identity_evidence_seal is None
            or common_controller_policy_seal is None
            or common_episode_evidence_seal is None
            or set(partitions) != {"p1", "p2"}
        ):
            raise ValueError("matchday episode lacks complete partitioned evidence")
        common_stamps = _identity_stamps_from_dict(common_identity_stamps)
        if set(role_identity_stamps) != {"entrant", "opponent"}:
            raise ValueError("competing trace identity stamps are incomplete")
        for role, role_stamp in role_identity_stamps.items():
            if not hmac.compare_digest(role_stamp, getattr(common_stamps, role)):
                raise ValueError(f"all {role} traces must share the captured identity")
        _validate_condition_stamps(
            common_stamps,
            opponent_condition=self._constructor_opponent_condition,
            pinned_opponent_stamp=self._constructor_pinned_opponent_stamp,
        )
        self._validate_constructor_seal()
        _validate_control_config(self.config)
        if type(common_controller_policy_seal) is not str or not hmac.compare_digest(
            common_controller_policy_seal, self._constructor_policy_seal
        ):
            raise ValueError("trace controller policy seal is invalid")
        self._validate_binding(common_binding, task.data)
        self._validate_runtime_evidence(
            common_runtime_ids,
            common_runtime_types,
            common_transport,
            self.config.debug_allow_subprocess,
        )
        complete_summary = {
            **copy.deepcopy(common_summary),
            "accepted_actions": [
                *copy.deepcopy(partitions["p1"]["expected_actions"]),
                *copy.deepcopy(partitions["p2"]["expected_actions"]),
            ],
            "notebook_receipts": [
                *copy.deepcopy(
                    partitions["p1"]["expected_notebook_receipts"]
                ),
                *copy.deepcopy(
                    partitions["p2"]["expected_notebook_receipts"]
                ),
            ],
        }
        expected_actions, expected_notebooks = self._validate_terminal_summary(
            complete_summary, task.data, common_binding
        )
        if Counter(actual_actions) != Counter(expected_actions):
            raise ValueError(
                "action referee joins do not exactly cover terminal accepted actions"
            )
        if Counter(actual_notebooks) != Counter(expected_notebooks):
            raise ValueError(
                "notebook referee joins do not exactly cover terminal receipts"
            )
        if set(action_counts) != {"p1", "p2"}:
            raise ValueError("both fixed seats must have at least one action trace")
        if any(len(carriers[pid]) != 1 for pid in ("p1", "p2")):
            raise ValueError("each fixed seat must have exactly one action reward carrier")

        manifest = _episode_evidence_manifest(
            key=self._identity_hmac_key,
            task=task,
            binding=common_binding,
            public_summary=common_summary,
            partitions=partitions,
            runtime_ids=common_runtime_ids,
            runtime_types=common_runtime_types,
            transport=common_transport,
            opponent_condition=self._constructor_opponent_condition,
            identity_stamps=common_identity_stamps,
            identity_evidence_seal=common_identity_evidence_seal,
            controller_policy_seal=common_controller_policy_seal,
            traces=episode_traces,
        )
        expected_seal = _episode_evidence_seal(self._identity_hmac_key, manifest)
        if type(common_episode_evidence_seal) is not str or not hmac.compare_digest(
            common_episode_evidence_seal, expected_seal
        ):
            raise ValueError("complete matchday episode evidence seal is invalid")

        result = common_summary["result"]
        if result["type"] == "tie":
            outcomes = {"p1": 0.0, "p2": 0.0}
        else:
            winner_pid = result["winner"]["pid"]
            outcomes = {
                "p1": 1.0 if winner_pid == "p1" else -1.0,
                "p2": 1.0 if winner_pid == "p2" else -1.0,
            }
        games = float(common_summary["games_count"])
        referee_episode_id = common_binding["episodeId"]
        consumed = self._consumed_referee_episode_ids
        if type(consumed) is not set:
            raise TypeError("consumed referee episode ids must be the exact built-in set")
        if referee_episode_id in consumed:
            raise ValueError("signed referee episode evidence was already finalized")
        reward_carriers = [carriers[pid][0] for pid in ("p1", "p2")]
        try:
            for carrier in reward_carriers:
                object.__setattr__(carrier, "rewards", {})
                object.__setattr__(carrier, "metrics", {})
            FrozenMatchdayEnv._validate_trace_destinations(episode_traces)
            for pid, carrier in zip(("p1", "p2"), reward_carriers):
                vf.Trace.record_reward(
                    carrier, "matchday_outcome_v0", outcomes[pid]
                )
                vf.Trace.record_metric(carrier, "matchday_games_v0", games)
                vf.Trace.record_metric(
                    carrier, "matchday_result_v0", outcomes[pid]
                )
            for pid, carrier in zip(("p1", "p2"), reward_carriers):
                reward = carrier.rewards.get("matchday_outcome_v0")
                if (
                    type(carrier.rewards) is not dict
                    or set(carrier.rewards) != {"matchday_outcome_v0"}
                    or type(reward) is not vf.Reward
                    or reward.score != outcomes[pid]
                    or reward.weight != 1.0
                    or type(carrier.metrics) is not dict
                    or carrier.metrics
                    != {
                        "matchday_games_v0": games,
                        "matchday_result_v0": outcomes[pid],
                    }
                ):
                    raise RuntimeError("matchday reward/metric write did not complete")
            set.add(consumed, referee_episode_id)
        except BaseException:
            set.discard(consumed, referee_episode_id)
            for carrier in reward_carriers:
                object.__setattr__(carrier, "rewards", {})
                object.__setattr__(carrier, "metrics", {})
            raise

    @staticmethod
    def _validate_trace_destinations(traces: list[vf.Trace]) -> None:
        destinations: list[dict[str, Any]] = []
        reward_metric_destinations: list[dict[str, Any]] = []
        for trace in traces:
            state = trace.__dict__
            if type(state) is not dict:
                raise TypeError("matchday Trace instance state must be an exact dict")
            if "record_reward" in state or "record_metric" in state:
                raise ValueError("matchday Trace contains a reward/metric method shadow")
            for name in ("info", "rewards", "metrics"):
                destination = state.get(name)
                if type(destination) is not dict:
                    raise TypeError(
                        f"matchday Trace {name} destination must be the exact built-in dict"
                    )
                destinations.append(destination)
                if name != "info":
                    reward_metric_destinations.append(destination)
        if len({id(destination) for destination in destinations}) != len(destinations):
            raise ValueError("matchday Trace info/reward/metric destinations must not alias")
        if any(destination for destination in reward_metric_destinations):
            raise ValueError("matchday Trace reward/metric destinations must be empty")

    def _validate_trace_base(
        self, trace: vf.Trace, task: FrozenMatchdayTask, pid: str
    ) -> None:
        if type(trace) is not vf.Trace:
            raise TypeError("matchday Episode requires exact v0.3 Trace artifacts")
        if type(trace.info) is not dict:
            raise TypeError("matchday Trace info must be the exact built-in dict")
        if not trace.is_completed or not trace.ok:
            raise ValueError(f"{pid} trace is not complete and successful")
        if trace.num_turns != 1:
            raise ValueError("every matchday trace must contain exactly one model turn")
        role = _PID_ROLE[pid]
        if trace.agent.name != role:
            raise ValueError(f"{pid} trace has the wrong role")
        if trace.agent.trainable is not False:
            raise ValueError("frozen matchday traces must all be nontrainable")
        config = getattr(trace.agent, "config", None)
        _validate_agent_config(
            config, f"{pid} framework-stamped Trace agent", require_resolved=True
        )
        if not _is_exact_null_harness(config.harness):
            raise ValueError("frozen matchday traces must use the exact null harness")
        if config.retries.max_retries != 0:
            raise ValueError("frozen matchday traces must have zero agent retries")
        if trace.tools:
            raise ValueError("frozen matchday null-harness traces must be tool-less")
        if type(trace.task.data) is not FrozenMatchdayData:
            raise ValueError(f"{pid} trace does not carry exact FrozenMatchdayData")
        if trace.task.data != task.data:
            raise ValueError(f"{pid} trace task data does not match the episode task")
        if trace.rewards:
            raise ValueError("matchday trace has unexpected preexisting rewards")
        if _RESERVED_METRICS & set(trace.metrics):
            raise ValueError("matchday trace has preexisting reserved metrics")
        required = {
            "referee_pid",
            "referee_kind",
            "referee_transport",
            "referee_runtime_ids",
            "referee_runtime_types",
            "opponent_condition",
            "agent_identity_stamps",
            "agent_identity_evidence_seal",
            "controller_policy_seal",
            "referee_binding",
            "referee_join",
            "matchday_reward_carrier",
            "referee_terminal_summary",
            "referee_role_partition",
            "episode_evidence_seal",
        }
        allowed = required | {"notebook_evidence_diagnostic"}
        if set(trace.info) - allowed or not required.issubset(trace.info):
            raise ValueError("matchday trace info is not the sanitized schema")
        if trace.info["referee_pid"] != pid:
            raise ValueError(f"{pid} trace has the wrong fixed referee pid")
        kind = trace.info["referee_kind"]
        if kind not in {"action", "notebook"}:
            raise ValueError("matchday trace has an invalid declared kind")
        has_diagnostic = "notebook_evidence_diagnostic" in trace.info
        if kind == "action" and has_diagnostic:
            raise ValueError("an action trace cannot carry a notebook diagnostic")
        if has_diagnostic and (
            trace.info["notebook_evidence_diagnostic"]
            != NOTEBOOK_EVIDENCE_DIAGNOSTIC
        ):
            raise ValueError("notebook trace has an invalid declared diagnostic")
        if type(trace.info["matchday_reward_carrier"]) is not bool:
            raise ValueError("matchday reward carrier flag must be boolean")
        if (
            trace.info["opponent_condition"]
            != self._constructor_opponent_condition
        ):
            raise ValueError("trace opponent condition does not match constructor seal")

        runtime_ids = trace.info["referee_runtime_ids"]
        runtime_types = trace.info["referee_runtime_types"]
        if type(runtime_ids) is not dict or role not in runtime_ids:
            raise ValueError("trace controller runtime ids omit its role")
        if type(runtime_types) is not dict or role not in runtime_types:
            raise ValueError("trace controller runtime types omit its role")
        runtime = getattr(trace.agent, "runtime", None)
        if runtime is None:
            raise ValueError("matchday trace lacks framework-stamped runtime evidence")
        runtime_id = getattr(runtime, "id", None)
        runtime_type = getattr(runtime, "type", None)
        borrowed = getattr(runtime, "borrowed", None)
        if type(runtime_id) is not str or not runtime_id:
            raise ValueError("framework-stamped trace runtime id is invalid")
        if runtime_id != runtime_ids[role]:
            raise ValueError("trace runtime id contradicts the controller runtime id")
        if type(runtime_type) is not str or not runtime_type:
            raise ValueError("framework-stamped trace runtime type is invalid")
        if runtime_type != runtime_types[role]:
            raise ValueError("trace runtime type contradicts controller runtime types")
        if borrowed is not True:
            raise ValueError("matchday interactions must stamp their role runtime as borrowed")
        config_runtime_type = getattr(getattr(config, "runtime", None), "type", None)
        if config_runtime_type != runtime_type:
            raise ValueError("trace runtime type contradicts its resolved runtime policy")
        transport = trace.info["referee_transport"]
        if transport == "debug-subprocess":
            if runtime_type != "subprocess":
                raise ValueError("debug subprocess transport contradicts trace runtime type")
        elif transport == "distinct-non-subprocess-runtime":
            if runtime_type == "subprocess":
                raise ValueError("non-subprocess transport contradicts trace runtime type")
        else:
            raise ValueError("trace referee transport label is invalid")

    @staticmethod
    def _validate_binding(binding: dict[str, Any], data: FrozenMatchdayData) -> None:
        if type(binding) is not dict:
            raise ValueError("trace referee binding must be the exact built-in dict")
        expected = {
            "conditionDigest": data.condition_digest,
            "configDigest": data.expected_config_digest,
            "showdownRevision": data.showdown_revision,
            "matchdayProtocolVersion": data.matchday_protocol_version,
            "battleProtocolVersion": data.battle_protocol_version,
        }
        if set(binding) != {"episodeId", *expected}:
            raise ValueError("trace referee binding is incomplete")
        if not isinstance(binding["episodeId"], str) or not binding["episodeId"]:
            raise ValueError("trace referee episode id is invalid")
        for key, value in expected.items():
            if type(binding.get(key)) is not type(value) or binding.get(key) != value:
                raise ValueError(f"trace referee binding {key} mismatch")

    @staticmethod
    def _validate_runtime_evidence(
        runtime_ids: Any,
        runtime_types: Any,
        transport: Any,
        debug_allow_subprocess: bool,
    ) -> None:
        if type(runtime_ids) is not dict or set(runtime_ids) != set(_RUNTIME_ROLES):
            raise ValueError("trace runtime ids must cover all three roles")
        if any(type(value) is not str or not value for value in runtime_ids.values()):
            raise ValueError("trace runtime ids must be exact nonempty text")
        if len(set(runtime_ids.values())) != 3:
            raise ValueError("trace runtime ids must be distinct")
        if type(runtime_types) is not dict or set(runtime_types) != set(_RUNTIME_ROLES):
            raise ValueError("trace runtime types must cover all three roles")
        if any(type(value) is not str or not value for value in runtime_types.values()):
            raise ValueError("trace runtime types must be exact nonempty text")
        if len(set(runtime_types.values())) != 1:
            raise ValueError("trace runtime types must be homogeneous in v0")
        runtime_type = next(iter(runtime_types.values()))
        if transport not in {
            "distinct-non-subprocess-runtime",
            "debug-subprocess",
        }:
            raise ValueError("trace referee transport label is invalid")
        if transport == "debug-subprocess":
            if not debug_allow_subprocess:
                raise ValueError("trace claims an unconfigured debug subprocess transport")
            if runtime_type != "subprocess":
                raise ValueError("debug subprocess transport requires subprocess runtimes")
        elif runtime_type == "subprocess":
            raise ValueError("non-subprocess transport contradicts homogeneous runtime types")

    @staticmethod
    def _action_join_key(
        join: Any, pid: str, binding: dict[str, Any]
    ) -> tuple[Any, ...]:
        fields = {
            "kind",
            "episode_id",
            "config_digest",
            "game",
            "pid",
            "battle_revision",
            "battle_state_hash",
            "command",
        }
        if type(join) is not dict or set(join) != fields:
            raise ValueError("action referee join is incomplete")
        if join["kind"] != "action" or join["pid"] != pid:
            raise ValueError("action referee join crossed its declared kind or fixed seat")
        if join["episode_id"] != binding["episodeId"]:
            raise ValueError("action referee join episode id mismatch")
        if join["config_digest"] != binding["configDigest"]:
            raise ValueError("action referee join config digest mismatch")
        for name in ("game", "battle_revision"):
            _integer(join.get(name), f"action join {name}")
        if join["game"] < 1:
            raise ValueError("action join game must be positive")
        _text(join.get("battle_state_hash"), "action join state hash", nonempty=True)
        _text(join.get("command"), "action join command", nonempty=True)
        return (
            join["game"],
            pid,
            join["battle_revision"],
            join["battle_state_hash"],
            join["command"],
        )

    @staticmethod
    def _notebook_join_key(
        join: Any, pid: str, binding: dict[str, Any]
    ) -> tuple[Any, ...]:
        fields = {
            "kind",
            "episode_id",
            "config_digest",
            "pid",
            "game",
            "notebook_sha256",
            "supplied",
        }
        if type(join) is not dict or set(join) != fields:
            raise ValueError("notebook referee join is incomplete")
        if join["kind"] != "notebook" or join["pid"] != pid:
            raise ValueError("notebook referee join crossed its declared kind or fixed seat")
        if join["episode_id"] != binding["episodeId"]:
            raise ValueError("notebook referee join episode id mismatch")
        if join["config_digest"] != binding["configDigest"]:
            raise ValueError("notebook referee join config digest mismatch")
        _integer(join.get("game"), "notebook join game")
        if join["game"] < 1:
            raise ValueError("notebook join game must be positive")
        _text(join.get("notebook_sha256"), "notebook join hash", nonempty=True)
        if not isinstance(join.get("supplied"), bool):
            raise ValueError("notebook join supplied must be boolean")
        return (pid, join["game"], join["supplied"], join["notebook_sha256"])

    @staticmethod
    def _validate_terminal_summary(
        summary: Any,
        data: FrozenMatchdayData,
        binding: dict[str, Any],
    ) -> tuple[list[tuple[Any, ...]], list[tuple[Any, ...]]]:
        fields = {
            "protocol_version",
            "battle_protocol_version",
            "showdown_revision",
            "format",
            "config_digest",
            "score",
            "result",
            "games_count",
            "game_results",
            "accepted_actions",
            "notebook_receipts",
        }
        if type(summary) is not dict or set(summary) != fields:
            raise ValueError("terminal summary is not the minimal sanitized schema")
        expected = {
            "protocol_version": data.matchday_protocol_version,
            "battle_protocol_version": data.battle_protocol_version,
            "showdown_revision": data.showdown_revision,
            "format": data.format,
            "config_digest": data.expected_config_digest,
        }
        for key, value in expected.items():
            if type(summary.get(key)) is not type(value) or summary.get(key) != value:
                raise ValueError(f"terminal summary {key} mismatch")
        if summary["config_digest"] != binding["configDigest"]:
            raise ValueError("terminal summary is not bound to the trace")
        games_count = summary.get("games_count")
        try:
            _validate_outcome_redundancy(
                score=summary.get("score"),
                result=summary.get("result"),
                games_count=games_count,
                game_results=summary.get("game_results"),
            )
        except ProtocolError as exc:
            raise ValueError(str(exc)) from exc
        accepted = summary.get("accepted_actions")
        if type(accepted) is not list:
            raise ValueError("terminal summary accepted_actions must be a list")
        expected_actions: list[tuple[Any, ...]] = []
        action_fields = {
            "game",
            "pid",
            "battle_revision",
            "battle_state_hash",
            "command",
        }
        for action in accepted:
            if type(action) is not dict or set(action) != action_fields:
                raise ValueError("terminal accepted action is incomplete")
            if action["pid"] not in {"p1", "p2"}:
                raise ValueError("terminal accepted action has invalid pid")
            for name in ("game", "battle_revision"):
                _integer(action.get(name), f"terminal accepted action {name}")
            if action["game"] < 1 or action["game"] > games_count:
                raise ValueError("terminal accepted action game is out of range")
            _text(
                action.get("battle_state_hash"),
                "terminal accepted action state hash",
                nonempty=True,
            )
            _text(action.get("command"), "terminal accepted action command", nonempty=True)
            expected_actions.append(
                (
                    action["game"],
                    action["pid"],
                    action["battle_revision"],
                    action["battle_state_hash"],
                    action["command"],
                )
            )
        receipts = summary.get("notebook_receipts")
        if type(receipts) is not list:
            raise ValueError("terminal summary notebook_receipts must be a list")
        expected_notebooks: list[tuple[Any, ...]] = []
        receipt_fields = {"pid", "game", "supplied", "notebook_sha256"}
        for receipt in receipts:
            if type(receipt) is not dict or set(receipt) != receipt_fields:
                raise ValueError("terminal notebook receipt is incomplete")
            if receipt["pid"] not in {"p1", "p2"}:
                raise ValueError("terminal notebook receipt has invalid pid")
            _integer(receipt.get("game"), "terminal notebook receipt game")
            if receipt["game"] < 1 or receipt["game"] >= games_count:
                raise ValueError("terminal notebook receipt game is out of range")
            if type(receipt.get("supplied")) is not bool:
                raise ValueError("terminal notebook receipt supplied must be boolean")
            _text(
                receipt.get("notebook_sha256"),
                "terminal notebook receipt hash",
                nonempty=True,
            )
            expected_notebooks.append(
                (
                    receipt["pid"],
                    receipt["game"],
                    receipt["supplied"],
                    receipt["notebook_sha256"],
                )
            )
        expected_receipt_slots = Counter(
            (pid, game)
            for pid in ("p1", "p2")
            for game in range(1, games_count)
        )
        actual_receipt_slots = Counter(
            (pid, game, ) for pid, game, _supplied, _hash in expected_notebooks
        )
        if actual_receipt_slots != expected_receipt_slots:
            raise ValueError("terminal notebook receipts do not cover every interval")
        return expected_actions, expected_notebooks
