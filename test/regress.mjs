/**
 * 逐阶段回归跑批：把 test/ 下的套件按「隔离服务 + 假 Key」的 harness 规则串行跑一遍。
 *
 *   node test/regress.mjs                 // 默认：Node 单元 + 自带服务的套件 + 包装器
 *   node test/regress.mjs --ext           // 再加上需要外部 BASE 的旧套件（共用本脚本的隔离服务）
 *   node test/regress.mjs --only=qa,citation-quote
 *   node test/regress.mjs --skip=relations
 *
 * 硬约束（沿用 docs/archive/refactor-baseline-phase0.md §2）：
 *  - 只用 test/artifacts 下的隔离目录；绝不碰仓库 data/、papers/、用户正在用的应用；
 *  - 每个套件开跑前清空隔离 data/、复位隔离书架、重新 POST 一个假 Key；
 *  - 串行执行，不并行（旧套件共用同一个隔离服务时有顺序耦合）。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.join(import.meta.dirname, '..');
const SANDBOX = path.join(import.meta.dirname, 'artifacts');
const HARNESS = path.join(SANDBOX, `regress-${Date.now().toString(36)}`);
const DATA = path.join(HARNESS, 'data');
const PAPERS = path.join(HARNESS, 'papers');
const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const TIMEOUT = Number(process.env.SUITE_TIMEOUT || 300000);

const args = process.argv.slice(2);
const has = (name) => args.some((a) => a === `--${name}`);
const valueOf = (name) => (args.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1] || '';

/** 自带隔离服务的套件：只传 CHROME，不传 BASE（个别会尊重外部 BASE 的除外，见 HYBRID） */
const SELF = [
  'ai-send-regression', 'answer-note', 'attachments', 'citation-quote', 'context-page',
  'files-batch', 'folders', 'fullscreen', 'memory-session', 'mobile', 'profile', 'qa',
  'r6', 'right-select', 'save-reliability', 'scan-pdf', 'send-range', 'session-bar',
  'theme', 'translate-order', 'teaching-isolated', 'e2e-isolated', 'node-search',
];
/** 会读外部 BASE、但没设置时自己起服务的套件：用 harness 服务跑 */
const HYBRID = ['dnd'];
/** 纯 Node 单元（不需要服务） */
const NODE = ['memory-unit'];
/** 需要外部 BASE 的旧套件 */
const EXT = [
  'cjk', 'context', 'home', 'lab-leak', 'library', 'links', 'math', 'outline',
  'relations', 'selection', 'selection-stable', 'smoke', 'stream', 'ux', 'zoom', 'zoom-touch',
  'translate-pure',
];
/** 单独跑或不适合纳入回归 */
const EXCLUDED = {
  'real.mjs': '已禁用（真实接口）',
  'isolate.mjs': '探针，恒 exit 0',
  'pack.mjs': '打包器（单独验收）',
  'desktop.mjs': 'exe 验收（单独跑）',
  'refsearch.mjs': '联网探针，无断言',
  'proto-search.mjs': '联网探针，无断言',
  'e2e.mjs': '由 e2e-isolated 包装调用',
  'ops.mjs': '由 teaching-isolated 包装调用',
  'teaching.mjs': '由 teaching-isolated 包装调用',
  'regress.mjs': '本脚本',
};

const suites = [];
const add = (name, kind) => suites.push({ name, kind, file: path.join(import.meta.dirname, `${name}.mjs`) });
for (const n of NODE) add(n, 'node');
for (const n of SELF) add(n, 'self');
for (const n of HYBRID) add(n, 'hybrid');
if (has('ext')) for (const n of EXT) add(n, 'ext');
const only = valueOf('only').split(',').filter(Boolean);
const skip = new Set(valueOf('skip').split(',').filter(Boolean));
const picked = suites.filter((s) => (!only.length || only.includes(s.name)) && !skip.has(s.name));

