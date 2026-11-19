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
| `lab/` | Townwise's forecast lab (`townwise_lab`, its own uv project with the same pins), model version v11 (`townwise_lab/version.py`, held equal to the API's `LAB_MODEL_VERSION` in `api/src/lab/input.ts` by a contract test, so a bump refits every location once). It has two engines: a baseline (each weekday's recent level, times last year's seasonal shape, times the location's own town-calendar effects) that runs from a 230-day history span, and the notebook's guest model beside it from a 595-day span. It returns the current run's engine unless the other's backtest weekly WAPE is at least 0.5 points lower and it passes the gate's checks. A run's forecast tier reaches today plus 91 days (at most 182 days past the data). Once that tier has 8 backtest weeks behind it, the outlook reaches today plus 365 (at most 400 past the data; a model run stops at the town's last researched term), with ranges widened from the backtest at 182 and 365 days of lead. A CLI, `python -m townwise_lab run`, turns a location's history (a `townwise.lab-input/3` file, with 400 future days and `termsThrough`; versions 1 and 2 are refused) into a draft forecast run, a backtest scorecard and a comparison with the published run (`townwise.lab-result/1`). In production the same package runs as `python -m townwise_lab job`, the entrypoint of the Container Apps job `caj-townwise-lab`. Its image is built from `lab/Dockerfile`, and `deploy.yml` deploys it when `lab/` changes. The API starts one execution per calibration (a person's, or the weekly refresh's from `caj-townwise-forecasts`), and the job fetches its input from the API and posts its result back with its own managed identity (`../infra/README.md`, step 20). Parity tests run the notebook's own functions; every test uses a synthetic restaurant, never `data/`. From `lab/`: `uv sync`, `uv run pytest` |
| `export_forecast_run.py` | Exports a frozen guest forecast from `forecasts/` (sha256 checked against its README) as a Townwise forecast run file in `outputs/`, for staff to import in the staff console (`../docs/portal/estimates.md` section 8). Standard library only; refuses a negative or non-finite number, never writes to `forecasts/` and prints no figure |

To re-run from the command line:

```sh
uv run jupyter nbconvert --to notebook --execute --inplace demand_model_v0.ipynb
```
