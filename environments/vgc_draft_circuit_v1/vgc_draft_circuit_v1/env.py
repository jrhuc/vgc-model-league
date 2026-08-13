from __future__ import annotations

import asyncio
import copy
import math
import uuid
from collections import Counter
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from typing import Any

from pydantic import Field, model_validator
from verifiers import v1 as vf

from ._model import (
    _PendingTurn,
    _PLAYERS,
    _ROLES,
    _ROLE_TO_SEAT,
    _SEATS,
    _SEAT_TO_ROLE,
    _SHA256,
    _TURN_KINDS,
)
from ._wire import (
    _integer,
    _object,
    _observation,
    _pending_turns,
    _public_receipt,
    _public_receipt_key,
    _raw_response,
    _recompute_return,
    _split,
    _start_result,
    _submission_join,
    _submit_result,
    _terminal,
    _trace_join,
    _trace_receipt_key,
)
from .protocol import (
    DEFAULT_REFEREE_EXECUTABLE,
    DEFAULT_REFEREE_IMAGE,
    DEFAULT_REQUEST_TIMEOUT,
    DEFAULT_STDERR_TAIL_BYTES,
    BATTLE_PROTOCOL_VERSION,
    CIRCUIT_PROTOCOL_VERSION,
    MATCHDAY_PROTOCOL_VERSION,
    PROMPT_PROTOCOL_VERSION,
    JSONL_PROTOCOL_VERSION,
    SHOWDOWN_REVISION,
    ProtocolBinding,
    ProtocolError,
    VgcDraftCircuitProtocolClient,
)
from .taskset import VgcDraftCircuitTask

_NULL_HARNESS = vf.HarnessConfig(id="null")
_NO_RETRIES = vf.RetryConfig(max_retries=0)
_PLAYER_RUNTIME_IMAGE = "python:3.11-slim"


def _player_config() -> vf.AgentConfig:
    return vf.AgentConfig(
        harness=_NULL_HARNESS,
        runtime=vf.DockerConfig(image=_PLAYER_RUNTIME_IMAGE),
        retries=_NO_RETRIES,
    )


def _referee_config() -> vf.AgentConfig:
    return vf.AgentConfig(
        harness=_NULL_HARNESS,
        runtime=vf.DockerConfig(image=DEFAULT_REFEREE_IMAGE),
        retries=_NO_RETRIES,
    )


class VgcDraftCircuitEnvConfig(vf.EnvConfig):
    seat1: vf.AgentConfig = _player_config()
    seat2: vf.AgentConfig = _player_config()
    seat3: vf.AgentConfig = _player_config()
    seat4: vf.AgentConfig = _player_config()
    seat5: vf.AgentConfig = _player_config()
    seat6: vf.AgentConfig = _player_config()
    seat7: vf.AgentConfig = _player_config()
    seat8: vf.AgentConfig = _player_config()
    referee: vf.AgentConfig = _referee_config()
    max_concurrent_agents: int = Field(8, ge=8)
    referee_executable: str = DEFAULT_REFEREE_EXECUTABLE
    referee_stderr_tail_bytes: int = Field(DEFAULT_STDERR_TAIL_BYTES, ge=0)
    referee_shutdown_timeout: float = Field(5.0, gt=0)
    referee_request_timeout: float = Field(DEFAULT_REQUEST_TIMEOUT, gt=0)
    debug_allow_subprocess: bool = False

    @model_validator(mode="after")
    def _circuit_policy(self) -> "VgcDraftCircuitEnvConfig":
        _validate_config(self)
        return self


@dataclass
class _Seat:
    seat_id: str
    role: str
    agent: Any
    runtime: Any
    traces: list[Any] = field(default_factory=list)


