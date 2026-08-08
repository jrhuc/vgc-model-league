from __future__ import annotations

import asyncio
import inspect
import json
import math
from collections.abc import AsyncIterator, Awaitable, Callable
from types import SimpleNamespace
from typing import Any

import pytest
from verifiers.v1 import RuntimeProcess

from vgc_frozen_matchday_v0.protocol import (
    BATTLE_PROTOCOL_VERSION,
    JSONL_PROTOCOL_VERSION,
    MATCHDAY_PROTOCOL_VERSION,
    SHOWDOWN_REVISION,
    FrozenMatchdayProtocolClient,
    ProtocolError,
    RuntimeProcessJsonlClient,
)


def encoded(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"


READY = {
    "kind": "ready",
    "protocolVersion": JSONL_PROTOCOL_VERSION,
    "matchdayProtocolVersion": MATCHDAY_PROTOCOL_VERSION,
    "battleProtocolVersion": BATTLE_PROTOCOL_VERSION,
    "showdownRevision": SHOWDOWN_REVISION,
}


def test_protocol_versions_are_jsonl_1_matchday_2_battle_2() -> None:
    assert (
        JSONL_PROTOCOL_VERSION,
        MATCHDAY_PROTOCOL_VERSION,
        BATTLE_PROTOCOL_VERSION,
    ) == (1, 2, 2)


_EOF = object()
Action = Callable[["FakeProcess"], Awaitable[None] | None]
Handler = Callable[[dict[str, Any], "FakeProcess"], Awaitable[None] | None]


class FakeProcess(RuntimeProcess):
    def __init__(
        self,
        stdout_chunks: list[Any],
        handler: Handler | None = None,
        *,
        stderr_chunks: list[Any] | None = None,
        terminate_action: Action | None = None,
        kill_action: Action | None = None,
        wait_error: BaseException | None = None,
    ) -> None:
        self.stdout_queue: asyncio.Queue[Any] = asyncio.Queue()
        self.stderr_queue: asyncio.Queue[Any] = asyncio.Queue()
        for chunk in stdout_chunks:
            self.stdout_queue.put_nowait(chunk)
        for chunk in stderr_chunks or []:
            self.stderr_queue.put_nowait(chunk)
        self.stdout = self._stream(self.stdout_queue)
        self.stderr = self._stream(self.stderr_queue)
        self.handler = handler
        self.terminate_action = terminate_action
        self.kill_action = kill_action
        self.wait_error = wait_error
        self.writes: list[bytes] = []
        self.terminated = 0
        self.killed = 0
        self._stdout_closed = False
        self._stderr_closed = False
        self._exit: asyncio.Future[int] = asyncio.get_running_loop().create_future()

    async def _stream(self, queue: asyncio.Queue[Any]) -> AsyncIterator[bytes]:
        while True:
            item = await queue.get()
            if item is _EOF:
                return
            yield item

    def output(self, *chunks: Any) -> None:
        for chunk in chunks:
            self.stdout_queue.put_nowait(chunk)

    def stderr_output(self, *chunks: Any) -> None:
        for chunk in chunks:
            self.stderr_queue.put_nowait(chunk)

    def close_stdout(self) -> None:
        if not self._stdout_closed:
            self._stdout_closed = True
            self.stdout_queue.put_nowait(_EOF)

    def close_stderr(self) -> None:
        if not self._stderr_closed:
            self._stderr_closed = True
            self.stderr_queue.put_nowait(_EOF)

    def exit(self, code: int, *, close_streams: bool = True) -> None:
        if not self._exit.done():
            self._exit.set_result(code)
        if close_streams:
            self.close_stdout()
            self.close_stderr()

    async def write(self, data: bytes) -> None:
        self.writes.append(data)
        request = json.loads(data)
        if self.handler is not None:
            result = self.handler(request, self)
            if inspect.isawaitable(result):
                await result

    async def wait(self) -> int:
        if self.wait_error is not None:
            raise self.wait_error
        return await self._exit

    async def terminate(self) -> None:
        self.terminated += 1
        if self.terminate_action is None:
            self.exit(-15)
            return
        result = self.terminate_action(self)
        if inspect.isawaitable(result):
            await result

    async def kill(self) -> None:
        self.killed += 1
        if self.kill_action is None:
            self.exit(-9)
            return
        result = self.kill_action(self)
        if inspect.isawaitable(result):
            await result


class CancellationSuppressingStream:
    def __init__(self, prefix: bytes, release: asyncio.Event) -> None:
        self.prefix: bytes | None = prefix
        self.release = release
        self.entered = asyncio.Event()
        self.cancellations = 0

    def __aiter__(self) -> CancellationSuppressingStream:
        return self

    async def __anext__(self) -> bytes:
        if self.prefix is not None:
            prefix = self.prefix
            self.prefix = None
            return prefix
        self.entered.set()
        while not self.release.is_set():
            try:
                await self.release.wait()
            except asyncio.CancelledError:
                self.cancellations += 1
        raise RuntimeError("late detached iterator failure")


class FakeRuntime:
    supports_live_processes = True

    def __init__(self, process: FakeProcess) -> None:
        self.process = process
        self.config = SimpleNamespace(type="docker")
        self.opened: list[tuple[list[str], dict[str, str]]] = []

    async def open_process(self, argv: list[str], env: dict[str, str]) -> FakeProcess:
        self.opened.append((argv, env))
        return self.process


def split_bytes(value: bytes, cuts: list[int]) -> list[bytes]:
    points = [0, *cuts, len(value)]
    return [value[a:b] for a, b in zip(points, points[1:]) if a != b]


async def launch(
    process: FakeProcess,
    *,
    ready: dict[str, Any] = READY,
    line_limit: int = 32 * 1024 * 1024,
    stderr_tail_bytes: int = 64 * 1024,
    shutdown_timeout: float = 0.02,
) -> RuntimeProcessJsonlClient:
    return await RuntimeProcessJsonlClient.launch(
        FakeRuntime(process),
        "/referee",
        expected_ready=ready,
        line_limit=line_limit,
        stderr_tail_bytes=stderr_tail_bytes,
        shutdown_timeout=shutdown_timeout,
    )


def success(request: dict[str, Any], result: Any = None) -> bytes:
    return encoded({"id": request["id"], "ok": True, "result": result})


@pytest.mark.asyncio
async def test_arbitrary_chunks_multiple_records_utf8_lf_and_split_crlf() -> None:
    ready = b"\n\r\n" + encoded(READY)[:-1] + b"\r\n"

    def handler(request: dict[str, Any], process: FakeProcess) -> None:
        response = success(request, {"text": "雪"})[:-1] + b"\r\n"
        snow = response.index("雪".encode())
        process.output(b"", b"\r\n", *split_bytes(response, [1, snow + 1, snow + 2]))

    chunks = split_bytes(ready, [1, 2, 3, 7, len(ready) - 1])
    process = FakeProcess(chunks, handler)
    client = await launch(process)
    assert client._responses.maxsize == 1
    async with client:
        first_id, first = await client.request("observe", {"pid": "p1"})
        second_id, second = await client.request("observe", {"pid": "p2"})
        assert (first_id, second_id) == (1, 2)
        assert first == second == {"text": "雪"}
    assert process.writes[0] == b'{"protocolVersion":1,"id":1,"method":"observe","params":{"pid":"p1"}}\n'


@pytest.mark.asyncio
@pytest.mark.parametrize("raw", [b" \n", b"[]\n", b"null\n", b"1\n", b'"x"\n'])
async def test_whitespace_and_non_object_records_are_rejected(raw: bytes) -> None:
    process = FakeProcess([raw])
    with pytest.raises(ProtocolError, match="JSONL stdout|JSON object"):
        await launch(process, ready={})
    assert process.terminated == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("raw", "message"),
    [
        (b'{"x":1,"x":2}\n', "duplicate"),
        (b'{"x":NaN}\n', "constant"),
        (b'{"x":Infinity}\n', "constant"),
        (b'{"x":-Infinity}\n', "constant"),
        (b'{"x":1e400}\n', "finite"),
        (b'{"x":' + b"9" * 400 + b"}\n", "overflows"),
        (b'{"x":{"y":1e400}}\n', "finite"),
        (b'{"x":"\xff"}\n', "JSONL stdout"),
    ],
)
async def test_strict_json_rejects_duplicates_nonfinite_overflow_and_utf8(
    raw: bytes, message: str
) -> None:
    process = FakeProcess([raw])
    with pytest.raises(ProtocolError, match=message):
        await launch(process, ready={})


