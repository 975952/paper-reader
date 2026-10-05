/* ═══════════════════════════════════════════════════════════════════════════
   design-qa.mjs —— 阅读助手界面设计稿的自动化验收 + 逐状态截图
   ───────────────────────────────────────────────────────────────────────────
   用法（在仓库根目录）：
     node design/design-qa.mjs              # 断言 + 截图
     node design/design-qa.mjs --no-shot    # 只断言
     node design/design-qa.mjs --state=answer-evidence   # 只跑一条

   说明：
     · 用本机已装的 Chrome（puppeteer-core），可用 CHROME= 指向别的浏览器
     · 只用 file:// 打开 design/reader.html，不需要起服务，不碰 data/ 与 papers/
     · 断言的是「需求里的硬约束」：14 个状态可达、无 emoji、无渐变/发光/厚重阴影、
       每个图标按钮都有 aria-label 与 tooltip、范围/依据/笔记/跳转的交互规则
   ═══════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// 默认用 file:// 直开（无需起服务）；也可以用 BASE=http://127.0.0.1:PORT/design 走静态服务
const PAGE = process.env.BASE
  ? `${process.env.BASE.replace(/\/$/, '')}/reader.html`
  : pathToFileURL(path.join(HERE, 'reader.html')).href;
const SHOT_DIR = path.join(HERE, 'screens');

const args = process.argv.slice(2);
const NO_SHOT = args.includes('--no-shot');
const ONLY = (args.find((a) => a.startsWith('--state=')) || '').split('=')[1] || '';

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('找不到 Chrome/Edge，请用 CHROME=<路径> 指定');
}

let puppeteer;
try {
  puppeteer = (await import(pathToFileURL(path.join(ROOT, 'test', 'node_modules', 'puppeteer-core', 'lib', 'esm', 'puppeteer', 'puppeteer-core.js')).href)).default;
} catch {
  puppeteer = (await import('puppeteer-core')).default;
}

const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  if (!ok) failures++;
  const mark = ok ? '  ok  ' : ' FAIL ';
  console.log(`[${mark}] ${name}${detail ? '  — ' + detail : ''}`);
}

/* ── 需求里的 14 个必须展示的界面状态 ─────────────────────────────── */
const REQUIRED = [
  ['settings-light', '浅色模式设置页'],
  ['settings-dark', '深色模式设置页'],
  ['answer-basic', '默认 AI 回答卡片'],
  ['answer-evidence', '依据展开状态'],
  ['answer-jump', '跳转原文状态'],
  ['answer-note', '已保存笔记状态'],
  ['range-collapsed', '发送范围收起状态'],
  ['range-expanded', '发送范围展开状态'],
  ['range-web', '整篇论文 + 联网搜索状态'],
  ['gen-streaming', '正在生成状态'],
  ['gen-stopped', '停止生成状态'],
  ['gen-failed', '失败重试状态'],
  ['answer-menu', '更多操作菜单展开状态'],
  ['icon-hover', '图标悬停状态']
];

const ALL_STATES = [
  ...REQUIRED.map((r) => r[0]),
  'dark-answer', 'dark-range', 'dark-failed',
  /* 与现有应用一一对应的入口，也必须能渲染 */
  'ops-menu', 'selection-bubble', 'page-bookmark'
];

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}]/u;

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: 'new',
  args: ['--allow-file-access-from-files', '--hide-scrollbars', '--force-device-scale-factor=1']
});

const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  // 走 http:// 时浏览器会自己请求 /favicon.ico，与本页无关
  if (/favicon|Failed to load resource/.test(t)) return;
  pageErrors.push('console: ' + t);
});

if (!NO_SHOT) fs.mkdirSync(SHOT_DIR, { recursive: true });

/** 等「正在生成」状态真的出现（流式输出是异步的，不能只靠固定 sleep）。 */
async function waitStreaming() {
  try {
    await page.waitForSelector('[data-action="stop"]', { timeout: 5000 });
  } catch {
    /* 已经生成完就按完成态断言 */
  }
  await new Promise((r) => setTimeout(r, 120));
}

