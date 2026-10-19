# Native image editor: PDF-library connection

## Scope

This connects the committed content-stream core to the existing @cantoo/pdf-lib dependency. `image-pdf-browser.mjs` imports the app's existing `/v/pdf-lib.js` route. No CDN, new production dependency, Electron privilege, toolbar button, file write or live document mutation is added.

The adapter owns copied input bytes through an opaque session. It edits a freshly loaded PDF and returns candidate bytes after save/reopen structural verification. A caller cannot change the internal snapshot through the returned frozen image descriptors. Closing the session releases its retained input. IDs belong to that session/revision, not to all future saves.

## Renderer API

    import {
      openNativeImagePage, applyNativeImageEdit, closeNativeImageSession,
    } from './image-pdf-browser.mjs';
    const session = await openNativeImagePage(exportedPdfBytes, 0);
    const image = session.images[0];
    const candidate = await applyNativeImageEdit(session, image.id, {
      dx: 20, dy: 10, scaleX: 1.2, scaleY: 1.2, rotation: 90,
    });
    closeNativeImageSession(session);

`candidate` is a Uint8Array. This API does NOT save the file or apply it to the active document. Callers must pass fully exported current document bytes, not base bytes that omit pending text/form/annotation/page edits. The future UI must bind the session to active document ID/revision, preview the result and commit through the authoring/export/undo pipeline.

Additional changes: `flipX`/`flipY`, normalized image-space `crop: [left,bottom,right,top]`, `opacity` in [0,1], `delete: true`, and `replacementBytes: Uint8Array` with `replacementType: 'png'|'jpeg'`. Each edit starts from the session's original bytes; reopen the returned candidate for cumulative changes.

## Safeguards and limitations

The selected page receives a new content stream and shallow-copied resource dictionaries, preserving shared original streams and resources. Resource names are generated internally. PNG/JPEG replacements are embedded before their references are used. Decoding uses chunked reads with encoded/decoded limits. File/session bytes are capped at 32 MiB, decoded page content at 8 MiB, and replacement image bytes at 8 MiB. These are application limits, not proof against all parser/decompression attacks.

Encrypted input and detected signature/certification structures are refused; signature validation/preservation is not implemented. Inline images, images inside nested Form XObjects, complex clipping and masks retain the core's restrictions. Clipping/deletion are not sanitization. Structural save verification checks page count, the exact edited decoded stream and placement count; it does not certify visual fidelity or every attachment/form/tagging invariant.

## Tests and current status

Local syntax checks passed for the adapter, renderer bridge and test script. Actual @cantoo/pdf-lib execution is NOT available in the assistant's execution environment. The previous 57 core tests remain the prior milestone's result, not an adapter integration pass.

Run with installed repository dependencies:

    node scripts/image-objects-test.mjs
    node scripts/image-pdf-test.mjs
    AIPDF_TEST_BROWSER_BUNDLE=1 node scripts/image-pdf-test.mjs

The new read-only GitHub Actions workflow installs @cantoo/pdf-lib 2.11.1 into an isolated temporary directory with install scripts disabled, then runs the core suite and the adapter suite against Node CommonJS and the bundled browser ESM build. It does not alter package.json/package-lock.json, commit, merge, publish, or build Windows binaries. Fork Actions may need enabling. No CI success is claimed before its run is observed.

The adapter suite covers move/resize/rotation/flip/crop/opacity/delete/replacement save/reopen, shared resources and content streams, inherited resources, split content streams, metadata, opaque sessions, input copying, signature refusal and invalid arguments. Further work: visual PDF.js assertions, actual Electron/browser integration, form/annotation preservation corpus, encrypted/signature workflows and the Edit Images selection UI.
