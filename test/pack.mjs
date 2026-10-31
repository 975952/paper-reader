import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const ROOT = path.join(import.meta.dirname, '..');
const STAGE = path.join(import.meta.dirname, 'artifacts', 'pkg');
const STAGE_ROOT = path.join(import.meta.dirname, 'artifacts');
const ZIP = path.join(import.meta.dirname, 'artifacts', 'paper-reader-src.zip');

/** 要发布的顶层文件 / 目录（相对 ROOT） */
const INCLUDE = [
  'server.js',
  'security.js',
  'model-profiles.js',
  'start.bat',
  '启动.bat',
  'README.md',
  'AGENTS.md',
  '.gitignore',
  'public',
  'desktop/src',
  'desktop/Cargo.toml',
  'desktop/Cargo.lock',
  'desktop/build.bat',
  'desktop/build.rs',
  'desktop/tools',
  'docs',
  'test',
];

/** 兜底：就算误入白名单，这些也绝不进包 */
const DENY = [
  /(^|[\\/])data([\\/]|$)/,
  /(^|[\\/])papers([\\/]|$)/,
  /node_modules/,
  /[\\/]target[\\/]/,
  /[\\/]artifacts[\\/]/,
  /\.exe$/i,
  /\.pdf$/i,        // 例外只有下面 isFixturePdf() 放行的合成夹具
  /\.log$/i,
  /webview2/,
  /\.desktop-port$/,
  /(^|[\\/])internal([\\/]|$)/,
  /(^|[\\/])archive([\\/]|$)/,
  /(^|[\\/])profile-[^\\/]*([\\/]|$)/,
  /(^|[\\/])dump([\\/]|$)/,
];

const isFixturePdf = (rel) => /^test[\\/]fixtures[\\/][^\\/]+\.pdf$/i.test(rel);

const walk = (abs, rel, out) => {
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(abs)) walk(path.join(abs, e), path.join(rel, e), out);
    return;
  }
  if (DENY.some((re) => re.test(rel)) && !isFixturePdf(rel)) return;
  out.push({ abs, rel });
};

/* ── 1. 收集 ── */
const files = [];
for (const item of INCLUDE) {
  const abs = path.join(ROOT, item);
  if (!fs.existsSync(abs)) { console.log(`  [skip] 不存在：${item}`); continue; }
  walk(abs, item, files);
}

/* ── 2. 安全检查：包里绝不能出现密钥 / 论文 ── */
const dangerous = files.filter((f) => /(^|[\\/])data([\\/]|$)|(^|[\\/])papers([\\/]|$)|\.exe$/i.test(f.rel)
  || (/\.pdf$/i.test(f.rel) && !isFixturePdf(f.rel)));
if (dangerous.length) {
  console.error('拒绝打包：白名单里混进了敏感文件');
  for (const d of dangerous) console.error('  ' + d.rel);
  process.exit(1);
}
// 反向自检：敏感目录一个都不许出现在清单里（正常情况 DENY 已经拦掉了，这里是第二道）
const forbidden = files.filter((f) => /(^|[\\/])(data|papers|node_modules|artifacts)([\\/]|$)/i.test(f.rel)
  || /[\\/]target[\\/]/i.test(f.rel));
if (forbidden.length) {
  console.error('拒绝打包：清单里出现了 data/ papers/ artifacts/ node_modules/ target/');
  for (const f of forbidden) console.error('  ' + f.rel);
  process.exit(1);
}
const leaked = [];
for (const f of files) {
  if (!/\.(js|mjs|json|html|css|md|rs|toml|bat|txt)$/i.test(f.rel)) continue;
  const txt = fs.readFileSync(f.abs, 'utf8');
  // 真实 API Key 长这样：sk- 后面 30+ 位
  if (/sk-[A-Za-z0-9]{20,}/.test(txt)) leaked.push(f.rel);
}
if (leaked.length) {
  console.error('拒绝打包：这些文件里出现了疑似真实 API Key');
  for (const l of leaked) console.error('  ' + l);
  process.exit(1);
}

