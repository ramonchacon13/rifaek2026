@echo off
REM ============================================================
REM  respaldo-apartados.bat
REM  Copia los datos a respaldo.json y lo sube a GitHub.
REM  Asi Render puede recuperar todo si pierde su disco.
REM ============================================================
setlocal
set "BASE=C:\Users\Ramon\Documents\Default Project\apartados"
set "ORIGEN=%BASE%\server\datos.json"
set "DESTINO=%BASE%\respaldo.json"

if not exist "%ORIGEN%" exit /b 0
copy /Y "%ORIGEN%" "%DESTINO%" >nul 2>&1

cd /d "%BASE%"
git add respaldo.json >nul 2>&1
git diff --cached --quiet -- respaldo.json
if errorlevel 1 (
  git -c user.name="respaldo-bot" -c user.email="respaldo-bot@users.noreply.github.com" commit -m "Respaldo automatico" >nul 2>&1
  git push >nul 2>&1
)
endlocal
exit /b 0
