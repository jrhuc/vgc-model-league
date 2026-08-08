from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Any

import pytest
from verifiers.v1.runtimes.subprocess import SubprocessConfig, SubprocessRuntime

from vgc_frozen_matchday_v0.protocol import (
    BATTLE_PROTOCOL_VERSION,
    FROZEN_MATCHDAY_FORMAT,
    JSONL_PROTOCOL_VERSION,
    MATCHDAY_PROTOCOL_VERSION,
    SHOWDOWN_REVISION,
    FrozenMatchdayProtocolClient,
)


_REPO_ROOT = Path(__file__).resolve().parents[3]
_REFEREE = _REPO_ROOT / "dist-matchday/tools/frozen-matchday-referee.js"
_FIXTURE = _REPO_ROOT / "dist/tests/fixtures/frozen-matchday.js"
_REFEREE_MODULE = _REPO_ROOT / "dist-matchday/src/frozen-matchday-referee.js"


def _compiled_inputs() -> tuple[Path, dict[str, Any], str]:
    node_name = shutil.which("node")
    required = [
        _REFEREE,
        _FIXTURE,
        _REFEREE_MODULE,
        _REPO_ROOT / "pokemon-showdown/dist/sim/index.js",
    ]
    missing = [str(path.relative_to(_REPO_ROOT)) for path in required if not path.is_file()]
    if node_name is None:
        missing.append("node executable on PATH")
    if missing:
        reason = "compiled smoke inputs are absent: " + ", ".join(missing)
        if os.environ.get("VGC_REQUIRE_COMPILED_SMOKE") == "1":
            pytest.fail(reason)
        pytest.skip(reason + "; run pnpm run setup:showdown && pnpm run build && pnpm run build:frozen-matchday")

    node = Path(node_name).resolve()
    source = f"""
const fixture = await import({json.dumps(_FIXTURE.as_uri())});
const production = await import({json.dumps(_REFEREE_MODULE.as_uri())});
const options = fixture.frozenMatchdayOptions();
const referee = new production.FrozenMatchdayReferee(options);
process.stdout.write(JSON.stringify({{
  options,
  configDigest: referee.configDigest,
  format: fixture.MATCHDAY_FORMAT,
}}));
"""
    environment = os.environ.copy()
    environment.pop("FORCE_COLOR", None)
    environment["NO_COLOR"] = "1"
    completed = subprocess.run(
        [str(node), "--input-type=module", "--eval", source],
        cwd=_REPO_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    assert completed.stderr == ""
    generated = json.loads(completed.stdout)
    assert generated["format"] == FROZEN_MATCHDAY_FORMAT
    assert isinstance(generated["options"], dict)
    assert isinstance(generated["configDigest"], str)
    return node, generated["options"], generated["configDigest"]


def _object(value: Any) -> dict[str, Any]:
    assert isinstance(value, dict)
    return value


@pytest.mark.asyncio
async def test_compiled_referee_over_v03_subprocess_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    node, options, config_digest = _compiled_inputs()
    monkeypatch.delenv("FORCE_COLOR", raising=False)
    monkeypatch.setenv("NO_COLOR", "1")

    assert (JSONL_PROTOCOL_VERSION, MATCHDAY_PROTOCOL_VERSION, BATTLE_PROTOCOL_VERSION) == (1, 2, 2)
    condition_digest = "d" * 64
    episode_id = "compiled-smoke"
    runtime = SubprocessRuntime(
        SubprocessConfig(), name=f"vgc-compiled-smoke-{uuid.uuid4().hex}"
    )
    await runtime.start()
    client: FrozenMatchdayProtocolClient | None = None
    try:
        assert runtime.workdir is not None
        wrapper = runtime.workdir / "vgc-frozen-matchday-referee"
        wrapper.write_text(
            "#!/usr/bin/env sh\n"
            f"exec {shlex.quote(str(node))} {shlex.quote(str(_REFEREE))}\n",
            encoding="utf-8",
        )
        wrapper.chmod(0o700)

        client = await FrozenMatchdayProtocolClient.launch(
            runtime,
            executable=str(wrapper),
            showdown_revision=SHOWDOWN_REVISION,
            jsonl_protocol_version=JSONL_PROTOCOL_VERSION,
            matchday_protocol_version=MATCHDAY_PROTOCOL_VERSION,
            battle_protocol_version=BATTLE_PROTOCOL_VERSION,
        )
        async with client:
            started = _object(
                (
                    await client.start(
                        episode_id=episode_id,
                        condition_digest=condition_digest,
                        expected_config_digest=config_digest,
                        showdown_revision=SHOWDOWN_REVISION,
                        options=options,
                    )
                ).value
            )
            assert started["started"] is True
            assert client.binding is not None
            assert client.binding.to_wire() == {
                "episodeId": episode_id,
                "conditionDigest": condition_digest,
                "configDigest": config_digest,
                "showdownRevision": SHOWDOWN_REVISION,
                "matchdayProtocolVersion": 2,
                "battleProtocolVersion": 2,
            }

            omitted_notebooks = 0
            terminal: dict[str, Any] | None = None
            for _step in range(200):
                observations = {
                    pid: _object((await client.call("observe", {"pid": pid})).value)
                    for pid in ("p1", "p2")
                }
                assert observations["p1"]["phase"] == observations["p2"]["phase"]
                phase = observations["p1"]["phase"]
                if phase == "terminal":
                    terminal = _object((await client.call("terminal")).value)
                    break
                if phase == "between-games":
                    notebooks_before: dict[str, str] = {}
                    for pid in ("p1", "p2"):
                        observation = _object(
                            (await client.call("observe", {"pid": pid})).value
                        )
                        before = _object(
                            (await client.call("private_evidence", {"pid": pid})).value
                        )
                        notebooks_before[pid] = before["currentNotebook"]
                        result = _object(
                            (
                                await client.call(
                                    "ready_next_game",
                                    {
                                        "pid": pid,
                                        "expectedRevision": observation["revision"],
                                        "expectedStateHash": observation["stateHash"],
                                    },
                                )
                            ).value
                        )
                        assert isinstance(result["advanced"], bool)
                        omitted_notebooks += 1
                    for pid, notebook_before in notebooks_before.items():
                        after = _object(
                            (await client.call("private_evidence", {"pid": pid})).value
                        )
                        assert after["currentNotebook"] == notebook_before
                    continue

                assert phase == "playing"
                submitted = 0
                for pid in ("p1", "p2"):
                    battle = _object(observations[pid]["battle"])
                    request = battle["request"]
                    if request is None or request.get("wait") is True:
                        continue
                    legal = _object((await client.call("legal_actions", {"pid": pid})).value)
                    actions = legal["actions"]
                    assert isinstance(actions, list) and actions
                    assert [action["number"] for action in actions] == sorted(
                        action["number"] for action in actions
                    )
                    first = _object(actions[0])
                    result = _object(
                        (
                            await client.call(
                                "submit",
                                {
                                    "pid": pid,
                                    "command": first["command"],
                                    "expectedRevision": legal["revision"],
                                    "expectedStateHash": legal["stateHash"],
                                },
                            )
                        ).value
                    )
                    assert isinstance(result["advanced"], bool)
                    submitted += 1
                assert submitted > 0
            assert terminal is not None, "compiled referee did not reach terminal in 200 decisions"
            assert terminal["protocolVersion"] == MATCHDAY_PROTOCOL_VERSION
            assert terminal["battleProtocolVersion"] == BATTLE_PROTOCOL_VERSION
            assert terminal["showdownRevision"] == SHOWDOWN_REVISION
            assert terminal["format"] == FROZEN_MATCHDAY_FORMAT
            assert terminal["configDigest"] == config_digest
            games = terminal["games"]
            assert isinstance(games, list) and len(games) in {2, 3}
            assert all(game["protocolVersion"] == BATTLE_PROTOCOL_VERSION for game in games)
            receipts = terminal["notebookReceipts"]
            assert {seat["pid"] for seat in receipts} == {"p1", "p2"}
            assert all(
                interval["supplied"] is False
                for seat in receipts
                for interval in seat["intervals"]
            )
            assert omitted_notebooks == 2 * (len(games) - 1)
            assert client.transport.stderr_tail == b""
            assert client.transport._poison is None
            assert not client.transport._wait_task.done()

        assert client.transport.stderr_tail == b""
        assert client.transport._closed
        assert client.transport._wait_task.done()
        assert client.transport._wait_task.result() in {0, -15}
    finally:
        if client is not None and not client.transport._closed:
            await client.transport.aclose(check_protocol=False)
        await runtime.stop()
