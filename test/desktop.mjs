/**
 * 桌面版（exe）验收：启动 exe → 找到端口 → 验证 HTTP 接口 → 打印端口给 e2e 用
 *   node test/desktop.mjs
 * 之后可以： BASE=http://127.0.0.1:<port> node e2e.mjs
 *
 * 隔离原则（2026-11 起）：只启动 test/artifacts 里的**副本**，不启动也不关闭用户正在用的那个 exe；
 * 副本用 `--background` 启动（窗口不显示、不抢焦点、不占任务栏）。用户实例继续占着它自己的端口。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { deliverableExe, killSandboxInstances, spawnReader, stageExe } from './_exe.mjs';

const ROOT = path.join(import.meta.dirname, '..');
// 交付物：只用来做「前端是否重新内嵌」的 mtime 对比；真正启动的是下面的沙箱副本。
const DELIVERABLE = deliverableExe();
const RANGE = Array.from({ length: 20 }, (_, i) => 8787 + i);
const SANDBOX = path.join(import.meta.dirname, 'artifacts', 'desktop-isolated');
const DATA = path.join(SANDBOX, 'data');
const PAPERS = path.join(SANDBOX, 'papers');

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '  ✅' : '  ❌'} ${n}${d ? `  — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* `node desktop.mjs --stop`：只收掉沙箱里遗留的测试副本，不碰任何用户实例 */
if (process.argv.includes('--stop')) {
  killSandboxInstances();
  console.log('已收掉 test/artifacts 下遗留的测试副本（用户正在用的实例未受影响）');
  process.exit(0);
}

/* ── 只清理沙箱里遗留的旧副本（用户正在用的实例不在沙箱前缀下，绝不会被命中） ── */
killSandboxInstances();
await sleep(300);
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(PAPERS, { recursive: true });
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'cn-sample.pdf'), path.join(PAPERS, 'fixture-cn-sample.pdf'));
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), path.join(PAPERS, 'fixture-multipage.pdf'));

if (!fs.existsSync(DELIVERABLE)) {
  console.error(`找不到 exe：${DELIVERABLE}\n先跑 desktop/build.bat`);
  process.exit(2);
}

const STAGED = stageExe('desktop');

/* ── 陈旧的构建产物检查 ──
   前端（public/）是 rust-embed 编译期嵌进 exe 的，改了 public/ 不重新 build，
   跑出来的「通过」全是假的。这里直接把 mtime 摆出来。 */
{
  let newest = 0;
  let newestFile = '';
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const m = fs.statSync(p).mtimeMs;
      if (m > newest) { newest = m; newestFile = p; }
    }
  };
  walk(path.join(ROOT, 'public'));
  const exeM = fs.statSync(DELIVERABLE).mtimeMs;
  check('exe 不旧于 public/（前端已重新内嵌）', exeM >= newest - 1000,
    `exe=${new Date(exeM).toLocaleTimeString()} 最新前端=${path.relative(ROOT, newestFile)}@${new Date(newest).toLocaleTimeString()}`);
}

check('验收启动的是沙箱副本（不碰用户正在用的应用）',
  !path.relative(path.join(import.meta.dirname, 'artifacts'), STAGED.exe).startsWith('..'),
  path.relative(ROOT, STAGED.exe));

console.log(`启动（后台模式，不显示窗口）：${STAGED.exe}`);
const child = spawnReader(STAGED.exe, {
  env: { PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1' },
});
fs.writeFileSync(path.join(SANDBOX, 'reader.pid'), String(child.pid));

/* ── 找端口 ── */
let base = null;
for (let attempt = 0; attempt < 40 && !base; attempt++) {
  await sleep(400);
  for (const p of RANGE) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(500) });
      if (r.ok) {
        const j = await r.json();
        if (!j?.ok) continue;
        // Another reader may already be open on an earlier port. Only use this test's
        // token-disabled instance and fixture, never the user's live data service.
        const papersProbe = await fetch(`http://127.0.0.1:${p}/api/papers`, { signal: AbortSignal.timeout(500) });
        if (!papersProbe.ok) continue;
        const listing = await papersProbe.json();
        if ((listing.papers || []).some((paper) => paper.name === 'fixture-multipage.pdf')) {
          base = `http://127.0.0.1:${p}`;
          break;
        }
      }
    } catch { /* 还没起来 */ }
  }
}
check('exe 启动并开了本地服务', !!base, base || '16 秒内没起来');
if (!base) { process.exit(1); }