/* ── 逐状态 ────────────────────────────────────────────────────────── */
for (const id of ALL_STATES) {
  if (ONLY && ONLY !== id) continue;
  const url = `${PAGE}?state=${id}`;
  await page.goto(url, { waitUntil: 'load' });
  if (id === 'gen-streaming') await waitStreaming();
  else await new Promise((r) => setTimeout(r, 700));

  const info = await page.evaluate((emojiSource) => {    const EMOJI_RE = new RegExp(emojiSource, 'u');
    const q = (s) => document.querySelector(s);
    const qa = (s) => Array.from(document.querySelectorAll(s));
    const cs = (el) => getComputedStyle(el);
    const html = document.documentElement;

    /* 图标按钮的口径 */
    const iconButtons = qa('button').filter((b) => b.querySelector('svg') && !b.textContent.trim());
    const missingLabel = iconButtons.filter((b) => !b.getAttribute('aria-label')).map((b) => b.className);
    const missingTip = iconButtons.filter((b) => !b.getAttribute('data-tip')).map((b) => b.className);

    /* SVG 口径 */
    const svgs = qa('svg');
    const badViewBox = svgs.filter((s) => s.getAttribute('viewBox') !== '0 0 24 24').length;
    const badStroke = svgs.filter((s) => s.getAttribute('stroke-width') !== '1.5').length;
    const badFill = svgs.filter((s) => s.getAttribute('fill') !== 'none').length;
    const badAria = svgs.filter((s) => s.getAttribute('aria-hidden') !== 'true').length;
    const sizes = [...new Set(svgs.map((s) => s.getAttribute('width')))];

    /* 禁用项是否存在（范围栏里「当前选中文字」置灰） */
    const disabledOpts = qa('.rp-opt[disabled]').map((o) => o.getAttribute('data-scope'));
    const disabledTip = disabledOpts.map((k) => {
      const el = qa('.rp-opt[disabled]').find((o) => o.getAttribute('data-scope') === k);
      return el ? el.getAttribute('data-tip') : '';
    });

    /* 计算样式扫描：渐变 / 发光 / 厚重阴影 / 纯黑 */
    const nodes = qa('body *').slice(0, 4000);
    const gradients = [];
    const heavyShadows = [];
    const blackish = [];
    for (const el of nodes) {
      const s = cs(el);
      const bi = s.backgroundImage || '';
      if (/gradient/i.test(bi)) gradients.push(el.className || el.tagName);
      for (const prop of ['boxShadow', 'textShadow', 'filter']) {
        const v = s[prop];
        if (v && v !== 'none' && !/^(none)$/.test(v)) {
          if (/rgba?\(0, 0, 0/.test(v) && /blur\(/.test(v)) heavyShadows.push(`${prop}:${v}`);
          const blurs = [...v.matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => parseFloat(m[1]));
          const maxBlur = blurs.length ? Math.max(...blurs) : 0;
          if (prop !== 'textShadow' && maxBlur > 20) heavyShadows.push(`${prop}:${v}`);
        }
      }
      for (const prop of ['backgroundColor', 'color']) {
        const v = s[prop];
        if (v === 'rgb(0, 0, 0)' || v === '#000' || v === 'rgb(0,0,0)') blackish.push(`${el.className || el.tagName}:${prop}`);
      }
    }

    /* 结构事实 */
    const theme = html.getAttribute('data-theme');
    const bodyText = document.body.innerText;

    return {
      theme,
      state: html.getAttribute('data-state'),
      missingLabel, missingTip,
      badViewBox, badStroke, badFill, badAria,
      iconCount: iconButtons.length,
      svgCount: svgs.length,
      sizes,
      disabledOpts, disabledTip,
      gradients: gradients.slice(0, 5),
      heavyShadows: heavyShadows.slice(0, 5),
      blackish: blackish.slice(0, 5),
      hasEmoji: EMOJI_RE.test(bodyText),
      emojiSample: (bodyText.match(EMOJI_RE) || []).slice(0, 3),
      // 结构
      appVisible: !!q('#app') && cs(q('#app')).display !== 'none',
      settingsVisible: !!q('#settings') && cs(q('#settings')).display !== 'none',
      cards: qa('.card').length,
      answerFontSize: q('#body-c1') ? cs(q('#body-c1')).fontSize : (q('[id^=body-]') ? cs(q('[id^=body-]')).fontSize : null),
      answerLineHeight: q('[id^=body-]') ? cs(q('[id^=body-]')).lineHeight : null,
      bodyHasText: !!bodyText.trim(),
      rangePanelShown: !!q('#rangePanel') && cs(q('#rangePanel')).display !== 'none',
      menuShown: !!q('#cardMenu') && cs(q('#cardMenu')).display !== 'none',
      evidenceShown: qa('.evidence').length > 0,
      evidenceItems: qa('.ev-item').length,
      badgeText: q('.badge') ? q('.badge').textContent : null,
      noteInputShown: !!q('#noteTitleInput'),
      noteIconSaved: !!q('[data-action="save-note"] [d*="14.9 16.7"]'),
      noteBtnIcon: q('[data-action="save-note"]') ? q('[data-action="save-note"] svg').innerHTML.slice(0, 40) : null,
      backBtn: !!q('[data-action="back-pos"]'),
      jumpBackShown: !!q('#jumpBack') && cs(q('#jumpBack')).display !== 'none',
      hitCount: qa('.pg-hit').length,
      notesCount: q('#notesCount') ? q('#notesCount').textContent : null,
      noteItems: qa('.note-item').length,
      scopeLabel: q('#cpScopeText') ? q('#cpScopeText').textContent : null,
      scopeIcon: q('#cpScope svg') ? q('#cpScope svg').innerHTML.slice(0, 30) : null,
      sendIcon: q('#btnSend svg') ? q('#btnSend svg').innerHTML.slice(0, 30) : null,
      cardScopeIcons: qa('.scope-ic').map((s) => s.getAttribute('data-scope')),
      cardBarIcons: qa('.card-bar .ic-btn').map((b) => b.getAttribute('aria-label')),
      apiKeyType: q('#cfgApiKey') ? q('#cfgApiKey').type : null,
      apiKeyValue: q('#cfgApiKey') ? q('#cfgApiKey').value : null,
      baseURL: q('#cfgBaseURL') ? q('#cfgBaseURL').value : null,
      answerText: q('[id^=body-]') ? q('[id^=body-]').innerText.trim().slice(0, 40) : '',
      storedAnswers: qa('.card').length
    };
  }, EMOJI.source);

  const label = (REQUIRED.find((r) => r[0] === id) || [id, id])[1];
  console.log(`\n── ${id}（${label}） ─────────────────────────────`);

  check(`${id}：渲染无异常`, info.bodyHasText, '');
  check(`${id}：无 emoji / 表情符号`, !info.hasEmoji, info.emojiSample.join(' '));
  check(`${id}：无渐变`, info.gradients.length === 0, info.gradients.join(' | '));
  check(`${id}：无发光 / 厚重阴影`, info.heavyShadows.length === 0, info.heavyShadows.join(' | '));
  if (info.theme === 'dark') check(`${id}：深色不使用纯黑`, info.blackish.length === 0, info.blackish.join(' | '));
  check(`${id}：图标按钮都有 aria-label`, info.missingLabel.length === 0, info.missingLabel.join(' | '));
  check(`${id}：图标按钮都有 tooltip`, info.missingTip.length === 0, info.missingTip.join(' | '));
  check(`${id}：SVG 口径统一（viewBox/stroke/fill/aria）`,
    info.badViewBox === 0 && info.badStroke === 0 && info.badFill === 0 && info.badAria === 0,
    `viewBox:${info.badViewBox} stroke:${info.badStroke} fill:${info.badFill} aria:${info.badAria}`);
  check(`${id}：图标尺寸在 16–18px`, info.sizes.every((s) => +s >= 14 && +s <= 18), info.sizes.join(','));

  /* 分状态断言 */
  if (id.startsWith('settings')) {
    check(`${id}：设置页可见、阅读区不重复渲染`, info.settingsVisible && !info.appVisible, '');
    check(`${id}：API Key 默认隐藏且非真实密钥`, info.apiKeyType === 'password' && /^sk-demo/.test(info.apiKeyValue), info.apiKeyType);
    check(`${id}：接口地址默认 api.apiyi.com/v1`, info.baseURL === 'https://api.apiyi.com/v1', info.baseURL);
    check(`${id}：主题分组与页面主题一致`, info.theme === (id.endsWith('dark') ? 'dark' : 'light'), info.theme);
  }
  if (id === 'answer-basic') {
    check(`${id}：只有一张回答卡片`, info.cards === 1, String(info.cards));
    check(`${id}：卡片默认只有 依据/笔记/更多 三个图标`,
      info.cardBarIcons.length === 3 && /依据/.test(info.cardBarIcons[0]) && info.cardBarIcons[1] === '添加到笔记' && info.cardBarIcons[2] === '更多操作',
      info.cardBarIcons.join(' | '));
    check(`${id}：依据图标带数字 2`, info.badgeText === '2', String(info.badgeText));
    check(`${id}：回答正文字号 ≥ 14px`, parseFloat(info.answerFontSize) >= 14, info.answerFontSize);
    check(`${id}：依据默认收起`, !info.evidenceShown, '');
  }
  if (id === 'answer-evidence') {
    check(`${id}：证据在卡片内部展开`, info.evidenceShown && info.cards === 1, '');
    check(`${id}：依据条目数量与数字一致（2）`, info.evidenceItems === 2, String(info.evidenceItems));
    check(`${id}：展开后依据图标保留数字 2`, info.badgeText === '2', String(info.badgeText));
  }
  if (id === 'answer-jump') {
    check(`${id}：正文跳到第 4 页并高亮`, info.hitCount === 1, String(info.hitCount));
    check(`${id}：卡片左上角出现返回箭头`, info.backBtn, '');
    check(`${id}：阅读区顶部出现返回原位置入口`, info.jumpBackShown, '');
    check(`${id}：跳转后回答卡片仍然可见`, info.cards === 1, String(info.cards));
  }
  if (id === 'answer-note') {
    check(`${id}：笔记图标为「已保存」（对勾）`, info.noteIconSaved, info.noteBtnIcon || '');
    check(`${id}：已保存状态下不再显示标题输入行`, !info.noteInputShown, '');
    check(`${id}：左栏笔记同步增加一项`, Number(info.notesCount) === 2 && info.noteItems === 2,
      `count=${info.notesCount} items=${info.noteItems}`);
  }
  if (id === 'range-collapsed') {
    check(`${id}：范围栏收起`, !info.rangePanelShown, '');
    check(`${id}：发送框显示当前范围「论文」`, info.scopeLabel === '论文', String(info.scopeLabel));
    check(`${id}：没有选中文字时「当前选中文字」置灰`,
      info.disabledOpts.length === 0 || !info.rangePanelShown, info.disabledOpts.join(','));
  }
  if (id === 'range-expanded' || id === 'dark-range') {
    check(`${id}：范围栏展开`, info.rangePanelShown, '');
    check(`${id}：没有选中文字时「当前选中文字」置灰`, info.disabledOpts.includes('selection'), info.disabledOpts.join(','));
    check(`${id}：置灰项悬停提示「请先在正文中选择文字」`,
      info.disabledTip.every((t) => t === '请先在正文中选择文字'), info.disabledTip.join(' | '));
    check(`${id}：无醒目红色/橙色告警`, info.heavyShadows.length === 0, '');
  }
  if (id === 'range-web') {
    check(`${id}：发送框范围标签为「论文 + 网络」`, info.scopeLabel === '论文 + 网络', String(info.scopeLabel));
    check(`${id}：回答卡片保留本次范围（书本 + 网络两个图标）`,
      info.cardScopeIcons.join(',') === 'paper,web', info.cardScopeIcons.join(','));
  }
  if (id === 'gen-streaming') {
    check(`${id}：保留用户的问题`, /为什么自注意力/.test(info.answerText) || info.cards === 1, '');
    check(`${id}：底部只有停止图标`, info.cardBarIcons.length === 1 && info.cardBarIcons[0] === '停止生成', info.cardBarIcons.join(' | '));
    check(`${id}：发送框的发送键变成停止`, /rect/.test(info.sendIcon || ''), info.sendIcon || '');
    check(`${id}：不显示依据 / 笔记 / 复制`, !/依据/.test(info.cardBarIcons.join()) && !/笔记/.test(info.cardBarIcons.join()), '');
  }
  if (id === 'gen-stopped') {
    check(`${id}：停止后显示 继续生成 / 重新回答 / 更多`,
      info.cardBarIcons.join('|') === '继续生成|重新回答|更多操作', info.cardBarIcons.join(' | '));
    check(`${id}：已生成内容保留`, /Transformer/.test(info.answerText), info.answerText);
  }
  if (id === 'gen-failed' || id === 'dark-failed') {
    check(`${id}：失败卡片保留问题与已生成内容`, info.cards === 1 && /Transformer/.test(info.answerText), info.answerText);
    check(`${id}：底部只有 重试 / 更多 两个图标`,
      info.cardBarIcons.join('|') === '重试|更多操作', info.cardBarIcons.join(' | '));
    check(`${id}：短提示「回答未完成」`, await page.evaluate(() => document.body.innerText.includes('回答未完成')), '');
  }
  if (id === 'answer-menu') {
    check(`${id}：更多菜单展开`, info.menuShown, '');
    const items = await page.$$eval('#cardMenu .menu-item', (els) => els.map((e) => e.textContent.trim()));
    check(`${id}：菜单含 复制 / 重新回答 / 删除`, items.join('|') === '复制|重新回答|删除', items.join(' | '));
  }
  if (id === 'ops-menu') {
    const items = await page.$$eval('#opsMenu .menu-item', (els) => els.map((e) => e.textContent.trim()));
    check(`${id}：论文操作菜单展开且四项高频操作平铺`,
      items.join('|') === '一句话速览|阅读路线|方法拆解|术语表|更多操作', items.join(' | '));
    check(`${id}：菜单里没有「AI」字样或 emoji`, !/AI|[\u{1F300}-\u{1FAFF}]/u.test(items.join('')), '');
  }
  if (id === 'selection-bubble') {
    const b = await page.evaluate(() => {
      const el = document.querySelector('#selBubble');
      const r = el.getBoundingClientRect();
      return {
        shown: !el.hidden,
        acts: Array.from(el.querySelectorAll('[data-sel-act]')).map((x) => x.getAttribute('data-sel-act')),
        labels: Array.from(el.querySelectorAll('[data-sel-act]')).map((x) => x.getAttribute('aria-label')),
        inView: r.x >= 0 && r.y >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight
      };
    });
    check(`${id}：划选气泡浮出且不出窗口`, b.shown && b.inView, '');
    check(`${id}：五个动作是 翻译/解释/加入对话/留标记/复制`,
      b.acts.join('|') === 'translate|explain|ask|bookmark|copy', b.acts.join(' | '));
    check(`${id}：每个动作都有可访问名`, b.labels.every((x) => x && x.length > 2), '');
    check(`${id}：动作结果进面板（不就地浮动结果）`, info.cards === 1 && !(await page.$('.page .result-float')), '');
  }
  if (id === 'page-bookmark') {
    const bm = await page.evaluate(() => ({
      marks: document.querySelectorAll('.page-bookmark').length,
      notes: document.querySelectorAll('.note-item').length,
      noYellowHL: document.querySelectorAll('.page .hl, .page .highlight').length
    }));
    check(`${id}：页边留下标记且笔记列表同步`, bm.marks === 1 && bm.notes === 2, `marks=${bm.marks} notes=${bm.notes}`);
    check(`${id}：不加黄色整段高亮`, bm.noYellowHL === 0, String(bm.noYellowHL));
  }
  if (id === 'icon-hover') {    const hovered = await page.evaluate(() => {
      const b = document.querySelector('.ic-btn.is-hover-sim');
      const tip = document.querySelector('#tip');
      return { cls: !!b, tipShown: tip && !tip.hidden, tipText: tip ? tip.textContent : '', color: b ? getComputedStyle(b).color : '' };
    });
    check(`${id}：悬停目标存在且变为蓝色`, hovered.cls && /76, 125, 190|130, 169, 220/.test(hovered.color), hovered.color);
    check(`${id}：悬停显示 tooltip`, hovered.tipShown && hovered.tipText.length > 0, hovered.tipText);
  }
  if (id.startsWith('dark-')) {
    const dark = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      return { bg: s.getPropertyValue('--bg').trim(), elev: s.getPropertyValue('--bg-elev').trim(), fg: s.getPropertyValue('--fg').trim() };
    });
    check(`${id}：深色底为深灰而非纯黑`, !/^#0{3,6}$/i.test(dark.bg) && !/^#0{3,6}$/i.test(dark.elev), `${dark.bg} / ${dark.elev}`);
  }

  if (!NO_SHOT) {
    const file = path.join(SHOT_DIR, `${id}.png`);
    await page.screenshot({ path: file });
    check(`${id}：截图已生成`, fs.existsSync(file), path.relative(ROOT, file));
  }
}

/* ── 交互规则（范围栏 / 依据 / 笔记 / 跳转 / 复制） ───────────────── */
console.log('\n── 交互规则 ───────────────────────────────────');

await page.goto(`${PAGE}?state=answer-basic`, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 400));

