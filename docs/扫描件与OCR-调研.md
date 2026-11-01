# 扫描版 PDF 与图内文字识别：方案调研（2026-10 现状）

> 用途：为 [`问答与翻译-整体设计.md`](问答与翻译-整体设计.md) §4「扫描件识别与图片上下文」与
> §7「PDF 构成扫描与 OCR」提供选型依据。结论只影响实现顺序，不改变本机数据边界：
> 论文 PDF 不上传；只有用户主动触发的页图/截图会发给已配置的模型接口。

## 0. 结论先行

1. **首选 A：复用已配置的视觉模型做按需 OCR**（页分类 → 整页图 → 结构化 Markdown + LaTeX → 缓存）。
   通用 VLM 当前在 OCR 基准上已与专用管道打平（约 76 分，够「读懂」、不够「逐字引用」）；
   中文手写明显强于传统 OCR；零新依赖、与现有 chat 通道同源。
2. **降级顺序**：A（视觉模型）→ Windows 自带 OCR（Rust 壳，零体积，印刷体兜底）→ RapidOCR sidecar（用户手动下载，离线兜底）→ 「仅看图 + 提示配置视觉模型」。
3. **不要做**：把 MinerU / marker / PaddleOCR-VL 打进 exe（体积、许可、GPU 三重坑）；默认装 Tesseract（手写差、语言包大、收益低）。
4. **PDF 构成扫描**不需要渲染整页像素：`getTextContent()` + `getOperatorList()`（或 render 的 `recordImages` / `recordOperations`）约 10–30 ms/页即可完成页级分类。

## 1. 多模态大模型直接看图

**质量现状**（olmocr-bench，1,403 个 PDF、约 8,400 条断言，覆盖公式/表格/多栏/老扫描件）：

| 方案 | 分数 |
|---|---|
| Gemini Flash 3.5（通用 VLM） | 76.4 |
| marker balanced（专用管道） | 76.0 |
| MinerU pipeline | 72.7 |
| docling | 50.3 |

（来源：marker README 对比表，2026 年 marker 的 `--use_llm` 默认已经是 gemini-3.5-flash。）

含义：

- 通用 VLM 已能当「够用的 OCR」：**够读懂、够当问答上下文；逐字引用仍约 1/4 断言失败**，所以
  引用场景要标注「OCR 结果，可能有个别错字」。
