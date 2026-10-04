/**
 * 手机版阅读器（public/mobile/mobile.js）
 *
 * 用户口径（2026-10-03）：
 *   「阅读的时候要只显示 pdf 本身。pdf 字体如果能放大就很好，图片的大小不变。
 *     或者说图片长按可以单独放大查看。然后也是长按选词。然后界面就不要做伸缩了，
 *     字体在设置调节。手机版的。」
 *
 * 这个模块**只做阅读**，故意不引入桌面版的任何 AI 代码（app.js / ai.js / ops.js 都不 import）：
 *   · 打开 PDF（本地选择的文件优先，其次 URL 上的 ?open=）
 *   · 上下滚动阅读；底部页码切页
 *   · 点屏幕中间唤出 / 收起顶栏（手机没有 hover）
 *   · **长按选词**：长按落在哪个词上就选哪个词，并弹出操作条（复制 / 选一个词 / 整段）
 *   · **字号只改文字**：--m-text-boost 作用在文本层的 span 上，canvas 位图不动，
 *     所以图片、表格、公式的尺寸一个像素都不变
 *   · 页面底色 / 阅读区底色 / 翻页方向
 *
 * 不复用桌面版 app.js 的原因：那里面有 8000 行围绕「右栏 AI / 面板 / 独立窗口」的逻辑，
 * 在手机上全是死代码；而 PdfViewer（pdfview.js）本身是干净的、可以独立使用的，
 * 所以这里只复用它 + util.js 的两个小工具。
 */
import { $, el, cleanText } from '../js/util.js';
import { PdfViewer, initPdfjs } from '../js/pdfview.js';

const LS = {
  font: 'mobile.fontScale',
  page: 'mobile.pageTone',
  back: 'mobile.backTone',
  dir: 'mobile.dir',
};
const readNum = (k, d) => { const v = Number(localStorage.getItem(k)); return Number.isFinite(v) && v > 0 ? v : d; };
const readStr = (k, d) => localStorage.getItem(k) || d;
const save = (k, v) => { try { localStorage.setItem(k, String(v)); } catch { /* 忽略 */ } };

let viewer = null;
let lastSel = null;

/* ────────────────────────────── 小提示条 ────────────────────────────── */
let toastTimer = 0;
function tip(msg, ms = 1800) {
  const node = $('#mToast');
  if (!node) return;
  node.textContent = msg;
  node.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), ms);
}

/* ────────────────────────────── 顶栏开关 ────────────────────────────── */
/**
 * 手机没有 hover，所以顶栏用「点了才出来」：
 *   · 点顶栏以外的任何地方 → 切换（出来时收起、收起时出来）
 *   · 任何滚动 → 立刻收起（阅读时不该被顶栏压着）
 * 顶栏与操作条都是 fixed 覆盖层，不占布局高度，所以正文区域永远是整屏。
 */
function initTopbar() {
  const bar = $('#mTopbar');
  const show = (on) => bar.classList.toggle('on', on);
  const isOn = () => bar.classList.contains('on');

  // 点在「正文」上：短按（<300ms）且几乎没动 → 切换顶栏；长按交给选词逻辑
  const viewerEl = $('#mViewer');
  let downAt = null;
  viewerEl.addEventListener('pointerdown', (e) => {
    downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
  }, { passive: true });
  viewerEl.addEventListener('pointerup', (e) => {
    if (!downAt) return;
    const moved = Math.abs(e.clientX - downAt.x) + Math.abs(e.clientY - downAt.y);
    const dt = performance.now() - downAt.t;
    downAt = null;
    if (moved > 10 || dt > 300) return;      // 拖动 / 长按都不算「点一下」
    if (!$('#mSelectSheet').classList.contains('hidden')) return;
    show(!isOn());
  }, { passive: true });
  // 滚动时收起顶栏（阅读优先）
  viewerEl.addEventListener('scroll', () => { if (isOn()) show(false); }, { passive: true });
  // 点顶栏自身不要把它关掉
  bar.addEventListener('pointerdown', (e) => e.stopPropagation());
}

