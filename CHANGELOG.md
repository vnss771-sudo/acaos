# ACAOS Changelog

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
