/**
 * 文件夹管理 API 冒烟测试（直接打 HTTP，不起浏览器）
 *   cd test && node folders.mjs          # 测 Node 版 server.js
 *   cd test && RUST_EXE=..\desktop\target\debug\prt.exe node folders.mjs   # 测 Rust 版
 * 用临时隔离目录（PRT_PAPERS_DIR / PRT_DATA_DIR），不碰真实 papers/ 与 data/。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures');
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failures++;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-folders-'));
const papersDir = path.join(tmp, 'papers');
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(papersDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

// 根下放两份不同 size 的同名 PDF（测 (2) 后缀）
fs.copyFileSync(path.join(FIX, 'multipage-sample.pdf'), path.join(papersDir, 'alpha.pdf'));
fs.copyFileSync(path.join(FIX, 'cn-sample.pdf'), path.join(papersDir, 'beta.pdf'));

const RUST_EXE = process.env.RUST_EXE;
const srv = RUST_EXE
  ? spawn(RUST_EXE, ['--port', String(PORT)], {
      env: { ...process.env, PRT_PAPERS_DIR: papersDir, PRT_DATA_DIR: dataDir, PRT_REQUIRE_TOKEN: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  : spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: { ...process.env, PRT_PAPERS_DIR: papersDir, PRT_DATA_DIR: dataDir, PORT: String(PORT), PRT_REQUIRE_TOKEN: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
let serverLog = '';
srv.stdout.on('data', (d) => (serverLog += d));
srv.stderr.on('data', (d) => (serverLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  return false;
}
let token = '';
async function api(method, p, body) {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch { /* non-json */ }
  return { status: r.status, j };
}