@pytest.mark.asyncio
async def test_nonbytes_stdout_and_stderr_are_rejected() -> None:
    with pytest.raises(ProtocolError, match="stdout chunks must be bytes"):
        await launch(FakeProcess([bytearray(b"{}\n")]), ready={})

    process = FakeProcess([b"{}\n"], stderr_chunks=["not bytes"])
    with pytest.raises(ProtocolError, match="stderr chunks must be bytes"):
        await launch(process, ready={})


@pytest.mark.asyncio
async def test_inbound_line_limit_exact_n_n_plus_one_crlf_and_multibyte() -> None:
    exact = {"x": "雪" * 4}
    line = encoded(exact)[:-1]
    limit = len(line)

    process = FakeProcess([line + b"\r", b"\n"])
    client = await launch(process, ready=exact, line_limit=limit)
    await client.aclose()

    process = FakeProcess([line + b"x\n"])
    with pytest.raises(ProtocolError, match=f"exceeds {limit}"):
        await launch(process, ready=exact, line_limit=limit)

    process = FakeProcess([line + b"\r"])
    process.close_stdout()
    with pytest.raises(ProtocolError, match=f"exceeds {limit}"):
        await launch(process, ready=exact, line_limit=limit)


@pytest.mark.asyncio
async def test_huge_provider_chunk_is_rejected_before_buffering_past_cap() -> None:
    process = FakeProcess([b"{" + b"x" * (1024 * 1024) + b"\n"])
    with pytest.raises(ProtocolError, match="exceeds 32"):
        await launch(process, ready={}, line_limit=32)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "wrong",
    [
        {**READY, "protocolVersion": 1.0},
        {**READY, "protocolVersion": True},
        {**READY, "extra": 1},
        {key: value for key, value in READY.items() if key != "kind"},
    ],
)
async def test_ready_envelope_is_exact_in_keys_values_and_types(wrong: dict[str, Any]) -> None:
    process = FakeProcess([encoded(wrong)])
    with pytest.raises(ProtocolError, match="ready envelope mismatch"):
        await launch(process)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("response", "message"),
    [
        ({"id": True, "ok": True, "result": {}}, "id mismatch"),
        ({"id": 1.0, "ok": True, "result": {}}, "id mismatch"),
        ({"id": 1, "ok": 1, "result": {}}, "boolean ok"),
        ({"id": 1, "ok": True}, "invalid envelope"),
        ({"id": 1, "ok": True, "result": {}, "extra": 1}, "invalid envelope"),
        ({"id": 1, "ok": False, "error": {"code": "x"}}, "invalid error object"),
        ({"id": 1, "ok": False, "error": {"code": "x", "message": 1}}, "invalid error object"),
        ({"id": 1, "ok": False, "error": {"code": "x", "message": "m"}, "x": 1}, "invalid envelope"),
    ],
)
async def test_response_envelopes_are_exact(response: dict[str, Any], message: str) -> None:
    process = FakeProcess([encoded(READY)], lambda request, proc: proc.output(encoded(response)))
    client = await launch(process)
    with pytest.raises(ProtocolError, match=message):
        async with client:
            await client.request("observe")


