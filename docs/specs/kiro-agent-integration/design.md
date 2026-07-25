---
slug: kiro-agent-integration
title: Kiro CLI 作为 ACP agent 接入 codeg · 设计
status: converged
review_rounds_done: 3
last_review_status: NEEDS_CHANGES
last_review_p0: 0
created: 2026-07-26
last_updated: 2026-07-25
shipped_commit: null
related_adrs: [ADR-0001]
related_specs: []
supersedes: []
superseded_by: null
rca: null
tags: [acp, agent-integration, kiro, mcp]
domain: agent-runtime
one_line: 新增 SystemBinary 分布类型接入系统安装的 kiro-cli，复用 Cursor/Grok 的既有模式完成注册、会话解析、MCP 接管与启动参数注入。
---

# Design · Kiro CLI 接入 codeg

## Current-State Inventory

> ⚠️ **2026-07-26 更新**：仓库已 rebase 到上游 `e540a4fa`（v0.21.9），**下表所有行号已漂移**。
> 按符号名定位。已完成的实现与被实测推翻的条目见
> `.agent-workspace/.archive/2026-07-26/kiro-agent/kiro-integration-execution-log.md`。
> 其中两个要点：后端测试基线已变**全绿**（上游 `df5ee401` 修掉那 8 项）；
> distribution 的编译强制点实测是 **17 处**，不是 9 处。

基线 `feat/kiro-agent` @ `00bc59bc`，代码内容 == 上游 `2b017446`，**仓内零 Kiro 实现代码**。
行号取自 `.agent-workspace/.archive/2026-07-25/kiro-agent/kiro-agent-recon.md` 的实测结果。

### ✅ 存在且可直接复用

| 能力 | 位置 | 复用方式 |
|---|---|---|
| agent 枚举 | `models/agent.rs` `enum AgentType` + `impl Display` | 加变体 |
| 分布类型 | `src-tauri/src/acp/registry.rs:4` (Npx/Binary/Uvx) | 加第四变体 |
| 元数据表 | `registry.rs:189 get_agent_meta`（Cursor arm `:452`） | 加 arm |
| 进程启动 | `acp/connection.rs:389 build_agent`（`:397` 分布 match） | 加分支 |
| **动态 argv 范本** | `connection.rs:576-591` Cursor 的 `cmd_args.insert(0, ...)` | **照抄**（`args` 是 `&'static`，动态参数只能在分支内构造） |
| env 注入范本 | `connection.rs:118 apply_grok_env_policy` | 同构实现 |
| PATH 解析 | `resolve_system_agent_binary`（`connection.rs:551` 处被 `dir_entry` gate 住） | 直接调用，不再 gate |
| MCP 转发跳过 | `connection.rs:2099-2104` `matches!(Hermes\|KimiCode\|Grok\|Cursor)` | 加 Kiro |
| per-agent MCP 读写 | `commands/mcp.rs`：`:2480/:2484/:2536` KimiCode、`:3007/:3015/:3019` Cursor | 同构三件套 |
| 凭据存储 | `agent_setting.env_json` + `acp_update_agent_env` | 直接用，零新增存储 |
| parser 目录 | `src-tauri/src/parsers/*.rs`（12 个 agent 各一） | 新增 `kiro.rs` |
| i18n 门禁 | `src/i18n/messages.test.ts` en↔9 locale 全 key 双向 diff | 唯一自带守卫的登记点 |

### ❌ 不存在（须新建）

| 项 | 位置 | 说明 |
|---|---|---|
| `AgentDistribution::SystemBinary` | `registry.rs:4` | 触发 9 处编译错误，见下表 |
| `parsers/kiro.rs` | 新文件 | 零冲突 |
| Kiro MCP 读写函数族 | `commands/mcp.rs` | `kiro_mcp_json_path` / `read_kiro_servers` / `read_kiro_servers_at` / `upsert_kiro_server` / `remove_kiro_server` |
| MCP 写入门禁 | `commands/mcp.rs` 函数族层 | 桌面 + HTTP 共用 |
| 自定义 agent 扫描 | 新 command | 扫 `~/.kiro/agents/*.json` |
| Kiro 配置面板 | `src/components/settings/acp-agent-settings.tsx` | 挂载点 `:9887` 的三元链 |