/* ── 进程与窗口 ──
   --background 模式下窗口是隐藏的（不抢焦点、不占任务栏），所以不能用
   MainWindowTitle（它只认可见窗口）；用 EnumWindows 按 PID 找它的顶层窗口和标题，
   证明「原生窗口确实创建了」而不需要把窗口显示到用户屏幕上。 */
try {
  const script = [
    'Add-Type @\'',
    'using System;',
    'using System.Text;',
    'using System.Runtime.InteropServices;',
    'public class PrtWin {',
    '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  public static string TitleOf(uint pid) {',
    '    string found = null;',
    '    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);',
    '      if (p == pid) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512);',
    '        if (sb.Length > 0) { found = sb.ToString() + "|" + (IsWindowVisible(h) ? "visible" : "hidden"); return false; } } return true; }, IntPtr.Zero);',
    '    return found;',
    '  }',
    '}',
    '\'@',
    '[PrtWin]::TitleOf([uint32]$env:PRT_PID)',
  ].join('\n');
  const out = execFileSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf8', env: { ...process.env, PRT_PID: String(child.pid) },
  }).trim();
  const [title, visibility] = out.split('|');
  check('原生窗口已创建且标题正确', title === 'prt', `pid=${child.pid} title="${title}"`);
  check('后台模式窗口不可见（不抢焦点、不占任务栏）', visibility === 'hidden', `window=${visibility}`);
} catch (e) {
  check('原生窗口已创建且标题正确', false, String(e.message).slice(0, 80));
  check('后台模式窗口不可见（不抢焦点、不占任务栏）', false, String(e.message).slice(0, 80));
}

/* ── 接口 ── */
console.log('\n▶ HTTP 接口…');
const health = await fetch(`${base}/api/health`).then((r) => r.json());
check('/api/health', health.ok === true && health.port > 0, JSON.stringify(health));

const papers = await fetch(`${base}/api/papers`).then((r) => r.json());
check('/api/papers 列出了 PDF', Array.isArray(papers.papers) && papers.papers.length > 0,
  `${papers.papers?.length} 篇，dir=${papers.dir}`);
check('论文有 url 和 docId', !!papers.papers?.[0]?.url && !!papers.papers?.[0]?.docId, papers.papers?.[0]?.name);

const name = papers.papers[0].name;
const full = await fetch(`${base}/api/pdf?name=${encodeURIComponent(name)}`);
check('/api/pdf 完整读取', full.status === 200 && Number(full.headers.get('content-length')) > 1000,
  `${full.status} ${full.headers.get('content-length')}B`);
check('/api/pdf 带 Accept-Ranges', full.headers.get('accept-ranges') === 'bytes');
await full.arrayBuffer();

const ranged = await fetch(`${base}/api/pdf?name=${encodeURIComponent(name)}`, { headers: { Range: 'bytes=100-199' } });
check('/api/pdf Range 返回 206', ranged.status === 206 && Number(ranged.headers.get('content-length')) === 100,
  `${ranged.status} ${ranged.headers.get('content-range')}`);
await ranged.arrayBuffer();

const suffix = await fetch(`${base}/api/pdf?name=${encodeURIComponent(name)}`, { headers: { Range: 'bytes=-50' } });
check('/api/pdf 后缀 Range', suffix.status === 206, `${suffix.status}`);
await suffix.arrayBuffer();

const bad = await fetch(`${base}/api/pdf?name=${encodeURIComponent(name)}`, { headers: { Range: 'bytes=99999999-' } });
check('/api/pdf 越界 Range 返回 416', bad.status === 416, `${bad.status}`);

