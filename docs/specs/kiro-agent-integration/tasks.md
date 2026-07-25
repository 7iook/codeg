---
slug: kiro-agent-integration
title: Kiro CLI 接入 codeg · 实施任务
status: converged
review_rounds_done: 3
last_review_status: NEEDS_CHANGES→resolved
last_review_p0: 0
created: 2026-07-26
last_updated: 2026-07-26
shipped_commit: null
related_adrs: [ADR-0001]
related_specs: []
supersedes: []
superseded_by: null
rca: null
tags: [acp, agent-integration, kiro, mcp]
domain: agent-runtime
one_line: 六波实施：基座 → 三路并行(parser/MCP/前端登记) → parser 挂载 → connection.rs 串行 → 面板+i18n。
---

# Tasks · Kiro CLI 接入 codeg

## 新会话开工须知（先读这一段，再看任务）

**契约**：`requirements.md`（8 需求 / 约 90 条 AC / 9 条 Correctness Property）+ `design.md`。
`background.md` 是**上一轮的历史存档，非契约** —— 冲突处一律以前两份为准（它头部已列 9 条已推翻条目）。

**仓库**：`F:\codeg-research`，分支 `feat/kiro-agent` @ `00bc59bc`（代码内容 == 上游 `2b017446`，
**仓内零 Kiro 实现代码**）。所有 `file:line` 取自
`.agent-workspace/.archive/2026-07-25/kiro-agent/kiro-agent-recon.md`（实测，非旧规格）。

### 三条硬红线

1. **禁用 `cargo fmt` 的任何形式**。仓内无 `rustfmt.toml`，`cargo fmt --all -- --check` 实测重排
   **90 文件 / 700 hunk**；不带 `--all` 也覆盖整个 workspace。要格式化只能 `rustfmt --check <单文件>`
   人工核对，或手写规范格式。
2. **后端测试基线是红的**。`cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib`
   → `1648 passed; 8 failed`，EXIT=101。**这 8 个不是你弄坏的**（上游 `2b017446` 引入的测试用
   `/tmp` 硬编码路径，Windows `Path::is_absolute()` 返 false）。验收判据见 requirements
   §验证基线：**失败测试标识集合 ⊆ 那 8 项（集合比较，不是数量比较）**。
3. **本仓无 pre-commit hook**（`core.hooksPath` 为空，`.git/hooks` 只有 sample）。格式、大文件、
   swallow、layering 全无自动检查 —— 每波自己跑验收命令。

### 验收命令（每波结束都跑）

```powershell
cd F:\codeg-research
cargo build --manifest-path src-tauri/Cargo.toml --no-default-features   # 必须 EXIT=0
cargo test  --manifest-path src-tauri/Cargo.toml --no-default-features --lib
pnpm test   # 前端；基线 EXIT=0 / 218 files / 2728 tests 全绿
```

前端跑测试前先 `Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue`（旧规格记的坑③）。

### 独占约束（多 executor 并行时必须遵守）

以下三个文件**全程只允许一个 executor 持有**，因为每个都含多个关注点且行数巨大：

| 文件 | 行数 | 关注点数 |
|---|---|---|
| `src-tauri/src/acp/connection.rs` | 9929 | 4 |
| `src-tauri/src/commands/acp.rs` | 13149 | 6（跨 7000 行） |
| `src/components/settings/acp-agent-settings.tsx` | 9900+ | 1（但超大） |

`src/i18n/messages/*.json`（10 个文件）是**原子包**：`messages.test.ts` 做 en↔9 locale 全 key
双向 diff，任何中途状态都是红的 → 不可拆包、不可并行、必须最后做。

### 两个先冻结再并行的契约（三处手写、无编译器保护）

1. **`McpAppType`**：后端 enum 变体名 ↔ `src/lib/types.ts:2235` union 字符串 ↔
   `mcp-settings.tsx:97` 的 `value` ↔ `:263` 的 key。
2. **`AgentType` serde 名 `kiro`** ↔ 前端 union `"kiro"` ↔ `registry_id_for` 返回的 id 字符串。
   三者在不同层，**别混为一谈**。

### 开工前必做一次的实测（唯一未决项）

`includeMcpJson` 的默认值。官方文档只说"设为 `true` 时额外包含 mcp.json 的 server"，未写默认。
影响 R4.1.2/4.1.3 的展示标注是否准确。验证：临时建一个测试 agent JSON，分别在声明/不声明该字段时
用 `kiro-cli` 交互会话的 `/mcp` 观察加载结果。**只影响展示标注文案，不阻塞任何一波实现。**

