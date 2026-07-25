# Kiro Agent 接入 codeg — 一次性重建规格 (REBUILD SPEC)

> **读者：执行重建的 AI，不是人类。** 本文是上一轮完整工程（14 commit / 483 turns / 3 轮 codex 异构评审 / 3 轮 sonnet reviewer）的全部结论蒸馏。上一轮的源码与 git 历史已因误操作永久丢失（见 `C-010`），只剩本规格。
>
> **执行契约**：本文所有「决策」段是**已定案**，不要重新论证；所有「死路」段是**已验证走不通**，不要再试；所有「锚点」是上一轮真实存在过的 file:line，**新基线行号会漂移，必须自己 grep 重新定位，但符号名和结构可信**。
>
> **基线**：`F:\codeg-research` @ `2b017446`（fork = `github.com/7iook/codeg`，upstream = `xintaofei/codeg`，codeg v0.21.8+）。上一轮基于 `692d6eb`(v0.21.6)，中途合并到 `c181c56b`(v0.21.8)。
>
> **目标产物**：Kiro CLI 作为 codeg 一等 agent，能对话、能被委派、会话可浏览、MCP 归口管理、模型/effort/授权模式可配。

---

## 0 · 执行顺序总览（按依赖，勿乱序）

```text
W0  基座          AgentType::Kiro + SystemBinary 分布类型 + registry + 编译强制 match 全补
     ↓ (其余全部依赖 W0，串行头)
W1  三路并行      P1 后端接线剩余 ∥ P2 KiroParser 会话解析 ∥ P3 前端登记
     ↓
W2  MCP + 门禁    三类型脱敏(Raw/QueryDto/Patch) + CAS 原子写 + McpAppType 前后端 + runtime_mode 门禁
     ↓
W3  增量功能      API key 免登录 → 模型/effort → 授权模式选择器
     ↓            (这三个上一轮是用户逐个提的，可一次做完)
W4  收尾          e2e 真二进制实测 + 死代码 grep + ADR + 变体扫
```

**每个 W 结束立刻 `git push`**（上一轮 14 commit 全在本地无远端 → 一次误删全损。这是硬要求，不是建议）。

---

## 1 · 已定案决策（勿重新论证）

| # | 决策 | 定案理由（上一轮已验证） |
|---|---|---|
| D1 | **新增 `SystemBinary` 分布类型**，不复用 `Binary`/`Npx` | Kiro 是系统装的二进制（`C:\Users\7\AppData\Local\Kiro-Cli\kiro-cli.exe`），不是 npm 包也不是 codeg 自己下载的 dir-tree。硬塞既有类型语义不清。评审 A6 曾质疑这是 Solution-Jumping，结论：保留但补业务分类说明 + version_prefix 与启动解耦 |
| D2 | **只做 CLI 会话格式**（`~/.kiro/sessions/cli/<uuid>.jsonl`） | IDE-v2 / IDE-legacy / workspace-session 三种格式明确 out-of-scope。只读浏览，**不做「恢复继续」** |
| D3 | **MCP 完整接管**（`~/.kiro/settings/mcp.json`）+ 专属面板 | 不走通用明文面板，见 §4 的数据损坏死路 |
| D4 | **委派/后台沿用既有泛型 `DelegationBroker`** | recon 已证 spawner 是泛型契约。评审 A5 要求「为 Kiro 重造委派状态机」→ **已驳回，是 over-engineering** |
| D5 | **单机单用户 fork 自用**，服务器/多租户 out-of-scope | 但 out-of-scope 标签 ≠ 代码禁用 → 落成 `runtime_mode` 可执行门禁（评审 R2-A1） |
| D6 | **API key 明文可见可编辑，不脱敏** | ⚠️ 这是上一轮**推翻自己**的决策，见 §5 绕圈记录 #3。MCP 第三方 token 的脱敏**保留**（那是别人的 secret，不同场景） |
| D7 | **模型/effort/授权模式 = 启动参数**，不做协议级实时切换 | 见 §4 死路 #1（`/model` 透传只回文本） |

---

## 2 · 必改点清单（含符号锚点，行号需自行 grep）

### W0 基座

