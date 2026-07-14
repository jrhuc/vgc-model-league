from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Iterable


REPO_ROOT = Path(__file__).resolve().parents[1]

def _tool(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {
        "name": name,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": False,
        },
    }


DEX_TOOLS = [
    _tool(
        "lookup_species",
        "Look up a species: typing, base Speed, forme, mega stone outcomes, and optional level/nature Speed range.",
        {
            "name": {"type": "string"},
            "item": {"type": ["string", "null"]},
            "nature": {"type": ["string", "null"]},
            "level": {"type": ["integer", "null"]},
        },
        ["name", "item", "nature", "level"],
    ),
    _tool(
        "lookup_move",
        "Look up a move: type, category, power, accuracy, priority, target, and effect text.",
        {"name": {"type": "string"}},
        ["name"],
    ),
    _tool(
        "lookup_item",
        "Look up an item's effect text and mega-stone behaviour.",
        {"name": {"type": "string"}},
        ["name"],
    ),
    _tool(
        "lookup_ability",
        "Look up an ability's effect text.",
        {"name": {"type": "string"}},
        ["name"],
    ),
    _tool(
        "lookup_nature",
        "Look up a Showdown nature/stat alignment (+stat / -stat).",
        {"name": {"type": "string"}},
        ["name"],
    ),
]


_QUERY_SCRIPT = r"""
const path = require('node:path');
const psDir = process.argv[1];
const formatid = process.argv[2];
const {Dex} = require(path.join(psDir, 'dist', 'sim'));
Dex.includeModData();
const dex = Dex.forFormat(formatid);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const query = JSON.parse(input || '{}');
  const result = {species: {}, moves: {}, items: {}, abilities: {}, natures: {}};

  for (const name of query.species || []) {
    const species = dex.species.get(name);
    if (!species.exists) continue;
    const megaForms = (species.otherFormes || [])
      .map(forme => dex.species.get(forme))
      .filter(forme => forme.exists && /^Mega(?:-|$)/.test(forme.forme || ''))
      .map(forme => ({
        name: forme.name,
        types: forme.types,
        speed: forme.baseStats.spe,
        requiredItem: forme.requiredItem || '',
      }));
    result.species[name] = {
      id: species.id,
      name: species.name,
      types: species.types,
      speed: species.baseStats.spe,
      baseSpecies: species.baseSpecies,
      forme: species.forme || '',
      megaForms,
    };
  }

  for (const name of query.moves || []) {
    const move = dex.moves.get(name);
    if (!move.exists) continue;
    result.moves[name] = {
      id: move.id,
      name: move.name,
      type: move.type,
      category: move.category,
      power: move.basePower,
      accuracy: move.accuracy,
      priority: move.priority,
      target: move.target,
      description: move.shortDesc || move.desc || '',
    };
  }

  for (const name of query.items || []) {
    const item = dex.items.get(name);
    if (!item.exists) continue;
    result.items[name] = {
      id: item.id,
      name: item.name,
      description: item.shortDesc || item.desc || '',
      megaStone: item.megaStone || null,
    };
  }

  for (const name of query.abilities || []) {
    const ability = dex.abilities.get(name);
    if (!ability.exists) continue;
    result.abilities[name] = {
      id: ability.id,
      name: ability.name,
      description: ability.shortDesc || ability.desc || '',
    };
  }

  for (const name of query.natures || []) {
    const nature = dex.natures.get(name);
    if (!nature.exists) continue;
    result.natures[name] = {
      id: nature.id,
      name: nature.name,
      plus: nature.plus || '',
      minus: nature.minus || '',
    };
  }

  process.stdout.write(JSON.stringify(result));
});
"""


def _id(value: str) -> str:
    return "".join(character for character in value.lower() if character.isalnum())


def _clean_description(value: object) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())


def _unique_names(values: Iterable[str]) -> list[str]:
    by_id: dict[str, str] = {}
    for value in values:
        if not isinstance(value, str) or not value.strip():
            continue
        clean = value.strip()
        by_id.setdefault(_id(clean), clean)
    return sorted(by_id.values(), key=_id)


