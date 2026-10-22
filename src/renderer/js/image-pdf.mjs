import { inspectImagePlacements, buildImageEdit, buildObjectEdit } from './image-objects.mjs';
const PAGE_LIMIT = 8 * 1024 * 1024, FILE_LIMIT = 32 * 1024 * 1024;
function copyBytes(value, limit = FILE_LIMIT) {
  const data = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  if (!(data instanceof Uint8Array) || !data.length || data.length > limit) throw new Error('Expected bounded nonempty PDF/image bytes');
  return Uint8Array.from(data);
}
function latin1(data) { let result = ''; for (let i = 0; i < data.length; i += 32768) result += String.fromCharCode(...data.subarray(i, i + 32768)); return result; }
const encode = value => Uint8Array.from(value, c => c.charCodeAt(0));
function lookup(PL, doc, dict, key) { if (!dict) return undefined; const value = dict.get(PL.PDFName.of(key)); return value ? doc.context.lookup(value) : undefined; }
function copyDict(PL, doc, value) {
  if (value && !(value instanceof PL.PDFDict)) throw new Error('Invalid resource dictionary');
  const result = doc.context.obj({}); if (value) for (const key of value.keys()) result.set(key, value.get(key)); return result;
}
function resourcesFor(PL, doc, page) {
  let node = page.node; const seen = new Set();
  while (node) {
    if (!(node instanceof PL.PDFDict) || seen.has(node) || seen.size >= 64) throw new Error('Invalid page inheritance'); seen.add(node);
    const resources = lookup(PL, doc, node, 'Resources'); if (resources) return resources;
    node = lookup(PL, doc, node, 'Parent');
  }
  return doc.context.obj({});
}
function assertEditable(PL, doc) {
  if (doc.isEncrypted || doc.context.trailerInfo.Encrypt) throw new Error('Encrypted image editing is not enabled');
  if (doc.catalog.get(PL.PDFName.of('Perms'))) throw new Error('Certification permissions require a separate signing workflow');
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    const dict = object instanceof PL.PDFDict ? object : object?.dict;
    if (dict && (dict.has(PL.PDFName.of('ByteRange')) || dict.get(PL.PDFName.of('Type'))?.toString() === '/Sig' || dict.get(PL.PDFName.of('FT'))?.toString() === '/Sig')) throw new Error('Signature-bearing PDFs are read-only in this adapter');
  }
}
function uniqueName(PL, dict, prefix) { let n = 0; while (dict.has(PL.PDFName.of(prefix + n))) n++; return prefix + n; }
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const fmt = n => String(Number(n.toFixed(6)));

/**
 * Register a new optional-content group (a real PDF layer) and make it visible
 * in the default configuration. Existing layers are preserved; the new ref is
 * appended to `/OCGs`, `/D /ON` and `/D /Order`.
 */
function addOCG(PL, doc, requestedBase) {
  const N = s => PL.PDFName.of(s);
  const base = String(requestedBase || 'Image area').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 110) || 'Image area';
  let used;
  try { used = new Set(doc.getOptionalContentGroups().map(g => g.name)); } catch { used = new Set(); }
  let n = 1;
  while (used.has(base + ' ' + n)) n++;
  const name = base + ' ' + n;
  const ocg = doc.context.obj({});
  ocg.set(N('Type'), N('OCG'));
  ocg.set(N('Name'), PL.PDFString.of(name));
  const ref = doc.context.register(ocg);

  const catalog = doc.catalog;
  const raw = catalog.get(N('OCProperties'));
  let ocp = raw ? doc.context.lookup(raw) : undefined;
  if (raw && !(ocp instanceof PL.PDFDict)) throw new Error('Unsupported optional-content dictionary');
  if (!ocp) {
    const d = doc.context.obj({});
    const on = doc.context.obj([]); on.push(ref);
    const order = doc.context.obj([]); order.push(ref);
    d.set(N('ON'), on);
    d.set(N('Order'), order);
    d.set(N('BaseState'), N('ON'));
    ocp = doc.context.obj({});
    const ocgs = doc.context.obj([]); ocgs.push(ref);
    ocp.set(N('OCGs'), ocgs);
    ocp.set(N('D'), d);
    catalog.set(N('OCProperties'), doc.context.register(ocp));
  } else {
    let ocgs = doc.context.lookup(ocp.get(N('OCGs')));
    if (!(ocgs instanceof PL.PDFArray)) { ocgs = doc.context.obj([]); ocp.set(N('OCGs'), ocgs); }
    ocgs.push(ref);
    let d = doc.context.lookup(ocp.get(N('D')));
    if (!(d instanceof PL.PDFDict)) { d = doc.context.obj({}); ocp.set(N('D'), d); }
    for (const key of ['ON', 'Order']) {
      let arr = doc.context.lookup(d.get(N(key)));
      if (!(arr instanceof PL.PDFArray)) { arr = doc.context.obj([]); d.set(N(key), arr); }
      arr.push(ref);
    }
  }
  return { ref, name };
}

