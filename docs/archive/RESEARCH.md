# 调研：划词翻译 / 问 AI 的 PDF 论文阅读器

> 目的：在动手之前先搞清「这个赛道有什么、缺什么」。
> 方法：搜索引擎 + 一手来源（GitHub README / LICENSE / package.json / 官方站点）。
> **无法从一手来源证实的都标了「未确认」。**

---

## 一、结论先行

1. **同时做到「划词翻译 + 划词问 AI」的开源方案，只有 `paper-chat-for-zotero`，而它必须装 Zotero。**
2. **「全文双语对照」和「划词」之间是断的**：做全文对照的全是离线批处理（产出新 PDF），做划词的全是"选区→一个气泡"；中间地带（读到哪里翻到哪里、译过就缓存）没人做。
3. **「开源 + 划词 + 本地 + 自带阅读器」这个组合，在调研范围内不存在。** 闭源阵营（知云 / 小绿鲸 / ReadPaper / SciSpace / ChatPDF / Explainpaper / Elicit）无一例外是**云端 SaaS**，要求把论文上传。
4. **「零依赖」本身就是差异化**：`pdf2zh` 要 Python 3.11–3.12 + uv + ONNX 模型（国内还得配镜像），`zotero-pdf2zh` 要 Python + server + xpi，`Selection-Assistance` 要 xdotool + Python + Node，`CopyTranslator` 是 Electron 8 老壳。

→ 所以本项目的定位：**双击就能用、PDF 不出本机、划词即译即问。**

---

## 二、同类工具

图例：✅ 有 ｜ ⚠️ 部分/有条件 ｜ ❌ 无 ｜ ? 未确认

