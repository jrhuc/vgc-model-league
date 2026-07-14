import json

import pytest

from vgcbench.teams import load_pool


def test_default_pool_loads_teams_in_manifest_order():
    pool = load_pool()

    assert pool.id == "test"
    assert pool.format == "gen9championsvgc2026regmbbo3"
    assert [team.id for team in pool.teams] == [
        "boschmans-mega-pyroar",
        "cybertron-mega-staraptor",
        "endo-mega-sceptile",
        "jpnats-mega-swampert",
        "rios-mega-raichu-x-venusaur",
        "wolfe-mega-raichu-y",
    ]
    assert all(team.packed.count("]") == 5 for team in pool.teams)


def test_named_pool_uses_its_own_directory(tmp_path):
    pool_dir = tmp_path / "dated-snapshot"
    pool_dir.mkdir()
    (pool_dir / "a.team").write_text("alpha", encoding="utf-8")
    (pool_dir / "b.team").write_text("beta", encoding="utf-8")
    (pool_dir / "pool.json").write_text(
        json.dumps(
            {
                "id": "dated-snapshot",
                "format": "gen9championsvgc2026regmbbo3",
                "teams": [
                    {"id": "a", "file": "a.team"},
                    {"id": "b", "file": "b.team"},
                ],
            }
        ),
        encoding="utf-8",
    )

    pool = load_pool("dated-snapshot", teams_dir=tmp_path)

    assert pool.id == "dated-snapshot"
    assert [(team.id, team.packed) for team in pool.teams] == [("a", "alpha"), ("b", "beta")]


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"format": "gen9championsvgc2026regmb"}, "BO3 format"),
        ({"teams": [{"id": "a", "file": "a.team"}]}, "at least two teams"),
        (
            {
                "teams": [
                    {"id": "a", "file": "a.team"},
                    {"id": "a", "file": "b.team"},
                ]
            },
            "duplicate team id",
        ),
    ],
)
def test_invalid_pool_manifest_is_rejected(tmp_path, change, message):
    (tmp_path / "a.team").write_text("alpha", encoding="utf-8")
    (tmp_path / "b.team").write_text("beta", encoding="utf-8")
    manifest = {
        "id": "test",
        "format": "gen9championsvgc2026regmbbo3",
        "teams": [
            {"id": "a", "file": "a.team"},
            {"id": "b", "file": "b.team"},
        ],
    }
    manifest.update(change)
    (tmp_path / "pool.json").write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(ValueError, match=message):
        load_pool("", teams_dir=tmp_path)