---

## W-1 · ADR 前置（已完成）

- [x] `docs/architecture/ADR-0001-agent-distribution-system-binary.md` 已落盘（Proposed）
- [ ] **W0 完成后**把它的 `状态` 改为 `Accepted`

---

## W0 · 基座（串行头 · 单 executor 独占 · 其余全部依赖它）

新枚举变体不存在时其他波次无法编译，所以这一波必须先做完。
**本波只补齐结构与编译，不实现业务逻辑**（match arm 里先返 `None` / `Err(unimplemented)` / 占位值）。

### T0.1 · 新增 `AgentType::Kiro`

- `src-tauri/src/models/agent.rs:6` `enum AgentType` 加 `Kiro` 变体（serde 名自动为 `kiro`）
- 同文件 `:23` `impl Display` 加 arm → `"Kiro"`
- _Requirements: 1.1, 1.2_

### T0.2 · 新增 `AgentDistribution::SystemBinary`

- `src-tauri/src/acp/registry.rs:4` 加第四变体，字段：`cmd: &'static str` + `args: &'static [&'static str]`
  + `env: &'static [(&'static str, &'static str)]`（**无 `version`、无 `platforms`、无 `dir_entry`**）
- `registry.rs:98` `registry_version()` 加独立 arm → `None`（不能并入现有 or-pattern，该变体无 `version` 字段）
- _Requirements: 2.1, 2.2, 2.5_
- _ADR: ADR-0001_

### T0.3 · 注册 Kiro 元数据与 id 映射

- `registry.rs:131` `all_acp_agents()` 手写 `vec![]` 加 `AgentType::Kiro`
  ⚠️ **漏了这一行 = Kiro 完全不出现在任何列表，且零报错**（design.md CCV 表首条）
- `registry.rs:163` `registry_id_for` 加 arm → `"kiro"`
- `registry.rs:180` `from_registry_id` 加 arm（否则 `:185` 的 `debug_assert_eq!` 在 debug 下 panic）
- `registry.rs:189` `get_agent_meta` 加 arm：`name` / `description` / `supports_mcp: false`
  （Kiro 从自己的配置原生加载 MCP，不经 ACP 线缆转发）/ `distribution: SystemBinary { cmd: "kiro-cli", args: &["acp"], env: &[] }`
- _Requirements: 1.1, 1.2, 4.5_
- _Properties: P-6_

### T0.4 · 默认启用

- `src-tauri/src/db/service/agent_setting_service.rs:28` `default_enabled()` 的 `matches!` 加 `Kiro`
  ⚠️ **漏了 = `enabled` 默认 false = UI 里灰着不能用，且零报错**
- _Requirements: 1.3_

### T0.5 · 补齐 9 处 distribution 编译错误（占位实现）

`cargo build` 会逐个报出来，全部由编译器强制暴露、不会漏：

| 位置 | 函数 | 本波填什么 |
|---|---|---|
| `acp/connection.rs:397` | `build_agent` | 占位 `Err(...)`，W2-S1 实装 |
| `acp/preflight.rs:60` | `run_preflight` | PATH 可解析检查（可直接实装，逻辑简单） |
| `commands/acp.rs:467` | `verify_agent_installed` | PATH 可解析检查 |
| `commands/acp.rs:589` | `detect_local_version` | 占位 `None`，W2-S1 实装 |
| `commands/acp.rs:865` | `build_agent_diag` | distribution 字符串 `"system-binary"` |
| `commands/acp.rs:1245` | `launch_label` | 「系统安装」 |
| `commands/acp.rs:7891` | `(available, installed_version)` | 复用 `verify_agent_installed` |
| `commands/acp.rs:7967` | `(available, dist_type, local_installed_version)` | 同上 |
| `acp/registry.rs:98` | `registry_version()` | 已在 T0.2 完成 |

- _Requirements: 2.3, 2.4, 2.5, 1.7_

### T0.6 · ACP 文件写权限白名单

- `src-tauri/src/acp/file_system_runtime.rs` 的 `agent_data_roots`（约 `:460-520`，KimiCode 在 `:486`、
  Cursor 在 `:493`）加 Kiro arm
- **不是**开放整个 `<KIRO_HOME>`：白名单 = 工作区 + `<KIRO_HOME>/sessions/`；
  显式拒绝 `<KIRO_HOME>/settings/` 与 `<KIRO_HOME>/agents/`
