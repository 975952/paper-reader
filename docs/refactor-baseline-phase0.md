# 阶段 0 · 基线固化（论文阅读器改造）

日期：2026-09-27　范围：只做基线，不改产品行为。
本文件是后续所有阶段的**对照基准**与**回退依据**。

---

## 1. 回退信息

| 项 | 值 |
|---|---|
| 备份目录 | `backup\phase0-public-20260927-175339\` |
| 内容 | `public/` 整目录 271 个文件（6.6 MB）、`README.md.bak`、`AGENTS.md.bak`、`BASELINE.txt`、`MANIFEST-public.sha256`、`RESTORE.txt` |
| 完整性 | 备份副本与源目录逐文件 SHA256 比对：**271/271 一致，差异 0** |
| 阶段 0 结束后复核 | `public/` 与备份清单再比对：**checked=271，changed_or_missing=0**（即本阶段确实一行产品代码都没改） |
| 回退方法 | 见 `backup\phase0-public-20260927-175339\RESTORE.txt` |

**注意**：前端是编译期内嵌进 exe 的。只回退 `public/` 而不重新跑 `desktop\build.bat`，exe 里仍是旧资源。

---

## 2. 隔离测试的正确跑法（重要）

基线跑通过程中发现：**套件之间有顺序耦合**，因为所有浏览器套件共用同一个隔离服务，
而它们大多打开**同一篇论文**（取「体积最大的那篇」），该论文的会话（`session-<docId>.json`）
会在套件之间累积；下次打开时 `restoreSession()` 会把旧消息重放出来，但结果块默认保持收起，用户从右栏开关按需展开。整篇论文范围是单次发送选择，不写入 `reader.fullText`。
（`public/js/app.js:1338`），于是一些「取第一条 `.msg.assistant`」的断言会读到旧消息。

实测证据：同一套件、同一份代码，只因为隔离 `data/` 里有没有上一轮留下的会话，结果就不同 ——
`context.mjs` 在脏 data 下 **48/70**，在干净 data 下 **70/70**；`e2e.mjs` 的「AI 分块默认全关」
一组 4 条同样只在干净 data 下通过。

因此**冻结基线的 harness 规则是**：

> 每个套件开跑前：清空隔离 `data/`（或每套件用独立 data 目录）+ 把隔离书架复位成恰好 2 篇合成论文 + 重新 POST 一个假 Key。

假 Key 是必需的：`public/js/app.js:2288` 的 `ensureReady()` 在「没有 Key 且 baseURL 不是本机」时
直接不发请求，`math` / `cards` / `selection` 会因此**假红**（不是产品问题）。

### 可复现的命令

```bat
:: ① 隔离书架 + 隔离 data（data 必须是 papers 的兄弟目录，见 test/_env.mjs:10-13）
mkdir test\artifacts\phase0\papers
mkdir test\artifacts\phase0\data
copy test\fixtures\multipage-sample.pdf test\artifacts\phase0\papers\fixture-multipage.pdf
copy test\fixtures\cn-sample.pdf        test\artifacts\phase0\papers\fixture-cn-sample.pdf

:: ② 起服务（8790；8787/8788 常被真实实例占着）
set PORT=8790
set PRT_PAPERS_DIR=%CD%\test\artifacts\phase0\papers
set PRT_DATA_DIR=%CD%\test\artifacts\phase0\data
set NO_OPEN=1
node server.js

:: ③ 每个套件之前：清空 data\*、复位书架、重塞假 Key
curl -X POST http://127.0.0.1:8790/api/config -H "Content-Type: application/json" ^
  -d "{\"apiKey\":\"sk-phase0-fake\",\"baseURL\":\"https://api.deepseek.com/v1\",\"model\":\"deepseek-chat\"}"

:: ④ 逐个跑（共用同一个服务，不要并行）
cd test
set BASE=http://127.0.0.1:8790
node e2e.mjs
```

**不要跑**：`real.mjs`（已禁用）、`desktop.mjs`（会按 exe 路径强制结束正在运行的阅读器）、
`isolate.mjs` / `diag*.mjs` / `smoke.mjs`（零断言、恒返回成功）、`pack.mjs`（打包器）。

---

## 3. 冻结基线（2026-09-27 实测）

环境：Node v24.18.0；Chrome `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`；
隔离实例 `http://127.0.0.1:8790`；合成论文 2 篇；全程假 Key、假上游、无真实 AI 调用。

