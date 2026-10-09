# Acquisition OS — cross-customer intelligence (phase 13)

This phase pools win rates per commercial-event kind across workspaces, so each
workspace can compare its own results to the wider picture. For example: "across
ACAOS, capacity expansions win 33% of the time; yours win 33%".

| Code | What |
|---|---|
| `lib/networkIntelligence.ts` | Pooling (pure), the daily recompute, reads, and participation |
| `Workspace.networkOptInAt` | When the workspace opted in; null means it hasn't (the default) |
| `NetworkBenchmark` | The pooled rows. A global table that isn't tenant-scoped (additive migration). |
| `GET /api/commercial-opportunities/network-benchmarks` | The pool beside the workspace's own figures (members of opted-in workspaces) |
| `PUT /api/commercial-opportunities/network-participation` | `{ workspaceId, optIn }`, admin only, audited as `network.opt_in` / `network.opt_out` |
| Worker `retention-purge` (daily) | Recomputes the pool, best-effort |

## Privacy rules

These were decided with the user: opt-in, and k = 10 (raised from 5 in UQ-30).

1. **Opt-in only.** A workspace contributes only after an admin opts it in, and only
   opted-in workspaces can read the pool. A non-participating workspace gets 403.
2. **Aggregated and anonymised.** Only per-kind counts leave a workspace:
   opportunities, conversations, closed and won. A published row holds the
   event kind, the number of contributing workspaces, the summed counts and two
   rates. It holds no workspace id, company, evidence, offer or opportunity id.
3. **Anonymity floor.** A kind is published only with **at least 10 contributing
   workspaces and 50 closed outcomes**. A workspace counts as a contributor to a
   kind only if it has a closed outcome of that kind.
   - `NETWORK_MIN_CONTRIBUTORS` and `NETWORK_MIN_CLOSED` can raise the floors but
     never lower them.
   - Kinds below the floor are withheld entirely. Their counts are not published
     anywhere.
4. **No exact pooled counts reach a customer.** The stored rows are exact, for
   the recompute only. The read API returns count bands (`10–24`, `25–49`, …
   `1000+`) and rates rounded to 5 percentage points, and it withholds a rate
   unless its hits and its misses each number at least 5. A workspace sees its
   own exact figures beside the pool, so exact pooled totals would let it
   subtract itself out and learn the other workspaces' combined totals.
5. **Tenant isolation holds.** Each workspace's figures come from the phase 12
   calibration report, computed inside its own tenant context
   (`runInWorkspaceContext`). Only the pooling step crosses workspaces, and it is
   pure arithmetic on counts.

## Lifecycle

The table is recomputed whole, inside one transaction (delete, then insert), by the
daily platform job.
- **Opting out** takes effect at the next recompute, within a day. The response and
  the audit event record the change at once, and the workspace loses read access
  straight away.
- **Staying opted in** keeps the original opt-in time.

## Not built yet

There's no web UI for the opt-in toggle or the benchmark view. Phase 14 (the
operator console) is the natural place for both, and the API is ready.