```text
src-tauri/src/models/agent.rs
  AgentType 枚举 + Display          加 Kiro（上一轮基线 12 变体：ClaudeCode/Codex/
                                    OpenCode/Gemini/OpenClaw/Cline/Hermes/CodeBuddy/
                                    KimiCode/Pi/Grok/Cursor）
src-tauri/src/acp/registry.rs
  AgentDistribution                 新增 SystemBinary 变体
  AcpAgentMeta (AgentType::Kiro)    cmd="kiro-cli", args=["acp"]
                                    ⚠️ args 是 &'static [&'static str]，承载不了动态选择
src-tauri/src/acp/connection.rs
  build_agent                       SystemBinary 分支 + Kiro 显式守卫（动态 argv 收口点）
  detect_local_version              SystemBinary 分支：resolve 绝对路径 → --version
                                    → strip_version_prefix("kiro-cli-chat ") → 干净版本号
```

**编译强制 match**：上一轮 W0 补齐了 **15 处**穷尽 match。`cargo build` 会逐个报，跟着报错补即可。分布在 registry / connection / parser / mcp / conversations / experts / office_tools / import / agent_setting / models 共 11 个后端文件（W4 死代码检查时数到 **29 处生产 caller**）。

**Kiro parser 点**：W0 阶段用明确 `Err`/`unreachable!` 占位，**不要冒充既有 parser**（W1-P2 才实现）。

### W1-P2 · KiroParser（工作量最大，~1267 行 + 14 测试）

**真实格式（第一手实测，样本仍在）**：
```text
样本: C:\Users\7\.kiro\sessions\cli\d1af4710-c5cf-41ba-ac22-a451de3e07a1.jsonl  (13.4 MB)
     同名 .json (135 KB 元数据) + .history + .lock
     同目录另有 918 个会话可交叉验证

.jsonl 每行: {"version":"v1", "kind":"...", "data":{...}}
顶层 kind:  Prompt · AssistantMessage · ToolResults · Clear
data.content[] 内层 kind:
  text        文本
  toolUse     {toolUseId, name, input}
  toolResult  {toolUseId, content[], status}
  thinking    {text, signature, modelId}   ← 取 .data.text
  image

.json 元数据: session_id / cwd / created_at / title / session_created_reason
  session_state.conversation_metadata.user_turn_metadatas[]:
    metering_usage[]  {value, unit:"credit"}   ← credits 不是 token
    context_usage_percentage / end_timestamp / turn_duration
    total_request_count / builtin_tool_uses / message_ids[]
  rts_model_state.model_info.model_id
```

**反腐映射必做项（评审 A8 + reviewer I2 两轮才修透）**：
- `thinking` 对象取 `.data.text`
- `LIVE STEERING` 归 user
- **`Clear` 是轮边界，`Prompt` 也是轮边界** ← reviewer 两轮才抓透：只按 Clear 分段不够，同一 Clear 段内不同 Prompt 轮次仍会被全局 `relocate_orphaned_tool_results` 跨轮移动。toolResult 只允许同轮配对
- 未知 `kind` 保留占位（不丢弃）
- 尾部半行（最后一行无换行 = 正在写入）视为暂态，**不当非法行**
- 缺 `.json` 时列表项用**有界回退**（只读 `.jsonl` 头部 N 行推标题，不全扫）
- 资源预算：字节 + 事件数 + **5 秒 deadline**（reviewer I1：design 承诺了耗时上限，实现只有字节/事件上限）
- 区分「缺失 / 空 / 损坏」三态，不吞错（评审 F2）

**验收锚**：本机 list 出 ~875 个会话无崩溃，抽样 40 个 get 全 ok，中文标题 / model_id / turn 数正确。

### W1-P3 · 前端登记

```text
src/lib/types.ts                    AgentType union + 5 个 agent 集合点
                                    AGENT_LABELS / AGENT_COLORS Record
src/components/.../agent-icon.tsx   KiroColorIcon（紫罗兰 squircle + K）
                                    ⚠️ 只进 COLOR_ICONS，不建 MonoIcon（见 §4 死路 #4）
一致性测试                          删 kiro → 红，加回 → 绿（防后续漏登记）
```

### W2 · MCP 三类型脱敏 + 门禁

```text
src-tauri/src/commands/mcp.rs
  KiroMcpRaw       内部用，含明文 env，**不实现 Serialize**（类型层防越界）
  KiroMcpQueryDto  返前端，脱敏
  KiroMcpPatch     三态写（Set / Keep / Remove），Keep 保护未见明文
  read_kiro_config / write_kiro_config    CAS 原子写（基于内容 revision，非 mtime）
                                          ⚠️ 保留未知字段
  McpAppType       枚举加 Kiro（前后端同改，后端 11 处穷尽 match 无兜底）
src-tauri/src/runtime_mode.rs (新建)
  三入口前置门禁: read_servers / conversations / build_agent
  Tauri desktop 恒放行；非 loopback fail-closed
src/components/settings/kiro-mcp-panel.tsx (新建)
  read 脱敏展示 → 三态编辑 → CAS 写回冲突提示
  ⚠️ 必须有「新增 server」入口（reviewer C4：上一轮只能编辑/删除既有，空配置无法新增）
```

