# W0 分流验证 — Claude 人格通道是否已可用（纯验证 · 0 行业务代码）

> 任务性质：分流验证。结论决定决策卡 `claude-persona-tools-decision.md` 约 40% 计划工作量是否删除。
> 证据强度约定：**[实跑]** = 本轮真实执行并观察到输出；**[读到]** = 直接引用 file:line 源码；**[推断]** = 由前两者推导，未直接观察。
> 未改任何业务代码。临时夹具 `.agent-workspace/tmp-w0-probe.mjs` + 输出文件已在验完后删除（`Test-Path` = False 核实）。

---

## 0. 结论（一句话）

**命题 P ✅ 完全成立，且比侦察报告推断的更强。** 本轮**实跑**了与 codeg 完全同构的 ACP 握手，
适配器 `session/new` 响应里**确实**带 `id="agent"` 的人格选择器，选项即用户 `~/.claude/agents/`
下的 9 个自定义人格；`session/set_config_option("agent","debugger")` **实跑返回 `currentValue="debugger"`**
（热切换生效）。codeg 侧从接收 → 映射 → 渲染 → 回写 → 持久化 → 重连回灌全链路**逐跳读到源码，无任何按 id 的白名单过滤**。

---

## 1. 实跑证据（本轮真实执行）

### 1.1 方法

写了一个最小 ACP stdio 客户端，直接 spawn codeg registry 钉住的同一个适配器二进制
（`src-tauri/src/acp/registry.rs:213` `@agentclientprotocol/claude-agent-acp@0.62.0`
→ 本机 `D:\Devtool\npm-global\node_modules\@agentclientprotocol\claude-agent-acp\dist\index.js`），
按 codeg 的报文形状发 `initialize` + `session/new`（`cwd` = `F:/codeg-research`，
`mcpServers: []`，`_meta.claudeCode.emitRawSDKMessages: true`，与 `connection.rs:2145` 一致），
再发一次 `session/set_config_option`。

**为什么不起 `pnpm dev` 全栈**：不需要 —— UI 层是否渲染这个选项，由前端代码里「有没有按 id 过滤」
唯一决定，而这一点静态可判定（§2.3，`availableConfigOptions.map()` 无过滤）。真正无法静态判定
的是「适配器到底会不会吐出这个选项 + 切换会不会被接受」，这两点本轮已用真实报文实跑闭环。
这样规避了 Rust 全量编译 + Next 构建的耗时，同时把不确定性降到零。

### 1.2 `session/new` 响应实测（[实跑]）

返回 `configOptions` 共 **3 项**：`mode` / `model` / **`agent`**。`agent` 项原样如下（截取）：

```json
{
  "id": "agent",
  "name": "Agent",
  "description": "Main-thread agent persona",
  "type": "select",
  "currentValue": "default",
  "options": [
    { "value": "default", "name": "Default", "description": "Standard Claude Code agent" },
    { "value": "debugger", "name": "debugger", "description": "Systematic debugger + ..." },
    { "value": "executor", "name": "executor", "description": "Sub-task executor. ..." },
    { "value": "get-current-datetime", ... },
    { "value": "init-architect", ... },
    { "value": "plan-reality-recon", ... },
    { "value": "planner", ... },
    { "value": "reviewer", ... },
    { "value": "ui-designer", ... },
    { "value": "ui-ux-designer", ... }
  ]
}
```

→ **9 个自定义人格 + 1 个 `default` 哨兵，无一个内置 subagent**（`claude` / `general-purpose` /
`Explore` / `Plan` / `statusline-setup` 均未出现）→ 印证 `BUILTIN_AGENT_NAMES` 过滤（`acp-agent.js:4563`）
在真实环境生效。[实跑]

### 1.3 热切换实测（[实跑]）

```
SWITCH_TARGET        {"value":"debugger","name":"debugger",...}
AFTER_SWITCH_CURRENT debugger
```

`session/set_config_option{configId:"agent", value:"debugger"}` 返回的 `configOptions` 中
`agent.currentValue` 已变为 `"debugger"`，**无报错、无静默回落**。→ 决策卡 §3.1「写：运行时 →
`set_config_option("agent", ...)`（已有链路）」在真实适配器上验证通过。[实跑]