class VgcDraftCircuitEnv(vf.Env[VgcDraftCircuitEnvConfig]):
    async def setup(self, agents: vf.Agents) -> None:
        for seat_id in _PLAYERS:
            getattr(agents, seat_id).trainable = True
        agents.referee.trainable = False

    async def run(self, task: vf.Task, agents: vf.Agents) -> None:
        if not isinstance(task, VgcDraftCircuitTask):
            raise TypeError("VgcDraftCircuitEnv requires VgcDraftCircuitTask")
        _validate_config(self.config)
        _validate_agents(agents)

        async with AsyncExitStack() as stack:
            runtimes = {
                role: await stack.enter_async_context(
                    getattr(agents, role).provision(task)
                )
                for role in _ROLES
            }
            transport, runtime_ids = _runtime_layout(
                runtimes, self.config.debug_allow_subprocess
            )
            client = await VgcDraftCircuitProtocolClient.launch(
                runtimes["referee"],
                executable=self.config.referee_executable,
                stderr_tail_bytes=self.config.referee_stderr_tail_bytes,
                shutdown_timeout=self.config.referee_shutdown_timeout,
                request_timeout=self.config.referee_request_timeout,
            )
            await stack.enter_async_context(client)
            started = await client.start(
                episode_id=uuid.uuid4().hex,
                condition_digest=task.data.condition_digest,
                scenario_id=task.data.scenario_id,
                seed=task.data.seed,
            )
            _start_result(started)
            if client.binding is None:
                raise ProtocolError("referee start did not establish a binding")
            seats = {
                seat_id: _Seat(
                    seat_id,
                    role,
                    getattr(agents, role),
                    runtimes[role],
                )
                for role, seat_id in _ROLE_TO_SEAT.items()
            }
            terminal = await self._play(
                task,
                client,
                seats,
                client.binding,
                transport,
                runtime_ids,
            )
            _attach_terminal(seats, terminal)

    async def _play(
        self,
        task: VgcDraftCircuitTask,
        client: VgcDraftCircuitProtocolClient,
        seats: dict[str, _Seat],
        binding: ProtocolBinding,
        transport: str,
        runtime_ids: dict[str, str],
    ) -> dict[str, Any]:
        while True:
            turns = _pending_turns(await client.call("pending_turns"))
            if not turns:
                terminal = _terminal(
                    await client.call("terminal"),
                    client.binding,
                    task.data.scenario_id,
                )
                return terminal
            observed = await asyncio.gather(
                *(
                    client.call("observe", {"seatId": turn.seat_id})
                    for turn in turns
                )
            )
            for turn, raw_observation in zip(turns, observed):
                _observation(
                    raw_observation,
                    task.data.scenario_id,
                    turn.seat_id,
                    turn.wire,
                )
            completed = await self._call_pending(
                task,
                turns,
                seats,
                binding,
                transport,
                runtime_ids,
            )
            for turn, trace, response in completed:
                result = _submit_result(
                    await client.call(
                        "submit",
                        {
                            "turnId": turn.turn_id,
                            "seatId": turn.seat_id,
                            "response": response,
                        },
                    )
                )
                join = _submission_join(turn, response, result)
                trace.info["circuit_v1"]["join"] = join

    async def _call_pending(
        self,
        task: VgcDraftCircuitTask,
        turns: list[_PendingTurn],
        seats: dict[str, _Seat],
        binding: ProtocolBinding,
        transport: str,
        runtime_ids: dict[str, str],
    ) -> list[tuple[_PendingTurn, Any, str]]:
        active: list[tuple[_PendingTurn, Any, Any]] = []
        async with AsyncExitStack() as stack:
            for turn in turns:
                seat = seats[turn.seat_id]
                interaction = await stack.enter_async_context(
                    seat.agent.interaction(task, runtime=seat.runtime)
                )
                trace = interaction.trace
                trace.info["circuit_v1"] = {
                    "binding": binding.to_wire(),
                    "scenario": task.data.scenario_id,
                    "seat": turn.seat_id,
                    "transport": transport,
                    "runtime_ids": dict(runtime_ids),
                    "join": None,
                }
                seat.traces.append(trace)
                active.append((turn, interaction, trace))
            results = await asyncio.gather(
                *(
                    interaction.turn(turn.prompt)
                    for turn, interaction, _trace in active
                ),
                return_exceptions=True,
            )
        completed: list[tuple[_PendingTurn, Any, str]] = []
        for (turn, _interaction, trace), result in zip(active, results):
            if isinstance(result, BaseException):
                raise result
            if result.terminated or trace.num_turns != 1:
                raise ProtocolError(
                    "each pending decision must produce one model turn"
                )
            completed.append((turn, trace, _raw_response(result)))
        return completed

    async def finalize(self, task: vf.Task, episode: vf.Episode) -> None:
        if not isinstance(task, VgcDraftCircuitTask):
            raise TypeError("VgcDraftCircuitEnv requires VgcDraftCircuitTask")
        if not episode.traces:
            raise ValueError("circuit episode has no player decision traces")

        by_seat: dict[str, list[Any]] = {seat_id: [] for seat_id in _SEATS}
        terminal_by_seat: dict[str, dict[str, Any]] = {}
        actual: Counter[tuple[Any, ...]] = Counter()
        common_binding: dict[str, Any] | None = None
        common_runtime_ids: dict[str, str] | None = None
        common_transport: str | None = None
        common_terminal: tuple[int, str] | None = None

        for trace in episode.traces:
            if set(trace.info) != {"circuit_v1"}:
                raise ValueError("trace must carry only circuit_v1 evidence")
            evidence = _object(trace.info["circuit_v1"], "circuit_v1 evidence")
            if set(evidence) != {
                "binding",
                "scenario",
                "seat",
                "transport",
                "runtime_ids",
                "join",
                "terminal",
            }:
                raise ValueError("circuit_v1 evidence has an unexpected schema")
            seat_id = evidence.get("seat")
            if seat_id not in by_seat or trace.agent.name != _SEAT_TO_ROLE[seat_id]:
                raise ValueError("trace role and circuit seat disagree")
            if not trace.ok or trace.num_turns != 1 or not trace.agent.trainable:
                raise ValueError(
                    "circuit trace is not one successful trainable decision"
                )
            if trace.rewards or trace.metrics:
                raise ValueError("circuit trace was scored before episode validation")
            runtime_ids = _runtime_ids(evidence.get("runtime_ids"))
            runtime = trace.agent.runtime
            if (
                runtime is None
                or runtime.borrowed is not True
                or runtime.id != runtime_ids[_SEAT_TO_ROLE[seat_id]]
            ):
                raise ValueError(
                    "trace runtime does not match its isolated circuit seat"
                )
            binding = _binding(evidence.get("binding"), task)
            if evidence.get("scenario") != task.data.scenario_id:
                raise ValueError("trace scenario does not match its task")
            transport = evidence.get("transport")
            if transport not in {"runtime-process", "debug-subprocess"}:
                raise ValueError("trace transport label is invalid")
            if common_binding is None:
                common_binding = binding
                common_runtime_ids = runtime_ids
                common_transport = transport
            elif (
                binding != common_binding
                or runtime_ids != common_runtime_ids
                or transport != common_transport
            ):
                raise ValueError("traces do not share one circuit binding")
            join = _trace_join(evidence.get("join"))
            if join["seatId"] != seat_id:
                raise ValueError("trace join belongs to another circuit seat")
            actual[_trace_receipt_key(join)] += 1
            terminal = _terminal_projection(evidence.get("terminal"), seat_id)
            terminal_global = (
                terminal["seriesCount"],
                terminal["championSeatId"],
            )
            if common_terminal is None:
                common_terminal = terminal_global
            elif common_terminal != terminal_global:
                raise ValueError("traces disagree on the circuit terminal")
            previous = terminal_by_seat.setdefault(seat_id, terminal["seat"])
            if previous != terminal["seat"]:
                raise ValueError("one seat's traces disagree on terminal receipts")
            by_seat[seat_id].append(trace)

        if (
            common_binding is None
            or common_runtime_ids is None
            or common_terminal is None
            or any(not traces for traces in by_seat.values())
            or set(terminal_by_seat) != set(_SEATS)
        ):
            raise ValueError("circuit evidence is missing a player partition")
        terminal = _projected_terminal(
            task,
            common_binding,
            common_terminal[0],
            common_terminal[1],
            [terminal_by_seat[seat_id] for seat_id in _SEATS],
        )
        expected = Counter(
            _public_receipt_key(receipt)
            for seat in terminal["seats"]
            for receipt in seat["receipts"]
        )
        if actual != expected:
            raise ValueError(
                "circuit traces do not Counter-join the terminal per-seat receipts"
            )

        scores: dict[str, tuple[str, float, dict[str, float]]] = {}
        for seat in terminal["seats"]:
            scores[seat["seatId"]] = (
                seat["rewardName"],
                seat["rewardValue"],
                _terminal_metrics(task.data.scenario_id, seat),
            )
        for seat_id, traces in by_seat.items():
            reward_name, reward, metrics = scores[seat_id]
            for trace in traces:
                trace.record_reward(reward_name, reward)
                trace.record_metrics(metrics)