### ⚠️ 形状与旧规格不同

| 项 | 旧规格记载 | 实测 |
|---|---|---|
| Kiro CLI 版本 | 2.12.1 | **2.14.2**（`--version` 前缀 `kiro-cli-chat ` 仍成立） |
| `acp` flags | 缺 `--agent` / `--agent-engine` | 实有 `--agent` / `--agent-engine`(v1\|v2\|v3)，前者直指自定义 agent 层 |
| 会话顶层 kind | 4 种 | **5 种**，多 `Compaction`（`{summary, strategy, messages_snapshot}`，非轮边界） |
| MCP 配置文件 | 单一 `settings/mcp.json` | **三层合并**（官方文档核实）：`Agent > Project(.kiro/settings/mcp.json) > Global(~/.kiro/settings/mcp.json)`，**同名才覆盖、不同名叠加**。字段现名 `includeMcpJson`（boolean），`useLegacyMcpJson` 是上游 Amazon Q CLI 旧名（本机 6 个 agent 定义仍写旧名 → 当前版本可能忽略）。另有 `KIRO_HOME` 可重定向整个 `~/.kiro` |
| 工具禁用粒度 | 未提及 | server 级 `disabledTools` / `disabled`；agent 级 `tools` 白名单 / `allowedTools` 免确认 / `toolsSettings`（如 `write.allowedPaths`） |
| secret 载体 | 仅 `env` | `args` 数组同样承载（本机 `ace-local` 的 `--token`） |
| 后端测试基线 | 1590 全绿 | 上游 `df5ee401`（v0.21.9）修掉了 Windows `/tmp` fixture 问题，**现基线全绿 1673 passed / EXIT=0**（中间版本曾是 1648+8 failed）。新测试复用它引入的 `absolute_path()` helper |
| `chat_channel::webhook` flaky | 已知噪声 | **不存在该测试模块**，1648 个测试零 chat_channel 失败 → 不列为已知噪声 |
| Tailwind `@source not` | 已修 | `git grep "@source" -- src/` **零命中**，修复可能随丢失的 14 commit 一起没了 → 待验证风险 |
| `tools/git-pre-commit.ps1` | 存在 | **本仓不存在**，`core.hooksPath` 为空 |

## Corrected Goal（draft-vs-reality）

| 旧规格决策 | 裁决 | 依据 |
|---|---|---|
| D1 新增 `SystemBinary` | **保留**，理由更硬 | 复用 `Binary` 需伪造 `platforms` 假 URL → 安装按钮下载不存在的 URL；复用 `Uvx.system_cmd` → 装了 `uv` 的机器走 `uvx --from <假包>` 主路径必失败 + `detect_local_version` 查 uvx 缓存恒显示未安装。两者都是可复现故障，非「语义不清」 |
| D2 只做 CLI 会话格式 | **保留**，路径逐字正确 | `sessions/cli/` 921 会话、最新写入 2026-07-26；IDE 格式是另一套，out-of-scope |
| D3 MCP 接管 | **保留**，语义已按官方文档修正为三层合并 | 见上表；写入目标定为 Global，Agent/Project 作用域只读展示 |
| D4 委派沿用泛型 broker | **保留**（未复核 broker 泛型性，前端 `delegation-agent-defaults.tsx:66` 需登记） | |
| D5 `runtime_mode.rs` 新建门禁 | **降级**为 `commands/mcp.rs` 函数族层门禁 | HTTP 侧 `web/handlers/mcp.rs` 是第二入口；一处生效覆盖两入口，代价远小于新建门禁文件。用户裁决：需支持局域网 → 门禁做成可配开关，默认拒绝非桌面入口 |
| D6 API key 明文不脱敏 | **保留** | 用户明确：本地自用工具，无脱敏需求 |
| D7 模型/effort/权限 = 启动参数 | **保留并扩展** | 增加自定义 agent 维度（`--agent`），用户裁决要能选 |
| §W3 whoami 解析 + logout | **降级为一行提示文案** | `kiro-cli` 子命令输出与 stderr 日志混排，解析其自由文本是脆弱依赖 |

