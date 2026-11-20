"""Townwise's forecast lab: the guest demand model of ../demand_model_v0.ipynb, and a baseline engine beside it, as a
tested package.

Modules: features (the day frame's model inputs), model (linear quantile baselines times an XGBoost multiplier),
holidays (shrunken holiday multipliers), backtest (rolling origins and six-month folds), metrics (the scorecard's
measures), baseline (the baseline engine: recent weekday level times last year's shape times calendar effects),
forecast (the run file: forecast tier and outlook), compare (the draft against the published run), pipeline
(calibrate: a LabInput in, a LabResult out, running both engines and returning one), schema (the LabInput and
LabResult documents, and validate_input), job (the Azure entrypoint: fetch the input, calibrate, post the result) and
version (the model version a lab run names).
"""
