import importlib.util
import json
import os
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location("build_pool", Path(__file__).parents[2] / "tools" / "build_pool.py")
assert SPEC is not None and SPEC.loader is not None
build_pool = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build_pool)


PACKED = {
    "https://example.test/one": "One||item|ability|moves|nature|evs|gender|ivs|shiny|level|happiness,pokeball]",
    "https://example.test/two": "Two||item|ability|moves|nature|evs|gender|ivs|shiny|level|happiness,pokeball]",
}


def make_manifest(tmp_path: Path) -> tuple[Path, Path]:
    pool_dir = tmp_path / "snapshot"
    pool_dir.mkdir()
    manifest_path = pool_dir / "sources.json"
    manifest_path.write_text(
        json.dumps(
            {
                "id": "test-pool",
                "format": "gen9testbo3",
                "teams": [
                    {"id": "one", "paste": "https://example.test/one", "author": "A"},
                    {"id": "two", "paste": "https://example.test/two", "author": "B"},
                ],
            }
        ),
        encoding="utf-8",
    )
    return manifest_path, pool_dir


def stub_build(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(build_pool, "default_ps_dir", lambda: Path("unused"))
    monkeypatch.setattr(build_pool, "default_node", lambda: "node")
    monkeypatch.setattr(build_pool, "fetch_paste", lambda url: url)
    monkeypatch.setattr(build_pool, "pack_team", lambda text, ps_dir, node: PACKED[text])
    monkeypatch.setattr(build_pool, "validate_team", lambda packed, format_id, ps_dir, node: None)


def assert_no_outputs(pool_dir: Path) -> None:
    assert not (pool_dir / "one.team").exists()
    assert not (pool_dir / "two.team").exists()
    assert not (pool_dir / "pool.json").exists()


def test_later_validation_failure_publishes_nothing(tmp_path, monkeypatch):
    manifest_path, pool_dir = make_manifest(tmp_path)
    stub_build(monkeypatch)

    def validate(packed, format_id, ps_dir, node):
        if packed == PACKED["https://example.test/two"]:
            raise ValueError("invalid second team")

    monkeypatch.setattr(build_pool, "validate_team", validate)

    with pytest.raises(ValueError, match="invalid second team"):
        build_pool.main(str(manifest_path))

    assert_no_outputs(pool_dir)


def test_duplicate_failure_publishes_nothing(tmp_path, monkeypatch):
    manifest_path, pool_dir = make_manifest(tmp_path)
    stub_build(monkeypatch)
    monkeypatch.setattr(
        build_pool,
        "pack_team",
        lambda text, ps_dir, node: PACKED["https://example.test/one"],
    )

    with pytest.raises(SystemExit, match="duplicates the species set"):
        build_pool.main(str(manifest_path))

    assert_no_outputs(pool_dir)


@pytest.mark.parametrize("existing_name", ["one.team", "pool.json"])
def test_existing_snapshot_output_is_never_overwritten(tmp_path, monkeypatch, existing_name):
    manifest_path, pool_dir = make_manifest(tmp_path)
    existing = pool_dir / existing_name
    existing.write_text("original\n", encoding="utf-8")
    monkeypatch.setattr(
        build_pool,
        "fetch_paste",
        lambda url: pytest.fail("must refuse before fetching"),
    )

    with pytest.raises(FileExistsError, match="refusing to overwrite"):
        build_pool.main(str(manifest_path))

    assert existing.read_text(encoding="utf-8") == "original\n"
    assert not (pool_dir / "two.team").exists()


def test_staging_write_failure_is_cleaned_up(tmp_path, monkeypatch):
    manifest_path, pool_dir = make_manifest(tmp_path)
    stub_build(monkeypatch)
    original_write_text = Path.write_text

    def write_text(path, data, **kwargs):
        if path.name == "two.team":
            raise OSError("disk full")
        return original_write_text(path, data, **kwargs)

    monkeypatch.setattr(Path, "write_text", write_text)

    with pytest.raises(OSError, match="disk full"):
        build_pool.main(str(manifest_path))

    assert_no_outputs(pool_dir)
    assert list(tmp_path.iterdir()) == [pool_dir]


def test_publication_failure_rolls_back_new_files(tmp_path, monkeypatch):
    manifest_path, pool_dir = make_manifest(tmp_path)
    stub_build(monkeypatch)
    real_link = os.link
    calls = 0

    def failing_link(source, target):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("publish failed")
        real_link(source, target)

    monkeypatch.setattr(build_pool.os, "link", failing_link)

    with pytest.raises(OSError, match="publish failed"):
        build_pool.main(str(manifest_path))

    assert_no_outputs(pool_dir)
    assert list(tmp_path.iterdir()) == [pool_dir]


def test_success_writes_unchanged_team_and_manifest_shapes(tmp_path, monkeypatch):
    manifest_path, pool_dir = make_manifest(tmp_path)
    stub_build(monkeypatch)

    assert build_pool.main(str(manifest_path)) == 0

    assert (pool_dir / "one.team").read_text(encoding="utf-8") == PACKED["https://example.test/one"] + "\n"
    assert (pool_dir / "two.team").read_text(encoding="utf-8") == PACKED["https://example.test/two"] + "\n"
    assert json.loads((pool_dir / "pool.json").read_text(encoding="utf-8")) == {
        "id": "test-pool",
        "format": "gen9testbo3",
        "teams": [
            {
                "id": "one",
                "file": "one.team",
                "source": {"paste": "https://example.test/one", "author": "A"},
            },
            {
                "id": "two",
                "file": "two.team",
                "source": {"paste": "https://example.test/two", "author": "B"},
            },
        ],
    }
