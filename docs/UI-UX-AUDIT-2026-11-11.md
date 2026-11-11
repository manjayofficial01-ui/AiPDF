# AiPDF Editor — Rendered UI/UX Audit

**Date:** 2026-11-11 · **Build:** v2.26.0 (`bootInfo.version` → `#brandVer`) · **Platform:** Windows / Electron, Chromium CDP
**Method:** Full rendered audit of the real application, not a source-only review.
**Status:** Audit complete; F1–F7 plus one newly discovered defect are implemented and verified — see §5. Pre-fix evidence is preserved in `.smoke/ux-audit/before/`.
**Verdict:** The visual system is strong at wide sizes and its accessibility plumbing (focus, ARIA, reduced motion) is genuinely good. Three defects were serious enough to ship a fix: unreachable controls at the app's own minimum window size, a CSS cascade bug that silently disables every colour skin in dark mode, and a set of small-text contrast failures.

---

## 1. Method and evidence

A CDP harness (`scripts/ux-audit.mjs`) boots the real Electron app with a **per-run `os.tmpdir()` profile**, loads the canonical 3-page fixture (`.fixtures/fixture.pdf`), and waits for `window.__aipdfBooted` plus rendered pages before installing its measurement library. It captures 15 screenshots and writes `.smoke/ux-audit/evidence.json` (101 KB). It never mutates source and restores every temporary DOM tweak.

| Dimension | Coverage |
| --- | --- |
| Viewports | 1440×900 (wide), 1920×1080 (ultrawide), 940×620 (**native `minWidth`/`minHeight`**) |
| Appearance | light, dark, `contrast` accessibility skin, theme gallery, command palette |
| States | ideal (3 pages), empty (no document), error (toast), long label, panels (pages / comments) |
| Measures | computed text contrast (WCAG 2.1 relative luminance, composited backgrounds), type sizes, hit-target boxes, spacing rhythm, layout overflow, status-bar overlap, focus sequence, reduced motion, five data states |

Screenshots: `.smoke/ux-audit/01`–`15-*.png`. Measurements: `.smoke/ux-audit/evidence.json`.

### What was measured vs. what was not

- **Measured:** rendered chrome — titlebar, menubar, ribbon, rail, sidebars, status bar, modals, toasts, empty workspace. PDF page **content** is excluded from text contrast by design (it is user content, not UI).
- **Verified false positives:** `.brand-mark` and `.ew-logo` use `background: var(--brand-mark)`, a **gradient** (`background-image`). `backgroundColor` computes as transparent, so the harness composited their text colour against the page background instead of the gradient. The reported 1.17:1 and 1.00:1 "failures" are measurement artefacts; the screenshots show a blue tile with a white "A" that is readable. **Not a finding.**
- **Not evaluated:** user research, screen-reader output, a full keyboard traversal of all 36 tools, focus restore after every dialog, runtime/animation performance, loading behaviour during real long-running operations (OCR, PDF→Word). Zero skeletons / `aria-busy` / progress elements were present in the observed idle and empty states, but no long operation was triggered, so "no loading state" is **unconfirmed, not a finding**.
- This is a rendered audit against WCAG AA contrast math and the UI/UX excellence rules; it is **not** a formal WCAG 2.1 conformance claim.

---

## 2. Scorecard

| # | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| F1 | **P0** | At 940×620 the mode-tab row and all three right-side controls are off-screen and unreachable | `minLight.layout` |
| F2 | **P1** | `body.dark` token bundle shadows `html[data-skin]` tokens — every skin is partly ignored in dark mode, including the High Contrast accessibility skin | `contrastSkin.surfaces`, `darkSurfaces` |
| F3 | **P1** | 13/66 light and 8/66 dark chrome text nodes fail WCAG AA; 52/66 are under 12px | `*.text` |
| F4 | **P1** | Dark-mode thumbnail badges are black-on-black (1.20:1) | `wideDark.text`, `04-wide-dark.png` |
| F5 | **P1** | Comment initial is white on the annotation colour (yellow → 1.26:1) | `errorToast.text`, `15-contrast-skin.png` |
| F6 | **P2** | 45/89 (51%) of controls are under the 32×32 desktop hit target; worst 16×16 | `*.hits` |
| F7 | **P2** | At 940×620 the document canvas is squeezed to 384px (41% of window) | `minLight.layout` |
| F8 | **P2** | Ribbon labels truncate and shortcut chips crowd the label at 1440px | `01-wide-light.png` |
| F9 | **P2** | Spacing rhythm breaks the 4pt grid in 6 recurring places | `wideLight.spacing` |
| F10 | **P2** | Gallery grid scrolls at minimum size; 3 of 9 palette cards below the fold | `06-gallery-min.png` |
| F11 | **P3** | No visible scroll affordance on the horizontally scrolling ribbon/mode row | screenshots |

---

## 3. Findings

### F1 · P0 — Core controls unreachable at the native minimum window size

