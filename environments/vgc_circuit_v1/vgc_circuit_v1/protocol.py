from __future__ import annotations

import asyncio
import json
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final

from verifiers.v1 import Runtime, RuntimeProcess

JSONL_PROTOCOL_VERSION: Final = 1
CIRCUIT_PROTOCOL_VERSION: Final = 2
PROMPT_PROTOCOL_VERSION: Final = 2
MATCHDAY_PROTOCOL_VERSION: Final = 1
BATTLE_PROTOCOL_VERSION: Final = 1
SHOWDOWN_REVISION: Final = "6a1836dd71c0718e923206f3d089e61074410868"
CIRCUIT_FORMAT_ID: Final = "gen9championsvgc2026regmbbo3"
SCENARIO_IDS: Final = ("victory-road-top8-v1", "draft-league-v1")
DEFAULT_REFEREE_EXECUTABLE: Final = "/usr/local/bin/vgc-circuit-referee"
# Mutable unpublished tag. Hosted runs must override with a reviewed digest.
DEFAULT_REFEREE_IMAGE: Final = "ghcr.io/jrhuc/vgc-circuit-referee:0.1.0"
MAX_ENCODED_LINE_BYTES: Final = 32 * 1024 * 1024
DEFAULT_STDERR_TAIL_BYTES: Final = 64 * 1024
DEFAULT_REQUEST_TIMEOUT: Final = 600.0

SUBSTRATE_PIN: Final = {
    "format": CIRCUIT_FORMAT_ID,
    "showdownRevision": SHOWDOWN_REVISION,
    "jsonlProtocolVersion": JSONL_PROTOCOL_VERSION,
    "circuitProtocolVersion": CIRCUIT_PROTOCOL_VERSION,
    "promptProtocolVersion": PROMPT_PROTOCOL_VERSION,
    "matchdayProtocolVersion": MATCHDAY_PROTOCOL_VERSION,
    "battleProtocolVersion": BATTLE_PROTOCOL_VERSION,
}

_ALLOWED_METHODS = {"observe", "pending_turns", "submit", "terminal"}
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class ProtocolError(RuntimeError):
    pass


@dataclass(frozen=True)
class ProtocolBinding:
    episode_id: str
    condition_digest: str
    scenario_id: str
    seed: int
    config_digest: str
    showdown_revision: str
    jsonl_protocol_version: int
    circuit_protocol_version: int
    prompt_protocol_version: int
    matchday_protocol_version: int
    battle_protocol_version: int
    prompt_revision: str

    def to_wire(self) -> dict[str, Any]:
        return {
            "episodeId": self.episode_id,
            "conditionDigest": self.condition_digest,
            "scenarioId": self.scenario_id,
            "seed": self.seed,
            "configDigest": self.config_digest,
            "showdownRevision": self.showdown_revision,
            "jsonlProtocolVersion": self.jsonl_protocol_version,
            "circuitProtocolVersion": self.circuit_protocol_version,
            "promptProtocolVersion": self.prompt_protocol_version,
            "matchdayProtocolVersion": self.matchday_protocol_version,
            "battleProtocolVersion": self.battle_protocol_version,
            "promptRevision": self.prompt_revision,
        }