- `<KIRO_HOME>` 解析：`KIRO_HOME` 环境变量优先，未设置则用户主目录 `.kiro`
- ⚠️ **新测试必须用 `std::env::temp_dir()` 或 `cfg!(windows)` 分支**，
  **不要照抄邻近测试的 `/tmp` 写法**（那 8 个已知失败就是这个原因）
- _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 4.1.6_
- _Properties: P-2c_

### W0 验收

- [ ] `cargo build --no-default-features` EXIT=0
- [ ] `cargo test --no-default-features --lib` 失败集合 ⊆ 已知 8 项
- [ ] `git grep -n "AgentType::Kiro" -- src-tauri/src` 命中数 ≥ 8
- [ ] ADR-0001 翻 Accepted

---

## W1 · 三路真并行（零共享文件 · 可派 3 个 executor）

⚠️ **P2 与 P3 都碰 `McpAppType` 的两侧（后端 enum ↔ 前端 union）→ 先冻结契约再并行。**

### P1 · 会话解析（新建文件，零冲突）

#### T1.1 · 新建 `src-tauri/src/parsers/kiro.rs`

读 `<KIRO_HOME>/sessions/cli/<uuid>.jsonl`。**只读**，不写。

**真实数据形状（实测，不要照旧规格）**：每行 `{"version":"v1","kind":"...","data":{...}}`。
顶层 `kind` **五种**：

| kind | 语义 | 实测样本占比（741 行文件） |
|---|---|---|
| `Prompt` | **用户轮次起点**（轮次边界） | 39 |
| `AssistantMessage` | 助手消息 | 370 |
| `ToolResults` | 工具结果 | 331 |
| `Clear` | **轮次终止**、丢弃上下文关联 | 0（该样本无，其他样本有） |
| `Compaction` | 上下文压缩检查点 `{summary, strategy, messages_snapshot}` · **不是轮次边界** | 1 |

内层 `data.content[].kind`：`text` / `thinking` / `toolUse` / `toolResult` / `image`。

**轮次状态机**（R1-F1 的 P0，务必按这个实现）：
- `Prompt` 开启新轮次；`Clear` 终止当前轮次并丢弃上下文关联
- 每个 `toolResult` 归属到**同一轮次内**产生对应 `toolUse` 的 `AssistantMessage`
- **禁止跨轮次配对** `toolUse` ↔ `toolResult`
- 同轮内找不到对应 `toolUse` 的 `toolResult` → 渲染为孤立工具结果，**不移动到相邻轮次**

**容错**：
- 非法 JSON 行 → 跳过，继续后续行
- 未知顶层 `kind` → 渲染带 kind 名的**占位事件**（不是丢弃）
- 未知内层 `kind` → 保留占位，不丢弃同事件内其余元素
- `Compaction` 的 `summary` / `messages_snapshot` 渲染**必须截断**（实测单条 43KB，
  且可能内含用户私有 steering 全文）—— 且不得写入日志

- `src-tauri/src/parsers/mod.rs` 加一行注册
- _Requirements: 3.1–3.8_
- _Properties: P-1, P-1b_

#### T1.2 · P1 测试

- 行级隔离（P-1）：合法/非法行任意交错 → 不 panic、事件序列与合法行保序一一对应
- 同轮不变式（P-1b）：构造跨轮 `toolUse`/`toolResult` → 断言不被错误配对
- `Compaction` 不分段 + 截断标记
- 建议用 `proptest`/`quickcheck` 跑 ≥100 次迭代做 P-1

### P2 · MCP 读写 + 凭据门禁

#### T2.1 · Kiro MCP 读写函数族

`src-tauri/src/commands/mcp.rs`。沿用 KimiCode（`:2480/:2484/:2536`）/ Cursor（`:3007/:3015/:3019`）
的既有三件套约定：

- `kiro_mcp_json_path()` → `<KIRO_HOME>/settings/mcp.json`
- `read_kiro_servers()` / `read_kiro_servers_at(&Path)`（`_at` 变体便于测试注入临时路径，是本仓约定）
- `upsert_kiro_server(id, spec)` / `remove_kiro_server(id)`
- `commands/mcp.rs:2443` `read_servers_for_agent_type` 加 Kiro arm

**写入目标是全局 `<KIRO_HOME>/settings/mcp.json`，不写 agent 定义文件。**
MCP 是三作用域**合并**（`Agent > Project > Global`，同名才覆盖、不同名叠加）——
Agent / Project 作用域的条目**只读展示 + 标注来源与覆盖关系**。

