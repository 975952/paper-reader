/**
 * icons.js —— 「论文阅读器」唯一的一套 24×24 线性图标。
 *
 *   import { ICONS, ICON_IDS, iconEl, iconHTML } from './icons.js';
 *   btn.replaceChildren(iconEl('close'));                       // 装饰性：按钮自己带 aria-label
 *   btn.replaceChildren(iconEl('send', { title: '发送' }));      // 语义性：图标自带名字
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【唯一口径】这套图标的视觉参数只在本文件里定义，调用方**不得**覆盖：
 *   viewBox      "0 0 24 24"        尺寸以 viewBox 为单位，靠 width/height 缩放
 *   fill         "none"             全部线性描边，没有实心块（"点"用 r≈0.95 的圆实现）
 *   stroke       "currentColor"     颜色一律跟随 CSS color，图标本身不写死颜色
 *   stroke-width 1.8                —— 唯一的粗细来源，见下面的 strokeWidth 选项说明
 *   linecap      "round"
 *   linejoin     "round"
 *   aria-hidden  "true"             默认装饰性；给了 title 就换成 role="img"+aria-label
 *   focusable    "false"            避免 IE/旧 Edge 把 svg 拉进 Tab 序列
 *
 * 为什么不用字符图标（译/问/✕/⧉/⇱ …）：字符图标实际长什么样取决于系统装了哪个字体，
 * 同一个符号在 Windows/macOS/Linux 上字重、字面大小、基线全不一样，一排按钮看过去
 * 轻重不齐；而且 Emoji 类符号（🗑 📖 🔗）会被系统按彩色 Emoji 字体渲染，与线性图标
 * 混在一起更乱。SVG 把这些全部固定下来。
 *
 * 【无障碍口径】"图标本身不能承担唯一语义"：
 *   - 图标只是装饰（父元素已有可见文字或 aria-label）→ 用 iconEl(id)，svg 是 aria-hidden。
 *   - 图标是唯一可见内容（纯图标按钮）→ 必须让控件有可访问名，两种写法二选一：
 *       a) iconEl(id, { title: '含义' })    → svg 自带 <title> + role="img" + aria-label
 *       b) 调用方给按钮写 aria-label / 可见文字，图标保持装饰性（推荐，避免读屏念两遍）
 *   注意 title 属性（鼠标悬停提示）**不能**替代 aria-label，两者都要给。
 *
 * 【零依赖 / 无副作用】纯 ESM，不 import 任何东西，模块顶层不碰 document / window，
 * 可以在主页面、独立浮窗页面、甚至 Node 里 import（只有 iconEl/iconHTML 需要 DOM）。
 */

/** 统一描边粗细。**唯一的定义处**，业务代码不要改。 */
export const ICON_STROKE = 1.8;
/** 统一默认尺寸（px）。 */
export const ICON_SIZE = 16;
/** 统一 viewBox。 */
export const ICON_VIEWBOX = '0 0 24 24';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * id → viewBox 内部标记字符串（不含外层 <svg>）。
 * 只允许几何元素：path / circle / rect / line / polyline / polygon。
 * **不要**放 <text>、<tspan>、<image>、<foreignObject> —— 那等于把字体依赖又请回来了，
 * 而且 verify-icons.mjs 会直接断言「元素内不含 <text>」。
 */
