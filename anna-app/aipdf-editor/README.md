# AiPDF Editor — Anna App edition

This directory is the **Anna App** packaging of AiPDF Editor (schema 4, bundle-only — no
Executas). The editor itself is the same renderer that powers the Windows desktop build and
the web edition; `scripts/build-anna.mjs` assembles the bundle into `bundle/`.

## Layout

| Path | Role |
| --- | --- |
| `app.json` | Store listing metadata (name, tagline, description, category) written to the Developer Console listing. |
| `manifest.json` | Schema-4 manifest: static-SPA bundle, one `main` view, `wasm-unsafe-eval` CSP override for the OCR engine, no `required_executas` (allowed for bundle-only apps). |
| `bundle/` | Generated — do not edit. Rebuild with the commands below. |

## Build

```bash
npm run build:web          # refresh web-dist/ from src/renderer (includes the Anna adapter)
node scripts/build-anna.mjs   # assemble + quota-audit anna-app/aipdf-editor/bundle/
```

## What differs from the plain web edition

- **AI provider**: inside the Anna window the renderer auto-selects the built-in
  **"Anna (host AI)"** provider (`baseUrl anna://host`); `web-shim.js` routes those calls to
  the host LLM via `anna.llm.complete` (text + image blocks, system-role fallback). No API
  key; usage bills to the signed-in user's Anna credits. Explicitly configured BYOK
  providers are respected and keep working when the user picks them.
- **AI editing**: Edit mode turns natural-language requests into a bounded, typed proposal.
  Nothing changes before approval; approved operations stage in memory, rebuild candidate
  bytes, verify the result, and commit once for undo/redo. Page numbers and exact native
  title recoloring are supported, with ambiguous or unverifiable targets rejected.
- **Privacy**: parsing and editing stay in the app window. The app asks before sending the
  document text or page images needed for a consented AI request.
- **OCR packs**: the bundle ships the `tessdata_fast` English pack (the vendored best pack
  is 10.4 MB and would bust Anna's 10 MB per-file cap) plus the vendored Nepali/Hindi packs,
  and only the three LSTM-only Tesseract cores (the app creates workers with OEM 1).
- **Read aloud**: uses the browser's built-in speech synthesis; cloud TTS providers are
  still selectable but require the desktop/web edition (the Anna bundle CSP blocks
  third-party endpoints — stated honestly in the listing).

## Fresh-install verification

```bash
npm run test:anna-adapter   # scripted host-SDK boundary, no network
npm run test:anna-e2e       # real Anna dispatcher + fresh Chromium profile
anna-app validate --strict  # run inside this directory
```

The E2E gate uses deterministic host-LLM fixtures and exercises upload, Q&A, page-number
and title-color plans, rejection/approval, undo/redo, Save As download, saved-byte checks,
reopen, responsive layouts, CSP/network guards, and temporary-profile cleanup.

## Publishing

```bash
anna-app login --host https://anna.partners   # browser approval, PAT ~90 days
anna-app validate --strict                    # run inside this directory
anna-app apps publish                         # push + cut an immutable version
# then: install-test, submit for review, release after approval
```
