# 论文阅读器桌面壳 —— 一键验收脚本
#
#   powershell -NoProfile -File tools\acceptance.ps1            # 起一个干净的测试实例跑全套
#   powershell -NoProfile -File tools\acceptance.ps1 -NoStart -Port 8788   # 测已经跑着的实例
#
# 测试数据全部落在 target\release\ 下，不碰项目根目录的 papers/ 和 data/。
# 注意：这个文件是 UTF-8 **带 BOM** 的（Windows PowerShell 5.1 否则会把中文读成乱码）。

param(
  [int]$Port = 8810,
  [int]$MockPort = 8899,
  [switch]$NoStart,
  [switch]$KeepData
)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktop = Split-Path -Parent $here
$rel = Join-Path $desktop 'target\release'
$exe = Join-Path $rel 'paper-reader.exe'
$papersDir = Join-Path $rel 'papers'
$dataDir = Join-Path $rel 'data'
$tmp = Join-Path $env:TEMP 'prt-accept'
New-Item -ItemType Directory -Force -Path $tmp, $papersDir | Out-Null

$script:pass = 0
$script:fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Host ("  [PASS] {0} {1}" -f $name, $detail) -ForegroundColor Green }
  else { $script:fail++; Write-Host ("  [FAIL] {0} {1}" -f $name, $detail) -ForegroundColor Red }
}
function Section([string]$t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }

# ---------------------------------------------------------------- HTTP 小工具
# 注意：Windows PowerShell 5.1 把带引号的 JSON 当原生命令行参数传会被拆坏，
# 所以 body 一律写进文件再用 --data-binary @file。
function Http([string]$url, [string[]]$extra = @()) {
  $h = Join-Path $tmp 'h.txt'; $b = Join-Path $tmp 'b.bin'
  Remove-Item $h, $b -ErrorAction SilentlyContinue
  $code = & curl.exe -s -D $h -o $b -w '%{http_code}' @extra $url
  return @{
    code    = [int]$code
    headers = (Get-Content $h -Raw -ErrorAction SilentlyContinue)
    body    = (Get-Content $b -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)
    file    = $b
  }
}
function PostJson([string]$url, [string]$json) {
  $f = Join-Path $tmp 'body.json'
  [System.IO.File]::WriteAllText($f, $json, (New-Object System.Text.UTF8Encoding($false)))
  return Http $url @('-X', 'POST', '-H', 'Content-Type: application/json', '--data-binary', "@$f")
}
function HeaderOf($res, [string]$name) {
  if (-not $res.headers) { return '' }
  $m = [regex]::Match($res.headers, "(?im)^$([regex]::Escape($name)):\s*(.+?)\r?$")
  if ($m.Success) { return $m.Groups[1].Value.Trim() } else { return '' }
}
function GetJson([string]$url) { return (Http $url).body | ConvertFrom-Json }

$B = "http://127.0.0.1:$Port"
$started = $null

# ---------------------------------------------------------------- 起被测服务
if (-not $NoStart) {
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "端口 $Port 已被占用" -ForegroundColor Yellow; exit 2
  }
  if (-not (Test-Path $exe)) { Write-Host "找不到 $exe，先跑 build.bat" -ForegroundColor Red; exit 2 }

  if (-not $KeepData) {
    # 每轮从干净状态开始，默认值/空列表之类的断言才有意义
    foreach ($f in @('config.json', 'state.json', 'window.json')) {
      Remove-Item (Join-Path $dataDir $f) -ErrorAction SilentlyContinue
    }
    Get-ChildItem $dataDir -Filter 'notes-*.json' -ErrorAction SilentlyContinue | Remove-Item -Force
  }
  & node (Join-Path $here 'make-test-pdf.js') (Join-Path $papersDir 'sample.pdf') | Out-Null
  Copy-Item (Join-Path $papersDir 'sample.pdf') (Join-Path $papersDir '论文 测试.pdf') -Force

  $started = Start-Process -FilePath $exe -WorkingDirectory $rel -ArgumentList @('--port', "$Port") -PassThru
  $ok = $false
  foreach ($i in 1..40) {
    Start-Sleep -Milliseconds 400
    if ((Http "$B/api/health").code -eq 200) { $ok = $true; break }
  }
  if (-not $ok) { Write-Host "服务没起来" -ForegroundColor Red; exit 2 }
  Write-Host "被测实例: pid=$($started.Id)  $B" -ForegroundColor DarkGray
}

