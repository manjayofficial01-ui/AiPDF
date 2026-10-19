# Native image editor — engine milestone 1

This is the first implementation milestone, not a completed SwifDoo-equivalent UI.

## Implemented core

`src/renderer/js/image-objects.mjs` detects direct image XObject placements from decoded page content. A placement has a distinct source-span ID, resource name, transformation matrix, corners and bounds. It can produce a per-occurrence move, resize, center rotation, flip, normalized image-space crop, opacity graphics-state invocation, replacement-resource invocation or deletion.

It changes the selected Do invocation and preserves bytes outside that span. It does not paint a white rectangle, add an annotation, rasterize the page or mutate the shared image object. Other instances of the same image remain separate targets.

## Fail-closed scope

Inline images cause page parsing to stop with an unsupported error. Form XObjects are reported but not recursively edited. Transform/crop edits refuse existing path/text clipping, pending paths, singular transforms and image masks. Deleting a placement does not sanitize unreferenced image bytes. Image crop is clipping, not confidential-data removal. The core consumes decoded page content, not whole PDF bytes.

## Validation

57 core checks passed locally. Eight real-PDF cases were written with the JS core's edited content, saved with pypdf and independently parsed after reopening. Those cases verified invocation counts, preservation of another page, preservation of the shared original image reference, and selected operation-specific structure. The replacement case verified resource-name rerouting, not decoded replacement pixels. No visual renderer was used.

The downloadable build bundle also includes an experimental `image-pdf.mjs` adapter and `image-pdf-test.mjs`. The adapter was syntax-checked but could not be executed here because @cantoo/pdf-lib is unavailable and network package installation is disabled. That adapter is NOT part of this first core commit. It must pass the repository dependency-based save/reopen tests before UI integration.

## Run the core tests

    node scripts/image-objects-test.mjs

No package changes or network requests are required.

## Next implementation gates

1. Run the experimental adapter's tests using the repository's installed @cantoo/pdf-lib, with shared resources, inherited resources and split streams.
2. Validate exact saved results with PDF.js/another renderer, including transparent replacement images, masks, cropped/rotated pages and nonzero page-box origins.
3. Add Edit Images entry, page hit-testing, drag/resize handles, object properties and preview controls.
4. Integrate the existing document authoring/export/undo pipeline. Do not save only base bytes and discard pending text, annotations, forms or page edits.
5. Add stale-document/revision guards, explicit save/cancel behavior and signed/encrypted-document safeguards before enabling mutations in the UI.
6. Add AI actions using stable image-placement IDs and the same validated edit path, after user approval and candidate verification.

Target branch: audit/aipdf-agent-hardening-2026-10-19 in Omid-r/AiPDF. This milestone does not change the toolbar, app.js, PDF writer, package files, theme, or main branch.
