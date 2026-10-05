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
const sec = require('./security');

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
/**
 * 诊断模式（审计 §P2）：只有显式 `PRT_DIAGNOSTICS=1` 才在接口里返回本机绝对路径。
 * 默认关闭 —— `/api/papers` 从前无条件返回 `dir: PAPERS_DIR`，等于把用户的
 * 本机目录结构告诉任何能访问本地服务的页面。
 *
 * 测试 harness 需要它：`test/_env.mjs` 的
 * `assertIsolatedDataDir(resolveDataDir(papers.dir))` 靠这个字段证明「服务确实指向
 * 临时目录」——这是防止测试写坏用户真实书架的安全互锁。所以自己 spawn 隔离服务的
 * 测试套件要在 env 里带上 `PRT_DIAGNOSTICS=1`。
 */
const DIAGNOSTICS = process.env.PRT_DIAGNOSTICS === '1';

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

async function readBody(req, limit = sec.BODY_LIMITS.chat) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    /**
     * 超限时**不能** `req.destroy()`：那会在客户端还没读到响应之前把连接掐掉，
     * 表现成 ECONNRESET / socket hang up，用户只看到「网络错误」而看不到 413。
     * 正确做法是丢掉后续数据（不再累积 → 内存不会涨），把请求读到自然结束，
     * 再把 413 发出去。
     */
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) {
        const err = new Error('请求体过大');
        err.code = 'PAYLOAD_TOO_LARGE';
        err.limit = limit;
        reject(err);
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

async function readJsonBody(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw.length) return {};
  return JSON.parse(raw.toString('utf8'));
}

/**
 * 按接口读 JSON 请求体：超限 / 解析失败分别给出 413 / 400。
 * 返回 null 表示已经回过响应，调用方直接 return。
 * 审计 §P1：超限必须 413，且**一个字都不能写盘**（调用方拿到 null 就结束）。
 */
async function readJsonBodyOrReq(req, res, limit) {
  try {
    return await readJsonBody(req, limit);
  } catch (e) {
    if (e && e.code === 'PAYLOAD_TOO_LARGE') {
      sendJson(res, 413, {
        error: { message: `请求体过大（上限 ${Math.round(limit / 1024)}KB），已拒绝，未写入任何数据` },
      });
      return null;
    }
    sendJson(res, 400, { error: { message: sec.sanitizeMessage(`请求体解析失败: ${e.message}`, '请求体解析失败') } });
    return null;
  }
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

/**
 * 文档 id：论文文件名的稳定短哈希，用于存放进度/笔记/会话。
 *
 * ⚠️ **必须幂等**：`docIdOf(docIdOf(x)) === docIdOf(x)`。
 *
 * 这是一个真 bug 的修复（2026-10）：前端在两处传的 `doc` 参数格式不同 ——
 * 有的地方传文件名（`?open=` 那条路），有的地方传 docId（`state.doc.docId`）。
 * 老实现无条件再哈希一次，于是同一个文档算出两个 key：
 *     docIdOf('multipage-sample.pdf')            = multipage-sample_pdf-afcbb748
 *     docIdOf('multipage-sample_pdf-afcbb748')   = multipage-sample_pdf-afcbb748-2866f44b
 * 会话文件按前者命名、列表按后者去扫 → **永远扫不到，界面一直是「还没有会话」**。
 *
 * 所以：已经长得像 docId 的输入直接原样返回。判定要**严格**，别把正常文件名误判成 id
 * （文件名几乎都带 `.pdf`，而 slug 里不会有点，所以「无扩展名 + slug-十六进制」这个
 * 形状足够安全）。
 */
const DOC_ID_RE = /^(.{1,64})-([0-9a-f]{6,10})$/;
function docIdOf(name) {
  const s = String(name);
  if (DOC_ID_RE.test(s)) return s;          // 已经是 docId → 幂等返回
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  const slug = s.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 48);
  return `${slug}-${h.toString(16)}`;
}

/**
 * 一个 doc 参数可能对应哪些历史 key。
 * 老版本写出的文件用的是「二次哈希」的键，列会话时必须一并认出来，
 * 否则用户升级后原来的会话会"消失"。
 */
