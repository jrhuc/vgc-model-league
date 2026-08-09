from __future__ import annotations

import asyncio
import copy
import re
import uuid
from collections import Counter
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import Field, model_validator
from verifiers import v1 as vf

from .protocol import (
    DEFAULT_REFEREE_EXECUTABLE,
    DEFAULT_REQUEST_TIMEOUT,
    DEFAULT_STDERR_TAIL_BYTES,
    FrozenMatchdayProtocolClient,
    ProtocolBinding,
    ProtocolError,
)
from .scaffold import (
    NOTEBOOK_EVIDENCE_DIAGNOSTIC,
    BetweenGamesReply,
    ScaffoldError,
    parse_between_games_reply,
    parse_playing_reply,
    render_between_games_prompt,
    render_playing_prompt,
    select_action,
)
from .taskset import FrozenMatchdayData, FrozenMatchdayTask

_NULL_HARNESS = vf.HarnessConfig(id="null")
_NO_RETRIES = vf.RetryConfig(max_retries=0)
_ROLES = ("entrant", "opponent", "referee")
_PID_ROLE = {"p1": "entrant", "p2": "opponent"}
_SAFE_ENV = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


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
    referee_request_timeout: float = Field(DEFAULT_REQUEST_TIMEOUT, gt=0)
    debug_allow_subprocess: bool = False

    @model_validator(mode="after")
    def _v0_policy(self) -> FrozenMatchdayEnvConfig:
        _validate_config(self)
        return self


@dataclass
class _Seat:
    pid: str
    agent: Any
    runtime: Any
    history: list[str] = field(default_factory=list)
    game: int | None = None
    traces: list[Any] = field(default_factory=list)


@dataclass(frozen=True)
class _Turn:
    seat: _Seat
    kind: Literal["action", "notebook"]
    prompt: str


@dataclass(frozen=True)
class _PendingAction:
    turn: _Turn
    legal: dict[str, Any]


@dataclass(frozen=True)
class _Notebook:
    trace: Any
    reply: BetweenGamesReply
    expected: str


