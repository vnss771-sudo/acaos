# ACAOS API Reference

**Objective:** Complete API documentation for developers integrating with ACAOS.

**Audience:** Backend engineers, integration partners, API consumers

**Last Updated:** 2026-09-20

---

## Table of Contents

1. [Authentication](#authentication)
2. [Core Concepts](#core-concepts)
3. [API Endpoints](#api-endpoints)
4. [Error Handling](#error-handling)
5. [Rate Limiting](#rate-limiting)
6. [Webhooks](#webhooks)
7. [SDK & Libraries](#sdk--libraries)

---

## Authentication

### API Key Authentication

**Get your API key:**

1. Log into ACAOS dashboard
2. Settings → **API Keys** → **Create New**
3. Copy the key (displayed once; save securely)

**Use in requests:**

```bash
curl -H "Authorization: Bearer acaos_secret_1234567890abcdef" \
  https://api.acaos.example.com/api/prospects
```

**In code:**

```javascript
const response = await fetch('https://api.acaos.example.com/api/prospects', {
  headers: {
    'Authorization': 'Bearer acaos_secret_1234567890abcdef',
    'Content-Type': 'application/json'
  }
});
```

### JWT Authentication (Web)

The web dashboard uses JWT tokens (handled automatically in browser). API integrations should use API keys (above).

---

## Core Concepts

### Workspaces

A **workspace** is your isolated organization environment.

```
GET /api/workspaces
→ Returns current workspace details
  {
    "id": "ws_abc123",
    "name": "Acme Agency",
    "plan": "growth",
    "stripeCustomerId": "cus_xyz789"
  }
```

### Users & Team

Users in a workspace have roles:

```
GET /api/workspaces/:workspaceId/team
→ Returns team members
  [
    {
      "id": "user_123",
      "email": "john@acme.com",
      "name": "John Smith",
      "role": "owner",
      "invitedAt": "2026-01-15T10:00:00Z"
    }
  ]
```

### Prospects

**Prospects** = potential customers / contacts you're outreaching to.

```
POST /api/prospects
  {
    "email": "alice@techcorp.com",
    "firstName": "Alice",
    "lastName": "Johnson",
    "company": "TechCorp",
    "title": "VP Sales"
  }
→ Returns created prospect with ID

GET /api/prospects/:id
→ Returns prospect details

PUT /api/prospects/:id
→ Update prospect fields

DELETE /api/prospects/:id
→ Delete prospect
```

### Campaigns

**Campaigns** = outreach email sequences.

```
POST /api/campaigns
  {
    "name": "Q4 Outreach",
    "prospectIds": ["prospect_123", "prospect_456"],
    "emailTemplate": { subject, body },
    "sendAt": "2026-09-20T15:00:00Z"
  }
→ Returns campaign with ID

GET /api/campaigns/:id
→ Returns campaign details + analytics (sent count, bounce rate, etc)

PATCH /api/campaigns/:id
  { "status": "approved" }
→ Approve campaign for sending (if approval workflow enabled)

DELETE /api/campaigns/:id
→ Cancel campaign (if not already sent)
```

### Emails & Sends

**Sends** = individual emails sent to prospects.

```
GET /api/campaigns/:campaignId/sends
→ Returns all emails sent in campaign
  [
    {
      "id": "send_123",
      "prospectEmail": "alice@techcorp.com",
      "status": "delivered",
      "sentAt": "2026-09-20T15:00:00Z",
      "bounceReason": null
    }
  ]

GET /api/sends/:id/metrics
→ Returns: opened, clicked, replied
```

### Inbox & Replies

**Inbox** = incoming replies to your campaigns.

```
GET /api/inbox
  { workspaceId, limit: 50 }
→ Returns recent emails (replies to your campaigns)
  [
    {
      "id": "msg_123",
      "fromEmail": "alice@techcorp.com",
      "subject": "Re: Q4 Outreach",
      "body": "Hi John, we're interested...",
      "sentAt": "2026-09-20T16:00:00Z",
      "relatedSend": "send_123"
    }
  ]

POST /api/inbox/:messageId/reply
  { "body": "Great! Let's schedule a call..." }
→ Sends reply to original sender
```

---

## API Endpoints

### Authentication & Account

```
POST /api/auth/signup
  { email, password, workspaceName }
→ 201 Created; sets JWT cookie

POST /api/auth/login
  { email, password }
→ 200 OK; JWT cookie

POST /api/auth/logout
→ 204 No Content

POST /api/auth/refresh
→ 200 OK; refreshes JWT

GET /api/auth/me
→ 200 OK; current user details
```

### Workspaces

```
GET /api/workspaces
→ 200 OK; list of workspaces user is member of

GET /api/workspaces/:id
→ 200 OK; workspace details

PATCH /api/workspaces/:id
  { name, senderBusinessName, senderPostalAddress, ... }
→ 200 OK; update workspace settings

DELETE /api/workspaces/:id
→ 204 No Content; delete workspace (cascades to all data)
```

### Team Management

```
GET /api/workspaces/:workspaceId/team
→ 200 OK; list team members

POST /api/workspaces/:workspaceId/team/invite
  { email, role: "operator"|"admin"|"viewer" }
→ 201 Created; sends invite email

PATCH /api/workspaces/:workspaceId/team/:userId
  { role: "operator" }
→ 200 OK; change user role

DELETE /api/workspaces/:workspaceId/team/:userId
→ 204 No Content; remove user from workspace
```

### Prospects

```
GET /api/prospects
  { workspaceId, limit: 50, offset: 0, status: "active", ... }
→ 200 OK; paginated list

POST /api/prospects
  { email, firstName, lastName, company, title, ... }
→ 201 Created

POST /api/prospects/bulk
  { prospects: [ { email, firstName, ... }, ... ] }
→ 201 Created; bulk import

GET /api/prospects/:id
→ 200 OK; prospect details

PUT /api/prospects/:id
  { firstName, company, ... }
→ 200 OK; update prospect

DELETE /api/prospects/:id
→ 204 No Content

GET /api/prospects/search
  { q: "alice@techcorp.com", limit: 10 }
→ 200 OK; search by email/name
```

### Campaigns

```
GET /api/campaigns
  { workspaceId, limit: 50, status: "sent"|"draft"|... }
→ 200 OK; list campaigns

POST /api/campaigns
  {
    name: "Q4 Outreach",
    prospectIds: ["prospect_123"],
    template: {
      subject: "Hi {{firstName}}",
      body: "Are you interested in {{company}}?",
      variables: ["firstName", "company"]
    },
    sendAt: "2026-09-20T15:00:00Z"
  }
→ 201 Created; campaign created (status: draft)

GET /api/campaigns/:id
→ 200 OK; campaign details + stats

PATCH /api/campaigns/:id
  { status: "approved"|"rejected" }
→ 200 OK; approve/reject (requires approval role)

POST /api/campaigns/:id/send
→ 202 Accepted; queue campaign for sending

DELETE /api/campaigns/:id
→ 204 No Content; delete draft campaign
```

### Campaign Analytics

```
GET /api/campaigns/:id/analytics
→ 200 OK; campaign stats
  {
    sent: 50,
    delivered: 48,
    bounced: 2,
    opened: 20,
    clicked: 5,
    replied: 3,
    bounceRate: 0.04,
    openRate: 0.40,
    replyRate: 0.06
  }

GET /api/campaigns/:id/sends
→ 200 OK; list individual sends with per-email metrics
```

### Inbox & Replies

```
GET /api/inbox
  { workspaceId, limit: 50 }
→ 200 OK; recent incoming emails

GET /api/inbox/:id
→ 200 OK; single email details

POST /api/inbox/:id/reply
  { body: "Response text" }
→ 202 Accepted; queue reply for sending

POST /api/inbox/:id/approve
  { approved: true }
→ 200 OK; approve reply before sending (if approval workflow enabled)

POST /api/inbox/:id/archive
→ 200 OK; archive email from inbox
```

### Email Configuration

```
GET /api/email-accounts
→ 200 OK; list connected email accounts

POST /api/email-accounts
  { provider: "gmail"|"outlook"|"custom", config: {...} }
→ 201 Created; add email account

DELETE /api/email-accounts/:id
→ 204 No Content; remove email account

POST /api/email-accounts/:id/test
→ 200 OK; test email account (sends test email)
```

### API Keys

```
GET /api/api-keys
→ 200 OK; list API keys

POST /api/api-keys
  { name: "Zapier Integration" }
→ 201 Created; returns secret (shown once)

DELETE /api/api-keys/:id
→ 204 No Content; revoke API key
```

### Billing

```
GET /api/billing/subscription
→ 200 OK; current subscription details
  {
    plan: "growth",
    status: "active",
    currentPeriodEnd: "2026-10-20T00:00:00Z",
    nextBillingAmount: 29900,
    currency: "usd"
  }

POST /api/billing/subscription
  { planId: "growth" }
→ 200 OK; change subscription plan

DELETE /api/billing/subscription
→ 204 No Content; cancel subscription
```

### Admin (Platform-wide)

```
GET /api/admin/users
→ 200 OK; list all users (platform admin only)

GET /api/admin/workspaces
→ 200 OK; list all workspaces (platform admin only)

PATCH /api/admin/users/:id
  { isPlatformAdmin: true }
→ 200 OK; grant platform admin role
```

---

## Error Handling

### Error Response Format

All errors return JSON with consistent structure:

```json
{
  "error": "invalid_request",
  "message": "Missing required field: email",
  "details": {
    "field": "email",
    "code": "REQUIRED_FIELD"
  }
}
```

### Common Status Codes

| Code | Meaning | Example |
|------|---------|---------|
| **200 OK** | Request succeeded | GET /api/prospects |
| **201 Created** | Resource created | POST /api/campaigns |
| **202 Accepted** | Async job queued | POST /api/campaigns/:id/send |
| **204 No Content** | Success, no body | DELETE /api/prospects/:id |
| **400 Bad Request** | Invalid input | Missing required field |
| **401 Unauthorized** | Auth failed | Invalid API key |
| **403 Forbidden** | Access denied | User lacks permission |
| **404 Not Found** | Resource not found | GET /api/prospects/invalid-id |
| **409 Conflict** | State conflict | Approve already-sent campaign |
| **429 Too Many Requests** | Rate limited | See Rate Limiting below |
| **500 Internal Server Error** | Server error | Contact support |

### Example Error Responses

**Invalid email format:**

```bash
$ curl -X POST https://api.acaos.example.com/api/prospects \
  -H "Authorization: Bearer acaos_secret_1234567890abcdef" \
  -d '{"email": "not-an-email"}'

→ 400 Bad Request
{
  "error": "validation_error",
  "message": "Invalid email format",
  "details": {
    "field": "email",
    "code": "INVALID_EMAIL"
  }
}
```

**Unauthorized:**

```bash
$ curl https://api.acaos.example.com/api/prospects \
  -H "Authorization: Bearer invalid-key"

→ 401 Unauthorized
{
  "error": "invalid_token",
  "message": "Invalid or expired API key"
}
```

---

## Rate Limiting

ACAOS applies rate limiting to prevent abuse:

**Default limits:**

| Endpoint Type | Limit | Window |
|---------------|-------|--------|
| General API | 100 req/min | Per IP |
| Bulk endpoints | 10 req/min | Per workspace |
| Sending (campaigns) | 1000 emails/day | Per workspace |

**When rate limited (HTTP 429):**

```
HTTP/1.1 429 Too Many Requests

{
  "error": "rate_limit_exceeded",
  "message": "Too many requests. Please retry after 60 seconds",
  "retryAfter": 60
}
```

**Response headers:**

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 45
X-RateLimit-Reset: 1695168000
```

**Best practices:**

1. Respect `X-RateLimit-Remaining` header
2. Implement exponential backoff for retries
3. Contact support for higher limits (enterprise plans)

---

## Webhooks

### Event Types

ACAOS can POST events to your endpoint when things happen:

```
event_type: "campaign.sent"
  payload: {
    campaignId: "camp_123",
    prospectCount: 50,
    sentAt: "2026-09-20T15:00:00Z"
  }

event_type: "email.replied"
  payload: {
    sendId: "send_123",
    prospectEmail: "alice@techcorp.com",
    replyEmail: {
      id: "msg_456",
      subject: "Re: Q4 Outreach",
      body: "Yes, we're interested...",
      sentAt: "2026-09-20T16:00:00Z"
    }
  }

event_type: "email.bounced"
  payload: {
    sendId: "send_123",
    prospectEmail: "invalid@example.com",
    bounceReason: "mailbox does not exist",
    bouncedAt: "2026-09-20T15:05:00Z"
  }
```

### Setting Up Webhooks

1. Settings → **Webhooks** → **Add Endpoint**
2. Enter your endpoint URL: `https://yourapp.example.com/webhooks/acaos`
3. Select events to subscribe to (or "all events")
4. ACAOS will POST events to your endpoint

### Webhook Signature Verification

Every webhook includes a signature header for security:

```
X-Acaos-Signature: sha256=abc123def456...
X-Acaos-Timestamp: 1695168000
```

**Verify signature (Node.js example):**

```javascript
const crypto = require('crypto');

function verifyWebhook(body, signature, timestamp, secret) {
  // Check timestamp is recent (prevent replay attacks)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) {
    return false;  // Signature too old
  }
  
  // Compute expected signature
  const signed = `${timestamp}.${body}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signed)
    .digest('hex');
  
  // Constant-time compare
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from('sha256=' + expected)
  );
}

// Usage in Express:
app.post('/webhooks/acaos', express.raw({type: 'application/json'}), (req, res) => {
  const signature = req.headers['x-acaos-signature'];
  const timestamp = req.headers['x-acaos-timestamp'];
  
  if (!verifyWebhook(req.body, signature, timestamp, process.env.WEBHOOK_SECRET)) {
    return res.status(401).json({error: 'Invalid signature'});
  }
  
  const event = JSON.parse(req.body);
  console.log(`Received webhook: ${event.event_type}`);
  
  res.json({ok: true});
});
```

### Webhook Retry Policy

If your endpoint doesn't respond with 200-299:

```
Attempt 1: Immediately
Attempt 2: After 5 minutes
Attempt 3: After 30 minutes
Attempt 4: After 2 hours
Attempt 5: After 24 hours

After 5 failed attempts, webhook is disabled.
```

---

## SDK & Libraries

### JavaScript/TypeScript

```bash
npm install @acaos/sdk
```

```javascript
import { AcaosClient } from '@acaos/sdk';

const client = new AcaosClient({
  apiKey: 'acaos_secret_...',
  baseUrl: 'https://api.acaos.example.com'
});

// Create campaign
const campaign = await client.campaigns.create({
  name: 'Q4 Outreach',
  prospectIds: ['prospect_123'],
  template: {
    subject: 'Hi {{firstName}}',
    body: 'Are you interested in {{company}}?'
  }
});

// Send campaign
await client.campaigns.send(campaign.id);

// List replies
const replies = await client.inbox.list({ limit: 50 });
```

### Python

```bash
pip install acaos-sdk
```

```python
from acaos import AcaosClient

client = AcaosClient(api_key='acaos_secret_...')

# Create prospect
prospect = client.prospects.create(
    email='alice@techcorp.com',
    firstName='Alice',
    lastName='Johnson',
    company='TechCorp'
)

# Create campaign
campaign = client.campaigns.create(
    name='Q4 Outreach',
    prospectIds=[prospect.id],
    template={
        'subject': 'Hi {{firstName}}',
        'body': 'Are you interested in {{company}}?'
    }
)

# Send
client.campaigns.send(campaign.id)
```

### cURL

See examples throughout this document, e.g.:

```bash
curl -X POST https://api.acaos.example.com/api/campaigns \
  -H "Authorization: Bearer acaos_secret_..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Q4 Outreach",
    "prospectIds": ["prospect_123"],
    "template": {
      "subject": "Hi {{firstName}}",
      "body": "Are you interested in {{company}}?"
    }
  }'
```

---

## Examples & Use Cases

### Use Case 1: Bulk Import Prospects from CSV

```javascript
const csv = require('csv-parse');
const fs = require('fs');
const { AcaosClient } = require('@acaos/sdk');

const client = new AcaosClient({ apiKey: 'acaos_secret_...' });

async function importProspects() {
  const prospects = [];
  
  fs.createReadStream('prospects.csv')
    .pipe(csv.parse({ columns: true }))
    .on('data', (row) => {
      prospects.push(row);
    })
    .on('end', async () => {
      // Bulk import
      const result = await client.prospects.bulkCreate(prospects);
      console.log(`Imported ${result.count} prospects`);
    });
}
```

### Use Case 2: Auto-Reply to Interested Prospects

```javascript
// Webhook handler for email.replied event
app.post('/webhooks/acaos', async (req, res) => {
  const event = req.body;
  
  if (event.event_type === 'email.replied') {
    const { sendId, prospectEmail, replyEmail } = event.payload;
    
    // Check if reply contains interest keywords
    if (replyEmail.body.toLowerCase().includes('interested')) {
      // Auto-reply
      await client.inbox.reply(replyEmail.id, {
        body: `Thanks for your interest! Let's schedule a call: [Calendly link]`
      });
    }
  }
  
  res.json({ ok: true });
});
```

### Use Case 3: Create Campaign from Zapier

```javascript
// Zapier webhook → Create ACAOS campaign
// Zapier calls this webhook with prospect data

app.post('/zapier/create-campaign', async (req, res) => {
  const { prospectEmail, prospectName, company } = req.body;
  
  // Create prospect
  const prospect = await client.prospects.create({
    email: prospectEmail,
    firstName: prospectName.split(' ')[0],
    company: company
  });
  
  // Create campaign
  const campaign = await client.campaigns.create({
    name: `Campaign for ${company}`,
    prospectIds: [prospect.id],
    template: {
      subject: `Hi {{firstName}}, quick question about {{company}}`,
      body: `Hi {{firstName}},\n\nI think {{company}} could benefit from our services...`
    }
  });
  
  // Send immediately
  await client.campaigns.send(campaign.id);
  
  res.json({ campaignId: campaign.id });
});
```

---

## Support

- **API Status:** https://status.acaos.example.com
- **Documentation:** https://docs.acaos.example.com
- **Support Email:** api-support@acaos.example.com
- **Rate limit increase:** Contact support for enterprise plans

