# AiPDF Editor — Competitive Research & Feature Integration Plan

**Prepared:** 7 November 2026 · **Scope:** Windows desktop PDF editors, 2025–2026 capabilities · **App under review:** AiPDF Editor v2.26.0 (Electron + pdf.js + pdf-lib) · **Status:** §5 shipped in v2.25.0, extended in v2.26.0

---

## 1. Executive summary

The commodity layer of PDF editing (view, annotate, merge, split, OCR, convert, sign) is **saturated**. Every serious Windows editor has it, and AiPDF Editor already has essentially all of it — plus a genuinely unusual amount of AI depth (cited Q&A, a tool-using agent, verified edit plans, contract review, smart redaction, PDF→Word via native PDF pages, read-aloud, and a batch pipeline engine).

The 2025–26 competitive frontier has moved to five places:

1. **Grounded / cited AI** — answers that link back to the exact passage (Adobe, Foxit).
2. **Where inference runs** — on-device vs cloud, and the privacy contract that follows (Foxit Local AI, ABBYY).
3. **Agent interoperability** — exposing the editor's tool surface to external LLMs via MCP (Bluebeam Max).
4. **Automatic accessibility / PDF-UA remediation** — still a cloud API, not a desktop feature (Adobe Auto-Tag API).
5. **Document forensics** — inspecting a PDF for hidden data, embedded actions and *redaction-surviving content* (Foxit PDF Action Inspector).

AiPDF Editor is already strong on #1 and, being local-first by architecture, well positioned on #2. **The biggest winnable gaps for a local Electron app are #4, #5, and a verifiable no-upload trust story** — all three are implementable offline with no backend. That is what this upgrade integrates.

---

## 2. What AiPDF Editor already has (audit of `src/renderer/js/`)

| Area | Already shipped |
|---|---|
| Viewing | pdf.js rendering, 6 page layouts (single/continuous/facing/cover/reverse/grid), zoom + Ctrl-wheel, rulers, guides, thumbnails, presentation mode, dark/light + system themes, density modes |
| Editing | **Object-owned "truthful save" Direct Editor** with operator-level excision, glyph-precise Area Direct Edit, paragraph reflow, table/cell recognition and per-cell editing, native content-stream image-object editing (move/resize/rotate/flip/crop/replace), 35 tools |
| Annotations | Full markup/drawing set, comments panel, stamps, watermark, header/footer, Bates numbering, signatures, forms (AcroForm), links, layers/OCG |
| Pages | Insert/delete/rotate/extract/merge/split/duplicate/replace/crop/reorder, split by bookmarks/blank pages, structural undo |
| AI | BYO-key multi-provider dock, **citation-linked answers**, agent mode, verified plan→approve editing, contract intelligence, smart redact + PII/Luhn detection, redaction-integrity proof, outline, data extraction, translate/rewrite/proofread |
| OCR / TTS | Tesseract (local) + AI-vision + hybrid, scanned-page detection, region OCR; multi-provider read-aloud |
| Documents | Compare, overlay, compress, flatten, sanitize, N-up, booklet, poster, page numbers, split by size, auto-rename, repair, attachments, **automation pipeline** |
| Convert | PDF→Word (real DOCX), HTML, RTF, EPUB, Markdown, text, images |
| UX | Tabbed documents, 10 contextual ribbon tabs, command palette with fuzzy ranking + recents, quick-access pinning, welcome/recents, status bar, shortcut cheatsheet, focus-visible rings, dialog focus trap |

**Verdict:** the app is not feature-poor. A credible upgrade must add *new categories*, not more buttons in existing ones.

---

## 3. Top 10 Windows PDF editors — standout, cutting-edge features

Ranked by market weight + differentiation. `[LOCAL]` / `[CLOUD]` / `[HYBRID]` marks where the capability actually runs.

