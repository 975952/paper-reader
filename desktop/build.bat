@echo off
rem ============================================================
rem  Paper Reader - desktop shell, one-click release build.
rem
rem  NOTE: this file is deliberately 100%% ASCII. cmd.exe parses
rem  .bat files with the OEM code page (936 on zh-CN), so any
rem  UTF-8 comment here would be decoded as garbage and executed
rem  (or worse: silently swallow the next line). The Chinese
rem  output filename is therefore built from its Unicode code
rem  points at run time:
rem      U+8BBA U+6587 U+9605 U+8BFB U+5668  =  "LunWenYueDuQi"
rem
rem  Why the steps are shaped like this (all learned the hard way):
rem  1) touch src\assets.rs before cargo build. The frontend is
rem     embedded by rust-embed at compile time, and cargo only
rem     tracks files it saw during the PREVIOUS compile, so a NEW
rem     file under public/ does not trigger a rebuild and silently
rem     never reaches the exe.
rem  2) kill the running instance by PROCESS NAME before copying.
rem     The shipped process name is Chinese "LunWenYueDuQi", not
rem     "paper-reader.exe", so an /IM paper-reader.exe taskkill
rem     misses it. Also: never use try/catch inside a Where-Object
rem     block - "try" is a statement, not an expression, and
rem     PowerShell will treat it as a command name and fail.
rem  3) copy, then verify the SHA256 of BOTH destinations. A copy
rem     onto a running exe fails silently otherwise, and tests then
rem     "pass" against a stale binary. Two hardening details learned
rem     the hard way: the copy RETRIES for up to 10s (killing the app
rem     releases the file handle a moment later than the process
rem     disappears - a one-shot copy right after the kill failed),
rem     and the cosmetic LastWriteTime touch is wrapped in try/catch
rem     (a locked target used to abort the whole statement, so
rem     powershell -Command exited 1 although both copies verified).
rem ============================================================
setlocal
cd /d "%~dp0"

echo [1/4] cargo build --release
powershell -NoProfile -Command "(Get-Item 'src\assets.rs').LastWriteTime = Get-Date"
cargo build --release
if errorlevel 1 (
  echo.
  echo [x] cargo build failed
  exit /b 1
)

echo.
echo [2/4] stop any running instance - otherwise the copy is locked
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$t = -join ([char]0x8BBA,[char]0x6587,[char]0x9605,[char]0x8BFB,[char]0x5668);" ^
  "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq $t -or $_.ProcessName -eq 'paper-reader' -or $_.MainWindowTitle -eq $t } | Stop-Process -Force -ErrorAction SilentlyContinue;" ^
  "Start-Sleep -Milliseconds 1500"

echo.
echo [3/4] copy exe to project root and the Desktop
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$n = -join ([char]0x8BBA,[char]0x6587,[char]0x9605,[char]0x8BFB,[char]0x5668);" ^
  "$src = (Resolve-Path 'target\release\paper-reader.exe').Path;" ^
  "$root = (Resolve-Path '..').Path;" ^
  "$dst = @((Join-Path $root ($n + '.exe')), (Join-Path ([Environment]::GetFolderPath('Desktop')) ($n + '.exe')));" ^
  "$latest = (Get-ChildItem '..\public' -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime;" ^
  "$sha = [Security.Cryptography.SHA256]::Create();" ^
  "$want = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($src))).Replace('-', '');" ^
  "$bad = 0;" ^
  "foreach ($d in $dst) {" ^
  "  $ok = 0;" ^
  "  for ($i = 0; $i -lt 20 -and -not $ok; $i++) {" ^
  "    try { Copy-Item -Force $src $d -ErrorAction Stop; $ok = 1 } catch { Start-Sleep -Milliseconds 500 }" ^
  "  }" ^
  "  if (-not $ok) { Write-Host ('      [x] ' + $d + ' : still locked (app open?)'); $bad = 1; continue }" ^
  "  $got = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($d))).Replace('-', '');" ^
  "  if ($got -ne $want) { Write-Host ('      [x] MISMATCH ' + $d); $bad = 1; continue }" ^
  "  try { (Get-Item $d).LastWriteTime = $latest } catch { }" ^
  "  Write-Host ('      -> ' + $d + '  (' + (Get-Item $d).Length + ' B, sha256 ok)')" ^
  "}" ^
  "exit $bad"
if errorlevel 1 (
  echo [x] copy failed - close the app and run this again
  exit /b 1
)

echo.
echo [4/4] done - double click that exe to start
exit /b 0
