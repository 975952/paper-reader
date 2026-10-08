/**
 * 桌面版（exe）验收：启动 exe → 找到端口 → 验证 HTTP 接口 → 打印端口给 e2e 用
 *   node test/desktop.mjs
 * 之后可以： BASE=http://127.0.0.1:<port> node e2e.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
// 默认验收交付物本身（根目录的 exe）。exe 的 papers/ 与 data/ 是相对自己所在目录解析的，
// 所以必须启根目录这个，启 target/release 里那个会去找 target/release/papers。
const EXE = process.env.EXE || path.join(ROOT, '论文阅读器.exe');
const RANGE = Array.from({ length: 20 }, (_, i) => 8787 + i);
const SANDBOX = path.join(import.meta.dirname, 'artifacts', 'desktop-isolated');
const DATA = path.join(SANDBOX, 'data');
const PAPERS = path.join(SANDBOX, 'papers');

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '  ✅' : '  ❌'} ${n}${d ? `  — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 先关掉已在跑的实例 ──
   注意：交付的 exe 文件名是中文，进程名也就是「论文阅读器」，
   所以 `taskkill /IM paper-reader.exe` 根本打不中 —— 那样会拿着上一轮的旧进程跑测试，
   而前端是内嵌进 exe 的，改了 public/ 却测了旧二进制 = 白测。
   这里改成按 exe 路径杀，并且杀完确认真的没了。 */
function killRunning() {
  const noop = { stdio: 'ignore' };
  try {
    execFileSync('taskkill', ['/IM', 'paper-reader.exe', '/F'], noop);
  } catch { /* 名字不对 / 没在跑 */ }
  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-Process | Where-Object { try { $_.Path -eq $env:PRT_EXE } catch { $false } } | Stop-Process -Force -ErrorAction SilentlyContinue",
    ], { ...noop, env: { ...process.env, PRT_EXE: EXE } });
  } catch { /* 尽力而为 */ }
}
const aliveCount = () => {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command',
      "(Get-Process | Where-Object { try { $_.Path -eq $env:PRT_EXE } catch { $false } } | Measure-Object).Count",
    ], { encoding: 'utf8', env: { ...process.env, PRT_EXE: EXE } }).trim();
  } catch { return '0'; }
};

killRunning();
for (let i = 0; i < 20 && aliveCount() !== '0'; i++) await sleep(300);
const stillAlive = aliveCount() !== '0';
if (!stillAlive) {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(PAPERS, { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'cn-sample.pdf'), path.join(PAPERS, 'fixture-cn-sample.pdf'));
  fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), path.join(PAPERS, 'fixture-multipage.pdf'));
}

if (!fs.existsSync(EXE)) {
  console.error(`找不到 exe：${EXE}\n先跑 desktop/build.bat`);
  process.exit(2);
}

/* ── 陈旧的构建产物检查 ──
   前端（public/）是 rust-embed 编译期嵌进 exe 的，改了 public/ 不重新 build，
   跑出来的「通过」全是假的。这里直接把 mtime 摆出来。 */
{
  let newest = 0;
  let newestFile = '';
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const m = fs.statSync(p).mtimeMs;
      if (m > newest) { newest = m; newestFile = p; }
    }
  };
  walk(path.join(ROOT, 'public'));
  const exeM = fs.statSync(EXE).mtimeMs;
  check('exe 不旧于 public/（前端已重新内嵌）', exeM >= newest - 1000,
    `exe=${new Date(exeM).toLocaleTimeString()} 最新前端=${path.relative(ROOT, newestFile)}@${new Date(newest).toLocaleTimeString()}`);
}

check('没有残留的旧实例（否则测的是旧二进制）', !stillAlive, stillAlive ? '还有进程没杀掉' : '');

console.log(`启动：${EXE}`);
/**
 * ⚠️ `PRT_REQUIRE_TOKEN: '0'` 是**必须**的（2026-10 安全加固后）：
 * exe 现在和 Node 版一样，对所有 `/api/*` 要求自定义头 `X-PRT-Token`（只豁免 `/api/health`）。
 * 本套件在 Node 侧直接 fetch `/api/papers`、`/api/state` 等，**发不出自定义头**，
 * 不关校验就会一路 401 → `papers.papers` 是 undefined → 在 `papers.papers[0].name` 处崩。
 *
 * 这是审计允许的「测试显式注入」：只对本进程 spawn 的隔离实例生效，不是产品后门。
 * 令牌校验本身另有一条独立验证（见验收报告：不带令牌的 `/api/papers` 必须 401）。
 */
