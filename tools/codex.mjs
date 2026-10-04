/**
 * 从本工作区**非交互地调用 Codex CLI**，把它的最终回答拿回来。
 *
 *   node tools/codex.mjs "你的问题或任务"
 *   node tools/codex.mjs --model gpt-5.1-codex --cd C:\some\dir "任务"
 *   node tools/codex.mjs --full-auto "允许它改文件、跑命令"
 *   echo "从 stdin 传的长提示" | node tools/codex.mjs -
 *
 * 为什么要有这个脚本（而不是直接 `codex exec ...`）：
 *   ① **不能用管道**：受限沙箱下 Node 的 `spawn(..., {stdio:'pipe'})` 会 EPERM，
 *      所以这里把子进程的 stdout/stderr **落文件**，再读文件（和 test/*.mjs 同一套做法）。
 *   ② `codex exec --json` 吐的是 JSONL 事件流，最后一条消息在 `item.completed`
 *      且 `item.type === 'agent_message'` 里；直接看屏幕会淹没在一堆事件里。
 *   ③ 中文提示词走 PowerShell 命令行容易被编码层破坏 —— 用文件/stdin 传更稳。
 *
 * 退出码：Codex 成功=0；失败或超时=非 0，并把 stderr 尾部打出来。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const opts = { timeoutMs: 30 * 60 * 1000, fullAuto: false, cd: process.cwd(), model: '', json: true, profile: 'deepseek' };
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--full-auto') { opts.fullAuto = true; continue; }
  if (a === '--plain') { opts.json = false; continue; }
  if (a === '--model') { opts.model = argv[++i] || ''; continue; }
  if (a === '--profile') { opts.profile = argv[++i] || ''; continue; }
  if (a === '--no-profile') { opts.profile = ''; continue; }
  if (a === '--cd') { opts.cd = argv[++i] || process.cwd(); continue; }
  if (a === '--timeout') { opts.timeoutMs = (Number(argv[++i]) || 30) * 60 * 1000; continue; }
  if (a === '--codex') { opts.codexPath = argv[++i] || ''; continue; }
  rest.push(a);
}
let prompt = rest.join(' ').trim();
/**
 * ⚠️ 提示词一律**从文件读、用 stdin 传**，不走命令行位置参数。
 *
 * 实测（Windows + PowerShell）：`& codex exec ... "中文提示"` 时提示词会丢掉，
 * Codex 直接报 "Reading additional input from stdin..." 然后卡住 ——
 * PowerShell 的原生命令参数传递 + 中文编码在 `.bat`/`codex.exe` 这一层会散架。
 * 走 stdin 就完全绕开这个坑（也能传任意长的提示词）。
 */
const promptFile = process.argv.includes('--prompt-file')
  ? argv[argv.indexOf('--prompt-file') + 1]
  : '';
if (promptFile) prompt = fs.readFileSync(promptFile, 'utf8');
while (rest.includes('--prompt-file')) {
  const i = rest.indexOf('--prompt-file');
  rest.splice(i, 2);
}
prompt = rest.filter((x) => x !== '-').join(' ').trim() || prompt;
if (!prompt) { console.error('[x] 没有提示词：用法 node tools/codex.mjs "..." 或 --prompt-file <路径>'); process.exit(2); }

const codex = opts.codexPath || 'codex';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-'));
const outFile = path.join(tmp, 'out.jsonl');
const errFile = path.join(tmp, 'err.log');
const lastFile = path.join(tmp, 'last.txt');

const args = ['exec', '--skip-git-repo-check', '-C', opts.cd];
/**
 * ⚠️ `-p/--profile` 是**顶层参数**，要放在 `exec` 前面 —— 我第一版写成 `exec ... -p deepseek`
 * 直接被当成子命令解析，报 "系统找不到指定的文件 (os error 2)"。
 *
 * 默认用 `deepseek` profile：实测你这台机器上 `~/.codex/config.toml` 的默认模型是
 * `gpt-6.1-sol`，而 ChatGPT 套餐**不支持**它（400 invalid_request_error），
 * `gpt-5.1-codex` 同样不支持；只有 `-p deepseek`（走 api.deepseek.com）能正常跑通。
 */
if (opts.profile) args.unshift('-p', opts.profile);
if (opts.json) args.push('--json');
if (opts.model) args.push('-m', opts.model);
if (opts.fullAuto) args.push('--dangerously-bypass-approvals-and-sandbox');
args.push('-o', lastFile, '-');          // '-' = 提示词从 stdin 读（见上面的注释）

const outFd = fs.openSync(outFile, 'w');
const errFd = fs.openSync(errFile, 'w');
/* stdin 不能直接 'pipe'（受限沙箱下会 EPERM），也不能 'ignore'（那样 Codex 读不到提示词）。
   折中：把提示词写进一个临时文件，再把它的 fd 当 stdin 传进去。 */
const inFile = path.join(tmp, 'prompt.txt');
fs.writeFileSync(inFile, prompt, 'utf8');
const inFd = fs.openSync(inFile, 'r');
const child = spawn(codex, args, { stdio: [inFd, outFd, errFd], windowsHide: true });

const t0 = Date.now();
const timer = setTimeout(() => {
  try { child.kill(); } catch { /* 忽略 */ }
}, opts.timeoutMs);

child.on('exit', (code) => {
  clearTimeout(timer);
  const ms = Date.now() - t0;
  let last = '';
  try { last = fs.readFileSync(lastFile, 'utf8').trim(); } catch { /* 没有就没有 */ }

  /* JSONL 里再兜一层：拿最后一条 agent_message */
  if (!last && opts.json) {
    try {
      const lines = fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const ev = JSON.parse(lines[i]);
          const it = ev?.item || ev?.msg || ev;
          if (it?.type === 'agent_message' && it?.text) { last = String(it.text); break; }
          if (typeof it?.text === 'string' && it.text.trim()) { last = it.text; break; }
        } catch { /* 跳过坏行 */ }
      }
    } catch { /* 忽略 */ }
  }

  const err = (() => { try { return fs.readFileSync(errFile, 'utf8').trim(); } catch { return ''; } })();
  console.log(`\n──── codex 退出码 ${code} · 用时 ${(ms / 1000).toFixed(1)}s ────`);
  if (last) console.log(last);
  else console.log('（没有拿到最终消息）');
  if (err && code !== 0) console.log(`\n[stderr 尾部]\n${err.slice(-1200)}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  process.exit(code === 0 && last ? 0 : 1);
});

child.on('error', (e) => {
  clearTimeout(timer);
  console.error(`[x] 起不来 codex（${codex}）：${e && e.message}`);
  console.error('    若是 PATH 问题，用 --codex 指定完整路径，例如：');
  console.error('    --codex "%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin\\codex.exe"');
  process.exit(2);
});
