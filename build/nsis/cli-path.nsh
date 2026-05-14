!include LogicLib.nsh
!include nsDialogs.nsh

!macro customHeader
  LangString TasiSkillOverwritePageTitle 1033 "Skill overwrite policy"
  LangString TasiSkillOverwritePageTitle 2052 "技能覆盖策略"
  LangString TasiSkillOverwritePageDescription 1033 "Select the local skills that may be overwritten by bundled installer versions. All conflicting skills are selected by default."
  LangString TasiSkillOverwritePageDescription 2052 "请选择允许安装包版本覆盖的本地技能。默认选中所有冲突技能。"
  LangString TasiSkillOverwriteSelectAll 1033 "Select all"
  LangString TasiSkillOverwriteSelectAll 2052 "全选"
  LangString TasiSkillOverwriteNoConflicts 1033 "No installed local skills conflict with this installer."
  LangString TasiSkillOverwriteNoConflicts 2052 "没有与此安装包冲突的本地技能。"
  LangString TasiCleanInstallFailed 1033 "Tasi Harness could not clean the existing installation directory. Close any running Tasi Harness windows and try the installer again."
  LangString TasiCleanInstallFailed 2052 "Tasi Harness 无法清理现有安装目录。请关闭所有正在运行的 Tasi Harness 窗口，然后重试安装。"
!macroend

!ifndef BUILD_UNINSTALLER
Var SkillConflictFile
Var SkillSelectionFile
Var SkillSelectAllCheck
Var SkillName0
Var SkillName1
Var SkillName2
Var SkillName3
Var SkillName4
Var SkillName5
Var SkillName6
Var SkillName7
Var SkillName8
Var SkillName9
Var SkillName10
Var SkillName11
Var SkillName12
Var SkillName13
Var SkillName14
Var SkillName15
Var SkillName16
Var SkillName17
Var SkillCheck0
Var SkillCheck1
Var SkillCheck2
Var SkillCheck3
Var SkillCheck4
Var SkillCheck5
Var SkillCheck6
Var SkillCheck7
Var SkillCheck8
Var SkillCheck9
Var SkillCheck10
Var SkillCheck11
Var SkillCheck12
Var SkillCheck13
Var SkillCheck14
Var SkillCheck15
Var SkillCheck16
Var SkillCheck17

!macro customPageAfterChangeDir
  Page custom SkillOverwritePageCreate SkillOverwritePageLeave
!macroend

!macro AddSkillOverwriteCheckbox INDEX X Y W
  IfErrors done_add_skill_${INDEX}
  StrCpy $SkillName${INDEX} $R0 -2
  ${If} $SkillName${INDEX} != ""
    ${NSD_CreateCheckbox} ${X} ${Y}u ${W} 10u "$SkillName${INDEX}"
    Pop $SkillCheck${INDEX}
    ${NSD_SetState} $SkillCheck${INDEX} ${BST_CHECKED}
    ClearErrors
    FileRead $2 $R0
  ${EndIf}
done_add_skill_${INDEX}:
!macroend

!macro SetSkillOverwriteCheckboxFromSelectAll INDEX
  ${If} $SkillName${INDEX} != ""
    ${NSD_SetState} $SkillCheck${INDEX} $R1
  ${EndIf}
!macroend

!macro WriteCheckedSkill INDEX
  ${If} $SkillName${INDEX} != ""
    ${NSD_GetState} $SkillCheck${INDEX} $R1
    ${If} $R1 == ${BST_CHECKED}
      FileWrite $3 "$SkillName${INDEX}$\r$\n"
    ${EndIf}
  ${EndIf}
!macroend

Function SkillOverwriteSelectAllChanged
  ${NSD_GetState} $SkillSelectAllCheck $R1
  !insertmacro SetSkillOverwriteCheckboxFromSelectAll 0
  !insertmacro SetSkillOverwriteCheckboxFromSelectAll 1
  !insertmacro SetSkillOverwriteCheckboxFromSelectAll 2
  !insertmacro SetSkillOverwriteCheckboxFromSelectAll 3
  !insertmacro SetSkillOverwriteCheckboxFromSelectAll 4
  !insertmacro SetSkillOverwriteCheckboxFromSelectAll 5
  !insertmacro SetSkillOverwriteCheckboxFromSelectAll 6
  !insertmacro SetSkillOverwriteCheckboxFromSelectAll 7
  !insertmacro SetSkillOverwriteCheckboxFromSelectAll 8
  !insertmacro SetSkillOverwriteCheckboxFromSelectAll 9
  !insertmacro SetSkillOverwriteCheckboxFromSelectAll 10
  !insertmacro SetSkillOverwriteCheckboxFromSelectAll 11
  !insertmacro SetSkillOverwriteCheckboxFromSelectAll 12
  !insertmacro SetSkillOverwriteCheckboxFromSelectAll 13
  !insertmacro SetSkillOverwriteCheckboxFromSelectAll 14
  !insertmacro SetSkillOverwriteCheckboxFromSelectAll 15
  !insertmacro SetSkillOverwriteCheckboxFromSelectAll 16
  !insertmacro SetSkillOverwriteCheckboxFromSelectAll 17
