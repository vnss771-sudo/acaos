# Design: Construction Relationship Graph (revision 3)

**Status:** Draft for approval. **Design only.** No application code, migration, merge, deploy or
production setting is part of this document or of the PR that carries it.

**Supersedes:** the first draft (single `graph_entities` / `graph_relationships` pair, recursive CTE,
`ON DELETE CASCADE` edges, schema-first ordering). That draft's architecture was approved; its schema,
query and sequencing were not. Revision 2 addressed all ten required changes (index in §14). Revision 3
adds four further corrections (§14.1): an award does not prove the head-builder role (§6.1), trade
relevance, explicit requirement and open packages are separate relations (§2.2, §6.1), edges are created
and promoted transactionally because foreign keys cannot establish evidence eligibility (§7.2), and a
`CONFIRMED` edge must keep currently eligible primary evidence or stop being confirmed (§7.3).

**Still open (unchanged by revision 3):** independent construction-domain labelling review (§11.6), all
thresholds provisional (§11.4), and **PR 2 is blocked** until that review is recorded.

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
| `APPOINTED_BUILDER` | PROJECT → ORGANISATION | Does a primary record say this organisation holds the builder/head-contractor role **on this project**? | appointment |
| `DEVELOPED_BY` | PROJECT → ORGANISATION | Who is the client / developer / applicant? | appointment |
| `TRADE_RELEVANCE` | PROJECT → TRADE_PACKAGE | Does the record's wording suggest this trade is relevant? (keyword/taxonomy match) | **heuristic; never confirmable** |
| `REQUIRES_TRADE` | PROJECT → TRADE_PACKAGE | Does a primary record **explicitly** require this trade? | requirement |
| `PACKAGE_AVAILABLE` | PROJECT → TRADE_PACKAGE | Is there a **confirmed, open, unawarded** package for this trade that someone can bid on? | opportunity |
| `SUBCONTRACT_AWARDED` | ORGANISATION → ORGANISATION (builder → sub), scoped to a trade via `tradeEntityId` | Who won this package? | appointment, **workspace-private only in v1** |
| `ASSOCIATED_WITH` | ORGANISATION → ORGANISATION | Have they worked together before? | **inferred historical association, never an appointment** |

- **Appointment, relevance, requirement and package availability are different edges with different
  evidence rules** (§6). A project that provably requires electrical work but has no known builder yields a
  `REQUIRES_TRADE` edge and **no** `APPOINTED_BUILDER` edge, which the query reports as `UNKNOWN_BUILDER`.
- **Three trade tiers, never collapsed.** `TRADE_RELEVANCE` (a keyword match, i.e. what
  `Opportunity.matchedTrades` is today) says only "worth a look". `REQUIRES_TRADE` needs an explicit
  requirement. `PACKAGE_AVAILABLE` needs an open procurement route. **A keyword match is never presented
  as a confirmed requirement or as an opportunity to bid.**
- `ASSOCIATED_WITH` and `TRADE_RELEVANCE` can never reach `verification = CONFIRMED`; `ASSOCIATED_WITH`
  never answers "who was appointed" and is shown only in a separately labelled "historical associations" list.
- The database enforces valid endpoint kinds per edge type (§5.3), so a trade edge cannot point at an
  organisation.

### 2.3 Verified vs inferred

- `CONFIRMED`: the relationship is stated by a **primary record that asserts that exact relationship on
  that exact project** (§6.1), with an entity match strong enough to trust (§6.2). Categorical, not
  "score ≥ N". It stays confirmed only while that evidence stays eligible (§7.3).
- `INFERRED`: everything else that still asserts something (name-only matches, keyword matches,
  heuristics, website claims, historical patterns). Never presented as an appointment, a requirement or
  an opportunity.