/** Decode one content stream (or an array of them) into a single string. */
function decodeContent(PL, doc, contents) {
  const streams = contents instanceof PL.PDFArray ? Array.from({ length: contents.size() }, (_, i) => doc.context.lookup(contents.get(i))) : contents ? [contents] : [];
  if (streams.length > 4096) throw new Error('Too many content streams');
  const chunks = []; let total = 0;
  for (const stream of streams) {
    let decoded;
    if (typeof stream?.getUnencodedContents === 'function') {
      const raw = stream.getUnencodedContents(); if (raw.length > PAGE_LIMIT) throw new Error('Page stream exceeds limit'); decoded = latin1(raw);
    } else {
      if (!(stream instanceof PL.PDFRawStream)) throw new Error('Unsupported page content stream');
      if (stream.contents.length > PAGE_LIMIT) throw new Error('Encoded page stream exceeds limit');
      const decoder = PL.decodePDFRawStream(stream), parts = []; let size = 0;
      if (typeof decoder.getBytes !== 'function') throw new Error('PDF decoder does not support bounded reads');
      for (;;) {
        const chunk = decoder.getBytes(Math.min(65536, PAGE_LIMIT - size + 1)); if (!chunk.length) break;
        size += chunk.length; if (size > PAGE_LIMIT) throw new Error('Decoded stream exceeds limit'); parts.push(latin1(chunk));
      }
      decoded = parts.join('');
    }
    total += decoded.length + 1; if (total > PAGE_LIMIT) throw new Error('Decoded page exceeds image editor limit'); chunks.push(decoded);
  }
  for (let i = 1; i < chunks.length; i++) if (chunks[i - 1] && chunks[i] && !/[\x00\x09\x0a\x0c\x0d\x20]$/.test(chunks[i - 1]) && !/^[\x00\x09\x0a\x0c\x0d\x20]/.test(chunks[i])) throw new Error('Unsupported token boundary between content streams');
  return chunks.join('\n');
}
function numberArray(PL, doc, dict, key, length) {
  const array = lookup(PL, doc, dict, key);
  if (!(array instanceof PL.PDFArray)) return null;
  const values = Array.from({ length: array.size() }, (_, i) => array.get(i)).map(v => v instanceof PL.PDFNumber ? v.asNumber() : NaN);
  return values.length === length && values.every(Number.isFinite) ? values : null;
}

/**
 * Resolve the XObject names a stream can draw with. A name is an IMAGE (one
 * addressable object) or a FORM (a container that holds more objects).
 */
