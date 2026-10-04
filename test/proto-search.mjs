/** 原型：验证几个搜索引擎的 HTML 能不能稳定解析出标题/链接/摘要 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

async function get(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(20000),
  });
  return { status: r.status, html: await r.text() };
}

const strip = (s) => String(s)
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#\d+;/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/* ---------- Bing ---------- */
function parseBing(html) {
  const out = [];
  const blocks = html.split(/<li class="b_algo"/).slice(1);
  for (const b of blocks) {
    const m = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!m) continue;
    const url = m[1];
    const title = strip(m[2]);
    let snippet = '';
    const sm = /<p[^>]*>([\s\S]*?)<\/p>/.exec(b) || /class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\//.exec(b);
    if (sm) snippet = strip(sm[1]);
    if (title && /^https?:/.test(url)) out.push({ title, url, snippet });
  }
  return out;
}

/* ---------- Baidu ---------- */
function parseBaidu(html) {
  const out = [];
  const blocks = html.split(/<div[^>]*class="result[^"]*"/).slice(1);
  for (const b of blocks) {
    const m = /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!m) continue;
    const url = m[1];
    const title = strip(m[2]);
    let snippet = '';
    const sm = /class="c-abstract[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(b) || /<span class="content-right_[^"]*">([\s\S]*?)<\/span>/.exec(b);
    if (sm) snippet = strip(sm[1]);
    if (title && url) out.push({ title, url, snippet });
  }
  return out;
}

/* ---------- Sogou ---------- */
function parseSogou(html) {
  const out = [];
  const blocks = html.split(/<div class="vrwrap"/).slice(1);
  for (const b of blocks) {
    const m = /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!m) continue;
    const title = strip(m[2]);
    let url = m[1];
    if (url.startsWith('/link')) url = 'https://www.sogou.com' + url;
    let snippet = '';
    const sm = /<div class="text-layout[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(b) || /<p[^>]*class="star-wiki"[^>]*>([\s\S]*?)<\/p>/.exec(b);
    if (sm) snippet = strip(sm[1]);
    if (title) out.push({ title, url, snippet });
  }
  return out;
}

/* ---------- 360 ---------- */
function parseSo(html) {
  const out = [];
  const blocks = html.split(/<li class="res-list"/).slice(1);
  for (const b of blocks) {
    const m = /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!m) continue;
    const title = strip(m[2]);
    let snippet = '';
    const sm = /<p class="res-desc"[^>]*>([\s\S]*?)<\/p>/.exec(b) || /class="res-rich[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(b);
    if (sm) snippet = strip(sm[1]);
    if (title && /^https?:/.test(m[1])) out.push({ title, url: m[1], snippet });
  }
  return out;
}

const q = encodeURIComponent('attention is all you need transformer 论文');
for (const [name, url, parse] of [
  ['Bing(cn)', `https://cn.bing.com/search?q=${q}&setlang=zh-CN`, parseBing],
  ['Baidu', `https://www.baidu.com/s?wd=${q}`, parseBaidu],
  ['Sogou', `https://www.sogou.com/web?query=${q}`, parseSogou],
  ['360', `https://www.so.com/s?q=${q}`, parseSo],
]) {
  try {
    const { status, html } = await get(url);
    const rs = parse(html);
    console.log(`\n── ${name}  http=${status}  html=${(html.length / 1024).toFixed(0)}KB  解析出 ${rs.length} 条`);
    for (const r of rs.slice(0, 3)) {
      console.log(`   · ${r.title.slice(0, 50)}`);
      console.log(`     ${r.url.slice(0, 78)}`);
      console.log(`     ${(r.snippet || '(无摘要)').slice(0, 70)}`);
    }
  } catch (e) {
    console.log(`\n── ${name} 失败: ${e.message}`);
  }
}
