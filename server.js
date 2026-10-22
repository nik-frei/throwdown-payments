// Throwdown — crowdfunding for debates.
// One Express app: public pages, Stripe pledge flow, share cards, and a small admin.

// Load .env for local runs (Render injects env vars itself).
try { require("fs").readFileSync(require("path").join(__dirname, ".env"), "utf8").split("\n").forEach((l) => { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; }); } catch (_) {}

const path = require("path");
const express = require("express");
const db = require("./lib/db");
const pay = require("./lib/payments");
const email = require("./lib/email");
const card = require("./lib/card");

const app = express();
app.set("trust proxy", 1);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

const PORT = process.env.PORT || 3000;
const SITE_NAME = "Throwdown";
const MIN_PLEDGE = 10 * 100;                                   // $10
const MIN_TARGET = (Number(process.env.MIN_TARGET_DOLLARS) || 5000) * 100;
const MAX_TARGET = 1_000_000 * 100;
const DEADLINE_DAYS = Number(process.env.DEADLINE_DAYS) || 75;
const SPLIT = { debater: 40, proposer: 10, platform: 10 };    // percent of the pot, each debater gets `debater`

// ---------- helpers available in every view ----------
const money = (c, { cents = false } = {}) =>
  "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
const pct = (m) => Math.min(100, Math.round((m.pledged_cents / m.target_cents) * 100));
const daysLeft = (m) => Math.max(0, Math.ceil((new Date(m.deadline) - Date.now()) / 86_400_000));
const STATUS = {
  open:      { label: "Open",       blurb: "Taking pledges" },
  funded:    { label: "Funded",     blurb: "Target hit — inviting the debaters" },
  accepted:  { label: "It's on",    blurb: "Both debaters accepted — cards charged" },
  scheduled: { label: "Scheduled",  blurb: "Date set" },
  recorded:  { label: "Recorded",   blurb: "Watch it" },
  expired:   { label: "Expired",    blurb: "Didn't fund in time — no one was charged" },
  cancelled: { label: "Cancelled",  blurb: "No one was charged" },
};
const isFunded = (m) => ["funded", "accepted", "scheduled", "recorded"].includes(m.status);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

app.locals = { ...app.locals, money, pct, daysLeft, STATUS, isFunded, SITE_NAME, SPLIT, MIN_PLEDGE, MIN_TARGET, DEADLINE_DAYS, DEMO: pay.DEMO, esc };

// ---------- middleware ----------
// Stripe webhook needs the raw body, so it's registered before the body parser.
app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = pay.verifyWebhook(req.body, req.get("stripe-signature"));
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }
  if (event.type === "checkout.session.completed") {
    try { await finalizeSession(event.data.object.id, req); }
    catch (err) { console.error("webhook finalize failed:", err); }
  }
  res.json({ received: true });
});

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1d" }));
app.use((req, res, next) => { res.locals.baseUrl = pay.baseUrl(req); res.locals.path = req.path; next(); });

// ---------- public pages ----------
app.get("/", async (req, res) => {
  await db.expireStale();
  const [open, done, s] = await Promise.all([
    db.listMatchups({ statuses: ["open", "funded", "accepted", "scheduled"] }),
    db.listMatchups({ statuses: ["recorded"], limit: 6 }),
    db.stats(),
  ]);
  res.render("home", { open, done, stats: s, title: null });
});

app.get("/how", (req, res) => res.render("how", { title: "How it works" }));
app.get("/terms", (req, res) => res.render("terms", { title: "Terms" }));

app.get("/new", (req, res) => res.render("new", { title: "Propose a debate", values: {}, error: null }));

app.post("/new", async (req, res) => {
  const v = clean(req.body);
  const error = validateMatchup(v) || validatePledge(v);
  if (error) return res.status(400).render("new", { title: "Propose a debate", values: v, error });
  if (v.website) return res.redirect("/"); // honeypot

  const pending = {
    kind: "new", question: v.question, a_name: v.a_name, a_handle: v.a_handle, b_name: v.b_name, b_handle: v.b_handle,
    target_cents: v.target_cents, name: v.name, email: v.email, amount_cents: v.amount_cents, return_to: "/new",
  };
  if (pay.DEMO) {
    const { slug } = await createFromPending(pending, null, req);
    return res.redirect(`/m/${slug}?thanks=1`);
  }
  const session = await pay.startPledge(req, { email: v.email, name: v.name, amountCents: v.amount_cents, pending });
  res.redirect(303, session.url);
});

app.get("/m/:slug", async (req, res) => {
  await db.expireStale();
  const m = await db.getMatchup(req.params.slug);
  if (!m) return res.status(404).render("error", { title: "Not found", message: "That matchup doesn't exist." });
  const pledges = await db.pledgesFor(m.id);
  res.render("matchup", {
    m, pledges, title: `${m.a_name} vs. ${m.b_name}`,
    thanks: req.query.thanks === "1", error: null, values: {},
    ogImage: `${res.locals.baseUrl}/m/${m.slug}/card.png?v=${m.pledged_cents}`,
  });
});

