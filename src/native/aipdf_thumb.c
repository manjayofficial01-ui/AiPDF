/*
 * AiPDF Editor — Windows Explorer thumbnail provider (IThumbnailProvider).
 *
 * Explorer asks for an HBITMAP for a .pdf file. This DLL renders page 1 through
 * the app's own headless worker (pdf.js + canvas, running under
 * ELECTRON_RUN_AS_NODE), which composites the AiPDF badge at the bottom-right,
 * then loads the resulting 32-bit BMP as a DIB section and hands it back.
 *
 * Design notes / safety:
 *   - The DLL is a thin, defensive COM shim. It does no PDF parsing, has no
 *     static CRT state, and never waits indefinitely: the worker is killed
 *     after TIMEOUT_MS so a broken PDF cannot hang Explorer.
 *   - All three initialisers are implemented (stream / item / file) because
 *     different shell hosts pick different ones. A stream is copied to a temp
 *     file that is deleted when the object is released.
 *   - Nothing is written outside the temp directory. The DLL never touches
 *     the user's PDF.
 *   - Registered per-user (HKCU\Software\Classes) by the NSIS installer, so
 *     installing/uninstalling needs no elevation and is trivially reversible.
 *
 * Build: node scripts/build-thumb-provider.mjs   (uses Zig's bundled MinGW).
 */

#include <windows.h>
#include <objbase.h>
#include <objidl.h>
#include <shobjidl.h>
#include <thumbcache.h>
#include <propsys.h>
#include <shlwapi.h>

#define TIMEOUT_MS 15000
#define AIPDF_ASAR        L"app.asar"
#define AIPDF_BADGE_WORKER L"src\\main\\thumbnail-worker.cjs"
#define AIPDF_EXE         L"AiPDF Editor.exe"
#define AIPDF_DEV_EXE     L"node_modules\\electron\\dist\\electron.exe"

/* B7C1E4A2-3D58-4F60-9A1E-6C8D2F05B731 */
static const GUID CLSID_AiPdfThumb =
  { 0xb7c1e4a2, 0x3d58, 0x4f60, { 0x9a, 0x1e, 0x6c, 0x8d, 0x2f, 0x05, 0xb7, 0x31 } };

static const GUID IID_IUnknown_ =
  { 0x00000000, 0x0000, 0x0000, { 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46 } };
static const GUID IID_IClassFactory_ =
  { 0x00000001, 0x0000, 0x0000, { 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46 } };
static const GUID IID_IThumbnailProvider_ =
  { 0xe357fccd, 0xa995, 0x4576, { 0xb0, 0x1f, 0x23, 0x46, 0x30, 0x15, 0x4e, 0x96 } };
static const GUID IID_IInitializeWithStream_ =
  { 0xb824b49d, 0x22ac, 0x4161, { 0xac, 0x8a, 0x99, 0x16, 0xe8, 0xfa, 0x3f, 0x7f } };
static const GUID IID_IInitializeWithItem_ =
  { 0x7f73be3f, 0xfb79, 0x493c, { 0xa6, 0xc7, 0x7e, 0xe1, 0x4e, 0x24, 0x58, 0x41 } };
static const GUID IID_IInitializeWithFile_ =
  { 0xb7d14566, 0x0509, 0x4cce, { 0xa7, 0x1f, 0x0a, 0x55, 0x42, 0x33, 0xbd, 0x9b } };

static HINSTANCE g_hInst = NULL;
static LONG g_objects = 0;
static LONG g_locks = 0;

static BOOL GuidEq(REFIID a, const GUID *b) {
  return a->Data1 == b->Data1 && a->Data2 == b->Data2 && a->Data3 == b->Data3
    && a->Data4[0] == b->Data4[0] && a->Data4[1] == b->Data4[1]
    && a->Data4[2] == b->Data4[2] && a->Data4[3] == b->Data4[3]
    && a->Data4[4] == b->Data4[4] && a->Data4[5] == b->Data4[5]
    && a->Data4[6] == b->Data4[6] && a->Data4[7] == b->Data4[7];
}

