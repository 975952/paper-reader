'use strict';

const crypto = require('crypto');


function makeToken() {
  const injected = process.env.PRT_API_TOKEN;
  if (typeof injected === 'string' && injected.trim()) {
    const v = injected.trim();
    if (v.length < 8) {
      console.error('[prt] PRT_API_TOKEN 太短（至少 8 个字符），已忽略并使用随机 token');
    } else {
      return v;
    }
  }
  return crypto.randomBytes(32).toString('hex');
}

const TOKEN = makeToken();

const ENFORCE = process.env.PRT_REQUIRE_TOKEN !== '0';

/** 自定义请求头。取不常见的名字，避免和任何现有中间件打架。 */
const HEADER = 'x-prt-token';
/** 子资源（<embed> / PDF.js 的 XHR 直取 / <img>）拿不到自定义头时用的会话 cookie。 */
const COOKIE = 'prt_session';

/** GET /api/pdf 是唯一被浏览器当子资源直接加载的接口，见下方 isSubresourceRequest() */
const SUBRESOURCE_PATH = '/api/pdf';

function getToken() {
  return TOKEN;
}

/** 这个 token 是调用方显式注入的（PRT_API_TOKEN）而不是本进程生成的 */
function isInjectedToken() {
  return typeof process.env.PRT_API_TOKEN === 'string'
    && process.env.PRT_API_TOKEN.trim() === TOKEN;
}

function tokenAnnouncement() {
  if (isInjectedToken()) return null;
  if (process.env.PRT_QUIET_TOKEN === '1') return null;
  return `[prt] api-token: ${TOKEN}`;
}

const PUBLIC_PATHS = new Set(['/api/health']);

function isEnforced() {
  return ENFORCE;
}

/**
 * 常量时间比较，避免按字节提前返回泄漏 token 前缀。
 * 长度不同直接返回 false（长度不是秘密，token 定长 64）。
 */
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}

/** 从 `Cookie: a=1; prt_session=xxx` 里取一个值 */
function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return '';
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

function authorized(req, pathname) {
  // 存活探针免认证（见 PUBLIC_PATHS 的说明）
  if (PUBLIC_PATHS.has(pathname)) return true;

  const headerValue = req.headers[HEADER];
  let presented = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (presented instanceof Buffer) presented = presented.toString('utf8');
  if (safeEqual(presented, TOKEN)) return true;

  const isSubresource = pathname === SUBRESOURCE_PATH
    && (req.method === 'GET' || req.method === 'HEAD');
  if (isSubresource && safeEqual(readCookie(req, COOKIE), TOKEN)) return true;
  return false;
}

const ALLOWED_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(\.)?(:\d+)?$/i;

function originAllowed(req) {
  const origin = req.headers.origin;
  if (origin) return ALLOWED_ORIGIN_RE.test(String(origin).trim());
  const referer = req.headers.referer;
  if (referer) {
    try {
      return ALLOWED_ORIGIN_RE.test(new URL(String(referer)).origin);
    } catch {
      return false;
    }
  }
  return false;
}

/** 给 index.html 响应用的 Set-Cookie（子资源例外通道） */
function sessionCookieHeader() {
  return `${COOKIE}=${TOKEN}; Path=/; HttpOnly; SameSite=Strict`;
}

/** POST /api/state 这类写接口在 401/403 时**必须**在任何写盘之前返回 */
function unauthorized(res, sendJson) {
  sendJson(res, 401, { error: { message: '未授权：缺少或错误的本地访问令牌（请刷新页面）' } });
}


const CHAT_FIELDS = new Set([
  'messages', 'stream', 'temperature', 'max_tokens', 'idleMs',
  // 上下文 / 范围类（前端将来的扩展字段，不参与上游请求体构造）
  'context', 'scope', 'doc', 'docId', 'page', 'files', 'meta', 'webResults',
]);

/** 请求体里出现这些字段说明调用方在尝试覆盖密钥 / 地址 / 模型 */
const CHAT_FORBIDDEN = ['baseURL', 'baseUrl', 'apiKey', 'apikey', 'model', 'visionModel', 'endpoint'];