class VgcCircuitProtocolClient:

    def __init__(
        self,
        process: RuntimeProcess,
        *,
        ready: Mapping[str, Any],
        line_limit: int,
        stderr_tail_bytes: int,
        shutdown_timeout: float,
        request_timeout: float,
    ) -> None:
        self.process = process
        self.ready = dict(ready)
        self.line_limit = line_limit
        self.stderr_tail_bytes = stderr_tail_bytes
        self.shutdown_timeout = shutdown_timeout
        self.request_timeout = request_timeout
        self.binding: ProtocolBinding | None = None
        self._responses: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=1)
        self._stderr = bytearray()
        self._request_lock = asyncio.Lock()
        self._next_id = 1
        self._poison: ProtocolError | None = None
        self._closing = False
        self._closed = False
        self._stdout_eof_before_close = False
        self._exit_before_close: tuple[int] | None = None
        self._close_task: asyncio.Task[None] | None = None
        self._wait_task = asyncio.create_task(self._wait(), name="circuit-process-wait")
        self._stdout_task = asyncio.create_task(self._stdout(), name="circuit-stdout")
        self._stderr_task = asyncio.create_task(self._stderr_pump(), name="circuit-stderr")

    @classmethod
    async def launch(
        cls,
        runtime: Runtime,
        *,
        executable: str = DEFAULT_REFEREE_EXECUTABLE,
        showdown_revision: str = SHOWDOWN_REVISION,
        jsonl_protocol_version: int = JSONL_PROTOCOL_VERSION,
        circuit_protocol_version: int = CIRCUIT_PROTOCOL_VERSION,
        prompt_protocol_version: int = PROMPT_PROTOCOL_VERSION,
        matchday_protocol_version: int = MATCHDAY_PROTOCOL_VERSION,
        battle_protocol_version: int = BATTLE_PROTOCOL_VERSION,
        line_limit: int = MAX_ENCODED_LINE_BYTES,
        stderr_tail_bytes: int = DEFAULT_STDERR_TAIL_BYTES,
        shutdown_timeout: float = 5.0,
        request_timeout: float = DEFAULT_REQUEST_TIMEOUT,
    ) -> "VgcCircuitProtocolClient":
        if not executable:
            raise ValueError("referee executable must be nonempty")
        if line_limit < 1 or stderr_tail_bytes < 0:
            raise ValueError("invalid referee output limits")
        if shutdown_timeout <= 0 or not math.isfinite(shutdown_timeout):
            raise ValueError("shutdown_timeout must be positive and finite")
        if request_timeout <= 0 or not math.isfinite(request_timeout):
            raise ValueError("request_timeout must be positive and finite")
        if not runtime.supports_live_processes:
            raise ProtocolError("referee runtime does not support live processes")
        process = await runtime.open_process([executable], {})
        client = cls(
            process,
            ready={
                "kind": "ready",
                "protocolVersion": jsonl_protocol_version,
                "circuitProtocolVersion": circuit_protocol_version,
                "promptProtocolVersion": prompt_protocol_version,
                "matchdayProtocolVersion": matchday_protocol_version,
                "battleProtocolVersion": battle_protocol_version,
                "showdownRevision": showdown_revision,
                "scenarios": list(SCENARIO_IDS),
            },
            line_limit=line_limit,
            stderr_tail_bytes=stderr_tail_bytes,
            shutdown_timeout=shutdown_timeout,
            request_timeout=request_timeout,
        )
        try:
            ready = await client._receive_bounded("ready envelope")
            if not _exact_mapping(ready, client.ready):
                raise client._poison_with("referee ready envelope mismatch")
        except BaseException as primary:
            try:
                await client.aclose(check_protocol=False)
            except BaseException as cleanup:
                primary.add_note(f"referee cleanup also failed: {cleanup}")
            raise
        return client

    async def __aenter__(self) -> VgcCircuitProtocolClient:
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        try:
            await self.aclose(check_protocol=exc is None)
        except BaseException as cleanup:
            if exc is None:
                raise
            exc.add_note(f"referee cleanup also failed: {cleanup}")

    @property
    def stderr_tail(self) -> bytes:
        return bytes(self._stderr)

    def _poison_with(self, message: str, cause: BaseException | None = None) -> ProtocolError:
        if self._poison is None:
            self._poison = ProtocolError(message)
            if cause is not None:
                self._poison.__cause__ = cause
        return self._poison

    async def _stdout(self) -> None:
        buffer = bytearray()
        async for chunk in self.process.stdout:
            if not isinstance(chunk, bytes):
                raise ProtocolError("referee stdout chunks must be bytes")
            offset = 0
            while offset < len(chunk):
                newline = chunk.find(b"\n", offset)
                end = len(chunk) if newline < 0 else newline
                if end > offset:
                    buffer.extend(memoryview(chunk)[offset:end])
                content_size = len(buffer) - (
                    1 if newline >= 0 and buffer and buffer[-1] == 13 else 0
                )
                pending_cr = newline < 0 and len(buffer) == self.line_limit + 1 and buffer[-1] == 13
                if content_size > self.line_limit and not pending_cr:
                    raise ProtocolError(
                        f"referee stdout line exceeds {self.line_limit} encoded bytes"
                    )
                if newline < 0:
                    break
                line = bytes(buffer[:content_size])
                buffer.clear()
                offset = newline + 1
                if line:
                    await self._responses.put(_decode(line))
        if buffer:
            raise ProtocolError("referee stdout ended with an unterminated JSONL line")
        if not self._closing:
            self._stdout_eof_before_close = True

    async def _wait(self) -> int:
        status = await self.process.wait()
        if not self._closing:
            self._exit_before_close = (status,)
        return status

    async def _stderr_pump(self) -> None:
        async for chunk in self.process.stderr:
            if not isinstance(chunk, bytes):
                raise ProtocolError("referee stderr chunks must be bytes")
            if not self.stderr_tail_bytes:
                continue
            self._stderr.extend(chunk[-self.stderr_tail_bytes :])
            if len(self._stderr) > self.stderr_tail_bytes:
                del self._stderr[: -self.stderr_tail_bytes]

    def _background_error(self, expected: str) -> ProtocolError | None:
        for task, label in (
            (self._stdout_task, "stdout"),
            (self._stderr_task, "stderr"),
            (self._wait_task, "process"),
        ):
            if not task.done():
                continue
            if task is self._wait_task and self._closing:
                continue
            try:
                result = task.result()
            except asyncio.CancelledError:
                return ProtocolError(f"referee {label} task was cancelled")
            except BaseException as exc:
                return ProtocolError(f"referee {label} failed: {exc}")
            if task is self._stdout_task:
                return ProtocolError(f"unexpected referee EOF while awaiting {expected}")
            if task is self._wait_task:
                tail = self.stderr_tail.decode("utf-8", errors="replace")
                detail = f"; stderr tail: {tail}" if tail else ""
                return ProtocolError(f"referee exited with status {result}{detail}")
        return None

    async def _receive(self, expected: str) -> dict[str, Any]:
        while True:
            try:
                return self._responses.get_nowait()
            except asyncio.QueueEmpty:
                pass
            if error := self._background_error(expected):
                raise self._poison_with(str(error), error)
            get = asyncio.create_task(self._responses.get())
            watched = {get, self._stdout_task, self._stderr_task, self._wait_task}
            try:
                await asyncio.wait(watched, return_when=asyncio.FIRST_COMPLETED)
                if get.done():
                    return get.result()
            finally:
                if not get.done():
                    get.cancel()
                await asyncio.gather(get, return_exceptions=True)

    async def _receive_bounded(self, expected: str) -> dict[str, Any]:
        try:
            return await asyncio.wait_for(
                self._receive(expected), timeout=self.request_timeout
            )
        except TimeoutError as exc:
            raise self._poison_with(
                f"referee did not produce {expected} within {self.request_timeout} seconds"
            ) from exc

    def _available(self) -> None:
        if self._closed or self._closing:
            raise ProtocolError("referee client is closed")
        if self._poison is not None:
            raise ProtocolError(f"referee client is poisoned: {self._poison}") from self._poison
        if error := self._background_error("request"):
            raise self._poison_with(str(error), error)

    def _encode(self, request_id: int, method: str, params: Mapping[str, Any]) -> bytes:
        try:
            payload = json.dumps(
                {
                    "protocolVersion": JSONL_PROTOCOL_VERSION,
                    "id": request_id,
                    "method": method,
                    "params": dict(params),
                },
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            ).encode("utf-8")
        except (TypeError, ValueError, OverflowError, UnicodeError, RecursionError) as exc:
            raise ProtocolError("referee request is not JSON data") from exc
        if len(payload) > self.line_limit:
            raise ProtocolError(
                f"referee request line exceeds {self.line_limit} encoded bytes"
            )
        return payload + b"\n"

    async def _request(self, method: str, params: Mapping[str, Any]) -> Any:
        async with self._request_lock:
            self._available()
            request_id = self._next_id
            payload = self._encode(request_id, method, params)
            self._next_id += 1
            try:
                await self.process.write(payload)
            except asyncio.CancelledError:
                self._poison_with("referee request write was cancelled")
                raise
            except BaseException as exc:
                raise self._poison_with("referee request write failed", exc) from exc
            try:
                response = await self._receive_bounded(f"response {request_id}")
            except asyncio.CancelledError:
                self._poison_with("referee request was cancelled after write")
                raise
            if response.get("id") != request_id or type(response.get("id")) is not int:
                raise self._poison_with("referee response id mismatch")
            if response.get("ok") is True and set(response) == {"id", "ok", "result"}:
                return response["result"]
            if response.get("ok") is False and set(response) == {"id", "ok", "error"}:
                detail = response["error"]
                if isinstance(detail, dict) and set(detail) == {"code", "message"}:
                    if all(isinstance(detail[key], str) for key in detail):
                        raise ProtocolError(
                            f"referee rejected {method}: {detail['code']}: {detail['message']}"
                        )
            raise self._poison_with("referee response envelope is invalid")

    async def start(
        self,
        *,
        episode_id: str,
        condition_digest: str,
        scenario_id: str,
        seed: int,
    ) -> Any:
        if self.binding is not None:
            raise ProtocolError("referee is already bound")
        raw = await self._request(
            "start",
            {
                "episodeId": episode_id,
                "conditionDigest": condition_digest,
                "showdownRevision": SHOWDOWN_REVISION,
                "options": {"scenarioId": scenario_id, "seed": seed},
            },
        )
        if not isinstance(raw, dict) or set(raw) != {"binding", "value"}:
            raise self._poison_with("start returned an incomplete binding")
        binding = _parse_start_binding(
            raw["binding"],
            episode_id=episode_id,
            condition_digest=condition_digest,
            scenario_id=scenario_id,
            seed=seed,
        )
        self.binding = binding
        return raw["value"]

    async def call(self, method: str, params: Mapping[str, Any] | None = None) -> Any:
        if self.binding is None:
            raise ProtocolError("start must bind the referee before calls")
        if method not in _ALLOWED_METHODS:
            raise ProtocolError(f"unsupported circuit method {method!r}")
        return self._unwrap(method, await self._request(method, params or {}))

    def _unwrap(self, method: str, result: Any) -> Any:
        expected = self.binding
        if expected is None or not isinstance(result, dict) or set(result) != {"binding", "value"}:
            raise self._poison_with(f"{method} returned an incomplete binding")
        if not _exact_mapping(result["binding"], expected.to_wire()):
            raise self._poison_with(f"{method} returned a mismatched binding")
        return result["value"]

    async def _operation(self, name: str, operation: Any) -> ProtocolError | None:
        task = asyncio.create_task(operation(), name=f"circuit-{name}")
        try:
            await asyncio.wait_for(task, timeout=self.shutdown_timeout)
        except asyncio.TimeoutError:
            return None
        except BaseException as exc:
            error = ProtocolError(f"referee {name} failed: {exc}")
            error.__cause__ = exc
            return error
        return None

    async def _shutdown(self, check_protocol: bool) -> None:
        self._closing = True
        issues: list[ProtocolError] = []
        queued_issue = False
        if check_protocol:
            if self._poison is not None:
                issues.append(self._poison)
            if self._stdout_eof_before_close:
                issues.append(ProtocolError("unexpected referee EOF before close"))
            if self._exit_before_close is not None:
                issues.append(
                    ProtocolError(
                        f"referee exited with status {self._exit_before_close[0]} before close"
                    )
                )
            if not self._responses.empty():
                issues.append(ProtocolError("unsolicited referee record queued at close"))
                queued_issue = True
        if not self._wait_task.done():
            if error := await self._operation("terminate", self.process.terminate):
                issues.append(error)
            done, _ = await asyncio.wait(
                {self._wait_task}, timeout=self.shutdown_timeout
            )
            if not done:
                if error := await self._operation("kill", self.process.kill):
                    issues.append(error)
                done, _ = await asyncio.wait(
                    {self._wait_task}, timeout=self.shutdown_timeout
                )
                if not done:
                    issues.append(ProtocolError("referee did not exit after kill"))
        tasks = (self._stdout_task, self._stderr_task, self._wait_task)
        for task in tasks:
            if not task.done():
                task.cancel()
        try:
            results = await asyncio.wait_for(
                asyncio.gather(*tasks, return_exceptions=True),
                timeout=self.shutdown_timeout,
            )
        except asyncio.TimeoutError:
            results = []
            issues.append(ProtocolError("referee stream cleanup timed out"))
        for result, label in zip(results, ("stdout", "stderr", "process")):
            if isinstance(result, BaseException) and not isinstance(
                result, asyncio.CancelledError
            ):
                issues.append(ProtocolError(f"referee {label} cleanup failed: {result}"))
        if check_protocol and not queued_issue and not self._responses.empty():
            issues.append(ProtocolError("unsolicited referee record queued at close"))
        self._closed = True
        if issues:
            error = issues[0]
            for additional in issues[1:]:
                error.add_note(f"additional referee error: {additional}")
            tail = self.stderr_tail.decode("utf-8", errors="replace")
            if tail:
                error.add_note(f"stderr tail: {tail}")
            raise error

    async def aclose(self, *, check_protocol: bool = True) -> None:
        if self._closed:
            return
        if self._close_task is None:
            self._close_task = asyncio.create_task(
                self._shutdown(check_protocol), name="circuit-close"
            )
        cancellation: asyncio.CancelledError | None = None
        while not self._close_task.done():
            try:
                await asyncio.shield(self._close_task)
            except asyncio.CancelledError as exc:
                cancellation = cancellation or exc
        error: BaseException | None = None
        try:
            self._close_task.result()
        except BaseException as exc:
            error = exc
        if cancellation is not None:
            if error is not None:
                cancellation.add_note(f"referee cleanup also failed: {error}")
            raise cancellation
        if error is not None:
            raise error



