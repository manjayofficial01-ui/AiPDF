const {
  TOKEN_TTL_MS,
  extraHostsFromEnv,
  isAllowedRelayTarget,
  issueRelayToken,
  createRateLimiter,
  clientKey,
} = require('./relay-policy.js');

const tokenLimiter = createRateLimiter({ limit: 30, windowMs: 60_000 });

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'POST only' });
    return;
  }
  const origin = String(req.headers?.origin || '');
  const host = String(req.headers?.host || '');
  if (origin && host) {
    let parsed;
    try { parsed = new URL(origin); } catch {
      res.status(403).json({ ok: false, error: 'Cross-origin token requests are not allowed.' });
      return;
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== host) {
      res.status(403).json({ ok: false, error: 'Cross-origin token requests are not allowed.' });
      return;
    }
  }
  const rate = tokenLimiter(clientKey(req));
  if (!rate.ok) {
    res.setHeader('Retry-After', String(Math.ceil(rate.retryAfterMs / 1000)));
    res.status(429).json({ ok: false, error: 'Token rate limit exceeded.' });
    return;
  }
  if (!process.env.AIPDF_RELAY_SECRET) {
    res.status(503).json({ ok: false, error: 'Relay signing is not configured.' });
    return;
  }
  const url = String(req.body?.url || '');
  if (!isAllowedRelayTarget(url, extraHostsFromEnv())) {
    res.status(403).json({ ok: false, error: 'The relay target is not allowed.' });
    return;
  }
  try {
    const now = Date.now();
    const token = issueRelayToken(url, process.env.AIPDF_RELAY_SECRET, { now });
    res.status(200).json({ ok: true, token, expiresAt: now + TOKEN_TTL_MS });
  } catch {
    res.status(500).json({ ok: false, error: 'Could not issue a relay token.' });
  }
};

module.exports.config = { runtime: 'nodejs20.x' };