**⚠️ 安全旁路必堵全（reviewer C2 + 二轮 I3.5，共 5 个入口）**：Kiro 必须从**通用 MCP CRUD 全部入口**移除，不只是专属 command 加门禁。上一轮漏了又补：
```text
scan_local_servers / APP_OPTIONS     ← 首轮堵（读旁路）
upsert_server_for_app                ← reviewer C2 抓（写旁路）
remove_server_for_app                ← reviewer C2 抓
mcp_set_server_apps                  ← reviewer 二轮 I3.5 抓（会先删旧配置再因 Kiro 失败 → 非原子数据损失）
mcp_remove_server                    ← executor 全扫自己多抓的第 5 个
```
**测试设计防假门**：拿真实 Codex config 当「牺牲品」，证明不预先拒绝 Kiro 时切换操作会先删掉 Codex 配置（真捕获非原子，非恒绿测试）。

**脱敏证据测试（两个，必须有）**：
- `mcp_kiro_read_config_returns_redacted`：构造 `sk-super-secret` → 返回 JSON 不含明文
- `scan_local_does_not_leak_kiro_env`

### W3 · 三个增量功能

**① API key 免登录（`KIRO_API_KEY`）**

官方机制（已核实 + 本机实测）：`ksk_` 前缀，app.kiro.dev 网页创建，Pro/Pro+/Power 订阅。设了该 env → kiro-cli 完全跳过浏览器登录。实测 `kiro-cli acp` 握手 + `session/new` 成功，authMethods 为空。

```text
src-tauri/src/acp/connection.rs
  apply_kiro_env_policy (新增 ~14 行，镜像 apply_grok_env_policy)
    api_key 模式      → 注入 KIRO_API_KEY
    subscription 模式 → 清除继承的 stale key
    共享 server 模式  → SystemBinary 入口门禁短路，Kiro 不启动
存储: agent_setting.env_json (DB) —— 走既有通用 command acp_update_agent_env
```
**⚠️ 不要建 keyring 存储、不要建新 Tauri command。** 上一轮我的设计文档写了「走 keyring + 新 command」，executor 核实后驳回：Grok/Cursor 的 api_key 都存 `env_json`、走通用 command，存储/读取/门禁**零新增代码**。后端最终只改 1 个文件。

**② 认证优先级必须在 UI 显式告知（Kiro CLI 硬限制，不是我们的 bug）**
```text
1. 浏览器登录态 (kiro-cli login)  ← 最高，不可覆盖
2. KIRO_API_KEY 环境变量
3. 无凭证 → 提示登录
```
官方文档原话：「API key authentication supports all Kiro CLI features available in **non-interactive** mode. For interactive sessions, use browser-based sign-in instead.」

→ 用户选了 api_key 但实际走登录态时**必须显式警告**（否则表现为 `bearer token invalid`，用户完全无法理解）。跑 `kiro-cli whoami -f json` 解析实际生效认证 + 一键 logout 按钮（两段式确认）。

**whoami 解析实测坑**：输出是 JSON **后面紧跟裸文本 `Profile:` 块**，必须先切 `{...}` 再解析；`Profile` 的标签独占一行、值在下一行。

**③ 模型 + effort + 授权模式（全是启动参数，收口在一处）**

```text
env_json 键                值域                       → argv
KIRO_MODEL                19 个模型 id                --model <id>
KIRO_EFFORT               low/medium/high/xhigh/max   --effort <level>
KIRO_PERMISSION_MODE      ask / trust_all / trust_list
                          ask        → 不传 flag（默认，不改变现有行为）
                          trust_all  → --trust-all-tools
                          trust_list → --trust-tools <KIRO_TRUSTED_TOOLS>
KIRO_TRUSTED_TOOLS        逗号分隔工具名

收口点: kiro_launch_args()  argv 顺序 [--model] [--effort] [权限flag]
                            要有组合测试断言三者同配时顺序正确
模型列表: acp_kiro_list_models → kiro-cli chat --list-models -f json
          19 个模型带 rate_multiplier (0.05x~2.4x) + 上下文窗口
          ⚠️ 15s 硬超时 + 10 分钟缓存(只缓存成功) + 共享模式门禁
          ⚠️ 按钮触发，不自动拉 —— 见 §4 死路 #5
```

