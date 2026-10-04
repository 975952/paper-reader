# 与 Codex 互调（PowerShell / Codex 都能用）

> 建这个的原因：DSH 是 Electron GUI 应用（`DeepSeek Harness.exe`，233MB，**没有 headless / CLI 入口**），
> 而我是跑在 DSH 会话里的智能体 —— **只在「你发消息 / 会话被恢复」时执行**，没有任何端口在等我。
> 所以 Codex 不能直接 RPC 调用我，中间必须有个**双方都够得着的信箱**。
> 本目录两个脚本就是这个信箱与反向调用器，两个方向都**已实测跑通**。

---

## 一、Codex → 我（两个方式，任选）

### 方式 A：HTTP 信箱（Codex 能直接 curl，实测通过）

```powershell
# 1) 起信箱（要保持这个进程开着）
node tools/bridge.mjs serve          # 默认 127.0.0.1:8899
#    端口被占：$env:BRIDGE_PORT='8901'; node tools/bridge.mjs serve

# 2) Codex 侧投任务（Codex 自己也能执行这条）
curl.exe -s -X POST http://127.0.0.1:8899/task -H "Content-Type: application/json" --data-binary "{\"prompt\":\"帮我把 X 修了\",\"from\":\"codex\"}"

# 3) 我侧取任务（我每次运行时先跑这个）
node tools/bridge.mjs fetch          # 取出并清空，打印 JSON

# 4) 我回写结果，Codex 再取
node tools/bridge.mjs reply <id> "结果文本"
curl.exe -s http://127.0.0.1:8899/result/<id>
```

**实测证据**：Codex 执行 `curl POST /task` 返回 `{"ok":true,"id":"tmutpfk124edi"}`，
我这边 `node tools/bridge.mjs status` 立刻看到 `pending:1`，`fetch` 取到该任务。

### 方式 B：纯文件信箱（不用起服务，最不容易坏）

```powershell
node tools/bridge.mjs post "任务内容"     # 谁都能投
node tools/bridge.mjs fetch               # 我取出并清空
node tools/bridge.mjs status              # 看队列
```

信箱文件：`test/artifacts/bridge/mailbox.jsonl`（投递）与 `results.jsonl`（回执/追溯）。

---

## 二、我 → Codex（一条命令，实测通过）

```powershell
node tools/codex.mjs "你的问题"                        # 默认走 deepseek profile
node tools/codex.mjs --full-auto "允许它改文件跑命令"
node tools/codex.mjs --model gpt-5.1-codex "换模型"
node tools/codex.mjs --prompt-file "$env:TEMP\p.txt"   # 长提示词/中文，推荐
```

**实测**：`node tools/codex.mjs --prompt-file ...` → 退出码 0，拿回 Codex 的回答（"你好，很高兴见到你。"）。

### 这台机器上调 Codex 的两个坑（都已绕过，别重踩）

| 坑 | 现象 | 处理 |
|---|---|---|
| **默认模型不被套餐支持** | `config.toml` 里 `model = "gpt-6.1-sol"` → 400 `model is not supported when using Codex with a ChatGPT account`；`gpt-5.1-codex` 同样 400 | **用 `-p deepseek`**（走 `api.deepseek.com`）：`tools/codex.mjs` 已默认加上 |
| **`-p` 的位置** | 写成 `codex exec ... -p deepseek` → `系统找不到指定的文件 (os error 2)` | `-p` 是**顶层参数**，必须放在 `exec` **前面** |
| **提示词别走命令行** | PowerShell 下 `& codex exec "中文提示"` 会让 Codex 报 "Reading additional input from stdin..." 然后卡住 | 提示词写进文件、用 **stdin** 传（`tools/codex.mjs` 已这么做） |
| **`models_cache.json` 报错** | `failed to load models cache: missing field base_instructions`（非致命告警，Codex 仍能跑） | 已备份并重建过一次；`~/.codex/models.json` 是 `deepseek.config.toml` 的 `model_catalog_json` 指向的文件，**不要删** |

---

## 三、安全提醒

`~/.codex/config.toml` 里 `[model_providers.deepseek]` 段有**明文 API Key**：

```
experimental_bearer_token = "sk-..."   ← 明文存在磁盘上
```

这是你自己配置的，我没动。但如果你之后要把 `~/.codex` 备份或分享，记得先把它换成环境变量引用
（`env_key = "DEEPSEEK_API_KEY"`）。同理，本仓库的 `data/config.json` 也含明文密钥 ——
它已在 `.gitignore` 里，**从未上传**。