def _speed_range(base: int, level: int, nature: dict | None) -> tuple[int, int]:
    def stat(iv: int, ev: int, modifier: float) -> int:
        raw = math.floor(((2 * base + iv + ev // 4) * level) / 100) + 5
        return math.floor(raw * modifier)

    if nature is None:
        return stat(0, 0, 0.9), stat(31, 252, 1.1)
    modifier = 1.1 if nature.get("plus") == "spe" else 0.9 if nature.get("minus") == "spe" else 1.0
    return stat(0, 0, modifier), stat(31, 252, modifier)


class ShowdownReference:
    """Small, lazy view of the exact Showdown Dex used by the simulator.

    Data is queried in batches from the configured local checkout and cached for
    the lifetime of a battle. The entire Dex is intentionally never copied into
    a prompt.
    """

    def __init__(
        self,
        format_id: str,
        ps_dir: str | Path | None = None,
        node: str | Path | None = None,
    ):
        self.format_id = format_id
        self.ps_dir = (
            Path(ps_dir).expanduser()
            if ps_dir
            else Path(os.environ.get("VGCBENCH_PS", REPO_ROOT / "pokemon-showdown")).expanduser()
        )
        configured_node = os.environ.get("VGCBENCH_NODE")
        self.node = str(
            Path(node or configured_node).expanduser()
            if node or configured_node
            else shutil.which("node") or Path("~/.local/bin/node").expanduser()
        )
        self._data: dict[str, dict[str, dict]] = {
            "species": {},
            "moves": {},
            "items": {},
            "abilities": {},
            "natures": {},
        }
        self._missing: dict[str, set[str]] = {kind: set() for kind in self._data}
        self._revision: str | None = None
        self._lock = threading.RLock()

    @property
    def revision(self) -> str:
        with self._lock:
            if self._revision is not None:
                return self._revision
            try:
                completed = subprocess.run(
                    ["git", "-C", str(self.ps_dir), "rev-parse", "--short=12", "HEAD"],
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                self._revision = completed.stdout.strip() or "unknown"
            except (OSError, subprocess.SubprocessError):
                self._revision = "unknown"
            return self._revision

    def prefetch(
        self,
        *,
        species: Iterable[str] = (),
        moves: Iterable[str] = (),
        items: Iterable[str] = (),
        abilities: Iterable[str] = (),
        natures: Iterable[str] = (),
    ) -> None:
        with self._lock:
            requested = {
                "species": species,
                "moves": moves,
                "items": items,
                "abilities": abilities,
                "natures": natures,
            }
            pending: dict[str, list[str]] = {}
            for kind, names in requested.items():
                pending[kind] = [
                    name
                    for name in _unique_names(names)
                    if _id(name) not in self._data[kind] and _id(name) not in self._missing[kind]
                ]
            if not any(pending.values()):
                return

            try:
                completed = subprocess.run(
                    [self.node, "-e", _QUERY_SCRIPT, str(self.ps_dir), self.format_id],
                    input=json.dumps(pending, separators=(",", ":")),
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=15,
                )
                result = json.loads(completed.stdout)
            except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
                detail = ""
                if isinstance(exc, subprocess.CalledProcessError):
                    detail = (exc.stderr or exc.stdout or "").strip()
                suffix = f": {detail[-2000:]}" if detail else ""
                raise RuntimeError(
                    f"could not query Showdown reference data for {self.format_id} "
                    f"from {self.ps_dir}{suffix}"
                ) from exc

            for kind, names in pending.items():
                returned = result.get(kind, {})
                if not isinstance(returned, dict):
                    returned = {}
                for name in names:
                    entry = returned.get(name)
                    if not isinstance(entry, dict):
                        self._missing[kind].add(_id(name))
                        continue
                    self._data[kind][_id(name)] = entry
                    if entry.get("id"):
                        self._data[kind][_id(str(entry["id"]))] = entry
                    if entry.get("name"):
                        self._data[kind][_id(str(entry["name"]))] = entry

    def get(self, kind: str, name: str | None) -> dict | None:
        with self._lock:
            if kind not in self._data or not name:
                return None
            return self._data[kind].get(_id(name))

    def render(
        self,
        *,
        species_items: Iterable[tuple[str, str | None]] = (),
        species_sets: Iterable[tuple[str, str | None, str | None, int | None]] = (),
        moves: Iterable[str] = (),
        items: Iterable[str] = (),
        abilities: Iterable[str] = (),
        natures: Iterable[str] = (),
    ) -> list[str]:
        with self._lock:
            species_sets = [*species_sets, *((species, item, None, None) for species, item in species_items)]
            moves = _unique_names(moves)
            items = _unique_names([*items, *(item for _, item, _, _ in species_sets if item)])
            abilities = _unique_names(abilities)
            natures = _unique_names([*natures, *(nature for _, _, nature, _ in species_sets if nature)])
            self.prefetch(
                species=(species for species, _, _, _ in species_sets),
                moves=moves,
                items=items,
                abilities=abilities,
                natures=natures,
            )
            lines: list[str] = []
            species_groups: dict[str, tuple[dict, set[tuple[str | None, str | None, int | None]]]] = {}
            for species_name, item_name, nature_name, level in species_sets:
                species = self.get("species", species_name)
                if not species:
                    continue
                _, visible_sets = species_groups.setdefault(species["id"], (species, set()))
                visible_sets.add((item_name, nature_name, level))

            for species, visible_sets in sorted(
                species_groups.values(),
                key=lambda group: _id(group[0]["name"]),
            ):
                details = ["/".join(species["types"]), f"base Spe {species['speed']}"]
                if species.get("forme"):
                    details.append(f"forme {species['forme']}")
                for _, nature_name, level in sorted(visible_sets, key=lambda entry: tuple(str(value or "") for value in entry)):
                    if not level:
                        continue
                    nature = self.get("natures", nature_name)
                    low, high = _speed_range(species["speed"], level, nature)
                    detail = (
                        f"L{level} Speed {low}-{high} with {nature['name']} alignment (full legal IV/EV range)"
                        if nature
                        else f"L{level} Speed {low}-{high} (full legal IV/EV/nature range)"
                    )
                    if detail not in details:
                        details.append(detail)
                for item_name in sorted({item for item, _, _ in visible_sets if item}, key=_id):
                    item = self.get("items", item_name)
                    mega_stone = item.get("megaStone") if item else None
                    for mega in species.get("megaForms", []):
                        permitted = False
                        if isinstance(mega_stone, str):
                            permitted = _id(mega_stone) == _id(mega["name"])
                        elif isinstance(mega_stone, dict):
                            permitted = _id(str(mega_stone.get(species["name"], ""))) == _id(mega["name"])
                        if permitted:
                            speed_text = ""
                            ranges = []
                            for visible_item, nature_name, level in visible_sets:
                                if _id(visible_item or "") != _id(item_name) or not level:
                                    continue
                                nature = self.get("natures", nature_name)
                                low, high = _speed_range(mega["speed"], level, nature)
                                nature_text = f" with {nature['name']} alignment" if nature else ""
                                ranges.append(f"L{level} Speed {low}-{high}{nature_text}")
                            if ranges:
                                speed_text = "; " + ", ".join(sorted(set(ranges)))
                            details.append(
                                f"with {item['name']} -> {mega['name']} "
                                f"({'/'.join(mega['types'])}, base Spe {mega['speed']}{speed_text})"
                            )
                lines.append(f"- Species {species['name']}: " + "; ".join(details))

            for move_name in moves:
                move = self.get("moves", move_name)
                if not move:
                    continue
                accuracy = "always hits" if move["accuracy"] is True else f"acc {move['accuracy']}%"
                power = f"BP {move['power']}" if move["power"] else "BP —"
                priority = f"priority {move['priority']:+d}"
                details = [move["type"], move["category"], power, accuracy, priority, f"target {move['target']}"]
                description = _clean_description(move.get("description"))
                if description:
                    details.append(description)
                lines.append(f"- Move {move['name']}: " + "; ".join(details))

            for item_name in items:
                item = self.get("items", item_name)
                if not item:
                    continue
                description = _clean_description(item.get("description"))
                if description:
                    lines.append(f"- Item {item['name']}: {description}")

            for ability_name in abilities:
                ability = self.get("abilities", ability_name)
                if not ability:
                    continue
                description = _clean_description(ability.get("description"))
                if description:
                    lines.append(f"- Ability {ability['name']}: {description}")

            for nature_name in natures:
                nature = self.get("natures", nature_name)
                if not nature:
                    continue
                if nature["plus"] and nature["minus"]:
                    lines.append(
                        f"- Stat alignment {nature['name']} (Showdown Nature): "
                        f"+{nature['plus']}, -{nature['minus']}"
                    )
                else:
                    lines.append(f"- Stat alignment {nature['name']} (Showdown Nature): neutral")

            if not lines:
                return []
            return [f"Showdown reference ({self.format_id}, commit {self.revision}):", *lines]

    def lookup(self, name: str, arguments: dict | None = None) -> str:
        args = arguments or {}
        if name == "lookup_species":
            return self.lookup_species(
                str(args.get("name") or ""),
                item=args.get("item"),
                nature=args.get("nature"),
                level=args.get("level"),
            )
        if name == "lookup_move":
            return self.lookup_move(str(args.get("name") or ""))
        if name == "lookup_item":
            return self.lookup_item(str(args.get("name") or ""))
        if name == "lookup_ability":
            return self.lookup_ability(str(args.get("name") or ""))
        if name == "lookup_nature":
            return self.lookup_nature(str(args.get("name") or ""))
        return f"Unknown tool: {name}"

    def lookup_species(
        self,
        name: str,
        *,
        item: str | None = None,
        nature: str | None = None,
        level: int | None = None,
    ) -> str:
        if not isinstance(name, str) or not name.strip():
            return "Species name is required."
        level_value = 50 if level is None else level
        if not isinstance(level_value, int) or isinstance(level_value, bool):
            return "Level must be an integer."
        item_name = item if isinstance(item, str) and item.strip() else None
        nature_name = nature if isinstance(nature, str) and nature.strip() else None
        lines = self.render(species_sets=[(name, item_name, nature_name, level_value)])
        body = [line for line in lines[1:] if line.startswith("- Species ")]
        return "\n".join(body) if body else f"No species data for {name!r} in {self.format_id}."

    def lookup_move(self, name: str) -> str:
        if not isinstance(name, str) or not name.strip():
            return "Move name is required."
        lines = self.render(moves=[name])
        body = [line for line in lines[1:] if line.startswith("- Move ")]
        return "\n".join(body) if body else f"No move data for {name!r} in {self.format_id}."

    def lookup_item(self, name: str) -> str:
        if not isinstance(name, str) or not name.strip():
            return "Item name is required."
        lines = self.render(items=[name])
        body = [line for line in lines[1:] if line.startswith("- Item ")]
        return "\n".join(body) if body else f"No item data for {name!r} in {self.format_id}."

    def lookup_ability(self, name: str) -> str:
        if not isinstance(name, str) or not name.strip():
            return "Ability name is required."
        lines = self.render(abilities=[name])
        body = [line for line in lines[1:] if line.startswith("- Ability ")]
        return "\n".join(body) if body else f"No ability data for {name!r} in {self.format_id}."

    def lookup_nature(self, name: str) -> str:
        if not isinstance(name, str) or not name.strip():
            return "Nature name is required."
        lines = self.render(natures=[name])
        body = [line for line in lines[1:] if line.startswith("- Stat alignment ")]
        return "\n".join(body) if body else f"No nature data for {name!r} in {self.format_id}."
