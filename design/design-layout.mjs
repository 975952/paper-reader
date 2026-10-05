/* ═══════════════════════════════════════════════════════════════════════════
   design-layout.mjs —— 版面几何体检（代替肉眼看图的机械部分）
   ───────────────────────────────────────────────────────────────────────────
   检查肉眼最容易漏、但一定会被看出来的问题：
     · 溢出 / 裁切：任何元素超出容器、文字被截断、横向滚动条
     · 对齐：右边一排图标是否共右基线，卡片间距是否一致
     · 节奏：正文与操作条的行距、内边距是否在合理区间（不太挤也不太散）
     · 层级：回答正文是否真的比其它文字更醒目（字号 / 颜色对比度）
     · 遮挡：浮动元素是否压住正文或输入框
   用法：node design/design-layout.mjs
   ═══════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// 默认用 file:// 直开；也可以用 BASE=http://127.0.0.1:PORT/design 走静态服务
const PAGE = process.env.BASE
  ? `${process.env.BASE.replace(/\/$/, '')}/reader.html`
  : pathToFileURL(path.join(HERE, 'reader.html')).href;

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('找不到 Chrome');
}

const puppeteer = (await import(pathToFileURL(path.join(ROOT, 'test', 'node_modules', 'puppeteer-core', 'lib', 'esm', 'puppeteer', 'puppeteer-core.js')).href)).default;

const STATES = [
  'settings-light', 'settings-dark', 'answer-basic', 'answer-evidence', 'answer-jump',
  'answer-note', 'answer-menu', 'icon-hover', 'range-collapsed', 'range-expanded',
  'range-web', 'gen-streaming', 'gen-stopped', 'gen-failed', 'dark-answer', 'dark-range', 'dark-failed'
];

let fails = 0;
const report = [];
function check(name, ok, detail) {
  report.push({ name, ok, detail: detail || '' });
  if (!ok) fails++;
  console.log(`[${ok ? '  ok  ' : ' FAIL '}] ${name}${detail ? '  — ' + detail : ''}`);
}

const browser = await puppeteer.launch({ executablePath: findChrome(), headless: 'new', args: ['--allow-file-access-from-files', '--hide-scrollbars'] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });

for (const id of STATES) {
  await page.goto(`${PAGE}?state=${id}`, { waitUntil: 'load' });
  if (id === 'gen-streaming') {
    await page.waitForSelector('[data-action="stop"]', { timeout: 5000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
  } else {
    await new Promise((r) => setTimeout(r, 600));
  }

  const m = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const qa = (s) => Array.from(document.querySelectorAll(s));
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; };
    const px = (v) => parseFloat(v) || 0;

    /* 1) 溢出：元素内容宽于自身（不含刻意省略号的元素，也不含视觉隐藏元素） */
    const overflows = [];
    for (const el of qa('.assistant *, .viewer *, .settings *')) {
      if (el.closest('.pdf-scroll') && !el.closest('.page')) continue;
      const s = getComputedStyle(el);
      if (s.textOverflow === 'ellipsis' || s.overflowX === 'auto' || s.overflowX === 'scroll') continue;
      if (s.position === 'absolute' && s.clip !== 'auto') continue;   /* .sr-only */
      if (el.classList.contains('sr-only')) continue;
      // 隐藏状态（设置页打开时阅读区被 display:none）不参与测量
      if (!el.offsetParent && s.position !== 'fixed') continue;
      if (el.scrollWidth - el.clientWidth > 2 && el.clientWidth > 0) {
        overflows.push(`${el.className || el.tagName} +${el.scrollWidth - el.clientWidth}px`);
      }
    }

    /* 2) 横向滚动条 */
    const hScroll = qa('body *').filter((el) => el.scrollWidth - el.clientWidth > 4 && getComputedStyle(el).overflowX === 'visible').length;

    /* 3) 卡片几何 */
    const card = q('.card');
    const body = q('[id^=body-]');
    const bar = q('.card-bar');
    const cardBox = card ? rect(card) : null;
    const bodyBox = body ? rect(body) : null;
    const barBox = bar ? rect(bar) : null;

    /* 4) 底部图标是否等距、共基线 */
    const barBtns = qa('.card-bar .ic-btn').map((b) => rect(b));
    const barGaps = [];
    for (let i = 1; i < barBtns.length; i++) barGaps.push(Math.round(barBtns[i].x - barBtns[i - 1].r));
    const sameBaseline = barBtns.every((b) => Math.abs(b.y - barBtns[0].y) < 1.5);

    /* 5) 回答正文是否比周边文字更醒目 */
    const answerStyle = body ? getComputedStyle(body) : null;
    const qStyle = q('.card-q') ? getComputedStyle(q('.card-q')) : null;
    const hintStyle = getComputedStyle(q('.as-title') || document.body);

    /* 6) 右栏宽度与阅读区宽度 */
    const asBox = rect(q('.assistant'));
    const viewerBox = rect(q('.viewer'));
    const pageBox = q('.page') ? rect(q('.page')) : null;

    /* 7) 发送框是否固定底部、是否遮挡卡片 */
    const composerBox = rect(q('.composer'));
    const listBox = rect(q('.as-list'));
    const overlap = cardBox && composerBox && cardBox.b < composerBox.y ? 0 : 0;
    const scrollBox = rect(q('.as-scroll'));

    /* 8) 触碰区尺寸（所有可点控件的命中框） */
    const small = qa('button, .ev-item, .rp-opt').filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      return r.height < 20 || r.width < 18;
    }).map((el) => `${el.className || el.tagName}:${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`);

    /* 9) 浮动元素是否压住文字（菜单/提示按设计会浮在卡片上方，但不该压输入框） */
    const floatOverlap = [];
    const floatEls = [q('#hintbar'), q('#tip'), q('#cardMenu'), q('#inputMenu')].filter((el) => el && !el.hidden && getComputedStyle(el).display !== 'none');
    for (const f of floatEls) {
      const fr = rect(f);
      for (const t of [q('#chatInput'), q('.cp-bar'), q('#cpScope'), q('#btnSend')]) {
        if (!t) continue;
        const tr = rect(t);
        const hit = fr.x < tr.r && fr.r > tr.x && fr.y < tr.b && fr.b > tr.y;
        if (hit) floatOverlap.push(`${f.className} over ${t.className || t.id}`);
      }
      // 浮层不能超出窗口
      if (fr.x < 0 || fr.y < 0 || fr.r > window.innerWidth || fr.b > window.innerHeight) {
        floatOverlap.push(`${f.className} 超出窗口`);
      }
    }

    /* 10) 依据条目内部对齐 */
    const evRow = q('.ev-item');
    const evParts = evRow ? {
      h: rect(evRow).h,
      quoteClamp: getComputedStyle(q('.ev-quote')).webkitLineClamp
    } : null;

    return {
      overflows: overflows.slice(0, 6), hScroll,
      cardBox, bodyBox, barBox, composerBox, scrollBox, asBox, viewerBox, pageBox, listBox, overlap,
      footBox: rect(q('.assistant')),
      windowH: window.innerHeight,
      appVisible: q('#app') ? getComputedStyle(q('#app')).display !== 'none' : false,
      hasEvidence: !!q('.evidence'),
      barGaps, sameBaseline,
      answerFont: answerStyle ? px(answerStyle.fontSize) : 0,
      answerLine: answerStyle ? px(answerStyle.lineHeight) : 0,
      answerColor: answerStyle ? answerStyle.color : '',
      hintColor: hintStyle ? hintStyle.color : '',
      small, floatOverlap, evParts,
      bodyPad: body ? { t: px(getComputedStyle(body).paddingTop), b: px(getComputedStyle(body).paddingBottom) } : null,
      cardPad: card ? { t: px(getComputedStyle(card).paddingTop), l: px(getComputedStyle(card).paddingLeft) } : null,
      gapAnswerToBar: (barBox && bodyBox) ? Math.round(barBox.y - bodyBox.b) : null,
      gapBarToCardBottom: (barBox && cardBox) ? Math.round(cardBox.b - barBox.b) : null
    };
  });

  const label = id.padEnd(18);
  check(`${label} 无内容溢出`, m.overflows.length === 0, m.overflows.join(' | '));
  check(`${label} 无横向滚动`, m.hScroll === 0, String(m.hScroll));

  if (m.viewerBox && m.appVisible) {
    check(`${label} 阅读区不被压没（≥ 560px）`, m.viewerBox.w >= 560, `${Math.round(m.viewerBox.w)}px`);
  }
  if (m.asBox && m.appVisible) {
    check(`${label} 助手面板宽度合适（340–400px）`, m.asBox.w >= 340 && m.asBox.w <= 400, `${Math.round(m.asBox.w)}px`);
  }
  if (m.composerBox && m.appVisible) {
    check(`${label} 发送框贴在窗口底部（固定不随滚动）`,
      m.composerBox.b <= m.windowH + 1 && m.composerBox.b >= m.windowH - 40, `${Math.round(m.composerBox.b)} / ${m.windowH}`);
    check(`${label} 滚动区没有被发送框遮住`, m.scrollBox.b <= m.composerBox.y + 1, '');
  }
  if (m.cardBox) {
    check(`${label} 卡片内边距舒展（10–22px，跳转态含返回箭头留白）`,
      m.cardPad.t >= 10 && m.cardPad.t <= 40, `pad=${m.cardPad.t}`);
    if (!m.hasEvidence) {
      check(`${label} 正文与操作条间距紧凑（0–16px）`,
        m.gapAnswerToBar >= -2 && m.gapAnswerToBar <= 16, `${m.gapAnswerToBar}px`);
    } else {
      check(`${label} 依据区在正文与操作条之间`, m.gapAnswerToBar > 20, `${m.gapAnswerToBar}px`);
    }
  }
  if (m.barBtns !== undefined && m.barGaps && m.barGaps.length) {
    check(`${label} 操作条图标共基线且间距均匀`,
      m.sameBaseline && m.barGaps.every((g) => Math.abs(g - m.barGaps[0]) <= 2 || Math.abs(g) > 40),
      m.barGaps.join(','));
  }
  if (m.answerFont) {
    check(`${label} 回答正文字号 ≥ 14px`, m.answerFont >= 14, `${m.answerFont}px`);
    check(`${label} 回答正文行高 ≥ 1.7`, m.answerLine / m.answerFont >= 1.7, (m.answerLine / m.answerFont).toFixed(2));
  }
  check(`${label} 可点控件命中区不过小（≥ 20px 高）`, m.small.length === 0, m.small.join(' | '));
  check(`${label} 浮动层不遮挡正文与输入框`, m.floatOverlap.length === 0, m.floatOverlap.join(' | '));
  if (m.evParts) {
    check(`${label} 依据摘录最多两行`, m.evParts.quoteClamp === '2', m.evParts.quoteClamp);
  }
}