### 1. Adobe — Acrobat Pro / **Acrobat Studio** (Aug 2025, ~$24.99/mo)
- **Citation-linked, source-grounded AI answers** — every AI response cites back to the source passage; the reference implementation of verifiable document RAG. `[CLOUD]` · [Adobe](https://www.adobe.com/acrobat/generative-ai-pdf.html)
- **PDF Spaces** — shared multi-document corpus → audio overviews, visual reports, presentations, *plus engagement analytics*. No competitor matches deliverable-generation + audience telemetry. `[CLOUD]` · [Adobe Studio](https://www.adobe.com/au/acrobat/acrobat-studio.html)
- **Agentic natural-language execution** — "edit, sign, redact and compress your docs" by instruction. `[HYBRID]`
- **AI Auto-Tag API** — automatic table/heading tagging for screen readers, paired with a desktop Create-and-Verify accessibility checker. `[HYBRID]` · [API](https://developer.adobe.com/document-services/apis/pdf-accessibility-auto-tag/)

### 2. Foxit — **PDF Editor Suite Pro / PDF Editor+** (v2026)
- **Local AI via Microsoft Foundry Local** — on-device inference, fully offline, zero credits, in paid *and free Reader*. The only vendor with an explicit local-AI capability matrix (Q&A, summarise, AI Bookmark, translation offline; edit-by-chat, formula recognition, podcasts, MCP/Skills cloud-only). `[LOCAL]` · [Foxit Local AI](https://www.foxit.com/ai/local-ai/)
- **Bring Your Own Model** — point the client at any OpenAI-compatible endpoint you control. `[HYBRID]`
- **PDF Action Inspector** — scans incoming PDFs for embedded JavaScript, **hidden data surviving redaction**, and print-vs-screen discrepancies before you sign/redact/print. A genuine security differentiator. `[LOCAL]` · [Foxit AI](https://www.foxit.com/ai/pdf-ai-assistant/)
- **Edit-by-chat with cited answers + reusable custom "Skills"**, AI Bookmark, formula→MathML/LaTeX, chat-with-charts. `[CLOUD]`

### 3. Nitro — **Nitro PDF Pro v26** (~$250 perpetual, Windows-only)
- **Smart Tools tab** — unified surface for form extraction, smart redact and PDF chat; rebuilt OCR/compression/Office conversion. `[CLOUD]`
- **Perpetual, no-subscription licence** — the clearest commercial anti-SaaS stance. `[LOCAL]`
- **Multi-PDF Bates numbering** and 80+ language Q&A for legal workflows. `[LOCAL]`/`[CLOUD]`

### 4. Tracker Software — **PDF-XChange Editor** (build 11.1, Sep 2026)
- **Wizard-driven recorded action sequences + JavaScript API** — the most scriptable *offline* batch automation in the market. `[LOCAL]` · [PDF-Tools](https://www.pdf-xchange.com/product/pdf-tools)
- **Fully offline toolchain**: Tesseract OCR, digital signatures, PDF/A validation, Brotli compression, group-policy deployment. `[LOCAL]`
- **No AI layer at all**, deliberately — a direct opening for a local-first app.
- Smallest footprint / fastest cold start among full editors.

### 5. Bluebeam — **Revu / Bluebeam Max** (2026, ~$590/user/yr)
- **MCP-native PDF client** — connect Revu to Claude, GitHub Copilot, AnythingLLM; prompts create/update markups and custom columns. The only MCP-native PDF editor in the market. `[HYBRID]` · [Bluebeam Max](https://www.bluebeam.com/bluebeam-max)
- **Smart Review / Smart Overlay** — computer vision finds missing sheets, missing tags, gridline inconsistencies; surfaces AI markups + dashboards; overlays detect cross-discipline design changes. `[CLOUD]`
- **Stitching** — auto-combines drawing sheets into one navigable view; **Magic Markups** with CAD-precision duplicate/offset. `[HYBRID]`
- **AEC takeoff & measurement** (scale, length, poly-length, area → quantities) and real-time Studio Sessions. `[LOCAL]`/`[CLOUD]`
- Publishes an [AI Transparency page](https://www.bluebeam.com/company/ai-transparency/) — unusually candid.

### 6. ABBYY — **FineReader PDF 16**
- **Layout-preserving OCR → editable paragraphs and table cells**, 190+ languages, "edit PDFs almost like Word". The conversion-fidelity benchmark. `[LOCAL]` · [ABBYY](https://pdf.abbyy.com/finereader-pdf/)
- **First-class document comparison** including scanned originals. `[LOCAL]`
- **Hot Folder / scheduled batch conversion**, automated deployment (Corporate). `[LOCAL]`
- **Entire engine runs on-device** — proof that high-end document AI need not be cloud. `[LOCAL]`

### 7. Wondershare — **PDFelement** (V12, ~$139.99 perpetual)
- **AI knowledge base + contract key-clause insights** (marketing-level on the EN page; verifiable tools are AI Grammar Checker and AI Smart Redact). `[CLOUD]` · [PDFelement](https://pdf.wondershare.com/pdfelement/)
- **Batch tasks**, and V12 added **batch signing, batch crop, smart workspace, domain-specific translation** (CN release notes — treat as secondary-sourced). `[HYBRID]`
- Perpetual licence at roughly half Acrobat's cost, cross-platform. `[HYBRID]`

### 8. Superace — **UPDF 3.0** (AI add-on ~$29/quarter)
- **Dual-model reasoning: GPT-5 + full DeepSeek R1** with an explicit "DeepThink" toggle, plus AI Paper/Scholar Search. Rare model-choice UX. `[CLOUD]` · [UPDF AI](https://ai.updf.com/)
- **PDF → mind map saved *into the PDF*** and shareable by link — structural output embedded in the document, not a sidecar. `[CLOUD]` · [Mind Maps](https://ai.updf.com/features/pdf-to-mind-maps)
- **Multimodal chat with images/charts**, full-document layout-preserving translation. `[CLOUD]`
- AI sold as a **separate paid add-on with hard cloud quotas** — a monetisation pattern, and a weakness for local-first buyers.

### 9. PDFgear — **PDFgear for Windows** (free, no signup)
- **Completely free, no account, offline-capable desktop editor** with Word-like editing, OCR (30+ langs), batch conversion and signing. `[LOCAL]` · [PDFgear](https://www.pdfgear.com/)
- **PDFgear Copilot** — chat/summarise/rewrite/translate with a built-in LLM; proves a no-login Windows editor can ship AI and gain distribution. `[CLOUD]` · [Copilot](https://www.pdfgear.com/pdf-copilot/)
- Its AI is cloud — the local-AI slot stays open.

### 10. Drawboard — **Drawboard PDF** (Windows, subscription)
- **Pressure-sensitive ink engine with shape recognition and a calligraphy pen** — best-in-class stylus feel on Windows/Surface, essentially unmatched by Adobe/Foxit/Nitro. `[LOCAL]`
- **Live multi-user markup across devices** plus a full measurement suite (scale, length, poly-length, area). `[CLOUD]`/`[LOCAL]`
- Templates, calibration, OCR, redaction for field review. `[LOCAL]`

**Considered, dropped:** Tungsten Power PDF (no differentiating 2025–26 AI), Smallpdf/Xodo/Sejda/Soda (web-first), PDF24 Creator (free offline toolbox, not an editor), SumatraPDF (viewer), Okular (Linux-first), **Stirling-PDF** (self-hosted, ~67k stars, purest no-upload exemplar but browser-based). These matter mainly as evidence of demand for offline/no-upload processing.

---

## 4. Consolidated cutting-edge feature catalogue (37 features)

`[L]` = implementable in a local Electron app without a backend · `[C]` = needs cloud/LLM · `[H]` = hybrid.

### AI & reasoning
| # | Feature | Where | Feas. |
|---|---|---|---|
| 1 | Citation/source-linked answers grounded in the exact page | Adobe, Foxit | `[C]` / already in AiPDF |
| 2 | On-device local LLM inference, offline, no credits (Foundry Local + BYO endpoint) | Foxit | `[L]` |
| 3 | MCP-native PDF client — external LLMs create/update markups | Bluebeam Max | `[C]`/`[H]` |
| 4 | Agentic natural-language task execution | Adobe, Foxit | `[C]` / already in AiPDF |
| 5 | Multi-document "space" → reports, slides, diagrams, audio + analytics | Adobe, Foxit, PDFelement | `[C]` |
| 6 | Audio/podcast overviews and Read-Aloud | Adobe, Foxit, UPDF | `[C]` / TTS already in AiPDF |
| 7 | Model-selectable deep reasoning + AI paper search | UPDF | `[C]` |
| 8 | PDF → mind map embedded in the document | UPDF | `[C]` |
| 9 | AI Bookmark / auto-structured bookmarks (local-capable) | Foxit | `[L]` |
| 10 | Formula → MathML/LaTeX, chat-with-charts | Foxit, UPDF | `[C]` |
| 11 | Freemium AI with hard quotas / credit pools | Foxit, UPDF, PDFgear | `[C]` |
| 12 | Custom reusable AI "Skills" / macro prompts | Foxit | `[C]` |

### Editing fidelity
| 13 | Layout-preserving OCR → editable paragraphs/tables | ABBYY | `[L]` |
| 14 | True in-place paragraph reflow on scanned PDFs | ABBYY, PDF-XChange | `[L]` / AiPDF partial |
| 15 | Pressure-sensitive ink + shape recognition / calligraphy | Drawboard | `[L]` |
| 16 | CAD-precision markup duplicate/offset/convert | Bluebeam | `[L]` |

### Automation / batch
| 17 | Recorded action-sequence batch wizard + JS automation API | PDF-XChange | `[L]` / AiPDF has pipeline |
| 18 | Hot Folder / watched-folder scheduled batch | ABBYY | `[L]` |
| 19 | Batch Bates, signing, crop, conversion | Nitro, PDFelement, PDFgear | `[L]` / AiPDF partial |
| 20 | AI-agnostic local automation pipeline with open API | Stirling-PDF | `[L]` / already in AiPDF |

### Collaboration / review
| 21 | Real-time multi-user Studio/Session markup | Bluebeam, Drawboard | `[C]` |
| 22 | Document comparison + visual overlay of versions | ABBYY, Nitro, Bluebeam | `[L]` / already in AiPDF |
| 23 | Computer-vision design-issue detection as markups | Bluebeam | `[C]` |
| 24 | 2D markup ↔ BIM/Revit, drawing-sheet stitching | Bluebeam | `[C]` |
| 25 | Markup-to-field-task linking, NL search across project folders | Bluebeam | `[C]` |
| 26 | AEC measurement / takeoff → quantities | Bluebeam, Drawboard | `[L]` / AiPDF has measure tools |

### Security / compliance / accessibility
| 27 | **PDF Action Inspector** — embedded JS, redaction-surviving hidden data, print-vs-screen mismatch | Foxit | `[L]` |
| 28 | **AI auto-tagging + PDF/UA / Section 508 remediation** | Adobe API, PDFxt | `[H]` / `[L]` checker |
| 29 | AI Smart Redact / PII pattern redaction | Foxit, Nitro, PDFelement | `[L]` / already in AiPDF |
| 30 | Digital signatures, PAdES/LTV, PDF/A validation, AES, group policy | PDF-XChange, ABBYY | `[L]` / partial in AiPDF |
| 31 | **Provable no-upload / air-gapped operation with no telemetry contract** | Foxit Local AI, Stirling | `[L]` |
| 32 | **Multi-version local snapshot history with restore** | (gap — only 1-level `.bak` everywhere) | `[L]` |

### Conversion & extraction
| 33 | High-fidelity table/form extraction and PDF↔Office | ABBYY, Nitro | `[L]` / AiPDF strong |
| 34 | Multimodal image/chart Q&A | Foxit, UPDF | `[C]` / AiPDF vision OCR |
| 35 | Full-document layout-preserving side-by-side translation | Foxit, UPDF | `[C]` / AiPDF translate |

### UX / productivity
| 36 | Perpetual licence, portable, sub-second startup | PDF-XChange, Nitro | product decision |
| 37 | Smart/unified AI command surface, template/stylus-first canvas | Nitro, Drawboard | `[L]` / AiPDF palette |

**Split:** ~20 of 37 are `[L]` — everything in editing fidelity, automation, security/compliance, measurement, conversion and UX. Nearly every `[C]` item is an LLM-mediated *reasoning/generation* layer; the document operations underneath (redaction, OCR, tagging, comparison) are perfectly local.

---

## 5. Gap analysis — what this upgrade actually adds

| Competitive feature | AiPDF before | Action taken |
|---|---|---|
| PDF Action Inspector / document forensics | ❌ none | ✅ **NEW** — `forensics.js` + Security Inspector panel |
| Redaction-leak detection via incremental-update history | ❌ none | ✅ **NEW** — byte-level `%%EOF` / `startxref` history scan |
| PDF/UA & WCAG accessibility checker | ❌ none | ✅ **NEW** — `auditAccessibility()` + checker panel with auto-fix |
| Verifiable local-first trust story / egress ledger | partial (consent gate only) | ✅ **NEW** — Trust Center + audit ledger + `window.aipdf` agent API |
| Multi-version local history | 1-level `.bak` only | ✅ **NEW** — IndexedDB Version Timeline, auto + manual checkpoints, restore |
| Premium visual system | cream/gold, low contrast, cramped | ✅ **REDESIGNED** — `premium.css` design system, light/dark/high-contrast skins |
| Focus / distraction-free reading mode | chrome-hidden only | ✅ **NEW** — Focus mode + high-contrast theme, palette-driven |
| Command palette with grouped recents, hints | present, plain | ✅ **UPGRADED** — visual polish, footer hints, category icons |
| Welcome / empty state | plain card | ✅ **REDESIGNED** — hero, trust strip, keyboard hints, feature grid |

### Deliberately **not** implemented in this pass (with reasons)

| Feature | Why deferred |
|---|---|
| On-device LLM inference (Foundry Local / bundled small VLM) | Requires shipping a multi-GB model + native runtime; a product/packaging decision, not a code patch. AiPDF already supports **BYO local endpoint** (Ollama / LM Studio providers) which is the 80% solution offline. |
| Full MCP server | Needs a main-process transport + auth surface; `window.aipdf` command API shipped here is the groundwork and is CDP-drivable today. |
| Real-time multi-user sessions / PDF Spaces / engagement analytics | Requires a backend and accounts — contradicts the local-first architecture. |
| CV-based design-issue detection (AEC) | Domain-specific model; out of scope for a general editor. |
| Pressure-sensitive ink + shape recognition | Feasible, but touches the pointer-event core in `tools.js` (highest regression risk in the app). Slated as a focused follow-up. |
| Hot Folder / watched-folder batch | Needs a main-process `fs.watch` IPC channel and a scheduler. Follow-up. |
| Embedded mind map / audio overviews | Cloud-generation features; low value offline. |

---

## 6. Market gaps AiPDF Editor is positioned to own

1. **Local AI without a vendor-shaped compromise.** Foxit closed the basic offline Q&A slot in July 2026, but its edit-by-chat, formula recognition, podcasts and Skills remain cloud-only. Nobody offers offline *agentic* editing.
2. **Verifiable, auditable AI with zero telemetry.** Adobe and Foxit promise citations, but both are cloud. A local app can make every answer deterministically traceable to a page/quad, with a local audit log and no DPA — the strongest story for legal, healthcare and sealed filings.
3. **"No subscription, no account, no cloud"** — PDF-XChange/Nitro prove perpetual demand, PDFgear proves free-no-login distribution, Stirling-PDF proves hunger for no-upload tooling. No product combines all three with a modern Electron UI.
4. **Offline PDF/UA accessibility remediation** — Adobe's auto-tag is still an API; specialists are web platforms. A desktop offline checker + repair is unserved and compliance-driven.
5. **General-purpose agent-ready PDF** — Bluebeam Max is the only MCP-native client and is locked to AEC at $590/yr. A horizontal "agent-ready" Windows PDF editor has no incumbent.

---

## 7. Sources

Official vendor pages used for primary claims, inline above. Key references:

- Adobe — [Generative AI in Acrobat](https://www.adobe.com/acrobat/generative-ai-pdf.html), [Acrobat Studio](https://www.adobe.com/au/acrobat/acrobat-studio.html), [Accessibility Auto-Tag API](https://developer.adobe.com/document-services/apis/pdf-accessibility-auto-tag/), [Create and Verify Accessibility](https://helpx.adobe.com/be_en/acrobat/using/create-verify-pdf-accessibility.html)
- Foxit — [Local AI](https://www.foxit.com/ai/local-ai/), [PDF AI Assistant](https://www.foxit.com/ai/pdf-ai-assistant/), [Workspace](https://www.foxit.com/ai/workspace/)
- Bluebeam — [Bluebeam Max](https://www.bluebeam.com/bluebeam-max), [AI Transparency](https://www.bluebeam.com/company/ai-transparency/), [Firmus AI acquisition](https://press.bluebeam.com/2025/09/bluebeam-acquires-firmus-ai-to-accelerate-intelligence-for-drawing-reviews-and-financial-risk-mitigation/)
- ABBYY — [FineReader PDF](https://pdf.abbyy.com/finereader-pdf/)
- PDF-XChange — [PDF-Tools](https://www.pdf-xchange.com/product/pdf-tools), [11.1 release note](https://www.pdf-xchange.com/company/news-press-events/1/view/338-new-release-build-11-1-0-0-available-now-29-09-2026)
- Nitro — [PDF Pro 26 release hub](https://www.gonitro.com/release-hub/nitro-pdf-pro-26)
- Wondershare — [PDFelement](https://pdf.wondershare.com/pdfelement/), [AI Smart Redact](https://pdf.wondershare.com/smart-redact-pdf.html)
- UPDF — [UPDF AI](https://ai.updf.com/), [PDF to Mind Maps](https://ai.updf.com/features/pdf-to-mind-maps)
- PDFgear — [PDFgear](https://www.pdfgear.com/), [Copilot](https://www.pdfgear.com/pdf-copilot/)
- Drawboard — [Pricing](https://www.drawboard.com/pricing), [Windows editors guide](https://www.drawboard.com/blog/best-pdf-editors-windows)

*Pricing/version signals from secondary sources are marked as such in §3. Marketing-only "AI-powered" claims were flagged rather than treated as verified capability.*

---

## 8. Implementation status — shipped as v2.25.0, extended in v2.26.0

Everything in §5 marked NEW / UPGRADED / REDESIGNED is implemented and wired into the running app, not just prototyped. v2.26.0 then completed the native `&Tools` menu (all 36 tools), added nine light/dark colour palettes with a live-preview gallery and native `View ▸ Colour Theme` radios, and closed the last unfinished document-processing path (below).

| Module | Role |
|---|---|
| `src/renderer/js/forensics.js` | Dependency-free offline byte forensics + PDF/UA/WCAG audit; directly unit-testable in Node |
| `src/renderer/js/assurance.js` | Security Inspector, Accessibility Checker, Trust Center, local audit ledger, sanitize rebuild, safe a11y fixes, rail panel |
| `src/renderer/js/timeline.js` | IndexedDB version timeline (30 per doc / 160 MB cap), baseline-on-open, save checkpoints, named checkpoints, restore/export/delete |
| `src/renderer/js/premium.js` | Skins, high contrast, persistent focus mode, welcome enhancements, `window.aipdf` local agent API |
| `src/renderer/css/premium.css` | Final-layer "Precision Slate" design system (896 lines), light/dark + Aurora + high-contrast |

Integration points: `index.html` (last stylesheet + `#stLocal` trust chip), `app.js` (boot init, `Assurance` mode, ribbon group, rail items, `COMMANDS`, `onMenuAction` dispatch, baseline/save hooks, exported dispatch surface), `store.js` (settings defaults), `sidebar.js` (dynamic panel registry), `src/main/menu.js` (`&Assurance` menu), and `package.json` (version + two new test scripts).

**Verification gates**

| Gate | Result (v2.26.0 sweep) |
|---|---|
| `npm run test:forensics` | 64 offline byte-level checks — all green (incl. the `/JavaScript` double-count regression and a real PDF fixture) |
| `npm run test:assurance` | 34 Electron/CDP end-to-end checks — all green (dialogs, panels, agent API, timeline, skins, zero renderer exceptions) |
| `npm run test:appearance` | 36 tools × menu + dispatch, 9 palettes × CSS + menu + dispatch + commands, gallery geometry/colour, 0 problems |
| `npm run test:wiring` | 210 menu actions, 102 ribbon buttons, 194 dispatch cases, 0 orphans |
| `npm run test:audit` | 2,185 call sites across 46 files resolve |
| `npm run test:launch` | Visible window, rAF, clean boot |
| `npm run test:redesign-shot` | 16 UI screenshots |
| `npm run test:asar` | Runs from `build.afterPack`; 2,519 entries byte-for-byte equal to source |
| `npm run test:icon` | 12 static + packed checks (exe, asar and installer RT_ICON frames) |
| `npm run test:pipeline` | 7 checks: page numbers/watermark verified in rebuilt bytes by pdf.js |

**Design decisions worth recording**

- No DOM id/class was renamed, so every CDP suite and the static wiring parser keep working; the redesign is purely an additional final CSS layer.
- New side panels register through `window.__aipdfSidePanels` instead of a static `sidebar.js` import, avoiding an `app.js ↔ sidebar.js` module cycle.
- `app.js` exports `COMMANDS` and `onMenuAction` so native menus, ribbon, palette, quick access, CDP hooks and `window.aipdf.run()` all share one dispatch funnel.
- Restore, sanitize and a11y fixes only change the **open document's bytes**; nothing is written to disk until the user Saves. Partial/uncertain repairs (tagging, alt text) are reported, never faked.
- The installed build runs from `resources/app.asar`. Editing `src/` alone cannot update an installed copy — the NSIS installer must be rebuilt and run.

**v2.26.0 completion pass (7 November 2026)**

| Item found unfinished | Resolution |
|---|---|
| `Automate` queued `addPageNumbers`, `watermark` and `splitSize` without ever executing them; the dialog offered no way to set their parameters | All eight steps now execute. `pipelineStamps()` in `stirling.js` is a pure planner producing one footer/header stamp per page plus a diagonal watermark; `app.js` appends them for exactly one `buildPdf()` pass, then exports split parts from the rebuilt bytes. Parameter controls sit beside each checkbox. `test:pipeline` re-reads the bytes with pdf.js to prove the text is really there. |
| `test:icon` silently skipped its packed checks (looked for a `dist-build` directory; releases use `dist-buildN`) | Resolves the newest built directory, same rule as `test:asar`. 12/12 packed checks now run. |
| Several CDP suites still shared the default Electron `userData`, leaving the renderer stuck mid-boot; this was the actual cause of the "legacy red" font/text/table suites | Every CDP suite now gets a per-run `os.tmpdir()` profile. `test:fonts` 11/11 and `test:text` 23/23 are green again. |
| README, this document and the gate table still described v2.24/v2.25 | Version, feature rows, gate results, known debt and the v2.26 completion table are recorded above. |

The long-standing "legacy red" suites are also green now, without touching `tools.js`: the shared userData profile, presses that started below the viewport, a skipped ask-for-text dialog, hidden-panel SVGs in the icon audit, and a shallow-drag angle that exceeded the 22.5° snapping boundary were all harness defects rather than product regressions. No product code in the pointer-event core was changed.
