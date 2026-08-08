from __future__ import annotations

import asyncio
import copy
import json
import os
import threading
import tempfile
from pathlib import Path
from contextlib import asynccontextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from typing import Any

import pytest
from verifiers import v1 as vf

import vgc_frozen_matchday_v0.env as env_module
from vgc_frozen_matchday_v0.env import (
    FrozenMatchdayEnv,
    FrozenMatchdayEnvConfig,
    _is_pending,
    _runtime_checks,
    _sanitize_terminal,
    _validate_control_config,
)
from vgc_frozen_matchday_v0.protocol import (
    BATTLE_PROTOCOL_VERSION,
    FROZEN_MATCHDAY_FORMAT,
    JSONL_PROTOCOL_VERSION,
    MATCHDAY_PROTOCOL_VERSION,
    SHOWDOWN_REVISION,
    BoundResponse,
    ProtocolBinding,
    ProtocolError,
)
from vgc_frozen_matchday_v0.scaffold import ScaffoldError
from vgc_frozen_matchday_v0.taskset import (
    FrozenMatchdayData,
    FrozenMatchdayTask,
    FrozenMatchdayTaskConfig,
    FrozenMatchdayTaskset,
    FrozenMatchdayTasksetConfig,
)


def make_fake_trace(agent: FakeAgent, task: FrozenMatchdayTask) -> vf.Trace:
    trace_type = getattr(agent, "trace_type", vf.Trace)
    return trace_type(
        task=vf.TraceTask(type=type(task).__name__, data=task.data),
        agent=vf.AgentInfo(
            config=agent.config,
            runtime={
                "type": agent.runtime.config.type,
                "id": agent.runtime.info.id,
                "borrowed": True,
            },
            name=agent.role,
            trainable=False,
        ),
    )


class FakeSegment:
    def __init__(self, reply: str | None) -> None:
        self.last_reply = reply or ""
        self.terminated = reply is None


class FakeInteraction:
    def __init__(
        self,
        agent: FakeAgent,
        task: FrozenMatchdayTask,
        reply: str | None,
        events: list[tuple[Any, ...]],
    ) -> None:
        self.agent = agent
        self.trace = make_fake_trace(agent, task)
        self.reply = reply
        self.events = events
        self.prompts: list[str] = []
        self.exit_error: BaseException | None = None

    async def turn(self, prompt: str) -> FakeSegment:
        self.prompts.append(prompt)
        self.trace.nodes.append(
            vf.MessageNode(
                parent=None,
                message=vf.AssistantMessage(content=self.reply or ""),
                sampled=True,
            )
        )
        self.agent.turn_count += 1
        self.events.append(("turn", self.agent.role, self.agent.turn_count))
        return FakeSegment(self.reply)


class FakeRuntime:
    supports_live_processes = True

    def __init__(self, name: str, type_: str = "docker", runtime_id: str | None = None) -> None:
        self.name = name
        self.config = SimpleNamespace(type=type_)
        self.info = SimpleNamespace(id=runtime_id or f"runtime-{name}")


class FakeAgent:
    def __init__(
        self,
        role: str,
        runtime: FakeRuntime,
        task: FrozenMatchdayTask,
        replies: list[str | None],
        events: list[tuple[Any, ...]],
    ) -> None:
        self.role = role
        self.runtime = runtime
        self.task = task
        self.replies = list(replies)
        self.events = events
        self.interactions: list[FakeInteraction] = []
        self.provision_count = 0
        self.interaction_count = 0
        self.turn_count = 0
        self.trainable = True
        client = vf.EvalClientConfig(
            base_url="http://fake.invalid/v1", api_key_var="FAKE_KEY"
        )
        self.config = vf.AgentConfig(
            model="fake-model",
            client=client,
            harness=vf.HarnessConfig(id="null"),
            runtime=vf.DockerConfig(),
            retries=vf.RetryConfig(max_retries=0),
        )
        self.ctx = vf.ModelContext(model="fake-model", client=client)

    @asynccontextmanager
    async def provision(self, task: FrozenMatchdayTask):
        assert task is self.task
        self.provision_count += 1
        yield self.runtime

    @asynccontextmanager
    async def interaction(self, task: FrozenMatchdayTask, *, runtime: FakeRuntime):
        if self.role == "referee":
            raise AssertionError("the referee must not have an interaction or Trace")
        assert task is self.task
        assert runtime is self.runtime
        self.interaction_count += 1
        if not self.replies:
            raise AssertionError(f"{self.role} lacks a scripted fresh-interaction reply")
        interaction = FakeInteraction(self, task, self.replies.pop(0), self.events)
        self.interactions.append(interaction)
        error: BaseException | None = None
        try:
            yield interaction
        except BaseException as exc:
            error = exc
            raise
        finally:
            interaction.exit_error = error
            interaction.trace.is_completed = True
            interaction.trace.ok = error is None and interaction.trace.num_turns == 1


