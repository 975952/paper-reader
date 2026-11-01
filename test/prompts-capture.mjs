/**
 * A 线 P0：抓提示词黄金基线（在改造**之前**跑一次，结果进 test/fixtures/prompts-baseline.json）。
 *
 *   node test/prompts-capture.mjs
 *
 * 只调用现有前端纯函数（Node 可直接 import），不碰浏览器/网络/data/。
 * 同一份代码连跑两次必须完全一致，否则说明有未固定的时间或随机源。
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildAll, FIXED_NOW } from './_prompts.mjs';

const FILE = path.join(import.meta.dirname, 'fixtures', 'prompts-baseline.json');
const first = buildAll();
const second = buildAll();
if (JSON.stringify(first) !== JSON.stringify(second)) {
  console.error('场景输出不确定：连续两次构造结果不一致，先修掉随机源再抓基线');
  process.exit(1);
}
const names = Object.keys(first);
const payload = {
  note: 'A 线 P0 黄金基线：legacy 提示词构造的真实 messages。P1 起逐字节比对；文案改动必须先改基线并在 PROGRESS 记录。',
  fixedNow: FIXED_NOW.toISOString(),
  scenarios: names.length,
  messages: first,
};
fs.writeFileSync(FILE, JSON.stringify(payload, null, 2) + '\n');
console.log(`基线已写入：${FILE}`);
console.log(`场景数：${names.length}`);
for (const n of names) console.log(`  - ${n}（${first[n].length} 条消息）`);