const child = spawn(EXE, [], { detached: true, stdio: 'ignore', env: { ...process.env, PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1' } });
child.unref();

/* ── 找端口 ── */
let base = null;
for (let attempt = 0; attempt < 40 && !base; attempt++) {
  await sleep(400);
  for (const p of RANGE) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(500) });
      if (r.ok) {
        const j = await r.json();
        if (!j?.ok) continue;
        // Another reader may already be open on an earlier port. Only use this test's
        // token-disabled instance and fixture, never the user's live data service.
        const papersProbe = await fetch(`http://127.0.0.1:${p}/api/papers`, { signal: AbortSignal.timeout(500) });
        if (!papersProbe.ok) continue;
        const listing = await papersProbe.json();
        if ((listing.papers || []).some((paper) => paper.name === 'fixture-multipage.pdf')) {
          base = `http://127.0.0.1:${p}`;
          break;
        }
      }
    } catch { /* 还没起来 */ }
  }
}
check('exe 启动并开了本地服务', !!base, base || '16 秒内没起来');
if (!base) { process.exit(1); }

/* ── 进程与窗口 ── */
try {
  // 按窗口标题找，不依赖进程名（交付的 exe 叫「论文阅读器.exe」）
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    "Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress"],
  { encoding: 'utf8' }).trim();
  const all = JSON.parse(out);
  const list = Array.isArray(all) ? all : [all];
  // Chrome 可能同时显示「论文阅读器 - Google Chrome」；只认桌面版自己的精确标题。
  const info = list.find((x) => x.Id === child.pid) || {};
  check('是原生窗口（有窗口句柄与标题）', info.MainWindowTitle === '论文阅读器', `pid=${info.Id} ${info.ProcessName} title="${info.MainWindowTitle}"`);
} catch (e) {
  check('是原生窗口（有窗口句柄与标题）', false, String(e.message).slice(0, 60));
}

/* ── 接口 ── */
console.log('\n▶ HTTP 接口…');
const health = await fetch(`${base}/api/health`).then((r) => r.json());
check('/api/health', health.ok === true && health.port > 0, JSON.stringify(health));

const papers = await fetch(`${base}/api/papers`).then((r) => r.json());
check('/api/papers 列出了 PDF', Array.isArray(papers.papers) && papers.papers.length > 0,
  `${papers.papers?.length} 篇，dir=${papers.dir}`);
check('论文有 url 和 docId', !!papers.papers?.[0]?.url && !!papers.papers?.[0]?.docId, papers.papers?.[0]?.name);

const name = papers.papers[0].name;
const full = await fetch(`${base}/api/pdf?name=${encodeURIComponent(name)}`);
check('/api/pdf 完整读取', full.status === 200 && Number(full.headers.get('content-length')) > 1000,
  `${full.status} ${full.headers.get('content-length')}B`);
check('/api/pdf 带 Accept-Ranges', full.headers.get('accept-ranges') === 'bytes');
await full.arrayBuffer();

const ranged = await fetch(`${base}/api/pdf?name=${encodeURIComponent(name)}`, { headers: { Range: 'bytes=100-199' } });
check('/api/pdf Range 返回 206', ranged.status === 206 && Number(ranged.headers.get('content-length')) === 100,
  `${ranged.status} ${ranged.headers.get('content-range')}`);
await ranged.arrayBuffer();

const suffix = await fetch(`${base}/api/pdf?name=${encodeURIComponent(name)}`, { headers: { Range: 'bytes=-50' } });
check('/api/pdf 后缀 Range', suffix.status === 206, `${suffix.status}`);
await suffix.arrayBuffer();

const bad = await fetch(`${base}/api/pdf?name=${encodeURIComponent(name)}`, { headers: { Range: 'bytes=99999999-' } });
check('/api/pdf 越界 Range 返回 416', bad.status === 416, `${bad.status}`);

