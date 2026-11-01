import { clamp, throttle, sleep } from './util.js';
import { stripPageLabels } from './reading-context.js';

let pdfjsLib = null;

export function pdfWorkerUrl() {
  try {
    return new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
  } catch {
    return '/vendor/pdf.worker.min.mjs';   // 拿不到模块 URL 时退回桌面版的约定
  }
}

export async function initPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import('../vendor/pdf.min.mjs');
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl();
  } catch { /* 极端情况下让 pdf.js 用默认行为 */ }
  return pdfjsLib;
}

function deviceRatio() {
  const d = window.devicePixelRatio || 1;
  return clamp(d, 1, 2);
}

/** 等一帧。页面被隐藏（自动化 `--background` 窗口）时 rAF 不触发，用定时器兜底。 */
function nextFrame(ms = 120) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(finish);
    setTimeout(finish, ms);
  });
}

const SUPERSAMPLE = 1.25;

/** 实际画多大：屏幕需求 × 超采样，仍然封顶 2（再高就是白烧内存） */
function renderRatio() {
  return clamp(deviceRatio() * SUPERSAMPLE, 1, 2);
}

const MAX_FULL_MP = 9;
const WHOLE_PAGE_TOLERANCE = 0.9;

/** 当前设置里的 PDF 纸张颜色。Canvas 不能直接读取 CSS 的 background，
 * 所以页面外壳和 pdf.js 的实际绘制都必须使用同一个颜色。 */
function paperColor() {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue('--paper').trim() || '#FFFFFF';
  } catch {
    return '#FFFFFF';
  }
}

/** 切片向外多渲染多少像素（CSS px，上限）。滚动时不至于一屏就重画一次；
 *  实际边距由 `_renderPlan()` 按**剩余预算**反解，屏幕越密边距越小。 */
const SLICE_MARGIN = 600;

export const ZOOM_SPEED_MIN = 0.5;
export const ZOOM_SPEED_MAX = 2;
/** 把设置里的值夹到合法范围；空值 / NaN / 字符串都回落到默认 1 */
export const clampZoomSpeed = (v) => clamp(Number(v) || 1, ZOOM_SPEED_MIN, ZOOM_SPEED_MAX);

const HIT_PAD_MAX = 6;

const CHAR_HIT_ROW_WEIGHT = 10000;

function layerScale(el) {
  const m = /^scale\(([\d.]+)\)$/.exec(el?.style?.transform || '');
  const k = m ? Number(m[1]) : NaN;
  return Number.isFinite(k) && k > 0 ? k : 1;
}

export function parseReferencesFromText(text, { minLen = 12, maxLen = 700 } = {}) {
  const out = [];
  if (!text) return out;
  const re = /(?:^|\n)[ \t]*\[(\d{1,3})\][ \t]*([\s\S]{0,700}?)(?=\n[ \t]*\[\d{1,3}\]|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const body = m[2]
      .replace(/([A-Za-z])-\s+([a-z])/g, '$1$2')
      .replace(/\s+/g, ' ')
      .trim();
    if (body.length < minLen) continue;
    out.push({ num: Number(m[1]), text: body.slice(0, maxLen) });
  }
  return out;
}

