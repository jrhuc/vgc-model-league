from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

_PLAYERS = tuple(f"seat{index}" for index in range(1, 9))
_SEATS = tuple(f"seat-{index}" for index in range(1, 9))
_SEAT_TO_ROLE = dict(zip(_SEATS, _PLAYERS))
_ROLE_TO_SEAT = dict(zip(_PLAYERS, _SEATS))
_ROLES = (*_PLAYERS, "referee")
_TURN_KINDS = {
    "draft",
    "construction",
    "action",
    "notebook",
    "trade_offer",
    "trade_response",
    "free_agency",
}
_PHASES = {"draft", "construction", "tournament", "trade", "terminal"}
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class _PendingTurn:
    turn_id: str
    seat_id: str
    kind: str
    prompt: str
    attempt: int
    wire: dict[str, Any]