**fail-closed 语义（三处都要）**：
- effort 非法值 → 丢弃 + warn，不透传（值只在 spawn 时用，报错时机太晚，连接已死）
- 权限模式非法值 → 回落 `ask`（CLI 根本没「模式」参数，猜一个可能等于给了用户从未选过的全量授权）
- trust_list 名单清洗后为空 → 回落 `ask`，**绝不传空的 `--trust-tools`**
- **拒绝照抄 Grok 的模式名**（`bypassPermissions` / `acceptEdits`）：那是 Grok config.toml 的语义，Kiro 只有三态，硬套会让人以为有中间档。加测试断言这类值被拒

**前端提示文案**：模型/effort/权限都是启动参数 → 「保存后需**新建会话**才生效，运行中会话保持原配置」。

### W4 · 收尾

```text
e2e 真二进制         #[ignore] 集成测试直调 detect_local_version(Kiro)
                     验完整 SystemBinary 探测链（非 mock）
死代码 grep          git grep 'AgentType::Kiro' 排除 tests/ → 应有 ~29 处生产 caller
                     前端 KiroMcpPanel 在 mcp-settings.tsx 真实渲染
ADR                  SystemBinary 分布类型（design 定了 ADR needed=yes）
变体扫               AgentType 穷尽 match（cargo build 强制）+ 前端 McpAppType
tool_schema.json     加 "kiro" → 委派泛型立即生效（W1 可提前做）
```

---

## 3 · 项目级坑（影响每个 W，先读）

```text
① cargo fmt --all 会污染全仓        squash clone 从未 fmt 过，一跑重排 90 文件
                                    → 只手写规范格式，禁用 --all
② 后端验证命令                      cargo test --no-default-features --lib
                                    默认 cargo build 需要 ../out 前端产物（tauri_build 校验）
③ NODE_ENV=development 污染生产构建   mcphub 给子 shell 注入的进程级变量
                                    → pnpm build 前必须 Remove-Item Env:NODE_ENV
                                    否则 prerender /_global-error 报 useContext null
                                    （Next.js issue #86146 明确记载）
④ PORT=3799 冲突                    mcphub 设的，Next.js 会抢它 → EADDRINUSE
                                    → 启动 dev 前 $env:PORT='3000'
⑤ 浏览器访问 codeg 走 3080          Rust 后端(前端+API 同源)，从 out/ 读静态文件
                                    3000 是 Next dev server，只有前端没 API
⑥ chat_channel::webhook 测试 flaky   要发真实 HTTP，偶发失败，与本工程无关
⑦ Tailwind v4 自动扫描全项目         会扫到 .worktrees 等目录里的锁定文件 → Turbopack panic
                                    → globals.css 加 @source not 排除
```

---

## 4 · 已验证死路（不要再走）

**死路 #1 · `/model` slash 透传不能替代模型选择器**
用户曾提「直接支持原生 `/model` 就行」。实测：`/model` **确实透传成功**（Kiro 返回全部 19 个模型，箭头标当前选中），但**只是纯文本打印**。原生 TUI 的交互菜单在 ACP 下不存在——Kiro 没把模型暴露成协议级可选项（不像 Grok 把 effort 放进 `session/set_model` 的 `_meta`）。→ 只能走启动参数 + codeg 侧下拉（D7）。

**死路 #2 · MCP 通用面板返回脱敏占位符会损坏数据**
我曾提方案 A：`mcp_scan_local` 对 Kiro 返回脱敏占位。executor 驳回且**它对**：通用面板是双向编辑，用户保存会把占位符 replace 写回，**覆盖真 token**。→ 只能走方案 B：Kiro 从明文 scan/面板剥离 + 专属脱敏面板 + 三态 patch 的 Keep 语义。

**死路 #3 · 非 dir-tree 的 Binary agent 不该回退实时探测**
我曾问「是否所有 Binary agent 都该回退」，executor 核实后驳回：OpenCode 的启动路径本身 gate 在 `dir_entry` 上，给它报 PATH 版本会让列表显示「已安装」但连接时抛 `SdkNotInstalled`——**把一个 UX 不一致换成更糟的（点了才报错）**。

**死路 #4 · 不建 KiroMonoIcon**
图标入口 COLOR 优先命中即 return，同时进两个 map 会让 MonoIcon 成死代码。只进 COLOR_ICONS，与 kimi_code/pi 同类。

