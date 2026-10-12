# Pilot readiness — verification matrix and blockers register

Snapshot **2026-10-12**, `master` @ `c117df0`. Updated at the end of each phase. Legend:
**V** = independently verified against the real system · **F** = fixture/stub/simulated · **N** = not verified.

## 1. Verified live (read-only, via the Railway / Stripe / Sentry connectors; no changes made)
| Area | Finding | |
|---|---|---|
| Deployment | Railway project **ACAOS**, environment **"Acaos "** (trailing space): `@acaos/api`, `@acaos/worker`, `@acaos/web`, Postgres 18.6, Redis 8.2 all `live`; latest deployments **SUCCESS** from `master` @ `c117df0` (08:06–08:08 UTC). **Merges to `master` auto-deploy**, so #381/#382/#384 (D1–D6, D2-disabled, E2) are already in production. | V |
| Deployment | A second environment named **"production"** has one *staged, uncommitted* change on the legacy service `acaos` (since 2026-10-10). Needs an owner decision (apply or discard). | V |
| Stripe | One **live-mode** account (`Ben box`); no test-mode account visible to the connector. Webhook endpoint `…/api/billing/webhook` is **enabled** and subscribed to exactly the five events the handler implements (`checkout.session.completed`, `customer.subscription.updated|deleted`, `invoice.payment_failed|succeeded`). | V |
| Stripe | Active prices (AUD, monthly, **tax-exclusive**): Starter A$149, Growth A$249, **Contractor Pro A$349**. The app maps only `starter` and `growth`; **"Contractor Pro" has no plan mapping** in `billing.ts`/`BillingPlan`. | V |
| Sentry | Org `benjamin-box` (EU), project `acaos` exists and has received events: one unresolved issue (stale lazy-chunk after deploy, 1 event, 1 day ago — the class fixed by #376). Proves *web* reports; API/worker reporting not evidenced. | V (partial) |
| CI | Master CI + CodeQL green on #381, #382, #384 merge commits; weekly AusTender smoke run passed live (run 38219223786), and its failure-alert path was proven (single issue, no secrets). | V |
| ABR contract | Request/response shape confirmed from ABR's official JSON sample code; terms read (no numeric rate limit stated; no mandatory display; no implied endorsement; delete withdrawn data on notice). | V |

## 2. Not verified (needs credentials/approval)
| Item | Why | Owner |
|---|---|---|
| Live ABN lookups (active / cancelled / invalid) | No `ABR_GUID`; sandbox has no route to abr.business.gov.au. Use the manual **ABR live verification** workflow after adding the secret. | You |
| `STRIPE_AUTOMATIC_TAX` value in production | Prices are tax-exclusive. If the variable is not `true`, checkout will **not add GST**. I did not read production variable values. | You |
| `STRIPE_PRICE_STARTER/GROWTH` match the live price IDs | Boot check exists (`services/stripe.ts`), but I did not read the env. Expected: `price_1UPJDT49qC3hGQa9MCLdOe3r` (Starter), `price_1UPJEB49qC3hGQa900Tiba6e` (Growth). | You |
| A real paid checkout → webhook → plan change in live mode | Would create a real charge/customer. Needs your explicit go-ahead (use a 100%-off coupon or refund). | You |
| Public URL health (`/api/live`, `/api/ready`, web) | Sandbox cannot reach railway.app hosts. Run `npm run release:smoke` from a machine with access. | You |
| `AU_COMMERCIAL_SENDING_ENABLED` is unset in production | Default is off in code; I did not read variables. Confirm by name in the Railway dashboard. | You |
| Sentry coverage for API/worker, alert routing, release tags | Only web evidenced. Trigger a test error from each service. | You |
| Backups/PITR and a restore drill | Not visible via connectors. See `docs/RECOVERY.md`. | You |

## 3. Signup → first send (what is covered)
Automated, against a real database with a stubbed SMTP (**F**): `tests-db/onboarding-first-send.test.ts` (new workspace → one prospect → approved → sent with intent provenance),
`tests-db/golden-spine.test.ts` (signal → score → recommendation → intent → draft → approve → materialise), `e2e/campaign-launch.spec.ts` (Approve & Send request/202),
`tests-db/send-campaign.test.ts`, `send-followup.test.ts`, `delivery*.test.ts`, unsubscribe and suppression tests. **Not covered anywhere:** a real SMTP delivery from the production stack
(needs a mailbox you own; do this as the Phase 5 supervised pilot send to yourself). Phase 5 will assemble the complete contractor workflow.

## 4. Blockers register
| # | Blocker | Type | Needed to clear |
|---|---|---|---|
| B1 | Independent legal review of Australian consent/footers/unsubscribe/privacy wording (`docs/legal/au-spam-act-review-package.md`) | Legal | Counsel sign-off + your written approval |
| B2 | `AU_COMMERCIAL_SENDING_ENABLED` must stay unset until B1 | Policy | — |
| B3 | `targetsAustralia` is opt-in: existing senders to AU recipients are un-gated (`docs/pilot/AU_TARGETSAUSTRALIA_ROLLOUT.md`) | Product/Legal | Run the report; decide A/B/D |
| B4 | D1 production cleanup (check → rotate → scrub → purge) not run | Security | Your approval per step (`docs/RUNBOOK_D1_credential_exposure.md`) |
| B5 | ABR GUID registration + live verification | Credential | You register; run the workflow |
| B6 | Stripe: confirm GST (`STRIPE_AUTOMATIC_TAX`), price-ID env mapping, and decide what to do with the unmapped "Contractor Pro" price | Billing | You |
| B7 | Staged-but-unapplied Railway change in environment "production" | Ops | You |
| B8 | Sentry reporting for API/worker not evidenced; alert routing unknown | Ops | Trigger test errors |
| B9 | Backups/restore drill not evidenced | Ops | Run drill, record RTO |
| B10 | Real SMTP delivery from production (SPF/DKIM/DMARC for the sending domain) not evidenced | Deliverability | Supervised self-send + `GET /api/mailbox/check-domain` |
| B11 | E3 website evidence not built yet → "confirmed" evidence is currently downgraded to "inferred" (D4) | Feature | Phase 4 |
| B12 | UI wording for the Australia section is unreviewed by counsel | Legal | With B1 |
| B13 | Privacy Act scope (APP 1.7–1.9 from 10 Dec 2026) undecided | Legal | With B1 |

## 5. Status
**Pilot-ready (supervised, human-approved, flagged workspace, sending to your own mailbox first): not yet** — blocked by B5, B6, B10 and the supervised-send check.
**Public-ready: no** — blocked additionally by B1–B4, B9, B12, B13.
