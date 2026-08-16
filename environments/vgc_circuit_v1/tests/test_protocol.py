from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, Callable

import pytest

from vgc_circuit_v1.protocol import (
    BATTLE_PROTOCOL_VERSION,
    CIRCUIT_PROTOCOL_VERSION,
    JSONL_PROTOCOL_VERSION,
    MATCHDAY_PROTOCOL_VERSION,
    PROMPT_PROTOCOL_VERSION,
    SCENARIO_IDS,
    SHOWDOWN_REVISION,
    ProtocolError,
    VgcCircuitProtocolClient,
)

_READY = {
    "kind": "ready",
    "protocolVersion": JSONL_PROTOCOL_VERSION,
    "circuitProtocolVersion": CIRCUIT_PROTOCOL_VERSION,
    "promptProtocolVersion": PROMPT_PROTOCOL_VERSION,
    "matchdayProtocolVersion": MATCHDAY_PROTOCOL_VERSION,
    "battleProtocolVersion": BATTLE_PROTOCOL_VERSION,
    "showdownRevision": SHOWDOWN_REVISION,
    "scenarios": list(SCENARIO_IDS),
}


def _encoded(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"


class FakeProcess:
    def __init__(
        self,
        chunks: list[bytes] | None = None,
        handler: Callable[[dict[str, Any], "FakeProcess"], Any] | None = None,
    ) -> None:
        self.stdout_queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        self.stderr_queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        for chunk in chunks or []:
            self.stdout_queue.put_nowait(chunk)
        self.stdout = self._stream(self.stdout_queue)
        self.stderr = self._stream(self.stderr_queue)
        self.handler = handler
        self.requests: list[dict[str, Any]] = []
        self.wait_future: asyncio.Future[int] = asyncio.get_running_loop().create_future()
        self.terminate_calls = 0
        self.kill_calls = 0
        self.terminate_impl: Callable[[], Any] | None = None

    async def _stream(self, queue: asyncio.Queue[bytes | None]) -> AsyncIterator[bytes]:
        while True:
            item = await queue.get()
            if item is None:
                return
            yield item

    def output(self, *chunks: bytes) -> None:
        for chunk in chunks:
            self.stdout_queue.put_nowait(chunk)

    def stderr_output(self, *chunks: bytes) -> None:
        for chunk in chunks:
            self.stderr_queue.put_nowait(chunk)

    def exit(self, code: int = 0) -> None:
        if not self.wait_future.done():
            self.wait_future.set_result(code)
        self.stdout_queue.put_nowait(None)
        self.stderr_queue.put_nowait(None)

    async def write(self, data: bytes) -> None:
        request = json.loads(data)
        self.requests.append(request)
        if self.handler is not None:
            result = self.handler(request, self)
            if asyncio.iscoroutine(result):
                await result

    async def wait(self) -> int:
        return await asyncio.shield(self.wait_future)

    async def terminate(self) -> None:
        self.terminate_calls += 1
        if self.terminate_impl is None:
            self.exit(0)
        else:
            await self.terminate_impl()

    async def kill(self) -> None:
        self.kill_calls += 1
        self.exit(-9)


class FakeRuntime:
    supports_live_processes = True

    def __init__(self, process: FakeProcess) -> None:
        self.process = process

    async def open_process(self, argv: list[str], env: dict[str, str]) -> FakeProcess:
        assert argv == ["referee"]
        assert env == {}
        return self.process


def _chunks(data: bytes) -> list[bytes]:
    cuts = [1, 7, max(8, len(data) // 2), len(data) - 1]
    points = [0, *sorted({cut for cut in cuts if 0 < cut < len(data)}), len(data)]
    return [data[start:end] for start, end in zip(points, points[1:])]


def _binding(params: dict[str, Any]) -> dict[str, Any]:
    return {
        "episodeId": params["episodeId"],
        "conditionDigest": params["conditionDigest"],
        "scenarioId": params["options"]["scenarioId"],
        "seed": params["options"]["seed"],
        "configDigest": "d" * 64,
        "showdownRevision": SHOWDOWN_REVISION,
        "jsonlProtocolVersion": JSONL_PROTOCOL_VERSION,
        "circuitProtocolVersion": CIRCUIT_PROTOCOL_VERSION,
        "promptProtocolVersion": PROMPT_PROTOCOL_VERSION,
        "matchdayProtocolVersion": MATCHDAY_PROTOCOL_VERSION,
        "battleProtocolVersion": BATTLE_PROTOCOL_VERSION,
        "promptRevision": "prompt-v1",
    }


async def _start(client: VgcCircuitProtocolClient) -> Any:
    return await client.start(
        episode_id="episode",
        condition_digest="a" * 64,
        scenario_id="draft-league-v1",
        seed=3,
    )


@pytest.mark.asyncio
async def test_fragmented_utf8_bound_runtime_process_and_exact_method_surface() -> None:
    binding: dict[str, Any] = {}

    async def handler(request: dict[str, Any], process: FakeProcess) -> None:
        nonlocal binding
        if request["method"] == "start":
            binding = _binding(request["params"])
            value: Any = {"started": True}
        else:
            value = {
                "turnId": "turn-雪",
                "seatId": request["params"].get("seatId", "seat-1"),
                "kind": "draft",
                "prompt": "雪だるま☃",
            }
        response = _encoded(
            {
                "id": request["id"],
                "ok": True,
                "result": {"binding": binding, "value": value},
            }
        )
        process.output(*_chunks(response))

    process = FakeProcess(_chunks(_encoded(_READY)), handler)
    client = await VgcCircuitProtocolClient.launch(
        FakeRuntime(process), executable="referee", line_limit=4096
    )
    async with client:
        assert await _start(client) == {"started": True}
        observations = await asyncio.gather(
            client.call("observe", {"seatId": "seat-1"}),
            client.call("observe", {"seatId": "seat-2"}),
        )
        assert [item["seatId"] for item in observations] == ["seat-1", "seat-2"]
        assert all(item["prompt"] == "雪だるま☃" for item in observations)
        assert client.binding is not None
        assert client.binding.to_wire() == binding
        with pytest.raises(ProtocolError, match="unsupported circuit method"):
            await client.call("legal_actions")
    assert [request["id"] for request in process.requests] == [1, 2, 3]
    assert [request["method"] for request in process.requests] == [
        "start",
        "observe",
        "observe",
    ]
    assert process.terminate_calls == 1


@pytest.mark.asyncio
async def test_binding_mismatch_timeout_and_shutdown_kill_fail_closed() -> None:
    binding: dict[str, Any] = {}

    def mismatch_handler(request: dict[str, Any], process: FakeProcess) -> None:
        nonlocal binding
        if request["method"] == "start":
            binding = _binding(request["params"])
            result = {"binding": binding, "value": {"started": True}}
        else:
            result = {
                "binding": {**binding, "episodeId": "tampered"},
                "value": [],
            }
        process.output(_encoded({"id": request["id"], "ok": True, "result": result}))

    mismatch_process = FakeProcess([_encoded(_READY)], mismatch_handler)
    mismatch = await VgcCircuitProtocolClient.launch(
        FakeRuntime(mismatch_process), executable="referee", shutdown_timeout=0.05
    )
    await _start(mismatch)
    with pytest.raises(ProtocolError, match="mismatched binding"):
        await mismatch.call("pending_turns")
    with pytest.raises(ProtocolError, match="poisoned"):
        await mismatch.call("pending_turns")
    await mismatch.aclose(check_protocol=False)

    silent = FakeProcess([_encoded(_READY)])
    client = await VgcCircuitProtocolClient.launch(
        FakeRuntime(silent),
        executable="referee",
        shutdown_timeout=0.05,
        request_timeout=0.02,
    )
    with pytest.raises(ProtocolError, match="did not produce response 1"):
        await _start(client)
    await client.aclose(check_protocol=False)

    hanging = FakeProcess([_encoded(_READY)])
    never = asyncio.Event()

    async def hang() -> None:
        await never.wait()

    hanging.terminate_impl = hang
    client = await VgcCircuitProtocolClient.launch(
        FakeRuntime(hanging), executable="referee", shutdown_timeout=0.01
    )
    await client.aclose(check_protocol=False)
    assert hanging.terminate_calls == 1
    assert hanging.kill_calls == 1


@pytest.mark.asyncio
async def test_start_rejects_unbound_config_digest() -> None:
    def handler(request: dict[str, Any], process: FakeProcess) -> None:
        binding = {**_binding(request["params"]), "configDigest": "not-a-digest"}
        process.output(
            _encoded(
                {
                    "id": request["id"],
                    "ok": True,
                    "result": {"binding": binding, "value": {"started": True}},
                }
            )
        )

    process = FakeProcess([_encoded(_READY)], handler)
    client = await VgcCircuitProtocolClient.launch(
        FakeRuntime(process), executable="referee", shutdown_timeout=0.05
    )
    with pytest.raises(ProtocolError, match="configDigest"):
        await _start(client)
    await client.aclose(check_protocol=False)


@pytest.mark.asyncio
async def test_oversized_output_and_early_process_exit_fail_closed() -> None:
    oversized = FakeProcess([b"{" + b"x" * 32])
    with pytest.raises(ProtocolError):
        await VgcCircuitProtocolClient.launch(
            FakeRuntime(oversized),
            executable="referee",
            line_limit=16,
            shutdown_timeout=0.05,
            request_timeout=0.05,
        )
    assert oversized.terminate_calls == 1

    binding: dict[str, Any] = {}

    def exit_handler(request: dict[str, Any], process: FakeProcess) -> None:
        nonlocal binding
        if request["method"] == "start":
            binding = _binding(request["params"])
            process.output(
                _encoded(
                    {
                        "id": request["id"],
                        "ok": True,
                        "result": {"binding": binding, "value": {"started": True}},
                    }
                )
            )
            return
        process.stderr_output(b"private referee failure")
        process.exit(17)

    exited = FakeProcess([_encoded(_READY)], exit_handler)
    client = await VgcCircuitProtocolClient.launch(
        FakeRuntime(exited), executable="referee", shutdown_timeout=0.05
    )
    await _start(client)
    with pytest.raises(ProtocolError):
        await client.call("pending_turns")
    await asyncio.sleep(0)
    assert b"private referee failure" in client.stderr_tail
    await client.aclose(check_protocol=False)


def test_showdown_revision_matches_repo_lock_when_present() -> None:
    lock_path = Path(__file__).resolve().parents[3] / "showdown.lock.json"
    if not lock_path.is_file():
        pytest.skip("standalone package checkout has no repository showdown lock")
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    assert SHOWDOWN_REVISION == lock["commit"]