function docKeyCandidates(doc) {
  const out = [];
  const push = (v) => { if (v && !out.includes(v)) out.push(v); };
  // ① 新键：幂等 docIdOf（传 docId 会原样返回，传文件名会哈希）
  push(docIdOf(doc));
  // ② 老键：把 doc 当纯字符串再哈希一次（= 老实现眼里"前端传 docId"的那条路）
  const s = String(doc);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  const slug = s.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 48);
  push(`${slug}-${h.toString(16)}`);
  // ③ 连文件名形式也认一下（老前端可能传的是 'xxx.pdf'）
  if (!/\.pdf$/i.test(s)) { push(docIdOf(`${s}.pdf`)); push(docIdOf(s.replace(/-[0-9a-f]{6,10}$/, '.pdf'))); }
  return out;
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
    return sendJson(res, 400, { error: { message: sec.sanitizeMessage(`请求体解析失败: ${e.message}`, '请求体解析失败') } });
  }

  /**
   * 审计 §P0：**只使用已保存配置**里的 baseURL / apiKey / model。
   * 从前这里写的是 `payload.baseURL || stored.baseURL`，于是任何拿到本机 API 调用权的
   * 页面都能把用户的 Key 转发到任意主机、或者让服务端带着 Key 去请求任意 URL。
   * 现在请求体里出现这三个字段一律**忽略**（旧前端还会带，忽略同样安全），
   * 同时在本地诊断日志里记一笔，方便判断是不是有人在试探。
   */
  const forbidden = sec.CHAT_FORBIDDEN.filter((k) => Object.prototype.hasOwnProperty.call(payload, k));
  if (forbidden.length) {
    sec.diag(`/api/chat 请求体里的 ${forbidden.join(', ')} 已忽略（只能来自 data/config.json）`);
  }
  const unknown = Object.keys(payload).filter((k) => !sec.CHAT_FIELDS.has(k) && !sec.CHAT_FORBIDDEN.includes(k));
  if (unknown.length) sec.diag(`/api/chat 忽略未知字段: ${unknown.join(', ')}`);

  const stored = await readDataFile('config.json', {});
  const baseURL = stored.baseURL || DEFAULT_CONFIG.baseURL;
  const apiKey = stored.apiKey || '';
  const model = stored.model || DEFAULT_CONFIG.model;

  let url;
  try {
    url = normalizeChatUrl(baseURL);
  } catch (e) {
    return sendJson(res, 400, { error: { message: e.message } });
  }

  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return sendJson(res, 400, { error: { message: 'messages 不能为空' } });
  }

  /** temperature：必须落在 [0,2]，超范围直接 400（不静默改写用户请求） */
  const temp = sec.pickTemperature(payload.temperature, DEFAULT_CONFIG.temperature);
  if (temp.error) return sendJson(res, 400, { error: { message: temp.error } });

  /** max_tokens：正整数且在上限内 */
  const mt = sec.pickMaxTokens(payload.max_tokens);
  if (mt.error) return sendJson(res, 400, { error: { message: mt.error } });

  /** idleMs：请求体可以缩短看门狗，但同样要夹在范围内 */
  const idleMs = sec.clampNumber(payload.idleMs, sec.LIMITS.idleMs.min, sec.LIMITS.idleMs.max)
    ?? sec.clampNumber(Number(stored.idleMs), sec.LIMITS.idleMs.min, sec.LIMITS.idleMs.max)
    ?? DEFAULT_CONFIG.idleMs;

  const body = {
    model,
    messages: payload.messages,
    stream: payload.stream !== false,
    temperature: temp.value,
  };
  if (mt.value !== null) body.max_tokens = mt.value;

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
    // 审计 §P2：不回显完整上游 URL 和底层网络异常原文，细节只进本地诊断日志
    sec.diag(`连接上游失败 url=${url} err=${e && e.message}`);
    return sendJson(res, 502, {
      error: { message: `连接 API 地址失败：${sec.sanitizeMessage(e && e.message, '网络请求失败')}。请到设置页检查 API 地址 / 网络 / 代理。` },
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
    sec.diag(`上游返回 ${upstream.status}: ${sec.sanitizeMessage(msg, '')}`);
    return sendJson(res, upstream.status, {
      error: { message: sec.sanitizeMessage(msg, `上游返回 ${upstream.status}`) },
    });
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
  // idleMs 已经在上面按 [LIMITS.idleMs] 范围校验过，这里直接用
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
      sec.diag(`读取上游流失败: ${e && e.message}`);
      res.write(`data: ${JSON.stringify({ error: { message: `读取上游流失败：${sec.sanitizeMessage(e && e.message, '网络中断')}` } })}\n\n`);
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
 * IPv4 点分四段 → [a,b,c,d]；不合法的段返回 [256,...]（调用方按「内网」处理）。
 */
function parseIPv4Quad(s) {
  const parts = String(s).split('.');
  if (parts.length !== 4) return null;
  const out = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : 256));
  return out;
}

/**
 * 内网地址不接。这个接口是「让本机去下载一个外部 URL」，
 * 不挡的话就变成一个可被网页利用的内网探测器（SSRF）。
 * 导入论文用到的都是 arXiv / 期刊这类公网地址，挡掉内网不影响正常使用。
 *
 * 注意 `URL.hostname` 对 IPv6 是**带方括号**的（`new URL('http://[::1]/').hostname === '[::1]'`），
 * 而且 IPv4-mapped 形式会被规范化成十六进制（`[::ffff:169.254.169.254]` → `[::ffff:a9fe:a9fe]`），
 * 所以两种写法都要能认出来 —— 两块都是实测发现的真实绕过口子。
 */