**保真要求**：`disabled` / `autoApprove` / `disabledTools` / `timeout` / `url` / `headers` /
`oauth` / `oauthScopes` 以及任何未识别字段，读写往返逐字保留；`mcpServers` 之外的顶层键保留。

**原子写**：读取时记录内容指纹 → 写入时校验指纹未变（变了返冲突错误、不覆盖）→
写同目录临时文件后原子替换 → 任一步失败则目标文件字节内容不变。

- _Requirements: 4.1–4.1.12, 4.2, 4.3, 4.4, 4.4.1–4.4.5, 4.7, 4.8, 4.9, 4.10, 4.11, 4.12, 4.13_
- _Properties: P-2, P-2b_

#### T2.2 · `McpAppType` 加 Kiro

`commands/mcp.rs:50` `enum McpAppType`（现 11 变体）加 Kiro，连带 4 处：

- `:2427` `upsert_server_for_app`（穷尽 match，编译强制）
- `:3365` `remove_server_for_app`（穷尽 match，编译强制）
- `:2332` `scan_local_servers()` 的 **11 段手写 for 循环**加一段（**不改也能编译** → Kiro 的 server
  不出现在通用面板）
- `:404-414` `mcp_add_server` 默认 apps + `:479-489` `mcp_remove_server(None)` 全量列表
  （两处手写 `vec![]`，**不改也能编译**）

- _Requirements: 4.6_

#### T2.3 · 凭据准入门禁（桌面 vs HTTP）

在 `commands/mcp.rs` 的**读写函数族层**实施，使桌面入口与 HTTP 入口
（`src-tauri/src/web/handlers/mcp.rs`，默认 3080 端口）**共用同一判断**。
**不新建 `runtime_mode.rs`**。

- 配置项控制是否允许非桌面入口访问 Kiro 凭据，**默认不允许**
- 拒绝清单：读 Kiro MCP 配置 / 写 Kiro MCP 配置 / 读已存 API key / 写 API key
- 拒绝时不得在响应体、错误信息或日志中包含 `env` 值、`args` 元素或 key 明文
- ⚠️ **必须前置拒绝**：`mcp_set_server_apps:433` 的实现是 `:460-466`
  **先 `remove_server_for_app` 再 `upsert_server_for_app`**（非原子，上游既有性质）。
  门禁判断必须在 `:437` **之前**，否则会留下"旧配置已删、新配置未写"的损坏状态。
- **不影响**其余 12 个 agent 的 MCP 读写；**不影响**经 HTTP 的会话浏览与 agent 启动
  （用户裁决：局域网场景须可用）
- _Requirements: 5.1–5.6_
- _Properties: P-4, P-5_

#### T2.4 · P2 测试

- `read(write(c)) == c` 往返保真，含未识别字段（P-2）
- 指纹冲突 → 拒写且文件字节不变；落盘失败 → 文件字节不变（P-2b）
- 门禁拒绝时文件字节不变（P-4）
- 门禁配置任意取值不改变非 Kiro app 的读写结果（P-5）

### P3 · 前端登记（不含 i18n）

#### T3.1 · `src/lib/types.ts`

| 行 | 构造 | 性质 |
|---|---|---|
| `:1-13` | `type AgentType` union 加 `"kiro"` | 驱动下面所有 Record |
| `:887` | `AGENT_LABELS: Record<AgentType,string>` | **tsc 强制** |
| `:902` | `AGENT_COLORS: Record<AgentType,string>` | **tsc 强制** |
| `:570` | `AGENT_DISPLAY_ORDER: AgentType[]` | 数组，漏了排最后（静默） |
| `:595` | `ALL_AGENT_TYPES: AgentType[]` | 数组，**漏了多处"遍历所有 agent"的 UI 不含 Kiro（静默、高危）** |
| `:2235` | `type McpAppType` union | 与后端 `McpAppType` 对偶，必须同步 |

`:610` `MODEL_PROVIDER_AGENT_TYPES` 只含 claude/codex/gemini → **不需要改**。

#### T3.2 · 其余前端登记点

- `src/components/agent-icon.tsx` 加一个内联 React memo 图标组件（参考 `KimiCodeColorIcon:288`）
  + `:392` `COLOR_ICONS` map 加一行
- `src/components/settings/mcp-settings.tsx:97` `APP_OPTIONS` 加 `{ value: "kiro", label: "Kiro" }`
  + `:263` 勾选状态对象加 `kiro: appSet.has("kiro")`
