/**
 * 端到端测试：用无头 Chrome 真跑一遍阅读器
 *   node e2e.mjs                  （默认打 http://127.0.0.1:8787）
 *   BASE=http://127.0.0.1:8790 node e2e.mjs
 * AI 请求会被拦截并返回假回复，不需要 API Key。
 */
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, resolveDataDir } from './_env.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.join(import.meta.dirname, 'artifacts');
fs.mkdirSync(OUT, { recursive: true });
const localPdf = path.join(OUT, 'local-import-sample.pdf');
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), localPdf);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ══════════════ 先把服务端状态清干净，保证断言可重复 ══════════════ */
const papers = await fetch(`${BASE}/api/papers`).then((r) => r.json()).catch(() => ({ papers: [] }));
// 列表是按 mtime 倒序的，直接取 [0] 会被「刚上传的小测试文件」带偏
// （真实事故：cjk 测试留下的 cn-sample.pdf 只有 1 页，e2e 的虚拟化断言当场全红）。
// 这里挑体积最大的一篇 —— 那才是真正的多页论文。
const biggest = [...(papers.papers || [])].sort((a, b) => (b.size || 0) - (a.size || 0))[0] || {};
const first = biggest;
const docId = first.docId || null;
const pdfName = first.name || 'attention-is-all-you-need.pdf';

// 拒绝连接使用真实 data/ 的服务；desktop.mjs 会启动专属临时目录。
assertIsolatedDataDir(resolveDataDir(papers.dir));
const postJson = (url, obj) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj),
});
if (docId) await postJson(`${BASE}/api/notes?doc=${encodeURIComponent(docId)}`, { items: [] });
const postConfig = (patch) => postJson(`${BASE}/api/config`, patch);

await postConfig({ baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'sk-e2e-fake-key', idleMs: 60000 });
await postJson(`${BASE}/api/state`, { lastDoc: null, lastName: null, lastUrl: null, docs: {} });

/* ══════════════ 浏览器 ══════════════ */
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1500,950'],
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
const chatRequests = [];
const externalOpens = [];   // /api/open-url 的调用（拦下来记录，别真弹浏览器）

page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('requestfailed', (r) => {
  if (r.failure()?.errorText === 'net::ERR_ABORTED') return;   // 主动 abort（停止 / 超时）是预期的
  failedRequests.push(`${r.url()} :: ${r.failure()?.errorText}`);
});

/* ══════════════ 拦截后端：AI 与文献检索 ══════════════ */
let mockMode = 'sse';   // 'sse' | 'json' | 'hang' | '401' | 'region'
/**
 * 每次 /api/chat 被拦下时，把当时的 mock 模式记下来。
 * 这一条是给「地区限制」那条断言用的：它历史上假红过两次，两次都是**没发出请求**或
 * **读到了别的条目**，而不是产品提示写错了。有这份流水就能一眼看出是哪一种。
 */
const mockLog = [];
const ANSWER = '这是假的流式回复：注意力机制（attention）让模型并行处理序列。\n\n```\nQKV = XW\n```\n\n- 要点一\n- 要点二';
const IMAGE_ANSWER = '【图片区域】这是一个公式：$$E = mc^2$$。\n\n- 含义：质能方程';

await page.setRequestInterception(true);
page.on('request', (req) => {
  const url = req.url();

  if (url.endsWith('/api/chat')) {
    const body = JSON.parse(req.postData() || '{}');
    const last = body.messages?.[body.messages.length - 1];
    const parts = Array.isArray(last?.content) ? last.content : null;
    const hasImage = !!parts && parts.some((c) => c.type === 'image_url');
    const imageCount = parts ? parts.filter((c) => c.type === 'image_url').length : 0;
    const userText = parts ? (parts.find((c) => c.type === 'text')?.text || '') : (last?.content || '');
    chatRequests.push({ model: body.model, stream: body.stream, hasImage, imageCount, userText, sys: body.messages?.[0]?.content?.slice(0, 40) });
    mockLog.push({ mode: mockMode, userText: String(userText).slice(0, 20) });

    if (mockMode === 'hang') return;   // 永不响应，模拟上游卡死
    if (mockMode === '401') {
      return req.respond({
        status: 401,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ error: { message: `Authentication Fails, Your api key: ****8593 is invalid`, type: 'authentication_error' } }),
      });
    }
    if (mockMode === 'region') {
      return req.respond({
        status: 403,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ error: { message: 'This model is not available in your region.' } }),
      });
    }
    if (mockMode === 'json') {
      return req.respond({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ choices: [{ message: { content: `非流式回退成功：${ANSWER.slice(0, 18)}` } }] }),
      });
    }
    const text = hasImage ? IMAGE_ANSWER : ANSWER;
    const chunks = text.match(/[\s\S]{1,18}/g) || [];
    const sse = chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
    return req.respond({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: sse });
  }

  // 外链一律拦下来：不拦的话，测试里点到「打开」会在真实桌面上弹浏览器
  if (url.includes('/api/open-url')) {
    const target = decodeURIComponent(new URL(url).searchParams.get('url') || '');
    externalOpens.push(target);
    return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, url: target }) });
  }

  if (url.includes('/api/ref-search')) {
    return req.respond({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        query: 'q', title: 'Attention Is All You Need',
        results: [
          { source: 'arXiv', title: 'Attention Is All You Need', year: '2017', venue: 'arXiv', url: 'https://arxiv.org/abs/1706.03762', pdfUrl: 'https://arxiv.org/pdf/1706.03762' },
          { source: 'Crossref', title: 'Attention Is All You Need', year: '2017', venue: 'NeurIPS', url: 'https://doi.org/10.5555/3295222', pdfUrl: '' },
        ],
        searchUrl: 'https://example.com/search', scholarUrl: 'https://example.com/scholar',
      }),
    });
  }

  return req.continue();
});

/* ══════════════ 工具 ══════════════ */
const selectSpans = (from = 1, to = 5) => page.evaluate((f, t) => {
  const v = document.getElementById('viewer');
  const vr = v.getBoundingClientRect();
  const pool = [...document.querySelectorAll('.page [class="textLayer"] span:not(.markedContent)')]
    .filter((s) => (s.textContent || '').trim().length > 3 && s.getBoundingClientRect().width > 0.5)
    .filter((s) => { const r = s.getBoundingClientRect(); return r.top > vr.top + 20 && r.bottom < vr.bottom - 20; });
  if (pool.length < t + 1) return { ok: false };
  const range = document.createRange();
  range.setStart(pool[f].firstChild, 0);
  range.setEnd(pool[t].firstChild, pool[t].textContent.length);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.getElementById('viewer').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return { ok: true, text: sel.toString() };
}, from, to);

const clickBubble = async (act) => {
  await page.waitForSelector('#bubble:not(.hidden)', { timeout: 6000 });
  const pt = await page.evaluate((a) => {
    const r = document.querySelector(`#bubble button[data-act="${a}"]`).getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, act);
  await page.mouse.click(pt.x, pt.y);
};

const lastEntry = () => page.evaluate(() => {
  const list = [...document.querySelectorAll('#aiArea .msg')]
    .sort((a, b) => Number(a.dataset.seq || 0) - Number(b.dataset.seq || 0));
  const e = list[list.length - 1];
  if (!e) return null;
  return {
    tag: e.querySelector('.role .tag')?.textContent || '',
    page: e.querySelector('.role .pg')?.textContent || '',
    body: e.querySelector('.text')?.innerText || '',
    acts: [...e.querySelectorAll('.acts button')].map((b) => b.textContent),
  };
});

const loadDoc = async () => {
  await page.goto(`${BASE}/?open=${encodeURIComponent(pdfName)}&topbar=static`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 30000 });
  await sleep(2200);
};

/** 等到没有正在生成的请求（停止按钮隐藏 = 空闲） */
const waitIdle = () => page.waitForFunction(
  () => document.getElementById('stopBtn').classList.contains('hidden'),
  { timeout: 25000 },
).catch(() => {});

/**
 * 强制回到空闲：先点产品自己的停止入口，再等停止按钮隐藏。
 * 与 waitIdle()（只等）的区别在这里**先复位** —— 「上游卡死」那条用例走超时分支后会留下 busy，
 * 不清就发下一条请求会被「上次回答尚未完成」挡回，后续断言读到的是上一条错误文案。
 * （定义必须放在这里：它是 const，下面用到它的地方在文件后半段，放晚了会 TDZ 报错。）
 */
const forceIdle = async () => {
  await page.evaluate(() => { const b = document.getElementById('stopBtn'); if (b) b.click(); });
  try {
    await page.waitForFunction(() => {
      const b = document.getElementById('stopBtn');
      return !b || b.classList.contains('hidden');
    }, { timeout: 12000 });
  } catch { /* 超时也让后面的断言把现场报出来 */ }
  await sleep(400);
};

/* ══════════════ 1. 打开论文 ══════════════ */
console.log('\n▶ 打开论文…');
await loadDoc();
const doc = await page.evaluate(() => ({
  pages: document.querySelectorAll('.page').length,
  docName: document.getElementById('docName').textContent,
  spans: document.querySelectorAll('.page[data-page="1"] .textLayer span:not(.markedContent)').length,
  canvases: document.querySelectorAll('.page canvas').length,
  clientH: document.getElementById('viewer').clientHeight,
  txt: [...document.querySelectorAll('.page[data-page="1"] .textLayer span:not(.markedContent)')].slice(0, 20).map((s) => s.textContent).join(''),
}));
check('PDF 打开成功', doc.pages > 0, `${doc.pages} 页 · ${doc.docName}`);
check('第 1 页已渲染且有文本层', doc.canvases >= 1 && doc.spans > 20, `${doc.canvases} canvas / ${doc.spans} span`);
check('文本层含真实论文文字', /Attention|Transformer|attention/i.test(doc.txt), JSON.stringify(doc.txt.slice(0, 46)));
check('阅读区是固定高度滚动容器', doc.clientH > 300 && doc.clientH < 2000, `clientHeight=${doc.clientH}`);
check('虚拟化生效（不是全部渲染）', doc.canvases < doc.pages, `渲染 ${doc.canvases}/${doc.pages} 页`);

/* ══════════════ 2. AI 分块：可选 / 开关栏在输入框下面 ══════════════ */
const aiInit = await page.evaluate(() => {
  const bar = document.getElementById('aiBar');
  const composer = document.getElementById('composer');
  return {
    empty: !!document.querySelector('#aiArea .ai-empty'),
    buttons: [...bar.querySelectorAll('.aibar-btn')].map((b) => b.textContent.trim()),
    onCount: bar.querySelectorAll('.aibar-btn.on').length,
    barBelow: bar.getBoundingClientRect().top >= composer.getBoundingClientRect().bottom - 1,
    blocks: document.querySelectorAll('.ai-block').length,
  };
});
check('AI 区分块可选：默认一块都不开', aiInit.empty && aiInit.blocks === 0, `空态=${aiInit.empty}`);
check('输入框下面是开关栏，只有译文 / 问答两块', aiInit.buttons.length === 2 && aiInit.onCount === 0, aiInit.buttons.join(' / '));
check('「看图」块已经去掉', !aiInit.buttons.some((b) => /看图/.test(b)), aiInit.buttons.join(' / '));
check('开关栏位置在输入框下方', aiInit.barBelow);

