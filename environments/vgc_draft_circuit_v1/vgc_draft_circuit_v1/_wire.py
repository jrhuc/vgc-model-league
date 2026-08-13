from __future__ import annotations

import copy
import hashlib
import math
from collections import Counter
from typing import Any

from verifiers import v1 as vf

from ._model import _PendingTurn, _PHASES, _SEATS, _SHA256, _TURN_KINDS
from .protocol import (
    BATTLE_PROTOCOL_VERSION,
    CIRCUIT_PROTOCOL_VERSION,
    MATCHDAY_PROTOCOL_VERSION,
    PROMPT_PROTOCOL_VERSION,
    SHOWDOWN_REVISION,
    ProtocolBinding,
    ProtocolError,
)


def _raw_response(segment: Any) -> str:
    for message in reversed(segment.messages):
        if isinstance(message, vf.AssistantMessage):
            if message.content is None:
                return ""
            if isinstance(message.content, str):
                return message.content
            raise ProtocolError("model response must be raw text")
    raise ProtocolError("model segment has no assistant response")


def _start_result(value: Any) -> dict[str, Any]:
    started = _object(value, "start result")
    if set(started) != {"started", "revision", "stateHash"}:
        raise ProtocolError("start result has an unexpected schema")
    if started.get("started") is not True:
        raise ProtocolError("referee did not start one fresh circuit")
    _integer(started.get("revision"), "start result.revision")
    _text(started.get("stateHash"), "start result.stateHash")
    return started


def _pending_turns(value: Any) -> list[_PendingTurn]:
    if not isinstance(value, list):
        raise ProtocolError("pending_turns must return a list")
    turns = [_pending_turn(item, "pending turn") for item in value]
    if len({turn.turn_id for turn in turns}) != len(turns):
        raise ProtocolError("pending turn ids must be unique")
    if len({turn.seat_id for turn in turns}) != len(turns):
        raise ProtocolError("one pending batch cannot repeat a seat")
    return turns


def _pending_turn(value: Any, name: str) -> _PendingTurn:
    turn = _object(value, name)
    if set(turn) != {"turnId", "seatId", "kind", "prompt", "attempt"}:
        raise ProtocolError(f"{name} has an unexpected schema")
    turn_id = _text(turn.get("turnId"), f"{name}.turnId")
    seat_id = turn.get("seatId")
    if seat_id not in _SEATS:
        raise ProtocolError(f"{name}.seatId is invalid")
    kind = turn.get("kind")
    if kind not in _TURN_KINDS:
        raise ProtocolError(f"{name}.kind is invalid")
    prompt = _text(turn.get("prompt"), f"{name}.prompt")
    attempt = _integer(turn.get("attempt"), f"{name}.attempt", 1)
    return _PendingTurn(
        turn_id,
        seat_id,
        kind,
        prompt,
        attempt,
        copy.deepcopy(turn),
    )


def _observation(
    value: Any,
    scenario_id: str,
    seat_id: str,
    pending: dict[str, Any],
) -> dict[str, Any]:
    observation = _object(value, "observe result")
    if set(observation) != {
        "protocolVersion",
        "promptProtocolVersion",
        "scenarioId",
        "seatId",
        "phase",
        "revision",
        "stateHash",
        "pendingTurns",
        "bracket",
        "private",
        "terminal",
    }:
        raise ProtocolError("observe result has an unexpected schema")
    expected = {
        "protocolVersion": CIRCUIT_PROTOCOL_VERSION,
        "promptProtocolVersion": PROMPT_PROTOCOL_VERSION,
        "scenarioId": scenario_id,
        "seatId": seat_id,
    }
    if any(
        type(observation.get(key)) is not type(item)
        or observation.get(key) != item
        for key, item in expected.items()
    ):
        raise ProtocolError("observe result binding is invalid")
    if observation.get("phase") not in _PHASES:
        raise ProtocolError("observe result phase is invalid")
    _integer(observation.get("revision"), "observe result.revision")
    _text(observation.get("stateHash"), "observe result.stateHash")
    pending_turns = _pending_turns(observation.get("pendingTurns"))
    if [turn.wire for turn in pending_turns] != [pending]:
        raise ProtocolError("observe result does not match the pending turn")
    bracket = observation.get("bracket")
    if bracket is not None and not isinstance(bracket, list):
        raise ProtocolError("observe result bracket must be a list or null")
    if not isinstance(observation.get("private"), dict):
        raise ProtocolError("observe result private view must be an object")
    if type(observation.get("terminal")) is not bool:
        raise ProtocolError("observe result terminal must be a boolean")
    return observation


def _submit_result(value: Any) -> dict[str, Any]:
    result = _object(value, "submit result")
    required = {
        "accepted",
        "advanced",
        "defaulted",
        "diagnostic",
        "phase",
        "revision",
        "stateHash",
        "terminal",
    }
    if not required <= set(result) or not set(result) <= required | {"problems"}:
        raise ProtocolError("submit result has an unexpected schema")
    for key in ("accepted", "advanced", "defaulted", "terminal"):
        if type(result.get(key)) is not bool:
            raise ProtocolError(f"submit result.{key} must be a boolean")
    diagnostic = result.get("diagnostic")
    if diagnostic is not None:
        _text(diagnostic, "submit result.diagnostic")
    if result.get("phase") not in _PHASES:
        raise ProtocolError("submit result.phase is invalid")
    _integer(result.get("revision"), "submit result.revision")
    _text(result.get("stateHash"), "submit result.stateHash")
    if "problems" in result and (
        not isinstance(result["problems"], list)
        or not all(isinstance(item, str) and item for item in result["problems"])
    ):
        raise ProtocolError("submit result.problems must contain nonempty text")
    return result


