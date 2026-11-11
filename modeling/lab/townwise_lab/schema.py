"""The lab's two documents: the LabInput the API builds (townwise.lab-input/1) and the LabResult the lab returns
(townwise.lab-result/1). validate_input checks an input against the contract before anything is fitted; its errors
name a path, never a value."""

import math
import re
from datetime import date, timedelta

from townwise_lab.forecast import HORIZON_DAYS

INPUT_SCHEMA = "townwise.lab-input/1"
RESULT_SCHEMA = "townwise.lab-result/1"

ONE_OFF = "one_off"  # an event with no calendar group
TERMS = ("fall", "winter", "spring", "summer", "interim")
DAY_STATUSES = ("open", "closed", "booked")
INPUT_KEYS = {"schema", "calibrationId", "metric", "today", "dataThrough", "horizonDays", "regimeStart", "days",
              "champion"}
DAY_KEYS = {"date", "guests", "term", "weekOfTerm", "events", "closed", "privateEvent", "booked"}
CHAMPION_KEYS = {"runId", "dataThrough", "days", "weeks"}
CHAMPION_DAY_KEYS = {"date", "status", "low", "mid", "high"}
CHAMPION_WEEK_KEYS = {"from", "to", "openDays", "low", "mid", "high"}
CALIBRATION_ID = re.compile(r"[0-9a-f]{24}")
GROUP = re.compile(r"[a-z0-9][a-z0-9:-]{0,119}")  # a calendar group, as the run file's reason refs allow
ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


class InputError(ValueError):
    """The input breaks the lab-input contract. The message is where (a path such as days[3].guests), never a value."""


def _require(ok: bool, path: str) -> None:
    if not ok:
        raise InputError(path)


def _date(value) -> date | None:
    if not (isinstance(value, str) and ISO_DATE.fullmatch(value)):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def _count(value) -> bool:
    """A finite number of guests: zero or more, and not a boolean."""
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def _int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _object(value, keys: set[str], path: str) -> None:
    _require(isinstance(value, dict) and set(value) == keys, path)


def _champion(champion: dict) -> None:
    _object(champion, CHAMPION_KEYS, "champion")
    _require(isinstance(champion["runId"], str) and champion["runId"] != "", "champion.runId")
    _require(_date(champion["dataThrough"]) is not None, "champion.dataThrough")
    _require(isinstance(champion["days"], list), "champion.days")
    seen = set()
    for i, day in enumerate(champion["days"]):
        at = f"champion.days[{i}]"
        _object(day, CHAMPION_DAY_KEYS, at)
        _require(_date(day["date"]) is not None and day["date"] not in seen, f"{at}.date")
        seen.add(day["date"])
        _require(isinstance(day["status"], str) and day["status"] in DAY_STATUSES, f"{at}.status")
        numbers = (day["low"], day["mid"], day["high"])
        _require(all(_count(v) for v in numbers) if day["status"] == "open" else all(v is None or _count(v)
                                                                                      for v in numbers), at)
    _require(isinstance(champion["weeks"], list), "champion.weeks")
    for i, week in enumerate(champion["weeks"]):
        at = f"champion.weeks[{i}]"
        _object(week, CHAMPION_WEEK_KEYS, at)
        _require(_date(week["from"]) is not None and _date(week["to"]) is not None, f"{at}.from")
        _require(_int(week["openDays"]) and 0 <= week["openDays"] <= 7, f"{at}.openDays")
        _require(all(_count(week[k]) for k in ("low", "mid", "high")), at)


def validate_input(inp: dict) -> None:
    """Raises InputError unless `inp` is a LabInput: every date from its first day to dataThrough + 182 once, in order;
    guests a count or null, and null after dataThrough; the calendar fields typed; the champion null or a run."""
    _object(inp, INPUT_KEYS, "input")
    _require(inp["schema"] == INPUT_SCHEMA, "schema")
    _require(isinstance(inp["calibrationId"], str) and CALIBRATION_ID.fullmatch(inp["calibrationId"]) is not None,
             "calibrationId")
    _require(inp["metric"] == "guests", "metric")
    through, today = _date(inp["dataThrough"]), _date(inp["today"])
    _require(through is not None, "dataThrough")
    _require(today is not None and today >= through, "today")
    _require(_int(inp["horizonDays"]) and inp["horizonDays"] == HORIZON_DAYS, "horizonDays")
    _require(inp["regimeStart"] is None or _date(inp["regimeStart"]) is not None, "regimeStart")

    days = inp["days"]
    _require(isinstance(days, list) and len(days) > 0, "days")
    previous = None
    for i, day in enumerate(days):
        at = f"days[{i}]"
        _object(day, DAY_KEYS, at)
        when = _date(day["date"])
        _require(when is not None and (previous is None or when == previous + timedelta(days=1)), f"{at}.date")
        previous = when
        _require(day["guests"] is None or (_count(day["guests"]) and when <= through), f"{at}.guests")
        _require(isinstance(day["term"], str) and day["term"] in TERMS, f"{at}.term")
        _require(_int(day["weekOfTerm"]) and day["weekOfTerm"] >= -1, f"{at}.weekOfTerm")
        _require(isinstance(day["events"], list) and all(
            isinstance(e, str) and (e == ONE_OFF or GROUP.fullmatch(e) is not None) for e in day["events"]),
                 f"{at}.events")
        _require(all(isinstance(day[k], bool) for k in ("closed", "privateEvent", "booked")), at)
    _require(_date(days[0]["date"]) <= through and previous == through + timedelta(days=HORIZON_DAYS), "days")

    if inp["champion"] is not None:
        _champion(inp["champion"])