/* ── Object ────────────────────────────────────────────────────────────────
 * Four COM "faces" share one ref count. Each face starts with its own vtable
 * pointer so QueryInterface can hand out the right layout, followed by a
 * back-pointer to the owning object. */

typedef struct ThumbObj ThumbObj;
typedef struct Face { const void *lpVtbl; ThumbObj *self; } Face;

struct ThumbObj {
  Face thumb;                 /* IThumbnailProvider          */
  Face stream;                /* IInitializeWithStream       */
  Face item;                  /* IInitializeWithItem         */
  Face file;                  /* IInitializeWithFile         */
  LONG ref;
  BOOL havePath;
  BOOL tempFile;
  WCHAR path[MAX_PATH];
};

typedef HRESULT (STDMETHODCALLTYPE *QI_FN)(void *, REFIID, void **);
typedef ULONG   (STDMETHODCALLTYPE *REF_FN)(void *);

typedef struct {
  QI_FN qi; REF_FN addref; REF_FN release;
  HRESULT (STDMETHODCALLTYPE *getThumbnail)(void *, UINT, HBITMAP *, WTS_ALPHATYPE *);
} VtblThumb;
typedef struct {
  QI_FN qi; REF_FN addref; REF_FN release;
  HRESULT (STDMETHODCALLTYPE *initialize)(void *, IStream *, DWORD);
} VtblStream;
typedef struct {
  QI_FN qi; REF_FN addref; REF_FN release;
  HRESULT (STDMETHODCALLTYPE *initialize)(void *, IShellItem *, DWORD);
} VtblItem;
typedef struct {
  QI_FN qi; REF_FN addref; REF_FN release;
  HRESULT (STDMETHODCALLTYPE *initialize)(void *, LPCWSTR, DWORD);
} VtblFile;
typedef struct {
  QI_FN qi; REF_FN addref; REF_FN release;
  HRESULT (STDMETHODCALLTYPE *createInstance)(void *, IUnknown *, REFIID, void **);
  HRESULT (STDMETHODCALLTYPE *lockServer)(void *, BOOL);
} VtblFactory;

static HRESULT STDMETHODCALLTYPE Obj_QI(void *, REFIID, void **);
static ULONG   STDMETHODCALLTYPE Obj_AddRef(void *);
static ULONG   STDMETHODCALLTYPE Obj_Release(void *);
static HRESULT STDMETHODCALLTYPE Obj_GetThumbnail(void *, UINT, HBITMAP *, WTS_ALPHATYPE *);
static HRESULT STDMETHODCALLTYPE Obj_InitStream(void *, IStream *, DWORD);
static HRESULT STDMETHODCALLTYPE Obj_InitItem(void *, IShellItem *, DWORD);
static HRESULT STDMETHODCALLTYPE Obj_InitFile(void *, LPCWSTR, DWORD);

static const VtblThumb g_vtblThumb =
  { Obj_QI, Obj_AddRef, Obj_Release, Obj_GetThumbnail };
static const VtblStream g_vtblStream =
  { Obj_QI, Obj_AddRef, Obj_Release, Obj_InitStream };
static const VtblItem g_vtblItem =
  { Obj_QI, Obj_AddRef, Obj_Release, Obj_InitItem };
static const VtblFile g_vtblFile =
  { Obj_QI, Obj_AddRef, Obj_Release, Obj_InitFile };

static ThumbObj *Obj_New(void) {
  ThumbObj *o = (ThumbObj *)CoTaskMemAlloc(sizeof(ThumbObj));
  if (!o) return NULL;
  ZeroMemory(o, sizeof(*o));
  o->thumb.lpVtbl = (const void *)&g_vtblThumb;
  o->stream.lpVtbl = (const void *)&g_vtblStream;
  o->item.lpVtbl = (const void *)&g_vtblItem;
  o->file.lpVtbl = (const void *)&g_vtblFile;
  o->thumb.self = o; o->stream.self = o;
  o->item.self = o;  o->file.self = o;
  o->ref = 1;
  InterlockedIncrement(&g_objects);
  return o;
}

