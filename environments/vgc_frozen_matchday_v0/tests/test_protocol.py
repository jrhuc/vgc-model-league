from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any, Callable

import pytest

from vgc_frozen_matchday_v0.protocol import (
    BATTLE_PROTOCOL_VERSION,
    JSONL_PROTOCOL_VERSION,
    MATCHDAY_PROTOCOL_VERSION,
    MAX_ENCODED_LINE_BYTES,
    SHOWDOWN_REVISION,
    FrozenMatchdayProtocolClient,
    ProtocolError,
)

_READY = {
    "kind": "ready",
    "protocolVersion": JSONL_PROTOCOL_VERSION,
    "matchdayProtocolVersion": MATCHDAY_PROTOCOL_VERSION,
    "battleProtocolVersion": BATTLE_PROTOCOL_VERSION,
    "showdownRevision": SHOWDOWN_REVISION,
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
        self.kill_impl: Callable[[], Any] | None = None
        self.write_gate: asyncio.Event | None = None

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
        if self.write_gate is not None:
            await self.write_gate.wait()
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
        if self.terminate_impl is not None:
            await self.terminate_impl()
        else:
            self.exit(0)

    async def kill(self) -> None:
        self.kill_calls += 1
        if self.kill_impl is not None:
            await self.kill_impl()
        else:
            self.exit(-9)


class FakeRuntime:
    supports_live_processes = True

    def __init__(self, process: FakeProcess) -> None:
        self.process = process

    async def open_process(self, argv: list[str], env: dict[str, str]) -> FakeProcess:
        assert argv == ["referee"]
        assert env == {}
        return self.process


def _chunks(data: bytes, cuts: list[int]) -> list[bytes]:
    result: list[bytes] = []
    start = 0
    for end in cuts:
        result.append(data[start:end])
        start = end
    result.append(data[start:])
    return [chunk for chunk in result if chunk]


def _binding(params: dict[str, Any]) -> dict[str, Any]:
    return {
        "episodeId": params["episodeId"],
        "conditionDigest": params["conditionDigest"],
        "configDigest": "b" * 64,
        "showdownRevision": params["showdownRevision"],
        "matchdayProtocolVersion": MATCHDAY_PROTOCOL_VERSION,
        "battleProtocolVersion": BATTLE_PROTOCOL_VERSION,
    }


async def _start(client: FrozenMatchdayProtocolClient) -> Any:
    return await client.start(
        episode_id="episode",
        condition_digest="a" * 64,
        expected_config_digest="b" * 64,
        showdown_revision=SHOWDOWN_REVISION,
        options={"private": "秘密"},
    )


@pytest.mark.asyncio
async def test_fragmented_utf8_ready_binding_and_monotonic_serial_calls() -> None:
    binding: dict[str, Any] = {}

    async def handler(request: dict[str, Any], process: FakeProcess) -> None:
        nonlocal binding
        if request["method"] == "start":
            binding = _binding(request["params"])
            value: Any = {"started": True}
        else:
            await asyncio.sleep(0)
            value = {"pid": request["params"]["pid"], "text": "雪だるま☃"}
        response = _encoded(
            {
                "id": request["id"],
                "ok": True,
                "result": {"binding": binding, "value": value},
            }
        )
        snow = response.find("雪".encode())
        cuts = [1, 7, len(response) - 2] if snow < 0 else [1, 7, snow + 1, snow + 2, len(response) - 2]
        process.output(*_chunks(response, cuts))

    ready = _encoded(_READY)
    process = FakeProcess(_chunks(ready, [1, 2, 9, len(ready) - 1]), handler)
    client = await FrozenMatchdayProtocolClient.launch(
        FakeRuntime(process), executable="referee", line_limit=4096
    )
    async with client:
        assert await _start(client) == {"started": True}
        p1, p2 = await asyncio.gather(
            client.call("observe", {"pid": "p1"}),
            client.call("observe", {"pid": "p2"}),
        )
        assert p1 == {"pid": "p1", "text": "雪だるま☃"}
        assert p2 == {"pid": "p2", "text": "雪だるま☃"}
        assert client.binding is not None
        assert client.binding.to_wire() == binding
    assert [request["id"] for request in process.requests] == [1, 2, 3]
    assert [request["method"] for request in process.requests] == [
        "start",
        "observe",
        "observe",
    ]
    assert all(request["protocolVersion"] == 1 for request in process.requests)
    assert process.terminate_calls == 1
    assert process.kill_calls == 0


@pytest.mark.asyncio
async def test_cap_write_cancel_binding_poison_eof_and_stderr_fail_closed() -> None:
    oversized = FakeProcess([b"{" + b"x" * 32])
    with pytest.raises(ProtocolError, match="exceeds"):
        await FrozenMatchdayProtocolClient.launch(
            FakeRuntime(oversized),
            executable="referee",
            line_limit=16,
            shutdown_timeout=0.05,
        )
    assert oversized.terminate_calls == 1

    combined = FakeProcess([_encoded({**_READY, "protocolVersion": 999})])

    async def failed_launch_terminate() -> None:
        raise RuntimeError("cleanup boom")

    combined.terminate_impl = failed_launch_terminate
    with pytest.raises(ProtocolError, match="ready envelope mismatch") as caught:
        await FrozenMatchdayProtocolClient.launch(
            FakeRuntime(combined), executable="referee", shutdown_timeout=0.01
        )
    assert caught.value.__notes__ == [
        "referee cleanup also failed: referee terminate failed: cleanup boom"
    ]

    write_process = FakeProcess([_encoded(_READY)])
    write_process.write_gate = asyncio.Event()
    client = await FrozenMatchdayProtocolClient.launch(
        FakeRuntime(write_process), executable="referee", shutdown_timeout=0.05
    )
    pending = asyncio.create_task(_start(client))
    await asyncio.sleep(0)
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    with pytest.raises(ProtocolError, match="poisoned"):
        await _start(client)
    await client.aclose(check_protocol=False)

    wrong_binding: dict[str, Any] = {}

    def wrong_handler(request: dict[str, Any], process: FakeProcess) -> None:
        nonlocal wrong_binding
        if request["method"] == "start":
            wrong_binding = _binding(request["params"])
            value: Any = {"started": True}
        else:
            wrong = {**wrong_binding, "episodeId": "other"}
            process.output(
                _encoded(
                    {
                        "id": request["id"],
                        "ok": True,
                        "result": {"binding": wrong, "value": {}},
                    }
                )
            )
            return
        process.output(
            _encoded(
                {
                    "id": request["id"],
                    "ok": True,
                    "result": {"binding": wrong_binding, "value": value},
                }
            )
        )

    mismatch_process = FakeProcess([_encoded(_READY)], wrong_handler)
    mismatch = await FrozenMatchdayProtocolClient.launch(
        FakeRuntime(mismatch_process), executable="referee", shutdown_timeout=0.05
    )
    await _start(mismatch)
    with pytest.raises(ProtocolError, match="mismatched binding"):
        await mismatch.call("observe", {"pid": "p1"})
    with pytest.raises(ProtocolError, match="poisoned"):
        await mismatch.call("observe", {"pid": "p1"})
    await mismatch.aclose(check_protocol=False)

    binding: dict[str, Any] = {}

    def eof_handler(request: dict[str, Any], process: FakeProcess) -> None:
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
        else:
            process.stderr_output(b"private crash diagnostic")
            process.exit(17)

    eof_process = FakeProcess([_encoded(_READY)], eof_handler)
    eof = await FrozenMatchdayProtocolClient.launch(
        FakeRuntime(eof_process), executable="referee", shutdown_timeout=0.05
    )
    await _start(eof)
    with pytest.raises(ProtocolError) as caught:
        await eof.call("observe", {"pid": "p1"})
    assert "EOF" in str(caught.value) or "status 17" in str(caught.value)
    await asyncio.sleep(0)
    assert b"private crash diagnostic" in eof.stderr_tail
    await eof.aclose(check_protocol=False)

    async def close_after_immediate_exit(exit_method: str) -> None:
        response_binding: dict[str, Any] = {}

        def handler(request: dict[str, Any], process: FakeProcess) -> None:
            nonlocal response_binding
            if request["method"] == "start":
                response_binding = _binding(request["params"])
                value: Any = {"started": True}
            else:
                value = {"terminal": True}
            process.output(
                _encoded(
                    {
                        "id": request["id"],
                        "ok": True,
                        "result": {"binding": response_binding, "value": value},
                    }
                )
            )
            if request["method"] == exit_method:
                process.exit(23)

        process = FakeProcess([_encoded(_READY)], handler)
        client = await FrozenMatchdayProtocolClient.launch(
            FakeRuntime(process), executable="referee", shutdown_timeout=0.05
        )
        assert await _start(client) == {"started": True}
        if exit_method == "terminal":
            assert await client.call("terminal") == {"terminal": True}
        await asyncio.sleep(0)
        with pytest.raises(ProtocolError, match="before close"):
            await client.aclose()

    await close_after_immediate_exit("start")
    await close_after_immediate_exit("terminal")

    unsolicited_process = FakeProcess(
        [_encoded(_READY), _encoded({"kind": "unsolicited"})]
    )
    unsolicited = await FrozenMatchdayProtocolClient.launch(
        FakeRuntime(unsolicited_process),
        executable="referee",
        shutdown_timeout=0.05,
    )
    await asyncio.sleep(0)
    with pytest.raises(ProtocolError, match="unsolicited"):
        await unsolicited.aclose()
    assert unsolicited_process.terminate_calls == 1


@pytest.mark.asyncio
async def test_terminate_timeout_kills_and_cancelled_close_still_completes() -> None:
    process = FakeProcess([_encoded(_READY)])
    never = asyncio.Event()
    terminate_cancelled = asyncio.Event()

    async def hanging_terminate() -> None:
        try:
            await never.wait()
        finally:
            terminate_cancelled.set()

    process.terminate_impl = hanging_terminate
    client = await FrozenMatchdayProtocolClient.launch(
        FakeRuntime(process),
        executable="referee",
        shutdown_timeout=0.01,
    )
    await client.aclose(check_protocol=False)
    assert process.terminate_calls == 1
    assert process.kill_calls == 1
    assert process.wait_future.done()
    assert terminate_cancelled.is_set()

    terminate_failure = FakeProcess([_encoded(_READY)])

    async def failed_terminate() -> None:
        raise RuntimeError("terminate boom")

    terminate_failure.terminate_impl = failed_terminate
    client = await FrozenMatchdayProtocolClient.launch(
        FakeRuntime(terminate_failure),
        executable="referee",
        shutdown_timeout=0.01,
    )
    with pytest.raises(ProtocolError, match="terminate failed: terminate boom"):
        await client.aclose(check_protocol=False)
    assert terminate_failure.kill_calls == 1

    kill_failure = FakeProcess([_encoded(_READY)])

    async def ineffective_terminate() -> None:
        return None

    async def failed_kill() -> None:
        raise RuntimeError("kill boom")

    kill_failure.terminate_impl = ineffective_terminate
    kill_failure.kill_impl = failed_kill
    client = await FrozenMatchdayProtocolClient.launch(
        FakeRuntime(kill_failure),
        executable="referee",
        shutdown_timeout=0.01,
    )
    with pytest.raises(ProtocolError, match="kill failed: kill boom"):
        await client.aclose(check_protocol=False)

    delayed = FakeProcess([_encoded(_READY)])

    async def delayed_terminate() -> None:
        await asyncio.sleep(0.03)
        delayed.exit(0)

    delayed.terminate_impl = delayed_terminate
    client = await FrozenMatchdayProtocolClient.launch(
        FakeRuntime(delayed),
        executable="referee",
        shutdown_timeout=0.1,
    )
    closing = asyncio.create_task(client.aclose(check_protocol=False))
    await asyncio.sleep(0.005)
    closing.cancel()
    with pytest.raises(asyncio.CancelledError):
        await closing
    assert delayed.wait_future.done()
    assert delayed.terminate_calls == 1
    assert delayed.kill_calls == 0
    await client.aclose(check_protocol=False)

    assert MAX_ENCODED_LINE_BYTES == 32 * 1024 * 1024