def _rate(wdl: dict[str, int]) -> float:
    played = sum(wdl.values())
    return 0.0 if played == 0 else (wdl["wins"] - wdl["losses"]) / played


def _terminal_metrics(
    scenario_id: str, seat: dict[str, Any]
) -> dict[str, float]:
    splits = seat["splits"]
    pre = splits["roundRobinPreWindow"]
    post = splits["roundRobinPostWindow"]
    playoffs = splits["playoffs"] if scenario_id == "draft-league-v1" else splits["topCut"]
    metrics = {
        "circuit_games_v1": seat["gamesPlayed"],
        "circuit_game_wins_v1": seat["gameWins"],
        "circuit_game_losses_v1": seat["gameLosses"],
        "circuit_game_draws_v1": seat["gameDraws"],
        "circuit_game_differential_v1": seat["gameWins"] - seat["gameLosses"],
        "circuit_game_return_v1": _rate(splits["total"]["games"]),
        "circuit_series_v1": seat["seriesPlayed"],
        "circuit_series_wins_v1": seat["seriesWins"],
        "circuit_series_losses_v1": seat["seriesLosses"],
        "circuit_series_draws_v1": seat["seriesDraws"],
        "circuit_defaulted_turns_v1": seat["defaultedTurns"],
        "circuit_invalid_turns_v1": seat["invalidTurns"],
        "circuit_champion_v1": float(seat["champion"]),
        "circuit_g1_loss_series_v1": seat["g1Losses"],
        "circuit_g1_loss_to_series_win_v1": seat["g1Conversions"],
        "circuit_g1_loss_conversion_rate_v1": (
            0.0 if seat["g1Losses"] == 0
            else seat["g1Conversions"] / seat["g1Losses"]
        ),
    }
    for kind, count in seat["defaults"].items():
        metrics[f"circuit_{kind}_defaults_v1"] = count
    if scenario_id == "draft-league-v1":
        metrics.update(
            {
                "draft_league_final_rr_rank_v1": seat["rank"],
                "draft_league_made_playoffs_v1": float(seat["madePlayoffs"]),
                "draft_league_pre_window_game_return_v1": _rate(pre["games"]),
                "draft_league_pre_window_series_return_v1": _rate(pre["series"]),
                "draft_league_post_window_game_return_v1": _rate(post["games"]),
                "draft_league_post_window_series_return_v1": _rate(post["series"]),
                "draft_league_playoff_game_return_v1": _rate(playoffs["games"]),
                "draft_league_playoff_series_return_v1": _rate(playoffs["series"]),
                "draft_league_transaction_offers_v1": seat["transactionOffers"],
                "draft_league_accepted_transactions_v1": seat["acceptedTransactions"],
                "draft_league_free_agency_swaps_v1": seat["freeAgencySwaps"],
            }
        )
    return metrics