function isPrivateHost(hostname) {
  let h = String(hostname || '').toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  // 结尾的点：`http://localhost./` 完全合法，DNS 上等价于 `localhost`（实测解析到 ::1），
  // 但 `h === 'localhost'` / `endsWith('.localhost')` 都拦不住它。
  h = h.replace(/\.+$/, '');
  if (!h) return true;

  // 主机名形态
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')
    || h.endsWith('.home.arpa') || h.endsWith('.lan') || h.endsWith('.intranet')) return true;

  // IPv6（只在确实是 IPv6 字面量时才按前缀判，避免 `fc` / `fd` 开头的主机名被误伤）
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (mappedHex) {
      const v = (parseInt(mappedHex[1], 16) * 65536) + parseInt(mappedHex[2], 16);
      const quad = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
      return isPrivateIPv4(quad);
    }
    const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
    if (mappedDotted) return isPrivateIPv4(parseIPv4Quad(mappedDotted[1]));
    if (h.startsWith('fe80:') || h.startsWith('fec0:')) return true;   // 链路本地 / 站点本地
    if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true;                    // fc00::/7 唯一本地地址
    if (h.startsWith('ff')) return true;                                // 组播
    if (/^2001:0?db8:/.test(h)) return true;                            // 文档用网段
    if (/^64:ff9b:/.test(h) || /^2002:/.test(h)) return true;           // NAT64 / 6to4（可能映射到内网）
    return false;
  }

  // IPv4
  const quad = parseIPv4Quad(h);
  if (!quad) return false;
  return isPrivateIPv4(quad);
}

/** [a,b,c,d] 是不是回环 / 私网 / 链路本地 / 保留地址 */
function isPrivateIPv4(quad) {
  if (!quad) return true;
  if (quad.some((n) => n > 255)) return true;        // 不合法的字面量一律当内网（宁严勿松）
  const [a, b] = quad;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;           // 链路本地 + 云元数据 169.254.169.254
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;   // 基准测试网段
  if (a >= 224) return true;                          // 组播 / 保留
  return false;
}

/**
 * 解析一个「允许让本机去下载」的 URL。
 * 审计 §P1：协议、凭证、控制字符都要检查；`checkPrivate` 控制是否做内网检查。
 *
 * 为什么内网检查要能关掉：**第一跳**的内网检查由调用方用原始错误码/文案做
 * （`handleImportPdf` 顶部的 `checkFetchUrl`，回 400「内网地址不允许导入」），
 * 而用户自己指定的地址本来就是「他想下载的那个地址」——本机 dev server 也在这个
 * 检查之外。真正要挡的是**重定向**：所以第 2 跳起每一跳都必须做内网检查。
 * 返回 { url } 或 { error }。
 */
function checkFetchUrl(raw, checkPrivate = true) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    return { error: 'url 格式不对' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { error: '只支持 http/https 链接' };
  }
  if (u.username || u.password) {
    return { error: 'url 不允许携带用户名密码' };
  }
  if (checkPrivate && isPrivateHost(u.hostname)) {
    return { error: '内网地址不允许导入' };
  }
  return { url: u };
}

/** 重定向跳数上限（审计 §P1：例如最多 3 跳） */
const MAX_REDIRECTS = 3;

/** ReadableStream → Buffer，边读边计数，超过 max 立刻取消（避免超大响应吃内存） */
async function readCapped(body, max) {
  if (!body) return { buffer: Buffer.alloc(0) };
  const chunks = [];
  let size = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.length) continue;
      size += value.length;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return { over: size };
      }
      chunks.push(Buffer.from(value));
    }
  } catch (e) {
    try { await reader.cancel(); } catch { /* ignore */ }
    return { error: e };
  }
  return { buffer: Buffer.concat(chunks) };
}

/**
 * 手动跟随重定向（最多 MAX_REDIRECTS 跳）。
 *
 * 从前这里是 `fetch(target, { redirect: 'follow' })`：只检查了**初始** URL 的主机，
 * 于是一个公网地址只要 302 到 http://127.0.0.1:… 或 http://169.254.169.254/ 就能
 * 绕过全部内网检查（审计 §P1）。现在每一跳都重新做协议 + 内网检查。
 *
 * `checkPrivateOnFirstHop`：默认 true（直连地址照旧立刻被拒）。
 * 传 false 只有一种场合 —— 调用方已经自己检查过第一跳的内网属性，
 * 想让**重定向目标**才走内网判定（测试用的本机重定向器就是这种：
 * `handleImportPdf` 顶层先用 `checkFetchUrl(target)` 做一次直连判定，
 * 把结果通过这个参数透传下来）。
 *
 * 返回 { resp, finalUrl } 或 { error, status? }。
 */
