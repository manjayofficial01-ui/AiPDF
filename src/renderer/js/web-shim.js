/**
 * Web deployment shim — the browser equivalent of the Electron preload bridge.
 *
 * The desktop app exposes `window.api` from src/main/preload.js. This script
 * installs a browser stand-in with the same surface so ONE renderer runs in
 * both places: it is loaded as a plain <script> BEFORE the ES-module entry and
 * exits immediately when a real bridge already exists (Electron preload runs
 * first), so index.html needs no build-time divergence.
 *
 * Mapping (desktop → web):
 *   openDialog            → hidden <input type=file>
 *   saveDialog            → File System Access API (Chromium), download fallback
 *   readFile              → registered File/handle, or the IndexedDB user store
 *   writeFile             → handle write / download / IndexedDB by path kind
 *   storeGet / storeSet   → localStorage (same JSON shape as main's settings file)
 *   listSystemFonts       → empty index; users can still upload TTF/OTF, and
 *                           uploaded fonts persist in IndexedDB across reloads
 *   aiModels / aiChat /   → direct fetch first (most providers send CORS
 *   ttsRequest              headers); when the browser blocks it, the same
 *                           call repeats through the same-origin relay
 *                           (/api/proxy, the moral equivalent of the desktop
 *                           main-process proxy). Streaming is parsed here.
 *   print                 → the browser's print dialog on the current view,
 *                           which is what the desktop print was printing too
 *   backupInfo / restore  → honestly unavailable; export a copy instead
 *
 * No file ever leaves the browser except to the AI/TTS endpoints the user
 * configures themselves, and downloads initiated on purpose.
 */