- **Uncertain is not inferred.** An award that names a supplier without establishing its role does **not**
  become an inferred builder: the role stays `ROLE_UNCERTAIN` (§6.1, provisional rules D7). The graph
  records the supplier as named on the award and says no more.

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
enum GraphEdgeType          { APPOINTED_BUILDER DEVELOPED_BY TRADE_RELEVANCE REQUIRES_TRADE PACKAGE_AVAILABLE SUBCONTRACT_AWARDED ASSOCIATED_WITH }
enum GraphVerification      { CONFIRMED INFERRED }
enum GraphEdgeStatus        { ACTIVE CONFLICTED SUPERSEDED REJECTED EXPIRED UNSUPPORTED }
enum GraphEvidenceVisibility{ PUBLIC_SOURCE WORKSPACE_PRIVATE }
enum GraphEvidenceClass     { PRIMARY_RECORD SECONDARY_REPORT WEBSITE_CLAIM HISTORICAL_PATTERN MANUAL_ENTRY }
enum GraphEntityMatch       { ABN_EXACT NAME_EXACT NAME_FUZZY REVIEWER_VERIFIED }
enum GraphReviewAction      { PROMOTE DEMOTE REJECT ADJUST_CONFIDENCE RESOLVE_CONFLICT SUPERSEDE REOPEN REVALIDATE }
enum GraphReviewActor       { REVIEWER SYSTEM }
// What the evidence actually ASSERTS about the relationship (not merely that it mentions the entity).
// Set at ingest by deterministic rules or by a reviewer; the only values that can confirm each edge
// type are listed in §6.1 and enforced by a CHECK on GraphEdge.
enum GraphAssertion {
  HEAD_CONTRACTOR PRINCIPAL_FOR_SCOPE REVIEWER_VERIFIED_ROLE          // APPOINTED_BUILDER
  UNSPECIFIED_SUPPLIER NON_BUILDER_SERVICE PANEL_ARRANGEMENT          // appointment evidence that does NOT confirm
  STATED_CLIENT                                                       // DEVELOPED_BY
  KEYWORD_ONLY                                                        // TRADE_RELEVANCE
  STRUCTURED_CLASSIFICATION EXPLICIT_SCOPE_STATEMENT REVIEWER_VERIFIED_SCOPE   // REQUIRES_TRADE
  OPEN_PROCUREMENT_NOTICE REVIEWER_VERIFIED_NOTICE CLOSED_OR_AWARDED  // PACKAGE_AVAILABLE
  MANUAL_AWARD_RECORD                                                 // SUBCONTRACT_AWARDED
  CO_OCCURRENCE                                                       // ASSOCIATED_WITH
}
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
  // The evidence row that justifies CONFIRMED. The composite FK below proves, in the database, that it
  // belongs to THIS edge, resolves to THIS edge's target, and carries the class and assertion copied
  // here. It does NOT prove the evidence is currently eligible: see §7.2-7.3.
  basisEvidenceId  String?
  basisEvidenceClass GraphEvidenceClass?
  basisAssertion   GraphAssertion?
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
  //     TRADE_RELEVANCE, REQUIRES_TRADE,
  //     PACKAGE_AVAILABLE               : PROJECT -> TRADE_PACKAGE
  //     SUBCONTRACT_AWARDED             : ORGANISATION -> ORGANISATION, tradeEntityId NOT NULL
  //     ASSOCIATED_WITH                 : ORGANISATION -> ORGANISATION, verification = INFERRED
  //   confidence BETWEEN 0 AND 100
  //   verification = 'CONFIRMED' => basisEvidenceId, basisEvidenceClass, basisAssertion NOT NULL,
  //                                 confidence >= 80, entityMatch IN ('ABN_EXACT','REVIEWER_VERIFIED')
  //   confirmable (edgeType, basisEvidenceClass, basisAssertion) combinations only (§6.1):
  //     APPOINTED_BUILDER   : PRIMARY_RECORD + HEAD_CONTRACTOR | PRINCIPAL_FOR_SCOPE | REVIEWER_VERIFIED_ROLE
  //     DEVELOPED_BY        : PRIMARY_RECORD + STATED_CLIENT
  //     REQUIRES_TRADE      : PRIMARY_RECORD + STRUCTURED_CLASSIFICATION | EXPLICIT_SCOPE_STATEMENT | REVIEWER_VERIFIED_SCOPE
  //     PACKAGE_AVAILABLE   : PRIMARY_RECORD + OPEN_PROCUREMENT_NOTICE | REVIEWER_VERIFIED_NOTICE; validUntil NOT NULL
  //     SUBCONTRACT_AWARDED : MANUAL_ENTRY + MANUAL_AWARD_RECORD
  //     TRADE_RELEVANCE, ASSOCIATED_WITH : never CONFIRMED
  //   verification = 'INFERRED'  => confidence <= 79
  //   validUntil IS NULL OR validFrom IS NULL OR validUntil > validFrom
  //   status = 'SUPERSEDED' <=> supersededById IS NOT NULL
  // Composite FK (workspaceId, id, basisEvidenceId, targetEntityId, basisEvidenceClass, basisAssertion)
  //   -> GraphEdgeEvidence(workspaceId, edgeId, id, resolvedEntityId, evidenceClass, assertion)
  //   so the confirming evidence provably belongs to this same edge, resolves to this edge's target, and
  //   has the class and assertion the CHECK above requires. Static facts only (see §7.2).
}

model GraphEdgeEvidence {
  id                    String                   @id @default(cuid())
  workspaceId           String
  edgeId                String
  evidenceClass         GraphEvidenceClass
  // What this evidence asserts about THIS relationship (see GraphAssertion), and the entity the
  // asserted party was resolved to at ingest. Both are snapshots validated again at promotion (§7.2).
  assertion             GraphAssertion
  resolvedEntityId      String
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
  // Re-published notices (§7): each version is its own row, never overwritten. The newer row points at
  // the one it replaces and records what materially changed.
  versionOfEvidenceId   String?                  // composite self-FK (workspaceId, versionOfEvidenceId)
  changeSummary         Json?                    // { supplier?, abn?, value?, scope?, dates?: {from, to} } NULL when identical
  expiresAt             DateTime?                // retention/freshness limit; past it the evidence is ineligible
  edge                  GraphEdge                @relation(fields: [workspaceId, edgeId], references: [workspaceId, id], onDelete: Cascade)
  workspace             Workspace                @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, id])
  @@unique([workspaceId, edgeId, id, resolvedEntityId, evidenceClass, assertion]) // FK target for GraphEdge.basis*
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
  reviewerUserId  String?            // NULL only for actor = SYSTEM (automatic revalidation, §7.3)
  actor           GraphReviewActor   @default(REVIEWER)
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
  reviewer        User?              @relation(fields: [reviewerUserId], references: [id], onDelete: NoAction)

  @@index([workspaceId, edgeId, createdAt])
  // A trigger rejects UPDATE (append-only). DELETE happens only through workspace erasure cascade.
  // CHECK: actor = 'SYSTEM' OR reviewerUserId IS NOT NULL. A reviewer PROMOTE row must list the
  //   basis evidence id in evidenceIds (the reviewer saw what they promoted on).
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

"Primary record" means a record from a registered source (or an authorised manual entry with the document
cited) that itself makes the assertion. "Names the organisation" is **not** the same as "asserts the
relationship".