class FrozenMatchdayEnv(vf.Env[FrozenMatchdayEnvConfig]):
    async def setup(self, agents: vf.Agents) -> None:
        for role in _ROLES:
            getattr(agents, role).trainable = False

    async def run(self, task: vf.Task, agents: vf.Agents) -> None:
        if not isinstance(task, FrozenMatchdayTask):
            raise TypeError("FrozenMatchdayEnv requires FrozenMatchdayTask")
        options = task.options()
        _validate_config(self.config)
        _validate_agents(agents, self.config)

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
            client = await FrozenMatchdayProtocolClient.launch(
                runtimes["referee"],
                executable=self.config.referee_executable,
                showdown_revision=task.data.showdown_revision,
                jsonl_protocol_version=task.data.jsonl_protocol_version,
                matchday_protocol_version=task.data.matchday_protocol_version,
                battle_protocol_version=task.data.battle_protocol_version,
                stderr_tail_bytes=self.config.referee_stderr_tail_bytes,
                shutdown_timeout=self.config.referee_shutdown_timeout,
                request_timeout=self.config.referee_request_timeout,
            )
            await stack.enter_async_context(client)
            started = _object(
                await client.start(
                    episode_id=uuid.uuid4().hex,
                    condition_digest=task.data.condition_digest,
                    expected_config_digest=task.data.expected_config_digest,
                    showdown_revision=task.data.showdown_revision,
                    options=options,
                    matchday_protocol_version=task.data.matchday_protocol_version,
                    battle_protocol_version=task.data.battle_protocol_version,
                ),
                "start result",
            )
            if started.get("started") is not True:
                raise ProtocolError("referee did not start a fresh matchday")
            if client.binding is None:
                raise ProtocolError("referee start did not establish a binding")
            seats = {
                "p1": _Seat("p1", agents.entrant, runtimes["entrant"]),
                "p2": _Seat("p2", agents.opponent, runtimes["opponent"]),
            }
            terminal, accepted = await self._play(
                task,
                client,
                seats,
                client.binding,
                transport,
                runtime_ids,
            )
            self._add_terminal_evidence(seats, terminal, accepted)

    async def _play(
        self,
        task: FrozenMatchdayTask,
        client: FrozenMatchdayProtocolClient,
        seats: dict[str, _Seat],
        binding: ProtocolBinding,
        transport: str,
        runtime_ids: dict[str, str],
    ) -> tuple[dict[str, Any], dict[str, list[dict[str, Any]]]]:
        while True:
            observed = {
                pid: _observation(
                    await client.call("observe", {"pid": pid}), pid, task.data
                )
                for pid in ("p1", "p2")
            }
            phase, game, revision, state_hash = _common_observation(observed)
            for pid, seat in seats.items():
                _update_history(seat, observed[pid])
            if phase == "terminal":
                return _terminal(
                    await client.call("terminal"), task.data
                )
            if phase == "playing":
                await self._playing(
                    task,
                    client,
                    seats,
                    observed,
                    game,
                    revision,
                    state_hash,
                    binding,
                    transport,
                    runtime_ids,
                )
            elif phase == "between-games":
                await self._between_games(
                    task,
                    client,
                    seats,
                    observed,
                    game,
                    revision,
                    state_hash,
                    binding,
                    transport,
                    runtime_ids,
                )
            else:
                raise ProtocolError(f"unsupported referee phase {phase!r}")

    async def _peer_turns(
        self,
        task: FrozenMatchdayTask,
        turns: list[_Turn],
        binding: ProtocolBinding,
        transport: str,
        runtime_ids: dict[str, str],
    ) -> list[tuple[_Turn, Any, str]]:
        active: list[tuple[_Turn, Any, Any]] = []
        async with AsyncExitStack() as stack:
            for turn in turns:
                interaction = await stack.enter_async_context(
                    turn.seat.agent.interaction(task, runtime=turn.seat.runtime)
                )
                trace = interaction.trace
                trace.info["matchday_v0"] = {
                    "pid": turn.seat.pid,
                    "kind": turn.kind,
                    "binding": binding.to_wire(),
                    "transport": transport,
                    "runtime_ids": dict(runtime_ids),
                    "join": None,
                    "diagnostic": None,
                    "carrier": False,
                }
                turn.seat.traces.append(trace)
                active.append((turn, interaction, trace))
            results = await asyncio.gather(
                *(interaction.turn(turn.prompt) for turn, interaction, _ in active),
                return_exceptions=True,
            )
        completed: list[tuple[_Turn, Any, str]] = []
        for (turn, _interaction, trace), result in zip(active, results):
            if isinstance(result, BaseException):
                raise result
            if result.terminated or trace.num_turns != 1:
                raise ScaffoldError("each fresh interaction must return exactly one turn")
            completed.append((turn, trace, result.last_reply))
        return completed

    async def _playing(
        self,
        task: FrozenMatchdayTask,
        client: FrozenMatchdayProtocolClient,
        seats: dict[str, _Seat],
        observed: dict[str, dict[str, Any]],
        game: int,
        revision: int,
        state_hash: str,
        binding: ProtocolBinding,
        transport: str,
        runtime_ids: dict[str, str],
    ) -> None:
        pending: list[_PendingAction] = []
        for pid in ("p1", "p2"):
            observation = observed[pid]
            if not _pending(observation):
                continue
            seat = seats[pid]
            private = _private(
                await client.call("private_evidence", {"pid": pid}), pid
            )
            current_notebook = private["currentNotebook"]
            legal = _legal(
                await client.call("legal_actions", {"pid": pid}), observation
            )
            pending.append(
                _PendingAction(
                    _Turn(
                        seat,
                        "action",
                        render_playing_prompt(
                            observation=observation,
                            request=observation["battle"]["request"],
                            history=seat.history,
                            current_notebook=current_notebook,
                            actions=legal["actions"],
                        ),
                    ),
                    legal,
                )
            )
        if not pending:
            raise ProtocolError("playing phase has no requested seat")
        replies = await self._peer_turns(
            task,
            [item.turn for item in pending],
            binding,
            transport,
            runtime_ids,
        )
        chosen: list[tuple[_PendingAction, Any, dict[str, Any]]] = []
        for item, (_turn, trace, text) in zip(pending, replies):
            actions = item.legal["actions"]
            reply = parse_playing_reply(
                text, [action["number"] for action in actions]
            )
            action = _object(select_action(actions, reply.choice), "selected action")
            chosen.append((item, trace, action))
        for index, (item, trace, action) in enumerate(chosen):
            pid = item.turn.seat.pid
            advanced = _advanced(
                await client.call(
                    "submit",
                    {
                        "pid": pid,
                        "command": action["command"],
                        "expectedRevision": revision,
                        "expectedStateHash": state_hash,
                    },
                )
            )
            if advanced != (index == len(chosen) - 1):
                raise ProtocolError("referee advanced at the wrong action boundary")
            trace.info["matchday_v0"]["join"] = {
                "kind": "action",
                "game": game,
                "pid": pid,
                "battle_revision": item.legal["battleRevision"],
                "battle_state_hash": item.legal["battleStateHash"],
                "command": action["command"],
            }

    async def _between_games(
        self,
        task: FrozenMatchdayTask,
        client: FrozenMatchdayProtocolClient,
        seats: dict[str, _Seat],
        observed: dict[str, dict[str, Any]],
        game: int,
        revision: int,
        state_hash: str,
        binding: ProtocolBinding,
        transport: str,
        runtime_ids: dict[str, str],
    ) -> None:
        completed_game = game - 1
        if completed_game < 1:
            raise ProtocolError("between-games phase has no completed game")
        turns: list[_Turn] = []
        old: dict[str, str] = {}
        for pid in ("p1", "p2"):
            seat = seats[pid]
            private = _private(
                await client.call("private_evidence", {"pid": pid}), pid
            )
            current_notebook = private["currentNotebook"]
            old[pid] = current_notebook
            turns.append(
                _Turn(
                    seat,
                    "notebook",
                    render_between_games_prompt(
                        observation=observed[pid],
                        history=seat.history,
                        current_notebook=current_notebook,
                    ),
                )
            )
        raw = await self._peer_turns(
            task, turns, binding, transport, runtime_ids
        )
        decisions: dict[str, _Notebook] = {}
        for turn, trace, text in raw:
            reply = parse_between_games_reply(text)
            trace.info["matchday_v0"]["diagnostic"] = reply.diagnostic
            expected = reply.notebook if reply.notebook_supplied else old[turn.seat.pid]
            if not isinstance(expected, str):
                raise ScaffoldError("notebook replacement must be text")
            decisions[turn.seat.pid] = _Notebook(trace, reply, expected)
        for index, pid in enumerate(("p1", "p2")):
            decision = decisions[pid]
            params: dict[str, Any] = {
                "pid": pid,
                "expectedRevision": revision,
                "expectedStateHash": state_hash,
            }
            if decision.reply.notebook_supplied:
                params["notebookReplacement"] = decision.reply.notebook
            if _advanced(await client.call("ready_next_game", params)) != (index == 1):
                raise ProtocolError("referee advanced at the wrong notebook boundary")
        for pid in ("p1", "p2"):
            decision = decisions[pid]
            private = _private(
                await client.call("private_evidence", {"pid": pid}), pid
            )
            receipts = [
                receipt
                for receipt in private["intervals"]
                if isinstance(receipt, dict)
                and receipt.get("gameNumber") == completed_game
            ]
            if private["currentNotebook"] != decision.expected or len(receipts) != 1:
                raise ProtocolError("referee notebook receipt does not match the submission")
            receipt = receipts[0]
            supplied = receipt.get("supplied")
            if (
                supplied is not decision.reply.notebook_supplied
                or receipt.get("notebook") != decision.expected
            ):
                raise ProtocolError("referee notebook receipt is invalid")
            notebook_hash = _sha256(
                receipt.get("notebookSha256"), "referee notebook receipt hash"
            )
            decision.trace.info["matchday_v0"]["join"] = {
                "kind": "notebook",
                "game": completed_game,
                "pid": pid,
                "supplied": supplied,
                "notebook_sha256": notebook_hash,
            }

    @staticmethod
    def _add_terminal_evidence(
        seats: dict[str, _Seat],
        terminal: dict[str, Any],
        accepted: dict[str, list[dict[str, Any]]],
    ) -> None:
        for pid in ("p1", "p2"):
            carrier = next(
                (
                    trace
                    for trace in seats[pid].traces
                    if trace.info["matchday_v0"]["kind"] == "action"
                ),
                None,
            )
            if carrier is None:
                raise ProtocolError(f"{pid} has no action reward carrier")
            evidence = carrier.info["matchday_v0"]
            evidence["carrier"] = True
            evidence["terminal"] = copy.deepcopy(terminal)
            evidence["accepted_joins"] = copy.deepcopy(accepted[pid])

    async def finalize(self, task: vf.Task, episode: vf.Episode) -> None:
        if not isinstance(task, FrozenMatchdayTask) or not episode.traces:
            raise ValueError("matchday episode has no decision traces")
        traces_by_pid: dict[str, list[Any]] = {"p1": [], "p2": []}
        actual: Counter[tuple[Any, ...]] = Counter()
        expected: Counter[tuple[Any, ...]] = Counter()
        carriers: dict[str, list[Any]] = {"p1": [], "p2": []}
        common_binding: dict[str, Any] | None = None
        common_terminal: dict[str, Any] | None = None
        common_runtime_ids: dict[str, str] | None = None
        common_transport: str | None = None

        for trace in episode.traces:
            if set(trace.info) != {"matchday_v0"}:
                raise ValueError("trace must carry only matchday_v0 evidence")
            evidence = _object(trace.info["matchday_v0"], "matchday_v0 evidence")
            base_keys = {
                "pid",
                "kind",
                "binding",
                "transport",
                "runtime_ids",
                "join",
                "diagnostic",
                "carrier",
            }
            carrier_value = evidence.get("carrier")
            if type(carrier_value) is not bool:
                raise ValueError("matchday_v0 carrier must be a boolean")
            carrier = carrier_value
            if set(evidence) != base_keys | (
                {"terminal", "accepted_joins"} if carrier else set()
            ):
                raise ValueError("matchday_v0 evidence has an unexpected schema")
            pid = evidence.get("pid")
            if pid not in traces_by_pid or trace.agent.name != _PID_ROLE[pid]:
                raise ValueError("trace role and matchday seat disagree")
            if not trace.ok or trace.num_turns != 1 or trace.agent.trainable:
                raise ValueError("matchday trace is not one successful nontrainable turn")
            if trace.rewards or trace.metrics:
                raise ValueError("matchday trace was scored before episode validation")
            runtime_ids = _runtime_ids(evidence.get("runtime_ids"))
            runtime = trace.agent.runtime
            if (
                runtime is None
                or runtime.borrowed is not True
                or runtime.id != runtime_ids[_PID_ROLE[pid]]
            ):
                raise ValueError("trace runtime does not match its matchday placement")
            binding = _binding(evidence.get("binding"), task.data)
            transport = evidence.get("transport")
            if transport not in {"debug-subprocess", "runtime-process"}:
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
                raise ValueError("traces do not share one matchday binding")
            kind = evidence.get("kind")
            if kind not in {"action", "notebook"}:
                raise ValueError("trace decision kind is invalid")
            join = _join(evidence.get("join"), pid, kind)
            diagnostic = evidence.get("diagnostic")
            if diagnostic not in {None, NOTEBOOK_EVIDENCE_DIAGNOSTIC} or (
                diagnostic is not None and kind != "notebook"
            ):
                raise ValueError("trace notebook diagnostic is invalid")
            if diagnostic is not None and join[-1] is True:
                raise ValueError("invalid notebook evidence cannot be supplied")
            actual[join] += 1
            traces_by_pid[pid].append(trace)
            if carrier:
                if kind != "action":
                    raise ValueError("notebook trace cannot carry reward")
                carriers[pid].append(trace)
                terminal = _public_terminal(evidence["terminal"], task.data)
                if common_terminal is None:
                    common_terminal = terminal
                elif terminal != common_terminal:
                    raise ValueError("reward carriers disagree on the terminal outcome")
                joins = evidence["accepted_joins"]
                if not isinstance(joins, list):
                    raise ValueError("accepted_joins must be a list")
                for item in joins:
                    accepted_key = _join(
                        item, pid, _object(item, "accepted join").get("kind")
                    )
                    expected[accepted_key] += 1

        if (
            any(len(value) != 1 for value in carriers.values())
            or any(not value for value in traces_by_pid.values())
            or common_terminal is None
            or common_binding is None
            or common_runtime_ids is None
            or actual != expected
        ):
            raise ValueError("matchday evidence does not exactly join the terminal receipts")
        result = common_terminal["result"]
        winner = result.get("winner") if result["type"] == "win" else None
        for pid in ("p1", "p2"):
            score = 0.0 if winner is None else (1.0 if winner == pid else -1.0)
            trace = carriers[pid][0]
            trace.record_reward("matchday_outcome_v0", score)
            trace.record_metric("matchday_games_v0", common_terminal["games"])
            trace.record_metric("matchday_result_v0", score)
        """The entrant carrier is the evaluation policy view: v0.3 aggregates
        rewards over trainable traces and falls back to all traces when none
        are, so exactly one flagged trace per episode keeps the native run
        metric the entrant's outcome instead of a two-seat cancellation."""
        carriers["p1"][0].agent.trainable = True



