"""python -m townwise_lab run: writes the LabResult and prints counts only, never a figure, a date or a message."""

import json
import re
import subprocess
import sys
import warnings
from pathlib import Path

from townwise_lab.__main__ import main

LAB = Path(__file__).resolve().parents[1]
GOLDEN_INPUT = Path(__file__).resolve().parent / "golden" / "input.json"
CODE = "0" * 40


def refuse_constant(name: str):
    raise AssertionError(f"the result holds {name}")


def run(*args: str) -> int:
    return main(["run", *args])


def test_cli_run_writes_result_and_prints_counts_only(tmp_path, capsys):
    out = tmp_path / "result.json"
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        assert run("--input", str(GOLDEN_INPUT), "--output", str(out), "--code-version", CODE) == 0
    assert [w.category.__name__ for w in caught] == []  # a library warning would reach the job's stderr
    printed = capsys.readouterr()
    assert re.fullmatch(r"calibrated: \d+ history days, \d+ backtest weeks, \d+ forecast days\n", printed.out)
    assert printed.err == ""
    result = json.loads(out.read_text(encoding="utf-8"), parse_constant=refuse_constant)
    assert result["ok"] is True and result["codeVersion"] == CODE
    card = result["scorecard"]
    assert [int(n) for n in re.findall(r"\d+", printed.out)] == [
        card["history"]["days"], card["backtest"]["weeks"], len(result["run"]["days"])]


def test_cli_prints_only_the_exception_class_on_failure(tmp_path, capsys):
    out = tmp_path / "result.json"
    assert run("--input", str(tmp_path / "missing.json"), "--output", str(out), "--code-version", CODE) == 1
    printed = capsys.readouterr()
    assert (printed.out, printed.err) == ("", "failed: FileNotFoundError\n")
    assert not out.exists()


def test_cli_refuses_a_code_version_that_is_not_a_full_commit(tmp_path, capsys):
    out = tmp_path / "result.json"
    assert run("--input", str(GOLDEN_INPUT), "--output", str(out), "--code-version", "abc1234") == 1
    assert capsys.readouterr().err == "failed: ValueError\n"
    assert not out.exists()


def test_cli_writes_a_failed_result_and_prints_its_code(tmp_path, capsys):
    bad = json.loads(GOLDEN_INPUT.read_text(encoding="utf-8"))
    bad["days"] = bad["days"][:10] + bad["days"][11:]  # a gap
    source, out = tmp_path / "input.json", tmp_path / "result.json"
    source.write_text(json.dumps(bad), encoding="utf-8")
    assert run("--input", str(source), "--output", str(out), "--code-version", CODE) == 1
    printed = capsys.readouterr()
    assert (printed.out, printed.err) == ("", "failed: invalid_input\n")
    assert json.loads(out.read_text(encoding="utf-8"))["code"] == "invalid_input"


def test_cli_runs_as_a_module(tmp_path):
    done = subprocess.run([sys.executable, "-m", "townwise_lab", "run", "--input", str(tmp_path / "missing.json"),
                           "--output", str(tmp_path / "result.json"), "--code-version", CODE],
                          cwd=LAB, capture_output=True, text=True, timeout=120)
    assert (done.returncode, done.stdout, done.stderr) == (1, "", "failed: FileNotFoundError\n")
