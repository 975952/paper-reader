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
// 列表按 mtime 倒序，别直接取 [0]：刚上传的小测试文件会排在真论文前面，
// 而「全文」相关用例需要一篇有正经正文的多页论文。挑体积最大的那篇。
const first = [...(papers.papers || [])].sort((a, b) => (b.size || 0) - (a.size || 0))[0] || {};
check('服务端有可用的 PDF', !!first.name && !!first.docId, first.name || '(无)');
assertIsolatedDataDir(resolveDataDir(papers.dir));

const postJson = (url, obj) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj),
});
// 测试只在 assertIsolatedDataDir 确认过的临时数据目录中使用假 key。
await postJson(`${BASE}/api/config`, { apiKey: 'sk-ctx-test-key', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-flash' });
await postJson(`${BASE}/api/state`, { lastDoc: null, lastName: null, lastUrl: null, docs: {} });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1500,950'],
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();

const consoleErrors = [];
const pageErrors = [];
const chatRequests = [];
const searchQueries = [];
let searchMode = 'ok';   // 'ok' | 'fail'
let expectingFetchFailure = false;   // 故意注入搜索失败时，浏览器的 502 报错是预期的

const WEB_RESULTS = [
  { title: 'Attention Is All You Need', url: 'https://arxiv.org/abs/1706.03762', snippet: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.' },
  { title: 'Transformer (machine learning model) - Wikipedia', url: 'https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)', snippet: 'A transformer is a deep learning architecture based on the multi-head attention mechanism.' },
  { title: '注意力机制 - 知乎', url: 'https://zhuanlan.zhihu.com/p/123456', snippet: '注意力机制让模型在处理序列时动态关注相关位置。' },
];
const ANSWER = '注意力机制让模型对序列中不同位置分配不同权重 [1]。\n\n- 来源二也提到多头注意力 [2]\n\n（背景知识）它最早用于机器翻译。';
const DIGEST = '研究问题：序列转导。方法：纯注意力，无循环无卷积。结论：BLEU 提升。';

page.on('console', (m) => {
  if (m.type() !== 'error') return;
  // 注入搜索失败的那一段，浏览器必然记一条 502 —— 那是被测行为本身，不算缺陷
  if (expectingFetchFailure && /Failed to load resource|502/.test(m.text())) return;
  consoleErrors.push(m.text());
});
page.on('pageerror', (e) => pageErrors.push(String(e)));

await page.setRequestInterception(true);
page.on('request', (req) => {
  const url = req.url();

  if (url.endsWith('/api/chat')) {
    const body = JSON.parse(req.postData() || '{}');
    const last = body.messages?.[body.messages.length - 1];
    const userText = Array.isArray(last?.content)
      ? (last.content.find((c) => c.type === 'text')?.text || '')
      : (last?.content || '');
    const sys = String(body.messages?.[0]?.content || '');
    chatRequests.push({ userText, sys, n: body.messages?.length });
    // 生成「阅读索引」的那次调用：system 是本文件里唯一提到「阅读索引」的那条
    const isDigest = sys.includes('阅读索引');
    const text = isDigest ? DIGEST : ANSWER;
    const chunks = text.match(/[\s\S]{1,16}/g) || [];
    const sse = chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('')
      + 'data: [DONE]\n\n';
    return req.respond({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: sse });
  }

  if (url.includes('/api/web-search')) {
    const q = decodeURIComponent(new URL(url).searchParams.get('q') || '');
    searchQueries.push(q);
    if (searchMode === 'fail') {
      return req.respond({ status: 502, contentType: 'application/json', body: '{"error":"upstream down"}' });
    }
    return req.respond({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ query: q, provider: 'Bing', results: WEB_RESULTS }),
    });
  }

  return req.continue();
});

await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#fileList li', { timeout: 20000 });
await page.evaluate((id) => {
  const li = [...document.querySelectorAll('#fileList li')].find((x) => x.dataset.id === id)
    || document.querySelector('#fileList li');
  li.click();
}, first.docId);
await page.waitForFunction(() => window.__viewer?.pdf && window.__viewer.pdf.numPages > 0, { timeout: 40000 });
await sleep(600);
const numPages = await page.evaluate(() => window.__viewer.pdf.numPages);
check('PDF 打开成功', numPages > 0, `${numPages} 页`);

/* 默认状态（全新 profile，localStorage 是空的） */
const defaults = await page.evaluate(() => ({
  f: !!window.__state.useFullText,
  w: !!window.__state.useWeb,
  range: window.__ctx.scopeRange,
  chipText: (document.getElementById('composerScope')?.textContent || '').trim(),
  options: [...document.querySelectorAll('#sendScope .scope-opt')].map((b) => b.dataset.range),
  noMenu: !document.getElementById('scopeMenu') && !document.getElementById('optScope'),
  noClear: !document.getElementById('clearSession'),
  lsF: localStorage.getItem('reader.useFullText'),
  lsW: localStorage.getItem('reader.useWeb'),
}));
check('「整篇」默认开着（用户口径：默认全文）', defaults.f === true, JSON.stringify(defaults));
check('「联网」默认开着（用户口径：默认联网）', defaults.w === true);
check('输入框那一排不再有范围菜单和「清空会话」', defaults.noMenu && defaults.noClear, JSON.stringify(defaults));
check('默认范围 = 整篇论文 + 联网搜索（两个偏好都开）', defaults.range === 'paper-web', defaults.range);
check('发送框上写着当前范围（一眼看得见，不用猜）',
  defaults.chipText.includes('论文') && defaults.chipText.includes('联网'), defaults.chipText);
check('上拉栏里是四个互斥选项（含「只联网」，没丢能力）',
  defaults.options.join('|') === 'current|paper|web|paper-web', defaults.options.join(' | '));

async function setScope(which, want) {
  return page.evaluate(async (w, on) => {
    const id = w === 'full' ? 'cfgUseFullText' : 'cfgUseWeb';
    document.getElementById('settingsBtn').click();
    const box = document.getElementById(id);
    if (box.checked !== on) box.checked = on;
    // 第 2 步起这两个勾是即时生效控件（input 事件）——只改 checked 不派发，界面不会动
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    document.getElementById('saveSettings').click();
    await new Promise((r) => setTimeout(r, 260));
    document.getElementById('closeSettings').click();
    return w === 'full' ? !!window.__state.useFullText : !!window.__state.useWeb;
  }, which, want);
}

console.log('\n-- 相关段落检索（词频打分）');
const pick = await page.evaluate(() => {
  const pages = [];
  for (let i = 1; i <= 12; i++) {
    const filler = `page ${i} generic discussion about datasets and training schedules. `.repeat(30);
    pages.push(`\n\n===== p.${i} =====\n${filler}`);
  }
  // 只在第 7 页塞进与问题强相关的词（页码标记本身不能跟着重复，否则等于有 20 个第 7 页）
  pages[6] = `\n\n===== p.7 =====\n${'beam search decoding length penalty alpha coverage 惩罚项用于调整解码长度。'.repeat(20)}`;
  const text = pages.join('').trim();
  const out = window.__ctx.pickRelevantPages(text, 'What is the beam search length penalty alpha?', 3);
  return { out, pages: (out.match(/\[p\.\d+\]/g) || []), dup: /===== p\.\d+ =====/.test(out) };
});
check('检索命中了含关键词的那一页', pick.pages.includes('[p.7]'), pick.pages.join(' ') || '(空)');
check('命中的那页排在最前', pick.pages[0] === '[p.7]', pick.pages.join(' '));
check('最多只取请求的段数', pick.pages.length <= 3, `${pick.pages.length} 段`);
check('摘出来的段落里不再混进下一页的页码标记', pick.dup === false);

const pickEmpty = await page.evaluate(() => {
  const text = Array.from({ length: 5 }, (_, i) => `\n\n===== p.${i + 1} =====\n没有任何匹配词的正文内容。`).join('').trim();
  const out = window.__ctx.pickRelevantPages(text, 'zzz qqq', 4);
  return (out.match(/\[p\.\d+\]/g) || []).length;
});
check('完全没有匹配词时兜底给前几页', pickEmpty > 0 && pickEmpty <= 4, `${pickEmpty} 段`);

const pickNone = await page.evaluate(() => window.__ctx.pickRelevantPages('一段没有页码标记的纯文本', 'abc', 3).length);
check('没有页码标记时不崩', pickNone > 0, `${pickNone} 字`);

console.log('\n-- 「整篇」单次范围');
check('打开论文默认不预读整篇', await page.evaluate(() => !window.__state.docText && !window.__state.docTextDoc));
const fullCtx = await page.evaluate(async () => {
  const ctx = await window.__ctx.buildDocContext('这篇论文讲了什么？', '');
  const t = ctx?.text || '';
  const lastPage = window.__viewer.pdf.numPages;
  const tail = t.split(`===== p.${lastPage} =====`)[1] || '';
  return {
    mode: ctx?.mode, chars: ctx?.chars,
    hasMark: /===== p\.1 =====/.test(t),
    pages: (t.match(/===== p\.\d+ =====/g) || []).length,
    lastPageChars: tail.trim().length,
  };
});
check('buildDocContext 返回整篇文本', fullCtx.mode === 'full', `mode=${fullCtx.mode} ${fullCtx.chars} 字`);
check('全文按页带了页码标记', fullCtx.hasMark && fullCtx.pages === numPages,
  `${fullCtx.pages}/${numPages} 页`);
check('末页正文也在里面（没被截断）', fullCtx.lastPageChars > 100, `末页 ${fullCtx.lastPageChars} 字`);
check('同一份文档第二次调用用的是缓存',
  await page.evaluate(() => window.__state.docTextDoc === window.__state.doc?.docId));

const chip = await page.evaluate(async () => {
  document.getElementById('settingsBtn').click();
  const box = document.getElementById('cfgUseFullText');
  const ui = JSON.parse(localStorage.getItem('reader.ui') || '{}').style || {};
  const checked = box.checked;
  box.checked = false;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 80));
  const off = !!window.__state.useFullText;
  const rangeOff = window.__ctx.scopeRange;
  box.checked = true;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 80));
  const on = !!window.__state.useFullText;
  const ls = JSON.parse(localStorage.getItem('reader.ui') || '{}').style || {};
  document.getElementById('closeSettings').click();
  return { on, off, checked, uiOn: ui.useFullText, savedOn: ls.useFullText, rangeOff };
});
check('设置里的勾选框反映当前状态（默认已勾上）', chip.checked === true, JSON.stringify(chip));
check('取消勾选立刻关掉整篇范围', chip.off === false, JSON.stringify(chip));
check('取消勾选后发送框的范围也跟着退到「只联网」', chip.rangeOff === 'web', chip.rangeOff);
check('重新勾选后 state.useFullText 打开', chip.on === true, JSON.stringify(chip));
check('默认发送范围是全局偏好：写进了 reader.ui 存档', chip.savedOn === true, JSON.stringify(chip));
check('关一次再开一次只改偏好，不影响当前这次提问的内容', await (async () => {
  await setScope('full', false);
  const off = await page.evaluate(() => (JSON.parse(localStorage.getItem('reader.ui') || '{}').style || {}).useFullText);
  await setScope('full', true);
  const on = await page.evaluate(() => (JSON.parse(localStorage.getItem('reader.ui') || '{}').style || {}).useFullText);
  return off === false && on === true && await page.evaluate(() => window.__state.useFullText === true);
})());

