@echo off
setlocal

cd /d "%~dp0"

set "PARKHUNTER_URL=http://127.0.0.1:3000"
set "PARKHUNTER_LOCK=%TEMP%\ParkHunter-3000.lock"
set "HOST=0.0.0.0"

if /i "%~1"=="--server" goto server_window

call :is_running
if not errorlevel 1 goto open_existing

if exist "%PARKHUNTER_LOCK%" (
  echo Removing stale ParkHunter startup lock.
  rmdir "%PARKHUNTER_LOCK%" 2>nul
)

start "ParkHunter Server" /D "%~dp0" "%ComSpec%" /k ""%~f0" --server"
timeout /t 1 /nobreak >nul
start "" "%PARKHUNTER_URL%"
exit /b 0

:server_window
title ParkHunter Server

call :is_running
if not errorlevel 1 goto open_existing

mkdir "%PARKHUNTER_LOCK%" 2>nul
if errorlevel 1 goto wait_for_existing

call :is_running
if not errorlevel 1 goto release_and_open

echo Starting ParkHunter...
echo Local URL: %PARKHUNTER_URL%
echo Network URLs:
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } | ForEach-Object { '  http://' + $_.IPAddress + ':3000' }"
echo.
echo Close this window to stop the server.
echo.

start "" "%PARKHUNTER_URL%"
npm.cmd start
set "PARKHUNTER_EXIT=%ERRORLEVEL%"

rmdir "%PARKHUNTER_LOCK%" 2>nul

echo.
echo ParkHunter stopped.
pause
exit /b %PARKHUNTER_EXIT%

:wait_for_existing
echo ParkHunter is already starting. Waiting for it to answer...
for /l %%I in (1,1,30) do (
  call :is_running
  if not errorlevel 1 goto open_existing
  timeout /t 1 /nobreak >nul
)

echo Startup lock looked stale. Clearing it and trying again...
rmdir "%PARKHUNTER_LOCK%" 2>nul
goto server_window

:release_and_open
rmdir "%PARKHUNTER_LOCK%" 2>nul
goto open_existing

:open_existing
echo ParkHunter is already running.
start "" "%PARKHUNTER_URL%"
exit /b 0

:is_running
powershell -NoProfile -ExecutionPolicy Bypass -Command "$client = [Net.Sockets.TcpClient]::new(); try { $connect = $client.BeginConnect('127.0.0.1', 3000, $null, $null); if ($connect.AsyncWaitHandle.WaitOne(250)) { $client.EndConnect($connect); exit 0 }; exit 1 } catch { exit 1 } finally { $client.Close() }"
exit /b %ERRORLEVEL%
