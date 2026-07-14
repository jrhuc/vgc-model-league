import json
import re
from pathlib import Path

import pytest

from vgcbench.choices import build_menus
from vgcbench.engines import BaseEngine


REQUESTS = Path(__file__).parent / "data" / "showdown_requests"
TARGETED = {"normal", "any", "adjacentFoe", "adjacentAlly", "adjacentAllyOrSelf"}


def load(name):
    return json.loads((REQUESTS / name).read_text())


def test_wait_has_no_menus():
    assert build_menus({"wait": True}) == []


def test_team_preview_is_compositional():
    request = load("team_preview.json")
    menus = build_menus(request)
    assert len(menus) == 4
    assert all({item["kind"] for item in menu} == {"team"} for menu in menus)

    class LastEngine(BaseEngine):
        def decide_joint(self, menus, request, ctx):
            choices = []
            parts = []
            for menu in menus:
                item = self._remaining(menu, parts)[-1]
                choices.append(menu.index(item))
                parts.append(item["part"])
            return choices

    choice = LastEngine("p1").act(request, {"pov_lines": [], "error": None})
    assert choice == "team 6543"


def test_force_switch_menus():
    menus = build_menus(load("forced_switch.json"))
    assert all(menu for menu in menus)
    assert "switch" in {item["kind"] for menu in menus for item in menu}
    for menu in menus:
        assert {item["kind"] for item in menu} <= {"switch", "pass"}


def test_move_targets_follow_target_table():
    request = load("turn.json")
    menus = build_menus(request)
    assert "move" in {item["kind"] for menu in menus for item in menu}
    for active, menu in zip(request["active"], menus):
        if active is None:
            continue
        by_slot = {index: move.get("target") for index, move in enumerate(active["moves"], 1)}
        for item in menu:
            if item["kind"] != "move":
                continue
            match = re.match(r"move (\d+)(?: ([+-]\d))?", item["part"])
            assert match
            has_target = match.group(2) is not None
            assert has_target == (by_slot[int(match.group(1))] in TARGETED)


def test_null_and_commanding_slots_pass():
    request = load("turn.json")
    request["active"][0] = None
    assert build_menus(request)[0][0]["kind"] == "pass"
    request = load("turn.json")
    request["side"]["pokemon"][1]["commanding"] = True
    assert build_menus(request)[1] == [{"label": "Pass", "part": "pass", "kind": "pass"}]


@pytest.mark.parametrize("target", ["normal", "any"])
def test_normal_and_any_moves_can_target_an_ally(target):
    request = load("turn.json")
    request["active"][0]["moves"][0]["target"] = target
    parts = {item["part"] for item in build_menus(request)[0] if item["part"].startswith("move 1")}
    assert {"move 1 +1", "move 1 +2", "move 1 -2"} <= parts


def test_adjacent_foe_move_cannot_target_an_ally():
    request = load("turn.json")
    request["active"][0]["moves"][0]["target"] = "adjacentFoe"
    parts = {item["part"] for item in build_menus(request)[0] if item["part"].startswith("move 1")}
    assert parts == {"move 1 +1", "move 1 +2"}


def test_all_disabled_moves_offer_struggle_and_switches():
    request = load("turn.json")
    for move in request["active"][0]["moves"]:
        move["disabled"] = True
    menu = build_menus(request)[0]
    assert {item["part"] for item in menu if item["kind"] == "move"} == {"move 1"}
    assert any(item["kind"] == "switch" for item in menu)


def test_mega_variants_added():
    request = load("turn.json")
    request["active"][0]["canMegaEvo"] = True
    menus = build_menus(request)
    mega = [item for item in menus[0] if item["part"].endswith(" mega")]
    plain = [item for item in menus[0] if item["kind"] == "move" and not item["part"].endswith(" mega")]
    assert mega and len(mega) == len(plain)
    assert all(re.match(r"move \d+(?: [+-]\d)? mega$", item["part"]) for item in mega)
    assert not any(item["part"].endswith(" mega") for item in menus[1])


def test_only_one_slot_can_mega_evolve():
    request = load("turn.json")
    request["active"][0]["canMegaEvo"] = True
    request["active"][1]["canMegaEvo"] = True

    class MegaEngine(BaseEngine):
        def decide_joint(self, menus, request, ctx):
            choices = []
            parts = []
            for menu in menus:
                remaining = self._remaining(menu, parts)
                item = next((item for item in remaining if item["part"].endswith(" mega")), remaining[0])
                choices.append(menu.index(item))
                parts.append(item["part"])
            return choices

    choice = MegaEngine("p1").act(request, {"pov_lines": [], "error": None})
    assert choice.count(" mega") == 1