await page.waitForFunction(() => window.__state.docText && window.__state.docText.length > 0, { timeout: 30000 })
  .catch(() => {});
const warmed = await page.evaluate(() => (window.__state.docText || '').length);
check('打开论文后全文已读进来（默认全文）', warmed > 500, `${warmed} 字`);

/* ═══════════ 三、超长论文：索引 + 相关段落 ═══════════ */
console.log('\n-- 超长论文走「索引 + 相关段落」分支');
const digest = await page.evaluate(async () => {
  window.__ctx.setFullLimit(5000);          // 把阈值调到 5000 字，这篇 4 万字就算超长
  const ctx = await window.__ctx.buildDocContext('注意力机制的计算复杂度是多少？', '');
  const out = { mode: ctx?.mode, text: ctx?.text || '', chars: ctx?.chars };
  window.__ctx.setFullLimit(100000);        // 立刻还原，别影响后面的用例
  return out;
});
check('超长时切换成索引模式', digest.mode === 'digest', `mode=${digest.mode}`);
check('索引模式下带上了【阅读索引】', digest.text.includes('【阅读索引】'));
check('索引模式下带了相关原文段落', digest.text.includes('【与本次问题最相关的原文段落】'));
check('相关段落按页标了页码', /\[p\.\d+\]/.test(digest.text), (digest.text.match(/\[p\.\d+\]/g) || []).join(' '));
check('索引模式下不再整篇塞进去', digest.text.length < digest.chars, `${digest.text.length} < ${digest.chars}`);
const digestCached = await page.evaluate(async () => {
  const before = window.__state.docDigest;
  await window.__ctx.buildDocContext('换个问题再问一次', '');
  return window.__state.docDigest === before && !!before;
});
check('索引只用一次模型调用（之后走缓存）', digestCached === true);
check('阈值已还原', await page.evaluate(() => window.__ctx.FULL_LIMIT) === 100000);
check('生成索引只发了一次请求', chatRequests.filter((r) => r.sys.includes('阅读索引')).length === 1,
  `${chatRequests.filter((r) => r.sys.includes('阅读索引')).length} 次`);
