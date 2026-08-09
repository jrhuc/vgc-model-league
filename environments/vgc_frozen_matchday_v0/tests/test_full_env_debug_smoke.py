from __future__ import annotations

import copy
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import threading
import time
from contextlib import AbstractContextManager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version
from pathlib import Path
from typing import Any

import pytest
from verifiers import v1 as vf
from verifiers.v1.serve.pool import env_config_data
from verifiers.v1.serve.server import EnvServer

from vgc_frozen_matchday_v0.env import FrozenMatchdayEnv, FrozenMatchdayEnvConfig
from vgc_frozen_matchday_v0.scaffold import FORMAT_AUTHORITY_NOTICE
from vgc_frozen_matchday_v0.taskset import (
    FrozenMatchdayTask,
    FrozenMatchdayTaskset,
    FrozenMatchdayTasksetConfig,
)


_REPO_ROOT = Path(__file__).resolve().parents[3]
_FIXTURE = _REPO_ROOT / "dist/tests/fixtures/frozen-matchday.js"
_SERIALIZATION = _REPO_ROOT / "dist/src/eval/serialization.js"
_FREEZER = _REPO_ROOT / "dist/tools/freeze-frozen-matchday-task-source.js"
_REFEREE = _REPO_ROOT / "dist-matchday/tools/frozen-matchday-referee.js"
_REFEREE_MODULE = _REPO_ROOT / "dist-matchday/src/frozen-matchday-referee.js"
_PROVIDER_KEY_VAR = "VGC_FULL_SMOKE_NO_PROVIDER_CREDENTIAL"
_MODEL = "local-scripted-openai-compatible-smoke"
_HMAC = re.compile(r"hmac-sha256-v0:[0-9a-f]{64}")
_SOURCE_PRIVATE_NEEDLES = (
    '"options"',
    '"gameSeeds"',
    '"construction"',
    "alpha-construction",
    "beta-construction",
    "alpha-0",
    "beta-0",
    "frozen-matchday-test",
    "private-three-game-min-menu",
    "private-two-game-min-menu",
)
_INFO_KEYS = {
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
_SUMMARY_KEYS = {
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
_TERMINAL_PRIVATE_NEEDLES = (
    '"registrations"',
    '"gameSeeds"',
    '"authoritativeLog"',
    '"submittedActions"',
    '"notebookReceipts"',
    '"teamSha256"',
    '"constructionSha256"',
)


class ScriptedChatServer(AbstractContextManager["ScriptedChatServer"]):
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.errors: list[str] = []
        self._lock = threading.Lock()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, _format: str, *_args: Any) -> None:
                return None

            def do_POST(self) -> None:
                try:
                    if self.path != "/v1/chat/completions":
                        raise AssertionError(f"unexpected provider path {self.path!r}")
                    length = int(self.headers.get("Content-Length", "-1"))
                    if length < 0:
                        raise AssertionError("provider request lacks Content-Length")
                    body = json.loads(self.rfile.read(length))
                    if type(body) is not dict:
                        raise AssertionError("provider request body is not an object")
                    messages = body.get("messages")
                    if type(messages) is not list or len(messages) != 1:
                        raise AssertionError("fresh interaction did not send exactly one message")
                    message = messages[0]
                    if (
                        type(message) is not dict
                        or message.get("role") != "user"
                        or type(message.get("content")) is not str
                    ):
                        raise AssertionError("fresh interaction did not send one text user prompt")
                    prompt = message["content"]
                    if not prompt.startswith(FORMAT_AUTHORITY_NOTICE + "\n\n"):
                        raise AssertionError("provider prompt lacks the authorized format notice")
                    prompt_payload = json.loads(prompt.rsplit("\n\n", 1)[1])
                    if type(prompt_payload) is not dict:
                        raise AssertionError("authorized prompt payload is not an object")
                    phase = prompt_payload.get("phase")
                    if phase == "playing":
                        if set(prompt_payload) != {
                            "phase",
                            "gameNumber",
                            "score",
                            "povHistory",
                            "request",
                            "currentNotebook",
                            "menu",
                        }:
                            raise AssertionError("playing prompt has an unexpected schema")
                        menu = prompt_payload["menu"]
                        if type(menu) is not list or not menu:
                            raise AssertionError("playing prompt lacks a legal menu")
                        numbers = [entry.get("number") for entry in menu]
                        if any(type(number) is not int for number in numbers):
                            raise AssertionError("playing prompt has a non-integer menu number")
                        reply = json.dumps(
                            {"choice": min(numbers)}, separators=(",", ":")
                        )
                    elif phase == "between-games":
                        if set(prompt_payload) != {
                            "phase",
                            "completedGameNumber",
                            "score",
                            "povHistory",
                            "currentNotebook",
                        }:
                            raise AssertionError("between-games prompt has an unexpected schema")
                        reply = "{}"
                    else:
                        raise AssertionError(f"unexpected prompt phase {phase!r}")
                    record = copy.deepcopy(body)
                    record["_smoke_prompt_payload"] = prompt_payload
                    record["_smoke_reply"] = reply
                    with owner._lock:
                        owner.requests.append(record)
                    response = {
                        "id": f"chatcmpl-local-{len(owner.requests)}",
                        "object": "chat.completion",
                        "created": 0,
                        "model": body.get("model", _MODEL),
                        "choices": [
                            {
                                "index": 0,
                                "message": {"role": "assistant", "content": reply},
                                "finish_reason": "stop",
                            }
                        ],
                        "usage": {
                            "prompt_tokens": 1,
                            "completion_tokens": 1,
                            "total_tokens": 2,
                        },
                    }
                    encoded = json.dumps(response, separators=(",", ":")).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(encoded)))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.wfile.write(encoded)
                except BaseException as exc:
                    with owner._lock:
                        owner.errors.append(f"{type(exc).__name__}: {exc}")
                    encoded = json.dumps(
                        {"error": {"message": str(exc), "type": "invalid_request_error"}},
                        separators=(",", ":"),
                    ).encode()
                    self.send_response(400)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(encoded)))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.wfile.write(encoded)

        class Server(ThreadingHTTPServer):
            daemon_threads = True
            allow_reuse_address = False

        self.httpd = Server(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(
            target=self.httpd.serve_forever,
            name="vgc-full-smoke-scripted-chat",
            daemon=False,
        )
        self.port = int(self.httpd.server_address[1])

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}/v1"

    def __enter__(self) -> "ScriptedChatServer":
        self.thread.start()
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)

    def snapshot(self) -> list[dict[str, Any]]:
        with self._lock:
            return copy.deepcopy(self.requests)



