#!/usr/bin/env node
'use strict';

const http = require('http');

const PORT = Number(process.argv[2] || process.env.MOCK_PORT || 8899);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'not found' } }));
  }

  let raw = '';
  for await (const chunk of req) raw += chunk;
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch { /* ignore */ }

  console.log(
    `[mock] ${req.method} ${req.url} model=${payload.model} stream=${payload.stream} `
    + `auth=${req.headers.authorization || '(none)'} ua=${req.headers['user-agent'] || '(none)'} `
    + `bytes=${raw.length}`,
  );

  if (payload.model === 'boom') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'Invalid API key (mock)' } }));
  }

  if (payload.stream === false) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      id: 'mock-1',
      choices: [{ index: 0, message: { role: 'assistant', content: '非流式回包 OK' }, finish_reason: 'stop' }],
    }));
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // 客户端提前断开时能看出来 —— 用来验收"客户端断开要中止上游请求"
  let finished = false;
  res.on('close', () => {
    if (!finished) console.log('[mock] !! client aborted, upstream stream cancelled');
  });

  if (payload.model === 'stall') {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '开始…' } }] })}\n\n`);
    await sleep(120000);   // 之后一个字节都不发
    finished = true;
    return res.end();
  }

  const pieces = ['论文', '阅读', '器', '流式', '转发', '测试', '完成'];
  for (const piece of pieces) {
    if (res.destroyed) return;
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    await sleep(400);
  }
  if (res.destroyed) return;
  res.write('data: [DONE]\n\n');
  finished = true;
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] listening on http://127.0.0.1:${PORT}`);
});
