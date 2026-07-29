@echo off
REM ===========================================================
REM  Nightly ingest — run this from Windows Task Scheduler on
REM  whichever machine the scraper drops its CSVs onto.
REM
REM  Edit the three paths below, then:
REM    Task Scheduler > Create Task > Triggers: Daily
REM    Action: Start a program > this file
REM    "Run whether user is logged on or not" + "Run with highest privileges"
REM ===========================================================

set APPDIR=E:\Company_Projects\Shopify_Stores\tracker
set DROPDIR=C:\Users\Administrator\Documents\UiPath\Shopify_Scraper\Scrapped_Csv_Files
set ARCHIVEDIR=C:\Users\Administrator\Documents\UiPath\Shopify_Scraper\Ingested

set LOGDIR=%APPDIR%\logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

REM date stamp for the log file (locale-independent)
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%i

cd /d "%APPDIR%"
echo ============================================ >> "%LOGDIR%\ingest-%TODAY%.log"
echo Run started %DATE% %TIME%                    >> "%LOGDIR%\ingest-%TODAY%.log"

node scripts\ingest-folder.mjs --dir "%DROPDIR%" --archive "%ARCHIVEDIR%" --concurrency 3 ^
  >> "%LOGDIR%\ingest-%TODAY%.log" 2>&1

set CODE=%ERRORLEVEL%
echo Run finished %DATE% %TIME% (exit %CODE%)     >> "%LOGDIR%\ingest-%TODAY%.log"

REM exit 1 means at least one store failed — Task Scheduler will show it as failed,
REM which is what you want so a broken night is visible in the task history.
exit /b %CODE%
