"""The forecast window as a townwise.forecast-run/1 run file (api/src/forecasts/file.ts): the days after the data cutoff
through the run's end (run_end), with each day's status, 80% range and reasons, and the Monday-to-Sunday weeks wholly
inside them. Ranges past 28 days of lead widen by the backtest's longer-horizon bands (lead_ratios), and past the
forecast tier by the outlook's ratios (D52, outlook_ratio). Both engines' runs are assembled here: the model's by
run_file, the baseline's by baseline.run_file."""

import math
from typing import NamedTuple

import numpy as np
import pandas as pd

from townwise_lab import backtest, metrics, model
from townwise_lab.features import EVENT_PREFIX, FLOOR
from townwise_lab.holidays import holiday_multiplier
from townwise_lab.version import MODEL_VERSION

RUN_SCHEMA = "townwise.forecast-run/1"
HORIZON_DAYS = 400  # the input's future days, and the furthest a run reaches after data_through (D52)
GATE_HORIZON = 28  # the gate's horizon: leads up to it take the range as backtested
FORECAST_DAYS = 91  # the forecast tier reaches the calibration's today plus this many days (D42's whole run)
FORECAST_CAP_DAYS = 182  # and at most this many days after data_through
OUTLOOK_DAYS = 365  # a run whose forecast tier is backed reaches today plus this many days (D52)
OUTLOOK_HORIZONS = (182, 365)  # the outlook's backtested leads
MIN_HORIZON_WEEKS = 8  # backtest weeks a longer horizon needs before the run reaches it
MAX_DAY_GUESTS = 20_000  # the run file's limits: a day's guests, and at most 6 reasons a day
MAX_REASONS = 6
CLOSED_WEEKDAY_DATES = 8  # a weekday served on under MIN_SERVED_DATES of its last 8 counted dates is closed
# One served date in 8 is more often an unnoted private party than a reopening; the cost is that a newly opened
# weekday shows open one week later.
MIN_SERVED_DATES = 2
NEAR_EMPTY_SHARE = 0.1  # a day under this share of its week's median guests was not served (api closed-days.ts's line)
HOLIDAY_FLAGS = ("hol_big_night", "hol_halloween", "hol_closed", "federal_holiday")
ONE_OFF = "one_off"  # an event with no calendar group: its reason names none
STATUS_REASON = {"open": "weekday", "closed": "closure", "booked": "booking"}


def iso(day: pd.Timestamp) -> str:
    return day.strftime("%Y-%m-%d")


def _monday(dates: pd.Series) -> pd.Series:
    return dates - pd.to_timedelta(dates.dt.day_of_week, unit="D")


