/**
 * 隔离测试：分块到达 vs 一次性到达
 *   node test/isolate.mjs
 * 直接对 /api/chat 发请求并给每个 chunk 打时间戳，绕开浏览器。
 */
import http from 'node:http';

const BASE = 'http://127.0.0.1:8787';
const MOCK_PORT = 8898;

const mock = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (let i = 1; i <= 6; i++) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `[c${i}]` } }] })}\n\n`);
    await new Promise((r) => setTimeout(r, 300));
  }
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

const t0 = Date.now();
const res = await fetch(`${BASE}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    baseURL: `http://127.0.0.1:${MOCK_PORT}/v1`,
    apiKey: 'x',
    model: 'm',
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  }),
});
console.log('响应头 content-type:', res.headers.get('content-type'));
console.log('响应头 transfer-encoding:', res.headers.get('transfer-encoding'));

const reader = res.body.getReader();
const dec = new TextDecoder();
let n = 0;
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  n++;
  const txt = dec.decode(value, { stream: true });
  console.log(`  chunk #${n} @ ${Date.now() - t0}ms : ${JSON.stringify(txt.replace(/\n/g, '\\n').slice(0, 60))}`);
}
console.log(`总计 ${n} 个 chunk，用时 ${Date.now() - t0}ms`);
console.log(n >= 6 ? '  → 代理是边收边转发的 ✅' : `  → 代理把响应缓冲了（只收到 ${n} 个 chunk）❌`);

mock.close();
process.exit(0);