const LIMITS = {
  temperature: { min: 0, max: 2 },
  maxTokens: { min: 1, max: 131072 },
  idleMs: { min: 1000, max: 900000 },
  fontSize: { min: 8, max: 40 },
  // 字符串长度上限（UTF-16 单元）
  str: {
    apiKey: 4096,
    baseURL: 2048,
    model: 256,
    visionModel: 256,
    targetLang: 32,
    theme: 16,
    glossary: 100000,
  },
};

/** 有限数字；否则 null */
function finiteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 夹到 [min, max]；非数字返回 null */
function clampNumber(v, min, max) {
  const n = finiteNumber(v);
  if (n === null) return null;
  return Math.min(max, Math.max(min, n));
}

/**
 * 请求体里的 temperature：必须在 [0,2] 内，超范围直接报错（不是静默改写）。
 * 返回 { value } 或 { error }。
 */
function pickTemperature(v, fallback) {
  if (v === undefined || v === null) return { value: fallback };
  const n = finiteNumber(v);
  if (n === null) return { error: 'temperature 必须是数字' };
  if (n < LIMITS.temperature.min || n > LIMITS.temperature.max) {
    return { error: `temperature 超出范围（允许 ${LIMITS.temperature.min} ~ ${LIMITS.temperature.max}）` };
  }
  return { value: n };
}

/** max_tokens：正整数，且有上限 */
function pickMaxTokens(v) {
  if (v === undefined || v === null || v === '') return { value: null };
  const n = finiteNumber(v);
  if (n === null || !Number.isInteger(n) || n <= 0) {
    return { error: 'max_tokens 必须是正整数' };
  }
  if (n > LIMITS.maxTokens.max) {
    return { error: `max_tokens 超出上限（最大 ${LIMITS.maxTokens.max}）` };
  }
  return { value: n };
}


const CONFIG_FIELDS = [
  'apiKey', 'baseURL', 'model', 'visionModel', 'targetLang',
  'temperature', 'stream', 'idleMs', 'theme', 'fontSize', 'glossary',
];

/** URL 必须是 http/https、无凭证、无控制字符 */
function validUrlString(raw) {
  const s = String(raw).trim();
  if (!s || s.length > LIMITS.str.baseURL) return null;
  // 控制字符（含 \r \n \t）
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;     // 禁止 URL 里带凭证
  if (!u.hostname) return null;
  // 结尾的点（localhost. / 127.0.0.1.）拒绝：留着它会让任何按主机名做的判断失效
  if (/\.$/.test(u.hostname)) return null;
  return s;
}

function boundedString(v, n) {
  if (typeof v !== 'string') return { notString: true };
  if (v.length > n) return { tooLong: true, limit: n };
  return { ok: v };
}