| Edge | CONFIRMED requires | Anything weaker is |
|---|---|---|
| `APPOINTED_BUILDER` | A `PRIMARY_RECORD` whose own text or structured fields **explicitly establish the builder / head-contractor (or an explicitly stated principal-contractor role for a named scope; provisional D7 rules below) on this specific project**, recorded as `assertion` ∈ {`HEAD_CONTRACTOR`, `PRINCIPAL_FOR_SCOPE`, `REVIEWER_VERIFIED_ROLE`} with the quoted excerpt; the evidence's `opportunityId` is the same `Opportunity` as the PROJECT node (or a reviewer-verified project link); **and** entity match `ABN_EXACT` or `REVIEWER_VERIFIED` | `INFERRED` |
| `DEVELOPED_BY` | A `PRIMARY_RECORD` stating the client/applicant/owner (`STATED_CLIENT`; today: `buyerName` on a contract award; a DA applicant only if the source exposes it) | `INFERRED` |
| `TRADE_RELEVANCE` | never confirmable. Created from keyword/taxonomy matches (`assertion = KEYWORD_ONLY`) | n/a: always `INFERRED` |
| `REQUIRES_TRADE` | A `PRIMARY_RECORD` that **explicitly requires** the trade: a structured classification naming it (`STRUCTURED_CLASSIFICATION`, e.g. an electrical UNSPSC class), an explicit scope statement quoted from the record (`EXPLICIT_SCOPE_STATEMENT`), or a reviewer who quotes the scope (`REVIEWER_VERIFIED_SCOPE`). **A keyword hit in a title or description is not enough** | `INFERRED` (and, when only keyword-visible, expressed as `TRADE_RELEVANCE`) |
| `PACKAGE_AVAILABLE` | A `PRIMARY_RECORD` procurement notice (approach to market, RFQ, EOI, tender) for **this trade on this project** that is **open and unawarded now** (`validUntil` = bid close, in the future), with a stated route to bid (`OPEN_PROCUREMENT_NOTICE`), or a reviewer-verified notice. A development application, an award, or a keyword match **never** creates it | `INFERRED` is never surfaced as an opportunity |
| `SUBCONTRACT_AWARDED` | `MANUAL_ENTRY` by an authorised user with the document attached or cited (`MANUAL_AWARD_RECORD`). No public source exists today | n/a: no inferred form in v1 |
| `ASSOCIATED_WITH` | cannot be CONFIRMED | `INFERRED` only; needs ≥ 2 distinct projects where both appear |

**Why an award does not confirm a builder.** A contract-award notice names a *supplier*. That supplier may
be a head contractor, but it may equally be an architect, project manager, quantity surveyor, supply-only
vendor, a specialist trade, or a standing-panel member, and the notice often does not say which. The
baseline (§11.5) treats the awarded supplier as the builder; that is exactly the false confirmation this
rule removes. Role is therefore its own assertion:

| Evidence asserts | `assertion` | Effect on `APPOINTED_BUILDER` |
|---|---|---|
| States the head/principal contractor role for the project (e.g. "head contractor", "construction contract for X", "principal contractor") | `HEAD_CONTRACTOR` | may confirm |
| **Explicitly states** a principal-contractor role for a named scope (e.g. "principal contractor for the switchboard works") | `PRINCIPAL_FOR_SCOPE` | may confirm (provisional D7 rule 1) |
| A reviewer read the record and verified the role, quoting it | `REVIEWER_VERIFIED_ROLE` | may confirm |
| Names a supplier, role unstated or ambiguous, including a specialist trade supplier whose scope is narrow but whose role is not stated | `UNSPECIFIED_SUPPLIER` | **uncertain, not inferred:** reported as `ROLE_UNCERTAIN` ("named on award, role not established"); confidence capped (§9.2), review queue, never outward, never counted as a builder |
| Design, project management, QS, supply-only | `NON_BUILDER_SERVICE` | **no `APPOINTED_BUILDER` edge at all** |
| Standing panel / period arrangement | `PANEL_ARRANGEMENT` | **no `APPOINTED_BUILDER` edge at all** |

Expected consequence, stated plainly: most AusTender-derived supplier links will be `ROLE_UNCERTAIN` until
a reviewer verifies the role or a source states it, so confirmed-builder **recall will be lower** than the
baseline's 1.00. That is the intended trade: precision and honesty over coverage.

#### Provisional classification rules (Decision D7)

Adopted by the project owner as defaults on 2026-10-17. **They are provisional and not yet validated by an
independent construction-domain reviewer (§11.6)**; the labelling brief and blind sheet deliberately do not
show them, so the reviewer's rulings are not anchored. They are used for design and for the eval harness
only until reviewed.

1. **Specialist subcontractors are not principal builders without explicit supporting evidence.** A narrow
   scope alone (switchboard, roofing, chillers) does not make a supplier the builder; the record must
   explicitly state the principal-contractor role (`PRINCIPAL_FOR_SCOPE`), or a reviewer must verify it.
2. **Documented same-notice supplier corrections are supersessions.** A re-published notice that carries a
   documented correction or amendment (or a same-ABN name correction) supersedes the earlier version (§7).
3. **Unresolved contradictory supplier evidence is a conflict.** Different suppliers for the same project
   that nothing documented resolves (including an undocumented supplier change on one notice) are
   `CONFLICTING_EVIDENCE` and need a reviewer (§9.4).
4. **Ambiguous roles remain uncertain rather than being inferred.** `UNSPECIFIED_SUPPLIER` yields
   `ROLE_UNCERTAIN`, never an inferred builder.
5. **Re-published notices preserve provenance and material changes.** Every version is retained as its own
   evidence row; the change between versions is recorded, never overwritten (§7).

Hard rules:
1. **An award or a development application never, by itself, confirms a builder.** A DA identifies an
   applicant, not a contractor; an award identifies a supplier, not necessarily a builder.
2. **`CONFIRMED` `APPOINTED_BUILDER` requires explicit primary evidence of the role on the specific
   project** (the evidence's `Opportunity` is the project's own, or a reviewer-verified project link).
   Cross-record project linking (DA → award) is not automatic in v1 (§16).