const cfg = await fetch(`${base}/api/config`).then((r) => r.json());
check('/api/config 不回传密钥', cfg.apiKey === '' && typeof cfg.hasApiKey === 'boolean', `hasApiKey=${cfg.hasApiKey}`);
check('/api/config 有默认值', !!cfg.baseURL && !!cfg.model, `${cfg.baseURL} / ${cfg.model}`);

const saved = await fetch(`${base}/api/config`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ targetLang: '中文', glossary: 'attention=注意力', apiKey: 'fake-desktop-test-key' }),
}).then((r) => r.json());
const cfg2 = await fetch(`${base}/api/config`).then((r) => r.json());
check('/api/config 写入中文正常（UTF-8）', cfg2.targetLang === '中文' && cfg2.glossary === 'attention=注意力',
  `${cfg2.targetLang} / ${cfg2.glossary}`);
check('/api/config 仅用假密钥且不回传', saved.hasApiKey === true && cfg2.apiKey === '' && cfg2.hasApiKey === true);

/* ── 视觉模型开关 / 长期记忆：Node 与 Rust 必须同契约 ── */
console.log('\n▶ 视觉模型与长期记忆…');
{
  const seen = [];
  const mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
      seen.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'mock ok' } }] }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockBase = `http://127.0.0.1:${mock.address().port}/v1`;
  try {
    const cfgSave = await fetch(`${base}/api/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseURL: mockBase, apiKey: 'fake-vision-key', model: 'text-mock', visionModel: 'vision-mock',
        longTermMemory: '我在读多模态方向，解释时保留英文术语',
      }),
    }).then((r) => r.json());
    check('/api/config 接受 visionModel / longTermMemory', cfgSave.ok === true, JSON.stringify(cfgSave));
    const cfgVision = await fetch(`${base}/api/config`).then((r) => r.json());
    check('config 回读 visionModel', cfgVision.visionModel === 'vision-mock', cfgVision.visionModel);
    check('config 回读长期记忆（中文 UTF-8）',
      cfgVision.longTermMemory === '我在读多模态方向，解释时保留英文术语', cfgVision.longTermMemory);

    const chat = (payload) => fetch(`${base}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }], stream: false, ...payload }),
    }).then((r) => r.json());
    await chat({ useVision: true });
    check('useVision=true 时上游收到 visionModel', seen.at(-1)?.model === 'vision-mock', seen.at(-1)?.model);
    await chat({ useVision: false });
    check('普通请求用主模型', seen.at(-1)?.model === 'text-mock', seen.at(-1)?.model);
    await chat({ model: 'evil-model', useVision: false });
    check('请求体里的 model 仍被忽略（模型只能来自本机 config）', seen.at(-1)?.model === 'text-mock', seen.at(-1)?.model);
    await chat({ useVision: true, messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }] }] });
    check('视觉请求的消息体原样转发（图片分段不被改写）',
      Array.isArray(seen.at(-1)?.messages?.[0]?.content), JSON.stringify(seen.at(-1)?.messages?.[0]?.content).slice(0, 60));
  } finally {
    await new Promise((r) => { mock.closeAllConnections?.(); mock.close(r); });
  }
  // 复原成不会真被调用的地址，后续写盘失败测试不受影响
  await fetch(`${base}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: 'https://api.deepseek.com/v1' }),
  });
}

// 故意让目标文件名变成目录，验证原子写入失败会返回 HTTP 错误。
const failWrite = async (filename, endpoint, body) => {
  const target = path.join(DATA, filename);
  const backup = `${target}.test-backup`;
  if (fs.existsSync(target) && fs.statSync(target).isFile()) fs.renameSync(target, backup);
  fs.mkdirSync(target, { recursive: true });
  const r = await fetch(`${base}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  fs.rmSync(target, { recursive: true, force: true });
  if (fs.existsSync(backup)) fs.renameSync(backup, target);
  return r.status;
};
check('/api/config 写盘失败返回错误', await failWrite('config.json', '/api/config', { glossary: 'pending' }) >= 500);
check('/api/state 写盘失败返回错误', await failWrite('state.json', '/api/state', { probe: 2 }) >= 500);
const noteDoc = 'desktop-write-failure';
let h = 5381; for (const c of noteDoc) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
const noteSlug = noteDoc.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 48);
const noteFile = `notes-${noteSlug}-${h.toString(16)}.json`;
check('/api/notes 写盘失败返回错误', await failWrite(noteFile, `/api/notes?doc=${noteDoc}`, { items: [{ id: 'kept' }] }) >= 500);
const sessionStatus = await fetch(`${base}/api/session?doc=${noteDoc}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries: [{ text: 'restored' }] }) });
const session = await fetch(`${base}/api/session?doc=${noteDoc}`).then((r) => r.json());
check('/api/session 写入并读回', sessionStatus.ok && session.entries?.[0]?.text === 'restored');

await fetch(`${base}/api/notes?doc=desktop-check`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ items: [{ id: 'x', page: 1 }] }),
});
const notes = await fetch(`${base}/api/notes?doc=desktop-check`).then((r) => r.json());
check('/api/notes 写入并读回', Array.isArray(notes.items) && notes.items.length === 1, JSON.stringify(notes));
await fetch(`${base}/api/notes?doc=desktop-check`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [] }),
});

await fetch(`${base}/api/state`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ probe: 1 }),
});
const st = await fetch(`${base}/api/state`).then((r) => r.json());
check('/api/state 读写', st.probe === 1, JSON.stringify(st).slice(0, 60));

console.log('\n▶ 静态资源与安全…');
const index = await fetch(`${base}/`);
const html = await index.text();
check('/ 返回前端页面', index.status === 200 && html.includes('prt'), `${index.status} ${html.length}B`);
check('首页 MIME 正确', (index.headers.get('content-type') || '').includes('text/html'), index.headers.get('content-type'));

const appjs = await fetch(`${base}/js/app.js`);
check('/js/app.js MIME 必须是 text/javascript', (appjs.headers.get('content-type') || '').includes('javascript'),
  `${appjs.status} ${appjs.headers.get('content-type')}`);
const embeddedApp = await appjs.text();
check('exe 内嵌了会话恢复和已完成段落增量渲染代码', embeddedApp.includes('/api/session?doc=') && /completedMarkdownEnd\(/.test(embeddedApp));
check('exe 内嵌了「读懂论文」与学习档案代码', embeddedApp.includes('读懂论文') && embeddedApp.includes('学习档案'));
check('搜索结果只嵌入链接入口（没有直接导入按钮）', embeddedApp.includes('打开链接') && !embeddedApp.includes('importPdf('));
const profileJs = await fetch(`${base}/js/profile.js`);
check('exe 内嵌了学习档案模块', profileJs.status === 200 && (await profileJs.text()).includes('buildProfileBlock'));
const teachingJs = await fetch(`${base}/js/teaching.js`);
check('exe 内嵌了四项教学能力提示词', teachingJs.status === 200 && (await teachingJs.text()).includes('先给我讲明白'));
// 学习档案接口（Rust 版必须和 Node 版一致，否则 exe 里个性化是坏的）
const profileGet = await fetch(`${base}/api/profile`);
const profileDefault = profileGet.ok ? await profileGet.json() : {};
check('exe 提供 GET /api/profile（默认空档案）', profileGet.ok && profileDefault.version === 1 && Array.isArray(profileDefault.items),
  `${profileGet.status}`);
const badProfile = await fetch(`${base}/api/profile`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ version: 1, items: [{ topic: '', status: 'confirmed' }] }),
});
check('exe 的 /api/profile 拒绝坏数据（400）', badProfile.status === 400, `${badProfile.status}`);
// 会话删除（Node 版补齐的那个动词，Rust 版一直有 —— 两边行为必须一致）
const delSession = await fetch(`${base}/api/session?doc=${encodeURIComponent('no-such-doc')}`, { method: 'DELETE' });
check('exe 提供 DELETE /api/session', delSession.ok, `${delSession.status}`);

console.log('\n▶ 截图附件单独存…');
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const attachDoc = 'desktop-attach-check';
let ah = 5381;
for (const c of attachDoc) ah = ((ah * 33) ^ c.charCodeAt(0)) >>> 0;
const attachKey = `${attachDoc.replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 48)}-${ah.toString(16)}`;
const attachDir = path.join(DATA, 'attachments', attachKey);
const postAttachment = (bytes, sid = '') => fetch(
  `${base}/api/attachment?doc=${encodeURIComponent(attachDoc)}${sid ? `&sid=${sid}` : ''}`,
  { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: bytes },
);
const up = await postAttachment(PNG_BYTES);
const upJson = up.ok ? await up.json() : {};
check('exe 提供 POST /api/attachment（原始图片字节 → 32 位 id）',
  up.ok && /^[0-9a-f]{32}$/.test(upJson.id || ''), `${up.status} ${upJson.id || ''}`);
check('图片单独落成文件（data/attachments/<会话键>/<id>.png）',
  !!upJson.id && fs.existsSync(path.join(attachDir, `${upJson.id}.png`)),
  fs.existsSync(attachDir) ? fs.readdirSync(attachDir).join(', ') : '(目录不存在)');
const got = await fetch(`${base}/api/attachment?doc=${encodeURIComponent(attachDoc)}&id=${upJson.id}`);
const gotBytes = Buffer.from(await got.arrayBuffer());
check('exe 提供 GET /api/attachment（字节与 Content-Type 一致）',
  got.ok && (got.headers.get('content-type') || '').includes('image/png')
  && Buffer.compare(gotBytes, PNG_BYTES) === 0,
  `${got.status} ${got.headers.get('content-type')} ${gotBytes.length}B`);
const badAttId = await fetch(`${base}/api/attachment?doc=${encodeURIComponent(attachDoc)}&id=${encodeURIComponent('../../server.js')}`);
check('非法附件 id 被拒（400）', badAttId.status === 400, `${badAttId.status}`);
const badAttType = await postAttachment(Buffer.from('not an image at all'));
check('非图片内容被拒（400）', badAttType.status === 400, `${badAttType.status}`);
const attachFiles = () => (fs.existsSync(attachDir) ? fs.readdirSync(attachDir) : []);
// 先传一张「孤儿图」，再用会话保存触发 GC：被引用的保留、没人引用的删掉
const orphan = await postAttachment(PNG_BYTES).then((r) => r.json());
await fetch(`${base}/api/session?doc=${encodeURIComponent(attachDoc)}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    entries: [{ block: 'chat', kind: 'user', text: '带图提问', screenshot: true, status: 'user', shots: [{ id: upJson.id, w: 1, h: 1, label: '截图' }] }],
    history: [], ops: [], updatedAt: Date.now(),
  }),
});
check('exe 会话保存后 GC：被引用的图保留', attachFiles().includes(`${upJson.id}.png`), attachFiles().join(', '));
check('exe 会话保存后 GC：没有引用的孤儿图被删掉',
  !!orphan.id && !attachFiles().includes(`${orphan.id}.png`), attachFiles().join(', '));
