# 记忆系统调研（Codex / ChatGPT / Claude Code / Cursor）

> 用途：为 [`问答与翻译-整体设计.md`](问答与翻译-整体设计.md) §6「会话记忆与全局记忆」提供外部参考。
> 调研时间：2026-11（面向 2026 年的产品形态）。只作设计参考，不改变本机数据边界：
> 所有记忆仍只存本机，不新增外部服务。

## 0. 一句话结论

Codex 没有自动生成的「项目知识库」：它把**项目规则**（AGENTS.md）、**跨会话回忆**（Memories，默认关闭）、
**屏幕上下文**（Chronicle，opt-in）和**会话连续性**（resume / compact）分开；
ChatGPT 把记忆做成「可查看、可纠正、可删除、可限定范围」的用户资产。
共同点是：**记忆是带来源的缓存，不是模型人格**。对本项目的启示是分层：
用户手写规则（长期记忆）> 论文/会话沉淀（摘要）> 会话内状态（原文历史）。

## 1. Codex 桌面应用 / CLI

| 能力 | 形态 | 解决什么 |
|---|---|---|
| AGENTS.md（项目级） | 仓库根/子目录 Markdown，随代码版本化；启动时拼成指令链 | 团队规范、构建命令、目录约定不用每次重复说 |
| Memories（跨会话，默认关闭） | Settings > Personalization > Memories 或 `[features] memories=true`；后台把合格旧线程提炼成本地 Markdown（摘要、条目、证据），存 `~/.codex/memories/`；跳过活跃/短会话，脱敏 secrets，等空闲再处理 | 稳定偏好、常用工作流、技术栈、项目坑 |
| Chronicle（屏幕记忆，opt-in） | macOS Pro 研究预览；读屏 + 辅助功能权限，后台 agent 从截图/OCR 生成 memory；截图临时存 6 小时，memory 是未加密 Markdown | 「我刚才在看什么/用什么工具」 |
| resume / compaction | `codex resume` 保留原 transcript、计划历史、approvals；`/compact` 总结可见对话释放上下文；不负责跨项目知识 | 长会话连续性 |

官方口径：**必须始终生效的团队规则应放 AGENTS.md**，Memories 只是本地回忆层，不是规则的唯一来源。

AGENTS.md 的层级（值得照抄的规则）：

1. 全局：`~/.codex/AGENTS.override.md`，否则 `AGENTS.md`，只取第一个非空文件；
2. 项目：从 Git root 逐层到 cwd，每层按 `AGENTS.override.md` → `AGENTS.md` → fallback 文件名查，每层最多一个；
3. 拼接：根 → cwd 用空行连接，越靠近 cwd 越靠后、覆盖前者；空文件跳过；
   总大小到 `project_doc_max_bytes`（默认 32 KiB）停止追加。

适合写：构建/测试命令、代码风格、目录结构、安全注意、PR/commit 规范、常见坑、必须始终遵守的短规则。
不适合：密钥、一次性任务、代码可推导的架构清单、长篇多步流程、模糊口号。

## 2. ChatGPT 的记忆

- **提取**：稳定偏好、身份/工作背景、长期目标等「下次有用」的信息；不保留每次对话所有细节；摘要会省略不相关或不适合展示的内容；敏感信息也可能被记住，需要用户审查。
- **注入**：不每轮全量塞入，只在「可能改善回答」时检索相关记忆/历史；回答下方 Sources 标出可能来源，但不保证列全。
- **控制**：可查看摘要、纠正、删除、「不要再提」；可分别关闭 Memory / Reference saved memories / Reference chat history；临时聊天不创建也不更新记忆；企业/受监管工作区可开 project-only memory。
- **隐私边界**：关 Memory 不删历史；删聊天不必然删已保存记忆；删记忆也不删原聊天；删除/传播最长约 30 天；摘要不是全部。
- 核心：**可见、可改、可删、可限定范围**，不是「记得越多越好」。

## 3. Claude Code / Cursor 对比

- **Claude Code**：两套。`CLAUDE.md` 由人写，按 managed policy → 用户 → 项目 → 本地分层，全部拼接（不是覆盖），子目录按需加载，建议 < 200 行。**auto memory** 由 Claude 写，按 git 仓库隔离，分 user / feedback / project / reference 四类；`MEMORY.md` 索引每次只加载前 200 行 / 25KB，细节放 topic 文件按需读；跳过代码可推导的内容和 CLAUDE.md 已写的内容；`/memory` 可看/改/删/关。
- **Cursor**：主要是显式 Rules：Project `.cursor/rules/*.mdc`、User Rules、Team Rules、AGENTS.md；用 frontmatter 的 alwaysApply / description / globs 控制「总是 / 智能 / 按文件 / 手动」触发。公开文档没有 Claude 式自动抽取。
- 结论：Claude 省事但易污染；Cursor 可控但靠用户勤奋；**Codex 把项目规则与个人回忆分开，最接近论文阅读器需要的形态**。