export const ICONS = {
  /* ══════════════ 基础语义：面板与操作 ══════════════ */

  // 译文：文档（带两行文字）+ 字母 A —— 对应现在的「译」
  translate: '<rect x="3" y="4" width="10.4" height="16" rx="1.7"/><path d="M5.9 8.5h4.6"/><path d="M5.9 11.7h4.6"/><path d="M15.1 20.2 18.5 10.6l3.4 9.6"/><path d="M16.4 17.1h4.2"/>',
  // 问答：对话气泡（内含三个点）—— 对应现在的「问」
  // 点间距 5.0、r=0.5：加 1.8 描边后每个点直径 ≈ 2.8，留出 2.2 的空隙。
  // 间距 4.0 时 16px 下空隙只剩 0.8px，抗锯齿一糊就变成一条横杠（用 --ascii 点阵实测过）
  chat: '<path d="M20.5 11.5c0 3.7-3.8 6.7-8.5 6.7-1.06 0-2.08-.16-3.02-.46L4.3 19.6l1.32-3.4A6.44 6.44 0 0 1 3.5 11.5c0-3.7 3.8-6.7 8.5-6.7s8.5 3 8.5 6.7z"/><circle cx="7" cy="11.5" r="0.5"/><circle cx="12" cy="11.5" r="0.5"/><circle cx="17" cy="11.5" r="0.5"/>',
  // 加入对话：气泡 + 右上角加号 —— 对应现在的「＋对话」
  'chat-add': '<path d="M20 11.4c0 3.5-3.63 6.4-8.1 6.4-.99 0-1.94-.16-2.81-.44L4.4 19.4l1.27-3.24A6.15 6.15 0 0 1 3.8 11.4c0-3.5 3.63-6.4 8.1-6.4.61 0 1.2.06 1.77.18"/><path d="M19.2 2.6v4.2"/><path d="M17.1 4.7h4.2"/>',
  // 解释：灯泡（也可当「要点 / 直觉」）—— 对应现在的「释」与 ops 的 💡
  explain: '<path d="M9.2 17.6h5.6"/><path d="M10.1 20.6h3.8"/><path d="M12 3.2a6 6 0 0 0-3.42 10.93c.5.35.82.92.82 1.53v.02h5.2v-.02c0-.61.32-1.18.82-1.53A6 6 0 0 0 12 3.2z"/>',
  // 复制：两个叠放的圆角方框 —— 对应现在的「⧉ 复制」
  copy: '<rect x="8.8" y="8.8" width="11.4" height="11.4" rx="2.2"/><path d="M15.2 6.1V5.8a2.2 2.2 0 0 0-2.2-2.2H5.8a2.2 2.2 0 0 0-2.2 2.2v7.2a2.2 2.2 0 0 0 2.2 2.2h.3"/>',
  // 笔记：书签 —— 对应现在的「笔记」栏与 ✎（写/改笔记）
  note: '<path d="M6.2 3.8h11.6a1 1 0 0 1 1 1v15.4l-6.8-4.1-6.8 4.1V4.8a1 1 0 0 1 1-1z"/>',
  // 编辑：铅笔 —— 对应现在的「✎」（写/改笔记、自测题）
  pencil: '<path d="M16.1 3.6a2.05 2.05 0 0 1 2.9 2.9L7.4 18.1l-4 1.1 1.1-4z"/><path d="M14.6 5.1 18.9 9.4"/>',
  // 删除：垃圾桶 —— 对应现在的「🗑」
  trash: '<path d="M4.2 6.6h15.6"/><path d="M9.4 6.6V4.9a1.2 1.2 0 0 1 1.2-1.2h2.8a1.2 1.2 0 0 1 1.2 1.2v1.7"/><path d="M6.6 6.6 7.6 19a1.6 1.6 0 0 0 1.6 1.5h5.6a1.6 1.6 0 0 0 1.6-1.5l1-12.4"/><path d="M10.4 10.4v6"/><path d="M13.6 10.4v6"/>',
  // 文件：文件夹 —— 对应现在的「▤ 文件」栏
  folder: '<path d="M3.4 7.4a2 2 0 0 1 2-2h3.3l2 2.4h7.9a2 2 0 0 1 2 2v8.4a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2z"/>',
  // 目录：列表 —— 对应现在的「≡ 目录」栏
  list: '<path d="M9 6.4h11"/><path d="M9 12h11"/><path d="M9 17.6h11"/><circle cx="4.7" cy="6.4" r="0.95"/><circle cx="4.7" cy="12" r="0.95"/><circle cx="4.7" cy="17.6" r="0.95"/>',
  // 关系：三个节点 + 连线 —— 对应现在的「参考文献」栏（原「文献关系」）
  relations: '<circle cx="6" cy="6.2" r="2.4"/><circle cx="18" cy="6.2" r="2.4"/><circle cx="18" cy="17.8" r="2.4"/><path d="M8.4 6.2h7.2"/><path d="M6 8.6v4.4a2.6 2.6 0 0 0 2.6 2.6H15.6"/>',
  // 搜索 —— 对应现在的「⌕ 全文搜索」「🔍 找这篇的 PDF」
  search: '<circle cx="10.8" cy="10.8" r="6.4"/><path d="M15.6 15.6 20.8 20.8"/>',
  // 设置：齿轮（同心圆 + 8 个齿）—— 对应现在的「⚙」
  settings: '<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="6.4"/><path d="M12 2.2v3.4"/><path d="M12 18.4v3.4"/><path d="M2.2 12h3.4"/><path d="M18.4 12h3.4"/><path d="m5.1 5.1 2.4 2.4"/><path d="m16.5 16.5 2.4 2.4"/><path d="m18.9 5.1-2.4 2.4"/><path d="m7.5 16.5-2.4 2.4"/>',
  // 更多：三个点 —— 对应现在的「⋯」
  more: '<circle cx="5.4" cy="12" r="0.95"/><circle cx="12" cy="12" r="0.95"/><circle cx="18.6" cy="12" r="0.95"/>',
  // 关闭：X —— 对应现在的「✕」
  close: '<path d="M6.4 6.4 17.6 17.6"/><path d="M17.6 6.4 6.4 17.6"/>',
  // 历史 / 时钟：用来表示历史记录、耗时、最近使用
  history: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.1V12l3.3 2"/>',
  // 链接：延伸阅读、引用关系
  link: '<path d="M10.1 13.9a3.9 3.9 0 0 0 5.6 0l3-3a3.9 3.9 0 0 0-5.6-5.6l-1.2 1.2"/><path d="M13.9 10.1a3.9 3.9 0 0 0-5.6 0l-3 3a3.9 3.9 0 0 0 5.6 5.6l1.2-1.2"/>',
  // 星标：贡献与创新点
  star: '<path d="m12 3.4 2.7 5.5 6 .88-4.35 4.24 1.03 5.98L12 17.18 6.62 20l1.03-5.98L3.3 9.78l6-.88z"/>',
  // 警告：局限与风险
  warn: '<path d="M10.3 3.9 2.5 17.4a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9.2v4.2"/><circle cx="12" cy="16.7" r="0.95"/>',
  // 天平：批判性评估
  scale: '<path d="M12 3.4v17"/><path d="M6.6 20.4h10.8"/><path d="M3.4 8.2h17.2"/><path d="M3.4 8.2 1.2 13.4a3 3 0 0 0 4.4 0z"/><path d="M20.6 8.2l2.2 5.2a3 3 0 0 1-4.4 0z"/>',
  // 靶心：可迁移 / 目标
  target: '<circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="4.6"/><circle cx="12" cy="12" r="0.95"/>',
  // 柱状图：实验审查
  chart: '<path d="M3.6 20.4h16.8"/><path d="M7.2 20.4v-6.2"/><path d="M12 20.4V7.6"/><path d="M16.8 20.4v-9.2"/>',
  // 指南针：定位与脉络
  compass: '<circle cx="12" cy="12" r="8.4"/><path d="m15.5 8.5-2.1 4.9-4.9 2.1 2.1-4.9z"/>',
  // 星芒：论文操作入口（顶栏 ✦）—— 一大一小两颗四角星
  ops: '<path d="m9.6 3.4 1.6 4.2 4.2 1.6-4.2 1.6-1.6 4.2-1.6-4.2L3.8 9.2l4.2-1.6z"/><path d="m17.4 13.4.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z"/>',
  // 学位帽：AI 教练 / 学术助手
  graduation: '<path d="M12 4.2 22 8.6l-10 4.4L2 8.6z"/><path d="M6.4 10.8v4.6c0 1.6 2.5 2.9 5.6 2.9s5.6-1.3 5.6-2.9v-4.6"/><path d="M22 8.6v5.4"/>',
  // 闪电：一句话速览
  bolt: '<path d="M13.4 2.6 4.6 13.4h6.2l-1 8 8.8-10.8h-6.2z"/>',
  // 地图：阅读路线
  map: '<path d="M9.4 3.8 3.6 6.2v14l5.8-2.4 5.2 2.4 5.8-2.4v-14l-5.8 2.4z"/><path d="M9.4 3.8v14"/><path d="M14.6 6.2v14"/>',
  // 步骤流：方法拆解
  steps: '<rect x="3" y="3.2" width="6.8" height="5.6" rx="1.4"/><rect x="14.2" y="15.2" width="6.8" height="5.6" rx="1.4"/><path d="M9.8 6h3.4a2 2 0 0 1 2 2v7.2"/><path d="m13.6 13.6 1.6 1.6-1.6 1.6"/>',
  // 书本：术语表 / 阅读
  book: '<path d="M4 19.2V5.2A2.2 2.2 0 0 1 6.2 3H20v14.6H6.2A2.2 2.2 0 0 0 4 19.8z"/><path d="M4 19.2a2.2 2.2 0 0 0 2.2 2.2H20v-3.8"/>',
  // 求和号 Σ：公式逐符号解释。没有 <text>，Σ 是用折线画出来的
  formula: '<path d="M17.6 5.6H6.4l6 6.4-6 6.4h11.2"/>',
  // 循环箭头：复现清单 / 重跑
  repeat: '<path d="M3.6 9.4V8.2A3.4 3.4 0 0 1 7 4.8h10.6"/><path d="m14.8 2 2.8 2.8-2.8 2.8"/><path d="M20.4 14.6v1.2a3.4 3.4 0 0 1-3.4 3.4H6.4"/><path d="m9.2 22-2.8-2.8L9.2 16.4"/>',
  // 刷新：重新解析参考文献 / 重新整理
  refresh: '<path d="M20.4 11.2a8.4 8.4 0 0 0-14.1-5L3.6 8.9"/><path d="M3.6 3.4v5.5h5.5"/><path d="M3.6 12.8a8.4 8.4 0 0 0 14.1 5l2.7-2.7"/><path d="M20.4 20.6v-5.5h-5.5"/>',

  /* ══════════════ 导航与箭头 ══════════════ */

  // 上一页 / 下一页（顶部翻页 ‹ ›）
  'chevron-left': '<path d="M15 4.8 7.8 12 15 19.2"/>',
  'chevron-right': '<path d="M9 4.8 16.2 12 9 19.2"/>',
  // 上一个 / 下一个结果（▲ ▼）
  prev: '<path d="M12 5.4 19.6 15H4.4z"/>',
  next: '<path d="M12 18.6 4.4 9h15.2z"/>',
  // 上移 / 下移一位（面板管理器 ↑ ↓）
  'arrow-up': '<path d="M12 20V4.6"/><path d="m5.8 10.8 6.2-6.2 6.2 6.2"/>',
  'arrow-down': '<path d="M12 4v15.4"/><path d="m18.2 13.2-6.2 6.2-6.2-6.2"/>',
  // 展开 / 折叠（分组标题上的 ▾）
  'caret-down': '<path d="m6.4 9.4 5.6 5.6 5.6-5.6"/>',
  // 右向小三角（style.css:578 的 `.pm-btn::before { content: '▸' }` 想统一时用）
  'caret-right': '<path d="m9.4 6.4 5.6 5.6-5.6 5.6"/>',
  // 勾（style.css:650/1019 的 `content: '✓'` 想统一时用）
  check: '<path d="M4.8 12.6 9.7 17.5 19.2 6.5"/>',
  // 返回原位置（↶）：阅读位置回退
  undo: '<path d="M4 9.6h11.2a4.8 4.8 0 0 1 0 9.6H9.6"/><path d="m8.2 5.4-4.2 4.2 4.2 4.2"/>',
  // 跳回正文（↩）：从引用卡片回原文
  'jump-back': '<path d="M9.6 14.2 4.8 9.4l4.8-4.8"/><path d="M4.8 9.4h10a4.8 4.8 0 0 1 4.8 4.8v5.4"/>',
  // 拖动手柄（⠿）：六点
  drag: '<circle cx="9" cy="6.4" r="0.95"/><circle cx="15" cy="6.4" r="0.95"/><circle cx="9" cy="12" r="0.95"/><circle cx="15" cy="12" r="0.95"/><circle cx="9" cy="17.6" r="0.95"/><circle cx="15" cy="17.6" r="0.95"/>',
  // 上下换位（⇅）：拖动调整顺序
  'drag-vertical': '<path d="M12 4.4v15.2"/><path d="m8.2 8.2 3.8-3.8 3.8 3.8"/><path d="m8.2 15.8 3.8 3.8 3.8-3.8"/>',

  /* ══════════════ 面板停靠 / 浮窗 ══════════════ */

  // 浮出（⇱）：从停靠区升成浮窗 —— 底边 + 向上箭头
  float: '<path d="M4 20.4h16"/><path d="M12 16V4"/><path d="m6.9 9.1 5.1-5.1 5.1 5.1"/>',
  // 收回（⇲）：从浮窗落回停靠区 —— 底边 + 向下箭头
  dock: '<path d="M4 20.4h16"/><path d="M12 4v12"/><path d="m6.9 10.9 5.1 5.1 5.1-5.1"/>',
  // 换到另一栏（⇄）：两条反向箭头
  swap: '<path d="M4 8.4h13.2"/><path d="m13.6 4.8 3.6 3.6-3.6 3.6"/><path d="M20 15.6H6.8"/><path d="m10.4 19.2-3.6-3.6 3.6-3.6"/>',
  // 换回第 1 栏（⇤）：箭头撞左墙
  'swap-back': '<path d="M20 12H5.4"/><path d="m9.6 7.8-4.2 4.2 4.2 4.2"/><path d="M3.6 4.4v15.2"/>',
  // 独立窗口（⧉）：方框 + 向右上角飞出的箭头
  popout: '<path d="M18 13.4v5.6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5.6"/><path d="M14.4 3.4h6.2v6.2"/><path d="M20.6 3.4 11.8 12.2"/>',
  // 展开右栏：右栏 + 向左（拉出来）的箭头
  'panel-expand-right': '<rect x="3" y="3.4" width="17.2" height="15.2" rx="2.2"/><path d="M14.2 3.4v15.2"/><path d="M19.6 10.4 17.8 12l1.8 1.6"/>',
  // 收起右栏：右栏 + 向右（推回去）的箭头
  'panel-collapse-right': '<rect x="3" y="3.4" width="17.2" height="15.2" rx="2.2"/><path d="M14.2 3.4v15.2"/><path d="M16.4 10.4 18.2 12l-1.8 1.6"/>',
  // 展开左栏：左栏 + 向左（拉出来）的箭头
  'panel-expand-left': '<rect x="3.8" y="3.4" width="17.2" height="15.2" rx="2.2"/><path d="M9.8 3.4v15.2"/><path d="M7.6 10.4 5.8 12l1.8 1.6"/>',
  // 收起左栏：左栏 + 向右（推回去）的箭头
  'panel-collapse-left': '<rect x="3.8" y="3.4" width="17.2" height="15.2" rx="2.2"/><path d="M9.8 3.4v15.2"/><path d="M5.6 10.4 7.4 12 5.6 13.6"/>',

  /* ══════════════ 操作 ══════════════ */

  // 放大（+）/ 缩小（−）
  'zoom-in': '<circle cx="10.8" cy="10.8" r="6.4"/><path d="M15.6 15.6 20.8 20.8"/><path d="M10.8 7.9v5.8"/><path d="M7.9 10.8h5.8"/>',
  'zoom-out': '<circle cx="10.8" cy="10.8" r="6.4"/><path d="M15.6 15.6 20.8 20.8"/><path d="M7.9 10.8h5.8"/>',
  // 适应宽度（⤢）：内容区两侧的竖线 + 双向箭头
  'fit-width': '<path d="M3 5.2v13.6"/><path d="M21 5.2v13.6"/><path d="M6.6 12h10.8"/><path d="m9.6 8.8-3.2 3.2 3.2 3.2"/><path d="m14.4 8.8 3.2 3.2-3.2 3.2"/>',
  // 发送（➤）：纸飞机
  send: '<path d="M20.6 3.4 3.6 10.2l6.6 2.8 2.8 6.6z"/><path d="m10.2 13 10.4-9.6"/>',
  // 停止（■）：圆角方块
  stop: '<rect x="6.4" y="6.4" width="11.2" height="11.2" rx="1.8"/>',
  // 截图 / 长截图（✂）：裁剪叠加线
  screenshot: '<path d="M6.6 2.6v14.8a1.6 1.6 0 0 0 1.6 1.6h13.2"/><path d="M2.6 6.6h14.8a1.6 1.6 0 0 1 1.6 1.6v13.2"/>',
  // 框选区域（⎚）：四个角括号组成的取景框。
  // 试过 stroke-dasharray 的虚线框：圆角矩形的虚线段会在拐角处断成很脏的形状，16px 下像坏图，
  // 换成角括号后既干净又能和「截图」的实线裁剪明确区分
  region: '<path d="M3.6 8.8V6a2.4 2.4 0 0 1 2.4-2.4h2.8"/><path d="M15.2 3.6H18a2.4 2.4 0 0 1 2.4 2.4v2.8"/><path d="M20.4 15.2V18a2.4 2.4 0 0 1-2.4 2.4h-2.8"/><path d="M8.8 20.4H6a2.4 2.4 0 0 1-2.4-2.4v-2.8"/>',
  // 附件 / 图片：回形针。**只要 3 道平行笔画**：加到 4 道在 16px 下会变成一把梳子
  attach: '<path d="M20.2 10.6 11.4 19.4a5.2 5.2 0 0 1-7.4-7.4l8.8-8.8a3.5 3.5 0 0 1 4.9 4.9l-8.8 8.8a1.7 1.7 0 0 1-2.5-2.5"/>',

  /* ── 回答存笔记（2026-10 用户拍板：不新建存储，复用现有笔记条目） ──────────
     同一张「纸张折角」，未保存是加号、已保存是对勾：
       · 加号 / 对勾都压在下半张纸上（y 14.2–19.2），折角线在上半张（y 5.2–10.6），
         两者不重叠；横竖各 4.6 单位，16px 下约 3px，抗锯齿后仍然看得清是「加」还是「勾」。
       · 纸高 16 单位、纸宽 14 单位，与旁边 copy（11.4 单位方框）分量相当，一排里不显突兀。 */
  'note-plus': '<path d="M19 11.2V6.6a1.4 1.4 0 0 0-1.4-1.4H6.4A1.4 1.4 0 0 0 5 6.6v11a1.4 1.4 0 0 0 1.4 1.4h4.3"/><path d="M9.1 5.2v5.4l2.5-1.6 2.5 1.6V5.2"/><path d="M17.2 14.6v4.4"/><path d="M15 16.8h4.4"/>',
  'note-check': '<path d="M19 11.2V6.6a1.4 1.4 0 0 0-1.4-1.4H6.4A1.4 1.4 0 0 0 5 6.6v11a1.4 1.4 0 0 0 1.4 1.4h4.3"/><path d="M9.1 5.2v5.4l2.5-1.6 2.5 1.6V5.2"/><path d="m14.9 16.7 1.8 1.9 3.4-3.7"/>',
};

