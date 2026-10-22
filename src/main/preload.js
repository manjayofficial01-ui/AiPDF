const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /** Boot info supplied by the main process. */
  boot: () => ipcRenderer.invoke('boot'),

  /** Absolute path for a File object from drag & drop (File.path was removed in Electron 32+). */
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },

  openDialog: (opts) => ipcRenderer.invoke('dialog:open', opts),
  saveDialog: (opts) => ipcRenderer.invoke('dialog:save', opts),
  messageBox: (opts) => ipcRenderer.invoke('dialog:message', opts),

  readFile: (filePath) => ipcRenderer.invoke('fs:read', filePath),
  writeFile: (filePath, data) => ipcRenderer.invoke('fs:write', filePath, data),
  /** Mark a drag & dropped file as openable/saveable (see fs:grantDrop). */
  grantDroppedFile: (filePath) => ipcRenderer.invoke('fs:grantDrop', filePath),
  fileExists: (filePath) => ipcRenderer.invoke('fs:exists', filePath),
  deleteFontFile: (fileName) => ipcRenderer.invoke('font:delete', fileName),
  listSystemFonts: (refresh) => ipcRenderer.invoke('fonts:system', refresh),

  print: (opts) => ipcRenderer.invoke('print', opts),
  setTitle: (title) => ipcRenderer.invoke('win:setTitle', title),
  setRepresented: (filePath) => ipcRenderer.invoke('win:setRepresented', filePath),
  setTheme: (mode) => ipcRenderer.invoke('win:setTheme', mode),
  ready: () => ipcRenderer.invoke('app:ready'),
  confirmQuit: () => ipcRenderer.invoke('app:confirmClose'),
  getPath: (name) => ipcRenderer.invoke('app:path', name),
  zoom: (factor) => ipcRenderer.invoke('win:zoom', factor),

  storeGet: (key, fallback) => ipcRenderer.invoke('store:get', key, fallback),
  storeSet: (key, value) => ipcRenderer.invoke('store:set', key, value),

  // AI runs through the main process: no renderer CORS, custom headers honoured.
  aiModels: (opts) => ipcRenderer.invoke('ai:models', opts),
  aiChat: (opts) => ipcRenderer.invoke('ai:chat', opts),
  aiOnStream: (handler) => {
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on('ai:stream', listener);
    return () => ipcRenderer.removeListener('ai:stream', listener);
  },
  // TTS (Read Aloud) providers — same proxy rules as ai:chat, but binary-safe.
  ttsRequest: (opts) => ipcRenderer.invoke('tts:request', opts),

  on: (channel, handler) => {
    const allowed = [
      'menu:action',
      'app:openPath',
      'app:willClose',
    ];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e, ...args) => handler(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});

// Do NOT call webFrame.setZoomLevel() here. Setting zoom from the preload before
// the first paint suppresses the compositor's first frame, so `ready-to-show`
// never fires and the `show: false` window in main.js stays invisible forever
// (the app "does not open": process runs, nothing on screen). Zoom level 0 is
// already the default, so this call was only ever paying out that side effect.
