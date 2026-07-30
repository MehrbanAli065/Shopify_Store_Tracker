@echo off
REM ===========================================================
REM  Ingest the scraper's own output folder into the database.
REM
REM  Runs on the machine where the CSVs land (the UiPath VM).
REM  No Google credentials needed - the files are already on disk
REM  here, before they are uploaded to Drive.
REM
REM  Two ways to use it:
REM    1. UiPath: add a "Start Process" activity after the upload
REM       loop, FileName = this file. Scrape -> upload -> ingest.
REM    2. Task Scheduler: a daily task pointing at this file.
REM
REM  Paths below are already set for this project. Change them only
REM  if the folders move.
REM ===========================================================

set "APPDIR=C:\shopify-tracker\tracker"
set "DROPDIR=C:\Users\Administrator\Documents\UiPath\Shopify_Scraper\Scrapped_Csv_Files"
set "ARCHIVEDIR=C:\Users\Administrator\Documents\UiPath\Shopify_Scraper\Ingested"

REM ---- sanity checks, so a misconfigured path fails loudly -----
if not exist "%APPDIR%\scripts\ingest-folder.mjs" (
  echo ERROR: APPDIR is wrong - ingest-folder.mjs not found under %APPDIR%
  exit /b 2
)
if not exist "%DROPDIR%" (
  echo ERROR: DROPDIR does not exist: %DROPDIR%
  exit /b 2
)
where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: node is not on PATH. Install Node.js LTS from https://nodejs.org
  exit /b 2
)

set "LOGDIR=%APPDIR%\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%i
set "LOG=%LOGDIR%\ingest-%TODAY%.log"

cd /d "%APPDIR%"
echo ============================================ >> "%LOG%"
echo Run started %DATE% %TIME%                    >> "%LOG%"

REM --archive moves each ingested file into ARCHIVEDIR, so the drop folder stays
REM clean and anything left behind is a file that failed. Use --delete instead
REM to remove them outright.
node scripts\ingest-folder.mjs --dir "%DROPDIR%" --archive "%ARCHIVEDIR%" --concurrency 3 >> "%LOG%" 2>&1

set CODE=%ERRORLEVEL%
echo Run finished %DATE% %TIME% (exit %CODE%)     >> "%LOG%"

REM exit 1 means at least one store failed. UiPath's Start Process can surface
REM that, and Task Scheduler marks the task failed - which is what you want, so
REM a broken night is visible instead of passing silently.
exit /b %CODE%