const cfg = await fetch(`${base}/api/config`).then((r) => r.json());
check('/api/config 不回传密钥', cfg.apiKey === '' && typeof cfg.hasApiKey === 'boolean', `hasApiKey=${cfg.hasApiKey}`);
check('/api/config 有默认值', !!cfg.baseURL && !!cfg.model, `${cfg.baseURL} / ${cfg.model}`);

const saved = await fetch(`${base}/api/config`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ targetLang: '中文', glossary: 'attention=注意力', apiKey: 'fake-desktop-test-key' }),
}).then((r) => r.json());
const cfg2 = await fetch(`${base}/api/config`).then((r) => r.json());
check('/api/config 写入中文正常（UTF-8）', cfg2.targetLang === '中文' && cfg2.glossary === 'attention=注意力',
  `${cfg2.targetLang} / ${cfg2.glossary}`);
check('/api/config 仅用假密钥且不回传', saved.hasApiKey === true && cfg2.apiKey === '' && cfg2.hasApiKey === true);

// 故意让目标文件名变成目录，验证原子写入失败会返回 HTTP 错误。
const failWrite = async (filename, endpoint, body) => {
  const target = path.join(DATA, filename);
  const backup = `${target}.test-backup`;
  if (fs.existsSync(target) && fs.statSync(target).isFile()) fs.renameSync(target, backup);
  fs.mkdirSync(target, { recursive: true });
  const r = await fetch(`${base}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  fs.rmSync(target, { recursive: true, force: true });
  if (fs.existsSync(backup)) fs.renameSync(backup, target);
  return r.status;
};
check('/api/config 写盘失败返回错误', await failWrite('config.json', '/api/config', { glossary: 'pending' }) >= 500);
check('/api/state 写盘失败返回错误', await failWrite('state.json', '/api/state', { probe: 2 }) >= 500);
const noteDoc = 'desktop-write-failure';
let h = 5381; for (const c of noteDoc) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
const noteSlug = noteDoc.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 48);
const noteFile = `notes-${noteSlug}-${h.toString(16)}.json`;
check('/api/notes 写盘失败返回错误', await failWrite(noteFile, `/api/notes?doc=${noteDoc}`, { items: [{ id: 'kept' }] }) >= 500);
const sessionStatus = await fetch(`${base}/api/session?doc=${noteDoc}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries: [{ text: 'restored' }] }) });
const session = await fetch(`${base}/api/session?doc=${noteDoc}`).then((r) => r.json());
check('/api/session 写入并读回', sessionStatus.ok && session.entries?.[0]?.text === 'restored');

await fetch(`${base}/api/notes?doc=desktop-check`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ items: [{ id: 'x', page: 1 }] }),
});
const notes = await fetch(`${base}/api/notes?doc=desktop-check`).then((r) => r.json());
check('/api/notes 写入并读回', Array.isArray(notes.items) && notes.items.length === 1, JSON.stringify(notes));
await fetch(`${base}/api/notes?doc=desktop-check`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [] }),
});

await fetch(`${base}/api/state`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ probe: 1 }),
});
const st = await fetch(`${base}/api/state`).then((r) => r.json());
check('/api/state 读写', st.probe === 1, JSON.stringify(st).slice(0, 60));

console.log('\n▶ 静态资源与安全…');
const index = await fetch(`${base}/`);
const html = await index.text();
check('/ 返回前端页面', index.status === 200 && html.includes('论文阅读器'), `${index.status} ${html.length}B`);
check('首页 MIME 正确', (index.headers.get('content-type') || '').includes('text/html'), index.headers.get('content-type'));

const appjs = await fetch(`${base}/js/app.js`);
check('/js/app.js MIME 必须是 text/javascript', (appjs.headers.get('content-type') || '').includes('javascript'),
  `${appjs.status} ${appjs.headers.get('content-type')}`);
