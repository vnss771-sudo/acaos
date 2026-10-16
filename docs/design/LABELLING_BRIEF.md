# Labelling brief: independent construction-domain review

**Status:** Ready to send once an independent reviewer accepts the engagement (none is assigned yet). **Audience:** the independent reviewer.
**Context:** ACAOS relationship-graph design, `docs/design/RELATIONSHIP_GRAPH.md` §11.6 (merged in PR #414).

---

## 1. Why you are being asked

ACAOS is building a system that links construction projects to the companies and trades involved, and
says how sure it is and why. Before any of that is built, we need to know whether our **test answers** are
right. All of them were written by one author (an AI assistant) and checked only by that same author.
That catches inconsistencies; it cannot catch someone who doesn't know how procurement really reads.

You are the independent check. Your job is to say, from industry knowledge, **what each record actually
establishes**, and where our labels or definitions are wrong. **Nothing is being built from your answers
yet.** Your sign-off is the condition for unblocking the next engineering step (PR 2).

You are **not** approving accuracy targets, the schema, or the product. Thresholds stay provisional.

## 2. Who should do this

- Works or has worked as an estimator, tendering/procurement lead, or contracts administrator at a
  commercial builder or a trade subcontractor, ideally with Australian public-sector tendering (AusTender,
  council DAs, ABNs).
- Did **not** write the labels or the baseline, and has no commercial interest in ACAOS results.
- Recommended: **a second reviewer on a 10-project overlap** so agreement can be reported. No pass mark is
  set; the agreement figure is recorded as information.

## 3. Independence rules (please follow)

1. **Label blind first.** Do not open `baseline.json`, `docs/design/RELATIONSHIP_GRAPH.md` §11.5, or the
   `truth` fields until your first pass is finished. Use only the records.
2. **Argue labels from the record text.** Never change a label because a program scores better or worse.
3. **Record disagreements; don't smooth them.** A case you cannot decide is a valid answer: mark it
   `UNDECIDABLE` and say what extra information you would need.
4. **Declare conflicts** (employer, relationships with any company named, even though all are invented).

## 4. What you are reviewing

All data is **synthetic**: invented organisations, invented ABNs (`11000000xxx`), `example.invalid` URLs.
Nothing is confidential and you need not protect it. Files, all under `eval/datasets/v2/relationship-graph/`:

| File | Content | Count |
|---|---|---|
| `cases.ts` | Projects: one or more source records each (award notices, development applications) | 42 |
| `pairs.ts` | Two company names: same legal entity or not | 20 |
| `drafts.ts` | Short outreach drafts checked against evidence | 10 |
| `types.ts` | The label definitions (summarised in §5) | n/a |

A **blind review sheet** (`labelling-review/blind-review-sheet.xlsx`: records only, no truth fields) is provided so you
never need to read code.

## 5. Definitions you are asked to test

### A. Builder (per project)

*Builder = the contractor appointed to deliver the project, or a named scope of it, as principal.*
A design, project-management, QS or supply-only supplier is **not** a builder. A standing panel appoints no
builder to any project.

| Your answer | Meaning |
|---|---|
| `KNOWN` + name | The records establish who the builder is |
| `UNKNOWN` | No record establishes a builder (e.g. DA only, or the supplier is a consultant/supplier) |
| `CONFLICT` | The records name different builders and nothing resolves it |

**New, and the most important:** for each `KNOWN`, say **what in the record establishes the role**. The
design now treats "named as the awarded supplier" as *not enough by itself*. Please classify each
builder-bearing record:

| Role evidence | When to use it |
|---|---|
| `HEAD_CONTRACTOR` | The record explicitly says head / principal contractor, or "construction contract for X" such that the role is unambiguous |
| `PRINCIPAL_FOR_SCOPE` | The supplier delivers a narrow scope directly (e.g. switchboard upgrade) |
| `UNSPECIFIED_SUPPLIER` | A supplier is named but the role is not stated |
| `NON_BUILDER_SERVICE` | Design, PM, QS, supply-only, etc. |
| `PANEL_ARRANGEMENT` | Standing panel / period contract |

### B. Developer / client

The party the work is for, if a record names one; otherwise `none stated`.

### C. Trades (per trade listed for the case)

Three questions, not one:

| Tier | Question | Notes |
|---|---|---|
| Relevance | Would an estimator think this trade is worth a look? | keyword-level; weakest |
| Explicit requirement | Does the record say this trade is in scope (named, or by definition that trade's scope: switchboard, sprinkler, solar PV, hydraulic services)? | `STATED` in the current files |
| Open package | Is there an **open, unawarded** package for this trade that someone could bid on now? | Almost never true from these records; say so |

Current labels use `STATED` / `IMPLIED` (normally needed on this kind of work, not mentioned) / `ABSENT`
(record affirms out of scope, or the scope is one narrow named work type that excludes it). Unmentioned
is **not** `ABSENT`.

### D. Entity pairs

Same legal entity or not. Each pair has a stated basis (a synthetic registry entry). Tell us where the
basis is not enough for you, e.g. whether "X (Qld) Pty Ltd" and "X Pty Ltd" would be one entity.

### E. Drafts

For each draft: does it state anything the listed facts do not support? Kinds: wrong number, "recently"
beyond the evidence, qualitative overreach, **wrong party or role**, **requirement stated as fact when
only implied**, or none.

## 6. Policy calls we need you to rule on

These are open decisions; please give a ruling and one-line reasoning for each.

1. **Specialist principal contractor.** Should a contractor appointed directly for a narrow scope (e.g.
   switchboard upgrade, roof replacement, HVAC chillers) count as the **builder** for that project?
   (Decision D7.)
2. **Same-notice supplier change** (cases `F4`, `F5`). When one notice is re-published with a different
   supplier, is that a correction (latest wins) or a novation/variation (conflict)?
3. **Implied trades.** Are the `IMPLIED` lists realistic for the project types? Examples: security on a
   court-house extension, roofing on a school hall, HVAC on a community centre.
4. **Role wording in real notices.** What phrases actually make a role explicit in practice (e.g. "head
   contractor", "principal contractor", "management contract", "design and construct")? Which phrases
   mislead? You may cite **public** examples; do not paste confidential material.
5. **Panels and standing arrangements** (case `I7`): is "no builder" right?

## 7. Procedure and time

1. Blind pass over all 42 projects, 20 pairs, 10 drafts (about 3 to 4 hours).
2. Fill the response sheet (§8). Use `UNDECIDABLE` freely.
3. Unblind: compare with the current labels. For every difference write which is right and why.
4. Rule on the five policy calls.
5. Return the sheet and the sign-off block (§9).

## 8. Response sheet (one row per item)

| Field | Projects | Pairs | Drafts |
|---|---|---|---|
| Item id | `A1` … | `P01` … | `G01` … |
| Builder answer | KNOWN / UNKNOWN / CONFLICT / UNDECIDABLE + name | n/a | n/a |
| Role evidence | one of the five in §5A, or none | n/a | n/a |
| Developer / client | name or none stated | n/a | n/a |
| Trade tiers | per listed trade: relevance / explicit / open package / none | n/a | n/a |
| Same entity | n/a | yes / no / UNDECIDABLE | n/a |
| Unsupported claim | n/a | n/a | kind or none |
| Confidence | high / medium / low | same | same |
| One-line reason | required | required | required |
| After unblinding: agree? | yes / no + why | same | same |

## 9. What comes back, and what it unlocks

Please return:
1. The completed sheet.
2. Your rulings on the five policy calls.
3. A **list of labels you say are wrong**, each with a reason.
4. Wording problems with the definitions in §5 (anything you could not apply as written).
5. The sign-off block below.

```
Reviewer: <name>            Role / experience: <role, years, sector>
Date: <date>                Independent of the label author: yes / no
Conflicts declared: <none / list>
Items reviewed: projects __/42, pairs __/20, drafts __/10      Undecidable: __
Policy rulings: (1) ___ (2) ___ (3) ___ (4) ___ (5) ___
Labels changed on review: <count and ids>
Second reviewer overlap (if any): <ids, agreement figure>
```

**What happens next.** The repository owner records this block in design §11.6 and updates the labels
by argument, with each change traced to your reason. The baseline is then re-recorded under the revised
definitions. Only after that entry exists can PR 2 (pure rule library) be approved. **Accuracy
thresholds are not fixed by this review**; they follow once a re-recorded baseline has been looked at.

## 10. Known limits to keep in mind

- 42 projects is a starting set (target 100); it is not a statistical sample of real notices.
- The current numbers measure what today's code does and **do not yet reflect** the new role and trade-tier
  definitions, so they are not a score you are being asked to improve.
- Records are synthetic and short. If a real notice would carry information a record lacks, say so; that is
  useful feedback, not a failure.
- The label owner is the project owner. Label changes are accepted or rejected by the label owner, by
  argument from your reasons; the final say on disagreements between reviewers rests with them.
