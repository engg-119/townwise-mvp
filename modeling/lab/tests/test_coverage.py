"""How often the publish gate's coverage check (api/src/lab/gate.ts: 65% to 95% of backtest weeks inside their 80%
range) holds a draft back on two-year synthetic histories of several shapes and seeds (fixture.two_year_input), the
check for design decision 6's ranges. An honest 80% band on 41 weeks lands outside 65% to 95% about 3% of the time by
chance. Measured 2026-11-17 on these 20 histories: with model v7's bands (every earlier week, before metrics.same_kind)
9 were held, every one above 95%, and the mean coverage was 92%; with bands from weeks of their own kind only, none was
held (mean 82%), but synthetic histories with Hanover's calendar fell under 65% (design decision 6); with v8's (their own
kind, the latest earlier weeks filling in to half a year) 1 is held, drifting seed 0 at 54%, and the mean is 77%.
Synthetic data only."""

import numpy as np

from fixture import TWO_YEAR_SHAPES, two_year_input
from townwise_lab.pipeline import calibrate

COVERAGE_MIN, COVERAGE_MAX = 0.65, 0.95  # GATE.coverageMin and GATE.coverageMax
WEEKS_MIN = 12  # GATE.heldOutWeeksMin
SEEDS = (0, 1, 2, 3)


def test_two_year_histories_are_seldom_held_for_coverage(capsys):
    rows = []
    for shape in TWO_YEAR_SHAPES:
        for seed in SEEDS:
            card = calibrate(two_year_input(seed, shape), "0" * 40)["scorecard"]
            coverage = card["backtest"]["metrics"]["coverage80"]
            share = coverage["inside"] / coverage["weeks"]
            rows.append((shape, seed, card["engine"], coverage["inside"], coverage["weeks"], share))
    with capsys.disabled():
        for shape, seed, engine, inside, weeks, share in rows:
            print(f"\n{shape} seed {seed}: {engine}, {inside} of {weeks} weeks inside ({share:.0%})", end="")
        held = [row for row in rows if not COVERAGE_MIN <= row[5] <= COVERAGE_MAX]
        print(f"\nheld for coverage_out_of_band: {len(held)} of {len(rows)}; mean coverage "
              f"{np.mean([row[5] for row in rows]):.0%}")
    assert all(row[4] >= WEEKS_MIN for row in rows)
    assert len(held) <= 2
    # Ranges that are honest on average: neither v7's over-wide bands (92% of weeks) nor too narrow
    assert 0.72 <= np.mean([row[5] for row in rows]) <= 0.88