function sanitizeConfigPatch(patch) {
  const out = {};
  const ignored = [];
  const capped = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { patch: out, ignored: ['<非对象请求体>'], capped };
  }
  for (const key of Object.keys(patch)) {
    if (!CONFIG_FIELDS.includes(key)) { ignored.push(key); continue; }

    const v = patch[key];
    switch (key) {
      case 'apiKey': {
        const s = boundedString(v, LIMITS.str.apiKey);
        if (s.tooLong) { capped.push({ field: key, limit: LIMITS.str.apiKey }); break; }
        if (s.notString) { ignored.push(key); break; }
        // 空字符串 = 「保留原来的 Key」，由调用方处理
        out.apiKey = s.ok;
        break;
      }
      case 'baseURL': {
        // 空字符串表示「不改」（前端可能传空），非空必须是合法 http(s) URL
        if (v === '') { out.baseURL = ''; break; }
        if (typeof v === 'string' && v.length > LIMITS.str.baseURL) {
          capped.push({ field: key, limit: LIMITS.str.baseURL });
          break;
        }
        const s = validUrlString(v);
        if (s === null) { ignored.push(key); break; }
        out.baseURL = s;
        break;
      }
      case 'model':
      case 'visionModel': {
        const s = boundedString(v, LIMITS.str[key]);
        if (s.tooLong) { capped.push({ field: key, limit: LIMITS.str[key] }); break; }
        if (s.notString) { ignored.push(key); break; }
        out[key] = s.ok;
        break;
      }
      case 'targetLang': {
        const s = boundedString(v, LIMITS.str.targetLang);
        if (s.tooLong) { capped.push({ field: key, limit: LIMITS.str.targetLang }); break; }
        if (s.notString) { ignored.push(key); break; }
        out.targetLang = s.ok;
        break;
      }
      case 'theme': {
        if (v !== 'light' && v !== 'dark') { ignored.push(key); break; }
        out.theme = v;
        break;
      }
      case 'glossary': {
        const s = boundedString(v, LIMITS.str.glossary);
        if (s.tooLong) { capped.push({ field: key, limit: LIMITS.str.glossary }); break; }
        if (s.notString) { ignored.push(key); break; }
        out.glossary = s.ok;
        break;
      }
      case 'temperature': {
        // 设置页是滑块/输入框：这里夹取而不是 400，避免把用户的其它改动一起丢掉
        const n = clampNumber(v, LIMITS.temperature.min, LIMITS.temperature.max);
        if (n === null) { ignored.push(key); break; }
        out.temperature = n;
        break;
      }
      case 'idleMs': {
        const n = clampNumber(v, LIMITS.idleMs.min, LIMITS.idleMs.max);
        if (n === null) { ignored.push(key); break; }
        out.idleMs = Math.round(n);
        break;
      }
      case 'fontSize': {
        const n = clampNumber(v, LIMITS.fontSize.min, LIMITS.fontSize.max);
        if (n === null) { ignored.push(key); break; }
        out.fontSize = Math.round(n);
        break;
      }
      case 'stream': {
        if (typeof v !== 'boolean') { ignored.push(key); break; }
        out.stream = v;
        break;
      }
      default:
        ignored.push(key);
    }
  }
  return { patch: out, ignored, capped };
}


/** 按接口的请求体上限（审计 §P1：超限返回 413，不截断保存） */
const BODY_LIMITS = {
  config: 1 * 1024 * 1024,
  state: 1 * 1024 * 1024,
  // 书架顺序（/api/papers 的 POST）：一个文件名数组，正常只有几百字节
  papers: 1 * 1024 * 1024,
  notes: 4 * 1024 * 1024,
  session: 16 * 1024 * 1024,
  // 图片附件（/api/attachment 的 POST）：单张截图的上限，与 server.js 的 ATTACHMENT_LIMIT 一致。
  // 图片单独存成文件，不进会话 JSON —— 所以这里给的是「单张图」的上限，不是整个会话的。
  attachment: 8 * 1024 * 1024,
  // 学习档案：全局一份，正常几 KB；给足余量但不允许被当成大数据仓库
  profile: 512 * 1024,
  chat: 64 * 1024 * 1024,
  upload: 256 * 1024 * 1024,
};

/** notes / session 的条目数与总字符数上限 */
const CONTENT_LIMITS = {
  notes: { maxItems: 5000, maxChars: 4 * 1024 * 1024 },
  session: { maxItems: 5000, maxChars: 8 * 1024 * 1024, maxBytes: 4 * 1024 * 1024 },
};

function countChars(v) {
  if (typeof v === 'string') return v.length;
  if (Array.isArray(v)) return v.reduce((n, x) => n + countChars(x), 0);
  if (v && typeof v === 'object') {
    let n = 0;
    for (const k of Object.keys(v)) n += k.length + countChars(v[k]);
    return n;
  }
  return 0;
}

/** /api/notes 的校验：条目数 + 总字符数 */
function checkNotes(items) {
  const lim = CONTENT_LIMITS.notes;
  if (!Array.isArray(items)) return 'notes.items 必须是数组';
  if (items.length > lim.maxItems) return `笔记条目过多（上限 ${lim.maxItems} 条）`;
  if (countChars(items) > lim.maxChars) return '笔记内容过大，请分文档保存';
  return null;
}

/** /api/session 的校验：历史条目数 + 总字符数 + 附件元数据大小 */function checkSession(payload) {
  const lim = CONTENT_LIMITS.session;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return '会话必须是对象';
  }
  for (const key of ['entries', 'history', 'ops', 'attachments', 'files']) {
    const v = payload[key];
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length > lim.maxItems) return `会话 ${key} 条目过多（上限 ${lim.maxItems} 条）`;
    }
  }
  if (countChars(payload) > lim.maxChars) return '会话内容过大';
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  } catch {
    return '会话包含无法序列化的内容';
  }
  if (bytes > lim.maxBytes) return '会话体积过大';
  return null;
}

