Spec decision D69; CONFIRM item 293. No model version bump (lab v12 is on another branch).

## 1. Lab

- [x] 1.1 `switch_p_value` (one-sided Diebold-Mariano, Newey-West over `HORIZON // 7` weeks, Student's t, never significant under 12 shared weeks or with unvarying differences), `SWITCH_ALPHA = 0.10`, and `choose_engine`'s `model_significant` and `baseline_significant`, computed in `calibrate` from each engine's `weeks28`. Tests: a consistent win is significant and one-sided; a noisy win is not; too few, unvarying or unshared weeks are not; an insignificant win keeps the current engine; with no current run an insignificant model win returns the baseline; the fixture without its level jump (model 1.3 points better, p about 0.12) returns the baseline, and returns the model when the win is made significant. `uv run pytest` in `modeling/lab`
  Done: 229 tests before the noisy-win fixture was made deterministic; the engine, golden and significance tests rerun after it. Golden result unchanged.

## 2. Words and docs

- [x] 2.1 `api/src/lab/gate.ts` `engine_switched` words, `api/src/lab/input.ts` comment, `api/README.md` (Two engines), `docs/portal/spec.md` 14.6, D69, item 293 and the changelog. `npm test -w @townwise/api -- test/lab-gate.test.ts test/lab-contract.test.ts`
