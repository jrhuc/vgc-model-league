from typing import Literal, TypedDict


class MenuItem(TypedDict):
    label: str
    part: str
    kind: Literal["move", "switch", "team", "pass"]


SlotMenu = list[MenuItem]

_TARGETS = {"normal", "any", "adjacentFoe"}
_SPREAD = {
    "allySide",
    "foeSide",
    "all",
    "allAdjacent",
    "allAdjacentFoes",
    "allies",
}


def _name(pokemon: dict) -> str:
    ident = pokemon.get("ident", "")
    return ident.split(": ", 1)[-1] or pokemon.get("details", "Pokémon").split(",", 1)[0]


def _switches(request: dict, reviving: bool = False) -> SlotMenu:
    menu: SlotMenu = []
    for index, pokemon in enumerate(request.get("side", {}).get("pokemon", []), 1):
        fainted = pokemon.get("condition", "").endswith(" fnt")
        if pokemon.get("active") or fainted != reviving:
            continue
        menu.append({"label": f"Switch to {_name(pokemon)}", "part": f"switch {index}", "kind": "switch"})
    return menu


def _target_label(side: str, number: int, names: dict | None) -> str:
    species = (names or {}).get(side, {}).get(number)
    return f" -> {side} {number}" + (f" ({species})" if species else "")


def _move_items(
    move: dict,
    slot: int,
    active_count: int,
    has_ally: bool,
    mega: bool,
    names: dict | None = None,
) -> SlotMenu:
    move_slot = move["slot"]
    name = move.get("move", f"Move {move_slot}")
    target = move.get("target")
    targets: list[tuple[str, str]] = [("", "")]
    if active_count > 1 and target in _TARGETS:
        targets = [(f" +{number}", _target_label("foe", number, names)) for number in (1, 2)]
        if target in {"normal", "any"} and has_ally:
            ally = 2 if slot == 1 else 1
            targets.append((f" -{ally}", _target_label("ally", ally, names)))
    elif active_count > 1 and target == "adjacentAlly":
        ally = 2 if slot == 1 else 1
        targets = [(f" -{ally}", _target_label("ally", ally, names))]
    elif active_count > 1 and target == "adjacentAllyOrSelf":
        targets = []
        for number in (1, 2):
            label = " -> itself" if number == slot else _target_label("ally", number, names)
            targets.append((f" -{number}", label))

    menu: SlotMenu = []
    spread = " (spread)" if target in _SPREAD else ""
    for target_part, target_label in targets:
        part = f"move {move_slot}{target_part}"
        label = f"{name}{spread}{target_label}"
        menu.append({"label": label, "part": part, "kind": "move"})
        if mega:
            menu.append({"label": f"{label} + Mega Evolve", "part": f"{part} mega", "kind": "move"})
    return menu


def build_menus(request: dict, names: dict | None = None) -> list[SlotMenu]:
    side = request.get("side", {})
    pokemon = side.get("pokemon", [])
    if request.get("wait"):
        return []
    if request.get("teamPreview"):
        count = request.get("maxChosenTeamSize") or len(pokemon)
        base = [
            {"label": f"Pick {_name(mon)}", "part": str(index), "kind": "team"}
            for index, mon in enumerate(pokemon, 1)
        ]
        return [[item.copy() for item in base] for _ in range(count)]
    if "forceSwitch" in request:
        menus: list[SlotMenu] = []
        active_pokemon = [mon for mon in pokemon if mon.get("active")]
        for slot, forced in enumerate(request["forceSwitch"]):
            if not forced:
                menus.append([{"label": "Pass", "part": "pass", "kind": "pass"}])
                continue
            current = active_pokemon[slot] if slot < len(active_pokemon) else {}
            menu = _switches(request, bool(current.get("reviving")))
            menus.append(menu or [{"label": "Pass", "part": "pass", "kind": "pass"}])
        forced = [index for index, value in enumerate(request["forceSwitch"]) if value]
        switch_targets = {item["part"] for menu in menus for item in menu if item["kind"] == "switch"}
        if len(switch_targets) < len(forced):
            for index in forced:
                if not any(item["kind"] == "pass" for item in menus[index]):
                    menus[index].append({"label": "Pass", "part": "pass", "kind": "pass"})
        return menus
    if "active" in request:
        menus = []
        active_pokemon = [mon for mon in pokemon if mon.get("active")]
        active_count = len(request["active"])
        for slot, active in enumerate(request["active"], 1):
            current = active_pokemon[slot - 1] if slot <= len(active_pokemon) else {}
            if active is None or current.get("commanding") or current.get("condition", "").endswith(" fnt"):
                menus.append([{"label": "Pass", "part": "pass", "kind": "pass"}])
                continue
            menu: SlotMenu = []
            enabled_moves = [move for move in active.get("moves", []) if not move.get("disabled")]
            for move_slot, move in enumerate(active.get("moves", []), 1):
                if move.get("disabled"):
                    continue
                menu.extend(
                    _move_items(
                        {**move, "slot": move_slot},
                        slot,
                        active_count,
                        active_count > 1 and request["active"][1 if slot == 1 else 0] is not None,
                        bool(active.get("canMegaEvo")),
                        names,
                    )
                )
            if not enabled_moves and active.get("moves"):
                menu.append({"label": "Struggle", "part": "move 1", "kind": "move"})
            if not active.get("trapped"):
                menu.extend(_switches(request))
            menus.append(menu or [{"label": "Pass", "part": "pass", "kind": "pass"}])
        return menus
    return [[{"label": "Pass", "part": "pass", "kind": "pass"}]]


def compose(parts: list[str]) -> str:
    return ", ".join(parts)