def _validate_config(config: VgcDraftCircuitEnvConfig) -> None:
    if config.retries.max_retries != 0:
        raise ValueError("circuit episodes use zero retries")
    for role in _ROLES:
        spec = getattr(config, role)
        if (
            spec.harness is None
            or spec.harness.id != "null"
            or spec.retries != _NO_RETRIES
        ):
            raise ValueError(f"{role} must use the null harness and zero retries")
        if spec.runtime.type == "subprocess" and not config.debug_allow_subprocess:
            raise ValueError("subprocess runtimes require debug_allow_subprocess")


def _validate_agents(agents: vf.Agents) -> None:
    for role in _PLAYERS:
        if not getattr(agents, role).trainable:
            raise ValueError(f"{role} must remain trainable from setup")
    if agents.referee.trainable:
        raise ValueError("referee must be nontrainable")


def _runtime_layout(
    runtimes: dict[str, Any], debug_allow_subprocess: bool
) -> tuple[str, dict[str, str]]:
    if set(runtimes) != set(_ROLES) or len({id(item) for item in runtimes.values()}) != 9:
        raise ProtocolError("the eight players and referee require distinct runtimes")
    ids: dict[str, str] = {}
    types: list[str] = []
    for role in _ROLES:
        runtime = runtimes[role]
        runtime_id = getattr(getattr(runtime, "info", None), "id", None)
        runtime_type = getattr(runtime, "type", None)
        if not isinstance(runtime_id, str) or not runtime_id:
            raise ProtocolError(f"{role} runtime has no id")
        if not isinstance(runtime_type, str) or not runtime_type:
            raise ProtocolError(f"{role} runtime has no type")
        ids[role] = runtime_id
        types.append(runtime_type)
    if len(set(ids.values())) != 9:
        raise ProtocolError("all nine circuit runtime ids must be distinct")
    if not runtimes["referee"].supports_live_processes:
        raise ProtocolError("referee runtime must support Runtime.open_process")
    if "subprocess" in types:
        if not debug_allow_subprocess:
            raise ProtocolError("subprocess runtimes require debug_allow_subprocess")
        return "debug-subprocess", ids
    return "runtime-process", ids