/* ────────────────────── 长按看图片（PDF 里的图长按放大） ────────────────────── */
/**
 * 判定「这一下是落在文字上，还是落在图上」。
 *
 * **为什么最终不用 pdf.js 的算子列表来算图像框**（试过、放弃，留个记录别再走一遍）：
 *   `page.getOperatorList()` 能拿到图像算子与它的 CTM，但把 CTM 正确映射到「页面 CSS 像素」
 *   需要把用户空间矩阵和 `viewport.transform` 复合对，而这两种顺序在任何一种下都会算出
 *   26253×13638 这种离谱框（实测两轮、写了独立脚本核对过），继续调下去收益也不对等 ——
 *   我们真正需要的不是「图的精确外接框」，而是**这一下到底该选词还是该看图**这个二选一。
 *
 * 所以改成用**已经可靠可用的信息**来判：
 *   · 长按点能不能取到一个「词」？能 → 选词（走 wordRangeFromPoint，这条已实测选中一个词）。
 *   · 取不到词 → 说明这一下不在正文文字上；再看它像不像图（像素启发式），像就放大看那一块。
 * 这条判据不依赖任何坐标系换算，误判代价也小：判成图 = 看到那一块被放大，判错也不会损坏数据。
 */
function pageElAtPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  return el?.closest?.('.page') || null;
}

/**
 * 像素启发式：这一块像不像图。
 * 文字行的特征是「大片纸色 + 少量墨色、几乎没有彩色」；图/表/公式通常是
 * 大面积着色、或者暗像素占比很高。阈值刻意放宽 —— 宁可多给一次「放大看看」，
 * 也别让长按图完全没反应。
 */
function looksLikeImageByPixels(pageEl, x, y) {
  const canvas = pageEl.querySelector('canvas');
  if (!canvas) return false;
  const pr = pageEl.getBoundingClientRect();
  if (!pr.width || !pr.height) return false;
  const cx = Math.round(((x - pr.left) / pr.width) * canvas.width);
  const cy = Math.round(((y - pr.top) / pr.height) * canvas.height);
  const w = Math.max(8, Math.round(canvas.width * 0.12));
  const h = Math.max(8, Math.round(canvas.height * 0.08));
  const sx = Math.min(Math.max(cx - w / 2, 0), Math.max(0, canvas.width - w));
  const sy = Math.min(Math.max(cy - h / 2, 0), Math.max(0, canvas.height - h));
  let data;
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    data = ctx.getImageData(sx, sy, w, h).data;
  } catch { return false; }
  const n = data.length / 4;
  let colored = 0; let dark = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]; const g = data[i + 1]; const b2 = data[i + 2];
    const mx = Math.max(r, g, b2); const mn = Math.min(r, g, b2);
    if (mx - mn > 36) colored += 1;
    if (mx < 160) dark += 1;
  }
  return (colored / n) > 0.05 || (dark / n) > 0.4;
}

let imgViewEl = null;
function closeImageView() {
  if (!imgViewEl) return;
  imgViewEl.remove();
  imgViewEl = null;
}
/**
 * 把长按的那一块从 canvas 裁出来，全屏看：双指缩放 + 拖动。
 * 裁的是「长按点周围的一个窗口」：约半页宽 × 三分之一页高。
 * 为什么不按「图的精确外接框」裁：PDF 的图是画进位图里的，DOM 里没有边界可查；
 * 算过 pdf.js 的算子列表，坐标系换算不可靠（见文件上方那段说明），
 * 而「以长按点为中心裁一块」对手指操作反而更符合直觉 —— 放大后能拖动、能再缩放。
 */
