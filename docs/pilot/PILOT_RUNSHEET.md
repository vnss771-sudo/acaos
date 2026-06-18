# ACAOS pilot run-sheet — prove the signal→reply loop

**The one question this pilot answers:** *which signals actually drive replies?*
Nothing else. Not architecture, not scale, not automation. Run it once, by hand,
against one real source, and let the results tell you what to automate.

> Decision already made: **pilot first, then automate.** Do not build the
> autonomous harvester until this pilot names a winning signal source.

---

## The loop, end to end

```
 pick a source → feed 50–100 real signals → engine scores + recommends + drafts
   → you review/approve the best 10–20 → authenticate + send → read results
   → automate the source behind the top reply-rate signal type
```

Everything below the "feed" step is already built and wired. Your only manual
jobs are: **choose a source, gather signals, review drafts, read results.**

---

## Step 0 — One-time setup (do before anything else)

- [ ] **Authenticate the sending domain.** Follow `docs/pilot/DOMAIN_DNS_SETUP.md`
      end to end. SPF + DKIM + DMARC must PASS on a test email *before* you send,
      or your reply numbers measure spam filtering, not your message. **Blocker.**
- [ ] Confirm `OPENAI_API_KEY` is set on the API service (drafting needs it — the
      draft endpoint returns 503 without it).
- [ ] Have your `WORKSPACE_ID` and a logged-in `AUTH_TOKEN` handy (see
      `scripts/pilot-import.mjs` header for where to find them).

## Step 1 — Pick ONE source

Choose a single, real, repeatable source you can read by hand for a week. Good
Brisbane-trade options:

- **Seek / Indeed job ads** (HIRING) — a contractor hiring installers is growing.
- **Local news / council announcements** (EXPANSION, NEWS_MENTION).
- **ABN/business registrations** (BUSINESS_REGISTRATION).

Pick the one *you* can most reliably scan. The pilot's job is to find out if it's
worth automating — so it must be something automatable later.

## Step 2 — Gather 50–100 real signals

- [ ] Copy `docs/pilot/signals-template.csv` and fill one row per real signal.
- [ ] **Evidence is mandatory** per row: `provider`, `sourceType`, and a real
      `sourceUrl`. No unsourced rows — that discipline *is* the moat.
- [ ] Valid `signalType` values: `HIRING`, `FUNDING`, `EXPANSION`,
      `TECH_ADOPTION`, `LEADERSHIP_CHANGE`, `NEWS_MENTION`, `PROCUREMENT`,
      `BUSINESS_REGISTRATION`, `WEBSITE_CHANGE`.
- [ ] Include `contactEmail` where you can find it — needed later to send.

## Step 3 — Feed them in

```bash
API_URL=https://<your-api>.up.railway.app \
AUTH_TOKEN=<jwt> WORKSPACE_ID=ws_xxx \
node scripts/pilot-import.mjs path/to/your-signals.csv
```

The engine then, automatically: scores each prospect → for those ≥70 generates a
recommendation → creates an OutreachIntent with an evidence snapshot.

## Step 4 — Review + approve the best 10–20

- [ ] Open the dashboard → **"This week's outreach"** card.
- [ ] For each strong opportunity: **Generate draft → read it → Approve →
      Prepare to send.** You are the quality gate; reject anything weak.
- [ ] Approve only the best 10–20 for this first run. Small, deliberate batch.

## Step 5 — Send (safely)

- [ ] **Simulate first if unsure:** send the batch to a couple of your *own*
      inboxes before real prospects, to confirm formatting + deliverability.
- [ ] Then launch the campaign to dispatch the approved drafts to real contacts.
- [ ] Sends are capped + approval-gated by design — you won't blast anyone.

## Step 6 — Read the results (after ~3–7 days)

```bash
DATABASE_URL=postgres://... WORKSPACE_ID=ws_xxx node scripts/pilot-results.mjs
```

Reads out: overall reply rate, **reply rate per signal type** (the key number),
reply intents, and progress toward the `MIN_OUTCOMES=10` the learning loop needs.

## Step 7 — Decide what to automate

- The signal type with the **highest reply rate** points at the source worth
  automating. That — and only that — is what the harvester should target next.
- If no type clears a useful bar, the source was wrong: pick a different one and
  re-run Steps 1–6. Cheaper to learn this now than to automate a dud.

---

### Success criteria for the pilot

You're done when you can finish this sentence with data, not a guess:

> "**\_\_\_\_** signals drove **\_\_%** replies — automate **\_\_\_\_** next."
