"""Export a frozen guest forecast as a Townwise forecast run file (townwise.forecast-run/1).

Reads a frozen daily and weekly guest CSV pair, plus the daily file that records term and event codes for the same
dates, from forecasts/ (it never writes there), checks each file's sha256 against the value you pass (the forecasts
README lists them), and writes outputs/forecast-run-{version}-{first day}.json. outputs/ is gitignored: never commit
the file. Staff import it in the Townwise staff console, where it lands as a draft, and publish it there once checked
(docs/portal/estimates.md, infra/README.md "Forecasts").

The run file holds outputs only: each day's status and 80% range, reason kinds and calendar refs, the week rows, and
the model's metadata. It never holds a name, a note, a closure reason's text or any other free text, and Townwise makes
every label in code, so nothing from the partner's exports can reach an owner or Anthropic through a forecast. The
backtest figures are typed in from the forecasts README, not computed here. This script prints file names and counts,
never a forecast figure.

Standard library only. From modeling/:

    uv run python export_forecast_run.py \\
      --daily forecasts/<v3 guests daily>.csv --daily-sha256 <from the README> \\
      --weekly forecasts/<v3 guests weekly>.csv --weekly-sha256 <from the README> \\
      --events forecasts/<v1 daily>.csv --events-sha256 <from the README> \\
      --version v3 --family hybrid_linear_xgboost --notebook-commit <commit of modeling/> \\
      --trained-from YYYY-MM-DD --data-through YYYY-MM-DD --made-at YYYY-MM-DD \\
      --town-id hanover-nh --booked YYYY-MM-DD --widened \\
      --backtest-from YYYY-MM-DD --backtest-to YYYY-MM-DD --backtest-weeks N \\
      --weekly-typical-error-pct X --weeks-over-20-pct N --weekly-range-below X --weekly-range-above X
"""

import argparse
import csv
import datetime
import hashlib
import json
import math
import re
import sys
from pathlib import Path

SCHEMA = "townwise.forecast-run/1"
HERE = Path(__file__).resolve().parent
OUTPUTS = HERE / "outputs"
FORECASTS = HERE / "forecasts"
FAMILIES = ("hybrid_linear_xgboost", "linear_median", "weekday_median")
FROZEN_NAME = re.compile(r"^frozen_forecast_[a-z0-9_.-]{1,80}\.csv$")
TOWN_ID = re.compile(r"^[a-z0-9-]{1,40}$")

DAILY_COLUMNS = {"date", "expected_open", "holiday", "guests_forecast", "guests_lo80", "guests_hi80"}
WEEKLY_COLUMNS = {"week", "days_in_forecast", "open_days", "guests_forecast", "guests_lo80", "guests_hi80"}
EVENTS_COLUMNS = {"date", "term", "events"}
# Event codes in the daily file, and the reason each becomes. A code not listed here stops the export.
EVENT_REASONS = {"football_home": "event", "private_event": "booking"}
# The calendar group a code names, so Townwise labels it from the public town calendar (spec 13.1).
EVENT_GROUPS = {"football_home": "home-football"}


def fail(message):
    print(f"export_forecast_run: {message}", file=sys.stderr)
    sys.exit(1)


def day(value, flag):
    try:
        return datetime.date.fromisoformat(value).isoformat()
    except ValueError:
        fail(f"{flag} is not a YYYY-MM-DD date")


def read_checked(path_text, expected, flag):
    """The CSV's rows, after its sha256 matches. Only frozen files under forecasts/ are read."""
    path = Path(path_text).resolve()
    if path.parent != FORECASTS or not FROZEN_NAME.match(path.name):
        fail(f"{flag} must be a frozen_forecast_*.csv file in modeling/forecasts/")
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        fail(f"{flag}-sha256 must be 64 lowercase hex characters")
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != expected:
        fail(f"{path.name} does not match {flag}-sha256; check the forecasts README")
    rows = list(csv.DictReader(data.decode("utf-8").splitlines()))
    return path.name, rows


