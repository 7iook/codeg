# Claude 子代理人格 + 工具限制 — 侦察报告（plan-reality recon）

> 侦察对象：`claude-persona-tools-decision.md`（决策卡，含 R1 实测与评审处置）
> 侦察范围：只读核对，未改任何业务代码。
> 证据强度约定：**[读到]** = 直接引用了该 file:line 的源码/注释；**[推断]** = 由读到的代码推导，未实跑验证；**[需实现方核实]** = 本轮无法用静态阅读定案。
> 检索手段：`git grep`（trio 语义检索的等价能力）+ `desktop-commander read_file` 实读 + `git log -L` 考古 + 实读已安装适配器 `D:\Devtool\npm-global\node_modules\@agentclientprotocol\claude-agent-acp\dist\acp-agent.js`（与 registry 钉住的 0.62.0 同一包，见证据 2.8）。

---

## 0. 一句话结论（先看这条）

卡片的代码锚点**全部准确**（5/5 命中，行号无漂移）；两个争议判断中**单租户判定成立**（有独立证据链），**「人格枚举谁做权威」这条卡片判错了** —— 适配器**已经**通过标准 ACP `configOptions` 通道下发了一个 `id="agent"` 的人格选择器，而 codeg 的通用映射层**已经把它渲染成选择器、已经能 `set_config_option` 切换、已经按 agentType 持久化到 localStorage 并在 connect 时回灌**。也就是说：**「用户在 codeg 里选 Claude 人格」这个能力，很可能今天就已经可用，不需要新增 `list_claude_custom_agents()`。** 这直接改变工作包拆分（详见 §3.2 / §4.1 / §6）。

---

## 1. 卡片假设清单（可被现实推翻的部分）

| # | 卡片假设 | 出处 |
|---|---|---|
| H1 | `claude_raw_sdk_session_meta()` 是唯一 `_meta.claudeCode` 注入点 | §2 表格 |
| H2 | `build_new_session_request` / load / resume 三处同形，调用者 3449/3527 | §2 表格 |
| H3 | Kiro 人格枚举形状可照搬（tauri cmd / web handler / router / api.ts / i18n 全套） | §2 表格、§5 注册清单 |
| H4 | `AgentDelegationDefaults` 已有 `mode_id` + `config_values`，人格走 `config_values["agent"]` 无需改结构 | §3.3 |
| H5 | `preferred_config_values` → `set_config_option` 链路已存在 | §2 表格 |
| H6 | codeg 是刻意的单租户信任模型，故驳回多租户隔离（A2） | §6.2 A2 |
| H7 | 保留「codeg 本地扫描 `~/.claude/agents/*.md`」为人格真源，不采纳 adapter 权威 catalog（A3） | §6.2 A3 |
| H8 | 人格/限制需作为「启动快照」持久化到 conversation 行，load/resume 复用 | §3.4 |
| H9 | `persona` / `requestedAgent` / `custom_agent`（Claude 侧）全仓无命中 = 本功能确为新增 | §2 表格 |
| H10 | 会话级只能做黑名单（`disallowedTools`），白名单必须落到人格定义 | §3.2 |

---

## 2. 现实核对（plan vs reality）

### 2.1 H1 `_meta.claudeCode` 唯一注入点 — ✅ [匹配]

- `src-tauri/src/acp/connection.rs:2136` `fn claude_raw_sdk_session_meta(agent_type: AgentType)`，行号**精确命中**。[读到]
- 函数体只塞 `emitRawSDKMessages: true`（`:2145`），并在 `agent_type != AgentType::ClaudeCode` 时 `return None`（`:2140`）。卡片描述准确。[读到]
- 全仓 `claudeCode` 字面量在 Rust 侧仅 4 处：`:2145` / `:2151` 构造，`:8242` / `:8479` / `:8555` 测试断言。**无第二个注入点**。[读到]（`git grep -e "claudeCode" -e "emitRawSDKMessages" -e "\.meta(" -- src-tauri/src src`）
- 另 3 处 `.meta(...)`（`:3146` / `:3261` / `:4995`）是把 **agent 返回的** `resume_resp.meta` / `load_resp.meta` / `fork_resp.meta` 写回 SessionState，是**读回**方向，不是发出方向。卡片没提但不冲突。[读到]
- 考古（`git log -L 2136,2160`）：该函数由 `f9923df1 feat(acp): surface Claude API retry state in chat input` 引入（原始意图 = 打开 raw SDK 消息以拿到 Claude 的 retry 状态），随后 `ec53b890 fix(mcp): forward MCP server config to agent sessions` 给三个 build 函数加了 `mcp_servers` 参数。**原始意图是「拿到更多可观测信息」，不是「下发能力配置」** —— 在这里挂人格/权限属于职责扩张，与评审 A5 的关切同源；不阻塞，但值得在 spec 里显式说明。[读到]

### 2.2 H2 三个同形构造函数 + 调用者 — ✅ [匹配]

- `:2157` `build_new_session_request` / `:2172` `build_load_session_request` / `:2193` `build_resume_session_request`，三处行号**全部精确命中**。[读到]
- 调用者：`build_new_session_request` 在 `:3449` 与 `:3527`（卡片写的 3449/3527 准确）；另有 `build_resume_session_request` @ `:3134`、`build_load_session_request` @ `:3247`。**卡片只列了 new 的调用者，load/resume 的调用点（3134/3247）未列** —— 补充如上。[读到]
- resume 版的 doc comment（`:2189-2192`）明确记录了唯一线格差异：`ResumeSessionRequest.mcp_servers` 带 `skip_serializing_if = Vec::is_empty`。改这三处时需注意这条既有约定。[读到]

### 2.3 H3 Kiro 人格枚举的完整落点 — ✅ [匹配]，落点比卡片列的更全

- `src-tauri/src/commands/acp.rs:4365` `pub struct KiroCustomAgent`（字段仅 `id` + `description`）、`:4380` `list_kiro_custom_agents()`、`:4386` `list_kiro_custom_agents_at(dir)`（测试注入）。行号**精确命中**。[读到]
- 完整落点（`git grep`，比卡片 §5 注册清单多两项）：

