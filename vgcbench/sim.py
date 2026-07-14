import json
import os
import random
import selectors
import shutil
import subprocess
import time
from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Protocol, TypedDict


REPO_ROOT = Path(__file__).resolve().parents[1]
TIMER_RUNNER = Path(__file__).with_name("showdown_timer.cjs")


class PlayerOpts(TypedDict):
    name: str
    team: str


class Outcome(TypedDict):
    winner: str | None
    turns: int
    log: list[str]
    pov: dict[str, list[str]]
    errors: dict[str, int]
    fallbacks: dict[str, int]


class Agent(Protocol):
    def act(self, request: dict, ctx: dict) -> str: ...

    def observe(self, pov_lines: list[str]) -> None: ...


def default_ps_dir() -> Path:
    return Path(os.environ.get("VGCBENCH_PS", REPO_ROOT / "pokemon-showdown")).expanduser()


def default_node() -> str:
    configured = os.environ.get("VGCBENCH_NODE")
    if configured:
        return str(Path(configured).expanduser())
    return shutil.which("node") or str(Path("~/.local/bin/node").expanduser())


def route_update_lines(
    lines: list[str],
    *,
    pov: dict[str, list[str]],
    log: list[str],
    pending_split: list[str],
    winner: str | None,
    turns: int,
) -> tuple[str | None, int]:
    if pending_split:
        lines = pending_split + lines
        pending_split.clear()
    index = 0
    while index < len(lines):
        line = lines[index]
        if line.startswith("|split|"):
            owner = line.split("|", 2)[2]
            if index + 2 >= len(lines):
                pending_split.extend(lines[index:])
                return winner, turns
            secret = lines[index + 1]
            public = lines[index + 2]
            if owner in pov:
                pov[owner].append(secret)
                log.append(secret)
                other = "p2" if owner == "p1" else "p1"
                if public:
                    pov[other].append(public)
            index += 3
            continue
        for pid in pov:
            pov[pid].append(line)
        log.append(line)
        if line.startswith("|turn|"):
            turns = int(line.split("|", 2)[2])
        elif line.startswith("|win|"):
            winner = line.split("|", 2)[2]
        elif line == "|tie":
            winner = None
        index += 1
    return winner, turns