def need_columns(rows, columns, name):
    if not rows:
        fail(f"{name} has no rows")
    missing = columns - set(rows[0].keys())
    if missing:
        fail(f"{name} lacks the columns {', '.join(sorted(missing))}")


def number(value, where):
    try:
        result = float(value)
    except ValueError:
        fail(f"{where} has a value that is not a number")
    # float() accepts "nan" and "inf", which json.dumps would write as invalid JSON, and guests can't be negative.
    if not math.isfinite(result) or result < 0:
        fail(f"{where} is not a finite, non-negative number")
    return result


def days_of(daily, events_by_date, booked, town_id):
    out = []
    for row in daily:
        date = day(row["date"], "a daily row's date")
        codes = [code for code in re.split(r"[;,| ]+", events_by_date.get(date, {}).get("events", "")) if code]
        unknown = [code for code in codes if code not in EVENT_REASONS]
        if unknown:
            fail(f"the events file has an event code this script doesn't map on {date}")
        if date in booked and "private_event" not in codes:
            fail(f"--booked {date} is not a private event day in the events file")
        if date in booked:
            status = "booked"
        elif row["expected_open"] == "False":
            status = "closed"
        elif row["expected_open"] == "True":
            status = "open"
        else:
            fail(f"the daily file's expected_open on {date} is neither True nor False")
        reasons = []
        if status == "open":
            reasons.append({"kind": "weekday", "ref": None, "effectPct": None})
        if status == "closed":
            reasons.append({"kind": "closure", "ref": None, "effectPct": None})
        if events_by_date.get(date, {}).get("term", "") != "":
            # Townwise names the term from the town calendar's term state on the day.
            reasons.append({"kind": "term", "ref": None, "effectPct": None})
        if row["holiday"] != "":
            # Townwise names a federal holiday on the day; any other holiday reads "Holiday".
            reasons.append({"kind": "holiday", "ref": None, "effectPct": None})
        for code in codes:
            group = EVENT_GROUPS.get(code)
            reasons.append({"kind": EVENT_REASONS[code], "ref": None if group is None else f"{town_id}:{group}", "effectPct": None})
        numbers = {"low": None, "mid": None, "high": None}
        if status == "open":
            numbers = {
                "low": number(row["guests_lo80"], f"guests_lo80 on {date}"),
                "mid": number(row["guests_forecast"], f"guests_forecast on {date}"),
                "high": number(row["guests_hi80"], f"guests_hi80 on {date}"),
            }
        out.append({"date": date, "status": status, **numbers, "baseline": None, "reasons": reasons[:6]})
    return out


def weeks_of(weekly, first, last):
    out = []
    for row in weekly:
        start, _, end = row["week"].partition("/")
        start, end = day(start, "a week's start"), day(end, "a week's end")
        start, end = max(start, first), min(end, last)
        span = (datetime.date.fromisoformat(end) - datetime.date.fromisoformat(start)).days + 1
        if str(span) != row["days_in_forecast"]:
            fail(f"the week from {start} has days_in_forecast that doesn't match its dates")
        out.append({
            "from": start, "to": end, "openDays": int(row["open_days"]),
            "low": number(row["guests_lo80"], f"the week from {start}"),
            "mid": number(row["guests_forecast"], f"the week from {start}"),
            "high": number(row["guests_hi80"], f"the week from {start}"),
        })
    return out