export async function extractPdfText(url, { maxPages = 40, onProgress } = {}) {
  const lib = await initPdfjs();
  const task = lib.getDocument({
    url,
    cMapUrl: '/vendor/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/vendor/standard_fonts/',
    wasmUrl: '/vendor/wasm/',
    useSystemFonts: true,
    isEvalSupported: false,
  });
  const pdf = await task.promise;
  try {
    const total = Math.min(pdf.numPages, maxPages);
    const parts = [];
    for (let i = 1; i <= total; i++) {
      try {
        const page = await pdf.getPage(i);
        const tc = await page.getTextContent();
        let out = '';
        for (const it of tc.items) {
          if (typeof it.str !== 'string') continue;
          out += it.str;
          if (it.hasEOL) out += '\n';
        }
        parts.push(out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n'));
      } catch { /* 单页失败不影响整体 */ }
      if (i % 5 === 0) onProgress?.(i, total);
    }
    return parts.join('\n');
  } finally {
    try { pdf.destroy(); } catch { /* 忽略 */ }
  }
}

export class PdfViewer {
  /**
   * @param {HTMLElement} container 滚动容器 .viewer
   * @param {{onPageChange?:Function,onStatus?:Function,onProgress?:Function}} opts
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;
    this.pdf = null;
    this.name = '';
    this.url = '';
    this.numPages = 0;
    this.scale = 1;
    /** 双指缩放速度倍率（设置项，默认 1；见 setZoomSpeed / clampZoomSpeed） */
    this.zoomSpeed = clampZoomSpeed(opts.zoomSpeed);
    this.baseSizes = [];      // [{width,height}] 按 scale=1 的尺寸，index 从 1 开始
    this.pageEls = [];        // .page 元素，index 从 1 开始
    this.rendered = new Map();  // pageNum -> {canvas, textDiv, task, hlLayer}
    this.renderTasks = new Map();
    this.textCache = new Map();  // pageNum -> string
    this.scanCache = new Map();  // 页面类型扫描结果缓存（同一次加载内）
    this._pageImageCache = new Map();  // `${page}:${maxDim}` -> {dataUrl,width,height}
    this.offsets = [];        // 每页顶部相对 pages 容器的偏移
    this.heights = [];
    this.current = 1;
    this.pagesEl = null;
    this._destroyed = false;
    this._gen = 0;          // 文档代际：换文档时自增，用来作废所有在途异步任务
    this._renderQueue = new Set();
    this._lastAnchor = null;
    this._activeHit = null;
    this._selRects = null;   // 当前选区的归一化方块，按页存；重画页面时用它补回来
    this.referencePages = new Set(); // 参考文献表页不绘制正文引用热点
    this.referenceByNum = new Map();  // 已解析的编号索引，点击引用时优先走缓存
    this.referenceEntries = new Map();
    this._fitMode = true;
    // 缩放手势期间只做一次合成层变换；停止后再提交真实页面尺寸。
    // 这样触摸板/滑块不会在每个 input 上触发全量布局和 PDF 重绘。
    this._zoomPreview = null;

    this._onScroll = throttle(() => this._handleScroll(), 60);
    this.container.addEventListener('scroll', this._onScroll, { passive: true });
    this._onResize = throttle(() => {
      if (this._fitMode) this.fitWidth();
    }, 200);
    window.addEventListener('resize', this._onResize);
    // Opening a side panel changes the reader width without resizing the window.
    this._resizeObserver = new ResizeObserver(this._onResize);
    this._resizeObserver.observe(this.container);

    // 窗口被拖到另一块不同 DPI 的显示器上时，已渲染的页要重画，否则会糊
    this._onDprChange = () => {
      if (!this.pdf) return;
      for (const i of Array.from(this.rendered.keys())) this._teardownPage(i);
      this._renderVisible(true);
    };
    this._watchDpr();

    /* 引用热点的悬停点亮（每帧最多判一次，不在 mousemove 里直接算） */
    this._hoverRaf = 0;
    this._onHoverMove = (e) => {
      if (this._hoverRaf) return;
      const x = e.clientX;
      const y = e.clientY;
      this._hoverRaf = requestAnimationFrame(() => {
        this._hoverRaf = 0;
        if (!this._destroyed) this._updateCiteHover(x, y);
      });
    };
    this.container.addEventListener('mousemove', this._onHoverMove, { passive: true });
    this._bindTouchZoom();
    this._watchJank();
  }

  _watchJank() {
    const p = this._perf = {
      raf: 0, frames: [], kind: '', last: 0, t0: 0, renders: 0, renderMs: 0,
      long: [], lastReport: 0, log: [],
    };
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          p.long.push(Math.round(e.duration));
          if (p.long.length > 200) p.long.shift();
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch { /* 老引擎没有 longtask 就算了 */ }
  }

  /** 有事发生 → 开一个采样窗口（kind 只在窗口开始时定一次） */
  _touchPerf(kind) {
    const p = this._perf;
    if (!p || this._destroyed) return;
    const now = performance.now();
    if (!p.raf) {
      p.kind = kind;
      p.t0 = now;
      p.renders = 0;
      p.renderMs = 0;
      p.long = [];
      const tick = (t) => {
        p.frames.push(t - p.last);
        p.last = t;
        if (performance.now() - p.active > 1200) { p.raf = 0; this._reportJank(); return; }
        p.raf = requestAnimationFrame(tick);
      };
      p.frames = [];
      p.last = now;
      p.active = now;
      p.raf = requestAnimationFrame(tick);
      return;
    }
    p.active = now;                       // 还在动：把窗口往后延
  }

  _reportJank() {
    const p = this._perf;
    const n = p.frames.length;
    if (!n) return;
    const s = [...p.frames].sort((a, b) => a - b);
    const avg = p.frames.reduce((a, b) => a + b, 0) / n;
    const max = s[n - 1];
    const drops = p.frames.filter((x) => x > 25).length;
    const longMax = p.long.length ? Math.max(...p.long) : 0;
    const rec = {
      kind: p.kind, ms: Math.round(p.t0 ? (performance.now() - p.t0) : 0), frames: n,
      avg: +avg.toFixed(1), p95: +s[Math.floor(n * 0.95)].toFixed(1), max: +max.toFixed(1),
      drops, longTasks: p.long.length, longMax, renderMs: Math.round(p.renderMs),
    };
    p.log.push(rec);
    if (p.log.length > 20) p.log.shift();
    window.__jankLog = p.log;
    const bad = max >= 100 || drops / n >= 0.3;
    if (!bad || performance.now() - p.lastReport < 3000) return;
    p.lastReport = performance.now();
    const text = `掉帧：${rec.kind} ${rec.ms}ms，${rec.frames} 帧 平均 ${rec.avg}ms / 最长 ${rec.max}ms，掉 ${rec.drops} 帧`
      + (rec.longMax ? `，单次卡顿 ${rec.longMax}ms` : '')
      + (rec.renderMs ? `，重画占 ${rec.renderMs}ms` : '');
    try { console.warn('[perf]', text); } catch { /* ignore */ }
  }

  _bindTouchZoom() {
    const el = this.container;
    const PINCH_ENGAGE_RATIO = 0.025;  // 间距相对变化
    const PINCH_ENGAGE_PX = 6;         // 间距绝对变化（两指靠得近时按这个算）
    const PINCH_GAIN = 1.6;
    const PAN_ENGAGE_PX = 10;          // 中点位移
    let mode = 'idle';                 // idle | undecided | pan | pinch
    let d0 = 0;
    let startScale = 1;
    let mid0 = { x: 0, y: 0 };
    let raf = 0;
    let pending = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
    const apply = (p) => {
      if (p.mode === 'pinch') this.previewScale(p.scale, { clientX: p.x, clientY: p.y });
      else this.previewPan(p.x, p.y);
    };
    const flush = () => {
      raf = 0;
      if (!pending) return;
      const p = pending;
      pending = null;
      apply(p);
    };
    const onStart = (e) => {
      if (e.touches.length !== 2) return;
      mode = 'undecided';
      d0 = dist(e.touches) || 1;
      startScale = this.scale;
      mid0 = mid(e.touches);
    };
    const onMove = (e) => {
      if (mode === 'idle' || e.touches.length !== 2) return;
      const d = dist(e.touches);
      const m = mid(e.touches);
      if (mode !== 'pinch') {
        // 还没定，或当前是平移：间距一旦明显变化就升级成缩放（升级后整段手势不再回头）
        const dd = Math.abs(d - d0);
        if (dd >= Math.max(PINCH_ENGAGE_PX, d0 * PINCH_ENGAGE_RATIO)) mode = 'pinch';
        else if (mode === 'undecided') {
          const dm = Math.hypot(m.x - mid0.x, m.y - mid0.y);
          if (dm >= PAN_ENGAGE_PX) mode = 'pan';
          else return;                    // 还没看清要干什么：不动
        }
      }
      if (mode === 'pinch') e.preventDefault();
      pending = mode === 'pinch'
        // 每帧现读 zoomSpeed：设置页拖滑杆时正在做的手势也立刻跟上新速度
        ? { mode, scale: startScale * Math.pow(d / d0, PINCH_GAIN * this.zoomSpeed), x: m.x, y: m.y }
        : { mode, x: m.x, y: m.y };
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const onEnd = (e) => {
      if (mode === 'idle' || e.touches.length >= 2) return;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      // 最后一帧还没合上就先补上：不然「手指停在哪儿」和「最后缩放多少」会差一帧
      const last = pending;
      pending = null;
      const moved = mode === 'pinch' || mode === 'pan';
      mode = 'idle';
      d0 = 0;
      if (last) apply(last);
      // 平移也要提交（把 transform 落成真实 scroll）；提交后 _zoomPreview 自然清空
      if (moved && this._zoomPreview) this.commitZoomPreview();
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });
    this._touchZoomHandlers = { onStart, onMove, onEnd };
  }

  destroy() {
    this._destroyed = true;
    this.container.removeEventListener('scroll', this._onScroll);
    this.container.removeEventListener('mousemove', this._onHoverMove);
    const tz = this._touchZoomHandlers;
    if (tz) {
      this.container.removeEventListener('touchstart', tz.onStart);
      this.container.removeEventListener('touchmove', tz.onMove);
      this.container.removeEventListener('touchend', tz.onEnd);
      this.container.removeEventListener('touchcancel', tz.onEnd);
      this._touchZoomHandlers = null;
    }
    if (this._hoverRaf) { try { cancelAnimationFrame(this._hoverRaf); } catch { /* ignore */ } }
    window.removeEventListener('resize', this._onResize);
    this._resizeObserver.disconnect();
    this._dprQuery?.removeEventListener?.('change', this._onDprChange);
    this.close();
  }

  /** 监听 devicePixelRatio 变化（换显示器 / 改系统缩放） */
  _watchDpr() {
    try {
      this._dprQuery?.removeEventListener?.('change', this._onDprChange);
      this._dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      this._dprQuery.addEventListener('change', this._onDprChange);
    } catch { /* 老浏览器没有 matchMedia 的 resolution 查询就算了 */ }
  }

  close() {
    this._cancelZoomPreview();
    this._gen++;            // 作废上一份文档的所有在途任务
    for (const i of Array.from(this.rendered.keys())) this._teardownPage(i);
    this.rendered.clear();
    this.renderTasks.clear();
    this.textCache.clear();
    this.scanCache.clear();
    this._pageImageCache.clear();
    if (this.pdf) {
      try { this.pdf.destroy(); } catch { /* ignore */ }
      this.pdf = null;
    }
    this.numPages = 0;
    this.pageEls = [];
    this.baseSizes = [];
    this.offsets = [];
    this.heights = [];
    this.current = 1;
    this._selRects = null;   // 换文档了，上一个选区跟着作废
    this.referencePages.clear();
    this.referenceByNum.clear();
    this.referenceEntries.clear();
    if (this.pagesEl) this.pagesEl.remove();
    this.pagesEl = null;
  }

  /* ------------------------------------------------------------ 加载 */

  async load(url, name = '') {
    this.close();
    this._destroyed = false;
    const gen = this._gen;   // 本次加载的代际；任何异步回跳先比对它
    const lib = await initPdfjs();
    const task = lib.getDocument({
      url,
      cMapUrl: '/vendor/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/vendor/standard_fonts/',
      wasmUrl: '/vendor/wasm/',
      // 中文/日文等 CID 字体需要 cMap；提高一点容错
      useSystemFonts: true,
      isEvalSupported: false,
    });
    this.opts.onStatus?.('正在解析 PDF…');
    const pdf = await task.promise;
    if (this._destroyed || gen !== this._gen) { pdf.destroy(); return { numPages: 0, stale: true }; }
    this.pdf = pdf;
    this.url = url;
    this.name = name;
    this.numPages = pdf.numPages;

    // 首页尺寸先拿到，立刻出画面
    const first = await pdf.getPage(1);
    if (gen !== this._gen) { pdf.destroy(); return { numPages: 0, stale: true }; }
    const vp1 = first.getViewport({ scale: 1 });
    this.baseSizes = new Array(this.numPages + 1);
    this.baseSizes[1] = { width: vp1.width, height: vp1.height, rotation: vp1.rotation };

    this.pagesEl = document.createElement('div');
    this.pagesEl.className = 'pages';
    // 只清掉上一次的页面容器，保留通过 #welcome 显示的欢迎页
    this.container.querySelectorAll('.pages').forEach((n) => n.remove());
    this.container.append(this.pagesEl);

    this._buildPageEls();
    // 打开就自动匹配窗口大小：按页面宽度铺满阅读区，并进入「适配模式」，
    // 之后窗口怎么拉都跟着变（除非用户自己拖了缩放）。
    this._fitMode = true;
    this.scale = this._computeFitScale();
    this.layout();
    this.opts.onScale?.(this.scale);

    this.opts.onStatus?.(`共 ${this.numPages} 页`);

    // 其余页尺寸后台补齐（不影响首屏）
    this._loadRemainingSizes(first, gen);

    await this._renderVisible(true, gen);
    if (gen !== this._gen) return { numPages: 0, stale: true };
    this._handleScroll();
    return { numPages: this.numPages };
  }

  async _loadRemainingSizes(firstPage, gen = this._gen) {
    const total = this.numPages;
    let done = 1;
    const CONC = 6;
    let next = 2;
    const worker = async () => {
      while (next <= total && gen === this._gen && !this._destroyed) {
        const i = next++;
        if (this.baseSizes[i]) { done++; continue; }
        try {
          const p = i === 1 ? firstPage : await this.pdf.getPage(i);
          if (gen !== this._gen) return;
          const vp = p.getViewport({ scale: 1 });
          this.baseSizes[i] = { width: vp.width, height: vp.height, rotation: vp.rotation };
        } catch {
          if (gen !== this._gen) return;
          this.baseSizes[i] = { ...this.baseSizes[1] };
        }
        done++;
        if (done % 5 === 0 || done === total) {
          this.opts.onProgress?.(done, total);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, Math.max(0, total - 1)) }, worker));
    if (gen !== this._gen) return;
    // 补齐后修正尺寸
    this.layout({ keepAnchor: true });
    // 尺寸补齐前 _handleScroll 可能把页码停在保守值；补齐后立刻按真实偏移再同步一次
    this._handleScroll();
    this.opts.onProgress?.(total, total);
  }

  _buildPageEls() {
    const frag = document.createDocumentFragment();
    this.pageEls = new Array(this.numPages + 1);
    for (let i = 1; i <= this.numPages; i++) {
      const page = document.createElement('div');
      page.className = 'page placeholder';
      page.dataset.page = String(i);
      const num = document.createElement('div');
      num.className = 'page-number';
      num.textContent = String(i);
      page.append(num);
      this.pageEls[i] = page;
      frag.append(page);
    }
    this.pagesEl.append(frag);
  }

  /* ------------------------------------------------------------ 布局 */

  _sizeOf(i) {
    const s = this.baseSizes[i] || this.baseSizes[1];
    return s;
  }

  _computeFitScale() {
    const pad = 32;
    const avail = Math.max(200, this.container.clientWidth - pad);
    const size = this._sizeOf(1);
    const w = (size && size.width) || 612;   // 没有文档时 baseSizes 是空的
    return clamp(avail / w, 0.15, 6);
  }

  layout({ keepAnchor = false } = {}) {
    if (!this.pagesEl) return;
    const anchor = keepAnchor ? this._captureAnchor() : null;
    for (let i = 1; i <= this.numPages; i++) {
      const { width, height } = this._sizeOf(i);
      const page = this.pageEls[i];
      if (!page) continue;
      page.style.width = `${Math.round(width * this.scale)}px`;
      page.style.height = `${Math.round(height * this.scale)}px`;
      page.style.setProperty('--total-scale-factor', String(this.scale));
      page.style.setProperty('--scale-factor', String(this.scale));
    }
    // 位置直接从 DOM 读，自动把 gap / padding 算进去，不会和 CSS 打架
    this.offsets = new Array(this.numPages + 1);
    this.heights = new Array(this.numPages + 1);
    for (let i = 1; i <= this.numPages; i++) {
      const page = this.pageEls[i];
      if (!page) continue;
      this.offsets[i] = page.offsetTop;
      this.heights[i] = page.offsetHeight;
    }
    if (anchor) this._restoreAnchor(anchor);
  }

  _captureAnchor() {
    const top = this.container.scrollTop;
    const center = top + this.container.clientHeight / 2;
    for (let i = 1; i <= this.numPages; i++) {
      const o = this.offsets[i] ?? 0;
      const h = this.heights[i] ?? 0;
      if (center >= o && center < o + h) {
        return { page: i, frac: h ? (center - o) / h : 0 };
      }
    }
    return { page: 1, frac: 0 };
  }

  _restoreAnchor(a) {
    const o = this.offsets[a.page] ?? 0;
    const h = this.heights[a.page] ?? 0;
    this.container.scrollTop = Math.max(0, o + h * a.frac - this.container.clientHeight / 2);
  }

  /* ------------------------------------------------------------ 缩放 */

  _cancelZoomPreview() {
    clearTimeout(this._zoomPreview?.timer);
    this._clearPreviewTransforms(this._zoomPreview);
    this._zoomPreview = null;
    if (this.pagesEl) {
      this.pagesEl.style.transform = '';
      this.pagesEl.style.transformOrigin = '';
      this.pagesEl.style.willChange = '';
      this.pagesEl.classList.remove('zoom-preview');
    }
  }

  _beginZoomPreview() {
    const c = this.container;
    const containerRect = c.getBoundingClientRect();
    const pagesRect = this.pagesEl.getBoundingClientRect();
    /* `.pages` 的 padding 与行距：**预览要预演真实布局**，就必须知道这两个值
       （真实布局里它们不随比例缩放，而容器的整体 scale 会把它们一起放大 —— 见 _predictedLayout）。
       每个文档读一次，手势期不再读。 */
    let padTop = 0;
    let padBottom = 0;
    let gap = 0;
    try {
      const cs = getComputedStyle(this.pagesEl);
      padTop = parseFloat(cs.paddingTop) || 0;
      padBottom = parseFloat(cs.paddingBottom) || 0;
      gap = parseFloat(cs.rowGap) || parseFloat(cs.gap) || 0;
      if (!Number.isFinite(padTop)) padTop = 0;
      if (!Number.isFinite(padBottom)) padBottom = 0;
      if (!Number.isFinite(gap)) gap = 0;
    } catch { /* 读不到就按 0 算，只会让预览差一点点 */ }
    /* 能滚到哪儿：**按布局算，不读 `scrollWidth/scrollHeight`**。
       后者会被溢出的后代（软缩放中带 transform 的层、比页面大的切片画布）撑大几千像素，
       于是两指平移能拖进空白、松手时浏览器再夹回来 —— 一次瞬移；捏合那边同理
       （提交要把夹取结果交给浏览器时，上限对不上就跳）。见 _writePreviewTransform 的说明。 */
    const oldLayout = this._predictedLayout(this.scale, padTop, gap, c.clientWidth);
    let contentW = 0;
    for (let i = 1; i <= this.numPages; i++) {
      const right = (oldLayout.lefts[i] ?? 0) + (oldLayout.widths[i] ?? 0);
      if (right > contentW) contentW = right;
    }
    const preview = {
      baseScale: this.scale,
      cLeft: containerRect.left,
      cTop: containerRect.top,
      scrollX: c.scrollLeft,
      scrollY: c.scrollTop,
      containerW: c.clientWidth,
      containerH: c.clientHeight,
      padTop,
      padBottom,
      gap,
      // 老布局（当前比例）下每页的真实位置：算一次，之后不用再读 DOM
      oldLayout,
      // 两指平移能滚到哪儿（手势一开始算一次，之后不再读布局）
      maxScrollX: Math.max(0, contentW - c.clientWidth),
      maxScrollY: Math.max(0, oldLayout.bottom - gap + padBottom - c.clientHeight),
      // pages 容器原点在内容坐标里的位置：整段手势恒定（transform 不改布局）
      originX: c.scrollLeft + pagesRect.left - containerRect.left,
      originY: c.scrollTop + pagesRect.top - containerRect.top,
      anchor: null,        // 内容坐标：手指抓住的那个点，整段手势不动
      page: null,          // 锚点所在页 + 页内相对位置（提交时用它把位置对回去）
      touched: new Set(),  // 这一轮写过 transform 的页（提交/取消时要逐个清掉）
      fx: 0,
      fy: 0,
      refX: null,          // 锚点钉在屏幕上的位置（缩放期间不变，见 _anchorZoomPreview）
      refY: null,
      panTx: null,         // 纯平移时算好并夹住的位移（提交时一次性落到 scroll）
      panTy: null,
      timer: 0,
    };
    this.pagesEl.style.transformOrigin = '0 0';
    this.pagesEl.style.willChange = 'transform';
    // 预览期间把文本层藏起来：几百个绝对定位 span 是这一层最贵的栅格化对象，
    // 而它们本来就是透明的（只负责命中/选区）。实测每帧写 transform 时掉帧 9~10 帧，
    // 藏掉之后是干净的 16.7ms/帧（test/perf/zoom-frame-rhythm.mjs 的 A/B）。见 style.css 的说明。
    this.pagesEl.classList.add('zoom-preview');
    return preview;
  }

  _predictedLayout(scale, padTop, gap, containerW) {
    const tops = new Array(this.numPages + 1);
    const lefts = new Array(this.numPages + 1);
    const widths = new Array(this.numPages + 1);
    let top = padTop;
    let maxW = 0;
    for (let i = 1; i <= this.numPages; i++) {
      const { width, height } = this._sizeOf(i);
      const w = Math.round(width * scale);
      tops[i] = top;
      widths[i] = w;
      if (w > maxW) maxW = w;
      top += Math.round(height * scale) + gap;
    }
    const boxW = Math.max(maxW, containerW || 0);
    for (let i = 1; i <= this.numPages; i++) lefts[i] = (boxW - widths[i]) / 2;
    /* `widths` 也要带出去：`_writePreviewTransform` 用它算「新布局的内容宽度」
       → 新布局真正能滚到多远（横向没得滚时要夹住，否则缩小方向提交那一帧会跳，
       见那里的说明与 test/artifacts/offcenter-commit.mjs 的实测）。 */
    return { tops, lefts, widths, bottom: top };
  }

  /** 手势开始那一帧记下锚点（内容坐标 + 页内相对位置），全程不再改 */
  _anchorZoomPreview(preview, cx, cy) {
    if (preview.anchor) return;
    preview.refX = cx;
    preview.refY = cy;
    this._setZoomPreviewAnchor(preview, cx, cy);
  }

  _setZoomPreviewAnchor(preview, cx, cy) {
    preview.anchor = {
      x: preview.scrollX + (cx - preview.cLeft),
      y: preview.scrollY + (cy - preview.cTop),
    };
    const page = this._pageAtContent(preview.anchor.y);
    if (!page) return;
    const r = page.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return;
    preview.page = page;
    preview.fx = (cx - r.left) / r.width;
    preview.fy = (cy - r.top) / r.height;
    /* 逐页预览要用：锚点在哪一页、以及它在**页内的局部坐标**（未缩放）。
       每帧由 `old.tops[ap] + t + k*ay = refY` 解出这套逐页 transform 的整体常数，
       于是「按下去抓住的那个点」始终钉在 refX/refY，其余页跟着同一套相对位置走。 */
    preview.anchorPage = Number(page.dataset.page) || null;
    preview.anchorLocalX = cx - r.left;
    preview.anchorLocalY = cy - r.top;
  }

  _writePreviewTransform(preview, k, tx, ty) {
    if (Math.abs(k - 1) < 1e-4) {
      // 纯平移：整层一条 transform，等价且最省
      this.pagesEl.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px)`;
      return;
    }
    this.pagesEl.style.transform = '';
    const [first, last] = this._visibleRange();
    const lo = Math.max(1, first - 1);
    const hi = Math.min(this.numPages, last + 1);
    const pred = this._predictedLayout(this.scale, preview.padTop, preview.gap, preview.containerW);
    const old = preview.oldLayout;
    const ap = preview.anchorPage;
    let C = 0;
    let D = 0;
    if (ap && old.tops[ap] != null) {
      const ax = preview.anchorLocalX;      // 锚点在页内的局部坐标（未缩放）
      const ay = preview.anchorLocalY;
      let contentW = 0;
      for (let i = 1; i <= this.numPages; i++) {
        const right = (pred.lefts[i] ?? 0) + (pred.widths[i] ?? 0);
        if (right > contentW) contentW = right;
      }
      const maxSX = Math.max(0, contentW - preview.containerW);
      const maxSY = Math.max(0, pred.bottom - preview.gap + preview.padBottom - preview.containerH);
      // 钉住锚点所需的滚动量，再夹进真实范围
      const wantSX = preview.cLeft + pred.lefts[ap] + k * ax - preview.refX;
      const wantSY = preview.cTop + pred.tops[ap] + k * ay - preview.refY;
      const sx = clamp(wantSX, 0, maxSX);
      const sy = clamp(wantSY, 0, maxSY);
      C = preview.scrollY - sy;
      D = preview.scrollX - sx;
      preview.sx = sx;
      preview.sy = sy;
    }
    for (let i = lo; i <= hi; i++) {
      const el = this.pageEls[i];
      if (!el) continue;
      const oy = old.tops[i] ?? 0;
      const ox = old.lefts[i] ?? 0;
      const py = (pred.tops[i] ?? oy) - oy + C;
      const px = (pred.lefts[i] ?? ox) - ox + D;
      el.style.transformOrigin = '0 0';
      el.style.transform = `translate(${px.toFixed(2)}px, ${py.toFixed(2)}px) scale(${k.toFixed(5)})`;
      preview.touched.add(el);
    }
  }

  /** 把预览期间写过 transform 的页面全部还原（提交/取消时各调一次） */
  _clearPreviewTransforms(preview) {
    if (!preview?.touched) return;
    for (const el of preview.touched) {
      el.style.transform = '';
      el.style.transformOrigin = '';
    }
    preview.touched.clear();
  }

  previewScale(scale, { clientX = null, clientY = null } = {}) {
    if (!this.pdf || !this.baseSizes[1] || !this.pagesEl) return;
    this._touchPerf('手势·缩放');
    const next = clamp(scale, 0.15, 6);
    if (Math.abs(next - this.scale) < 0.0005 && !this._zoomPreview) return;
    let preview = this._zoomPreview;
    if (!preview) preview = this._zoomPreview = this._beginZoomPreview();

    // 指针位置：有坐标就用坐标；滑块没有坐标，用阅读区中心（保持当前位置稳定）
    let cx = clientX;
    let cy = clientY;
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
      cx = preview.cLeft + this.container.clientWidth / 2;
      cy = preview.cTop + this.container.clientHeight / 2;
    }
    this._anchorZoomPreview(preview, cx, cy);
    if (preview.panTx != null && !preview.upgraded) {
      preview.upgraded = true;
      if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
        preview.refX = cx;
        preview.refY = cy;
      } else {
        preview.refX += preview.panTx;
        preview.refY += preview.panTy;
      }
    }

    const k = next / preview.baseScale;
    this.scale = next;
    this._fitMode = false;
    this._writePreviewTransform(preview, k, 0, 0);

    clearTimeout(preview.timer);
    // 140ms（原来 200）：用户要「缩放快一点」——停手到变清晰的总延迟少 60ms
    preview.timer = setTimeout(() => this.commitZoomPreview(), 140);
    this.opts.onScale?.(this.scale);
  }

  previewPan(clientX, clientY) {
    if (!this.pdf || !this.pagesEl) return;
    this._touchPerf('手势·平移');
    let preview = this._zoomPreview;
    if (!preview) preview = this._zoomPreview = this._beginZoomPreview();
    this._anchorZoomPreview(preview, clientX, clientY);
    // 手势开始时指针在哪儿（由锚点反推，不用再存一份）
    const startX = preview.anchor.x - preview.scrollX + preview.cLeft;
    const startY = preview.anchor.y - preview.scrollY + preview.cTop;
    /* 手指往右下走 → 内容跟着往右下走 → scrollTop/scrollLeft 变小。
       位移夹在「最多能滚到哪儿」之间，边界手感与原生滚动一致。 */
    const rawTx = clientX - startX;
    const rawTy = clientY - startY;
    const tx = clamp(rawTx, preview.scrollX - preview.maxScrollX, preview.scrollX);
    const ty = clamp(rawTy, preview.scrollY - preview.maxScrollY, preview.scrollY);
    if (tx !== rawTx || ty !== rawTy) {
      /* 到边界了：内容停在边上，手指底下那个 PDF 点就换了。
         锚点必须跟着挪（整套一起挪，见 _setZoomPreviewAnchor 的说明），
         否则「拖到边之后再捏合」会从旧锚点算，升级帧和提交帧各跳一次。 */
      this._setZoomPreviewAnchor(preview, clientX, clientY);
      // `anchor` 要用夹住之后的内容坐标（它与「手指底下那个点」差一个夹取量），
      // 上面的 helper 算的是未夹取的版本，这里覆盖掉。
      preview.anchor.x = clientX + preview.scrollX - preview.cLeft - tx;
      preview.anchor.y = clientY + preview.scrollY - preview.cTop - ty;
    }
    preview.panTx = tx;
    preview.panTy = ty;
    this._writePreviewTransform(preview, 1, tx, ty);
  }

  commitZoomPreview() {
    const preview = this._zoomPreview;
    if (!preview) return;
    this._touchPerf('提交缩放');
    clearTimeout(preview.timer);
    this._zoomPreview = null;
    this.pagesEl.style.transform = '';
    this.pagesEl.style.transformOrigin = '';
    this.pagesEl.style.willChange = '';
    this.pagesEl.classList.remove('zoom-preview');
    // 逐页预览写的 transform 也要清（不然页面会带着预览位移进入真实布局）
    this._clearPreviewTransforms(preview);
    /* 纯平移（两指拖动）：把 transform 落成真实滚动就完事 —— 不重排、不重画、不动比例。
       这是最常见的两指手势，所以这条捷径也很重要：它一次布局都不触发。 */
    if (Math.abs(this.scale - preview.baseScale) < 0.0005) {
      if (preview.panTx != null) {
        this.container.scrollLeft = preview.scrollX - preview.panTx;
        this.container.scrollTop = preview.scrollY - preview.panTy;
      }
      return;
    }
    // 预览期间变换了页面；提交时先把已有 canvas/文本层同步到
    // 最终比例，再改 page 外框尺寸，避免旧位图留在新页面里造成错位/重叠。
    this._softRescale();
    this.layout();
    if (preview.sx != null) {
      this.container.scrollLeft = preview.sx;
      this.container.scrollTop = preview.sy;
    } else if (preview.page && preview.refX != null) {
      /* 兜底（理论上走不到：只有写过逐页 transform 的预览才有 sx）。
         把锚点对回**按下去时的那个屏幕位置**（refX/refY）：缩放手势本身不平移，提交时也不该平移。 */
      const r = preview.page.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        this.container.scrollLeft += r.left + preview.fx * r.width - preview.refX;
        this.container.scrollTop += r.top + preview.fy * r.height - preview.refY;
      }
    }
    // 90ms（原来 140）：用户要「缩放快一点」，松手到开始重画之间的空档再短一点
    this._scheduleRerender(90);
    this.opts.onStatus?.(`缩放 ${Math.round(this.scale * 100)}%`);
  }

  /** 内容坐标（纵坐标）→ 页面元素（用缓存的 offsets/heights 做数学判定，不做命中测试） */
  _pageAtContent(y) {
    if (!this.offsets?.length) return null;
    for (let i = 1; i <= this.numPages; i++) {
      const o = this.offsets[i] ?? 0;
      const h = this.heights[i] ?? 0;
      if (y >= o && y < o + h) return this.pageEls[i] || null;
    }
    return this.pageEls[this.current] || null;
  }

  /**
   * 换缩放前：拆掉已渲染的页，并记下还在渲染中的页（它们被 cancel 后不会自愈）
   * 只在非手势缩放时用（换文档之类）；拖动缩放走 _softRescale。
   */
  _beginZoomChange() {
    const inflight = Array.from(this.renderTasks.keys());
    for (const i of Array.from(this.rendered.keys())) this._teardownPage(i);
    return inflight;
  }

  _softRescale() {
    for (const entry of this.rendered.values()) {
      const base = entry.renderScale || this.scale;
      const k = this.scale / base;
      if (!(k > 0)) continue;
      entry.dirty = true;
      this._softRescaleCanvas(entry, k);
      this._softRescaleLayers(entry, k);
    }
  }

  _softRescaleCanvas(entry, k) {
    const c = entry.canvas;
    if (!c) return;
    const baseW = entry.slice ? entry.slice.w : entry.cssW;
    const baseH = entry.slice ? entry.slice.h : entry.cssH;
    c.style.width = `${(baseW * k).toFixed(2)}px`;
    c.style.height = `${(baseH * k).toFixed(2)}px`;
    c.style.left = `${((entry.slice ? entry.slice.x : 0) * k).toFixed(2)}px`;
    c.style.top = `${((entry.slice ? entry.slice.y : 0) * k).toFixed(2)}px`;
    c.classList.add('soft-zoom');
  }

  /** 四个覆盖层整层 scale(k)：里面全是渲染比例下的绝对 px（见上面的单位铁律） */
  _softRescaleLayers(entry, k) {
    const tf = Math.abs(k - 1) < 0.0005 ? '' : `scale(${k})`;
    for (const layer of [entry.textDiv, entry.hlLayer, entry.hitLayer, entry.quoteLayer, entry.pinLayer]) {
      if (!layer) continue;
      layer.style.transformOrigin = '0 0';
      layer.style.transform = tf;
    }
  }

  _resetLayerScale(entry) {
    if (!entry) return;
    entry.canvas?.classList.remove('soft-zoom');
    for (const layer of [entry.textDiv, entry.hlLayer, entry.hitLayer, entry.quoteLayer, entry.pinLayer]) {
      if (layer) layer.style.transform = '';
    }
  }

  _scheduleRerender(delay = 140) {
    this._rerenderWanted = true;
    if (this._rerenderRunning) return;
    clearTimeout(this._rerenderTimer);
    this._rerenderTimer = setTimeout(() => {
      this._rerenderTimer = 0;
      this._runRerenderPass();
    }, delay);
  }

  async _runRerenderPass() {
    if (this._rerenderRunning) return;
    this._rerenderRunning = true;
    let didWork = false;
    try {
      for (let round = 0; round < 8; round++) {
        this._rerenderWanted = false;
        if (this._destroyed || !this.pdf || !this.offsets.length) return;
        const gen = this._gen;
        const [first, last] = this._visibleRange();
        const center = this.container.scrollTop + this.container.clientHeight / 2;
        const mid = (i) => (this.offsets[i] ?? 0) + (this.heights[i] ?? 0) / 2;
        const queue = [];
        for (let i = Math.max(1, first - 1); i <= Math.min(this.numPages, last + 1); i++) {
          const entry = this.rendered.get(i);
          if (entry?.dirty) queue.push(i);
          else if (!entry && !this.renderTasks.has(i)) queue.push(i);
        }
        // 没活干就把「还想再跑」的标记清掉，免得在 finally 里空转
        if (!queue.length) { this._rerenderWanted = false; return; }
        didWork = true;
        queue.sort((a, b) => Math.abs(mid(a) - center) - Math.abs(mid(b) - center));
        for (const i of queue) {
          // 新的手势/换文档一来就放弃剩下的 —— 跟手比清晰度重要。
          // ⚠️ 这里不能直接 return 了事：这一次请求（_rerenderWanted）还没被消费，
          // 由 finally 负责补一趟（见下面的说明）。
          if (this._destroyed || gen !== this._gen || this._zoomPreview) return;
          const entry = this.rendered.get(i);
          try {
            if (entry?.dirty) await this._renderPage(i, { gen, soft: true });
            else if (!entry && !this.renderTasks.has(i)) await this._renderPage(i, { gen });
          } catch { /* 单页失败不影响后面的页 */ }
          await nextFrame();
        }        this._reclaimFar();
        if (!this._rerenderWanted) return;
      }
    } finally {
      this._rerenderRunning = false;
      if (didWork && this._rerenderWanted && !this._destroyed) {
        clearTimeout(this._rerenderTimer);
        this._rerenderTimer = setTimeout(() => {
          this._rerenderTimer = 0;
          this._runRerenderPass();
        }, 60);
      } else if (!didWork) {
        this._rerenderWanted = false;
      }
    }
  }

  /** 回收远离视口、留着只会吃内存的页面 */
  _reclaimFar() {
    const [first, last] = this._visibleRange();
    const keepLo = Math.max(1, first - 4);
    const keepHi = Math.min(this.numPages, last + 4);
    for (const i of Array.from(this.rendered.keys())) {
      if (i < keepLo || i > keepHi) this._teardownPage(i);
    }
  }

  _resumeInflight(inflight, gen = this._gen) {
    for (const i of inflight) {
      const p = this.renderTasks.get(i);
      if (p && typeof p.finally === 'function') {
        p.finally(() => { if (gen === this._gen && !this._destroyed) this._renderVisible(true, gen); });
      }
    }
  }

  setScale(scale, { keepCenter = true } = {}) {
    if (!this.pdf || !this.baseSizes[1]) return;
    this.commitZoomPreview();
    const next = clamp(scale, 0.15, 6);
    if (Math.abs(next - this.scale) < 0.0005) return;
    const anchor = keepCenter ? this._captureAnchor() : null;
    this.scale = next;
    this._fitMode = false;
    this._softRescale();          // 先拉伸预览：不拆 DOM，就不会露灰条
    this.layout();
    if (anchor) this._restoreAnchor(anchor);
    this._scheduleRerender();     // 停下后再重画出清晰版
    this.opts.onScale?.(this.scale);
    this.opts.onStatus?.(`缩放 ${Math.round(this.scale * 100)}%`);
  }

  /** Keep the PDF point under a touchpad pinch in place, including horizontal scroll. */
  zoomAt(scale, clientX, clientY) {
    if (!this.pdf) return;
    this.previewScale(scale, { clientX, clientY });
  }

  /**
   * 设置双指缩放速度（1 = 默认手感，见 `clampZoomSpeed` 的说明）。
   * 触摸屏捏合每帧都现读 `this.zoomSpeed`，所以设置页拖动滑杆时下一帧就生效，
   * 不用重开论文，也不打断正在做的手势。
   */
  setZoomSpeed(mult) {
    this.zoomSpeed = clampZoomSpeed(mult);
  }

  fitWidth() {
    if (!this.pdf || !this.baseSizes[1]) return;
    this.commitZoomPreview();
    const anchor = this._captureAnchor();
    this.scale = this._computeFitScale();
    this._fitMode = true;
    this._softRescale();
    this.layout();
    this._restoreAnchor(anchor);
    this._scheduleRerender(80);
    this.opts.onScale?.(this.scale);
    this.opts.onStatus?.(`适应宽度 ${Math.round(this.scale * 100)}%`);
  }

  /* ------------------------------------------------- 虚拟化渲染 */

  _visibleRange() {
    const top = this.container.scrollTop;
    const bottom = top + this.container.clientHeight;
    let first = 1;
    let last = this.numPages;
    for (let i = 1; i <= this.numPages; i++) {
      if (this.offsets[i] === undefined) continue;   // 尺寸还没补齐：跳过，别把范围算成整篇
      if (this.offsets[i] + (this.heights[i] ?? 0) >= top) { first = i; break; }
    }
    for (let i = first; i <= this.numPages; i++) {
      if (this.offsets[i] === undefined) { last = Math.max(first, i - 1); break; }
      if (this.offsets[i] > bottom) { last = Math.max(first, i - 1); break; }
      last = i;
    }
    return [first, last];
  }

  /**
   * 当前页（P1.5）：按「页面矩形 ∩ 阅读区视口」的交集面积最大判定，同面积取更靠近视口中心的一页。
   * 旧实现用「scrollTop + 30% 视口」探针，扫描件/页高不一致时会偏；面积判定与状态栏同一口径。
   * 只读已渲染页面的布局（offsetTop/offsetHeight），不触发渲染；滚动节流由调用方负责。
   * 与 `current` 的区别：这里每次按 scrollTop 现算，不受滚动事件节流影响。
   */
  currentVisiblePage() {
    if (!this.pdf || !this.pageEls.length || !this.offsets.length) return this.current || 1;
    const viewTop = this.container.scrollTop || 0;
    const viewH = this.container.clientHeight || 0;
    if (!viewH) return this.current || 1;
    const viewBottom = viewTop + viewH;
    const viewCenter = viewTop + viewH / 2;
    let best = this.current || 1;
    let bestArea = -1;
    let bestDist = Infinity;
    for (let i = 1; i <= this.numPages; i++) {
      const el = this.pageEls[i];
      if (!el || this.offsets[i] === undefined) continue;
      const top = this.offsets[i];
      const height = el.offsetHeight || this.heights?.[i] || 0;
      if (!height) continue;
      const overlap = Math.min(top + height, viewBottom) - Math.max(top, viewTop);
      if (overlap <= 0) continue;
      const width = el.offsetWidth || 1;
      const area = overlap * width;
      const dist = Math.abs(top + height / 2 - viewCenter);
      if (area > bestArea + 0.5 || (Math.abs(area - bestArea) <= 0.5 && dist < bestDist)) {
        best = i;
        bestArea = area;
        bestDist = dist;
      }
    }
    return bestArea > 0 ? best : (this.current || 1);
  }

  async _renderVisible(force = false, gen = this._gen) {
    if (!this.pdf || !this.offsets.length || gen !== this._gen || this._zoomPreview) return;
    const [first, last] = this._visibleRange();
    const lo = Math.max(1, first - 1);
    const hi = Math.min(this.numPages, last + 1);
    let hasDirty = false;
    for (let i = lo; i <= hi; i++) {
      const entry = this.rendered.get(i);
      if (entry?.dirty) { hasDirty = true; continue; }
      if (!entry && !this.renderTasks.has(i)) this._renderPage(i, { gen });
    }
    if (hasDirty) this._scheduleRerender(0);
    // 回收远处页面，控制内存
    this._reclaimFar();
  }

  /** 首屏布局完成后重画指定页，避免首页在侧栏/窗口尺寸尚未稳定时留下低密度首帧。 */
  async refreshPage(pageNum = 1) {
    const i = Number(pageNum);
    if (!this.pdf || !Number.isInteger(i) || i < 1 || i > this.numPages) return;
    this._teardownPage(i);
    await this._renderPage(i, { force: true, priority: true, gen: this._gen });
  }

  _renderPlan(i, cssW, cssH) {
    const base = renderRatio();          // 实际画多大（含轻微超采样）
    const need = deviceRatio();          // 屏幕真正需要多少
    const wholeCSS = cssW * cssH;
    if (wholeCSS * base * base / 1e6 <= MAX_FULL_MP) return { ratio: base, slice: null };
    /* 整页放不下，但「降一点点倍率就能整页放下」时宁可要整页：
       滚动时不用重画（切片每滚一个边距就得重画一次，2× 屏上很痛）。
       差得多才切成可见区域、保满分辨率 —— 也就是用户要的「放大之后要清晰」。 */
    const capped = Math.sqrt((MAX_FULL_MP * 1e6) / wholeCSS);
    if (capped >= need * WHOLE_PAGE_TOLERANCE) return { ratio: Math.min(capped, base), slice: null };
    const pageEl = this.pageEls[i];
    if (!pageEl) return { ratio: base, slice: null };
    const pr = pageEl.getBoundingClientRect();
    const vr = this.container.getBoundingClientRect();
    const winW = Math.min(cssW, Math.max(1, vr.width));
    const winH = Math.min(cssH, Math.max(1, vr.height));
    const vx0 = clamp(vr.left - pr.left, 0, Math.max(0, cssW - winW));
    const vy0 = clamp(vr.top - pr.top, 0, Math.max(0, cssH - winH));
    const visCSS = winW * winH;
    // 连这个窗口都超预算（超大窗口 + 高 dpr）→ 才降倍率；夹在 [屏幕需求, 目标倍率] 之间
    const ratio = visCSS * base * base / 1e6 > MAX_FULL_MP
      ? clamp(Math.sqrt((MAX_FULL_MP * 1e6) / visCSS), need, base)
      : base;
    const targetCSS = (MAX_FULL_MP * 1e6) / (ratio * ratio);   // 这块位图最多能覆盖多少 CSS 面积
    const spare = targetCSS - visCSS;
    const sum = winW + winH;
    const margin = spare > 0
      ? clamp((-2 * sum + Math.sqrt(4 * sum * sum + 16 * spare)) / 8, 0, SLICE_MARGIN)
      : 0;
    return {
      ratio,
      window: { x: vx0, y: vy0, w: winW, h: winH },
      slice: {
        x: Math.max(0, Math.floor(vx0 - margin)),
        y: Math.max(0, Math.floor(vy0 - margin)),
        w: Math.min(cssW, Math.ceil(vx0 + winW + margin)) - Math.max(0, Math.floor(vx0 - margin)),
        h: Math.min(cssH, Math.ceil(vy0 + winH + margin)) - Math.max(0, Math.floor(vy0 - margin)),
      },
    };
  }

  /** 已渲染的切片是否仍然覆盖当前视口（否则要重画） */
  _sliceCovers(current, need) {
    if (!need) return true;
    if (!current) return false;
    return current.x <= need.x && current.y <= need.y
      && current.x + current.w >= need.x + need.w
      && current.y + current.h >= need.y + need.h;
  }

  /** 滚动时检查切片是否还够用 */
  _refreshSlices() {
    if (this._zoomPreview) return;
    for (const [i, entry] of Array.from(this.rendered.entries())) {
      if (!entry.cssW) continue;
      /* dirty 的页（刚被软缩放拉伸过）已经排在重画队列里了，这里再点一次就是
         两页并行的第二个来源（实测把排队让帧绕过去，长任务又叠成 233ms）。
         队列里那次 _renderPage(..., {soft:true}) 本来就会重算切片。 */
      if (entry.dirty) continue;
      const plan = this._renderPlan(i, entry.cssW, entry.cssH);
      // 倍率变了（窗口/屏幕变了）或者「以前是切片、现在整页放得下了」都要重画回整页
      const ratioDrift = Math.abs(plan.ratio - (entry.ratio || 0)) > 0.01 * plan.ratio;
      const backToFull = !plan.slice && entry.slice;
      // 覆盖率只比 `window`（必须覆盖的可见窗口），边距是"提前画的余量"，不算需求
      if (!ratioDrift && !backToFull && this._sliceCovers(entry.slice, plan.window)) continue;
      // 滚动很快时同一页可能连续触发多次切片刷新；保留当前任务，避免每 60ms
      // 取消并重开一次文本层，导致引用热点出现可点击空窗。
      if (this.renderTasks.has(i)) continue;
      this._renderPage(i, { force: true });
    }
  }

  async _renderPage(i, { priority = false, gen = this._gen, force = false, soft = false } = {}) {
    const t0 = this._perf ? performance.now() : 0;
    if (!this.pdf || gen !== this._gen) return;
    // 无论调用方是否带 force，都不要取消一份正在生成的文本层；等它自然结束后
    // 再由切片检查决定是否需要下一轮。这样旧热点可以继续覆盖当前页面。
    if (this.renderTasks.has(i)) return;
    if (!force && !soft && this.rendered.has(i)) return;
    const pageEl = this.pageEls[i];
    if (!pageEl) return;
    const storedEntry = this.rendered.get(i);
    const prevEntry = storedEntry?.canvas?.parentElement === pageEl ? storedEntry : null;
    if (storedEntry && !prevEntry) this.rendered.delete(i);
    const prevCanvas = prevEntry?.canvas || null;
    const reusePinLayer = !!(prevEntry?.pinLayer
      && Math.abs(Number(prevEntry.renderScale || this.scale) - this.scale) < 0.001);
    // Keep the entire old page live while the new canvas renders. In particular,
    // a pinch can continue during this task, and _softRescale must still move the
    // visible preview rather than only resizing a hidden replacement canvas.

    const stale = () => gen !== this._gen || this._destroyed;

    const run = async () => {
      let page;
      try {
        page = await this.pdf.getPage(i);
      } catch (e) {
        if (!stale()) this.opts.onStatus?.(`第 ${i} 页加载失败：${e.message}`);
        return;
      }
      if (stale() || !this.pageEls[i]) return;

      const viewport = page.getViewport({ scale: this.scale });
      const cssW = viewport.width;
      const cssH = viewport.height;
      // 倍率与区域一起定：先按 dpr 定画哪一块，再按这块的面积分配预算（见 _renderPlan）
      const { ratio, slice } = this._renderPlan(i, cssW, cssH);
      const drawW = slice ? slice.w : cssW;
      const drawH = slice ? slice.h : cssH;
      const ox = slice ? slice.x : 0;
      const oy = slice ? slice.y : 0;

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(drawW * ratio));
      canvas.height = Math.max(1, Math.floor(drawH * ratio));
      canvas.style.width = `${drawW}px`;
      canvas.style.height = `${drawH}px`;
      canvas.style.left = `${ox}px`;
      canvas.style.top = `${oy}px`;
      canvas.classList.remove('soft-zoom');
      // 换帧时先把新画布藏起来，等画完再露出来 —— 否则会先闪一下白底。
      // 注意不能用 z-index 压住旧画布：文本层没有 z-index（靠 DOM 顺序盖在画布上），
      // 一旦给画布设了 z-index，它就会盖住文本层，鼠标点不到文字 —— 选取文字直接失效。
      // 这里靠 DOM 顺序解决：新画布插在旧画布后面，天然在上层。
      if (prevCanvas) canvas.style.visibility = 'hidden';
      const ctx = canvas.getContext('2d', { alpha: false });
      const paper = paperColor();
      ctx.fillStyle = paper;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const textDiv = document.createElement('div');
      textDiv.className = 'textLayer';
      const hlLayer = document.createElement('div');
      hlLayer.className = 'hl-layer';
      const hitLayer = document.createElement('div');
      hitLayer.className = 'search-hit-layer';
      // 引用定位高亮单独一层（橙色）；与搜索命中分开，互不覆盖，也不参与搜索跳转
      const quoteLayer = document.createElement('div');
      quoteLayer.className = 'quote-layer';
      // 笔记书签单独一层，z-index 必须高于文本层，否则点不到
      const pinLayer = reusePinLayer ? prevEntry.pinLayer : document.createElement('div');
      pinLayer.className = 'hl-pin-layer';
      if (!reusePinLayer) pinLayer.style.transform = '';

      const entry = {
        canvas, textDiv, hlLayer, hitLayer, quoteLayer, pinLayer, task: null, textLayer: null,
        slice, ratio, cssW, cssH,
        renderScale: this.scale,   // 这张位图是按哪个比例画的（软缩放拉伸时要用）
        dirty: false,
        // 下面两张是命中表（页面内局部坐标）：citeHits 由 _paintCites 填，hitBoxes 由 _tileTextHitBoxes 填
        citeHits: [],
        hitBoxes: null,
      };
      if (!prevEntry) this.rendered.set(i, entry);

      // 先把 canvas 插进去，滚动时不会闪白。
      // 有旧画布时插在它后面（DOM 顺序即层级，见上面的说明），否则插到最前面。
      pageEl.classList.remove('placeholder');
      if (prevCanvas) {
        prevCanvas.after(canvas);
      } else {
        pageEl.prepend(hlLayer, hitLayer, quoteLayer, canvas);
        pageEl.append(textDiv, pinLayer);
      }

      const renderTask = page.render({
        canvasContext: ctx,
        viewport,
        // pdf.js 会先应用这个 transform，再叠加 viewport 自己的变换。
        // 所以 [ratio,0,0,ratio,-ox*ratio,-oy*ratio] 就是「把 (ox,oy) 这块搬到画布原点，并放大 ratio 倍」
        transform: [ratio, 0, 0, ratio, -ox * ratio, -oy * ratio],
        background: paper,
      });
      entry.task = renderTask;
      try {
        await renderTask.promise;
      } catch (e) {
        if (e?.name !== 'RenderingCancelledException' && !stale()) {
          this.opts.onStatus?.(`第 ${i} 页渲染失败：${e.message}`);
        }
        // 这次没画成：把藏着的半成品摘掉，让上一张预览继续顶着
        if (prevCanvas) {
          canvas.remove();
          pageEl.classList.remove('placeholder');
        }
        return;
      }
      if (stale() || this.rendered.get(i) !== (prevEntry || entry)) {
        canvas.remove();
        return;
      }
      // A later pinch moved the page while this bitmap was rendering. Keep the
      // live preview and render once more at the latest scale; never flash an
      // obsolete, differently sized bitmap in front of it.
      if (Math.abs(this.scale - entry.renderScale) > 0.001) {
        if (prevCanvas) canvas.remove();
        (prevEntry || entry).dirty = true;
        this._scheduleRerender(80);
        return;
      }

      // 新版画好了：露出来，再把上一张预览扔掉（这一步才是「换帧」，中间没有空白）
      if (prevCanvas) {
        canvas.style.visibility = '';
        prevEntry.textDiv.remove();
        prevEntry.hlLayer.remove();
        prevEntry.hitLayer.remove();
        prevEntry.quoteLayer?.remove();
        if (!reusePinLayer) prevEntry.pinLayer?.remove();
        this.rendered.set(i, entry);
        prevCanvas.before(hlLayer, hitLayer, quoteLayer);
        pageEl.append(textDiv, pinLayer);
        try { prevCanvas.width = 0; prevCanvas.height = 0; } catch { /* ignore */ }
        prevCanvas.remove();
      }
      /* 换帧即收尾：这一页的「临时缩放」必须在这里归零 ——
         canvas 不再是拉伸预览、四个覆盖层不再有 transform。
         不变量：steady(transform 全空) → preview(pages 层 transform) → committing → steady。
         漏掉这一步，旧 transform 会和新比例同时生效（就是那个"双重缩放"）。 */
      this._resetLayerScale(entry);
      entry.dirty = false;

      // 文本层
      try {
        let textContent = null;
        try {
          textContent = await page.getTextContent({ includeMarkedContent: true });
        } catch { textContent = null; }
        if (stale()) return;
        const tl = new pdfjsLib.TextLayer({
          textContentSource: textContent
            ? { items: textContent.items, styles: textContent.styles, lang: textContent.lang }
            : page.streamTextContent({ includeMarkedContent: true }),
          container: textDiv,
          viewport,
        });
        entry.textLayer = tl;
        await tl.render();
        if (!stale()) {
          await this._bindRealFonts(textDiv, page, textContent);
          if (!stale()) {
            this._freezeTextLayerMetrics(textDiv, entry);
            this._normalizeTextScale(textDiv);
            this._nudgeTextLayer(textDiv, page);
            /* 顺序在最后：命中盒铺满必须按**最终**的字形盒子算（字体、字距、垂直补偿都定了）。
               返回值是这一页的命中表（页面内局部坐标），`charPosAt()` 直接用它做几何命中，
               不再每次鼠标移动都逐 span 读 DOM。 */
            entry.hitBoxes = this._tileTextHitBoxes(textDiv) || null;
            this._paintCites(i);
          }
        }
      } catch (e) {
        if (!stale()) console.warn(`第 ${i} 页文本层构建失败`, e);
      }
      if (stale()) return;

      // 恢复高亮 & 搜索命中 & 当前选区
      this._paintHighlights(i);
      this._paintHits(i);
      this._paintQuote(i);
      // 选中方块也要重画：虚拟化会把页面整个卸掉，再滚回来时
      // 浏览器那边的选区已经没了，不重画的话「选中的文字」看起来就凭空消失了
      this._paintSel(i);
      document.dispatchEvent(new CustomEvent('pdfview:page-rendered', { detail: { page: i } }));
    };

    const p = run().finally(() => {
      this.renderTasks.delete(i);
      if (this._perf) { this._perf.renders++; this._perf.renderMs += performance.now() - t0; }
    });
    this.renderTasks.set(i, p);
    return p;
  }

  _teardownPage(i) {
    const entry = this.rendered.get(i);
    if (!entry) return;
    try { entry.task?.cancel(); } catch { /* ignore */ }
    try { entry.canvas.width = 0; entry.canvas.height = 0; } catch { /* ignore */ }
    entry.canvas.remove();
    entry.textDiv.remove();
    entry.hlLayer.remove();
    entry.hitLayer.remove();
    entry.quoteLayer?.remove();
    entry.pinLayer?.remove();
    this.rendered.delete(i);
    const el = this.pageEls[i];
    if (el) el.classList.add('placeholder');
  }

  /** 纸张背景设置改变时，按当前颜色重画已渲染页面；不清空文本层和滚动位置。 */
  refreshPaper() {
    if (!this.pdf) return;
    for (const entry of this.rendered.values()) entry.dirty = true;
    this._renderVisible(true);
  }

  /* ------------------------------------------------------------ 滚动/页码 */

  _handleScroll() {
    if (!this.pdf || !this.pageEls.length || !this.offsets.length) return;
    this._touchPerf('滚动');
    const [first, last] = this._visibleRange();
    // 页码 = 视口上部 30% 处所在的页
    const probe = this.container.scrollTop + this.container.clientHeight * 0.3;
    let cur = first;
    for (let i = first; i <= last; i++) {
      if (this.offsets[i] === undefined) break;   // 尺寸没补齐：保持当前页，别把页码算到最后一页
      if (probe >= this.offsets[i]) cur = i;
      else break;
    }
    if (cur !== this.current) {
      this.current = cur;
      this.opts.onPageChange?.(cur, this.numPages);
    }
    this._renderVisible();
    this._refreshSlices();
  }

  async goToPage(n, { smooth = false } = {}) {
    const target = clamp(Math.round(n), 1, this.numPages || 1);
    if (!this.pageEls[target]) return;
    this._pendingScrollTo = target;
    this.container.scrollTo({ top: this.offsets[target] ?? 0, behavior: smooth ? 'smooth' : 'auto' });
    this.current = target;
    this.opts.onPageChange?.(target, this.numPages);
    await this._renderVisible(true);
  }

  capturePosition() {
    return { scrollTop: this.container.scrollTop, scale: this.scale };
  }

  async restorePosition(position) {
    if (!this.pdf || !position) return;
    if (Number.isFinite(position.scale) && position.scale > 0) {
      this.setScale(position.scale, { keepCenter: false });
      this._fitMode = false;
    }
    const maxTop = Math.max(0, this.container.scrollHeight - this.container.clientHeight);
    this.container.scrollTo({ top: clamp(Number(position.scrollTop) || 0, 0, maxTop), behavior: 'auto' });
    this._handleScroll();
    await this._renderVisible(true);
  }

  /* ------------------------------------------------------------ 文本 */

  async getPageText(i) {
    if (this.textCache.has(i)) return this.textCache.get(i);
    if (!this.pdf) return '';
    const gen = this._gen;
    try {
      const page = await this.pdf.getPage(i);
      const tc = await page.getTextContent();
      if (gen !== this._gen) return '';
      let out = '';
      for (const it of tc.items) {
        if (typeof it.str !== 'string') continue;
        out += it.str;
        if (it.hasEOL) out += '\n';
      }
      out = out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      this.textCache.set(i, out);
      return out;
    } catch {
      return '';
    }
  }

  /** 整篇文本：用于「带全文提问」和导出 */
  async getAllText(onProgress) {
    const gen = this._gen;
    const parts = [];
    for (let i = 1; i <= this.numPages; i++) {
      const t = await this.getPageText(i);
      if (gen !== this._gen) return '';
      parts.push(`\n\n===== p.${i} =====\n${t}`);
      if (i % 10 === 0) onProgress?.(i, this.numPages);
    }
    onProgress?.(this.numPages, this.numPages);
    return parts.join('').trim();
  }

  /* ------------------------------------------------------------ 页型扫描 / 页图 */

  /**
   * 打开后逐页判断页型：有没有文本层、是不是扫描图、有没有大图。
   * 只读文本流和算子表，不渲染像素；几十页的字数/图片覆盖率通常在 1s 量级。
   * 结果只用来决定「问答/教学要不要带页图」，不是精确版面分析。
   * @returns {Promise<null|{version:number,numPages:number,pages:Array,scanned:boolean,
   *   scanPages:number[],figurePages:number[],textChars:number,avgChars:number}>}
   */
  async scanDocProfile({ onProgress = null, shouldStop = () => false } = {}) {
    if (!this.pdf) return null;
    const gen = this._gen;
    const OPS = pdfjsLib?.OPS || null;
    // 2D 仿射矩阵乘法（列向量约定，与 PDF.js 的 transform 参数一致）
    const multiply = (m1, m2) => [
      m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ];
    const pages = [];
    for (let i = 1; i <= this.numPages; i++) {
      if (gen !== this._gen || this._destroyed || shouldStop()) return null;
      const page = await this.pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const pageArea = Math.max(1, viewport.width * viewport.height);
      let textChars = 0;
      let oddChars = 0;
      try {
        const tc = await page.getTextContent();
        for (const item of tc.items) {
          if (!item || typeof item.str !== 'string') continue;
          const s = item.str.trim();
          if (!s) continue;
          textChars += s.length;
          // 低质 OCR 留下的假文本层：cid 占位符 / 私用区字符 / 替换符
          if (/\(cid:\d+\)|[\uE000-\uF8FF\uFFFD]/.test(s)) oddChars += s.length;
        }
      } catch { /* 文本层取不到：按无文本处理 */ }
      let imageCount = 0;
      let imageCoverage = 0;
      let vectorOps = 0;
      try {
        const ops = await page.getOperatorList();
        let ctm = [1, 0, 0, 1, 0, 0];
        const stack = [];
        for (let k = 0; k < ops.fnArray.length; k++) {
          const fn = ops.fnArray[k];
          if (fn === OPS.save) stack.push(ctm);
          else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
          else if (fn === OPS.transform) ctm = multiply(ctm, ops.argsArray[k] || [1, 0, 0, 1, 0, 0]);
          else if (fn === OPS.setTransform) {
            const a = ops.argsArray[k];
            ctm = Array.isArray(a) && a.length >= 6 ? a.slice(0, 6) : [1, 0, 0, 1, 0, 0];
          } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
            imageCount++;
            // 图像画在单位正方形上再由 CTM 放大 → |det(CTM)| 就是它在页面上的面积
            imageCoverage += Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]) / pageArea;
          } else if (fn === OPS.paintImageMaskXObject || fn === OPS.paintImageMaskXObjectRepeat
            || fn === OPS.paintImageMaskXObjectGroup || fn === OPS.paintInlineImageXObjectGroup) {
            imageCount++;
            imageCoverage += Math.min(1, Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]) / pageArea);
          } else if (fn === OPS.constructPath || fn === OPS.fill || fn === OPS.eoFill || fn === OPS.stroke) {
            vectorOps++;
          }
        }
      } catch { /* 算子表取不到：按纯文本页处理 */ }
      const coverage = Number(Math.min(1, imageCoverage).toFixed(3));
      const oddRatio = textChars ? Number((oddChars / textChars).toFixed(2)) : 0;
      let kind;
      if (textChars >= 200 && coverage < 0.15) kind = 'text';
      else if (textChars < 40 && coverage >= 0.5) kind = 'scan';
      else if (textChars < 40 && imageCount > 0) kind = coverage >= 0.2 ? 'scan' : 'figure';
      else if (textChars < 300 && coverage > 0.3) kind = 'figure';
      else if (textChars < 40) kind = 'blank';
      else kind = 'text';
      if (oddRatio > 0.3 && coverage > 0.2) kind = 'scan';
      pages.push({
        page: i, kind, chars: textChars, imageCount, coverage, vectorOps, oddRatio,
      });
      onProgress?.(i, this.numPages);
    }
    if (gen !== this._gen || this._destroyed) return null;
    const textChars = pages.reduce((n, p) => n + p.chars, 0);
    const scanPages = pages.filter((p) => p.kind === 'scan').map((p) => p.page);
    const figurePages = pages.filter((p) => p.kind === 'figure').map((p) => p.page);
    // 过半页面是扫描页，或整篇平均每页不到 20 字 → 按扫描件处理
    const scanned = scanPages.length >= Math.max(1, Math.ceil(pages.length * 0.5))
      || textChars < pages.length * 20;
    const profile = {
      version: 1,
      numPages: this.numPages,
      pages,
      scanned,
      scanPages,
      figurePages,
      textChars,
      avgChars: Math.round(textChars / Math.max(1, pages.length)),
      scannedAt: Date.now(),
    };
    this.scanCache.set('doc', profile);
    return profile;
  }

  /** 渲染整页为图片（扫描件的问答 / 教学上下文用）；同一页同一尺寸会缓存 */
  async capturePageImage(pageNum, { maxDim = 1400, quality = 0.85 } = {}) {
    const key = `${pageNum}:${maxDim}`;
    const hit = this._pageImageCache.get(key);
    if (hit) return hit;
    if (!this.pdf) throw new Error('没有打开的文档');
    const page = await this.pdf.getPage(pageNum);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.5, Math.max(0.4, maxDim / Math.max(base.width, base.height)));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    const outWidth = Math.max(1, Math.floor(viewport.width));
    const outHeight = Math.max(1, Math.floor(viewport.height));
    canvas.width = outWidth;
    canvas.height = outHeight;
    const ctx = canvas.getContext('2d', { alpha: false });
    const paper = paperColor();
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, outWidth, outHeight);
    await page.render({ canvasContext: ctx, viewport, background: paper }).promise;
    let dataUrl = canvas.toDataURL('image/jpeg', quality);
    if (dataUrl.length > 750_000) dataUrl = canvas.toDataURL('image/jpeg', 0.6);
    canvas.width = 0;
    canvas.height = 0;
    const shot = { dataUrl, width: outWidth, height: outHeight, page: pageNum };
    if (this._pageImageCache.size > 24) this._pageImageCache.delete(this._pageImageCache.keys().next().value);
    this._pageImageCache.set(key, shot);
    return shot;
  }

  /** 全文搜索：每个命中一条，包含页码、页内序号和可读的上下文片段 */
  async search(query, { onProgress } = {}) {    const q = String(query || '').trim();
    if (!q) return { hits: [], total: 0 };
    const gen = this._gen;
    const hits = [];
    let total = 0;
    for (let i = 1; i <= this.numPages; i++) {
      const text = await this.getPageText(i);
      if (gen !== this._gen) return { hits: [], total: 0, stale: true };
      const lower = text.toLowerCase();
      const needle = q.toLowerCase();
      let from = 0;
      let pageIndex = 0;
      let at;
      while ((at = lower.indexOf(needle, from)) !== -1) {
        const beforeAt = Math.max(0, at - 48);
        const afterAt = Math.min(text.length, at + q.length + 64);
        hits.push({
          page: i,
          pageIndex,
          index: total,
          offset: at,
          before: `${beforeAt > 0 ? '…' : ''}${text.slice(beforeAt, at)}`,
          match: text.slice(at, at + q.length),
          after: `${text.slice(at + q.length, afterAt)}${afterAt < text.length ? '…' : ''}`,
        });
        pageIndex++;
        total++;
        from = at + Math.max(1, needle.length);
      }
      if (onProgress && i % 5 === 0) onProgress(i, this.numPages);
    }
    return { hits, total };
  }

  _paintHits(i) {
    const entry = this.rendered.get(i);
    if (!entry) return;
    entry.hitLayer.innerHTML = '';
    const q = this._activeQuery;
    if (!q) return;
    const pageEl = this.pageEls[i];
    const pr = pageEl.getBoundingClientRect();
    // 排除 .markedContent 包装 span：display:contents，尺寸恒为 0，还会让同一个词匹配两次
    const spans = Array.from(entry.textDiv.querySelectorAll('span:not(.markedContent)'));

    for (const seg of findInSpans(spans, q)) {
      const span = spans[seg.spanIndex];
      const node = span && span.firstChild;
      if (!node || node.nodeType !== 3) continue;
      const a = Math.min(seg.start, node.length);
      const b = Math.min(seg.end, node.length);
      if (b <= a) continue;
      const range = document.createRange();
      try {
        range.setStart(node, a);
        range.setEnd(node, b);
      } catch {
        continue;
      }
      for (const r of range.getClientRects()) {
        if (r.width < 0.5 || r.height < 0.5) continue;
        const d = document.createElement('div');
        d.className = `search-hit${this._activeHit?.page === i && this._activeHit.index === seg.hitIndex ? ' current' : ''}`;
        d.dataset.hitIndex = String(seg.hitIndex);
        d.style.left = `${r.left - pr.left}px`;
        d.style.top = `${r.top - pr.top}px`;
        d.style.width = `${r.width}px`;
        d.style.height = `${r.height}px`;
        entry.hitLayer.append(d);
      }
    }
  }

  repaintHits() {
    for (const [i] of this.rendered) this._paintHits(i);
  }

  /* ------------------------------------------------------------ 引用定位高亮（橙色，可取消） */

  /** 清掉引用高亮（点击正文 / Esc / 再点同一个引用 / 翻页 / 切文档时调用） */
  clearQuoteHighlight() {
    this._quote = null;
    for (const [, entry] of this.rendered) {
      if (entry.quoteLayer) entry.quoteLayer.innerHTML = '';
    }
  }

  hasQuoteHighlight() {
    return !!(this._quote && this._quote.page);
  }

  /**
   * 跳到某页并高亮「原文片段」（模型引用里的 〔p.N‖片段〕 用）。
   * 刻意做成「一次到位」：即时跳页（不做平滑滚动动画）、只有目标页还没渲染时才等它渲染，
   * 已渲染的页面绝不重建（之前每次 refreshPage 都会把画布拆掉重画，看起来就是闪一下）。
   * 高亮位置已经在视口里时不再滚动，避免同一引用连点时来回动。
   * 片段跨页时（换页处被切开）会把剩余部分接着画到后面几页（用户实测：之前只画第一页的）。
   * @returns {Promise<boolean>} 是否画出了高亮
   */
  async highlightQuote(pageNum, fragment) {
    const target = clamp(Math.round(Number(pageNum) || 1), 1, this.numPages || 1);
    // 片段可能是一整句（比按钮 title 里显示的更长），高亮时尽量覆盖整句，不能只画开头几个字
    const text = String(fragment || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    this._quote = { page: target, fragment: text };
    // 即时跳页（behavior:auto），目标页没渲染好就等它的渲染任务；已渲染就直接用
    await this.goToPage(target);
    if (!this.rendered.get(target)?.textDiv) {
      await this.renderTasks.get(target)?.catch?.(() => {});
    }
    if (!this.rendered.get(target)?.textDiv) {
      // 兜底：仍没有文本层（极少见）才重建这一页
      await this.refreshPage(target);
    }
    const start = this._matchQuote(this._quoteSpans(target), text);
    let ok = false;
    if (start.hits.length) {
      this._paintQuote(target);
      ok = true;
      // 跨页片段：这一页没放完的部分，从下一页开头接着找
      const extra = await this._quoteExtraPages(target, start.consumed);
      if (Object.keys(extra).length) {
        this._quote.extra = extra;
        for (const p of Object.keys(extra)) {
          if (this.rendered.get(Number(p))?.textDiv) this._paintQuote(Number(p));
        }
      }
    }
    if (!ok) return false;
    const entry = this.rendered.get(target);
    const first = entry?.quoteLayer?.firstElementChild;
    if (!first) return true;
    // 已经在视口里就不动滚动条：连点同一个引用不会来回晃
    const view = this.container.getBoundingClientRect();
    const rect = first.getBoundingClientRect();
    const margin = Math.min(80, this.container.clientHeight * 0.15);
    const visible = rect.top >= view.top + margin && rect.bottom <= view.bottom - margin;
    if (!visible) {
      const y = parseFloat(first.style.top || '0');
      const pageTop = this.offsets[target] ?? 0;
      const want = Math.max(0, pageTop + y - this.container.clientHeight * 0.35);
      this.container.scrollTo({ top: want, behavior: 'auto' });
    }
    return true;
  }

  /** 某页文本层的 spans（没渲染/没有文本层时返回空数组） */
  _quoteSpans(i) {
    const entry = this.rendered.get(i);
    if (!entry?.textDiv) return [];
    return Array.from(entry.textDiv.querySelectorAll('span:not(.markedContent)'));
  }

  /** 把一页文本压成「去空白小写串」，并记住每个字在原文里的下标 */
  _normPageText(text) {
    const map = [];
    let norm = '';
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i])) continue;
      map.push(i);
      norm += text[i];
    }
    return { lower: norm.toLowerCase(), map };
  }

  /**
   * 跨页片段：从 target+1 页开始，把片段「还没画完」的剩余部分接着找出来。
   * 返回 { 页码: 该页要画的那段原文 }，供 _paintQuote 在后面几页照常画。
   */
  async _quoteExtraPages(target, consumed) {
    const extra = {};
    const fNorm = String(this._quote?.fragment || '').replace(/\s+/g, '').toLowerCase();
    let remain = fNorm.slice(Math.max(0, consumed));
    if (remain.length < 6) return extra;
    for (let page = target + 1; page <= this.numPages && page <= target + 3 && remain.length >= 6; page += 1) {
      let pageText = '';
      try { pageText = await this.getPageText(page); } catch { break; }
      if (!pageText) break;
      const { lower, map } = this._normPageText(String(pageText));
      let matched = 0;
      let idx = -1;
      for (const len of [...new Set([Math.min(remain.length, 80), 60, 40, 24, 14, 8])]) {
        if (len > remain.length || len < 6) continue;
        const at = lower.indexOf(remain.slice(0, len));
        if (at >= 0) { matched = len; idx = at; break; }
      }
      if (idx < 0 || matched < 6) break;
      extra[page] = String(pageText).slice(map[idx], map[idx + matched - 1] + 1);
      remain = remain.slice(matched);
    }
    return extra;
  }

  /** 只重画某一页的引用高亮（页面重渲染后由 _renderPage 调用） */
  _paintQuote(i) {
    const entry = this.rendered.get(i);
    if (!entry) return false;
    if (entry.quoteLayer) entry.quoteLayer.innerHTML = '';
    const quote = this._quote;
    if (!quote?.page || !entry.textDiv) return false;
    const fragment = quote.page === i ? quote.fragment : (quote.extra?.[i] || '');
    if (!fragment) return false;
    const pageEl = this.pageEls[i];
    if (!pageEl) return false;
    const pr = pageEl.getBoundingClientRect();
    const spans = this._quoteSpans(i);
    const { hits } = this._matchQuote(spans, fragment);
    if (!hits.length) return false;
    let painted = 0;
    for (const seg of hits) {
      const span = spans[seg.spanIndex];
      const node = span && span.firstChild;
      if (!node || node.nodeType !== 3) continue;
      const a = Math.min(seg.start, node.length);
      const b = Math.min(seg.end, node.length);
      if (b <= a) continue;
      const range = document.createRange();
      try { range.setStart(node, a); range.setEnd(node, b); } catch { continue; }
      for (const r of range.getClientRects()) {
        if (r.width < 0.5 || r.height < 0.5) continue;
        const d = document.createElement('div');
        d.className = 'quote-hit';
        d.style.left = `${r.left - pr.left}px`;
        d.style.top = `${r.top - pr.top}px`;
        d.style.width = `${r.width}px`;
        d.style.height = `${r.height}px`;
        entry.quoteLayer.append(d);
        painted += 1;
      }
    }
    return painted > 0;
  }

  /**
   * 片段匹配：把页面 span 文本压成「去掉空白的小写串」再定位起点，
   * 然后尽量延伸到整句结束（用句尾回找 + 贪心延伸容忍连字符/换行/个别字差）。
   * @returns {{hits: Array, consumed: number}} hits 覆盖完整片段的 span 区间；
   *          consumed 是这一页「吃掉」了多少个去掉空白的片段字符（跨页时接着找下一页）。
   */
  _matchQuote(spans, fragment) {
    const raw = String(fragment || '').trim();
    if (!raw || !spans.length) return { hits: [], consumed: 0 };
    const fNorm = raw.replace(/\s+/g, '').toLowerCase();
    if (fNorm.length < 2) return { hits: [], consumed: 0 };
    // norm = 页面文本去掉空白；pos[i] 记住第 i 个字对应哪个 span 的哪个字符
    const pos = [];
    let norm = '';
    spans.forEach((span, spanIndex) => {
      const text = span.textContent || '';
      for (let i = 0; i < text.length; i++) {
        if (/\s/.test(text[i])) continue;
        pos.push({ spanIndex, charIndex: i });
        norm += text[i];
      }
    });
    const lower = norm.toLowerCase();
    let at = lower.indexOf(fNorm);
    let end = at < 0 ? -1 : at + fNorm.length;
    if (at < 0) {
      // 整句对不上（换行、连字符、个别字差）：先用最长前缀找起点，再靠句尾把终点补回来
      let startLen = 0;
      for (const len of [160, 120, 90, 60, 40, 24, 16, 10, 6]) {
        if (fNorm.length <= len) continue;
        at = lower.indexOf(fNorm.slice(0, len));
        if (at >= 0) { startLen = len; break; }
      }
      if (at < 0) return { hits: [], consumed: 0 };
      end = at + startLen;
      const tailLen = Math.min(24, fNorm.length);
      if (tailLen >= 6) {
        const te = lower.indexOf(fNorm.slice(-tailLen), at + 1);
        if (te > at) end = Math.max(end, te + tailLen);
      }
      // 中段最多容忍 2 个字符不一致，逐字向后延伸；一旦连续对不上就停（不跨到下一句）
      let k = startLen;
      let miss = 0;
      while (at + k < lower.length && k < fNorm.length && miss <= 2) {
        if (lower[at + k] === fNorm[k]) { k += 1; miss = 0; } else { miss += 1; }
      }
      if (k > end - at) end = at + k;
      end = Math.min(end, lower.length);
    }
    if (end <= at) return { hits: [], consumed: 0 };
    const consumed = Math.min(end - at, fNorm.length);
    // norm 区间 → span 区间（同一 span 里取首尾，跨 span 逐段拆）
    const out = [];
    let cur = null;
    for (let i = at; i < end; i++) {
      const p = pos[i];
      if (!p) continue;
      if (cur && cur.spanIndex === p.spanIndex) { cur.end = p.charIndex + 1; continue; }
      if (cur) out.push(cur);
      cur = { spanIndex: p.spanIndex, start: p.charIndex, end: p.charIndex + 1 };
    }
    if (cur) out.push(cur);
    return {
      hits: out.map((seg) => ({ hitIndex: 0, spanIndex: seg.spanIndex, start: seg.start, end: seg.end })),
      consumed,
    };
  }

  setActiveQuery(q) {
    this._activeQuery = q || '';
    this._activeHit = null;
    this.repaintHits();
  }

  /** 跳到页内指定命中，多个命中在同一页也能逐个定位 */
  async gotoHit(page, pageIndex = 0, isCurrent = () => true) {
    const gen = this._gen;
    this._activeHit = { page, index: pageIndex };
    await this.goToPage(page);
    if (gen !== this._gen || !isCurrent()) return;
    await this.renderTasks.get(page)?.catch?.(() => {});
    if (gen !== this._gen || !isCurrent()) return;
    const entry = this.rendered.get(page);
    if (!entry) return;
    this._paintHits(page);
    const first = entry.hitLayer.querySelector(`[data-hit-index="${pageIndex}"]`);
    if (first) {
      const pageTop = this.offsets[page] ?? 0;
      const y = parseFloat(first.style.top || '0');
      this.container.scrollTo({ top: Math.max(0, pageTop + y - this.container.clientHeight * 0.35), behavior: 'smooth' });
    }
  }

  /* ------------------------------------------------------------ 目录 */

  async getOutline() {
    if (!this.pdf) return [];
    let raw = [];
    try {
      raw = (await this.pdf.getOutline()) || [];
    } catch {
      return [];
    }
    const out = [];
    const walk = async (items, level) => {
      for (const it of items) {
        let page = null;
        let top = null;
        try {
          let dest = it.dest;
          if (typeof dest === 'string') dest = await this.pdf.getDestination(dest);
          if (Array.isArray(dest) && dest[0]) {
            const idx = await this.pdf.getPageIndex(dest[0]);
            page = idx + 1;
            top = destTop(dest);   // 书签目标里带着 Y，用它可以精确停在标题上
          }
        } catch { /* 忽略坏目录项 */ }
        out.push({ title: it.title, page, top, level });
        if (it.items?.length) await walk(it.items, level + 1);
      }
    };
    await walk(raw, 1);
    return out;
  }

  async goToDest({ page, top = null }, { smooth = true, margin = 6 } = {}) {
    const target = clamp(Math.round(page || 1), 1, this.numPages || 1);
    if (!this.pageEls[target]) return;
    let y = this.offsets[target] ?? 0;
    if (top !== null && Number.isFinite(top)) {
      try {
        const p = await this.pdf.getPage(target);
        const vp = p.getViewport({ scale: 1 });
        // convertToViewportPoint 把 PDF 坐标（原点在左下）翻成视口坐标（原点在左上），
        // 页面有旋转也一并处理了
        const vy = vp.convertToViewportPoint(0, top)[1];
        if (Number.isFinite(vy)) y += vy * this.scale;
      } catch { /* 换算失败就退回页顶 */ }
    }
    this._pendingScrollTo = target;
    this.container.scrollTo({ top: Math.max(0, Math.round(y - margin)), behavior: smooth ? 'smooth' : 'auto' });
    this.current = target;
    this.opts.onPageChange?.(target, this.numPages);
    await this._renderVisible(true);
  }

  /* ------------------------------------------------------------ 选区 */

  /** 读取当前浏览器选区，返回与页面绑定的干净文本和坐标 */
  getSelectionInfo() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const text = sel.toString();
    if (!text.trim()) return null;

    const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const pageEl = startEl?.closest?.('.page');
    if (!pageEl) return null;

    const pageNum = Number(pageEl.dataset.page);
    const pr = pageEl.getBoundingClientRect();
    const rawRects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);

    // 选区可能横跨多页：每个矩形按它实际落在的那一页归一化。
    // 全按起始页归一化的话，落到下一页的矩形会在起始页上画到错误的位置。
    const byPage = new Map();
    for (const r of rawRects) {
      const cx = (r.left + r.right) / 2;
      const cy = (r.top + r.bottom) / 2;
      let host = null;
      for (let p = 1; p <= this.numPages; p++) {
        const el = this.pageEls[p];
        if (!el) continue;
        const box = el.getBoundingClientRect();
        if (cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom) { host = { p, box }; break; }
      }
      if (!host) continue;
      const arr = byPage.get(host.p) || [];
      // 归一化后夹进 [0,1]：跨页/跨栏时偶尔会有矩形探出页面边界，
      // 不夹的话会画出横贯整页的方块
      const nx = clamp((r.left - host.box.left) / host.box.width, 0, 1);
      const nw = clamp(r.width / host.box.width, 0, 1 - nx);
      const ny = clamp((r.top - host.box.top) / host.box.height, 0, 1);
      const nh = clamp(r.height / host.box.height, 0, 1 - ny);
      arr.push({ x: nx, y: ny, w: nw, h: nh });
      byPage.set(host.p, arr);
    }

    const box = range.getBoundingClientRect();
    const endEl = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement;
    const endPage = endEl?.closest?.('.page');

    // 去掉上下重叠：pdf.js 的行盒常常比行距还高，不过一遍的话
    // 选区/高亮看起来就是一块块互相压着的方块
    for (const [p, arr] of byPage) byPage.set(p, normalizeRects(arr));

    const pages = Array.from(byPage.keys()).sort((a, b) => a - b);
    return {
      text,
      page: pageNum,
      endPage: endPage ? Number(endPage.dataset.page) : pageNum,
      rects: byPage.get(pageNum) || [],
      rectsByPage: Object.fromEntries(byPage),
      pages,
      // 视口坐标，用于定位浮动气泡
      box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height },
      pageRect: { left: pr.left, top: pr.top, width: pr.width, height: pr.height },
    };
  }

  clearSelection() {
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
  }

  /** 选区所在页的上下文（前后各若干字符），给模型当语境 */
  async getContextAround(pageNum, text, span = 700) {
    const full = await this.getPageText(pageNum);
    if (!full) return '';
    const normalize = (s) => String(s).normalize('NFKC').replace(/([A-Za-z])-\s+([a-z])/g, '$1$2').replace(/\s+/g, ' ').trim();
    const body = normalize(full);
    const selected = normalize(stripPageLabels(text));
    // 没有指定选区时给当前页；选区定位失败时留空，不能拿页首冒充选区附近。
    if (!selected) return body.slice(0, 8000);
    const key = selected.slice(0, 120);
    let idx = body.toLowerCase().indexOf(key.toLowerCase());
    if (idx < 0) {
      const probe = key.split(' ').slice(0, 4).join(' ');
      if (probe.length >= 8) idx = body.toLowerCase().indexOf(probe.toLowerCase());
    }
    if (idx < 0) return '';
    return body.slice(Math.max(0, idx - span), Math.min(body.length, idx + selected.length + span));
  }

  /* ------------------------------------------------------------ 框选截取 */

  /**
   * 把某一页上的矩形区域渲染成图片（用于图/表/公式识别）。
   * @param {number} pageNum
   * @param {{x:number,y:number,w:number,h:number}} rectCss 相对页面元素左上角的 CSS 像素
   */
  async captureRegion(pageNum, rectCss, { maxDim = 1600 } = {}) {
    if (!this.pdf) throw new Error('没有打开的文档');
    const page = await this.pdf.getPage(pageNum);
    const baseScale = this.scale || 1;
    // 以放大约 3 倍 PDF 单位的清晰度重新渲染这一页，再裁剪
    const renderScale = clamp(Math.max(3, baseScale * 2.5), 1.5, 8);
    const viewport = page.getViewport({ scale: renderScale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext('2d', { alpha: false });
    const paper = paperColor();
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, background: paper }).promise;

    const k = renderScale / baseScale; // CSS 像素 -> 渲染像素
    const sx = clamp(Math.floor(rectCss.x * k), 0, canvas.width - 1);
    const sy = clamp(Math.floor(rectCss.y * k), 0, canvas.height - 1);
    const sw = clamp(Math.ceil(rectCss.w * k), 1, canvas.width - sx);
    const sh = clamp(Math.ceil(rectCss.h * k), 1, canvas.height - sy);
    const pad = Math.round(6 * k);
    const px = clamp(sx - pad, 0, canvas.width - 1);
    const py = clamp(sy - pad, 0, canvas.height - 1);
    const pw = clamp(sw + pad * 2, 1, canvas.width - px);
    const ph = clamp(sh + pad * 2, 1, canvas.height - py);

    const out = document.createElement('canvas');
    let ow = pw;
    let oh = ph;
    const shrink = Math.min(1, maxDim / Math.max(ow, oh));
    ow = Math.max(1, Math.round(ow * shrink));
    oh = Math.max(1, Math.round(oh * shrink));
    out.width = ow;
    out.height = oh;
    const octx = out.getContext('2d');
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(canvas, px, py, pw, ph, 0, 0, ow, oh);
    canvas.width = 0;
    canvas.height = 0;

    let dataUrl = out.toDataURL('image/png');
    if (dataUrl.length > 1_600_000) {
      const jpg = document.createElement('canvas');
      jpg.width = ow;
      jpg.height = oh;
      const jctx = jpg.getContext('2d');
      jctx.fillStyle = paperColor();
      jctx.fillRect(0, 0, ow, oh);
      jctx.drawImage(out, 0, 0);
      dataUrl = jpg.toDataURL('image/jpeg', 0.9);
    }
    return { dataUrl, width: ow, height: oh };
  }

  /* ------------------------------------------------------------ 文本层校正 */

  async _bindRealFonts(container, page, textContent = null) {
    try {
      /* textContent 由 `_renderPage` 传进来（那一页的文本流已经取过一次了，见那里的说明）；
         没有传就自己取 —— 保持这个函数可以单独调用。 */
      const tc = textContent || await page.getTextContent();
      const spans = [...container.querySelectorAll('span:not(.markedContent)')];
      const items = (tc.items || []).filter((it) => it && typeof it.str === 'string' && it.str.trim() !== '');
      /* 按文本层实际顺序配对。旧实现从 item 反向找 span，遇到一个换行/空 item
         就可能把后续 span 配到前一个字体；这里宁可跳过不匹配的 item，也不写错字体。 */
      const norm = (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      let ii = 0;
      const pairs = [];
      for (const span of spans) {
        const text = norm(span.textContent);
        if (!text) continue;
        while (ii < items.length && norm(items[ii].str) !== text) ii++;
        if (ii >= items.length) break;
        pairs.push([span, items[ii++]]);
      }
      /* 覆盖率太低说明流式文本和页面文本不是同一份，宁可整页保持 pdf.js 原样。 */
      if (!pairs.length || pairs.length < Math.max(1, spans.length * 0.6)) return;
      const rows = [];
      for (const [span, item] of pairs) {
        const fam = String(item.fontName || '').trim();
        if (!fam) continue;
        const px = parseFloat(getComputedStyle(span).fontSize) || 0;
        if (document.fonts?.check && px > 0 && !document.fonts.check(`${px}px "${fam}"`)) continue;
        /* item.width 是 scale=1 的 PDF/CSS 宽度；不要误用 transform[0]（那是字号/基线变换）。 */
        const want = Number(item.width) * this.scale;
        rows.push({ span, fam, want });
      }
      if (!rows.length) return;
      for (const r of rows) {
        r.span.style.fontFamily = `"${r.fam}"`;
        r.span.style.letterSpacing = 'normal';
        r.span.dataset.pdfFontName = r.fam;
        if (r.want > 0) r.span.style.setProperty('--scale-x', '1');
      }
      const widths = rows.map((r) => r.span.getBoundingClientRect().width);
      for (let k = 0; k < rows.length; k++) {
        const r = rows[k];
        if (!(r.want > 0)) continue;
        const nat = widths[k];
        if (!(nat > 1)) continue;
        const sx = r.want / nat;
        if (Number.isFinite(sx) && sx > 0.2 && sx < 5) r.span.style.setProperty('--scale-x', String(sx));
      }
    } catch { /* 拿不到文本内容就不动 —— 保持 pdf.js 原样，至少不是更坏 */ }
  }

  _nudgeTextLayer(container, page) {
    try {
      const pageEl = container.closest('.page') || container.parentElement;
      const pageH = pageEl?.clientHeight || 0;
      const spans = container.querySelectorAll('span:not(.markedContent)');
      const ctx = this._measureCtx || (this._measureCtx = document.createElement('canvas').getContext('2d'));
      const pr = pageEl.getBoundingClientRect();
      const rows = [];
      for (const span of spans) {
        const text = span.textContent || '';
        if (!text.trim()) continue;
        const abs = span.style.top;
        if (!abs) continue;
        /* span.style.top 是百分比字符串（pdf.js 的约定），换算成 px */
        let topPx = null;
        if (abs.endsWith('%')) topPx = (parseFloat(abs) / 100) * pageH;
        else if (abs.endsWith('px')) topPx = parseFloat(abs);
        if (!Number.isFinite(topPx)) continue;
        const cs = getComputedStyle(span);
        const fs = parseFloat(cs.fontSize) || 0;
        if (!(fs > 0)) continue;
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${fs}px ${cs.fontFamily}`;
        let inkTop = 0, inkBottom = 0;
        try {
          const m = ctx.measureText(text);
          inkTop = m.actualBoundingBoxAscent || 0;
          inkBottom = m.actualBoundingBoxDescent || 0;
        } catch { continue; }
        if (!(inkTop > 0)) continue;
        /* PDF.js 的 top 是 baseline - fontBoundingBoxAscent；浏览器的 Range 命中框
           往往还会向上伸出一小段。用同一字体的实际墨迹上缘和 Range 上缘做差，
           把命中带移到可见字形上，而不是用一个会代数抵消成 0 的中心公式。 */
        const fm = ctx.measureText('');
        const fba = fm.fontBoundingBoxAscent || fs * 0.75;
        const fbd = Math.abs(fm.fontBoundingBoxDescent || fs * 0.25);
        const ratio = fba / Math.max(0.01, fba + fbd);
        const baseline = topPx + fs * ratio;
        const inkTopPx = baseline - inkTop;
        const range = document.createRange();
        try { range.selectNodeContents(span.firstChild || span); } catch { continue; }
        const rr = range.getClientRects()[0];
        if (!rr || !pr || !(pr.height > 0)) continue;
        const hitTopPx = rr.top - pr.top;
        const nudge = inkTopPx - hitTopPx;
        // 正文的小字号行距很紧：+2px 已足够把 10–12pt 的命中分界线压到字形下缘，
        // 再往下会让双击/拖选少吃一个字。标题和大字号保留更宽的上限。
        const downLimit = fs <= 14 ? Math.min(fs * 0.25, 2) : Math.min(fs * 0.35, 4);
        const limited = clamp(nudge, -fs * 0.35, downLimit);
        if (Math.abs(limited) < 0.25) continue;
        rows.push([span, topPx, limited]);
      }
      for (const [span, topPx, limited] of rows) {
        span.style.top = `${(topPx + limited).toFixed(2)}px`;
      }
    } catch { /* 补偿失败就保持原样 */ }
  }

  _tileTextHitBoxes(container) {
    try {
      const layerRect = container.getBoundingClientRect();
      const W = layerRect.width;
      const H = layerRect.height;
      if (!(W > 4 && H > 4)) return null;

      /* ① 只读一遍几何（先读后写，避免每个 span 都触发一次重排）。
         注意：这一份 `read` 会原样返回给 `charPosAt()` 当命中表用 ——
         它必须包含所有有文字子节点的 span（含只有空格的），
         否则「鼠标点在两个 run 之间的空格上」会找不到字符位置。 */
      const read = [];
      for (const span of container.querySelectorAll('span:not(.markedContent)')) {
        // pdf.js 把图片也放成 span；它 user-select:none，不参与文字选择
        if (span.getAttribute('role') === 'img') continue;
        const node = span.firstChild;
        if (!node || node.nodeType !== 3) continue;
        /* 旋转 / 被缩放的 span 不参与铺满：padding 会跟着 transform 一起缩放，
           按「盒子边界等分」算出来的扩张量对不上。（每页只有零星几个：页边竖排文字）
           但它们仍然进命中表 —— `charPosAt()` 需要一个「最近的字」兜底。 */
        const rot = Math.abs(parseFloat(span.style.getPropertyValue('--rotate') || '0') || 0);
        const tm = getComputedStyle(span).transform;
        const tilted = rot > 0.01 || (tm && tm !== 'none' && !/^matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*0\)$/.test(tm));
        const r = span.getBoundingClientRect();
        if (!(r.width > 0.5 && r.height > 0.5)) continue;
        read.push({
          span,
          node,
          tilted,
          blank: !(node.textContent || '').trim(),
          l: r.left - layerRect.left,
          t: r.top - layerRect.top,
          w: r.width,
          h: r.height,
        });
      }
      if (read.length < 2) return read.length ? read : null;

      /* 比正文高一截的盒子（页边竖排文字实测能到页高的 45%）会把整页的行结构拽歪：
         它自己一条「行」，还会把相邻两行的边界一起拉过去。剔除它，保持 pdf.js 原样。
         阈值和 `mergeRectsByLine()` 里砍怪矩形的口径一致。 */
      const hs = read.map((x) => x.h).sort((a, b) => a - b);
      const medH = hs[hs.length >> 1] || 0;
      const maxH = Math.max(H * 0.08, medH * 4);
      const items = read.filter((x) => !x.tilted && !x.blank && x.h <= maxH);
      if (items.length < 2) return read;

      /* ② 分行：按**垂直重叠**聚类。
         不能按中心线距离：上下标、小字号引文与正文中心线差得远，会被拆成两行。 */
      items.sort((a, b) => a.t - b.t);
      const rows = [];
      for (const it of items) {
        const row = rows[rows.length - 1];
        const overlap = row ? Math.min(row.bottom, it.t + it.h) - Math.max(row.top, it.t) : 0;
        if (row && overlap > Math.min(row.h, it.h) * 0.5) {
          row.items.push(it);
          row.top = Math.min(row.top, it.t);
          row.bottom = Math.max(row.bottom, it.t + it.h);
          row.h = Math.min(row.h, it.h);
        } else {
          rows.push({ top: it.t, bottom: it.t + it.h, h: it.h, items: [it] });
        }
      }
      for (const row of rows) row.cy = (row.top + row.bottom) / 2;

      /* ③ 纵向边界：相邻行中心线的中点；首/末行顶到层边，层内不留「无主之地」 */
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const prev = rows[i - 1];
        const next = rows[i + 1];
        const midPrev = prev ? (prev.cy + row.cy) / 2 : 0;
        const midNext = next ? (row.cy + next.cy) / 2 : H;
        row.bandTop = Math.max(0, Math.min(midPrev, row.top));
        row.bandBottom = Math.min(H, Math.max(midNext, row.bottom));
      }

      for (const row of rows) {
        for (const it of row.items) {
          const pt = Math.min(HIT_PAD_MAX, Math.max(0, it.t - row.bandTop));
          const pb = Math.min(HIT_PAD_MAX, Math.max(0, row.bandBottom - (it.t + it.h)));
          if (pt + pb < 0.5) continue;
          it.span.style.paddingTop = `${pt.toFixed(2)}px`;
          it.span.style.paddingBottom = `${pb.toFixed(2)}px`;
          it.span.style.top = `${(it.t - pt).toFixed(2)}px`;
          it.span.dataset.hitBox = 'tiled';
        }
      }
      return read;
    } catch { /* 铺不满就保持 pdf.js 原样：宁可有缝，也不能把文本层弄坏 */ }
    return null;
  }

  charPosAt(clientX, clientY) {
    /* 先找最近的一页：拖到阅读区**外面**松手（右侧面板上）时，坐标要夹回页面边缘，
       否则「拖出去松手」就没有字符位置可用，跑偏的选区没法纠正。 */
    let pick = null;
    for (const [i, entry] of this.rendered) {
      const pageEl = this.pageEls[i];
      if (!pageEl) continue;
      const boxes = entry.hitBoxes;
      if (!boxes || !boxes.length) continue;   // 文本层还没建好（或整页没有文字）
      const pr = pageEl.getBoundingClientRect();
      const dx = clientX < pr.left ? pr.left - clientX : (clientX > pr.right ? clientX - pr.right : 0);
      const dy = clientY < pr.top ? pr.top - clientY : (clientY > pr.bottom ? clientY - pr.bottom : 0);
      const d = dx * dx + dy * dy;
      if (!pick || d < pick.d) pick = { d, i, entry, pr };
    }
    if (!pick) return null;
    const { entry, pr, i } = pick;
    const k = layerScale(entry.textDiv);
    const x = (clamp(clientX, pr.left, pr.right) - pr.left) / k;
    const y = (clamp(clientY, pr.top, pr.bottom) - pr.top) / k;
    let best = null;
    for (const b of entry.hitBoxes) {
      // 先看纵向归属哪一行，再看横向差多少（缝隙被补上之后，正确的那一个两项都是 0）
      const bdy = y < b.t ? b.t - y : (y > b.t + b.h ? y - (b.t + b.h) : 0);
      const bdx = x < b.l ? b.l - x : (x > b.l + b.w ? x - (b.l + b.w) : 0);
      const d = bdy * CHAR_HIT_ROW_WEIGHT + bdx;
      if (!best || d < best.d) best = { d, b };
    }
    if (!best) return null;
    // `_offsetInSpan` 里的字符区间是视口坐标（getBoundingClientRect 已含缩放），所以这里传原始 x
    return { ...this._offsetInSpan(best.b.span, best.b.node, clamp(clientX, pr.left, pr.right)), page: Number(this.pageEls[i].dataset.page) };
  }

  _offsetInSpan(span, node, clientX) {
    if (!this._charX) this._charX = new WeakMap();
    const spanRect = span.getBoundingClientRect();
    const rel = clientX - spanRect.left;
    let map = this._charX.get(span);
    if (!map) {
      map = [];
      const text = node.textContent || '';
      const r = document.createRange();
      for (let k = 0; k < text.length; k++) {
        try { r.setStart(node, k); r.setEnd(node, k + 1); } catch { map.push(null); continue; }
        const cr = r.getBoundingClientRect();
        map.push(cr.width > 0 || cr.height > 0 ? { l: cr.left - spanRect.left, r: cr.right - spanRect.left } : null);
      }
      this._charX.set(span, map);
    }
    let bi = 0;
    let bd = Infinity;
    for (let k = 0; k < map.length; k++) {
      const m = map[k];
      if (!m) continue;
      const d = rel < m.l ? m.l - rel : (rel > m.r ? rel - m.r : 0);
      if (d < bd) { bd = d; bi = k; }
    }
    // 落在字符右半边就取它后面那个边界 —— 和浏览器 caret 的手感一致
    const m = map[bi];
    const offset = m && rel > (m.l + m.r) / 2 ? bi + 1 : bi;
    return { node, offset: Math.min(offset, (node.textContent || '').length) };
  }

  repairSelectionEnds({ anchor = null, focus = null, allowCollapsed = false } = {}) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    const common = range.commonAncestorContainer;
    const commonEl = common.nodeType === 1 ? common : common.parentElement;
    // 只修 PDF 阅读区里的选区：笔记/问答里的输入框不走这条
    if (!commonEl || !this.pagesEl?.contains(commonEl)) return false;
    if (sel.isCollapsed) {
      if (!allowCollapsed || !anchor || !focus) return false;
      // 只处理「真的拖过」的那种：原地单击不该凭空造出选区
      if (Math.hypot(focus.x - anchor.x, focus.y - anchor.y) < 4) return false;
      const a0 = this.charPosAt(anchor.x, anchor.y);
      const f0 = this.charPosAt(focus.x, focus.y);
      if (!a0 || !f0) return false;
      try { sel.setBaseAndExtent(a0.node, a0.offset, f0.node, f0.offset); } catch { return false; }
      return true;
    }
    const isText = (n) => !!(n && n.nodeType === 3 && n.parentElement?.closest?.('.textLayer'));
    const okA = isText(range.startContainer);
    const okF = isText(range.endContainer);
    if (okA && okF) return false;
    const a = okA ? { node: range.startContainer, offset: range.startOffset } : (anchor ? this.charPosAt(anchor.x, anchor.y) : null);
    const f = okF ? { node: range.endContainer, offset: range.endOffset } : (focus ? this.charPosAt(focus.x, focus.y) : null);
    if (!a || !f) return false;
    try { sel.setBaseAndExtent(a.node, a.offset, f.node, f.offset); } catch { return false; }
    return true;
  }

  _freezeTextLayerMetrics(container, entry) {
    const W = entry.cssW || container.clientWidth || 0;
    const H = entry.cssH || container.clientHeight || 0;
    if (!(W > 0 && H > 0)) return;
    for (const span of container.querySelectorAll('span:not(.markedContent)')) {
      const left = span.style.left;
      if (left && left.endsWith('%')) span.style.left = `${((parseFloat(left) / 100) * W).toFixed(2)}px`;
      const top = span.style.top;
      if (top && top.endsWith('%')) span.style.top = `${((parseFloat(top) / 100) * H).toFixed(2)}px`;
      // 字号：把 CSS 里的 calc(var(--text-scale-factor) * var(--font-height)) 固定成 px
      const fs = parseFloat(getComputedStyle(span).fontSize);
      if (fs > 0) span.style.fontSize = `${fs.toFixed(3)}px`;
    }
  }

  _normalizeTextScale(container) {
    const spans = container.querySelectorAll('span:not(.markedContent)');
    /**
     * 同样要读写分离：`rect.width` 是写完上一个 span 的 letter-spacing 之后再读的，
     * 所以旧写法每行都强制一次布局。这里先一次读完所有宽度，再统一写。
     */
    const rows = [];
    for (const span of spans) {
      const raw = span.style.getPropertyValue('--scale-x');
      if (!raw) continue;
      const sx = parseFloat(raw);
      if (!Number.isFinite(sx) || Math.abs(sx - 1) < 0.004) continue;
      const rot = parseFloat(span.style.getPropertyValue('--rotate') || '0');
      if (Number.isFinite(rot) && Math.abs(rot) > 0.01) continue;   // 旋转 span：跳过
      const text = span.textContent || '';
      if (text.length < 2) continue;
      rows.push({ span, sx, len: text.length });
    }
    if (!rows.length) return;
    const widths = rows.map((r) => r.span.getBoundingClientRect().width);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const width = widths[i];
      if (!width) continue;
      const natural = width / r.sx;
      const extra = width - natural;
      r.span.style.setProperty('--scale-x', '1');
      const ls = extra / r.len;                                     // 见上面 ①
      if (Number.isFinite(ls) && Math.abs(ls) > 0.01) {
        r.span.style.letterSpacing = `${ls.toFixed(3)}px`;
      }
    }
  }

  /* ------------------------------------------------------------ 正文引用 [n] */

  /**
   * 把正文里的 [12] / [3,4] / [5-7] 标成可点的小块。
   * 点一下跳到文末对应的参考文献条目，并可以顺手去查这篇的开放 PDF。
   */
  _paintCites(i) {
    const entry = this.rendered.get(i);
    if (!entry || !entry.pinLayer) return;
    // 复用热点层时只清引用节点，保留同层的笔记书签。
    entry.pinLayer.querySelectorAll('.cite-link').forEach((node) => node.remove());
    entry.citeHits = [];

    const refNumsOnPage = this.referenceEntries?.get(i) || null;
    const pageEl = this.pageEls[i];
    const pr = pageEl.getBoundingClientRect();
    const spans = entry.textDiv.querySelectorAll('span:not(.markedContent)');
    const RE = /\[\s*\d+(?:\s*[-,–]\s*\d+)*\s*\]/g;

    for (const span of spans) {
      const node = span.firstChild;
      if (!node || node.nodeType !== 3) continue;
      const text = node.textContent || '';
      if (text.indexOf('[') < 0) continue;
      RE.lastIndex = 0;
      let m;
      while ((m = RE.exec(text))) {
        // 条目行：匹配出现在这个 span 的最前面，且编号就是本页文献表里的条目号 → 跳过
        if (refNumsOnPage && m.index === 0) {
          const first = Number((m[0].match(/\d+/) || [])[0]);
          if (first && refNumsOnPage.has(first)) continue;
        }
        // 必须在这里把值取出来固化：m 是循环变量，等用户点击时它已经是 null 了
        const raw = m[0];
        const start = m.index;
        const nums = (raw.match(/\d+/g) || []).map(Number).filter((n) => n > 0 && n < 999);
        if (!nums.length) continue;
        const range = document.createRange();
        try {
          range.setStart(node, start);
          range.setEnd(node, start + raw.length);
        } catch { continue; }
        for (const r of range.getClientRects()) {
          if (r.width < 3 || r.height < 3) continue;
          const d = document.createElement('div');
          d.className = 'cite-link';
          const pageW = pageEl.clientWidth || pr.width;
          const pageH = pageEl.clientHeight || pr.height;
          const k = layerScale(entry.pinLayer);
          // 页面内局部坐标（热点就是挂在这一页上的，所以不需要屏幕坐标这一步）
          const localLeft = (r.left - pr.left) / k;
          const localTop = (r.top - pr.top) / k;
          const citeW = Math.min(Math.max(r.width / k, 1), pageW);
          const citeH = Math.min(Math.max(r.height / k, 1), pageH);
          const citeLeft = clamp(localLeft, 0, Math.max(0, pageW - citeW));
          const citeTop = clamp(localTop, 0, Math.max(0, pageH - citeH));
          d.style.left = `${citeLeft}px`;
          d.style.top = `${citeTop}px`;
          d.style.width = `${citeW}px`;
          d.style.height = `${citeH}px`;
          d.title = `引用 [${nums.join(', ')}] —— 点击跳到参考文献`;
          entry.pinLayer.append(d);
          entry.citeHits.push({ el: d, nums, raw, page: i, x: citeLeft, y: citeTop, w: citeW, h: citeH });
        }
      }
    }
  }

  citeAt(clientX, clientY) {
    for (const [i, entry] of this.rendered) {
      const hits = entry.citeHits;
      if (!hits || !hits.length) continue;
      const pageEl = this.pageEls[i];
      const pr = pageEl?.getBoundingClientRect();
      if (!pr) continue;
      const k = layerScale(entry.pinLayer);
      const lx = (clientX - pr.left) / k;
      const ly = (clientY - pr.top) / k;
      if (lx < -4 || ly < -4 || lx > pr.width / k + 4 || ly > pr.height / k + 4) continue;
      for (const h of hits) {
        if (lx >= h.x - 1 && lx <= h.x + h.w + 1 && ly >= h.y - 1 && ly <= h.y + h.h + 1) {
          // 只有真的命中才去读一次矩形（卡片锚点必须现取，滚动后绘制时的坐标就过期了）
          const r = h.el.getBoundingClientRect();
          return {
            nums: h.nums,
            raw: h.raw,
            page: i,
            el: h.el,
            anchor: { left: r.left, top: r.top, bottom: r.bottom, width: r.width, height: r.height },
          };
        }
      }
    }
    return null;
  }

  _updateCiteHover(clientX, clientY) {
    const hot = this.citeAt(clientX, clientY);
    const el = hot?.el || null;
    if (el === this._hotCite) return;
    this._hotCite?.classList.remove('hot');
    this._hotCite = el;
    if (el) el.classList.add('hot');
    const pageEl = el ? el.closest('.page') : null;
    if (this._hotCitePage && this._hotCitePage !== pageEl) this._hotCitePage.classList.remove('cite-hot');
    if (pageEl) pageEl.classList.add('cite-hot');
    this._hotCitePage = pageEl;
  }

  async findAllReferences(onProgress) {
    const gen = this._gen;
    const found = new Map();
    let misses = 0;
    for (let p = this.numPages; p >= 1 && misses < 4; p--) {
      const text = await this.getPageText(p);
      if (gen !== this._gen) return [];
      if (!text) { misses++; continue; }
      let hit = 0;
      for (const r of parseReferencesFromText(text)) {
        if (found.has(r.num)) continue;
        found.set(r.num, { num: r.num, page: p, text: r.text });
        hit++;
      }
      if (hit) misses = 0; else misses++;
      onProgress?.(p, this.numPages, found.size);
    }
    return [...found.values()].sort((a, b) => a.num - b.num);
  }

  /** 标记参考文献表里的条目（页 + 编号），避免把条目前的 [n] 画成正文引用热点。
   *  注意是**条目粒度**而不是整页粒度，理由见构造函数里 referenceEntries 的注释。 */
  setReferencePages(refs = []) {
    this.referencePages = new Set(
      (refs || []).map((r) => Number(r?.page)).filter((p) => p > 0)
    );
    const byPage = new Map();
    for (const r of refs || []) {
      const page = Number(r?.page);
      const num = Number(r?.num);
      if (!(page > 0) || !(num > 0)) continue;
      if (!byPage.has(page)) byPage.set(page, new Set());
      byPage.get(page).add(num);
    }
    this.referenceEntries = byPage;
    this.referenceByNum = new Map();
    for (const r of refs || []) {
      const num = Number(r?.num);
      if (num > 0 && !this.referenceByNum.has(num)) this.referenceByNum.set(num, r);
    }
    /* 页面可能在解析参考文献前就已渲染：按新的条目表**重画**这些页的热点。
       原来这里是「把整页热点删掉」，那会把同页的正文引用一起误删 —— 现在改成重画。 */
    for (const page of this.referencePages) {
      if (!this.rendered.has(page)) continue;
      this.rendered.get(page)?.pinLayer?.querySelectorAll('.cite-link').forEach((node) => node.remove());
      this._paintCites(page);
    }
  }

  /** 在正文里找 [n] 对应的参考文献条目（通常在最后几页） */
  async findReference(n) {
    const gen = this._gen;
    const cached = this.referenceByNum?.get(Number(n));
    if (cached) return { page: cached.page, num: Number(n), text: cached.text };
    // 注意不能加 m 标志：那样 $ 会在每个换行处成立，惰性匹配只吃到第一行，
    // 文献条目就会被截成半句
    const re = new RegExp(`(?:^|\\n)[ \\t]*\\[${n}\\][ \\t]*([\\s\\S]{0,700}?)(?=\\n[ \\t]*\\[\\d+\\]|$)`);
    for (let p = this.numPages; p >= 1; p--) {
      const text = await this.getPageText(p);
      if (gen !== this._gen) return null;
      if (!text) continue;
      const m = re.exec(text);
      if (m && m[1].trim().length > 8) {
        return { page: p, num: n, text: m[1].replace(/([A-Za-z])-\s+([a-z])/g, '$1$2').replace(/\s+/g, ' ').trim().slice(0, 600) };
      }
    }
    return null;
  }

  /* ------------------------------------------------------------ 长截图 */

  /**
   * 把一块可能跨页、超出视口的区域渲染成一张竖图。
   * 因为我是从 PDF 重新渲染而不是截屏，所以不受视口大小限制。
   * range: { pageStart, pageEnd, x, w, yStart, yEnd } —— 单位都是 CSS px（相对各自页面）
   */
  async captureRange({ pageStart, pageEnd, x, w, yStart, yEnd }, { ratio = 2.5, maxDim = 3000 } = {}) {
    if (!this.pdf) throw new Error('没有打开的文档');
    const slices = [];
    for (let p = pageStart; p <= pageEnd; p++) {
      const el = this.pageEls[p];
      if (!el) continue;
      const pageH = this.heights[p] || el.offsetHeight;
      const top = p === pageStart ? Math.max(0, yStart) : 0;
      const bottom = p === pageEnd ? Math.min(pageH, yEnd) : pageH;
      if (bottom - top < 2) continue;
      slices.push({ page: p, top, height: bottom - top });
    }
    if (!slices.length) throw new Error('选区太小');

    const totalH = slices.reduce((s, x2) => s + x2.height, 0);
    const outW = Math.max(1, Math.round(w * ratio));
    const outH = Math.max(1, Math.round(totalH * ratio));
    const shrink = Math.min(1, maxDim / Math.max(outW, outH));
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(outW * shrink));
    out.height = Math.max(1, Math.round(outH * shrink));
    const octx = out.getContext('2d');
    const paper = paperColor();
    octx.fillStyle = paper;
    octx.fillRect(0, 0, out.width, out.height);

    let dy = 0;
    for (const s of slices) {
      const page = await this.pdf.getPage(s.page);
      const viewport = page.getViewport({ scale: 1 });
      const r = ratio * shrink;
      const cw = Math.max(1, Math.round(w * r));
      const ch = Math.max(1, Math.round(s.height * r));
      const c = document.createElement('canvas');
      c.width = cw;
      c.height = ch;
      const ctx = c.getContext('2d', { alpha: false });
      ctx.fillStyle = paper;
      ctx.fillRect(0, 0, cw, ch);
      await page.render({
        canvasContext: ctx,
        viewport,
        transform: [r, 0, 0, r, -x * r, -s.top * r],
        background: paper,
      }).promise;
      octx.drawImage(c, 0, Math.round(dy * r));
      dy += s.height;
      c.width = 0;
      c.height = 0;
    }

    let dataUrl = out.toDataURL('image/png');
    if (dataUrl.length > 1_600_000) dataUrl = out.toDataURL('image/jpeg', 0.9);
    return { dataUrl, width: out.width, height: out.height, pages: slices.length };
  }

  /* ------------------------------------------------------------ 高亮 */

  setHighlights(items) {
    this._highlights = items || [];
    for (const [i] of this.rendered) this._paintHighlights(i);
  }

  _paintHighlights(i) {
    const entry = this.rendered.get(i);
    if (!entry) return;
    // 不再画黄色高亮块 —— 笔记只在页面右边缘留一个小书签
    if (entry.pinLayer) entry.pinLayer.querySelectorAll('.hl-pin').forEach((n) => n.remove());
    const list = (this._highlights || []).filter((h) => h.page === i);
    for (const h of list) {
      const rects = h.rects || [];
      let topY = null;
      for (const r of rects) if (topY === null || r.y < topY) topY = r.y;
      if (topY === null) continue;
      const pin = document.createElement('div');
      pin.className = `hl-pin${h.note ? ' has-note' : ''}`;
      /* 绝对 px（不是百分比）：pinLayer 在缩放提交时会被整层 scale(k)，
         百分比定位自己也会跟着页框缩放 → 叠加起来就是双倍。层里单位必须统一。 */
      const pinH = entry.cssH || entry.pageEl?.clientHeight || 0;
      pin.style.top = pinH > 0 ? `${(topY * pinH - 9).toFixed(2)}px` : '0px';
      pin.dataset.id = h.id;
      pin.title = h.note ? `笔记：${h.note.slice(0, 80)}` : `收藏：${(h.text || '').slice(0, 80)}`;
      pin.addEventListener('click', (e) => {
        e.stopPropagation();
        this.opts.onNoteClick?.(h.id);
      });
      (entry.pinLayer || entry.hlLayer).append(pin);
    }
  }

  paintSelection(rectsByPage) {
    this._selRects = rectsByPage || null;
    for (const [i] of this.rendered) this._paintSel(i);
  }

  /** 只画某一页的选中方块（不动别的层，免得把搜索命中/引用标记一起清掉） */
  _paintSel(i) {
    const entry = this.rendered.get(i);
    if (!entry) return;
    entry.hlLayer.querySelectorAll('.sel-mark').forEach((n) => n.remove());
    const rects = this._selRects?.[i];
    if (!rects) return;
    /* 用绝对 px 而不是百分比：这一层在缩放提交时会被整层 scale(k)，
       百分比定位自己也会跟着页框缩放 → 两者叠加就是双倍（实测选中方块会飘到 1.5 倍处）。
       层里统一用 px，整层缩放才成立。 */
    const W = entry.cssW || 0;
    const H = entry.cssH || 0;
    if (!(W > 0 && H > 0)) return;
    for (const r of rects) {
      const d = document.createElement('div');
      d.className = 'sel-mark';
      d.style.left = `${(r.x * W).toFixed(2)}px`;
      d.style.top = `${(r.y * H).toFixed(2)}px`;
      d.style.width = `${(r.w * W).toFixed(2)}px`;
      d.style.height = `${(r.h * H).toFixed(2)}px`;
      entry.hlLayer.append(d);
    }
  }
}

