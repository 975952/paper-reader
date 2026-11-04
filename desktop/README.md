# prt · Windows 桌面壳（Rust）

把原来「Node 服务 + 浏览器」的prt，做成**双击即用的单个 exe**：

* 自己的原生窗口（tao + wry / WebView2），不再开浏览器
* 前端资源（`../public/` 全部 271 个文件）用 `rust-embed` 编进 exe，运行时不依赖外部文件夹
* HTTP 接口用 Rust 重写（tiny_http），契约与 `../server.js` 逐条对齐
* **不需要 Node，不需要装任何运行时**（WebView2 运行时 Win10/11 一般自带）
* 面板管理器可以把六个面板打开成系统级独立窗口；窗口之间通过同源消息同步布局

---

## 1. 构建

```bat
cd desktop
build.bat
```

`build.bat` 做两件事：`cargo build --release` → 把产物复制到项目根目录
`..\prt.exe`。

也可以手动来：

```bat
cargo build --release
copy target\release\prt.exe "..\prt.exe"
```

依赖（首次构建需要联网拉 crates）：

| crate | 用途 |
| --- | --- |
| `wry` 0.55 + `tao` 0.35 | 窗口 + WebView2 |
| `tiny_http` 0.12 | 本地 HTTP 服务 |
| `ureq` 2（`native-tls`） | 转发 AI 请求；TLS 走 Windows 自带的 SChannel，避开 ring/NASM |
| `rust-embed` 8 | 把 `../public/` 打进 exe |
| `serde_json`（`float_roundtrip` + `preserve_order`） | 读写 data/ 下的 JSON，保证数值/键顺序零漂移 |

> 前端是**编译期内嵌**的：改完 `public/` 里的东西要重新 `build.bat` 才会生效。

## 2. 使用

双击 `prt.exe` 即可。窗口标题「prt」，初始 1400×900，可最大化；
窗口大小记在 `data/window.json`，下次打开还原。关掉窗口 = 退出进程。

命令行参数（可选）：

```
prt.exe                 正常启动（无控制台黑框）
prt.exe --console       挂上控制台并打印日志（调试用）
prt.exe --port 8899     从这个端口开始找（默认从 8787 开始，被占用就往后退）
prt.exe --help          看用法
```

> 如果你同时开着 Node 版（`node server.js`，占 8787），桌面版会自动用到 8788，
> 两个可以并存互不干扰。

### 目录约定（都相对于 exe 所在目录）

```
prt.exe
papers/          放 PDF（不存在会自动创建；/api/papers 只列这里的 .pdf）
data/config.json    设置（API Key 只存在这里，不回传前端）
data/state.json     阅读进度 / 上次打开的文件
data/notes-*.json   按文档存的高亮笔记
data/papers-order.json  左栏文件列表的手工排序（`{"order":["b.pdf","a.pdf"]}`；不改 papers/ 里的文件名）
data/window.json    窗口大小
data/webview2/      WebView2 的用户数据目录（浏览器缓存，删了会自动重建）
data/prt.log  运行日志（超过 512KB 就不再追加）
```

`papers/` 和 `data/` 里已有的东西（Node 版写下的置顶进度、笔记）**可以直接接着用**，
`docId` 算法与 server.js 完全一致，文件名对得上。

### 独立面板窗口

推荐：按住面板标题栏左侧的 `⠿` 抓手（整条标题栏余下区域同样可拖）拖离按下点超过 24px
再松手，面板即刻变成真正的系统窗口（拖动全程有跟随提示，超过阈值会高亮）；拖回按下点附近
再松手则放回原位、不生成窗口。浮窗拖到窗口边缘松手同样会转为系统窗口。右栏块标题栏上的
`⇅` 是上下换位用的，不参与拖出。面板开成独立窗口后主窗口里只是暂时收起，关闭子窗口
（或下次启动）会自动回到主窗口，不会再「关掉就没了」。

标题栏右侧是 VS Code 式的操作行（常显、悬停或键盘聚焦时变亮）：`⧉` 独立窗口、`⇱`/`⇲` 浮出与收回、
`✕` 隐藏。**不再有「一个按钮装下所有操作」**：顶栏的 `▤` 面板管理器和每块面板上的 `⋯` 都已移除，
固定 / 排序 / 换停靠区 / 显示所有面板等长尾操作改为**右键任意面板标题栏**打开面板管理器
（键盘 Shift+F10 同效）。关闭独立子窗口只关闭该面板窗口，面板会自动回到主窗口。

