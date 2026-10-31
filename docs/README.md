# 文档索引

> 2026-10-22 仓库整理后的文档分界：`docs/` 只放**长期维护**的文档，
> 过程性/一次性材料进 `docs/archive/`，本机私人资料**根本不进仓库**。

## 长期文档（会跟着代码更新）

| 文档 | 内容 |
|---|---|
| [`PROGRESS.md`](PROGRESS.md) | 逐轮改造记录：每一轮的用户口径 → 根因 → 改法 → 验收数字 |
| [`使用说明书.md`](使用说明书.md) | 给使用者的界面与操作说明 |
| [`触摸屏缩放丝滑化.md`](触摸屏缩放丝滑化.md) | 触摸屏手势 / 渲染倍率 / 掉帧的专项技术记录（含实测数据） |
| [`读懂论文-设计.md`](读懂论文-设计.md) | 「读懂论文」四项教学能力与学习记忆的设计（2026-10-25 改为后台自动维护） |
| [`读懂论文-示例回答.md`](读懂论文-示例回答.md) | 上述提示词在真实论文（Attention Is All You Need）上的真实模型输出与点评 |

## 历史归档（`archive/`，不再维护，只作追溯）

| 文档 | 内容 |
|---|---|
| [`archive/refactor-baseline-phase0.md`](archive/refactor-baseline-phase0.md) | 阶段 0 基线固化：备份、测试跑法、冻结基准 |
| [`archive/开发记录-用户反馈对照.md`](archive/开发记录-用户反馈对照.md) | 27 条用户反馈的「根因 → 修法 → 验证」对照表（原在 README） |
| [`archive/交接提示词.md`](archive/交接提示词.md) | 给接手会话的交接说明 |
| [`archive/给DeepSeek的下一阶段提示词.md`](archive/给DeepSeek的下一阶段提示词.md) | 早期给模型的下一阶段提示词 |
| [`archive/代码审查-可维护性问题清单.md`](archive/代码审查-可维护性问题清单.md) | 代码审查发现的可维护性问题 |
| [`archive/删减审计.md`](archive/删减审计.md) · [`archive/删减验收清单.md`](archive/删减验收清单.md) | 功能删减审计与验收清单 |
| [`archive/安全与数据边界审计.md`](archive/安全与数据边界审计.md) | 安全与数据边界审计 |
| [`archive/待办总台账.md`](archive/待办总台账.md) · [`archive/待解决清单.md`](archive/待解决清单.md) | 早期待办与待解决清单 |
| [`archive/RESEARCH.md`](archive/RESEARCH.md) | 立项调研（同类产品为什么都不顺手） |
| [`archive/paper-explainer-plan.md`](archive/paper-explainer-plan.md) | Coach 模式 / 论文操作模块的早期设计 |
| [`archive/阅读助手界面设计.md`](archive/阅读助手界面设计.md) · [`archive/阅读助手界面设计-对照与冲突.md`](archive/阅读助手界面设计-对照与冲突.md) | 阅读助手界面设计稿与冲突对照 |
| [`archive/首页设计.md`](archive/首页设计.md) | 首页（书架）设计 |

## 本机资料（**不在仓库里**，见仓库根 `.gitignore`）

| 路径 | 内容 |
|---|---|
| `docs/internal/` | VPS / SSH / 代理等私人资料（2026-10-22 已从全部 git 历史抹除） |
| `tools/internal/` | DSH 等 AI 工具的内部脚本 |
| `archive/`（仓库根） | 旧 Android 壳工程（约 7 MB，前端资源的重复副本），只留本机 |
| `brightness-research-report.md` | 与本项目无关的个人技术调研报告 |
