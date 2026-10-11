@echo off
rem Double-click entry for scripts\install-plugins.mjs: install / update / uninstall this repo's
rem DSH plugins, or show their status. Arguments are passed through, e.g.
rem   install-plugins.cmd --action install --plugins all --profiles desktop --yes
rem Kept ASCII-only on purpose: cmd.exe parses batch files in the console code page, so any
rem Chinese text here would break on non-UTF-8 consoles. All prompts live in the .mjs.
rem
rem No system Node.js is required: DSH ships a console node.exe as its "primary runtime"
rem (resources\runtime\primary-runtime\dependencies\node\bin\node.exe) and the script runs on it.
rem Not "DeepSeek Harness.exe" with ELECTRON_RUN_AS_NODE=1 the way dsh.cmd does it: that exe is a
rem GUI-subsystem binary without console input, so every interactive prompt reads EOF at once.
rem If that path moves, the copy DSH keeps under %DSH_HOME%\dsh-runtimes is tried next;
rem a system node is only the last resort.
setlocal

set "SCRIPT=%~dp0scripts\install-plugins.mjs"
if not exist "%SCRIPT%" (
  echo Cannot find "%SCRIPT%".
  pause
  exit /b 1
)

rem Locate dsh.cmd (DSH_CLI override, PATH, then the default per-user install location);
rem the runtime sits beside it: resources\runtime\{cli\bin\dsh.cmd, primary-runtime\...}.
set "DSHCMD="
if defined DSH_CLI if exist "%DSH_CLI%" set "DSHCMD=%DSH_CLI%"
if not defined DSHCMD for %%I in (dsh.cmd) do set "DSHCMD=%%~$PATH:I"
if not defined DSHCMD if exist "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" set "DSHCMD=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"

set "RUNTIME="
if defined DSHCMD for %%I in ("%DSHCMD%\..\..\..\primary-runtime\dependencies\node\bin\node.exe") do if exist "%%~fI" set "RUNTIME=%%~fI"

rem Fallback: DSH also keeps a copy of the primary runtime under its home directory
rem (DSH_HOME, default %USERPROFILE%\.dsh). The install-dir layout above is internal and may
rem move in a future DSH release; this copy keeps the installer working without system Node.
set "HOMEDIR=%USERPROFILE%\.dsh"
if defined DSH_HOME set "HOMEDIR=%DSH_HOME%"
if not defined RUNTIME if exist "%HOMEDIR%\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "RUNTIME=%HOMEDIR%\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

if defined RUNTIME (
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
