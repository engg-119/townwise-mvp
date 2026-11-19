"""The outlook's coverage check (D52 decision 6): do a year-long run's outlook ranges hold the guests of the year after
its cut? Release B ships only if this passes, and it is built to be able to fail: the same check on runs whose outlook
carries the forecast tier's last ratio flat (the obvious naive outlook, no outlook widening) must fail it at every cut
and horizon, which the last test asserts.

Set on 2026-11-17, before anything was measured, and not tuned after:

- Histories (fixture.four_year_input): the five weekly swings of test_coverage.py ("steady", "calm", "drifting",
  "growing", "closed_mondays"), a 20% level shift and a trend that changes slope (both starting 183 days after the
  cut, inside the scored year), and Hanover's days and calendar with term and event lifts in the guests; seeds 0 to 3
  of each, 32 histories, four years from 2024-06-12.
- Cuts: each history calibrated as of two years (730 days, data through 2026-06-11) and three years (1095 days, through
  2027-06-11), today the day after, and its run scored on the guests of the days it covers. The Hanover inputs carry
  no town event that starts more than 182 days after the cut, while the scored guests were made with every event, so
  the outlook is scored as one made before the town announced them. Terms (researched years ahead, and the model's
  outlook stops at the last researched one) and federal holidays stay.
- Outlook days are those after the run's forecast tier (forecast.forecast_end, today plus 91 here). Horizon 182 holds
  the outlook's days with a lead of at most 182 days after the cut, horizon 365 the later ones; a week (Monday to
  Sunday, wholly in the run) with any outlook day counts at the horizon of its last day. A week is inside when the sum
  of its open days' guests is within its low to high, a day when its guests are within its low to high (open days
  with guests only).
- Pass, per horizon and per cut (not pooled): the mean over histories of the share of weeks inside at least 80% and no
  history under 65%; the mean of the share of days inside at least 75%. Every history's run must have outlook weeks at
  both horizons, so the check cannot pass on runs with no outlook.

The control reuses each calibration: forecast.run_file and baseline.run_file are run a second time with
forecast.lead_ratios given no outlook, so every outlook day takes the forecast tier's last ratio (91 days, or the
reach), which is the run the same calibration would publish if the outlook only carried the tier's ranges on. Outlook
weeks stay the same on both sides in the control, so it isolates the ratio. (Until 2026-11-19 the control forced every
outlook ratio to 1, narrower than the tier's own last days: a strawman that any widening would beat.)
Synthetic data only. Calibrates 64 histories (several minutes)."""

import numpy as np
import pandas as pd
import pytest
from fixture import FOUR_YEAR_SHAPES, four_year_input

from townwise_lab import baseline, forecast, pipeline

SEEDS = (0, 1, 2, 3)
CUTS = (2, 3)
HORIZONS = (182, 365)
WEEKLY_MEAN_MIN, WEEKLY_HISTORY_MIN, DAILY_MEAN_MIN = 0.80, 0.65, 0.75


LEAD_RATIOS = forecast.lead_ratios


def _flat(dates, data_through, widening, outlook=None):
    """forecast.lead_ratios with the forecast tier's last ratio carried flat over the outlook's days."""
    return LEAD_RATIOS(dates, data_through, widening)


def _twice(original, controls: list):
    """A run_file that returns its run and keeps, in `controls`, the run it makes with the tier's ratio held flat."""
    def run_file(*args, **kwargs):
        honest = original(*args, **kwargs)
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(forecast, "lead_ratios", _flat)
            controls.append(original(*args, **kwargs))
        return honest
    return run_file


def coverage(run: dict, actual: pd.Series, through: pd.Timestamp, tier_end: pd.Timestamp) -> dict:
    """Per horizon: [weeks inside, weeks, days inside, days] of the run's outlook (the module's rules)."""
    out = {h: [0, 0, 0, 0] for h in HORIZONS}

    def horizon_of(day: pd.Timestamp) -> int:
        return 182 if (day - through).days <= 182 else 365

    days = {pd.Timestamp(d["date"]): d for d in run["days"]}
    for when, d in days.items():
        guests = actual.get(when)
        if when <= tier_end or d["status"] != "open" or guests is None or np.isnan(guests):
            continue
        cell = out[horizon_of(when)]
        cell[2] += int(d["low"] <= guests <= d["high"])
        cell[3] += 1
    for w in run["weeks"]:
        start, end = pd.Timestamp(w["from"]), pd.Timestamp(w["to"])
        if end <= tier_end:
            continue
        total = sum(float(actual[when]) for when in pd.date_range(start, end)
                    if days[when]["status"] == "open" and not np.isnan(actual[when]))
        cell = out[horizon_of(end)]
        cell[0] += int(w["low"] <= total <= w["high"])
        cell[1] += 1
    return out