try {
  Section '健康检查'
  $r = Http "$B/api/health"
  Check '/api/health 200' ($r.code -eq 200) $r.body
  Check '/api/health 带 port' ($r.body -match "`"port`":$Port")

  Section '论文列表'
  $r = Http "$B/api/papers"
  $j = $r.body | ConvertFrom-Json
  $names = @($j.papers | ForEach-Object { $_.name })
  Check '/api/papers 200' ($r.code -eq 200)
  Check '列出 sample.pdf' ($names -contains 'sample.pdf') ("names=" + ($names -join ','))
  Check '列出中文名 PDF' ($names -contains '论文 测试.pdf')
  Check '只有 .pdf' (@($names | Where-Object { $_ -notmatch '\.pdf$' }).Count -eq 0)
  Check 'dir 是 papers 绝对路径' ($j.dir -eq $papersDir) $j.dir
  Check 'mtime 倒序' (@($j.papers)[0].mtime -ge @($j.papers)[-1].mtime)
  $sp = $j.papers | Where-Object { $_.name -eq 'sample.pdf' }
  Check 'url 做了 encodeURIComponent' ($sp.url -eq '/api/pdf?name=sample.pdf')
  Check 'docId 与 server.js 一致' ($sp.docId -eq 'sample-52e4341f') $sp.docId
  $cn = $j.papers | Where-Object { $_.name -eq '论文 测试.pdf' }
  Check '中文名 url 编码' ($cn.url -eq '/api/pdf?name=%E8%AE%BA%E6%96%87%20%E6%B5%8B%E8%AF%95.pdf') $cn.url

  Section 'PDF 读取 / Range'
  $fileLen = (Get-Item (Join-Path $papersDir 'sample.pdf')).Length
  $r = Http "$B/api/pdf?name=sample.pdf"
  Check '200 全量' ($r.code -eq 200) "len=$fileLen"
  Check 'Content-Type=application/pdf' ((HeaderOf $r 'Content-Type') -eq 'application/pdf')
  Check 'Accept-Ranges: bytes' ((HeaderOf $r 'Accept-Ranges') -eq 'bytes')
  Check 'Content-Length 正确' ((HeaderOf $r 'Content-Length') -eq "$fileLen")

  $r = Http "$B/api/pdf?name=sample.pdf" @('-H', 'Range: bytes=0-99')
  Check 'bytes=0-99 → 206' ($r.code -eq 206)
  Check '  Content-Range 正确' ((HeaderOf $r 'Content-Range') -eq "bytes 0-99/$fileLen") (HeaderOf $r 'Content-Range')
  Check '  Content-Length=100' ((HeaderOf $r 'Content-Length') -eq '100')

  $r = Http "$B/api/pdf?name=sample.pdf" @('-H', 'Range: bytes=100-')
  Check 'bytes=100- → 206' ($r.code -eq 206)
  Check '  Content-Range 正确' ((HeaderOf $r 'Content-Range') -eq "bytes 100-$($fileLen-1)/$fileLen")

  $r = Http "$B/api/pdf?name=sample.pdf" @('-H', 'Range: bytes=-50')
  Check 'bytes=-50 → 206 后缀区间' ($r.code -eq 206)
  Check '  Content-Range 正确' ((HeaderOf $r 'Content-Range') -eq "bytes $($fileLen-50)-$($fileLen-1)/$fileLen")

  $r = Http "$B/api/pdf?name=sample.pdf" @('-H', 'Range: bytes=99999-')
  Check '越界 → 416' ($r.code -eq 416)
  Check '  416 带 Content-Range: bytes */total' ((HeaderOf $r 'Content-Range') -eq "bytes */$fileLen")

  $r = Http "$B/api/pdf?name=sample.pdf" @('-I')
  Check 'HEAD 200 + Content-Length，无 body' ($r.code -eq 200 -and (HeaderOf $r 'Content-Length') -eq "$fileLen")

  $src = [System.IO.File]::ReadAllBytes((Join-Path $papersDir 'sample.pdf'))
  $r = Http "$B/api/pdf?name=sample.pdf" @('-H', 'Range: bytes=10-59')
  $got = [System.IO.File]::ReadAllBytes($r.file)
  $want = $src[10..59]
  Check 'Range 字节内容与源文件一致' ((-not (Compare-Object $got $want)) -and $got.Length -eq 50)

  $r = Http "$B/api/pdf?name=%E8%AE%BA%E6%96%87%20%E6%B5%8B%E8%AF%95.pdf"
  Check '中文文件名也能取到' ($r.code -eq 200 -and (HeaderOf $r 'Content-Length') -eq "$fileLen")

  Section '目录穿越防护'
  $evil = @('/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/..%5Cserver.js', '/%2e%2e%2fserver.js',
    '/subdir/../../server.js', '/C:/Windows/win.ini', '/%00', '/js/../../server.js')
  foreach ($p in $evil) {
    $r = Http "$B$p" @('--path-as-is')
    $leaked = $r.body -match 'require\(|createServer'
    Check "静态穿越 $p → 400/404" (($r.code -eq 400 -or $r.code -eq 404) -and -not $leaked) "code=$($r.code)"
  }
  foreach ($n in @('..%2F..%2Fserver.js', '%2e%2e%2fserver.js', 'C%3A%5CWindows%5Cwin.ini', 'sub%2F..%2F..%2Fserver.js')) {
    $r = Http "$B/api/pdf?name=$n"
    $leaked = $r.body -match 'require\('
    Check "pdf name 穿越 $n → 400" ($r.code -eq 400 -and -not $leaked) "code=$($r.code)"
  }
  $r = Http "$B/api/pdf?name=missing.pdf"
  Check 'pdf 不存在 → 404' ($r.code -eq 404)

  Section '静态资源'
  $r = Http "$B/"
  Check '/ → 200 text/html' ($r.code -eq 200 -and (HeaderOf $r 'Content-Type') -eq 'text/html; charset=utf-8')
  $r = Http "$B/vendor/pdf.min.mjs"
  Check '.mjs → text/javascript' ((HeaderOf $r 'Content-Type') -eq 'text/javascript; charset=utf-8')
  $r = Http "$B/style.css"
  Check '.css → text/css' ((HeaderOf $r 'Content-Type') -eq 'text/css; charset=utf-8')
  $r = Http "$B/unknown-route"
  Check '未知无扩展名 → 回落 index.html' ($r.code -eq 200 -and (HeaderOf $r 'Content-Type') -eq 'text/html; charset=utf-8')
  $r = Http "$B/nope.txt"
  Check '未知带扩展名 → 404' ($r.code -eq 404)
  $r = Http "$B/" @('-I')
  Check 'HEAD / 正常' ($r.code -eq 200)

  Section '方法限制'
  foreach ($m in @('PUT', 'DELETE', 'PATCH')) {
    $r = Http "$B/api/config" @('-X', $m)
    Check "$m /api/config → 405" ($r.code -eq 405)
  }
  $r = Http "$B/api/state" @('-X', 'PUT')
  Check 'PUT /api/state → 405' ($r.code -eq 405)
  $r = Http "$B/api/notes?doc=x" @('-X', 'DELETE')
  Check 'DELETE /api/notes → 405' ($r.code -eq 405)
  $r = Http "$B/api/chat"
  Check 'GET /api/chat → 405' ($r.code -eq 405)
  $r = Http "$B/style.css" @('-X', 'POST')
  Check 'POST 静态资源 → 405' ($r.code -eq 405)

  Section '设置'
  $r = Http "$B/api/config"
  $c = $r.body | ConvertFrom-Json
  Check 'GET /api/config 200' ($r.code -eq 200)
  Check 'apiKey 不回传（空串）' ($c.apiKey -eq '')
  Check '含 hasApiKey 布尔' ($c.hasApiKey -is [bool])
  Check '默认 baseURL 正确' ($c.baseURL -eq 'https://api.deepseek.com/v1')
  Check '默认 model' ($c.model -eq 'deepseek-flash')
  Check '默认流式/温度/语言' ($c.stream -eq $true -and $c.temperature -eq 0.2 -and $c.targetLang -eq '中文')
  Check '默认 theme/fontSize/visionModel/glossary' ($c.theme -eq 'light' -and $c.fontSize -eq 15 -and $c.visionModel -eq '' -and $c.glossary -eq '')
  Check '含 idleMs=60000' ($c.idleMs -eq 60000) "idleMs=$($c.idleMs)"

  $key = 'sk-accept-' + (Get-Random)
  $r = PostJson "$B/api/config" "{`"apiKey`":`"$key`",`"model`":`"accept-model`"}"
  Check 'POST /api/config → ok' ($r.body -match '"ok":true' -and $r.body -match '"hasApiKey":true') $r.body
  $c = GetJson "$B/api/config"
  Check '写进去的 model 生效' ($c.model -eq 'accept-model')
  Check 'hasApiKey=true' ($c.hasApiKey -eq $true)
  Check 'apiKey 仍然不回传' ($c.apiKey -eq '')
  $disk = Get-Content (Join-Path $dataDir 'config.json') -Raw -Encoding UTF8
  Check '磁盘上确实存了 key' ($disk -match [regex]::Escape($key))
  $null = PostJson "$B/api/config" '{"apiKey":"","theme":"dark"}'
  $disk = Get-Content (Join-Path $dataDir 'config.json') -Raw -Encoding UTF8
  Check 'apiKey 传空 → 保留原 key' ($disk -match [regex]::Escape($key))
  Check '同一请求里的其它字段仍然写入' ($disk -match '"theme": "dark"')
  $r = PostJson "$B/api/config" 'not-json'
  Check 'body 不是 JSON → 报错但不崩' ($r.code -ge 400)

  Section '进度'
  $null = PostJson "$B/api/state" '{"page":7,"lastDoc":"sample"}'
  $s = GetJson "$B/api/state"
  Check 'POST→GET 浅合并' ($s.page -eq 7 -and $s.lastDoc -eq 'sample')
  $null = PostJson "$B/api/state" '{"page":9}'
  $s = GetJson "$B/api/state"
  Check '第二次合并保留其它字段' ($s.page -eq 9 -and $s.lastDoc -eq 'sample')

  Section '笔记'
  $doc = 'sample-52e4341f'
  $null = PostJson "$B/api/notes?doc=$doc" '{"items":[{"id":"h1","rects":[{"x":0.17599239864864866}]}]}'
  $n = GetJson "$B/api/notes?doc=$doc"
  Check 'POST→GET 取回 items' ($n.items.Count -eq 1 -and $n.items[0].id -eq 'h1')
  Check '浮点零漂移' ("$($n.items[0].rects[0].x)" -eq '0.17599239864864866') "$($n.items[0].rects[0].x)"
  $null = PostJson "$B/api/notes?doc=wrongtype" '{"items":"oops"}'
  $n = GetJson "$B/api/notes?doc=wrongtype"
  Check 'items 不是数组 → 写 []' ($n.items.Count -eq 0)
  $null = PostJson "$B/api/notes?doc=../../evil" '{"items":[1]}'
  $outside = Test-Path (Join-Path (Split-Path -Parent $dataDir) 'evil.json')
  $inData = @(Get-ChildItem $dataDir -Filter 'notes-*.json' | Where-Object { $_.Name -like 'notes-_-*' })
  Check 'doc=../../evil 被清洗成 data 内文件' ((-not $outside) -and $inData.Count -ge 1) ($inData.Name -join ',')
  $n = GetJson "$B/api/notes?doc=../../evil"
  Check '清洗后的 doc 还能读回' ($n.items.Count -eq 1)
  $n = GetJson "$B/api/notes"
  Check '缺 doc 参数 → default' ($null -ne $n.items)

  Section 'AI 转发'
  if (-not (Get-NetTCPConnection -LocalPort $MockPort -State Listen -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath (Get-Command node).Source -WindowStyle Hidden `
      -ArgumentList @("`"$(Join-Path $here 'mock-openai.js')`"", "$MockPort") | Out-Null
    Start-Sleep -Seconds 2
  }
  $base = "http://127.0.0.1:$MockPort/v1"
  $chatBase = "{`"messages`":[{`"role`":`"user`",`"content`":`"hi`"}],`"baseURL`":`"$base`",`"apiKey`":`"sk-accept`"}"

  $r = PostJson "$B/api/chat" ($chatBase -replace '^\{', '{"model":"mock-model","stream":false,')
  Check '非流式：原样回 JSON' ($r.code -eq 200 -and (HeaderOf $r 'Content-Type') -like 'application/json*' -and $r.body -match '非流式回包') "code=$($r.code)"

  $r = PostJson "$B/api/chat" ($chatBase -replace '^\{', '{"model":"boom",')
  Check '上游 401 → 同状态码' ($r.code -eq 401) "code=$($r.code)"
  Check '  取到上游 error.message' ($r.body -match 'Invalid API key') $r.body

  $r = PostJson "$B/api/chat" '{"messages":[{"role":"user","content":"hi"}],"baseURL":"http://127.0.0.1:9/v1"}'
  Check '连不上上游 → 502' ($r.code -eq 502) "code=$($r.code)"
  Check '  提示语与 server.js 一致' ($r.body -match '请检查 API 地址 / 网络 / 代理') $r.body

  $r = PostJson "$B/api/chat" '{"messages":[]}'
  Check 'messages 为空 → 400' ($r.code -eq 400 -and $r.body -match 'messages 不能为空')
  $r = PostJson "$B/api/chat" '{"messages":[{"role":"user","content":"x"}],"baseURL":"ftp://x"}'
  Check 'baseURL 非 http(s) → 400' ($r.code -eq 400 -and $r.body -match 'http:// 或 https://')
  $r = PostJson "$B/api/chat" 'not-json'
  Check 'body 不是 JSON → 400 且不崩' ($r.code -eq 400)

  Write-Host ''
  & node (Join-Path $here 'check-stream.js') "$Port" "$MockPort" | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
  Check '流式：client 分多次收到 chunk' ($LASTEXITCODE -eq 0)

  $null = PostJson "$B/api/config" '{"idleMs":1500}'
  $js = "const t0=Date.now();(async()=>{const r=await fetch('$B/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'hi'}],model:'stall',baseURL:'$base',apiKey:'sk-accept'})});const rd=r.body.getReader();const d=new TextDecoder();let s='';while(true){const x=await rd.read();if(x.done)break;s+=d.decode(x.value)}console.log((Date.now()-t0)+'|'+s.includes('没有返回数据'))})()"
  $idle = & node -e $js
  $parts = "$idle" -split '\|'
  Check '空闲超时：写出 SSE error 并收尾' ($parts.Count -ge 2 -and $parts[1] -eq 'True' -and [int]$parts[0] -lt 6000) ("用时 " + $parts[0] + "ms")

  Section '并发'
  $jobs = 1..24 | ForEach-Object {
    Start-Job -ScriptBlock { param($u) curl.exe -s -o NUL -w '%{http_code}' $u } -ArgumentList @("$B/api/pdf?name=sample.pdf")
  }
  $codes = $jobs | Wait-Job | Receive-Job
  $jobs | Remove-Job -Force
  Check '24 个并发 Range 请求全部 200' (@($codes | Where-Object { $_ -ne '200' }).Count -eq 0) ($codes -join ',')

  $jobs = 1..6 | ForEach-Object {
    Start-Job -ScriptBlock { param($u) curl.exe -s -o NUL -w '%{http_code}' $u } -ArgumentList @("$B/api/health")
  }
  $codes = $jobs | Wait-Job | Receive-Job
  $jobs | Remove-Job -Force
  Check '6 个并发 /api/health 全部 200' (@($codes | Where-Object { $_ -ne '200' }).Count -eq 0)

  Write-Output ''
  Write-Output '--- 进程还活着吗（没有任何请求能把服务打挂）---'
  $alive = if ($started) { $null -ne (Get-Process -Id $started.Id -ErrorAction SilentlyContinue) } else { $true }
  Check '服务进程仍然存活' $alive
}
finally {
  if ($started) {
    $started.Refresh()
    if (-not $started.HasExited) { $null = $started.CloseMainWindow(); Start-Sleep -Seconds 2 }
    $started.Refresh()
    if (-not $started.HasExited) { Stop-Process -Id $started.Id -Force }
    Write-Host "`n被测实例已关闭" -ForegroundColor DarkGray
  }
  Write-Host ''
  Write-Host ("  通过 {0} / 失败 {1}" -f $script:pass, $script:fail) -ForegroundColor $(if ($script:fail -eq 0) { 'Green' } else { 'Red' })
  exit $(if ($script:fail -eq 0) { 0 } else { 1 })
}
