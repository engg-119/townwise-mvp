"""The API's side of the lab contract: golden/api-input.json is an input the API built (api/test/lab-input.test.ts checks
it equals what labInputOf makes, and regenerates it), and the lab must take it as it is. Version 2 only: version 1 and
a calendar entry carrying a title or a URL are refused. Synthetic data only."""

import copy
import json
from pathlib import Path

import pytest

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


def api_input() -> dict:
    return json.loads(API_INPUT.read_text(encoding="utf-8"))


def test_the_api_input_is_version_2_with_its_calendar_and_champion_engine():
    inp = api_input()
    assert inp["schema"] == schema.INPUT_SCHEMA == "townwise.lab-input/2"
    assert inp["champion"]["engine"] in schema.ENGINES
    kinds = {entry["kind"] for entry in inp["calendar"]}
    assert {"holiday", "term", "event"} <= kinds
    assert all(set(entry) == schema.CALENDAR_KEYS for entry in inp["calendar"])


def test_a_version_1_input_is_refused():
    inp = api_input()
    inp["schema"] = "townwise.lab-input/1"
    with pytest.raises(schema.InputError, match="^schema$"):
        schema.validate_input(inp)
    # As version 1 was: no calendar and no champion engine
    del inp["calendar"]
    del inp["champion"]["engine"]
    assert calibrate(inp, "0" * 40) == {"schema": schema.RESULT_SCHEMA, "calibrationId": inp["calibrationId"],
                                        "ok": False, "code": "invalid_input"}


@pytest.mark.parametrize("key", ["title", "url", "sources", "groupLabel"])
def test_a_calendar_entry_with_a_title_or_url_is_refused(key):
    inp = api_input()
    entry = next(i for i, e in enumerate(inp["calendar"]) if e["kind"] == "event")
    broken = copy.deepcopy(inp)
    broken["calendar"][entry][key] = "Test Town Festival" if key != "url" else "https://example.test/festival"
    with pytest.raises(schema.InputError, match=rf"^calendar\[{entry}\]$"):
        schema.validate_input(broken)
    assert calibrate(broken, "0" * 40)["code"] == "invalid_input"


@pytest.mark.parametrize("field, value", [("kind", "show"), ("group", "Test Town"), ("start", "2025-02-30"),
                                          ("confidence", "certain"), ("id", "Test Town Festival")])
def test_a_calendar_entry_with_a_bad_field_is_refused(field, value):
    inp = api_input()
    inp["calendar"][0][field] = value
    with pytest.raises(schema.InputError, match=r"^calendar\[0\]"):
        schema.validate_input(inp)


def test_a_champion_without_a_known_engine_is_refused():
    inp = api_input()
    inp["champion"]["engine"] = "xgboost"
    with pytest.raises(schema.InputError, match="^champion.engine$"):
        schema.validate_input(inp)
