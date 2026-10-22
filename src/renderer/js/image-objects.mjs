/** Native object-placement edits. No PDF-library, DOM, or network dependency.
 *
 *  A PDF page is a content stream plus the resources that stream names.
 *  Objects are discovered by READING that structure — never by guessing from
 *  a rendered picture — so a page that looks flat still yields its separate
 *  text, image, path and form objects, and a logo drawn inside a Form
 *  XObject is still one addressable object.
 *
 *  Four things are easy to confuse, and this module only ever does the third:
 *
 *    selection       drawing a boundary round something
 *    extraction      reading image data out of the file
 *    editing         changing an existing object's placement or appearance
 *    reconstruction  inferring structure the file never contained
 *
 *  A page that is one bitmap has exactly ONE object in it. The pixels inside
 *  that bitmap are not objects, and nothing here pretends otherwise.
 */
const I = [1, 0, 0, 1, 0, 0];
const MAX_FORM_DEPTH = 8;

export function multiply(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
export function inverse(m) {
  const [a, b, c, d, e, f] = m, det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) throw new Error('Singular image transform');
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
export function imageCorners(m) { return [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]); }
/** Axis-aligned bounds of a point list. */
export function boundsOf(points) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
function finite(n) { if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 1e8) throw new Error('Invalid numeric image argument'); return n; }
function number(n) { finite(n); return String(Number(n.toFixed(10))); }
function resourceName(n) { if (typeof n !== 'string' || !/^\/[A-Za-z][A-Za-z0-9_]*$/.test(n)) throw new Error('Invalid generated resource name'); return n; }
const whitespace = c => c !== undefined && /[\x00\x09\x0a\x0c\x0d\x20]/.test(c);
const delimiter = c => c === undefined || whitespace(c) || '()<>[]{}/%'.includes(c);
const skipWhite = (source, i) => { while (i < source.length && whitespace(source[i])) i++; return i; };

/* ── Inline images (BI … ID … EI) ───────────────────────────────────────────
 *  An inline image lives in the content stream instead of the resource
 *  dictionary. Its data is binary, so the stream cannot simply be tokenised:
 *  the data has to be measured first, or every token after it is garbage.
 *  The length is computed from the inline dictionary where the filter allows
 *  it, and otherwise found by the PDF rule that the data is terminated by an
 *  "EI" surrounded by white space. */

/** Components per pixel for the abbreviated inline colour-space names. */
function colorComponents(cs) {
  switch (cs) {
    case 'G': case 'DeviceGray': case 'CalGray': case 'I': case 'Indexed': return 1;
    case 'RGB': case 'DeviceRGB': case 'CalRGB': case 'Lab': return 3;
    case 'CMYK': case 'DeviceCMYK': return 4;
    default: return 0;               // unknown → fall back to the EI scan
  }
}

/** Read the entries of an inline image dictionary (`<< … >>` body). */
function parseInlineDict(text) {
  const out = {};
  const re = /\/([A-Za-z][A-Za-z0-9]*)(?:\s+(\/[^\s/[\]<>]+|-?\d+(?:\.\d+)?|true|false|null))?/g;
  let m;
  while ((m = re.exec(text))) {
    let value = m[2];
    if (value === undefined) value = true;
    else if (value[0] === '/') value = value.slice(1);
    else if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (value === 'null') value = null;
    else value = Number(value);
    out[m[1]] = value;
  }
  return out;
}

/** Index of the ">>" that closes a dictionary opened at `start`. */
function findDictEnd(source, start) {
  let depth = 1, i = start;
  while (i < source.length && depth) {
    if (source.slice(i, i + 2) === '<<') { depth++; i += 2; continue; }
    if (source.slice(i, i + 2) === '>>') { depth--; i += 2; continue; }
    i++;
  }
  if (depth) throw new Error('Unterminated inline image dictionary');
  return i - 2;
}

/** True when "EI" follows the data at `pos`, skipping white space. */
function endsWithEI(source, pos) {
  const i = skipWhite(source, pos);
  return source.slice(i, i + 2) === 'EI';
}

