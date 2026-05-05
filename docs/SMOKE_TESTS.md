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
