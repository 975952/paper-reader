import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const PORT = Number(process.env.NODE_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH = path.join(import.meta.dirname, 'artifacts', 'node-scratch');
const PAPERS = path.join(SCRATCH, 'papers');
const DATA = path.join(SCRATCH, 'data');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  [OK]' : '  [XX]'} ${name}${detail ? `  -- ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 干净的临时环境：没有任何配置 = 没有任何 API Key ── */
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(PAPERS, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });

const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    NO_OPEN: '1',
    PRT_PAPERS_DIR: PAPERS,
    PRT_DATA_DIR: DATA,
  },
  stdio: 'ignore',
  detached: true,
});
child.unref();
// 只收拾自己拉起来的那个进程：按 PID 杀，绝不能按镜像名（脚本自己也是 node）
const killChild = () => {
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已经退了 */ }
};
process.on('exit', killChild);

let up = false;
for (let i = 0; i < 30 && !up; i++) {
  await sleep(400);
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(600) });
    if (r.ok && (await r.json()).ok) up = true;
  } catch { /* 还没起来 */ }
}
check('node server.js 起来了', up, up ? BASE : '12 秒内没起来');

if (!up) {
  killChild();
  console.log(`\n结果：0/${results.length} 通过`);
  process.exit(1);
}

/* ── 隔离性：确认它读的确实是临时目录 ── */
const papersResp = await fetch(`${BASE}/api/papers`).then((r) => r.json());
check('服务端用的是临时目录（没碰用户数据）',
  path.resolve(papersResp.dir) === path.resolve(PAPERS), papersResp.dir);

/* ── 前提：此刻确实没有 Key ── */
const cfgNow = await fetch(`${BASE}/api/config`).then((r) => r.json());
check('前提：当前配置里没有 API Key', cfgNow.hasApiKey === false && cfgNow.apiKey === '',
  `hasApiKey=${cfgNow.hasApiKey} baseURL=${cfgNow.baseURL}`);

