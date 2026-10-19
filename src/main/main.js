const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { start } = require('./server');
const { buildMenu } = require('./menu');
const { buildFontIndex, defaultDirs } = require('./fontindex');

// Milestone tracing for startup debugging. Off by default so normal launches
// never touch the filesystem; enable with --trace (or --dev).
const TRACE = path.join(__dirname, '..', '..', '.smoke', 'launch-trace.txt');
const t0 = Date.now();
function trace(m) {
  // Self-contained: isDev is declared further down, so don't reference it here.
  if (!(process.argv.includes('--dev') || process.argv.includes('--trace'))) return;
  try {
    fs.mkdirSync(path.dirname(TRACE), { recursive: true });
    fs.appendFileSync(TRACE, `+${Date.now() - t0}ms ${m}\n`);
  } catch { /* ignore */ }
}
trace(`argv=${JSON.stringify(process.argv.slice(1))}`);

let win = null;
let serverInfo = null;
let pendingOpenPath = null;
let allowClose = false;

// Window chrome metrics, shared with the renderer over the `boot` IPC so the
// CSS never has to guess. The stylesheet used to reserve a magic 138px for the
// Windows caption buttons and hardcode a 36px titlebar in a different process;
// if either changed, the caption buttons misaligned against the titlebar row.
const TITLEBAR_OVERLAY_HEIGHT = 36;
const CAPTION_BUTTON_WIDTH = 46;
const CAPTION_BUTTONS = 3;

// Atelier surfaces. These must match --bg-app in the active theme layer
// (src/renderer/css/theme-claude.css) or the window flashes the wrong colour
// between creation and first paint.
const ATELIER = {
  light: { bg: '#f3eddf', symbol: '#3a332b' },
  dark: { bg: '#15120e', symbol: '#ece6dc' },
};

/** Resolve dark/light from the *saved* preference, falling back to the OS. Using
 *  nativeTheme alone flashed the wrong background for anyone whose app theme
 *  disagreed with their system theme. */
function initialDark() {
  const file = loadSettings();
  const s = file && file.settings && typeof file.settings === 'object' ? file.settings : file;
  const theme = (s && s.theme) || 'system';
  return theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
}

const isDev = process.argv.includes('--dev');

/** Flags that run a headless assertion pass and then quit instead of
 *  opening the normal editor window. */
const isTestMode = ['--boot-test', '--functional-test', '--edit-test', '--parity-test', '--ocr-test', '--ai-test', '--agent-test'].some((f) => process.argv.includes(f));

/** Test modes also write their result to .smoke/<name>.json — GUI-subsystem
 *  apps on Windows detach from the console, so stdout alone is unreliable. */
function reportTest(name, payload) {
  try {
    const dir = path.join(app.getAppPath(), '.smoke');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(payload, null, 2));
  } catch { /* best effort */ }
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}
function saveSettings(s) {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
  } catch {
    /* ignore */
  }
}

/** Rebuild the native menu from current settings. The Open Recent submenu is
 *  built by hand because the `recentDocuments` role is macOS-only and renders
 *  inert on Windows, so it has to be refreshed whenever recents change. */
function rebuildMenu() {
  if (!win) return;
  const s = loadSettings();
  Menu.setApplicationMenu(
    buildMenu(
      (action, payload) => {
        if (win) win.webContents.send('menu:action', action, payload);
      },
      { recents: Array.isArray(s.recents) ? s.recents : [] }
    )
  );
}

