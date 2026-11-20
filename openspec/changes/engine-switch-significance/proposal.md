## Why

The lab chooses between its two engines (the hybrid model and the baseline) by a point estimate: the other engine wins when its backtest weekly WAPE is at least 0.5 points lower on the same weeks. A Diebold-Mariano comparison on the partner restaurant's own backtest (lab v11, 41 weeks, 28 days ahead) found the model 1.0 point better at a one-sided p of about 0.63, and the baseline 0.6 points better on the earlier 37 of those weeks. The rule was choosing engines on noise. On 2026-11-19 the owner asked: "sure do a sig test and push that".

## What Changes

- **A significance test in `modeling/lab`.** `pipeline.switch_p_value` is a one-sided Diebold-Mariano test on the two engines' weekly absolute errors over the weeks both scored: the mean difference over its Newey-West (Bartlett) standard error with 4 weeks of overlap (`HORIZON // 7`, since weeks forecast from the same refit share errors), read against Student's t with T − 1 degrees of freedom. Fewer than 12 shared weeks, or differences that never vary, are never significant (p = 1).
- **An engine switch needs a significant win.** `choose_engine` keeps the 0.5-point margin and adds `model_significant` and `baseline_significant` (p under `SWITCH_ALPHA` = 0.10). A tie or an insignificant win keeps the current engine.
- **A first forecast defaults to the baseline.** With no current run, the model is chosen only when it wins the baseline the same way; otherwise the baseline, the simpler engine, is returned. The fallback when the chosen engine fails its checks is unchanged.
- **No change** to the gate's rules, the scorecard, the lab input, the run file or `MODEL_VERSION` (lab v12 is in flight on `fix/lab-v12-closed-weekdays`; its bump refits every location, and weekly data changes refit Sawtooth anyway). The gate's `engine_switched` words gain "better week after week rather than by luck".

## Capabilities

### New Capabilities
- `forecast-engines`: written as a new requirement so it validates on its own; the engine choice is otherwise specified in the unarchived `autonomous-forecasts` change and `docs/portal/spec.md` 14.6.

### Modified Capabilities
None in `openspec/specs/`.

## Impact

- Spec decision **D69**; CONFIRM index item **293** (numbered after the open branches' 225 to 292).
- Lab: `modeling/lab/townwise_lab/pipeline.py` (`switch_p_value`, `SWITCH_ALPHA`, `SWITCH_LAGS`, `choose_engine`, its call in `calibrate`); `modeling/lab/tests/test_pipeline.py`. The golden result is unchanged: its baseline wins at p ≈ 0.
- API: words only (`api/src/lab/gate.ts`, `api/src/lab/input.ts` comment). Docs: `docs/portal/spec.md` (14.6, D69, 22.2, 23), `api/README.md`.