await fetch(`${base}/api/session?doc=${encodeURIComponent(attachDoc)}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ entries: [], history: [], ops: [], updatedAt: Date.now() }),
});
check('exe 清空会话后附件与空目录一起收掉', !fs.existsSync(attachDir));
await fetch(`${base}/api/session?doc=${encodeURIComponent(attachDoc)}`, { method: 'DELETE' });
check('exe 删除会话后整个附件目录一起删掉', !fs.existsSync(attachDir));
const aiJs = await fetch(`${base}/js/ai.js`).then((r) => r.text());
check('exe 内嵌了地区限制与密钥错误的区分提示', aiJs.includes('该模型在你所在地区不可用') && aiJs.includes('API Key 无效或已失效'));
const worker = await fetch(`${base}/vendor/pdf.worker.min.mjs`);
check('内嵌了 pdf.js worker', worker.status === 200 && (await worker.arrayBuffer()).byteLength > 100000,
  `${worker.status}`);

for (const [label, url] of [
  ['/../ 穿越', `${base}/%2e%2e/secret`],
  ['/../ 带扩展名穿越', `${base}/%2e%2e/server.js`],
  ['api/pdf 穿越', `${base}/api/pdf?name=${encodeURIComponent('../server.js')}`],
  ['api/pdf 绝对路径', `${base}/api/pdf?name=${encodeURIComponent('C:\\Windows\\win.ini')}`],
  ['js/ 多级回退穿越', `${base}/js/%2e%2e/%2e%2e/README.md`],
]) {
  const r = await fetch(url);
  const body = await r.text();
  // 允许 400/404，也允许无扩展名路径回落成首页外壳；但绝不允许泄露 public 之外的文件内容
  const leaked = /PAPERS_DIR|createServer|fn main|use wry|std::net/.test(body);
  const okFallback = r.status === 200 && body.includes('prt');
  check(`${label} 被挡住或只是回落首页`, !leaked && (r.status === 400 || r.status === 404 || okFallback),
    `${r.status} ${body.length}B${leaked ? ' ← 泄露!' : ''}`);
}

const txt = await fetch(`${base}/api/pdf?name=${encodeURIComponent('../server.js')}`).then((r) => r.text());
check('穿越没有泄露源码', !/PAPERS_DIR|createServer/.test(txt), txt.slice(0, 40));

/* ── 应用图标：极简「P」 ── */
const icon = await fetch(`${base}/icon.svg`);
const iconBody = await icon.text();
check('图标 /icon.svg 能取到且是 SVG',
  icon.status === 200 && (icon.headers.get('content-type') || '').includes('svg'),
  `${icon.status} ${icon.headers.get('content-type')} ${iconBody.length}B`);
check('图标是透明底的纯图形（无背景矩形、无文字）',
  !/<text/.test(iconBody) && !/width="100"[^>]*height="100"/.test(iconBody) && /viewBox="0 0 100 100"/.test(iconBody),
  iconBody.split('\n').filter((l) => l.includes('<rect')).join('').trim().slice(0, 60));

/* ── 参考文献检索（需要联网，走真实公开接口） ── */
console.log('\n▶ 参考文献检索…');
try {
  const q = encodeURIComponent('Ashish Vaswani, Noam Shazeer, Niki Parmar. Attention is all you need. NeurIPS 2017.');
  const r = await fetch(`${base}/api/ref-search?q=${q}`, { signal: AbortSignal.timeout(60000) });
  const j = await r.json();
  check('猜出了正确的标题', /attention is all you need/i.test(j.title || ''), j.title);
  check('返回了检索结果', Array.isArray(j.results) && j.results.length > 0, `${j.results?.length} 条`);
  const withPdf = (j.results || []).filter((x) => x.pdfUrl);
  check('结果里有可直接打开的 PDF 链接', withPdf.length > 0, withPdf[0]?.pdfUrl || '(无)');
  check('给了搜索引擎兜底链接', /^https?:/.test(j.searchUrl || '') && /^https?:/.test(j.scholarUrl || ''));
} catch (e) {
  check('参考文献检索可用（联网）', false, String(e.message).slice(0, 80));
}

/* ── 联网搜索（真实公开页面，不需要密钥） ── */
console.log('\n▶ 联网搜索…');
try {
  const sq = encodeURIComponent('attention is all you need transformer arxiv');
  const r = await fetch(`${base}/api/web-search?q=${sq}&n=6`, { signal: AbortSignal.timeout(60000) });
  const j = await r.json();
  check('联网搜索返回结果', Array.isArray(j.results) && j.results.length >= 2,
    `${j.provider || '(无引擎)'} ${j.results?.length || 0} 条`);
  check('结果都有标题和直链', (j.results || []).every((x) => x.title && /^https?:\/\//.test(x.url)),
    j.results?.[0]?.url);
  check('结果带摘要', (j.results || []).some((x) => (x.snippet || '').length > 20));
  check('标题里没有残留 HTML 标签或实体',
    !(j.results || []).some((x) => /[<>]|&(amp|lt|gt|quot|nbsp|#\d+);/.test(x.title)),
    (j.results || []).map((x) => x.title).find((t) => /[<>]|&/.test(t)) || '干净');

  const t0 = Date.now();
  const cached = await fetch(`${base}/api/web-search?q=${sq}&n=6`).then((x) => x.json());
  const ms = Date.now() - t0;
  check('同一查询第二次走缓存', ms < 300 && cached.results.length === j.results.length, `${ms}ms`);

  const cn = await fetch(`${base}/api/web-search?q=${encodeURIComponent('注意力机制 论文')}&n=6`,
    { signal: AbortSignal.timeout(60000) }).then((x) => x.json());
  check('中文查询也能搜到', (cn.results || []).length >= 2, `${cn.provider} ${cn.results?.length} 条`);

  const noq = await fetch(`${base}/api/web-search?q=`);
  check('缺少 q 返回 400', noq.status === 400, `${noq.status}`);

  // 相关性兜底：真事故是把整句中文问句丢给 Bing，它会退化成单字查询，
  // 返回一堆「这」字的字典释义。这种结果宁可丢掉，也不能当来源列给用户。
  const junkQ = '这篇论文的核心贡献是什么？另外帮我查一下 Transformer 架构最近有什么重要进展。';
  const junk = await fetch(`${base}/api/web-search?q=${encodeURIComponent(junkQ)}&n=6`,
    { signal: AbortSignal.timeout(60000) }).then((x) => x.json());
  const toks = new Set();
  for (const w of junkQ.toLowerCase().match(/[a-z][a-z0-9+#._-]*/g) || []) if (w.length >= 2) toks.add(w);
  for (const run of junkQ.toLowerCase().replace(/[^\u4e00-\u9fa5]+/g, ' ').split(/\s+/)) {
    for (let i = 0; i + 2 <= run.length; i++) toks.add(run.slice(i, i + 2));
  }
  const unrelated = (junk.results || []).filter((r) => {
    const hay = `${r.title} ${r.snippet || ''}`.toLowerCase();
    return ![...toks].some((t) => hay.includes(t));
  });
  check('整句口水问句不会拿回一堆不相关的结果',
    (junk.results || []).length === 0 || unrelated.length === 0,
    `${junk.results?.length || 0} 条，其中不相关 ${unrelated.length} 条 · ${unrelated[0]?.title || ''}`);
  check('丢弃时给出了人话解释', !junk.error || /丢|对不上|换/.test(junk.error), junk.error || '(没丢)');

  // 关键词查询要仍然好使（别为了过滤把正常结果也滤掉了）
  const kw = await fetch(`${base}/api/web-search?q=${encodeURIComponent('Transformer 架构 进展')}&n=6`,
    { signal: AbortSignal.timeout(60000) }).then((x) => x.json());
  check('关键词查询照常返回结果', (kw.results || []).length >= 2, `${kw.provider} ${kw.results?.length} 条`);
  check('关键词查询的结果确实提到 Transformer',
    (kw.results || []).every((r) => /transformer/i.test(`${r.title} ${r.snippet || ''}`)),
    (kw.results || []).map((r) => r.title).find((t) => !/transformer/i.test(t)) || '全部命中');
} catch (e) {
  check('联网搜索可用（联网）', false, String(e.message).slice(0, 80));
}

fs.writeFileSync(path.join(import.meta.dirname, '.desktop-port'), base);
console.log(`\n端口已写入 test/.desktop-port → ${base}`);
console.log(`可以接着跑： BASE=${base} node e2e.mjs`);
console.log(`测试副本 pid=${child.pid}（窗口不可见）；收尾： node test/desktop.mjs --stop`);

const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
