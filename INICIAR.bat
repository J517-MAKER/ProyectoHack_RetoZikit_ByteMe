@echo off
rem ===================================================
rem  SecureGuard - doble clic para arrancar (Windows)
rem  La primera vez prepara Python e instala lo necesario;
rem  despues solo levanta los servidores y abre el tablero.
rem ===================================================
title SecureGuard - gramo
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\iniciar.ps1" %*
if errorlevel 1 (
  echo.
  echo   Algo salio mal. Lee el mensaje de arriba o revisa la carpeta logs\
)
echo.
pause
