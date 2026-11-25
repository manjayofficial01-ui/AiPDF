const crypto = require('node:crypto');

const DEFAULT_ALLOWED_HOSTS = new Set([
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'openrouter.ai',
  'api.groq.com',
  'api.together.xyz',
  'api.deepseek.com',
  'api.mistral.ai',
  'api.elevenlabs.io',
  'api.fish.audio',
  'api.anthropic.com',
]);

const TOKEN_TTL_MS = 5 * 60 * 1000;

function extraHostsFromEnv(value = process.env.AIPDF_RELAY_EXTRA_HOSTS || '') {
  return String(value).split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
}

function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === 'metadata.google.internal' || h.endsWith('.svc') || h.endsWith('.svc.cluster.local')) return true;
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  return false;
}

function isAllowedRelayTarget(raw, extraHosts = []) {
  let target;
  try { target = new URL(String(raw || '')); } catch { return false; }
  if (target.protocol !== 'https:' || target.username || target.password) return false;
  if (target.port && target.port !== '443') return false;
  const host = target.hostname.toLowerCase();
  if (isPrivateHost(host)) return false;
  const extras = new Set((Array.isArray(extraHosts) ? extraHosts : extraHostsFromEnv()).map((item) => String(item).toLowerCase()));
  return DEFAULT_ALLOWED_HOSTS.has(host) || extras.has(host) || host.endsWith('.openai.azure.com');
}

function requireSecret(secret = process.env.AIPDF_RELAY_SECRET || '') {
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('AIPDF_RELAY_SECRET must be at least 16 characters.');
  return secret;
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function issueRelayToken(raw, secret = process.env.AIPDF_RELAY_SECRET || '', { now = Date.now(), ttlMs = TOKEN_TTL_MS } = {}) {
  const key = requireSecret(secret);
  if (!isAllowedRelayTarget(raw)) throw new Error('Relay target is not allowed.');
  if (!Number.isFinite(ttlMs) || ttlMs < 30_000 || ttlMs > 10 * 60_000) throw new Error('Relay token TTL is outside the allowed range.');
  const host = new URL(raw).hostname.toLowerCase();
  const payload = Buffer.from(JSON.stringify({ v: 1, host, exp: now + ttlMs })).toString('base64url');
  return `${payload}.${sign(payload, key)}`;
}

function verifyRelayToken(token, raw, secret = process.env.AIPDF_RELAY_SECRET || '', { now = Date.now() } = {}) {
  if (typeof token !== 'string' || !token || token.length > 4096 || !isAllowedRelayTarget(raw)) return { ok: false, reason: 'invalid_target' };
  let key;
  try { key = requireSecret(secret); } catch { return { ok: false, reason: 'secret_missing' }; }
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'invalid_token' };
  const expected = sign(parts[0], key);
  const actualBuffer = Buffer.from(parts[1]);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    return { ok: false, reason: 'invalid_signature' };
  }
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch {
    return { ok: false, reason: 'invalid_payload' };
  }
  const host = new URL(raw).hostname.toLowerCase();
  if (payload?.v !== 1 || payload.host !== host || !Number.isFinite(payload.exp) || payload.exp <= now) {
    return { ok: false, reason: 'expired_or_mismatched' };
  }
  return { ok: true, host };
}

function createRateLimiter({ limit = 60, windowMs = 60_000, now = Date.now } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(windowMs) || windowMs < 1) throw new Error('Invalid rate limit configuration.');
  const buckets = new Map();
  return function check(key) {
    const current = now();
    if (buckets.size > 10_000) {
      for (const [bucketKey, bucket] of buckets) if (bucket.resetAt <= current) buckets.delete(bucketKey);
      if (buckets.size > 10_000) buckets.clear();
    }
    const id = String(key || 'unknown');
    let bucket = buckets.get(id);
    if (!bucket || bucket.resetAt <= current) {
      bucket = { count: 0, resetAt: current + windowMs };
      buckets.set(id, bucket);
    }
    if (bucket.count >= limit) {
      return { ok: false, remaining: 0, retryAfterMs: Math.max(1, bucket.resetAt - current) };
    }
    bucket.count++;
    return { ok: true, remaining: limit - bucket.count, retryAfterMs: 0 };
  };
}

function clientKey(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req?.headers?.['x-real-ip'] || req?.socket?.remoteAddress || 'unknown');
}

module.exports = {
  DEFAULT_ALLOWED_HOSTS,
  TOKEN_TTL_MS,
  extraHostsFromEnv,
  isPrivateHost,
  isAllowedRelayTarget,
  issueRelayToken,
  verifyRelayToken,
  createRateLimiter,
  clientKey,
};