async function fetchWithSafety(rawTarget, { headers, timeoutMs = 60000, checkPrivateOnFirstHop = true } = {}) {
  let current = rawTarget;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checkPrivate = hop === 0 ? checkPrivateOnFirstHop : true;
    const checked = checkFetchUrl(current, checkPrivate);
    if (checked.error) return { error: checked.error, status: 400 };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let resp;
    try {
      resp = await fetch(checked.url.href, {
        redirect: 'manual',
        signal: ctl.signal,
        headers,
      });
    } catch (e) {
      return { error: `下载失败：${sec.sanitizeMessage(e && e.message, '网络请求失败')}`, status: 502 };
    } finally {
      clearTimeout(timer);
    }

    // fetch 的 redirect:'manual' 在浏览器里返回 opaque-redirect，在 Node 里就是普通 3xx 响应
    const loc = resp.status >= 300 && resp.status < 400 ? resp.headers.get('location') : null;
    if (!loc) {
      if (resp.status >= 300 && resp.status < 400) {
        return { error: '对方返回了一个没有 Location 的跳转', status: 502 };
      }
      return { resp, finalUrl: checked.url.href };
    }
    // 3xx：**先丢掉这次响应体**，再重新走一遍协议/主机检查
    try { await resp.body?.cancel(); } catch { /* ignore */ }
    let next;
    try {
      next = new URL(loc, checked.url).href;   // 相对 Location 也要支持
    } catch {
      return { error: '对方返回的跳转地址不合法', status: 502 };
    }
    if (hop === MAX_REDIRECTS) {
      return { error: `跳转次数过多（超过 ${MAX_REDIRECTS} 次），已停止`, status: 502 };
    }
    sec.diag(`/api/import-pdf 跟随跳转 → ${next}`);
    current = next;
  }
  return { error: '跳转次数过多，已停止', status: 502 };
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

  // 初始 URL 先检查一次（错误码/文案与从前一致），随后**每一跳**都会再检查一次。
  // 这里直连就已经挡掉内网地址（不发出任何请求）；重定向目标由 fetchWithSafety
  // 逐跳检查 —— 所以把「第一跳已检查过」透传下去，避免直连日志里出现两条同样的判定。
  const first = checkFetchUrl(target);
  if (first.error) return sendJson(res, 400, { error: { message: first.error } });

  const got = await fetchWithSafety(target, {
    checkPrivateOnFirstHop: false,
    headers: {
      'User-Agent': SEARCH_UA,
      Accept: 'application/pdf,*/*;q=0.8',
    },
  });
  if (got.error) {
    if (got.status && got.status !== 502) return sendJson(res, got.status, { error: { message: got.error } });
    sec.diag(`/api/import-pdf 失败 target=${sec.scrubText(target)} err=${got.error}`);
    return sendJson(res, 502, { error: { message: got.error } });
  }
  const resp = got.resp;

  if (!resp.ok) {
    return sendJson(res, 502, { error: { message: `对方返回 ${resp.status}，没能拿到 PDF` } });
  }
  const declared = Number(resp.headers.get('content-length') || 0);
  if (declared > MAX_IMPORT) {
    return sendJson(res, 413, { error: { message: `文件太大（${Math.round(declared / 1048576)}MB）` } });
  }

  // 边读边计数：没有 Content-Length（chunked）时也不能让内存无上限地涨
  const read = await readCapped(resp.body, MAX_IMPORT);
  if (read.over) {
    return sendJson(res, 413, { error: { message: `文件太大（超过 ${Math.round(MAX_IMPORT / 1048576)}MB）` } });
  }
  if (read.error) {
    sec.diag(`/api/import-pdf 读取内容失败: ${read.error && read.error.message}`);
    return sendJson(res, 502, { error: { message: `读取内容失败：${sec.sanitizeMessage(read.error && read.error.message, '网络中断')}` } });
  }
  const body = read.buffer;
  if (body.length > MAX_IMPORT) {
    return sendJson(res, 413, { error: { message: `文件太大（${Math.round(body.length / 1048576)}MB）` } });
  }
  if (!body.length) return sendJson(res, 400, { error: { message: '下回来的是空文件' } });
  if (body.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return sendJson(res, 400, { error: { message: '这个链接不是 PDF（可能是个网页，试着直接找 PDF 直链）' } });
  }

  const wanted = sanitizePdfName(url.searchParams.get('name') || guessPdfName(resp.url || got.finalUrl || target, resp.headers.get('content-disposition')));
  const name = sanitizePdfName(wanted) || 'imported.pdf';

  try {
    const final = await uniquePdfName(name, body.length);
    await fsp.writeFile(path.join(PAPERS_DIR, final), body);
    const st = await fsp.stat(path.join(PAPERS_DIR, final));
    // 日志里不打印完整 URL 的查询串（可能带 token / 签名），只留主机 + 文件名
    console.log(`[import] ${final} (${Math.round(body.length / 1024)}KB) <- ${hostLabel(got.finalUrl || target)}`);
    return sendJson(res, 200, {
      ok: true,
      name: final,
      size: st.size,
      mtime: st.mtimeMs,
      docId: docIdOf(final),
      url: `/api/pdf?name=${encodeURIComponent(final)}`,
    });
  } catch (e) {
    sec.diag(`写入 papers/ 失败: ${e && e.message}`);
    return sendJson(res, 500, { error: { message: '写入 papers/ 失败：请检查磁盘空间与目录权限' } });
  }
}