def _submission_join(
    turn: _PendingTurn, response: str, result: dict[str, Any]
) -> dict[str, Any]:
    return {
        "turnId": turn.turn_id,
        "seatId": turn.seat_id,
        "kind": turn.kind,
        "attempt": turn.attempt,
        "submitted": response,
        "responseSha256": hashlib.sha256(response.encode("utf-8")).hexdigest(),
        "accepted": result["accepted"],
        "advanced": result["advanced"],
        "defaulted": result["defaulted"],
        "diagnostic": result["diagnostic"],
    }


def _public_receipt(value: Any, name: str = "terminal receipt") -> dict[str, Any]:
    receipt = _object(value, name)
    if set(receipt) != {
        "turnId",
        "seatId",
        "kind",
        "attempt",
        "responseSha256",
        "accepted",
        "advanced",
        "defaulted",
        "diagnostic",
    }:
        raise ProtocolError(f"{name} has an unexpected schema")
    _text(receipt.get("turnId"), f"{name}.turnId")
    if receipt.get("seatId") not in _SEATS:
        raise ProtocolError(f"{name}.seatId is invalid")
    if receipt.get("kind") not in _TURN_KINDS:
        raise ProtocolError(f"{name}.kind is invalid")
    _integer(receipt.get("attempt"), f"{name}.attempt", 1)
    digest = receipt.get("responseSha256")
    if not isinstance(digest, str) or _SHA256.fullmatch(digest) is None:
        raise ProtocolError(f"{name}.responseSha256 must be lowercase 64-hex")
    for key in ("accepted", "advanced", "defaulted"):
        if type(receipt.get(key)) is not bool:
            raise ProtocolError(f"{name}.{key} must be a boolean")
    diagnostic = receipt.get("diagnostic")
    if diagnostic is not None:
        _text(diagnostic, f"{name}.diagnostic")
    return receipt


def _trace_join(value: Any) -> dict[str, Any]:
    join = _object(value, "trace join")
    if set(join) != {
        "turnId",
        "seatId",
        "kind",
        "attempt",
        "submitted",
        "responseSha256",
        "accepted",
        "advanced",
        "defaulted",
        "diagnostic",
    }:
        raise ProtocolError("trace join has an unexpected schema")
    if not isinstance(join.get("submitted"), str):
        raise ProtocolError("trace join.submitted must be text")
    public = {key: item for key, item in join.items() if key != "submitted"}
    _public_receipt(public, "trace join")
    expected = hashlib.sha256(join["submitted"].encode("utf-8")).hexdigest()
    if join["responseSha256"] != expected:
        raise ProtocolError("trace join response hash does not bind submitted text")
    return join


def _public_receipt_key(receipt: dict[str, Any]) -> tuple[Any, ...]:
    return (
        receipt["turnId"],
        receipt["seatId"],
        receipt["kind"],
        receipt["attempt"],
        receipt["responseSha256"],
        receipt["accepted"],
        receipt["advanced"],
        receipt["defaulted"],
        receipt["diagnostic"],
    )


def _trace_receipt_key(join: dict[str, Any]) -> tuple[Any, ...]:
    return _public_receipt_key(
        {key: item for key, item in join.items() if key != "submitted"}
    )


