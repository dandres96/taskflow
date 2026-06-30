@echo off
title TaskFlow Server
cd /d C:\Users\Equipo\.openclaw-autoclaw\workspace\taskflow

echo ========================================
echo   TaskFlow - Iniciando...
echo ========================================

:: Kill anything on port 3000
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1
)

:: Start server with tunnel
node server.js

echo.
echo Si ves este mensaje, el servidor se detuvo.
echo Presiona una tecla para reiniciar...
pause >nul
start.bat
