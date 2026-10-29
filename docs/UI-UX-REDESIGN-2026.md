# AiPDF Editor — UI/UX Redesign

**Date:** 2026-10-30 · **Scope:** information architecture, ribbon, tools, context-aware
properties, settings, chrome · **Status:** implemented

---

## 1. What the research said

The redesign was driven by how the four reference editors actually behave, not by
generic UI advice.

### Adobe Acrobat (the "megaverb" model)

Acrobat's core idea is that a toolbar should not be a list of every possible
button. It is organised around **megaverbs** — broad intentions like *Edit*,
*Convert*, *Organise*, *Protect*, *Sign* — each of which opens a small set of
**tasks**. Two consequences matter for AiPDF:

- A **global bar** (always visible, one level up) carries the megaverbs.
- A **contextual task pane** appears only when something is selected, and it
  explains *what* it is acting on.

Critically, Acrobat also keeps a **Quick Access Toolbar** — a short strip of
pinned commands that survives every ribbon tab, and that the user can edit.

### Foxit (the closest analogue)

Foxit is the closest product analogue to AiPDF: same era, same tabbed ribbon,
same "panels on the left, properties on the right" geometry. Foxit contributes
two specific patterns:

- Every ribbon tab leads with **Hand**, then **Select** — the two tools that
  are meaningful regardless of the task.
- Its ribbon mixes **large labelled buttons** (icon over a text label) for
  primary tools with **small icon-only buttons** for dense secondary tools.
  It does not label everything; the label budget is spent where it pays.

### PDFgear / Nitro (modern framing)

These products add:

- A **single self-describing tab strip** rather than a horizontal scroll of
  dozens of small buttons.
- A **command palette** as the power-user path, with fuzzy matching.
- Tool **defaults surfaced next to the tool**, not buried in a global dialog.

### The synthesis applied here

| Reference pattern | What AiPDF adopted |
|---|---|
| Acrobat megaverbs | New **Documents** tab covering the document-level workflows |
| Acrobat Quick Access Toolbar | **Pinned tools** strip + customiser + right-click to pin |
| Foxit large labelled tools | **Large labelled primary buttons** with shortcut chips |
| Foxit dense icon-only groups | Secondary tools stay icon-only — label budget preserved |
| Acrobat contextual pane | Properties panel gains a **scope strip** naming the target |
| Nitro command palette | Palette gains **fuzzy match**, **recents**, and **tool search** |
| Modern settings IA | **Tabbed Settings** exposing ~45 real preferences |

---

## 2. The problems this app actually had

These were found by auditing the code, not by opinion.

### 2.1 Nineteen working features were invisible

`src/main/menu.js` defined a **Documents** menu with nineteen working
workflows — Compare, Overlay, Scale, Compress, Flatten, Remove blanks, Remove
annotations, Adjust colours, N-up, Join into single page, Poster tiles,
Booklet imposition, Page numbers, Split by size, Auto-rename, Repair, Manage
attachments, Document information, Automate (pipeline). Every one had a
dispatch case in `onMenuAction` and a working implementation.

**None of them appeared in the ribbon, in a mode tab, or in the command
palette.** They were reachable only through the Windows menu bar. A feature a
user cannot see is a feature nobody uses — this was the single largest
discoverability failure in the app.

The native menu's top-level list (13 menus) also did not match the ribbon's
tab list (9 tabs), so the two surfaces disagreed about what the product
contained.

### 2.2 The Home tab repeated the global bar

Home opened with a `File` group containing Open, Save, Print and Props — all
of which were already buttons in the quick-access bar 20px above it. The
redundancy pushed the actual tools toward the right edge and made the tab look
busier than it was. Neither Acrobat nor Foxit repeats the global bar inside the
ribbon.

### 2.3 Every ribbon button was an unlabelled 34px icon

The entire ribbon was icon-only with small uppercase group titles. A new user
had to guess ~60 glyphs. The keyboard shortcuts existed and were documented,
but nothing on screen connected a key to a tool.

### 2.4 The Properties panel silently changed meaning

The panel's title moved between "Highlight", "3 selected", "Text block", "Page"
and "Direct Editor tool" depending on the selection — but it never said
*what the controls below applied to*. The same **Colour** row was the tool
default, then the selected object's colour, then the page. On top of that, the
panel's sections were flat: a long panel had to be re-collapsed by hand after
every selection change.

### 2.5 Preferences exposed 3 of ~45 settings

The Preferences modal offered theme, author name and default zoom. Meanwhile
`DEFAULT_SETTINGS` defined layout, sidebar state, ribbon mode, chrome
visibility, measure unit, OCR language, colour presets, opacity, six text
defaults, four border/brush defaults, the stamp font, the whole AI block
(provider, base URL, model, API key, auth mode, temperature, context budget)
and the OCR block. Most were only settable as a side effect of clicking a
ribbon button.

