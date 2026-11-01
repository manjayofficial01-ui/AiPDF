/**
 * Crash-safe file writing for the main process.
 *
 * `fs.writeFile(path)` truncates the target first and then fills it, so a power
 * loss, a kill, or a full disk halfway through leaves a short, unreadable file
 * where the user's document used to be. The failure mode is not an error
 * message — it is the loss of the file they were editing.
 *
 * Here the bytes land in a sibling temp file, are flushed to the device, and
 * only then move onto the target with a rename, which is atomic inside one
 * directory. Either the old file or the new one is always whole.
 *
 * `backup` additionally copies the previous revision to `<name>.bak` before the
 * swap. The order matters — temp, backup, rename — and a rename that fails after
 * a successful backup puts the original back rather than leaving the path empty.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function tmpPathFor(filePath) {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.aipdf-tmp`);
}

async function safeWrite(filePath, buf, opts = {}) {
  const backup = !!opts.backup;
  const bak = filePath + '.bak';
  const tmp = tmpPathFor(filePath);
  let backupMade = false;
  try {
    const handle = await fs.promises.open(tmp, 'w');
    try {
      await handle.writeFile(buf);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (backup && fs.existsSync(filePath)) {
      await fs.promises.copyFile(filePath, bak);
      backupMade = true;
    }
    await fs.promises.rename(tmp, filePath);
    return { path: filePath, size: buf.length, backup: backupMade ? bak : null };
  } catch (err) {
    // Never leave a stray temp file behind in the user's folder.
    try { await fs.promises.unlink(tmp); } catch { /* not created */ }
    if (backupMade && !fs.existsSync(filePath)) {
      try { await fs.promises.copyFile(bak, filePath); } catch { /* report the original failure */ }
    }
    throw err;
  }
}

module.exports = { safeWrite, tmpPathFor };
