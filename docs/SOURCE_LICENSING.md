# Work-discovery source licensing

Every work-discovery source in `packages/backend-core/src/lib/opportunitySources.ts`
must have an entry in `SOURCE_LICENCES` (`packages/backend-core/src/lib/sourceRegistry.ts`).
The unit test `tests/lib-source-registry.test.ts` fails if one is missing.

An entry records the licence as established, the terms and evidence links, the
review date, the attribution owed, and one of three commercial-use positions:

| Position | Meaning |
| --- | --- |
| `confirmed` | Commercial reuse is confirmed from an authoritative source (the publisher, or a licence the publisher applies to this exact feed). |
| `unverified` | Not yet confirmed for this feed. The source may still run while the gate is `off` or `observe`. |
| `prohibited` | The terms forbid our use. |

Moving a source to `confirmed` needs the evidence added to its entry in the same commit.

## Current positions (reviewed 17 Oct 2026)

| Source | Position | Licence | Why |
| --- | --- | --- | --- |
| `austender` | unverified | CC BY 3.0 AU for the same data via Finance's [contract-notice export](https://researchdata.edu.au/austender-contract-notice-export/3804931); API itself unstated | The [OCDS API](https://github.com/austender/austender-ocds-api) states no data licence (its MIT licence covers code). The [Open Contracting registry](https://data.open-contracting.org/en/publication/19) also lists CC BY 3.0 AU. Ask the Department of Finance to confirm the API feed. |
| `planningalerts` | unverified | Commercial plan required | [Community plan is non-commercial](https://api.planningalerts.org.au/api/howto); the Standard plan (A$3,850/month + GST) is not held. Not configured in production. |

## The gate: `SOURCE_LICENCE_GATE`

| Value | Effect |
| --- | --- |
| unset, empty, `off` | Gate never consulted; discovery behaves exactly as before. |
| `observe` | Every source runs; one warning per sweep for a source that is not `confirmed`. |
| `enforce` | Sources that are not `confirmed` are skipped (recorded like an unconfigured source). Refused at configuration time while it would stop a configured source. |
| anything else | Configuration error: API boot fails; the worker's sweep fetches nothing and records the error on every source. |

Because AusTender is `unverified`, `enforce` is refused today. This is deliberate:
the gate must never switch off live discovery as a side effect.
