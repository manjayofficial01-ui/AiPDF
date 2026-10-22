# Edit Object tool — how a flat-looking page is read, and what that buys

This document is the traceability record for the **Edit Object** tool (ribbon:
*Edit ▸ Objects ▸ Edit object*; internal id `editImage`). It starts from a
research question about how a commercial PDF editor selects images and objects
in files that look completely flat, and ends with the code that now ships.

---

## 1. The question, and the answer it produced

> *How does an editor select an image inside a page that shows no layers, no
> visible structure, and no obvious objects?*

The answer is not visual recognition. A PDF page is a **content stream** plus the
**resources** that stream names, and a content stream is a list of operators.
An editor reads that list. Text, images, vector paths, shadings and form
containers are all *there*, addressable, even when the rendered page looks like
one flat picture.

Three consequences follow, and they are the whole design of this tool:

| Fact about the file | What the tool does |
|---|---|
| A page can look flat and still hold separate objects | Objects are enumerated from the content stream, never guessed from pixels |
| Objects nest (a Form XObject holds more objects) | The traversal descends into the containers and composes the matrices |
| The picture inside a single bitmap is **not** an object | The tool says so, instead of pretending it can select a logo out of a scan |

The third row is the limit, and the tool is built to be honest about it.

---

## 2. What was broken before this change

Each row is a real, reproducible failure of the previous implementation — not a
hypothetical.

| Symptom | Cause | Fixed in |
|---|---|---|
| A logo drawn inside a Form XObject could not be selected at all | The inspector stopped at the container and reported it as *unsupported* | `image-objects.mjs` — recursive descent |
| **One inline image on a page made the whole page unselectable** | The tokenizer threw `Inline images are not supported`, aborting the parse | `image-objects.mjs` — inline images are measured and parsed |
| Clicking a logo on top of a photo selected the photo underneath | The hit test took the *first* match in document order — the bottom-most object | `image-edit.js` — top-most (paint order) wins |
| A form shared by ten pages could not be edited, and the reason was invisible | The edit path refused nested objects with no explanation | `image-pdf.mjs` — the form is **copied**, the shared definition is untouched |
| A scan produced "nothing found" with no explanation | The tool could not tell "no objects" from "one object that is the whole page" | `image-edit.js` — the page is described, not left silent |
| A drag that crossed a page re-render silently did nothing | The move gesture was bound to the selection box, and the re-render replaces the box — so the `pointerup` was lost | `image-edit.js` — the gesture is tracked on the window, and the live bounds belong to the gesture |

The most damaging of these was the second: a single inline image made the tool
report an empty page, so the user was told a page had no editable objects when
it had several.

---

## 3. The object model

`src/renderer/js/image-objects.mjs` is the pure core: no PDF library, no DOM,
no network. It answers one question — *what does this content stream draw?* —
and answers it in **page coordinates**.

```
page content stream
├── image XObject placement      → object { kind:'image'  }
├── inline image (BI…ID…EI)      → object { kind:'inline' }
└── form XObject invocation      → object { kind:'form' }   ← a CONTAINER
    └── the form's own stream is read too
        ├── image XObject        → object { kind:'image', container:['Fm0'] }
        └── another form         → object { kind:'form',  container:['Fm0'] }
```

Every object carries:

