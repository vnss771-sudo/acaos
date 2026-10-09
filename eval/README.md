# AI evaluation

Suites are listed per task in a versioned manifest, `datasets/v1/manifest.json`.

| Tier | Command | Needs | When |
|---|---|---|---|
| Offline | `npm run eval:offline` | nothing (no key, no network) | any time; first step of the weekly AI eval workflow |
| Live | `npm run eval:outreach`, `npm run eval:research` | `OPENAI_API_KEY` (billed) | weekly / manual (`.github/workflows/eval.yml`) |

Live runs append to `eval-results/<task>.json`: score and lift, the model that
actually served (after the allow-list), task, dataset version, prompt version
where one exists, wall-clock time and provider-reported token usage. Tokens are
null when the provider reports none; no cost is recorded because prices change.

To change a dataset, add `datasets/v2/` rather than editing `v1`, so recorded
history stays comparable.
