@echo off
setlocal
title RIFA - VERIFICAR QUE NO SE DUERMA
set "URL=https://rifaek2026.onrender.com/api/estado"

echo ============================================================
echo  Verificar estado de la RIFA en Render
echo  URL: %URL%
echo ============================================================
echo.

echo [1/2] Consultando el servidor (si estaba dormido, puede tardar unos segundos)...
powershell -NoProfile -Command "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}; try { $w = New-Object System.Net.WebClient; $w.Headers.Add('User-Agent','KeepAlive'); $r = $w.DownloadString('%URL%'); if ($r -match 'ok') { Write-Host '  OK - La rifa responde (servidor despierto).' } else { Write-Host '  Responde, pero con formato inesperado.' } } catch { Write-Host '  CAIDO o dormido ->' $_.Exception.Message }"

echo.
echo [2/2] Abriendo el panel de UptimeRobot y la URL monitoreada...
start "" "https://dashboard.uptimerobot.com/monitors"
start "" "%URL%"

echo.
echo Revisa en UptimeRobot que el monitor de la rifa cumpla:
echo   1) Estado UP (verde).
echo   2) Intervalo = 5 minutes.
echo   3) El monitor esta ACTIVE (no Paused).
echo.
echo Si el monitor esta verde y en 5 min, la rifa ya no se duerme.
echo.
pause
