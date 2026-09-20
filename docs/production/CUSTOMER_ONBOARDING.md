# ACAOS Customer Onboarding Guide

**Objective:** Enable new agency customers to successfully set up and configure ACAOS for their team.

**Audience:** Sales engineers, customer success, new agency customers

**Last Updated:** 2026-09-20

---

## Table of Contents

1. [Pre-Launch Checklist](#pre-launch-checklist)
2. [Account Setup](#account-setup)
3. [Email Configuration](#email-configuration)
4. [Team Onboarding](#team-onboarding)
5. [First Campaign (Quick Start)](#first-campaign-quick-start)
6. [Configuration & Best Practices](#configuration--best-practices)
7. [Support & Escalation](#support--escalation)

---

## Pre-Launch Checklist

### What You Need Before Starting

- [ ] **ACAOS account created** (via signup or invited by sales)
- [ ] **Email inbox(es) ready** — IMAP/SMTP credentials from your email provider
  - Gmail: [App Password](https://support.google.com/accounts/answer/185833)
  - Outlook: Same email password + app password (if 2FA enabled)
  - Custom SMTP: Provided by your email hosting (e.g., SendGrid, Mailgun, Amazon SES)
- [ ] **Team roster** — Names and email addresses of team members who'll use ACAOS
- [ ] **Prospect list** (optional) — CSV of leads to import, or use discovery features
- [ ] **Brand info** — Company name, logo, postal address (for CAN-SPAM footer)

### Estimated Time

- **Basic setup:** 30 minutes
- **Email configuration:** 15 minutes
- **Team onboarding:** 20 minutes
- **First campaign:** 30 minutes
- **Total:** ~2 hours for a fully operational team

---

## Account Setup

### Step 1: Log In

1. Go to `https://acaos.example.com`
2. Click **Sign Up** (or use an invite link from sales)
3. Enter email + password (strong password required: 12+ characters, mixed case, numbers/symbols)
4. Click **Create Account**
5. **Verify your email** (click link in verification email)

### Step 2: Create Your Workspace

**Workspace** = Your organization's isolated environment. One workspace per company/subsidiary.

1. After email verification, you're prompted to create a workspace
2. Enter **Workspace Name:** e.g., "Acme Sales Agency"
3. Click **Create Workspace**
4. You're now the **Owner** (full permissions)

### Step 3: Set Billing

**ACAOS uses Stripe for billing.** Choose your plan:

| Plan | Monthly | Limits | Best For |
|------|---------|--------|----------|
| **Free** | $0 | 100 emails/month, 1 user | Trials, small teams |
| **Starter** | $99 | 10k emails/month, 3 users | Small agencies (<5 users) |
| **Growth** | $299 | Unlimited emails, 10 users | Growing agencies (5-20 users) |
| **Enterprise** | Custom | Custom limits, dedicated support | Large agencies (20+ users) |

**To set billing:**

1. Dashboard → **Settings** → **Billing**
2. Select plan → Click **Upgrade**
3. Enter Stripe payment details (card or invoice)
4. **Confirmation:** Your plan is now active; invoice emailed

**Special offer (first 30 days):**
- Free tier customers get 50% off their first month of Starter/Growth plans

---

## Email Configuration

### Add Your Email Account

ACAOS can read replies from multiple email accounts (multi-inbox support).

#### Option A: Gmail (Recommended)

**Steps:**

1. Settings → **Email Accounts** → **Add Account**
2. Select **Gmail**
3. Click **Connect with Google** (opens Google OAuth)
4. **Select the Gmail account** you want to use
5. **Grant permissions:**
   - Read emails (IMAP)
   - Send emails (SMTP)
6. Click **Authorize**
7. ACAOS confirms connection and shows inbox details

**What happens next:**

- ACAOS syncs your inbox every 10 minutes
- New replies appear in **Inbox Assistant** automatically
- You can send outreach from this email account

**Permissions you're granting:**

```
✓ Read emails (detect replies to your campaigns)
✓ Send emails (send your replies and new campaigns)
✗ Access calendar, contacts, or other data (not requested)
```

#### Option B: Outlook

1. Settings → **Email Accounts** → **Add Account**
2. Select **Outlook** (Office 365)
3. Enter your Outlook email + password
4. If prompted, approve device login in Outlook security settings
5. Done!

**Note:** If 2-factor auth is enabled, you may need an app password instead of your regular password.

#### Option C: Custom SMTP/IMAP

1. Settings → **Email Accounts** → **Add Account**
2. Select **Custom SMTP/IMAP**
3. Fill in details (from your email hosting provider):
   - **IMAP Server:** imap.example.com
   - **IMAP Port:** 993 (usually)
   - **IMAP Username:** your-email@example.com
   - **IMAP Password:** (or app password if using 2FA)
   - **SMTP Server:** smtp.example.com
   - **SMTP Port:** 587 (usually)
   - **SMTP Username:** your-email@example.com
   - **SMTP Password:** (or app password)
4. Click **Test Connection** (ACAOS sends a test email to verify)
5. Click **Save**

**Example: Gmail with custom domain**

```
Custom domain with Gmail backend (your-company.com email powered by Gmail):

IMAP Server:   imap.gmail.com
IMAP Port:     993
IMAP User:     your-email@your-company.com
IMAP Password: [Gmail App Password from step above]

SMTP Server:   smtp.gmail.com
SMTP Port:     587
SMTP User:     your-email@your-company.com
SMTP Password: [Gmail App Password]
```

### Verify Inbox Sync

After configuring an email account:

1. Go to **Inbox Assistant** → **Inbox** tab
2. You should see your recent emails (sync may take 30 seconds)
3. If no emails appear:
   - Check Settings → **Email Accounts** → status should be "Connected"
   - If "Connection Failed," re-test credentials
   - Check email account has IMAP enabled (not disabled for security)

### Multiple Email Accounts (Team)

To add more email inboxes (one per team member):

1. Repeat steps above for each email account
2. Each email account appears in **Inbox Assistant** → **Inbox** with a filter
3. Team can collaborate on shared inboxes, or each person has their own

---

## Team Onboarding

### Invite Team Members

1. Settings → **Team** → **Invite Members**
2. Enter email address(es) of team members
3. Select **Role:**
   - **Operator:** Can send campaigns, reply to emails, view analytics (most common)
   - **Admin:** Can manage team + settings (usually just you as owner)
   - **Viewer:** Read-only access to dashboards (good for managers)
4. Click **Send Invites**
5. Team members receive email invitation; click link to join workspace

**Maximum users per plan:**

| Plan | Users |
|------|-------|
| Free | 1 |
| Starter | 3 |
| Growth | 10 |
| Enterprise | Unlimited |

### Set Up Approval Workflow

For safety, all outgoing emails can require approval before sending.

1. Settings → **Approval Workflow** → toggle **On**
2. Optional: Specify who can approve:
   - Owner only
   - Owner + Admins
   - Anyone with Operator role
3. When toggled **On:**
   - Users draft campaigns
   - Campaign goes to "Pending Review" queue
   - Approver reviews and clicks "Approve" (or rejects with feedback)
   - Only then does campaign send

**Best practice:** Enable approval workflow for new teams (reduces accidental campaigns).

---

## First Campaign (Quick Start)

### Scenario: Send 10 test emails to your own inbox + a few colleagues

#### Step 1: Create Campaign

1. **Prospects** → **Create Campaign**
2. Enter **Campaign Name:** e.g., "Test Campaign - Q4 Outreach"
3. Add prospects:
   - **Option A (Manual):** Click **Add Row** → enter email, name
   - **Option B (Import CSV):** Click **Upload CSV** → select file with columns (email, firstName, lastName, company)
4. Click **Next**

#### Step 2: Compose Message

1. **Template:** Pick or create an email template
   - **Pre-built:** Browse default templates
   - **Custom:** Click **Create Custom**
     - **Subject:** e.g., "Quick question about {{company}}"
     - **Body:** e.g., "Hi {{firstName}}, I think {{company}} would benefit from... [your pitch]"
     - **Variables:** Use {{fieldName}} to personalize; pulls from prospect data
2. **Preview:** Click **Preview** to see how email looks personalized
3. Click **Next**

#### Step 3: Review & Send

1. **Approval workflow:** If enabled, campaign goes to review queue (approver must click "Approve")
2. If workflow disabled, click **Send Campaign**
3. **Confirmation:** You'll see "Campaign sent to X recipients"
4. Go to **Inbox Assistant** → watch for replies

#### Step 4: Respond to Replies

1. **Inbox Assistant** → **Inbox** tab
2. Click an email to open it
3. Click **Reply** to compose response
4. Type message (or click **AI Suggest** for AI-generated reply ideas)
5. Click **Send**
6. **Audit trail:** Every reply is logged with approval status + timestamp

---

## Configuration & Best Practices

### General Settings

**Settings → General:**

- **Workspace Name:** Update if needed (e.g., rebrand)
- **Sender Business Name:** Legal name for compliance footer (e.g., "Acme Agency Inc.")
- **Sender Postal Address:** Physical address for CAN-SPAM compliance
  - Required if sending bulk email in USA
  - Format: "123 Main St, San Francisco, CA 94102"
- **Save** and verify compliance footer appears on outgoing emails

### Email Configuration Best Practices

**1. Use a company email, not personal:**

```
✓ Good:  sales@acme-agency.com
✗ Bad:   john.smith@acme-agency.com (if John leaves, inbox is lost)
```

**2. If using team inbox (multiple people), separate personal + team accounts:**

```
Workspace setup:
  - team-inbox@acme.com   (shared, anyone can reply)
  - john@acme.com         (John's personal inbox; replies from John only)
  - jane@acme.com         (Jane's personal inbox; replies from Jane only)

Inbox Assistant shows each inbox separately; team collaborates on shared one.
```

**3. Configure email signatures:**

Most email providers auto-append signatures; make sure they include:
- Your name and title
- Company name and website
- Phone number
- Any compliance disclaimers (e.g., "This is a sales message")

### Compliance & Legal

**ACAOS automatically includes compliance footer on all outgoing emails:**

```
---
You're receiving this because you were identified as [reason].
To unsubscribe from future emails, click here: [unsubscribe link]

[Sender Business Name]
[Sender Postal Address]
```

**Configure these in Settings → General** (required before sending).

**Key compliance rules (USA — CAN-SPAM):**

1. ✓ Include unsubscribe link (ACAOS does this automatically)
2. ✓ Include business name + postal address (configure in Settings)
3. ✓ Honor unsubscribe requests (ACAOS auto-processes)
4. ✓ Don't use deceptive headers (use real from/subject)
5. ✓ Don't harvest email addresses (manually curated lists OK)

**GDPR (EU):**

1. ✓ Use consent-based lists (email recipients have opted in)
2. ✓ Provide unsubscribe (ACAOS does this)
3. ✓ Delete on request (contact support for GDPR data deletion)

**For questions:** Contact support@acaos.example.com with compliance questions.

### Sample Campaign Templates

**Template 1: Cold Outreach**

```
Subject: {{firstName}}, we've helped companies like {{company}} increase sales by 40%

Hi {{firstName}},

I've been researching {{company}} and noticed you're in [target industry].

We work with agencies to [your value prop]. In the last [timeframe], we've helped 
{{company}} and similar companies achieve [results].

Would you be open to a brief 15-minute call next week to see if there's a fit?

Best,
[Your Name]
[Your Title]
[Company]
```

**Template 2: Follow-Up**

```
Subject: Quick follow-up: {{company}} opportunity

Hi {{firstName}},

I know you're busy, so I'll keep this brief. I reached out last week about 
[your value prop] for {{company}}.

I found this case study that might be relevant: [link to case study about similar company]

If you're interested in exploring further, my calendar is open [dates/link].

If not, no worries—just reply and I'll take you off future emails.

Best,
[Your Name]
```

### Integration with External Tools

**API Key for third-party apps:**

1. Settings → **API Keys** → **Create New**
2. Give it a name: e.g., "Zapier Integration"
3. Copy the key (shown once; save securely)
4. Use the key to authenticate API requests (see `API_REFERENCE.md`)

**Examples:**

```
# Zapier: Send every new CSV file in Google Drive → ACAOS campaign
# Slack: New Slack command /sendcampaign → ACAOS API

# Setup:
Settings → API Keys → Create
Copy the secret
Paste into Zapier/Slack auth flow
```

---

## Support & Escalation

### Help Resources

1. **In-app Help:**
   - Click **?** icon in bottom-right corner
   - Browse FAQ, tutorials, video guides

2. **Email Support:**
   - Email: support@acaos.example.com
   - Response time: <2 hours (business hours)
   - Response time: <24 hours (off-hours)

3. **Status Page:**
   - Check service status: https://status.acaos.example.com
   - Historical incident reports

### Common Issues

#### Issue 1: "Connection Failed" for Email Account

**Symptom:** Settings → Email Accounts shows "Connection Failed"

**Solutions:**

1. **Check credentials:**
   - Verify email + password are correct
   - Try logging into your email provider's website directly (confirm access works)

2. **Check IMAP/SMTP enabled:**
   - Gmail: Check "Less secure app access" is enabled (or use App Password)
   - Outlook: Check app password is correct (not your regular password)
   - Custom: Verify IMAP port (usually 993) and SMTP port (usually 587)

3. **Test connection:**
   - Click "Test" button in ACAOS
   - See detailed error message (e.g., "Authentication failed")

4. **If still failing:**
   - Contact support with error message
   - We can help debug credential issues

#### Issue 2: "Emails Not Sending"

**Symptom:** Campaign created, clicked "Send," but no emails arrive at recipients

**Diagnosis:**

1. Check campaign status:
   - **Campaigns** → click campaign → check "Status" field
   - Status = "Sent" ✓ (emails should be in recipients' inboxes soon)
   - Status = "Pending Review" (waiting for approval; not sent yet)
   - Status = "Failed" (error occurred; see message for reason)

2. Check deliverability:
   - **Campaigns** → click campaign → **Analytics**
   - "Sent" shows successful sends
   - "Bounced" shows rejected by recipient email server (bad email, domain issues)
   - "Failed" shows SMTP errors (credentials wrong, rate limit hit)

3. Common causes:
   - **Email list has invalid addresses:** Validate email format before sending
   - **SMTP provider rate-limited:** Too many emails in short time; spread sends over longer window
   - **Sender reputation low:** New domain/IP; warm up gradually (start with 100 emails/day, ramp to 10k over 2 weeks)

#### Issue 3: "Can't See Replies in Inbox"

**Symptom:** I sent a campaign, but replies aren't showing in ACAOS Inbox

**Diagnosis:**

1. Check email sync:
   - **Inbox Assistant** → **Inbox** → look for emails (may take 30 sec to sync)
   - If nothing appears, check email account status in Settings

2. Check inbox in email provider directly:
   - Log into Gmail/Outlook
   - Do you see replies from recipients there?
   - If YES: Sync issue (contact support)
   - If NO: Replies may not have been sent (ask recipient to check their sent folder)

3. Check folder configuration:
   - ACAOS only syncs INBOX folder (not Sent, Trash, etc.)
   - Some email rules may auto-archive replies (check email provider's rules)

#### Issue 4: "Too many emails sent from this domain"

**Symptom:** Emails bouncing; error message says "Too many emails from this IP/domain"

**Cause:** Sender reputation is new; ISPs throttle new senders to prevent spam

**Solution: Email Warm-up**

```
Week 1: Send 100 emails/day (goal: establish sender history)
  - Spread sends across full day (don't send all at once)
  - Expect 5-10% bounce rate (normal for new domain)

Week 2: Send 500 emails/day
  - Gradually increase daily volume
  - Monitor bounce rate (should decrease)

Week 3: Send 2,000 emails/day
  - Continue increasing
  - Once bounce rate is <2%, can scale further

Week 4: Full capacity
  - Send 10,000+ emails/day
  - Sender reputation now established
```

**Best practices:**

1. Validate email list before sending (remove invalid addresses)
2. Use dedicated sending IP if available (ACAOS + email provider feature)
3. Create domain reputation by using consistent sender domain
4. Monitor bounce rates; contact email provider if issues persist

### Escalation Path

**For bugs or account issues:**

1. **Email support:** support@acaos.example.com
   - Describe issue + steps to reproduce
   - Attach screenshots if helpful
   - Include workspace ID (found in Settings → General)

2. **If urgent (cannot send emails):**
   - Email with subject line: "🚨 URGENT: ..."
   - We prioritize critical issues

3. **Product feedback:**
   - Feature requests → in-app feedback widget
   - Or email: feedback@acaos.example.com

---

## Success Metrics (First 30 Days)

**Track these to measure successful onboarding:**

| Metric | Target | How to Check |
|--------|--------|--------------|
| Email account configured | 1 account | Settings → Email Accounts |
| Team members invited | 2+ members | Settings → Team |
| First campaign sent | 1 campaign | Campaigns dashboard |
| Replies received | 10+ replies | Inbox Assistant → Inbox |
| Reply response rate | 10%+ | Campaigns → click campaign → Analytics |
| Approval workflow set up | Yes | Settings → Approval Workflow |
| Compliance footer verified | Yes | Send test email; check footer |

**If you hit these targets by day 30:** You're successfully onboarded!

**If stuck on any of these:** Reach out to support@acaos.example.com; we can help.

---

## Related Documentation

- [`docs/API_REFERENCE.md`](./API_REFERENCE.md) — Developer integration guide
- [`docs/TROUBLESHOOTING_GUIDE.md`](./TROUBLESHOOTING_GUIDE.md) — Detailed troubleshooting
- Main product docs: https://docs.acaos.example.com