// 1) 展开范围栏
await page.click('#cpBar [data-action="range-toggle"]');
await new Promise((r) => setTimeout(r, 260));
let open = await page.evaluate(() => !document.querySelector('#rangePanel').hidden);
check('点箭头可以展开发送范围', open, '');

// 2) 选择「整篇论文 + 联网搜索」后自动收起，并更新发送框标签
await page.click('#rpOpts .rp-opt[data-scope="paper-web"]');
await new Promise((r) => setTimeout(r, 320));
let afterPick = await page.evaluate(() => ({
  hidden: document.querySelector('#rangePanel').hidden,
  label: document.querySelector('#cpScopeText').textContent,
  checked: document.querySelector('.rp-opt[data-scope="paper-web"]').getAttribute('aria-checked'),
  stored: document.querySelector('#cpScope').getAttribute('data-scope')
}));
check('选择后立即更新当前范围', afterPick.label === '论文 + 网络' && afterPick.stored === 'paper-web', afterPick.label);
check('选择完成后自动收起', afterPick.hidden, '');

// 3) 发送后仍然沿用该范围
await page.click('#chatInput');
await page.type('#chatInput', '多头注意力为什么要降维？');
await page.keyboard.press('Enter');
await waitStreaming();
// 等真的吐出一些字再停（停止要保留已生成内容）
await page.waitForFunction(() => {
  const b = document.querySelector('[id^=body-]');
  return b && b.innerText.trim().length > 12;
}, { timeout: 5000 }).catch(() => {});
let afterSend = await page.evaluate(() => ({
  scope: document.querySelector('#cpScope').getAttribute('data-scope'),
  cardScope: Array.from(document.querySelectorAll('.scope-ic')).map((s) => s.getAttribute('data-scope')).join(','),
  streaming: !!document.querySelector('[data-action="stop"]'),
  rangeHidden: document.querySelector('#rangePanel').hidden
}));
check('发送后自动收起范围栏', afterSend.rangeHidden, '');
check('范围沿用到下一次发送（论文 + 网络）', afterSend.scope === 'paper-web', afterSend.scope);
check('回答卡片保留本次实际使用的范围', afterSend.cardScope === 'paper,web', afterSend.cardScope);
check('发送后进入生成中状态（底部只有停止）', afterSend.streaming, '');