/** 所有合法 id（冻结数组，顺序即上面的定义顺序）。验证脚本与文档用它遍历。 */
export const ICON_IDS = Object.freeze(Object.keys(ICONS));

/** id 是否存在。 */
export function hasIcon(id) {
  return Object.prototype.hasOwnProperty.call(ICONS, id);
}

function assertIcon(id) {
  if (!hasIcon(id)) {
    throw new Error(`icons.js: 未知图标 id「${String(id)}」；可用 id 见 ICON_IDS（共 ${ICON_IDS.length} 个）`);
  }
}

/** size 允许 number（px）或 CSS 长度字符串（如 '1em'）。 */
function toCssSize(v) {
  if (v === undefined || v === null) return String(ICON_SIZE);
  return typeof v === 'number' ? String(v) : String(v);
}

function toClassList(cls) {
  if (!cls) return '';
  return Array.isArray(cls) ? cls.filter(Boolean).join(' ') : String(cls);
}

/**
 * 建一个 <svg> 图标元素。
 *
 * @param {string} id  ICONS 里的 id；未知 id 直接抛错（宁可炸在开发期，也别静默留白）
 * @param {object} [opts]
 * @param {number|string} [opts.size=16]        宽高（数字按 px）
 * @param {string} [opts.title]                 语义名。给了就写 <title> + role="img" + aria-label，
 *                                              并**不再** aria-hidden；不给就是纯装饰（aria-hidden）
 * @param {string|string[]} [opts.cls]          附加 class
 * @param {number} [opts.strokeWidth=1.8]       仅供本文件/极端尺寸做光学补偿。**业务代码不要传**：
 *                                              整套图标的粗细一致性靠这个常量，逐处覆盖就散了
 * @returns {SVGSVGElement}
 */
