/**
 * 公式渲染验收。
 *
 *   BASE=http://127.0.0.1:8787 node test/math.mjs
 *
 * 背景：之前 renderMarkdown 里写着「行内公式保留原样，交给用户看」，
 * 于是模型给的 \text{Attention}(Q,K,V)=\text{softmax}(\frac{QK^T}{\sqrt{d_k}})V
 * 原样显示成 LaTeX 源码 = 用户说的「一些符号渲染不了」。
 * 现在内置 KaTeX（public/vendor/katex，不联网）。
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
assertIsolatedDataDir(resolveDataDir(papers.dir));
await fetch(`${BASE}/api/state`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ lastDoc: null, lastName: null, lastUrl: null, docs: {} }),
});

/* ── 一、静态资源：KaTeX 必须被内嵌并能正确取到 ── */
console.log('\n-- 公式引擎资源');
const cssRes = await fetch(`${BASE}/vendor/katex/katex.min.css`);
check('katex.min.css 能取到', cssRes.status === 200 && (await cssRes.text()).includes('katex'),
  `${cssRes.status} ${cssRes.headers.get('content-type')}`);
check('CSS 的 MIME 正确', (cssRes.headers.get('content-type') || '').includes('text/css'));

const jsRes = await fetch(`${BASE}/vendor/katex/katex.min.js`);
const jsBody = await jsRes.text();
check('katex.min.js 能取到', jsRes.status === 200 && jsBody.length > 100000, `${Math.round(jsBody.length / 1024)}KB`);
check('JS 的 MIME 正确', (jsRes.headers.get('content-type') || '').includes('javascript'),
  jsRes.headers.get('content-type'));

const fontRes = await fetch(`${BASE}/vendor/katex/fonts/KaTeX_Main-Regular.woff2`);
check('字体文件能取到（离线渲染，不依赖 CDN）', fontRes.status === 200,
  `${fontRes.status} ${fontRes.headers.get('content-type')} ${fontRes.headers.get('content-length')}B`);
check('字体 MIME 是 font/woff2', (fontRes.headers.get('content-type') || '').includes('font/woff2'),
  fontRes.headers.get('content-type'));

