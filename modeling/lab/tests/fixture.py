"""A synthetic restaurant history for the lab's tests. It reads no file and holds no real restaurant's figure.

synthetic_frame(seed) is the frame the lab builds from a LabInput (date, weekday, guests, term, week_of_term, one
ev_<group> column per town event group, private_event, closed, booked and the holiday flags), plus the notebook's own
column names for the same facts (is_2026, football_home) and two show flags only the notebook has, so one frame feeds
both the lab and the notebook's functions in the parity tests. synthetic_input(seed) is the same history as the
LabInput the API sends, with synthetic_calendar as its town calendar and synthetic_champion as the current published
run.
"""

import numpy as np
import pandas as pd
from pandas.tseries.holiday import USFederalHolidayCalendar

FIRST_DAY = pd.Timestamp("2024-01-01")
DATA_THROUGH = pd.Timestamp("2025-10-21")
FUTURE_DAYS = 182
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
    # The notebook's holiday rules (section 1, cell 6), copied here so the lab's holiday_flags is checked against them
    federal = USFederalHolidayCalendar().holidays(dates.min(), dates.max(), return_name=True)
    thanksgiving = federal[federal == "Thanksgiving Day"].index
    years = range(dates.min().year, dates.max().year + 1)
    big_night = list(thanksgiving - pd.Timedelta(days=1)) + [pd.Timestamp(y, 12, d) for y in years for d in (23, 31)]
    closed = list(thanksgiving) + [pd.Timestamp(y, m, d) for y in years
                                   for m, d in ((1, 1), (7, 4), (12, 24), (12, 25))]
    return pd.DataFrame({
        "hol_big_night": dates.isin(big_night).astype(int),
        "hol_halloween": ((dates.dt.month == 10) & (dates.dt.day == 31)).astype(int),
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
    booked. Weeks run Monday to Sunday, clipped to its days."""
    past = frame[(frame.date <= through) & frame.guests.gt(0) & ~frame.closed & ~frame.booked]
    median = past.groupby("weekday").guests.median()
    rows = frame[(frame.date > through) & (frame.date <= through + pd.Timedelta(days=FUTURE_DAYS))]
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
    return {"runId": CHAMPION_RUN_ID, "engine": "model", "dataThrough": _iso(through), "days": days, "weeks": weeks}


def synthetic_input(seed: int = 0) -> dict:
    """synthetic_frame(seed) as the LabInput the API sends: every date from the first day with guests to the data
    cutoff plus 182 days, no regime start, synthetic_calendar over those days, and synthetic_champion (a model run) as
    the current published run."""
    f = synthetic_frame(seed)
    has = f.guests.gt(0)
    first, through = f.date[has].min(), f.date[has].max()
    rows = f[(f.date >= first) & (f.date <= through + pd.Timedelta(days=FUTURE_DAYS))]
    groups = [c for c in rows.columns if c.startswith("ev_")]
    days = [{"date": _iso(row.date), "guests": None if np.isnan(row.guests) else int(row.guests), "term": row.term,
             "weekOfTerm": int(row.week_of_term),
             "events": sorted(c.removeprefix("ev_") for c in groups if row[c] == 1),
             "closed": bool(row.closed), "privateEvent": bool(row.private_event), "booked": bool(row.booked)}
            for _, row in rows.iterrows()]
    return {"schema": "townwise.lab-input/2", "calibrationId": CALIBRATION_ID, "metric": "guests", "today": _iso(TODAY),
            "dataThrough": _iso(through), "horizonDays": FUTURE_DAYS, "regimeStart": None, "days": days,
            "calendar": synthetic_calendar(rows), "champion": synthetic_champion(f)}
