/**
 * TradeROW — Sentry Error Reporting endpoint
 * Vercel serverless function: /api/sentry
 *
 * Receives error reports from the frontend and forwards them to
 * Sentry using their Envelope API (no SDK needed, pure REST).
 *
 * Env vars to add in Vercel:
 *   SENTRY_DSN  — from sentry.io → Settings → Projects → your project → Client Keys (DSN)
 *                 Looks like: https://abc123@o123456.ingest.sentry.io/789012
 *
 * This proxy pattern keeps your DSN off the client page source,
 * and lets you filter/enrich events server-side before forwarding.
 */

// ── Parse a Sentry DSN into its components ───────────────────────
function parseDSN(dsn) {
  try {
    const url   = new URL(dsn);
    const key   = url.username;
    const host  = url.hostname;
    const projId = url.pathname.replace("/", "");
    return { key, host, projId };
  } catch {
    return null;
  }
}

// ── Build Sentry envelope payload ────────────────────────────────
function buildEnvelope(event, dsn) {
  const { key, projId } = parseDSN(dsn);
  const eventId = event.event_id || crypto.randomUUID().replace(/-/g, "");

  const header = JSON.stringify({
    event_id: eventId,
    sent_at:  new Date().toISOString(),
    dsn,
  });

  const itemHeader = JSON.stringify({ type: "event" });
  const itemBody   = JSON.stringify({ ...event, event_id: eventId });

  return `${header}\n${itemHeader}\n${itemBody}\n`;
}

// ── Forward to Sentry ingest ──────────────────────────────────────
async function sendToSentry(event, dsn) {
  const { host, projId } = parseDSN(dsn);
  const envelope = buildEnvelope(event, dsn);

  const r = await fetch(`https://${host}/api/${projId}/envelope/`, {
    method:  "POST",
    headers: {
      "Content-Type": "application/x-sentry-envelope",
      "User-Agent":   "TradeROW/1.0",
    },
    body: envelope,
  });

  return r.ok;
}

// ── Main handler ─────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return res.status(500).json({ error: "SENTRY_DSN not configured" });

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const { type, message, stack, context, level = "error" } = body;

  // Build a Sentry event
  const event = {
    platform:  "javascript",
    level,
    timestamp: new Date().toISOString(),
    logger:    "traderow.frontend",
    release:   "traderow@1.0.0",
    environment: process.env.VERCEL_ENV || "production",

    // Main error or message
    ...(type === "exception"
      ? {
          exception: {
            values: [
              {
                type:  message?.split(":")[0] || "Error",
                value: message || "Unknown error",
                stacktrace: stack
                  ? {
                      frames: stack
                        .split("\n")
                        .filter(Boolean)
                        .map((line) => ({ filename: "index.html", function: line.trim() }))
                        .reverse(),
                    }
                  : undefined,
              },
            ],
          },
        }
      : {
          message: message || "Unknown event",
        }),

    // Extra context (page, user action, trade id, etc.)
    extra: context || {},

    // Request info
    request: {
      url:     req.headers.referer || "https://trade-row.vercel.app",
      headers: {
        "User-Agent": req.headers["user-agent"] || "",
      },
    },

    // Tags for filtering in Sentry dashboard
    tags: {
      app:       "traderow",
      source:    context?.source    || "unknown",
      page:      context?.page      || "unknown",
    },
  };

  // Attach user info if provided (never log passwords/tokens)
  if (body.userId || body.userEmail) {
    event.user = {
      id:    body.userId    || undefined,
      email: body.userEmail || undefined,
    };
  }

  try {
    await sendToSentry(event, dsn);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[Sentry proxy]", err.message);
    // Don't fail loudly — error reporting should never break the app
    return res.status(200).json({ ok: false, note: "forwarding failed silently" });
  }
};