export function iconEl(id, opts = {}) {
  assertIcon(id);
  const { size = ICON_SIZE, title, cls, strokeWidth = ICON_STROKE } = opts;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', ICON_VIEWBOX);
  svg.setAttribute('width', toCssSize(size));
  svg.setAttribute('height', toCssSize(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('focusable', 'false');

  const className = toClassList(cls);
  if (className) svg.setAttribute('class', className);

  if (title) {
    // 图标是唯一可见内容：给它一个可访问名，同时**不能** aria-hidden
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', String(title));
    const t = document.createElementNS(SVG_NS, 'title');
    t.textContent = String(title);
    svg.appendChild(t);
  } else {
    // 装饰性图标：父元素（按钮/标签）负责提供可访问名
    svg.setAttribute('aria-hidden', 'true');
  }

  // 用 innerHTML 而不是 DOMParser：svg 子节点在 SVG 命名空间下才能正确解析
  svg.insertAdjacentHTML('beforeend', ICONS[id]);
  return svg;
}

/** HTML 转义，只用于 iconHTML 的 title。 */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 与 iconEl 同参，但返回 HTML 字符串 —— 给 `el.innerHTML = ...` 那种落点用
 * （例如设置向导里「点右上角 ⚙」的内联图标）。
 */
export function iconHTML(id, opts = {}) {
  assertIcon(id);
  const { size = ICON_SIZE, title, cls, strokeWidth = ICON_STROKE } = opts;
  const className = toClassList(cls);
  const common = `viewBox="${ICON_VIEWBOX}" width="${esc(toCssSize(size))}" height="${esc(toCssSize(size))}"`
    + ` fill="none" stroke="currentColor" stroke-width="${esc(strokeWidth)}"`
    + ' stroke-linecap="round" stroke-linejoin="round" focusable="false"';
  const klass = className ? ` class="${esc(className)}"` : '';
  const titleEl = title ? `<title>${esc(title)}</title>` : '';
  const a11y = title
    ? ` role="img" aria-label="${esc(title)}"`
    : ' aria-hidden="true"';
  return `<svg xmlns="${SVG_NS}" ${common}${klass}${a11y}>${titleEl}${ICONS[id]}</svg>`;
}
