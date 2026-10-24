/**
 * 学习档案验收：/api/profile 的校验与落盘 + 弹窗编辑 + 时间戳 + 待确认 + 个性化注入。
 *
 *   BASE=http://127.0.0.1:8787 node test/profile.mjs
 *
 * 时间口径（用户要求）：
 *   · 写入档案时带当时时间（客户端 ISO 8601 带本地时区）；
 *   · 每次 AI 调用把「当前时间」交给模型；
 *   · 档案条目进 prompt 时带「约 N 天前确认」和「超过 90 天 → 可能生疏」的代码标签。
 */
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, resolveDataDir } from './_env.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  [OK]' : '  [XX]'} ${name}${detail ? `  -- ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const postJson = (url, obj) => fetch(`${BASE}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const getJson = async (url) => (await fetch(`${BASE}${url}`)).json();
const profile = () => getJson('/api/profile');

const pad2 = (n) => String(n).padStart(2, '0');
const isoLocal = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  + `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}+08:00`;
const daysAgoISO = (n) => isoLocal(new Date(Date.now() - n * 86400000));
const ISO_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

/* ── 准备 ── */
const papers = await (await fetch(`${BASE}/api/papers`)).json().catch(() => ({ papers: [] }));
const first = (papers.papers || [])[0] || {};
check('服务端有可用的 PDF', !!first.name, first.name || '(无)');
assertIsolatedDataDir(resolveDataDir(papers.dir));
await postJson('/api/state', { lastDoc: null, lastName: null, lastUrl: null, docs: {} });
await postJson('/api/config', { apiKey: 'sk-profile-test', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-flash' });
{
  const list = await (await fetch(`${BASE}/api/sessions?doc=${encodeURIComponent(first.docId)}`)).json().catch(() => ({}));
  for (const s of list.sessions || []) {
    await fetch(`${BASE}/api/session?doc=${encodeURIComponent(first.docId)}${s.sid ? `&sid=${encodeURIComponent(s.sid)}` : ''}`, { method: 'DELETE' }).catch(() => {});
  }
}

/* ── 一、接口校验（Node 侧直接打 /api/profile） ── */
console.log('\n-- /api/profile 校验');
await postJson('/api/profile', { version: 1, revision: 0, updatedAt: '', selfReport: '', selfReportAt: '', items: [] });
const empty = await profile();
check('默认返回空档案结构', empty.version === 1 && Array.isArray(empty.items) && empty.items.length === 0);
const staleAt = daysAgoISO(120);
const pendingAt = daysAgoISO(1);
const validProfile = {
  version: 1, revision: 3, updatedAt: isoLocal(),
  selfReport: '学过 PyTorch，写过 CNN；矩阵运算基本会，概率论比较薄弱',
  selfReportAt: daysAgoISO(4),
  items: [
    {
      id: 'kp-stale', topic: '残差连接', aliases: ['residual connection'], level: '理解基本原理，能够实现',
      boundary: '维度一致时的相加能解释；维度变化时的投影不熟', basis: 'user_confirmed', status: 'confirmed',
      createdAt: daysAgoISO(200), updatedAt: staleAt, lastConfirmedAt: staleAt, source: null, note: '',
    },
    {
      id: 'kp-pending', topic: '多头注意力', aliases: [], level: '能说清原理',
      boundary: '知道并行多组投影再拼接；W^O 的形状没算过', basis: 'model_inferred', status: 'pending',
      createdAt: pendingAt, updatedAt: pendingAt, lastConfirmedAt: null, source: null, note: 'AI 观察',
    },
  ],
};
let r = await postJson('/api/profile', validProfile);
check('合法档案能保存（200）', r.status === 200, `${r.status}`);
const saved = await profile();
check('时间戳按客户端写入的原样保存', saved.items[0].lastConfirmedAt === staleAt && saved.items[0].createdAt === daysAgoISO(200));
check('自述也带填写时间', saved.selfReportAt === daysAgoISO(4) && /PyTorch/.test(saved.selfReport));

const invalidCases = [
  ['版本不对', { ...validProfile, version: 2 }],
  ['缺少 items', { version: 1, revision: 1 }],
  ['条目缺 topic', { ...validProfile, items: [{ ...validProfile.items[0], topic: '' }] }],
  ['状态不合法', { ...validProfile, items: [{ ...validProfile.items[0], status: 'mastered' }] }],
  ['createdAt 不是合法时间', { ...validProfile, items: [{ ...validProfile.items[0], createdAt: '昨天' }] }],
  ['不是对象', [1, 2, 3]],
];
for (const [name, payload] of invalidCases) {
  const rr = await postJson('/api/profile', payload);
  check(`拒绝${name}（400）`, rr.status === 400, `${rr.status}`);
}
const afterInvalid = await profile();
check('校验失败不覆盖旧档案', afterInvalid.items.length === 2 && afterInvalid.items[0].lastConfirmedAt === staleAt);
const many = { ...validProfile, items: Array.from({ length: 201 }, (_, i) => ({ ...validProfile.items[0], id: `kp-${i}`, topic: `知识点 ${i}` })) };
const rrMany = await postJson('/api/profile', many);
check('条目数超上限（201 条）被拒', rrMany.status === 400, `${rrMany.status}`);
const msTime = isoLocal().replace(/(\+\d{2}:\d{2})$/, '.123$1');
const rrMs = await postJson('/api/profile', { ...validProfile, items: [{ ...validProfile.items[0], updatedAt: msTime }] });
check('带毫秒的 ISO 时间也接受', rrMs.status === 200, `${rrMs.status}`);
await postJson('/api/profile', validProfile);

/* ── 二、Prompt 注入与「当前时间」（教学请求 system） ── */
console.log('\n-- 注入 prompt');
const chatBodies = [];
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1500,950'],
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.setRequestInterception(true);
page.on('request', (req) => {
  if (req.url().endsWith('/api/chat')) {
    chatBodies.push(JSON.parse(req.postData() || '{}'));
    const sse = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '桩回答。' } }] }) + '\n\ndata: [DONE]\n\n';
    return req.respond({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: sse });
  }
  return req.continue();
});
const open = async () => {
  await page.goto(`${BASE}/?open=${encodeURIComponent(first.name)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.pdf && window.__ctx, { timeout: 40000 });
  await sleep(1200);
};
await open();
await page.evaluate(() => window.__ctx.runTeaching('prereq', { force: true }));
await page.waitForFunction(() => !window.__state.busy, { timeout: 20000 });
await sleep(300);
const sys = chatBodies.at(-1).messages[0].content;
check('system 里注入学习档案规则', /学习档案 · 只影响讲解深度/.test(sys));
check('system 里注入当前时间', /【当前时间】\d{4}-\d{2}-\d{2} \d{2}:\d{2}（周[一二三四五六日]，UTC[+-]\d{2}:\d{2}）/.test(sys));
check('超过 90 天的条目带「可能生疏」标签', /超过 90 天未确认|可能生疏/.test(sys), (sys.match(/残差连接[^\n]*/) || [''])[0].slice(0, 80));
check('待确认条目标了「不能当作已掌握」', /待确认[^\n]*不能当作已掌握/.test(sys), (sys.match(/多头注意力[^\n]*/) || [''])[0].slice(0, 80));
check('档案里带「约 N 天前确认」的代码计算值', /约 120 天前/.test(sys));
check('档案块不会超过 1200 字', sys.length < 20000);

/* ── 三、弹窗：查看 / 编辑 / 待确认 / 时间显示 ── */
console.log('\n-- 学习档案弹窗');
await page.evaluate(() => window.__ctx.openProfile());
await sleep(300);
const modal = await page.evaluate(() => {
  const m = document.getElementById('profileModal');
  return {
    open: !m.classList.contains('hidden'),
    counts: m.querySelector('#profileCounts')?.textContent || '',
    selfValue: m.querySelector('#profileSelfReport')?.value || '',
    selfAt: m.querySelector('#profileSelfAt')?.textContent || '',
    pending: m.querySelectorAll('#profilePending .profile-card').length,
    confirmed: m.querySelectorAll('#profileConfirmed .profile-card').length,
    staleChip: [...m.querySelectorAll('#profileConfirmed .profile-chip')].some((c) => c.textContent === '可能生疏'),
    dates: [...m.querySelectorAll('.profile-date')].map((x) => x.textContent),
  };
});
check('弹窗显示自述与填写时间', /PyTorch/.test(modal.selfValue) && /\d{4}-\d{2}-\d{2}/.test(modal.selfAt), modal.selfAt);
check('弹窗区分待确认 / 已确认', modal.pending === 1 && modal.confirmed === 1, `pending=${modal.pending} confirmed=${modal.confirmed}`);
check('超过 90 天的已确认条目显示「可能生疏」', modal.staleChip);
check('条目显示确认日期与相对时间', modal.dates.some((d) => /确认（(?:\d+ 天前|\d+ 个月前)）/.test(d)), modal.dates.join(' | '));

// 待确认 → 还不会
await page.evaluate(() => {
  const card = document.querySelector('#profilePending .profile-card');
  [...card.querySelectorAll('.profile-btn')].find((b) => b.textContent === '还不会').click();
});
await sleep(800);
const afterReject = await profile();
const multi = afterReject.items.find((i) => i.topic === '多头注意力');
check('待确认条目标「还不会」后变成已确认记录', multi?.status === 'confirmed' && /还不会/.test(multi.level) && !!multi.lastConfirmedAt, multi?.level);

// 手动添加一条
await page.evaluate(() => document.getElementById('profileAdd').click());
await sleep(200);
await page.evaluate(() => {
  const card = document.querySelector('#profileConfirmed .profile-card.editing');
  const inputs = card.querySelectorAll('input');
  inputs[0].value = '位置编码';
  inputs[1].value = '只听过名字';
  card.querySelector('textarea').value = '知道它补词序，但公式没记住';
  [...card.querySelectorAll('.profile-btn')].find((b) => b.textContent === '添加').click();
});
await sleep(800);
const afterAdd = await profile();
const pos = afterAdd.items.find((i) => i.topic === '位置编码');
check('手动添加的条目带合法时间戳', !!pos && ISO_TZ.test(pos.createdAt) && ISO_TZ.test(pos.lastConfirmedAt), pos?.createdAt || '(没有)');

// 编辑已确认条目（编辑即一次新确认）
const beforeEdit = pos.lastConfirmedAt;
await page.evaluate(() => {
  const cards = [...document.querySelectorAll('#profileConfirmed .profile-card')];
  const card = cards.find((c) => /位置编码/.test(c.textContent));
  [...card.querySelectorAll('.profile-btn')].find((b) => b.textContent === '编辑').click();
});
await sleep(200);
await page.evaluate(() => {
  const card = document.querySelector('#profileConfirmed .profile-card.editing');
  card.querySelector('textarea').value = '公式也没记住，需要从位置编码公式讲起';
  [...card.querySelectorAll('.profile-btn')].find((b) => b.textContent === '保存').click();
});
await sleep(800);
const afterEdit = await profile();
const pos2 = afterEdit.items.find((i) => i.topic === '位置编码');
check('编辑后边界更新且 lastConfirmedAt 刷新', /公式也没记住/.test(pos2?.boundary || '') && pos2.lastConfirmedAt >= beforeEdit, `${pos2?.lastConfirmedAt}`);

// 自述保存
await page.evaluate(() => {
  const ta = document.querySelector('#profileSelfReport');
  ta.value = '学过 PyTorch，写过 CNN；矩阵运算基本会，概率论比较薄弱';
  document.getElementById('profileSelfSave').click();
});
await sleep(800);
const afterSelf = await profile();
check('自述保存带填写时间', /PyTorch/.test(afterSelf.selfReport) && ISO_TZ.test(afterSelf.selfReportAt), afterSelf.selfReportAt);

// 删除一条
const countBeforeDelete = (await profile()).items.length;
await page.evaluate(() => {
  const cards = [...document.querySelectorAll('#profileConfirmed .profile-card')];
  const card = cards.find((c) => /残差连接/.test(c.textContent));
  [...card.querySelectorAll('.profile-btn')].find((b) => b.textContent === '删除').click();
});
await sleep(800);
check('删除条目生效', (await profile()).items.length === countBeforeDelete - 1);
await page.evaluate(() => window.__ctx.closeProfile());

/* ── 四、设置页开关持久化 ── */
console.log('\n-- 个性化开关');
await page.evaluate(() => window.__ctx.profileStore.setEnabled(false));
await open();
const disabled = await page.evaluate(() => window.__ctx.profileEnabled);
check('关闭个性化后状态持久（localStorage）', disabled === false);
await page.evaluate(() => window.__ctx.profileStore.setEnabled(true));

check('没有未捕获的页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
await browser.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
await sleep(250);
process.exit(passed === results.length ? 0 : 1);