/* 默认模型 */
check('设置里模型输入框的占位也是 deepseek-flash',
  (await page.evaluate(() => {
    document.getElementById('settingsBtn').click();
    return document.getElementById('cfgModel').placeholder;
  })) === 'deepseek-flash');
await page.evaluate(() => document.getElementById('closeSettings').click());
await sleep(200);

await page.evaluate(() => document.querySelectorAll('#aiBar .aibar-btn')[1].click());
await sleep(300);
const opened = await page.evaluate(() => ({
  blocks: [...document.querySelectorAll('.ai-block')].map((b) => b.dataset.block),
  on: document.querySelectorAll('#aiBar .aibar-btn.on').length,
}));
check('点开关能打开块', opened.blocks.length === 1 && opened.on === 1, opened.blocks.join(','));
const hintInfo = await page.evaluate(() => {
  // 空态文案 2026-10-03 起从 `.ai-hint` 换成了 `.ai-empty`（renderCol 重构为「结果会出现在这里 /
  // 从下面这一排图标打开译文 / 问答…」那一组）。
  // 判据是「这个块写清了用途」，不是「此刻必须可见」：`.ai-hint` 在块里**有消息时会被隐藏**
  // （applyPanels 里按条数 toggle），此时可见性为 false 是**正确行为**，旧断言把它当成失败。
  const block = document.querySelector('.ai-block[data-block="chat"]');
  const hint = block?.querySelector('.ai-hint');
  const empty = document.querySelector('#aiArea > .ai-empty');
  const vis = (n) => !!n && !n.classList.contains('hidden') && n.getBoundingClientRect().height > 0;
  if (vis(empty)) return { source: 'ai-empty', text: empty.textContent || '', visible: true, msgs: block ? block.querySelectorAll('.msg').length : 0 };
  return {
    source: 'ai-hint',
    text: hint?.textContent || '',
    visible: vis(hint),
    // 有消息时说明文案被有意隐藏，这同样是「写清了用途」的满足形态
    hiddenByDesign: !!hint && !vis(hint) && !!(block && block.querySelectorAll('.msg').length),
    msgs: block ? block.querySelectorAll('.msg').length : 0,
  };
});
check('块里写清了用途',
  hintInfo.text.length > 8 && (hintInfo.visible || hintInfo.hiddenByDesign),
  `${hintInfo.source}: 可见=${hintInfo.visible} 有消息故隐藏=${!!hintInfo.hiddenByDesign} 消息数=${hintInfo.msgs} · ${JSON.stringify(hintInfo.text.slice(0, 40))}`);
await page.evaluate(() => document.querySelectorAll('#aiBar .aibar-btn')[1].click());
await sleep(300);
check('再点一次能关掉块', (await page.evaluate(() => document.querySelectorAll('.ai-block').length)) === 0);

/* ══════════════ 3. 清晰度（重点） ══════════════ */
console.log('\n▶ 放大清晰度…');
const sharp = () => page.evaluate(() => {
  const c = document.querySelector('.page[data-page="1"] canvas');
  if (!c) return null;
  const w = c.getBoundingClientRect().width;
  return { density: +(c.width / w).toFixed(3), mp: +((c.width * c.height) / 1e6).toFixed(1), zoom: document.getElementById('zoomLabel').textContent };
});
const fit = await sharp();
check('适应宽度下像素密度 ≥ 2（有超采样）', fit && fit.density >= 1.99, JSON.stringify(fit));
await page.evaluate(() => { for (let i = 0; i < 8; i++) document.getElementById('zoomIn').click(); });
await sleep(2500);
const zoomed = await sharp();
check('放大 8 级后像素密度仍 ≥ 2（不糊）', zoomed && zoomed.density >= 1.99, JSON.stringify(zoomed));
check('高倍下限制单页 canvas 面积（走切片）', zoomed && zoomed.mp <= 24, `${zoomed?.mp} MP @ ${zoomed?.zoom}`);

await page.evaluate(() => { document.getElementById('zoomIn').click(); document.getElementById('zoomOut').click(); });
await sleep(200);
await page.click('#fitWidth');
await sleep(2500);
const raceOk = await page.evaluate(() => {
  const vr = document.getElementById('viewer').getBoundingClientRect();
  const vis = [...document.querySelectorAll('.page')].find((p) => { const r = p.getBoundingClientRect(); return r.top < vr.bottom - 100 && r.bottom > vr.top + 100; });
  return { has: !!vis?.querySelector('canvas'), n: document.querySelectorAll('.page canvas').length };
});
check('渲染中缩放不会留下空白页', raceOk.has && raceOk.n > 0, `可见页 canvas=${raceOk.has}`);