## 架构

### SystemBinary 的 9 处编译强制落点

新增变体后 `cargo build` 逐个报错，**零静默漏项**——这是选 A 方案的核心安全性论据。

| 位置 | 函数 | Kiro arm 应做什么 |
|---|---|---|
| `registry.rs:98` | `registry_version()` | 返 `None`（版本由系统安装决定，codeg 不 pin） |
| `connection.rs:397` | `build_agent` | PATH 解析 `kiro-cli` → argv = `["acp", ...动态参数]` |
| `acp/preflight.rs:60` | `run_preflight` | 仅检查 PATH 可解析 |
| `commands/acp.rs:467` | `verify_agent_installed` | 同上（连接闸门） |
| `commands/acp.rs:589` | `detect_local_version` | 跑 `kiro-cli --version` 并剥前缀 |
| `commands/acp.rs:865` | `build_agent_diag` | distribution 字符串 = `"system-binary"` |
| `commands/acp.rs:1245` | `launch_label` | 「系统安装」 |
| `commands/acp.rs:7891` | `(available, installed_version)` | 复用 detect |
| `commands/acp.rs:7967` | `(available, dist_type, local_installed_version)` | 同上 |

### 注册点：编译强制 vs 静默降级

**编译强制**（不改则 build 失败）：`models/agent.rs:6` 枚举 + `:23` Display、
`registry.rs:163 registry_id_for`、`:189 get_agent_meta`、
`acp/file_system_runtime.rs` `agent_data_roots`、`commands/conversations.rs:280` + `:938` parser 分派、
`db/service/import_service.rs:25` **定长数组 `[AgentType; 12]` → 13**、`:41 build_parser`、
`commands/mcp.rs:2443 read_servers_for_agent_type`；若把 Kiro 加入 `McpAppType`（`mcp.rs:50`，
11 变体）则连带 `:2427 upsert_server_for_app` + `:3365 remove_server_for_app`；
前端 `src/lib/types.ts:887 AGENT_LABELS` + `:902 AGENT_COLORS`（`Record<AgentType,_>` → tsc 强制）。

**静默降级**（不改也能编译，风险更高——旧规格完全未提）：

| 位置 | 漏改后果 |
|---|---|
| `registry.rs:131 all_acp_agents()` 手写 `vec![]` | **Kiro 完全不出现在任何列表，零报错**（最致命） |
| `db/service/agent_setting_service.rs:28 default_enabled()` `matches!` | `enabled` 默认 false → UI 灰掉，零报错 |
| `connection.rs:2099 load_mcp_servers_for_agent` skip 名单 | MCP 双重注册（Kiro 已从 `~/.kiro` 原生加载） |
| `commands/mcp.rs:2332 scan_local_servers()` 11 段手写循环 | Kiro 的 server 不出现在通用面板 |
| `commands/mcp.rs:404-414` / `:479-489` 两处手写全量 `vec![]` | 默认 apps / 全量删除遗漏 Kiro |
| `src/lib/types.ts:570 AGENT_DISPLAY_ORDER` | 排序落到 `MAX_SAFE_INTEGER`，排最后 |
| `src/lib/types.ts:595 ALL_AGENT_TYPES` | 多处「遍历所有 agent」的 UI 不含 Kiro |
| `src/components/settings/mcp-settings.tsx:97` APP_OPTIONS + `:263` 勾选状态 | Kiro 不出现在 MCP 面板 / 勾选态恒 false |
| `src/components/settings/delegation-agent-defaults.tsx:66` | Kiro 不能被委派 |

`commands/experts.rs:780` / `office_tools.rs:1050` / `science.rs:610` 的 `const ALL` 同构切片
**不必改**：三者都被 `skill_storage_spec().is_some()` 过滤，且 `science.rs` 上游自己就只列了 10 项
（缺 Grok/Cursor）——证明这类列表是已知会漏的模式，非必改项。

### 须先冻结的契约（三处手写、无编译器保护）

1. `McpAppType`：后端 enum 变体名 ↔ 前端 `types.ts:2235` union 字符串 ↔
   `mcp-settings.tsx:97` 的 `value` ↔ `:263` 的 key。