def _terminal(
    value: Any,
    binding: ProtocolBinding | None,
    scenario_id: str,
) -> dict[str, Any]:
    if binding is None:
        raise ProtocolError("terminal has no circuit binding")
    evidence = _object(value, "terminal evidence")
    if set(evidence) != {"summary", "privateEvidence"}:
        raise ProtocolError("terminal evidence has an unexpected schema")
    private = _object(evidence.get("privateEvidence"), "terminal privateEvidence")
    if set(private) != {
        "series",
        "seats",
        "transactionState",
        "turnReceipts",
        "derived",
    }:
        raise ProtocolError("terminal privateEvidence has an unexpected schema")
    summary = _object(evidence.get("summary"), "terminal summary")
    if set(summary) != {
        "protocolVersion",
        "promptProtocolVersion",
        "matchdayProtocolVersion",
        "battleProtocolVersion",
        "showdownRevision",
        "scenarioId",
        "format",
        "configDigest",
        "promptRevision",
        "fixtureDigests",
        "scenario",
        "championSeatId",
        "finalStandings",
        "bracket",
        "series",
        "perSeat",
        "transactions",
        "defaults",
        "turnReceipts",
    }:
        raise ProtocolError("terminal summary has an unexpected schema")
    expected = {
        "protocolVersion": CIRCUIT_PROTOCOL_VERSION,
        "promptProtocolVersion": PROMPT_PROTOCOL_VERSION,
        "matchdayProtocolVersion": MATCHDAY_PROTOCOL_VERSION,
        "battleProtocolVersion": BATTLE_PROTOCOL_VERSION,
        "showdownRevision": SHOWDOWN_REVISION,
        "scenarioId": scenario_id,
        "format": "gen9championsvgc2026regmbbo3",
        "configDigest": binding.config_digest,
        "promptRevision": binding.prompt_revision,
    }
    if any(
        type(summary.get(key)) is not type(item) or summary.get(key) != item
        for key, item in expected.items()
    ):
        raise ProtocolError("terminal summary binding is invalid")
    fixture_digests = _object(summary.get("fixtureDigests"), "terminal summary.fixtureDigests")
    if set(fixture_digests) != {"board", "victoryRoadPool"}:
        raise ProtocolError("terminal fixtureDigests has an unexpected schema")
    for key, digest in fixture_digests.items():
        if digest is not None and (not isinstance(digest, str) or _SHA256.fullmatch(digest) is None):
            raise ProtocolError(f"terminal fixtureDigests.{key} is invalid")
    if scenario_id == "draft-league-v1":
        if fixture_digests["board"] is None or fixture_digests["victoryRoadPool"] is not None:
            raise ProtocolError("draft league fixture digests are invalid")
    elif fixture_digests["board"] is not None or fixture_digests["victoryRoadPool"] is None:
        raise ProtocolError("victory-road fixture digests are invalid")
    scenario = _object(summary.get("scenario"), "terminal summary.scenario")
    if set(scenario) != {"seats", "source", "scope", "claims", "doesNotClaim"} or scenario.get("seats") != 8:
        raise ProtocolError("terminal scenario has an unexpected schema")
    for key in ("source", "scope"):
        _text(scenario.get(key), f"terminal scenario.{key}")
    for key in ("claims", "doesNotClaim"):
        if not isinstance(scenario.get(key), list) or any(not isinstance(item, str) for item in scenario[key]):
            raise ProtocolError(f"terminal scenario.{key} must be a list of strings")
    for key in ("bracket", "series", "perSeat", "defaults", "turnReceipts"):
        if not isinstance(summary.get(key), list):
            raise ProtocolError(f"terminal summary.{key} must be a list")
    champion = summary.get("championSeatId")
    if champion not in _SEATS:
        raise ProtocolError("terminal championSeatId is invalid")
    receipts = [_public_receipt(item) for item in summary["turnReceipts"]]
    if len({_public_receipt_key(item) for item in receipts}) != len(receipts):
        raise ProtocolError("terminal turn receipts are duplicated")
    series = [_series(item) for item in summary["series"]]
    if [item["seriesIndex"] for item in series] != list(range(len(series))):
        raise ProtocolError("terminal series indexes must be contiguous and ordered")
    defaults = [_domain_default(item) for item in summary["defaults"]]
    transactions = _transactions(summary.get("transactions"), scenario_id, receipts)
    final_standings = _standings(summary.get("finalStandings"), scenario_id)
    per_seat = [
        _terminal_wire_seat(
            item,
            champion=champion,
            receipts=receipts,
            defaults=defaults,
            series=series,
            final_standings=final_standings,
            transactions=transactions,
            scenario_id=scenario_id,
        )
        for item in summary["perSeat"]
    ]
    if len(per_seat) != 8 or {seat["seatId"] for seat in per_seat} != set(_SEATS):
        raise ProtocolError("terminal perSeat partition is incomplete or duplicated")
    _validate_schedule(
        scenario_id, series, final_standings, per_seat, transactions
    )
    _validate_bracket(summary["bracket"], series, per_seat)
    if [seat["seatId"] for seat in per_seat if seat["champion"]] != [champion]:
        raise ProtocolError("terminal champion projection is inconsistent")
    return {
        "seriesCount": len(series),
        "championSeatId": champion,
        "seats": per_seat,
    }


