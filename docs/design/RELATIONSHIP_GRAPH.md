# Design: Construction Relationship Graph (revision 2)

**Status:** Draft for approval. **Design only.** No application code, migration, merge, deploy or
production setting is part of this document or of the PR that carries it.

**Supersedes:** the first draft (single `graph_entities` / `graph_relationships` pair, recursive CTE,
`ON DELETE CASCADE` edges, schema-first ordering). That draft's architecture was approved; its schema,
query and sequencing were not. This revision addresses all ten required changes (index in §14).

---

## 1. Goal and non-goals

**Goal.** Let ACAOS answer, with evidence and an explicit "we don't know" when evidence is absent:

> Which builders have been appointed to commercial projects in Brisbane that need an electrical
> package, and what supports each link?

**Non-goals (v1).**
- No graph database, embeddings or vector store. PostgreSQL only.
- No LLM decides an edge. Ingestion and scoring are deterministic and reproducible, like
  `opportunityMatch.ts` and `commercialEventEngine.ts`.
- No outreach. A graph entity is **not** a `Prospect`; creating or linking one never creates a send
  path. Converting an organisation into a `Prospect` stays the existing, explicit user action.
- No cross-tenant sharing of any row (see §4).
- No change to the existing sweep, scoring, approvals or `SOURCE_LICENCE_GATE` behaviour.

## 2. Corrected graph model

The first draft typed *entities* as `developer` / `builder` / `subcontractor`. That is wrong: the same
company is the developer on one project and the builder on another. **Role belongs on the edge, not the
node.**

### 2.1 Nodes: three kinds

| Kind | Meaning | Backed by (no duplication) |
|---|---|---|
| `ORGANISATION` | A company, whatever role it plays | optional link to `Prospect` (`companyNameKey`, `domainKey`); ABN as in `Opportunity.counterpartyAbn` / `Workspace.senderAbn` |
| `PROJECT` | A contract award or development application | `Opportunity` (1:1 via `opportunityId`; location, value, kind, `source`, `externalId` stay on `Opportunity`) |
| `TRADE_PACKAGE` | A trade taxonomy node (e.g. electrical) | codes from `opportunityTaxonomy.ts` (`TradeId`), the same taxonomy that fills `Opportunity.matchedTrades` |

Trade nodes are taxonomy nodes, not per-project rows. "Project P requires electrical" is an edge from
P to the electrical node, so that **requirement carries its own evidence**.

### 2.2 Edges: separate relationships, separate evidence

| Edge type | From → To | Question it answers | Class |
|---|---|---|---|
| `APPOINTED_BUILDER` | PROJECT → ORGANISATION | Who was appointed to build this? | appointment |
| `DEVELOPED_BY` | PROJECT → ORGANISATION | Who is the client / developer / applicant? | appointment |
| `REQUIRES_TRADE` | PROJECT → TRADE_PACKAGE | Does this project need this trade? | requirement |
| `SUBCONTRACT_AWARDED` | ORGANISATION → ORGANISATION (builder → sub), scoped to a trade via `tradeEntityId` | Who won this package? | appointment, **workspace-private only in v1** |
| `ASSOCIATED_WITH` | ORGANISATION → ORGANISATION | Have they worked together before? | **inferred historical association, never an appointment** |

- **Appointment and requirement are different edges with different evidence rules** (§6). A project that
  provably needs electrical work but has no known builder yields a `REQUIRES_TRADE` edge and **no**
  `APPOINTED_BUILDER` edge, which the query reports as `UNKNOWN_BUILDER`.
- `ASSOCIATED_WITH` can never reach `verification = CONFIRMED`, never answers "who was appointed", and is
  shown only in a separately labelled "historical associations" list.
- The database enforces valid endpoint kinds per edge type (§5.3), so `REQUIRES_TRADE` cannot point at an
  organisation.

### 2.3 Verified vs inferred

- `CONFIRMED`: an appointment/requirement stated by a primary record, with an entity match strong enough
  to trust (§6.2). Categorical, not "score ≥ N".
- `INFERRED`: everything else (name-only matches, heuristics, website claims, historical patterns).
  Never presented as an appointment.

## 3. Mapping to existing Prisma models (reuse, don't duplicate)

