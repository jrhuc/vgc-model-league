from __future__ import annotations

import asyncio
import copy
import hashlib
import math
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest
from pydantic import ValidationError
from verifiers import v1 as vf

import vgc_circuit_v1.env as env_module
from vgc_circuit_v1.env import (
    VgcCircuitEnv,
    VgcCircuitEnvConfig,
)
from vgc_circuit_v1.protocol import (
    BATTLE_PROTOCOL_VERSION,
    CIRCUIT_PROTOCOL_VERSION,
    DEFAULT_REFEREE_EXECUTABLE,
    DEFAULT_REFEREE_IMAGE,
    JSONL_PROTOCOL_VERSION,
    MATCHDAY_PROTOCOL_VERSION,
    PROMPT_PROTOCOL_VERSION,
    SHOWDOWN_REVISION,
    ProtocolBinding,
    ProtocolError,
)
from vgc_circuit_v1.taskset import (
    VgcCircuitTask,
    VgcCircuitTasksetConfig,
)

_ROLES = tuple(f"seat{index}" for index in range(1, 9))
_SEATS = tuple(f"seat-{index}" for index in range(1, 9))
_KINDS = ("draft", "construction", "action", "trade_offer", "trade_response", "free_agency")


class Concurrency:
    def __init__(self) -> None:
        self.active = 0
        self.maximum = 0


class FakeSegment:
    def __init__(self, reply: str | None) -> None:
        self.terminated = reply is None
        self.messages = [] if reply is None else [vf.AssistantMessage(content=reply)]


class FakeRuntime:
    supports_live_processes = True

    def __init__(self, role: str, runtime_id: str | None = None) -> None:
        self.type = "docker"
        self.info = SimpleNamespace(id=runtime_id or f"runtime-{role}")


class FakeInteraction:
    def __init__(self, agent: "FakeAgent", task: VgcCircuitTask, reply: str | None, concurrency: Concurrency) -> None:
        self.reply = reply
        self.concurrency = concurrency
        self.prompts: list[str] = []
        self.trace = vf.Trace(
            task=vf.TraceTask(type=type(task).__name__, data=task.data),
            agent=vf.AgentInfo(
                config=agent.config,
                runtime={"type": "docker", "id": agent.runtime.info.id, "borrowed": True},
                name=agent.role,
                trainable=agent.trainable,
            ),
        )

    async def turn(self, prompt: str) -> FakeSegment:
        self.prompts.append(prompt)
        self.concurrency.active += 1
        self.concurrency.maximum = max(self.concurrency.maximum, self.concurrency.active)
        try:
            await asyncio.sleep(0)
            if self.reply is not None:
                self.trace.nodes.append(
                    vf.MessageNode(parent=None, message=vf.AssistantMessage(content=self.reply), sampled=True)
                )
            return FakeSegment(self.reply)
        finally:
            self.concurrency.active -= 1


class FakeAgent:
    def __init__(
        self,
        role: str,
        task: VgcCircuitTask,
        replies: list[str | None],
        concurrency: Concurrency,
        runtime_id: str | None = None,
    ) -> None:
        self.role = role
        self.task = task
        self.replies = list(replies)
        self.concurrency = concurrency
        self.runtime = FakeRuntime(role, runtime_id)
        self.interactions: list[FakeInteraction] = []
        self.trainable = True
        self.provision_entered = 0
        self.provision_exited = 0
        self.config = vf.AgentConfig(
            model="fake/model",
            client=vf.EvalClientConfig(base_url="http://fake.invalid/v1"),
            harness=vf.HarnessConfig(id="null"),
            runtime=vf.DockerConfig(),
            retries=vf.RetryConfig(max_retries=0),
        )

    @asynccontextmanager
    async def provision(self, task: VgcCircuitTask):
        assert task is self.task
        self.provision_entered += 1
        try:
            yield self.runtime
        finally:
            self.provision_exited += 1

    @asynccontextmanager
    async def interaction(self, task: VgcCircuitTask, *, runtime: FakeRuntime):
        assert self.role != "referee"
        assert task is self.task and runtime is self.runtime
        if not self.replies:
            raise AssertionError(f"{self.role} has no scripted response")
        interaction = FakeInteraction(self, task, self.replies.pop(0), self.concurrency)
        self.interactions.append(interaction)
        error: BaseException | None = None
        try:
            yield interaction
        except BaseException as exc:
            error = exc
            raise
        finally:
            interaction.trace.is_completed = True
            interaction.trace.ok = error is None and interaction.trace.num_turns == 1


