/** 用隔离服务跑 e2e（不碰用户书架/配置）：起临时 server.js → 跑 e2e.mjs → 收掉。
 *
 *   node test/e2e-isolated.mjs
 *
 * e2e 需要一个显式 BASE（它会拒绝默认去摸 8787，避免误测用户正在用的应用）。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';

fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'e2e-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data'));
const papers = path.join(scratch, 'papers');
fs.mkdirSync(data);
fs.mkdirSync(papers);
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), path.join(papers, 'attention-is-all-you-need.pdf'));
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'cn-sample.pdf'), path.join(papers, 'cn-sample.pdf'));

const probe = http.createServer();
await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const base = `http://127.0.0.1:${port}`;

const reader = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  windowsHide: true,
  stdio: 'ignore',
  env: {
    ...process.env, PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1',
  },
});
const watchdog = setTimeout(() => {
  console.error('e2e 隔离服务超时未就绪');
  try { reader.kill(); } catch { /* ignore */ }
  process.exit(3);
}, 180000);
watchdog.unref?.();

try {
  let ready = false;
  for (let i = 0; i < 100 && !ready; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* starting */ }
  }
  if (!ready) throw new Error('isolated reader did not start');
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'test', 'e2e.mjs')], {
      stdio: 'inherit',
      env: { ...process.env, BASE: base },
    });
    child.once('exit', (c) => resolve(c));
    child.once('error', () => resolve(1));
  });
  if (code !== 0) process.exitCode = code;
} finally {
  try { reader.kill(); } catch { /* ignore */ }
  clearTimeout(watchdog);
  // 清掉这次 e2e 留下的临时数据（只删本测试创建的 sandbox 子目录）
  try {
    if (path.basename(scratch).startsWith('e2e-')) fs.rmSync(scratch, { recursive: true, force: true });
  } catch { /* ignore */ }
}