async function openImageView(pageEl, x, y) {
  const pr = pageEl.getBoundingClientRect();
  const w = Math.max(80, Math.round(pr.width * 0.55));
  const h = Math.max(80, Math.round(pr.height * 0.34));
  const rect = {
    x: Math.max(0, x - pr.left - w / 2),
    y: Math.max(0, y - pr.top - h / 2),
    w,
    h,
  };
  // ⚠️ captureRegion 返回的是**对象** `{ dataUrl, width, height }`（桌面版拿它去做视觉识别，
  // 所以没直接给字符串）。这里必须取 .dataUrl —— 直接把对象赋给 img.src 会得到
  // src="[object Object]"，页面不报错、图就是不出来（实测踩过）。
  const shot = await viewer?.captureRegion?.(Number(pageEl.dataset.page), rect, { maxDim: 2200 })
    .catch(() => null);
  const src = shot && shot.dataUrl ? shot.dataUrl : (typeof shot === 'string' ? shot : '');
  if (!src) { tip('这一块读不出来'); return; }
  closeImageView();
  const img = el('img', { src, alt: '放大查看' });
  let scale = 1; let tx = 0; let ty = 0;
  const apply = () => { img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; };
  const view = el('div', { class: 'm-imgview' },
    img,
    el('button', { class: 'm-imgview-close', text: '✕', 'aria-label': '关闭', onclick: closeImageView }),
    el('div', { class: 'm-imgview-bar' },
      el('button', { text: '放大', onclick: () => { scale = Math.min(6, scale * 1.35); apply(); } }),
      el('button', { text: '缩小', onclick: () => { scale = Math.max(0.5, scale / 1.35); apply(); } }),
      el('button', { text: '复位', onclick: () => { scale = 1; tx = 0; ty = 0; apply(); } })),
  );
  // 单指拖动平移；双指捏合缩放
  let dragging = false; let lx = 0; let ly = 0; let pinch0 = 0; let scale0 = 1;
  view.addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; });
  view.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerType === 'mouse' && e.buttons === 0) return;
    tx += e.clientX - lx; ty += e.clientY - ly; lx = e.clientX; ly = e.clientY; apply();
  });
  view.addEventListener('pointerup', () => { dragging = false; });
  view.addEventListener('pointercancel', () => { dragging = false; });
  view.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      pinch0 = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      scale0 = scale;
    }
  }, { passive: true });
  view.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinch0 > 0) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      scale = Math.min(6, Math.max(0.5, scale0 * (d / pinch0)));
      apply();
    }
  }, { passive: true });
  view.addEventListener('dblclick', () => { scale = scale > 1 ? 1 : 2.2; tx = 0; ty = 0; apply(); });
  document.body.append(view);
  imgViewEl = view;
  apply();
}

/* ────────────────────────────── 长按选词 ────────────────────────────── */
/**
 * 长按选词的实现要点（移动端最容易做坏的一块）：
 *   ① 移动端**不能**依赖浏览器的长按菜单：用户要的是「选一个词」，而系统给的是整段选择手柄。
 *   ② 也不能只 setStart/setEnd —— 系统会在 touchend 后用原生选区把手柄位置覆盖回来。
 *      所以：只要用户还在拖那两只手柄，我们就不动；一旦松手（touchend）就立刻按我们的口径重设一次。
 *   ③ 「选一个词」的边界要按字符类判断：汉字一个字就是一个词，拉丁字母/数字连成一串才算一个词。
 */