static HRESULT STDMETHODCALLTYPE Obj_QI(void *This, REFIID riid, void **ppv) {
  Face *f = (Face *)This;
  ThumbObj *o = f ? f->self : NULL;
  if (!ppv) return E_POINTER;
  *ppv = NULL;
  if (!o) return E_NOINTERFACE;
  if (GuidEq(riid, &IID_IUnknown_) || GuidEq(riid, &IID_IThumbnailProvider_)) *ppv = &o->thumb;
  else if (GuidEq(riid, &IID_IInitializeWithStream_)) *ppv = &o->stream;
  else if (GuidEq(riid, &IID_IInitializeWithItem_)) *ppv = &o->item;
  else if (GuidEq(riid, &IID_IInitializeWithFile_)) *ppv = &o->file;
  else return E_NOINTERFACE;
  InterlockedIncrement(&o->ref);
  return S_OK;
}

static ULONG STDMETHODCALLTYPE Obj_AddRef(void *This) {
  ThumbObj *o = ((Face *)This)->self;
  return (ULONG)InterlockedIncrement(&o->ref);
}

static ULONG STDMETHODCALLTYPE Obj_Release(void *This) {
  ThumbObj *o = ((Face *)This)->self;
  LONG left = InterlockedDecrement(&o->ref);
  if (!left) {
    if (o->tempFile && o->path[0]) DeleteFileW(o->path);
    CoTaskMemFree(o);
    InterlockedDecrement(&g_objects);
  }
  return (ULONG)left;
}

static BOOL SetPath(ThumbObj *o, LPCWSTR p, BOOL temp) {
  int n = lstrlenW(p);
  if (!p || n <= 0 || n >= MAX_PATH) return FALSE;
  lstrcpynW(o->path, p, MAX_PATH);
  o->havePath = TRUE;
  o->tempFile = temp;
  return TRUE;
}

static HRESULT STDMETHODCALLTYPE Obj_InitFile(void *This, LPCWSTR path, DWORD mode) {
  (void)mode;
  return SetPath(((Face *)This)->self, path, FALSE) ? S_OK : E_INVALIDARG;
}

static HRESULT STDMETHODCALLTYPE Obj_InitItem(void *This, IShellItem *psi, DWORD mode) {
  (void)mode;
  LPWSTR name = NULL;
  if (!psi) return E_POINTER;
  HRESULT hr = psi->lpVtbl->GetDisplayName(psi, (SIGDN)0x80058000 /* SIGDN_FILESYSPATH */, &name);
  if (FAILED(hr) || !name) return FAILED(hr) ? hr : E_FAIL;
  BOOL ok = SetPath(((Face *)This)->self, name, FALSE);
  CoTaskMemFree(name);
  return ok ? S_OK : E_FAIL;
}

/* Copy an IStream into a temp .pdf so the worker always receives a real path.
   The file is removed when the COM object is released. */
static HRESULT STDMETHODCALLTYPE Obj_InitStream(void *This, IStream *stm, DWORD mode) {
  (void)mode;
  WCHAR tmpDir[MAX_PATH], tmp[MAX_PATH];
  ThumbObj *o = ((Face *)This)->self;
  if (!stm) return E_POINTER;
  if (!GetTempPathW(MAX_PATH, tmpDir)) return E_FAIL;
  if (!GetTempFileNameW(tmpDir, L"aip", 0, tmp)) return E_FAIL;
  HANDLE hf = CreateFileW(tmp, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                          FILE_ATTRIBUTE_TEMPORARY | FILE_ATTRIBUTE_HIDDEN, NULL);
  if (hf == INVALID_HANDLE_VALUE) { DeleteFileW(tmp); return E_FAIL; }

  BYTE buf[65536];
  HRESULT hr = S_OK;
  for (;;) {
    ULONG got = 0;
    hr = stm->lpVtbl->Read(stm, buf, sizeof(buf), &got);
    if (FAILED(hr)) break;
    if (!got) break;
    DWORD wrote = 0;
    if (!WriteFile(hf, buf, got, &wrote, NULL) || wrote != got) { hr = E_FAIL; break; }
  }
  CloseHandle(hf);
  if (FAILED(hr) || !SetPath(o, tmp, TRUE)) { DeleteFileW(tmp); return FAILED(hr) ? hr : E_FAIL; }
  return S_OK;
}

