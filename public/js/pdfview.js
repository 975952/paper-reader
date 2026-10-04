/**
 * PDF 阅读核心：虚拟化连续滚动 + 文本层 + 缩放 + 目录 + 全文搜索 + 区域截取
 *
 * 依赖 pdf.js（public/vendor/pdf.min.mjs），用 pdf.js 官方的 TextLayer，
 * 保证选区的读取顺序和浏览器原生 selection 一致。
 */
import { clamp, throttle, sleep } from './util.js';

let pdfjsLib = null;

/**
 * pdf.js worker 的地址必须是**绝对可解析**的，否则 APK 里会静默退化成「主线程假 worker」。
 *
 * 两个真实场景：
 *   · 桌面 / Node 服务：页面在 `http://host/`，worker 就是 `/vendor/pdf.worker.min.mjs`；
 *   · 手机版 APK：页面是 `file:///android_asset/mobile/index.html`，根路径 `/` 指向**文件系统根**，
 *     写 `/vendor/...` 会 404。这时必须按模块自身位置算相对路径 → `file:///android_asset/js/vendor/...`。
 *
 * 所以用 import.meta.url 解析：无论页面挂在哪、是不是根路径，都能指到同一个文件。
 */
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

/**
 * 渲染倍率：至少 2 倍超采样，保证在任何屏幕上放大后都够密。
 * 这是「放大就糊」的直接对策——浏览器拿到比显示尺寸更密的位图再降采样，
 * 边缘才不会发虚。
 */
function renderRatio() {
  const d = window.devicePixelRatio || 1;
  return clamp(Math.max(d, 2), 1, 3);
}

/** 当前设置里的 PDF 纸张颜色。Canvas 不能直接读取 CSS 的 background，
 * 所以页面外壳和 pdf.js 的实际绘制都必须使用同一个颜色。 */
function paperColor() {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue('--paper').trim() || '#FFFFFF';
  } catch {
    return '#FFFFFF';
  }
}

/** 单页整幅渲染的像素上限（百万像素）。超过就只渲染可见切片 —— 否则放大后
 *  一张 canvas 能到几十 MB，多页叠加会爆显存，浏览器会静默降采样 = 糊。 */
const MAX_FULL_MP = 8;
/** 切片向外多渲染一点，减少滚动时的重绘次数（CSS px） */
const SLICE_MARGIN = 600;

/**
 * 从一段文本里解析出参考文献条目 `[n] ...`。
 *
 * 要求方括号出现在**行首**才算条目：正文里也有 `[12]` 这种行内引用，
 * 不这样限定的话整页正文都会被当成文献条目。
 */
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