class ScriptedReferee:
    def __init__(
        self,
        events: list[tuple[Any, ...]],
        agents: SimpleNamespace,
        *,
        winner: str | None = "p1",
        advance_fault: str | None = None,
        terminal_mutator: Any = None,
    ) -> None:
        self.events = events
        self.agents = agents
        self.winner = winner
        self.game_winners = (
            ["p1", "p1"]
            if winner == "p1"
            else ["p2", "p2"]
            if winner == "p2"
            else ["p1", "p2", None]
        )
        self.advance_fault = advance_fault
        self.terminal_mutator = terminal_mutator
        self.binding: ProtocolBinding | None = None
        self.request_id = 0
        self.phase = "playing"
        self.game = 1
        self.revision = 0
        self.state_hash = "outer-0"
        self.submitted: list[str] = []
        self.ready: list[str] = []
        self.intervals: dict[str, list[dict[str, Any]]] = {"p1": [], "p2": []}
        self.notebooks = {"p1": "p1-initial-note", "p2": "p2-initial-note"}
        self.start_options: dict[str, Any] | None = None
        self.ready_params: dict[str, dict[str, Any]] = {}
        self.pending_outer_lines: dict[str, list[str]] = {"p1": [], "p2": []}
        self.submitted_commands: list[dict[str, Any]] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        return None

    def next_id(self) -> int:
        self.request_id += 1
        return self.request_id

    async def start(
        self,
        *,
        episode_id: str,
        condition_digest: str,
        expected_config_digest: str,
        showdown_revision: str,
        options: dict[str, Any],
        matchday_protocol_version: int,
        battle_protocol_version: int,
    ) -> BoundResponse:
        self.start_options = options
        self.binding = ProtocolBinding(
            episode_id,
            condition_digest,
            expected_config_digest,
            showdown_revision,
            matchday_protocol_version,
            battle_protocol_version,
        )
        return BoundResponse(
            self.next_id(),
            {"started": True, "revision": 0, "stateHash": "outer-0"},
        )

    def score(self) -> dict[str, int]:
        completed = max(0, self.game - 1)
        outcomes = self.game_winners[:completed]
        return {
            "p1": outcomes.count("p1"),
            "p2": outcomes.count("p2"),
            "ties": outcomes.count(None),
        }

    def observation(self, pid: str) -> dict[str, Any]:
        battle = None
        if self.phase == "playing":
            battle = {
                "protocolVersion": 2,
                "pid": pid,
                "seat": {"pid": pid, "name": pid},
                "revision": 0,
                "stateHash": f"battle-{self.game}",
                "request": {"rqid": self.game, "native": f"request-{pid}-g{self.game}"},
                "povLines": [f"|battle-private|{pid}|game-{self.game}"],
                "terminal": False,
            }
        outer_lines = list(self.pending_outer_lines[pid])
        self.pending_outer_lines[pid].clear()
        return {
            "protocolVersion": MATCHDAY_PROTOCOL_VERSION,
            "battleProtocolVersion": 2,
            "pid": pid,
            "phase": self.phase,
            "gameNumber": self.game,
            "score": self.score(),
            "revision": self.revision,
            "stateHash": self.state_hash,
            "povLines": outer_lines,
            "battle": battle,
            "terminal": self.phase == "terminal",
            "pendingSides": "CONTROLLER_PENDING_MARKER",
        }

    def result(self, advanced: bool) -> dict[str, Any]:
        return {
            "advanced": advanced,
            "phase": self.phase,
            "gameNumber": self.game,
            "score": self.score(),
            "revision": self.revision,
            "stateHash": self.state_hash,
            "terminal": self.phase == "terminal",
        }

    def private(self, pid: str) -> dict[str, Any]:
        return {
            "pid": pid,
            "currentNotebook": self.notebooks[pid],
            "intervals": copy.deepcopy(self.intervals[pid]),
        }

    def terminal(self) -> dict[str, Any]:
        games = []
        for game, winner in enumerate(self.game_winners, start=1):
            game_result: dict[str, Any]
            if winner is None:
                game_result = {"type": "tie", "winner": None}
            else:
                game_result = {
                    "type": "win",
                    "winner": {
                        "pid": winner,
                        "name": "GAME_RESULT_NAME_PRIVATE_MARKER",
                    },
                }
            games.append(
                {
                    "protocolVersion": 2,
                    "format": FROZEN_MATCHDAY_FORMAT,
                    "seed": [game, 0, 0, 0],
                    "seats": [
                        {"pid": "p1", "name": "TEAM_PRIVATE_MARKER"},
                        {"pid": "p2", "name": "p2"},
                    ],
                    "result": game_result,
                    "turns": 1,
                    "authoritativeLog": ["OMNISCIENT_LOG_MARKER"],
                    "submittedActions": [
                        {
                            "decisionRevision": 0,
                            "stateHash": f"battle-{game}",
                            "pid": pid,
                            "command": f"command-{pid}-g{game}",
                        }
                        for pid in ("p1", "p2")
                    ],
                }
            )
        assert self.binding is not None
        if self.winner is None:
            result: dict[str, Any] = {"type": "tie", "winner": None}
        else:
            result = {
                "type": "win",
                "winner": {
                    "pid": self.winner,
                    "name": "RESULT_NAME_PRIVATE_MARKER",
                },
            }
        terminal = {
            "protocolVersion": MATCHDAY_PROTOCOL_VERSION,
            "battleProtocolVersion": 2,
            "showdownRevision": SHOWDOWN_REVISION,
            "format": FROZEN_MATCHDAY_FORMAT,
            "configDigest": self.binding.config_digest,
            "registrations": [
                {
                    "pid": "p1",
                    "name": "TEAM_PRIVATE_MARKER",
                    "teamSha256": "TEAM_HASH_MARKER",
                    "constructionSha256": "CONSTRUCTION_PRIVATE_MARKER",
                },
                {
                    "pid": "p2",
                    "name": "p2",
                    "teamSha256": "P2_TEAM_HASH_MARKER",
                    "constructionSha256": "P2_CONSTRUCTION_PRIVATE_MARKER",
                },
            ],
            "gameSeeds": [[game, 1, 2, 3] for game in (1, 2, 3)],
            "score": self.score(),
            "result": result,
            "games": games,
            "notebookReceipts": [
                {
                    "pid": pid,
                    "intervals": [
                        {
                            "gameNumber": record["gameNumber"],
                            "supplied": record["supplied"],
                            "notebookSha256": record["notebookSha256"],
                        }
                        for record in self.intervals[pid]
                    ],
                }
                for pid in ("p1", "p2")
            ],
        }
        if self.terminal_mutator is not None:
            self.terminal_mutator(terminal)
        return terminal

    async def call(self, method: str, params: dict[str, Any] | None = None) -> BoundResponse:
        params = params or {}
        request_id = self.next_id()
        if method == "observe":
            return BoundResponse(request_id, self.observation(params["pid"]))
        if method == "private_evidence":
            return BoundResponse(request_id, self.private(params["pid"]))
        if method == "legal_actions":
            pid = params["pid"]
            number = 11 if pid == "p1" else 22
            return BoundResponse(
                request_id,
                {
                    "protocolVersion": MATCHDAY_PROTOCOL_VERSION,
                    "gameNumber": self.game,
                    "revision": self.revision,
                    "stateHash": self.state_hash,
                    "battleRevision": 0,
                    "battleStateHash": f"battle-{self.game}",
                    "candidateScope": "showdown-accepted-request-derived",
                    "actions": [
                        {
                            "number": number,
                            "label": f"label-{pid}-g{self.game}",
                            "command": f"command-{pid}-g{self.game}",
                            "choices": [0],
                            "privateConstruction": "LEGAL_PRIVATE_MARKER",
                        },
                        {
                            "number": number + 100,
                            "label": f"alternate-{pid}-g{self.game}",
                            "command": (
                                f"UNEXECUTED_PRIVATE_{pid.upper()}_COMMAND_MARKER"
                            ),
                        },
                    ],
                },
            )
        if method == "submit":
            pid = params["pid"]
            assert self.agents.entrant.turn_count == self.game * 2 - 1
            assert self.agents.opponent.turn_count == self.game * 2 - 1
            self.events.append(("submit", pid, self.game))
            self.submitted.append(pid)
            self.submitted_commands.append(dict(params))
            advanced = pid == "p2"
            if self.advance_fault == "early-action" and pid == "p1":
                advanced = True
            if self.advance_fault == "late-action" and pid == "p2":
                advanced = False
            if advanced and pid == "p2":
                final_game = self.game == len(self.game_winners)
                for queued_pid in ("p1", "p2"):
                    marker = "terminal-v2-outer" if final_game else "completed-final"
                    self.pending_outer_lines[queued_pid].append(
                        f"|{marker}|{queued_pid}|game-{self.game}"
                    )
                self.game += 1
                self.revision += 1
                if final_game:
                    self.phase = "terminal"
                else:
                    self.phase = "between-games"
                self.state_hash = f"outer-{self.revision}"
                self.submitted.clear()
            return BoundResponse(request_id, self.result(advanced))
        if method == "ready_next_game":
            pid = params["pid"]
            assert self.agents.entrant.turn_count == self.game * 2 - 2
            assert self.agents.opponent.turn_count == self.game * 2 - 2
            self.events.append(("ready", pid))
            self.ready_params[pid] = dict(params)
            self.ready.append(pid)
            advanced = pid == "p2"
            if self.advance_fault == "early-ready" and pid == "p1":
                advanced = True
            if self.advance_fault == "late-ready" and pid == "p2":
                advanced = False
            if advanced and pid == "p2":
                completed_game = self.game - 1
                for ready_pid in ("p1", "p2"):
                    supplied = "notebookReplacement" in self.ready_params[ready_pid]
                    if supplied:
                        self.notebooks[ready_pid] = self.ready_params[ready_pid][
                            "notebookReplacement"
                        ]
                    notebook = self.notebooks[ready_pid]
                    self.intervals[ready_pid].append(
                        {
                            "gameNumber": completed_game,
                            "supplied": supplied,
                            "notebook": notebook,
                            "notebookSha256": str(completed_game) * 64
                            if ready_pid == "p1"
                            else str(completed_game + 3) * 64,
                        }
                    )
                self.phase = "playing"
                self.revision += 1
                self.state_hash = f"outer-{self.revision}"
            return BoundResponse(request_id, self.result(advanced))
        if method == "terminal":
            return BoundResponse(request_id, self.terminal())
        raise AssertionError(method)


def make_task() -> FrozenMatchdayTask:
    source_dir = Path(tempfile.mkdtemp())
    source = source_dir / "matchdays.json"
    row = {
        "case_id": "case",
        "condition_digest": "a" * 64,
        "expected_config_digest": "b" * 64,
        "showdown_revision": SHOWDOWN_REVISION,
        "format": FROZEN_MATCHDAY_FORMAT,
        "jsonl_protocol_version": JSONL_PROTOCOL_VERSION,
        "matchday_protocol_version": MATCHDAY_PROTOCOL_VERSION,
        "battle_protocol_version": BATTLE_PROTOCOL_VERSION,
        "options": {
            "sealed": {
                "gameSeeds": [[1, 2, 3, 4]],
                "constructions": ["OPTIONS_PRIVATE_MARKER"],
            }
        },
    }
    source.write_text(json.dumps([row]))
    config = FrozenMatchdayTasksetConfig(source=source)
    return next(iter(FrozenMatchdayTaskset(config).load()))


def bare_env(
    *,
    debug_allow_subprocess: bool = False,
    opponent_condition: str = "self_play",
) -> FrozenMatchdayEnv:
    env = object.__new__(FrozenMatchdayEnv)
    opponent = (
        vf.AgentConfig(
            model="fake-model",
            client=vf.EvalClientConfig(
                base_url="http://fake.invalid/v1", api_key_var="FAKE_KEY"
            ),
            harness=vf.HarnessConfig(id="null"),
            runtime=vf.DockerConfig(),
            retries=vf.RetryConfig(max_retries=0),
        )
        if opponent_condition == "pinned_opponent"
        else vf.AgentConfig(
            harness=vf.HarnessConfig(id="null"),
            retries=vf.RetryConfig(max_retries=0),
        )
    )
    env.config = FrozenMatchdayEnvConfig(
        debug_allow_subprocess=debug_allow_subprocess,
        opponent_condition=opponent_condition,
        opponent=opponent,
        referee_executable="/referee",
        referee_stderr_tail_bytes=128,
        referee_shutdown_timeout=0.1,
    )
    env._capture_constructor_seals()
    return env


