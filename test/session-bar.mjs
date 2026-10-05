/**
 * 会话条（多对话）版式与显示条件
 *   node test/session-bar.mjs
 *
 * 用户口径（2026-10）：「问答和翻译都有那个多对话的标」—— 要修的就是这块：
 *   ① 会话条**只在问答块开着时**出现（会话 = 一篇论文的对话，跟译文无关）
 *   ② 去掉不承载信息的绿色圆点，换成一个细线「会话」图标
 *   ③ 不再是一个占满整行的带边框块，而是右上角一个很轻的小胶囊
 *      （文字用次级灰，悬停/展开才变强调色），面板顶部不再压一条绿边
 *   ④ 胶囊与菜单都不跑出右栏、不盖住输入框；菜单里能看出哪条会话是当前
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';

const scratch = fs.mkdtempSync(path.join(SANDBOX, 'sessbar-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), path.join(PAPERS, 'sess-fixture.pdf'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (n, ok, d = '') => { checks.push({ n, ok }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };

async function findPort() {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const p = probe.address().port;
  await new Promise((r) => probe.close(r));
  return p;
}

let browser;
let server;
try {
  const port = await findPort();
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS, NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1' },
    stdio: 'ignore',
  });
  const BASE = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) { await wait(100); try { ready = (await fetch(`${BASE}/api/health`)).ok; } catch { /* wait */ } }
  check('隔离服务启动', ready);
  if (!ready) throw new Error('服务没起来');
  await fetch(`${BASE}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: 'http://127.0.0.1:1/v1', model: 'sess', apiKey: 'sess-key' }),
  });

  browser = await puppeteer.launch({
    executablePath: process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'shell', args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 1500, height: 950 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`${BASE}/?open=${encodeURIComponent('sess-fixture.pdf')}&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 30000 });
  await wait(600);

  const barState = () => page.evaluate(() => {
    const bar = document.querySelector('#sessBar');
    const btn = document.querySelector('#sessBtn');
    if (!bar || !btn) return null;
    const br = bar.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    const cs = getComputedStyle(btn);
    const bcs = getComputedStyle(bar);
    const contentRight = br.right - parseFloat(bcs.paddingRight || '0');
    return {
      barHidden: bar.classList.contains('hidden'),
      label: document.querySelector('#sessLabel')?.textContent || '',
      hasDot: !!document.querySelector('.sess-dot'),
      hasIcon: !!document.querySelector('.sess-ic svg'),
      barWidth: Math.round(br.width),
      btnWidth: Math.round(b.width),
      btnLeft: Math.round(b.x),
      barRight: Math.round(br.right),
      color: cs.color,
      bg: cs.backgroundColor,
      borderColor: cs.borderTopColor,
      expanded: btn.getAttribute('aria-expanded'),
      ariaLabel: btn.getAttribute('aria-label') || '',
      // 靠右对齐：按钮右边缘贴在内容盒右边缘（栏自身还有内边距，所以比的是内容盒）
      rightAnchored: Math.abs(contentRight - b.right) < 2.5,
      strayPx: Math.round(Math.abs(contentRight - b.right)),
    };
  });

  /* 问答块开着时的形态 */
  await page.evaluate(() => { window.__ctx.setPanelVisible('chat', true); document.body.classList.remove('no-right'); });
  await wait(500);
  const onChat = await barState();
  check('① 问答块开着时显示会话条', !!onChat && !onChat.barHidden, JSON.stringify(onChat && { label: onChat.label }));
  check('② 绿色圆点已经去掉', !onChat?.hasDot, '');
  check('② 换成了细线会话图标', !!onChat?.hasIcon, '');
  check('③ 文字用次级灰（不是强调色）', onChat?.color === 'rgb(119, 120, 108)', onChat?.color);
  check('③ 没有底色、没有边框（不再是一条压边的块）',
    (onChat?.bg === 'rgba(0, 0, 0, 0)' || onChat?.bg === 'transparent') && onChat?.borderColor === 'rgba(0, 0, 0, 0)',
    `${onChat?.bg} / ${onChat?.borderColor}`);
  check('③ 是小胶囊而不是整行（宽度 < 120px，且靠右）',
    onChat.btnWidth < 120 && onChat.rightAnchored && onChat.btnWidth < onChat.barWidth,
    `btn=${onChat.btnWidth} bar=${onChat.barWidth} 距右=${onChat.strayPx}px`);
  check('① 默认会话不撒谎：显示中性「会话」而不是「默认会话」',
    onChat.label === '会话', onChat.label);
  check('可访问名交代了当前会话与点击行为', /当前会话/.test(onChat?.ariaLabel || ''), (onChat?.ariaLabel || '').slice(0, 30));

  /* 右栏顶部只能有一种底色：标签行 / 会话条 / 结果区都跟着面板走。
     （.aibar 在本文件里有多处定义，最后一条曾经把背景又写成 --bg-elev，
       于是顶部压出一条更亮的横条 —— 这条断言就是焊住它的。） */
  const surfaces = await page.evaluate(() => {
    const bg = (s) => { const el = document.querySelector(s); return el ? getComputedStyle(el).backgroundColor : null; };
    return { panel: bg('#rightSide'), aibar: bg('#aiBar'), sessbar: bg('#sessBar'), aiArea: bg('#aiArea') };
  });
  const isSame = (a, b) => a === b || b === 'rgba(0, 0, 0, 0)';
  check('右栏顶部没有更亮的横条（标签行/会话条/结果区同底色）',
    isSame(surfaces.panel, surfaces.aibar) && isSame(surfaces.panel, surfaces.sessbar) && isSame(surfaces.panel, surfaces.aiArea),
    JSON.stringify(surfaces));

  /* 悬停才变强调色 */
  await page.hover('#sessBtn');
  await wait(200);
  const hovered = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('#sessBtn'));
    return { color: cs.color, bg: cs.backgroundColor };
  });
  check('悬停时变强调色 + 一层浅底', hovered.color === 'rgb(85, 107, 47)' && hovered.bg !== 'rgba(0, 0, 0, 0)',
    `${hovered.color} / ${hovered.bg}`);

  /* 菜单 */
  await page.click('#sessBtn');
  await wait(500);
  const menu = await page.evaluate(() => {
    const m = document.querySelector('#sessionMenu');
    const r = m.getBoundingClientRect();
    const box = document.querySelector('#rightSide').getBoundingClientRect();
    return {
      open: !m.classList.contains('hidden'),
      expanded: document.querySelector('#sessBtn').getAttribute('aria-expanded'),
      insideRight: r.x >= box.x - 1 && r.right <= box.right + 1,
      rows: document.querySelectorAll('.sess-row').length,
      newText: document.querySelector('.sess-new')?.textContent || '',
      clearText: document.querySelector('.sess-clear')?.textContent || '',
      dashed: getComputedStyle(document.querySelector('.sess-new') || document.body).borderStyle,
      hasHead: !!document.querySelector('.sess-head'),
    };
  });
  check('④ 点开会话菜单（芯片进入展开态）', menu.open && menu.expanded === 'true', '');
  check('④ 菜单不跑出右栏', menu.insideRight, '');
  check('④ 有会话标题头（写明是哪篇论文的会话）', menu.hasHead, '');
  check('④「新建会话 / 清空当前会话」降为普通菜单项（没有虚线框）',
    menu.newText === '新建会话' && menu.clearText === '清空当前会话' && menu.dashed !== 'dashed',
    `${menu.newText} / ${menu.clearText} / ${menu.dashed}`);
  await page.screenshot({ path: path.join(ROOT, 'design', 'screens-theme', 'session-menu.png') });

  /* 切到译文块：会话条必须消失 */
  await page.keyboard.press('Escape');
  await wait(200);
  const onTranslate = await page.evaluate(async () => {
    window.__ctx.setPanelVisible('translate', true);
    await new Promise((r) => setTimeout(r, 200));
    const bar = document.querySelector('#sessBar');
    return {
      translateVisible: window.__state.panels.translate.visible,
      chatVisible: window.__state.panels.chat.visible,
      barHidden: bar.classList.contains('hidden'),
      activePanel: document.querySelector('#rightSide')?.dataset.activePanel,
    };
  });
  check('① 切到译文后会话条消失（这就是「两边都有」的根因）',
    onTranslate.translateVisible && !onTranslate.chatVisible && onTranslate.barHidden,
    JSON.stringify(onTranslate));

  /* 回到问答：又出现 */
  const backToChat = await page.evaluate(async () => {
    window.__ctx.setPanelVisible('chat', true);
    await new Promise((r) => setTimeout(r, 200));
    return { barHidden: document.querySelector('#sessBar').classList.contains('hidden') };
  });
  check('① 切回问答后会话条回来', !backToChat.barHidden, '');

  check('整页无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));

  /* 分隔条宽度（2026-10 用户口径：「拉动的那个栏稍微做宽一点」）
     宽度有两个消费方：CSS 的 flex 基准与 app.js 的 SPLIT_W —— 必须一致，
     否则「窗口多宽才自动收侧栏」的判断会偏几个像素。这条断言就是焊住它俩的。 */
  const split = await page.evaluate(() => {
    const el = document.getElementById('splitLeft');
    const el2 = document.getElementById('splitRight');
    const ai = document.querySelector('.ai-split');
    return {
      left: el ? Math.round(el.getBoundingClientRect().width) : 0,
      right: el2 ? Math.round(el2.getBoundingClientRect().width) : 0,
      ai: ai ? Math.round(ai.getBoundingClientRect().width) : 0,
      cssFlex: el ? getComputedStyle(el).flexBasis : '',
      js: window.__ctx.SPLIT_W,
    };
  });
  /* 滚动条加宽（2026-10 用户口径：「PDF 上下滚动的那个栏稍微做宽一点」）。
     无头 Chrome 用**覆盖式**滚动条（不占布局宽度，offsetWidth-clientWidth 恒为 0），
     所以这里验的是**伪元素的计算样式** —— 它证明规则确实命中了那个滚动容器。
     要验的主容器：PDF 正文区 .viewer、右栏结果区 #aiArea（.ai）。 */
  const sb = await page.evaluate(() => {
    const read = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const bar = getComputedStyle(el, '::-webkit-scrollbar');
      const thumb = getComputedStyle(el, '::-webkit-scrollbar-thumb');
      return { w: bar.width, h: bar.height, thumb: thumb.backgroundColor, radius: thumb.borderRadius };
    };
    return { viewer: read('#viewer'), ai: read('#aiArea'), side: read('#leftSide'), token: getComputedStyle(document.documentElement).getPropertyValue('--scroll-thumb').trim() };
  });
  check('PDF 正文区的滚动条加宽到 16px 且规则命中',
    sb.viewer?.w === '16px' && sb.viewer?.h === '16px', JSON.stringify(sb.viewer));
  check('右栏结果区的滚动条同样加宽', sb.ai?.w === '16px', JSON.stringify(sb.ai));
  check('左栏滚动条同样加宽', sb.side?.w === '16px', JSON.stringify(sb.side));
  check('滑块用色板颜色（不是系统灰）',
    sb.viewer?.thumb === 'rgb(213, 206, 180)' && sb.token === '#D5CEB4' && sb.viewer?.radius === '8px',
    `${sb.viewer?.thumb} / ${sb.viewer?.radius}`);
  check('分隔条没有被顺手改宽（回到 5px / 6px）',
    split.left === 5 && split.right === 5 && split.js === 5, JSON.stringify({ l: split.left, r: split.right, js: split.js }));

  /* 加宽后拖动仍然可用：拖 40px，左栏宽度应跟着变 */
  const dragged = await page.evaluate(async () => {
    const sp = document.getElementById('splitLeft');
    const r = sp.getBoundingClientRect();
    const before = document.getElementById('leftSide').getBoundingClientRect().width;
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    const fire = (type, cx) => sp.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: cx, clientY: y, buttons: 1, pointerId: 1 }));
    sp.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, buttons: 1, pointerId: 1 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x + 40, clientY: y, buttons: 1, pointerId: 1 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x + 40, clientY: y, buttons: 1, pointerId: 1 }));
    void fire;
    await new Promise((res) => setTimeout(res, 300));
    return { before: Math.round(before), after: Math.round(document.getElementById('leftSide').getBoundingClientRect().width) };
  });
  check('加宽后仍然拖得动（左栏宽度跟着变）',
    Math.abs(dragged.after - dragged.before) >= 20, `${dragged.before}px → ${dragged.after}px`);

  console.log('\n════════════════════════════════════════');
  const failed = checks.filter((c) => !c.ok);
  console.log(`会话条版式验收：${checks.length} 条断言，失败 ${failed.length} 条`);
  if (failed.length) { failed.forEach((c) => console.log(`  · ${c.n}`)); process.exitCode = 1; } else { console.log('全部通过。'); }
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
}