| 层 | 位置 | 状态 |
|---|---|---|
| tauri command | `src-tauri/src/commands/acp.rs:9449 acp_list_kiro_custom_agents` | ✅ |
| invoke_handler 注册 | `src-tauri/src/lib.rs:1144` | ✅ |
| web handler | `src-tauri/src/web/handlers/acp.rs:240` | ✅ |
| router | `src-tauri/src/web/router.rs:757-758` | ✅ |
| 前端 api client | `src/lib/api.ts:540 acpListKiroCustomAgents()` | ✅ |
| 前端类型镜像 | `src/lib/types.ts:1978 KiroCustomAgent` | ✅ |
| UI 消费 | `src/components/settings/kiro-config-panel.tsx:190/205/223` | ✅（**卡片未列**） |
| UI 测试 | `src/components/settings/kiro-config-panel.test.tsx`（10+ 断言） | ✅（**卡片未列**） |
| 启动期校验 | `src-tauri/src/commands/acp.rs:554 verify_kiro_selected_agent_exists()` | ✅（**卡片未列，但这是不变量 3 的现成前例**） |
| i18n | `en/zh-CN/ar/...:766-771` `customAgentLabel` 等 6 个 key | ✅ |

- 特别值得照搬的是 `verify_kiro_selected_agent_exists`（`acp.rs:551-579`）：它的 doc comment 已经把卡片不变量 3 的理由写了 ——「*Deliberately an ERROR rather than a silent fall back … a custom agent carries its own prompt and tool allowlist, so quietly running a different one would change both what the agent is told to do and what it is allowed to touch, with no signal to the user*」。**卡片的 fail-closed 不是新原则，是仓库既有约定**，这加强了不变量 3 的正当性。[读到]

### 2.4 H4 `AgentDelegationDefaults` — ✅ [匹配]

- `src-tauri/src/acp/delegation/types.rs:26`（注释块起）/ `:28`（struct 定义）：`mode_id: Option<String>` + `config_values: BTreeMap<String, String>`，两字段，`#[serde(default, skip_serializing_if=...)]` 齐备。卡片描述准确。[读到]
- 配套 `is_empty()`（`:35-38`）被 `DelegationSettings::clamped()`（`commands/delegation.rs:97-101`）用于剔空条目。**加第三个字段 `disallowed_tools` 必须同步更新 `is_empty()`**，否则一个只含 `disallowed_tools` 的条目会被 clamped 静默丢弃 —— 卡片 §3.3 未提这一点。[读到 + 推断]
- 前端对称落点：`src/components/settings/delegation-agent-defaults.tsx:150/186` 手工构造 `{ mode_id, config_values }` 两处对象字面量；加字段需同步（TS 结构化类型不会报错，会**静默丢字段**）。[读到]

### 2.5 H5 `preferred_config_values` → `set_config_option` 链路 — ✅ [匹配]，链路比卡片写的更长

`spawner.rs:69` 的 doc 准确（`preferred_config_values` — applied via `session/set_config_option`）。完整链路（全部 [读到]）：

```
delegation UI (delegation-agent-defaults.tsx)
  → DelegationSettings.agent_defaults (commands/delegation.rs:72, 持久化 app_metadata KEY=delegation.agent_defaults :43)
  → DelegationConfig.agent_defaults (broker.rs:243)
  → broker.rs:2697 / 4236 取出 (mode_id, config_values)
  → ConnectionSpawner::spawn(..., preferred_config_values) (spawner.rs:89)
  → ConnectionManager::spawn_agent(..., preferred_config_values) (manager.rs:399)
  → spawn_agent_connection(..., preferred_config_values) (connection.rs:1002)
  → apply_and_emit_session_config_options (connection.rs:2054) 【new: 3471/3549 · load: 3332 · resume: 3172 四条路径都过】
  → apply_preferred_session_options (connection.rs:4238)
  → set_session_config_option_inner → "session/set_config_option" (connection.rs:4177)
```

关键实现细节（卡片未覆盖，直接影响不变量 3）：**`apply_preferred_session_options` 对失败是「log + skip」，不是 fail-closed** ——
`connection.rs:4288-4292`：`Err(e) => tracing::error!("[ACP] failed to apply preferred config '{config_id}'='{value_id}' on connect: {e}")`，
并且函数 doc（`:4235-4236`）明写「*Failures on individual preferences are logged and skipped so a stale/invalid preference can't block session startup*」。
→ **卡片的不变量 3（显式配置 fail-closed）与这条既有设计直接冲突。** 若人格走 `preferred_config_values` 路径，当前实现会**静默降级**成 default 人格。这是本次侦察发现的最实质的现实约束之一（见 §3.1）。[读到]

### 2.6 H9 「Claude 侧 persona/disallowedTools 全仓无命中」 — ✅ [匹配]

- `git grep -e "disallowedTools" -e "disallowed_tools" -e "allowedTools" -- src-tauri/src src` → **零命中**。卡片的 verified absent 成立。[读到]
- `currentAgent` 在 codeg 侧零命中（前端仅有无关的 `currentAgentType`，`skills-settings.tsx:656`）。[读到]

### 2.7 H10 「会话级只能黑名单」 — ✅ [匹配]，并在适配器源码里得到二次确认

实读适配器 `acp-agent.js`（版本对齐见 2.8）：
- `:4006-4010`：`const tools = userProvidedOptions?.tools ?? (params._meta?.disableBuiltInTools === true ? [] : { type: "preset", preset: "claude_code" })` —— `tools` 确实被适配器直接透传给 SDK 顶层 `Options`，缺省即 `claude_code` preset。卡片不变量 2 描述准确。[读到]
- `:4088`：`disallowedTools: [...(userProvidedOptions?.disallowedTools || []), ...disallowedTools]` —— **合并语义确认**（适配器自己会在客户端不支持 form elicitation 时追加 `"AskUserQuestion"`，见 `:4004`）。[读到]
- `:4042` `...userProvidedOptions`（整体展开进 SDK `options`）→ 任何 `_meta.claudeCode.options` 的键都会进 SDK options，包括 `agent`。[读到]

### 2.8 适配器版本对齐

- codeg 钉住 `@agentclientprotocol/claude-agent-acp@0.62.0`（`src-tauri/src/acp/registry.rs:213`、`:665`）。[读到]
- 我实读的文件 `D:\Devtool\npm-global\node_modules\@agentclientprotocol\claude-agent-acp\dist\acp-agent.js` 大小 339203 字节，与卡片 R1 解包的临时目录 `C:\Users\7\AppData\Local\Temp\acp062\package\dist\acp-agent.js` **字节数完全一致（339203）**（`everything-search` 结果）→ 同一版本，我的引用与卡片 R1 的引用可互相对齐。[读到 + 推断：仅比对了大小，未做哈希]

