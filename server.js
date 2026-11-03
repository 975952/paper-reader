#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const sec = require('./security');
const modelProfiles = require('./model-profiles');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PAPERS_DIR = process.env.PRT_PAPERS_DIR || path.join(ROOT, 'papers');
const DATA_DIR = process.env.PRT_DATA_DIR || path.join(ROOT, 'data');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
/** 导入 PDF 的大小上限 */
const MAX_UPLOAD = 256 * 1024 * 1024;
/**
 * 单张截图附件的上限（POST /api/attachment）。
 * 与 security.js 的 BODY_LIMITS.attachment、Rust 的 limits::BODY_ATTACHMENT 三处一致。
 * 图片是单独存的（data/attachments/），不进会话 JSON，所以这个上限只约束单张图。
 */
const ATTACHMENT_LIMIT = 8 * 1024 * 1024;
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
 * 审计 §P1：超限必须 413，且一个字都不能写盘（调用方拿到 null 就结束）。
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

const DOC_ID_RE = /^(.{1,64})-([0-9a-f]{6,10})$/;
function docIdOf(name) {
  const s = String(name);
  if (DOC_ID_RE.test(s)) return s;          // 已经是 docId → 幂等返回
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  const slug = s.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 48);
  return `${slug}-${h.toString(16)}`;
}

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
let profileWriteChain = Promise.resolve();
/** 串行化写盘，避免并发请求交叉写坏 JSON */
function writeDataFile(name, obj) {
  // 注意先 catch：否则一次写失败会让整条 Promise 链永久处于 rejected 状态，
  // 之后所有的保存（设置/进度/笔记）都会静默失效
  writeChain = writeChain.catch(() => {}).then(async () => {
    const target = path.join(DATA_DIR, name);
    const tmp = `${target}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
    // Windows 上目标文件可能正被另一个请求读取（EPERM/EBUSY），rename 偶发失败。
    // 这里退避重试几次，避免「拖动排序保存失败」这种假故障（用户实测过）。
    let lastErr = null;
    for (let i = 0; i < 12; i++) {
      try {
        await fsp.rename(tmp, target);
        return;
      } catch (e) {
        lastErr = e;
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) break;
        await new Promise((r) => setTimeout(r, 25 + i * 15));
      }
    }
    try { await fsp.unlink(tmp); } catch { /* ignore */ }
    throw lastErr || new Error('writeDataFile failed');
  });
  return writeChain;
}

/* --------------------------------------------------- 图片附件（单独存） */

const ATTACHMENT_EXTS = ['png', 'jpg', 'webp'];
const ATTACHMENT_ID_RE = /^[0-9a-f]{32}$/;

/** 会话键：与会话文件名共用 docIdOf(doc)（+ sid），不许带路径分隔符 */
function attachmentSessionKey(doc, sid) {
  const key = docIdOf(doc);
  const safeSid = String(sid || '').replace(/[^\w-]/g, '').slice(0, 40);
  return safeSid ? `${key}-${safeSid}` : key;
}
function attachmentDir(doc, sid) {
  return path.join(DATA_DIR, 'attachments', attachmentSessionKey(doc, sid));
}

/** 只看文件头判断图片类型（扩展名/Content-Type 都不可信；只接受截图会用的三种） */
function sniffImageExt(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF'
    && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return '';
}

/** 从会话 payload 里收集所有还被引用的附件 id（用户条目的 shots[] + retry 里的图片附件） */
function collectAttachmentIds(payload) {
  const ids = new Set();
  const take = (v) => { if (typeof v === 'string' && ATTACHMENT_ID_RE.test(v)) ids.add(v); };
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  for (const e of entries) {
    if (Array.isArray(e?.shots)) for (const s of e.shots) take(s?.id);
    const atts = e?.retry?.attachments;
    if (Array.isArray(atts)) for (const a of atts) if (a?.kind === 'image') take(a?.id);
  }
  return ids;
}

/** 会话保存成功之后的 GC：删掉本会话目录里不再被 payload 引用的图（失败不报错，下次再清） */
async function pruneAttachments(doc, sid, payload) {
  const dir = attachmentDir(doc, sid);
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return; }
  const alive = collectAttachmentIds(payload);
  await Promise.all(names.map(async (name) => {
    const m = /^([0-9a-f]{32})\.(png|jpg|webp)$/.exec(name);
    if (!m || alive.has(m[1])) return;
    try { await fsp.rm(path.join(dir, name), { force: true }); } catch { /* 下次保存再清 */ }
  }));
  // 空目录也收掉：清空会话之后 data/attachments/ 下不留一堆空文件夹
  try {
    const left = await fsp.readdir(dir);
    if (!left.length) await fsp.rmdir(dir);
  } catch { /* 忽略（目录可能已经不在了） */ }
}

/** 删掉一个会话的整个附件目录（删除会话时用） */
async function removeAttachmentDir(doc, sid) {
  try { await fsp.rm(attachmentDir(doc, sid), { recursive: true, force: true }); } catch { /* 忽略 */ }
}

async function handleAttachment(req, res, url) {
  const doc = url.searchParams.get('doc') || 'default';
  const sid = url.searchParams.get('sid') || '';
  if (req.method === 'POST') {
    let body;
    try {
      body = await readBody(req, ATTACHMENT_LIMIT);
    } catch (e) {
      if (e && e.code === 'PAYLOAD_TOO_LARGE') {
        return sendJson(res, 413, { error: { message: `图片过大（上限 ${Math.round(ATTACHMENT_LIMIT / 1048576)}MB）` } });
      }
      return sendJson(res, 400, { error: { message: '图片读取失败' } });
    }
    const ext = sniffImageExt(body);
    if (!ext) return sendJson(res, 400, { error: { message: '只支持 PNG / JPEG / WebP 截图' } });
    const id = crypto.randomBytes(16).toString('hex');
    try {
      const dir = attachmentDir(doc, sid);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, `${id}.${ext}`), body);
    } catch (e) {
      sec.diag(`保存截图附件失败: ${e && e.message}`);
      return sendJson(res, 500, { error: { message: '保存截图失败（磁盘空间或目录权限）' } });
    }
    return sendJson(res, 200, { ok: true, id, mime: MIME[`.${ext}`] || 'application/octet-stream' });
  }
  if (req.method === 'GET') {
    const id = String(url.searchParams.get('id') || '');
    if (!ATTACHMENT_ID_RE.test(id)) return sendJson(res, 400, { error: { message: '附件 id 不合法' } });
    const dir = attachmentDir(doc, sid);
    for (const ext of ATTACHMENT_EXTS) {
      const abs = path.join(dir, `${id}.${ext}`);
      let st;
      try { st = await fsp.stat(abs); } catch { continue; }
      if (!st.isFile()) continue;
      try {
        const bytes = await fsp.readFile(abs);
        return send(res, 200, bytes, { 'Content-Type': MIME[`.${ext}`] || 'application/octet-stream', 'Content-Length': String(bytes.length) });
      } catch {
        return sendJson(res, 500, { error: { message: '读取截图片失败' } });
      }
    }
    return sendJson(res, 404, { error: { message: '附件不存在（可能已被清理）' } });
  }
  return send(res, 405, 'Method Not Allowed');
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
  // 用户手写的长期记忆（对应 Codex 的全局 AGENTS.md）：只进 prompt，不当论文证据
  longTermMemory: '',
};

/* ---------------------------------------------------------------- papers */

const PAPER_ORDER_FILE = 'papers-order.json';

async function readPaperOrder() {
  const cur = await readDataFile(PAPER_ORDER_FILE, {});
  if (!Array.isArray(cur?.order)) return [];
  return cur.order.filter((n) => typeof n === 'string' && n);
}

async function writePaperOrder(order) {
  await writeDataFile(PAPER_ORDER_FILE, { order });
}

/** 校验前端传来的顺序数组：收 papers/ 里合法相对路径（根 PDF、文件夹、夹内 PDF）。
 *  允许 '/'（文件夹层级），拒绝 \、控制符、..、隐藏路径段。 */
function sanitizePaperOrder(raw) {
  if (!raw || !Array.isArray(raw.order)) return null;
  const out = [];
  const seen = new Set();
  for (const v of raw.order) {
    if (typeof v !== 'string') continue;
    const p = v.trim();
    if (!p || p.length > 200) continue;
    if (/\\|\u0000|\.\.|(^|\/)\./.test(p)) continue;
    if (p.includes('/') && (p.startsWith('/') || p.endsWith('/'))) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= 5000) break;
  }
  return out;
}

/** 用户传来的相对路径规范化：\ 归一为 /、去前导 /、去首尾空白（安全边界由 safeJoin 兜底） */
function normalizeRel(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

/** 递归收集 papers/ 的文件夹树。rel 统一用 '/' 分隔，根目录 rel = ''。
 *  返回 { folders: [{name,path,count}], papers: [{name,folder,path,size,mtime,docId,url}] }
 *  排序：手动排过序（papers-order.json）的按它；没排过的**保持目录扫描顺序、排在已排序项之后**，
 *  并且首次列目录时把看到的顺序写进 order 冻结下来 —— 用户口径「左侧文档不应该做自动排序」，
 *  新导入的文件因此追加在末尾，不会因为修改时间被自动插到最前面。 */
async function listPapers() {
  const folders = [];
  const papers = [];
  const order = await readPaperOrder();
  const rank = new Map(order.map((p, i) => [p, i]));

  /** 扫描一层目录，返回直接子项（含文件夹与 PDF），已按 order 排序 */
  async function scanDir(absDir, rel) {
    let entries = [];
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const items = [];
    for (const e of entries) {
      if (/[\\/\u0000]/.test(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const st = await fsp.stat(path.join(absDir, e.name)).catch(() => null);
      if (!st) continue;
      if (e.isDirectory()) {
        items.push({ kind: 'folder', name: e.name, rel: childRel, mtime: st.mtimeMs });
      } else if (e.isFile() && /\.pdf$/i.test(e.name)) {
        items.push({ kind: 'file', name: e.name, rel: childRel, mtime: st.mtimeMs, size: st.size });
      }
    }
    items.forEach((it, i) => { it.__i = i; });
    items.sort((a, b) => {
      const ra = rank.has(a.rel) ? rank.get(a.rel) : -1;
      const rb = rank.has(b.rel) ? rank.get(b.rel) : -1;
      if (ra === -1 && rb === -1) return a.__i - b.__i;   // 都没排过：保持扫描顺序（不按时间重排）
      if (ra === -1) return 1;                             // 新出现的排到已排序项之后
      if (rb === -1) return -1;
      return ra - rb;
    });
    return items;
  }

  async function walk(absDir, rel) {
    const items = await scanDir(absDir, rel);
    for (const it of items) {
      if (it.kind === 'folder') {
        folders.push({ name: it.name, path: it.rel });
        await walk(path.join(absDir, it.name), it.rel);
      } else {
        papers.push({
          name: it.name,
          folder: rel,
          path: it.rel,
          size: it.size,
          mtime: it.mtime,
          docId: docIdOf(it.name),
          url: `/api/pdf?path=${encodeURIComponent(it.rel)}`,
        });
      }
    }
  }

  await walk(PAPERS_DIR, '');
  // count = 直接子 PDF 数（不含子文件夹里的）
  const byDir = new Map();
  for (const p of papers) byDir.set(p.folder, (byDir.get(p.folder) || 0) + 1);
  for (const f of folders) f.count = byDir.get(f.path) || 0;

  /* 「不做自动排序」：把这次看到的完整顺序冻结进 order 文件（已有的条目保持原顺序，
     新条目按它们出现的位置追加到末尾）。之后只有用户手动拖拽才会改变顺序。 */
  const seen = [...folders.map((f) => f.path), ...papers.map((p) => p.path)];
  const seenSet = new Set(seen);
  const kept = order.filter((rel) => seenSet.has(rel));
  const keptSet = new Set(kept);
  const missing = seen.filter((rel) => !keptSet.has(rel));
  if (missing.length || kept.length !== order.length) {
    const next = [...kept, ...missing];
    await writePaperOrder(next).catch(() => {});
    next.forEach((rel, i) => rank.set(rel, i));
  }
  return { folders, papers };
}

/** 在指定目录里找不重名的 PDF 文件名（重名加 (2)(3)）；size 同则视为同一份直接复用 */
async function uniquePdfNameInDir(absDir, base, size) {
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 1; i < 200; i++) {
    const candidate = i === 1 ? base : `${stem} (${i})${ext}`;
    const abs = path.join(absDir, candidate);
    try {
      const st = await fsp.stat(abs);
      if (size != null && st.size === size) return candidate;
    } catch {
      return candidate;
    }
  }
  return `${stem}-${Date.now()}${ext}`;
}

/** 在指定目录里找不重名的文件夹名（重名加 (2)(3)） */
async function uniqueFolderName(absDir, base) {
  for (let i = 1; i < 200; i++) {
    const candidate = i === 1 ? base : `${base} (${i})`;
    try {
      await fsp.stat(path.join(absDir, candidate));
    } catch {
      return candidate;
    }
  }
  return `${base}-${Date.now()}`;
}

/** 文件夹名清洗：去掉路径分隔符与控制符，返回干净的 basename 或 null */
function sanitizeFolderName(name) {
  const n = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .trim();
  if (!n || n === '.' || n === '..') return null;
  return n.slice(0, 80);
}

/** 解析目标文件夹：''=根；非空必须是存在的文件夹（不存在则尝试创建，供导入用） */
async function resolveTargetDir(folderRel) {
  if (!folderRel) return PAPERS_DIR;
  const abs = safeJoin(PAPERS_DIR, folderRel);
  if (!abs) return null;
  try {
    const st = await fsp.stat(abs);
    if (!st.isDirectory()) return null;
    return abs;
  } catch {
    try {
      await fsp.mkdir(abs, { recursive: true });
      return abs;
    } catch {
      return null;
    }
  }
}

/** 全库按 basename 找 PDF（旧 ?name= 链接回退用），取第一个命中的绝对路径 */
async function findPdfByBasename(base) {
  let hit = null;
  async function walk(dir) {
    if (hit) return;
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hit) return;
      if (e.isDirectory()) await walk(path.join(dir, e.name));
      else if (e.isFile() && e.name === base) {
        hit = path.join(dir, e.name);
        return;
      }
    }
  }
  await walk(PAPERS_DIR);
  return hit;
}

/** 解析 PDF 请求路径：?path= 直接定位；?name= 先看根目录，找不到按 basename 全库回退 */
async function resolvePdfPath(rel, isNameFallback) {
  if (!rel) return null;
  const abs = safeJoin(PAPERS_DIR, rel);
  if (!abs) return null;
  if (!isNameFallback) return abs;
  try {
    const st = await fsp.stat(abs);
    if (st.isFile()) return abs;
  } catch { /* 落到全库回退 */ }
  return findPdfByBasename(path.basename(rel));
}

async function handleDeletePaper(req, res, url) {
  const rel = normalizeRel(url.searchParams.get('path') ?? url.searchParams.get('name'));
  const abs = safeJoin(PAPERS_DIR, rel);
  if (!abs || !/\.pdf$/i.test(path.basename(abs))) {
    return sendJson(res, 400, { error: { message: '非法文件名' } });
  }
  try {
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
  } catch (e) {
    if (e && e.code === 'ENOENT') return sendJson(res, 404, { error: { message: '文件不存在（可能已被手动删除）' } });
    return sendJson(res, 500, { error: { message: '读取文件失败，请重试' } });
  }
  try {
    await fsp.unlink(abs);
  } catch (e) {
    sec.diag(`删除 papers/ 文件失败: ${e && e.message}`);
    return sendJson(res, 500, { error: { message: '删除失败：文件可能正被其它程序占用' } });
  }
  const order = (await readPaperOrder()).filter((n) => n !== rel);
  await writePaperOrder(order);
  console.log(`[delete] ${rel}`);
  return sendJson(res, 200, { ok: true, name: rel });
}

/* ----------------------------------------------------------- 文件夹管理 */

async function handleCreateFolder(req, res, url) {
  const name = sanitizeFolderName(url.searchParams.get('name'));
  const parent = normalizeRel(url.searchParams.get('parent')); // '' = 根
  if (!name) return sendJson(res, 400, { error: { message: '文件夹名不合法' } });
  const absParent = parent ? safeJoin(PAPERS_DIR, parent) : PAPERS_DIR;
  if (!absParent || absParent === PAPERS_DIR && parent) {
    return sendJson(res, 400, { error: { message: '父文件夹路径不合法' } });
  }
  try {
    const st = await fsp.stat(absParent);
    if (!st.isDirectory()) return sendJson(res, 400, { error: { message: '父文件夹不存在' } });
  } catch {
    return sendJson(res, 404, { error: { message: '父文件夹不存在' } });
  }
  try {
    const final = await uniqueFolderName(absParent, name);
    await fsp.mkdir(path.join(absParent, final));
    const rel = parent ? `${parent}/${final}` : final;
    console.log(`[mkdir] ${rel}`);
    return sendJson(res, 200, { ok: true, name: final, path: rel });
  } catch (e) {
    sec.diag(`创建文件夹失败: ${e && e.message}`);
    return sendJson(res, 500, { error: { message: '创建文件夹失败：请检查磁盘空间与目录权限' } });
  }
}

async function handleRenameFolder(req, res, url) {
  const raw = await readJsonBodyOrReq(req, res, sec.BODY_LIMITS.papers);
  if (raw === null) return undefined;
  const from = normalizeRel(raw.from);
  const to = sanitizeFolderName(raw.to);
  if (!from || !to) return sendJson(res, 400, { error: { message: '参数不合法' } });
  const absFrom = safeJoin(PAPERS_DIR, from);
  if (!absFrom || absFrom === PAPERS_DIR) return sendJson(res, 400, { error: { message: '非法路径' } });
  try {
    const st = await fsp.stat(absFrom);
    if (!st.isDirectory()) return sendJson(res, 400, { error: { message: '目标不是文件夹' } });
  } catch {
    return sendJson(res, 404, { error: { message: '文件夹不存在' } });
  }
  const absTo = path.join(path.dirname(absFrom), to);
  try {
    await fsp.stat(absTo);
    return sendJson(res, 409, { error: { message: `已存在同名文件夹「${to}」` } });
  } catch { /* 无冲突，可用 */ }
  try {
    await fsp.rename(absFrom, absTo);
  } catch (e) {
    sec.diag(`重命名文件夹失败: ${e && e.message}`);
    return sendJson(res, 500, { error: { message: '重命名失败：文件夹可能正被其它程序占用' } });
  }
  const idx = from.lastIndexOf('/');
  const toRel = idx >= 0 ? `${from.slice(0, idx)}/${to}` : to;
  const order = (await readPaperOrder()).map((n) => {
    if (n === from) return toRel;
    if (n.startsWith(`${from}/`)) return `${toRel}${n.slice(from.length)}`;
    return n;
  });
  await writePaperOrder(order);
  console.log(`[rename] ${from} -> ${toRel}`);
  return sendJson(res, 200, { ok: true, from, to: toRel });
}

async function handleDeleteFolder(req, res, url) {
  const rel = normalizeRel(url.searchParams.get('path'));
  const mode = url.searchParams.get('mode') === 'recursive' ? 'recursive' : 'to-root';
  if (!rel) return sendJson(res, 400, { error: { message: '缺少 path' } });
  const abs = safeJoin(PAPERS_DIR, rel);
  if (!abs || abs === PAPERS_DIR) return sendJson(res, 400, { error: { message: '非法路径' } });
  try {
    const st = await fsp.stat(abs);
    if (!st.isDirectory()) return sendJson(res, 400, { error: { message: '目标不是文件夹' } });
  } catch {
    return sendJson(res, 404, { error: { message: '文件夹不存在' } });
  }
  // 收集该文件夹树下的所有 PDF
  const pdfs = [];
  async function collect(dirAbs, dirRel) {
    let entries = [];
    try {
      entries = await fsp.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (/[\\/\u0000]/.test(e.name)) continue;
      const childRel = dirRel ? `${dirRel}/${e.name}` : e.name;
      const childAbs = path.join(dirAbs, e.name);
      if (e.isDirectory()) await collect(childAbs, childRel);
      else if (e.isFile() && /\.pdf$/i.test(e.name)) pdfs.push({ rel: childRel, abs: childAbs });
    }
  }
  await collect(abs, rel);
  try {
    if (mode === 'to-root') {
      // PDF 移到根（同名自动加后缀），再删空文件夹树
      for (const p of pdfs) {
        const final = await uniquePdfNameInDir(PAPERS_DIR, path.basename(p.abs));
        await fsp.rename(p.abs, path.join(PAPERS_DIR, final)).catch(() => {});
      }
    } else {
      // recursive：连同 PDF 一起删（data/ 里按 docId 的笔记/会话/进度保留）
      for (const p of pdfs) {
        await fsp.unlink(p.abs).catch(() => {});
      }
    }
    await fsp.rm(abs, { recursive: true, force: true });
  } catch (e) {
    sec.diag(`删除文件夹失败: ${e && e.message}`);
    return sendJson(res, 500, { error: { message: '删除文件夹失败：文件夹可能正被其它程序占用' } });
  }
  const next = (await readPaperOrder()).filter((n) => n !== rel && !n.startsWith(`${rel}/`));
  await writePaperOrder(next);
  console.log(`[rmdir] ${rel} mode=${mode} pdfs=${pdfs.length}`);
  return sendJson(res, 200, { ok: true, path: rel, mode, moved: pdfs.length });
}

async function handleMove(req, res, url) {
  const raw = await readJsonBodyOrReq(req, res, sec.BODY_LIMITS.papers);
  if (raw === null) return undefined;
  const from = normalizeRel(raw.from);
  const to = normalizeRel(raw.to); // '' = 根
  if (!from) return sendJson(res, 400, { error: { message: '缺少 from' } });
  const absFrom = safeJoin(PAPERS_DIR, from);
  if (!absFrom) return sendJson(res, 400, { error: { message: '非法路径' } });
  let st;
  try {
    st = await fsp.stat(absFrom);
  } catch {
    return sendJson(res, 404, { error: { message: '源不存在（可能已被删除）' } });
  }
  const isFolder = st.isDirectory();

  let absToDir = PAPERS_DIR;
  if (to) {
    const absTo = safeJoin(PAPERS_DIR, to);
    if (!absTo) return sendJson(res, 400, { error: { message: '非法目标路径' } });
    try {
      const tst = await fsp.stat(absTo);
      if (!tst.isDirectory()) return sendJson(res, 400, { error: { message: '目标不是文件夹' } });
    } catch {
      return sendJson(res, 404, { error: { message: '目标文件夹不存在' } });
    }
    absToDir = absTo;
  }
  // 文件夹移动禁区：不能移到自己或自己的子孙目录里
  if (isFolder && (to === from || to.startsWith(`${from}/`))) {
    return sendJson(res, 400, { error: { message: '不能把文件夹移到自己的子目录里' } });
  }

  // 移到自身所在目录：无操作（排序交给 /api/papers；绝不能走「同名同 size 去重」把源文件删了）
  if (absToDir === path.dirname(absFrom)) {
    return sendJson(res, 200, { ok: true, from, to, name: path.basename(absFrom), moved: false });
  }

  let finalName = path.basename(absFrom);
  const targetAbs = path.join(absToDir, finalName);
  try {
    const tst = await fsp.stat(targetAbs);
    if (isFolder) {
      finalName = await uniqueFolderName(absToDir, finalName);
    } else if (tst.size === st.size) {
      // 目标已有同一份文件（同名同 size）→ 直接删源，等效移动完成
      await fsp.unlink(absFrom);
      const newRel = to ? `${to}/${finalName}` : finalName;
      const order = (await readPaperOrder()).filter((n) => n !== from);
      await writePaperOrder(order);
      console.log(`[move] ${from} -> ${newRel} (去重)`);
      return sendJson(res, 200, { ok: true, from, to: newRel, name: finalName, moved: true });
    } else {
      finalName = await uniquePdfNameInDir(absToDir, finalName);
    }
  } catch { /* 目标无同名文件，直接用原名 */ }

  const absNew = path.join(absToDir, finalName);
  try {
    await fsp.rename(absFrom, absNew);
  } catch (e) {
    sec.diag(`移动失败: ${e && e.message}`);
    return sendJson(res, 500, { error: { message: '移动失败：文件可能正被其它程序占用' } });
  }
  // order 前缀替换 + 去重
  const newRel = to ? `${to}/${finalName}` : finalName;
  const order = await readPaperOrder();
  const next = [];
  const seen = new Set();
  for (const n of order) {
    let v = n;
    if (n === from) v = newRel;
    else if (isFolder && n.startsWith(`${from}/`)) v = `${newRel}${n.slice(from.length)}`;
    if (!seen.has(v)) {
      seen.add(v);
      next.push(v);
    }
  }
  await writePaperOrder(next);
  console.log(`[move] ${from} -> ${newRel}`);
  return sendJson(res, 200, { ok: true, from, to: newRel, name: finalName, moved: true });
}

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

  const forbidden = sec.CHAT_FORBIDDEN.filter((k) => Object.prototype.hasOwnProperty.call(payload, k));
  if (forbidden.length) {
    sec.diag(`/api/chat 请求体里的 ${forbidden.join(', ')} 已忽略（只能来自 data/config.json）`);
  }
  const unknown = Object.keys(payload).filter((k) => !sec.CHAT_FIELDS.has(k) && !sec.CHAT_FORBIDDEN.includes(k));
  if (unknown.length) sec.diag(`/api/chat 忽略未知字段: ${unknown.join(', ')}`);

  const stored = await readDataFile('config.json', {});
  const baseURL = stored.baseURL || DEFAULT_CONFIG.baseURL;
  const apiKey = stored.apiKey || '';
  // 视觉模型：前端只传 useVision 标记，模型名仍只从本机 config 取（请求体里的 model 被忽略）。
  const wantsVision = payload.useVision === true || payload.useVision === '1';
  const model = (wantsVision && stored.visionModel) ? stored.visionModel : (stored.model || DEFAULT_CONFIG.model);

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

  /** A 线 P2.5：只读工具的受限透传（形状/大小校验，不合规 400） */
  const tools = sec.pickTools(payload.tools);
  if (tools.error) return sendJson(res, 400, { error: { message: tools.error } });
  const toolChoice = sec.pickToolChoice(payload.tool_choice, tools.value);
  if (toolChoice.error) return sendJson(res, 400, { error: { message: toolChoice.error } });

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
  if (tools.value) {
    body.tools = tools.value;
    if (toolChoice.value !== null) body.tool_choice = toolChoice.value;
    if (payload.parallel_tool_calls === false) body.parallel_tool_calls = false;
  }

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

async function getText(url, accept = '*/*', ua = 'paper-reader/1.0 (local; reference lookup)', timeoutMs = FETCH_TIMEOUT) {
  const r = await fetch(url, {
    headers: { 'User-Agent': ua, Accept: accept, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}


const REF_VENUE_RE = /^(in|proceedings|proc\.?|advances|journal|transactions|conference|workshop|symposium|arxiv|corr|pages?|vol\.?|pp\.?|press|ieee|acm|springer|elsevier|wiley|neurips|nips|icml|iclr|cvpr|iccv|eccv|acl|emnlp|naacl|aaai|ijcai|kdd|sigir|www)\b/i;
const REF_CJK_RE = /[\u4e00-\u9fa5]/;

/** 按「句末点号」切段，但 `V.` `J. R.` 这类**缩写点不切**（就是本 bug 的根因） */
function splitRefSegments(s) {
  const out = [];
  let buf = '';
  const push = () => { const t = buf.trim(); if (t) out.push(t); buf = ''; };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '。' || ch === '．' || ch === '！' || ch === '？') { push(); continue; }
    if (ch === '.' && (i + 1 >= s.length || /\s/.test(s[i + 1]))) {
      // `V. Sindhwani` 的 `V.` 不切；但 `Hochreiter, S. Long short-term memory` 里的
      // `S.` 前面有逗号 —— 那是「姓, 名首字母」这种完整的作者写法，该切。
      const tail = buf.replace(/\s+$/, '');
      const initial = /(^|\s)[A-Z]$/.test(tail);
      const surnameInitial = /,\s*[A-Z]$/.test(tail);
      if (!initial || surnameInitial) { push(); continue; }
    }
    buf += ch;
  }
  push();
  return out;
}

/** 这一段像不像「作者列表」 */
function looksLikeAuthors(seg) {
  const t = String(seg).trim();
  if (!t) return false;
  if (/^[A-Z]\.?(\s+[A-Z]\.?)*$/.test(t)) return true;                    // 纯缩写：V. T. S.
  if (/^(and|&)\s+[^,]+$/i.test(t) && t.split(/\s+/).length <= 6) return true;   // 作者列表被切成两段的后半截
  if (/,[ ]*[A-Z]\.?$/.test(t)) return true;                              // 「姓, 名首字母」被切成一段：Hochreiter, S
  if (/(^|\s)et\s+al\.?$|等人$|等$/i.test(t)) return true;                 // et al. / 等
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 16) return false;                                    // 太长不像作者
  const commas = (t.match(/[,，、]/g) || []).length;
  const ands = /\band\b|&/i.test(t);
  if (commas >= 2) return true;                                           // A, B, C
  if (commas >= 1 && (ands || (REF_CJK_RE.test(t) && t.length <= 20))) return true;
  if (/(^|\s)[A-Z]\.[\s,]/.test(t)) {                                     // 带缩写的人名：J. Smith
    const names = words.filter((w) => /^[A-Z]\.?$/.test(w) || /^[A-Z][A-Za-z'’-]+[,.]?$/.test(w)).length;
    if (names >= words.length - 1) return true;
  }
  return false;
}

/** 这一段像不像「标题」（而不是出版信息 / 期刊名 / 页码） */
function looksLikeTitle(seg) {
  const t = String(seg).trim();
  if (!t || REF_VENUE_RE.test(t)) return false;
  const letters = (t.match(/[A-Za-z\u4e00-\u9fa5]/g) || []).length;
  if (REF_CJK_RE.test(t)) return t.length >= 6;                           // 中文标题没空格，按字数
  return letters >= 12 && t.split(/\s+/).filter(Boolean).length >= 2;
}

function guessTitle(ref) {
  const s = String(ref).replace(/^\[\d+\]\s*/, '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const segs = splitRefSegments(s);
  if (!segs.length) return '';
  let i = 0;
  while (i < segs.length - 1 && i < 6 && looksLikeAuthors(segs[i])) i++;
  for (let j = i; j < segs.length; j++) if (looksLikeTitle(segs[j])) return cleanTitle(segs[j]);
  return cleanTitle(segs[i]);
}

function cleanTitle(t) {
  return String(t).replace(/^[\s.,;:，。；：]+|[\s.,;:，。；：]+$/g, '').slice(0, 160);
}

/** 猜出来的标题能不能拿去检索：单字母 / 一两个词的碎片不算 */
function titleIsSearchable(t) {
  const s = String(t || '').trim();
  const letters = (s.match(/[A-Za-z\u4e00-\u9fa5]/g) || []).length;
  if (REF_CJK_RE.test(s)) return letters >= 4;                            // 中文标题没空格，4 个字就够
  if (letters < 6) return false;
  const words = s.split(/\s+/).filter(Boolean);
  return words.length >= 2 || letters >= 8;                               // 单个长词（AlphaFold）也算
}

/** 归一化成一堆词（小写、只留字母数字汉字） */
function normWords(x) {
  return String(x).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ').trim().split(' ').filter(Boolean);
}

function titleScore(a, b) {
  const A = new Set(normWords(a));
  const B = new Set(normWords(b));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / Math.max(A.size, B.size);
}

function resultMatchesTitle(searchTitle, confident, candTitle) {
  const Q = new Set(normWords(searchTitle));
  const C = new Set(normWords(candTitle));
  if (!Q.size || !C.size) return false;
  let hit = 0;
  for (const w of C) if (Q.has(w)) hit++;
  if (!confident) return hit / C.size >= 0.8;
  return hit / Math.max(Q.size, C.size) >= 0.34;
}

function openAlexAbstract(work) {
  const index = work?.abstract_inverted_index;
  if (!index || typeof index !== 'object') return '';
  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const p of Array.isArray(positions) ? positions : []) {
      if (Number.isInteger(p) && p >= 0 && p < 10000) words.push([p, word]);
    }
  }
  return words.sort((a, b) => a[0] - b[0]).slice(0, 800).map((w) => w[1]).join(' ').slice(0, 4000);
}

async function searchReference(q, { reading = false } = {}) {
  const raw = String(q).replace(/\s+/g, ' ').trim().slice(0, 300);
  const guessed = guessTitle(raw);
  // 标题认不出来（单字母 / 碎片）就别拿它去搜 —— 退回整条文献串。
  // 事故回顾：`V. Sindhwani, …` 猜成 `V`，arXiv 就按「标题含 V」返回了一堆无关论文。
  const confident = titleIsSearchable(guessed);
  const title = confident ? guessed : raw;
  const results = [];
  const read = (url, accept) => getText(url, accept, undefined, reading ? 2500 : FETCH_TIMEOUT);

  // 1) arXiv：先按标题精确搜，没有再退回全文搜
  for (const query of [`ti:"${title}"`, `all:"${title}"`].slice(0, reading ? 1 : 2)) {
    try {
      const xml = await read(
        `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&max_results=3`,
        'application/atom+xml',
      );
      for (const e of xml.split('<entry>').slice(1)) {
        const t = (/<title>([\s\S]*?)<\/title>/.exec(e)?.[1] || '').replace(/\s+/g, ' ').trim();
        const id = (/<id>([\s\S]*?)<\/id>/.exec(e)?.[1] || '').trim();
        const year = (/<published>(\d{4})/.exec(e)?.[1]) || '';
        if (!/arxiv\.org\/abs\//.test(id)) continue;
        const snippet = stripTags((/<summary>([\s\S]*?)<\/summary>/.exec(e)?.[1] || '')).slice(0, 4000);
        results.push({ source: 'arXiv', title: t, year, venue: 'arXiv', url: id, pdfUrl: id.replace('/abs/', '/pdf/'), snippet, excerptKind: 'abstract' });
      }
      if (results.length) break;
    } catch { /* 换下一个源 */ }
  }

  // 2) OpenAlex：免费无密钥，而且有开放获取直链
  if (!(reading && results.some((r) => r.snippet && resultMatchesTitle(title, confident, r.title)))) try {
    const j = JSON.parse(await read(
      `https://api.openalex.org/works?search=${encodeURIComponent(title)}&per-page=4&select=title,publication_year,doi,open_access,primary_location,abstract_inverted_index`,
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
        snippet: openAlexAbstract(w), excerptKind: 'abstract',
      });
    }
  } catch { /* 忽略 */ }

  // 3) Crossref：用整条文献串检索，覆盖最广
  if (!reading) try {
    const j = JSON.parse(await read(
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
  if (!reading) try {
    const j = JSON.parse(await read(
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

  // 去重 → 丢掉和标题无关的 → 按「标题相似度 + 有没有 PDF 直链」排序
  const seen = new Set();
  const uniq = [];
  let dropped = 0;
  results.sort((a, b) => Number(!!b.snippet) - Number(!!a.snippet));
  for (const r of results) {
    const key = (r.title || r.url || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '').slice(0, 60);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!resultMatchesTitle(title, confident, r.title)) { dropped++; continue; }
    r.score = titleScore(title, r.title) + (r.pdfUrl ? 0.35 : 0) + (r.url?.includes('doi.org') || r.url?.includes('arxiv.org') ? 0.1 : 0);
    uniq.push(r);
  }
  uniq.sort((a, b) => b.score - a.score);

  return {
    query: raw,
    title,
    titleGuessed: confident,     // false = 没认出标题，这次是拿整条文献串搜的
    dropped,                     // 被相关性判据丢掉的条数（前端据此解释「为什么是空的」）
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
  // 这里不能写「反正别的引擎失败了，就把这批不相关的先给出去」。
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
    // 3xx：先丢掉这次响应体，再重新走一遍协议/主机检查
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

  // 初始 URL 先检查一次（错误码/文案与从前一致），随后每一跳都会再检查一次。
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
  const folderRel = normalizeRel(url.searchParams.get('folder'));
  const absDir = await resolveTargetDir(folderRel);
  if (!absDir) return sendJson(res, 400, { error: { message: '目标文件夹不存在或不可写' } });

  try {
    const final = await uniquePdfNameInDir(absDir, name, body.length);
    await fsp.writeFile(path.join(absDir, final), body);
    const st = await fsp.stat(path.join(absDir, final));
    const rel = folderRel ? `${folderRel}/${final}` : final;
    // 日志里不打印完整 URL 的查询串（可能带 token / 签名），只留主机 + 文件名
    console.log(`[import] ${rel} (${Math.round(body.length / 1024)}KB) <- ${hostLabel(got.finalUrl || target)}`);
    return sendJson(res, 200, {
      ok: true,
      name: final,
      folder: folderRel,
      path: rel,
      size: st.size,
      mtime: st.mtimeMs,
      docId: docIdOf(final),
      url: `/api/pdf?path=${encodeURIComponent(rel)}`,
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

/** 同名同大小 → 认为已经导入过，直接复用；否则加 (2)(3) 后缀（根目录版，兼容旧调用） */
async function uniquePdfName(base, size) {
  return uniquePdfNameInDir(PAPERS_DIR, base, size);
}

async function handleUpload(req, res, url) {
  const name = sanitizePdfName(url.searchParams.get('name'));
  if (!name) return sendJson(res, 400, { error: { message: '文件名不合法' } });
  const folderRel = normalizeRel(url.searchParams.get('folder'));
  const absDir = await resolveTargetDir(folderRel);
  if (!absDir) return sendJson(res, 400, { error: { message: '目标文件夹不存在或不可写' } });

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
    const final = await uniquePdfNameInDir(absDir, name, body.length);
    await fsp.writeFile(path.join(absDir, final), body);
    const st = await fsp.stat(path.join(absDir, final));
    const rel = folderRel ? `${folderRel}/${final}` : final;
    console.log(`[upload] ${rel} (${Math.round(body.length / 1024)}KB)`);
    return sendJson(res, 200, {
      ok: true,
      name: final,
      folder: folderRel,
      path: rel,
      size: st.size,
      mtime: st.mtimeMs,
      docId: docIdOf(final),
      url: `/api/pdf?path=${encodeURIComponent(rel)}`,
    });
  } catch (e) {
    // 审计 §P2：磁盘错误里带完整路径，只进本地诊断日志
    sec.diag(`写入 papers/ 失败: ${e && e.message}`);
    return sendJson(res, 500, { error: { message: '写入 papers/ 失败：请检查磁盘空间与目录权限' } });
  }
}

/* ------------------------------------------- 会话 meta（P0 会话系统 v4） */

/** 用户手改标题的上限 */
const SESSION_TITLE_MAX = 120;
/** 自动派生标题上限（设计文档：首条用户消息 28 字） */
const SESSION_DERIVED_TITLE_MAX = 28;
const SESSION_TS_MIN = 1e11;
const SESSION_TS_MAX = 1e14;

function collapsWs(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/** 合法的毫秒时间戳；0 表示没有/不合法 */
function sessionTs(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > SESSION_TS_MIN && n < SESSION_TS_MAX ? Math.round(n) : 0;
}

/**
 * 会话内容指纹：只回答「这次保存是不是真的改了内容」。
 * 规则故意保持简单：条目数 + 最后一条文本前 80 字 + history 长度 + summary 长度 +
 * summaryCovered + ops 数。desktop/src/api.rs 有完全相同的实现 ——
 * 换后端（Node ↔ Rust）不能造成 updatedAt 抖动。
 */
function sessionContentFingerprint(data) {
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const lastWithText = [...entries].reverse().find((e) => e && typeof e.text === 'string' && e.text);
  const history = Array.isArray(data?.history) ? data.history : [];
  const ops = Array.isArray(data?.ops) ? data.ops : [];
  return [
    entries.length,
    String(lastWithText ? lastWithText.text : '').slice(0, 80),
    history.length,
    String(data?.summary || '').length,
    Number(data?.summaryCovered) || 0,
    ops.length,
  ].join('\u0001');
}

function sessionEntries(data) {
  return Array.isArray(data?.entries) ? data.entries : [];
}

function sessionFirstUserText(data) {
  const hit = sessionEntries(data).find((e) => e && e.kind === 'user' && typeof e.text === 'string' && e.text.trim());
  return hit ? hit.text : '';
}

function sessionLastEntryText(data) {
  const hit = [...sessionEntries(data)].reverse().find((e) => e && typeof e.text === 'string' && e.text.trim());
  return hit ? hit.text : '';
}

/** 标题：用户改过就用用户的；否则用首条用户消息；旧「解释/翻译」会话没有用户消息时
 *  退到首条有文字的助手消息，再退到首条 quote。都去掉【…】界面标记后截 28 字。
 *  desktop/src/api.rs 的 session_title_of 必须保持一致。 */
function sessionTitleOf(data) {
  const saved = collapsWs(data?.title);
  if (saved) return saved.slice(0, SESSION_TITLE_MAX);
  const clean = (s) => collapsWs(collapsWs(s).replace(/【[^】]{0,60}】/g, ' '));
  const userHit = sessionFirstUserText(data);
  if (collapsWs(userHit)) return clean(userHit).slice(0, SESSION_DERIVED_TITLE_MAX);
  for (const e of sessionEntries(data)) {
    if (e && typeof e.text === 'string' && e.text.trim()) return clean(e.text).slice(0, SESSION_DERIVED_TITLE_MAX);
  }
  for (const e of sessionEntries(data)) {
    if (e && typeof e.quote === 'string' && e.quote.trim()) return clean(e.quote).slice(0, SESSION_DERIVED_TITLE_MAX);
  }
  return '';
}

/** docIds/docTitles 按 docId 合并去重（旧文件的引用也不能丢），最多留 12 个 */
function mergeSessionDocRefs(oldData, incoming) {
  const ids = [];
  const titles = [];
  const add = (id, title) => {
    const key = collapsWs(id).slice(0, 120);
    if (!key) return;
    const i = ids.indexOf(key);
    if (i >= 0) { if (!titles[i]) titles[i] = collapsWs(title).slice(0, 200); return; }
    ids.push(key);
    titles.push(collapsWs(title).slice(0, 200));
  };
  const oldIds = Array.isArray(oldData?.docIds) ? oldData.docIds : [];
  const oldTitles = Array.isArray(oldData?.docTitles) ? oldData.docTitles : [];
  oldIds.forEach((id, i) => add(id, oldTitles[i]));
  const newIds = Array.isArray(incoming?.docIds) ? incoming.docIds : [];
  const newTitles = Array.isArray(incoming?.docTitles) ? incoming.docTitles : [];
  newIds.forEach((id, i) => add(id, newTitles[i]));
  return { docIds: ids.slice(-12), docTitles: titles.slice(-12) };
}

/**
 * POST /api/session 落盘前的整理：把 meta 补进 payload。
 * - updatedAt 只在内容真的变了时才更新（指纹没变就沿用旧值）；
 * - createdAt / pinned / archived / title 等客户端没传时沿用旧文件；
 * - 永远不丢 payload 里的内容字段。
 */
function prepareSessionRecord(payload, oldData, now) {
  const old = oldData && typeof oldData === 'object' && !Array.isArray(oldData) ? oldData : null;
  const fp = sessionContentFingerprint(payload);
  const prevFp = old ? (typeof old.contentFp === 'string' ? old.contentFp : sessionContentFingerprint(old)) : '';
  const changed = !old || fp !== prevFp;
  const refs = mergeSessionDocRefs(old, payload);
  const pinned = old?.pinned === true || payload?.pinned === true;
  const archived = old?.archived === true || payload?.archived === true;
  const createdAt = sessionTs(old?.createdAt) || sessionTs(payload?.createdAt) || now;
  const updatedAt = changed ? (sessionTs(payload?.updatedAt) || now) : (sessionTs(old?.updatedAt) || now);
  const title = collapsWs(payload?.title || old?.title).slice(0, SESSION_TITLE_MAX);
  const titleSource = (payload?.titleSource === 'user' || old?.titleSource === 'user') ? 'user' : 'auto';
  return {
    ...payload,
    v: 4,
    folderPath: typeof payload?.folderPath === 'string' ? payload.folderPath.slice(0, 400)
      : (typeof old?.folderPath === 'string' ? old.folderPath : ''),
    title,
    titleSource,
    createdAt,
    updatedAt,
    lastOpenedAt: sessionTs(payload?.lastOpenedAt) || sessionTs(old?.lastOpenedAt) || updatedAt,
    pinned,
    pinnedAt: pinned ? (sessionTs(old?.pinnedAt) || sessionTs(payload?.pinnedAt) || updatedAt) : 0,
    archived,
    archivedAt: archived ? (sessionTs(old?.archivedAt) || sessionTs(payload?.archivedAt) || updatedAt) : 0,
    docIds: refs.docIds,
    docTitles: refs.docTitles,
    contentRev: (Number(old?.contentRev) || 0) + (changed ? 1 : 0),
    contentFp: fp,
  };
}

/**
 * 定位会话文件：先按 docKeyCandidates 找已存在的（老键），都没有就用规范文件名的。
 * 与 desktop/src/api.rs 的 session_file_resolved 同规则。
 */
async function resolveSessionFileName(doc, sid) {
  const keys = docKeyCandidates(doc);
  for (const key of keys) {
    const name = sid ? `session-${key}-${sid}.json` : `session-${key}.json`;
    try {
      await fsp.access(path.join(DATA_DIR, name));
      return name;
    } catch { /* 试下一个候选 */ }
  }
  return sid ? `session-${docIdOf(doc)}-${sid}.json` : `session-${docIdOf(doc)}.json`;
}

async function handle(req, res) {
  const host = String(req.headers.host || '').toLowerCase();
  const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
  if (!allowedHosts.has(host)) return sendJson(res, 403, { error: { message: '非法 Host' } });
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const pathname = decodeURIComponent(url.pathname);

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

  // ---- 论文目录 / 文件夹 / 排序 / 删除 / 移动
  if (pathname === '/api/papers') {
    if (req.method === 'GET') {
      const body = await listPapers();
      // 审计 §P2：默认不返回本机绝对路径；只有显式开启诊断才给
      if (DIAGNOSTICS) body.dir = PAPERS_DIR;
      return sendJson(res, 200, body);
    }
    if (req.method === 'POST') {
      // 保存拖拽后的书架顺序；只写 data/papers-order.json，不动文件本身
      const raw = await readJsonBodyOrReq(req, res, sec.BODY_LIMITS.papers);
      if (raw === null) return undefined;
      const order = sanitizePaperOrder(raw);
      if (!order) return sendJson(res, 400, { error: { message: '请求体缺少 order 数组' } });
      try {
        await writePaperOrder(order);
      } catch (e) {
        sec.diag(`保存 papers-order.json 失败: ${e && e.message}`);
        return sendJson(res, 500, { error: { message: '保存文件顺序失败，请检查磁盘空间与目录权限' } });
      }
      return sendJson(res, 200, { ok: true, count: order.length });
    }
    if (req.method === 'DELETE') return handleDeletePaper(req, res, url);
    return send(res, 405, 'Method Not Allowed');
  }

  // ---- 文件夹管理：POST 新建 / PATCH 重命名 / DELETE 删除
  if (pathname === '/api/folders') {
    if (req.method === 'POST') return handleCreateFolder(req, res, url);
    if (req.method === 'PATCH') return handleRenameFolder(req, res, url);
    if (req.method === 'DELETE') return handleDeleteFolder(req, res, url);
    return send(res, 405, 'Method Not Allowed');
  }

  // ---- 移动 PDF / 文件夹（含拖出拖入）
  if (pathname === '/api/move') {
    if (req.method !== 'POST') return send(res, 405, 'Method Not Allowed');
    return handleMove(req, res, url);
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
    const hasPath = url.searchParams.has('path');
    const rel = normalizeRel(hasPath ? url.searchParams.get('path') : url.searchParams.get('name'));
    const abs = await resolvePdfPath(rel, !hasPath);
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
      return sendJson(res, 200, modelProfiles.publicConfig(cfg));
    }
    if (req.method === 'POST') {
      // 审计 §P1：1MB 上限；超限直接 413，绝不写盘
      const raw = await readJsonBodyOrReq(req, res, sec.BODY_LIMITS.config);
      if (raw === null) return undefined;
      // 审计 §P1：严格字段白名单 + 范围限制，未知字段忽略
      const { patch, ignored, capped } = sec.sanitizeConfigPatch(raw);
      if (ignored.length) sec.diag(`/api/config 忽略字段: ${ignored.join(', ')}`);
      /**
       * 超长字段返回 400，绝不截断保存（审计 §验收：「超限返回 413/400，
       * 不截断后静默保存」）。从前一个 5000 字的 model 会被悄悄存成 256 字、
       * 接口还回 200 —— 用户以为保存成功了，设置其实已经被改坏。
       */
      if (capped.length) {
        const detail = capped.map((c) => `${c.field}（上限 ${c.limit} 字符）`).join('、');
        return sendJson(res, 400, { error: { message: `字段超长：${detail}。请缩短后重试（未保存任何改动）` } });
      }
      let cur;
      try {
        cur = JSON.parse(await fsp.readFile(path.join(DATA_DIR, 'config.json'), 'utf8'));
      } catch (e) {
        if (e && e.code === 'ENOENT') cur = {};
        else {
          sec.diag(`读取 config.json 失败: ${e && e.message}`);
          return sendJson(res, 500, { error: { message: '配置文件损坏，已拒绝覆盖，请先修复 config.json' } });
        }
      }
      const next = { ...DEFAULT_CONFIG, ...cur, ...patch };
      if (!patch.apiKey) next.apiKey = cur.apiKey || '';
      try { modelProfiles.saveProfiles({ ...DEFAULT_CONFIG, ...cur }, next, raw); }
      catch (e) { return sendJson(res, 400, { error: { message: e.message } }); }
      await writeDataFile('config.json', next);
      return sendJson(res, 200, { ok: true, hasApiKey: !!next.apiKey });
    }
    return send(res, 405, 'Method Not Allowed');
  }

  if (pathname === '/api/profile') {
    if (req.method === 'GET') {
      const saved = await readDataFile('learning-profile.json', null);
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) return sendJson(res, 200, saved);
      return sendJson(res, 200, { version: 1, revision: 0, updatedAt: '', selfReport: '', selfReportAt: '', items: [] });
    }
    if (req.method === 'POST') {
      const raw = await readJsonBodyOrReq(req, res, sec.BODY_LIMITS.profile);
      if (raw === null) return undefined;
      const checked = sec.checkProfile(raw);
      if (checked.error) return sendJson(res, 400, { error: { message: checked.error } });
      profileWriteChain = profileWriteChain.catch(() => {}).then(async () => {
        try {
          const expected = req.headers['if-match'];
          if (expected !== undefined) {
            const current = await readDataFile('learning-profile.json', {});
            const revision = current?.revision || 0;
            if (!/^\d+$/.test(expected) || Number(expected) !== revision || checked.value.revision !== revision + 1) {
              return sendJson(res, 409, { error: { message: '学习记忆已更新，请重新读取' } });
            }
          }
          await writeDataFile('learning-profile.json', checked.value);
          return sendJson(res, 200, { ok: true, revision: checked.value.revision });
        } catch (e) {
          sec.diag(`保存学习档案失败: ${e && e.message}`);
          return sendJson(res, 500, { error: { message: '保存学习档案失败，请重试' } });
        }
      });
      return profileWriteChain;
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
    if (req.method === 'DELETE') {
      try { await fsp.rm(path.join(DATA_DIR, file), { force: true }); }
      catch (e) {
        sec.diag(`删除阅读会话失败: ${e && e.message}`);
        return sendJson(res, 500, { error: { message: '删除阅读会话失败，请重试' } });
      }
      return sendJson(res, 200, { ok: true });
    }
    return send(res, 405, 'Method Not Allowed');
  }

  if (pathname === '/api/session') {
    const doc = url.searchParams.get('doc') || 'default';
    const sid = (url.searchParams.get('sid') || '').replace(/[^\w-]/g, '').slice(0, 40);
    const file = await resolveSessionFileName(doc, sid);
    if (req.method === 'GET') return sendJson(res, 200, await readDataFile(file, { entries: [], history: [], ops: [] }));
    if (req.method === 'POST') {
      // 审计 §P1：条目数 + 总字符数 + 附件元数据大小
      const payload = await readJsonBodyOrReq(req, res, sec.BODY_LIMITS.session);
      if (payload === null) return undefined;
      const bad = sec.checkSession(payload);
      if (bad) return sendJson(res, 413, { error: { message: bad } });
      let stored;
      try {
        const old = await readDataFile(file, null);
        stored = prepareSessionRecord(payload, old, Date.now());
        await writeDataFile(file, stored);
      } catch (e) {
        sec.diag(`保存阅读会话失败: ${e && e.message}`);
        return sendJson(res, 500, { error: { message: '保存阅读会话失败，请重试' } });
      }
      // 图片单独存：会话写成功之后按「还引用着的 id」清理本会话的附件目录
      // （清空会话 = 没有引用 → 图全删；发送失败留下的孤儿图也在这里被清掉）
      await pruneAttachments(doc, sid, stored);
      return sendJson(res, 200, { ok: true, updatedAt: stored.updatedAt, contentRev: stored.contentRev });
    }
    if (req.method === 'PATCH') {
      // P0 会话系统：只允许改 meta 白名单字段（标题/置顶/归档/最后打开时间），不许借此改内容
      const patch = await readJsonBodyOrReq(req, res, sec.BODY_LIMITS.sessionPatch);
      if (patch === null) return undefined;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return sendJson(res, 400, { error: { message: '会话 meta 必须是对象' } });
      }
      const cur = await readDataFile(file, null);
      if (!cur || typeof cur !== 'object' || Array.isArray(cur)) {
        return sendJson(res, 404, { error: { message: '会话不存在或已被删除' } });
      }
      const now = Date.now();
      const next = { ...cur };
      if (Object.prototype.hasOwnProperty.call(patch, 'title')) {
        const t = collapsWs(patch.title).slice(0, SESSION_TITLE_MAX);
        if (t) { next.title = t; next.titleSource = 'user'; }
        else { delete next.title; next.titleSource = 'auto'; }
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'titleSource')) {
        next.titleSource = patch.titleSource === 'user' ? 'user' : 'auto';
        if (!next.title && next.titleSource === 'user') next.titleSource = 'auto';
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'pinned')) {
        next.pinned = patch.pinned === true;
        next.pinnedAt = next.pinned ? (sessionTs(cur.pinnedAt) || now) : 0;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'archived')) {
        next.archived = patch.archived === true;
        next.archivedAt = next.archived ? (sessionTs(cur.archivedAt) || now) : 0;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'lastOpenedAt')) {
        const t = sessionTs(patch.lastOpenedAt);
        if (t) next.lastOpenedAt = t;
      }
      next.v = 4;
      if (!sessionTs(next.createdAt)) next.createdAt = sessionTs(cur.updatedAt) || now;
      try { await writeDataFile(file, next); }
      catch (e) {
        sec.diag(`更新会话失败: ${e && e.message}`);
        return sendJson(res, 500, { error: { message: '更新会话失败，请重试' } });
      }
      return sendJson(res, 200, {
        ok: true,
        session: {
          sid,
          title: sessionTitleOf(next),
          titleSource: next.titleSource === 'user' ? 'user' : 'auto',
          pinned: next.pinned === true,
          pinnedAt: sessionTs(next.pinnedAt),
          archived: next.archived === true,
          archivedAt: sessionTs(next.archivedAt),
          lastOpenedAt: sessionTs(next.lastOpenedAt),
        },
      });
    }
    if (req.method === 'DELETE') {
      try { await fsp.rm(path.join(DATA_DIR, file), { force: true }); }
      catch (e) {
        sec.diag(`删除阅读会话失败: ${e && e.message}`);
        return sendJson(res, 500, { error: { message: '删除阅读会话失败，请重试' } });
      }
      // 会话没了，它单独存的截图附件也一起删（否则会变成永远没人引用的垃圾文件）
      await removeAttachmentDir(doc, sid);
      return sendJson(res, 200, { ok: true });
    }
    return send(res, 405, 'Method Not Allowed');
  }

  /**
   * P0 会话系统：文件夹改名/移动后把该文件夹的会话复制到新键。
   * 复制而不是移动：旧文件保留作为回退备份（本机 disk 成本可忽略）。
   * 截图附件目录也复制一份到新键，否则老会话里的截图会 404。
   */
  if (pathname === '/api/sessions/move-folder') {
    if (req.method !== 'POST') return send(res, 405, 'Method Not Allowed');
    const body = await readJsonBodyOrReq(req, res, sec.BODY_LIMITS.sessionPatch);
    if (body === null) return undefined;
    const fromKey = String(body.fromKey || '').trim();
    const toKey = String(body.toKey || '').trim();
    const toPath = typeof body.toPath === 'string' ? body.toPath.slice(0, 400) : '';
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(fromKey) || !/^[A-Za-z0-9._-]{1,120}$/.test(toKey) || fromKey === toKey) {
      return sendJson(res, 400, { error: { message: '迁移参数不合法' } });
    }
    const fromDocKey = docIdOf(fromKey);
    const toDocKey = docIdOf(toKey);
    let names = [];
    try { names = await fsp.readdir(DATA_DIR); } catch { names = []; }
    let migrated = 0;
    try {
      for (const name of names) {
        const m = /^session-(.+)\.json$/.exec(name);
        if (!m) continue;
        const rest = m[1];
        if (rest.endsWith('-__translate') || rest.endsWith('__translate')) continue;
        let sid = '';
        if (rest === fromDocKey) sid = '';
        else if (rest.startsWith(`${fromDocKey}-`)) sid = rest.slice(fromDocKey.length + 1);
        else continue;
        const data = await readDataFile(name, null);
        if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
        const next = { ...data, v: 4, folderPath: toPath || data.folderPath || '' };
        const targetName = sid ? `session-${toDocKey}-${sid}.json` : `session-${toDocKey}.json`;
        await writeDataFile(targetName, next);
        migrated += 1;
      }
    } catch (e) {
      sec.diag(`迁移会话失败: ${e && e.message}`);
      return sendJson(res, 500, { error: { message: '迁移会话失败，请重试' } });
    }
    let attachments = 0;
    const attRoot = path.join(DATA_DIR, 'attachments');
    let attNames = [];
    try { attNames = await fsp.readdir(attRoot); } catch { attNames = []; }
    for (const dirName of attNames) {
      let tail = '';
      if (dirName === fromDocKey) tail = '';
      else if (dirName.startsWith(`${fromDocKey}-`)) tail = dirName.slice(fromDocKey.length);
      else continue;
      const fromDir = path.join(attRoot, dirName);
      const toDir = path.join(attRoot, `${toDocKey}${tail}`);
      if (fromDir === toDir) continue;
      try { await fsp.cp(fromDir, toDir, { recursive: true, force: true }); attachments += 1; }
      catch (e) { sec.diag(`迁移截图附件失败: ${e && e.message}`); }
    }
    return sendJson(res, 200, { ok: true, migrated, attachments });
  }

  if (pathname === '/api/attachment') return handleAttachment(req, res, url);

  if (pathname === '/api/sessions') {
    const doc = url.searchParams.get('doc') || 'default';
    const folderPath = (url.searchParams.get('folderPath') || '').slice(0, 400);
    const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'folder';
    const archivedParam = url.searchParams.get('archived');
    const archivedFilter = archivedParam === '1' || archivedParam === '0' ? archivedParam : 'all';
    const q = collapsWs(url.searchParams.get('q') || '').toLowerCase().slice(0, 200);
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 200));
    let names = [];
    try { names = await fsp.readdir(DATA_DIR); } catch { names = []; }
    const out = [];
    const seen = new Set();
    const describe = async (fileName, sid, folderPathHint) => {
      if (seen.has(fileName)) return;
      seen.add(fileName);
      const data = await readDataFile(fileName, null);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      let stat = null;
      try { stat = await fsp.stat(path.join(DATA_DIR, fileName)); } catch { stat = null; }
      const mtime = stat ? Math.round(stat.mtimeMs) : 0;
      const createdFallback = stat && stat.birthtimeMs ? Math.round(stat.birthtimeMs) : 0;
      const updatedAt = sessionTs(data.updatedAt) || mtime;
      out.push({
        sid,
        folderPath: (typeof data.folderPath === 'string' && data.folderPath) ? data.folderPath : (folderPathHint || ''),
        title: sessionTitleOf(data),
        titleSource: data.titleSource === 'user' ? 'user' : 'auto',
        preview: collapsWs(sessionLastEntryText(data)).slice(0, 80),
        count: sessionEntries(data).length,
        createdAt: sessionTs(data.createdAt) || createdFallback || updatedAt,
        updatedAt,
        lastOpenedAt: sessionTs(data.lastOpenedAt) || updatedAt,
        pinned: data.pinned === true,
        pinnedAt: sessionTs(data.pinnedAt),
        archived: data.archived === true,
        archivedAt: sessionTs(data.archivedAt),
        docIds: Array.isArray(data.docIds) ? data.docIds.slice(0, 12) : [],
        docTitles: Array.isArray(data.docTitles) ? data.docTitles.slice(0, 12) : [],
        contentRev: Number(data.contentRev) || 0,
      });
    };
    if (scope === 'all') {
      // 全部文件夹：直接扫 data/ 下的所有会话文件（跳过译文伪会话）
      for (const name of names) {
        const m = /^session-(.+)\.json$/.exec(name);
        if (!m) continue;
        const rest = m[1];
        if (rest.endsWith('-__translate') || rest.endsWith('__translate')) continue;
        // 新格式尾部是 sid（newSid 只由 base36 组成）；老格式 session-<key>.json 没有 sid
        const sidMatch = /^(.*)-([a-z0-9]{6,24})$/.exec(rest);
        await describe(name, sidMatch ? sidMatch[2] : '', '');
      }
    } else {
      const keys = docKeyCandidates(doc);
      const fileFor = (key, sid) => (sid ? `session-${key}-${sid}.json` : `session-${key}.json`);
      // 对每一个候选 key：老的单会话文件 + 该 key 下的所有 sid 文件
      for (const key of keys) {
        if (names.includes(fileFor(key, ''))) await describe(fileFor(key, ''), '', folderPath);
        const prefix = `session-${key}-`;
        for (const name of names) {
          if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
          await describe(name, name.slice(prefix.length, -'.json'.length), folderPath);
        }
      }
    }
    let items = out;
    if (archivedFilter === '0') items = items.filter((s) => !s.archived);
    else if (archivedFilter === '1') items = items.filter((s) => s.archived);
    if (q) items = items.filter((s) => `${s.title}\n${s.preview}\n${s.folderPath}`.toLowerCase().includes(q));
    items.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.pinned && b.pinned) return (b.pinnedAt || 0) - (a.pinnedAt || 0);
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    const total = items.length;
    items = items.slice(0, limit);
    return sendJson(res, 200, { sessions: items, scope, total });
  }

  if (pathname === '/api/health') return sendJson(res, 200, { ok: true, port: PORT });

  // ---- 参考文献检索：给一条文献条目找它的 PDF / 链接
  if (pathname === '/api/ref-search') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return sendJson(res, 400, { error: { message: '缺少 q' } });
    try {
      const out = await searchReference(q, { reading: url.searchParams.get('scope') === 'reading' });
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
    // 审计 §P0：明确告诉操作者当前认证状态（绝不打印 token 本身）
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
