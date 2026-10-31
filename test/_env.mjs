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