## 4. 设计要点（对 §6 的输入）

1. **分层**：全局偏好（语言、解释深度、模型/预算、UI 习惯）→ 论文级知识（元数据、概念、用户标注/结论、阅读进度、未解决问题）→ 会话内状态。优先级：用户当前指令 > 论文级 > 全局。
2. **写入时机**：显式「记住」立即写；自动提取只在会话空闲后异步跑，短会话/低额度跳过，高影响条目进「待确认」队列。
3. **证据**：每条记忆带来源（DOI/标题 + 页码/段落 + 原文引句或用户原话 + 时间 + 置信度）；区分「用户说的」与「模型推断」，后者默认不作为事实注入。
4. **去重、冲突与上限**：稳定键归一；新值覆盖旧值但保留版本；冲突显式提示，不静默合并；全局 100–200 条、每篇 30–50 条、单次注入 token 预算固定，按「最近使用 + 重要性 + 证据强度」衰减，过期归档而非硬删。
5. **可见、可控与注入**：记忆面板可搜索/编辑/删除/停用/导出；支持「本次不用记忆」「这篇论文不记」；全局小卡常驻，论文级按检索 top-k 注入，会话摘要按需，并标注「以下为记忆，可能过时」，不要整库拼进 system prompt。
6. **成本与失败**：后台用便宜模型、批量、超时/重试/熔断；任何记忆失败都不阻塞翻译/问答主流程；本地优先，默认不上传。

## 5. 常见翻车点

- **记忆污染与错误推断**：模型把一次「这次用中文」写成「永远只用中文」，下次再被自己强化；靠证据、置信度、待确认队列和定期审计，全局偏好要求重复出现或显式确认。
- **隐私泄露**：本地 Markdown 未加密、屏幕截图、API Key 混入；记忆文件应脱敏、排除 `data/` 密钥、可一键清空。
- **token 膨胀**：全量注入挤掉论文正文，且规则越长遵循率越差（Codex 32 KiB、Claude 200 行/25KB 都是硬约束）。
- **用户不知情/过期**：自动记录却没有入口；首次启用要 consent；面板要显示「记了什么、从哪来、被谁用过」；记忆带时间和论文版本，跨项目默认隔离。

## 6. 对本项目的落地建议（对应 §6.2）

1. **先做论文级，再做全局**：以 `docId` 为主键，存讨论摘要、已确认结论、开放问题；全局只放语言/风格/长期要求等少量稳定项。
2. **显式为主、自动为辅**：用户手写「长期记忆」；自动只做会话摘要与既有学习画像，不自动写论文事实。
3. **每条记忆可溯源**：会话摘要记录生成时间与覆盖范围；学习画像已带原话证据；长期记忆是用户手写，不冒充论文证据。
4. **检索注入，不整库注入**：长期记忆卡 + 论文讨论摘要 + 会话摘要 + 最近对话，各自有字符上限。
5. **给用户控制权**：设置页可编辑/清空长期记忆；会话菜单可清除本篇对话记忆；设置页可关闭后台学习记忆（已有）。
6. **本地优先 + 失败开放**：全部本机文件；摘要生成失败静默降级；不引入外部记忆服务、不做跨设备同步。

## 7. 主要来源

- [Codex Memories](https://developers.openai.com/codex/memories) / [Chronicle](https://developers.openai.com/codex/memories/chronicle)
- [Codex AGENTS.md 指南](https://developers.openai.com/codex/guides/agents-md)
- [Codex CLI 功能](https://developers.openai.com/codex/cli/features) / [slash commands](https://developers.openai.com/codex/cli/slash-commands)
- [Memory in ChatGPT](https://help.openai.com/en/articles/8590148-memory-in-chatgpt)
- [OpenAI: Memory and new controls for ChatGPT](https://openai.com/index/memory-and-new-controls-for-chatgpt/)
- [Claude Code memory](https://code.claude.com/docs/en/memory)
- [Cursor Rules](https://cursor.com/docs/rules) / [agents.md](https://agents.md/)