def _series(value: Any) -> dict[str, Any]:
    item = _object(value, "terminal series")
    if set(item) != {
        "seriesIndex",
        "stage",
        "week",
        "bracketRound",
        "seats",
        "winnerSeatId",
        "tiebreak",
        "score",
        "gameCount",
        "games",
        "matchdayConfigDigest",
        "acceptedJoins",
    }:
        raise ProtocolError("terminal series has an unexpected schema")
    index = _integer(item.get("seriesIndex"), "terminal series.seriesIndex")
    stage = item.get("stage")
    if stage not in {"top-cut", "roundrobin", "playoff"}:
        raise ProtocolError("terminal series.stage is invalid")
    week = item.get("week")
    bracket_round = item.get("bracketRound")
    if stage == "roundrobin":
        _integer(week, "terminal series.week", 1)
        if week > 7 or bracket_round is not None:
            raise ProtocolError("round-robin series has invalid week or bracketRound")
    else:
        if week is not None:
            raise ProtocolError("elimination series cannot have a week")
        _integer(bracket_round, "terminal series.bracketRound")
    seats = _object(item.get("seats"), "terminal series.seats")
    if set(seats) != {"p1", "p2"} or set(seats.values()) - set(_SEATS) or seats["p1"] == seats["p2"]:
        raise ProtocolError("terminal series seats are invalid")
    score = _object(item.get("score"), "terminal series.score")
    if set(score) != {"p1", "p2", "ties"}:
        raise ProtocolError("terminal series score has an unexpected schema")
    for key in score:
        _integer(score[key], f"terminal series.score.{key}")
    game_count = _integer(item.get("gameCount"), "terminal series.gameCount", 1)
    if game_count < 2 or game_count > 9 or sum(score.values()) != game_count:
        raise ProtocolError("terminal series score does not match its game count")
    games_raw = item.get("games")
    if not isinstance(games_raw, list) or len(games_raw) != game_count:
        raise ProtocolError("terminal series games do not match gameCount")
    games: list[dict[str, Any]] = []
    counted = {"p1": 0, "p2": 0, "ties": 0}
    for expected_number, raw in enumerate(games_raw, start=1):
        game = _object(raw, "terminal game")
        if set(game) != {"gameNumber", "result", "turns"}:
            raise ProtocolError("terminal game has an unexpected schema")
        if game.get("gameNumber") != expected_number or type(game["gameNumber"]) is not int:
            raise ProtocolError("terminal games must be consecutively numbered")
        _integer(game.get("turns"), "terminal game.turns")
        result = _object(game.get("result"), "terminal game.result")
        if result == {"type": "tie", "winnerSeatId": None}:
            counted["ties"] += 1
        elif (
            set(result) == {"type", "winnerSeatId"}
            and result.get("type") == "win"
            and result.get("winnerSeatId") in seats.values()
        ):
            counted["p1" if result["winnerSeatId"] == seats["p1"] else "p2"] += 1
        else:
            raise ProtocolError("terminal game result is invalid")
        games.append(game)
    if counted != score:
        raise ProtocolError("terminal game results do not reproduce the series score")
    prefix = {"p1": 0, "p2": 0}
    for game_number, game in enumerate(games, start=1):
        if game_number > 1 and (
            max(prefix.values()) >= 2
            or (
                game_number - 1 >= 3
                and (stage == "roundrobin" or prefix["p1"] != prefix["p2"])
            )
        ):
            raise ProtocolError("terminal series records a game after it was complete")
        game_winner = game["result"]["winnerSeatId"]
        if game_winner is not None:
            prefix["p1" if game_winner == seats["p1"] else "p2"] += 1
    complete = max(prefix.values()) >= 2 or (
        game_count >= 3
        and (stage == "roundrobin" or prefix["p1"] != prefix["p2"])
    )
    if not complete or (stage == "roundrobin" and game_count > 3):
        raise ProtocolError("terminal series is not a completed frozen best-of-three")
    winner = item.get("winnerSeatId")
    natural = seats["p1"] if score["p1"] > score["p2"] else seats["p2"] if score["p2"] > score["p1"] else None
    if stage == "roundrobin":
        if winner != natural or item.get("tiebreak") != "none":
            raise ProtocolError("round-robin winner or tiebreak is inconsistent")
    else:
        expected_tiebreak = "deterministic-extra-games" if game_count > 3 else "none"
        if winner != natural or winner is None or item.get("tiebreak") != expected_tiebreak:
            raise ProtocolError("elimination winner or tiebreak is inconsistent")
    digest = item.get("matchdayConfigDigest")
    if not isinstance(digest, str) or _SHA256.fullmatch(digest) is None:
        raise ProtocolError("terminal series matchdayConfigDigest is invalid")
    joins = item.get("acceptedJoins")
    if not isinstance(joins, list) or len(joins) != 2:
        raise ProtocolError("terminal series must contain two accepted joins")
    joined: set[str] = set()
    for expected_pid, raw in zip(("p1", "p2"), joins, strict=True):
        join = _object(raw, "terminal accepted join")
        if set(join) != {"seatId", "pid", "teamSha256", "constructionSha256"}:
            raise ProtocolError("terminal accepted join has an unexpected schema")
        if join.get("seatId") not in seats.values() or join.get("pid") != expected_pid:
            raise ProtocolError("terminal accepted join seat or pid is invalid")
        if join["seatId"] != seats[join["pid"]]:
            raise ProtocolError("terminal accepted join does not match the series side")
        for key in ("teamSha256", "constructionSha256"):
            if not isinstance(join.get(key), str) or _SHA256.fullmatch(join[key]) is None:
                raise ProtocolError(f"terminal accepted join {key} is invalid")
        joined.add(join["seatId"])
    if joined != set(seats.values()):
        raise ProtocolError("terminal accepted joins do not cover both seats")
    return {
        **copy.deepcopy(item),
        "seriesIndex": index,
        "games": games,
    }


def _wdl(value: Any, name: str) -> dict[str, int]:
    wdl = _object(value, name)
    if set(wdl) != {"wins", "draws", "losses"}:
        raise ProtocolError(f"{name} has an unexpected schema")
    return {key: _integer(wdl[key], f"{name}.{key}") for key in wdl}


def _split(value: Any, name: str) -> dict[str, dict[str, int]]:
    split = _object(value, name)
    if set(split) != {"series", "games"}:
        raise ProtocolError(f"{name} has an unexpected schema")
    return {
        "series": _wdl(split["series"], f"{name}.series"),
        "games": _wdl(split["games"], f"{name}.games"),
    }


def _series_split(
    series: list[dict[str, Any]], seat_id: str
) -> dict[str, dict[str, int]]:
    result = {
        "series": {"wins": 0, "draws": 0, "losses": 0},
        "games": {"wins": 0, "draws": 0, "losses": 0},
    }
    for item in series:
        if seat_id not in item["seats"].values():
            continue
        if item["winnerSeatId"] is None:
            result["series"]["draws"] += 1
        elif item["winnerSeatId"] == seat_id:
            result["series"]["wins"] += 1
        else:
            result["series"]["losses"] += 1
        for game in item["games"]:
            winner = game["result"]["winnerSeatId"]
            if winner is None:
                result["games"]["draws"] += 1
            elif winner == seat_id:
                result["games"]["wins"] += 1
            else:
                result["games"]["losses"] += 1
    return result