@pytest.mark.asyncio
async def test_exact_error_envelope_rejects_without_desynchronizing() -> None:
    calls = 0

    def handler(request: dict[str, Any], process: FakeProcess) -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            process.output(
                encoded({"id": request["id"], "ok": False, "error": {"code": "phase", "message": "no"}})
            )
        else:
            process.output(success(request, {"yes": True}))

    process = FakeProcess([encoded(READY)], handler)
    client = await launch(process)
    async with client:
        with pytest.raises(ProtocolError, match="phase: no"):
            await client.request("submit")
        assert await client.request("observe") == (2, {"yes": True})


@pytest.mark.asyncio
async def test_outbound_nonserializable_nonfinite_and_oversize_fail_before_write() -> None:
    process = FakeProcess([encoded(READY)])
    client = await launch(process, line_limit=1024)
    async with client:
        with pytest.raises(ProtocolError, match="not JSON serializable"):
            await client.request("observe", {"x": object()})
        with pytest.raises(ProtocolError, match="not JSON serializable"):
            await client.request("observe", {"x": math.nan})
        with pytest.raises(ProtocolError, match="request line exceeds"):
            await client.request("observe", {"x": "a" * 2000})
        assert process.writes == []


@pytest.mark.asyncio
async def test_outbound_exact_line_limit_and_n_plus_one() -> None:
    def responder(request: dict[str, Any], process: FakeProcess) -> None:
        process.output(success(request, None))

    params = {"x": "a" * 40}
    request_line = json.dumps(
        {"protocolVersion": 1, "id": 1, "method": "m", "params": params},
        separators=(",", ":"),
    ).encode()
    limit = len(request_line)
    process = FakeProcess([b"{}\n"], responder)
    client = await launch(process, ready={}, line_limit=limit)
    async with client:
        assert await client.request("m", params) == (1, None)

    process = FakeProcess([b"{}\n"])
    client = await launch(process, ready={}, line_limit=limit)
    async with client:
        with pytest.raises(ProtocolError, match="request line exceeds"):
            await client.request("m", {"x": "a" * 41})
        assert process.writes == []


@pytest.mark.asyncio
async def test_write_error_poisons_all_future_requests() -> None:
    async def failing_handler(request: dict[str, Any], process: FakeProcess) -> None:
        raise OSError("broken pipe")

    process = FakeProcess([encoded(READY)], failing_handler)
    client = await launch(process)
    with pytest.raises(ProtocolError, match="write failed"):
        await client.request("observe")
    with pytest.raises(ProtocolError, match="poisoned"):
        await client.request("observe")
    with pytest.raises(ProtocolError, match="write failed"):
        await client.aclose()
    await client.aclose()


