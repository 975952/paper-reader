# 可嵌入应用的现成 Agent 运行时调研（2026-11-01）

> 状态：调研记录，**不改设计、不改代码**。缘起：用户问「有没有这种可以嵌入应用的、已经写好的 agent 应用」，
> 用来替代/加速「自己写工具循环 + 上下文管理」这条路线。
>
> 结论先行见 §0；候选清单见 §2；对本项目的落地建议见 §4。

## 0. 结论先行（人话版）

1. **有，而且不少。** 成熟产品都把「Agent 内核」做成了可嵌入/可驱动的东西：
   DeepSeek Harness（ACP / SDK / headless 三种方式）、Claude Agent SDK（把 Claude Code 当库用）、
   OpenAI Codex SDK、Sema Core（官方定位就是「可嵌入的 agent 运行时」）、OpenCode，以及一个已经标准化的
   **ACP（Agent Client Protocol）生态**——60+ 个 agent 都实现了 ACP，任何应用都能当客户端接进来。
2. **但它们都是「编码 agent」**：自带工具是读文件、改代码、跑命令；**没有现成的「读 PDF 某页/看扫描页图/搜论文」工具**。
   要让它们服务论文阅读器，仍然要自己写一层 PDF 工具（通常做成 MCP server 最省事）。
3. **直接整包嵌进你的 exe 不划算**：它们都依赖 Node/Bun 运行时 + 几十 MB 组件，你的单文件 exe 现在约 10.6 MB，
   嵌进去会到 60–150 MB；而且它们是「文件系统 + shell」的假设，和你「本地 PDF 阅读器」的权限模型对不上。
4. **最合适的路线是「协议接入」而不是「代码嵌入」**：
   - 默认：应用内自己写一个轻量工具循环（就是原计划的 P2.5，代码量很小），配 DeepSeek 原生 function calling；
   - 进阶：应用实现 **ACP 客户端**，让用户把本机已装的 DSH / Codex / Cursor / Claude Code / Gemini CLI 等接进来；
   - 工具侧：把「读第 N 页文本 / 读第 N 页图 / 搜论文 / 当前页」做成 **MCP server**（或 ACP 工具），
     这样内置循环和外部 agent 可以共用同一套 PDF 能力。
5. 也就是说：**loop 和上下文管理**可以「抄」成熟产品的做法（DSH 的代码就在本机，已逐项读过：工具循环、
   分层系统提示、压缩 80% 阈值/保留 16%、工具结果修剪、KV 缓存纪律、按需 skill 加载）；
   **PDF 工具**必须自己写——而这恰好是最小、最确定的一块。

## 1. 调研方法与来源分级

- **A 级**：本机 DeepSeek Harness 源码（解包 app.asar 后读的包 README）、官方文档站、npm/crates 元数据（2026-11-01 抓取）。
- **B 级**：搜索摘要与第三方页面（如 ACM 论文页、GitHub README），已核对仓库/包名。
- 未做真实嵌入实验；体积为估算（按 Node 运行时 + 典型 agent 包规模）。

## 2. 候选清单（A 级事实）

### 2.1 完整 Agent 运行时（可作为子进程嵌入）

| 项目 | 形态 / 版本 | 嵌入方式 | 运行时要求 | 许可 |
|---|---|---|---|---|
| **DeepSeek Harness** | npm `@deepseek-ai/dsh` v0.2.1-rc.5 | ① `dsh --profile acp`：标准 ACP v1 stdio 服务器（建/恢复会话、工具、权限、上下文用量事件）；② `dsh --profile sdk-minimal`：极简 JSON-RPC stdio agent（默认只给一个 shell 工具，**不含压缩/文件工具**）；③ `dsh --profile headless --json`：一次性任务 + 事件流 | Node 运行时 | MIT |
| **Claude Agent SDK** | npm `@anthropic-ai/claude-agent-sdk` v0.3.316，Node ≥18.14 | 官方定位「Build production AI agents with Claude Code as a library」：内置工具、agent loop、上下文管理、会话、hooks、subagents、MCP、skills、权限、checkpointing；非 Python/TS 语言可用 CLI `-p --output-format json` 子进程驱动 | Node + Claude Code 二进制 | Anthropic 商业条款 |
| **OpenAI Codex SDK** | npm `@openai/codex-sdk` v0.166.0 + Codex CLI | SDK 驱动本地 Codex agent；另有官方社区 ACP 适配器 `codex-acp` | Codex 二进制（Rust） | Apache-2.0 |
| **Sema Core** | npm `sema-core`，GitHub `midea-ai/sema-code-core`，论文 SPLASH/ISSTA'26 | 专门定位「Open, Embeddable AI Coding Agent Runtime」：事件驱动内核，多 agent 协作、Skill、Plan mode；已有 VSCode/JetBrains 扩展、Web UI（SemaWork）、PLC IDE 等产品；提供 Java/Python/C# SDK | Node ≥20.18.1 | MIT |
| **OpenCode** | npm `opencode-ai` v1.19.5 | CLI/server + SDK，也实现 ACP | 自带运行时 | MIT |