@pytest.fixture(scope="module")
def scored() -> list[dict]:
    """For every history and cut: its engine and the honest and control runs' coverage."""
    rows = []
    for shape in FOUR_YEAR_SHAPES:
        for seed in SEEDS:
            for cut in CUTS:
                inp, actual = four_year_input(seed, shape, cut)
                controls: list[dict] = []
                with pytest.MonkeyPatch.context() as patch:
                    patch.setattr(forecast, "run_file", _twice(forecast.run_file, controls))
                    patch.setattr(baseline, "run_file", _twice(baseline.run_file, controls))
                    result = pipeline.calibrate(inp, "0" * 40)
                assert result["ok"], (shape, seed, cut, result.get("code"))
                through, today = pd.Timestamp(inp["dataThrough"]), pd.Timestamp(inp["today"])
                tier_end = forecast.forecast_end(today, through)
                [control] = controls
                rows.append({"shape": shape, "seed": seed, "cut": cut, "engine": result["scorecard"]["engine"],
                             "honest": coverage(result["run"], actual, through, tier_end),
                             "control": coverage(control, actual, through, tier_end)})
    return rows


def verdicts(rows: list[dict], which: str) -> dict[tuple[int, int], dict]:
    """Per (cut, horizon): the mean and lowest weekly share, the mean daily share and whether each threshold holds."""
    out = {}
    for cut in CUTS:
        for horizon in HORIZONS:
            cells = [row[which][horizon] for row in rows if row["cut"] == cut]
            weekly = [inside / weeks for inside, weeks, _, _ in cells]
            daily = [inside / days for _, _, inside, days in cells]
            out[(cut, horizon)] = {
                "weekly_mean": float(np.mean(weekly)), "weekly_min": float(np.min(weekly)),
                "daily_mean": float(np.mean(daily)),
                "passes": (np.mean(weekly) >= WEEKLY_MEAN_MIN and np.min(weekly) >= WEEKLY_HISTORY_MIN
                           and np.mean(daily) >= DAILY_MEAN_MIN)}
    return out


def report(rows: list[dict], which: str) -> str:
    lines = []
    for row in rows:
        cells = "; ".join(f"{h}: {c[0]}/{c[1]} weeks, {c[2]}/{c[3]} days" for h, c in row[which].items())
        lines.append(f"{which} {row['shape']} seed {row['seed']} cut {row['cut']}y ({row['engine']}): {cells}")
    for (cut, horizon), v in verdicts(rows, which).items():
        lines.append(f"{which} cut {cut}y horizon {horizon}: weekly mean {v['weekly_mean']:.1%}, lowest "
                     f"{v['weekly_min']:.1%}, daily mean {v['daily_mean']:.1%}: {'pass' if v['passes'] else 'FAIL'}")
    return "\n".join(lines)


def test_every_history_has_an_outlook_at_both_horizons(scored):
    for row in scored:
        for horizon in HORIZONS:
            assert row["honest"][horizon][1] > 0 and row["honest"][horizon][3] > 0, (row["shape"], row["seed"],
                                                                                    row["cut"], horizon)


def test_the_outlook_ranges_hold_the_year_after_each_cut(scored, capsys):
    with capsys.disabled():
        print("\n" + report(scored, "honest"))
    failed = [key for key, v in verdicts(scored, "honest").items() if not v["passes"]]
    assert failed == []


def test_the_check_fails_with_the_tiers_ratio_held_flat(scored, capsys):
    with capsys.disabled():
        print("\n" + report(scored, "control"))
    assert all(not v["passes"] for v in verdicts(scored, "control").values())