def _standings(value: Any, scenario_id: str) -> list[dict[str, Any]] | None:
    if scenario_id == "victory-road-top8-v1":
        if value is not None:
            raise ProtocolError("victory-road terminal cannot contain league standings")
        return None
    if not isinstance(value, list) or len(value) != 8:
        raise ProtocolError("draft league terminal requires eight final standings")
    standings: list[dict[str, Any]] = []
    for raw in value:
        row = _object(raw, "terminal standing")
        if set(row) != {
            "rank", "seatId", "series", "gameWins", "gameDraws", "gameLosses"
        }:
            raise ProtocolError("terminal standing has an unexpected schema")
        rank = _integer(row.get("rank"), "terminal standing.rank", 1)
        if rank > 8 or row.get("seatId") not in _SEATS:
            raise ProtocolError("terminal standing rank or seat is invalid")
        standings.append(
            {
                "rank": rank,
                "seatId": row["seatId"],
                "series": _wdl(row.get("series"), "terminal standing.series"),
                "gameWins": _integer(row.get("gameWins"), "terminal standing.gameWins"),
                "gameDraws": _integer(row.get("gameDraws"), "terminal standing.gameDraws"),
                "gameLosses": _integer(row.get("gameLosses"), "terminal standing.gameLosses"),
            }
        )
    if (
        [row["rank"] for row in standings] != list(range(1, 9))
        or {row["seatId"] for row in standings} != set(_SEATS)
    ):
        raise ProtocolError("terminal standings are incomplete, unordered, or duplicated")
    return standings


def _domain_default(value: Any) -> dict[str, Any]:
    default = _object(value, "terminal domain default")
    if set(default) != {"turnId", "seatId", "kind", "seriesIndex", "selectedDigest", "diagnostic"}:
        raise ProtocolError("terminal domain default has an unexpected schema")
    _text(default.get("turnId"), "terminal domain default.turnId")
    if default.get("seatId") not in _SEATS or default.get("kind") not in _TURN_KINDS - {"notebook"}:
        raise ProtocolError("terminal domain default seat or kind is invalid")
    if default.get("seriesIndex") is not None:
        _integer(default["seriesIndex"], "terminal domain default.seriesIndex")
    selected_digest = _text(default.get("selectedDigest"), "terminal domain default.selectedDigest")
    if _SHA256.fullmatch(selected_digest) is None:
        raise ProtocolError("terminal domain default.selectedDigest is invalid")
    _text(default.get("diagnostic"), "terminal domain default.diagnostic")
    return default


