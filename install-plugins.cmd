@echo off
rem Double-click entry for scripts\install-plugins.ps1: install / update / uninstall this repo's
rem DSH plugins, or show their status. Arguments are passed through, e.g.
rem   install-plugins.cmd -Action install -Plugins all -Profiles desktop -Yes
rem Kept ASCII-only on purpose: cmd.exe parses batch files in the console code page, so any
rem Chinese text here would break on non-UTF-8 consoles. All prompts live in the .ps1.
setlocal

set "SCRIPT=%~dp0scripts\install-plugins.ps1"
if not exist "%SCRIPT%" (
  echo Cannot find "%SCRIPT%".
  pause
  exit /b 1
)

rem Prefer PowerShell 7; fall back to Windows PowerShell 5.1, which ships with every Windows.
set "PS=powershell.exe"
where pwsh.exe >nul 2>nul && set "PS=pwsh.exe"

"%PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
set "CODE=%ERRORLEVEL%"

rem Double-clicking closes the window as soon as the script ends; keep it open so the result
rem can be read. Skipped when arguments are given (scripted use) or when run inside a cmd prompt.
if not "%~1"=="" goto done
echo %CMDCMDLINE% | find /i "/c" >nul
if not errorlevel 1 pause

:done
exit /b %CODE%
