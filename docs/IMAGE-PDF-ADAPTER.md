# Native image editor: PDF-library connection

> **Scope note.** The adapter now resolves Form XObjects as well as image
> XObjects, and an object that lives inside a shared form is edited by
> **copying that form** and pointing this page at the copy — the shared
> definition, and every other page that uses it, is left alone. Inline images
> are parsed by the core and edited by transform. See
> [EDIT-OBJECT-TOOL.md](EDIT-OBJECT-TOOL.md).

## Scope

This connects the committed content-stream core to the existing @cantoo/pdf-lib dependency. `image-pdf-browser.mjs` imports the app's existing `/v/pdf-lib.js` route. No CDN, new production dependency, Electron privilege, toolbar button, file write or live document mutation is added.

The adapter owns copied input bytes through an opaque session. It edits a freshly loaded PDF and returns candidate bytes after save/reopen structural verification. A caller cannot change the internal snapshot through the returned frozen image descriptors. Closing the session releases its retained input. IDs belong to that session/revision, not to all future saves.

## Renderer API

    import {
      openNativeImagePage, applyNativeImageEdit, applyNativeAreaLayer, closeNativeImageSession,
    } from './image-pdf-browser.mjs';
    const session = await openNativeImagePage(exportedPdfBytes, 0);
    const image = session.images[0];
    const candidate = await applyNativeImageEdit(session, image.id, {
      dx: 20, dy: 10, scaleX: 1.2, scaleY: 1.2, rotation: 90,
    });
    const layered = await applyNativeAreaLayer(session, image.id, {
      area: [36.5, 281, 86.2, 326.3], pngBytes, layerBase: 'Image area',
    });
    closeNativeImageSession(session);

`candidate` is a Uint8Array. This API does NOT save the file or apply it to the active document. Callers must pass fully exported current document bytes, not base bytes that omit pending text/form/annotation/page edits. The future UI must bind the session to active document ID/revision, preview the result and commit through the authoring/export/undo pipeline.

`applyNativeAreaLayer` is the Area Direct Edit path: it embeds the caller's PNG extract (white already transparent) as a new image placement inside a **new optional-content group (layer)**, paints an opaque white rectangle over the same page area, and returns `{ bytes, layer, image }` after a save/reopen check. The source image is left byte-for-byte unchanged; the white fill is page content, so hiding the layer reveals paper-white. `layer` carries `{ name, ref, visible }`; `image` carries `{ name, bounds, transparent }`, where `transparent` reports the new image's SMask.

`session.objects` is the unified object list — placed images, inline images and Form XObject groups — each with `kind`, `name`, `bounds`, `corners`, `matrix`, `order` (paint order), `container` (the chain of form names it lives in) and `streamKey` (the stream that holds its bytes). `session.images` remains the image-only subset.

Additional changes: `flipX`/`flipY`, normalized image-space `crop: [left,bottom,right,top]`, `opacity` in [0,1], `delete: true`, and `replacementBytes: Uint8Array` with `replacementType: 'png'|'jpeg'`. Each edit starts from the session's original bytes; reopen the returned candidate for cumulative changes.

## Safeguards and limitations

The selected page receives a new content stream and shallow-copied resource dictionaries, preserving shared original streams and resources. Resource names are generated internally. PNG/JPEG replacements are embedded before their references are used. Decoding uses chunked reads with encoded/decoded limits. File/session bytes are capped at 32 MiB, decoded page content at 8 MiB, and replacement image bytes at 8 MiB. These are application limits, not proof against all parser/decompression attacks.

Encrypted input and detected signature/certification structures are refused; signature validation/preservation is not implemented. Complex clipping and masks retain the core's restrictions. Clipping/deletion are not sanitization. An inline image cannot be replaced by a file. Structural save verification checks page count, the exact edited decoded stream and placement count; it does not certify visual fidelity or every attachment/form/tagging invariant.

## Tests and current status

    node scripts/image-objects-test.mjs
    node scripts/image-pdf-test.mjs
    AIPDF_TEST_BROWSER_BUNDLE=1 node scripts/image-pdf-test.mjs

The new read-only GitHub Actions workflow installs @cantoo/pdf-lib 2.11.1 into an isolated temporary directory with install scripts disabled, then runs the core suite and the adapter suite against Node CommonJS and the bundled browser ESM build. It does not alter package.json/package-lock.json, commit, merge, publish, or build Windows binaries. Fork Actions may need enabling. No CI success is claimed before its run is observed.

The adapter suite covers move/resize/rotation/flip/crop/opacity/delete/replacement save/reopen, shared resources and content streams, inherited resources, split content streams, metadata, opaque sessions, input copying, signature refusal and invalid arguments. It also covers the object model: a form is reported as a container, an object inside it is reported in page coordinates, editing it copies the form and leaves the other page of the same shared form untouched, a group drawn on the page is moved through the page stream, and an inline image is parsed and moved. Further work: visual PDF.js assertions, actual Electron/browser integration, form/annotation preservation corpus, encrypted/signature workflows and the Edit Objects selection UI.

