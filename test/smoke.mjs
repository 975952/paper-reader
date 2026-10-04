import puppeteer from 'puppeteer-core';
const CHROME = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.stack || e}`));
page.on('requestfailed', (r) => logs.push(`[failed] ${r.url()} :: ${r.failure()?.errorText}`));
await page.goto('http://127.0.0.1:8787/?open=attention-is-all-you-need.pdf', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 6000));
const st = await page.evaluate(() => ({
  docName: document.getElementById('docName')?.textContent,
  pages: document.querySelectorAll('.page').length,
  canvases: document.querySelectorAll('.page canvas').length,
  status: document.getElementById('statusText')?.textContent,
  welcome: !document.getElementById('welcome')?.classList.contains('hidden'),
  hasViewer: !!window.__viewer,
  papers: document.querySelectorAll('#fileList li').length,
}));
console.log('状态:', JSON.stringify(st, null, 1));
console.log('\n日志:');
for (const l of logs.slice(0, 30)) console.log('  ' + l);
await browser.close();
