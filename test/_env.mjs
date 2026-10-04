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

export { ROOT, SANDBOX };