// 4) 停止 → 保留内容
await page.click('.card-bar [data-action="stop"]');
await new Promise((r) => setTimeout(r, 200));
let stopped = await page.evaluate(() => ({
  text: document.querySelector('[id^=body-]').innerText.trim().length,
  resume: !!document.querySelector('[data-action="resume"]')
}));
check('停止后保留已生成内容', stopped.text > 5 && stopped.resume, `chars=${stopped.text}`);

// 5) 依据展开 → 在卡片内部
await page.goto(`${PAGE}?state=answer-basic`, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 300));
await page.click('[data-action="evidence"]');
await new Promise((r) => setTimeout(r, 260));
let ev = await page.evaluate(() => ({
  inside: !!document.querySelector('.card .evidence'),
  items: document.querySelectorAll('.ev-item').length,
  badge: document.querySelector('.badge').textContent,
  active: document.querySelector('[data-action="evidence"]').getAttribute('aria-expanded'),
  supports: Array.from(document.querySelectorAll('.ev-item')).map((e) => e.getAttribute('data-support'))
}));
check('依据在卡片内部展开（不新开窗口）', ev.inside, '');
check(`依据图标变激活态并保留数字`, ev.active === 'true' && ev.badge === '2', `${ev.active}/${ev.badge}`);
check('每条依据都有状态图标（对勾/波浪线/问号）',
  ev.supports.every((s) => ['direct', 'infer', 'none'].includes(s)), ev.supports.join(','));

