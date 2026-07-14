import pytest

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