@pytest.mark.asyncio
async def test_write_cancellation_poisons_all_future_requests() -> None:
    entered = asyncio.Event()
    release = asyncio.Event()

    async def blocked_handler(request: dict[str, Any], process: FakeProcess) -> None:
        entered.set()
        await release.wait()

    process = FakeProcess([encoded(READY)], blocked_handler)
    client = await launch(process)
    request_task = asyncio.create_task(client.request("observe"))
    await entered.wait()
    request_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await request_task
    with pytest.raises(ProtocolError, match="poisoned"):
        await client.request("observe")
    release.set()
    with pytest.raises(ProtocolError, match="write was cancelled"):
        await client.aclose()


@pytest.mark.asyncio
async def test_concurrent_requests_are_serialized_and_ids_are_monotonic() -> None:
    entered = asyncio.Event()
    release = asyncio.Event()

    async def handler(request: dict[str, Any], process: FakeProcess) -> None:
        if request["id"] == 1:
            entered.set()
            await release.wait()
        process.output(success(request, request["id"]))

    process = FakeProcess([encoded(READY)], handler)
    client = await launch(process)
    first = asyncio.create_task(client.request("one"))
    await entered.wait()
    second = asyncio.create_task(client.request("two"))
    await asyncio.sleep(0)
    assert len(process.writes) == 1
    release.set()
    assert await first == (1, 1)
    assert await second == (2, 2)
    await client.aclose()


@pytest.mark.asyncio
async def test_waiting_request_rechecks_closed_after_request_lock() -> None:
    entered = asyncio.Event()
    release = asyncio.Event()

    async def handler(request: dict[str, Any], process: FakeProcess) -> None:
        entered.set()
        await release.wait()
        process.output(success(request, None))

    process = FakeProcess([encoded(READY)], handler)
    client = await launch(process)
    first = asyncio.create_task(client.request("one"))
    await entered.wait()
    second = asyncio.create_task(client.request("two"))
    close_task = asyncio.create_task(client.aclose(check_protocol=False))
    await asyncio.sleep(0)
    release.set()
    await asyncio.gather(first, return_exceptions=True)
    with pytest.raises(ProtocolError, match="closed"):
        await second
    await close_task
    assert len(process.writes) == 1


@pytest.mark.asyncio
async def test_saturated_response_queue_cannot_deadlock_close() -> None:
    process = FakeProcess([encoded(READY)])
    client = await launch(process)
    process.output(*(encoded({"id": index, "ok": True, "result": {}}) for index in range(50)))
    with pytest.raises(ProtocolError, match="unsolicited"):
        await asyncio.wait_for(client.aclose(), timeout=1)
    assert client._stdout_task.done()
    assert not client._operation_tasks


@pytest.mark.asyncio
async def test_controller_shutdown_accepts_its_own_clean_eof() -> None:
    process = FakeProcess([encoded(READY)])
    client = await launch(process)
    await client.aclose()
    await client.aclose()
    assert process.terminated == 1
    assert process.killed == 0
    assert client._closed


@pytest.mark.asyncio
async def test_preexisting_stdout_eof_and_exit_fail_closed() -> None:
    process = FakeProcess([encoded(READY)])
    client = await launch(process)
    process.close_stdout()
    await asyncio.sleep(0)
    with pytest.raises(ProtocolError, match="EOF before controller shutdown"):
        await client.aclose()

    process = FakeProcess([encoded(READY)])
    client = await launch(process)
    process.exit(0)
    await asyncio.sleep(0)
    with pytest.raises(ProtocolError, match="before controller shutdown|EOF"):
        await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("trailing", "message"),
    [
        (encoded({"id": 1, "ok": True, "result": {}}), "unsolicited"),
        (encoded({"id": 1, "ok": True, "result": {}}) * 2, "unsolicited"),
        (b"{bad}\n", "invalid referee JSONL"),
        (b'{"id":1}', "unterminated"),
    ],
)
async def test_close_drains_and_rejects_delayed_trailing_output(
    trailing: bytes, message: str
) -> None:
    async def terminate(process: FakeProcess) -> None:
        await asyncio.sleep(0)
        process.output(trailing)
        await asyncio.sleep(0)
        process.exit(-15)

    process = FakeProcess([encoded(READY)], terminate_action=terminate)
    client = await launch(process)
    with pytest.raises(ProtocolError, match=message):
        await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("terminate_mode", ["hang", "raise"])