def _transactions(
    value: Any,
    scenario_id: str,
    receipts: list[dict[str, Any]],
) -> dict[str, Any] | None:
    if scenario_id == "victory-road-top8-v1":
        if value is not None:
            raise ProtocolError("victory-road terminal cannot contain transactions")
        if any(item["kind"] in {"trade_offer", "trade_response", "free_agency"} for item in receipts):
            raise ProtocolError("victory-road receipts cannot contain transactions")
        return None
    tx = _object(value, "terminal transactions")
    if set(tx) != {"afterWeek", "tradesAllowed", "maxFreeAgencySwaps", "order", "offers", "freeAgency", "finalRosterDigests"}:
        raise ProtocolError("terminal transactions has an unexpected schema")
    if tx.get("afterWeek") != 3 or tx.get("tradesAllowed") != 1 or tx.get("maxFreeAgencySwaps") != 6:
        raise ProtocolError("terminal transaction policy is invalid")
    order = tx.get("order")
    if not isinstance(order, list) or len(order) != 8 or set(order) != set(_SEATS):
        raise ProtocolError("terminal transaction order is not a seat permutation")
    offers = tx.get("offers")
    free = tx.get("freeAgency")
    digests = tx.get("finalRosterDigests")
    if not isinstance(offers, list) or len(offers) != 8 or not isinstance(free, list) or len(free) != 8 or not isinstance(digests, list) or len(digests) != 8:
        raise ProtocolError("terminal transactions must contain one row per seat")
    for expected_from, offer in zip(order, offers, strict=True):
        row = _object(offer, "terminal transaction offer")
        if set(row) != {"from", "to", "give", "get", "accepted", "proposerDefaulted", "responderDefaulted"}:
            raise ProtocolError("terminal transaction offer has an unexpected schema")
        if row.get("from") != expected_from or row.get("to") not in {*_SEATS, None} or row.get("to") == expected_from:
            raise ProtocolError("terminal transaction offer seat or order is invalid")
        if type(row.get("proposerDefaulted")) is not bool:
            raise ProtocolError("terminal transaction proposer flag is invalid")
        if row["to"] is None:
            if any(row.get(key) is not None for key in ("give", "get", "accepted", "responderDefaulted")):
                raise ProtocolError("empty transaction offer has non-null outcome fields")
        elif (
            not isinstance(row.get("give"), str)
            or not row["give"]
            or not isinstance(row.get("get"), str)
            or not row["get"]
            or type(row.get("accepted")) is not bool
            or type(row.get("responderDefaulted")) is not bool
        ):
            raise ProtocolError("terminal transaction offer outcome is invalid")
    for expected_seat, item in zip(order, free, strict=True):
        row = _object(item, "terminal free agency")
        if set(row) != {"seatId", "swaps", "defaulted"} or row.get("seatId") != expected_seat or not isinstance(row.get("swaps"), list) or type(row.get("defaulted")) is not bool:
            raise ProtocolError("terminal free-agency row or order is invalid")
        if len(row["swaps"]) > 6:
            raise ProtocolError("terminal free-agency swaps exceed the policy")
        drops: set[str] = set()
        adds: set[str] = set()
        for raw_swap in row["swaps"]:
            swap = _object(raw_swap, "terminal free-agency swap")
            if set(swap) != {"drop", "add"}:
                raise ProtocolError("terminal free-agency swap has an unexpected schema")
            drop = _text(swap.get("drop"), "terminal free-agency swap.drop")
            add = _text(swap.get("add"), "terminal free-agency swap.add")
            if drop in drops or add in adds:
                raise ProtocolError("terminal free-agency swap repeats an asset")
            drops.add(drop)
            adds.add(add)
    if {item["seatId"] for item in free} != set(_SEATS):
        raise ProtocolError("terminal free-agency seats are incomplete")
    for item in digests:
        row = _object(item, "terminal roster digest")
        if set(row) != {"seatId", "rosterDigest"} or row.get("seatId") not in _SEATS or not isinstance(row.get("rosterDigest"), str) or _SHA256.fullmatch(row["rosterDigest"]) is None:
            raise ProtocolError("terminal roster digest is invalid")
    if {item["seatId"] for item in digests} != set(_SEATS):
        raise ProtocolError("terminal roster digests are incomplete")
    by_kind = Counter(item["kind"] for item in receipts)
    if by_kind["trade_offer"] < 8 or by_kind["free_agency"] < 8:
        raise ProtocolError("terminal transaction turn receipts are incomplete")
    for offer in offers:
        proposer_defaults = sum(
            item["seatId"] == offer["from"]
            and item["kind"] == "trade_offer"
            and item["defaulted"]
            for item in receipts
        )
        if proposer_defaults > 1 or offer["proposerDefaulted"] != (proposer_defaults == 1):
            raise ProtocolError("transaction proposer default does not match receipts")
    for seat_id in _SEATS:
        response_defaults = sum(
            item["seatId"] == seat_id
            and item["kind"] == "trade_response"
            and item["defaulted"]
            for item in receipts
        )
        offer_defaults = sum(
            offer["to"] == seat_id and offer["responderDefaulted"] is True
            for offer in offers
        )
        if response_defaults != offer_defaults:
            raise ProtocolError("transaction responder defaults do not match receipts")
    for item in free:
        free_defaults = sum(
            receipt["seatId"] == item["seatId"]
            and receipt["kind"] == "free_agency"
            and receipt["defaulted"]
            for receipt in receipts
        )
        if free_defaults > 1 or item["defaulted"] != (free_defaults == 1):
            raise ProtocolError("free-agency default does not match receipts")
    return copy.deepcopy(tx)


