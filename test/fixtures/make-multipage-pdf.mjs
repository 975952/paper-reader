/** Build a small deterministic, multi-page paper fixture for isolated browser tests. */
import fs from 'node:fs';
import path from 'node:path';

/* 默认 16 页；隔离测试可用 FIXTURE_PAGES 生成更多页（<=30 页会让「只读前 30 页」的旧实现漏掉尾部）。 */
const PAGE_COUNT = Number(process.env.FIXTURE_PAGES || 16);
const GROUP_COUNT = 4;
if (!Number.isInteger(PAGE_COUNT) || PAGE_COUNT < 4 || PAGE_COUNT % GROUP_COUNT !== 0) {
  throw new Error('FIXTURE_PAGES 必须是 4 的倍数且 >=4');
}
const childrenPerGroup = PAGE_COUNT / GROUP_COUNT;
/* 只在最后一页追加的探针文本：验证全文检索能命中靠后的页。 */
const LAST_PAGE_MARK = String(process.env.FIXTURE_LAST_MARK || '');

/* 正文排版常量：第一行基线 Y=740，行距 10（对应下面 content 里的 `72 740 Td` / `10 TL`）。
   书签目标必须指向**标题所在那一行的 Y**，否则「点目录顶到标题」根本无从验证。 */
const FIRST_LINE_Y = 740;
const LINE_LEADING = 10;
/** 第 index 行（从 0 开始）的基线 Y */
const lineY = (index) => FIRST_LINE_Y - index * LINE_LEADING;
/** 组标题（Section N）在页面上的行号：第 0 行是页眉/论文标题 */
const GROUP_HEADING_INDEX = 1;
/** 主题标题（Section N Topic M）的行号：组的第一页要给组标题让出一行 */
const topicHeadingIndex = (sibling) => (sibling === 0 ? GROUP_HEADING_INDEX + 1 : GROUP_HEADING_INDEX);

const objects = [];
const add = (value) => { objects.push(Buffer.from(value, 'ascii')); return objects.length; };