/* ══════════════ 4. 缩放滑块 ══════════════ */
console.log('\n▶ 独立的大小调节…');
await page.evaluate(() => {
  const r = document.getElementById('zoomRange');
  r.value = '250';
  r.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(1800);
const slider = await page.evaluate(() => ({ label: document.getElementById('zoomLabel').textContent, scale: Math.round(window.__viewer.scale * 100), max: Number(document.getElementById('zoomRange').max) }));
check('拖动滑块能改 PDF 大小', slider.scale === 250, `label=${slider.label}`);
check('滑块上限够用', slider.max >= 300, `${slider.max}%`);
await page.click('#fitWidth');
await sleep(1500);

/* ══════════════ 5. 划词 + 选区不重叠 ══════════════ */
console.log('\n▶ 划词与选区…');
await selectSpans(1, 5);
await sleep(300);
check('划词后弹出气泡', await page.evaluate(() => !document.getElementById('bubble').classList.contains('hidden')));
const bubbleActs = await page.evaluate(() => [...document.querySelectorAll('#bubble button[data-act]')].map((b) => b.dataset.act));
check('气泡按钮：译 / 释 / ＋对话 / 笔记 / 复制',
  JSON.stringify(bubbleActs) === JSON.stringify(['translate', 'explain', 'add', 'note', 'copy']), bubbleActs.join(' '));
check('「问」按钮已经去掉', !bubbleActs.includes('ask'));

// 每个按钮的文字都不能溢出自己的小方块
const bubbleFit = await page.evaluate(() => {
  const bubble = document.getElementById('bubble');
  const btns = [...bubble.querySelectorAll('button[data-act]')].map((b) => {
    const r = b.getBoundingClientRect();
    return {
      act: b.dataset.act,
      text: b.textContent.trim(),
      w: Math.round(r.width),
      overflowX: b.scrollWidth - b.clientWidth,
      overflowY: b.scrollHeight - b.clientHeight,
    };
  });
  const br = bubble.getBoundingClientRect();
  return {
    btns,
    bubbleW: Math.round(br.width),
    bubbleRight: Math.round(br.right),
    viewportW: window.innerWidth,
    anyOverflow: btns.some((b) => b.overflowX > 1 || b.overflowY > 1),
    tooNarrow: btns.filter((b) => b.w < 26),
  };
});
check('气泡里每个按钮都不溢出', !bubbleFit.anyOverflow && bubbleFit.tooNarrow.length === 0,
  bubbleFit.btns.map((b) => `${b.text}:${b.w}px`).join(' '));
check('气泡整体没超出右边界', bubbleFit.bubbleRight <= bubbleFit.viewportW,
  `右边缘 ${bubbleFit.bubbleRight} / 视口 ${bubbleFit.viewportW}`);

const selMarks = await page.evaluate(() => {
  const marks = [...document.querySelectorAll('.sel-mark')].map((m) => {
    const r = m.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  }).sort((a, b) => a.top - b.top);
  let overlaps = 0;
  for (let i = 1; i < marks.length; i++) {
    const a = marks[i - 1];
    const b = marks[i];
    const hx = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    if (hx > 0.5 && a.bottom - b.top > 0.5) overlaps++;
  }
  return { n: marks.length, overlaps };
});
check('选中的文字被画成方块', selMarks.n > 0, `${selMarks.n} 块`);
check('选区方块上下不重叠', selMarks.overlaps === 0, `重叠 ${selMarks.overlaps} 对`);

await page.evaluate(() => window.getSelection().removeAllRanges());
const dragTarget = await page.evaluate(() => {
  const vr = document.getElementById('viewer').getBoundingClientRect();
  const s = [...document.querySelectorAll('.page [class="textLayer"] span:not(.markedContent)')]
    .find((n) => (n.textContent || '').trim().length > 24 && n.getBoundingClientRect().width > 120
      && n.getBoundingClientRect().top > vr.top + 30 && n.getBoundingClientRect().bottom < vr.bottom - 30);
  const r = s.getBoundingClientRect();
  return { text: s.textContent, left: r.left, top: r.top, w: r.width, h: r.height };
});
await page.mouse.move(dragTarget.left + 3, dragTarget.top + dragTarget.h / 2);
await page.mouse.down();
await page.mouse.move(dragTarget.left + dragTarget.w * 0.35, dragTarget.top + dragTarget.h / 2, { steps: 10 });
await page.mouse.up();
await sleep(400);
const dragged = await page.evaluate(() => window.getSelection().toString());
const dragError = Math.abs(dragged.length - dragTarget.text.length * 0.35);
check('鼠标拖选命中精度正常（误差不超过 5%）',
  dragError <= Math.max(2, dragTarget.text.length * 0.05),
  `选中 ${dragged.length}/${dragTarget.text.length} 字符（期望约 ${Math.round(dragTarget.text.length * 0.35)}）`);

/* ══════════════ 6. 译 ══════════════ */
console.log('\n▶ 译…');
await selectSpans(1, 5);
await sleep(250);
await clickBubble('translate');
await page.waitForFunction(() => document.querySelector('#translationCardText')?.innerText.includes('注意力机制'), { timeout: 15000 });
const transShown = await page.evaluate(() => {
  return {
    card: !document.querySelector('#translationCard').classList.contains('hidden'),
    text: document.querySelector('#translationCardText').innerText,
    rightWidth: document.querySelector('#rightCols').getBoundingClientRect().width,
    saved: window.__state.sessionEntries.some((x) => x.block === 'translate' && x.text.includes('注意力机制')),
  };
});
check('右栏关闭时译文显示在卡片中，PDF 不让宽，结果仍保存',
  transShown.card && transShown.text.includes('注意力机制') && transShown.rightWidth === 0 && transShown.saved,
  JSON.stringify(transShown));
await page.click('#topbarRightToggle');
await page.waitForFunction(() => document.querySelector('#rightCols').getBoundingClientRect().width > 200);
await page.click('#aiBar .aibar-btn[data-block="translate"]');
await page.waitForFunction(() => document.querySelector('#aiArea .msg .text')?.innerText.includes('注意力机制'));
const tEntry = await lastEntry();
/**
 * 类型标签是**内部标记**：public/style.css 里 `.msg .tag { display: none; }`，
 * 用户看不到它。写入的词法是 translation / explanation / answer（论文操作写的是中文 op.title）。
 * 页码在结果区是「第N页」；`p.N` 只出现在左栏文献关系、搜索结果和笔记里。
 * 旧断言按 `/译/` + `/p\.\d/` 写，是在标签可见、页码统一成 p.N 的旧构建下成立的，
 * 现在必然失败。这里改成与当前实现一致；「标签要不要显示」「页码词法要不要统一」
 * 留给后续视觉/排版阶段决定，不在基线阶段改产品行为。
 */
check('打开右栏后仍能在「译文」块找到结果（带页码）', tEntry.tag === 'translation' && /^第\d+页$/.test(tEntry.page), `${tEntry.tag} ${tEntry.page}`);
check('动作条里没有多余的 null', !tEntry.acts.some((a) => a === 'null'), tEntry.acts.join('/'));
check('译文块按需打开', (await page.evaluate(() => [...document.querySelectorAll('#aiArea .ai-block')].map((b) => b.dataset.block))).includes('translate'));

/* ══════════════ 7. 释（只在右栏） ══════════════ */
console.log('\n▶ 释…');
await selectSpans(2, 6);
await sleep(250);
const beforeExplain = chatRequests.length;
await clickBubble('explain');
await page.waitForFunction(() => [...document.querySelectorAll('#aiArea .msg .text')].some((x) => x.innerText.includes('注意力机制')), { timeout: 15000 });
await sleep(500);
const explainEntry = await lastEntry();
check('「释」不需要输入就直接出结果', explainEntry.tag === 'explanation' && explainEntry.body.includes('注意力机制'), `tag=${explainEntry.tag}`);
check('「释」只在右栏出结果（就地浮层已删除）',
  await page.evaluate(() => !document.getElementById('popover')
    && document.querySelectorAll('#aiArea .msg.assistant').length > 0));
check('「释」确实发了一次请求', chatRequests.length === beforeExplain + 1, `${chatRequests.length - beforeExplain} 次`);
check('「释」用的是解释提示词', /讲明白/.test(chatRequests[chatRequests.length - 1].sys || ''));

/* ══════════════ 8. ＋对话：可加多个 ══════════════ */
console.log('\n▶ ＋对话（可加多段）…');
const beforeAdd = chatRequests.length;
await selectSpans(3, 6);
await sleep(250);
await clickBubble('add');
await sleep(400);
await selectSpans(7, 9);
await sleep(250);
await clickBubble('add');
await sleep(500);
const atts = await page.evaluate(() => ({
  n: document.querySelectorAll('#attachRow .attach').length,
  kinds: [...document.querySelectorAll('#attachRow .attach')].map((a) => (a.classList.contains('image') ? 'image' : 'text')),
  visible: !document.getElementById('attachRow').classList.contains('hidden'),
  focused: document.activeElement?.id,
  texts: [...document.querySelectorAll('#attachRow .at-text')].map((t) => t.textContent.slice(0, 16)),
}));
check('「＋对话」不会自动发请求', chatRequests.length === beforeAdd, `${chatRequests.length - beforeAdd} 次新请求`);
check('可以连续加多段内容', atts.n === 2 && atts.kinds.every((k) => k === 'text'), `${atts.n} 项：${atts.texts.join(' | ')}`);
check('加完光标落在输入框', atts.focused === 'chatInput', atts.focused);

await page.type('#chatInput', '这两段有什么关系？');
await page.keyboard.press('Enter');
await page.waitForFunction(() => [...document.querySelectorAll('#aiArea .msg .text')].some((x) => x.innerText.includes('注意力机制')), { timeout: 15000 });
await sleep(600);
const qa = await lastEntry();
const qaReq = chatRequests[chatRequests.length - 1];
check('带着多段引用提问能拿到回答', qa.tag === 'answer' && qa.body.includes('注意力机制'), `tag=${qa.tag}`);
check('请求里带上了引用原文和我的问题', /选中文本/.test(qaReq.userText) && qaReq.userText.includes('这两段有什么关系'), JSON.stringify(qaReq.userText.slice(0, 56)));
check('发送后附件条已清空', (await page.evaluate(() => document.querySelectorAll('#attachRow .attach').length)) === 0);

/* ══════════════ 9. 截图 / 长截图 → 图片附件 ══════════════ */
console.log('\n▶ 截图与长截图…');

// 输入框边上的 ✂ 也要能进截图模式（曾经这里绑了一个不存在的函数）
await page.click('#clipBtn');
await sleep(300);
check('✂ 按钮能进入截图模式', await page.evaluate(() => !document.getElementById('regionOverlay').classList.contains('hidden')));
check('✂ 按钮进入时也有高亮状态', await page.evaluate(() => document.getElementById('clipBtn').classList.contains('on')));
await page.keyboard.press('Escape');
await sleep(300);
check('Esc 能退出截图模式', await page.evaluate(() => document.getElementById('regionOverlay').classList.contains('hidden')));

await page.click('#regionBtn');
await sleep(250);
const box = await page.evaluate(() => {
  const vr = document.getElementById('viewer').getBoundingClientRect();
  for (const p of document.querySelectorAll('.page')) {
    const r = p.getBoundingClientRect();
    if (r.top < vr.bottom - 150 && r.bottom > vr.top + 150) return { x: r.left + 60, y: Math.max(r.top, vr.top) + 120 };
  }
  return null;
});
check('框选遮罩已激活', await page.evaluate(() => !document.getElementById('regionOverlay').classList.contains('hidden')));
await page.mouse.move(box.x, box.y);
await page.mouse.down();
await page.mouse.move(box.x + 300, box.y + 180, { steps: 8 });
await page.mouse.up();
await page.waitForFunction(() => document.querySelectorAll('#attachRow .attach.image').length > 0, { timeout: 20000 });
await sleep(400);
const shot = await page.evaluate(() => {
  const im = document.querySelector('#attachRow .attach.image img');
  return { w: im?.naturalWidth || 0, h: im?.naturalHeight || 0, label: document.querySelector('#attachRow .attach.image .at-text')?.textContent || '' };
});
check('框选截图变成了对话附件', shot.w > 50 && shot.h > 50, `${shot.w}×${shot.h} · ${shot.label}`);
check('截图不会自动发请求（由你自己提问）', chatRequests.filter((r) => r.hasImage).length === 0);

// 没配 API Key 时截图也必须能用 —— 截图本身不需要密钥
await page.evaluate(() => { window.__settings.data.hasApiKey = false; window.__settings.data.apiKey = ''; });
const beforeNoKey = await page.evaluate(() => document.querySelectorAll('#attachRow .attach.image').length);
await page.click('#regionBtn');
await sleep(250);
const nkBox = await page.evaluate(() => {
  const vr = document.getElementById('viewer').getBoundingClientRect();
  return { x: Math.round(vr.left + 80), y: Math.round(vr.top) + 140 };
});
await page.mouse.move(nkBox.x, nkBox.y);
await page.mouse.down();
await page.mouse.move(nkBox.x + 260, nkBox.y + 140, { steps: 8 });
await page.mouse.up();
await sleep(2500);
const noKey = await page.evaluate(() => ({
  n: document.querySelectorAll('#attachRow .attach.image').length,
  settingsOpen: !document.getElementById('settingsModal').classList.contains('hidden'),
}));
check('没配 API Key 时截图照样能用（不弹设置框）',
  noKey.n > beforeNoKey && !noKey.settingsOpen,
  `附件 ${beforeNoKey} → ${noKey.n}，设置框弹出=${noKey.settingsOpen}`);
await page.evaluate(() => { window.__settings.data.hasApiKey = true; window.__settings.data.apiKey = 'sk-e2e-fake-key'; });
await page.evaluate(() => document.getElementById('attachRow').querySelectorAll('.at-x').forEach((b) => b.click()));
await sleep(300);

const startPt = await page.evaluate(() => {
  const vr = document.getElementById('viewer').getBoundingClientRect();
  return { x: Math.round(vr.left + 120), y: Math.round(vr.top + 160), bottom: Math.round(vr.bottom - 6) };
});
const beforeLong = await page.evaluate(() => document.querySelectorAll('#attachRow .attach.image').length);
await page.click('#regionBtn');
await sleep(200);
await page.mouse.move(startPt.x, startPt.y);
await page.mouse.down();
await page.mouse.move(startPt.x + 320, startPt.bottom, { steps: 8 });
await sleep(1600);                       // 让它自动滚动
await page.mouse.up();
await page.waitForFunction((b) => document.querySelectorAll('#attachRow .attach.image').length > b, { timeout: 25000 }, beforeLong);
await sleep(600);
const longShot = await page.evaluate(() => {
  const imgs = [...document.querySelectorAll('#attachRow .attach.image')];
  const last = imgs[imgs.length - 1];
  return { n: imgs.length, h: last?.querySelector('img')?.naturalHeight || 0, label: last?.querySelector('.at-text')?.textContent || '' };
});
check('拖出视口会自动滚动并生成跨页长截图',
  longShot.n > beforeLong && longShot.h > 700 && /长截图/.test(longShot.label),
  `${longShot.n - beforeLong} 张新图，长图 ${longShot.h}px，${longShot.label}`);

await page.type('#chatInput', '这块图讲的是什么？');
await page.keyboard.press('Enter');
// 注意：$$E = mc^2$$ 现在会被 KaTeX 渲染成真公式，文本内容变成「E=mc²」（空格被吃掉、
// 上标变成 <sup>），所以不能再按 'E = mc' 这种字面文本去找。
await page.waitForFunction(() => [...document.querySelectorAll('#aiArea .msg .text')]
  .some((x) => x.querySelector('.katex') || /mc/.test(x.innerText)), { timeout: 20000 });
await sleep(500);
const imgReq = chatRequests[chatRequests.length - 1];
check('图片作为多模态内容发给模型', imgReq.hasImage && imgReq.imageCount >= 1, `${imgReq.imageCount} 张图`);
check('带图提问的回复已渲染（公式渲染成了 KaTeX）', await page.evaluate(() => {
  const nodes = [...document.querySelectorAll('#aiArea .msg .text')];
  const last = nodes[nodes.length - 1];
  return !!last && (last.querySelectorAll('.katex').length > 0 || /mc/.test(last.innerText));
}));
check('助手消息里显示了截图缩略图', (await page.evaluate(() => document.querySelectorAll('#aiArea .msg .shot-img').length)) > 0);

/* ══════════════ 10. 修饰键 ══════════════ */
console.log('\n▶ 修饰键…');
await selectSpans(1, 4);
await sleep(250);
const beforeCtrl = chatRequests.length;
await page.keyboard.down('Control');
await page.keyboard.press('KeyA');
await page.keyboard.up('Control');
await sleep(900);
check('Ctrl+A 不会误发 AI 请求', chatRequests.length === beforeCtrl, `${chatRequests.length - beforeCtrl} 次`);
await page.keyboard.down('Control');
await page.keyboard.press('KeyR');
await page.keyboard.up('Control');
await sleep(400);
check('Ctrl+R 不会打开框选遮罩', await page.evaluate(() => document.getElementById('regionOverlay').classList.contains('hidden')));

/* ══════════════ 11. 非流式上游回退 ══════════════ */
console.log('\n▶ 非流式回退…');
mockMode = 'json';
await selectSpans(11, 13);
await sleep(250);
await clickBubble('translate');
await page.waitForFunction(() => [...document.querySelectorAll('#aiArea .msg .text')].some((x) => x.innerText.includes('非流式回退成功')), { timeout: 15000 }).catch(() => {});
check('上游回普通 JSON 也能出结果', /非流式回退成功/.test((await lastEntry()).body));
mockMode = 'sse';
await sleep(200);

/* ══════════════ 12. 正文引用 → 参考文献 ══════════════ */
console.log('\n▶ 正文引用跳转…');
const citeInfo = await page.evaluate(async () => {
  const v = window.__viewer;
  const { hits } = await v.search('[1]');
  if (!hits.length) return { ok: false };
  await v.goToPage(hits[0].page);
  await new Promise((r) => setTimeout(r, 1500));
  const vr = document.getElementById('viewer').getBoundingClientRect();
  const links = [...document.querySelectorAll('.cite-link')].filter((l) => {
    const r = l.getBoundingClientRect();
    return r.width > 4 && r.height > 4 && r.left >= vr.left && r.right <= vr.right && r.top >= vr.top + 30 && r.bottom <= vr.bottom - 30;
  });
  const r0 = links[0] ? links[0].getBoundingClientRect() : null;
  return {
    ok: true,
    total: document.querySelectorAll('.cite-link').length,
    visible: links.length,
    pt: r0 ? { x: Math.round(r0.x + r0.width / 2), y: Math.round(r0.y + r0.height / 2) } : null,
    origin: v.capturePosition(),
  };
});
check('正文里的 [n] 被标成可点', citeInfo.ok && citeInfo.total > 0, `本页 ${citeInfo.total} 处，可见 ${citeInfo.visible} 处`);
if (citeInfo.pt) {
  await page.mouse.click(citeInfo.pt.x, citeInfo.pt.y);
  await sleep(1600);
  const cb = await page.evaluate(() => ({
    open: !document.getElementById('citeBox').classList.contains('hidden'),
    title: document.getElementById('citeTitle').textContent,
    text: document.getElementById('citeText').textContent,
    page: document.getElementById('pageInput').value,
    // 2026-10-03 图标统一之后，这个按钮的可见文字只剩「返回原位置」——
    // 原来的 ↶ 换成了 24×24 线性 SVG（写在按钮里的 <svg> 内联，textContent 不再包含它）。
    // 所以断言改成：可见文字正确 + 图标确实是一个 SVG（两者都要，不能只留一半）。
    returnLabel: document.getElementById('citeReturn')?.textContent.trim() || '',
    returnIcon: (() => {
      const n = document.getElementById('citeReturn')?.querySelector('svg');
      if (!n) return null;
      return { viewBox: n.getAttribute('viewBox'), stroke: getComputedStyle(n).strokeWidth };
    })(),
    titleColor: getComputedStyle(document.getElementById('citeText')).color,
    titleWeight: getComputedStyle(document.getElementById('citeText')).fontWeight,
  }));
  check('点 [n] 会跳到文末那条参考文献', cb.open && cb.text.length > 30 && /(19|20)\d{2}/.test(cb.text), `${cb.title} → 第 ${cb.page} 页`);
  check('引用卡片里的论文名清楚可见', Number(cb.titleWeight) >= 500 && cb.titleColor !== 'rgb(153, 158, 168)',
    `color=${cb.titleColor} weight=${cb.titleWeight}`);
  await page.click('#citeSearch');
  await page.waitForFunction(() => document.querySelectorAll('#citeResult .cite-item').length > 0, { timeout: 10000 }).catch(() => {});
  await sleep(400);
  const found = await page.evaluate(() => {
    const it = document.querySelector('#citeResult .cite-item');
    return {
      n: document.querySelectorAll('#citeResult .cite-item').length,
      href: it?.querySelector('.ci-acts a')?.getAttribute('href') || '',
      pdf: !!it?.querySelector('.ci-badge.pdf'),
      copy: !!it?.querySelector('.ci-acts button'),
      title: it?.querySelector('.ci-title')?.textContent || '',
      import: !!it?.querySelector('.ci-acts button.import'),
    };
  });
  check('「找这篇的 PDF」能给出网址', found.n > 0 && /^https?:/.test(found.href), `${found.n} 条 · ${found.href}`);
  check('标出了 PDF 直链并给了复制按钮', found.pdf && found.copy);
  check('搜索结果只提供链接，不提供直接导入', found.title.length > 0 && !found.import);
  await page.click('#citeReturn');
  await sleep(300);
  const returned = await page.evaluate(() => ({
    open: !document.getElementById('citeBox').classList.contains('hidden'),
    position: window.__viewer.capturePosition(),
    returnButtonVisible: !document.getElementById('returnPosition').classList.contains('hidden'),
  }));
  const exactReturn = Math.abs(returned.position.scrollTop - citeInfo.origin.scrollTop) < 3
    && Math.abs(returned.position.scale - citeInfo.origin.scale) < 0.002;
  check('参考文献卡片提供「返回原位置」并收起卡片',
    cb.returnLabel === '返回原位置' && cb.returnIcon?.viewBox === '0 0 24 24' && !returned.open,
    `label="${cb.returnLabel}" icon=${JSON.stringify(cb.returnIcon)}`);
  check('点击后恢复正文滚动位置和缩放', exactReturn,
    `滚动 ${Math.round(citeInfo.origin.scrollTop)} → ${Math.round(returned.position.scrollTop)} · 缩放 ${Math.round(citeInfo.origin.scale * 100)}% → ${Math.round(returned.position.scale * 100)}%`);
  check('已返回后不再显示返回位置入口', !returned.returnButtonVisible);
}

/* ══════════════ 13. 搜索 ══════════════ */
console.log('\n▶ 全文搜索…');
await page.click('#searchBtn');
await page.type('#searchInput', 'attention');
await sleep(2600);
const sc = await page.evaluate(() => document.getElementById('searchCount').textContent);
check('全文搜索显示命中数量和当前页', /^\d+\/\d+ 条 · p\.\d+$/.test(sc), sc);
const hitP = await page.evaluate(() => {
  const hits = [...document.querySelectorAll('.page .search-hit')];
  const pw = hits[0]?.closest('.page')?.getBoundingClientRect().width || 1;
  const maxW = Math.max(...hits.map((h) => h.getBoundingClientRect().width), 0);
  return { n: hits.length, ratio: maxW / pw };
});
check('搜索命中已高亮', hitP.n > 0, `${hitP.n} 块`);
check('只标命中的词，不是整行变黄', hitP.ratio < 0.25, `最宽 ${(hitP.ratio * 100).toFixed(0)}% 页宽`);
await page.evaluate(() => document.getElementById('searchClose').click());
await sleep(300);

/* ══════════════ 14. 翻页 ══════════════ */
console.log('\n▶ 翻页…');
await page.evaluate(() => { document.getElementById('pageInput').value = '3'; document.getElementById('pageInput').dispatchEvent(new Event('change')); });
await sleep(1500);
const jump = await page.evaluate(() => {
  const vr = document.getElementById('viewer').getBoundingClientRect();
  const r = document.querySelector('.page[data-page="3"]').getBoundingClientRect();
  return { page: document.getElementById('pageInput').value, top: Math.round(r.top - vr.top), visible: r.top < vr.bottom && r.bottom > vr.top };
});
check('跳页真的滚过去了', jump.page === '3' && jump.visible && Math.abs(jump.top) < 220, `p3 距顶 ${jump.top}px`);

/* ══════════════ 15. 笔记 ══════════════ */
console.log('\n▶ 笔记…');
await selectSpans(1, 3);
await sleep(250);
await clickBubble('note');
await sleep(700);
const editor = await page.evaluate(() => ({
  open: !document.getElementById('noteBox').classList.contains('hidden'),
  quote: document.getElementById('noteQuote').textContent.slice(0, 24),
  focused: document.activeElement?.id,
}));
check('点「✎」弹出笔记编辑框（能自己写字）', editor.open && editor.quote.length > 5, `引用="${editor.quote}"`);

const NOTE = '这一段是全文的出发点，后面所有实验都要回来看它。';
await page.evaluate((v) => { document.getElementById('noteText').value = v; }, NOTE);
await page.click('#noteSave');
await sleep(900);
const noted = await page.evaluate(() => ({
  items: document.querySelectorAll('#notesList li:not(.empty)').length,
  marks: document.querySelectorAll('.hl-mark').length,
  pins: document.querySelectorAll('.hl-pin').length,
  pinsWithNote: document.querySelectorAll('.hl-pin.has-note').length,
  listNote: document.querySelector('#notesList li .nnote')?.textContent || '',
}));
check('笔记已保存并出现在列表', noted.items === 1 && noted.listNote.includes('出发点'), `${noted.items} 条`);
check('笔记不再画黄色高亮块', noted.marks === 0, `${noted.marks} 块高亮`);
check('正文右边缘出现了可点的小书签', noted.pins === 1 && noted.pinsWithNote === 1, `标记 ${noted.pins} 个`);

const pinPt = await page.evaluate(() => {
  const n = document.querySelector('.hl-pin');
  const r = n.getBoundingClientRect();
  const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
  const hit = document.elementFromPoint(cx, cy);
  const viewer = document.getElementById('viewer').getBoundingClientRect();
  return {
    x: cx, y: cy,
    // 现场取证：书签的几何位置 vs 阅读区真正可见的右边界，以及这个坐标上实际是谁
    pinX: Math.round(r.x), viewerRight: Math.round(viewer.right),
    hit: hit ? `${hit.tagName}.${hit.className}` : '(无)',
    hitIsPin: !!(hit && hit.closest && hit.closest('.hl-pin')),
  };
});
await page.mouse.click(pinPt.x, pinPt.y);
await sleep(500);
const reopened = await page.evaluate(() => ({
  open: !document.getElementById('noteBox').classList.contains('hidden'),
  text: document.getElementById('noteText').value,
}));
/**
 * ⚠️ 2026-10 实测**真缺陷**（不是断言过期，别删这条）：
 *   右栏开着时 `.hl-pin` 的坐标落在阅读区可见范围之外 ——
 *   实测 viewer=[215,1135]、`.page` 右边界 1282、书签 rect.x=1272（中心 x=1275），
 *   于是 `elementFromPoint(1275,216)` 命中的是右栏里的 `.ai-body`，真实鼠标点不到书签。
 *   节点本身是活的（`document.querySelector('.hl-pin').click()` 能正常打开笔记框），
 *   所以问题在**书签定位 / 裁剪**，不在事件绑定。
 *   书签贴近纸面右边缘、而纸面比阅读区宽（开了右栏或放大后横向溢出）时必然复现。
 */
check('点文中书签能重新打开这条笔记', reopened.open && reopened.text.includes('出发点'),
  `书签中心 x=${pinPt.x} · 阅读区右边界=${pinPt.viewerRight} · 命中=${pinPt.hit}（是书签=${pinPt.hitIsPin}）· 笔记框=${reopened.open}`);

/**
 * 书签点不开时 `#noteBox` 是关着的，此时直接 `page.click('#noteSave')` 会抛
 * 「Node is either not clickable or not an Element」，把后面整段（修改 / 刷新持久化 /
 * 目录 / 外观 …）全部带走。这里兜一层：真失败上一条已经报过了，
 * 这一层只保证套件能继续跑完，并把级联失败也如实记下来。
 */
if (await page.evaluate(() => !document.getElementById('noteBox').classList.contains('hidden'))) {
  await page.evaluate(() => { document.getElementById('noteText').value = '改过的笔记内容'; });
  await page.click('#noteSave');
  await sleep(800);
  check('笔记可以修改', (await page.evaluate(() => document.querySelector('#notesList li .nnote')?.textContent || '')) === '改过的笔记内容');
} else {
  check('笔记可以修改', false, '前置失败：书签没把笔记框点开，改不了（见上一条的现场取证）');
}

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 30000 });
await sleep(2000);
const persisted = await page.evaluate(() => ({
  items: document.querySelectorAll('#notesList li:not(.empty)').length,
  pins: document.querySelectorAll('.hl-pin').length,
  note: document.querySelector('#notesList li .nnote')?.textContent || '',
}));
check('刷新后笔记和文中书签都在', persisted.items === 1 && persisted.pins >= 1 && persisted.note === '改过的笔记内容', `${persisted.items} 条 / ${persisted.pins} 标记`);

