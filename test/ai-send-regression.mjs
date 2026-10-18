// Real translation/chat requests against an isolated local fake upstream.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';

const scratch = fs.mkdtempSync(path.join(SANDBOX, 'ai-send-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data'));
const papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, 'fixture.pdf'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const listen = server => new Promise(r => server.listen(0, '127.0.0.1', r));
let hits = 0;
const mock = http.createServer(async (req, res) => {
  for await (const chunk of req) { /* drain */ }
  hits++;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const content of ['mock ', 'answer']) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    await wait(100);
  }
  res.end('data: [DONE]\n\n');
});
let server, browser;
try {
  await listen(mock);
  const probe = http.createServer(); await listen(probe);
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers,
      NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1' }, stdio: 'ignore',
  });
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    await wait(100); try { ready = (await fetch(base + '/api/health')).ok; } catch {}
  }
  assert.ok(ready);
  const config = await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: 'fake-key', model: 'mock' }) });
  assert.ok(config.ok);
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1400, height: 900 } });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base + '/?open=fixture.pdf');
  // PDF 存在时会话仍可能在恢复；等论文的完整打开流程结束再开始发送。
  await page.waitForFunction(() => window.__viewer?.pdf && window.__ctx
    && window.__state.viewerDocId === window.__state.doc?.docId);
  for (const kind of ['translate', 'explain', 'chat']) {
    const before = hits;
    const entriesBefore = await page.evaluate(() => window.__state.sessionEntries.length);
    await page.evaluate(kind => {
      window.__ctx.setScopeRange('current');
      window.__ctx.toggleScopePanel();
      if (kind === 'chat') {
        document.querySelector('#chatInput').value = 'Explain this paper.';
        document.querySelector('#sendBtn').click();
      } else {
        window.__ctx[kind === 'translate' ? 'doTranslate' : 'doExplain']({ text: 'Attention connects distant positions.', page: 1 });
      }
    }, kind);
    try {
      await page.waitForFunction((n) => window.__state.sessionEntries.length > n
        && !window.__state.busy
        && window.__state.sessionEntries.at(-1)?.status === 'complete', { timeout: 10000 }, entriesBefore);
    } catch (e) {
      console.log('TIMEOUT', kind, await page.evaluate(() => ({ busy: window.__state.busy,
        abort: !!window.__state.abort, entries: window.__state.sessionEntries.map(x => ({ tag:x.tag, status:x.status, text:x.text })) })));
      throw e;
    }
    const result = await page.evaluate(() => ({
      text: window.__state.sessionEntries.at(-1).text,
      disabled: document.querySelector('#sendBtn').disabled,
      scopeClosed: document.querySelector('#sendScope').classList.contains('hidden'),
    }));
    assert.equal(hits, before + 1, `${kind}: reaches upstream`);
    assert.equal(result.text, 'mock answer', `${kind}: renders real response`);
    assert.equal(result.disabled, false, `${kind}: composer usable again`);
    assert.equal(result.scopeClosed, true, `${kind}: scope popup closed`);
    console.log(`PASS ${kind}: upstream, response, busy reset, scope closed`);
  }
  assert.deepEqual(errors, []);
  console.log('PASS no browser exceptions; 13/13 assertions');
} finally {
  await browser?.close(); server?.kill();
  mock.closeAllConnections(); await new Promise(r => mock.close(r));
}