At 940×620 (the app's own `BrowserWindow.minWidth`/`minHeight`), `.menubar` has `scrollWidth 1190` vs `clientWidth 940`. `.modes` extends to x=1084 and `.mb-right` to x=1190, both with `overflow-x: visible`.

- The last **3 of 11 mode tabs** (Convert, Forms, AI) are clipped.
- **Find, Command Palette and Ribbon toggle are entirely off-screen** — no scrollbar, no overflow menu, no keyboard path from the menu row.
- `.ribbon` correctly handles the same pressure (`overflow-x:auto`, scrollWidth 1095) and its overflow button is visible in `03-min-light.png`; the menubar has no equivalent.

**Root cause:** `.modes { flex: 1 }` has no `min-width: 0`, so its 677px of tabs can never shrink; `.quick` (391px) and `.mb-right` (98px) are then pushed past the viewport by the flex row.

**Impact:** A user who sizes the window to the minimum loses search, the palette and ribbon collapse. This is a functional blocker, not a cosmetic one. See `03-min-light.png`, `09-min-pages-panel.png`, `10-min-comments-panel.png`.

**Fix:** pin `.quick`/`.mb-right` with `flex: 0 0 auto`; give `.modes` `min-width: 0; overflow-x: auto; overscroll-behavior-x: contain` with a thin scrollbar and non-shrinking tabs; keep the menubar's `min-width: 0`.

### F2 · P1 — Dark mode silently overrides every colour skin (systemic)

`applyTheme()` (`app.js:973`) sets BOTH `document.documentElement.dataset.theme` **and** `document.body.classList.toggle('dark')` as a legacy alias. Two dark token bundles target that alias:

- `premium.css:140` — `[data-theme="dark"], body.dark { --surface:#171e2a; --text-4:#71839c; … }`
- `app.css:346` — `[data-theme="dark"], body.dark { … }`

Skins declare their tokens on **`html[data-skin="…"]`** (`premium.css:208–375`). Custom properties inherit: a declaration on `<body>` wins for every descendant of `<body>`, regardless of the `html` rule's specificity. So in dark mode, the skin's `--surface`, `--bg-app`, `--text-1…4`, `--accent-*` are applied to `<html>` but **shadowed on everything the user actually sees**.

Hard evidence from `contrastSkin.surfaces` (dark + `contrast` skin):

| Surface | Expected (contrast dark) | Rendered |
| --- | --- | --- |
| `body` `--bg-app` | `#000000` | `rgb(15,20,29)` — default dark |
| `.sidebar` / `.context` / `.statusbar` | `#000000` | `rgb(23,30,42)` — default dark |
| `.menubar` / `.ribbon` | `#000000` | `rgb(0,0,0)` — correct (chrome tokens are not re-declared on body) |
| `--text-4` on `html` | `#ffffff` | `#ffffff`, but body descendants compute `#71839c` |

Result: the "WCAG AAA" accessibility skin shows navy panels with grey borders and 4.32:1 secondary text in dark mode (`contrastSkin.text`, `15-contrast-skin.png`). The same shadowing mutes all eight hue palettes in dark mode. `test:appearance` does not catch it because it reads `getComputedStyle(document.documentElement)`, i.e. the unshadowed `<html>` values.

**Impact:** An accessibility feature gives false assurance; palette selection is only half-effective for half the users. Highest-value fix in this pass.

**Fix:** re-declare the skin token bundles on `body.dark` as well as on `html`, so the body element inherits from itself rather than from the default dark bundle. Use a shared selector list — no JS change, legacy alias preserved.

### F3 · P1 — Small, low-contrast chrome text

`wideLight.text`: **66 visible text nodes; 13 fail AA (19.7%)**. `52/66 (79%)` are below 12px and `36/66 (55%)` below 11px. The type ramp is unusually compressed: `{9px:12, 9.5:1, 10:12, 10.5:11, 11:5, 11.5:11, 12:12, 13:2}`.

| Class | Size | Foreground / background | Ratio | Need | Count |
| --- | --- | --- | --- | --- | --- |
| `.rkey` shortcut chips | 9px | `#8a98ac` / `#f5f7fb` | **2.73** | 4.5 | 7 |
| `.rtitle` ribbon group titles | 9px | `#8a98ac` / `#f7f8fd` | **2.77** | 4.5 | 5 |
| `.pgroup` palette headings | 9px | `#8a98ac` / `#ffffff` | **2.93** | 4.5 | 12 (palette open: 25/182 fail) |
| `.th-section`, `.th-foot` | 10–10.5px | `#8a98ac` / `#ffffff` | **2.93** | 4.5 | 2 |
| `.rtitle` (dark) | 9px | `#71839c` / `#1b2433` | **4.05** | 4.5 | 5 |
| `.ew-hint` (dark empty) | 10px | `#71839c` / `#171e2a` | **4.32** | 4.5 | 1 |

WCAG has **no small-text exemption**: 9px text still needs 4.5:1. These are information-bearing labels (group names, keyboard shortcuts, section headings), not decorative.

**Fix:** raise `--text-4` to a value that clears 4.5:1 on the lightest chrome surfaces and dark backgrounds. Computed candidates: `#5f6d82` → 4.90 on `#f5f7fb`, 4.95 on `#f7f8fd`, 5.25 on white; dark `#8497b0` → 5.22 on `#1b2433`, 5.60 on `#171e2a`. Keep the hierarchy through size/weight/tracking, not through near-invisible colour. Follow with a type-size pass (`9px → 10.5px` minimum for group labels) as a separate change.

### F4 · P1 — Dark-mode thumbnail badges are black-on-black

`wideDark.text` group: `span.pnum "1"/"2"/"3"` computes `rgb(16,21,31)` on `rgb(34,38,45)` = **1.20:1**. `.thumb .pnum` (`app.css:1055`) uses `color: var(--text-inverse)`, which flips from `#ffffff` in light to `#10151f` in dark, while `--overlay-ink` stays dark in both themes. `04-wide-dark.png` confirms the page numbers are effectively invisible. `.scanbadge` / `.ocrdone` (`app.css:1080`) share the same inverted ink on `--warn-solid` / `--ok-solid`.

**Fix:** pin the ink on dark overlay badges to a light colour (the overlay is always dark ink); do not tie it to `--text-inverse`.

### F5 · P1 — Comment avatar initial is white on the annotation colour

`sidebar.js:547` paints `.cmt-ic` with the annotation's RGB (`rgb(255,230,51)` for the fixture's yellow highlight) while `.cmt-ic` (`app.css:1126`) hardcodes `color: var(--accent-text)` = white → **1.26:1**. Measured in `errorToast.text`, `emptyState`, `contrastSkin` and visible in `15-contrast-skin.png` (the yellow "H" chip in the Comments panel).

