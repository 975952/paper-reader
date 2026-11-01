/**
 * 预算与裁剪（A 线 P1 先只提供估算与硬上限；P3 才真正裁剪）。
 *
 * 裁剪顺序按 docs/提示词工程-设计.md §9.2 固定，并且**永不裁剪**：
 * 身份/基础规则/任务段/契约、当前问题、当前选区、当前页头、截图规则、扫描件规则。
 */

/** CJK 友好的 token 估算（零依赖，纯函数）：CJK ≈ 1 token/字；拉丁 ≈ 3.2 字符/token */
export function estimateTokens(text) {
  const s = String(text || '');
  let cjk = 0;
  for (const ch of s) if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) cjk += 1;
  const rest = s.length - cjk;
  return Math.ceil(cjk + rest / 3.2);
}

/** 单次请求硬上限（约 38 万字符，覆盖 128k 上下文模型） */
export const HARD_TOKENS = 120000;

/** 视觉请求里每张图的估算 token（长边 1800 JPEG） */
export const IMAGE_TOKENS = 1200;
export const MAX_PAGE_IMAGES = 6;
export const MAX_SCREENSHOTS = 6;

/** 固定裁剪顺序（测试断言这个数组的顺序，防止以后拍脑袋改） */
export const TRIM_ORDER = [
  'web',            // 1. 联网结果：从末条开始删，每条截到 2000 字符
  'references',     // 2. 参考文献书目：只留前 3 条
  'fulltext',       // 3. 全文/索引：相关段落从后往前删；索引保留
  'pageContext',    // 4. 所在页上下文：8000 → 4000 → 2000
  'paperMemory',    // 5. 论文旧讨论摘要：1800 → 900
  'profileItems',   // 6. 画像条目：推测 → 自述 → 仍需讲解（身份/偏好最后）
  'longTerm',       // 7. 长期记忆：4000 → 2000
  'history',        // 8. 历史：从最旧一轮开始成对删
  'sessionSummary', // 9. 会话摘要：1200 → 600
];

/** 永不裁剪的块（P1 只登记；P3 裁剪器按这个名单跳过） */
export const NEVER_TRIM = ['identity', 'base', 'task', 'contract', 'question', 'selection', 'pageHead', 'screenshotRule', 'scanRule'];

/** 估算 messages 的 token（文本 + 图片张数） */
export function estimateMessagesTokens(messages = [], { images = 0 } = {}) {
  let total = images * IMAGE_TOKENS;
  for (const m of messages) {
    if (typeof m?.content === 'string') { total += estimateTokens(m.content); continue; }
    if (!Array.isArray(m?.content)) continue;
    let imgs = 0;
    for (const part of m.content) {
      if (!part) continue;
      if (part.type === 'text') total += estimateTokens(part.text || '');
      else if (part.type === 'image_url') imgs += 1;
    }
    total += imgs * IMAGE_TOKENS;
  }
  return total;
}