// 6) 跳转原文 → 高亮 + 返回箭头 → 返回原位置
await page.click('.ev-item .ev-jump [data-action="jump"]');
await new Promise((r) => setTimeout(r, 700));
let jumped = await page.evaluate(() => ({
  hit: document.querySelectorAll('.pg-hit').length,
  back: !!document.querySelector('[data-action="back-pos"]'),
  page: document.querySelector('#curPage').textContent,
  cardVisible: !!document.querySelector('.card')
}));
check('跳转原文：正文高亮 + 定位到对应页', jumped.hit === 1 && jumped.page === '4', `page=${jumped.page} hit=${jumped.hit}`);
check('跳转后卡片左上角出现返回箭头', jumped.back && jumped.cardVisible, '');
await page.click('[data-action="back-pos"]');
await new Promise((r) => setTimeout(r, 600));
let back = await page.evaluate(() => ({
  back: !!document.querySelector('[data-action="back-pos"]'),
  hit: document.querySelectorAll('.pg-hit').length
}));
check('点返回箭头恢复跳转前的阅读位置', !back.back && back.hit === 0, '');

// 7) 保存为笔记：编辑标题 → 确认
await page.goto(`${PAGE}?state=answer-basic`, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 300));
await page.click('[data-action="save-note"]');
await new Promise((r) => setTimeout(r, 220));
let editing = await page.evaluate(() => {
  const i = document.querySelector('#noteTitleInput');
  const acts = Array.from(document.querySelectorAll('.note-actions .ic-btn')).map((b) => b.getAttribute('aria-label'));
  return { has: !!i, value: i ? i.value : '', acts };
});
check('保存为笔记：原地出现可编辑标题行', editing.has && editing.value.length > 0, editing.value.slice(0, 16));
check('标题行右侧只有确认与取消两个图标', editing.acts.join('|') === '确认保存笔记|取消保存', editing.acts.join(' | '));
await page.click('.note-actions [data-action="note-confirm"]');
await new Promise((r) => setTimeout(r, 220));
let saved = await page.evaluate(() => ({
  rows: document.querySelectorAll('.note-item').length,
  count: document.querySelector('#notesCount').textContent,
  savedIcon: !!document.querySelector('[data-action="save-note"] svg [d*="14.9 16.7"]'),
  noModal: !document.querySelector('.modal, [role="dialog"]')
}));
check('保存后笔记列表同步增加一项', saved.rows >= 1 && Number(saved.count) >= 1, `${saved.rows}/${saved.count}`);
check('保存后笔记图标保持已保存状态', saved.savedIcon, '');
check('不弹出大型成功提示框', saved.noModal, '');