async def test_terminate_hang_or_raise_falls_back_to_bounded_kill(terminate_mode: str) -> None:
    gate = asyncio.Event()

    async def terminate(process: FakeProcess) -> None:
        if terminate_mode == "raise":
            raise OSError("terminate failed")
        await gate.wait()

    process = FakeProcess([encoded(READY)], terminate_action=terminate)
    client = await launch(process, shutdown_timeout=0.002)
    with pytest.raises(ProtocolError, match="terminate"):
        await client.aclose()
    await client.aclose()
    assert process.terminated == 1
    assert process.killed == 1
    assert process._exit.done()


@pytest.mark.asyncio
@pytest.mark.parametrize("kill_mode", ["hang", "raise", "no-exit"])
async def test_kill_and_post_kill_failures_are_bounded_and_reported(kill_mode: str) -> None:
    never = asyncio.Event()

    async def terminate(process: FakeProcess) -> None:
        await never.wait()

    async def kill(process: FakeProcess) -> None:
        if kill_mode == "hang":
            await never.wait()
        elif kill_mode == "raise":
            raise OSError("kill failed")

    process = FakeProcess(
        [encoded(READY)], terminate_action=terminate, kill_action=kill
    )
    client = await launch(process, shutdown_timeout=0.002)
    with pytest.raises(ProtocolError, match="kill|post-kill"):
        await asyncio.wait_for(client.aclose(), timeout=0.2)
    assert client._closed
    await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["terminate", "stdout"])
async def test_noncooperative_runtime_cleanup_is_bounded_observed_and_explicit(
    mode: str,
) -> None:
    release = asyncio.Event()
    entered = asyncio.Event()
    cancellations = 0
    stream: CancellationSuppressingStream | None = None

    async def noncooperative_terminate(process: FakeProcess) -> None:
        nonlocal cancellations
        entered.set()
        while not release.is_set():
            try:
                await release.wait()
            except asyncio.CancelledError:
                cancellations += 1
        raise RuntimeError("late detached terminate failure")

    if mode == "terminate":
        process = FakeProcess(
            [encoded(READY)], terminate_action=noncooperative_terminate
        )
    else:
        process = FakeProcess([])
        stream = CancellationSuppressingStream(encoded(READY), release)
        process.stdout = stream

    loop = asyncio.get_running_loop()
    observed_contexts: list[dict[str, Any]] = []
    previous_handler = loop.get_exception_handler()
    loop.set_exception_handler(
        lambda event_loop, context: observed_contexts.append(context)
    )
    client: RuntimeProcessJsonlClient | None = None
    try:
        client = await launch(process, shutdown_timeout=0.01)
        if stream is not None:
            await stream.entered.wait()
        close_task = asyncio.create_task(client.aclose())
        if mode == "terminate":
            await entered.wait()
        else:
            await asyncio.sleep(0)
        started = loop.time()
        with pytest.raises(ProtocolError) as caught:
            await asyncio.wait_for(close_task, timeout=0.3)
        elapsed = loop.time() - started

        details = [str(caught.value), *getattr(caught.value, "__notes__", [])]
        assert any("noncooperative RuntimeProcess" in detail for detail in details)
        assert any("ignored cancellation" in detail for detail in details)
        assert any("owned by the runtime context" in detail for detail in details)
        assert elapsed < 0.2
        assert client._closed
        assert client._detached_runtime_tasks

        release.set()
        for _ in range(100):
            if not client._detached_runtime_tasks:
                break
            await asyncio.sleep(0)
        assert not client._detached_runtime_tasks
        if stream is None:
            assert cancellations >= 1
        else:
            assert stream.cancellations >= 1
        await asyncio.sleep(0)
        assert observed_contexts == []
        await client.aclose()
    finally:
        release.set()
        for _ in range(10):
            if client is None or not client._detached_runtime_tasks:
                break
            await asyncio.sleep(0)
        loop.set_exception_handler(previous_handler)


@pytest.mark.asyncio
async def test_close_cancellation_finishes_cleanup_then_reraises_and_is_retry_safe() -> None:
    entered = asyncio.Event()
    release = asyncio.Event()

    async def terminate(process: FakeProcess) -> None:
        entered.set()
        await release.wait()
        process.exit(-15)

    process = FakeProcess([encoded(READY)], terminate_action=terminate)
    client = await launch(process)
    close_task = asyncio.create_task(client.aclose())
    await entered.wait()
    close_task.cancel()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await close_task
    assert client._closed
    assert client._stdout_task.done()
    assert client._stderr_task.done()
    assert client._wait_task.done()
    await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["terminate", "kill", "drain"])