**Fix:** compute a contrast-aware ink from the annotation colour's relative luminance in `sidebar.js` (dark ink on light swatches, light ink on dark swatches).

### F6 · P2 — Half the controls are below the desktop hit target

`wideLight.hits`: **45/89 (50.6%)** under 32×32; `minLight.hits`: **59/90 (65.6%)**. Distribution: `30×28` ×22 (quick-access and icon buttons), `36×32` ×21, `36×34` ×13, `16×16` ×1 (`.t-close` tab close), `28×28` ×1 (`.tab-add`), `62×23` ×1 (`#aiChip`), plus several `~25px` status-bar chips. At 940×620 the theme/rail buttons shrink further to `26×26`/`36×28`.

The smallest offender, `.t-close` at 16×16, is a destructive action on a tab — the classic mis-click hazard.

**Fix (non-visual, low risk):** expand the interactive box with an absolutely positioned `::after` (`inset:-1px -1px -2px -2px`) on icon buttons, so the 30×28 visual becomes a 32×32 target without changing the chrome's measured height. Give `.t-close` a real 24×24 minimum. Avoid a blanket height change: raising the menubar to 32px would ripple into `--h-menu` and every CDP geometry assertion.

### F7 · P2 — Document canvas starved at minimum size

At 940×620 the layout gives rail 52px + sidebar 244px + context 260px, leaving `.canvas-wrap` only **384px (41% of the window)** with `scrollHeight 1630`. The page is legible but the workspace is unusable for editing (`03-min-light.png`). The existing `@media (max-width:1080px)` rule already narrows panels from 288/312 to 244/260, but does not go far enough for the native minimum.

**Fix:** add a `@media (max-width:1000px)` step (e.g. 208/208 → 480px canvas). A behavioural fix — auto-collapsing the context panel below a width threshold — would be better UX but needs state/JS work and is out of scope for this pass.

### F8 · P2 — Ribbon labels truncate and collide with shortcut chips

`01-wide-light.png`: "Area Direct Edi…", "Add [ink]sible", "Note" / "Callout" / "Text box" labels wrap into their `Ctrl+…` chips; the shortcut chip is rendered inside the same 62–88px button as a two-line label. `.rbtn.large .rlabel` is 10px with `max-width:150px` and the buttons are `min-width:62px`. The overlap is visible at 1440px, not just at the minimum.

**Fix:** hide `.rkey` inside `.rbtn.large` when the button is narrower than ~92px, or move shortcuts to native tooltips; reserve a single line for the label with `white-space:nowrap; text-overflow:ellipsis`.

### F9 · P2 — Spacing rhythm off the 4pt grid

`wideLight.spacing`, recurring non-multiples of 4:

| Value | Where | Count |
| --- | --- | --- |
| `11px` | `.mode-tab` padding-left/right | 16 / 15 |
| `2px` | `#tabStrip` gap / row / column | 14 each |
| `5px` | `.rbtn.large` padding-top, `.rgroup` gap, `.rkey` padding | 10 / 8 / 7 |
| `1px` | `.rkey` padding-block, `#brandVer` padding | 8 / 3 |
| `10px` | `#aiChip` padding-inline | 5 / 3 |
| `9px` | `.mini-btn` padding-inline | 3 |
| `6px` | `.tb-right` gap | 3 |

These are small, deliberate optical adjustments in a dense desktop ribbon; converting them wholesale would churn the whole chrome. Recommend harmonising to the 4/8pt scale **only alongside** the next ribbon layout pass, not as an isolated edit.

### F10 / F11 · P2/P3 — Small responsive and affordance gaps