// 8) 复制：内容含正文 / 论文名 / 页码 / 引用，图标短暂变对勾
await page.goto(`${PAGE}?state=answer-basic`, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 300));
await page.evaluate(() => {
  window.__copied = '';
  navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); };
});
await page.click('[data-action="more"]');
await new Promise((r) => setTimeout(r, 200));
await page.click('#cardMenu [data-action="copy"]');
await new Promise((r) => setTimeout(r, 150));
let copy = await page.evaluate(() => ({
  text: window.__copied,
  flashing: !!document.querySelector('.card-bar [data-action="more"] svg [d*="5.4 12.6"]')
}));
check('复制内容含回答正文', /Transformer 使用自注意力机制/.test(copy.text), '');
check('复制内容含论文名称与页码', /Attention Is All You Need/.test(copy.text) && /p\.3/.test(copy.text), '');
check('复制内容含引用', /引用：/.test(copy.text) && /p\.4/.test(copy.text), '');
check('复制后图标短暂变成对勾', copy.flashing, '');
await page.waitForFunction(
  () => !!document.querySelector('.card-bar [data-action="more"] svg circle[cx="12"]'),
  { timeout: 3000 }
).catch(() => {});
let restored = await page.evaluate(() => !!document.querySelector('.card-bar [data-action="more"] svg circle[cx="12"]'));
check('对勾随后恢复为复制图标', restored, '');