/* Build an environment block identical to the parent's but with
   ELECTRON_RUN_AS_NODE=1, so electron.exe behaves as a plain Node runtime. */
static LPWSTR NodeEnvironment(void) {
  LPWCH src = GetEnvironmentStringsW();
  if (!src) return NULL;
  LPWCH p = src;
  SIZE_T chars = 0;
  while (*p) { SIZE_T n = (SIZE_T)lstrlenW(p) + 1; p += n; chars += n; }
  LPWSTR out = (LPWSTR)HeapAlloc(GetProcessHeap(), 0, (chars + 32) * sizeof(WCHAR));
  if (!out) { FreeEnvironmentStringsW(src); return NULL; }
  LPWSTR d = out;
  p = src;
  while (*p) {
    SIZE_T n = (SIZE_T)lstrlenW(p) + 1;
    static const WCHAR key[] = L"ELECTRON_RUN_AS_NODE=";
    BOOL skip = (n >= 21) && (CompareStringOrdinal(p, 20, key, 20, TRUE) == CSTR_EQUAL);
    if (!skip) { CopyMemory(d, p, n * sizeof(WCHAR)); d += n; }
    p += n;
  }
  static const WCHAR add[] = L"ELECTRON_RUN_AS_NODE=1";
  CopyMemory(d, add, sizeof(add));
  d += 22; /* 21 chars + terminating NUL */
  *d = L'\0';
  FreeEnvironmentStringsW(src);
  return out;
}

static HRESULT STDMETHODCALLTYPE Obj_GetThumbnail(void *This, UINT cx,
                                                  HBITMAP *phbmp, WTS_ALPHATYPE *pdwAlpha) {
  ThumbObj *o = ((Face *)This)->self;
  if (!phbmp || !pdwAlpha) return E_POINTER;
  *phbmp = NULL;
  *pdwAlpha = WTSAT_RGB;                 /* opaque: the worker draws a white page */
  if (!o->havePath) return E_UNEXPECTED;

  /* Resolve the app the worker runs under. Two layouts are supported:
     - Installed: DLL sits in <install>\resources next to app.asar; the
       executable is one level up.
     - Dev/source: DLL sits in <project>\vendor\thumbnail; the Electron
       binary from node_modules and the plain worker file (no asar) are used.
     NOTE: app.asar is a FILE to Windows, so never call PathFileExistsW on
     anything "inside" it — only on the archive itself. */
  WCHAR dll[MAX_PATH], dir[MAX_PATH], root[MAX_PATH], root2[MAX_PATH];
  WCHAR exe[MAX_PATH], worker[MAX_PATH], out[MAX_PATH];
  if (!GetModuleFileNameW(g_hInst, dll, MAX_PATH)) return E_FAIL;
  lstrcpynW(dir, dll, MAX_PATH);
  PathRemoveFileSpecW(dir);                 /* …\resources | …\vendor\thumbnail */
  lstrcpynW(root, dir, MAX_PATH);
  PathRemoveFileSpecW(root);                /* install root | …\vendor        */

  lstrcpynW(exe, root, MAX_PATH);
  PathAppendW(exe, AIPDF_EXE);
  lstrcpynW(worker, root, MAX_PATH);
  PathAppendW(worker, L"resources\\" AIPDF_ASAR);
  if (PathFileExistsW(exe) && PathFileExistsW(worker)) {
    PathAppendW(worker, AIPDF_BADGE_WORKER); /* Node resolves this inside asar */
  } else {
    lstrcpynW(root2, root, MAX_PATH);
    PathRemoveFileSpecW(root2);             /* project root */
    lstrcpynW(exe, root2, MAX_PATH);
    PathAppendW(exe, AIPDF_DEV_EXE);
    lstrcpynW(worker, root2, MAX_PATH);
    PathAppendW(worker, AIPDF_BADGE_WORKER);
    if (!PathFileExistsW(exe) || !PathFileExistsW(worker)) return E_FAIL;
  }

  WCHAR tmpDir[MAX_PATH];
  if (!GetTempPathW(MAX_PATH, tmpDir)) return E_FAIL;
  if (!GetTempFileNameW(tmpDir, L"atb", 0, out)) return E_FAIL;

  WCHAR cmd[4096];
  wsprintfW(cmd, L"\"%s\" \"%s\" \"%s\" \"%s\" %u", exe, worker, o->path, out, cx);
  LPWSTR env = NodeEnvironment();
  if (!env) { DeleteFileW(out); return E_FAIL; }

  STARTUPINFOW si;
  PROCESS_INFORMATION pi;
  ZeroMemory(&si, sizeof(si));
  ZeroMemory(&pi, sizeof(pi));
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE;

  BOOL started = CreateProcessW(exe, cmd, NULL, NULL, FALSE,
                                CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                                env, NULL, &si, &pi);
  HeapFree(GetProcessHeap(), 0, env);
  if (!started) { DeleteFileW(out); return E_FAIL; }

  DWORD waited = WaitForSingleObject(pi.hProcess, TIMEOUT_MS);
  if (waited != WAIT_OBJECT_0) TerminateProcess(pi.hProcess, 1);
  DWORD code = 1;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);

  if (waited != WAIT_OBJECT_0 || code != 0) { DeleteFileW(out); return E_FAIL; }
  HBITMAP hb = (HBITMAP)LoadImageW(NULL, out, IMAGE_BITMAP, 0, 0,
                                   LR_LOADFROMFILE | LR_CREATEDIBSECTION);
  DeleteFileW(out);
  if (!hb) return E_FAIL;
  *phbmp = hb;
  return S_OK;
}