check('索引请求里带了论文正文', /【正文】/.test(chatRequests.find((r) => r.sys.includes('阅读索引'))?.userText || ''));

console.log('\n-- 「联网」开关');
// 先把查询串的构造逻辑过一遍：整句中文问句直接丢给搜索引擎会被当成单字查询，
// 真实事故是 Bing 返回了一堆「这」字的字典释义。
const queries = await page.evaluate(async () => {
  const m = await import('/js/ai.js');
  return {
    long: m.webQueryFor('这篇论文的核心贡献是什么？另外帮我查一下 Transformer 架构最近有什么重要进展。', ''),
    cn: m.webQueryFor('什么是注意力机制', ''),
    sel: m.webQueryFor('这段什么意思', 'The encoder is composed of a stack of N = 6 identical layers.'),
    en: m.webQueryFor('What are the recent advances of the Transformer architecture?', ''),
    terms: m.searchTerms('这篇论文的核心贡献是什么？另外帮我查一下 Transformer 架构最近有什么重要进展。'),
  };
});
check('长问句被压缩成关键词', queries.long.length < 60 && /Transformer/.test(queries.long), queries.long);
check('压缩后没有留下「这篇/论文/什么/帮我」这类口水词',
  !/这篇|论文|什么|帮我|的|是/.test(queries.long.replace(/Transformer/gi, '')), queries.long);