/** 日志里用的「主机名」标签：去掉 path / query，避免把签名或 token 写进日志 */
function hostLabel(rawUrl) {
  try {
    return new URL(rawUrl).host;
  } catch {
    return 'unknown-host';
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
    if (e && e.code === 'PAYLOAD_TOO_LARGE') {
      return sendJson(res, 413, { error: { message: `请求体过大（上限 ${Math.round(MAX_UPLOAD / 1048576)}MB），已拒绝，未写入任何数据` } });
    }
    return sendJson(res, 400, { error: { message: '请求体读取失败' } });
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
    // 审计 §P2：磁盘错误里带完整路径，只进本地诊断日志
    sec.diag(`写入 papers/ 失败: ${e && e.message}`);
    return sendJson(res, 500, { error: { message: '写入 papers/ 失败：请检查磁盘空间与目录权限' } });
  }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const pathname = decodeURIComponent(url.pathname);

  /**
   * 审计 §P0：所有 /api/* 都必须带自定义请求头。
   *
   * 校验在**最前面**，早于任何读盘 / 写盘 / 出网动作 —— 401/403 不会写入任何用户数据。
   * 例外只有 `/api/pdf` 的 GET/HEAD（浏览器子资源加载拿不到自定义头），
   * 详见 security.js 的 authorized()。
   */
  if (pathname.startsWith('/api/') && sec.isEnforced()) {
    if (!sec.authorized(req, pathname)) {
      return sec.unauthorized(res, sendJson);
    }
    // Origin / Referer 白名单只是附加防线，token 才是主防线（审计 §P0 第 4 条）
    if (!sec.originAllowed(req)) {
      return sendJson(res, 403, { error: { message: '拒绝跨站请求：Origin 不在允许列表内' } });
    }
  }

  // ---- AI 代理
  if (pathname === '/api/chat') {
    if (req.method !== 'POST') return send(res, 405, 'Method Not Allowed');
    return handleChat(req, res);
  }

  // ---- 论文目录
  if (pathname === '/api/papers') {
    const body = { papers: await listPapers() };
    // 审计 §P2：默认不返回本机绝对路径；只有显式开启诊断才给
    if (DIAGNOSTICS) body.dir = PAPERS_DIR;
    return sendJson(res, 200, body);
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
    // 日志只留主机名：外链查询串里可能带签名 / 会话标识
    console.log(`[open] 已交给系统浏览器: ${hostLabel(target)}`);
    return sendJson(res, 200, { ok: true });
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
      sec.diag(`/api/web-search 失败: ${e && e.message}`);
      return sendJson(res, 200, { query: q, provider: '', results: [], error: '搜索失败（网络或限流），稍后再试' });
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
      // 审计 §P1：1MB 上限；超限直接 413，绝不写盘
      const raw = await readJsonBodyOrReq(req, res, sec.BODY_LIMITS.config);
      if (raw === null) return undefined;
      // 审计 §P1：严格字段白名单 + 范围限制，未知字段忽略
      const { patch, ignored, capped } = sec.sanitizeConfigPatch(raw);
      if (ignored.length) sec.diag(`/api/config 忽略字段: ${ignored.join(', ')}`);
      /**
       * 超长字段**返回 400，绝不截断保存**（审计 §验收：「超限返回 413/400，
       * 不截断后静默保存」）。从前一个 5000 字的 model 会被悄悄存成 256 字、
       * 接口还回 200 —— 用户以为保存成功了，设置其实已经被改坏。
       */
      if (capped.length) {
        const detail = capped.map((c) => `${c.field}（上限 ${c.limit} 字符）`).join('、');
        return sendJson(res, 400, { error: { message: `字段超长：${detail}。请缩短后重试（未保存任何改动）` } });
      }
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
      // 审计 §P1：state < 1MB；超限 413，旧的 state.json 原样保留
      const patch = await readJsonBodyOrReq(req, res, sec.BODY_LIMITS.state);
      if (patch === null) return undefined;
      const cur = await readDataFile('state.json', {});
      await writeDataFile('state.json', { ...cur, ...patch });
      return sendJson(res, 200, { ok: true });
    }
    /**
     * DELETE /api/state?doc=<docId> —— 首页的「移除最近记录」。
     *
     * 只从 `docs` 里删掉这一条阅读记录；如果 `lastDoc` 正是它，一并清空那三个
     * 「上次打开」字段。**绝不删除 papers/ 里的文件** —— 用户看到的文案是
     * 「移除最近记录（文件还在 papers/）」，语义必须与之一致。
     *
     * 为什么要一个独立的动词、而不是让前端把 docs[docId] 置成 undefined 再整体 POST：
     * `POST /api/state` 是**浅合并**（{...cur, ...patch}），undefined 根本不会真的删键，
     * 要支持它就得给 POST 加深合并语义 —— 那反而更容易写坏旧数据。独立动词也更好限制范围。
     */
    if (req.method === 'DELETE') {
      const doc = url.searchParams.get('doc') || '';
      if (!doc) return sendJson(res, 400, { error: { message: '缺少 doc' } });
      const cur = await readDataFile('state.json', {});
      const docs = { ...(cur.docs || {}) };
      const existed = Object.prototype.hasOwnProperty.call(docs, doc);
      delete docs[doc];
      const next = { ...cur, docs };
      if (cur.lastDoc === doc) {
        next.lastDoc = null;
        next.lastUrl = null;
        next.lastName = null;
      }
      await writeDataFile('state.json', next);
      return sendJson(res, 200, { ok: true, removed: existed });
    }
    return send(res, 405, 'Method Not Allowed');
  }

  // ---- 高亮 / 笔记（按文档存）
  if (pathname === '/api/notes') {
    const doc = url.searchParams.get('doc') || 'default';
    const file = `notes-${docIdOf(doc)}.json`;
    if (req.method === 'GET') return sendJson(res, 200, { items: await readDataFile(file, []) });
    if (req.method === 'POST') {
      // 审计 §P1：条目数 + 总字符数 + 请求体三重上限
      const payload = await readJsonBodyOrReq(req, res, sec.BODY_LIMITS.notes);
      if (payload === null) return undefined;
      const items = Array.isArray(payload.items) ? payload.items : [];
      const bad = sec.checkNotes(items);
      if (bad) return sendJson(res, 413, { error: { message: bad } });
      await writeDataFile(file, items);
      return sendJson(res, 200, { ok: true });
    }
    return send(res, 405, 'Method Not Allowed');
  }

  /**
   * /api/session —— 一篇论文的对话。
   *
   * 2026-10 起支持**多会话**（用户口径：「问答是不是要做多对话分对话」→ 会话列表 + 新建 + 切换）。
   * 存储布局（**向后兼容**，老文件不动也不改名）：
   *
   *   老： session-<docId>.json                       ← 单会话时代的文件，仍然照读照写
   *   新： session-<docId>-<sid>.json                 ← 每个会话一个文件，sid 由前端生成
   *
   * 不传 `sid` 时行为与以前**完全一致**（读/写 `session-<docId>.json`）——
   * 这样即使前端没升级、或者有老书签，也不会读坏数据。
   * 传了 `sid` 才走新的一份文件。老文件由前端在"第一次新建会话"时当作默认会话接管。
   */
  if (pathname === '/api/session') {
    const doc = url.searchParams.get('doc') || 'default';
    const sid = (url.searchParams.get('sid') || '').replace(/[^\w-]/g, '').slice(0, 40);
    const docKey = docIdOf(doc);
    const file = sid ? `session-${docKey}-${sid}.json` : `session-${docKey}.json`;
    if (req.method === 'GET') return sendJson(res, 200, await readDataFile(file, { entries: [], history: [], ops: [] }));
    if (req.method === 'POST') {
      // 审计 §P1：条目数 + 总字符数 + 附件元数据大小
      const payload = await readJsonBodyOrReq(req, res, sec.BODY_LIMITS.session);
      if (payload === null) return undefined;
      const bad = sec.checkSession(payload);
      if (bad) return sendJson(res, 413, { error: { message: bad } });
      try { await writeDataFile(file, payload); }
      catch (e) {
        sec.diag(`保存阅读会话失败: ${e && e.message}`);
        return sendJson(res, 500, { error: { message: '保存阅读会话失败，请重试' } });
      }
      return sendJson(res, 200, { ok: true });
    }
    return send(res, 405, 'Method Not Allowed');
  }

  /**
   * GET /api/sessions?doc=<doc> —— 这篇论文的会话列表（2026-10 多会话）。
   *
   * 只回**元信息**（sid / 条数 / 最后一条摘要 / 更新时间），不回正文 ——
   * 会话多的时候列表接口不该把每一份正文都读出来。
   * 老的单会话文件以 sid='' 出现在列表里（前端把它当"默认会话"）。
   */
  if (pathname === '/api/sessions') {
    const doc = url.searchParams.get('doc') || 'default';
    const keys = docKeyCandidates(doc);
    const fileFor = (key, sid) => (sid ? `session-${key}-${sid}.json` : `session-${key}.json`);
    let names = [];
    try { names = await fsp.readdir(DATA_DIR); } catch { names = []; }
    const out = [];
    const seen = new Set();
    const describe = async (fileName, sid) => {
      if (seen.has(fileName)) return;
      seen.add(fileName);
      const data = await readDataFile(fileName, null);
      if (!data || typeof data !== 'object') return;
      const entries = Array.isArray(data.entries) ? data.entries : [];
      const firstUser = entries.find((e) => e && e.kind === 'user');
      const lastText = [...entries].reverse().find((e) => e && typeof e.text === 'string' && e.text.trim());
      let mtime = 0;
      try { mtime = (await fsp.stat(path.join(DATA_DIR, fileName))).mtimeMs; } catch { /* 忽略 */ }
      out.push({
        sid,
        count: entries.length,
        title: String((firstUser && firstUser.text) || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        preview: String((lastText && lastText.text) || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        updatedAt: Number(data.updatedAt) || mtime || 0,
      });
    };
    // 对每一个候选 key：老的单会话文件 + 该 key 下的所有 sid 文件
    for (const key of keys) {
      if (names.includes(fileFor(key, ''))) await describe(fileFor(key, ''), '');
      const prefix = `session-${key}-`;
      for (const name of names) {
        if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
        await describe(name, name.slice(prefix.length, -'.json'.length));
      }
    }
    out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return sendJson(res, 200, { sessions: out });
  }

  /** DELETE /api/session?doc=<doc>&sid=<sid> —— 删掉一个会话文件（不碰论文本身） */
  if (pathname === '/api/session' && req.method === 'DELETE') {
    const doc = url.searchParams.get('doc') || 'default';
    const sid = (url.searchParams.get('sid') || '').replace(/[^\w-]/g, '').slice(0, 40);
    const docKey = docIdOf(doc);
    const file = sid ? `session-${docKey}-${sid}.json` : `session-${docKey}.json`;
    try { await fsp.rm(path.join(DATA_DIR, file), { force: true }); }
    catch (e) { return sendJson(res, 500, { error: { message: `删除会话失败：${e && e.message}` } }); }
    return sendJson(res, 200, { ok: true });
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
      sec.diag(`/api/ref-search 失败: ${e && e.message}`);
      return sendJson(res, 200, { results: [], error: '文献检索失败（网络或限流），稍后再试' });
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
      return serveHtml(req, res, idxAbs);
    }
  }
  return fsp
    .stat(abs)
    .then((st) => {
      if (st.isDirectory()) throw new Error('dir');
      // 应用自己的页面：注入 token（审计 §P0 第 2 条：只注入本应用页面）
      if (path.extname(abs).toLowerCase() === '.html') {
        return serveHtml(req, res, abs);
      }
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
        return serveHtml(req, res, index);
      }
      send(res, 404, 'Not Found');
    });
}