### 1.4 catalog 覆盖面 vs 本地单层扫描（[实跑] + [读到]）

本机 `~/.claude/agents/` 下 `*.md` 递归共 **9 个**，其中 **4 个在嵌套子目录**：

```
C:\Users\7\.claude\agents\debugger.md            (顶层)
C:\Users\7\.claude\agents\executor.md            (顶层)
C:\Users\7\.claude\agents\plan-reality-recon.md  (顶层)
C:\Users\7\.claude\agents\reviewer.md            (顶层)
C:\Users\7\.claude\agents\ui-designer.md         (顶层)
C:\Users\7\.claude\agents\zcf\common\get-current-datetime.md   (嵌套)
C:\Users\7\.claude\agents\zcf\common\init-architect.md         (嵌套)
C:\Users\7\.claude\agents\zcf\plan\planner.md                  (嵌套)
C:\Users\7\.claude\agents\zcf\plan\ui-ux-designer.md           (嵌套)
```

适配器 catalog **9/9 全部命中，含 4 个嵌套目录的人格**。

→ **这是对决策卡 §3.1 方案的一条硬性反证**：卡片计划的 `list_claude_custom_agents()`「扫描
`~/.claude/agents/*.md`」是**单层 glob**（照 Kiro `list_kiro_custom_agents_at` 的
`read_dir` 一层形状，`commands/acp.rs:4386`），**会漏掉本机现有 9 个人格中的 4 个（44%）**。
侦察报告 §3.2 只指出「本地扫描少了 project/local 层与 plugin 人格」，**实测显示连 user 层内部
的嵌套目录都会漏** —— 缺口比侦察报告估计的更大。[实跑 + 读到]

同时顺带落定侦察报告标为 [需实现方核实] 的一项：`.md` 文件名 stem 与 frontmatter `name`
在本机 **9/9 完全一致**（逐个提取比对，[实跑]）—— 所以本机环境下「传文件名」不会立刻踩
静默回落坑，但这只是本机的巧合，不是契约（详见 §4 问题 3）。

---

## 2. 静态链路逐跳复核（[读到]，独立于侦察报告重跑）

### 2.1 后端接收（无 agent 类型分支）

- `connection.rs:3524` / `:3446`（new，两条路径）、`:3257`（load）、`:3142`（resume）
  取 `*_resp.config_options` → 传入 `apply_and_emit_session_config_options`（`:2053`）。[读到]

### 2.2 后端映射 —— **关键：无 id 白名单**

`connection.rs:1351 map_session_config_option`：`match &option.kind` 只区分
`SessionConfigKind::Select(_)`（映射）与 `_ => None`（丢弃）。**判据是 kind 是否 Select，
与 `option.id` 完全无关** —— `id` 只是被 `option.id.to_string()` 原样搬进 `SessionConfigOptionInfo`。
`agent` 项 `type: "select"` → 必然通过。[读到]

`emit_session_config_options_values`（`:1464`）中唯一的条件分支是
`if agent_type == AgentType::Codex { ensure_codex_mode_option(...) }` —— **Claude 走原样路径，
零特殊处理**。[读到]

### 2.3 前端渲染 —— **无 id 白名单**

- `message-input.tsx:951 availableConfigOptions = configOptions ?? []`（无 filter）。[读到]
- `:2694 availableConfigOptions.map((option) => ...)` —— **遍历全部**，逐项渲染
  `ModelOptionPicker` 或 `InlineSessionConfigSelector`。[读到]
- `:2739` 折叠面板路径同样 `for (const option of availableConfigOptions)`，唯一 skip 条件是
  `option.kind.type !== "select"`。[读到]
- `isModelConfigOption`（`model-config-groups.ts:20`：`id === "model" || category === "model"`）
  只决定**是否按 `provider/` 前缀分组 + 是否启用搜索虚拟列表**（`:481` / `:2785` 两处调用点均在
  展示分支内），**不决定是否渲染**。→ 侦察报告「非白名单」判断准确。[读到]

### 2.4 回写 / 持久化 / 回灌