## 3. HTTP 接口

只监听 `127.0.0.1:<port>`，端口自动从 8787 起找空位。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/HEAD | `/`、`/<静态路径>` | 返回内嵌的 public/ 资源；MIME 按扩展名（`.mjs`/`.js` → `text/javascript; charset=utf-8`）。未知路径且无扩展名 → 回落 `index.html` |
| GET | `/api/health` | `{"ok":true,"port":<port>}` |
| GET | `/api/papers` | `{"folders":[{name,path,count}],"papers":[{name,folder,path,size,mtime,docId,url}],"dir":"<papers 绝对路径>"}`，递归列出 `papers/` 下的文件夹树；`folder` 为父路径（根=`""`）、`path` 为相对路径（`/` 分隔）；顺序 = `data/papers-order.json`（相对路径数组）里排过的按数组顺序，**没排过的排最前（mtime 倒序）**；旧纯文件名 order 数据兼容（视为根目录项） |
| POST | `/api/papers` | body `{"order":["a.pdf","ML/b.pdf"]}` 保存文件列表顺序（相对路径数组，只写 `data/papers-order.json`，不改文件名）；回 `{ok,count}` |
| DELETE | `/api/papers?path=<rel>` | 删除这篇 PDF（兼容旧 `?name=`，根目录直接命中，否则按 basename 全库回退），并把它从顺序文件里摘掉；文件不存在 404、非法名 400。**不删** `data/` 里按 docId 存的笔记 / 会话 / 进度 |
| POST | `/api/folders?name=<name>` | 根下新建文件夹（重名自动加 `(2)`，非法字符清洗）；回 `{ok,name,path}` |
| PATCH | `/api/folders` | body `{"from":"<rel>","to":"<新名>"}` 同级重命名文件夹（`to` 只允许名字、不带路径），order 前缀同步；回 `{ok,from,to}` |
| DELETE | `/api/folders?path=<rel>&mode=to-root\|recursive` | 删除文件夹。`to-root`（默认）：夹内 PDF 递归移到根再删空夹；`recursive`：连同 PDF 一起删（data/ 按 docId 的笔记/会话/进度保留）；回 `{ok,path,mode,moved}` |
| POST | `/api/move` | body `{"from":"<rel>","to":"<目标夹 rel 或空=根>"}` 移动 PDF 或文件夹；同名冲突自动加 `(2)`、同名同 size 去重、文件夹禁移入自身子孙；order 前缀同步；回 `{ok,from,to,name,moved}` |
| GET/HEAD | `/api/pdf?path=<rel>` | 支持 Range：`bytes=a-b`、`bytes=a-`、`bytes=-N`；206 + `Content-Range`，越界 416 + `bytes */<total>`，无 Range 200 + `Content-Length`；总是带 `Accept-Ranges: bytes`。兼容旧 `?name=`：根目录命中优先，否则按 basename 全库递归回退 |
| GET | `/api/config` | `{baseURL,apiKey:"",model,visionModel,targetLang,temperature,theme,fontSize,autoTranslate,stream,glossary,idleMs,hasApiKey}` —— **apiKey 永远回传空串** |
| POST | `/api/config` | 合并写入 `data/config.json`；body 里 apiKey 为空串/缺失时保留原 key，回 `{ok,hasApiKey}` |
| GET | `/api/state` | 原样返回 `data/state.json`（默认 `{}`） |
| POST | `/api/state` | 浅合并写回，回 `{ok:true}` |
| GET | `/api/notes?doc=<docId>` | `{"items":[...]}`（文件 `data/notes-<docIdOf(doc)>.json`，默认 `[]`） |
| POST | `/api/notes?doc=<docId>` | body `{"items":[...]}` 整体覆盖；items 不是数组就写 `[]`，回 `{ok:true}` |
| GET | `/api/session?doc=<docId>` | 读取当前论文的有界对话/AI 结果会话 |
| POST | `/api/session?doc=<docId>` | 原子保存当前论文会话；写盘失败返回 HTTP 500 |
| POST | `/api/chat` | AI 转发，见下 |

其它方法 → `405`；未知路由 → 走静态逻辑（无扩展名的会回落 `index.html`，和 Node 版一致）。
请求体上限 64MB。

### `/api/chat`

请求：`{messages:[...], model?, stream?, temperature?, max_tokens?, baseURL?, apiKey?}`；
`baseURL`/`apiKey` 缺省时取 `data/config.json`。