/* --------------------------------------------------------- 页面 token 注入 */

/**
 * 把 session token 注入本应用自己的 HTML 页面（审计 §P0 第 2 条）。
 *
 * 注入三样东西：
 *   1. `<meta name="prt-token" content="...">`  —— 供前端读取
 *   2. 一段内联脚本：定义 `window.__PRT_TOKEN__` 和 `window.apiFetch()`，
 *      并在 `document` 上装一个捕获阶段的 fetch 补丁 —— 页面里**所有**
 *      fetch('/api/...') 自动带上 `X-PRT-Token`，前端不用改 20 处调用点。
 *   3. `Set-Cookie: prt_session=...`（HttpOnly + SameSite=Strict）—— 只为了让
 *      `/api/pdf` 这种「浏览器子资源加载」也能通过校验（它无法带自定义头）。
 *
 * 注入是「加法」：就算 public/ 那边的 index.html 完全不认识 token，页面照样能跑，
 * 只是 `window.apiFetch` 不存在而已。
 * token 只出现在响应体与响应头里，**不进日志、不进错误信息**。
 *
 * 占位符刻意用 `@@PRT_TOKEN@@` 而不是 `__PRT_TOKEN__`：后者是**属性名**的一部分
 * （`window.__PRT_TOKEN__`），用同一个串做全局替换会把属性名也换成 `window."token"`，
 * 直接产出语法错误 —— 实测被 test/zoom.mjs 的「没有未捕获的页面异常」抓出来过。
 */