async def test_repeated_close_cancellation_waits_for_supported_cleanup(
    phase: str,
) -> None:
    terminate_entered = asyncio.Event()
    kill_entered = asyncio.Event()
    release = asyncio.Event()

    async def terminate(process: FakeProcess) -> None:
        terminate_entered.set()
        if phase == "terminate":
            await release.wait()
            process.exit(-15)
        elif phase == "drain":
            if not process._exit.done():
                process._exit.set_result(-15)

    async def kill(process: FakeProcess) -> None:
        kill_entered.set()
        await release.wait()
        process.exit(-9)

    process = FakeProcess(
        [encoded(READY)], terminate_action=terminate, kill_action=kill
    )
    client = await launch(process, shutdown_timeout=0.1)
    close_task = asyncio.create_task(client.aclose())
    if phase == "terminate":
        await terminate_entered.wait()
    elif phase == "kill":
        await kill_entered.wait()
    else:
        await terminate_entered.wait()
        while any(
            task.get_name() == "referee-terminate"
            for task in client._operation_tasks
        ):
            await asyncio.sleep(0)
        await asyncio.sleep(0)

    for index in range(3):
        close_task.cancel(f"caller cancellation {index}")
        await asyncio.sleep(0)
        assert not close_task.done(), (
            index,
            client._close_task.done() if client._close_task is not None else None,
            client._closed,
        )

    if phase == "drain":
        process.close_stdout()
        process.close_stderr()
    else:
        release.set()
    with pytest.raises(asyncio.CancelledError) as caught:
        await close_task

    notes = getattr(caught.value, "__notes__", [])
    assert notes == []
    assert client._closed
    assert not client._operation_tasks
    assert not client._detached_runtime_tasks
    assert all(
        task.done()
        for task in (
            client._stdout_task,
            client._stderr_task,
            client._wait_task,
            client._close_task,
        )
        if task is not None
    )
    assert not [
        task
        for task in asyncio.all_tasks()
        if task is not asyncio.current_task()
        and task.get_name().startswith("referee-")
        and not task.done()
    ]
    await client.aclose()


@pytest.mark.asyncio
async def test_concurrent_close_is_idempotent_and_has_no_internal_live_tasks() -> None:
    async def terminate(process: FakeProcess) -> None:
        await asyncio.sleep(0)
        process.exit(-15)

    process = FakeProcess([encoded(READY)], terminate_action=terminate)
    client = await launch(process)
    await asyncio.gather(client.aclose(), client.aclose(), client.aclose())
    assert process.terminated == 1
    assert not client._operation_tasks
    assert all(
        task.done()
        for task in (client._stdout_task, client._stderr_task, client._wait_task, client._close_task)
        if task is not None
    )


@pytest.mark.asyncio
async def test_body_error_remains_primary_and_cleanup_detail_is_attached() -> None:
    def handler(request: dict[str, Any], process: FakeProcess) -> None:
        process.output(encoded({"id": 999, "ok": True, "result": {}}))

    async def terminate(process: FakeProcess) -> None:
        process.output(b"{bad}\n")
        process.exit(-15)

    process = FakeProcess([encoded(READY)], handler, terminate_action=terminate)
    client = await launch(process)
    with pytest.raises(ProtocolError, match="id mismatch") as caught:
        async with client:
            await client.request("observe")
    notes = getattr(caught.value, "__notes__", [])
    assert any("cleanup also failed" in note for note in notes)


@pytest.mark.asyncio
async def test_stderr_tail_is_bounded_without_large_chunk_concatenation_and_is_late_drained() -> None:
    huge = b"discard" * 100_000

    async def terminate(process: FakeProcess) -> None:
        process.stderr_output(b"late-0123456789")
        await asyncio.sleep(0)
        process.exit(-15)

    process = FakeProcess(
        [encoded(READY)], stderr_chunks=[b"early", huge], terminate_action=terminate
    )
    client = await launch(process, stderr_tail_bytes=8)
    await client.aclose()
    assert client.stderr_tail == b"23456789"


@pytest.mark.asyncio
async def test_nonzero_preexisting_exit_reports_bounded_late_stderr() -> None:
    process = FakeProcess([encoded(READY)], stderr_chunks=[b"discard-", b"0123456789"])
    client = await launch(process, stderr_tail_bytes=8)
    process.exit(7)
    await asyncio.sleep(0)
    with pytest.raises(ProtocolError, match="status 7") as caught:
        await client.aclose()
    assert client.stderr_tail == b"23456789"
    assert any("23456789" in note for note in getattr(caught.value, "__notes__", []))


BINDING = {
    "episodeId": "episode",
    "conditionDigest": "a" * 64,
    "configDigest": "b" * 64,
    "showdownRevision": SHOWDOWN_REVISION,
    "matchdayProtocolVersion": MATCHDAY_PROTOCOL_VERSION,
    "battleProtocolVersion": BATTLE_PROTOCOL_VERSION,
}


def bound_result(value: Any, binding: dict[str, Any] = BINDING) -> dict[str, Any]:
    return {"binding": binding, "value": value}


