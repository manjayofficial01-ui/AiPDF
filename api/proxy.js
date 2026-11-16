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
 * Guardrails: https targets only, public hosts only (no loopback, no private
 * ranges, no cloud metadata endpoints), GET/POST only, 32 MB response cap.
 * DNS rebinding is the accepted residual risk of a hostname check on
 * serverless; the desktop app carries the same design (it resolves nothing
 * either) and the worst case is a relayed call the user themselves asked for.
 */

const RESPONSE_CAP = 32 * 1024 * 1024;
const ALLOWED_METHODS = new Set(['GET', 'POST']);

function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === 'metadata.google.internal' || h.endsWith('.svc') || h.endsWith('.svc.cluster.local')) return true;
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (h.startsWith('[') || h === '::1' || h === '::') return true; // IPv6 loopback-ish
  return false;
}

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
  if (isPrivateHost(target.hostname)) {
    res.status(403).json({ ok: false, error: 'The relay does not forward to private addresses.' });
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
