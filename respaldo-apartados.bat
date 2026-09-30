@echo off
REM ============================================================
REM  respaldo-apartados.bat
REM  Trae la copia desde GitHub. NO sube nada: Render es
REM  quien guarda, este script solo mantiene esta PC al dia.
REM ============================================================
cd /d "C:\Users\Ramon\Documents\Default Project\apartados"
node sincronizar-respaldo.js
exit /b 0