INVALID_REMOTE_BINDINGS: list[Any] = []
for _field, _expected in BINDING.items():
    INVALID_REMOTE_BINDINGS.append(
        pytest.param(
            {key: value for key, value in BINDING.items() if key != _field},
            id=f"missing-{_field}",
        )
    )
    _wrong_type: Any = 7 if isinstance(_expected, str) else str(_expected)
    INVALID_REMOTE_BINDINGS.append(
        pytest.param(
            {**BINDING, _field: _wrong_type},
            id=f"type-{_field}",
        )
    )
    _wrong_value: Any = (
        f"{_expected}-wrong" if isinstance(_expected, str) else _expected + 1
    )
    INVALID_REMOTE_BINDINGS.append(
        pytest.param(
            {**BINDING, _field: _wrong_value},
            id=f"value-{_field}",
        )
    )
INVALID_REMOTE_BINDINGS.extend(
    [
        pytest.param({**BINDING, "unexpected": "field"}, id="extra-field"),
        pytest.param(None, id="binding-type"),
    ]
)


async def start_bound_client(client: FrozenMatchdayProtocolClient) -> BoundResponse:
    return await client.start(
        episode_id="episode",
        condition_digest="a" * 64,
        expected_config_digest="b" * 64,
        showdown_revision=SHOWDOWN_REVISION,
        options={},
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["start", "submit"])
async def test_post_response_check_cancellation_poisons_without_retry_write(
    phase: str,
) -> None:
    def handler(request: dict[str, Any], process: FakeProcess) -> None:
        process.output(success(request, bound_result({"method": request["method"]})))

    process = FakeProcess([encoded(READY)], handler)
    client = await FrozenMatchdayProtocolClient.launch(
        FakeRuntime(process), shutdown_timeout=0.02
    )
    if phase == "submit":
        started = await start_bound_client(client)
        assert started.request_id == 1

    entered = asyncio.Event()
    release = asyncio.Event()
    checks = 0
    original_assert_no_unsolicited = client.transport._assert_no_unsolicited

    async def gated_assert_no_unsolicited() -> None:
        nonlocal checks
        checks += 1
        await original_assert_no_unsolicited()
        if checks == 2:
            entered.set()
            await release.wait()

    client.transport._assert_no_unsolicited = gated_assert_no_unsolicited
    if phase == "start":
        request_task = asyncio.create_task(start_bound_client(client))
    else:
        request_task = asyncio.create_task(client.call("submit", {"action": 1}))
    await entered.wait()
    writes_after_response = len(process.writes)
    assert writes_after_response == (1 if phase == "start" else 2)

    request_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await request_task

    poison = client.transport._poison
    assert poison is not None
    assert str(poison) == "referee request was cancelled after its write completed"
    with pytest.raises(ProtocolError, match="poisoned"):
        if phase == "start":
            await start_bound_client(client)
        else:
            await client.call("submit", {"action": 1})
    assert len(process.writes) == writes_after_response

    with pytest.raises(ProtocolError) as closed:
        await client.transport.aclose()
    assert closed.value is poison
    assert client.transport._closed
    assert len(process.writes) == writes_after_response
    await client.transport.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["start", "call"])
@pytest.mark.parametrize("bad_binding", INVALID_REMOTE_BINDINGS)
async def test_every_incomplete_or_mismatched_binding_poisons_before_raising(
    phase: str, bad_binding: Any
) -> None:
    calls = 0

    def handler(request: dict[str, Any], process: FakeProcess) -> None:
        nonlocal calls
        calls += 1
        returned = BINDING if phase == "call" and calls == 1 else bad_binding
        process.output(success(request, bound_result({"call": calls}, returned)))

    process = FakeProcess([encoded(READY)], handler)
    client = await FrozenMatchdayProtocolClient.launch(
        FakeRuntime(process), shutdown_timeout=0.02
    )
    if phase == "call":
        started = await start_bound_client(client)
        assert started.request_id == 1

    with pytest.raises(ProtocolError, match="binding mismatch") as caught:
        if phase == "start":
            await start_bound_client(client)
        else:
            await client.call("observe", {"pid": "p1"})
    writes_after_violation = len(process.writes)
    assert client.transport._poison is caught.value

    with pytest.raises(ProtocolError, match="poisoned"):
        if phase == "start":
            await start_bound_client(client)
        else:
            await client.call("observe", {"pid": "p1"})
    assert len(process.writes) == writes_after_violation

    with pytest.raises(ProtocolError, match="binding mismatch"):
        await client.transport.aclose()
    assert client.transport._closed
    assert len(process.writes) == writes_after_violation
    await client.transport.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "result",
    [
        None,
        {},
        {"binding": BINDING},
        {"value": 1},
        {"binding": BINDING, "value": 1, "x": 2},
    ],
)
async def test_incomplete_bound_result_poisons_retry_and_close(result: Any) -> None:
    process = FakeProcess(
        [encoded(READY)], lambda request, proc: proc.output(success(request, result))
    )
    client = await FrozenMatchdayProtocolClient.launch(
        FakeRuntime(process), shutdown_timeout=0.02
    )
    with pytest.raises(ProtocolError, match="complete bound response") as caught:
        await start_bound_client(client)
    assert client.transport._poison is caught.value
    assert len(process.writes) == 1

    with pytest.raises(ProtocolError, match="poisoned"):
        await start_bound_client(client)
    assert len(process.writes) == 1
    with pytest.raises(ProtocolError, match="complete bound response"):
        await client.transport.aclose()
    assert client.transport._closed


