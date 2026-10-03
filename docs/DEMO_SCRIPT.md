# Demo script — "Sparky & Co Electrical"

A 10-minute demo for a trade business owner. It walks one job around the whole
loop, then shows what the loop teaches. Positioning and wording: `POSITIONING.md`.

**The story:** Jordan runs a 12-person electrical contractor in Brisbane. Work
comes from builders they already know and the odd tender. They don't know which
jobs actually make money until the accountant tells them, months later.

## Setup (once)

1. Run the stack locally (`BUILD.md`): Postgres, Redis, `npm run start:dev -w @acaos/api`,
   `npm run dev -w @acaos/web`. Use a throwaway database.
2. Create the owner, then seed (the script prints `ok`):
   ```bash
   curl -X POST localhost:4000/api/auth/signup -H 'Content-Type: application/json' \
     -d '{"email":"owner@sparkyco.example","password":"Sup3rStrongPass!","name":"Jordan Reid"}'
   NODE_OPTIONS=--conditions=acaos-src npx tsx scripts/demo/seed-contractor.mts
   ```
3. Sign in at http://localhost:5173 as `owner@sparkyco.example` / `Sup3rStrongPass!`.

The seed gives Sparky & Co three new jobs found, one being quoted, one in progress,
three closed out (so the margin report has enough to show), crew with rates (one
without — on purpose), and client signals for four builders.

## The walk-through

### 1. Today — "what needs me" (1 min)
Lands on **Today**. Point at the four numbers: open pipeline, won through ACAOS,
quote-to-win, delivered margin **with how many jobs it's based on**.
> "This is your morning. Not a dashboard of charts — the decisions."

Open **Why? Show evidence** on Northside Builders: three sources, dated, linked.
> "Every recommendation shows its working. If it can't, it says so."

### 2. Find work (2 min)
**Work → Find work.** The childcare fit-out in Nundah, lodged yesterday, 7 km away,
with the builder's phone number.
> "Your competitors find this when it goes to tender. You found it the day the
> DA was lodged."

Click **Pursue**. The card offers **Record quote**.

### 3. Contact and quote (1 min)
Click the builder's number (it's a real `tel:` link on a phone). Then **Record quote**:
$41,500, 230 hours. **Save quote**.
> "That's the only admin — and you did it while you were on the phone."

### 4. Win and start the job (1 min)
Open the **Pursuing** tab — Eagle Farm cold store, quoted $86,500. Click
**Client accepted**. The card follows you to **Won**; click **Start the job**.
> "Quote to job in one click. The site's created, your crew can log hours against it."

### 5. Crew and shifts (1 min)
**Crew → Shifts**: hours logged against the job's site. **Crew → Crew**: Ava has
no rate yet.
> "Your crew clock on and off. Nobody re-types hours into a costing sheet."

### 6. Close out (1 min)
**Work → Jobs & margins.** The gym fit-out: 66% of estimated hours used, and it
says plainly that margin is **unknown** because Ava has no rate — with a
**Set crew rates** button.
> "We never show you a made-up number. Unknown is unknown."

On a finished job: **Job done — close out** → invoice, materials, on-costs.

### 7. Margin — the point of it all (2 min)
Top of **Jobs & margins**: *What your work actually earns*. Three closed jobs from
development applications: median gross margin 28.9%, range 19.5–34.4%, n=3.
> "After a few months this tells you whether tenders or DAs or builder
> relationships actually pay — by where the work came from. That's what tells
> you what to chase next. Nobody else connects those two."

## Questions you'll get

- **"What does it cost?"** Contractor plan, $149/month; one job covers the year.
  First 5 customers: free for 3 months for closing out every job.
- **"Does it send emails for me?"** Only if you set up Outreach, and never without
  your approval.
- **"Where does the work come from?"** AusTender contract awards and council
  development applications (PlanningAlerts), matched to your trades and area.
- **"I already use simPRO / Fergus."** Keep it for invoicing. ACAOS finds the work
  and tells you which work made money; job costing is the means, not the product.

## Don't

- Don't open Outreach, Missions or Analytics in a contractor demo.
- Don't quote margin numbers without saying how many jobs they come from.
