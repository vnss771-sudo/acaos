# Sending-domain + DNS run-sheet

**Goal:** stop sending from `onboarding@resend.dev` (a shared test sender that lands
in spam) and start sending from your own authenticated domain so the pilot's emails
actually reach inboxes. ~20 minutes of work + up to a few hours of DNS propagation.

> Why this is blocker #1: an unauthenticated sender gets filtered before a human ever
> sees it. You can run the whole loop technically "successfully" and get zero replies
> purely because nothing was delivered. Authenticate first, *then* measure.

---

## 1. Pick the sending domain

Use a subdomain, not your root domain — keeps marketing/cold mail reputation
separate from your real business mail.

- Recommended: `send.yourdomain.com.au` (or `mail.` / `outreach.`)
- You keep replying from your normal address; only the *sending* identity changes.

## 2. Add + verify the domain in Resend

1. Resend dashboard → **Domains** → **Add Domain** → enter `send.yourdomain.com.au`.
2. Resend shows you a set of DNS records. You'll add these at your DNS host
   (Cloudflare / GoDaddy / Namecheap / wherever the domain's nameservers live).

You will get **three kinds** of records:

| Type  | Purpose | Notes |
|-------|---------|-------|
| **TXT (SPF)**   | Authorises Resend's servers to send for you | Host like `send`; value `v=spf1 include:resend.com ~all` (copy Resend's exact value) |
| **TXT/CNAME (DKIM)** | Cryptographically signs each message | Resend gives you the exact host + value; paste verbatim |
| **MX** (for the send subdomain) | Lets Resend handle bounces for the subdomain | Only on the `send.` subdomain — does **not** touch your main mail |

3. Add a **DMARC** record (do this yourself; it's the policy that ties SPF+DKIM
   together and is what Gmail/Outlook increasingly require for bulk senders):

   - Host: `_dmarc.send.yourdomain.com.au`
   - Type: `TXT`
   - Value (start in monitor mode): `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com.au`
   - After the pilot, once you confirm everything passes, you can tighten `p=none`
     → `p=quarantine`.

4. Back in Resend, click **Verify**. SPF/DKIM usually verify within minutes;
   give it up to a few hours. All three should go green before you send.

## 3. Flip the Railway env vars

In the **API** and **worker** services on Railway → Variables:

| Variable | Set to | Notes |
|----------|--------|-------|
| `SMTP_FROM` | `outreach@send.yourdomain.com.au` | Must be on the verified domain |
| `RESEND_API_KEY` | (your key) | Confirm it's present on both services |
| `WEB_URL` | `https://<your-web>.up.railway.app` | **Fix the `-production` typo** if still there |
| `API_URL` | `https://<your-api>.up.railway.app` | **Fix the `-production` typo** if still there |

Redeploy after changing variables.

> Separately (not strictly a sending blocker, but flagged): set the Railway **start
> command** to `node scripts/start-with-migrations.mjs` so migrations apply on deploy.

## 4. Smoke-test deliverability before the pilot

1. Send **one** real email to a Gmail address you own (use the campaign send path,
   or a one-off draft → approve → materialize → send).
2. In Gmail: open the message → **⋮ → Show original**. Confirm:
   - **SPF: PASS**
   - **DKIM: PASS**
   - **DMARC: PASS**
3. Send one to `check-auth@verifier.port25.com` (free) — it replies with a full
   auth report. Or use mail-tester.com for a 0–10 spam score (aim for 9+).

Only once all three say PASS are you cleared to run the pilot send. If anything
fails, fix DNS before feeding signals — otherwise your reply-rate numbers measure
your spam folder, not your message.