2. `AgentType` serde 名 `kiro` ↔ 前端 union `"kiro"` ↔ `registry_id_for` 的 id 字符串
   （三者不同层，勿混）。

### MCP 门禁的位置选择

放在 `commands/mcp.rs` 的读写函数族层，而非新建 `runtime_mode.rs`：

- Tauri command 与 `web/handlers/mcp.rs`（HTTP，默认 3080，`web/mod.rs` 的
  `is_advertisable_ipv4` 证明可绑非 loopback）**共用同一批函数** → 一处生效覆盖两入口。
- **必须前置拒绝**：`mcp_set_server_apps:433` 的实现是 `:460-466` 先 `remove_server_for_app`
  再 `upsert_server_for_app`（非原子，上游既有性质）。若门禁在中途返 `Err`，会留下
  「旧配置已删、新配置未写」的损坏状态。故门禁判断必须在 `:437` 之前。

### 会话解析

`parsers/kiro.rs` 消费 `~/.kiro/sessions/cli/<uuid>.jsonl`，行级容错（P-1）。
五种顶层 kind：`Prompt` / `AssistantMessage` / `ToolResults` / `Clear`（轮边界）/
`Compaction`（压缩检查点，渲染为记录，**不分段**）。内层 `data.content[].kind`：
`text` / `thinking` / `toolUse` / `toolResult` / `image`。

⚠️ `Compaction.summary` 与 `messages_snapshot` 可能内含用户 steering 全文（实测单条 43KB）；
`session_start` 类内容在 IDE 格式中可达 140KB。渲染须做长度截断，且不得写入日志。

### 文件系统写权限

`agent_data_roots` 加 arm → `~/.kiro`。该函数的测试**当前基线就是红的**（8 个失败），
故 Kiro 的新测试**必须**用 `std::env::temp_dir()` 或 `cfg!(windows)` 分支，不能照抄邻近的 `/tmp` 写法。

## 实施波次

依赖来源：勘察报告 §5.2 + §9 的冲突面矩阵。

```text
W-1 【前置 · 已完成】ADR-0001 Proposed 已落盘
    docs/architecture/ADR-0001-agent-distribution-system-binary.md
    （仓内首个 ADR，编号已 git ls-files 核实无占用）
    W0 完成后翻 Accepted

W0 【串行头 · 独占】基座
    registry.rs（枚举 + SystemBinary + meta + id 双向映射 + all_acp_agents）
    + models/agent.rs + file_system_runtime.rs 的 agent_data_roots arm
    + 9 处 distribution 编译错误全补（先占位，不实现业务）
    + agent_setting_service.rs:28 default_enabled
    验收：cargo build EXIT=0；失败测试标识集合 ⊆ 已知 8 项（集合比较）
    ↓ 其余全部依赖 W0（新枚举变体不存在时无法编译）

W1 【三路真并行 · 零共享文件】
  P1 parsers/kiro.rs（新建）+ parsers/mod.rs 一行
  P2 commands/mcp.rs 全部（函数族 + 3 处 match + 门禁）+ web/handlers/mcp.rs
  P3 前端登记：types.ts + agent-icon.tsx + mcp-settings.tsx + delegation-agent-defaults.tsx
     ⚠️ 不含 i18n 新增
     ⚠️ P2/P3 都碰 McpAppType 两侧 → 契约先冻结再并行

W1.5【串行 · 极小】parser 挂载
    conversations.rs(2 处) + import_service.rs(2 处 + 数组 12→13)

W2 【必须串行 · 全在 connection.rs（9929 行）】
  S1 build_agent 的 Kiro 分支 + commands/acp.rs 6 处 match 实装
  S2 connection.rs:2099 MCP skip 名单
  S3 apply_kiro_env_policy + 启动参数收口（model/effort/权限/--agent）
    → 同一 executor 串行，或 3 次顺序提交。切给 3 个 AI 并行 = 必然冲突

W3 【串行尾 · 独占】前端面板 + i18n
    acp-agent-settings.tsx 面板 + api.ts + 10 个 locale JSON
    ⚠️ i18n 原子包：messages.test.ts 做 en↔9 locale 全 key 双向 diff，
       任何中途状态都是红的 → 不可拆包、不可并行、必须最后
```

