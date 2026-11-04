@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title StreamChat Hub

if exist "release\StreamChatHub-1.1.2-portable.exe" (
  start "" "release\StreamChatHub-1.1.2-portable.exe"
  exit /b 0
)

if exist "..\StreamChat Hub.exe" (
  start "" "..\StreamChat Hub.exe"
  exit /b 0
)

if exist "node_modules\.bin\electron.cmd" (
  start "" cmd /c "node_modules\.bin\electron.cmd ."
  exit /b 0
)

echo.
echo No se encontro StreamChat Hub.exe.
echo Abre directamente "StreamChat Hub.exe" del escritorio o la carpeta release.
echo.
pause
