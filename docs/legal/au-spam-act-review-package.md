# Independent legal review package — Australian commercial email (Spam Act 2003)

**Purpose.** Give independent Australian counsel what they need to approve (or change) how ACAOS
sends cold B2B email to Australian recipients. **Nothing here is legal advice.** Australian commercial
sending is **disabled** (`AU_COMMERCIAL_SENDING_ENABLED` unset ⇒ off) and stays off until counsel has
reviewed this package and the owner gives explicit written approval.

Prepared 2026-10-12 against `master` @ `c117df0` (PRs #381, #382, #384 merged; UI in PR #385).

## 1. What the product does
ACAOS helps Australian contractors (trades) find construction opportunities and prospects, drafts
outreach with AI, and — only after a human approves — sends it from the customer's own mailbox.
The customer (workspace) is the sender and the legal "controller"; ACAOS is the processor.

Flow: discovery (AusTender contract notices; PlanningAlerts if enabled) → prospect/business record →
evidence + score → recommendation → **consent validation** → AI draft → **human approval** → send →
reply handling → unsubscribe/suppression.

## 2. Rules we encoded and where (please confirm each reading)
Statutory references come from the Readiness Audit's primary-source table (Spam Act ss7, 16, 17, 18,
Sch 2; ACMA "Avoid sending spam"); they were not re-verified line-by-line for this package.

| # | Rule as implemented | Code |
|---|---|---|
| R1 | Unsolicited commercial email with an Australian link needs the recipient's **consent** (express, or inferred). `legitimate_interest` (a GDPR concept) is never consent. Legacy `express_consent`/`implied_consent` (CASL/GDPR) rows do **not** satisfy the Australian gate. | `lib/auConsent.ts`, `lib/consent.ts` |
| R2 | **Express consent** record needs: date given (not future) and documentation (URL, or excerpt ≥ 10 chars). | `validateAuConsentEvidence` |
| R3 | **Inferred consent from conspicuous publication** needs ALL of: page URL (http/https), date seen, address type (role/personal), verified absence of a "no unsolicited commercial email" statement, and that the message is relevant to the recipient's role/function. Publication alone is never enough. | same |
| R4 | Missing/unknown evidence ⇒ not consent (**fail closed**). | same |
| R5 | Sender identified: legal business name + postal address required before any send; optional verified ABN (ABN Lookup) printed in the footer. | `lib/emailFooter.ts`, `sendReadiness.ts`, `lib/abnLookup.ts` |
| R6 | Functioning unsubscribe in every message (link + RFC 8058 one-click headers); honoured immediately (policy target ≤ 5 business days per ACMA); unsubscribe tokens kept ≥ 30 days after sending — retention for sent records floored at **60 days**. | `routes/unsubscribe.ts`, `lib/retention.ts` |
| R7 | Contact policy: suppression list, no re-contact after reply/terminal stage, ≥ 5 business days between sends, ≤ 3 sends per 30 days. | `services/contactPolicy.ts` |
| R8 | Human approval before send (approval mode default on; autonomous sending needs separate opt-in + thresholds). | `autonomyReadiness.ts`, `LaunchApprovalModal` |
| R9 | Jurisdiction is an explicit workspace flag `targetsAustralia`; AU-flagged workspaces cannot send at all while the master switch is off; with it on, every recipient needs R2/R3 evidence. Replies to inbound mail are not blocked. | `services/sendAuthorization.ts` |

## 3. Data collected for consent evidence (privacy)
`ConsentRecord`: recipient email (normalised), basis, source, `evidenceUrl`, `evidenceAt`,
`evidenceExcerpt` (≤ 500 chars, short quote only), `evidenceHash` (sha256 of URL+excerpt), `addressType`,
`optOutStatementAbsent`, `roleRelevant`. Deleted with the workspace (cascade). **Open:** retention period
for evidence (currently kept for the life of the workspace).

## 4. Wording to review verbatim (UI: Settings → Compliance → Australia)
- "Publication of an email address is **not** consent on its own. For an address published on a website you must record where and when you saw it, whether it is a role address or the person's own, that no 'no unsolicited commercial email' statement accompanies it, and that your message is relevant to their role. Legitimate interest never counts for Australia."
- Checkbox: "I checked: no 'no unsolicited commercial email' (or similar) statement appears with the address"
- Checkbox: "My message is relevant to this person's role or business"
- Targeting: "We send to recipients with an Australian link (requires documented consent per recipient)"
- Blocked state: "Sending is currently blocked for this workspace: Australian commercial sending is disabled on this ACAOS deployment pending legal review."
- ABN: "Shown in your email footer. Source: ABN Lookup. This does not mean the Commonwealth endorses or is affiliated with your business." (ABR terms prohibit implying endorsement.)
- Footer text: "You received this email because you matched our outreach criteria. To stop receiving emails, unsubscribe here." + business name, postal address, optional ABN.

## 5. Questions for counsel
1. Is the R3 evidence set sufficient for "inferred consent" via conspicuous publication (Sch 2 cl 4)? Is a single checkbox attestation by the customer adequate, or must we capture/retain page content?
2. Role addresses (info@, sales@): treat as publication-consent candidates or require express consent?
3. "Relevance to role": should we constrain/validate message content, or is the customer's attestation enough?
4. How long must/may consent evidence be kept; should it expire (re-confirm after N months)?
5. Is `legitimate_interest` display/recording acceptable for the GDPR ledger while being excluded for Australia?
6. Sender identification: legal name + ABN + postal address — adequate? Is a verified ABN required or merely recommended?
7. Unsubscribe: our commitment is immediate suppression; are the 30-day (s18(1)(e)) and 60-day retention floors adequate?
8. Are replies/inbound-enquiry responses outside the "commercial electronic message" definition as we assume (R9)?
9. Are AusTender-derived prospects (public contract notices) any different for consent purposes?
10. Privacy Act: are we an APP entity (small-business exemption, trading in personal information)? Are APP 1.7–1.9 automated-decision disclosure rules (from 10 Dec 2026) triggered by lead scoring/auto-skip?
11. Terms/DPA/AUP changes needed so customers warrant compliance and indemnify appropriately.
12. Anything about AI-drafted content (misleading/deceptive conduct) that should be added.

## 6. Known gaps (not yet addressed)
- A workspace that does not set `targetsAustralia` is **not** gated by R9 (a recipient-based `.au` heuristic is not enforced). See `docs/pilot/AU_TARGETSAUSTRALIA_ROLLOUT.md`.
- Evidence is an attestation by the customer; ACAOS does not yet fetch/verify the page (planned E3).
- No expiry/re-confirmation of evidence; no bulk evidence import (imports cannot create AU bases).

## 7. Evidence of testing
Unit/DB/E2E tests in `tests/au-consent.test.ts`, `tests-db/au-consent-gate.test.ts`, `tests-db/consent-review.test.ts`,
`e2e/au-compliance.spec.ts`; design in `docs/DESIGN_au_spam_act_consent.md`. All simulated/fixture-based; no real Australian message has been sent.

## 8. Approval record (fill in; keep with the repo)
| Item | Reviewer | Date | Outcome / conditions |
|---|---|---|---|
| Consent rules R1–R4 | | | |
| Footer / sender identification R5 | | | |
| Unsubscribe & retention R6 | | | |
| UI wording (§4) | | | |
| Privacy Act scope (Q10) | | | |
| **Owner approval to set `AU_COMMERCIAL_SENDING_ENABLED=true`** | | | |