const PROFILE_LIMITS = {
  maxItems: 200,
  maxTotalChars: 400000,
  maxTopic: 120,
  maxLevel: 300,
  maxBoundary: 2000,
  maxSelfReport: 4000,
  maxNote: 2000,
};

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:[+-]\d{2}:\d{2}|Z)$/;

function checkProfile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: '学习档案必须是对象' };
  if (Number(raw.version) !== 1) return { error: '学习档案版本不支持' };
  if (!Array.isArray(raw.items)) return { error: '学习档案缺少 items 数组' };
  if (raw.items.length > PROFILE_LIMITS.maxItems) return { error: `学习档案条目过多（上限 ${PROFILE_LIMITS.maxItems} 条）` };
  const items = [];
  for (const it of raw.items) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) return { error: '学习档案条目必须是对象' };
    const topic = typeof it.topic === 'string' ? it.topic.trim() : '';
    if (!topic) return { error: '学习档案条目缺少 topic' };
    if (topic.length > PROFILE_LIMITS.maxTopic) return { error: '学习档案知识点名称过长' };
    const status = it.status === 'pending' || it.status === 'confirmed' ? it.status : null;
    if (!status) return { error: '学习档案条目状态不合法' };
    const basis = ['user_confirmed', 'user_self_report', 'model_inferred'].includes(it.basis) ? it.basis : 'user_confirmed';
    const level = typeof it.level === 'string' ? it.level.slice(0, PROFILE_LIMITS.maxLevel) : '';
    const boundary = typeof it.boundary === 'string' ? it.boundary.slice(0, PROFILE_LIMITS.maxBoundary) : '';
    if (level.length > PROFILE_LIMITS.maxLevel || boundary.length > PROFILE_LIMITS.maxBoundary) return { error: '学习档案条目过长' };
    const stamp = (v) => (typeof v === 'string' && ISO_LIKE.test(v) ? v : null);
    const createdAt = stamp(it.createdAt);
    if (!createdAt) return { error: '学习档案条目缺少合法的 createdAt 时间' };
    const aliases = (Array.isArray(it.aliases) ? it.aliases : []).filter((a) => typeof a === 'string' && a.trim())
      .slice(0, 8).map((a) => a.trim().slice(0, PROFILE_LIMITS.maxTopic));
    items.push({
      id: typeof it.id === 'string' && it.id.trim() ? it.id.trim().slice(0, 80) : `kp-${items.length}`,
      topic: topic.slice(0, PROFILE_LIMITS.maxTopic),
      aliases,
      level,
      boundary,
      basis,
      status,
      createdAt,
      updatedAt: stamp(it.updatedAt) || createdAt,
      lastConfirmedAt: stamp(it.lastConfirmedAt),
      source: it.source && typeof it.source === 'object' ? {
        docId: typeof it.source.docId === 'string' ? it.source.docId.slice(0, 120) : '',
        paper: typeof it.source.paper === 'string' ? it.source.paper.slice(0, 300) : '',
        capability: typeof it.source.capability === 'string' ? it.source.capability.slice(0, 40) : '',
      } : null,
      note: typeof it.note === 'string' ? it.note.slice(0, PROFILE_LIMITS.maxNote) : '',
      memory: it.memory && ['knowledge', 'preference'].includes(it.memory.kind)
        && ['self_report', 'needs_help', 'demonstrated', 'inferred', 'preference'].includes(it.memory.signal) ? {
          kind: it.memory.kind,
          scope: it.memory.scope === 'paper' ? 'paper' : 'global',
          signal: it.memory.signal,
          evidence: typeof it.memory.evidence === 'string' ? it.memory.evidence.trim().slice(0, 500) : '',
        } : null,
    });
  }
  const selfReport = typeof raw.selfReport === 'string' ? raw.selfReport.trim().slice(0, PROFILE_LIMITS.maxSelfReport) : '';
  const value = {
    version: 1,
    revision: Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
    updatedAt: typeof raw.updatedAt === 'string' && ISO_LIKE.test(raw.updatedAt) ? raw.updatedAt : '',
    selfReport,
    selfReportAt: typeof raw.selfReportAt === 'string' && ISO_LIKE.test(raw.selfReportAt) ? raw.selfReportAt : '',
    items,
  };
  if (countChars(value) > PROFILE_LIMITS.maxTotalChars) return { error: '学习档案内容过大' };
  return { value };
}


/**
 * 诊断日志：只在本地打印，绝不进 HTTP 响应。
 * 显式过滤 Authorization / apiKey / token，避免把密钥写进日志。
 */
function diag(...args) {
  try {
    const parts = args.map((a) => (typeof a === 'string' ? scrubText(a) : scrubText(safeStringify(a))));
    console.error('[diag]', ...parts);
  } catch { /* 日志失败不能影响请求 */ }
}

function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function scrubText(s) {
  let t = String(s == null ? '' : s);
  t = t.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer ***');
  t = t.replace(/(sk-)[A-Za-z0-9._-]{6,}/gi, '$1***');
  // "apiKey": "xxx" / apiKey=xxx / Authorization: Bearer（截断的 JSON 也要打码）
  t = t.replace(/(["']?(?:apiKey|api_key|authorization|token|x-prt-token)["']?\s*[:=]\s*["']?)([^"'\s,}]{6,})/gi, '$1***');
  // 本机绝对路径：分隔符按「一个或多个 \ 或 /」处理，段内允许空格
  // （`C:\Users\John Doe\…` 与 JSON 转义过的 `C:\\Users\\John Doe\\…` 都能整段吃掉）
  t = t.replace(/[A-Za-z]:[\\/](?:[^"',;)\]}]+|[ ][^\\/"',;)\]}\s])*/g, '<path>');
  t = t.replace(/\\\\[A-Za-z0-9_][^"',;)\]}]*/g, '<path>');
  t = t.replace(/\/(?:Users|home|root|var|tmp|opt|private)\/[^\s"',;)]*/g, '<path>');
  // token 本身（万一被拼进 URL 或错误串）
  if (TOKEN) t = t.split(TOKEN).join('***');
  return t;
}

/**
 * 把底层异常 / 上游响应变成可以给用户看的文案。
 * 保留可操作信息，去掉完整 URL、本机路径、底层网络错误原文。
 */
function sanitizeMessage(msg, fallback) {
  const raw = String(msg == null ? '' : msg).trim();
  if (!raw) return fallback || '操作失败，请重试';
  let t = scrubText(raw);
  // 上游返回体里带完整 URL / 堆栈时，只留第一行、限长
  const firstLine = t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || '';
  t = firstLine.slice(0, 300);
  if (!t) return fallback || '操作失败，请重试';
  return t;
}

/**
 * 网络类错误 → 用户文案。
 * Node 的 fetch 失败信息形如 "fetch failed" / "connect ECONNREFUSED 127.0.0.1:9"，
 * 里面既没有 URL 也没有路径，仍然统一走 sanitizeMessage 过一遍。
 */
function networkErrorMessage(prefix, err) {
  const detail = sanitizeMessage(err && err.message, '网络请求失败');
  return `${prefix}：${detail}。请检查网络 / 代理设置。`;
}

module.exports = {
  TOKEN,
  HEADER,
  COOKIE,
  SUBRESOURCE_PATH,
  PUBLIC_PATHS,
  getToken,
  isInjectedToken,
  tokenAnnouncement,
  isEnforced,
  safeEqual,
  authorized,
  originAllowed,
  sessionCookieHeader,
  unauthorized,
  CHAT_FIELDS,
  CHAT_FORBIDDEN,
  LIMITS,
  CONFIG_FIELDS,
  BODY_LIMITS,
  CONTENT_LIMITS,
  clampNumber,
  finiteNumber,
  pickTemperature,
  pickMaxTokens,
  sanitizeConfigPatch,
  validUrlString,
  checkNotes,
  checkSession,
  checkProfile,
  PROFILE_LIMITS,
  countChars,
  diag,
  scrubText,
  sanitizeMessage,
  networkErrorMessage,
};
