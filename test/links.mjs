/**
 * 外链点击验收：论文查找 / 联网来源 里的网页链接必须真的能点开。
 *
 *   BASE=http://127.0.0.1:8787 node test/links.mjs
 *
 * 背景（用户反馈的原话是「现在的论文查找，网页链接不能直接点」）：
 * 桌面版是 WebView2 外壳，页面里的 `<a target="_blank">` 默认什么都不会发生；
 * 而不加 target 直接跳又会把应用界面顶掉换成外站。所以所有 http(s) 链接统一
 * 拦下来，交给后端 /api/open-url 用系统浏览器打开。
 *
 * 这个测试把 /api/open-url 拦下来记录调用（否则每跑一次都会在真实桌面上
 * 弹一个浏览器窗口），验证的是「点一下 → 正确地把地址交给了后端 → 应用本身没被顶走」。
 * 后端那一侧的正向能力由 test/node-search.mjs（校验规则）和真机手测覆盖。
 */
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, resolveDataDir } from './_env.mjs';
import { setScope } from './_scope.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.join(import.meta.dirname, 'artifacts');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  [OK]' : '  [XX]'} ${name}${detail ? `  -- ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const papers = await fetch(`${BASE}/api/papers`).then((r) => r.json()).catch(() => ({ papers: [] }));
const first = [...(papers.papers || [])].sort((a, b) => (b.size || 0) - (a.size || 0))[0] || {};
check('服务端有可用的 PDF', !!first.name && !!first.docId, first.name || '(无)');
assertIsolatedDataDir(resolveDataDir(papers.dir));
await fetch(`${BASE}/api/state`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lastDoc: null, lastName: null, lastUrl: null, docs: {} }),
});

/* ── 后端正反例：不触发真浏览器的那部分（非 http(s) 一律拒绝） ── */
console.log('\n-- /api/open-url 的输入校验');
for (const [label, bad] of [
  ['javascript: 伪协议', 'javascript:alert(1)'],
  ['file: 本地文件', 'file:///C:/Windows/win.ini'],
  ['data: 内联内容', 'data:text/html,<script>1</script>'],
  ['ftp: 其它协议', 'ftp://example.com/x'],
]) {
  try {
    const r = await fetch(`${BASE}/api/open-url?url=${encodeURIComponent(bad)}`);
    check(`${label} 被拒绝`, r.status === 400, `${r.status}`);
  } catch (e) {
    check(`${label} 被拒绝`, false, String(e.message).slice(0, 60));
  }
}
{
  const r = await fetch(`${BASE}/api/open-url`);
  check('缺少 url 返回 400', r.status === 400, `${r.status}`);
  const r2 = await fetch(`${BASE}/api/open-url?url=${'http://a/' + 'x'.repeat(3000)}`);
  check('超长 url 返回 400', r2.status === 400, `${r2.status}`);
}

/* ── 浏览器侧 ── */
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1500,950'],
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();

const consoleErrors = [];
const pageErrors = [];
const opened = [];          // 被拦下来的 /api/open-url 调用
const navigations = [];
const badResponses = [];

page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations.push(f.url()); });
page.on('response', (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`); });

const REF_URL = 'https://arxiv.org/abs/1706.03762';
const REF_PDF = 'https://arxiv.org/pdf/1706.03762';
const SOURCE_URL = 'https://zhuanlan.zhihu.com/p/338817680';

await page.setRequestInterception(true);
page.on('request', (req) => {
  const url = req.url();

  // 关键：拦下 /api/open-url，别在真实桌面上弹浏览器
  if (url.includes('/api/open-url')) {
    const target = decodeURIComponent(new URL(url).searchParams.get('url') || '');
    opened.push(target);
    return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, url: target }) });
  }

  if (url.includes('/api/ref-search')) {
    return req.respond({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        query: 'q', title: 'Attention Is All You Need',
        results: [
          { source: 'arXiv', title: 'Attention Is All You Need', year: '2017', venue: 'arXiv', url: REF_URL, pdfUrl: REF_PDF },
        ],
        searchUrl: 'https://www.bing.com/search?q=Attention+Is+All+You+Need+pdf',
        scholarUrl: 'https://scholar.google.com/scholar?q=Attention+Is+All+You+Need',
      }),
    });
  }

  if (url.includes('/api/web-search')) {
    const q = decodeURIComponent(new URL(url).searchParams.get('q') || '');
    return req.respond({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        query: q, provider: 'Bing',
        results: [{ title: 'Transformer 模型详解', url: SOURCE_URL, snippet: '注意力机制的图解说明。' }],
      }),
    });
  }

  if (url.endsWith('/api/chat')) {
    const chunks = ['注意力机制让模型对序列中不同位置分配不同权重 [来源1]。'].flatMap((t) => t.match(/[\s\S]{1,16}/g) || []);
    const sse = chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
    return req.respond({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: sse });
  }

  return req.continue();
});

