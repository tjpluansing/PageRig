; Extra steps for the Windows (NSIS) installer, wired in through
; bundle.windows.nsis.installerHooks in tauri.conf.json.

; The stock uninstaller deletes only the files it installed and then removes the
; folder if it is empty. Anything else left there (a file a crashed helper wrote,
; or a folder still held open by a process that hasn't exited yet) keeps
; %LOCALAPPDATA%\PageRig around, and the next installer then finds a half-removed
; copy. Clear the whole folder instead, finishing after a restart if something
; still holds it open.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    ; Only ever clear a folder named after the app, so a copy installed straight
    ; into a shared folder never takes that folder's other contents with it.
    StrCpy $0 "$INSTDIR" "" -8
    ${If} $0 == "\PageRig"
      ; Step out of the folder first; the uninstaller can't remove its own working folder.
      SetOutPath "$TEMP"
      RMDir /r /REBOOTOK "$INSTDIR"
    ${EndIf}
  ${EndIf}
!macroend