/* ══════════════ 16. 目录 ══════════════ */
const outline = await page.evaluate(() => document.querySelectorAll('#outlineList li:not(.empty)').length);
check('目录已解析', outline > 0, `${outline} 项`);
const oLook = await page.evaluate(() => {
  const list = document.getElementById('outlineList');
  const items = [...list.querySelectorAll('li:not(.empty)')];
  const sec = list.closest('.sec');
  const lv1 = items.find((li) => li.classList.contains('lv1'));
  const lv2 = items.find((li) => li.classList.contains('lv2'));
  return {
    sizes: [...new Set(items.slice(0, 12).map((li) => getComputedStyle(li).fontSize))],
    maxH: getComputedStyle(sec).maxHeight,
    overflow: getComputedStyle(list).overflowY,
    // 判据要的是「这一块没有把目录关进一个小滚动框里」：
    // 只看 overflowY 会把 `overflow:auto` 但**根本不需要滚动**（scrollH == clientH）的情况误判成失败，
    // 所以同时量一下它到底有没有被裁掉内容。
    listClientH: list.clientHeight,
    listScrollH: list.scrollHeight,
    panel: getComputedStyle(document.getElementById('leftSide')).overflowY,
    indented: lv1 && lv2 ? parseFloat(getComputedStyle(lv2).paddingLeft) > parseFloat(getComputedStyle(lv1).paddingLeft) : null,
  };
});
check('目录字号统一（不做大小标题）', oLook.sizes.length === 1, oLook.sizes.join('/'));
check('目录不再被限制在小区域里',
  oLook.maxH === 'none' && oLook.overflow !== 'hidden' && oLook.overflow !== 'scroll'
    && oLook.listScrollH - oLook.listClientH <= 4,
  `max-height=${oLook.maxH} overflowY=${oLook.overflow} client=${oLook.listClientH} scroll=${oLook.listScrollH}`);