/* ── 打开论文 ── */
await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#fileList li', { timeout: 20000 });
await page.evaluate((id) => {
  const li = [...document.querySelectorAll('#fileList li')].find((x) => x.dataset.id === id) || document.querySelector('#fileList li');
  li.click();
}, first.docId);
await page.waitForFunction(() => window.__viewer?.pdf, { timeout: 40000 });
await sleep(1200);

/* ═══════════ 一、论文查找（点正文 [n] → 找这篇的 PDF → 打开） ═══════════ */
console.log('\n-- 论文查找里的链接');
// 别假设第 1 页就有 [n]：这篇的摘要页没有引用，正文引用在后面几页；
// 而且进度会被记住，打开时可能停在半路。直接滚到第一个 [n] 所在位置再算坐标。
await page.evaluate(() => document.querySelector('.cite-link')?.scrollIntoView({ block: 'center' }));
await sleep(2000);
const citeInfo = await page.evaluate(() => {
  const v = document.getElementById('viewer');
  const vr = v.getBoundingClientRect();
  const links = [...document.querySelectorAll('.cite-link')].filter((a) => {
    const r = a.getBoundingClientRect();
    return r.width > 0 && r.top > vr.top + 10 && r.bottom < vr.bottom - 10;
  });
  const r0 = links[0]?.getBoundingClientRect();
  return { total: document.querySelectorAll('.cite-link').length, visible: links.length, pt: r0 ? { x: Math.round(r0.x + r0.width / 2), y: Math.round(r0.y + r0.height / 2) } : null };
});
check('正文里有可点的 [n] 引用', citeInfo.total > 0 && !!citeInfo.pt, `共 ${citeInfo.total} 处，可见 ${citeInfo.visible} 处`);

if (citeInfo.pt) {
  await page.mouse.click(citeInfo.pt.x, citeInfo.pt.y);
  await sleep(1500);
  const boxOpen = await page.evaluate(() => !document.getElementById('citeBox').classList.contains('hidden'));
  check('点 [n] 打开了参考文献浮层', boxOpen);

  await page.click('#citeSearch');
  await page.waitForFunction(() => document.querySelectorAll('#citeResult .cite-item').length > 0, { timeout: 15000 }).catch(() => {});
  await sleep(400);

  const before = opened.length;
  const navBefore = navigations.length;
  const firstHref = await page.evaluate(() => document.querySelector('#citeResult .ci-acts a')?.getAttribute('href') || '');
  check('查到了结果且带着链接', /^https?:/.test(firstHref), firstHref);

  // 点「打开」
  await page.evaluate(() => document.querySelector('#citeResult .ci-acts a').click());
  await sleep(700);
  check('点「打开」把地址交给了后端', opened.length === before + 1 && opened[before] === firstHref,
    `${opened[before] || '(没调用)'}`);
  check('点链接没有把应用顶走（界面还在）',
    await page.evaluate(() => !!window.__viewer?.pdf && !!document.getElementById('citeBox') && location.pathname === '/'),
    `pathname=${await page.evaluate(() => location.pathname)}`);
  check('没有发生整页跳转', navigations.length === navBefore, `${navigations.length - navBefore} 次`);

  // 底部两个搜索引擎兜底链接
  const bottoms = await page.evaluate(() => [...document.querySelectorAll('#citeResult .cite-acts a')].map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') })));
  check('给了 Google Scholar / 网页搜索 两个兜底入口', bottoms.length === 2, bottoms.map((b) => b.text).join(' / '));
  for (const b of bottoms) {
    const n = opened.length;
    await page.evaluate((text) => {
      const a = [...document.querySelectorAll('#citeResult .cite-acts a')].find((x) => x.textContent.trim() === text);
      a.click();
    }, b.text);
    await sleep(500);
    check(`点「${b.text}」也能打开`, opened.length === n + 1 && opened[n] === b.href, opened[n] || '(没调用)');
  }
}

/* ═══════════ 二、联网来源列表里的链接 ═══════════ */
console.log('\n-- 联网来源里的链接');
/**
 * 2026-10：发送范围搬进设置页（`#cfgUseFullText` / `#cfgUseWeb`），不再是输入框旁边
 * 那个「范围」菜单（`#optScope` → `#scopeMenu`）。口径没变，只是入口和语义变了：
 * 这两个现在是全局偏好，默认都开着，改一次就一直算数。
 * 联网来源列表要验的是「开着联网」，所以这里关整篇、开联网。
 */
await setScope(page, { full: false, web: true });
/**
 * 2026-10：右栏在「译文 / 问答一块都没开」时会收成右侧活动栏（`body.right-empty`），
 * 输入框 `#chatInput` 跟着变成 0×0 —— 直接 `page.click('#chatInput')` 会抛
 * 「Node is either not clickable or not an Element」。想打字必须先点活动栏把右栏拉回来。
 */
async function ensureComposer() {
  const visible = await page.evaluate(() => (document.getElementById('chatInput')?.getBoundingClientRect().width || 0) > 0);
  if (visible) return;
  // 2026-10：右侧那条小的活动栏（#railRightBtn）已按用户要求删除，
  // 而顶栏的 #topbarRightToggle 只切「右栏这一整条的展开/收起」，
  // 右栏展开后**仍然可能一块面板都没开**（问答块 visible=false）→ 输入框还是 0×0。
  // 所以直接走面板 API 把「问答」显出来，语义与当年点活动栏一致（与 context.mjs 同法）。
  await page.evaluate(() => {
    window.__ctx.setPanelVisible('chat', true);
    document.body.classList.remove('no-right');
  });
  await sleep(500);
}

await ensureComposer();
await page.click('#chatInput');
await page.type('#chatInput', '注意力机制是什么');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.querySelectorAll('#aiArea .msg.assistant .acts:not(.hidden)').length > 0, { timeout: 30000 });
await sleep(400);

