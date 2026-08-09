from __future__ import annotations

import copy
import hashlib
import json
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from pydantic_config import cli as parse_cli
from pydantic_config.cli import ConfigFileError
from verifiers import v1 as vf
from verifiers.v1.cli.resolve import narrow_config, with_positional_taskset
from verifiers.v1.configs.cli.eval import EvalConfig
from verifiers.v1.utils.platform import _run_metrics

import vgc_frozen_matchday_v0.env as env_module
from vgc_frozen_matchday_v0.env import FrozenMatchdayEnv, FrozenMatchdayEnvConfig
from vgc_frozen_matchday_v0.protocol import (
    BATTLE_PROTOCOL_VERSION,
    FROZEN_MATCHDAY_FORMAT,
    JSONL_PROTOCOL_VERSION,
    MATCHDAY_PROTOCOL_VERSION,
    SHOWDOWN_REVISION,
    ProtocolBinding,
    ProtocolError,
)
from vgc_frozen_matchday_v0.scaffold import (
    FORMAT_AUTHORITY_NOTICE,
    NOTEBOOK_EVIDENCE_DIAGNOSTIC,
    ScaffoldError,
)
from vgc_frozen_matchday_v0.taskset import (
    FrozenMatchdayTask,
    FrozenMatchdayTasksetConfig,
)


