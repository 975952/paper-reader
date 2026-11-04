/** Node backend regression: all mutable files and a fake key live in a fresh OS temp root. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir } from './_env.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-save-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
fs.mkdirSync(DATA); fs.mkdirSync(PAPERS);
const PORT = 9010 + Math.floor(Math.random() * 4000);
const BASE = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  // 2026-10 安全加固：隔离服务自己 spawn，须显式关掉强制校验并开启诊断路径
  env: { ...process.env, PORT: String(PORT), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS, NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1' },
  stdio: 'ignore',
});
const stop = () => { try { child.kill(); } catch {} };
process.on('exit', () => { stop(); fs.rmSync(scratch, { recursive: true, force: true }); });
const check = (label, ok) => { console.log(`${ok ? '✅' : '❌'} ${label}`); if (!ok) process.exitCode = 1; };
let guardRejected = false;
try { assertIsolatedDataDir(path.join(ROOT, 'data')); } catch { guardRejected = true; }
check('测试护栏拒绝仓库真实 data/ 目录', guardRejected);

let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 150));
  try { ready = (await fetch(`${BASE}/api/health`)).ok; } catch {}
}
check('isolated Node server starts', ready);
if (!ready) process.exit(1);
const defaults = await fetch(`${BASE}/api/config`).then((r) => r.json());
check('empty isolated config uses the default model', defaults.model === 'deepseek-flash' && defaults.apiKey === '' && !defaults.hasApiKey);

const post = (url, payload) => fetch(`${BASE}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
const failWrite = async (file, url, payload) => {
  const target = path.join(DATA, file); const backup = `${target}.old`;
  if (fs.existsSync(target)) fs.renameSync(target, backup);
  fs.mkdirSync(target);
  const response = await post(url, payload);
  fs.rmSync(target, { recursive: true, force: true });
  if (fs.existsSync(backup)) fs.renameSync(backup, target);
  return response.status;
};

check('config write failure returns 500', await failWrite('config.json', '/api/config', { apiKey: 'fake-test-key' }) >= 500);
check('state write failure returns 500', await failWrite('state.json', '/api/state', { page: 2 }) >= 500);
let h = 5381; const doc = 'fixture-save-test'; for (const c of doc) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
const slug = doc.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 48);
check('notes write failure returns 500', await failWrite(`notes-${slug}-${h.toString(16)}.json`, `/api/notes?doc=${doc}`, { items: [{ id: 'pending' }] }) >= 500);

const config = await post('/api/config', { apiKey: 'fake-test-key', model: 'mock-model' });
const configJson = await config.json();
const readConfig = await fetch(`${BASE}/api/config`).then((r) => r.json());
check('fake key is accepted but never returned', config.ok && configJson.hasApiKey && readConfig.apiKey === '');
const progress = await post('/api/state', { docs: { fixture: { page: 2 } } });
check('progress retry succeeds after storage is writable', progress.ok);
const session = await post(`/api/session?doc=${doc}`, { entries: [{ text: 'completed mock result' }], history: [] });
check('session is persisted in isolated data root', session.ok && JSON.parse(fs.readFileSync(path.join(DATA, `session-${slug}-${h.toString(16)}.json`), 'utf8')).entries[0].text === 'completed mock result');

const chrome = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const browser = await puppeteer.launch({ executablePath: chrome, headless: 'shell', args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__settings);
await page.click('#settingsBtn');
await page.evaluate(() => {
  document.querySelector('#cfgModel').value = 'pending-model-value';
  const original = window.fetch.bind(window);
  window.fetch = (url, opts) => String(url) === '/api/config' && opts?.method === 'POST'
    ? Promise.resolve(new Response(JSON.stringify({ error: { message: 'disk full' } }), { status: 500, headers: { 'Content-Type': 'application/json' } }))
    : original(url, opts);
});
await page.click('#saveSettings');
await page.waitForFunction(() => /保存失败.*HTTP 500|保存失败.*disk full/.test(document.querySelector('#testResult')?.textContent || ''));
const draft = await page.$eval('#cfgModel', (n) => n.value);
check('保存失败在前端明确提示且保留设置草稿', draft === 'pending-model-value');
await browser.close();

stop();
