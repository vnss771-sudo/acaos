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

## Relationship-graph baseline (dataset v2)

`datasets/v2/manifest.json` re-lists the v1 suites unchanged and adds
`relationship-graph-baseline`. It measures what the product does today, with no
graph, against a labelled gold set, so the construction relationship graph
(`docs/design/RELATIONSHIP_GRAPH.md` §11) has a number to beat.

| Command | Does |
|---|---|
| `node scripts/eval-offline.mjs --dataset v2` | runs every offline suite, including the baseline |
| `npm run eval:graph-baseline` | prints the baseline metrics as JSON |
| `npm run eval:graph-baseline -- --write` | regenerates `datasets/v2/relationship-graph/baseline.json` |

Offline and deterministic: no key, no network, no database, no clock. All data is
synthetic (invented organisations, invented `11000000xxx` ABNs, `example.invalid`
URLs). The recorded baseline is a regression pin, not a threshold; the test fails
if code the baseline exercises changes its output, and you review the
`baseline.json` diff. Labels are written from record text and the definitions in
`types.ts`, never from code output: if a case looks wrong, fix the label by
argument, not by matching the code. Add cases by extending `cases.ts`, `pairs.ts`
or `drafts.ts`, then regenerate.