check('左栏整体滚动', oLook.panel === 'auto');
check('层级靠缩进体现', oLook.indented === true);

/* ══════════════ 17. 设置 ══════════════ */
console.log('\n▶ 设置…');
await page.click('#settingsBtn');
await page.waitForSelector('#settingsModal:not(.hidden)', { timeout: 6000 });
await sleep(200);
const ui = await page.evaluate(() => {
  const modal = document.getElementById('settingsModal');
  const fields = [...modal.querySelectorAll('.field')];
  return {
    open: !modal.classList.contains('hidden'),
    // select 也要取到 id：主题是 <select>，只读 input 会得到 undefined
    visible: fields.filter((f) => !f.classList.contains('hidden')).map((f) => f.querySelector('input, select')?.id),
    coreVisible: [...modal.querySelectorAll('.settings-core-grid .field')]
      .filter((f) => getComputedStyle(f).display !== 'none' && f.getBoundingClientRect().height > 0)
      .map((f) => f.querySelector('input, select')?.id),
    removedPresent: ['advancedStyles', 'uiDensity', 'uiTopbar', 'uiUiFontSize', 'uiControlSize', 'uiLineHeight',
      'uiCodeSize', 'uiMaxWidth', 'uiOpacity', 'uiPaper', 'uiShowPage', 'uiShowQuote', 'uiShowSources']
      .filter((id) => document.getElementById(id)),
    resets: ['resetLayout', 'resetStyle', 'resetSettings'].filter((id) => document.getElementById(id)),
    topbar: [...document.querySelectorAll('.topbar button, .topbar input')].map((n) => n.id),
    tabs: document.querySelectorAll('.tabs').length,
    quickRow: document.querySelectorAll('#quickRow').length,
    glossary: document.querySelectorAll('#cfgGlossary').length,
  };
});
/**
 * 2026-10 删减：设置弹窗从「核心三项 + 更多样式折叠」收成固定的六项 ——
 * API Key / 模型名 / 接口地址 / 主题 / 阅读字号 / 恢复默认设置。
 * 「结果密度」「顶栏行为」和「更多样式」里那批调试刻度（界面字号 / 控件大小 / 行高 /
 * 代码大小 / 最大宽度 / 结果透明度 / PDF 纸张 / 三个显示开关）全部下架，
 * 两个 reset 按钮并成一个 `#resetSettings`。
 * 所以判据改成：留下的两项可见且**真的还能用**、下架的确实不在、恢复默认只剩一个入口。
 * 存档里的老字段仍然生效（DEFAULT_UI_STYLE 没删），只是没有界面入口了。
 */
check('设置是弹窗：AI 字段与主题 / 阅读字号核心项可见',
  ui.open && ui.visible.includes('cfgApiKey') && ui.visible.includes('cfgModel')
    && ui.coreVisible.join() === 'uiTheme,uiFontSize',
  `核心=${ui.coreVisible.join(', ')} · 可见=${ui.visible.join(', ')}`);
check('下架的低频样式控件确实都不在', ui.removedPresent.length === 0, ui.removedPresent.join(', '));
check('恢复默认只剩一个入口（#resetSettings）', ui.resets.join() === 'resetSettings', ui.resets.join(', '));
check('旧版非核心控件已移除', ui.tabs === 0 && ui.quickRow === 0 && ui.glossary === 0);

// 主题：改一下必须立刻落到 documentElement[data-theme]（'跟随系统' = 删掉该属性）
const themeApplied = await page.evaluate(() => {
  const sel = document.getElementById('uiTheme');
  const before = document.documentElement.dataset.theme || '(跟随系统)';
  sel.value = 'dark'; sel.dispatchEvent(new Event('input', { bubbles: true }));
  const after = document.documentElement.dataset.theme || '(跟随系统)';
  sel.value = 'light'; sel.dispatchEvent(new Event('input', { bubbles: true }));
  const back = document.documentElement.dataset.theme || '(跟随系统)';
  return { before, after, back };
});
check('设置里改主题立刻生效（跟随系统 → dark → light）',
  themeApplied.before !== 'dark' && themeApplied.after === 'dark' && themeApplied.back === 'light',
  JSON.stringify(themeApplied));
// 阅读字号：改一下必须立刻写进 --ai-fs（结果正文用的就是它）
const fontSizeApplied = await page.evaluate(() => {
  const el = document.getElementById('uiFontSize');
  const before = getComputedStyle(document.documentElement).getPropertyValue('--ai-fs').trim();
  const next = Number(el.value) >= Number(el.max) ? Number(el.max) - 1 : Number(el.value) + 1;
  el.value = String(next); el.dispatchEvent(new Event('input', { bubbles: true }));
  return {
    before,
    after: getComputedStyle(document.documentElement).getPropertyValue('--ai-fs').trim(),
    label: document.getElementById('uiFontSizeValue')?.textContent || '',
    value: el.value,
  };
});
check('设置里改阅读字号立刻生效（--ai-fs 跟着变，右侧数值同步）',
  fontSizeApplied.before !== fontSizeApplied.after && fontSizeApplied.label === `${fontSizeApplied.value}px`,
  JSON.stringify(fontSizeApplied));
// 恢复默认设置：真实点一下，确认它把主题与字号拨回默认（只动壳，不碰论文/会话/Key）
const resetApplied = await page.evaluate(() => {
  document.getElementById('resetSettings').click();
  return {
    select: document.getElementById('uiTheme').value,
    range: document.getElementById('uiFontSize').value,
    theme: document.documentElement.dataset.theme || '(跟随系统)',
    fs: getComputedStyle(document.documentElement).getPropertyValue('--ai-fs').trim(),
  };
});
check('「恢复默认设置」一个按钮把主题与阅读字号拨回默认',
  resetApplied.select === 'system' && resetApplied.theme === '(跟随系统)' && !!resetApplied.range,
  JSON.stringify(resetApplied));
