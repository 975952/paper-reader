
/**
 * 深入阅读两项操作。定义已迁到 ./prompts/capabilities/ops.js（A 线 P1），
 * 这里保留旧导出名与返回结构（app.js 用 OPS / opById，历史上有 COMMON_RULES / ADVANCED_OPS）。
 */
export { OPS, ADVANCED_OPS, opById } from './prompts/capabilities/ops.js';

/** 旧名兼容：所有操作共用的规矩（实现已迁 prompts/base.js 的 BASE_OPS） */
export { BASE_OPS as COMMON_RULES } from './prompts/base.js';