/** End of inline image data, found by the PDF " EI " rule. */
function findInlineEnd(source, from) {
  for (let i = from; i < source.length - 1; i++) {
    if (source[i] !== 'E' || source[i + 1] !== 'I') continue;
    if (!whitespace(source[i - 1])) continue;
    const after = source[i + 2];
    if (after !== undefined && !whitespace(after) && !delimiter(after)) continue;
    return i - 1;
  }
  return -1;
}

/**
 * Read one inline image starting at the "BI" keyword. Returns the offset just
 * past the closing "EI" and pushes a token describing the whole block.
 */
function readInlineImage(source, start, after, out) {
  let p = skipWhite(source, after);
  if (source.slice(p, p + 2) !== '<<') throw new Error('Inline image dictionary is missing');
  const dictEnd = findDictEnd(source, p + 2);
  const dict = parseInlineDict(source.slice(p + 2, dictEnd));
  p = skipWhite(source, dictEnd + 2);
  if (source.slice(p, p + 2) !== 'ID') throw new Error('Inline image data marker is missing');
  p += 2;
  if (!whitespace(source[p])) throw new Error('Inline image data is not separated from ID');
  p += 1;                              // exactly one white-space byte separates ID from data
  const width = Number(dict.W), height = Number(dict.H);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Inline image is missing a valid /W and /H');
  }
  const bpc = Number.isFinite(Number(dict.BPC)) ? Number(dict.BPC) : 8;
  if (![1, 2, 4, 8, 16].includes(bpc)) throw new Error('Inline image has an invalid /BPC');
  const filter = typeof dict.F === 'string' ? dict.F : null;
  let dataEnd = -1;
  if ('DP' in dict) dataEnd = p;                       // the data lives in the dictionary
  else if (filter === 'AHx') {
    const k = source.indexOf('>', p);
    if (k < 0) throw new Error('Inline image hex data is unterminated');
    dataEnd = k;
  } else if (!filter) {
    const comps = colorComponents(dict.CS);
    if (comps) {
      const rowBytes = Math.ceil(width * comps * bpc / 8);
      const candidate = p + rowBytes * height;
      if (candidate <= source.length && endsWithEI(source, candidate)) dataEnd = candidate;
    }
  }
  if (dataEnd < 0) dataEnd = findInlineEnd(source, p);
  if (dataEnd < 0) throw new Error('Inline image data end could not be determined');
  if (!endsWithEI(source, dataEnd)) throw new Error('Inline image is not terminated by EI');
  const end = skipWhite(source, dataEnd) + 2;
  out.push({ type: 'inline', start, end, dataStart: p, dataEnd, dict });
  return end;
}