def _compiled_inputs() -> Path:
    node_name = shutil.which("node")
    required = [
        _FIXTURE,
        _SERIALIZATION,
        _FREEZER,
        _REFEREE,
        _REFEREE_MODULE,
        _REPO_ROOT / "dist/src/eval/frozen-matchday-task-source.js",
        _REPO_ROOT / "dist/src/eval/producer.js",
        _REPO_ROOT / "pokemon-showdown/dist/sim/index.js",
    ]
    missing = [str(path.relative_to(_REPO_ROOT)) for path in required if not path.is_file()]
    if node_name is None:
        missing.append("node executable on PATH")
    if missing:
        reason = "compiled full-smoke inputs are absent: " + ", ".join(missing)
        if os.environ.get("VGC_REQUIRE_COMPILED_SMOKE") == "1":
            pytest.fail(reason)
        pytest.skip(
            reason
            + "; run pnpm run setup:showdown && pnpm run build && pnpm run build:frozen-matchday"
        )
    return Path(node_name).resolve()



def _freeze_source(node: Path, tmp_path: Path) -> Path:
    private = tmp_path / "private-full-smoke"
    private.mkdir(mode=0o700)
    private.chmod(0o700)
    input_file = private / "source.json"
    output_root = private / "frozen"
    helper = r'''
import fs from "node:fs";
import * as fixture from __FIXTURE__;
import { canonicalJson } from __SERIALIZATION__;
const original = fixture.frozenMatchdayOptions();
const twoGames = {
  ...original,
  gameSeeds: [original.gameSeeds[0], original.gameSeeds[2], original.gameSeeds[1]],
};
const source = {
  schema_version: 1,
  source_id: "local-scripted-full-smoke",
  conditions: [
    { condition_id: "scripted-self-play", definition: { opponent_policy: "scripted-minimum-menu" } },
  ],
  cases: [
    {
      case_id: "three-game-min-menu",
      condition_id: "scripted-self-play",
      options: original,
      provenance: {
        source: "private-three-game-min-menu",
        seed_source: "compiled-fixture-order",
      },
    },
    {
      case_id: "two-game-min-menu",
      condition_id: "scripted-self-play",
      options: twoGames,
      provenance: {
        source: "private-two-game-min-menu",
        seed_source: "compiled-fixture-reordered",
      },
    },
  ],
};
fs.writeFileSync(process.argv[1], `${canonicalJson(source)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`${JSON.stringify({ rows: source.cases.length })}\n`);
'''
    helper = helper.replace("__FIXTURE__", json.dumps(_FIXTURE.as_uri())).replace(
        "__SERIALIZATION__", json.dumps(_SERIALIZATION.as_uri())
    )
    environment = os.environ.copy()
    environment.pop("FORCE_COLOR", None)
    environment["NO_COLOR"] = "1"
    exported = subprocess.run(
        [str(node), "--input-type=module", "--eval", helper, str(input_file)],
        cwd=_REPO_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert exported.returncode == 0, exported.stderr
    assert exported.stderr == ""
    assert json.loads(exported.stdout) == {"rows": 2}
    assert input_file.stat().st_mode & 0o7777 == 0o600

    frozen = subprocess.run(
        [
            str(node),
            str(_FREEZER),
            "--input",
            str(input_file),
            "--out",
            str(output_root),
        ],
        cwd=_REPO_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert frozen.returncode == 0, f"{frozen.stdout}\n{frozen.stderr}"
    assert frozen.stderr == ""
    result = json.loads(frozen.stdout)
    assert result["rows"] == 2
    assert result["outputRoot"] == str(output_root.resolve())
    assert result["identicalRerun"] is False
    assert re.fullmatch(r"[0-9a-f]{64}", result["taskSourceSha256"])
    return output_root / "task-source.jsonl"



def _agent_config() -> vf.AgentConfig:
    return vf.AgentConfig(
        harness=vf.HarnessConfig(id="null"),
        runtime=vf.SubprocessConfig(),
        retries=vf.RetryConfig(max_retries=0),
    )



def _make_wrapper(node: Path, tmp_path: Path) -> tuple[Path, Path]:
    pid_file = tmp_path / "referee-pids"
    wrapper = tmp_path / "vgc-frozen-matchday-referee"
    wrapper.write_text(
        "#!/bin/sh\n"
        f"printf '%s\\n' \"$$\" >> {shlex.quote(str(pid_file))}\n"
        f"exec {shlex.quote(str(node))} {shlex.quote(str(_REFEREE))}\n",
        encoding="utf-8",
    )
    wrapper.chmod(0o700)
    assert wrapper.is_absolute()
    return wrapper, pid_file



def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))



