import pandas as pd
import pytest
from fixture import (DATA_THROUGH, FIRST_DAY, NOTEBOOK_BASE, NOTEBOOK_EVENT_COLS, NOTEBOOK_EVENT_INPUTS, REGIME_START,
                     synthetic_frame)
from notebook import notebook_namespace

from townwise_lab import backtest, features


@pytest.fixture(scope="session")
def frame() -> pd.DataFrame:
    # The frame as the lab prepares it at the fixture's data cutoff, with the fixture's weekday regime
    return features.add_weekday_regime(features.add_recent_level(synthetic_frame(0), DATA_THROUGH), REGIME_START)


@pytest.fixture(scope="session")
def hist(frame) -> pd.DataFrame:
    return features.training_rows(frame, DATA_THROUGH)


@pytest.fixture(scope="session")
def origins() -> list[pd.Timestamp]:
    return backtest.quarterly_origins(FIRST_DAY, DATA_THROUGH)


@pytest.fixture(scope="session")
def window(origins) -> tuple[pd.Timestamp, pd.Timestamp]:
    # The notebook scores both horizons on one window (SCORE_START, SCORE_END), the 28-day one
    return backtest.score_window(origins, DATA_THROUGH, 28)


@pytest.fixture(scope="session")
def nb(hist, origins, window) -> dict:
    return notebook_namespace(hist, SCHEDULES={"every 3 months": pd.DatetimeIndex(origins)}, ROLL_END=DATA_THROUGH,
                              SCORE_START=window[0], SCORE_END=window[1], BASE=NOTEBOOK_BASE,
                              EVENT_INPUTS=NOTEBOOK_EVENT_INPUTS)


@pytest.fixture(scope="session")
def preds(frame, hist, origins) -> pd.DataFrame:
    # The lab's rolling backtest on the notebook's inputs, without holidays, as the notebook's backtests ran
    return backtest.rolling_predictions(frame, hist, origins, DATA_THROUGH, NOTEBOOK_BASE, NOTEBOOK_EVENT_COLS,
                                        holidays=False)


@pytest.fixture(scope="session")
def nb_scores(nb) -> dict:
    return nb["rolling_scores"]("guests")