**死路 #5 · 模型列表不能自动拉**
实测：**未登录时 `kiro-cli chat --list-models` 挂在浏览器 auth portal 无限转**（20s 未退需 kill）。Cursor 模板是 auth ok 后自动 fetch，照抄会让每次打开设置页都可能卡 15 秒。→ 按钮触发 + 15s 硬超时。

**死路 #6 · 不改 `AgentDistribution` 枚举来支持动态 argv**
`SystemBinary.args` 是 `&'static [&'static str]`。动态化收在 `build_agent` 的 Kiro 分支一处（`agent_type == Kiro` 显式守卫），不改所有 agent 共享的枚举。只有 Kiro 一家需要，出现第二个再抽 trait。

**死路 #7 · 不回写 `installed_version` 到 DB**
该字段现有语义是「codeg 自己装时写的记录」，已有专责写入口。列表是高频只读路径，抢写会污染字段来源语义、破 SSOT。

---

## 5 · 绕圈记录（上一轮浪费的时间，直接跳过）

**#1 · 「列表说未安装、诊断说已安装」不是 Kiro 引入的**
上游既有 UX 缺陷：列表的 `installed_version` 取自 **DB**，诊断是**实时探针**。用户自己 npm 装的 Claude Code 在 DB 无记录 → 显示「未安装」。上游代码注释自己承认过这个现象。修法：DB 无版本时回退实时探测（Npx 9 个 + Uvx Hermes；Binary 保持只 dir-tree 回退见死路 #3）。性能三层：DB 命中零开销 / per-cmd 缓存含负结果 / `join_all` 并发（13 个命令名两两不同，per-cmd 缓存不构成上界，必须并发，否则 13 次串行 ~60s）。
**Kiro 走 SystemBinary 本来就是实时探测，是这个修复的参照标准。**

**#2 · `Session is active in another process (PID N)` 是误报**
那个 PID 是别的进程（实测是用户的 uvicorn）——Kiro 的 `.lock` 记了陈旧 PID，号被复用了。真因是积压的遗留 kiro-cli 进程 + 陈旧 lock 文件。→ 清进程即可，别去改代码。

**#3 · API key 脱敏是我的过度设计，最终被推翻（重建时直接按 D6 做，省一整轮）**
上一轮时序：reviewer 提「secret 不该进前端」→ 我做 C 方案脱敏（输入框恒空 + 只传布尔 `kiroApiKeyConfigured`）→ 用户困惑「key 不持久化 / 不知道在用哪个 key」→ 查证 key **其实落库了**，是脱敏让它看不见 → 用户明确「本地自用工具，不需要脱敏」→ 全部撤销改明文 WYSIWYG。
**根因**：把「secret 不该进前端」的一般性安全原则，套到一个**单机 fork 自用、根本没有前后端信任边界**的场景。
**重建时**：Kiro API key 一开始就明文（password input + 眼睛图标切换，照抄 Grok），语义「看到什么就是什么，空就是清空」，不要 Keep 兜底。MCP 第三方 token 的脱敏**保留**——那是别人的 secret，是真实信任边界。

**#4 · 评审器会把单机自用项目推成企业级（要批判性过筛）**
3 轮 codex 评审 P0 收敛：2 → 2 → 1。已驳回/收窄的：
```text
A5  为 Kiro 重造委派状态机        → 驳回（recon 证既有泛型契约）
A3  AgentDefinition 全仓重构      → deferred（只采纳其防遗漏 gate 建议）
R2-A1 完整多租户身份模型          → 收窄为 runtime_mode 断言
R2-A3 分布式 CAS                  → 收窄为内容 revision 比对
I3  可信安装位置硬拒              → 收窄为 temp/cwd fail-closed，标准安装目录放行
```
但**真 P0 别驳**：A2（MCP secret 脱敏）是真盲区（本机 mcp.json 实测确有 token 字段）、F1（幂等性质数学错误）、R3-A1（新旧契约双真源 = E-060）。

**#5 · E-060 双真源（改 spec 用追加不删旧正文）**
我在 design.md 加了新三类型契约，却没删旧 `read_kiro_servers() -> Vec` 描述 → 评审第 3 轮抓出新旧契约自相矛盾。**改正文要就地覆写，Update Log 只记指针。**