- `src/components/settings/delegation-agent-defaults.tsx:66` 白名单数组加 `"kiro"`
- _Requirements: 4.6_

#### T3.3 · 不必改的（有意跳过，别浪费时间）

`commands/experts.rs:780` / `office_tools.rs:1050` / `science.rs:610` 的 `const ALL` 切片：
三者都被 `skill_storage_spec().is_some()` 过滤，且 `science.rs` 上游自己只列了 10 项（缺 Grok/Cursor）
—— 证明这类列表是已知会漏的模式，非必改项。

---

## W1.5 · parser 挂载（串行 · 极小 · 依赖 P1）

- `src-tauri/src/commands/conversations.rs:280` parser 分派加 Kiro arm
- `src-tauri/src/commands/conversations.rs:938` **第二处独立分派**（导出/批量路径）加 arm
- `src-tauri/src/db/service/import_service.rs:25` `const ALL_PARSER_AGENTS: [AgentType; 12]`
  → **长度改 13** 并加项
- `src-tauri/src/db/service/import_service.rs:41` `build_parser` 加 arm
- ⚠️ **验收必须 `git grep KiroParser -- src-tauri/src` 确认有生产 caller（不是只在 `tests/`）** ——
  parser 写了但 match 漏挂 = 死代码，测试全绿也发现不了（design.md CCV 表第三条）
- _Requirements: 3.8_

---

## W2 · connection.rs 全部（必须串行 · 单 executor 独占）

三个关注点全在 `src-tauri/src/acp/connection.rs`（9929 行）。
**切给 3 个 AI 并行 = 必然 merge 冲突。** 同一 executor 顺序做，或拆 3 次顺序提交。

### S1 · `build_agent` 的 Kiro 分支 + `commands/acp.rs` 实装

- `connection.rs:397` 的 `SystemBinary` arm：`resolve_system_agent_binary(cmd)` 解析 PATH →
  argv = `["acp", ...动态参数]`
- ⚠️ `registry.rs` 三个变体的 `args` 都是 `&'static [&'static str]`，**动态参数只能在分支内构造** ——
  **照抄 `connection.rs:576-591` Cursor 的 `cmd_args.insert(0, ...)` 范本**，别改枚举
- `commands/acp.rs:589` `detect_local_version` 实装：跑 `kiro-cli --version` →
  剥除 `kiro-cli-chat ` 前缀（实测输出 `kiro-cli-chat 2.14.2`）
- 连接状态机：重复请求复用既有连接不起第二个进程 / 握手超时终止子进程 / 取消不留孤儿进程 /
  非预期退出保留退出码与 stderr 尾部 / 生命周期复用现有状态机不引入 Kiro 专属状态
- _Requirements: 1.4, 1.4.1–1.4.5, 1.5, 1.6, 2.3, 2.4_

### S2 · MCP 转发跳过名单

- `connection.rs:2099-2104` 的 `matches!(Hermes|KimiCode|Grok|Cursor)` 加 `Kiro`
- ⚠️ 漏了 → codeg 会把用户 MCP 服务器再经 ACP 线缆转发一次，而 Kiro 已从自己配置原生加载 →
  **双重注册**
- _Requirements: 4.5_

### S3 · 启动参数收口 + env policy

新增 `apply_kiro_env_policy`（同构参考 `connection.rs:118 apply_grok_env_policy`）。

**四个启动参数维度**（实测 `kiro-cli acp --help` 全部存在）：

| 维度 | 参数 | 取值 |
|---|---|---|
| 模型 | `--model <MODEL>` | 预设集合**非权威**，允许用户输入任意自定义 ID 原样传递；未选则省略 |
| effort | `--effort <EFFORT>` | `low` / `medium` / `high` / `xhigh` / `max` |
| 授权 | `--trust-all-tools` 或 `--trust-tools <TOOL_NAMES>` | 二选一 |
| 自定义 agent | `--agent <AGENT>` | 扫 `<KIRO_HOME>/agents/*.json` 的文件名（去扩展名）；未选则省略 |

**自定义 agent 扫描**（新 command）：
- 文件名去扩展名 = 稳定标识 = 传给 `--agent` 的值
- 无法读取或非合法 JSON → 从列表排除，不阻止其余项
- 用 `description` 字段作说明文字，缺失则只显示标识
- 已选 agent 在启动时不存在 → 明确报错，**不静默回退到默认 agent**
- 目录不存在或为空 → 空列表，不阻止连接

