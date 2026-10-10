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
 * 屏幕**真正**需要多少倍率：设备像素比，夹到 [1, 2]。
 *
 * 为什么 ratio = dpr 就是「够」：canvas 的 CSS 尺寸等于页面尺寸，设备像素比是 1 时
 * 1 个 CSS 像素正好对应 1 个物理像素 —— 既不糊也不浪费。
 * 这个函数只回答「屏幕需要多少」，用来判「整页还是切片」「密度够不够」；
 * 实际画多大还要乘下面的超采样系数，再用像素预算收口（见 `_renderPlan`）。
 */
function deviceRatio() {
  const d = window.devicePixelRatio || 1;
  return clamp(d, 1, 2);
}

/**
 * 超采样系数：在实际需要的基础上**再多画一点**，让边缘不那么硬。
 *
 * 2026-10-10 用户口径：「界面的锐化太强了，就正常就行」。
 * 起因是第四轮为了治卡顿，把「无条件 2 倍超采样」改成了「按 dpr 严格 1:1」——
 * 1:1 时 PDF 的细笔画正好落在像素格上，看着发硬（1× / 1.25× / 1.5× 屏最明显；
 * 2× 屏本来就是设备分辨率，超采样到 2.5 一页要 16 MP，不划算，所以封顶在 2）。
 *
 * 25% 是有意的**轻微**：像素数 1.56 倍（2 倍超采样是 4 倍），
 * 实测 fitWidth 在 1× 屏上是 2.6 → 4.0 MP，滚动仍然 0 长任务；
 * 而**密度始终高于屏幕需求**，不会退回到「放大就糊」那一轮的问题。
 * 嫌硬/嫌糊只改这一个数（1 = 严格 1:1）。
 */
const SUPERSAMPLE = 1.25;

/** 实际画多大：屏幕需求 × 超采样，仍然封顶 2（再高就是白烧内存） */
function renderRatio() {
  return clamp(deviceRatio() * SUPERSAMPLE, 1, 2);
}

/**
 * 单页位图的像素预算（百万像素）。`renderRatio()` 给的是「屏幕要多少」，
 * 这里再兜一道「别超过多少」：一块 canvas 撑到几十 MB 时，重画一次几百毫秒、
 * 显存也吃不消，浏览器还会静默降采样（那就白画了）。
 *
 * ⚠️ 2026-10-10 修：这个预算必须**按「实际画出来的那块」算，不能按整页算**。
 * 以前是 `renderRatioFor(cssW, cssH)` 先按**整页**面积把倍率压到 0.75，
 * 再交给切片逻辑 —— 顺序反了：切片只有 2.4 MP、完全放得下，却继承了被压低的 0.75。
 * 实测（`test/artifacts/sharpness.mjs`，密度 = 屏幕 1 个 CSS 像素分到几个位图像素）：
 *   dpr=1：scale 5 起密度掉到 0.75（浏览器放大位图 = 糊）；
 *   dpr=2：fit 宽度就已经是 1.53/2，3.5× 掉到 1.0，5× 之后 0.75 —— 用户说的
 *   「放大之后就不太清晰了」就是这个。
 * 现在改成 `_renderPlan()`：**先按 dpr 定要画哪一块，再按这块的面积分配预算**，
 * 边距用剩下的预算反解（面积越大边距越小），于是可见区域**恒等于设备分辨率**。
 */
const MAX_FULL_MP = 9;
/**
 * 整页降采样能忍到什么程度（相对 `renderRatio()`）。
 *
 * 一块位图两种画法，成本都被 MAX_FULL_MP 卡住，区别在**取舍**：
 *   · 整页 + 降一点倍率：滚动时**不用重画**（位图盖着整页），代价是轻微发虚；
 *   · 可见区域 + 满倍率：清晰，但每滚过一个边距就要重画一次。
 * 所以只有「降一点点就能整页放下」时才选整页：2× 屏上 fitWidth 一页 10.3 MP、
 * 降到 1.87（93%）就能整页放下 —— 这点差别肉眼看不出来，换来滚动不重画；
 * 而放大到 3.5× 时整页只能降到 1.23（61%），那就必须切片保满分辨率。
 * 0.9 这条线就是这么定的（实测见 test/artifacts/sharpness.mjs）。
 */
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

/* ────────────────────────── 双指缩放速度（设置项） ──────────────────────────
   用户口径（2026-10-10）：「把缩放速度做进设置里面」。
   以前速度是两个写死的常数：触摸屏捏合的跟手倍率 `PINCH_GAIN = 1.6`
   （`scale = start × (d/d0)^gain`）和触摸板的灵敏度 `0.0022`（`app.js` 的 ctrl+wheel）。
   现在两者都乘一个**用户可在设置里调**的倍率 `zoomSpeed`，默认 1（= 原来的手感）。

   为什么上限是 2、下限是 0.5：gain 的物理含义是「手指距离变化 1% → 画面缩放百分之几」。
   1.6 已经是 1:1 之上的加速；再往上（2 倍 → 3.2）手指稍微一动就翻页级地跳，
   往下（0.5 倍 → 0.8）则比原生还迟钝、捏合会像没反应。范围卡在这里是防止
   调出一个自己都控制不住的手感。 */
export const ZOOM_SPEED_MIN = 0.5;
export const ZOOM_SPEED_MAX = 2;
/** 把设置里的值夹到合法范围；空值 / NaN / 字符串都回落到默认 1 */
export const clampZoomSpeed = (v) => clamp(Number(v) || 1, ZOOM_SPEED_MIN, ZOOM_SPEED_MAX);

/**
 * 文本层命中盒**纵向**最多扩张多少像素（见 `_tileTextHitBoxes`）。
 *
 * 只用来补「行距之间那条 1~3px 的缝隙」—— 缝隙补上之后，
 * 鼠标落在两行之间也不会退化成「容器 + 第几个子节点」那种没有文字含义的位置。
 * 上限必须这么小：实测 padding 到 158px 时，整盒会被 `Range.getClientRects()`
 * 当成选区矩形返回（画出来的方块变成一个大色块）。宁可留大空白给
 * `repairSelectionEnds()` 兜底，也不给矩形任何被污染的机会。
 */
const HIT_PAD_MAX = 6;

/**
 * 命中判定里「纵向差 1px」相当于多少横向差。
 *
 * `charPosAt()` 用它把「先看属于哪一行、再看行内第几个字」写成一次求最小值的打分：
 * 权重必须大到「纵向差 1px 压倒横向任意误差」，否则页面很宽时
 * 「同一行最右边那个字」会把「下一行最左边那个字」比下去 —— 拖选终点就跳行了。
 */
const CHAR_HIT_ROW_WEIGHT = 10000;

/**
 * 读某个层当前的 CSS 缩放倍数。
 *
 * `_softRescale()`（拖动缩放时的拉伸预览）会把文本层/热点层整体 `transform: scale(k)`，
 * 此时层里所有坐标都是**缩放前**的，指针位置要除回 k 才能和缓存下来的盒子比较。
 * 这里只解析内联样式字符串（不触发布局），成本可忽略。
 */