### 2.2 协议层：ACP（Agent Client Protocol）——「你的应用当客户端」

- 定位：把「编辑器/应用」与「agent 进程」之间的通信标准化（stdio JSON-RPC；会话新建/恢复/关闭、prompt、工具调用、
  权限请求、计划、取消、文件系统、终端、上下文用量等）。
- 生态：官方 agents 列表已有 **60+** 实现，包括 Codex CLI、Cursor、Gemini CLI、GitHub Copilot、Kimi CLI、
  Qwen Code、Claude Agent（经 Zed 适配器）、OpenCode、Cline、Goose、OpenHands、Junie（JetBrains）、Kiro、Mistral Vibe 等。
- SDK：**Rust 1.0**（crate `agent-client-protocol`，Zed 在用）、**TypeScript 1.0**（`@zed-industries/agent-client-protocol` v0.4.5）。
- 含义：你的应用**不需要打包任何 agent**——只要实现 ACP 客户端，用户装了什么就能接什么；协议还已包含
  **会话压缩（session compaction）**、上下文用量、权限等标准消息。

### 2.3 进程内 Agent 库（不捆绑完整运行时，需要构建/打包）

| 语言 | 候选 | 版本/许可 | 说明 |
|---|---|---|---|
| JS/TS | `@openai/agents` | v0.21.0，MIT | 轻量多 agent 框架（tools / handoffs / sessions / streaming） |
| JS/TS | Vercel AI SDK `ai` | v7.0.159，Apache-2.0 | 统一模型接口 + 工具循环 + 流式；浏览器可用，但需要打包 |
| JS/TS | `@langchain/langgraph` | v1.6.0，MIT | 图/状态机式 agent 工作流，重 |
| JS/TS | `@mastra/core` | v1.81.0，Apache-2.0，Node ≥22.13 | 全功能 agent 框架，依赖多 |
| Rust | `rig` / `rig-core` | rig-core 0.46.0，MIT，约 396 万下载 | Rust 原生 agent 库：内置 20+ 模型 provider、工具、多轮流式；另带终端 agent `rig -p --json` 可管道驱动 |
| Python | Claude Agent SDK（Python） / Pydantic AI / smolagents | — | 不适合本项目（无 Python 运行时） |

### 2.4 MCP（工具层标准）

- `@modelcontextprotocol/sdk` v1.32.2（MIT）：任何人都能把「本地能力」暴露成 MCP 工具，供上面这些 agent 使用。
- 对本项目：把「PDF 阅读能力」做成 MCP server 后，DSH / Claude Code / Codex 等**不需要改代码**就能读论文页。

## 3. DeepSeek Harness 的做法（本机源码核对，可抄的设计）

从 `app.asar` 解包读到的包（README 与包结构）：

| 包 | 关键事实 | 对本项目的借鉴 |
|---|---|---|
| `dsh-agent-loop` | 「调用模型 → 执行工具 → 重复」的循环；并行工具调用上限 10；独占调用串行屏障；**没有固定轮次上限**（由 turn-stopping 策略控制）；取消保留已交付文本 | 工具循环不要写死 2 轮；设超时/预算止损 |
| `dsh-system-prompt` | 系统提示是**有序段注册表**（顺序 + 名称 + 可插值变量）+ 工具 schema 一起组装；runtime 上下文单独作为 user 角色快照；**KV cache 纪律**（append-only、系统提示不变、变更用 in-history 更新） | 提示词分层注册；稳定前缀放前面；变量只放易变信息 |
| `dsh-compaction-basic` | 上下文到模型窗口 **80%** 时压缩；逐字保留最近 **16%**；旧历史摘要成 checkpoint（`<compacted-summary>`）；溢出错误自动压缩重试；摘要请求复用热前缀 | 逐字保留近期 + 摘要旧史；不要把整篇塞满窗口 |
| `dsh-compaction-tool-result-pruner` | 工具结果超过 **8192 字符**时保留头 4096 + 尾 1024 + 中间标记；不调模型、确定性 | 页文本/搜索结果回传要有上限，超了头尾截断 |
| `dsh-compaction-image-offload` | 图片超预算时**替换为占位文本 + 只读路径**，后续按需重读 | 扫描件页图不必永远留在上下文——留"页号+可重读"引用即可 |
| `dsh-skill` / `dsh-skill-filesystem` | 技能 = 目录（名称+描述）+ **按需加载正文**（渐进披露）；调用策略分模型/用户 | 论文能力可做成「技能」按需加载，而不是塞满系统提示 |
| `dsh-agent-instructions` | `AGENTS.md`/`CLAUDE.md` 分层发现、预算截断、仅追加的上下文注入 | 全局/单篇记忆可以照这个做「分层 + 预算 + 只追加」 |
| `dsh-tools` / `dsh-tool-fs` | 工具注册表（类型化 schema、权限门禁、超时、取消）；`read` 带行号/offset/limit/硬上限，`read_image` 原生图片块 | PDF 页文本/页图工具照这个形状设计 |