class SimBattle:
    def __init__(
        self,
        format_id: str,
        p1: PlayerOpts,
        p2: PlayerOpts,
        seed=None,
        ps_dir=None,
        node=None,
    ):
        self.format_id = format_id
        self.players = {"p1": p1, "p2": p2}
        if isinstance(seed, int):
            rng = random.Random(seed)
            seed = [rng.randrange(0x10000) for _ in range(4)]
        self.seed = seed
        self.ps_dir = Path(ps_dir).expanduser() if ps_dir else default_ps_dir()
        self.node = str(Path(node).expanduser()) if node else default_node()

    def run(self, agents: dict[str, Agent]) -> Outcome:
        proc = subprocess.Popen(
            [self.node, str(TIMER_RUNNER), str(self.ps_dir)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=self.ps_dir,
        )
        if proc.stdin is None or proc.stdout is None or proc.stderr is None:
            proc.kill()
            raise RuntimeError("failed to open simulator pipes")

        recent_inputs: deque[str] = deque(maxlen=4)
        log: list[str] = []
        pov = {"p1": [], "p2": []}
        pov_cursor = {"p1": 0, "p2": 0}
        errors = {"p1": 0, "p2": 0}
        fallbacks = {"p1": 0, "p2": 0}
        last_request: dict[str, dict | None] = {"p1": None, "p2": None}
        retry_count = {"p1": 0, "p2": 0}
        pending_error: dict[str, str | None] = {"p1": None, "p2": None}
        suppress_request = {"p1": False, "p2": False}
        action_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="vgcbench-player")
        pending_actions: dict[Future[str], str] = {}
        winner = None
        turns = 0
        last_activity = time.monotonic()

        pending_split: list[str] = []

        def send(line: str) -> None:
            nonlocal last_activity
            recent_inputs.append(line)
            proc.stdin.write((line + "\n").encode())
            proc.stdin.flush()
            last_activity = time.monotonic()

        def schedule_act(pid: str, request: dict, error: str | None = None) -> None:
            if pid in pending_actions.values():
                raise RuntimeError(f"received another request while {pid} is still deciding")
            lines = pov[pid][pov_cursor[pid] :]
            pov_cursor[pid] = len(pov[pid])
            future = action_pool.submit(agents[pid].act, request, {"pov_lines": lines, "error": error})
            pending_actions[future] = pid

        def send_finished_actions() -> None:
            for future, pid in list(pending_actions.items()):
                if not future.done():
                    continue
                del pending_actions[future]
                choice = future.result()
                send(f">{pid} {choice}")

        start = {"formatid": self.format_id}
        if self.seed is not None:
            start["seed"] = self.seed
        send(f">start {json.dumps(start, separators=(',', ':'))}")
        for pid in ("p1", "p2"):
            send(f">player {pid} {json.dumps(self.players[pid], separators=(',', ':'))}")

        selector = selectors.DefaultSelector()
        selector.register(proc.stdout, selectors.EVENT_READ)
        selector.register(proc.stderr, selectors.EVENT_READ)
        buffer = bytearray()
        stderr_buffer = bytearray()
        def route_update(lines: list[str]) -> None:
            nonlocal winner, turns
            winner, turns = route_update_lines(
                lines,
                pov=pov,
                log=log,
                pending_split=pending_split,
                winner=winner,
                turns=turns,
            )

        def handle_sideupdate(lines: list[str]) -> None:
            pid = lines[0]
            for line in lines[1:]:
                if line.startswith("|error|"):
                    errors[pid] += 1
                    retry_count[pid] += 1
                    pending_error[pid] = line
                    if retry_count[pid] >= 3:
                        send(f">{pid} default")
                        fallbacks[pid] += 1
                        suppress_request[pid] = "[Unavailable choice]" in line
                        pending_error[pid] = None
                    elif "[Unavailable choice]" not in line and last_request[pid] is not None:
                        schedule_act(pid, last_request[pid], line)
                        pending_error[pid] = None
                elif line.startswith("|timer|"):
                    for future, owner in list(pending_actions.items()):
                        if owner == pid:
                            del pending_actions[future]
                            future.cancel()
                            abandon = getattr(agents[pid], "abandon_decision", None)
                            if callable(abandon):
                                abandon()
                    if line == "|timer|autodefault":
                        fallbacks[pid] += 1
                    pov[pid].append(line)
                    log.append(line)
                elif line.startswith("|request|"):
                    payload = line[len("|request|") :]
                    if not payload:
                        continue
                    request = json.loads(payload)
                    last_request[pid] = request
                    if suppress_request[pid]:
                        suppress_request[pid] = False
                        continue
                    error = pending_error[pid]
                    if error is None:
                        retry_count[pid] = 0
                    pending_error[pid] = None
                    if not request.get("wait"):
                        schedule_act(pid, request, error)

        try:
            ended = False
            while not ended:
                send_finished_actions()
                marker = buffer.find(b"\n\n")
                if marker < 0:
                    remaining = 60 - (time.monotonic() - last_activity)
                    wait_for = 0.1 if pending_actions else max(0, remaining)
                    events = selector.select(wait_for)
                    if not events:
                        if pending_actions:
                            continue
                        raise TimeoutError(
                            f"simulator produced no output for 60 seconds after {list(recent_inputs)}"
                        )
                    chunk = b""
                    stdout_ready = False
                    for key, _ in events:
                        if key.fileobj is proc.stderr:
                            stderr_chunk = os.read(proc.stderr.fileno(), 65536)
                            if stderr_chunk:
                                stderr_buffer.extend(stderr_chunk)
                            else:
                                selector.unregister(proc.stderr)
                        else:
                            chunk = os.read(proc.stdout.fileno(), 65536)
                            stdout_ready = True
                    if not stdout_ready:
                        continue
                    if not chunk:
                        if buffer:
                            message = bytes(buffer)
                            buffer.clear()
                        else:
                            break
                    else:
                        buffer.extend(chunk)
                        last_activity = time.monotonic()
                        continue
                else:
                    message = bytes(buffer[:marker])
                    del buffer[: marker + 2]
                lines = message.decode().splitlines()
                if not lines:
                    continue
                if lines[0] == "update":
                    route_update(lines[1:])
                elif lines[0] == "sideupdate" and len(lines) >= 2:
                    handle_sideupdate(lines[1:])
                elif lines[0] == "end":
                    if len(lines) > 1:
                        data = json.loads("\n".join(lines[1:]))
                        winner = data.get("winner") or winner
                        turns = data.get("turns", turns)
                    ended = True
                elif lines[0].startswith("|"):
                    route_update(lines)
            proc.stdin.close()
            return_code = proc.wait(timeout=10)
            if not ended:
                stderr_buffer.extend(proc.stderr.read())
                stderr = stderr_buffer.decode(errors="replace").strip()[-4000:]
                raise RuntimeError(f"simulator exited {return_code} without an end block: {stderr}")
        except BaseException:
            proc.kill()
            proc.wait()
            raise
        finally:
            selector.close()
            action_pool.shutdown(wait=True, cancel_futures=True)

        for pid, agent in agents.items():
            remaining = pov[pid][pov_cursor[pid] :]
            if remaining:
                agent.observe(remaining)

        return {
            "winner": winner,
            "turns": turns,
            "log": log,
            "pov": pov,
            "errors": errors,
            "fallbacks": fallbacks,
        }