| Field | Meaning |
|---|---|
| `kind` | `image` · `inline` · `form` |
| `matrix` | absolute placement in **page** space (the container's matrices are composed) |
| `local` / `space` | the transform **inside its own stream** and the transform **of its own stream** — together they let a change be expressed in the bytes that actually hold the object |
| `bounds` / `corners` | the real quad, so a rotated object is hit-tested where it *is* |
| `order` | paint order — later objects are painted over earlier ones |
| `container` | the chain of form names the object lives in |
| `streamKey` | which stream holds the bytes (`page`, `form:Fm0`, …) |

### 3.1 Containers are descended into, not refused

A Form XObject is a *reusable container*, not a fillable form. The traversal
resolves it, composes `page CTM × form /Matrix × inner CTM`, and reports the
children in page coordinates. Two guards keep it finite: a form may not contain
itself (`recursive-form`) and the depth is capped (`form-too-deep`).

### 3.2 Inline images are measured, not guessed

An inline image's data is binary, so the stream cannot simply be tokenised —
the data has to be located first or every token after it is garbage. The
length is computed from the inline dictionary (`/W`, `/H`, `/BPC`, `/CS`,
`/F`) where the filter allows it, and otherwise found by the PDF rule that the
data is terminated by an `EI` surrounded by white space. The bytes themselves
are never rewritten: an inline image is edited by wrapping it in a transform.

### 3.3 A change is expressed in the stream that holds the bytes

A move, resize, rotation, flip or fade of an object inside a form is computed
in **page space** (that is what the user drags) and then mapped back into the
space of the stream that holds the object:

```
desired (page space)  →  newLocal = inverse(space) × desired  →  delta = inverse(local) × newLocal
```

For an object on the page this collapses to the original behaviour, because
`space` is the identity there.

---

## 4. Hit testing: paint order, and the group underneath

A PDF paints later objects **over** earlier ones, so the object the reader sees
under the pointer is the **last one drawn**. The click therefore picks the
highest `order` among the objects whose quad contains the point.

Marquee selection is a different question — *which object is inside this box?* —
and answers it by coverage. A marquee that **encloses** an object almost
completely (90% of its quad) selects that whole object: a tight marquee round
a small logo wins over a background photo it barely touches.

A marquee that lies **inside** one image is **Area Direct Edit** instead: the
selection becomes only the picture that is actually in the box, clipped to the
image's visible placement and trimmed of white margins (section 4.1). This is
what makes a full-page scan useful: a small box round the emblem no longer
selects the whole page.

**Alt+click** steps down through the objects stacked under the pointer. That is
how the *group* around an object is reached: the form is painted first and its
child is painted on top of it, so the child is what a plain click finds.

### 4.1 Area Direct Edit: only the picture in the box

A drag inside an image is not a whole-object pick. It is a limited edit of
exactly the pixels the box touches:

1. The best-covered image under the marquee is chosen, and the box is clipped
   to that placement's **visible** bounds (a section cropped earlier is
   respected).
2. The page is rendered fresh at up to 3× into an offscreen canvas, so the
   result does not depend on the window's zoom or its device-pixel ratio.
3. Every pixel in the clipped box below the white cutoff (any channel < 244)
   counts as content. The selection becomes the tight bounds of that ink, plus
   one source pixel of breathing room.
4. If the box holds only white — a margin, a blank cell, the space beside a
   logo — **nothing is selected** and the tool says so. White background is
   never turned into a selectable object.

The floating toolbar then offers:

| Action | What it does |
|---|---|
| **New layer** | Extracts the selected pixels at the source image's native density, makes white transparent, writes them as a new image placement inside a **new PDF optional-content group (layer)**, and paints a white rectangle in the same page area underneath. The Layers panel can show or hide the result; undo removes it. |
| **Keep area** | Crops the placement to the selected content through the native content-stream adapter. Everything outside the area is hidden; undo restores the full image. |
| **Whole image** | Steps back to ordinary whole-object selection, so the image can be moved, resized, replaced or deleted. |
| **Cancel** | Clears the area selection. |

**New layer** is the way to take a sub-region out of a bitmap without
re-encoding the source: the original placement is left exactly as it was, a
white fill covers the selected area on the page, and the extracted picture is
a normal editable image on its own layer (move, resize, replace, delete).
Hiding the layer reveals the white fill; showing it brings the picture back.
The layer image is raster — native pixel density, white made transparent — not
a vector reconstruction.

On the supplied PDF (one full-page grayscale scan), a marquee
`(10,255)–(95,334)` around the state emblem produces a selection of about
`50 × 45 pt` — the measured ink bounds with one pixel of breathing room, not
the marquee. **New layer** adds a second placement (`AiArea0`) at those bounds
inside layer **Image area 1**; the new image carries an SMask, and hiding the
layer leaves the area white while the banner, header and table elsewhere on the
page stay exactly as they were.

---

## 5. Editing a shared form without touching the shared definition

A form is frequently shared: the same logo on every page of a report, the same
header on every page of a contract. Editing the form's own definition would
change every page that uses it.

The adapter therefore **copies the form** and points this page at the copy:

```
page content:   /Fm0 Do      →   /Fm00 Do          (the copy)
original form:  untouched, still referenced by every other page
```

The copy chain is built from the innermost form outwards, so an object nested
two forms deep is edited without touching either shared definition. A group
drawn directly on the page needs no copy at all — its placement lives in the
page's own content stream, and that is where it is changed.

Verified in `scripts/image-pdf-test.mjs`: after editing an object inside a
shared form, **page 1 moved and page 2 did not**, and the original form's
content stream in the saved file is byte-for-byte what it was.

---

## 6. Selection is not reconstruction

Four operations are easy to confuse, and this tool only ever performs the
third:

