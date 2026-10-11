@echo off
rem Double-click entry for scripts\install-plugins.mjs: install / update / uninstall this repo's
rem DSH plugins, or show their status. Arguments are passed through, e.g.
rem   install-plugins.cmd --action install --plugins all --profiles desktop --yes
rem Kept ASCII-only on purpose: cmd.exe parses batch files in the console code page, so any
rem Chinese text here would break on non-UTF-8 consoles. All prompts live in the .mjs.
rem
rem No system Node.js is required: like DSH's own dsh.cmd, the script runs on the Node runtime
rem built into "DeepSeek Harness.exe" (ELECTRON_RUN_AS_NODE=1). A system node is only the
rem fallback when the DSH install cannot be found (the script then explains what is missing).
setlocal

set "SCRIPT=%~dp0scripts\install-plugins.mjs"
if not exist "%SCRIPT%" (
  echo Cannot find "%SCRIPT%".
  pause
  exit /b 1
)

rem Locate dsh.cmd (DSH_CLI override, PATH, then the default per-user install location);
rem the executable is in the install root, above resources\runtime\cli\bin\dsh.cmd.
set "DSHCMD="
if defined DSH_CLI if exist "%DSH_CLI%" set "DSHCMD=%DSH_CLI%"
if not defined DSHCMD for %%I in (dsh.cmd) do set "DSHCMD=%%~$PATH:I"
if not defined DSHCMD if exist "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" set "DSHCMD=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"

set "RUNTIME="
if defined DSHCMD for %%I in ("%DSHCMD%\..\..\..\..\..\DeepSeek Harness.exe") do if exist "%%~fI" set "RUNTIME=%%~fI"

if defined RUNTIME (
  set "ELECTRON_RUN_AS_NODE=1"
  "%RUNTIME%" "%SCRIPT%" %*
) else (
  "%SystemRoot%\System32\where.exe" node.exe >nul 2>nul || (
    echo DeepSeek Harness was not found. Install DeepSeek Harness Desktop first,
    echo or set DSH_CLI to the full path of its dsh.cmd.
    set "CODE=1"
    goto finish
  )
  node.exe "%SCRIPT%" %*
)
set "CODE=%ERRORLEVEL%"

:finish
rem Double-clicking closes the window as soon as the script ends; keep it open so the result
rem can be read. Skipped when arguments are given (scripted use) or when run inside a cmd prompt.
rem find.exe / where.exe are called by full path: Git's GNU find can come first on PATH.
if not "%~1"=="" goto done
echo %CMDCMDLINE% | "%SystemRoot%\System32\find.exe" /i "/c" >nul
if not errorlevel 1 pause

:done
exit /b %CODE%
