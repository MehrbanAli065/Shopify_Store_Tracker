@echo off
REM ===========================================================
REM  Nightly ingest - reads the scraper's own output folder.
REM
REM  Use this on the machine where the CSVs land (the UiPath VM).
REM  No Google credentials are needed: the files are already on disk
REM  here, before they are uploaded to Drive.
REM
REM  Edit the three paths below, then:
REM    Task Scheduler > Create Task > Triggers: Daily
REM    Action: Start a program > this file
REM    "Run whether user is logged on or not" + "Run with highest privileges"
REM ===========================================================

set "APPDIR=C:\shopify-tracker\tracker"
set "DROPDIR=C:\Users\Administrator\Documents\UiPath\Shopify_Scraper\Scrapped_Csv_Files"
set "ARCHIVEDIR=C:\Users\Administrator\Documents\UiPath\Shopify_Scraper\Ingested"

set "LOGDIR=%APPDIR%\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%i

cd /d "%APPDIR%"
echo ============================================ >> "%LOGDIR%\ingest-%TODAY%.log"
echo Run started %DATE% %TIME%                    >> "%LOGDIR%\ingest-%TODAY%.log"

REM --archive moves each ingested file into ARCHIVEDIR so the drop folder stays
REM clean and a failed file is obvious. Use --delete to remove them instead.
node scripts\ingest-folder.mjs --dir "%DROPDIR%" --archive "%ARCHIVEDIR%" --concurrency 3 >> "%LOGDIR%\ingest-%TODAY%.log" 2>&1

set CODE=%ERRORLEVEL%
echo Run finished %DATE% %TIME% (exit %CODE%)     >> "%LOGDIR%\ingest-%TODAY%.log"

REM exit 1 means at least one store failed - Task Scheduler shows the task as
REM failed, which is what you want so a broken night is visible.
exit /b %CODE%
