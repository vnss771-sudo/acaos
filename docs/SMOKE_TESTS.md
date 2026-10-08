# Smoke Tests

## Auth
- Create user
- Login
- Fetch `/api/auth/me`

## Workspace
- Create workspace
- List workspaces

## Leads
- Create lead
- Update lead
- List leads for workspace

## AI
- Research one lead
- Generate outreach for one lead
- Analyze one reply

## Billing
- Create checkout session
- Hit webhook with a Stripe CLI test event

## Mailbox
- Send a test email
- Sync inbox
- Confirm reply ingestion

## Worker
- Queue research job
- Confirm worker picks it up
- Confirm DB side-effect exists

## Pilot preflight ordering

The controlled-pilot command now runs the strict configuration policy before any expensive verification:

```bash
npm run pilot:preflight
```

Order: policy contract → repository verification → DB/Redis tiers → browser E2E → OpenAI smoke → discovery smoke → release metadata → optional deployed smoke. If deployment smoke URLs are supplied, the smoke must report the same release ID/commit as the candidate currently being certified.
