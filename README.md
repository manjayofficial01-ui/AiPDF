# AiPDF Editor

A modern, Electron‑based PDF **viewer and editor** with a built‑in AI assistant.
It was designed by studying the standards and best‑in‑class features of the
top consumer PDF editors (Adobe Acrobat, Foxit, PDFelement, Nitro PDF, and
PDF‑XChange) and integrating the capabilities that matter most into a single,
fast, local‑first desktop app.

> Local‑first: your files never leave your machine. The AI assistant is
> **bring‑your‑own‑key** — point it at any OpenAI‑compatible endpoint
> (OpenAI, OpenRouter, Groq, Ollama, LM Studio…) and your documents are sent
> only to the endpoint you choose.

---

## Features

Mapped from the capabilities that define the category leaders:

| Capability | What AiPDF does | Inspired by |
| --- | --- | --- |
| **View** | Fast pdf.js rendering, lazy page loading, text‑layer selection, thumbnails, bookmarks/outline, continuous & single‑page layouts, fit‑width/fit‑page, zoom, dark mode, **measurement rulers with draggable guides** — pull a guide straight out of a ruler (Photoshop‑style), it snaps to page edges/centre/other guides, moves by dragging and deletes by dragging back onto the ruler or double‑clicking (View ▸ Clear Guides). **Full layer panel**: add a layer, show or hide any layer, rename it, delete it, and pick the **active layer** — new annotations, text boxes and Direct Editor text are placed on it, and the properties panel can move a selection to another layer. Every layer is written into the saved file as a real optional‑content group (OCG), so Acrobat and every other reader sees the same layers, names and visibility. | All leaders |
| **Comment** | Highlight, underline, strike‑through, squiggly, sticky notes, shapes (rect/ellipse/line/arrow), free‑ink, text boxes & callouts, stamps, signatures, images, measurement. **Real PDF annotations** are written with appearance streams so they render in any reader. | Acrobat / Foxit |
| **Edit** | **Direct Editor** — Acrobat‑style in‑place text editing with a full Format panel (font, size, colour, bold/italic/underline, align incl. justify, line & character spacing, horizontal scaling). The font dropdown lists the **fonts installed on your machine** (grouped under *Local fonts*) alongside the standard families — picking one registers it so it embeds on save. **Tables are recognised** (ruled *and* borderless) so an edit inside a table is scoped to its **cell**, not the whole row — and the same cell scoping now works on **recognised scans**: OCR lines are cut at table-rule glyphs ("|" read by Tesseract) and word gutters, the grid is rebuilt from the recurring boundaries (header bands that sit at wrapped-line pitch are absorbed), and each cell becomes an independent block. With an AI key, recognition goes further: the vision model returns the table as **explicit per-cell entries** (the structure-aware idea from a proven PDF→Word flow), so cells arrive pre-separated. The Direct Editor panel also offers **Select area**: drag a rectangle on the page and only the text inside it becomes editable — on scans, recognition runs for that region first. When the text is detected the editor **asks for the text first**, prefilled, before anything is replaced. On save the original run is **removed from the file** and the replacement is written as ordinary page text (see [Object-owned editing](#object-owned-editing--remove-dont-cover)); the block can be **dragged anywhere** on the page, merged into a paragraph, or threaded across frames and pages. **Edit Object** - pick an object already drawn on the page and move, resize, rotate, flip, fade, crop, replace or delete it. Objects are read from the file rather than guessed from pixels, so a page that looks flat still yields its separate objects - including a logo drawn inside a Form XObject, which is copied before it is edited so a form shared with other pages is left alone. A click picks the object painted on top; Alt+click steps down to the one underneath. A drag that encloses an object selects it whole, while a drag **inside** an image is **Area Direct Edit**: only the picture in the box is selected and white margins are trimmed off. *New layer* lifts that selection into its own real PDF layer with the white background removed, leaving a white fill in its place; *Keep area* crops the placement instead. A box over blank paper selects nothing. Plus redaction, headers/footers, watermarks, Bates numbering, page background. | Acrobat Pro / Nitro |
| **Organize** | Insert/delete/rotate/extract/reorder pages, merge documents, split, insert blank pages or pages from another PDF. | PDFelement / Nitro |
| **Forms** | Read & fill existing AcroForm fields, create new text/checkbox/radio/dropdown/signature fields, export values to JSON/CSV. | Acrobat / PDF‑XChange |
| **Protect** | **AES‑256 encryption** (user/owner passwords), granular permissions (print/copy/modify/annotate/fill), manual redaction marks + apply/sanitize, and remove security. | Acrobat / Nitro |
| **AI assistant** | Summarize, translate, proofread, rewrite selections, ask questions about the open document (or *all* open documents at once). Responses include navigable **`[p.N]` citations** that jump to and flash the referenced passage, plus **suggested follow‑up questions** under every answer. | Acrobat AI Assistant |
| **AI Smart Redact** | One‑click scan of the current page or the whole document for sensitive data — emails, phones, SSNs/national IDs, credit cards (Luhn‑validated), IBANs, IPs, dates of birth, labelled ID numbers, street addresses and person names. A review checklist (all/none, per‑item) creates redaction marks over every located hit; "Mark + Apply & Sanitize" finishes the job in one step. Runs offline with pattern matching alone; with an AI key it also catches names, addresses and contextual data. | Foxit Smart Redact / Redactable |
| **AI Contract Review** | Detects whether a document is an agreement, then reports parties, key terms (term, payment, renewal, termination, liability, governing law…), **risk flags** by severity (auto‑renewal, uncapped liability, unilateral clauses…), and "before you sign" action items — every finding cited with a clickable page jump. | Acrobat AI Contract Intelligence |
| **AI Document Outline** | Builds a hierarchical outline of the document with page references; every entry jumps to its page. | UPDF mind map |
| **Read aloud (TTS)** | Speaks your document from a floating player — **play/pause, stop, 0.5–2× speed and a live page indicator**. The local system voice works offline with no key; bring your own key for **ElevenLabs, Fish Audio, Mistral (Voxtral) or Google Gemini TTS** (or any OpenAI‑compatible `/audio/speech` endpoint). Selecting a provider auto‑fills its official base URL, **voices are fetched live with your key** ("Fetch voices"), and **Test voice** speaks a sample before you commit. Pages are split at sentence boundaries and read on with optional auto‑advance. | Acrobat Read Aloud / cloud TTS |

---

## Architecture

```
AiPDF Editor/
├── src/main/            Electron main process
│   ├── main.js         window, native menu, IPC handlers, headless test modes
│   ├── server.js       localhost static server (serves the renderer + pdf.js/pdf-lib assets over HTTP)
│   ├── preload.js      contextBridge → window.api
│   └── menu.js         native application menu
├── src/renderer/       Browser UI (native ES modules, no bundler)
│   ├── index.html
│   ├── css/app.css
│   └── js/             viewer, annots, pdfwrite, tools, textedit, stamps,
│                       sidebar, search, pages, forms, ai, store, app,
│                       stirling (Stirling-PDF pack: compress/flatten/…), …
└── scripts/            vendor check, fixtures, smoke + headless tests
```

**Why a local HTTP server?** The renderer is served over `http://127.0.0.1`
instead of `file://` so that native ES modules, `import.meta`, and the pdf.js
Web Worker all behave exactly like they do on the web — no CORS / opaque‑origin
surprises and no bundler step required.

**PDF engine**
- Rendering, text, outline, and annotation *reading*: **pdf.js** (`pdfjs-dist`).
- Annotation/appearance writing, text edits, encryption, page operations,
  forms: **`@cantoo/pdf-lib`** (a maintained fork of pdf-lib that adds
  AES‑256/RC4 encryption, which stock pdf-lib lacks).

The unified annotation model is stored in **PDF‑space coordinates**; an SVG
overlay is rendered on screen with affine transforms and converted back to PDF
space when the document is saved, so what you see is exactly what gets written.

**Security model**
- The renderer is sandboxed (Electron default), context-isolated, and the only
  bridge to Node is `preload.js` → `window.api`.
- The window can never navigate away from the app's own origin
  (`will-navigate` guard), so the bridge cannot be carried to another page;
  external links open in the OS browser only.
- File access is **grant‑based**: `fs:read`/`fs:write` only accept paths that
  came from a user gesture the main process saw — an open/save dialog, the
  command line or "open with", a recent-list entry, a drag & drop, or the
  app's own font/userData directories. A compromised renderer cannot silently
  read or write arbitrary locations. (Headless test/debug sessions
  `--remote-debugging-port`, `--*-test` bypass this: CDP already owns the
  renderer there.)
- The strict CSP allows only same-origin scripts (no inline script, no other
  localhost ports); WASM compilation is allowed for pdf.js/Tesseract.
- The AI / Read-Aloud proxy only fetches http(s) endpoints the user
  configured, and reads every response through a size cap (5–32 MB) so a
  hostile endpoint cannot exhaust memory.

---

## Object-owned editing — remove, don't cover

The **Direct Editor** (the "Edit Text" tool, renamed to match Acrobat's Edit PDF
model) is built on an **object-owned, story-based** engine. Three things are kept
separate, and that separation is what the whole design rests on:

```
ORIGINAL PDF   →   AUTHORING MODEL   →   LAYOUT MODEL   →   PDF WRITER
source objects,    stories, styled      wrapping,          remove owned sources,
text, fonts,       runs, confirmed      baselines,         insert replacements,
geometry,          source ownership,    placements,        regenerate, save
transforms         ordered frames       logical ranges,    candidate, reopen
                                        overset status
```

**1. Ownership is explicit.** Grouping a page's text produces *proposals*, each
carrying the source objects it would own. Nothing is owned until a commit records
it (`sourceRefs`). The writer may remove the owned sources and only those — so a
rect that merely grazes a neighbouring line cannot take it with it.

**2. A save removes, it does not cover.** On export the writer **deletes the owned
source operators** and inserts the replacement, so search, copy‑paste and a
screen reader in any reader agree with what is on screen. A white cover is *not*
a deletion: a screenshot looks right while the old, searchable words remain
extractable underneath. `scripts/truthful-save-test.mjs` proves the difference
with an independent extractor (pdf.js) — and asserts that a cover *would* fail
the same check.

A wash is now only a **fallback**, used when removal is genuinely impossible:
a recognised scan (the original is ink in an image) or text inside a shared
**Form XObject** (editing it in place would corrupt pages the user never opened).
The fallback is recorded on the edit as `removal: 'cover'`, never silent.

> This is still **not secure redaction.** A removed visible object does not prove
> every copy in attachments, metadata or unused resources is gone — use the
> Redact tool with Sanitize for confidentiality.

**3. Stories can thread frames.** An edit may carry an **ordered chain of
destination frames**, possibly on different pages. Text composes into frame 1 and
continues from the exact logical position into frame 2 — the frames are never
merged into one rectangle, because the area between them may hold an image or
another column. Anything that does not fit the last frame is **overset**:
reported, marked on the page, and never silently clipped.

A committed block is a free object:

- **Drag it anywhere** with the Select tool (or the Edit Text tool).
- **Double‑click it** (wherever it now sits) to type into it again — re‑editing
  keeps the dragged position instead of teleporting the block home.
- **Delete** (`Del`) restores the original: export always reconstructs from the
  original bytes, so removal is never cumulative and undo is exact.
- Move → save → move → save cannot leave ghost copies: every export rebuilds
  from the **original** bytes, so a previous replacement is never an input to
  the next one. Each drag also records the box it started from (last 8) so the
  app never offers your own past output back as an editable source block.

The text‑block panel exposes the three explicit actions the design calls for —
**Edit text** (a line), **Make paragraph with next block** (with an explicit
join: space / line break / nothing), and **Continue on next page** (link frames) —
plus a live composition readout of placed vs. overset characters.

**4. Tables are recognised, so a cell edit stays inside its cell.** Clicking text
inside a table edits the **cell**, not the block of text that happens to sit
there. Two detectors run and the more reliable one wins:

- **Ruled tables** are rebuilt from the page's own strokes (`source: 'rules'`),
  walked from the content stream with the same CTM tracking the excise path uses.
  A ruled table recovers **empty cells** too — exactly where you want to type.
- **Borderless tables** are inferred from text geometry (`source: 'text'`): rows
  from shared baselines, columns from gutters that **recur across rows**.

**One block per cell — even when the file says otherwise.** A producer may lay a
whole table row out inside a single text run, positioning each cell with `Td` and
gaps under 1.5em. Text grouping then sees one block per row, and clicking any cell
edited the entire row. The grid is authoritative, so blocks inside a table are
rebuilt from their own text items **per cell**: one block per cell, empty cells
stay empty, and ownership stops at the cell boundary — so editing one cell can no
longer take its neighbour with it.

It is deliberately conservative — two‑column prose, a single row, a caption and a
plain page border are all rejected, because a false table would silently scope an
edit to a rectangle that means nothing. The on‑page overlay labels each grid
(`Table 1 · R2C2 of 3×3`), and a cell too small for the replacement is reported as
**overset** rather than clipped. On save the cell's own text is excised and every
neighbouring cell survives — see `scripts/table-cell-test.mjs` (32 checks), which
asserts the saved file has the replacement, no `B2`, and `A1…C3`, `X1…Y2` intact.

**5. It asks for the text before replacing it.** When the text *is* detected there
is something concrete to confirm, so the editor shows it first — selected, and
labelled with where it came from (`Detected text on page 1, Table 1 · R2C2 of
3×3`) — and applies on Enter (Ctrl+Enter for multi‑line text). Cancelling leaves
the document completely untouched: no editor, no edit record. A block with no
detected text, and an edit you have already authored, go straight to the editor.

Verified by `scripts/story-test.mjs` (the authoring + layout model, 42 checks),
`scripts/truthful-save-test.mjs` (removal vs. covering, 14 checks),
`scripts/reflow-test.mjs` (the content‑stream primitive) and the `--parity-test`
suite (edit → save → reopen → the original is **gone**, the replacement is
present as real text, neighbouring text survives).

### Select & Hand — always available

Like Acrobat and Foxit, **Select** and **Hand** are never buried in a tool group.
They are reachable from four places at once: the **Edit menu** (`Edit ▸ Select Tool`
/ `Hand Tool`), the ribbon's Tools group, a persistent Select/Hand pair in the
**status bar** that works from every ribbon tab, and the keyboard.

- **Select** (`V`) selects objects and text.
- **Hand** pans the page. Even without switching to it, **hold `Space`** to
  grab‑pan from *any* tool — the page scrolls while your current tool stays armed.
  (A quick `Space` tap still pages forward, as before.)

The menu entries carry **no single‑letter accelerator** on purpose: the renderer
keymap owns bare letters (`V` = Select, `H` = Highlight), and a native accelerator
fires even while a text field has focus — it would steal the keystroke from the
find bar. `scripts/menu-test.mjs` fails the build if a bare‑letter accelerator is
ever added.

### Edits go to the object you actually selected

The properties panel always describes **the object that is selected right now**.
Switching tools drops the previous selection, so arming the Direct Editor (or any
drawing tool) shows that tool's own panel instead of the object you were editing a
moment ago — and a colour, font‑size, border or fill change lands on the current
selection, never on the previous one. While a Direct Editor session is open its
**Format** panel takes the panel over, so the controls act on the text you are
editing.

---

## Opening

The app **boots straight into the editor workspace** — ribbon, tabs, sidebars and
status bar are live from the first frame, with a compact empty‑workspace card on
the canvas offering *Open a PDF* / *Create blank PDF* / *Images → PDF*. There is no
landing page in the way; the full Welcome/Recent screen is still available from
**Help ▸ Start page** (`Ctrl+Shift+H`).

---

## Menu structure

The menu bar follows the de‑facto PDF editor standard used by Acrobat, Foxit,
Nitro and PDF‑XChange, and mirrors the ribbon modes so the two never disagree:

```
File · Edit · View · Comment · Edit PDF · Organize · Documents · Protect · Convert · Forms · AI · Window · Help
```

- **File** — New, Open, Recent, Save / Save As / Save a Copy, Create from
  Images, **Export ▸** (Text, Pages as Images, Comments), Print, Document
  Properties, Close, Exit.
- **Edit** — Undo/Redo, Cut/Copy/Paste, Select All, Find, Preferences.
- **View** — Zoom (In/Out, Actual Size, Fit Page, Fit Width, Reset), page
  layout (Single/Continuous/Facing), Rotate, Dark mode, Presentation,
  **Read This Page Aloud**, **Read Aloud Settings…**, panels.
- **Comment** — annotation & markup tools (Highlight…Redact, Stamp, Signature).
- **Edit PDF** — content modification (Edit Text, Whiteout, OCR, Watermark,
  Header & Footer, Bates numbering).
- **Organize** — page management (Insert, Extract, Delete, Rotate, Merge, Split).
- **Documents** — batch document tools (see below).
- **Forms**, **Protect** (AI Smart Redact, encrypt / redact), **AI** (Ask,
  Agent, Summarize, Extract Data, Translate, Rewrite, Proofread, **Contract
  Review**, **Document Outline**, Configure), **Window**, **Help**.

Standard accelerators are used throughout: `Ctrl+N/O/S/P/W`, `Ctrl+Shift+S`,
`Ctrl+Z` / `Ctrl+Shift+Z`, `Ctrl+F`, `Ctrl+D` (Document Properties),
`Ctrl+0/1` (fit page/width), `Ctrl+,` on macOS / `Ctrl+K` on Windows for
Preferences. Single‑key tool shortcuts (`V H U S Q N C T R O L A P E K I X`)
match Acrobat/Foxit muscle memory.

## Running

```bash
npm install        # also runs scripts/vendor.js to verify pdf.js / pdf-lib assets
npm start          # production‑like launch
npm run dev        # launch with DevTools + verbose console
```

### Launch flags

No flags are needed for normal use — `npm start` just works.

```bash
npm start              # normal launch — no flags needed
npm start -- --gpu     # opt into hardware acceleration (default is software)
npm start -- --no-sandbox   # run without the Chromium sandbox
npm start -- --trace   # write startup milestones to .smoke/launch-trace.txt
```

> **Startup robustness (two real failure modes, both fixed).**
> 1. *App never opened at all:* on some Windows hosts/VMs the sandboxed GPU
>    process dies with an access violation and Chromium aborts the whole app
>    ("GPU process isn't usable. Goodbye."). AiPDF disables **only** the GPU
>    sandbox at startup, keeping the renderer sandbox intact.
> 2. *App ran but no window appeared:* the window used to be revealed solely on
>    `ready-to-show`, which waits for the compositor's first paint. When the GPU
>    process stalls that event never fires, leaving the window hidden forever.
>    The window is now revealed via `ready-to-show` (fast path) with guaranteed
>    fallbacks on `did-finish-load` and a hard timeout.
>
> Because pdf.js draws through canvas 2D (CPU) anyway, AiPDF defaults to
> software rendering — use `--gpu` if you prefer hardware acceleration.

> When developing, never launch with `ELECTRON_RUN_AS_NODE=1` set — that makes
> `require('electron')` return the Node binding instead of the app API and breaks
> IPC. The launch commands above strip it automatically.

---

## Building a Windows installer

```bash
npm run dist        # electron-builder --win  →  AiPDF-Editor-<version>-setup.exe
```

The `build` block in `package.json` produces a per‑machine NSIS installer with
a choose‑install‑directory prompt and a desktop shortcut. `node_modules` is
automatically pruned of dev dependencies.

---

## AI assistant setup (bring‑your‑own‑key)

Open **AI ▸ Configure** (or the AI chip in the title bar). The provider layer is
fully **OpenAI‑compatible** and standard:

| Setting | What it does |
| --- | --- |
| **Base URL** | Any OpenAI‑compatible endpoint, e.g. `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, `https://api.groq.com/openai/v1`, `http://localhost:11434/v1`. `/chat/completions` and `/models` are appended automatically. |
| **API key** | Sent per the **Send key as** scheme below. Stored locally in the app settings file. |
| **Model** | Free text **or** pick from a fetched list. |
| **Fetch models** | Calls `GET /models` on the endpoint and fills the model dropdown — works with OpenAI, Gemini, Groq, Together, OpenRouter, DeepSeek, Ollama, LM Studio, … |
| **Send key as** | `Authorization: Bearer` (OpenAI and most providers), `x-goog-api-key` (Google Gemini), `x-api-key`, `api-key` (Azure OpenAI), a **custom header name**, or **None** for local servers. |
| **Custom headers** | Arbitrary name/value headers sent with every request (e.g. OpenRouter `HTTP-Referer` / `X-Title`). Rows can be enabled/disabled individually. |
| **Smart Context** | Ranks every page by relevance to your question and sends only the best‑matching pages (plus the current page) within the character budget, instead of a flat prefix. Toggle in the settings dialog or the dock chip. |
| **Context budget / Max pages / Temperature** | Bounds on how much document text is sent and how creative the model is. |
| **Test connection** | Sends a one‑line round trip so you can confirm the URL, key and headers before asking a real question. |

Presets are provided for **OpenAI, Google Gemini (native API), OpenRouter, Groq,
Together AI, DeepSeek, Mistral, Ollama (local)** and **LM Studio (local)**, plus
a generic **Custom (OpenAI‑compatible)** entry. The **Google Gemini** preset
speaks the native Generative Language API (`generateContent`,
`x-goog-api-key`, Gemini tool calling and vision) — everything else uses the
OpenAI‑compatible surface. Requests are proxied through the **main process**
(not the renderer), so there are no browser CORS restrictions and custom
headers are honoured for any endpoint. The assistant sends only the text of the
pages you ask about to the endpoint you configure; citations in the reply
(`[p.3]`) are clickable and scroll to + flash the matching snippet.

---

## AI Agent mode (the AI edits the PDF for you)

Toggle **Ask ⇄ Agent** at the bottom of the AI dock (or **AI ▸ AI Agent — Edit
this PDF…**, `Ctrl+Shift+E`). In Agent mode the model stops merely answering and
becomes a tool‑using bot that **reads, searches, OCRs and edits the open
document directly**, planning and calling tools until the task is done:

| Tool | What it does |
| --- | --- |
| `list_pages` | Page count, page sizes in pt, which pages are scans |
| `read_page` / `search_document` | Read a page's text layer / find pages containing a term |
| `ocr_page` | OCR a scanned page with the configured engine (AI vision or Tesseract) |
| `view_page` | Look at a page as an image with the model's vision |
| `add_text` / `add_textbox` / `add_note` | Write new text at a position, boxed text, sticky notes |
| `replace_text` | Find exact text on a page and replace it (white‑out + redraw) |
| `add_highlight` / `add_shape` / `add_redaction` | Highlight by search term, draw shapes, mark redactions |
| `rotate_pages` / `delete_pages` / `insert_blank_page` | Organize pages |
| `set_metadata` | Title / author / subject / keywords |
| `done` | Report what was changed, with page citations |

Every mutation goes through the same document model as manual editing: edits
render immediately, are individually **undoable** (Ctrl+Z, plus an "Undo all"
chip on the agent's final card), and save exactly like hand edits. Tool calls
show as compact cards in the dock while the agent works. Works over both
protocols — Gemini native tool calling and OpenAI function calling.

---

## OCR — three engines behind one button

The OCR panel (sidebar ▸ OCR) picks an engine per run:

- **Hybrid** (default) — AI vision when a provider is configured, local
  Tesseract otherwise, with automatic fallback to Tesseract if the AI call
  fails.
- **AI vision** — the page is rendered at high DPI and transcribed by the
  configured vision model (Gemini or any OpenAI‑compatible provider). Best for
  low‑quality scans, handwriting, tables and non‑Latin scripts. Uses the same
  provider stack: base URL, API key, auth scheme, custom headers, fetched
  model. An optional **language hint** (e.g. "Nepali + English") steers it.
- **Local Tesseract** — fully offline (English, Hindi, Nepali, mixed pairs).

Offline means offline: the Tesseract worker, its WASM core and the
`eng`/`hin`/`nep`/`osd` language packs all ship inside the installer. The core
is served from `/v/tesscore/` (kept unpacked from the asar so the worker can
`importScripts` it) and the packs from `/v/tessdata/`, which electron-builder
copies to `resources/tessdata` via `extraResources`. No CDN is contacted unless
you pick a language that is not bundled — those fall back to the CDN and are
cached in IndexedDB.

If a build ever ships incomplete OCR files the panel says so explicitly by
name ("The bundled offline OCR files are missing…") instead of failing deep
inside the worker with a bare `importScripts` NetworkError: the local server
reports where the assets actually resolved over `GET /__ocr-health`, and the
renderer checks it before starting a worker. Run
`node scripts/ocr-server-test.mjs` to verify both the dev and the packaged
asset layouts without launching the app.

Results land in the same store either way, so search, Ask‑AI citations and the
Agent all work on scanned pages after OCR.

---

## Documents — batch document tools

Twenty tools that act on a whole document rather than one page. They live in
the menu bar (**Documents**) and the command palette (`Ctrl+K` ▸ *Documents*).
The original five push into the same rebuild pipeline that Save uses; the
fifteen Stirling-PDF ports (v2.8) follow the same rule — so what you see in
the dialog is exactly what lands in the file.

| Tool | What it does |
| --- | --- |
| **Compare with Another PDF…** | Diffs the open document's text against a second file, page by page. A modal lists *N pages · M changed · K identical*, chips the `+added / −removed` line and word counts, a *Show changed pages only* filter, a jump-to-page button per row, and **Copy report** for a plain-text digest. Nothing is written — comparison is read-only. |
| **Overlay PDF…** | Stamps every page of a second PDF over (or under) the current one, with a page range, x/y offset, scale and opacity. Under this run it adds a new rebuild op, so the original pages (and their annotations) survive; the result stays a real PDF you can keep editing. |
| **Scale Pages…** | Resizes a page *range* by a percentage. Implemented by copying the page and letting pdf-lib's `page.scale()` resize it, which keeps text selectable and carries `/Annots`, `/Rotate` and inherited `/Resources` over — so comments and widgets stay where they were. |
| **Remove Blank Pages…** | Detects pages with no meaningful content and drops them in one pass. Refuses to empty the document, leaves non-page ops (inserted blanks, inserted files) untouched, and reports how many pages went away. |
| **Adjust Colors…** | Rasterises the selected pages through a canvas filter — grayscale, invert, brightness/contrast, and the rest of the preset list — and re-embeds them as image pages with a chosen DPI. |
| **Compress…** *(Stirling port)* | Re-renders pages at 72–300 DPI with 30–95% JPEG quality (Web / Balanced / Print / Grayscale / Scan presets), optionally stripping metadata. Fixes a real bug found while porting: the JPEG quality was silently dropped on the filtered path, so compressed pages never shrank. |
| **Flatten Annotations…** *(Stirling port)* | Burns annotations and (optionally) form values into page content — `form.flatten()` plus rasterisation of annotated pages. |
| **Sanitize…** *(Stirling port)* | Strips attachments, metadata, form values and embedded JavaScript (`/OpenAction`, `/AA`, `/Names/JavaScript`) and rebuilds the file. |
| **Document Information…** *(Stirling “Get All Info”)* | Version, page sizes, counts, metadata, encryption state in one modal. |
| **Remove Annotations…** *(Stirling port)* | Bulk-deletes annotations by type, with per-type counts. |
| **Multi-Page Layout (N-up)…** *(Stirling port)* | Tiles 2/4/6/9/16 pages per sheet via raster composition (never `embedPdf`, for the reasons below). |
| **Join into Single Page…** *(Stirling “To Single Page”)* | Stacks all pages into one long strip. |
| **Poster Tiles…** *(Stirling port)* | Splits the current page into cols×rows tiles, one output page each. |
| **Booklet Imposition…** *(Stirling port)* | Reorders pages into folded sheets (padded to a multiple of 4, blanks reported). |
| **Add Page Numbers…** *(Stirling port)* | `1 / N`, `Page 1 of N`, roman numerals — written as real selectable text stamps. |
| **Split by Size…** *(Stirling port)* | Chunks the document into ~N MB files using average bytes/page. |
| **Auto-Rename…** *(Stirling port)* | Suggests a filename from title metadata, else the first text line. |
| **Repair…** *(Stirling port)* | Header/trailer/object health check, then rebuild-by-`copyPages`, skipping unreadable pages and reporting what survived. |
| **Manage Attachments…** *(Stirling port)* | Add / extract / remove embedded files (the model already round-trips them through save). |
| **Automate (Pipeline)…** *(Stirling Automate)* | Runs ticked tools in one pass — sanitize, remove-blanks, compress, grayscale, flatten — then rebuilds once. |

> Raster-based tools (Compress, N-up, poster, booklet, single-strip, Flatten,
> Adjust Colors) re-render pages as images: text on rebuilt pages becomes
> non-selectable. Vector-safe tools (Scale, page numbers, sanitize, repair)
> keep everything selectable. Every dialog says which one it is.

### Why the scaling op is not a Form XObject

The obvious way to scale a PDF page is `embedPdf()` + `drawPage()`. It is a trap
here, and it cost real debugging time, so it is worth writing down:

1. `embedPdf()` fails **lazily**. It resolves its promise immediately and only
   throws when the document is serialised, so a `try/catch` around the `await`
   cannot see the error. The failure surfaces inside `save()`, where it aborts
   the entire build — the user loses the whole save, not one page.
2. It rejects any page whose dictionary has no `/Contents`. Absent `/Contents`
   is *legal* PDF — it means an empty page — and documents full of such pages
   are common enough (scans, generated files) that this is not an edge case.
3. Re-embedding as a Form XObject silently drops `/Annots` and `/Rotate`, so
   comments and rotated pages change appearance.

`copyPages()` + `page.scale()` has none of those properties: it cannot throw
lazily, a content-less page is simply a blank page (`scaleContent()` is a no-op
on it), and the copy keeps annotations, rotation and inherited resources.

---

## Testing

Headless, assertion‑based checks (no display required):

```bash
node scripts/smoke-pdf.mjs            # Node: pdf-lib ops (annot AP, encrypt AES-256, page ops, forms)
node scripts/reflow-test.mjs          # Node: content-stream text engine (walk/group/excise primitives)
node scripts/make-fixtures.mjs        # regenerate the test fixture PDF

# Tables (detection + cell-scoped editing):
npm run test:tables                   # Node: detector unit suite (31) + real fixture (24) + cell split (19)
npm run test:table-ui                 # real app: ask-for-text, cell-scoped editor, truthful cell save (44)
node scripts/make-table-fixture.mjs   # regenerate the ruled 3x3 + borderless 2x2 fixture

# Inside the real Electron app (renderer + main IPC):
npm start -- --boot-test             # clean boot, zero renderer errors
npm start -- --functional-test ".fixtures/fixture.pdf"   # view pipeline
npm start -- --edit-test ".fixtures/fixture.pdf"         # edit → save → reopen
npm start -- --ai-test               # AI provider layer (auth, headers, models, smart context, Gemini protocol)
npm start -- --agent-test            # agent tool registry, page-range parsing, schema shape

# Launch integrity (needs a desktop session):
node scripts/launch-test.mjs         # the app actually OPENS: a visible window, rAF firing, renderer booted
node scripts/ui-shot.mjs             # real screenshots of both themes into .smoke/

# OCR (offline engine):
npm run test:ocr                     # real app: image-only page → Recognize → edit → saved file searchable (16 checks)
npm run test:ocr-server              # node: every OCR asset resolves in the dev AND the packaged layout (17 checks)
AIPDF_TARGET=packaged npm run test:ocr-packaged   # the built app: same, against the real installer tree (12 checks)

# Documents menu (Compare / Overlay / Scale / Remove Blank Pages / Adjust Colors + 15 Stirling ports):
npm run test:tools                   # node: the pure engines — compare.js diff maths, docxtools.js ops (37 checks)
npm run test:stirling                # node: stirling.js planners — compress/flatten/sanitize/N-up/booklet/… (28 checks)
npm run test:overlay                 # node: two real PDFs through buildPdf → verified with pdf.js (9 checks)
npm run test:doctools                # real app over CDP: all five tools end-to-end, incl. save → reopen (13 checks)

# Edit Object tool (objects on the page, read from the file — not from pixels):
node scripts/image-objects-test.mjs  # node: the core — containers, inline images, paint order (76 checks)
node scripts/image-pdf-test.mjs      # node: the adapter — save/reopen, shared forms copied, not mutated (25 checks)
npm run test:image                   # real app: select, move, resize, rotate, fade, crop, replace, delete (22 checks)
npm run test:imagemarquee            # real app: a drag is a marquee, a press is a click (9 checks)
npm run test:flatobject              # real app: a flat-looking page — paint order, a logo inside a form (12 checks)
```

Each app mode prints a `BOOT_TEST` / `FUNC_TEST` / `EDIT_TEST` / `AI_TEST` JSON
line and an error count, then quits. `--ai-test` is a pure‑logic check (no
network): it verifies the auth‑header mapping for every scheme, custom‑header
inclusion/omission, endpoint construction, `/models` parsing and Smart Context
relevance ranking. Together these are the CI gate for this project.

`launch-test.mjs` exists because `--boot-test` cannot see the worst failure mode
this app has had: a window that is created and whose renderer boots perfectly
while remaining **invisible**, because `ready-to-show` never fired. `__aipdfBooted`
is set by JavaScript alone and needs no painted frame, so the boot test passes
while the user sees nothing. `launch-test.mjs` asserts a real visible top‑level
window (via `scripts/win-visible.ps1`) and that `requestAnimationFrame` fires.

---

## Project status

- View, comment, edit, organize, forms, protect, and AI pipelines are
  implemented and verified end‑to‑end via the headless tests above.
- Known environment caveat: the WebGL/pdf.js GPU path is disabled by default on
  some VMs; software rendering is used and works correctly.