/* ── 3. 落到临时目录 ── */
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
let bytes = 0;
for (const f of files) {
  const dst = path.join(STAGE, f.rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(f.abs, dst);
  bytes += fs.statSync(dst).size;
}

/* ── 4. 打 zip ── */
fs.rmSync(ZIP, { force: true });
let zipTool = 'tar';
try {
  execFileSync('tar', ['-a', '-c', '-f', ZIP, '-C', STAGE, '.'], { stdio: 'inherit' });
} catch (e) {
  zipTool = 'Compress-Archive（不跨平台：条目名是反斜杠）';
  execFileSync('powershell', [
    '-NoProfile', '-Command',
    `Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${ZIP}' -CompressionLevel Optimal -Force`,
  ], { stdio: 'inherit' });
}
fs.rmSync(STAGE, { recursive: true, force: true });

const VERIFY = path.join(STAGE_ROOT, 'pkg-verify');
let verifyNote = '';
try {
  fs.rmSync(VERIFY, { recursive: true, force: true });
  fs.mkdirSync(VERIFY, { recursive: true });
  execFileSync('tar', ['-x', '-f', ZIP, '-C', VERIFY], { stdio: 'ignore' });
  const dataDir = path.join(VERIFY, '__data__');
  const papersDir = path.join(VERIFY, 'test', 'fixtures');
  fs.mkdirSync(dataDir, { recursive: true });
  const port = 8999;
  const child = spawn(process.execPath, [path.join(VERIFY, 'server.js')], {
    stdio: 'ignore',
    env: { ...process.env, PORT: String(port), PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir, NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0' },
  });
  let health = null;
  for (let i = 0; i < 40 && !health; i++) {
    await new Promise((r) => setTimeout(r, 250));
    health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }
  const papers = health ? await fetch(`http://127.0.0.1:${port}/api/papers`).then((r) => r.json()).catch(() => null) : null;
  child.kill();
  if (!health?.ok) throw new Error('解包后的服务没起来');
  if (!(papers?.papers || []).length) throw new Error('解包后的服务读不到夹具 PDF');
  verifyNote = `通过（起得来、/api/health ok、读到 ${papers.papers.length} 个夹具 PDF）`;
} catch (e) {
  verifyNote = `**失败**：${e.message}`;
  console.error('\n拒绝交付：源码包解开后跑不起来 —— 白名单很可能漏了 server.js 依赖的模块');
  console.error('  ' + e.message);
  fs.rmSync(VERIFY, { recursive: true, force: true });
  process.exit(1);
} finally {
  fs.rmSync(VERIFY, { recursive: true, force: true });
}

const zipSize = fs.statSync(ZIP).size;
console.log(`\n文件数：${files.length}`);
console.log(`原始大小：${(bytes / 1048576).toFixed(1)} MB`);
console.log(`压缩后：${(zipSize / 1048576).toFixed(1)} MB`);
console.log(`打包器：${zipTool}`);
console.log(`输出：${ZIP}`);
console.log(`解包自检：${verifyNote}`);
console.log('\n前 20 个文件：');
for (const f of files.slice(0, 20)) console.log('  ' + f.rel);
// 夹具 PDF 单独列出来：它们进了包，e2e / ux / cjk 这些套件才跑得起来，值得一眼核对
const fixturePdfs = files.filter((f) => isFixturePdf(f.rel)).map((f) => f.rel).sort();
console.log(`\n合成 PDF 夹具（${fixturePdfs.length} 个）：`);
for (const f of fixturePdfs) console.log('  ' + f);
console.log(`敏感路径自检：${forbidden.length === 0 ? '通过（清单里没有 data/ / papers/ / artifacts/ / node_modules/ / target/）' : '失败'}`);