/**
 * 顶栏白名单：这份清单是**故意收窄**的 —— 顶栏只放用户高频、且一次点击能说清用途的控件。
 * R8 曾加入 `scanBtn`（扫描版 OCR），后按用户要求整体删除该功能。
 * 2026-10 删减又把 `panelBtn`（面板管理器入口）连同整个面板管理器一起删掉了：
 * 「打开译文 / 问答」现在只剩右栏底部那排分段切换器（`#aiBar`）一个入口。
 * 2026-10-04 顶栏又按用户口径（「完全模仿 VS Code」）变成**应用内标题栏**，
 * 于是**故意**多了左右活动栏开关（topbarLeftToggle / topbarRightToggle）与
 * 窗口按钮（windowMinimize / windowMaximize / windowClose）—— 这五个是新增的正当成员。
 * 2026-10 首页改造再加 `homeBtn`（回首页 / 书架）：启动默认停在首页之后，阅读态必须
 * 有**一个**明确的回头入口，否则用户只能靠刷新回书架。它是正当成员，
 * 不是「删掉的入口又回来了」——白名单里也仍然禁止 panelBtn / scanBtn 那些。
 */
const topbarCore = new Set(['prevPage', 'pageInput', 'nextPage', 'returnPosition', 'zoomOut', 'zoomRange', 'zoomIn', 'fitWidth', 'homeBtn', 'opsBtn', 'regionBtn', 'searchBtn', 'settingsBtn',
  'topbarLeftToggle', 'topbarRightToggle', 'windowMinimize', 'windowMaximize', 'windowClose']);
check('顶栏只剩核心控件 + 标题栏按钮，且删掉的入口没有回来',
  ui.topbar.includes('returnPosition')
    && ui.topbar.every((id) => topbarCore.has(id))
    && !ui.topbar.some((id) => ['scanBtn', 'panelBtn', 'exportBtn', 'dockBtn'].includes(id)),
  ui.topbar.join(' '));
await page.evaluate(() => { document.getElementById('cfgModel').value = 'deepseek-chat'; });
await page.click('#saveSettings');
await page.waitForFunction(() => /✅|❌/.test(document.getElementById('testResult').textContent || ''), { timeout: 20000 });
check('保存并测试连接可用', /✅|❌/.test(await page.evaluate(() => document.getElementById('testResult').textContent)));
await page.evaluate(() => document.getElementById('closeSettings').click());
// 必须等弹窗**真的**关掉再往下点：设置是覆盖层，弹窗还开着时点 #settingsBtn 的坐标会先命中
// 遮罩（它的 mousedown 会顺手把弹窗关掉），于是后面点 #saveSettings 时它已经不可见了 ——
// 实测报的就是「Node is either not clickable or not an Element」。
await page.waitForFunction(() => document.getElementById('settingsModal').classList.contains('hidden'), { timeout: 5000 }).catch(() => {});
await sleep(150);

/* ══════════════ 17b. API Key 填一次就存下来 ══════════════ */
console.log('\n▶ API Key 持久化…');
await page.click('#settingsBtn');
await page.waitForSelector('#settingsModal:not(.hidden)', { timeout: 6000 });
await sleep(200);
await page.evaluate(() => { document.getElementById('cfgApiKey').value = 'sk-persist-check-abcdef'; });
await page.click('#saveSettings');
await page.waitForFunction(() => /✅|❌/.test(document.getElementById('testResult').textContent || ''), { timeout: 20000 });
const savedOnce = await page.evaluate(() => ({
  hasKey: window.__settings.data.hasApiKey,
  inputCleared: document.getElementById('cfgApiKey').value === '',
  placeholder: document.getElementById('cfgApiKey').placeholder,
}));
check('填一次后输入框清空并标记「已保存」',
  savedOnce.hasKey && savedOnce.inputCleared && /已保存/.test(savedOnce.placeholder), savedOnce.placeholder);
await page.evaluate(() => document.getElementById('closeSettings').click());
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 30000 });
await sleep(1800);
await page.click('#settingsBtn');
await sleep(400);
const afterReload = await page.evaluate(() => ({
  hasKey: window.__settings.data.hasApiKey,
  placeholder: document.getElementById('cfgApiKey').placeholder,
  value: document.getElementById('cfgApiKey').value,
}));
check('刷新 / 重开之后 Key 还在（不用再填第二遍）',
  afterReload.hasKey && afterReload.value === '' && /已保存/.test(afterReload.placeholder),
  `hasApiKey=${afterReload.hasKey} placeholder="${afterReload.placeholder}"`);
const cfgEcho = await fetch(`${BASE}/api/config`).then((r) => r.json());
check('/api/config 不回传密钥明文，只回 hasApiKey', cfgEcho.apiKey === '' && cfgEcho.hasApiKey === true);
await page.evaluate(() => document.getElementById('closeSettings').click());
await sleep(300);

/* ══════════════ 18. 侧栏拖动 ══════════════ */
console.log('\n▶ 侧栏拖动…');
const w0 = await page.evaluate(() => document.getElementById('leftSide').getBoundingClientRect().width);
const sp1 = await page.evaluate(() => { const r = document.getElementById('splitLeft').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 200) }; });
await page.mouse.move(sp1.x, sp1.y); await page.mouse.down(); await page.mouse.move(sp1.x + 90, sp1.y, { steps: 8 }); await page.mouse.up();
await sleep(700);
const w1 = await page.evaluate(() => document.getElementById('leftSide').getBoundingClientRect().width);
check('左栏可以拖动调宽', Math.abs(w1 - w0) > 50, `${Math.round(w0)}px → ${Math.round(w1)}px`);
/**
 * 2026-10：右栏在「译文 / 问答一块都没开」时会收成右侧活动栏（`body.right-empty`），
 * `#rightSide` 宽度变 0、`#splitRight` 也点不到 —— 直接量/拖只会得到「0px → 0px」的假红。
 * 先把右栏拉回来，再量再拖。
 */
if (await page.evaluate(() => document.getElementById('rightSide').getBoundingClientRect().width === 0)) {
  await page.click('#railRightBtn');
  await sleep(500);
}
const r0 = await page.evaluate(() => document.getElementById('rightSide').getBoundingClientRect().width);
const sp2 = await page.evaluate(() => { const r = document.getElementById('splitRight').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 200) }; });
await page.mouse.move(sp2.x, sp2.y); await page.mouse.down(); await page.mouse.move(sp2.x - 70, sp2.y, { steps: 8 }); await page.mouse.up();
await sleep(700);
const r1 = await page.evaluate(() => document.getElementById('rightSide').getBoundingClientRect().width);
check('右栏可以拖动调宽', Math.abs(r1 - r0) > 40, `${Math.round(r0)}px → ${Math.round(r1)}px`);

/* ══════════════ 19. AI 分块：右栏恒为单列 / 一栏只开一个 ══════════════ */
console.log('\n▶ AI 分块调整…');
// 前面几轮重载过页面，先造一条消息，才能验证「换块不丢消息」
await selectSpans(1, 4);
await sleep(300);
await clickBubble('translate');
await page.waitForFunction(() => document.querySelectorAll('#aiArea .msg').length >= 1, { timeout: 15000 });
await sleep(700);
/**
 * 2026-10 删减后右栏**恒为 1 列**：第二栏（`#rightCol2` / `#aiArea2` / `#rightColSplit` /
 * `setPanelColumn` / `rightCols.{count,w2}`）连同上下分屏（`.ai-split`）一起删掉了。
 * 「一栏只开一个面板」这条契约仍然成立，只是现在只有一个栏位：
 *   · 文档里只有一栏（`#rightCols > .side.right` 长度 1）；
 *   · `#aiArea` 里同时最多 1 个 `.ai-block`，且它就是要显示的那一块。
 * 旧断言验的是「两块各占一栏 + 第 2 栏按需现建」，那整套契约已经不存在了。
 */
const adj0 = await page.evaluate(() => {
  const blocks = [...document.querySelectorAll('#aiArea .ai-block')];
  return {
    blocks: blocks.map((b) => b.dataset.block),
    heights: blocks.map((b) => `${b.dataset.block}:${Math.round(b.getBoundingClientRect().height)}`),
    splits: document.querySelectorAll('.ai-split').length,
    cols: document.querySelectorAll('#rightCols > .side.right').length,
    col2: !!document.getElementById('rightCol2'),
    aiArea2: !!document.getElementById('aiArea2'),
  };
});
check('右栏恒为单列：译文块在 #aiArea 里，没有第二栏、也没有上下分隔条',
  adj0.blocks.length === 1 && adj0.blocks[0] === 'translate'
    && adj0.cols === 1 && !adj0.col2 && !adj0.aiArea2 && adj0.splits === 0,
  `blocks=${JSON.stringify(adj0.blocks)} · 列数=${adj0.cols} · #rightCol2=${adj0.col2} · #aiArea2=${adj0.aiArea2} · .ai-split=${adj0.splits} | 高 ${adj0.heights.join(' / ')}`);
// 单列里「一栏只开一个」：再开问答 → 同一栏原来那块自动收起，仍然只有 1 块
await page.evaluate(() => document.querySelector('#aiBar .aibar-btn[data-block="chat"]').click());
await sleep(700);
const adjSwitch = await page.evaluate(() => ({
  blocks: [...document.querySelectorAll('#aiArea .ai-block')].map((b) => b.dataset.block),
  on: [...document.querySelectorAll('#aiBar .aibar-btn.on')].map((b) => b.dataset.block),
}));
check('单列里同时只开一块：开问答后 #aiArea 里只剩问答块',
  adjSwitch.blocks.length === 1 && adjSwitch.blocks[0] === 'chat' && adjSwitch.on.join() === 'chat',
  `blocks=${JSON.stringify(adjSwitch.blocks)} · 开关栏选中=${JSON.stringify(adjSwitch.on)}`);
// 变矮的窗口里，唯一那块必须重新夹进栏内，不许被裁到栏外
await page.setViewport({ width: 1500, height: 700 });
await sleep(900);
const adjShort = await page.evaluate(() => {
  const pane = document.getElementById('aiArea');
  const block = pane?.querySelector('.ai-block');
  return {
    paneBottom: pane ? Math.round(pane.getBoundingClientRect().bottom) : 0,
    blockBottom: block ? Math.round(block.getBoundingClientRect().bottom) : 0,
  };
});
check('窗口变矮后结果块仍夹在栏内（没被裁到栏外）',
  adjShort.blockBottom > 0 && adjShort.blockBottom <= adjShort.paneBottom + 1, JSON.stringify(adjShort));
await page.setViewport({ width: 1500, height: 950 });
await sleep(700);
// 切回译文：块节点被停进脱离文档的 #panelPark 后仍带着原来那条消息 —— 换块不丢消息
await page.evaluate(() => document.querySelector('#aiBar .aibar-btn[data-block="translate"]').click());
await sleep(700);
const adjBack = await page.evaluate(() => ({
  block: document.querySelector('#aiArea .ai-block')?.dataset.block || '',
  msgs: document.querySelectorAll('#aiArea .msg').length,
}));
check('换块不丢消息：切回译文后原来那条还在',
  adjBack.block === 'translate' && adjBack.msgs > 0, `${adjBack.block} · msg=${adjBack.msgs}`);