| Operation | What it produces |
|---|---|
| **Selection** | A boundary around content that is really in the file |
| **Extraction** | Image data read out of the file |
| **Editing** | A change to an existing object's placement or appearance |
| **Reconstruction** | Structure inferred from pixels that were never objects |

A page that is one bitmap has exactly **one** object in it. The logo inside
that scan is not an object, and no amount of clicking will produce one. The
tool states this rather than failing silently:

- a page with no image objects → *"This page has no image objects — it holds
  text and vector content only."*
- a page that is one full-page bitmap → the selection is marked **Page image**
  and the tooltip says *"this page is one image"*.

OCR is a separate tool (`OCR page`) and is not part of object selection.

---

## 7. Deliberate limits

- **Vector paths and text objects are not edited here.** Text is the Direct
  Editor's job; vector art is drawn with the drawing tools. This tool edits
  the *placed* objects: images, inline images and form groups.
- **No OCR, no segmentation, no reconstruction.** Nothing here guesses at
  content that the file does not contain.
- **Clipping, masks, pending paths and singular transforms are refused** for
  the object being edited, and the refusal is reported rather than approximated.
- **Crop is clipping, not redaction.** A cropped image is still in the file.
- **Inline images cannot be replaced by a file** — the data would have to be
  rewritten in place. They can be moved, resized, rotated, flipped, faded,
  cropped and deleted.
- **Encrypted and signature-bearing files are refused** by the adapter.
- **A group is changed in the page stream**, so a group inside another form is
  reported but not moved (the tool says the object is not editable there).
- **New layer rasterises the selection.** The extract is rendered at the source
  image's native density (clamped), with white made transparent. It is not a
  vector reconstruction and does not preserve the original compressed bytes of
  that section.
- **Only a top-level, unclipped image can be lifted into a layer.** Inline
  images, and placements the adapter already considers clipped, masked or
  singular, are refused with a reason; **Keep area** remains available where
  cropping is safe.
- **The area trim detects white, not subjects.** A very light background that
  is not white counts as content; this path uses pixels, not a segmentation
  model.

---

## 8. Verification

| Suite | Checks | Proves |
|---|---|---|
| `scripts/image-objects-test.mjs` | 76 | The core: containers descended into, matrices composed, inline images measured, paint order, group edits, refusal cases |
| `scripts/image-pdf-test.mjs` | 25 | The adapter: save/reopen for every edit, a shared form copied and the other page untouched, an inline image moved, the original definition byte-identical |
| `scripts/image-tool-test.mjs` | 22 | The live tool: select, move, resize, rotate, fade, delete, crop, replace — and the saved file agrees |
| `scripts/image-marquee-test.mjs` | 9 | The live tool: a drag is a marquee, a press is a click |
| `scripts/flat-object-test.mjs` | 12 | The live tool on a page that *looks* flat: paint order, an object inside a form, Alt+click to the group, and the honest messages |
| `scripts/area-direct-edit-test.mjs` | 35 (+1 on a packaged build) | The live **Area Direct Edit** on the supplied full-page scan: the box hugs the ink and drops the white margins, white-only boxes select nothing, **New layer** creates a real OCG and a transparent layer image, the white fill hides the original area, the Layers panel hides/shows it, the rest of the page is unchanged, the original file stays untouched. Set `AIPDF_EXE` to test a packaged/installed exe and `AIPDF_EXPECT_VERSION` to assert its version chip |

```
npm run test:image         # live tool
npm run test:imagemarquee  # marquee gesture
npm run test:flatobject    # flat pages, containers, paint order
node scripts/image-objects-test.mjs
node scripts/image-pdf-test.mjs
```

---

## 9. Files

| File | Role |
|---|---|
| `src/renderer/js/image-objects.mjs` | The pure core: tokenizer, object model, transform maths, edit spans |
| `src/renderer/js/image-pdf.mjs` | The adapter: resolves resources and forms, copies shared forms, saves and re-verifies |
| `src/renderer/js/image-pdf-browser.mjs` | Renderer bridge to the bundled PDF library (no CDN) |
| `src/renderer/js/image-edit.js` | The tool: marquee and click selection, paint order, the floating toolbar, the honest messages |
| `src/renderer/js/pages.js` | `listNativeObjects` / `commitNativeObjectEdit` — the authoring + undo path |
| `src/renderer/js/app.js` | The ribbon entry (`editImage`, labelled *Edit object*) |
| `scripts/area-direct-edit-test.mjs` | Live acceptance run on the supplied full-page scan (takes the PDF path) |
