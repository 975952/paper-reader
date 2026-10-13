/**
 * 参考文献标题猜测 / 检索相关性（2026-10 用户报的 bug 的回归套件）
 *   cd test && node refsearch.mjs       （或：node test/refsearch.mjs）
 *
 * 事故现场：`V. Sindhwani, T. Sainath, and S. Kumar. Structured transforms for
 * small-footprint deep learning. …` 被猜成标题 **`V`**，于是拿单个字母 V 去 arXiv
 * 检索，返回「$V$-rings versus $Σ$-$V$ Rings」「On a conjecture of V. V. Shchigolev」
 * 这类毫不相干的论文 —— 用户看到的就是「我都不知道这个查找是怎么在找」。
 *
 * 这里只起一个**隔离**的 Node 服务（PRT_DATA_DIR / PRT_PAPERS_DIR 指向 test/artifacts），
 * 不碰用户的书架与 data/。标题猜测是纯函数，不需要联网；只有「真去搜一次」那两条
 * 需要外网，拿不到外网时按 SKIP 处理（不假装通过）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const SANDBOX = path.join(import.meta.dirname, 'artifacts', 'refsearch-isolated');

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '  ✅' : '  ❌'} ${n}${d ? `  — ${d}` : ''}`); };
const note = (t) => console.log(`  ⏭  ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 起服务（端口让系统给一个空闲的） ── */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, 'papers'), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, 'data'), { recursive: true });

const PORT = await freePort();
/**
 * stdio 用 'ignore'，不起管道：一是与 test/desktop.mjs 的起法一致，
 * 二是某些受限环境里 spawn 一个走管道 stdio 的子进程会直接 EPERM。
 */
const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    PRT_DATA_DIR: path.join(SANDBOX, 'data'),
    PRT_PAPERS_DIR: path.join(SANDBOX, 'papers'),
    PRT_REQUIRE_TOKEN: '0',        // 本套件不模拟浏览器，只打接口
    PRT_QUIET_TOKEN: '1',
  },
  stdio: 'ignore',
});
process.on('exit', () => { try { child.kill(); } catch { /* 已经没了 */ } });

const BASE = `http://127.0.0.1:${PORT}`;
let up = false;
for (let i = 0; i < 100 && !up; i++) {
  try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await sleep(100); }
}
if (!up) {
  console.error(`服务起不来（PORT=${PORT}）`);
  child.kill();
  process.exit(2);
}

const refSearch = async (q) => {
  const r = await fetch(`${BASE}/api/ref-search?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(90000) });
  return { status: r.status, json: await r.json().catch(() => null) };
};

try {
  /* ═══════════ 一、标题猜测（纯函数，不依赖外网） ═══════════ */
  console.log('\n▶ 标题猜测');
  const CASES = [
    ['用户报的那条（bug 现场）',
      'V. Sindhwani, T. Sainath, and S. Kumar. Structured transforms for small-footprint deep learning. In Advances in Neural Information Processing Systems, pages 3088–3096, 2015.',
      'Structured transforms for small-footprint deep learning'],
    ['带方括号编号 + 缩写',
      '[1] V. Sindhwani, T. Sainath, and S. Kumar. Structured transforms for small-footprint deep learning. In Advances in Neural Information Processing Systems, pages 3088-3096, 2015.',
      'Structured transforms for small-footprint deep learning'],
    ['老测试用例（多个作者）',
      'Ashish Vaswani, Noam Shazeer, Niki Parmar. Attention is all you need. NeurIPS 2017.',
      'Attention is all you need'],
    ['缩写姓名全带点',
      'K. He, X. Zhang, S. Ren, and J. Sun. Deep residual learning for image recognition. CVPR 2016.',
      'Deep residual learning for image recognition'],
    ['姓在前 + et al',
      'Vaswani, A., Shazeer, N., Parmar, N., et al. Attention is all you need. In NIPS, 2017.',
      'Attention is all you need'],
    ['姓, 名首字母（点号在作者段末）',
      'Hochreiter, S. and Schmidhuber, J. Long short-term memory. Neural computation, 9(8):1735-1780, 1997.',
      'Long short-term memory'],
    ['单个作者带缩写',
      'J. Smith. A survey of neural machine translation. ACM Computing Surveys, 2020.',
      'A survey of neural machine translation'],
    ['没有作者，只有标题',
      'Structured transforms for small-footprint deep learning. NeurIPS 2015.',
      'Structured transforms for small-footprint deep learning'],
    ['中文文献（GB/T 7714）',
      '张三, 李四. 基于深度学习的图像识别综述. 计算机学报, 2020, 43(5): 1-20.',
      '基于深度学习的图像识别综述'],
  ];
  for (const [label, ref, want] of CASES) {
    const { json } = await refSearch(ref);
    const got = json?.title || '';
    check(label, got === want, got === want ? `「${got}」` : `得到「${got}」，期望「${want}」`);
  }

  // 单字母 / 碎片不许拿去检索：标题不可信时必须 titleGuessed=false（前端据此提示）
  for (const [label, ref] of [['单字母碎片', 'V. Q.'], ['只有一个缩写', 'V.']]) {
    const { json } = await refSearch(ref);
    check(`${label} → 不拿它当标题去搜`, json?.titleGuessed === false, `titleGuessed=${json?.titleGuessed} title=「${json?.title}」`);
  }

  const empty = await refSearch('');
  check('缺少 q 返回 400', empty.status === 400, `${empty.status}`);

  /* ═══════════ 二、真去搜一次（需要外网） ═══════════ */
  console.log('\n▶ 检索相关性（联网）');
  const bug = 'V. Sindhwani, T. Sainath, and S. Kumar. Structured transforms for small-footprint deep learning. In Advances in Neural Information Processing Systems, pages 3088–3096, 2015.';
  const { json: hit } = await refSearch(bug);
  if (!hit || !(hit.results || []).length) {
    note('这次没拿到任何检索结果（外网不可用？）—— 标题猜测那几条已经过了，这条不假装通过');
  } else {
    const top = hit.results[0];
    check('第一名就是这篇本身（不是 V-rings 那类无关论文）',
      /structured\s+transforms/i.test(top.title || ''), `[${top.source}] ${top.title}`);
    check('第一名带 PDF 直链', !!top.pdfUrl, top.pdfUrl || '(无)');
    check('同行里再没有「标题只有一个 V」的结果',
      !(hit.results || []).some((r) => /^\$?V\$?-rings|Shchigolev|ChatGPT v Bard/i.test(r.title || '')),
      (hit.results || []).map((r) => r.title).join(' | ').slice(0, 120));
    check('无关结果被丢掉并回报 dropped', hit.dropped >= 0, `dropped=${hit.dropped}`);
  }
} finally {
  child.kill();
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? '❌' : '✅'} ${results.length - bad.length}/${results.length} 通过`);
process.exit(bad.length ? 1 : 0);
