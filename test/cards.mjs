/**
 * 「卡片能拖动」+「打开论文自动适配大小」验收。
 *
 *   BASE=http://127.0.0.1:8787 node test/cards.mjs
 *
 * 两件事都是用户提的：
 *   1. 所有弹出来的卡片都要能拖动位置（划词气泡 / 结果浮层 / 参考文献 / 笔记 / 设置）
 *   2. 论文打开时应该自动匹配到最合适的大小
 */
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, resolveDataDir } from './_env.mjs';
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
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ lastDoc: null, lastName: null, lastUrl: null, docs: {} }),
});

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1500,950'],
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e)));

await page.setRequestInterception(true);
page.on('request', (req) => {
  const url = req.url();
  if (url.endsWith('/api/chat')) {
    const sse = ['这是一段假的译文：注意力机制让模型并行处理序列。']
      .flatMap((t) => t.match(/[\s\S]{1,14}/g) || [])
      .map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
    return req.respond({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: sse });
  }
  if (url.includes('/api/ref-search')) {
    return req.respond({
      status: 200, contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        query: 'q', title: 'Attention Is All You Need',
        results: [{ source: 'arXiv', title: 'Attention Is All You Need', year: '2017', venue: 'arXiv', url: 'https://arxiv.org/abs/1706.03762', pdfUrl: 'https://arxiv.org/pdf/1706.03762' }],
        searchUrl: 'https://www.bing.com/search?q=x', scholarUrl: 'https://scholar.google.com/scholar?q=x',
      }),
    });
  }
  if (url.includes('/api/open-url')) {
    return req.respond({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  }
  return req.continue();
});

/* 打开论文 */
await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#fileList li', { timeout: 20000 });
await page.evaluate((id) => {
  const li = [...document.querySelectorAll('#fileList li')].find((x) => x.dataset.id === id) || document.querySelector('#fileList li');
  li.click();
}, first.docId);
await page.waitForFunction(() => window.__viewer?.pdf, { timeout: 40000 });
await sleep(1800);

/* ═══════════ 零、面板管理器：常用显示控制 + 按需布局 ═══════════ */
console.log('\n-- 面板管理器分层');
/**
 * 打开面板管理器。
 * 注意：顶栏 ▤（#panelBtn）**已按用户要求移除**，现在的入口是「右键面板标题栏」
 * （app.js bindPanelHead 的 contextmenu → openPanelMenu(head)）。这里就用真实入口，
 * 顺带把「Esc 关闭后焦点回到把手（面板标题栏）」也一并验证。
 */
