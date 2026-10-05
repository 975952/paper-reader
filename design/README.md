# design/ —— 阅读助手界面设计稿

> 完整的界面设计与可交互实现。**与正式界面（`public/`）互相独立**：删掉本目录不影响应用运行，
> 也不需要重新编译 exe。

## 打开

```
双击 design/reader.html          # file:// 直接能跑，零依赖、零构建、不用起服务
```

顶部状态条可以切换 14 个界面状态（另有 3 个深色补充状态），也可以直接用 URL 指定：

```
design/reader.html?state=answer-evidence
```

## 文件

| 文件 | 说明 |
| --- | --- |
| `reader.html` | 应用外壳：顶栏 / 活动栏 / 左窄栏 / PDF 正文区 / 助手面板 / 设置页 |
| `reader.css` | 设计令牌 + 全部组件样式（浅色与深色两套令牌） |
| `js/icons.js` | 唯一的一套细线 SVG 图标（24×24 viewBox，stroke 1.5，只用几何元素） |
| `js/parts.js` | 卡片 / 依据 / 笔记标题行 / 范围选项 / 设置片的渲染片段 |
| `js/reader.js` | 行为层：状态机、范围栏、依据展开、跳转与返回、笔记、生成 / 停止 / 失败、tooltip |
| `screens/*.png` | 20 个状态的逐张截图（由验证脚本生成） |
| `design-qa.mjs` | 硬约束与交互动线断言 + 截图 |
| `design-layout.mjs` | 版面几何体检（溢出 / 对齐 / 遮挡 / 窄窗） |

## 验证

```bat
node design\design-qa.mjs            :: 296 条断言 + 20 张截图
node design\design-qa.mjs --no-shot  :: 只断言
node design\design-layout.mjs         :: 199 项版面检查
set CHROME=C:\path\to\chrome.exe      :: 默认找本机 Chrome / Edge
set BASE=http://127.0.0.1:PORT/design :: 也可以走静态服务（默认 file:// 直开）
```

设计文档见 [`../docs/阅读助手界面设计.md`](../docs/阅读助手界面设计.md)（含令牌表、状态说明、合并路径）。
与现有应用的逐项对照与 7 处冲突的处置见 [`../docs/阅读助手界面设计-对照与冲突.md`](../docs/阅读助手界面设计-对照与冲突.md)。
