/**
 * Minimal ZIP container writer (stored entries, no compression).
 *
 * OOXML (.docx/.xlsx) and EPUB are both "a ZIP with a fixed file layout", so a
 * dependency-free writer is all either format needs. Storing entries rather
 * than deflating keeps the code short and the output trivially valid; Word and
 * every EPUB reader accept stored entries.
 *
 * Extracted from app.js so the PDF→Word converter can share one implementation
 * (it used to be a private helper there, which an ES-module cycle would have
 * made awkward to reach).
 *
 * @param {{name: string, data: string}[]} files
 * @returns {Uint8Array}
 */
export function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = (bytes) => {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = enc.encode(f.data);
    const crc = crc32(data);
    // Local file header: 30 bytes, stored (uncompressed), no extra field.
    const lh = [
      0x50, 0x4b, 0x03, 0x04,       // signature
      20, 0,                        // version needed to extract
      0, 0,                         // general purpose flags
      0, 0,                         // method 0 = stored
      0, 0,                         // mod time
      0x21, 0,                      // mod date 1980-01-01 (day 0 is invalid)
      ...u32(crc),
      ...u32(data.length),
      ...u32(data.length),
      ...u16(nameBytes.length),
      0, 0,                         // extra field length
    ];
    parts.push(new Uint8Array(lh), nameBytes, data);
    // Central directory header: 46 bytes.
    const cd = [
      0x50, 0x4b, 0x01, 0x02,       // signature
      20, 0,                        // version made by
      20, 0,                        // version needed
      0, 0,                         // flags
      0, 0,                         // method
      0, 0,                         // mod time
      0x21, 0,                      // mod date
      ...u32(crc),
      ...u32(data.length),
      ...u32(data.length),
      ...u16(nameBytes.length),
      0, 0,                         // extra field length
      0, 0,                         // comment length
      0, 0,                         // disk number start
      0, 0,                         // internal attributes
      0, 0, 0, 0,                   // external attributes
      ...u32(offset),               // offset of the local header
    ];
    central.push(new Uint8Array(cd), nameBytes);
    offset += lh.length + nameBytes.length + data.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) { parts.push(c); cdSize += c.length; }
  const end = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(cdStart), 0, 0]);
  parts.push(end);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
