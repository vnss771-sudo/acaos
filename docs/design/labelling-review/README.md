# Labelling review files

| File | Who gets it |
|---|---|
| `blind-review-sheet.xlsx` | **The independent reviewer.** Records only, shuffled neutral ids (R/Q/D), no labels, notes, strata, pair bases or draft verdicts. Dropdowns on the yellow cells; grey row 2 is an example. |
| `blind-key.csv` | **Repository owner only. Do not send to the reviewer.** Maps blind ids to repo ids so answers can be unblinded after the first pass. |

Everything is synthetic. The shuffle uses a fixed seed (20261017), so the sheet is reproducible from
`eval/datasets/v2/relationship-graph/`. If any label or record changes, regenerate the sheet and key
together; do not edit them by hand.

Sending the reviewer the whole repository defeats the blind. Send only the `.xlsx` and the brief
(`../LABELLING_BRIEF.md`).
