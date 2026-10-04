#!/usr/bin/env node
/**
 * 验证 /api/chat 是"真流式"：记录每个 chunk 到达的时刻。
 * 如果服务端把上游整体缓冲后再发，所有 chunk 会在同一毫秒到达 —— 那就是失败的。
 *
 *   node check-stream.js <appPort> <mockPort>
 */
'use strict';

const appPort = Number(process.argv[2] || 8788);
const mockPort = Number(process.argv[3] || 8899);
const model = process.argv[4] || 'mock-model';

const body = {
  messages: [{ role: 'user', content: '你好' }],
  model,
  temperature: 0,
  stream: true,
  baseURL: `http://127.0.0.1:${mockPort}/v1`,
  apiKey: 'sk-mock-123',
};

const t0 = Date.now();
const res = await fetch(`http://127.0.0.1:${appPort}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

console.log(`status=${res.status} content-type=${res.headers.get('content-type')} `
  + `transfer-encoding=${res.headers.get('transfer-encoding') || '(none)'} `
  + `connection=${res.headers.get('connection') || '(none)'}`);

const reader = res.body.getReader();
const decoder = new TextDecoder();
const arrivals = [];
let text = '';

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  const chunk = decoder.decode(value, { stream: true });
  text += chunk;
  arrivals.push({ at: Date.now() - t0, size: chunk.length, chunk: chunk.replace(/\n/g, '\\n') });
}

console.log(`\n收到 ${arrivals.length} 个 chunk：`);
for (const a of arrivals) console.log(`  +${String(a.at).padStart(5)}ms  ${a.size}B  ${a.chunk}`);

const spread = arrivals.length ? arrivals[arrivals.length - 1].at - arrivals[0].at : 0;

let out = '';
for (const line of text.split('\n')) {
  const t = line.trim();
  if (!t.startsWith('data:')) continue;
  const payload = t.slice(5).trim();
  if (!payload || payload === '[DONE]') continue;
  try { out += JSON.parse(payload).choices?.[0]?.delta?.content || ''; } catch { /* ignore */ }
}

console.log(`\n拼出的正文: ${JSON.stringify(out)}`);
console.log(`首尾 chunk 时间差: ${spread}ms`);

const ok = arrivals.length >= 3 && spread >= 1000;
console.log(ok
  ? '\n[PASS] 确实是边收边发（chunk 分散在多个时间点到达）'
  : `\n[FAIL] 看起来被整体缓冲了（chunk 数=${arrivals.length}, 时间差=${spread}ms）`);
process.exit(ok ? 0 : 1);
