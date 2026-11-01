/**
 * Redaction integrity — the browser half.
 *
 * A redaction is a claim: "this content is gone from the file". Until now the
 * app made the claim and moved on, and both of its mechanisms can fail at it —
 * the plain Apply path covers the area with a black box while the original text
 * operators stay in the content stream, and the Sanitize path rebuilds the page
 * as an image, which works but is only believed to work.
 *
 * So the text under each mark is captured *before* anything changes, and the
 * bytes a save is about to write are reopened with pdf.js — the same independent
 * extractor the Compare tool uses — and searched. The matching rule itself lives
 * in redactproof.js so it can be asserted in plain Node.
 */

import { pdfjs, textInRect } from './viewer.js';
import { matchRedactions, redactionVerdict } from './redactproof.js';

/**
 * Remember what each mark is about to destroy.
 *
 * `native: false` means the page had no text layer under the mark at all. That
 * is not a pass — it is a redaction whose removal this check cannot confirm, and
 * it has to be reported as such.
 *
 * @returns {Promise<Array<{page:number, secret:string, native:boolean}>>}
 */
export async function captureRedactionSecrets(doc, marks) {
  const out = [];
  for (const a of marks) {
    let secret = '';
    try { secret = await textInRect(a.page, a.rect); } catch { secret = ''; }
    out.push({ page: a.page, secret: secret.trim(), native: secret.trim().length >= 2 });
  }
  return out;
}

/**
 * Reopen the built file and prove the captured strings are gone.
 * @param {Uint8Array} bytes exactly what is about to be written
 * @param {Array} proof      what captureRedactionSecrets recorded
 */
export async function verifyRedactions(bytes, proof) {
  if (!proof || !proof.length) {
    return { checked: 0, leaks: [], unverifiable: [], ok: true };
  }
  const pdf = await pdfjs.getDocument({ data: bytes.slice(0), useSystemFonts: false }).promise;
  const pages = new Map();
  try {
    const needed = [...new Set(proof.map((p) => p.page))];
    for (const i of needed) {
      let text = '';
      try {
        const p = await pdf.getPage(i + 1);
        const tc = await p.getTextContent();
        text = tc.items.map((x) => x.str || '').join(' ');
      } catch { text = ''; }
      pages.set(i, text);
    }
  } finally {
    try { pdf.destroy(); } catch { /* ignore */ }
  }
  return matchRedactions(pages, proof);
}

export { redactionVerdict };