def _terminal_wire_seat(
    value: Any,
    *,
    champion: str,
    receipts: list[dict[str, Any]],
    defaults: list[dict[str, Any]],
    series: list[dict[str, Any]],
    final_standings: list[dict[str, Any]] | None,
    transactions: dict[str, Any] | None,
    scenario_id: str,
) -> dict[str, Any]:
    raw = _object(value, "terminal perSeat")
    if set(raw) != {"seatId", "name", "total", "roundRobinPreWindow", "roundRobinPostWindow", "playoffs", "topCut", "reward", "defaults"}:
        raise ProtocolError("terminal perSeat has an unexpected schema")
    seat_id = raw.get("seatId")
    if seat_id not in _SEATS:
        raise ProtocolError("terminal perSeat.seatId is invalid")
    _text(raw.get("name"), "terminal perSeat.name")
    split_filters = {
        "total": lambda item: True,
        "roundRobinPreWindow": lambda item: item["stage"] == "roundrobin" and item["week"] <= 3,
        "roundRobinPostWindow": lambda item: item["stage"] == "roundrobin" and item["week"] > 3,
        "playoffs": lambda item: item["stage"] == "playoff",
        "topCut": lambda item: item["stage"] == "top-cut",
    }
    parsed_splits: dict[str, Any] = {}
    for name, predicate in split_filters.items():
        projected = _split(raw.get(name), f"terminal perSeat.{name}")
        actual = _series_split([item for item in series if predicate(item)], seat_id)
        if projected != actual:
            raise ProtocolError(f"terminal perSeat.{name} does not match series evidence")
        parsed_splits[name] = projected
    default_counts = _object(raw.get("defaults"), "terminal perSeat.defaults")
    default_kinds = _TURN_KINDS - {"notebook"}
    if set(default_counts) != default_kinds:
        raise ProtocolError("terminal perSeat.defaults has an unexpected schema")
    for kind in default_kinds:
        _integer(default_counts[kind], f"terminal perSeat.defaults.{kind}")
        actual = sum(item["seatId"] == seat_id and item["kind"] == kind for item in defaults)
        receipt_actual = sum(
            item["seatId"] == seat_id
            and item["kind"] == kind
            and item["defaulted"]
            for item in receipts
        )
        if default_counts[kind] != actual or actual != receipt_actual:
            raise ProtocolError("terminal perSeat default count does not match defaults and receipts")
    reward = _object(raw.get("reward"), "terminal perSeat.reward")
    if set(reward) != {"name", "value"} or type(reward.get("value")) not in {int, float} or not math.isfinite(float(reward["value"])):
        raise ProtocolError("terminal perSeat.reward is invalid")
    expected_name, expected_value = _recompute_return(scenario_id, parsed_splits)
    if reward.get("name") != expected_name or not math.isclose(float(reward["value"]), expected_value, rel_tol=0.0, abs_tol=1e-12):
        raise ProtocolError("terminal perSeat.reward does not match the frozen return")
    standing = None if final_standings is None else next(item for item in final_standings if item["seatId"] == seat_id)
    if standing is not None:
        rr = {
            key: parsed_splits["roundRobinPreWindow"]["series"][key]
            + parsed_splits["roundRobinPostWindow"]["series"][key]
            for key in ("wins", "draws", "losses")
        }
        rr_games = {
            key: parsed_splits["roundRobinPreWindow"]["games"][key]
            + parsed_splits["roundRobinPostWindow"]["games"][key]
            for key in ("wins", "draws", "losses")
        }
        if (
            standing["series"] != rr
            or standing["gameWins"] != rr_games["wins"]
            or standing["gameDraws"] != rr_games["draws"]
            or standing["gameLosses"] != rr_games["losses"]
        ):
            raise ProtocolError("terminal standing does not match round-robin evidence")
    seat_receipts = [item for item in receipts if item["seatId"] == seat_id]
    g1_losses = 0
    g1_conversions = 0
    for item in series:
        if seat_id in item["seats"].values() and item["games"][0]["result"]["winnerSeatId"] not in {None, seat_id}:
            g1_losses += 1
            g1_conversions += item["winnerSeatId"] == seat_id
    transaction_offers = [] if transactions is None else [item for item in transactions["offers"] if item["from"] == seat_id]
    free = None if transactions is None else next(item for item in transactions["freeAgency"] if item["seatId"] == seat_id)
    return {
        "seatId": seat_id,
        "rewardName": reward["name"],
        "rewardValue": float(reward["value"]),
        "splits": parsed_splits,
        "seriesPlayed": sum(parsed_splits["total"]["series"].values()),
        "seriesWins": parsed_splits["total"]["series"]["wins"],
        "seriesLosses": parsed_splits["total"]["series"]["losses"],
        "seriesDraws": parsed_splits["total"]["series"]["draws"],
        "gamesPlayed": sum(parsed_splits["total"]["games"].values()),
        "gameWins": parsed_splits["total"]["games"]["wins"],
        "gameLosses": parsed_splits["total"]["games"]["losses"],
        "gameDraws": parsed_splits["total"]["games"]["draws"],
        "defaultedTurns": sum(item["defaulted"] for item in seat_receipts),
        "invalidTurns": sum(not item["accepted"] for item in seat_receipts),
        "defaults": copy.deepcopy(default_counts),
        "champion": seat_id == champion,
        "rank": None if standing is None else standing["rank"],
        "madePlayoffs": standing is not None and standing["rank"] <= 4,
        "transactionOffers": len(transaction_offers),
        "acceptedTransactions": sum(item["accepted"] is True for item in transaction_offers),
        "freeAgencySwaps": 0 if free is None else len(free["swaps"]),
        "g1Losses": g1_losses,
        "g1Conversions": g1_conversions,
        "receipts": copy.deepcopy(seat_receipts),
    }


def _recompute_return(
    scenario_id: str, splits: dict[str, Any]
) -> tuple[str, float]:
    if scenario_id == "draft-league-v1":
        rr_pre = splits["roundRobinPreWindow"]["series"]
        rr_post = splits["roundRobinPostWindow"]["series"]
        playoffs = splits["playoffs"]["series"]
        value = (
            rr_pre["wins"] - rr_pre["losses"]
            + rr_post["wins"] - rr_post["losses"]
            + playoffs["wins"] - playoffs["losses"]
        ) / 9
        return "draft_league_series_return_v1", value
    if scenario_id == "victory-road-top8-v1":
        top_cut = splits["topCut"]["series"]
        return "tournament_series_return_v1", (top_cut["wins"] - top_cut["losses"]) / 3
    raise ProtocolError(f"unsupported circuit scenario {scenario_id!r}")