Two of those settings — `grid`, `coverPage` and `reverse` — were **read by the
ribbon but never defined in `DEFAULT_SETTINGS`**, so `settings.grid` was always
`undefined` and the Grid ribbon toggle could never show itself as active.

### 2.6 No density, no persistence, no pin

There was no way to make the chrome denser for a small screen, the ribbon tab
was not remembered between sessions, and there was no way to promote a tool to
a permanent one-click position.

---

## 3. What changed

### 3.1 A new Documents ribbon tab

`MODES` gained `Documents`, inserted between `Protect` and `Convert` so the
tab strip now mirrors the native menu bar exactly:

```
Home · View · Comment · Edit · Organize · Protect · Documents · Convert · Forms · AI
```

The tab is grouped by intent rather than by implementation:

| Group | Commands |
|---|---|
| Compare & combine | Compare…, Overlay… |
| Optimise | Compress…, Flatten…, Scale…, Colours… |
| Page layout | N-up…, Join…, Poster…, Booklet…, Page numbers… |
| Clean up | Remove blanks…, Remove annotations…, Split by size… |
| Document | Auto-rename…, Repair…, Attachments…, Information… |
| Automate | Pipeline… |

### 3.2 A Home tab built around the primary tools

- The **File group is gone** — it duplicated the quick-access bar.
- **Tools** (Hand, Select, Direct Editor, Area Direct Edit, Edit object, Add
  link) and **Annotate** (Highlight, Note, Callout, Text box) are now **large
  labelled groups**.
- **Markup**, **Drawing** and **Stamp & sign** stay dense and icon-only, so
  the tab still fits without horizontal scrolling.
- **Document properties** no longer sit on Home either. Neither Acrobat nor
  Foxit puts them there: it is a File-menu and Documents-tab item, and it
  remains in the File menu, the command palette and the new **Documents** tab
  (*Information…*). A single-button group on Home only bought width.

### 3.3 Large labelled buttons and shortcut chips

`groupIsLarge()` decides per group whether a button is drawn large
(20px icon over an 11px label over a monospace shortcut chip) or icon-only.
The mode is a user preference:

| Setting | Behaviour |
|---|---|
| `auto` (default) | Only groups authored as large get labels |
| `always` | Every ribbon button is labelled |
| `never` | The original icon-only ribbon |

A single `TOOL_KEYS` table mirrors the renderer keymap and the native menu
accelerators, so the chip on a button can never advertise a shortcut the
keyboard does not honour. The same table feeds the palette.

Tooltips now carry the shortcut (`Highlight · H`) via `data-tip`; the shared
tooltip helper in `util.js` retires the native `title` on first hover so the
two never stack. The `title` attribute itself still holds the bare label,
because several UI tests match on it exactly.

### 3.4 A real Quick Access Toolbar

- Pinned tools render **first**, ahead of Open / Save / Undo, exactly like
  Acrobat's QAT.
- **Right-click any ribbon tool → "Pin to quick access"** — the fast route.
- A **customiser** (Settings → Quick access, or the pin button in the bar)
  ticks tools and reorders them with up/down arrows.
- State lives in `settings.pinnedTools`.

### 3.5 A Properties panel that says what it is acting on

A **scope strip** sits between the panel title and the controls:

```
┌──────────────────────────────────────────┐
│ ▣  Highlight                             │
│    Page 3 of 12                          │
└──────────────────────────────────────────┘
```

It is set at every branch — selected annotation, multi-selection, text block,
Direct Editor session, armed tool defaults, page info — so the controls below
always have a stated subject.

Sections also became **collapsible**, with the fold state remembered per
section in `settings.collapsedProps`.

### 3.6 A tabbed Settings dialog

`src/renderer/js/settings.js` replaces the flat three-field modal. Nine
sections, each bound to a real `DEFAULT_SETTINGS` key:

| Section | Covers |
|---|---|
| General | Author, default zoom, measure unit, OCR language |
| Appearance | Theme, **density**, **ribbon labels**, **restore last tab**, colours, fill |
| View & layout | Layout, sidebar, rulers, grid, cover, reverse, ribbon state |
| Markup & editing | Opacity, font, size, colour, alignment, bold/italic/underline, spacing, scale, border, brush, marker, stamp font |
| Colour presets | The editable swatch list |
| OCR | Engine, dpi, language hint |
| AI assistant | Provider, URL, model, API key, auth mode, temperature, pages, context, scope |
| Shortcuts | The keyboard reference table |
| Advanced | Reset all settings |

Settings apply live and persist immediately — there is no Apply button, which
is how every modern editor behaves.

### 3.7 A command palette worth using