| Concern | Existing model/field | Graph treatment |
|---|---|---|
| Tenant | `Workspace` | every graph row has `workspaceId`; cascade from `Workspace` |
| Company identity | `Prospect.companyNameKey` (via `normalizeCompanyNameKey` in `lib/normalize.ts`), `domainKey`; `Opportunity.counterpartyName/Abn` | `GraphEntity.nameKey` uses the **same normaliser**; optional `prospectId` link, no copied contact data |
| Project | `Opportunity` (`source`, `externalId`, `kind`, `region`, `locality`, `publishedAt`, `sourceUrl`, `contentHash`, `matchedTrades`, `rawData`) | `PROJECT` entity references it; location stays on `Opportunity` |
| Trade taxonomy | `opportunityTaxonomy.ts` `TradeId` | `GraphEntity.tradeCode` |
| Appointment evidence | `Opportunity` (CONTRACT_AWARD: counterparty = awarded supplier, buyer = agency) | `GraphEdgeEvidence.opportunityId` |
| Corroborating signals | `Signal`, `EvidenceSource`, `EvidenceLink`, `CommercialEvent` | `GraphEdgeEvidence.signalId` / `evidenceSourceId`; **not** re-modelled. A `CommercialEvent` stays an organisation-level event; the graph does not replace it |
| Raw website claims | `WebsiteEvidenceClaim` (schema comment: *"NOT verified business truth"*) | evidence allowed, **capped at INFERRED** (§6.2) |
| Licence/provenance | `SOURCE_LICENCES`, `sourceGateDecision` (`lib/sourceRegistry.ts`, PR #413) | snapshot at ingest + live check at read (§8) |
| Audit | `AuditEvent` (FK-free, append-only) | graph review actions also write `AuditEvent`; domain history lives in `GraphEdgeReview` (§7) |
| Reviewer | `User`, `Membership.role` (`docs/RBAC.md`) | `GraphEdgeReview.reviewerUserId` |
| Confidence scale | `CommercialEvent.confidence Int`, `Signal.strength Int` | integer 0–100 (the first draft's 0.00–1.00 numeric is dropped for consistency) |
| Approvals for learning changes | `LearningRecommendation` | calibration changes use the same propose → human-approve pattern (§9.3) |
| Evidence **files** (`EvidenceFile*`, technician photos) | field-ops evidence | **out of scope**; unrelated to public-record provenance |

New tables: `GraphEntity`, `GraphEdge`, `GraphEdgeEvidence`, `GraphEdgeReview`. Nothing else.

## 4. Tenancy and public-source vs private data

**Decision (recommended): v1 is strictly workspace-scoped. There is no shared/global tier.**

- Public-source data (AusTender notices, council DAs) is ingested **per workspace**, exactly as
  `Opportunity` already is (`@@unique([workspaceId, source, externalId])`). Two workspaces that see the
  same award each hold their own rows. This duplicates some public facts but removes cross-tenant
  leakage by construction and keeps licence/attribution decisions per workspace.
- Each evidence row carries `visibility`: `PUBLIC_SOURCE` (from a registered, licensed discovery source)
  or `WORKSPACE_PRIVATE` (user-entered, CRM/reply-derived, private signals). `WORKSPACE_PRIVATE` evidence
  can only support edges in its own workspace, which is already guaranteed by the above, and is **never**
  eligible for any cross-workspace aggregate. The only cross-tenant path stays the existing anonymised
  `NetworkBenchmark` (counts and rates, k-anonymity floor); the graph adds nothing to it in v1.
- **Rejected for v1:** a shared `PublicEntity` table with nullable `workspaceId`. It breaks the
  composite-key isolation in §5, couples every tenant to one licence decision, and makes erasure harder.
  It can be revisited as a separate design once source licences are `confirmed`.

**Database-level enforcement** (§5): every cross-table reference is a composite `(workspaceId, id)`
foreign key, so a row in workspace A cannot reference a row in workspace B even if application code is
wrong. This follows the precedent already in the schema (`EvidenceFile @@unique([workspaceId, id])`,
referenced by `EvidenceDeletionRequest(workspaceId, fileId)`).

## 5. Revised Prisma model proposals (design only)

Proposals only; **not added to `schema.prisma`** by this PR. Names follow existing conventions
(`cuid()` string ids, `workspaceId` first in compound keys/indexes).

### 5.1 Prerequisite additive changes to existing models

Composite foreign keys need a unique target on `(workspaceId, id)`. Add (redundant with the primary key,
needed only as an FK target):

```prisma
model Prospect              { /* … */ @@unique([workspaceId, id]) }
model Opportunity           { /* … */ @@unique([workspaceId, id]) }
model Signal                { /* … */ @@unique([workspaceId, id]) }
model EvidenceSource        { /* … */ @@unique([workspaceId, id]) }
model WebsiteEvidenceClaim  { /* … */ @@unique([workspaceId, id]) }
```

### 5.2 New enums

```prisma
enum GraphEntityKind        { ORGANISATION PROJECT TRADE_PACKAGE }
enum GraphEdgeType          { APPOINTED_BUILDER DEVELOPED_BY REQUIRES_TRADE SUBCONTRACT_AWARDED ASSOCIATED_WITH }
enum GraphVerification      { CONFIRMED INFERRED }
enum GraphEdgeStatus        { ACTIVE CONFLICTED SUPERSEDED REJECTED EXPIRED UNSUPPORTED }
enum GraphEvidenceVisibility{ PUBLIC_SOURCE WORKSPACE_PRIVATE }
enum GraphEvidenceClass     { PRIMARY_RECORD SECONDARY_REPORT WEBSITE_CLAIM HISTORICAL_PATTERN MANUAL_ENTRY }
enum GraphEntityMatch       { ABN_EXACT NAME_EXACT NAME_FUZZY REVIEWER_VERIFIED }
enum GraphReviewAction      { PROMOTE DEMOTE REJECT ADJUST_CONFIDENCE RESOLVE_CONFLICT SUPERSEDE REOPEN }
```

### 5.3 Models

```prisma
model GraphEntity {
  id            String          @id @default(cuid())
  workspaceId   String
  kind          GraphEntityKind
  displayName   String
  // ORGANISATION only. Same normaliser as Prospect.companyNameKey.
  nameKey       String?
  abn           String?         // ORGANISATION; 11 digits, verified form only
  tradeCode     String?         // TRADE_PACKAGE only (TradeId)
  prospectId    String?         // ORGANISATION: optional link, never auto-created
  opportunityId String?         // PROJECT: the Opportunity this node is
  createdAt     DateTime        @default(now())
  updatedAt     DateTime        @updatedAt
  workspace     Workspace       @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  prospect      Prospect?       @relation(fields: [workspaceId, prospectId], references: [workspaceId, id], onDelete: NoAction)
  opportunity   Opportunity?    @relation(fields: [workspaceId, opportunityId], references: [workspaceId, id], onDelete: NoAction)
  outEdges      GraphEdge[]     @relation("EdgeSource")
  inEdges       GraphEdge[]     @relation("EdgeTarget")

  @@unique([workspaceId, id])
  @@unique([workspaceId, id, kind])           // FK target that carries the kind
  @@index([workspaceId, kind])
  @@index([workspaceId, nameKey])
  // Raw-SQL partial uniques (Prisma cannot express them; same approach as Prospect's domain unique):
  //   (workspaceId, abn)        WHERE kind = 'ORGANISATION' AND abn IS NOT NULL
  //   (workspaceId, nameKey)    WHERE kind = 'ORGANISATION' AND abn IS NULL AND nameKey IS NOT NULL
  //   (workspaceId, opportunityId) WHERE kind = 'PROJECT'
  //   (workspaceId, tradeCode)  WHERE kind = 'TRADE_PACKAGE'
  // CHECKs: kind-specific columns (ORGANISATION: nameKey NOT NULL; PROJECT: opportunityId NOT NULL;
  //   TRADE_PACKAGE: tradeCode NOT NULL; other kinds' columns NULL).
}

model GraphEdge {
  id               String            @id @default(cuid())
  workspaceId      String
  edgeType         GraphEdgeType
  sourceEntityId   String
  sourceKind       GraphEntityKind
  targetEntityId   String
  targetKind       GraphEntityKind
  tradeEntityId    String?           // SUBCONTRACT_AWARDED: which package
  verification     GraphVerification @default(INFERRED)
  status           GraphEdgeStatus   @default(ACTIVE)
  confidence       Int               // 0–100 (§9)
  entityMatch      GraphEntityMatch  // weakest match among the endpoints' resolution
  // The evidence row that justifies CONFIRMED (must belong to THIS edge; DB-enforced).
  basisEvidenceId  String?
  validFrom        DateTime?
  validUntil       DateTime?
  supersededById   String?
  conflictGroupKey String?           // edges competing for the same slot share a key
  dedupeKey        String            // sha256(edgeType|source|target|trade|validFrom day)
  createdAt        DateTime          @default(now())
  updatedAt        DateTime          @updatedAt
  workspace        Workspace         @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  source           GraphEntity       @relation("EdgeSource", fields: [workspaceId, sourceEntityId, sourceKind], references: [workspaceId, id, kind], onDelete: NoAction)
  target           GraphEntity       @relation("EdgeTarget", fields: [workspaceId, targetEntityId, targetKind], references: [workspaceId, id, kind], onDelete: NoAction)
  supersededBy     GraphEdge?        @relation("Supersession", fields: [workspaceId, supersededById], references: [workspaceId, id], onDelete: NoAction)
  supersedes       GraphEdge[]       @relation("Supersession")
  evidence         GraphEdgeEvidence[]
  reviews          GraphEdgeReview[]

  @@unique([workspaceId, id])
  @@unique([workspaceId, dedupeKey])
  @@index([workspaceId, edgeType, status])
  @@index([workspaceId, sourceEntityId, edgeType])
  @@index([workspaceId, targetEntityId, edgeType])
  @@index([workspaceId, conflictGroupKey])
  // CHECKs (raw SQL), all enforced by the database:
  //   endpoint kinds per edgeType:
  //     APPOINTED_BUILDER, DEVELOPED_BY : PROJECT -> ORGANISATION
  //     REQUIRES_TRADE                  : PROJECT -> TRADE_PACKAGE
  //     SUBCONTRACT_AWARDED             : ORGANISATION -> ORGANISATION, tradeEntityId NOT NULL
  //     ASSOCIATED_WITH                 : ORGANISATION -> ORGANISATION, verification = INFERRED
  //   confidence BETWEEN 0 AND 100
  //   verification = 'CONFIRMED' => basisEvidenceId IS NOT NULL AND confidence >= 80
  //   verification = 'INFERRED'  => confidence <= 79
  //   validUntil IS NULL OR validFrom IS NULL OR validUntil > validFrom
  //   status = 'SUPERSEDED' <=> supersededById IS NOT NULL
  // Composite FK (workspaceId, id, basisEvidenceId) -> GraphEdgeEvidence(workspaceId, edgeId, id)
  //   so the confirming evidence provably belongs to this same edge.
}

model GraphEdgeEvidence {
  id                    String                   @id @default(cuid())
  workspaceId           String
  edgeId                String
  evidenceClass         GraphEvidenceClass
  visibility            GraphEvidenceVisibility
  // Exactly ONE of these references is set (CHECK), each a composite workspace FK:
  opportunityId         String?
  signalId              String?
  evidenceSourceId      String?
  websiteEvidenceClaimId String?
  // Snapshot, so the edge stays explainable if the referenced row later changes or expires:
  sourceKey             String                   // registry key, e.g. 'austender'; 'manual' for MANUAL_ENTRY
  sourceUrl             String?
  excerpt               String                   // the exact statement relied on
  contentHash           String                   // hash of the referenced content at ingest
  observedAt            DateTime                 // when the source says it happened
  ingestedAt            DateTime                 @default(now())
  // Licence snapshot (PR #413 registry) at ingest; eligibility is also re-checked live at read:
  licenceCommercialUse  String                   // 'confirmed' | 'unverified' | 'prohibited' | 'n/a'
  licenceReviewedAt     String?                  // registry reviewedAt (YYYY-MM-DD)
  attribution           String?                  // text owed wherever shown
  retractedAt           DateTime?                // evidence withdrawn/expired; kept for audit
  edge                  GraphEdge                @relation(fields: [workspaceId, edgeId], references: [workspaceId, id], onDelete: Cascade)
  workspace             Workspace                @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, id])
  @@unique([workspaceId, edgeId, id])          // FK target for GraphEdge.basisEvidenceId
  @@unique([workspaceId, edgeId, contentHash]) // dedupe: same content never attached twice
  @@index([workspaceId, edgeId])
  @@index([workspaceId, sourceKey])
  // Composite workspace FKs (onDelete NoAction) to Opportunity / Signal / EvidenceSource /
  // WebsiteEvidenceClaim on (workspaceId, <ref>Id).
}

model GraphEdgeReview {            // append-only
  id              String             @id @default(cuid())
  workspaceId     String
  edgeId          String
  reviewerUserId  String
  action          GraphReviewAction
  fromStatus      GraphEdgeStatus
  toStatus        GraphEdgeStatus
  fromVerification GraphVerification
  toVerification  GraphVerification
  fromConfidence  Int
  toConfidence    Int
  reason          String             // required, non-empty
  evidenceIds     String[]           // evidence the reviewer was shown
  createdAt       DateTime           @default(now())
  edge            GraphEdge          @relation(fields: [workspaceId, edgeId], references: [workspaceId, id], onDelete: Cascade)
  reviewer        User               @relation(fields: [reviewerUserId], references: [id], onDelete: NoAction)

  @@index([workspaceId, edgeId, createdAt])
  // A trigger rejects UPDATE (append-only). DELETE happens only through workspace erasure cascade.
}
```

**Why these choices**
- **`NoAction` rather than `Restrict`/`SetNull` on references to existing tables.** `NoAction` is checked
  at end of statement, so a `Workspace` delete can cascade through both sides in one statement.
  `SetNull` would null `workspaceId` too (composite key) and fail. Consequence: deleting an
  `Opportunity` that a graph row references is blocked until the graph rows are removed. An erasure path
  (retract evidence, then delete) is part of PR C and tested.
- **Why `sourceKind`/`targetKind` on the edge.** An FK to `(workspaceId, id, kind)` plus the `CHECK` on
  `(edgeType, sourceKind, targetKind)` makes illegal shapes unrepresentable.
- **No `metadata JSONB` bag.** Location and attributes stay on `Opportunity`; the first draft's
  `p.metadata->>'location'` was an unindexed duplicate.

## 6. Relationship-specific evidence requirements

### 6.1 Requirements per edge type

| Edge | CONFIRMED requires | Anything weaker is |
|---|---|---|
| `APPOINTED_BUILDER` | ≥ 1 `PRIMARY_RECORD` evidence: a `CONTRACT_AWARD` `Opportunity` from a registered source naming the organisation as the awarded supplier (`counterpartyName`/`counterpartyAbn`), **and** entity match `ABN_EXACT` or `REVIEWER_VERIFIED` | `INFERRED` (e.g. name-only match, secondary report, website claim) |
| `DEVELOPED_BY` | ≥ 1 `PRIMARY_RECORD` stating the client/applicant/owner (today: `buyerName` on a contract award; a DA applicant only if the source exposes it) | `INFERRED` |
| `REQUIRES_TRADE` | ≥ 1 `PRIMARY_RECORD` whose scope text names the trade (the deterministic keyword rules in `opportunityMatch.ts`/`opportunityTaxonomy.ts`) | `INFERRED` (trade implied by build type only, `IMPLIED_BY_BUILD`) |
| `SUBCONTRACT_AWARDED` | `MANUAL_ENTRY` by an authorised user, with the document attached or cited. No public source exists today | n/a: no inferred form in v1 |
| `ASSOCIATED_WITH` | cannot be CONFIRMED | `INFERRED` only; needs ≥ 2 distinct projects where both appear |

Hard rules:
1. **A development application alone never confirms a builder.** It identifies an applicant, not a
   contractor.
2. **`WEBSITE_CLAIM` and `SECONDARY_REPORT` evidence can support `INFERRED` only.** Website claims are
   documented in the schema as raw observation, not verified truth.
3. **Name-only entity matches (`NAME_EXACT`, `NAME_FUZZY`) can never produce `CONFIRMED`.**
4. A `CONFIRMED` edge needs `basisEvidenceId`; the database rejects it otherwise (§5.3).
5. Evidence from a `prohibited` source is never ingested (§8).

### 6.2 Entity resolution

Order of trust: `ABN_EXACT` > `REVIEWER_VERIFIED` > `NAME_EXACT` (identical `normalizeCompanyNameKey`) >
`NAME_FUZZY`. `NAME_FUZZY` matches create no edge on their own; they enter the review queue (§7). Entity
merge/split tooling is out of scope for v1; ABN uniqueness prevents duplicate organisations where ABNs
exist, name-only duplicates are tolerated and visible.

## 7. Provenance, supersession, dedup and reviewer audit

- **Multiple evidence references.** An edge has many `GraphEdgeEvidence` rows. Corroboration counts
  *independent* `sourceKey`s, mirroring `commercialEventEngine`'s independent-source rule.
- **Temporal validity.** `validFrom`/`validUntil` on edges (from the source's dates, e.g.
  `Opportunity.publishedAt`); an edge past `validUntil`, or whose every evidence is retracted/expired,
  becomes `EXPIRED` / `UNSUPPORTED` and stops appearing as a current answer. History is kept.
- **Supersession.** Never overwrite. A correction creates a new edge and sets the old edge `SUPERSEDED`
  with `supersededById`. Automatic supersession happens only when the *same* source/`externalId`
  re-delivers changed content (`Opportunity.contentHash` differs). Anything cross-source is a conflict
  and needs a reviewer (§9.4).
- **Deduplication.** `dedupeKey` unique per workspace for edges; `(edgeId, contentHash)` unique for
  evidence; partial unique indexes for entities (§5.3). Re-ingesting the same Opportunity is a no-op.
- **Reviewer audit history.** Every reviewer action appends a `GraphEdgeReview` (who, action, before →
  after status/verification/confidence, mandatory reason, the evidence ids shown) and a matching
  `AuditEvent`. `UPDATE` on review rows is blocked by trigger. The reviewer UI renders the underlying
  evidence (excerpt, source link, attribution), not an AI summary.
- **Review triggers.** Edge with confidence 40–69, any `NAME_FUZZY` candidate, any `CONFLICTED` group,
  any proposed `PROMOTE`. Who may review is verified against the code in §7.1.

### 7.1 Reviewer RBAC (verified against the code, 2026-10-17)

What exists today:
- Roles are `member ⊂ admin ⊂ owner` on `Membership.role`. Members hold **no** named capability
  (`MEMBER_PERMISSIONS = []` in `apps/api/src/lib/permissions.ts`); platform admin (`User.isPlatformAdmin`)
  is a separate cross-tenant axis and is **not** a workspace reviewer.
- Approving an outreach draft is **admin or owner**: the routes in `apps/api/src/routes/leads.ts`
  (approve, and the two sibling draft actions) call `assertMinimumWorkspaceRole(..., 'admin')`, and the
  matching named capability `campaign:approve_draft` is in `ADMIN_PERMISSIONS`.
- Destructive evidence governance is **owner-only** (`evidence:govern`).
- Every boundary in the matrix is pinned by `tests/lib-permissions.test.ts` and documented in `docs/RBAC.md`.

Resolution of Decision D4 (proposed, for approval):
- Add one named capability, `graph:review`, to `ADMIN_PERMISSIONS` (so admin and owner, never member).
  It covers promote, demote, reject, adjust confidence and conflict resolution, the same tier as
  approving a draft. It is a capability, not a bare role check, so it appears in the matrix and the test.
- Reading graph edges and evidence while in `shadow` mode: admin or owner via the same capability.
  Members see nothing from the graph until `on` mode, and then only through existing recommendation
  surfaces.
- Retracting or deleting graph rows that reference field-ops `EvidenceFile` data is **not** a graph
  action; it stays under the existing owner-only `evidence:govern` path. Graph evidence is public-record
  and workspace-private text, not technician photos (§3).
- Delivered in PR 6 together with `docs/RBAC.md` matrix rows and the `tests/lib-permissions.test.ts`
  assertions (admin and owner allowed, member and non-member denied). No RBAC change is made in PR 1.

## 8. Source licensing and provenance (PR #413)

The graph must not become a side door around the licence registry (`lib/sourceRegistry.ts`,
`docs/SOURCE_LICENSING.md`). Today both registered sources are `unverified` (AusTender pending Finance
confirmation; PlanningAlerts non-commercial plan only).

1. **Single source of truth.** Ingestion calls `getSourceLicence` / `sourceGateDecision` from the registry;
   it does not duplicate licence logic. Evidence whose `Opportunity.source` has **no registry entry** is
   rejected (matches the registry's own "every source must have an entry" rule).
2. **`prohibited` is never ingested**, at any gate mode. (The graph is new, so it can be stricter than the
   gate's `off`-mode compatibility behaviour without changing anything that exists.)
3. **`unverified` follows `SOURCE_LICENCE_GATE`:** `off` / `observe` ingest (observe logs once per run,
   as the sweep does); `enforce` skips. Because `enforce` is currently refused at boot while AusTender is
   `unverified`, the graph inherits that and does not change it.
4. **Snapshot + live check.** At ingest, store `licenceCommercialUse`, `licenceReviewedAt` and
   `attribution` on each evidence row for audit. At read time, **eligibility is recomputed from the live
   registry** and passed to the query as `eligibleSources` (§10), so a source downgraded to `prohibited`
   in a later commit stops supporting edges immediately without a data migration.
5. **Outward use requires `confirmed`** (Decision D1). Edges supported only by `unverified` evidence are
   visible in shadow/review surfaces and the eval harness, but **cannot feed recommendations or outreach**
   until the source is `confirmed`. Practical effect today: shadow mode only, until Finance confirms the
   AusTender feed. This is deliberately stricter than the sweep gate.
6. **Attribution.** Wherever an edge's evidence is shown, render the stored `attribution` string.
7. **Pull, not push.** A separate worker job reads `Opportunity` by `lastChangedAt` cursor. It does not
   hook into or modify `opportunitySweep.ts`, so #413's behaviour is untouched.
8. **Website and private evidence** is not in the discovery registry. `WORKSPACE_PRIVATE` /
   `WEBSITE_CLAIM` evidence records `licenceCommercialUse = 'n/a'`, is limited to `INFERRED`
   (website) or manual entries by an authorised user, and follows the workspace's own retention
   (`docs/DATA_RETENTION.md`): expiry retracts the evidence and re-evaluates the edge.

## 9. Confidence, calibration and conflicts

### 9.1 Scale and bands (integer 0–100, DB-checked)

| Band | Meaning | Treatment |
|---|---|---|
| 80–100 | `CONFIRMED` only | usable outward (if licence-eligible) |
| 70–79 | strong `INFERRED` | usable outward, labelled inferred |
| 40–69 | uncertain | **review queue**; not shown outward |
| < 40 | weak | suppressed from outward recommendations; kept for audit |

### 9.2 Deterministic scoring (initial constants, to be recalibrated)

`score = base(evidenceClass) + entityMatch + corroboration − ageDecay − conflictPenalty`, clamped to the
band the verification state allows.

| Term | Initial value |
|---|---|
| base | PRIMARY_RECORD 85, SECONDARY_REPORT 55, MANUAL_ENTRY 75, WEBSITE_CLAIM 40, HISTORICAL_PATTERN 35 |
| entityMatch | ABN_EXACT +10, REVIEWER_VERIFIED +10, NAME_EXACT 0, NAME_FUZZY −20 |
| corroboration | +5 per additional independent source, max +10 |
| ageDecay | −1 per 30 days beyond 90 days since `observedAt`, max −20 |
| conflictPenalty | −30 on every edge in a conflict group |

### 9.3 Calibration

Initial constants are guesses until measured. Calibration is **evidence-driven and human-approved**:
1. Score the labelled gold set (§11); build a reliability table per 10-point band.
2. A band with < 30 labelled edges is **uncalibrated** and its outward use is capped one band lower.
3. Constant changes are proposed as a reviewable change (same propose → human-approve pattern as
   `LearningRecommendation`), shipped as a versioned constants file, and re-run against the eval with
   results attached. Nothing auto-tunes.

### 9.4 Conflicting evidence

A *slot* is `(project, APPOINTED_BUILDER)` (likewise `DEVELOPED_BY`). Edges competing for a slot share a
`conflictGroupKey`.
- Two live edges to **different** organisations with overlapping validity → all edges in the group become
  `CONFLICTED`, each takes the conflict penalty, and **neither is output as the appointed builder**.
  The query returns `CONFLICTING_EVIDENCE` with all candidates and their evidence.
- A reviewer resolves by: choosing one (others → `SUPERSEDED`/`REJECTED` with reason), or recording both as
  valid (e.g. joint venture) by creating a role-scoped second edge. Resolution is a `RESOLVE_CONFLICT`
  review row.
- Same-source re-delivery with changed supplier is automatic supersession (§7), not a conflict.
- Evidence that disagrees with a `CONFIRMED` edge demotes it to `CONFLICTED` pending review; `CONFIRMED`
  is never silently overwritten.

## 10. Corrected example SQL

The first draft used a recursive CTE, which is wrong here: appointment and requirement are two separate
single-hop edges from the same project, and recursion would walk edges of different meaning. Below is a
non-recursive, fully tenant-scoped query. Every join carries `workspaceId`, so it uses the composite
indexes and cannot cross tenants. Identifiers are quoted because Prisma creates camel-cased columns.

Parameters: `$1` workspaceId · `$2` tradeCode (e.g. `electrical`) · `$3` region (e.g. `QLD`) ·
`$4` locality pattern (e.g. `%Brisbane%`) · `$5` minimum confidence (e.g. 70) · `$6` eligible source keys
(`text[]`, computed by the service from the live registry and mode, §8.4–8.5).

```sql
WITH requirement AS (
  -- Projects in scope that provably require the trade, via their own REQUIRES_TRADE edge.
  SELECT p."id"            AS project_id,
         o."title"         AS project_name,
         o."locality"      AS locality,
         r."id"            AS requirement_edge_id,
         r."verification"  AS requirement_verification
  FROM "GraphEntity" p
  JOIN "Opportunity" o
    ON o."workspaceId" = p."workspaceId" AND o."id" = p."opportunityId"
  JOIN "GraphEdge" r
    ON r."workspaceId" = p."workspaceId"
   AND r."sourceEntityId" = p."id"
   AND r."edgeType" = 'REQUIRES_TRADE'
   AND r."status" = 'ACTIVE'
   AND (r."validUntil" IS NULL OR r."validUntil" > now())
  JOIN "GraphEntity" t
    ON t."workspaceId" = r."workspaceId" AND t."id" = r."targetEntityId"
   AND t."kind" = 'TRADE_PACKAGE' AND t."tradeCode" = $2
  WHERE p."workspaceId" = $1
    AND p."kind" = 'PROJECT'
    AND o."region" = $3
    AND o."locality" ILIKE $4
    AND r."confidence" >= $5
    AND EXISTS (                         -- requirement itself must be licence-eligible
      SELECT 1 FROM "GraphEdgeEvidence" ev
      WHERE ev."workspaceId" = r."workspaceId" AND ev."edgeId" = r."id"
        AND ev."retractedAt" IS NULL AND ev."sourceKey" = ANY ($6))
),
builder AS (
  -- Appointment edges for those same projects, from a separate relationship with its own evidence.
  SELECT q.project_id,
         count(DISTINCT a."targetEntityId")                      AS distinct_builders,
         bool_or(a."status" = 'CONFLICTED')                      AS flagged_conflict,
         bool_or(a."verification" = 'CONFIRMED')                 AS any_confirmed,
         jsonb_agg(jsonb_build_object(
           'builderEntityId', b."id",
           'builderName',     b."displayName",
           'abn',             b."abn",
           'edgeId',          a."id",
           'verification',    a."verification",
           'confidence',      a."confidence",
           'evidence',        (SELECT jsonb_agg(jsonb_build_object(
                                  'evidenceId', ev."id", 'sourceKey', ev."sourceKey",
                                  'sourceUrl',  ev."sourceUrl", 'excerpt', ev."excerpt",
                                  'attribution', ev."attribution"))
                               FROM "GraphEdgeEvidence" ev
                               WHERE ev."workspaceId" = a."workspaceId" AND ev."edgeId" = a."id"
                                 AND ev."retractedAt" IS NULL AND ev."sourceKey" = ANY ($6))
         ) ORDER BY a."confidence" DESC)                         AS candidates
  FROM requirement q
  JOIN "GraphEdge" a
    ON a."workspaceId" = $1
   AND a."sourceEntityId" = q.project_id
   AND a."edgeType" = 'APPOINTED_BUILDER'
   AND a."status" IN ('ACTIVE', 'CONFLICTED')
   AND (a."validUntil" IS NULL OR a."validUntil" > now())
   AND a."confidence" >= $5
  JOIN "GraphEntity" b
    ON b."workspaceId" = a."workspaceId" AND b."id" = a."targetEntityId"
   AND b."kind" = 'ORGANISATION'
  WHERE EXISTS (                         -- at least one licence-eligible, non-retracted evidence row
    SELECT 1 FROM "GraphEdgeEvidence" ev
    WHERE ev."workspaceId" = a."workspaceId" AND ev."edgeId" = a."id"
      AND ev."retractedAt" IS NULL AND ev."sourceKey" = ANY ($6))
  GROUP BY q.project_id
)
SELECT q.project_name,
       q.locality,
       CASE
         WHEN b.project_id IS NULL                              THEN 'UNKNOWN_BUILDER'
         WHEN b.distinct_builders > 1 OR b.flagged_conflict     THEN 'CONFLICTING_EVIDENCE'
         WHEN b.any_confirmed                                   THEN 'CONFIRMED_BUILDER'
         ELSE                                                        'INFERRED_BUILDER'
       END                                         AS builder_status,
       CASE WHEN b.project_id IS NULL THEN '[]'::jsonb ELSE b.candidates END AS candidates,
       q.requirement_verification
FROM requirement q
LEFT JOIN builder b ON b.project_id = q.project_id
ORDER BY (b.project_id IS NULL), q.project_name;
```

Behaviour, all asserted by integration tests (§13):
- **Absent evidence → explicit `UNKNOWN_BUILDER`** with empty candidates. No name or id is fabricated,
  and the row still appears (the `LEFT JOIN` keeps the project that needs the trade).
- **Conflicts surface as `CONFLICTING_EVIDENCE`**, never as a pick.
- **Inferred is labelled `INFERRED_BUILDER`**, never `CONFIRMED_BUILDER`.
- **Licence-ineligible evidence is invisible:** an edge supported only by sources outside `$6` does not
  count, so it cannot appear as a builder.
- **Tenant isolation is redundant by design:** `workspaceId = $1` on the anchor, `workspaceId` equality on
  every join, and composite FKs underneath.
- `ASSOCIATED_WITH` is not joined at all, so historical associations can never answer this question.

## 11. Evaluation: baselines first

The evaluation lands **before any schema** and measures today's behaviour, so the graph has to earn its
place against a number.

### 11.1 Harness

- New `eval/datasets/v2/` (per `eval/README.md`: add `v2`, never edit `v1`). `v2/manifest.json`
  re-lists the five v1 suites unchanged and adds a `relationship-graph` task.
- **Offline, deterministic, no key, no network, no database** (same tier as `npm run eval:offline`).
  Fixtures are anonymised/synthetic or public records with redistribution permitted; no tenant data.
- Each case is a labelled project: its source records (shaped like `Opportunity` rows), the true builder
  (by ABN where known), the true required trades, and the true "unknown" cases.

### 11.2 Baseline method ("no graph")

What the product does today: take `Opportunity.counterpartyName/Abn` from a `CONTRACT_AWARD` as the
builder and `matchedTrades` as the trade set, with the existing name normaliser for matching. Recording
this gives the reference precision/recall, the current false-confirmation exposure, and the current
grounding rate (via `draftGrounding`).

### 11.3 Metrics

| Metric | Definition |
|---|---|
| Builder precision / recall | on projects with a known appointment: correct builder among `CONFIRMED_BUILDER` / found |
| Trade-requirement precision / recall | `REQUIRES_TRADE` vs labelled trades |
| Entity-resolution accuracy | correct merge/non-merge on labelled name/ABN pairs, split by `ABN_EXACT`, `NAME_EXACT`, `NAME_FUZZY` |
| False confirmation rate | `CONFIRMED` edges whose label is wrong, or which lack qualifying primary evidence |
| Unknown correctness | share of "evidence absent" cases that return `UNKNOWN_BUILDER` |
| Citation grounding rate | share of output claims with ≥ 1 eligible evidence row |
| Calibration error | per 10-point band: |claimed − observed accuracy|; ECE overall |
| Conflict detection | share of seeded conflicts returned as `CONFLICTING_EVIDENCE` |
| Licence safety | outward-eligible edges whose only evidence is `prohibited`/`unverified` |
| Tenant leakage | cross-workspace rows returned in an adversarial two-tenant fixture |

### 11.4 Acceptance criteria

Hard invariants (must be exactly met on the gold set and in tests):
- Citation grounding rate = **100%**; every output edge has ≥ 1 licence-eligible evidence row.
- Unknown correctness = **100%**: no fabricated builder when evidence is absent.
- Conflict detection = **100%** on seeded conflicts; none resolved silently.
- Licence safety violations = **0**; tenant leakage = **0**.
- False confirmations: **0** `CONFIRMED` edges lacking qualifying primary evidence or an ABN/verified match.

Quality floors (numbers to be fixed after the baseline is measured; proposed starting values):
- `CONFIRMED` builder precision ≥ **95%** and **not below baseline**; recall ≥ baseline + **10 points**,
  otherwise the graph's added complexity is not justified and the project stops there.
- False confirmation rate on labelled `CONFIRMED` ≤ **1%**.
- Entity resolution: `ABN_EXACT` ≥ 99%; name-only matches never promoted to `CONFIRMED`.
- ECE ≤ **0.05**; every band used outward has ≥ 30 labelled edges or is capped one band lower.

**Gold set:** target at least **100** labelled projects (PR 1 starts with 42; see §11.5–11.6) (stratified: awarded/unawarded, single/multiple
candidate builders, ABN present/absent, seeded conflicts, evidence-absent, prohibited-source). Labelling
is a human task and is Decision D5.

### 11.5 Recorded baseline (PR 1)

Gold set v0: **42 projects, 20 entity pairs, 10 grounding drafts** (51 source records), all synthetic.
Numbers are what today's code does, measured by `npm run eval:graph-baseline` and pinned in
`eval/datasets/v2/relationship-graph/baseline.json`. They are **not thresholds**; §11.4 floors are fixed
only after this is reviewed. Modelling choices for the baseline are listed at the top of
`scripts/eval-relationship-graph.ts`.

| Metric | Baseline |
|---|---|
| Builder: correct / assertions / known cases | 24 / 33 / 24 (precision 0.727, recall 1.00) |
| False confirmation rate (every assertion is implicitly "confirmed") | 0.273 |
| Name-only builder assertions (design: never confirmable) | 0.152 of assertions |
| Unknown correctness (notice does not appoint a builder) | 9 / 15 = 0.600; builder fabricated for C1–C4 (design, PM, supply, QS suppliers), H3 (council as its own supplier) and I7 (standing panel) |
| Conflict detection | 0 / 3; all 3 silently resolved to one builder |
| Supersession (same notice corrected) | 2 / 2 (latest wins) |
| Developer/client accuracy | 42 / 42; 1 builder↔developer swap (H3) |
| Trade required, stated | recall 28 / 28 |
| Trade required, absent | false positives 0 / 13 |
| Trade implied surfaced as if required | 31 / 39 = 0.795 (baseline cannot distinguish stated from implied) |
| Entity resolution accuracy | 10 / 20 = 0.50; 3 false merges, 7 false splits; 0 / 3 on `&`/`and` and abbreviations, 0 / 3 on bracket tokens, 0 / 3 on same name with different ABN |
| Grounding: unsupported drafts flagged | 3 / 6 = 0.50; **0 / 2** wrong-party claims and **0 / 1** unstated-requirement claims caught; 0 / 4 grounded drafts wrongly blocked |
| Licence: builder assertions resting only on non-`confirmed` sources | 33 / 33 (both registered sources are `unverified`) |

Reading it honestly:
- Trade detection is already strong on this set (keyword rules were designed for it), so the graph's
  value is **not** better trade recall; it is the stated/implied split and per-project evidence.
- The biggest gaps are the ones the design targets: fabricated builders on non-appointing notices,
  silent conflict resolution, name-only entity matching (false merges and splits), and grounding that
  cannot catch a wrong party or an unstated requirement.
- Limits: 42 projects is a starting set (target ≥ 100); labels were written from record text and the
  definitions in `eval/datasets/v2/relationship-graph/types.ts`, not from code output; the baseline is
  given the project grouping for free, which flatters it; builder precision here is on synthetic
  notices and says nothing about real-world prevalence of each stratum.

### 11.6 Label verification and ownership (PR 1 follow-up)

**What was done.** The first set of labels was re-read against the record text and the role
definitions, and a lasting audit was added to `tests/eval-relationship-graph.test.ts` that checks labels
with its own term table, deliberately **not** `matchOpportunity` or the trade taxonomy, so a label cannot
be right only because the code under measurement agrees with it. Defects found and fixed:

| Case | Problem | Fix |
|---|---|---|
| A2, A4, B4, D2, D4 (electrical), D6, E2, I1, I5 (electrical), I8 | `ABSENT` trade labels the record did not affirm (e.g. chillers need pipework; illuminated signs need power) | removed; `ABSENT` now means affirmed out of scope or a single narrowly named scope that excludes it |
| A1 | `demolition ABSENT` rested on nothing | record now says "cleared greenfield site" |
| H3 | footpath/kerb works labelled `concreting STATED` (taxonomy-driven) | `IMPLIED` |
| H5 | "joint venture" in the title blurred client vs builder | wording removed |
| I7 | a standing maintenance panel labelled as a builder appointment | builder `UNKNOWN` |
| Pairs P01–P20 | truth had no stated basis; "Limited" vs "Pty Ltd" and bracket variants are not necessarily one entity | every pair now carries a `labelBasis` (synthetic ABR registration); P04 no longer mixes legal forms |

The audit also pins: `STATED` ⇒ the text names the trade, `IMPLIED`/`ABSENT` ⇒ it does not; `KNOWN`
builder ⇒ the latest award's counterparty with no non-builder service wording and not a self-award;
`UNKNOWN` ⇒ no award, a non-builder service, a panel, or a self-award; `CONFLICT` ⇒ ≥ 2 distinct notices
and suppliers; developer ⇒ an award buyer, else null; pair truth consistent with any ABNs given.

**What this is not.** It is a consistency audit by the same author, not independent verification.
Roles, implied trades and unknown cases still need a second person. Open policy calls for that person:
1. Does a specialist contractor appointed directly for a narrow scope (A5, A6, I1, I2, I4, I6, B3, B4)
   count as the `APPOINTED_BUILDER`, or only a head/principal contractor?
2. Is a same-notice supplier change (F4, F5) a correction (supersede, as labelled) or a novation (conflict)?
3. Are the `IMPLIED` lists reasonable to a working estimator (e.g. security on a court-house extension,
   roofing on a school hall)?

**Labelling owner (Decision D5): not yet assigned.** The only human committer in this repository is
`vnss771-sudo` (51 of 157 commits; the rest are Claude sessions) and there is no `CODEOWNERS` file, so
the code gives no basis to name anyone. Requirements for the owner: has construction-procurement
knowledge (a head contractor estimator or procurement lead), is not the author of the baseline, and signs
off the three policy calls above and each batch of new labels. Until a name is recorded here, the
baseline is provisional and §11.4 floors must not be fixed.

**Requirement before PR 2 is approved: independent construction-domain validation.** The baseline
and every threshold stay **provisional and unfixed** until a named person with construction-procurement
knowledge, who did not write the labels or the baseline, has reviewed the gold set and recorded in this
document: their name and role, the date, the three policy calls above, and any labels changed. PR 2
(pure rule library) must not be approved, and the §11.4 floors must not be set, before that entry
exists. The self-audit test in `tests/eval-relationship-graph.test.ts` is a regression guard, not a
substitute.

**CI.** Node 26 is the CI toolchain (`NODE_VERSION` in `.github/workflows/ci.yml`; the "Forward-compat
(Node 26)" job runs install, prisma generate, typecheck, unit tests and build). See the PR for the run
that covers the final head commit.

## 12. Implementation sequence (revised: evaluation before schema)

Each step is its own small PR, merged and verified before the next. No step enables anything in
production; `RELATIONSHIP_GRAPH_MODE` stays `off` until step 7 is separately approved.

| PR | Scope | Touches DB/prod? | Gate to proceed |
|---|---|---|---|
| **1. Eval baseline** (in review) | `eval/datasets/v2` manifest, 42 labelled projects + 20 entity pairs + 10 grounding drafts, offline "no-graph" baseline, recorded `baseline.json` (§11.5) | No | Baseline numbers reviewed; thresholds in §11.4 fixed |
| **2. Pure rule library** | Evidence-requirement, entity-match, confidence and conflict functions as pure TypeScript with unit tests, run through the PR 1 eval | No | Meets §11.4 invariants offline **and** the independent construction-domain validation in §11.6 is recorded |
| **3. Schema, flag, rollback** | Migration for §5 (+ prerequisite unique indexes), rollback SQL, `RELATIONSHIP_GRAPH_MODE` parsing with `validateConfig`, `tests-db` isolation/constraint tests. **No writers** | Additive only, empty tables | Integration tests green; rollback rehearsed on a clean DB |
| **4. Shadow ingestion** | Worker job reading `Opportunity` by cursor; licence-gated; writes edges/evidence in `shadow` only; idempotent | Writes only if mode ≠ `off` | Eval vs gold set on ingested output meets §11.4 |
| **5. Read service + read-only API** | §10 query as a repository function, route returning §10 statuses; admin/owner only; shadow-only data | No writes | Query integration tests green |
| **6. Review workflow** | Review queue, promote/demote/reject/resolve actions, `GraphEdgeReview` + `AuditEvent`, UI shows evidence | Writes review rows | Audit/append-only tests green |
| **7. `on` mode** | Allow licence-eligible edges to feed recommendations (never outreach directly) | Yes, behind flag | **Separate explicit approval**, eval results attached, source licences confirmed |

Hybrid retrieval, embeddings, and agent orchestration remain deferred and are not part of this sequence.

## 13. Migration, rollback, feature flag, integration tests

### 13.1 Migration (PR 3)

- Additive only: four tables, enums, indexes, CHECKs and triggers; plus `UNIQUE (workspaceId, id)`
  indexes on `Prospect`, `Opportunity`, `Signal`, `EvidenceSource`, `WebsiteEvidenceClaim`.
- Applied through the existing `prisma migrate deploy` startup path (`docs/MIGRATIONS.md`); never
  `db push`. Partial uniques, CHECKs and triggers live in the migration's raw SQL, as with the Prospect
  domain unique.
- **Lock risk on existing tables:** a plain `CREATE UNIQUE INDEX` blocks writes while it builds.
  PR 3 must report row counts for the five tables and choose between a plain index (small tables) and
  `CREATE UNIQUE INDEX CONCURRENTLY` run as a documented pre-step (Decision D3). It does not guess.

### 13.2 Rollback

- Ships `docs/plans/RELATIONSHIP_GRAPH_ROLLBACK.sql` (same convention as `C4_EVIDENCE_GOVERNANCE_ROLLBACK.sql`):
  drop in dependency order (`GraphEdgeReview`, `GraphEdgeEvidence`, `GraphEdge`, `GraphEntity`, enums,
  triggers, then the prerequisite indexes) and remove the `_prisma_migrations` row.
- Order of operations: (1) set `RELATIONSHIP_GRAPH_MODE=off`, (2) confirm the worker job idle,
  (3) **export `GraphEdgeReview` and `AuditEvent` rows** if any exist (the SQL deletes reviewer
  history), (4) run the rollback SQL. Safe with zero data; with data it discards graph state and review
  history, and says so.
- Rehearsed in CI on a clean database: migrate up, roll back, migrate up again.

### 13.3 Feature flag

`RELATIONSHIP_GRAPH_MODE`, following the `SOURCE_LICENCE_GATE` pattern (parsed by one pure function,
validated at boot, never silently defaulting):

| Value | Effect |
|---|---|
| unset, empty, `off` | **Default.** No ingestion job, no reads, API route answers 404; tables exist but stay empty |
| `shadow` | Ingestion and the read API and review UI work; **no** output feeds recommendations, drafts or outreach |
| `on` | Licence-eligible edges may inform recommendations. Refused at boot unless an explicit eval-approved marker is set (specified in PR 7) |
| anything else | Configuration error: API boot fails (`validateConfig`); the worker job does nothing and records the error |

Documented in `docs/CONFIGURATION.md` with "do not set in production without approval". Nothing in this
design changes any production setting.

### 13.4 Integration tests (`tests-db/`, PR 3–6)

- **Tenant isolation:** inserting an edge whose `sourceEntityId` belongs to another workspace fails with
  an FK violation; likewise evidence → `Opportunity`/`Signal` across workspaces; adversarial two-tenant
  read returns zero foreign rows.
- **Constraints:** endpoint-kind CHECK per edge type; `CONFIRMED` without `basisEvidenceId` rejected;
  `basisEvidenceId` pointing at another edge's evidence rejected; confidence bounds and band-vs-verification
  CHECKs; `ASSOCIATED_WITH` cannot be `CONFIRMED`; exactly-one evidence reference.
- **Dedup/supersession:** re-ingest is a no-op; changed `contentHash` supersedes; cross-source disagreement
  yields `CONFLICTED`, not an overwrite.
- **Review audit:** every action appends a review row and an `AuditEvent`; `UPDATE` on a review row fails.
- **Lifecycle:** workspace delete cascades cleanly in one statement (the `NoAction` choice); deleting a
  referenced `Opportunity` is blocked until evidence is retracted; retention expiry retracts evidence and
  re-evaluates the edge to `UNSUPPORTED`.
- **Flag:** `off` performs no writes and 404s the route; invalid value fails `validateConfig`; `shadow`
  never reaches recommendations.
- **Licensing:** `prohibited` never ingested at any gate mode; `unverified` per `off`/`observe`/`enforce`;
  an unregistered source is rejected; a registry downgrade removes the evidence from §10 results without
  data changes.
- **Query (§10):** returns `UNKNOWN_BUILDER`, `CONFLICTING_EVIDENCE`, `INFERRED_BUILDER`,
  `CONFIRMED_BUILDER` on seeded fixtures; keeps projects with no builder edge; ignores `ASSOCIATED_WITH`.
- **Migration:** up → rollback → up on a clean DB.

## 14. Index: how this revision answers the ten required changes

| # | Required change | Where |
|---|---|---|
| 1 | Separate appointment vs requirement relationships | §2.2, §6.1 |
| 2 | Accurate tenant-scoped query, explicit `UNKNOWN_BUILDER` | §10 |
| 3 | DB-level tenant isolation; public vs private model | §4, §5.1–5.3 |
| 4 | Map to existing Prisma models, avoid duplication | §3 |
| 5 | Relationship-specific evidence; verified vs inferred | §2.3, §6 |
| 6 | Multi-evidence, validity, supersession, dedup, reviewer audit | §5.3, §7 |
| 7 | Confidence calibration and conflicting evidence | §9 |
| 8 | Baseline evals before schema | §11, §12 |
| 9 | Migration, rollback, default-off flag, integration tests | §13 |
| 10 | Respect PR #413 licensing and provenance | §8 |

## 15. Decisions needing your approval

| # | Decision | Recommendation |
|---|---|---|
| D1 | Outward use requires `confirmed` licence even when `SOURCE_LICENCE_GATE` is `off` | **Yes.** The graph is new and default-off, so it can be stricter; effect today is shadow-only until AusTender is confirmed |
| D2 | v1 workspace-scoped only, with no shared public tier | **Yes**; revisit after licences are confirmed |
| D3 | Index build strategy for the five existing tables | Decide in PR 3 from measured row counts |
| D4 | Which role may promote/resolve edges | **Verified in §7.1:** new `graph:review` capability at the admin tier (admin and owner), mirroring `campaign:approve_draft`; added in PR 6 with matrix and test rows |
| D5 | Gold-set labelling: who labels, and the ≥ 100 project size | **Unassigned.** Needs a named construction-procurement owner who is not the baseline author (§11.6); blocks fixing §11.4 floors |
| D6 | Integer 0–100 confidence (replacing the first draft's decimal) | **Yes**, consistent with `CommercialEvent.confidence` |

## 16. Known limitations

- Today's registered sources identify an awarded supplier on a contract award, but **not** a builder on a
  development application, so confirmed builder links will initially come from awards only.
- Both registered sources are `unverified`; until that changes, nothing is outward-eligible.
- Entity merge/split tooling and `SUBCONTRACT_AWARDED` ingestion from public sources are out of scope.
- Threshold values in §9 and §11.4 are starting points and are fixed only after the PR 1 baseline.
