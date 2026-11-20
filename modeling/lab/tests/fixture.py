"""A synthetic restaurant history for the lab's tests. It reads no file and holds no real restaurant's figure.

synthetic_frame(seed) is the frame the lab builds from a LabInput (date, weekday, guests, term, week_of_term, one
ev_<group> column per town event group, private_event, closed, booked and the holiday flags), plus the notebook's own
column names for the same facts (is_2026, football_home) and two show flags only the notebook has, so one frame feeds
both the lab and the notebook's functions in the parity tests. synthetic_input(seed) is the same history as the
LabInput the API sends, with synthetic_calendar as its town calendar and synthetic_champion as the current published
run.
"""

import json
import re
from pathlib import Path

import numpy as np
import pandas as pd
from pandas.tseries.holiday import USFederalHolidayCalendar

FIRST_DAY = pd.Timestamp("2024-01-01")
DATA_THROUGH = pd.Timestamp("2025-10-21")
FUTURE_DAYS = 400  # the LabInput's future days (input version 3, D52)
CHAMPION_DAYS = 182  # the current published run's days after its cutoff
LEVEL_SHIFT = DATA_THROUGH - pd.Timedelta(days=364)  # the last year runs busier (what the notebook's is_2026 marks)
REGIME_START = pd.Timestamp("2025-05-26")  # Mondays have no row from here on, and three weekdays change level
FESTIVAL = "ev_test-town:festival"
FOOTBALL = "ev_test-town:home-football"

# The notebook's inputs under its own column names (sections 2 and 2d), for the parity tests
NOTEBOOK_BASE = ["weekday", "is_2026", "term"]
NOTEBOOK_EVENT_INPUTS = [FESTIVAL, "football_home", "private_event", "show_comedy_improv", "show_music"]
NOTEBOOK_EVENT_COLS = NOTEBOOK_EVENT_INPUTS + ["week_of_term", "weekday"]

WEEKDAY_LEVEL = {"Monday": 30, "Tuesday": 38, "Wednesday": 45, "Thursday": 55, "Friday": 85, "Saturday": 95,
                 "Sunday": 50}
REGIME_SHIFT = {"Tuesday": 0.8, "Wednesday": 0.85, "Saturday": 1.1}
TERMS = {"winter": ((1, 6), (3, 14)), "spring": ((3, 27), (6, 9)), "summer": ((6, 22), (8, 25)),
         "fall": ((9, 10), (11, 24))}
TERM_LIFT = {"winter": 1.15, "spring": 1.25, "summer": 1.05, "fall": 1.3, "interim": 1.0}
FESTIVAL_STARTS = ["2024-02-08", "2024-07-18", "2025-02-13", "2025-07-17", "2026-02-12"]  # Thursday to Saturday
CLOSED_NO_ROW = ["2024-08-12", "2024-08-13", "2024-08-14"]  # a closure note, no sales row
CLOSED_WITH_GUESTS = ["2025-03-04"]  # a closure note on a day that still has a sales row
CLOSED_FUTURE = ["2025-12-29"]
ZERO_GUEST_DAYS = ["2024-03-19", "2024-09-03", "2025-04-15"]
EFFECT = {"festival": 1.5, "football": 1.6, "private_event": 1.3, "comedy": 1.15, "music": 1.2, "big_night": 1.8,
          "halloween": 1.4, "level_shift": 1.2}


def _notebook_holidays(dates: pd.Series) -> pd.DataFrame:
    # The notebook's holiday rules (section 1, cell 6), copied here so the lab's holiday_flags is checked against them,
    # except Halloween: the notebook flagged Oct 31 alone, the lab (v11) the weekend too, as written out below; read a
    # day past the last date, as the lab does, since the frame (400 days after the cutoff) ends on Thanksgiving Eve
    friday = dates - pd.to_timedelta((dates.dt.day_of_week == 5).astype(int), unit="D")
    md = friday.dt.month * 100 + friday.dt.day
    halloween = ((dates.dt.month == 10) & (dates.dt.day == 31)) | (
        dates.dt.day_of_week.isin([4, 5]) & (md.between(1027, 1031) | md.between(1101, 1102)))
    federal = USFederalHolidayCalendar().holidays(dates.min(), dates.max() + pd.Timedelta(days=1), return_name=True)
    thanksgiving = federal[federal == "Thanksgiving Day"].index
    years = range(dates.min().year, dates.max().year + 1)
    big_night = list(thanksgiving - pd.Timedelta(days=1)) + [pd.Timestamp(y, 12, d) for y in years for d in (23, 31)]
    closed = list(thanksgiving) + [pd.Timestamp(y, m, d) for y in years
                                   for m, d in ((1, 1), (7, 4), (12, 24), (12, 25))]
    return pd.DataFrame({
        "hol_big_night": dates.isin(big_night).astype(int),
        "hol_halloween": halloween.astype(int),
        "hol_closed": dates.isin(closed).astype(int),
        "federal_holiday": dates.isin(federal.index).astype(int),
    }, index=dates.index)