/* ══════════════ 20. 外观 ══════════════ */
console.log('\n▶ 对话流外观…');
await selectSpans(1, 4);
await sleep(300);
await clickBubble('translate');
await page.waitForFunction(() => document.querySelectorAll('#aiArea .msg').length >= 1, { timeout: 15000 });
await sleep(700);
// 再造一条「我说的话」，才能检查用户气泡的样式
await waitIdle();
await selectSpans(6, 8);
await sleep(300);
await clickBubble('add');
await sleep(400);
await page.type('#chatInput', '这两段怎么联系起来？');
await page.keyboard.press('Enter');
await page.waitForFunction(() => !!document.querySelector('#aiArea .msg.user'), { timeout: 15000 });
await sleep(900);
const look = await page.evaluate(() => {
  const msgs = [...document.querySelectorAll('#aiArea .msg')];
  const last = msgs[msgs.length - 1];
  const cs = last ? getComputedStyle(last) : null;
  const um = document.querySelector('#aiArea .msg.user');
  const umText = um ? um.querySelector('.text') : null;
  const userBg = umText ? getComputedStyle(umText).backgroundColor : '';
  // 最新一条助手消息：分块之后 DOM 顺序 ≠ 时间顺序，按 seq 取
  const asst = msgs.filter((m) => m.classList.contains('assistant'))
    .sort((a, b) => Number(a.dataset.seq || 0) - Number(b.dataset.seq || 0)).pop() || null;
  return {
    // 「折叠元素（<details>）只应该出现在设置面板里」这条契约的**正确判据**：
    // 数「文档里 details 的总数」与「设置弹窗里的数量」，要求两者相等 ——
    // 这样别处冒出折叠元素（比如曾经的面板管理器布局设置）仍然会红。
    // 2026-10 删减把设置里唯一那个 <details>（「更多样式」）也去掉了，
    // 于是两边都是 0；判据保留「不许出现在设置以外」这条不变量，不再要求「至少有一个」。
    details: document.querySelectorAll('details').length,
    detailsInSettings: document.querySelectorAll('#settingsModal details').length,
    border: cs ? `${cs.borderTopWidth}/${cs.borderLeftWidth}` : '',
    radius: cs ? cs.borderRadius : '',
    msgBg: cs ? cs.backgroundColor : '',
    panelBg: getComputedStyle(document.getElementById('rightSide')).backgroundColor,
    userBg,
    legacy: document.querySelectorAll('.entry, .e-head, .e-body, .quote-block').length,
    // 最终设计：用户消息 = 圆标 + 底色气泡；助手消息 = 没有圆标，
    // 靠阅读字体 / 正文宽度 / 底部动作条跟用户消息区分开
    userHasAva: !!document.querySelector('#aiArea .msg.user .ava'),
    userHasBubble: !!userBg && !/^(transparent|rgba\(0,\s*0,\s*0,\s*0\))$/.test(userBg),
    assistantNoAva: !!asst && !asst.querySelector('.ava'),
    assistantHasActs: !!asst && !!asst.querySelector('.acts'),
  };
});
// 折叠元素只允许出现在设置弹窗里：总数必须等于设置里的数量（2026-10 之后两边都是 0）
check('折叠元素不许出现在设置以外的地方',
  look.details === look.detailsInSettings,
  `details=${look.details} 设置内=${look.detailsInSettings}`);
const notCard = look.radius === '0px' && look.border.endsWith('/0px') && parseFloat(look.border) <= 1;
check('消息是扁平行（无圆角卡片、无左边框）', notCard && look.legacy === 0, `border=${look.border} radius=${look.radius}`);
check('助手消息与面板同底色', look.msgBg === look.panelBg || look.msgBg === 'rgba(0, 0, 0, 0)', look.msgBg);
check('用户/助手消息区分清晰（用户圆标+气泡，助手无圆标但有动作条）',
  look.userHasAva && look.userHasBubble && look.assistantNoAva && look.assistantHasActs,
  `用户 ava=${look.userHasAva} 气泡=${look.userHasBubble} ｜ 助手 无圆标=${look.assistantNoAva} 有动作条=${look.assistantHasActs}`);
check('用户消息有独立底色气泡', look.userHasBubble, look.userBg);

await page.evaluate(() => document.getElementById('fitWidth').click());
await sleep(1500);
await page.screenshot({ path: path.join(OUT, 'reader-light.png') });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
await sleep(900);
await page.screenshot({ path: path.join(OUT, 'reader-dark.png') });
check('跟随系统深色模式生效', (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) !== 'rgb(244, 245, 247)');
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
console.log(`\n📸 截图已保存到 ${OUT}`);

/* ══════════════ 21. 卡死超时 ══════════════ */
console.log('\n▶ 上游卡死…');
await postConfig({ idleMs: 4000 });
// 校验 idleMs 真的落到服务端了：没生效的话（仍是默认 60s）「上游卡死」这条断言
// 永远等不到超时报错，必然假红 —— 实测就栽在这里。
const idleCfg = await fetch(`${BASE}/api/config`).then((r) => r.json()).catch(() => ({}));
console.log(`   服务端 idleMs=${idleCfg.idleMs}（期望 4000）`);
await loadDoc();
// 上一段（截图 / 深色模式）没跑过请求，但保险起见先回到空闲再发，避免被「上次回答尚未完成」挡回
await forceIdle();
mockMode = 'hang';
await selectSpans(1, 4);
await sleep(300);
const hangPre = await page.evaluate(() => ({
  busy: !!window.__state?.busy,
  sel: (window.getSelection()?.toString() || '').slice(0, 24),
  stopHidden: document.getElementById('stopBtn').classList.contains('hidden'),
}));
// 先记下**发请求前**已有的最大 seq，之后只看比它大的那条 —— 断言必须盯住本次这一条。
// 旧写法用「界面上存在任意一条含『没有收到任何数据|失败』的元素」当条件，而会话恢复会把
// 历史失败条目一起带回来，于是条件第一轮就成立、hangMs 恒为 0.0s 读到历史条目 —— 假红。
const hangTarget = Math.max(0, ...(await page.evaluate(() => [...document.querySelectorAll('#aiArea .msg')].map((e) => Number(e.dataset.seq || 0)))));
await clickBubble('translate');
const t0 = Date.now();
await page.waitForFunction((target) => {
  const list = [...document.querySelectorAll('#aiArea .msg')]
    .sort((a, b) => Number(a.dataset.seq || 0) - Number(b.dataset.seq || 0));
  const mine = list.filter((e) => Number(e.dataset.seq || 0) > target).pop();
  if (!mine) return false;
  return /没有收到任何数据|失败/.test(mine.querySelector('.text')?.innerText || '');
}, { timeout: 25000 }, hangTarget).catch(() => {});
const hangMs = Date.now() - t0;
const hangEntry = await page.evaluate((target) => {
  const list = [...document.querySelectorAll('#aiArea .msg')]
    .sort((a, b) => Number(a.dataset.seq || 0) - Number(b.dataset.seq || 0));
  const mine = list.filter((e) => Number(e.dataset.seq || 0) > target).pop();
  return mine ? { seq: mine.dataset.seq, body: mine.querySelector('.text')?.innerText || '' } : null;
}, hangTarget);
// 现场记录：这条断言历史上报过「0.0s 后报错」，有这份流水就能看出是「没发请求」还是「读错条目」
const hangDiag = await page.evaluate(() => {
  const list = [...document.querySelectorAll('#aiArea .msg')]
    .sort((a, b) => Number(a.dataset.seq || 0) - Number(b.dataset.seq || 0));
  return {
    busy: !!window.__state?.busy,
    lastThree: list.slice(-3).map((e) => ({ seq: e.dataset.seq, body: (e.querySelector('.text')?.innerText || '').slice(0, 34) })),
  };
});
check('上游卡死会明确报错，不是一直转',
  hangMs < 15000 && /没有收到任何数据/.test(hangEntry?.body || ''),
  `${(hangMs / 1000).toFixed(1)}s 后报错 ‖ 本次条目=${JSON.stringify(hangEntry)} ‖ 发请求前=${JSON.stringify(hangPre)} ‖ 现场=${JSON.stringify(hangDiag)} ‖ 拦截流水=${JSON.stringify(mockLog.slice(-3))}`);
mockMode = 'sse';
await postConfig({ idleMs: 60000 });
/**
 * ⚠️ 必须显式把「忙」状态清掉再往下走。
 *
 * 卡死用例走的是**超时**分支：请求被判定失败并显示「没有收到任何数据」，但这一轮的
 * `state.busy` 不保证已经复位。不清的话，下一条用例（401 / 地区限制）发请求时会被
 * 「上次回答尚未完成」挡回来 —— **请求根本没发出去**，断言读到的还是上一条错误文案，
 * 表现成两条断言的假红（实测：seq 29 = 「上次回答尚未完成」，seq 30 才是残留的 401）。
 * 这里用产品自己的停止入口（#stopBtn）把它复位，并等到真的不忙了再继续。
 */
await page.evaluate(() => { const b = document.getElementById('stopBtn'); if (b) b.click(); });
await page.waitForFunction(() => {
  const b = document.getElementById('stopBtn');
  return !b || b.classList.contains('hidden');
}, { timeout: 10000 }).catch(() => {});
await sleep(300);

/* ══════════════ 21b. 密钥失效的提示 ══════════════ */
/**
 * 真实遇到过一次：DeepSeek 返回 401 "Your api key: ****8593 is invalid"。
 * 光把那句英文甩给用户没用，得告诉他「去换 Key」。
 */
console.log('\n▶ 密钥失效…');
await loadDoc();
/**
 * ⚠️ 先等应用真的「不忙」再往下走。
 *
 * 上一条用例（上游卡死）走的是超时分支：界面报「没有收到任何数据」，但这一轮可能还留着
 * `state.busy`。不清就发下一条请求会被挡回来，**请求根本没发出去**，断言读到的是上一条
 * 错误文案 —— 这就是「地区限制」那条断言反复假红的真正原因（实测拦截流水里完全没有
 * mode=region 的记录，而会话里多出一条 pending 的「上次回答尚未完成」）。
 * 这里用产品自己的停止入口复位，并且**等到 busy 真的清零**再继续。
 */
await forceIdle();

mockMode = '401';
await selectSpans(1, 4);
await sleep(300);
await clickBubble('translate');
await page.waitForFunction(() => [...document.querySelectorAll('#aiArea .msg .text')].some((x) => /失败/.test(x.innerText)), { timeout: 20000 }).catch(() => {});
const authMsg = (await lastEntry())?.body || '';
check('401 会提示「API Key 无效/已失效，去换一个」',
  /API Key 无效或已失效/.test(authMsg) && /⚙/.test(authMsg), authMsg.slice(0, 90));
