# Eval gaps

The scoring script compares each fixture's `gold` label with its checked-in `model_output`. That lets the harness run without an Anthropic key. It is not a live model score. No live eval has been run, because this environment has no `ANTHROPIC_API_KEY`.

Agreement on category and complexity together is 27/30 (90%) on the recorded outputs, above the ~80% bar. The three misses:

- `gh-18` — gold `feature` / `high`, recorded output `feature` / `med`. A small editor conflict-resolution change. Difficulty is high; the recorded output treated the modest diff as medium complexity.
- `gl-09` — gold `bugfix` / `med`, recorded output `refactor` / `med`. The empty-state fix reads like a cleanup if the failing behavior is not in the title.
- `gl-10` — gold `docs` / `med`, recorded output `config/infra` / `low`. Backup-window prose overlaps with operational config, so both the category and the complexity drifted.

Re-score a live model with a key by replacing `model_output` (or pointing the harness at fresh responses) and running `npm run eval`. Update this file if a new miss appears; the test fails when a disagreement is not listed here.
