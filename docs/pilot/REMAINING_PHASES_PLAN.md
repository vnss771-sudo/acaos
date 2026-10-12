# Remaining phases — implementation plan

Baseline: `master` @ `143694d` (#381–#386, #388 merged). **#387 (Phase 1 hardening v3–v5) is open** — review/merge first.
Principles: one small reviewable PR per slice; every slice ships tests + docs; nothing enabled by default; no production flag, credential or
send without your written approval; each PR runs the affected tiers locally on Node 26 **including the offline-stub typecheck** (the check that
repeatedly bites) and CI is authoritative.

## 0. Hygiene and owner actions (no code; unblocks everything)
| # | Action | Owner |
|---|---|---|
| 0.1 | Review/merge #387 | You |
| 0.2 | Register ABR GUID → add repo secret `ABR_GUID` → run "ABR live verification" workflow (active/cancelled/invalid, GUID-leak check) | You, then me |
| 0.3 | In Railway: confirm `AU_COMMERCIAL_SENDING_ENABLED` unset, `AU_JURISDICTION_REVIEW_REQUIRED` unset, `STRIPE_AUTOMATIC_TAX=true`; resolve staged change in env "production"; delete branch `tmp/smoke-failure-test` | You |
| 0.4 | Decide "Contractor Pro" Stripe price (map to a plan or archive) | You |
| 0.5 | Engage Australian counsel with `docs/legal/au-spam-act-review-package.md` | You |

## 1. E3 remaining stages (each its own PR; library → worker → API → UI)
Stages 1–3 (collector, extractor, store) are merged and inert.

**E3.4 — Controlled collection job (flag `WEBSITE_EVIDENCE_ENABLED`, default off)**
- BullMQ job per prospect: collect → extract → `saveWebsiteEvidence` in one tx. Per-workspace daily quota (reuse discovery-quota pattern), global concurrency cap, per-host rate limit (≥1 req/5 s), page cap (≤3 pages/prospect: home, /about, /contact — fixed paths only), retries with jitter, circuit breaker, audit events (`website_evidence.collected|blocked`), metrics.
- **robots.txt + noindex/`X-Robots-Tag` respected** (fetch robots via the same pinned collector; cache 24 h; deny on fetch error = fail closed). Honest UA with contact URL.
- Egress: documented firewall/allow-list note; no proxies/headless browser.
- Tests: worker unit with stub transport; DB test (quota, dedupe by `sourceHash`, tenant isolation); flag-off = no job enqueued.

**E3.5 — Pipeline integration (Signal → Evidence → Scoring → Recommendation)**
- Map stored claims to `EvidenceSource` rows (`provider: website`, type `observed`, never `confirmed`) and a Signal with source URL/capture time.
- Scoring treats website claims as `observed` weight; D4 stays: `confirmed` only when the LLM quote is found **verbatim** in a stored claim for that URL (replaces blanket downgrade via `downgradeUnverifiedEvidence(…, fetchedUrls)` + quote match).
- Recommendation cites evidence IDs; **auto-outreach is never triggered by evidence** (explicit test: collecting evidence creates no draft/send).
- Tests: golden-spine extension; prompt-injection fixture ("ignore previous instructions", fake `confirmed`) cannot change recommendation or send state.

**E3.6 — Read API + approval UI**
- `GET /api/prospects/:id/website-evidence` (membership + prospect ownership, tenant guard, expired hidden).
- Approvals view: evidence list with source URL, capture time, "observed — unverified" badge, hash, excerpt; no raw HTML. vitest + one Playwright journey.

**E3.7 — Adversarial suite**
- SSRF: DNS rebinding (resolver flips between calls), redirect→private/metadata IPs, decimal/octal/IPv6-mapped literals, userinfo tricks, `.au` lookalike hosts; size bombs, gzip bombs (identity-only), slowloris (total deadline), binary, charset tricks; malicious HTML (nested script/template/svg, entity bombs, huge attribute lists) with CPU-time bounds. Fixture-based extraction goldens.
- Acceptance: all green in CI; no regex catastrophic backtracking (timing assertions).

## 2. Operational hardening (small PRs, mostly docs/scripts/tests)
- **O1** Sentry: verify API + worker report (send controlled test errors from each service once, with your approval); alert routing documented.
- **O2** `scripts/pilot-preflight.mjs` (read-only): checks required env **names** present (never values), flag defaults, DB reachability, migrations applied, Stripe webhook events vs handler list (via API read), AU flags off. Output = markdown report; wire into `docs/GO_LIVE_CHECKLIST.md`.
- **O3** Backups/PITR restore drill record (`docs/RECOVERY.md` result table).
- **O4** D1 production cleanup per runbook — **only on your per-step approval**.
- **O5** Stripe: price/plan mapping decision implemented; paid-checkout rehearsal with a 100%-off coupon (your go-ahead).
- **O6** Post-deploy smoke run from a machine with network access (`npm run release:smoke`).

## 3. Jurisdiction state machine (after counsel approves criteria)
Implements `docs/AU_JURISDICTION_REVIEW_V4.md`: persisted `UNREVIEWED/AU_IN_SCOPE/OUT_OF_SCOPE/REVIEW_EXPIRED`, operator-only transitions (not workspace admins), append-only audit, `targetsAustralia=true` always wins, migration with no auto-reclassification, then replaces the blunt `AU_JURISDICTION_REVIEW_REQUIRED` flag. Tests: transitions, race conditions, worker/batch/follow-up/queued retries, tenancy.

## 4. Phase 5 — pilot acceptance
1. **Automated spine test** (DB tier, stubbed SMTP): discovery fixture → business verification (ABR stub) → evidence (stored claims) → opportunity → recommendation → AU consent validation (qualifying vs missing evidence) → AI draft (stubbed) → human approval → safe send (footer/ABN/unsubscribe) → reply ingestion → won → FieldOps job. Asserts each gate fails closed.
2. **Supervised live pilot** (needs your approval + flagged workspace + `AU_COMMERCIAL_SENDING_ENABLED` **only after counsel sign-off**; until then sends go to your own mailbox with the AU flag off): checklist in `PILOT_RUNSHEET.md`.
3. Deliverable `docs/pilot/PILOT_ACCEPTANCE.md`: verified vs simulated matrix, CI/deploy status, blockers, pilot-ready vs public-ready.

## 5. Ordering and rough sizing (PR count; effort S/M/L)
`0` → `E3.4 (L)` → `E3.5 (M)` → `E3.6 (M)` → `E3.7 (M)` ‖ `O1–O3, O5–O6 (S each)` → `§3 (L, gated on counsel)` → `§4.1 (M)` → `§4.2/4.3 (S, gated)`. About 12 PRs.
Critical path to **pilot-ready (supervised, own mailbox)**: 0.2, 0.3, O1, O3, O6, §4.1. Critical path to **public-ready**: all of the above plus counsel sign-off (0.5), §3, O4, E3.7.

## 6. Working protocol (token- and risk-conservative)
- Keep a rolling handoff (`docs/pilot/PILOT_READINESS.md` blockers table) updated per PR so a fresh session needs no history.
- Prefer applying reviewed patches; read only the files a slice touches; run only affected suites locally (always include stub typecheck + `check:tenant-resources` when schema/models change); let CI run the full matrix.
- Stop and ask before: any production write, credential rotation, flag flip, spend, live send, or schema change that can't be rolled back.
