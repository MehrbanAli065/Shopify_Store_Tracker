@echo off
REM ===========================================================
REM  Wrapper for the n8n "Execute Command" node.
REM
REM  Two deliberate differences from nightly.bat:
REM
REM  1. This ALWAYS exits 0 and prints EXITCODE=n instead.
REM     n8n treats a non-zero exit as a node failure and replaces
REM     the node's output with an error object - which would throw
REM     away stdout, and with it every per-store result. The
REM     workflow's "Read the result" node reads EXITCODE= instead.
REM
REM  2. --delete rather than --archive. Archiving keeps the files
REM     on Drive, and Drive is at 98%%. Only --delete frees quota.
REM     Safe: the database is the archive - see DRIVE.md.
REM
REM  Edit APPDIR if the project moves. Everything else the workflow
REM  needs is read from tracker\.env.
REM ===========================================================

set "APPDIR=E:\Company_Projects\Shopify_Stores\tracker"

if not exist "%APPDIR%\scripts\ingest-drive.mjs" (
  echo Cannot find the tracker at %APPDIR% - fix APPDIR in this file.
  echo EXITCODE=1
  exit /b 0
)

set "LOGDIR=%APPDIR%\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%i

cd /d "%APPDIR%"

REM One run per day, and the date is in the filename, so a re-run
REM legitimately replaces that day's log rather than appending to it.
node scripts\ingest-drive.mjs --delete --concurrency 3 > "%LOGDIR%\ingest-%TODAY%.log" 2>&1
set CODE=%ERRORLEVEL%

REM Hand the same output to n8n so it lands in the execution record.
type "%LOGDIR%\ingest-%TODAY%.log"

echo EXITCODE=%CODE%
exit /b 0