3. **`WEBSITE_CLAIM` and `SECONDARY_REPORT` evidence can support `INFERRED` only.** Website claims are
   documented in the schema as raw observation, not verified truth.
4. **Name-only entity matches (`NAME_EXACT`, `NAME_FUZZY`) can never produce `CONFIRMED`.**
5. **Keyword matches are trade relevance only.** They never produce a `CONFIRMED` `REQUIRES_TRADE` or
   `PACKAGE_AVAILABLE`, and are never surfaced as an opportunity to bid.
6. A `CONFIRMED` edge needs `basisEvidenceId`, `basisEvidenceClass` and `basisAssertion`; the database
   rejects it otherwise (§5.3). The database cannot decide whether that evidence is *currently eligible*;
   that is §7.2-7.3.
7. Evidence from a `prohibited` source is never ingested (§8).

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
  re-delivers changed content (`Opportunity.contentHash` differs) **and** the change is documented: the
  new version states a correction or amendment, or the supplier is the same entity (same ABN) with a name
  fix. A changed supplier **without** documentation is *unresolved contradictory evidence*, so it is a
  conflict (§9.4), not a supersession. Anything cross-source is a conflict and needs a reviewer.
- **Re-published notices keep provenance (D7 rule 5).** Each version is retained as its own evidence row
  (new `contentHash`, `versionOfEvidenceId` pointing at the one it replaces, `changeSummary` listing what
  materially changed: supplier, ABN, value, scope, dates). The earlier excerpt and snapshot are never
  edited or deleted by a re-publication, and the superseded edge keeps its evidence for audit.
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

### 7.2 Transactional creation and promotion

Foreign keys alone cannot establish evidence eligibility. They prove a basis row exists, belongs to the
same workspace and edge, resolves to the edge's target, and carries a given class and assertion. They cannot
evaluate whether the assertion is true of the record text, whether the licence registry (code, not data)
currently permits the source, whether the evidence is stale, retracted, or whether the entity match is
strong enough. Eligibility is therefore checked by one validation function (`validateConfirmation`, pure,
shared by ingestion, review and the eval harness) and applied inside a database transaction.

Protocol (one transaction per edge; isolation `SERIALIZABLE`, or `READ COMMITTED` plus the advisory lock below):

1. **Lock.** Take `pg_advisory_xact_lock(hash(workspaceId, conflictGroupKey))` so two ingestions cannot
   race on the same slot, then upsert entities.
2. **Create the edge as `INFERRED`**, `status = ACTIVE`, confidence ≤ 79, no basis columns.
3. **Attach evidence** rows: snapshot (excerpt, `contentHash`, `observedAt`), licence snapshot,
   `assertion`, `resolvedEntityId`, `expiresAt`. Rejected here: `prohibited`/unregistered sources, a
   missing excerpt, an evidence `Opportunity` that is not the project's own.
4. **Validate** with `validateConfirmation(edge, evidence, registry, mode, now)`: edge-type rule from §6.1;
   class and assertion allowed for the type; `retractedAt IS NULL` and `expiresAt` in the future; source
   present in the **live** registry with the commercial-use position §8 requires; entity match strong
   enough; for `PACKAGE_AVAILABLE`, the notice still open (`validUntil` in the future); and the
   conflict-group check of §9.4.
5. **Promote or stay inferred.** If valid, set `basisEvidenceId`, `basisEvidenceClass`, `basisAssertion`,
   `verification = CONFIRMED` and the confirmed confidence band in a single `UPDATE`; the CHECKs and the
   composite FK then re-verify the static facts. If invalid, leave it `INFERRED` and record why.
6. **Audit.** A reviewer-driven promotion appends a `GraphEdgeReview` (basis evidence in `evidenceIds`) and
   an `AuditEvent`; an automatic one appends a `SYSTEM` row.
7. **Commit.** Any failure rolls back the edge, evidence and audit together, so there is never a
   `CONFIRMED` edge without validated evidence, or evidence without its edge.

No code path may write `verification = 'CONFIRMED'` outside this protocol. Three layers, each doing only
what it can do:

| Layer | Enforces | Cannot enforce |
|---|---|---|
| Database (CHECKs, composite FKs) | tenant isolation; edge-type/endpoint shape; basis belongs to this edge and target; allowed class and assertion per edge type; non-null basis | truth of the assertion; licence registry; freshness; retraction state |
| Transactional service (`validateConfirmation`) | everything above plus assertion truth, live licence, freshness, entity strength, conflict check | anything after commit |
| Read-time guard + revalidation (§7.3) | the invariant stays true as the world changes | n/a |

### 7.3 Evidence validity: a CONFIRMED edge must stay supported

**Invariant.** Every `CONFIRMED` edge retains **at least one currently eligible, unretracted,
appropriately licensed `PRIMARY_RECORD` (or authorised `MANUAL_ENTRY`) evidence row that supports that exact
relationship**: the basis row is attached to this edge, resolves to this edge's target entity, carries the
required `assertion`, has `retractedAt IS NULL`, `expiresAt` null or in the future, and a source the live
registry permits for the surface being served. If no such row exists, the edge **cannot remain
confirmed**.

How it is kept true:
- **Read-time guard.** No query trusts the stored `verification`. §10 computes an *effective*
  verification: `CONFIRMED` only if the stored value is `CONFIRMED` **and** the basis row passes the
  eligibility test at query time; otherwise it is treated as `INFERRED`. A stale `CONFIRMED` therefore
  cannot reach any output even before the job below runs.
- **Revalidation job** (worker, default off with the graph flag) re-runs `validateConfirmation` for every
  `CONFIRMED` edge when any of these happens: evidence retracted or past `expiresAt`; the licence registry
  changes a source's position or the gate mode changes; the referenced `Opportunity.contentHash` changes
  so the snapshot no longer matches; retention expiry; an entity merge or ABN change; supersession;
  `PACKAGE_AVAILABLE` past `validUntil`. It also runs on a schedule as a safety net.
