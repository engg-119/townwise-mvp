# Sawtooth reorder

Demand forecasts live in `modeling/`. The reorder module in `reorder/` reads those forecasts and the bar's sales files. It does not place orders.

## Tests

From `reorder/`:

```sh
uv sync
uv run pytest
```

The phone mockup is `reorder/mockup_app.py`. From `reorder/`, run `python3 -m streamlit run mockup_app.py`.