## 3.5 专题：直接改 DeepSeek Harness 源码可行吗（2026-11-01 实测数字）

- **源码**：GitHub `deepseek-ai/deepseek-harness` 公开、**MIT**、默认分支 `master`、仓库根版本 `0.2.2-alpha.2`；
  Node **≥24.9.0**、pnpm **11.28.5**，pnpm monorepo（「一切皆插件」、Cordis 框架）；官方明确是 **developer preview**，
  「未来将出现破坏兼容性的变更」。文档站：<https://deepseek-harness.github.io/deepseek-harness/>。
- **本机安装体积实测**（DeepSeek Harness 桌面版 `app.asar`/runtime）：
  - 内置 Node 运行时：**89.4 MB**（`primary-runtime/dependencies/node`）；
  - `dsh/node_modules` 合计 **443.5 MB**，其中 `libreoffice-kit-win32-x64` 一项就 **325.1 MB**（Office→PDF 工具，论文阅读器不需要，可裁）；
  - 另有 `@img/sharp-win32-x64` 18.5 MB、`@vscode/ripgrep` 5.2 MB、client/web UI 产物约 12 MB（嵌入阅读器时可裁）。
  - 剔除 Office 套件后，DSH JS 包体量约 **118 MB**（仍含所有 bundle 与 client UI）。
- **exe 体积影响估算**：单文件绿色版现在 **10.6 MB**；若内置 DSH+npm 依赖+Node 运行时，未压缩约 **130–160 MB**，
  7z 压缩后约 **40–70 MB**（还没算我们的 PDF 工具与前端）。与「单文件 10 MB 绿色版」的定位冲突。
- **集成方式可行性（官方支持，不用改内核源码）**：
  1. DSH 有 **ACP profile**（`dsh --profile acp`，标准 ACP stdio 服务器）与 **SDK profile**（JSON-RPC）；
  2. DSH 有 **MCP client**：PDF 工具可做成 MCP server 挂进去，**不用改 DSH 代码**；
  3. profile/`--patch` 文件可在默认配置树之上插 bundle/配置项。
  → **「直接用」的最小路径是：官方 DSH + 自定义 profile 补丁 + MCP/PDF 工具 + 我们的 UI**；
  fork 整仓只在需要改内核行为/UI 时才必要。
- **风险**：developer preview 版本快速迭代且声明会破坏兼容；Node 24.9 运行时需随应用分发；双进程（Node sidecar + Rust 后端 + webview）
  通信与生命周期复杂度上升；PDF 页面渲染在 Node 侧不可直接复用 webview 的 PDF.js，需回调阅读器取页图/页文本；
  杀软对「exe 释放 node 运行时」敏感度未知。
- **结论**：**技术可行，工程可控，但体积与维护成本显著**。建议先做「不改源码」的 POC 验证效果，再决定是否 fork/裁剪打包。

## 4. 对本项目的落地建议

### 4.1 不要做（成本/收益不成比例）

- **不要把 DSH / Claude Code / Codex / Sema Core 整包塞进 exe**：需要捆绑 Node 运行时（或它们的二进制），
  exe 从 ~10.6 MB 涨到 60–150 MB；它们的默认工具与权限模型是「改代码 + 跑命令」，与「只读论文」不符；
  还要额外写 PDF 工具/权限适配，工作量和自建相当。
- 也不建议为此改成 Electron 应用（丢失单文件绿色版的优势）。

### 4.2 推荐分三层