app.post("/m/:slug/pledge", async (req, res) => {
  const m = await db.getMatchup(req.params.slug);
  if (!m) return res.status(404).render("error", { title: "Not found", message: "That matchup doesn't exist." });
  if (m.status !== "open") return res.redirect(`/m/${m.slug}`);
  const v = clean(req.body);
  const error = validatePledge(v);
  if (error) {
    const pledges = await db.pledgesFor(m.id);
    return res.status(400).render("matchup", { m, pledges, title: `${m.a_name} vs. ${m.b_name}`, thanks: false, error, values: v, ogImage: `${res.locals.baseUrl}/m/${m.slug}/card.png` });
  }
  if (v.website) return res.redirect(`/m/${m.slug}`);

  const pending = { kind: "pledge", matchup_id: m.id, name: v.name, email: v.email, amount_cents: v.amount_cents, return_to: `/m/${m.slug}` };
  if (pay.DEMO) {
    await createFromPending(pending, null, req);
    return res.redirect(`/m/${m.slug}?thanks=1`);
  }
  const session = await pay.startPledge(req, { email: v.email, name: v.name, amountCents: v.amount_cents, pending });
  res.redirect(303, session.url);
});

// Return from Stripe Checkout. The webhook may already have finalized this
// session; finalizeSession is idempotent on session id.
app.get("/pledge/done", async (req, res) => {
  const sid = req.query.session_id;
  if (!sid) return res.redirect("/");
  try {
    const { slug } = await finalizeSession(sid, req);
    res.redirect(`/m/${slug}?thanks=1`);
  } catch (err) {
    console.error(err);
    res.status(500).render("error", { title: "Something went wrong", message: "Your card was saved but we couldn't record the pledge. Email us and we'll sort it out." });
  }
});

app.get("/m/:slug/card.png", async (req, res) => {
  const m = await db.getMatchup(req.params.slug);
  if (!m) return res.sendStatus(404);
  try {
    const png = await card.render(m);
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=300");
    res.send(Buffer.from(png));
  } catch (err) {
    console.error("card render failed:", err);
    res.sendStatus(500);
  }
});

// ---------- admin ----------
function adminAuth(req, res, next) {
  const want = process.env.ADMIN_PASSWORD;
  if (!want) return res.status(503).send("Set ADMIN_PASSWORD to enable the admin page.");
  const header = req.get("authorization") || "";
  const [, b64] = header.split(" ");
  const given = b64 ? Buffer.from(b64, "base64").toString().split(":").slice(1).join(":") : "";
  if (given === want) return next();
  res.set("WWW-Authenticate", 'Basic realm="Throwdown admin"');
  res.status(401).send("Sign in required.");
}

app.get("/admin", adminAuth, async (req, res) => {
  const all = await db.listMatchups({ limit: 500 });
  const pledgesByMatchup = {};
  for (const m of all) pledgesByMatchup[m.id] = await db.pledgesFor(m.id);
  res.render("admin", { all, pledgesByMatchup, title: "Admin", msg: req.query.msg || null });
});

app.post("/admin/matchup/:id", adminAuth, async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body;
  const fields = {};
  if (b.status && STATUS[b.status]) fields.status = b.status;
  fields.a_accepted = b.a_accepted === "on";
  fields.b_accepted = b.b_accepted === "on";
  fields.featured = b.featured === "on";
  fields.video_url = (b.video_url || "").trim() || null;
  fields.note = (b.note || "").trim() || null;
  if (b.deadline) fields.deadline = new Date(b.deadline);
  if (b.target_dollars) fields.target_cents = Math.round(Number(b.target_dollars) * 100);
  await db.updateMatchup(id, fields);

  // If it was just marked recorded, tell the backers.
  if (fields.status === "recorded") {
    const m = await db.getMatchupById(id);
    const url = `${res.locals.baseUrl}/m/${m.slug}`;
    for (const p of await db.pledgesFor(id)) if (p.status === "charged") email.recorded({ pledge: p, matchup: m, url });
  }
  res.redirect(`/admin?msg=${encodeURIComponent("Saved.")}#m${id}`);
});

// Charge every saved card for a matchup. Run once both debaters have accepted.
app.post("/admin/matchup/:id/charge", adminAuth, async (req, res) => {
  const id = Number(req.params.id);
  const m = await db.getMatchupById(id);
  if (!m) return res.sendStatus(404);
  const url = `${res.locals.baseUrl}/m/${m.slug}`;
  let ok = 0, failed = 0;
  for (const p of await db.pledgesFor(id)) {
    if (p.status !== "pledged") continue;
    const r = await pay.chargePledge(p, `Throwdown: ${m.a_name} vs. ${m.b_name}`);
    if (r.ok) {
      ok++;
      await db.updatePledge(p.id, { status: "charged", stripe_pi_id: r.piId });
      email.charged({ pledge: p, matchup: m, url });
    } else {
      failed++;
      await db.updatePledge(p.id, { status: "failed", stripe_pi_id: r.piId });
      console.error(`charge failed for pledge ${p.id}: ${r.error}`);
    }
  }
  if (["open", "funded"].includes(m.status)) await db.updateMatchup(id, { status: "accepted", a_accepted: true, b_accepted: true });
  res.redirect(`/admin?msg=${encodeURIComponent(`Charged ${ok} pledge${ok === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}.`)}#m${id}`);
});