- 专用小模型（[PaddleOCR-VL 0.9B](https://ernie.baidu.com/blog/posts/paddleocr-vl/)、
  [MinerU2.5 1.2B](https://arxiv.org/abs/2509.22186)）在 OmniDocBench 上反超 GPT-4o / Gemini-2.5-Pro /
  Qwen2.5-VL-72B——精度天花板在「小专用模型 + 两阶段」，但部署成本高。
- 手写：Mistral OCR 3 主打手写/潦草批注（宣称对前代与竞品 74% 胜率，[$2/千页、batch $1](https://korben.info/en/mistral-ocr-3-french-ocr-reads-handwriting.html)），
  中文手写仍会错字；公式常丢上下标、把 `\frac` 拉平。

**必须切片**：整页原图直送是精度杀手。MinerU2.5 的做法是「1036² 缩略图做版面/阅读顺序 → 原生分辨率按块 crop 识别」；
前端做不到版面分析时，用固定 2×2 / 3×2 切片近似即可。

**成本/延迟估算**（按 2026 主流视觉价位 $0.1–1/百万 token）：A4@150dpi 一页约 1–2k 视觉 token，
单页 ≈ ¥0.002–0.02；20 页论文 ≈ ¥0.05–0.4；单页延迟 1–5 s，串行整篇 30–90 s。

**对「整篇读懂」的适配**：整页图适合理解 + 问答（20 页 ≈ 3 万 token，长上下文吃得下），
不适合逐字引用/公式复刻。建议双通道：理解走整页图（3–5 页/批），引用与公式走 crop 精修。

## 2. 本地离线 OCR

| 引擎 | 体积 | 中文印刷 | 中文手写 | 公式 | 部署难度 |
|---|---|---|---|---|---|
| Windows.Media.Ocr | 0 | 中上 | 差 | 无 | 免安装；语言取决于系统 OCR 语言包；**Node 零依赖调不到 WinRT，只有 Rust 壳能零体积用** |
| Tesseract | 每语言 10–40 MB + dll | 中 | 差 | 无 | 需 dll + tessdata |
| RapidOCR / PP-OCRv5(ONNX) | 数十 MB（[rapidocr wheel 27.3 MB](https://pypi.org/project/rapidocr/)，Apache-2.0） | 强（印刷中文约 0.90） | 弱（手写中文 0.42–0.58） | 无 | 需 onnxruntime，CPU 约 1.4 s/图 |
| PaddleOCR-VL / MinerU2.5 / marker / Docling | 数百 MB–数 GB | 最强 | 较好 | 有 LaTeX | Python + 深度学习运行时；体积/许可/GPU 都不适合绿色 exe |

**能否嵌进「零依赖绿色 exe」**：PaddleOCR-VL / MinerU / marker / Docling 全部不行（Python 运行时 +
数百 MB 权重 + 许可要评估：marker 代码 Apache-2.0 但权重 OpenRAIL-M；MinerU 为 AGPL 系）。
现实做法只有「可选外部引擎 sidecar」或「用户自装后填 URL」。Tesseract 能嵌但收益低。

## 3. 云 OCR

- **Mistral OCR 3**：$2/千页、batch $1，手写最强，直接输出结构化 Markdown/HTML（含合并单元格），对论文表格友好。
- **Azure Document Intelligence Read**：$1–2/千页量级（以官网为准），中英混排强，需 Azure 订阅、国内需代理。
- **百度/腾讯/阿里**：约 ¥0.01–0.05/次、有免费额度，中文印刷体强、手写一般、公式弱；需实名 + 密钥。
- 合规：境外 OCR 涉及内容出境；论文类非敏感内容影响不大，但要给用户「仅本地」开关。

## 4. 与现有视觉模型配置的复用度

**已配视觉模型 → 直接拿它做 OCR 最省事**：同 key、同 base_url、同流式通道，新增代码只有
「canvas 渲染 → 切片 → prompt → 缓存」。**未配/失败 → 降级**：Windows OCR（Rust 壳）→
RapidOCR sidecar（用户手动下载）→ 明确提示「该页为扫描件，仅可看图，请配置视觉模型」。

## 5. PDF 构成扫描（打开时判页型）

- **`getTextContent()`**：`items[].str / width / height / transform / fontName` → 字符数、字框覆盖率、平均字号；
  用 `(cid:` / 私用区 / 替换符占比识别「假文本层」（扫描件经过低质 OCR 后留下的乱码）。零渲染成本。
- **`getOperatorList()`**：返回 `{fnArray, argsArray}`，数 `paintImageXObject / paintJpegXObject / paintInlineImage`
  估图像数量，结合 `setTransform` 的 CTM 与图像原始尺寸估覆盖面积；数 showText / fillText 判文字量；
  shading / pattern 判矢量块。
- **更省事的官方能力**：PDF.js render 参数已支持 `recordImages`（记录图像位置）与 `recordOperations`
  （记录每个操作的依赖与包围盒），一次低分辨率渲染即可拿到图像/矢量覆盖，不必自己解析算子表。
- **阈值经验（工程建议，实施时用真实书架校准）**：
  - 字符 < 40 且图像覆盖 > 60% → 扫描页；
  - 字符 > 200 且图像 < 15% → 纯文本页；
  - 图像 > 30% 且字符 < 300 → 插图/表格页；
  - 有字符但 cid 占比 > 30% → 假文本层，照走 OCR。
- **公式区域**：PDF.js 无语义，只能靠字体名（CMMI/MSAM/Symbol）、基线异常、矢量笔画密度粗筛，
  误报高——**不要在前端硬做公式检测**，交给模型在 prompt 里「公式用 $$LaTeX$$ 输出」。
- **是否要渲染整页像素**：分类不需要；只有「到底要不要 OCR 这一页」的二次确认（空白页、纯图页、
  墨迹覆盖率）才用 200dpi 灰度缩略图；整页彩色渲染只在真正送模型/OCR 时做（50–150 ms）。

## 6. 同类产品怎么做（以及局限）

- **Zotero**：内置阅读器**没有 OCR**。正规解法是外部工具把 OCR 结果写成文本层（Zotero OCR 插件 /
  Acrobat / ABBYY / OCRmyPDF），Zotero 只负责索引文本层。局限：OCR 文本没有字形几何，
  **不能按字高亮、框选取词失效**（[zoteus OCR 文档](https://github.com/oscardvs/zoteus/blob/main/docs/ocr.md)、
  [zotero-ocr 插件](https://github.com/UB-Mannheim/zotero-ocr)）。
- **Acrobat「识别文本」**：桌面端离线，把隐藏文本层写回 PDF，只给词框，不做版面结构与 LaTeX；
  中文需语言包；手写公式基本无解（[Adobe 帮助](https://helpx.adobe.com/acrobat/desktop/create-documents/scan-documents-to-pdfs/recognize-text.html)）。
- **Sioyek**：轻量键盘阅读器，无内建 OCR，扫描件只能看图。
- **MarginNote**：框选式 OCR + 摘录，偏交互，不做整篇解析。
- **Readpaper / Scholarcy**：云端解析，依赖文本层，扫描件质量差甚至直接失败。
- 共同点：桌面阅读器几乎都不做「本地整篇 OCR」，要么「补文本层」要么「上云」。
  **差异化空间**：用已配置的视觉模型做「按需局部 OCR + 结果缓存」。

## 7. 候选方案对比

| 方案 | 工作量 | 体积 | 离线 | 中文手写 | 对现有架构侵入度 |
|---|---|---|---|---|---|
| **A. 视觉模型按需 OCR**（页分类 + 切片 + 缓存） | 3–5 人日 | 0 | 否 | ★★★☆ | 低（复用 chat 通道，纯前端 + 缓存目录） |
| **B. Windows OCR + 可选 RapidOCR sidecar** | 6–9 人日 | 0 / +30–60 MB | 是 | ★☆ | 中（Rust 壳加 WinRT、下载器、ONNX 运行时两套实现） |
| **C. 外挂文档解析引擎**（MinerU / marker / PaddleOCR-VL） | 10–15 人日 | 数百 MB–GB | 是（需 GPU 才快） | ★★★★ | 高（进程/端口/GPU、许可、安装包策略） |

## 8. 对本项目的推荐实施

1. **第一阶段（跟随整体设计 P1）**：打开时用 text + operator list 做页分类（零成本）；扫描页渲染整页图给
   Q&A / 教学使用；只需「页级分类」，不做公式/文字区域的精确 bbox（当前 UI 没有需要它的交互）。
2. **第二阶段（P3）**：视觉模型 OCR → 缓存 `data/ocr-<docKey>.json`（按页存、带文件指纹），
   让扫描件也能全文搜索与基于文本的问答；「重新识别本页」按钮；标注「OCR 结果，可能有个别错字」。
3. **降级**：Windows OCR（Rust 壳，零体积）仅作为「未配置视觉模型」时的兜底，不做手写承诺。
4. **工程参数**：150–200 dpi、JPEG q80、单页 ≤ 2 MP；>15 页的论文先 OCR 前 3 页判定语种/质量再决定是否全篇；
   失败重试 1 次即降级；prompt 固定「只输出 Markdown，公式用 $$...$$，不要解释」。
5. **不要**：把 MinerU / marker / PaddleOCR-VL 打进 exe；默认装 Tesseract。

## 9. 来源

- MinerU2.5：<https://arxiv.org/abs/2509.22186>
- PaddleOCR-VL：<https://ernie.baidu.com/blog/posts/paddleocr-vl/>
- marker（含 olmocr-bench 对比）：<https://github.com/datalab-to/marker>
- PP-OCRv5 官方文档：<http://www.paddleocr.ai/v3.0.3/en/version3.x/algorithm/PP-OCRv5/PP-OCRv5.html>
- RapidOCR：<https://pypi.org/project/rapidocr/>
- Windows.Media.Ocr：<https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine>
- PDF.js API：<https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html>
- Zotero OCR 生态：<https://github.com/UB-Mannheim/zotero-ocr> / <https://github.com/oscardvs/zoteus/blob/main/docs/ocr.md>
- Adobe「识别文本」：<https://helpx.adobe.com/acrobat/desktop/create-documents/scan-documents-to-pdfs/recognize-text.html>
- Azure Document Intelligence 定价：<https://azure.microsoft.com/en-us/pricing/details/document-intelligence/>
- Mistral OCR 3 报道：<https://korben.info/en/mistral-ocr-3-french-ocr-reads-handwriting.html>

## 10. 落地记录（2026-11-01）

已按首选方案 A 落地第一版，实现位置与结论一致的部分：

- **页型判定**：`PdfViewer.scanDocProfile()` 用 `getTextContent()` + `getOperatorList()` 逐页统计
  文本字符数 / 图片覆盖面积（按 CTM 的行列式估算）/ 矢量操作数，页级分类 text / scan / figure / blank；
  结果按 docId+size+mtime 缓存在 localStorage。与本文 §5 的阈值建议一致。
- **视觉模型 OCR**：`runOcrDoc()` 逐页渲染页图（`capturePageImage`，长边 1800）→ 视觉模型转写
  （固定 prompt：只输出 Markdown、公式 `$$...$$`、看不清写「[看不清]」）→ 按页缓存
  （localStorage `reader.ocr.v1:*`，逐页落盘、可中断续跑）。
  完成后的问答 / 教学优先用 OCR 文字，不再发页图；结果进右栏「文字版（OCR）」条目。
- **没有做的部分**：Windows.Media.Ocr 本地降级、RapidOCR sidecar、针对 OCR 文字的全文搜索 / 逐字高亮。
  其中 Windows OCR 需要 Rust 侧 WinRT 调用（零体积但手写弱），等有「未配视觉模型」的真实需求再做。
- **工程参数**：页图长边 1800 / JPEG、单页 ≤ 12000 字截断、一次最多 80 页、单页失败跳过继续、
  提示模型 OCR 可能有错字。实测 3 页扫描件生成 + 缓存命中 + 问答切换在隔离测试里全绿（`test/ocr.mjs` 14/14）。
