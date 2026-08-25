; Agent Relay - install directory policy (v0.3.1+)
;
; One-click per-user installs default to the package.json "name"
; (agent-relay-log). Per product requirement, fresh installs go to:
;   %LOCALAPPDATA%\Programs\Agent Relay\
;
; - This macro runs AFTER initMultiUser (see installer.nsi).
; - Upgrades keep their existing location: when the registry already has an
;   InstallLocation ($PerUserInstallationFolder), $INSTDIR is left untouched.
; - NOTE: this file is included BEFORE common.nsh, so LogicLib (${if}...) and
;   other template defines are NOT available here. Use plain NSIS (StrCmp).
; - No-op for per-machine builds (that variable does not exist there).
!macro customInit
  !ifndef INSTALL_MODE_PER_ALL_USERS
    StrCmp $PerUserInstallationFolder "" 0 skip_relay_instdir
      StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Agent Relay"
    skip_relay_instdir:
  !endif
!macroend