async def run_script(
    monkeypatch: pytest.MonkeyPatch,
    *,
    entrant_replies: list[str | None] | None = None,
    opponent_replies: list[str | None] | None = None,
    winner: str | None = "p1",
    advance_fault: str | None = None,
    terminal_mutator: Any = None,
    before_run: Any = None,
    capture: dict[str, Any] | None = None,
    opponent_condition: str = "self_play",
) -> tuple[FrozenMatchdayEnv, FrozenMatchdayTask, SimpleNamespace, ScriptedReferee, list[tuple[Any, ...]]]:
    task = make_task()
    events: list[tuple[Any, ...]] = []
    runtimes = {role: FakeRuntime(role) for role in ("entrant", "opponent", "referee")}
    game_count = 3 if winner is None else 2
    default_entrant_replies: list[str | None] = []
    default_opponent_replies: list[str | None] = []
    for game in range(1, game_count + 1):
        default_entrant_replies.append(
            '{"choice":11,"rationale":7,"unknown":"ignored"}'
            if game == 1
            else '{"choice":11}'
        )
        default_opponent_replies.append('{"choice":22}')
        if game < game_count:
            default_entrant_replies.append(
                '{"notebook":"p1-next"}' if game == 1 else '{}'
            )
            default_opponent_replies.append('{}')
    agents = SimpleNamespace()
    agents.entrant = FakeAgent(
        "entrant",
        runtimes["entrant"],
        task,
        entrant_replies if entrant_replies is not None else default_entrant_replies,
        events,
    )
    agents.opponent = FakeAgent(
        "opponent",
        runtimes["opponent"],
        task,
        opponent_replies if opponent_replies is not None else default_opponent_replies,
        events,
    )
    agents.referee = FakeAgent("referee", runtimes["referee"], task, [], events)
    script = ScriptedReferee(
        events,
        agents,
        winner=winner,
        advance_fault=advance_fault,
        terminal_mutator=terminal_mutator,
    )

    async def launch(cls, runtime: FakeRuntime, **kwargs: Any) -> ScriptedReferee:
        assert runtime is runtimes["referee"]
        assert kwargs["executable"] == "/referee"
        return script

    monkeypatch.setattr(
        "vgc_frozen_matchday_v0.env.FrozenMatchdayProtocolClient.launch",
        classmethod(launch),
    )
    env = bare_env(opponent_condition=opponent_condition)
    await env.setup(agents)
    if before_run is not None:
        before_run(env, agents)
    if capture is not None:
        capture.update(env=env, task=task, agents=agents, script=script, events=events)
    await env.run(task, agents)
    return env, task, agents, script, events


def real_trace(
    task: FrozenMatchdayTask, role: str, info: dict[str, Any], trace_id: str
) -> vf.Trace:
    return vf.Trace(
        id=trace_id,
        task=vf.TraceTask(type=type(task).__name__, data=task.data),
        agent=vf.AgentInfo(
            config=vf.AgentConfig(
                model="fake-model",
                client=vf.EvalClientConfig(
                    base_url="http://fake.invalid/v1", api_key_var="FAKE_KEY"
                ),
                harness=vf.HarnessConfig(id="null"),
                runtime=vf.DockerConfig(),
            ),
            runtime={
                "type": "docker",
                "id": info["referee_runtime_ids"][role],
                "borrowed": True,
            },
            name=role,
            trainable=False,
        ),
        nodes=[
            vf.MessageNode(
                parent=None,
                message=vf.AssistantMessage(content="{}"),
                sampled=True,
            )
        ],
        info=copy.deepcopy(info),
        is_completed=True,
        ok=True,
        stop_condition="user_closed",
    )


def episode_from_agents(task: FrozenMatchdayTask, agents: SimpleNamespace) -> vf.Episode:
    traces: list[vf.Trace] = []
    for role in ("entrant", "opponent"):
        for interaction in getattr(agents, role).interactions:
            traces.append(
                real_trace(task, role, interaction.trace.info, interaction.trace.id)
            )
    return vf.Episode(traces=list(reversed(traces)))