**#6 · executor 的纠偏比我的指令对（听它的）**
上一轮 executor 4 次驳回我的指令，**全部正确**：mcp-settings 消费 `McpAppType` 非 `AgentType`（拒绝越界改，避免 built-but-not-wired）/ 不建 MonoIcon / 脱敏占位符有数据损坏风险 / Binary 不该全回退。
反向：我也纠正过 executor 一次错判——它报告「`kiro-cli --version` 不存在」，实测**正常**（返回 `kiro-cli-chat 2.12.1` EXIT=0）。

---

## 6 · 验收基线（上一轮实际达到的数字，作为对照）

```text
后端 cargo test --no-default-features --lib
  W0 1590 → W1 1604 → W2 1616/1618 → reviewer修复 1628 → 二轮 1634
  合并上游 v0.21.8 后 1679 → 列表修复 1685 → 模型/effort 1691
  → whoami 1695 → 权限模式 1701
前端 pnpm test
  W1 2683 → 2699 → 合并上游 2752 → 2758 → 2765
tsc / clippy / cargo build   全程 EXIT=0
```

**真实验证过的（可复现）**：ACP 握手（返回 loadSession:true + mcpCapabilities.http:true）· 版本探测全链路（真 kiro-cli）· 会话解析 875 个真实会话抽样 40 全 ok · 脱敏（构造 secret 证不外泄）· API key 免登录（session/new 返真 sessionId）

**始终未验证的（重建时补）**：GUI 连通点验 · 委派 6 项生命周期运行时 · 真机「完全授权后不再弹授权」· 设置页打开耗时墙钟

---

## 7 · 重建时必须先读的既有机制（勿造轮子）

```text
需要「模型下拉」          → 抄 Cursor：CursorModelInfo / CursorModelsResult / parse_cursor_models
需要「effort UI 形态」    → 抄 Grok：GROK_EFFORT_OPTION_ID
需要「启动时传参」        → 抄 Grok：grok_launch_permission_mode() → build_agent
需要「api_key 存储」      → 抄 Grok/Cursor：agent_setting.env_json + acp_update_agent_env
需要「env 注入」          → 既有 build_session_runtime_env SSOT（覆盖 acp_connect/委派/探测三处 spawn）
                            + merge_agent_env
需要「委派」              → 既有 DelegationBroker（泛型，加 tool_schema.json 的 "kiro" 即生效）
                            depth_limit 默认 1
需要「后台任务追踪」      → 既有 background_watch.rs（tail JSONL transcript）
前端调用链               → api.ts (业务封装) → tauri.ts (invoke transport)
                            → lib.rs (handler 注册) → *.rs (#[tauri::command])
```

**codeg 对 Kiro 零提示词注入（本轮已核查，勿引入）**：`map_prompt_blocks` 是纯映射；expert 系统因 Kiro 无 `skill_storage_spec` 被 `supported_agents()` 过滤；`load_mcp_servers_for_agent` 对 Kiro 短路返空（防与原生 `~/.kiro/settings/mcp.json` 双重注册）；`codeg-mcp` companion 的四个开关（delegation/feedback/ask/sessions）默认全 false → `companion_features_arg` 返 None → 完全不注入。**保持这个性质。**

---

## 8 · 重建 checklist（AI 自查，逐项打勾）

```text
[ ] W0 前：git push 确认远端可达（origin=7iook/codeg）
[ ] W0：cargo build 报的每个 match 都补（约 15 处），Kiro parser 点用 Err 占位不冒充
[ ] W1-P2：Clear 和 Prompt 都是轮边界，toolResult 只同轮配对
[ ] W1-P2：5 秒 deadline + 字节/事件上限 + 尾部半行当暂态
[ ] W1-P2：本机真实会话 list 无崩溃 + 抽样 get 全 ok（非 mock）
[ ] W1-P3：一致性测试 red→green（删 kiro 真的红）
[ ] W2：5 个 MCP 入口全堵（scan/upsert/remove/set_apps/mcp_remove）
[ ] W2：KiroMcpRaw 不实现 Serialize
[ ] W2：kiro-mcp-panel 有「新增 server」入口（不只编辑既有）
[ ] W2：两个脱敏证据测试
[ ] W3：API key 明文 WYSIWYG（不脱敏），MCP token 脱敏保留
[ ] W3：认证优先级警告（选了 key 但实际走登录态时）
[ ] W3：三个 fail-closed（effort 丢弃 / 权限回落 ask / 空名单回落 ask）
[ ] W3：argv 顺序组合测试
[ ] W4：git grep 生产 caller ~29 处（排除 tests/）
[ ] W4：ADR + 变体扫 + tool_schema.json 含 "kiro"
[ ] 每个 W 结束 git push（不攒）
```