const embeddedApp = await appjs.text();
check('exe 内嵌了会话恢复和已完成段落增量渲染代码', embeddedApp.includes('/api/session?doc=') && embeddedApp.includes('completedMarkdownEnd(pending, scan)'));
check('搜索结果只嵌入链接入口（没有直接导入按钮）', embeddedApp.includes('打开链接') && !embeddedApp.includes('importPdf('));
const aiJs = await fetch(`${base}/js/ai.js`).then((r) => r.text());
check('exe 内嵌了地区限制与密钥错误的区分提示', aiJs.includes('该模型在你所在地区不可用') && aiJs.includes('API Key 无效或已失效'));
const worker = await fetch(`${base}/vendor/pdf.worker.min.mjs`);
check('内嵌了 pdf.js worker', worker.status === 200 && (await worker.arrayBuffer()).byteLength > 100000,
  `${worker.status}`);

for (const [label, url] of [
  ['/../ 穿越', `${base}/%2e%2e/secret`],
  ['/../ 带扩展名穿越', `${base}/%2e%2e/server.js`],
  ['api/pdf 穿越', `${base}/api/pdf?name=${encodeURIComponent('../server.js')}`],
  ['api/pdf 绝对路径', `${base}/api/pdf?name=${encodeURIComponent('C:\\Windows\\win.ini')}`],
  ['js/ 多级回退穿越', `${base}/js/%2e%2e/%2e%2e/README.md`],
]) {
  const r = await fetch(url);
  const body = await r.text();
  // 允许 400/404，也允许无扩展名路径回落成首页外壳；但绝不允许泄露 public 之外的文件内容
  const leaked = /PAPERS_DIR|createServer|fn main|use wry|std::net/.test(body);
  const okFallback = r.status === 200 && body.includes('论文阅读器');
  check(`${label} 被挡住或只是回落首页`, !leaked && (r.status === 400 || r.status === 404 || okFallback),
    `${r.status} ${body.length}B${leaked ? ' ← 泄露!' : ''}`);
}

const txt = await fetch(`${base}/api/pdf?name=${encodeURIComponent('../server.js')}`).then((r) => r.text());
check('穿越没有泄露源码', !/PAPERS_DIR|createServer/.test(txt), txt.slice(0, 40));

/* ── 应用图标：极简「P」 ── */
const icon = await fetch(`${base}/icon.svg`);
const iconBody = await icon.text();
check('图标 /icon.svg 能取到且是 SVG',
  icon.status === 200 && (icon.headers.get('content-type') || '').includes('svg'),
  `${icon.status} ${icon.headers.get('content-type')} ${iconBody.length}B`);
check('图标是透明底的纯图形（无背景矩形、无文字）',
  !/<text/.test(iconBody) && !/width="100"[^>]*height="100"/.test(iconBody) && /viewBox="0 0 100 100"/.test(iconBody),
  iconBody.split('\n').filter((l) => l.includes('<rect')).join('').trim().slice(0, 60));

/* ── 参考文献检索（需要联网，走真实公开接口） ── */
console.log('\n▶ 参考文献检索…');
try {
  const q = encodeURIComponent('Ashish Vaswani, Noam Shazeer, Niki Parmar. Attention is all you need. NeurIPS 2017.');
  const r = await fetch(`${base}/api/ref-search?q=${q}`, { signal: AbortSignal.timeout(60000) });
  const j = await r.json();
  check('猜出了正确的标题', /attention is all you need/i.test(j.title || ''), j.title);
  check('返回了检索结果', Array.isArray(j.results) && j.results.length > 0, `${j.results?.length} 条`);
  const withPdf = (j.results || []).filter((x) => x.pdfUrl);
  check('结果里有可直接打开的 PDF 链接', withPdf.length > 0, withPdf[0]?.pdfUrl || '(无)');
  check('给了搜索引擎兜底链接', /^https?:/.test(j.searchUrl || '') && /^https?:/.test(j.scholarUrl || ''));
} catch (e) {
  check('参考文献检索可用（联网）', false, String(e.message).slice(0, 80));
}