const isCJK = (ch) => /[\u3400-\u4DBF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(ch);
const isWordChar = (ch) => /[A-Za-z0-9_'’\-]/.test(ch);
/** 「点在文字上」的容差（CSS 像素）：手指精度就这么大，超出这个范围就算点在图上 */
const WORD_SLOP = 6;

/** 从某个文本节点 + 偏移出发，把一个词的范围扩出来 */
function wordRangeAt(node, offset) {
  const text = node.nodeValue || '';
  if (!text) return null;
  let i = Math.min(Math.max(offset, 0), text.length - 1);
  // 落在空白上就左右各找一个最近的非空白字符
  if (!text[i] || /\s/.test(text[i])) {
    let l = i; let r = i;
    while (l > 0 && /\s/.test(text[l])) l -= 1;
    while (r < text.length - 1 && /\s/.test(text[r])) r += 1;
    i = /\s/.test(text[l]) ? r : l;
  }
  const ch = text[i];
  if (!ch) return null;
  let start = i; let end = i + 1;
  if (isCJK(ch)) {
    // 汉字：一个字就是「一个词」（再往下切没有意义）
  } else if (isWordChar(ch)) {
    while (start > 0 && isWordChar(text[start - 1])) start -= 1;
    while (end < text.length && isWordChar(text[end])) end += 1;
  } else {
    return null;   // 标点不当作词
  }
  return { node, start, end };
}

/** 用 caretRangeFromPoint 找一个「词」——先精确、不行再左右各试一点 */
function wordRangeFromPoint(x, y) {
  const doc = document;
  const probe = (px, py) => {
    if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(px, py);
    if (doc.caretPositionFromPoint) {
      const p = doc.caretPositionFromPoint(px, py);
      if (!p) return null;
      const r = doc.createRange();
      r.setStart(p.offsetNode, p.offset);
      r.collapse(true);
      return r;
    }
    return null;
  };
  const tryAt = (px, py) => {
    const r = probe(px, py);
    if (!r) return null;
    const node = r.startContainer;
    if (node.nodeType !== 3) return null;
    // 只认正文文本层里的节点（页面编号、引用块等不算）
    const host = node.parentElement?.closest?.('.textLayer');
    if (!host) return null;
    const word = wordRangeAt(node, r.startOffset);
    if (!word) return null;
    /**
     * ⚠️ 关键：**必须看这个词离长按点有多近**。
     *
     * `wordRangeAt` 对落在空白处的点会「往左右找最近的非空白字符」，于是
     * 手指点在图上、而图上方 20px 处有一行标题时，它会顺手把标题里那个词选出来 ——
     * 表现就是「长按图片，结果选了个词」，图片放大的入口永远轮不到（实测两次都栽在这里）。
     *
     * 所以这里给一个很小的容差：只有当那个词的外接框离长按点足够近（手指精度范围内）
     * 才算「点在文字上」；否则返回 null，把判断让给「这一块像不像图」。
     */
    const box = word.node.parentElement?.getBoundingClientRect?.();
    if (box) {
      const near = px >= box.left - WORD_SLOP && px <= box.right + WORD_SLOP
        && py >= box.top - WORD_SLOP && py <= box.bottom + WORD_SLOP;
      if (!near) return null;
    }
    return word;
  };
  for (const [dx, dy] of [[0, 0], [-4, 0], [4, 0], [0, -4], [0, 4], [-8, 4], [8, 4]]) {
    const hit = tryAt(x + dx, y + dy);
    if (hit) return hit;
  }
  return null;
}

function selectWordRange(range) {
  if (!range) return false;
  const sel = window.getSelection();
  const r = document.createRange();
  try {
    r.setStart(range.node, range.start);
    r.setEnd(range.node, range.end);
  } catch { return false; }
  sel.removeAllRanges();
  sel.addRange(r);
  return true;
}

/** 长按：先按「词」选；如果长按位置上取不到词，就退回浏览器给的那一段（用户仍可用手柄调） */
function initLongPress() {
  const viewerEl = $('#mViewer');
  let pressTimer = 0;
  let startPt = null;
  let longPressed = false;

  const cancel = () => { clearTimeout(pressTimer); pressTimer = 0; startPt = null; };

  viewerEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;    // 桌面调试时别抢鼠标行为
    cancel();
    longPressed = false;
    startPt = { x: e.clientX, y: e.clientY };
    pressTimer = setTimeout(async () => {
      pressTimer = 0;
      if (!startPt) return;
      longPressed = true;
      const word = wordRangeFromPoint(startPt.x, startPt.y);
      if (word) {
        selectWordRange(word);
        // 等一下让系统选区落定，再读选区内容并弹条
        setTimeout(() => showSelectSheet(), 60);
        return;
      }
      // 长按没落在文字上 → 这一下不在正文文字上。看它像不像图，像就放大看那一块
      // （用户口径：「图片长按可以单独放大查看」）。
      // 判据是「取不到词 + 这一块像素不像文字行」，见文件上方那段说明（为什么不算子图框）。
      const pageEl = pageElAtPoint(startPt.x, startPt.y);
      if (pageEl) {
        if (looksLikeImageByPixels(pageEl, startPt.x, startPt.y)) {
          openImageView(pageEl, startPt.x, startPt.y);
        }
      }
    }, 480);
  }, { passive: true });

  viewerEl.addEventListener('pointermove', (e) => {
    if (!startPt || !pressTimer) return;
    if (Math.abs(e.clientX - startPt.x) + Math.abs(e.clientY - startPt.y) > 12) cancel();
  }, { passive: true });
  viewerEl.addEventListener('pointerup', () => {
    cancel();
    if (longPressed) {
      // 系统可能在这一刻把手柄位置覆盖回来：再重设一次我们的「一个词」
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        const r = sel.getRangeAt(0);
        const node = r.startContainer;
        if (node.nodeType === 3 && node.parentElement?.closest?.('.textLayer') && r.endOffset - r.startOffset <= 1) {
          const word = wordRangeAt(node, r.startOffset);
          if (word) selectWordRange(word);
        }
      }
      setTimeout(() => showSelectSheet(), 40);
    }
  }, { passive: true });
  viewerEl.addEventListener('pointercancel', cancel, { passive: true });

  // 长按后系统弹出的原生菜单会挡我们的操作条：直接禁掉 contextmenu（长按菜单）
  viewerEl.addEventListener('contextmenu', (e) => e.preventDefault());
}