| 套件 | 结果 | 备注 |
|---|---|---|
| `math.mjs` 公式与表格 | **33 / 33** | 需要先塞假 Key |
| `cards.mjs` 卡片拖动 / 自适应宽度 | **32 / 32** | 需要先塞假 Key |
| `zoom.mjs` 缩放不闪灰条 | **17 / 17** | |
| `selection.mjs` 选区覆盖层 | **31 / 31** | 需要先塞假 Key |
| `outline.mjs` 目录跳转 | **2 / 4** | 已知问题 #3 |
| `context.mjs` 全文 / 联网上下文 | **70 / 70** | 必须干净 data |
| `links.mjs` 外链拦截 | **24 / 24** | 本阶段修过断言 |
| `ops.mjs` 论文操作目录 | **28 / 28** | |
| `stream.mjs` 真实流式 / 停止 / 非流式回退 | **14 / 14** | |
| `cjk.mjs` 中文 PDF + 文本层 | **11 / 11** | |
| `e2e.mjs` 端到端 | **109 / 111** | 已知问题 #1 #2 |
| `relations.mjs` 文献关系 | **34 / 34** | 含一次真实 arXiv 下载并自清 |
| `save-reliability.mjs` 保存失败与隔离 | **全绿** | 无汇总行，逐条 ✅ |
| `ux.mjs` 综合回归（自带服务 + 假上游） | **33 / 33** | |

历史对照：改造前 `test/artifacts/e2e-clean.txt` / `e2e-clean2.txt` 记录的是 **105/111**（6 条红）；
本阶段修掉其中 4 条陈旧断言后为 **109/111**（剩 2 条见已知问题 #1 #2）。
`ops.txt` 的 24/28 已过期（现为 28/28）。

---

## 4. 本阶段实际改了什么

只改了测试与文档，**`public/` 一行未改**（271 个文件哈希全部一致）。

