# ACAOS Changelog

## Unreleased

### Operator console (phase 14)
- New *Today* screen: what needs a decision with its evidence and contact, new work this week,
  work worth watching, and pipeline / won revenue / quote-to-win / delivered margin
- Propose outreach (nothing sends), quote company-level opportunities, and opt in to
  cross-customer benchmarks from the console

### Delivery economics (phase 15A)
- Quotes on Work-discovery and commercial opportunities; accepting one marks the opportunity won
- Delivery jobs linked to Field Ops job sites, with live and frozen (closeout) economics:
  hours vs estimate, labour and gross margin, unknowns reported instead of zeroed
- `/api/delivery/*` (admin only); see `docs/ACQUISITION_OS_DELIVERY.md`

### Delivery economics (phase 15B)
- Record and decide quotes from Find work; new *Jobs & margins* screen with closeout and reopen
- Report of what closed work earns by origin (medians with sample sizes)
- Outcome graph attributes wins and revenue to the exact quoted opportunity

## v1.3.0 — Full Build Pass

### API — New routes
- `GET/POST /api/campaigns` — list and create campaigns per workspace
- `GET/PATCH/DELETE /api/campaigns/:id` — read, update, delete campaigns
- `GET /api/leads` — paginated lead list with workspace/campaign/stage filters
- `POST /api/leads` — create single lead
- `POST /api/leads/import` — bulk import up to 500 leads
- `GET/PATCH/DELETE /api/leads/:id` — read, update stage/AI fields, delete
- `POST /api/billing/webhook` — Stripe webhook with signature verification

### API — Fixes
- Fixed OpenAI model name: `gpt-5.4-mini` → `gpt-4o-mini`
- Fixed OpenAI service: `responses.create` → `chat.completions.create` with `json_object` response format
- Added `userBelongsToWorkspace` helper to workspaces lib

### Worker — Now functional
- `research-lead`: fetches AI summary + outreach angle, writes back to Lead row, advances to RESEARCHED
- `generate-outreach`: generates subject/email/followup copy for a lead
- `analyze-reply`: classifies reply, advances INTERESTED leads to REPLIED stage
- `sync-mailbox`: invokes IMAP sync, logs results per workspace

### Frontend — Full rebuild
- Dashboard with workspace/campaign/lead stat cards
- Campaigns page: list, create, delete
- Leads page: filterable table by stage, paginated, add single lead, detail panel, stage transitions
- AI Tools page: Research / Outreach / Reply tabs with live API calls
- Billing page: Stripe checkout trigger
- Sidebar navigation, JWT auth with logout-on-401
