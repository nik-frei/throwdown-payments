# Throwdown

Crowdfunding for debates. Propose a matchup, back it with real money, and when the number gets big enough and both debaters say yes, it happens. Nobody is charged until then.

One Node app, one Postgres database, Stripe for cards. That's the whole stack.

## How the money works

- A pledge saves a card through Stripe Checkout (setup mode). **Nothing is charged.**
- When a matchup's pledges cross its target, it flips to **Funded** automatically. You contact the debaters.
- Once both accept, you press **Charge all pledges** in the admin. Every saved card is charged off-session for exactly what was pledged, and backers get an email.
- If it doesn't fund within the deadline (default 75 days), it expires on its own and no one is ever charged.
- Payouts to the debaters and proposer are manual for now (Stripe Dashboard → transfer, or a check). Split is 40 / 40 / 10 / 10 — see `SPLIT` in `server.js`.

## Pages

| URL | What |
| --- | --- |
| `/` | Live matchups, sorted by money pledged |
| `/new` | Propose a matchup (requires a pledge) |
| `/m/:slug` | The matchup page — the thing people share |
| `/m/:slug/card.png` | Auto-generated share image (used as the X/OG card) |
| `/how` | How it works |
| `/terms` | Terms — pledge authorization, the split, failed-payment disclaimer |
| `/admin` | You only. Change status, mark debaters accepted, charge cards, add the video. |

Headshots are pulled from X profile pictures via the handle (through unavatar.io). No uploads.

## Run it locally

```
npm install
cp .env.example .env     # fill in DATABASE_URL at minimum
npm start
```

With no `STRIPE_SECRET_KEY` the app runs in **demo mode**: pledges are recorded without a card so you can click through everything. The admin "charge" button just marks pledges as charged.

## Deploy on Render

1. Push this folder to a GitHub repo.
2. In Render: **New → Blueprint**, pick the repo. `render.yaml` creates the web service and a Postgres database and wires `DATABASE_URL`.
3. Set these environment variables on the web service:

| Variable | Value |
| --- | --- |
| `ADMIN_PASSWORD` | anything — it's the password for `/admin` (username can be blank) |
| `BASE_URL` | `https://throwdown.me` (or the Render URL until the domain's pointed) |
| `STRIPE_SECRET_KEY` | from Stripe → Developers → API keys. Use the **test** key first. |
| `STRIPE_WEBHOOK_SECRET` | see step 4 |
| `RESEND_API_KEY` | from resend.com, after verifying your sending domain |
| `EMAIL_FROM` | `Throwdown <hello@throwdown.me>` |

4. In Stripe → Developers → Webhooks, add an endpoint `https://YOUR-DOMAIN/webhooks/stripe` listening for `checkout.session.completed`. Copy its signing secret into `STRIPE_WEBHOOK_SECRET`. (The app also records the pledge when the backer lands back on the site, so the webhook is a backstop, not a requirement — but set it up.)
5. Point `throwdown.me` at the service in Render → Settings → Custom Domains.

Optional knobs: `MIN_TARGET_DOLLARS` (default 5000), `DEADLINE_DAYS` (default 75).

## Running a debate, start to finish

1. A matchup funds → status shows **Funded**, pledges close.
2. Email the two debaters. In `/admin`, tick each one's **accepted** box as they say yes.
3. Both accepted → press **Charge all pledges**. Status becomes **It's on**, backers are emailed.
4. Set a date → change status to **Scheduled**.
5. Afterward, paste the YouTube link into **Video URL**, set status to **Recorded**. Backers get a "watch it" email and the video embeds on the matchup page.
6. Pay the debaters and the proposer from your Stripe balance.

If a debater declines, set the status to **Cancelled**. Nothing was charged, so there's nothing to refund.

## Files

```
server.js          routes, validation, admin
lib/db.js          Postgres schema + queries (schema is created on boot)
lib/payments.js    Stripe setup-mode checkout and off-session charging
lib/email.js       Resend emails (skipped if no key)
lib/card.js        share-card PNG renderer
views/             EJS templates
public/style.css   all the styling
fonts/             Inter, for the share card
```
