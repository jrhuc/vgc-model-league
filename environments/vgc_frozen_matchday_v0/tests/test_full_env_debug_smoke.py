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
_PRIVATE_NEEDLES = (
    '"options"',
    '"gameSeeds"',
    '"registrations"',
    '"authoritativeLog"',
    '"submittedActions"',
    '"notebookReceipts"',
    "alpha-construction",
    "beta-construction",
    "PRIVATE_SOURCE_PROVENANCE",
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
        pytest.fail(
            "required root full-smoke inputs are absent: "
            + ", ".join(missing)
            + "; run pnpm test before the package suite"
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
const source = {
  schema_version: 1,
  source_id: "required-three-game-full-smoke",
  conditions: [
    { condition_id: "scripted-self-play", definition: { opponent_policy: "scripted-minimum-menu" } },
  ],
  cases: [
    {
      case_id: "three-game-min-menu",
      condition_id: "scripted-self-play",
      options: original,
      provenance: {
        source: "PRIVATE_SOURCE_PROVENANCE",
        seed_source: "compiled-fixture-order",
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
    assert json.loads(exported.stdout) == {"rows": 1}
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
    assert result["rows"] == 1
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


def _assert_episode(
    episode: vf.Episode,
    task: FrozenMatchdayTask,
    provider_requests: list[dict[str, Any]],
    *,
    provider_base_url: str,
    source_path: Path,
    wrapper: Path,
) -> dict[str, str]:
    assert episode.ok is True and episode.errors == []
    assert episode.traces and len(provider_requests) == len(episode.traces)
    assert set(trace.agent.name for trace in episode.traces) == {"entrant", "opponent"}
    assert all(trace.ok and trace.num_turns == 1 for trace in episode.traces)
    assert all(trace.agent.trainable is False for trace in episode.traces)
    public = task.data.model_dump(mode="json")
    assert "options" not in public
    assert "PRIVATE_SOURCE_PROVENANCE" not in _json(public)

    carriers = [
        trace for trace in episode.traces if trace.info["matchday_v0"]["carrier"]
    ]
    assert len(carriers) == 2
    assert {trace.agent.name for trace in carriers} == {"entrant", "opponent"}
    terminal = carriers[0].info["matchday_v0"]["terminal"]
    assert terminal == carriers[1].info["matchday_v0"]["terminal"]
    assert terminal["games"] == 3
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
    runtime_ids = carriers[0].info["matchday_v0"]["runtime_ids"]
    assert set(runtime_ids) == {"entrant", "opponent", "referee"}
    assert len(set(runtime_ids.values())) == 3

    for trace in episode.traces:
        assert set(trace.info) == {"matchday_v0"}
        evidence = trace.info["matchday_v0"]
        assert evidence["transport"] == "debug-subprocess"
        assert evidence["runtime_ids"] == runtime_ids
        assert trace.agent.runtime is not None
        assert trace.agent.runtime.id == runtime_ids[trace.agent.name]
        assert trace.agent.runtime.borrowed is True
        assert trace.agent.config.harness.id == "null"
        assert trace.agent.config.retries.max_retries == 0
        assert trace.agent.config.client is not None
        assert trace.agent.config.client.headers == {}
        assert trace.agent.config.client.base_url == provider_base_url
        assert trace.agent.config.client.api_key_var == _PROVIDER_KEY_VAR
        encoded = _json(trace.model_dump(mode="json"))
        for needle in _PRIVATE_NEEDLES:
            assert needle not in encoded
        assert str(source_path) not in encoded
        assert str(wrapper) not in encoded
        if evidence["carrier"]:
            pid = evidence["pid"]
            assert all(join["pid"] == pid for join in evidence["accepted_joins"])
            expected = 1.0 if pid == "p1" else -1.0
            assert trace.rewards["matchday_outcome_v0"].score == expected
            assert trace.metrics == {
                "matchday_games_v0": 3.0,
                "matchday_result_v0": expected,
            }
        else:
            assert "terminal" not in evidence
            assert trace.rewards == {} and trace.metrics == {}

    for request in provider_requests:
        payload = request.pop("_smoke_prompt_payload")
        request.pop("_smoke_reply")
        assert request["model"] == _MODEL
        assert len(request["messages"]) == 1
        assert request["messages"][0]["role"] == "user"
        assert payload["phase"] in {"playing", "between-games"}
        encoded = _json(request)
        for needle in _PRIVATE_NEEDLES:
            assert needle not in encoded
        assert provider_base_url not in encoded
        assert _PROVIDER_KEY_VAR not in encoded
        assert str(source_path) not in encoded
        assert str(wrapper) not in encoded
        notebook = payload["currentNotebook"]
        if notebook == "alpha initial notebook":
            assert "beta initial notebook" not in encoded
        elif notebook == "beta initial notebook":
            assert "alpha initial notebook" not in encoded
        else:
            raise AssertionError("provider received an unknown role notebook")
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
async def test_required_three_game_real_freezer_envserver_runtimes_provider_referee(
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
    taskset = FrozenMatchdayTasksetConfig(
        id="vgc-frozen-matchday-v0", source=source
    )
    client_task = next(iter(FrozenMatchdayTaskset(taskset)))
    assert client_task.data.case_id == "three-game-min-menu"

    scripted = ScriptedChatServer()
    episode: vf.Episode | None = None
    runtime_ids: dict[str, str] = {}
    with scripted:
        client = vf.EvalClientConfig(
            base_url=scripted.base_url,
            api_key_var=_PROVIDER_KEY_VAR,
            headers={},
        )
        config = FrozenMatchdayEnvConfig(
            taskset=taskset,
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
            task = server._build_task(
                json.loads(json.dumps(client_task.data.model_dump(mode="json")))
            )
            assert type(task) is FrozenMatchdayTask
            ctx = server._context(client, _MODEL, vf.SamplingConfig())
            async with env.serving():
                episode = await env.run_episode(task, ctx)
            runtime_ids = _assert_episode(
                episode,
                task,
                scripted.snapshot(),
                provider_base_url=scripted.base_url,
                source_path=source,
                wrapper=wrapper,
            )
            assert env._interception is None and env._shared_tools == {}
            assert scripted.errors == []
        finally:
            server.frontend.close()
            server.ctx.term()
        assert server.frontend.closed and server.ctx.closed

    assert episode is not None
    assert not scripted.thread.is_alive()
    with socket.socket() as probe:
        probe.settimeout(0.2)
        assert probe.connect_ex(("127.0.0.1", scripted.port)) != 0
    assert all(not Path(runtime_id).exists() for runtime_id in runtime_ids.values())
    pids = [int(line) for line in pid_file.read_text(encoding="utf-8").splitlines()]
    assert len(pids) == 1
    for _ in range(50):
        if not _process_alive(pids[0]):
            break
        time.sleep(0.01)
    assert not _process_alive(pids[0])