---

## 3. 两个争议判断的独立复核

### 3.1 单租户信任模型（卡片驳回 A2）— ✅ **判定成立**，且有卡片未引用的独立证据

卡片引用的三处注释我逐条核实，**全部准确**：

- `src-tauri/src/acp/delegation/listener.rs:563`：*"This is sound in codeg's single-tenant trust model: there is no per-user isolation anywhere"*。[读到]
- `:565`：*"server mode shares one `CODEG_TOKEN` + one data dir across an operator's devices"*。[读到]
- `:1774`：测试 doc *"Accepted-policy coverage (deliberate single-tenant scope): a single valid token resolves ANY non-deleted session id"*，并有对应测试 `session_info_resolves_any_session_id_not_just_referenced`（三个无关 id 用同一 token 全部解析成功）。[读到]

**注释是自证的，我另找了三条不依赖注释的结构证据（这才是关键）：**

1. **数据模型无所有者维度**：`src-tauri/src/db/entities/conversation.rs:39-68` 完整字段表里**没有** `user_id` / `workspace_id` / `owner_id`；`git grep -e "user_id" -e "workspace_id" -e "owner_id" -- src-tauri/src/db` **零命中**（整个 db 层，不只 conversation 表）。[读到]
2. **鉴权是单个全局 bearer**：`src-tauri/src/bin/codeg_server.rs:203-217` —— 单个 `CODEG_TOKEN`，未设置时**自动生成并持久化一个**，打印到 stderr 让运营者自取。没有用户表、没有登录、没有 per-principal 概念。持有 token = 全权。[读到]
3. **`tenant` 关键词全仓无业务命中**：`git grep tenant -- src-tauri/src` 只命中 ① `chat_channel/backends/lark.rs` 的飞书 `tenant_access_token`（第三方 API 名词，无关）② `paths.rs:59` 一句注释 *"To bound the long-term footprint on shared / multi-tenant servers, operators can set CODEG_UPLOAD_MAX_TOTAL_BYTES"*。[读到]

**关于第 ③ 条的诚实说明（唯一的"反例候选"）**：`paths.rs:59` 确实出现了 "multi-tenant servers" 字样。但读完上下文（`:50-75`），它说的是「**多人共用一台服务器时磁盘占用会涨**，所以给运营者一个总量上限开关」，紧接着 `:63-70` 明确写 *"codeg is designed for single-process deployments; horizontal scaling would require external coordination … that this codebase does not provide"*。**这是容量运维语境，不是身份隔离语境，且同一段落再次自陈单进程设计。** 不构成反例。[读到]

另一条值得记录的独立佐证：仓库里已有一次同题裁决 —— `docs/specs/delegation-continue-session/design.md:390` 与 `:402` 记录了上一轮（delegation-continue-session）**同一评审器提出同一条 A3 多租户意见、被同样以「codeg 单用户单租户」驳回**，理由链与本卡片一致。[读到]

> **结论：H6 成立。** 评审 A2 的驳回是正确的。**但有一条可落地的残余**（与上一轮 spec 的处置一致）：单租户不等于「人格列表可以裸奔」—— 服务器模式下扫描的是 `codeg-server` **进程用户**的 `~/.claude/agents/`，而 ACP 子进程也由同一进程 spawn，所以 **UI 列表与执行环境天然同源**，A2 担心的「扫错主机」在当前架构下不成立（远程 workspace 例外，见 §4.4）。这一点建议在 spec 里用一句话写清依据，而不是留白。

### 3.2 「人格枚举谁做权威」（卡片 A3 处置：保留 Kiro 本地扫描模式）— 🔴 **卡片判错了，这是本次侦察最重要的发现**

**先答卡片问的两个子问题：**

**(a) Kiro 本地扫描的健壮性 — 确实健壮，卡片这半句是对的。** `commands/acp.rs:4386-4437` 逐条读：
- 目录不存在 → `let Ok(entries) = read_dir(dir) else { return Vec::new() }`（`:4387-4390`，注释：*"Missing directory is the common case on a fresh install"*）。[读到]
- 非文件 / 非 `.json`（大小写不敏感）→ skip（`:4394-4406`）。[读到]
- 文件名 stem 空 → skip（`:4408-4413`）。[读到]
- 读不出 / JSON 语法错 → `tracing::warn!` + 只跳过这一个（`:4415-4423`，注释：*"a syntax error there must not hide their other agents"*）。[读到]
- description 截断 300 字符（`:4425-4430` + `KIRO_AGENT_DESCRIPTION_CAP: usize = 300` @ `:4442`）。[读到]
- 结果按 id 排序（`:4436`，*"Stable order so the dropdown does not reshuffle"*）。[读到]
- **同名冲突：不存在** —— 因为标识是文件 stem，单目录内文件名天然唯一（Kiro 只扫一层 `<KIRO_HOME>/agents/`）。**注意这条不能外推到 Claude**：Claude 适配器读 user/project/local **三层**（`acp-agent.js:4040` `settingSources: ["user","project","local"]`），三层同名是真实可能的（卡片 R3 未验，正确地标为未验）。[读到]
- 测试覆盖：`acp.rs:10860-10904`（畸形文件 / 目录缺失 / 空目录三种边界），卡片引用的行号准确。[读到]

**(b) ACP 侧是否真有现成 catalog 通道 — 有，而且已经通了，卡片说「无」是错的。**

实读适配器 `acp-agent.js`：

| 证据 | 内容 |
|---|---|
| `:4589-4595` | `export const AGENT_CONFIG_ID = "agent"` —— 人格是一个**标准 ACP session config option**，id 就是 `"agent"`，与 `mode`/`model`/`effort`/`fast` 并列 |
| `:4269` | `const agents = await discoverCustomAgents(q)` 在 `session/new` 处理里被调用 |
| `:4722-4739` | `buildConfigOptions` 把它拼成 `{ id: "agent", name: "Agent", description: "Main-thread agent persona", type: "select", currentValue, options: [{value:"default",name:"Default"}, ...agents.map(a => ({value: a.name, name: a.name, description: a.description}))] }` —— **完整 catalog，带 name + description，随 `session/new` 响应的 `configOptions` 直接返回给客户端** |
| `:4724-4726` | 且**仅在** `agents.length > 0` 时才出现该选项（没配自定义人格就不出现，注释明说） |
| `:3757-3768` | `session/set_config_option` 收到 `configId === "agent"` 时 → `applyFlagSettings({ agent: value === "default" ? null : value })` + 更新 `session.currentAgent` + 更新 `configOptions`。注释：*"Live agent switch — no subprocess restart needed"*，且*"Apply the SDK flag first so a rejected control request leaves both `currentAgent` and the config option untouched (no UI/SDK desync)"* |
| `:4276-4278` | `_meta.claudeCode.options.agent` 也被接受（卡片 R1 已验），并与 discover 列表核对后落到 `currentAgent`；不在列表内则**静默回落 `DEFAULT_AGENT_ID`** |

