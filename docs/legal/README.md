# Legal & compliance documents

> ⚠️ **DRAFTS — NOT LEGAL ADVICE.** The documents in this folder are engineering-authored
> **starting templates** to give your counsel something to redline, not finished or binding
> terms. **Qualified legal counsel must review and approve every document here before it is
> shown to customers or relied upon**, and before `COMPLIANCE_GATE_ENABLED` is turned on.

These back the in-product compliance surface shipped in PR #224 (Settings → Compliance,
the `/api/legal/*` disclosure endpoints, and the dormant send-readiness gate).

| Document | Purpose | Who completes |
|---|---|---|
| [`subprocessors.md`](./subprocessors.md) | Public sub-processor disclosure (GDPR Art. 13–14). Factual — derived from `packages/backend-core/src/lib/subprocessors.ts`. | Eng keeps the list in sync; legal approves wording. |
| [`acceptable-use-and-dpa.md`](./acceptable-use-and-dpa.md) | Acceptable-use terms customers accept + a Data Processing Addendum outline. | **Counsel** (binding terms). |
| [`legitimate-interest-assessment.md`](./legitimate-interest-assessment.md) | LIA worksheet a customer fills in to document their GDPR Art. 6(1)(f) basis. | Customer; we provide the template. |

## Keeping versions in sync

The product records which **version** a workspace accepted. When you change wording:
- Sub-processors: bump `SUBPROCESSORS_VERSION` in `lib/subprocessors.ts` — the UI then shows
  "update available" and prompts re-acknowledgement.
- Terms: bump `COMPLIANCE_TERMS_VERSION` likewise (drives `termsVersion`).

The dates in the code constants and these docs must match what counsel signs off.

## Turning the gate on (operator procedure)

The compliance checks ship **dormant**. To enforce them:

1. Counsel approves the three documents above; publish them (e.g. host the markdown, or
   surface via the web — the API already serves the sub-processor list at
   `GET /api/legal/subprocessors`).
2. Confirm `SUBPROCESSORS_VERSION` / `COMPLIANCE_TERMS_VERSION` match the approved copy.
3. Decide rollout: new workspaces first, or all. (A backfill prompt for existing
   workspaces is design item C5 — not yet built.)
4. Set `COMPLIANCE_GATE_ENABLED=true`. From then on `getSendReadiness` requires a recorded
   lawful basis + accepted terms (+ CASL consent for Canada-targeting workspaces) before a
   workspace can launch outreach.
5. Communicate to existing customers that they must complete Settings → Compliance.

## What the product does NOT do (your obligations, not ours)

ACAOS acts as a **data processor**; the customer is the **controller** and retains their
legal obligations. The product *facilitates* compliance (records attestations, discloses
sub-processors, gates sending) — it does not draft your LIA/DPA, obtain consent on your
behalf, or assume liability for the customer's sending decisions.
