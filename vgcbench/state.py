from __future__ import annotations

from dataclasses import dataclass, field

@dataclass
class MonState:
    ident: str
    species: str = "Pokémon"
    level: int | None = None
    hp: str | None = None
    hp_percent: float | None = None
    status: str | None = None
    stats: dict[str, int] = field(default_factory=dict)
    boosts: dict[str, int] = field(default_factory=dict)
    moves: dict[str, dict] = field(default_factory=dict)

    def record_move(self, name: str, used: int = 0) -> None:
        key = "".join(character for character in name.lower() if character.isalnum())
        entry = self.moves.setdefault(key, {"name": name, "used": 0})
        if " " in name:
            entry["name"] = name
        entry["used"] += used
    item: str | None = None
    item_consumed: bool = False
    ability: str | None = None
    nature: str | None = None
    mega: bool = False
    fainted: bool = False
    preview: bool = False


@dataclass
class SideState:
    mons: dict[str, MonState] = field(default_factory=dict)
    active: dict[str, str] = field(default_factory=dict)
    conditions: set[str] = field(default_factory=set)
    sheet: list[MonState] = field(default_factory=list)
    showteam: bool = False


class BattleState:
    def __init__(self, pid: str, format_id: str = ""):
        self.pid = pid
        self.turn = 0
        self.weather: str | None = None
        self.fields: set[str] = set()
        self.sides = {"p1": SideState(), "p2": SideState()}

    def feed(self, pov_lines) -> None:
        for raw in pov_lines or []:
            if not isinstance(raw, str):
                continue
            if raw.startswith(("|uhtml|", "|uhtmlchange|", "|html|", "|raw|")):
                continue
            self._feed_line(raw)

    def _feed_line(self, line: str) -> None:
        if not line.startswith("|"):
            return
        parts = line.split("|")
        kind = parts[1]
        args = parts[2:]
        if kind == "turn" and args:
            self.turn = int(args[0])
        elif kind in {"switch", "drag", "replace"} and len(args) >= 3:
            mon = self._mon(args[0])
            self._set_details(mon, args[1])
            self._set_hp(mon, args[2])
            side, slot = self._ident_parts(args[0])
            if side:
                self._merge_sheet_mon(mon, self.sides[side])
                previous = self.sides[side].active.get(slot)
                if previous and previous in self.sides[side].mons:
                    self.sides[side].mons[previous].boosts.clear()
                if kind != "replace":
                    mon.boosts.clear()
                self.sides[side].active[slot] = self._mon_key(args[0])
        elif kind == "detailschange" and len(args) >= 2:
            self._set_details(self._mon(args[0]), args[1])
        elif kind == "poke" and len(args) >= 2 and args[0] in self.sides:
            species = args[1].split(",", 1)[0].strip()
            mon = self._mon(f"{args[0]}: {species}")
            self._set_details(mon, args[1])
            mon.preview = True
        elif kind == "move" and len(args) >= 2:
            self._mon(args[0]).record_move(args[1], used=1)
        elif kind == "faint" and args:
            mon = self._mon(args[0])
            mon.hp = "0 fnt"
            mon.hp_percent = 0.0
            mon.fainted = True
            mon.boosts.clear()
        elif kind in {"-damage", "-heal"} and len(args) >= 2:
            self._set_hp(self._mon(args[0]), args[1])
        elif kind == "-sethp":
            for index in range(0, len(args) - 1, 2):
                if args[index].startswith("p"):
                    self._set_hp(self._mon(args[index]), args[index + 1])
        elif kind == "-status" and len(args) >= 2:
            self._mon(args[0]).status = args[1]
        elif kind == "-curestatus" and args:
            self._mon(args[0]).status = None
        elif kind in {"-boost", "-unboost", "-setboost"} and len(args) >= 3:
            mon = self._mon(args[0])
            amount = int(args[2])
            if kind == "-boost":
                mon.boosts[args[1]] = mon.boosts.get(args[1], 0) + amount
            elif kind == "-unboost":
                mon.boosts[args[1]] = mon.boosts.get(args[1], 0) - amount
            else:
                mon.boosts[args[1]] = amount
        elif kind == "-clearboost" and args:
            self._mon(args[0]).boosts.clear()
        elif kind == "-clearallboost":
            for side in self.sides.values():
                for mon in side.mons.values():
                    mon.boosts.clear()
        elif kind == "-clearnegativeboost" and args:
            mon = self._mon(args[0])
            mon.boosts = {stat: value for stat, value in mon.boosts.items() if value > 0}
        elif kind == "-weather" and args:
            self.weather = None if args[0] in {"none", ""} else self._effect(args[0])
        elif kind == "-fieldstart" and args:
            self.fields.add(self._effect(args[0]))
        elif kind == "-fieldend" and args:
            self.fields.discard(self._effect(args[0]))
        elif kind in {"-sidestart", "-sideend"} and len(args) >= 2:
            side = args[0].split(":", 1)[0]
            if side in self.sides:
                effect = self._effect(args[1])
                if kind == "-sidestart":
                    self.sides[side].conditions.add(effect)
                else:
                    self.sides[side].conditions.discard(effect)
        elif kind == "-item" and len(args) >= 2:
            mon = self._mon(args[0])
            mon.item = args[1]
            mon.item_consumed = False
        elif kind == "-enditem" and args:
            mon = self._mon(args[0])
            if len(args) >= 2:
                mon.item = args[1]
            mon.item_consumed = True
        elif kind == "-ability" and len(args) >= 2:
            self._mon(args[0]).ability = args[1]
        elif kind == "-mega" and args:
            # The second protocol argument is the publicly apparent base
            # species, not the evolved forme. ``detailschange`` supplies the
            # actual Mega forme immediately before this event.
            self._mon(args[0]).mega = True
        elif kind == "-formechange" and len(args) >= 2:
            self._mon(args[0]).species = args[1]
        elif kind == "showteam" and len(args) >= 2:
            self._showteam(args[0], "|".join(args[1:]))

    def render(self, request: dict) -> str:
        self._update_own_request(request)
        lines = [f"Turn: {self.turn}"]
        lines.append(f"Weather: {self.weather or 'none'}")
        lines.append("Field: " + (", ".join(sorted(self.fields)) if self.fields else "none"))
        lines.extend(self._render_side(self.pid, own=True))
        foe = "p2" if self.pid == "p1" else "p1"
        lines.extend(self._render_side(foe, own=False))
        return "\n".join(lines)

    def slot_name(self, slot_i: int, request: dict) -> str:
        if request.get("teamPreview"):
            return f"team preview pick {slot_i + 1}"
        key = self.sides[self.pid].active.get(chr(ord("a") + slot_i))
        mon = self.sides[self.pid].mons.get(key or "")
        if mon:
            return mon.species
        active = [mon for mon in request.get("side", {}).get("pokemon", []) if mon.get("active")]
        if slot_i < len(active):
            return self._request_name(active[slot_i])
        return "Pokémon"

    def _render_side(self, pid: str, own: bool) -> list[str]:
        side = self.sides[pid]
        title = "Your side" if own else "Opponent side"
        conditions = ", ".join(sorted(side.conditions)) if side.conditions else "none"
        lines = [f"{title} conditions: {conditions}"]
        mons = list(side.mons.values())
        rich = {
            self._species_key(mon.species)
            for mon in mons
            if mon.hp is not None or mon.moves or mon.item or mon.ability
        }
        mons = [
            mon
            for mon in mons
            if not (mon.preview and mon.hp is None and self._species_key(mon.species) in rich)
        ]
        if not own and side.showteam:
            known = {self._species_key(mon.species) for mon in mons}
            mons.extend(mon for mon in side.sheet if self._species_key(mon.species) not in known)
        for mon in mons:
            if (
                not own
                and not side.showteam
                and not mon.preview
                and mon.hp is None
                and not mon.moves
                and not mon.item
                and not mon.ability
            ):
                continue
            attrs = [mon.species]
            active_slots = [slot for slot, key in side.active.items() if key == self._mon_key(mon.ident)]
            if active_slots:
                attrs.append("active slot " + "/".join(active_slots))
            if mon.level is not None:
                attrs.append(f"L{mon.level}")
            attrs.append(f"HP {mon.hp or '?'}")
            if mon.status:
                attrs.append(mon.status)
            if mon.fainted:
                attrs.append("fainted")
            if mon.boosts:
                attrs.append("boosts " + ", ".join(f"{k} {v:+d}" for k, v in sorted(mon.boosts.items()) if v))
            if mon.moves:
                attrs.append(
                    "moves "
                    + ", ".join(self._render_move(entry) for entry in mon.moves.values())
                )
            if own and mon.stats:
                attrs.append("stats " + ", ".join(f"{stat} {value}" for stat, value in mon.stats.items()))
            if mon.item:
                attrs.append(f"item {mon.item}" + (" (consumed)" if mon.item_consumed else ""))
            if mon.ability:
                attrs.append(f"ability {mon.ability}")
            if mon.nature:
                attrs.append(f"stat alignment {mon.nature}")
            if mon.mega:
                attrs.append("Mega Evolved")
            lines.append("- " + "; ".join(part for part in attrs if part))
        if len(lines) == 1:
            lines.append("- no Pokémon revealed")
        return lines

    def _update_own_request(self, request: dict) -> None:
        active_index = 0
        for pokemon in request.get("side", {}).get("pokemon", []):
            ident = pokemon.get("ident")
            if not ident:
                continue
            mon = self._mon(ident)
            self._set_details(mon, pokemon.get("details", ""))
            condition = pokemon.get("condition", "")
            self._set_hp(mon, condition)
            condition_parts = condition.split()
            mon.status = condition_parts[1] if len(condition_parts) > 1 and condition_parts[1] != "fnt" else None
            mon.item = pokemon.get("item") or mon.item
            mon.ability = pokemon.get("ability") or pokemon.get("baseAbility") or mon.ability
            stats = pokemon.get("stats")
            if isinstance(stats, dict):
                mon.stats = {
                    str(stat): int(value)
                    for stat, value in stats.items()
                    if isinstance(value, int) and not isinstance(value, bool)
                }
            for move in pokemon.get("moves", []):
                if isinstance(move, str) and move:
                    mon.record_move(move)
            if pokemon.get("active"):
                active_requests = request.get("active", [])
                active = active_requests[active_index] if active_index < len(active_requests) else None
                active_index += 1
                if isinstance(active, dict):
                    for move in active.get("moves", []):
                        name = move.get("move") or move.get("id")
                        if not isinstance(name, str) or not name:
                            continue
                        mon.record_move(name)
                        key = "".join(character for character in name.lower() if character.isalnum())
                        entry = mon.moves[key]
                        if isinstance(move.get("pp"), int):
                            entry["pp"] = move["pp"]
                        if isinstance(move.get("maxpp"), int):
                            entry["maxpp"] = move["maxpp"]

    def _mon(self, ident: str) -> MonState:
        side, _ = self._ident_parts(ident)
        side = side if side in self.sides else self.pid
        key = self._mon_key(ident)
        if key not in self.sides[side].mons:
            self.sides[side].mons[key] = MonState(ident=ident, species=self._nickname(ident))
        mon = self.sides[side].mons[key]
        mon.ident = ident
        return mon

    def _set_details(self, mon: MonState, details: str) -> None:
        if not details:
            return
        fields = [part.strip() for part in details.split(",")]
        mon.species = fields[0] or mon.species
        for field_value in fields[1:]:
            if field_value.startswith("L") and field_value[1:].isdigit():
                mon.level = int(field_value[1:])

    def _set_hp(self, mon: MonState, hp: str) -> None:
        if not hp:
            return
        mon.hp = hp
        first = hp.split()[0]
        if "/" in first:
            current, maximum = first.split("/", 1)
            if maximum and float(maximum):
                mon.hp_percent = 100.0 * float(current) / float(maximum)
        elif first == "0":
            mon.hp_percent = 0.0
        status = hp.split()[1] if len(hp.split()) > 1 else None
        mon.fainted = status == "fnt" or mon.hp_percent == 0
        if status and status != "fnt":
            mon.status = status

    def _showteam(self, pid: str, packed: str) -> None:
        if pid not in self.sides:
            return
        sheet = []
        for entry in packed.split("]"):
            if not entry:
                continue
            fields = entry.split("|")
            nickname = fields[0] if fields else "Pokémon"
            species = fields[1] if len(fields) > 1 and fields[1] else nickname
            mon = MonState(ident=f"{pid}: {nickname}", species=species or "Pokémon")
            if len(fields) > 2:
                mon.item = fields[2] or None
            if len(fields) > 3:
                mon.ability = fields[3] or None
            if len(fields) > 4 and fields[4]:
                for move in fields[4].split(","):
                    mon.record_move(move)
            if len(fields) > 5:
                mon.nature = fields[5] or None
            if len(fields) > 10 and fields[10].isdigit():
                mon.level = int(fields[10])
            sheet.append(mon)
        side = self.sides[pid]
        side.sheet = sheet
        side.showteam = True
        by_species = {self._species_key(mon.species): mon for mon in side.mons.values()}
        for sheet_mon in sheet:
            mon = by_species.get(self._species_key(sheet_mon.species))
            if mon is None:
                continue
            mon.item = mon.item or sheet_mon.item
            mon.ability = mon.ability or sheet_mon.ability
            mon.nature = mon.nature or sheet_mon.nature
            mon.level = mon.level or sheet_mon.level
            for entry in sheet_mon.moves.values():
                mon.record_move(entry["name"])

    @staticmethod
    def _merge_sheet_mon(mon: MonState, side: SideState) -> None:
        species_key = BattleState._species_key(mon.species)
        sheet_mon = next(
            (candidate for candidate in side.sheet if BattleState._species_key(candidate.species) == species_key),
            None,
        )
        if sheet_mon is None:
            return
        mon.item = mon.item or sheet_mon.item
        mon.ability = mon.ability or sheet_mon.ability
        mon.nature = mon.nature or sheet_mon.nature
        mon.level = mon.level or sheet_mon.level
        for entry in sheet_mon.moves.values():
            mon.record_move(entry["name"])

    @staticmethod
    def _render_move(entry: dict) -> str:
        details = []
        if "pp" in entry:
            details.append(f"PP {entry['pp']}/{entry.get('maxpp', '?')}")
        if entry.get("used"):
            details.append(f"used {entry['used']}")
        return entry["name"] + (f" ({'; '.join(details)})" if details else "")

    @staticmethod
    def _ident_parts(ident: str) -> tuple[str, str]:
        head = ident.split(":", 1)[0]
        return (head[:2], head[2:3] or "a") if head.startswith(("p1", "p2")) else ("", "a")

    @staticmethod
    def _mon_key(ident: str) -> str:
        side = ident[:2] if ident.startswith(("p1", "p2")) else ""
        return f"{side}:{BattleState._nickname(ident).lower()}"

    @staticmethod
    def _nickname(ident: str) -> str:
        return ident.split(": ", 1)[-1] or "Pokémon"

    @staticmethod
    def _request_name(pokemon: dict) -> str:
        return pokemon.get("ident", "").split(": ", 1)[-1] or pokemon.get("details", "Pokémon").split(",", 1)[0]

    @staticmethod
    def _species_key(species: str) -> str:
        return "".join(character for character in species.lower() if character.isalnum())

    @staticmethod
    def _effect(value: str) -> str:
        return value.split(": ", 1)[-1]