/**
 * 取**最后一条带来源列表的助手消息**，不要用 `#aiArea .msg.assistant .src-list a`。
 * 会话恢复会把上一批套件留下的消息连同它们的来源一起重新渲染出来
 * （context.mjs 的联网来源是 arxiv 链接），所以「第一个 .src-list a」很可能属于更早的消息，
 * 断言就会拿错的 URL 去比对 —— 实测过：点的是 arxiv，期望的是 SOURCE_URL。
 */
const lastSrcList = () => page.evaluate(() => {
  const msgs = [...document.querySelectorAll('#aiArea .msg.assistant')];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const list = msgs[i].querySelector('.src-list');
    if (!list) continue;
    const a = list.querySelector('a');
    return { n: list.querySelectorAll('a').length, href: a?.getAttribute('href') || '', text: a?.textContent.trim() || '' };
  }
  return { n: 0, href: '', text: '' };
});
const srcInfo = await lastSrcList();
check('回答下面列出了来源', srcInfo.n >= 1 && /^https?:/.test(srcInfo.href), `${srcInfo.n} 条 · ${srcInfo.href}`);

{
  const n = opened.length;
  const navBefore = navigations.length;
  await page.evaluate(() => {
    const msgs = [...document.querySelectorAll('#aiArea .msg.assistant')];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const a = msgs[i].querySelector('.src-list a');
      if (a) { a.click(); return; }
    }
  });
  await sleep(700);
  check('点来源链接把地址交给了后端', opened.length === n + 1 && opened[n] === SOURCE_URL, opened[n] || '(没调用)');
  check('点来源链接不会把应用顶走', navigations.length === navBefore && await page.evaluate(() => !!window.__viewer?.pdf));
}

/* ═══════════ 三、只有 http(s) 才该被送出去 ═══════════ */
// 这里不去「点」相对链接：在浏览器里点一个 href="/api/health" 会真的把页面导航走，
// 反而把测试自己搞坏（第一版就是这样，导航到 JSON 后浏览器去要 favicon，多出一个 404）。
// 直接调 openExternal 检查它的判断，更准确也不带副作用。
{
  const n0 = opened.length;
  const guards = await page.evaluate(() => {
    const c = window.__ctx;
    return {
      rel: c.openExternal('/api/health'),
      js: c.openExternal('javascript:alert(1)'),
      file: c.openExternal('file:///C:/Windows/win.ini'),
      data: c.openExternal('data:text/html,<b>x</b>'),
      empty: c.openExternal(''),
    };
  });
  await sleep(400);
  check('站内相对链接 / 伪协议不会被当成外链送出去',
    Object.values(guards).every((v) => v === false) && opened.length === n0,
    `${JSON.stringify(guards)} · 多送 ${opened.length - n0} 次`);

  const n1 = opened.length;
  const okCall = await page.evaluate(() => window.__ctx.openExternal('http://example.com/x?a=1&b=2'));
  await sleep(500);
  check('http 链接会被送出去，且带 & 的查询串完整送达',
    okCall === true && opened.length === n1 + 1 && opened[n1] === 'http://example.com/x?a=1&b=2',
    opened[n1] || '(没调用)');
}

/* ═══════════ 汇总 ═══════════ */
check('没有未捕获的页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
check('没有控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
check('没有 4xx/5xx 请求', badResponses.length === 0, badResponses.slice(0, 3).join(' | '));

await page.screenshot({ path: path.join(OUT, 'links.png') });
await browser.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
