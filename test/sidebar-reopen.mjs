import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-reopen-'));
for (const dir of ['data', 'papers']) fs.mkdirSync(path.join(tmp, dir));
const exe = path.join(tmp, 'reader.exe');
fs.copyFileSync(path.join(root, '论文阅读器.exe'), exe);
const child = spawn(exe, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, PRT_DATA_DIR: path.join(tmp, 'data'), PRT_PAPERS_DIR: path.join(tmp, 'papers'), PRT_REQUIRE_TOKEN: '0' } });
let browser;
try {
  let base;
  for (let attempt = 0; attempt < 40 && !base; attempt++) {
    await new Promise(r => setTimeout(r, 300));
    for (let port = 8787; port < 8807; port++) {
      try {
        const candidate = `http://127.0.0.1:${port}`;
        const res = await fetch(candidate + '/api/health', { signal: AbortSignal.timeout(150) });
        if (res.ok) { base = candidate; break; }
      } catch {}
    }
  }
  assert.ok(base, 'isolated exe listening');
  const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: path.join(tmp, 'profile') });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base, { waitUntil: 'networkidle0' });
  assert.equal(await (await fetch(base + '/js/app.js')).text(), fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8'), 'embedded source matches');
  for (const [rail, id] of [['files', 'files'], ['outline', 'outline'], ['notes', 'notes']]) {
    await page.click(`[data-rail="${rail}"]`);
    await page.click(`[data-panel="${id}"] .panel-hide`);
    await page.click('#topbarLeftToggle');
    await page.waitForFunction(id => {
      const side = document.querySelector('#leftSide');
      const panel = document.querySelector(`[data-panel="${id}"]`);
      return side.getBoundingClientRect().width > 0 && !panel.classList.contains('hidden') && !document.body.classList.contains('no-left');
    }, {}, id);
    await page.click('#topbarLeftToggle');
    await page.click('#topbarLeftToggle');
    assert.equal(await page.$eval('#leftSide', el => el.getBoundingClientRect().width > 0), true);
    console.log(`PASS ${id}: close -> topbar reopen -> collapse -> reopen`);
  }
  assert.deepEqual(errors, []);
  console.log('PASS embedded source and zero page errors');
} finally {
  await browser?.close();
  child.kill();
}