const TOKEN_SNIPPET = `<!-- prt-auth: 本地 API 令牌（勿外传，刷新即失效） -->
<meta name="prt-token" content="@@PRT_TOKEN@@" />
<script>
(function () {
  var T = "@@PRT_TOKEN@@";
  var H = "x-prt-token";
  try { Object.defineProperty(window, "__PRT_TOKEN__", { value: T, enumerable: false, configurable: false, writable: false }); }
  catch (e) { window.__PRT_TOKEN__ = T; }
  function withToken(input, init) {
    var url = (typeof input === "string") ? input : (input && input.url) || "";
    if (url.indexOf("/api/") !== 0 && url.indexOf(location.origin + "/api/") !== 0) return init;
    var next = Object.assign({}, init || {});
    var h = new Headers((init && init.headers) || (typeof input !== "string" && input && input.headers) || {});
    if (!h.has(H)) h.set(H, T);
    next.headers = h;
    return next;
  }
  var native = window.fetch ? window.fetch.bind(window) : null;
  if (native) {
    window.fetch = function (input, init) { return native(input, withToken(input, init)); };
  }
  window.apiFetch = function (input, init) { return window.fetch(input, init); };
  document.addEventListener("DOMContentLoaded", function () {
    var m = document.querySelector('meta[name="prt-token"]');
    if (m && m.content !== T) m.content = T;
  });
})();
</script>
`;