def _source(tmp_path: Path) -> FrozenMatchdayTasksetConfig:
    row = {
        "case_id": "unit-match",
        "condition_digest": "a" * 64,
        "expected_config_digest": "b" * 64,
        "showdown_revision": SHOWDOWN_REVISION,
        "format": FROZEN_MATCHDAY_FORMAT,
        "jsonl_protocol_version": JSONL_PROTOCOL_VERSION,
        "matchday_protocol_version": MATCHDAY_PROTOCOL_VERSION,
        "battle_protocol_version": BATTLE_PROTOCOL_VERSION,
        "options": {
            "privateConstruction": "OPTIONS_PRIVATE_MARKER",
            "gameSeeds": [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]],
        },
    }
    path = tmp_path / "task-source.jsonl"
    path.write_text(
        json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    return FrozenMatchdayTasksetConfig(
        id="vgc-frozen-matchday-v0", source=path
    )


class FakeSegment:
    def __init__(self, reply: str | None) -> None:
        self.last_reply = reply or ""
        self.terminated = reply is None


class FakeRuntime:
    supports_live_processes = True

    def __init__(self, role: str) -> None:
        self.type = "docker"
        self.info = SimpleNamespace(id=f"runtime-{role}")


class FakeInteraction:
    def __init__(
        self,
        agent: "FakeAgent",
        task: FrozenMatchdayTask,
        reply: str | None,
    ) -> None:
        self.agent = agent
        self.reply = reply
        self.prompts: list[str] = []
        self.exit_error: BaseException | None = None
        self.trace = vf.Trace(
            task=vf.TraceTask(type=type(task).__name__, data=task.data),
            agent=vf.AgentInfo(
                config=agent.config,
                runtime={
                    "type": agent.runtime.type,
                    "id": agent.runtime.info.id,
                    "borrowed": True,
                },
                name=agent.role,
                trainable=False,
            ),
        )

    async def turn(self, prompt: str) -> FakeSegment:
        self.prompts.append(prompt)
        self.trace.nodes.append(
            vf.MessageNode(
                parent=None,
                message=vf.AssistantMessage(content=self.reply or ""),
                sampled=True,
            )
        )
        return FakeSegment(self.reply)


class FakeAgent:
    def __init__(
        self,
        role: str,
        task: FrozenMatchdayTask,
        replies: list[str | None],
        client: vf.EvalClientConfig,
    ) -> None:
        self.role = role
        self.task = task
        self.replies = list(replies)
        self.runtime = FakeRuntime(role)
        self.interactions: list[FakeInteraction] = []
        self.trainable = True
        self.provision_entered = 0
        self.provision_exited = 0
        self.config = vf.AgentConfig(
            model="fake-model",
            client=client,
            harness=vf.HarnessConfig(id="null"),
            runtime=vf.DockerConfig(),
            retries=vf.RetryConfig(max_retries=0),
        )

    @asynccontextmanager
    async def provision(self, task: FrozenMatchdayTask):
        assert task is self.task
        self.provision_entered += 1
        try:
            yield self.runtime
        finally:
            self.provision_exited += 1

    @asynccontextmanager
    async def interaction(self, task: FrozenMatchdayTask, *, runtime: FakeRuntime):
        assert self.role != "referee"
        assert task is self.task and runtime is self.runtime
        if not self.replies:
            raise AssertionError(f"{self.role} has no scripted fresh reply")
        interaction = FakeInteraction(self, task, self.replies.pop(0))
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
    def __init__(self) -> None:
        self.binding: ProtocolBinding | None = None
        self.phase = "playing"
        self.game = 1
        self.revision = 0
        self.state_hash = "outer-0"
        self.submitted: list[str] = []
        self.ready: list[str] = []
        self.notebooks = {"p1": "p1-private-note", "p2": "p2-private-note"}
        self.intervals: dict[str, list[dict[str, Any]]] = {"p1": [], "p2": []}
        self.options: dict[str, Any] | None = None
        self.closed = 0

    async def __aenter__(self) -> "ScriptedReferee":
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        self.closed += 1

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
    ) -> dict[str, Any]:
        self.binding = ProtocolBinding(
            episode_id,
            condition_digest,
            expected_config_digest,
            showdown_revision,
            matchday_protocol_version,
            battle_protocol_version,
        )
        self.options = options
        return {"started": True, "unusedRevision": 0, "unusedStateHash": "outer-0"}

    def _score(self) -> dict[str, int]:
        return {"p1": min(self.game - 1, 2), "p2": 0, "ties": 0}

    def _observe(self, pid: str) -> dict[str, Any]:
        battle = None
        if self.phase == "playing":
            battle = {
                "protocolVersion": BATTLE_PROTOCOL_VERSION,
                "pid": pid,
                "revision": 0,
                "stateHash": f"battle-{self.game}",
                "povLines": [f"|battle-private|{pid}|game-{self.game}"],
                "request": {"rqid": self.game, "native": f"request-{pid}"},
            }
        return {
            "protocolVersion": MATCHDAY_PROTOCOL_VERSION,
            "battleProtocolVersion": BATTLE_PROTOCOL_VERSION,
            "pid": pid,
            "phase": self.phase,
            "gameNumber": self.game,
            "score": self._score(),
            "revision": self.revision,
            "stateHash": self.state_hash,
            "povLines": [f"|outer-private|{pid}|game-{self.game}"],
            "battle": battle,
            "terminal": self.phase == "terminal",
            "controllerOnly": "not projected",
        }

    def _private(self, pid: str) -> dict[str, Any]:
        return {
            "pid": pid,
            "currentNotebook": self.notebooks[pid],
            "intervals": copy.deepcopy(self.intervals[pid]),
        }

    def _legal(self, pid: str) -> dict[str, Any]:
        number = 11 if pid == "p1" else 22
        return {
            "protocolVersion": MATCHDAY_PROTOCOL_VERSION,
            "gameNumber": self.game,
            "revision": self.revision,
            "stateHash": self.state_hash,
            "battleRevision": 0,
            "battleStateHash": f"battle-{self.game}",
            "actions": [
                {
                    "number": number,
                    "label": f"minimum-{pid}-g{self.game}",
                    "command": f"command-{pid}-g{self.game}",
                    "privateConstruction": "LEGAL_PRIVATE_MARKER",
                },
                {
                    "number": number + 100,
                    "label": f"other-{pid}-g{self.game}",
                    "command": f"UNSELECTED_PRIVATE_{pid}",
                },
            ],
        }

    def _terminal(self) -> dict[str, Any]:
        assert self.binding is not None
        return {
            "protocolVersion": MATCHDAY_PROTOCOL_VERSION,
            "battleProtocolVersion": BATTLE_PROTOCOL_VERSION,
            "showdownRevision": SHOWDOWN_REVISION,
            "format": FROZEN_MATCHDAY_FORMAT,
            "configDigest": self.binding.config_digest,
            "score": {"p1": 2, "p2": 0, "ties": 0},
            "result": {
                "type": "win",
                "winner": {"pid": "p1", "name": "PRIVATE_WINNER_NAME"},
            },
            "registrations": ["PRIVATE_REGISTRATIONS"],
            "gameSeeds": [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]],
            "games": [
                {
                    "authoritativeLog": ["PRIVATE_OMNISCIENT_LOG"],
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
                for game in (1, 2)
            ],
            "notebookReceipts": [
                {
                    "pid": pid,
                    "intervals": [
                        {
                            "gameNumber": item["gameNumber"],
                            "supplied": item["supplied"],
                            "notebookSha256": item["notebookSha256"],
                        }
                        for item in self.intervals[pid]
                    ],
                }
                for pid in ("p1", "p2")
            ],
        }

    async def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        params = params or {}
        if method == "observe":
            return self._observe(params["pid"])
        if method == "private_evidence":
            return self._private(params["pid"])
        if method == "legal_actions":
            return self._legal(params["pid"])
        if method == "submit":
            pid = params["pid"]
            self.submitted.append(pid)
            advanced = pid == "p2"
            if advanced:
                self.game += 1
                self.revision += 1
                self.state_hash = f"outer-{self.revision}"
                self.phase = "terminal" if self.game == 3 else "between-games"
                self.submitted.clear()
            return {"advanced": advanced, "unusedScore": self._score()}
        if method == "ready_next_game":
            pid = params["pid"]
            self.ready.append(pid)
            advanced = pid == "p2"
            if advanced:
                for ready_pid in ("p1", "p2"):
                    notebook = self.notebooks[ready_pid]
                    self.intervals[ready_pid].append(
                        {
                            "gameNumber": 1,
                            "supplied": False,
                            "notebook": notebook,
                            "notebookSha256": ("1" if ready_pid == "p1" else "2") * 64,
                        }
                    )
                self.phase = "playing"
                self.revision += 1
                self.state_hash = f"outer-{self.revision}"
                self.ready.clear()
            return {"advanced": advanced, "unusedScore": self._score()}
        if method == "terminal":
            return self._terminal()
        raise AssertionError(method)


