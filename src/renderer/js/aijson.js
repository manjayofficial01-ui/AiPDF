/**
 * Robust JSON recovery from AI responses + normalizers for the document-AI
 * features (suggested follow-ups, outline, contract review, PII candidates).
 *
 * Pure module — no DOM, no imports — so the headless test gate
 * (scripts/aidocs-test.mjs) can exercise every function directly. Models
 * frequently wrap JSON in markdown fences or lead with a sentence; extractJson
 * recovers the first balanced JSON value without assuming clean output.
 */

const MAX_FOLLOWUPS = 3;
const MAX_OUTLINE_NODES = 120;

export function completionText(reply) {
  if (typeof reply === 'string') return reply;
  if (typeof reply?.text === 'string') return reply.text;
  if (typeof reply?.content === 'string') return reply.content;
  return '';
}

/** Find and parse the first balanced JSON value in a model response.
 *  kind: 'array' | 'object' | 'any' (default). Returns null when nothing
 *  parseable of the requested kind is present — callers must handle null. */
export function extractJson(text, kind = 'any') {
  if (typeof text !== 'string') return null;
  // Strip markdown fences so fence markers never sit inside the scan window.
  const clean = text.replace(/```[a-zA-Z]*\s*/g, '');
  for (const [open, close] of kind === 'object'
    ? [['{', '}']]
    : kind === 'array'
      ? [['[', ']']]
      : [['{', '}'], ['[', ']']]) {
    const start = clean.indexOf(open);
    if (start < 0) continue;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < clean.length; i++) {
      const ch = clean[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (!depth) {
          try {
            const parsed = JSON.parse(clean.slice(start, i + 1));
            if (Array.isArray(parsed)) { if (kind !== 'object') return parsed; }
            else if (parsed && typeof parsed === 'object') { if (kind !== 'array') return parsed; }
            else return parsed;
          } catch { /* fence or truncation noise — keep scanning outer text */ }
          break;
        }
      }
    }
  }
  return null;
}

const asText = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** AI Assistant-style suggested follow-ups: keep short, unique, human strings. */
export function normalizeFollowups(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    let q = asText(typeof item === 'string' ? item : (item && (item.question || item.text || item.q)), 140);
    if (!q) continue;
    q = q.replace(/\s+/g, ' ').replace(/^(question\s*\d+[:.)-]\s*)/i, '').trim();
    const key = q.toLowerCase();
    if (!q || q.length < 6 || seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= MAX_FOLLOWUPS) break;
  }
  return out;
}

/** Outline node: {level 1..3, text, page (1-based, clamped)}. */
export function normalizeOutline(raw, numPages = 0) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const text = asText(item.text ?? item.title ?? item.label, 160);
    if (!text) continue;
    const level = Math.min(3, Math.max(1, Math.round(Number(item.level) || 1)));
    let page = Math.round(Number(item.page) || 1);
    if (!Number.isFinite(page) || page < 1) page = 1;
    if (numPages) page = Math.min(page, numPages);
    const key = level + '|' + text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ level, text, page });
    if (out.length >= MAX_OUTLINE_NODES) break;
  }
  return out;
}

const RISK_SEVERITIES = ['high', 'medium', 'low'];

/** Contract Intelligence report (Adobe-style): shape every field so the card
 *  renderer can trust it. Returns null when the payload is not a report. */
export function normalizeContract(raw, numPages = 0) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const clampPage = (p) => {
    let v = Math.round(Number(p) || 0);
    if (!Number.isFinite(v) || v < 1) v = 1;
    return numPages ? Math.min(v, numPages) : v;
  };
  const list = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);
  const parties = list(raw.parties).map((p) => asText(typeof p === 'string' ? p : (p && (p.name || p.party)), 80)).filter(Boolean);
  const keyTerms = list(raw.keyTerms ?? raw.terms ?? raw.key_terms).map((t) => {
    if (!t || typeof t !== 'object') return null;
    const label = asText(t.label ?? t.term ?? t.name, 60);
    const value = asText(t.value ?? t.detail ?? t.summary, 220);
    if (!label) return null;
    return { label, value, page: clampPage(t.page) };
  }).filter(Boolean);
  const risks = list(raw.risks ?? raw.flags ?? raw.riskFlags ?? raw.risk_flags).map((r) => {
    if (!r || typeof r !== 'object') return null;
    const title = asText(r.title ?? r.clause ?? r.name, 120);
    if (!title) return null;
    let sev = asText(r.severity ?? r.level ?? r.risk, 12).toLowerCase();
    if (!RISK_SEVERITIES.includes(sev)) sev = 'medium';
    return {
      severity: sev,
      title,
      detail: asText(r.detail ?? r.reason ?? r.description ?? r.why, 400),
      page: clampPage(r.page),
    };
  }).filter(Boolean);
  risks.sort((a, b) => RISK_SEVERITIES.indexOf(a.severity) - RISK_SEVERITIES.indexOf(b.severity));
  const actionItems = list(raw.actionItems ?? raw.actions ?? raw.action_items)
    .map((a) => asText(typeof a === 'string' ? a : (a && (a.text ?? a.action ?? a.item)), 240)).filter(Boolean);
  let confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence)) confidence = raw.isContract ? 0.7 : 0.3;
  confidence = Math.min(1, Math.max(0, confidence));
  return {
    documentType: asText(raw.documentType ?? raw.type ?? raw.docType, 60) || 'Document',
    isContract: !!(raw.isContract ?? raw.is_contract ?? /contract|agreement|nda|lease|msa|sla/i.test(raw.documentType ?? raw.type ?? '')),
    confidence,
    summary: asText(raw.summary ?? raw.overview, 900),
    parties,
    keyTerms,
    risks,
    actionItems,
  };
}

/** Smart Redact AI candidates: {page 1-based, text, type, reason}.
 *  mapType canonicalises provider-specific type names (e.g. 'person' → 'name')
 *  BEFORE the validTypes filter, so synonyms are not dropped as unknown.
 *  mapType has no default value on purpose — scripts/audit-imports.mjs
 *  resolves called parameters by name, which default-valued params lose. */
export function normalizePiiCandidates(raw, numPages = 0, validTypes = null, mapType) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const text = asText(item.text ?? item.value ?? item.match, 120);
    if (!text || text.length < 2) continue;
    let page = Math.round(Number(item.page) || 1);
    if (!Number.isFinite(page) || page < 1) page = 1;
    if (numPages) page = Math.min(page, numPages);
    const rawType = asText(item.type ?? item.category ?? item.kind, 24).toLowerCase().replace(/[^a-z]/g, '') || 'other';
    const type = mapType ? mapType(rawType) : rawType;
    if (validTypes && !validTypes.has(type)) continue;
    out.push({ page, text, type, reason: asText(item.reason ?? item.why ?? item.note, 140) });
    if (out.length >= 300) break;
  }
  return out;
}
