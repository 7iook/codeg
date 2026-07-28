# 内置 SUB vs 委托 SUB · 交互能力差距侦察

- 日期：2026-07-27 · 分支 `feat/kiro-agent` @ `07552fd2`
- 范围：只读侦察，未改任何代码
- 适配器解包位置：`C:\Users\7\AppData\Local\Temp\acp062\package\dist\`（`claude-agent-acp@0.62.0`）
- 证据分级：**【读码】**=读到的源码 · **【实测】**=实跑观察到的落盘/输出 · **【推断】**=由前两者推导，需实现方复核

---

## 0. 一句话结论（先给关键判定）

**真双向直连不可行 —— 不是「codeg 没做」，而是 ACP 线上不存在可寻址内置 SUB 的入口。**
但**只读观测的缺口只差最后一跳**：codeg 已经有 (a) 全量 raw SDK 通道开着、(b) 一个在跑的 transcript 尾随器、(c) 读 `subagents/agent-*.jsonl` 的现成函数 —— 三者都在，只是**没有任何一处把内置 SUB 的完整消息流接到 UI**。

---

## 1. 计划假设清单（本次任务书中会被现实推翻的假设）

| # | 任务书假设 | 判定 |
|---|---|---|
| A1 | `connection.rs:6376 is_subagent_invocation()` 是 codeg 识别内置 SUB（含 Claude）的后端入口 | **[偏差]** 该函数 **显式排除 Claude**，只对 OpenCode / CodeBuddy 生效 |
| A2 | `sub-agent-overlay.tsx` 是内置 SUB 的前端渲染 | **[偏差]** 它渲染的是 **委托**（B）的 `delegate_to_agent` 卡，与内置 SUB 无关 |
| A3 | codeg 没读 `subagents/agent-*.jsonl` | **[偏差]** 已经在读，但只抽 tool_calls 计数，丢弃全部 prose |
| A4 | 适配器 `session.liveBackgroundTasks` 的 `task_id` 意味着「有可寻址句柄」 | **[偏差]** 是纯**进程内归属追踪表**，无任何对外驱动面 |
| A5 | 只读观测「点进去看完整过程」尚未实现 | **[匹配]**，且缺的正是最后一跳（见 §3） |
| A6 | 委托 SUB 的用户发消息入口未知 | **[已定位]** `continue_delegation`，四层齐备（见 §2） |
| A7 | 内置 SUB「已能被主 AI 发消息」 | **[匹配 · 且这是真双向的唯一现存通道]** Claude 内部 `SendMessage(to:<agentId>)`，见 §2.2 |

---

## 2. 能力差异矩阵（B 有 / A 没有）

### 2.1 委托 SUB（B）的用户可见能力盘点

四层通路完整（`2505e164` 净新增用户侧一层）：

| 层 | 锚点 |
|---|---|
| broker 方法 | `broker.rs` `continue_delegation` / `close_delegation_session` / `get_continuation_availability` |
| Tauri command | `commands/delegation.rs:305` `continue_delegation_core` · `:359` `get_continuation_availability_core` · `:409/:459` `#[tauri::command]` 包装 |
| Web handler + route | `web/handlers/delegation.rs:63/:105` · `web/router.rs:69-78` |
| 前端 API | `src/lib/api.ts:3599` `continue_delegation` · `:3622` `get_continuation_availability` |
| 前端 UI | `sub-agent-session-dialog.tsx:659` `<textarea>` + `:681` 发送键 · `:600` 调 `continueDelegation` · `:629-637` 按五档 availability 启停输入框 |
| 独立会话行 | `db/entities/conversation.rs:28/:52/:56` `ConversationKind::Delegate` + `parent_id`（不变量：`kind==Delegate ⟺ parent_id IS NOT NULL`） |
| 侧边栏可打开 | 子行与根行共用 `handleSelect → openTab`（design.md 已核实记录） |
| 恢复凭据 | `conversation_service.rs:274/:299` — 对 Delegate 行 `external_id` 是 resume 凭据 |

### 2.2 逐项对照

