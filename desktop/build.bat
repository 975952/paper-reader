@echo off
rem ============================================================
rem  prt - desktop shell, one-click release build.
rem
rem  NOTE: this file is deliberately 100%% ASCII. cmd.exe parses
rem  .bat files with the OEM code page (936 on zh-CN), so any
rem  UTF-8 comment here would be decoded as garbage and executed
rem  (or worse: silently swallow the next line).
rem
rem  Why the steps are shaped like this:
rem  1) touch src\assets.rs before cargo build. The frontend is
rem     embedded by rust-embed at compile time, and cargo only
rem     tracks files it saw during the PREVIOUS compile, so a NEW
rem     file under public/ does not trigger a rebuild and silently
rem     never reaches the exe.
rem  2) never kill a running reader. This script used to close every
rem     process named after the app so the copy could overwrite a
rem     running exe - which also closed the copy the user was
rem     reading. Now it kills nothing: the project-root copy is
rem     required (retry for 10s, then report how to free it), and
rem     the Desktop copy is best-effort (if it is in use, print a
rem     note and leave the old one alone; close the app and rerun
rem     build.bat when it is convenient).
rem  3) verify the SHA256 of every destination - a copy onto a
rem     running exe fails silently otherwise, and tests then "pass"
rem     against a stale binary. The copy retries for up to 10s
rem     because Windows releases the file handle a moment after
rem     the last handle closes.
rem ============================================================
setlocal
cd /d "%~dp0"

echo [1/3] cargo build --release
powershell -NoProfile -Command "(Get-Item 'src\assets.rs').LastWriteTime = Get-Date"
cargo build --release
if errorlevel 1 (
  echo.
  echo [x] cargo build failed
  exit /b 1
)

echo.
echo [2/3] copy prt.exe to project root and the Desktop ^(running instances are left alone^)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$src = (Resolve-Path 'target\release\prt.exe').Path;" ^
  "$root = (Resolve-Path '..').Path;" ^
  "$desktop = [Environment]::GetFolderPath('Desktop');" ^
  "$dst = @((Join-Path $root 'prt.exe'), (Join-Path $desktop 'prt.exe'));" ^
  "$latest = (Get-ChildItem '..\public' -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime;" ^
  "$sha = [Security.Cryptography.SHA256]::Create();" ^
  "$want = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($src))).Replace('-', '');" ^
  "$bad = 0;" ^
  "foreach ($d in $dst) {" ^
  "  $isDesktop = $d.StartsWith($desktop, [StringComparison]::OrdinalIgnoreCase);" ^
  "  $ok = 0;" ^
  "  for ($i = 0; $i -lt 20 -and -not $ok; $i++) {" ^
  "    try { Copy-Item -Force $src $d -ErrorAction Stop; $ok = 1 } catch { Start-Sleep -Milliseconds 500 }" ^
  "  }" ^
  "  if (-not $ok) {" ^
  "    if ($isDesktop) { Write-Host ('      [!] ' + $d + ' : in use, skipped - close the app and rerun build.bat to update the Desktop copy'); continue }" ^
  "    Write-Host ('      [x] ' + $d + ' : locked - a reader is running from this folder; close it and rerun build.bat'); $bad = 1; continue" ^
  "  }" ^
  "  $got = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($d))).Replace('-', '');" ^
  "  if ($got -ne $want) { Write-Host ('      [x] MISMATCH ' + $d); $bad = 1; continue }" ^
  "  try { (Get-Item $d).LastWriteTime = $latest } catch { }" ^
  "  Write-Host ('      -> ' + $d + '  (' + (Get-Item $d).Length + ' B, sha256 ok)')" ^
  "}" ^
  "exit $bad"
if errorlevel 1 (
  echo [x] project-root copy failed - close the reader that is running from this folder and run build.bat again
  exit /b 1
)

echo.
echo [3/3] done - double click prt.exe to start
exit /b 0
