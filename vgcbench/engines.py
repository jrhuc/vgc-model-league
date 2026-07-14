import json
import random
import re
import threading
import time
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

from .choices import SlotMenu, build_menus, compose
from .prompts import SYSTEM, render_decision
from .providers import Completion, assistant_tool_message, tool_result_message
from .reference import DEX_TOOLS, ShowdownReference
from .state import BattleState


class BaseEngine(ABC):
    def __init__(self, pid: str) -> None:
        if pid not in {"p1", "p2"}:
            raise ValueError("pid must be 'p1' or 'p2'")
        self.pid = pid

    def begin_game(self, **context: Any) -> None:
        pass

    def end_game(self, **context: Any) -> None:
        pass

    def observe(self, pov_lines: list[str]) -> None:
        pass

    def decision_stats(self) -> dict[str, int]:
        return {}

    def abandon_decision(self) -> None:
        pass

    def act(self, request: dict, ctx: dict) -> str:
        menus = build_menus(request, self._menu_names(request))
        if not menus:
            return ""
        automatic = all(len(menu) == 1 for menu in menus)
        choices = [0] * len(menus) if automatic else self.decide_joint(menus, request, ctx)
        try:
            parts = self._parts(menus, choices)
        except ValueError:
            choices, parts = self._defaults(menus)
            automatic = False
        self.action_committed(request, ctx, menus, choices, parts, automatic)
        if request.get("teamPreview"):
            return "team " + "".join(parts)
        return compose(parts)

    @abstractmethod
    def decide_joint(
        self,
        menus: list[SlotMenu],
        request: dict,
        ctx: dict,
    ) -> list[int]:
        raise NotImplementedError

    def action_committed(
        self,
        request: dict,
        ctx: dict,
        menus: list[SlotMenu],
        choices: list[int],
        parts: list[str],
        automatic: bool,
    ) -> None:
        pass

    def _menu_names(self, request: dict) -> dict | None:
        return None

    @classmethod
    def _parts(cls, menus: list[SlotMenu], choices: list[int]) -> list[str]:
        if len(choices) != len(menus):
            raise ValueError(f"choices must contain exactly {len(menus)} indices")
        parts: list[str] = []
        for slot, (menu, index) in enumerate(zip(menus, choices), 1):
            if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < len(menu):
                raise ValueError(f"choice for slot {slot} is outside its menu")
            item = menu[index]
            if item not in cls._remaining(menu, parts):
                raise ValueError(f"choice for slot {slot} conflicts with an earlier slot")
            parts.append(item["part"])
        cls._check_forced_passes(menus, parts)
        return parts

    @staticmethod
    def _check_forced_passes(menus: list[SlotMenu], parts: list[str]) -> None:
        forced = [index for index, menu in enumerate(menus) if any(item["kind"] == "switch" for item in menu)]
        if not forced or not any(parts[index] == "pass" for index in forced):
            return
        replacements = {item["part"] for index in forced for item in menus[index] if item["kind"] == "switch"}
        allowed = max(0, len(forced) - len(replacements))
        if sum(1 for index in forced if parts[index] == "pass") > allowed:
            raise ValueError("cannot pass a forced switch while a replacement remains")

    @classmethod
    def _defaults(cls, menus: list[SlotMenu]) -> tuple[list[int], list[str]]:
        choices: list[int] = []
        parts: list[str] = []
        for menu in menus:
            remaining = cls._remaining(menu, parts)
            if not remaining:
                parts.append("pass")
                choices.append(-1)
                continue
            item = remaining[0]
            choices.append(menu.index(item))
            parts.append(item["part"])
        return choices, parts

    @staticmethod
    def _remaining(menu: SlotMenu, chosen_parts: list[str]) -> SlotMenu:
        used_switches = {part for part in chosen_parts if part.startswith("switch ")}
        used_team = set(chosen_parts)
        mega_used = any(part.endswith(" mega") for part in chosen_parts)
        return [
            item
            for item in menu
            if not (item["kind"] == "switch" and item["part"] in used_switches)
            and not (item["kind"] == "team" and item["part"] in used_team)
            and not (mega_used and item["part"].endswith(" mega"))
        ]


