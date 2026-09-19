# ACAOS Engineering Roadmap: SaaS Excellence
## Positioning Inbox Assistant for Rapid Scaling

**Timeframe:** 90 days  
**Focus:** Product velocity + operational maturity + customer obsession  
**Success Criteria:** Free → Paid conversion >30%, WAU >80%, NPS >50, <2% error rate

---

## Phase 1: Immediate Wins (Week 1-2)
### Goal: Ship high-impact features that drive trial-to-paid conversion

#### 1.1 Inbox Assistant MVP Completeness
**Current State:** Email classification + reply suggestions exist; some flows unfinished  
**Work:**
- [ ] Verify end-to-end email → classify → suggest → approve → send flow is seamless
- [ ] Add visual confirmation after successful send (celebration moment for users)
- [ ] Implement "undo send" for 30 seconds (trust-building for nervous users)
- [ ] Add reply suggestion quality metrics (show user: "We're 92% accurate on this sender type")

**Expected Impact:** +20% engagement, reduced anxiety about AI-generated content

#### 1.2 Free Trial Experience
**Current State:** Workspace creation works; no clear trial path  
**Work:**
- [ ] Auto-configure first email inbox on signup (reduce friction to "first value moment")
- [ ] Pre-seed 3-5 classified reply examples for demo purposes
- [ ] Add "Skip this step" buttons to onboarding (don't force setup)
- [ ] Create progress tracker: "Setup 1/3 steps complete" → "2/3" → "Connected! Here's what to do next"

**Expected Impact:** +30% onboarding completion, faster time-to-first-value

#### 1.3 Mobile Email Notifications (Optional but high-impact)
**Current State:** No push notifications  
**Work:**
- [ ] Implement for: incoming reply classified as INTERESTED, time-sensitive actions
- [ ] Schema: notify when new INTERESTED reply arrives in inbox (actionable)
- [ ] Don't spam: digest unread replies in daily summary at 9am/6pm (user configurable)
- [ ] Testing: verify email-to-push latency <2 seconds

**Expected Impact:** +40% daily active users on paid plan

---

## Phase 2: Foundation & Reliability (Week 3-4)
### Goal: Build operational maturity to support 1000+ active users

#### 2.1 Email Resilience & Scale
**Current State:** Email parsing works; high-volume inbox edge cases untested  
**Work:**
- [ ] Implement batching: process 50+ daily emails without latency spike
- [ ] Add retry logic for transient IMAP failures (3 exponential backoff attempts)
- [ ] Implement circuit breaker for external email services (graceful degradation)
- [ ] Test: 500 concurrent email imports without queueing bottleneck
- [ ] Add instrumentation: track email processing latency per provider (Gmail vs Outlook)

**Expected Impact:** >99.5% uptime for core Inbox flow

#### 2.2 Database Performance
**Current State:** Single Postgres instance; no query optimization  
**Work:**
- [ ] Index analysis: identify slow queries in Inbox read path
- [ ] Add indexes on: (workspaceId, createdAt DESC) for inbox list, (senderId, classification) for patterns
- [ ] Profile: reply classification query should complete in <100ms
- [ ] Implement query result caching for "recent replies by classification" (TTL: 5min)
- [ ] Verify N+1 query elimination in Inbox view

**Expected Impact:** 3-5x latency improvement, enable real-time classification

#### 2.3 Error Tracking & Alerting
**Current State:** Sentry integrated; alerts not configured  
**Work:**
- [ ] Configure Sentry alerts for:
  - Email parsing failures (>5 in 5min)
  - AI classification errors (>10 in 1hr)
  - Reply send failures (>3 in 5min)
- [ ] Set up dashboards: Sentry + custom metrics showing:
  - Classification accuracy % by sender
  - Email delivery SLA (95th percentile latency)
  - Error rate by API endpoint
- [ ] Implement runbooks for common errors (missing OAuth refresh, billing provider timeout)

**Expected Impact:** <5min MTTR for production issues

#### 2.4 Frontend Test Coverage
**Current State:** Tests exist but don't cover Inbox flows  
**Work:**
- [ ] Add E2E tests:
  - [ ] Email inbox connection → classification → reply suggestion → approval → send
  - [ ] Batch import (10+ emails) → all classified within 2s
  - [ ] Error state recovery (network timeout → retry)
- [ ] Add component tests for Inbox cards, reply classification badges, action buttons
- [ ] Target: 70%+ coverage on Inbox-related code

**Expected Impact:** Zero regressions in paid product

---

## Phase 3: Growth & Retention (Month 2)
### Goal: Expand features and build engagement loops

#### 3.1 Reply Patterns & Learning
**Current State:** Classification is one-shot; no feedback loop  
**Work:**
- [ ] Implement: User marks AI suggestion as "good" or "bad"
- [ ] Store feedback: workspaceId + classification + user_rating
- [ ] Show confidence interval on suggestions: "We're 87% confident this is INTERESTED"
- [ ] Weekly email: "Your inbox assistant got 94 replies right this week, 3 misclassified"
- [ ] Auto-adjust: apply workspace-specific confidence thresholds after 50 samples

**Expected Impact:** +15% engagement, build trust in AI

#### 3.2 Multi-Workspace & Team Seats
**Current State:** Single user per workspace; Starter plan allows 5 seats  
**Work:**
- [ ] Remove 1-workspace limitation (allow agency to add 5 client workspaces on one bill)
- [ ] Implement workspace switcher in sidebar
- [ ] Unified inbox dashboard: "All client inboxes at a glance"
- [ ] Billing: show seat usage % and upgrade prompt when approaching limit

**Expected Impact:** +25% ARPU, team expansion revenue

#### 3.3 Automation: Smart Reply Composer
**Current State:** Suggests reply text; user must copy/paste  
**Work:**
- [ ] Add "Use this reply" button → auto-fills composer with suggested text
- [ ] Implement: "Assistant, write a reply that says we'll follow up Monday"
- [ ] Save templates: "Quick positive response," "Request more info," "Pass to team"
- [ ] Track: how many replies use AI suggestions vs manual (optimize based on real usage)

**Expected Impact:** +50% reply volume, 5min/week time saved per user

#### 3.4 Analytics Dashboard (Paid Only)
**Current State:** Usage metrics exist; not exposed to user  
**Work:**
- [ ] Show: "Email stats this month"
  - Inbox volume trend (daily, weekly)
  - Reply classification breakdown (pie chart)
  - Time to respond (avg days from receive to reply)
  - Top senders by reply rate
- [ ] Benchmark: "Industry average response time is 2.1 days; you're at 1.8 days ✓"
- [ ] Export: monthly CSV of inbox metrics (for client reports)

**Expected Impact:** +20% perceived value, justifies renewal

---

## Phase 4: Scale & Expansion (Month 3)
### Goal: Prepare for 10,000+ users and multi-module revenue

#### 4.1 Multi-Tenant Performance Hardening
**Current State:** Multi-tenant works; no tenant isolation verification  
**Work:**
- [ ] Add middleware: verify workspace_id matches authenticated user + ingest key
- [ ] Implement rate limiting per workspace: 100 emails/min, 1000 AI calls/month
- [ ] Test: one rogue workspace hitting rate limit doesn't affect others
- [ ] Database connection pool: verify per-tenant connections don't leak
- [ ] Load test: 500 concurrent workspaces, 10 each processing email, no latency spike

**Expected Impact:** <1ms extra latency for multi-tenant isolation verification

#### 4.2 Cross-Module Revenue Foundation
**Current State:** Inbox Assistant only  
**Work:**
- [ ] Design: "Lead scoring" → offer upgrade path from Inbox
- [ ] Implement: optional lead enrichment API call (costs money, upsell)
- [ ] Pricing: $0.50 per enrichment, charge when used (transparent)
- [ ] UX: "Your reply came from john@acme.com; want to enrich their company? $0.50"
- [ ] Implement upgrade prompt in Inbox when patterns suggest need for discovery

**Expected Impact:** Foundation for Growth plan upsell

#### 4.3 API Ecosystem
**Current State:** No public API  
**Work:**
- [ ] Publish API docs: inbox read/list, reply creation, classification fetch
- [ ] Implement webhook: "new classified reply" → Slack, Zapier, HTTP
- [ ] Rate limiting: 100 API calls/min per token (Inbox Asst), higher for Growth
- [ ] SDK: JavaScript client for agencies to build custom dashboards
- [ ] Test: verify API backwards compatibility in CI

**Expected Impact:** 3rd-party integrations, expansion of TAM

#### 4.4 Compliance & Security
**Current State:** Multi-tenant; audit trails exist; compliance docs missing  
**Work:**
- [ ] Implement: GDPR data export (all user data as JSON in <24h)
- [ ] Implement: Right to deletion (cascade all workspace data)
- [ ] Add: SOC 2 Type II readiness checklist
- [ ] Document: data retention policy (emails deleted after 90 days by default)
- [ ] Test: verify encryption of email credentials at rest

**Expected Impact:** Unlock enterprise sales, customer trust

---

## Technical Debt & Foundation

### Priority Bug Fixes
- [ ] Fix: email parsing edge case with unusual charsets (1% of users hit this)
- [ ] Fix: reply suggestion latency spike on >500 unread emails in inbox
- [ ] Fix: IMAP OAuth refresh race condition (causes occasional auth failures)

### Infrastructure
- [ ] Set up: horizontal pod autoscaling in Kubernetes (currently manual)
- [ ] Implement: canary deployments (5% → 25% → 100%, with rollback)
- [ ] Add: synthetic monitoring (test Inbox flow every 5min from 3 geographies)
- [ ] Upgrade: Node.js version to 22 LTS (currently on 20)

### Observability
- [ ] Dashboard: "Email processing SLA" (95th percentile latency, error rate)
- [ ] Dashboard: "Pricing & Revenue" (MRR, ARPU, churn by cohort)
- [ ] Dashboard: "Product Health" (signup → trial completion % funnel)
- [ ] Alerts: notify team when daily churn >3% or MRR growth <5%

---

## Resource & Dependencies

### Team Needed
- **Backend:** 1 engineer (email resilience + API expansion)
- **Frontend:** 1 engineer (UI polish + onboarding flow)
- **DevOps:** 0.5 engineer (monitoring + deployment automation)
- **Product:** 1 PM (metrics + user feedback loops)

### Critical Dependencies
- Stripe API: webhook handling for subscription changes
- OpenAI: rate limits must support 100+ concurrent classification calls
- Email providers: Gmail/Outlook API quotas (verify sufficient allocation)
- Database: Postgres must support concurrent connections for 100+ workspaces

---

## Success Metrics & Milestones

### Week 2 (First Wins)
- [ ] Trial-to-paid conversion: 20%+
- [ ] Onboarding completion: 80%+
- [ ] Email classification accuracy: 90%+

### Week 4 (Foundation)
- [ ] API response time p95: <200ms
- [ ] Error rate: <1%
- [ ] Database query time p95: <100ms

### Month 2 (Growth)
- [ ] WAU: 80%+
- [ ] Multi-workspace adoption: 15% of paid users
- [ ] Reply automation usage: 30% of classifications

### Month 3 (Scale)
- [ ] MRR: $50K+ (assuming 250+ paid users at $150/mo avg)
- [ ] Churn: <5% monthly
- [ ] NPS: 50+
- [ ] 10K+ free users

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Email API quota exceeded | 🔴 High | Implement queue backoff, buy higher quota tier, cache classifications |
| AI classification accuracy <85% | 🔴 High | Add feedback loop, reduce confidence threshold, human review mode |
| Competitor launches cheaper | 🟡 Medium | Emphasize trust/approval workflow, build switching costs (integrations) |
| Churn >10% | 🔴 High | Daily engagement metrics, re-engagement campaigns, feature releases |
| Breach/data loss | 🔴 Critical | Encrypt credentials at rest, enable WAF, regular pen testing, insurance |

---

## Decision Framework

**Ship or Defer:**
- Feature is > 3 weeks of work → Defer to Month 2
- Feature touches email reliability → Ship immediately (core trust)
- Feature is < 1 week, driven by user feedback → Ship immediately
- Feature is "nice-to-have" → Defer unless it unblocks other work

**Quality Standards:**
- Error rate must stay <1% in production
- API p95 latency must stay <300ms
- Email parsing must handle 99% of formats (graceful degr on edge cases)
- All customer-facing messages must be spell-checked and tested

---

**Status:** Ready for execution  
**Next:** Daily standup on progress; weekly review of metrics  
**Owner:** Engineering team + PM + DevOps
