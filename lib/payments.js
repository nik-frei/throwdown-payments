// Stripe: pledges save a card (Checkout in "setup" mode); nothing is charged
// until a matchup is funded and both debaters accept. Then charge() bills every
// saved card off-session in one pass.
//
// With no STRIPE_SECRET_KEY set, the app runs in DEMO mode: pledges are
// recorded straight into the database with no card, so you can click through
// the whole flow locally.

const Stripe = require("stripe");

const key = process.env.STRIPE_SECRET_KEY;
const stripe = key ? new Stripe(key) : null;
const DEMO = !stripe;

function baseUrl(req) {
  return process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
}

// Start a pledge. `pending` carries everything we need to create the pledge
// (and, for a new proposal, the matchup) once the card is saved.
async function startPledge(req, { email, name, amountCents, pending }) {
  // A Customer up front so the saved card attaches to it automatically.
  const existing = await stripe.customers.list({ email, limit: 1 });
  const customer = existing.data[0] || (await stripe.customers.create({ email, name }));

  const session = await stripe.checkout.sessions.create({
    mode: "setup",
    customer: customer.id,
    currency: "usd",
    metadata: Object.fromEntries(
      Object.entries(pending).map(([k, v]) => [k, String(v ?? "").slice(0, 490)])
    ),
    custom_text: {
      submit: { message: `You're pledging $${(amountCents / 100).toLocaleString()}. Your card is saved, not charged, until this debate is funded and both debaters accept.` },
    },
    success_url: `${baseUrl(req)}/pledge/done?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl(req)}${pending.return_to || "/"}`,
  });
  return session;
}

async function retrieveSession(id) {
  return stripe.checkout.sessions.retrieve(id, { expand: ["setup_intent"] });
}

// Charge one pledge. Returns { ok, piId, error }.
async function chargePledge(pledge, description) {
  if (DEMO) return { ok: true, piId: `demo_pi_${pledge.id}` };
  try {
    const pi = await stripe.paymentIntents.create({
      amount: pledge.amount_cents,
      currency: "usd",
      customer: pledge.stripe_customer_id,
      payment_method: pledge.stripe_pm_id,
      off_session: true,
      confirm: true,
      description,
      metadata: { pledge_id: String(pledge.id), matchup_id: String(pledge.matchup_id) },
    });
    return { ok: pi.status === "succeeded", piId: pi.id, error: pi.status !== "succeeded" ? pi.status : null };
  } catch (err) {
    return { ok: false, piId: err?.payment_intent?.id || null, error: err.message };
  }
}

function verifyWebhook(rawBody, signature) {
  return stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

module.exports = { stripe, DEMO, startPledge, retrieveSession, chargePledge, verifyWebhook, baseUrl };