**独占约束**：`connection.rs`(9929 行)、`commands/acp.rs`(13149 行，6 处 match 跨 7000 行)、
`acp-agent-settings.tsx`(9900+ 行) 三者各自**全程只允许一个 executor 持有**。

## 链路完整性（CCV 断点候选）

| 链路 | 风险 |
|---|---|
| 选 Kiro → `all_acp_agents()` → 前端列表 | ⛔ 手写 `vec![]`，漏加 = 整条链零输出零报错 |
| 列表 → `default_enabled():28` → DB `enabled` | ⛔ `matches!` 漏 = UI 灰掉零报错 |
| 会话文件 → `KiroParser` → `conversations.rs:280/938` | ⛔ parser 写了但 match 漏挂 = 死代码。**须 `git grep KiroParser -- src-tauri/src` 验生产 caller，不能只看 tests** |
| MCP 面板 → `:97` APP_OPTIONS → `set_server_apps:433` → `upsert_server_for_app:2427` → 文件 | ⛔ 四处无编译器保护，契约先冻结 |
| HTTP `web/handlers/mcp.rs` → 同一批 upsert/remove | ⛔ 只堵桌面则浏览器绕过 |
| env_json → `build_agent` argv | ⚠️ 典型 built-but-not-wired，须 argv 顺序组合测试（P-3） |
| i18n key → 10 locale → `messages.test.ts` | ✅ 有硬门禁，漏了必红 |

## ADR admission

**needed: yes → ADR-0001「Agent 分布类型：SystemBinary」**

裁决收口（R1-A6 指出 `background.md` 的 W4/checklist 要求建 ADR、本设计初稿写 `needed: no`，
两者互斥）：**以「需要」为准**，`background.md` 的要求成立，初稿的 `no` 作废。

理由：`AgentDistribution` 是**跨 agent 的通用概念**，新增变体改变的是「codeg 如何获得 agent 可执行体」
这一分布模型本身，后续任何系统安装型 agent（gemini-cli 系统装、claude-code 系统装等）都会复用它。
「为什么不复用 Binary / Uvx」这个问题必然被后人再问一次，且三方案的证据（假下载 URL / uv 抢主路径）
不写下来就会丢失。初稿判「可逆」只看了「删变体无数据迁移」，忽略了它是**边界定义型**决策
—— 准入条件是「难以逆转 **或** 边界定义」，命中后者即需要。

落地要求：**W0 开始前**先落 `docs/architecture/ADR-0001-agent-distribution-system-binary.md`
（Proposed，含 context / decision / 三方案 alternatives），由它指导 W0 实现；W0 完成后翻 Accepted。
ADR 编号须先 `git ls-files docs/architecture` 查实际占用，不得沿用记忆中的编号（E-061/E-066）。

## R1 评审驳回记录

以下 R1 意见经三步过滤（真伪 / 比重 / 根因）后**不予采纳**，理由记录在此以免 R2 重复提出：