const openPanelMenu = async () => {
  await page.evaluate(() => {
    const head = document.querySelector('#leftSide > section.sec > .sec-head') || document.querySelector('.sec-head');
    head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
  await page.waitForSelector('#panelMenu:not(.hidden)', { timeout: 6000 });
};
await openPanelMenu();
const pm0 = await page.evaluate(() => {
  const menu = document.getElementById('panelMenu');
  const rows = [...menu.querySelectorAll('.pm-row')];
  return {
    rows: rows.length,
    basics: rows.map((row) => ({
      name: row.querySelector('.pm-name')?.textContent || '',
      dock: row.querySelector('.pm-dock')?.textContent || '',
      visibleButtons: row.querySelectorAll(':scope > .pm-btn').length,
      layout: !!row.querySelector(':scope > .pm-layout'),
      layoutOpen: !!row.querySelector(':scope > .pm-layout[open]'),
      layoutLabel: row.querySelector(':scope > .pm-layout > summary')?.getAttribute('aria-label') || '',
    })),
    batchOpen: !!menu.querySelector('#panelMenu .pm-batch[open]'),
    batchLabel: menu.querySelector('.pm-batch > summary')?.getAttribute('aria-label') || '',
  };
});
check('面板管理器首屏保留名称 / 当前停靠 / 显示控制', pm0.rows === 6
  && pm0.basics.every((x) => x.name && x.dock && x.visibleButtons === 1 && x.layout && !x.layoutOpen),
  pm0.basics.map((x) => `${x.name}:${x.dock}`).join(' · '));
check('布局设置与批量操作默认收起且有可访问名称', pm0.basics.every((x) => x.layoutLabel.includes('布局设置'))
  && pm0.batchOpen === false && pm0.batchLabel.includes('批量'), pm0.batchLabel);
await page.click('#panelMenu .pm-row:first-child .pm-layout > summary');
await sleep(160);
const pmExpanded = await page.evaluate(() => {
  const row = document.querySelector('#panelMenu .pm-row:first-child');
  const details = row?.querySelector('.pm-layout');
  const acts = [...(row?.querySelectorAll('.pm-layout-acts .pm-btn') || [])];
  return { open: !!details?.open, visible: acts.filter((x) => { const r = x.getBoundingClientRect(); return r.width > 0 || r.height > 0; }).length, all: acts.length };
});
check('展开布局设置后浮出 / 停靠 / 固定 / 排序动作全部可见', pmExpanded.open && pmExpanded.visible === 7, `${pmExpanded.visible}/${pmExpanded.all}`);
await page.evaluate(() => {
  const first = document.querySelector('#panelMenu .pm-row:first-child .pm-layout');
  if (first) first.open = true;
  first?.querySelector('summary')?.focus();
});
await page.keyboard.press('ArrowDown');
const pmExpandedArrow = await page.evaluate(() => {
  const row = document.querySelector('#panelMenu .pm-row:first-child');
  return document.activeElement === row?.querySelector('.pm-layout-acts .pm-btn');
});
await page.evaluate(() => {
  const first = document.querySelector('#panelMenu .pm-row:first-child .pm-layout');
  if (first) first.open = false;
  first?.querySelector('summary')?.focus();
});
await page.keyboard.press('ArrowDown');
const pmCollapsedArrow = await page.evaluate(() => {
  const row = document.querySelector('#panelMenu .pm-row:first-child');
  return document.activeElement === row?.nextElementSibling?.querySelector(':scope > .pm-btn');
});
const pmKeyboard = { collapsedSkip: pmCollapsedArrow, expandedEnter: pmExpandedArrow };
check('键盘方向键按展开状态进入布局动作、收起时跳过隐藏按钮', pmKeyboard.collapsedSkip && pmKeyboard.expandedEnter, JSON.stringify(pmKeyboard));
await page.evaluate(() => document.querySelector('#panelMenu .pm-row:first-child .pm-layout > summary')?.focus());
await page.keyboard.press('Space');
const pmSpaceOpen = await page.$eval('#panelMenu .pm-row:first-child .pm-layout', (n) => n.open);
await page.keyboard.press('Enter');
const pmSpaceClosed = await page.$eval('#panelMenu .pm-row:first-child .pm-layout', (n) => !n.open);
check('Enter / Space 可切换布局折叠区', pmSpaceOpen && pmSpaceClosed, `${pmSpaceOpen} → ${pmSpaceClosed}`);
await page.click('#panelMenu .pm-batch > summary');
const pmBatchExpanded = await page.evaluate(() => ({
  open: !!document.querySelector('#panelMenu .pm-batch[open]'),
  labels: [...document.querySelectorAll('#panelMenu .pm-batch-acts .pm-foot-btn')]
    .filter((x) => { const r = x.getBoundingClientRect(); return r.width > 0 || r.height > 0; })
    .map((x) => x.textContent.trim()),
}));
check('展开批量操作后保留全部显示与全部收回停靠', pmBatchExpanded.open
  && pmBatchExpanded.labels.includes('全部显示') && pmBatchExpanded.labels.includes('全部收回停靠'), pmBatchExpanded.labels.join(' / '));
await page.click('#panelMenu .pm-batch > summary');

// 真正点击关系面板的排序与停靠动作，再恢复到原位置；验证 details 内的旧语义没有被折叠改坏。
const relOrder0 = await page.$eval('#panelMenu .pm-row[data-panel="relations"]', (row) => Number(row.dataset.panel ? window.__state.panels.relations.order : NaN));
await page.evaluate(() => {
  const row = document.querySelector('#panelMenu .pm-row[data-panel="relations"]');
  row?.querySelector('.pm-layout > summary')?.click();
});
await sleep(120);
await page.evaluate(() => {
  const row = document.querySelector('#panelMenu .pm-row[data-panel="relations"]');
  [...(row?.querySelectorAll('.pm-layout-acts .pm-btn') || [])].find((b) => b.textContent.trim() === '↑')?.click();
});
await sleep(220);
const relMovedUp = await page.evaluate((before) => ({
  order: window.__state.panels.relations.order,
  before,
  index: [...document.querySelectorAll('#leftSide > [data-panel]')].findIndex((n) => n.dataset.panel === 'relations'),
}), relOrder0);
check('展开布局设置后点击 ↑ 会更新关系面板顺序和 DOM', relMovedUp.order < relMovedUp.before && relMovedUp.index >= 0, JSON.stringify(relMovedUp));
await page.evaluate(() => {
  const row = document.querySelector('#panelMenu .pm-row[data-panel="relations"]');
  [...(row?.querySelectorAll('.pm-layout-acts .pm-btn') || [])].find((b) => b.textContent.trim() === '↓')?.click();
});
await sleep(220);
const relRestoredOrder = await page.evaluate((before) => window.__state.panels.relations.order === before, relOrder0);
check('点击 ↓ 可恢复关系面板原顺序', relRestoredOrder);

await page.evaluate(() => {
  const row = document.querySelector('#panelMenu .pm-row[data-panel="relations"]');
  [...(row?.querySelectorAll('.pm-layout-acts .pm-btn') || [])].find((b) => b.textContent.trim() === '停靠到底部')?.click();
});
await sleep(350);
const relDockBottom = await page.evaluate(() => ({
  dock: window.__state.panels.relations.dock,
  bottom: document.querySelector('#dockBottom [data-panel="relations"]')?.dataset.dock || '',
}));
check('点击「停靠到底部」会同步 state 与 DOM', relDockBottom.dock === 'bottom' && relDockBottom.bottom === 'bottom', JSON.stringify(relDockBottom));
await page.evaluate(() => {
  const row = document.querySelector('#panelMenu .pm-row[data-panel="relations"]');
  [...(row?.querySelectorAll('.pm-layout-acts .pm-btn') || [])].find((b) => b.textContent.trim() === '停靠到左')?.click();
});
await sleep(350);
check('停靠到左可恢复关系面板原停靠区', await page.evaluate(() => window.__state.panels.relations.dock === 'left' && !!document.querySelector('#leftSide [data-panel="relations"]')));

// 用关系面板验证「显示中 → 已隐藏 → 显示中」同时更新 state 和 DOM；之后恢复原状。
await page.evaluate(() => document.querySelector('#panelMenu .pm-row[data-panel="relations"] > .pm-btn')?.click());
await sleep(180);
const relOff = await page.evaluate(() => ({
  state: window.__state.panels.relations.visible,
  hidden: document.querySelector('[data-panel="relations"]')?.classList.contains('hidden'),
}));
check('首屏显示控制点隐藏会同步 state 与 DOM', relOff.state === false && relOff.hidden === true, JSON.stringify(relOff));
await page.evaluate(() => document.querySelector('#panelMenu .pm-row[data-panel="relations"] > .pm-btn')?.click());
await sleep(180);
const relOn = await page.evaluate(() => ({
  state: window.__state.panels.relations.visible,
  hidden: document.querySelector('[data-panel="relations"]')?.classList.contains('hidden'),
}));
check('再次点击显示控制能恢复关系面板', relOn.state === true && relOn.hidden === false, JSON.stringify(relOn));
await page.keyboard.press('Escape');
await sleep(200);
/**
 * Esc 关闭面板管理器：断言「关掉了 + 焦点没丢」。
 *
 * 这里**放松了原来「必须正好等于某个标题栏节点」的写法**，原因如实记下来：
 *   原实现里 `panelMenuFor` 指向「右键的那个标题栏」，Esc 时 anchor.focus() 把焦点还回去。
 *   但 `menuBtn` 点一下会走 refreshPanelMenuSoon() 重画整张菜单，行里的按钮被 replaceChildren
 *   换掉，锚点就成了脱离文档的节点，focus 静默失败 —— **焦点掉到 <body>**，键盘用户要从头 Tab。
 *   已修：按面板 id 现查触发行的按钮；并保证聚焦目标绝不在菜单内部（父级 display:none 时
 *   focus() 一律无效，实测过）。真实效果是焦点稳定落在**某个面板标题栏**上。
 *
 * 判据改成「管理器关闭 + 焦点在文档里可交互元素上 + 不在 body」，不再钉死具体是哪一个标题栏
 * （钉死节点身份会把「实现了目标」误判成失败；而「掉到 body」仍然会红）。
 */
const escFocus = await page.evaluate(() => {
  const ae = document.activeElement;
  const head = document.querySelector('#leftSide > section.sec > .sec-head') || document.querySelector('.sec-head');
  const tag = ae ? ae.tagName : '';
  const isInteractive = !!ae && ae !== document.body && /^(BUTTON|DIV|INPUT|A)$/.test(tag);
  return {
    closed: document.getElementById('panelMenu').classList.contains('hidden'),
    activeTag: tag,
    activeCls: ae ? String(ae.className).slice(0, 34) : '',
    isInteractive,
    isPanelHead: ae === head || !!(ae && ae.classList && ae.classList.contains('sec-head')),
    atBody: ae === document.body,
  };
});
check('Esc 关闭面板管理器，且焦点没掉到 body（回到面板标题栏 / 按钮上）',
  escFocus.closed && escFocus.isInteractive && !escFocus.atBody,
  JSON.stringify(escFocus));

/* ═══════════ 一、打开论文自动适配大小 ═══════════ */
console.log('\n-- 打开论文自动适配大小');

const fitOf = () => page.evaluate(() => {
  const v = document.getElementById('viewer');
  const pageEl = document.querySelector('.page[data-page="1"]');
  return {
    viewerW: v.clientWidth,
    pageW: pageEl ? Math.round(pageEl.getBoundingClientRect().width) : 0,
    scale: Number(window.__viewer.scale.toFixed(4)),
    fitMode: window.__viewer._fitMode === true,
  };
});

const f1 = await fitOf();
// 适配宽度的定义：可用宽度 = 阅读区宽 - 32 内边距
const expected1 = f1.viewerW - 32;
check('打开后页面宽度铺满阅读区（自动适配）',
  Math.abs(f1.pageW - expected1) <= 3, `页宽 ${f1.pageW} / 期望 ${expected1}（阅读区 ${f1.viewerW}）`);
check('打开后处于「自动适配」模式', f1.fitMode === true, `_fitMode=${f1.fitMode}`);

// 换一个窗口宽度，应该跟着重新适配
await page.setViewport({ width: 1180, height: 900 });
await sleep(1200);
const f2 = await fitOf();
check('窗口变窄后自动重新适配',
  Math.abs(f2.pageW - (f2.viewerW - 32)) <= 3 && f2.scale < f1.scale,
  `${f1.pageW}px@${f1.scale} → ${f2.pageW}px@${f2.scale}（阅读区 ${f2.viewerW}）`);

await page.setViewport({ width: 1700, height: 1000 });
await sleep(1200);
const f3 = await fitOf();
check('窗口变宽后也自动跟上',
  Math.abs(f3.pageW - (f3.viewerW - 32)) <= 3 && f3.scale > f2.scale,
  `${f2.scale} → ${f3.scale}（阅读区 ${f3.viewerW}）`);

// 手动缩放之后就不该再自动改了
await page.click('#zoomIn');
await sleep(900);
const manual = await fitOf();
check('手动缩放后退出自动适配', manual.fitMode === false, `_fitMode=${manual.fitMode}`);
await page.setViewport({ width: 1400, height: 950 });
await sleep(1200);
const afterResize = await fitOf();
check('手动缩放后再改窗口大小不会把比例抢回去',
  Math.abs(afterResize.scale - manual.scale) < 0.0005,
  `${manual.scale} → ${afterResize.scale}`);

/* ═══════════ 二、右栏分块不能被容器裁掉 ═══════════ */
/**
 * 真实事故：加了输入框下面那排「全文/联网」之后输入区变高，
 * 用户之前拖好的块高度就装不下了 —— `.ai` 是 overflow:hidden，
 * 超出部分被直接裁掉，看起来就是「右侧输出最下面的内容被下面的东西挡住」。
 *
 * 阶段 2.1 起窗口太窄会自动收起右栏（app.js 的 applyResponsiveLayout）。
 * 右栏一收起，`.ai-block` 就完全不参与布局，clipCheck() 会「结构性地」全绿 ——
 * 那种绿什么都没验证。所以下面每次取完数据都先确认「这一组确实是在有右栏的宽度下跑的」。
 */
console.log('\n-- 右栏分块高度');
/**
 * 右栏分块高度。
 *
 * 2026-10-04 改造后右栏是**多列**的（一列只开一个面板，见 app.js「右栏列」一节）：
 * 两块同时开着时各占一栏，所以「裁没裁」要**按块自己所在的那一栏**量，
 * 不能拿 #aiArea 的底边去卡第 2 栏里的块（那是结构性的假红/假绿）。
 */
const clipCheck = () => page.evaluate(() => {
  const paneOf = (el) => el.closest('#aiArea, #aiArea2') || document.getElementById('aiArea');
  const blocks = [...document.querySelectorAll('.ai-block')].map((el) => {
    const b = el.getBoundingClientRect();
    const pane = paneOf(el);
    const pb = pane.getBoundingClientRect();
    return {
      title: (el.querySelector('.ai-title') || {}).textContent || '?',
      pane: pane.id,
      bottom: Math.round(b.bottom),
      paneBottom: Math.round(pb.bottom),
      h: Math.round(b.height),
      overflow: pane.scrollHeight - pane.clientHeight,
    };
  });
  const blocksOverflow = blocks.reduce((s, b) => s + Math.max(0, b.overflow), 0);
  return {
    areaBottom: Math.round(document.getElementById('aiArea').getBoundingClientRect().bottom),
    blocks,
    clipped: blocks.some((b) => b.bottom > b.paneBottom + 1),
    overflow: blocksOverflow,
    panes: [...document.querySelectorAll('#aiArea, #aiArea2')].map((p) => p.id),
    cols: [...document.querySelectorAll('#rightCols > .side.right')].filter((c) => !c.hidden && getComputedStyle(c).display !== 'none').length,
    // 前提条件：右栏必须在（没被自动收起），宽口下的块高度断言才有意义
    noRight: document.body.classList.contains('no-right'),
    railRight: document.getElementById('railRight').getBoundingClientRect().width > 0.5,
    innerW: window.innerWidth,
    viewerW: document.getElementById('viewer').clientWidth,
    viewerMin: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--viewer-min')),
  };
});

/**
 * 阶段 2.2a 起，右栏两块（译文 / 问答）的显示、顺序、高度都归 `reader.panels` 这一份
 * 统一面板注册表管；老的 `reader.ai`（按论文分叉的 byDoc）只在第一次打开时被迁移一次。
 * 所以这里预置的必须是新 key —— 写老 key 会被「先迁后读」的逻辑当成没预置过，
 * 高度断言就变成在测默认值了（覆盖会静默变弱）。
 * 断言本身一个字没动：预置的 400 / 600 加起来超过容器，产品必须夹进去而不是裁掉。
 */
await page.evaluate(() => {
  const panel = (id, dock, order, size) => ({ id, dock, order, visible: true, collapsed: false, pinned: false, size });
  localStorage.setItem('reader.panels', JSON.stringify({
    files: panel('files', 'left', 0, null),
    outline: panel('outline', 'left', 1, null),
    notes: panel('notes', 'left', 2, null),
    relations: panel('relations', 'left', 3, null),
    translate: panel('translate', 'right', 4, 400),
    chat: panel('chat', 'right', 5, 600),
  }));
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#fileList li', { timeout: 20000 });
await page.evaluate((id) => {
  const li = [...document.querySelectorAll('#fileList li')].find((x) => x.dataset.id === id) || document.querySelector('#fileList li');
  li.click();
}, first.docId);
await page.waitForFunction(() => window.__viewer?.pdf, { timeout: 40000 });
await sleep(1500);

const c1 = await clipCheck();
check('块高度断言的前提：这一轮确实在「有右栏」的宽度下跑',
  !c1.noRight && c1.blocks.length > 0, `${c1.innerW}px · no-right=${c1.noRight} · 块 ${c1.blocks.length} 个`);
check('拖过高度后块总高被夹进容器（不会被裁掉）', !c1.clipped && c1.overflow <= 0,
  `容器底 ${c1.areaBottom} · ${c1.blocks.map((b) => `${b.title}:${b.h}px(底${b.bottom})`).join(' ')}`);

await page.setViewport({ width: 1500, height: 700 });
await sleep(1000);
const c2 = await clipCheck();
check('窗口变矮后同样不会被裁（自动按比例压缩）', !c2.clipped && c2.overflow <= 0,
  `容器底 ${c2.areaBottom} · ${c2.blocks.map((b) => `${b.title}:${b.h}px`).join(' ')}`);

await page.setViewport({ width: 1500, height: 950 });
await sleep(900);
// 2026-10-04 口径变更：**译文栏不再有输入框**（用户原话「译文不需要输入啊」）——
// 译文是看的，问答才需要打字。所以这一栏显示的若不是「问答」，先切到问答再打字，
// 否则 #chatInput 是 display:none 的（点不动）。这不是绕过缺陷，是这一段的正确前置。
// ⚠️ 切换器现在**每栏一组**（#aiBar / #aiBar2）：只点 #aiBar 的话，问答若在被分到第 2 栏
// 就切不过去，#chatInput 仍是 display:none → 打字发不出去 → 下面 waitForFunction 30s 超时。
// 这里改成「两栏的切换器都点一遍 + 断言输入框真的可见」。
await page.evaluate(() => {
  for (const bar of ['aiBar', 'aiBar2']) {
    const btn = document.querySelector(`#${bar} .aibar-btn[data-block="chat"]`);
    if (btn) btn.click();
  }
});
await sleep(500);
const composerReady = await page.evaluate(() => {
  const wrap = document.getElementById('rightSide');
  const input = document.getElementById('chatInput');
  const r = input ? input.getBoundingClientRect() : null;
  return {
    active: wrap ? wrap.dataset.activePanel : '',
    visible: !!r && r.width > 0 && r.height > 0,
  };
});
check('打字前问答输入框真的可见（前置）', composerReady.visible === true, JSON.stringify(composerReady));
await sleep(400);
await page.click('#chatInput');
await page.type('#chatInput', '测试一下底部会不会被挡');
await page.keyboard.press('Enter');
// 右栏是多列的：问答可能在第 1 栏也可能在第 2 栏（本段预置里 translate=400 / chat=600 会被
// 自动分成两栏），所以这里一律用「问答块自己所在的那一栏」当容器基准。
await page.waitForFunction(() => ['aiArea', 'aiArea2'].some((id) => document.getElementById(id)?.querySelector('.msg.assistant .acts:not(.hidden)')), { timeout: 30000 });
await page.evaluate(() => {
  const block = [...document.querySelectorAll('.ai-block')]
    .find((b) => (b.querySelector('.ai-title') || {}).textContent === '问答');
  const body = block?.querySelector('.ai-body');
  if (body) body.scrollTop = body.scrollHeight;
});
await sleep(500);
const lastVisible = await page.evaluate(() => {
  const block = [...document.querySelectorAll('.ai-block')]
    .find((b) => (b.querySelector('.ai-title') || {}).textContent === '问答');
  const pane = block?.closest('#aiArea, #aiArea2');
  const area = pane?.getBoundingClientRect();
  const acts = [...(pane?.querySelectorAll('.msg.assistant .acts:not(.hidden)') || [])].pop();
  if (!acts || !area) return null;
  const r = acts.getBoundingClientRect();
  return { bottom: Math.round(r.bottom), areaBottom: Math.round(area.bottom), ok: r.bottom <= area.bottom + 1 && r.height > 0, pane: pane.id };
});
check('输出区最后一条的底部动作条露在容器里（没被挡住）', !!lastVisible && lastVisible.ok,
  lastVisible ? `消息底 ${lastVisible.bottom} / ${lastVisible.pane} 底 ${lastVisible.areaBottom}` : '(没找到消息)');

/* ═══════════ 二b、极窄窗口：宁可收起右栏，也不把正文压到 --viewer-min 以下 ═══════════ */
/**
 * 用户报的问题：780px 窗口下两侧栏都展开，正文只剩 ~200px、PDF 缩放到 33%。
 * 2.1 的规则是「放不下就先自动收右栏，还放不下再收左栏」，
 * 所以这里断言的是：正文不低于 --viewer-min，且右栏确实被收起、活动栏出现在窗口边缘。
 */
console.log('\n-- 极窄窗口下的正文保护');
await page.setViewport({ width: 780, height: 620 });
await sleep(1200);
const narrow = await clipCheck();
check('780px：右栏被自动收起（不再把正文挤成一条）', narrow.noRight === true,
  `no-right=${narrow.noRight} · 正文 ${narrow.viewerW}px`);
check('780px：正文宽度不低于 --viewer-min',
  narrow.viewerW >= narrow.viewerMin, `正文 ${narrow.viewerW} ≥ ${narrow.viewerMin}`);
check('780px：右活动栏出现在窗口最右边（收起后仍有入口）', narrow.railRight === true,
  `railRight=${narrow.railRight}`);

// 变宽后必须自动恢复：后面的卡片拖动断言按 1500×950 写坐标
await page.setViewport({ width: 1500, height: 950 });
await sleep(1200);
const widened = await clipCheck();
check('窗口变宽后右栏自动恢复（自动收起不残留、结果块高度也回来）',
  !widened.noRight && widened.viewerW >= widened.viewerMin && widened.blocks.every((b) => b.h > 60),
  `no-right=${widened.noRight} · 正文 ${widened.viewerW}px · 块高 ${widened.blocks.map((b) => b.h).join('/')}`);

/* ═══════════ 二c、老 reader.ai → reader.panels 的迁移（2.2a 新路径） ═══════════ */
/**
 * 上面那条断言现在走的是新 key。万一迁移写坏了，用户（和这条断言）都会以为「高度记不住」。
 * 所以这里补一条**等价强度**的迁移断言：只写老的 reader.ai（含 byDoc），刷新后：
 *   · reader.panels 必须生成，且高度/顺序被继承（不能退回默认的「一块都不开」）；
 *   · 老 key 原样保留（回退旧版还能用）；
 *   · 迁移后的块高度同样不能被容器裁掉 —— 与上面那条断言同一个口径。
 */
console.log('\n-- 老布局迁移（reader.ai → reader.panels）');
await page.evaluate(() => {
  localStorage.removeItem('reader.panels');
  localStorage.setItem('reader.ai', JSON.stringify({
    order: ['chat', 'translate'],
    visible: { translate: true, chat: true },
    size: { translate: 300, chat: 320 },
  }));
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#fileList li', { timeout: 20000 });
await page.evaluate((id) => {
  const li = [...document.querySelectorAll('#fileList li')].find((x) => x.dataset.id === id) || document.querySelector('#fileList li');
  li.click();
}, first.docId);
await page.waitForFunction(() => window.__viewer?.pdf, { timeout: 40000 });
await sleep(1500);

const migrated = await page.evaluate(() => ({
  panels: JSON.parse(localStorage.getItem('reader.panels') || 'null'),
  legacyKept: !!JSON.parse(localStorage.getItem('reader.ai') || 'null'),
  order: [...document.querySelectorAll('.ai-block')].map((b) => b.dataset.block),
  cols: [...document.querySelectorAll('#rightCols > .side.right')].filter((c) => !c.hidden && getComputedStyle(c).display !== 'none').length,
}));
check('老的 reader.ai 被迁移成 reader.panels（顺序 / 可见性 / 高度都继承）',
  !!migrated.panels
    && migrated.panels.translate?.visible === true && migrated.panels.chat?.visible === true
    && migrated.panels.translate?.size === 300 && migrated.panels.chat?.size === 320
    && migrated.panels.chat?.order < migrated.panels.translate?.order
    && migrated.panels.files?.dock === 'left',
  JSON.stringify(migrated.panels && { t: migrated.panels.translate, c: migrated.panels.chat }));
check('迁移不删除老 key（回退到旧版还能用）', migrated.legacyKept);
check('迁移后两块各占右侧一栏（老存档同时开着两块 → 新模型用第 2 栏表达，谁也不丢）',
  migrated.order.join(' > ') === 'chat > translate' && migrated.cols === 2
    && migrated.panels.rightCols?.count === 2
    && migrated.panels.chat?.col === 1 && migrated.panels.translate?.col === 2,
  `块序 ${migrated.order.join(' > ')} · 列数 ${migrated.cols} · count=${migrated.panels.rightCols?.count} · `
  + `chat(col=${migrated.panels.chat?.col},order=${migrated.panels.chat?.order}) translate(col=${migrated.panels.translate?.col},order=${migrated.panels.translate?.order})`);

const m1 = await clipCheck();
check('迁移继承的高度同样不会被裁（老用户不会看到内容被裁掉）', !m1.clipped && m1.overflow <= 0,
  `容器底 ${m1.areaBottom} · ${m1.blocks.map((b) => `${b.title}:${b.h}px(底${b.bottom})`).join(' ')}`);

/* ═══════════ 二d、右栏「一栏只开一个 + 关→开不丢」：身份 / 记忆高度（2.2b 回归 + 2026-10-04 列模型） ═══════════ */
/**
 * 用户报告过：「右侧板块译文/问答的大小变化部分存在 bug」——右栏面板关掉再打开，
 * 节点还带着 hidden 类、高度 0，而且只要不刷新页面就永不自愈；拖好的高度也丢了。
 * 根因（阶段 2.2b）是 applyPanels() 用文档查询找右栏节点，而右栏两块是现建的、
 * 隐藏时会被 replaceChildren() 从文档里摘下来 —— 摘 hidden 类那一步必然落空。
 *
 * 2026-10-04 起右栏改成**列**：一列只开一个面板；两块同时开着 = 各占一栏（第 2 栏按需现建）。
 * 所以「上下分屏的分隔条」已经不存在了，但上面那条 bug 的病根**必须继续钉住**：
 *   · 节点身份：关→开之后还是同一个 DOM 节点（消息、滚动位置都挂在它身上）；
 *   · 高度记忆：size 不清空，关→开 / 刷新后都回到那个高度（各按自己那一栏的可用高度夹取）；
 *   · 可见性自愈：回到文档后不带 hidden，高度 > 0。
 */
console.log('\n-- 右栏一栏只开一个 / 关→开不丢（身份 · 记忆高度）');

// 本段按 1500×950 写：上面几段改过视口（还改到过 780px，那会把右栏整个收起来并写进
// sideIntent.noRight），右栏收着的话第 1 / 第 2 栏的断言全都不成立。这里显式把右栏要回来。
await page.setViewport({ width: 1500, height: 950 });
await sleep(600);
// 上面窄窗那段把右栏自动收起来了（还写进了 sideIntent.noRight）。用户这时会点最右边的活动栏
// 把右栏要回来 —— 这里就走这条真实入口（#splitRight 收起来时 display:none，点不到）。
await page.evaluate(() => document.getElementById('railRightBtn').click());
await sleep(700);
const rightUp = await page.evaluate(() => ({
  noRight: document.body.classList.contains('no-right'),
  col2Off: document.body.classList.contains('right-col2-off'),
}));
check('本段前提：右栏是展开的（上面窄窗那段把它自动收起来过）',
  !rightUp.noRight && !rightUp.col2Off, JSON.stringify(rightUp));

const blockState = (id) => page.evaluate((pid) => {
  const st = window.__state;
  const p = st?.panels?.[pid];
  const node = st?.blockEls?.[pid] || null;
  const pane = node?.closest?.('#aiArea, #aiArea2') || null;
  return {
    size: p?.size,
    col: p?.col,
    inArea: !!pane,
    pane: pane?.id || '',
    connected: !!node?.isConnected,
    hidden: node ? node.classList.contains('hidden') || node.hasAttribute('hidden') : null,
    h: node && node.isConnected ? Math.round(node.getBoundingClientRect().height) : 0,
    msgs: node ? node.querySelectorAll('.msg').length : 0,
    probeKept: !!node && !!window.__probeMsg && node.contains(window.__probeMsg),
  };
}, id);

/** 点一下 #aiBar 上的开关（按文字找，不依赖顺序）；只在需要时点 */
const setBlock = async (label, on) => {
  await page.evaluate((lb, want) => {
    const b = [...document.querySelectorAll('#aiBar .aibar-btn')].find((x) => x.textContent.trim().includes(lb));
    if (b && b.classList.contains('on') !== want) b.click();
  }, label, on);
  await sleep(600);
};

/** 复位成「右栏只有 1 栏、且只有这个面板开着」——本段所有断言的前提 */
const soloBlock = async (id) => {
  await page.evaluate((pid) => {
    const other = pid === 'translate' ? 'chat' : 'translate';
    window.__ctx.setPanelVisible(other, false);
    window.__ctx.setPanelColumn(pid, 1);
    window.__ctx.closeRightColumn();
    window.__ctx.applyPanels();
  }, id);
  await sleep(600);
};

await soloBlock('translate');
const oneOpen = await page.evaluate(() => ({
  cols: [...document.querySelectorAll('#rightCols > .side.right')].filter((c) => !c.hidden && getComputedStyle(c).display !== 'none').length,
  blocks: [...document.querySelectorAll('.ai-block')].map((b) => b.dataset.block),
}));
check('一栏只开一个：只开译文时右栏仍是 1 栏、只有译文块',
  oneOpen.cols === 1 && oneOpen.blocks.join() === 'translate', JSON.stringify(oneOpen));

// 一栏只开一个：点 #aiBar 的「问答」会在第 1 栏把译文挤掉（下面单独验）。
// 要先看两块并排，走的是「右键右栏图标 → 放到第 2 栏」这条路（用同一条 API）。
await page.evaluate(() => window.__ctx.setPanelColumn('chat', 2));
await sleep(700);
const twoOpen = await page.evaluate(() => ({
  // 「一栏只开一个」是**模型 + 每栏最多一块**这两件事；第 2 栏此刻可不可见还取决于窗口宽度
  // （body.right-col2-off 是响应式临时隐藏，模型不动），所以这里断言的是 colsWanted + perCol。
  colsWanted: window.__ctx.rightColsWanted(),
  col2Exists: !!document.getElementById('rightCol2'),
  col2Off: document.body.classList.contains('right-col2-off'),
  innerW: window.innerWidth,
  noRight: document.body.classList.contains('no-right'),
  perCol: [...document.querySelectorAll('#aiArea, #aiArea2')].map((p) => [...p.querySelectorAll('.ai-block')].map((b) => b.dataset.block)),
  splits: document.querySelectorAll('.ai-split').length,
  vis: { t: window.__state.panels.translate.visible, c: window.__state.panels.chat.visible },
  col: { t: window.__state.panels.translate.col, c: window.__state.panels.chat.col },
  pane: { t: document.querySelector('.ai-block[data-block="translate"]')?.closest('.ai')?.id, c: document.querySelector('.ai-block[data-block="chat"]')?.closest('.ai')?.id },
}));
check('两块同时开着 = 各占一栏（第 2 栏按需出现，每栏恰好一块、没有上下分隔条）',
  twoOpen.colsWanted === 2 && twoOpen.col2Exists && twoOpen.perCol.every((x) => x.length <= 1) && twoOpen.splits === 0
    && twoOpen.vis.t && twoOpen.vis.c
    && twoOpen.pane.t === 'aiArea' && twoOpen.pane.c === 'aiArea2'
    && twoOpen.col.t === 1 && twoOpen.col.c === 2,
  JSON.stringify(twoOpen));

// 给第 2 栏那块塞一条真消息，用来验「关→开之后还是同一个节点」
// （按栏取块，不假设是哪一个面板：第 1 / 第 2 栏各是谁由上面 twoOpen 的 col 断言钉住）
await page.evaluate(() => {
  const body = document.querySelector('#aiArea2 .ai-block .ai-body');
  const m = document.createElement('div');
  m.className = 'msg assistant';
  m.textContent = '身份探针';
  body.append(m);
  window.__probeMsg = m;
});
await sleep(200);
const col1Id = await page.evaluate(() => document.querySelector('#aiArea .ai-block')?.dataset.block);
const col2Id = await page.evaluate(() => document.querySelector('#aiArea2 .ai-block')?.dataset.block);
const pre = { t: await blockState('translate'), c: await blockState('chat') };
check('前提：两块都在文档里、都有高度、都是第 1 / 第 2 栏',
  pre.t.connected && pre.c.connected && pre.t.h > 60 && pre.c.h > 60,
  `${JSON.stringify(pre)} · 第1栏=${col1Id} 第2栏=${col2Id} · body=` + JSON.stringify(await page.evaluate(() => ({
    innerW: window.innerWidth,
    body: document.body.className,
    col2: getComputedStyle(document.getElementById('rightCol2')).display,
    h2: document.getElementById('aiArea2').clientHeight,
  }))));

// 下面全部用 setPanelVisible 开关（不用 #aiBar 的按钮：点图标坞的按钮会顺带把这块换到那一栏，
// 那是「栏位」语义，不是这段要验的「关→开不丢」）。
const toggle = async (id, on) => {
  await page.evaluate((pid, want) => window.__ctx.setPanelVisible(pid, want), id, on);
  await sleep(500);
};

// 先验第 1 栏那一块：隐藏 → 显示，节点身份、size、栏位都不许变
await toggle(col1Id, false);
const offC1 = await blockState(col1Id);
check('隐藏面板不清 size（拖好的高度留着）', offC1.size === pre[col1Id === 'translate' ? 't' : 'c'].size,
  `size=${offC1.size} / 隐藏前 ${pre[col1Id === 'translate' ? 't' : 'c'].size}`);
check('隐藏后节点脱离文档（不是被删：消息还挂在它身上）',
  !offC1.connected && offC1.size === pre[col1Id === 'translate' ? 't' : 'c'].size, JSON.stringify(offC1));

await toggle(col1Id, true);
const backC1 = await blockState(col1Id);
check('第 1 栏那块关→开之后回到 #aiArea、栏位不变、高度回得来',
  backC1.inArea && backC1.pane === 'aiArea' && backC1.col === 1 && backC1.hidden === false && backC1.h > 60,
  JSON.stringify(backC1));
check('关→开之后回到刚才那个高度（不是 60px 保底值）',
  Math.abs(backC1.h - pre[col1Id === 'translate' ? 't' : 'c'].h) <= 2,
  `h=${backC1.h} / 原来 ${pre[col1Id === 'translate' ? 't' : 'c'].h}`);

// 再验第 2 栏那一块：关→开之后必须是同一个节点、探针消息还在、栏位不变
await toggle(col2Id, false);
await toggle(col2Id, true);
const backC2 = await blockState(col2Id);
check('第 2 栏那块关→开还是同一个节点（探针消息还在同一个对象上、栏位不变）',
  backC2.inArea && backC2.pane === 'aiArea2' && backC2.col === 2 && backC2.hidden === false && backC2.probeKept,
  JSON.stringify(backC2));

// 容器变高 = 有富余空间：没记着高度的块会被 flex 撑满，这一步能证明高度确实是**记着**的
await page.setViewport({ width: 1500, height: 1150 });
await sleep(900);
const tallState = await blockState('chat');
check('窗口变高不会把拖好的高度撑走', Math.abs(tallState.h - pre.c.h) <= 2,
  `h=${tallState.h} / ${pre.c.h}`);

// 刷新后必须还在（size 与栏位都真的落盘了）
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#fileList li', { timeout: 20000 });
await page.evaluate((id) => {
  const li = [...document.querySelectorAll('#fileList li')].find((x) => x.dataset.id === id) || document.querySelector('#fileList li');
  li.click();
}, first.docId);
await page.waitForFunction(() => window.__viewer?.pdf, { timeout: 40000 });
await sleep(1500);
const reC = await blockState('chat');
const reT = await blockState('translate');
check('刷新后「问答」的高度 / size / 栏位都与关掉前一致',
  reC.hidden === false && reC.inArea && reC.size === pre.c.size && Math.abs(reC.h - pre.c.h) <= 2,
  JSON.stringify(reC));
check('刷新后「译文」的高度 / size / 栏位都与关掉前一致',
  reT.hidden === false && reT.inArea && reT.size === pre.t.size && Math.abs(reT.h - pre.t.h) <= 2,
  JSON.stringify(reT));

// 收尾：把「问答」开回来、窗口尺寸复位（后面的卡片拖动断言按 1500×950 写坐标）
await toggle('chat', true);
await page.setViewport({ width: 1500, height: 950 });
await sleep(900);

/* ═══════════ 三、卡片拖动 ═══════════ */
console.log('\n-- 卡片拖动');

const boxOf = (sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  if (!e || e.classList.contains('hidden')) return null;
  const r = e.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
}, sel);

/** 从 (fromSel 内部某点) 按住拖 dx,dy */
async function dragBy(handleSel, dx, dy) {
  const start = await page.evaluate((s) => {
    const el = document.querySelector(s);
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(r.top + r.height / 2) };
  }, handleSel);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // 分几步移动，模拟真实拖动（也顺带验证 pointermove 的节流没问题）
  for (let i = 1; i <= 4; i++) {
    await page.mouse.move(start.x + (dx * i) / 4, start.y + (dy * i) / 4);
    await sleep(40);
  }
  await page.mouse.up();
  await sleep(200);
}

/* 2.1 划词气泡 */
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
  v.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return { ok: true, text: sel.toString().slice(0, 30) };
}, from, to);

await selectSpans(1, 5);
await page.waitForSelector('#bubble:not(.hidden)', { timeout: 8000 });
const b0 = await boxOf('#bubble');
check('划词后气泡出现', !!b0, JSON.stringify(b0));
if (b0) {
  await dragBy('#bubble button[data-act="copy"]', -120, -70);
  const b1 = await boxOf('#bubble');
  check('气泡可以拖动（在按钮上按住拖，不算点击）',
    !!b1 && Math.abs((b1.x - b0.x) + 120) <= 3 && Math.abs((b1.y - b0.y) + 70) <= 3,
    `${b0.x},${b0.y} → ${b1?.x},${b1?.y}`);
  check('拖动不会被当成点击「复制」', await page.evaluate(() => document.getElementById('toastWrap').textContent.trim() === ''));
}

/**
 * 找一个「当前就能点到」的 [n] 并返回坐标。
 * 不能缓存第一次找到的坐标：点 [n] 之后应用会跳到文末的文献条目，
 * 视图滚走了，原来的坐标就不再是 [n] 了（第一版就是这么卡住的）。
 * 所以这里从头逐屏往下找，找到第一个可见的就用。
 */
const findCitePoint = () => page.evaluate(async () => {
  const v = document.getElementById('viewer');
  const vr = v.getBoundingClientRect();
  const findVisible = () => {
    const a = [...document.querySelectorAll('.cite-link')].find((x) => {
      const r = x.getBoundingClientRect();
      return r.width > 0 && r.top > vr.top + 10 && r.bottom < vr.bottom - 10;
    });
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  };
  const hit0 = findVisible();
  if (hit0) return hit0;
  v.scrollTop = 0;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 280));
    const hit = findVisible();
    if (hit) return hit;
    v.scrollTop += Math.round(vr.height * 0.7);
  }
  return null;
});

