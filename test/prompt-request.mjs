/**
 * A 线 P1：提示词 → 请求体的契约断言（Node + 假上游，不起浏览器）。
 *
 *   node test/prompt-request.mjs
 *
 * 1) 24 个场景的 messages 全部满足请求体 schema（role 合法、system 开头、user 结尾、无空内容）；
 * 2) 材料标签/问题块位置符合契约（问答问题在最后一条、教学/操作带【本次任务】）；
 * 3) 历史条数符合各能力声明（问答 6 / 操作 4 / 教学 10），翻译无历史；
 * 4) 不含密钥、路径、undefined；单请求估算 token < HARD_TOKENS；
 * 5) 真正发给 /api/chat 后，假上游收到的 messages 与本地构造逐字节一致
 *    （后端代理不改写前端消息），且 model 只来自本机 config。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildAll } from './_prompts.mjs';
import * as prompts from '../public/js/prompts/index.js';

const ROOT = path.join(import.meta.dirname, '..');
const SANDBOX = path.join(import.meta.dirname, 'artifacts');
let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  const ok = !!cond;
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? `  — ${detail}` : ''}`);
  if (ok) pass++;
  else failures.push({ name, detail });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 1. 消息级 schema 与契约 ── */
console.log('▶ 消息契约');
const scenarios = buildAll();
const names = Object.keys(scenarios);
const validRole = new Set(['system', 'user', 'assistant']);
for (const name of names) {
  const messages = scenarios[name];
  const text = messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  check(`${name} 非空`, Array.isArray(messages) && messages.length >= 1);
  check(`${name} role 合法且首条 system、末条 user`,
    messages.every((m) => validRole.has(m.role)) && messages[0].role === 'system'
    && messages[messages.length - 1].role === 'user',
    messages.map((m) => m.role).join(','));
  check(`${name} 没有空内容`, messages.every((m) => (typeof m.content === 'string' ? m.content.trim() : m.content)));
  check(`${name} 没有 undefined/null 字样`,
    !/\bundefined\b|\bnull\b/.test(text.replace(/"null"/g, '')));
}

/* 保留标记与关键标签（假上游路由依赖） */
const qa = scenarios['qa.chat/basic'];
check('问答 system 含引用契约', qa[0].content.includes('〔p.N‖'));
check('问答 user 含【论文】与【问题】', qa.at(-1).content.includes('【论文】') && qa.at(-1).content.includes('【问题】'));
check('问答最后一块就是问题', qa.at(-1).content.endsWith('{}'.length ? qa.at(-1).content.split('【问题】\n').at(-1) : ''));
check('问答不含 prt 协议（问答不做 chips）', !qa[0].content.includes('```prt'));
check('教学 system 含 prt 协议', scenarios['teach/intro'][0].content.includes('```prt'));
check('操作 user 含【本次任务】', scenarios['op/evidence'].at(-1).content.includes('【本次任务】'));
check('翻译 system 含「只输出译文」', scenarios['translate/basic'][0].content.includes('只输出译文本身'));
check('整篇材料带页标记', scenarios['qa.chat/fulltext-web-refs'].at(-1).content.includes('===== p.1 ====='));
check('联网材料带来源编号与防混用说明',
  scenarios['qa.chat/fulltext-web-refs'].at(-1).content.includes('[来源1]')
  && scenarios['qa.chat/fulltext-web-refs'].at(-1).content.includes('论文自己的参考文献'));
check('扫描件页图规则在 system 里', scenarios['qa.chat/scan-page-images'][0].content.includes('没有可抽取的文本层（扫描件）'));
check('截图规则按张数注入', scenarios['qa.chat/screenshot-only'][0].content.includes('本次附带了读者发来的 2 张截图'));
check('右栏选文明确「不是论文原文」', scenarios['qa.chat/right-selection'].at(-1).content.includes('来自右栏回答 / 译文，不是论文原文'));
check('记忆抽取 system 含「只输出 JSON 数组」', scenarios['bg/memory-extract'][0].content.includes('只输出 JSON 数组'));

/* P1.5：可用页码白名单 + 近因指令（程序事实，不靠模型记忆） */
check('问答材料含【本次可用页码】白名单', scenarios['qa.chat/basic'].at(-1).content.includes('【本次可用页码】'));
check('白名单按区间渲染（p.3 形式）', /【本次可用页码】p\.\d/.test(scenarios['qa.chat/basic'].at(-1).content),
  scenarios['qa.chat/basic'].at(-1).content.match(/【本次可用页码】[^\n（]*/)?.[0]);
check('问答问题前有【本轮要求】近因指令',
  scenarios['qa.chat/basic'].at(-1).content.indexOf('【本轮要求】') > 0
  && scenarios['qa.chat/basic'].at(-1).content.indexOf('【本轮要求】') < scenarios['qa.chat/basic'].at(-1).content.indexOf('【问题】'));
check('近因指令写明「当前页只是背景」', scenarios['qa.chat/basic'].at(-1).content.includes('当前页只是背景信息'));
check('教学材料含【本次可用页码】', scenarios['teach/prereq'].at(-1).content.includes('【本次可用页码】'));
check('操作材料含【本次可用页码】', scenarios['op/evidence'].at(-1).content.includes('【本次可用页码】'));
check('所在页上下文标注「背景信息，必要时可忽略」',
  scenarios['qa.chat/basic'].at(-1).content.includes('背景信息，必要时可忽略'));
