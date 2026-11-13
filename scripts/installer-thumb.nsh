; Windows Explorer thumbnail registration for .pdf — per-user, no elevation.
;
; Included by electron-builder from the `nsis.include` build setting. The
; provider DLL itself is copied to $INSTDIR\resources\AiPdfThumbnailProvider.dll
; by the extraResources mapping in package.json.
;
; Why HKCU and not HKLM/HKCR:
;   - installing per-user needs no admin rights, and uninstalling is trivially
;     reversible;
;   - HKCU\Software\Classes is merged into the system view, so the shell picks
;     it up for this user regardless of whether the app was installed per-user
;     or per-machine;
;   - the handler is bound at the .pdf extension level (shellex), not to the
;     AiPDF ProgID, so thumbnails work even when another application owns the
;     "Open with" default for PDFs.
;
; CLSID {B7C1E4A2-3D58-4F60-9A1E-6C8D2F05B731} must match src/native/aipdf_thumb.c
; {e357fccd-a995-4576-b01f-234630154e96} is the shell's IThumbnailProvider
; category key under shellex.

!macro customInstall
  DetailPrint "Registering PDF first-page thumbnails for the current user…"
  WriteRegStr HKCU "Software\Classes\CLSID\{B7C1E4A2-3D58-4F60-9A1E-6C8D2F05B731}" "" "AiPDF Thumbnail Provider"
  WriteRegStr HKCU "Software\Classes\CLSID\{B7C1E4A2-3D58-4F60-9A1E-6C8D2F05B731}\InprocServer32" "" "$INSTDIR\resources\AiPdfThumbnailProvider.dll"
  WriteRegStr HKCU "Software\Classes\CLSID\{B7C1E4A2-3D58-4F60-9A1E-6C8D2F05B731}\InprocServer32" "ThreadingModel" "Apartment"
  WriteRegStr HKCU "Software\Classes\.pdf\shellex\{e357fccd-a995-4576-b01f-234630154e96}" "" "{B7C1E4A2-3D58-4F60-9A1E-6C8D2F05B731}"
  ; SHCNE_ASSOCCHANGED — flushes Explorer's icon/thumbnail caches so the new
  ; handler is visible immediately, without an Explorer restart or logoff.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DetailPrint "Unregistering PDF first-page thumbnails…"
  DeleteRegKey /ifempty HKCU "Software\Classes\CLSID\{B7C1E4A2-3D58-4F60-9A1E-6C8D2F05B731}"
  DeleteRegKey /ifempty HKCU "Software\Classes\.pdf\shellex\{e357fccd-a995-4576-b01f-234630154e96}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
