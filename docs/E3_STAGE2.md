# E3.2 — Deterministic evidence extraction

`extractWebsiteEvidence(document)` accepts only the `WebsiteDocument` envelope from E3.1. It removes typical hidden HTML sections, scripts, styles, comments, tags and attributes; normalizes character entities; and emits bounded, exact textual excerpts and content hashes. No AI model is involved. Excerpts are `source_observed` and `unverified`, **never verified business facts, verified consent, or authorization to send**.

## Limitations and release gates
- The minimal HTML tokenizer is best-effort, not a standards-compliant HTML parser. Browser-rendered content, malformed/nested HTML, hidden CSS, ads, navigation and dynamically rendered elements require a hardened parser and policy review in production.
- A claim is evidence that *the site displayed the words*, not evidence that the business assertion is true. Site ownership, URL, freshness, content authenticity and consent remain separately unverified.
- Do not place `pageText` into model system/developer instructions. Pass only escaped/fenced untrusted data with strict JSON schemas and independent gates. No automatic scoring boost or outreach may follow this extraction.
- The current bounded excerpts are a staging substrate; future persistence must have tenant isolation, dedupe keys, TTL/erasure and audit trails.
- Before production collection: robots/policy compliance, domain permission, concurrency/rate limits, secure egress, strict DOM sanitizer and SSRF penetration testing.

Stage 2 does not add routes, jobs, sends, database schema or rollout flags.
