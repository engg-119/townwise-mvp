# eda

Exploratory data analysis notebooks for the Sawtooth forecasting project.

## Setup

Uses [uv](https://docs.astral.sh/uv/). From this folder:

```sh
uv sync              # creates .venv from pyproject.toml / uv.lock
uv run jupyter lab   # open the notebooks
```

The notebooks read Kieran's raw exports from `../data/sawtooth/`, which is gitignored. See `data/README.md` for what goes there.

## Notebooks

| Notebook | What it does |
|---|---|
| `sawtooth_chatgpt_audit.ipynb` | Checks each claim in ChatGPT's summary of the Sawtooth data against the raw exports, and ends with a scorecard. Also covers daily completeness and closures, the year-over-year trend, the daily calendar heatmap, Event-category revenue, and Product Mix granularity. Ends with `encode_closed_days()`, which labels every closed day and builds the open-days-only modeling target |

To re-run a notebook from the command line:

```sh
uv run jupyter nbconvert --to notebook --execute --inplace sawtooth_chatgpt_audit.ipynb
```
