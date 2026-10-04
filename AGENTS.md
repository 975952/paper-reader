
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
7. **大改动之前先备份**：仓库没有 git。改 `public/` 之前至少要有一份可回退的整目录副本
   （`test/pack.mjs` 打的源码 zip、或直接复制 `public/`），否则改坏了没法回退。