/** Byte offsets are preserved; inline image data is measured, never guessed at. */
export function tokenizeImageContent(source) {
  if (typeof source !== 'string' || source.length > 8 * 1024 * 1024) throw new Error('Page stream exceeds image editor limit');
  const out = []; let i = 0;
  while (i < source.length) {
    if (out.length >= 200000) throw new Error('Too many page tokens');
    const start = i, c = source[i];
    if (whitespace(c)) { i++; continue; }
    if (c === '%') { while (i < source.length && !['\r', '\n'].includes(source[i])) i++; continue; }
    if (c === '(') {
      let depth = 1; i++;
      while (i < source.length && depth) { if (source[i] === '\\') { i += 2; continue; } if (source[i] === '(') depth++; if (source[i] === ')') depth--; i++; }
      if (depth) throw new Error('Unterminated PDF string');
      out.push({ type: 'value', start, end: i }); continue;
    }
    if (c === '<' && source[i + 1] !== '<') {
      const end = source.indexOf('>', i + 1); if (end < 0) throw new Error('Unterminated PDF hex string');
      if (!/^[0-9a-f\s]*$/i.test(source.slice(i + 1, end))) throw new Error('Invalid PDF hex string');
      i = end + 1; out.push({ type: 'value', start, end: i }); continue;
    }
    if (source.slice(i, i + 2) === '<<' || source.slice(i, i + 2) === '>>') {
      const value = source.slice(i, i + 2); i += 2; out.push({ type: 'delimiter', value, start, end: i }); continue;
    }
    if ('[]'.includes(c)) { i++; out.push({ type: 'delimiter', value: c, start, end: i }); continue; }
    if (c === '/') {
      i++; while (i < source.length && !delimiter(source[i])) i++;
      const raw = source.slice(start, i);
      if (/#(?![0-9a-f]{2})/i.test(raw)) throw new Error('Malformed escaped PDF name');
      const value = raw.slice(1).replace(/#([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
      out.push({ type: 'name', value, raw, start, end: i }); continue;
    }
    if (delimiter(c)) throw new Error('Unexpected PDF delimiter');
    while (i < source.length && !delimiter(source[i])) i++;
    const value = source.slice(start, i);
    if (value === 'BI') { i = readInlineImage(source, start, i, out); continue; }
    const numeric = /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value);
    out.push({ type: numeric ? 'number' : ['true', 'false', 'null'].includes(value) ? 'value' : 'operator', value: numeric ? Number(value) : value, start, end: i });
  }
  return out;
}

/* ── Object discovery ───────────────────────────────────────────────────────
 *  resources maps decoded PDF names to {kind:'image'|'form',…metadata}.
 *  options.resolveForm(name) may return {source, resources, matrix, bbox} for
 *  a Form XObject; the traversal then descends into it, composing the
 *  matrices so a child is reported in PAGE coordinates. */

function resourceKind(resources, name) {
  return Object.hasOwn(resources, name) ? resources[name] : null;
}

/** One content stream, plus the matrix its contents are placed in. */
function inspectStream(source, resources, ctx) {
  const tokens = tokenizeImageContent(source);
  const images = [], objects = [], unsupported = [], forms = {};
  let state = { matrix: I.slice(), clipped: false, textMode: 0 }, operands = [], stack = [], containers = [];
  let path = false;

  const pushImage = (token, name, rawName, resource, kind, span) => {
    const local = state.matrix.slice();
    const absolute = multiply(ctx.space, local);
    const corners = imageCorners(absolute);
    let singular = false; try { inverse(absolute); } catch { singular = true; }
    const img = {
      id: `${kind}:${ctx.streamKey}:${span[0]}:${span[1]}`,
      kind,
      name, rawName,
      start: span[0], end: span[1],
      streamKey: ctx.streamKey,
      container: ctx.path.slice(),
      local, space: ctx.space.slice(), matrix: absolute,
      corners, bounds: boundsOf(corners),
      clipped: state.clipped, pendingPath: path, singular,
      resource: resource ? { ...resource } : null,
      order: ctx.order.n++,
    };
    images.push(img); objects.push(img);
    return img;
  };

  for (const token of tokens) {
    if (token.type === 'delimiter') {
      const opening = ['[', '<<'].includes(token.value);
      if (opening) { containers.push(token.value); if (containers.length > 64) throw new Error('PDF container nesting too deep'); }
      else if (containers.pop() !== ({ ']': '[', '>>': '<<' }[token.value])) throw new Error('Unbalanced PDF container');
      operands.push(token); continue;
    }
    if (containers.length) { continue; }
    if (token.type === 'inline') {
      // An inline image is painted like any other image, in the unit square.
      const img = pushImage(token, 'inline', 'inline', { kind: 'inline', imageMask: false }, 'inline', [token.start, token.end]);
      img.inline = true;
      img.dict = token.dict;
      continue;
    }
    if (token.type !== 'operator') { operands.push(token); continue; }
    const op = token.value;
    if (op === 'q') {
      if (operands.length || stack.length >= 256) throw new Error('Invalid graphics-state stack');
      stack.push({ ...state, matrix: state.matrix.slice() });
    } else if (op === 'Q') {
      if (operands.length || !stack.length) throw new Error('Unbalanced graphics state');
      state = stack.pop();
    } else if (op === 'cm') {
      if (operands.length !== 6 || operands.some(t => t.type !== 'number' || !Number.isFinite(t.value))) throw new Error('Malformed cm operator');
      state.matrix = multiply(state.matrix, operands.map(t => t.value)); state.matrix.forEach(finite);
    } else if (op === 'W' || op === 'W*') { state.clipped = true; }
    else if (op === 'Tr') {
      if (operands.length !== 1 || operands[0].type !== 'number' || !Number.isInteger(operands[0].value) || operands[0].value < 0 || operands[0].value > 7) throw new Error('Malformed text rendering mode');
      state.textMode = operands[0].value;
    }
    else if (['Tj', 'TJ', "'", '"'].includes(op) && state.textMode >= 4) { state.clipped = true; }
    else if (['m', 'l', 'c', 'v', 'y', 're', 'h'].includes(op)) { path = true; }
    else if (['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n'].includes(op)) { path = false; }
    else if (op === 'Do') {
      if (operands.length !== 1 || operands[0].type !== 'name') throw new Error('Malformed XObject invocation');
      const operand = operands[0], resource = resourceKind(resources, operand.value);
      if (resource?.kind === 'image') {
        pushImage(token, operand.value, operand.raw, resource, 'image', [operand.start, token.end]);
      } else if (resource?.kind === 'form') {
        const form = ctx.resolveForm ? ctx.resolveForm(operand.value, resources, ctx.path) : null;
        if (!form) {
          unsupported.push({ name: operand.value, reason: 'nested-form' });
        } else if (ctx.path.includes(operand.value)) {
          unsupported.push({ name: operand.value, reason: 'recursive-form' });
        } else if (ctx.depth >= MAX_FORM_DEPTH) {
          unsupported.push({ name: operand.value, reason: 'form-too-deep' });
        } else {
          const formMatrix = form.matrix || I;
          const parentAbs = multiply(ctx.space, state.matrix);
          const absolute = multiply(parentAbs, formMatrix);
          const bbox = Array.isArray(form.bbox) && form.bbox.length === 4 ? form.bbox : [0, 0, 1, 1];
          const boxCorners = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]]
            .map(([x, y]) => [absolute[0] * x + absolute[2] * y + absolute[4], absolute[1] * x + absolute[3] * y + absolute[5]]);
          const group = {
            id: `form:${ctx.streamKey}:${operand.start}:${token.end}`,
            kind: 'form',
            name: operand.value, rawName: operand.raw,
            start: operand.start, end: token.end,
            streamKey: ctx.streamKey,
            container: ctx.path.slice(),
            local: state.matrix.slice(), space: ctx.space.slice(),
            parentAbs, formMatrix, matrix: absolute,
            bbox, corners: boxCorners, bounds: boundsOf(boxCorners),
            clipped: state.clipped, pendingPath: path, singular: false,
            resource: { ...resource },
            order: ctx.order.n++,
          };
          objects.push(group);
          const key = 'form:' + [...ctx.path, operand.value].join('/');
          const sub = inspectStream(form.source, form.resources || resources, {
            ...ctx,
            streamKey: key,
            path: [...ctx.path, operand.value],
            space: absolute,
            depth: ctx.depth + 1,
          });
          forms[key] = {
            key, name: operand.value, path: [...ctx.path, operand.value],
            source: form.source, resources: form.resources || resources,
            matrix: formMatrix, bbox, parentAbs,
            images: sub.images, objects: sub.objects,
          };
          images.push(...sub.images);
          objects.push(...sub.objects);
          unsupported.push(...sub.unsupported);
          group.childCount = sub.objects.length;
          Object.assign(forms, sub.forms);
        }
      } else {
        unsupported.push({ name: operand.value, reason: resource ? 'unsupported-xobject' : 'unresolved-xobject' });
      }
    }
    operands = [];
  }
  if (containers.length || stack.length || operands.length) throw new Error('Incomplete or unbalanced page stream');
  return { source, images, objects, forms, unsupported };
}