function createWindow(url, show = true) {
  const dark = initialDark();
  const skin = dark ? ATELIER.dark : ATELIER.light;
  // Resolve the icon relative to the app path so it works both in `npm start`
  // (project root) and in the packaged asar. electron-builder does NOT copy
  // assets/ on its own — `build.files` must list assets/icon.ico explicitly, or
  // this path silently misses inside app.asar and the window falls back to the
  // generic Electron icon. scripts/icon-pack-test.mjs guards that.
  const iconPath = path.join(app.getAppPath(), 'assets', 'icon.ico');
  const hasIcon = (() => { try { return require('node:fs').statSync(iconPath).size > 0; } catch { return false; } })();
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: skin.bg,
    show: false,
    frame: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: skin.symbol,
      height: TITLEBAR_OVERLAY_HEIGHT,
    },
    autoHideMenuBar: true,
    ...(hasIcon ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  if (isDev) {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer ${level}] ${message}  (${sourceId}:${line})`);
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => console.error('[load failed]', code, desc));
    win.webContents.openDevTools({ mode: 'detach' });
  }

  trace(`createWindow show=${show} url=${url}`);
  win.loadURL(url);
  win.webContents.on('dom-ready', () => trace('dom-ready'));
  win.webContents.on('did-finish-load', () => trace('did-finish-load'));
  win.webContents.on('did-fail-load', (_e, c, d) => trace(`did-fail-load ${c} ${d}`));
  win.on('show', () => trace('window show event'));

  // Reveal the window as soon as it is safe. 'ready-to-show' waits for the
  // compositor's first paint, which never arrives when the GPU process is
  // unstable — the window then stays hidden forever and the app looks like it
  // simply never opened. Treat it as the fast path only, and guarantee the
  // reveal via 'did-finish-load' plus a hard timeout.
  let revealed = false;
  const reveal = () => {
    if (revealed || !show) return;
    if (!win || win.isDestroyed()) return;
    revealed = true;
    trace('reveal');
    // Test modes must still be mapped, or the compositor produces no frames:
    // pdf.js schedules its render chunks on requestAnimationFrame, so a window
    // that is never shown makes every render assertion time out while the test
    // still reports zero errors. showInactive keeps focus with the caller.
    if (isTestMode) win.showInactive();
    else win.show();
  };
  win.once('ready-to-show', () => { trace('ready-to-show'); reveal(); });
  win.webContents.once('did-finish-load', () => setTimeout(reveal, 120));
  setTimeout(reveal, 2500);

  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    win.webContents.send('app:willClose');
  });

  win.on('closed', () => {
    win = null;
  });

  // Open external links in the OS browser, never in the app.
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith('http')) shell.openExternal(u);
    return { action: 'deny' };
  });

  return win;
}

/** Resolve a file path handed to us at launch (CLI arg or "open with"). */
function resolveStartupPath(argv) {
  const candidates = argv.slice(isDev ? 2 : 1);
  for (const c of candidates) {
    if (!c || c.startsWith('--') || c.startsWith('-')) continue;
    const abs = path.resolve(c);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  }
  return null;
}

async function boot() {
  // Headless test runs get their own userData: they never fight the
  // single-instance lock of a real, open app window, and they don't touch
  // the user's real settings/recents.
  if (isTestMode) {
    app.setPath('userData', path.join(app.getPath('userData'), 'headless-test'));
  }
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    reportTest('boot-test', { error: 'single-instance lock denied (another AiPDF instance is running)' });
    app.quit();
    return;
  }
  app.on('second-instance', (_e, argv) => {
    const p = resolveStartupPath(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (p) win.webContents.send('app:openPath', p);
    } else {
      pendingOpenPath = p;
    }
  });

  // Software rendering by default. The GPU process on some hosts is unstable:
  // it can die outright (Chromium then aborts the app) or stall the first
  // paint so 'ready-to-show' never fires. pdf.js draws through canvas 2D
  // (CPU) anyway, so this costs nothing and makes startup deterministic.
  // Pass --gpu to opt back into hardware acceleration.
  if (!process.argv.includes('--gpu')) app.disableHardwareAcceleration();
  // On some Windows hosts/VMs the sandboxed GPU process dies with an access
  // violation and Chromium then aborts the whole app ("GPU process isn't
  // usable. Goodbye.") instead of falling back. Disabling *only* the GPU
  // sandbox avoids that while keeping the renderer sandbox intact.
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  if (process.argv.includes('--no-sandbox')) app.commandLine.appendSwitch('no-sandbox');
  // Windows occlusion tracking marks covered/minimised windows as hidden,
  // which starves requestAnimationFrame — and pdf.js schedules its render
  // loop on rAF, so pages stop rendering whenever the app window is covered.
  // Disabling the occlusion calculation keeps rendering alive; the only cost
  // is a little power efficiency while the window is fully covered.
  if (process.platform === 'win32') {
    app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  }

  await app.whenReady();
  trace('app ready');

  // Honour the saved preference rather than defaulting to the OS theme and
  // letting the renderer flip it a moment later — that flip was visible.
  {
    const file = loadSettings();
    const st = file && file.settings && typeof file.settings === 'object' ? file.settings : file;
    const theme = (st && st.theme) || 'system';
    nativeTheme.themeSource = theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'system';
  }

  serverInfo = await start();
  // Always reveal. Test modes reveal *inactive* (see createWindow) rather than
  // staying hidden: an unmapped window gets no compositor frames under software
  // rendering, which made page0Rendered / rafFires / inlineRender fail (or time
  // out) in the functional and OCR gates while still reporting zero errors.
  const w = createWindow(serverInfo.url, true);

  // Headless boot smoke-test: confirm the renderer links and initializes
  // without runtime errors, then quit. Used by `npm run boot-test`.
  if (process.argv.includes('--boot-test')) {
    const errs = [];
    w.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 2) errs.push(`[renderer ${level}] ${message}  (${sourceId}:${line})`);
    });
    w.webContents.on('did-fail-load', (_e, code, desc) => errs.push(`[load failed] ${code} ${desc}`));
    await new Promise((r) => setTimeout(r, 5000));
    const booted = await w.webContents.executeJavaScript('!!window.__aipdfBooted').catch(() => false);
    const rail = await w.webContents.executeJavaScript('!!document.getElementById("rail")').catch(() => false);
    const modules = await w.webContents.executeJavaScript(
      '({ ocr: !!window.__aipdfOcrReady, fonts: !!window.__aipdfFontsReady })'
    ).catch(() => ({}));
    console.log(`BOOT_TEST booted=${booted} rail=${rail} errors=${errs.length}`);
    if (errs.length) console.log(errs.join('\n'));
    reportTest('boot-test', { booted, rail, errors: errs, modules });
    setTimeout(() => app.quit(), 100);
    return;
  }

  // Headless functional test: open a fixture PDF and verify the view
  // pipeline (pdf.js parse, text extraction, annotation read-back, form
  // field read-back). Pass the path as the arg after --functional-test.
  if (process.argv.includes('--functional-test')) {
    const fixture = process.argv[process.argv.indexOf('--functional-test') + 1];
    const errs = [];
    const warns = [];
    w.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 2) errs.push(`[renderer ${level}] ${message}  (${sourceId}:${line})`);
      else if (level >= 1 && warns.length < 60) warns.push(message.slice(0, 300));
    });
    w.webContents.on('did-fail-load', (_e, code, desc) => errs.push(`[load failed] ${code} ${desc}`));
    // Wait until the renderer has finished booting, then open the fixture.
    for (let i = 0; i < 50; i++) {
      if (await w.webContents.executeJavaScript('!!window.__aipdfBooted').catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await w.webContents.executeJavaScript('window.__aipdfVerbosity = 5').catch(() => {});
    if (fixture) w.webContents.send('app:openPath', fixture);
    await new Promise((r) => setTimeout(r, 7000));
    const report = await w.webContents.executeJavaScript('window.__aipdfGetTestReport ? window.__aipdfGetTestReport() : null').catch((e) => ({ execError: e.message }));
    // Diagnose the render pipeline: does requestAnimationFrame fire at all
    // (pdf.js schedules render chunks on rAF; a hidden/occluded window can
    // starve it) and did the first page render finish?
    report.rafFires = await w.webContents.executeJavaScript(
      'new Promise((res) => { const t = setTimeout(() => res(false), 3000); requestAnimationFrame(() => { clearTimeout(t); res(true); }); })'
    ).catch((e) => 'exec-error:' + e.message);
    // Minimal in-app render probe: fresh document + one render, raced on 15s.
    report.inlineRender = await w.webContents.executeJavaScript(`(async () => {
      try {
        const pdfjs = await import('/v/pdf.min.mjs');
        pdfjs.GlobalWorkerOptions.workerSrc = '/v/pdf.worker.min.mjs';
        const r2 = await fetch('/js/../js/app.js').catch(() => null);
        const buf = await (await fetch('/index.html')).arrayBuffer();
        const pdfbytes = new Uint8Array(await (await fetch('/fixture-render-src.pdf')).arrayBuffer());
        const doc = await pdfjs.getDocument({ data: pdfbytes, standardFontDataUrl: '/v/stdfonts/' }).promise;
        const page = await doc.getPage(1);
        const vp = page.getViewport({ scale: 1.5 });
        const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
        const t = await Promise.race([page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise,
          new Promise((res) => setTimeout(() => res('TIMEOUT'), 15000))]);
        return t && typeof t === 'object' ? 'ok' : t;
      } catch (e) { return 'err: ' + e.message; }
    })()`).catch((e) => 'exec-error:' + e.message);
    console.log('FUNC_TEST ' + JSON.stringify(report));
    console.log('FUNC_ERRORS ' + errs.length);
    if (errs.length) console.log(errs.join('\n'));
    reportTest('functional-test', { report, errors: errs, warnings: warns });
    setTimeout(() => app.quit(), 100);
    return;
  }

  // Headless edit→save→reopen test: open the fixture, run the renderer's
  // edit cycle (add annotation, build, write, reopen), and report.
  if (process.argv.includes('--edit-test')) {
    const fixture = process.argv[process.argv.indexOf('--edit-test') + 1];
    const errs = [];
    w.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 2) errs.push(`[renderer ${level}] ${message}  (${sourceId}:${line})`);
    });
    w.webContents.on('did-fail-load', (_e, code, desc) => errs.push(`[load failed] ${code} ${desc}`));
    for (let i = 0; i < 50; i++) {
      if (await w.webContents.executeJavaScript('!!window.__aipdfBooted').catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (fixture) w.webContents.send('app:openPath', fixture);
    await new Promise((r) => setTimeout(r, 5000));
    const cycle = await w.webContents.executeJavaScript('window.__aipdfRunEditCycle ? window.__aipdfRunEditCycle() : null').catch((e) => ({ execError: e.message }));
    console.log('EDIT_TEST ' + JSON.stringify(cycle));
    console.log('EDIT_ERRORS ' + errs.length);
    if (errs.length) console.log(errs.join('\n'));
    reportTest('edit-test', { cycle, errors: errs });
    setTimeout(() => app.quit(), 100);
    return;
  }

  // Headless Foxit-parity test: opens the fixture and runs the renderer's
  // one-case-per-tool parity suite (new annotation shapes → save → reopen,
  // find & replace, structural page ops with struct undo/redo, Convert
  // exporters). See window.__aipdfRunParityTest in app.js.
  if (process.argv.includes('--parity-test')) {
    const fixture = process.argv[process.argv.indexOf('--parity-test') + 1];
    const errs = [];
    w.webContents.on('console-message', (_e, level, message, sourceId, line) => {
      if (level >= 2) errs.push(`[renderer ${level}] ${message}  (${sourceId}:${line})`);
    });
    w.webContents.on('did-fail-load', (_e, code, desc) => errs.push(`[load failed] ${code} ${desc}`));
    for (let i = 0; i < 50; i++) {
      if (await w.webContents.executeJavaScript('!!window.__aipdfBooted').catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (fixture) w.webContents.send('app:openPath', fixture);
    await new Promise((r) => setTimeout(r, 5000));
    const result = await w.webContents.executeJavaScript('window.__aipdfRunParityTest ? window.__aipdfRunParityTest() : null').catch((e) => ({ execError: e.message }));
    console.log('PARITY_TEST ' + JSON.stringify(result));
    console.log('PARITY_ERRORS ' + errs.length);
    if (errs.length) console.log(errs.join('\n'));
    reportTest('parity-test', { result, errors: errs });
    setTimeout(() => app.quit(), 100);
    return;
  }

  // Headless OCR test: opens the fixture and runs Tesseract on page 1.
  // The first run downloads the English language pack (~11 MB) from the
  // tessdata CDN — later runs use the local IndexedDB cache.
  if (process.argv.includes('--ocr-test')) {
    const fixture = process.argv[process.argv.indexOf('--ocr-test') + 1];
    const errs = [];
    w.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 2) errs.push(`[renderer ${level}] ${message}  (${sourceId}:${line})`);
    });
    w.webContents.on('did-fail-load', (_e, code, desc) => errs.push(`[load failed] ${code} ${desc}`));
    for (let i = 0; i < 50; i++) {
      if (await w.webContents.executeJavaScript('!!window.__aipdfBooted').catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (fixture) w.webContents.send('app:openPath', fixture);
    await new Promise((r) => setTimeout(r, 5000));
    // Kick off the OCR run, then poll progress so slow first-run downloads
    // (language pack ~11 MB) are visible in the log.
    const runPromise = w.webContents.executeJavaScript('window.__aipdfRunOcrTest ? window.__aipdfRunOcrTest() : null').catch((e) => ({ execError: e.message }));
    let result = null;
    for (let i = 0; i < 36; i++) {
      result = await Promise.race([runPromise, new Promise((r) => setTimeout(() => r(null), 5000))]);
      if (result) break;
      const progress = await w.webContents.executeJavaScript('JSON.stringify(window.__aipdfOcrProgress || [])').catch(() => '[]');
      console.log(`OCR_WAIT ${(i + 1) * 5}s progress=${progress}`);
    }
    if (!result) result = { error: 'OCR timed out after 180s' };
    console.log('OCR_TEST ' + JSON.stringify(result));
    console.log('OCR_ERRORS ' + errs.length);
    reportTest('ocr-test', { result, errors: errs });
    setTimeout(() => app.quit(), 100);
    return;
  }

  // Headless AI self-test: pure-logic checks of the OpenAI-compatible provider
  // layer (auth-header mapping, custom headers, endpoint building, model-list
  // parsing, Smart Context relevance ranking). No network calls are made.
  if (process.argv.includes('--ai-test')) {
    const errs = [];
    w.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 2) errs.push(`[renderer ${level}] ${message}  (${sourceId}:${line})`);
    });
    w.webContents.on('did-fail-load', (_e, code, desc) => errs.push(`[load failed] ${code} ${desc}`));
    for (let i = 0; i < 50; i++) {
      if (await w.webContents.executeJavaScript('!!window.__aipdfBooted').catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const result = await w.webContents.executeJavaScript('window.__aipdfAiSelfTest ? window.__aipdfAiSelfTest() : null')
      .catch((e) => ({ execError: e.message }));
    console.log('AI_TEST ' + JSON.stringify(result));
    console.log('AI_ERRORS ' + errs.length);
    if (errs.length) console.log(errs.join('\n'));
    reportTest('ai-test', { result, errors: errs });
    setTimeout(() => app.quit(), 100);
    return;
  }

  // Headless agent self-test (--agent-test): the agentic tool layer's
  // pure-logic checks (tool registry, page-range parsing, schema shape).
  // No model, no network.
  if (process.argv.includes('--agent-test')) {
    const errs = [];
    w.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 2) errs.push(`[renderer ${level}] ${message}  (${sourceId}:${line})`);
    });
    w.webContents.on('did-fail-load', (_e, code, desc) => errs.push(`[load failed] ${code} ${desc}`));
    for (let i = 0; i < 50; i++) {
      if (await w.webContents.executeJavaScript('!!window.__aipdfBooted').catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const result = await w.webContents.executeJavaScript('window.__aipdfAgentSelfTest ? window.__aipdfAgentSelfTest() : null')
      .catch((e) => ({ execError: e.message }));
    console.log('AGENT_TEST ' + JSON.stringify(result));
    console.log('AGENT_ERRORS ' + errs.length);
    if (errs.length) console.log(errs.join('\n'));
    reportTest('agent-test', { result, errors: errs });
    setTimeout(() => app.quit(), 100);
    return;
  }

  rebuildMenu();
  trace('application menu set');

  // Forward accelerator-driven actions coming from the native menu.
  ipcMain.on('menu:forward', (_e, action, payload) => {
    if (win) win.webContents.send('menu:action', action, payload);
  });

  if (pendingOpenPath) {
    w.webContents.once('did-finish-load', () => {
      w.webContents.send('app:openPath', pendingOpenPath);
      pendingOpenPath = null;
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(serverInfo.url);
  });
}

/* ------------------------------------------------------------------ IPC */

ipcMain.handle('boot', () => ({
  // In headless test modes the fixture is opened via app:openPath after boot;
  // returning it here as well would open the document twice.
  startupPath: isTestMode ? null : resolveStartupPath(process.argv),
  // The renderer must know it is being driven headlessly: a dirty document
  // would otherwise raise the "save before quitting?" modal, which nobody is
  // there to answer, and the test process would never exit.
  testMode: isTestMode,
  version: app.getVersion(),
  platform: process.platform,
  home: os.homedir(),
  settings: loadSettings(),
  dev: isDev,
  chrome: {
    overlayHeight: TITLEBAR_OVERLAY_HEIGHT,
    captionWidth: CAPTION_BUTTON_WIDTH * CAPTION_BUTTONS,
  },
}));

ipcMain.handle('app:ready', () => {
  const p = resolveStartupPath(process.argv);
  return p;
});

ipcMain.handle('app:path', (_e, name) => {
  try {
    return app.getPath(name);
  } catch {
    return os.homedir();
  }
});

ipcMain.handle('dialog:open', async (_e, opts = {}) => {
  const res = await dialog.showOpenDialog(win, {
    properties: opts.multiSelections ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: opts.filters || [
      { name: 'PDF Documents', extensions: ['pdf'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    defaultPath: opts.defaultPath,
    title: opts.title,
  });
  return res.canceled ? null : res.filePaths;
});

ipcMain.handle('dialog:save', async (_e, opts = {}) => {
  const res = await dialog.showSaveDialog(win, {
    title: opts.title || 'Save PDF',
    defaultPath: opts.defaultPath,
    filters: opts.filters || [{ name: 'PDF Document', extensions: ['pdf'] }],
  });
  return res.canceled ? null : res.filePath;
});

ipcMain.handle('dialog:message', async (_e, opts = {}) => {
  const res = await dialog.showMessageBox(win, {
    type: opts.type || 'info',
    title: opts.title || 'AiPDF Editor',
    message: opts.message || '',
    detail: opts.detail || '',
    buttons: opts.buttons || ['OK'],
    defaultId: 0,
    cancelId: opts.buttons ? opts.buttons.length - 1 : 0,
  });
  return res.response;
});

ipcMain.handle('fs:read', async (_e, filePath) => {
  try {
    const buf = await fs.promises.readFile(filePath);
    return { ok: true, data: new Uint8Array(buf) };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('fs:write', async (_e, filePath, data) => {
  try {
    const buf = Buffer.from(data);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, buf);
    return { ok: true, path: filePath, size: buf.length };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('fs:exists', async (_e, filePath) => fs.existsSync(filePath));

/**
 * Delete one file from the user-fonts directory, and nothing else.
 *
 * The renderer already has an unrestricted fs:write, so a general fs:delete would
 * widen an existing hole for no benefit. Font removal only ever targets a bare
 * filename inside userData/fonts, so that is all this will accept.
 */
ipcMain.handle('font:delete', async (_e, fileName) => {
  const safe = String(fileName || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safe) || safe.includes('..')) {
    return { ok: false, error: 'Invalid font file name.' };
  }
  const target = path.join(app.getPath('userData'), 'fonts', safe);
  try {
    await fs.promises.rm(target, { force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

/**
 * List the fonts installed on this machine so the user can pick one without
 * hunting for its file. Takes ~450 ms for a few hundred faces, so the result is
 * memoised for the session; `refresh` forces a rescan after a font install.
 */
let systemFontIndex = null;
ipcMain.handle('fonts:system', async (_e, refresh) => {
  if (systemFontIndex && !refresh) return systemFontIndex;
  const dirs = defaultDirs(process.env, process.platform);
  if (!dirs.length) return { faces: [], skippedCollections: 0, dirs, unsupported: true };
  const { faces, skippedCollections } = buildFontIndex(dirs);
  systemFontIndex = { faces, skippedCollections, dirs, unsupported: false };
  return systemFontIndex;
});

ipcMain.handle('fs:info', async (_e, filePath) => {
  try {
    const st = await fs.promises.stat(filePath);
    return {
      ok: true,
      size: st.size,
      mtime: st.mtimeMs,
      name: path.basename(filePath),
      dir: path.dirname(filePath),
      ext: path.extname(filePath).toLowerCase(),
    };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle('shell:show', (_e, p) => {
  if (p) shell.showItemInFolder(p);
});

ipcMain.handle('shell:open', async (_e, p) => {
  if (p) return shell.openPath(p);
  return '';
});

ipcMain.handle('print', async (_e, opts = {}) => {
  return new Promise((resolve) => {
    if (!win) return resolve({ ok: false, error: 'no window' });
    win.webContents.print(
      {
        silent: !!opts.silent,
        printBackground: true,
        margins: { marginType: opts.marginType || 'default' },
        pageSize: opts.pageSize,
        copies: opts.copies || 1,
      },
      (success, reason) => resolve({ ok: success, error: reason })
    );
  });
});

ipcMain.handle('win:setTitle', (_e, title) => {
  if (win) win.setTitle(title || 'AiPDF Editor');
});

ipcMain.handle('win:setRepresented', (_e, p) => {
  if (win && p) {
    win.setRepresentedFilename(p);
    app.addRecentDocument(p);
  }
});

ipcMain.handle('win:setTheme', (_e, mode) => {
  nativeTheme.themeSource = mode === 'dark' ? 'dark' : mode === 'light' ? 'light' : 'system';
  const dark = nativeTheme.shouldUseDarkColors;
  // The renderer used to toggle body.dark without ever telling us, so
  // nativeTheme stayed on 'system' and the Windows caption glyphs kept the
  // colour they were created with — invisible caption buttons in dark mode.
  if (process.platform === 'win32' && win && !win.isDestroyed()) {
    try {
      win.setTitleBarOverlay({
        color: '#00000000',
        symbolColor: dark ? '#ece6dc' : '#3a332b',
        height: TITLEBAR_OVERLAY_HEIGHT,
      });
    } catch { /* overlay not available on this window */ }
  }
  return dark;
});

ipcMain.handle('win:zoom', (_e, factor) => {
  if (win) win.webContents.setZoomFactor(factor);
});

ipcMain.handle('store:get', (_e, key, fallback) => {
  const s = loadSettings();
  return key in s ? s[key] : fallback;
});

ipcMain.handle('store:set', (_e, key, value) => {
  const s = loadSettings();
  s[key] = value;
  saveSettings(s);
  if (key === 'recents') rebuildMenu();
  return true;
});

/* ---------------------------------------------------------- AI proxy
   The renderer talks to OpenAI-compatible endpoints through the main process.
   Running the HTTP call here (a) sidesteps renderer CORS — many self-hosted and
   gateway servers send no CORS headers — and (b) keeps custom headers / auth
   handling in one place. Node's global fetch is available in Electron 33. */

ipcMain.handle('ai:models', async (_e, opts = {}) => {
  try {
    const res = await fetch(opts.url, { method: 'GET', headers: opts.headers || {} });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 400) };
    let json = {};
    try { json = JSON.parse(text); } catch { return { ok: false, status: res.status, error: 'Invalid JSON from the models endpoint.' }; }
    const raw = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
    const models = raw
      .map((m) => {
        if (typeof m === 'string') return m;
        // Google Gemini lists embedding/tts models here too — only keep the
        // ones that can actually answer a generateContent call.
        if (m && Array.isArray(m.supportedGenerationMethods) && !m.supportedGenerationMethods.includes('generateContent')) return '';
        return String((m && (m.id || m.name)) || '').replace(/^models\//, '');
      })
      .filter(Boolean);
    models.sort((a, b) => a.localeCompare(b));
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('ai:chat', async (_e, opts = {}) => {
  try {
    const res = await fetch(opts.url, {
      method: 'POST',
      headers: opts.headers || {},
      body: JSON.stringify(opts.body || {}),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: t.slice(0, 500) };
    }
    if (!opts.stream) {
      const j = await res.json();
      // `raw` hands the full response body back to the renderer — the Gemini
      // protocol is parsed there (candidates/parts), while the OpenAI shape is
      // already answered here.
      if (opts.raw) return { ok: true, json: j };
      // Some gateways (Claude-style, notably) return content as an array of
      // typed parts instead of a string — flatten to plain text or every
      // string method downstream explodes.
      const c = j.choices?.[0]?.message?.content;
      const text = typeof c === 'string'
        ? c
        : Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('') : (c ? String(c) : '');
      return { ok: true, text };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let out = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const l = line.trim();
        if (!l.startsWith('data:')) continue;
        const payload = l.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          // OpenAI streams deltas; Gemini SSE frames each carry full candidate
          // parts — accept both shapes in one place.
          const d = j.choices?.[0]?.delta?.content
            || j.choices?.[0]?.text
            || (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
          if (d) {
            out += d;
            if (win && !win.isDestroyed()) win.webContents.send('ai:stream', { reqId: opts.reqId, delta: d, text: out });
          }
        } catch { /* partial frame */ }
      }
    }
    return { ok: true, text: out };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

// TTS proxy (Read Aloud). Unlike ai:chat this must return BINARY audio from
// ElevenLabs / Fish Audio / OpenAI-compatible endpoints, base64-JSON from
// Mistral, and raw JSON from voice-list endpoints — so it hands the renderer
// base64 + content type and lets tts.js decode per provider. Same no-CORS,
// custom-header-honoured rules as the chat proxy.
ipcMain.handle('tts:request', async (_e, opts = {}) => {
  try {
    const res = await fetch(opts.url, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: opts.headers || {},
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: t.slice(0, 500) };
    }
    if (opts.expect === 'json') {
      return { ok: true, json: await res.json() };
    }
    const buf = await res.arrayBuffer();
    let b64 = '';
    const bytes = new Uint8Array(buf);
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      b64 += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    }
    return { ok: true, audioBase64: b64, contentType: res.headers.get('content-type') || 'audio/mpeg' };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('app:confirmClose', () => {
  allowClose = true;
  if (win) win.close();
  app.quit();
});

ipcMain.handle('app:cancelClose', () => true);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

boot().catch((err) => {
  console.error('[AiPDF] boot failed', err);
  reportTest('boot-test', { error: String(err && err.stack ? err.stack : err) });
  app.quit();
});
