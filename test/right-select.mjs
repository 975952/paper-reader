/**
 * 右栏划词：问答回答 / 译文里的文字，选中后要像正文一样出现气泡，
 * 按钮子集是「加入问答 / 直接解释 / 复制」（翻译、写笔记不显示）。
 *
 *   node test/right-select.mjs
 *
 * 全部使用隔离数据目录与假模型；不需要真实 API Key。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';

const scratch = fs.mkdtempSync(path.join(SANDBOX, 'right-select-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), path.join(PAPERS, 'fixture-right.pdf'));

const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (label, ok, detail = '') => {
  checks.push({ label, ok });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
};
// 兜底：任何一步卡死都别让进程「假死」在后台（unref：正常结束不受影响）
const watchdog = setTimeout(() => { console.error('测试超时（180s），强制退出'); process.exit(3); }, 180000);
watchdog.unref?.();

async function findPort() {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  return port;
}

/* 假模型：第一轮问答、第二轮解释、第三轮翻译都用不同的可识别文本 */
const upstreamRequests = [];
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
    const sys = String(body.messages?.[0]?.content || '');
    const last = String(body.messages?.at(-1)?.content || '');
    upstreamRequests.push({ sys, last });
    let text = '这是右栏回答：注意力机制让模型并行处理序列。';
    // 只认翻译请求自己的系统提示（问答规则里现在也会出现「来自右栏回答 / 译文」字样）
    if (/学术论文翻译专家/.test(sys)) text = '这是右栏译文：注意力机制。';
    else if (/解释这段内容/.test(last)) text = '这是右栏解释：注意力就是按相关度加权求和。';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for (const chunk of (text.match(/[\s\S]{1,24}/g) || [])) {
      if (res.destroyed || res.writableEnded) return;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
      await wait(15);
    }
    if (!res.destroyed && !res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
  });
});

/** 在指定元素里选中一段文字，并模拟松手（触发 app 的 mouseup 选区判定） */
const selectInPanel = async (page, { selector, find }) => page.evaluate((sel, needle) => {
  const root = [...document.querySelectorAll(sel)].at(-1);
  if (!root) return { ok: false, reason: 'no element' };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = null;
  let at = -1;
  while (walker.nextNode()) {
    const i = walker.currentNode.textContent.indexOf(needle);
    if (i >= 0) { node = walker.currentNode; at = i; break; }
  }
  if (!node) return { ok: false, reason: 'text not found' };
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + needle.length);
  const choices = window.getSelection();
  choices.removeAllRanges();
  choices.addRange(range);
  const rect = range.getBoundingClientRect();
  root.dispatchEvent(new MouseEvent('mouseup', {
    bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
  }));
  return { ok: true, text: range.toString(), width: rect.width, height: rect.height };
}, selector, find);