| 意见 | 驳回理由 |
|---|---|
| **A3** 补 Agent Catalog / Runtime / Conversation Import / MCP Configuration / Credential Settings 限界上下文与依赖图 | 本任务是往**已有 12 个 agent 的成熟注册表**加第 13 个，上游架构已定且本规格不改变它。补一层领域概念图不改变任何一行实现、不消除任何一个已识别风险；真正的横切风险已由「CCV 链路表」逐条覆盖。判定为文档完备性诉求（§0.17 D 类·技术洁癖），不入交付。 |
| **A5** 建跨注册表 / 前端集合 / MCP app / 委派 schema 的自动一致性门禁 | 方向正确但**超出接入范围**：本仓零 pre-commit hook（`core.hooksPath` 为空），建门禁体系是独立工程。评审器自己也写「长期注册表重构可另立任务，不必阻塞本次接入」。本轮以 CCV 链路表 + 静默降级点清单 + `git grep` 验生产 caller 覆盖，登记为架构债。 |
| **F3** 会话浏览的字节/事件/deadline 资源预算与三态语义提升为正式 AC | 会话浏览是**只读**路径，13MB 文件的分页与性能属实现细节；`Compaction` 的长度截断已作为 R3.5.1 入 AC（那是真实风险：单条 43KB 且可能含 steering 全文）。其余预算入 AC 会把实现自由度写死在无实测依据的数字上。 |
| **F5** 模型列表须定义 CLI 来源 / 手动触发 / 超时 / 缓存 | `background.md` §4 死路 #5 已实测「未登录时 `--list-models` 挂在 auth portal」。**硬编码取值集合是据此做出的正确选择**，不是遗漏。反悔去调 CLI 子命令会重新踩已验证过的坑；且本规格范围已明确排除解析 `kiro-cli` 子命令输出（实测其 stdout 与 stderr 日志混排）。 |
| **F6** 须检测实际认证来源（whoami）否则调整用户故事 | 用户已裁决降级为提示文案（R7.4）。依据：`kiro-cli` 子命令输出为自由文本且与日志混排，把 UI 建在解析它上面是脆弱依赖。用户故事描述**动机**（不想每次开浏览器登录）而非保证，R7.4 已如实披露优先级。 |
| **A1 的方案部分** | 诊断采纳（API key 与第三方 MCP 凭据是两个安全域 → 已写入 R4.12）；但建议的 `Raw/QueryDto/Patch` 三类型 + 脱敏 + `Keep` 三态**不予采用**：该方案的动机是防「占位符回写覆盖真实凭据」，而不引入占位符即从根上消除该风险。用户已明确本地自用不需脱敏。见 R4.13 决策依据。 |
| **A2 的范围部分** | 能力矩阵方向采纳到 MCP 读写（R5）；但「会话读取 / agent 启动也需准入契约」超出用户裁决范围 —— 用户要的是局域网可用 + MCP 凭据不外泄。把只读会话浏览与本机进程启动一并封禁会使其宣称支持的场景不可用（评审器自己也指出这个反向风险）。 |

## Update Log

- **2026-07-26 R1（codex, gpt-5.6-sol）** `NEEDS_CHANGES`，p0=3，15 条 patch plan。处置：
  - **F1（P0）采纳** —— 主 AI 独立验证：实测 kind 序列为
    `Prompt > AssistantMessage > ToolResults > ... > Prompt > ...`，且 `ToolResults` 从不直接
    跟在 `Prompt` 后。确认 `Prompt` 是轮次起点，初稿只把 `Clear` 当边界是漏的
    → 重写 R3.4/3.4.1/3.4.2/3.4.3，新增 P-1b 同轮不变式。
  - **A1（P0）部分采纳** —— 凭据两安全域诊断成立 → 新增 R4.12/4.13 收口唯一契约；
    脱敏方案驳回（见驳回记录）。
  - **A2（P0）部分采纳** —— 门禁范围按用户裁决定为 MCP 读写；扩至会话/启动的部分驳回。
  - **A4 采纳** → 新增 R4.9（内容指纹 CAS）/4.10（临时文件原子替换）/4.11（局部合并），
    新增 P-2b。
  - **A6 采纳** → ADR 裁决翻转为 `needed: yes`，本节已重写。
  - **F2 采纳** —— P-1 的「消息数 == 合法行数」确实不成立（一行可含多个 content 项）
    → P-1 改为「领域事件映射 + 保序 + 行级故障隔离」；R3.6 拆为 3.6/3.6.1/3.6.2，
    未知事件策略统一为占位而非丢弃。
  - **F7 采纳** → 新增 R6.5.1–6.5.4（稳定标识 / 损坏 JSON 排除 / description 回退 / 启动前失效反馈）。
  - **F8 采纳** → R8 增主体澄清（约束 ACP `fs/*` 通路，非进程原生访问）+ 新增 8.4/8.5/8.6，
    新增 P-2c 路径封闭性。
  - **F9 采纳** → 验证基线改为**固定 8 个测试标识 + 错误指纹 + 集合比较**三条判据，
    修掉「按失败数量判定」的不可证伪问题。
  - **A3 / A5 / F3 / F5 / F6 驳回**，理由见上表。