FunctionEnd

Function SkillOverwritePageCreate
  File /oname=$PLUGINSDIR\bundled-skills.json "${BUILD_RESOURCES_DIR}\nsis\bundled-skills.json"
  File /oname=$PLUGINSDIR\detect-skill-conflicts.ps1 "${BUILD_RESOURCES_DIR}\nsis\detect-skill-conflicts.ps1"
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\detect-skill-conflicts.ps1" -ManifestPath "$PLUGINSDIR\bundled-skills.json" -OutPath "$PLUGINSDIR\skill-conflicts.txt"`
  StrCpy $SkillConflictFile "$PLUGINSDIR\skill-conflicts.txt"
  StrCpy $SkillSelectionFile "$PLUGINSDIR\skill-overwrite-selection.txt"
  Delete "$SkillSelectionFile"

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 18u "$(TasiSkillOverwritePageTitle)"
  Pop $1
  ${NSD_CreateLabel} 0 20u 100% 32u "$(TasiSkillOverwritePageDescription)"
  Pop $1

  IfFileExists "$SkillConflictFile" 0 no_skill_conflicts
  FileOpen $2 "$SkillConflictFile" r
  ClearErrors
  FileRead $2 $R0
  IfErrors no_skill_conflicts
  ${NSD_CreateCheckbox} 0 54u 100% 10u "$(TasiSkillOverwriteSelectAll)"
  Pop $SkillSelectAllCheck
  ${NSD_SetState} $SkillSelectAllCheck ${BST_CHECKED}
  ${NSD_OnClick} $SkillSelectAllCheck SkillOverwriteSelectAllChanged
  !insertmacro AddSkillOverwriteCheckbox 0 0 70 48%
  !insertmacro AddSkillOverwriteCheckbox 1 0 82 48%
  !insertmacro AddSkillOverwriteCheckbox 2 0 94 48%
  !insertmacro AddSkillOverwriteCheckbox 3 0 106 48%
  !insertmacro AddSkillOverwriteCheckbox 4 0 118 48%
  !insertmacro AddSkillOverwriteCheckbox 5 0 130 48%
  !insertmacro AddSkillOverwriteCheckbox 6 0 142 48%
  !insertmacro AddSkillOverwriteCheckbox 7 0 154 48%
  !insertmacro AddSkillOverwriteCheckbox 8 0 166 48%
  !insertmacro AddSkillOverwriteCheckbox 9 50% 70 50%
  !insertmacro AddSkillOverwriteCheckbox 10 50% 82 50%
  !insertmacro AddSkillOverwriteCheckbox 11 50% 94 50%
  !insertmacro AddSkillOverwriteCheckbox 12 50% 106 50%
  !insertmacro AddSkillOverwriteCheckbox 13 50% 118 50%
  !insertmacro AddSkillOverwriteCheckbox 14 50% 130 50%
  !insertmacro AddSkillOverwriteCheckbox 15 50% 142 50%
  !insertmacro AddSkillOverwriteCheckbox 16 50% 154 50%
  !insertmacro AddSkillOverwriteCheckbox 17 50% 166 50%
  FileClose $2
  Goto skill_conflict_page_done

no_skill_conflicts:
  ${NSD_CreateLabel} 0 60u 100% 24u "$(TasiSkillOverwriteNoConflicts)"
  Pop $1

skill_conflict_page_done:
  nsDialogs::Show
FunctionEnd

Function SkillOverwritePageLeave
  Delete "$SkillSelectionFile"
  FileOpen $3 "$SkillSelectionFile" w
  !insertmacro WriteCheckedSkill 0
  !insertmacro WriteCheckedSkill 1
  !insertmacro WriteCheckedSkill 2
  !insertmacro WriteCheckedSkill 3
  !insertmacro WriteCheckedSkill 4
  !insertmacro WriteCheckedSkill 5
  !insertmacro WriteCheckedSkill 6
  !insertmacro WriteCheckedSkill 7
  !insertmacro WriteCheckedSkill 8
  !insertmacro WriteCheckedSkill 9
  !insertmacro WriteCheckedSkill 10
  !insertmacro WriteCheckedSkill 11
  !insertmacro WriteCheckedSkill 12
  !insertmacro WriteCheckedSkill 13
  !insertmacro WriteCheckedSkill 14
  !insertmacro WriteCheckedSkill 15
  !insertmacro WriteCheckedSkill 16
  !insertmacro WriteCheckedSkill 17
  FileClose $3
