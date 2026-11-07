@echo off
rem ------------------------------------------------------------------
rem  AiPDF Editor - one-double-click launcher
rem  First run: installs the app's parts automatically (once only).
rem  Every run after that: starts the app straight away.
rem ------------------------------------------------------------------
title AiPDF Editor

rem --- Check that Node.js is installed ------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [X] Node.js was not found.
  echo.
  echo  Please install it first - see the "INSTALL.md" guide, Step 1.
  echo  Download: https://nodejs.org  ^(choose the LTS version^)
  echo  After installing, close this window and double-click again.
  echo.
  pause
  exit /b 1
)

rem --- First run: install the dependencies automatically ------------
if not exist "node_modules" (
  echo  First run detected: downloading the app's parts.
  echo  This happens only ONCE and can take 2-10 minutes.
  echo  Please do not close this window...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo  [X] The download failed. Check your internet connection,
    echo      then close this window and double-click again.
    echo      More help: the Troubleshooting table in INSTALL.md
    echo.
    pause
    exit /b 1
  )
)

rem --- Start the app -------------------------------------------------
echo  Starting AiPDF Editor... this window must stay open.
call npm start