async def _run(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    entrant_replies: list[str | None] | None = None,
    opponent_replies: list[str | None] | None = None,
    capture: dict[str, Any] | None = None,
) -> tuple[
    FrozenMatchdayEnv,
    FrozenMatchdayTask,
    SimpleNamespace,
    ScriptedReferee,
    vf.Episode,
]:
    taskset = _source(tmp_path)
    spec = vf.AgentConfig(
        harness=vf.HarnessConfig(id="null"),
        runtime=vf.DockerConfig(),
        retries=vf.RetryConfig(max_retries=0),
    )
    env = FrozenMatchdayEnv(
        FrozenMatchdayEnvConfig(
            taskset=taskset,
            entrant=spec,
            opponent=spec,
            referee=spec,
        )
    )
    task = next(iter(env.taskset))
    client = vf.EvalClientConfig(
        base_url="http://fake.invalid/v1", api_key_var="FAKE_PROVIDER_KEY", headers={}
    )
    agents = SimpleNamespace(
        entrant=FakeAgent(
            "entrant",
            task,
            entrant_replies or ['{"choice":11}', "{}", '{"choice":11}'],
            client,
        ),
        opponent=FakeAgent(
            "opponent",
            task,
            opponent_replies or ['{"choice":22}', "{}", '{"choice":22}'],
            client,
        ),
        referee=FakeAgent("referee", task, [], client),
    )
    referee = ScriptedReferee()
    if capture is not None:
        capture.update(agents=agents, referee=referee)

    async def launch(_cls: Any, runtime: Any, **kwargs: Any) -> ScriptedReferee:
        assert runtime is agents.referee.runtime
        assert kwargs["showdown_revision"] == SHOWDOWN_REVISION
        return referee

    monkeypatch.setattr(
        env_module.FrozenMatchdayProtocolClient,
        "launch",
        classmethod(launch),
    )
    await env.setup(agents)
    await env.run(task, agents)
    traces = [
        interaction.trace
        for role in (agents.entrant, agents.opponent)
        for interaction in role.interactions
    ]
    return env, task, agents, referee, vf.Episode(traces=traces)


