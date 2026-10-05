# test/archive —— 只作参考的旧测试套件

这里放的是 **2026-10 产品删减** 之前写的套件，测试的是已经**被删掉、不打算再回来**的功能。
保留它们是为了留一份历史断言与现场取证，**不是**拿来跑的门禁。

## 为什么它们一定跑不过

2026-10 的删减把这些能力整体拿掉了：

| 被删的能力 | 当年测它的套件 |
| --- | --- |
| 右栏第 2 列（`#rightCol2` / `#aiArea2` / `#rightColSplit` / `rightCols.{count,w2}` / 面板换栏），右栏**恒为 1 列** | `panels-right.mjs`、`cards.mjs` |
| 浮动面板 / 拖出停靠 / 底部停靠区（`#floatLayer`、`.panel-float`、`#dockBottom`、`#dockPreview`） | `card-mode.mjs`、`cards.mjs`、`panels-right.mjs` |
| 面板管理器弹窗（`#panelMenu`、`.pm-row`、`.pm-btn`、`Shift+F10` / `Alt+↑↓` / `Alt+H`） | `cards.mjs`、`panels-right.mjs`、`card-mode.mjs` |
| 论文操作目录的 15 个预设 + 4 个分组 + Coach 模式（现在只剩 4 个操作、平铺列表） | 旧版 `ops.mjs`（现行版本已重写，**不在这里**） |
| `?window=panel&panel=<id>` 整页单面板模式 | `card-mode.mjs` |

这些套件里的选择器（`#aiArea2`、`#panelMenu`、`#floatLayer` …）在当前产品里**根本不存在**，
所以断言会稳定失败在 `waitForFunction` / `waitForSelector` 超时上——那是预期结果，不是新缺陷。

## 目录内容

| 文件 | 原用途 | 归档理由 |
| --- | --- | --- |
| `panels-right.mjs` | 右栏「列」模型 A–I 段：2 列并排、换栏、浮出、窄窗收栏 | 全部围绕第 2 列与面板管理器 |
| `cards.mjs` | 浮层卡片拖动、面板管理器键盘走查、老存档迁移 | 面板管理器 + 浮卡 + 第 2 列 |
| `card-mode.mjs` | `?window=panel` 退化行为、浮出卡片尺寸钳制 | URL 模式与浮卡都已删除 |
| `diag.mjs` | 一次性探针：翻页高度 / canvas 数量 | 零断言、硬编码 `127.0.0.1:8787` 与不存在的夹具名 |
| `diag2.mjs` | 一次性探针：放大清晰度、选区文字 vs 送出的文字 | 同上 |
| `diag3.mjs` | 一次性探针：canvas 上限降采样、文本层命中精度 | 同上 |

## 注意

- **不要**把这里的文件加回 `test/pack.mjs` 的白名单；`pack.mjs` 的 `DENY` 里已经有
  `test/archive/`，发布包不会带上它们。
- 搬进来之后相对路径**就已经断了**，这是刻意不修的：`cards.mjs` 的 `./_env.mjs`、
  `panels-right.mjs` 的 `./artifacts/right-cols/static-audit.mjs` 现在都指向
  `test/archive/` 下面不存在的文件；`cards.mjs` 还会把产物写进 `test/archive/artifacts/`，
  绕过 `test/_env.mjs` 的 `assertIsolatedDataDir` 护栏。想参考就读源码，
  **不要**直接 `node test/archive/<x>.mjs`。
- 想复活其中某个用例，正确做法是按**当前**产品的契约重写断言，而不是把文件挪回去。
- `diag*.mjs` 里硬编码的 `8787` 是用户真机安装版的端口，跑起来会打到真实书架，
  这也是把它们挪走的另一个原因。
