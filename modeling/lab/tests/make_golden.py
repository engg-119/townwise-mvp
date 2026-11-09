"""Writes golden/input.json (synthetic_input(0)) and golden/result.json (its LabResult, code version forty zeros).

The API's contract test (api/test/lab-contract.test.ts) parses both, and test_golden_result_is_current fails until they
are regenerated after a change to the pipeline. Synthetic data only. From modeling/lab:

    uv run python tests/make_golden.py
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]  # tests/ for the fixture, the lab for townwise_lab

from fixture import synthetic_input  # noqa: E402

from townwise_lab.pipeline import calibrate  # noqa: E402

CODE_VERSION = "0" * 40


def write(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, indent=1, allow_nan=False) + "\n", encoding="utf-8")


def main() -> None:
    golden = HERE / "golden"
    golden.mkdir(exist_ok=True)
    inp = synthetic_input(0)
    result = calibrate(inp, CODE_VERSION)
    if not result["ok"]:
        raise SystemExit(f"the synthetic input did not calibrate: {result['code']}")
    write(golden / "input.json", inp)
    write(golden / "result.json", result)
    print(f"wrote golden/input.json ({len(inp['days'])} days) and golden/result.json")


if __name__ == "__main__":
    main()