@pytest.mark.asyncio
async def test_phase_loop_fresh_private_turns_terminal_allowlist_joins_and_rewards(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    env, task, agents, referee, episode = await _run(monkeypatch, tmp_path)
    assert referee.options == task.options()
    assert referee.options is not task.options()
    assert referee.closed == 1
    assert all(agent.provision_entered == agent.provision_exited == 1 for agent in (
        agents.entrant,
        agents.opponent,
        agents.referee,
    ))
    assert agents.referee.interactions == []
    assert len(agents.entrant.interactions) == len(agents.opponent.interactions) == 3
    assert all(interaction.exit_error is None for role in (
        agents.entrant,
        agents.opponent,
    ) for interaction in role.interactions)

    prompts = [
        interaction.prompts[0]
        for role in (agents.entrant, agents.opponent)
        for interaction in role.interactions
    ]
    assert all(prompt.startswith(FORMAT_AUTHORITY_NOTICE + "\n\n") for prompt in prompts)
    assert all("OPTIONS_PRIVATE_MARKER" not in prompt for prompt in prompts)
    assert all("LEGAL_PRIVATE_MARKER" not in prompt for prompt in prompts)
    for interaction in agents.entrant.interactions:
        assert "p2-private-note" not in interaction.prompts[0]
    for interaction in agents.opponent.interactions:
        assert "p1-private-note" not in interaction.prompts[0]

    await env.finalize(task, episode)
    assert len(episode.traces) == 6
    carriers = [
        trace for trace in episode.traces if trace.info["matchday_v0"]["carrier"]
    ]
    assert len(carriers) == 2
    assert {trace.agent.name for trace in carriers} == {"entrant", "opponent"}
    assert all("terminal" not in trace.info["matchday_v0"] for trace in episode.traces if trace not in carriers)
    assert carriers[0].info["matchday_v0"]["terminal"] == carriers[1].info["matchday_v0"]["terminal"]
    terminal = carriers[0].info["matchday_v0"]["terminal"]
    assert set(terminal) == {
        "protocol_version",
        "battle_protocol_version",
        "showdown_revision",
        "format",
        "config_digest",
        "score",
        "result",
        "games",
    }
    assert terminal["games"] == 2
    assert terminal["result"] == {"type": "win", "winner": "p1"}
    for carrier in carriers:
        pid = carrier.info["matchday_v0"]["pid"]
        assert all(join["pid"] == pid for join in carrier.info["matchday_v0"]["accepted_joins"])
        assert set(carrier.rewards) == {"matchday_outcome_v0"}
        expected = 1.0 if pid == "p1" else -1.0
        assert carrier.rewards["matchday_outcome_v0"].score == expected
        assert carrier.metrics == {
            "matchday_games_v0": 2.0,
            "matchday_result_v0": expected,
        }
    entrant_carrier = next(
        trace for trace in carriers if trace.info["matchday_v0"]["pid"] == "p1"
    )
    assert [trace for trace in episode.traces if trace.agent.trainable] == [
        entrant_carrier
    ]
    aggregate = _run_metrics([episode], episode.traces)
    assert aggregate["avg_reward"] == 1.0
    assert aggregate["avg_metrics"] == {
        "matchday_outcome_v0": 1.0,
        "matchday_games_v0": 2.0,
        "matchday_result_v0": 1.0,
    }
    for trace in episode.traces:
        evidence = trace.info["matchday_v0"]
        assert evidence["runtime_ids"] == {
            "entrant": "runtime-entrant",
            "opponent": "runtime-opponent",
            "referee": "runtime-referee",
        }
        assert evidence["transport"] == "runtime-process"
        encoded = json.dumps(trace.model_dump(mode="json"), sort_keys=True)
        for private in (
            "OPTIONS_PRIVATE_MARKER",
            "PRIVATE_REGISTRATIONS",
            "PRIVATE_OMNISCIENT_LOG",
            "PRIVATE_WINNER_NAME",
            "gameSeeds",
        ):
            assert private not in encoded
        if trace not in carriers:
            assert trace.rewards == {} and trace.metrics == {}


@pytest.mark.asyncio
async def test_v03_policy_peer_failure_cleanup_and_counter_join_validate_before_scoring(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    taskset = _source(tmp_path)
    null = vf.HarnessConfig(id="null")
    with pytest.raises(ValueError, match="unsafe"):
        FrozenMatchdayEnvConfig(
            taskset=taskset,
            entrant=vf.AgentConfig(
                harness=null,
                client=vf.EvalClientConfig(headers={"Authorization": "secret"}),
            ),
        )
    with pytest.raises(ValueError, match="zero retries"):
        FrozenMatchdayEnvConfig(
            taskset=taskset,
            entrant=vf.AgentConfig(
                harness=null, retries=vf.RetryConfig(max_retries=1)
            ),
        )
    with pytest.raises(ValueError, match="explicit model and client"):
        FrozenMatchdayEnvConfig(
            taskset=taskset, opponent_condition="pinned_opponent"
        )

    failure_dir = tmp_path / "failure"
    failure_dir.mkdir()
    failed: dict[str, Any] = {}
    with pytest.raises(ScaffoldError, match="fresh interaction"):
        await _run(
            monkeypatch,
            failure_dir,
            entrant_replies=['{"choice":11}'],
            opponent_replies=[None],
            capture=failed,
        )
    failed_agents = failed["agents"]
    assert failed["referee"].closed == 1
    assert all(agent.provision_entered == agent.provision_exited == 1 for agent in (
        failed_agents.entrant,
        failed_agents.opponent,
        failed_agents.referee,
    ))
    assert all(
        interaction.exit_error is None
        for role in (failed_agents.entrant, failed_agents.opponent)
        for interaction in role.interactions
    )

    join_dir = tmp_path / "join"
    join_dir.mkdir()
    env, task, agents, referee, episode = await _run(monkeypatch, join_dir)
    assert referee.closed == 1
    carrier = next(
        trace
        for trace in episode.traces
        if trace.info["matchday_v0"]["carrier"]
        and trace.info["matchday_v0"]["pid"] == "p1"
    )
    evidence = carrier.info["matchday_v0"]
    evidence["carrier"] = 1
    with pytest.raises(ValueError, match="carrier must be a boolean"):
        await env.finalize(task, episode)
    evidence["carrier"] = True
    evidence["diagnostic"] = NOTEBOOK_EVIDENCE_DIAGNOSTIC
    with pytest.raises(ValueError, match="notebook diagnostic"):
        await env.finalize(task, episode)
    evidence["diagnostic"] = None

    terminal_cases = [
        ("games-domain", {"games": 1}, "exactly 2 or 3"),
        (
            "negative-score",
            {"score": {"p1": -1, "p2": 3, "ties": 0}},
            "integer >= 0",
        ),
        (
            "score-sum",
            {"score": {"p1": 2, "p2": 0, "ties": 1}},
            "does not sum",
        ),
        (
            "two-game-shape",
            {"score": {"p1": 1, "p2": 1, "ties": 0}, "result": {"type": "tie"}},
            "must be 2-0",
        ),
        (
            "three-game-result",
            {
                "games": 3,
                "score": {"p1": 2, "p2": 1, "ties": 0},
                "result": {"type": "win", "winner": "p2"},
            },
            "does not agree",
        ),
    ]
    for _name, changes, message in terminal_cases:
        invalid = copy.deepcopy(episode)
        for trace in invalid.traces:
            invalid_evidence = trace.info["matchday_v0"]
            if invalid_evidence["carrier"]:
                invalid_evidence["terminal"].update(copy.deepcopy(changes))
        with pytest.raises(ProtocolError, match=message):
            await env.finalize(task, invalid)
        assert all(trace.rewards == {} and trace.metrics == {} for trace in invalid.traces)

    invalid_hash = copy.deepcopy(episode)
    notebook_trace = next(
        trace
        for trace in invalid_hash.traces
        if trace.info["matchday_v0"]["kind"] == "notebook"
    )
    notebook_trace.info["matchday_v0"]["join"]["notebook_sha256"] = "A" * 64
    with pytest.raises(ProtocolError, match="lowercase 64-hex"):
        await env.finalize(task, invalid_hash)
    assert all(trace.rewards == {} and trace.metrics == {} for trace in invalid_hash.traces)

    invalid_receipt = referee._terminal()
    invalid_receipt["notebookReceipts"][0]["intervals"][0][
        "notebookSha256"
    ] = "A" * 64
    with pytest.raises(ProtocolError, match="lowercase 64-hex"):
        env_module._terminal(invalid_receipt, task.data)

    action = next(
        join
        for join in carrier.info["matchday_v0"]["accepted_joins"]
        if join["kind"] == "action"
    )
    action["command"] = "coherent-looking-but-unaccepted"
    with pytest.raises(ValueError, match="exactly join"):
        await env.finalize(task, episode)
    assert all(trace.rewards == {} and trace.metrics == {} for trace in episode.traces)
    assert all(agent.provision_entered == agent.provision_exited == 1 for agent in (
        agents.entrant,
        agents.opponent,
        agents.referee,
    ))


def test_native_cli_dotted_overrides_bind_source_and_enforce_opponent_policy(
    tmp_path: Path,
) -> None:
    source = str(_source(tmp_path).source)
    pinned = with_positional_taskset(
        [
            "vgc_frozen_matchday_v0",
            "--env.taskset.source",
            source,
            "--env.opponent_condition",
            "pinned_opponent",
            "--env.opponent.model",
            "pinned/model",
            "--env.opponent.client.type",
            "eval",
            "--env.opponent.client.base_url",
            "https://pinned.invalid/v1",
            "--env.opponent.client.api_key_var",
            "PINNED_KEY",
        ]
    )
    config = parse_cli(narrow_config(EvalConfig, pinned), args=pinned, plain=True)
    assert isinstance(config.env, FrozenMatchdayEnvConfig)
    assert config.env.opponent_condition == "pinned_opponent"
    assert config.env.opponent.model == "pinned/model"
    assert isinstance(config.env.opponent.client, vf.EvalClientConfig)
    assert config.env.opponent.client.base_url == "https://pinned.invalid/v1"
    assert config.env.taskset.source == Path(source)
    assert config.env.taskset.task.source_sha256 == hashlib.sha256(
        Path(source).read_bytes()
    ).hexdigest()

    for overrides, message in (
        (
            [
                "--env.opponent_condition",
                "pinned_opponent",
                "--env.opponent.model",
                "pinned/model",
            ],
            "explicit model and client",
        ),
        (["--env.opponent.model", "sneaky/override"], "must inherit"),
    ):
        argv = with_positional_taskset(
            ["vgc_frozen_matchday_v0", "--env.taskset.source", source, *overrides]
        )
        with pytest.raises(ConfigFileError, match=message):
            parse_cli(narrow_config(EvalConfig, argv), args=argv, plain=True)
