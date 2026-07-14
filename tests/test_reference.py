from pathlib import Path

from vgcbench.reference import ShowdownReference


ROOT = Path(__file__).parents[1]
PS = ROOT.parent / "pokemon-showdown"
NODE = Path.home() / ".local/bin/node"


def test_reference_queries_exact_format_data_without_dumping_the_dex():
    reference = ShowdownReference(
        "gen9championsvgc2026regmb",
        ps_dir=PS,
        node=NODE,
    )
    rendered = "\n".join(
        reference.render(
            species_sets=[
                ("Gengar", "Gengarite", "Timid", 50),
                ("Garchomp", "Clear Amulet", "Jolly", 50),
            ],
            moves=["Shadow Ball", "shadowball", "Earthquake"],
            items=["Gengarite", "Clear Amulet"],
            abilities=["Cursed Body", "Rough Skin"],
            natures=["Timid"],
        )
    )

    assert "commit " in rendered
    assert "Species Gengar: Ghost/Poison; base Spe 110" in rendered
    assert "L50 Speed 126-178 with Timid alignment (full legal IV/EV range)" in rendered
    assert "Gengar-Mega (Ghost/Poison, base Spe 130; L50 Speed 148-200 with Timid alignment)" in rendered
    assert "Species Garchomp: Dragon/Ground; base Spe 102" in rendered
    assert "L50 Speed 117-169 with Jolly alignment (full legal IV/EV range)" in rendered
    assert "Move Shadow Ball: Ghost; Special; BP 80; acc 100%; priority +0; target normal" in rendered
    assert rendered.count("- Move Shadow Ball:") == 1
    assert "Move Earthquake: Ground; Physical; BP 100; acc 100%; priority +0; target allAdjacent" in rendered
    assert "Item Gengarite: If held by a Gengar" in rendered
    assert "Ability Rough Skin:" in rendered
    assert "Stat alignment Timid (Showdown Nature): +spe, -atk" in rendered
    assert "Pikachu" not in rendered


def test_mega_form_is_only_rendered_with_its_visible_stone():
    reference = ShowdownReference(
        "gen9championsvgc2026regmb",
        ps_dir=PS,
        node=NODE,
    )
    rendered = "\n".join(
        reference.render(
            species_items=[("Charizard", "Choice Specs")],
            items=["Choice Specs"],
        )
    )

    assert "Species Charizard: Fire/Flying; base Spe 100" in rendered
    assert "Charizard-Mega" not in rendered


def test_reference_failure_is_fatal_instead_of_silently_removing_mechanics(tmp_path):
    reference = ShowdownReference(
        "gen9championsvgc2026regmb",
        ps_dir=tmp_path / "missing-showdown",
        node=NODE,
    )

    import pytest

    with pytest.raises(RuntimeError, match="could not query Showdown reference data"):
        reference.render(species_items=[("Gengar", None)])