@pytest.mark.asyncio
async def test_bound_controller_blocks_unbound_and_start_restore_snapshot_generic_calls() -> None:
    def handler(request: dict[str, Any], process: FakeProcess) -> None:
        process.output(success(request, bound_result({"started": True})))

    process = FakeProcess([encoded(READY)], handler)
    client = await FrozenMatchdayProtocolClient.launch(
        FakeRuntime(process), shutdown_timeout=0.02
    )
    async with client:
        with pytest.raises(ProtocolError, match="start must bind"):
            await client.call("observe")
        await client.start(
            episode_id="episode",
            condition_digest="a" * 64,
            expected_config_digest="b" * 64,
            showdown_revision=SHOWDOWN_REVISION,
            options={},
        )
        for method in ("start", "restore", "snapshot"):
            with pytest.raises(ProtocolError, match="not available"):
                await client.call(method)


@pytest.mark.asyncio
async def test_process_wait_error_fails_launch_and_launch_cleanup_kills_without_leaks() -> None:
    process = FakeProcess([encoded(READY)], wait_error=OSError("wait transport failed"))
    with pytest.raises(ProtocolError, match="process wait failed"):
        await launch(process, shutdown_timeout=0.002)
    assert process.killed == 1
    assert process._stdout_closed
    assert process._stderr_closed


@pytest.mark.asyncio
async def test_close_cancellation_while_kill_is_awaited_finishes_the_kill() -> None:
    never = asyncio.Event()
    kill_entered = asyncio.Event()
    kill_release = asyncio.Event()

    async def terminate(process: FakeProcess) -> None:
        await never.wait()

    async def kill(process: FakeProcess) -> None:
        kill_entered.set()
        await kill_release.wait()
        process.exit(-9)

    process = FakeProcess(
        [encoded(READY)], terminate_action=terminate, kill_action=kill
    )
    client = await launch(process, shutdown_timeout=0.002)
    close_task = asyncio.create_task(client.aclose())
    await kill_entered.wait()
    close_task.cancel()
    kill_release.set()
    with pytest.raises(asyncio.CancelledError) as caught:
        await close_task
    assert any(
        "cleanup also failed" in note and "terminate timed out" in note
        for note in getattr(caught.value, "__notes__", [])
    )
    assert process._exit.done()
    assert client._closed
    await client.aclose()


@pytest.mark.asyncio
async def test_close_cancellation_while_draining_streams_finishes_stream_cleanup() -> None:
    terminated = asyncio.Event()

    async def terminate(process: FakeProcess) -> None:
        if not process._exit.done():
            process._exit.set_result(-15)
        terminated.set()

    process = FakeProcess([encoded(READY)], terminate_action=terminate)
    client = await launch(process, shutdown_timeout=0.05)
    close_task = asyncio.create_task(client.aclose())
    await terminated.wait()
    close_task.cancel()
    process.close_stdout()
    process.close_stderr()
    with pytest.raises(asyncio.CancelledError):
        await close_task
    assert client._stdout_task.done()
    assert client._stderr_task.done()
    assert client._wait_task.done()


@pytest.mark.asyncio
async def test_late_stderr_drain_error_is_not_dropped_at_normal_close() -> None:
    async def terminate(process: FakeProcess) -> None:
        process.stderr_output(memoryview(b"not-bytes"))
        process.exit(-15)

    process = FakeProcess([encoded(READY)], terminate_action=terminate)
    client = await launch(process)
    with pytest.raises(ProtocolError, match="stderr chunks must be bytes"):
        await client.aclose()
    await client.aclose()


@pytest.mark.asyncio
async def test_outbound_lone_surrogate_is_a_protocol_serialization_error_before_write() -> None:
    process = FakeProcess([encoded(READY)])
    client = await launch(process)
    async with client:
        with pytest.raises(ProtocolError, match="not JSON serializable"):
            await client.request("observe", {"x": "\ud800"})
        assert process.writes == []
