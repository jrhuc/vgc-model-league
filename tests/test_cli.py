import pytest

from vgcbench import cli
from vgcbench.cli import build_parser


@pytest.mark.parametrize(
    "argv",
    [
        ["run", "--models", "a", "b", "--series-per-pair", "0"],
        ["run", "--models", "a", "b", "--concurrency", "0"],
    ],
)
def test_workload_values_must_be_positive(argv):
    with pytest.raises(SystemExit):
        build_parser().parse_args(argv)


def test_run_is_one_vgc_round_robin_command():
    args = build_parser().parse_args(
        [
            "run",
            "--models",
            "meta:muse-spark-1.1",
            "openai:gpt-5.2",
            "anthropic:claude-sonnet-5",
            "--reasoning",
            "medium",
            "--series-per-pair",
            "3",
        ]
    )

    assert len(args.models) == 3
    assert args.reasoning == "medium"
    assert args.series_per_pair == 3
    assert args.pool == "test"


@pytest.mark.parametrize("command", ["standings", "report"])
def test_output_commands_accept_optional_pool(command):
    assert build_parser().parse_args([command]).pool is None
    assert build_parser().parse_args([command, "--pool", "regmb"]).pool == "regmb"


def test_standings_pool_filters_rows(monkeypatch):
    rows = [{"pool": "a"}, {"pool": "b"}, {}]
    captured = []
    monkeypatch.setattr(cli, "load_rows", lambda path: rows)
    monkeypatch.setattr(cli, "_print_standings", captured.extend)

    assert cli.main(["standings", "--pool", "b"]) == 0
    assert captured == [{"pool": "b"}]


def test_report_passes_pool_filter(monkeypatch, tmp_path):
    from vgcbench import report

    captured = {}

    def fake_write_report(records_path, out_path, pool=None):
        captured.update(records_path=records_path, out_path=out_path, pool=pool)
        return out_path

    monkeypatch.setattr(report, "write_report", fake_write_report)

    out = tmp_path / "report.html"
    assert cli.main(["report", "--out", str(out), "--pool", "regmb"]) == 0
    assert captured == {
        "records_path": cli.RESULTS,
        "out_path": str(out),
        "pool": "regmb",
    }
