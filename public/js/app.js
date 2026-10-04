/**
 * 主控（极简版）
 *
 * 交互约定：
 *   译  = 直接翻译选中文字，就地出结果
 *   释  = 直接把选中文字讲明白，就地出结果（不需要提问）
 *   问  = 只把选中文字塞进对话引用，等你自己提问，不发请求
 *   ⎚   = 框选图/表/公式交给视觉模型
 */
import { $, $$, el, appendAll, toast, toastAction, cleanText, renderMarkdown, escapeHtml, debounce, throttle, clamp, fmtSize } from './util.js';
import { iconEl, iconHTML, hasIcon } from './icons.js';
import { PdfViewer, extractPdfText } from './pdfview.js';
import { OPS, COACH, opById, opGroups } from './ops.js';
import {
  Settings, streamChat, testConnection, targetLangFor,
  translateMessages, askMessages, explainMessages, regionMessages,
  digestMessages, webQueryFor, opMessages,
} from './ai.js';

/**
 * 旧版的 `?window=panel&panel=...` 只为系统级子窗口服务，现已彻底停用。
 * 即使用户从旧书签 / 旧子窗口刷新，也必须回到普通阅读器布局，不能再把某一块面板
 * 撑成覆盖整个窗口的“遮挡块”。当前的浮窗唯一入口是主页面内的 #floatLayer 卡片。
 */
const panelWindow = Object.freeze({ enabled: false, id: '' });
let panelBus = null;

function publishPanelMessage(message) {
  try { panelBus?.postMessage(message); } catch { /* 窗口关闭时忽略 */ }
}

/** 两个布尔开关存在 localStorage 里，重启/换论文都保留 */
function readFlag(key, dflt = false) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? dflt : v === '1';
  } catch { return dflt; }
}
function writeFlag(key, on) {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* 忽略 */ }
}

/** AI 区的分块定义。默认一个都不显示，用到哪块就自动出现，也可以手动增删。 */
const AI_BLOCKS = [
  { id: 'translate', title: '译文', hint: '划选正文后点「译」，译文按时间堆在这里' },
  { id: 'chat', title: '问答', hint: '点「释」在这里解释这段；「＋对话」加入选中的文字或截图，然后你自己提问' },
];

/* ══════════════════════════════ 右栏列（译文 / 问答的归属） ══════════════════════════════
   用户口径（2026-10-04）：
     「翻译和问答部分应该只放在右边部分，而且应该是独占右侧一整个栏，就是一栏只能开一个，
       或者可以右键图标选择再开一栏，或者按住图标拖动出一个新窗口。」

   所以右栏是一组**列**，不是「一堆块叠在一起」：
       · 译文 / 问答**只**能在右栏（dock 恒为 'right'）—— 不能被停靠到左栏 / 底部。
         需要暂时展开时，使用阅读器内部卡片，不创建系统级窗口。
     · 一列同时最多渲染**一个**面板（默认第 1 列）。
     · 右键图标「在右侧再开一栏」→ 现建第 2 列，两块可以各占一列并排看。
     · 面板的列归属存在 p.col（1|2）；它声明的列没开或已被占，这个面板就自动收起，
       **不**改归属、也不挤掉别人 —— 这样「右键→放到第 2 栏」的结果永远可预测。
   DOM：#rightCols > #splitRight + #rightSide(.col-1) + [#rightColSplit + #rightCol2(.col-2)]。
   第 2 列只在「列数 = 2」时存在；body.right-col2-off 是窗口放不下时的临时隐藏（不动模型）。 */

/** 只许待在右栏的面板（= PANEL_DEFS 里 dock:'right' 的那两个） */
const isRightPanel = (id) => PANEL_IDS_RIGHT.includes(id);
/** 右栏第 n 列的结果区（第 1 列永远是文档里的 #aiArea；第 2 列现建于 openRightColumn） */
const rightAreaEl = (n) => (n === 2 ? document.getElementById('aiArea2') : document.getElementById('aiArea'));
/** 右栏第 n 列的 <aside>（模型里的列数，不看临时隐藏） */
const rightColEl = (n) => (n === 2 ? document.getElementById('rightCol2') : document.getElementById('rightSide'));
/** 右栏当前请求的列数（1 或 2）—— 用户意图，窗口宽度导致的临时隐藏不算 */
const rightColsWanted = () => (Number(state.panels?.rightCols?.count) === 2 ? 2 : 1);
/** 右栏面板的列归属：非法值一律算第 1 列 */
const colOf = (id) => (Number(state.panels?.[id]?.col) === 2 ? 2 : 1);
/**
 * 隐藏面板的停放区。
 * **故意是脱离文档的**（不 append 到 body）：译文 / 问答的节点永不重建（消息与滚动位置都挂在
 * 节点上），但对外口径仍是「没开就等于没有这一块」—— 挂在文档里的话
 * `document.querySelectorAll('.ai-block')` / `'#aiArea .msg'` 还会查到它，
 * 既有断言与「空态」判断都会被带偏。脱离文档后节点照样活着、状态全在，重新显示时原样挂回去。
 */
let panelParkEl = null;
function panelPark() {
  if (!panelParkEl) panelParkEl = el('div', { id: 'panelPark', 'aria-hidden': 'true' });
  return panelParkEl;
}
/** 面板节点此刻应该在哪个容器里：visible 且列可用 → 结果区；否则 → 停放区 */
function dockedAreaFor(id) {
  const p = state.panels?.[id];
  if (!p || !isRightPanel(id)) return null;
  // 应用内卡片已经在 #floatLayer 中，不能再被右栏重排搬进隐藏停放区。
  if (p.dock === 'float') return null;
  if (!p.visible) return panelPark();
  if (p.dock !== 'right') return panelPark();          // 模型被外部改坏时的兜底
  if (!document.body.classList.contains('no-right')) {
    const n = colOf(id);
    if (n === 1) return rightAreaEl(1);
    if (rightColsWanted() === 2 && rightAreaEl(2)) return rightAreaEl(2);
  }
  return panelPark();
}
/**
 * 右栏面板的滚动位置：**脱离文档时浏览器会把 scrollTop 归零**，所以任何一次「搬走节点」
 * （隐藏 → 停放区、换栏 → 另一列）之前都要先把位置记在节点自己身上，重新挂回文档后再放回去。
 * 挂在节点上而不是共享表里：位置跟着这一块走，先记的不会被后记的覆盖。
 */
function rememberBodyScroll(id) {
  const box = state.blockMeta[id]?.body;
  // 只在**还在文档里**的时候读：节点一旦离开文档，scrollTop 会被浏览器归零，
  // 这时候读到的 0 会把真正的位置覆盖掉（R12 实测踩过：想要 794，存下来的是 0）。
  if (box && box.isConnected && box.clientHeight > 0) box.__prtScrollTop = box.scrollTop;
}
/** 重新挂回文档之后把滚动位置放回去（clientHeight 为 0 时读回也没用，所以要求它排过版） */
function applyBodyScroll(id) {
  const box = state.blockMeta[id]?.body;
  if (box && box.clientHeight > 0 && box.__prtScrollTop > 0) box.scrollTop = box.__prtScrollTop;
}
/** 把节点搬进目标容器（同一个节点，内容与滚动位置都不动）；已经在里面就什么都不做 */
function parkRightPanel(id, target) {
  const node = state.blockEls[id];
  if (!node || !target) return;
  const parked = target === panelPark();
  // 停放态**同时**挂 hidden 属性：节点虽然脱离文档，但样式上也不该有任何显示机会
  //（写 CSS 的隐藏容器也挡不住 position:fixed 之类的历史残留，属性这一层是最后一道保险）。
  if (parked) node.setAttribute('hidden', '');
  else node.removeAttribute('hidden');
  if (node.parentElement === target) return;
  rememberBodyScroll(id);
  withPanelMove([node], () => target.append(node));
  // 同一帧内就把位置补回去：只靠 setPanelVisible 里那个 requestAnimationFrame 太晚 ——
  // 调用方（包括自动化套件）完全可能在下一帧之前就读 scrollTop，读到的会是 0。
  if (!parked) applyBodyScroll(id);
}

/** 读 reader.panels.rightCols（列数 + 第 2 列宽度）；老存档没有这一项时回落 1 列 / 360px */
function loadRightCols() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem('reader.panels') || 'null'); } catch { raw = null; }
  const src = raw && typeof raw === 'object' ? raw.rightCols : null;
  const out = {
    count: Number(src?.count) === 2 ? 2 : 1,
    w2: Number.isFinite(Number(src?.w2)) && Number(src.w2) > 0 ? Math.round(Number(src.w2)) : 360,
  };
  state.panels = state.panels || {};
  state.panels.rightCols = out;
  return out;
}
/** 列状态变化后写盘：列数 / 第 2 栏宽度都在 state.panels.rightCols 里，savePanels 一次写完 */

/** 把列数落到 DOM：够 = 现建第 2 列（含把手）；不够 = 现收（节点搬回停放区，模型不动） */
function applyRightColsDom() {
  const wrap = document.getElementById('rightCols');
  if (!wrap) return;
  const want2 = rightColsWanted() === 2;
  let split = document.getElementById('rightColSplit');
  let col2 = document.getElementById('rightCol2');
  if (want2 && (!split || !col2)) {
    if (!split) {
      split = el('div', { class: 'splitter', id: 'rightColSplit', title: '拖动调整第 2 栏宽度' });
      wrap.append(split);
      bindSplitter(split, '--right-w2', 240, 720, 200);
    }
    if (!col2) {
      col2 = el('aside', { class: 'side right col-2', id: 'rightCol2', dataset: { col: '2' } },
        el('div', { class: 'ai', id: 'aiArea2' }),
        // 第 2 栏底部的切换器：与第 1 栏同构、但只反映**第 2 栏**的状态
        el('div', { class: 'aibar', id: 'aiBar2', role: 'tablist', 'aria-label': '第 2 栏面板切换' }),
      );
      wrap.append(col2);
      renderAiBar();
    }
  }
  // 显示 / 隐藏**无条件**同步一次：`col2.hidden` 是「用户要不要第 2 栏」的唯一 DOM 开关，
  // 只在建/删分支里写它是不够的 —— 「先收起（hidden=true，DOM 留着）→ 再点放到第 2 栏」
  // 这条路上根本没有建/删分支可走，栏就会一直藏着（R12 实测复现：点了「放到第 2 栏」没反应）。
  if (col2) col2.hidden = !want2;
  if (split) split.hidden = !want2;
  if (!want2 && col2) {
    // 收栏：第 2 栏里的节点搬回停放区（模型里的 col 归属保留，下次开栏还在那一栏）
    for (const id of PANEL_IDS_RIGHT) if (colOf(id) === 2 && state.blockEls[id]?.parentElement === rightAreaEl(2)) parkRightPanel(id, panelPark());
  }
  // 第 2 栏宽度的来源：模型（拖动松手写入）
  document.documentElement.style.setProperty('--right-w2', `${state.panels.rightCols?.w2 || 360}px`);
  syncPanelDock();
}

/** 用户明确要「再开一栏」：列数置 2（面板 null 时只开一栏空列，用户随后右键选面板） */
function openRightColumn() {
  if (rightColsWanted() === 2) return false;
  state.panels.rightCols = { ...(state.panels.rightCols || {}), count: 2 };
  // 第 2 栏是用户明确打开的布局意图；窄窗下它会暂时不可见，但仍必须立刻写盘，
  // 否则 applyResponsiveLayout() 结束后只剩内存里的 count=2，刷新就会退回一栏。
  savePanels();
  applyRightColsDom();
  // 开了空列立刻重排：让用户看到「第 2 栏在这儿，往里放个面板」
  renderCols();
  applyResponsiveLayout();
  refitViewer(REFIT_AFTER_MS);
  toast('已再开一栏：右键右栏图标选「放到第 2 栏」，或把图标拖成应用内卡片', 'ok', 4200);
  return true;
}
/** 收起第 2 栏：里面的面板回到「收起」状态（列归属保留，下次开栏还在那一栏） */
function closeRightColumn() {
  if (rightColsWanted() !== 2) return false;
  for (const id of PANEL_IDS_RIGHT) {
    if (colOf(id) === 2 && state.panels[id].visible) setPanelVisible(id, false);
  }
  state.panels.rightCols = { ...(state.panels.rightCols || {}), count: 1 };
  // 只收 DOM，不动模型：栏位归属（p.col）留着，下次「放到第 2 栏」直接回到那一栏
  const col2 = document.getElementById('rightCol2');
  if (col2) {
    for (const id of PANEL_IDS_RIGHT) if (state.blockEls[id]?.parentElement === rightAreaEl(2)) parkRightPanel(id, panelPark());
    col2.hidden = true;
    const split = document.getElementById('rightColSplit');
    if (split) split.hidden = true;
  }
  document.documentElement.style.setProperty('--right-w2', `${state.panels.rightCols?.w2 || 360}px`);
  savePanels();
  syncPanelDock();
  renderCols();
  applyResponsiveLayout();
  refitViewer(REFIT_AFTER_MS);
  return true;
}

/**
 * 把面板放到右栏第 n 栏：n=2 时按需要先把第 2 栏开出来。
 * 同一栏里原来显示着的另一个面板会收起（**一栏只开一个**），这是用户点图标时的既有口径。
 * 返回是否真的改了归属。
 */
function setPanelColumn(id, n) {
  const p = state.panels?.[id];
  const col = Number(n) === 2 ? 2 : 1;
  if (!p || !isRightPanel(id)) return false;
  // 「放到第 2 栏」隐含「第 2 栏要有」：列数还是 1 就先把栏开出来。
  // **这一步必须在下面的早退之前** —— 否则「面板已经归在第 2 栏、但第 2 栏被收起了」这一态
  //（closeRightColumn 之后 panel.col 是保留的）会被早退吃掉，点了没反应（R12 实测复现）。
  if (col === 2 && rightColsWanted() === 1) {
    state.panels.rightCols = { ...(state.panels.rightCols || {}), count: 2 };
    applyRightColsDom();
  }
  if (colOf(id) === col && p.visible) {
    // 归属已经对了：只补一次「栏要开着 + 节点挂到位」，不再动同栏别的面板
    renderCols();
    applyResponsiveLayout();
    fitBlockSizes();
    return true;
  }
  p.col = col;
  p.dock = 'right';
  p.home = 'right';
  p.rect = null;
  p.visible = true;
  // 一栏只开一个：同栏里在显示的那一个收起来
  for (const other of PANEL_IDS_RIGHT) {
    if (other !== id && colOf(other) === col && state.panels[other].visible) setPanelVisible(other, false);
  }
  // 换栏会把节点从一列搬到另一列（脱离文档 → scrollTop 归零），搬之前先记下这一块停在哪
  rememberBodyScroll(id);
  savePanels();
  applyPanels();
  applyResponsiveLayout();
  fitBlockSizes();
  return true;
}

/**
 * 老存档 / 老版本的归位（boot 里跑一次，loadPanels 之后）：
 *   1. 右栏两块曾经能「浮出到应用内浮窗」或「并排再开一栏」（那一版是浮窗）——
 *      现在右栏只有列，历史浮窗一律归位到右栏第 1 栏（可见性保留）。
 *   2. rightCols.count=2 但两个面板都在第 1 栏 → 把后一个挪到第 2 栏，
 *      否则第 2 栏会空着，用户看到的是「开了一栏什么都没有」。
 *   3. 同栏两块都 visible（老存档可能同时开着）→ 保留 order/col 更靠后的那个。
 */
function normalizeRightPanelModel() {
  let changed = false;
  for (const id of PANEL_IDS_RIGHT) {
    const p = state.panels[id];
    if (p.dock === 'float' || p.dock !== 'right') { p.dock = 'right'; changed = p.rect !== null || changed; p.rect = null; }
    if (p.home !== 'right') { p.home = 'right'; changed = true; }
    if (![1, 2].includes(Number(p.col))) { p.col = 1; changed = true; }
  }
  if (rightColsWanted() === 2) {
    const c1 = PANEL_IDS_RIGHT.filter((id) => state.panels[id].visible && colOf(id) === 1);
    if (!PANEL_IDS_RIGHT.some((id) => state.panels[id].visible && colOf(id) === 2) && c1.length > 1) {
      const move = c1.sort((a, b) => state.panels[b].order - state.panels[a].order)[0];
      state.panels[move].col = 2;
      changed = true;
    }
  }
  return changed;
}

/**
 * 老存档里「译文 + 问答同时开着」（2.2b 允许，之后被互斥规则收敛成只留一块）：
 * 新模型下这一态只能靠**两栏**表达，所以开第 2 栏把它们各放一栏。
 * 不这样做的话，进 boot 的归一化时总得把其中一块悄悄隐藏 —— 那是**用户设置被吃掉**。
 * 窗口放不下时由 applyResponsiveLayout 临时收起（模型不动），窗口一变宽两块就都回来。
 */
function adoptLegacyBothBlocks() {
  // 按 order 排（与屏幕上「谁在上面」一致），不是按注册表顺序 ——
  // 否则老存档里 order 更靠前的那块会被塞到第 2 栏，用户看到两块左右调了个个儿。
  const both = PANEL_IDS_RIGHT
    .filter((id) => state.panels[id].visible && state.panels[id].dock === 'right')
    .sort((a, b) => (state.panels[a].order - state.panels[b].order) || (PANEL_IDS.indexOf(a) - PANEL_IDS.indexOf(b)));
  if (both.length < 2 || rightColsWanted() === 2) return false;
  state.panels.rightCols = { ...(state.panels.rightCols || {}), count: 2 };
  for (const [i, id] of both.entries()) state.panels[id].col = i === 0 ? 1 : 2;
  return true;
}

/* ══════════════════════════════ 面板注册表（阶段 2.2a / 2.2b） ══════════════════════════════
   左栏四块（section.sec）与右栏两块（section.ai-block）统一成**一个** state.panels 注册表：
     { id, dock, home, order, visible, collapsed, pinned, size, rect, z, w, docId }
       dock      'left' | 'right' | 'bottom' | 'float' | 'hidden'（'tab' / 中央标签页本阶段不做）
       home      浮出（dock='float'）之前在哪个停靠区 —— 占位块放哪、✕ / Esc 回到哪都看它
       order     同一 dock 内的排序（小的在前）
       visible   用户是否要它显示（'hidden' 等价 visible:false）
       collapsed 只留标题栏
       pinned    用户固定这一侧：窗口放不下时优先收起**没有固定面板**的那一侧（见 applyResponsiveLayout）
       size      右栏块高度 px（左栏 / 底部忽略；null = 自适应平分）
       rect      浮窗位置与大小 {left, top, w, h}（dock==='float' 时有效，每次都会钳进视口）
       z         浮窗层叠序号（点击 / 拖动到最前时自增）
       w         底部停靠时的列宽 px（null = 各列平分）
       docId     浮出时是哪篇论文 —— 换论文时靠它把所有浮窗自动收回停靠
   渲染契约一个字都没改：左栏仍是 section.sec（内部 id 全不动），右栏仍是
   section.ai-block[data-block] + .ai-head / .ai-body / .ai-split，只是两边都补了 data-panel。
   切换永远不重建节点（只改 hidden 类 / DOM 顺序 / 换容器），否则消息与滚动位置会丢。 */

/** 六个面板的固定 id 与默认值：左栏文件/目录/笔记/文献关系，右栏译文/问答 */
const PANEL_DEFS = [
  { id: 'files', title: '文件', dock: 'left' },
  { id: 'outline', title: '目录', dock: 'left' },
  { id: 'notes', title: '笔记', dock: 'left' },
  // 关系整理会在后台准备，但默认只留入口，避免打开论文时把阅读空间铺满。
  // 老用户保存过 reader.panels 的展开状态仍按存档恢复（见 readPanelDescriptor）。
  { id: 'relations', title: '文献关系', dock: 'left', collapsed: true },
  // 右栏两块默认**不显示**：结果区是可选输出，用到哪块自动出现
  //（addEntry / showAiBlock），也能用输入框下面的开关栏或面板管理器打开。
  // 这与 2.2a 之前的状态完全一致（老 state.ai.visible 默认也是 false），
  // 所以「打开论文时右栏一块都不开」这条既有行为没有被这次统一改掉。
  { id: 'translate', title: '译文', dock: 'right', visible: false },
  { id: 'chat', title: '问答', dock: 'right', visible: false },
];
const PANEL_IDS = PANEL_DEFS.map((d) => d.id);
/** 右栏面板 id（顺序与旧 AI_BLOCKS 一致，兼容老 reader.ai 的 order 数组） */
const PANEL_IDS_RIGHT = PANEL_DEFS.filter((d) => d.dock === 'right').map((d) => d.id);
/**
 * 六个面板的默认描述符（每次现算一份新对象，别让调用方改到模板上）。
 * 注意是 function 而不是 const 箭头函数：state = { panels: loadPanels() } 在模块求值时就会跑到
 * 这里，那时 const 还在 TDZ 里，会直接抛 "Cannot access before initialization"。
 */
function defaultPanels() {
  return Object.fromEntries(PANEL_DEFS.map((d, i) => [d.id, {
    id: d.id, dock: d.dock, home: d.dock, order: i, visible: d.visible !== false,
    collapsed: d.collapsed === true, pinned: false, size: null,
    rect: null, z: 0, w: null, docId: '',
    // 右栏面板在第几栏（1|2）；左栏 / 底部面板不用这一项
    col: d.dock === 'right' ? 1 : 0,
  }]));
}

const panelTitle = (id) => (PANEL_DEFS.find((d) => d.id === id) || {}).title || id;
/**
 * 面板根部节点：左栏四块（.side-head / section.sec）与右栏两块（section.ai-block）。
 *
 * **两类面板的节点来源不一样，不能都用文档查询**（阶段 2.2b 的回归就出在这里）：
 *   · 左栏四块是 index.html 里的静态 DOM，用属性选择器在整个文档里找 data-panel 就够；
 *   · 右栏两块（translate / chat）是**按需现建**的：ensureBlock() 建完把它登记在
 *     state.blockEls[id] 上，renderAiArea() 又会在面板隐藏时用 `replaceChildren()` 重排，
 *     把这块节点**从文档里摘下来**（节点本身没丢，state.blockEls 一直持有，内容与滚动都在）。
 * 所以「隐藏着」这一态里 `document.querySelector('[data-panel="chat"]')` 必然返回 null ——
 * 而 applyPanels() 摘 / 挂 `hidden` 类正好走的是这个查询：查询落空 → 类没被同步 → 重新打开
 * 时节点带着上一次的 `hidden` 回到 DOM，高度 0 且再也不会自愈（用户报的正是这个）。
 * 右栏两块一律以 state.blockEls 为唯一登记表，文档查询只服务于左栏。
 */
function panelEl(id) {
  if (PANEL_IDS_RIGHT.includes(id)) return state.blockEls?.[id] || null;
  return document.querySelector(`[data-panel="${id}"]`);
}
/** 收起时还剩标题栏的那个节点（左栏 .sec-head / 右栏 .ai-head / 文件块 .side-head）。
 * 文件面板本身就是 .side-head，不能只用 querySelector 查后代，否则它永远不会绑定拖拽。
 */
const panelHeadEl = (id) => {
  const root = panelEl(id);
  if (!root) return null;
  return root.matches?.('.side-head, .sec-head, .ai-head')
    ? root
    : root.querySelector('.side-head, .sec-head, .ai-head');
};

/** 合法 dock 取值（'tab' / 中央标签页本阶段不做） */
const PANEL_DOCKS = ['left', 'right', 'bottom', 'float', 'hidden'];
/** 能真正装下面板的停靠区（浮窗回停靠 / 管理器「停靠到…」只认这三个） */
const PANEL_DOCKS_REAL = ['left', 'right', 'bottom'];
const DOCK_LABEL = { left: '左栏', right: '右栏', bottom: '底部', float: '浮动', hidden: '隐藏' };

/** 读一个合法矩形：四个数都有限、宽高为正才算数，否则返回 null（调用方回落到默认浮窗位置） */
function readPanelRect(raw) {
  const left = Number(raw?.left);
  const top = Number(raw?.top);
  const w = Number(raw?.w);
  const h = Number(raw?.h);
  if (![left, top, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return { left, top, w, h };
}

/** 读一份合法描述符：非法值全部回落到默认值，宁可用默认值也不能出 NaN / undefined */
function readPanelDescriptor(id, raw, fallback) {
  const dock = PANEL_DOCKS.includes(raw?.dock) ? raw.dock : fallback.dock;
  const size = Number(raw?.size);
  const w = Number(raw?.w);
  const z = Number(raw?.z);
  const home = PANEL_DOCKS_REAL.includes(raw?.home) ? raw.home : (PANEL_DOCKS_REAL.includes(fallback.home) ? fallback.home : 'left');
  return {
    id,
    dock,
    home,
    order: Number.isFinite(raw?.order) ? raw.order : fallback.order,
    visible: typeof raw?.visible === 'boolean' ? raw.visible : fallback.visible,
    collapsed: typeof raw?.collapsed === 'boolean' ? raw.collapsed : fallback.collapsed,
    pinned: typeof raw?.pinned === 'boolean' ? raw.pinned : fallback.pinned,
    size: Number.isFinite(size) && size > 0 ? size : null,
    rect: readPanelRect(raw?.rect) || (dock === 'float' ? defaultFloatRect(id) : null),
    z: Number.isFinite(z) && z >= 0 ? z : 0,
    w: Number.isFinite(w) && w > 0 ? w : null,
    docId: typeof raw?.docId === 'string' ? raw.docId : '',
    // 右栏面板的列归属（1|2）。旧存档没有这个字段 → 第 1 栏。
    col: PANEL_IDS_RIGHT.includes(id) ? (Number(raw?.col) === 2 ? 2 : 1) : 0,
  };
}

/**
 * 一次性迁移：把老的 reader.ai（含按论文分叉的 byDoc）映射成 reader.panels。
 *   新 key 在 → 只读新 key，一行都不改（老 key 原样留着，回退到旧版还能用）。
 *   新 key 不在、老 key 在 → order / visible / size 映射到 translate / chat，
 *   再被 byDoc[当前 docId] 覆盖（如果存在），其余四个用默认值；迁移结果写进新 key。
 *   两个都没有 → 默认值。
 * 关键点：**绝不丢用户拖好的块高度**（reader.ai.size 或 byDoc[...].size 里那个数字）。
 *
 * 时机：boot() 里**第一件事**（在 initPanels / ensurePanel 之前），因为后面所有面板代码都要用
 * state.panels。放在模块顶层求值会太早 —— 那时还拿不到「当前是哪篇论文」，byDoc 覆盖会落空。
 */
function loadPanels() {
  const panels = defaultPanels();
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem('reader.panels') || 'null'); } catch { raw = null; }

  if (raw && typeof raw === 'object') {
    for (const id of PANEL_IDS) panels[id] = readPanelDescriptor(id, raw[id], panels[id]);
    return panels;
  }
  // 新 key 不存在：试着从老的 reader.ai 迁移
  let legacy = null;
  try { legacy = JSON.parse(localStorage.getItem('reader.ai') || 'null'); } catch { legacy = null; }
  if (!legacy || typeof legacy !== 'object') return panels;

  const applyLegacy = (src) => {
    if (!src || typeof src !== 'object') return;
    for (const id of PANEL_IDS_RIGHT) {
      if (typeof src.visible?.[id] === 'boolean') panels[id].visible = src.visible[id];
      const size = Number(src.size?.[id]);
      if (Number.isFinite(size) && size > 0) panels[id].size = size;
    }
    const rightOrder = (Array.isArray(src.order) ? src.order : []).filter((x) => PANEL_IDS_RIGHT.includes(x));
    if (!rightOrder.length) return;
    for (const id of PANEL_IDS_RIGHT) if (!rightOrder.includes(id)) rightOrder.push(id);
    rightOrder.forEach((id, i) => { panels[id].order = 4 + i; });   // 左栏 0..3，右栏接在后面
  };
  applyLegacy(legacy);
  // byDoc 覆盖：docId 优先取 ?open=（可能是 docId，也可能是文件名）、再取左栏列表里的当前项，
  // 都认不出来就留给 applyPanelMigration() 在 boot 后续（拿到服务端 lastDoc 之后）补一次
  const byDoc = legacy.byDoc && typeof legacy.byDoc === 'object' ? legacy.byDoc : null;
  const docId = byDoc ? resolvePanelDocId(byDoc) : '';
  if (docId && byDoc[docId]) applyLegacy(byDoc[docId]);
  else if (byDoc) state._aiMigrated = legacy;
  savePanels(panels);
  return panels;
}

/**
 * 迁移的「第二步」：loadPanels() 跑在 boot 最前面，那时只有 ?open= 一个线索，
 * 真实 docId（形如 slug-xxxxxxxx）往往要等 loadServerState() 回来才知道。
 * 所以迁移时把老 key 记在 state._aiMigrated 上，这里拿到 lastDoc / 当前列表项之后再补一次
 * byDoc 覆盖。**只补一次**，之后用户自己怎么摆就是最终状态。
 * 返回：这次是否真的补上了（调用方据此重排 DOM）。
 */
function applyPanelMigration() {
  const legacy = state._aiMigrated;
  state._aiMigrated = null;
  if (!legacy || !state.panels) return false;
  const byDoc = legacy.byDoc && typeof legacy.byDoc === 'object' ? legacy.byDoc : null;
  const docId = byDoc ? resolvePanelDocId(byDoc) : '';
  const src = docId ? byDoc[docId] : null;
  if (!src || typeof src !== 'object') return false;
  let changed = false;
  for (const panel of PANEL_IDS_RIGHT) {
    const p = state.panels[panel];
    if (typeof src.visible?.[panel] === 'boolean' && p.visible !== src.visible[panel]) {
      p.visible = src.visible[panel];
      changed = true;
    }
    const size = Number(src.size?.[panel]);
    if (Number.isFinite(size) && size > 0 && p.size !== size) { p.size = size; changed = true; }
  }
  const rightOrder = (Array.isArray(src.order) ? src.order : []).filter((x) => PANEL_IDS_RIGHT.includes(x));
  for (const panel of PANEL_IDS_RIGHT) if (!rightOrder.includes(panel)) rightOrder.push(panel);
  if (rightOrder.length) {
    const base = Math.min(...PANEL_IDS_RIGHT.map((panel) => state.panels[panel].order));
    rightOrder.forEach((panel, i) => {
      if (state.panels[panel].order !== base + i) { state.panels[panel].order = base + i; changed = true; }
    });
  }
  if (changed) savePanels();
  return changed;
}

/** 找出 byDoc 里属于「当前这篇论文」的那一条（拿不到就返回空串） */
function resolvePanelDocId(byDoc) {
  const keys = Object.keys(byDoc);
  if (!keys.length) return '';
  let open = '';
  try { open = new URL(location.href).searchParams.get('open') || ''; } catch { /* 忽略 */ }
  const candidates = [
    open,
    serverState.lastDoc || '',
    state.doc?.docId || '',
    $$('#fileList li').find((li) => li.classList.contains('active'))?.dataset.id || '',
  ].filter(Boolean);
  for (const c of candidates) {
    if (byDoc[c]) return c;
    // ?open= 有时给的是文件名：按「去扩展名后的 slug」去配 docId（docId 形如 slug-xxxxxxxx）
    const slug = c.replace(/\.pdf$/i, '').toLowerCase();
    const hit = keys.find((k) => k.toLowerCase().startsWith(`${slug}-`));
    if (hit) return hit;
  }
  return '';
}

/** 写回 reader.panels（整份快照，不再按论文分叉） */
function savePanels(panels = state.panels) {
  // 独立窗口只改自己的面板描述；把变更发回主窗口，不能把「只显示一个面板」的临时快照写回全局。
  if (panelWindow.enabled) {
    const own = panels?.[panelWindow.id];
    if (own) publishPanelMessage({ type: 'panel-patch', id: panelWindow.id, panel: { ...own } });
    return;
  }
  try {
    localStorage.setItem('reader.panels', JSON.stringify(panels));
    publishPanelMessage({ type: 'panels', panels });
  } catch { /* 忽略 */ }
}

function applyPanelPatch(id, raw) {
  if (!PANEL_IDS.includes(id) || !raw || typeof raw !== 'object' || !state.panels?.[id]) return;
  state.panels[id] = { ...state.panels[id], ...raw, id };
  applyPanels();
  if (id === 'translate' || id === 'chat') fitBlockSizes();
}

/* ══════════════════ 面板「暂离」= 正在独立窗口里：唯一状态模型 ══════════════════
   用户口径（2026-10-03，原话）：
     「你现在看到『窗口已经关了，主界面仍然显示在独立窗口状态』……关闭时必须统一执行：
      删除 detached 标记 / 恢复 panel.visible / 恢复原来的 dock、col / 刷新右栏 DOM /
      刷新图标按钮 / 刷新面板管理器。不能只依赖 beforeunload。」

   **状态只有五种，且只有一个真相源**：
     ① 停靠在第 1 栏   ② 停靠在第 2 栏   ③ 隐藏   ④ 独立窗口中
     （① ② ③ 由 state.panels[id].visible + .dock + .col 表达；④ 由 reader.detachedWindows 表达）
   「独立窗口中」与前三者是**互斥**的：只要 detachedWindows 里还有这个 id，面板在主窗口一律不显示。

   关闭路径不允许各改各的 —— ⑤detached → ①/②/③ 的**每一条**路径都必须调用
   releaseDetachedWindow()，由它串起 clearDetachedState → restoreDockState →
   refreshPanelButtons → refreshPanelManager。少调一个就会出现「看起来回来了，
   但按钮仍然显示独立窗口」的半恢复态（这正是用户报的那个 bug）。

   关闭信号的可靠性分层（设计要求，不能只靠一个事件）：
     · 一层：子窗口 pagehide / beforeunload / unload —— 正常关窗、正常刷新
     · 二层：子窗口 BroadcastChannel「我走了」 —— 上面那条没触发时的兜底
     · 三层：子窗口定时心跳 + 主窗口看门狗 —— **窗口被强杀 / 宿主直接销毁 WebView** 时
              pagehide 与 close 消息都不会来，只有心跳会停（Chromium 对隐藏页的定时器
              会限流到约 1/min，所以阈值取 75s，宁可慢一点也不能误判） */
const DETACH_KEY = 'reader.detachedWindows';
function readDetachedWindows() {
  try { return JSON.parse(localStorage.getItem(DETACH_KEY) || '{}') || {}; } catch { return {}; }
}
function writeDetachedWindows(map) {
  try { localStorage.setItem(DETACH_KEY, JSON.stringify(map)); } catch { /* 忽略 */ }
}
function markPanelDetached(id) {
  const m = readDetachedWindows();
  m[id] = Date.now();
  writeDetachedWindows(m);
}
/** 主窗口侧的独立窗口运行时台账（不落盘）：window 引用、心跳时刻、看门狗定时器 */
const detachedRuntime = new Map();
const detachedRt = (id) => {
  let rt = detachedRuntime.get(id);
  if (!rt) { rt = { win: null, lastSeen: 0, timer: 0 }; detachedRuntime.set(id, rt); }
  return rt;
};
/** 子窗口心跳超时阈值。隐藏页的 setInterval 被 Chromium 限流到约 1 次/分钟，留足余量。 */
const DETACH_ALIVE_MS = 75000;

/** 这个面板此刻是不是「暂离」在系统级独立窗口里（= 状态模型里的第 ④ 种）。
 *  **所有** UI 判断（图标坞、底部切换器、面板管理器）都必须问这一个函数，
 *  不许各自去读 localStorage —— 那样就会重现「一处恢复了、另一处还写着独立窗口」。 */
const panelDetached = (id) => !!readDetachedWindows()[id];

/** ④ → ①/②/③ 的唯一出口：把「暂离」标记清干净。
 *  **只清标记与定时器，不动 rt.restore 快照** —— 快照由随后的 restoreDockState() 消费，
 *  顺序反了就会「清完再恢复」，面板回不到原来的栏位。幂等，重复调用无副作用。 */
function clearDetachedState(id) {
  const m = readDetachedWindows();
  const wasDetached = id in m;
  if (wasDetached) { delete m[id]; writeDetachedWindows(m); }
  const rt = detachedRuntime.get(id);
  if (rt?.timer) { clearInterval(rt.timer); rt.timer = 0; }
  return wasDetached;
}

/** 恢复这个面板停靠时的状态。**只在确实处于「暂离」时才动状态**：
    否则用户在独立窗口里把面板设成隐藏、关窗后又被这里强行打开，等于替他做决定。
    返回「有没有真的改过模型」，调用方据此决定要不要落盘。 */
function restoreDockState(id) {
  const rt = detachedRuntime.get(id);
  const snap = rt?.restore;
  if (rt) rt.restore = null;
  const p = state.panels?.[id];
  if (!p) return false;
  let changed = false;
  if (snap) {
    if (snap.visible !== p.visible) { p.visible = snap.visible; changed = true; }
    if (snap.dock && snap.dock !== p.dock) { p.dock = snap.dock; changed = true; }
    if (Number.isFinite(snap.col) && snap.col >= 1 && snap.col <= 2 && Number(snap.col) !== Number(p.col)) { p.col = Number(snap.col); changed = true; }
    if (snap.floatRect && p.dock === 'float') { p.rect = { ...snap.floatRect }; changed = true; }
  }
  // 独立窗口里一定是「不显示」的：如果快照丢了（换过页面 / 存档被外部改过），
  // 这里至少要让它回到看得见的地方，绝不能留下「没有独立窗口但面板还是不可见」的孤儿态。
  if (!p.visible) { p.visible = true; changed = true; }
  if (p.dock === 'hidden') { p.dock = isRightPanel(id) ? 'right' : 'left'; changed = true; }
  return changed;
}

/** 刷「同一类操作的唯一入口」的按钮状态：左栏图标坞 / 右栏每一栏底部的译文·问答切换器 */
function refreshPanelButtons() {
  try { renderAiBar(); } catch { /* 右栏还没装好（boot 早期）时忽略 */ }
  syncPanelDock();
}

/** 管理器是不是「开着」（.closed 是关闭动画的那一帧，也算关着） */
const panelMenuOpen = () => !!panelMenuEl
  && !panelMenuEl.classList.contains('hidden')
  && !panelMenuEl.classList.contains('closed');

/**
 * 面板管理器开着的话重画它，让「显示中 / 独立窗口」立刻跟上（关着就什么都不做）。
 * ⚠️ 必须走 panelMenuOpen()，不能只判 .hidden —— 关闭序列里菜单先是 `.closed`（这一帧隐藏、
 * 下一帧才补 `.hidden`），此时重画会把刚聚焦的元素从 DOM 里换掉、焦点又丢回 <body>。
 */
function refreshPanelManager() {
  if (panelMenuOpen()) renderPanelMenu();
}

/**
 * 「独立窗口没了」的**唯一收敛点** —— 无论消息来自哪一层、无论调几次，
 * 结果都必须是同一个完整状态。返回是否真的恢复了一个「暂离」面板。
 */
function releaseDetachedWindow(id, { via = 'message', silent = false } = {}) {
  const p = state.panels?.[id];
  const wasDetached = clearDetachedState(id);
  // 这条路径必须无条件走完：以前「visible 已经是 true 就整个跳过」正是半恢复态的根因
  const restored = restoreDockState(id);
  const changed = !!(wasDetached || restored);
  if (changed) {
    try { savePanels(); } catch { /* 忽略 */ }
    applyPanels();
  }
  refreshPanelButtons();
  refreshPanelManager();
  const label = panelTitle(id);
  if (p && changed && !silent) {
    toast(
      via === 'watchdog' ? `「${label}」的独立窗口已意外结束，已回到主窗口` : `「${label}」已回到主窗口`,
      via === 'watchdog' ? 'err' : '',
      via === 'watchdog' ? 3200 : 1800,
    );
  }
  return changed;
}

/** 主窗口看到「子窗口已经没了」时调用（心跳超时 / window.closed / 通道说再见都走这里） */
function notePanelWindowGone(id, via) {
  if (panelWindow.enabled) return;
  const rt = detachedRuntime.get(id);
  if (rt) { rt.win = null; clearDetachedState(id); }
  releaseDetachedWindow(id, { via });
}

/** 子窗口心跳：它只要还在，看门狗就不动它。主窗口同时也收得到（同一个频道）。 */
function notePanelWindowAlive(id) {
  detachedRt(id).lastSeen = Date.now();
}

/** 心跳看门狗（只在主窗口跑）：超时就认定那个窗口已经不存在了，把面板收回来 */
function detachWatchdogTick() {
  if (panelWindow.enabled) return;
  const now = Date.now();
  for (const id of Object.keys(readDetachedWindows())) {
    if (!PANEL_IDS.includes(id)) continue;
    const rt = detachedRt(id);
    // 浏览器版拿得到 window 引用，window.closed 是最快最准的判据（桌面壳一律是 null）
    if (rt.win && rt.win.closed) { notePanelWindowGone(id, 'closed'); continue; }
    if (rt.lastSeen && now - rt.lastSeen > DETACH_ALIVE_MS) {
      const stillOpen = !!(rt.win && !rt.win.closed);
      if (!stillOpen) { notePanelWindowGone(id, 'watchdog'); continue; }
      rt.lastSeen = now;   // 引用还在：只续命，不动状态
    }
  }
}

/* 看门狗从脚本加载起就跑（不是从 initPanelSync 起）—— 只在主窗口装。
   放这里而不是 boot 里：boot 是个 async IIFE，「独立窗口被强杀」完全可能发生在
   它跑完之前，晚装就可能错过一整轮。 */
const detachWatchdogTimer = panelWindow.enabled ? 0 : setInterval(detachWatchdogTick, 5000);

/** boot 时清账（只在主窗口跑）：子窗口不会跨进程存活，残留标记一律恢复显示并落盘。 */
function reconcileDetachedPanels() {  const m = readDetachedWindows();
  const ids = Object.keys(m).filter((id) => PANEL_IDS.includes(id));
  if (!ids.length) {
    // 非面板的脏键一并清掉，别让存档里越攒越多
    if (Object.keys(m).length) writeDetachedWindows({});
    return false;
  }
  for (const id of ids) {
    const p = state.panels?.[id];
    if (!p) continue;
    if (!p.visible) p.visible = true;
    if (p.dock === 'hidden') p.dock = isRightPanel(id) ? 'right' : 'left';
  }
  writeDetachedWindows({});
  return true;
}

/** 主窗口和系统级面板窗口共用同一份布局；窗口关闭后监听器随页面一起释放。 */
function handlePanelMessage(message) {
  if (!message || typeof message !== 'object') return;
  // 子窗口加载完成后会报到：桌面壳自己建 Tao 窗口时 window.open 必然返回 null，
  // 靠这条消息才能区分「真的被系统拦了」和「窗口其实已经开了」。
  if (message.type === 'panel-window-open') {
    if (!panelWindow.enabled) {
      state._panelWinSeen = state._panelWinSeen || {};
      state._panelWinSeen[message.id] = performance.now();
      notePanelWindowAlive(message.id);
    }
    return;
  }
  // 子窗口还活着：刷新心跳时刻（看门狗据此判断它有没有被强杀）
  if (message.type === 'panel-window-heartbeat') {
    if (!panelWindow.enabled) notePanelWindowAlive(message.id);
    return;
  }
  // 子窗口关闭：④ → ①/②/③ 走**唯一**收敛点（无条件刷新按钮与管理器）
  if (message.type === 'panel-window-close') {
    if (!panelWindow.enabled) releaseDetachedWindow(message.id, { via: message.via || 'message' });
    return;
  }
  if (message.type === 'panel-patch') {
    if (!panelWindow.enabled) {
      applyPanelPatch(message.id, message.panel);
      try { localStorage.setItem('reader.panels', JSON.stringify(state.panels)); } catch { /* 忽略 */ }
    } else if (message.id === panelWindow.id) {
      applyPanelPatch(message.id, message.panel);
    }
    return;
  }
  if (message.type !== 'panels' || !message.panels || typeof message.panels !== 'object') return;
  if (panelWindow.enabled) {
    applyPanelPatch(panelWindow.id, message.panels[panelWindow.id]);
  }
}

/**
 * 桌面壳在独立窗口被销毁时直接调用（Rust 侧 CloseRequested → evaluate_script）。
 * 子页面的 pagehide / beforeunload 在宿主直接销毁 WebView 时不保证触发，这条是
 * 「关掉窗口，面板一定回来」的兜底；releaseDetachedWindow 自身幂等，三条路都走到也不会重复。
 */
if (!panelWindow.enabled) {
  window.__prtPanelWindowClosed = (id) => {
    clearDetachedState(id);                                  // 宿主说它没了，先摘掉运行时台账
    releaseDetachedWindow(id, { via: 'host' });
  };
}

function initPanelSync() {
  try {
    panelBus = new BroadcastChannel('prt-panel-sync-v1');
    panelBus.addEventListener('message', (e) => handlePanelMessage(e.data));
  } catch { panelBus = null; }
  window.addEventListener('storage', (e) => {
    if (e.key !== 'reader.panels' || !e.newValue) return;
    try {
      const panels = JSON.parse(e.newValue);
      if (panelWindow.enabled) applyPanelPatch(panelWindow.id, panels?.[panelWindow.id]);
      else if (panels && typeof panels === 'object') {
        // 右栏列数与第 2 栏宽度也要跟着走（另一个窗口改了列数，这边得现建 / 现收）
        const rc = panels.rightCols;
        if (rc && typeof rc === 'object') {
          const count = Number(rc.count) === 2 ? 2 : 1;
          const w2 = Number.isFinite(Number(rc.w2)) && Number(rc.w2) > 0 ? Math.round(Number(rc.w2)) : 360;
          if (state.panels && (state.panels.rightCols?.count !== count || state.panels.rightCols?.w2 !== w2)) {
            state.panels.rightCols = { count, w2 };
            applyRightColsDom();
          }
        }
        for (const id of PANEL_IDS) applyPanelPatch(id, panels[id]);
      }
    } catch { /* 忽略损坏的旧存档 */ }
  });
  // 面板窗口（子窗口）侧的关闭信号：三层一起发，任何一层到达主窗口都够。
  // 为什么不能只靠一个事件：宿主（Tao/wry）直接销毁 WebView 时 pagehide / beforeunload
  // 都不保证触发（见 window.rs 的 CloseRequested 注释），所以还有下面这套心跳：
  //   · pagehide / beforeunload / unload —— 正常关窗、正常刷新
  //   · BroadcastChannel 说再见 —— 主窗口据此把面板收回去（幂等，重复发没关系）
  //   · 定时心跳 —— 窗口被强杀时上面两条都不会来，只有心跳会停，主窗口的看门狗兜底
  if (panelWindow.enabled) {
    const announce = () => {
      publishPanelMessage({ type: 'panel-window-open', id: panelWindow.id });
      publishPanelMessage({ type: 'panel-window-heartbeat', id: panelWindow.id });
    };
    const beat = () => publishPanelMessage({ type: 'panel-window-heartbeat', id: panelWindow.id });
    announce();
    window.addEventListener('load', announce);
    window.addEventListener('focus', beat);
    window.addEventListener('visibilitychange', () => { if (!document.hidden) beat(); });
    window.addEventListener('pagehide', () => panelWindowGoodbye('pagehide'));
    window.addEventListener('beforeunload', () => panelWindowGoodbye('beforeunload'));
    window.addEventListener('unload', () => panelWindowGoodbye('unload'));
    // 4s 一次：隐藏页会被限流到约 1/min，主窗口的阈值（75s）给足了余量
    setInterval(beat, 4000);
  }
}

/** 同一 dock 内按 order 排好的面板 id（order 相同时按注册表顺序，稳定排序） */
const panelsOfDock = (dock) => PANEL_IDS
  .filter((id) => state.panels[id].dock === dock)
  .sort((a, b) => (state.panels[a].order - state.panels[b].order) || (PANEL_IDS.indexOf(a) - PANEL_IDS.indexOf(b)));
const visiblePanelsOfDock = (dock) => (state.panels ? panelsOfDock(dock).filter((id) => state.panels[id].visible) : []);

/** 当前浮出（dock==='float'）的面板；传 home 就只挑「从这一侧浮出去的」 */
const floatPanels = (home) => PANEL_IDS.filter((id) => state.panels?.[id]?.dock === 'float' && (!home || state.panels[id].home === home));
/** 右栏「在右栏里 + 从右栏浮出去的」全部面板（输入框下面那排开关要用它，浮出不该让开关消失） */
const rightPanelsAll = () => PANEL_IDS
  .filter((id) => state.panels[id].dock === 'right' || (state.panels[id].dock === 'float' && state.panels[id].home === 'right'))
  .sort((a, b) => (state.panels[a].order - state.panels[b].order) || (PANEL_IDS.indexOf(a) - PANEL_IDS.indexOf(b)));

/**
 * 一个停靠区里要渲染的东西，按 order 排好：
 *   { kind:'panel', id }   —— 面板本体
 *   { kind:'slot', id }    —— 从这一侧浮出去的面板留下的占位块
 * 浮出面板的 order 不参与 panelsOfDock(dock)，但它原来站的位置要由占位块顶上，
 * 所以这里把两类合起来按 order 排（回停靠时占位块正好被面板本体换回来）。
 * 注意：这里**只算不建**，占位块由各停靠区的重排循环 ensurePanelSlot() 现取，
 * 免得在别的地方（比如管理器）调用它时凭空造出一堆没人挂上去的占位块。
 */
function dockItems(dock) {
  const items = [];
  for (const id of PANEL_IDS) {
    const p = state.panels[id];
    const at = p.dock === 'float' ? p.home : p.dock;
    if (at !== dock) continue;
    items.push({ kind: p.dock === 'float' ? 'slot' : 'panel', id, order: p.order });
  }
  items.sort((a, b) => (a.order - b.order) || (PANEL_IDS.indexOf(a.id) - PANEL_IDS.indexOf(b.id)));
  return items;
}

/** 面板管理器里行的顺序：左栏 → 底部 → 右栏（浮出的排进它 home 那一区），与屏幕上的三个停靠区一致 */
function panelMenuIds() {
  const out = [];
  for (const dock of ['left', 'bottom', 'right']) for (const item of dockItems(dock)) out.push(item.id);
  for (const id of PANEL_IDS) if (!out.includes(id)) out.push(id);   // 兜底：dock='hidden' 之类
  return out;
}

/** 右栏当前显示的面板签名（列数 / 可见集合变了才重排右栏，见 applyPanels 的 ④b） */
const rightPanelsSig = () => `${rightColsWanted()}|${PANEL_IDS_RIGHT.map((id) => `${id}#${colOf(id)}${state.panels[id].visible ? '1' : '0'}`).join(',')}`;

/**
 * 把注册表刷到 DOM 上（阶段 2.2b 起五件事，顺序不能换）：
 *   ① 每个面板 root 补 data-panel / data-dock，visible / collapsed 落类；
 *   ② **先**把浮出的面板搬进 #floatLayer —— 右栏的 renderAiArea() 会 replaceChildren，
 *      还留在 #aiArea 里的浮窗会被它摘掉，所以浮出的必须先搬走；
 *   ③ 占位块：还给浮着可见的面板留 .panel-slot，其余淡出；
 *   ④ 左栏 / 右栏 / 底部三个停靠区各自按 order 重排（占位块也算在顺序里）；
 *   ⑤ 顶栏 ▤ 的小圆点。
 * 右栏只在「显示集合 / 浮出集合真的变了」时才走 renderAiArea()。
 * 搬节点永远走 withPanelMove()：滚动位置、焦点、输入内容一个都不丢。
 */
function applyPanels() {
  for (const id of PANEL_IDS) {
    const p = state.panels[id];
    const node = panelEl(id);
    if (!node) continue;
    node.dataset.panel = id;
    node.dataset.dock = p.dock;
    const panelHidden = !p.visible || p.dock === 'hidden';
    node.classList.toggle('hidden', panelHidden);
    // 文件面板的拖入区/文件列表是它的兄弟节点：只藏标题栏会留下半截侧栏
    if (id === 'files') for (const part of panelParts('files')) part.classList.toggle('hidden', panelHidden);
    node.classList.toggle('panel-collapsed', p.collapsed);
    if (p.collapsed) node.setAttribute('data-collapsed', '');
    else node.removeAttribute('data-collapsed');
    const head = panelHeadEl(id);
    if (head) head.setAttribute('aria-expanded', String(!p.collapsed));
    syncPanelActions(id);
    // 已经不在浮动状态了：把浮窗留下的定位样式与类清干净（安全网，正常路径在 dockPanelTo 里已清）。
    // 节点还赖在 #floatLayer 里的（比如 resetPanels 把它变成「不可见的右栏面板」，右栏那次重排
    // 就不会再认领它）也要搬回它自己的停靠容器去，不许留在浮层里。
    if (p.dock !== 'float') {
      const box = floatBoxOf(id);
      if (box) {
        clearFloatStyle(box);
        if (box.parentElement === floatLayer()) {
          // 右栏两块的「家」是它自己那一列的结果区（不是无脑 #aiArea）
          const home = PANEL_IDS_RIGHT.includes(id) ? dockedAreaFor(id) : $('#leftSide');
          const parts = panelParts(id);
          if (home && parts.length) withPanelMove(parts, () => { for (const part of parts) home.append(part); });
        }
      }
    }
  }

  // 右栏两块的节点去向（结果区 ↔ 停放区）永远由这一条统管 —— 绝不重建节点。
  // 顺手把「一栏只开一个」这条硬不变量**在这里强制一遍**：任何路径（旧存档、跨窗口补丁、
  // 拖拽排序、我们自己漏调 setPanelVisible）把两块留在同一栏时，都只保留 order 靠前的那块。
  // 放在渲染之前，所以「模型里有几块可见」和「屏幕上真有几块」永远一致。
  enforceOnePerColumn();
  for (const id of PANEL_IDS_RIGHT) parkRightPanel(id, dockedAreaFor(id));

  syncPanelDock();
  // 左栏活动栏的高亮跟着「此刻真正显示的是哪一块」走（一次只开一个 → 高亮唯一）
  try { syncRailActive(); } catch { /* 活动栏还没装好（boot 早期）时忽略 */ }
  // 左栏没有任何可见面板时，不保留一整块只有背景色的空栏；活动栏仍作为入口。
  // 浮出去的面板不算左栏可见内容，它的占位只服务于回停靠，不应阻止左栏收起。
  document.body.classList.toggle(
    'left-empty',
    !panelWindow.enabled && visiblePanelsOfDock('left').length === 0,
  );
  /**
   * 右栏同理（用户实测 2026-10-04）：「右边侧栏的下面两个都关闭的时候还会有一个问答的口」。
   * 译文与问答都关掉以后，右栏会变成一条只剩切换器的空栏，看起来像个没有归属的输入框。
   * 现在两块都不显示时把右栏收成右侧活动栏（图标仍在，点一下就能把栏拉回来），
   * 与左栏的 left-empty 完全对称。
   */
  document.body.classList.toggle(
    'right-empty',
    !panelWindow.enabled && visiblePanelsOfDock('right').length === 0,
  );

  // ② 浮出的面板先搬进浮层（见函数头注释：必须在 renderAiArea 之前）
  for (const id of floatPanels()) applyFloatRect(id);

  // ③ 占位块：浮着且可见的留下，其余淡出
  syncPanelSlots(floatPanels().filter((id) => state.panels[id].visible));

  // ④a 左栏按 order 重排（隐藏的也一起排，顺序里保留它的位置；浮出的位置由占位块顶上）。
  // 搬的是同一批节点，所以走 withPanelMove：滚动位置 / 焦点 / 输入内容一个都不丢
  //（面板头常常是**当前有焦点**的节点，被搬走时浏览器会 blur 它，搬完必须 focus 回去，
  //  否则「按一次 Alt+↑ 之后键盘就不响应了」）。
  const leftEl = $('#leftSide');
  if (leftEl) {
    // 占位块先解析成元素（ensurePanelSlot 会建），后面两处都用同一个节点，别建出两个来
    const items = dockItems('left').map((item) => (item.kind === 'slot' ? { ...item, node: ensurePanelSlot(item.id, 'left') } : item));
    const parts = items.flatMap((item) => (item.kind === 'slot' ? [item.node] : panelParts(item.id)));
    for (const id of PANEL_IDS) if (state.panels[id].dock === 'hidden') parts.push(...panelParts(id));
    if (parts.length) {
      withPanelMove(parts, () => {
        for (const item of items) {
          if (item.kind === 'slot') { leftEl.append(item.node); continue; }
          for (const part of panelParts(item.id)) leftEl.append(part);
        }
        // dock='hidden' 的面板（等价 visible:false）节点收进左栏待着：display:none 不占地方，
        // 又不会被底部停靠区的重排连带删掉（重新显示时它还在文档里）
        for (const id of PANEL_IDS) {
          if (state.panels[id].dock !== 'hidden') continue;
          for (const part of panelParts(id)) leftEl.append(part);
        }
      });
    }
  }

  // 底部图标坞永远贴在左栏最底：④a 的重排只认面板节点，普通子节点会被顶到别处
  const dockEl = $('#panelDock');
  if (dockEl && dockEl.parentElement) dockEl.parentElement.append(dockEl);

  // ④b 右栏：列结构 + 每列的块序列（见「右栏列」一节）。
  // 这里**无条件**走一遍 renderCols()：renderCol() 内部对「已经是对的那块」有短路，
  // 真正的 replaceChildren 只在换块 / 变空态时发生，所以不会把消息和滚动位置洗掉。
  // （曾经按「可见集合签名」跳过一次重排，结果隐藏的那块虽然停了车、却还留在结果区的 DOM 里。）
  state._aiVisibleSig = rightPanelsSig();
  renderCols();

  // ④c 底部停靠区：横向排布；没有面板停靠到底部时整块（含高度把手）收起，零占用
  applyBottomDock();

  // 多节点面板（文件）搬回左栏后可能留下空壳，扫一遍清掉
  for (const shell of $$('.panel-shell')) if (!shell.children.length) shell.remove();

  // ⑤ 有面板被隐藏时给顶栏 ▤ 挂个点，否则用户看不出「还有东西藏着」
  $('#panelBtn')?.classList.toggle('has-hidden', PANEL_IDS.some((id) => !state.panels[id].visible));
}

/**
 * 底部停靠区：每个面板一个 .panel-col 列（列宽 = p.w，没存过就各列平分），
 * 相邻两列之间插一条 .dock-vsplit 宽度把手。空的时候整块 display:none —— 默认零占用。
 * 格子与把手都按 data 属性复用（不重建），只有顺序真的变了才重排一次。
 */
function applyBottomDock() {
  const dock = dockBottomEl();
  if (!dock) return;
  const items = dockItems('bottom');
  const wanted = [];
  let prevId = '';
  for (const item of items) {
    if (item.kind === 'slot') { wanted.push(ensurePanelSlot(item.id, 'bottom')); prevId = ''; continue; }
    if (prevId) wanted.push(ensureDockSplit(prevId, item.id));
    wanted.push(ensureDockCell(item.id));
    prevId = item.id;
  }
  const same = dock.children.length === wanted.length && wanted.every((n, i) => dock.children[i] === n);
  if (!same) {
    const parts = items.filter((x) => x.kind === 'panel').flatMap((x) => panelParts(x.id));
    withPanelMove(parts, () => dock.replaceChildren(...wanted));
  }
  applyPanelWidths();
  const empty = items.length === 0;
  dock.classList.toggle('hidden', empty);
  $('#dockBottomSplit')?.classList.toggle('hidden', empty);
  if (empty && $('#dockPreview')?.dataset.zone === 'bottom') hideDockPreview();
}

/** 底部一列的 .panel-col：同一个面板永远复用同一个格子（部件搬进去 = 移动，不重建） */
function ensureDockCell(id) {
  let cell = document.querySelector(`.dock-bottom > .panel-col[data-col="${id}"]`);
  if (!cell) cell = el('div', { class: 'panel-col', dataset: { col: id } });
  const parts = panelParts(id);
  if (parts.some((part) => part.parentElement !== cell)) {
    withPanelMove(parts, () => { for (const part of parts) cell.append(part); });
  }
  return cell;
}

/** 相邻两列之间的宽度把手（同一个组合复用同一条） */
function ensureDockSplit(a, b) {
  const key = `${a}|${b}`;
  let node = document.querySelector(`.dock-bottom > .dock-vsplit[data-split="${key}"]`);
  if (!node) {
    node = bindDockColumnSplit(a, b);
    node.dataset.split = key;
  }
  return node;
}

/** 右栏里浮出面板的占位块：右栏两块现在只走「列」，不会浮出 → 这里只处理历史遗留的浮窗 */
function renderRightSlots() {
  const area = $('#aiArea');
  if (!area) return;
  const ids = floatPanels('right').filter((id) => state.panels[id].visible && colOf(id) === 1);
  for (const id of ids) {
    const slot = ensurePanelSlot(id, 'right');
    const anchor = [...area.querySelectorAll('.ai-block')]
      .find((b) => state.panels[b.dataset.block]?.order > state.panels[id].order);
    area.insertBefore(slot, anchor || null);
  }
}

function togglePanelCollapsed(id) {
  const p = state.panels[id];
  p.collapsed = !p.collapsed;
  savePanels();
  applyPanels();
  // 折叠只是显示/隐藏，右栏块高度要重新夹一次（否则折叠那个块的高度还占着）
  if (p.dock === 'right') fitBlockSizes();
}

/**
 * 显示 / 隐藏一个面板。
 *
 * 隐藏**绝不清 size**：那是用户拖出来的高度偏好，关掉再打开必须回到原来那个高度
 *（阶段 2.2b 之前这里写着 `p.size = null`，等于每收展一次就把用户拖好的高度丢掉，
 *  再打开只能看到平分或 60px 保底）。真的装不下时由 fitBlockSizes() 按比例夹取，
 * 而不是把记忆扔掉。
 *
 * 隐藏是 display:none，滚动容器量不到高度、scrollTop 会归零，所以先把每块 body 的
 * 滚动位置记下来，重新显示之后再放回去 —— 用户看到的就是「隐藏再显示，位置还在」。
 */
function setPanelVisible(id, on) {
  const p = state.panels[id];
  if (!p) return;
  const wasVisible = p.visible;
  p.visible = !!on;
  // 隐藏浮窗 = 先把它收回原来的停靠区（再藏），免得「藏起来又浮着」这种自相矛盾的状态；
  // 反过来，重新显示一个 dock='hidden' 的面板时也让它回到自己的停靠区。
  // 右栏两块永远不浮出（它们只有「第 1 / 第 2 栏」），所以这一类判断跳过它们。
  if (isRightPanel(id)) {
    if (p.dock !== 'right') { p.dock = 'right'; p.home = 'right'; p.rect = null; }
  } else if (!on && p.dock === 'float') { p.dock = p.home || 'left'; p.rect = null; }
  if (!isRightPanel(id) && on && p.dock === 'hidden') { p.dock = p.home || 'left'; }
  // 同一栏一次只放一块：显示译文 / 问答时，把**同一栏**里那一块（还在右栏里的）收起来。
  // 另一栏不动 —— 第 2 栏就是给「两块同时看」用的。
  if (on && isRightPanel(id) && p.dock === 'right') {
    const col = colOf(id);
    for (const other of PANEL_IDS_RIGHT) {
      if (other === id) continue;
      if (colOf(other) !== col) continue;
      if (state.panels[other].dock === 'right' && state.panels[other].visible) state.panels[other].visible = false;
    }
  }
  // 左栏同理，而且更严：**整个左栏一次只显示一块**（用户口径 2026-10-03）：
  //   「左侧应该也做成一次只能打开一个」
  // 以前四块是竖着堆叠、互不影响的，结果「文件 + 目录 + 笔记 + 文献关系」能一起摊开，
  // 左栏被塞满、下面几块其实已经被挤出视口。现在的规则是：打开哪一块，其余三块自动收起，
  // 但**块自己的折叠状态（p.collapsed）不动** —— 那是另一回事，不该被这次切换改掉。
  if (on && !isRightPanel(id) && p.dock === 'left') {
    for (const other of PANEL_IDS) {
      if (other === id || isRightPanel(other)) continue;
      if (state.panels[other].dock === 'left' && state.panels[other].visible) state.panels[other].visible = false;
    }
  }
  // 自动打开一个右栏面板 = 用户明确要这一侧，别让它被自动收起（2.1 的临时豁免）
  if (on && p.dock === 'right') sideIntent.pinned.right = true;
  // 隐藏之前先把滚动位置记下来 —— **必须在 applyPanels() 之前**：
  // applyPanels 会把节点停进脱离文档的停放区，那之后 scrollTop 已经是 0 了。
  if (!on && wasVisible) rememberBlockScroll();
  savePanels();
  applyPanels();
  applyResponsiveLayout();
  if (on && !wasVisible) restoreBlockScroll();
}

/**
 * 记住右栏每块 .ai-body 的滚动位置（隐藏之前调）。
 *
 * 位置记在**节点自己身上**（`__prtScrollTop`），不是记在一个「最近一次」的共享表里：
 * 右栏面板隐藏时节点会脱离文档，而脱离文档的元素 `scrollTop` 会被浏览器归零 ——
 * 等到「显示」那一步再去读，读到的永远是 0（R12 实测：隐藏前后 1167 → 0）。
 * 挂在节点上还顺带解决了顺序问题：先记的位置不会被后记的覆盖。
 */
function rememberBlockScroll() {
  for (const id of PANEL_IDS_RIGHT) rememberBodyScroll(id);
}

/** 把记住的滚动位置放回去（重新显示之后调；同一帧的同步补位在 parkRightPanel / renderCol 里） */
function restoreBlockScroll() {
  requestAnimationFrame(() => {
    for (const id of PANEL_IDS_RIGHT) applyBodyScroll(id);
  });
}

/** 固定 / 取消固定：只影响「窗口放不下时先收哪一侧」，不影响用户手动收起 */
function setPanelPinned(id, on) {
  const p = state.panels[id];
  if (!p) return;
  p.pinned = !!on;
  savePanels();
  applyResponsiveLayout();
}

/**
 * 直接设一个面板的显示 / 隐藏并立刻刷 UI（管理器按钮、面板头的 Alt+H、截图自动开「问答」
 * 走的都是 setPanelVisible；resetPanels 之外的批量预置也用它，避免只改模型不刷界面）。
 * 与 setPanelVisible 同一个口径：隐藏**不动 size**（那是用户拖出来的高度偏好）。
 */
function setPanelsVisible(ids, on) {
  const anyVisible = ids.some((id) => state.panels[id]?.visible);
  if (!on && anyVisible) rememberBlockScroll();
  for (const id of ids) {
    const p = state.panels[id];
    if (!p) continue;
    p.visible = !!on;
  }
  savePanels();
  applyPanels();
  applyResponsiveLayout();
  if (on) restoreBlockScroll();
}

/** 同 dock 内上移 / 下移一位（到边界就什么都不做） */
function movePanel(id, dir) {
  const p = state.panels[id];
  if (!p || p.dock === 'hidden') return;
  const list = panelsOfDock(p.dock);
  const i = list.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const other = list[j];
  const tmp = p.order;
  p.order = state.panels[other].order;
  state.panels[other].order = tmp;
  savePanels();
  applyPanels();
}

/* ══════════════════════════════ 阶段 2.2b：停靠 / 应用内浮动 / 动效 ══════════════════════════════
   三件事，一条铁律：**搬的是同一批 DOM 节点**，绝不重建。
     · dock='bottom' 的面板搬进 .viewer-wrap 里 #viewer 之后、.statusbar 之前的 #dockBottom；
     · dock='float'  的面板搬进 body > #floatLayer，自己 position:fixed + left/top/width/height；
     · 浮出的面板在原停靠区留一个 .panel-slot 占位块，拖回左 / 右 / 底部时先出停靠预览，
       松手用 FLIP 平滑收缩回去。
   搬动前后必须保全：滚动位置 / 焦点 / #chatInput 内容与光标 / 消息条数（见 withPanelMove）。
   动效一律 100–260ms 的短 ease-out，可被下一次拖动或停靠打断（cancelPanelAnims），
   prefers-reduced-motion: reduce 时全部关掉（motionMs 返回 0）。 */

const FLOAT_MIN_W = 260;      // 浮窗最小宽（用户要求的 260×180）
const FLOAT_MIN_H = 180;
const FLOAT_GAP = 6;          // 浮窗与视口边缘 / 顶栏之间至少留这么多
const FLOAT_DEFAULT_W = 340;
const FLOAT_DEFAULT_H = 300;
const DOCK_BOTTOM_MIN_H = 90;
/** 各条动效的时长（ms）——都在用户要求的 100–260ms 区间内 */
const ANIM = { lift: 120, slot: 160, preview: 120, flip: 200, close: 160, settle: 140 };
const EASE = 'cubic-bezier(.2,.7,.3,1)';   // 短 ease-out，不做弹跳、不做长缓动

/** 用户要求减少动态效果吗（读不到就当 false；测试里可以用 page.emulateMediaFeatures 切） */
function prefersReducedMotion() {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}
const motionMs = (ms) => (prefersReducedMotion() ? 0 : ms);

/** 正在跑的浮窗动画句柄：新拖动 / 新停靠一开始就全部 cancel（动画必须能被下一次操作打断） */
const panelAnims = new Set();
function cancelPanelAnims() {
  for (const a of panelAnims) { try { a.cancel(); } catch { /* 忽略 */ } }
  panelAnims.clear();
}

/**
 * 记一条动效日志并返回**实际时长**（reduced-motion 下是 0）。
 * 日志是给自动化探针看的原始证据：每条动效的时长 / 缓动都能逐条核对。
 */
function logPanelAnim(kind, ms) {
  const dur = motionMs(ms);
  if (state._panelAnimLog) {
    state._panelAnimLog.push({ kind, ms: dur, easing: EASE, at: Math.round(performance.now()) });
    while (state._panelAnimLog.length > 80) state._panelAnimLog.shift();
  }
  return dur;
}

/** 跑一条 WAAPI 动效（时长 0 或没有 animate 时什么都不做）；句柄记下来供打断 */
function panelAnim(node, frames, { kind = 'anim', ms = ANIM.flip, easing = EASE } = {}) {
  const dur = logPanelAnim(kind, ms);
  if (!node?.animate || dur <= 0) return null;
  let a = null;
  try { a = node.animate(frames, { duration: dur, easing, fill: 'none' }); } catch { return null; }
  panelAnims.add(a);
  a.finished.then(() => panelAnims.delete(a), () => panelAnims.delete(a));
  return a;
}

/* ── DOM 定位：浮层 / 底部停靠区 / 面板部件 ── */

const floatLayer = () => document.getElementById('floatLayer');
const dockBottomEl = () => document.getElementById('dockBottom');

/**
 * 一个面板由哪些节点组成。五个面板就是它自己；**文件面板是三兄弟**
 *（.side-head 标题栏 + .dropzone 拖入区 + .filelist 文件列表，内部 id 一个都没动）。
 * 移动时三兄弟要一起走，否则浮出去的文件面板只剩一个筛选框。
 * 右栏两块是**按需建**的（用到才 ensureBlock）：管理器直接点「浮出」时这里先把节点建出来，
 * 否则浮出会静默失败（DOM 里根本没有那个面板）。
 */
function panelParts(id) {
  let node = panelEl(id);
  if (!node && PANEL_IDS_RIGHT.includes(id)) {
    ensureBlock(id);
    node = panelEl(id);
  }
  if (!node) return [];
  if (id !== 'files') return [node];
  return [node, $('#dropzone'), $('#fileList')].filter(Boolean);
}

/** 多节点面板（文件）需要一个 .panel-shell 把三兄弟装在一起；单节点面板直接用自己 */
function panelShell(id) {
  const parts = panelParts(id);
  if (parts.length <= 1) return parts[0] || null;
  let shell = document.querySelector(`.panel-shell[data-shell="${id}"]`);
  if (!shell) shell = el('div', { class: 'panel-shell', dataset: { shell: id } });
  for (const part of parts) if (part.parentElement !== shell) shell.append(part);
  return shell;
}

/** 当前真正带着 .panel-float（position:fixed）的那个盒子；没浮出就返回 null */
const floatBoxOf = (id) => document.querySelector(
  `#floatLayer > .panel-float[data-panel="${id}"], #floatLayer > .panel-float[data-shell="${id}"]`,
);

/** 停靠状态下代表这个面板的盒子（文件面板是 shell，其余是节点自己） */
function dockedBody(id) {
  const parts = panelParts(id);
  if (parts.length <= 1) return parts[0] || null;
  return document.querySelector(`.panel-shell[data-shell="${id}"]`) || parts[0];
}

/** 清掉浮窗留下的一切（类 + inline 定位），回停靠 / 隐藏时都要走一遍 */
function clearFloatStyle(box) {
  if (!box) return;
  box.classList.remove('panel-float', 'dragging', 'focused');
  box.style.left = ''; box.style.top = ''; box.style.width = ''; box.style.height = ''; box.style.zIndex = '';
}

/* ── 几何：钳进视口 + 避开顶栏与 #composer ── */

const rectOf = (node) => {
  const r = node?.getBoundingClientRect?.();
  return r && (r.width > 0 || r.height > 0) ? { left: r.left, top: r.top, w: r.width, h: r.height } : null;
};
/**
 * 浮窗的「CSS 矩形」：位置读 inline left/top，宽高读模型。
 * 拖动刚结束时面板身上还有 120ms 的 scale(1.01) 在回落，getBoundingClientRect() 会量到放大的值，
 * 拿它当起点 / 存盘会把浮窗越拖越大（实测 320 → 323），所以浮窗一律走这一条。
 */
function floatCssRect(id) {
  const p = state.panels[id];
  const box = floatBoxOf(id);
  if (!p || !box) return null;
  const w = p.rect?.w || FLOAT_DEFAULT_W;
  const h = p.rect?.h || FLOAT_DEFAULT_H;
  const left = parseFloat(box.style.left);
  const top = parseFloat(box.style.top);
  return {
    left: Number.isFinite(left) ? left : (p.rect?.left ?? 0),
    top: Number.isFinite(top) ? top : (p.rect?.top ?? 0),
    w, h,
  };
}
/** 一组节点的外接矩形（文件面板三兄弟要合成一个盒子来算） */
function unionRect(nodes) {
  const rs = nodes.map(rectOf).filter(Boolean);
  if (!rs.length) return null;
  const left = Math.min(...rs.map((r) => r.left));
  const top = Math.min(...rs.map((r) => r.top));
  const right = Math.max(...rs.map((r) => r.left + r.w));
  const bottom = Math.max(...rs.map((r) => r.top + r.h));
  return { left, top, w: right - left, h: bottom - top };
}
const visibleRect = (nodes) => unionRect(nodes);

/** 可以让浮窗待的区域：顶栏以下、视口以内 */
function floatSafeBox() {
  const main = $('#main');
  const top = Math.round(main?.getBoundingClientRect().top || 46);
  return { left: 0, top, right: window.innerWidth, bottom: window.innerHeight };
}
/** #composer 的矩形；收起右栏 / 没有输入框时返回 null（这时不需要避让） */
function composerRect() {
  const node = $('#composer');
  if (!node) return null;
  const r = node.getBoundingClientRect();
  return r.width > 2 && r.height > 2 ? r : null;
}
const rectsOverlap = (a, b) => a.left < b.right && a.left + a.w > b.left && a.top < b.bottom && a.top + a.h > b.top;
const overlapArea = (a, b) => {
  const w = Math.min(a.left + a.w, b.left + b.w) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.h, b.top + b.h) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
};

/**
 * 把浮窗矩形钳进视口：最小 260×180，最大不超过视口；
 * 且**不许盖住 #composer**（输入框被浮窗挡住就没法提问了）。
 * 避让顺序：先挪到输入框左边，再挪到上边，再挪到下边；都放不下就挑重叠最小的那个。
 * （钳制思路沿用 placeCard/clampCard —— 拖到 4000,4000 会被拉回屏幕里。）
 */
function clampFloatRect(raw, { w, h } = {}) {
  const box = floatSafeBox();
  const maxW = Math.max(FLOAT_MIN_W, box.right - box.left - FLOAT_GAP * 2);
  const maxH = Math.max(FLOAT_MIN_H, box.bottom - box.top - FLOAT_GAP * 2);
  const W = Math.round(clamp(Number(w) || FLOAT_DEFAULT_W, FLOAT_MIN_W, maxW));
  const H = Math.round(clamp(Number(h) || FLOAT_DEFAULT_H, FLOAT_MIN_H, maxH));
  const put = (left, top) => ({
    left: Math.round(clamp(left, box.left + FLOAT_GAP, Math.max(box.left + FLOAT_GAP, box.right - W - FLOAT_GAP))),
    top: Math.round(clamp(top, box.top + FLOAT_GAP, Math.max(box.top + FLOAT_GAP, box.bottom - H - FLOAT_GAP))),
    w: W, h: H,
  });
  const want = put(Number(raw?.left) || box.left + FLOAT_GAP, Number(raw?.top) || box.top + FLOAT_GAP);
  const comp = composerRect();
  if (!comp || !rectsOverlap(want, comp)) return want;
  const candidates = [
    put(comp.left - W - FLOAT_GAP, want.top),                                   // 输入框左边
    put(want.left, comp.top - H - FLOAT_GAP),                                   // 输入框上边
    put(want.left, comp.bottom + FLOAT_GAP),                                    // 输入框下边
    put(comp.left - W - FLOAT_GAP, box.top + FLOAT_GAP),
  ];
  const clean = candidates.find((c) => !rectsOverlap(c, comp));
  if (clean) return clean;
  return candidates.reduce((best, c) => (overlapArea(c, comp) < overlapArea(best, comp) ? c : best), want);
}

/** 浮窗的默认位置与大小（按面板在注册表里的次序错开一点，别叠成一摞） */
function defaultFloatRect(id) {
  const i = Math.max(0, PANEL_IDS.indexOf(id));
  return clampFloatRect(
    { left: 90 + i * 26, top: 90 + i * 22 },
    { w: FLOAT_DEFAULT_W, h: FLOAT_DEFAULT_H },
  );
}

/* ── 浮出 / 回停靠 / 收起 ── */

/** 把注册表里的 rect 写到浮窗的 inline 样式上（每次都重新钳一遍：窗口变小也不会跑到屏幕外） */
function applyFloatRect(id) {
  const p = state.panels[id];
  const parts = panelParts(id);
  if (!p || !parts.length) return null;
  const box = parts.length === 1 ? parts[0] : panelShell(id);
  if (!box) return null;
  const layer = floatLayer();
  box.classList.add('panel-float');
  // 搬进浮层（已经在里面就别再 append，免得把兄弟浮窗的层叠顺序洗牌）
  if (layer && box.parentElement !== layer) withPanelMove(parts, () => layer.append(box));
  const prev = p.rect || defaultFloatRect(id);
  const r = clampFloatRect(prev, { w: prev.w, h: prev.h });
  p.rect = r;
  box.style.left = `${r.left}px`;
  box.style.top = `${r.top}px`;
  box.style.width = `${r.w}px`;
  box.style.height = `${r.h}px`;
  box.style.zIndex = String(Math.max(1, Math.round(p.z) || 1));
  // 右栏两块是按需建的：initPanels() 跑的时候它们还不存在，拖动绑定要在这儿补一次
  bindFloatDrag(id);
  ensureFloatChrome(id, box);
  return r;
}

/**
 * 浮窗的缩放抓手：**四条边 + 四个角共 8 个**（用户口径 2026-10-04：
 *   「窗口要做成左右上下都能直接拉伸而且也可以在角落直接拉伸的样子」）。
 *
 * 原来只有右下角一个 `.panel-resize`。现在按方向生成 `n / s / e / w / ne / nw / se / sw`，
 * 每个用 CSS 定位到对应的边或角（见 style.css 的 .panel-grip 一族）。
 * 停靠状态下这些抓手由 CSS `display:none` 隐藏，不参与布局；只加一次。
 */
const FLOAT_GRIPS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
function ensureFloatChrome(id, box) {
  if (!box || box.querySelector(':scope > .panel-grip')) return;
  for (const dir of FLOAT_GRIPS) {
    const grip = el('div', {
      class: `panel-grip panel-grip-${dir}`, 'aria-hidden': 'true',
      title: '拖动调整浮窗大小（最小 260×180）',
    });
    box.append(grip);
    bindFloatResize(id, grip, dir);
  }
}

/** 当前最靠前的浮窗 z（新浮出的排到最后面之上） */
function nextFloatZ() {
  const zs = floatPanels().map((id) => Number(state.panels[id].z) || 0);
  return (zs.length ? Math.max(...zs) : 0) + 1;
}

/** 浮窗获得焦点时保持原底色与不透明度，只切换边框 / 外圈。 */
function syncFloatFocus(id) {
  for (const fid of floatPanels()) {
    floatBoxOf(fid)?.classList.toggle('focused', fid === id);
  }
}

/** 点 / 拖一个浮窗 = 把它提到最前（#floatLayer 内部自增，不动别的层） */
function bringFloatToFront(id) {
  const p = state.panels[id];
  if (!p || p.dock !== 'float') return;
  syncFloatFocus(id);
  const top = Math.max(0, ...floatPanels().map((x) => Number(state.panels[x].z) || 0));
  if ((Number(p.z) || 0) >= top && top > 0) return;
  p.z = nextFloatZ();
  const box = floatBoxOf(id);
  if (box) box.style.zIndex = String(p.z);
  savePanels();
}

/** 浮出：把面板从停靠区搬进 #floatLayer（同一个 DOM 节点），原停靠区留 .panel-slot */
function floatPanel(id, { rect = null } = {}) {
  const p = state.panels[id];
  if (!p) return false;
  if (p.dock === 'float') { bringFloatToFront(id); return true; }
  cancelPanelAnims();
  const parts = panelParts(id);
  const before = visibleRect(parts);
  const wasVisible = p.visible;
  // 面板马上要离开这个容器了：先记住它当前的滚动位置（内容一变矮就会被夹小）
  rememberAwayScroll(dockContainerFor(PANEL_DOCKS_REAL.includes(p.dock) ? p.dock : p.home));
  p.home = PANEL_DOCKS_REAL.includes(p.dock) ? p.dock : (p.home || 'left');
  p.dock = 'float';
  p.visible = true;
  p.docId = state.doc?.docId || p.docId || '';   // 论文绑定：换论文时靠它把浮窗收回停靠
  p.z = nextFloatZ();
  const seed = rect || (before ? { left: before.left, top: before.top } : null);
  const size = {
    w: Math.max(FLOAT_MIN_W, Math.round(rect?.w || before?.w || FLOAT_DEFAULT_W)),
    h: Math.max(FLOAT_MIN_H, Math.round(rect?.h || before?.h || FLOAT_DEFAULT_H)),
  };
  p.rect = clampFloatRect(seed || defaultFloatRect(id), size);
  withPanelMove(parts, () => { savePanels(); applyPanels(); });
  const box = floatBoxOf(id);
  const after = rectOf(box);
  flipPanel(before, after ? { ...after, node: box } : null, 'float-out', ANIM.flip);
  syncFloatFocus(id);
  // 右侧 AI 面板浮出后，右侧栏只留下活动入口，不再同时占着正文宽度。
  // 回栏时 dockPanelTo('right') 会明确展开它；浮窗停在普通位置时不会自动恢复右栏。
  if (isRightPanel(id)) {
    sideIntent.noRight = true;
    sideIntent.pinned.right = false;
  }
  // 浮出可能把某一侧栏空出来：重算一次布局（正文宽度 / 自动收起）
  if (applyResponsiveLayout()) refitViewer(0); else refitViewer(REFIT_AFTER_MS);
  if (isRightPanel(id)) saveUi();
  if (!wasVisible) toast(`「${panelTitle(id)}」已浮出`, '', 1600);
  return true;
}

/**
 * 回停靠 / 换停靠区（左 / 右 / 底部）：FLIP —— 先记起点矩形，搬完 DOM 再从起点动画到终点（≤220ms）。
 * 拖到目标区松手、管理器的「停靠到…」、Esc、✕ 收起走的都是这一条。
 */
function dockPanelTo(id, zone) {
  const p = state.panels[id];
  if (!p || !PANEL_DOCKS_REAL.includes(zone) || p.dock === zone) return false;
  // 译文 / 问答固定在右栏（用户口径）：不许停靠到左栏 / 底部。
  // 右栏面板仍然不能停到左栏 / 底部；卡片只是阅读器内部的临时展开方式。
  if (isRightPanel(id) && zone !== 'right') return false;
  // R7：把停靠目标区被浮窗盖住的那部分先让开。
  // 起因：视觉验收里「笔记」浮窗没收回就停靠底部，结果浮窗压在新停靠的面板上，
  // 面板标题/摘要/按钮都被遮掉半截，看起来像面板被从中间切断。
  // 只收「真的和目标区矩形相交」的浮窗 —— 不搞一刀切把全部浮窗都收了，
  // 免得用户觉得「我只是停靠一个面板，怎么别的浮窗也没了」。
  clearFloatsCovering(dockContainerFor(zone), id);
  const parts = panelParts(id);
  const wasFloat = p.dock === 'float';
  const before = wasFloat ? floatCssRect(id) : visibleRect(parts);
  cancelPanelAnims();
  const box = wasFloat ? floatBoxOf(id) : null;
  if (box) clearFloatStyle(box);
  resetBlockHeight(id);                 // 离开右栏时把 fitBlockSizes() 写死的 inline 高度清掉
  p.home = zone;
  p.dock = zone;
  p.rect = null;
  p.visible = true;
  if (zone === 'bottom' && !(p.w > 0)) p.w = 280;
  // 停靠到右栏 = 用户明确要这一侧，别让它被自动收起（与 setPanelVisible 同一个口径）
  if (zone === 'right') sideIntent.pinned.right = true;
  withPanelMove(parts, () => { savePanels(); applyPanels(); });
  // 回到停靠区之后：把「离开时那个容器停在哪儿」补回去（占位块收掉之后容器高度才定下来，
  // 所以同步补一次、下一帧补一次、FLIP 走完再补一次）
  const dest = dockContainerFor(zone);
  const restoreAway = () => applyAwayScroll(dest);
  restoreAway();
  requestAnimationFrame(restoreAway);
  setTimeout(restoreAway, ANIM.flip + 60);
  const after = rectOf(dockedBody(id));
  flipPanel(before, after ? { ...after, node: dockedBody(id) } : null, 'dock-flip', ANIM.flip);
  // 目标那一侧本来是收起的话，用户这次「拖过去」就是要它显示出来
  if ((zone === 'left' || zone === 'right') && document.body.classList.contains(`no-${zone}`)) setSideCollapsed(zone, false, true);
  else applyResponsiveLayout();
  if (zone === 'right') fitBlockSizes();
  refitViewer(REFIT_AFTER_MS);
  return true;
}

/** 把 fitBlockSizes() 写在块上的 inline 高度清掉（它只认「还停在右栏的块」） */
function resetBlockHeight(id) {
  const node = panelEl(id);
  if (!node) return;
  node.classList.remove('sized');
  node.style.height = '';
}

/** FLIP：把 after.node 从 before 那个矩形「收缩 / 展开」到它现在的位置 */
function flipPanel(before, after, kind, ms = ANIM.flip) {
  if (!before || !after?.node || after.w <= 1 || after.h <= 1) return null;
  const dx = before.left - after.left;
  const dy = before.top - after.top;
  const sx = before.w > 1 ? before.w / after.w : 1;
  const sy = before.h > 1 ? before.h / after.h : 1;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < .01 && Math.abs(sy - 1) < .01) return null;
  return panelAnim(after.node, [
    { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, transformOrigin: 'top left' },
    { transform: 'none', transformOrigin: 'top left' },
  ], { kind, ms });
}

/** 拖到无效区域松手：保持浮动，把位置平滑地钳回视口里 */
function settleFloat(id) {
  const p = state.panels[id];
  const box = floatBoxOf(id);
  if (!p || !box) return;
  const from = floatCssRect(id);
  const r = clampFloatRect(from || p.rect || defaultFloatRect(id), { w: from?.w, h: from?.h });
  p.rect = r;
  savePanels();
  if (from && (Math.abs(from.left - r.left) > 1 || Math.abs(from.top - r.top) > 1)) {
    panelAnim(box, [
      { left: `${from.left}px`, top: `${from.top}px` },
      { left: `${r.left}px`, top: `${r.top}px` },
    ], { kind: 'settle', ms: ANIM.settle });
  }
  box.style.left = `${r.left}px`;
  box.style.top = `${r.top}px`;
  box.style.width = `${r.w}px`;
  box.style.height = `${r.h}px`;
}

/**
 * 浮窗头上的 ✕：先朝**最近的那条屏幕边缘**平滑收起（160ms），收起动画结束后再回原停靠区。
 * 不做「突然消失」——用户能看见它「收」到边上去。
 */
function closeFloatPanel(id) {
  const p = state.panels[id];
  const box = floatBoxOf(id);
  if (!p || p.dock !== 'float' || !box) return false;
  cancelPanelAnims();
  const r = floatCssRect(id) || rectOf(box);
  const target = nearestEdgeRect(r);
  const done = () => {
    // 收起动画期间用户又拖起来了 / 已经回停靠了：那就别再动它
    if (floatDragId === id || state.panels[id]?.dock !== 'float') return;
    dockPanelTo(id, state.panels[id].home || 'left');
  };
  const a = panelAnim(box, [
    { left: `${r.left}px`, top: `${r.top}px`, opacity: 1 },
    { left: `${target.left}px`, top: `${target.top}px`, opacity: 0 },
  ], { kind: 'close', ms: ANIM.close });
  if (a) a.finished.then(done, done); else done();
  return true;
}

/** 离浮窗最近的那条边（左 / 右 / 上 / 下），以及「贴上去」的位置 */
function nearestEdgeRect(r) {
  if (!r) return { left: 0, top: 0 };
  const box = floatSafeBox();
  const dist = {
    left: r.left - box.left,
    right: box.right - (r.left + r.w),
    top: r.top - box.top,
    bottom: box.bottom - (r.top + r.h),
  };
  const edge = Object.keys(dist).reduce((a, b) => (dist[b] < dist[a] ? b : a), 'left');
  return {
    left: edge === 'left' ? box.left + FLOAT_GAP : (edge === 'right' ? box.right - r.w - FLOAT_GAP : r.left),
    top: edge === 'top' ? box.top + FLOAT_GAP : (edge === 'bottom' ? box.bottom - r.h - FLOAT_GAP : r.top),
  };
}

/** 窗口变小 / 变窄时把所有浮窗重新钳进视口（绝不出现「跑到屏幕外拿不回来」） */
function clampAllFloats() {
  let n = 0;
  for (const id of floatPanels()) { applyFloatRect(id); n += 1; }
  if (n) savePanels();
  return n;
}

/**
 * 换论文：把所有浮窗收回它们原来的停靠区。
 * 判据是 docId —— 同一篇论文重新打开（刷新 / 重进）时浮窗保持原样，
 * 换成**另一篇**才收回，免得浮在屏幕上的面板显示的却是上一篇的内容。
 * 返回收回的个数（探针与报表用得到）。
 */
function redockFloatsForDoc(docId) {
  const ids = floatPanels();
  if (!ids.length) return 0;
  const tgt = docId || '';
  let moved = 0;
  for (const id of ids) {
    const p = state.panels[id];
    if (!p.docId) { p.docId = tgt; continue; }        // 浮出时还没开论文：认领当前这篇，别乱收
    if (tgt && p.docId !== tgt) { dockPanelTo(id, p.home || 'left'); moved += 1; }
  }
  if (moved) savePanels();
  return moved;
}
/** 手动「全部收回停靠」（面板管理器 / 探针用） */
function redockFloats() {
  let n = 0;
  for (const id of floatPanels()) if (dockPanelTo(id, state.panels[id].home || 'left')) n += 1;
  return n;
}

/**
 * R7：把「和容器矩形相交」的浮窗收回各自的 home 停靠区，返回收回的个数。
 * 供 dockPanelTo() 在停靠前调用：目标停靠区若被浮窗压着，先让开再停靠。
 * 目标区还没布局出来（宽高为 0）时不动手，避免误判。
 *
 * ⚠️ `exclude` 是**必须**的，不是可选优化：调用方 dockPanelTo() 此刻自己还是浮窗
 * （`p.dock` 要到函数后半段才改成 zone），而它自己的卡片常常正好压在目标停靠区上
 * （左栏面板的卡片就停在左栏旁边，必然相交）。不排除自己的话：
 *   dockPanelTo(A) → clearFloatsCovering(左栏) → 看到 A 的卡片相交 → dockPanelTo(A) → …
 * 无限互相递归，**栈溢出（Maximum call stack size exceeded）**，卡片永远收不回去。
 * 实测事故：左栏四块（文件/目录/笔记/文献关系）浮出为卡片后点 ✕ 全部收不回，
 * 控制台报 `at dockPanelTo ← at clearFloatsCovering ← at dockPanelTo …`。
 */
function clearFloatsCovering(container, exclude = '') {
  const target = container?.getBoundingClientRect?.();
  if (!target || target.width < 1 || target.height < 1) return 0;
  const overlaps = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
  let moved = 0;
  for (const fid of floatPanels()) {
    if (fid === exclude) continue;                          // 正在停靠的那一块：别让它递归调用自己
    const node = panelEl(fid) || state.blockEls[fid];
    const rect = node?.getBoundingClientRect?.();
    if (rect && overlaps(rect, target) && dockPanelTo(fid, state.panels[fid].home || 'left')) moved += 1;
  }
  return moved;
}

/* ── 原位置占位块 ── */

function ensurePanelSlot(id, dock) {
  document.querySelector(`.panel-slot[data-slot="${id}"][data-dying]`)?.remove();
  let slot = document.querySelector(`.panel-slot[data-slot="${id}"]`);
  if (!slot) {
    slot = el('div', { class: 'panel-slot', dataset: { slot: id, dock }, 'aria-hidden': 'true' },
      el('span', { text: `「${panelTitle(id)}」会回到这里` }));
    panelAnim(slot, [{ opacity: 0, transform: 'scale(.98)' }, { opacity: .55, transform: 'none' }], { kind: 'slot-in', ms: ANIM.slot });
  }
  slot.dataset.dock = dock;
  return slot;
}

function removePanelSlot(slot) {
  if (!slot || slot.dataset.dying) return;
  slot.dataset.dying = '1';
  const done = () => {
    const host = slot.parentElement;
    slot.remove();
    // 占位块一消失，它上面的内容就变矮了，浏览器的「滚动锚定」会把容器 scrollTop 往下带
    //（实测左栏直接归零）。强制一次布局把账算清，再把「离开时停在哪」补回去。
    void host?.scrollHeight;
    applyAwayScroll(host);
    requestAnimationFrame(() => applyAwayScroll(host));
  };
  const a = panelAnim(slot, [{ opacity: .55 }, { opacity: 0, transform: 'scale(.98)' }], { kind: 'slot-out', ms: ANIM.slot });
  if (a) a.finished.then(done, done);
  else done();
}

/** 只有「还浮着且可见」的面板才留占位块，其余统统淡出 */
function syncPanelSlots(keepIds) {
  for (const slot of $$('.panel-slot')) {
    if (slot.dataset.dying) continue;
    if (keepIds.includes(slot.dataset.slot)) continue;
    removePanelSlot(slot);
  }
}

/* ── 拖动时的停靠预览 ── */

/** 兼容旧探针：浮窗现在只认最右边缘，不再认左栏 / 底部 / 普通右栏。 */
function dockZoneAt(x, y) {
  const box = floatSafeBox();
  return y >= box.top - 2 && x >= window.innerWidth - FLOAT_REDOCK_RIGHT_PX ? 'right' : '';
}

// 只有最后这 18px 的「贴边区」会触发回栏；浮窗在左侧、底部或普通右侧都只会停留在原位。
const FLOAT_REDOCK_RIGHT_PX = 18;
function floatRedockTarget(id, x, y) {
  const box = floatSafeBox();
  if (y < box.top - 2 || x < window.innerWidth - FLOAT_REDOCK_RIGHT_PX) return '';
  if (isRightPanel(id)) return 'right';
  const home = state.panels[id]?.home;
  return PANEL_DOCKS_REAL.includes(home) ? home : 'left';
}

/** 预览框该画在哪（收起的一侧画在活动栏上；底部没有停靠区时画一条底部横带） */
function dockZoneRect(zone) {
  if (zone === 'left' || zone === 'right') {
    const collapsed = document.body.classList.contains(`no-${zone}`);
    const node = collapsed ? $(zone === 'left' ? '#railLeft' : '#railRight') : $(zone === 'left' ? '#leftSide' : '#rightSide');
    const r = node?.getBoundingClientRect();
    return r && r.width > 2 ? { left: r.left, top: r.top, w: r.width, h: r.height } : null;
  }
  if (zone === 'bottom') {
    const wrap = $('.viewer-wrap')?.getBoundingClientRect();
    if (!wrap) return null;
    const dock = dockBottomEl();
    const shown = dock && !dock.classList.contains('hidden');
    const h = shown ? dock.getBoundingClientRect().height : Math.min(240, Math.max(120, Math.round(wrap.height * .34)));
    return { left: wrap.left, top: wrap.bottom - h, w: wrap.width, h };
  }
  return null;
}

function showDockPreview(zone) {
  const box = $('#dockPreview');
  if (!box) return;
  const r = dockZoneRect(zone);
  if (!zone || !r) { hideDockPreview(); return; }
  if (box.classList.contains('hidden')) {
    box.classList.remove('hidden');
    panelAnim(box, [{ opacity: 0 }, { opacity: .55 }], { kind: 'preview-in', ms: ANIM.preview });
  }
  box.dataset.zone = zone;
  box.style.left = `${Math.round(r.left)}px`;
  box.style.top = `${Math.round(r.top)}px`;
  box.style.width = `${Math.round(r.w)}px`;
  box.style.height = `${Math.round(r.h)}px`;
}

function hideDockPreview() {
  const box = $('#dockPreview');
  if (!box) return;
  box.dataset.zone = '';
  box.classList.add('hidden');
}

/* ── 不丢状态：搬节点前后保存 / 恢复滚动位置、焦点、输入内容 ── */

/**
 * 搬的是同一批 DOM 节点，所以这里可以直接用**元素引用**记住 scrollTop ——
 * 不需要任何选择器（跨容器搬家时选择器最容易失配）。
 * 记两类滚动容器：① 节点自己与后代（.ai-body / .outline / .rel-list …）；
 * ② 节点往上的祖先（左栏 #leftSide 是整栏滚动的那一层）。
 * 面板**浮出去**时容器会变矮、scrollTop 被浏览器夹小，那一路由 rememberAwayScroll()/
 * applyAwayScroll() 单独负责（只在 float → dock 这一个来回里生效，见那边的注释）。
 * 一并记下：焦点元素（搬走带焦点的节点会被浏览器 blur 掉，键盘就废了）、
 * #chatInput 的内容与光标位置、消息条数（给探针留证据）。
 */
function capturePanelMove(nodes) {
  const scrolls = [];
  const seen = new Set();
  const keep = (n) => {
    if (!n || seen.has(n)) return;
    seen.add(n);
    // 右栏的 .ai-body 有一个「离开文档时也不能丢」的位置（__prtScrollTop，见 rememberBodyScroll）：
    // 节点一旦脱离文档，n.scrollTop 已经是 0，照抄它就会把真正的位置覆盖成 0 —— 换栏时实测就丢在这儿。
    const top = n.__prtScrollTop > 0 ? n.__prtScrollTop : n.scrollTop;
    scrolls.push([n, top]);
  };
  const walk = (n) => { keep(n); for (const child of n.children) walk(child); };
  for (const n of nodes) {
    walk(n);
    for (let up = n.parentElement; up && up !== document.body; up = up.parentElement) keep(up);
  }
  const active = document.activeElement;
  const input = $('#chatInput');
  return {
    scrolls,
    active: active && active !== document.body && nodes.some((n) => n.contains(active)) ? active : null,
    input: input ? { value: input.value, start: input.selectionStart, end: input.selectionEnd } : null,
    msgCount: document.querySelectorAll('#aiArea .msg').length,
  };
}

/**
 * 「面板离开时那个停靠容器的滚动位置」。
 * 面板一浮出去，容器内容就变矮，浏览器会把 scrollTop 夹小（常常直接归零）；
 * 等它回停靠时再想恢复就已经没数了，所以离开前先记一笔，回来时补上。
 * 只在 float → dock 这一个来回里用，**不参与别的搬动** ——
 * 否则一个陈旧的记忆值会盖掉用户自己刚滚到的位置（踩过）。
 * 补的时候只往下推（`< away` 才动）：记忆值只可能被浏览器夹小，不会自己变小。
 */
function dockContainerFor(dock) {
  if (dock === 'right') return $('#aiArea');
  if (dock === 'bottom') return dockBottomEl();
  return $('#leftSide');
}
function rememberAwayScroll(container) {
  if (!container) return;
  state._awayScroll = state._awayScroll || new Map();
  if (container.scrollHeight > container.clientHeight) state._awayScroll.set(container, container.scrollTop);
}
function applyAwayScroll(container) {
  const away = state._awayScroll?.get(container);
  if (container && away != null && container.scrollTop < away) container.scrollTop = away;
}

function restorePanelMove(snap) {
  if (!snap) return;
  /** 把记下来的滚动位置放回去；返回「是不是已经全部对上了」 */
  const putScrolls = () => {
    let all = true;
    for (const [node, top] of snap.scrolls) {
      if (!node.isConnected) continue;
      if (node.scrollTop !== top) node.scrollTop = top;
      if (node.scrollTop !== top) all = false;    // 放不下时浏览器会夹住，这一趟没对上
    }
    return all;
  };
  const put = () => {
    putScrolls();
    if (snap.active && snap.active.isConnected && document.activeElement !== snap.active) {
      snap.active.focus?.({ preventScroll: true });
    }
    const input = $('#chatInput');
    if (input && snap.input && input.value !== snap.input.value) {
      input.value = snap.input.value;
      try { input.setSelectionRange(snap.input.start, snap.input.end); } catch { /* 忽略 */ }
    }
  };
  put();
  /**
   * 搬完之后容器/内容的高度还会继续变（FLIP 200ms、占位块 160ms 后收掉、字体与公式渲染、
   * 图片解码…），高度一变，刚才被夹住的滚动位置就又放得回去了；浏览器自己的
   * 「滚动锚定」也会在随后的布局里把 scrollTop 往下带（实测 2236 → 2019）。
   * 所以每帧补一次，最多盯 40 帧（≈0.7s）：**用户一碰页面就停**（按下 / 滚轮 / 按键），
   * 保证不会跟用户自己之后的滚动较劲。
   * 只补滚动：焦点与输入内容在第一趟就恢复了，不能被后面的帧反复覆盖。
   */
  let stopped = false;
  const stop = () => { stopped = true; };
  const opts = { once: true, capture: true, passive: true };
  document.addEventListener('pointerdown', stop, opts);
  document.addEventListener('wheel', stop, opts);
  document.addEventListener('keydown', stop, { once: true, capture: true });
  let frames = 0;
  const tick = () => {
    if (stopped) return;
    for (const [node, top] of snap.scrolls) {
      if (node.isConnected && node.scrollTop < top) node.scrollTop = top;
    }
    frames += 1;
    if (frames < 40) requestAnimationFrame(tick);
    else {
      document.removeEventListener('pointerdown', stop, opts);
      document.removeEventListener('wheel', stop, opts);
      document.removeEventListener('keydown', stop, opts);
    }
  };
  requestAnimationFrame(tick);
  setTimeout(putScrolls, ANIM.flip + 60);
}

function withPanelMove(nodes, fn) {
  const snap = capturePanelMove(nodes);
  fn();
  restorePanelMove(snap);
  return snap;
}

/* ── 浮窗的拖动 / 缩放 ── */

let floatDragId = '';        // 当前正在拖的浮窗（同一时刻只会有一个）

/**
 * 浮窗拖动：手感与 makeDraggable 一致 ——
 *   指针捕获、5px 阈值（没走够就当点击，面板头里的按钮照常能用）、
 *   拖动期间给个 120ms 的轻微抬升（更大阴影 + scale(1.01)）。
 * 松手：落在左 / 右 / 底部 → FLIP 回停靠；落在无效区域 → 保持浮动并钳进视口。
 */
function bindFloatDrag(id) {
  const head = panelHeadEl(id);
  if (!head || head.dataset.floatDragBound) return;
  head.dataset.floatDragBound = '1';
  let armed = false; let dragging = false; let sx = 0; let sy = 0; let ox = 0; let oy = 0; let pid = null;
  // 拖动结束后紧跟着的那一下 click 要吃掉（不然会误触面板头里的按钮）。
  // 记的是**时间戳**而不是布尔位：松手时指针早就离开面板头了，那个 click 根本不会落到头上，
  // 布尔位就会一直挂着，把之后真正的 ✕ / ⋯ 点击全吃掉（按钮看起来是坏的）。
  let suppressClickAt = 0;

  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (state.panels[id]?.dock !== 'float') return;
    if (e.target.closest('input, textarea')) return;
    if (e.target.closest('button, a, select, label, .no-drag')) { bringFloatToFront(id); return; }
    armed = true;
    sx = e.clientX; sy = e.clientY;
    pid = e.pointerId;
    bringFloatToFront(id);
    const box = floatBoxOf(id);
    const r = box?.getBoundingClientRect();
    ox = r ? r.left : 0;
    oy = r ? r.top : 0;
    // .ai-head 上还挂着 HTML5 的 draggable（块换位用的），会和指针拖动抢同一次按下
    if (head.draggable) { head.dataset.wasDraggable = '1'; head.draggable = false; }
    // 移动事件挂到 window：鼠标一离开面板头（几乎是立刻）就收不到 head 上的 pointermove 了，
    // 那样拖动会「粘」在原地。bindSplitter 用的也是这个写法。
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  });

  const move = (e) => {
    if (!armed) return;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (!dragging) {
      if (Math.abs(dx) + Math.abs(dy) < 5) return;   // 还在「点击」的抖动范围内
      dragging = true;
      suppressClickAt = performance.now();
      floatDragId = id;
      cancelPanelAnims();                            // 新拖动打断正在跑的过渡
      try { head.setPointerCapture(pid); } catch { /* 忽略 */ }
      floatBoxOf(id)?.classList.add('dragging');      // 抬升：CSS transition 120ms
      logPanelAnim('lift', ANIM.lift);
      document.body.classList.add('panel-dragging');
    }
    const p = state.panels[id];
    const box = floatBoxOf(id);
    if (!p || !box) return;
    const r = clampFloatRect({ left: ox + dx, top: oy + dy }, { w: p.rect?.w, h: p.rect?.h });
    // 拖动期间把模型里的 left/top 一起跟上（不落盘）：松手时 settleFloat / FLIP 要用它，
    // 而且这时候量 getBoundingClientRect() 会被「抬升」的 scale(1.01) 污染（量出来偏大 1%）
    if (p.rect) { p.rect.left = r.left; p.rect.top = r.top; }
    box.style.left = `${r.left}px`;
    box.style.top = `${r.top}px`;
    showDockPreview(floatRedockTarget(id, e.clientX, e.clientY));
  };

  const end = (e) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    if (!armed) return;
    armed = false;
    document.body.classList.remove('panel-drag-out');
    try { head.releasePointerCapture?.(pid); } catch { /* 忽略 */ }
    if (head.dataset.wasDraggable) { head.draggable = true; delete head.dataset.wasDraggable; }
    if (!dragging) return;                            // 只是点了一下：什么都不做
    dragging = false;
    floatDragId = '';
    floatBoxOf(id)?.classList.remove('dragging');
    document.body.classList.remove('panel-dragging');
    hideDockPreview();
    const zone = floatRedockTarget(id, e.clientX, e.clientY);
    if (zone) {
      dockPanelTo(id, zone);                          // FLIP 平滑收缩回停靠区
    } else {
      settleFloat(id);                                // 除最右 18px 外：保持浮动 + 钳进视口
    }
  };

  // 拖完那一下浏览器还会补一个 click，得吃掉，不然会误触面板头里的按钮。
  // 只吃掉「拖动刚结束 400ms 内」的那一下，过期自动作废。
  head.addEventListener('click', (e) => {
    if (!suppressClickAt || performance.now() - suppressClickAt > 400) return;
    suppressClickAt = 0;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

/**
 * 拖动某个方向的抓手改浮窗大小。
 *
 * `dir` 是 'n' | 's' | 'e' | 'w' 或两两组合（'ne' 等）。四个角与四条边都能拉 ——
 * 用户口径：「左右上下都能直接拉伸而且也可以在角落直接拉伸」。
 *
 * 关键：往**左/上**方向拉时，左边（或上边）也跟着动 —— 也就是先算新的 left/top，
 * 再把宽高按同一个方向补回来，而不是固定左上角只缩放右下角。
 * 最小 260×180、最大不出视口，统一由 clampFloatRect 保证。
 */
function bindFloatResize(id, grip, dir = 'se') {
  const growE = dir.includes('e');
  const growS = dir.includes('s');
  const growW = dir.includes('w');
  const growN = dir.includes('n');
  if (!growE && !growS && !growW && !growN) return;

  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const p = state.panels[id];
    const box = floatBoxOf(id);
    if (!p || p.dock !== 'float' || !box) return;
    e.preventDefault();
    e.stopPropagation();
    bringFloatToFront(id);
    cancelPanelAnims();
    const r = box.getBoundingClientRect();
    const sx = e.clientX; const sy = e.clientY;
    const pid = e.pointerId;
    grip.classList.add('dragging');
    try { grip.setPointerCapture(pid); } catch { /* 忽略 */ }

    const move = (ev) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      /* 先按方向算出拟议的 left/top/宽高：往左拉 = left 减小、宽增大；往上拉同理 */
      let left = r.left + (growW ? dx : 0);
      let top = r.top + (growN ? dy : 0);
      let w = r.width + (growE ? dx : 0) - (growW ? dx : 0);
      let h = r.height + (growS ? dy : 0) - (growN ? dy : 0);
      /* 撞到最小尺寸时，left/top 不能再跟着走（否则会出现「往外拉但框不动」的错觉） */
      if (growW && w < FLOAT_MIN_W) { left = r.left + r.width - FLOAT_MIN_W; w = FLOAT_MIN_W; }
      if (growN && h < FLOAT_MIN_H) { top = r.top + r.height - FLOAT_MIN_H; h = FLOAT_MIN_H; }
      const nr = clampFloatRect({ left, top }, { w, h });
      p.rect = nr;
      box.style.left = `${nr.left}px`;
      box.style.top = `${nr.top}px`;
      box.style.width = `${nr.w}px`;
      box.style.height = `${nr.h}px`;
    };
    const up = () => {
      grip.classList.remove('dragging');
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      savePanels();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
}

/* ── 底部停靠区：高度把手 + 列宽把手 ── */

/** 底部停靠区高度（--dock-bottom-h）：拖动 / ↑↓ 微调，写进 reader.ui.dockBottomH */
function setDockBottomHeight(px, { save = true } = {}) {
  const wrapH = $('.viewer-wrap')?.clientHeight || 600;
  const h = Math.round(clamp(Number(px) || 240, DOCK_BOTTOM_MIN_H, Math.max(140, wrapH - 120)));
  document.documentElement.style.setProperty('--dock-bottom-h', `${h}px`);
  if (save) saveUi();
  return h;
}

function bindDockBottomSplitter() {
  const node = $('#dockBottomSplit');
  if (!node || node.dataset.bound) return;
  node.dataset.bound = '1';
  const now = () => cssPx('--dock-bottom-h', 240);
  node.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    setDockBottomHeight(now() + (e.key === 'ArrowUp' ? 16 : -16));
  });
  let startY = 0; let startH = 0;
  const move = (e) => setDockBottomHeight(startH + (startY - e.clientY), { save: false });
  const up = () => {
    node.classList.remove('dragging');
    document.body.classList.remove('dock-dragging');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    saveUi();
    refitViewer(REFIT_AFTER_MS);
  };
  node.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    startY = e.clientY;
    startH = now();
    node.classList.add('dragging');
    document.body.classList.add('dock-dragging');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

/** 底部停靠区里相邻两列之间的宽度把手（等价于 .ai-split 的拖动逻辑，方向改成左右） */
function bindDockColumnSplit(id, nextId) {
  const node = el('div', { class: 'dock-vsplit', role: 'separator', 'aria-orientation': 'vertical', tabIndex: 0, title: '拖动调整左右两列的宽度' });
  const setW = (a, b) => {
    state.panels[id].w = Math.round(a);
    state.panels[nextId].w = Math.round(b);
    applyPanelWidths();
  };
  node.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const delta = e.key === 'ArrowRight' ? 24 : -24;
    const a = dockColumnWidth(id);
    const b = dockColumnWidth(nextId);
    if (a + delta < 120 || b - delta < 120) return;
    setW(a + delta, b - delta);
    savePanels();
  });
  let startX = 0; let aw = 0; let bw = 0;
  const move = (e) => {
    const dx = e.clientX - startX;
    let a = aw + dx;
    let b = bw - dx;
    if (a < 120) { b -= 120 - a; a = 120; }
    if (b < 120) { a -= 120 - b; b = 120; }
    if (a < 120 || b < 120) return;
    setW(a, b);
  };
  const up = () => {
    node.classList.remove('dragging');
    document.body.classList.remove('dragging');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    savePanels();
  };
  node.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    aw = dockColumnWidth(id);
    bw = dockColumnWidth(nextId);
    node.classList.add('dragging');
    document.body.classList.add('dragging');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  return node;
}

/** 底部某一列现在的宽度（没量到就用兜底值） */
function dockColumnWidth(id) {
  const node = document.querySelector(`.panel-col[data-col="${id}"]`);
  return Math.round(node?.getBoundingClientRect().width || 240);
}

/** 把注册表里的列宽写到 .panel-col 上（没有存过宽度 = 各列平分） */
function applyPanelWidths() {
  for (const id of PANEL_IDS) {
    const col = document.querySelector(`.panel-col[data-col="${id}"]`);
    if (!col) continue;
    const w = state.panels[id].w;
    col.style.flex = w > 0 ? `0 0 ${Math.round(w)}px` : '1 1 0';
  }
}

/* ── 键盘：焦点在哪个面板上 ── */

/** 当前聚焦（或最近点过）的面板 id */
function currentPanelId() {
  const active = document.activeElement;
  const inPanel = active?.closest?.('[data-panel]')?.dataset?.panel;
  if (inPanel && state.panels?.[inPanel]) return inPanel;
  if (state._activePanel && state.panels?.[state._activePanel]) return state._activePanel;
  return '';
}

/** 焦点在浮窗里（或最近点过某个浮窗）时，Esc 把它收回停靠区 */
function focusedFloatPanel() {
  const id = currentPanelId();
  return id && state.panels?.[id]?.dock === 'float' ? id : '';
}

/* ───────────────────────── 面板管理器弹出层 ───────────────────────── */

let panelMenuEl = null;
let panelMenuFor = null;   // 当前把手（点它弹出菜单的那个按钮）

/** 旧函数名保留给旧测试钩子与桌面壳兼容，但现在只打开阅读器内部卡片。
 * 不再写 reader.detachedWindows，也不再调用 window.open()。卡片不会因点击外部区域消失，
 * 只能用卡片标题栏的收回按钮、面板管理器的明确操作或 Esc 收回。 */
function detachPanelToWindow(id) {
  const p = state.panels?.[id];
  if (!p) return false;
  const ok = floatPanel(id);
  if (ok) toast(`「${panelTitle(id)}」已打开为应用内卡片`, '', 1600);
  return ok;
}

/** 兼容旧入口名：不再创建 popup / Tao 子窗口，统一转为应用内卡片。 */
function openPanelWindow(id) {
  return detachPanelToWindow(id);
}

/** 独立窗口页（子窗口）专用的「关闭信号」：三层都发，任何一层到达主窗口都够 */
function panelWindowGoodbye(via) {
  publishPanelMessage({ type: 'panel-window-close', id: panelWindow.id, via });
}

/** 面板窗口只保留一个面板，布局变更通过 savePanels() 发回主窗口。 */
function initPanelWindow() {
  if (!panelWindow.enabled) return;
  document.body.classList.add('panel-window', `panel-window-${panelWindow.id}`);
  const target = panelWindow.id;
  for (const id of PANEL_IDS) {
    const p = state.panels[id];
    p.visible = id === target;
    if (id === target) {
      p.dock = PANEL_IDS_RIGHT.includes(id) ? 'right' : 'left';
      p.home = p.dock;
      p.collapsed = false;
    }
  }
  applyPanels();
  document.title = `${panelTitle(target)} · 论文阅读器`;
  $('#panelBtn')?.remove();
  $('#settingsBtn')?.remove();
}

function ensurePanelMenu() {
  if (panelMenuEl) return panelMenuEl;
  panelMenuEl = el('div', { class: 'panel-menu hidden', id: 'panelMenu', role: 'dialog', 'aria-label': '面板管理器' });
  // 点菜单内部（空白处 / 按钮）都不算「点外部」，别误关
  panelMenuEl.addEventListener('mousedown', (e) => e.stopPropagation());
  // 展开布局 / 批量操作会改变菜单高度，仍要把整张菜单夹在当前窗口内。
  panelMenuEl.addEventListener('toggle', () => clampPanelMenuToViewport(), true);
  /**
   * 纯键盘也能走完管理器里的所有操作：方向键在「行」之间移动焦点，
   * Enter / Space 是 <button> 的原生行为（summary 上的那一套由下面显式处理），
   * Esc 由 initPanels 的 document 监听负责关闭并把焦点还给把手。
   *
   * 导航规则（R12 修）：用「DOM 顺序的扁平列表」上下移动是**错的** ——
   * 一个 .pm-row 的结构是「显示按钮 → 布局设置 summary → 独立窗口 summary」，
   * 而折叠的 details 里的按钮会被过滤掉。于是从「布局设置」按 ↓ 会落到**同一行**的
   * 「独立窗口」，而不是下一行的显示按钮：卡片套件里那条
   * 「收起时跳过隐藏按钮」的断言就是这么红的（真机上是键盘用户走不动管理器）。
   * 现在的规则：↑↓ 在**行与行**之间移动（落到那一行的显示按钮）；
   * 在某个 summary 上按↓ = 进入它自己的操作区（展开后才有按钮，否则原地不动）；
   * 在操作区里按↑ = 回到本行 summary；←→ 仍在「当前可见按钮」的扁平列表里走。
   */
  panelMenuEl.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    if ((e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') && active?.tagName === 'SUMMARY') {
      e.preventDefault();
      const details = active.parentElement;
      if (details?.tagName === 'DETAILS') {
        details.open = !details.open;
        clampPanelMenuToViewport();
      }
      return;
    }
    const isArrow = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key);
    if (!isArrow) return;
    const btns = [...panelMenuEl.querySelectorAll('button:not(:disabled), summary')]
      // Chromium can still report a rect for descendants of a closed
      // <details>; those controls are not keyboard-visible until expanded.
      .filter((node) => {
        const r = node.getBoundingClientRect();
        return (r.width > 0 || r.height > 0)
          && (node.tagName === 'SUMMARY' || !node.closest('details:not([open])'));
      });
    if (!btns.length) return;    const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight';
    const vertical = e.key === 'ArrowDown' || e.key === 'ArrowUp';
    const rows = [...panelMenuEl.querySelectorAll('.pm-row')];
    const row = active?.closest?.('.pm-row') || null;
    const rowIdx = rows.indexOf(row);
    const inActs = !!active?.closest?.('.pm-layout-acts, .pm-window-acts');
    let next = null;
    if (vertical && rowIdx >= 0) {
      if (inActs) {
        // 在操作区里：↑ 回本行 summary；↓ 去下一行的显示按钮
        next = forward
          ? rows[rowIdx + 1]?.querySelector(':scope > .pm-btn') || null
          : row.querySelector('.pm-layout > summary');
      } else if (active?.tagName === 'SUMMARY' && forward) {
        // summary 上按 ↓ = 进入它自己的操作区。
        // 只在**已展开**时进：收起态里 Chromium 会让 details 内容不可聚焦
        //（`.focus()` 静默失败，实测 activeElement 原地不动），所以收起时按下面的规则去下一行。
        const det = active.parentElement;
        next = det?.open
          ? [...det.querySelectorAll('button:not(:disabled)')].find((b) => b.getBoundingClientRect().height > 0) || null
          : rows[rowIdx + 1]?.querySelector(':scope > .pm-btn') || null;
      } else {
        next = rows[rowIdx + (forward ? 1 : -1)]?.querySelector(':scope > .pm-btn') || null;
      }
    }
    if (!next) {
      const i = btns.indexOf(active);
      if (i < 0) { next = btns[0]; } else { next = btns[(i + (forward ? 1 : -1) + btns.length) % btns.length]; }
    }
    if (!next) return;
    e.preventDefault();
    next.focus();
  });
  document.body.append(panelMenuEl);
  return panelMenuEl;
}

/**
 * 菜单里点一下之后重画菜单：按钮文案是 toggle 语义（显示中 / 已隐藏、固定有没有选上、
 * ↑↓ 有没有到边界），不重画就会和真实状态不一致。
 * **必须延到微任务再画**：直接在这一下点击里 replaceChildren 会把事件目标从 DOM 里摘掉，
 * 冒泡中断，第二次点同一个按钮就整个失效（按钮像坏的）。
 */
// 同样要认 .closed：关闭序列里重画会把焦点元素换掉（见 refreshPanelManager 的注释）
const refreshPanelMenuSoon = () => { queueMicrotask(() => { if (panelMenuOpen()) renderPanelMenu(); }); };

const menuBtn = (label, title, onclick, { on = false, disabled = false } = {}) =>
  el('button', {
    type: 'button', class: `pm-btn${on ? ' on' : ''}`, text: label, title,
    dataset: { pmAction: /^(显示中|已隐藏)$/.test(label) ? 'visibility' : label },
    disabled, 'aria-pressed': on ? 'true' : 'false',
    onclick: (e) => { e.stopPropagation(); onclick(); refreshPanelMenuSoon(); },
  });

function renderPanelMenu() {
  const box = ensurePanelMenu();
  // 只记住本次菜单内的展开状态；重新打开时 box 是 hidden，所有低频区仍默认收起。
  const keep = !box.classList.contains('hidden');
  const expanded = new Set(keep ? [...box.querySelectorAll('.pm-layout[open]')]
    .map((node) => node.closest('.pm-row')?.dataset.panel) : []);
  const batchOpen = keep && !!box.querySelector('.pm-batch[open]');
  const active = keep && box.contains(document.activeElement) ? document.activeElement : null;
  const focusPanel = active?.closest('.pm-row')?.dataset.panel;
  const focusAction = active?.dataset.pmAction;
  const scrollTop = box.scrollTop;
  const rows = [];
  for (const id of panelMenuIds()) {
    const p = state.panels[id];
    const floating = p.dock === 'float';
    const list = p.dock === 'float' ? panelsOfDock(p.home) : panelsOfDock(p.dock);
    const at = list.indexOf(id);
    const head = el('div', { class: 'pm-head' },
      el('span', { class: 'pm-name', text: panelTitle(id) }),
      el('span', {
        class: `pm-dock${floating ? ' pm-detached' : ''}`,
        // 译文 / 问答标出「右栏第几栏」——它们只在这一侧，「一栏只开一个」全靠这个数分栏
        text: floating ? '应用内卡片' : (isRightPanel(id) ? `右栏 · 第${colOf(id)}栏` : (DOCK_LABEL[p.dock] || p.dock)),
      }),
    );
    // 浮动卡片不是「隐藏」：点击这里只把卡片提到最前，不会因点外部区域自动消失。
    const visibleBtn = floating
      ? menuBtn('卡片中', `「${panelTitle(id)}」正在阅读器内部卡片中；点击这里把卡片提到最前`, () => {
          bringFloatToFront(id);
        }, { on: true })
      : menuBtn(p.visible ? '显示中' : '已隐藏', `${p.visible ? '隐藏' : '显示'}「${panelTitle(id)}」`, () => setPanelVisible(id, !p.visible), { on: p.visible });
    const layout = el('details', {
      class: 'pm-layout',
      open: expanded.has(id),
      'aria-label': `「${panelTitle(id)}」布局设置`,
    });
    layout.append(el('summary', {
      text: '布局设置',
      dataset: { pmAction: 'layout' },
      title: `展开「${panelTitle(id)}」的浮出、停靠、固定和排序操作`,
      'aria-label': `展开或收起「${panelTitle(id)}」布局设置`,
    }));
    layout.append(el('div', { class: 'pm-layout-acts' },
      // 译文 / 问答不允许停到左栏 / 底部；卡片入口仍然保留在这里。
      // 左栏四块沿用 2.2b 的浮出 / 停靠到左 / 右 / 底部。
      ...(isRightPanel(id) ? [
        menuBtn(floating ? '卡片中' : '打开应用内卡片', floating
          ? `「${panelTitle(id)}」已经在阅读器内部卡片中；点击可提到最前`
          : `在阅读器内部打开「${panelTitle(id)}」卡片`, () => floating ? bringFloatToFront(id) : floatPanel(id), { on: floating }),
        menuBtn('放到第 1 栏', `把「${panelTitle(id)}」放到右栏第 1 栏`, () => setPanelColumn(id, 1), { on: colOf(id) === 1 }),
        menuBtn('放到第 2 栏', `把「${panelTitle(id)}」放到右栏第 2 栏（会自动把第 2 栏开出来）`, () => setPanelColumn(id, 2), { on: colOf(id) === 2 }),
        rightColsWanted() === 1
          ? menuBtn('再开一栏', '在右栏右边再开一栏：译文和问答可以各占一栏并排看', () => openRightColumn())
          : menuBtn('收起第 2 栏', '把右栏第 2 栏收起来（第 2 栏里的面板一并收起，栏位归属保留）', () => closeRightColumn(), { on: true }),
      ] : [
        menuBtn('浮出', `把「${panelTitle(id)}」浮成应用内浮窗（原位置留占位块，可拖动缩放）`, () => floatPanel(id), { on: p.dock === 'float' }),
        menuBtn('停靠到左', `把「${panelTitle(id)}」停靠到左栏`, () => dockPanelTo(id, 'left'), { on: p.dock === 'left' }),
        menuBtn('停靠到右', `把「${panelTitle(id)}」停靠到右栏`, () => dockPanelTo(id, 'right'), { on: p.dock === 'right' }),
        menuBtn('停靠到底部', `把「${panelTitle(id)}」停靠到底部横条`, () => dockPanelTo(id, 'bottom'), { on: p.dock === 'bottom' }),
      ]),
      menuBtn('固定', `固定「${panelTitle(id)}」：窗口放不下时，优先收起没有固定面板的那一侧`, () => setPanelPinned(id, !p.pinned), { on: p.pinned }),
      menuBtn('↑', `「${panelTitle(id)}」上移一位`, () => movePanel(id, -1), { disabled: at <= 0 }),
      menuBtn('↓', `「${panelTitle(id)}」下移一位`, () => movePanel(id, 1), { disabled: at < 0 || at >= list.length - 1 }),
    ));
    const windowDetails = el('details', { class: 'pm-window', 'aria-label': `「${panelTitle(id)}」应用内卡片` });
    windowDetails.append(el('summary', {
      text: floating ? '应用内卡片（使用中）' : '应用内卡片',
      dataset: { pmAction: 'window' },
      title: floating ? `「${panelTitle(id)}」正在阅读器内部卡片中` : `在阅读器内部打开「${panelTitle(id)}」卡片`,
      'aria-label': `展开或收起「${panelTitle(id)}」应用内卡片操作`,
    }));
    windowDetails.append(el('div', { class: 'pm-window-acts' },
      floating
        ? menuBtn('已在应用内卡片中', '卡片不会因点击其他区域自动消失；用卡片右上角按钮或明确的收回操作结束', () => bringFloatToFront(id), { on: true })
        : menuBtn('打开应用内卡片', `在阅读器内部打开「${panelTitle(id)}」卡片，不创建独立窗口`, () => detachPanelToWindow(id)),
    ));
    layout.append(windowDetails);
    rows.push(el('div', { class: 'pm-row', dataset: { panel: id } }, head, visibleBtn, layout));
  }
  const batch = el('details', { class: 'pm-batch', open: batchOpen, 'aria-label': '批量面板操作' });
  batch.append(el('summary', {
    text: '批量操作',
    dataset: { pmAction: 'batch' },
    title: '展开全部显示与全部收回停靠',
    'aria-label': '展开或收起批量面板操作',
  }));
  batch.append(el('div', { class: 'pm-batch-acts' },
    el('button', { type: 'button', class: 'pm-foot-btn', text: '全部显示', dataset: { pmAction: 'showAll' }, title: '把六个面板都打开', onclick: () => { showAllPanels(); refreshPanelMenuSoon(); } }),
    el('button', {
      type: 'button', class: 'pm-foot-btn', text: '全部收回停靠',
      dataset: { pmAction: 'redockAll' },
      title: '把所有浮窗收回它们原来的停靠区',
      onclick: () => { const n = redockFloats(); toast(n ? `${n} 个浮窗已收回停靠` : '当前没有浮窗', n ? 'ok' : '', 1800); refreshPanelMenuSoon(); },
    }),
  ));
  rows.push(el('div', { class: 'pm-foot' },
    el('button', { type: 'button', class: 'pm-foot-btn', text: '恢复默认布局', dataset: { pmAction: 'reset' }, title: '六个面板、两侧栏宽度、收展意图、浮窗全部回默认', onclick: () => { hidePanelMenu(); resetLayout(); } }),
    batch,
  ));
  box.replaceChildren(...rows);
  if (focusAction) {
    const scope = focusPanel ? [...box.querySelectorAll('.pm-row')].find((row) => row.dataset.panel === focusPanel) : box.querySelector('.pm-foot');
    const target = [...(scope?.querySelectorAll('[data-pm-action]') || [])].find((node) => node.dataset.pmAction === focusAction);
    // 排序到边界后 ↑/↓ 会禁用；焦点回到同一行 summary，便于继续操作与退出。
    (target && !target.disabled ? target : scope?.querySelector('summary'))?.focus({ preventScroll: true });
  }
  box.scrollTop = keep ? scrollTop : 0;
  clampPanelMenuToViewport();
  return box;
}

function clampPanelMenuToViewport() {
  const box = panelMenuEl;
  if (!box || box.classList.contains('hidden')) return;
  const r = box.getBoundingClientRect();
  box.style.left = `${Math.round(clamp(r.left, 8, Math.max(8, innerWidth - r.width - 8)))}px`;
  box.style.top = `${Math.round(clamp(r.top, 8, Math.max(8, innerHeight - r.height - 8)))}px`;
}

/** 打开面板管理器（anchor = 点它的那个按钮，用来定位） */
function togglePanelMenu(anchor) {
  if (!panelMenuEl || panelMenuEl.classList.contains('hidden')) openPanelMenu(anchor);
  else hidePanelMenu();
}

/**
 * 记住「这一次是哪个面板行触发的管理器」。
 *
 * 为什么需要它：`menuBtn` 点一下之后会走 `refreshPanelMenuSoon()` 重画整张菜单
 * （按钮文案是 toggle 语义，不重画就与实际状态不符），**原来那个按钮节点被 replaceChildren 摘掉了**。
 * 于是 `panelMenuFor` 指向一个已经脱离文档的节点，Esc 时 `anchor.focus()` 静默失败，
 * 焦点掉回 <body> —— 用户按 Esc 关掉管理器之后，键盘焦点就丢了，Tab 得从头再走一遍。
 * 记一个**面板 id**（稳定、可重新查到），关菜单时按 id 找回同一行的显示按钮。
 */
let panelMenuAnchorId = null;

function openPanelMenu(anchor) {
  const box = renderPanelMenu();
  panelMenuFor = anchor || null;
  panelMenuAnchorId = anchor?.closest?.('.pm-row')?.dataset?.panel || null;
  /**
   * 顺手记下「这一次是在操作哪个面板」。
   *
   * `state._activePanel` 平时只由 document 上的 pointerdown / focusin 维护，判据是
   * 「事件目标在 [data-panel] 里」—— 而**管理器里的按钮不在任何 [data-panel] 里**，
   * 所以「点管理器里的按钮」这条路径上它永远更新不了。后果就是关闭管理器找不到
   * 「该把焦点还给谁」，只能退回默认值，键盘用户按 Esc 之后焦点跑到别的面板去了。
   * 这里补上：从触发行反查面板 id，行为与「点过那个面板」等价。
   */
  const opId = panelMenuAnchorId || anchor?.closest?.('[data-panel]')?.dataset?.panel || '';
  if (opId && state.panels?.[opId]) state._activePanel = opId;
  box.classList.remove('hidden');
  // 贴着把手放；放不下就翻到另一侧，最后再夹进窗口（fixed 定位，不受滚动影响）
  const r = anchor?.getBoundingClientRect();
  const w = box.offsetWidth || 300;
  const h = box.offsetHeight || 320;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = r ? r.right - w : vw - w - 12;
  let top = r ? r.bottom + 6 : 44;
  box.style.left = `${Math.round(clamp(left, 8, Math.max(8, vw - w - 8)))}px`;
  box.style.top = `${Math.round(clamp(top, 8, Math.max(8, vh - h - 8)))}px`;
  (box.querySelector('.pm-btn, .pm-foot-btn') || box).focus?.();
}

function hidePanelMenu() {
  panelMenuEl?.classList.add('hidden');
  panelMenuFor = null;
  // 记一下「刚关过管理器」：Esc 的收浮窗分支据此让开，免得一次 Esc 干两件事
  state._menuClosedAt = performance.now();
}

/**
 * 关掉管理器并把键盘焦点还回去。
 *
 * ⚠️ 三件事的顺序全部是实测出来的，别凭直觉改：
 *   ① 浏览器对「父级 display:none 的元素」执行 `focus()` **一律无效**（焦点落 <body>）。
 *      独立复现：先 focus 再 display:none → 焦点保住；先 display:none 再 focus → 焦点丢。
 *   ② 但 focus() 之后**同一个任务里**就把菜单 display:none，焦点同样会丢回 body
 *      （实测：focusin 收到了，activeElement 最后还是 body）。
 *   ③ 所以必须「先 focus → 下一帧才 hide」。
 *
 * 为了让「关闭了没有」在**同一帧**就能被观察到（调用方与自动化都靠 `hidden` 类判断），
 * 这一帧先加一个 `.closed` 类立刻隐藏菜单（与 .hidden 同样 display:none），
 * 下一帧再补真正的 hidden + 清理面板把手。隐藏发生在 focus 之后，所以焦点保得住。
 */
function closePanelMenuAndRestoreFocus(fallbackAnchor = null) {
  const id = panelMenuAnchorId;
  const byId = id ? panelMenuEl?.querySelector(`.pm-row[data-panel="${id}"] > .pm-btn`) : null;
  const stillThere = fallbackAnchor && fallbackAnchor.isConnected ? fallbackAnchor : null;
  const pid = currentPanelId();
  const head = pid ? panelHeadEl(pid) : null;
  const docHead = document.querySelector('#leftSide > section.sec > .sec-head') || document.querySelector('.sec-head');
  // 候选里**绝不能有菜单内部的元素**：菜单马上要隐藏，聚焦它等于聚焦空气
  const target = byId || docHead || stillThere || head;
  try { target?.focus?.(); } catch { /* 忽略 */ }
  panelMenuEl?.classList.add('closed');    // 同一帧就视觉关闭（display:none），但不动焦点
  panelMenuAnchorId = null;
  // 隐藏之后再**补一次** focus：实测「focus → 隐藏」在真实链路上仍会被别的重排/重画打断
  // （焦点最终落到 <body>）。补这一刀是幂等的 —— 目标已聚焦时不产生任何可见变化，
  // 被打断时能把焦点拉回来。两帧是因为菜单的 .hidden 要到下一帧才补上。
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      panelMenuEl?.classList.remove('closed');
      hidePanelMenu();
      if (document.activeElement !== target && target && target.isConnected) {
        try { target.focus(); } catch { /* 忽略 */ }
      }
    });
  });
}

/** 「全部显示」：六个面板全打开、全展开 */
function showAllPanels() {
  for (const id of PANEL_IDS) {
    state.panels[id].visible = true;
    state.panels[id].collapsed = false;
  }
  sideIntent.pinned.left = true;
  sideIntent.pinned.right = true;
  savePanels();
  applyPanels();
  applyResponsiveLayout();
  toast('六个面板已全部显示', 'ok', 1800);
}

/** 面板头左侧的点开区域：Enter/Space 折叠展开、Alt+↑/↓ 同栏换位、Alt+H 隐藏、Shift+F10 / 菜单键开管理器 */
function bindPanelHead(id, head) {
  head.tabIndex = 0;
  head.setAttribute('role', 'button');
  head.setAttribute('aria-expanded', String(!state.panels[id].collapsed));
  // 右键标题栏 = 打开面板管理器（已按用户要求去掉常驻的 ⋯ 和顶栏 ▤ 按钮）
  head.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openPanelMenu(head);
  });
  head.addEventListener('keydown', (e) => {
    // 这些组合由面板头自己处理：别让文档级快捷键再抢一次（比如 Alt+H 落到无修饰的 h）
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      e.stopPropagation();
      togglePanelCollapsed(id);
      return;
    }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      e.stopPropagation();
      movePanel(id, e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (e.altKey && e.key.toLowerCase() === 'h') {
      e.preventDefault();
      e.stopPropagation();
      setPanelVisible(id, false);
      toast(`已隐藏「${panelTitle(id)}」`, '', 1600);
      return;
    }
    if (e.shiftKey && e.key === 'F10') {
      e.preventDefault();
      e.stopPropagation();
      openPanelMenu(head);
    }
  });
}

/* ── 拖出成应用内卡片 ──
   停靠面板：拖离按下点超过 DRAG_OUT_MIN 松手就打开阅读器内部卡片；拖回原处（不足 DRAG_OUT_MIN）松手 = 放回原位。
   浮窗：拖到窗口边缘也仍留在应用内，不能通过边缘手势创建系统窗口。
   判定基准是「按下点」而不是屏幕边缘 —— 左栏本来就贴着窗口边缘，用边缘判定会一拖就误触发。 */
const DRAG_OUT_MIN = 24;
const DRAG_OUT_MARGIN = 44;
const nearWindowEdge = (x, y) => x <= DRAG_OUT_MARGIN || y <= DRAG_OUT_MARGIN
  || x >= innerWidth - DRAG_OUT_MARGIN || y >= innerHeight - DRAG_OUT_MARGIN;

let dragGhostEl = null;
function showDragGhost(x, y, text, hot) {
  if (!dragGhostEl) {
    dragGhostEl = el('div', { class: 'panel-drag-ghost hidden', id: 'panelDragGhost', 'aria-hidden': 'true' });
    document.body.append(dragGhostEl);
  }
  dragGhostEl.textContent = text;
  dragGhostEl.classList.toggle('hot', !!hot);
  dragGhostEl.classList.remove('hidden');
  dragGhostEl.style.left = `${clamp(x + 16, 6, Math.max(6, innerWidth - 40))}px`;
  dragGhostEl.style.top = `${clamp(y + 18, 6, Math.max(6, innerHeight - 40))}px`;
}
function hideDragGhost() { dragGhostEl?.classList.add('hidden'); }

/** 面板标题栏左侧的可见抓手：位置固定，不依赖「找到标题栏空白处」这种运气 */
function panelDragHandle() {
  return el('span', {
    class: 'panel-drag-handle',
    title: '按住拖动：拖出一点距离松手，就在阅读器内部打开卡片；拖回原处松手则放回原位',
    'aria-hidden': 'true',
  }, iconEl('drag', { size: 14 }));
}

// 停靠面板拖出：拖离按下点一小段距离松手就移入阅读器内部卡片；拖回原处松手则保持停靠。
function bindDockPanelDrag(id, head) {
  if (!head || head.dataset.dockDragBound) return;
  head.dataset.dockDragBound = '1';
  let armed = false; let dragging = false; let sx = 0; let sy = 0; let pid = 0;
  let suppressClickAt = 0;
  const distOf = (e) => Math.hypot(e.clientX - sx, e.clientY - sy);
  const end = (e) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    if (!armed) return;
    armed = false;
    if (head.dataset.wasDraggable) { head.draggable = true; delete head.dataset.wasDraggable; }
    document.body.classList.remove('panel-drag-out');
    hideDragGhost();
    if (!dragging) return;
    dragging = false;
    head.classList.remove('dragging');
    document.body.classList.remove('panel-dragging');
    const canceled = e?.type === 'pointercancel';
    const moved = canceled || !e ? 0 : distOf(e);
    if (!canceled && moved >= DRAG_OUT_MIN && state.panels[id]?.dock !== 'float') {
      // 拖离了原处：交给阅读器内部卡片
      detachPanelToWindow(id);
    } else if (!canceled && moved >= 8) {
      // 拉回原处松手：保持停靠，明确说一声「放回去了」
      toast('已放回原位，没有打开应用内卡片', '', 1800);
    }
  };
  const move = (e) => {
    if (!armed) return;
    const dx = e.clientX - sx; const dy = e.clientY - sy;
    if (!dragging) {
      if (Math.abs(dx) + Math.abs(dy) < 4) return;   // 4px 起步，鼠标轻轻一拖就有反馈
      dragging = true;
      suppressClickAt = performance.now();
      head.classList.add('dragging');
      document.body.classList.add('panel-dragging');
    }
    const moved = distOf(e);
    const willDetach = moved >= DRAG_OUT_MIN;
    document.body.classList.toggle('panel-drag-out', willDetach);
    showDragGhost(
      e.clientX, e.clientY,
      willDetach
        ? `松手：「${panelTitle(id)}」在应用内卡片中打开`
        : `拖出 ${DRAG_OUT_MIN}px 就会打开应用内卡片（现在松手 = 放回原位）`,
      willDetach,
    );
  };
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || state.panels[id]?.dock === 'float') return;
    if (e.target.closest('button, a, input, textarea, select, label, .no-drag')) return;
    if (e.target.closest('.grip')) return;   // 右栏的 ⇅ 抓手归「上下换位」，不参与拖出
    // .ai-head 自带 HTML5 draggable（块换位），会和指针拖拽抢同一次按下：按下期间先摘掉
    if (head.draggable) { head.dataset.wasDraggable = '1'; head.draggable = false; }
    armed = true; dragging = false; sx = e.clientX; sy = e.clientY; pid = e.pointerId;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    try { head.setPointerCapture(pid); } catch { /* optional */ }
  });
  head.addEventListener('click', (e) => {
    if (!suppressClickAt || performance.now() - suppressClickAt > 450) return;
    suppressClickAt = 0;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

/** 面板头右侧的「更多」按钮：点开同一个管理器（隐藏 / 固定 / 上移 / 下移） */
function panelMoreButton(id, label) {
  return el('button', {
    type: 'button', class: 'tbtn tiny panel-more',
    title: `「${panelTitle(id)}」面板：隐藏 / 固定 / 上移 / 下移`,
    'aria-haspopup': 'dialog', 'aria-label': `${label}面板操作`,
    onclick: (e) => { e.stopPropagation(); togglePanelMenu(e.currentTarget); },
  }, iconEl('more'));
}

/**
 * 标题栏右侧的直接操作（VS Code 式）：常用动作直接摆在标题栏上，悬停显形；
 * 只有固定 / 上移 / 下移 / 换停靠区这类长尾操作才留在 ⋯ 里。
 */
/**
 * 标题栏右侧的直接操作（VS Code 式）：常用动作直接摆在标题栏上；
 * 只有固定 / 上移 / 下移 / 换停靠区这类长尾操作才留在 ⋯ 里。
 * 参数从「字符」改成「icons.js 的 id」—— 图标本身不承担语义，title / aria-label 照旧给全。
 */
function panelIcon(iconId, title, onclick, extra) {
  return el('button', {
    type: 'button', class: `tbtn tiny panel-icon ${extra || ''}`.trim(), title,
    'aria-label': title,
    onclick: (e) => { e.stopPropagation(); onclick(); },
  }, iconEl(iconId));
}
function panelActions(id) {
  const title = panelTitle(id);
  if (isRightPanel(id)) {
    // 译文 / 问答：应用内卡片 / 换栏 / 隐藏。
    // 卡片仍然只能在当前阅读器窗口内部，不改变它们只能归属右栏的模型。
    return el('div', { class: 'panel-actions' },
      panelIcon('popout', `在应用内卡片中打开「${title}」`, () => detachPanelToWindow(id)),
      panelColumnToggle(id),
      panelIcon('close', `隐藏「${title}」（右键标题栏可以再显示）`, () => setPanelVisible(id, false), 'panel-hide'),
    );
  }
  return el('div', { class: 'panel-actions' },
    panelIcon('popout', `在应用内卡片中打开「${title}」`, () => detachPanelToWindow(id)),
    // 浮出 / 收回在执行时按当前状态判定；图标由 syncPanelActions 在 applyPanels 里刷新
    el('button', {
      type: 'button', class: 'tbtn tiny panel-icon panel-float-toggle',
      title: `把「${title}」浮出成应用内浮窗`, 'aria-label': `浮出或收回「${title}」`,
      onclick: (e) => {
        e.stopPropagation();
        const p = state.panels?.[id];
        if (p?.dock === 'float') dockPanelTo(id, p.home || 'left');
        else floatPanel(id);
      },
    }, iconEl('float')),
    panelIcon('close', `隐藏「${title}」（右键标题栏可以再显示）`, () => setPanelVisible(id, false), 'panel-hide'),
  );
}

/** 译文 / 问答标题栏上的换栏按钮（去第 2 栏 / 回第 1 栏），图标由 syncPanelActions 刷新 */
function panelColumnToggle(id) {
  return el('button', {
    type: 'button', class: 'tbtn tiny panel-icon panel-col-toggle',
    title: `把「${panelTitle(id)}」放到右栏第 2 栏`, 'aria-label': `切换「${panelTitle(id)}」的右栏栏位`,
    onclick: (e) => {
      e.stopPropagation();
      setPanelColumn(id, colOf(id) === 2 ? 1 : 2);
    },
  });
}

/**
 * 浮窗 / 换栏状态变化后刷新标题栏那两个按钮的图标。
 * **必须是 replaceChildren(iconEl(...))，不能写 textContent** —— 图标是 SVG 元素，
 * 赋 textContent 只会把标记当文字显示出来（而且会把已有图标连根删掉）。
 */
function syncPanelActions(id) {
  const head = panelHeadEl(id);
  // 译文 / 问答的换栏按钮：显示当前在第几栏，点一下换到另一栏
  const colBtn = head?.querySelector('.panel-col-toggle');
  if (colBtn) {
    const inCol2 = colOf(id) === 2;
    const title = inCol2
      ? `把「${panelTitle(id)}」放回右栏第 1 栏`
      : `把「${panelTitle(id)}」放到右栏第 2 栏（会自动把第 2 栏开出来）`;
    const want = inCol2 ? 'swap-back' : 'swap';
    if (colBtn.dataset.icon !== want) {
      colBtn.dataset.icon = want;
      colBtn.replaceChildren(iconEl(want));
    }
    if (colBtn.title !== title) { colBtn.title = title; colBtn.setAttribute('aria-label', title); }
  }
  const btn = head?.querySelector('.panel-float-toggle');
  if (!btn) return;
  const floating = state.panels?.[id]?.dock === 'float';
  const title = floating
    ? `收回「${panelTitle(id)}」浮窗，回到停靠区`
    : `把「${panelTitle(id)}」浮出成应用内浮窗`;
  const want = floating ? 'dock' : 'float';
  if (btn.dataset.icon !== want) {
    btn.dataset.icon = want;
    btn.replaceChildren(iconEl(want));
  }
  if (btn.title !== title) { btn.title = title; btn.setAttribute('aria-label', title); }
}

/**
 * 侧栏底部的小图标坞：每个面板一个图标，点一下就显示/收起。
 * 它是「面板永远找得回来」的固定入口 —— 不需要撤销提示，也不限制你隐藏多少块。
 *
 * 用户口径（2026-10-03）：译文 / 问答**只在右栏**，右栏改用每一栏底部的分段切换器
 * （#aiBar / #aiBar2）当唯一可见入口，所以这一排只有左栏四个面板。
 */
const PANEL_DOCK_ICON = {
  files: 'folder', outline: 'list', notes: 'note', relations: 'relations',
  // 译文 / 问答不在这里露面（左栏图标坞只列左栏面板），但映射留着，
  // 万一将来左栏也需要这两块时不会退化成「取标题第一个字」。
  translate: 'translate', chat: 'chat',
};

/** 造一个图标按钮（左右两侧共用同一套手势：点＝开关 · 右键＝菜单 · 按住拖出＝应用内卡片） */
function dockButton(id) {
  // 注意：这里不能写 data-panel —— panelEl() 靠 [data-panel=id] 找面板节点，会误认这些图标
  const btn = el('button', {
    type: 'button', class: 'dock-btn', role: 'menuitem', dataset: { dockFor: id },
    title: `「${panelTitle(id)}」：点一下显示/收起 · 按住拖出＝应用内卡片 · 右键＝更多`,
    'aria-label': `显示 / 收起「${panelTitle(id)}」`,
  }, iconEl(PANEL_DOCK_ICON[id] || 'folder'));
  bindPanelToggleGestures(btn, id, { dragToDetach: true });
  return btn;
}

/**
 * 把「点 / 右键 / 按住拖出」这套手势绑到一个面板入口按钮上。
 * 左栏图标坞的 `.dock-btn` 与右栏底部那**唯一一组**「译文 / 问答」切换器共用它 ——
 * 用户口径：「右键和拖拽能力附着在这一组图标上，不再额外渲染另一组相同按钮」。
 */
function bindPanelToggleGestures(btn, id, { dragToDetach = true, onClick = null } = {}) {
  let armed = false; let dragged = false; let sx = 0; let sy = 0;
  if (dragToDetach) {
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      armed = true; dragged = false; sx = e.clientX; sy = e.clientY;
      try { btn.setPointerCapture(e.pointerId); } catch { /* 可选 */ }
    });
    btn.addEventListener('pointermove', (e) => {
      if (!armed) return;
      if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 18) dragged = true;
    });
    btn.addEventListener('pointerup', () => {
      if (!armed) return;
      armed = false;
      if (!dragged) return;              // 没拖动：交给 click 去开关
      btn.dataset.justDragged = '1';
      detachPanelToWindow(id);           // 按住图标拖出 = 应用内卡片
    });
  }
  btn.addEventListener('click', (e) => {
    if (btn.dataset.justDragged) { delete btn.dataset.justDragged; e.preventDefault(); e.stopPropagation(); return; }
    if (onClick) onClick(e);
    else toggleDockPanel(id);
  });
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    showDockMenu(btn, id);
  });
  return btn;
}

function initPanelDock() {
  // 左栏图标坞：只放左栏面板。右栏的译文 / 问答改用输入框下面那排分段切换器
  //（#aiBar / #aiBar2），这里不再重复渲染它们 —— 一套功能只有一个可见入口。
  const dock = $('#panelDock');
  if (dock) dock.replaceChildren(...PANEL_IDS.filter((id) => !isRightPanel(id)).map(dockButton));
  if (dock) syncPanelDock();
}

/** 右栏每一列的「面板切换器」容器：第 1 栏在文档里，第 2 栏由 applyRightColsDom 现建 */
const aiBarEl = (n) => document.getElementById(n === 2 ? 'aiBar2' : 'aiBar');

/** 左栏图标坞的按钮状态（译文 / 问答不在这里，它们的状态由 renderAiBar 刷） */
function syncPanelDock() {
  const dock = $('#panelDock');
  if (!dock) return;
  for (const btn of dock.querySelectorAll('.dock-btn')) {
    const p = state.panels?.[btn.dataset.dockFor];
    if (!p) continue;
    const on = !!p.visible;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  }
}

/**
 * 点图标：显示 / 收起。
 * 右栏那两块**一栏只能开一个**：点第 2 栏的图标就把这块放进第 2 栏（必要时现开第 2 栏），
 * 同栏里原来显示的那一个自动收起。左栏四块不受影响。
 */
function toggleDockPanel(id, col = 0) {
  const p = state.panels[id];
  if (!p) return;
  if (isRightPanel(id)) {
    const want = col === 2 ? 2 : (col === 1 ? 1 : colOf(id));
    if (p.visible && colOf(id) === want) { setPanelVisible(id, false); return; }
    setPanelColumn(id, want);
    return;
  }
  setPanelVisible(id, !p.visible);
}

/** 「再开一栏」只能对右栏面板用（左栏面板有自己的浮出 / 停靠能力） */
function dockFloatColumn(id) {
  if (!isRightPanel(id)) return floatPanel(id);
  return setPanelColumn(id, 2);
}

/**
 * 图标坞右键小菜单。
 *   左栏图标：显示/收起 · 浮出成应用内卡片
 *   右栏图标（译文 / 问答）：显示/收起 · 放到第 1 / 2 栏 · 再开一栏 / 收起这一栏 · 应用内卡片
 * 这就是用户说的「右键图标选择再开一栏」——第 2 栏原本没有任何入口。
 */
let dockMenuEl = null;
let dockMenuDown = null;
function hideDockMenu() {
  if (!dockMenuEl && !dockMenuDown) return;
  dockMenuEl?.remove();
  dockMenuEl = null;
  if (dockMenuDown) { document.removeEventListener('pointerdown', dockMenuDown, true); dockMenuDown = null; }
}
function showDockMenu(anchor, id) {
  hideDockMenu();
  const menu = el('div', { class: 'dock-menu', id: 'dockMenu', role: 'menu' });
  const item = (text, fn, { on = false } = {}) => el('button', {
    type: 'button', class: `dock-menu-btn${on ? ' on' : ''}`, text, role: 'menuitem',
    'aria-pressed': String(on),
    onclick: () => { hideDockMenu(); fn(); },
  });
  if (isRightPanel(id)) {
    const here = Number(anchor.dataset.dockCol) === 2 ? 2 : 1;
    const col = colOf(id);
    const p = state.panels[id];
    // 点第 2 栏的图标但那一栏还没开：先给「再开一栏」，顺序按当前状态排
    menu.append(
      item(p?.visible ? `收起「${panelTitle(id)}」` : `打开「${panelTitle(id)}」`, () => toggleDockPanel(id, here), { on: !!p?.visible && col === here }),
      item('放到第 1 栏', () => setPanelColumn(id, 1), { on: col === 1 }),
      item('放到第 2 栏', () => setPanelColumn(id, 2), { on: col === 2 }),
    );
    if (rightColsWanted() === 1) menu.append(item('再开一栏（并排显示）', () => openRightColumn()));
    else menu.append(item('收起第 2 栏', () => closeRightColumn()));
    menu.append(item('在应用内卡片中打开', () => detachPanelToWindow(id)));
  } else {
    menu.append(
      item(state.panels[id]?.visible ? `收起「${panelTitle(id)}」` : `显示「${panelTitle(id)}」`, () => toggleDockPanel(id)),
      item('浮出成应用内浮窗', () => floatPanel(id)),
      item('在应用内卡片中打开', () => detachPanelToWindow(id)),
    );
  }
  menu.classList.remove('hidden');
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mr = menu.getBoundingClientRect();
  menu.style.left = `${Math.round(Math.max(8, Math.min(r.left, innerWidth - mr.width - 8)))}px`;
  menu.style.top = `${Math.round(Math.max(8, r.top - mr.height - 6))}px`;
  dockMenuEl = menu;
  dockMenuDown = (e) => { if (!menu.contains(e.target)) hideDockMenu(); };
  document.addEventListener('pointerdown', dockMenuDown, true);
}

/**
 * 浮窗头上的 ✕：先朝最近的屏幕边缘平滑收起（160ms），再回原来的停靠区。
 * 停靠状态下这个按钮是 display:none（CSS），所以默认外观与 2.2a 一致。
 */
function panelFloatCloseButton(id) {
  return el('button', {
    type: 'button', class: 'tbtn tiny panel-float-x',
    title: `收起「${panelTitle(id)}」浮窗，回到原来的停靠区（Esc 同效）`,
    'aria-label': `收起「${panelTitle(id)}」浮窗`,
    onclick: (e) => { e.stopPropagation(); closeFloatPanel(id); },
  }, iconEl('close'));
}

/**
 * 六个面板统一走这一条渲染路径。
 * 左栏四块**不重写内部结构**：文件块用 .side-head 当标题栏，其余三块沿用 section.sec + .sec-head，
 * 只补 data-panel 与标题栏上的折叠 / ⋯ 控件（内部所有 id 一个都没动）。
 */
function initPanels() {
  ensurePanelMenu();
  initPanelDock();
  // 点外部 / Esc 关闭（顶栏 ▤ 与各面板的 ⋯ 都在菜单外面，所以点它们会先关掉再开回来，
  // 由 togglePanelMenu 里的 hidden 判断兜住，不会出现「点了没反应」）
  document.addEventListener('mousedown', (e) => {
    if (!panelMenuEl || panelMenuEl.classList.contains('hidden')) return;
    if (panelMenuEl.contains(e.target) || panelMenuFor?.contains(e.target)) return;
    hidePanelMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !panelMenuEl || panelMenuEl.classList.contains('hidden')) return;
    // 先把把手记下来再关：hidePanelMenu() 会把 panelMenuFor 清成 null，反过来写焦点就永远回不去。
    // 而且行里的按钮会被重画替换，所以 closePanelMenuAndRestoreFocus 是按「面板 id」重查的。
    closePanelMenuAndRestoreFocus(panelMenuFor);
  });
  /**
   * 「全部显示」这个底部按钮不走 menuBtn（它会自己重画），这里补一次；
   * 同样要延到微任务 —— 否则点它时会被自己重建掉的 DOM 掐断。
   */
  document.addEventListener('click', (e) => {
    if (!panelMenuEl || panelMenuEl.classList.contains('hidden')) return;
    if (!panelMenuEl.contains(e.target) || !e.target.closest?.('.pm-foot-btn')) return;
    refreshPanelMenuSoon();
  }, true);
  // 六个面板统一入模：先补上标题栏控件与折叠开关，再按注册表排一遍
  for (const d of PANEL_DEFS) ensurePanel(d.id, d);
  // 阶段 2.2b：每个面板头都能拖（只在它是浮窗时生效），并记住「最近碰过哪个面板」供快捷键用
  for (const d of PANEL_DEFS) bindFloatDrag(d.id);
  const rememberPanel = (e) => {
    const id = e.target?.closest?.('[data-panel]')?.dataset?.panel;
    if (id) {
      state._activePanel = id;
      if (state.panels?.[id]?.dock === 'float') bringFloatToFront(id);
    }
  };
  document.addEventListener('pointerdown', rememberPanel, true);
  document.addEventListener('focusin', rememberPanel);
  bindDockBottomSplitter();
  applyPanels();
}

const DEFAULT_UI_STYLE = Object.freeze({
  theme: 'system', density: 'standard', fontSize: 14, lineHeight: 1.72,
  codeSize: 12, maxWidth: 760, opacity: 1,
  // PDF 纸张默认跟随阅读器的暖色纸面；设置里可切换为纯白。
  paper: 'tint',
  // 界面尺度：uiFontSize = 界面字号 px（--ui-fs），controlSize = 控件大小 %（--ctl-scale）。
  // 这两个和上面的 fontSize（阅读/结果字号 --ai-fs）是互相独立的三套刻度。
  uiFontSize: 13.5, controlSize: 100,
  showPage: true, showQuote: true, showSources: false,
});
let uiStyle = { ...DEFAULT_UI_STYLE };

/** 界面字号：老存档（localStorage reader.ui）里没有这个字段时回落默认值，不能变 NaN */
const uiFontSizePx = (v) => clamp(Number(v) || DEFAULT_UI_STYLE.uiFontSize, 12, 17);
/** 控件大小：存档里是百分比（80–130），CSS 里是缩放系数（0.8–1.3） */
const ctlScaleOf = (v) => clamp(Number(v) || DEFAULT_UI_STYLE.controlSize, 80, 130) / 100;

const state = {
  doc: null,
  viewerDocId: null,
  // 响应式布局：窗口太窄导致的自动收起。**只在内存里**，绝不写进 reader.ui
  //（reader.ui.noLeft/noRight 是用户意图，两者混在一起会导致「窄窗用过一次就永久收起」）
  autoCollapse: { left: false, right: false },
  papers: [],
  selection: null,
  quote: null,          // 对话引用 {page, text}
  _dragSelecting: false,   // 正在正文里拖选（用于「松手在窗口外」的兜底）
  _downAt: null,           // 这次按下的坐标，用来区分「单击」和「拖选」
  history: [],          // 对话历史（只含真正发出去的问答）
  sessionEntries: [],
  highlights: [],
  cache: new Map(),     // 翻译缓存
  abort: null,
  abortReason: '',
  busy: false,
  search: { hits: [], idx: 0, query: '' },
  jumpHistory: new Map(), // docId -> [{ scrollTop, scale }]
  activeSendScope: '',
  // 统一面板注册表（左栏四块 + 右栏两块）：见「面板注册表」一节。
  // 右栏两块的高度（px）就存在各自的 size 里，缺省=自适应平分。
  // 真正的值在 boot() 第一步由 loadPanels() 装进来（那时才拿得到当前论文，迁移要用）。
  panels: null,
  // 阶段 2.2b：浮窗动效日志（自动化探针逐条核对时长 / 缓动用的原始证据）、
  // 「最近碰过的面板」（Esc、Ctrl+Alt+←/→ 作用在它身上）、浮窗层叠序号。
  _panelAnimLog: [],
  _activePanel: '',
  _floatZ: 0,
  attachments: [],      // 待发送的附件：{id,kind:'text'|'image',page,text?,dataUrl?,w?,h?,label?}
  blockEls: {},
  blockMeta: {},
  splitEls: {},
  dragBlock: null,
  // 「整篇」是一次明确的扩大范围操作，默认只带选中文字和当前页上下文。
  // 「联网」默认关着 —— 每问一句都先去搜一遍会平白慢一两秒，需要时点一下就行。
  // 不写 localStorage：它只对当前一次待发送的问题生效，成功 / 失败 / 停止后都会复位。
  useFullText: false,
  useWeb: readFlag('reader.web', false),
  docText: null,
  docTextDoc: null,
  docDigest: null,
  lastSources: [],
  // 文献关系：本文的参考文献列表 + 库内引用扫描结果
  refs: [],
  refsDoc: null,
  citedBy: [],
  citedByDoc: null,
  relBusy: false,
  relScanned: null,
  /**
   * 阶段 3：关系代际令牌。**只在换论文时 +1**（relBumpGen）。
   * 所有异步收尾（解析参考文献 / 扫描库内引用 / 单条查 PDF / 批量查）都要先校验
   * `gen === state.relGen && docId === state.doc?.docId`，对不上就整批丢弃 ——
   * 这是 R1/R2/R3/R5 的统一解法：切换论文后，旧论文的在途结果一个字都写不进来。
   *
   * 注意它**不**在「↻ 重新解析」时 +1：那条路径没换论文，在途的单条查询必须能
   * 按稳定 key 落回重建后的新对象，否则 ↻ 会把按钮永久卡在「查询中…」。
   * 「解析 vs 解析」的先后由 refsSeq 单独管。
   */
  relGen: 0,
  refsSeq: 0,
  /**
   * 阶段 3：引用条目的显式状态表 `key -> { key, docId, status, found, fail, guessed }`。
   * 以前 busy/found 直接挂在 ref 对象上，而 ref 对象在「↻ 重新解析」时会被整批换掉，
   * 在途请求的结果就写进了被丢弃的旧对象（busy 永远卡住）。
   * key 由内容派生（relKey = 编号 + 文本前 60 字），所以换了对象也找得回来。
   */
  relItemState: new Map(),
  /** 阶段 3：列表视图（搜索 / 筛选 / 排序 / 分组折叠）—— 只存内存，切论文重置，不写 localStorage */
  relView: { q: '', filter: 'all', sort: 'num', fold: { lib: false, pdf: false, todo: false, cited: false } },
  /** 关系面板顶部那一行的临时进度（解析 / 扫描 / 批量查询），单独存一份免得被重绘覆盖 */
  relHint: '',
  /** 正文引用卡片 [n] 当前在看哪一条：{ n, ref } */
  cite: null,
  // 论文操作：结果按 docId:opId 缓存（用缓存就不再花钱）；opsDone 只用于菜单里标「已生成」
  opsCache: new Map(),
  opsDone: {},
  opsDoc: null,
  coach: false,
  // 划词翻译的就地浮层只做生成中的临时反馈；完成后短暂保留方便用户看到收尾，
  // 随后自动收起，正式结果只留在右侧「译文」块里。
  popoverTimer: null,
};

let viewer = null;
let serverState = {};

/* ══════════════════════════════ 启动 ══════════════════════════════ */

(async function boot() {
  await Settings.load();
  // 清理 R1 以前可能留下的持久化偏好；「整篇」不再跨论文 / 跨会话记忆。
  try { localStorage.removeItem('reader.fullText'); } catch { /* ignore */ }
  fillSettings();
  // 第一件事：装面板注册表（必要时把老的 reader.ai 迁过来）。必须在 initLayout / initPanels 之前，
  // 因为两边栏的自动收展规则（dockHasPinned）与面板渲染都要读它。
  state.panels = loadPanels();
  // 右栏列数与第 2 栏宽度（同一份 reader.panels 里的 rightCols）
  loadRightCols();
  // 上一次运行残留的「暂离」标记：子窗口不会跨进程存活，主窗口统一恢复，避免面板永久失踪。
  // **恢复完必须立刻落盘**：只改内存的话，第二次启动又会从旧存档读回 visible=false
  //（这个坑 20:42 那轮踩过一次，这里保留同一条纪律）。
  if (!panelWindow.enabled && reconcileDetachedPanels()) {
    try { savePanels(); } catch { /* 忽略 */ }
  }
  // 历史存档归一化：右栏两块只认「第 1 / 第 2 栏」，老版本的浮窗 / 同栏两块都归位。
  // **顺序不能换**：adoptLegacyBothBlocks() 可能把列数开成 2，normalizeRightPanelModel()
  // 的分栏兜底只在「已经是 2 栏」时才生效（反过来先跑就会把两块都留在第 1 栏）。
  if (!panelWindow.enabled) {
    const adopted = adoptLegacyBothBlocks();
    const norm = normalizeRightPanelModel();
    if (norm || adopted) { try { savePanels(); } catch { /* 忽略 */ } }
  }
  initLayout();
  initPanels();
  initTopbar();
  initPanelSync();
  initViewer();
  initFiles();
  initSelection();
  initPopover();
  initNoteBox();
  initCiteBox();
  initAiArea();
  initComposer();
  initRegion();
  initSearch();
  initSettings();
  initShortcuts();
  initExternalLinks();
  initDraggableCards();
  initRelations();
  initOps();

  await loadServerState();
  // 服务端记住的「上次打开哪篇」这时才拿到：如果刚才的 reader.ai 迁移还没能认出当前论文，
  // 这里补一次 byDoc 覆盖（只在「刚迁移过」时发生，之后用户怎么摆就怎么算）
  const migrated = applyPanelMigration();
  if (migrated) { applyPanels(); applyResponsiveLayout(); }
  await refreshPaperList();
  await maybeReopenLast();
  initPanelWindow();
  checkConfigWarning();
})();

/* ══════════════════════════════ 布局 / 拖动调宽 / 响应式收展 ══════════════════════════════ */

/**
 * 响应式布局常量（与 style.css 里的同名令牌一一对应，改一处要改两处）
 *   VIEWER_MIN 正文最小可用宽度（--viewer-min）：放不下就收侧栏，而不是把 PDF 挤扁
 *   RAIL_W     活动栏宽度（--rail-w）：收起的一侧仍占这么宽（贴边的竖条）
 *   SPLIT_W    分隔条宽度（.splitter 是 flex: 0 0 5px）
 */
const VIEWER_MIN = 420;
const RAIL_W = 40;
const SPLIT_W = 5;

/** 拖动松手时的「收起阈值」：最终宽度比它小，就把这一侧直接收起来 */
const COLLAPSE_BELOW = { left: 140, right: 200 };

/** 宽度带 .14s 过渡，量正文宽度要等它走完（键盘微调这种宽度真的在变的路径用） */
const REFIT_AFTER_MS = 200;

/**
 * 布局意图。这里必须把两件事分清楚：
 *   sideIntent.noLeft/noRight  用户意图 —— 唯一会被写进 localStorage 的（reader.ui）
 *   state.autoCollapse         窗口太窄导致的自动收起 —— 只在内存里，绝不持久化
 * body.no-left / body.no-right = 用户意图 ∪ 自动收起，仍然是「收起」的唯一开关。
 * pinned：用户刚刚「明确展开过」的一侧，在当前窗口尺寸下不再被自动收起（窗口一变就作废）——
 * 否则窄窗里点活动栏展开会当场又被收起来，按钮等于坏的。
 */
const sideIntent = { noLeft: false, noRight: false, pinned: { left: false, right: false } };

/**
 * 两侧栏的**用户宽度意图**（拖动分隔条 / 读存档得到），与「这一刻实际生效的宽度」分开。
 *
 * 为什么必须分开：窗口变窄时侧栏会临时让宽（见 applyResponsiveLayout 的 SIDE_MIN 那一段），
 * 而 `--left-w` / `--right-w` 会被写成让宽后的值。如果读存档也从这两个变量读回来，
 * 那么「在窄窗口下关一次应用」就会把用户拖好的宽度永久改小 —— 和 autoCollapse 不许
 * 写进 reader.ui 是同一个道理。所以：**用户意图只从拖动与存档来，实际宽度只在布局里算。**
 */
const sideBaseW = { left: 210, right: 360 };

/** 读一个 px 令牌的数值（读不到就用兜底值） */
function cssPx(name, dflt) {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(v) ? v : dflt;
}

/** 正文重排：适配宽度模式重新按窗口算比例，手动缩放模式只重画可见页 */
function refitViewer(delay = 0) {
  const run = () => { if (viewer?._fitMode) viewer.fitWidth(); else viewer?._renderVisible(true); };
  if (delay > 0) setTimeout(run, delay); else run();
}

/**
 * 两侧是否还有「被用户固定（pinned）」的面板。
 * 注意与 sideIntent.pinned 区分：那个是 2.1 的**临时**豁免（用户刚明确展开过这一侧，
 * 在当前窗口尺寸下不再被自动收起，窗口一变就作废）；这里的 pinned 是用户在面板管理器里
 * 明确要求的「这一侧别自动收」，持久化在 reader.panels 里，只参与自动收起的先后顺序。
 */
const dockHasPinned = (dock) => PANEL_IDS.some((id) => state.panels?.[id]?.dock === dock && state.panels?.[id]?.pinned);

/**
 * 唯一的布局重算入口：按窗口宽度决定两侧栏收不收。
 *   放得下 → 按用户意图恢复（本次的临时豁免同时作废）
 *   放不下 → 先自动收「用户没固定面板」的那一侧；两侧都没固定 / 都固定，维持 2.1 的默认顺序（先右后左）
 * 每次都从「用户意图」重新算，不累积上一次的自动收起，所以窗口一变宽就自动撤销。
 * 返回：body 上的收起状态是否变了（调用方据此决定要不要立刻重排正文）。
 */
function applyResponsiveLayout() {
  // 面板窗口没有 PDF 正文，侧栏必须始终占满窗口，不能按阅读器的正文最小宽度自动收起。
  if (panelWindow.enabled) {
    state.autoCollapse = { left: false, right: false };
    const wasNoLeft = document.body.classList.contains('no-left');
    const wasNoRight = document.body.classList.contains('no-right');
    document.body.classList.remove('no-left', 'no-right');
    syncSideToggleButtons();
    return wasNoLeft || wasNoRight;
  }
  const innerW = window.innerWidth;
  const baseLeftW = sideBaseW.left;
  const baseRightW = sideBaseW.right;
  const rightW2 = cssPx('--right-w2', 360);
  const railW = cssPx('--rail-w', RAIL_W);
  const viewerMin = cssPx('--viewer-min', VIEWER_MIN);
  // 侧栏先「让宽」再「整条消失」（见下方 sideWanted 的注释）
  const SIDE_MIN = 220;
  /** 用户口径：「窄窗下不要出现横向滚动条、正文不能只剩一条缝」→ 正文硬下限就取
   *  --viewer-min（420）。⚠️ 这里**不能**降成一个很小的值：试过 200，结果 780px 窗口下
   *  右栏死活不收、正文被压到 200px —— 那是另一种坏（正文读不了）。
   *  真正的规则是「先让宽、再收起」：让宽的下限是 SIDE_MIN，让到最小还不够就整条收起。 */
  const VIEWER_HARD_MIN = viewerMin;

  // 右栏第 2 栏是可选的奢侈项：先让「两栏」用正文宽度买单，
  // 真的放不下再把它临时藏掉（只加 body.right-col2-off，**不动模型** ——
  // 窗口一变宽 2 栏自己回来，用户不用重新右键开一次），最后才轮到整条右栏收起。
  const col2Wants = rightColsWanted() === 2;
  const col2On = col2Wants && !document.body.classList.contains('right-col2-off');
  const chromeOf = (noLeft, noRight, withCol2, lw = baseLeftW, rw = baseRightW) =>
    (noLeft ? railW : lw + SPLIT_W) + (noRight ? railW : rw + SPLIT_W + (withCol2 ? rightW2 + SPLIT_W : 0));
  if (col2On) {
    // 第 2 栏只要「把两侧压到最小之后正文还剩得下」就不藏 —— 先把 --left-w / --right-w
    // 压到最小，实在不够才临时藏掉第 2 栏。这样开两栏时不会动不动就剩一栏。
    const squeezed = innerW - chromeOf(sideIntent.noLeft, false, true, SIDE_MIN, SIDE_MIN);
    if (squeezed < VIEWER_HARD_MIN) {
      document.body.classList.add('right-col2-off');
      renderCols();
    }
  } else if (!col2On && col2Wants) {
    const squeezed = innerW - chromeOf(sideIntent.noLeft, false, true, SIDE_MIN, SIDE_MIN);
    if (squeezed >= VIEWER_HARD_MIN) document.body.classList.remove('right-col2-off');
  }
  const col2Shown = col2Wants && !document.body.classList.contains('right-col2-off');

  /**
   * 侧栏的「让宽」：用户这次的诉求是
   *   「翻译部分窗口容易自动消失，翻译的内容应该是要记录在右侧那个里面的，不管打不打开」
   * 而旧逻辑是**阶跃**的：窗口一旦不够宽，整条右栏直接 display:none ——
   * 面板并没有真的消失（模型、消息、滚动位置都还在），但用户看到的就是「它没了」。
   * 所以这里改成**两级**：
   *   ① 先按需要把侧栏宽度往下压（下限 SIDE_MIN），正文优先；
   *   ② 压到最小还是放不下，才按原来的规则整条收起。
   * 强制收起只在「正文连 VIEWER_HARD_MIN 都保证不了」时发生。
   */
  let leftApplied = baseLeftW;
  let rightApplied = baseRightW;
  const chrome = (noLeft, noRight, lw, rw) => chromeOf(noLeft, noRight, col2Shown && !noRight, lw, rw);
  if (!sideIntent.noRight && col2Shown) {
    const need = innerW - chrome(sideIntent.noLeft, false, baseLeftW, baseRightW);
    if (need < viewerMin) {
      const deficit = viewerMin - need;
      leftApplied = Math.max(SIDE_MIN, baseLeftW - deficit / 2);
      rightApplied = Math.max(SIDE_MIN, baseRightW - deficit / 2);
      // 两边都压到最小还不够：把差额继续从右栏让它（正文保底 VIEWER_HARD_MIN）
      if (innerW - chrome(sideIntent.noLeft, false, leftApplied, rightApplied) < VIEWER_HARD_MIN) {
        rightApplied = Math.max(SIDE_MIN, innerW - chrome(sideIntent.noLeft, false, leftApplied, SIDE_MIN) - VIEWER_HARD_MIN + SIDE_MIN);
      }
    }
  }
  const fits = (noLeft, noRight) => innerW - chrome(noLeft, noRight, leftApplied, rightApplied) >= Math.min(viewerMin, VIEWER_HARD_MIN);

  let noLeft = sideIntent.noLeft;
  let noRight = sideIntent.noRight;
  if (fits(noLeft, noRight)) {
    // 放得下：用户刚「明确展开过」的临时豁免完成使命
    sideIntent.pinned.left = false;
    sideIntent.pinned.right = false;
  } else {
    // 阶段 2.2a：面板固定优先决定「先牺牲哪一侧」——
    // 只有右栏有固定面板 → 先收左栏；只有左栏有固定面板 → 先收右栏；
    // 两侧都有或都没有 → 维持 2.1 的默认顺序（先右后左）。
    // pinned 只影响这里的自动收起，用户手动收起（sideIntent）不受它影响。
    const pinLeft = dockHasPinned('left');
    const pinRight = dockHasPinned('right');
    const order = pinRight && !pinLeft ? ['left', 'right'] : ['right', 'left'];
    // ① 先收顺序里的第一侧（默认是右栏：输出区是可选项，优先牺牲它）
    if (order[0] === 'right') {
      if (!noRight && !sideIntent.pinned.right) noRight = true;
    } else if (!noLeft && !sideIntent.pinned.left) noLeft = true;
    // ② 还是放不下，才收另一侧
    if (order[1] === 'right') {
      if (!noRight && !sideIntent.pinned.right && !fits(noLeft, noRight)) noRight = true;
    } else if (!noLeft && !sideIntent.pinned.left && !fits(noLeft, noRight)) noLeft = true;
  }

  // 先把「让宽」的结果写到 CSS 变量上，再决定收不收 —— 顺序不能反：
  // fits() 是按实际宽度算的（cssPx 读的就是这两个变量），先写后判，判断才和屏幕上一致。
  const leftFinal = noLeft ? baseLeftW : leftApplied;
  const rightFinal = noRight ? baseRightW : rightApplied;
  const setVar = (name, v) => document.documentElement.style.setProperty(name, `${Math.round(v)}px`);
  // 只在真的需要让宽时动它：写的是实际生效值，窗口一放宽，上面算出的
  // leftApplied/rightApplied 自动回到用户原宽度，不需要任何额外的复位逻辑。
  if (Math.round(leftFinal) !== Math.round(cssPx('--left-w', baseLeftW))) setVar('--left-w', leftFinal);
  if (Math.round(rightFinal) !== Math.round(cssPx('--right-w', baseRightW))) setVar('--right-w', rightFinal);

  state.autoCollapse = { left: noLeft && !sideIntent.noLeft, right: noRight && !sideIntent.noRight };
  const wasNoLeft = document.body.classList.contains('no-left');
  const wasNoRight = document.body.classList.contains('no-right');
  document.body.classList.toggle('no-left', noLeft);
  document.body.classList.toggle('no-right', noRight);
  syncSideToggleButtons();
  // 右栏被收起 / 放开、第 2 栏被临时藏掉 / 放开，都会改「哪些块真的有地方放」：
  // 节点的停放与结果区的重排必须跟着走，否则会出现「栏收起来了，块还赖在 DOM 里」。
  renderCols();
  // 右栏是 display:none 的时候量不到高度，窗口 resize 里的 fitBlockSizes() 会把结果块
  // 压成 60px 保底值。这里（右栏刚好重新显示、布局已经能量了）补一次，恢复成记忆高度。
  if (wasNoRight && !noRight) fitBlockSizes();
  return wasNoLeft !== noLeft || wasNoRight !== noRight;
}

/**
 * 用户手动设置某一侧的收展（会写进 reader.ui），然后按窗口宽度重算。
 * pin=true 表示「用户明确要展开这一侧」（活动栏 / 顶栏 ▤ 用的是这个）。
 */
function setSideCollapsed(side, collapsed, pin = false) {
  if (side === 'left') sideIntent.noLeft = !!collapsed;
  else sideIntent.noRight = !!collapsed;
  sideIntent.pinned[side] = !collapsed && !!pin;
  const changed = applyResponsiveLayout();
  saveUi();
  // 收起 / 展开是 display 切换，宽度瞬间到位：立刻重排就不会出现「正文停在旧尺寸」
  refitViewer(changed ? 0 : REFIT_AFTER_MS);
}

/** 顶栏像 VS Code 一样提供左右栏的独立收展按钮。 */
function syncSideToggleButtons() {
  for (const side of ['left', 'right']) {
    const btn = document.getElementById(side === 'left' ? 'topbarLeftToggle' : 'topbarRightToggle');
    if (!btn) continue;
    const collapsed = document.body.classList.contains(`no-${side}`);
    const label = collapsed ? `展开${side === 'left' ? '左' : '右'}栏` : `收起${side === 'left' ? '左' : '右'}栏`;
    const icon = collapsed
      ? (side === 'left' ? 'panel-expand-left' : 'panel-expand-right')
      : (side === 'left' ? 'panel-collapse-left' : 'panel-collapse-right');
    btn.replaceChildren(iconEl(icon));
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', String(!collapsed));
  }
}

function bindSideToggleButton(side, btn) {
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const collapsed = document.body.classList.contains(`no-${side}`);
    setSideCollapsed(side, !collapsed, !collapsed);
  });
}

function initLayout() {
  const saved = readUi();
  uiStyle = { ...DEFAULT_UI_STYLE, ...(saved.style || {}) };
  applyUiStyle();
  if (saved.leftW) { sideBaseW.left = saved.leftW; document.documentElement.style.setProperty('--left-w', `${saved.leftW}px`); }
  if (saved.rightW) { sideBaseW.right = saved.rightW; document.documentElement.style.setProperty('--right-w', `${saved.rightW}px`); }
  // 阶段 2.2b：底部停靠区高度也恢复（拖动过才写；老存档没有这个字段 → 用 CSS 里的默认 240）
  if (saved.dockBottomH) setDockBottomHeight(saved.dockBottomH, { save: false });
  // 只恢复「用户意图」；自动收起由 applyResponsiveLayout() 按当前窗口宽度当场算
  sideIntent.noLeft = !!saved.noLeft;
  sideIntent.noRight = !!saved.noRight;
  // 右栏浮窗是右侧输出区的独占形态：即使是旧存档，也先收起右栏，避免两套入口同时占位。
  if (!panelWindow.enabled && floatPanels('right').some((id) => state.panels[id].visible)) {
    sideIntent.noRight = true;
    sideIntent.pinned.right = false;
  }
  applyResponsiveLayout();

  bindSideToggleButton('left', $('#topbarLeftToggle'));
  bindSideToggleButton('right', $('#topbarRightToggle'));
  syncSideToggleButtons();

  bindSplitter($('#splitLeft'), '--left-w', 150, 520, COLLAPSE_BELOW.left);
  bindSplitter($('#splitRight'), '--right-w', 240, 720, COLLAPSE_BELOW.right);
  initRails();

  // 旧的面板管理器按钮已经移除；面板管理器仍可从标题栏 / 右键入口打开。
  $('#panelBtn')?.addEventListener('click', (e) => {    e.stopPropagation();
    togglePanelMenu($('#panelBtn'));
  });

  // 窗口尺寸变化：先让「明确展开」的豁免作废（自动规则重新生效），再重算
  window.addEventListener('resize', debounce(() => {
    sideIntent.pinned.left = false;
    sideIntent.pinned.right = false;
    if (applyResponsiveLayout()) refitViewer(0);
    // 阶段 2.2b：窗口变小 / 变窄时把浮窗重新钳进视口 —— 绝不出现「跑到屏幕外拿不回来」
    clampAllFloats();
  }, 120));
}

/** 活动栏：点一下 = 展开对应侧栏，并把那一块滚到可见（2.2a：目标改成 data-panel，与面板管理器同一份模型）
 *
 *  左栏的口径（用户 2026-10-03）：
 *    「左侧应该也做成一次只能打开一个。而且再次点击选中的就直接收起收成小的侧边栏。
 *      然后点击侧边栏应该出来的就是点击的哪一个。」
 *  所以左栏有**三级**，不再是「展开 / 收起」两态：
 *    ① 展开且显示某一块     —— 点别块的图标 → 换成那一块；点自己那块（在左栏内）→ 收到 ②
 *    ② 收起成图标活动栏     —— 点图标 → 展开并显示**那一个**；点上次选的那个 → 回到 ① 的同一块
 *    ③ 文件块的筛选框等内部折叠（p.collapsed）—— 与 ①② 正交，点标题栏管的是它
 *  选中态高亮的判据是「这一块此刻在左栏里显示着」，而不是「上次点过谁」—— 界面不许骗人。 */
function initRails() {
  const targets = { files: 'files', outline: 'outline', notes: 'notes', rel: 'relations' };
  $$('#railLeft .rail-btn').forEach((btn) => {
    btn.onclick = () => {
      const id = targets[btn.dataset.rail];
      if (!id) return;
      const expanded = !document.body.classList.contains('no-left');
      const wasVisible = !!state.panels?.[id]?.visible;
      // 「再次点击选中的」= 这一块正显示着、左栏也开着 → 收成活动栏（不隐藏块本身）
      if (expanded && wasVisible) { setSideCollapsed('left', true); return; }
      rememberLeftChoice(id);            // 点活动栏出来的就是点的这一个，并且记住它
      setSideCollapsed('left', false, true);
      setPanelVisible(id, true);         // 内部会把左栏其余三块收起（一次只开一个）
      syncRailActive();
      // 展开是 display 切换，同步量一次布局就能滚（roll 的是 .side.left 这个滚动容器）。
      // 面板正浮着的时候别去滚它 —— 浮窗是 fixed 的，滚它只会把外层容器带偏。
      if (state.panels?.[id]?.dock !== 'float') {
        const target = panelEl(id);
        if (target) target.scrollIntoView({ block: 'start' });
      }
    };
  });
  const rightBtn = $('#railRightBtn');
  if (rightBtn) rightBtn.onclick = () => setSideCollapsed('right', false, true);
  syncRailActive();
}

/**
 * 顶栏自动隐藏（用户口径 2026-10-03）：
 *   「在阅读的时候，最上面那一栏应该是鼠标悬停在上面才出现，鼠标移走就收起。」
 *   「控件需要下移的可以跟着下移，文章不动。」
 *
 * 为什么**以指针位置为准**，而不是给热区和顶栏各挂 mouseenter：
 *   顶栏收起时是 translateY(-100%)，整个在屏幕外。凡「按坐标点击」的路径
 *   （自动化脚本、辅助工具、以及任何先算坐标再点的实现）都会因为目标是屏幕外元素而失败 ——
 *   实测这直接把既有套件打红（page.click('#opsBtn') 抛 "Node is either not clickable"）。
 *   改成「指针落在屏幕顶部这一条带里就展开」之后：真实用户「移上去就出现」的手感不变，
 *   按坐标点击也会先把指针移进去 → 顶栏展开 → 自然点得到。
 *
 * 四条纪律（每条对应一个会咬人的场景）：
 *   ① 触发带只有屏幕顶部 8px。顶栏滑下来后由顶栏本体接管 hover，
 *      不会中途判定为离开 —— 不需要再单独维护一个 hover 组。
 *   ② **焦点优先**：焦点在顶栏里（Tab 走进去、或点完按钮焦点留在按钮上）就保持展开。
 *   ③ 焦点在输入控件（页码框）上时不自动收 —— 打字打到一半顶栏滑走最烦人。
 *   ④ 手上有活时不收：拖分隔条 / 拖面板出窗 / 正在跑操作（state.busy）都强制展开，
 *      免得顶栏在拖动过程中一开一合把布局量歪。
 */
const TOPBAR_TRIGGER_H = 8;     // 收起时只留 8px 触发带，避免正文稍微靠上就误触
/**
 * 顶栏自动隐藏的开关（默认开；用户口径 2026-10-03 要求「悬停才出现、移走就收起」）。
 *
 * 为什么必须留一个关掉它的办法：
 *   自动隐藏 = 顶栏在静息态整个移到屏幕外，于是**任何按坐标点击顶栏控件的路径都会失败**
 *   （自动化脚本、辅助技术、以及「先算坐标再点」的实现都会报 "node is not clickable"）。
 *   这不是可以忽略的边角：无障碍工具与既有自动化都走这条路。所以：
 *     · `?topbar=static`（或 localStorage reader.topbarAuto='0'）→ 常驻，一切可点击；
 *     · 设置里的「更多样式」是否暴露这个开关由后续决定，但入口先留好。
 *   这也是本仓库既有的做法：面板的「自动收起」等行为都有类似的显式开关或回退。
 */
function topbarAutoEnabled() {
  try {
    // ① URL 开关优先级最高：自动化与「我这次就想常驻」都用它
    const q = new URL(location.href).searchParams;
    const v = q.get('topbar');
    if (v === 'static' || v === '0') return false;
    if (v === 'auto' || v === '1') return true;
    // ② 设置里的「顶栏：悬停才出现 / 常驻」（localStorage reader.topbarAuto）
    if (localStorage.getItem('reader.topbarAuto') === '0') return false;
    if (localStorage.getItem('reader.topbarAuto') === '1') return true;
  } catch { /* 拿不到就用默认 */ }
  return true;   // ③ 默认：悬停才出现（用户口径）
}

/** 用户改了「顶栏」设置：写偏好 + 立刻切换 body 类（不必刷新） */
function applyTopbarPref(mode) {
  const auto = mode !== 'static';
  try { localStorage.setItem('reader.topbarAuto', auto ? '1' : '0'); } catch { /* 忽略 */ }
  const wasAuto = document.body.classList.contains('topbar-auto');
  if (auto === wasAuto) return;
  if (auto) {
    document.body.classList.remove('topbar-static');
    initTopbar();
  } else {
    document.body.classList.remove('topbar-auto', 'topbar-near');
    document.body.classList.add('topbar-static');
    const hot = $('#topbarHot');
    if (hot) hot.style.height = '';
  }
}

function topbarZoneHeight() {
  const h = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h')) || 0;
  return h > 0 ? TOPBAR_TRIGGER_H : 0;   // 面板窗口 --topbar-h 是 0 → 不提供触发带
}

function initTopbar() {
  const bar = $('#topbar');
  const hot = $('#topbarHot');
  if (!bar) return;
  // 没有热区（老 DOM / 面板窗口）或用户关掉了自动隐藏 → 常驻，不做半套自动隐藏
  if (!hot || !topbarAutoEnabled()) { document.body.classList.add('topbar-static'); return; }
  const zone = topbarZoneHeight();
  if (!zone) { document.body.classList.add('topbar-static'); return; }
  document.body.classList.add('topbar-auto');
  hot.style.height = `${zone}px`;

  let pointerActive = false;
  let inZone = false;
  let pinUntil = 0;        // 操作期间的强制展开截止时刻
  let hideTimer = 0;

  const busyNow = () => {
    if (performance.now() < pinUntil) return true;
    if (state.busy) return true;
    return ['panel-dragging', 'row-dragging', 'dragging', 'panel-drag-out']
      .some((c) => document.body.classList.contains(c));
  };
  const focusInForm = () => {
    const a = document.activeElement;
    return !!(a && bar.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  };
  /** 焦点在顶栏里（含按钮）也算「用户正在用顶栏」—— 键盘用户与点完按钮之后都靠这条 */
  const focusInBar = () => !!(document.activeElement && bar.contains(document.activeElement));

  const want = () => inZone || pointerActive || bar.matches(':hover') || busyNow() || focusInForm() || focusInBar();
  /**
   * ⚠️ 状态类叫 `topbar-near`，**不能**叫 `topbar-hot`。
   *
   * 真实事故：状态类原来叫 `topbar-hot`，而热区元素 `<div class="topbar-hot" id="topbarHot">`
   * 的类名也是 `.topbar-hot`，CSS 里 `.topbar-hot { position:fixed; height:var(--topbar-hot);
   * z-index:45; background:transparent }`。于是 `classList.add('topbar-hot')` 一执行，
   * **`<body>` 自己**就命中了那套样式 → body 变成屏幕顶部 56px 高的透明固定条，
   * `#main` 与整个 PDF 阅读区随之消失。用户实测原话：
   * 「鼠标移上去就会出现一个大色块把整个屏幕除了上面一条遮住，移走就消失」。
   * 排查手段：CDP 的 `CSS.getMatchedStylesForNode(body)` 直接报出 body 命中了 `.topbar-hot`。
   * 结论：**body 上的状态类必须与任何元素类名不同名**，这里用 `topbar-near` 彻底隔开。
   */
  const sync = () => { document.body.classList.toggle('topbar-near', want()); };
  const scheduleHide = () => { clearTimeout(hideTimer); hideTimer = setTimeout(sync, 80); };

  // 指针位置是唯一真相：落进顶部触发带 → 立刻展开，离开后就允许收起。
  const onMove = (y) => {
    inZone = y <= zone;
    /*
     * 顶栏是「移到顶部才出现」，不是「鼠标在窗口任意位置活动就出现」。
     * 旧逻辑把每一次 pointermove 都设成 pointerActive=true，导致阅读区里
     * 只要移动鼠标，顶栏就会滑下来并压住两侧栏。这里让活动状态只代表
     * 指针仍在顶部触发带内；离开触发带后由 CSS :hover / busy / focus 负责
     * 保留必要的交互状态。
     */
    pointerActive = inZone;
    clearTimeout(hideTimer);
    sync();
  };
  document.addEventListener('pointermove', (e) => onMove(e.clientY), { passive: true });
  document.addEventListener('pointerdown', (e) => onMove(e.clientY), { passive: true });
  // 指针离开窗口（移到别的应用 / 屏幕外）：立刻按 want() 收
  document.addEventListener('pointerleave', () => { pointerActive = false; scheduleHide(); });
  window.addEventListener('blur', () => { pointerActive = false; scheduleHide(); });
  // 触摸屏没有 hover：点一下触发带 = 把顶栏叫出来 4 秒
  hot.addEventListener('click', () => {
    pinUntil = performance.now() + 4000;
    sync();
    setTimeout(sync, 4100);
  });
  // 键盘：焦点进 / 出顶栏都要重算
  bar.addEventListener('focusin', sync);
  bar.addEventListener('focusout', () => setTimeout(sync, 0));
  // 点顶栏里的任何按钮都续命一会儿（操作菜单 / 设置弹窗这类会立刻用顶栏做锚点）
  bar.addEventListener('click', () => {
    pinUntil = performance.now() + 1500;
    sync();
    setTimeout(sync, 1600);
  }, true);
  // 页面加载时先亮一下再收：让用户知道「原来顶栏在这儿」
  document.body.classList.add('topbar-near');
  pinUntil = performance.now() + 1200;
  setTimeout(sync, 1300);
}

/** 左栏当前该高亮哪个图标：优先「此刻真正显示着的那一块」，都没有就退回上次的选择 */
function leftActiveId() {
  const shown = PANEL_IDS.find((id) => !isRightPanel(id) && state.panels?.[id]?.dock === 'left' && state.panels[id].visible);
  return shown || readLeftChoice();
}

/** 把高亮落到图标上（aria-current 也一起，读屏能跟上） */
function syncRailActive() {
  const active = leftActiveId();
  for (const btn of $$('#railLeft .rail-btn')) {
    const id = { files: 'files', outline: 'outline', notes: 'notes', rel: 'relations' }[btn.dataset.rail];
    const on = id === active;
    btn.classList.toggle('active', on);
    if (on) btn.setAttribute('aria-current', 'true');
    else btn.removeAttribute('aria-current');
  }
}

/**
 * 六个面板统一走这一条渲染路径（左栏四块 + 右栏两块）。
 * 左栏**不重写内部结构**：文件块用 .side-head 当标题栏，其余三块沿用 section.sec + .sec-head，
 * 只补 data-panel 与标题栏上的折叠开关 / ⋯ 按钮（内部所有 id 一个都没动）。
 * 节点一定是从 DOM 里找出来的那一个，绝不重建 —— 否则消息与滚动位置会丢。
 */
function ensurePanel(id, def) {
  const p = state.panels[id];
  let node = panelEl(id);
  if (!node) {
    // 文件块：DOM 里就是左栏顶部那条 .side-head（筛选框 / 拖入区 / 文件列表是它的兄弟节点，
    // 所以收起时用 CSS 的 .side-head[data-collapsed] + 相邻兄弟规则把它们一起收起来）
    if (id === 'files') {
      node = $('#leftSide .side-head');
      if (!node) return null;
      node.classList.add('panel');
    } else {
      // 左栏三块的节点按**结构位置**认领（第 1 个 section.sec = 目录、第 2 个 = 笔记、
      // 第 3 个 = 文献关系）。这里不能只靠 [data-panel] 查：那段属性是本函数第一次跑时才写上去的，
      // 第一次进来时 DOM 里根本还没有这个标记，查不到就会把三个面板全漏掉、顺序也排不动。
      const idx = PANEL_DEFS.filter((d) => d.dock === 'left').findIndex((d) => d.id === id) - 1;
      if (idx >= 0) node = $$('#leftSide > section.sec')[idx] || null;
      // 右栏两块不在这里建：它们由 ensureBlock() 现建（本来就不是静态 DOM）
      if (!node) return null;
    }
  }
  node.dataset.panel = id;
  node.dataset.dock = p.dock;

  const head = panelHeadEl(id);
  if (head && !head.dataset.panelBound) {
    head.dataset.panelBound = '1';
    bindPanelHead(id, head);
    bindDockPanelDrag(id, head);
    // 可见抓手：位置固定、每块面板都有，不必赌「标题栏哪里是空白」
    if (!head.querySelector(':scope > .panel-drag-handle')) head.prepend(panelDragHandle());
    // VS Code 式操作行：⧉ 应用内卡片 / ⇱⇲ 浮窗 / ✕ 隐藏 / ⋯ 长尾操作
    if (!head.querySelector(':scope > .panel-actions')) head.append(panelActions(id));
    // 浮窗时的 ✕（收回到停靠区）；停靠状态下 CSS 让它 display:none，不占布局
    if (!head.querySelector(':scope > .panel-float-x')) head.append(panelFloatCloseButton(id));
  }
  // 文献关系默认只露出标题栏；标题本身就是明确入口，点击即可展开。
  // 其它面板保留原来的标题栏行为，避免误触改变文件/目录/笔记的布局。
  if (id === 'relations' && head && !head.dataset.relationClickBound) {
    head.dataset.relationClickBound = '1';
    head.title = '点击展开或收起文献关系';
    head.addEventListener('click', (e) => {
      if (e.target?.closest?.('button, input, select, a, .panel-drag-handle')) return;
      togglePanelCollapsed(id);
    });
  }
  node.classList.toggle('hidden', !p.visible);
  node.classList.toggle('panel-collapsed', p.collapsed);
  if (p.collapsed) node.setAttribute('data-collapsed', '');
  else node.removeAttribute('data-collapsed');
  if (head) head.setAttribute('aria-expanded', String(!p.collapsed));
  // 折叠 = 把 .ai-body（可滚动的那一层）从布局里摘掉，滚动位置本来会跟着丢；记一下补回来。
  // 位置同样挂在节点自己的 __prtScrollTop 上（与 rememberBlockScroll 一套口径）。
  if (p.dock !== 'right') return node;
  const body = state.blockMeta[id]?.body;
  if (!body) return node;
  if (p.collapsed) body.__prtScrollTop = body.scrollTop;
  else if (body.__prtScrollTop > 0) body.scrollTop = body.__prtScrollTop;
  return node;
}

function bindSplitter(node, cssVar, min, max, collapseBelow) {
  if (!node) return;
  const isLeft = cssVar === '--left-w';
  const side = isLeft ? 'left' : 'right';
  // 拖动 / 键盘微调 = 用户在改**宽度意图**，同步记进 sideBaseW。
  // （布局自动让宽走的是 document.documentElement.style.setProperty，不经过这里，
  //   所以「用户的宽度」和「这一刻生效的宽度」不会被搅在一起。）
  const setW = (px) => {
    const v = Math.round(px);
    document.documentElement.style.setProperty(cssVar, `${v}px`);
    sideBaseW[side] = v;
  };
  /**
   * 拖动时的下限：允许拖进「收起判定区」（比 min 再低一点）。
   * 否则 min=150/240 永远够不到 140/200 的阈值，4.4 就是死代码。
   * 注意这没改「展开后」的下限 —— 松手落在 [拖动下限, min) 之间会被夹回 min。
   */
  const dragFloor = Math.min(min, collapseBelow - 1);

  node.tabIndex = 0;
  node.setAttribute('role', 'separator');
  node.setAttribute('aria-orientation', 'vertical');
  node.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue(cssVar), 10) || min;
    const delta = (isLeft ? (e.key === 'ArrowRight' ? 16 : -16) : (e.key === 'ArrowLeft' ? 16 : -16));
    setW(clamp(current + delta, min, max));
    saveUi();
    refitViewer(REFIT_AFTER_MS);   // 宽度带过渡，等它走完再量正文
  });

  let startX = 0;
  let startW = 0;
  let lastDownAt = 0;      // 双击判定：两次 pointerdown 挨得很近、且位置几乎没动
  let lastDownX = 0;
  let lastToggleAt = 0;    // pointerdown 自检和原生 dblclick 只能有一个生效，别翻两次

  /** 双击分隔条 = 切换该侧收起 / 展开（用户手动行为，写 reader.ui） */
  const toggleSide = () => {
    const now = Date.now();
    if (now - lastToggleAt < 300) return;
    lastToggleAt = now;
    setSideCollapsed(side, !(side === 'left' ? sideIntent.noLeft : sideIntent.noRight));
  };

  const move = (e) => {
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 4) lastDownAt = 0;   // 这是一次真拖动，别让下一次 pointerdown 被当成双击
    // 左栏往右拖变宽；右栏往左拖才是变宽
    const w = clamp(isLeft ? startW + dx : startW - dx, dragFloor, max);
    setW(w);
    node.classList.toggle('will-collapse', w < collapseBelow);
  };
  const up = () => {
    node.classList.remove('dragging', 'will-collapse');
    document.body.classList.remove('dragging');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    const finalW = cssPx(cssVar, startW);
    if (finalW < collapseBelow) {
      // 拖到阈值以下 = 用户主动把这一侧拖没了：等同手动收起，**要写进 reader.ui**；
      // 宽度恢复成这一侧的记忆宽度（这次拖动开始前的宽度），下次展开还是这么宽
      setW(startW);
      setSideCollapsed(side, true);
      return;
    }
    const settled = clamp(finalW, min, max);
    setW(settled);
    applyResponsiveLayout();
    saveUi();
    // 只有「从收起判定区夹回 min」这种宽度真的在动的情况才需要等过渡结束
    refitViewer(Math.abs(settled - finalW) > .5 ? REFIT_AFTER_MS : 0);
  };
  node.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    // 双击：不要产生一次 0px 的拖动（虽然 0px 拖动本身不会误判成收起，但会白存一次 reader.ui）
    const now = Date.now();
    if (now - lastDownAt < 350 && Math.abs(e.clientX - lastDownX) <= 4) {
      lastDownAt = 0;
      toggleSide();
      return;
    }
    lastDownAt = now;
    lastDownX = e.clientX;
    startX = e.clientX;
    startW = parseInt(getComputedStyle(document.documentElement).getPropertyValue(cssVar), 10) || 240;
    node.classList.add('dragging');
    document.body.classList.add('dragging');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  // 原生 dblclick 兜底（pointerdown 上 preventDefault 之后，各浏览器行为不完全一致）
  node.addEventListener('dblclick', (e) => { e.preventDefault(); toggleSide(); });
}

function readUi() {
  try { return JSON.parse(localStorage.getItem('reader.ui') || '{}'); } catch { return {}; }
}

/**
 * 左栏「上次选中的是哪一块」。用途只有一个：活动栏收起时，点已被选中的那个图标要能
 * 原样展开回**同一块**，而不是随便挑一个。所以它必须持久化，跟着 reader.ui 一起走。
 * （点活动栏里别的图标会立刻改写它；点左栏内部那块图标则会把它清空，语义交给「此刻显示谁」。）
 */
function readLeftChoice() {
  const v = readUi().leftActive;
  return ['files', 'outline', 'notes', 'relations'].includes(v) ? v : 'files';
}
function rememberLeftChoice(id) {
  if (!['files', 'outline', 'notes', 'relations'].includes(id)) return;
  try {
    const old = readUi();
    old.leftActive = id;
    localStorage.setItem('reader.ui', JSON.stringify(old));
  } catch { /* 忽略 */ }
}

function saveUi() {
  const old = readUi();
  localStorage.setItem('reader.ui', JSON.stringify({
    ...old,
    // 存**用户意图**的宽度（sideBaseW），不是这一刻实际生效的宽度 ——
    // 窄窗下侧栏会让宽，把让宽后的值存下来等于把用户拖好的宽度改掉（同 autoCollapse 的纪律）。
    leftW: Math.round(sideBaseW.left) || 210,
    rightW: Math.round(sideBaseW.right) || 360,
    // 阶段 2.2b：底部停靠区高度（没有面板停靠到底部时它不显示，但高度记着）
    dockBottomH: parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dock-bottom-h'), 10) || 240,
    // 只存「用户意图」：窗口太窄导致的自动收起（state.autoCollapse）不能写进来，
    // 否则窄窗用过一次之后，下次开宽窗也还是收起的
    noLeft: !!sideIntent.noLeft,
    noRight: !!sideIntent.noRight,
    // 左栏活动栏「上次选中的是哪一块」（见 readLeftChoice 的注释）
    leftActive: readLeftChoice(),
    style: { ...old.style, ...uiStyle },
  }));
}

/** 浅色主题下的纸面米白 —— 深色主题下也用它（常量必须在 applyUiStyle 之前定义） */
const PAPER_TINT_LIGHT = (v) => {
  const s = String(v || '').trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) return '#F8F1DF';
  const r = parseInt(s.slice(1, 3), 16), g = parseInt(s.slice(3, 5), 16), b = parseInt(s.slice(5, 7), 16);
  // 太深的纸色（深色主题的 #2A2721）不能当纸面用：白纸黑字的文档一旦变成深纸黑字就没法读了
  return ((r * 299 + g * 587 + b * 114) / 1000) < 140 ? '#F8F1DF' : s;
};

function applyUiStyle() {
  const root = document.documentElement;
  const style = uiStyle;
  if (style.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = style.theme === 'dark' ? 'dark' : 'light';
  document.body.dataset.density = ['compact', 'standard', 'comfortable'].includes(style.density) ? style.density : 'standard';
  root.style.setProperty('--ai-fs', `${clamp(Number(style.fontSize) || 14, 12, 19)}px`);
  root.style.setProperty('--ai-lh', `${clamp(Number(style.lineHeight) || 1.72, 1.45, 2.05)}`);
  root.style.setProperty('--ai-code-fs', `${clamp(Number(style.codeSize) || 12, 10, 15)}px`);
  root.style.setProperty('--ai-max-width', `${clamp(Number(style.maxWidth) || 760, 480, 920)}px`);
  root.style.setProperty('--ai-opacity', `${clamp(Number(style.opacity) || 1, .82, 1)}`);
  root.style.setProperty('--surface-opacity', `${clamp(Number(style.opacity) || 1, .82, 1)}`);
  // 界面尺度：--ui-fs 只带界面文字（不碰 --ai-fs，也不影响控件高度），
  // --ctl-scale 只带控件尺寸（不影响界面文字，也不影响阅读字号）
  root.style.setProperty('--ui-fs', `${uiFontSizePx(style.uiFontSize)}px`);
  root.style.setProperty('--ctl-scale', `${ctlScaleOf(style.controlSize)}`);
  const paperMode = style.paper === 'white' ? 'white' : 'tint';
  /**
   * ⚠️ PDF 纸面**不跟随深色主题**（用户实测反馈 2026-10-04）：
   *   「调了保存之后，pdf 有的变深色有的不变深色，而且变深色的字体也没变成白色」。
   *
   * 原因链：
   *   ① 深色主题把 `--paper-tint` 设成 #2A2721（深暖灰），而下面这行原样把它写进 `--paper`；
   *   ② pdf.js 是**把纸面颜色画进位图**的（`page.render({ background: paper })`），
   *      连同 PDF 自己的黑字一起画上去 —— 底色变深、字**还是原来的黑字**，等于自毁可读性；
   *   ③ 主题切换这条路径**没有重画已渲染页面**（只有「设置 → PDF 纸面背景」那条会调
   *      `viewer.refreshPaper()`），于是先渲染的页仍是浅色、后渲染的页变深色 —— 一半一半。
   *
   * 修法：纸面只用浅色。`纯白` = #FFFFFF；`跟随界面` 用浅色纸色常量（#F8F1DF），
   * 深色主题下一律保持浅色纸（夜里看文档仍是白纸黑字，界面外壳才是深的）。
   */
  const paperTint = getComputedStyle(root).getPropertyValue('--paper-tint').trim();
  root.style.setProperty('--paper', paperMode === 'white' ? '#FFFFFF' : PAPER_TINT_LIGHT(paperTint));
  applyMessageVisibility();
}

function applyMessageVisibility() {
  for (const node of $$('#aiArea .msg')) {
    node.querySelector('.ref')?.classList.toggle('hidden', !uiStyle.showQuote);
    node.querySelectorAll('.pg, .role .tbtn').forEach((n) => n.classList.toggle('hidden', !uiStyle.showPage));
    node.querySelectorAll('.source-details').forEach((n) => { n.open = !!uiStyle.showSources; });
    const role = node.querySelector('.role');
    if (role) role.classList.toggle('hidden', !node.querySelector('.ava, .pg, .role .tbtn'));
  }
}

/* ══════════════════════════════ 阅读器 ══════════════════════════════ */

function initViewer() {
  viewer = new PdfViewer($('#viewer'), {
    onPageChange: (cur, total) => {
      $('#pageInput').value = String(cur);
      $('#pageCount').textContent = String(total || 0);
      saveProgress();
      checkScannedPage(cur);
    },
    onStatus: (s) => { $('#statusText').textContent = s; },
    onProgress: (done, total) => { $('#progressText').textContent = done < total ? `解析中 ${done}/${total}` : ''; },
    onScale: (scale) => syncZoom(scale),
    onNoteClick: (id) => openNoteEditorById(id),
    onCiteClick: (info) => handleCite(info),
  });
  window.__viewer = viewer;
  window.__settings = Settings;   // 方便调试 / 自动化测试
  window.__state = state;
  // 供自动化测试直接验证「全文上下文」和「相关段落检索」这两块纯逻辑
  window.__ctx = {
    buildDocContext, pickRelevantPages, webSearch, syncOptChips, PICK_K, openExternal,
    alignProbe: selectionAlignProbe, clearSelectionState,
    OPS, opById, opGroups, runOperation, doTranslate, doExplain, send, restoreSession, COACH, saveSessionNow,
    get FULL_LIMIT() { return FULL_LIMIT; },
    jumpToPageWithHistory, jumpToDestWithHistory, returnToPreviousPosition,
    updateSendScope, runSearch, stepHit, addToChat, addImageToChat, removeAttach,
    renderAttachments, refreshReturnButton,
    get uiStyle() { return uiStyle; },
    applyUiSettingsFromControls, resetLayout, resetStyle,
    // 阶段 2.2a：面板管理器的开关（自动化测试也用这一条，不用去点那个只在 hover 时可见的 ⋯）
    togglePanelMenu, resetPanels, setPanelsVisible, setPanelVisible,
    // 右栏列：译文 / 问答的归属与第 2 栏开关（自动化测试直接调这几个，省得模拟右键与拖拽）
    openRightColumn, closeRightColumn, setPanelColumn, rightColsWanted, colOf, rightPanelInCol,
    openPanelWindow,
    // 阶段 2.2b：停靠 / 浮出 / 收回（探针按这些跑，省得去模拟鼠标轨迹）
    floatPanel, dockPanelTo, redockFloats, clampAllFloats, closeFloatPanel,
    // 拖出应用内卡片 / 强制重排：验证「按住图标拖出去」这一条时必须能直接调（不必模拟指针轨迹）
    detachPanelToWindow, applyPanels,
    // 独立窗口状态闭环：探针直接调这一组，省得去凑关闭消息或真等 75 秒心跳超时
    releaseDetachedWindow, clearDetachedState, restoreDockState, detachWatchdogTick,
    detachedRuntime, panelDetached, readDetachedWindows,
    get panelAnimLog() { return state._panelAnimLog.slice(); },
    clearPanelAnimLog() { state._panelAnimLog.length = 0; },
    // 测试用：把「多长算太长」调小，才能在没有超长 PDF 的情况下验证索引分支
    setFullLimit(n) { FULL_LIMIT = n; },
  };

  $('#returnPosition').onclick = () => returnToPreviousPosition();

  $('#prevPage').onclick = () => viewer.goToPage(viewer.current - 1);
  $('#nextPage').onclick = () => viewer.goToPage(viewer.current + 1);
  $('#pageInput').addEventListener('change', (e) => {
    const n = parseInt(e.target.value, 10);
    if (!Number.isNaN(n)) viewer.goToPage(n);
    else e.target.value = String(viewer.current);
  });
  $('#pageInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });

  // PDF 大小调节
  $('#zoomIn').onclick = () => viewer.setScale(viewer.scale * 1.15);
  $('#zoomOut').onclick = () => viewer.setScale(viewer.scale / 1.15);
  $('#fitWidth').onclick = () => viewer.fitWidth();
  const range = $('#zoomRange');
  range.addEventListener('input', () => viewer.setScale(Number(range.value) / 100));
  range.addEventListener('dblclick', () => viewer.fitWidth());

  $('#viewer').addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    viewer.setScale(viewer.scale * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
  }, { passive: false });
}

function refreshReturnButton() {
  const button = $('#returnPosition');
  if (!button) return;
  const stack = state.doc ? state.jumpHistory.get(state.doc.docId) || [] : [];
  button.classList.toggle('hidden', !viewer?.pdf || state.viewerDocId !== state.doc?.docId || !stack.length);
  button.title = stack.length > 1
    ? `逐步返回之前的 ${stack.length} 个阅读位置`
    : '返回跳转前的阅读位置';
}

function recordReaderJump() {
  const docId = state.doc?.docId;
  if (!docId || state.viewerDocId !== docId || !viewer?.pdf) return;
  const stack = state.jumpHistory.get(docId) || [];
  stack.push({ docId, ...viewer.capturePosition() });
  if (stack.length > 50) stack.shift();
  state.jumpHistory.set(docId, stack);
  refreshReturnButton();
}

function pageJumpWouldMove(page) {
  const target = clamp(Math.round(Number(page) || 1), 1, viewer?.numPages || 1);
  const top = Number(viewer?.offsets?.[target]);
  const currentTop = Number(viewer?.container?.scrollTop || 0);
  return viewer?.current !== target || !Number.isFinite(top) || Math.abs(currentTop - top) > 4;
}

async function jumpToPageWithHistory(page, options = {}) {
  if (!viewer?.pdf || state.viewerDocId !== state.doc?.docId) return;
  if (pageJumpWouldMove(page)) recordReaderJump();
  return viewer.goToPage(page, options);
}

async function jumpToDestWithHistory(dest, options = {}) {
  if (!viewer?.pdf || state.viewerDocId !== state.doc?.docId) return;
  recordReaderJump();
  return viewer.goToDest(dest, options);
}

async function returnToPreviousPosition() {
  const docId = state.doc?.docId;
  const stack = docId ? state.jumpHistory.get(docId) : null;
  if (!stack?.length || !viewer?.pdf || state.viewerDocId !== docId) return;
  const previous = stack.pop();
  if (previous.docId !== state.doc?.docId) return;
  await viewer.restorePosition(previous);
  refreshReturnButton();
}

function syncZoom(scale) {
  const pct = Math.round(scale * 100);
  $('#zoomLabel').textContent = `${pct}%`;
  const r = $('#zoomRange');
  if (document.activeElement !== r) r.value = String(clamp(pct, Number(r.min), Number(r.max)));
}

function checkScannedPage(page) {
  if (!viewer?.pdf) return;
  const myDoc = state.doc?.docId;
  const myGen = viewer._gen;
  if (state.scannedHintShown === page) return;
  viewer.getPageText(page).then((t) => {
    if (state.doc?.docId !== myDoc || viewer?._gen !== myGen || !viewer?.pdf) return;
    if (t && t.replace(/\s/g, '').length > 40) return;
    if (state.scannedHintShown === page) return;
    state.scannedHintShown = page;
    toast(`第 ${page} 页没有文本层（扫描版？）→ 用顶部「⎚」框选交给视觉模型`, '', 5000);
  });
}

/* ══════════════════════════════ 文件 ══════════════════════════════ */

async function loadServerState() {
  try {
    const r = await fetch('/api/state');
    if (r.ok) serverState = await r.json();
  } catch { serverState = {}; }
}

const saveProgress = debounce(async () => {
  if (!state.doc || !viewer) return;
  const docs = { ...(serverState.docs || {}) };
  docs[state.doc.docId] = { page: viewer.current, scale: Number(viewer.scale.toFixed(3)), fit: !!viewer._fitMode, ts: Date.now(), name: state.doc.name };
  serverState = { ...serverState, docs, lastDoc: state.doc.docId, lastUrl: state.doc.url, lastName: state.doc.name };
  try {
    const r = await fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serverState),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    toastAction('阅读进度保存失败，当前进度仍在内存中。', '重试', () => saveProgressNow(), 'err', 10000);
  }
}, 500);

async function saveProgressNow() {
  if (!state.doc || !viewer) return;
  const docs = { ...(serverState.docs || {}) };
  docs[state.doc.docId] = { page: viewer.current, scale: Number(viewer.scale.toFixed(3)), fit: !!viewer._fitMode, ts: Date.now(), name: state.doc.name };
  const payload = { ...serverState, docs, lastDoc: state.doc.docId, lastUrl: state.doc.url, lastName: state.doc.name };
  const r = await fetch('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  serverState = payload;
  toast('阅读进度已保存', 'ok');
}

async function refreshPaperList() {
  try {
    const r = await fetch('/api/papers');
    if (r.ok) state.papers = (await r.json()).papers || [];
  } catch { state.papers = []; }
  renderPaperList();
}

function renderPaperList() {
  const list = $('#fileList');
  const filter = ($('#fileFilter').value || '').trim().toLowerCase();
  list.innerHTML = '';
  const items = state.papers.filter((p) => !filter || p.name.toLowerCase().includes(filter));
  if (!items.length) {
    list.append(el('li', {
      class: 'empty',
      text: state.papers.length ? '没有匹配的文件' : 'papers/ 里还没有 PDF',
    }));
    return;
  }
  for (const p of items) {
    const li = el('li', {
      title: `${p.name}\n${fmtSize(p.size)}`,
      text: p.name.replace(/\.pdf$/i, ''),
      dataset: { id: p.docId },
      onclick: () => openDoc({ name: p.name, url: p.url, docId: p.docId }),
    });
    if (state.doc?.url === p.url) li.classList.add('active');
    list.append(li);
  }
}

function initFiles() {
  const dz = $('#dropzone');
  $('#fileFilter').addEventListener('input', debounce(renderPaperList, 150));
  $('#fileInput').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) openLocalFile(f);
    e.target.value = '';
  });
  for (const ev of ['dragenter', 'dragover']) {
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); });
  }
  for (const ev of ['dragleave', 'drop']) dz.addEventListener(ev, () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) openLocalFile(f);
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f && /\.pdf$/i.test(f.name)) openLocalFile(f);
  });
}

let localObjectUrl = null;

/**
 * 打开本地 PDF：先上传到服务端的 papers/ 存下来，再从服务端打开。
 * 这样下次启动还在列表里（以前用 blob URL，关掉就没了）。
 * 万一上传失败（比如 papers/ 不可写），退回临时打开，至少还能看。
 */
async function openLocalFile(file) {
  if (!/\.pdf$/i.test(file.name)) { toast('只支持 PDF 文件', 'err'); return; }
  setBusy(true, '正在导入…');
  try {
    const buf = await file.arrayBuffer();
    const r = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: buf,
    });
    let j = {};
    try { j = await r.json(); } catch { /* 非 JSON */ }
    if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
    await refreshPaperList();
    await openDoc({ name: j.name, url: j.url, docId: j.docId });
    toast(`已存到 papers/：${j.name}`, 'ok', 2600);
  } catch (e) {
    toast(`导入失败（${e.message}），先用临时方式打开`, 'err', 5000);
    if (localObjectUrl) URL.revokeObjectURL(localObjectUrl);
    localObjectUrl = URL.createObjectURL(file);
    await openDoc({ name: file.name, url: localObjectUrl, docId: `local-${file.name}-${file.size}` });
  } finally {
    setBusy(false);
  }
}

async function openDoc({ name, url, docId }) {
  cancelSearch({ clearInput: true, close: true, focus: false });
  abortStream('document-switch');
  if (state.doc && state.sessionEntries.length) {
    persistSession.cancel?.();
    try {
      if (sessionSaveInFlight) await sessionSaveInFlight;
      await saveSessionNow();
    } catch (e) {
      toastAction(`当前会话保存失败，仍停留在「${state.doc.name}」。`, '重试', async () => {
        await saveSessionNow();
        toast('会话已保存，现在可以切换论文', 'ok');
      }, 'err', 12000);
      return;
    }
  }
  /**
   * 这一次打开的「身份」。用单调递增的序号而不是 docId 来判断有没有被顶替：
   * 同一篇文档可能被并发打开两次（比如启动时自动恢复上次的论文，用户同时又点了列表里的它），
   * 那时 docId 相同，旧的判断会以为「我仍然是当前文档」，于是被中断的那次加载
   * 会在 catch 里把界面清成「未打开文档」—— 而 PDF 其实已经显示出来了。
   */
  const myOpen = (state.openSeq = (state.openSeq || 0) + 1);
  const superseded = () => myOpen !== state.openSeq;
  state.selection = null;
  state.scannedHintShown = null;
  state.doc = { name, url, docId };
  // 面板布局不再按论文分叉（阶段 2.2a）：换论文不重载 state.panels
  state.viewerDocId = null;
  /**
   * 阶段 2.2b：换论文时把所有浮窗自动收回停靠。
   * 浮在屏幕上的面板若显示的还是上一篇的内容，比「布局被重置」糟糕得多；
   * 同一篇论文重新打开（刷新 / 重进）时 docId 相同，浮窗保持原样（位置 / 大小都还在）。
   */
  redockFloatsForDoc(docId);
  refreshReturnButton();
  document.title = `${name} · 论文阅读器`;
  $('#docName').textContent = name;
  $('#docName').title = name;
  $('#welcome').classList.add('hidden');
  clearAllBlocks();
  state.attachments = [];
  renderAttachments();
  viewer.paintSelection(null);

  state.history = [];
  state.sessionEntries = [];
  state.cache.clear();
  // 换论文了：整篇文本和阅读索引都作废；单次范围也随论文切换复位。
  state.docText = null;
  state.docTextDoc = null;
  state.docDigest = null;
  state.useFullText = false;
  // 换论文了：文献关系重新整理（异步，不挡打开）。
  // 阶段 3：先把代际令牌抬一格，再清状态 —— 旧论文在途的解析 / 扫描 / 查询回来时
  // 会发现自己是上一代，整批丢弃，一个字都不写进新论文（R1/R2/R3/R5）。
  relBumpGen();
  state.refs = [];
  state.refsDoc = null;
  state.citedBy = [];
  state.citedByDoc = null;
  state.relScanned = null;
  state.relBusy = false;        // R5：不重置的话，扫描在途时切论文会让新论文的按钮永久灰着
  state.relHint = '';
  state.relItemState.clear();   // 条目状态跟着论文走（key 只保证在同一篇论文内稳定）
  resetRelView();               // 搜索 / 筛选 / 排序 / 折叠只活在内存里，换论文即重置
  // 正文引用卡片也是上一篇的：不清的话「找这篇的 PDF」会拿上一篇的文献去查
  state.cite = null;
  $('#citeBox')?.classList.add('hidden');
  // 换论文：操作结果不再适用（缓存按 docId 存，别串到新论文头上）
  state.opsDone = {};
  state.opsDoc = null;
  hideOpsMenu();
  renderRelations();
  setHint('');
  syncOptChips();
  hidePopover();
  $('#statusText').textContent = '正在打开…';
  for (const li of $$('#fileList li')) li.classList.toggle('active', li.dataset.id === docId);

  try {
    const r = await viewer.load(url, name);
    if (superseded()) return;
    if (r?.stale) return;
  } catch (e) {
    // 被后一次打开顶替了、或者这次加载本来就被中断 → 一律不动界面
    if (superseded() || isAbortish(e)) return;
    toast(`打开失败：${e.message}`, 'err', 6000);
    state.doc = null;
    state.viewerDocId = null;
    document.title = '论文阅读器';
    $('#docName').textContent = '未打开文档';
    $('#docName').title = '';
    $('#welcome').classList.remove('hidden');
    $('#statusText').textContent = '打开失败';
    $('#pageInput').value = '–';
    $('#pageCount').textContent = '–';
    $('#progressText').textContent = '';
    for (const li of $$('#fileList li')) li.classList.remove('active');
    refreshReturnButton();
    syncOptChips();
    checkConfigWarning();
    return;
  }
  if (superseded()) return;
  const saved = serverState.docs?.[docId];
  /**
   * 打开论文时优先「自动匹配到最合适的大小」：
   *   · 用户从没手动缩放过（或是老记录、没有 fit 字段）→ 按当前窗口宽度适配；
   *   · 用户明确拖过缩放（fit === false）→ 还原他自己挑的比例。
   * 旧代码是无条件套用存下来的 scale，窗口大小一变化就对不上了。
   */
  const userZoomed = !!(saved && saved.fit === false && saved.scale > 0.2);
  if (userZoomed) {
    viewer.setScale(saved.scale, { keepCenter: false });
    viewer._fitMode = false;   // setScale 可能因为数值相同而提前返回，这里补一刀
  } else {
    viewer.fitWidth();
  }
  if (superseded()) return;
  syncZoom(viewer.scale);
  await renderOutline();
  await renderNotes();
  if (superseded()) return;
  await restoreSession(docId);
  if (superseded()) return;
  if (saved?.page && saved.page > 1) await viewer.goToPage(saved.page);
  if (superseded()) return;
  state.viewerDocId = docId;
  refreshReturnButton();
  saveProgress();
  $('#statusText').textContent = '就绪';
  syncOptChips();
  // 默认不提前提取整篇；用户点「整篇」后才读取，避免打开每篇论文都做无用工作。
  // 文献关系：后台整理本文引用了谁、谁引用了本文（不挡阅读）
  buildRelations();
}

/** pdf.js 在加载任务被销毁时会抛这类异常，属于「这次加载作废了」，不是真失败 */
const isAbortish = (e) => /abort|destroy|cancel|stale/i.test(`${e?.name || ''} ${e?.message || ''}`);

/* ══════════════════════════════ 目录 / 笔记 ══════════════════════════════ */

async function renderOutline() {
  const list = $('#outlineList');
  const myDoc = state.doc?.docId;
  list.innerHTML = '';
  $('#outlineCount').textContent = '';
  if (!viewer?.pdf) return;
  let items = [];
  try { items = await viewer.getOutline(); } catch { items = []; }
  if (state.doc?.docId !== myDoc) return;
  if (!items.length) {
    list.append(el('li', { class: 'empty', text: '这篇 PDF 没有书签目录' }));
    return;
  }
  $('#outlineCount').textContent = `(${items.length})`;
  for (const it of items) {
    list.append(el('li', {
      class: `lv${Math.min(5, it.level)}`,
      title: it.top !== null && it.top !== undefined ? `${it.title}（点它标题会顶到最上面）` : it.title,
      text: it.title,
      // 有目标 Y 就精确停在标题上；没有（Fit/FitV 这类）才退回滚到页顶
      onclick: () => { if (it.page) jumpToDestWithHistory(it, { smooth: true }); },
    }));
  }
}

async function renderNotes() {
  const list = $('#notesList');
  const myDoc = state.doc?.docId;
  list.innerHTML = '';
  if (!myDoc) return;
  try {
    const r = await fetch(`/api/notes?doc=${encodeURIComponent(myDoc)}`);
    if (state.doc?.docId !== myDoc) return;
    if (r.ok) state.highlights = (await r.json()).items || [];
  } catch { /* 忽略 */ }
  if (state.doc?.docId !== myDoc) return;
  viewer?.setHighlights(state.highlights);
  $('#notesCount').textContent = state.highlights.length ? `(${state.highlights.length})` : '';
  if (!state.highlights.length) {
    list.append(el('li', { class: 'empty', text: '还没有笔记' }));
    return;
  }
  for (const h of [...state.highlights].sort((a, b) => (b.ts || 0) - (a.ts || 0))) {
    list.append(el('li', {
      dataset: { id: h.id },
      title: h.note || h.text || '',
      onclick: (e) => {
        if (e.target.closest('.nact')) return;
        if (h.page) jumpToPageWithHistory(h.page, { smooth: true });
      },
    },
      el('div', { class: 'np', text: `p.${h.page}${h.note ? ' · 有笔记' : ''}` }),
      el('div', { class: 'nt', text: h.text }),
      h.note ? el('div', { class: 'nt nnote', text: h.note }) : null,
      el('div', { class: 'nact' },
        el('button', { title: '写 / 改笔记', onclick: () => openNoteEditor(h) }, iconEl('pencil', { size: 14 })),
        el('button', { class: 'del', title: '删除', onclick: () => deleteNoteItem(h.id) }, iconEl('close', { size: 14 })),
      ),
    ));
  }
}

async function saveNotes() {
  if (!state.doc) return;
  const r = await fetch(`/api/notes?doc=${encodeURIComponent(state.doc.docId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: state.highlights }),
    });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

async function addHighlight(sel, note = '') {
  if (!sel) return;
  const text = sel.cleanText || cleanText(sel.text || '');
  const groups = sel.rectsByPage && Object.keys(sel.rectsByPage).length
    ? sel.rectsByPage
    : { [sel.page || viewer?.current || 1]: sel.rects || [] };
  const added = [];
  for (const [pageStr, rects] of Object.entries(groups)) {
    added.push({
      id: `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      page: Number(pageStr),
      rects: rects || [],
      text: text.slice(0, 2000),
      note: added.length === 0 ? note : '',
      ts: Date.now(),
    });
  }
  if (!added.length) return;
  state.highlights.push(...added);
  viewer?.setHighlights(state.highlights);
  await saveNotes();
  await renderNotes();
  return added[0];
}

/* ══════════════════════════════ 正文引用 → 文献 ══════════════════════════════ */
/* 点正文里的 [12]：跳到文末那条参考文献，并可以一键去 arXiv/OpenAlex/Crossref 找它的 PDF */

function initCiteBox() {
  $('#citeClose').onclick = () => $('#citeBox').classList.add('hidden');
  $('#citeSearch').onclick = () => searchCite();
  $('#citeReturn').onclick = async () => {
    await returnToPreviousPosition();
    $('#citeBox').classList.add('hidden');
  };
  // 阶段 3：详情面板（从关系列表点进来时没有「返回原位置」这个语义，改用「跳回正文」）
  $('#citeJump').onclick = () => jumpToCiteInBody();
  $('#citeCopy').onclick = () => copyText(state.cite?.ref?.text || '');
  document.addEventListener('mousedown', (e) => {
    if ($('#citeBox').classList.contains('hidden')) return;
    if (e.target.closest('#citeBox') || e.target.closest('.cite-link')) return;
    $('#citeBox').classList.add('hidden');
  });
}

/** 详情面板的「跳回正文」：到 PDF 里这条参考文献所在的页面去，并收起卡片 */
function jumpToCiteInBody() {
  const page = Number(state.cite?.ref?.page) || 0;
  $('#citeBox').classList.add('hidden');
  if (page > 0) jumpToPageWithHistory(page, { smooth: true });
}

async function handleCite({ nums, page, anchor }) {
  const n = nums[0];
  const ref = await viewer.findReference(n);
  if (!ref) { toast(`正文里没找到 [${n}] 对应的文献条目`, 'err', 3000); return; }
  const onReferencePage = ref.page === page
    || (state.refsDoc === state.doc?.docId
      && state.refs.some((item) => item.page === page));
  showCiteBox(n, ref, anchor, { canReturn: !onReferencePage });
  if (!onReferencePage) jumpToPageWithHistory(ref.page, { smooth: true });
}

function placeBox(box, anchor) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(400, vw - 24);
  const left = clamp(anchor ? anchor.left : vw - w - 30, 10, Math.max(10, vw - w - 10));
  let top = anchor ? anchor.bottom + 10 : 90;
  if (top > vh - 240 && anchor) top = Math.max(52, anchor.top - 250);
  top = clamp(top, 52, Math.max(52, vh - 240));
  box.style.width = `${w}px`;
  // 用户把这个卡片拖动过就沿用它挪到的位置，否则按锚点自动摆
  const p = applyCardPos(box, left, top);
  box.style.left = `${p.left}px`;
  box.style.top = `${p.top}px`;
}

function showCiteBox(n, ref, anchor, { canReturn = true } = {}) {
  state.cite = { n, ref };
  const box = $('#citeBox');
  box.classList.remove('hidden');
  $('#citeReturn').classList.toggle('hidden', !canReturn);
  $('#citeTitle').textContent = `参考文献 [${n}] · p.${ref.page}`;
  $('#citeText').textContent = ref.text;
  $('#citeResult').innerHTML = '';
  renderCiteDetail();
  placeBox(box, anchor);
}

/**
 * 详情补充区：书架匹配 + 已知的开放版本结果。
 *
 * **不碰 #citeResult** —— 那是「找这篇的 PDF」的检索结果容器，e2e / relations 都按
 * 「点完之后里面才有 .cite-item」来断言，预填进去会让它们提前通过。
 */
function renderCiteDetail() {
  const out = $('#citeDetail');
  if (!out) return;
  out.replaceChildren();
  const ref = state.cite?.ref;
  if (!ref) return;
  const docId = state.doc?.docId || null;

  if (ref.lib) {
    out.append(el('div', { class: 'cite-item' },
      el('div', { class: 'ci-top' }, el('span', { class: 'ci-badge', text: '书架已有' })),
      el('div', { class: 'cd-name', text: ref.lib.name.replace(/\.pdf$/i, '') }),
      el('div', { class: 'ci-acts' },
        el('button', {
          text: '打开',
          onclick: () => {
            $('#citeBox').classList.add('hidden');
            openDoc({ name: ref.lib.name, url: ref.lib.url, docId: ref.lib.docId });
          },
        }))));
  }

  const slot = docId ? relSlotIfAny(docId, ref) : null;
  if (!slot || slot.status === 'idle' || slot.status === 'local') return;
  if (slot.status === 'loading') {
    out.append(el('div', { class: 'cite-msg', text: '正在查 arXiv / OpenAlex / Crossref…' }));
    return;
  }
  if (slot.status === 'none') {
    out.append(el('div', { class: 'cite-msg', text: '公开库里没查到这篇的开放版本；可以点下面的「找这篇的 PDF」再搜一遍。' }));
    return;
  }
  if (slot.status === 'error') {
    out.append(el('div', { class: 'cite-msg err', text: `上次查询失败：${slot.fail || '未知原因'}` }));
    out.append(el('button', {
      class: 'cd-btn', text: '重试',
      onclick: () => lookupRefPdf(state.cite?.ref),
    }));
    return;
  }
  // pdf / landing：已知的开放版本
  const link = searchResultUrl(slot.found);
  out.append(el('div', { class: 'cite-item' },
    el('div', { class: 'ci-top' },
      el('span', {
        class: 'ci-badge' + (slot.found?.pdfUrl ? ' pdf' : ''),
        text: slot.found?.pdfUrl ? 'PDF 直链' : (slot.found?.source || '落地页'),
      }),
      slot.found?.year ? el('span', { text: slot.found.year }) : null,
      slot.found?.venue ? el('span', { text: String(slot.found.venue).slice(0, 26) }) : null),
    el('div', { class: 'ci-title', text: slot.found?.title || slot.guessed || '(无标题)' }),
    el('div', { class: 'ci-acts' },
      link ? el('a', { href: link, target: '_blank', rel: 'noopener noreferrer', text: '打开链接' }) : null,
      link ? el('button', { text: '复制链接', onclick: () => copyText(link) }) : null)));
}

async function searchCite() {
  const ref = state.cite?.ref;
  if (!ref) return;
  const docId = state.doc?.docId || null;
  const myGen = state.relGen;
  const btn = $('#citeSearch');
  const out = $('#citeResult');
  btn.disabled = true;
  out.innerHTML = '<div class="cite-msg">正在查 arXiv / OpenAlex / Crossref…</div>';
  try {
    const r = await fetch(`/api/ref-search?q=${encodeURIComponent(ref.text)}`);
    const data = await r.json();
    if (relStale(docId, myGen)) return;          // 换论文了：这次结果属于上一篇，一个字都不写
    renderCiteResults(data);
    // 顺手把结论同步到关系列表的显式状态（列表里同一行的小徽标跟着变，不用再单独查一次）
    applyResultsToSlot(docId, ref, data);
    renderRelations();
    renderCiteDetail();
  } catch (e) {
    if (relStale(docId, myGen)) return;
    out.innerHTML = `<div class="cite-msg err">检索失败：${esc(e.message)}</div>`;
    markSlotError(docId, ref, e.message);
    renderRelations();
    renderCiteDetail();
  } finally {
    btn.disabled = false;
  }
}

function renderCiteResults(data) {
  const out = $('#citeResult');
  out.innerHTML = '';
  const list = data?.results || [];
  if (!list.length) {
    out.append(el('div', { class: 'cite-msg', text: '几家公开库里都没查到这个标题的开放版本，可以直接用下面的搜索引擎链接。' }));
  }
  for (const r of list) {
    const link = r.pdfUrl || r.url || '';
    if (!link) continue;
    out.append(el('div', { class: 'cite-item' },
      el('div', { class: 'ci-top' },
        el('span', { class: 'ci-badge' + (r.pdfUrl ? ' pdf' : ''), text: r.pdfUrl ? 'PDF 直链' : r.source }),
        r.year ? el('span', { text: r.year }) : null,
        r.venue ? el('span', { text: r.venue.slice(0, 26) }) : null,
      ),
      el('div', { class: 'ci-title', text: r.title || '(无标题)' }),
      el('div', { class: 'ci-acts' },
        el('a', { href: link, target: '_blank', rel: 'noopener noreferrer', text: '打开链接' }),
        el('button', { text: '复制链接', onclick: () => copyText(link) }),
      ),
    ));
  }
  const extra = el('div', { class: 'cite-acts' });
  if (data?.scholarUrl) extra.append(el('a', { href: data.scholarUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Google Scholar' }));
  if (data?.searchUrl) extra.append(el('a', { href: data.searchUrl, target: '_blank', rel: 'noopener noreferrer', text: '网页搜索 PDF' }));
  if (extra.children.length) out.append(el('div', { class: 'cite-item' }, el('div', { class: 'ci-top' }, el('span', { text: '没找到？' })), extra));
}
/* ══════════════════════════════ 笔记 ══════════════════════════════ */
/* 点气泡上的「✎」= 收藏这段文字，然后立刻弹出编辑框写笔记；
   正文右边缘会出现一个小书签，点它就能随时读 / 改这条笔记。 */

function initNoteBox() {
  $('#noteSave').onclick = () => saveNoteBox();
  $('#noteClose').onclick = () => saveNoteBox();          // 关闭即保存，不会白写
  $('#noteDelete').onclick = () => deleteNoteBox();
  $('#noteText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveNoteBox(); }
    if (e.key === 'Escape') { e.preventDefault(); saveNoteBox(); }
  });
  // 点到别处也保存关闭，避免笔记丢失
  document.addEventListener('mousedown', (e) => {
    if ($('#noteBox').classList.contains('hidden')) return;
    if (e.target.closest('#noteBox') || e.target.closest('.hl-pin')) return;
    saveNoteBox();
  });
}

function openNoteEditor(item, anchorBox) {
  if (!item) return;
  state.editingId = item.id;
  const box = $('#noteBox');
  box.classList.remove('hidden');
  $('#noteTitle').textContent = `笔记 · p.${item.page}`;
  $('#noteQuote').textContent = item.text || '';
  $('#noteText').value = item.note || '';
  $('#noteHint').textContent = 'Ctrl+Enter 保存 · 留空也会保存这段文字';

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(380, vw - 24);
  const left = clamp(anchorBox ? anchorBox.left : vw - w - 30, 10, Math.max(10, vw - w - 10));
  let top = anchorBox ? anchorBox.bottom + 10 : 90;
  if (top > vh - 230 && anchorBox) top = Math.max(52, anchorBox.top - 250);
  top = clamp(top, 52, Math.max(52, vh - 230));
  box.style.width = `${w}px`;
  // 拖动过的位置优先，没拖过才按锚点自动摆
  const pos = applyCardPos(box, left, top);
  box.style.left = `${pos.left}px`;
  box.style.top = `${pos.top}px`;
  setTimeout(() => $('#noteText').focus(), 30);
}

function openNoteEditorById(id) {
  const item = state.highlights.find((x) => x.id === id);
  if (item) openNoteEditor(item);
}

function closeNoteBox() {
  $('#noteBox').classList.add('hidden');
  state.editingId = null;
}

async function saveNoteBox() {
  const id = state.editingId;
  if (!id) { closeNoteBox(); return; }
  const item = state.highlights.find((x) => x.id === id);
  const val = $('#noteText').value.trim();
  closeNoteBox();
  if (!item) return;
  if ((item.note || '') === val) return;      // 没改就不写盘
  item.note = val;
  try {
    await saveNotes();
    viewer?.setHighlights(state.highlights);
    await renderNotes();
    toast(val ? '笔记已保存' : '已收藏这段文字', 'ok', 1300);
  } catch (e) {
    toastAction(`笔记保存失败：${e.message}，内容仍保留。`, '重试', async () => {
      await saveNotes(); viewer?.setHighlights(state.highlights); await renderNotes(); toast('笔记已保存', 'ok');
    }, 'err', 12000);
  }
}

async function deleteNoteBox() {
  const id = state.editingId;
  closeNoteBox();
  if (id) await deleteNoteItem(id);
}

async function deleteNoteItem(id) {
  const previous = state.highlights;
  state.highlights = state.highlights.filter((x) => x.id !== id);
  viewer?.setHighlights(state.highlights);
  try { await saveNotes(); await renderNotes(); }
  catch (e) {
    state.highlights = previous;
    viewer?.setHighlights(previous);
    await renderNotes();
    toastAction(`删除未保存：${e.message}，笔记已恢复。`, '重试', () => deleteNoteItem(id), 'err', 12000);
  }
}
/* ══════════════════════════════ 划词气泡 ══════════════════════════════ */

function initSelection() {
  const v = $('#viewer');
  // 原生 ::selection 已设成透明，这里自己画不重叠的方块（拖动过程中也在刷新）
  document.addEventListener('selectionchange', throttle(() => {
    const info = viewer?.getSelectionInfo();
    // 只在「确实有一个新选区」时更新方块。
    // 选区为空时**故意不动**：虚拟化把页面卸掉时浏览器也会顺手把选区清空，
    // 那时若跟着清，滚回来就再也看不到刚才选的是哪一段了（用户反馈的 bug）。
    // 真正的「取消选择」由点击别处 / Esc / 做出新选择来触发。
    if (info) viewer?.paintSelection(info.rectsByPage);
  }, 50));
  v.addEventListener('touchend', () => setTimeout(onSelectionChanged, 60));

  /**
   * 松手要监听整个 document，不能只监听 #viewer：
   * 拖选时鼠标常常顺手划到右侧面板才松开，那样 #viewer 收不到 mouseup，
   * 方块画出来了但气泡死活不弹（用户说的「有些地方选不中」就是这个）。
   *
   * 这里同时判断「这是一次单击，还是一次拖选」：
   *   · 单击在空白处 / 面板上  → 取消选择（浏览器的选区这时已经塌掉了）
   *   · 单击在按钮、输入框上    → 不动选区。点缩放/翻页按钮不该把选区弄没，
   *                              用户放大往往正是为了看清选中的那段
   *   · 拖选（指针移动过）      → 一律按「有了新选区」处理
   * 注意浏览器自己的选区是唯一裁判：双击选词时第一次 mouseup 选区是空的、
   * 第二次才是选中的词，所以这里只在「没有活选区」时才真的去清。
   */
  document.addEventListener('mouseup', (e) => {
    if (e.target?.closest?.('#bubble, #popover, #citeBox, #noteBox, #settingsModal')) return;
    const moved = state._downAt
      ? Math.hypot(e.clientX - state._downAt.x, e.clientY - state._downAt.y)
      : 999;
    const isClick = moved < 5;
    const onControl = !!e.target?.closest?.('button, input, select, textarea, label, a');
    state._downAt = null;
    setTimeout(() => onSelectionChanged({ deselect: isClick && !onControl }), 10);
  });

  /**
   * 拖着选到窗口外面松手，页面里根本收不到 mouseup。
   * 鼠标一离开窗口就当作松手处理（此时选区已经成型了）。
   */
  document.documentElement.addEventListener('mouseleave', () => {
    if (!state._dragSelecting) return;
    state._dragSelecting = false;
    state._downAt = null;
    setTimeout(() => onSelectionChanged({}), 10);
  });

  document.addEventListener('mousedown', (e) => {
    const t = e.target;
    if (t?.closest?.('#bubble, #popover, #citeBox, #noteBox, #settingsModal')) return;
    state._downAt = { x: e.clientX, y: e.clientY };
    // 在正文里按下 = 准备开始新的选择，标记一下防止漏掉「窗口外松手」
    if (t?.closest?.('#viewer')) state._dragSelecting = true;
  });

  // 只有正文区（或整个文档）滚动时才收起气泡。
  // scroll 不冒泡，但 capture 阶段 window 能收到所有元素的滚动事件，
  // 不加判断的话，右侧面板流式输出时自动滚动会把气泡误关掉。
  window.addEventListener('scroll', (e) => {
    const t = e.target;
    if (t === document || t === document.documentElement || t === document.body || t === $('#viewer')) hideBubble();
  }, true);

  // 点气泡按钮时别把选区弄丢
  $('#bubble').addEventListener('mousedown', (e) => e.preventDefault());
  $('#bubble').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    // 用最新选区：用户可能在气泡弹出后又调整了选择范围
    const fresh = viewer.getSelectionInfo();
    const sel = fresh ? { ...fresh, cleanText: cleanText(fresh.text) } : state.selection;
    if (!sel?.cleanText) return;
    state.selection = sel;
    hideBubble();
    switch (btn.dataset.act) {
      case 'translate': doTranslate(sel); break;
      case 'explain': doExplain(sel); break;
      case 'add': addToChat(sel); break;
      case 'note': {
        const item = await addHighlight(sel);
        if (item) openNoteEditor(item, sel.box);
        break;
      }
      case 'copy': copyText(sel.cleanText); break;
      default: break;
    }
  });
}

/**
 * @param opts.deselect 这次松手是不是一次「取消选择」的单击（点在空白处/面板上）。
 *   是的话且浏览器已经没有活选区，就把气泡、方块、state.selection 一起清掉。
 */
function onSelectionChanged({ deselect = false } = {}) {
  state._dragSelecting = false;
  const info = viewer?.getSelectionInfo();
  if (!info) {
    if (deselect) clearSelectionState();
    else hideBubble();
    return;
  }
  let text = cleanText(info.text);
  if (text.length < 2) {
    if (deselect) clearSelectionState();
    else hideBubble();
    return;
  }
  // Ctrl/⌘ + 划选：把上一次选区拼到前面（对付被图表/换栏切开的句子）
  const pending = state._pendingMerge;
  state._pendingMerge = null;
  if (pending && !pending.includes(text)) {
    text = `${pending}\n${text}`;
    toast('已拼接上一段选区', 'ok', 1800);
  }
  info.cleanText = text;
  state.selection = info;
  showBubble(info);
}

function showBubble(sel) {
  const b = $('#bubble');
  b.classList.remove('hidden');
  const w = b.offsetWidth || 158;
  const h = b.offsetHeight || 32;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // 选区被滚出视口时 box 可能是负数，必须钳进视口，否则气泡会飞到屏幕外点不到
  const left = clamp(sel.box.left + sel.box.width / 2 - w / 2, 8, Math.max(8, vw - w - 8));
  let top = sel.box.top - h - 8;
  if (top < 52) top = sel.box.bottom + 8;
  top = clamp(top, 52, Math.max(52, vh - h - 8));
  b.style.left = `${Math.round(left)}px`;
  b.style.top = `${Math.round(top)}px`;
}

function hideBubble() { $('#bubble').classList.add('hidden'); }

/**
 * 忘掉当前选区：气泡、页面上的方块、state.selection 三样必须一起清，
 * 只清一部分就会出现「屏幕上没选区，按 T 却翻出旧文字」。
 */
function clearSelectionState() {
  hideBubble();
  state.selection = null;
  state._pendingMerge = null;
  viewer?.paintSelection(null);
}

/* ══════════════════════════════ 右栏结果块（面板注册表的渲染端） ══════════════════════════════ */
/* 这两块就是 state.panels 里的 translate / chat：
   显示与否看 visible，顺序看 order，高度看 size。
   分块区仍然是「可选」的：默认一块都不显示，用到哪块自动出现；
   每块都能 ✕ 移除、用底部按钮加回来；块与块之间可以拖动调高度、拖块头上下交换位置。
   注意：**切换显示/位置时绝不重建节点**（只改 DOM 顺序与 hidden 类），否则消息与滚动位置会丢。 */

const blockTitle = (id) => panelTitle(id);
const visibleBlocks = () => visiblePanelsOfDock('right');

/** 确保某个块是打开的（比如有截图进来时自动打开「问答」） */
function showAiBlock(id) {
  if (!state.panels[id].visible) setPanelVisible(id, true);
}

function initAiArea() {
  state._aiVisibleSig = rightPanelsSig();
  renderAiArea();
  // 窗口一变矮，原来拖好的块高度就可能装不下 —— 重新夹一次，别让底部被裁掉
  window.addEventListener('resize', debounce(() => fitBlockSizes(), 150));
}

function clearAllBlocks() {
  for (const meta of Object.values(state.blockMeta)) meta.body.innerHTML = '';
  refreshCounts();
}

/** 建一个块。只建一次，之后复用同一个 DOM —— 增删/换位都不会丢消息 */
function ensureBlock(id) {
  if (state.blockEls[id]) return state.blockEls[id];
  const count = el('span', { class: 'ai-count' });
  const meta0 = AI_BLOCKS.find((b) => b.id === id) || {};
  const hint = el('div', { class: 'ai-hint', text: meta0.hint || '' });
  const body = el('div', { class: 'ai-body' }, hint);
  const head = el('header', { class: 'ai-head', draggable: 'true', tabIndex: 0, role: 'button', 'aria-label': `移动${blockTitle(id)}结果块` },
    el('span', { class: 'grip', title: '按住上下拖动：调整这块和其他块的顺序' }, iconEl('drag-vertical', { size: 14 })),
    el('span', { class: 'ai-title', text: blockTitle(id) }),
    count,
    el('span', { class: 'spacer' }),
  );
  const root = el('section', { class: 'ai-block', dataset: { block: id, panel: id } }, head, body);

  // 右栏两块是这里现建的，不会走左栏 ensurePanel 的绑定分支 —— 标题栏的键盘操作、
  // 拖出成应用内卡片和左侧抓手都必须在这里补上，否则「问答 / 译文」永远拖不动。
  if (!head.dataset.panelBound) {
    head.dataset.panelBound = '1';
    bindPanelHead(id, head);
    bindDockPanelDrag(id, head);
    if (!head.querySelector(':scope > .panel-drag-handle')) head.prepend(panelDragHandle());
    if (!head.querySelector(':scope > .panel-actions')) head.append(panelActions(id));
    if (!head.querySelector(':scope > .panel-float-x')) head.append(panelFloatCloseButton(id));
  }

  head.addEventListener('dragstart', (e) => {
    state.dragBlock = id;
    root.classList.add('dragging');
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
    } catch { /* 忽略 */ }
  });
  head.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const vis = visibleBlocks();
    const i = vis.indexOf(id);
    const target = e.key === 'ArrowUp' ? vis[i - 1] : vis[i + 1];
    if (target) moveBlock(id, target, e.key === 'ArrowDown');
  });
  head.addEventListener('dragend', () => {
    state.dragBlock = null;
    root.classList.remove('dragging');
    clearDropMarks();
  });
  root.addEventListener('dragover', (e) => {
    if (!state.dragBlock || state.dragBlock === id) return;
    e.preventDefault();
    const r = root.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    clearDropMarks();
    root.classList.add(after ? 'drop-after' : 'drop-before');
  });
  root.addEventListener('dragleave', () => root.classList.remove('drop-before', 'drop-after'));
  root.addEventListener('drop', (e) => {
    if (!state.dragBlock || state.dragBlock === id) return;
    e.preventDefault();
    const r = root.getBoundingClientRect();
    moveBlock(state.dragBlock, id, e.clientY > r.top + r.height / 2);
  });

  // R7：滚动时刷新底部渐隐（滚到底就摘掉标记）
  body.addEventListener('scroll', updateScrollFades, { passive: true });

  state.blockEls[id] = root;
  state.blockMeta[id] = { body, count };
  return root;
}

function clearDropMarks() {
  for (const node of Object.values(state.blockEls)) node.classList.remove('drop-before', 'drop-after');
}

/**
 * 「当前真正可见的上下两块」——改高度之前现算一次。
 *
 * 判据取 **DOM 真相**（两块都在文档里、都没带 hidden 类），不是模型里的 visible：
 * 拖动是异步的（pointermove 挂在 window 上），按下之后到松手之前，可见集合完全可能变
 *（消息进来自动打开另一块、用户点开关、截图自动开「问答」……）。这时候还照旧把 size
 * 写下去，就会写到一块**用户根本看不见**的块上 —— 用户报的「隐藏时被写成 60」是同一个
 * 病根：下面那块 height=0，`belowH - dy` 一夹就落到 60px 保底值。
 * 返回 null 表示这一对已经不成立，调用方必须整次作废（不要只写一半）。
 */
function visibleSplitPair(belowId) {
  const vis = visibleBlocks();
  const i = vis.indexOf(belowId);
  if (i <= 0) return null;
  const above = vis[i - 1];
  const a = state.blockEls[above];
  const b = state.blockEls[belowId];
  if (!a?.isConnected || !b?.isConnected) return null;
  if (a.classList.contains('hidden') || b.classList.contains('hidden')) return null;
  return { above, below: belowId };
}

/** 两块之间的高度分隔条：拖动时同时改上下两块的高度（只作用于当前可见的那一对） */
function ensureSplit(belowId) {
  if (state.splitEls[belowId]) return state.splitEls[belowId];
  let startAbove = null;      // 按下那一刻上面那一块是谁（拖动途中它变了就说明基准失效）
  let startY = 0;
  let aboveH = 0;
  let belowH = 0;

  const move = (e) => {
    const pair = visibleSplitPair(belowId);
    // 可见集合在拖动途中变过（两块里有一块被藏/被换）：两个基准高度都对不上了，整次拖动作废
    if (!pair || pair.above !== startAbove) return;
    const min = 60;
    const dy = e.clientY - startY;
    let a = aboveH + dy;
    let b = belowH - dy;
    if (a < min) { b -= min - a; a = min; }
    if (b < min) { a -= min - b; b = min; }
    if (a < min || b < min) return;
    state.panels[pair.above].size = Math.round(a);
    state.panels[pair.below].size = Math.round(b);
    fitBlockSizes();
  };
  const up = () => {
    node.classList.remove('dragging');
    document.body.classList.remove('row-dragging');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    startAbove = null;
    savePanels();
  };
  const node = el('div', { class: 'ai-split', title: '拖动调整上下两块的高度', tabIndex: 0, role: 'separator', 'aria-orientation': 'horizontal' });
  node.addEventListener('keydown', (e) => {
    if (!['ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const pair = visibleSplitPair(belowId);
    if (!pair) return;
    e.preventDefault();
    const delta = e.key === 'ArrowDown' ? 24 : -24;
    const ah = state.panels[pair.above].size || state.blockEls[pair.above]?.getBoundingClientRect().height || 120;
    const bh = state.panels[pair.below].size || state.blockEls[pair.below]?.getBoundingClientRect().height || 120;
    if (ah + delta < 60 || bh - delta < 60) return;
    state.panels[pair.above].size = Math.round(ah + delta);
    state.panels[pair.below].size = Math.round(bh - delta);
    fitBlockSizes(); savePanels();
  });
  node.addEventListener('pointerdown', (e) => {
    const pair = visibleSplitPair(belowId);
    if (!pair) return;
    e.preventDefault();
    startAbove = pair.above;
    startY = e.clientY;
    aboveH = state.blockEls[pair.above].getBoundingClientRect().height;
    belowH = state.blockEls[pair.below].getBoundingClientRect().height;
    node.classList.add('dragging');
    document.body.classList.add('row-dragging');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  state.splitEls[belowId] = node;
  return node;
}

/** 拖块头换位：把 from 插到 to 的前 / 后，然后按右栏的新顺序重排 order（同一套注册表） */
function moveBlock(from, to, after) {
  const slots = panelsOfDock('right');                 // 右栏所有块（含隐藏的）占的 order 槽位
  const orderValues = slots.map((id) => state.panels[id].order);   // 先把槽位号抄下来再改
  const list = slots.filter((x) => state.panels[x].visible);
  const rest = list.filter((x) => x !== from);
  let idx = rest.indexOf(to);
  if (idx < 0) return;
  if (after) idx += 1;
  rest.splice(idx, 0, from);
  slots.forEach((slotId, i) => {
    const nextId = rest[i];
    if (nextId) state.panels[nextId].order = orderValues[i];
  });
  savePanels();
  applyPanels();
}

/** 显示 / 隐藏一个右栏块（等价于 setPanelVisible，名字留着给 2.1 的调用点用） */
function setBlockVisible(id, on) {
  setPanelVisible(id, on);
}

/**
 * 把保存的块高度套上去，**并且保证总高不超过容器**。
 *
 * 用户拖出来的高度只是「偏好」：窗口变小、或者输入区变高（比如多了「全文/联网」那一行）之后，
 * 原来的高度加起来就装不下了。`.ai` 是 overflow:hidden，装不下的部分会被**直接裁掉**，
 * 表现出来就是「右侧输出最下面的内容被下面的输入框挡住」——其实是被裁了，滚也滚不到。
 * 所以这里按比例压缩，每个块至少留 60px。
 */
function fitBlockSizes() {
  // 现在右栏可能有并列的两栏，每一栏的「可用高度」是它自己的结果区；
  // 各栏各算各的，绝不用另一栏的高度去夹这一栏的块（否则并排时右边那块会被压成 60px 保底）。
  for (const n of [1, 2]) {
    const area = rightAreaEl(n);
    if (!area) continue;
    const id = rightPanelInCol(n);
    const node = id ? state.blockEls[id] : null;
    if (!node) continue;
    // 第 2 栏可能是 display:none（窄窗临时隐藏）—— 这时量到的高度是 0，别把用户拖好的高度写坏
    const avail = Math.max(160, area.clientHeight - 5);
    const px = state.panels[id].size;
    if (px > 0) {
      node.classList.add('sized');
      node.style.height = `${Math.max(60, Math.min(Math.round(px), avail))}px`;
    } else {
      node.classList.remove('sized');
      node.style.height = '';
    }
  }
  // R7：块高变了 → 是否还能滚动也会变，下一帧刷新底部渐隐
  requestAnimationFrame(updateScrollFades);
}

function refreshCounts() {
  for (const meta of Object.values(state.blockMeta)) {
    const n = meta.body.querySelectorAll('.msg').length;
    meta.count.textContent = n ? `(${n})` : '';
    meta.body.querySelector('.ai-hint')?.classList.toggle('hidden', n > 0);
  }
  updateScrollFades();
}

/**
 * R7：结果块底部的渐隐提示。
 * `.ai-body` 是滚动容器，内容超出时在底边叠一层渐隐，告诉用户"下面还有"；
 * 滚到底（或本来就没溢出）就把标记摘掉，避免在末尾给出假的"还有内容"暗示。
 * 容差 2px 是为了兼容小数像素和缩放。
 */
function updateScrollFades() {
  for (const node of Object.values(state.blockEls)) {
    if (!node) continue;
    const body = node.querySelector('.ai-body');
    if (!body) continue;
    const more = body.scrollHeight - body.clientHeight - body.scrollTop > 2;
    node.classList.toggle('has-scroll', more);
  }
}

/** 同一栏里真有几块在显示？超过一块就按 order 只留最靠前的那块（一栏只开一个） */
function enforceOnePerColumn() {
  for (const n of [1, 2]) {
    const list = PANEL_IDS_RIGHT
      .filter((id) => colOf(id) === n && state.panels[id].visible && state.panels[id].dock === 'right')
      .sort((a, b) => (state.panels[a].order - state.panels[b].order) || (PANEL_IDS.indexOf(a) - PANEL_IDS.indexOf(b)));
    for (const id of list.slice(1)) {
      state.panels[id].visible = false;
      flushPanelVisibility(id, false);
      rememberBodyScroll(id);          // 它马上要被停进脱离文档的停放区
    }
  }
}

/**
 * 把「模型里说不可见」落到节点上：挂 hidden 类 + data-dock。
 * 不能整个 applyPanels 递归一遍（enforceOnePerColumn 就在 applyPanels 里面），所以这里只做这两件事。
 */
function flushPanelVisibility(id, visible) {
  const node = panelEl(id);
  if (!node) return;
  node.classList.toggle('hidden', !visible);
  node.dataset.dock = state.panels[id].dock;
}

/**
 * 一列里应该渲染哪一块（**一栏只能开一个**）：只认「可见 + 归属这一栏」的那一个。
 * 归属栏没开（列数 1）或已被同栏更高优先级的面板占掉 → 返回空串，调用方把节点停进 #panelPark。
 * 排序用 order（与旧的上下两块口径一致），同 order 时按注册表顺序。
 */
function rightPanelInCol(n) {
  const list = PANEL_IDS_RIGHT
    .filter((id) => colOf(id) === n && state.panels[id].visible && state.panels[id].dock === 'right')
    .sort((a, b) => (state.panels[a].order - state.panels[b].order) || (PANEL_IDS.indexOf(a) - PANEL_IDS.indexOf(b)));
  return list[0] || '';
}

/** 一列的结果区长什么样（只改 DOM，不改导航） */
function renderCol(n) {
  const area = rightAreaEl(n);
  if (!area) return;
  const id = rightPanelInCol(n);
  // 把「这一栏此刻显示的是谁」写到 <aside> 上：CSS 需要它来决定要不要显示输入区。
  // 用户口径（2026-10-04）：「译文不需要输入啊」—— 译文栏只显示译文，不给输入框；
  // 问答栏才需要输入框。见 style.css 的 [data-active-panel="translate"] 那一条。
  const col = rightColEl(n);
  if (col) {
    if (id) col.dataset.activePanel = id;
    else delete col.dataset.activePanel;
  }
  if (!id) {
    if (n === 1) {
      // 空态：译文 / 问答一块都没开。文案改成右键也能开第 2 栏（入口在图标坞上）
      const empty = area.querySelector(':scope > .ai-empty');
      if (empty && area.children.length === 1) return;
      area.replaceChildren(el('div', { class: 'ai-empty' },
        el('div', { text: '结果会出现在这里' }),
        el('div', { text: '从下面这一排图标打开译文 / 问答，或在正文中选择文字开始。' }),
      ));
    } else {
      area.replaceChildren(el('div', { class: 'ai-empty' },
        el('div', { text: '这一栏还空着' }),
        el('div', { text: '右键下面的图标 →「放到第 2 栏」，或把图标拖出去开一个应用内卡片。' }),
      ));
    }
    return;
  }
  const block = ensureBlock(id);
  if (area.children.length === 1 && area.firstElementChild === block) return;
  rememberBodyScroll(id);          // 换块 / 变空态之前先记位置（节点会短暂离开文档）
  area.replaceChildren(block);
  applyBodyScroll(id);             // 同一帧补回（见 parkRightPanel 的注释）
}

/**
 * 右栏所有列一起重排（applyPanels 的 ④b 与 openRightColumn / closeRightColumn 都走这一条）。
 * 第 2 栏只在「列数 = 2」时存在，所以渲染前先把列 DOM 对好。
 */
function renderCols() {
  applyRightColsDom();
  for (const id of PANEL_IDS_RIGHT) parkRightPanel(id, dockedAreaFor(id));
  renderCol(1);
  if (rightColsWanted() === 2) renderCol(2);
  fitBlockSizes();
  refreshCounts();
  renderAiBar();
}

function renderAiArea() {
  renderCols();
}

/**
 * 右栏每一栏底部的「译文 / 问答」分段切换器 —— **右栏唯一的一组可见面板入口**。
 *
 * 用户口径（2026-10-03）：
 *   「右栏顶部：只放当前面板的标题和面板操作；右栏底部：只保留一组『译文 / 问答』切换器；
 *     右键和拖拽能力附着在这一组图标上；不再额外渲染另一组相同按钮。」
 *   「开启第二栏时…第二栏也不应该再重复渲染完整的两套按钮。每一栏只显示当前栏的面板状态，
 *     切换入口统一放在该栏底部。」
 *
 * 语义（必须与「一栏只开一个」一致）：
 *   · 每一栏的切换器只反映**这一栏**的状态：这一栏现在开着谁，谁就是选中态。
 *   · 点本栏没开的那个 → 在本栏打开它（同栏原来那个自动收起）。
 *   · 点本栏正开着的那个 → 收起它（这一栏变空，另一栏不受影响）。
 *   · 右键 → 换栏 / 再开一栏 / 应用内卡片；按住拖出 → 应用内卡片。
 */
function renderAiBar() {
  for (const col of [1, 2]) {
    const host = aiBarEl(col);
    if (!host) continue;
    // 顺序 = 右栏面板的 order（用户可以把译文拖到问答前面）
    const ids = PANEL_IDS_RIGHT
      .slice()
      .sort((a, b) => (state.panels[a].order - state.panels[b].order) || (PANEL_IDS.indexOf(a) - PANEL_IDS.indexOf(b)));
    const here = rightPanelInCol(col);
    host.replaceChildren(...ids.map((id) => {
      const meta = AI_BLOCKS.find((b) => b.id === id) || {};
      const floating = state.panels[id]?.dock === 'float';
      const on = !floating && here === id;
      const label = blockTitle(id);
      const title = floating
        ? `「${label}」正在阅读器内部卡片中；点击此按钮把卡片提到最前`
        : `${on ? '关闭' : '打开'}「${label}」${col === 2 ? '（右栏第 2 栏）' : ''} —— ${meta.hint || ''}`;
      const btn = el('button', {
        type: 'button',
        class: `aibar-btn${on ? ' on' : ''}${floating ? ' detached' : ''}`,
        role: 'tab',
        'aria-selected': on ? 'true' : 'false',
        'aria-pressed': on ? 'true' : 'false',
        dataset: { block: id, col: String(col) },
        text: label,
        title,
      });
      bindPanelToggleGestures(btn, id, {
        // 卡片状态下仍允许点击（提到最前），但不重复创建第二张卡片
        dragToDetach: !floating,
        onClick: () => {
          if (floating) {
            bringFloatToFront(id);
            return;
          }
          if (on) { setPanelVisible(id, false); return; }
          if (colOf(id) !== col) setPanelColumn(id, col);   // 不在本栏 → 挪到本栏再开
          else setPanelVisible(id, true);
        },
      });
      return btn;
    }));
  }
}

/* ══════════════════════════════ 消息 ══════════════════════════════ */

/**
 * 一条消息（Copilot 风格扁平结构）：
 *   角色行（小圆标 + 类型 + 页码 + 回跳） / 引用原文（细竖线，不做盒子） / 截图 / 正文 / 底部小动作
 * 没有边框卡片，也没有任何折叠。
 */
function addEntry({ block = 'chat', tag, page, quote, imageSrc, thumbs, kind = 'assistant', text, retry, restore = false }) {
  // 恢复历史时只把内容装回对应块，不强行打开右栏；用户可从下方开关按需展开。
  if (!restore && !state.panels[block].visible) setPanelVisible(block, true);
  const bodyEl = state.blockMeta[block].body;
  const isUser = kind === 'user';

  const role = el('div', { class: `role${!isUser && !page ? ' hidden' : ''}` },
    isUser ? el('span', { class: 'ava', text: '你', 'aria-label': '你的问题' }) : null,
    tag ? el('span', { class: 'tag', text: tag, 'aria-hidden': 'true' }) : null,
    page && uiStyle.showPage ? el('span', { class: 'pg', text: `第${page}页` }) : null,
    !isUser && page && uiStyle.showPage ? el('button', {
      class: 'tbtn',
      title: `回到第${page}页原文`,
      'aria-label': `回到第${page}页原文`,
      onclick: () => jumpToPageWithHistory(page, { smooth: true }),
    }, iconEl('jump-back')) : null,
  );
  const ref = quote && uiStyle.showQuote ? el('div', { class: 'ref', text: quote, title: quote }) : null;
  const shots = (imageSrc ? [imageSrc] : (thumbs || [])).filter(Boolean);
  const shot = shots.length
    ? el('div', { class: 'shots' }, ...shots.map((src) => el('img', { class: 'shot-img', src })))
    : null;
  const textEl = el('div', {
    class: 'text',
    html: text !== undefined ? renderMarkdown(text) : '<span class="cursor"></span>',
  });
  const acts = el('div', { class: 'acts hidden' });
  const root = el('div', { class: `msg ${isUser ? 'user' : 'assistant'}`, dataset: { operation: tag || '', page: page || '' } }, role, ref, shot, textEl, acts);
  // 全局序号：分块之后 DOM 顺序 ≠ 时间顺序，取「最新一条」要靠它
  state.msgSeq = (state.msgSeq || 0) + 1;
  root.dataset.seq = String(state.msgSeq);
  bodyEl.append(root);
  const record = { block, tag: tag || '', page: page || null, quote: quote || '', kind, text: text || '', screenshot: !!shots.length, sources: [], meta: '', status: isUser ? 'user' : (text !== undefined ? 'complete' : 'pending'), retry: retry || null };
  root.__sessionRecord = record;
  if (!restore) {
    state.sessionEntries.push(record);
    scheduleSessionSave();
  }
  scrollBody(bodyEl);
  refreshCounts();
  return { root, body: textEl, acts, role };
}

function finishEntry(entry, fullText, { page, onAsk, onRetry, sources, meta, status = 'complete' } = {}) {
  const rec = entry.root.__sessionRecord;
  if (rec) {
    rec.text = String(fullText || '').slice(0, 12000);
    rec.page = page || rec.page;
    rec.sources = (sources || []).slice(0, 8);
    rec.meta = meta || '';
    rec.status = status;
  }
  // R7：内容长出来之后刷新底部渐隐（下一帧量，等布局落定）
  requestAnimationFrame(updateScrollFades);
  // 同一个条目可能被收尾多次（典型：操作「重试」复用同一条），
  // 先把上一次的元信息行与来源列表摘掉，否则会叠出两行、旧的那行还写着「N 页失败」。
  entry.root.querySelectorAll('.entry-meta, .src-list').forEach((node) => node.remove());
  entry.acts.replaceChildren();
  entry.acts.classList.remove('hidden');
  // 必须用 appendAll：Element.append(null) 会把 null 变成文本节点 "null" 显示出来
  appendAll(entry.acts,
    el('button', { text: '复制', onclick: () => copyText(fullText) }),
    page ? el('button', { text: `回到第${page}页`, onclick: () => jumpToPageWithHistory(page, { smooth: true }) }) : null,
    onAsk ? el('button', { text: '接着问', onclick: onAsk }) : null,
    onRetry ? el('button', { text: status === 'stopped' ? '重新生成' : '重试', onclick: onRetry }) : null,
  );
  const extra = [];
  if (sources?.length) extra.push(renderSources(sources));
  // 精简层级：正文写完本身就是「完成」信号，不再单独占一行播报「回答完成」。
  // 只有在「被停止」或有实质元信息（已带全文 N 字 / 联网 N 条）时才渲染这一行，两者都空就整行不渲染。
  const stateParts = [];
  if (status === 'stopped') stateParts.push('已停止 · 已保留当前回答');
  if (meta) stateParts.push(meta);
  if (stateParts.length) extra.push(el('div', { class: `entry-meta${status === 'stopped' ? ' stopped' : ''}`, text: stateParts.join(' · ') }));
  if (extra.length) entry.root.append(...extra);
  scheduleSessionSave();
  scrollBody(entry.root.closest('.ai-body'));
}

function addFailureRetry(entry, message, onRetry) {
  const rec = entry.root.__sessionRecord;
  if (rec) { rec.status = 'failed'; rec.text = ''; rec.meta = ''; }
  entry.root.classList.add('err');
  entry.acts.replaceChildren(el('button', { text: '重试这次发送', onclick: onRetry }));
  entry.acts.classList.remove('hidden');
  entry.root.querySelectorAll('.entry-meta').forEach((node) => node.remove());
  entry.root.append(el('div', { class: 'entry-meta failed', text: `发送失败：${message} · 问题和附件仍保留在输入区` }));
  scheduleSessionSave();
}

/**
 * 可恢复请求的最小持久化描述。截图只记「有过截图」及页码，永远不把 data URL 写进会话；
 * 这样跨重启仍能恢复问题、文字附件和范围开关，同时明确提示用户重新添加截图。
 */
function serialiseRetryPayload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = String(raw.kind || 'chat');
  if (kind === 'chat') {
    return {
      kind, docId: String(raw.docId || '').slice(0, 240), docTitle: String(raw.docTitle || '').slice(0, 240),
      inputValue: String(raw.inputValue || '').slice(0, 6000), question: String(raw.question || '').slice(0, 6000),
      quoteText: String(raw.quoteText || '').slice(0, 6000), firstPage: raw.firstPage || null,
      useFullText: !!raw.useFullText, useWeb: !!raw.useWeb,
      attachments: (Array.isArray(raw.attachments) ? raw.attachments : []).slice(0, 12).map((a) => {
        const kind0 = a?.kind === 'image' ? 'image' : 'text';
        return kind0 === 'image'
          ? { kind: 'image', page: a?.page || null, label: String(a?.label || '截图').slice(0, 120), screenshot: true }
          : { kind: 'text', page: a?.page || null, text: String(a?.text || '').slice(0, 3000) };
      }),
    };
  }
  if (kind === 'translate' || kind === 'explain') {
    return { kind, docId: String(raw.docId || '').slice(0, 240), text: String(raw.text || '').slice(0, 6000), page: raw.page || null };
  }
  if (kind === 'operation') {
    return { kind, docId: String(raw.docId || '').slice(0, 240), opId: String(raw.opId || '').slice(0, 120), block: String(raw.block || 'chat').slice(0, 40) };
  }
  return null;
}

let sessionSaveInFlight = null;
const persistSession = debounce(() => {
  sessionSaveInFlight = saveSessionNow().catch((e) => {
    toastAction('会话保存失败，当前内容仍保留。', '重试', saveSessionNow, 'err', 12000);
  });
}, 800);
function scheduleSessionSave() { if (state.doc) persistSession(); }

function sessionPayload() {
  if (!state.doc) return null;
  const entries = state.sessionEntries.slice(-90).map((x) => ({
    block: String(x.block || 'chat'), tag: String(x.tag || '').slice(0, 120), page: x.page || null,
    quote: String(x.quote || '').slice(0, 3000), kind: x.kind === 'user' ? 'user' : 'assistant',
    text: String(x.text || '').slice(0, 12000), screenshot: !!x.screenshot,
    status: ['pending', 'complete', 'stopped', 'failed', 'user'].includes(x.status) ? x.status : (x.kind === 'user' ? 'user' : 'complete'),
    sources: (Array.isArray(x.sources) ? x.sources : []).slice(0, 8).map((s) => ({ title: String(s.title || '').slice(0, 500), url: String(s.url || '').slice(0, 2000) })),
    meta: String(x.meta || '').slice(0, 500),
    retry: serialiseRetryPayload(x.retry),
  }));
  const prefix = `${state.doc.docId}:`;
  const ops = [...state.opsCache.entries()].filter(([key]) => key.startsWith(prefix)).slice(-20)
    .map(([key, value]) => ({ id: key.slice(prefix.length), text: String(value.text || '').slice(0, 12000), at: value.at || Date.now(), page: value.page || null }));
  const payload = { entries, history: state.history.slice(-80).map((m) => ({ role: m.role, content: String(m.content).slice(0, 12000) })), ops };
  let encoded = JSON.stringify(payload);
  const encodedBytes = () => new TextEncoder().encode(encoded).byteLength;
  while (encodedBytes() > 350000 && entries.length > 1) { entries.shift(); payload.entries = entries; encoded = JSON.stringify(payload); }
  while (encodedBytes() > 350000 && payload.ops.length) { payload.ops.shift(); encoded = JSON.stringify(payload); }
  while (encodedBytes() > 350000 && payload.history.length) { payload.history.shift(); encoded = JSON.stringify(payload); }
  return encoded;
}

async function saveSessionNow() {
  if (!state.doc) return;
  const encoded = sessionPayload();
  const r = await fetch(`/api/session?doc=${encodeURIComponent(state.doc.docId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: encoded,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

function restoreComposerFallback(question, payload = null) {
  const ta = $('#chatInput');
  if (!ta) return;
  const text = String(payload?.inputValue || question || '').trim();
  ta.value = text;
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(130, ta.scrollHeight)}px`;
  if (payload) {
    state.useFullText = !!payload.useFullText;
    state.useWeb = !!payload.useWeb;
    const textAttachments = (Array.isArray(payload.attachments) ? payload.attachments : [])
      .filter((a) => a?.kind === 'text' && String(a.text || '').trim())
      .map((a) => ({ id: uid(), kind: 'text', page: a.page || null, text: String(a.text).slice(0, 3000) }));
    state.attachments = textAttachments;
    renderAttachments();
    syncOptChips();
  }
  updateSendScope();
  ta.focus();
}

function restoreRetryCallback(row, entry, priorUser) {
  const payload = row?.retry && typeof row.retry === 'object' ? row.retry : null;
  const fallbackQuestion = String(priorUser?.text || row?.quote || '').replace(/\n\n【截图附件未保存，请重新添加截图】$/, '').slice(0, 6000);
  if (!payload) {
    return () => {
      restoreComposerFallback(fallbackQuestion);
      toast('已恢复问题到输入框；旧会话没有保存可自动重试的范围。', 'ok', 4200);
    };
  }
  return () => {
    if (payload.docId && payload.docId !== state.doc?.docId) {
      toast('这条请求属于另一篇论文，请切回原论文后重试', 'err', 3200);
      return;
    }
    if (payload.kind === 'translate' || payload.kind === 'explain') {
      const sel = { page: payload.page || null, text: payload.text || '', cleanText: payload.text || '' };
      if (!sel.cleanText) { restoreComposerFallback(fallbackQuestion); return; }
      if (payload.kind === 'translate') doTranslate(sel);
      else doExplain(sel);
      return;
    }
    if (payload.kind === 'operation') {
      runOperation(payload.opId, { force: true, block: payload.block || 'chat', retryEntry: entry });
      return;
    }
    const rawAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    const lostShots = rawAttachments.some((a) => a?.kind === 'image' || a?.screenshot);
    if (lostShots) {
      restoreComposerFallback(payload.question || fallbackQuestion, payload);
      toast('问题和文字附件已恢复；截图跨重启未保存，请重新添加截图后再发送。', 'ok', 5200);
      return;
    }
    const attachments = rawAttachments
      .filter((a) => a?.kind === 'text' && String(a.text || '').trim())
      .map((a) => ({ id: uid(), kind: 'text', page: a.page || null, text: String(a.text).slice(0, 3000) }));
    const pending = {
      inputValue: String(payload.inputValue || payload.question || ''),
      question: String(payload.question || fallbackQuestion || '请解释我加进来的这段内容。'),
      attachments,
      quoteText: String(payload.quoteText || attachments.map((a) => (a.page ? `[第${a.page}页] ` : '') + a.text).join('\n\n')),
      firstPage: payload.firstPage || attachments[0]?.page || entry.root.dataset.page || null,
      docId: state.doc?.docId || payload.docId || null,
      docTitle: state.doc?.name || payload.docTitle || '',
      history: state.history.map((m) => ({ role: m.role, content: m.content })),
      useFullText: !!payload.useFullText,
      useWeb: !!payload.useWeb,
      entry,
      userEntry: null,
    };
    if (!ensureReady()) {
      restoreComposerFallback(pending.question, payload);
      toast('已恢复问题；先配置模型接口，再点发送。', 'ok', 4200);
      return;
    }
    send(pending);
  };
}

async function restoreSession(docId) {
  try {
    const r = await fetch(`/api/session?doc=${encodeURIComponent(docId)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const saved = await r.json();
    state.sessionEntries = Array.isArray(saved.entries) ? saved.entries.slice(-90) : [];
    state.history = Array.isArray(saved.history) ? saved.history.slice(-80) : [];
    state.opsDone = {};
    state.opsDoc = docId;
    for (const op of Array.isArray(saved.ops) ? saved.ops : []) {
      if (!op?.id || typeof op.text !== 'string') continue;
      state.opsCache.set(`${docId}:${op.id}`, { text: op.text.slice(0, 12000), at: op.at || Date.now(), page: op.page || null });
      state.opsDone[op.id] = true;
    }
    for (let rowIndex = 0; rowIndex < state.sessionEntries.length; rowIndex += 1) {
      let row = state.sessionEntries[rowIndex];
      if (!row || typeof row !== 'object') continue;
      const safeBlock = AI_BLOCKS.some((b) => b.id === row.block) ? row.block : 'chat';
      // 右栏按需创建：恢复历史不能因为默认 hidden 就访问不存在的 blockMeta。
      ensureBlock(safeBlock);
      if (row.block !== safeBlock) {
        row = { ...row, block: safeBlock };
        state.sessionEntries[rowIndex] = row;
      }
      const text = `${String(row.text || '').slice(0, 12000)}${row.screenshot ? '\n\n【截图附件未保存，请重新添加截图】' : ''}`;
      const entry = addEntry({ ...row, text, restore: true });
      entry.root.__sessionRecord = row;
      const priorUser = [...state.sessionEntries.slice(0, rowIndex)].reverse().find((x) => x?.kind === 'user');
      const retry = restoreRetryCallback(row, entry, priorUser);
      if (row.kind !== 'user' && (row.text || row.status === 'stopped' || row.status === 'complete')) finishEntry(entry, row.text || '', {
        page: row.page, sources: row.sources, meta: row.meta,
        status: row.status === 'stopped' ? 'stopped' : 'complete',
        onRetry: row.status === 'stopped' ? retry : null,
      });
      else if (row.kind !== 'user' && row.status === 'failed') {
        entry.body.textContent = '上次发送失败。问题和文字附件保留在上一条消息中；截图没有保存。';
        entry.root.classList.add('err');
        entry.acts.replaceChildren(el('button', { text: '重试这次发送', onclick: retry }));
        entry.acts.classList.remove('hidden');
        entry.root.append(el('div', { class: 'entry-meta failed', text: '发送失败 · 问题和文字附件仍保留；截图需重新添加' }));
      } else if (row.kind !== 'user' && row.status === 'pending') {
        entry.body.textContent = '上次回答尚未完成。';
        entry.acts.replaceChildren(el('button', { text: '恢复并重试', onclick: retry }));
        entry.acts.classList.remove('hidden');
        entry.root.append(el('div', { class: 'entry-meta stopped', text: '未完成 · 问题和文字附件仍保留；截图需重新添加' }));
      }
    }
  } catch (e) { toast(`读取当前论文会话失败：${e.message}`, 'err', 5000); }
}

async function clearCurrentSession() {
  if (!state.doc || !confirm(`清空「${state.doc.name}」的对话和 AI 结果？`)) return;
  persistSession.cancel?.();
  state.sessionEntries = [];
  state.history = [];
  const prefix = `${state.doc.docId}:`;
  for (const key of state.opsCache.keys()) if (key.startsWith(prefix)) state.opsCache.delete(key);
  state.opsDone = {};
  clearAllBlocks();
  try {
    const r = await fetch(`/api/session?doc=${encodeURIComponent(state.doc.docId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries: [], history: [], ops: [] }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    toast('当前论文会话已清空', 'ok');
  } catch (e) { toastAction(`清空失败：${e.message}`, '重试', clearCurrentSession, 'err', 10000); }
}

/** 回答下面的来源列表：编号 + 标题（只提供外链） */
function renderSources(sources) {
  const list = el('ol', { class: 'src-list' }, ...sources.map((s, i) => {
    const a = el('a', {
      href: s.url,
      target: '_blank',
      rel: 'noreferrer',
      text: s.title || s.url,
      title: `${s.title || ''}\n${s.url}`,
    });
    // 标成「来源1」而不是「[1]」：论文正文里的 [27] 是它自己的参考文献编号，两者不能混
    const li = el('li', {}, el('span', { class: 'src-n', text: `[来源${i + 1}]` }), a);
    return li;
  }));
  const details = el('details', { class: 'source-details' },
    el('summary', { text: `来源 ${sources.length} 条` }), list,
  );
  if (uiStyle.showSources) details.open = true;
  return details;
}

/* ══════════════════════════ 浮层卡片：可拖动 ══════════════════════════ */

/**
 * 所有浮出来的卡片（划词气泡 / 结果浮层 / 参考文献 / 笔记 / 设置）都能拖动。
 *
 * 卡片都是 position:fixed + JS 算 left/top，所以拖动只要改这两个值就行。
 * 拖过的位置记在 cardPos 里，下次弹出来还在原地（双击手柄可以恢复自动位置）。
 * 唯一例外是划词气泡：它必须贴着新选中处出现，所以拖完不记位置。
 */
const cardPos = new Map();

/**
 * 夹住卡片的位置：
 *   · 装得下就整张留在屏幕里（别出现「按钮被切掉一半」）；
 *   · 卡片比视口还大时才允许露到外面，但至少留 28px 抓手，免得再也拖不回来。
 */
function clampCard(el, left, top) {
  const w = el.offsetWidth || 220;
  const h = el.offsetHeight || 60;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const minL = w <= vw ? 0 : vw - w;
  const maxL = w <= vw ? vw - w : Math.max(0, vw - 48);
  const minT = 0;
  const maxT = h <= vh ? vh - h : Math.max(0, vh - 28);
  return {
    left: Math.round(clamp(left, Math.min(minL, maxL), Math.max(minL, maxL))),
    top: Math.round(clamp(top, Math.min(minT, maxT), Math.max(minT, maxT))),
  };
}

/** 把卡片放到指定位置；remember=true 时记下来供下次弹出使用 */
function placeCard(el, left, top, remember = true) {
  const p = clampCard(el, left, top);
  el.style.left = `${p.left}px`;
  el.style.top = `${p.top}px`;
  el.style.right = 'auto';
  el.style.bottom = 'auto';
  if (remember && el.id) cardPos.set(el.id, p);
  return p;
}

function rememberedCardPos(el) {
  return el?.id ? cardPos.get(el.id) || null : null;
}

/**
 * @param el        卡片
 * @param handleSel 拖动把手的选择器；不传 = 整张卡片都能拖
 * @param opts.fromAnywhere 卡上全是按钮时用（气泡）：按下后移动超过阈值才算拖，
 *                          单纯点一下仍然是点按钮
 */
function makeDraggable(el, handleSel, { fromAnywhere = false, remember = true } = {}) {
  if (!el) return;
  const handle = handleSel ? el.querySelector(handleSel) : el;
  if (!handle) return;

  let dragging = false;
  let armed = false;      // 已按下，但还没越过阈值
  let sx = 0; let sy = 0; let ox = 0; let oy = 0;
  let suppressClick = false;

  const begin = () => {
    const r = el.getBoundingClientRect();
    dragging = true;
    armed = false;
    el.classList.add('dragging');
    // 设置弹窗平时是靠 flex 居中的，要拖它得先转成 fixed 定位；
    // 用测量到的 rect 当 left/top，视觉上原地不动。
    if (getComputedStyle(el).position !== 'fixed') {
      el.style.position = 'fixed';
      el.style.margin = '0';
    }
    el.style.left = `${Math.round(r.left)}px`;
    el.style.top = `${Math.round(r.top)}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    ox = r.left;
    oy = r.top;
  };

  /** 指针捕获要等「真的开始拖」了再要 */
  const capture = (pointerId) => {
    try { handle.setPointerCapture(pointerId); } catch { /* 忽略 */ }
  };
  const release = (pointerId) => {
    try { handle.releasePointerCapture(pointerId); } catch { /* 忽略 */ }
  };

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // 输入框里按下不算拖动，否则正文没法选字
    if (e.target.closest('input, textarea')) return;
    // 手柄上的按钮（复制/停止/关闭）要能正常点，别被拖动吃掉；
    // 气泡整条都是按钮，所以它用 fromAnywhere：按钮上也「预备」，但要走够 5px 才算拖。
    const onControl = e.target.closest('button, a, select, label, .no-drag');
    if (onControl && !fromAnywhere) return;
    armed = true;
    sx = e.clientX;
    sy = e.clientY;
    if (!fromAnywhere) {
      begin();
      capture(e.pointerId);
    }
    // 注意：这里绝对不能无条件 setPointerCapture ——
    // 指针一旦被捕获，后续 click 的目标会变成捕获元素本身，
    // 气泡上的「译 / 释 / ＋对话 / ✎」就全都点不动了（真实鼠标点，不是脚本 click）。
  });

  handle.addEventListener('pointermove', (e) => {
    if (!armed && !dragging) return;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (armed && !dragging) {
      if (Math.abs(dx) + Math.abs(dy) < 5) return;   // 还在点击的抖动范围内
      begin();
      capture(e.pointerId);
      suppressClick = true;
    }
    placeCard(el, ox + dx, oy + dy, remember);
  });

  const end = (e) => {
    if (!dragging && !armed) return;
    armed = false;
    dragging = false;
    el.classList.remove('dragging');
    release(e.pointerId);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);

  // 拖完那一下会顺手触发 click，得吃掉，不然会误触卡片上的按钮
  el.addEventListener('click', (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  // 双击手柄 = 忘掉拖过的位置，回到自动摆放
  handle.addEventListener('dblclick', (e) => {
    if (e.target.closest('input, textarea')) return;
    if (!cardPos.has(el.id)) return;
    cardPos.delete(el.id);
    toast('已恢复自动位置');
  });

  if (handleSel) handle.style.cursor = 'grab';
  el.classList.add('draggable-card');
}

function initDraggableCards() {
  // 气泡整条都是按钮，所以用「按下后移动才算拖」的模式；它不记位置，每次贴新的选区
  makeDraggable($('#bubble'), null, { fromAnywhere: true, remember: false });
  makeDraggable($('#popover'), '.pop-head');
  makeDraggable($('#citeBox'), '.pop-head');
  makeDraggable($('#noteBox'), '.pop-head');
  makeDraggable($('.modal-box'), '.modal-head');
  // 双击气泡上的空白处也能把它放回选区旁边
  $('#bubble')?.addEventListener('dblclick', () => hideBubble());
}

/** 浮层重新定位时用：拖动过就用拖动后的位置，没拖过才用自动算出来的 */
function applyCardPos(el, left, top) {
  const savedPos = rememberedCardPos(el);
  if (savedPos) {
    // 卡片尺寸可能变了（比如换了一段译文），重新夹一次别让它跑出屏幕
    return placeCard(el, savedPos.left, savedPos.top, false);
  }
  return { left: Math.round(left), top: Math.round(top) };
}

/* ══════════════════════════ 论文操作（可按需调用） ══════════════════════════ */

/**
 * 一排「对这篇论文能做的事」，用户自己挑；结果流进问答块，可缓存、可重新生成。
 * coach 模式（苏格拉底式多轮）是独立的、按需开启的模式，不在这里。
 */
function initOps() {
  const btn = $('#opsBtn');
  const menu = $('#opsMenu');
  if (!btn || !menu) return;

  // 首屏只放读者最常用的四个入口；其余操作仍完整保留在「更多操作」里。
  // 用 id 集合而不是按数组下标分组，后续给目录加操作时不会误把它挤进首屏。
  const FEATURED_OPS = new Set(['tldr', 'route', 'method', 'terms']);

  const build = () => {
    menu.replaceChildren();
    const head = el('div', { class: 'ops-head' },
      el('div', { class: 'ops-head-title', text: `对这篇论文能做的事${state.doc ? '' : '（先打开一篇）'}` }),
      el('div', { class: 'ops-head-note', text: '常用入口直接可选；低频操作在「更多操作」里展开' }));
    menu.append(head);

    const opButton = (op) => {
      const cached = state.opsDoc === state.doc?.docId && state.opsDone[op.id];
      return el('button', {
        class: 'ops-item' + (cached ? ' cached' : ''),
        type: 'button',
        title: op.hint,
        onclick: () => { hideOpsMenu(); runOperation(op.id, { force: false }); },
      },
      // ops.js 现在给的是 icons.js 的 id（不再是一堆平台相关的 Emoji）
      el('span', { class: 'ops-icon' }, iconEl(hasIcon(op.icon) ? op.icon : 'ops')),
      el('span', { class: 'ops-text' },
        el('span', { class: 'ops-title', text: op.title + (cached ? ' · 已生成' : '') }),
        el('span', { class: 'ops-hint', text: op.hint })));
    };
    const appendGroups = (root, predicate) => {
      for (const g of opGroups()) {
        const ops = g.ops.filter(predicate);
        if (!ops.length) continue;
        root.append(el('div', { class: 'ops-group', text: g.title }));
        for (const op of ops) root.append(opButton(op));
      }
    };

    const featured = el('div', { class: 'ops-featured', 'aria-label': '常用论文操作' });
    featured.append(el('div', { class: 'ops-group', text: '常用入口' }));
    for (const op of OPS.filter((x) => FEATURED_OPS.has(x.id))) featured.append(opButton(op));
    menu.append(featured);

    const more = el('details', {
      class: 'ops-more', id: 'moreOps',
      'aria-label': '更多论文操作',
    });
    more.append(el('summary', {
      text: `更多操作（${OPS.length - FEATURED_OPS.size}）`,
      title: '展开全部低频论文操作',
      'aria-label': '展开或收起更多论文操作',
    }));
    const moreBody = el('div', { class: 'ops-more-body' });
    appendGroups(moreBody, (op) => !FEATURED_OPS.has(op.id));
    more.append(moreBody);
    menu.append(more);

    // coach 模式：按需开启，不是默认入口
    menu.append(el('div', { class: 'ops-group', text: '低频模式' }));
    menu.append(el('button', {
      class: 'ops-item coach',
      type: 'button',
      title: COACH.hint,
      onclick: () => { hideOpsMenu(); startCoach(); },
    },
    el('span', { class: 'ops-icon' }, iconEl('graduation')),
    el('span', { class: 'ops-text' },
      el('span', { class: 'ops-title', text: COACH.title + '（按需开启）' }),
      el('span', { class: 'ops-hint', text: COACH.hint }))));
  };

  btn.onclick = (e) => {
    e.stopPropagation();
    const hidden = menu.classList.contains('hidden');
    if (hidden) { build(); menu.classList.remove('hidden'); } else { hideOpsMenu(); }
  };
  document.addEventListener('click', (e) => {
    if (menu.classList.contains('hidden')) return;
    if (e.target.closest('#opsMenu') || e.target.closest('#opsBtn')) return;
    hideOpsMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideOpsMenu(); });
}

function hideOpsMenu() { $('#opsMenu')?.classList.add('hidden'); }

/**
 * 跑一个操作。
 * 材料走 buildDocContext()：它已经处理好「全文 / 超长降级成索引+相关段落 / 按 docId 缓存」，
 * 操作不需要各自再实现一遍。
 */
async function runOperation(opId, { force = false, block = 'chat', retryEntry = null } = {}) {
  const op = opById(opId);
  if (!op) return null;
  if (!state.doc || !viewer?.pdf) { toast('先打开一篇论文', 'err', 3000); return null; }
  if (state.busy) { toast('正在生成中，等它跑完或者点停止', 'err', 3000); return null; }

  const docId = state.doc.docId;
  const cacheKey = `${docId}:${opId}`;
  const hit = state.opsCache.get(cacheKey);

  // 已经跑过就直接用缓存，不再花钱（除非点「重新生成」）
  if (hit && !force) {
    const existing = [...state.sessionEntries].reverse().find((x) => x?.block === block && x?.tag === op.title
      && x?.status === 'complete' && (x.retry?.opId === opId || String(x.text || '') === String(hit.text || '').slice(0, 12000)));
    if (existing) {
      showAiBlock(block);
      existing.root?.scrollIntoView?.({ block: 'nearest' });
      toast(`「${op.title}」已在结果区，点「重新生成」可以重跑`, 'ok', 3000);
      state.opsDone[opId] = true;
      return hit;
    }
    // 旧会话可能只保留了缓存而没有 DOM 记录：复用缓存，不凭空追加第二条结果。
    state.opsDone[opId] = true;
    toast(`「${op.title}」已恢复，点「重新生成」可以重跑`, 'ok', 3000);
    return hit;
  }

  if (!ensureReady()) return null;
  const entry = retryEntry || addEntry({ block, tag: op.title,
    retry: { kind: 'operation', docId, opId, block } });
  if (retryEntry) {
    entry.body.replaceChildren();
    entry.acts.replaceChildren();
    entry.acts.classList.add('hidden');
    entry.root.classList.remove('err', 'error');
    entry.root.querySelectorAll('.entry-meta, .src-list').forEach((node) => node.remove());
    const record = entry.root.__sessionRecord;
    if (record) { record.text = ''; record.meta = ''; record.status = 'pending'; }
  }
  const target = streamTarget(entry.body);
  const ctl = makeController();
  if (!ctl) return null;
  setBusy(true, `0s · ${op.title}`);
  let received = '';
  try {
    const ctx = await buildDocContext(op.ask, '');
    const messages = opMessages(op, {
      docTitle: state.doc?.name,
      fullText: ctx?.text,
      digest: state.docDigest,
    });
    const full = await chat({
      messages,
      signal: ctl.signal,
      onDelta: (piece, all) => { received = all; target.push(all); },
      onTick: (ms) => setBusy(true, `${(ms / 1000).toFixed(0)}s · ${op.title}`),
    });
    if (state.doc?.docId !== docId) return null;
    target.done(full);
    state.opsCache.set(cacheKey, { text: full, at: Date.now(), page: viewer.current });
    state.opsDone[opId] = true;
    if (state.opsDoc !== docId) { state.opsDoc = docId; }
    finishEntry(entry, full, {
      page: viewer.current,
      onAsk: () => { state.quote = { page: viewer.current, text: full.slice(0, 2000) }; toast('已设为引用，直接提问即可', 'ok', 2500); },
    });
    entry.acts.append(el('button', { text: '重新生成', onclick: () => runOperation(opId, { force: true, block, retryEntry: entry }) }));
    return { text: full };
  } catch (e) {
    if (state.doc?.docId !== docId) return null;
    if (isAbort(e)) {
      target.done(received);
      finishEntry(entry, received, {
        page: viewer.current, status: 'stopped',
        onRetry: () => runOperation(opId, { force: true, block, retryEntry: entry }),
      });
    } else {
      target.fail(errText(e));
      addFailureRetry(entry, errText(e), () => runOperation(opId, { force: true, block, retryEntry: entry }));
    }
    return null;
  } finally {
    if (state.abort === ctl) { state.abort = null; state.abortReason = ''; setBusy(false); }
  }
}

/**
 * coach 模式：按需开启。
 * 这里只是入口 + 状态标记；多轮问答循环按 docs/paper-explainer-plan.md 的 T1/T2 实现。
 */
function startCoach() {
  if (!state.doc) { toast('先打开一篇论文', 'err', 3000); return; }
  state.coach = true;
  const entry = addEntry({ block: 'chat', tag: 'Coach' });
  entry.body.innerHTML = renderMarkdown([
    '**Coach 模式**（按需开启）',
    '',
    '这个模式里我不会一口气讲完 —— 我会先问你一个问题，**等你回答之后再往下走**；',
    '答错了先给提示而不是直接给答案。',
    '',
    `流程：${COACH.steps.join(' → ')}`,
    '',
    '> 还在搭（见 `docs/paper-explainer-plan.md` 的 T1/T2）。现在先可以直接用上面那排**论文操作**，',
    '> 或者用「＋对话」把某一段加进来问我。',
  ].join('\n'));
  state.coach = false;
  toast('Coach 模式还在搭，先用「论文操作」', 'err', 4000);
}

/** 从检索结果里挑一个能打开的 http(s) 链接（优先 PDF 直链） */
function searchResultUrl(r) {
  const cand = r?.pdfUrl || r?.url || '';
  return /^https?:\/\//i.test(cand) ? cand : '';
}

/* ══════════════════════════ 文献关系整理 ══════════════════════════ */

/** 归一化标题：只留字母数字和汉字，用来判断「这条文献是不是书架里的某篇」 */
function titleKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');
}

/** 书架论文的标题索引。要求 ≥8 个字符：太短的文件名（bert.pdf）误判率太高，不参与匹配 */
function libIndex() {
  const out = [];
  for (const p of state.papers) {
    const key = titleKey(p.name.replace(/\.pdf$/i, ''));
    if (key.length >= 8) out.push({ key, paper: p });
  }
  return out;
}

function findInLibrary(text, idx) {
  const t = titleKey(text);
  if (t.length < 8) return null;
  for (const { key, paper } of idx) if (t.includes(key)) return paper;
  return null;
}

/**
 * 抽出过的书架论文正文：docId -> { sig, text }（只在内存里，重启即弃）。
 * R4：只按 docId 作键不够 —— 同名 PDF 被换掉（重新导入 / 覆盖）后 docId 不变，
 * 旧文本会一直被当成新文本用，库内引用扫描就会给出错误结论。
 * 所以每条缓存都带一个「内容指纹」（书架列表里的 size + mtime），指纹变了就重抽。
 */
const relTextCache = new Map();

/** 书架列表里那篇论文的内容指纹；拿不到 mtime（老后端）时退化成 size，仍比 docId 强 */
function paperSig(docId) {
  const p = state.papers.find((x) => x.docId === docId);
  if (!p) return '';
  return `${p.size || 0}:${Math.round(Number(p.mtime) || 0)}`;
}

/** 取某篇书架论文的正文（带内容指纹的缓存）；内容变了就重新抽 */
async function paperText(docId, url, opts) {
  const sig = paperSig(docId);
  const hit = relTextCache.get(docId);
  if (hit && hit.sig === sig && hit.text) return hit.text;
  const text = await extractPdfText(url, opts);
  relTextCache.set(docId, { sig, text });
  return text;
}

/**
 * 顶部那一行的临时进度。单独存在 state.relHint 里，是为了让 renderRelations() 重绘时
 * 不把进度覆盖掉（以前 relHint 写完就被 renderRelations 的 innerHTML 冲掉，进度一闪而过）。
 */
function relHint(t) {
  state.relHint = t || '';
  const node = $('#relSummary');
  if (node && state.relHint) node.textContent = state.relHint;
}

/* ── 阶段 3：引用条目的显式状态模型 ──────────────────────────────────────
   以前靠 `r.found?.pdfUrl` 的真值猜状态，「还没查 / 查过了但没有 / 查失败」在界面上
   分不出来，失败也不能单独重试。现在状态是显式枚举： */

/** status 枚举 + 徽标文案 + 归到哪一组 */
const REL_STATUS = {
  local:   { tag: '书架已有', cls: 'lib', group: 'lib' },
  idle:    { tag: '未查',     cls: '',    group: 'todo' },
  loading: { tag: '查询中',   cls: '',    group: 'todo' },
  pdf:     { tag: '已找到',   cls: 'has', group: 'pdf' },
  landing: { tag: '落地页',   cls: 'has', group: 'todo' },
  none:    { tag: '未找到',   cls: '',    group: 'todo' },
  error:   { tag: '查询失败', cls: 'err', group: 'todo' },
};
/** 「按状态」排序时的先后：越靠前越有用 */
const REL_STATUS_ORDER = ['local', 'pdf', 'landing', 'loading', 'idle', 'none', 'error'];

const REL_GROUPS = [
  { id: 'lib', title: '书架已有' },
  { id: 'pdf', title: '已找到开放版本' },
  { id: 'todo', title: '待查 / 未找到' },
  { id: 'cited', title: '被引用' },
];

/** 关系面板底部那排按钮里「还有几条要查」的口径：没入库、且还没出结果（含上次失败）的 */
const relNeedsQuery = (status) => status === 'idle' || status === 'error';

/**
 * 稳定 key：编号 + 文本前 60 字。
 * 「↻ 重新解析」会整批换掉 ref 对象，但在途请求靠这个 key 仍能落回重建后的新对象，
 * 而不是写进被丢弃的旧对象（那正是 `busy` 永久卡住的根因）。
 */
function relKey(ref) {
  return `${Number(ref?.num) || 0}:${String(ref?.text || '').slice(0, 60)}`;
}

/** 取某条引用的状态槽；key 相同但换了论文（同编号同开头，极少见）就重建一个 */
function relSlot(docId, ref) {
  const key = relKey(ref);
  let slot = state.relItemState.get(key);
  if (!slot || slot.docId !== docId) {
    slot = { key, docId, status: 'idle', found: null, fail: '', guessed: '' };
    state.relItemState.set(key, slot);
  }
  return slot;
}

/** 只查不建：正文里点的 [n] 未必在 state.refs 里（文本抽取口径略有差异），别为它凭空造槽 */
function relSlotIfAny(docId, ref) {
  const slot = state.relItemState.get(relKey(ref));
  return slot && slot.docId === docId ? slot : null;
}

/** 显式状态：书架里已经有这篇就是 local，其余看状态槽 */
function relStatusOf(docId, ref) {
  if (ref?.lib) return 'local';
  return relSlot(docId, ref).status;
}

/** 把一次检索结果写进状态槽（单条查 / 详情里查 / 搜索卡片都走这里，口径只有一个） */
function applyResultsToSlot(docId, ref, data) {
  if (!docId || ref?.lib) return null;
  const slot = relSlot(docId, ref);
  const list = (data?.results || []).filter((x) => x.pdfUrl || x.url);
  slot.found = list.find((x) => x.pdfUrl) || list[0] || null;   // 优先带 PDF 直链的
  slot.guessed = data?.title || '';
  slot.fail = '';
  slot.status = slot.found ? (slot.found.pdfUrl ? 'pdf' : 'landing') : 'none';
  // 兼容镜像：老代码 / 外部探针仍在读 ref.found
  ref.found = slot.found;
  ref.guessed = slot.guessed;
  return slot;
}

/** 把一次失败写进状态槽（只影响这一条，别的条目照常） */
function markSlotError(docId, ref, message) {
  if (!docId || ref?.lib) return null;
  const slot = relSlot(docId, ref);
  slot.status = 'error';
  slot.fail = String(message || '查询失败');
  return slot;
}

/* ── 阶段 3：代际令牌 ─────────────────────────────────────────────────── */

/**
 * 换论文：代际 +1。所有异步收尾都必须过 relStale 这一关。
 * 「↻ 重新解析」**不**走这里（它不换论文，在途查询要能落回新列表）。
 */
function relBumpGen() {
  state.relGen = (state.relGen || 0) + 1;
  state.refsSeq = (state.refsSeq || 0) + 1;   // 旧的解析也一并作废
  return state.relGen;
}

/** 这次异步是不是属于已经被换掉的那篇论文 */
function relStale(docId, gen) {
  return gen !== state.relGen || !docId || docId !== state.doc?.docId;
}

/** 视图状态（搜索 / 筛选 / 排序 / 折叠）：只活在内存里，切论文重置 */
function relView() {
  if (!state.relView) resetRelView();
  return state.relView;
}

function resetRelView() {
  state.relView = { q: '', filter: 'all', sort: 'num', fold: { lib: false, pdf: false, todo: false, cited: false } };
}

/** 条目里的年份（搜索与「按年份」排序都用它）：取最后一个 4 位年份 */
function relYear(text) {
  const m = String(text || '').match(/(?:19|20)\d{2}/g);
  return m ? Number(m[m.length - 1]) : 0;
}

/** 解析当前论文的参考文献，并和书架做匹配 */
async function buildRelations({ force = false } = {}) {
  if (!state.doc || !viewer?.pdf) { renderRelations(); return; }
  const docId = state.doc.docId;
  if (!force && state.refsDoc === docId) { renderRelations(); return; }
  const myGen = state.relGen;
  // 「解析 vs 解析」的先后：连点两次 ↻ 时，只有最后发起的这次算数
  const mySeq = (state.refsSeq = (state.refsSeq || 0) + 1);
  const parseStale = () => relStale(docId, myGen) || mySeq !== state.refsSeq;
  relHint('正在解析本文的参考文献…');
  try {
    const refs = await viewer.findAllReferences((p, total, n) => {
      if (parseStale()) return;
      relHint(`正在解析参考文献… p.${p}/${total}（已找到 ${n} 条）`);
    });
    if (parseStale()) return;                     // 代际 + docId + 本次解析序号，三重校验
    const idx = libIndex();
    for (const r of refs) {
      r.lib = findInLibrary(r.text, idx);
      // 建槽，并把已经查到过的结果镜像回新对象（↻ 之后列表上的徽标不会白白退回「未查」）
      const slot = relSlot(docId, r);
      if (slot.found) { r.found = slot.found; r.guessed = slot.guessed; }
    }
    state.refs = refs;
    state.refsDoc = docId;
    viewer.setReferencePages(refs);
    if (state.citedByDoc !== docId) { state.citedBy = []; state.citedByDoc = null; state.relScanned = null; }
  } catch {
    if (parseStale()) return;
    state.refs = [];
    state.refsDoc = docId;
    viewer.setReferencePages([]);
  }
  relHint('');
  renderRelations();
}

/**
 * 查一条文献的开放 PDF（复用 /api/ref-search：arXiv → OpenAlex → Crossref）。
 * ctx.docId / ctx.gen 由批量调用方传进来，保证整批用的是同一个代际；
 * 单条点按钮时不给，就用当前代际。
 */
async function lookupRefPdf(ref, ctx = {}) {
  const myDoc = ctx.docId || state.doc?.docId || null;
  const myGen = ctx.gen ?? state.relGen;
  if (!myDoc || !ref) return null;
  const slot = relSlot(myDoc, ref);
  // 正在查 / 已经有结果（含书架已有）就不重复打请求；idle / none / error 都允许再查一次
  if (slot.status === 'loading' || slot.status === 'local'
    || slot.status === 'pdf' || slot.status === 'landing') return slot;
  slot.status = 'loading';
  slot.fail = '';
  renderRelations();
  renderCiteDetail();
  try {
    const r = await fetch(`/api/ref-search?q=${encodeURIComponent(ref.text)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (relStale(myDoc, myGen)) return slot;    // 换论文了：这条结果属于上一篇，直接丢掉
    applyResultsToSlot(myDoc, ref, data);
  } catch (e) {
    if (relStale(myDoc, myGen)) return slot;
    markSlotError(myDoc, ref, e.message);
  } finally {
    if (!relStale(myDoc, myGen)) { renderRelations(); renderCiteDetail(); }
  }
  return slot;
}

/**
 * 批量找还没入库、还没查过的 PDF（一次最多 15 条）。
 * §3.5：单条失败只标这一条 error 并继续下一条，最后汇总「N 条成功 / M 条失败」，
 * 绝不因为一条报错就把整批中断。
 */
async function findMissingPdfs() {
  const docId = state.doc?.docId || null;
  if (!docId) return;
  const myGen = state.relGen;
  const refs = state.refsDoc === docId ? state.refs : [];
  const todo = refs.filter((r) => relNeedsQuery(relStatusOf(docId, r))).slice(0, 15);
  if (!todo.length) { toast('没有待查找的条目了', 'ok', 2500); return; }
  let ok = 0;
  let bad = 0;
  for (let i = 0; i < todo.length; i++) {
    if (relStale(docId, myGen)) return;         // R3：切论文了，整批停手，一条统计都不写
    relHint(`正在查 PDF ${i + 1}/${todo.length}…`);
    const slot = await lookupRefPdf(todo[i], { docId, gen: myGen });
    if (!slot || relStale(docId, myGen)) return;
    if (slot.status === 'error') bad++; else ok++;
  }
  relHint('');
  renderRelations();
  const withPdf = todo.filter((r) => relStatusOf(docId, r) === 'pdf').length;
  toast(`查完 ${todo.length} 条：${ok} 条成功（其中 ${withPdf} 条有 PDF 直链）· ${bad} 条失败（失败的可以单条重试）`,
    bad ? 'err' : 'ok', 4000);
}

/**
 * 扫描书架里其他论文有没有引用本文。
 *
 * R1/R2/R5：`others` 是开头捕获的，所以收尾写回的也必须是**开头那篇**的 docId 与名字；
 * 循环每一轮都先过一遍代际检查，切了论文就立刻收手（连 hint 都不再写）。
 */
async function scanLibraryRelations() {
  const docId = state.doc?.docId || null;
  if (!docId || state.relBusy) return;
  const myGen = state.relGen;
  const myName = state.doc.name;                    // R2：名字在这里定死
  const others = state.papers.filter((p) => p.docId !== docId);
  if (!others.length) { toast('书架里只有这一篇，暂时没有可比较的对象', 'err', 4000); return; }
  state.relBusy = true;
  renderRelations();
  const myKey = titleKey(myName.replace(/\.pdf$/i, ''));
  const citedBy = [];
  try {
    for (let i = 0; i < others.length; i++) {
      if (relStale(docId, myGen)) return;           // R1：切论文了，什么都不写
      const p = others[i];
      relHint(`扫描 ${i + 1}/${others.length}：${p.name.slice(0, 26)}`);
      try {
        const text = await paperText(p.docId, p.url, { maxPages: 40 });   // R4：带内容指纹的缓存
        if (relStale(docId, myGen)) return;
        if (myKey.length >= 8 && titleKey(text).includes(myKey)) citedBy.push(p);
      } catch { /* 单篇失败跳过 */ }
    }
    if (relStale(docId, myGen)) return;
    state.citedBy = citedBy;
    state.citedByDoc = docId;                       // R1：记在**我这次扫的那篇**头上
    state.relScanned = { docId, docName: myName, at: Date.now() };   // R2：用开头捕获的名字
  } finally {
    // 过期就别动新论文的 relBusy（它已经被 openDoc 重置过了），否则会把新论文的按钮又灰住
    if (!relStale(docId, myGen)) { state.relBusy = false; relHint(''); }
    renderRelations();
  }
}

/** 把工具条控件对齐到内存里的视图状态（值相同就不写，免得把光标顶到末尾） */
function syncRelTools(view) {
  const q = $('#relSearch');
  if (q && q.value !== view.q) q.value = view.q;
  const f = $('#relFilter');
  if (f && f.value !== view.filter) f.value = view.filter;
  const s = $('#relSort');
  if (s && s.value !== view.sort) s.value = view.sort;
}

/** 按搜索词过滤：编号 / 条目文本 / 年份 */
function relMatch(ref, q) {
  if (!q) return true;
  if (String(ref.num).includes(q) || `[${ref.num}]`.includes(q)) return true;
  if (String(ref.text || '').toLowerCase().includes(q)) return true;
  const y = relYear(ref.text);
  return y > 0 && String(y).includes(q);
}

/** 排序：编号（升）/ 年份（新 → 旧）/ 状态（有用的在前，同档按编号） */
function relSortRows(rows, sort) {
  const arr = [...rows];
  if (sort === 'year') arr.sort((a, b) => (relYear(b.ref.text) - relYear(a.ref.text)) || (a.ref.num - b.ref.num));
  else if (sort === 'status') {
    arr.sort((a, b) => (REL_STATUS_ORDER.indexOf(a.status) - REL_STATUS_ORDER.indexOf(b.status)) || (a.ref.num - b.ref.num));
  } else arr.sort((a, b) => a.ref.num - b.ref.num);
  return arr;
}

/**
 * 点关系列表里的一行 → 打开详情。
 * 复用正文 [n] 用的同一个 `#citeBox`（可拖动、e2e / relations 都在用），不新建第二套 UI。
 * 从列表进来的没有「原来在正文哪一页」这个语义，所以不给「返回原位置」，
 * 改用「跳回正文」（去 PDF 里这条文献所在的页）。
 */
function showRefDetail(ref) {
  if (!ref) return;
  showCiteBox(ref.num, ref, null, { canReturn: false });
}

/** 一行引用：结构与阶段 2 完全一致（.rt > .rn + 文本，.rrow > .rbtn + .rel-tag），只是多了一个「点行开详情」 */
function relItemRow(docId, row) {
  const { ref: r, status } = row;
  const meta = REL_STATUS[status] || REL_STATUS.idle;
  const slot = relSlotIfAny(docId, r);
  const rr = el('div', { class: 'rrow' });

  if (status === 'local') {
    rr.append(el('button', {
      class: 'rbtn primary', text: '打开',
      onclick: () => openDoc({ name: r.lib.name, url: r.lib.url, docId: r.lib.docId }),
    }));
  } else if (status === 'pdf' || status === 'landing') {
    const link = searchResultUrl(slot?.found);
    if (link) {
      rr.append(el('a', { class: 'rbtn primary', href: link, target: '_blank', rel: 'noreferrer', text: '打开链接' }));
      rr.append(el('button', { class: 'rbtn', text: '复制链接', onclick: () => copyText(link) }));
    }
  } else if (status === 'loading') {
    rr.append(el('button', { class: 'rbtn', text: '查询中…', disabled: true }));
  } else {
    // idle 未查 / none 没查到 / error 上次失败 —— 三种都能再查一次
    rr.append(el('button', {
      class: 'rbtn',
      text: status === 'error' ? '重试' : (status === 'none' ? '重查' : '查 PDF'),
      onclick: () => lookupRefPdf(r),
    }));
  }
  rr.append(el('span', { class: `rel-tag ${meta.cls}`.trim(), text: meta.tag }));
  rr.append(el('span', { class: 'rel-tag', text: `p.${r.page}` }));

  const li = el('li', {
    class: 'rel-item',
    dataset: { key: relKey(r), status },
    onclick: (e) => { if (!e.target.closest('button, a')) showRefDetail(r); },
  },
    el('div', { class: 'rt', title: `${r.text}\n（点这一行看详情）` },
      el('span', { class: 'rn', text: `[${r.num}]` }),
      document.createTextNode(r.text)),
    rr);
  return li;
}

/** 一个可折叠分组：标题带计数，组内是 .rel-item */
function relGroupEl(group, rows, view) {
  const folded = !!view.fold[group.id];
  const head = el('button', {
    class: 'rel-group-head', type: 'button', dataset: { group: group.id },
    'aria-expanded': folded ? 'false' : 'true',
  },
    el('span', { class: 'rg-caret' }, iconEl('caret-down', { size: 14 })),
    el('span', { class: 'rg-title', text: group.title }),
    el('span', { class: 'rg-count', text: `(${rows.length})` }));
  const ul = el('ul', { class: 'rel-group-list' });
  for (const row of rows) ul.append(relItemRow(state.doc.docId, row));
  const li = el('li', {
    class: `rel-group${folded ? ' collapsed' : ''}`,
    dataset: { group: group.id },
  }, head, ul);
  return li;
}

function renderRelations() {
  const sum = $('#relSummary');
  const list = $('#relList');
  const cnt = $('#relCount');
  if (!sum || !list) return;
  const findBtn = $('#relFindPdf');
  const scanBtn = $('#relScanLib');
  const view = relView();
  syncRelTools(view);

  if (!state.doc) {
    sum.textContent = '打开一篇论文后自动整理';
    list.replaceChildren();
    if (cnt) cnt.textContent = '';
    if (findBtn) findBtn.disabled = true;
    if (scanBtn) scanBtn.disabled = true;
    return;
  }
  const docId = state.doc.docId;
  const refs = state.refsDoc === docId ? state.refs : null;
  if (!refs) {
    sum.textContent = state.relHint || (state.relBusy ? '正在整理…' : '还没整理，点右上角 ↻');
    list.replaceChildren();
    if (cnt) cnt.textContent = '';
    if (findBtn) findBtn.disabled = true;
    if (scanBtn) scanBtn.disabled = !!state.relBusy;
    return;
  }

  // 每条引用的显式状态 → 三个引用分组
  const rows = refs.map((ref) => ({ ref, status: relStatusOf(docId, ref) }));
  const byGroup = { lib: [], pdf: [], todo: [] };
  for (const row of rows) (byGroup[REL_STATUS[row.status]?.group || 'todo']).push(row);
  const cited = state.citedByDoc === docId ? state.citedBy : [];
  const scanned = state.relScanned?.docId === docId;

  const bits = [
    `本文引用 <b>${refs.length}</b> 篇`,
    `书架已有 <b>${byGroup.lib.length}</b> 篇`,
    `查到开放版本 <b>${byGroup.pdf.length}</b> 条`,
    `待查 <b>${byGroup.todo.length}</b> 条`,
  ];
  if (scanned) bits.push(`库内 <b>${cited.length}</b> 篇引用了本文`);
  else if (state.papers.length > 1) bits.push('未扫描库内引用');
  // 进度里可能带文件名，一律走 textContent，不进 innerHTML
  if (state.relHint) sum.textContent = state.relHint;
  else sum.innerHTML = bits.join(' · ');
  if (cnt) cnt.textContent = refs.length ? `(${refs.length})` : '';

  const out = [];
  // 结论行：`.rel-cited` 这个类与文案都保持不变（relations.mjs 依赖它）
  if (refs.length) {
    const h = el('li', { class: 'rel-cited' });
    h.innerHTML = byGroup.lib.length
      ? `本文引用了书架里的：${byGroup.lib.map((x) => `<b>${esc(x.ref.lib.name.replace(/\.pdf$/i, ''))}</b>`).join('、')}`
      : '本文没有引用书架里已有的论文';
    if (cited.length) {
      h.innerHTML += `<br>书架里引用了本文的：${cited.map((p) => `<b>${esc(p.name.replace(/\.pdf$/i, ''))}</b>`).join('、')}`;
    }
    out.push(h);
  }

  // 被引用组：只在真的有库内引用（或用户明确筛它）时出现
  const showCited = cited.length > 0 || view.filter === 'cited';

  for (const group of (refs.length ? REL_GROUPS : [])) {
    // 状态筛选：不是「全部」时只渲染被选中的那一组（「被引用」组也走这条）
    if (view.filter !== 'all' && view.filter !== group.id) continue;
    if (group.id === 'cited') {
      if (!showCited) continue;
      const rowsC = cited.filter((p) => relMatch({ num: '', text: p.name }, view.q));
      // 只有「全部 + 有搜索词」才把空组藏起来；显式筛某一组时 0 条也要画出来（否则点了没反馈）
      if (!rowsC.length && view.q && view.filter === 'all') continue;
      const head = el('button', {
        class: 'rel-group-head', type: 'button', dataset: { group: 'cited' },
        'aria-expanded': view.fold.cited ? 'false' : 'true',
      },
        el('span', { class: 'rg-caret' }, iconEl('caret-down', { size: 14 })),
        el('span', { class: 'rg-title', text: '被引用' }),
        el('span', { class: 'rg-count', text: `(${rowsC.length})` }));
      const ul = el('ul', { class: 'rel-group-list' });
      for (const p of rowsC) {
        ul.append(el('li', { class: 'rel-cited-row' },
          el('span', { class: 'rc-name', text: p.name.replace(/\.pdf$/i, '') })));
      }
      out.push(el('li', {
        class: `rel-group${view.fold.cited ? ' collapsed' : ''}`,
        dataset: { group: 'cited' },
      }, head, ul));
      continue;
    }
    let rowsG = byGroup[group.id].filter((x) => relMatch(x.ref, view.q));
    rowsG = relSortRows(rowsG, view.sort);
    // 默认（没有搜索/筛选）时三组都出现，哪怕是 0 —— 用户要看得到「一条都没有」这个结论
    if (!rowsG.length && view.q && view.filter === 'all') continue;
    out.push(relGroupEl(group, rowsG, view));
  }

  list.replaceChildren(...out);

  if (!refs.length) {
    list.append(el('li', { class: 'empty', text: '没在文末找到编号式参考文献（[1] [2] …）。扫描版 PDF 抽不出文字，这类关系整理不了。' }));
  }

  if (findBtn) {
    const left = rows.filter((x) => relNeedsQuery(x.status)).length;
    findBtn.textContent = left ? `找未入库的 PDF（${left}）` : '都查过了';
    findBtn.disabled = !left || state.relBusy;
  }
  if (scanBtn) {
    scanBtn.textContent = state.relBusy ? '扫描中…' : '扫描库内引用';
    scanBtn.disabled = state.relBusy;
  }
}

function initRelations() {
  $('#relRescan').onclick = () => { state.refsDoc = null; buildRelations({ force: true }); };
  $('#relFindPdf').onclick = () => findMissingPdfs();
  $('#relScanLib').onclick = () => scanLibraryRelations();
  // 搜索 / 筛选 / 排序：只改内存里的视图状态再重绘，不写 localStorage
  const q = $('#relSearch');
  if (q) q.addEventListener('input', () => { relView().q = q.value.trim().toLowerCase(); renderRelations(); });
  const f = $('#relFilter');
  if (f) f.addEventListener('change', () => { relView().filter = f.value; renderRelations(); });
  const s = $('#relSort');
  if (s) s.addEventListener('change', () => { relView().sort = s.value; renderRelations(); });
  // 分组折叠用事件委托 —— 列表每次重绘都会 replaceChildren，逐组绑监听会全丢
  $('#relList').addEventListener('click', (e) => {
    const head = e.target.closest('.rel-group-head');
    if (!head) return;
    const g = head.dataset.group;
    const v = relView();
    v.fold[g] = !v.fold[g];
    renderRelations();
  });
  renderRelations();
}

/* ══════════════════════════ 外链一律交给系统浏览器 ══════════════════════════ */

/**
 * 应用是 WebView2 外壳，页面里的 `<a target="_blank">` **默认什么都不会发生**
 * —— 用户反馈的「论文查找里的网页链接点不动」就是这个原因。
 * 而如果去掉 target 让它在应用窗口里直接跳，又会被外站顶掉整个界面、还退不回来。
 *
 * 所以：所有 http(s) 链接统一拦下来，交给后端用系统默认浏览器打开。
 * 用事件委托，页面上不管哪里冒出来的链接（包括后来动态加进来的）都走这条路。
 */
function openExternal(target) {
  const u = String(target || '').trim();
  if (!/^https?:\/\//i.test(u)) return false;
  // 本地应用 URL（包括 ?window=panel）必须留在 WebView 内，不能被当成外链
  // 交给 /api/open-url；否则打开独立面板会退化成系统浏览器标签页。
  try {
    if (new URL(u, location.href).origin === location.origin) return false;
  } catch { return false; }
  fetch(`/api/open-url?url=${encodeURIComponent(u)}`)
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); })
    .catch(() => {
      // 后端打不开时至少把地址给用户，不至于点了一点反馈都没有
      copyText(u);
      toast('打不开系统浏览器，链接已复制到剪贴板', 'err', 5000);
    });
  return true;
}

/**
 * 测试用：量一量画出来的「选中方块」是不是真的压在选中的文字上。
 * 做法是拿选区里的几个词去正文里找对应的 span，再看每个 span 的中心有没有被方块盖住。
 * 缩放之后浏览器自己的选区已经没了，所以只能这样独立地验。
 */
function selectionAlignProbe() {
  const marks = [...document.querySelectorAll('.sel-mark')].map((m) => m.getBoundingClientRect());
  const sel = state.selection;
  if (!sel || !marks.length) return { marks: marks.length, total: 0, hit: 0, ratio: 0 };
  const pageEl = document.querySelector(`.page[data-page="${sel.page}"]`);
  const spans = pageEl ? [...pageEl.querySelectorAll('.textLayer span:not(.markedContent)')] : [];
  const words = String(sel.cleanText || '').split(/\s+/).filter((w) => w.length >= 4).slice(0, 8);
  let hit = 0;
  for (const w of words) {
    const span = spans.find((s) => (s.textContent || '').includes(w));
    if (!span) continue;
    const r = span.getBoundingClientRect();
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    if (marks.some((m) => cx >= m.left - 4 && cx <= m.right + 4 && cy >= m.top - 4 && cy <= m.bottom + 4)) hit++;
  }
  return { marks: marks.length, total: words.length, hit, ratio: words.length ? hit / words.length : 0 };
}

function initExternalLinks() {
  // 捕获阶段拦，抢在别的处理函数之前
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const a = e.target?.closest?.('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(href)) return;    // 站内相对链接照常走
    e.preventDefault();
    openExternal(href);
  }, true);

  // window.open 也走同一条路（看大图之类用的是它）
  const nativeOpen = window.open.bind(window);
  window.open = (target, ...rest) => {
    if (typeof target === 'string' && openExternal(target)) return null;
    return nativeOpen(target, ...rest);
  };
}

/** 只在用户已经在底部时才自动跟随，上滚阅读时不抢滚动条 */
function scrollBody(node) {
  if (!node) return;
  const near = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
  if (near) requestAnimationFrame(() => { node.scrollTop = node.scrollHeight; });
}

/**
 * 流式渲染目标：~30fps 合帧 + 只在贴底时自动跟随。
 * 注意：不能只靠 requestAnimationFrame —— 窗口被遮挡/最小化/无头环境下
 * rAF 会被浏览器节流甚至完全不触发，那样文字会攒到全部生成完才一次性出现，
 * 看起来就像「卡住了」。所以再挂一个定时器兜底。
 */
function streamTarget(node) {
  let pending = null;
  let rawNode = null;
  let paintedText = '';
  let cursorNode = null;
  const scan = { cursor: 0, safe: 0, fence: '', inMath: false };
  let raf = 0;
  let timer = 0;
  const stopTimers = () => {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (timer) { clearTimeout(timer); timer = 0; }
  };
  const ensureTail = () => {
    if (rawNode?.parentNode === node) return;
    rawNode = document.createTextNode('');
    cursorNode = el('span', { class: 'cursor' });
    node.append(rawNode, cursorNode);
  };
  const paint = () => {
    stopTimers();
    if (pending === null) return;
    const parent = node.closest('.ai-body');
    const follow = parent && parent.scrollHeight - parent.scrollTop - parent.clientHeight < 100;
    if (!pending.startsWith(paintedText)) {
      node.replaceChildren();
      rawNode = null;
      cursorNode = null;
      paintedText = '';
      scan.cursor = 0; scan.safe = 0; scan.fence = ''; scan.inMath = false;
    }
    ensureTail();
    const safeEnd = completedMarkdownEnd(pending, scan);
    if (safeEnd > paintedText.length) {
      const template = document.createElement('template');
      template.innerHTML = renderMarkdown(pending.slice(paintedText.length, safeEnd));
      node.insertBefore(template.content, rawNode);
      paintedText = pending.slice(0, safeEnd);
    }
    rawNode.data = pending.slice(paintedText.length);
    if (follow) requestAnimationFrame(() => { parent.scrollTop = parent.scrollHeight; });
  };
  return {
    push(text) {
      pending = text;
      if (raf || timer) return;
      raf = requestAnimationFrame(paint);
      timer = setTimeout(paint, 120);   // rAF 被节流时的兜底
    },
    done(finalText) {
      stopTimers();
      pending = null;
      node.innerHTML = renderMarkdown(finalText);
      rawNode = null; cursorNode = null; paintedText = '';
      scrollBody(node.closest('.ai-body'));
    },
    fail(msg) {
      stopTimers();
      pending = null;
      node.innerHTML = `<span style="color:var(--err)">${esc(msg)}</span>`;
      rawNode = null; cursorNode = null; paintedText = '';
      scrollBody(node.closest('.ai-body'));
    },
  };
}

/** Find a finished Markdown block boundary without interpreting an open fence or display formula. */
function completedMarkdownEnd(text, scan) {
  while (scan.cursor < text.length) {
    const nl = text.indexOf('\n', scan.cursor);
    if (nl < 0) break; // leave the unfinished final line as plain, stable tail text
    const lineEnd = nl + 1;
    const line = text.slice(scan.cursor, nl);
    const trimmed = line.trim();
    if (scan.fence) {
      const close = trimmed.match(/^(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === scan.fence[0] && close[1].length >= scan.fence.length) {
        scan.fence = '';
        scan.safe = lineEnd;
      }
    } else if (scan.inMath) {
      if (trimmed.includes('$$')) { scan.inMath = false; scan.safe = lineEnd; }
    } else {
      const open = trimmed.match(/^(`{3,}|~{3,})/);
      if (open) scan.fence = open[1];
      else if (trimmed.startsWith('$$')) {
        const count = (trimmed.match(/\$\$/g) || []).length;
        if (count >= 2) scan.safe = lineEnd;
        else scan.inMath = true;
      } else if (!trimmed) scan.safe = lineEnd;
    }
    scan.cursor = lineEnd;
  }
  return scan.safe;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/* ══════════════════════════════ 译 / 释 / 问 ══════════════════════════════ */

function ensureReady() {
  const d = Settings.data;
  if (!d.baseURL) { openSettings(); return false; }
  const local = /127\.0\.0\.1|localhost/.test(d.baseURL);
  if (!d.hasApiKey && !local) { openSettings('先填 API Key'); return false; }
  return true;
}

/** 统一入口：注入空闲超时，避免界面像卡死一样一直转 */
function chat(opts) {
  return streamChat({ idleMs: Number(Settings.data.idleMs) || 60000, ...opts });
}

function makeController() {
  if (state.busy) return null;
  const ctl = new AbortController();
  state.abort = ctl;
  state.abortReason = '';
  return ctl;
}

function abortStream(reason = 'user') {
  const ctl = state.abort;
  if (ctl) {
    state.abortReason = reason;
    try { ctl.abort(); } catch { /* ignore */ }
  }
}

function setBusy(on, hint = '') {
  state.busy = on;
  if (!on) state.activeSendScope = '';
  $('#stopBtn').classList.toggle('hidden', !on || !state.abort);
  $('#popStop').classList.toggle('hidden', !on || !state.abort);
  $('#sendBtn').disabled = on;
  $('#composerHint').textContent = on ? hint : '';
  $('#clipBtn').disabled = on;
  $('#regionBtn').disabled = on;
  $$('#attachRow .at-x').forEach((button) => { button.disabled = on; });
  $('#optFull').disabled = on || !state.doc || state.viewerDocId !== state.doc?.docId;
  $('#optWeb').disabled = on;
  $('#clearSession').disabled = on;
  updateSendScope();
}

function sendScopeText({ attachments, history, useFullText, useWeb, query, docId, fullMode, contextIncluded } = {}) {
  const rows = attachments || [];
  const quotes = rows.filter((a) => a.kind === 'text');
  const images = rows.filter((a) => a.kind === 'image');
  const parts = [];
  if (quotes.length) parts.push(`选区 ${quotes.length} 段`);
  if (images.length) parts.push(`图片 ${images.length} 张`);
  const hasDoc = !!docId && !!viewer?.pdf && state.doc?.docId === docId && state.viewerDocId === docId;
  if (hasDoc && (contextIncluded === undefined ? true : contextIncluded)) {
    parts.push(quotes.length ? '附近上下文' : '当前页上下文');
  }
  if (hasDoc && useFullText) {
    let mode = fullMode;
    if (!mode && state.docTextDoc === docId) {
      mode = !state.docText ? 'unavailable' : (state.docText.length > FULL_LIMIT ? 'digest' : 'full');
    }
    if (mode === 'full') parts.push('整篇论文');
    else if (mode === 'digest') parts.push(`整篇论文索引 + ${PICK_K} 段相关原文`);
    else if (mode === 'unavailable') parts.push('整篇论文暂不可提取');
    else parts.push('整篇论文（将增加读取 / 请求量）');
  }
  const prior = Math.min(6, (history || []).length);
  if (prior) parts.push(`最近 ${prior} 条对话`);
  if (useWeb && String(query || '').trim()) parts.push('联网搜索');
  if (!parts.length && String(query || '').trim()) parts.push('仅当前问题');
  return parts.join(' · ');
}

function updateSendScope() {
  const node = $('#sendScope');
  if (!node) return;
  const content = state.busy && state.activeSendScope
    ? `本次发送：${state.activeSendScope}`
    : sendScopeText({
      attachments: state.attachments,
      history: state.history,
      useFullText: state.useFullText,
      useWeb: state.useWeb,
      query: $('#chatInput')?.value,
      docId: state.doc?.docId,
    });
  node.textContent = content;
  node.classList.toggle('hidden', !content);
}

/**
 * 译文**直接进侧栏**，不弹浮层（用户口径 2026-10-04：
 *   「划词翻译不要弄成弹窗了，应该是直接就在侧边栏显示」。
 *
 * 三件事：
 *   ① 译文块必须是「显示中」（否则用户看不到东西）；
 *   ② 右栏若被收起了，展开它 —— 结果总得有个地方显示；
 *   ③ 若译文块被拖成了应用内卡片，把它收回右栏（卡片会浮在正文上，正是"被挡住"的来源）。
 */
function revealTranslatePanel() {
  const p = state.panels.translate;
  if (!p) return;
  if (p.dock === 'float') dockPanelTo('translate', 'right');
  showAiBlock('translate');                       // visible = true
  if (document.body.classList.contains('no-right')) setSideCollapsed('right', false, true);
  document.querySelector('#rightSide')?.setAttribute('data-active-panel', 'translate');
  applyPanels();
}

async function doTranslate(sel) {
  if (state.busy) return;
  const text = sel.cleanText || cleanText(sel.text);
  if (!text || !ensureReady()) return;
  const lang = targetLangFor(text);
  const key = `${lang}::${text.length}-${hashStr(text)}`;
  const cached = state.cache.get(key);

  if (cached) {
    const existing = [...state.sessionEntries].reverse().find((x) => x?.block === 'translate'
      && x?.tag === 'translation' && x?.status === 'complete' && x?.quote === text
      && String(x?.text || '') === String(cached));
    if (existing) {
      revealTranslatePanel();
      existing.root?.scrollIntoView?.({ block: 'nearest' });
      toast('这段翻译已在结果区，直接使用原结果', 'ok', 1800);
      return;
    }
  }
  revealTranslatePanel();
  const entry = addEntry({ block: 'translate', tag: 'translation', page: sel.page, quote: text,
    retry: { kind: 'translate', docId: state.doc?.docId || null, text, page: sel.page || null } });
  if (cached) {
    entry.body.innerHTML = renderMarkdown(cached);
    finishEntry(entry, cached, { page: sel.page, onAsk: () => addToChat(sel) });
    toast('这段翻过，直接用缓存', 'ok', 1500);
    return;
  }

  const target = streamTarget(entry.body);
  const ctl = makeController();
  if (!ctl) return;
  setBusy(true, '0s');
  let received = '';
  try {
    const context = sel.page ? await viewer.getContextAround(sel.page, text) : '';
    const full = await chat({
      messages: translateMessages({ text, targetLang: lang, context, page: sel.page, docTitle: state.doc?.name }),
      signal: ctl.signal,
      onDelta: (piece, all) => { received = all; target.push(all); },
      onTick: (ms) => setBusy(true, `${(ms / 1000).toFixed(0)}s`),
    });
    const clean = full.trim();
    target.done(clean);
    state.cache.set(key, clean);
    finishEntry(entry, clean, { page: sel.page, onAsk: () => addToChat(sel) });
  } catch (e) {
    if (isAbort(e)) {
      target.done(received);
      finishEntry(entry, received, { page: sel.page, status: 'stopped', onRetry: () => doTranslate(sel) });
    }
    else {
      target.fail(errText(e));
      addFailureRetry(entry, errText(e), () => doTranslate(sel));
    }
  } finally {
    if (state.abort === ctl) { state.abort = null; state.abortReason = ''; setBusy(false); }
  }
}

async function doExplain(sel) {
  if (state.busy) return;
  const text = sel.cleanText || cleanText(sel.text);
  if (!text || !ensureReady()) return;
  // 「释」直接写在侧栏里，不弹浮层 —— 解释是要读的，不是瞄一眼的
  const entry = addEntry({ block: 'chat', tag: 'explanation', page: sel.page, quote: text,
    retry: { kind: 'explain', docId: state.doc?.docId || null, text, page: sel.page || null } });
  const target = streamTarget(entry.body);
  const ctl = makeController();
  if (!ctl) return;
  setBusy(true, '0s');
  let received = '';
  try {
    const context = sel.page ? await viewer.getContextAround(sel.page, text) : '';
    const full = await chat({
      messages: explainMessages({ selection: text, context, page: sel.page, docTitle: state.doc?.name }),
      signal: ctl.signal,
      onDelta: (piece, all) => { received = all; target.push(all); },
      onTick: (ms) => setBusy(true, `${(ms / 1000).toFixed(0)}s`),
    });
    target.done(full);
    finishEntry(entry, full, { page: sel.page, onAsk: () => addToChat(sel) });
  } catch (e) {
    if (isAbort(e)) {
      target.done(received);
      finishEntry(entry, received, { page: sel.page, status: 'stopped', onAsk: () => addToChat(sel), onRetry: () => doExplain(sel) });
    }
    else {
      target.fail(errText(e));
      addFailureRetry(entry, errText(e), () => doExplain(sel));
    }
  } finally {
    if (state.abort === ctl) { state.abort = null; state.abortReason = ''; setBusy(false); }
  }
}

/* ══════════════════════════════ 加入对话（可加多个） ══════════════════════════════ */

const uid = () => `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 把选中的文字加进「待发送附件」，可以连续加多段，也可以再加图片 */
function addToChat(sel) {
  if (!sel || state.busy) return;
  const text = sel.cleanText || cleanText(sel.text || '');
  if (!text) return;
  state.attachments.push({ id: uid(), kind: 'text', page: sel.page || viewer?.current, text });
  renderAttachments();
  $('#chatInput').focus();
  flashHint(`已加入对话（共 ${state.attachments.length} 项，可以继续加）`);
}

/** 把一张截图加进附件 */
function addImageToChat(shot, page, label, { allowBusy = false } = {}) {
  if (state.busy && !allowBusy) return;
  state.attachments.push({
    id: uid(), kind: 'image', page, dataUrl: shot.dataUrl,
    w: shot.width, h: shot.height, pages: shot.pages || 1, label,
  });
  renderAttachments();
  $('#chatInput').focus();
  flashHint(`已加入截图${shot.pages > 1 ? `（跨 ${shot.pages} 页）` : ''}，共 ${state.attachments.length} 项`);
}

function removeAttach(id) {
  if (state.busy) return;
  state.attachments = state.attachments.filter((a) => a.id !== id);
  renderAttachments();
}

function takeAttachments() {
  const list = state.attachments.slice();
  state.attachments = [];
  renderAttachments();
  return list;
}

function renderAttachments() {
  const row = $('#attachRow');
  if (!row) return;
  if (!state.attachments.length) {
    row.classList.add('hidden');
    row.replaceChildren();
    updateSendScope();
    return;
  }
  row.classList.remove('hidden');
  row.replaceChildren(...state.attachments.map((a) => el('div', { class: `attach ${a.kind}` },
    a.kind === 'image'
      ? el('img', { src: a.dataUrl, title: '点开看大图', onclick: () => window.open(a.dataUrl, '_blank') })
      : null,
    el('span', { class: 'at-meta' },
      a.page ? el('b', { text: `第${a.page}页` }) : null,
      el('span', { class: 'at-text', text: a.kind === 'image' ? (a.label || '截图') : a.text.replace(/\s+/g, ' ') }),
    ),
    el('button', { type: 'button', class: 'at-x', title: '移除', onclick: () => removeAttach(a.id) }, iconEl('close', { size: 13 })),
  )));
  $$('#attachRow .at-x').forEach((button) => { button.disabled = state.busy; });
  updateSendScope();
}

let hintTimer = null;
function flashHint(msg, ms = 3200) {
  const node = $('#composerHint');
  node.textContent = msg;
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { if (!state.busy) node.textContent = ''; }, ms);
}

/* ══════════════════════════════ 对话 ══════════════════════════════ */

function initComposer() {
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  $('#stopBtn').onclick = () => { abortStream('user'); $('#composerHint').textContent = '正在停止…'; };
  $('#clipBtn').onclick = () => state.startRegion?.();
  $('#clearSession').onclick = clearCurrentSession;
  renderAttachments();

  $('#optFull').onclick = () => {
    if (state.busy) return;
    state.useFullText = !state.useFullText;
    syncOptChips();
    setHint(state.useFullText ? '本次发送将带整篇论文，读取和请求量会增加' : '默认：选中文字和当前页上下文');
    if (state.useFullText) warmDocText();          // 只在本次明确选择后读取
    updateSendScope();
  };
  $('#optWeb').onclick = () => {
    if (state.busy) return;
    state.useWeb = !state.useWeb;
    writeFlag('reader.web', state.useWeb);
    syncOptChips();
    setHint(state.useWeb ? '开：回答前先联网搜一遍，并在回答里标出来源' : '');
    updateSendScope();
  };
  syncOptChips();

  const ta = $('#chatInput');
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(130, ta.scrollHeight)}px`;
    updateSendScope();
  });
}

function syncOptChips() {
  const f = $('#optFull');
  const w = $('#optWeb');
  if (f) {
    f.classList.toggle('on', state.useFullText);
    f.setAttribute('aria-pressed', state.useFullText ? 'true' : 'false');
    f.title = state.useFullText
      ? '本次发送：带整篇论文（会增加读取 / 请求量；发送后自动关闭）'
      : '只发送选中文字和当前页上下文；点“整篇”可临时扩大范围';
    f.disabled = state.busy || !state.doc || !viewer?.pdf || state.viewerDocId !== state.doc?.docId;
  }
  if (w) {
    w.classList.toggle('on', state.useWeb);
    w.setAttribute('aria-pressed', state.useWeb ? 'true' : 'false');
    w.title = state.useWeb
      ? '已开：回答前先联网搜索，回答里会标出来源编号'
      : '关：只用论文内容和模型自身的知识回答';
    w.disabled = state.busy;
  }
  updateSendScope();
}

/** 输入框下面那行小字，用于显示进度；传空字符串清掉 */
function setHint(t) {
  const h = $('#composerHint');
  if (h) h.textContent = t || '';
}

/** 用户明确选择「整篇」后读取文本，默认打开论文不触发全文提取。 */
async function warmDocText() {
  if (!viewer?.pdf || !state.doc) return;
  const myDoc = state.doc.docId;
  if (state.docText && state.docTextDoc === myDoc) return;
  try {
    setHint('正在读取整篇论文…');
    const text = await viewer.getAllText((i, n) => setHint(`正在读取整篇论文 ${i}/${n} 页`));
    // 抽的过程中可能已经换了论文：那就丢掉，别把空串记到新文档头上
    if (state.doc?.docId !== myDoc) return;
    state.docText = text;
    state.docTextDoc = myDoc;
    updateSendScope();
    // 用户在读取过程中取消了这次范围，就不要把过时的完成提示写回输入框。
    if (!state.useFullText) return;
    setHint(text ? `整篇论文已就绪：${text.length.toLocaleString()} 字（本次发送会增加请求量）` : '这篇文章抽不出文本（可能是扫描件），改用框选截图问');
  } catch {
    if (state.doc?.docId !== myDoc) return;
    setHint('读取整篇论文失败，这次提问只带选中内容和当前页上下文');
    updateSendScope();
  }
}

/** 超过这个字数就不原样发全文了，改发「阅读索引 + 相关段落」 */
let FULL_LIMIT = 100000;
/** 索引模式下一次取几段原文 */
const PICK_K = 6;

/**
 * 组装「整篇论文」上下文。
 *  ≤ FULL_LIMIT 字：按页原样发全文（页码标记，便于模型引用和回跳）。
 *  更长：第一次提问时用模型生成一份 800 字「阅读索引」并缓存，
 *        再按关键词从各页里挑出与问题最相关的 PICK_K 段原文一起发。
 */
async function buildDocContext(question, selection) {
  if (!state.doc) return null;
  const myDoc = state.doc.docId;
  const myTitle = state.doc.name;
  const myOpen = state.openSeq;
  const stillCurrent = () => state.doc?.docId === myDoc && (myOpen == null || state.openSeq === myOpen)
    && (!state.viewerDocId || state.viewerDocId === myDoc);
  const stale = () => {
    const e = new Error('论文已切换，丢弃旧论文上下文');
    e.name = 'AbortError';
    return e;
  };
  if (!state.docText || state.docTextDoc !== myDoc) {
    setHint('正在读取整篇论文…');
    const text = await viewer.getAllText((i, n) => setHint(`正在读取整篇论文 ${i}/${n} 页`));
    if (!stillCurrent()) throw stale();
    state.docText = text;
    state.docTextDoc = myDoc;
    state.docDigest = null;
  }
  if (!stillCurrent() || state.docTextDoc !== myDoc) throw stale();
  const text = state.docText || '';
  if (!text) { setHint(''); return null; }
  if (text.length <= FULL_LIMIT) {
    setHint('');
    return { text, mode: 'full', chars: text.length };
  }

  if (!state.docDigest) {
    setHint('整篇论文较长，正在生成阅读索引（只做一次）…');
    const head = text.slice(0, 240000);           // 索引阶段不必喂到最后一个字
    const digest = await chat({
      messages: digestMessages({ text: head, docTitle: myTitle }),
      signal: state.abort?.signal,
      onTick: () => setHint('正在生成阅读索引…'),
    });
    if (!stillCurrent()) throw stale();
    state.docDigest = digest;
  }
  if (!stillCurrent()) throw stale();
  const digest = state.docDigest;
  const picked = pickRelevantPages(text, `${question}\n${selection || ''}`, PICK_K);
  setHint('');
  return {
    text: `【阅读索引】\n${digest}\n\n【与本次问题最相关的原文段落】\n${picked}`,
    mode: 'digest',
    chars: text.length,
  };
}

/**
 * 极简关键词检索：正文按 "===== p.N =====" 切成页，词频打分取前 k 页。
 * 不引入向量模型——对「找相关段落」这个用途，词频足够好且零成本。
 */
function pickRelevantPages(text, query, k = PICK_K, per = 1600) {
  const re = /===== p\.(\d+) =====/g;
  const marks = [];
  let m;
  while ((m = re.exec(text))) {
    // start = 标记起点（上一页正文到这儿为止），at = 标记之后（本页正文起点）
    marks.push({ page: Number(m[1]), start: m.index, at: m.index + m[0].length });
  }
  if (!marks.length) return text.slice(0, per * k);
  const chunks = marks.map((mk, i) => ({
    page: mk.page,
    body: text.slice(mk.at, i + 1 < marks.length ? marks[i + 1].start : text.length),
  }));

  const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'were', 'from', 'has',
    'have', 'not', 'but', 'can', 'its', 'which', 'when', 'what', 'how', 'why', 'you', 'your', 'our',
    'they', 'their', 'will', 'would', 'should', 'could', 'been', 'more', 'than', 'then', 'into', 'also',
    'such', 'only', 'some', 'other', 'these', 'those', 'using', 'used', 'based', 'paper', 'method',
    'methods', 'results', 'result', 'about', 'there', 'here', 'does', 'each', 'both', 'same', 'very']);
  const terms = [...new Set(String(query).toLowerCase().match(/[a-z][a-z0-9-]{2,}|[\u4e00-\u9fa5]{2,}/g) || [])]
    .filter((t) => !STOP.has(t))
    .slice(0, 30);

  const low = chunks.map((c) => c.body.toLowerCase());
  const scored = chunks.map((c, i) => {
    let score = 0;
    for (const t of terms) {
      let idx = low[i].indexOf(t);
      let n = 0;
      while (idx !== -1 && n < 6) { n++; idx = low[i].indexOf(t, idx + t.length); }
      if (n) score += n * (t.length >= 6 ? 2 : 1);
    }
    return { page: c.page, body: c.body, score };
  });

  const hit = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  const use = hit.length ? hit : scored.slice(0, k);
  return use.sort((a, b) => a.page - b.page)
    .map((s) => `[p.${s.page}] ${s.body.replace(/\s+/g, ' ').trim().slice(0, per)}`)
    .join('\n\n');
}

/** 联网搜索（服务端带 5 分钟缓存，多引擎兜底） */
async function webSearch(query, signal) {
  const url = `/api/web-search?q=${encodeURIComponent(String(query).slice(0, 200))}&n=6`;
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`搜索失败 HTTP ${r.status}`);
  const j = await r.json();
  return (j.results || []).filter((x) => x && x.url).slice(0, 6);
}

async function send(retryPending = null) {
  const ta = $('#chatInput');
  if (state.busy) return;
  let pending = retryPending;
  if (!pending && state.doc && state.viewerDocId !== state.doc.docId) {
    flashHint('论文正在打开，请稍候');
    return;
  }
  if (!pending && !ta.value.trim() && !state.attachments.length) return;
  if (pending && pending.docId !== (state.doc?.docId || null)) {
    flashHint('这条请求属于另一篇论文，请切回原论文后重试');
    return;
  }
  if (!ensureReady()) return;

  if (!pending) {
    const inputValue = ta.value;
    const q = inputValue.trim();
    const attachments = state.attachments.slice();
    if (!q && !attachments.length) return;
    const quotes = attachments.filter((a) => a.kind === 'text');
    const images = attachments.filter((a) => a.kind === 'image');
    const quoteText = quotes.map((a) => (a.page ? `[第${a.page}页] ` : '') + a.text).join('\n\n');
    const firstPage = quotes[0]?.page || images[0]?.page || (state.doc ? viewer?.current : null);
    const question = q || (images.length
      ? '请识别并解释我加进来的这些内容（图/表/公式/文字），说明它们在论文里的作用。'
      : '请解释我加进来的这段内容。');
    pending = {
      inputValue, question, attachments, quoteText, firstPage,
      docId: state.doc?.docId || null,
      docTitle: state.doc?.name || '',
      history: state.history.map((m) => ({ role: m.role, content: m.content })),
      useFullText: state.useFullText,
      useWeb: state.useWeb,
    };
    // 同一条待发问题在失败或停止后重试时复用这两行，不再追加用户消息。
    pending.userEntry = addEntry({
      block: 'chat', kind: 'user', text: question, quote: quoteText,
      thumbs: images.map((im) => im.dataUrl),
    });
    pending.entry = addEntry({
      block: 'chat', tag: 'answer', page: firstPage,
      retry: {
        kind: 'chat', docId: pending.docId, docTitle: pending.docTitle,
        inputValue: pending.inputValue, question: pending.question, quoteText: pending.quoteText,
        firstPage: pending.firstPage, attachments: pending.attachments,
        useFullText: pending.useFullText, useWeb: pending.useWeb,
      },
    });
  } else {
    pending.entry.body.replaceChildren();
    pending.entry.acts.replaceChildren();
    pending.entry.acts.classList.add('hidden');
    pending.entry.root.classList.remove('err', 'error');
    pending.entry.root.querySelectorAll('.entry-meta, .src-list').forEach((node) => node.remove());
    const record = pending.entry.root.__sessionRecord;
    if (record) { record.text = ''; record.meta = ''; record.status = 'pending'; }
  }

  const ctl = makeController();
  if (!ctl) return;
  const images = pending.attachments.filter((a) => a.kind === 'image');
  const baseScope = sendScopeText({
    attachments: pending.attachments,
    history: pending.history,
    useFullText: pending.useFullText,
    useWeb: pending.useWeb,
    query: pending.inputValue,
    docId: pending.docId,
  });
  pending.scope = baseScope;
  state.activeSendScope = baseScope;
  setBusy(true, '0s');
  const target = streamTarget(pending.entry.body);
  let received = '';
  let sources = [];
  let meta = '';
  let docCtx = null;
  try {
    // 没有选区时也带当前页上下文；整篇论文仍只有在用户点「整篇」后才加入。
    const context = pending.firstPage && pending.docId
      ? await viewer.getContextAround(pending.firstPage, pending.quoteText)
      : '';
    pending.scope = sendScopeText({
      attachments: pending.attachments, history: pending.history,
      useFullText: pending.useFullText, useWeb: pending.useWeb,
      query: pending.inputValue, docId: pending.docId, contextIncluded: !!context,
    });
    state.activeSendScope = pending.scope;
    updateSendScope();

    // ① 联网搜索：仅当用户输入了问题时运行，附件识别提示不会触发联网搜索。
    if (pending.useWeb && pending.inputValue.trim()) {
      setHint('正在联网搜索…');
      try {
        sources = await webSearch(webQueryFor(pending.question, pending.quoteText), ctl.signal);
        setHint(sources.length ? `搜到 ${sources.length} 条来源` : '没搜到相关结果，只用论文内容回答');
      } catch (e) {
        if (isAbort(e)) throw e;
        sources = [];
        setHint('联网搜索不可用，这次只用论文内容回答');
      }
    }

    // ② 整篇论文上下文。长文会降为阅读索引和与问题相关的段落。
    if (pending.useFullText && pending.docId) {
      try {
        docCtx = await buildDocContext(pending.question, pending.quoteText);
      } catch (e) {
        if (isAbort(e)) throw e;
        docCtx = null;
        setHint('读取整篇论文失败，这次只带选中内容和当前页上下文');
      }
    }
    pending.scope = sendScopeText({
      attachments: pending.attachments,
      history: pending.history,
      useFullText: pending.useFullText,
      useWeb: pending.useWeb,
      query: pending.inputValue,
      docId: pending.docId,
      fullMode: pending.useFullText ? (docCtx?.mode || 'unavailable') : null,
      contextIncluded: !!context,
    });
    state.activeSendScope = pending.scope;
    updateSendScope();

    const messages = askMessages({
      question: pending.question,
      selection: pending.quoteText,
      context,
      page: pending.firstPage,
      docTitle: pending.docTitle,
      fullText: docCtx?.text,
      webResults: sources,
      history: pending.history,
    });
    if (images.length) {
      const last = messages[messages.length - 1];
      const parts = [{ type: 'text', text: last.content }];
      for (const im of images) parts.push({ type: 'image_url', image_url: { url: im.dataUrl } });
      last.content = parts;
    }
    if (docCtx) {
      meta = docCtx.mode === 'full'
        ? `已带整篇论文 ${docCtx.chars.toLocaleString()} 字`
        : `整篇论文 ${docCtx.chars.toLocaleString()} 字 → 索引 + ${PICK_K} 段相关原文`;
    }
    if (sources.length) meta = meta ? `${meta} · 联网 ${sources.length} 条` : `联网 ${sources.length} 条`;

    setHint('');
    const full = await chat({
      messages,
      signal: ctl.signal,
      onDelta: (piece, all) => { received = all; target.push(all); },
      onTick: (ms) => setBusy(true, `${(ms / 1000).toFixed(0)}s`),
    });
    if ((state.doc?.docId || null) !== pending.docId) return;
    target.done(full);
    state.history.push({ role: 'user', content: pending.question });
    state.history.push({ role: 'assistant', content: full });
    finishEntry(pending.entry, full, { page: pending.firstPage, sources, meta, status: 'complete' });
    if (ta.value.trim() === pending.inputValue.trim()) {
      ta.value = '';
      ta.style.height = 'auto';
    }
    const sentIds = new Set(pending.attachments.map((a) => a.id));
    state.attachments = state.attachments.filter((a) => !sentIds.has(a.id));
    renderAttachments();
    scheduleSessionSave();
  } catch (e) {
    if ((state.doc?.docId || null) !== pending.docId) return;
    if (isAbort(e)) {
      // 保留已经收到的回答；状态放在回答下方，绝不覆盖回答正文。
      target.done(received);
      finishEntry(pending.entry, received, {
        page: pending.firstPage, meta, status: 'stopped', onRetry: () => send(pending),
      });
    } else {
      target.fail(errText(e));
      addFailureRetry(pending.entry, errText(e), () => send(pending));
    }
  } finally {
    setHint('');
    if (state.abort === ctl) { state.abort = null; state.abortReason = ''; setBusy(false); }
    // 「整篇」是单次发送范围：无论成功、失败还是用户停止，本次结束后按钮复位。
    // 失败 / 停止的重试闭包仍持有 pending.useFullText，因此不会丢掉原范围。
    if (pending.useFullText) {
      state.useFullText = false;
      syncOptChips();
    }
  }
}

/* ══════════════════════════════ 浮层 ══════════════════════════════ */

function initPopover() {
  $('#popClose').onclick = () => hidePopover();
  $('#popStop').onclick = () => abortStream();
  $('#popCopy').onclick = () => copyText($('#popBody')?.innerText || '');
  $('#popStop').classList.add('hidden');
}

/** 译文完成后浮层只留一小段时间作生成反馈，正式结果以右栏块为准。 */
function dismissPopoverSoon(ms = 1500) {
  if (state.popoverTimer) clearTimeout(state.popoverTimer);
  state.popoverTimer = setTimeout(() => {
    state.popoverTimer = null;
    $('#popover')?.classList.add('hidden');
  }, ms);
}

function showPopover(title, anchorBox, html) {
  if (state.popoverTimer) { clearTimeout(state.popoverTimer); state.popoverTimer = null; }
  const p = $('#popover');
  p.classList.remove('hidden');
  $('#popTitle').textContent = title;

  // 每次用全新的内容容器，杜绝上一个流的 rAF 写进同一个节点
  const body = document.createElement('div');
  body.className = 'pop-body';
  body.id = 'popBody';
  p.replaceChildren($('.pop-head', p), body);
  if (html !== undefined) body.innerHTML = renderMarkdown(html);

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(430, vw - 24);
  const left = clamp(anchorBox ? anchorBox.left : vw - w - 30, 10, Math.max(10, vw - w - 10));
  let top = anchorBox ? anchorBox.bottom + 10 : 80;
  if (top > vh - 160 && anchorBox) top = anchorBox.top - 260;
  top = clamp(top, 52, Math.max(52, vh - 160));
  p.style.width = `${w}px`;
  const dragged = rememberedCardPos(p);
  const pos = applyCardPos(p, left, top);
  p.style.left = `${pos.left}px`;
  p.style.top = `${pos.top}px`;
  // 高度要等布局完成才知道，测量后再收一次（被拖过的卡片就别再自动挪了）
  if (!dragged) {
    requestAnimationFrame(() => {
      const t = clamp(parseFloat(p.style.top) || 80, 52, Math.max(52, vh - p.offsetHeight - 10));
      p.style.top = `${Math.round(t)}px`;
    });
  }
  return { root: p, body };
}

function hidePopover() {
  if (state.popoverTimer) { clearTimeout(state.popoverTimer); state.popoverTimer = null; }
  $('#popover').classList.add('hidden');
  // 关掉浮层也要停掉正在往里写的那个流
  abortStream();
}

/* ══════════════════════════════ 截图 / 长截图 ══════════════════════════════ */
/* 拖框选区域；把鼠标拖出正文区上下边缘会自动滚动，于是可以一路框到下一页 ——
   因为图是从 PDF 重新渲染的（不是截屏），超出视口的部分也能完整拿到。 */

function initRegion() {
  const overlay = $('#regionOverlay');
  const rect = $('#regionRect');
  const hint = $('#regionHint');
  const viewerEl = $('#viewer');
  let startX = 0;
  let startDocY = 0;
  let dragging = false;
  let lastPointer = null;
  let autoTimer = null;

  const stop = () => {
    overlay.classList.add('hidden');
    hint.classList.add('hidden');
    rect.style.display = 'none';
    $('#regionBtn').classList.remove('on');
    $('#clipBtn')?.classList.remove('on');
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    document.body.classList.remove('row-dragging');
    dragging = false;
    lastPointer = null;
    startDocY = 0;
  };
  state.stopRegion = stop;

  /** 进入 / 退出截图模式。顶部 ⎚ 和输入框边上的 ✂ 走的是同一个入口 */
  const startRegion = () => {
    if (!overlay.classList.contains('hidden')) { stop(); return; }
    if (!viewer?.pdf) { toast('先打开一篇 PDF', 'err'); return; }
    overlay.classList.remove('hidden');
    hint.classList.remove('hidden');
    $('#regionBtn').classList.add('on');
    $('#clipBtn')?.classList.add('on');
    hint.innerHTML = '拖动框住要加进对话的区域 · 拖到上下边缘会自动滚动（长截图）· <kbd>Esc</kbd> 取消';
  };
  state.startRegion = startRegion;

  const docYOf = (clientY) => {
    const vr = viewerEl.getBoundingClientRect();
    return viewerEl.scrollTop + clientY - vr.top;
  };

  const draw = (cx, cy) => {
    const vr = viewerEl.getBoundingClientRect();
    const startScreenY = startDocY - viewerEl.scrollTop + vr.top;
    const x1 = Math.min(startX, cx);
    const x2 = Math.max(startX, cx);
    const y1 = Math.min(startScreenY, cy);
    const y2 = Math.max(startScreenY, cy);
    Object.assign(rect.style, {
      left: `${x1}px`, top: `${y1}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px`,
    });
  };

  // 拖到上下边缘就自动滚动，越框越长
  const maybeAutoScroll = (clientY) => {
    const vr = viewerEl.getBoundingClientRect();
    let dir = 0;
    if (clientY > vr.bottom - 46) dir = 1;
    else if (clientY < vr.top + 46) dir = -1;
    if (!dir) {
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
      return;
    }
    if (autoTimer) return;
    autoTimer = setInterval(() => {
      const before = viewerEl.scrollTop;
      viewerEl.scrollTop = before + dir * 22;
      if (viewerEl.scrollTop === before) return;      // 到头了
      if (lastPointer) draw(lastPointer.x, lastPointer.y);
    }, 16);
  };

  $('#regionBtn').onclick = () => startRegion();

  overlay.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startDocY = docYOf(e.clientY);
    dragging = true;
    lastPointer = { x: e.clientX, y: e.clientY };
    rect.style.display = 'block';
    draw(e.clientX, e.clientY);
    document.body.classList.add('row-dragging');
  });

  overlay.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    lastPointer = { x: e.clientX, y: e.clientY };
    draw(e.clientX, e.clientY);
    maybeAutoScroll(e.clientY);
  });

  overlay.addEventListener('mouseup', async (e) => {
    if (!dragging) return;
    const cx = e.clientX;
    const endDocY = docYOf(e.clientY);
    const topDoc = Math.min(startDocY, endDocY);
    const bottomDoc = Math.max(startDocY, endDocY);
    const leftVp = Math.min(startX, cx);
    const rightVp = Math.max(startX, cx);
    stop();
    if (rightVp - leftVp < 14 || bottomDoc - topDoc < 14) return;
    await captureToChat(topDoc, bottomDoc, leftVp, rightVp);
  });
}

/** 把滚动坐标落到具体某一页上 */
function locateDoc(docY) {
  const pages = viewer.numPages;
  for (let i = 1; i <= pages; i++) {
    const o = viewer.offsets[i];
    const h = viewer.heights[i];
    if (o === undefined) continue;
    if (docY >= o && docY < o + h) return { page: i, y: docY - o };
  }
  // 落在页间空隙或末尾：贴到最近的一页
  let best = 1;
  for (let i = 1; i <= pages; i++) {
    if (viewer.offsets[i] !== undefined && viewer.offsets[i] <= docY) best = i;
  }
  const o = viewer.offsets[best] ?? 0;
  const h = viewer.heights[best] ?? 0;
  return { page: best, y: Math.max(0, Math.min(h, docY - o)) };
}

async function captureToChat(topDoc, bottomDoc, leftVp, rightVp) {
  if (state.busy) return;
  // 注意：截图本身不需要 API Key（图只是先放进附件区），
  // 所以这里绝不能调 ensureReady()，否则没配密钥时截图会被静默拦掉
  const a = locateDoc(topDoc);
  const b = locateDoc(bottomDoc);
  const pageEl = viewer.pageEls[a.page];
  if (!pageEl) return;
  const pr = pageEl.getBoundingClientRect();
  const x = clamp(leftVp - pr.left, 0, pr.width);
  const w = clamp(rightVp - pr.left, 0, pr.width) - x;
  if (w < 8) { toast('选框太窄', 'err'); return; }

  setBusy(true, '截图中…');
  try {
    let shot;
    if (a.page === b.page) {
      shot = await viewer.captureRegion(a.page, { x, y: a.y, w, h: b.y - a.y });
    } else {
      shot = await viewer.captureRange({
        pageStart: a.page, pageEnd: b.page, x, w, yStart: a.y, yEnd: b.y,
      });
    }
    const label = a.page === b.page ? `截图 p.${a.page}` : `长截图 p.${a.page}–${b.page}`;
    addImageToChat(shot, a.page, label, { allowBusy: true });
    showAiBlock('chat');
  } catch (e) {
    toast(`截图失败：${e.message}`, 'err', 4000);
  } finally {
    setBusy(false);
  }
}

/* ══════════════════════════════ 搜索 ══════════════════════════════ */

let searchToken = 0;
let searchDebounced = null;

function cancelSearch({ clearInput = false, close = false, focus = false } = {}) {
  searchToken++;
  searchDebounced?.cancel?.();
  state.search = { hits: [], idx: 0, query: '' };
  viewer?.setActiveQuery('');
  const results = $('#searchResults');
  if (results) { results.replaceChildren(); results.classList.add('hidden'); }
  const count = $('#searchCount');
  if (count) count.textContent = '';
  if (clearInput) $('#searchInput').value = '';
  if (close) $('#searchBar').classList.add('hidden');
  if (focus) viewer?.container.focus();
}

function initSearch() {
  const bar = $('#searchBar');
  const input = $('#searchInput');
  $('#searchBtn').onclick = () => {
    if (bar.classList.contains('hidden')) { bar.classList.remove('hidden'); input.focus(); }
    else cancelSearch({ clearInput: true, close: true, focus: true });
  };
  $('#searchClose').onclick = () => cancelSearch({ clearInput: true, close: true, focus: true });
  $('#searchPrev').onclick = () => stepHit(-1);
  $('#searchNext').onclick = () => stepHit(1);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = input.value.trim();
      if (state.search.query !== q || !state.search.hits.length) {
        searchDebounced?.cancel?.();
        runSearch(q);
      } else stepHit(e.shiftKey ? -1 : 1);
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); $('#searchClose').click(); }
  });
  searchDebounced = debounce((q) => runSearch(q), 260);
  input.addEventListener('input', () => {
    searchToken++;
    state.search = { hits: [], idx: 0, query: '' };
    viewer?.setActiveQuery('');
    $('#searchResults').replaceChildren();
    $('#searchResults').classList.add('hidden');
    const q = input.value.trim();
    const ready = !!viewer?.pdf && state.viewerDocId === state.doc?.docId;
    $('#searchCount').textContent = q ? (ready ? '搜索中…' : (state.doc ? '论文正在打开' : '先打开一篇论文')) : '';
    if (q && ready) searchDebounced(q);
  });
}

async function runSearch(q) {
  const count = $('#searchCount');
  q = String(q || '').trim();
  const my = ++searchToken;
  viewer?.setActiveQuery(q);
  const ready = !!viewer?.pdf && state.viewerDocId === state.doc?.docId;
  if (!q || !ready) {
    count.textContent = q && !ready ? (state.doc ? '论文正在打开' : '先打开一篇论文') : '';
    state.search = { hits: [], idx: 0, query: '' };
    $('#searchResults').replaceChildren();
    $('#searchResults').classList.add('hidden');
    return;
  }
  count.textContent = '搜索中…';
  $('#searchResults').replaceChildren();
  $('#searchResults').classList.add('hidden');
  const docId = state.doc?.docId;
  let result;
  try { result = await viewer.search(q); }
  catch (e) {
    if (my === searchToken && docId === state.doc?.docId) count.textContent = `搜索失败：${e.message}`;
    return;
  }
  // 慢的旧搜索后返回不能覆盖新结果；换文档后的结果直接丢弃
  if (my !== searchToken || result.stale || docId !== state.doc?.docId) return;
  state.search = { hits: result.hits, idx: 0, query: q };
  renderSearchResults();
  if (result.hits.length) await showSearchHit(0, true);
  else count.textContent = '无结果';
}

function renderSearchResults() {
  const results = $('#searchResults');
  const hits = state.search.hits;
  results.replaceChildren();
  results.classList.toggle('hidden', !hits.length);
  hits.forEach((hit, i) => {
    const button = el('button', {
      type: 'button', class: `search-result${i === state.search.idx ? ' current' : ''}`,
      role: 'option', 'aria-selected': i === state.search.idx ? 'true' : 'false',
      onclick: () => showSearchHit(i, true),
    });
    button.append(
      el('span', { class: 'sr-page', text: `p.${hit.page}` }),
      el('span', { class: 'sr-snippet' }, document.createTextNode(hit.before || ''),
        el('mark', { text: hit.match }), document.createTextNode(hit.after || '')),
    );
    results.append(button);
  });
}

function updateSearchCount() {
  const { hits, idx } = state.search;
  const hit = hits[idx];
  if (!hit) return;
  $('#searchCount').textContent = `${idx + 1}/${hits.length} 条 · p.${hit.page}`;
}

async function showSearchHit(index, record = true) {
  const hit = state.search.hits[index];
  if (!hit || !viewer?.pdf || state.viewerDocId !== state.doc?.docId) return;
  state.search.idx = index;
  renderSearchResults();
  updateSearchCount();
  if (record) recordReaderJump();
  const docId = state.doc?.docId;
  const my = searchToken;
  await viewer.gotoHit(hit.page, hit.pageIndex,
    () => my === searchToken && docId === state.doc?.docId && state.search.hits[index] === hit);
  if (docId !== state.doc?.docId) return;
}

function stepHit(dir) {
  const { hits, idx } = state.search;
  if (!hits.length) return;
  showSearchHit((idx + dir + hits.length) % hits.length, true);
}

/* ══════════════════════════════ 设置（只有 Key + 模型名） ══════════════════════════════ */

const ENDPOINT_SHORT = {
  'https://api.deepseek.com/v1': 'api.deepseek.com',
  'https://api.openai.com/v1': 'api.openai.com',
  'https://openrouter.ai/api/v1': 'openrouter.ai',
  'https://api.siliconflow.cn/v1': 'siliconflow.cn',
  'http://127.0.0.1:11434/v1': '本地 Ollama',
};

function fillSettings() {
  const d = Settings.data;
  $('#cfgModel').value = d.model || '';
  $('#cfgBaseURL').value = d.baseURL || '';
  $('#cfgApiKey').value = '';
  $('#cfgApiKey').placeholder = d.hasApiKey ? '已保存，留空则不改' : 'sk-…';
  updateEndpointNote();
  fillUiSettings();
}

function fillUiSettings() {
  const ids = ['uiTheme', 'uiDensity', 'uiUiFontSize', 'uiControlSize', 'uiFontSize', 'uiLineHeight', 'uiCodeSize', 'uiMaxWidth', 'uiOpacity', 'uiPaper', 'uiShowPage', 'uiShowQuote', 'uiShowSources'];
  if (!ids.every((id) => document.getElementById(id))) return;
  $('#uiTheme').value = uiStyle.theme;
  $('#uiDensity').value = uiStyle.density;
  $('#uiPaper').value = uiStyle.paper === 'white' ? 'white' : 'tint';
  $('#uiUiFontSize').value = uiFontSizePx(uiStyle.uiFontSize);
  $('#uiControlSize').value = Math.round(ctlScaleOf(uiStyle.controlSize) * 100);
  $('#uiFontSize').value = uiStyle.fontSize;
  $('#uiLineHeight').value = uiStyle.lineHeight;
  $('#uiCodeSize').value = uiStyle.codeSize;
  $('#uiMaxWidth').value = uiStyle.maxWidth;
  $('#uiOpacity').value = uiStyle.opacity;
  $('#uiShowPage').checked = !!uiStyle.showPage;
  $('#uiShowQuote').checked = !!uiStyle.showQuote;
  $('#uiShowSources').checked = !!uiStyle.showSources;
  // 顶栏：这是**偏好**不是 uiStyle（不走 applyUiStyle），单独回填
  if ($('#uiTopbar')) $('#uiTopbar').value = topbarAutoEnabled() ? 'auto' : 'static';
  updateUiRangeLabels();
}

function updateUiRangeLabels() {
  const uiFs = $('#uiUiFontSize');
  if (uiFs && $('#uiUiFontSizeValue')) $('#uiUiFontSizeValue').textContent = `${uiFontSizePx(uiFs.value)}px`;
  const ctl = $('#uiControlSize');
  if (ctl && $('#uiControlSizeValue')) $('#uiControlSizeValue').textContent = `${Math.round(ctlScaleOf(ctl.value) * 100)}%`;
  if ($('#uiFontSizeValue')) $('#uiFontSizeValue').textContent = `${$('#uiFontSize').value}px`;
  if ($('#uiLineHeightValue')) $('#uiLineHeightValue').textContent = Number($('#uiLineHeight').value).toFixed(2);
  if ($('#uiCodeSizeValue')) $('#uiCodeSizeValue').textContent = `${$('#uiCodeSize').value}px`;
  if ($('#uiMaxWidthValue')) $('#uiMaxWidthValue').textContent = `${$('#uiMaxWidth').value}px`;
  if ($('#uiOpacityValue')) $('#uiOpacityValue').textContent = `${Math.round(Number($('#uiOpacity').value) * 100)}%`;
}

/**
 * Ctrl/⌘ + =（+）/ - 的落点：只改「阅读字号」（结果正文 --ai-fs），
 * 不动界面字号、不动控件大小；范围与设置里的滑杆一致（12–19），并同步面板与 toast。
 */
function setReadingFontSize(px) {
  const next = clamp(Math.round(Number(px) || DEFAULT_UI_STYLE.fontSize), 12, 19);
  uiStyle = { ...uiStyle, fontSize: next };
  applyUiStyle();
  saveUi();
  const range = $('#uiFontSize');
  if (range) range.value = String(next);
  updateUiRangeLabels();
  toast(`阅读字号 ${next}px`, '', 1600);
}

function applyUiSettingsFromControls() {
  const oldPaper = uiStyle.paper === 'white' ? 'white' : 'tint';
  const oldTheme = uiStyle.theme;
  uiStyle = {
    ...uiStyle,
    theme: $('#uiTheme').value,
    density: $('#uiDensity').value,
    paper: $('#uiPaper').value === 'white' ? 'white' : 'tint',
    uiFontSize: uiFontSizePx($('#uiUiFontSize').value),
    controlSize: clamp(Number($('#uiControlSize').value) || DEFAULT_UI_STYLE.controlSize, 80, 130),
    fontSize: clamp(Number($('#uiFontSize').value), 12, 19),
    lineHeight: clamp(Number($('#uiLineHeight').value), 1.45, 2.05),
    codeSize: clamp(Number($('#uiCodeSize').value), 10, 15),
    maxWidth: clamp(Number($('#uiMaxWidth').value), 480, 920),
    opacity: clamp(Number($('#uiOpacity').value), .82, 1),
    showPage: $('#uiShowPage').checked,
    showQuote: $('#uiShowQuote').checked,
    showSources: $('#uiShowSources').checked,
  };
  applyUiStyle();
  /**
   * ⚠️ **主题变化也要重画 PDF 页面**，不能只在「纸面背景」变化时重画。
   *
   * 用户实测：「调了保存之后，pdf 有的变深色有的不变深色」——
   * 根因就是这条分支原来只判 `oldPaper`：主题一变，`--paper` 跟着变，
   * 但已渲染的页面（`this.rendered` 里的位图）不会重画，于是**先渲染的页仍是旧色、
   * 之后滚进来的页用新色**，一屏里一半深一半浅。
   * 纸面现在已不跟随深色主题，但这条重画仍然必须留着：
   * 只要将来纸面色还可能变，主题切换就必须触发一次全量重画。
   */
  if (oldPaper !== uiStyle.paper || oldTheme !== uiStyle.theme) viewer?.refreshPaper?.();
  saveUi();
  renderAiArea();
  updateUiRangeLabels();
}

/**
 * 「恢复默认布局」（设置里的按钮 / 面板管理器底部的按钮）：
 *   ① 六个面板全回默认（dock / home / order / visible / collapsed / pinned / size / rect / z / docId）；
 *   ② 两侧栏宽度 + 底部停靠区高度回默认（--left-w / --right-w / --dock-bottom-h）；
 *   ③ 清掉用户的收起意图与 2.1 的临时豁免（sideIntent.noLeft/noRight/pinned）；
 *   ④ 停掉正在跑的浮窗动画、收掉停靠预览；
 *   ⑤ 重排 + 按当前窗口宽度重算（窄窗下仍然会按规则自动收起 —— 那是窗口的问题，不是记忆）。
 * 浮着的面板也一并收回停靠并复位（defaultPanels() 里没有 float，applyPanels() 会把节点搬回去）。
 * 只动「壳」：论文、会话、消息一条都不碰。
 */
function resetPanels() {
  // 复位宽度意图与实际宽度都要回默认（sideBaseW 是「用户意图」，两边一起写才一致）
  sideBaseW.left = 210;
  sideBaseW.right = 360;
  document.documentElement.style.setProperty('--left-w', '210px');
  document.documentElement.style.setProperty('--right-w', '360px');
  document.documentElement.style.setProperty('--right-w2', '360px');
  document.body.classList.remove('right-col2-off');
  setDockBottomHeight(240, { save: false });
  // 右栏列数回 1（面板本身由下面的 defaultPanels() 复位）
  if (state.panels) state.panels.rightCols = { count: 1, w2: 360 };
  // 「恢复默认布局」= 两边都展开：清掉用户意图和临时豁免，再按窗口宽度重算
  sideIntent.noLeft = false;
  sideIntent.noRight = false;
  sideIntent.pinned.left = false;
  sideIntent.pinned.right = false;
  cancelPanelAnims();
  hideDockPreview();
  const floatingIds = floatPanels();
  state._floatZ = 0;
  state.panels = defaultPanels();
  const parts = floatingIds.flatMap((id) => panelParts(id));
  withPanelMove(parts, () => {
    savePanels();
    applyResponsiveLayout();
    applyPanels();
  });
  saveUi();
  renderAiArea();
  refitViewer(REFIT_AFTER_MS);
  renderPanelMenu();
}

function resetLayout() {
  resetPanels();
  toast('已恢复默认布局，论文和会话未受影响', 'ok');
}

function resetStyle() {
  uiStyle = { ...DEFAULT_UI_STYLE };
  // 只复位样式：右栏块的显示/顺序/高度属于布局，归 resetLayout 管，这里不碰
  applyUiStyle(); viewer?.refreshPaper?.(); saveUi(); fillUiSettings();
  toast('已恢复默认样式，论文和会话未受影响', 'ok');
}

function updateEndpointNote() {
  const url = $('#cfgBaseURL').value || Settings.data.baseURL || '';
  $('#endpointNote').textContent = `接口：${ENDPOINT_SHORT[url] || url}`;
}

function openSettings(hint) {
  const modal = $('#settingsModal');
  modal.classList.remove('hidden');
  fillSettings();
  if (hint) { $('#testResult').className = 'test-result err'; $('#testResult').textContent = hint; }
  setTimeout(() => $('#cfgApiKey').focus(), 50);
}

function closeSettings() {
  $('#settingsModal').classList.add('hidden');
  $('#testResult').textContent = '';
}

function initSettings() {
  $('#settingsBtn').onclick = () => openSettings();
  $('#closeSettings').onclick = closeSettings;
  $('#settingsModal').addEventListener('mousedown', (e) => { if (e.target.id === 'settingsModal') closeSettings(); });
  $('#toggleEndpoint').onclick = () => {
    $('#endpointField').classList.toggle('hidden');
    updateEndpointNote();
  };
  $('#cfgBaseURL').addEventListener('input', updateEndpointNote);
  ['uiTheme', 'uiDensity', 'uiUiFontSize', 'uiControlSize', 'uiFontSize', 'uiLineHeight', 'uiCodeSize', 'uiMaxWidth', 'uiOpacity', 'uiPaper', 'uiShowPage', 'uiShowQuote', 'uiShowSources']
    .forEach((id) => document.getElementById(id)?.addEventListener('input', applyUiSettingsFromControls));
  // 顶栏行为单独接（它不是 uiStyle 的一部分，见 applyTopbarPref 的注释）
  $('#uiTopbar')?.addEventListener('input', (e) => applyTopbarPref(e.currentTarget.value));
  $('#resetLayout').onclick = resetLayout;
  $('#resetStyle').onclick = resetStyle;

  $('#saveSettings').onclick = async () => {
    const out = $('#testResult');
    const key = $('#cfgApiKey').value.trim();
    const model = $('#cfgModel').value.trim() || Settings.data.model;
    const baseURL = $('#cfgBaseURL').value.trim() || Settings.data.baseURL;
    out.className = 'test-result';
    out.textContent = '保存并测试中…';
    try {
      await Settings.save({ model, baseURL, ...(key ? { apiKey: key } : {}) });
      $('#cfgApiKey').value = '';
      $('#cfgApiKey').placeholder = Settings.data.hasApiKey ? '已保存，留空则不改' : 'sk-…';
      updateEndpointNote();
      const r = await testConnection();
      out.className = 'test-result ok';
      out.textContent = `✅ ${r.model} · ${r.ms}ms`;
      setTimeout(closeSettings, 900);
    } catch (e) {
      out.className = 'test-result err';
      out.textContent = `❌ ${e.message}`;
    }
  };
}

function checkConfigWarning() {
  const warn = $('#welcomeWarn');
  if (!warn) return;
  const need = !Settings.data.hasApiKey && !/127\.0\.0\.1|localhost/.test(Settings.data.baseURL || '');
  warn.classList.toggle('hidden', !need);
  if (need) {
    warn.innerHTML = '还没配置模型接口：点右上角 <b>⚙</b> 填 API Key 和模型名。<br />密钥只写在本机 <code>data/config.json</code>，PDF 不会离开这台电脑。';
  }
}

/* ══════════════════════════════ 快捷键 ══════════════════════════════ */

function initShortcuts() {
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;

    if (e.key === 'Escape') {
      if (!$('#regionOverlay').classList.contains('hidden')) { state.stopRegion?.(); return; }
      if (!$('#settingsModal').classList.contains('hidden')) { closeSettings(); return; }
      if (!$('#searchBar').classList.contains('hidden')) { $('#searchClose').click(); return; }
      if (!$('#noteBox').classList.contains('hidden')) { saveNoteBox(); return; }
      if (!$('#popover').classList.contains('hidden')) { hidePopover(); return; }
      // 面板管理器开着（或刚刚被这次 Esc 关掉）的时候，Esc 只负责关菜单，
      // 别再顺手把浮窗也收回去 —— 一次 Esc 干两件事最让人意外
      if (panelMenuEl && !panelMenuEl.classList.contains('hidden')) return;
      if (performance.now() - (state._menuClosedAt || -1e9) < 200) return;
      // 阶段 2.2b：焦点在浮窗里（或刚碰过某个浮窗）时，Esc = 把它收回原来的停靠区
      const fid = focusedFloatPanel();
      if (fid) {
        e.preventDefault();
        dockPanelTo(fid, state.panels[fid].home || 'left');
        toast(`「${panelTitle(fid)}」已收回停靠`, '', 1500);
        return;
      }
      if (state.abort) { abortStream('user'); $('#composerHint').textContent = '正在停止…'; return; }
      // Esc 是明确的「不要这个选区了」：连方块和记住的选区一起清掉
      if (state.selection) { clearSelectionState(); viewer?.clearSelection(); return; }
      hideBubble();
      return;
    }
    // Ctrl/⌘ + Alt + ←/→：当前面板在左栏 / 右栏之间停靠（浮窗也适用）。
    // 和 Ctrl+=/-/0 一样放在 `if (typing) return` 之前：Ctrl 组合不受输入框保护。
    if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const id = currentPanelId();
      if (id) {
        e.preventDefault();
        dockPanelTo(id, e.key === 'ArrowLeft' ? 'left' : 'right');
        toast(`「${panelTitle(id)}」已停靠到${e.key === 'ArrowLeft' ? '左' : '右'}栏`, '', 1400);
      }
      return;
    }
    // Ctrl/⌘ + =（也就是 Ctrl++）/ - / 0：调「阅读字号」（结果正文），只动 --ai-fs。
    // 这三条特意放在 `if (typing) return` 之前：Ctrl 组合不受 typing 保护，
    // 否则输入问题时按 Ctrl+0 会触发浏览器整页缩放，而不是恢复阅读字号。
    // 必须 preventDefault —— 不然 WebView2/Chromium 会同时触发原生整页缩放。
    // 无修饰键的 + / - / 0 仍然是 PDF 缩放 / 适应宽度（见下面），依然受 typing 保护。
    if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); setReadingFontSize(uiStyle.fontSize + 1); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === '-' || e.key === '_')) { e.preventDefault(); setReadingFontSize(uiStyle.fontSize - 1); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); setReadingFontSize(DEFAULT_UI_STYLE.fontSize); return; }

    if (typing) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#searchBtn').click(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') return;
    // 其余单键快捷键一律不能带修饰键，否则 Ctrl+A（全选）会被当成「问」真的发一次付费请求
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const hasSel = state.selection?.cleanText;
    if (e.key === 't' || e.key === 'T') { if (hasSel) { e.preventDefault(); doTranslate(state.selection); } return; }
    if (e.key === 'e' || e.key === 'E') { if (hasSel) { e.preventDefault(); doExplain(state.selection); } return; }
    if (e.key === 'q' || e.key === 'Q') { if (hasSel) { e.preventDefault(); addToChat(state.selection); } return; }
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); $('#regionBtn').click(); return; }
    if (e.key === '+' || e.key === '=') { viewer?.setScale(viewer.scale * 1.15); return; }
    if (e.key === '-' || e.key === '_') { viewer?.setScale(viewer.scale / 1.15); return; }
    if (e.key === '0') { viewer?.fitWidth(); return; }
    if (e.key === 'PageDown') { e.preventDefault(); viewer?.goToPage(viewer.current + 1); return; }
    if (e.key === 'PageUp') { e.preventDefault(); viewer?.goToPage(viewer.current - 1); return; }
    if (e.key === 'Home') { e.preventDefault(); viewer?.goToPage(1); return; }
    if (e.key === 'End') { e.preventDefault(); viewer?.goToPage(viewer.numPages); return; }
  });

  // Ctrl/⌘ + 划选 = 拼接上一次选区。
  // 只在这里打标记，真正的合并交给 onSelectionChanged 做 ——
  // 否则 10ms 后那次回调会用新选区把合并结果覆盖掉。
  $('#viewer').addEventListener('mouseup', (e) => {
    state._pendingMerge = (e.ctrlKey || e.metaKey) ? (state.selection?.cleanText || null) : null;
  });
}

/* ══════════════════════════════ 杂项 ══════════════════════════════ */

// 只有用户主动停止（fetch 被 abort）才算「已停止」；超时是 TimeoutError，必须显示成错误
const isAbort = (e) => e?.name === 'AbortError';
function errText(e) {
  const raw = String(e?.message || '').trim();
  if (!raw) return '暂时没有生成结果';
  // 空闲看门狗抛的是 TimeoutError + 中文说明（ai.js 的 stale()），
  // 必须放在最前面原样透出：否则会被下面的 /网络|fetch/ 规则抢先命中，
  // 用户看到的就成了「接口暂时不可用」，完全对不上「卡住 / 超时」这个事实。
  if (e?.name === 'TimeoutError' || /没有收到任何数据|没有返回数据|超时/.test(raw)) {
    return raw.length > 200 ? `${raw.slice(0, 197)}…` : raw;
  }
  if (/timeout|timed out|idle/i.test(raw)) return '等待模型回应超时，可以重试。';
  if (/HTTP 401|unauthorized|invalid api key/i.test(raw)) return '接口没有接受密钥，请检查设置后重试。';
  if (/HTTP 429|rate limit|too many/i.test(raw)) return '接口暂时繁忙，请稍后再试。';
  if (/HTTP 5\d\d|网络|fetch|failed to fetch/i.test(raw)) return '接口暂时不可用，请检查连接后重试。';
  return raw.length > 180 ? `${raw.slice(0, 177)}…` : raw;
}

async function copyText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制', 'ok', 1100);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制', 'ok', 1100); } catch { toast('复制失败', 'err'); }
    ta.remove();
  }
}

async function maybeReopenLast() {
  const url = new URL(location.href);
  const openName = url.searchParams.get('open');
  if (openName) {
    const found = state.papers.find((p) => p.name === openName || p.name.replace(/\.pdf$/i, '') === openName);
    if (found) return openDoc({ name: found.name, url: found.url, docId: found.docId });
    toast(`papers/ 里没有找到 ${openName}`, 'err', 4000);
  }
  if (serverState.lastDoc && serverState.lastName && serverState.lastUrl && !/^blob:/.test(serverState.lastUrl)) {
    // 用户手比自动恢复快：已经点开一篇了就别再插一脚，否则两次并发加载会打架
    if (state.doc) return;
    // 上次看的文件可能已经被删掉/移走了。先对一下列表，别去发一个注定 404 的请求，
    // 否则启动时用户只会看到一个莫名其妙的「打开失败」。
    const gone = !state.papers.some((p) => p.docId === serverState.lastDoc || p.name === serverState.lastName);
    if (gone) {
      serverState = { ...serverState, lastDoc: null, lastUrl: null, lastName: null };
      fetch('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(serverState),
      }).catch(() => {});
      return;
    }
    return openDoc({ name: serverState.lastName, url: serverState.lastUrl, docId: serverState.lastDoc }).catch(() => {});
  }
}

window.addEventListener('beforeunload', () => {
  // 不能只是 cancel：那样刚翻的那页进度就丢了。用 sendBeacon 保证送达。
  saveProgress.cancel?.();
  persistSession.flush?.();
  if (state.doc) {
    try {
      const session = sessionPayload();
      navigator.sendBeacon(`/api/session?doc=${encodeURIComponent(state.doc.docId)}`, new Blob([session], { type: 'application/json' }));
    } catch { /* unload fallback */ }
  }
  if (!state.doc || !viewer) return;
  try {
    const docs = { ...(serverState.docs || {}) };
    docs[state.doc.docId] = { page: viewer.current, scale: Number(viewer.scale.toFixed(3)), fit: !!viewer._fitMode, ts: Date.now(), name: state.doc.name };
    const payload = { ...serverState, docs, lastDoc: state.doc.docId, lastUrl: state.doc.url, lastName: state.doc.name };
    navigator.sendBeacon('/api/state', new Blob([JSON.stringify(payload)], { type: 'application/json' }));
  } catch { /* 尽力而为 */ }
});
