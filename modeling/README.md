# modeling

Forecasting models for Sawtooth.

## Setup

Uses [uv](https://docs.astral.sh/uv/). From this folder:

```sh
uv sync
uv run jupyter lab
```

The notebooks read Kieran's exports from `../data/sawtooth/` and ChatGPT's earlier outputs from `../data/chatgpt/` (both gitignored; see `data/README.md`).

## Contents

| File | What it is |
|---|---|
| `demand_model_v0.ipynb` | Trains the daily demand model on ChatGPT's three test periods: median quantile regression, a two-stage event model with shrinkage (2b), mapping days to specific events and last year's occurrence (2c), XGBoost including a linear-baseline hybrid (2d), and holiday effects for model v2 (8b). Scores each data source by how much it improves accuracy, checks the 80% forecast ranges, and ranks what to ask Kieran for. Section 9h lists frozen forecast nights above the most guests that weekday has had, for a person to review; section 11 tests a log-scale baseline for the next forecast run, against a decision rule written before its scores are shown (it didn't pass, so the raw baseline stays) |
| `forecasts/` | Frozen forecasts saved before their outcomes existed, for honest scoring later (see its README). Sections 8-10 of the notebook add the rolling backtest, write the frozen forecast, and score it |
| `outputs/` | Presentation tables regenerated on every run, such as the Oct-Dec 2026 forecast with closures and the booking rule applied (see its README) |
| `dartmouth_calendar_2025_2026.csv` | Public Dartmouth dates (terms, finals, Commencement, Green Key, Homecoming, Winter Carnival, Family Weekend, orientation, home football), each with a source URL and confidence level |
| `lab/` | Townwise's forecast lab: the notebook's guest model as a tested package (`townwise_lab`, its own uv project with the same pins) and a CLI, `python -m townwise_lab run`, that turns a location's history (a `townwise.lab-input/1` file) into a draft forecast run, a backtest scorecard and a comparison with the published run (`townwise.lab-result/1`). Parity tests run the notebook's own functions; every test uses a synthetic restaurant, never `data/`. From `lab/`: `uv sync`, `uv run pytest` |
| `export_forecast_run.py` | Exports a frozen guest forecast from `forecasts/` (sha256 checked against its README) as a Townwise forecast run file in `outputs/`, for staff to import in the staff console (`../docs/portal/estimates.md` section 8). Standard library only; refuses a negative or non-finite number, never writes to `forecasts/` and prints no figure |

To re-run from the command line:

```sh
uv run jupyter nbconvert --to notebook --execute --inplace demand_model_v0.ipynb
```