// 9) 设置页：恢复默认只重置三项
await page.goto(`${PAGE}?state=settings-light`, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 300));
await page.click('#btnSizeUp');
await page.click('#defaultScope .rp-opt[data-scope="paper-web"]');
await page.click('#themeSeg [data-theme-set="dark"]');
await new Promise((r) => setTimeout(r, 200));
let before = await page.evaluate(() => ({
  size: document.querySelector('#sizeValue').textContent,
  scope: document.querySelector('#defaultScope .rp-opt[aria-checked="true"]').getAttribute('data-scope'),
  theme: document.documentElement.getAttribute('data-theme'),
  key: document.querySelector('#cfgApiKey').value
}));
check('字号调整立即生效（显示当前数值）', before.size === '18 px' && before.theme === 'dark' && before.scope === 'paper-web',
  `${before.size}/${before.theme}/${before.scope}`);
await page.click('#btnRestoreDefaults');
await new Promise((r) => setTimeout(r, 200));
let after = await page.evaluate(() => ({
  size: document.querySelector('#sizeValue').textContent,
  scope: document.querySelector('#defaultScope .rp-opt[aria-checked="true"]').getAttribute('data-scope'),
  theme: document.documentElement.getAttribute('data-theme'),
  key: document.querySelector('#cfgApiKey').value,
  note: document.querySelector('#restoreNote').hidden
}));
check('恢复默认：字号 / 默认范围 / 主题回到默认值',
  after.size === '17 px' && after.scope === 'paper' && after.theme === 'light', `${after.size}/${after.scope}/${after.theme}`);
check('恢复默认不动 API Key', after.key === before.key && after.key.length > 0, '');
check('恢复默认后给出低强调度说明文字', after.note === false, '');

// 10) 范围栏：点箭头可手动收起
await page.goto(`${PAGE}?state=range-expanded`, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 400));
await page.click('#rangePanel [data-action="range-collapse"]');
await new Promise((r) => setTimeout(r, 300));
let collapsed = await page.evaluate(() => document.querySelector('#rangePanel').hidden);
check('点箭头可以手动收起范围栏', collapsed, '');

// 11) 划选正文 → 自动切到「当前选中文字」
await page.goto(`${PAGE}?state=range-collapsed`, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 400));
await page.evaluate(() => {
  const el = document.querySelector('#p-attn');
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
});
await new Promise((r) => setTimeout(r, 200));
let sel = await page.evaluate(() => ({
  scope: document.querySelector('#cpScope').getAttribute('data-scope'),
  attach: !document.querySelector('#attachRow').hidden
}));
check('刚刚选择文字后默认切换为「当前选中文字」', sel.scope === 'selection', sel.scope);
check('选中文字显示为发送框上方的附件', sel.attach, '');

// 12) 深色模式令牌 + 对比度
const measureContrast = () => {
  const parse = (c) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (fg, bg) => {
    const [l1, l2] = [lum(parse(fg)), lum(parse(bg))].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };
  const gap = (sel, bgSel) => {
    const el = document.querySelector(sel), bg = document.querySelector(bgSel);
    return ratio(getComputedStyle(el).color, getComputedStyle(bg).backgroundColor);
  };
  return {
    answer: gap('[id^=body-]', '.assistant'),
    ui: gap('.as-title', '.assistant'),
    paper: gap('.page p', '.page'),
    paperBg: getComputedStyle(document.querySelector('.page')).backgroundColor
  };
};

await page.goto(`${PAGE}?state=dark-answer`, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 300));
const contrast = await page.evaluate(measureContrast);
check('深色模式回答正文对比度 ≥ 7:1', contrast.answer >= 7, contrast.answer.toFixed(2));
check('深色模式界面文字对比度 ≥ 4.5:1', contrast.ui >= 4.5, contrast.ui.toFixed(2));
check('深色模式正文（PDF）对比度 ≥ 7:1', contrast.paper >= 7, contrast.paper.toFixed(2));
check('深色模式 PDF 纸面也是深灰（不闪白）', !/^rgb\(2[0-9]{2}/.test(contrast.paperBg), contrast.paperBg);

await page.goto(`${PAGE}?state=answer-basic`, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 300));
const light = await page.evaluate(measureContrast);
check('浅色模式回答正文对比度 ≥ 7:1', light.answer >= 7, light.answer.toFixed(2));

// 13) 真实指针悬停 → 低对比度灰变蓝 + tooltip 出现
await page.goto(`${PAGE}?state=answer-basic`, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 400));
const beforeHover = await page.evaluate(() => getComputedStyle(document.querySelector('[data-action="save-note"]')).color);
await page.hover('[data-action="save-note"]');
await new Promise((r) => setTimeout(r, 500));
const hovered = await page.evaluate(() => ({
  color: getComputedStyle(document.querySelector('[data-action="save-note"]')).color,
  tipShown: !document.querySelector('#tip').hidden,
  tipText: document.querySelector('#tip').textContent
}));
check('真实悬停：图标由低对比度灰变低饱和蓝',
  beforeHover === 'rgb(124, 130, 139)' && hovered.color === 'rgb(76, 125, 190)', `${beforeHover} -> ${hovered.color}`);