// ---------- internals ----------
function clean(body) {
  const t = (k) => String(body[k] ?? "").trim();
  return {
    question: t("question").slice(0, 160),
    a_name: t("a_name").slice(0, 60), a_handle: t("a_handle").replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 30),
    b_name: t("b_name").slice(0, 60), b_handle: t("b_handle").replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 30),
    target_cents: Math.round(Number(t("target").replace(/[^0-9.]/g, "")) * 100) || 0,
    name: t("name").slice(0, 60), email: t("email").toLowerCase().slice(0, 120),
    amount_cents: Math.round(Number(t("amount").replace(/[^0-9.]/g, "")) * 100) || 0,
    website: t("website"),
  };
}

function validateMatchup(v) {
  if (!v.a_name || !v.b_name) return "Name both debaters.";
  if (v.a_name.toLowerCase() === v.b_name.toLowerCase()) return "Pick two different people.";
  if (v.question.length < 10) return "Write the question they'd debate (one line).";
  if (v.target_cents < MIN_TARGET) return `The target has to be at least ${money(MIN_TARGET)}.`;
  if (v.target_cents > MAX_TARGET) return `The target can't be more than ${money(MAX_TARGET)}.`;
  return null;
}

function validatePledge(v) {
  if (!v.name) return "Add your name — it shows up on the backer list.";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) return "That email doesn't look right.";
  if (v.amount_cents < MIN_PLEDGE) return `Pledges start at ${money(MIN_PLEDGE)}.`;
  if (v.amount_cents > 100_000 * 100) return "That's a lot. Email us for pledges over $100,000.";
  return null;
}

async function uniqueSlug(a, b) {
  const base = `${a}-vs-${b}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  let slug = base, i = 2;
  while (await db.slugExists(slug)) slug = `${base}-${i++}`;
  return slug;
}

// Turn Checkout metadata (or a demo-mode pending object) into real rows.
async function createFromPending(pending, stripeInfo, req) {
  let matchup;
  if (pending.kind === "new") {
    matchup = await db.createMatchup({
      slug: await uniqueSlug(pending.a_name, pending.b_name),
      question: pending.question, a_name: pending.a_name, a_handle: pending.a_handle || null,
      b_name: pending.b_name, b_handle: pending.b_handle || null,
      target_cents: Number(pending.target_cents), proposer_name: pending.name, proposer_email: pending.email,
      deadline: new Date(Date.now() + DEADLINE_DAYS * 86_400_000),
    });
  } else {
    matchup = await db.getMatchupById(Number(pending.matchup_id));
    if (!matchup) throw new Error("matchup missing");
  }
  const pledge = await db.createPledge({
    matchup_id: matchup.id, name: pending.name, email: pending.email, amount_cents: Number(pending.amount_cents),
    is_proposer: pending.kind === "new", ...(stripeInfo || {}),
  });
  if (pledge) {
    const full = await db.getMatchup(matchup.slug);
    email.pledgeConfirmed({ pledge, matchup: full, url: `${pay.baseUrl(req)}/m/${full.slug}` });
    // Auto-flip to funded the moment the target is crossed.
    if (full.status === "open" && full.pledged_cents >= full.target_cents) await db.updateMatchup(full.id, { status: "funded" });
  }
  return { slug: matchup.slug };
}

async function finalizeSession(sessionId, req) {
  const existing = await db.pledgeBySession(sessionId);
  if (existing) return { slug: (await db.getMatchupById(existing.matchup_id)).slug };
  const session = await pay.retrieveSession(sessionId);
  if (session.status !== "complete") throw new Error(`session ${sessionId} not complete`);
  const si = session.setup_intent;
  const stripeInfo = {
    stripe_session_id: session.id,
    stripe_customer_id: typeof session.customer === "string" ? session.customer : session.customer?.id,
    stripe_pm_id: typeof si?.payment_method === "string" ? si.payment_method : si?.payment_method?.id,
  };
  const pending = { ...session.metadata };
  // Checkout may create the customer without attaching our email; keep ours.
  pending.email = pending.email || session.customer_details?.email;
  return createFromPending(pending, stripeInfo, req);
}

app.use((req, res) => res.status(404).render("error", { title: "Not found", message: "Nothing here." }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render("error", { title: "Something went wrong", message: "Try again in a moment." });
});

db.init().then(() => {
  app.listen(PORT, () => console.log(`Throwdown on :${PORT}${pay.DEMO ? " (demo mode — no Stripe key, pledges are recorded without a card)" : ""}`));
}).catch((err) => { console.error("DB init failed:", err); process.exit(1); });