def _on(dates: pd.Series, days: list[str]) -> pd.Series:
    return dates.isin(pd.to_datetime(days))


def synthetic_frame(seed: int = 0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    dates = pd.Series(pd.date_range(FIRST_DAY, DATA_THROUGH + pd.Timedelta(days=FUTURE_DAYS)), name="date")
    f = pd.DataFrame({"date": dates, "weekday": dates.dt.day_name()})

    f["term"], f["week_of_term"] = "interim", -1
    for year in range(FIRST_DAY.year, dates.max().year + 1):
        for season, ((m1, d1), (m2, d2)) in TERMS.items():
            start = pd.Timestamp(year, m1, d1)
            span = dates.between(start, pd.Timestamp(year, m2, d2))
            f.loc[span, "term"] = season
            f.loc[span, "week_of_term"] = (dates[span] - start).dt.days // 7

    hol = _notebook_holidays(dates)
    festival = pd.Series(False, index=f.index)
    for start in pd.to_datetime(FESTIVAL_STARTS):
        festival |= dates.between(start, start + pd.Timedelta(days=2))
    f[FESTIVAL] = festival.astype(int)
    f[FOOTBALL] = ((f.term == "fall") & (f.weekday == "Saturday") & (dates.dt.isocalendar().week % 2 == 0)).astype(int)

    closed_dates = CLOSED_NO_ROW + CLOSED_WITH_GUESTS + CLOSED_FUTURE
    quiet = (hol.drop(columns="federal_holiday").sum(axis=1) == 0) & ~festival & ~_on(dates, closed_dates + ZERO_GUEST_DAYS)
    candidates = dates[quiet & ((dates - pd.Timestamp("2024-01-10")).dt.days % 19 == 0)]
    booked_dates = candidates.iloc[2::3]  # every third private event is a buyout (a private event closed to walk-ins)
    f["private_event"] = dates.isin(candidates).astype(int)
    f["closed"] = _on(dates, closed_dates)
    f["booked"] = dates.isin(booked_dates)
    f = pd.concat([f, hol], axis=1)

    # Only the notebook has show dates: comedy on each month's first Thursday, music on its last Friday
    first_thursday = (f.weekday == "Thursday") & (dates.dt.day <= 7)
    last_friday = (f.weekday == "Friday") & ((dates + pd.Timedelta(days=7)).dt.month != dates.dt.month)
    f["is_2026"] = (dates >= LEVEL_SHIFT).astype(int)
    f["football_home"] = f[FOOTBALL]
    f["show_comedy_improv"] = first_thursday.astype(int)
    f["show_music"] = last_friday.astype(int)

    level = f.weekday.map(WEEKDAY_LEVEL).astype(float) * f.term.map(TERM_LIFT)
    level *= np.where(dates >= REGIME_START, f.weekday.map(REGIME_SHIFT).fillna(1.0), 1.0)
    level *= np.where(f.is_2026 == 1, EFFECT["level_shift"], 1.0)
    for column, effect in ((FESTIVAL, "festival"), (FOOTBALL, "football"), ("private_event", "private_event"),
                           ("show_comedy_improv", "comedy"), ("show_music", "music"),
                           ("hol_big_night", "big_night"), ("hol_halloween", "halloween")):
        level *= np.where(f[column] == 1, EFFECT[effect], 1.0)
    guests = np.round(level * rng.lognormal(0.0, 0.15, len(f)))

    no_row = ((dates > DATA_THROUGH) | _on(dates, CLOSED_NO_ROW)
              | ((f.hol_closed == 1) & ~((dates.dt.month == 7) & (dates.dt.day == 4)))  # open on July 4
              | ((f.weekday == "Monday") & (dates >= REGIME_START)))
    f["guests"] = np.where(no_row, np.nan, np.where(_on(dates, ZERO_GUEST_DAYS), 0.0, guests))

    lab = ["date", "weekday", "guests", "term", "week_of_term", FESTIVAL, FOOTBALL, "private_event", "closed", "booked",
           "hol_big_night", "hol_halloween", "hol_closed", "federal_holiday"]
    return f[lab + ["is_2026", "football_home", "show_comedy_improv", "show_music"]]


CALIBRATION_ID = "0123456789abcdef01234567"
CHAMPION_RUN_ID = "fedcba9876543210fedcba98"
CHAMPION_THROUGH = pd.Timestamp("2025-06-30")  # the current published run's data cutoff, a quarter before the lab's
TODAY = DATA_THROUGH + pd.Timedelta(days=2)


def _iso(day: pd.Timestamp) -> str:
    return day.strftime("%Y-%m-%d")


HOLIDAY_SLUGS = {"New Year's Day": "new-years-day", "Birthday of Martin Luther King, Jr.": "martin-luther-king-jr-day",
                 "Washington's Birthday": "washingtons-birthday", "Memorial Day": "memorial-day",
                 "Juneteenth National Independence Day": "juneteenth", "Independence Day": "independence-day",
                 "Labor Day": "labor-day", "Columbus Day": "columbus-day", "Veterans Day": "veterans-day",
                 "Thanksgiving Day": "thanksgiving", "Christmas Day": "christmas"}


def synthetic_calendar(frame: pd.DataFrame) -> list[dict]:
    """The town calendar the API sends for `frame`'s dates (townEvents, api/src/lab/input.ts): the federal holidays
    (group us:<slug>), each term (group test-town:classes:<season>), each festival and each home football Saturday,
    with ids, groups, kinds, dates and confidence only. Sorted by start, then id, as townEvents sorts."""
    first, last = frame.date.min(), frame.date.max()
    entries = []
    federal = USFederalHolidayCalendar().holidays(first, last, return_name=True)
    for when, name in federal.items():
        slug = HOLIDAY_SLUGS[name]
        entries.append({"id": f"us:{slug}:{when.year}", "group": f"us:{slug}", "kind": "holiday", "start": _iso(when),
                        "end": _iso(when), "confidence": None})
    for year in range(first.year, last.year + 1):
        for season, ((m1, d1), (m2, d2)) in TERMS.items():
            start, end = pd.Timestamp(year, m1, d1), pd.Timestamp(year, m2, d2)
            if start <= last and end >= first:
                entries.append({"id": f"test-town:{_iso(start)}:{season}-term", "group": f"test-town:classes:{season}",
                                "kind": "term", "start": _iso(start), "end": _iso(end), "confidence": "high"})
    for start in pd.to_datetime(FESTIVAL_STARTS):
        if first <= start <= last:
            entries.append({"id": f"test-town:{_iso(start)}:festival", "group": FESTIVAL.removeprefix("ev_"),
                            "kind": "event", "start": _iso(start), "end": _iso(start + pd.Timedelta(days=2)),
                            "confidence": "medium"})
    for when in frame.date[frame[FOOTBALL] == 1]:
        entries.append({"id": f"test-town:{_iso(when)}:home-football", "group": FOOTBALL.removeprefix("ev_"),
                        "kind": "event", "start": _iso(when), "end": _iso(when), "confidence": "high"})
    return sorted(entries, key=lambda e: (e["start"], e["id"]))


def synthetic_champion(frame: pd.DataFrame, through: pd.Timestamp = CHAMPION_THROUGH) -> dict:
    """A published run made at `through` for the 182 days after it (the LabInput's champion): each weekday's median
    guests over the days before it as the forecast, 20% below to 25% above as the daily range and 15% either side as
    the weekly one; closures, the holidays the place closes on and Mondays from the regime on are closed, buyouts
    booked. Weeks run Monday to Sunday, clipped to its days. No recorded weekday bias, as for an imported run, so the
    model's weekday-bias check (pipeline.passes) has nothing to compare with."""
    past = frame[(frame.date <= through) & frame.guests.gt(0) & ~frame.closed & ~frame.booked]
    median = past.groupby("weekday").guests.median()
    rows = frame[(frame.date > through) & (frame.date <= through + pd.Timedelta(days=CHAMPION_DAYS))]
    closed = rows.closed | rows.hol_closed.eq(1) | (rows.weekday.eq("Monday") & (rows.date >= REGIME_START))
    status = np.select([rows.booked, closed], ["booked", "closed"], "open")
    mid = rows.weekday.map(median).where(status == "open")
    days = [{"date": _iso(day), "status": str(s), "low": None if s != "open" else round(0.8 * m, 2),
             "mid": None if s != "open" else round(m, 2), "high": None if s != "open" else round(1.25 * m, 2)}
            for day, s, m in zip(rows.date, status, mid)]
    weeks = []
    for _, week in rows.assign(mid=mid).groupby(rows.date - pd.to_timedelta(rows.date.dt.day_of_week, unit="D")):
        total = round(float(week.mid.sum()), 2)
        weeks.append({"from": _iso(week.date.min()), "to": _iso(week.date.max()),
                      "openDays": int(week.mid.notna().sum()),
                      "low": round(0.85 * total, 2), "mid": total, "high": round(1.15 * total, 2)})
    return {"runId": CHAMPION_RUN_ID, "engine": "model", "recordedWeekdayBiasMeanAbs": None, "dataThrough": _iso(through),
            "days": days, "weeks": weeks}


def synthetic_input(seed: int = 0) -> dict:
    """synthetic_frame(seed) as the LabInput the API sends: every date from the first day with guests to the data
    cutoff plus 400 days, no regime start, no termsThrough (the test town's terms are not a researched calendar's), synthetic_calendar over those days, and synthetic_champion (a model run) as
    the current published run."""
    f = synthetic_frame(seed)
    has = f.guests.gt(0)
    first, through = f.date[has].min(), f.date[has].max()
    rows = f[(f.date >= first) & (f.date <= through + pd.Timedelta(days=FUTURE_DAYS))]
    groups = [c for c in rows.columns if c.startswith("ev_")]
    days = [{"date": _iso(row.date), "guests": None if np.isnan(row.guests) else int(row.guests), "term": row.term,
             "weekOfTerm": int(row.week_of_term),
             "events": sorted(c.removeprefix("ev_") for c in groups if row[c] == 1),
             "closed": bool(row.closed), "privateEvent": bool(row.private_event), "booked": bool(row.booked),
             "party": False}
            for _, row in rows.iterrows()]
    return {"schema": "townwise.lab-input/4", "calibrationId": CALIBRATION_ID, "metric": "guests", "today": _iso(TODAY),
            "dataThrough": _iso(through), "horizonDays": FUTURE_DAYS, "termsThrough": None, "regimeStart": None,
            "days": days,
            "calendar": synthetic_calendar(rows), "champion": synthetic_champion(f)}


# Two-year histories of other shapes (two_year_input), for the coverage check (test_coverage.py): no events, terms or
# closures, so what a range has to cover is the season, the week-to-week swings and the daily noise.
TWO_YEAR_LEVEL = {"Monday": 30, "Tuesday": 38, "Wednesday": 45, "Thursday": 55, "Friday": 85, "Saturday": 95,
                  "Sunday": 50}
TWO_YEAR_SHAPES = ("steady", "calm", "drifting", "growing", "closed_mondays")


def two_year_input(seed: int, shape: str, days: int = 700, through: str = "2026-11-15") -> dict:
    """A LabInput of `days` days of guests through `through`, plus 400 days after (guests drawn for the first 182 of
    them, as before the input reached 400, so the histories are those of D42's check): each weekday's level times a yearly
    season (25% either way, peaking in summer) times a weekly swing times daily noise (lognormal, sigma 0.12). The
    weekly swing by `shape`: "steady" an independent 8% each week, "calm" 4%, "drifting" a random walk of 3% a week,
    "growing" steady with 15% more guests a year, "closed_mondays" steady with no Monday row. No calendar, no champion."""
    if shape not in TWO_YEAR_SHAPES:
        raise ValueError(shape)
    rng = np.random.default_rng(seed)
    end = pd.Timestamp(through)
    first = end - pd.Timedelta(days=days - 1)
    dates = pd.Series(pd.date_range(first, end + pd.Timedelta(days=CHAMPION_DAYS)))
    week = ((dates - first).dt.days // 7).to_numpy()
    weeks = int(week.max()) + 1
    swing = (np.exp(np.cumsum(rng.normal(0.0, 0.03, weeks))) if shape == "drifting"
             else np.exp(rng.normal(0.0, 0.04 if shape == "calm" else 0.08, weeks)))
    season = 1 + 0.25 * np.sin(2 * np.pi * (dates.dt.day_of_year.to_numpy() - 100) / 365.25)
    growth = 1 + (0.15 * np.arange(len(dates)) / 365 if shape == "growing" else 0.0)
    level = dates.dt.day_name().map(TWO_YEAR_LEVEL).to_numpy(dtype=float)
    guests = np.round(level * season * growth * swing[week] * rng.lognormal(0.0, 0.12, len(dates)))
    no_row = (dates > end) | ((dates.dt.day_name() == "Monday") & (shape == "closed_mondays"))
    out = [{"date": _iso(day), "guests": None if missing else int(count), "term": "interim", "weekOfTerm": -1,
            "events": [], "closed": False, "privateEvent": False, "booked": False, "party": False}
           for day, count, missing in zip(dates, guests, no_row)]
    out += [{"date": _iso(day), "guests": None, "term": "interim", "weekOfTerm": -1, "events": [], "closed": False,
             "privateEvent": False, "booked": False, "party": False}
            for day in pd.date_range(dates.iloc[-1] + pd.Timedelta(days=1), end + pd.Timedelta(days=FUTURE_DAYS))]
    first_with = next(i for i, d in enumerate(out) if d["guests"])
    return {"schema": "townwise.lab-input/4", "calibrationId": CALIBRATION_ID, "metric": "guests",
            "today": _iso(end + pd.Timedelta(days=1)), "dataThrough": through, "horizonDays": FUTURE_DAYS,
            "termsThrough": None, "regimeStart": None, "days": out[first_with:], "calendar": [], "champion": None}


# Four-year histories for the outlook coverage check (test_outlook_coverage.py, D52 decision 6). Each history runs
# from FOUR_YEAR_FIRST (to 2028-06-11, where Hanover's researched calendar ends, and on to FOUR_YEAR_LAST) and is cut at
# two or three years; the cut's input carries the 400 days after it, and its run is scored on the guests of the year after it.
FOUR_YEAR_FIRST = pd.Timestamp("2024-06-12")
FOUR_YEAR_LAST = pd.Timestamp("2028-07-15")  # the three-year cut's input reaches here; the same draws for both cuts
FOUR_YEAR_SHAPES = TWO_YEAR_SHAPES + ("level_shift", "trend_change", "hanover")
CHANGE_AFTER_DAYS = 183  # the level shift and the trend change start this many days after the cut: inside its year
LEVEL_SHIFT_UP, LEVEL_SHIFT_DOWN = 1.2, 0.8  # even seeds shift up 20%, odd seeds down 20%
TREND_PER_YEAR = 1.15  # trend_change: 15% a year one way, then 15% a year the other (even seeds up first)
HANOVER_TERM_LIFT = {"fall": 1.3, "winter": 1.15, "spring": 1.25, "summer": 1.05, "interim": 1.0}
HANOVER_EVENT_LIFT = 1.4  # a day with any town event
EVENT_NOTICE_DAYS = 182  # a cut's input knows only the town events that start within this many days of it
HANOVER_CALENDAR = Path(__file__).resolve().parent / "golden" / "hanover-calendar.json"


def hanover_days() -> dict:
    """Hanover's days (term, week of term, event groups) and calendar entries from 2024-06-12 to 2028-07-15, as the API
    builds them (api/test/lab-input.test.ts writes golden/hanover-calendar.json)."""
    return json.loads(HANOVER_CALENDAR.read_text(encoding="utf-8"))


def _withheld(calendar: list[dict], known_until: pd.Timestamp) -> tuple[list[dict], dict[str, set[str]]]:
    """The calendar a cut's input carries (no town event starting after `known_until`), and by date the event groups
    only the withheld entries put there."""
    kept, hidden = [], []
    for entry in calendar:
        (hidden if entry["kind"] == "event" and pd.Timestamp(entry["start"]) > known_until else kept).append(entry)

    def groups(entries: list[dict]) -> dict[str, set[str]]:
        out: dict[str, set[str]] = {}
        for entry in entries:
            if entry["kind"] != "event":
                continue
            for when in pd.date_range(entry["start"], entry["end"]):
                out.setdefault(_iso(when), set()).add(entry["group"] or "one_off")
        return out

    shown = groups(kept)
    return kept, {date: names - shown.get(date, set()) for date, names in groups(hidden).items()}


def four_year_input(seed: int, shape: str, cut_years: int) -> tuple[dict, pd.Series]:
    """The LabInput (version 3) of a four-year history cut at `cut_years` (2 or 3) years, today the day after the cut,
    and every day's guests (the scored year's included), by date.

    Guests as two_year_input makes them: each weekday's level times a yearly season (25% either way) times a weekly
    swing times daily noise (lognormal, sigma 0.12), the swing by shape ("steady" 8% each week, "calm" 4%, "drifting" a
    3% random walk, "growing" steady with 15% more guests a year, "closed_mondays" steady with no Monday row). The other
    shapes are steady with: "level_shift" a 20% shift (up for even seeds, down for odd) from 183 days after the cut;
    "trend_change" 15% a year up then down from 183 days after the cut (down then up for odd seeds); "hanover" Hanover's
    term lifts (HANOVER_TERM_LIFT) and 40% more guests on a day with any town event, with Hanover's days and calendar,
    its termsThrough (the last day of its last term entry), and no town event starting more than 182 days after the cut
    in the input. The others have no calendar and termsThrough null. No champion."""
    if shape not in FOUR_YEAR_SHAPES or cut_years not in (2, 3):
        raise ValueError(shape)
    rng = np.random.default_rng(seed)
    first = FOUR_YEAR_FIRST
    through = first + pd.Timedelta(days=365 * cut_years - 1)  # 730 or 1095 days: through 2026-06-11 or 2027-06-11
    dates = pd.Series(pd.date_range(first, FOUR_YEAR_LAST))
    week = ((dates - first).dt.days // 7).to_numpy()
    weeks = int(week.max()) + 1
    swing = (np.exp(np.cumsum(rng.normal(0.0, 0.03, weeks))) if shape == "drifting"
             else np.exp(rng.normal(0.0, 0.04 if shape == "calm" else 0.08, weeks)))
    season = 1 + 0.25 * np.sin(2 * np.pi * (dates.dt.day_of_year.to_numpy() - 100) / 365.25)
    t = (dates - first).dt.days.to_numpy()
    change = (through - first).days + CHANGE_AFTER_DAYS
    multiplier = np.ones(len(dates))
    if shape == "growing":
        multiplier = 1 + 0.15 * t / 365
    elif shape == "level_shift":
        multiplier = np.where(t >= change, LEVEL_SHIFT_UP if seed % 2 == 0 else LEVEL_SHIFT_DOWN, 1.0)
    elif shape == "trend_change":
        slope = np.log(TREND_PER_YEAR) / 365 * (1 if seed % 2 == 0 else -1)
        multiplier = np.exp(slope * np.minimum(t, change) - slope * np.maximum(t - change, 0))
    town = None
    if shape == "hanover":
        town = hanover_days()
        by_date = {d["date"]: d for d in town["days"]}
        multiplier = np.array([HANOVER_TERM_LIFT[by_date[_iso(day)]["term"]]
                               * (HANOVER_EVENT_LIFT if by_date[_iso(day)]["events"] else 1.0) for day in dates])
    level = dates.dt.day_name().map(TWO_YEAR_LEVEL).to_numpy(dtype=float)
    guests = np.round(level * season * multiplier * swing[week] * rng.lognormal(0.0, 0.12, len(dates)))
    no_row = (dates.dt.day_name() == "Monday") & (shape == "closed_mondays")
    actual = pd.Series(np.where(no_row, np.nan, guests), index=dates.to_numpy())

    calendar, terms_through, hidden = [], None, {}
    if town is not None:
        calendar, hidden = _withheld(town["calendar"], through + pd.Timedelta(days=EVENT_NOTICE_DAYS))
        terms_through = max(e["end"] for e in town["calendar"]
                            if e["kind"] == "term" and re.search(r":(classes|finals):", e["group"] or ""))
        calendar = [e for e in calendar if e["start"] <= _iso(dates.iloc[-1])]
    out = []
    for day, count, missing in zip(dates, guests, no_row):
        if day > through + pd.Timedelta(days=FUTURE_DAYS):
            break
        date = _iso(day)
        known = town is not None and by_date[date]
        out.append({"date": date, "guests": None if missing or day > through else int(count),
                    "term": known["term"] if known else "interim", "weekOfTerm": known["weekOfTerm"] if known else -1,
                    "events": sorted(set(known["events"]) - hidden.get(date, set())) if known else [],
                    "closed": False, "privateEvent": False, "booked": False, "party": False})
    first_with = next(i for i, d in enumerate(out) if d["guests"])
    inp = {"schema": "townwise.lab-input/4", "calibrationId": CALIBRATION_ID, "metric": "guests",
           "today": _iso(through + pd.Timedelta(days=1)), "dataThrough": _iso(through),
           "horizonDays": FUTURE_DAYS, "termsThrough": terms_through, "regimeStart": None,
           "days": out[first_with:], "calendar": calendar, "champion": None}
    return inp, actual
