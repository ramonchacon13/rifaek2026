@echo off
REM ============================================================
REM  iniciar-apartados.bat  -  Arranca el servidor del afiche
REM  0.0.0.0:3260  (el afiche publico y el panel del organizador)
REM  Copialo junto a la carpeta "server" y ejecutalo doble click.
REM ============================================================
title APARTADOS - SERVIDOR
cd /d "%~dp0"

REM 1) Ver que este instalado node
where node >nul 2>&1
if errorlevel 1 (
  echo FALTA NODE.JS. Instalalo desde https://nodejs.org y vuelve a ejecutar.
  echo.
  pause
  exit /b 1
)

REM 2) Actualizar el codigo desde GitHub
if exist ".git" (
  echo [1/2] Actualizando desde GitHub...
  git pull --ff-only
) else (
  echo [1/2] Sin git en esta carpeta: se usa la copia que ya hay aqui.
)

REM 3) Arrancar el servidor
echo [2/2] Arrancando el servidor del afiche...
start "APARTADOS-SERVER" node server\server.js

echo.
echo Servidor iniciado. Abre en el navegador:
echo   Desde esta Win7 : http://localhost:3260/afiche.html
echo   Desde otras PC  : http://192.168.1.10:3260/afiche.html
echo   Panel organizador: http://192.168.1.10:3260/afiche-admin.html  (clave 1234)
echo.
echo Para detenerlo, cierra la ventana "APARTADOS-SERVER".
pause
