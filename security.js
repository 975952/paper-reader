/**
 * 安全与数据边界（server.js 专用，零依赖）
 *
 * 对应 docs/安全与数据边界审计.md：
 *   P0  本地 API 认证（不可预测的 per-boot token + 自定义请求头）
 *   P0  /api/chat 只使用已保存配置（禁止请求体覆盖 baseURL / apiKey / model）
 *   P1  /api/config 严格字段白名单 + 范围限制
 *   P1  按接口的请求体上限
 *   P2  错误信息脱敏、日志过滤
 *
 * 这里放的都是纯函数 + 常量，方便单独检查和复用。
 */
'use strict';

const crypto = require('crypto');

/* ==================================================================== P0 认证 */

/**
 * 启动时生成一次不可预测的 session token。
 * 32 字节 CSPRNG → 64 位十六进制；进程重启即失效。
 *
 * 测试可以显式注入 `PRT_API_TOKEN=<值>` 用固定值（审计 §P0 明确允许：
 * 「测试认证必须显式注入，不能依赖生产后门」）。**没有**任何隐式的后门 token：
 * 不注入就是随机值，注入的值就是唯一有效的值。
 */
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

/**
 * token 的注入与校验开关分离：
 *   - token 总是生成，也总是注入到「本服务自己吐出去的 index.html」；
 *   - 校验默认**开启**，显式 `PRT_REQUIRE_TOKEN=0` 才关掉（浏览器开发模式 / 尚未适配
 *     请求头的测试套件用它）。
 *
 * 注意：**不存在**「固定 token / 后门 token」之类的测试捷径。测试要过认证只能显式
 * 注入 `PRT_REQUIRE_TOKEN=0`，或者从它自己启动的进程里把 token 取出来 —— 生产路径
 * 上没有任何旁路（见 docs/安全与数据边界审计.md 验收要求最后一条）。
 */
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

/**
 * 机器可读的 token 输出行，给测试 harness 用。
 *
 * 为什么需要它：好几套测试自己 spawn 一个隔离的 `node server.js`，然后要用 HTTP 说话。
 * 它们必须有确定性的方式拿到 token，否则只能去改「默认关闭认证」——那才是真的后门。
 * 所以这里把 token **只打到 stdout 的这一行**，并且：
 *   * `PRT_API_TOKEN` 已注入 → 不打印（调用方本来就知道）；
 *   * `PRT_QUIET_TOKEN=1` → 不打印（交付的桌面版 / 不希望 token 落日志的场合）。
 * token 不出现在任何其它日志、错误信息或 DOM 文本里。
 */
function tokenAnnouncement() {
  if (isInjectedToken()) return null;
  if (process.env.PRT_QUIET_TOKEN === '1') return null;
  return `[prt] api-token: ${TOKEN}`;
}

/**
 * 免认证路径。
 *
 * 只有 `/api/health`：它是**存活探针**，返回体固定是 `{ ok, port }`，
 * 不含任何用户数据、不读盘、不写盘、不出网。测试套件靠轮询它来判断
 * 「隔离服务起来了没有」，而那时它们还没拿到 token ——
 * 如果它也要求 token，就会陷入「要先有 token 才能探测服务，可服务没起来就没法读 token」
 * 的死循环，测试只能退回「关掉认证」，反而更糟。
 */
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

/**
 * 这次请求有没有带上正确的 token。
 *
 * 子资源例外（只有 /api/pdf 的 GET/HEAD）：浏览器加载 `<embed src>` 或 PDF.js 直接
 * 用 XHR 取字节时无法附加自定义头，所以这里额外接受同源的 `prt_session` cookie。
 * 该 cookie 是 HttpOnly + SameSite=Strict、且只在「本服务吐出的 index.html」上种下，
 * 因此其它本地页面拿不到它、跨站请求也不会自动带上。
 */
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

/**
 * 附加防线：Origin / Referer 白名单。
 * **不能替代 token**（审计 §P0 第 4 条），只在 token 已经校验通过之后再看一眼，
 * 用来挡住「token 通过某种途径泄漏到别的页面」这种情况。
 * 两个头都没有时放行：非浏览器客户端（curl / 测试脚本）本来就不带。
 */
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
  return true;
}

/** 给 index.html 响应用的 Set-Cookie（子资源例外通道） */
function sessionCookieHeader() {
  return `${COOKIE}=${TOKEN}; Path=/; HttpOnly; SameSite=Strict`;
}

/** POST /api/state 这类写接口在 401/403 时**必须**在任何写盘之前返回 */
function unauthorized(res, sendJson) {
  sendJson(res, 401, { error: { message: '未授权：缺少或错误的本地访问令牌（请刷新页面）' } });
}

/* ==================================================================== P0 聊天 */

/**
 * /api/chat 允许出现在请求体里的字段。
 * 审计 §P0：只允许 messages / stream / temperature / max_tokens / 上下文范围。
 *
 * 明确**不再接受** baseURL / apiKey / model —— 它们只能来自 data/config.json。
 * 旧前端仍会带上它们，所以这里是「忽略」而不是 400：忽略同样满足
 * 「拿到本地 API 调用权的页面不能把 Key 转发到任意地址」。
 */
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

/* ==================================================================== P1 配置 */

/**
 * /api/config 的严格白名单（审计 §P1）。
 * 未知字段一律忽略；每个字段有自己的类型/范围/长度限制。
 *
 * 返回 { patch, ignored } —— ignored 只用于本地诊断日志，不回给前端。
 */
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

/**
 * 字符串字段的长度检查。
 *
 * 返回 `{ ok: value }` 或 `{ tooLong: true }` 或 `{ notString: true }`。
 *
 * **绝不截断**：审计 §P1 / §验收 明确要求「超限返回 413/400，不截断后静默保存」。
 * 从前这里是 `v.slice(0, n)` —— 一个 5000 字的 model 会被悄悄存成 256 字、
 * 接口还回 200，用户看到「保存成功」但设置已经被改坏了。
 */
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

/* ============================================================ P1 请求体上限 */

/** 按接口的请求体上限（审计 §P1：超限返回 413，不截断保存） */
const BODY_LIMITS = {
  config: 1 * 1024 * 1024,
  state: 1 * 1024 * 1024,
  notes: 4 * 1024 * 1024,
  session: 16 * 1024 * 1024,
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

/** /api/session 的校验：历史条目数 + 总字符数 + 附件元数据大小 */
function checkSession(payload) {
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

/* ============================================================== P2 脱敏 */

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

/**
 * 把一串文本里明显敏感的内容打码。
 *
 * 与 Rust `limits::scrub_text()` 逐条对齐：密文（Bearer / apiKey / token 的值）、
 * 本机绝对路径、本次 token 本身。
 */
function scrubText(s) {
  let t = String(s == null ? '' : s);
  t = t.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer ***');
  t = t.replace(/(sk-)[A-Za-z0-9._-]{6,}/gi, '$1***');
  // "apiKey": "xxx" / apiKey=xxx / Authorization: Bearer（截断的 JSON 也要打码）
  t = t.replace(/(["']?(?:apiKey|api_key|authorization|token|x-prt-token)["']?\s*[:=]\s*["']?)([^"'\s,}]{6,})/gi, '$1***');
  // 本机绝对路径：分隔符按「一个或多个 \ 或 /」处理，段内允许空格
  // （`C:\Users\Wang Wenbo\…` 与 JSON 转义过的 `C:\\Users\\Wang Wenbo\\…` 都能整段吃掉）
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
  countChars,
  diag,
  scrubText,
  sanitizeMessage,
  networkErrorMessage,
};