function resolveXObjects(PL, doc, resources) {
  const resolved = Object.create(null), names = Object.create(null);
  const xobjects = lookup(PL, doc, resources, 'XObject');
  if (xobjects instanceof PL.PDFDict) {
    for (const key of xobjects.keys()) {
      const decoded = key.decodeText();
      names[decoded] = key;
      const ref = xobjects.get(key), object = doc.context.lookup(ref), dict = object instanceof PL.PDFDict ? object : object?.dict;
      const subtype = dict && lookup(PL, doc, dict, 'Subtype')?.toString();
      if (subtype === '/Image') {
        const width = lookup(PL, doc, dict, 'Width'), height = lookup(PL, doc, dict, 'Height');
        if (!(width instanceof PL.PDFNumber) || !(height instanceof PL.PDFNumber) || width.asNumber() <= 0 || height.asNumber() <= 0) throw new Error('Invalid image dimensions');
        resolved[decoded] = { kind: 'image', ref: String(ref), width: width.asNumber(), height: height.asNumber(), imageMask: lookup(PL, doc, dict, 'ImageMask')?.toString() === 'true' };
      } else if (subtype === '/Form') {
        resolved[decoded] = { kind: 'form', ref: String(ref) };
      }
    }
  }
  return { resolved, names, xobjects: xobjects instanceof PL.PDFDict ? xobjects : null };
}

/**
 * Inspect a page: its own objects AND the objects its Form XObjects contain.
 * A form is a container, not a picture — the traversal descends into it and
 * composes the matrices, so a logo inside a header form is reported in PAGE
 * coordinates and can be picked like any other object.
 */
async function inspect(PL, doc, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= doc.getPageCount()) throw new Error('Invalid page index');
  const page = doc.getPage(index);
  const source = decodeContent(PL, doc, lookup(PL, doc, page.node, 'Contents'));
  const pageResources = resourcesFor(PL, doc, page);
  const byResolved = new WeakMap();
  const forms = new Map();

  const register = (resources) => {
    const { resolved, names, xobjects } = resolveXObjects(PL, doc, resources);
    byResolved.set(resolved, { dict: resources, names, xobjects });
    return resolved;
  };
  const resolveForm = (name, resources, path) => {
    const entry = byResolved.get(resources);
    if (!entry || !entry.xobjects) return null;
    const pdfName = entry.names[name];
    if (!pdfName) return null;
    const ref = entry.xobjects.get(pdfName), object = doc.context.lookup(ref), dict = object instanceof PL.PDFDict ? object : object?.dict;
    if (!dict || lookup(PL, doc, dict, 'Subtype')?.toString() !== '/Form') return null;
    const key = 'form:' + [...path, name].join('/');
    if (forms.has(key)) return forms.get(key).resolved;
    const matrix = numberArray(PL, doc, dict, 'Matrix', 6) || [1, 0, 0, 1, 0, 0];
    const bbox = numberArray(PL, doc, dict, 'BBox', 4);
    // A form must carry its own resources; some producers omit them, so the
    // invoking stream's resources are the fallback rather than a failure.
    const formResources = lookup(PL, doc, dict, 'Resources') || entry.dict;
    const formSource = decodeContent(PL, doc, lookup(PL, doc, dict, 'Contents'));
    const formResolved = register(formResources);
    const resolved = { source: formSource, resources: formResolved, matrix, bbox };
    forms.set(key, { key, name, path: [...path, name], ref, dict, pdfName, source: formSource, resources: formResolved, matrix, bbox, parent: entry.dict });
    return resolved;
  };

  const pageResolved = register(pageResources);
  const snapshot = inspectImagePlacements(source, pageResolved, { resolveForm });
  for (const [key, info] of forms) {
    if (snapshot.forms[key]) snapshot.forms[key].dict = info.dict;
    else snapshot.forms[key] = { key, name: info.name, path: info.path, source: info.source, resources: info.resources, matrix: info.matrix, bbox: info.bbox, dict: info.dict, images: [], objects: [] };
  }
  return { ...snapshot, pageIndex: index };
}

/** A plain, freezable view of one object. */
function objectView(o) {
  return {
    id: o.id,
    kind: o.kind,
    name: o.name,
    bounds: o.bounds.slice(),
    corners: o.corners.map(p => p.slice()),
    matrix: o.matrix.slice(),
    local: o.local.slice(),
    space: o.space.slice(),
    clipped: !!o.clipped,
    container: (o.container || []).slice(),
    order: o.order,
    singular: !!o.singular,
    resource: o.resource ? { ...o.resource } : null,
    imageMask: !!o.resource?.imageMask,
    streamKey: o.streamKey,
    inline: !!o.inline,
    children: o.kind === 'form' ? (o.childCount || 0) : 0,
  };
}

