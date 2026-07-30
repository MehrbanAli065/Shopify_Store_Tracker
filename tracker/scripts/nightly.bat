@echo off
REM ===========================================================
REM  Nightly ingest - pulls the day's CSVs straight from Drive.
REM
REM  Set APPDIR below, make sure tracker\.env holds DATABASE_URL,
REM  DRIVE_FOLDER_ID and the Google credentials (see DRIVE.md), then:
REM    Task Scheduler > Create Task > Triggers: Daily
REM    Action: Start a program > this file
REM    "Run whether user is logged on or not" + "Run with highest privileges"
REM ===========================================================

set "APPDIR=E:\Company_Projects\Shopify_Stores\tracker"

set "LOGDIR=%APPDIR%\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%i

cd /d "%APPDIR%"
echo ============================================ >> "%LOGDIR%\ingest-%TODAY%.log"
echo Run started %DATE% %TIME%                    >> "%LOGDIR%\ingest-%TODAY%.log"

REM --archive moves each ingested file into Drive/Ingested/ so the folder does
REM not fill up. Use --trash instead to delete them outright.
node scripts\ingest-drive.mjs --archive --concurrency 3 >> "%LOGDIR%\ingest-%TODAY%.log" 2>&1

set CODE=%ERRORLEVEL%
echo Run finished %DATE% %TIME% (exit %CODE%)     >> "%LOGDIR%\ingest-%TODAY%.log"

REM exit 1 means at least one store failed - Task Scheduler shows the task as
REM failed, which is what you want so a broken night is visible.
exit /b %CODE%
