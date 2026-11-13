# Windows shell thumbnails — first page + AiPDF badge

Every `.pdf` file on the desktop and in Explorer shows **page 1 of the real
document** as its icon, with the small **AiPDF logo on a white plate at the
bottom-right** — the same visual signature Acrobat and Foxit use. Before this
feature, PDF files carried the static app icon (`assets/icon.ico`) from the
NSIS file association, so a shelf of PDFs looked like a shelf of identical
AiPDF logos.

---

## How it works

```
Explorer / Desktop
   │  asks for a thumbnail (IThumbnailProvider)
   ▼
vendor/thumbnail/AiPdfThumbnailProvider.dll        ← tiny COM shim, in-process
   │  spawns on demand, 15 s timeout, no window
   ▼
AiPDF Editor.exe  (ELECTRON_RUN_AS_NODE=1 — plain Node)
   └─ src/main/thumbnail-worker.cjs
        ├─ pdf.js renders page 1 into an @napi-rs/canvas surface
        ├─ white page, soft shadow, hairline border
        ├─ AiPDF badge (assets/icon.png) composited bottom-right
        └─ writes a 32-bit BMP → GDI LoadImage → HBITMAP → Explorer
```

Key properties:

- **The DLL never parses PDFs.** It is a defensive shim: it copies
  `IInitializeWithStream` inputs to a temp file (deleted on release), spawns
  the worker, waits at most 15 s, then falls back to the plain icon on any
  failure — a broken PDF can never hang Explorer.
- **One renderer, two layouts.** The DLL resolves its app from its own
  location: `resources\app.asar` next to it → installed app; otherwise the
  dev layout (`node_modules\electron\dist\electron.exe` + the plain worker
  file) — so the same committed DLL works for source checkouts.
- **Badge only where it fits.** The badge is drawn when it stays ≥ 10 px wide
  (i.e. Explorer medium icons and larger). At 16–32 px the file shows a clean
  page render instead of a badge covering it.
- **Association-independent.** The handler is bound at the `.pdf` *extension*
  level, not to the AiPDF ProgID, so thumbnails appear even when another app
  (Acrobat, Photoshop, Edge…) owns the "Open with" default.

## Registration

The CLSID lives in `src/native/aipdf_thumb.c`:

`{B7C1E4A2-3D58-4F60-9A1E-6C8D2F05B731}` — `AiPDF Thumbnail Provider`

- **Installer (users):** `scripts/installer-thumb.nsh` (wired via
  `nsis.include` in package.json) writes per-user keys into
  `HKCU\Software\Classes` on install and deletes them on uninstall:

  | Key | Value |
  | --- | --- |
  | `CLSID\{B7C1E4A2-…}\InprocServer32` | `$INSTDIR\resources\AiPdfThumbnailProvider.dll` |
  | `CLSID\{B7C1E4A2-…}\InprocServer32\ThreadingModel` | `Apartment` |
  | `.pdf\shellex\{e357fccd-a995-4576-b01f-234630154e96}` | `{B7C1E4A2-…}` |

  The DLL itself is shipped by the `extraResources` mapping in package.json.
  After registering, the script fires `SHChangeNotify(SHCNE_ASSOCCHANGED)` so
  Explorer flushes its icon/thumbnail caches immediately — no logoff needed.

- **Per-user, no elevation.** `HKCU\Software\Classes` merges into the shell's
  view, works for per-user and per-machine installs, and uninstalling is a
  plain `DeleteRegKey`.

- **Dev machine (source checkout):** register the project DLL directly:

  ```bat
  set CLSID={B7C1E4A2-3D58-4F60-9A1E-6C8D2F05B731}
  reg add "HKCU\Software\Classes\CLSID\%CLSID%" /ve /d "AiPDF Thumbnail Provider" /f
  reg add "HKCU\Software\Classes\CLSID\%CLSID%\InprocServer32" /ve /d "D:\000000 Lab\AiPDF Editor\vendor\thumbnail\AiPdfThumbnailProvider.dll" /f
  reg add "HKCU\Software\Classes\CLSID\%CLSID%\InprocServer32" /v ThreadingModel /d Apartment /f
  reg add "HKCU\Software\Classes\.pdf\shellex\{e357fccd-a995-4576-b01f-234630154e96}" /ve /d "%CLSID%" /f
  ie4uinit -show
  ```

  To undo, `reg delete` the same three keys (`/f`).

## Building

```bash
npm run build:thumb          # node scripts/build-thumb-provider.mjs [--force] [--probe]
npm run test:thumbshell      # full end-to-end verification (see below)
```

No Visual Studio needed: the build script uses Zig's bundled MinGW-w64 headers
and import libraries (`zig cc -target x86_64-windows-gnu`). Zig is downloaded
once into `.scratch/zig` (gitignored); the compiled DLL is committed under
`vendor/thumbnail`, so ordinary builds need neither network access nor a
compiler. Zig's compilation cache is pinned into `.scratch/zig-cache` because
`AppDataDirUnavailable` breaks the default cache location in service shells.

`--probe` additionally builds `.scratch/thumb_probe.exe` — a standalone COM
harness that loads the DLL and drives the exact interface sequence the shell
uses, writing the returned bitmap to disk for inspection.

## Verification

```bash
node scripts/thumb-provider-test.mjs
```

checks, in order:

1. DLL exists, is x64, exports `DllGetClassObject` / `DllCanUnloadNow`
2. the worker renders a fixture PDF to a BMP under plain Node
3. the probe returns 256 px and 32 px bitmaps; **pixel assertions** verify
   real page content, the AiPDF badge cluster bottom-right at 256 px, and a
   clean badge-free render at 32 px
4. *(self-skipping)* the real Explorer pipeline
   (`IShellItemImageFactory::GetImage` with `SIIGBF_THUMBNAILONLY`) on a
   fresh temp copy of a fixture PDF, with a `.jpg` control file — in service
   or CI sessions there is no interactive shell, so the control file reports
   `E_NOINTERFACE` and the check skips itself with an explanation
5. reports the registration state of this machine (informational)

Output ends with `THUMB_PROVIDER_PASS all N checks green`.

## Limits & notes

- Thumbnails are generated per file on demand; a folder of hundreds of PDFs
  warms its thumbnails lazily as Explorer displays them, each render costing
  one short-lived Node process (~1–3 s). A native pdfium engine inside the
  DLL would be faster, but shipping it needs a real C++ toolchain — the
  Electron route reuses the app's own renderer with zero extra dependencies.
- Files that fail to render (corrupt, encrypted, zero pages) simply keep the
  regular file icon; nothing is written outside `%TEMP%`.
- The `Documents\` thumbnail cache may keep old entries for files that
  haven't changed since before the provider was registered. If some icons
  look stale after installing, run the installer once more (it flushes the
  caches) or delete `%LOCALAPPDATA%\Microsoft\Windows\Explorer\thumbcache_*.db`
  and sign out/in.
- CLSID, category GUID (`{e357fccd-a995-4576-b01f-234630154e96}` is the
  shell's `IThumbnailProvider` category) and the badge rule are the only
  magic constants — everything else is derived from the DLL's own path.