* 目标地址：baseURL 去掉尾部 `/`，已以 `/chat/completions` 结尾就直接用，否则拼 `/chat/completions`；
  非 `http(s)://` 开头 → 400。
* 转发头：`Authorization: Bearer <key>`（key 为空则不带）、`Content-Type: application/json`、
  `User-Agent: prt/1.0`。
* **流式**：上游来多少转发多少，响应 `Content-Type: text/event-stream; charset=utf-8`、
  `Cache-Control: no-cache, no-transform`、`Connection: keep-alive`，
  HTTP/1.1 下用 chunked 且**每个片段单独 flush**。
  上游非 2xx → 同状态码 + `{"error":{"message":"<上游 error.message>"}}`。
  连不上 → 502 + `{"error":{"message":"连接 <url> 失败：<原因>。请检查 API 地址 / 网络 / 代理。"}}`。
  `stream:false` → 上游响应体原样返回，`Content-Type: application/json; charset=utf-8`。
* **空闲超时**：`idleMs`（默认 60000）内收不到任何字节 → 给客户端补
  `data: {"error":{"message":"上游超过 N 秒没有返回数据"}}` 再结束。
* 客户端断开 → 停止读取上游、连接随之关闭（等于中止上游请求）。

## 4. 与 server.js 的差异（D1–D11 逐条）

> 第一阶段审计把 `server.js` 与 `desktop/src/` 逐条比过，**一共 11 处**响应契约差异。
> 每条都标了是否 **用户可见** —— 可见 = 界面上能直接看出不同（文案 / 条数 / 顺序 / 有没有链接）；
> 没标的只影响协议细节，正常使用看不出来。
>
> **2026-10-03（R10）已把 4 处「用户可见」差异全部对齐**（D5/D8/D9/D11），
> 并补了 6 个 Rust 单元测试锁死它们（`cargo test --release` → 9 passed）。
> 剩下 7 处都是「正常使用看不出来」的协议细节差异，**有意保留**（见每条说明）。
>
> **2026-10-06（参考文献标题猜测）**：用户报「找这篇的 PDF」返回一堆毫不相干的论文
> —— `V. Sindhwani, T. Sainath, and S. Kumar. Structured transforms …` 被猜成标题
> **`V`**，于是拿单个字母去 arXiv 检索。根因（按 `. ` 硬切 + 第一段没逗号/and 就当标题）
> 两边一模一样，所以 `server.js` 的 `guessTitle` 与这里的 `guess_title` **一起改**，
> 口径逐条对齐：缩写点不切段 → 跳过作者段 → 取第一段像标题的；认不出可检索的标题时
> 退回整条文献串；结果再按标题相关性过滤（`resultMatchesTitle` / `result_matches_title`，
> 响应多两个字段 `titleGuessed` / `dropped`）。
> 锁死方式：Rust 单测 5 组 + `test/refsearch.mjs`（隔离服务，标题猜测不依赖外网）。

1. **D1 · 额外响应头**（不可见）：tiny_http 会额外加 `Server: tiny-http (Rust)` 和 `Date`
   （Node 只加 `Date`）；静态/PDF 响应头与 Node 逐条一致。SSE 响应由本程序手写响应头，
   `Content-Type` / `Cache-Control` / `X-Accel-Buffering` 也与 Node 完全一致。
2. **D2 · 请求体超限**（不可见）：Node 走的是「读取失败 → `/api/chat` 400、其它接口 500」，
   这里是**所有接口统一** `413` + 中文错误信息「请求体过大（上限 64MB）」
   （`/api/upload` 单独放宽到 256MB）。只有请求体真的超过上限才撞得到。
3. **D3 · HTTP/1.0 客户端**（不可见）：不支持 chunked，改为 `Connection: close` 的自然结束
   （浏览器/curl 都是 HTTP/1.1，走不到这条路径）。
4. **D4 · 错误响应的 Content-Type**（不可见）：明确写成 `text/plain; charset=utf-8`（Node 版没有该头）。
5. ~~**D5 · `/api/chat` 的空闲超时**（用户可见）~~ → **R10 已对齐文案**：
   * 超时文案已改成与 Node 逐字一致：「上游超过 N 秒没有返回**任何**数据」。
   * **仍然保留的唯一差别**（不可见）：时长只读 `data/config.json` 里的 `idleMs`，不看请求体。
     Node 是 `payload.idleMs || stored.idleMs || 60000`。也就是说**前端如果把 `idleMs` 放进
     `/api/chat` 的 payload，在 exe 上会静默失效**（不报错、也不生效，仍用 stored 的值）。
     目前前端只在自己那边用 `idleMs` 做看门狗、没有把它发出去，所以看不出来 —— 但改前端时不要踩。
