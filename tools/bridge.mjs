/**
 * 双向桥：让 Codex 与我（DSH 里的智能体）能互相派活。
 *
 * 背景（为什么需要这个文件）：
 *   DSH 是 Electron GUI 应用（`DeepSeek Harness.exe`），**没有 headless / CLI 入口**；
 *   而我是跑在 DSH 会话里的智能体，只在「用户发消息 / 会话被恢复」时执行。
 *   所以 Codex 无法直接 RPC 调用我 —— 中间必须有个**双方都能碰到的信箱**。
 *
 * 用法一（Codex → 我）：Codex 把任务投进信箱，我下一次运行时取出来执行
 *   node tools/bridge.mjs serve                  # 起信箱（HTTP，默认 127.0.0.1:8899）
 *   # Codex 侧（或任何脚本）：
 *   curl -X POST http://127.0.0.1:8899/task -d '{"prompt":"帮我把 X 修了"}'
 *   # 我侧取任务：
 *   node tools/bridge.mjs fetch                  # 取出并清空（打印 JSON）
 *   node tools/bridge.mjs reply <id> "结果文本"   # 回写结果（Codex 可 GET /result/<id> 取）
 *
 * 用法二（我 → Codex）：直接问 Codex，把它的最终回答拿回来
 *   node tools/bridge.mjs ask "帮我看一下这段 CSS 有没有问题"
 *   node tools/bridge.mjs ask --model gpt-5.2-codex --full-auto "顺手修掉"
 *
 * 用法三（不启服务，纯文件信箱）：双方都直接读写 JSONL，最省事也最不容易坏
 *   node tools/bridge.mjs post "任务"            # 追加到信箱队列
 *   node tools/bridge.mjs fetch                  # 取出并清空
 *   node tools/bridge.mjs status                 # 看队列里还有几条
 *
 * 注意：默认全部走 127.0.0.1，不监听 0.0.0.0；不做鉴权，**只在本机用**。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
/* 信箱 / 回执的路径可被环境变量覆盖：测试用临时信箱跑回归，绝不动正在用的那一份。
   （路径写死会让「验证 fetch 的行为」变成「拿真实信箱做实验」，风险不值得。） */
const MAILBOX = process.env.BRIDGE_MAILBOX
  ? path.resolve(process.env.BRIDGE_MAILBOX)
  : path.join(ROOT, 'test', 'artifacts', 'bridge', 'mailbox.jsonl');
const RESULTS = process.env.BRIDGE_RESULTS
  ? path.resolve(process.env.BRIDGE_RESULTS)
  : path.join(ROOT, 'test', 'artifacts', 'bridge', 'results.jsonl');
const PORT = Number(process.env.BRIDGE_PORT || 8899);
const CODEX = process.env.CODEX_BIN
  || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';

const ensureDir = () => fs.mkdirSync(path.dirname(MAILBOX), { recursive: true });
/**
 * 读 JSONL。**一行坏掉不能让整箱任务消失。**
 *
 * 踩过的坑（2026-10-04 实测）：用 PowerShell 的 `Set-Content -Encoding utf8`（或任何带 BOM 的
 * 编辑器）碰过信箱后，文件头多出 U+FEFF，`JSON.parse` 第一行就抛错。旧写法是
 * `try { …map(JSON.parse) } catch { return [] }` —— 一个 catch 把**整个文件**判成空，
 * 于是 `fetch` 打印 `[]`、`status` 报 `pending:0`，而任务其实正躺在信箱里没人取：
 * 这正是「Codex 投了任务但我收不到」最隐蔽的一种坏法。
 *
 * 现在：剥掉 BOM、逐行解析、坏行跳过并**在 stderr 上报**（不静默）。半截行（多进程同时
 * append 时可能出现）也被安全跳过，不再连累后面的好行。
 */
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const readLines = (f) => {
  let text = '';
  try { text = stripBom(fs.readFileSync(f, 'utf8')); } catch { return []; }
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try { out.push(JSON.parse(line)); }
    catch { console.error(`[bridge] 跳过一行无法解析的内容（${line.slice(0, 60)}…）`); }
  }
  return out;
};
const append = (f, obj) => { ensureDir(); fs.appendFileSync(f, JSON.stringify(obj) + '\n', 'utf8'); };