/* ── 隔离目录 ── */
fs.rmSync(HARNESS, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(PAPERS, { recursive: true });
const resetPapers = () => {
  fs.rmSync(PAPERS, { recursive: true, force: true });
  fs.mkdirSync(PAPERS, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'multipage-sample.pdf'), path.join(PAPERS, 'fixture-multipage.pdf'));
  fs.copyFileSync(path.join(FIXTURES, 'cn-sample.pdf'), path.join(PAPERS, 'fixture-cn-sample.pdf'));
};
const resetData = () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = async () => {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
};

/* ── 共用隔离服务（只给 hybrid / ext 套件用） ── */
let server = null;
let BASE = null;
async function ensureServer() {
  if (server) return;
  resetData();
  resetPapers();
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env, PORT: String(port), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS,
      NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1',
    },
  });
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* starting */ }
  }
}
async function resetHarness() {
  resetData();
  resetPapers();
  await fetch(`${BASE}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: 'sk-regress-fake', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }),
  }).catch(() => {});
}

/* ── 跑一个套件 ── */
const SUMMARY = /(?:结果|通过|合计|总数|passed)[^\d]*(\d+)\s*\/\s*(\d+)/i;

function runSuite(s, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [s.file], {
      cwd: path.join(ROOT, 'test'),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let out = '';
    const cap = (d) => { out += d.toString('utf8'); if (out.length > 400000) out = out.slice(-200000); };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, TIMEOUT);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: String(e), ms: 0 }); });
    const t0 = Date.now();
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, ms: Date.now() - t0 }); });
  });
}

function parseFraction(out) {
  // 取最后出现的「N/M」作为分数（多数套件收尾打印一行汇总）
  let last = null;
  for (const m of out.matchAll(/(\d+)\s*\/\s*(\d+)/g)) last = m;
  if (!last) return null;
  return { pass: Number(last[1]), total: Number(last[2]) };
}

const results = [];
ensureServer && (await ensureServer());
resetPapers();
resetData();
console.log(`隔离 harness：${HARNESS}`);
console.log(`服务：${BASE || '(未起)'}`);
console.log(`套件：${picked.map((s) => s.name).join(', ')}\n`);

for (const s of picked) {
  if (s.kind === 'hybrid' || s.kind === 'ext') { await resetHarness(); }
  else if (s.kind === 'self') { resetPapers(); resetData(); }
  const env = {
    CHROME,
    QA_BACKEND: '',
    ...(s.kind === 'hybrid' || s.kind === 'ext' ? { BASE } : {}),
  };
  delete env.QA_BACKEND;
  process.stdout.write(`▶ ${s.name.padEnd(22)} `);
  const r = await runSuite(s, env);
  const frac = parseFraction(r.out);
  const ok = r.code === 0;
  console.log(`${ok ? 'OK  ' : 'FAIL'} exit=${r.code} ${frac ? `${frac.pass}/${frac.total}` : ''} ${(r.ms / 1000).toFixed(0)}s`);
  if (!ok) {
    const tail = r.out.split('\n').filter((l) => /❌|✗|FAIL|Error|Assertion|错误|失败/.test(l)).slice(-4);
    for (const line of tail) console.log(`    ${line.trim().slice(0, 180)}`);
  }
  results.push({ name: s.name, kind: s.kind, code: r.code, frac, ms: r.ms, out: r.out });
}

server?.kill();
const passed = results.filter((r) => r.code === 0).length;
const report = {
  at: new Date().toISOString(),
  harness: HARNESS,
  node: process.version,
  results: results.map(({ out, ...rest }) => rest),
};
fs.writeFileSync(path.join(HARNESS, 'regress.json'), JSON.stringify(report, null, 2));
console.log(`\n结果：${passed}/${results.length} 套件通过`);
console.log(`明细：${path.join(HARNESS, 'regress.json')}`);
for (const r of results) {
  if (r.code !== 0) console.log(`  FAIL ${r.name}${r.frac ? ` ${r.frac.pass}/${r.frac.total}` : ''}`);
}
process.exit(passed === results.length ? 0 : 1);
