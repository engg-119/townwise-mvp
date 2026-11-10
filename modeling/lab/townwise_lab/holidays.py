"""Holiday multipliers on top of the hybrid (the notebook's sections 8b and 9c): per holiday group, the median log
ratio of actual guests to the hybrid's in-sample forecast, shrunk toward zero by n / (n + lambda)."""

import numpy as np
import pandas as pd

from townwise_lab import model
from townwise_lab.features import FLOOR

LAMBDAS = (0, 1, 3, 10)  # candidates for the big-night shrinkage, chosen by leave-one-out
HALLOWEEN_LAMBDA = 3


def holiday_effects(frame: pd.DataFrame, train: pd.DataFrame, fit: model.HybridFit, lams: dict[str, int],
                    target: str = "guests") -> dict[str, float]:
    """Per flag column in `lams` (read from `frame`), its shrunken log effect; 0.0 when no training day has it."""
    pred = model.hybrid_predict(fit, train)[0.5]
    log_ratio = np.log(train[target].clip(lower=FLOOR) / pred.clip(lower=FLOOR))
    flags = frame.loc[train.index]
    effects = {}
    for k, lam in lams.items():
        days = train.index[flags[k] == 1]
        effects[k] = len(days) / (len(days) + lam) * log_ratio[days].median() if len(days) else 0.0
    return effects


def holiday_multiplier(rows: pd.DataFrame, effects: dict[str, float]) -> pd.Series:
    return np.exp(sum((rows[k] * v for k, v in effects.items()), pd.Series(0.0, index=rows.index)))


def choose_big_night_lambda(frame: pd.DataFrame, hist: pd.DataFrame, base_cols: list[str], event_cols: list[str],
                            target: str = "guests") -> tuple[int, dict[int, float]]:
    """Leave-one-out over the big nights in `hist`: total absolute error for each candidate lambda, and the lambda with
    the least (the first of equals, so 0 when `hist` has no big night)."""
    errs = dict.fromkeys(LAMBDAS, 0.0)
    for idx in hist.index[hist.hol_big_night == 1]:
        tr, one = hist.drop(index=idx), hist.loc[[idx]]
        fit = model.hybrid_fit(frame, tr, base_cols, event_cols, target=target)
        base = model.hybrid_predict(fit, one)[0.5].iloc[0]
        for lam in LAMBDAS:
            eff_one = holiday_effects(frame, tr, fit, {"hol_big_night": lam}, target=target)
            errs[lam] += abs(one[target].iloc[0] - base * holiday_multiplier(one, eff_one).iloc[0])
    return min(errs, key=errs.get), errs