**而 codeg 这一侧，这条通道已经全线打通（不是要新建）：**

| 环节 | 位置 | 状态 |
|---|---|---|
| 接收 `configOptions` | `connection.rs:3453`（new）/ `:3257`（load）/ `:3142`（resume）取 `*_resp.config_options` | ✅ 已有，与 agent 类型无关 |
| 通用映射（Select→前端结构，保留 id/name/description/options） | `connection.rs:1352 map_session_config_option` + `:1394 map_session_config_options` | ✅ 已有，**无 Claude 专属分支** |
| 下发事件 | `connection.rs:1464 emit_session_config_options_values` → `AcpEvent::SessionConfigOptions` | ✅ 已有（仅 Codex 有个 `ensure_codex_mode_option` 补丁分支 `:1419`，Claude 走原样） |
| 前端渲染 | `message-input.tsx:2690-2720`（内联）/ `:2795-2802`（折叠面板）—— 遍历 `availableConfigOptions` 任意 `select` 选项，`isModelConfigOption`（`model-config-groups.ts:20`）只影响是否分组/搜索，非白名单 | ✅ 已有，**任何 id 都会渲染** |
| 用户切换 → 回写 agent | `acp-connections-context.tsx:4508-4522 setConfigOption` → `acpSetConfigOption` → `acp_set_config_option`（`api.ts:217`） | ✅ 已有 |
| 持久化偏好（按 agentType） | `acp-connections-context.tsx:4520 saveConfigPreference` → `lib/selector-prefs-storage.ts:113-123` localStorage `codeg:selector-prefs` | ✅ 已有 |
| 下次 connect 回灌 | `acp-connections-context.tsx:4212-4219 getSavedPrefsForConnect` → `acpConnect(..., savedPrefs.configValues)` → `preferred_config_values` → `apply_preferred_session_options`（`connection.rs:4238`） | ✅ 已有 |

**推论（[推断]，需一次实跑确认）**：只要用户 `~/.claude/agents/` 下有 ≥1 个自定义人格，**当前版本的 codeg 打开一个 Claude 会话，composer 的选择器里应该已经多出一个 "Agent" 下拉，能选人格、能切换、并且选择会被记住并在下次连接时自动应用。** 全链路无一处需要新代码。

→ **卡片 §3.1 计划新建的 `list_claude_custom_agents()` + tauri command + web handler + router + api.ts + types.ts + i18n 这一整套，很可能是在造第二个 SSOT**（本地扫 `~/.claude/agents/*.md` 的 frontmatter vs 适配器 `q.supportedAgents()`），而且两者语义不等价：

| 维度 | codeg 本地扫描（卡片计划） | 适配器 catalog（已存在） |
|---|---|---|
| 来源层 | 只 user 层（`~/.claude/agents/`） | user + project + local 三层（`:4040`） |
| plugin 提供的人格 | 扫不到 | 能拿到（`discoverCustomAgents` doc 明写 *"user/plugin/project-configured"*） |
| 内置 subagent 过滤 | 需自己实现 | 已过滤（`BUILTIN_AGENT_NAMES` @ `:4563`：claude / general-purpose / Explore / Plan / statusline-setup） |
| `default` 哨兵冲突 | 需自己处理 | 已排除（`:4583`，注释说明同名会与哨兵撞车） |
| 标识 | 文件 stem（Kiro 惯例） | `a.name`（SDK 报的 name，**不是文件名**） |
| 一致性 | 需契约测试维持 | 天然一致（就是执行方自己报的） |

