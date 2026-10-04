import puppeteer from 'puppeteer-core';
const CHROME = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1500, height: 950 } });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8787/?open=attention-is-all-you-need.pdf', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 3000));

const probe = async (label) => {
  const d = await page.evaluate(() => {
    const v = document.getElementById('viewer');
    return {
      clientHeight: v.clientHeight,
      scrollTop: v.scrollTop,
      scrollHeight: v.scrollHeight,
      pages: document.querySelectorAll('.page').length,
      canvases: document.querySelectorAll('.page canvas').length,
      firstPageTop: document.querySelector('.page')?.offsetTop,
      lastPageTop: document.querySelector('.page:last-of-type')?.offsetTop,
      pageH: document.querySelector('.page')?.offsetHeight,
    };
  });
  console.log(label, JSON.stringify(d));
};
await probe('初始:      ');
await page.evaluate(() => { document.getElementById('viewer').scrollTop = 5000; });
await new Promise((r) => setTimeout(r, 1500));
await probe('滚到中间:  ');
await page.evaluate(() => { const v = document.getElementById('viewer'); v.scrollTop = v.scrollHeight; });
await new Promise((r) => setTimeout(r, 1500));
await probe('滚到底部:  ');
await browser.close();