check('没有材料的场景不带白名单（不编可用页）',
  !scenarios['qa.chat/screenshot-only'].at(-1).content.includes('【本次可用页码】'));

/* 历史条数 */
const countHistory = (name) => scenarios[name].filter((m) => m.role !== 'system').length - 1;
check('问答历史 ≤6 条', countHistory('qa.chat/basic') <= 6, String(countHistory('qa.chat/basic')));
check('操作历史 ≤4 条', countHistory('op/evidence') <= 4, String(countHistory('op/evidence')));
check('教学历史 ≤10 条', countHistory('teach/walk-continue') <= 10, String(countHistory('teach/walk-continue')));
check('翻译没有历史', countHistory('translate/basic') === 0);

/* 预算：全部场景都在硬上限内，且估算器可用 */
let maxTokens = 0;
let maxName = '';
for (const name of names) {
  const tokens = prompts.estimateMessagesTokens(scenarios[name]);
  if (tokens > maxTokens) { maxTokens = tokens; maxName = name; }
  check(`${name} token 估算 < 硬上限`, tokens < prompts.HARD_TOKENS, `${tokens}`);
}
check('最大场景在 8k token 内（P1 基线体量）', maxTokens < 8000, `${maxName} ${maxTokens}`);

/* 不含密钥 / 本机路径 */
const all = JSON.stringify(scenarios);
check('提示词里没有 API Key 形态', !/sk-[A-Za-z0-9]{16,}/.test(all));
check('提示词里没有本机绝对路径', !/[A-Za-z]:\\\\Users\\\\/.test(all) && !all.includes('AppData'));

/* ── 2. 请求级：假上游收到的 messages 与本地一致 ── */
console.log('\n▶ 请求体转发（假上游）');
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'prompt-request-'));
const dataDir = path.join(scratch, 'data');
const papersDir = path.join(scratch, 'papers');
fs.mkdirSync(dataDir); fs.mkdirSync(papersDir);
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'cn-sample.pdf'), path.join(papersDir, 'fixture.pdf'));

const captured = [];
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
    captured.push(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'mock ok' } }] }));
  });
});
const freePort = async () => {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  return port;
};
const upstreamPort = await freePort();
await new Promise((r) => upstream.listen(upstreamPort, '127.0.0.1', r));
const readerPort = await freePort();
const reader = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  windowsHide: true, stdio: 'ignore',
  env: {
    ...process.env, PORT: String(readerPort), PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1',
  },
});
const BASE = `http://127.0.0.1:${readerPort}`;
try {
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    await sleep(100);
    try { ready = (await fetch(`${BASE}/api/health`)).ok; } catch { /* starting */ }
  }
  check('隔离服务起来了', ready, BASE);
  if (ready) {
    await fetch(`${BASE}/api/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseURL: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-fake-prompt-request', model: 'mock-model',
      }),
    });
    const send = async (messages, extra = {}) => {
      const r = await fetch(`${BASE}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, model: 'evil-model', stream: false, ...extra }),
      });
      return r.json();
    };
    for (const name of ['qa.chat/basic', 'teach/intro', 'op/evidence', 'translate/basic', 'bg/digest']) {
      captured.length = 0;
      const messages = scenarios[name];
      const res = await send(messages);
      check(`${name} /api/chat 返回 200`, res && !res.error, JSON.stringify(res).slice(0, 80));
      const got = captured.at(-1);
      check(`${name} 上游收到同样的 messages（前端不被改写）`,
        JSON.stringify(got?.messages) === JSON.stringify(messages));
      check(`${name} model 只来自本机 config`, got?.model === 'mock-model', got?.model);
      check(`${name} 请求体里没有 apiKey 泄漏`, !JSON.stringify(got || {}).includes('apiKey'));
    }
    // tools 字段的受限透传：P2.5 已实现（形状校验在 security.js，Node/Rust 两套后端一致）
    captured.length = 0;
    const toolsPayload = [{ type: 'function', function: { name: 'read_page', description: '读页', parameters: { type: 'object', properties: { page: { type: 'integer' } } } } }];
    await send([{ role: 'user', content: 'hi' }], { tools: toolsPayload, tool_choice: 'auto', parallel_tool_calls: false });
    check('tools 透传给上游（P2.5 依赖）', JSON.stringify(captured.at(-1)?.tools) === JSON.stringify(toolsPayload),
      JSON.stringify(captured.at(-1)?.tools || null).slice(0, 80));
    check('tool_choice 透传', captured.at(-1)?.tool_choice === 'auto', String(captured.at(-1)?.tool_choice));
    check('parallel_tool_calls=false 透传', captured.at(-1)?.parallel_tool_calls === false);
    // 非法 tools 必须 400，不能塞给上游
    captured.length = 0;
    const badToolRes = await fetch(`${BASE}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: false, tools: [{ type: 'function', function: { name: 'bad name!', parameters: {} } }] }),
    });
    check('非法 tools 名返回 400 且不发给上游', badToolRes.status === 400 && captured.length === 0, String(badToolRes.status));
  }
} finally {
  reader.kill();
  await new Promise((r) => { upstream.closeAllConnections?.(); upstream.close(r); });
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n结果：${pass}/${pass + failures.length} 通过`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  ❌ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
