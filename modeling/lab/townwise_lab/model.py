"""The notebook's hybrid model: linear quantile baselines (10th, 50th, 90th percentile) times one XGBoost multiplier
fitted to the log residual of the median baseline (sections 2, 2d and 8). Same library calls in the same order as the
notebook, so the parity tests can ask for equal results.
"""

from typing import NamedTuple

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.linear_model import QuantileRegressor

from townwise_lab.features import FLOOR

XGB_PARAMS = dict(objective="reg:absoluteerror", n_estimators=400, learning_rate=0.03, max_depth=3, min_child_weight=5,
                  subsample=0.8, colsample_bytree=0.8, reg_lambda=5.0, random_state=0, n_jobs=1)
QUANTILES = (0.1, 0.5, 0.9)
CATEGORICAL = ("weekday", "term", "weekday_regime")


class HybridFit(NamedTuple):
    base: dict[float, tuple[QuantileRegressor, pd.DataFrame]]  # per quantile: the model and its design matrix
    trees: xgb.XGBRegressor
    X_trees: pd.DataFrame


def design(frame: pd.DataFrame, cols: list[str], train_idx: pd.Index, drop_reference: bool = True) -> pd.DataFrame:
    """The design matrix over every row of `frame`: categorical inputs one-hot (without the training rows' most common
    category when drop_reference), others as floats, and only columns that vary on the training rows."""
    parts = []
    for c in cols:
        if c in CATEGORICAL:
            dummies = pd.get_dummies(frame[c], prefix=c, dtype=float)
            reference = f"{c}_{frame.loc[train_idx, c].mode()[0]}"  # most common category in training
            parts.append(dummies.drop(columns=reference) if drop_reference else dummies)
        else:
            parts.append(frame[[c]].astype(float))
    X = pd.concat(parts, axis=1)
    return X.loc[:, X.loc[train_idx].nunique() > 1]  # nothing can be learned from a column constant in training


def fit_quantile(frame: pd.DataFrame, cols: list[str], train: pd.DataFrame, q: float = 0.5,
                 target: str = "guests") -> tuple[QuantileRegressor, pd.DataFrame]:
    X = design(frame, cols, train.index)
    model = QuantileRegressor(quantile=q, alpha=0.0, solver="highs").fit(X.loc[train.index], train[target])
    return model, X


def xgb_fit(frame: pd.DataFrame, cols: list[str], train: pd.DataFrame,
            values: pd.Series) -> tuple[xgb.XGBRegressor, pd.DataFrame]:
    X = design(frame, cols, train.index, drop_reference=False)
    return xgb.XGBRegressor(**XGB_PARAMS).fit(X.loc[train.index], values), X


def hybrid_fit(frame: pd.DataFrame, train: pd.DataFrame, base_cols: list[str], event_cols: list[str],
               target: str = "guests") -> HybridFit:
    base = {q: fit_quantile(frame, base_cols, train, q, target=target) for q in QUANTILES}
    model, X = base[0.5]
    base_train = pd.Series(model.predict(X.loc[train.index]), index=train.index)
    resid = np.log(train[target].clip(lower=FLOOR) / base_train.clip(lower=FLOOR))
    trees, X_trees = xgb_fit(frame, event_cols, train, resid)
    return HybridFit(base, trees, X_trees)


def hybrid_predict(fit: HybridFit, rows: pd.DataFrame) -> dict[float, pd.Series]:
    """Per quantile, the baseline times the event multiplier for `rows` (any rows of the frame the fit was made on)."""
    multiplier = np.exp(fit.trees.predict(fit.X_trees.loc[rows.index]))
    return {q: pd.Series(m.predict(X.loc[rows.index]) * multiplier, index=rows.index) for q, (m, X) in fit.base.items()}


def learning_curve(frame: pd.DataFrame, train: pd.DataFrame, valid: pd.DataFrame, base_cols: list[str],
                   event_cols: list[str], target: str = "guests") -> tuple[list[float], list[float]]:
    """The trees' loss after each boosting round, on the rows they were fitted to and on `valid`, rows they never saw:
    the mean absolute error of the log residual of the median baseline (the trees' own objective), so a ratio and never
    a guest count. The same fit as hybrid_fit's trees on `train`; watching a second set changes no tree."""
    base, X = fit_quantile(frame, base_cols, train, 0.5, target=target)

    def resid(rows: pd.DataFrame) -> pd.Series:
        predicted = pd.Series(base.predict(X.loc[rows.index]), index=rows.index)
        return np.log(rows[target].clip(lower=FLOOR) / predicted.clip(lower=FLOOR))

    X_trees = design(frame, event_cols, train.index, drop_reference=False)
    sets = [(X_trees.loc[rows.index], resid(rows)) for rows in (train, valid)]
    trees = xgb.XGBRegressor(**XGB_PARAMS, eval_metric="mae").fit(*sets[0], eval_set=sets, verbose=False)
    history = trees.evals_result()
    return history["validation_0"]["mae"], history["validation_1"]["mae"]