/**
 * Inspect one content stream and everything it draws.
 * options.resolveForm(name) -> {source, resources, matrix, bbox} | null
 */
export function inspectImagePlacements(source, resources, options = {}) {
  if (!resources || typeof resources !== 'object') throw new Error('Resolved XObject resources are required');
  const ctx = {
    streamKey: options.streamKey || 'page',
    path: [],
    space: I.slice(),
    depth: 0,
    resolveForm: options.resolveForm || null,
    order: { n: 0 },
  };
  const result = inspectStream(source, resources, ctx);
  return {
    source,
    resources,
    images: result.images,
    objects: result.objects,
    forms: result.forms,
    unsupported: result.unsupported,
    resolveForm: ctx.resolveForm,
  };
}

/** Transforms are applied about the object centre in page user space. */
export function changedImageMatrix(matrix, change, centre) {
  const dx = finite(change.dx ?? 0), dy = finite(change.dy ?? 0), sx = finite(change.scaleX ?? 1), sy = finite(change.scaleY ?? 1), angle = finite(change.rotation ?? 0) * Math.PI / 180;
  if (sx <= 0 || sy <= 0 || sx > 1000 || sy > 1000) throw new Error('Image scales must be positive and at most 1000');
  for (const key of ['flipX', 'flipY']) if (key in change && typeof change[key] !== 'boolean') throw new Error('Flip flags must be boolean');
  const cx = centre ? finite(centre[0]) : (matrix[0] + matrix[2]) / 2 + matrix[4];
  const cy = centre ? finite(centre[1]) : (matrix[1] + matrix[3]) / 2 + matrix[5];
  const c = Math.cos(angle), s = Math.sin(angle);
  return multiply(multiply(multiply(multiply([1, 0, 0, 1, cx + dx, cy + dy], [c, s, -s, c, 0, 0]), [sx * (change.flipX ? -1 : 1), 0, 0, sy * (change.flipY ? -1 : 1), 0, 0]), [1, 0, 0, 1, -cx, -cy]), matrix);
}