**注意最后一行的标识差异是硬伤**：Kiro 的「文件 stem = 标识」惯例**不能照搬到 Claude** —— 适配器用 `a.name` 与 `requestedAgent` 比对（`:4277` `agents.some(a => a.name === requestedAgent)`），而 `~/.claude/agents/*.md` 的 `name` 来自 frontmatter，可以与文件名不同。照搬 Kiro 形状 = 传文件名 → 适配器匹配不上 → 静默回落 default（`:4278`）。**卡片 §3.1「扫描 ~/.claude/agents/*.md（frontmatter: name/...）」的形状与「对齐 KiroCustomAgent」的指示自相矛盾**（前者暗示用 frontmatter name，后者的既定语义是文件 stem）。[读到 + 推断]

> **结论：H7 不成立。** 评审 A3 的方向（让 adapter 返回权威 catalog）是对的，且**代价近乎为零 —— 不是"改成 adapter 权威"，而是"发现它已经是 adapter 权威了"**。卡片以「与 Kiro 既定模式冲突」为由保留本地扫描，代价是：多一套解析、多 6 个注册点、多 10 语言 i18n、多一组契约测试，换来的是一个语义更窄且标识可能对不上的并行实现。
>
> **建议的改法**（决策权在主 AI / 用户）：本期人格部分改为「**验证既有通道 + 补 UX**」，不新建枚举 API。若实跑确认已可用，则人格能力的真实缺口只剩：① 选择器可能需要更好的标签/i18n（当前显示适配器给的英文 "Agent"）；② 委派子代理时人格默认值 —— 而这个**通过 `AgentDelegationDefaults.config_values["agent"]` 也已经能配**（`delegation-agent-defaults.tsx` 的 UI 是**实探 probe** 出来的选项：`manager.rs:1659 probe_agent_options` doc 明写 *"with the guarantee that what the UI shows is exactly what codeg-mcp will pass through to session/set_config_option"*）。→ **H4 不仅成立，而且比卡片说的更强：委派侧人格能力可能也已经是现成的。**

---

## 4. 卡片未覆盖的现实约束

### 4.1 不变量 3（fail-closed）与既有「log & skip」设计正面冲突 —— 最需要先裁决的一条

如 §2.5 所述，`apply_preferred_session_options`（`connection.rs:4238`）对每一条偏好的失败都是 `tracing::error!` + 继续，doc 明确把这当**特性**（*"so a stale/invalid preference can't block session startup"*，`:4235`）。而适配器侧对未知人格也是静默回落（`acp-agent.js:4278`）。

**两条链路各自的失败行为（都是 [读到]）：**

| 路径 | 人格不存在时 | 与不变量 3 |
|---|---|---|
| `_meta.claudeCode.options.agent`（卡片 §3.1 用法 A） | 适配器 `:4277-4278` 静默回落 `default` | ⛔ 违反 |
| `set_config_option("agent", x)`（既有链路） | 适配器 `:3129` `const option = session.configOptions.find(o => o.id === params.configId)` → 找不到会走错误分支（**未细读该分支，[需实现方核实]**）；codeg 侧 `:4288` 捕获后 log & skip | ⛔ 违反（codeg 侧吞掉） |
| Kiro 的做法（现成前例） | `verify_kiro_selected_agent_exists`（`acp.rs:551`）在 **`build_agent` 阶段（连接前）** 报错，列出可用项 | ✅ 符合 |

**约束**：要实现不变量 3，**不能只改 `_meta` 或只依赖既有偏好链路**，必须像 Kiro 那样在**启动前**加一道显式校验闸门；或者显式修改 `apply_preferred_session_options` 的失败语义（**这会影响 mode/model/effort/Grok 等所有既有偏好**，属于跨切面改动，风险远超本功能范围）。**推荐前者**（新增独立校验点，不动既有 log&skip 语义）—— 但这要求 codeg 侧能先拿到权威人格列表，又回到 §3.2 的结论：**校验数据源应当来自适配器 catalog，而非本地扫描**。若走 `set_config_option` 路径，权威列表就是 agent 刚返回的 `configOptions[id="agent"].options`，**校验可以变成纯本地比对，零额外 IO**。[读到 + 推断]

### 4.2 conversation 表 / migration 编号（卡片 §3.4 的持久化前提）

- **现有字段**（`src-tauri/src/db/entities/conversation.rs:41-68`，全部 [读到]）：`id` / `folder_id` / `title` / `title_locked` / `agent_type` / `status` / `kind` / `model` / `git_branch` / `external_id` / `parent_id` / `parent_tool_use_id` / `delegation_call_id` / `message_count` / `created_at` / `updated_at` / `deleted_at` / `pinned_at`。**没有任何「启动配置快照」字段**（`model` 是单值，非快照）。
- **要不要 migration：要**。SeaORM entity 与表结构强绑定，新增列必须 migration。
- **编号规则（实测全局占用，非凭直觉）**：`src-tauri/src/db/migration/` 共 26 个文件，格式 `m<YYYYMMDD>_<NNNNNN>_<snake_name>.rs`；**目前最大 = `m20260717_000001_folder_alias`**（`git ls-files` + `list_directory` 双核对）。同日多个用序号递增（前例：`m20260424_000001_folder_color` / `m20260424_000002_quick_message`）。→ **本任务若在 2026-07-27 落地，编号应为 `m20260727_000001_<name>`**（当日无占用，已核实）。[读到]
- **两处必须同步注册**（漏一处 migration 不会跑）：`migration/mod.rs:3-27` 的 `mod` 声明 + `:34-60` 的 `migrations()` vec。[读到]
- **既有 ALTER TABLE 模板**：`m20260610_000001_conversation_pinned_at.rs`（nullable、无 default、无需回填、带 `down()` drop_column、附带 `#[cfg(test)]` 测试）。照抄这个即可。[读到]
- **⚠️ 有一个更省的替代方案（卡片未考虑）**：`automation` 表已经用**单个 `config: Text` 列存整个「启动快照 JSON」** —— `entities/automation.rs:53-56`：*"JSON snapshot of the captured composer state (prompt blocks, mode, config values, label cache). Replayed wholesale at fire; never parsed for queries."*，对应 Rust 结构 `models/automation.rs:80-82` 就有 `mode_id` + `config_values`。**这是仓库里「启动快照」的既有范式，且已包含人格所需的 `config_values`。** conversation 侧若加快照，建议照此范式（一个 `launch_config: Option<Text>` JSON 列），而不是给人格/工具限制各开一列 —— 后者每加一个维度都要一次 migration。[读到]

### 4.3 双模式对等：Kiro 那套确实两侧都注册了；但仓库里有「只加桌面侧」的先例风险点

- Kiro 人格：tauri（`lib.rs:1144`）+ web handler（`web/handlers/acp.rs:240`）+ router（`web/router.rs:757`）**三处齐全**，无遗漏。[读到]
- 同样对等的还有 `acp_describe_agent_options`：`lib.rs:1108` + `web/handlers/acp.rs:407` + `web/router.rs:639`。[读到]
- **我没有找到「只加桌面侧」的实际先例**（未做全量 invoke_handler vs router 差集比对，**[需实现方核实]** 若要确证需写一个对账脚本）。但仓库的条件编译约定（`CLAUDE.md`「`_core` 后缀函数供两种模式共用」）本身就是为防这类漏注册而设，且 Kiro 的 web handler doc（`handlers/acp.rs:236-238`）显式说明了「无参数、不读凭据、不受 Kiro credential gate 约束」——说明作者在两侧对等上是自觉的。
- **真正的对等风险不在注册，而在 §3.2 的结论下反而消失了**：走既有 `configOptions` 通道，双模式天然对等（同一 `_core` 路径 + 同一 WS/事件桥），**不需要新增任何 handler/router 条目**。这是「不新建 API」方案的额外收益。[推断]

### 4.4 远程 workspace（卡片完全未覆盖）

`src-tauri/src/commands/remote_proxy.rs:74` / `:83` / `:313` 显示存在**远程 workspace 代理**，且 `describeAgentOptions` 的探测会跨代理转发（*"the longest today is 70s for describeAgentOptions"*）。→ 若人格列表由 codeg **本地**扫描 `~/.claude/agents/`，而 ACP 进程跑在**远端**主机，**列表与执行环境会不一致** —— 这正是评审 A2「扫错主机」担忧的**唯一真实成立场景**（不是多租户，是远程 workspace）。走适配器 catalog 则此问题自动消失（catalog 由实际执行方生成）。**[读到远程代理存在 + 推断该不一致；未实测远程路径下 ACP 进程的落地主机]** → **[需实现方核实]** 远程 workspace 下 ACP 子进程是否真在远端 spawn。

### 4.5 i18n 组织方式（卡片 §5 要求 10 语言）

- 10 个文件：`ar / de / en / es / fr / ja / ko / pt / zh-CN / zh-TW`，**每个文件均为 4148 行，行数完全一致** → 结构严格对齐，key 顺序也对齐（可按行号平移）。[读到]
- 嵌套结构：`AgentSettings.kiro.customAgentLabel` 形态（`en.json:738` `"kiro": {` → `:766-771` 6 个 `customAgent*` key）。命名约定 = camelCase，同一功能用共同前缀（`customAgentLabel` / `customAgentNone` / `customAgentEmpty` / `customAgentMissing` / `customAgentHint` / `reloadCustomAgents`）。[读到]
- 加 key 必须 10 文件同位置同步，否则 next-intl 缺 key。[推断，基于行数严格一致这一事实]

### 4.6 `AgentDelegationDefaults` 加字段的两个静默陷阱（§2.4 已述，此处汇总为约束）

1. `is_empty()`（`types.rs:35`）不更新 → 只配了 `disallowed_tools` 的条目被 `clamped()`（`commands/delegation.rs:97`）静默丢弃。
2. 前端 `delegation-agent-defaults.tsx:150` / `:186` 两处手工对象字面量不更新 → 用户改 mode 或 config 时，已存的 `disallowed_tools` 被**静默覆盖丢失**（TS 不报错）。

### 4.7 R2（mcpServers 合并挤掉 codeg-mcp）— 静态证据已相当明确，可给验证方一个先验

**注意：R2 有另一 sub 在实跑，此处不抢裁决，只提供静态读到的合并顺序供其对账。**

- `acp-agent.js:4058`：`mcpServers: { ...(userProvidedOptions?.mcpServers || {}), ...mcpServers }` —— **后者覆盖前者**，而 `mcpServers`（`:3942-3966`）是从 **ACP `params.mcpServers`**（即 codeg 通过 `req.mcp_servers(...)` 发的那份，含 `codeg-mcp`）构建的。→ **[推断] ACP 侧注入优先，`_meta` 里的用户 mcpServers 只会被 ACP 同名项覆盖，不会挤掉 `codeg-mcp`**（除非用户人格里恰好也叫 `codeg-mcp`，那会被 ACP 版覆盖，仍安全）。
- codeg 侧 `codeg-mcp` 的注入名为字面量 `"codeg-mcp"`（`connection.rs:2527 McpServerStdio::new("codeg-mcp", binary_path)`），且 `inject_codeg_mcp` 在 `mcp_servers` 数组构建**之后**追加（`:3087`），再整体传给三个 build 函数（`:3138` / `:3251` / `:3449` / `:3527`）。[读到]
- → 先验判断：**R2 大概率通过**。但这是 [推断]，不能替代实跑（§0.14 Gate 2/3：读代码 ≠ 控制变量实验）。工作包仍按「R2 可能不通过」设计（§6）。

### 4.8 业务现实核对（§0.17，仅对卡片提出的新建项）

| 卡片新建项 | ① 真实场景 | ② 缺失影响 | ③ 既有覆盖 | ④ 分类 |
|---|---|---|---|---|
| 选定 Claude 人格 | 用户派 SUB 时要指定「评审员/执行器」人格 | 无法复用已写好的人格，SUB 行为不可控 | **✅ 已有（§3.2）适配器 `agent` config option 全链路已通** | **A**，但**不需新建代码**，改为「验证 + 补 UX」 |
| `list_claude_custom_agents()` 新 API | —— | 无（既有通道已提供 catalog） | ✅ 完全覆盖 | **D 技术洁癖（为对齐 Kiro 形状而建并行实现）→ 建议不建** |
| 会话级 `disallowedTools` | 用户不想让某个 SUB 动 git / 写文件 | SUB 权限过宽，误操作风险真实 | ⛔ 无（全仓零命中，§2.6） | **B 稳定性防护**，真缺口，建议做 |
| `_meta.claudeCode.options.mcpServers` | 给人格挂专属 MCP | 中等 | 部分（用户级 MCP 已有 `load_mcp_servers_for_agent` @ `connection.rs:2279`） | **C**，优先级最低，且被 R2 门禁挡着 → 建议直接切出本期 |
| 会话快照持久化（§3.4） | 续聊/恢复时人格要一致 | 恢复后人格漂移，行为不可预测 | ⛔ 无（conversation 表无快照字段，§4.2）；但**部分被 localStorage 偏好回灌覆盖**（按 agentType 而非按会话，粒度更粗） | **B**，真缺口，但**可降级**：若接受「按 agentType 记忆」的既有粒度，本期可不加 migration（见 §6 W4 可选性） |
| 向 LLM 暴露 persona 参数 | —— | 无 | —— | 卡片已自判不做 ✅ |

**结论：本次侦察把「人格枚举」从 A 类新建降级为「已存在，需验证」，把 `mcpServers` 建议切出本期，真正的新增缺口只剩 `disallowedTools`（B）与会话快照（B，可降级）。**

### 4.9 架构 / 前提质疑（§0.18 / §0.19）

**一个真实的错路信号（不阻塞，但必须说出来）**：卡片把人格与工具限制**都**挂到 `_meta.claudeCode`。但读完适配器后可见两者层级不同：
- 人格 = **标准 ACP 能力**（`configOptions` + `set_config_option`，跨 agent 通用词汇，Kiro 也有 `--agent`，Codex 有 `mode`）。
- `disallowedTools` = **Claude 私有 SDK 参数**（只在 `_meta.claudeCode.options` 里存在）。

把两者都塞进同一个 Claude 私有信封，会把一个**本来通用的能力**（人格选择）**私有化到 Claude 分支**里，未来 Kiro/Codex 要同能力就得各写一遍 —— 这正是评审 A5 担心的形状。**更省的分层**：人格走既有通用 config-option 通道（零新增），只有 `disallowedTools` 走 `_meta.claudeCode`（它确实是 Claude 私有的）。这样 §2.1 提到的「在 raw-SDK 可观测性函数里挂能力配置」的职责扩张也缩到最小面。

**无 §0.19 类约束问题**：没有发现「因为某处不许改而被迫在别处造等价物」的情况。

---

## 5. 真实修改范围（核实后）

**必做（真缺口）：**
1. `connection.rs:2136` `claude_raw_sdk_session_meta` 扩展为接受可选 `disallowed_tools`（并同步 `:2157` / `:2172` / `:2193` 三个 build 函数签名 + `:3134` / `:3247` / `:3449` / `:3527` 四个调用点）。
2. `delegation/types.rs:28` `AgentDelegationDefaults` 加 `disallowed_tools` + **同步 `is_empty()`（`:35`）**；前端 `delegation-agent-defaults.tsx:150/186` 两处字面量同步。
3. 委派链路透传：`spawner.rs:89` `spawn()` 签名 / `manager.rs:399` `spawn_agent` / `connection.rs:1002` `spawn_agent_connection` —— 需新增一个参数把 `disallowed_tools` 带到 `build_*_session_request`（**当前 `preferred_config_values` 是 `BTreeMap<String,String>`，装不下 `Vec<String>`；需要独立参数或换结构**）[读到签名 + 推断]。
4. 测试：卡片测试 1/2/3 有效（`connection.rs:8472` / `:8487` / `:8512` / `:8543` / `:8563` 是现成的同形扩展点）。

**改为「验证 + 小补」（原计划的新建被现实推翻）：**
5. 人格：**先实跑验证既有 `agent` config option 通道**（E1 验收即此项）。通过 → 本期人格部分只需 ① 可能的 i18n/标签打磨 ② 显式校验闸门（不变量 3，参照 `verify_kiro_selected_agent_exists`）。
6. **卡片测试 4（`list_claude_custom_agents_parses_frontmatter`）与整套枚举 API 建议作废**（连同 6 个注册点 + 10 语言 i18n）。

**可降级 / 建议切出：**
7. 会话快照（§4.2）：若接受既有「按 agentType 的 localStorage 偏好」粒度 → 本期不加 migration；若要真快照 → 用 `automation.config` 范式的单 JSON 列，编号 `m20260727_000001_*`。
8. `mcpServers`：建议**切出本期**（C 类 + R2 门禁 + §4.7 静态先验已显示它不是必需）。

**明确不改：**
- `apply_preferred_session_options`（`connection.rs:4238`）的 log&skip 语义 —— 跨切面，动它会影响 mode/model/effort/Grok 全部既有偏好。
- Kiro 的 `list_kiro_custom_agents` 一族 —— 不受本功能影响，不要「顺手统一」。
- `tool_schema.json`（`acp/delegation/tool_schema.json`）—— 卡片已定本期不向 LLM 暴露 persona。

---

## 6. 可执行工作包拆分

**设计原则**：① W0 是纯验证包，其结论会砍掉或保留后续包（不是可选的前置，是分流器）；② `mcpServers` 单独成包（W6）且**无人依赖它**，R2 不通过直接删掉即可；③ 触碰 `connection.rs:2136-2210` 这一小段的只有 W2 一个包（避免多 AI 撞同一段）。

| ID | 范围（文件） | 目标 | 依赖 | 可并行 | 预估改动量 | 推荐 AI 数 |
|---|---|---|---|---|---|---|
| **W0** | 无（只读 + 实跑） | **分流验证**：① 在 `~/.claude/agents/` 放 1 个人格，起一个 Claude 会话，确认 composer 出现 "Agent" 选择器、可切换、重连后保持（§3.2 推论）；② 记录 `agent` 选项的 `options[].value` 到底是文件名还是 frontmatter name；③ 顺带抓 `session/new` 报文（供 W2 对齐） | 无 | — | 0 行代码，1 次真跑 | 1（**必须先跑，其结论决定 W1/W3 是否存在**） |
| **W1** | `connection.rs`（新增独立校验函数）+ 可能的 `commands/acp.rs` | 不变量 3 的**显式校验闸门**：照 `verify_kiro_selected_agent_exists`（`acp.rs:551`）形状，用 W0 确认的权威列表（agent 返回的 `configOptions[id="agent"].options`）做本地比对，不命中 → 稳定错误码 `UnknownClaudeAgent{name}`，不静默回落 | W0 | 与 W2 并行（不同函数、不同段落） | ~80 行 + 3 测试 | 1 |
| **W2** | `connection.rs:2136 / 2157 / 2172 / 2193` + 4 个调用点（`:3134/:3247/:3449/:3527`）+ 测试 `:8472/:8487/:8512/:8543/:8563` | `disallowedTools` 注入：`claude_raw_sdk_session_meta` 加参数；未配置时**字段缺席**（不是空数组）；非 Claude 仍 `None` | 无（可与 W0 并行起步） | 与 W1 / W3 并行 | ~120 行 + 4 测试 | 1 |
| **W3** | `delegation/types.rs:28`+`:35`、`delegation/broker.rs:2697/4236`、`spawner.rs:89/133`（+ mock `:231/:244/:322/:386`）、`manager.rs:399/2567`、`connection.rs:1002` | 委派侧透传 `disallowed_tools` 到 W2 的注入点；`is_empty()` 同步；旧 payload 反序列化行为不变 | **W2 的函数签名**（串行：W2 先定签名） | 与 W1 并行 | ~150 行 + 3 测试（含 broker 的 `agent_defaults_are_forwarded_to_spawner` 同形扩展 @ `broker.rs:7595`） | 1 |
| **W4** | 前端 `delegation-agent-defaults.tsx:150/186` + `src/lib/types.ts`（`AgentDelegationDefaults` 镜像）+ i18n 10 文件 | 委派设置页的工具黑名单输入（参照 Kiro `trustToolsLabel`/`trustToolsHint` 的逗号分隔 textarea 形状，`en.json:762-764`） | W3 的字段名 | 与 W5 并行 | ~150 行 + 2 测试 | 1 |
| **W5**（可选，见 §4.2） | `db/migration/m20260727_000001_*.rs` + `migration/mod.rs:3-27/34-60` + `entities/conversation.rs` + `conversation_service.rs:76 create_inner` | 会话启动快照（**建议单 JSON 列，照 `automation.config` 范式**）+ load/resume 复用 | 无（独立于 W1-W4） | 与全部并行 | ~200 行 + 3 测试 | 1（**若接受 localStorage 粒度可整包删除**） |
| **W6**（R2 门禁下游，可整包丢弃） | `connection.rs`（W2 同函数的另一字段）+ 设置 UI | `_meta.claudeCode.options.mcpServers` 透传 | W2 + **R2 门禁通过** | 最后做 | ~80 行 | 1 |
| **W7** | 端到端验收（E1-E6） | 卡片 §4.1 的 6 项真跑；E6（codeg-mcp 存活）在 W6 被砍时降级为「验证 disallowedTools 不影响 codeg-mcp」 | W1-W4 全部完成 | — | 0 行代码 | 1 |

**波次依赖图：**

```
W0 (分流验证) ──┬─→ W1 (fail-closed 闸门) ──┐
                │                            ├─→ W7 (E2E 验收)
W2 (_meta 注入) ─┴─→ W3 (委派透传) ─→ W4 (UI+i18n) ┘
                     └─(R2 通过时)→ W6 (mcpServers) ─→ W7 补 E6
W5 (快照 migration, 独立) ─────────────────────→ W7
```

- **真正的并行度**：W0 / W2 / W5 三包可同时起步（3 AI）；W2 完成后 W1+W3 并行（2 AI）；W3 完成后 W4。**峰值 3，串行链最长 = W2→W3→W4→W7（4 波）**。
- **W0 若确认人格已可用** → W1 保留（校验闸门仍需要，且变简单：数据源在手边），卡片计划的枚举 API 包**不存在**（已从拆分中剔除）。
- **W0 若确认人格不可用**（例如 codeg 某处过滤了非 model/mode 的 config option —— 我读到的映射层没有这种过滤，但 [需实现方核实] 实际渲染）→ 需临时新增一个「W1b 人格枚举」包，此时**再回到卡片 §3.1 的方案，但标识必须用适配器的 `a.name` 而非文件 stem**（§3.2 硬伤）。

---

## 7. 风险交叉区 & 对主 AI 的派发建议

| 交叉区 | 涉及包 | 处置 |
|---|---|---|
| `connection.rs:2136-2210`（meta + 三个 build 函数） | W2、W6 | **串行**：W2 先定型并合入，W6 再加字段。绝不并行。 |
| `connection.rs` 测试模块 `:8200-8600` | W1、W2 | 同文件不同区段；建议**W2 先，W1 后**，或明确划定 W1 只在文件尾追加新测试函数。 |
| `spawner.rs` trait 签名 | W3 | 改 trait 会连带 `mock`（`:231/:244`）+ 两个 impl（`:322/:386`）+ `manager.rs`；**一个包内一次改完**，不要拆。 |
| `src/lib/types.ts` | W4、W5 | 不同 interface，可并行；但同文件建议同一 AI 顺序做，或明确行区间。 |
| i18n 10 文件 | W4 | 单包独占。**10 文件行数严格一致（各 4148 行）**，两个 AI 并行改 i18n 必然冲突。 |
| `migration/mod.rs` | W5 | 单包独占。**编号必须查全局实际最大值**（当前 `m20260717_000001`），不要凭直觉；同日多包会撞号。 |

**派发建议：**
1. **先只派 W0**，拿到分流结论再写 tasks/spec 的后续部分。**这一步不能省** —— 本报告 §3.2 的核心结论是 [推断]，如果它成立，卡片约 40% 的计划工作量（枚举 API + 6 注册点 + 10 语言 i18n + 一组契约测试）应当直接删除；如果不成立，则需要按 §6 末尾的 W1b 修正形状。用一次真跑换这个分流，性价比极高。
2. W0 与 W2 / W5 可同时派（三者互不触碰同一文件）。
3. **在给执行 AI 的指令里必须带上两条本报告发现的静默陷阱**：`AgentDelegationDefaults::is_empty()` 必须同步（否则条目被 clamped 丢弃）；前端两处对象字面量必须同步（否则字段被静默覆盖）。
4. R2 由另一 sub 裁决；§4.7 的静态先验（合并顺序 ACP 优先）可作为其对账参考，但**不得替代实跑**。

---

## 8. Domain-Model 对账

**判定：不适用（无需 `docs/domain/<subsystem>-model.md`）。**

依据：本功能不引入跨切面中间层 —— 不涉及数据抓取/持久化维度表、不新增采集频率/限流通道、不新增状态机（人格是既有 `configOptions` 的一个 select 值，工具黑名单是一次性启动参数）。`docs/domain/` 目录在本仓库不存在（`git ls-files` 未见），既有同类工作走的是 `docs/specs/<feature>/` 三件套（前例：`docs/specs/delegation-continue-session/{requirements,design,review.codex}.md`、`docs/specs/kiro-agent-integration/requirements.md`）。**若 W5（会话快照）保留并采用 JSON 列范式，那才开始有「启动配置维度」的雏形，但一个维度不值得建模型层文件** —— 届时在 spec 的 design.md 里用一张表说明即可。

唯一需要在 spec 里显式记一笔的既有不变量（`entities/conversation.rs:19-24`）：`kind == Delegate ⟺ parent_id IS NOT NULL`，且 `kind` *"Written once at insert, never updated"*。W5 若加快照列，应遵循同一「insert 时写一次、之后不改」的语义（除运行时切人格那一次，卡片 §3.4 已定义为同事务更新）。[读到]

---

## 9. 交付物路径

**本轮仅产出侦察报告**：`F:\codeg-research\.agent-workspace\.archive\2026-07-27\claude-persona-tools\claude-persona-tools-recon.md`（本文件）。

未产出 `docs/specs/<feature>/` 三件套与 `tasks.md` —— 按当前工作流分工，spec/tasks 由主派发 AI 在本侦察返回后严格按模板产出。本报告 §5（真实修改范围）+ §6（工作包表 + 波次图）+ §7（交叉区）已按可直接转写为 `tasks.md` 的粒度组织。

**⚠️ 转写 spec/tasks 前必须先解决的两个裁决点（不是技术细节，是方向）：**
1. **人格是否改为「验证既有通道」而不新建枚举 API**（§3.2，卡片 A3 处置有误）—— 需 W0 实跑 + 用户/主 AI 裁决。
2. **不变量 3 的落地方式**（§4.1，与既有 log&skip 语义冲突）—— 推荐新增独立校验闸门，不动跨切面既有语义。

## Update Log

- 2026-07-27 侦察落盘。锚点核对 5/5 准确；单租户判定成立（另补 3 条不依赖注释的结构证据）；**「人格枚举谁做权威」判错 —— 适配器已通过标准 ACP `agent` config option 提供权威 catalog 且 codeg 全链路已通**；新发现 5 条卡片未覆盖约束（fail-closed 与既有 log&skip 冲突 / migration 编号与 automation 快照范式 / 远程 workspace 主机不一致 / `is_empty()` 与前端字面量静默陷阱 / 标识是 `a.name` 非文件 stem）；拆 8 个工作包，峰值并行 3，`mcpServers` 独立可丢弃。