| 用户可见能力 | B 委托 | A 内置 SUB | A 缺的是哪一环 |
|---|---|---|---|
| 独立会话卡片 / 侧边栏出现 | ✅ 独立 `conversation` 行 | ❌ | 无 DB 行。内置 SUB 只是父会话里一个 tool_call；`sessionId` 复用父会话（**【实测】**见 §3.1） |
| 点进去看完整 transcript | ✅ `SubAgentSessionDialog` + `MessageListView` | ⚠️ 仅 tool_calls 列表 | 数据已在盘上且已被读，但只取 tool_calls；prose 全丢（§3.2） |
| 用户直接发消息 | ✅ `continue_delegation` 四层 | ❌ | **协议阻断**：无可寻址入口（§2.3） |
| 状态实时更新 | ✅ 子连接 `liveMessage` 桥接进 runtime | ⚠️ 仅父卡状态 + `tool_progress` 里 `subagentType`/`subagentRetry` | 无子会话 runtime session 可桥 |
| 取消 | ✅ `cancel_delegation` MCP 工具 | ❌ 用户侧无 | Claude 内部有 `TaskStop`，但只有主 AI 能调 |
| 续聊 / 会话恢复 | ✅ `external_id` → `session/resume`/`load` | ❌ | 内置 SUB 无 `external_id`（它不是 ACP session） |
| 可续聊性查询 | ✅ 五档 `ContinuationAvailability` | ❌ | — |
| **主 AI 给它发消息** | ✅ MCP `delegate_to_agent` 续轮 | ✅ **Claude 内部 `SendMessage(to:<agentId>)`** | 两条路都有，但 A 的这条**只对主 AI 开放，用户无法调用** |

### 2.3 关键锚点：`SendMessage` 存在，但只在 Claude 进程内

**【实测】** 真实落盘样本，父会话 JSONL 第 16 行，`Agent` 工具的 launch ack 原文：

```
agentId: a0e3fec5a93d807f5 (internal ID - do not mention to user.
Use SendMessage with to: 'a0e3fec5a93d807f5', summary: '<5-10 word recap>' to continue this agent.)
```

样本路径：`C:\Users\7\.claude\projects\C--Users-7-AppData-Roaming-app-codeg-chat-sessions-2026-07-27-4f2472cd35ab41168660b2927d4fc668\b36bfde5-7eb1-4d40-a2fb-ecdeb6d12d5a.jsonl`

即：**内置 SUB 确实是可寻址的**（`to: <agentId>`），而且这条路 codeg 已经在被动监听 —— `background_watch.rs:894` 就是解析主 AI 发出的 `SendMessage` 以重新武装计数（**【读码】**）。

**但 `SendMessage` 是 Claude CLI 的一个内部工具，不是 ACP 方法。** 只有模型能调它。codeg 想调，必须让模型代调 —— 那就不是直连（见 §4 方案 B）。

---

## 3. 真双向可行性（最关键判定）

### 3.1 ACP 协议层：无 subagent 寻址面 —— 判定「协议不允许」

**【读码】** 适配器 `acp-agent.d.ts` 全部对外方法（`:615-743`）：
`initialize` / `newSession` / `resumeSession` / `loadSession` / `listSessions` / `authenticate` / `logout` / `prompt` / `steer` / `cancel` / `dispose` / `closeSession` / `deleteSession` / `setSessionMode` / `setSessionConfigOption` / `readTextFile` / `writeTextFile`。

**每一个都以 `sessionId` 为唯一寻址键，没有一个接受 `agentId` / `taskId` / `parentToolUseId`。**

最接近的候选 `_session/steering`（`acp-agent.js:56` `STEER_METHOD = "_session/steering"`）的参数类型是（`acp-agent.d.ts:26-29`）：

```ts
export type SteerRequest = {
    sessionId: string;
    prompt: PromptRequest["prompt"];
}
```

**只有 `sessionId`。** 且语义是注入**当前正在跑的父 turn**（`:673` 注释 `STEER_PRIORITY` = `now`，pre-empt 当前 generation），不是寻址子代理。

**【实测】** 内置 SUB 复用父 `sessionId`，因此 sessionId 无法区分父子：
- 子 transcript 每行 `sessionId` = `b36bfde5-...`（与父文件名同）、`isSidechain=true`、`agentId=a0e3fec5a93d807f5`
- 父文件 40 行中 `isSidechain=true` 的行数 = **0**（父子物理分离）

**【读码】** `liveBackgroundTasks`（`acp-agent.js:1905`）的实体是：
```js
session.liveBackgroundTasks.set(message.task_id, {
    parentToolUseId: message.tool_use_id,
    isSubagent: !!message.subagent_type,
})
```
两个字段都是**归属元数据**（用于把 SUB 的 permission 请求归因到父 tool_call，`:3363`），**不含任何句柄/发送器/流引用**。它的唯一消费者是 `turnAwaitingSubagents`（`:1234`，决定父 turn 是否延迟 settle）和权限归因。**这不是可寻址句柄。**

