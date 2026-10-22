
## 项目简介

论文阅读器：本地 PDF 阅读器 + AI 辅助（划词翻译/解释、整篇论文问答、联网搜索、
论文操作目录、文献关系整理、公式与表格渲染）。
- 前端：`public/`（零依赖原生 ES module，无打包）
- 后端两套：`server.js`（Node，零依赖）与 `desktop/`（Rust：wry + tao + tiny_http + ureq + rust-embed）
- 交付物：`论文阅读器.exe`（单文件绿色版，免安装；`papers/` 与 `data/` 相对 exe 所在目录解析）
- 构建：`desktop\build.bat`
- 测试：`cd test && node <套件>.mjs`（先 `node desktop.mjs` 起服务）

## 阅读代码时的背景知识

1. **`data/` 里是用户填的 API Key** —— 只读，别动。
2. **`.bat` 必须纯 ASCII**：cmd 按 OEM 代码页解析，中文注释会让后续命令被吞。
3. **前端是 rust-embed 编译期内嵌进 exe 的**：改了 `public/` 不重新编译就不生效，
   而且**新增文件不会触发重编译**。
4. **`data/`、`papers/` 不进入 zip 或 git**：`.gitignore` 与 `test/pack.mjs` 已有拒绝清单。
5. **测试断言不要写死用户的书架内容**：用户随时可能导入新论文。
6. **不要用 PowerShell 改源码内容**：`Set-Content` / `Out-File` / `>` 在中文 Windows 上
   默认按 ANSI(936) 解析再写回，会把整个文件的 UTF-8 中文变成乱码
   （踩过一次：`public/js/app.js` 全文乱码）。改文件用编辑工具；必须用脚本时显式指定编码：
   `[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`。
7. **大改动之前先备份**：仓库**有 git**（`origin = https://github.com/975952/paper-reader.git`，
   交付物 `.exe` 被 `.gitignore` 排除，改动只在源码里），所以正确的做法是
   **改之前先 `git commit` 一次**，改坏了 `git checkout` 就能回退；
   `test/pack.mjs` 打的源码 zip 是第二道保险（2026-10-06 修好了它漏掉 `security.js` 的白名单）。
   注意 `data/`、`papers/` 永远不进 git，也不要进 zip。
8. **本机专属资料永远不进仓库**（`.gitignore` 已挡，2026-10-22 整理时还从**全部 git 历史**里抹掉了）：
   `docs/internal/`（VPS/SSH/代理等私人资料）、`tools/internal/`（DSH 等工具内部脚本）、
   仓库根的 `archive/`（旧 Android 壳）、`brightness-research-report.md`。
   `docs/` 只留长期文档（PROGRESS / 使用说明书 / 触摸屏缩放丝滑化），历史过程文档在
   `docs/archive/`，分类见 `docs/README.md`。**不要 `git add -A` 一把梭**——历史上就是这么把内部资料带进仓库的。