def _validate_schedule(
    scenario_id: str,
    series: list[dict[str, Any]],
    standings: list[dict[str, Any]] | None,
    per_seat: list[dict[str, Any]],
    transactions: dict[str, Any] | None,
) -> None:
    if scenario_id == "victory-road-top8-v1":
        if len(series) != 7 or any(item["stage"] != "top-cut" for item in series):
            raise ProtocolError("victory-road circuit must contain seven top-cut series")
        _validate_elimination(series, 0, 7, {0: 4, 1: 2, 2: 1})
        return
    if len(series) != 31:
        raise ProtocolError("draft league must contain 31 series")
    rr = series[:28]
    playoffs = series[28:]
    if any(item["stage"] != "roundrobin" or item["week"] != item["seriesIndex"] // 4 + 1 for item in rr):
        raise ProtocolError("draft league round-robin stage/week sequence is invalid")
    pairs = [frozenset(item["seats"].values()) for item in rr]
    expected_pairs = {
        frozenset((left, right))
        for index, left in enumerate(_SEATS)
        for right in _SEATS[index + 1 :]
    }
    if set(pairs) != expected_pairs or len(set(pairs)) != 28:
        raise ProtocolError("draft league round robin does not cover every pair exactly once")
    if standings is None:
        raise ProtocolError("draft league standings are missing")
    seat_index = {seat["seatId"]: index for index, seat in enumerate(per_seat)}
    expected_order = sorted(
        standings,
        key=lambda row: (
            -row["series"]["wins"],
            -(row["gameWins"] - row["gameLosses"]),
            -row["gameWins"],
            seat_index[row["seatId"]],
        ),
    )
    if [row["seatId"] for row in standings] != [row["seatId"] for row in expected_order]:
        raise ProtocolError("draft league standings do not follow the frozen tiebreak tuple")
    seeds = {row["rank"]: row["seatId"] for row in standings}
    if transactions is None:
        raise ProtocolError("draft league transactions are missing")
    pre_order = sorted(
        per_seat,
        key=lambda seat: (
            -seat["splits"]["roundRobinPreWindow"]["series"]["wins"],
            -(
                seat["splits"]["roundRobinPreWindow"]["games"]["wins"]
                - seat["splits"]["roundRobinPreWindow"]["games"]["losses"]
            ),
            -seat["splits"]["roundRobinPreWindow"]["games"]["wins"],
            seat_index[seat["seatId"]],
        ),
    )
    expected_transaction_order = [
        seat["seatId"] for seat in reversed(pre_order)
    ]
    if transactions["order"] != expected_transaction_order:
        raise ProtocolError("draft transaction order does not reverse frozen week-three standings")
    if [item["seatId"] for item in transactions["finalRosterDigests"]] != [
        seat["seatId"] for seat in per_seat
    ]:
        raise ProtocolError("final roster digests do not follow entrant order")
    seeds = {row["rank"]: row["seatId"] for row in standings}
    if [frozenset(item["seats"].values()) for item in playoffs[:2]] != [
        frozenset((seeds[1], seeds[4])),
        frozenset((seeds[2], seeds[3])),
    ]:
        raise ProtocolError("draft league semifinals do not join the top four seeds")
    _validate_elimination(playoffs, 28, 31, {0: 2, 1: 1})
    final_seats = set(playoffs[2]["seats"].values())
    if final_seats != {playoffs[0]["winnerSeatId"], playoffs[1]["winnerSeatId"]}:
        raise ProtocolError("draft league final does not join semifinal winners")
    made = {seat["seatId"] for seat in per_seat if seat["madePlayoffs"]}
    if made != {seeds[index] for index in range(1, 5)}:
        raise ProtocolError("draft league playoff flags do not match standings")


def _validate_elimination(
    series: list[dict[str, Any]],
    start: int,
    stop: int,
    round_counts: dict[int, int],
) -> None:
    if [item["seriesIndex"] for item in series] != list(range(start, stop)):
        raise ProtocolError("elimination series indexes are invalid")
    counts = Counter(item["bracketRound"] for item in series)
    if counts != Counter(round_counts):
        raise ProtocolError("elimination bracket-round counts are invalid")
    for round_number in range(1, max(round_counts) + 1):
        previous = {item["winnerSeatId"] for item in series if item["bracketRound"] == round_number - 1}
        current = {seat for item in series if item["bracketRound"] == round_number for seat in item["seats"].values()}
        if current != previous:
            raise ProtocolError("elimination round does not join prior winners")


def _validate_bracket(
    value: Any,
    series: list[dict[str, Any]],
    per_seat: list[dict[str, Any]],
) -> None:
    if not isinstance(value, list) or not value:
        raise ProtocolError("terminal bracket must contain rounds")
    seat_order = [seat["seatId"] for seat in per_seat]
    seen: set[int] = set()
    for round_number, raw_round in enumerate(value):
        if not isinstance(raw_round, list):
            raise ProtocolError("terminal bracket round must be a list")
        for raw in raw_round:
            match = _object(raw, "terminal bracket match")
            if set(match) != {"round", "seriesIndex", "slots", "winner"} or match.get("round") != round_number:
                raise ProtocolError("terminal bracket match has an unexpected schema")
            index = match.get("seriesIndex")
            _integer(index, "terminal bracket match.seriesIndex")
            slots = match.get("slots")
            if not isinstance(slots, list) or len(slots) != 2 or any(type(slot) is not int or slot < 0 or slot >= 8 for slot in slots):
                raise ProtocolError("terminal bracket match slots are invalid")
            winner = match.get("winner")
            if type(winner) is not int or winner < 0 or winner >= 8:
                raise ProtocolError("terminal bracket match winner is invalid")
            item = next((entry for entry in series if entry["seriesIndex"] == index), None)
            if item is None or item["bracketRound"] != round_number:
                raise ProtocolError("terminal bracket match does not join a series")
            if {seat_order[slot] for slot in slots} != set(item["seats"].values()) or seat_order[winner] != item["winnerSeatId"]:
                raise ProtocolError("terminal bracket slots or winner do not join series evidence")
            if index in seen:
                raise ProtocolError("terminal bracket repeats a series")
            seen.add(index)
    elimination_indexes = {item["seriesIndex"] for item in series if item["stage"] != "roundrobin"}
    if seen != elimination_indexes:
        raise ProtocolError("terminal bracket does not cover every elimination series")


def _object(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ProtocolError(f"{name} must be an object")
    return value


def _text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ProtocolError(f"{name} must be nonempty text")
    return value


def _integer(value: Any, name: str, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum:
        raise ProtocolError(f"{name} must be an integer >= {minimum}")
    return value