- **Demotion, not deletion.** An edge that fails revalidation is set to `INFERRED`, its basis columns are
  cleared, `status` becomes `UNSUPPORTED` when no eligible evidence of any kind remains (or `EXPIRED`
  past validity), and a `SYSTEM` `DEMOTE`/`REVALIDATE` row with the reason is appended. History is kept.
  Any other edges in its conflict group are re-evaluated.
- **A database trigger on evidence `UPDATE`** that sets `retractedAt` clears the basis of any `CONFIRMED`
  edge using that row in the same statement, so retraction cannot leave a confirmed edge pointing at
  withdrawn evidence even if the job is down. (Licence registry changes are code, so the read-time guard
  and the job cover those.)
- **Re-promotion** follows §7.2 again, with new or restored eligible evidence.

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
5. **Outward use requires `confirmed`** (Decision D1), and eligibility is evaluated per evidence row at
   read time as part of the §7.3 invariant. Edges supported only by `unverified` evidence are
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
| assertion cap | `UNSPECIFIED_SUPPLIER` capped at 69 (reported as `ROLE_UNCERTAIN`; review queue, never outward); `KEYWORD_ONLY` capped at 59 |
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

The first draft used a recursive CTE, which is wrong here: appointment and trade relations are separate
single-hop edges from the same project, and recursion would walk edges of different meaning. Below is a
non-recursive, fully tenant-scoped query. Every join carries `workspaceId`, so it uses the composite
indexes and cannot cross tenants. Identifiers are quoted because Prisma creates camel-cased columns.

Parameters: `$1` workspaceId · `$2` tradeCode (e.g. `electrical`) · `$3` region (e.g. `QLD`) ·
`$4` locality pattern (e.g. `%Brisbane%`) · `$5` minimum confidence (e.g. 70) · `$6` eligible source keys
(`text[]`, computed by the service from the live registry, the gate mode and the surface being served,
§8.4-8.5; includes `manual` only when workspace-private evidence is permitted).

Two rules from §7.3 are applied in SQL, not trusted from stored columns: an edge counts as `CONFIRMED`
only if its **basis evidence is currently eligible**, and every edge needs at least one eligible evidence
row. The trade relation reported is the strongest **effective** tier: a keyword match is reported as
`TRADE_RELEVANCE_ONLY`, never as a requirement or an opportunity.

