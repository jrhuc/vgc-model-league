from __future__ import annotations

import asyncio
import json
import math
import reprlib
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from typing import Any, Final

from verifiers.v1 import Runtime, RuntimeProcess

JSONL_PROTOCOL_VERSION: Final = 1
MATCHDAY_PROTOCOL_VERSION: Final = 2
BATTLE_PROTOCOL_VERSION: Final = 2
SHOWDOWN_REVISION: Final = "6a1836dd71c0718e923206f3d089e61074410868"
FROZEN_MATCHDAY_FORMAT: Final = "gen9championsvgc2026regmbbo3"
DEFAULT_REFEREE_EXECUTABLE: Final = "/usr/local/bin/vgc-frozen-matchday-referee"
MAX_ENCODED_LINE_BYTES: Final = 32 * 1024 * 1024
DEFAULT_STDERR_TAIL_BYTES: Final = 64 * 1024


class ProtocolError(RuntimeError):
    """The referee transport or its binding violated the frozen protocol."""


def _reject_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant {value}")


def _parse_int(value: str) -> int:
    parsed = int(value)
    try:
        finite = math.isfinite(float(parsed))
    except OverflowError as exc:
        raise ValueError("JSON integer overflows a finite IEEE-754 number") from exc
    if not finite:
        raise ValueError("JSON integer overflows a finite IEEE-754 number")
    return parsed


def _parse_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError("JSON number is not finite")
    return parsed


def _pairs_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON object key {key!r}")
        value[key] = item
    return value


def _assert_finite_numbers(value: Any) -> None:
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("JSON number is not finite")
    if isinstance(value, dict):
        for item in value.values():
            _assert_finite_numbers(item)
    elif isinstance(value, list):
        for item in value:
            _assert_finite_numbers(item)


def _decode_object(line: bytes) -> dict[str, Any]:
    try:
        text = line.decode("utf-8", errors="strict")
        value = json.loads(
            text,
            object_pairs_hook=_pairs_object,
            parse_constant=_reject_constant,
            parse_float=_parse_float,
            parse_int=_parse_int,
        )
        _assert_finite_numbers(value)
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"invalid referee JSONL stdout: {exc}") from exc
    if not isinstance(value, dict):
        raise ProtocolError("each nonempty referee stdout line must be one JSON object")
    return value