| 工具 | 开源 / License | 技术栈 | 划词翻译 | 全文双语对照 | 划词问 AI | 全文问答 | 图表/公式 | 笔记高亮 | 本地离线 | 自带阅读器 |
|---|---|---|---|---|---|---|---|---|---|---|
| [zotero-pdf-translate](https://github.com/windingwind/zotero-pdf-translate) | ✅ AGPL-3.0 | TS，Zotero 7/8 插件 | ✅ | ❌ 仅句级 | ❌ | ❌ | ❌ | ✅ 写入批注 | ✅ 可接 MTranServer/NLLB | ❌ 寄生 Zotero |
| [paper-chat-for-zotero](https://github.com/syt2/paper-chat-for-zotero) | ✅ AGPL-3.0 | TS，Zotero 7–10 插件 | ✅ | ❌ | ✅ | ✅ | ✅ 可截 PDF 图 | ✅ | ❌ | ❌ 寄生 Zotero |
| [Selection-Assistance](https://github.com/xuyicheng-zju/Selection-Assistance) | ✅ Apache-2.0（README 写 MIT，冲突未确认） | Electron 31 + React + FastAPI | ✅ 全局热键 + xdotool | ❌ | ✅ 多轮追问 | ❌ | ⚠️ KaTeX + OCR | ❌ | ❌ 走阿里云百炼 | ❌ 跨应用划词 |
| [PDFMathTranslate / pdf2zh](https://github.com/PDFMathTranslate/PDFMathTranslate) | ✅ AGPL-3.0 | Python + DocLayout-YOLO ONNX | ❌ | ✅ dual 版 | ❌ | ❌ | ⚠️ 保留排版 | ❌ | ✅ 可接 Ollama | ❌ 产出 PDF |
| [Sioyek](https://github.com/ahrm/sioyek) | ✅ GPL-3.0 | C++ / Qt5 | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ 多色高亮 | ✅ 纯本地 | ✅ 原生 |
| [沉浸式翻译 PDF](https://immersivetranslate.com/en/docs/features/pdf/) | ❌ 闭源（README 明说） | 浏览器扩展 + Zotero 插件 | ✅ +悬停/输入框 | ✅ Pro 逐行 | ❌ | ❌ | ⚠️ Pro 公式/表格/OCR | ❌ | ❌ Pro 上传云端 | ❌ |
| [CopyTranslator](https://github.com/copytranslator/CopyTranslator) | ✅ GPL-2.0 | TS + Vue + Electron 8 | ✅ 复制即翻译 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ v12 可接 Ollama | ❌ 纯剪贴板外挂 |
| 知云文献翻译 | ❌ 闭源 | ? | ✅ | ? | ? | ? | ? | ? | ? | ? |
| [小绿鲸](https://www.xljsci.com/) | ❌ 闭源 | ? | ✅ 上限 5000 字符 | ✅ | ⚠️ | ✅ | ✅ 图表解读 | ✅ 思维导图 | ⚠️ 有"离线模式"，程度未确认 | ✅ |
| [ReadPaper](https://readpaper.com/) | ❌ 闭源 | ? | ✅ | ✅ | ✅ | ✅ | ✅ 图表&引文解析 | ✅ | ❌ 云端 | ✅ |
| [SciSpace](https://scispace.com/) | ❌ 闭源 | ? | ✅ 75+ 语言 | ❌ | ✅ 划词解释 | ✅ 带引用 | ✅ | ✅ | ❌ | ✅ Web |
| [ChatPDF](https://www.chatpdf.com/) | ❌ 闭源 | ? | ❌ **无划词** | ❌ | ❌ | ✅ 多文件 | ⚠️ | ❌ | ❌ | ✅ |
| [Explainpaper](https://www.explainpaper.com/) | ❌ 闭源 | ? | ❌（是"解释"） | ❌ | ✅ 高亮即解释 | ⚠️ | ? | ❌ | ❌ | ✅ Web |
| [Elicit](https://elicit.com/) | ❌ 闭源 | ? | ❌ | ❌ | ❌ | ✅ | ✅ Scale 档 | ❌ | ❌ | ❌ 工作台 |
| [zotero-gpt](https://github.com/MuiseDestiny/zotero-gpt) | ✅ | TS，Zotero 插件 | ❌ | ❌ | ✅ 命令标签 | ✅ | ❌ | ⚠️ | ❌ | ❌ 寄生 |
| [zotero-pdf2zh](https://github.com/guaguastandup/zotero-pdf2zh) | ✅ | Zotero 插件 + Python Server | ❌ | ✅ Dual/Crop | ❌ | ❌ | ⚠️ | ❌ | ✅ | ❌ 寄生 |
| [BabelDOC](https://github.com/funstory-ai/BabelDOC) | ✅ | Python 库 | ❌ | ✅ | ❌ | ❌ | ⚠️ | ❌ | ✅ | ❌ 产出 PDF |

### 关键发现

- **`pdf2zh` / `zotero-pdf2zh` 官方文档明确说：不提供 OCR**，扫描版要用户自己先处理（原文："需要您用其他工具对自己的扫描版文件进行 OCR 处理"）。
- **沉浸式翻译免费版明确「只支持标准（非扫描）PDF」**，OCR 是 Pro 付费项；且 Pro 的**译文会在服务端保存一段时间**。
- **`zotero-pdf-translate` 支持自托管 MTranServer / LibreTranslate / NLLB** —— 说明"本地翻译后端"这条路已有先例，但没人把它和"自带阅读器"合起来。
- **知云**官方 FAQ 里有一条「为何划选单词可以翻译，但划选句子和段落不翻译？」—— 划词**粒度受限**曾是真实痛点；其计费是"46 个引擎分 4 类，按积分解锁"。

### 值得借鉴的具体交互（已实现 ✅ / 待做 ⬜）

| 来源 | 交互 | 本项目 |
|---|---|---|
| zotero-pdf-translate | **Ctrl/⌘ 拼接多次选区**（Concat Mode），治句子被图表切开 | ✅ 按住 Ctrl 划选自动拼接 |
| CopyTranslator | **选区 reflow**：PDF 复制出来带多余换行，先清洗再翻 | ✅ `cleanText()` 处理断词连字符 / 换行 / 段落 |
| paper-chat-for-zotero | 译文**就地显示在选区旁**，不弹大面板 | ✅ 浮动译文卡片贴选区下方 |
| SciSpace / ChatPDF | 答案**锚定原文** + 可回跳 / Side-by-Side 核对 | ✅ 每条回复带页码 + 「回跳 p.N」 |
| 小绿鲸 | **术语库**批量导入，保证译名统一 | ✅ 术语表，只把命中条目喂给模型 |
| 小绿鲸 | 切换文档**保留缩放与阅读位置** | ✅ 按论文存 `data/state.json` |
| Selection-Assistance | SSE token **~30fps 合帧**，防高吞吐掉帧 | ✅ `requestAnimationFrame` 合帧 |
| Selection-Assistance | **智能贴底**：用户上滚时不抢滚动位置 | ✅ `scrollChatIfSticky()` |
| Selection-Assistance | **空选区哨兵**：没选到新文字就不重发请求 | ✅ 选区 < 2 字符直接返回 |
| zotero-gpt | **命令标签**：高频提问一键执行 | ✅ 快捷提问按钮行 |
| Sioyek | **Smart Jump**：点引用跳图/表/参考文献 | ⬜ 未做（文本层拿不到足够结构） |
| Sioyek | **Portals**：第二屏常驻对照区 | ⬜ 未做（右侧面板部分替代） |
| 沉浸式翻译 Pro | **多栏自动重排为单栏** | ⬜ 未做（跨栏划选仍会混） |

---

## 三、相关论文

> 以下几篇是通过检索找到的、与本项目设计直接相关的学术工作。**只列出实际检索到的条目**，未逐篇精读全文，故只描述标题/摘要层面的信息。

| 论文 | 出处 | 与本项目的关系 |
|---|---|---|
| [Paper Plain: Making Medical Research Papers Approachable to Healthcare Consumers with NLP](https://ar5iv.labs.arxiv.org/html/2203.00130) | CHI 2023 | 让非专业读者读懂论文：术语与段落级通俗解释。对应本项目的「释」和「解释这段」 |
| [Augmenting Scientific Papers with Just-in-Time, Position-Sensitive Definitions of Terms and Symbols](https://dl.acm.org/doi/abs/10.1145/3411764.3445648)（ScholarPhi，[arXiv:2009.14237](https://export.arxiv.org/pdf/2009.14237v1.pdf)） | CHI 2021 | **位置敏感**：同一个符号在不同章节含义不同 → 上下文必须带页码与所在段落 |
| [CiteRead: Integrating Localized Citation Contexts into Scientific Paper Reading](https://dl.acm.org/doi/fullHtml/10.1145/3490099.3511162) | UIST 2022 | 把被引论文的相关段落**就地**展示在阅读位置 → 支持"就地展示"而非"另开空间" |
| [Qlarify: Recursively Expandable Abstracts for Dynamic Information Retrieval over Scientific Papers](https://dl.acm.org/doi/fullHtml/10.1145/3654777.3676397) | UIST 2024 | 按需**递归下钻** → 支持从"这段是什么"连续追问到"这个术语是什么" |
| [PDF-WuKong: A Large Multimodal Model for Efficient Long PDF Reading](https://arxiv.org/html/2410.05970v1) | arXiv 2410.05970 | 整篇 PDF 喂模型代价高（要稀疏采样）→ 默认只发选中的一段 + 局部上下文 |
| [Beyond the Page: Enriching Academic Paper Reading with Social Media Discussions](https://dl.acm.org/doi/full/10.1145/3746059.3747647) | ACM 2025 | 把外部讨论引入阅读 → 提示"（背景知识）"与原文内容要区分标注 |
| [DocVoyager: Anticipating User's Information Needs and Guiding Document Reading through QA](https://research.adobe.com/publication/docvoyager-anticipating-users-information-needs-and-guiding-document-reading-through-question-answering/) | Adobe Research | 预测信息需求、引导式阅读 → 快捷提问按钮的动机 |
| [LLMs as Academic Reading Companions: Extending HCI Through Synthetic Personae](https://ui.adsabs.harvard.edu/abs/2024arXiv240319506C/abstract) | arXiv 2403.19506 | LLM 作为阅读同伴的角色设计 |
| [Emerging Reliance Behaviors in Human-AI Content Grounded Data Generation](https://research.ibm.com/publications/emerging-reliance-behaviors-in-human-ai-content-grounded-data-generation-the-role-of-cognitive-forcing-functions-and-hallucinations) | CHIWORK 2025 | **过度依赖**风险 → 回答必须可核验：标出处、区分原文与背景知识 |

### 从文献推出的设计原则（本项目据此取舍）

1. **位置敏感**：同一个符号在不同节含义不同 → 每次提问/翻译都带上**页码 + 所在页上下文**，而不是裸发一段文字。
2. **就地展示**：译文贴在原文旁边；答案与原文并排。不把用户推离阅读位置。
3. **可核验**：每条回答都带「回跳 p.N」。不给回跳，用户没法验证，信任会崩（也助长过度依赖）。
4. **区分来源**：提示词里明确要求——论文里没有的就说没有，用常识要标「（背景知识）」。
5. **长文有代价**：默认只发选中的那一段；「整篇」是一次性的**显式发送范围**，且先压成索引再用。
6. **防误触发**：选区太短不发请求；同一段文字用缓存，不重复花钱。

---

## 四、不确定性与未验证项

- **知云文献翻译**：官方文档在语雀且纯 JS 渲染，抓取只拿到标题；其技术栈、全文对照、AI 能力、离线能力**均无法从一手来源证实**，表中已标 `?`。
- **小绿鲸 / ReadPaper / SciSpace / ChatPDF / Explainpaper / Elicit**：均为闭源 SaaS，无公开技术说明，技术栈未确认。其功能描述来自官方更新日志 / 关于页 / 定价页，**未做实际使用验证**。
- **Selection-Assistance 的 License 在仓库内自相矛盾**（根 `LICENSE` = Apache-2.0，README 与 `package.json` = MIT），以何者为准未确认。
- **小绿鲸「离线模式」的离线程**未确认（疑似仅指客户端可启动，翻译仍需联网）。
- 论文条目仅来自检索结果，**未逐篇精读**；上表的"与本项目的关系"是设计层面的推断，**不代表论文作者的主张**。