def _attach_terminal(seats: dict[str, _Seat], terminal: dict[str, Any]) -> None:
    summaries = {item["seatId"]: item for item in terminal["seats"]}
    for seat_id in _SEATS:
        if not seats[seat_id].traces:
            raise ProtocolError(f"{seat_id} completed without a decision trace")
        projection = {
            "seriesCount": terminal["seriesCount"],
            "championSeatId": terminal["championSeatId"],
            "seat": summaries[seat_id],
        }
        for trace in seats[seat_id].traces:
            trace.info["circuit_v1"]["terminal"] = copy.deepcopy(projection)


def _terminal_projection(value: Any, seat_id: str) -> dict[str, Any]:
    projection = _object(value, "trace terminal")
    if set(projection) != {"seriesCount", "championSeatId", "seat"}:
        raise ProtocolError("trace terminal has an unexpected schema")
    _integer(projection.get("seriesCount"), "trace terminal.seriesCount", 1)
    if projection.get("championSeatId") not in _SEATS:
        raise ProtocolError("trace terminal championSeatId is invalid")
    seat = _projected_seat(projection.get("seat"))
    if seat["seatId"] != seat_id:
        raise ProtocolError("trace terminal is bound to another seat")
    return projection


def _projected_seat(value: Any) -> dict[str, Any]:
    seat = _object(value, "projected terminal seat")
    keys = {
        "seatId", "rewardName", "rewardValue", "splits", "seriesPlayed",
        "seriesWins", "seriesLosses", "seriesDraws", "gamesPlayed",
        "gameWins", "gameLosses", "gameDraws", "defaultedTurns",
        "invalidTurns", "defaults", "champion", "rank", "madePlayoffs",
        "transactionOffers", "acceptedTransactions", "freeAgencySwaps",
        "g1Losses", "g1Conversions", "receipts",
    }
    if set(seat) != keys or seat.get("seatId") not in _SEATS:
        raise ProtocolError("projected terminal seat has an unexpected schema")
    if (
        seat.get("rewardName") not in {
            "draft_league_series_return_v1",
            "tournament_series_return_v1",
        }
        or type(seat.get("rewardValue")) not in {int, float}
        or not math.isfinite(float(seat["rewardValue"]))
    ):
        raise ProtocolError("projected terminal reward is invalid")
    numeric = keys - {
        "seatId", "rewardName", "rewardValue", "splits", "defaults",
        "champion", "rank", "madePlayoffs", "receipts",
    }
    for key in numeric:
        _integer(seat.get(key), f"projected terminal seat.{key}")
    if type(seat.get("champion")) is not bool or type(seat.get("madePlayoffs")) is not bool:
        raise ProtocolError("projected terminal flags must be booleans")
    if seat.get("rank") is not None:
        rank = _integer(seat["rank"], "projected terminal rank", 1)
        if rank > 8:
            raise ProtocolError("projected terminal rank is invalid")
    splits_raw = _object(seat.get("splits"), "projected terminal splits")
    split_names = {
        "total", "roundRobinPreWindow", "roundRobinPostWindow", "playoffs", "topCut"
    }
    if set(splits_raw) != split_names:
        raise ProtocolError("projected terminal splits have an unexpected schema")
    splits = {
        name: _split(splits_raw[name], f"projected terminal splits.{name}")
        for name in split_names
    }
    totals = splits["total"]
    if (
        seat["seriesPlayed"] != sum(totals["series"].values())
        or seat["seriesWins"] != totals["series"]["wins"]
        or seat["seriesLosses"] != totals["series"]["losses"]
        or seat["seriesDraws"] != totals["series"]["draws"]
        or seat["gamesPlayed"] != sum(totals["games"].values())
        or seat["gameWins"] != totals["games"]["wins"]
        or seat["gameLosses"] != totals["games"]["losses"]
        or seat["gameDraws"] != totals["games"]["draws"]
    ):
        raise ProtocolError("projected terminal totals are inconsistent")
    defaults = _object(seat.get("defaults"), "projected terminal defaults")
    if set(defaults) != _TURN_KINDS - {"notebook"}:
        raise ProtocolError("projected terminal defaults have an unexpected schema")
    for kind, count in defaults.items():
        _integer(count, f"projected terminal defaults.{kind}")
    receipts_raw = seat.get("receipts")
    if not isinstance(receipts_raw, list):
        raise ProtocolError("projected terminal receipts must be a list")
    receipts = [_public_receipt(item) for item in receipts_raw]
    if any(item["seatId"] != seat["seatId"] for item in receipts):
        raise ProtocolError("projected terminal receipt belongs to another seat")
    if seat["defaultedTurns"] != sum(item["defaulted"] for item in receipts):
        raise ProtocolError("projected terminal default total is inconsistent")
    for kind, count in defaults.items():
        if count != sum(
            item["kind"] == kind and item["defaulted"] for item in receipts
        ):
            raise ProtocolError("projected terminal default partition is inconsistent")
    if seat["invalidTurns"] != sum(not item["accepted"] for item in receipts):
        raise ProtocolError("projected terminal invalid total is inconsistent")
    scenario_id = (
        "draft-league-v1"
        if seat["rewardName"] == "draft_league_series_return_v1"
        else "victory-road-top8-v1"
    )
    name, value = _recompute_return(scenario_id, splits)
    if name != seat["rewardName"] or not math.isclose(
        value, float(seat["rewardValue"]), rel_tol=0.0, abs_tol=1e-12
    ):
        raise ProtocolError("projected terminal reward is inconsistent")
    return {**copy.deepcopy(seat), "splits": splits, "defaults": defaults, "receipts": receipts}