- **2026-07-26 R2（codex, gpt-5.6-sol）** `NEEDS_CHANGES`，p0=3，6 条 patch plan（较 R1 的 15 条收窄）。
  **本轮引入了一次用户纠偏 + 官方文档核实，推翻了主 AI 的一次错误修改**：
  - **R2-A1（P0）诊断采纳、我的第一版修法作废**。评审指出「全局固定文件可能不是所选 agent 的
    实际配置源」。我先据本机数据（5 个 agent 内嵌 `mcpServers` 且 `useLegacyMcpJson: false`）
    改成「按 agent 二选一配置源」——**这是错的**。用户指出实际使用中自定义 agent 的 MCP 工具
    仍依赖全局，只是可以禁用其中某些工具。
    **官方文档核实**（`kiro.dev/docs/cli/mcp/configuration` · `/cli/chat/configuration`，
    页面更新 2026-05-27 / 2026-07-09）：MCP 是**三作用域合并**
    `Agent > Project > Global`，**同名才覆盖、不同名叠加**（官方示例：agent 有 `fetch`、
    workspace 有 `git`、global 有 `aws` → 三者同时生效）。agent 内嵌 `mcpServers`
    是叠加/覆盖，**不是替代**。
    → 重写 R4.1–4.1.6：写入目标定为 Global `~/.kiro/settings/mcp.json`（唯一对所有 agent
    生效的层，也是 `kiro-cli mcp add --scope global` 的目标）；Agent/Project 作用域**只读展示
    并标注来源与覆盖关系**；明确不写 agent 定义文件（避免把「管 MCP」与「改 agent 人格」耦合）。
    另修正：字段现名 **`includeMcpJson`**（boolean），`useLegacyMcpJson` 是上游 Amazon Q CLI
    旧名（`aws/amazon-q-developer-cli` issue #2984）；本机 6 个 agent 定义写的仍是旧名，
    当前版本可能忽略。新增 `KIRO_HOME` 重定向支持（R4.1.6）与项目级作用域。
  - **工具禁用需求补齐（用户实际用法）** → 新增 R4.4.2–4.4.5：server 级 `disabledTools`
    （省略指定工具）、`disabled`（停用整个 server 而不删配置）、`autoApprove`，
    以及 `timeout`/`url`/`headers`/`oauth` 等字段的往返保真。
  - **R2-A2（P0）采纳并收窄授权面** —— 评审要求「以真实 ACP 写入需求证明必要性」。
    结论：Kiro 进程自身维护 `~/.kiro` 走它自己的文件 API，**不需要 codeg 经 ACP 代写**；
    把整个 `.kiro` 开放给 ACP 等于把模型可驱动的写入面扩到会话记录 / agent 定义 / MCP 凭据。
    → R8 重写为「工作区 + `<KIRO_HOME>/sessions/`」白名单，显式拒绝 `settings/` 与 `agents/`，
    并加 8.7：实机若被拒则按最小范围补白名单，不得直接放开整个根。
  - **R2-A3（P0）采纳** —— 「本地明文」的前提是操作者已有本机文件系统权限，局域网网页入口
    不满足该前提。→ R5 从「MCP 写入门禁」扩为「凭据访问的模式差异」：拒绝清单覆盖
    MCP 读 + 写 + API key 读 + 写（R5.3），并加 5.3.1 禁止在响应/错误/日志中回显明文；
    5.6 明确不影响会话浏览与 agent 启动（用户裁决：局域网须可用）。
  - **R2-F1 采纳** → R6.1.1–6.1.3：模型预设为**非权威**、允许自定义 ID 原样传递、未选则省略
    `--model`。这与 R1-F5 的驳回不冲突：驳的是「去调 CLI 拉列表」（已实测会挂在 auth portal），
    采纳的是「不假设预设永久完整」。
  - **R2-A4 / R2-A5（P1）驳回** —— A4 要求把「枚举扩展 vs 职责拆分」再在 ADR 里比一轮：
    ADR-0001 已固化三方案对比，9 处 match 是**编译器强制暴露**的机械落点，不是职责过载；
    A5 要求按能力纵向拆波次：波次划分依据是**共享文件冲突面**（`connection.rs` 9929 行、
    `commands/acp.rs` 13149 行各含多个关注点），按能力纵切会让两个 executor 同时改同一文件，
    这是实测的冲突源而非理论风险。