- Gallery at 940×620: modal `[80,30,780,560]` fits the viewport, but `.th-grid` is 347px tall with `scrollHeight 414` — 3 of 9 cards are below the fold. A scrollbar is present in `06-gallery-min.png`; fine, but a 2-column grid at narrow widths would show all palettes at once.
- The horizontally scrolling ribbon (and, after F1, the mode row) has no fade, arrow or "more" affordance beyond the OS scrollbar. Low severity; worth adding a right-edge gradient once F1 lands.

---

## 4. What is working well (keep it)

These were measured, not assumed — do not regress them.

- **No chrome overflow at 1440×900 or 1920×1080.** `body.scrollWidth === clientWidth`; no child extends past the viewport; `.statusbar` has 9 items and **0 overlapping pairs** at every size.
- **Modal accessibility.** Theme gallery: `role`-labelled, `aria-modal="true"`, 13 focusables, focus lands on `.th-mode-btn.active` with `:focus-visible` and a `1.6px` ring at 2px offset; six Tabs stay inside the modal; Escape closes it. `galleryFocus.closed === true`.
- **Reduced motion.** With `prefers-reduced-motion: reduce`, every measured transition/animation computes to `1e-05s` and transforms to `none`.
- **Long labels.** Injecting a 96-character filename keeps `.tab` at 236px, `.t-name` at 191px with `overflow:hidden; text-overflow:ellipsis; white-space:nowrap`; tab strip and body do not grow (`bodyScrollW 1440`).
- **Five data states.** Ideal (3 pages, canvas ink), empty (`.empty-workspace` visible, icon + 3 CTAs, in light and dark), error (`toast` with the failure message), overflow (long label) all render. Loading state not exercised — see §1.
- **Theme gallery at wide size.** 780×742 at `[330,79]`, fully within viewport, 9 cards, grid does not scroll, `cardRect 237×134`, `previewRect 220×62`.
- **Density and surfaces.** The `--chrome-menu*` / `--chrome-toolbar*` bands produce a real, subtle tint separation; dark mode's surfaces are consistent; contrast skin's light mode is pure black/white.

---

## 5. Fixes implemented (this pass)

Ordered by severity and blast radius. All changes are CSS/JS-only in `src/`; no build artefacts were touched. Pre-fix evidence is preserved in `.smoke/ux-audit/before/`.

| Finding | File(s) | Change |
| --- | --- | --- |
| F1 | `premium.css` §4b | `.menubar { min-width:0 }`, `.quick`/`.mb-right { flex:0 0 auto }`, `.modes { flex:1 1 0; min-width:0; height:32px; overflow-x:auto }`, non-shrinking tabs, 4px scrollbar |
| F2 | `premium.css` §2 | Re-declare the contrast skin (light + dark), the shared `--th-*` → semantic mapping, and the dark `--accent-solid` rule on `body.dark` as well as on `html`, defeating the legacy alias's shadowing |
| F3 | `premium.css` §1 | `--text-4`: `#8a98ac → #5f6d82` (light), `#71839c → #8497b0` (dark) |
| F4 | `app.css` | `.pnum`, `.scanbadge`, `.ocrdone` pin `#ffffff` instead of `--text-inverse` |
| F5 | `sidebar.js` | New `inkForRgb()` picks dark/light ink from the annotation swatch's relative luminance |
| F6 | `premium.css` §4c | Out-of-flow `::after` expands icon-button pointer boxes to 32×32; `.t-close` grows 16×16 → 24×24 with a 32×32 hit box |
| F7 | `premium.css` §12 | `@media (max-width:1000px)` narrows `--w-side`/`--w-ctx` to 208px (root, body and both density classes) |
| **New** | `premium.css` §2 | Verification exposed one more real defect: `.ew-logo` hardcodes white ink, but the dark contrast skin makes `--brand-mark` solid yellow (1.27:1). Added the same black/white ink flip already used by the titlebar mark |

### Measured before → after