/**
 * 单独抽一份 PDF 的全文，**不影响当前打开的那份**。
 * 「论文关系」要读库里其他论文的正文，判断谁引用了谁；
 * 用 viewer.load() 会把用户正在看的那篇顶掉，所以这里自己开一个文档实例。
 * 换行要保留：参考文献条目是按「行首 [n]」识别的。
 */
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
    this.baseSizes = [];      // [{width,height}] 按 scale=1 的尺寸，index 从 1 开始
    this.pageEls = [];        // .page 元素，index 从 1 开始
    this.rendered = new Map();  // pageNum -> {canvas, textDiv, task, hlLayer}
    this.renderTasks = new Map();
    this.textCache = new Map();  // pageNum -> string
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
    /**
     * 是否处于「自动适配」状态。打开文档时默认为 true（load() 里会按窗口宽度算一次），
     * 手动缩放（setScale）会把它关掉。
     * 之前这里没有初始化，于是 load() 虽然算出了适配比例，却没记成「适配模式」，
     * 结果窗口一变大变小页面就不再跟着变 —— 用户看到的就是「打开后大小不对」。
     */
    this._fitMode = true;

    this._onScroll = throttle(() => this._handleScroll(), 60);
    this.container.addEventListener('scroll', this._onScroll, { passive: true });
    this._onResize = throttle(() => {
      if (this._fitMode) this.fitWidth();
    }, 200);
    window.addEventListener('resize', this._onResize);

    // 窗口被拖到另一块不同 DPI 的显示器上时，已渲染的页要重画，否则会糊
    this._onDprChange = () => {
      if (!this.pdf) return;
      for (const i of Array.from(this.rendered.keys())) this._teardownPage(i);
      this._renderVisible(true);
    };
    this._watchDpr();
  }

  destroy() {
    this._destroyed = true;
    this.container.removeEventListener('scroll', this._onScroll);
    window.removeEventListener('resize', this._onResize);
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
    this._gen++;            // 作废上一份文档的所有在途任务
    for (const i of Array.from(this.rendered.keys())) this._teardownPage(i);
    this.rendered.clear();
    this.renderTasks.clear();
    this.textCache.clear();
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

  /**
   * 换缩放前：拆掉已渲染的页，并记下还在渲染中的页（它们被 cancel 后不会自愈）
   * 只在**非**手势缩放时用（换文档之类）；拖动缩放走 _softRescale。
   */
  _beginZoomChange() {
    const inflight = Array.from(this.renderTasks.keys());
    for (const i of Array.from(this.rendered.keys())) this._teardownPage(i);
    return inflight;
  }

  /**
   * 「软」缩放：不拆 DOM、不加 .placeholder，直接把已有位图按比例拉伸当预览。
   *
   * 为什么必须这样：`_teardownPage()` 会给页面加 `.placeholder`，
   * 而 `.page.placeholder::after` 是一条灰色斜条纹 —— 拖动缩放时每动一下就拆一次页面，
   * 用户看到的就是「灰条一直闪」（甚至整页变灰）。
   * 现在改成：位图先拉伸（糊一下但画面连续），等手势停下来再真正重画、换上清晰的。
   */
  _softRescale() {
    for (const entry of this.rendered.values()) {
      const base = entry.renderScale || this.scale;
      const k = this.scale / base;
      if (!(k > 0)) continue;
      entry.dirty = true;
      const c = entry.canvas;
      c.style.width = `${(entry.cssW * k).toFixed(2)}px`;
      c.style.height = `${(entry.cssH * k).toFixed(2)}px`;
      c.style.left = `${((entry.slice ? entry.slice.x : 0) * k).toFixed(2)}px`;
      c.style.top = `${((entry.slice ? entry.slice.y : 0) * k).toFixed(2)}px`;
      c.classList.add('soft-zoom');
      // 文本层 / 高亮层 / 命中层 / 书签层里都是按旧比例算好的绝对定位，整体 CSS 缩放
      for (const layer of [entry.textDiv, entry.hlLayer, entry.hitLayer, entry.pinLayer]) {
        if (!layer) continue;
        layer.style.transformOrigin = '0 0';
        layer.style.transform = `scale(${k})`;
      }
    }
  }

  /** 手势停下后再真正重画（防抖），避免拖动过程中反复解码同一页 */
  _scheduleRerender(delay = 160) {
    clearTimeout(this._rerenderTimer);
    this._rerenderTimer = setTimeout(() => {
      this._rerenderTimer = 0;
      if (this._destroyed) return;
      this._renderVisible(false);
    }, delay);
  }

  /**
   * 被 cancel 的在途渲染不会自己重来：任务从 renderTasks 里删掉后没人补渲染，
   * 而 _restoreAnchor 若算出同一个 scrollTop，浏览器不会派发 scroll 事件，
   * 于是页面就永久空白了。这里在任务落定后补一次渲染。
   * 只对本次换缩放时在途的那几页挂一次回调，不会造成失败重试死循环。
   */
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

  fitWidth() {
    if (!this.pdf || !this.baseSizes[1]) return;
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
      if (this.offsets[i] + this.heights[i] >= top) { first = i; break; }
    }
    for (let i = first; i <= this.numPages; i++) {
      if (this.offsets[i] > bottom) { last = Math.max(first, i - 1); break; }
      last = i;
    }
    return [first, last];
  }

  async _renderVisible(force = false, gen = this._gen) {
    if (!this.pdf || !this.offsets.length || gen !== this._gen) return;
    const [first, last] = this._visibleRange();
    const lo = Math.max(1, first - 1);
    const hi = Math.min(this.numPages, last + 1);
    for (let i = lo; i <= hi; i++) {
      const entry = this.rendered.get(i);
      // dirty = 软缩放留下的拉伸预览，需要重画成清晰版（但不走 placeholder 那条路）
      if (entry?.dirty) this._renderPage(i, { gen, soft: true });
      else if (!entry && !this.renderTasks.has(i)) this._renderPage(i, { gen });
    }
    // 回收远处页面，控制内存
    const keepLo = Math.max(1, first - 4);
    const keepHi = Math.min(this.numPages, last + 4);
    for (const i of Array.from(this.rendered.keys())) {
      if (i < keepLo || i > keepHi) this._teardownPage(i);
    }
  }

  /**
   * 算出这一页当前需要渲染的区域（CSS px，相对页面左上角）。
   * 放大到一定程度后整页渲染会撑爆显存，只渲染视口附近这一块。
   * 返回 null 表示按整页渲染。
   */
  _sliceFor(i, cssW, cssH, ratio) {
    const pageEl = this.pageEls[i];
    if (!pageEl) return null;
    const fullMP = (cssW * ratio * cssH * ratio) / 1e6;
    if (fullMP <= MAX_FULL_MP) return null;   // 整页还在安全范围内
    const pr = pageEl.getBoundingClientRect();
    const vr = this.container.getBoundingClientRect();
    const x0 = Math.max(0, Math.floor(vr.left - pr.left - SLICE_MARGIN));
    const y0 = Math.max(0, Math.floor(vr.top - pr.top - SLICE_MARGIN));
    const x1 = Math.min(cssW, Math.ceil(vr.right - pr.left + SLICE_MARGIN));
    const y1 = Math.min(cssH, Math.ceil(vr.bottom - pr.top + SLICE_MARGIN));
    if (x1 - x0 < 16 || y1 - y0 < 16) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
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
    for (const [i, entry] of Array.from(this.rendered.entries())) {
      if (!entry.slice || !entry.cssW) continue;
      const need = this._sliceFor(i, entry.cssW, entry.cssH, entry.ratio);
      if (need && this._sliceCovers(entry.slice, need)) continue;
      this._renderPage(i, { force: true });
    }
  }

  async _renderPage(i, { priority = false, gen = this._gen, force = false, soft = false } = {}) {
    if (!this.pdf || gen !== this._gen) return;
    if (!force && !soft && (this.renderTasks.has(i) || this.rendered.has(i))) return;
    if (!force && soft && this.renderTasks.has(i)) return;
    const pageEl = this.pageEls[i];
    if (!pageEl) return;
    /**
     * 双缓冲：上一张位图先留着当预览，新的画好了再换掉它。
     * 不管走哪条路径（软缩放 / 换切片 / 面板变宽）中间都不会露出
     * `.page.placeholder::after` 那条灰斜纹，也不会闪白 ——
     * 用户反馈的「拖动缩放时灰条一直闪」就是这么来的。
     * 新的画布是**另一个 canvas**，所以两边不会抢同一个上下文，
     * 也就不需要「等在途任务落定再重画」那套了。
     */
    const prevEntry = this.rendered.get(i);
    const prevCanvas = prevEntry?.canvas || null;
    if (prevEntry) {
      try { prevEntry.task?.cancel(); } catch { /* ignore */ }
      prevEntry.textDiv.remove();
      prevEntry.hlLayer.remove();
      prevEntry.hitLayer.remove();
      prevEntry.pinLayer?.remove();
      this.rendered.delete(i);
    }

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
      const ratio = renderRatio();
      const cssW = viewport.width;
      const cssH = viewport.height;
      const slice = this._sliceFor(i, cssW, cssH, ratio);
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
      // 注意**不能用 z-index** 压住旧画布：文本层没有 z-index（靠 DOM 顺序盖在画布上），
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
      // 笔记书签单独一层，z-index 必须高于文本层，否则点不到
      const pinLayer = document.createElement('div');
      pinLayer.className = 'hl-pin-layer';

      const entry = {
        canvas, textDiv, hlLayer, hitLayer, pinLayer, task: null, textLayer: null,
        slice, ratio, cssW, cssH,
        renderScale: this.scale,   // 这张位图是按哪个比例画的（软缩放拉伸时要用）
        dirty: false,
      };
      this.rendered.set(i, entry);

      // 先把 canvas 插进去，滚动时不会闪白。
      // 有旧画布时插在它后面（DOM 顺序即层级，见上面的说明），否则插到最前面。
      pageEl.classList.remove('placeholder');
      if (prevCanvas && prevCanvas.parentElement === pageEl) {
        prevCanvas.before(hlLayer, hitLayer);
        prevCanvas.after(canvas);
      } else {
        pageEl.prepend(hlLayer, hitLayer, canvas);
      }
      pageEl.append(textDiv, pinLayer);

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
        if (prevCanvas && this.rendered.get(i) !== prevEntry) {
          canvas.remove();
          pageEl.classList.remove('placeholder');
        }
        return;
      }
      if (stale() || this.rendered.get(i) !== entry) return;

      // 新版画好了：露出来，再把上一张预览扔掉（这一步才是「换帧」，中间没有空白）
      if (prevCanvas) {
        canvas.style.visibility = '';
        try { prevCanvas.width = 0; prevCanvas.height = 0; } catch { /* ignore */ }
        prevCanvas.remove();
      }
      entry.dirty = false;

      // 文本层
      try {
        const tl = new pdfjsLib.TextLayer({
          textContentSource: page.streamTextContent({ includeMarkedContent: true }),
          container: textDiv,
          viewport,
        });
        entry.textLayer = tl;
        await tl.render();
        // pdf.js 用 scaleX 把整段文字横向压/拉，浏览器在这种被 transform 的文本上
        // 做命中测试会差 1~2 个字符（选中的词和实际送出去的词对不上就是这个原因）。
        // 换成 letter-spacing 达到同样的宽度，字形不再被缩放，命中就准了。
        if (!stale()) {
          this._normalizeTextScale(textDiv);
          this._paintCites(i);
        }
      } catch (e) {
        if (!stale()) console.warn(`第 ${i} 页文本层构建失败`, e);
      }
      if (stale()) return;

      // 恢复高亮 & 搜索命中 & 当前选区
      this._paintHighlights(i);
      this._paintHits(i);
      // 选中方块也要重画：虚拟化会把页面整个卸掉，再滚回来时
      // 浏览器那边的选区已经没了，不重画的话「选中的文字」看起来就凭空消失了
      this._paintSel(i);
      document.dispatchEvent(new CustomEvent('pdfview:page-rendered', { detail: { page: i } }));
    };

    const p = run().finally(() => this.renderTasks.delete(i));
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
    const [first, last] = this._visibleRange();
    // 页码 = 视口上部 30% 处所在的页
    const probe = this.container.scrollTop + this.container.clientHeight * 0.3;
    let cur = first;
    for (let i = first; i <= last; i++) {
      if (probe >= (this.offsets[i] ?? 0)) cur = i;
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

  /** 全文搜索：每个命中一条，包含页码、页内序号和可读的上下文片段 */
  async search(query, { onProgress } = {}) {
    const q = String(query || '').trim();
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

  /**
   * 画搜索命中。
   * 关键：不能直接标整个 span —— pdf.js 的一个 span 常常是一整行，
   * 那样会「一整排都变黄」。这里按命中的字符区间建 Range，
   * 用 range.getClientRects() 拿到精确到词的小方块。
   */
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

  /**
   * 跳到目录项指的位置。
   *
   * 只用 goToPage() 的话只能滚到这一页的页顶 —— 标题如果在本页中间，
   * 点完它还在屏幕中间，看起来就是「没跳到位」。
   * PDF 的书签目标本来就带 Y 坐标（XYZ 的第 4 项 / FitH 的第 3 项 / FitR 的第 6 项），
   * 这里把它换算成视口偏移，让标题正好顶在最上面。
   */
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
    const key = String(text).slice(0, 60).replace(/\s+/g, ' ');
    let idx = full.indexOf(key);
    if (idx < 0) {
      const probe = key.split(' ').slice(0, 4).join(' ');
      idx = full.indexOf(probe);
    }
    if (idx < 0) return full.slice(0, span * 2);
    return full.slice(Math.max(0, idx - span), Math.min(full.length, idx + key.length + span));
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

  /**
   * pdf.js 的 TextLayer 对多字符 span 会加 transform: scaleX(...)，把整段文字
   * 横向压扁/拉长去贴合 PDF 里的字宽。被 transform 的文本在浏览器里做命中测试
   * 会有 1~2 个字符的误差 —— 表现为「选中的词」和「实际送去翻译的词」差几位。
   * 这里把 scaleX 换成等效的 letter-spacing：宽度一样，但字形不再被缩放，
   * 命中测试和视觉就一致了。
   */
  _normalizeTextScale(container) {
    const spans = container.querySelectorAll('span:not(.markedContent)');
    for (const span of spans) {
      const raw = span.style.getPropertyValue('--scale-x');
      if (!raw) continue;
      const sx = parseFloat(raw);
      if (!Number.isFinite(sx) || Math.abs(sx - 1) < 0.004) continue;
      const text = span.textContent || '';
      if (text.length < 2) continue;
      const rect = span.getBoundingClientRect();
      if (!rect.width || !sx) continue;
      const natural = rect.width / sx;
      const extra = rect.width - natural;
      span.style.setProperty('--scale-x', '1');
      const ls = extra / (text.length - 1);
      if (Number.isFinite(ls) && Math.abs(ls) > 0.01) {
        span.style.letterSpacing = `${ls.toFixed(3)}px`;
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
    // 参考文献条目本身通常以 [n] 开头；它不是正文引用，不能点击后
    // 再跳回同一页并伪造一条“返回原位置”记录。
    if (this.referencePages.has(i)) return;
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
          /**
           * ⚠️ 热点坐标必须钳进**这一页**，不能钳进阅读区视口（用户实测 2026-10-04：
           *   「文中的 [] 数字不能直接跳转了」）。
           *
           * 原来的写法把屏幕坐标钳到 `viewerRect`（阅读区可视矩形）里再换算回页面坐标。
           * 一页 PDF 往往比视口高得多（实测 1149px 页 vs 928px 视口），于是：
           *   · 落在视口**下方**的引用，`top` 全被钳到 `viewerRect.bottom` 同一条线上 ——
           *     几十个热点在页面底部叠成一排，谁也点不准；
           *   · 落在视口**上方**露出的部分，又正好压住那条线。
           * 结果就是「有的 [n] 能点、有的点了没反应」。
           *
           * 正确做法：只把**超出页面**的那一点点（pdf.js 文本度量会溢出几个像素）收回来，
           * 与视口无关 —— 页面滚动时热点跟着页面走，本来就不需要视口参与。
           */
          const pageW = pageEl.clientWidth || pr.width;
          const pageH = pageEl.clientHeight || pr.height;
          const tm = getComputedStyle(entry.pinLayer).transform;
          const layerScale = tm && tm !== 'none' ? (Number.parseFloat(tm.split(',')[0].replace('matrix(', '')) || 1) : 1;
          // 页面内局部坐标（热点就是挂在这一页上的，所以不需要屏幕坐标这一步）
          const localLeft = (r.left - pr.left) / layerScale;
          const localTop = (r.top - pr.top) / layerScale;
          const citeW = Math.min(Math.max(r.width / layerScale, 1), pageW);
          const citeH = Math.min(Math.max(r.height / layerScale, 1), pageH);
          const citeLeft = clamp(localLeft, 0, Math.max(0, pageW - citeW));
          const citeTop = clamp(localTop, 0, Math.max(0, pageH - citeH));
          d.style.left = `${citeLeft}px`;
          d.style.top = `${citeTop}px`;
          d.style.width = `${citeW}px`;
          d.style.height = `${citeH}px`;
          d.title = `引用 [${nums.join(', ')}] —— 点击跳到参考文献`;
          const anchor = { left: r.left, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
          d.addEventListener('click', (e) => {
            e.stopPropagation();
            this.opts.onCiteClick?.({ nums, page: i, raw, anchor });
          });
          entry.pinLayer.append(d);
        }
      }
    }
  }

  /**
   * 抽出全文里的**整个参考文献表**：[{num, page, text}]，按编号排序。
   *
   * 参考文献都在文末，所以从最后一页往前扫；连续几页都没条目就停 ——
   * 正文里也有 `[12]` 这种行内引用，但要求方括号出现在**行首**才能算条目，
   * 行内的引用就不会被误收进来。
   */
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

  /** 标记参考文献表所在页面，避免把条目前的 [n] 画成正文引用热点。 */
  setReferencePages(refs = []) {
    this.referencePages = new Set(
      (refs || []).map((r) => Number(r?.page)).filter((p) => p > 0)
    );
    // 页面可能在解析参考文献前就已渲染，立即移除已经画出的伪热点。
    for (const page of this.referencePages) {
      const entry = this.rendered.get(page);
      entry?.pinLayer?.querySelectorAll('.cite-link').forEach((node) => node.remove());
    }
  }

  /** 在正文里找 [n] 对应的参考文献条目（通常在最后几页） */
  async findReference(n) {
    const gen = this._gen;
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
      pin.style.top = `calc(${(topY * 100).toFixed(3)}% - 9px)`;
      pin.dataset.id = h.id;
      pin.title = h.note ? `笔记：${h.note.slice(0, 80)}` : `收藏：${(h.text || '').slice(0, 80)}`;
      pin.addEventListener('click', (e) => {
        e.stopPropagation();
        this.opts.onNoteClick?.(h.id);
      });
      (entry.pinLayer || entry.hlLayer).append(pin);
    }
  }

  /**
   * 把当前选区画成不重叠的方块（原生 ::selection 已经设成透明）。
   *
   * rectsByPage 会记在 this._selRects 里：页面被虚拟化卸掉再滚回来时，
   * 浏览器自己的选区已经随 DOM 一起消失了，只有靠这份记录才能把方块补回来，
   * 否则「翻页/滚动之后选区就没了」，而 state.selection 还在 —— 界面和数据对不上。
   */
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
    for (const r of rects) {
      const d = document.createElement('div');
      d.className = 'sel-mark';
      d.style.left = `${(r.x * 100).toFixed(3)}%`;
      d.style.top = `${(r.y * 100).toFixed(3)}%`;
      d.style.width = `${(r.w * 100).toFixed(3)}%`;
      d.style.height = `${(r.h * 100).toFixed(3)}%`;
      entry.hlLayer.append(d);
    }
  }
}