> 这与 `58d63358` commit body 的独立结论一致：「源码核实 v2.1.88：寻址表与实体均为进程内存，无外部驱动面」。本次在 v0.62.0 适配器上复核，结论相同。

**结论：真双向直连 = 协议不允许。** 在不 patch Claude CLI / 不等上游新增 ACP 扩展的前提下，codeg 无法向内置 SUB 单独发消息。

### 3.2 只读观测：现状与缺口 —— 缺的只是最后一跳

三块料都已就位：

**① 全量 raw SDK 通道已经开着（最重要的既有资产）**

- **【读码】** `connection.rs:2136` `claude_raw_sdk_session_meta()` 对 `AgentType::ClaudeCode` 返回 `{claudeCode:{emitRawSDKMessages:true}}`，在 `:2163/:2179/:2200` 三处注入（`session/new` / resume / load）
- **【读码】** 适配器侧 `acp-agent.js:1479` 在 SDK 消息循环**最顶端**、任何 subagent 过滤之前转发：
  ```js
  if (session.emitRawSDKMessages && shouldEmitRawMessage(...))
      await this.client.extNotification("_claude/sdkMessage", { sessionId, message });
  ```
  `shouldEmitRawMessage(true, msg)` → `return true`（`:4371`）= **无条件全量**
- 即：**内置 SUB 的每一条 assistant/user 消息（带 `parent_tool_use_id`）已经在线上到达 codeg 了**
- **缺口** —— `connection.rs:6845` 的 mapper 把它们全扔了：
  ```rust
  if !is_claude_api_retry_message(&message) { return None; }
  ```
  只放行 `system/api_retry`（`:6841`）。**通道开着，阀门关着。**
- 对照：typed 路径**必然**拿不到 prose ——适配器 `:2695-2699` 对 `parent_tool_use_id !== null` 的 assistant 消息 `filter(item => item.type !== "text" && item.type !== "thinking")`，主动剥离。所以 raw 通道是唯一可能的线上来源。

**② transcript 尾随器已在跑，但不看 `subagents/`**

- **【读码】** `background_watch.rs:1-44` 模块头：已经在 1s 节奏 tail 父会话 JSONL，用 `ClaudeRecordAccumulator` + `group_into_turns`（与详情解析器同一套 Stage-A/B 代码）组装成 turn，发 `AcpEvent::BackgroundActivity`；前端 `acp-connections-context.tsx:3037` → `runtime.actions.applyBackgroundActivity` 已消费
- **缺口** —— 它只打开 `find_session_file(session_id)` 定位的**父文件**；`git grep subagent|sidechain -- background_watch.rs` 仅 1 处命中，且在测试 fixture 里（`:1291`）。**从不打开 `subagents/agent-*.jsonl`。**

**③ 读 subagent transcript 的函数已存在，但只取 tool_calls**

- **【读码】** `parsers/claude.rs:950-961`：拿 `toolUseResult.agentId` → `is_safe_subagent_id` 防穿越 → 拼 `<session>/subagents/agent-<id>.jsonl` → `parse_subagent_tool_calls`
- **【读码】** `parse_subagent_tool_calls`（`claude.rs:1620`）**只抽 tool_use/tool_result 配对**成 `Vec<AgentToolCall>{tool_name,input_preview,output_preview,is_error}`（`models/message.rs:15-20`），**丢弃全部 text/thinking**
- 前端 `agent-tool-call.tsx:254-257` 渲染 `agentStats.tool_calls`，`content-parts-renderer.tsx:2325` 还剥掉 `agentStats` 防递归 → **用户看到的是工具调用列表，不是对话**

**【实测】数据本身是全保真的**：样本 `agent-a0e3fec5a93d807f5.jsonl` 45 行 = `assistant×25 / user×18 / attachment×2`，格式与主会话同构，每行带 `agentId` + `isSidechain:true`。旁边还有 `agent-<id>.meta.json`：
```json
{"agentType":"general-purpose","description":"对比三个CLI最新版与本机版","toolUseId":"toolu_012eXKjkYJAhMcADtk63BGU3","spawnDepth":1}
```
`toolUseId` 正是与 codeg 父卡 `tool_call_id` 的**现成关联键** —— 归属不需要猜。

---

## 4. 架构 / 前提质疑 + 业务现实核查（§0.17）

### 4.1 XY 回推

用户的 Y（表层诉求）= 「内置 SUB 也能像委托那样单独打开、单独发消息」。
X（真问题）= **「我派出去的子代理，我要能看见它在干什么，并在它跑偏时切进去纠正」**。