1. **默认层（必做）：应用内轻量工具循环 + DeepSeek 原生 function calling。**
   - 工具：`list_pages` / `read_page_text(n)` / `read_page_image(n)` / `search_paper(q)` / `current_page`；
   - 循环：最多 3 轮、每轮 ≤3 个工具、整体超时；引用白名单 = 已读页（天然防编页）；
   - 上下文策略**照抄 DSH**：稳定前缀（论文元信息/系统提示）→ 历史 → 当前页/选区，压缩阈值与工具结果修剪；
   - 保留原计划的「模型选页（两段式）」作为无 tool-calling 模型的降级路径。
2. **进阶层：实现 ACP 客户端（可选功能，不打包 agent）。**
   - 用 Rust `agent-client-protocol`（1.0）在桌面壳里实现客户端，或前端经本地代理说 JSON-RPC；
   - 设置页提供「连接外部 Agent」：DSH、Codex、Claude Code、Cursor、Gemini CLI、Kimi CLI、Qwen Code…（用户本机已装的）；
   - 外部 agent 看到的工具通过 **MCP** 提供（PDF 页文本/页图/搜索），这样它不需要知道 PDF 解析细节。
3. **工具层：把 PDF 能力做成 MCP server（首选）或 ACP 工具。**
   - 这是「一次实现，内置循环和外部 agent 都能用」的关键；
   - 也方便以后接别的模型/agent 产品（OpenAI/Anthropic 都支持 MCP）。

### 4.3 如果用户坚持「要现成的整套」

最接近的是 **Sema Core**（MIT、明确的可嵌入定位、多语言 SDK、已有 IDE 产品验证）或 **DeepSeek Harness**（同厂、ACP/SDK/headless 三种接入、源码可读）。
但要接受：体积、Node 运行时、以及必须自写 PDF 工具/权限适配。

## 5. 待验证（本调研未做实验）

1. DSH `acp` / `sdk-minimal` 的实际启动体积与内存占用（含 Node 运行时）；
2. DSH 能否用 **DeepSeek Anthropic 兼容端点**跑通 Claude Agent SDK 风格的工具循环（官方有 `/anthropic` 端点）；
3. ACP Rust 客户端与本地前端通信的最小实现成本（stdio 代理 vs 本机 HTTP）；
4. MCP server 在 exe 内的启动方式（子进程 vs 内置 HTTP 端点）；
5. 各家 agent 对「PDF 页图（图片结果）」作为工具返回值的支持差异。

## 6. 来源（A 级，2026-11-01 抓取）

- 本机 DeepSeek Harness 运行时：`app.asar` 内 `@deepseek-ai/dsh-*` 包 README（agent-loop / system-prompt / compaction-basic /
  compaction-tool-result-pruner / compaction-image-offload / tools / tool-fs / skill / agent-instructions / acp / sdk-minimal / headless）
- npm registry：`@deepseek-ai/dsh` 0.2.1-rc.5、`@anthropic-ai/claude-agent-sdk` 0.3.316、`@openai/agents` 0.21.0、
  `@openai/codex-sdk` 0.166.0、`opencode-ai` 1.19.5、`ai` 7.0.159、`@langchain/langgraph` 1.6.0、`@mastra/core` 1.81.0、
  `@modelcontextprotocol/sdk` 1.32.2、`@zed-industries/agent-client-protocol` 0.4.5
- crates.io：`rig-core` 0.46.0；`agent-client-protocol`（ACP Rust SDK 1.0）
- 官方文档：Claude Agent SDK Overview <https://docs.claude.com/en/api/agent-sdk/overview>；
  ACP Agents <https://agentclientprotocol.com/get-started/agents>、ACP Rust SDK <https://agentclientprotocol.com/libraries/rust>；
  Sema Core GitHub <https://github.com/midea-ai/sema-code-core>（README、论文 DOI 10.1145/3837729.3840503）；
  rig GitHub <https://github.com/0xPlaygrounds/rig>、rig 文档 <https://rig.rs/docs>
- B 级：SPLASH/ISSTA 2026 工具演示页（Sema Core）、DeepSeek Harness 官方文档站

## 7. 与既有文档的关系

- 不推翻 [`上下文策略-调研.md`](上下文策略-调研.md) 的「混合」结论，也不推翻 [`提示词工程-设计.md`](提示词工程-设计.md) 的 P0–P4 计划；
- 新增的是「**现成 agent 运行时**」这一选项：默认仍自建轻量 loop，但把「ACP 客户端 + MCP 工具层」列为可选进阶方向；
- 是否采纳 ACP/MCP 层由用户决定，未写进设计。