def _null_harness(value: Any) -> bool:
    return (
        getattr(value, "id", None) == "null"
        and value.model_dump(mode="python") == _NULL_HARNESS.model_dump(mode="python")
    )

def _validate_config(config: FrozenMatchdayEnvConfig) -> None:
    if config.retries.max_retries != 0:
        raise ValueError("matchday episodes use zero retries")
    for role in _ROLES:
        agent = getattr(config, role)
        if not _null_harness(agent.harness):
            raise ValueError(f"{role} must use the null harness")
        if agent.retries != _NO_RETRIES:
            raise ValueError(f"{role} must use zero retries")
        if agent.client is not None:
            _safe_client(agent.client, role)
    inherited = config.opponent.model is None and config.opponent.client is None
    pinned = config.opponent.model is not None and config.opponent.client is not None
    if config.opponent_condition == "self_play" and not inherited:
        raise ValueError("self_play opponent identity must inherit from the run")
    if config.opponent_condition == "pinned_opponent" and not pinned:
        raise ValueError("pinned_opponent requires an explicit model and client")


def _safe_client(client: Any, role: str) -> None:
    if not isinstance(client, vf.EvalClientConfig):
        raise TypeError(f"{role} client must be EvalClientConfig")
    url = urlsplit(client.base_url)
    if (
        url.scheme not in {"http", "https"}
        or not url.hostname
        or url.username is not None
        or url.password is not None
        or url.query
        or url.fragment
        or client.headers
        or not _SAFE_ENV.fullmatch(client.api_key_var)
    ):
        raise ValueError(f"{role} client contains unsafe endpoint or credential fields")