- **2026-07-26 R3（codex, gpt-5.6-sol）** NEEDS_CHANGES，p0=1，6 条（趋势 15→6→6，P0 3→3→1）。
  R3 为硬止轮，处置后定稿。
  - **R3-A1（P0）采纳，从根上解决** —— 评审指出 requirements / design / background 三份文档对
    「MCP 第三方凭据明文 vs 脱敏」存在互斥契约。根因不在 requirements，而在 ackground.md
    自称「执行契约 · 已定案」却承载着已被推翻的方案（三类型 DTO + 脱敏 + Keep 三态）。
    → **把 ackground.md 整体降级为「背景资料 · 非契约」**：文件头加显式声明
    「唯一契约是 requirements.md + design.md，冲突处一律以它们为准」，并列出 9 条已被推翻
    /修正的条目对照表（MCP 方案 / MCP 单文件 / 4 种 kind / CLI 版本 / 测试基线 /
    webhook flaky / Tailwind / pre-commit hook / D5 门禁 / ADR 裁决）。同时保留其仍可信部分
    （符号名与结构、七条死路结论、勿造轮子清单、Cursor 动态 argv 范本）。
    这消除了双真源，而不是在三份文档间同步同一句话。
  - **R3-A2（P1）采纳** → 新增 R4.1.7/4.1.8 统一 runtime profile：<KIRO_HOME> 单一解析结果
    同时服务会话读取 / agent 扫描 / MCP 读写 / ACP 写权限边界四个消费方，并以「启动子进程时
    实际生效的 KIRO_HOME」为解析依据。同步把 AC 正文中 5 处硬编码 ~/.kiro 改为
    <KIRO_HOME>，并将该术语提到术语段定义（原先散落在 4.1.6，被 R8 等处引用）。
  - **R3-F1（P1）采纳** → 新增 R4.1.9–4.1.12：Project 作用域根 = 当前工作区
    （<workspace>/.kiro/settings/mcp.json）、工作区切换即重解析、文件缺失视为空集不报错、
    单个作用域 JSON 损坏时标示该作用域失败但不使整个面板不可用。
  - **R3-F2（P1）采纳** → 新增 R1.4.1–1.4.5 连接状态机：重复请求复用既有连接、握手超时终止
    子进程、取消不留孤儿进程、非预期退出保留退出码与 stderr 尾部、生命周期复用现有状态机
    不引入 Kiro 专属状态。
  - **R3-F3（P1）采纳** → 新增 R7.3.1–7.3.4：清空 key 则移除该键（不注入空串）、未存储则不注入
    使 Kiro 回落自身认证、codeg 显式设置优先于继承的同名变量、认证失败呈现原始错误
    且不静默重试或清除已存 key。
  - **R3-F4（P1）驳回** —— 评审要求把 D5 的信任边界写进 ackground.md。该文件本轮已整体
    降级为非契约；往其中补契约级约束会**重建刚刚消除的双真源**（正是 R3-A1 的根因）。
    对应约束已在 requirements R5.1–5.6 中，ackground.md 头部对照表也已指向它。

## 未决风险

- Tailwind v4 `@source not` 修复可能随丢失的 14 commit 一并消失（当前零命中）。一旦仓内出现
  `.worktrees` 目录，Turbopack panic 可能复现 → Mode C worktree 隔离时须实测。
- `remote_registry.rs` 是否遍历 `all_acp_agents()` 拉远端清单未核实（该文件不按 distribution 分派）。
- `Compaction` 是否还有 `messages_snapshot` 之外的分段语义未穷尽（仅抽样验证 1 条）。
- `includeMcpJson` 的默认值未在官方文档中明示（仅说明「设为 true 时额外包含」）→ 影响
  「agent 内嵌 `mcpServers` 且未显式声明该字段」时全局是否仍生效。实现前须实测确认。
