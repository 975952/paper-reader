#!/usr/bin/env node
/**
 * 论文阅读器 —— 本地服务（零依赖，只用 Node 标准库）
 *
 * 职责：
 *   1. 托管前端静态文件（public/）
 *   2. 列出 / 读取 papers/ 目录里的 PDF
 *   3. 转发 AI 请求到任意 OpenAI 兼容接口（绕开浏览器 CORS，密钥只留在本机）
 *   4. 保存设置、阅读进度、高亮笔记到 data/
 *
 * 只监听 127.0.0.1，不对外暴露。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
/**
 * 论文目录 / 数据目录默认在仓库里，但允许用环境变量换掉。
 * 这是给测试留的：想验证「没有 API Key 时联网搜索照样能用」，
 * 就得让服务端读一份空配置，而不是把用户真填的 Key 搬走再搬回来
 * —— 那样一旦测试中途被强杀（taskkill /F 不会跑退出钩子），用户的 Key 就真丢了。
 */
const PAPERS_DIR = process.env.PRT_PAPERS_DIR || path.join(ROOT, 'papers');
const DATA_DIR = process.env.PRT_DATA_DIR || path.join(ROOT, 'data');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
/** 导入 PDF 的大小上限 */
const MAX_UPLOAD = 256 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/* ------------------------------------------------------------------ utils */

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': MIME['.json'] });
}

async function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  return JSON.parse(raw.toString('utf8'));
}

/** 把用户传入的相对路径安全地解析到 base 目录内，越界返回 null */
function safeJoin(base, rel) {
  const cleaned = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('\0')) return null;
  const abs = path.resolve(base, cleaned);
  const relToBase = path.relative(base, abs);
  if (relToBase.startsWith('..') || path.isAbsolute(relToBase)) return null;
  return abs;
}

/** 文档 id：论文文件名的稳定短哈希，用于存放进度/笔记 */
function docIdOf(name) {
  let h = 5381;
  const s = String(name);
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  const slug = s.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 48);
  return `${slug}-${h.toString(16)}`;
}

/* ------------------------------------------------------------------- data */

async function ensureDirs() {
  await fsp.mkdir(PUBLIC_DIR, { recursive: true });
  await fsp.mkdir(PAPERS_DIR, { recursive: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });
}

async function readDataFile(name, fallback) {
  try {
    const raw = await fsp.readFile(path.join(DATA_DIR, name), 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

let writeChain = Promise.resolve();
/** 串行化写盘，避免并发请求交叉写坏 JSON */
function writeDataFile(name, obj) {
  // 注意先 catch：否则一次写失败会让整条 Promise 链永久处于 rejected 状态，
  // 之后所有的保存（设置/进度/笔记）都会静默失效
  writeChain = writeChain.catch(() => {}).then(async () => {
    const target = path.join(DATA_DIR, name);
    const tmp = `${target}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
    await fsp.rename(tmp, target);
  });
  return writeChain;
}

const DEFAULT_CONFIG = {
  baseURL: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-flash',
  visionModel: '',
  targetLang: '中文',
  temperature: 0.2,
  theme: 'light',
  fontSize: 15,
  autoTranslate: true,
  stream: true,
  glossary: '',
  idleMs: 60000,
};

/* ---------------------------------------------------------------- papers */

async function listPapers() {
  let entries = [];
  try {
    entries = await fsp.readdir(PAPERS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!/\.pdf$/i.test(e.name)) continue;
    const st = await fsp.stat(path.join(PAPERS_DIR, e.name)).catch(() => null);
    if (!st) continue;
    out.push({
      name: e.name,
      size: st.size,
      mtime: st.mtimeMs,
      docId: docIdOf(e.name),
      url: `/api/pdf?name=${encodeURIComponent(e.name)}`,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/**
 * 把文件流式发给客户端。
 * 必须监听源流 error：pipe() 不会把源流错误转给 res，
 * 未处理的 'error' 会变成 uncaughtException 直接干掉整个进程
 * （Windows 上文件被独占、U 盘/网络盘断开、读到一半 EIO 都会触发）。
 */
function streamFile(res, absPath, opts) {
  const rs = fs.createReadStream(absPath, opts);
  rs.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
  res.on('close', () => { try { rs.destroy(); } catch { /* ignore */ } });
  rs.pipe(res);
}

/** 支持 Range 的 PDF 读取，大文件不用一次性加载进内存 */
function servePdf(req, res, absPath) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return send(res, 404, 'PDF 不存在');
  }
  const total = stat.size;
  const range = req.headers.range;
  const baseHeaders = {
    'Content-Type': 'application/pdf',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start;
      let end;
      if (m[1] === '') {
        // 后缀区间 bytes=-N：最后 N 字节
        const n = parseInt(m[2] || '0', 10);
        if (!n) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}` });
          return res.end();
        }
        start = Math.max(0, total - n);
        end = total - 1;
      } else {
        start = parseInt(m[1], 10);
        end = m[2] ? parseInt(m[2], 10) : total - 1;
      }
      if (Number.isNaN(start) || start < 0) start = 0;
      if (Number.isNaN(end) || end >= total) end = total - 1;
      if (start > end || start >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        return res.end();
      }
      res.writeHead(206, {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': end - start + 1,
      });
      if (req.method === 'HEAD') return res.end();
      return streamFile(res, absPath, { start, end });
    }
  }
  res.writeHead(200, { ...baseHeaders, 'Content-Length': total });
  if (req.method === 'HEAD') return res.end();
  streamFile(res, absPath);
}