6. **D6 · `POST /api/session` 收到坏 JSON**（不可见）：Node 会 `JSON.parse` 抛到最外层兜底 →
   **500**；这里是 **400** + 「请求体解析失败: …」。前端只按 `!r.ok` 提示「会话保存失败」，
   两个状态码在界面上看到的一样。
7. **D7 · `upload` / `import-pdf` 的响应少了 `mtime`**（不可见）：Node 的 200 里带
   `mtime: st.mtimeMs`，这里只有 `name` / `size` / `docId` / `url`。
   前端上传完会 `refreshPaperList()` 重新拉一次 `/api/papers`（那份带 mtime），所以界面上看不出来；
   但按这份契约读 `mtime` 的客户端会拿到 `undefined`。
8. ~~**D8 · OpenAlex 结果的链接兜底**（用户可见）~~ → **R10 已对齐**：
   现在与 Node 一致 —— 有 `doi` 用 `doi`，没有就回落到 `primary_location.landing_page_url`。
   抽成了纯函数 `openalex_link()`，单测锁死（没 DOI 的条目在 exe 上不再「点不开」）。
9. ~~**D9 · 参考文献检索的源集合与打分**（用户可见）~~ → **R10 已对齐**：
   * 源补齐到 **4 个**（arXiv / OpenAlex / Crossref / **Semantic Scholar**）；
   * 打分补上 `doi.org` / `arxiv.org` 链接的 **+0.1**，抽成 `ref_score()` 并由单测锁死。
   * ⚠️ **未能联网实测**：Semantic Scholar 的公开接口在本机一直返回 **429（限流）**，
     而两个实现都是「失败就跳过」（Node 注释里也写了「经常 429，失败无所谓」），
     所以这一条目前只由**单元测试**保证，**没有**在真实响应上验证过。
     等哪天它不限流了，`/api/ref-search` 的 `results[].source` 里会出现 `Semantic Scholar`。
   * 副作用（预期内）：源变多后，同一条文献在 exe 上的**条数与排序会与 Node 更接近**，
     但两者仍是各自独立并发抓取，顺序不保证逐条相同。
10. **D10 · `/api/open-url` 的错误体**（基本不可见）：Node 的 400 是 `{"error":"缺少 url"}`
    （`error` 是**字符串**），这里是 `{"error":{"message":"…"}}`；
    另外系统浏览器打不开时这里回 `500`，Node 一律当成功回 200（失败被它自己吞掉）。
    前端只看 `r.ok`、失败提示「打不开系统浏览器，链接已复制到剪贴板」，
    所以只有「真的打不开浏览器」这一种情况在 exe 上会多一句提示。
11. ~~**D11 · 联网搜索的词元切分**（用户可见）~~ → **R10 已对齐**：
    词元现在**必须以字母开头**（等价于 Node 的 `/[a-z][a-z0-9+#._-]*/g`），
    纯数字 / 数字开头的串（`2017`、`3`）不再算词元 —— 相关度门槛与 Node 一致，
    不再出现「Node 判不相关丢掉、exe 却当成来源列出来」。
    单测覆盖：数字开头被拒、`gpt-4o`/`c++`/`a_b.c` 仍可用、中文二字组不受影响。

## 5. 自测工具（都在 `tools/`，只在验收时用）

```bat
node tools\make-test-pdf.js target\release\papers\sample.pdf   :: 造一个合法最小 PDF
node tools\mock-openai.js 8899                                :: 假 OpenAI 服务（SSE / 非流式 / 401 / 装死）
node tools\check-stream.js 8788 8899                          :: 验证 /api/chat 是不是真流式
```

`mock-openai.js` 的几种行为：正常 model 每 400ms 发一片；`model=boom` 回 401；
`model=stall` 发一片后装死（用来验证 idleMs）。

## 6. 排错

| 现象 | 处理 |
| --- | --- |
| 窗口白屏 | `prt.exe --console` 看日志；确认 `data/prt.log` 里有 `[window] 已加载` |
| 提示 WebView2 初始化失败 | 装一下 Microsoft Edge WebView2 Runtime（Win10 老版本可能没有） |
| 端口被占 | 正常现象，会自动往后找；`--console` 会打印实际端口 |
| 改了前端没生效 | 前端是内嵌的，重新跑 `build.bat` |
| 想看真实报错 | `data/prt.log`，或 `--console` 前台跑 |