/* ── 联网搜索（真实公开页面，不需要密钥） ── */
console.log('\n▶ 联网搜索…');
try {
  const sq = encodeURIComponent('attention is all you need transformer arxiv');
  const r = await fetch(`${base}/api/web-search?q=${sq}&n=6`, { signal: AbortSignal.timeout(60000) });
  const j = await r.json();
  check('联网搜索返回结果', Array.isArray(j.results) && j.results.length >= 2,
    `${j.provider || '(无引擎)'} ${j.results?.length || 0} 条`);
  check('结果都有标题和直链', (j.results || []).every((x) => x.title && /^https?:\/\//.test(x.url)),
    j.results?.[0]?.url);
  check('结果带摘要', (j.results || []).some((x) => (x.snippet || '').length > 20));
  check('标题里没有残留 HTML 标签或实体',
    !(j.results || []).some((x) => /[<>]|&(amp|lt|gt|quot|nbsp|#\d+);/.test(x.title)),
    (j.results || []).map((x) => x.title).find((t) => /[<>]|&/.test(t)) || '干净');

  const t0 = Date.now();
  const cached = await fetch(`${base}/api/web-search?q=${sq}&n=6`).then((x) => x.json());
  const ms = Date.now() - t0;
  check('同一查询第二次走缓存', ms < 300 && cached.results.length === j.results.length, `${ms}ms`);

  const cn = await fetch(`${base}/api/web-search?q=${encodeURIComponent('注意力机制 论文')}&n=6`,
    { signal: AbortSignal.timeout(60000) }).then((x) => x.json());
  check('中文查询也能搜到', (cn.results || []).length >= 2, `${cn.provider} ${cn.results?.length} 条`);

  const noq = await fetch(`${base}/api/web-search?q=`);
  check('缺少 q 返回 400', noq.status === 400, `${noq.status}`);

  // 相关性兜底：真事故是把整句中文问句丢给 Bing，它会退化成单字查询，
  // 返回一堆「这」字的字典释义。这种结果宁可丢掉，也不能当来源列给用户。
  const junkQ = '这篇论文的核心贡献是什么？另外帮我查一下 Transformer 架构最近有什么重要进展。';
  const junk = await fetch(`${base}/api/web-search?q=${encodeURIComponent(junkQ)}&n=6`,
    { signal: AbortSignal.timeout(60000) }).then((x) => x.json());
  const toks = new Set();
  for (const w of junkQ.toLowerCase().match(/[a-z][a-z0-9+#._-]*/g) || []) if (w.length >= 2) toks.add(w);
  for (const run of junkQ.toLowerCase().replace(/[^\u4e00-\u9fa5]+/g, ' ').split(/\s+/)) {
    for (let i = 0; i + 2 <= run.length; i++) toks.add(run.slice(i, i + 2));
  }
  const unrelated = (junk.results || []).filter((r) => {
    const hay = `${r.title} ${r.snippet || ''}`.toLowerCase();
    return ![...toks].some((t) => hay.includes(t));
  });
  check('整句口水问句不会拿回一堆不相关的结果',
    (junk.results || []).length === 0 || unrelated.length === 0,
    `${junk.results?.length || 0} 条，其中不相关 ${unrelated.length} 条 · ${unrelated[0]?.title || ''}`);
  check('丢弃时给出了人话解释', !junk.error || /丢|对不上|换/.test(junk.error), junk.error || '(没丢)');

  // 关键词查询要仍然好使（别为了过滤把正常结果也滤掉了）
  const kw = await fetch(`${base}/api/web-search?q=${encodeURIComponent('Transformer 架构 进展')}&n=6`,
    { signal: AbortSignal.timeout(60000) }).then((x) => x.json());
  check('关键词查询照常返回结果', (kw.results || []).length >= 2, `${kw.provider} ${kw.results?.length} 条`);
  check('关键词查询的结果确实提到 Transformer',
    (kw.results || []).every((r) => /transformer/i.test(`${r.title} ${r.snippet || ''}`)),
    (kw.results || []).map((r) => r.title).find((t) => !/transformer/i.test(t)) || '全部命中');
} catch (e) {
  check('联网搜索可用（联网）', false, String(e.message).slice(0, 80));
}

fs.writeFileSync(path.join(import.meta.dirname, '.desktop-port'), base);
console.log(`\n端口已写入 test/.desktop-port → ${base}`);
console.log(`可以接着跑： BASE=${base} node e2e.mjs`);

const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