```sql
WITH trade_edges AS (
  -- Every live trade edge for in-scope projects, with its EFFECTIVE verification.
  SELECT p."id"        AS project_id,
         o."title"     AS project_name,
         o."locality"  AS locality,
         r."id"        AS edge_id,
         r."edgeType"  AS edge_type,
         (r."verification" = 'CONFIRMED' AND EXISTS (
            SELECT 1 FROM "GraphEdgeEvidence" b             -- basis evidence must be eligible NOW
            WHERE b."workspaceId" = r."workspaceId" AND b."edgeId" = r."id"
              AND b."id" = r."basisEvidenceId"
              AND b."resolvedEntityId" = r."targetEntityId"
              AND b."assertion" = r."basisAssertion"
              AND b."evidenceClass" = r."basisEvidenceClass"
              AND b."retractedAt" IS NULL
              AND (b."expiresAt" IS NULL OR b."expiresAt" > now())
              AND b."sourceKey" = ANY ($6)))  AS effective_confirmed,
         r."confidence" AS confidence
  FROM "GraphEntity" p
  JOIN "Opportunity" o
    ON o."workspaceId" = p."workspaceId" AND o."id" = p."opportunityId"
  JOIN "GraphEdge" r
    ON r."workspaceId" = p."workspaceId"
   AND r."sourceEntityId" = p."id"
   AND r."edgeType" IN ('PACKAGE_AVAILABLE', 'REQUIRES_TRADE', 'TRADE_RELEVANCE')
   AND r."status" = 'ACTIVE'
   AND (r."validFrom" IS NULL OR r."validFrom" <= now())
   AND (r."validUntil" IS NULL OR r."validUntil" > now())
   AND r."confidence" >= $5
  JOIN "GraphEntity" t
    ON t."workspaceId" = r."workspaceId" AND t."id" = r."targetEntityId"
   AND t."kind" = 'TRADE_PACKAGE' AND t."tradeCode" = $2
  WHERE p."workspaceId" = $1
    AND p."kind" = 'PROJECT'
    AND o."region" = $3
    AND o."locality" ILIKE $4
    AND EXISTS (                         -- at least one eligible, non-retracted evidence row
      SELECT 1 FROM "GraphEdgeEvidence" ev
      WHERE ev."workspaceId" = r."workspaceId" AND ev."edgeId" = r."id"
        AND ev."retractedAt" IS NULL AND (ev."expiresAt" IS NULL OR ev."expiresAt" > now())
        AND ev."sourceKey" = ANY ($6))
),
trade_link AS (
  -- One row per project: the strongest effective tier. INFERRED PACKAGE_AVAILABLE or REQUIRES_TRADE
  -- edges fall to the relevance tier; they are never reported as a requirement or an opportunity.
  SELECT DISTINCT ON (project_id)
         project_id, project_name, locality,
         CASE WHEN effective_confirmed AND edge_type = 'PACKAGE_AVAILABLE' THEN 'PACKAGE_AVAILABLE'
              WHEN effective_confirmed AND edge_type = 'REQUIRES_TRADE'    THEN 'REQUIRES_TRADE'
              ELSE 'TRADE_RELEVANCE_ONLY' END AS trade_tier
  FROM trade_edges
  ORDER BY project_id,
           CASE WHEN effective_confirmed AND edge_type = 'PACKAGE_AVAILABLE' THEN 1
                WHEN effective_confirmed AND edge_type = 'REQUIRES_TRADE'    THEN 2
                ELSE 3 END,
           confidence DESC
),
builder AS (
  -- Appointment edges for those same projects: a separate relationship with its own evidence.
  SELECT q.project_id,
         count(DISTINCT a."targetEntityId")                          AS distinct_builders,
         bool_or(a."status" = 'CONFLICTED')                          AS flagged_conflict,
         bool_or(a."verification" = 'CONFIRMED' AND EXISTS (         -- effective, not stored
            SELECT 1 FROM "GraphEdgeEvidence" b
            WHERE b."workspaceId" = a."workspaceId" AND b."edgeId" = a."id"
              AND b."id" = a."basisEvidenceId"
              AND b."resolvedEntityId" = a."targetEntityId"
              AND b."assertion" = a."basisAssertion"
              AND b."evidenceClass" = a."basisEvidenceClass"
              AND b."retractedAt" IS NULL
              AND (b."expiresAt" IS NULL OR b."expiresAt" > now())
              AND b."sourceKey" = ANY ($6)))                         AS any_confirmed,
         bool_or(EXISTS (                                            -- explicit role asserted (not merely named)
            SELECT 1 FROM "GraphEdgeEvidence" ex
            WHERE ex."workspaceId" = a."workspaceId" AND ex."edgeId" = a."id"
              AND ex."assertion" IN ('HEAD_CONTRACTOR', 'PRINCIPAL_FOR_SCOPE', 'REVIEWER_VERIFIED_ROLE')
              AND ex."retractedAt" IS NULL
              AND (ex."expiresAt" IS NULL OR ex."expiresAt" > now())
              AND ex."sourceKey" = ANY ($6)))                        AS any_explicit_role,
         jsonb_agg(jsonb_build_object(
           'builderEntityId', b."id",
           'builderName',     b."displayName",
           'abn',             b."abn",
           'edgeId',          a."id",
           'storedVerification', a."verification",
           'confidence',      a."confidence",
           'evidence',        (SELECT jsonb_agg(jsonb_build_object(
                                  'evidenceId', ev."id", 'sourceKey', ev."sourceKey",
                                  'assertion', ev."assertion", 'sourceUrl', ev."sourceUrl",
                                  'excerpt', ev."excerpt", 'attribution', ev."attribution"))
                               FROM "GraphEdgeEvidence" ev
                               WHERE ev."workspaceId" = a."workspaceId" AND ev."edgeId" = a."id"
                                 AND ev."retractedAt" IS NULL
                                 AND (ev."expiresAt" IS NULL OR ev."expiresAt" > now())
                                 AND ev."sourceKey" = ANY ($6))
         ) ORDER BY a."confidence" DESC)                             AS candidates
  FROM trade_link q
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
  WHERE EXISTS (                         -- at least one eligible, non-retracted evidence row
    SELECT 1 FROM "GraphEdgeEvidence" ev
    WHERE ev."workspaceId" = a."workspaceId" AND ev."edgeId" = a."id"
      AND ev."retractedAt" IS NULL AND (ev."expiresAt" IS NULL OR ev."expiresAt" > now())
      AND ev."sourceKey" = ANY ($6))
  GROUP BY q.project_id
)
SELECT q.project_name,
       q.locality,
       q.trade_tier,
       CASE
         WHEN b.project_id IS NULL                              THEN 'UNKNOWN_BUILDER'
         WHEN b.distinct_builders > 1 OR b.flagged_conflict     THEN 'CONFLICTING_EVIDENCE'
         WHEN b.any_confirmed                                   THEN 'CONFIRMED_BUILDER'
         WHEN b.any_explicit_role                               THEN 'INFERRED_BUILDER'   -- role explicit, another requirement unmet (e.g. name-only match)
         ELSE                                                        'ROLE_UNCERTAIN'      -- supplier named, role not established
       END                                         AS builder_status,
       CASE WHEN b.project_id IS NULL THEN '[]'::jsonb ELSE b.candidates END AS candidates
FROM trade_link q
LEFT JOIN builder b ON b.project_id = q.project_id
ORDER BY (b.project_id IS NULL), q.project_name;
```

Behaviour, all asserted by integration tests (§13):
- **Absent evidence → explicit `UNKNOWN_BUILDER`** with empty candidates. No name or id is fabricated,
  and the row still appears (the `LEFT JOIN` keeps the project that needs the trade).
- **An award that names a supplier without establishing its role is `ROLE_UNCERTAIN`**: not a confirmed
  and not an inferred builder (D7 rule 4). `INFERRED_BUILDER` is reserved for an explicit role whose
  identity match is still weak (e.g. name-only). Design, PM, QS, supply-only and panel awards produce no
  appointment edge, so they yield `UNKNOWN_BUILDER`.
- **Trade tiers are separate:** `TRADE_RELEVANCE_ONLY` for keyword matches, `REQUIRES_TRADE` only with an
  explicit requirement, `PACKAGE_AVAILABLE` only with a confirmed open procurement route. A project with
  only a keyword match is never reported as requiring or offering the trade.
- **Stored `CONFIRMED` is not trusted.** If the basis evidence is retracted, expired, resolves to a
  different entity, carries a different assertion, or its source is no longer eligible, the edge reads as
  inferred in this query even before revalidation runs.