/* ------------------------------------------------------------------ 辅助 */

function destTop(dest) {
  if (!Array.isArray(dest)) return null;
  const kind = (dest[1] && typeof dest[1] === 'object' && dest[1].name)
    || (typeof dest[1] === 'string' ? dest[1] : '');
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (kind === 'XYZ') return num(dest[3]);
  if (kind === 'FitH' || kind === 'FitBH') return num(dest[2]);
  if (kind === 'FitR') return num(dest[5]);
  return null;
}

function mergeRectsByLine(list) {
  let rs = list.filter((r) => r.w > 0.0005 && r.h > 0.0005);
  if (!rs.length) return [];

  // 先按高度中位数砍掉「不可能是文字行」的怪矩形。
  // 实测第 1 页（arXiv 首页）上有一个旋转的页边文字，它的 client rect 高达页高的 45%，
  // 留着就会画出一条糊住半页的蓝块 —— 这就是用户说的「整页整块变蓝」。
  const allH = rs.map((r) => r.h).sort((a, b) => a - b);
  const medH = allH[Math.floor(allH.length / 2)];
  const maxH = Math.max(0.08, medH * 4);      // 大字标题也就 3% 左右，8% 已经很宽松
  rs = rs.filter((r) => r.h <= maxH);
  if (!rs.length) return [];

  // 行高容差取「高度中位数的一半」：同一个视觉行里的碎片中心线基本重合，
  // 相邻行则差着整整一个行距，用中心线聚类比「有重叠就并入」稳得多。
  const tol = Math.max(0.002, medH * 0.6);

  const rows = [];
  for (const r of [...rs].sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2))) {
    const cy = r.y + r.h / 2;
    const row = rows.find((R) => Math.abs(cy - R.cy) <= tol);
    if (!row) { rows.push({ cy, items: [r] }); continue; }
    row.items.push(r);
    // 中心取平均：个别碎片位置偏一点也不会把整行拽歪
    row.cy = row.items.reduce((s, x) => s + x.y + x.h / 2, 0) / row.items.length;
  }

  return rows.map((R) => {
    const x0 = Math.min(...R.items.map((r) => r.x));
    const x1 = Math.max(...R.items.map((r) => r.x + r.w));
    // 高度取中位数，不用 max-min：否则一个偏高的碎片会把整行撑成大方块
    const hs = R.items.map((r) => r.h).sort((a, b) => a - b);
    const h = hs[Math.floor(hs.length / 2)];
    return { x: x0, w: x1 - x0, y: R.cy - h / 2, h };
  }).sort((a, b) => a.y - b.y);
}