| Metric | Before | After |
| --- | --- | --- |
| Menubar `scrollWidth` @940 (client 940) | 1190 | **940** |
| Right-side controls off-screen @940 | 3 | **0** (all three hit-testable) |
| `body.scrollWidth` @940 | 1190 | **940** |
| Mode row | clipped, unreachable | scrolls 677→419px; last tab reachable |
| Document canvas @940 | 384px | **472px** |
| Light chrome text failures | 13 / 66 | **1 / 66** (gradient artefact only) |
| Dark chrome text failures | 8 / 66 | **0 / 66** |
| Command palette failures | 25 / 182 | **1 / 182** (same artefact) |
| Empty state, light / dark | 16 / 7 | **2 / 0** (artefacts) |
| Contrast dark skin failures | 3 | **0** |
| Contrast dark skin `body --surface` | `rgb(23,30,42)` default dark | **`#000000`** |
| 9px ribbon group title | 2.77:1 | **4.96:1** |
| Dark thumbnail page number | 1.20:1 | **15.23:1** |
| Comment initial on yellow swatch | 1.26:1 | **14.46:1** |
| Ocean skin `--accent` on `<body>` (dark) | shadowed | `#67d3e8`, matches `<html>` |

The remaining 1–2 "failures" in light mode are the documented `.brand-mark` / `.ew-logo` gradient false positives from §1, not real defects.

`ux-audit.mjs` reports `hits.under32` as 45/89 both before and after: it measures `getBoundingClientRect()`, which cannot see an out-of-flow pseudo-element. A dedicated probe (`scripts/ux-verify.mjs`, `npm run test:ux-verify`) hit-tests the expanded boxes with `elementFromPoint` and confirms the pointer now reaches the button 1px above and 0.5px left of its rect, without changing any chrome geometry.

### Gate results

- `npm run test:ux-verify` → **PASS 19/19** (menubar fit, control clickability, tab scrolling, hit expansion, text/pnum/avatar contrast, contrast dark skin on body, hue skin in dark, empty-logo ink).
- Core gates, all **exit 0**: `test:wiring`, `test:audit`, `test:launch`, `test:appearance`, `test:assurance`, `test:forensics`, `test:redesign-shot`.
- Interaction gates, all **exit 0**: `test:smoke`, `test:menu`, `test:key`, `test:tools`, `test:walk` (**175/175 actions clean**), `test:resize`, `test:overlay`, `test:modaldrag`, `test:wheel`. These matter because F6 adds pointer-catching pseudo-elements.
- `test:appearance` initially failed one **static** check that looked for the literal `html[data-skin="aurora"] {` as the last selector of the shared mapping block. The F2 fix legitimately added `body.dark` selectors there. The check was rewritten to parse the whole selector list and require **every** hue palette — strictly stronger than the old Aurora-only assertion. It now passes (`APPEARANCE_PASS 0 problem(s)`).
- **Not run:** `test:icon` and `test:asar`. Both compare the newest `dist-buildN` artefact, and this pass changed source only. A fresh build is required before those two are meaningful; running them against `dist-build38` would fail legitimately.

### Deferred, with rationale

F8 (ribbon label truncation / chip collision — needs a layout decision), F9 (4pt rhythm — would churn every chrome measurement for marginal gain), F10/F11 (gallery scroll and edge fade — cosmetic), and the 9px→10.5px type ramp (a deliberate visual redesign, not a bug fix). Contrast now passes at 9px, but a type-scale pass would still improve readability.

---

## 6. Reproduction

```bash
node scripts/ux-audit.mjs                 # regenerates .smoke/ux-audit/*.png + evidence.json
npm run test:ux-verify                    # 19 rendered regression assertions + verify.json
node -e "const E=require('./.smoke/ux-audit/evidence.json'); console.log(E.minLight.layout['.menubar'])"
```

Both harnesses use a fresh `os.tmpdir()` profile per run — a shared profile leaves the renderer at `readyState: interactive` with `__aipdfBooted=false` and produces misleading "zero documents" results.
