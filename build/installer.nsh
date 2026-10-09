!macro customInstall
  FileOpen $0 "$INSTDIR\taskcontinuum-install.json" w
  IfErrors marker_failed
  FileWrite $0 '{"schemaVersion":1,"distribution":"nsis","appId":"com.leoncl2025.taskcontinuum"}'
  FileClose $0
  Goto marker_done
marker_failed:
  Abort "Unable to write the Task Continuum installation marker."
marker_done:
!macroend

!macro customUnInstall
  Delete "$INSTDIR\taskcontinuum-install.json"
!macroend