/** 注入点：`<head>` 之后（越早越好，必须在任何 module 脚本之前） */
function injectToken(html) {
  const snippet = TOKEN_SNIPPET.replace(/@@PRT_TOKEN@@/g, sec.getToken());
  const m = /<head[^>]*>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + '\n' + snippet + html.slice(m.index + m[0].length);
  return snippet + html;
}

/** 返回注入了 token 的 HTML（Content-Length 按注入后的字节数算） */
function serveHtml(req, res, absPath) {
  let html;
  try {
    html = fs.readFileSync(absPath, 'utf8');
  } catch {
    return send(res, 404, 'Not Found');
  }
  const out = Buffer.from(injectToken(html), 'utf8');
  res.writeHead(200, {
    'Content-Type': MIME['.html'],
    'Content-Length': out.length,
    'Cache-Control': 'no-cache',
    // 子资源通道：/api/pdf 的 GET/HEAD 允许用它替代自定义头
    'Set-Cookie': sec.sessionCookieHeader(),
  });
  if (req.method === 'HEAD') return res.end();
  res.end(out);
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
      // 审计 §P2：未处理的异常里可能带本机路径 / 上游 URL，细节只进本地诊断日志
      sec.diag(`未处理异常 ${req.method} ${req.url}: ${e && e.stack ? e.stack : e}`);
      if (!res.headersSent) sendJson(res, 500, { error: { message: '服务器内部错误，请重试' } });
      else res.end();
    });
  });
  // 兜底：任何漏网的异常都不该让本地服务直接退出
  process.on('uncaughtException', (e) => sec.diag(`uncaughtException: ${e && e.stack ? e.stack : e}`));
  process.on('unhandledRejection', (e) => sec.diag(`unhandledRejection: ${e && e.stack ? e.stack : e}`));
  // 用 Node 默认超时即可：requestTimeout 只管「收完请求体」，不会掐断长时间的流式响应，
  // 设成 0 反而会让卡住的连接永远占着不放。
  server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}`;
    console.log('');
    console.log('  📖  论文阅读器已启动');
    console.log(`      打开： ${url}`);
    console.log(`      论文目录： ${PAPERS_DIR}`);
    console.log(`      配置文件： ${path.join(DATA_DIR, 'config.json')}`);
    // 审计 §P0：明确告诉操作者当前认证状态（**绝不打印 token 本身**）
    console.log(`      API 令牌校验： ${sec.isEnforced() ? '已启用（所有 /api/* 需带 X-PRT-Token；/api/health 免认证）' : '已关闭（PRT_REQUIRE_TOKEN=0）'}`);
    /**
     * 机器可读的 token 行：给「自己 spawn 隔离服务」的测试套件用。
     * 只此一行，且 PRT_API_TOKEN（调用方已知）或 PRT_QUIET_TOKEN=1（交付版）时不打印。
     */
    const announce = sec.tokenAnnouncement();
    if (announce) console.log(announce);
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

/**
 * 只在**直接执行**时启动服务。
 *
 * 被 `require()` 时不启动 —— 否则 test/artifacts 下的单元脚本一 require 就会去
 * `listen(PORT)`，而默认 PORT 是 8787（用户真机安装版的端口）。实测踩过：
 * require 一下就会打印「端口 8787 已经被占用了」，等于平白去撞用户的线上实例。
 */
if (require.main === module) {
  main();
}

/**
 * 自检出口：给 test/artifacts 下的单元脚本用。
 * 放在文件末尾，避免在 `const MAX_REDIRECTS` 初始化之前取它的值。
 */
module.exports.__test = { isPrivateHost, isPrivateIPv4, checkFetchUrl, MAX_REDIRECTS };