check('中文问句剔掉提问套话后留下实词', queries.cn === '注意力机制', queries.cn);
check('全是口水话时用选中原文当线索', /encoder/i.test(queries.sel), queries.sel);
check('英文问句丢掉 what/recent/the 只留实词',
  /Transformer|architecture|advances/i.test(queries.en) && !/\bwhat\b|\brecent\b|\bthe\b/i.test(queries.en),
  queries.en);
check('术语提取有结果', Array.isArray(queries.terms) && queries.terms.length > 0, JSON.stringify(queries.terms));

await setScope('web', true);
check('设置里勾上「联网」后立刻是开启态',
  await page.evaluate(() => window.__state.useWeb === true
    && (JSON.parse(localStorage.getItem('reader.ui') || '{}').style || {}).useWeb === true
    && (document.getElementById('composerScope')?.textContent || '').includes('联网')));

/* ═══════════ 五、发一条真实的问题，检查真正送出去的 prompt ═══════════ */
console.log('\n-- 送出去的 prompt');
const i1 = chatRequests.length;   // 上一节生成索引已经花掉一次请求，这里按相对位置取
const done1 = await page.evaluate(() => document.querySelectorAll('#aiArea .msg.assistant .acts:not(.hidden)').length);
const histBefore = await page.evaluate(() => window.__state.history.length);
async function ensureComposer() {
  const visible = await page.evaluate(() => (document.getElementById('chatInput')?.getBoundingClientRect().width || 0) > 0);
  if (visible) return;
  await page.evaluate(() => {
    window.__ctx.setPanelVisible('chat', true);
    document.body.classList.remove('no-right');
  });
  await sleep(500);
}

