// Postgres access. One pool, one schema, created on boot if missing.
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && /render\.com|amazonaws|sslmode=require/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : undefined,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS matchups (
  id            SERIAL PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,
  question      TEXT NOT NULL,
  a_name        TEXT NOT NULL,
  a_handle      TEXT,
  b_name        TEXT NOT NULL,
  b_handle      TEXT,
  target_cents  INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',
  -- open → funded → accepted → scheduled → recorded ; or expired / cancelled
  proposer_name  TEXT,
  proposer_email TEXT,
  deadline      TIMESTAMPTZ NOT NULL,
  video_url     TEXT,
  a_accepted    BOOLEAN NOT NULL DEFAULT FALSE,
  b_accepted    BOOLEAN NOT NULL DEFAULT FALSE,
  featured      BOOLEAN NOT NULL DEFAULT FALSE,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pledges (
  id                 SERIAL PRIMARY KEY,
  matchup_id         INTEGER NOT NULL REFERENCES matchups(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  email              TEXT NOT NULL,
  amount_cents       INTEGER NOT NULL,
  is_proposer        BOOLEAN NOT NULL DEFAULT FALSE,
  stripe_customer_id TEXT,
  stripe_pm_id       TEXT,
  stripe_session_id  TEXT UNIQUE,
  stripe_pi_id       TEXT,
  status             TEXT NOT NULL DEFAULT 'pledged',
  -- pledged → charged | failed | released
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pledges_matchup_idx ON pledges(matchup_id);
CREATE INDEX IF NOT EXISTS matchups_status_idx ON matchups(status);
`;

async function init() {
  await pool.query(SCHEMA);
}

const q = (text, params) => pool.query(text, params);

// ---- matchups ----

async function listMatchups({ statuses, limit = 50 } = {}) {
  const where = statuses ? `WHERE m.status = ANY($1)` : "";
  const params = statuses ? [statuses] : [];
  const { rows } = await q(
    `SELECT m.*,
            COALESCE(SUM(p.amount_cents) FILTER (WHERE p.status IN ('pledged','charged')), 0)::int AS pledged_cents,
            COUNT(p.id) FILTER (WHERE p.status IN ('pledged','charged'))::int AS backer_count
       FROM matchups m
       LEFT JOIN pledges p ON p.matchup_id = m.id
       ${where}
       GROUP BY m.id
       ORDER BY m.featured DESC, pledged_cents DESC, m.created_at DESC
       LIMIT ${Number(limit)}`,
    params
  );
  return rows;
}

async function getMatchup(slug) {
  const { rows } = await q(
    `SELECT m.*,
            COALESCE(SUM(p.amount_cents) FILTER (WHERE p.status IN ('pledged','charged')), 0)::int AS pledged_cents,
            COUNT(p.id) FILTER (WHERE p.status IN ('pledged','charged'))::int AS backer_count
       FROM matchups m
       LEFT JOIN pledges p ON p.matchup_id = m.id
      WHERE m.slug = $1
      GROUP BY m.id`,
    [slug]
  );
  return rows[0] || null;
}

async function getMatchupById(id) {
  const { rows } = await q(`SELECT slug FROM matchups WHERE id = $1`, [id]);
  return rows[0] ? getMatchup(rows[0].slug) : null;
}

async function createMatchup(m) {
  const { rows } = await q(
    `INSERT INTO matchups (slug, question, a_name, a_handle, b_name, b_handle, target_cents,
                           proposer_name, proposer_email, deadline)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [m.slug, m.question, m.a_name, m.a_handle, m.b_name, m.b_handle, m.target_cents,
     m.proposer_name, m.proposer_email, m.deadline]
  );
  return rows[0];
}

async function updateMatchup(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await q(`UPDATE matchups SET ${sets} WHERE id = $1`, [id, ...keys.map((k) => fields[k])]);
}

async function slugExists(slug) {
  const { rows } = await q(`SELECT 1 FROM matchups WHERE slug = $1`, [slug]);
  return rows.length > 0;
}

// Flip open matchups past their deadline to expired. Cheap; called on page loads.
async function expireStale() {
  await q(`UPDATE matchups SET status = 'expired' WHERE status = 'open' AND deadline < now()`);
}

// ---- pledges ----

async function createPledge(p) {
  const { rows } = await q(
    `INSERT INTO pledges (matchup_id, name, email, amount_cents, is_proposer,
                          stripe_customer_id, stripe_pm_id, stripe_session_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (stripe_session_id) DO NOTHING
     RETURNING *`,
    [p.matchup_id, p.name, p.email, p.amount_cents, !!p.is_proposer,
     p.stripe_customer_id || null, p.stripe_pm_id || null, p.stripe_session_id || null]
  );
  return rows[0] || null;
}

async function pledgesFor(matchupId) {
  const { rows } = await q(
    `SELECT * FROM pledges WHERE matchup_id = $1 ORDER BY amount_cents DESC, created_at ASC`,
    [matchupId]
  );
  return rows;
}

async function updatePledge(id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await q(`UPDATE pledges SET ${sets} WHERE id = $1`, [id, ...keys.map((k) => fields[k])]);
}

async function pledgeBySession(sessionId) {
  const { rows } = await q(`SELECT * FROM pledges WHERE stripe_session_id = $1`, [sessionId]);
  return rows[0] || null;
}

async function stats() {
  const { rows } = await q(
    `SELECT COUNT(DISTINCT m.id)::int AS matchups,
            COALESCE(SUM(p.amount_cents) FILTER (WHERE p.status IN ('pledged','charged')),0)::int AS pledged_cents,
            COUNT(p.id) FILTER (WHERE p.status IN ('pledged','charged'))::int AS pledges
       FROM matchups m LEFT JOIN pledges p ON p.matchup_id = m.id
      WHERE m.status NOT IN ('cancelled')`
  );
  return rows[0];
}

module.exports = {
  init, q,
  listMatchups, getMatchup, getMatchupById, createMatchup, updateMatchup, slugExists, expireStale,
  createPledge, pledgesFor, updatePledge, pledgeBySession, stats,
};