**API key**：存 `agent_setting.env_json`（复用 Grok/Cursor 现成通路，零新增存储代码），
启动时作环境变量注入。清空则**移除该键**（不注入空串）；未存储则不注入（让 Kiro 回落自身认证）；
codeg 显式设置优先于继承的同名变量；认证失败呈现 Kiro 原始错误，不静默重试、不清除已存 key。

- _Requirements: 6.1–6.9, 7.1, 7.3, 7.3.1–7.3.4, 7.5_
- _Properties: P-3_

### S3 测试

- **argv 顺序组合测试（P-3）**：四个维度（含各自"未设置"）的全组合 →
  每个已设置维度恰好出现一次、未设置不出现、argv 首元素恒为 `acp`
- ⚠️ 这是防 built-but-not-wired 的关键测试：「写了 `env_json` 但 `build_agent` 没读」
  是本任务最可能的静默失败（design.md CCV 表第六条）

---

## W3 · 前端面板 + i18n（串行尾 · 单 executor 独占 · 必须最后）

### T4.1 · Kiro 配置面板

`src/components/settings/acp-agent-settings.tsx:9887` 的三元链加
`selectedAgent.agent_type === "kiro" ? <KiroConfigPanel/> : ...`

面板内容：
- API key 输入（**明文显示**，无脱敏、无占位符回写 —— 本地自用工具，用户已明确裁决）
- 模型选择（预设 + 允许自定义输入）/ effort 选择 / 授权模式选择 / 自定义 agent 下拉
- 一行提示文案：「若已执行过 `kiro-cli login`，登录态优先于 API key」
  （**不做 whoami 解析** —— `kiro-cli` 子命令输出与 stderr 日志混排，解析其自由文本是脆弱依赖）
- MCP 面板侧：显示当前读写目标的绝对路径；Agent / Project 作用域条目只读 + 标注来源与覆盖关系；
  server 条目可编辑 `disabledTools` / `disabled` / `autoApprove`
- `src/lib/api.ts` 加对应 command 封装（参考 `:569 acp_update_kimi_code_config`）
- _Requirements: 4.1.4, 4.1.5, 4.4.2–4.4.4, 6.1–6.4, 7.1, 7.2, 7.4_

### T4.2 · i18n（原子包 · 一次做完 10 个 locale）

`src/i18n/messages/{ar,de,en,es,fr,ja,ko,pt,zh-CN,zh-TW}.json` —— **共 10 个文件**。

⚠️ `src/i18n/messages.test.ts` 以 `en.json` 为 SSOT 做**全 key 集合双向 diff**
（`missing` + `extra` 都必须为空）→ **只加 `en.json` 会让 9 个 locale 测试全红**。
**不可拆包、不可并行、必须一次改完 10 个文件。**

按 KimiCode 样本推断需要的 key 路径：`kiro.*`（面板文案）+ `actions.saveKiroConfig` +
`toasts.kiroSaved` / `toasts.saveKiroFailed`；具体条目取决于面板控件数量。

---

## 全局收尾

- [ ] 全波验收命令通过（失败集合 ⊆ 已知 8 项 / 前端全绿）
- [ ] **变体再扫描**：`git grep -n "AgentType::Cursor" -- src-tauri/src` 得到 13 个文件的分布，
      逐一核对 Kiro 是否也需要（Cursor 是最近新增的 agent，是最好的对照样本）
- [ ] ADR-0001 翻 `Accepted`
- [ ] `docs/specs/README.md`（本轮 bootstrap 生成，AUTO-INDEX 标记）与 charter 三件套一起提交
- [ ] 提交时 `git add` 只加自己改的文件，**禁 `git add .` / `-A`**
      （工作区有一个不属于本任务的 `2026-07-25-204440-*.txt` 会话导出文件）
- [ ] 改动索引过的项目 → `codegraph sync F:\codeg-research`

## 未决风险（实施时留意）

- **Tailwind v4 `@source not`**：`git grep "@source" -- src/` 当前**零命中**，该修复可能随丢失的
  14 commit 一起没了。一旦仓内出现 `.worktrees` 目录，Turbopack panic 可能复现 →
  用 worktree 隔离时须实测。
- `remote_registry.rs` 是否遍历 `all_acp_agents()` 拉远端清单**未核实**（该文件不按 distribution 分派）。
- `Compaction` 是否还有 `messages_snapshot` 之外的分段语义未穷尽（仅抽样验证 1 条）。
- `includeMcpJson` 默认值（见开工须知）。