try {
  if (!(await waitReady())) throw new Error('服务起不来：\n' + serverLog);

  console.log('· 初始列表');
  let r = await api('GET', '/api/papers');
  check('GET /api/papers 200', r.status === 200);
  check('初始 2 个根 PDF', (r.j?.papers || []).length === 2);
  check('初始 folders 空数组', Array.isArray(r.j?.folders) && r.j.folders.length === 0);
  check('papers 项带 folder/path', r.j.papers.every((p) => 'folder' in p && 'path' in p && p.path === p.name));

  console.log('· 新建文件夹');
  r = await api('POST', '/api/folders?name=AI');
  check('新建 AI → 200', r.status === 200 && r.j?.path === 'AI');
  r = await api('POST', '/api/folders?name=AI');
  check('重名 AI → AI (2)', r.status === 200 && r.j?.path === 'AI (2)');
  r = await api('POST', '/api/folders?name=a%2Fb');
  check('非法字符清洗 a/b → a_b', r.status === 200 && r.j?.path === 'a_b');
  r = await api('POST', '/api/folders?name=..%2Fevil');
  check('拒绝 .. 注入', r.status !== 200 || r.j?.path !== '../evil');
  r = await api('POST', '/api/folders?name=ML');
  check('准备 ML 供子夹用例', r.status === 200);
  r = await api('POST', '/api/folders?name=sub&parent=ML');
  check('ML 下新建子夹 sub → ML/sub', r.status === 200 && r.j?.path === 'ML/sub');
  r = await api('POST', '/api/folders?name=sub&parent=ML');
  check('子夹重名 → ML/sub (2)', r.status === 200 && r.j?.path === 'ML/sub (2)');
  r = await api('POST', '/api/folders?name=x&parent=not-exist');
  check('父夹不存在 → 404', r.status === 404);

  console.log('· 重命名文件夹');
  r = await api('PATCH', '/api/folders', { from: 'AI', to: 'DL' });
  check('AI → DL', r.status === 200 && r.j?.to === 'DL');
  r = await api('PATCH', '/api/folders', { from: 'AI', to: 'X' });
  check('重命名不存在的夹 → 404', r.status === 404);

  console.log('· 移动 PDF（移入夹 / 移出到根）');
  r = await api('POST', '/api/move', { from: 'beta.pdf', to: 'ML' });
  check('beta.pdf 移入 ML → ML/beta.pdf', r.status === 200 && r.j?.to === 'ML/beta.pdf');
  r = await api('GET', '/api/papers');
  const ml = (r.j?.folders || []).find((f) => f.path === 'ML');
  check('ML.count = 1', ml && ml.count === 1);
  check('papers 含 ML/beta.pdf', (r.j?.papers || []).some((p) => p.path === 'ML/beta.pdf' && p.folder === 'ML'));
  r = await api('POST', '/api/move', { from: 'ML/beta.pdf', to: '' });
  check('ML/beta.pdf 移出到根 → beta.pdf', r.status === 200 && r.j?.to === 'beta.pdf');

  console.log('· 同名冲突');
  r = await api('POST', '/api/move', { from: 'alpha.pdf', to: 'ML' });
  check('alpha.pdf 移入 ML', r.status === 200 && r.j?.to === 'ML/alpha.pdf');
  // 根下再造一个同名不同 size 的 alpha.pdf，再移入 → alpha (2).pdf
  fs.copyFileSync(path.join(FIX, 'cn-sample.pdf'), path.join(papersDir, 'alpha.pdf'));
  r = await api('POST', '/api/move', { from: 'alpha.pdf', to: 'ML' });
  check('同名不同内容 → ML/alpha (2).pdf', r.status === 200 && r.j?.to === 'ML/alpha (2).pdf');
  // 同 size 去重：根下恢复一份与 ML/alpha.pdf 完全相同的 multipage，再移入 → 直接删源去重
  fs.copyFileSync(path.join(FIX, 'multipage-sample.pdf'), path.join(papersDir, 'alpha.pdf'));
  r = await api('POST', '/api/move', { from: 'alpha.pdf', to: 'ML' });
  check('同名同 size → 去重不新增', r.status === 200 && r.j?.to === 'ML/alpha.pdf');
  check('去重后根下 alpha.pdf 已删', !fs.existsSync(path.join(papersDir, 'alpha.pdf')));
  r = await api('GET', '/api/papers');
  const mlPdfs = (r.j?.papers || []).filter((p) => p.folder === 'ML').map((p) => p.path);
  check('ML 里只有 2 个 PDF', mlPdfs.length === 2 && mlPdfs.includes('ML/alpha.pdf') && mlPdfs.includes('ML/alpha (2).pdf'));

  console.log('· PDF 读取 path/name');
  r = await api('GET', '/api/pdf?path=ML/alpha.pdf');
  check('?path=ML/alpha.pdf → 200', r.status === 200 && r.j === null);
  r = await api('GET', '/api/pdf?name=alpha.pdf');
  check('?name=alpha.pdf 回退命中 → 200', r.status === 200);
  r = await api('GET', '/api/pdf?path=ML/不存在.pdf');
  check('?path=不存在 → 404', r.status === 404);

  console.log('· 文件夹移动与循环禁区');
  await api('POST', '/api/folders?name=N1');
  await api('POST', '/api/folders?name=N2');
  r = await api('POST', '/api/move', { from: 'N2', to: 'N1' });
  check('N2 移入 N1 → N1/N2', r.status === 200 && r.j?.to === 'N1/N2');
  r = await api('POST', '/api/move', { from: 'N1', to: 'N1/N2' });
  check('N1 移入自己子孙 → 400', r.status === 400);
  r = await api('POST', '/api/move', { from: 'N1', to: 'N1' });
  check('N1 移入自己 → 400', r.status === 400);

  console.log('· 移到自身目录（no-op，绝不能去重删源）');
  r = await api('POST', '/api/move', { from: 'ML/alpha.pdf', to: 'ML' });
  check('alpha.pdf 移回 ML → 200 且 moved=false', r.status === 200 && r.j?.moved === false);
  check('ML/alpha.pdf 仍在', fs.existsSync(path.join(papersDir, 'ML', 'alpha.pdf')));
  r = await api('POST', '/api/move', { from: 'beta.pdf', to: '' });
  check('根文件移到根 → 200 且 moved=false', r.status === 200 && r.j?.moved === false);
  check('beta.pdf 仍在根', fs.existsSync(path.join(papersDir, 'beta.pdf')));

  console.log('· 顺序（相对路径 order）');
  r = await api('POST', '/api/papers', { order: ['alpha.pdf', 'ML/alpha (2).pdf', 'N1/N2'] });
  check('POST 相对路径 order → 200', r.status === 200);
  r = await api('POST', '/api/papers', { order: ['../escape.pdf', 'alpha.pdf'] });
  check('.. 顺序项被过滤（整体仍 200）', r.status === 200);
  const savedOrder = JSON.parse(fs.readFileSync(path.join(dataDir, 'papers-order.json'), 'utf8'));
  check('order 不含 .. 项', Array.isArray(savedOrder.order) && !savedOrder.order.includes('../escape.pdf') && savedOrder.order.includes('alpha.pdf'));
  r = await api('GET', '/api/papers');
  check('order 落盘生效', (r.j?.papers || []).length >= 1);

  console.log('· 删除文件夹');
  r = await api('DELETE', '/api/folders?path=ML&mode=to-root');
  check('ML to-root → 200 且 PDF 移出', r.status === 200 && r.j?.moved === 2);
  r = await api('GET', '/api/papers');
  check('ML 已删', !(r.j?.folders || []).some((f) => f.path === 'ML'));
  check('ML 的 PDF 回到根', (r.j?.papers || []).some((p) => p.path === 'alpha.pdf'));
  r = await api('DELETE', '/api/folders?path=N1&mode=recursive');
  check('N1 recursive → 200', r.status === 200);
  r = await api('DELETE', '/api/folders?path=no-such&mode=recursive');
  check('删不存在的夹 → 404', r.status === 404);

  console.log('\n结果:', failures === 0 ? '全部通过 ✅' : `${failures} 个失败 ❌`);
} catch (e) {
  failures++;
  console.error('测试执行异常：', e && e.message);
  console.error(serverLog.slice(-2000));
} finally {
  srv.kill();
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录清理失败可忽略 */ }
  process.exit(failures ? 1 : 0);
}
