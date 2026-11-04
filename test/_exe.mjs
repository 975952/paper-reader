/**
 * 交付 exe 的验收 helper。
 *
 * 硬规矩：验收**绝不**启动或关闭用户正在用的那个 exe。
 *  - stageExe()：把仓库根的交付物复制到 test/artifacts 下的独立目录，之后只启动这个副本；
 *  - spawnReader()：副本 + `--background`（不显示窗口、不抢焦点、不占任务栏）；
 *  - stopChild()：只结束自己启动的子进程（taskkill /PID /T /F）；
 *  - killSandboxInstances()：只清理 test/artifacts 里遗留的副本进程（用户的实例在 Desktop/papers
 *    目录之外，绝不会被它命中）。
 *
 * 用户正在用的应用（例如桌面上的 `prt.exe`）与测试互不影响：
 * 它继续占着自己的 8787 端口，测试副本会自动往后找空闲端口。
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, SANDBOX } from './_env.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 交付物路径（可用 EXE=… 覆盖，方便测 target/release 里的构建产物） */
export function deliverableExe() {
  return process.env.EXE || path.join(ROOT, 'prt.exe');
}

/**
 * 把交付物复制到 sandbox 下的独立目录。
 * @returns {{exe:string, dir:string}}
 */
export function stageExe(tag = 'reader') {
  const src = deliverableExe();
  if (!fs.existsSync(src)) throw new Error(`找不到交付 exe：${src}（先跑 desktop\\build.bat）`);
  fs.mkdirSync(SANDBOX, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SANDBOX, `exe-${tag}-`));
  const exe = path.join(dir, 'reader.exe');
  fs.copyFileSync(src, exe);
  return { exe, dir };
}

/** 启动一份沙箱副本：窗口不显示、不抢焦点，独立端口/数据目录由调用方的 env 决定 */
export function spawnReader(exe, { args = [], env = {} } = {}) {
  return spawn(exe, ['--background', ...args], {
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, PRT_BACKGROUND: '1', ...env },
  });
}

/** 只结束本测试自己启动的子进程 */
export async function stopChild(child, timeoutMs = 8000) {
  if (!child || child.exitCode !== null || !child.pid) return;
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已经退了 */ }
  const start = Date.now();
  while (child.exitCode === null && Date.now() - start < timeoutMs) await sleep(100);
}

/**
 * 清理 test/artifacts 目录下遗留的副本进程（只动沙箱里的可执行文件）。
 * 用户正在用的 exe 不在这个前缀下，因此永远不会被命中。
 */
export function killSandboxInstances() {
  if (process.platform !== 'win32') return;
  const ps = [
    '$root = $env:PRT_SANDBOX;',
    '$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) };',
    'foreach ($p in $procs) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch { } }',
  ].join(' ');
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', ps], {
      stdio: 'ignore',
      env: { ...process.env, PRT_SANDBOX: SANDBOX },
    });
  } catch { /* 尽力而为 */ }
}

/**
 * 等待某个端口区间里出现「本次测试自己的」服务：用 papers 目录是否等于隔离目录来识别。
 * @returns {Promise<string|null>} 形如 http://127.0.0.1:8788
 */
export async function waitForBase({ ports, papersDir, timeoutMs = 20000 }) {
  const want = path.resolve(papersDir);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const port of ports) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/papers`, { signal: AbortSignal.timeout(300) });
        if (!r.ok) continue;
        const listing = await r.json();
        if (path.resolve(listing.dir || '') === want) return `http://127.0.0.1:${port}`;
      } catch { /* 还没起来 */ }
    }
    await sleep(150);
  }
  return null;
}

/** 8760..8860 的端口区间：测试副本从 8787 起往后找空闲端口，用户的 8787 不会被抢 */
export const READER_PORTS = Array.from({ length: 100 }, (_, i) => 8760 + i);