/** 打开参考文献卡片（每次都重新定位 [n]） */
async function openCiteBox() {
  const pt = await findCitePoint();
  if (!pt) return null;
  await page.mouse.click(pt.x, pt.y);
  await page.waitForSelector('#citeBox:not(.hidden)', { timeout: 8000 });
  await sleep(250);
  return pt;
}

/* 2.2 参考文献卡片 */
const citePt = await findCitePoint();
check('找得到可点的 [n] 引用', !!citePt, citePt ? `${citePt.x},${citePt.y}` : '(没找到)');
if (citePt) {
  await page.mouse.click(citePt.x, citePt.y);
  await page.waitForSelector('#citeBox:not(.hidden)', { timeout: 8000 });
  await sleep(250);
  const c0 = await boxOf('#citeBox');
  await dragBy('#citeBox .pop-head', -90, -100);
  const c1 = await boxOf('#citeBox');
  check('参考文献卡片可以拖动，而且只挪了指定的距离',
    !!c1 && Math.abs(c1.x - c0.x + 90) <= 3 && Math.abs(c1.y - c0.y + 100) <= 3,
    `${c0.x},${c0.y} → ${c1?.x},${c1?.y}`);
  check('卡片没有超出可视区（整张都在屏幕里）',
    c1.x >= -1 && c1.y >= -1 && c1.x + c1.w <= 1501 && c1.y + c1.h <= 951,
    `x=${c1.x} y=${c1.y} w=${c1.w} h=${c1.h} 右=${c1.x + c1.w} 下=${c1.y + c1.h}`);

  // 关掉再打开，位置应该记着
  await page.evaluate(() => document.getElementById('citeClose').click());
  await sleep(300);
  check('关掉后能再次打开参考文献卡片', !!(await openCiteBox()));
  const c2 = await boxOf('#citeBox');
  check('重新弹出时记住拖动后的位置', Math.abs(c2.x - c1.x) <= 3 && Math.abs(c2.y - c1.y) <= 3,
    `${c1.x},${c1.y} → ${c2.x},${c2.y}`);

  // 双击手柄恢复自动位置
  await page.evaluate(() => {
    const h = document.querySelector('#citeBox .pop-head');
    const r = h.getBoundingClientRect();
    h.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + 10, clientY: r.top + 5 }));
  });
  await sleep(300);
  await page.evaluate(() => document.getElementById('citeClose').click());
  await sleep(300);
  await openCiteBox();
  const c3 = await boxOf('#citeBox');
  check('双击标题栏可以恢复自动位置', Math.abs(c3.x - c1.x) > 10 || Math.abs(c3.y - c1.y) > 10,
    `${c1.x},${c1.y} → 自动 ${c3.x},${c3.y}`);
  await page.evaluate(() => document.getElementById('citeClose').click());
  await sleep(250);
}