def _validate_agents(agents: vf.Agents, config: FrozenMatchdayEnvConfig) -> None:
    identities: dict[str, tuple[str, dict[str, Any]]] = {}
    for role in _ROLES:
        agent = getattr(agents, role)
        if agent.trainable:
            raise ValueError(f"{role} must be nontrainable")
        resolved = agent.config
        if not _null_harness(resolved.harness) or resolved.retries != _NO_RETRIES:
            raise ValueError(f"{role} resolved outside the v0 policy")
        _safe_client(resolved.client, role)
        if not isinstance(resolved.model, str) or not resolved.model:
            raise ValueError(f"{role} model must be resolved")
        identities[role] = (
            resolved.model,
            resolved.client.model_dump(mode="json"),
        )
    if config.opponent_condition == "self_play":
        if identities["entrant"] != identities["opponent"]:
            raise ValueError("self_play requires equal entrant and opponent identities")
    else:
        pinned = (
            config.opponent.model,
            config.opponent.client.model_dump(mode="json"),
        )
        if identities["opponent"] != pinned:
            raise ValueError("resolved opponent differs from its explicit pin")


def _runtime_layout(
    runtimes: dict[str, Any], debug_allow_subprocess: bool
) -> tuple[str, dict[str, str]]:
    if len({id(runtime) for runtime in runtimes.values()}) != 3:
        raise ProtocolError("the three roles require distinct runtimes")
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
    if len(set(ids.values())) != 3:
        raise ProtocolError("the three role runtime ids must be distinct")
    if not runtimes["referee"].supports_live_processes:
        raise ProtocolError("referee runtime must support a live process")
    if "subprocess" in types:
        if not debug_allow_subprocess:
            raise ProtocolError("subprocess runtimes require debug_allow_subprocess")
        return "debug-subprocess", ids
    return "runtime-process", ids


