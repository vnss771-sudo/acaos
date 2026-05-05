# Railway Deployment Notes

Create services for:
- Postgres
- Redis
- API
- Worker
- Web

Recommended order:
1. Provision Postgres and Redis
2. Deploy API with env vars
3. Run Prisma migrate against Railway Postgres
4. Deploy worker
5. Deploy web
6. Attach Stripe webhook URL to Railway API