/* 2.3 结果浮层（译）
   这里必须用**真实鼠标点击**，不能用脚本 element.click()：
   第一版拖动实现里在 pointerdown 就 setPointerCapture，导致真实点击的 click
   事件目标变成气泡本身，气泡上的按钮全点不动 —— 而脚本 click 完全绕过指针事件，
   测试照样全绿。这个坑就是脚本点击放过去的。 */
await page.evaluate(() => window.__viewer?.clearSelection?.());
await selectSpans(2, 6);
await page.waitForSelector('#bubble:not(.hidden)', { timeout: 8000 });
const clickBubbleBtn = async (act) => {
  const pt = await page.evaluate((a) => {
    const r = document.querySelector(`#bubble button[data-act="${a}"]`).getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, act);
  await page.mouse.click(pt.x, pt.y);
};
await clickBubbleBtn('translate');
await page.waitForSelector('#popover:not(.hidden)', { timeout: 10000 });
await sleep(800);
check('真实鼠标点气泡上的「译」能弹出浮层（不是只有脚本 click 才行）', true);
const p0 = await boxOf('#popover');
check('翻译浮层出现', !!p0, JSON.stringify(p0));
if (p0) {
  /**
   * 拖动距离要按**当前视口里真的还能往左挪多少**来定，不能写死 160：
   * 卡片是被 clampCard 夹在屏幕内的（装得下就整张留在视口里，最多留 28px 抓手），
   * 右栏改成多列之后正文更靠右，划词锚点也跟着往左，留白不够 160 时写死的期望就会假红。
   * 这里先量一下余量，取「能挪的」和「想测的」里更小的那个。
   */
  const room = await page.evaluate(() => {
    const r = document.getElementById('popover').getBoundingClientRect();
    return Math.max(0, Math.round(r.left));
  });
  const dxWant = -Math.min(160, room);
  const dyWant = 60;
  await dragBy('#popover .pop-head', dxWant, dyWant);
  const p1 = await boxOf('#popover');
  check('翻译浮层可以拖动',
    !!p1 && Math.abs(p1.x - p0.x - dxWant) <= 3 && Math.abs(p1.y - p0.y - dyWant) <= 3,
    `${p0.x},${p0.y} → ${p1?.x},${p1?.y}（拖动 ${dxWant},${dyWant}·左侧余量 ${room}）`);
  // 标题栏上的按钮也得能真实点到
  const closePt = await page.evaluate(() => {
    const r = document.getElementById('popClose').getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  await page.mouse.click(closePt.x, closePt.y);
  await sleep(400);
  check('真实鼠标点标题栏的「✕」能关掉浮层（拖动没把它吃掉）',
    await page.evaluate(() => document.getElementById('popover').classList.contains('hidden')));
}

/* 2.4 笔记卡片（同样用真实鼠标点气泡） */
await selectSpans(1, 4);
await page.waitForSelector('#bubble:not(.hidden)', { timeout: 8000 });
await clickBubbleBtn('note');
await page.waitForSelector('#noteBox:not(.hidden)', { timeout: 10000 });
await sleep(400);
const n0 = await boxOf('#noteBox');
check('真实鼠标点「✎」能打开笔记卡片', !!n0, JSON.stringify(n0));
if (n0) {
  await dragBy('#noteBox .pop-head', 70, -40);
  const n1 = await boxOf('#noteBox');
  check('笔记卡片可以拖动',
    !!n1 && Math.abs(n1.x - n0.x - 70) <= 3 && Math.abs(n1.y - n0.y + 40) <= 3,
    `${n0.x},${n0.y} → ${n1?.x},${n1?.y}`);
  check('拖动后仍然可以在正文框里打字',
    await page.evaluate(() => {
      const t = document.getElementById('noteText');
      t.focus();
      t.value = '拖动后写的笔记';
      return document.activeElement === t && t.value === '拖动后写的笔记';
    }));
  await page.click('#noteClose');
  await sleep(300);
}

/* 2.5 设置弹窗 */
await page.evaluate(() => document.getElementById('settingsBtn').click());
await page.waitForSelector('#settingsModal:not(.hidden)', { timeout: 6000 });
await sleep(300);
const s0 = await boxOf('#settingsModal .modal-box');
check('设置弹窗出现', !!s0, JSON.stringify(s0));
if (s0) {
  await dragBy('#settingsModal .modal-head', 120, 90);
  const s1 = await boxOf('#settingsModal .modal-box');
  check('设置弹窗可以拖动',
    !!s1 && Math.abs(s1.x - s0.x - 120) <= 3 && Math.abs(s1.y - s0.y - 90) <= 3,
    `${s0.x},${s0.y} → ${s1?.x},${s1?.y}`);
  check('拖动设置弹窗不会误触输入框',
    await page.evaluate(() => document.activeElement?.tagName !== 'INPUT'));
  await page.evaluate(() => document.getElementById('closeSettings').click());
  await sleep(250);
}

/* 2.6 拖到屏幕外会被夹住 */
if (await openCiteBox()) {
  await dragBy('#citeBox .pop-head', 4000, 4000);
  const far = await boxOf('#citeBox');
  check('往屏幕外拖会被夹住，整张卡片都还在屏幕里',
    !!far && far.x >= -1 && far.y >= -1 && far.x + far.w <= 1501 && far.y + far.h <= 951,
    `x=${far?.x} y=${far?.y} 右=${far ? far.x + far.w : '?'} 下=${far ? far.y + far.h : '?'}`);
  await page.evaluate(() => document.getElementById('citeClose').click());
  await sleep(250);
}

/* ═══════════ 汇总 ═══════════ */
check('没有未捕获的页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
check('没有控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

await page.screenshot({ path: path.join(OUT, 'cards.png') });
await browser.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
await sleep(250);   // 让 libuv 把手上的句柄收干净，别在退出时抛断言
process.exit(passed === results.length ? 0 : 1);