- **Conflicts surface as `CONFLICTING_EVIDENCE`**, never as a pick.
- **Licence-ineligible evidence is invisible:** an edge supported only by sources outside `$6` does not
  count, so it cannot appear as a builder or a trade link.
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
| Trade relevance recall | keyword-visible trades surfaced as `TRADE_RELEVANCE` vs labelled `STATED`/`IMPLIED` |
| Explicit-requirement precision | `CONFIRMED` `REQUIRES_TRADE` vs labelled explicit requirements (structured class or explicit scope statement) |
| Package-available precision | `CONFIRMED` `PACKAGE_AVAILABLE` vs labelled open procurement notices; any keyword-only case counts as a false positive |
| Builder-role assertion accuracy | `assertion` (`HEAD_CONTRACTOR`, `UNSPECIFIED_SUPPLIER`, `NON_BUILDER_SERVICE`, `PANEL_ARRANGEMENT`) vs labelled role evidence |
| Confirmation revalidation | after simulated retraction, expiry, licence downgrade and content change: `CONFIRMED` edges left without eligible basis evidence |
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
- **0** `CONFIRMED` `APPOINTED_BUILDER` edges whose evidence does not explicitly assert the role on that project.
- **0** `CONFIRMED` `REQUIRES_TRADE`/`PACKAGE_AVAILABLE` edges resting only on a keyword match.
- **0** `CONFIRMED` edges without currently eligible basis evidence after the simulated changes above.

Quality floors (numbers to be fixed after the baseline is measured; proposed starting values):
- `CONFIRMED` builder precision ≥ **95%** and **not below baseline**; recall ≥ baseline + **10 points**,
  otherwise the graph's added complexity is not justified and the project stops there.
- False confirmation rate on labelled `CONFIRMED` ≤ **1%**.
- Entity resolution: `ABN_EXACT` ≥ 99%; name-only matches never promoted to `CONFIRMED`.
- ECE ≤ **0.05**; every band used outward has ≥ 30 labelled edges or is capped one band lower.

The PR 1 gold set labels trades as `STATED`/`IMPLIED`/`ABSENT` and builders as `KNOWN`/`UNKNOWN`/`CONFLICT`;
it does **not yet** label (a) whether the record explicitly asserts the builder role, (b) trade tier
(relevance vs explicit requirement vs open package), or (c) revalidation scenarios. Adding those labels, and
re-recording the baseline against them, is part of the independent review in §11.6 and is **not** done in
this PR. The recorded baseline's "stated trade" and "builder" numbers are therefore upper bounds on what the
corrected definitions would score.

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

**Labelling owner (Decision D5): the project owner, provisionally (adopted 2026-10-17).** The label owner
is accountable for the gold set: accepts or rejects label changes (by argument, with the reviewer's
reasons), signs each batch, and holds the private unblinding key. This is **not** the independent
validation: the project owner is not asserted to be a construction-procurement specialist and is not
independent of the project.

**Independent reviewer: unassigned.** No external construction procurement or estimating specialist has
accepted the engagement. **No reviewer identity is recorded here and no sign-off exists.** The requirement
is: a qualified external specialist who did not write the labels or baseline, has no stake in ACAOS
results, and returns the items below.

**Distribution rule.** The reviewer receives only `labelling-review/blind-review-sheet.xlsx` and
`LABELLING_BRIEF.md`. `labelling-review/blind-key.csv` stays private to the label owner. The workbook was
opened and round-tripped in LibreOffice on 2026-10-17 (all 8 sheets, every cell value and all 10 dropdown
ranges preserved; renders to PDF). It has not been opened in Microsoft Excel, and the frozen header row was
not confirmable in headless LibreOffice (cosmetic).

**What the reviewer must return before sign-off is recorded:** (1) the completed blind sheet, (2) rulings
on the five policy calls, (3) disputed labels with reasons, (4) a signed review record (name, role,
independence declaration, counts, rulings).

**After sign-off, in order:** record the findings in this section; apply only justified label corrections;
expand the gold set toward 100; re-record the baseline under the revised definitions; **only then**
consider threshold tuning. PR 2 stays blocked until the sign-off is recorded.

**Labels the provisional D7 rules may change (not changed now; labels move only after review):**
specialist-scope suppliers labelled `KNOWN` builder (A5, A6, B3, B4, I1, I2, I4, I6); `F5`, where the same
notice replaces the supplier with a different entity and no documentation, which rule 3 treats as a
conflict, not a supersession; and every `KNOWN` builder whose record does not itself state the role, which
would become `ROLE_UNCERTAIN` under rule 4. `F4` (same ABN, name corrected) remains a supersession.

**Requirement before PR 2 is approved: independent construction-domain validation.** Its scope now
also covers the revision-3 definitions: the reviewer labels, per project, whether the record explicitly
asserts the builder role, the trade tier, and open-package status, and confirms the role-assertion table
in §6.1 against real notice wording. The baseline
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
- **Dedup/supersession:** re-ingest is a no-op; a documented same-notice correction supersedes; an
  undocumented supplier change on one notice yields `CONFLICTED`; cross-source disagreement yields
  `CONFLICTED`, not an overwrite; every re-published version keeps its own evidence row with
  `versionOfEvidenceId` and `changeSummary`, and the earlier excerpt is unchanged (D7 rules 2, 3, 5).
- **Review audit:** every action appends a review row and an `AuditEvent`; `UPDATE` on a review row fails.
- **Lifecycle:** workspace delete cascades cleanly in one statement (the `NoAction` choice); deleting a
  referenced `Opportunity` is blocked until evidence is retracted; retention expiry retracts evidence and
  re-evaluates the edge to `UNSUPPORTED`.
- **Flag:** `off` performs no writes and 404s the route; invalid value fails `validateConfig`; `shadow`
  never reaches recommendations.
- **Licensing:** `prohibited` never ingested at any gate mode; `unverified` per `off`/`observe`/`enforce`;
  an unregistered source is rejected; a registry downgrade removes the evidence from §10 results without
  data changes.