class RandomEngine(BaseEngine):
    def __init__(self, pid: str, seed=None):
        super().__init__(pid)
        self.rng = random.Random(seed)

    def decide_joint(self, menus: list[SlotMenu], request: dict, ctx: dict) -> list[int]:
        choices: list[int] = []
        parts: list[str] = []
        for menu in menus:
            candidates = self._remaining(menu, parts)
            if not candidates:
                choices.append(-1)
                parts.append("pass")
                continue
            weights = [0.25 if item["part"].endswith(" mega") else 1.0 for item in candidates]
            item = self.rng.choices(candidates, weights=weights, k=1)[0]
            choices.append(menu.index(item))
            parts.append(item["part"])
        return choices


class LLMEngine(BaseEngine):
    NOTE_LIMIT = 2400

    def __init__(
        self,
        pid: str,
        spec: str,
        provider=None,
        decision_log=None,
        format_id: str = "gen9championsvgc2026regmbbo3",
        ps_dir=None,
        node=None,
        reference: ShowdownReference | None = None,
    ):
        super().__init__(pid)
        self.spec = spec
        if provider is None:
            from .providers import make_provider, parse_spec

            provider = make_provider(parse_spec(spec))
        self.provider = provider
        self.decision_log = Path(decision_log) if isinstance(decision_log, (str, Path)) else decision_log
        self.game_id = spec
        self.series_id: str | None = None
        self.game_number = 1
        self.series_score: dict[str, int] = {}
        self.format_id = format_id
        self.reference = reference or ShowdownReference(format_id, ps_dir=ps_dir, node=node)
        self.state = self._new_state()
        self.transcript: list[dict[str, str]] = []
        self.notebook = ""
        self.decision_count = 0
        self.fallback_count = 0
        self._pending: dict = {}
        self._lock = threading.Lock()
        self._generation = 0

    def begin_game(
        self,
        *,
        game_id: str,
        game_number: int,
        series_id: str,
        series_score: dict[str, int] | None = None,
        **_: Any,
    ) -> None:
        with self._lock:
            self.game_id = game_id
            self.game_number = game_number
            self.series_id = series_id
            self.series_score = dict(series_score or {})
            self.state = self._new_state()
            self._pending = {}
            self._compact_transcript()
            self._remember(f"[Game {game_number} begins; series score {self._score_text()}]")

    def end_game(
        self,
        *,
        outcome: dict,
        game_number: int,
        series_score: dict[str, int] | None = None,
        **_: Any,
    ) -> None:
        with self._lock:
            self.series_score = dict(series_score or self.series_score)
            winner = outcome.get("winner") or "tie"
            self._remember(f"[Game {game_number} ended; winner {winner}; series score {self._score_text()}]")
            self._compact_transcript()

    def observe(self, pov_lines: list[str]) -> None:
        lines = [line for line in pov_lines or [] if isinstance(line, str)]
        if not lines:
            return
        with self._lock:
            self.state.feed(lines)
            self._remember(
                "Observed after the final decision:\n" + "\n".join(lines),
                brief="Observed after the final decision: (events elided)",
            )
            self._compact_transcript()

    def abandon_decision(self) -> None:
        with self._lock:
            self._generation += 1
            self._pending = {}

    def _remember(self, full: str, brief: str | None = None) -> None:
        self.transcript.append({"full": full, "brief": brief if brief is not None else full})

    def _transcript_lines(self) -> list[str]:
        return [entry["brief"] for entry in self.transcript]

    def _compact_transcript(self) -> None:
        for entry in self.transcript:
            entry["full"] = entry["brief"]

    def act(self, request: dict, ctx: dict) -> str:
        lines = [line for line in ctx.get("pov_lines", []) if isinstance(line, str)]
        with self._lock:
            generation = self._generation
            self.state.feed(lines)
            self._pending = {
                "events": lines,
                "raw_response": "",
                "notes": self.notebook,
                "generation": generation,
            }
        choice = super().act(request, ctx)
        with self._lock:
            if generation != self._generation:
                return ""
        return choice

    def decide_joint(self, menus: list[SlotMenu], request: dict, ctx: dict) -> list[int]:
        started = time.perf_counter()
        timer = request.get("timer") or {}
        turn_seconds = timer.get("turnSeconds")
        deadline = started + float(turn_seconds) if isinstance(turn_seconds, (int, float)) else None
        with self._lock:
            generation = self._generation
            state_block = self.state.render(request)
            slot_names = [self.state.slot_name(slot, request) for slot in range(len(menus))]
            notebook = self.notebook
            transcript = self._transcript_lines()
            series_context = f"Series {self.series_id or '?'}; game {self.game_number}; score {self._score_text()}"
        prompt = render_decision(
            state_block,
            slot_names,
            menus,
            transcript=transcript,
            notebook=notebook,
            series_context=series_context,
        )
        if turn_seconds is not None:
            prompt += (
                f"\n\nShowdown timer: {turn_seconds:g} seconds for this decision; "
                f"{timer.get('seconds', turn_seconds):g} seconds remain in your clock bank."
            )
        if ctx.get("error"):
            prompt += f"\n\nThe simulator rejected the previous joint action: {ctx['error']}"
        raw_response = ""
        usage: dict[str, int] = {}
        parsed: tuple[list[int], str] | None = None
        error = "no choices found"
        parse_failures = 0
        tool_calls = 0
        max_rounds = 6
        messages: list[dict] = [{"role": "user", "content": prompt}]
        while parsed is None and parse_failures < 2:
            if generation != self._generation:
                return [0] * len(menus)
            if parse_failures:
                messages.append({"role": "assistant", "content": raw_response})
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            f"Your previous response was invalid. Error: {error}. "
                            "Reply again following the required JSON format."
                        ),
                    }
                )
            raw_response = ""
            for round_index in range(max_rounds):
                if generation != self._generation:
                    return [0] * len(menus)
                final_round = round_index == max_rounds - 1
                kwargs = {
                    "max_tokens": 8192,
                    "temperature": 0.6,
                    "tools": DEX_TOOLS,
                    "tool_choice": "none" if final_round else "auto",
                }
                if deadline is not None:
                    kwargs["timeout"] = max(0.1, deadline - time.perf_counter() + 1.0)
                completion = self.provider.complete(SYSTEM, messages, **kwargs)
                self._add_usage(usage, completion.usage)
                if completion.tool_calls and not final_round:
                    tool_calls += len(completion.tool_calls)
                    assistant = assistant_tool_message(completion)
                    messages.append(assistant)
                    for call, tool_call in zip(completion.tool_calls, assistant["tool_calls"]):
                        messages.append(
                            tool_result_message(
                                tool_call["id"],
                                self.reference.lookup(call.name, call.arguments),
                            )
                        )
                    continue
                raw_response = completion.text or ""
                break
            if not raw_response:
                error = "empty response"
                break
            try:
                choices, notes = self._extract_choices(raw_response, menus)
                self._parts(menus, choices)
                parsed = choices, notes
            except ValueError as exc:
                error = str(exc)
                parse_failures += 1
        fallback = parsed is None
        if fallback:
            choices, _ = self._defaults(menus)
            notes = None
        else:
            choices, notes = parsed
        with self._lock:
            if generation != self._generation:
                return choices
            pending_notes = self.notebook if notes is None else notes
            self._pending.update(
                {
                    "raw_response": raw_response,
                    "notes": pending_notes,
                    "usage": usage,
                    "fallback": fallback,
                    "error": error if fallback else None,
                    "latency_ms": (time.perf_counter() - started) * 1000,
                    "tool_calls": tool_calls,
                    "generation": generation,
                }
            )
        return choices

    def action_committed(
        self,
        request: dict,
        ctx: dict,
        menus: list[SlotMenu],
        choices: list[int],
        parts: list[str],
        automatic: bool,
    ) -> None:
        with self._lock:
            pending = self._pending
            if not pending or pending.get("generation") != self._generation:
                self._pending = {}
                return
            self._pending = {}
            notes = pending.get("notes", self.notebook)
            if not automatic:
                self.notebook = notes
                self.decision_count += 1
                self.fallback_count += int(pending.get("fallback", False))
            events = pending.get("events", [])
            entry = []
            if events:
                entry.append("Events from your point of view:\n" + "\n".join(events))
            entry.append("Chosen joint action: " + compose(parts))
            if automatic:
                entry.append("(automatic; no model call required)")
            self._remember("\n".join(entry), brief="\n".join(entry[1:] if events else entry))
            self._compact_transcript()
            if automatic:
                return
            row = {
                "game_id": self.game_id,
                "series_id": self.series_id,
                "game_number": self.game_number,
                "turn": self.state.turn,
                "pid": self.pid,
                "menus": [[item["label"] for item in menu] for menu in menus],
                "choices": choices,
                "parts": parts,
                "notes": notes,
                "fallback": pending.get("fallback", False),
                "error": pending.get("error"),
                "raw_response": pending.get("raw_response", ""),
                "usage": pending.get("usage", {}),
                "latency_ms": pending.get("latency_ms", 0.0),
                "tool_calls": pending.get("tool_calls", 0),
            }
        self._write_decision(row)

    def decision_stats(self) -> dict[str, int]:
        return {"decisions": self.decision_count, "fallbacks": self.fallback_count}

    def _menu_names(self, request: dict) -> dict | None:
        if request.get("teamPreview") or "active" not in request:
            return None
        names: dict[str, dict[int, str]] = {"foe": {}, "ally": {}}
        foe = "p2" if self.pid == "p1" else "p1"
        for group, pid in (("ally", self.pid), ("foe", foe)):
            side = self.state.sides[pid]
            for number, slot in ((1, "a"), (2, "b")):
                mon = side.mons.get(side.active.get(slot) or "")
                if mon and not mon.fainted:
                    names[group][number] = mon.species
        if not names["ally"]:
            actives = [mon for mon in request.get("side", {}).get("pokemon", []) if mon.get("active")]
            for number, mon in enumerate(actives, 1):
                names["ally"][number] = self.state._request_name(mon)
        return names

    def _new_state(self) -> BattleState:
        return BattleState(self.pid, self.format_id)

    def _score_text(self) -> str:
        return f"p1 {self.series_score.get('p1', 0)}, p2 {self.series_score.get('p2', 0)}"

    @classmethod
    def _extract_choices(cls, text: str, menus: list[SlotMenu]) -> tuple[list[int], str]:
        objects = []
        decoder = json.JSONDecoder()
        index = 0
        while True:
            match = re.search(r"\{", text[index:])
            if match is None:
                break
            start = index + match.start()
            try:
                obj, consumed = decoder.raw_decode(text[start:])
            except json.JSONDecodeError:
                index = start + 1
                continue
            if isinstance(obj, dict) and ("choices" in obj or "choice" in obj):
                objects.append(obj)
            index = start + consumed
        if not objects:
            raise ValueError("no JSON object with a choices key")
        obj = objects[-1]
        choices = obj.get("choices")
        if choices is None and len(menus) == 1:
            choices = [obj.get("choice")]
        if not isinstance(choices, list) or len(choices) != len(menus):
            raise ValueError(f"choices must be an array of exactly {len(menus)} integers")
        for slot, (choice, menu) in enumerate(zip(choices, menus), 1):
            if not isinstance(choice, int) or isinstance(choice, bool):
                raise ValueError(f"choice for slot {slot} must be an integer")
            if not 0 <= choice < len(menu):
                raise ValueError(f"choice for slot {slot} must be between 0 and {len(menu) - 1}")
        raw_notes = obj.get("notes", "")
        if isinstance(raw_notes, str):
            notes = raw_notes
        elif raw_notes is None:
            notes = ""
        else:
            notes = json.dumps(raw_notes, ensure_ascii=False, separators=(",", ":"))
        return list(choices), notes[: cls.NOTE_LIMIT]

    @staticmethod
    def _add_usage(total: dict[str, int], usage: Any) -> None:
        if not isinstance(usage, dict):
            return
        for key, value in usage.items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                total[key] = total.get(key, 0) + int(value)

    def _write_decision(self, row: dict) -> None:
        if self.decision_log is None:
            return
        if callable(self.decision_log):
            self.decision_log(row)
            return
        if isinstance(self.decision_log, list):
            self.decision_log.append(row)
            return
        path = self.decision_log
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, separators=(",", ":")) + "\n")
