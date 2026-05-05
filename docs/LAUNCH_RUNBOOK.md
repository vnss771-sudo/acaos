# Launch Runbook

## 1. Local bring-up
1. Copy `.env.example` to `.env`
2. Fill in Postgres, Redis, JWT, OpenAI, Stripe, SMTP, and IMAP values
3. Run `npm install`
4. Run `npm run prisma:generate`
5. Run `npm run prisma:migrate`
6. Run `npm run dev:web`, `npm run dev:api`, and `npm run dev:worker`

## 2. Pre-launch checklist
- [ ] Signup and login work end to end
- [ ] Workspace creation works
- [ ] Leads CRUD works
- [ ] AI research endpoint returns valid JSON
- [ ] Outreach generation returns draft content
- [ ] Stripe checkout creates a session
- [ ] Webhook endpoint verifies signatures
- [ ] SMTP sends to a test inbox
- [ ] IMAP sync can read the test inbox
- [ ] Queue worker consumes a test job
- [ ] Prisma migrations applied in staging
- [ ] Admin health endpoint returns green

## 3. Staging
- Deploy Postgres + Redis
- Deploy API
- Deploy worker
- Deploy web
- Point staging Stripe/webhooks to staging URLs
- Test with a real mailbox and a low-volume test workspace

## 4. Production launch day
- Apply production migrations
- Verify environment variables
- Enable Stripe live keys
- Enable OpenAI production key
- Enable SMTP/IMAP production mailbox
- Smoke test auth, lead create, queue create, send, reply analyze
- Watch logs for 60 minutes

## 5. First week metrics
- Signup conversion
- Workspace creation rate
- Lead import count
- AI action usage
- Messages sent
- Reply rate
- Booked calls
- Payment conversion
- Worker failures