/* ── 二、浏览器里渲染 ── */
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1500,950'],
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
const consoleErrors = [];
const pageErrors = [];
const badResponses = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('response', (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`); });

await page.setRequestInterception(true);
const ANSWER = [
  '注意力机制（attention）的核心公式是：$\\text{Attention}(Q,K,V)=\\text{softmax}(\\frac{QK^T}{\\sqrt{d_k}})V$。',
  '',
  '多头的拼接如下：',
  '',
  '$$\\text{MultiHead}(Q,K,V)=\\text{Concat}(\\text{head}_1,\\dots,\\text{head}_h)W^O$$',
  '',
  '另外用 \\(P E_{(pos,2i)}=\\sin(pos/10000^{2i/d_{model}})\\) 注入位置信息，用 \\[O(n^2 d)\\] 表示复杂度。',
  '',
  '行内代码里的 $ 不该变成公式：`echo $HOME`。',
  '',
  '```',
  'fenced $x^2$ code',
  '```',
  '',
  '价格是 $5 到 $10 之间，这不该被当成公式。',
  '',
  '这条公式是坏的：$\\frac{1}$ —— 应该原样显示而不是崩掉。',
].join('\n');

page.on('request', (req) => {
  if (req.url().endsWith('/api/chat')) {
    const chunks = ANSWER.match(/[\s\S]{1,40}/g) || [];
    const sse = chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
    return req.respond({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: sse });
  }
  return req.continue();
});

await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#fileList li', { timeout: 20000 });
await page.evaluate((id) => {
  const li = [...document.querySelectorAll('#fileList li')].find((x) => x.dataset.id === id) || document.querySelector('#fileList li');
  li.click();
}, first.docId);
await page.waitForFunction(() => window.__viewer?.pdf, { timeout: 40000 });
await sleep(1200);

check('页面里加载了 KaTeX', await page.evaluate(() => typeof window.katex?.renderToString === 'function'));

/* 直接喂一段公式，检查 renderMarkdown 的产物 —— 比走一遍问答更快也更准 */
const rendered = await page.evaluate(async (ans) => {
  const m = await import('/js/util.js');
  const html = m.renderMarkdown(ans);
  const box = document.createElement('div');
  box.className = 'text';
  box.style.cssText = 'position:fixed;left:-9999px;top:0;width:360px';
  box.innerHTML = html;
  document.body.append(box);
  const out = {
    html,
    katex: box.querySelectorAll('.katex').length,
    display: box.querySelectorAll('.katex-display').length,
    errors: box.querySelectorAll('.katex-error').length,
    // 公式必须真的占位置（不是空壳）
    firstBox: (() => { const k = box.querySelector('.katex'); if (!k) return null; const r = k.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
    codeText: [...box.querySelectorAll('code')].map((c) => c.textContent),
    // 货币符号不该被吃掉
    plain: box.textContent,
    overflow: (() => { const d = box.querySelector('.katex-display'); return d ? { sw: d.scrollWidth, cw: d.clientWidth } : null; })(),
  };
  box.remove();
  return out;
}, ANSWER);

console.log('\n-- 渲染结果');
check('行内 $...$ 变成了真公式', rendered.katex > 0, `${rendered.katex} 个 .katex 节点`);
check('块级 $$...$$ 变成独立公式块', rendered.display >= 1, `${rendered.display} 个 .katex-display`);
check('公式有实际尺寸（不是空壳）', !!rendered.firstBox && rendered.firstBox.w > 5 && rendered.firstBox.h > 5,
  JSON.stringify(rendered.firstBox));
check('\\\\( \\\\) 与 \\\\[ \\\\] 也能渲染', rendered.katex >= 3, `${rendered.katex} 个`);
check('没有红色报错块（坏公式走的是原文回退）', rendered.errors === 0, `${rendered.errors} 个 .katex-error`);
check('坏公式原样显示、没被吞掉', rendered.plain.includes('\\frac{1}'),
  rendered.plain.match(/这条公式是坏的：.{0,24}/)?.[0] || '');
check('货币符号不会被误当成公式', rendered.plain.includes('$5 到 $10'),
  rendered.plain.match(/价格是.{0,16}/)?.[0] || '');
check('行内代码里的 $ 保持原样', rendered.codeText.some((t) => t.includes('$HOME')), JSON.stringify(rendered.codeText.slice(0, 3)));
check('围栏代码块里的公式不被渲染', rendered.codeText.some((t) => t.includes('$x^2$')), JSON.stringify(rendered.codeText.slice(0, 3)));

/* ── 三、Markdown 表格 ── */
console.log('\n-- 表格');
const TABLE_MD = [
  '| 想写的东西 | LaTeX 写法 | 说明 |',
  '|---|---|---|',
  '| 上标 / 下标 | $x^n$、$a_k$ | 多字符必须加花括号：$x^{2n}$ |',
  '| 导数阶数 | $f^{(n)}(0)$ | 括号是必要的 |',
  '| 分数 | $\\frac{f^{(n)}(0)}{n!}$ | 嵌套分数会变小 |',
  '| 竖线转义 | a \\| b | 用反斜杠转义 |',
  '',
  '表格下面还有一段普通文字。',
].join('\n');

const table = await page.evaluate(async (md) => {
  const m = await import('/js/util.js');
  const html = m.renderMarkdown(md);
  const box = document.createElement('div');
  box.className = 'text';
  box.style.cssText = 'position:fixed;left:-9999px;top:0;width:360px';
  box.innerHTML = html;
  document.body.append(box);
  const out = {
    html,
    hasTable: !!box.querySelector('table.md-table'),
    th: box.querySelectorAll('table.md-table th').length,
    tr: box.querySelectorAll('table.md-table tbody tr').length,
    td: box.querySelectorAll('table.md-table td').length,
    katexInCell: box.querySelectorAll('table.md-table td .katex').length,
    wrapScrolls: (() => { const w = box.querySelector('.md-table-wrap'); return w ? getComputedStyle(w).overflowX : null; })(),
    nested: !!box.querySelector('p table'),
    before: box.textContent.includes('想写的东西'),
    after: box.textContent.includes('表格下面还有一段普通文字'),
    escapedPipe: box.textContent.includes('a | b'),
    borderSet: (() => { const c = box.querySelector('table.md-table td'); return c ? getComputedStyle(c).borderTopWidth : null; })(),
    headBg: (() => { const c = box.querySelector('table.md-table th'); return c ? getComputedStyle(c).backgroundColor : null; })(),
  };
  box.remove();
  return out;
}, TABLE_MD);

check('| 表格被渲染成真正的 <table>', table.hasTable, table.hasTable ? '' : table.html.slice(0, 80));
check('表头 3 列 / 数据 4 行', table.th === 3 && table.tr === 4, `${table.th} 列头 · ${table.tr} 行`);
check('每行 3 个单元格', table.td === 12, `${table.td} 个 td`);
check('表格里的公式也渲染了', table.katexInCell >= 3, `${table.katexInCell} 个公式`);
check('表格没有被包进 <p>（否则浏览器会把它甩出去）', !table.nested);
check('表格前后的正文都还在', table.before && table.after);
check('单元格里转义的竖线不拆列', table.escapedPipe);
check('表格有边框、表头有底色', table.borderSet !== '0px' && table.headBg !== 'rgba(0, 0, 0, 0)',
  `border=${table.borderSet} headBg=${table.headBg}`);
check('宽表格可以横向滚动', table.wrapScrolls === 'auto' || table.wrapScrolls === 'scroll', table.wrapScrolls);

const notTable = await page.evaluate(async () => {
  const m = await import('/js/util.js');
  const html = m.renderMarkdown('只是一句话 | 中间有个竖线，但下面不是分隔行\n下一行也不是。');
  return { hasTable: /<table/.test(html), text: html };
});
check('只有竖线、没有分隔行的不会被误判成表格', !notTable.hasTable, notTable.text.slice(0, 60));

/* ── 四、走一遍真实问答，确认消息里也渲染 ── */
console.log('\n-- 走一遍问答');
/**
 * 2026-10：发送范围搬进设置页（`#cfgUseFullText` / `#cfgUseWeb`），默认都开着。
 * 这一节只要「不要带整篇」——所以去设置里把它关掉（全局偏好，关一次一直算数）。
 */
await setScope(page, { full: false });
// 等「这一条新回答」按**增量**等：会话恢复会把旧消息连同已完成的动作条一起重放出来，
// 写死 `> 0` 在脏 data 下会立刻满足，断言就会读到上一批套件留下的旧消息。
const doneBefore = await page.evaluate(() => document.querySelectorAll('#aiArea .msg.assistant .acts:not(.hidden)').length);
/**
 * 2026-10：右栏在「一块都没开」时会收成右侧活动栏（`body.right-empty`），`#chatInput`
 * 跟着变成 0×0 —— `page.click('#chatInput')` 会抛「Node is either not clickable」。
 */
async function ensureComposer() {
  const visible = await page.evaluate(() => (document.getElementById('chatInput')?.getBoundingClientRect().width || 0) > 0);
  if (visible) return;
  // 2026-10：右侧那条小的活动栏（#railRightBtn）已按用户要求删除
  //（「最右边那个小的侧边栏不要」）。右栏显隐现在只有顶栏的 #topbarRightToggle 一个入口。
  await page.click('#topbarRightToggle');
  await sleep(500);
}

await ensureComposer();
await page.click('#chatInput');
await page.type('#chatInput', '把公式列一下');
await page.keyboard.press('Enter');
await page.waitForFunction((n) => document.querySelectorAll('#aiArea .msg.assistant .acts:not(.hidden)').length > n,
  { timeout: 30000 }, doneBefore);
await sleep(600);
const inMsg = await page.evaluate(() => {
  // 取**最后一条**助手消息（分块之后 DOM 顺序 ≠ 时间顺序，按 dataset.seq 取最大）
  const msgs = [...document.querySelectorAll('#aiArea .msg.assistant')]
    .sort((a, b) => Number(a.dataset.seq || 0) - Number(b.dataset.seq || 0));
  const t = msgs.at(-1)?.querySelector('.text');
  if (!t) return { katex: 0, display: 0, err: 0 };
  return { katex: t.querySelectorAll('.katex').length, display: t.querySelectorAll('.katex-display').length, err: t.querySelectorAll('.katex-error').length };
});
check('AI 回答里的公式真的渲染出来了', inMsg.katex > 0 && inMsg.display > 0, JSON.stringify(inMsg));
check('回答里没有报错公式', inMsg.err === 0);

/* ── 四、窄面板里公式不能撑破布局 ── */
const wide = await page.evaluate(() => {
  const side = document.getElementById('rightSide');
  const d = document.querySelector('#aiArea .katex-display');
  return {
    sideOverflow: side.scrollWidth - side.clientWidth,
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    displayScrollable: d ? getComputedStyle(d).overflowX : '(没有块级公式)',
  };
});
check('公式没有把右栏撑破', wide.sideOverflow <= 1 && wide.docOverflow <= 1, JSON.stringify(wide));
check('块级公式超宽时可以横向滚动', wide.displayScrollable === 'auto' || wide.displayScrollable === 'scroll',
  wide.displayScrollable);

check('没有未捕获的页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
check('没有控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
check('没有 4xx/5xx 资源请求', badResponses.length === 0, badResponses.slice(0, 3).join(' | '));

await page.screenshot({ path: path.join(OUT, 'math.png') });
await browser.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
await sleep(250);
process.exit(passed === results.length ? 0 : 1);