- `acp-connections-context.tsx:4508 setConfigOption(contextKey, configId, valueId)` —— 参数
  `configId` 直接来自 `option.id`（`message-input.tsx:2793 onConfigOptionChange?.(option.id, value)`），
  `valueId` 直接来自 catalog 的 `item.value`。**无重写、无映射**。[读到]
- `:4520 saveConfigPreference(conn.agentType, configId, valueId)` →
  `selector-prefs-storage.ts:113` localStorage `codeg:selector-prefs`，按 agentType 存
  `configValues: { agent: "debugger" }`。[读到]
- `:4212 getSavedPrefsForConnect(agentType)` → `acpConnect(..., configValues)` →
  `preferred_config_values` → `apply_preferred_session_options`（`connection.rs:4237`）
  → `set_session_config_option_inner`。[读到]

**唯一的语义缺口**：`connection.rs:4290-4293` 对单条偏好失败是 `tracing::error!` + 继续
（doc `:4235` 明写这是刻意设计）→ 人格文件被删后重连会**静默回落 default**。
这与侦察报告 §4.1 的判断一致，是 W1 校验闸门要解决的问题，**不影响命题 P 的成立**
（P 说的是"能选、能生效、能持久化"，这三项都成立）。[读到]

---

## 3. 必答四问

### 问题 1：命题 P 成立吗？

**✅ 完全成立。** 人格下拉今天就已可用：适配器吐出 catalog（[实跑]）→ codeg 无过滤地映射
（[读到]）→ 前端无过滤地渲染（[读到]）→ 切换生效（[实跑] 适配器侧 `currentValue` 已变）→
按 agentType 持久化到 localStorage 并在下次 connect 回灌（[读到]）。

**诚实边界**：我**没有**启动 codeg 全栈观察 UI 上的那个下拉框像素（Rust + Next 构建成本高，
且该环节静态可判定）。所以严格说：「适配器吐出 + 切换生效」= [实跑]；「UI 会渲染它」= [读到] 全链路
无过滤后的高置信度结论，不是我肉眼看到的。不确定性集中在"有没有我漏读的过滤分支"，
我用 `git grep availableConfigOptions`（5 处命中，全部读完）+ `map_session_config_option`
全函数通读做了穷尽，未发现任何按 id 的过滤。

### 问题 2：决策卡哪些计划工作应当删除？

| 计划项 | 出处 | 处置 | 理由 |
|---|---|---|---|
| `list_claude_custom_agents()` + `ClaudeCustomAgent` 结构体 | 卡片 §3.1 | **删除** | catalog 已由执行方权威提供；自建单层扫描实测漏 44% 人格（§1.4） |
| tauri command `acp_list_claude_custom_agents` | 卡片 §5 注册清单 | **删除** | 无消费方 |
| `lib.rs` invoke_handler 注册 | 卡片 §5 | **删除** | 同上 |
| web handler（`web/handlers/acp.rs`） | 卡片 §5 | **删除** | 同上 |
| `web/router.rs` 路由 | 卡片 §5 | **删除** | 同上 |
| `src/lib/api.ts` client 方法 | 卡片 §5 | **删除** | 同上 |
| `src/lib/types.ts` `ClaudeCustomAgent` 镜像 | 卡片 §3.1「形状对齐 KiroCustomAgent」 | **删除** | 同上 |
| i18n × 10 语言（`customAgent*` 一族 6 key） | 卡片 §5 | **删除** | 无自建 UI 需要文案；适配器已给 `name`/`description`。**注**：若要把选择器标题从适配器的英文 "Agent" 本地化，那是**另一件事**（覆盖既有通用 config-option 标签），不在本行删除范围，见下方"保留"项 |
| 测试 4 `list_claude_custom_agents_parses_frontmatter` | 卡片 §4 | **删除** | 被测函数不存在 |
| 「加契约测试验证本地扫描与 `discoverCustomAgents()` 一致」（A3 处置） | 卡片 §6.2 A3 | **删除** | 两侧合一，无需对账 |
| 人格的会话快照持久化（§3.4 中人格那一半） | 卡片 §3.4 | **降级为可选** | localStorage 按 agentType 回灌已覆盖大部分场景；真快照需求见 W5 |