(function () {
  'use strict';
  if (window.api) return; // Electron: the real contextBridge API is installed.

  /* ── tiny helpers ─────────────────────────────────────────────────────── */

  const msg = (err) => String(err && err.message ? err.message : err);

  /** Path segments like the desktop build expects: '/'-separated, drive-free. */
  const baseName = (p) => String(p || '').split(/[\\/]/).pop() || 'document.pdf';
  const under = (p, dir) => String(p).startsWith(dir.endsWith('/') ? dir : dir + '/');
  const utf8 = new TextEncoder();

  const MIME_BY_EXT = {
    pdf: 'application/pdf', txt: 'text/plain', html: 'text/html',
    rtf: 'application/rtf', md: 'text/markdown', csv: 'text/csv',
    json: 'application/json', png: 'image/png', jpg: 'image/jpeg',
    jpeg: 'image/jpeg', webp: 'image/webp', ttf: 'font/ttf', otf: 'font/otf',
  };

  /* ── settings store (mirrors main's settings file semantics) ──────────── */

  const LS_KEY = 'aipdf.web.store';
  let store = {};
  try { store = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch { store = {}; }
  const persistStore = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch { /* private mode */ } };

  /* ── virtual file table ───────────────────────────────────────────────── */
  // Every path the renderer holds came from a gesture (file pick, save pick,
  // drop). Entries remember how to read/write that path again later.

  const USER_DATA = '/aipdf-user-data'; // getPath('userData') on the web

  /** vpath → { file?: File, handle?: FileSystemFileHandle, download?: name, bytes?: Uint8Array, mtimeMs } */
  const files = new Map();

  const register = (path, entry) => { files.set(String(path), entry); return String(path); };

  async function entryBytes(entry) {
    if (entry.handle) return new Uint8Array(await (await entry.handle.getFile()).arrayBuffer());
    if (entry.file) return new Uint8Array(await entry.file.arrayBuffer());
    if (entry.bytes) return entry.bytes;
    if (entry.idbKey != null) {
      const got = await idbGet(entry.idbKey);
      return got || new Uint8Array(0);
    }
    return null;
  }

  /* ── IndexedDB user files (uploaded fonts must survive a reload) ──────── */

  let idbPromise = null;
  function idb() {
    if (idbPromise) return idbPromise;
    idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('aipdf-user-files', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('files');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB unavailable'));
    }).catch((err) => { idbPromise = null; throw err; });
    return idbPromise;
  }
  async function idbTx(mode, fn) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', mode);
      const out = fn(tx.objectStore('files'));
      tx.oncomplete = () => resolve(out.result !== undefined ? out.result : out);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }
  const idbPut = (key, bytes) => idbTx('readwrite', (s) => s.put(bytes, key));
  const idbGet = (key) => idbTx('readonly', (s) => s.get(key));
  const idbDel = (key) => idbTx('readwrite', (s) => s.delete(key));

  /* ── downloads (the no-File-System-Access save path) ──────────────────── */

  function triggerDownload(bytes, name) {
    const blob = new Blob([bytes], { type: MIME_BY_EXT[(name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase()] || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  /* ── file pickers ─────────────────────────────────────────────────────── */

  function inputPick(opts) {
    const exts = [];
    for (const f of opts.filters || []) for (const e of f.extensions || []) if (e && e !== '*') exts.push('.' + String(e).replace(/^\./, ''));
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      if (opts.multiSelections) input.multiple = true;
      if (exts.length) input.accept = exts.join(',');
      input.style.display = 'none';
      let picked = false;
      input.addEventListener('change', () => {
        picked = true;
        const list = Array.from(input.files || []);
        const paths = list.map((f) => register(`/web/${f.name}`, { file: f, mtimeMs: f.lastModified || Date.now() }));
        input.remove();
        resolve(paths.length ? paths : null);
      });
      // FireFox fires no cancel event; watch focus return instead.
      input.addEventListener('cancel', () => { picked = true; input.remove(); resolve(null); });
      document.body.appendChild(input);
      input.click();
      setTimeout(() => {
        window.addEventListener('focus', function onFocus() {
          window.removeEventListener('focus', onFocus);
          setTimeout(() => { if (!picked) { picked = true; input.remove(); resolve(null); } }, 350);
        }, { once: true });
      }, 0);
    });
  }

  async function savePick(opts) {
    const suggested = baseName(opts.defaultPath || 'document.pdf');
    const ext = ((suggested.match(/\.([a-z0-9]+)$/i) || [])[1] || 'pdf').toLowerCase();
    // Chromium: a real save target. Writing later goes through the handle, so
    // repeated saves update the same file in place, like the desktop build.
    if (window.showSaveFilePicker) {
      try {
        const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
        const handle = await window.showSaveFilePicker({
          suggestedName: suggested,
          types: [{ description: suggested, accept: { [mime]: [ext.startsWith('.') ? ext : '.' + ext] } }],
        });
        return register(`/web/${handle.name}`, { handle, download: handle.name, mtimeMs: Date.now() });
      } catch (err) {
        if (err && err.name === 'AbortError') return null; // user cancelled the dialog
        // Anything else (gesture expired on a deep async save flow, rejected
        // type map) falls through to the download path rather than failing.
      }
    }
    register(`/web/${suggested}`, { download: suggested, mtimeMs: Date.now() });
    return `/web/${suggested}`;
  }

  /* ── provider calls: direct fetch, relay when the browser refuses ─────── */

  const RELAY = '/api/proxy';
  const RESPONSE_CAP = 32 * 1024 * 1024; // same order as the desktop caps

  /** Registered during aiChat(stream:true); see aiOnStream below. */
  let streamHandler = null;

  /**
   * Providers with CORS headers (OpenAI, Gemini, ElevenLabs, Mistral…) are
   * called straight from the browser. Others (Claude-style gateways, custom
   * basUrls without CORS) throw a network TypeError; the identical request
   * then repeats through the same-origin relay, which honours custom headers
   * exactly like the desktop's main-process proxy.
   */
  async function providerFetch(opts) {
    const direct = {
      method: opts.method || (opts.body != null ? 'POST' : 'GET'),
      headers: opts.headers || {},
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    };
    try {
      return await fetch(opts.url, direct);
    } catch (err) {
      const res = await fetch(RELAY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: opts.url, method: direct.method, headers: opts.headers || {}, body: opts.body != null ? opts.body : undefined }),
      });
      if (!res.ok && (res.status === 404 || res.status === 405 || res.status === 501)) {
        // No relay in this deployment: surface the original browser error.
        throw err;
      }
      return res;
    }
  }

  async function cappedText(res) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let out = '', size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value ? value.length : 0;
      if (size > RESPONSE_CAP) throw new Error('Response exceeds the size limit');
      out += dec.decode(value, { stream: true });
    }
    return out;
  }

  /* ── the bridge ───────────────────────────────────────────────────────── */

  window.api = {
    async boot() {
      return {
        startupPath: null,
        testMode: false,
        version: '2.26.0-web',
        platform: 'web',
        home: '',
        settings: {},
        dev: false,
        chrome: { overlayHeight: 0, captionWidth: 0 }, // no window chrome to reserve space for
      };
    },

    /**
     * Return a virtual path for a dropped File and register it, so the drop
     * takes the same code path as a desktop drag (openDocFromPath): the
     * document keeps a path, recents work, and a later Ctrl+S "saves back to
     * where it came from" — which in a browser means downloading the updated
     * bytes under the original name.
     */
    pathForFile(file) {
      if (!file || !file.name) return '';
      return register(`/web/${file.name}`, { file, download: file.name, mtimeMs: file.lastModified || Date.now() });
    },

    async grantDroppedFile() { return true; },
    async fileExists(path) {
      if (files.has(path)) return true;
      if (under(path, USER_DATA)) {
        try { return (await idbGet(path)) != null; } catch { return false; }
      }
      return false;
    },
    async fileStat(path) {
      const e = files.get(path);
      if (e) {
        const size = e.file ? e.file.size : e.bytes ? e.bytes.length : null;
        return { size: size || 0, mtimeMs: e.mtimeMs || Date.now() };
      }
      return null;
    },

    openDialog: (opts) => inputPick(opts || {}),
    saveDialog: (opts) => savePick(opts || {}),

    async messageBox(opts = {}) {
      // Only ever used for rare confirmations; the index mapping matches the
      // desktop convention (first button = OK = 0).
      const ok = window.confirm([opts.message, opts.detail].filter(Boolean).join('\n\n'));
      return ok ? 0 : (opts.buttons ? opts.buttons.length - 1 : 0);
    },

    async readFile(path) {
      try {
        if (under(path, USER_DATA)) {
          const got = await idbGet(path);
          return got ? { ok: true, data: got } : { ok: false, error: 'File not found.' };
        }
        const e = files.get(path);
        if (!e) return { ok: false, error: 'This file has not been opened in AiPDF Editor.' };
        const data = await entryBytes(e);
        if (!data) return { ok: false, error: 'This file has not been opened in AiPDF Editor.' };
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: msg(err) };
      }
    },

    async writeFile(path, data, opts) {
      try {
        const bytes = data instanceof Uint8Array ? data : utf8.encode(String(data));
        const e = files.get(path);
        if (e && e.handle) {
          const w = await e.handle.createWritable();
          await w.write(bytes);
          await w.close();
          e.mtimeMs = Date.now();
          return { ok: true, path, size: bytes.length };
        }
        if (e && e.download) {
          triggerDownload(bytes, e.download);
          return { ok: true, path, size: bytes.length };
        }
        if (under(path, USER_DATA)) {
          await idbPut(path, bytes);
          return { ok: true, path, size: bytes.length };
        }
        // Internal/unknown target (parity-test fixtures, in-memory writes).
        files.set(path, { bytes, mtimeMs: Date.now() });
        return { ok: true, path, size: bytes.length };
      } catch (err) {
        return { ok: false, error: msg(err) };
      }
    },

    backupInfo() { return { ok: false, error: 'Version backups are not available in the web edition. Export a copy before risky edits.' }; },
    async restoreBackup() { return { ok: false, error: 'Version backups are not available in the web edition.' }; },

    async deleteFontFile(fileName) {
      try { await idbDel(`${USER_DATA}/fonts/${fileName}`); return true; } catch { return false; }
    },
    async listSystemFonts() {
      // No filesystem font scan in a browser tab; uploaded TTF/OTF fonts still
      // work everywhere (picker → IndexedDB → FontFace + fontkit embedding).
      return { faces: [], skippedCollections: 0, dirs: [], unsupported: true };
    },

    print() { window.print(); return { ok: true }; },
    async setTitle(title) { document.title = title || 'AiPDF Editor'; },
    async setRepresented() {},
    async setTheme() {},
    async ready() {},
    async confirmQuit() { return true; },
    async getPath(name) { return name === 'userData' ? USER_DATA : '/'; },
    async zoom() {},

    async openExternal(url) {
      const allow = new Set([
        'https://github.com/manjayofficial01-ui/AiPDF',
        'https://github.com/manjayofficial01-ui/AiPDF/issues',
        'ms-settings:defaultapps',
      ]);
      if (!allow.has(String(url || ''))) return false;
      window.open(String(url), '_blank', 'noopener');
      return true;
    },

    async storeGet(key, fallback) { return key in store ? store[key] : fallback; },
    async storeSet(key, value) { store[key] = value; persistStore(); return true; },

    /* ── AI (models / chat / stream) ─────────────────────────────────────── */

    async aiModels(opts = {}) {
      try {
        // Same pagination the desktop proxy runs: Gemini pages at 50/1000,
        // OpenAI-compatible gateways may use `after`/`has_more`.
        const base = new URL(String(opts.url || ''));
        if (!/^https?:$/.test(base.protocol)) return { ok: false, error: 'The models endpoint must be an http(s) URL.' };
        const gemini = /generativelanguage\.googleapis\.com|\/v1beta(\/|$)/i.test(String(opts.url));
        const collected = [];
        let pageToken = '', after = '';
        for (let page = 0; page < 50; page++) {
          const u = new URL(base.toString());
          if (gemini) {
            u.searchParams.set('pageSize', '1000');
            if (pageToken) u.searchParams.set('pageToken', pageToken);
          } else if (after) {
            u.searchParams.set('after', after);
          }
          const res = await providerFetch({ url: u.toString(), method: 'GET', headers: opts.headers || {} });
          if (!res.ok) return { ok: false, status: res.status, error: (await res.text().catch(() => '')).slice(0, 400) };
          let json;
          try { json = JSON.parse(await cappedText(res)); } catch { return { ok: false, status: res.status, error: 'Invalid JSON from the models endpoint.' }; }
          const raw = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
          for (const m of raw) {
            if (typeof m === 'string') { collected.push(m); continue; }
            if (m && Array.isArray(m.supportedGenerationMethods) && !m.supportedGenerationMethods.includes('generateContent')) continue;
            const id = String((m && (m.id || m.name)) || '').replace(/^models\//, '');
            if (id) collected.push(id);
          }
          const next = json.nextPageToken || json.next_page_token || '';
          if (next && next !== pageToken) { pageToken = next; continue; }
          if (json.has_more === true && json.last_id && json.last_id !== after) { after = json.last_id; continue; }
          break;
        }
        return { ok: true, models: [...new Set(collected)].sort((a, b) => a.localeCompare(b)) };
      } catch (err) {
        return { ok: false, error: msg(err) };
      }
    },

    async aiChat(opts = {}) {
      try {
        if (!/^https?:/i.test(String(opts.url || ''))) return { ok: false, error: 'The chat endpoint must be an http(s) URL.' };
        const res = await providerFetch(opts);
        if (!res.ok) return { ok: false, status: res.status, error: (await res.text().catch(() => '')).slice(0, 500) };
        if (!opts.stream) {
          const j = JSON.parse(await cappedText(res));
          if (opts.raw) return { ok: true, json: j };
          const c = j.choices?.[0]?.message?.content;
          const text = typeof c === 'string'
            ? c
            : Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('') : (c ? String(c) : '');
          return { ok: true, text };
        }
        // Streaming: parse the SSE frames here exactly where the desktop main
        // process did, then forward deltas through the registered handler.
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '', out = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            const l = line.trim();
            if (!l.startsWith('data:')) continue;
            const payload = l.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const j = JSON.parse(payload);
              const d = j.choices?.[0]?.delta?.content
                || j.choices?.[0]?.text
                || (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
              if (d) {
                out += d;
                if (out.length > RESPONSE_CAP) throw new Error('Streamed response exceeds the size limit');
                if (streamHandler) streamHandler({ reqId: opts.reqId, delta: d, text: out });
              }
            } catch { /* partial frame */ }
          }
        }
        return { ok: true, text: out };
      } catch (err) {
        return { ok: false, error: msg(err) };
      }
    },

    aiOnStream(handler) {
      streamHandler = handler;
      return () => { if (streamHandler === handler) streamHandler = null; };
    },

    /* ── TTS (Read Aloud; the `local` provider needs none of this) ───────── */

    async ttsRequest(opts = {}) {
      try {
        if (!/^https?:/i.test(String(opts.url || ''))) return { ok: false, error: 'The speech endpoint must be an http(s) URL.' };
        const res = await providerFetch(opts);
        if (!res.ok) return { ok: false, status: res.status, error: (await res.text().catch(() => '')).slice(0, 500) };
        if (opts.expect === 'json') return { ok: true, json: JSON.parse(await cappedText(res)) };
        // Binary audio → base64, the same shape the desktop proxy returns.
        const bytes = await res.arrayBuffer();
        if (bytes.byteLength > RESPONSE_CAP) return { ok: false, error: 'Response exceeds the size limit' };
        let b64 = '';
        const u8 = new Uint8Array(bytes);
        const CHUNK = 0x8000;
        for (let i = 0; i < u8.length; i += CHUNK) b64 += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CHUNK, u8.length)));
        return { ok: true, audioBase64: b64, contentType: res.headers.get('content-type') || 'audio/mpeg' };
      } catch (err) {
        return { ok: false, error: msg(err) };
      }
    },

    on(channel, handler) {
      const allowed = ['menu:action', 'app:openPath', 'app:willClose'];
      // Nothing can push menu actions or open paths from a web server; the
      // ribbon, shortcuts and drop handling live entirely in the renderer.
      return allowed.includes(channel) ? () => {} : () => {};
    },
  };

  // Mark the edition for diagnostics and let anyone verify the shim loaded.
  window.AIPDF_WEB = true;
})();
