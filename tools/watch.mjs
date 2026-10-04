/**
 * 信箱守望：**只观察、不取走**，一有任务就退出。
 *
 * 为什么需要它：
 *   DSH 是 Electron GUI 应用，**没有 headless / CLI 入口**，我是跑在会话里的智能体，
 *   只在「用户发消息 / 会话被恢复」时执行 —— Codex 没法直接把我叫醒。
 *   （实测：`dsh` 不在 PATH 上；GUI 端口 127.0.0.1:19387 需要鉴权，401；
 *     也没有「往某个会话投一条消息」的公开入口。）
 *
 *   但有一条**受支持的通道**：后台任务结束时，运行时会往我的会话里投一条完成通知。
 *   所以只要挂一个「有任务就退出」的后台任务，Codex 一投递我就会收到通知，
 *   然后我自己跑 `bridge.mjs fetch` 取件（**取件仍然只走 bridge，避免两处逻辑**）。
 *
 * 用法：
 *   node tools/watch.mjs                    # 守望默认信箱，最多 1 小时
 *   node tools/watch.mjs --timeout 1800     # 30 分钟
 *   node tools/watch.mjs --interval 1000    # 轮询间隔 1s（默认 2000）
 *   node tools/watch.mjs --mailbox <path>   # 换一个信箱文件（测试用）
 *   node tools/watch.mjs --once             # 只查一次（不等待），有任务退 0、没有退 3
 *
 * 退出码：0 = 信箱里有任务（会打印条数与 id）；3 = 等到超时也没有；2 = 参数错。
 * 它**从不修改信箱**：取走是 `bridge.mjs fetch` 的事，这里只读，避免和 bridge 抢。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};

const MAILBOX = path.resolve(arg('--mailbox', path.join(ROOT, 'test', 'artifacts', 'bridge', 'mailbox.jsonl')));
const TIMEOUT_MS = Math.max(1, Number(arg('--timeout', 3600))) * 1000;
const INTERVAL_MS = Math.max(200, Number(arg('--interval', 2000)));
const ONCE = argv.includes('--once');

if (argv.includes('--help') || argv.includes('-h')) {
  console.log('用法：node tools/watch.mjs [--timeout 秒] [--interval 毫秒] [--mailbox 路径] [--once]');
  process.exit(0);
}

/**
 * 读信箱里还没被取走的任务（只读，绝不清空）。
 *
 * ⚠️ 必须剥 BOM + 逐行容错：信箱被带 BOM 的编辑器 / PowerShell `Set-Content -Encoding utf8`
 * 碰过之后，第一行 `JSON.parse` 会抛错；如果这里静默丢掉那一行，守望就会对着
 * 「明明有任务」的信箱一直报「信箱为空」。这是「任务来了但我收不到」最隐蔽的一种坏法。
 */
function pending() {
  let text = '';
  try { text = fs.readFileSync(MAILBOX, 'utf8'); } catch { return []; }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try { out.push(JSON.parse(line)); }
    catch { console.error(`[watch] 跳过一行无法解析的内容（${line.slice(0, 60)}…）`); }
  }
  return out;
}

function report(tasks) {
  console.log(`[watch] 收到 ${tasks.length} 条任务：${tasks.map((t) => t.id).join(', ')}`);
  for (const t of tasks) {
    const prompt = String(t.prompt || '').replace(/\s+/g, ' ').slice(0, 120);
    console.log(`  · ${t.id}（${t.at || '?'}，来自 ${t.from || '?'}）：${prompt}${prompt.length >= 120 ? '…' : ''}`);
  }
  console.log(`[watch] 下一步：node tools/bridge.mjs fetch   # 取出并清空，然后处理`);
}

const started = Date.now();
for (;;) {
  const tasks = pending();
  if (tasks.length) { report(tasks); process.exit(0); }
  if (ONCE) { console.log('[watch] 信箱为空'); process.exit(3); }
  if (Date.now() - started >= TIMEOUT_MS) {
    console.log(`[watch] 等了 ${Math.round((Date.now() - started) / 1000)}s 没有新任务，退出`);
    process.exit(3);
  }
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
}
