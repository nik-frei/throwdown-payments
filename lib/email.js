// Transactional email via Resend. Silently skipped when RESEND_API_KEY is unset.
const { Resend } = require("resend");

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM = process.env.EMAIL_FROM || "Throwdown <hello@throwdown.me>";

async function send(to, subject, text) {
  if (!resend) {
    console.log(`[email skipped] to=${to} subject=${subject}`);
    return;
  }
  try {
    await resend.emails.send({ from: FROM, to, subject, text });
  } catch (err) {
    console.error("email failed:", err.message);
  }
}

const money = (c) => "$" + (c / 100).toLocaleString("en-US");

function pledgeConfirmed({ pledge, matchup, url }) {
  return send(
    pledge.email,
    `You backed ${matchup.a_name} vs. ${matchup.b_name}`,
    `Thanks, ${pledge.name}.

You pledged ${money(pledge.amount_cents)} toward ${matchup.a_name} vs. ${matchup.b_name}:
"${matchup.question}"

Your card is saved, not charged. It's only charged if the debate reaches its ${money(matchup.target_cents)} target by ${new Date(matchup.deadline).toLocaleDateString("en-US", { month: "long", day: "numeric" })} and both debaters accept. If it doesn't fund, nothing happens.

Share it to make it happen: ${url}

— Throwdown`
  );
}

function charged({ pledge, matchup, url }) {
  return send(
    pledge.email,
    `It's on: ${matchup.a_name} vs. ${matchup.b_name}`,
    `${pledge.name} — the debate you backed is happening.

Both debaters accepted, and your ${money(pledge.amount_cents)} pledge has now been charged.

We'll email you when it's scheduled and again when the recording is up. Follow along here: ${url}

— Throwdown`
  );
}

function recorded({ pledge, matchup, url }) {
  return send(
    pledge.email,
    `Watch: ${matchup.a_name} vs. ${matchup.b_name}`,
    `The debate you backed is recorded and live.

Watch it here: ${url}

Thanks for making it happen.

— Throwdown`
  );
}

module.exports = { send, pledgeConfirmed, charged, recorded };