def _object(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ProtocolError(f"{name} must be an object")
    return value


def _integer(value: Any, name: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ProtocolError(f"{name} must be an integer >= {minimum}")
    return value


def _text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ProtocolError(f"{name} must be nonempty text")
    return value


def _score(value: Any, name: str) -> dict[str, int]:
    score = _object(value, name)
    if set(score) != {"p1", "p2", "ties"}:
        raise ProtocolError(f"{name} has an unexpected schema")
    return {pid: _integer(score[pid], f"{name}.{pid}") for pid in score}


def _terminal_games(value: Any, name: str) -> int:
    if type(value) is not int or value not in {2, 3}:
        raise ProtocolError(f"{name} must be exactly 2 or 3")
    return value


def _terminal_consistency(
    score: dict[str, int], result: dict[str, Any], games: int, name: str
) -> None:
    if sum(score.values()) != games:
        raise ProtocolError(f"{name} score does not sum to its games")
    if games == 2 and (
        score["ties"] != 0 or sorted((score["p1"], score["p2"])) != [0, 2]
    ):
        raise ProtocolError(f"{name} two-game terminal must be 2-0")
    expected = (
        {"type": "tie"}
        if score["p1"] == score["p2"]
        else {
            "type": "win",
            "winner": "p1" if score["p1"] > score["p2"] else "p2",
        }
    )
    if result != expected:
        raise ProtocolError(f"{name} result does not agree with its score")


def _sha256(value: Any, name: str) -> str:
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        raise ProtocolError(f"{name} must be lowercase 64-hex")
    return value


def _lines(value: Any, name: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(line, str) for line in value):
        raise ProtocolError(f"{name} must contain text lines")
    return value


def _observation(
    value: Any, pid: str, data: FrozenMatchdayData
) -> dict[str, Any]:
    observation = _object(value, f"{pid} observation")
    if (
        observation.get("protocolVersion") != data.matchday_protocol_version
        or type(observation.get("protocolVersion")) is not int
        or observation.get("battleProtocolVersion") != data.battle_protocol_version
        or type(observation.get("battleProtocolVersion")) is not int
        or observation.get("pid") != pid
    ):
        raise ProtocolError(f"{pid} observation binding is invalid")
    phase = observation.get("phase")
    if phase not in {"playing", "between-games", "terminal"}:
        raise ProtocolError(f"{pid} observation phase is invalid")
    _integer(observation.get("gameNumber"), f"{pid} gameNumber", 1)
    _integer(observation.get("revision"), f"{pid} revision")
    _text(observation.get("stateHash"), f"{pid} stateHash")
    _score(observation.get("score"), f"{pid} score")
    _lines(observation.get("povLines"), f"{pid} povLines")
    if observation.get("terminal") is not (phase == "terminal"):
        raise ProtocolError(f"{pid} terminal flag is invalid")
    battle = observation.get("battle")
    if phase != "playing":
        if battle is not None:
            raise ProtocolError(f"{pid} non-playing observation contains a battle")
        return observation
    battle = _object(battle, f"{pid} battle")
    if (
        battle.get("protocolVersion") != data.battle_protocol_version
        or type(battle.get("protocolVersion")) is not int
        or battle.get("pid") != pid
    ):
        raise ProtocolError(f"{pid} battle binding is invalid")
    _integer(battle.get("revision"), f"{pid} battle revision")
    _text(battle.get("stateHash"), f"{pid} battle stateHash")
    _lines(battle.get("povLines"), f"{pid} battle povLines")
    request = battle.get("request")
    if request is not None and not isinstance(request, dict):
        raise ProtocolError(f"{pid} battle request must be an object or null")
    return observation


def _common_observation(
    observed: dict[str, dict[str, Any]]
) -> tuple[str, int, int, str]:
    p1, p2 = observed["p1"], observed["p2"]
    for key in ("phase", "gameNumber", "revision", "stateHash", "score", "terminal"):
        if p1.get(key) != p2.get(key):
            raise ProtocolError(f"seat observations disagree on {key}")
    return p1["phase"], p1["gameNumber"], p1["revision"], p1["stateHash"]


def _update_history(seat: _Seat, observation: dict[str, Any]) -> None:
    if observation["phase"] == "playing" and observation["gameNumber"] != seat.game:
        if seat.game is not None and observation["gameNumber"] < seat.game:
            raise ProtocolError("game number moved backwards")
        seat.game = observation["gameNumber"]
        seat.history.clear()
    seat.history.extend(observation["povLines"])
    if observation.get("battle") is not None:
        seat.history.extend(observation["battle"]["povLines"])


def _pending(observation: dict[str, Any]) -> bool:
    request = observation["battle"]["request"]
    if request is None:
        return False
    if "wait" in request and not isinstance(request["wait"], bool):
        raise ProtocolError("request wait flag must be boolean")
    return request.get("wait") is not True


def _private(value: Any, pid: str) -> dict[str, Any]:
    private = _object(value, f"{pid} private evidence")
    if private.get("pid") != pid or not isinstance(private.get("currentNotebook"), str):
        raise ProtocolError(f"{pid} private evidence is bound incorrectly")
    if not isinstance(private.get("intervals"), list):
        raise ProtocolError(f"{pid} private intervals must be a list")
    return private


def _legal(value: Any, observation: dict[str, Any]) -> dict[str, Any]:
    legal = _object(value, "legal_actions result")
    battle = observation["battle"]
    expected = {
        "gameNumber": observation["gameNumber"],
        "revision": observation["revision"],
        "stateHash": observation["stateHash"],
        "battleRevision": battle["revision"],
        "battleStateHash": battle["stateHash"],
    }
    if any(type(legal.get(key)) is not type(item) or legal.get(key) != item for key, item in expected.items()):
        raise ProtocolError("legal_actions does not match the observation")
    actions = legal.get("actions")
    if not isinstance(actions, list) or not actions:
        raise ProtocolError("legal_actions must contain a nonempty menu")
    numbers: set[int] = set()
    for raw in actions:
        action = _object(raw, "legal action")
        number = _integer(action.get("number"), "legal action number")
        if number in numbers:
            raise ProtocolError("legal action numbers must be unique")
        numbers.add(number)
        if not isinstance(action.get("label"), str):
            raise ProtocolError("legal action label must be text")
        _text(action.get("command"), "legal action command")
    return legal


def _advanced(value: Any) -> bool:
    advanced = _object(value, "transition result").get("advanced")
    if not isinstance(advanced, bool):
        raise ProtocolError("transition result advanced must be boolean")
    return advanced


def _terminal(
    value: Any, data: FrozenMatchdayData
) -> tuple[dict[str, Any], dict[str, list[dict[str, Any]]]]:
    raw = _object(value, "terminal evidence")
    expected = {
        "protocolVersion": data.matchday_protocol_version,
        "battleProtocolVersion": data.battle_protocol_version,
        "showdownRevision": data.showdown_revision,
        "format": data.format,
        "configDigest": data.expected_config_digest,
    }
    if any(type(raw.get(key)) is not type(item) or raw.get(key) != item for key, item in expected.items()):
        raise ProtocolError("terminal evidence binding is invalid")
    score = _score(raw.get("score"), "terminal score")
    result_raw = _object(raw.get("result"), "terminal result")
    if result_raw.get("type") == "tie" and result_raw.get("winner") is None:
        result = {"type": "tie"}
    elif result_raw.get("type") == "win":
        winner = _object(result_raw.get("winner"), "terminal winner").get("pid")
        if winner not in {"p1", "p2"}:
            raise ProtocolError("terminal winner pid is invalid")
        result = {"type": "win", "winner": winner}
    else:
        raise ProtocolError("terminal result is invalid")
    games = raw.get("games")
    if not isinstance(games, list):
        raise ProtocolError("terminal evidence games must be a list")
    game_count = _terminal_games(len(games), "terminal evidence games")
    _terminal_consistency(score, result, game_count, "terminal evidence")
    accepted = {"p1": [], "p2": []}
    for game_number, game_raw in enumerate(games, start=1):
        game = _object(game_raw, "terminal game")
        actions = game.get("submittedActions")
        if not isinstance(actions, list):
            raise ProtocolError("terminal submittedActions must be a list")
        for action_raw in actions:
            action = _object(action_raw, "terminal submitted action")
            pid = action.get("pid")
            if pid not in accepted:
                raise ProtocolError("terminal action pid is invalid")
            accepted[pid].append(
                {
                    "kind": "action",
                    "game": game_number,
                    "pid": pid,
                    "battle_revision": _integer(
                        action.get("decisionRevision"), "terminal action revision"
                    ),
                    "battle_state_hash": _text(
                        action.get("stateHash"), "terminal action stateHash"
                    ),
                    "command": _text(action.get("command"), "terminal action command"),
                }
            )
    receipts = raw.get("notebookReceipts")
    if not isinstance(receipts, list):
        raise ProtocolError("terminal notebookReceipts must be a list")
    for seat_raw in receipts:
        seat = _object(seat_raw, "terminal receipt seat")
        pid = seat.get("pid")
        intervals = seat.get("intervals")
        if pid not in accepted or not isinstance(intervals, list):
            raise ProtocolError("terminal receipt seat is invalid")
        for receipt_raw in intervals:
            receipt = _object(receipt_raw, "terminal notebook receipt")
            supplied = receipt.get("supplied")
            if not isinstance(supplied, bool):
                raise ProtocolError("terminal receipt supplied must be boolean")
            accepted[pid].append(
                {
                    "kind": "notebook",
                    "game": _integer(
                        receipt.get("gameNumber"), "terminal receipt game", 1
                    ),
                    "pid": pid,
                    "supplied": supplied,
                    "notebook_sha256": _sha256(
                        receipt.get("notebookSha256"), "terminal receipt hash"
                    ),
                }
            )
    terminal = {
        "protocol_version": raw["protocolVersion"],
        "battle_protocol_version": raw["battleProtocolVersion"],
        "showdown_revision": raw["showdownRevision"],
        "format": raw["format"],
        "config_digest": raw["configDigest"],
        "score": score,
        "result": result,
        "games": game_count,
    }
    return terminal, accepted


def _runtime_ids(value: Any) -> dict[str, str]:
    if (
        not isinstance(value, dict)
        or set(value) != set(_ROLES)
        or not all(isinstance(item, str) and item for item in value.values())
        or len(set(value.values())) != 3
    ):
        raise ValueError("matchday runtime_ids are invalid")
    return value


def _binding(value: Any, data: FrozenMatchdayData) -> dict[str, Any]:
    binding = _object(value, "trace binding")
    if set(binding) != {
        "episodeId",
        "conditionDigest",
        "configDigest",
        "showdownRevision",
        "matchdayProtocolVersion",
        "battleProtocolVersion",
    }:
        raise ValueError("trace binding has an unexpected schema")
    expected = {
        "conditionDigest": data.condition_digest,
        "configDigest": data.expected_config_digest,
        "showdownRevision": data.showdown_revision,
        "matchdayProtocolVersion": data.matchday_protocol_version,
        "battleProtocolVersion": data.battle_protocol_version,
    }
    if not isinstance(binding["episodeId"], str) or not binding["episodeId"]:
        raise ValueError("trace binding episodeId is invalid")
    if any(type(binding.get(key)) is not type(item) or binding.get(key) != item for key, item in expected.items()):
        raise ValueError("trace binding does not match the task")
    return binding


def _join(value: Any, pid: str, kind: Any) -> tuple[Any, ...]:
    join = _object(value, "trace join")
    if kind == "action":
        keys = {
            "kind",
            "game",
            "pid",
            "battle_revision",
            "battle_state_hash",
            "command",
        }
        if set(join) != keys or join.get("kind") != kind or join.get("pid") != pid:
            raise ValueError("action join has an unexpected schema")
        return (
            kind,
            _integer(join["game"], "action join game", 1),
            pid,
            _integer(join["battle_revision"], "action join revision"),
            _text(join["battle_state_hash"], "action join stateHash"),
            _text(join["command"], "action join command"),
        )
    if kind == "notebook":
        keys = {"kind", "game", "pid", "supplied", "notebook_sha256"}
        if set(join) != keys or join.get("kind") != kind or join.get("pid") != pid:
            raise ValueError("notebook join has an unexpected schema")
        if not isinstance(join["supplied"], bool):
            raise ValueError("notebook join supplied is invalid")
        return (
            kind,
            _integer(join["game"], "notebook join game", 1),
            pid,
            _sha256(join["notebook_sha256"], "notebook join hash"),
            join["supplied"],
        )
    raise ValueError("trace join kind is invalid")


def _public_terminal(value: Any, data: FrozenMatchdayData) -> dict[str, Any]:
    terminal = _object(value, "public terminal")
    if set(terminal) != {
        "protocol_version",
        "battle_protocol_version",
        "showdown_revision",
        "format",
        "config_digest",
        "score",
        "result",
        "games",
    }:
        raise ValueError("public terminal has an unexpected schema")
    expected = {
        "protocol_version": data.matchday_protocol_version,
        "battle_protocol_version": data.battle_protocol_version,
        "showdown_revision": data.showdown_revision,
        "format": data.format,
        "config_digest": data.expected_config_digest,
    }
    if any(type(terminal.get(key)) is not type(item) or terminal.get(key) != item for key, item in expected.items()):
        raise ValueError("public terminal does not match the task")
    score = _score(terminal.get("score"), "public terminal score")
    games = _terminal_games(terminal.get("games"), "public terminal games")
    result = _object(terminal.get("result"), "public terminal result")
    if result != {"type": "tie"} and (
        set(result) != {"type", "winner"}
        or result.get("type") != "win"
        or result.get("winner") not in {"p1", "p2"}
    ):
        raise ValueError("public terminal result is invalid")
    _terminal_consistency(score, result, games, "public terminal")
    return terminal
