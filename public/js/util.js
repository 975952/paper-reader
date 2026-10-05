/* 小工具集合 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function debounce(fn, ms = 200) {
  let t = null;
  let lastArgs = null;
  const wrapped = (...a) => {
    lastArgs = a;
    clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...a); }, ms);
  };
  wrapped.cancel = () => { clearTimeout(t); t = null; };
  /** 立刻执行还没触发的那一次（关页面前落盘用） */
  wrapped.flush = () => {
    if (!t) return false;
    clearTimeout(t);
    t = null;
    fn(...(lastArgs || []));
    return true;
  };
  return wrapped;
}

export function throttle(fn, ms = 100) {
  let last = 0;
  let timer = null;
  return (...a) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...a);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(...a);
      }, ms - (now - last));
    }
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function fmtSize(bytes) {
  if (!bytes) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

export function toast(msg, kind = '', ms = 2600) {
  const wrap = $('#toastWrap');
  if (!wrap) return;
  const node = el('div', { class: `toast ${kind}`, text: msg });
  wrap.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s, transform .25s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(8px)';
    setTimeout(() => node.remove(), 260);
  }, ms);
}

export function toastAction(msg, label, action, kind = 'err', ms = 7000) {
  const wrap = $('#toastWrap');
  if (!wrap) return;
  const retry = async () => {
    try { await action(); }
    catch (e) { toastAction(`重试失败：${e?.message || e}`, label, retry, kind, ms); }
  };
  const node = el('div', { class: `toast ${kind}` }, el('span', { text: msg }), el('button', {
    type: 'button', text: label, onclick: async () => {
      node.remove();
      await retry();
    },
  }));
  wrap.append(node);
  setTimeout(() => node.remove(), ms);
}

/* ---------------------------------------------------------------- 选区清洗 */

/**
 * 论文 PDF 的文本层会把连字符断行、列切换都塞进选区。
 * 这里把选中的原始文本还原成适合翻译/提问的连续文本。
 */
export function cleanText(raw) {
  if (!raw) return '';
  let t = raw.replace(/\r\n?/g, '\n');
  t = t.replace(/[ \t]*\n[ \t]*/g, '\n');          // 去掉行首行尾空白
  t = t.replace(/([A-Za-z])-\n([a-z])/g, '$1$2');   // 处理断词连字符
  t = t.replace(/\n{2,}/g, '\u0000');               // 段落占位
  t = t.replace(/\n/g, ' ');                        // 段内换行变空格
  t = t.replace(/\u0000/g, '\n\n');
  t = t.replace(/[ \t]{2,}/g, ' ');
  return t.trim();
}

/**
 * 数学公式渲染：$...$、$$...$$、\(...\)、\[...\]。
 *
 * 之前这里写着「行内公式保留原样，交给用户看」，于是模型输出的一堆
 *   \text{Attention}(Q,K,V)=\text{softmax}(\frac{QK^T}{\sqrt{d_k}})V
 * 就原样显示成 LaTeX 源码 —— 用户看到的「符号渲染不了」就是这个。
 *
 * 用本地内置的 KaTeX（public/vendor/katex，不联网）。
 * 渲染失败（比如 $ 只是货币符号、或者模型写错命令）就原样返回：
 * 绝不吞内容，也绝不把 KaTeX 的红色报错塞进回答里。
 */
const MATH_MAX_LEN = 3000;

export function renderMathToString(tex, display = false) {
  const katex = globalThis.katex;
  const body = String(tex || '').trim();
  if (!katex || !body || body.length > MATH_MAX_LEN) return null;
  try {
    return katex.renderToString(body, {
      displayMode: !!display,
      throwOnError: true,   // 出错抛异常 → 上层退回原文
      strict: 'ignore',
      trust: false,         // 禁掉 \htmlClass 这类越权命令
      maxSize: 12,
    });
  } catch {
    return null;
  }
}

/**
 * 表格：
 *   | 列1 | 列2 |
 *   |---|---|
 *   | a | b |
 * 判定写得宽松一些 —— 模型输出的分隔行经常长成 `|---|:--:|`，两端也可能没有竖线。
 */
function isTableSep(line) {
  const t = String(line || '').trim();
  if (!t || !t.includes('-')) return false;
  return /^\|?[\s:|-]*\|?$/.test(t);
}

