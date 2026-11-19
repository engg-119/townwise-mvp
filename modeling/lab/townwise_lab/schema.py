"""The lab's two documents: the LabInput the API builds (townwise.lab-input/3) and the LabResult the lab returns
(townwise.lab-result/1). validate_input checks an input against the contract before anything is fitted; its errors
name a path, never a value. Inputs of versions 1 and 2 are refused: the API and the lab move to version 3 together
(D52: 400 future days and termsThrough, the town's last researched term day)."""

import math
import re
from datetime import date, timedelta

from townwise_lab.forecast import HORIZON_DAYS

INPUT_SCHEMA = "townwise.lab-input/3"
RESULT_SCHEMA = "townwise.lab-result/1"

ONE_OFF = "one_off"  # an event with no calendar group
TERMS = ("fall", "winter", "spring", "summer", "interim")
DAY_STATUSES = ("open", "closed", "booked")
ENGINES = ("model", "baseline")
CALENDAR_KINDS = ("event", "holiday", "term", "season")
CONFIDENCES = ("high", "medium", "low")
INPUT_KEYS = {"schema", "calibrationId", "metric", "today", "dataThrough", "horizonDays", "termsThrough", "regimeStart",
              "days", "calendar", "champion"}
DAY_KEYS = {"date", "guests", "term", "weekOfTerm", "events", "closed", "privateEvent", "booked"}
CALENDAR_KEYS = {"id", "group", "kind", "start", "end", "confidence"}  # never a title, URL or source label
CHAMPION_KEYS = {"runId", "engine", "recordedWeekdayBiasMeanAbs", "dataThrough", "days", "weeks"}
CHAMPION_DAY_KEYS = {"date", "status", "low", "mid", "high"}
CHAMPION_WEEK_KEYS = {"from", "to", "openDays", "low", "mid", "high"}
CALIBRATION_ID = re.compile(r"[0-9a-f]{24}")
GROUP = re.compile(r"[a-z0-9][a-z0-9:-]{0,119}")  # a calendar group, as the run file's reason refs allow
ENTRY_ID = re.compile(r"[a-z0-9][a-z0-9:-]{0,199}")  # a calendar entry's id (api/src/town-calendar.ts)
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
    _require(isinstance(champion["engine"], str) and champion["engine"] in ENGINES, "champion.engine")
    _require(champion["recordedWeekdayBiasMeanAbs"] is None or _count(champion["recordedWeekdayBiasMeanAbs"]),
             "champion.recordedWeekdayBiasMeanAbs")
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


def _calendar(calendar) -> None:
    _require(isinstance(calendar, list), "calendar")
    for i, entry in enumerate(calendar):
        at = f"calendar[{i}]"
        _object(entry, CALENDAR_KEYS, at)
        _require(isinstance(entry["id"], str) and ENTRY_ID.fullmatch(entry["id"]) is not None, f"{at}.id")
        _require(entry["group"] is None or (isinstance(entry["group"], str) and GROUP.fullmatch(entry["group"])
                                            is not None), f"{at}.group")
        _require(isinstance(entry["kind"], str) and entry["kind"] in CALENDAR_KINDS, f"{at}.kind")
        start, end = _date(entry["start"]), _date(entry["end"])
        _require(start is not None and end is not None and start <= end, f"{at}.start")
        _require(entry["confidence"] is None or (isinstance(entry["confidence"], str)
                                                 and entry["confidence"] in CONFIDENCES), f"{at}.confidence")


def validate_input(inp: dict) -> None:
    """Raises InputError unless `inp` is a LabInput: every date from its first day to dataThrough + 400 once, in order;
    guests a count or null, and null after dataThrough; the calendar fields typed; the town calendar's entries with
    no title, URL or source; termsThrough a date or null; the champion null or a run with its engine and its recorded weekday bias (null without
    one)."""
    _object(inp, INPUT_KEYS, "input")
    _require(inp["schema"] == INPUT_SCHEMA, "schema")
    _require(isinstance(inp["calibrationId"], str) and CALIBRATION_ID.fullmatch(inp["calibrationId"]) is not None,
             "calibrationId")
    _require(inp["metric"] == "guests", "metric")
    through, today = _date(inp["dataThrough"]), _date(inp["today"])
    _require(through is not None, "dataThrough")
    _require(today is not None and today >= through, "today")
    _require(_int(inp["horizonDays"]) and inp["horizonDays"] == HORIZON_DAYS, "horizonDays")
    _require(inp["termsThrough"] is None or _date(inp["termsThrough"]) is not None, "termsThrough")
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
    _calendar(inp["calendar"])

    if inp["champion"] is not None:
        _champion(inp["champion"])