def _projected_terminal(
    task: VgcDraftCircuitTask,
    binding: dict[str, Any],
    series_count: int,
    champion: str,
    seats: list[dict[str, Any]],
) -> dict[str, Any]:
    scenario_id = task.data.scenario_id
    if binding["scenarioId"] != scenario_id:
        raise ProtocolError("projected terminal scenario binding is invalid")
    parsed = [_projected_seat(item) for item in seats]
    if len(parsed) != 8 or {item["seatId"] for item in parsed} != set(_SEATS):
        raise ProtocolError("projected terminal seat partition is incomplete")
    if [item["seatId"] for item in parsed if item["champion"]] != [champion]:
        raise ProtocolError("projected terminal champion is inconsistent")
    expected_count = 31 if scenario_id == "draft-league-v1" else 7
    if series_count != expected_count:
        raise ProtocolError("projected terminal series count is inconsistent")
    component_names = (
        "roundRobinPreWindow", "roundRobinPostWindow", "playoffs", "topCut"
    )
    for seat in parsed:
        for unit in ("series", "games"):
            for result in ("wins", "draws", "losses"):
                component_total = sum(
                    seat["splits"][name][unit][result] for name in component_names
                )
                if seat["splits"]["total"][unit][result] != component_total:
                    raise ProtocolError("projected terminal split components do not sum to total")
        if seat["g1Conversions"] > seat["g1Losses"] or seat["g1Losses"] > seat["seriesPlayed"]:
            raise ProtocolError("projected terminal game-one conversion counts are invalid")
    if scenario_id == "draft-league-v1":
        expected_reward = "draft_league_series_return_v1"
        if any(seat["rewardName"] != expected_reward for seat in parsed):
            raise ProtocolError("projected draft league reward name is invalid")
        for seat in parsed:
            splits = seat["splits"]
            if (
                sum(splits["roundRobinPreWindow"]["series"].values()) != 3
                or sum(splits["roundRobinPostWindow"]["series"].values()) != 4
                or sum(splits["topCut"]["series"].values()) != 0
                or seat["rank"] is None
                or seat["madePlayoffs"] != (seat["rank"] <= 4)
                or seat["transactionOffers"] != 1
                or seat["acceptedTransactions"] > 1
            ):
                raise ProtocolError("projected draft league seat partition is invalid")
        seat_index = {seat["seatId"]: index for index, seat in enumerate(parsed)}
        expected_order = sorted(
            parsed,
            key=lambda seat: (
                -(
                    seat["splits"]["roundRobinPreWindow"]["series"]["wins"]
                    + seat["splits"]["roundRobinPostWindow"]["series"]["wins"]
                ),
                -(
                    seat["splits"]["roundRobinPreWindow"]["games"]["wins"]
                    + seat["splits"]["roundRobinPostWindow"]["games"]["wins"]
                    - seat["splits"]["roundRobinPreWindow"]["games"]["losses"]
                    - seat["splits"]["roundRobinPostWindow"]["games"]["losses"]
                ),
                -(
                    seat["splits"]["roundRobinPreWindow"]["games"]["wins"]
                    + seat["splits"]["roundRobinPostWindow"]["games"]["wins"]
                ),
                seat_index[seat["seatId"]],
            ),
        )
        if any(seat["rank"] != rank for rank, seat in enumerate(expected_order, start=1)):
            raise ProtocolError("projected draft standings do not follow the frozen tiebreak tuple")
        if sum(seat["seriesPlayed"] for seat in parsed) != 62:
            raise ProtocolError("projected draft series partition is incomplete")
        champion_seat = next(seat for seat in parsed if seat["seatId"] == champion)
        if champion_seat["splits"]["playoffs"]["series"]["wins"] != 2:
            raise ProtocolError("projected draft champion did not win two playoff series")
    else:
        expected_reward = "tournament_series_return_v1"
        if any(seat["rewardName"] != expected_reward for seat in parsed):
            raise ProtocolError("projected tournament reward name is invalid")
        for seat in parsed:
            splits = seat["splits"]
            if (
                any(
                    sum(splits[name]["series"].values()) != 0
                    for name in (
                        "roundRobinPreWindow", "roundRobinPostWindow", "playoffs"
                    )
                )
                or seat["rank"] is not None
                or seat["madePlayoffs"]
                or seat["transactionOffers"] != 0
                or seat["acceptedTransactions"] != 0
                or seat["freeAgencySwaps"] != 0
            ):
                raise ProtocolError("projected tournament seat partition is invalid")
        if sum(seat["seriesPlayed"] for seat in parsed) != 14:
            raise ProtocolError("projected tournament series partition is incomplete")
        champion_seat = next(seat for seat in parsed if seat["seatId"] == champion)
        if champion_seat["splits"]["topCut"]["series"]["wins"] != 3:
            raise ProtocolError("projected tournament champion did not win three series")
    return {"seriesCount": series_count, "championSeatId": champion, "seats": parsed}