def _assert_no_source_private_material(value: Any) -> None:
    encoded = _json(value)
    for needle in _SOURCE_PRIVATE_NEEDLES:
        assert needle not in encoded



def _assert_hmac(value: Any) -> None:
    assert type(value) is str and _HMAC.fullmatch(value)



def _assert_episode(
    episode: vf.Episode,
    task: FrozenMatchdayTask,
    provider_requests: list[dict[str, Any]],
    *,
    expected_games: int,
    provider_base_url: str,
    source_path: Path,
    wrapper: Path,
) -> dict[str, str]:
    assert type(episode) is vf.Episode
    assert episode.ok is True
    assert episode.errors == []
    assert episode.traces
    assert len(provider_requests) == len(episode.traces)
    assert set(trace.agent.name for trace in episode.traces) == {"entrant", "opponent"}
    assert all(type(trace) is vf.Trace for trace in episode.traces)
    assert all(trace.ok and trace.errors == [] and trace.num_turns == 1 for trace in episode.traces)
    assert all(trace.agent.trainable is False for trace in episode.traces)

    public_data = task.data.model_dump(mode="json")
    assert "options" not in public_data
    _assert_no_source_private_material(public_data)
    public_encoded = _json(public_data)
    assert provider_base_url not in public_encoded
    assert _PROVIDER_KEY_VAR not in public_encoded
    assert str(source_path) not in public_encoded
    assert str(wrapper) not in public_encoded
    assert "alpha initial notebook" not in public_encoded
    assert "beta initial notebook" not in public_encoded

    traces_by_pid = {
        "p1": [trace for trace in episode.traces if trace.agent.name == "entrant"],
        "p2": [trace for trace in episode.traces if trace.agent.name == "opponent"],
    }
    runtime_ids = episode.traces[0].info["referee_runtime_ids"]
    runtime_types = episode.traces[0].info["referee_runtime_types"]
    assert type(runtime_ids) is dict and set(runtime_ids) == {"entrant", "opponent", "referee"}
    assert len(set(runtime_ids.values())) == 3
    assert type(runtime_types) is dict and runtime_types == {
        "entrant": "subprocess",
        "opponent": "subprocess",
        "referee": "subprocess",
    }
    assert all(Path(runtime_id).is_absolute() for runtime_id in runtime_ids.values())

    common_stamps = episode.traces[0].info["agent_identity_stamps"]
    assert type(common_stamps) is dict and set(common_stamps) == {
        "entrant",
        "opponent",
        "referee",
    }
    for stamp in common_stamps.values():
        _assert_hmac(stamp)
    assert len(set(common_stamps.values())) == 1
    for key in (
        "agent_identity_evidence_seal",
        "controller_policy_seal",
        "episode_evidence_seal",
    ):
        _assert_hmac(episode.traces[0].info[key])

    role_partitions: dict[str, dict[str, Any]] = {}
    carrier_scores: dict[str, float] = {}
    for pid, traces in traces_by_pid.items():
        assert traces
        role = "entrant" if pid == "p1" else "opponent"
        own_notebook = "alpha initial notebook" if pid == "p1" else "beta initial notebook"
        opposing_notebook = "beta initial notebook" if pid == "p1" else "alpha initial notebook"
        carriers = [trace for trace in traces if trace.info["matchday_reward_carrier"]]
        assert len(carriers) == 1
        carrier = carriers[0]
        assert set(carrier.rewards) == {"matchday_outcome_v0"}
        assert carrier.metrics == {
            "matchday_games_v0": float(expected_games),
            "matchday_result_v0": carrier.rewards["matchday_outcome_v0"].score,
        }
        carrier_scores[pid] = carrier.rewards["matchday_outcome_v0"].score
        for trace in traces:
            info = trace.info
            assert set(info) == _INFO_KEYS
            assert info["referee_pid"] == pid
            assert info["referee_kind"] in {"action", "notebook"}
            assert info["referee_transport"] == "debug-subprocess"
            assert info["referee_runtime_ids"] == runtime_ids
            assert info["referee_runtime_types"] == runtime_types
            assert info["opponent_condition"] == "self_play"
            assert info["agent_identity_stamps"] == common_stamps
            assert info["agent_identity_evidence_seal"] == episode.traces[0].info[
                "agent_identity_evidence_seal"
            ]
            assert info["controller_policy_seal"] == episode.traces[0].info[
                "controller_policy_seal"
            ]
            assert info["episode_evidence_seal"] == episode.traces[0].info[
                "episode_evidence_seal"
            ]
            assert info["referee_binding"]["configDigest"] == task.data.expected_config_digest
            assert info["referee_join"]["pid"] == pid
            assert trace.agent.runtime is not None
            assert trace.agent.runtime.type == "subprocess"
            assert trace.agent.runtime.id == runtime_ids[role]
            assert trace.agent.runtime.borrowed is True
            assert trace.agent.config.runtime.type == "subprocess"
            assert trace.agent.config.harness.id == "null"
            assert trace.agent.config.retries.max_retries == 0
            assert trace.agent.config.client is not None
            assert trace.agent.config.client.base_url == provider_base_url
            assert trace.agent.config.client.api_key_var == _PROVIDER_KEY_VAR
            assert trace.agent.config.client.headers == {}
            summary = info["referee_terminal_summary"]
            assert set(summary) == _SUMMARY_KEYS
            assert summary["games_count"] == expected_games
            assert len(summary["game_results"]) == expected_games
            assert "accepted_actions" not in summary
            assert "notebook_receipts" not in summary
            partition = info["referee_role_partition"]
            assert set(partition) == {
                "pid",
                "expected_actions",
                "expected_notebook_receipts",
            }
            assert partition["pid"] == pid
            assert all(action["pid"] == pid for action in partition["expected_actions"])
            assert all(
                receipt["pid"] == pid
                for receipt in partition["expected_notebook_receipts"]
            )
            assert len(partition["expected_notebook_receipts"]) == expected_games - 1
            if pid not in role_partitions:
                role_partitions[pid] = partition
            else:
                assert partition == role_partitions[pid]
            trace_encoded = _json(trace.model_dump(mode="json"))
            for needle in (*_SOURCE_PRIVATE_NEEDLES, *_TERMINAL_PRIVATE_NEEDLES):
                assert needle not in trace_encoded
            assert not re.search(r"(?:alpha|beta)-[0-5]", trace_encoded)
            assert opposing_notebook not in trace_encoded
            if info["referee_kind"] == "action":
                assert own_notebook in trace_encoded
            if trace is not carrier:
                assert trace.rewards == {}
                assert trace.metrics == {}

    assert carrier_scores == {"p1": 1.0, "p2": -1.0}
    for pid, opposite in (("p1", "p2"), ("p2", "p1")):
        encoded = _json(role_partitions[pid])
        own_hashes = {
            receipt["notebook_sha256"]
            for receipt in role_partitions[pid]["expected_notebook_receipts"]
        }
        opposite_hashes = {
            receipt["notebook_sha256"]
            for receipt in role_partitions[opposite]["expected_notebook_receipts"]
        }
        assert own_hashes
        assert own_hashes.isdisjoint(opposite_hashes)
        assert all(value not in encoded for value in opposite_hashes)

    for request in provider_requests:
        prompt_payload = request.pop("_smoke_prompt_payload")
        reply = request.pop("_smoke_reply")
        assert set(request["messages"][0]) >= {"role", "content"}
        assert request["messages"][0]["role"] == "user"
        assert len(request["messages"]) == 1
        assert all(message["role"] != "assistant" for message in request["messages"])
        assert request["model"] == _MODEL
        assert request.get("stream") in {None, False}
        assert request.get("tools") in {None, ()}
        if prompt_payload["phase"] == "playing":
            numbers = [entry["number"] for entry in prompt_payload["menu"]]
            assert json.loads(reply) == {"choice": min(numbers)}
        else:
            assert reply == "{}"
        body_encoded = _json(request)
        for needle in _SOURCE_PRIVATE_NEEDLES:
            assert needle not in body_encoded
        assert provider_base_url not in body_encoded
        assert _PROVIDER_KEY_VAR not in body_encoded
        assert '"base_url"' not in body_encoded
        assert '"api_key_var"' not in body_encoded
        assert '"headers"' not in body_encoded
        assert str(source_path) not in body_encoded
        assert str(wrapper) not in body_encoded
        current_notebook = prompt_payload["currentNotebook"]
        if current_notebook == "alpha initial notebook":
            assert "beta initial notebook" not in body_encoded
        elif current_notebook == "beta initial notebook":
            assert "alpha initial notebook" not in body_encoded
        else:
            raise AssertionError("scripted provider received an unknown role notebook")

    assert sum(1 for trace in episode.traces if trace.info["referee_kind"] == "notebook") == 2 * (
        expected_games - 1
    )
    return runtime_ids