def _rr_pairs() -> list[tuple[int, int]]:
    return [
        (0, 7), (1, 6), (2, 5), (3, 4),
        (6, 0), (5, 7), (4, 1), (3, 2),
        (0, 5), (6, 4), (7, 3), (1, 2),
        (4, 0), (3, 5), (2, 6), (1, 7),
        (0, 3), (4, 2), (5, 1), (6, 7),
        (2, 0), (1, 3), (7, 4), (6, 5),
        (0, 1), (2, 7), (3, 6), (4, 5),
    ]


def _series(index: int, stage: str, a: str, b: str, week: int | None, bracket_round: int | None) -> dict[str, Any]:
    return {
        "seriesIndex": index,
        "stage": stage,
        "week": week,
        "bracketRound": bracket_round,
        "seats": {"p1": a, "p2": b},
        "winnerSeatId": a,
        "tiebreak": "none",
        "score": {"p1": 2, "p2": 0, "ties": 0},
        "gameCount": 2,
        "games": [
            {"gameNumber": game, "result": {"type": "win", "winnerSeatId": a}, "turns": game + 4}
            for game in (1, 2)
        ],
        "matchdayConfigDigest": f"{index:064x}",
        "acceptedJoins": [
            {
                "seatId": seat,
                "pid": pid,
                "teamSha256": hashlib.sha256(f"team:{index}:{seat}".encode()).hexdigest(),
                "constructionSha256": hashlib.sha256(f"build:{index}:{seat}".encode()).hexdigest(),
            }
            for pid, seat in (("p1", a), ("p2", b))
        ],
    }


def _split(series: list[dict[str, Any]], seat: str) -> dict[str, dict[str, int]]:
    result = {
        "series": {"wins": 0, "draws": 0, "losses": 0},
        "games": {"wins": 0, "draws": 0, "losses": 0},
    }
    for item in series:
        if seat not in item["seats"].values():
            continue
        result["series"]["wins" if item["winnerSeatId"] == seat else "losses"] += 1
        for game in item["games"]:
            result["games"]["wins" if game["result"]["winnerSeatId"] == seat else "losses"] += 1
    return result