def backtest_of(args):
    flags = (args.backtest_from, args.backtest_to, args.backtest_weeks, args.weekly_typical_error_pct, args.weeks_over_20_pct)
    if all(flag is None for flag in flags):
        return None
    if any(flag is None for flag in flags):
        fail("give every --backtest-* flag, or none")
    ranges = (args.weekly_range_below, args.weekly_range_above)
    if (ranges[0] is None) != (ranges[1] is None):
        fail("give both --weekly-range-below and --weekly-range-above, or neither")
    return {
        "from": day(args.backtest_from, "--backtest-from"), "to": day(args.backtest_to, "--backtest-to"),
        "weeks": args.backtest_weeks, "weeklyTypicalErrorPct": args.weekly_typical_error_pct,
        "weeksOver20Pct": args.weeks_over_20_pct,
        "weeklyRangePct": None if ranges[0] is None else {"below": ranges[0], "above": ranges[1]},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    for name in ("daily", "weekly", "events"):
        parser.add_argument(f"--{name}", required=True)
        parser.add_argument(f"--{name}-sha256", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--family", required=True, choices=FAMILIES)
    parser.add_argument("--notebook-commit", required=True)
    parser.add_argument("--trained-from", required=True)
    parser.add_argument("--data-through", required=True)
    parser.add_argument("--made-at", required=True)
    parser.add_argument("--town-id", required=True)
    parser.add_argument("--booked", action="append", default=[], help="a full private buyout day (the booking rule); repeat")
    parser.add_argument("--widened", action="store_true", help="the 80%% ranges were widened after backtests")
    parser.add_argument("--backtest-from")
    parser.add_argument("--backtest-to")
    parser.add_argument("--backtest-weeks", type=int)
    parser.add_argument("--weekly-typical-error-pct", type=float)
    parser.add_argument("--weeks-over-20-pct", type=int)
    parser.add_argument("--weekly-range-below", type=float)
    parser.add_argument("--weekly-range-above", type=float)
    args = parser.parse_args()

    if not re.fullmatch(r"v[0-9]{1,3}", args.version):
        fail("--version looks like v3")
    if not re.fullmatch(r"[0-9a-f]{7,40}", args.notebook_commit):
        fail("--notebook-commit is a git commit hash")
    if not TOWN_ID.match(args.town_id):
        fail("--town-id looks like hanover-nh")
    booked = {day(date, "--booked") for date in args.booked}

    daily_name, daily = read_checked(args.daily, args.daily_sha256, "--daily")
    weekly_name, weekly = read_checked(args.weekly, args.weekly_sha256, "--weekly")
    events_name, events = read_checked(args.events, args.events_sha256, "--events")
    need_columns(daily, DAILY_COLUMNS, daily_name)
    need_columns(weekly, WEEKLY_COLUMNS, weekly_name)
    need_columns(events, EVENTS_COLUMNS, events_name)
    events_by_date = {row["date"]: row for row in events}
    if set(events_by_date) != {row["date"] for row in daily}:
        fail(f"{events_name} and {daily_name} cover different dates")

    days = days_of(daily, events_by_date, booked, args.town_id)
    dates = sorted(row["date"] for row in days)
    run = {
        "schema": SCHEMA,
        "metric": "guests",
        "model": {"family": args.family, "version": args.version, "notebookCommit": args.notebook_commit},
        "trainingSource": "files_from_owner",
        "trainedFrom": day(args.trained_from, "--trained-from"),
        "dataThrough": day(args.data_through, "--data-through"),
        "madeAt": day(args.made_at, "--made-at"),
        "frozen": {"files": [
            {"name": name, "sha256": sha} for name, sha in
            ((daily_name, args.daily_sha256), (weekly_name, args.weekly_sha256), (events_name, args.events_sha256))
        ]},
        "interval": {"level": 0.8, "widened": args.widened},
        "backtest": backtest_of(args),
        "days": days,
        "weeks": weeks_of(weekly, dates[0], dates[-1]),
    }
    OUTPUTS.mkdir(exist_ok=True)
    out = OUTPUTS / f"forecast-run-{args.version}-{dates[0]}.json"
    out.write_text(json.dumps(run, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out.relative_to(HERE)}: {len(run['days'])} days, {len(run['weeks'])} weeks (gitignored; never commit it)")


if __name__ == "__main__":
    main()