**保留 / 新增（人格部分的真实剩余缺口）**：
1. **W1 fail-closed 校验闸门**（卡片不变量 3）—— 仍需要，且因 catalog 在手边变简单：数据源就是
   `configOptions[id="agent"].options`，纯本地比对零额外 IO。
2. **可选 UX 打磨**：选择器标题当前是适配器给的英文 `"Agent"`，`description` 是人格 frontmatter
   的整段英文。若要本地化，需要在**通用 config-option 渲染层**按 id 覆盖标签 —— 这会影响所有
   agent 的所有选项，属跨切面改动，建议**单独裁决，不塞进本期**。

**删减量核实**：卡片 §5 注册清单 6 项中 4 项删除（第 5 项 `tool_schema.json` 卡片已定不动，
第 6 项 feature flag 卡片已定不加）；卡片 §4 六个测试中 1 个删除、1 个（测试 6 同名冲突边界）
因不再自建解析而失去意义。→ **与侦察报告估计的「约 40% 计划工作量」量级吻合。**

### 问题 3：`set_config_option` 传的是 `name` 还是别的？会不会踩静默回落？

**传的就是 catalog 自己给的 `value`，而 `value` 就是适配器的 `a.name`。不会踩静默回落。** 证据链：

1. 适配器构造：`acp-agent.js:4731-4735` `...agents.map((a) => ({ value: a.name, name: a.name, ... }))`
   → `value === a.name`。[读到]
2. codeg 后端映射：`map_session_config_select_option` 原样搬 `value`（未改写）。[读到]
3. 前端回传：`message-input.tsx:2793 onConfigOptionChange?.(option.id, value)`，`value` 取自
   `groups.flatMap(...).options[].value`，即第 2 步搬过来的原值。[读到]
4. 适配器校验：`acp-agent.js:3128` `session.configOptions.find(o => o.id === params.configId)`
   → `:3143` `allValues.find(o => o.value === params.value)` —— **在自己刚吐出的 options 里比对**，
   必然命中。[读到]
5. **实跑印证**：传 `"debugger"`（catalog 的 value）→ 返回 `currentValue: "debugger"`。[实跑]

**关键区分**：`:4277` 的静默回落（`agents.some(a => a.name === requestedAgent)` 不中则
`DEFAULT_AGENT_ID`）**只在 `_meta.claudeCode.options.agent` 这条路上**（`session/new` 时的
`requestedAgent`）。走 `set_config_option` 时，值来自 catalog 自身，是**闭环**的，
天然不可能不匹配 —— 侦察报告担心的硬伤**只对卡片计划的自建扫描方案成立**（自建方案传文件 stem，
而 stem 与 frontmatter `name` 无契约保证；本机 9/9 恰好相同是巧合，不是保证）。
**这条风险随着删除自建枚举而一并消失。**

⚠️ **但有一处残留**：`_meta` 路径若将来仍被使用（例如委派侧在 `session/new` 时预置人格），
静默回落风险依旧存在。当前委派侧走的是 `preferred_config_values` → `set_config_option`
（`spawner.rs:69` doc + `connection.rs:4237`），属安全路径；**只要不新增 `_meta.claudeCode.options.agent`
的用法，就不会踩。建议在 spec 里把「人格一律走 config option，不走 `_meta`」写成硬约束** ——
这也正好与侦察报告 §4.9 的分层建议（人格=通用 ACP 能力，`disallowedTools`=Claude 私有）一致。

### 问题 4：工具限制（`disallowedTools`）是否受影响？

**不受影响，工作量仍然全额需要。** 核实：

- `git grep -e "disallowedTools" -e "disallowed_tools" -e "allowedTools" -- src-tauri/src src`
  → **退出码 1，零命中**（本轮重跑，非采信侦察报告）。[实跑]
- 两者层级确实不同：人格 = 标准 ACP `configOptions` 通道（本报告全篇验证的那条）；
  `disallowedTools` = 仅存在于 `_meta.claudeCode.options`，被适配器 `:4088`
  `disallowedTools: [...(userProvidedOptions?.disallowedTools || []), ...disallowedTools]`
  数组拼接后交给 SDK。[读到]