class ScriptedCircuitReferee:
    def __init__(self) -> None:
        self.binding: ProtocolBinding | None = None
        self.scenario_id = "draft-league-v1"
        self.closed = 0
        self.batch = 0
        self.submitted: set[str] = set()
        self.receipts: list[dict[str, Any]] = []
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.batches = [
            [
                {"turnId": f"offer-{seat}", "seatId": seat, "kind": "trade_offer", "prompt": f"private offer prompt {seat}", "attempt": 1}
                for seat in _SEATS
            ],
            [
                {"turnId": f"fa-{seat}", "seatId": seat, "kind": "free_agency", "prompt": f"private FA prompt {seat}", "attempt": 1}
                for seat in _SEATS
            ],
        ]

    async def __aenter__(self) -> "ScriptedCircuitReferee":
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        self.closed += 1

    async def start(self, *, episode_id: str, condition_digest: str, scenario_id: str, seed: int) -> dict[str, Any]:
        self.binding = ProtocolBinding(
            episode_id=episode_id,
            condition_digest=condition_digest,
            scenario_id=scenario_id,
            seed=seed,
            config_digest="c" * 64,
            showdown_revision=SHOWDOWN_REVISION,
            jsonl_protocol_version=JSONL_PROTOCOL_VERSION,
            circuit_protocol_version=CIRCUIT_PROTOCOL_VERSION,
            prompt_protocol_version=PROMPT_PROTOCOL_VERSION,
            matchday_protocol_version=MATCHDAY_PROTOCOL_VERSION,
            battle_protocol_version=BATTLE_PROTOCOL_VERSION,
            prompt_revision="prompt-v2",
        )
        return {"started": True, "revision": 0, "stateHash": "initial-state"}

    async def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        params = params or {}
        self.calls.append((method, copy.deepcopy(params)))
        if method == "pending_turns":
            return [] if self.batch == len(self.batches) else copy.deepcopy(self.batches[self.batch])
        if method == "observe":
            turn = next(item for item in self.batches[self.batch] if item["seatId"] == params["seatId"])
            return {
                "protocolVersion": CIRCUIT_PROTOCOL_VERSION,
                "promptProtocolVersion": PROMPT_PROTOCOL_VERSION,
                "scenarioId": self.scenario_id,
                "seatId": params["seatId"],
                "phase": "trade",
                "revision": self.batch,
                "stateHash": f"state-{self.batch}",
                "pendingTurns": [copy.deepcopy(turn)],
                "bracket": None,
                "private": {"seatOnly": params["seatId"]},
                "terminal": False,
            }
        if method == "submit":
            turn = next(item for item in self.batches[self.batch] if item["turnId"] == params["turnId"])
            invalid = params["response"] == "not-json"
            result = {
                "accepted": not invalid,
                "advanced": True,
                "defaulted": invalid,
                "diagnostic": "invalid_output_defaulted" if invalid else None,
                "phase": "trade",
                "revision": self.batch + 1,
                "stateHash": f"state-{self.batch + 1}",
                "terminal": False,
            }
            self.receipts.append(
                {
                    "turnId": turn["turnId"],
                    "seatId": turn["seatId"],
                    "kind": turn["kind"],
                    "attempt": turn["attempt"],
                    "responseSha256": hashlib.sha256(params["response"].encode()).hexdigest(),
                    **{key: result[key] for key in ("accepted", "advanced", "defaulted", "diagnostic")},
                }
            )
            self.submitted.add(turn["seatId"])
            if self.submitted == set(_SEATS):
                self.batch += 1
                self.submitted.clear()
            return result
        if method == "terminal":
            return self.terminal()
        raise AssertionError(method)

    def terminal(self) -> dict[str, Any]:
        series = [
            _series(index, "roundrobin", _SEATS[a], _SEATS[b], index // 4 + 1, None)
            for index, (a, b) in enumerate(_rr_pairs())
        ]
        rr_splits = {seat: _split(series, seat) for seat in _SEATS}
        ranked = sorted(_SEATS, key=lambda seat: (-rr_splits[seat]["series"]["wins"], seat))
        semis = [
            _series(28, "playoff", ranked[0], ranked[3], None, 0),
            _series(29, "playoff", ranked[1], ranked[2], None, 0),
        ]
        final = _series(30, "playoff", ranked[0], ranked[1], None, 1)
        series.extend([*semis, final])
        defaults = [
            {
                "turnId": "fa-seat-2",
                "seatId": "seat-2",
                "kind": "free_agency",
                "seriesIndex": None,
                "selectedDigest": hashlib.sha256(b"safe-empty-free-agency").hexdigest(),
                "diagnostic": "invalid_output_defaulted",
            }
        ]
        per_seat = []
        for seat in _SEATS:
            pieces = {
                "total": _split(series, seat),
                "roundRobinPreWindow": _split(series[:12], seat),
                "roundRobinPostWindow": _split(series[12:28], seat),
                "playoffs": _split(series[28:], seat),
                "topCut": _split([], seat),
            }
            reward = (
                pieces["roundRobinPreWindow"]["series"]["wins"]
                - pieces["roundRobinPreWindow"]["series"]["losses"]
                + pieces["roundRobinPostWindow"]["series"]["wins"]
                - pieces["roundRobinPostWindow"]["series"]["losses"]
                + pieces["playoffs"]["series"]["wins"]
                - pieces["playoffs"]["series"]["losses"]
            ) / 9
            per_seat.append(
                {
                    "seatId": seat,
                    "name": seat,
                    **pieces,
                    "reward": {"name": "draft_league_series_return_v1", "value": reward},
                    "defaults": {kind: int(seat == "seat-2" and kind == "free_agency") for kind in _KINDS},
                }
            )
        standings = [
            {
                "rank": rank,
                "seatId": seat,
                "series": rr_splits[seat]["series"],
                "gameWins": rr_splits[seat]["games"]["wins"],
                "gameDraws": rr_splits[seat]["games"]["draws"],
                "gameLosses": rr_splits[seat]["games"]["losses"],
            }
            for rank, seat in enumerate(ranked, start=1)
        ]
        index_of = {seat: index for index, seat in enumerate(_SEATS)}
        bracket = [
            [
                {"round": 0, "seriesIndex": item["seriesIndex"], "slots": [index_of[item["seats"]["p1"]], index_of[item["seats"]["p2"]]], "winner": index_of[item["winnerSeatId"]]}
                for item in semis
            ],
            [{"round": 1, "seriesIndex": 30, "slots": [index_of[ranked[0]], index_of[ranked[1]]], "winner": index_of[ranked[0]]}],
        ]
        pre_ranked = sorted(
            _SEATS,
            key=lambda seat: (
                -_split(series[:12], seat)["series"]["wins"],
                -(
                    _split(series[:12], seat)["games"]["wins"]
                    - _split(series[:12], seat)["games"]["losses"]
                ),
                -_split(series[:12], seat)["games"]["wins"],
                _SEATS.index(seat),
            ),
        )
        transaction_order = list(reversed(pre_ranked))
        transactions = {
            "afterWeek": 3,
            "tradesAllowed": 1,
            "maxFreeAgencySwaps": 6,
            "order": transaction_order,
            "offers": [
                {"from": seat, "to": None, "give": None, "get": None, "accepted": None, "proposerDefaulted": False, "responderDefaulted": None}
                for seat in transaction_order
            ],
            "freeAgency": [
                {"seatId": seat, "swaps": [], "defaulted": seat == "seat-2"}
                for seat in transaction_order
            ],
            "finalRosterDigests": [
                {"seatId": seat, "rosterDigest": hashlib.sha256(f"roster:{seat}".encode()).hexdigest()}
                for seat in _SEATS
            ],
        }
        summary = {
            "protocolVersion": CIRCUIT_PROTOCOL_VERSION,
            "promptProtocolVersion": PROMPT_PROTOCOL_VERSION,
            "matchdayProtocolVersion": MATCHDAY_PROTOCOL_VERSION,
            "battleProtocolVersion": BATTLE_PROTOCOL_VERSION,
            "showdownRevision": SHOWDOWN_REVISION,
            "scenarioId": "draft-league-v1",
            "format": "gen9championsvgc2026regmbbo3",
            "configDigest": "c" * 64,
            "promptRevision": "prompt-v2",
            "fixtureDigests": {"board": "b" * 64, "victoryRoadPool": None},
            "scenario": {"seats": 8, "source": "fixture", "scope": "full league", "claims": [], "doesNotClaim": []},
            "championSeatId": ranked[0],
            "finalStandings": standings,
            "bracket": bracket,
            "series": series,
            "perSeat": per_seat,
            "transactions": transactions,
            "defaults": defaults,
            "turnReceipts": copy.deepcopy(self.receipts),
        }
        return {
            "summary": summary,
            "privateEvidence": {"series": [], "seats": [], "transactionState": {}, "turnReceipts": [], "derived": {}},
        }


class VictoryReferee(ScriptedCircuitReferee):
    def __init__(self) -> None:
        super().__init__()
        self.scenario_id = "victory-road-top8-v1"
        self.batches = [[
            {
                "turnId": f"action-{seat}",
                "seatId": seat,
                "kind": "action",
                "prompt": f"private tournament prompt {seat}",
                "attempt": 1,
            }
            for seat in _SEATS
        ]]

    def terminal(self) -> dict[str, Any]:
        plans = [
            (0, 0, "seat-1", "seat-8"),
            (1, 0, "seat-2", "seat-7"),
            (2, 0, "seat-3", "seat-6"),
            (3, 0, "seat-4", "seat-5"),
            (4, 1, "seat-1", "seat-2"),
            (5, 1, "seat-3", "seat-4"),
            (6, 2, "seat-1", "seat-3"),
        ]
        series = [
            _series(index, "top-cut", a, b, None, round_number)
            for index, round_number, a, b in plans
        ]
        empty = _split([], "seat-1")
        per_seat = []
        for seat in _SEATS:
            top_cut = _split(series, seat)
            per_seat.append(
                {
                    "seatId": seat,
                    "name": seat,
                    "total": top_cut,
                    "roundRobinPreWindow": copy.deepcopy(empty),
                    "roundRobinPostWindow": copy.deepcopy(empty),
                    "playoffs": copy.deepcopy(empty),
                    "topCut": top_cut,
                    "reward": {
                        "name": "tournament_series_return_v1",
                        "value": (
                            top_cut["series"]["wins"]
                            - top_cut["series"]["losses"]
                        ) / 3,
                    },
                    "defaults": {kind: 0 for kind in _KINDS},
                }
            )
        index_of = {seat: index for index, seat in enumerate(_SEATS)}
        bracket = []
        for round_number in range(3):
            bracket.append(
                [
                    {
                        "round": round_number,
                        "seriesIndex": item["seriesIndex"],
                        "slots": [
                            index_of[item["seats"]["p1"]],
                            index_of[item["seats"]["p2"]],
                        ],
                        "winner": index_of[item["winnerSeatId"]],
                    }
                    for item in series
                    if item["bracketRound"] == round_number
                ]
            )
        summary = {
            "protocolVersion": CIRCUIT_PROTOCOL_VERSION,
            "promptProtocolVersion": PROMPT_PROTOCOL_VERSION,
            "matchdayProtocolVersion": MATCHDAY_PROTOCOL_VERSION,
            "battleProtocolVersion": BATTLE_PROTOCOL_VERSION,
            "showdownRevision": SHOWDOWN_REVISION,
            "scenarioId": self.scenario_id,
            "format": "gen9championsvgc2026regmbbo3",
            "configDigest": "c" * 64,
            "promptRevision": "prompt-v2",
            "fixtureDigests": {"board": None, "victoryRoadPool": "f" * 64},
            "scenario": {
                "seats": 8,
                "source": "fixture",
                "scope": "complete top cut",
                "claims": [],
                "doesNotClaim": [],
            },
            "championSeatId": "seat-1",
            "finalStandings": None,
            "bracket": bracket,
            "series": series,
            "perSeat": per_seat,
            "transactions": None,
            "defaults": [],
            "turnReceipts": copy.deepcopy(self.receipts),
        }
        return {
            "summary": summary,
            "privateEvidence": {
                "series": [],
                "seats": [],
                "transactionState": None,
                "turnReceipts": [],
                "derived": {},
            },
        }


async def _run(
    monkeypatch: pytest.MonkeyPatch,
    *,
    failed_role: str | None = None,
    duplicate_runtime: bool = False,
    scenario_id: str = "draft-league-v1",
    **pins: str,
) -> tuple[VgcCircuitEnv, VgcCircuitTask, SimpleNamespace, ScriptedCircuitReferee, vf.Episode, Concurrency]:
    config = VgcCircuitEnvConfig(
        taskset=VgcCircuitTasksetConfig(
            id="vgc-circuit-v1", scenario=scenario_id
        ),
        **pins,
    )
    env = VgcCircuitEnv(config)
    task = next(iter(env.taskset))
    concurrency = Concurrency()
    agents_by_name: dict[str, FakeAgent] = {}
    for role in _ROLES:
        replies: list[str | None] = [None if failed_role == role else f" raw response {role} "]
        replies.append("not-json" if role == "seat2" else f"valid FA {role}")
        runtime_id = "duplicate" if duplicate_runtime and role in {"seat1", "seat2"} else None
        agents_by_name[role] = FakeAgent(role, task, replies, concurrency, runtime_id)
    agents_by_name["referee"] = FakeAgent("referee", task, [], concurrency)
    agents = SimpleNamespace(**agents_by_name)
    referee = (
        VictoryReferee()
        if scenario_id == "victory-road-top8-v1"
        else ScriptedCircuitReferee()
    )

    async def launch(_cls: Any, runtime: Any, **kwargs: Any) -> ScriptedCircuitReferee:
        assert runtime is agents.referee.runtime
        assert kwargs["executable"] == DEFAULT_REFEREE_EXECUTABLE
        return referee

    monkeypatch.setattr(env_module.VgcCircuitProtocolClient, "launch", classmethod(launch))
    await env.setup(agents)
    await env.run(task, agents)
    traces = [interaction.trace for role in _ROLES for interaction in getattr(agents, role).interactions]
    return env, task, agents, referee, vf.Episode(traces=traces), concurrency


@pytest.mark.asyncio
async def test_full_eight_seat_31_series_join_rewards_and_diagnostics(monkeypatch: pytest.MonkeyPatch) -> None:
    env, task, agents, referee, episode, concurrency = await _run(monkeypatch)
    assert referee.closed == 1
    assert concurrency.maximum == 8
    assert len(episode.traces) == 16
    assert agents.referee.interactions == []
    assert all(agent.provision_entered == agent.provision_exited == 1 for agent in (getattr(agents, role) for role in (*_ROLES, "referee")))
    assert all(len(getattr(agents, role).interactions) == 2 for role in _ROLES)
    assert [method for method, _ in referee.calls].count("observe") == 16
    invalid = agents.seat2.interactions[1].trace.info["circuit_v1"]["join"]
    assert invalid["submitted"] == "not-json"
    assert invalid["accepted"] is False and invalid["defaulted"] is True
    assert invalid["diagnostic"] == "invalid_output_defaulted"
    assert invalid["responseSha256"] == hashlib.sha256(b"not-json").hexdigest()

    await env.finalize(task, episode)
    assert all(trace.agent.trainable for trace in episode.traces)
    assert all(set(trace.rewards) == {"draft_league_series_return_v1"} for trace in episode.traces)
    for trace in episode.traces:
        reward = trace.rewards["draft_league_series_return_v1"].score
        assert -1 <= reward <= 1
        assert trace.metrics["circuit_series_v1"] >= 7
        assert "circuit_game_return_v1" in trace.metrics
        assert "draft_league_final_rr_rank_v1" in trace.metrics
        assert "draft_league_pre_window_game_return_v1" in trace.metrics
        assert "draft_league_post_window_series_return_v1" in trace.metrics
        assert "draft_league_playoff_game_return_v1" in trace.metrics
        assert "circuit_g1_loss_conversion_rate_v1" in trace.metrics
        evidence = trace.info["circuit_v1"]
        assert evidence["scenario"] == "draft-league-v1"
        assert evidence["seat"] == f"seat-{int(trace.agent.name[4:])}"
        assert len(set(evidence["runtime_ids"].values())) == 9
        splits = evidence["terminal"]["seat"]["splits"]
        expected = sum(
            splits[name]["series"]["wins"] - splits[name]["series"]["losses"]
            for name in ("roundRobinPreWindow", "roundRobinPostWindow", "playoffs")
        ) / 9
        assert reward == pytest.approx(expected)
    assert all(item.trace.metrics["circuit_free_agency_defaults_v1"] == 1 for item in agents.seat2.interactions)
    assert all(item.trace.metrics["circuit_champion_v1"] == 1 for item in agents.seat1.interactions)
    assert all(trace.metrics["circuit_seat_decisions_v1"] == 2 for trace in episode.traces)
    assert math.fsum(
        trace.rewards["draft_league_series_return_v1"].score / trace.metrics["circuit_seat_decisions_v1"]
        for trace in episode.traces
    ) == pytest.approx(0.0, abs=1e-12)


@pytest.mark.asyncio
async def test_victory_road_rewards_every_joined_trace(monkeypatch: pytest.MonkeyPatch) -> None:
    env, task, agents, referee, episode, concurrency = await _run(
        monkeypatch, scenario_id="victory-road-top8-v1"
    )
    assert concurrency.maximum == 8
    assert len(episode.traces) == 8
    assert agents.referee.interactions == []
    assert all(len(getattr(agents, role).interactions) == 1 for role in _ROLES)
    await env.finalize(task, episode)
    assert all(
        set(trace.rewards) == {"tournament_series_return_v1"}
        for trace in episode.traces
    )
    champion = agents.seat1.interactions[0].trace
    reward = champion.rewards["tournament_series_return_v1"].score
    assert reward == 1
    top_cut = champion.info["circuit_v1"]["terminal"]["seat"]["splits"]["topCut"]["series"]
    assert reward == pytest.approx((top_cut["wins"] - top_cut["losses"]) / 3)
    assert champion.metrics["circuit_series_v1"] == 3
    assert champion.metrics["circuit_champion_v1"] == 1
    assert champion.metrics["circuit_seat_decisions_v1"] == 1
    assert math.fsum(
        trace.rewards["tournament_series_return_v1"].score
        for trace in episode.traces
    ) == pytest.approx(0.0, abs=1e-12)
    assert all(
        "draft_league_final_rr_rank_v1" not in trace.metrics
        for trace in episode.traces
    )
    assert referee.closed == 1


@pytest.mark.asyncio
async def test_impossible_post_clinch_series_is_rejected_at_the_environment_boundary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    terminal = ScriptedCircuitReferee.terminal

    def impossible(self: ScriptedCircuitReferee) -> dict[str, Any]:
        evidence = terminal(self)
        series = evidence["summary"]["series"][0]
        series["games"].append(
            {
                "gameNumber": 3,
                "result": {"type": "tie", "winnerSeatId": None},
                "turns": 7,
            }
        )
        series["gameCount"] = 3
        series["score"]["ties"] = 1
        return evidence

    monkeypatch.setattr(ScriptedCircuitReferee, "terminal", impossible)
    with pytest.raises(ProtocolError):
        await _run(monkeypatch)




@pytest.mark.asyncio
async def test_terminal_tampering_scores_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    env, task, _agents, _referee, episode, _concurrency = await _run(monkeypatch)
    tampered = copy.deepcopy(episode)
    tampered.traces[0].info["circuit_v1"]["join"]["submitted"] = "tampered"
    with pytest.raises(ProtocolError, match="response hash"):
        await env.finalize(task, tampered)
    assert all(not trace.rewards and not trace.metrics for trace in tampered.traces)

    bad_reward = copy.deepcopy(episode)
    for trace in bad_reward.traces:
        if trace.agent.name == "seat1":
            trace.info["circuit_v1"]["terminal"]["seat"]["rewardValue"] += 0.1
    with pytest.raises(ProtocolError, match="reward"):
        await env.finalize(task, bad_reward)
    assert all(not trace.rewards and not trace.metrics for trace in bad_reward.traces)


@pytest.mark.asyncio
async def test_self_consistent_seat_inflation_breaks_the_zero_sum_partition(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env, task, _agents, _referee, episode, _concurrency = await _run(monkeypatch)
    inflated = copy.deepcopy(episode)
    seats = [trace.info["circuit_v1"]["terminal"]["seat"] for trace in inflated.traces]
    target = next(
        seat["seatId"]
        for seat in seats
        if seat["splits"]["playoffs"]["series"]["losses"]
    )
    for seat in seats:
        if seat["seatId"] != target:
            continue
        for name in ("playoffs", "total"):
            seat["splits"][name]["series"]["wins"] += 1
            seat["splits"][name]["series"]["losses"] -= 1
        seat["seriesWins"] += 1
        seat["seriesLosses"] -= 1
        seat["rewardValue"] += 2 / 9
    with pytest.raises(ProtocolError, match="zero-sum"):
        await env.finalize(task, inflated)
    assert all(not trace.rewards and not trace.metrics for trace in inflated.traces)


@pytest.mark.asyncio
async def test_referee_content_pins_gate_the_episode(monkeypatch: pytest.MonkeyPatch) -> None:
    env, task, _agents, _referee, episode, _concurrency = await _run(
        monkeypatch,
        expected_config_digest="c" * 64,
        expected_prompt_revision="prompt-v2",
    )
    await env.finalize(task, episode)
    assert all(trace.rewards for trace in episode.traces)
    with pytest.raises(ProtocolError, match="configDigest"):
        await _run(monkeypatch, expected_config_digest="d" * 64)
    with pytest.raises(ProtocolError, match="promptRevision"):
        await _run(monkeypatch, expected_prompt_revision="prompt-v1")


@pytest.mark.asyncio
async def test_provider_failure_and_runtime_alias_fail_without_reward(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(ProtocolError, match="one model turn"):
        await _run(monkeypatch, failed_role="seat8")
    with pytest.raises(ProtocolError, match="runtime ids must be distinct"):
        await _run(monkeypatch, duplicate_runtime=True)


def test_config_nine_roles_defaults_and_concurrency_floor() -> None:
    config = VgcCircuitEnvConfig()
    assert config.max_concurrent_agents == 8
    assert config.referee.runtime.image == DEFAULT_REFEREE_IMAGE
    assert config.referee_executable == DEFAULT_REFEREE_EXECUTABLE
    assert all(getattr(config, role).runtime.type == "docker" for role in _ROLES)
    assert config.expected_config_digest is None
    assert config.expected_prompt_revision is None
    with pytest.raises(ValidationError):
        VgcCircuitEnvConfig(expected_config_digest="not-a-digest")
    with pytest.raises(ValidationError):
        VgcCircuitEnvConfig(expected_prompt_revision="")
    with pytest.raises(ValidationError):
        VgcCircuitEnvConfig(max_concurrent_agents=7)
    with pytest.raises(ValidationError):
        VgcCircuitEnvConfig(
            seat1=vf.AgentConfig(harness=vf.HarnessConfig(id="bash"), runtime=vf.DockerConfig())
        )
    with pytest.raises(ValidationError):
        VgcCircuitEnvConfig(
            seat1=vf.AgentConfig(
                harness=vf.HarnessConfig(id="null"),
                runtime=vf.DockerConfig(),
                retries=vf.RetryConfig(max_retries=1),
            )
        )
    with pytest.raises(ValidationError):
        VgcCircuitEnvConfig(retries=vf.RetryConfig(max_retries=1))
    with pytest.raises(ValidationError, match="debug_allow_subprocess"):
        VgcCircuitEnvConfig(
            seat1=vf.AgentConfig(harness=vf.HarnessConfig(id="null"), runtime=vf.SubprocessConfig())
        )