def _parse_start_binding(
    value: Any,
    *,
    episode_id: str,
    condition_digest: str,
    scenario_id: str,
    seed: int,
) -> ProtocolBinding:
    if not isinstance(value, dict) or set(value) != {
        "episodeId",
        "conditionDigest",
        "scenarioId",
        "seed",
        "configDigest",
        "showdownRevision",
        "jsonlProtocolVersion",
        "circuitProtocolVersion",
        "promptProtocolVersion",
        "matchdayProtocolVersion",
        "battleProtocolVersion",
        "promptRevision",
    }:
        raise ProtocolError("start binding has an unexpected schema")
    expected = {
        "episodeId": episode_id,
        "conditionDigest": condition_digest,
        "scenarioId": scenario_id,
        "seed": seed,
        "showdownRevision": SHOWDOWN_REVISION,
        "jsonlProtocolVersion": JSONL_PROTOCOL_VERSION,
        "circuitProtocolVersion": CIRCUIT_PROTOCOL_VERSION,
        "promptProtocolVersion": PROMPT_PROTOCOL_VERSION,
        "matchdayProtocolVersion": MATCHDAY_PROTOCOL_VERSION,
        "battleProtocolVersion": BATTLE_PROTOCOL_VERSION,
    }
    if any(
        type(value.get(key)) is not type(item) or value.get(key) != item
        for key, item in expected.items()
    ):
        raise ProtocolError("start binding does not match the requested case")
    digest = value.get("configDigest")
    if not isinstance(digest, str) or _SHA256.fullmatch(digest) is None:
        raise ProtocolError("start binding configDigest must be lowercase 64-hex")
    prompt_revision = value.get("promptRevision")
    if not isinstance(prompt_revision, str) or not prompt_revision:
        raise ProtocolError("start binding promptRevision must be nonempty text")
    return ProtocolBinding(
        episode_id=episode_id,
        condition_digest=condition_digest,
        scenario_id=scenario_id,
        seed=seed,
        config_digest=digest,
        showdown_revision=SHOWDOWN_REVISION,
        jsonl_protocol_version=JSONL_PROTOCOL_VERSION,
        circuit_protocol_version=CIRCUIT_PROTOCOL_VERSION,
        prompt_protocol_version=PROMPT_PROTOCOL_VERSION,
        matchday_protocol_version=MATCHDAY_PROTOCOL_VERSION,
        battle_protocol_version=BATTLE_PROTOCOL_VERSION,
        prompt_revision=prompt_revision,
    )

def _exact_mapping(value: Any, expected: Mapping[str, Any]) -> bool:
    return (
        isinstance(value, dict)
        and set(value) == set(expected)
        and all(
            type(value[key]) is type(item) and value[key] == item
            for key, item in expected.items()
        )
    )


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def _decode(line: bytes) -> dict[str, Any]:
    try:
        value = json.loads(
            line.decode("utf-8", errors="strict"),
            object_pairs_hook=_pairs,
            parse_constant=lambda value: (_ for _ in ()).throw(
                ValueError(f"invalid JSON constant {value}")
            ),
            parse_float=_finite_float,
            parse_int=_finite_int,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError) as exc:
        raise ProtocolError("invalid referee JSONL stdout") from exc
    if not isinstance(value, dict):
        raise ProtocolError("referee JSONL records must be objects")
    return value


def _finite_float(value: str) -> float:
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("JSON number is not finite")
    return result


def _finite_int(value: str) -> int:
    result = int(value)
    try:
        finite = math.isfinite(float(result))
    except OverflowError:
        finite = False
    if not finite:
        raise ValueError("JSON integer is outside the interoperable range")
    return result