/* ── 联网搜索：不需要 Key 也能用 ── */
try {
  const q = encodeURIComponent('Transformer architecture attention');
  const r = await fetch(`${BASE}/api/web-search?q=${q}&n=6`, { signal: AbortSignal.timeout(60000) });
  const j = await r.json();
  check('无 API Key 时联网搜索照样可用', r.status === 200 && (j.results || []).length >= 2,
    `${j.provider || '(无引擎)'} ${j.results?.length || 0} 条`);
  check('结果都带标题和 http 直链',
    (j.results || []).every((x) => x.title && /^https?:\/\//.test(x.url)), j.results?.[0]?.url);
  check('结果带摘要', (j.results || []).some((x) => (x.snippet || '').length > 20));

  /* ── 相关性兜底（和 Rust 端同一套规则） ── */
  const junkQ = '这篇论文的核心贡献是什么？另外帮我查一下 Transformer 架构最近有什么重要进展。';
  const junk = await fetch(`${BASE}/api/web-search?q=${encodeURIComponent(junkQ)}&n=6`,
    { signal: AbortSignal.timeout(60000) }).then((x) => x.json());
  const toks = new Set();
  for (const w of junkQ.toLowerCase().match(/[a-z][a-z0-9+#._-]*/g) || []) if (w.length >= 2) toks.add(w);
  for (const run of junkQ.toLowerCase().replace(/[^\u4e00-\u9fa5]+/g, ' ').split(/\s+/)) {
    for (let i = 0; i + 2 <= run.length; i++) toks.add(run.slice(i, i + 2));
  }
  const unrelated = (junk.results || []).filter((x) => {
    const hay = `${x.title} ${x.snippet || ''}`.toLowerCase();
    return ![...toks].some((t) => hay.includes(t));
  });
  check('整句口水问句不会拿回一堆不相关的结果',
    (junk.results || []).length === 0 || unrelated.length === 0,
    `${junk.results?.length || 0} 条，不相关 ${unrelated.length} 条 · ${unrelated[0]?.title || ''}`);
  check('丢弃时给出人话解释', !junk.error || /丢|对不上|换/.test(junk.error), junk.error || '(没丢)');

  const kw = await fetch(`${BASE}/api/web-search?q=${encodeURIComponent('Transformer 架构 进展')}&n=6`,
    { signal: AbortSignal.timeout(60000) }).then((x) => x.json());
  check('关键词查询照常返回结果（兜底没把正常结果滤掉）',
    (kw.results || []).length >= 2, `${kw.provider} ${kw.results?.length} 条`);
  check('关键词查询的结果确实提到 Transformer',
    (kw.results || []).every((x) => /transformer/i.test(`${x.title} ${x.snippet || ''}`)),
    (kw.results || []).map((x) => x.title).find((t) => !/transformer/i.test(t)) || '全部命中');

  const noq = await fetch(`${BASE}/api/web-search?q=`);
  check('缺少 q 返回 400', noq.status === 400, `${noq.status}`);

  const cached = await fetch(`${BASE}/api/web-search?q=${encodeURIComponent('Transformer 架构 进展')}&n=6`,
    { signal: AbortSignal.timeout(20000) }).then((x) => x.json());
  check('同一查询走缓存（结果一致）',
    cached.results?.length === kw.results?.length, `${cached.results?.length} 条`);
} catch (e) {
  check('无 Key 联网搜索（联网）', false, String(e.message).slice(0, 100));
}

/* ── 对照组：没有 Key 时聊天接口会如实把上游的拒绝透传出来，而不是假装成功 ──
   这里不去拦它：baseURL 指向 localhost 时（Ollama 之类）本来就允许不带 Key，
   真正的「先填 Key」提示由前端的 ensureReady() 负责。 */
try {
  const r = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(30000),
  });
  const txt = await r.text();
  check('没 Key 时 /api/chat 如实报错而不是假装成功', r.status >= 400 && txt.length > 0,
    `${r.status} ${txt.slice(0, 70)}`);
} catch (e) {
  check('没 Key 时 /api/chat 如实报错而不是假装成功', false, String(e.message).slice(0, 80));
}

/* ── 联网导入 PDF：也在临时目录里做，不碰用户书架 ── */
const enc = encodeURIComponent;
console.log('\n-- 联网导入（Node 端）');
for (const [label, q] of [
  ['缺少 url', ''],
  ['非 http 协议', `?url=${enc('javascript:alert(1)')}`],
  ['内网地址（SSRF）', `?url=${enc(`http://127.0.0.1:${PORT}/api/health`)}`],
]) {
  const r = await fetch(`${BASE}/api/import-pdf${q}`);
  check(`导入接口：${label} 被拒绝`, r.status === 400, `${r.status}`);
}
{
  const r = await fetch(`${BASE}/api/import-pdf?url=${enc('https://arxiv.org/abs/1706.03762')}`,
    { signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  check('导入接口：网页链接会被识破', r.status === 400 && /PDF/i.test(j?.error?.message || ''),
    `${r.status} ${j?.error?.message || ''}`);
}
try {
  const r = await fetch(`${BASE}/api/import-pdf?url=${enc('https://arxiv.org/pdf/1706.03762v7')}&name=${enc('node-import.pdf')}`,
    { signal: AbortSignal.timeout(120000) });
  const j = await r.json().catch(() => ({}));
  check('导入接口：能真的下载并落到临时 papers/', r.status === 200 && j.ok === true,
    `${r.status} ${j.name || j?.error?.message || ''}`);
  if (j.ok) {
    const abs = path.join(PAPERS, j.name);
    check('导入的文件确实存在且是 PDF',
      fs.existsSync(abs) && fs.readFileSync(abs).subarray(0, 5).toString() === '%PDF-',
      `${Math.round(fs.statSync(abs).size / 1024)}KB`);
    const list = await fetch(`${BASE}/api/papers`).then((x) => x.json());
    check('导入后出现在 /api/papers 列表里', list.papers.some((p) => p.name === j.name), `${list.papers.length} 篇`);
  }
} catch (e) {
  check('导入接口：能真的下载（联网）', false, String(e.message).slice(0, 90));
}

const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
check('全程服务没有崩（健康检查仍正常）', health.ok === true, JSON.stringify(health));

/* ── 收摊 ── */
killChild();
await sleep(400);
fs.rmSync(SCRATCH, { recursive: true, force: true });
check('临时目录已清理', !fs.existsSync(SCRATCH));

const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
