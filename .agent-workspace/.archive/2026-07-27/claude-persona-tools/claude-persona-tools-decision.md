> ✅ **2026-07-27 · W0 已定案：人格功能已存在，本卡片 §3.1 的自建方案全部删除。**
> 实跑同构 ACP 握手（同一个 `claude-agent-acp@0.62.0`）：`session/new` 响应的
> `configOptions` 含 `mode`/`model`/**`agent`** 三项，`agent` 带 default 哨兵 +
> 本机 **9 个自定义人格**（内置 subagent 已滤）；`set_config_option{configId:"agent"}`
> 实跑返回 `currentValue:"debugger"`，热切换生效。codeg 侧五跳**无按 id 过滤**
> （`connection.rs:1351` 只判 `kind==Select`；`message-input.tsx:2694` 遍历全部）。
>
> ⛔ **决定性证据**：本机 9 个人格中 **4 个在嵌套子目录**（`agents\zcf\common\*` 等），
> adapter catalog 9/9 全中；而本卡片计划照搬 Kiro 的**单层 `read_dir`** 扫描**会漏 44%**。
> 自建方案不只是第二个 SSOT，是**功能更差的**第二个 SSOT。
>
> **保留**：工具限制（§3.2 `disallowedTools`，全仓 grep 零命中，工作量全额）
> + fail-closed 独立闸门（但变简单：数据源就是手边的 `configOptions[id="agent"].options`）。
> **写死约束**：人格一律走 config option，**不走 `_meta`**（R8 静默回落只存在于 `_meta` 路）。

# Claude 子代理人格 + 工具限制 — Boundary Decision Card

> 目标（一句话可验证成功态）：用户在 codeg 里派发 Claude 子代理时，能选定
> `~/.claude/agents/` 中自定义的人格，并对该子代理施加工具/MCP 白黑名单；
> 派出去的会话是可见、可续聊的 codeg 会话。

---

## 🏗️ 1. Boundary Decisions

- **Bounded context**：`acp` 基础设施层（外部代理进程的启动契约），非核心 domain。
  人格与工具限制都是「启动/会话参数」，不进入 conversation domain 模型。
- **状态机**：无新状态机。人格选择是会话级配置，复用现有
  `session/set_config_option` 的既有状态（`currentAgent`）。
- **不变量**：
  1. `_meta.claudeCode` 只对 `AgentType::ClaudeCode` 发出（现有
     `claude_raw_sdk_session_meta` 已守此约束，不得放宽）。
  2. 工具限制是**收窄**语义：不传 = 适配器 `claude_code` preset，不得因本功能
     导致「未配置时工具变多」。
  3. **显式配置 = fail-closed**（R1 实测 + 评审 A1/F2 共同得出）：用户显式选了
     人格或配了工具限制时，若无法确认适配器已应用，**拒绍启动** + 稳定错误码；
     绝不得静默降级为默认人格 / 更宽权限。仅**未配置**时允许 best-effort。
  3. 人格名必须先经 `discoverCustomAgents()` 校验存在，未命中不得静默降级为
     default 而不告知（适配器 L4277 自身会 fallback，codeg 需在 UI 反馈）。

- **ADR admission**：**否** — 不新增依赖方向、不定义新边界；是在既有
  `_meta.claudeCode` 注入点与既有 Kiro 人格枚举形状上做同构扩展。可逆
  （删掉字段即回到当前行为）。

---

## 🔍 2. Existing-Implementation Search

**内部（trio + git grep）**

| 查询 | 命中 | 结论 |
|---|---|---|
| `_meta` 注入点 | `connection.rs:2136 claude_raw_sdk_session_meta()` | ✅ **已存在**，当前只塞 `emitRawSDKMessages: true`。扩展此函数，**禁止新建第二个注入点** |
| `session/new` 构造 | `connection.rs:2157 build_new_session_request()`（调用者 3449 / 3527） | 唯一 chokepoint；load/resume 同形（2172 / 2193） |
| 人格枚举前例 | `commands/acp.rs:4380 list_kiro_custom_agents()` + `KiroCustomAgent`(4365) + tauri cmd `acp_list_kiro_custom_agents`(9449) | ✅ 复用形状 |
| Kiro 人格下发 | `connection.rs:222 KIRO_AGENT_ENV → --agent` | 参照但**不照抄**（Kiro 走 CLI flag，Claude 走 ACP 字段） |
| 委托侧 config 透传 | `delegation/spawner.rs:69` `preferred_config_values` → `set_config_option` | ✅ 人格切换链路已存在 |
| `persona` / `requestedAgent` / `custom_agent`（Claude 侧） | 无命中 | **verified absent** — 本功能确为新增 |

**外部（实物验证，非文档推断）**

- `npm pack @agentclientprotocol/claude-agent-acp@0.62.0` 解包实测：
  - `dist/acp-agent.d.ts` `NewSessionMeta.claudeCode.options` 注释逐条声明：
    `hooks`(合并) / `mcpServers`(合并) / `disallowedTools`(合并) / `tools`(透传，
    缺省用 `claude_code` preset)。与 0.61.0 **逐字节相同**。
  - `dist/acp-agent.js:4040` `settingSources: ["user","project","local"]`（硬编码）
    → `~/.claude/agents/` 自动被读取。
  - `dist/acp-agent.js:4580` `discoverCustomAgents(q)` → `q.supportedAgents()`，
    滤除内置 subagent。
  - `dist/acp-agent.js:4277` 接受 `requestedAgent`，与发现列表核对后设为
    `currentAgent`；`:3766` 支持运行时改写。
  - d.ts 结构 diff（agents/tools/AgentInfo 相关）0.61 vs 0.62 = 零差异。
- Claude Code 2.1.88 sourcemap（`E:\word\claude-code-sourcemap`）：
  `entrypoints/sdk/coreSchemas.ts:1110 AgentDefinitionSchema` 含
  `tools` / `disallowedTools` / `prompt` / `model` / `mcpServers` / `skills`；
  `controlSchemas.ts:68` `initialize.agents: Record<string, AgentDefinition>`。

**结论**：SDK + 适配器均已支持；缺口纯在 codeg 未传。**复用既有注入点扩展，
不新建并行实现。**

---

## 📐 3. Interface Contract

### 3.1 人格（persona）

```
读：list_claude_custom_agents() -> Vec<ClaudeCustomAgent>
    扫描 ~/.claude/agents/*.md（frontmatter: name/description/tools/model）
    形状对齐既有 KiroCustomAgent
写：session/new → _meta.claudeCode.options.agent = <name>
    或运行时 → set_config_option("agent", <name>)（已有链路）
```

**R1 已实测定案**（`@anthropic-ai/claude-agent-sdk@0.3.219` `sdk.d.ts:1350/1367`）——
是**两个独立键**，选择器与定义源分离：

```typescript
agent?:  string                            // 选哪个人格 · 等价 --agent CLI flag
agents?: Record<string, AgentDefinition>   // 编程式定义人格（不依赖文件系统）
```

SDK 原文：*"The agent must be defined either in the `agents` option or in settings."*

两种用法（**本期选 A，B 记为后续可能**）：
- **A 复用用户已有人格**：只传 `agent: "<name>"`，定义由 `settingSources` 的 user
  层（`~/.claude/agents/`）提供。
- **B codeg 自带内置人格**：传 `agents: {...}` 定义 + `agent` 选中，**完全不要求
  用户先建文件**。→ 这是「codeg 内置几个 SUB」的实现路径。

- 校验：名称必须在 `discoverCustomAgents()` 返回集合内；不在则**报错而非静默**。
- 幂等：同名重复设置为 no-op。

### 3.2 工具限制

⛔ **R1 实测纠正了本节原稿的一处错误**：原稿把 `tools` 写成会话级白名单（照抄了
适配器注释）。SDK 顶层 `Options` 的真实语义（`sdk.d.ts:1375/1395`）是：

| 键 | 语义 | 能否当白名单 |
|---|---|---|
| `allowedTools` | **自动放行、免确认** —— SDK 原文 *"To restrict which tools are available, use the `tools` option instead"* | ❌ **不能** — 误用会得到「工具未受限，反而全部免确认」，安全方向相反 |
| `disallowedTools` | 从模型上下文中**移除**，不可用 | ✅ 真限制（黑名单） |
| `tools` | 仅存在于 **`AgentDefinition`**（人格级），非会话级 | ✅ 白名单，但须随人格定义走 |

```
_meta.claudeCode.options = {
  disallowedTools?: Vec<String>,   // 黑名单（与 ACP 侧合并）· 会话级真限制
  mcpServers?:      ...,           // 与 ACP 侧合并 —— ⚠️ 见风险 R2
  // ⛔ 勿用 allowedTools 做限制（语义是免确认，不是收窄）
}
AgentDefinition.tools = Vec<String>   // 白名单只能在人格级施加
```

**推论**：会话级只能做黑名单；要白名单必须落到人格定义上（即用法 B）。

- **错误码**：新增 `AcpError::UnknownClaudeAgent { name }`（人格不存在）。
- **降级（评审 F2 修正：原稿笼统“best-effort”已作废）**：区分两种情形——
  - **未配置**（无人格、无限制）：`_meta` 被忽略不得导致启动失败（兼容旧 adapter）。
  - **显式配置**：必须能确认生效（读回 `currentAgent` / config option）；
    无法确认 → **fail-closed，拒绍启动**。理由：“界面显示已限制、实际未限制”
    是安全误导，比启动失败严重得多。
- **错误码补齐**：`UnknownClaudeAgent{name}` / `PersonaNotAppliedByAdapter` /
  `InvalidToolName{name}` / `MalformedPersonaFile{path}`。

### 3.3 委托侧（评审 A6：原稿“新增一个字段”悬空，已补齐契约）

`AgentDelegationDefaults`（`delegation/types.rs:26`）已有 `mode_id` +
`config_values`。人格走 `config_values["agent"]` 即可，**无需改结构**。
工具限制新增一个字段：

```rust
pub struct AgentDelegationDefaults {
    pub mode_id: Option<String>,
    pub config_values: BTreeMap<String, String>,
    /// 新增。会话级工具黑名单，透传至 `_meta.claudeCode.options.disallowedTools`。
    /// 空 = 无限制（不发字段，非发空数组）。仅 ClaudeCode 消费；其他 agent 忽略。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub disallowed_tools: Vec<String>,
}
```

- **优先级**：会话级显式配置 > agent 级默认 > 无限制。
- **向后兼容**：`#[serde(default)]` → 旧 payload 反序列化为空，行为不变。
- **校验位置**：应用层（人格存在性）——不在 `connection.rs`，避免业务规则沉到 adapter。
- **UI 与 LLM 同走一个应用服务**（避免三套能力）。LLM 不得绕过用户可选范围。
- **是否向 LLM 暴露 persona 参数**：本期**不暴露**（`tool_schema.json` 不动）——
  先让用户在 UI 选，避免 LLM 自选人格带来的权限绕过面。

### 3.4 人格与能力的会话快照（评审 A4：不引入状态机，但定义生命周期）

人格/限制不只是一次性 ACP 参数，也是**启动快照**（因为会话可续聊/可恢复）：

| 时机 | 行为 |
|---|---|
| `session/new` | 写入快照（持久化到 conversation 行） |
| `session/load` / `resume` | **复用原快照**（不重新解析当前文件）——保证恢复后行为一致 |
| 人格文件被改/删 | 旧会话沿用快照；重建时才报人格不存在 |
| 运行时切人格 | 更新快照 + `set_config_option`，两者同事务 |

不引入新状态机（仅一个不可变快照 + 一个可变 currentAgent）。

---

## 🧪 4. Test Boundaries (TDD Red)

先写、必须先红：

1. `claude_session_meta_carries_persona_when_configured` — 配了人格时
   `_meta.claudeCode` 含该人格名；未配时**字段缺席**（不是空串/null）。
2. `claude_session_meta_omits_tool_limits_when_unconfigured` — 守不变量 2：
   未配置时 `tools`/`disallowedTools` 均不出现。
3. `non_claude_agent_never_gets_claude_meta` — 守不变量 1（扩展现有
   `connection.rs:8512` 的 OpenClaw 断言）。
4. `list_claude_custom_agents_parses_frontmatter` — 含畸形 frontmatter /
   空目录 / 目录不存在三种边界（对齐 `acp.rs:10889-10904` 的 Kiro 测试）。
5. `unknown_persona_is_rejected_not_silently_defaulted` — 不变量 3。
6. 边界（真实世界压力）：目录不存在 / 人格文件名含非法字符 / 同名人格在 user 与
   project 两层并存（谁优先——**待定，见风险 R3**）。

### 4.1 端到端验收（评审 F3：单测只验字段形状，不能证明业务成功态）

上面 1-6 只能证明报文拼对了。**下列必须真跑一次**（否则就是 E-052
“单测全绿但未接入”）：

| # | 验收项 | 对应目标 |
|---|---|---|
| E1 | 选定人格后，会话**实际生效人格** = 所选（读回 `currentAgent` 核对） | 人格可选 |
| E2 | 被拒工具调用**真的失败**且原因正确（非“声称成功但 toolUseCount=0”） | 工具限制 |
| E3 | 会话出现在列表中且**能续聊**（不因本功能破坏委派能力） | 可见可续聊 |
| E4 | 桌面模式与 Web/服务器模式行为一致 | 双模式对等 |
| E5 | 显式限制被 adapter 忽略时，启动**失败**而非静默放宽 | 不变量 3 |
| E6 | `codeg-mcp` 在配了工具限制后仍存活（否则委派整体失效） | 风险 R2/R5 |
| E7 | 黑名单写入 `mcp__codeg-mcp__*` 或通配 → **校验报错**，非静默过滤 | 风险 R5 |
| E8 | resume 一个带人格的会话 → 人格与限制**仍生效**（验 fingerprint 不含 `_meta` 的影响） | 风险 R6 |

---

## 🛡️ 5. Anti-Corruption Layer & Registration

- **隔离**：`_meta.claudeCode` 的 JSON 形状是第三方契约，收敛在
  `claude_raw_sdk_session_meta()` 一个函数内（SSOT）。上层只传 Rust 结构体，
  不得在别处手拼 JSON。
- **注册清单**：
  - [ ] tauri command `acp_list_claude_custom_agents` → `lib.rs` invoke_handler
  - [ ] web handler + `router.rs` 路由（双模式对等，勿只加桌面侧）
  - [ ] 前端 `api.ts` client
  - [ ] i18n 10 语言（en/zh-CN/zh-TW/ja/ko/es/de/fr/pt/ar）
  - [ ] `delegate_to_agent` 的 `tool_schema.json`——是否暴露 persona 参数给 LLM
  - [ ] feature flag：**不加**（纯增量、默认关闭语义已由「字段缺席」实现）

---

## ⚠️ 6. 风险与未验项（不得当已验事实使用）

| ID | 项 | 状态 |
|---|---|---|
| R1 | 人格的确切键名 | 🟢 **已验（2026-07-27）** — `npm pack @anthropic-ai/claude-agent-sdk@0.3.219` 解包实测：`sdk.d.ts:1350` `agent?: string`（选择器）+ `:1367` `agents?: Record<string, AgentDefinition>`（定义源），两键独立。**顺带纠正原稿 `tools` 键名错误 → 见 §3.2** |
| R2 | `mcpServers` 是**合并**语义：codeg 自己注入 `codeg-mcp` 伴生进程。若人格也声明 mcpServers，合并结果是否会挤掉/重复 `codeg-mcp`（→ 委托能力失效） | 🟡 **未验** — 高风险，需真跑一次验证 |
| R3 | 同名人格在 user / project / local 三层并存时的优先级 | 🟡 未验 |
| R4 | `tools` 白名单若不含 ACP 侧注入的 `mcp__acp__*`，可能复现上游 issue #305（子代理无法写文件） | 🟡 未验 — 白名单需自动补齐 ACP 工具 |

~~R1~~ 已验（见上）。**R2 仍必须在写实现前用一次真实 session 实测**（§0.14 Gate 2）。

### 6.1 风险门禁（评审 F4：风险已记录但无可判定出口，已补）

| ID | 验证输入 | 通过判据 | 失败分支 |
|---|---|---|---|
| R2 | 真起一个 Claude ACP 会话，`_meta` 带 mcpServers | `codeg-mcp` 仍在工具列表且委派可用 | 🟢 **已验·风险不成立（2026-07-27）** — `acp-agent.js:4058` 合并为对象 spread 且 **ACP 侧后展开→胜出**；`codeg-mcp` 走 ACP 侧（`connection.rs:2486` `inject_codeg_mcp()` → `req.mcp_servers()`），SDK 侧为 `Record<name,cfg>` 非数组 → 无覆盖、无重复注册 |
| **R5** | **新增（R2 顺带发现）**：`disallowedTools` 是**数组拼接**（`acp-agent.js:4088`） | 黑名单不得含 `mcp__codeg-mcp__*` / 通配 | 🔴 **必须硬防** — 否则用户配工具限制会连带禁掉委派能力。实现需在应用层拦下并报错（不静默过滤） |
| **R6** | **新增（R2 推断，待动态验）**：`computeSessionFingerprint`（`acp-agent.js:128-131`）只对 `cwd` + **ACP 侧** `mcpServers` 取指纹，**不含 `_meta`** | resume 时只改 `_meta` 能否生效 | 🟡 **待验** — 直接影响 §3.4 快照复用设计。不生效 → resume 路径需重建 session 或改走 `set_config_option` |
| R3 | 同名人格在 user/project 并存 | 优先级与 adapter 一致 | 不一致 → 只支持 user 层，显式告知忽略 project 层 |
| R4 | 白名单不含 `mcp__acp__*` | 子代理能写文件 | 不能写 → 白名单**自动补齐** ACP 必需工具，并在 UI 明示（不静默扩权） |
| **R7** | **新增（recon · 与不变量 3 正面冲突）**：`apply_preferred_session_options`（`connection.rs:4288`）对每条偏好失败都是 log + skip，函数 doc 把这当特性（*"a stale/invalid preference can't block session startup"*） | 人格不得静默降级 | 🔴 **设计约束已定案** — 该语义管着 mode/model/effort/Grok 全部偏好，**不得修改**（改它=拿正确代码迁就新需求）。fail-closed 必须**新增独立校验闸门**，照仓库已有先例 `verify_kiro_selected_agent_exists`（`acp.rs:551`） |
| **R8** | **新增（recon）**：适配器用 `a.name` 比对人格（`acp-agent.js:4277`），Kiro 惯例是文件 stem | 传值与 catalog 的 `name` 一致 | 🟡 W0 验证中 — 传错则**静默回落 default**（`:4278`）；走 adapter catalog 自动避开 |
| **R9** | **新增（recon：评审 A2 唯一真实成立的子场景，原先漏了）**：远程 workspace（`remote_proxy.rs`）下本地扫描目录与**执行主机不一致** | UI 列表 = 实际启动环境 | 🟢 **走 adapter catalog 后自动消失**（又一条指向删除本地扫描） |
| **R10** | **新增（recon）**：`AgentDelegationDefaults` 加字段有两个静默陷阱——`is_empty()` 不同步会被 `clamped()` 丢弃；前端两处对象字面量不同步会静默覆盖 | 加字段后两处同步到位 | 🔴 executor 必须同步修正（否则字段默默丢失） |

**go/no-go**：~~R2 不通过~~ → **R2 已通过，开工硬门禁解除**。但新增 **R5 为必须硬防项**
（不能延后）、**R6 为 executor 验证项**。每项验证结果**回写本卡片** Update Log。

### 6.3 实现约束（R2 实测直接得出 · 不得偏离）

1. **只传 `disallowedTools`，不传 `mcpServers`**。后者唯一作用是「加额外服务器」，
   **无法用作限制已有服务器**（对象 spread 语义）——传了也没用，徒增风险面。
2. **黑名单必须拒绝 `mcp__codeg-mcp__*` 与通配**（R5）。在应用层校验时报错，
   **不得静默过滤**（静默过滤 = 用户以为禁了实际没禁，反方向误导）。
3. **不使用 `tools`**：它是**整体覆盖**（`acp-agent.js:4008`，非合并），一旦传入
   就必须显式列全内置工具集，漏一个就降能力。本期不碰。
4. **绝不使用 `allowedTools` 做限制**（R1 + R2 双路独立证实）：适配器对它**零引用**，
   会原样透传；而 SDK 语义是「免确认白名单」——用它限制 = 工具未受限反而全部免确认。

### 6.2 评审意见处置（R1 · 非全盘照收 · 逐条过筛）

| ID | 评审意见 | 处置 |
|---|---|---|
| A1 (P0) | 能力授权无闭环 | 🟢 **采纳** — 与 R1 实测独立发现同一根因（把透传参数当授权模型）。已加不变量 3 fail-closed + §3.2 语义表 + E2/E5/E6 验收。但**不**引入 `CapabilityPolicy` 值对象全套（§4.3 pragmatic restraint） |
| A2 (P1) | 多租户/服务器权限隔离缺失 | 🔴 **驳回** — 代码确认为既定单租户信任模型：`delegation/listener.rs:563` *"codeg's single-tenant trust model"* · `:565` *"one CODEG_TOKEN + one data dir across an operator's devices"* · `:1774` *"deliberate single-tenant scope"*。服务器模式 = 单运营者跳设备，非多租户 SaaS。补租户隔离 = 为不存在的场景加防御 |
| A3 (P1) | 人格双 SSOT | 🔴→🟢 **我原先判错，评审是对的（recon 2026-07-27 纠正）**。我以“与 Kiro 既定模式冲突”为由改了法，但 adapter 不只“应该”是权威——**它已经是了**，且 codeg 通用链路早已接好（见页首警告框）。本地扫描方案 = 造第二个 SSOT + 语义更窄 + 踩 R8 静默回落坑。待 W0 确认后删除 §3.1 相关工作 |
| A4 (P1) | 可恢复会话生命周期 | 🟢 采纳 → §3.4 快照表（不引入状态机） |
| A5 (P1) | 职责过度收缩到基础设施层 | 🟡 部分采纳 — 校验上提到应用层（§3.3）；但不为本期规模引入 `PersonaRef`/`CapabilityPolicy` 值对象层 → **登记为债**（第二个 adapter 需要同能力时再抽） |
| A6 (P1) | 委派字段悬空 | 🟢 采纳 → §3.3 完整契约 |
| F1 (P1) | 角色/流程矩阵缺失 | 🟡 部分 — 单租户下“角色”退化为单一运营者；仅保留入口区分（UI 创建 / LLM 委派 / 恢复）已入 §3.3 + §3.4 |
| F2 (P1) | best-effort 与限制承诺冲突 | 🟢 采纳 → 不变量 3 + §3.2 降级分支 |
| F3 (P1) | 验收不覆盖可观察结果 | 🟢 采纳 → §4.1 E1-E6 |
| F4 (P1) | 风险无决策出口 | 🟢 采纳 → §6.1 门禁表 |
| F5 (P2) | 悬空引用/编号 | 🟢 采纳 — 不变量编号已补 `3.`、`见任务 4` 已改为实体契约、`§5.4` 改为“真实世界压力” |

---

## 📋 实施顺序

1. ~~实测 R1~~（已完成）· 实测 R2（真起一次 Claude ACP 会话，抓 `session/new`
   报文 + 验证 `codeg-mcp` 是否存活）。
2. 红：写测试 1-3。
3. 绿：扩展 `claude_raw_sdk_session_meta()`。
4. 人格枚举：`list_claude_custom_agents()` 对齐 Kiro 形状 + 测试 4-6。
5. 注册清单逐项打勾（双模式对等 + i18n）。
6. 变体复扫：`git grep` 确认 load/resume（2172/2193）与 new 行为一致。
7. 写回 CHANGELOG + ARCHITECTURE 演进索引。

## Update Log

- 2026-07-27 卡片落盘（尚未写任何业务代码）。
- 2026-07-27 R1 实测闭环：`agent`/`agents` 两键独立（SDK 0.3.219 实物）；
  **纠正原稿把 `allowedTools`/`tools` 当会话级白名单的错误** —— `allowedTools`
  语义是「免确认」而非「收窄」，误用会让工具全部免确认（安全方向相反）；
  白名单只能落在 `AgentDefinition.tools`（人格级）。§3.1 / §3.2 已就地重写。
  新增发现：`agents` 支持编程式定义 → codeg 可自带内置人格，不依赖用户文件系统。
- 2026-07-27 R1 评审（codex · `review.codex.md` · NEEDS_CHANGES · 1×P0 + 9×P1）
  逐条过筛后修订完成，处置明细见 §6.2。主要变更：
  ① 新增不变量 3（显式配置 fail-closed），作废原稿的笼统 best-effort 降级；
  ② §3.3 补齐委派字段完整契约（原为“见任务 4”悬空引用）；
  ③ 新增 §3.4 会话快照生命周期、§4.1 端到端验收 E1-E6、§6.1 风险 go/no-go 门禁；
  ④ **驳回 A2**（多租户隔离）——代码已明确单租户信任模型（listener.rs:563/565/1774），
     评审器看不到代码把“服务器模式”默认当成多租户 SaaS；
  ⑤ **A3 改法不同**——保留 Kiro 既定本地扫描模式 + 加契约测试，而非改为 adapter 权威；
  ⑥ **A5 登记为债**——不为本期规模引入值对象层。
  剩余 P0 = 0；本卡片具备开工条件，但 **R2 实测仍为硬门禁**。
- 2026-07-27 **R2 实测闭环（sub 静态源码核实）：风险不成立，开工硬门禁解除**。
  `acp-agent.js:4058` 合并为对象 spread、ACP 侧后展开胜出；`codeg-mcp` 走 ACP 侧
  （`connection.rs:2486`），与 `_meta` 分居合并表达式两侧 → 不会被挤掉/重复注册。
  **但风险落点发生转移**，新增两项：
  • **R5（必须硬防）**：`disallowedTools` 是**数组拼接**（`acp-agent.js:4088`），
    黑名单写 `mcp__codeg-mcp__*` / 通配 会**直接禁掉委派工具本身** → 应用层拦下报错。
  • **R6（待动态验）**：`computeSessionFingerprint`（`:128-131`）不含 `_meta`，
    resume 时只改 `_meta` 可能不生效 → 直接影响 §3.4 快照复用设计。
  双路独立证实 `allowedTools` 不可用作限制（适配器零引用 + SDK 语义为免确认）。
  新增 §6.3 实现约束四条 + §4.1 验收 E7/E8。
- 2026-07-27 **plan-reality-recon 侦察回报（`claude-persona-tools-recon.md`）：
  卡片锤点 5/5 全命中无漂移，但人格部分实现计划被推翻**。
  • **判对的**：单租户——另有 3 条不依赖注释的结构证据（conversation 表无
    user_id/workspace_id/owner_id、服务器鉴权为全局单 CODEG_TOKEN、tenant 仅命中
    飞书 API 名词）；且上一轮 delegation-continue-session 对同一评审意见有同样驳回记录。
  • **判错的（A3）**：adapter 已作为人格权威 catalog 下发，codeg 通用链路已通。
    → §3.1 的 `list_claude_custom_agents()` + 5 注册点 + i18n×10 疑为多余，待 W0 定案。
  • **新增 R7-R10**（见 §6.1）：R7 静默 skip 语义冲突 · R8 name vs stem 静默回落 ·
    R9 远程主机扫错（评审 A2 唯一真实子场景，原先漏了）· R10 加字段静默丢弃。
  • **其他约束**：migration 当前最大编号 `m20260717_000001_folder_alias` → 本日应为
    `m20260727_000001_*`；`automation` 表已有「单 JSON 列存启动快照」范式
    （`entities/automation.rs:53`），比每维度开一列更省。
  • **工作包**：8 包 · 峰值并行 3 · 最长串行链 W2→W3→W4→W7。
- 2026-07-27 **W0 分流验证已派发**（验证命题 P：人格下拉是否已可用）。
  **结果未回前不得开始写人格部分实现**（可能在造一个已存在的功能）。
  工具限制（§3.2 `disallowedTools`）不受此影响，仍需实现。
- 2026-07-27 **W0 定案（`claude-persona-tools-w0-verify.md`）：命题 P ✅ 完全成立。**
  • **实跑证据**：同构 ACP 握手 → `configOptions` 含 `agent` 项 + 本机 9 个人格；
    `set_config_option{configId:"agent",value:"debugger"}` → `currentValue:"debugger"` 生效。
    codeg 侧五跳无按 id 过滤（`connection.rs:1351` 只判 kind==Select）。
    诚实边界：UI 渲染为“读完全链路无过滤”的高置信度推断，未起全栈看像素。
  • **决定性新证据**：本机 9 个人格中 4 个在**嵌套子目录**，adapter 9/9 全中，
    而照搬 Kiro 的单层 `read_dir` **会漏 44%** —— 自建方案是功能更差的并行实现。
  • **删除 10 项**：`list_claude_custom_agents()` / `ClaudeCustomAgent` / tauri command /
    `lib.rs` 注册 / web handler / router / `api.ts` / `types.ts` 镜像 / i18n×10
    （`customAgent*` 6 key）/ 相关测试 4 项 + A3 对账契约测试。人格快照降为可选。
  • **R8 澄清**：`acp-agent.js:4731` 是 `value: a.name`，codeg 原样搬运回传 → adapter
    在自己刚吐的 options 里 `find(o=>o.value===params.value)` 必然命中（实跑印证）。
    静默回落**只存在于 `_meta.claudeCode.options.agent` 路**。本机 stem==name 纯属巧合，
    换机才炸 → 潜伏 bug 比立即失败更危险。**写死：人格不走 `_meta`**。
  • **`disallowedTools` 零影响**：全仓 grep 退出码 1 零命中，工作量全额保留；
    R5 硬防 + R10 两个静默陷阱仍全部适用。
  • W0 自证：临时夹具已删，`git status` 确认 0 行业务代码改动。