mockMode = 'region';
await forceIdle();
// ⚠️ 必须换一段**不同的**文字再译：doTranslate 开头会按 (目标语言 + 文本) 查缓存/去重，
// 用与上一次完全相同的选区时它会直接复用上一条结果（"这段翻译已在结果区"），
// 于是这次请求根本没发出去，读到的还是上一条 401 的文案 —— 断言就成了假红。
// 换选区（from/to 不同 → 文本不同）才是真正把 region 分支跑一遍。
const regionSel = await selectSpans(2, 6);
const regionClicks = await page.evaluate(() => ({
  bubbleHidden: document.getElementById('bubble').classList.contains('hidden'),
  sel: (window.getSelection()?.toString() || '').slice(0, 30),
  busy: !!window.__state?.busy,
  stopHidden: document.getElementById('stopBtn')?.classList.contains('hidden'),
}));
await sleep(300);
const regionBubble = await page.evaluate(() => {
  const b = document.getElementById('bubble');
  const btn = b?.querySelector('button[data-act="translate"]');
  const r = btn?.getBoundingClientRect();
  return { hidden: b?.classList.contains('hidden'), hasBtn: !!btn, w: r?.width || 0, x: r?.x || 0, y: r?.y || 0 };
});
/**
 * 不用 clickBubble（它「先量坐标 → 再点」，量完到点下去之间有窗口期）；
 * 这里改成「取按钮中心 → 打印该点上的真实元素 → 点下去」，并把点之前的坐标留档。
 * 若 `elementFromPoint` 不是这个按钮，就说明坐标点击根本没落到按钮上 —— 那是脚手架的锅。
 */
const regionHit = await page.evaluate(() => {
  const btn = document.querySelector('#bubble button[data-act="translate"]');
  if (!btn) return { missing: true };
  const r = btn.getBoundingClientRect();
  const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
  const hit = document.elementFromPoint(x, y);
  return { x, y, w: Math.round(r.width), h: Math.round(r.height),
    hitTag: hit?.tagName, hitAct: hit?.dataset?.act || hit?.closest?.('button')?.dataset?.act || '',
    isBtn: hit === btn };
});
if (regionHit.missing) { console.log('   ⚠️ 气泡里没有 translate 按钮，点不了'); }
else { await page.mouse.click(regionHit.x, regionHit.y); }
await sleep(1200);
// 点完 1.2s 后：请求到底发了没有？没发的话界面给了什么理由？
const regionAfterClick = await page.evaluate(() => ({
  busy: !!window.__state?.busy,
  stopHidden: document.getElementById('stopBtn')?.classList.contains('hidden'),
  hint: document.querySelector('.ai-empty, .hint, #aiArea .tip')?.textContent?.slice(0, 40) || '',
}));
await page.waitForFunction(() => [...document.querySelectorAll('#aiArea .msg .text')].some((x) => /该模型在你所在地区不可用/.test(x.innerText)), { timeout: 20000 }).catch(() => {});
const regionMsg = (await lastEntry())?.body || '';
// 诊断（保留：这条断言历史上假红过两次，留一份现场便于下次直接看出是「没发请求」还是「读错条目」）
const regionDiag = await page.evaluate(() => {
  const list = [...document.querySelectorAll('#aiArea .msg')]
    .sort((a, b) => Number(a.dataset.seq || 0) - Number(b.dataset.seq || 0));
  return {
    total: list.length,
    lastThree: list.slice(-3).map((e) => ({
      seq: e.dataset.seq, tag: e.querySelector('.role .tag')?.textContent || '',
      body: (e.querySelector('.text')?.innerText || '').slice(0, 46),
    })),
  };
});
check('地区限制明确提示模型不可用且不误报密钥失效',
  /该模型在你所在地区不可用/.test(regionMsg) && !/API Key 无效或已失效/.test(regionMsg),
  `${regionMsg.slice(0, 70)} ‖ 选中=${JSON.stringify(regionSel)} ‖ 点前=${JSON.stringify(regionClicks)} ‖ 气泡=${JSON.stringify(regionBubble)} ‖ 命中=${JSON.stringify(regionHit)} ‖ 点后=${JSON.stringify(regionAfterClick)} ‖ 请求数=${chatRequests.length} ‖ 现场=${JSON.stringify(regionDiag)} ‖ 拦截流水=${JSON.stringify(mockLog.slice(-4))}`);
mockMode = 'sse';

/* ══════════════ 22. 首次使用（2026-10：欢迎页 → 首页 / 书架页） ══════════════ */
console.log('\n▶ 首次使用…');
await page.goto('about:blank');
await sleep(300);
await postJson(`${BASE}/api/state`, { lastDoc: null, lastName: null, lastUrl: null, docs: {} });
await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
await sleep(1800);
/**
 * 契约已随首页改造更新：原来的 `#welcome`（阅读区里的空状态）升级成了独立的
 * `#home` 首页，而且**默认就停在这里**（不再自动打开上次论文，见 test/home.mjs 的 A4）。
 * 所以这里的断言是「停在首页 + 书架可见」，语义与改造前一致，只是选择器和页面结构换了。
 */
const firstRun = await page.evaluate(() => ({
  home: !document.getElementById('home').classList.contains('hidden'),
  reading: document.body.classList.contains('reading'),
  hasOpen: !!document.getElementById('homeOpen'),
  hasDrop: !!document.getElementById('homeDrop'),
  files: document.querySelectorAll('#fileList li:not(.empty)').length,
}));
check('首次打开停在首页（书架页）', firstRun.home && !firstRun.reading && firstRun.hasOpen && firstRun.hasDrop,
  JSON.stringify(firstRun));
check('首次打开**没有**自动进入任何论文', firstRun.reading === false);
check('papers/ 里的论文被列出', firstRun.files >= 1, `${firstRun.files} 篇`);
const errBefore = pageErrors.length;
await page.evaluate(() => { document.getElementById('fitWidth').click(); document.getElementById('zoomIn').click(); document.getElementById('zoomOut').click(); });
await page.keyboard.press('0');
await sleep(400);
check('没有文档时缩放不会崩', pageErrors.length === errBefore, `${pageErrors.length - errBefore} 条新异常`);

await page.click('#fileList li');
await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 30000 });
const openedName = await page.evaluate(() => ({
  name: document.getElementById('docName').textContent,
  files: [...document.querySelectorAll('#fileList li')].map((li) => li.textContent.trim()).filter(Boolean),
}));
// 断言要跟「书架里恰好有什么」解耦：用户随时可能导入新论文，新论文 mtime 更新会排到第一位，
// 写死 /attention|sample/ 会在用户加了论文之后突然变红（真的这么红过一次）。
check('点列表能打开论文',
  !!openedName.name && openedName.name !== '未打开文档'
    && openedName.files.some((f) => openedName.name === `${f}.pdf` || openedName.name.startsWith(f)),
  `${openedName.name} · 列表:${openedName.files.join('|')}`);

/* ══════════════ 23. 本地文件（导入落盘）+ 快速切换 ══════════════ */
console.log('\n▶ 本地文件导入 / 快速切换…');
await (await page.$('#fileInput')).uploadFile(localPdf);
await page.waitForFunction(() => document.querySelectorAll('.page[data-page="1"] .textLayer span').length > 10, { timeout: 30000 });
await sleep(1200);
check('本地文件可以直接打开', (await page.evaluate(() => document.querySelectorAll('.page [class="textLayer"] span').length)) > 20);

// 导入的 PDF 必须落盘到 papers/，并且出现在左侧列表里（下次打开还在）
const imported = await page.evaluate(() => ({
  inList: [...document.querySelectorAll('#fileList li')].map((li) => li.textContent).join('|'),
  doc: document.getElementById('docName').textContent,
  toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' '),
}));
const localName = path.basename(localPdf);
const stem = localName.replace(/\.pdf$/i, '');
check('导入的 PDF 出现在左侧列表里', imported.inList.includes(stem), JSON.stringify(imported.inList.slice(0, 60)));
const onDisk = await fetch(`${BASE}/api/papers`).then((r) => r.json());
check('导入的 PDF 真的写进了测试 papers/', onDisk.papers.some((p) => p.name === localName), `${onDisk.papers.length} 篇 · ${onDisk.dir}`);
check('没有退回 blob 临时打开', !/^blob:/.test(await page.evaluate(() => window.__state?.doc?.url || '')), 'doc url 来自服务端');

await page.evaluate(() => document.querySelectorAll('#fileList li')[0]?.click());
await sleep(30);
await (await page.$('#fileInput')).uploadFile(localPdf);
await sleep(2500);
/**
 * 状态栏已删除（2026-10）：PDF 下面那条只有「就绪」的 22px 横条整块去掉了，
 * 解析进度改由页码那一格的 `.busy` + title 表达。
 * 所以这里不再读 statusText，改成读**等价的真实信号**：
 *   · 页面与画布都渲染出来了（原来的 pages/canvases 判据不变）
 *   · 页码那一格不是占位符「–」（说明视图真的就绪了，而不是停在「正在打开…」）
 * 没有削弱断言，只是把已删除的 UI 换成它现在对应的观测点。
 */
const race2 = await page.evaluate(() => ({
  pages: document.querySelectorAll('.page').length,
  canvases: document.querySelectorAll('.page canvas').length,
  pageLabel: document.getElementById('pageInput')?.value || '',
  busy: !!document.querySelector('#pageInput.busy'),
}));
check('快速切换文档状态一致', race2.pages > 0 && race2.canvases >= 1 && race2.pageLabel !== '–' && race2.pageLabel !== '',
  `${race2.canvases}/${race2.pages} 已渲染 · 页码=${race2.pageLabel} busy=${race2.busy}`);

/* ══════════════ 汇总 ══════════════ */
console.log('\n──────── 错误汇总 ────────');
const realConsole = consoleErrors.filter((t) => !/favicon|Failed to load resource: net::ERR_/i.test(t));
if (pageErrors.length) console.log('页面异常:\n' + pageErrors.map((e) => '  ! ' + e).join('\n'));
if (realConsole.length) console.log('控制台错误:\n' + realConsole.map((e) => '  ! ' + e).join('\n'));
if (failedRequests.length) console.log('失败请求:\n' + failedRequests.map((e) => '  ! ' + e).join('\n'));
if (!pageErrors.length && !realConsole.length && !failedRequests.length) console.log('  无');

const passed = results.filter((r) => r.ok).length;
console.log(`\n──────── 结果：${passed}/${results.length} 通过 ────────`);
for (const r of results) if (!r.ok) console.log(`  ❌ ${r.name} ${r.detail}`);

await browser.close();
process.exit(passed === results.length && !pageErrors.length ? 0 : 1);
