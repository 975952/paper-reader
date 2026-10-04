/**
 * 真实流式验证：起"慢速分块吐字"的假 OpenAI 服务，让前端真走一遍
 *   node test/stream.mjs
 * 验证：代理边收边转发、前端逐块显示、停止按钮可用、非流式上游可回退
 */
import http from 'node:http';
import { assertIsolatedDataDir, resolveDataDir } from './_env.mjs';
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const SSE_PORT = 8899;
const JSON_PORT = 8897;
const CHUNKS = 10;
const CHUNK_DELAY = 220;

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '  ✅' : '  ❌'} ${n}${d ? `  — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 两个假上游：慢速 SSE / 普通 JSON ── */
async function drain(req) { for await (const _ of req) { /* drain */ } }

const sseMock = http.createServer(async (req, res) => {
  await drain(req);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (let i = 1; i <= CHUNKS; i++) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `[块${i}]` } }] })}\n\n`);
    await sleep(CHUNK_DELAY);
  }
  res.write('data: [DONE]\n\n');
  res.end();
});
const jsonMock = http.createServer(async (req, res) => {
  await drain(req);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: '非流式：直接返回整段译文\n\n```js\nconst ok = true;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n$E=mc^2$' } }] }));
});
/** 端口被上次残留进程占着就顺延，避免测试因为环境问题假失败 */
async function listenAny(server, ports, label) {
  for (const port of ports) {
    try {
      await new Promise((resolve, reject) => {
        const onErr = (e) => { server.removeListener('listening', onOk); reject(e); };
        const onOk = () => { server.removeListener('error', onErr); resolve(); };
        server.once('error', onErr);
        server.once('listening', onOk);
        server.listen(port, '127.0.0.1');
      });
      return port;
    } catch { /* 换下一个端口 */ }
  }
  throw new Error(`${label} 在 ${ports.join('/')} 上都起不来`);
}
const SSE_PORT_ACTUAL = await listenAny(sseMock, [SSE_PORT, 8909, 8919, 8929], '假 SSE 上游');
const JSON_PORT_ACTUAL = await listenAny(jsonMock, [JSON_PORT, 8907, 8917, 8927], '假 JSON 上游');

const setBase = (port) => fetch(`${BASE}/api/config`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ baseURL: `http://127.0.0.1:${port}/v1`, model: 'mock-model', apiKey: 'mock-key' }),
});

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 1400, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const papers = await fetch(`${BASE}/api/papers`).then((r) => r.json());
const pdfName = papers.papers[0].name;
assertIsolatedDataDir(resolveDataDir(papers.dir));