def _process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


@pytest.mark.asyncio
async def test_full_env_debug_subprocess_with_scripted_openai_compatible_server(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert version("verifiers") == "0.3.0"
    node = _compiled_inputs()
    monkeypatch.delenv("FORCE_COLOR", raising=False)
    monkeypatch.setenv("NO_COLOR", "1")
    monkeypatch.delenv(_PROVIDER_KEY_VAR, raising=False)
    source = _freeze_source(node, tmp_path)
    wrapper, pid_file = _make_wrapper(node, tmp_path)

    taskset_config = FrozenMatchdayTasksetConfig(
        id="vgc-frozen-matchday-v0", source=source
    )
    client_tasks = list(FrozenMatchdayTaskset(taskset_config))
    assert [task.data.case_id for task in client_tasks] == [
        "three-game-min-menu",
        "two-game-min-menu",
    ]

    all_runtime_ids: list[str] = []
    episode_trace_counts: dict[str, int] = {}
    episode_provider_counts: dict[str, int] = {}
    scripted = ScriptedChatServer()
    with scripted:
        client = vf.EvalClientConfig(
            base_url=scripted.base_url,
            api_key_var=_PROVIDER_KEY_VAR,
            headers={},
        )
        config = FrozenMatchdayEnvConfig(
            taskset=taskset_config,
            entrant=_agent_config(),
            opponent=_agent_config(),
            referee=_agent_config(),
            referee_executable=str(wrapper),
            debug_allow_subprocess=True,
        )
        rebuilt = vf.resolve_env_config(
            json.loads(json.dumps(env_config_data(config)))
        )
        server = EnvServer(rebuilt, address="tcp://127.0.0.1:0")
        try:
            env = server.env
            assert type(env) is FrozenMatchdayEnv
            ctx = server._context(client, _MODEL, vf.SamplingConfig())
            before = 0
            async with env.serving():
                for client_task in client_tasks:
                    wire_data = json.loads(
                        json.dumps(client_task.data.model_dump(mode="json"))
                    )
                    task = server._build_task(wire_data)
                    assert type(task) is FrozenMatchdayTask
                    expected_games = {
                        "three-game-min-menu": 3,
                        "two-game-min-menu": 2,
                    }[task.data.case_id]
                    episode = await env.run_episode(task, ctx)
                    requests = scripted.snapshot()
                    current = requests[before:]
                    before = len(requests)
                    ids = _assert_episode(
                        episode,
                        task,
                        current,
                        expected_games=expected_games,
                        provider_base_url=scripted.base_url,
                        source_path=source,
                        wrapper=wrapper,
                    )
                    all_runtime_ids.extend(ids.values())
                    episode_trace_counts[task.data.case_id] = len(episode.traces)
                    episode_provider_counts[task.data.case_id] = len(current)
                    assert all(not Path(runtime_id).exists() for runtime_id in ids.values())
            assert env._interception is None
            assert env._shared_tools == {}
            assert scripted.errors == []
        finally:
            server.frontend.close()
            server.ctx.term()
        assert server.frontend.closed
        assert server.ctx.closed

    assert not scripted.thread.is_alive()
    with socket.socket() as probe:
        probe.settimeout(0.2)
        assert probe.connect_ex(("127.0.0.1", scripted.port)) != 0
    assert len(all_runtime_ids) == 6
    assert len(set(all_runtime_ids)) == 6
    assert all(not Path(runtime_id).exists() for runtime_id in all_runtime_ids)
    pids = [int(line) for line in pid_file.read_text(encoding="utf-8").splitlines()]
    assert len(pids) == 2
    for _ in range(50):
        if all(not _process_alive(pid) for pid in pids):
            break
        time.sleep(0.01)
    assert all(not _process_alive(pid) for pid in pids)
    assert episode_trace_counts == episode_provider_counts
    print(
        "full debug smoke trace/provider turns "
        f"{episode_trace_counts}; cleanup=2 referee processes, 6 runtimes, 1 provider server"
    )