/* ───────────────── 我 → Codex：非交互调用，拿最终回答 ───────────────── */
function askCodex(prompt, { model = '', fullAuto = false, timeoutMs = 20 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-codex-'));
    const outFile = path.join(tmp, 'out.jsonl');
    const errFile = path.join(tmp, 'err.log');
    const lastFile = path.join(tmp, 'last.txt');
    const inFile = path.join(tmp, 'prompt.txt');
    fs.writeFileSync(inFile, prompt, 'utf8');            // ⚠️ 提示词走 stdin，不走命令行参数（中文会被 PowerShell 弄丢）
    const args = ['exec', '--skip-git-repo-check', '--json', '-C', ROOT, '-o', lastFile, '-'];
    if (model) args.push('-m', model);
    if (fullAuto) args.push('--dangerously-bypass-approvals-and-sandbox');
    const outFd = fs.openSync(outFile, 'w');
    const errFd = fs.openSync(errFile, 'w');
    const inFd = fs.openSync(inFile, 'r');
    const child = spawn(CODEX, args, { stdio: [inFd, outFd, errFd], windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 忽略 */ } }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: `起不来 codex：${e && e.message}` }); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      let last = '';
      try { last = fs.readFileSync(lastFile, 'utf8').trim(); } catch { /* 没有 */ }
      if (!last) {
        for (const line of readLines(outFile).reverse()) {
          const it = line?.item || line;
          if (it?.type === 'agent_message' && it?.text) { last = String(it.text); break; }
          if (it?.type === 'error' && it?.message) { last = `(codex 报错) ${it.message}`; break; }
        }
      }
      let err = '';
      try { err = fs.readFileSync(errFile, 'utf8').trim(); } catch { /* 忽略 */ }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
      resolve({ ok: code === 0 && !!last, code, answer: last, stderr: err.slice(-800) });
    });
  });
}

/* ───────────────── CLI ───────────────── */
if (cmd === 'ask') {
  const rest = argv.slice(1);
  let model = ''; let fullAuto = false; const words = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--model') { model = rest[++i] || ''; continue; }
    if (rest[i] === '--full-auto') { fullAuto = true; continue; }
    words.push(rest[i]);
  }
  let prompt = words.join(' ').trim();
  if (!prompt) prompt = fs.readFileSync(0, 'utf8');
  if (!prompt.trim()) { console.error('[x] 没有提示词'); process.exit(2); }
  const r = await askCodex(prompt, { model, fullAuto });
  console.log(r.ok ? r.answer : `[失败 code=${r.code}] ${r.answer || r.error || ''}\n${r.stderr || ''}`);
  process.exit(r.ok ? 0 : 1);
}

if (cmd === 'post') {
  const prompt = argv.slice(1).join(' ').trim() || fs.readFileSync(0, 'utf8');
  const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  append(MAILBOX, { id, at: new Date().toISOString(), from: process.env.BRIDGE_FROM || 'unknown', prompt });
  console.log(JSON.stringify({ ok: true, id }));
  process.exit(0);
}

if (cmd === 'fetch') {
  const all = readLines(MAILBOX);
  if (!all.length) { console.log('[]'); process.exit(0); }
  /* 取出即清空（把已取走的记到 results 里，便于追溯） */
  ensureDir();
  fs.writeFileSync(MAILBOX, '', 'utf8');
  for (const t of all) append(RESULTS, { ...t, event: 'taken', takenAt: new Date().toISOString() });
  console.log(JSON.stringify(all, null, 1));
  process.exit(0);
}