- → 决策卡的 W2（`claude_raw_sdk_session_meta` 扩展）/ W3（委派透传）/ W4（UI + i18n）
  **一项都不能删**。R5 硬防（黑名单不得含 `mcp__codeg-mcp__*`）同样仍然必要。

**唯一的连带影响**：`AgentDelegationDefaults` 加 `disallowed_tools` 字段这件事，因为人格部分
**不再需要动这个结构**（人格走既有 `config_values["agent"]`，卡片 §3.3 本就如此判断，此判断
经本轮验证为正确），所以 W3 的改动面比卡片设想的**略小** —— 只加一个 `Vec<String>` 字段，
人格零改动。侦察报告 §4.6 的两个静默陷阱（`is_empty()` 同步 / 前端两处对象字面量同步）
**仍然全部适用**，不得因本报告的删减而遗漏。

---

## 4. 对侦察报告的独立复核结论

| 侦察报告的判断 | 本轮复核 |
|---|---|
| §3.2 「适配器已提供权威 catalog + codeg 全链路已通」（标为 [推断]） | ✅ **成立，已升级为 [实跑]** |
| §3.2 表格「本地扫描只覆盖 user 层」 | ⚠️ **偏保守 —— 实测连 user 层的嵌套子目录都漏（9 个人格漏 4 个）** |
| §3.2 「标识差异是硬伤：传文件 stem 会静默回落」 | ✅ 逻辑成立，但**仅对自建方案成立**；走 config option 是闭环，不受影响。本机 stem 与 name 9/9 相同（[实跑]），故该坑在本机不会立刻暴露 —— 这反而更危险（其他机器才炸） |
| §4.1 「fail-closed 与既有 log&skip 冲突」 | ✅ 成立（`connection.rs:4290` 复核确认），W1 仍需要 |
| §4.8 「`list_claude_custom_agents()` 判为 D 类，建议不建」 | ✅ 成立，且理由更强（不只是"并行实现"，而是"功能更差的并行实现"） |
| 「W0 若确认不可用则需 W1b」 | 已确认可用 → **W1b 不需要，可从拆分中永久剔除** |

**未发现侦察报告有事实性错误。** 唯一需要修正的是 §3.2 对本地扫描缺口的低估（少说了嵌套目录）。

---

## 5. 建议的波次图修订（供主 AI 转写 tasks.md）

```
W0 (本报告 · ✅ 已完成 · 结论:命题 P 成立)
   └─→ 人格枚举 API 包 (原卡片 §3.1 + §5 注册清单) ⛔ 整包删除
   └─→ W1b (人格枚举备选方案)                      ⛔ 永不需要

W1 (fail-closed 校验闸门 · 数据源 = configOptions[id="agent"].options) ──┐
W2 (_meta disallowedTools 注入) ─→ W3 (委派透传) ─→ W4 (UI+i18n) ────────┼─→ W7 (E2E)
W5 (会话快照 migration · 独立 · 可降级删除) ─────────────────────────────┘
W6 (mcpServers) ⛔ 建议切出本期（卡片 §6.3 已自判"传了也没用"）
```

峰值并行仍为 3（W1 / W2 / W5），串行最长链 W2→W3→W4→W7。

---

## Update Log

- 2026-07-27 W0 分流验证落盘。**命题 P ✅ 完全成立**（实跑 ACP 握手拿到 `agent` catalog 9 个人格 +
  实跑 `set_config_option` 热切换返回 `currentValue="debugger"`；codeg 侧全链路逐跳读到源码无 id 过滤）。
  新增一条侦察报告未发现的硬证据：**卡片计划的单层扫描会漏掉本机 9 个人格中的 4 个（嵌套子目录）**
  —— 自建方案不只是并行实现，是**功能更差**的并行实现。删减清单 10 项（枚举函数 + 5 个注册点 +
  types 镜像 + i18n×10 + 测试 4 + 契约测试）。工具限制部分零影响、全额保留。
  临时夹具已删除，0 行业务代码改动。
