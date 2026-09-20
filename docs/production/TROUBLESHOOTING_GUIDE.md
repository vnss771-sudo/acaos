# ACAOS Troubleshooting Guide

**Objective:** Resolve common issues without opening a support ticket.

**Audience:** ACAOS users, customer success, support engineers

**Last Updated:** 2026-09-20

---

## Table of Contents

1. [Email Setup Issues](#email-setup-issues)
2. [Campaign Problems](#campaign-problems)
3. [Delivery & Bounce Issues](#delivery--bounce-issues)
4. [Performance Issues](#performance-issues)
5. [Access & Permissions](#access--permissions)
6. [Billing & Subscription](#billing--subscription)

---

## Email Setup Issues

### Issue: "Connection Failed" When Adding Email Account

**Symptom:**
```
Settings → Email Accounts → "Connection Failed"
Error: "Authentication failed for gmail.com"
```

**Diagnosis:**

```
Step 1: Verify credentials are correct
  1. Go to your email provider's website (gmail.com, outlook.com, etc)
  2. Log in with the email + password you entered in ACAOS
  3. Does login succeed?
     YES → Credentials are correct; proceed to Step 2
     NO → Password is wrong; correct and try again in ACAOS
```

**Solution (by email provider):**

**Gmail:**

```
1. Gmail requires app-specific passwords (not your regular password)

2. Create an app password:
   a. Go to myaccount.google.com/app-passwords
   b. Select "Mail" + "Windows Computer" (or your device)
   c. Google will generate a 16-character password
   d. Copy this password

3. In ACAOS:
   - Email: your-email@gmail.com
   - Password: [paste the 16-char app password from step 2c]
   - Click Test

4. If still failing:
   - Check "Less secure app access" is enabled:
     myaccount.google.com/lesssecureapps → turn ON
   - Try again in ACAOS
```

**Outlook / Office 365:**

```
1. If 2-factor auth (2FA) is enabled, use app password (not regular password)
   a. Go to account.microsoft.com/security
   b. Create app password
   c. Copy password

2. In ACAOS:
   - Email: your-email@outlook.com
   - Password: [app password from step 1c]
   - Click Test

3. If failing:
   - Verify IMAP is enabled in Outlook:
     Settings → Forwarding and POP/IMAP → IMAP enabled?
   - Try again
```

**Custom SMTP (SendGrid, Mailgun, etc):**

```
1. Get SMTP credentials from your email provider
   (Usually in Settings → SMTP or API Keys section)

2. In ACAOS:
   IMAP Server: imap.example.com (from provider)
   IMAP Port: 993
   IMAP User: your-email@example.com
   IMAP Password: [provided by provider]
   
   SMTP Server: smtp.example.com (from provider)
   SMTP Port: 587
   SMTP User: [provided by provider; often "apikey"]
   SMTP Password: [provided by provider]

3. Click Test

4. If still failing:
   - Double-check port numbers (IMAP 993, SMTP 587 are common)
   - Check if provider requires TLS (usually yes)
   - Contact your email provider's support
```

### Issue: Email Account Connected, But No Emails Appear in Inbox

**Symptom:**
```
Settings → Email Accounts → Status: "Connected" ✓
Inbox Assistant → Inbox → No emails visible
```

**Diagnosis:**

```
Step 1: Check if your email has new messages
  1. Log into your email provider directly (Gmail, Outlook, etc)
  2. Do you see recent emails?
     YES → Emails exist; check Step 2
     NO → Inbox is empty; send yourself a test email

Step 2: Check sync status
  1. In ACAOS: Settings → Email Accounts → click account
  2. Look for "Last synced: X minutes ago"
  3. If "Last synced: never", click Sync Now
  4. Wait 30 seconds
  5. Go back to Inbox Assistant → Inbox
  6. Do emails appear now?
     YES → Sync was just triggered; working now
     NO → Proceed to Step 3

Step 3: Check email folder configuration
  1. ACAOS only syncs INBOX folder
  2. In your email provider, do you see emails in INBOX folder?
     (Some providers auto-archive emails; check Inbox rules)
  3. If emails are being auto-archived:
     - Turn off auto-archive rule
     - Re-sync in ACAOS
```

**Solution:**

1. **Force re-sync:**
   - Settings → Email Accounts → click account
   - Click **Sync Now**
   - Wait 2-3 minutes for sync to complete

2. **Check folder configuration:**
   - IMAP INBOX is the only folder ACAOS syncs
   - If your emails are in custom folders (not INBOX), they won't appear
   - Solution: Move emails to INBOX or disable auto-archive

3. **If still not working:**
   - Try re-adding the email account:
     - Delete account (Settings → Email Accounts → Delete)
     - Add again with fresh credentials
     - Click Sync Now

---

## Campaign Problems

### Issue: "Campaign Won't Send" - Status Shows "Pending"

**Symptom:**
```
Campaigns → click campaign → Status: "Pending Review"
Button: "Approve Campaign" is visible
```

**Explanation:**

Your workspace has **approval workflow enabled**. Campaigns need approval before sending.

**Solution:**

1. **If you're the approver:**
   - Click **Approve Campaign** button
   - Campaign status changes to "Sent"
   - Emails are queued and will send within 5 minutes

2. **If you're not the approver:**
   - Ask your workspace Owner or Admin to approve
   - They go to: Campaigns → click campaign → **Approve Campaign**

3. **To disable approval workflow (optional):**
   - Settings → **Approval Workflow** → toggle OFF
   - Campaigns now send immediately (no approval needed)
   - Note: Less safe; consider keeping approval on for new teams

### Issue: "Campaign Shows 'Sent' But I Don't See Emails Being Sent"

**Symptom:**
```
Campaigns → click campaign → Status: "Sent" ✓
But no emails arrived at recipients' inboxes
```

**Diagnosis:**

```
Step 1: Check campaign send status
  1. Campaigns → click campaign
  2. Look for "Sent" count (e.g., "Sent: 50 emails")
  3. If "Sent: 0" → campaign failed to send; see Step 2
  4. If "Sent: 50" → emails were sent; checking recipient inboxes (Step 3)

Step 2: Why did campaign fail to send?
  1. Click campaign → **Analytics** tab
  2. Look at "Failed" count and reason
  3. Common reasons:
     - "SMTP connection failed" → email account disconnected; reconnect
     - "Authentication failed" → email password changed; update credentials
     - "Invalid email in list" → email addresses are malformed; verify CSV

Step 3: Campaign sent, but emails aren't arriving
  1. Check recipient email addresses (typos? invalid format?)
  2. Ask recipient to check:
     - Spam/Junk folder (emails may have been filtered)
     - Sender domain reputation (new senders often go to spam)
  3. Check "Bounced" count in campaign analytics:
     - High bounce rate (>10%) = email list quality issue
     - Solution: Validate emails before sending (use Email Validator tool)
```

**Solution:**

1. **If "Email account disconnected":**
   - Go to Settings → Email Accounts
   - Check status (should be "Connected")
   - If "Connection Failed," re-add account (follow Email Setup Issues)

2. **If "Invalid emails":**
   - Go to Campaigns → click campaign → **Review Prospects**
   - Look for malformed emails (missing @, spaces, etc)
   - Delete or correct invalid emails
   - Create new campaign with corrected list

3. **If emails are bouncing:**
   - Campaigns → click campaign → **Analytics** → "Bounced" section
   - Click "View bounced emails"
   - Look at bounce reasons (e.g., "mailbox does not exist", "domain rejected")
   - Remove invalid emails from future campaigns

---

## Delivery & Bounce Issues

### Issue: "High Bounce Rate" (>5%)

**Symptom:**
```
Campaign Analytics shows:
  Sent: 100
  Bounced: 10
  Bounce Rate: 10%
```

**Common Causes:**

1. **Bad email list** (most common)
   - Emails are invalid, outdated, or misspelled
   - Solution: Validate email list before sending

2. **Sender reputation issue**
   - New domain/IP hasn't built reputation yet
   - ISPs throttle or reject new senders
   - Solution: Email warmup (send small volumes initially)

3. **SMTP configuration**
   - Email account credentials wrong
   - Sending domain doesn't match email provider
   - Solution: Verify SMTP settings

**Solution:**

```
Step 1: Validate email list
  1. Campaigns → click campaign → **Analytics**
  2. Export "Bounced emails" list
  3. Review bounce reasons:
     - "Mailbox does not exist" → email is invalid (remove)
     - "Domain rejected" → domain reputation low (wait or use different sender)
     - "User unknown" → email doesn't exist (remove)

Step 2: Clean your prospect list
  1. Remove all bounced emails from future campaigns
  2. Use email validator tool before importing (remove invalid emails)

Step 3: Warm up sender reputation
  1. If bounce rate remains high:
     - Send small campaigns first (100 emails/day)
     - Monitor bounce rate; increase volume gradually
     - After 1 week of low bounces, can send larger campaigns

Step 4: Verify SMTP configuration
  1. Settings → Email Accounts → click account
  2. Click "Test" to verify connection
  3. If test fails, SMTP is misconfigured (see Email Setup Issues)
```

### Issue: "All Emails Bounced" - Campaign Completely Failed

**Symptom:**
```
Campaign Analytics shows:
  Sent: 100
  Bounced: 100
  Bounce Rate: 100%
  Bounce Reason: "SMTP authentication failed"
```

**Diagnosis:**

The email account SMTP credentials are wrong or expired.

**Solution:**

1. **Verify email account is connected:**
   - Settings → Email Accounts
   - Check status (should be "Connected")
   - If status is "Connection Failed," re-add account

2. **Re-authenticate email account:**
   - Settings → Email Accounts → click account
   - Click "Disconnect"
   - Click "Connect Again" (re-do OAuth or enter password)
   - Click "Test" to verify

3. **If still bouncing:**
   - Check if email account is working in Gmail/Outlook directly
   - If yes, try different SMTP port (587 vs 465)
   - Contact email provider support if issue persists

---

## Performance Issues

### Issue: "Dashboard is Slow" or "Pages Won't Load"

**Symptom:**
```
ACAOS dashboard takes >5 seconds to load
Or pages time out / show error
```

**Diagnosis:**

```
Step 1: Check your internet connection
  1. Run speed test: speedtest.net
  2. Is your internet slow?
     YES → Improve connection (use wired, different WiFi, etc)
     NO → Proceed to Step 2

Step 2: Check if ACAOS service is up
  1. Go to status.acaos.example.com
  2. Are all services showing green status?
     YES → Service is up; may be your connection (Step 1)
     NO → Service is degraded; wait for recovery + retry

Step 3: Clear browser cache
  1. Your browser may be caching old, slow pages
  2. Clear cache:
     - Chrome: Ctrl+Shift+Delete → select All time → Clear data
     - Safari: Develop → Empty Caches
     - Firefox: Ctrl+Shift+Delete → Everything → Clear Now
  3. Refresh ACAOS and try again
```

**Solution:**

1. **Improve internet connection:**
   - Use wired Ethernet (faster than WiFi)
   - Switch to different WiFi network (less congestion)
   - Close other bandwidth-heavy apps

2. **Wait for service recovery:**
   - If status page shows issues, wait 5-10 minutes
   - Refresh periodically to check status

3. **Use different browser:**
   - If slowness is persistent, try Chrome, Firefox, or Safari
   - Some browser extensions slow down page loads; disable if present

4. **Contact support if persistent:**
   - If pages are slow even after above, contact support@acaos.example.com
   - Include browser type, speed test result, and error message

---

## Access & Permissions

### Issue: "Access Denied" or "You Don't Have Permission"

**Symptom:**
```
Try to send campaign or edit settings
Error: "You don't have permission to perform this action"
```

**Diagnosis:**

Your user role doesn't have required permissions.

**Permissions by role:**

| Action | Owner | Admin | Operator | Viewer |
|--------|-------|-------|----------|--------|
| Send campaigns | ✓ | ✓ | ✓ | ✗ |
| Reply to emails | ✓ | ✓ | ✓ | ✗ |
| Edit team | ✓ | ✓ | ✗ | ✗ |
| Change billing | ✓ | ✗ | ✗ | ✗ |
| View analytics | ✓ | ✓ | ✓ | ✓ |
| View inbox | ✓ | ✓ | ✓ | ✓ |

**Solution:**

1. **Check your current role:**
   - Settings → **Team** → find your name
   - What is your role? (Owner, Admin, Operator, Viewer)

2. **If you need higher permissions:**
   - Ask the Workspace Owner to promote you
   - Settings → Team → click your name → Change Role

3. **If you forgot your password:**
   - Login page → "Forgot password"
   - Enter email; you'll get password reset link

---

## Billing & Subscription

### Issue: "Can't Upgrade Plan" - Stripe Payment Failed

**Symptom:**
```
Settings → Billing → try to upgrade plan
Error: "Payment failed. Please try a different card."
```

**Diagnosis:**

Stripe (payment processor) declined your card.

**Common reasons:**

1. Card is expired
2. Insufficient funds
3. Card blocked by bank (fraud detection)
4. Address mismatch

**Solution:**

1. **Try a different card:**
   - Settings → Billing → **Update Payment Method**
   - Enter a different card
   - Try upgrade again

2. **Contact your bank:**
   - If multiple cards are declined, contact your bank
   - Let them know ACAOS (Stripe) charges are legitimate
   - They may have blocked the charge as suspected fraud

3. **Use invoice billing (Enterprise):**
   - If card payment isn't working, switch to invoice billing
   - Settings → Billing → **Request Invoice**
   - ACAOS will email you an invoice; pay via bank transfer

### Issue: "Double Charged" or "Payment Went Through Twice"

**Symptom:**
```
Billing shows two charges for the same month
Or you received two invoices
```

**Diagnosis:**

Rare, but can happen if:
1. You clicked "Subscribe" twice
2. System processed payment twice (technical error)

**Solution:**

1. **Check Stripe directly:**
   - Settings → Billing → "View in Stripe" button
   - Look at charge history
   - Is there really a duplicate charge?

2. **Contact support:**
   - Email: support@acaos.example.com
   - Include screenshot of duplicate charges
   - We can refund the duplicate charge within 30 days

---

## General Troubleshooting Steps

### Self-Help Flowchart

```
                     ISSUE OCCURS
                          |
                          v
                  Is ACAOS down?
                    (status page)
              /                   \
            YES                    NO
             |                      |
             v                      v
      Wait for recovery    Clear browser cache
             |                      |
             v                      v
         Resolved?            Restart browser
      /         \              |
    YES         NO            v
                |          Try again
                |
         Report issue
         support@acaos
      .example.com
```

---

## When to Contact Support

**Contact support@acaos.example.com if:**

- ✓ Issue persists after following this guide
- ✓ Error message suggests a bug (e.g., "Internal Server Error")
- ✓ Service is down (status page shows red)
- ✓ Need to recover deleted/lost data
- ✓ Have a feature request or feedback

**Include in your support email:**

1. Exact error message
2. Steps to reproduce
3. Screenshot (if applicable)
4. Browser type + version
5. Workspace ID (Settings → General → Workspace ID)

**Support SLA:**

- **P1 (can't access service):** <2 hours
- **P2 (feature broken):** <4 hours
- **P3 (degraded/minor):** <24 hours

---

## Related Documentation

- [`docs/production/CUSTOMER_ONBOARDING.md`](./CUSTOMER_ONBOARDING.md) — Setup guide
- [`docs/production/API_REFERENCE.md`](./API_REFERENCE.md) — API documentation
- [`docs/production/OPERATIONAL_PROCEDURES.md`](./OPERATIONAL_PROCEDURES.md) — Platform operations