await ensureComposer();
await page.click('#chatInput');
await page.type('#chatInput', '注意力机制到底是什么？');
await page.keyboard.press('Enter');
await page.waitForFunction((n) => document.querySelectorAll('#aiArea .msg.assistant .acts:not(.hidden)').length > n,
  { timeout: 30000 }, done1);

check('这次提问只发了一次 AI 请求', chatRequests.length === i1 + 1, `${chatRequests.length - i1} 次`);
const sent = chatRequests[i1]?.userText || '';
check('prompt 里带了整篇论文', sent.includes('【论文全文'), sent.includes('【论文全文') ? '' : sent.slice(0, 80));
check('prompt 里的全文带页码标记', /===== p\.1 =====/.test(sent));
check('prompt 里带回了联网搜索结果', sent.includes('【联网搜索结果】'));
check('搜索结果带来源编号和直链',
  sent.includes('[来源1] Attention Is All You Need') && sent.includes('https://arxiv.org/abs/1706.03762'));
check('prompt 明确要求区分「来源N」与论文自己的 [27] 式编号',
  /\[来源1\]/.test(sent) && /参考文献/.test(sent));
check('system 提示里交代了引用规则', /来源|联网搜索结果/.test(chatRequests[i1]?.sys || ''));
check('prompt 里带了用户的问题', sent.includes('注意力机制到底是什么？'));
check('联网搜索用了问题本身当查询词',
  searchQueries.length === 1 && /Transformer|注意力/.test(searchQueries[0]),
  searchQueries[0] || '(没搜)');
check('送出去的查询串是关键词而不是整句',
  searchQueries.length === 1 && !/帮我|是什么|另外/.test(searchQueries[0]),
  searchQueries[0] || '(没搜)');

/* ═══════════ 六、界面：来源列表与元信息 ═══════════ */
console.log('\n-- 界面呈现');
const ui = await page.evaluate(() => {
  // 取最后一条助手消息，不要拿「第一条 .msg.assistant」：会话恢复会把旧回答一起重放出来，
  // 而且分块之后 DOM 顺序 ≠ 时间顺序（要看 dataset.seq），第一条很可能属于上一批套件。
  const msgs = [...document.querySelectorAll('#aiArea .msg.assistant')]
    .sort((a, b) => Number(a.dataset.seq || 0) - Number(b.dataset.seq || 0));
  const root = msgs.at(-1);
  if (!root) return { n: 0, hrefs: [], texts: [], nums: [], meta: '', blank: true };
  const links = [...root.querySelectorAll('.src-list a')];
  return {
    n: links.length,
    hrefs: links.map((a) => a.href),
    texts: links.map((a) => a.textContent.trim()),
    nums: [...root.querySelectorAll('.src-list .src-n')].map((s) => s.textContent),
    meta: root.querySelector('.entry-meta')?.textContent || '',
    blank: links.every((a) => a.target === '_blank'),
  };
});
check('回答下面列出了全部来源', ui.n === WEB_RESULTS.length, `${ui.n} 条`);
check('来源链接是可点的外链', ui.blank && ui.hrefs[0] === WEB_RESULTS[0].url, ui.hrefs[0] || '(无)');
check('来源带编号 [来源1] [来源2] [来源3]', ui.nums.join(' ') === '[来源1] [来源2] [来源3]', ui.nums.join(' '));
check('来源用标题当链接文字', ui.texts[0] === WEB_RESULTS[0].title, ui.texts[0]);
check('元信息写明了联网条数', /联网 3 条/.test(ui.meta), ui.meta);
check('元信息写明了整篇论文来源', /整篇论文/.test(ui.meta), ui.meta);
check('回答正文渲染正常', await page.evaluate(() => {
  const msgs = [...document.querySelectorAll('#aiArea .msg.assistant')]
    .sort((a, b) => Number(a.dataset.seq || 0) - Number(b.dataset.seq || 0));
  return (msgs.at(-1)?.querySelector('.text')?.textContent || '').includes('注意力机制');
}));