/** 拆一行单元格。`\|` 是转义过的竖线，不能当分隔符 */
function splitTableRow(line) {
  const raw = String(line || '').trim();
  const body = raw.replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && body[i + 1] === '|') { cur += '|'; i++; continue; }
    if (body[i] === '|') { cells.push(cur); cur = ''; continue; }
    cur += body[i];
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function renderTable(head, rows) {
  const n = Math.max(1, head.length);
  const pad = (arr) => {
    const out = arr.slice(0, n);
    while (out.length < n) out.push('');
    return out;
  };
  const th = pad(head).map((c) => `<th>${c}</th>`).join('');
  const tb = rows.map((r) => `<tr>${pad(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  // 外层 div 管横向滚动：侧栏很窄，宽表格不能把面板撑破
  return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`;
}

/**
 * 极简 Markdown 渲染：够用于模型输出（标题、列表、粗体、行内代码、公式、表格）。
 * 全程转义 HTML，避免模型输出注入。
 */
export function renderMarkdown(src) {
  if (!src) return '';
  const blocks = [];
  const hold = (html) => {
    blocks.push(html);
    return `\u0000${blocks.length - 1}\u0000`;
  };

  let text = String(src);

  // 模型常把一个段落吐成三到六个空行；正文只保留一个段落间隔。
  // 代码围栏内部必须原样保留，避免破坏示例代码的行号和缩进。
  const markdownParts = text.split(/(```[\s\S]*?```)/g);
  for (let i = 0; i < markdownParts.length; i += 2) {
    markdownParts[i] = markdownParts[i].replace(/\n[ \t]*(?:\n[ \t]*){2,}/g, '\n\n');
  }
  text = markdownParts.join('');

  // 1) 围栏代码块
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => (
    hold(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`)
  ));
  // 2) 行内代码先摘出来：里面的 $ 不该被当成公式
  text = text.replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${escapeHtml(c)}</code>`));
  // 3) 公式。必须在 escapeHtml 之前 —— 否则 $ 和 \ 已经被转义，KaTeX 就认不出来了。
  //    $$ 要在 $ 之前处理，否则 $$x$$ 会被拆成两个行内公式。
  const math = (tex, display, raw) => {
    const html = renderMathToString(tex, display);
    return html === null ? raw : hold(html);
  };
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (raw, tex) => math(tex, true, raw));
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (raw, tex) => math(tex, true, raw));
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (raw, tex) => math(tex, false, raw));
  // 行内公式用 pandoc 的规矩：开头的 $ 右边不能是空格、结尾的 $ 左边不能是空格、
  // 后面不能紧跟数字。不然「价格是 $5 到 $10」里的两个 $ 会被当成一对公式，
  // 把中间的汉字渲染进公式里、还把 $ 吃掉。
  text = text.replace(/\$(?![\s$])([^\n$]*?[^\s$])\$(?!\d)/g, (raw, tex) => math(tex, false, raw));

  text = escapeHtml(text);

  // 行内代码（兜底：第 2 步没摘走的）
  text = text.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);
  // 粗体 / 斜体
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // 列表 / 表格 / 标题
  const lines = text.split('\n');
  const out = [];
  let inList = null;
  const closeList = () => { if (inList) { out.push(`</${inList}>`); inList = null; } };
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].replace(/\s+$/, '');
    let m;
    // 表格：本行是 | a | b |，下一行是 |---|---|
    if (line.includes('|') && li + 1 < lines.length && isTableSep(lines[li + 1])) {
      const head = splitTableRow(line);
      const rows = [];
      let j = li + 2;
      while (j < lines.length && lines[j].trim() && lines[j].includes('|')) {
        rows.push(splitTableRow(lines[j]));
        j++;
      }
      closeList();
      // 表格是块级元素，用占位符递出去（不然会被包进 <p> 里，浏览器会把 table 甩出去）
      out.push('', hold(renderTable(head, rows)), '');
      li = j - 1;
      continue;
    }
    if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) {
      if (inList !== 'ul') { closeList(); out.push('<ul>'); inList = 'ul'; }
      out.push(`<li>${m[1]}</li>`);
    } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      if (inList !== 'ol') { closeList(); out.push('<ol>'); inList = 'ol'; }
      out.push(`<li>${m[1]}</li>`);
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      closeList();
      const lv = Math.min(6, m[1].length + 2);
      out.push(`<h${lv}>${m[2]}</h${lv}>`);
    } else if (!line.trim()) {
      // 列表项目之间的空行仍属于同一个列表，避免完成渲染时拆成多个
      // <ul>/<ol>，导致列表外边距叠加成明显的大空行。
      if (inList) continue;
      closeList();
      out.push('');
    } else {
      closeList();
      out.push(line);
    }
  }
  closeList();
  text = out.join('\n');
  text = text.replace(/\n{2,}/g, '</p><p>');
  text = text.replace(/\n/g, '<br />');
  // 列表项之间的源码换行不应渲染成额外的可见换行。
  text = text.replace(/<\/li>\s*<br \/>/g, '</li>');
  text = text.replace(/<br \/>\s*<li>/g, '<li>');
  text = `<p>${text}</p>`;
  text = text.replace(/<p>\s*<\/p>/g, '');
  // 独立成段的占位块（代码块 / 表格）先脱掉 <p>，再统一还原
  text = text.replace(/<p>\s*(\u0000\d+\u0000)\s*<\/p>/g, '$1');
  /**
   * 还原要**循环**做，不能只替换一遍：
   * 表格这种块本身也是占位符，里面还嵌着单元格的公式占位符；
   * String.replace 不会回头再扫一遍替换进去的内容，一遍下来内层的 \u0000N\u0000
   * 就原样留在 HTML 里了（表现：表格里的公式不渲染）。
   */
  for (let k = 0; k < 8 && /\u0000\d+\u0000/.test(text); k++) {
    text = text.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  }
  // 代码块被包进 <p> 里了，去掉
  text = text.replace(/<p>\s*(<pre>)/g, '$1').replace(/(<\/pre>)\s*<\/p>/g, '$1');
  // 块级公式也是块，别被 <p> 裹着
  text = text.replace(/<p>\s*(<span class="katex-display")/g, '$1');
  return text;
}

/**
 * 安全批量插入子节点。
 * 注意：原生 Element.append(null) 会把 null 转成字符串 "null" 插进 DOM，
 * 条件渲染的按钮很容易踩这个坑，所以统一走这里。
 */
export function appendAll(parent, ...children) {
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    parent.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return parent;
}
