"""The API's side of the lab contract: golden/api-input.json is an input the API built (api/test/lab-input.test.ts checks
it equals what labInputOf makes, and regenerates it), and the lab must take it as it is. Synthetic data only."""

import json
from pathlib import Path

from townwise_lab import schema
from townwise_lab.pipeline import calibrate

API_INPUT = Path(__file__).resolve().parent / "golden" / "api-input.json"


def test_the_input_the_api_builds_validates_and_calibrates():
    inp = json.loads(API_INPUT.read_text(encoding="utf-8"))
    schema.validate_input(inp)  # raises InputError, naming a path, on any break of the contract
    result = calibrate(inp, "0" * 40)
    assert result["ok"] is True, result.get("code")
    assert result["calibrationId"] == inp["calibrationId"]
    assert result["run"]["dataThrough"] == inp["dataThrough"] and result["run"]["madeAt"] == inp["today"]
    assert result["params"]["regimeStart"] == inp["regimeStart"]
    card = result["scorecard"]
    assert card["backtest"]["weeksWithRange"] >= 12
    assert card["comparison"] is not None and card["comparison"]["championRunId"] == inp["champion"]["runId"]