@pytest.mark.asyncio
async def test_run_uses_fresh_one_turn_traces_persistent_runtimes_and_sanitized_views(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    terminal_histories: dict[str, list[str]] = {}
    original_update_history = env_module._update_history

    def tracked_update_history(seat: Any, observation: dict[str, Any]) -> None:
        original_update_history(seat, observation)
        if observation["phase"] == "terminal":
            terminal_histories[seat.pid] = list(seat.history)

    monkeypatch.setattr(env_module, "_update_history", tracked_update_history)
    monkeypatch.setenv("FAKE_KEY", "RAW_PROVIDER_CREDENTIAL_MARKER")
    env, task, agents, script, events = await run_script(monkeypatch)
    assert env is not None
    assert [
        agents.entrant.trainable,
        agents.opponent.trainable,
        agents.referee.trainable,
    ] == [False, False, False]
    assert [
        agents.entrant.provision_count,
        agents.opponent.provision_count,
        agents.referee.provision_count,
    ] == [1, 1, 1]
    assert agents.entrant.interaction_count == agents.opponent.interaction_count == 3
    assert agents.referee.interaction_count == 0
    assert all(
        interaction.trace.num_turns == 1
        for agent in (agents.entrant, agents.opponent)
        for interaction in agent.interactions
    )
    assert events[:4] == [
        ("turn", "entrant", 1),
        ("turn", "opponent", 1),
        ("submit", "p1", 1),
        ("submit", "p2", 1),
    ]
    between_turns = events[4:8]
    assert between_turns == [
        ("turn", "entrant", 2),
        ("turn", "opponent", 2),
        ("ready", "p1"),
        ("ready", "p2"),
    ]
    assert script.start_options == task.options
    assert script.ready_params["p1"]["notebookReplacement"] == "p1-next"
    assert "notebookReplacement" not in script.ready_params["p2"]
    assert [submission["command"] for submission in script.submitted_commands] == [
        "command-p1-g1",
        "command-p2-g1",
        "command-p1-g2",
        "command-p2-g2",
    ]
    assert all(set(submission) == {"pid", "command", "expectedRevision", "expectedStateHash"} for submission in script.submitted_commands)

    p1_prompts = [interaction.prompts[0] for interaction in agents.entrant.interactions]
    p2_prompts = [interaction.prompts[0] for interaction in agents.opponent.interactions]
    assert "|completed-final|p1|game-1" in p1_prompts[1]
    assert '"completedGameNumber": 1' in p1_prompts[1]
    assert "|completed-final|p2|game-1" in p2_prompts[1]
    assert "game-1" not in p1_prompts[2]
    assert "game-2" in p1_prompts[2]
    assert script.pending_outer_lines == {"p1": [], "p2": []}
    assert "|terminal-v2-outer|p1|game-2" in terminal_histories["p1"]
    assert "|terminal-v2-outer|p2|game-2" in terminal_histories["p2"]
    assert all("p2-initial-note" not in prompt for prompt in p1_prompts)
    assert all("p1-initial-note" not in prompt for prompt in p2_prompts)
    assert all("CONTROLLER_PENDING_MARKER" not in prompt for prompt in p1_prompts + p2_prompts)
    assert all("LEGAL_PRIVATE_MARKER" not in prompt for prompt in p1_prompts + p2_prompts)

    all_infos = []
    for role, pid in (("entrant", "p1"), ("opponent", "p2")):
        traces = [interaction.trace for interaction in getattr(agents, role).interactions]
        assert [trace.info["referee_kind"] for trace in traces] == [
            "action",
            "notebook",
            "action",
        ]
        assert sum(trace.info["matchday_reward_carrier"] for trace in traces) == 1
        for trace in traces:
            assert trace.info["referee_pid"] == pid
            assert trace.info["referee_transport"] == "distinct-non-subprocess-runtime"
            assert trace.info["referee_runtime_ids"] == {
                "entrant": "runtime-entrant",
                "opponent": "runtime-opponent",
                "referee": "runtime-referee",
            }
            assert isinstance(trace.info["referee_join"], dict)
            assert trace.info["referee_join"]["kind"] == trace.info["referee_kind"]
            assert "referee_terminal" not in trace.info
            assert "action_number" not in trace.info["referee_join"]
            partition = trace.info["referee_role_partition"]
            assert partition["pid"] == pid
            assert all(action["pid"] == pid for action in partition["expected_actions"])
            assert all(
                receipt["pid"] == pid
                for receipt in partition["expected_notebook_receipts"]
            )
            all_infos.append(trace.info)

    p1_trace_json = [
        interaction.trace.model_dump_json()
        for interaction in agents.entrant.interactions
    ]
    p2_trace_json = [
        interaction.trace.model_dump_json()
        for interaction in agents.opponent.interactions
    ]
    assert all("UNEXECUTED_PRIVATE_P2_COMMAND_MARKER" not in raw for raw in p1_trace_json)
    assert all("UNEXECUTED_PRIVATE_P1_COMMAND_MARKER" not in raw for raw in p2_trace_json)
    assert all("command-p2" not in raw for raw in p1_trace_json)
    assert all("command-p1" not in raw for raw in p2_trace_json)
    assert all("RAW_PROVIDER_CREDENTIAL_MARKER" not in raw for raw in p1_trace_json + p2_trace_json)

    sealed_markers = (
        "OPTIONS_PRIVATE_MARKER",
        "CONSTRUCTION_PRIVATE_MARKER",
        "P2_CONSTRUCTION_PRIVATE_MARKER",
        "TEAM_PRIVATE_MARKER",
        "OMNISCIENT_LOG_MARKER",
        "RESULT_NAME_PRIVATE_MARKER",
        "GAME_RESULT_NAME_PRIVATE_MARKER",
        "fake-model",
        "fake.invalid",
        "FAKE_KEY",
    )
    task_data_text = task.data.model_dump_json()
    prompts_text = json.dumps(p1_prompts + p2_prompts)
    info_text = json.dumps(all_infos)
    for marker in sealed_markers:
        assert marker not in task_data_text
        assert marker not in prompts_text
        assert marker not in info_text
    assert "p1-next" not in info_text
    summary = all_infos[0]["referee_terminal_summary"]
    assert set(summary) == {
        "protocol_version",
        "battle_protocol_version",
        "showdown_revision",
        "format",
        "config_digest",
        "score",
        "result",
        "games_count",
        "game_results",
    }
    assert summary["result"] == {"type": "win", "winner": {"pid": "p1"}}
    assert summary["score"] == {"p1": 2, "p2": 0, "ties": 0}
    assert summary["game_results"] == [
        {"game": 1, "result": {"type": "win", "winner": {"pid": "p1"}}},
        {"game": 2, "result": {"type": "win", "winner": {"pid": "p1"}}},
    ]


@pytest.mark.asyncio
async def test_notebook_clear_invalid_retain_diagnostic_and_post_private_equality(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _env, _task, agents, script, events = await run_script(
        monkeypatch,
        entrant_replies=['{"choice":11}', '{"notebook":""}', '{"choice":11}'],
        opponent_replies=['{"choice":22}', '{"notebook":7}', '{"choice":22}'],
    )
    assert script.notebooks == {"p1": "", "p2": "p2-initial-note"}
    assert script.ready_params["p1"]["notebookReplacement"] == ""
    assert "notebookReplacement" not in script.ready_params["p2"]
    assert events.index(("turn", "opponent", 2)) < events.index(("ready", "p1"))
    p1_note = agents.entrant.interactions[1].trace.info
    p2_note = agents.opponent.interactions[1].trace.info
    assert "notebook_evidence_diagnostic" not in p1_note
    assert "notebook_evidence_diagnostic" in p2_note
    assert p1_note["referee_join"]["supplied"] is True
    assert p2_note["referee_join"]["supplied"] is False
    assert p1_note["referee_join"]["game"] == 1
    assert p2_note["referee_join"]["game"] == 1
    assert "p2-initial-note" not in json.dumps(p2_note)


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", ["early-action", "late-action", "early-ready", "late-ready"])
async def test_advance_mismatch_fails_closed(
    monkeypatch: pytest.MonkeyPatch, fault: str
) -> None:
    with pytest.raises(ProtocolError, match="advanced|did not advance"):
        await run_script(monkeypatch, advance_fault=fault)


def test_pending_wait_none_and_malformed_wait() -> None:
    observation = {"battle": {"request": {"rqid": 1}}}
    assert _is_pending(observation) is True
    observation["battle"]["request"] = {"wait": True}
    assert _is_pending(observation) is False
    observation["battle"]["request"] = None
    assert _is_pending(observation) is False
    observation["battle"]["request"] = {"wait": "yes"}
    with pytest.raises(ProtocolError, match="wait"):
        _is_pending(observation)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("winner", "entrant_outcome", "opponent_outcome", "games"),
    [
        ("p1", 1.0, -1.0, 2.0),
        ("p2", -1.0, 1.0, 2.0),
        (None, 0.0, 0.0, 3.0),
    ],
)
async def test_finalize_rewards_exactly_one_action_carrier_per_role_after_validation(
    monkeypatch: pytest.MonkeyPatch,
    winner: str | None,
    entrant_outcome: float,
    opponent_outcome: float,
    games: float,
) -> None:
    env, task, agents, _script, _events = await run_script(monkeypatch, winner=winner)
    episode = episode_from_agents(task, agents)
    await env.finalize(task, episode)
    for role, outcome in (("entrant", entrant_outcome), ("opponent", opponent_outcome)):
        traces = episode.by_agent[role]
        rewarded = [trace for trace in traces if "matchday_outcome_v0" in trace.rewards]
        assert len(rewarded) == 1
        carrier = rewarded[0]
        assert carrier.info["referee_kind"] == "action"
        assert carrier.info["matchday_reward_carrier"] is True
        assert carrier.rewards["matchday_outcome_v0"].score == outcome
        assert carrier.metrics == {
            "matchday_games_v0": games,
            "matchday_result_v0": outcome,
        }
        assert all(
            not trace.rewards and not trace.metrics
            for trace in traces
            if trace is not carrier
        )
        assert all(
            not trace.rewards
            for trace in traces
            if trace.info["referee_kind"] == "notebook"
        )


@pytest.mark.asyncio
async def test_finalize_rejects_shadowed_subclassed_and_aliased_write_destinations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env, task, agents, _script, _events = await run_script(monkeypatch)
    baseline = episode_from_agents(task, agents)
    method_markers: list[str] = []

    class RaisingDict(dict):
        def __setitem__(self, key: object, value: object) -> None:
            raise AssertionError(f"unexpected write to {key!r}")

    for attack in (
        "record-reward-shadow",
        "raising-dict-subclass",
        "aliased-carrier-rewards",
        "metrics-aliased-to-info",
    ):
        episode = baseline.model_copy(deep=True)
        carriers = [
            trace
            for trace in episode.traces
            if trace.info["matchday_reward_carrier"]
        ]
        if attack == "record-reward-shadow":
            object.__setattr__(
                carriers[0],
                "record_reward",
                lambda *_args, **_kwargs: method_markers.append(
                    "INSTANCE_REWARD_SHADOW_MARKER"
                ),
            )
        elif attack == "raising-dict-subclass":
            object.__setattr__(carriers[0], "rewards", RaisingDict())
        elif attack == "aliased-carrier-rewards":
            object.__setattr__(carriers[1], "rewards", carriers[0].rewards)
        else:
            object.__setattr__(carriers[0], "metrics", episode.traces[0].info)
        with pytest.raises((TypeError, ValueError), match="shadow|exact|alias"):
            await env.finalize(task, episode)
        assert all(
            "matchday_outcome_v0" not in trace.rewards for trace in episode.traces
        )
        assert all(not ({"matchday_games_v0", "matchday_result_v0"} & set(trace.metrics)) for trace in episode.traces)
        assert env._consumed_referee_episode_ids == set()
    assert method_markers == []


@pytest.mark.asyncio
async def test_finalize_rolls_back_both_carriers_when_trusted_class_write_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env, task, agents, _script, _events = await run_script(monkeypatch)
    episode = episode_from_agents(task, agents)
    original_record_metric = vf.Trace.record_metric
    write_calls: list[str] = []

    def failing_record_metric(trace: vf.Trace, name: str, value: float) -> None:
        original_record_metric(trace, name, value)
        write_calls.append(name)
        raise RuntimeError("forced class metric write failure")

    monkeypatch.setattr(vf.Trace, "record_metric", failing_record_metric)
    with pytest.raises(RuntimeError, match="forced class metric write failure"):
        await env.finalize(task, episode)
    carriers = [
        trace for trace in episode.traces if trace.info["matchday_reward_carrier"]
    ]
    assert write_calls == ["matchday_games_v0"]
    assert len(carriers) == 2
    assert all(type(trace.rewards) is dict and trace.rewards == {} for trace in carriers)
    assert all(type(trace.metrics) is dict and trace.metrics == {} for trace in carriers)
    assert env._consumed_referee_episode_ids == set()


@pytest.mark.asyncio
async def test_finalize_rejects_binding_role_cardinality_runtime_trainable_and_join_mutations_without_partial_reward(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env, task, agents, _script, _events = await run_script(monkeypatch)
    baseline = episode_from_agents(task, agents)

    def cloned() -> vf.Episode:
        return baseline.model_copy(deep=True)

    mutations: list[tuple[str, Any]] = [
        (
            "binding",
            lambda episode: episode.traces[0].info["referee_binding"].__setitem__(
                "episodeId", "cross-episode"
            ),
        ),
        ("role", lambda episode: setattr(episode.traces[0].agent, "name", "referee")),
        (
            "runtime",
            lambda episode: episode.traces[0].info["referee_runtime_ids"].__setitem__(
                "referee", "runtime-entrant"
            ),
        ),
        ("trainable", lambda episode: setattr(episode.traces[0].agent, "trainable", True)),
        (
            "terminal",
            lambda episode: episode.traces[0].info["referee_role_partition"][
                "expected_actions"
            ].pop(),
        ),
        (
            "cross-seat-action",
            lambda episode: next(
                trace
                for trace in episode.traces
                if trace.agent.name == "entrant"
                and trace.info["referee_kind"] == "action"
            ).info["referee_join"].__setitem__("pid", "p2"),
        ),
        (
            "missing-action",
            lambda episode: episode.traces.remove(
                next(
                    trace
                    for trace in episode.traces
                    if trace.agent.name == "entrant"
                    and trace.info["referee_kind"] == "action"
                    and not trace.info["matchday_reward_carrier"]
                )
            ),
        ),
        (
            "missing-notebook",
            lambda episode: episode.traces.remove(
                next(
                    trace
                    for trace in episode.traces
                    if trace.agent.name == "opponent"
                    and trace.info["referee_kind"] == "notebook"
                )
            ),
        ),
        (
            "duplicate-action",
            lambda episode: episode.traces.append(
                next(
                    trace
                    for trace in episode.traces
                    if trace.agent.name == "opponent"
                    and trace.info["referee_kind"] == "action"
                    and not trace.info["matchday_reward_carrier"]
                ).model_copy(deep=True)
            ),
        ),
        (
            "extra-notebook",
            lambda episode: episode.traces.append(
                next(
                    trace
                    for trace in episode.traces
                    if trace.agent.name == "entrant"
                    and trace.info["referee_kind"] == "notebook"
                ).model_copy(deep=True)
            ),
        ),
        (
            "preexisting-reward",
            lambda episode: episode.traces[-1].record_reward("unexpected", 1.0),
        ),
        (
            "preexisting-reserved-metric",
            lambda episode: episode.traces[-1].record_metric(
                "matchday_games_v0", 99.0
            ),
        ),
    ]
    for label, mutate in mutations:
        episode = cloned()
        mutate(episode)
        with pytest.raises((ValueError, ProtocolError), match="."):
            await env.finalize(task, episode)
        assert all(
            "matchday_outcome_v0" not in trace.rewards for trace in episode.traces
        ), label


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "fault",
    [
        "top-result-extra",
        "score-extra",
        "game-extra",
        "game-result-extra",
        "seed-structural",
        "log-structural",
    ],
)
async def test_terminal_raw_nested_leaks_are_rejected_before_trace_summary(
    monkeypatch: pytest.MonkeyPatch, fault: str
) -> None:
    def mutate(terminal: dict[str, Any]) -> None:
        if fault == "top-result-extra":
            terminal["result"]["winner"]["nestedLeak"] = {
                "private": "RESULT_NESTED_LEAK"
            }
        elif fault == "score-extra":
            terminal["score"]["nestedLeak"] = {"private": "SCORE_NESTED_LEAK"}
        elif fault == "game-extra":
            terminal["games"][0]["nestedLeak"] = {
                "private": "GAME_NESTED_LEAK"
            }
        elif fault == "game-result-extra":
            terminal["games"][0]["result"]["winner"]["nestedLeak"] = {
                "private": "GAME_RESULT_NESTED_LEAK"
            }
        elif fault == "seed-structural":
            terminal["games"][0]["seed"][0] = {"private": "SEED_NESTED_LEAK"}
        else:
            terminal["games"][0]["authoritativeLog"].append(
                {"private": "LOG_NESTED_LEAK"}
            )

    captured: dict[str, Any] = {}
    with pytest.raises(ProtocolError, match="exactly|integer|only text"):
        await run_script(
            monkeypatch, terminal_mutator=mutate, capture=captured
        )
    agents = captured["agents"]
    assert all(
        "referee_terminal_summary" not in interaction.trace.info
        for role in ("entrant", "opponent")
        for interaction in getattr(agents, role).interactions
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", ["score", "game-result", "top-result"])
async def test_terminal_outcome_contradictions_fail_during_sanitization(
    monkeypatch: pytest.MonkeyPatch, fault: str
) -> None:
    def mutate(terminal: dict[str, Any]) -> None:
        if fault == "score":
            terminal["score"] = {"p1": 1, "p2": 1, "ties": 0}
        elif fault == "game-result":
            terminal["games"][1]["result"] = {
                "type": "win",
                "winner": {"pid": "p2", "name": "p2"},
            }
        else:
            terminal["result"] = {
                "type": "win",
                "winner": {"pid": "p2", "name": "p2"},
            }

    with pytest.raises(ProtocolError, match="folded|contradicts"):
        await run_script(monkeypatch, terminal_mutator=mutate)


@pytest.mark.asyncio
async def test_finalize_rebinds_outcome_redundancy_when_all_summary_copies_mutate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env, task, agents, _script, _events = await run_script(monkeypatch)
    baseline = episode_from_agents(task, agents)

    def all_summaries(episode: vf.Episode) -> list[dict[str, Any]]:
        return [trace.info["referee_terminal_summary"] for trace in episode.traces]

    mutations = [
        lambda summary: summary.__setitem__(
            "score", {"p1": 1, "p2": 1, "ties": 0}
        ),
        lambda summary: summary["game_results"][1].__setitem__("game", 3),
        lambda summary: summary["game_results"][1].__setitem__(
            "result", {"type": "win", "winner": {"pid": "p2"}}
        ),
        lambda summary: summary.__setitem__(
            "result", {"type": "win", "winner": {"pid": "p2"}}
        ),
        lambda summary: summary.__setitem__("games_count", 3),
    ]
    for mutate in mutations:
        episode = baseline.model_copy(deep=True)
        for summary in all_summaries(episode):
            mutate(summary)
        with pytest.raises(ValueError, match="terminal|folded|games|result"):
            await env.finalize(task, episode)
        assert all(not trace.rewards for trace in episode.traces)


@pytest.mark.asyncio
async def test_action_failure_is_fail_closed_and_never_rewarded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(ScaffoldError, match="choice"):
        _env, _task, agents, _script, _events = await run_script(
            monkeypatch,
            entrant_replies=['{"rationale":"no authority"}'],
        )


@pytest.mark.asyncio
async def test_optional_provider_failure_is_narrow_v03_fail_closed_limitation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}
    with pytest.raises(ScaffoldError, match="v0.3"):
        await run_script(
            monkeypatch,
            entrant_replies=['{"choice":11}', None],
            capture=captured,
        )
    agents = captured["agents"]
    assert agents.entrant.turn_count == agents.opponent.turn_count == 2
    assert agents.entrant.interactions[1].exit_error is None
    assert agents.opponent.interactions[1].exit_error is None
    assert captured["script"].ready_params == {}


@pytest.mark.asyncio
async def test_runtime_revalidates_actual_self_play_and_mutated_controls_before_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def change_opponent_identity(_env: FrozenMatchdayEnv, agents: Any) -> None:
        client = vf.EvalClientConfig(
            base_url="http://different.invalid/v1", api_key_var="DIFFERENT_KEY"
        )
        agents.opponent.config = agents.opponent.config.model_copy(
            update={"model": "different-model", "client": client}
        )
        agents.opponent.ctx = vf.ModelContext(
            model="different-model", client=client
        )

    captured: dict[str, Any] = {}
    with pytest.raises(ValueError, match="self_play.*actual resolved"):
        await run_script(
            monkeypatch, before_run=change_opponent_identity, capture=captured
        )
    assert captured["agents"].entrant.provision_count == 0
    assert captured["agents"].opponent.provision_count == 0

    def mutate_retry(env: FrozenMatchdayEnv, _agents: Any) -> None:
        env.config.retries.max_retries = 1

    with pytest.raises(ValueError, match="policy changed"):
        await run_script(monkeypatch, before_run=mutate_retry)

    def mutate_agent_harness(_env: FrozenMatchdayEnv, agents: Any) -> None:
        agents.referee.config.harness.env["MUTATED"] = "yes"

    with pytest.raises(ValueError, match="exact null harness"):
        await run_script(monkeypatch, before_run=mutate_agent_harness)

    def mutate_runtime_policy(_env: FrozenMatchdayEnv, agents: Any) -> None:
        agents.opponent.config = agents.opponent.config.model_copy(
            update={"runtime": vf.SubprocessConfig()}
        )

    with pytest.raises(ProtocolError, match="runtime policy type"):
        await run_script(monkeypatch, before_run=mutate_runtime_policy)


@pytest.mark.asyncio
async def test_pinned_opponent_uses_stable_explicit_identity_and_revalidates_mutation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def mutate_constructor_pin(env: FrozenMatchdayEnv, _agents: Any) -> None:
        assert env.config.opponent.client is not None
        env.config.opponent.client.headers["PIN_MUTATION_MARKER"] = "yes"

    captured: dict[str, Any] = {}
    with pytest.raises(ValueError, match="policy changed"):
        await run_script(
            monkeypatch,
            opponent_condition="pinned_opponent",
            before_run=mutate_constructor_pin,
            capture=captured,
        )
    assert captured["agents"].opponent.provision_count == 0

    def change_actual_opponent(_env: FrozenMatchdayEnv, agents: Any) -> None:
        replacement = vf.EvalClientConfig(
            base_url="http://different.invalid/v1", api_key_var="DIFFERENT_KEY"
        )
        agents.opponent.config = agents.opponent.config.model_copy(
            update={"client": replacement}
        )
        agents.opponent.ctx = vf.ModelContext(
            model="fake-model", client=replacement
        )

    with pytest.raises(ValueError, match="pinned_opponent actual resolved"):
        await run_script(
            monkeypatch,
            opponent_condition="pinned_opponent",
            before_run=change_actual_opponent,
        )

    env, task, agents, _script, _events = await run_script(
        monkeypatch, opponent_condition="pinned_opponent"
    )
    episode = episode_from_agents(task, agents)
    await env.finalize(task, episode)
    assert all(
        trace.info["opponent_condition"] == "pinned_opponent"
        for trace in episode.traces
    )

    env2, task2, agents2, _script2, _events2 = await run_script(
        monkeypatch, opponent_condition="pinned_opponent"
    )
    episode2 = episode_from_agents(task2, agents2)
    assert env2.config.opponent.client is not None
    env2.config.opponent.client.headers["MUTATED"] = "yes"
    for trace in episode2.by_agent["opponent"]:
        assert trace.agent.config.client is not None
        trace.agent.config.client.headers["MUTATED"] = "yes"
        assert "MUTATED" not in repr(trace.info)
    with pytest.raises(ValueError, match="headers.*unsupported"):
        await env2.finalize(task2, episode2)
    assert all(not trace.rewards for trace in episode2.traces)


@pytest.mark.asyncio
@pytest.mark.parametrize("opponent_condition", ["self_play", "pinned_opponent"])
async def test_real_v03_plugin_agents_context_and_trace_use_exact_supported_types(
    opponent_condition: str,
) -> None:
    task = make_task()
    source = task.config.source
    assert source is not None
    secret_marker = "FULL_TRACE_PROVIDER_SECRET_MARKER"
    os.environ["VGC_TEST_PROVIDER_KEY"] = secret_marker
    client = vf.EvalClientConfig(
        base_url="http://fake.invalid/v1",
        api_key_var="VGC_TEST_PROVIDER_KEY",
    )
    opponent = (
        vf.AgentConfig(
            model="fake-model",
            client=client,
            harness=vf.HarnessConfig(id="null"),
            retries=vf.RetryConfig(max_retries=0),
        )
        if opponent_condition == "pinned_opponent"
        else vf.AgentConfig(
            harness=vf.HarnessConfig(id="null"),
            retries=vf.RetryConfig(max_retries=0),
        )
    )
    env = FrozenMatchdayEnv(
        FrozenMatchdayEnvConfig(
            taskset=FrozenMatchdayTasksetConfig(
                id="vgc_frozen_matchday_v0", source=source
            ),
            opponent_condition=opponent_condition,
            opponent=opponent,
        )
    )
    resolved_client = env.config.opponent.client if opponent_condition == "pinned_opponent" else client
    assert resolved_client is not None
    ctx = vf.ModelContext(model="fake-model", client=resolved_client)
    completed: list[vf.Trace] = []
    agents = env._episode_agents(ctx, completed, None, None)
    await env.setup(agents)
    captured = env._validate_agents(agents)
    assert all(type(getattr(agents, role).config) is vf.AgentConfig for role in ("entrant", "opponent", "referee"))
    assert all(type(getattr(agents, role).ctx) is vf.ModelContext for role in ("entrant", "opponent", "referee"))

    async with agents.opponent.interaction(task) as interaction:
        trace = interaction.trace
        assert type(trace) is vf.Trace
        assert type(trace.agent.config) is vf.AgentConfig
        assert type(trace.agent.config.client) is vf.EvalClientConfig
        trace.info.update(
            {
                "opponent_condition": opponent_condition,
                "agent_identity_stamps": captured.as_dict(),
                "agent_identity_evidence_seal": env_module._identity_evidence_seal(
                    env._identity_hmac_key,
                    env._constructor_opponent_condition,
                    captured,
                ),
            }
        )
    env._validate_trace_identity_stamp(trace, "opponent")
    assert secret_marker not in trace.model_dump_json()
    del os.environ["VGC_TEST_PROVIDER_KEY"]


@pytest.mark.asyncio
async def test_finalize_rejects_common_runtime_and_trace_identity_mutations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env, task, agents, _script, _events = await run_script(monkeypatch)
    baseline = episode_from_agents(task, agents)

    def mutate_all_referee_stamps(episode: vf.Episode) -> None:
        for trace in episode.traces:
            trace.info["agent_identity_stamps"]["referee"] = (
                "hmac-sha256-v0:" + "0" * 64
            )

    def mutate_all_conditions(episode: vf.Episode) -> None:
        for trace in episode.traces:
            trace.info["opponent_condition"] = "pinned_opponent"

    mutations: list[Any] = [
        mutate_all_referee_stamps,
        mutate_all_conditions,
        lambda episode: [
            trace.info["referee_runtime_ids"].__setitem__(
                "entrant", "mutated-runtime-entrant"
            )
            for trace in episode.traces
        ],
        lambda episode: setattr(episode.traces[0].agent.runtime, "borrowed", False),
        lambda episode: setattr(episode.traces[0].agent.runtime, "id", "mutated-id"),
        lambda episode: [
            setattr(trace.agent.config, "model", "different-model")
            for trace in episode.by_agent["opponent"]
        ],
        lambda episode: next(
            trace
            for trace in episode.traces
            if trace.info["referee_kind"] == "action"
        ).info.__setitem__(
            "notebook_evidence_diagnostic", "invalid_notebook_evidence_retained_v0"
        ),
        lambda episode: next(
            trace
            for trace in episode.traces
            if trace.info["referee_kind"] == "notebook"
        ).info.__setitem__("notebook_evidence_diagnostic", "undeclared-value"),
    ]
    for mutate in mutations:
        episode = baseline.model_copy(deep=True)
        mutate(episode)
        with pytest.raises(
            (ValueError, ProtocolError),
            match="runtime|identity|condition|diagnostic|action trace|self_play",
        ):
            await env.finalize(task, episode)
        assert all(not trace.rewards for trace in episode.traces)


@pytest.mark.asyncio
@pytest.mark.parametrize("boundary", ["run", "finalize"])
@pytest.mark.parametrize("attack", ["nonexact-config", "options_for", "_checked_rows"])
async def test_env_boundaries_use_sealed_exact_task_config_dispatch(
    boundary: str, attack: str
) -> None:
    task = make_task()
    env = bare_env()
    markers: list[str] = []

    def injected(*_args, **_kwargs) -> dict[str, str]:
        markers.append("INJECTED_OPTIONS_MARKER")
        return {"injected": "INJECTED_OPTIONS_MARKER"}

    if attack == "nonexact-config":
        class NonexactConfig(FrozenMatchdayTaskConfig):
            def options_for(self, data: FrozenMatchdayData) -> dict[str, str]:
                return injected(data)

        replacement = NonexactConfig.model_validate(
            task.config.model_dump(mode="python")
        )
        object.__setattr__(task, "config", replacement)
        expected_error = TypeError
        expected_message = "exact FrozenMatchdayTaskConfig"
    else:
        object.__setattr__(task.config, attack, injected)
        expected_error = ValueError
        expected_message = "unexpected copied state"

    with pytest.raises(expected_error, match=expected_message):
        if boundary == "run":
            await env.run(task, SimpleNamespace())
        else:
            await env.finalize(task, vf.Episode())
    assert markers == []


@pytest.mark.asyncio
async def test_exact_task_and_v03_controller_types_reject_subclass_overrides(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task = make_task()
    env = bare_env()

    class OverridingTask(FrozenMatchdayTask):
        @property
        def options(self) -> dict[str, Any]:
            return {"injected": "SUBCLASS_OPTIONS_MARKER"}

    overriding_task = OverridingTask(task.data, task.config)
    with pytest.raises(TypeError, match="exact FrozenMatchdayTask"):
        await env.run(overriding_task, SimpleNamespace())
    with pytest.raises(TypeError, match="exact FrozenMatchdayTask"):
        await env.finalize(overriding_task, vf.Episode())

    class LyingEnvConfig(FrozenMatchdayEnvConfig):
        def model_dump(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
            return {}

    with pytest.raises(TypeError, match="exact supported v0.3 concrete type"):
        FrozenMatchdayEnv(LyingEnvConfig())

    class LyingClient(vf.EvalClientConfig):
        def model_dump(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
            return {
                "base_url": "http://fake.invalid/v1",
                "api_key_var": "FAKE_KEY",
                "headers": {},
                "type": "eval",
            }

    pinned = FrozenMatchdayEnvConfig(
        opponent_condition="pinned_opponent",
        opponent=vf.AgentConfig(
            model="fake-model",
            client=vf.EvalClientConfig(
                base_url="http://fake.invalid/v1", api_key_var="FAKE_KEY"
            ),
            harness=vf.HarnessConfig(id="null"),
            retries=vf.RetryConfig(max_retries=0),
        ),
    )
    pinned.opponent.client = LyingClient(
        base_url="http://fake.invalid/v1", api_key_var="FAKE_KEY"
    )
    with pytest.raises(TypeError, match="exact supported v0.3 concrete type"):
        FrozenMatchdayEnv(pinned)

    def client_override(_env: FrozenMatchdayEnv, agents: Any) -> None:
        lying_client = LyingClient(
            base_url="http://fake.invalid/v1", api_key_var="FAKE_KEY"
        )
        agents.entrant.config = agents.entrant.config.model_copy(
            update={"client": lying_client}
        )
        agents.entrant.ctx = vf.ModelContext(
            model="fake-model", client=lying_client
        )

    with pytest.raises(TypeError, match="exact supported v0.3 concrete type"):
        await run_script(monkeypatch, before_run=client_override)

    class LyingAgentConfig(vf.AgentConfig):
        pass

    def agent_override(_env: FrozenMatchdayEnv, agents: Any) -> None:
        agents.entrant.config = LyingAgentConfig.model_validate(
            agents.entrant.config.model_dump(mode="python")
        )

    with pytest.raises(TypeError, match="exact supported v0.3 concrete type"):
        await run_script(monkeypatch, before_run=agent_override)

    class LyingModelContext(vf.ModelContext):
        pass

    def context_override(_env: FrozenMatchdayEnv, agents: Any) -> None:
        agents.entrant.ctx = LyingModelContext(
            model=agents.entrant.ctx.model,
            client=agents.entrant.ctx.client,
        )

    with pytest.raises(TypeError, match="exact v0.3 ModelContext"):
        await run_script(monkeypatch, before_run=context_override)

    class LyingTrace(vf.Trace):
        def model_dump(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
            return {}

    def trace_override(_env: FrozenMatchdayEnv, agents: Any) -> None:
        agents.entrant.trace_type = LyingTrace

    with pytest.raises(TypeError, match="exact v0.3 Trace"):
        await run_script(monkeypatch, before_run=trace_override)

    real_env, real_task, agents, _script, _events = await run_script(monkeypatch)
    episode = episode_from_agents(real_task, agents)
    original = episode.traces[0]
    episode.traces[0] = LyingTrace.model_construct(**original.__dict__)
    with pytest.raises(TypeError, match="exact v0.3 Trace"):
        await real_env.finalize(real_task, episode)

    client_episode = episode_from_agents(real_task, agents)
    trace_client = LyingClient(
        base_url="http://fake.invalid/v1", api_key_var="FAKE_KEY"
    )
    client_episode.traces[0].agent.config.client = trace_client
    with pytest.raises(TypeError, match="exact supported v0.3 concrete type"):
        await real_env.finalize(real_task, client_episode)


@pytest.mark.asyncio
async def test_finalize_rejects_episode_subclass_grouping_and_nonlist_traces(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env, task, agents, _script, _events = await run_script(monkeypatch)
    actual = episode_from_agents(task, agents)
    detached = actual.model_copy(deep=True).traces

    class LyingEpisode(vf.Episode):
        @property
        def by_agent(self) -> dict[str, list[vf.Trace]]:
            return {
                "entrant": [trace for trace in detached if trace.agent.name == "entrant"],
                "opponent": [trace for trace in detached if trace.agent.name == "opponent"],
            }

    lying = LyingEpisode.model_construct(
        id=actual.id,
        env=actual.env,
        ok=actual.ok,
        errors=actual.errors,
        traces=actual.traces,
    )
    with pytest.raises(TypeError, match="exact v0.3 Episode"):
        await env.finalize(task, lying)
    assert all(not trace.rewards and not trace.metrics for trace in actual.traces)
    assert all(not trace.rewards and not trace.metrics for trace in detached)
    assert env._consumed_referee_episode_ids == set()

    nonlist = actual.model_copy(deep=True)
    object.__setattr__(nonlist, "traces", tuple(nonlist.traces))
    with pytest.raises(ValueError, match="exact decision Trace list"):
        await env.finalize(task, nonlist)
    assert all(not trace.rewards and not trace.metrics for trace in nonlist.traces)
    assert env._consumed_referee_episode_ids == set()


@pytest.mark.asyncio
async def test_client_config_never_serializes_raw_authentication(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for client in (
        vf.EvalClientConfig(
            base_url="http://fake.invalid/v1",
            api_key_var="FAKE_KEY",
            headers={"Authorization": "RAW_HEADER_SECRET_MARKER"},
        ),
        vf.EvalClientConfig(
            base_url="https://user:RAW_URL_SECRET_MARKER@example.invalid/v1",
            api_key_var="FAKE_KEY",
        ),
        vf.EvalClientConfig(
            base_url="https://example.invalid/v1?token=RAW_QUERY_SECRET_MARKER",
            api_key_var="FAKE_KEY",
        ),
    ):
        pinned = FrozenMatchdayEnvConfig(
            opponent_condition="pinned_opponent",
            opponent=vf.AgentConfig(
                model="fake-model",
                client=client,
                harness=vf.HarnessConfig(id="null"),
                retries=vf.RetryConfig(max_retries=0),
            ),
        )
        with pytest.raises(ValueError, match="headers|credential-free"):
            FrozenMatchdayEnv(pinned)

    def raw_header_at_run(_env: FrozenMatchdayEnv, agents: Any) -> None:
        bad = vf.EvalClientConfig(
            base_url="http://fake.invalid/v1",
            api_key_var="FAKE_KEY",
            headers={"X-Token": "RUN_RAW_SECRET_MARKER"},
        )
        agents.entrant.config = agents.entrant.config.model_copy(
            update={"client": bad}
        )
        agents.entrant.ctx = vf.ModelContext(
            model="fake-model", client=bad
        )

    with pytest.raises(ValueError, match="headers.*unsupported"):
        await run_script(monkeypatch, before_run=raw_header_at_run)


@pytest.mark.asyncio
async def test_complete_episode_seal_rejects_coherent_wholesale_rewrites(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env, task, agents, _script, _events = await run_script(monkeypatch)
    baseline = episode_from_agents(task, agents)

    def rewrite_outcome(episode: vf.Episode) -> None:
        for trace in episode.traces:
            summary = trace.info["referee_terminal_summary"]
            summary["score"] = {"p1": 0, "p2": 2, "ties": 0}
            summary["result"] = {"type": "win", "winner": {"pid": "p2"}}
            summary["game_results"] = [
                {"game": game, "result": {"type": "win", "winner": {"pid": "p2"}}}
                for game in (1, 2)
            ]

    def rewrite_actions(episode: vf.Episode) -> None:
        for trace in episode.traces:
            partition = trace.info["referee_role_partition"]
            for action in partition["expected_actions"]:
                action["command"] += "-COHERENT_ACTION_REWRITE"
            if trace.info["referee_kind"] == "action":
                trace.info["referee_join"]["command"] += "-COHERENT_ACTION_REWRITE"

    def rewrite_receipts(episode: vf.Episode) -> None:
        for trace in episode.traces:
            partition = trace.info["referee_role_partition"]
            for receipt in partition["expected_notebook_receipts"]:
                receipt["notebook_sha256"] = "f" * 64
            if trace.info["referee_kind"] == "notebook":
                trace.info["referee_join"]["notebook_sha256"] = "f" * 64

    def rewrite_carriers(episode: vf.Episode) -> None:
        actions = [
            trace
            for trace in episode.by_agent["entrant"]
            if trace.info["referee_kind"] == "action"
        ]
        for trace in actions:
            trace.info["matchday_reward_carrier"] = False
        actions[0].info["matchday_reward_carrier"] = True

    def rewrite_runtime(episode: vf.Episode) -> None:
        for trace in episode.traces:
            trace.info["referee_runtime_ids"]["entrant"] = "rewritten-runtime-entrant"
        for trace in episode.by_agent["entrant"]:
            assert trace.agent.runtime is not None
            trace.agent.runtime.id = "rewritten-runtime-entrant"

    def rewrite_trace_ids(episode: vf.Episode) -> None:
        for index, trace in enumerate(episode.traces):
            trace.id = f"coherently-rewritten-trace-{index}"

    def rewrite_historical_agent_config(episode: vf.Episode) -> None:
        for trace in episode.traces:
            trace.agent.config.max_turns = 999

    for mutate in (
        rewrite_outcome,
        rewrite_actions,
        rewrite_receipts,
        rewrite_carriers,
        rewrite_runtime,
        rewrite_trace_ids,
        rewrite_historical_agent_config,
    ):
        episode = baseline.model_copy(deep=True)
        mutate(episode)
        with pytest.raises(ValueError, match="episode evidence seal"):
            await env.finalize(task, episode)
        assert all(not trace.rewards for trace in episode.traces)

    copied = baseline.model_copy(deep=True)
    p1_actions = [
        trace
        for trace in copied.by_agent["entrant"]
        if trace.info["referee_kind"] == "action"
    ]
    p1_actions[1].info = copy.deepcopy(p1_actions[0].info)
    with pytest.raises(ValueError, match="cover|carrier|evidence|common"):
        await env.finalize(task, copied)


@pytest.mark.asyncio
async def test_same_env_concurrent_episodes_have_distinct_seals_and_finalize(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env = bare_env()
    scripts: dict[str, ScriptedReferee] = {}

    def prepared(suffix: str) -> tuple[FrozenMatchdayTask, SimpleNamespace]:
        task = make_task()
        events: list[tuple[Any, ...]] = []
        runtimes = {
            role: FakeRuntime(role, runtime_id=f"runtime-{suffix}-{role}")
            for role in ("entrant", "opponent", "referee")
        }
        agents = SimpleNamespace(
            entrant=FakeAgent(
                "entrant",
                runtimes["entrant"],
                task,
                ['{"choice":11}', '{}', '{"choice":11}'],
                events,
            ),
            opponent=FakeAgent(
                "opponent",
                runtimes["opponent"],
                task,
                ['{"choice":22}', '{}', '{"choice":22}'],
                events,
            ),
            referee=FakeAgent("referee", runtimes["referee"], task, [], events),
        )
        scripts[runtimes["referee"].info.id] = ScriptedReferee(events, agents)
        return task, agents

    first_task, first_agents = prepared("first")
    second_task, second_agents = prepared("second")

    async def launch(
        cls, runtime: FakeRuntime, **_kwargs: Any
    ) -> ScriptedReferee:
        return scripts[runtime.info.id]

    monkeypatch.setattr(
        "vgc_frozen_matchday_v0.env.FrozenMatchdayProtocolClient.launch",
        classmethod(launch),
    )
    await asyncio.gather(env.setup(first_agents), env.setup(second_agents))
    await asyncio.gather(
        env.run(first_task, first_agents),
        env.run(second_task, second_agents),
    )
    first = episode_from_agents(first_task, first_agents)
    second = episode_from_agents(second_task, second_agents)
    first_episode_id = first.traces[0].info["referee_binding"]["episodeId"]
    second_episode_id = second.traces[0].info["referee_binding"]["episodeId"]
    first_seal = first.traces[0].info["episode_evidence_seal"]
    second_seal = second.traces[0].info["episode_evidence_seal"]
    assert first_episode_id != second_episode_id
    assert first_seal != second_seal

    await asyncio.gather(
        env.finalize(first_task, first),
        env.finalize(second_task, second),
    )
    assert type(env._consumed_referee_episode_ids) is set
    assert env._consumed_referee_episode_ids == {
        first_episode_id,
        second_episode_id,
    }
    for episode in (first, second):
        carriers = [
            trace
            for trace in episode.traces
            if trace.info["matchday_reward_carrier"]
        ]
        assert len(carriers) == 2
        assert all("matchday_outcome_v0" in trace.rewards for trace in carriers)


@pytest.mark.asyncio
async def test_signed_referee_episode_cannot_be_finalized_twice(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env, task, agents, _script, _events = await run_script(monkeypatch)
    baseline = episode_from_agents(task, agents)
    first = baseline.model_copy(deep=True)
    replay = baseline.model_copy(deep=True)
    episode_id = first.traces[0].info["referee_binding"]["episodeId"]
    assert episode_id != task.data.case_id
    await env.finalize(task, first)
    with pytest.raises(ValueError, match="already finalized"):
        await env.finalize(task, replay)
    assert env._consumed_referee_episode_ids == {episode_id}
    assert all(not trace.rewards for trace in replay.traces)


def test_runtime_identity_live_process_and_subprocess_policy() -> None:
    distinct = {role: FakeRuntime(role) for role in ("entrant", "opponent", "referee")}
    label, ids, types = _runtime_checks(distinct, allow_subprocess=False)
    assert label == "distinct-non-subprocess-runtime"
    assert len(set(ids.values())) == 3
    assert types == {role: "docker" for role in ("entrant", "opponent", "referee")}

    shared = FakeRuntime("shared")
    with pytest.raises(ProtocolError, match="must be distinct"):
        _runtime_checks(
            {"entrant": shared, "opponent": FakeRuntime("other"), "referee": shared},
            allow_subprocess=False,
        )
    missing_id = {role: FakeRuntime(role) for role in ("entrant", "opponent", "referee")}
    missing_id["entrant"].info.id = ""
    with pytest.raises(ProtocolError, match="nonempty runtime info id"):
        _runtime_checks(missing_id, allow_subprocess=False)
    same_id = {role: FakeRuntime(role, runtime_id="shared-id") for role in ("entrant", "opponent", "referee")}
    with pytest.raises(ProtocolError, match="shared runtime id"):
        _runtime_checks(same_id, allow_subprocess=False)
    heterogeneous = {
        "entrant": FakeRuntime("entrant", "docker"),
        "opponent": FakeRuntime("opponent", "modal"),
        "referee": FakeRuntime("referee", "docker"),
    }
    with pytest.raises(ProtocolError, match="heterogeneous"):
        _runtime_checks(heterogeneous, allow_subprocess=False)
    unsupported = {role: FakeRuntime(role) for role in ("entrant", "opponent", "referee")}
    unsupported["opponent"].supports_live_processes = False
    with pytest.raises(ProtocolError, match="support live processes"):
        _runtime_checks(unsupported, allow_subprocess=False)
    subprocesses = {
        role: FakeRuntime(role, "subprocess")
        for role in ("entrant", "opponent", "referee")
    }
    with pytest.raises(ProtocolError, match="debug/test-only"):
        _runtime_checks(subprocesses, allow_subprocess=False)
    label, _ids, _types = _runtime_checks(subprocesses, allow_subprocess=True)
    assert label == "debug-subprocess"


def test_exact_null_harness_zero_retry_and_opponent_condition_config() -> None:
    config = FrozenMatchdayEnvConfig()
    _validate_control_config(config)

    bad_harness = FrozenMatchdayEnvConfig(
        entrant=vf.AgentConfig(
            harness=vf.HarnessConfig(id="null", env={"EXTRA": "not exact"})
        )
    )
    with pytest.raises(ValueError, match="exact.*null harness"):
        _validate_control_config(bad_harness)

    retried = FrozenMatchdayEnvConfig(
        opponent=vf.AgentConfig(
            harness=vf.HarnessConfig(id="null"),
            retries=vf.RetryConfig(max_retries=1),
        )
    )
    with pytest.raises(ValueError, match="retry counts"):
        _validate_control_config(retried)

    inherited_but_labeled_pinned = FrozenMatchdayEnvConfig(
        opponent_condition="pinned_opponent"
    )
    with pytest.raises(ValueError, match="explicitly pinned"):
        _validate_control_config(inherited_but_labeled_pinned)

    pinned = FrozenMatchdayEnvConfig(
        opponent_condition="pinned_opponent",
        opponent=vf.AgentConfig(
            harness=vf.HarnessConfig(id="null"),
            model="comparison-model",
            client=vf.EvalClientConfig(
                base_url="http://comparison.invalid/v1",
                api_key_var="COMPARISON_KEY",
            ),
        ),
    )
    _validate_control_config(pinned)

    mislabeled_self_play = FrozenMatchdayEnvConfig(
        opponent=vf.AgentConfig(
            harness=vf.HarnessConfig(id="null"),
            model="comparison-model",
            client=vf.EvalClientConfig(
                base_url="http://comparison.invalid/v1",
                api_key_var="COMPARISON_KEY",
            ),
        ),
    )
    with pytest.raises(ValueError, match="self_play"):
        _validate_control_config(mislabeled_self_play)


@pytest.mark.asyncio
async def test_exact_null_harness_fresh_interactions_do_not_replay_prior_evidence() -> None:
    requests: list[dict[str, Any]] = []

    class ProviderHandler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers["Content-Length"])
            request = json.loads(self.rfile.read(length))
            requests.append(request)
            content = (
                '{"choice":1,"rationale":"OLD_RATIONALE_MARKER"}'
                if len(requests) == 1
                else '{"choice":2}'
            )
            response = {
                "id": f"mock-{len(requests)}",
                "object": "chat.completion",
                "created": 0,
                "model": "mock-model",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": content},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 1,
                    "completion_tokens": 1,
                    "total_tokens": 2,
                },
            }
            encoded = json.dumps(response).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, format: str, *args: Any) -> None:
            return None

    provider = ThreadingHTTPServer(("127.0.0.1", 0), ProviderHandler)
    thread = threading.Thread(target=provider.serve_forever, daemon=True)
    thread.start()
    old_key = os.environ.get("FRESH_INTERACTION_MOCK_KEY")
    os.environ["FRESH_INTERACTION_MOCK_KEY"] = "test-key"
    try:
        task = vf.Task(vf.TaskData(prompt=None))
        agent = vf.Agent(
            vf.AgentConfig(
                model="mock-model",
                harness=vf.HarnessConfig(id="null"),
                client=vf.EvalClientConfig(
                    base_url=f"http://127.0.0.1:{provider.server_port}/v1",
                    api_key_var="FRESH_INTERACTION_MOCK_KEY",
                ),
                retries=vf.RetryConfig(max_retries=0),
            )
        )
        async with agent.provision(task) as runtime:
            async with agent.interaction(task, runtime=runtime) as first:
                first_segment = await first.turn(
                    "FIRST_EXPLICIT_PROMPT NOTEBOOK_PRIVATE_MARKER"
                )
                assert first_segment.last_reply.endswith("}")
            async with agent.interaction(task, runtime=runtime) as second:
                second_segment = await second.turn("SECOND_EXPLICIT_PROMPT_ONLY")
                assert second_segment.last_reply == '{"choice":2}'
        assert len(requests) == 2
        assert requests[0]["messages"] == [
            {
                "role": "user",
                "content": "FIRST_EXPLICIT_PROMPT NOTEBOOK_PRIVATE_MARKER",
            }
        ]
        assert requests[1]["messages"] == [
            {"role": "user", "content": "SECOND_EXPLICIT_PROMPT_ONLY"}
        ]
        second_wire = json.dumps(requests[1])
        for forbidden in (
            "FIRST_EXPLICIT_PROMPT",
            "NOTEBOOK_PRIVATE_MARKER",
            "OLD_RATIONALE_MARKER",
        ):
            assert forbidden not in second_wire
    finally:
        provider.shutdown()
        provider.server_close()
        thread.join(timeout=2)
        if old_key is None:
            os.environ.pop("FRESH_INTERACTION_MOCK_KEY", None)
        else:
            os.environ["FRESH_INTERACTION_MOCK_KEY"] = old_key