def _exact_int(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ProtocolError(f"{name} must be an integer")
    return value


def _exact_mapping(value: Any, expected: Mapping[str, Any]) -> bool:
    return (
        isinstance(value, dict)
        and set(value) == set(expected)
        and all(type(value[key]) is type(item) and value[key] == item for key, item in expected.items())
    )


def _short_repr(value: Any) -> str:
    formatter = reprlib.Repr()
    formatter.maxdict = 6
    formatter.maxlist = 6
    formatter.maxtuple = 6
    formatter.maxstring = 200
    formatter.maxother = 200
    return formatter.repr(value)


def _as_protocol_error(label: str, exc: BaseException) -> ProtocolError:
    if isinstance(exc, ProtocolError):
        return exc
    return ProtocolError(f"{label}: {exc}")


class RuntimeProcessJsonlClient:
    """Strict request/response JSONL over a v0.3 ``RuntimeProcess``.

    The one-slot response queue is the only decoded-output buffer. Pump task
    completion, rather than a queued sentinel, signals stdout EOF. Request
    parameters are trusted and bounded by the source, task, and controller; the
    exact byte cap is applied after serialization because the standard-library
    JSON encoder has no streaming size preflight.

    RuntimeProcess v0.3 cannot force-cancel a provider coroutine or iterator
    that suppresses ``CancelledError``. Cleanup gives cancellation a bounded
    grace period, then reports and observes such a noncooperative task while
    leaving its lifetime to the owning runtime context.
    """

    def __init__(
        self,
        process: RuntimeProcess,
        *,
        expected_ready: Mapping[str, Any],
        line_limit: int = MAX_ENCODED_LINE_BYTES,
        stderr_tail_bytes: int = DEFAULT_STDERR_TAIL_BYTES,
        shutdown_timeout: float = 5.0,
    ) -> None:
        if line_limit < 1:
            raise ValueError("line_limit must be positive")
        if stderr_tail_bytes < 0:
            raise ValueError("stderr_tail_bytes must be non-negative")
        if shutdown_timeout <= 0 or not math.isfinite(shutdown_timeout):
            raise ValueError("shutdown_timeout must be a positive finite number")
        self.process = process
        self.expected_ready = dict(expected_ready)
        self.line_limit = line_limit
        self.stderr_tail_bytes = stderr_tail_bytes
        self.shutdown_timeout = shutdown_timeout
        self._stderr_tail = bytearray()
        self._responses: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=1)
        self._next_id = 1
        self._closed = False
        self._closing = False
        self._controller_shutdown_started = False
        self._poison: ProtocolError | None = None
        self._close_task: asyncio.Task[None] | None = None
        self._request_lock = asyncio.Lock()
        self._read_lock = asyncio.Lock()
        self._operation_tasks: set[asyncio.Task[Any]] = set()
        self._detached_runtime_tasks: set[asyncio.Task[Any]] = set()

        wait_awaitable = process.wait()
        self._wait_task = asyncio.create_task(wait_awaitable, name="referee-process-wait")
        self._stdout_task = asyncio.create_task(self._drain_stdout(), name="referee-stdout-pump")
        self._stderr_task = asyncio.create_task(self._drain_stderr(), name="referee-stderr-pump")

    @property
    def stderr_tail(self) -> bytes:
        return bytes(self._stderr_tail)

    @classmethod
    async def launch(
        cls,
        runtime: Runtime,
        executable: str,
        *,
        expected_ready: Mapping[str, Any],
        process_env: dict[str, str] | None = None,
        line_limit: int = MAX_ENCODED_LINE_BYTES,
        stderr_tail_bytes: int = DEFAULT_STDERR_TAIL_BYTES,
        shutdown_timeout: float = 5.0,
    ) -> RuntimeProcessJsonlClient:
        if not executable:
            raise ValueError("referee executable must be nonempty")
        if line_limit < 1:
            raise ValueError("line_limit must be positive")
        if stderr_tail_bytes < 0:
            raise ValueError("stderr_tail_bytes must be non-negative")
        if shutdown_timeout <= 0 or not math.isfinite(shutdown_timeout):
            raise ValueError("shutdown_timeout must be a positive finite number")
        ready_copy = dict(expected_ready)
        environment = dict(process_env or {})
        if not getattr(runtime, "supports_live_processes", False):
            raise ProtocolError("referee runtime does not support live processes")
        process = await runtime.open_process([executable], environment)
        client: RuntimeProcessJsonlClient | None = None
        try:
            client = cls(
                process,
                expected_ready=ready_copy,
                line_limit=line_limit,
                stderr_tail_bytes=stderr_tail_bytes,
                shutdown_timeout=shutdown_timeout,
            )
            ready = await client._next_object("ready envelope")
            if not _exact_mapping(ready, client.expected_ready):
                error = ProtocolError(
                    f"referee ready envelope mismatch: expected {client.expected_ready!r}, got {ready!r}"
                )
                client._poison_once(error)
                raise error
            await client._assert_no_unsolicited()
        except BaseException as primary:
            if client is not None:
                try:
                    await client.aclose(check_protocol=False)
                except BaseException as cleanup:
                    primary.add_note(f"referee launch cleanup also failed: {cleanup}")
            raise
        return client

    async def __aenter__(self) -> RuntimeProcessJsonlClient:
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        try:
            await self.aclose(check_protocol=exc is None)
        except BaseException as cleanup:
            if exc is None:
                raise
            exc.add_note(f"referee cleanup also failed: {cleanup}")

    def _poison_once(self, error: BaseException) -> ProtocolError:
        protocol_error = _as_protocol_error("referee protocol failed", error)
        if self._poison is None:
            self._poison = protocol_error
        return self._poison

    def _line_too_large(self) -> ProtocolError:
        return ProtocolError(f"referee stdout line exceeds {self.line_limit} encoded bytes")

    async def _publish_line(self, line: bytes) -> None:
        if not line:
            return
        await self._responses.put(_decode_object(line))

    async def _drain_stdout(self) -> None:
        buffer = bytearray()
        async for raw_chunk in self.process.stdout:
            if not isinstance(raw_chunk, bytes):
                raise ProtocolError("referee stdout chunks must be bytes")
            offset = 0
            chunk_length = len(raw_chunk)
            while offset < chunk_length:
                newline = raw_chunk.find(b"\n", offset)
                end = chunk_length if newline < 0 else newline
                segment_length = end - offset
                total = len(buffer) + segment_length
                last_byte = (
                    raw_chunk[end - 1]
                    if segment_length
                    else (buffer[-1] if buffer else None)
                )
                if newline < 0:
                    pending_crlf = total == self.line_limit + 1 and last_byte == 0x0D
                    if total > self.line_limit and not pending_crlf:
                        raise self._line_too_large()
                else:
                    content_length = total - (1 if last_byte == 0x0D else 0)
                    if content_length > self.line_limit:
                        raise self._line_too_large()

                if newline < 0:
                    if segment_length:
                        buffer.extend(memoryview(raw_chunk)[offset:end])
                    break

                if buffer:
                    if segment_length:
                        buffer.extend(memoryview(raw_chunk)[offset:end])
                    content_length = len(buffer) - (1 if buffer and buffer[-1] == 0x0D else 0)
                    line = bytes(memoryview(buffer)[:content_length])
                    buffer.clear()
                else:
                    content_end = end - (1 if segment_length and raw_chunk[end - 1] == 0x0D else 0)
                    line = raw_chunk[offset:content_end]
                await self._publish_line(line)
                offset = newline + 1

        if buffer:
            if len(buffer) > self.line_limit:
                raise self._line_too_large()
            raise ProtocolError("referee stdout ended with an unterminated JSONL line")

    async def _drain_stderr(self) -> None:
        async for chunk in self.process.stderr:
            if not isinstance(chunk, bytes):
                raise ProtocolError("referee stderr chunks must be bytes")
            limit = self.stderr_tail_bytes
            if not limit or not chunk:
                continue
            if len(chunk) >= limit:
                self._stderr_tail.clear()
                self._stderr_tail.extend(memoryview(chunk)[-limit:])
                continue
            overflow = len(self._stderr_tail) + len(chunk) - limit
            if overflow > 0:
                del self._stderr_tail[:overflow]
            self._stderr_tail.extend(chunk)

    def _stderr_diagnostic(self) -> str:
        return self.stderr_tail.decode("utf-8", errors="replace")

    def _task_exception(self, task: asyncio.Task[Any], label: str) -> ProtocolError | None:
        if not task.done():
            return None
        try:
            task.result()
        except asyncio.CancelledError as exc:
            return ProtocolError(f"{label} was cancelled")
        except BaseException as exc:
            return _as_protocol_error(f"{label} failed", exc)
        return None

    def _wait_result(self) -> int:
        try:
            return _exact_int(self._wait_task.result(), "process exit code")
        except asyncio.CancelledError as exc:
            raise ProtocolError("referee process wait was cancelled") from exc
        except ProtocolError:
            raise
        except BaseException as exc:
            raise ProtocolError(f"referee process wait failed: {exc}") from exc

    def _background_failure(self, expected: str | None = None) -> ProtocolError | None:
        stderr_error = self._task_exception(self._stderr_task, "referee stderr drain")
        if stderr_error is not None:
            return stderr_error
        if self._wait_task.done() and not self._controller_shutdown_started:
            try:
                code = self._wait_result()
                diagnostic = self._stderr_diagnostic()
                suffix = f"; stderr tail: {diagnostic}" if diagnostic else ""
                return ProtocolError(f"referee process exited with status {code}{suffix}")
            except ProtocolError as exc:
                return exc
        if self._stdout_task.done() and self._responses.empty():
            stdout_error = self._task_exception(self._stdout_task, "referee stdout drain")
            if stdout_error is not None:
                return stdout_error
            suffix = f" while awaiting {expected}" if expected else ""
            code: int | None = None
            if self._wait_task.done():
                try:
                    code = self._wait_result()
                except ProtocolError:
                    pass
            return ProtocolError(f"unexpected referee EOF{suffix} (exit={code!r})")
        return None

    async def _wait_for_response_or_background(self, expected: str) -> dict[str, Any]:
        async with self._read_lock:
            while True:
                failure = self._background_failure(expected)
                if failure is not None:
                    raise self._poison_once(failure)
                try:
                    return self._responses.get_nowait()
                except asyncio.QueueEmpty:
                    pass

                get_task = asyncio.create_task(
                    self._responses.get(), name="referee-response-get"
                )
                self._operation_tasks.add(get_task)
                watched: set[asyncio.Task[Any]] = {get_task, self._stdout_task}
                if not self._wait_task.done() and not self._controller_shutdown_started:
                    watched.add(self._wait_task)
                if not self._stderr_task.done():
                    watched.add(self._stderr_task)
                try:
                    await asyncio.wait(watched, return_when=asyncio.FIRST_COMPLETED)
                    failure = self._background_failure(expected)
                    if failure is not None:
                        raise self._poison_once(failure)
                    if get_task.done():
                        return get_task.result()
                finally:
                    if not get_task.done():
                        get_task.cancel()
                    await asyncio.gather(get_task, return_exceptions=True)
                    self._operation_tasks.discard(get_task)

    async def _next_object(self, expected: str) -> dict[str, Any]:
        return await self._wait_for_response_or_background(expected)

    async def _assert_no_unsolicited(self) -> None:
        await asyncio.sleep(0)
        async with self._read_lock:
            try:
                event = self._responses.get_nowait()
            except asyncio.QueueEmpty:
                event = None
            if event is not None:
                error = ProtocolError(f"unsolicited referee response: {_short_repr(event)}")
                raise self._poison_once(error)
            failure = self._background_failure()
            if failure is not None:
                raise self._poison_once(failure)

    def _raise_if_unavailable(self) -> None:
        if self._closed or self._closing:
            raise ProtocolError("referee client is closed")
        if self._poison is not None:
            raise ProtocolError(f"referee client is poisoned: {self._poison}") from self._poison

    def _encode_request(
        self, request_id: int, method: str, params: Mapping[str, Any] | None
    ) -> bytes:
        if params is not None and not isinstance(params, Mapping):
            raise ProtocolError("request params must be a mapping")
        try:
            request = {
                "protocolVersion": JSONL_PROTOCOL_VERSION,
                "id": request_id,
                "method": method,
                "params": dict(params) if params is not None else {},
            }
            encoded = json.dumps(
                request,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            ).encode("utf-8")
        except (TypeError, ValueError, OverflowError, UnicodeError, RecursionError) as exc:
            raise ProtocolError(f"request is not JSON serializable: {exc}") from exc
        if len(encoded) > self.line_limit:
            raise ProtocolError(f"referee request line exceeds {self.line_limit} encoded bytes")
        return encoded + b"\n"

    async def request(self, method: str, params: Mapping[str, Any] | None = None) -> tuple[int, Any]:
        self._raise_if_unavailable()
        if not isinstance(method, str) or not method:
            raise ValueError("method must be a nonempty string")
        async with self._request_lock:
            self._raise_if_unavailable()
            await self._assert_no_unsolicited()
            request_id = self._next_id
            payload = self._encode_request(request_id, method, params)
            self._next_id += 1
            try:
                await self.process.write(payload)
            except asyncio.CancelledError as exc:
                self._poison_once(ProtocolError("referee request write was cancelled"))
                raise
            except BaseException as exc:
                error = ProtocolError(f"referee request write failed: {exc}")
                raise self._poison_once(error) from exc

            try:
                try:
                    response = await self._next_object(f"response id {request_id}")
                except asyncio.CancelledError:
                    raise
                except BaseException as exc:
                    raise self._poison_once(exc)

                response_id = response.get("id")
                if type(response_id) is not int or response_id != request_id:
                    error = ProtocolError(
                        f"referee response id mismatch: expected {request_id}, got {response_id!r}"
                    )
                    raise self._poison_once(error)
                ok = response.get("ok")
                if type(ok) is not bool:
                    error = ProtocolError("referee response must contain a boolean ok field")
                    raise self._poison_once(error)
                if ok:
                    if set(response) != {"id", "ok", "result"}:
                        error = ProtocolError("successful referee response has an invalid envelope")
                        raise self._poison_once(error)
                    result = response["result"]
                else:
                    if set(response) != {"id", "ok", "error"}:
                        error = ProtocolError("error referee response has an invalid envelope")
                        raise self._poison_once(error)
                    detail = response["error"]
                    if (
                        not isinstance(detail, dict)
                        or set(detail) != {"code", "message"}
                        or type(detail["code"]) is not str
                        or type(detail["message"]) is not str
                    ):
                        error = ProtocolError("error referee response has an invalid error object")
                        raise self._poison_once(error)
                    await self._assert_no_unsolicited()
                    raise ProtocolError(
                        f"referee rejected {method!r}: {detail['code']}: {detail['message']}"
                    )
                await self._assert_no_unsolicited()
                return request_id, result
            except asyncio.CancelledError:
                self._poison_once(
                    ProtocolError("referee request was cancelled after its write completed")
                )
                raise

    def _consume_detached_runtime_task(self, task: asyncio.Task[Any]) -> None:
        self._detached_runtime_tasks.discard(task)
        try:
            task.result()
        except BaseException:
            pass

    def _detach_runtime_task(self, task: asyncio.Task[Any]) -> None:
        self._detached_runtime_tasks.add(task)
        task.add_done_callback(self._consume_detached_runtime_task)

    async def _cancel_with_grace(
        self, tasks: set[asyncio.Task[Any]]
    ) -> set[asyncio.Task[Any]]:
        pending = {task for task in tasks if not task.done()}
        for task in pending:
            task.cancel()
        if not pending:
            return set()
        _, noncooperative = await asyncio.wait(
            pending, timeout=self.shutdown_timeout
        )
        for task in noncooperative:
            self._detach_runtime_task(task)
        return noncooperative

    def _noncooperative_error(self, label: str, subject: str) -> ProtocolError:
        return ProtocolError(
            f"referee {label} ignored cancellation for {self.shutdown_timeout} seconds; "
            f"noncooperative RuntimeProcess {subject} remains owned by the runtime context"
        )

    async def _bounded_operation(
        self, label: str, operation: Any
    ) -> ProtocolError | None:
        try:
            awaitable = operation()
            task = asyncio.create_task(awaitable, name=f"referee-{label}")
        except BaseException as exc:
            return ProtocolError(f"referee {label} failed: {exc}")
        self._operation_tasks.add(task)
        try:
            done, _ = await asyncio.wait({task}, timeout=self.shutdown_timeout)
            if not done:
                noncooperative = await self._cancel_with_grace({task})
                if noncooperative:
                    return ProtocolError(
                        f"referee {label} timed out after {self.shutdown_timeout} seconds and "
                        f"ignored cancellation for {self.shutdown_timeout} seconds; "
                        "noncooperative RuntimeProcess coroutine remains owned by the runtime context"
                    )
                return ProtocolError(
                    f"referee {label} timed out after {self.shutdown_timeout} seconds"
                )
            try:
                task.result()
            except asyncio.CancelledError:
                return ProtocolError(f"referee {label} was cancelled")
            except BaseException as exc:
                return ProtocolError(f"referee {label} failed: {exc}")
            return None
        finally:
            if not task.done() and task not in self._detached_runtime_tasks:
                await self._cancel_with_grace({task})
            self._operation_tasks.discard(task)

    async def _bounded_process_wait(self, label: str) -> tuple[bool, ProtocolError | None]:
        done, _ = await asyncio.wait({self._wait_task}, timeout=self.shutdown_timeout)
        if not done:
            return False, ProtocolError(
                f"referee {label} timed out after {self.shutdown_timeout} seconds"
            )
        try:
            self._wait_result()
        except ProtocolError as exc:
            return True, exc
        return True, None

    async def _collect_shutdown_stdout(self) -> ProtocolError | None:
        first: str | None = None
        additional = 0
        async with self._read_lock:
            while True:
                try:
                    event = self._responses.get_nowait()
                except asyncio.QueueEmpty:
                    event = None
                if event is not None:
                    if first is None:
                        first = _short_repr(event)
                    else:
                        additional += 1
                    continue
                if self._stdout_task.done():
                    error = self._task_exception(self._stdout_task, "referee stdout drain")
                    if error is not None:
                        return error
                    break
                get_task = asyncio.create_task(
                    self._responses.get(), name="referee-shutdown-response-get"
                )
                self._operation_tasks.add(get_task)
                try:
                    await asyncio.wait(
                        {get_task, self._stdout_task},
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    if get_task.done():
                        event = get_task.result()
                        if first is None:
                            first = _short_repr(event)
                        else:
                            additional += 1
                finally:
                    if not get_task.done():
                        get_task.cancel()
                    await asyncio.gather(get_task, return_exceptions=True)
                    self._operation_tasks.discard(get_task)
        if first is None:
            return None
        suffix = f" (and {additional} additional records)" if additional else ""
        return ProtocolError(f"unsolicited referee response during shutdown: {first}{suffix}")

    async def _cleanup(self, check_protocol: bool) -> None:
        issues: list[BaseException] = []
        issue_keys: set[tuple[type[BaseException], str]] = set()
        collector: asyncio.Task[ProtocolError | None] | None = None

        def add_issue(issue: BaseException | None) -> None:
            if issue is None or isinstance(issue, asyncio.CancelledError):
                return
            key = (type(issue), str(issue))
            if key not in issue_keys:
                issue_keys.add(key)
                issues.append(issue)

        def task_subject(task: asyncio.Task[Any]) -> tuple[str, str]:
            if task is self._stdout_task:
                return "stdout drain", "stdout iterator"
            if task is self._stderr_task:
                return "stderr drain", "stderr iterator"
            if task is self._wait_task:
                return "process wait", "wait coroutine"
            if collector is not None and task is collector:
                return "stdout collector", "stdout iterator collector"
            return task.get_name(), "coroutine"

        try:
            await asyncio.sleep(0)
            if check_protocol:
                add_issue(self._poison)

            stdout_was_done = self._stdout_task.done()
            wait_was_done = self._wait_task.done()
            preexisting_wait_valid = wait_was_done
            if stdout_was_done:
                stdout_error = self._task_exception(self._stdout_task, "referee stdout drain")
                add_issue(stdout_error or ProtocolError("unexpected referee EOF before controller shutdown"))
            if wait_was_done:
                try:
                    code = self._wait_result()
                    add_issue(
                        ProtocolError(
                            f"referee process exited with status {code} before controller shutdown"
                        )
                    )
                except ProtocolError as exc:
                    preexisting_wait_valid = False
                    add_issue(exc)
            add_issue(self._task_exception(self._stderr_task, "referee stderr drain"))

            self._controller_shutdown_started = True
            collector = asyncio.create_task(
                self._collect_shutdown_stdout(), name="referee-shutdown-stdout-collector"
            )

            wait_finished = wait_was_done
            wait_valid = preexisting_wait_valid
            if not wait_was_done:
                add_issue(await self._bounded_operation("terminate", self.process.terminate))
                wait_finished, wait_error = await self._bounded_process_wait("initial wait")
                wait_valid = wait_finished and wait_error is None
                if wait_finished:
                    add_issue(wait_error)
            if not wait_finished or not wait_valid:
                add_issue(await self._bounded_operation("kill", self.process.kill))
                if not wait_finished:
                    wait_finished, wait_error = await self._bounded_process_wait("post-kill wait")
                    add_issue(wait_error)
            if wait_finished:
                try:
                    self._wait_result()
                except ProtocolError as exc:
                    add_issue(exc)

            stream_tasks: set[asyncio.Task[Any]] = {
                self._stdout_task,
                self._stderr_task,
                collector,
            }
            _, pending = await asyncio.wait(
                stream_tasks, timeout=self.shutdown_timeout
            )
            if pending:
                noncooperative = await self._cancel_with_grace(pending)
                if self._stdout_task in pending:
                    if self._stdout_task in noncooperative:
                        add_issue(
                            self._noncooperative_error(
                                "stdout drain", "stdout iterator"
                            )
                        )
                    else:
                        add_issue(ProtocolError("referee stdout drain did not finish after shutdown"))
                if self._stderr_task in pending:
                    if self._stderr_task in noncooperative:
                        add_issue(
                            self._noncooperative_error(
                                "stderr drain", "stderr iterator"
                            )
                        )
                    else:
                        add_issue(ProtocolError("referee stderr drain did not finish after shutdown"))
                if collector in pending and self._stdout_task not in pending:
                    if collector in noncooperative:
                        add_issue(
                            self._noncooperative_error(
                                "stdout collector", "stdout iterator collector"
                            )
                        )
                    else:
                        add_issue(ProtocolError("referee stdout collector did not finish after shutdown"))
            if collector.done() and not collector.cancelled():
                try:
                    add_issue(collector.result())
                except BaseException as exc:
                    add_issue(_as_protocol_error("referee stdout collector failed", exc))
            add_issue(self._task_exception(self._stdout_task, "referee stdout drain"))
            add_issue(self._task_exception(self._stderr_task, "referee stderr drain"))
        except BaseException as exc:
            if isinstance(exc, asyncio.CancelledError):
                raise
            add_issue(_as_protocol_error("referee cleanup failed", exc))
        finally:
            tasks: set[asyncio.Task[Any]] = {
                self._stdout_task,
                self._stderr_task,
                self._wait_task,
                *self._operation_tasks,
            }
            if collector is not None:
                tasks.add(collector)
            cancellable = {
                task
                for task in tasks
                if not task.done() and task not in self._detached_runtime_tasks
            }
            noncooperative = await self._cancel_with_grace(cancellable)
            for task in noncooperative:
                label, subject = task_subject(task)
                add_issue(self._noncooperative_error(label, subject))
            for task in tasks:
                if not task.done():
                    continue
                try:
                    task.result()
                except asyncio.CancelledError:
                    pass
                except BaseException as exc:
                    if task is self._stdout_task:
                        add_issue(_as_protocol_error("referee stdout drain failed", exc))
                    elif task is self._stderr_task:
                        add_issue(_as_protocol_error("referee stderr drain failed", exc))
                    elif task is self._wait_task:
                        add_issue(_as_protocol_error("referee process wait failed", exc))
                    elif collector is not None and task is collector:
                        add_issue(_as_protocol_error("referee stdout collector failed", exc))
                    else:
                        add_issue(_as_protocol_error(f"{task.get_name()} failed", exc))
            self._operation_tasks.clear()
            self._closed = True

        if issues:
            primary = _as_protocol_error("referee cleanup failed", issues[0])
            for detail in issues[1:]:
                primary.add_note(f"additional cleanup failure: {detail}")
            diagnostic = self._stderr_diagnostic()
            if diagnostic:
                primary.add_note(f"stderr tail: {diagnostic}")
            raise primary

    async def aclose(self, *, check_protocol: bool = True) -> None:
        if self._closed:
            return
        if self._close_task is None:
            self._closing = True
            self._close_task = asyncio.create_task(
                self._cleanup(check_protocol), name="referee-client-close"
            )
        close_task = self._close_task
        cancellation: asyncio.CancelledError | None = None
        cleanup_error: BaseException | None = None
        while True:
            try:
                await asyncio.shield(close_task)
            except asyncio.CancelledError as exc:
                current = asyncio.current_task()
                if close_task.cancelled() and (
                    current is None or current.cancelling() == 0
                ):
                    cleanup_error = ProtocolError("referee cleanup task was cancelled")
                    break
                if cancellation is None:
                    cancellation = exc
                if close_task.done():
                    break
            except BaseException as exc:
                cleanup_error = exc
                break
            else:
                break

        if close_task.done() and cleanup_error is None:
            try:
                close_task.result()
            except asyncio.CancelledError:
                cleanup_error = ProtocolError("referee cleanup task was cancelled")
            except BaseException as exc:
                cleanup_error = exc
        if cancellation is not None:
            if cleanup_error is not None:
                detail = str(cleanup_error) or type(cleanup_error).__name__
                cancellation.add_note(f"referee cleanup also failed: {detail}")
            raise cancellation
        if cleanup_error is not None:
            raise cleanup_error


@dataclass(frozen=True)
class ProtocolBinding:
    episode_id: str
    condition_digest: str
    config_digest: str
    showdown_revision: str
    matchday_protocol_version: int
    battle_protocol_version: int

    def to_wire(self) -> dict[str, Any]:
        return {
            "episodeId": self.episode_id,
            "conditionDigest": self.condition_digest,
            "configDigest": self.config_digest,
            "showdownRevision": self.showdown_revision,
            "matchdayProtocolVersion": self.matchday_protocol_version,
            "battleProtocolVersion": self.battle_protocol_version,
        }


@dataclass(frozen=True)
class BoundResponse:
    request_id: int
    value: Any


class FrozenMatchdayProtocolClient:
    """Frozen matchday methods with complete binding checks on every response."""

    def __init__(self, transport: RuntimeProcessJsonlClient) -> None:
        self.transport = transport
        self.binding: ProtocolBinding | None = None

    @classmethod
    async def launch(
        cls,
        runtime: Runtime,
        *,
        executable: str = DEFAULT_REFEREE_EXECUTABLE,
        showdown_revision: str = SHOWDOWN_REVISION,
        jsonl_protocol_version: int = JSONL_PROTOCOL_VERSION,
        matchday_protocol_version: int = MATCHDAY_PROTOCOL_VERSION,
        battle_protocol_version: int = BATTLE_PROTOCOL_VERSION,
        stderr_tail_bytes: int = DEFAULT_STDERR_TAIL_BYTES,
        shutdown_timeout: float = 5.0,
    ) -> FrozenMatchdayProtocolClient:
        expected_ready = {
            "kind": "ready",
            "protocolVersion": jsonl_protocol_version,
            "matchdayProtocolVersion": matchday_protocol_version,
            "battleProtocolVersion": battle_protocol_version,
            "showdownRevision": showdown_revision,
        }
        transport = await RuntimeProcessJsonlClient.launch(
            runtime,
            executable,
            expected_ready=expected_ready,
            stderr_tail_bytes=stderr_tail_bytes,
            shutdown_timeout=shutdown_timeout,
        )
        return cls(transport)

    async def __aenter__(self) -> FrozenMatchdayProtocolClient:
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        await self.transport.__aexit__(exc_type, exc, traceback)

    async def start(
        self,
        *,
        episode_id: str,
        condition_digest: str,
        expected_config_digest: str,
        showdown_revision: str,
        options: dict[str, Any],
        matchday_protocol_version: int = MATCHDAY_PROTOCOL_VERSION,
        battle_protocol_version: int = BATTLE_PROTOCOL_VERSION,
    ) -> BoundResponse:
        if self.binding is not None:
            raise ProtocolError("referee is already bound")
        binding = ProtocolBinding(
            episode_id=episode_id,
            condition_digest=condition_digest,
            config_digest=expected_config_digest,
            showdown_revision=showdown_revision,
            matchday_protocol_version=matchday_protocol_version,
            battle_protocol_version=battle_protocol_version,
        )
        self.binding = binding
        try:
            return await self._bound_request(
                "start",
                {
                    "episodeId": episode_id,
                    "conditionDigest": condition_digest,
                    "showdownRevision": showdown_revision,
                    "options": options,
                },
            )
        except BaseException:
            self.binding = None
            raise

    async def call(self, method: str, params: Mapping[str, Any] | None = None) -> BoundResponse:
        if self.binding is None:
            raise ProtocolError("start must bind the referee before method calls")
        if method in {"start", "restore", "snapshot"}:
            raise ProtocolError(f"method {method!r} is not available through the bound controller")
        return await self._bound_request(method, params)

    async def _bound_request(
        self, method: str, params: Mapping[str, Any] | None
    ) -> BoundResponse:
        expected = self.binding
        if expected is None:
            raise ProtocolError("referee binding is unavailable")
        request_id, result = await self.transport.request(method, params)
        if not isinstance(result, dict) or set(result) != {"binding", "value"}:
            error = ProtocolError(f"{method!r} did not return a complete bound response")
            raise self.transport._poison_once(error)
        binding = result["binding"]
        if not _exact_mapping(binding, expected.to_wire()):
            error = ProtocolError(
                f"{method!r} binding mismatch: expected {expected.to_wire()!r}, got {binding!r}"
            )
            raise self.transport._poison_once(error)
        return BoundResponse(request_id=request_id, value=result["value"])
