# Outreach acceptable-use terms & Data Processing Addendum (DRAFT)

> 🚫 **DRAFT TEMPLATE — NOT BINDING, NOT LEGAL ADVICE.** Counsel MUST review, complete, and
> approve before this is presented to customers or `COMPLIANCE_GATE_ENABLED` is set. Bracketed
> `[…]` fields and every clause are placeholders for your legal team. Version this against
> `COMPLIANCE_TERMS_VERSION`.

## Part A — Outreach Acceptable Use (customer-facing, accepted in Settings → Compliance)

By sending outreach through ACAOS, the customer agrees that they will:

1. **Have a lawful basis.** Only send to recipients for whom they have a valid legal basis
   under applicable law (e.g. GDPR Art. 6(1)(f) legitimate interest with a documented LIA;
   CASL express/implied consent for Canadian recipients; CAN-SPAM compliance for US
   recipients). They will record that basis in ACAOS where the product provides for it.
2. **Send only B2B, relevant outreach** consistent with the recipient's reasonable
   expectations; no consumer spam, no purchased/scraped lists lacking a lawful basis.
3. **Honour opt-outs immediately.** (ACAOS enforces unsubscribe + suppression before every
   send and includes the sender's physical address and a one-click unsubscribe in every
   message — but the customer remains responsible for honouring out-of-band opt-outs.)
4. **Provide accurate sender identity** (business name + physical postal address) — required
   for sending and enforced by the readiness gate.
5. **Not send** unlawful, deceptive, harassing, or prohibited-industry content `[define]`.
6. **Remain the data controller** for their prospect/recipient data and indemnify ACAOS for
   their sending decisions `[counsel to scope]`.

Breach may result in `[suspension / termination — counsel to define]`.

## Part B — Data Processing Addendum (DPA) outline

> Counsel to convert this outline into the binding DPA. Key clauses to cover:

- **Roles:** customer = controller; ACAOS = processor; the entities in
  [`subprocessors.md`](./subprocessors.md) = sub-processors.
- **Subject-matter & duration:** processing of prospect/recipient personal data for the
  duration of the subscription.
- **Nature & purpose:** outreach CRM — research, generation, sending, reply tracking.
- **Categories of data subjects / data:** business contacts; name, business email, company,
  derived research, message content.
- **Processor obligations (Art. 28(3)):** process only on documented instructions;
  confidentiality; security measures (see below); sub-processor flow-down + the disclosure
  list with a change-notification mechanism; assist with data-subject requests; assist with
  breach notification; delete/return data on termination; allow audits.
- **Security measures (Annex — ACAOS implements):** encryption in transit (TLS) and of stored
  mail credentials/TOTP secrets at rest (AES-256-GCM); tenant isolation; RBAC + step-up auth
  for sensitive actions; retention purge of aged data; access logging/audit events; documented
  recovery (`docs/RECOVERY.md`).
- **Data-subject rights:** the product supports per-lead deletion and transactional workspace
  erasure (`DELETE /api/workspaces/:id`) for Art. 17 requests.
- **International transfers:** `[counsel — SCCs / adequacy for OpenAI, Stripe, discovery
  providers]`.
- **Sub-processor changes:** notice via the versioned disclosure (`SUBPROCESSORS_VERSION`)
  with a `[N]`-day objection window `[counsel to set]`.

`[Governing law, liability, indemnity, term — counsel.]`