- **Ranked fuzzy matching** with hard bands: an exact name beats a name that
  starts with the query, which beats one that contains it, which beats a
  group-name hit, which beats scattered characters. Scoring all of these in
  one band is what let "Compare with another PDF" outrank "Sticky note" when
  you typed "note" — the letters were scattered across the longer word.
- **Groups are ordered by their strongest hit**, so the entry you meant sits
  at the top of the list rather than under a group header further down.
- **Recent commands** lead the list, recorded through `onMenuAction`, so the
  recents reflect what the user actually does across the menu, the ribbon and
  the palette.
- **Tool search** — typing a tool name surfaces the tool; tools join the list
  only while searching, so they never bury the commands.
- **Shortcut chips** on tool rows.
- An **empty state** that names what was not found.

### 3.8 Chrome refinements

- **Density**: `comfortable` / `compact`, expressed as a body class, so the
  control heights, ribbon and side panels all tighten together.
- **The ribbon tab you left is remembered** (`settings.lastRibbonTab`), and
  the value is validated against the live tab list before it is trusted.
- **A ribbon overflow menu** appears when the tab is wider than the window,
  listing every command on that tab, so nothing hides behind the horizontal
  scroll.
- The ribbon's **right-edge scroll fade now only appears when the ribbon
  actually overflows**. Left permanently on, it faded the last group's own
  title the moment the ribbon got shorter than the window — a side effect of
  removing the redundant File group.

---

## 4. Design-system notes

The existing token architecture was kept intact — it is genuinely good:

```
primitive  →  semantic  →  component
(--c-*)       (--text-1,    (.rbtn, .pitem, .modal…)
               --surface,
               --border,
               --accent)
```

All new CSS is written against **semantic tokens only**, with no raw hex values
and no primitive references, so both theme overrides
(`theme-professional.css`, `theme-claude.css`) continue to work unchanged.
Density is expressed as a body class overriding the same semantic size tokens
the components already use, rather than as a parallel set of component rules.

---

## 5. Files touched

| File | Change |
|---|---|
| `src/renderer/js/app.js` | Documents tab; labelled ribbon; overflow menu; quick access; properties scope + folding; palette rebuild; settings wiring; density; tab persistence |
| `src/renderer/js/settings.js` | **New** — the tabbed Settings dialog |
| `src/renderer/js/store.js` | New settings keys; fixed the undefined `grid` / `coverPage` / `reverse` |
| `src/renderer/js/icons.js` | Added `menu`, `dots`, `pin`, `keyboard` |
| `src/renderer/js/util.js` | Tooltip helper retires the native `title` when a richer `data-tip` exists |
| `src/renderer/index.html` | Properties scope strip; pinned-tools container; quick-access customiser button |
| `src/renderer/css/app.css` | New component layer: density, labelled ribbon, overflow, quick access, properties scope, collapsible sections, settings dialog, palette extras |
| `scripts/redesign-shot.mjs` | **New** — drives the real app and photographs each redesigned surface |

---

## 6. Constraints respected

The repo has a strict UI test gate, so the redesign was written around it:

- `title` on a ribbon button stays the **bare label** (`direct-edit-test`,
  `hand-tool-test` match on it exactly); the shortcut lives in `data-tip`.
- `aria-label` stays the bare label (`hand-tool-test`, `image-tool-test`,
  `area-region-ocr-test` select on `[aria-label="Hand"]` etc.).
- Every ribbon button keeps a **dispatch case** and an **existing icon id**.
- The `Documents` tab reuses only `docs:*` actions that already existed with
  working implementations.

`scripts/shortcuts-test.mjs` reports `pass=18 fail=3` both before and after
this work — the three failures are in the Direct Editor focus test and
predate the redesign (verified by running the suite with these changes
stashed).

### Verification run

| Gate | Result |
|---|---|
| `scripts/wiring-test.mjs` | **PASS** — menu, ribbon, icons, accelerators all consistent |
| `scripts/menu-test.mjs` | **PASS** — 6/6 |
| `scripts/hand-tool-test.mjs` | **PASS** — 11/11 |
| `scripts/launch-test.mjs` | **PASS** — 3/3, app boots, paints frames |
| `scripts/gui-walkthrough-test.mjs` | 172/174 — **all 10 ribbon tabs pass**, 0 console errors. The 2 failures are `ai:translate` and `ai:contract`, both live-API 503 rate-limits |
| `scripts/shortcuts-test.mjs` | `pass=18 fail=3` — unchanged from the pre-redesign baseline |
| `scripts/icon-audit.mjs` | 4 invisible icons — unchanged from the pre-redesign baseline (the find-bar and context-panel close icons, which are hidden when their panels are closed) |

`node scripts/redesign-shot.mjs` photographs every redesigned surface from
the running app; the images in `.smoke/redesign/` are its output.
