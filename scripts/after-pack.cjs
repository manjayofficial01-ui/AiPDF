/**
 * electron-builder `afterPack` hook — verify the asar before an installer is
 * ever produced.
 *
 * v2.22.0 shipped with 23 bytes missing from the middle of `app.asar`. The
 * header was intact and every size matched, so nothing complained: the only
 * symptom was that the renderer server could not read `src/renderer/js/zip.js`,
 * the module graph died, and the app opened with an empty ribbon and no tab
 * labels. Running the byte-for-byte check here turns that into a failed build.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const asar = path.join(context.appOutDir, 'resources', 'app.asar');
  const checker = path.join(__dirname, 'asar-check.mjs');
  console.log('  • verifying asar integrity');
  execFileSync(process.execPath, [checker, asar], { stdio: 'inherit' });
};