/** The XObject sub-dictionary of a resource dictionary, if it has one. */
function xObjectDict(PL, doc, resources) {
  if (!resources) return null;
  const x = lookup(PL, doc, resources, 'XObject');
  return x instanceof PL.PDFDict ? x : null;
}

/** Copy a Form XObject so one instance can be edited without touching the
 *  original definition — a form shared by other pages stays untouched. */
function cloneForm(PL, doc, dict, source, extras) {
  const copy = copyDict(PL, doc, dict);
  const resources = copyDict(PL, doc, lookup(PL, doc, dict, 'Resources'));
  if (extras) {
    const xobjects = copyDict(PL, doc, xObjectDict(PL, doc, resources));
    for (const [name, ref] of Object.entries(extras)) xobjects.set(PL.PDFName.of(name), ref);
    resources.set(PL.PDFName.of('XObject'), xobjects);
  }
  copy.set(PL.PDFName.of('Resources'), resources);
  copy.set(PL.PDFName.of('Contents'), doc.context.register(doc.context.flateStream(encode(source))));
  return doc.context.register(copy);
}

/** Owns copied input bytes. Edits return new PDF bytes; never writes the live app model. */
export function createImagePdfAdapter(PL) {
  for (const name of ['PDFDocument', 'PDFName', 'PDFDict', 'PDFArray', 'PDFNumber', 'PDFRawStream', 'decodePDFRawStream', 'PDFString']) if (!PL?.[name]) throw new Error('PDF library lacks ' + name);
  const sessions = new WeakMap();
  async function load(bytes) { const doc = await PL.PDFDocument.load(bytes, { updateMetadata: false, preserveXFA: true }); assertEditable(PL, doc); return doc; }
  async function open(input, index = 0) {
    const bytes = copyBytes(input), doc = await load(bytes), snapshot = await inspect(PL, doc, index);
    const session = freeze({
      pageIndex: index,
      pageCount: doc.getPageCount(),
      images: snapshot.images.map(objectView),
      objects: snapshot.objects.map(objectView),
      unsupported: snapshot.unsupported,
    });
    sessions.set(session, { bytes, snapshot });
    return session;
  }
  async function edit(session, id, change) {
    const stored = sessions.get(session); if (!stored) throw new Error('Unknown or closed image session');
    if (!change || typeof change !== 'object' || Array.isArray(change)) throw new Error('Image edit must be an object');
    const { replacementBytes, replacementType, ...options } = change;
    if (Array.isArray(options.crop)) options.crop = options.crop.slice();
    if ('graphicsStateName' in options || 'replacementName' in options) throw new Error('Resource names are internal');
    if (replacementBytes === undefined && replacementType !== undefined) throw new Error('Replacement type requires image bytes');
    const replacement = replacementBytes === undefined ? null : copyBytes(replacementBytes, PAGE_LIMIT);
    if (replacement && !['png', 'jpeg'].includes(replacementType)) throw new Error('Replacement must be PNG or JPEG');
    if (options.delete && replacement) throw new Error('Cannot delete and replace together');
    const doc = await load(Uint8Array.from(stored.bytes)), before = await inspect(PL, doc, session.pageIndex);
    if (before.source !== stored.snapshot.source) throw new Error('Source changed; reopen image session');
    const target = before.objects.find(o => o.id === id);
    if (!target) throw new Error('That object can no longer be edited on this page');

    const page = doc.getPage(session.pageIndex);
    const pageResources = copyDict(PL, doc, resourcesFor(PL, doc, page));
    const pageXObjects = copyDict(PL, doc, lookup(PL, doc, pageResources, 'XObject'));
    let expectedPageSource = before.source;

    /* A group drawn on the page is changed in the PAGE stream, so a form that
     * other pages share is never touched. */
    if (target.kind === 'form') {
      const result = buildObjectEdit(before, id, options);
      expectedPageSource = result.source;
      if ('opacity' in options) {
        const graphics = copyDict(PL, doc, lookup(PL, doc, pageResources, 'ExtGState'));
        options.graphicsStateName = '/' + uniqueName(PL, graphics, 'AiImageGS');
        graphics.set(PL.PDFName.of(options.graphicsStateName.slice(1)), doc.context.register(doc.context.obj({ Type: 'ExtGState', ca: options.opacity })));
        pageResources.set(PL.PDFName.of('ExtGState'), graphics);
      }
      page.node.set(PL.PDFName.of('Resources'), pageResources);
      page.node.set(PL.PDFName.of('Contents'), doc.context.register(doc.context.flateStream(encode(expectedPageSource))));
      const bytes = await doc.save({ updateFieldAppearances: false, useObjectStreams: false });
      if (bytes.length > FILE_LIMIT) throw new Error('Edited PDF exceeds adapter file limit');
      const verified = await load(bytes), after = await inspect(PL, verified, session.pageIndex);
      if (verified.getPageCount() !== session.pageCount || after.source !== expectedPageSource) throw new Error('Saved object edit failed structural verification');
      return bytes;
    }

    /* An image (or inline image) that lives inside a Form XObject. The form is
     * COPIED and the copy is drawn instead, so the shared definition — and
     * every other page that uses it — stays exactly as it was. */
    const nested = target.streamKey !== 'page';
    const formPath = nested ? (before.forms[target.streamKey]?.path || []) : [];
    let resourceExtras = null;
    if (replacement) {
      const embedded = replacementType === 'png' ? await doc.embedPng(replacement) : await doc.embedJpg(replacement);
      await embedded.embed();
      options.replacementName = '/' + uniqueName(PL, pageXObjects, 'AiImage');
      pageXObjects.set(PL.PDFName.of(options.replacementName.slice(1)), embedded.ref);
      resourceExtras = { [options.replacementName.slice(1)]: embedded.ref };
    }
    if ('opacity' in options) {
      const graphics = copyDict(PL, doc, lookup(PL, doc, pageResources, 'ExtGState'));
      options.graphicsStateName = '/' + uniqueName(PL, graphics, 'AiImageGS');
      const gsRef = doc.context.register(doc.context.obj({ Type: 'ExtGState', ca: options.opacity }));
      graphics.set(PL.PDFName.of(options.graphicsStateName.slice(1)), gsRef);
      pageResources.set(PL.PDFName.of('ExtGState'), graphics);
      resourceExtras = { ...(resourceExtras || {}), [options.graphicsStateName.slice(1)]: gsRef };
    }

    const result = buildImageEdit(before, id, options);
    if (!nested) {
      expectedPageSource = result.source;
      pageResources.set(PL.PDFName.of('XObject'), pageXObjects);
      page.node.set(PL.PDFName.of('Resources'), pageResources);
      page.node.set(PL.PDFName.of('Contents'), doc.context.register(doc.context.flateStream(encode(expectedPageSource))));
    } else {
      /* Copy the chain of forms from the page down to the edited object. */
      let childName = null, childRef = null;
      let pendingSource = result.source;
      for (let i = formPath.length - 1; i >= 0; i--) {
        const levelKey = 'form:' + formPath.slice(0, i + 1).join('/');
        const info = before.forms[levelKey];
        if (!info || !info.dict) throw new Error('That object lives in a form this editor cannot rewrite');
        let source = pendingSource;
        if (i < formPath.length - 1) {
          const childGroup = (info.objects || []).find(o => o.kind === 'form' && o.name === formPath[i + 1]);
          if (!childGroup) throw new Error('That object lives in a form this editor cannot rewrite');
          source = info.source.slice(0, childGroup.start) + '/' + childName + ' Do' + info.source.slice(childGroup.end);
        }
        const extras = i === formPath.length - 1 ? resourceExtras : (childName ? { [childName]: childRef } : null);
        const ref = cloneForm(PL, doc, info.dict, source, extras);
        // The copy is named in the resources of whatever draws it.
        const parent = i === 0
          ? xObjectDict(PL, doc, pageResources)
          : xObjectDict(PL, doc, lookup(PL, doc, before.forms['form:' + formPath.slice(0, i).join('/')]?.dict, 'Resources'));
        childName = uniqueName(PL, parent || doc.context.obj({}), formPath[i]);
        childRef = ref;
        pendingSource = source;
      }
      const group = before.objects.find(o => o.kind === 'form' && o.name === formPath[0]);
      if (!group) throw new Error('That object lives in a form this editor cannot rewrite');
      expectedPageSource = before.source.slice(0, group.start) + '/' + childName + ' Do' + before.source.slice(group.end);
      pageXObjects.set(PL.PDFName.of(childName), childRef);
      pageResources.set(PL.PDFName.of('XObject'), pageXObjects);
      page.node.set(PL.PDFName.of('Resources'), pageResources);
      page.node.set(PL.PDFName.of('Contents'), doc.context.register(doc.context.flateStream(encode(expectedPageSource))));
    }

    const bytes = await doc.save({ updateFieldAppearances: false, useObjectStreams: false });
    if (bytes.length > FILE_LIMIT) throw new Error('Edited PDF exceeds adapter file limit');
    const verified = await load(bytes), after = await inspect(PL, verified, session.pageIndex);
    if (verified.getPageCount() !== session.pageCount || after.source !== expectedPageSource) throw new Error('Saved image edit failed structural verification');
    if (options.delete && after.images.length !== before.images.length - 1) throw new Error('Saved image edit failed structural verification');
    if (!options.delete && after.images.length < before.images.length) throw new Error('Saved image edit failed structural verification');
    return bytes;
  }
  /**
   * Area Direct Edit → a real layer.
   *
   * The selected pixels (a PNG with white made transparent) are embedded as a
   * new XObject, drawn inside a marked-content section belonging to a new OCG.
   * Before it, a white rectangle fills the same page area, so the original
   * picture underneath is covered: hiding the layer leaves paper-white, not a
   * ghost of the selected content. The source image is never re-encoded.
   */
  async function placeAreaLayer(session, id, options) {
    const stored = sessions.get(session);
    if (!stored) throw new Error('Unknown or closed image session');
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Area layer options must be an object');
    const area = options.area;
    if (!Array.isArray(area) || area.length !== 4 || area.some(n => typeof n !== 'number' || !Number.isFinite(n)) || area[2] <= area[0] || area[3] <= area[1]) throw new Error('Area layer needs a nonempty page-space rectangle');
    const png = copyBytes(options.pngBytes, PAGE_LIMIT);
    if (options.layerBase !== undefined && typeof options.layerBase !== 'string') throw new Error('Layer name must be text');

    const doc = await load(Uint8Array.from(stored.bytes));
    const before = await inspect(PL, doc, session.pageIndex);
    if (before.source !== stored.snapshot.source) throw new Error('Source changed; reopen image session');
    const target = before.objects.find(o => o.id === id);
    if (!target) throw new Error('That object can no longer be edited on this page');
    if (target.kind !== 'image' || target.streamKey !== 'page' || target.clipped || target.singular || target.imageMask) {
      throw new Error('Only an unclipped image drawn directly on the page can be lifted into a layer');
    }
    const B = target.bounds;
    const clamped = [
      Math.max(B[0], Math.min(B[2], area[0])), Math.max(B[1], Math.min(B[3], area[1])),
      Math.max(B[0], Math.min(B[2], area[2])), Math.max(B[1], Math.min(B[3], area[3])),
    ];
    if (clamped[2] - clamped[0] < 0.5 || clamped[3] - clamped[1] < 0.5) throw new Error('The selected area is too small to lift into a layer');

    const page = doc.getPage(session.pageIndex);
    const pageResources = copyDict(PL, doc, resourcesFor(PL, doc, page));
    const pageXObjects = copyDict(PL, doc, lookup(PL, doc, pageResources, 'XObject'));
    const imageName = uniqueName(PL, pageXObjects, 'AiArea');
    const embedded = await doc.embedPng(png);
    await embedded.embed();
    pageXObjects.set(PL.PDFName.of(imageName), embedded.ref);
    pageResources.set(PL.PDFName.of('XObject'), pageXObjects);

    const layer = addOCG(PL, doc, options.layerBase);
    const properties = copyDict(PL, doc, lookup(PL, doc, pageResources, 'Properties'));
    const mcName = uniqueName(PL, properties, 'AiAreaMC');
    properties.set(PL.PDFName.of(mcName), layer.ref);
    pageResources.set(PL.PDFName.of('Properties'), properties);
    page.node.set(PL.PDFName.of('Resources'), pageResources);

    const w = clamped[2] - clamped[0], h = clamped[3] - clamped[1];
    // White paper under the layer, painted over the original picture. It is
    // page content, not part of the layer, so hiding the layer reveals it.
    const whiteFill = [
      'q',
      '1 1 1 rg',
      fmt(clamped[0]) + ' ' + fmt(clamped[1]) + ' ' + fmt(w) + ' ' + fmt(h) + ' re',
      'f',
      'Q',
    ].join('\n');
    const placement = [
      'q',
      fmt(w) + ' 0 0 ' + fmt(h) + ' ' + fmt(clamped[0]) + ' ' + fmt(clamped[1]) + ' cm',
      '/OC /' + mcName + ' BDC',
      '/' + imageName + ' Do',
      'EMC',
      'Q',
    ].join('\n');
    const expectedPageSource = before.source + '\n' + whiteFill + '\n' + placement;
    page.node.set(PL.PDFName.of('Contents'), doc.context.register(doc.context.flateStream(encode(expectedPageSource))));

    const bytes = await doc.save({ updateFieldAppearances: false, useObjectStreams: false });
    if (bytes.length > FILE_LIMIT) throw new Error('Layered PDF exceeds adapter file limit');
    const verified = await load(bytes);
    const after = await inspect(PL, verified, session.pageIndex);
    if (verified.getPageCount() !== session.pageCount || after.source !== expectedPageSource) throw new Error('Saved area layer failed structural verification');
    if (after.images.length !== before.images.length + 1) throw new Error('Saved area layer failed structural verification');
    if (!after.objects.some(o => o.kind === 'image' && o.name === target.name && !o.clipped)) throw new Error('Saved area layer modified the source image');
    const savedLayer = verified.getOptionalContentGroups().find(g => String(g.ref) === String(layer.ref));
    if (!savedLayer || savedLayer.name !== layer.name) throw new Error('Saved area layer is missing from the document layers');
    const lifted = after.objects.find(o => o.kind === 'image' && o.name === imageName && !o.clipped);
    if (!lifted) throw new Error('Saved area layer image is missing');
    if (Math.abs(lifted.bounds[0] - clamped[0]) > 0.5 || Math.abs(lifted.bounds[1] - clamped[1]) > 0.5
      || Math.abs(lifted.bounds[2] - clamped[2]) > 0.5 || Math.abs(lifted.bounds[3] - clamped[3]) > 0.5) {
      throw new Error('Saved area layer is not where the selection was');
    }
    const xobjects = lookup(PL, verified, resourcesFor(PL, verified, verified.getPage(session.pageIndex)), 'XObject');
    const liftedRef = xobjects instanceof PL.PDFDict ? xobjects.get(PL.PDFName.of(imageName)) : undefined;
    const liftedObject = liftedRef ? verified.context.lookup(liftedRef) : null;
    const liftedDict = liftedObject instanceof PL.PDFDict ? liftedObject : liftedObject?.dict;
    const transparent = !!(liftedDict && liftedDict.get(PL.PDFName.of('SMask')));
    return {
      bytes,
      layer: { name: savedLayer.name, ref: String(savedLayer.ref), visible: savedLayer.visible },
      image: { name: imageName, bounds: lifted.bounds.slice(), transparent },
    };
  }

  return Object.freeze({ open, edit, placeAreaLayer, close: session => sessions.delete(session) });
}