function currentSelectionText() {
  const sel = window.getSelection();
  const t = sel ? sel.toString() : '';
  return t ? cleanText(t) : '';
}

function showSelectSheet() {
  const text = currentSelectionText();
  if (!text) return;
  lastSel = text;
  $('#mSelQuote').textContent = text;
  $('#mSelectSheet').classList.remove('hidden');
}

function hideSelectSheet() {
  $('#mSelectSheet').classList.add('hidden');
  viewer?.clearSelection?.();
}

function initSelectSheet() {
  $('#mSelectSheet').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'close') { hideSelectSheet(); return; }
    if (act === 'copy') {
      try {
        await navigator.clipboard.writeText(lastSel || '');
        tip('已复制');
      } catch {
        // WebView 里 clipboard 可能被拒：退回 execCommand
        try {
          const ta = el('textarea', { style: 'position:fixed;opacity:0' });
          ta.value = lastSel || '';
          document.body.append(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
          tip('已复制');
        } catch { tip('复制失败，长按选区试系统复制'); }
      }
      hideSelectSheet();
      return;
    }
    if (act === 'word') {
      // 把选区收窄到「一个词」：用选区起点重新取词
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        const r = sel.getRangeAt(0);
        const node = r.startContainer;
        if (node.nodeType === 3) {
          const w = wordRangeAt(node, r.startOffset);
          if (w && selectWordRange(w)) { showSelectSheet(); return; }
        }
      }
      tip('这一个位置取不到单独的单词');
      return;
    }
    if (act === 'all') {
      // 整段：按标点/换行把这一段扩出来（比 let 系统选整页要好用）
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        const r = sel.getRangeAt(0);
        const node = r.startContainer;
        if (node.nodeType === 3) {
          const text = node.nodeValue || '';
          const isEnd = (c) => /[。！？；.!?;\n]/.test(c);
          let s = Math.min(r.startOffset, text.length - 1);
          let e = Math.max(r.endOffset, s + 1);
          while (s > 0 && !isEnd(text[s - 1])) s -= 1;
          while (e < text.length && !isEnd(text[e])) e += 1;
          const rr = document.createRange();
          try {
            rr.setStart(node, s);
            rr.setEnd(node, e);
            sel.removeAllRanges();
            sel.addRange(rr);
            showSelectSheet();
            return;
          } catch { /* 落到下面的提示 */ }
        }
      }
      tip('这一个位置取不到整段');
    }
  });
}

/* ────────────────────────────── 设置 ────────────────────────────── */
/**
 * 字号：只放大 PDF 里的**文字**。
 * 做法是在文本层每个 span 上加一个只有字形的缩放（见 reader.css 的说明），
 * canvas 位图完全不动 —— 所以图片/表格/公式的尺寸不变，这正是用户要的。
 */
function applyFontScale(pct) {
  const v = Math.min(200, Math.max(60, Number(pct) || 100)) / 100;
  document.documentElement.style.setProperty('--m-text-boost', String(v));
  const label = $('#mFsVal');
  if (label) label.textContent = `${Math.round(v * 100)}%`;
}

function applyPageTone(tone) {
  document.documentElement.dataset.pageTone = tone;
  save(LS.page, tone);
}
function applyBackTone(tone) {
  document.documentElement.dataset.backTone = tone;
  save(LS.back, tone);
}
function applyDir(dir) {
  document.documentElement.dataset.dir = dir;
  save(LS.dir, dir);
}

function initSettings() {
  const modal = $('#mModal');
  const open = () => { modal.classList.remove('hidden'); };
  const close = () => { modal.classList.add('hidden'); saveNote(); };

  $('#mSettings').onclick = open;
  $('#mOpen').onclick = () => $('#mFile').click();
  $('#mOpen2').onclick = () => $('#mFile').click();
  $('#mClose').onclick = close;
  $('#mDone').onclick = close;
  modal.addEventListener('pointerdown', (e) => { if (e.target === modal) close(); });

  const fs = $('#mFontScale');
  fs.value = String(readNum(LS.font, 100));
  applyFontScale(fs.value);
  fs.addEventListener('input', () => { applyFontScale(fs.value); save(LS.font, fs.value); refreshTextLayerNotes(); });

  const pt = $('#mPageTone');
  pt.value = readStr(LS.page, 'paper');
  applyPageTone(pt.value);
  pt.addEventListener('change', () => applyPageTone(pt.value));

  const bt = $('#mBackTone');
  bt.value = readStr(LS.back, 'app');
  applyBackTone(bt.value);
  bt.addEventListener('change', () => applyBackTone(bt.value));

  const dir = $('#mDir');
  dir.value = readStr(LS.dir, 'v');
  applyDir(dir.value);
  dir.addEventListener('change', () => applyDir(dir.value));
}