- **Query (§10):** returns `UNKNOWN_BUILDER`, `CONFLICTING_EVIDENCE`, `ROLE_UNCERTAIN`, `INFERRED_BUILDER`,
  `CONFIRMED_BUILDER` on seeded fixtures; keeps projects with no builder edge; ignores `ASSOCIATED_WITH`.
- **Builder identity (§6.1):** an award naming a supplier with no role statement is reported
  `ROLE_UNCERTAIN`, never an inferred or confirmed builder; a specialist with a narrow scope and no explicit
  role statement is `ROLE_UNCERTAIN` (D7 rule 1); design, PM, QS, supply-only and panel awards yield no `APPOINTED_BUILDER` edge; a `CONFIRMED`
  promotion with `UNSPECIFIED_SUPPLIER` or a name-only match is rejected; evidence from a different
  `Opportunity` than the project's is rejected.
- **Trade tiers:** a keyword-only match creates `TRADE_RELEVANCE` and can never be `CONFIRMED`; a
  `CONFIRMED` `REQUIRES_TRADE` needs a structured class or explicit scope statement; `PACKAGE_AVAILABLE`
  needs an open notice with a future `validUntil` and flips to `EXPIRED` after bid close; a DA or award never
  creates it; the §10 query reports `TRADE_RELEVANCE_ONLY` for a keyword-only project.
- **Transactional integrity (§7.2):** a failure at any step rolls back edge, evidence and audit together;
  concurrent ingestions of one conflict group serialise (advisory lock) without a lost conflict; no
  `CONFIRMED` row exists without validated basis evidence; the FK and CHECKs reject a basis from another
  edge, another target, or a disallowed class/assertion; direct `UPDATE ... SET verification='CONFIRMED'`
  without basis is rejected.
- **Evidence validity (§7.3):** retracting the basis evidence clears the basis in the same statement
  (trigger); expiry, a licence downgrade to `prohibited`/`unverified`, a content-hash change and a gate-mode
  change each make the revalidation job demote the edge with a `SYSTEM` review row; the §10 query shows the
  edge as inferred *before* the job runs; re-promotion needs new eligible evidence.
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

### 14.1 Revision 3: the four additional corrections

| # | Correction | Where |
|---|---|---|
| 1 | An award does not prove the head builder; confirm `APPOINTED_BUILDER` only on explicit primary evidence of the role on that project | §2.3, §6.1, §9.2, §10 |
| 2 | Separate trade relevance, explicitly required trades and confirmed open packages; keyword matches are never confirmed opportunities | §2.2, §6.1, §10, §11.3–11.4 |
| 3 | Transactional creation: inferred edge, attach evidence, validate, promote; foreign keys alone cannot establish eligibility | §5.3, §7.2, §13.4 |
| 4 | A `CONFIRMED` edge must retain currently eligible, unretracted, licensed primary evidence for that exact relationship, or stop being confirmed | §7.3, §10, §13.4 |

### 14.2 Provisional classification rules (D7)

| Rule | Where |
|---|---|
| Specialists are not principal builders without explicit evidence | §6.1 (D7 rule 1), §10 |
| Documented same-notice corrections are supersessions; undocumented supplier changes are conflicts | §7, §9.4, §13.4 |
| Ambiguous roles stay uncertain (`ROLE_UNCERTAIN`), never inferred | §2.3, §6.1, §10 |
| Re-published notices keep every version and the change between them | §5.3, §7 |

## 15. Decisions needing your approval

| # | Decision | Recommendation |
|---|---|---|
| D1 | Outward use requires `confirmed` licence even when `SOURCE_LICENCE_GATE` is `off` | **Yes.** The graph is new and default-off, so it can be stricter; effect today is shadow-only until AusTender is confirmed |
| D2 | v1 workspace-scoped only, with no shared public tier | **Yes**; revisit after licences are confirmed |
| D3 | Index build strategy for the five existing tables | Decide in PR 3 from measured row counts |
| D4 | Which role may promote/resolve edges | **Verified in §7.1:** new `graph:review` capability at the admin tier (admin and owner), mirroring `campaign:approve_draft`; added in PR 6 with matrix and test rows |
| D5 | Gold-set labelling: who labels, and the ≥ 100 project size | **Label owner: the project owner, provisionally.** Independent construction-domain reviewer **unassigned**, no sign-off recorded (§11.6); blocks PR 2 and fixing §11.4 floors |
| D6 | Integer 0–100 confidence (replacing the first draft's decimal) | **Yes**, consistent with `CommercialEvent.confidence` |
| D7 | Classification rules for specialists, supplier corrections, conflicts, ambiguous roles and re-published notices | **Provisional rules adopted by the project owner (§6.1):** specialists are not principal builders without explicit evidence; documented same-notice corrections supersede; unresolved contradictory supplier evidence is a conflict; ambiguous roles stay uncertain; re-published notices preserve provenance and material changes. Pending the independent review in §11.6 |

## 16. Known limitations

- Today's registered sources identify an awarded supplier on a contract award, but **not** a builder on a
  development application, so confirmed builder links will initially come from awards only.
- Both registered sources are `unverified`; until that changes, nothing is outward-eligible.
- Entity merge/split tooling and `SUBCONTRACT_AWARDED` ingestion from public sources are out of scope.
- Threshold values in §9 and §11.4 are starting points and are fixed only after the PR 1 baseline.
- Explicit builder-role statements are uncommon in public award notices, so confirmed builder links will be
  few until reviewers verify roles (§6.1). Recall will be below the baseline's by design.
- `PACKAGE_AVAILABLE` has no public source today; in v1 it can only come from a registered tender-type
  source for that trade or an authorised manual entry.
- A DA and a later award for the same site are separate `Opportunity` rows, hence separate PROJECT nodes.
  Linking them is not automatic in v1 (a reviewer-verified project link is the only path to carry a builder
  from an award onto a DA project).