/* ------------------------------------------------------------------ 辅助 */

/**
 * 从 pdf.js 的显式目标数组里取「Y 坐标」（PDF 用户空间，原点在左下）。
 * 不同目标类型参数位置不一样：
 *   [ref, {name:'XYZ'}, left, top, zoom]
 *   [ref, {name:'FitH'|'FitBH'}, top]
 *   [ref, {name:'FitR'}, left, bottom, right, top]
 *   [ref, {name:'Fit'}] / [ref, {name:'FitV'}, left] → 没有 Y，返回 null
 * 取不到就返回 null，调用方会退回「滚到页顶」。
 */
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

/**
 * 把浏览器给的一堆碎片矩形合成「一行一个方块」。
 *
 * 为什么必须合并：`range.getClientRects()` 是**按 span 切**的碎片，同一行文字会得到
 * 好几个高度不一、位置轻微错开的矩形（实测选 5 个 span 出 10 块，整页出 136 块）。
 * 而 .sel-mark 是半透明的蓝（rgba(59,110,245,.28)），叠在一起就会一块深一块浅，
 * 密的地方直接糊成一大片蓝 —— 用户看到的「整页整块变蓝」和「有的浅蓝有的深蓝」就是这个。
 *
 * 按行合并之后每个方块互不重叠，颜色就均匀了，顺带 DOM 节点也少了一个数量级。
 */
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

/**
 * 在文本层 span 序列里找 query，返回**精确到字符区间**的命中片段：
 *   [{ spanIndex, start, end }, ...]
 * pdf.js 会把一句话切成很多 span、而且一个 span 常常就是一行，
 * 所以既要处理跨 span 匹配，又要记下命中在 span 内的起止偏移，
 * 否则只能整段标黄（看起来就是「一整排都变黄」）。
 */
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