async function loadPage() {
  await page.goto(`${BASE}/?open=${encodeURIComponent(pdfName)}&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 30000 });
  await sleep(1800);
}

/** 选一段文字并点气泡按钮。offset 用来选不同文本，避开翻译缓存 */
async function selectAndClick(act = 'translate', offset = 1) {
  const ok = await page.evaluate((off) => {
    const v = document.getElementById('viewer');
    const vr = v.getBoundingClientRect();
    const pool = [...document.querySelectorAll('.page [class="textLayer"] span:not(.markedContent)')]
      .filter((s) => (s.textContent || '').trim().length > 3 && s.getBoundingClientRect().width > 0.5)
      .filter((s) => { const r = s.getBoundingClientRect(); return r.top > vr.top + 30 && r.bottom < vr.bottom - 30; });
    const a = pool[off];
    const b = pool[off + 2];
    if (!a || !b) return false;
    const range = document.createRange();
    range.setStart(a.firstChild, 0);
    range.setEnd(b.firstChild, b.textContent.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.getElementById('viewer').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return true;
  }, offset);
  if (!ok) throw new Error('选不到文字');
  await sleep(300);
  const pt = await page.evaluate((a) => {
    const r = document.querySelector(`#bubble button[data-act="${a}"]`).getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, act);
  await page.mouse.click(pt.x, pt.y);
}

/* ═══ 1. 流式 ═══ */
console.log('▶ 流式响应…');
await setBase(SSE_PORT_ACTUAL);
await loadPage();
const t0 = Date.now();
await selectAndClick('translate', 1);
let firstAt = null;
let firstCount = 0;
for (let i = 0; i < 100; i++) {
  const txt = await page.evaluate(() => document.getElementById('popBody')?.innerText || '');
  const n = (txt.match(/\[块\d+\]/g) || []).length;
  if (!firstAt && n > 0) { firstAt = Date.now() - t0; firstCount = n; }
  if (n >= CHUNKS) break;
  await sleep(80);
}
const totalMs = Date.now() - t0;
const finalText = await page.evaluate(() => document.getElementById('popBody')?.innerText || '');
const finalCount = (finalText.match(/\[块\d+\]/g) || []).length;
check('译文完整收到', finalCount === CHUNKS, `${finalCount}/${CHUNKS} 块，总耗时 ${totalMs}ms`);
check('是真实流式（第一块远早于总耗时）',
  firstAt !== null && firstAt < totalMs * 0.6,
  `第 1 块 ${firstAt}ms / 全部 ${totalMs}ms（${Math.round((firstAt / totalMs) * 100)}%）`);
check('逐块增长（不是一次性出现）', firstCount > 0 && firstCount < CHUNKS / 2, `第一块出现时已有 ${firstCount} 块`);
await page.evaluate(() => document.getElementById('popClose').click());
await sleep(300);

/* ═══ 2. 停止 ═══ */
console.log('\n▶ 停止生成…');
await selectAndClick('translate', 4);
await sleep(650);
const busy = await page.evaluate(() => ({
  stopVisible: !document.getElementById('stopBtn').classList.contains('hidden'),
  hint: document.getElementById('composerHint').textContent,
}));
check('生成中显示停止按钮 + 计时', busy.stopVisible && /\d+s/.test(busy.hint), `按钮=${busy.stopVisible} 提示="${busy.hint}"`);
await page.evaluate(() => document.getElementById('stopBtn').click());
const atStop = await page.evaluate(() => document.getElementById('popBody')?.innerText || '');
await sleep(1200);
const afterStop = await page.evaluate(() => ({
  text: document.getElementById('popBody')?.innerText || '',
  stopHidden: document.getElementById('stopBtn').classList.contains('hidden'),
}));
check('停止后不再继续增长', !afterStop.text.includes(`[块${CHUNKS}]`), `停止时 ${(atStop.match(/\[块\d+\]/g) || []).length} 块，之后 ${(afterStop.text.match(/\[块\d+\]/g) || []).length} 块`);
check('停止后按钮恢复', afterStop.stopHidden);
await page.evaluate(() => document.getElementById('popClose').click());
await sleep(300);

/* ═══ 3. 非流式上游 ═══ */
console.log('\n▶ 非流式上游…');
await setBase(JSON_PORT_ACTUAL);
await loadPage();
await selectAndClick('translate', 1);
await sleep(1600);
const jsonText = await page.evaluate(() => document.getElementById('popBody')?.innerText || '');
check('非流式上游也能出结果', jsonText.includes('非流式'), JSON.stringify(jsonText.slice(0, 40)));
const rendered = await page.evaluate(() => {
  // 取**最后一条**助手消息，不要用「第一个匹配」（恢复会话会把更早套件留下的回答一起重放出来）；
  // 而且分栏之后 DOM 顺序 ≠ 时间顺序，「最新一条」按 dataset.seq 取最大。
  // 注意选择器：`.assistant` 要在两个容器上各写一次（`#aiArea .msg, #aiArea2 .msg.assistant` 是错的）。
  const msgs = [...document.querySelectorAll('#aiArea .msg.assistant, #aiArea2 .msg.assistant')]
    .sort((a, b) => Number(a.dataset.seq || 0) - Number(b.dataset.seq || 0));
  const root = msgs.at(-1);
  if (!root) return { code: '', table: 0, math: false };
  return {
    code: root.querySelector('.text pre code')?.textContent || '',
    table: root.querySelectorAll('.text table tbody tr').length,
    math: !!root.querySelector('.text .katex'),
  };
});
check('生成内容最终正确渲染代码、表格和公式', rendered.code.includes('const ok') && rendered.table >= 1 && rendered.math,
  `代码=${!!rendered.code} 表格行=${rendered.table} 公式=${rendered.math}`);
// 直接用「问答块里的消息条数」做判据：这块本身就代表问答分块，
// 不必再拼 `#aiArea/#aiArea2` 那种跨栏选择器（分栏后那块可能在任意一栏）。
const chatMsgCount = () => page.evaluate(() => window.__state.blockEls?.chat?.querySelectorAll('.msg').length ?? 0);
const priorCount = await chatMsgCount();
await page.evaluate(() => {
  if (document.querySelector('#optFull').classList.contains('on')) document.querySelector('#optFull').click();
  document.querySelector('#chatInput').value = 'mock session question';
  document.querySelector('#composer').requestSubmit();
});
await page.waitForFunction((count) => {
  // 判据用「问答块里的消息条数」：这块本身就是问答分块，分栏之后它在 #aiArea 还是 #aiArea2
  // 都不影响；同时要求最后一条助手消息的动作条已经显形（=这一轮回答真的收尾了）。
  const chat = window.__state.blockEls?.chat;
  const msgs = [...(chat?.querySelectorAll('.msg') || [])]
    .sort((a, b) => Number(a.dataset.seq || 0) - Number(b.dataset.seq || 0));
  const last = msgs.filter((m) => m.classList.contains('assistant')).at(-1);
  return msgs.length > count && !!last && !last.querySelector('.acts')?.classList.contains('hidden');
}, { timeout: 15000 }, priorCount).catch(async (err) => {
  const dbg = await page.evaluate(() => ({
    chatMsgs: window.__state.blockEls?.chat?.querySelectorAll('.msg').length ?? -1,
    chatInDoc: window.__state.blockEls?.chat?.isConnected,
    chatPane: window.__state.blockEls?.chat?.closest('.ai')?.id || '-',
    chatKids: [...(window.__state.blockEls?.chat?.querySelectorAll('.ai-body > *') || [])].map((m) => `${m.tagName}.${m.className}`),
    vis: { t: window.__state.panels.translate.visible, c: window.__state.panels.chat.visible },
    col: { t: window.__state.panels.translate.col, c: window.__state.panels.chat.col },
    entries: window.__state.sessionEntries.length,
    busy: window.__state.busy,
    hint: document.getElementById('composerHint')?.textContent || '',
  }));
  console.log('  [dbg] 等新助手消息超时：' + JSON.stringify(dbg));
  throw err;
});
const savedSession = await page.evaluate(() => ({
  entries: window.__state.sessionEntries.map((x) => x.text).join('\n'),
  history: window.__state.history.map((x) => x.content).join('\n'),
  raw: JSON.stringify(window.__state.sessionEntries),
}));
check('会话持久化不包含图片 data URL', savedSession.raw.includes('非流式') && !savedSession.raw.includes('data:image/'));
check('对话历史已保存', savedSession.history.includes('mock session question') && savedSession.history.includes('非流式'));
const switchTarget = await page.evaluate(() => {
  const current = window.__state.doc?.docId;
  return [...document.querySelectorAll('#fileList li')].map((n) => n.dataset.id).find((id) => id && id !== current) || '';
});
check('临时书架提供第二篇测试论文', !!switchTarget);
if (switchTarget) {
  await page.click(`#fileList li[data-id="${switchTarget}"]`);
  await page.waitForFunction((id) => window.__state.doc?.docId === id, { timeout: 30000 }, switchTarget);
}
await loadPage();
const restored = await page.evaluate(() => ({
  result: [...document.querySelectorAll('#aiArea .msg.assistant .text, #aiArea2 .msg.assistant .text')].some((n) => n.textContent.includes('非流式')),
  history: window.__state.history.some((x) => x.content === 'mock session question'),
}));
check('重启页面后恢复已完成 AI 结果和对话历史', restored.result && restored.history);
await page.evaluate(async () => {
  window.__state.sessionEntries = Array.from({ length: 90 }, (_, i) => ({ block: 'chat', kind: 'assistant', text: `${i}:` + '测'.repeat(12000), sources: [] }));
  await window.__ctx.saveSessionNow();
});
const boundedBytes = await page.evaluate(async (id) => {
  const payload = await fetch(`/api/session?doc=${encodeURIComponent(id)}`).then((r) => r.json());
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
}, await page.evaluate(() => window.__state.doc.docId));
check('论文会话存储上限为 350 KB', boundedBytes <= 350000, `${boundedBytes} bytes`);
page.once('dialog', (dialog) => dialog.accept());
await page.click('#clearSession');
await page.waitForFunction(async (id) => {
  const r = await fetch(`/api/session?doc=${encodeURIComponent(id)}`); const j = await r.json(); return !j.entries?.length && !j.history?.length;
}, {}, (await page.evaluate(() => window.__state.doc.docId)));
check('清空当前论文会话入口可用', true);

console.log('\n── 异常 ──');
console.log(errors.length ? errors.map((e) => '  ! ' + e).join('\n') : '  无');

const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);

await browser.close();
await new Promise((r) => sseMock.close(r));
await new Promise((r) => jsonMock.close(r));
process.exit(passed === results.length && !errors.length ? 0 : 1);