/* ── Class factory (one static instance is enough) ──────────────────────── */

static HRESULT STDMETHODCALLTYPE Fac_QI(void *This, REFIID riid, void **ppv) {
  (void)This;
  if (!ppv) return E_POINTER;
  if (GuidEq(riid, &IID_IUnknown_) || GuidEq(riid, &IID_IClassFactory_)) {
    *ppv = This;
    return S_OK;
  }
  *ppv = NULL;
  return E_NOINTERFACE;
}
static ULONG STDMETHODCALLTYPE Fac_AddRef(void *This) { (void)This; return 1; }
static ULONG STDMETHODCALLTYPE Fac_Release(void *This) { (void)This; return 1; }
static HRESULT STDMETHODCALLTYPE Fac_CreateInstance(void *This, IUnknown *outer,
                                                    REFIID riid, void **ppv) {
  (void)This;
  if (!ppv) return E_POINTER;
  *ppv = NULL;
  if (outer) return CLASS_E_NOAGGREGATION;
  ThumbObj *o = Obj_New();
  if (!o) return E_OUTOFMEMORY;
  HRESULT hr = Obj_QI(&o->thumb, riid, ppv);
  Obj_Release(&o->thumb);
  return hr;
}
static HRESULT STDMETHODCALLTYPE Fac_LockServer(void *This, BOOL lock) {
  (void)This;
  if (lock) InterlockedIncrement(&g_locks); else InterlockedDecrement(&g_locks);
  return S_OK;
}
static const VtblFactory g_vtblFactory =
  { Fac_QI, Fac_AddRef, Fac_Release, Fac_CreateInstance, Fac_LockServer };
static Face g_factory = { (const void *)&g_vtblFactory, NULL };

__declspec(dllexport) HRESULT STDMETHODCALLTYPE DllGetClassObject(REFCLSID rclsid,
                                                                  REFIID riid, void **ppv) {
  if (!GuidEq(rclsid, &CLSID_AiPdfThumb)) return CLASS_E_CLASSNOTAVAILABLE;
  return Fac_QI(&g_factory, riid, ppv);
}

__declspec(dllexport) HRESULT STDMETHODCALLTYPE DllCanUnloadNow(void) {
  return (g_objects == 0 && g_locks == 0) ? S_OK : S_FALSE;
}

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, void *reserved) {
  (void)reserved;
  if (reason == DLL_PROCESS_ATTACH) {
    g_hInst = h;
    DisableThreadLibraryCalls(h);
  }
  return TRUE;
}