/* 窄窗：优先保证正文不被压到 0 */
for (const w of [1024, 900, 820]) {
  await page.setViewport({ width: w, height: 800 });
  await page.goto(`${PAGE}?state=answer-basic`, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 400));
  const g = await page.evaluate(() => {
    const r = (s) => { const el = document.querySelector(s); const b = el.getBoundingClientRect(); return { w: Math.round(b.width), x: Math.round(b.x) }; };
    return { viewer: r('.viewer'), as: r('.assistant'), rail: r('.rail'), side: document.querySelector('.side').getBoundingClientRect().width, bodyScrollX: document.documentElement.scrollWidth };
  });
  check(`窄窗 ${w}px：阅读区仍有可用宽度`, g.viewer.w >= 240, `${g.viewer.w}px`);
  check(`窄窗 ${w}px：助手面板保留`, g.as.w >= 280, `${g.as.w}px`);
  check(`窄窗 ${w}px：无横向溢出`, g.bodyScrollX <= w + 1, `${g.bodyScrollX}`);
}

await browser.close();
console.log('\n════════════════════════════════════════════');
console.log(`版面体检 ${report.length} 项，失败 ${fails} 项`);
if (fails) {
  report.filter((r) => !r.ok).forEach((r) => console.log(`  · ${r.name} ${r.detail}`));
  process.exit(1);
}
console.log('全部通过。');