// 只断言「这次问答新增了一问一答两条」：脏 data 下 restoreSession() 会把旧历史一并恢复，
// 写死 === 2 会在有历史时假红。
const histLen = await page.evaluate(() => window.__state.history.length);
check('问答写进了历史（用于多轮）', histLen === histBefore + 2, `${histLen} 条（本轮之前 ${histBefore} 条）`);

/* ═══════════ 八、发送范围是全局偏好：关掉之后提问就不带那些东西 ═══════════ */
console.log('\n-- 关掉范围后提问');
await setScope('web', false);
const offState = await page.evaluate(() => ({
  f: !!window.__state.useFullText,
  w: !!window.__state.useWeb,
  scope: document.getElementById('sendScope')?.textContent || '',
  ls: JSON.parse(localStorage.getItem('reader.ui') || '{}').style || {},
}));
check('关掉联网后 state 立刻是关的（整篇保持默认开着）',
  offState.f === true && offState.w === false, JSON.stringify(offState));
check('范围偏好写进了 reader.ui 存档（不再是一次性的）',
  offState.ls.useWeb === false && offState.ls.useFullText === true, JSON.stringify(offState.ls));
check('输入框上方的提示跟着变（只说联网没了）',
  offState.scope.includes('整篇论文') && !offState.scope.includes('联网搜索'), JSON.stringify(offState.scope));

const searchBefore = searchQueries.length;
const i2 = chatRequests.length;
const done2 = await page.evaluate(() => document.querySelectorAll('#aiArea .msg.assistant .acts:not(.hidden)').length);
await page.click('#chatInput');
await page.type('#chatInput', '再问一次，这次不带那些东西');
await page.keyboard.press('Enter');
await page.waitForFunction((n) => document.querySelectorAll('#aiArea .msg.assistant .acts:not(.hidden)').length > n,
  { timeout: 30000 }, done2);
const bare = chatRequests[i2]?.userText || '';
check('关掉后不再联网', searchQueries.length === searchBefore, `${searchQueries.length - searchBefore} 次搜索`);
check('关掉后 prompt 里没有全文', !bare.includes('【论文全文') && !/===== p\.\d+ =====/.test(bare));
check('关掉后 prompt 里没有搜索结果', !bare.includes('【联网搜索结果】'));
check('关掉后问题本身照样发出去了', bare.includes('再问一次，这次不带那些东西'));
check('关掉后不再显示来源列表', await page.evaluate(() => {
  // 取最后一条助手消息，不要按下标 [1]（脏 data 下下标全部错位）
  const msgs = [...document.querySelectorAll('#aiArea .msg.assistant')]
    .sort((a, b) => Number(a.dataset.seq || 0) - Number(b.dataset.seq || 0));
  return msgs.at(-1)?.querySelectorAll('.src-list').length === 0;
}));

/* ═══════════ 九、搜索挂了也要能回答（优雅降级） ═══════════ */
console.log('\n-- 搜索失败降级');
searchMode = 'fail';
expectingFetchFailure = true;
await setScope('web', true);
const i3 = chatRequests.length;
const done3 = await page.evaluate(() => document.querySelectorAll('#aiArea .msg.assistant .acts:not(.hidden)').length);
await page.click('#chatInput');
await page.type('#chatInput', '搜索挂掉的时候还能回答吗');
await page.keyboard.press('Enter');
await page.waitForFunction((n) => document.querySelectorAll('#aiArea .msg.assistant .acts:not(.hidden)').length > n,
  { timeout: 30000 }, done3);
