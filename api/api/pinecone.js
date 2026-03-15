/**
 * TradeROW — Pinecone API endpoint
 * Vercel serverless function: /api/pinecone
 *
 * Uses Pinecone REST API + Pinecone Inference (embeddings) directly.
 * No npm install required.
 *
 * Env vars to add in Vercel:
 *   PINECONE_API_KEY   — from console.pinecone.io → API Keys
 *   PINECONE_HOST      — your index host URL, e.g. https://traderow-abc123.svc.pinecone.io
 *
 * Actions:
 *   POST { action:"upsert",  trade: {...} }         → embeds & stores a trade
 *   POST { action:"search",  query: "...", topK: 5 } → semantic search, returns trade IDs + scores
 *   POST { action:"delete",  tradeId: "..." }        → removes a trade vector
 *   POST { action:"delete-all" }                     → wipes all vectors (use carefully)
 */

const PINECONE_EMBED_URL = "https://api.pinecone.io/embed";
const EMBED_MODEL        = "multilingual-e5-large"; // 1024 dims, built into Pinecone free tier
const EMBED_DIM          = 1024;

// ── Build a rich text blob from a trade for embedding ────────────
function tradeToText(trade) {
  const parts = [];

  if (trade.pair)      parts.push(`Pair: ${trade.pair}`);
  if (trade.direction) parts.push(`Direction: ${trade.direction}`);
  if (trade.result)    parts.push(`Result: ${trade.result}`);
  if (trade.session)   parts.push(`Session: ${trade.session}`);
  if (trade.market_type) parts.push(`Market: ${trade.market_type}`);

  const pnl = trade.netPnl ?? trade.pnl;
  if (pnl != null) parts.push(`PnL: ${pnl > 0 ? "+" : ""}${pnl.toFixed(2)}`);
  if (trade.rrr || trade.rr) parts.push(`RR: ${(trade.rrr || trade.rr).toFixed(2)}`);
  if (trade.riskPct)   parts.push(`Risk: ${trade.riskPct}%`);

  const behaviors = trade.tags?.psych || trade.behaviors || [];
  if (behaviors.length) parts.push(`Mindset: ${behaviors.join(", ")}`);

  if (trade.notes && trade.notes.trim()) parts.push(`Notes: ${trade.notes.trim()}`);

  const date = trade.entryTime || trade.date;
  if (date) parts.push(`Date: ${new Date(date).toDateString()}`);

  return parts.join(". ");
}

// ── Pinecone Inference: get embedding vector ─────────────────────
async function embed(texts) {
  const r = await fetch(PINECONE_EMBED_URL, {
    method: "POST",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "Content-Type": "application/json",
      "X-Pinecone-API-Version": "2024-10",
    },
    body: JSON.stringify({
      model: EMBED_MODEL,
      inputs: texts.map((t) => ({ text: t })),
      parameters: { input_type: "passage", truncate: "END" },
    }),
  });

  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Pinecone embed error ${r.status}: ${err}`);
  }

  const j = await r.json();
  return j.data.map((d) => d.values);
}

// ── Pinecone Vector DB: upsert ───────────────────────────────────
async function upsertVector(id, values, metadata) {
  const r = await fetch(`${process.env.PINECONE_HOST}/vectors/upsert`, {
    method: "POST",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      vectors: [{ id: String(id), values, metadata }],
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Pinecone upsert error ${r.status}: ${err}`);
  }
  return r.json();
}

// ── Pinecone Vector DB: query ────────────────────────────────────
async function queryVectors(vector, topK, filter) {
  const body = {
    vector,
    topK: topK || 5,
    includeMetadata: true,
  };
  if (filter) body.filter = filter;

  const r = await fetch(`${process.env.PINECONE_HOST}/query`, {
    method: "POST",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Pinecone query error ${r.status}: ${err}`);
  }
  return r.json();
}

// ── Pinecone Vector DB: delete ───────────────────────────────────
async function deleteVector(id) {
  const r = await fetch(`${process.env.PINECONE_HOST}/vectors/delete`, {
    method: "POST",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ids: [String(id)] }),
  });
  if (!r.ok) throw new Error(`Pinecone delete error ${r.status}`);
  return r.json();
}

async function deleteAllVectors() {
  const r = await fetch(`${process.env.PINECONE_HOST}/vectors/delete`, {
    method: "POST",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ deleteAll: true }),
  });
  if (!r.ok) throw new Error(`Pinecone delete-all error ${r.status}`);
  return r.json();
}

// ── Main handler ─────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  if (!process.env.PINECONE_API_KEY || !process.env.PINECONE_HOST) {
    return res.status(500).json({ error: "Missing PINECONE_API_KEY or PINECONE_HOST env vars" });
  }

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const { action } = body;

  // ── UPSERT: index a trade ──────────────────────────────────────
  if (action === "upsert") {
    const { trade } = body;
    if (!trade || !trade.id) return res.status(400).json({ error: "trade.id required" });

    try {
      const text = tradeToText(trade);
      const [vector] = await embed([text]);

      const metadata = {
        pair:       trade.pair        || "",
        result:     trade.result      || "",
        direction:  trade.direction   || "",
        session:    trade.session     || "",
        netPnl:     parseFloat(trade.netPnl ?? trade.pnl ?? 0),
        rrr:        parseFloat(trade.rrr || trade.rr || 0),
        date:       trade.entryTime || trade.date || "",
        behaviors:  (trade.tags?.psych || trade.behaviors || []).join(","),
        notes:      (trade.notes || "").slice(0, 500), // Pinecone metadata limit
        text:       text.slice(0, 500),
      };

      await upsertVector(trade.id, vector, metadata);
      return res.status(200).json({ ok: true, id: trade.id });
    } catch (err) {
      console.error("[Pinecone upsert]", err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── SEARCH: semantic query ─────────────────────────────────────
  if (action === "search") {
    const { query, topK = 8, filter } = body;
    if (!query) return res.status(400).json({ error: "query required" });

    try {
      // Embed with query input_type for better retrieval
      const r = await fetch(PINECONE_EMBED_URL, {
        method: "POST",
        headers: {
          "Api-Key": process.env.PINECONE_API_KEY,
          "Content-Type": "application/json",
          "X-Pinecone-API-Version": "2024-10",
        },
        body: JSON.stringify({
          model: EMBED_MODEL,
          inputs: [{ text: query }],
          parameters: { input_type: "query", truncate: "END" },
        }),
      });

      if (!r.ok) throw new Error(`Embed error ${r.status}: ${await r.text()}`);
      const embData = await r.json();
      const vector = embData.data[0].values;

      const results = await queryVectors(vector, topK, filter || undefined);

      const matches = (results.matches || []).map((m) => ({
        id:       m.id,
        score:    Math.round(m.score * 100) / 100,
        pair:     m.metadata?.pair,
        result:   m.metadata?.result,
        netPnl:   m.metadata?.netPnl,
        date:     m.metadata?.date,
        notes:    m.metadata?.notes,
        text:     m.metadata?.text,
      }));

      return res.status(200).json({ matches });
    } catch (err) {
      console.error("[Pinecone search]", err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── DELETE: remove a single trade ─────────────────────────────
  if (action === "delete") {
    const { tradeId } = body;
    if (!tradeId) return res.status(400).json({ error: "tradeId required" });
    try {
      await deleteVector(tradeId);
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── DELETE-ALL: wipe index (admin use) ────────────────────────
  if (action === "delete-all") {
    try {
      await deleteAllVectors();
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: "Unknown action" });
};