这个 X 有两条独立的满足路径，而 codeg 已经有一条完整的（委托）。所以本任务的真实性质**不是**「补齐 A 的能力」，而是**「在 A 与 B 之间做路由选择」** —— 而 `58d63358` 已经这么干了（改 `tool_schema.json` 文案，把「要可交互子代理」的请求引流到 `delegate_to_agent`）。

### 4.2 业务现实核查（四问）

对「让内置 SUB 可被用户单独发消息」这个新建能力：

| 问 | 答 |
|---|---|
| ① 真实场景 | 用户在 codeg 里让主 AI 派了个内置 SUB 干长任务，中途想纠正方向 —— **真实场景成立** |
| ② 缺失影响 | 用户只能对主 AI 说「告诉那个 sub 改成 X」，多一跳、且主 AI 可能不转达 —— **真实但非阻断**（有 workaround） |
| ③ 已有覆盖 | **有，且是完整覆盖**：`delegate_to_agent` 通路（B）提供全部诉求能力，`58d63358` 已把路由文案指向它 |
| ④ 分级 | 「用户直发内置 SUB」= **D 类（技术整洁强迫症 + 协议不允许）→ 不做**<br>「看内置 SUB 完整过程」= **A 类（真实可观测性缺口，且无替代 —— 主 AI 不会把 SUB 的中间过程转述给用户）→ 做** |

**『业务现实建议』**：把「真双向」从需求里摘掉。它同时踩两条线 —— 协议不允许（§3.1）+ 已有等价覆盖（B 通路）。真正的 A 类缺口只有**只读观测**。

### 4.3 更好方案（建议）

**不要为内置 SUB 造第二套会话/交互体系。** 理由：会造出第二个 SSOT（`ConversationKind::Delegate` 之外再来一套子会话身份），而内置 SUB 连 `external_id` 都没有、进程死即灰飞烟灭，撑不起 B 那套持久语义。

正确的性价比排序是：**先把已经到手的数据显示出来（§5 方案 1），再谈交互。**

---

## 5. 候选方案（按事实排序，非按诉求排序）

### 方案 1 · 只读增强 A：接通 raw SDK 通道（推荐首选）

- **做什么**：放宽 `connection.rs:6845` `map_claude_sdk_ext_notification` 的过滤，让带 `parent_tool_use_id` 的 assistant/user 消息通过；按 `parent_tool_use_id` 归组挂到父 `Agent` tool_call 卡下；前端在 `agent-tool-call.tsx` 的现有胶囊里增加「完整过程」折叠区
- **效果**：**实时**看到内置 SUB 的完整 prose + thinking + 工具流
- **协议阻断**：无。数据已在线上（§3.2①）
- **改动面**：中。后端 1 处 mapper + 1 个新 event 变体 + `event_stream.rs` 尺寸核算（`agent_stats_size` 同类）+ 前端 1 个渲染区
- **风险**：raw 通道是**全量 SDK 消息**（`shouldEmitRawMessage(true)` → 一律 true），放宽过滤有**流量/内存放大**风险，必须按 `parent_tool_use_id != null` 精确白名单，不能整体放开。`SDKMessageFilter[]` 支持 `{type,subtype,origin}` 过滤（`acp-agent.js:4371`），但**无 `parent_tool_use_id` 维度** → 过滤只能在 codeg 侧做。**需实现方核实**：非 Claude agent 不受影响（`claude_raw_sdk_session_meta` 已 gate）

### 方案 2 · 只读增强 B：尾随 `subagents/agent-*.jsonl`（推荐并行做，或作为方案 1 的历史补充）

- **做什么**：`background_watch.rs` 在 tail 父文件时，对每个 `async_launched` 的 `agentId` 同时 tail `<session>/subagents/agent-<id>.jsonl`；复用 `ClaudeRecordAccumulator` + `group_into_turns`；用 `agent-<id>.meta.json` 的 `toolUseId` 归属到父卡
- **效果**：完整历史 + 准实时（1s 轮询）；**且历史会话重新打开也能看**（方案 1 只覆盖 live）
- **协议阻断**：无。纯本地文件
- **改动面**：中偏小。既有零件齐全：`is_safe_subagent_id` 防穿越、路径拼接、`ClaudeRecordAccumulator`、`BackgroundActivity` 事件与前端消费链全在
- **风险**：轮询文件数随 SUB 数线性增长（需上限）；**仅 Claude 有此落盘结构**（OpenCode/CodeBuddy 走各自的，`codebuddy.rs:820 agent_stats_from_subagent` 是另一套）→ 需按 agent gate
- **【推断】** 方案 1+2 组合 = live 走线上、历史走落盘，与 codeg 现有「wire 渲染 + 落盘补全」的既定分工一致

