/**
 * TradeROW — Redis API endpoint
 * Vercel serverless function: /api/redis
 *
 * Uses Upstash REST API directly — no npm install needed.
 * Env vars required (already set in Vercel):
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *
 * Actions:
 *   GET  /api/redis?action=leaderboard        → returns cached leaderboard (60s TTL)
 *   POST /api/redis  { action:"rate-limit", userId:"..." } → checks push rate limit
 *   POST /api/redis  { action:"invalidate" }  → clears leaderboard cache
 */

const SUPABASE_URL      = "https://hgzxeezrfsyjoltwevzu.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhnenhlZXpyZnN5am9sdHdldnp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMDExODUsImV4cCI6MjA4ODY3NzE4NX0.Jwo8ZCl9HOiHJkq27dIh7-ngoy_9EX4eSOre0ef82ts";

const LB_CACHE_KEY = "traderow:leaderboard";
const LB_CACHE_TTL = 60;        // seconds — leaderboard freshness window
const PUSH_RATE_LIMIT = 120;    // seconds — min gap between stat pushes per user

// ── Upstash REST helpers ────────────────────────────────────────
async function redisGet(key) {
  const r = await fetch(
    `${process.env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }
  );
  const j = await r.json();
  return j.result ?? null;
}

async function redisSet(key, value, exSeconds) {
  await fetch(
    `${process.env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}${exSeconds ? `/ex/${exSeconds}` : ""}`,
    { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }
  );
}

async function redisDel(key) {
  await fetch(
    `${process.env.UPSTASH_REDIS_REST_URL}/del/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }
  );
}

async function redisIncr(key) {
  const r = await fetch(
    `${process.env.UPSTASH_REDIS_REST_URL}/incr/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }
  );
  const j = await r.json();
  return j.result;
}

async function redisExpire(key, seconds) {
  await fetch(
    `${process.env.UPSTASH_REDIS_REST_URL}/expire/${encodeURIComponent(key)}/${seconds}`,
    { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }
  );
}

// ── Supabase leaderboard fetch ──────────────────────────────────
async function fetchLeaderboardFromSupabase() {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/leaderboard?opted_in=eq.true&order=discipline_score.desc&limit=100&select=*`,
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );
  if (!r.ok) throw new Error(`Supabase error ${r.status}`);
  return r.json();
}

// ── Main handler ────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // ── GET: leaderboard cache ───────────────────────────────────
  if (req.method === "GET") {
    const { action } = req.query;

    if (action === "leaderboard") {
      try {
        // Try Redis cache first
        const cached = await redisGet(LB_CACHE_KEY);
        if (cached) {
          const data = JSON.parse(cached);
          return res.status(200).json({ source: "cache", data });
        }

        // Cache miss — fetch fresh from Supabase
        const data = await fetchLeaderboardFromSupabase();
        await redisSet(LB_CACHE_KEY, data, LB_CACHE_TTL);
        return res.status(200).json({ source: "live", data });

      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    return res.status(400).json({ error: "Unknown action" });
  }

  // ── POST ─────────────────────────────────────────────────────
  if (req.method === "POST") {
    let body = {};
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    } catch {
      return res.status(400).json({ error: "Invalid JSON body" });
    }

    const { action } = body;

    // Rate limit check before a leaderboard push
    if (action === "rate-limit") {
      const { userId } = body;
      if (!userId) return res.status(400).json({ error: "userId required" });

      const key = `traderow:rl:lb:${userId}`;
      try {
        const count = await redisIncr(key);
        if (count === 1) {
          // First hit — set expiry window
          await redisExpire(key, PUSH_RATE_LIMIT);
        }
        if (count > 1) {
          // Already pushed recently — get TTL to tell user how long to wait
          const ttlRes = await fetch(
            `${process.env.UPSTASH_REDIS_REST_URL}/ttl/${encodeURIComponent(key)}`,
            { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }
          );
          const ttlData = await ttlRes.json();
          return res.status(200).json({ allowed: false, waitSeconds: ttlData.result ?? PUSH_RATE_LIMIT });
        }
        return res.status(200).json({ allowed: true });
      } catch (err) {
        // On Redis error, allow the push (fail open)
        return res.status(200).json({ allowed: true, note: "redis-err-failopen" });
      }
    }

    // Invalidate leaderboard cache (called after a successful push)
    if (action === "invalidate") {
      try {
        await redisDel(LB_CACHE_KEY);
        return res.status(200).json({ ok: true });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    return res.status(400).json({ error: "Unknown action" });
  }

  return res.status(405).json({ error: "Method not allowed" });
};
