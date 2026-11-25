/**
 * Same-origin relay for AI / TTS provider calls from the web edition.
 *
 * The desktop app proxies provider calls through its main process because
 * browsers cannot always reach provider endpoints directly (missing CORS
 * headers, required custom headers, no way to set them). The web renderer
 * first tries a direct fetch and only repeats the call through this relay
 * when the browser blocked it — so this exists purely to restore parity,
 * not to see anyone's data: requests come from the user's own session with
 * the user's own keys, addressed to the endpoint the user configured.
 *
 * Guardrails: https targets only, built-in/configured provider allowlist,
 * short-lived host-bound HMAC token, per-instance rate limit, GET/POST only,
 * and a 32 MB response cap. DNS rebinding remains a residual serverless risk,
 * but the relay is no longer a generic public forwarding service.
 */

const {
  extraHostsFromEnv,
  isAllowedRelayTarget,
  verifyRelayToken,
  createRateLimiter,
  clientKey,
} = require('./relay-policy.js');

const RESPONSE_CAP = 32 * 1024 * 1024;
const ALLOWED_METHODS = new Set(['GET', 'POST']);
const relayLimiter = createRateLimiter({ limit: 120, windowMs: 60_000 });

/** Never forward hop-by-hop or identity headers; everything else passes. */
function filterHeaders(headers) {
  const skip = new Set([
    'host', 'connection', 'content-length', 'accept-encoding',
    'origin', 'referer', 'cookie', 'x-forwarded-for', 'x-forwarded-host',
    'x-vercel-id', 'x-vercel-forwarded-for', 'forwarded',
  ]);
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!skip.has(String(k).toLowerCase()) && v != null) out[k] = String(v);
  }
  return out;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'POST only' });
    return;
  }

  const payload = req.body && typeof req.body === 'object' ? req.body : null;
  if (!payload) {
    res.status(400).json({ ok: false, error: 'Missing request envelope.' });
    return;
  }

  const rate = relayLimiter(clientKey(req));
  if (!rate.ok) {
    res.setHeader('Retry-After', String(Math.ceil(rate.retryAfterMs / 1000)));
    res.status(429).json({ ok: false, error: 'Relay rate limit exceeded.' });
    return;
  }
  if (!process.env.AIPDF_RELAY_SECRET) {
    res.status(503).json({ ok: false, error: 'Relay signing is not configured.' });
    return;
  }

  let target;
  try { target = new URL(String(payload.url || '')); } catch {
    res.status(400).json({ ok: false, error: 'The relay target must be an absolute URL.' });
    return;
  }
  if (target.protocol !== 'https:') {
    res.status(400).json({ ok: false, error: 'The relay only forwards https:// endpoints.' });
    return;
  }
  const method = String(payload.method || 'POST').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    res.status(400).json({ ok: false, error: 'Only GET and POST are relayed.' });
    return;
  }
  if (!isAllowedRelayTarget(target.toString(), extraHostsFromEnv())) {
    res.status(403).json({ ok: false, error: 'The relay target is not allowed.' });
    return;
  }
  const verdict = verifyRelayToken(payload.relayToken, target.toString());
  if (!verdict.ok) {
    res.status(401).json({ ok: false, error: 'A valid relay token is required.' });
    return;
  }

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method,
      headers: filterHeaders(payload.headers),
      body: method === 'GET' || payload.body == null
        ? undefined
        : typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body),
      redirect: 'manual',
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: `Upstream request failed: ${err && err.message ? err.message : err}` });
    return;
  }

  res.status(upstream.status);
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Aipdf-Relay', '1');

  if (!upstream.body) {
    res.end();
    return;
  }

  // Stream straight through (SSE chat deltas stay live) with a hard cap.
  let size = 0;
  try {
    for await (const chunk of upstream.body) {
      size += chunk.byteLength;
      if (size > RESPONSE_CAP) {
        res.destroy(); // status is already sent; cutting the stream surfaces the failure
        return;
      }
      res.write(Buffer.from(chunk));
    }
    res.end();
  } catch {
    res.destroy();
  }
};

module.exports.config = { runtime: 'nodejs20.x' };