/** 面板底部的小字：把「只改文字、图片不动」这件事讲清楚，并说明当前倍率 */
function refreshTextLayerNotes() {
  const n = $('#mNote');
  if (!n) return;
  const boost = Number(getComputedStyle(document.documentElement).getPropertyValue('--m-text-boost')) || 1;
  n.textContent = boost === 1
    ? '正文字号 100%＝原始大小。放大只改文字，图片 / 表格 / 公式的尺寸不变。'
    : `正文字号 ${Math.round(boost * 100)}%：PDF 里的文字被放大，图片 / 表格 / 公式仍按原始尺寸显示。`;
}
const saveNote = refreshTextLayerNotes;

/* ────────────────────────────── 打开 PDF 与翻页 ────────────────────────────── */
function setPager(cur, total) {
  $('#mPageCur').textContent = String(cur || '–');
  $('#mPageAll').textContent = String(total || '–');
}

async function openUrl(url, name) {
  try {
    $('#mWelcome')?.classList.add('hidden');
    await viewer.load(url, name || '');
    setPager(1, viewer.numPages);
    document.title = `${name || '论文阅读器'}`;
    $('#mName').textContent = name || '未命名';
    tip('已打开');
  } catch (e) {
    $('#mWelcome')?.classList.remove('hidden');
    tip(`打开失败：${e && (e.message || e)}`, 3200);
  }
}

function initOpen() {
  // ① 本地文件（手机上最主要的方式：从文件管理器 / 微信里选一个 PDF）
  $('#mFile').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    openUrl(url, f.name);
    e.target.value = '';    // 允许连续选同一个文件
  });
  // ② 拖进来也能开（桌面调试用；手机上不常见但无害）
  const v = $('#mViewer');
  v.addEventListener('dragover', (e) => e.preventDefault());
  v.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    openUrl(URL.createObjectURL(f), f.name);
  });
  // ③ URL 参数？open=xxx（服务端有这篇时直接打开；手机版通常走 ①）
  const q = new URL(location.href).searchParams;
  const open = q.get('open');
  if (open) {
    const url = q.get('url') || `/api/pdf?name=${encodeURIComponent(open)}`;
    openUrl(url, open);
  }
}

function initPager() {
  $('#mPrev').onclick = () => viewer?.goToPage(viewer.current - 1, { smooth: true });
  $('#mNext').onclick = () => viewer?.goToPage(viewer.current + 1, { smooth: true });
  $('#mPage').onclick = async () => {
    const total = viewer?.numPages || 0;
    if (!total) return;
    const input = prompt(`跳到第几页？（1–${total}）`, String(viewer.current));
    if (input == null) return;
    const n = parseInt(input, 10);
    if (Number.isFinite(n)) viewer.goToPage(n, { smooth: true });
  };
}

/* ────────────────────────────── 启动 ────────────────────────────── */
(async function boot() {
  await initPdfjs();
  viewer = new PdfViewer($('#mViewer'), {
    onPageChange: (cur, total) => setPager(cur, total),
    onStatus: () => { /* 手机版不显示状态文字，避免抢阅读区 */ },
    onProgress: () => { /* 同上 */ },
  });
  window.__viewer = viewer;

  initTopbar();
  initLongPress();
  initSelectSheet();
  initSettings();
  initPager();
  initOpen();
  refreshTextLayerNotes();

  // 自动化探针（只读，不改变任何行为）：套件要能**分别**验证
  // 「图像框算得对不对」与「长按有没有走对分支」，否则一旦红了我只能猜。
  window.__mobile = {
    looksLikeImageByPixels,
    pageElAtPoint,
    wordRangeFromPoint,
    openImageView,
    get lastSelection() { return lastSel; },
  };

  // 顶栏：进页面先亮一下再收，让用户知道「点一下能出来」
  $('#mTopbar').classList.add('on');
  setTimeout(() => $('#mTopbar').classList.remove('on'), 1400);
})();
