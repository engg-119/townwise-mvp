"""The notebook's own definitions, for the parity tests.

Parses ../demand_model_v0.ipynb's code cells with ast and runs only the function definitions named in FUNCTIONS and
the assignments to CONSTANTS, in notebook order, so nothing reads data/, plots or writes a file. The functions see np,
pd, QuantileRegressor, xgb and the globals the caller passes (od, SCHEDULES, ROLL_END, SCORE_START, SCORE_END, BASE,
EVENT_INPUTS) in place of the notebook's own.
"""

import ast
import json
from collections.abc import Iterable
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.linear_model import QuantileRegressor

NOTEBOOK = Path(__file__).resolve().parents[2] / "demand_model_v0.ipynb"
FUNCTIONS = ("design", "fit_quantile", "xgb_fit", "hybrid_fit", "hybrid_predict", "holiday_effects",
             "holiday_multiplier", "choose_big_night_lambda", "rolling_scores", "rolling_quantiles", "widen",
             "daily_coverage")
CONSTANTS = ("XGB_PARAMS", "FLOOR", "LAMBDAS")


def code_cells(path: Path = NOTEBOOK) -> list[str]:
    cells = json.loads(path.read_text(encoding="utf-8"))["cells"]
    return ["".join(c["source"]) for c in cells if c["cell_type"] == "code"]


def definitions(sources: Iterable[str], functions: Iterable[str] = FUNCTIONS,
                constants: Iterable[str] = CONSTANTS) -> ast.Module:
    functions, constants = set(functions), set(constants)
    picked, found = [], set()
    for source in sources:
        for node in ast.parse(source).body:
            if isinstance(node, ast.FunctionDef) and node.name in functions:
                picked.append(node)
                found.add(node.name)
            elif isinstance(node, ast.Assign):
                names = {t.id for t in node.targets if isinstance(t, ast.Name)} & constants
                if names:
                    picked.append(node)
                    found |= names
    missing = sorted((functions | constants) - found)
    if missing:
        raise LookupError(f"the notebook no longer defines {', '.join(missing)}")
    return ast.Module(body=picked, type_ignores=[])


def notebook_namespace(od: pd.DataFrame, **globals_) -> dict:
    namespace = {"np": np, "pd": pd, "QuantileRegressor": QuantileRegressor, "xgb": xgb, "od": od, **globals_}
    exec(compile(definitions(code_cells()), str(NOTEBOOK), "exec"), namespace)
    return namespace