const degraded = chatRequests[i3]?.userText || '';
check('搜索失败不影响出答案', degraded.length > 0 && !degraded.includes('【联网搜索结果】'));
check('搜索失败后没有来源列表', await page.evaluate(() => {
  const msgs = [...document.querySelectorAll('#aiArea .msg.assistant')]
    .sort((a, b) => Number(a.dataset.seq || 0) - Number(b.dataset.seq || 0));
  return msgs.at(-1)?.querySelectorAll('.src-list').length === 0;
}));
check('搜索失败没有把页面搞崩（无未捕获异常）', pageErrors.length === 0, pageErrors[0] || '');
expectingFetchFailure = false;
searchMode = 'ok';

/* ═══════════ 十、刷新后偏好保留（发送范围是全局设置，跨启动算数） ═══════════ */
console.log('\n-- 刷新后状态保留');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#fileList li', { timeout: 20000 });
await sleep(400);
const afterReload = await page.evaluate(() => ({
  w: !!window.__state.useWeb,
  f: !!window.__state.useFullText,
  scope: document.getElementById('sendScope')?.textContent || '',
}));
check('刷新后「联网」仍是开始的（上一步刚打开）', afterReload.w === true);
check('刷新后「整篇」仍是默认开着的', afterReload.f === true);
check('刷新后范围提示写着「整篇论文 + 联网搜索」',
  afterReload.scope.includes('整篇论文') && afterReload.scope.includes('联网搜索'), JSON.stringify(afterReload.scope));

/* ═══════════ 十一、竞态：自动恢复和手点撞车 ═══════════ */
// 真实事故：启动时 boot() 会自动恢复「上次那篇」，如果用户同时点了列表里的同一篇，
// 两次并发加载都指向同一个 docId，先被中断的那次会在 catch 里把界面清成「未打开文档」，
// 而 PDF 已经显示出来了 —— 结果就是「看得见论文，却用不了全文」。
console.log('\n-- 自动恢复与手点撞车');
await postJson(`${BASE}/api/state`, {
  docs: {}, lastDoc: first.docId, lastUrl: first.url, lastName: first.name,
});
const p2 = await browser.newPage();
try {
  await p2.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await p2.waitForSelector('#fileList li', { timeout: 20000 });
  // 不等 boot 跑完，立刻点
  await p2.evaluate((id) => {
    const li = [...document.querySelectorAll('#fileList li')].find((x) => x.dataset.id === id)
      || document.querySelector('#fileList li');
    li.click();
  }, first.docId);
  await p2.waitForFunction(() => window.__viewer?.pdf, { timeout: 40000 });
  await sleep(1800);
  const race = await p2.evaluate(() => ({
    doc: window.__state.doc?.name || null,
    name: document.getElementById('docName').textContent,
    // 2026-10：#welcome 升级成了独立的首页 #home，阅读态由 body.reading 表达。
    // 这里要验的语义没变 ——「打开论文之后不该还停在首页」。
    reading: document.body.classList.contains('reading'),
    homeHidden: document.getElementById('home')?.classList.contains('hidden'),
    chatUsable: !document.getElementById('chatInput').disabled,
    pages: document.querySelectorAll('.page canvas').length,
  }));
  check('自动恢复与手点撞车后状态一致（不是「PDF 显示着但未打开文档」）',
    race.doc === first.name && race.reading && race.homeHidden && race.name === first.name,
    JSON.stringify(race));
  check('撞车后输入框可用（说明文档状态是好的）', race.chatUsable === true, JSON.stringify(race));
  check('撞车后页面确实渲染了', race.pages >= 1, `${race.pages} 个画布`);
} finally {
  await p2.close();
}

await page.screenshot({ path: path.join(OUT, 'context.png'), fullPage: false });

check('没有未捕获的页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
check('没有控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

await browser.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