def _runtime_ids(value: Any) -> dict[str, str]:
    if (
        not isinstance(value, dict)
        or set(value) != set(_ROLES)
        or not all(isinstance(item, str) and item for item in value.values())
        or len(set(value.values())) != 9
    ):
        raise ValueError("circuit runtime_ids are invalid")
    return value


def _binding(value: Any, task: VgcDraftCircuitTask) -> dict[str, Any]:
    binding = _object(value, "trace binding")
    if set(binding) != {
        "episodeId",
        "conditionDigest",
        "scenarioId",
        "seed",
        "configDigest",
        "showdownRevision",
        "jsonlProtocolVersion",
        "circuitProtocolVersion",
        "promptProtocolVersion",
        "matchdayProtocolVersion",
        "battleProtocolVersion",
        "promptRevision",
    }:
        raise ValueError("trace binding has an unexpected schema")
    expected = {
        "conditionDigest": task.data.condition_digest,
        "scenarioId": task.data.scenario_id,
        "seed": task.data.seed,
        "showdownRevision": SHOWDOWN_REVISION,
        "jsonlProtocolVersion": JSONL_PROTOCOL_VERSION,
        "circuitProtocolVersion": CIRCUIT_PROTOCOL_VERSION,
        "promptProtocolVersion": PROMPT_PROTOCOL_VERSION,
        "matchdayProtocolVersion": MATCHDAY_PROTOCOL_VERSION,
        "battleProtocolVersion": BATTLE_PROTOCOL_VERSION,
    }
    if not isinstance(binding.get("episodeId"), str) or not binding["episodeId"]:
        raise ValueError("trace binding episodeId is invalid")
    if any(
        type(binding.get(key)) is not type(item) or binding.get(key) != item
        for key, item in expected.items()
    ):
        raise ValueError("trace binding does not match its task")
    digest = binding.get("configDigest")
    if not isinstance(digest, str) or _SHA256.fullmatch(digest) is None:
        raise ValueError("trace binding configDigest must be lowercase 64-hex")
    if not isinstance(binding.get("promptRevision"), str) or not binding["promptRevision"]:
        raise ValueError("trace binding promptRevision must be nonempty text")
    return binding