let reader = null;
let browser = null;
try {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const aiPort = upstream.address().port;
  const readerPort = await findPort();
  reader = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env, PORT: String(readerPort), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS,
      NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1',
    },
    stdio: 'ignore',
  });
  const BASE = `http://127.0.0.1:${readerPort}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i += 1) {
    await wait(100);
    try { ready = (await fetch(`${BASE}/api/health`)).ok; } catch { /* wait */ }
  }
  check('隔离服务启动', ready);
  if (!ready) throw new Error('isolated server failed to start');
  await fetch(`${BASE}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: `http://127.0.0.1:${aiPort}/v1`, model: 'right-select-mock', apiKey: 'right-select-key' }),
  });

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
    defaultViewport: { width: 1500, height: 950 },
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto(`${BASE}/?open=fixture-right.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__state?.doc && window.__viewer?.numPages > 0, { timeout: 40000 });
  await page.evaluate(() => window.__ctx.setPanelVisible('chat', true));
  await page.waitForFunction(() => document.querySelectorAll('#aiArea .ai-block').length > 0, { timeout: 20000 });

  /* ── 1. 先做一次问答，右栏得到一条回答 ── */
  await page.evaluate(() => {
    window.__ctx.setPanelVisible('chat', true);
    const input = document.querySelector('#chatInput');
    input.value = '注意力机制是什么？';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#sendBtn');
  await page.waitForFunction(() => !window.__state.busy
    && [...document.querySelectorAll('#aiArea .msg.assistant .text')].some((n) => n.textContent.includes('注意力机制让模型')), { timeout: 20000 });

  /* ── 2. 在回答正文里选中一段：气泡出现、按钮子集正确 ── */
  const picked = await selectInPanel(page, {
    selector: '#aiArea .ai-block[data-panel="chat"] .msg.assistant .text',
    find: '注意力机制',
  });
  check('能在右栏回答里建立选区', picked.ok, picked.reason || `"${picked.text}"`);
  await wait(150);
  const bubble = await page.evaluate(() => {
    const b = document.querySelector('#bubble');
    const visible = (sel) => [...b.querySelectorAll(sel)].filter((n) => getComputedStyle(n).display !== 'none').map((n) => n.dataset.act);
    return {
      open: !b.classList.contains('hidden'),
      source: b.dataset.source || '',
      visible: visible('button[data-act]'),
      label: b.querySelector('button[data-act="add"] span')?.textContent || '',
      selected: window.__state.selection?.cleanText || '',
      page: window.__state.selection?.page || null,
      viewerPage: window.__viewer?.current || null,
      scrollTop: document.querySelector('#viewer')?.scrollTop || 0,
    };
  });
  check('右栏选区弹出气泡', bubble.open && bubble.source === 'right', JSON.stringify(bubble));
  check('气泡只显示 加入问答 / 直接解释 / 复制', JSON.stringify(bubble.visible.sort()) === JSON.stringify(['add', 'copy', 'explain']), bubble.visible.join(','));
  check('「加入问答」文案和按钮标题已切换', bubble.label === '加入问答', bubble.label);
  check('右栏选区不冒充 PDF 页码（page 为 null）',
    bubble.selected.includes('注意力机制') && bubble.page === null,
    `p=${bubble.page} viewer=${bubble.viewerPage} scrollTop=${bubble.scrollTop}`);

  /* ── 3. 点「加入问答」：进附件区、聚焦输入框、标注来源（不标页码） ── */
  await page.click('#bubble button[data-act="add"]');
  await wait(120);
  const attached = await page.evaluate(() => ({
    count: window.__state.attachments.length,
    from: window.__state.attachments[0]?.from || '',
    page: Object.prototype.hasOwnProperty.call(window.__state.attachments[0] || {}, 'page')
      ? window.__state.attachments[0].page : 'missing',
    text: window.__state.attachments[0]?.text || '',
    rowText: [...document.querySelectorAll('#attachRow .attach')].map((n) => n.textContent).join(' | '),
    focused: document.activeElement?.id || '',
    bubbleHidden: document.querySelector('#bubble').classList.contains('hidden'),
  }));
  check('点「加入问答」后进入附件区', attached.count === 1 && attached.text.includes('注意力机制'), JSON.stringify(attached));
  check('附件标注来源「右栏」且不带第 N 页', attached.from === 'right' && attached.rowText.includes('右栏')
    && attached.page === null && !/第\d+页/.test(attached.rowText), attached.rowText);
  check('加完气泡收起、光标落在输入框', attached.bubbleHidden && attached.focused === 'chatInput', attached.focused);
  // 清掉附件，免得影响后面的「直接解释」
  await page.evaluate(() => { window.__state.attachments = []; window.__ctx.renderAttachments(); });

  /* ── 4. 再选一段、点「直接解释」：解释进问答区 ── */
  await page.evaluate(() => window.__ctx.hideBubble());
  const picked2 = await selectInPanel(page, {
    selector: '#aiArea .ai-block[data-panel="chat"] .msg.assistant .text',
    find: '并行处理',
  });
  check('第二次右栏选区可用', picked2.ok, picked2.reason || picked2.text);
  await wait(120);
  await page.click('#bubble button[data-act="explain"]');
  await page.waitForFunction(() => [...document.querySelectorAll('#aiArea .msg.assistant')]
    .some((n) => n.querySelector('.tag')?.textContent === 'explanation' && n.textContent.includes('按相关度加权')), { timeout: 20000 });
  // 解释正文先到、历史在流结束后才落：等它记进去再断言，避免读早了
  const historyOk = await page.waitForFunction(() => window.__state.history.length >= 4, { timeout: 5000 })
    .then(() => true).catch(() => false);
  const explain = await page.evaluate(() => {
    const row = [...document.querySelectorAll('#aiArea .msg.assistant')]
      .find((n) => n.querySelector('.tag')?.textContent === 'explanation');
    return { quote: row?.querySelector('.ref')?.textContent || '', history: window.__state.history.length };
  });
  check('「直接解释」把右栏选中文本作为解释对象', explain.quote.includes('并行处理'), explain.quote);
  check('解释进入会话历史（可继续追问）', historyOk && explain.history >= 4, String(explain.history));
  const explainReq = upstreamRequests.find((r) => /请解释这段内容/.test(r.last) && /并行处理/.test(r.last))?.last || '';
  check('解释请求标明来自右栏、不冒充第 N 页原文',
    /来自右栏回答/.test(explainReq) && !/第\s*\d+\s*页/.test(explainReq), explainReq.slice(0, 200));

  /* ── 5. 译文块里的文字同样能划词 ── */
  await page.evaluate(() => window.__ctx.doTranslate({
    text: 'attention is all you need', cleanText: 'attention is all you need', page: 1,
    box: { left: 100, top: 100, right: 200, bottom: 120 },
  }));
  await page.waitForFunction(() => [...document.querySelectorAll('#aiArea .ai-block[data-panel="translate"] .msg .text')]
    .some((n) => n.textContent.includes('这是右栏译文')), { timeout: 20000 });
  const picked3 = await selectInPanel(page, {
    selector: '#aiArea .ai-block[data-panel="translate"] .msg .text',
    find: '注意力机制',
  });
  check('译文块里也能建立选区', picked3.ok, picked3.reason || picked3.text);
  await wait(120);
  const bubble2 = await page.evaluate(() => {
    const b = document.querySelector('#bubble');
    const visible = [...b.querySelectorAll('button[data-act]')]
      .filter((n) => getComputedStyle(n).display !== 'none').map((n) => n.dataset.act).sort();
    return { open: !b.classList.contains('hidden'), source: b.dataset.source, visible };
  });
  check('译文块划词也弹出同一气泡（无翻译 / 笔记按钮）',
    bubble2.open && bubble2.source === 'right' && JSON.stringify(bubble2.visible) === JSON.stringify(['add', 'copy', 'explain']),
    JSON.stringify(bubble2));

  /* ── 6. 正文划词不受影响：气泡回到正文按钮集 ── */
  await page.evaluate(() => window.__ctx.hideBubble());
  const bodySel = await page.evaluate(() => {
    const span = [...document.querySelectorAll('#viewer .page[data-page="1"] .textLayer span, #viewer .page[data-page="1"] .text-layer span')]
      .find((s) => (s.textContent || '').trim().length > 8);
    if (!span) return { ok: false };
    const range = document.createRange();
    range.selectNodeContents(span);
    const choices = window.getSelection();
    choices.removeAllRanges();
    choices.addRange(range);
    const rect = range.getBoundingClientRect();
    span.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
    }));
    return { ok: true, text: range.toString() };
  });
  await wait(200);
  const bubble3 = await page.evaluate(() => {
    const b = document.querySelector('#bubble');
    const visible = [...b.querySelectorAll('button[data-act]')]
      .filter((n) => getComputedStyle(n).display !== 'none').map((n) => n.dataset.act).sort();
    return { open: !b.classList.contains('hidden'), source: b.dataset.source, visible, label: b.querySelector('button[data-act="add"] span')?.textContent };
  });
  check('正文划词仍显示完整气泡（翻译 / 笔记都还在）',
    bodySel.ok && bubble3.open && bubble3.source === 'body'
      && ['add', 'copy', 'explain', 'note', 'translate'].every((a) => bubble3.visible.includes(a)),
    JSON.stringify(bubble3));
  check('正文气泡文案回到「对话」', bubble3.label === '对话', bubble3.label);

  check('操作期间没有页面错误', pageErrors.length === 0, pageErrors.join(' | '));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n右栏划词：${checks.length - failed.length}/${checks.length} 通过`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { reader?.kill(); } catch { /* ignore */ }
  // 假上游不关掉会一直占着事件循环：测试失败时进程会「假死」，看不到报错
  try { upstream.closeAllConnections?.(); await new Promise((r) => upstream.close(r)); } catch { /* ignore */ }
}