/** The stream that holds an object, and the resources that stream sees. */
function streamOf(snapshot, streamKey) {
  if (streamKey === 'page') return { source: snapshot.source, resources: snapshot.resources || {} };
  const form = snapshot.forms && snapshot.forms[streamKey];
  return form ? { source: form.source, resources: form.resources || {} } : null;
}

/**
 * Replace one placement, preserving every byte outside its source span.
 * The result carries the edited STREAM, not the whole file: a nested object
 * lives in its form's content stream, and the caller writes it back there.
 */
export function buildImageEdit(snapshot, id, change = {}) {
  const allowed = new Set(['dx', 'dy', 'scaleX', 'scaleY', 'rotation', 'flipX', 'flipY', 'delete', 'crop', 'opacity', 'replacementName', 'graphicsStateName']);
  if (!change || typeof change !== 'object' || Array.isArray(change) || Object.keys(change).some(k => !allowed.has(k))) throw new Error('Unknown image-edit option');
  const target = (snapshot.images || []).find(im => im.id === id);
  if (!target) throw new Error('Image placement no longer exists');
  const stream = streamOf(snapshot, target.streamKey);
  if (!stream) throw new Error('The stream holding this object is no longer available');
  const fresh = inspectImagePlacements(stream.source, stream.resources, {
    resolveForm: snapshot.resolveForm || null,
    streamKey: target.streamKey,
  });
  const image = fresh.images.find(im => im.id === id);
  if (!image) throw new Error('Image placement no longer exists');
  if ('delete' in change && typeof change.delete !== 'boolean') throw new Error('Delete flag must be boolean');
  let replacement;
  if (change.delete) {
    if (Object.keys(change).some(k => k !== 'delete')) throw new Error('Deletion cannot be mixed with other edits');
    replacement = '';
  } else {
    if (image.clipped || image.pendingPath || image.singular || image.resource?.imageMask) throw new Error('This image placement requires an unsupported clipping, path, mask, or transform operation');
    if (image.kind === 'inline' && 'replacementName' in change) throw new Error('An inline image cannot be replaced by a new image file');
    // The change is expressed in PAGE space, then mapped back into the space
    // of the stream that actually holds the bytes.
    const desired = changedImageMatrix(target.matrix, change);
    const newLocal = multiply(inverse(target.space), desired);
    const local = multiply(inverse(target.local), newLocal);
    const commands = ['q', local.map(number).join(' ') + ' cm'];
    if ('crop' in change) {
      const r = change.crop;
      if (!Array.isArray(r) || r.length !== 4 || r.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) || r[2] <= r[0] || r[3] <= r[1]) throw new Error('Image crop must be a nonempty normalized rectangle');
      commands.push([r[0], r[1], r[2] - r[0], r[3] - r[1]].map(number).join(' ') + ' re W n');
    }
    if ('opacity' in change) {
      if (typeof change.opacity !== 'number' || !Number.isFinite(change.opacity) || change.opacity < 0 || change.opacity > 1) throw new Error('Opacity must be in [0,1]');
      commands.push(resourceName(change.graphicsStateName) + ' gs');
    } else if ('graphicsStateName' in change) throw new Error('Unexpected graphics state name');
    if (image.kind === 'inline') {
      // The inline block keeps its bytes; only the transform around it changes.
      commands.push(stream.source.slice(image.start, image.end), 'Q');
    } else {
      commands.push((change.replacementName ? resourceName(change.replacementName) : image.rawName) + ' Do', 'Q');
    }
    replacement = commands.join('\n');
  }
  return {
    source: stream.source.slice(0, image.start) + replacement + stream.source.slice(image.end),
    imageId: id,
    removed: !!change.delete,
    streamKey: target.streamKey,
    start: image.start,
    end: image.end,
    replacement,
  };
}