const catalogId = add('');
const pagesId = add('');
const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
const pageIds = [];
for (let p = 1; p <= PAGE_COUNT; p++) {
  const group = Math.floor((p - 1) / childrenPerGroup);
  const sibling = (p - 1) % childrenPerGroup;
  // 页面上真的写出标题文字，书签的 /XYZ Y 才有落点：
  // 每组第一页先写组标题（Section N），随后每页写主题标题（Section N Topic M）。
  const headings = [
    ...(sibling === 0 ? [`Section ${group + 1}`] : []),
    `Section ${group + 1} Topic ${sibling + 1}`,
  ];
  const lines = [
    p === 1 ? 'Attention Is All You Need: A Synthetic Test Paper' : `Synthetic Paper - Page ${p}`,
    ...headings,
    ...(p === 1 ? ['UniqueSignal marks the first isolated search hit.', 'The second UniqueSignal hit stays on the same page.'] : []),
    'Abstract: This test fixture discusses attention and the Transformer architecture.',
    'It contains no user data and is used only for automated reader regression tests.',
    'The model maps queries, keys, and values through scaled dot product attention.',
    'Multi-head attention allows the model to jointly attend to information.',
    'The encoder and decoder use residual connections and feed-forward layers.',
    'This paragraph provides selectable text for the PDF text layer assertions.',
    'A citation to the original architecture appears here [1].',
    'The following lines ensure enough text spans are present on each page.',
    'Experiments evaluate translation quality and computational complexity.',
    'Results are illustrative fixture content, not research findings or user papers.',
    'The attention mechanism computes weights from query and key representations.',
    'The value vectors are combined according to those normalized weights.',
    'Positional encodings represent token order in the input sequence.',
    'The model uses multiple layers to build contextual representations.',
    'This text also provides stable words for find and selection UI tests.',
    'Related work includes sequence models and neural machine translation.',
    'The reader should preserve page numbers and restore document progress.',
    'A reference marker [3-5] tests clickable citation detection.',
    'Automated tests must not depend on a users personal bookshelf contents.',
  ];
  for (let i = 1; i <= 45; i++) lines.push(`Supplementary fixture line ${i}: attention supports contextual sequence processing and evaluation.`);
  if (p === PAGE_COUNT) {
    lines.push('References', '[1] Vaswani et al. Attention Is All You Need. NeurIPS 2017.');
    if (LAST_PAGE_MARK) lines.push(LAST_PAGE_MARK);
  }
  // 自检：书签指向的 Y 必须真的是那一行标题，行号算错这里就直接炸，不留静默错位
  if (lines[topicHeadingIndex(sibling)] !== `Section ${group + 1} Topic ${sibling + 1}`) {
    throw new Error(`夹具行号错位：第 ${p} 页第 ${topicHeadingIndex(sibling)} 行不是主题标题`);
  }
  if (sibling === 0 && lines[GROUP_HEADING_INDEX] !== `Section ${group + 1}`) {
    throw new Error(`夹具行号错位：第 ${p} 页第 ${GROUP_HEADING_INDEX} 行不是组标题`);
  }
  let content = `BT\n/F1 9 Tf\n${LINE_LEADING} TL\n72 ${FIRST_LINE_Y} Td\n`;
  for (const line of lines) content += `(${line.replace(/[()\\]/g, '\\$&')}) Tj\nT*\n`;
  content += 'ET\n';
  const streamId = add(`<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}endstream`);
  const pageId = objects.length + 1;
  pageIds.push(pageId);
  add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${streamId} 0 R >>`);
}
const outlineRootId = objects.length + 1;
const groupIds = Array.from({ length: GROUP_COUNT }, (_, i) => outlineRootId + 1 + i);
const childIds = Array.from({ length: PAGE_COUNT }, (_, i) => outlineRootId + 1 + GROUP_COUNT + i);
add(`<< /Type /Outlines /First ${groupIds[0]} 0 R /Last ${groupIds.at(-1)} 0 R /Count ${PAGE_COUNT + GROUP_COUNT} >>`);
for (let group = 0; group < GROUP_COUNT; group++) {
  const firstChild = group * childrenPerGroup;
  const lastChild = firstChild + childrenPerGroup - 1;
  const page = firstChild + 1;
  const links = `${group ? `/Prev ${groupIds[group - 1]} 0 R ` : ''}${group + 1 < GROUP_COUNT ? `/Next ${groupIds[group + 1]} 0 R ` : ''}`;
  add(`<< /Title (Section ${group + 1}) /Parent ${outlineRootId} 0 R ${links}/First ${childIds[firstChild]} 0 R /Last ${childIds[lastChild]} 0 R /Count ${childrenPerGroup} /Dest [${pageIds[page - 1]} 0 R /XYZ null ${lineY(GROUP_HEADING_INDEX)} null] >>`);
}
for (let i = 0; i < PAGE_COUNT; i++) {
  const group = Math.floor(i / childrenPerGroup);
  const groupStart = group * childrenPerGroup;
  const sibling = i - groupStart;
  const links = `${sibling ? `/Prev ${childIds[i - 1]} 0 R ` : ''}${sibling + 1 < childrenPerGroup ? `/Next ${childIds[i + 1]} 0 R ` : ''}`;
  add(`<< /Title (Section ${group + 1} Topic ${sibling + 1}) /Parent ${groupIds[group]} 0 R ${links}/Dest [${pageIds[i]} 0 R /XYZ null ${lineY(topicHeadingIndex(sibling))} null] >>`);
}
objects[catalogId - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R /Outlines ${outlineRootId} 0 R /PageMode /UseOutlines >>`, 'ascii');
objects[pagesId - 1] = Buffer.from(`<< /Type /Pages /Count ${PAGE_COUNT} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`, 'ascii');

const chunks = [Buffer.from('%PDF-1.4\n%TEST\n', 'ascii')];
const offsets = [0];
let offset = chunks[0].length;
for (let i = 0; i < objects.length; i++) {
  offsets.push(offset);
  const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'ascii'), objects[i], Buffer.from('\nendobj\n', 'ascii')]);
  chunks.push(chunk); offset += chunk.length;
}
const xrefOffset = offset;
let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const at of offsets.slice(1)) xref += `${String(at).padStart(10, '0')} 00000 n \n`;
chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'ascii'));
const dest = process.env.FIXTURE_OUT || path.join(import.meta.dirname, 'multipage-sample.pdf');
fs.writeFileSync(dest, Buffer.concat(chunks));
console.log(`Created ${dest} (${PAGE_COUNT} pages)`);