/* ------------------------------------------------------------------- chat */

function normalizeChatUrl(baseURL) {
  let base = String(baseURL || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('没有配置 API 地址');
  if (!/^https?:\/\//i.test(base)) throw new Error('API 地址必须以 http:// 或 https:// 开头');
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

async function handleChat(req, res) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: { message: `请求体解析失败: ${e.message}` } });
  }

  const stored = await readDataFile('config.json', {});
  const baseURL = payload.baseURL || stored.baseURL || DEFAULT_CONFIG.baseURL;
  const apiKey = payload.apiKey !== undefined && payload.apiKey !== '' ? payload.apiKey : stored.apiKey || '';
  const model = payload.model || stored.model || DEFAULT_CONFIG.model;

  let url;
  try {
    url = normalizeChatUrl(baseURL);
  } catch (e) {
    return sendJson(res, 400, { error: { message: e.message } });
  }

  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return sendJson(res, 400, { error: { message: 'messages 不能为空' } });
  }

  const body = {
    model,
    messages: payload.messages,
    stream: payload.stream !== false,
    temperature: typeof payload.temperature === 'number' ? payload.temperature : DEFAULT_CONFIG.temperature,
  };
  if (typeof payload.max_tokens === 'number' && payload.max_tokens > 0) body.max_tokens = payload.max_tokens;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  headers['User-Agent'] = 'paper-reader/1.0';

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  req.on('aborted', onAbort);
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (controller.signal.aborted) return;
    return sendJson(res, 502, {
      error: { message: `连接 ${url} 失败：${e.message}。请检查 API 地址 / 网络 / 代理。` },
    });
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = j?.error?.message || j?.message || text;
    } catch {
      /* 保持原文 */
    }
    return sendJson(res, upstream.status, { error: { message: msg || `上游返回 ${upstream.status}` } });
  }

  if (!body.stream) {
    const type = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    const text = await upstream.text();
    return send(res, 200, text, { 'Content-Type': type });
  }

  // 上游可能忽略 stream:true 直接回普通 JSON。
  // 这时绝不能给它贴上 text/event-stream —— 前端会当成 SSE 去解析，
  // 结果一个 data: 行都没有，表现为「模型没有返回任何内容」的空白气泡。
  const upstreamType = (upstream.headers.get('content-type') || '').toLowerCase();
  if (!upstreamType.includes('event-stream')) {
    const text = await upstream.text();
    return send(res, 200, text, {
      'Content-Type': upstreamType || 'application/json; charset=utf-8',
    });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // 上游空闲超时：一段时间一个字节都收不到就主动收尾，
  // 否则连接会一直挂着，前端看起来就是「卡住了」
  const idleMs = Number(payload.idleMs) || Number(stored.idleMs) || DEFAULT_CONFIG.idleMs || 60000;
  let idleTimer = null;
  let idled = false;
  const onIdle = () => {
    idled = true;
    try { controller.abort(); } catch { /* ignore */ }
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: { message: `上游超过 ${Math.round(idleMs / 1000)} 秒没有返回任何数据` } })}\n\n`);
      res.end();
    }
  };
  const bumpIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(onIdle, idleMs);
  };

  bumpIdle();
  try {
    for await (const chunk of Readable.fromWeb(upstream.body)) {
      bumpIdle();
      res.write(chunk);
    }
  } catch (e) {
    if (!controller.signal.aborted && !idled) {
      res.write(`data: ${JSON.stringify({ error: { message: `读取上游流失败：${e.message}` } })}\n\n`);
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (!res.writableEnded) res.end();
  }
}

/* ---------------------------------------------------------- 文献检索 */

const FETCH_TIMEOUT = 9000;

async function getText(url, accept = '*/*', ua = 'paper-reader/1.0 (local; reference lookup)') {
  const r = await fetch(url, {
    headers: { 'User-Agent': ua, Accept: accept, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

/** 从一条参考文献里猜标题：作者列表通常在第一段，标题紧随其后 */
function guessTitle(ref) {
  let s = String(ref).replace(/^\[\d+\]\s*/, '').replace(/\s+/g, ' ').trim();
  const parts = s.split(/\.\s+/);
  if (parts.length >= 2) {
    const first = parts[0];
    const looksLikeAuthors = /,|\band\b/i.test(first) && first.split(/\s+/).length <= 80;
    s = looksLikeAuthors ? parts[1] : parts[0];
  }
  s = s.replace(/^(In|Proceedings|Proc\.|Advances)\b.*$/i, '').trim();
  return (s || String(ref)).replace(/[.,;:]+$/, '').slice(0, 160);
}

function titleScore(a, b) {
  const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ').trim();
  const A = new Set(norm(a).split(' ').filter(Boolean));
  const B = new Set(norm(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / Math.max(A.size, B.size);
}

/**
 * 给一条参考文献找 PDF / 链接。
 * arXiv（常直接给 PDF）→ OpenAlex（免费、有 open_access.oa_url）→ Crossref（覆盖面最广，DOI 落地页）。
 * Semantic Scholar 只在没被限流时作为补充（公开接口经常 429）。
 * 全是公开接口，不需要密钥；某个源失败就跳过，不会整体失败。
 */
async function searchReference(q) {
  const raw = String(q).replace(/\s+/g, ' ').trim().slice(0, 300);
  const title = guessTitle(raw);
  const results = [];

  // 1) arXiv：先按标题精确搜，没有再退回全文搜
  for (const query of [`ti:"${title}"`, `all:"${title}"`]) {
    try {
      const xml = await getText(
        `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&max_results=3`,
        'application/atom+xml',
      );
      for (const e of xml.split('<entry>').slice(1)) {
        const t = (/<title>([\s\S]*?)<\/title>/.exec(e)?.[1] || '').replace(/\s+/g, ' ').trim();
        const id = (/<id>([\s\S]*?)<\/id>/.exec(e)?.[1] || '').trim();
        const year = (/<published>(\d{4})/.exec(e)?.[1]) || '';
        if (!/arxiv\.org\/abs\//.test(id)) continue;
        results.push({ source: 'arXiv', title: t, year, venue: 'arXiv', url: id, pdfUrl: id.replace('/abs/', '/pdf/') });
      }
      if (results.length) break;
    } catch { /* 换下一个源 */ }
  }

  // 2) OpenAlex：免费无密钥，而且有开放获取直链
  try {
    const j = JSON.parse(await getText(
      `https://api.openalex.org/works?search=${encodeURIComponent(title)}&per-page=4&select=title,publication_year,doi,open_access,primary_location`,
      'application/json',
    ));
    for (const w of j.results || []) {
      const oa = w.open_access?.oa_url || '';
      results.push({
        source: 'OpenAlex',
        title: w.title || '',
        year: w.publication_year ? String(w.publication_year) : '',
        venue: w.primary_location?.source?.display_name || '',
        url: w.doi || w.primary_location?.landing_page_url || '',
        pdfUrl: /\.pdf(\?|$)/i.test(oa) ? oa : '',
        oaUrl: oa,
      });
    }
  } catch { /* 忽略 */ }

  // 3) Crossref：用整条文献串检索，覆盖最广
  try {
    const j = JSON.parse(await getText(
      `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(raw.slice(0, 220))}&rows=3&select=title,DOI,URL,issued,container-title`,
      'application/json',
    ));
    for (const w of j.message?.items || []) {
      const doi = w.DOI || '';
      results.push({
        source: 'Crossref',
        title: (w.title || [])[0] || '',
        year: w.issued?.['date-parts']?.[0]?.[0] ? String(w.issued['date-parts'][0][0]) : '',
        venue: (w['container-title'] || [])[0] || '',
        url: w.URL || (doi ? `https://doi.org/${doi}` : ''),
        pdfUrl: '',
      });
    }
  } catch { /* 忽略 */ }

  // 4) Semantic Scholar：能通就补一条（经常 429，失败无所谓）
  try {
    const j = JSON.parse(await getText(
      `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(title)}&limit=3&fields=title,year,venue,url,openAccessPdf`,
      'application/json',
    ));
    for (const p of j.data || []) {
      results.push({
        source: 'Semantic Scholar',
        title: p.title || '',
        year: p.year ? String(p.year) : '',
        venue: p.venue || '',
        url: p.url || '',
        pdfUrl: p.openAccessPdf?.url || '',
      });
    }
  } catch { /* 忽略 */ }

  // 去重 → 按「标题相似度 + 有没有 PDF 直链」排序
  const seen = new Set();
  const uniq = [];
  for (const r of results) {
    const key = (r.title || r.url || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '').slice(0, 60);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    r.score = titleScore(title, r.title) + (r.pdfUrl ? 0.35 : 0) + (r.url?.includes('doi.org') || r.url?.includes('arxiv.org') ? 0.1 : 0);
    uniq.push(r);
  }
  uniq.sort((a, b) => b.score - a.score);

  return {
    query: raw,
    title,
    results: uniq.slice(0, 6).map(({ score, ...r }) => r),
    searchUrl: `https://www.bing.com/search?q=${encodeURIComponent(`${title} pdf`)}`,
    scholarUrl: `https://scholar.google.com/scholar?q=${encodeURIComponent(title)}`,
  };
}
/* ---------------------------------------------------------- 联网搜索 */

const SEARCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const searchCache = new Map();     // q -> { at, data }
const SEARCH_TTL = 5 * 60 * 1000;

function stripTags(s) {
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bing 的结果块最规整：直链 + 摘要 */
function parseBing(html) {
  const out = [];
  for (const b of html.split(/<li class="b_algo"/).slice(1)) {
    const m = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!m) continue;
    const url = stripTags(m[1]);
    const title = stripTags(m[2]);
    let snippet = '';
    const sm = /<p[^>]*>([\s\S]*?)<\/p>/.exec(b);
    if (sm) snippet = stripTags(sm[1]);
    if (title && /^https?:\/\//.test(url)) out.push({ title, url, snippet });
  }
  return out;
}

function parseSogou(html) {
  const out = [];
  for (const b of html.split(/<div class="vrwrap"/).slice(1)) {
    const m = /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!m) continue;
    let url = stripTags(m[1]);
    if (url.startsWith('/link')) url = `https://www.sogou.com${url}`;
    const title = stripTags(m[2]);
    let snippet = '';
    const sm = /<div class="text-layout[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(b) || /<p[^>]*class="star-wiki"[^>]*>([\s\S]*?)<\/p>/.exec(b);
    if (sm) snippet = stripTags(sm[1]);
    if (title && /^https?:\/\//.test(url)) out.push({ title, url, snippet });
  }
  return out;
}

function parseBaidu(html) {
  const out = [];
  for (const b of html.split(/<div[^>]*class="result[^"]*"/).slice(1)) {
    const m = /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!m) continue;
    const url = stripTags(m[1]);
    const title = stripTags(m[2]);
    let snippet = '';
    const sm = /class="c-abstract[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(b);
    if (sm) snippet = stripTags(sm[1]);
    if (title && /^https?:\/\//.test(url)) out.push({ title, url, snippet });
  }
  return out;
}

/**
 * 结果与查询串是不是完全沾不上边。
 *
 * 真实踩过的坑：把一整句中文问句丢给 Bing，它会退化成单字查询，返回一堆
 * 「这」字的字典释义。这种结果当成「来源」列给用户比没有还糟 —— 模型会被带偏，
 * 用户点开也全是垃圾。所以这里做一次极保守的相关性筛查：
 * 只要有任意一条结果命中了查询里的一个「有辨识度的词」就放行，
 * 一条都不命中才判定这个引擎这次不能用，换下一个引擎。
 */
function queryTokens(q) {
  const s = String(q || '').toLowerCase();
  const toks = new Set();
  for (const w of s.match(/[a-z][a-z0-9+#._-]*/g) || []) if (w.length >= 2) toks.add(w);
  const cjk = s.replace(/[^\u4e00-\u9fa5]+/g, ' ');
  for (const run of cjk.split(/\s+/)) {
    for (let i = 0; i + 2 <= run.length; i++) toks.add(run.slice(i, i + 2));   // 所有二字组
  }
  return [...toks];
}

function looksRelevant(query, results) {
  const toks = queryTokens(query);
  if (!toks.length) return true;           // 纯符号之类的查询，没法判断，放行
  const hit = results.filter((r) => {
    const hay = `${r.title || ''} ${r.snippet || ''}`.toLowerCase();
    return toks.some((t) => hay.includes(t));
  }).length;
  // 要求「过半数结果都沾边」。只要求 1 条的话，长问句几乎必然蒙中一个二字组
  // （问句里的二字组太多了），兜底就形同虚设。
  return hit >= Math.max(2, Math.ceil(results.length / 2));
}

/**
 * 联网搜索。依次试 Bing(cn) → 搜狗 → 百度，谁先给出够用的结果就用谁。
 * 都是公开页面、不需要密钥；结果缓存 5 分钟，避免同一个问题反复打人家。
 */
async function webSearch(q, n = 6) {
  const query = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!query) return { query, provider: '', results: [] };

  const key = query.toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.data;

  const engines = [
    ['Bing', `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`, parseBing],
    ['搜狗', `https://www.sogou.com/web?query=${encodeURIComponent(query)}`, parseSogou],
    ['百度', `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`, parseBaidu],
  ];
  let dropped = 0;
  for (const [name, url, parse] of engines) {
    try {
      const html = await getText(url, 'text/html,application/xhtml+xml', SEARCH_UA);
      const all = parse(html);
      const results = all.slice(0, n);
      if (results.length >= 2 && looksRelevant(query, results)) {
        const data = { query, provider: name, results };
        if (searchCache.size > 200) searchCache.clear();
        searchCache.set(key, { at: Date.now(), data });
        return data;
      }
      if (results.length >= 2) dropped++;
    } catch { /* 换下一个引擎 */ }
  }
  // 这里**不能**写「反正别的引擎失败了，就把这批不相关的先给出去」。
  // 之前留过这么一个兜底，结果 Bing 退化成单字查询时，一堆「这」字的字典释义
  // 照样被当成来源返回给模型和用户。宁可不给，也别给错的。
  return {
    query, provider: '', results: [],
    error: dropped
      ? '搜到的结果和问题对不上，已丢弃（换个更具体的问法试试）'
      : '几个搜索引擎都没返回可用结果（可能被限流或断网）',
  };
}

/* --------------------------------------------------------------- 联网导入 */

/** 一次性导入的大小上限（比拖拽上传小一些，够放任何论文了） */
const MAX_IMPORT = 128 * 1024 * 1024;

/**
 * 内网地址不接。这个接口是「让本机去下载一个外部 URL」，
 * 不挡的话就变成一个可被网页利用的内网探测器（SSRF）。
 * 导入论文用到的都是 arXiv / 期刊这类公网地址，挡掉内网不影响正常使用。
 */
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** 从 URL 或 Content-Disposition 里猜一个像样的文件名 */
function guessPdfName(finalUrl, disposition) {
  const cd = String(disposition || '');
  let raw = '';
  const star = /filename\*\s*=\s*([^;]+)/i.exec(cd);
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  if (star) {
    // filename*=UTF-8''%E8%AE%BA%E6%96%87.pdf
    const v = star[1].trim().replace(/^[^']*'[^']*'/, '');
    try { raw = decodeURIComponent(v); } catch { raw = v; }
  } else if (plain) {
    raw = plain[1].trim();
  }
  if (!raw) {
    try {
      const p = decodeURIComponent(new URL(finalUrl).pathname);
      raw = p.split('/').filter(Boolean).pop() || '';
    } catch { raw = ''; }
  }
  raw = raw.replace(/\.(pdf|PDF)(\?.*)?$/, '.pdf');
  if (!/\.pdf$/i.test(raw)) raw = `${raw || 'imported'}.pdf`;
  return raw;
}

/**
 * GET /api/import-pdf?url=<http(s) 链接>[&name=...]
 * 把远处的 PDF 抓回来存进 papers/，前端刷新列表就能读。
 * 只认真正的 PDF（校验文件头），网页/登录页一律拒绝。
 */
async function handleImportPdf(res, url) {
  const target = (url.searchParams.get('url') || '').trim();
  if (!target) return sendJson(res, 400, { error: { message: '缺少 url' } });
  if (target.length > 2000) return sendJson(res, 400, { error: { message: 'url 过长' } });

  let u;
  try { u = new URL(target); } catch { return sendJson(res, 400, { error: { message: 'url 格式不对' } }); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return sendJson(res, 400, { error: { message: '只支持 http/https 链接' } });
  }
  if (isPrivateHost(u.hostname)) {
    return sendJson(res, 400, { error: { message: '内网地址不允许导入' } });
  }

  let resp;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60000);
    resp = await fetch(target, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: {
        'User-Agent': SEARCH_UA,
        Accept: 'application/pdf,*/*;q=0.8',
      },
    }).finally(() => clearTimeout(timer));
  } catch (e) {
    return sendJson(res, 502, { error: { message: `下载失败：${e.message}` } });
  }
  if (!resp.ok) {
    return sendJson(res, 502, { error: { message: `对方返回 ${resp.status}，没能拿到 PDF` } });
  }
  const declared = Number(resp.headers.get('content-length') || 0);
  if (declared > MAX_IMPORT) {
    return sendJson(res, 413, { error: { message: `文件太大（${Math.round(declared / 1048576)}MB）` } });
  }

  let body;
  try {
    body = Buffer.from(await resp.arrayBuffer());
  } catch (e) {
    return sendJson(res, 502, { error: { message: `读取内容失败：${e.message}` } });
  }
  if (body.length > MAX_IMPORT) {
    return sendJson(res, 413, { error: { message: `文件太大（${Math.round(body.length / 1048576)}MB）` } });
  }
  if (!body.length) return sendJson(res, 400, { error: { message: '下回来的是空文件' } });
  if (body.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return sendJson(res, 400, { error: { message: '这个链接不是 PDF（可能是个网页，试着直接找 PDF 直链）' } });
  }

  const wanted = sanitizePdfName(url.searchParams.get('name') || guessPdfName(resp.url || target, resp.headers.get('content-disposition')));
  const name = sanitizePdfName(wanted) || 'imported.pdf';

  try {
    const final = await uniquePdfName(name, body.length);
    await fsp.writeFile(path.join(PAPERS_DIR, final), body);
    const st = await fsp.stat(path.join(PAPERS_DIR, final));
    console.log(`[import] ${final} (${Math.round(body.length / 1024)}KB) <- ${target}`);
    return sendJson(res, 200, {
      ok: true,
      name: final,
      size: st.size,
      mtime: st.mtimeMs,
      docId: docIdOf(final),
      url: `/api/pdf?name=${encodeURIComponent(final)}`,
      from: target,
    });
  } catch (e) {
    return sendJson(res, 500, { error: { message: `写入 papers/ 失败：${e.message}` } });
  }
}

/* ----------------------------------------------------------------- upload */

/** 文件名洗净：去掉路径分隔符和控制字符，保证以 .pdf 结尾 */
function sanitizePdfName(name) {
  let n = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim();
  if (!n) return null;
  if (!/\.pdf$/i.test(n)) n += '.pdf';
  const ext = path.extname(n);
  const stem = n.slice(0, n.length - ext.length).slice(0, 140);
  return `${stem || 'uploaded'}${ext}`;
}

/** 同名同大小 → 认为已经导入过，直接复用；否则加 (2)(3) 后缀 */
async function uniquePdfName(base, size) {
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 1; i < 200; i++) {
    const candidate = i === 1 ? base : `${stem} (${i})${ext}`;
    const abs = path.join(PAPERS_DIR, candidate);
    try {
      const st = await fsp.stat(abs);
      if (st.size === size) return candidate;      // 同一份文件，不重复存
    } catch {
      return candidate;                            // 不存在，就用这个名字
    }
  }
  return `${stem}-${Date.now()}${ext}`;
}

async function handleUpload(req, res, url) {
  const name = sanitizePdfName(url.searchParams.get('name'));
  if (!name) return sendJson(res, 400, { error: { message: '文件名不合法' } });

  let body;
  try {
    body = await readBody(req, MAX_UPLOAD);
  } catch (e) {
    return sendJson(res, 413, { error: { message: `${e.message}（上限 ${Math.round(MAX_UPLOAD / 1048576)}MB）` } });
  }
  if (!body.length) return sendJson(res, 400, { error: { message: '空文件' } });
  if (body.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return sendJson(res, 400, { error: { message: '这不是一个 PDF 文件' } });
  }

  try {
    const final = await uniquePdfName(name, body.length);
    await fsp.writeFile(path.join(PAPERS_DIR, final), body);
    const st = await fsp.stat(path.join(PAPERS_DIR, final));
    console.log(`[upload] ${final} (${Math.round(body.length / 1024)}KB)`);
    return sendJson(res, 200, {
      ok: true,
      name: final,
      size: st.size,
      mtime: st.mtimeMs,
      docId: docIdOf(final),
      url: `/api/pdf?name=${encodeURIComponent(final)}`,
    });
  } catch (e) {
    return sendJson(res, 500, { error: { message: `写入 papers/ 失败：${e.message}` } });
  }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const pathname = decodeURIComponent(url.pathname);

  // ---- AI 代理
  if (pathname === '/api/chat') {
    if (req.method !== 'POST') return send(res, 405, 'Method Not Allowed');
    return handleChat(req, res);
  }

  // ---- 论文目录
  if (pathname === '/api/papers') {
    return sendJson(res, 200, { papers: await listPapers(), dir: PAPERS_DIR });
  }

  /**
   * GET /api/open-url?url=<http(s) 链接>
   * 页面里的外链统一走这里交给系统默认浏览器。
   * （桌面版是 WebView2 外壳，`<a target="_blank">` 默认不会有任何反应。）
   */
  if (pathname === '/api/open-url') {
    const target = (url.searchParams.get('url') || '').trim();
    if (!target) return sendJson(res, 400, { error: '缺少 url' });
    if (target.length > 2000) return sendJson(res, 400, { error: 'url 过长' });
    if (!/^https?:\/\//i.test(target)) return sendJson(res, 400, { error: '只允许打开 http/https 链接' });
    openBrowser(target);
    console.log(`[open] 已交给系统浏览器: ${target}`);
    return sendJson(res, 200, { ok: true, url: target });
  }

  if (pathname === '/api/pdf') {
    const abs = safeJoin(PAPERS_DIR, url.searchParams.get('name'));
    if (!abs) return send(res, 400, '非法文件名');
    return servePdf(req, res, abs);
  }

  // ---- 联网搜索
  if (pathname === '/api/web-search') {
    const q = url.searchParams.get('q') || '';
    const n = Math.min(10, Math.max(1, Number(url.searchParams.get('n')) || 6));
    if (!q.trim()) return sendJson(res, 400, { error: { message: '缺少 q' } });
    try {
      return sendJson(res, 200, await webSearch(q, n));
    } catch (e) {
      return sendJson(res, 200, { query: q, provider: '', results: [], error: String(e && e.message) });
    }
  }

  // ---- 导入 PDF：把拖进来的文件存进 papers/，下次打开还在
  if (pathname === '/api/upload') {
    if (req.method !== 'POST') return send(res, 405, 'Method Not Allowed');
    return handleUpload(req, res, url);
  }

  if (pathname === '/api/import-pdf') return handleImportPdf(res, url);

  // ---- 设置
  if (pathname === '/api/config') {
    if (req.method === 'GET') {
      const cfg = { ...DEFAULT_CONFIG, ...(await readDataFile('config.json', {})) };
      // 密钥不回传给前端，前端只需要知道「有没有配」
      return sendJson(res, 200, { ...cfg, apiKey: '', hasApiKey: !!cfg.apiKey });
    }
    if (req.method === 'POST') {
      const patch = await readJsonBody(req);
      const cur = await readDataFile('config.json', {});
      const next = { ...DEFAULT_CONFIG, ...cur, ...patch };
      if (!patch.apiKey) next.apiKey = cur.apiKey || '';
      await writeDataFile('config.json', next);
      return sendJson(res, 200, { ok: true, hasApiKey: !!next.apiKey });
    }
    return send(res, 405, 'Method Not Allowed');
  }

  // ---- 阅读进度 / 上次打开的文件
  if (pathname === '/api/state') {
    if (req.method === 'GET') return sendJson(res, 200, await readDataFile('state.json', {}));
    if (req.method === 'POST') {
      const patch = await readJsonBody(req);
      const cur = await readDataFile('state.json', {});
      await writeDataFile('state.json', { ...cur, ...patch });
      return sendJson(res, 200, { ok: true });
    }
    return send(res, 405, 'Method Not Allowed');
  }

  // ---- 高亮 / 笔记（按文档存）
  if (pathname === '/api/notes') {
    const doc = url.searchParams.get('doc') || 'default';
    const file = `notes-${docIdOf(doc)}.json`;
    if (req.method === 'GET') return sendJson(res, 200, { items: await readDataFile(file, []) });
    if (req.method === 'POST') {
      const payload = await readJsonBody(req);
      await writeDataFile(file, Array.isArray(payload.items) ? payload.items : []);
      return sendJson(res, 200, { ok: true });
    }
    return send(res, 405, 'Method Not Allowed');
  }

  if (pathname === '/api/session') {
    const doc = url.searchParams.get('doc') || 'default';
    const file = `session-${docIdOf(doc)}.json`;
    if (req.method === 'GET') return sendJson(res, 200, await readDataFile(file, { entries: [], history: [], ops: [] }));
    if (req.method === 'POST') {
      const payload = await readJsonBody(req);
      try { await writeDataFile(file, payload); }
      catch (e) { return sendJson(res, 500, { error: { message: `保存阅读会话失败：${e.message}` } }); }
      return sendJson(res, 200, { ok: true });
    }
    return send(res, 405, 'Method Not Allowed');
  }

  if (pathname === '/api/health') return sendJson(res, 200, { ok: true, port: PORT });

  // ---- 参考文献检索：给一条文献条目找它的 PDF / 链接
  if (pathname === '/api/ref-search') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return sendJson(res, 400, { error: { message: '缺少 q' } });
    try {
      const out = await searchReference(q);
      return sendJson(res, 200, out);
    } catch (e) {
      return sendJson(res, 200, { results: [], error: String(e && e.message) });
    }
  }

  // ---- 静态文件
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed');
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const abs = safeJoin(PUBLIC_DIR, rel);
  if (!abs) return send(res, 400, 'Bad path');
  /**
   * 目录索引：`/mobile/` 要落到 `public/mobile/index.html`。
   * 没有这一条的时候，`/mobile/` 会被下面的「单页应用回落」抢走，
   * 直接返回桌面版的 index.html —— 表现就是「请求手机版，拿到的却是桌面版」，
   * 而且它不报错（200 + 正常页面），排查时非常容易被骗（实测踩过：
   * 手机版页面里 document.getElementById('mViewer') 是 null，但没有任何 404）。
   * 这里显式把「以 / 结尾」和「指向真实目录」的路径映射到该目录下的 index.html。
   */
  const dirIndex = (rel === '' || rel.endsWith('/'))
    ? path.join(rel, 'index.html')
    : (fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? path.join(rel, 'index.html') : '');
  if (dirIndex) {
    const idxAbs = safeJoin(PUBLIC_DIR, dirIndex);
    if (idxAbs && fs.existsSync(idxAbs) && fs.statSync(idxAbs).isFile()) {
      const st = fs.statSync(idxAbs);
      res.writeHead(200, {
        'Content-Type': MIME['.html'],
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      return streamFile(res, idxAbs);
    }
  }
  return fsp
    .stat(abs)
    .then((st) => {
      if (st.isDirectory()) throw new Error('dir');
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      streamFile(res, abs);
    })
    .catch(() => {
      // 前端是单页应用：未知路径回落到 index.html
      const index = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(index) && !path.extname(rel)) {
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        return streamFile(res, index);
      }
      send(res, 404, 'Not Found');
    });
}

/* ------------------------------------------------------------------- boot */

/** 启动后自动打开浏览器（设 NO_OPEN=1 可关闭） */
function openBrowser(url) {
  const { spawn } = require('child_process');
  try {
    if (process.platform === 'win32') {
      // 不用 `cmd /c start`：cmd 会把 URL 里的 & 当命令分隔符，
      // 搜索结果链接经常带查询串（?q=a&b=c），会被截断。
      // 优先 rundll32（完全不过 shell），失败再退回 explorer，最后才是 cmd。
      const tries = [
        ['rundll32.exe', ['url.dll,FileProtocolHandler', url]],
        ['explorer.exe', [url]],
        ['cmd', ['/c', 'start', '', `"${url.replace(/"/g, '')}"`]],
      ];
      for (const [exe, args] of tries) {
        try {
          spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
          return;
        } catch { /* 试下一个 */ }
      }
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* 打不开就让用户自己点链接 */ }
}

async function main() {
  await ensureDirs();
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error('[error]', req.method, req.url, e);
      if (!res.headersSent) sendJson(res, 500, { error: { message: String(e && e.message) } });
      else res.end();
    });
  });
  // 兜底：任何漏网的异常都不该让本地服务直接退出
  process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
  process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
  // 用 Node 默认超时即可：requestTimeout 只管「收完请求体」，不会掐断长时间的流式响应，
  // 设成 0 反而会让卡住的连接永远占着不放。
  server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}`;
    console.log('');
    console.log('  📖  论文阅读器已启动');
    console.log(`      打开： ${url}`);
    console.log(`      论文目录： ${PAPERS_DIR}`);
    console.log(`      配置文件： ${path.join(DATA_DIR, 'config.json')}`);
    console.log('      按 Ctrl+C 停止');
    console.log('');
    if (process.env.NO_OPEN !== '1') openBrowser(url);
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error('');
      console.error(`  [!] 端口 ${PORT} 已经被占用了。`);
      console.error('      很可能阅读器已经在跑 —— 直接打开 http://127.0.0.1:8787 看看。');
      console.error(`      想换端口的话：  set PORT=8899 && node server.js`);
      console.error('');
      process.exit(1);
    }
    throw e;
  });
}

main();