/**
 * 选区方块的最终形状：一行一个、互不重叠。
 * （同一行里的多列仍然各算各的：先按行合并，再对垂直方向的重叠对半分。）
 */
function normalizeRects(list) {
  const lines = mergeRectsByLine(list).sort((a, b) => (a.y - b.y) || (a.x - b.x));
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1];
    const b = lines[i];
    // 合并后两行可能贴到一起，接口处对半分，保证不再有叠加
    const overlap = (a.y + a.h) - b.y;
    if (overlap > 0.0005 && overlap < Math.min(a.h, b.h)) {
      const half = overlap / 2;
      a.h -= half;
      b.y += half;
      b.h -= half;
    }
  }
  return lines.filter((r) => r.w > 0.0005 && r.h > 0.0005);
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let count = 0;
  let idx = 0;
  while ((idx = h.indexOf(n, idx)) !== -1) { count++; idx += n.length; }
  return count;
}

function findInSpans(spans, query) {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const texts = spans.map((s) => s.textContent || '');
  const out = [];
  const starts = [];
  let combined = '';
  for (const text of texts) {
    starts.push(combined.length);
    combined += text;
  }
  const lower = combined.toLowerCase();
  let from = 0;
  let hitIndex = 0;
  let at;
  while ((at = lower.indexOf(q, from)) !== -1) {
    const end = at + q.length;
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] + texts[mid].length <= at) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < spans.length && starts[k] < end; k++) {
      const a = Math.max(at, starts[k]);
      const b = Math.min(end, starts[k] + texts[k].length);
      if (b > a) out.push({ hitIndex, spanIndex: k, start: a - starts[k], end: b - starts[k] });
    }
    hitIndex++;
    from = at + q.length;
  }
  return out;
}