| 文件 | 改动 |
|---|---|
| `test/e2e.mjs` | 4 条陈旧断言改为与当前实现一致：`:386` 译文 tag→`translation`、页码→`/^第\d+页$/`；`:401` 释 tag→`explanation`；`:434` 问答 tag→`answer`；`:752/765` 设置字段不再数个数，改为按 id 断言「AI 两字段 + 样式七项」，并修掉 `<select>` 取不到 id 的收集缺陷 |
| `test/links.mjs` | 来源链接断言不再用「`#aiArea` 里第一个 `.src-list a`」（那属于更早的消息），改为取**最后一条带来源的助手消息** |
| `README.md` | 6 处过期描述：一键导入已下线；设置字段说明；`_env.mjs` 快照→拒绝式护栏（2 处）；测试目录规模；测试运行方式（含假 Key 步骤与「不要跑」清单） |
| `docs/refactor-baseline-phase0.md` | 本文件（新增） |
| `backup\phase0-public-20260927-175339\` | 回退备份（新增） |

---

## 5. 已知问题清单

> 这些**在改造前就存在**，不是任何阶段引入的回归。后续阶段带着这份清单走。

### #1 产品缺陷：上游卡死时提示文不对题（用户可见）
- 现象：模型卡住 4 秒后虽然会中止并给出重试按钮，但提示是
  **「接口暂时不可用，请检查连接后重试。」**，而不是「超时 / 卡住」。
- 根因：`public/js/app.js:3446-3454` 的 `errText()` 第一条规则只认拉丁文
  `timeout|timed out|idle`，而 `streamChat()` 抛出的 `TimeoutError` 文案是中文
  「超过 N 秒没有收到任何数据…或网络/代理卡住了…」，于是被后面的 `/网络|fetch/` 规则抢先命中。
- 证据：探针实测 `abort` 精确在 `idleMs` 触发（4000ms 场景下 click+4016ms），
  但屏幕上是「接口暂时不可用…」；`idleMs=60000` 时 59679ms 才触发。
  **看门狗本身是好的，坏的只是文案映射。**
- 对应红灯：`e2e.mjs`「上游卡死会明确报错，不是一直转」。
- 归属：阶段 1（约 1 行，先判 `e.name === 'TimeoutError'` 或加中文超时模式）。
- **状态：阶段 1 已修复 ✅** —— `public/js/app.js` 的 `errText()` 最前面加了
  `if (e?.name === 'TimeoutError' || /没有收到任何数据|没有返回数据|超时/.test(raw)) return raw…;`
  阶段 1 复测：`e2e.mjs` 该条转绿（`4.0s 后报错`，屏幕原文「超过 4 秒没有收到任何数据，已判定为卡住并中断。」），
  且不再出现「接口暂时不可用」。`e2e` 由 109/111 升到 110/111。

### #2 设计待定：助手消息没有角色圆标
- `e2e.mjs:884` 断言「每条消息有角色标识」，但 `.ava` 只在用户消息上渲染
  （`public/js/app.js:1343`），助手消息只有页码行。
- 这是「要不要给助手也加圆标」的设计问题，不是 bug。
- 归属：阶段 1（结果排版统一时连同类型标签、页码词法一起定）。
- **状态：阶段 1 收尾已解决 ✅** —— 设计定为「**用户消息 = 圆标 + 底色气泡；助手消息无圆标**，
  靠阅读字体 / 正文宽度 / 底部动作条区分」，并**按最终设计改写断言**（不是为了让旧断言通过去给助手加圆标）：
  `e2e.mjs` 的 `hasRole`/`hasActs` → `userHasAva`/`userHasBubble`/`assistantNoAva`/`assistantHasActs`。
  `e2e.mjs` 由 110/111 升到 **111/111**。

### #3 测试夹具缺口：目录书签没有 Y 坐标
- `outline.mjs` 断言「目录项里解析出了目标 Y 坐标」，实测 **0/20**。
- 根因：`test/fixtures/make-multipage-pdf.mjs:58,65` 生成的书签目标只有 `/Fit`，
  没有 `/XYZ` 的 Y 值，所以「顶到标题」这条前提在该夹具上根本不成立。
- 归属：阶段 1 —— 要么给夹具加 `/XYZ` 目标（会影响 e2e/ux 等共用该夹具的套件，需一起复跑），
  要么把断言放宽成「能跳到正确页」。

### #4 测试脆弱性：套件之间共用会话（已缓解，未根治）
- 多个套件用 `document.querySelector('#aiArea .msg.assistant ...')`（**第一条**）取消息；
  同一篇论文的会话跨套件累积后，会读到旧消息。
- 已修：`links.mjs`。仍在（靠 harness 规则规避）：`context.mjs:308/325`、`math.mjs:218`、`stream.mjs:167-169`。
- 归属：阶段 1 可选加固（把选择器改成最后一条即可，风险很低）。

### #5 测试假绿/噪声（不能当门禁）
- `outline.mjs` 在大纲为空时报 ❌ **但仍 `exit(0)`**；
- `isolate.mjs` 恒 `exit(0)`（代理坏了也报成功），且硬编码 8787；
- `smoke.mjs` / `diag*.mjs` 零断言、硬编码 8787 与不存在的文件名。

### #6 后端/桌面端既有差异（已登记，未处理）
- Node 与 Rust 有约 11 处响应契约差异，其中用户可见的包括：检索源数量与排序、
  无 DOI 文献的链接兜底、联网搜索词元、超时/导入文案。
- `desktop.mjs:14` 只扫 8787–8806，而 exe 会扫到 `preferred+64`，极端情况下会误报「16 秒内没起来」。
- `node-search.mjs` 没有 `_env.mjs` 护栏（只有软校验）。

### #7 后续改动必须同步的字符串门禁
- `test/desktop.mjs:211` 直接 grep 内嵌 `app.js` 里的字面量 **`completedMarkdownEnd(pending, scan)`**；
- `test/desktop.mjs:212` 反向断言 `app.js` **不得**包含 `importPdf(`；
- `test/relations.mjs:247` 断言检索结果里**没有**直接导入按钮。
  → 阶段 1/2/3 若要重命名函数或恢复导入入口，必须同时改这三处。

### #8 产品缺陷（未修，归属阶段 2/3）：换论文漏重置 `state.relBusy`
- `openDoc()` 的重置块（`app.js:514-546`）没有重置 `state.relBusy`，
  扫描进行中切换论文会让新论文的「扫描库内引用」按钮一直灰着（`app.js:2087`）。

---

## 6. 后续阶段与门禁

阶段划分（简化版）：**阶段 1 视觉与字体 → 阶段 2 侧栏与浮动面板 → 阶段 3 文献关系 → 阶段 4 最终回归与桌面构建**。

每个阶段的门禁：
1. 只改白名单内的模块；跨模块依赖先报告。
2. 改完后按 §2 的 harness 规则跑隔离测试，结果**不得低于本文件 §3 的冻结基线**。
3. 每阶段结束后更新本文件的基线表与已知问题清单。
4. 动 `public/` 之后，阶段 4 必须重跑 `desktop\build.bat` 并确认 exe 里的前端是新的
   （`test/desktop.mjs` 自带 mtime 新鲜度检查）。

---

## 7. 阶段 1（视觉基础）记录

**范围**：字体 / 控件大小 / 内容密度 / `Ctrl+-`·`Ctrl++`·`Ctrl+0` / 超时文案。未做侧栏、浮动面板、文献关系、AI 数据流。

**改动面**（对阶段 0 备份 SHA256 全量比对：`public/` 271 vs 271，changed=3、removed=0、added=0）
- `public/style.css`：`:root` 新增「界面尺度」组（`--ui-fs` + 5 个派生档位、`--ctl-scale`/`--ctl-h`/`--ctl-fs`/`--ctl-pad-x`）
  与「内容密度」组（`--list-pad-y/-x/-lh`、`--gap-msg`、`--para-gap`、`--panel-pad`、`--ctl-gap`，standard 为默认值）；
  `body[data-density="compact"|"comfortable"]` 各覆盖 8 个密度令牌。**没有删除或改写任何选择器**。
- `public/index.html`：设置里新增 `#uiUiFontSize`(12–17) 与 `#uiControlSize`(80–130，100=标准)；`#uiFontSize` 标签「正文大小」→「阅读字号」。
- `public/js/app.js`：`DEFAULT_UI_STYLE` 增 `uiFontSize:13.5`、`controlSize:100`（含老存档回落，不出 NaN）；
  `applyUiStyle()` 写 `--ui-fs`/`--ctl-scale`；两个新滑杆的填表/取值/监听/标签；`setReadingFontSize()`；
  `initShortcuts()` 在 `Ctrl+F`/`Ctrl+C` 之后、通配 `Ctrl` 守卫之前插入 `Ctrl+=`/`Ctrl+-`/`Ctrl+0`（都 `preventDefault`，**无修饰键的 `+ - 0` 仍是 PDF 缩放/适应宽度**）；`errText()` 超时规则。
- `test/e2e.mjs`：`styleIds` 追加两个新 id（全文件仅此 1 处改动）。

**阶段 1 回归实测（同一隔离 harness 规则）**：math 33/33 · cards 32/32 · zoom 17/17 · selection 31/31 ·
outline 2/4 · context 70/70 · links 24/24 · ops 28/28 · stream 14/14 · cjk 11/11 ·
**e2e 110/111（+1，已知问题 #1 修复）** · relations 34/34 · save-reliability 全绿 · ux 33/33。
**没有任何一项低于阶段 0 冻结基线。**

**新增行为实测**：三尺度互不影响（13.5/14/26 → 17/14/26 → 17/19/26 → 17/19/33.8）；
密度三档在 `.msg`/`.outline li`/`.filelist li`/`.sec-head`/`.ai-head` 上严格单调；
`Ctrl+=`/`Ctrl+-`/`Ctrl+0` 均 `defaultPrevented=true`，夹取 12–19，无修饰键行为不变；超时文案 4.0s 复现；两次 reload 后设置稳定。

**阶段 1 遗留**
- **视觉美观度未经人眼确认**：本次会话的模型不支持图像输入（`read_image` 被拒），
  12 张截图只做了尺寸/像素统计/计算样式与几何校验，**深浅色与密度的观感需人过目**：
  `test/artifacts/p1v/shots/`。
- **默认观感微调**：`.msg + .msg` 的 `padding-top` 由 13px 变为 `--gap-msg + --ctl-gap` = 18px（standard 档）。
  其余 standard 数值与原值逐像素相同。
- **既有小瑕疵（非本阶段引入）**：设置网格 `scrollWidth 484 > clientWidth 482`（2px，来自 7 行滑杆 `.field` 的 237>235），
  `#settingsModal` 与 `html` 都不溢出、无可见后果；属阶段 2 可顺手处理项。
- **exe 仍是旧前端**：阶段 1 只改 `public/`，未重跑 `desktop\build.bat`，**阶段 4 必须重编并复验**。
- 仍需带着走：已知问题 #3（outline 夹具无 Y 坐标）、#4、#6、#7、#8。（#1、#2 已在阶段 1 解决。）

---

## 8. 阶段 1 收尾记录（按用户复核意见）

用户在看完截图与代码后提出三条，逐条处理：

| # | 用户意见 | 处理 |
|---|---|---|
| 1 | `Ctrl+-/+/0` 在输入框内失效（`if (typing) return` 在前，会变成浏览器整页缩放） | 把 3 条 Ctrl 字号快捷键**上移到 `if (typing) return;` 之前**（仍在 `Escape` 之后）；`Ctrl+F`/`Ctrl+C` 位置未动；无修饰键的 `t/e/q/r`、`+/-/0` 仍受 typing 保护。实测焦点在 `#chatInput`/`#noteText`/`#uiFontSize` 时三条均生效且 `defaultPrevented=true`；反例（输入框内按无修饰 `0/-/=`）不改变 `--ai-fs` 也不改变 PDF 缩放。 |
| 2 | 视觉偏碎偏淡：页码/原文引用/「回答完成」/底部操作层层排列，正文不突出 | `finishEntry()` 改为条件渲染 `.entry-meta`：正常完成**不再输出「回答完成」**，仅当 `stopped` 或有实质 meta（已带全文 N 字 / 联网 N 条）时才占一行；`.msg .role` 加 `opacity:.8`、`.msg .ref` 加 `.78`、`.msg .acts` 由 `.55` 降到 `.32`，hover 恢复 `1`；`.msg .text` 未动（仍是 `--ai-fs`/`--ai-lh`/继承 `--fg`）。未给助手加圆标、未加卡片边框。 |
| 3 | 未给出可直接打开的隔离预览；且不该拿「有截图文件」当视觉验收通过 | 起了一个**完全隔离、可交互**的预览（见下）。**视觉美观度仍未由我验收**——本会话模型不支持图像输入，需要你本人看。 |

**测试侧同步**：`test/e2e.mjs` 的消息区分断言按最终设计改写（见 §5 #2），`e2e` **111/111**（收尾前 110/111）。

**预览环境**（离线、隔离、可交互，随时可关）
- 应用：`http://127.0.0.1:8796`（`node server.js`，`PRT_PAPERS_DIR/PRT_DATA_DIR` 指向 `test/artifacts/preview/`）
- 假模型：`http://127.0.0.1:8898/v1`（`test/artifacts/preview/mock-llm.mjs`，按 system prompt 回带公式/表格/代码块的 Markdown 并分批 SSE）
- 书架：2 篇**合成论文**（`multipage-sample.pdf`、`cn-sample.pdf` 的副本）；`data/config.json` 的 baseURL 指向本地假模型，**不需要任何 Key**
- 预置会话：`test/artifacts/preview/seed.mjs` 写入 6 条样本（译文 / 解释 / 用户提问 / 带表格与来源的问答 / 一句话速览 / 一条「已停止」）
- 关闭：停掉这两个后台作业即可；不涉及真实 `data/`、`papers/`

**阶段 1 形态备份**：`backup/phase1-public-20260929-004159/`（271 文件，SHA256 与源逐文件一致）。
阶段 0 那份备份是**加字体改动之前**的，回退它会连带回退阶段 1；要回退到「阶段 1 已完成」请用这一份。

---

## 9. 阶段 2 进展（侧栏 / 面板 / 浮动）

### 2.1 窄窗正文保护（完成）

**问题**：780px 窗口下左右栏都展开，正文只剩约 170–200px，PDF 缩放到 33%。

**做法**：新增令牌 `--viewer-min:420px` 与 `--rail-w:40px`；`applyResponsiveLayout()` 按「用户意图 ∪ 自动收起」重算
`body.no-left/no-right`，窗口放不下时**先收右栏、再收左栏**；自动收起只存内存（`state.autoCollapse`），
**绝不写进 `reader.ui`**，窗口变宽自动撤销；`saveUi()` 改为只写用户意图。
活动栏 `#railLeft`（文件/目录/笔记/文献关系 4 键，点击展开并滚到该区）与 `#railRight`（展开右栏）只在对应侧收起时显示。
拖动松手低于阈值（左 140 / 右 200）即收起并**写用户意图**；双击分隔条切换收展；删掉旧 `@media (max-width:760px)`
里「右栏 absolute 覆盖层 / `--left-w:180px`」两条冲突规则。

**实测**：780px → 正文 **525px / 缩放 80.6%**（原来 ~170px / 33%）；1000px 恰好落在 `--viewer-min`。
`e2e 111/111`、`cards 37/37`、`zoom 17/17`、`ux 33/33`、自写探针 55/55。
**已知取舍**：收起仍是 `display:none`，所以列宽瞬间到位 + 立刻重排；140ms 过渡只覆盖宽度真在变的路径（键盘微调、松手夹回 min）。

**回退点**：`backup/phase21-public-20261002-163726/`（改动前）、`backup/phase21-done-20261002-164730/`（完成后）。

### 2.2a 统一面板注册表（完成）

**做法**：把原先并存的两套模型（左栏静态 `section.sec` + 右栏 `state.ai`/`reader.ai`）合并为**一个** `state.panels`：
六个固定 id `files/outline/notes/relations/translate/chat`，字段 `{dock, order, visible, collapsed, pinned, size}`。
新增面板管理器 `#panelMenu`（顶栏 ▤ 打开，或面板头的 ⋯）：显示/隐藏、固定、上移/下移、恢复默认布局、全部显示；
面板头支持 `Enter/Space` 折叠、`Alt+↑/↓` 换位、`Alt+H` 隐藏、`Shift+F10` 开管理器。
持久化改为 `reader.panels`（单一 key，不再按论文分叉）；**旧 `reader.ai` 只读一次用于迁移、永不修改/删除**，
迁移分两步（boot 时读顶层，拿到 `lastDoc` 后再补 `byDoc` 覆盖）。
`pinned` 只影响自动收起的先后：只有右栏有固定面板 → 先收左栏；只有左栏有固定 → 先收右栏；否则维持「先右后左」。

**有意的偏离（已确认）**：右栏两块默认 `visible:false`（与合并前的 `state.ai.visible` 默认一致），
若改成 `true` 会打掉「打开论文时右栏一块都不开」这条既有行为与两条 e2e 断言（111 → 109）。

**实测**：探针 69/69；`e2e 111/111`、`cards 41/41`（含新增 4 条迁移断言）、`ux 33/33`、`zoom 17/17`。

**回退点**：`backup/phase22a-done-20261002-172816/`。

### 2.2b 应用内浮动 + 停靠 + 动效（完成）

范围：`dock` 扩到 `left/right/bottom/float`；`#floatLayer` 浮动层；停靠预览；浮动面板拖动/缩放；
原位置占位 `.panel-slot`；关闭向最近边缘收起；回停靠 FLIP；动效 100–260ms + `prefers-reduced-motion` + 可打断；
切换论文时浮动面板自动回停靠；`resetPanels()` 一并收回浮动。
**明确不做**：中央标签页（需要先定"标签页与 PDF 正文如何共存"的产品决策）、系统级独立窗口。

实测：探针 **78/78**；`e2e 111/111`、`cards 41/41`、`ux 33/33`、`zoom 17/17`。
探针逼出并修掉 7 个真 bug（右栏面板缺 `data-panel`、浮窗拖动粘住、抬升后量到放大矩形、
"吃掉 click" 布尔位卡死按钮、管理器 Esc 不回焦点、Chromium 滚动锚定把 `.ai-body` 拽走、`resetPanels` 后节点赖在浮动层）。
**回退点**：`backup/phase22b-done-20261002-180342/`。

### 修复 · 右栏面板「关 → 开」不回来（用户报告，已根治）

**症状**：右栏「译文 / 问答」关掉再打开后面板不回来 —— 状态 `visible=true`、开关显示已开，
但 DOM 里仍是 `class="ai-block hidden"`、高度 0；等多久、改窗口都不恢复，**只有刷新页面才好**。
同时暴露两条同源问题：隐藏时 `size` 被清成 `null`（用户拖好的高度丢失）；面板隐藏时拖分隔条会给隐藏块写 `size=60`。

**根因**：两个真值来源打架。`applyPanels()` 用 `panelEl(id)`（`document.querySelector('[data-panel=…]')`）
找节点并摘/挂 `hidden`；而右栏两块是 `ensureBlock()` 现建、登记在 `state.blockEls`，
且 `renderAiArea()` 隐藏时用 `replaceChildren()` 把不可见块**从文档里摘下来**。
于是「关掉」时节点**带着 `hidden` 离开文档** → 再打开时 `panelEl()` 查不到 → `continue` → 没人摘 `hidden`；
`renderAiArea()` 把同一个带 `hidden` 的节点塞回来 → 永久 `display:none`。
签名缓存 `_aiVisibleSig` 与 `rightPanelsSig()` 都是对的，所以不会再触发重渲染；resize 只改 inline 高度不碰类。

**修法**：① `panelEl()` 对右栏两块改走唯一登记表 `state.blockEls[id]`（左栏四块仍走文档查询）；
② 删除「隐藏时清 `size`」；③ 新增 `visibleSplitPair()`，拖分隔条前按 **DOM 真相**现算当前可见的两块，
拖动途中可见集合变过就整次作废。
**顺带修好**：隐藏的右栏面板现在能被 `panelParts()` 正确认领（此前对隐藏块浮出/回停靠静默失败）。

**验证**（独立复验，非实现者自述）：`probe-height3` 关→开从 `hidden h=0` 变 `class="ai-block" h=378`；
隐藏不再清 `size`（348 保留）；再显示回到 348；窗口压到 560 再恢复高度完整回来。
`cards.mjs` 新增 12 条固化断言（41 → **53/53**）；全量回归 14 套件零失败行
（e2e 111/111 · ux 33/33 · zoom 17/17 · outline 8/8 · relations 43/43 · save-reliability 全绿）。
exe 已同步重编：**2026-10-02 20:42:33，9,799,680 B，sha256 `14a1623389e9d42d9fc976cdcdade5097886ad133ddbc3438917eff17f516ae5`**，
`desktop.mjs` 52/52。
**回退点**：`backup/fix-panel-size-20261002-204226/`。

---

## 10. 阶段 3 + 积压清理 + 最终构建（完成）

### 3 文献关系重构
分组列表（书架已有 / 已找到开放版本 / 待查·未找到 / 被引用，各组带计数、可折叠）+ 概览计数 +
搜索 / 状态筛选 / 排序（只存内存，切论文重置）+ 点行开详情（复用 `#citeBox`）+ 单条失败不影响整组。
状态显式化：`status ∈ {local, idle, loading, pdf, landing, none, error}`；引用条目用内容派生的**稳定 key**，
`busy/found` 从对象搬到 `Map<key, slot>`。
**R1–R5 五个跨论文竞态全部修复**：统一 `relStale(docId, gen)` 代际校验；`relGen` 只在换论文时 +1（`↻` 不动它，
否则在途查询会被误判过期）；`relTextCache` 加 `size:mtime` 内容指纹；`openDoc` 重置 `relBusy`；
`state.cite` 换论文清空；`lookupRefPdf` 按稳定 key 落槽。
实测：探针 42/42（含"扫描中 30ms 内切论文 → 等 9s 被顶替的扫描跑完仍一个字没写回"）；`relations.mjs` 43/43（原 34）。

### 积压清理（test/工具侧，`public/` 一行未改）
- **#3 夹具补 Y**：`make-multipage-pdf.mjs` 改成生成 `/XYZ null <Y> null`，并让页面正文真的画出
  `Section N` / `Section N Topic M`；夹具 107704 → 108472 B。`outline.mjs` **2/4 → 8/8**
  （`mid` 找得到后，原本被跳过的 4 条断言也真的执行了；断言一条未放宽）。
- **#4 顺序耦合**：`context/math/stream` 的"第一条助手消息"改为按 `dataset.seq` 取最后一条，
  并把写死的 `>0/>1/>2`、下标 `[1]/[2]`、`history.length === 2` 改为增量基线。
  脏 data 下连跑两轮：`70/70 · 33/33 · 14/14`（改前同条件 context 仅 53/70）。
- **#5 假绿**：`outline.mjs` 提前退出改为按结果给退出码（用无书签 PDF 反证 `0/1` + `exit 1`）。
  `isolate.mjs` 确认恒 `exit(0)` 且硬编码 8787 —— **仍未修**，继续列入"不要当门禁"。
- **#6 pack.mjs**：INCLUDE 补 6 个套件；DENY 对 `test/fixtures/*.pdf` 加唯一豁免（`papers/`、`data/` 及别处 pdf 仍拒）。
  实跑 327 文件，清单含两个夹具 PDF、无任何 `data/`/`papers/`/`artifacts/` 路径。
- **#7 desktop/README.md**：§4 由 5 条补成 D1–D11，标注用户可见项为 **D5 / D8 / D9 / D11**。
- 顺带修：`desktop/tools/acceptance.ps1:200` 陈旧断言（期望 `deepseek-chat`，两个后端实际都是 `deepseek-flash`）→ 90/91 变 **91/91**。

### 最终构建与两端验收
- `desktop\build.bat`：cargo release 11.2s；新 exe **2026-10-02 18:26:20，9,796,608 B，
  sha256 `c0ea03d43102281b9a590a700228b01641981a76b4057153e1bc6a2b5d46a0d3`**；
  项目根与**桌面**两份逐字节一致（旧 exe 为 `2026-09-27 17:23:14` / `ec39a71b…`）。
- `test/desktop.mjs` **52/52**（含 exe 新鲜度、内嵌前端字符串门禁、HTTP/安全/文献检索）。
- `desktop/tools/acceptance.ps1` **91/91**。
- 全量隔离回归（14 套件）**零下降**：math 33/33 · cards 41/41 · zoom 17/17 · selection 31/31 ·
  outline 8/8 · context 70/70 · links 24/24 · ops 28/28 · stream 14/14 · cjk 11/11 ·
  e2e 111/111 · relations 43/43 · ux 33/33 · save-reliability 全绿。

### 仍未做 / 待决策
1. **中央标签页**：需要先定「标签页与 PDF 正文如何共存」（替换正文 / 上下分屏 / 浮层）。
2. **系统级独立窗口**：只在桌面版有意义，且需要跨窗口面板状态同步。**已于 2026-10-03 阶段 5 首版完成**：Rust 侧只放行本机 `window=panel` URL，六个面板均可创建 Tao/WebView 独立窗口，`BroadcastChannel` + `reader.panels` storage 事件同步布局；细节见 `docs/PROGRESS.md` §18。
3. **整篇双语对照导出**（默认 HTML 自包含 + 断点续跑 + 调用数可见）与**扫描版整篇 OCR**（默认走视觉模型逐页路线）—— 已排入阶段 6/7，未开工。
4. `isolate.mjs` 恒 `exit(0)`；`smoke.mjs`/`diag*.mjs` 零断言 —— 不要当门禁。
5. Node/Rust 契约 11 处差异（`desktop/README.md` §4）；其中 4 处用户可见，如需对齐要同时改 `server.js` 与 `desktop/src/api.rs`。
6. 视觉观感自始至终**未经人眼逐张确认**（本会话模型不支持图像输入），需你过目 `test/artifacts/preview/shots-final/`。
7. 待你拍板：消息间距 18px 保留还是回 13px；检索结果是否恢复「直接导入」按钮；文献关系是否默认显示关系图；
   论文操作结果是否显示类型标签。

> **R11 更新（2026-10-03）**：阶段 5 已完成首版并重编 exe。当前唯一未开工的产品决策是中央标签页，
> 需要先确定它与 PDF 正文的共存方式。

---

## 11. 阶段 6 · 整篇双语对照导出（已完成，**已于 R9 整体移除**）

> ⚠️ **2026-10-03 R9 更新**：用户判断这个功能「没用，完全不实用」，拍板**彻底删除**。
> 入口按钮、浮动卡片、`app.js` 里的导出实现（切块/计划/任务/下载/复制）、
> `style.css` 的导出样式、`test/export.mjs` 与相关产物**全部已删**，
> exe 重新构建（9,865,728 → **9,836,032 B**）。
> 本节以下内容保留为**历史记录**，描述的是当年实现，已不对应当前代码。
> 作为参考：当时它按 3500 字/块切成串行请求，15 页论文要约 9 次调用，
> 中途没有可读产出（只能等下载 HTML），这是用户觉得不实用的主因。

> 一页式现状见 [`PROGRESS.md`](PROGRESS.md)。本节只记本阶段的实现与取舍。

**入口**：左栏筛选框旁新增 `⇩ 双语`（**没放顶栏** —— `e2e.mjs` 有顶栏控件白名单断言），
点开是一张可拖动的浮动卡片 `#exportBox`。

**流程**：开始前显示「将调用 N 次模型（共 M 页）」→ 串行逐页翻译 → 可停止 → 可续跑（只翻没翻过/失败的页）
→ 单页失败只跳过该页并可单独重试 → 完成后下载自包含 HTML。

**切块**：以 `===== p.N =====` 页标记为硬边界；单页超 3500 字符时在**段落边界**再切一刀，
同一页的多块译文按顺序拼回该页译文栏。`splitExportPages()` / `splitExportChunks()` / `hardSplitExport()`
是纯函数；**卡片上的预估调用数与实际请求队列由同一个函数派生**，不存在"各算各的"。

**缓存**：`state.exportCache = Map<docId, {src, pages, parts, failed, chunks, order, note}>`，
**只在内存**（刷新即失）；按 docId 分槽，切论文各算各的、不串。

**导出的 HTML**：单文件、内联全部 CSS、零外部引用；逐页一节（`h2` 写「第 n 页」），
节内左右两栏（`grid`，≤760px 自动上下堆叠），左原文段落、右整页译文；失败页写「（本页未翻译）」；
全部文本过 `escapeHtml`；文件名 `<名去扩展名>-双语对照-<YYYYMMDD-HHmm>.html`。

**有意的设计取舍**（用户已问过一次，记在这里免得重复讨论）：
1. **页级对齐而非段级** —— 页是原文里真实存在的结构，段落边界是客户端猜的；段数一旦不匹配左右就整体错行，
   错位比粗糙更糟。代价：16 页 ≈ 32 次调用（段对段约 6 倍，且需段数校验 + 回退重译）。
2. **不渲染 Markdown/公式** —— 原文本来就是纯文本，只渲染译文会让左右视觉不对等；要做得对得两边都渲染
   （原文渲染不出东西）并内嵌 KaTeX（体积涨到 MB 级）。

**验证**：新增 `test/export.mjs` **57/57**（含"预估 == 实际请求数"、"中断后续跑不重复请求已翻页"、
"单页 500 后其余页照常完成且可单页重试"、"原文含 `<script>` 时被转义"、"下载文件名格式"）；
`e2e 111/111`、`cards 53/53`、`ux 33/33`、`ops 28/28`、`outline 8/8`。
**Lead 独立复验**（在预览实例上真跑一遍并抓真实 Blob）：**16/16 通过**，
产物 `test/artifacts/preview/export-preview.html`（16 页、106 KB、无外链）。

**预览保真度修正**：原先预览的假模型对**任何输入都回同一段**，导致导出件"每页像是复读同一段"——
那是假模型的锅，不是导出功能的锅。已改成**按页/按块回显该块原文开头并明写「占位译文」**，
避免继续误导对版式的判断。假模型永远不能用来判断译文质量。

**exe**：已随之重编（见 `PROGRESS.md` §3.1）。**回退点**：`backup/phase6-done-20261002-210419/`。

## 12. R6 · 会话恢复与跨论文上下文收敛

重开论文时，历史译文 / 问答结果先恢复到按需创建的结果块，结果块仍保持隐藏，用户从 AI 开关展开后即可看到。非法历史 block 安全归入问答，不再因为默认隐藏而让恢复过程抛异常。

失败、停止、未完成的助手记录保存了问题、文字附件、页码、论文范围开关和文档 id 的最小重试描述；重开后可沿原路径重试并复用原用户行。截图不写入会话，只保留「截图附件未保存，请重新添加截图」提示；旧会话没有重试描述时，按钮只把问题恢复到输入框，不会自动发请求。

全文读取和长文阅读索引在每个异步等待后校验当前论文代际。切换论文会丢弃旧全文 / 索引，不覆盖新论文缓存，也不会把旧请求失败条写到新论文。论文操作和划词翻译命中当前结果缓存时只定位原条目，不重复追加 DOM 或会话记录；「重新生成」仍明确走强制路径。

隔离证据：`node test/r6.mjs` **9/9**；测试目录为 `test/artifacts/r6-run-20261003/`，使用合成 PDF、独立 data 和本地假模型服务。改动前回退点为 `backup/r6-before-20261003-120353/public/`。桌面 exe 证据记录在 `test/artifacts/r6-run-20261003/RESULTS.md`。