function layerScale(el) {
  const m = /^scale\(([\d.]+)\)$/.exec(el?.style?.transform || '');
  const k = m ? Number(m[1]) : NaN;
  return Number.isFinite(k) && k > 0 ? k : 1;
}

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
    /** 双指缩放速度倍率（设置项，默认 1；见 setZoomSpeed / clampZoomSpeed） */
    this.zoomSpeed = clampZoomSpeed(opts.zoomSpeed);
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
    this.referenceByNum = new Map();  // 已解析的编号索引，点击引用时优先走缓存
    /**
     * ⚠️ `page -> Set<编号>`：**哪些参考文献条目在哪一页**。
     *
     * 为什么需要它（用户实测缺陷 2026-10-04：「有的可以识别出来点击出现弹窗，有的不行」）：
     * 原来只按**整页**判断（`referencePages.has(i) → 整页不画热点`），
     * 但真实论文里「结论段 + 表格引用 + 文献表开头」常常同页共存 ——
     * 实测 `attention-arxiv.pdf` 第 10 页同时有 §7 结论段（`…Grammar [8].` / `…models [37],`）
     * 和 Table 4 的 10 个引用，只因该页有 `[1]`–`[4]` 这 4 条文献条目，
     * **整页 13 个正文引用一个热点都没画**（漏 21% 的正文引用）。
     *
     * 有了这张表就能精确到条目：只跳过「这一行的开头正好是本文献表里的那个编号」的行，
     * 同一页里的其它正文引用照常可点。
     */
    this.referenceEntries = new Map();
    /**
     * 是否处于「自动适配」状态。打开文档时默认为 true（load() 里会按窗口宽度算一次），
     * 手动缩放（setScale）会把它关掉。
     * 之前这里没有初始化，于是 load() 虽然算出了适配比例，却没记成「适配模式」，
     * 结果窗口一变大变小页面就不再跟着变 —— 用户看到的就是「打开后大小不对」。
     */
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

  /**
   * 轻量掉帧自检：**给真机用的取证工具**。
   *
   * 为什么需要它：我这边只能用无头 Chrome + 合成事件测，测不出用户机器上的真实手感
   * （他报「还是卡顿」，而我手上的数字是干净的）。与其继续猜，不如让应用自己报数。
   *
   * 规则（尽量不打扰、也尽量不耗电）：
   *   · 只在「有动作」时采样：滚动 / 手势 / 提交；闲置 1.2s 就停掉 rAF，不常驻；
   *   · 一个"动作窗口"里统计帧间隔、掉帧数、长任务，以及这段时间花在重画上的毫秒数；
   *   · 只有真的卡（最长帧 ≥ 100ms 或掉帧比例 ≥ 30%）才回报一次，3 秒内不重复；
   *   · 回报走 `opts.onJank`（app.js 接到 toast 上），同时在 console 打一行，
   *     并把最近 20 次记录留在 `window.__jankLog` 里，方便直接抄给我。
   */
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
    this.opts.onJank?.(rec, text);
  }

  /**
   * 触摸屏两指手势：**先判意图，再动手**。
   *
   * ── 为什么必须自己做（实测证据 test/perf/zoom-touch-takeover.mjs）──────────
   * 触摸屏捏合**不会**变成 `wheel` + ctrlKey（那是触摸板的路径，Windows 上由系统把
   * 触摸板 pinch 合成成带 CONTROL 的 WM_MOUSEWHEEL）。浏览器把它当成**整页 Page Scale**：
   * 实测两指张开时 `visualViewport.scale` 从 1 直接跳到 4，而 `zoomAt` 一次都没被调用 ——
   * 顶栏、侧栏、PDF 位图一起被拉大，用户看到的就是「糊 + 不跟手」。
   * （WebView2 侧对应 `IsPinchZoomEnabled`，wry 把它和 `with_hotkeys_zoom` 绑在一起，
   *   见 desktop/src/window.rs 的说明。）
   *
   * ── 判定优先（用户口径 2026-10-09：「下手到底是滑动还是缩放判断清楚，不要先划又变大变小」）
   * 两指落下到「看清意图」之间**一个像素都不动**，避免手指间距的抖动被当成缩放：
   *   · 间距变化 ≥ max(16px, 15%)  → 判成**缩放**（之后整段手势都按缩放走，不再回头）
   *   · 中点位移 ≥ 10px            → 判成**平移**（直接改 scroll，不碰比例）
   *   · 都没到阈值                 → 什么都不做
   * 两指平行拖动时间距几乎不变，所以只会平移、比例一动不动 —— 这正是要的效果。
   *
   * ── 为什么不 preventDefault（实测 test/perf/touch-pan-vs-pinch.mjs）
   * 在 `html{touch-action:pan-x pan-y}` 下，Chromium 对**两指**手势既不滚动也不捏合、
   * 也不发 touchcancel（四种手势全测过：事件原样送到页面、滚动 0px、vvScale 保持 1）。
   * 也就是说浏览器层面本来就是「惰性」的，不需要 preventDefault 去抢；
   * 反而一旦 preventDefault，后续「松开一根手指继续拖」就再也滚不动了（整个触摸序列被作废）。
   * 只在判定成缩放之后才 preventDefault，作为「万一某个引擎想插一脚」的兜底。
   *
   * 合帧与触摸板路径一致：touchmove 只记最新值，真正改比例/改滚动放到 requestAnimationFrame。
   */
  _bindTouchZoom() {
    const el = this.container;
    /**
     * 判定阈值。
     *
     * ⚠️ 2026-10-09 用户口径定稿（第四轮）：
     *   「只要判断是缩放，就不要移动位置；只要是两指之间距离增大，**不管是哪个方向**都是放大，缩小也一样」
     * 也就是**距离优先**：两指间距变了就是缩放，与方向无关、与中点动不动无关。
     * 所以这里把缩放的阈值压得很小（6px 或 2.5%），平移阈值保持 10px；
     * 只有「间距几乎不变、中点明显在走」才算平移。
     */
    const PINCH_ENGAGE_RATIO = 0.025;  // 间距相对变化
    const PINCH_ENGAGE_PX = 6;         // 间距绝对变化（两指靠得近时按这个算）
    /**
     * 触摸屏捏合的「跟手倍率」：`scale = start * (d/d0)^GAIN`。
     * GAIN = 1 是严格的 1:1（手指张开一倍、画面放大一倍）。
     * 用户两次要求「速度调大」：1 → 1.25 → **1.6**；2026-10-10 又要求
     * 「把缩放速度做进设置里面」→ 这里只是**基准值**，实际乘 `this.zoomSpeed`
     * （设置页那个滑杆，1 = 就是这个手感，0.5~2 可调）。每帧现读，改了立刻生效。
     */
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
    // 手指真的抬起来才算手势结束：不要用防抖在手指还按着的时候重排（实测那样会插进一次 200ms 卡顿）
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

  /**
   * 手势中的轻量预览：只缩放 pages 容器这一层，避免逐页改尺寸/读 offsetTop。
   * this.scale 仍实时更新，所以百分比和外部状态立即同步；真正布局延迟到手势停下。
   *
   * ── 铁律：**每帧一次 DOM 读都不做** ────────────────────────────────────
   * 旧实现每帧 `elementFromPoint` + 两次 `getBoundingClientRect`
   * （写完 transform 再读一次 = 强制同步布局），再加上逐帧改 scrollLeft/scrollTop。
   * 手感上这就是「跟手但一顿一顿」。改成本地代数：
   *   ① 手势开始那一帧量一次几何，记下 pages 容器原点的**内容坐标** E、滚动量 s、
   *      容器视口原点 c0；
   *   ② 锚点 p（手指抓住的那个 PDF 点）在内容坐标里固定不变；
   *   ③ 每帧只写一条 `translate(t) scale(k)`（transform-origin: 0 0），
   *      由 `E + t + k(p − E)` 落在当前手指位置 c 解出
   *        t = (c − c0) + s − E − k(p − E)
   *      —— 全是加减乘除，不碰布局。
   */
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

  /**
   * 预演某个比例下的真实布局：每页的内容坐标 top 与 left。
   *
   * 为什么要它（2026-10-09 实测「手势做完之后偏移闪现」）：
   * 之前预览是给 `.pages` 整层 `scale(k)` —— **页间距（14px）和上下内边距也被一起放大**，
   * 但提交后的真实布局里它们是固定值。于是离锚点每远一页，位置就差一个
   * `间距 × (k−1)`：实测 k=2.18 时视口内第 8 页在提交那一帧跳了 **16.5px**
   * （14 × 1.18 = 16.5，一分不差）。用户看到的就是「做完手势偏移一下」。
   * 现在预览按这里的预测值逐页摆放，与提交后的布局逐页对齐 → 提交那一帧不动。
   *
   * 公式与 `layout()` 完全一致：`top = padTop + Σ(round(h×scale) + gap)`，
   * 横向按 `.pages` 的居中规则 `(max(页宽, 容器宽) − 本页宽) / 2`。
   */
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
    /* `refX/refY` = **锚点要钉在屏幕上的位置**，整段缩放手势都不变。
       用户口径（2026-10-09）：「只要判断是缩放，就不要移动位置」——
       手指搓动时中点会漂，如果让画面跟着中点走，看起来就是「闪/飘」；
       只有对称的横竖拉伸（中点不动）才不闪，正是这个道理。
       所以缩放期间**只缩放、不平移**：锚点钉在按下去时的位置。
       （两指平移是另一个模式：那时才移动，见 previewPan。） */
    preview.refX = cx;
    preview.refY = cy;
    this._setZoomPreviewAnchor(preview, cx, cy);
  }

  /**
   * 记下「当前跟踪的那个点」：内容坐标 + 它在哪一页的什么相对位置。
   *
   * ⚠️ 下面这六个字段**必须一起更新**，它们分别是"预览每帧解常数用"和"提交时对回来用"的两套表示：
   *   · `anchor`（内容坐标，给 previewPan 反推手指起点）
   *   · `page` / `fx` / `fy`（提交时量一次页框矩形，用它把锚点对回 refX/refY）
   *   · `anchorPage` / `anchorLocalX` / `anchorLocalY`（逐页预览每帧解整体常数 C/D）
   * 只改一半的后果实测过（2026-10-09）：拖到滚动边界（平移被夹住）后再捏合，
   * 预览钉在旧点上、提交却按新点算，**提交那一帧画面跳 519px** —— 正是用户说的偏移闪现。
   * 所以重锚点只有这一个入口。
   *
   * `fx/fy` **不夹到 [0,1]**：页内相对位置允许线性外推（手指在页外时，
   * `r.top + fy*r.height` 仍精确等于那个屏幕位置）。夹了反而会让
   * 「预览钉的点」与「提交对回的点」变成两个不同的点。
   */
  _setZoomPreviewAnchor(preview, cx, cy) {
    preview.anchor = {
      x: preview.scrollX + (cx - preview.cLeft),
      y: preview.scrollY + (cy - preview.cTop),
    };
    /* 锚点在**哪一页的哪个相对位置**（fx/fy）。
       提交时用「页框矩形 + 相对位置」把位置对回去，而不是继续用上面的内容坐标：
       布局之后 pages 容器里的**间隙与内边距不随比例缩放**（CSS 里是固定 14px），
       所以「内容坐标 × k」在提交那一刻只是近似 —— 实测差 30px 左右（就是「飘」）。
       页内相对位置则严格不变（页内所有东西都按同一个比例缩放）。 */
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

  /**
   * 每帧的写：**逐页**预演真实布局（不读任何几何）。
   *
   * k === 1（两指平移）时退化成「整层平移」，直接用容器 transform —— 一次写、和以前一样快。
   * k ≠ 1（捏合）时逐页写：页面自己 `scale(k)`，位置按 `_predictedLayout` 预演，
   * 于是**页间距/内边距保持固定**，与提交后的真实布局逐页对齐（提交那一帧不再位移）。
   * 见 `_predictedLayout` 里的实测说明（16.5px → 0）。
   *
   * 只写"看得见的那几页"：视口外的页不写（transform 不改布局，不会影响别的页），
   * 这样每帧的写次数与可见页数同阶（实测 1~3 页）。
   */
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
    /**
     * 预览 = **把提交后的那一帧画出来**：页面位置用预测布局，滚动量用「钉住锚点所需的值」
     * 再夹到这个布局真正能滚到的范围里。
     *
     * 为什么必须夹（2026-10-10 用户口径：「要归中就固定归中，不要已经移到左右又闪回中间」）：
     * 提交后能不能停在我们想要的位置，取决于**新布局的滚动范围**。缩小的时候页面会变得比
     * 阅读区窄（`maxScrollX` 变 0），布局会把页居中 —— 而预览期却在按手指横向钉住，
     * 于是提交那一帧被硬拽回去。实测（test/artifacts/offcenter-commit.mjs）：
     *   5× → 1.75× 缩小：中点居中时提交帧横移 **269px**、中点偏右时 **483px**，
     *   纵向也有一例 **83px**（顶到文档头）。
     * 夹住之后「预览看到的位置」与「提交后的位置」在数学上恒等：
     *   px = (pred.lefts[i] − old.lefts[i]) + (scrollX − sx)，sx 就是提交会写的那个 scrollLeft。
     * 横向没得滚时 sx ≡ 0，预览从头到尾就是居中的 —— 也就是用户要的「固定归中放大」。
     */
    const ap = preview.anchorPage;
    let C = 0;
    let D = 0;
    if (ap && old.tops[ap] != null) {
      const ax = preview.anchorLocalX;      // 锚点在页内的局部坐标（未缩放）
      const ay = preview.anchorLocalY;
      /* 坐标系（这是唯一一套，别再加别的项）：`.pages` 自己就是被滚动的那个内容，
         所以页顶的屏幕位置 = `cTop + 内容 top − scrollY`，内容坐标原点就在 `.pages` 的
         padding 起点。（`originX/originY` 是捕获时顺手记的、恒等于 0，**不要**再拿它加减，
         否则会凭空多出一个 `scrollY` 的量级 —— 实测那样写预览会整体飞掉。）
         新布局的内容尺寸 → 新布局真正能滚到的范围：
         纵向：`bottom` 含最后一页后面那个 gap（row-gap 不会渲染出来），所以减掉再加 padding-bottom。
         横向：`lefts` 已经是按「居中、且不小于容器宽」算的，所以取每页右边缘的最大值即可
         （页比容器窄时它小于容器宽 → 结果为 0，正是「没得滚」）。 */
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
      /* 把这一帧算出来的滚动量记在 preview 上：**提交时直接落这个值**（见 commitZoomPreview）。
         不能让提交再写一遍「未夹取」的 want、交给浏览器去夹 —— DOM 的 scrollWidth/scrollHeight
         会被溢出的后代（拉伸中的层、切片画布）撑大，浏览器允许的滚动量比布局真正的大，
         于是预览显示 A、提交落到 B：实测 24 次随机手势里 5 次中招、最大横移 7516px
         （test/artifacts/gesture-fuzz.mjs）。预览与提交用同一个数才叫「所见即所得」。 */
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
    /* 从「平移」升级成「缩放」时，锚点要重新钉一次，否则升级/提交那一帧会跳。
       钉在**当前指针位置**：平移期画面一直是 1:1 跟着手指的（到边界被夹住时例外，
       见 previewPan 的夹取分支 —— 那里会把 fx/fy/page 改成「手指底下那个点」），
       所以「手指底下那个点」此刻就在手指上，钉住它就等于**画面纹丝不动地开始放大**。
       注意不能写成 `refX + panTx`：被夹住过的平移，手指位置和画面位置差着「搓过头的量」，
       那样算出来的锚点会让「预览钉的点」与「提交对回的点」分成两个点
       （实测搓过头 480px → 提交那一帧画面跳 **660px**）。 */
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

  /**
   * 两指平移预览：只写 transform，**一个字都不写 scroll**。
   *
   * 为什么不直接改 scrollTop（实测 test/perf/touch-pan-vs-pinch.mjs）：
   * 在触摸序列中途写一次 `container.scrollTop`，后续 touchmove / touchend **全部收不到**
   * ——20 个 move 只剩 1 个，手势当场死掉（浏览器没有发 touchcancel，就是不发事件了）。
   * 同样位置写 `transform` 则完全没事（捏合那条路一直是写 transform，20 个 move 全到）。
   * 所以平移也走 transform，松手时一次性落到 scroll：
   *   · 1:1 跟手，不看浏览器滚动实现的脸色；
   *   · 提交那一刻位置严格对齐，且**不重排、不重画、不碰比例**；
   *   · 位移按「最多能滚到哪儿」夹住（maxScroll 在手势开始时量过一次），
   *     所以到边界的手感跟原生滚动一样，不会越拉越多再回弹。
   */
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
         锚点必须跟着挪（**整套一起挪**，见 _setZoomPreviewAnchor 的说明），
         否则「拖到边之后再捏合」会从旧锚点算，升级帧和提交帧各跳一次。 */
      this._setZoomPreviewAnchor(preview, clientX, clientY);
      // `anchor` 要用**夹住之后**的内容坐标（它与「手指底下那个点」差一个夹取量），
      // 上面的 helper 算的是未夹取的版本，这里覆盖掉。
      preview.anchor.x = clientX + preview.scrollX - preview.cLeft - tx;
      preview.anchor.y = clientY + preview.scrollY - preview.cTop - ty;
    }
    preview.panTx = tx;
    preview.panTy = ty;
    this._writePreviewTransform(preview, 1, tx, ty);
  }

  /**
   * 提交缩放预览：**steady → preview → committing → steady** 里的 committing 段。
   *
   * 这一段必须整体跑在**同一个同步任务**里，浏览器中间不会绘制，所以不存在
   * 「旧视觉坐标被丢掉 → 重新补回来」的中间帧。实测（test/perf/commit-continuity.mjs）：
   * 手指中点固定在 (750,430) 时，锚点在手势全程 36 帧（含提交那一帧）里
   * 离手指最大偏差 0.2px、逐帧位移全是 0 —— 没有瞬移。
   *
   * 顺序上有一处**不能换**：必须先清 `.pages` 的 transform，再去量页框矩形。
   * 因为 `getBoundingClientRect()` 会把祖先的 transform 算进去；带着 preview transform
   * 量出来的矩形是缩放后的，用它反算滚动量会重复算一次缩放。
   * 所以流程是「清 transform → 摆好旧内容 → 改真实布局 → 量新矩形 → 写滚动」，一次到底。
   *
   * 换帧（新位图换上）之后由 `_resetLayerScale()` 收尾，保证回到 steady 时
   * canvas 没有拉伸标记、四个覆盖层没有 transform —— 见那里的不变量说明。
   */
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
    /* 落滚动：**直接用预览最后一帧算出来的那两个数**（见 _writePreviewTransform）。
       预览就是按 (sx, sy) 画的，提交写同样的值 → 这一帧在数学上不可能位移。
       为什么不再「量页框矩形再反推」：那条路要重新解一次锚点，而且把夹取交给浏览器 ——
       浏览器的上限来自 DOM 的 scrollWidth/scrollHeight，会被溢出的后代（拉伸中的层、
       切片画布）撑大，比布局真正的大，于是预览夹住了、提交却没夹 → 瞬移（实测最大 7516px）。
       `sx/sy` 一定落在真实范围内（预测的内容尺寸 ≤ 真实内容尺寸），浏览器不会再夹第二次。 */
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
   *
   * ⚠️ 单位铁律（2026-10-09）：**层里只允许有一种定位单位 ——「渲染比例下的绝对 px」**。
   * 这一层要整层 `scale(k)` 才能跟上新页框，而任何「自己也会跟着页框缩放」的东西
   * （百分比定位、吃 `--total-scale-factor` 的字号）再叠一层 scale(k) 就是**双倍**。
   * 所以：pdf.js 的 span（百分比 + CSS 变量字号）先被 `_freezeTextLayerMetrics` 冻结成 px；
   * 选中方块与笔记书签也改成 px。唯独文本层的 `transform` 由这里统一管，
   * 业务代码不要再自己给这几个层写 transform。
   */
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

  /** 旧位图按比例拉伸：位图是绝对 px，直接改宽高/偏移最省事（不重画）。
   *  ⚠️ 高位图可能是**切片**（`entry.slice`）：那时这块 canvas 只覆盖切片那么大，
   *  拉伸的宽高必须是 `slice.w/h × k`，不能用整页的 `cssW/cssH` ——
   *  否则一块 1589×1153 的切片会被拉成整页 2142×2772，画面明显错位（实测密度算出 2.317>dpr 才发现）。 */
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
    for (const layer of [entry.textDiv, entry.hlLayer, entry.hitLayer, entry.pinLayer]) {
      if (!layer) continue;
      layer.style.transformOrigin = '0 0';
      layer.style.transform = tf;
    }
  }

  /**
   * 一页「临时缩放」的收尾：新位图换上之后必须满足
   *   canvas 的软缩放标记 = 无、四个覆盖层的 transform = 无。
   * 这是提交阶段的状态机不变量（steady → preview → committing → steady），
   * 漏掉任何一项，旧 transform 就会和新比例同时生效 —— 也就是"双重缩放"。
   */
  _resetLayerScale(entry) {
    if (!entry) return;
    entry.canvas?.classList.remove('soft-zoom');
    for (const layer of [entry.textDiv, entry.hlLayer, entry.hitLayer, entry.pinLayer]) {
      if (layer) layer.style.transform = '';
    }
  }

  /**
   * 手势停下后再真正重画（防抖 + **一页一页来**）。
   *
   * 为什么要节流（实测 test/perf/zoom-commit-timeline.mjs）：
   *   一页重画 = 重建文本层（字体绑定/字距/命中带）+ 重画位图，实测 240~450ms；
   *   旧实现一次把视口内外 5 页全部开工，主线程于是连续卡住近 1 秒 ——
   *   用户口径就是「松手之后顿一下，再捏就不跟手了」。
   *   现在按「离视口中心近的优先」排队，一页画完让出一帧再画下一页：
   *   用户正在看的那一页最先变清晰，中间随时可以再捏/再滚（新预览一到就放弃队列）。
   *   中间那次让帧实测把长任务从 8 个 / 779ms 降到 4 个 / 314ms。
   */
  _scheduleRerender(delay = 140) {
    /* ⚠️ 不能因为「已经在跑」就把请求丢掉（踩过一次）：
       拖动缩放那 41 次 setScale 会在队列跑着的时候继续标脏 + 继续请求，
       丢掉请求的后果是「某一页明明在视口里、却一直糊着」（实测 6 秒都不自愈）——
       因为队列是在开跑那一刻按当时的可见范围建的，之后变可见的页没人管。
       所以：记一个「还想再跑一趟」的标记，这一趟跑完再用新的可见范围补一趟。 */
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
          await new Promise((r) => requestAnimationFrame(() => r()));
        }
        this._reclaimFar();
        if (!this._rerenderWanted) return;
      }
    } finally {
      this._rerenderRunning = false;
      /**
       * ⚠️ 关键补丁（2026-10-09 实测抓到的真 bug）：
       * `_scheduleRerender()` 在「队列正在跑」时只记 `_rerenderWanted`、不排定时器，
       * 指望这一趟跑完把标记消费掉。但这一趟可能**中途 return**（手势插进来）
       * 或者**跑满轮次上限**退出 —— 那样标记就永远没人处理：
       * 现场实测（zoom.mjs 失败时的 DOM 快照）是
       *   `page=1 dirty=true renderScale=2.694 scale=2.072 tasks=[] running=false wanted=true timer=false`
       * ——那一页在视口里糊着，10 秒都不自愈。
       * 所以退出时只要「做过事 + 还有请求」，就补一个定时器再跑一趟，保证请求不丢。
       */
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
   * 触摸屏捏合每帧都现读 `this.zoomSpeed`，所以设置页拖动滑杆时**下一帧就生效**，
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
      if (this.offsets[i] + this.heights[i] >= top) { first = i; break; }
    }
    for (let i = first; i <= this.numPages; i++) {
      if (this.offsets[i] > bottom) { last = Math.max(first, i - 1); break; }
      last = i;
    }
    return [first, last];
  }

  async _renderVisible(force = false, gen = this._gen) {
    if (!this.pdf || !this.offsets.length || gen !== this._gen || this._zoomPreview) return;
    const [first, last] = this._visibleRange();
    const lo = Math.max(1, first - 1);
    const hi = Math.min(this.numPages, last + 1);
    let hasDirty = false;
    for (let i = lo; i <= hi; i++) {
      const entry = this.rendered.get(i);
      /* dirty = 软缩放留下的拉伸预览，需要重画成清晰版（但不走 placeholder 那条路）。
         ⚠️ 这类**不能在这里直接开工**：本函数是滚动处理器调的，一次会把视口内所有页
         同时点着 —— 实测那样会在 commit 之后立刻叠出一个 178ms 长任务
         （commit 写 scrollTop → 60ms 后 _handleScroll → 这里 → 两页并行重画），
         把上面那套「排队 + 让帧」整个绕过去了。
         交给 _runRerenderPass 一页一页画；缺页（placeholder）仍然立刻补，滚动不能等。 */
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

  /**
   * 决定「这一页这一帧画哪一块、按多大倍率画」——顺序是**先区域、后预算**。
   *
   * 1. 倍率两个口径：`deviceRatio()` 是屏幕**真正需要**多少（dpr），
   *    `renderRatio()` 是实际画多大（再乘一点超采样，见 `SUPERSAMPLE`）。
   *    「整页还是切片」「降采样能忍到哪」都按**屏幕需求**判，超采样只影响实际画的尺寸。
   * 2. 整页按目标倍率画放得进预算 → 整页。
   * 3. 放不进、但降一点点（≥ `WHOLE_PAGE_TOLERANCE` × 屏幕需求）就能整页放下 → 整页 + 那点降采样
   *    （滚动时不用重画，值这一点点糊）。
   * 4. 否则 → 只画**可见区域**，倍率仍然是目标倍率。这一步以前是反的：先按整页面积
   *    把倍率压到 0.75 再切片，于是切片也糊 —— 用户说的「放大之后就不太清晰」。
   * 5. 连可见区域都超预算（超大窗口 + 2× 屏）→ 才降倍率，
   *    但**不低于屏幕需求**（降到屏幕以下就真的糊了）。
   * 6. 剩下的预算拿来做边距（滚动时不用马上重画）：边距面积解方程
   *    `(w+2m)(h+2m)·ratio² = 预算`，所以屏幕越密、窗口越大，边距越小。
   *
   * 返回 `{ ratio, slice, window? }`，`slice` 是相对页面左上角的 CSS px 矩形（null = 整页）。
   */
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
    /* 画哪一块 = 「阅读区大小的窗口」挪进页面范围内、取离阅读区最近的位置：
       · 页面盖住阅读区 → 就是可见区域；
       · 页面只露出一角、或者**根本不在视口里**（离屏页被排进重画队列时就是这种）
         → 取最近的等大窗口（页面上/下那一头）。
       ⚠️ 这里**绝不能**退化成「整页按 dpr 画」：5× 下一页是 3060×3960 CSS，
       dpr=2 就是 **48.5 MP / 194 MB 一张位图**，浏览器当场卡死（实测过一次）。 */
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
      /* `window` = **必须被覆盖**的那一块（就是阅读区大小的窗口）。
         判断「已渲染的切片还够不够用」只能拿它去比 —— 拿 `slice`（= window + 边距）
         去比的话，边距自己也在"需要"里，于是任何一点滚动都判成不够用，
         边距等于白留：实测 5× 时 45 个滚动步触发了 45 次重画（长任务合计 2536ms）。 */
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
    /**
     * 双缓冲：上一张位图先留着当预览，新的画好了再换掉它。
     * 不管走哪条路径（软缩放 / 换切片 / 面板变宽）中间都不会露出
     * `.page.placeholder::after` 那条灰斜纹，也不会闪白 ——
     * 用户反馈的「拖动缩放时灰条一直闪」就是这么来的。
     * 新的画布是**另一个 canvas**，所以两边不会抢同一个上下文，
     * 也就不需要「等在途任务落定再重画」那套了。
     */
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
      // 倍率与区域一起定：**先按 dpr 定画哪一块，再按这块的面积分配预算**（见 _renderPlan）
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
      const pinLayer = reusePinLayer ? prevEntry.pinLayer : document.createElement('div');
      pinLayer.className = 'hl-pin-layer';
      if (!reusePinLayer) pinLayer.style.transform = '';

      const entry = {
        canvas, textDiv, hlLayer, hitLayer, pinLayer, task: null, textLayer: null,
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
        pageEl.prepend(hlLayer, hitLayer, canvas);
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
        if (!reusePinLayer) prevEntry.pinLayer?.remove();
        this.rendered.set(i, entry);
        prevCanvas.before(hlLayer, hitLayer);
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
        /**
         * ⚠️ 这一页的文本流**只取一次**。
         * 旧实现是：TextLayer 用 `page.streamTextContent()` 取一遍；
         * `_bindRealFonts` 里又 `page.getTextContent()` 取一遍 ——
         * 而 pdf.js 的 `getTextContent()` 只是把 `streamTextContent()` 拼起来，**没有任何缓存**
         * （见 public/vendor/pdf.min.mjs 里 `async getTextContent(t={})` 的实现），
         * 等于同一页在 worker 里被解析两遍。实测（test/perf/zoom-commit-timeline.mjs）这一段约 90ms/页，
         * 正好压在「松手之后」那一下上。
         * pdf.js 的 TextLayer 既接受 ReadableStream 也接受 `{items, styles}` 对象
         * （构造器里有 `if (t instanceof ReadableStream) … else 自己包一个流`），
         * 所以先取一次，再同时喂给文本层和字体绑定。
         */
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
        /**
         * ⚠️ 顺序很重要，三步都不能少（用户实测缺陷 2026-10-04：
         *   「选词划词没有做准，没有和真实的字对齐」「鼠标偏移一点点就选中了一大段」）：
         *
         *   ① `_bindRealFonts`：pdf.js 把 PDF 的**嵌入字体**装进了 `document.fonts`
         *      （`g_d1_f1` 这种族名），但渲染出来的 span 用的是通用族兜底（`sans-serif`/`monospace`）。
         *      于是 **DOM 按系统字体排版、canvas 按嵌入字体画字**，宽度能差 10~16%
         *      （实测 "Provided proper attribution is…"：DOM 自然宽 421.16 vs 墨迹 361.5）。
         *      pdf.js 只能用一个整体 scaleX 把总宽拉回去，字符位置必然错位 ——
         *      行两端误差 ~1px、行中间最大 4.9px（200% 下 8.1px）。这就是「对不齐」。
         *   ② `_normalizeTextScale`：把 scaleX 换成 letter-spacing（换字体后仍需，
         *      因为子集缺字形会逐字回退，宽度还会差 3.5~6.3%）。
         *   ③ `_nudgeTextLayer`：**垂直命中带补偿**。文本层 span 的 top 是按 PDF 字体的
         *      ascent 算的，但参与命中测试的 inline 文本框高度由当前字体决定；
         *      两份字体不一致时每行可见字形最下面约 2.75px（10pt，占墨迹高 32%）在命中上属于下一行，
         *      而相邻行盒只隔 0.97px → 拖选时终点掉到下一行，「选 10 个字」变成「选 96 个字」。
         */
        if (!stale()) {
          await this._bindRealFonts(textDiv, page, textContent);
          if (!stale()) {
            /* 先把这个文本层「冻结」成**渲染比例下的绝对 px**，再做后面三步。
               为什么必须冻结（2026-10-09 实测，见 test/perf/commit-continuity.mjs）：
               提交缩放时 `_softRescale()` 会给每一层挂 `transform: scale(k)`（位图/覆盖层
               都是按旧比例算的绝对 px，只能整层缩放跟上新页框）。但 pdf.js 写的 span
               是 `left/top` **百分比**、字号吃 `--total-scale-factor` —— 这两样**自己就会
               跟着页框缩放**，再叠一层 scale(k) 就是**双倍**：实测 span 的页内相对位置
               fx 0.199 → 0.299（正好多缩了 1.5 倍），而同一层里被 `_nudgeTextLayer`
               改写成 px 的 `top` 却是对的 —— 一个层里混着两套单位，怎么缩都有一半是错的。
               冻结之后就只剩一套单位：**层里全是 px，整层 scale(k) 恰好正确**。 */
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
  /**
   * 把 pdf.js 已经加载好的**嵌入字体**真正用到文本层的 span 上。
   *
   * 用户实测缺陷（2026-10-04）：「选词划词没有做准，没有和真实的字对齐」。
   * 根因：`document.fonts` 里已经有 `g_d1_f1` 这类真实嵌入字体（status=loaded，
   * 宽度和 canvas 墨迹只差 0.88px），**但渲染出来的 span 用的是通用族兜底**
   * （`font-family: sans-serif` / `monospace`）。于是 DOM 按系统字体排版、
   * canvas 按嵌入字体画字，同一串文字宽度能差 10~16%：
   *   "Provided proper attribution is…"  DOM 自然宽 421.16 / pdf.js 期望 362.67 / 墨迹 361.5
   * pdf.js 只能用一个**整体 scaleX** 把总宽拉回去 → 字符位置必然错位：
   * 逐词偏差行两端 ~1px、**行中间 4~6px**（≈0.7~0.9 个字），200% 缩放下最大 8.1px。
   *
   * 做法：拿 `page.getTextContent()` 的 items，按顺序与 span 双指针对上，
   * 把 span 的字体换成 `item.fontName`，并据此重算 `--scale-x`。
   * ⚠️ 对不上就**整页放弃**（上错字体比不改更糟）—— pdf.js 会跳过空串 / role=img /
   * markedContent 包装，双指针必须能一路对上才算可信。
   */
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
      /**
       * ── 两趟「读写分离」，不要在一个循环里又写又读 ─────────────────────────
       * 旧写法每个 span 都是「写 fontFamily → getBoundingClientRect 读宽度 → 写 --scale-x」，
       * 而 `--scale-x` 是 `transform: scaleX()` 的输入、fontFamily 又会改排版：
       * 于是**每个 span 都把整份文档的样式与布局重新算一遍**（强制同步布局 / layout thrashing）。
       * 实测（test/perf/zoom-commit-timeline.mjs，16 页夹具）：
       * 单页这一项要 **152~184ms**，是「捏合松开后顿一下」的最大一笔开销；
       * 拆成 ①只读 computedStyle ②只写字体 ③一次性读全部宽度 ④只写 --scale-x 之后，
       * 整页只剩 1 次强制布局。宽度必须在写完字体、且 --scale-x 归 1 之后读（和旧写法同一时刻）。
       */
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

  /**
   * 垂直命中带补偿：让「鼠标命中带」的中心与「canvas 上真实墨迹」的中心重合。
   *
   * 用户实测缺陷（2026-10-04）：「鼠标偏移一点点就选中了一大段」。
   * 根因：span 的 `top` 是 pdf.js 按 **PDF 字体 ascent** 算的，但参与命中测试的
   * **inline 文本框**高度由**当前 DOM 字体**决定。两份字体不一致时，每行可见字形
   * 最下面约 2.75px（10pt 正文，占墨迹高 8.5px 的 32%）在命中上属于**下一行**，
   * 而相邻行盒只隔 0.97px → 拖选时终点被解析到下一行，选区从 10 个字拉到 96 个字
   * （再低 8px 就是 433 个字、跨 6 行）。
   *
   * 补偿量 ≈ (行盒高 − 墨迹高)/2 与字体相关的差值。子智能体实测的安全工作区：
   * 10pt ≈ +2~+5px、12pt ≈ +1.75px、17.2pt ≈ −4.25px；
   * **过冲比现状更糟**（> +6px 时选区变 0 字或 433 字），所以这里按字体度量算，
   * 不写全局常数，并夹在 ±0.5em 之内兜底。
   */
  _nudgeTextLayer(container, page) {
    try {
      const pageEl = container.closest('.page') || container.parentElement;
      const pageH = pageEl?.clientHeight || 0;
      const spans = container.querySelectorAll('span:not(.markedContent)');
      const ctx = this._measureCtx || (this._measureCtx = document.createElement('canvas').getContext('2d'));
      /**
       * 读写分离（同 `_bindRealFonts`）：旧写法在一个循环里
       * 「getComputedStyle + Range.getClientRects + pageEl.getBoundingClientRect → 写 span.style.top」，
       * 写 top 会把布局打脏，下一轮的读又要强制同步布局 —— 每个 span 一次，整页实测 ~20ms。
       * 现在所有读都在写之前完成（pageEl 的矩形也只量一次，循环里它不会变），
       * 于是整页只留 1 次强制布局。
       */
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

  /**
   * 把文本层的命中盒**在纵向补满行距缝隙**（一行一条命中带，边界取相邻行中心线的中点）。
   *
   * ── 为什么必须补（用户实测缺陷 2026-10-06：「有时候不是按鼠标选中的区域，
   *    有时候一搞就选中一大块」）────────────────────────────────────────────
   * 根因不在选区逻辑，而在文本层的布局：
   *   `.textLayer` 的子元素**全部**是 `position:absolute`（不在行内流里），
   *   容器因此一个行盒都没有。鼠标落在任何 span 盒子以外的地方 ——
   *   行距之间那条缝隙、行尾右侧的空白、左右页边、同一行两个 run 之间的小空隙 ——
   *   浏览器的「坐标 → 文字位置」没有行盒可吸附，就退化成
   *   **「容器 + 第几个子节点」**（实测 `caretRangeFromPoint` 返回 `DIV.textLayer@43`）。
   *   于是 Range 从锚点一路「吃到」第 k 个子节点：
   *     · 行内横拖 120px → 1356 字 / 80 个矩形 / 框高跨 492px（跨好几行）；
   *     · 起手/终点落在行间缝隙 → 0 字（两端都退化成容器，一个字都选不出来）；
   *     · 起手落在 `[n]` 引用热点或页边上 → 2776 字、横跨两页。
   *
   * ── 这里只做「纵向补缝」，横向的空白留给 `repairSelectionEnds()` ──────────
   *   纵向：行上/下边界取「与相邻行中心线的中点」，扩张量夹在 HIT_PAD_MAX 以内
   *   （正常行距只差 1~3px，够用）；用 `padding-top/bottom` 扩张命中盒，`top` 反向补偿，
   *   字形位置一个像素都不动。
   *   ⚠️ 横向 padding **绝对不能加**、纵向也不能放大：受控实验（test/lab-leak.mjs）实测，
   *   只要 span 有横向 padding，它在「跨 span 的选区」中就会被浏览器**整盒**返回 ——
   *   `Range.getClientRects()` 给出 300/953（边框盒）而不是 52/434（行盒），
   *   画出来的选中方块立刻横贯整页，正是用户说的「一搞就选中一大块」；
   *   纵向 padding 加到 158px 时页 1 的作者栏也会被整盒返回。
   *   所以左右页边、图区那种大空白**不铺**，由 `repairSelectionEnds()` 按几何命中兜底。
   *
   * 效果：正常行距的缝隙被补上之后，落点不会再退化成容器位置；
   * 加上兜底之后，同样 120px 的拖动从 1356 字降到 50 字上下（见 test/selection-stable.mjs）。
   */
  _tileTextHitBoxes(container) {
    try {
      const layerRect = container.getBoundingClientRect();
      const W = layerRect.width;
      const H = layerRect.height;
      if (!(W > 4 && H > 4)) return null;

      /* ① 只读一遍几何（先读后写，避免每个 span 都触发一次重排）。
         注意：这一份 `read` 会原样返回给 `charPosAt()` 当命中表用 ——
         它必须包含**所有**有文字子节点的 span（含只有空格的），
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

      /* ④ 写样式（全部算完再写，只触发一次重排）：**只做纵向扩张，而且只补行距缝隙**。
         ⚠️ 两条硬约束（都是实测出来的，别改）：
         ① **横向 padding 绝对不能加**：受控实验 test/lab-leak.mjs 里，只要 span 有横向
            padding，它在「跨 span 的选区」中就会被浏览器**整盒**返回 ——
            `Range.getClientRects()` 给出 300/953（边框盒）而不是 52/434（行盒），
            画出来的选中方块立刻横贯整页，正是用户说的「一搞就选中一大块」。
         ② **纵向 padding 也要夹住**：同一实验里小 padding 不污染矩形，但页 1 的作者栏
            在 pt=158px 时又被整盒返回了。所以只补「行距缝隙」这一档（实测 1~3px 就够），
            上限 HIT_PAD_MAX；页面上下页边、图区那种大空白不铺，
            交给 `repairSelectionEnds()` 的几何命中兜底。
         `top` 反向补偿，保证字形位置一个像素都不动。 */
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

  /**
   * 「这个屏幕坐标下面是哪个字」—— 不走浏览器的坐标→位置回退，自己按几何算。
   *
   * 为什么要自己算：几类鼠标落点浏览器给不出真正的文字位置（成因见 `_tileTextHitBoxes`）：
   *   · 行距缝隙 / 左右页边 / 行尾空白 → 浏览器退化成「容器 + 第几个子节点」；
   *   · 起手落在引用热点 `[n]` 上 → 实测锚点能差 10 个字。
   * `repairSelectionEnds()` 用它把跑偏的选区两端拉回文字上。
   *
   * 几何来自 `_tileTextHitBoxes()` 返回并缓存在 `entry.hitBoxes` 上的命中表
   * （页面内局部坐标），所以每次判定只读一次页面矩形，不逐个 span 读 DOM。
   *
   * @returns {{node: Text, offset: number, page: number}|null}
   */
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
    // `_offsetInSpan` 里的字符区间是**视口坐标**（getBoundingClientRect 已含缩放），所以这里传原始 x
    return { ...this._offsetInSpan(best.b.span, best.b.node, clamp(clientX, pr.left, pr.right)), page: Number(this.pageEls[i].dataset.page) };
  }

  /**
   * span 里离 clientX 最近的**字符边界**。
   *
   * 每个字符的 x 区间缓存进 WeakMap（文本层重建时元素一起消失，缓存自动作废），
   * 所以同一段文字只量一次。
   *
   * ⚠️ 缓存里存的是**相对 span 左边缘**的偏移，不是屏幕坐标：
   * 页面会滚动，屏幕坐标每次都要重算（否则滚动之后再拖选，算出来的字符位置会整整偏一个滚动量）。
   * 相对量在滚动、缩放（`_softRescale` 的 CSS 缩放）下都不变。
   */
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

  /**
   * 把「跑偏的选区」两端拉回文字上。
   *
   * 判据：Range 的某一端**不是文本节点**。那说明浏览器算出的是「容器 + 第几个子节点」
   * 这类没有文字含义的位置（成因见 `_tileTextHitBoxes`），Range 会从锚点一路吃到那个
   * 子节点 —— 界面上看就是「一搞就选中一大块」。这时用鼠标的两个真实落点
   * （按下点 / 松手点）自己算字符位置，重建选区。
   *
   * 还有一类**更彻底的失败**要一起兜：拖选本该有选区，浏览器却给了一个**塌掉的**空选区
   * （起手落在页边空白、或者落在引用热点那种非文字元素上时实测会发生）——
   * 用户拖了半天一个字都没选出来。`allowCollapsed` 打开时，用两个落点自己建选区。
   *
   * ⚠️ 只有这两种情况才动手：正常拖选、双击选词、三击选段、测试里程序化构造的选区
   * 两端本来就是文本节点，**一个字节都不碰**。
   *
   * @param {{anchor?:{x:number,y:number}, focus?:{x:number,y:number}, allowCollapsed?:boolean}} opts
   */
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

  /**
   * 把 pdf.js 的 `transform: scaleX(...)` 换算成等效的 `letter-spacing`。
   *
   * 保留它是因为**换真字体后仍然需要**：嵌入字体常常是子集，缺字形会逐字回退到
   * 系统字体，整行宽度还会差 3.5~6.3%（实测 "[5] Kyunghyun Cho, Bart " 378.89 vs 392.26）。
   *
   * ⚠️ 两个已修正的细节（子智能体实测）：
   *   ① `letter-spacing` 在 Chrome 里**最后一个字符也会加**，所以除数应该是 `text.length`
   *      而不是 `length-1` —— 原来那样每行最多偏 1.09px；
   *   ② `--rotate` 非 0 的 span 要跳过：那是旋转文本，`rect.width` 是旋转后的外接框，
   *      拿它算 letter-spacing 会写进完全错误的字距。
   */
  /**
   * 把 pdf.js 生成的文本层冻结成**渲染比例下的绝对 px**：
   *   `left` / `top` 百分比 → px，`font-size` 的 `calc(...)` → 计算后的 px。
   * 这样整个层只剩一套单位，提交缩放时统一 `scale(k)` 才是正确的（见 _renderPage 里的说明）。
   * 页框尺寸用 entry.cssW/cssH —— 那正是这一层渲染时的尺寸（`.textLayer` 是 inset:0）。
   */
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
     * 同样要读写分离：`rect.width` 是**写完上一个 span 的 letter-spacing 之后**再读的，
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
    /**
     * ⚠️ 热点是 `pointer-events:none` 的（见 style.css 里 `.cite-link` 的说明）：
     * 它盖在 `[12]` 这几个字**上面**，一旦吃鼠标事件，mousedown 就落在 div 而不是文本上，
     * 浏览器给不出真正的文字锚点 —— 起手落在 `[n]` 上的一次小拖选能选出 2776 字（跨两页）。
     * 代价是 `e.target.closest('.cite-link')` 和 `:hover` 都不再成立，
     * 所以这里留一份**几何表**：`citeAt()` 按坐标判命中，`_updateCiteHover()` 点亮悬停。
     */
    entry.citeHits = [];

    /**
     * 参考文献**条目**本身通常以 [n] 开头，它不是正文引用，不能点击后再跳回同一页并伪造
     * 一条"返回原位置"记录。
     *
     * ⚠️ 判据必须是「这一行的开头 + 编号命中本文献表」，**不能**是「这一页是参考文献页」。
     * 原来写的是 `if (this.referencePages.has(i)) return;` —— 整页粒度，
     * 于是「结论段 / 表格引用 / 文献表开头」同页的真实论文（实测 attention-arxiv p.10）
     * 整页 13 个正文引用全部失去热点（占全部正文引用的 21%），表现为"有的能点有的不能点"。
     */
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
          /**
           * 命中表存**页面内局部坐标**（不是屏幕坐标）：`citeAt()` 每次鼠标移动都要用，
           * 存屏幕坐标就得对每个热点读一次 `getBoundingClientRect()`（一页几十个 ×
           * 每帧一次 = 几百次布局查询）；存局部坐标则只需要每页读一次页面矩形。
           * 卡片锚点在**命中时**现取，滚动后也不会过期（见用户实测 2026-10-04）。
           */
          entry.citeHits.push({ el: d, nums, raw, page: i, x: citeLeft, y: citeTop, w: citeW, h: citeH });
        }
      }
    }
  }

  /**
   * 这个屏幕坐标下面有没有正文引用热点 `[n]`。
   *
   * 热点自己不吃鼠标事件（见 `_paintCites` 的说明），所以点击/悬停都改成
   * **按坐标几何命中**：只读每页一次页面矩形，其余全是命中表上的算术。
   *
   * @returns {{nums:number[],raw:string,page:number,anchor:object,el:Element}|null}
   */
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

  /**
   * 鼠标经过引用热点时点亮它 / 换手型光标。
   *
   * `.cite-link` 改成 `pointer-events:none` 之后 CSS 的 `:hover` 不再触发，
   * 这里用同一个几何命中把「鼠标移上去才亮」的观感补回来。
   * 光标走 `.page.cite-hot` 类（见 style.css）：热点自己不吃事件，
   * 只能让**整页文字**在悬停热点期间变手型。
   */
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
