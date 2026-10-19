/** Renderer connection: use the existing bundled PDF library, never a CDN. */
import * as PDFLib from '/v/pdf-lib.js';
import {createImagePdfAdapter} from './image-pdf.mjs';
const adapter=createImagePdfAdapter(PDFLib);
export const openNativeImagePage=adapter.open;
export const applyNativeImageEdit=adapter.edit;
export const closeNativeImageSession=adapter.close;