if (cmd === 'reply') {
  const [, id, ...words] = argv;
  const text = words.join(' ').trim() || fs.readFileSync(0, 'utf8');
  if (!id) { console.error('[x] 用法：reply <id> "结果"'); process.exit(2); }
  append(RESULTS, { id, at: new Date().toISOString(), event: 'reply', text });
  console.log(JSON.stringify({ ok: true, id }));
  process.exit(0);
}

if (cmd === 'status') {
  const pend = readLines(MAILBOX);
  const res = readLines(RESULTS).filter((x) => x.event === 'reply');
  console.log(JSON.stringify({ pending: pend.length, replies: res.length, pendingIds: pend.map((p) => p.id) }));
  process.exit(0);
}

if (cmd === 'serve') {
  const server = http.createServer((req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
      if (req.method === 'POST' && url.pathname === '/task') {
        let payload = {};
        try { payload = JSON.parse(body || '{}'); } catch { /* 也接受纯文本 */ }
        const prompt = String(payload.prompt || body || '').trim();
        if (!prompt) return json(400, { ok: false, error: 'empty prompt' });
        const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        append(MAILBOX, { id, at: new Date().toISOString(), from: payload.from || 'http', prompt });
        return json(200, { ok: true, id });
      }
      if (req.method === 'GET' && url.pathname === '/tasks') return json(200, { tasks: readLines(MAILBOX) });
      if (req.method === 'GET' && url.pathname.startsWith('/result/')) {
        const id = url.pathname.split('/').pop();
        const hit = readLines(RESULTS).filter((x) => x.id === id && x.event === 'reply').pop();
        return hit ? json(200, hit) : json(404, { ok: false, error: 'no reply yet' });
      }
      if (req.method === 'POST' && url.pathname === '/ask') {
        let payload = {};
        try { payload = JSON.parse(body || '{}'); } catch { /* 忽略 */ }
        const r = await askCodex(String(payload.prompt || '').trim(), { model: payload.model || '', fullAuto: !!payload.fullAuto });
        return json(r.ok ? 200 : 502, r);
      }
      if (url.pathname === '/' || url.pathname === '/status') {
        return json(200, { ok: true, pending: readLines(MAILBOX).length, endpoints: ['POST /task', 'GET /tasks', 'GET /result/<id>', 'POST /ask'] });
      }
      json(404, { ok: false, error: 'not found' });
    });
  });
  server.on('error', (e) => {
    console.error(`[x] 监听失败（${PORT}）：${e && e.message}`);
    console.error('    端口被占就换一个：BRIDGE_PORT=8901 node tools/bridge.mjs serve');
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[bridge] 收发信箱已启动：http://127.0.0.1:${PORT}`);
    console.log('  POST /task {"prompt":"..."}  → 给我派活（我 fetch 时取走）');
    console.log('  POST /ask  {"prompt":"..."}  → 转问 Codex 并直接返回它的回答');
    console.log('  GET  /tasks | /result/<id> | /status');
    console.log('  （Ctrl+C 停止。这个进程要一直开着，信箱才有效。）');
  });
  /* ⚠️ 这里**不能** process.exit —— 会立刻把服务关掉（我第一版就踩了这个：
     一启动就退出，外部 curl 连不上）。让事件循环自然挂住。 */
}

console.log(`用法：node tools/bridge.mjs <命令>

  我 → Codex
    ask [--model M] [--full-auto] "提示词"    问 Codex 并拿回最终回答

  Codex → 我（文件信箱，最省事）
    post "任务"                              投一条任务
    fetch                                    取出并清空（我运行前先跑这个）
    reply <id> "结果"                        回写结果
    status                                   看队列

  Codex → 我（HTTP 信箱，适合 Codex 直接调）
    serve                                    起服务（127.0.0.1:${PORT}）
                                             POST /task | GET /tasks | GET /result/<id> | POST /ask

  环境变量：BRIDGE_PORT（默认 8899）、CODEX_BIN（codex.exe 路径）、BRIDGE_FROM（投递方标识）`);