def bounded(lo: pd.Series, mid: pd.Series, hi: pd.Series) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Daily quantile forecasts as a run's days need them: the median at least FLOOR guests (a quantile regression can
    fall to zero or below on a quiet day) and the 10th and 90th percentiles on either side of it (three separate fits
    can cross). Identity on ordinary days."""
    mid = mid.clip(lower=FLOOR)
    return lo.clip(lower=0).clip(upper=mid), mid, hi.clip(lower=mid)


def backtest_predictions(frame: pd.DataFrame, hist: pd.DataFrame, origins: list[pd.Timestamp], end: pd.Timestamp,
                         base_cols: list[str], event_cols: list[str]) -> pd.DataFrame:
    """The lab's rolling backtest: backtest.rolling_predictions with holiday multipliers, its ranges bounded as a run's
    days are, so every weekly ratio is finite."""
    preds = backtest.rolling_predictions(frame, hist, origins, end, base_cols, event_cols, holidays=True)
    lo, mid, hi = bounded(preds.lo, preds.mid, preds.hi)
    return preds.assign(lo=lo, mid=mid, hi=hi)


def set_aside(frame: pd.DataFrame) -> pd.Series:
    """The days that say nothing about a weekday's regular service: a private event, a counted party (`party`, read
    only when the frame has it) or a booking. closed_weekdays counts them as neither served nor unserved (D70)."""
    out = frame.private_event.eq(1) | frame.booked.astype(bool)
    if "party" in frame:
        out |= frame.party.astype(bool)
    return out


def served(frame: pd.DataFrame) -> pd.Series:
    """Whether each day was open to the public: guests at least a tenth of the median guests over its week's days with
    guests, and not set aside (a private event, a counted party or booked). A day closed to the public can still ring a
    private party as one check with a guest or two, or as a full room, and neither says anything about the weekday's
    regular service."""
    typical = frame.guests.where(frame.guests.gt(0)).groupby(_monday(frame.date)).transform("median")
    return frame.guests.gt(0) & frame.guests.ge(NEAR_EMPTY_SHARE * typical) & ~set_aside(frame)


def closed_weekdays(frame: pd.DataFrame, through: pd.Timestamp) -> set[str]:
    """Weekdays served (see served) on at most one of their last 8 counted dates. A counted date is on or before
    `through`, in a complete week (the week holding `through` only when `through` is its Sunday: a partial week's median
    can fall to a few guests), in a week served on another day (a week closed throughout says nothing about one
    weekday) and not set aside (set_aside, D70: a private event or party is neither served nor unserved, so a party
    every Friday never closes Fridays and parties on a closed Monday never reopen it). A weekday with fewer than
    MIN_SERVED_DATES counted dates stays open."""
    last_sunday = through - pd.Timedelta(days=(through.day_of_week + 1) % 7)
    past = frame[frame.date <= last_sunday]
    had = served(past).astype(int)
    counted = ((had.groupby(_monday(past.date)).transform("sum") - had) > 0) & ~set_aside(past)
    recent = had[counted].groupby(past.weekday[counted]).tail(CLOSED_WEEKDAY_DATES)
    return {name for name, values in recent.groupby(past.weekday[recent.index])
            if len(values) >= MIN_SERVED_DATES and values.sum() < MIN_SERVED_DATES}


def private_on_closed_weekday(frame: pd.DataFrame) -> pd.Series:
    """D70: whether each day with guests is a private event or a counted party (`party`, when the frame has it) on a
    weekday closed (closed_weekdays) as judged from the complete weeks before the day's week. Such a day opened only for
    the event: its guests are the party's or its leftovers, not the weekday's service, so training leaves it out
    (features.training_rows). The weeks before the day's are all it reads, so a day's flag is the same at every cutoff
    after it and every backtest trains on the same days. A private day on an open weekday is not flagged."""
    private = frame.private_event.eq(1)
    if "party" in frame:
        private |= frame.party.astype(bool)
    private &= frame.guests.gt(0)  # only a day with guests could train
    mondays = _monday(frame.date)
    out = pd.Series(False, index=frame.index)
    for monday in sorted(set(mondays[private])):
        closed = closed_weekdays(frame, monday - pd.Timedelta(days=1))
        out |= private & mondays.eq(monday) & frame.weekday.isin(closed)
    return out


def _holiday_key(day: pd.Timestamp) -> tuple[int, ...]:
    # Thanksgiving moves, and it is the only closing holiday in November; the others fall on fixed dates
    return (11,) if day.month == 11 else (day.month, day.day)


def closed_holidays(frame: pd.DataFrame, through: pd.Timestamp) -> set[tuple[int, ...]]:
    """The closing holidays (hol_closed) whose most recent occurrence on or before `through` had no guests."""
    past = frame[(frame.date <= through) & frame.hol_closed.eq(1)]
    last = {_holiday_key(day): guests > 0 for day, guests in zip(past.date, past.guests)}  # dates ascend: latest wins
    return {key for key, had in last.items() if not had}


def statuses(frame: pd.DataFrame, through: pd.Timestamp) -> pd.Series:
    """For each row of `frame` after `through`: booked when booked; closed with a closure note, on a closing holiday
    whose last occurrence had no guests, or on a weekday closed_weekdays finds; open otherwise."""
    rows = frame[frame.date > through]
    holidays = closed_holidays(frame, through)
    on_closed_holiday = np.array([flag == 1 and _holiday_key(day) in holidays
                                  for day, flag in zip(rows.date, rows.hol_closed)], dtype=bool)
    closed = rows.closed.astype(bool) | rows.weekday.isin(closed_weekdays(frame, through)) | on_closed_holiday
    return pd.Series(np.select([rows.booked.astype(bool), closed], ["booked", "closed"], "open"), index=rows.index,
                     dtype=object)


def reasons(status: str, term: str, holiday: bool, groups: list[str]) -> list[dict]:
    """In order: the status's own reason, the term (not between terms), a holiday, then one per event group (no ref for
    an event with no group); at most 6. Townwise words each one in code; effects are not estimated per reason."""
    kinds = [(STATUS_REASON[status], None)]
    if term != "interim":
        kinds.append(("term", None))
    if holiday:
        kinds.append(("holiday", None))
    kinds += [("event", None if group == ONE_OFF else group) for group in groups]
    return [{"kind": kind, "ref": ref, "effectPct": None} for kind, ref in kinds[:MAX_REASONS]]


def forecast_end(today: pd.Timestamp, data_through: pd.Timestamp) -> pd.Timestamp:
    """The forecast tier's last day (D52): today + 91, at most data_through + 182, where a D42 run made today would have
    ended (api/src/forecasts/tiers.ts tierEnd, with madeAt the calibration's today). Later days are the outlook."""
    return min(today + pd.Timedelta(days=FORECAST_DAYS), data_through + pd.Timedelta(days=FORECAST_CAP_DAYS))


def run_end(today: pd.Timestamp, data_through: pd.Timestamp, weeks91: int, weeks_reach: int | None,
            terms_through: pd.Timestamp | None = None) -> pd.Timestamp:
    """The run's last day. Where a horizon of the forecast tier has fewer than 8 backtest weeks, D42's stops: 28 days of
    lead without 91-day evidence, 91 without the reach's (only asked for when the tier ends more than 91 days after
    data_through), and no outlook. Otherwise today + 365, at most data_through + 400 (D52), and for a model run
    (`terms_through`, the town's last researched term day, when it has one) no later than the later of the forecast
    tier's end and terms_through, so the tier is never cut."""
    end = forecast_end(today, data_through)
    if weeks91 < MIN_HORIZON_WEEKS:
        return min(end, data_through + pd.Timedelta(days=GATE_HORIZON))
    if (end - data_through).days > FORECAST_DAYS and (weeks_reach or 0) < MIN_HORIZON_WEEKS:
        return data_through + pd.Timedelta(days=FORECAST_DAYS)
    outlook_end = min(today + pd.Timedelta(days=OUTLOOK_DAYS), data_through + pd.Timedelta(days=HORIZON_DAYS))
    if terms_through is not None:
        outlook_end = min(outlook_end, max(end, terms_through))
    return outlook_end


def reach_horizon(today: pd.Timestamp, data_through: pd.Timestamp) -> int | None:
    """The forecast tier's longest lead in whole weeks when it is beyond 91 days (sales lag), else None."""
    longest = (forecast_end(today, data_through) - data_through).days
    return 7 * -(-longest // 7) if longest > FORECAST_DAYS else None


class Outlook(NamedTuple):
    """The outlook's ranges (D52 decision 5): the forecast tier's last day, and the ratios at 182 and 365 days of lead."""
    tier_end: pd.Timestamp
    r182: float
    r365: float


def outlook_ratio(lead: int, r182: float, r365: float) -> float:
    """An outlook day's ratio by its lead: r182 up to 182 days, then interpolated on the square root of lead to r365 at
    365 (r182 * sqrt(lead / 182) when r365 is that growth), then r365 * sqrt(lead / 365)."""
    if lead <= OUTLOOK_HORIZONS[0]:
        return r182
    if lead <= OUTLOOK_HORIZONS[1]:
        low, high = math.sqrt(OUTLOOK_HORIZONS[0]), math.sqrt(OUTLOOK_HORIZONS[1])
        return r182 + (r365 - r182) * (math.sqrt(lead) - low) / (high - low)
    return r365 * math.sqrt(lead / OUTLOOK_HORIZONS[1])


def lead_ratios(dates: pd.Series, data_through: pd.Timestamp, widening: list[tuple[int, float]],
                outlook: Outlook | None = None) -> pd.Series:
    """How much each date's range widens for its lead (days after data_through): 1 up to 28 days, then from each
    (first lead, ratio) of `widening` on, in order; a date after the forecast tier (`outlook`) by outlook_ratio."""
    leads = (dates - data_through).dt.days
    ratio = pd.Series(1.0, index=dates.index)
    for first, value in widening:
        ratio[leads >= first] = value
    if outlook is not None:
        past = dates > outlook.tier_end
        ratio[past] = [outlook_ratio(int(lead), outlook.r182, outlook.r365) for lead in leads[past]]
    return ratio


def window(frame: pd.DataFrame, data_through: pd.Timestamp, end: pd.Timestamp) -> tuple[pd.DataFrame, pd.Series]:
    """The rows of `frame` after data_through through `end`, and their statuses."""
    status = statuses(frame, data_through)
    status = status[(frame.date[status.index] <= end).to_numpy()]
    return frame.loc[status.index], status


def assemble(rows: pd.DataFrame, status: pd.Series, numbers: pd.DataFrame, weekly_log_range: dict[str, float],
             ratio: pd.Series, effect_pct=None, tier_end: pd.Timestamp | None = None) -> tuple[list[dict], list[dict]]:
    """A run's days and weeks. `numbers` has low, mid, high and baseline for the open rows; `effect_pct(index, reason)`,
    when given, sets an open day's reason's effectPct. Each week is a Monday-to-Sunday span wholly inside the rows: the
    sum of its open days' forecasts, and the weekly log range around it, widened by its first day's ratio. A week with
    a day after the forecast tier's last day (`tier_end`, an outlook week) is widened by the largest of its days'
    ratios instead, and is the same on both sides: the weekly log range's wider side, so a range that held only one
    way at 28 days is not carried one way a year out (D52, pipeline.outlook_ratios)."""
    table = rows[["date"]].assign(status=status).join(numbers)
    groups = [c for c in rows.columns if c.startswith(EVENT_PREFIX)]
    holiday = rows[list(HOLIDAY_FLAGS)].eq(1).any(axis=1)
    days = []
    for (index, row), (_, source) in zip(table.iterrows(), rows.iterrows()):
        is_open = row.status == "open"
        why = reasons(row.status, source.term, bool(holiday[index]),
                      [g.removeprefix(EVENT_PREFIX) for g in groups if source[g] == 1])
        if is_open and effect_pct is not None:
            why = [reason | {"effectPct": effect_pct(index, reason)} for reason in why]
        days.append({
            "date": iso(row.date), "status": str(row.status),
            **{key: float(row[key]) if is_open else None for key in ("low", "mid", "high", "baseline")},
            "reasons": why,
        })

    weeks = []
    for monday, week in table.groupby(_monday(table.date)):
        if len(week) < 7:  # a week only partly inside the run has no week row
            continue
        in_outlook = tier_end is not None and week.date.max() > tier_end
        widened = float(ratio[week.index].max() if in_outlook else ratio[week.index[0]])
        lo_side, hi_side = weekly_log_range["lo"], weekly_log_range["hi"]
        if in_outlook:
            hi_side = max(-lo_side, hi_side)
            lo_side = -hi_side
        lo_factor, hi_factor = np.exp(lo_side * widened), np.exp(hi_side * widened)
        total = float(week.mid.sum())  # open days only: the others have no number
        weeks.append({"from": iso(monday), "to": iso(week.date.max()),
                      "openDays": int((week.status == "open").sum()), "low": float(total * lo_factor), "mid": total,
                      "high": float(min(total * hi_factor, 7 * MAX_DAY_GUESTS))})
    return days, weeks


def run_document(family: str, *, trained_from: pd.Timestamp, data_through: pd.Timestamp, made_at: str,
                 code_version: str, backtest_block: dict | None, days: list[dict], weeks: list[dict]) -> dict:
    return {
        "schema": RUN_SCHEMA,
        "metric": "guests",
        "model": {"family": family, "version": MODEL_VERSION, "notebookCommit": code_version},
        "trainingSource": "townwise_lab",
        "trainedFrom": iso(trained_from),
        "dataThrough": iso(data_through),
        "madeAt": made_at,
        "frozen": None,
        "interval": {"level": 0.8, "widened": True},
        "backtest": backtest_block,
        "days": days,
        "weeks": weeks,
    }


def run_file(frame: pd.DataFrame, fit: model.HybridFit, effects: dict[str, float], widen_k: float,
             weekly_log_range: dict[str, float], *, trained_from: pd.Timestamp, data_through: pd.Timestamp,
             end: pd.Timestamp, widening: list[tuple[int, float]], made_at: str, code_version: str,
             backtest_block: dict | None, outlook: Outlook | None = None) -> dict:
    """The model's run file for the days of `frame` (the frame `fit` was made on) after `data_through` through `end`.

    Open days: the hybrid's quantiles times the holiday multipliers, bounded, the range widened by widen_k (section
    9e) times the day's lead ratio (`outlook` past the forecast tier); baseline is the linear median baseline alone. Closed and booked days carry no
    number. Weeks as assemble makes them."""
    rows, status = window(frame, data_through, end)
    open_rows = rows[status == "open"]
    quantiles = model.hybrid_predict(fit, open_rows)
    multiplier = holiday_multiplier(open_rows, effects)
    lo, mid, hi = bounded(quantiles[0.1] * multiplier, quantiles[0.5] * multiplier, quantiles[0.9] * multiplier)
    ratio = lead_ratios(rows.date, data_through, widening, outlook)
    lo, hi = metrics.widen(mid, lo, hi, widen_k * ratio[open_rows.index])
    linear, X = fit.base[0.5]
    baseline = pd.Series(linear.predict(X.loc[open_rows.index]), index=open_rows.index)
    numbers = pd.DataFrame({"low": lo, "mid": mid, "high": hi, "baseline": baseline}).clip(lower=0,
                                                                                         upper=MAX_DAY_GUESTS)
    days, weeks = assemble(rows, status, numbers, weekly_log_range, ratio,
                           tier_end=None if outlook is None else outlook.tier_end)
    return run_document("hybrid_linear_xgboost", trained_from=trained_from, data_through=data_through,
                        made_at=made_at, code_version=code_version, backtest_block=backtest_block, days=days,
                        weeks=weeks)