/**
 * Move, resize, rotate, fade or delete a whole Form XObject group.
 * The group is changed in the PAGE stream — the form's own definition is left
 * alone — so a form shared by other pages is untouched.
 */
export function buildObjectEdit(snapshot, id, change = {}) {
  const allowed = new Set(['dx', 'dy', 'scaleX', 'scaleY', 'rotation', 'flipX', 'flipY', 'delete', 'opacity', 'graphicsStateName']);
  if (!change || typeof change !== 'object' || Array.isArray(change) || Object.keys(change).some(k => !allowed.has(k))) throw new Error('Unknown object-edit option');
  const group = (snapshot.objects || []).find(o => o.id === id);
  if (!group || group.kind !== 'form') throw new Error('That object is not an editable group');
  if (group.streamKey !== 'page') throw new Error('Only a group drawn directly on the page can be moved');
  if ('delete' in change && typeof change.delete !== 'boolean') throw new Error('Delete flag must be boolean');
  const span = [group.start, group.end];
  if (change.delete) {
    if (Object.keys(change).some(k => k !== 'delete')) throw new Error('Deletion cannot be mixed with other edits');
    return { source: snapshot.source.slice(0, span[0]) + snapshot.source.slice(span[1]), objectId: id, removed: true, streamKey: 'page', start: span[0], end: span[1], replacement: '' };
  }
  const bbox = group.bbox || [0, 0, 1, 1];
  const centre = [
    group.matrix[0] * ((bbox[0] + bbox[2]) / 2) + group.matrix[2] * ((bbox[1] + bbox[3]) / 2) + group.matrix[4],
    group.matrix[1] * ((bbox[0] + bbox[2]) / 2) + group.matrix[3] * ((bbox[1] + bbox[3]) / 2) + group.matrix[5],
  ];
  const desired = changedImageMatrix(group.matrix, change, centre);
  const local = multiply(multiply(inverse(group.parentAbs), desired), inverse(group.formMatrix));
  const commands = ['q', local.map(number).join(' ') + ' cm'];
  if ('opacity' in change) {
    if (typeof change.opacity !== 'number' || !Number.isFinite(change.opacity) || change.opacity < 0 || change.opacity > 1) throw new Error('Opacity must be in [0,1]');
    commands.push(resourceName(change.graphicsStateName) + ' gs');
  } else if ('graphicsStateName' in change) throw new Error('Unexpected graphics state name');
  commands.push(group.rawName + ' Do', 'Q');
  const replacement = commands.join('\n');
  return {
    source: snapshot.source.slice(0, span[0]) + replacement + snapshot.source.slice(span[1]),
    objectId: id,
    removed: false,
    streamKey: 'page',
    start: span[0],
    end: span[1],
    replacement,
  };
}