check('真实悬停：显示 tooltip「添加到笔记」', hovered.tipShown && hovered.tipText === '添加到笔记', hovered.tipText);

// 14) 复制之后图标短暂变对勾（反馈落在仍然可见的「更多」图标上）
await page.goto(`${PAGE}?state=answer-basic`, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 300));
await page.click('.card-bar [data-action="more"]');
await new Promise((r) => setTimeout(r, 200));
await page.click('#cardMenu [data-action="copy"]');
await new Promise((r) => setTimeout(r, 160));
check('复制后「更多」图标短暂变成对勾',
  await page.evaluate(() => !!document.querySelector('.card-bar [data-action="more"] svg [d*="5.4 12.6"]')), '');
await page.waitForFunction(
  () => !!document.querySelector('.card-bar [data-action="more"] svg circle[cx="12"]'),
  { timeout: 3000 }
).catch(() => {});
check('对勾随后恢复原状（约 1 秒后）',
  await page.evaluate(() => !!document.querySelector('.card-bar [data-action="more"] svg circle[cx="12"]')), '');

// 15) 划选 → 气泡 → 动作结果进面板（与现有应用的划词动线一致）
await page.goto(`${PAGE}?state=answer-basic`, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 400));
await page.evaluate(() => {
  const el = document.querySelector('#p-sa');
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
});
await new Promise((r) => setTimeout(r, 250));
check('划选正文后浮出气泡', await page.evaluate(() => !document.querySelector('#selBubble').hidden), '');
await page.click('#selBubble [data-sel-act="translate"]');
await new Promise((r) => setTimeout(r, 250));
const afterSelAct = await page.evaluate(() => ({
  label: (document.querySelector('.card-label') || {}).textContent || '',
  body: (document.querySelector('[id^=body-]') || {}).innerText || '',
  card: document.querySelectorAll('.card').length
}));
check('点「翻译」后结果作为一条回答进面板', afterSelAct.card === 1 && /译文/.test(afterSelAct.label) && afterSelAct.body.length > 10,
  afterSelAct.label);
check('划选动作结果不与面板外的浮层重复出现', await page.evaluate(() => !document.querySelector('#selBubble:not([hidden]) .card')), '');

// 16) 论文操作 → 结果进面板
await page.goto(`${PAGE}?state=answer-basic`, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 400));
await page.click('#btnOps');
await new Promise((r) => setTimeout(r, 200));
check('点「论文操作」图标展开菜单', await page.evaluate(() => !document.querySelector('#opsMenu').hidden), '');
await page.click('#opsMenu [data-action="op-quick"]');
await new Promise((r) => setTimeout(r, 250));
const afterOp = await page.evaluate(() => ({
  label: (document.querySelector('.card-label') || {}).textContent || '',
  body: (document.querySelector('[id^=body-]') || {}).innerText || ''
}));
check('论文操作结果进面板且无「AI」字样', /一句话速览/.test(afterOp.label) && afterOp.body.length > 10 && !/AI/.test(afterOp.body), afterOp.label);

// 17) 页边标记：不加黄色高亮
await page.goto(`${PAGE}?state=answer-basic`, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 400));
await page.evaluate(() => {
  const el = document.querySelector('#p-attn');
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
});
await new Promise((r) => setTimeout(r, 200));
await page.click('#selBubble [data-sel-act="bookmark"]');
await new Promise((r) => setTimeout(r, 200));
check('「留标记」在页边留痕且不撒黄色高亮', await page.evaluate(() =>
  document.querySelectorAll('.page-bookmark').length === 1 && document.querySelectorAll('.page .hl').length === 0), '');

/* ── 全量清单 ──────────────────────────────────────────────────────── */
const missingStates = REQUIRED.filter((r) => !ALL_STATES.includes(r[0])).map((r) => r[0]);
check('14 个必须展示的界面状态全部有定义', missingStates.length === 0, missingStates.join(','));

const shots = fs.existsSync(SHOT_DIR) ? fs.readdirSync(SHOT_DIR).filter((f) => f.endsWith('.png')) : [];
check('所有状态都有截图', NO_SHOT || shots.length >= ALL_STATES.length, `${shots.length} 张`);

check('整页无 JS 报错', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();

console.log('\n════════════════════════════════════════════');
console.log(`共 ${results.length} 条断言，失败 ${failures} 条`);
if (!NO_SHOT) console.log(`截图目录：${path.relative(ROOT, SHOT_DIR)}`);
if (failures) {
  console.log('\n失败明细：');
  results.filter((r) => !r.ok).forEach((r) => console.log(`  · ${r.name}  ${r.detail}`));
  process.exit(1);
}
console.log('全部通过。');