### 方案 3 · 伪双向：用户输入 → 转成主 AI 的 steering（唯一可行的「发消息」）

- **做什么**：用户在内置 SUB 卡里输入 → codeg 走 `_session/steering`（或现有 `check_user_feedback` 反馈通道）把「请用 SendMessage 转告 agent `<agentId>`：<用户原话>」注入父 turn → 主 AI 调 `SendMessage(to:<agentId>)`
- **效果**：功能上「用户能给内置 SUB 发消息」
- **协议阻断**：**不是直连**。语义上是「请主 AI 代为转达」，主 AI **可以不转达 / 可以改写**。不可靠、不可保证
- **改动面**：小（`_session/steering` 尚未接入 codeg，见 `registry.rs:251-252` 明写「not wired into codeg yet」—— 但那条注释是 codex-acp 的；Claude 适配器同样暴露 `steer`）
- **风险**：**语义骗人**。用户以为在直连，实际是提示词转达。若做，UI 必须明说「通过主代理转达」。**不建议在方案 1/2 之前做**

### 方案 4 · 真双向直连

- **判定：不可行（协议不允许）**。见 §3.1。前提是上游给 ACP 加 subagent 寻址扩展（或 `SendMessage` 上线为 ACP 方法）。可关注 design.md D1 已记录的 `claude-agent-acp` PR #881（`subagent-transcript` capability，未合，且只解决「看」不解决「发」）—— **需实现方核实其当前状态**

---

## 6. 真实修改范围

若采纳方案 1+2（推荐组合）：

| 文件 | 改什么 |
|---|---|
| `src-tauri/src/acp/connection.rs` | `map_claude_sdk_ext_notification`（`:6845`）放宽过滤 + 新 event 分支 |
| `src-tauri/src/acp/types.rs` | `AcpEvent` 新增子代理消息变体（`ClaudeSdkMessage` 旁） |
| `src-tauri/src/acp/event_stream.rs` | 新变体的尺寸核算（对齐 `agent_stats_size`，`:532`） |
| `src-tauri/src/acp/background_watch.rs` | 子 transcript tail 注册/注销 + 归属 |
| `src-tauri/src/parsers/claude.rs` | 复用 `group_into_turns` 产出完整 turn（现有 `parse_subagent_tool_calls` 保留不动） |
| `src/lib/types.ts` | 事件类型镜像 |
| `src/contexts/acp-connections-context.tsx` | 新事件分发 |
| `src/components/message/agent-tool-call.tsx` | 「完整过程」折叠区 |
| `src/i18n/messages/*.json` | 10 语言文案 |

**明确不改**：`delegation/` 全目录（B 通路不受影响）· `is_subagent_invocation`（Claude 不走它，且改它会波及 OpenCode/CodeBuddy）

---

## 7. 可并行拆分建议

| 包 | 范围 | 目标 | 依赖 | 可并行 |
|---|---|---|---|---|
| W1 | `types.rs` + `event_stream.rs` + `lib/types.ts` | 先定事件契约（子代理消息形状 + 归属键 `parent_tool_use_id`/`toolUseId`） | 无 | 否（W2/W3 的前置） |
| W2 | `connection.rs` mapper | live raw 通道接通 | W1 | 与 W3 并行 |
| W3 | `background_watch.rs` + `claude.rs` | 落盘 transcript tail | W1 | 与 W2 并行 |
| W4 | `agent-tool-call.tsx` + context + i18n | 渲染 | W1（契约定了即可开工） | 与 W2/W3 并行 |

**风险交叉点**：`connection.rs` 是超大文件（10434 行）且 `2505e164` 刚改过 599 行 —— W2 单独占用，勿与他人并发编辑。`types.rs::AcpEvent` 是三方共享枚举 → W1 必须先落地并广播。

---

## 8. Domain-Model 对账

**不适用**（`docs/domain/` 目录不存在，本仓库未采用该分层约定）。但 §5 方案会新增一条「数据获取维度」（子代理 transcript 的两条来源：线上 raw / 落盘 tail），建议在 `docs/specs/` 新 spec 的 design 里明确二者分工与去重键，避免同一条消息双路渲染。

---

## 9. 交付物

**本轮仅侦察报告。** spec 三件套 / tasks.md 由主调度依模板产出。
若立项，建议 slug：`builtin-subagent-observability`（**注意命名不含 "interaction"** —— 依 §4.2，真双向不在范围内）。
