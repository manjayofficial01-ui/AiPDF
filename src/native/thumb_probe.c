/*
 * Standalone COM harness for AiPdfThumbnailProvider.dll.
 *
 * Deliberately does NOT need any registry entry: it loads the DLL directly and
 * calls DllGetClassObject, then exercises the same interface sequence the
 * shell uses (IInitializeWithFile -> IThumbnailProvider::GetThumbnail).
 * Prints the returned bitmap geometry and writes the DIB to <out>.bmp for a
 * visual check. Build: node scripts/build-thumb-provider.mjs --probe
 */
#include <windows.h>
#include <objbase.h>
#include <objidl.h>
#include <shobjidl.h>
#include <thumbcache.h>
#include <propsys.h>
#include <stdio.h>

typedef HRESULT (WINAPI *GETCLASS)(REFCLSID, REFIID, void **);

int wmain(int argc, WCHAR **argv) {
  if (argc < 4) { fwprintf(stderr, L"usage: thumb_probe <dll> <pdf> <out.bmp> [width]\n"); return 2; }
  const WCHAR *dll = argv[1], *pdf = argv[2], *out = argv[3];
  UINT cx = argc > 4 ? (UINT)_wtoi(argv[4]) : 256;

  static const GUID CLSID_AiPdfThumb =
    { 0xb7c1e4a2, 0x3d58, 0x4f60, { 0x9a, 0x1e, 0x6c, 0x8d, 0x2f, 0x05, 0xb7, 0x31 } };
  static const GUID IID_IClassFactory_ =
    { 0x00000001, 0x0000, 0x0000, { 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46 } };
  static const GUID IID_IInitFile =
    { 0xb7d14566, 0x0509, 0x4cce, { 0xa7, 0x1f, 0x0a, 0x55, 0x42, 0x33, 0xbd, 0x9b } };
  static const GUID IID_IThumb =
    { 0xe357fccd, 0xa995, 0x4576, { 0xb0, 0x1f, 0x23, 0x46, 0x30, 0x15, 0x4e, 0x96 } };

  HMODULE h = LoadLibraryW(dll);
  if (!h) { fwprintf(stderr, L"LoadLibrary failed %lu\n", GetLastError()); return 3; }
  GETCLASS get = (GETCLASS)(void *)GetProcAddress(h, "DllGetClassObject");
  if (!get) { fwprintf(stderr, L"DllGetClassObject export missing\n"); return 4; }

  IClassFactory *factory = NULL;
  HRESULT hr = get(&CLSID_AiPdfThumb, &IID_IClassFactory_, (void **)&factory);
  if (FAILED(hr) || !factory) { fwprintf(stderr, L"DllGetClassObject 0x%08lx\n", (long)hr); return 5; }

  IInitializeWithFile *init = NULL;
  hr = factory->lpVtbl->CreateInstance(factory, NULL, &IID_IInitFile, (void **)&init);
  if (FAILED(hr) || !init) { fwprintf(stderr, L"CreateInstance 0x%08lx\n", (long)hr); return 6; }
  hr = init->lpVtbl->Initialize(init, pdf, 0);
  if (FAILED(hr)) { fwprintf(stderr, L"Initialize 0x%08lx\n", (long)hr); return 7; }

  IThumbnailProvider *tp = NULL;
  hr = init->lpVtbl->QueryInterface(init, &IID_IThumb, (void **)&tp);
  if (FAILED(hr) || !tp) { fwprintf(stderr, L"QueryInterface 0x%08lx\n", (long)hr); return 8; }

  HBITMAP hb = NULL;
  WTS_ALPHATYPE alpha = WTSAT_UNKNOWN;
  hr = tp->lpVtbl->GetThumbnail(tp, cx, &hb, &alpha);
  if (FAILED(hr) || !hb) { fwprintf(stderr, L"GetThumbnail 0x%08lx\n", (long)hr); return 9; }

  BITMAP bm; ZeroMemory(&bm, sizeof(bm));
  if (!GetObjectW(hb, sizeof(bm), &bm)) { fwprintf(stderr, L"GetObject failed\n"); return 10; }
  wprintf(L"THUMB_PROBE_OK %ldx%ld bpp=%u alpha=%d\n",
          bm.bmWidth, bm.bmHeight, bm.bmBitsPixel, (int)alpha);

  /* Dump the DIB so the badge can be inspected without Explorer. */
  BITMAPINFOHEADER bi; ZeroMemory(&bi, sizeof(bi));
  bi.biSize = sizeof(bi); bi.biWidth = bm.bmWidth; bi.biHeight = bm.bmHeight;
  bi.biPlanes = 1; bi.biBitCount = 32; bi.biCompression = BI_RGB;
  SIZE_T pixBytes = (SIZE_T)bm.bmWidth * bm.bmHeight * 4;
  BYTE *bits = (BYTE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, pixBytes);
  HDC dc = GetDC(NULL);
  if (bits && dc && GetDIBits(dc, hb, 0, bm.bmHeight, bits, (BITMAPINFO *)&bi, DIB_RGB_COLORS)) {
    FILE *f = NULL;
    if (!_wfopen_s(&f, out, L"wb") && f) {
      BYTE head[54]; ZeroMemory(head, sizeof(head));
      head[0] = 'B'; head[1] = 'M';
      DWORD total = (DWORD)(54 + pixBytes), off = 54;
      CopyMemory(head + 2, &total, 4); CopyMemory(head + 10, &off, 4);
      DWORD ih = 40; CopyMemory(head + 14, &ih, 4);
      CopyMemory(head + 18, &bi.biWidth, 4); CopyMemory(head + 22, &bi.biHeight, 4);
      WORD planes = 1, bpp = 32; CopyMemory(head + 26, &planes, 2); CopyMemory(head + 28, &bpp, 2);
      CopyMemory(head + 34, &pixBytes, 4);
      fwrite(head, 1, 54, f); fwrite(bits, 1, pixBytes, f); fclose(f);
    }
  }
  if (dc) ReleaseDC(NULL, dc);
  if (bits) HeapFree(GetProcessHeap(), 0, bits);

  tp->lpVtbl->Release(tp);
  init->lpVtbl->Release(init);
  factory->lpVtbl->Release(factory);
  DeleteObject(hb);
  return 0;
}