FunctionEnd
!endif

!macro customInit
  DetailPrint "Preparing clean Tasi Harness installation directory"
  InitPluginsDir
  File /oname=$PLUGINSDIR\clean-install-dir.ps1 "${BUILD_RESOURCES_DIR}\nsis\clean-install-dir.ps1"
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\clean-install-dir.ps1" -InstallDir "$INSTDIR"`
  Pop $0
  StrCmp $0 "0" clean_install_done
  MessageBox MB_ICONSTOP "$(TasiCleanInstallFailed)"
  Abort
clean_install_done:
!macroend

!macro customInstall
  DetailPrint "Saving Tasi Harness skill overwrite selection"
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$harnessHome = Join-Path $$env:USERPROFILE '.tasi-harness'; $$runtime = Join-Path $$harnessHome 'runtime'; New-Item -ItemType Directory -Force -Path $$runtime | Out-Null; $$selectionPath = '$PLUGINSDIR\skill-overwrite-selection.txt'; $$names = @(); if (Test-Path -LiteralPath $$selectionPath) { $$names = Get-Content -LiteralPath $$selectionPath -ErrorAction SilentlyContinue | Where-Object { $$_ -and $$_.Trim() } | ForEach-Object { $$_.Trim() } }; $$payload = [pscustomobject]@{ overwriteBundledSkills = $$false; overwriteSkillNames = @($$names); createdAt = (Get-Date).ToUniversalTime().ToString('o'); installerVersion = '${VERSION}' }; $$payload | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $$runtime 'installer-skill-overwrite.json') -Encoding UTF8"`
  DetailPrint "Adding Tasi Harness CLI to the user PATH"
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$installDir = '$INSTDIR'; $$aliasDir = Join-Path $$env:LOCALAPPDATA 'Microsoft\WindowsApps'; New-Item -ItemType Directory -Force -Path $$aliasDir | Out-Null; $$current = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($$null -eq $$current) { $$current = '' }; $$parts = $$current -split ';' | Where-Object { $$_ -and $$_.Trim() }; foreach ($$desired in @($$installDir)) { $$exists = $$false; foreach ($$part in $$parts) { if ($$part.TrimEnd('\') -ieq $$desired.TrimEnd('\')) { $$exists = $$true } }; if (-not $$exists) { $$parts = @($$parts) + $$desired } }; [Environment]::SetEnvironmentVariable('Path', ($$parts -join ';'), 'User'); $$nl = [Environment]::NewLine; $$dq = [char]34; $$sq = [char]39; foreach ($$base in @('tasi', 'tasi-harness')) { $$cmdTarget = Join-Path $$installDir ($$base + '.cmd'); if (Test-Path -LiteralPath $$cmdTarget) { $$cmdShim = '@echo off' + $$nl + $$dq + $$cmdTarget + $$dq + ' %*' + $$nl; Set-Content -LiteralPath (Join-Path $$aliasDir ($$base + '.cmd')) -Value $$cmdShim -Encoding ASCII }; $$psTarget = Join-Path $$installDir ($$base + '.ps1'); if (Test-Path -LiteralPath $$psTarget) { $$psShim = '& ' + $$sq + $$psTarget + $$sq + ' @args' + $$nl + 'exit $$LASTEXITCODE' + $$nl; Set-Content -LiteralPath (Join-Path $$aliasDir ($$base + '.ps1')) -Value $$psShim -Encoding UTF8 } }"`
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro customUnInstall
  DetailPrint "Removing Tasi Harness CLI from the user PATH"
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$installDir = '$INSTDIR'; $$aliasDir = Join-Path $$env:LOCALAPPDATA 'Microsoft\WindowsApps'; $$current = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($$null -ne $$current) { $$parts = $$current -split ';' | Where-Object { $$_ -and $$_.Trim() -and ($$_.TrimEnd('\') -ine $$installDir.TrimEnd('\')) }; [Environment]::SetEnvironmentVariable('Path', ($$parts -join ';'), 'User') }; foreach ($$name in @('tasi.cmd', 'tasi-harness.cmd', 'tasi.ps1', 'tasi-harness.ps1')) { $$shimPath = Join-Path $$aliasDir $$name; if (Test-Path -LiteralPath $$shimPath) { $$content = Get-Content -LiteralPath $$shimPath -Raw -ErrorAction SilentlyContinue; if ($$content -like ('*' + $$installDir + '*')) { Remove-Item -LiteralPath $$shimPath -Force -ErrorAction SilentlyContinue } } }"`
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend
