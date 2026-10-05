/**
 * 测试隔离护栏。所有可写测试数据必须位于 test/artifacts/ 下；
 * 不再读取、覆盖或回写仓库/安装目录的 data/。
 */
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SANDBOX = path.resolve(import.meta.dirname, 'artifacts');

export function resolveDataDir(papersDir) {
  if (!papersDir) throw new Error('测试必须提供临时 papers 目录');
  return path.join(path.dirname(path.resolve(papersDir)), 'data');
}

export function assertIsolatedDataDir(dataDir) {
  const target = path.resolve(dataDir || '');
  const rel = path.relative(SANDBOX, target);
  if (!dataDir || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`拒绝测试真实数据目录：${target}`);
  }
  return target;
}

/* ────────────────────────── 本地 API 令牌（P0 认证） ──────────────────────────
   2026-10 安全加固后，除了 `/api/health`，所有 `/api/*` 都要带 `X-PRT-Token`。
   浏览器侧由服务注入的补丁自动附带；**Node 侧的 fetch 不会** —— 而在 18 个套件里
   一共有近百处 Node 侧 fetch。逐处去加请求头既容易漏、又会把测试改得满屏噪声。

   所以这里在模块加载时给 `globalThis.fetch` 打一次补丁：
     · 只对「本机 / 回环地址」的 `/api/` 请求加头 —— 打给别的服务（mock 上游、
       arxiv、openalex 等）的请求一个字节都不动，否则会把 mock 服务也带上头；
     · 只在 `PRT_API_TOKEN` 存在时加。没注入就保持默认行为，
       于是「没有令牌就该 401」这条断言仍然测得到（不是把安全关掉换绿）。

   这是**显式注入**：令牌由外部环境变量给，不是服务里的后门。 */
const API_TOKEN = process.env.PRT_API_TOKEN || '';

if (API_TOKEN) {
  const isLocalApi = (input) => {
    let url;
    try {
      url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input?.url);
    } catch { return false; }
    if (!url) return false;
    try {
      const u = new URL(url, 'http://127.0.0.1');
      const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1'
        || u.hostname === '[::1]';
      return local && u.pathname.startsWith('/api/');
    } catch { return false; }
  };

  const nativeFetch = globalThis.fetch;
  globalThis.fetch = function patchedFetch(input, init = {}) {
    if (!isLocalApi(input)) return nativeFetch(input, init);
    // 调用方自己写了头就尊重它（用 Headers 归一化，兼容对象 / 数组 / Headers 三种写法）
    const headers = new Headers(init.headers || (typeof input === 'object' && input?.headers) || {});
    if (!headers.has('X-PRT-Token')) headers.set('X-PRT-Token', API_TOKEN);
    return nativeFetch(input, { ...init, headers });
  };
}

export { ROOT, SANDBOX, API_TOKEN };

