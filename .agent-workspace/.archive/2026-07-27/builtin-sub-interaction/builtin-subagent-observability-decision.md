# 内置子代理可观测性 — Boundary Decision Card

> slug: `builtin-subagent-observability`
>
> 目标（一句话可验证成功态）：用户在 codeg 里看到主 AI 派发的**内置 SUB**（Claude
> 自己的 Task/Agent 工具子代理）时，能点进去看到它的**完整过程**（消息流、工具调用），
> live 与历史会话都能看 —— 而不是只有一个摘要行。

## ⛔ 范围边界（用户已裁决 · 不得擅自扩张）

- **不做双向对话**。真双向被协议封死：适配器对外 17 个方法（`acp-agent.d.ts:615-743`）
  无一接受 `agentId`/`taskId`，全部以 `sessionId` 寻址，而内置 SUB **复用父 sessionId**
  （已实测）。`SendMessage` 是 Claude CLI 内部工具，只有模型能调，codeg 够不着。
- **不做伪双向**（用户输入→主 AI 代转达）：语义骗人，主 AI 可不转达/可改写。
- 「用户直发内置 SUB」按 §0.17 判 **D 类**（协议不允许 + 委托通路已完整覆盖，
  且 commit `58d63358` 已把路由文案引流到委托）→ **不实现**。
- 「看完整过程」判 **A 类**（真实缺口、无替代）→ 本卡片范围。

---

## 🏗️ 1. Boundary Decisions

- **Bounded context**：`acp` 事件映射 + `parsers/claude` transcript 解析（基础设施层）。
  纯读取与呈现，不产生新领域概念。
- **状态机**：无。内置 SUB 的生命周期由代理进程拥有，codeg 只是观察者。
- **不变量**：
  1. **只读**。codeg 绝不向内置 SUB 写入/发消息（协议上也做不到）。
  2. **归属必须显式**：每条 subagent 消息必须能追溯到父 `tool_use_id`，
     不得混入父会话主流（否则父对话被子代理噪声淹没）。
  3. **raw 通道白名单精确放宽**：`emitRawSDKMessages` 是**全量**通道，
     放宽 mapper 时必须按类型精确过滤，**不得整体放开**（会灌爆事件流）。
- **ADR admission**：**否** —— 无新依赖方向、无边界重划；扩展既有 mapper +
  既有 tailer。可逆（收回白名单即回到当前行为）。

---

## 🔍 2. Existing-Implementation Search

**内部（trio + git grep + recon 报告 `builtin-sub-interaction-recon.md`）**

| 查询 | 命中 | 结论 |
|---|---|---|
| raw SDK 通道是否已开 | `connection.rs:2136` `claude_raw_sdk_session_meta()` 注入 `emitRawSDKMessages:true` | ✅ **已开** |
| 适配器是否过滤 subagent | `acp-agent.js:1479` `shouldEmitRawMessage()` 在 SDK 循环最顶端、任何 subagent 过滤**之前**无条件转发 | ✅ **消息已到达 codeg** |
| codeg 侧阀门 | `connection.rs:6844-6857` `map_claude_sdk_ext_notification()` → `if !is_claude_api_retry_message() { return None }` | 🔴 **只放行 system/api_retry，其余全扔** — 通道开着、阀门关着 |
| transcript 尾随器 | `background_watch.rs`（1s 节奏 · 整套 turn 组装 + 前端消费链齐备） | ✅ 复用；但**从不打开 `subagents/` 目录** |
| 是否已读 subagents jsonl | `parsers/claude.rs:950-961` | ⚠️ **已读但只抽 tool_calls**，未取消息流 |
| `is_subagent_invocation()` | `connection.rs:6376` | ⚠️ **显式排除 Claude**，只对 OpenCode/CodeBuddy 生效 — 不可复用 |
| `sub-agent-overlay.tsx` / `sub-agent-session-dialog.tsx` | 前端 | ⚠️ 渲染的是**委托**卡，与内置 SUB 无关 — 可参考形状，不可直接复用 |

**外部（实物解包，非文档推断）**

- `@anthropic-ai/claude-agent-sdk@0.3.219` `sdk.d.ts`：
  - **`parent_tool_use_id: string | null`（`:2857`）** — SDKMessage 自带的 subagent
    归属键。非 null 即来自 subagent。**这是不变量 2 的实现基础。**
  - **`getSubagentMessages(sessionId, agentId, options)`（`:796`）** — SDK **官方**
    subagent 消息读取 API；`:1003` 注释直接给出路径
    `~/.claude/projects/<dir>/<sessionId>/subagents/agent-<agentId>.jsonl`。
  - `agentID?: string`（`:247`）
- 落盘实测（本会话自己的 SUB 样本）：每行含 `agentId` + `isSidechain:true` +
  `parentUuid` 链；assistant 行另有 `attributionAgent`；同目录每个 SUB 配一份
  `agent-<id>.meta.json`（含 `toolUseId` — 与父卡关联的现成键）。

**结论**：三块料齐备（live 通道 / 落盘数据 / 尾随器+前端链），**只差最后一跳**。
不新建并行实现。

---

## 📐 3. Interface Contract

### 3.1 Live 路径（放宽 mapper 白名单）

```
_claude/sdkMessage { sessionId, message }
  └ message.parent_tool_use_id != null  → 判定为 subagent 消息
      └ 新 AcpEvent 变体（携带 parent_tool_use_id）→ 前端按父 tool_use 归组
```

- 白名单**按 message.type 精确放行**（assistant / user / tool 结果等实际需要的），
  不得 `return Some(..)` 兜底放开（不变量 3）。
- 现有 `api_retry` 分支行为**不得改变**（回归风险）。
- 注意：适配器转发时只带 `sessionId` + `message`，**不带 agentId** —— 所以归属
  只能靠 `message.parent_tool_use_id`，这是唯一可用键。

### 3.2 历史路径（尾随 `subagents/*.jsonl`）

```
<父session>/subagents/agent-<agentId>.jsonl   +   agent-<agentId>.meta.json
  └ meta.json 的 toolUseId → 关联父会话的那次 Task 工具调用
```

- 复用 `background_watch.rs` 既有 turn 组装 + 前端消费链，仅新增目录来源。
- 复用/扩展 `parsers/claude.rs:950-961`（已在读该目录，扩展为取消息流而非只取
  tool_calls）—— **扩展既有解析，不新写一个 parser**。

**组装算法（权威规格 · 来自 SDK `getSubagentMessages` 文档，`sdk.d.ts:784-796`）**：

> *"Parses the subagent transcript, **builds the conversation chain via parentUuid
> links**, and returns user/assistant messages **in chronological order**."*

→ 硬约束：**按 `parentUuid` 链组装，不得按行序**（行序≠对话顺序；上游
 issue #33651 就是 parentUuid 链重建选错 tip 导致 28 条消息静默丢失）。
只取 user/assistant（`attachment` 等其他 type 不入消息流）。
官方 `GetSubagentMessagesOptions` 带 `limit`/`offset` → **官方也认为此处需分页**，
印证 K1；前端展示应支持分页/懒加载。

### 3.3 前端

- 内置 SUB 卡片可展开 → 完整消息流。形状参考 `sub-agent-session-dialog.tsx`
  （委托侧），但**明确无输入框**（不变量 1：只读）。

---

## 🧪 4. Test Boundaries (TDD Red)

1. `subagent_sdk_message_is_mapped_with_parent_tool_use_id` — `parent_tool_use_id`
   非 null 的 raw 消息被映射，且携带该 id。
2. `main_thread_sdk_message_is_not_treated_as_subagent` — `parent_tool_use_id`
   为 null 时不进 subagent 通路。
3. `api_retry_mapping_unchanged` — 回归：既有 `api_retry` 行为不变。
4. `raw_channel_does_not_leak_unwhitelisted_types` — 守不变量 3：未白名单的
   message.type 仍被丢弃（防"整体放开"）。
5. `subagent_transcript_is_parsed_into_message_stream` — 解析 `subagents/*.jsonl`
   得到消息流（含 assistant/user），非仅 tool_calls。
6. `subagent_meta_json_links_to_parent_tool_use` — `meta.json` 的 `toolUseId`
   正确关联父卡。
7. 边界：`subagents/` 目录不存在 / jsonl 半行（尾随时文件正在被写） /
   畸形 JSON 行 / 同一父会话多个并发 SUB / SUB 数量很多时的性能。

### 4.1 端到端验收（单测绿 ≠ 真接入）

| # | 验收项 |
|---|---|
| E1 | 主 AI 派一个内置 SUB → 用户能在 UI 点进去看到**完整消息流**（非摘要） |
| E2 | live 过程中消息**实时**出现（走 raw 通道，非等落盘） |
| E3 | 历史会话（重开 codeg）也能看到内置 SUB 完整过程（走 tailer） |
| E4 | 父对话**未被** subagent 消息污染（不变量 2） |
| E5 | 事件流未被灌爆（不变量 3）—— 多 SUB 并发时 UI 不卡 |
| E6 | 桌面与 Web/服务器模式一致 |

---

## 🛡️ 5. Anti-Corruption Layer & Registration

- **隔离**：SDKMessage 的 JSON 形状是第三方契约，收敛在 mapper 一处（SSOT）。
- **注册清单**：
  - [ ] 新 `AcpEvent` 变体 → 事件桥（Tauri 事件 + WebSocket 广播**双模式对等**）
  - [ ] 前端 `types.ts` 镜像 + adapter
  - [ ] i18n ×10（若有新文案）
  - [ ] `parsers/claude.rs` 扩展 + 快照测试（`cargo insta review`）

---

## ⚠️ 6. 风险与未验项

| ID | 项 | 状态 |
|---|---|---|
| K1 | raw 通道放宽后的**事件量级**未实测（多 SUB 并发 / 长任务）；可能需要节流或按需订阅 | 🟡 未验 — 实现时须实测 E5 |
| K2 | `getSubagentMessages()` 适配器是否透出 | 🔴 **已查·未透出（2026-07-27）** — 适配器全包（acp-agent.js/.d.ts/tools.js/lib.js）grep `getSubagentMessages|subagentMessages` **零命中** → §3.2 解析工作**省不掉**。但其文档是**权威组装规格**（见 §3.2） |
| K3 | live（raw 通道）与历史（jsonl）两路的**去重/一致性**：同一条消息两路都到时如何合并 | 🟡 未验 — 需定义合并键（uuid？） |
| K4 | `parent_tool_use_id` 在**嵌套 SUB**（SUB 再派 SUB）下的语义未验 | 🟡 未验 |

**实施顺序**：先查 K2（可能省一大块）→ 红：测试 1-4 → 绿：mapper 放宽 →
红绿：测试 5-6（transcript）→ 前端 → E1-E6 端到端 → 变体复扫 → 写回
CHANGELOG + ARCHITECTURE。

## Update Log

- 2026-07-27 **K2 已查结**：`getSubagentMessages` 适配器**未透出**（全包零命中），
  解析工作省不掉。但其文档提供了**权威组装算法**（按 `parentUuid` 链、时序输出、
  只取 user/assistant）已写入 §3.2；其 `limit`/`offset` 选项印证 K1 分页需求。
  另已确认 `parent_tool_use_id: string|null`（`sdk.d.ts:2857`）在 SDKMessage 上，
  为 §3.1 live 路径的唯一可用归属键（适配器转发时只带 sessionId+message，不带 agentId）。

- 2026-07-28 **第一阶段（§3.1 live 通道）已实现 · executor** — 未 commit，交主 AI 统一提交。

  **本轮最有价值的发现（推翻卡片与派单的一处共同前提）**：原判「适配器在任何
  subagent 过滤之前无条件转发，**所以内置 SUB 的每条消息已经到达 codeg 了**」——
  前半句成立，**后半句不成立**。`emitRawSDKMessages` 与
  `forwardSubagentText` 是**两个不同层**的开关：前者决定「适配器要不要把 SDK 帧
  转发给 ACP 客户端」，后者决定「CLI 要不要把 subagent 文本**产出成** SDK 帧」。
  SDK `sdk.d.ts:1633-1638` 原文：`forwardSubagentText?: boolean` — "**By default,
  only tool_use/tool_result blocks from subagents are emitted** (enough for a
  heartbeat counter). When true, the full subagent conversation is forwarded so
  consumers can render a nested transcript."
  即 **raw 通道全量 ≠ 内置 SUB 消息已到达**：prose/thinking 在 CLI 侧就没生成，
  下游再怎么放宽阀门也搬不到不存在的东西。只放宽 mapper 会得到「只有工具调用、
  没有对话内容」的空 transcript。证据：`forwardSubagentText` 在适配器包
  （acp-agent.js/.d.ts/tools.js/lib.js）**零命中**，仅存在于 SDK `sdk.mjs`（4 处，
  由 `initConfig` 透传）；适配器构造 `options` 时不设它，而
  `userProvidedOptions = sessionMeta?.claudeCode?.options`（`acp-agent.js:3989`）
  是用户可透传的，且它**不在**适配器的 ACP 覆盖黑名单（`acp-agent.d.ts:428-436`
  仅列 cwd / includePartialMessages / allowDangerouslySkipPermissions /
  permissionMode / canUseTool / executable）。

  **裁决落地（用户已批准）**：`claude_raw_sdk_session_meta()`（`connection.rs:2135`）
  除 `emitRawSDKMessages: true` 外增加 `options: { forwardSubagentText: true }`。
  作用域刻意只有这一个键——`tools` 是整体预设覆盖（会**降低**工具能力）、
  `allowedTools` 语义是免确认而非限制、`mcpServers` 无法约束既有服务器；
  由 `claude_session_meta_enables_subagent_text_forwarding` 测试钉住这份窄性。

  **改动清单**
  - `src-tauri/src/acp/connection.rs:2135` — `claude_raw_sdk_session_meta()` 注入
    `options.forwardSubagentText`（含上述两层开关差异的注释）
  - `src-tauri/src/acp/connection.rs:6857` — `SUBAGENT_LIVE_MESSAGE_TYPES`
    白名单常量 + `claude_subagent_parent_tool_use_id()` 归属键提取
  - `src-tauri/src/acp/connection.rs:6890` — `map_claude_sdk_ext_notification()`
    扩展（**未新建第二个 mapper**，§5 SSOT）
  - `src-tauri/src/acp/types.rs:69` — 新 `AcpEvent::ClaudeSubagentMessage`
    （`parent_tool_use_id` 为**必填**字段，落实不变量 2）
  - `src-tauri/src/acp/event_stream.rs:368` — 结构化尺寸核算（对齐
    `ClaudeSdkMessage`，避免锁内序列化 fallback）
  - `src-tauri/src/acp/session_state.rs:1000` — 归入「不改可见字段」分支
  - `src/lib/types.ts:1253` — 前端契约镜像

  **放行的 message.type 及理由**（显式枚举，**无兜底**）：
  `["assistant", "user"]`。`assistant` = subagent 的 prose/thinking，这是**唯一**
  live 来源（typed 路径上适配器主动剥离：`acp-agent.js:2675-2681` 对
  `parent_tool_use_id !== null` 执行
  `filter(item => item.type !== "text" && item.type !== "thinking")`）；`user` =
  subagent 的 tool_result 与启动 prompt，否则 transcript 只剩半边对话。
  不兜底的依据：`shouldEmitRawMessage(true, _)` 直接 `return true`
  （`acp-agent.js:4371`）= 全量火管，兜底会把 per-token `stream_event` 与
  `tool_progress` / `command_lifecycle` / `tool_use_summary` / `result` /
  `control_response` 全部灌入事件流并挤占 ring buffer。
  `api_retry` 分支**提前**到 subagent 判定之前，使带 `parent_tool_use_id` 的重试帧
  仍走原事件类型（横幅是 session 级瞬态提示，不应被吞进 transcript）。

  **双模式对等（K 项外的一处认知纠正）**：`AcpEvent` 走统一信封
  （`emit_with_state` → per-connection `ConnectionEventStream` + `InternalEventBus`
  + Tauri `app.emit`），`ws_attach.rs:218 spawn_forwarder` 对
  `Arc<EventEnvelope>` 泛型转发、不做变体判别 → **新变体自动双模式对等，无需逐变体
  注册**。§5 注册清单里「新 AcpEvent 变体 → 事件桥双模式」一项据此视为满足。

  **验证（真跑，命令与结论一一对应）**
  - RED（mapper 未动，仅先落 `AcpEvent` 变体以取得干净的断言红）：
    `subagent_sdk_message_is_mapped_with_parent_tool_use_id ... FAILED`
    （`panicked: a subagent assistant message must map to an event`），
    其余 3 个 ok → `FAILED. 3 passed; 1 failed`。
    `claude_session_meta_enables_subagent_text_forwarding ... FAILED`
    （`left: None, right: Some(true)`）。**均为功能缺失的断言失败，非编译错误。**
  - GREEN：5 个新测试 + 既有 `claude_raw_sdk_meta_enabled_only_for_claude` /
    `build_resume_session_request_sets_claude_raw_meta` / `openclaw_*` 全 ok。
  - `cargo test --no-default-features --bin codeg-server --lib` → **1811 passed;
    0 failed; 1 ignored**。
  - `cargo clippy --all-targets --features test-utils -- -D warnings` → **exit 0**；
    `cargo clippy --no-default-features --bin codeg-server --lib -- -D warnings`
    → **exit 0**；`cargo check --no-default-features --bin codeg-server` → **exit 0**。
  - `npx tsc --noEmit` → **exit 0**；`pnpm test` → **225 文件 / 2838 测试全通过**。

  **⚠️ 未能取得的证据（诚实标注，勿当已验）**
  - `cargo test --features test-utils`（桌面 harness）**跑不起来**，非本轮引入：
    `codeg_lib-<hash>.exe (exit code: 0xc0000139, STATUS_ENTRYPOINT_NOT_FOUND)`。
    受控对比：把本轮全部改动 stash 后、在**磁盘已扩容至 47.8 GB 空闲**的干净 HEAD
    上跑既有测试 `claude_raw_sdk_meta_enabled_only_for_claude`，**同样失败** →
    与本轮改动无关，亦非磁盘（我最初的磁盘归因**不完整**：磁盘耗尽确实曾造成
    `os error 112` 构建失败，但修复空间后 STATUS_ENTRYPOINT_NOT_FOUND 依旧）。
    进一步定位：`--no-default-features` 的 server harness 在同机同源同链接器下
    **可正常运行** → 触发条件在 `tauri-runtime` feature 的某个依赖，不在 codeg 源码。
    已排除：ShadowBot 目录抢占 `vcruntime140.dll`（移出 PATH 后仍失败）、
    局部覆盖 system32 版 vcruntime（仍失败）、harness 未重链（时间戳确认已重链）。
    **未定位到具体缺失导出符号**（缺 dumpbin；自写 PE 解析器有 bug，已止损）。
    → 建议单独立项处理，不宜混入本卡片范围。本轮的 Rust 侧证据全部由 server
    harness 提供（同一份 `connection.rs`），属有效替代但**非**桌面模式实测。
  - **K1 事件量级：未实测**。本轮无端到端真跑（无 instrumentation、未起带内置 SUB
    的真实会话），**不给猜测数字**。且 `forwardSubagentText: true` 会**增加**上游
    产出量，正是 K1 担心的方向 → E5「多 SUB 并发时 UI 不卡」仍为未验。
    仅能给出结构性判断（非实测）：已挡掉 `stream_event`（最大量级来源），量级应接近
    「每条完整 subagent 消息一个事件」而非 per-token；新变体已按结构计入
    `estimate_envelope_size`，受既有 per-event cap 约束；但 ring buffer 是**共享**的，
    多 SUB 并发挤占父会话事件的风险真实存在。
  - `pnpm eslint` 报 3000+ `Delete ␍` prettier 错 —— 受控对比证实**既存**
    （未碰过的 `src/lib/api.ts` 同样报；把 types.ts 改动 stash 后在 HEAD 上仍报
    3141 条）。按裁决**未跑** `--fix`（会重写整仓行尾，远超范围）。

  **交付契约核验（§0.16）**：派单未带 `[交付契约]` 块，我未代填。链路核验结果——
  raw 通道（`acp-agent.js:1479`）→ mapper（`connection.rs:6890`）→ 事件桥双模式
  → **前端消费者缺失**：`acp-connections-context.tsx` 的 switch 无
  `case "claude_subagent_message"`。这是派单范围（只做 live 通道）的必然结果，
  但意味着 **E1「用户能点进去看到完整消息流」本阶段不成立**，需第四包（渲染）才闭环。
  未擅自扩到前端渲染。

  **本阶段明确未做**：§3.2 历史路径（`subagents/*.jsonl` 解析 + tailer）、
  前端渲染、i18n ×10 —— 按派单留给第二阶段。

- 2026-07-27 **第四包（前端渲染）已实现 · executor** — 未 commit，交主 AI 统一提交。

  **交付契约核验（§0.16）**：派单**未带** `[交付契约]` 块，我未代填。按 §0.16 逐跳核验既有链路：
  raw 通道（`acp-agent.js:1479`）→ mapper（`connection.rs:6890`）→ 事件桥双模式
  → **前端消费者（本包补上）** → 归组存储 → 胶囊内渲染 → 用户可见。链表已闭合，
  唯一未验节点是"真实会话端到端跑一次"（见下方未取得证据）。

  **改动清单**
  - `src/lib/subagent-transcript.ts`（新）— 去重键 + verbatim SDK 帧 → 项目 `ContentBlock` 归一化 +
    视图构建（计数 / 活动尾 / 任务 prompt 抽离）。纯函数，第二阶段 jsonl 路径可直接复用同一套键。
  - `src/contexts/subagent-transcript-context.tsx`（新）— 按 `parent_tool_use_id` 索引的 live 存储；
    `useAcpEvent` 消费 `claude_subagent_message`；rAF 批处理；ref+listener 而非 React state。
  - `src/components/message/subagent-transcript.tsx`（新）— 只读 transcript 区块（只读徽标+tooltip /
    任务 prompt / thinking 默认折叠 / prose / 内联工具走父注入口 / E-5 分页锚 / E-6 截断行）。
  - `src/contexts/live-observability-providers.tsx`（新）— DelegationProvider + SubagentTranscriptProvider
    组合；layout 只换一个标签名，避免整块 JSX 重缩进（见下方 prettier 说明）。
  - `src/components/message/agent-tool-call.tsx:17,273,345,428` — 订阅 frames、pill 计数徽标、
    body 内挂 transcript、running 时单行活动尾。
  - `src/components/message/agent-capsule.tsx:62` — `userToggled` 标记；running→completed 自动折叠
    仅在 `!userToggled` 时生效（**未删除**自动折叠）。
  - `src/app/workspace/layout.tsx:26,1149,1185` — 挂载 `LiveObservabilityProviders`。
  - `src/i18n/messages/*.json` ×10 — 设计卡 13 个 key，`Folder.chat.contentParts` 命名空间。

  **去重键最终方案（坑 1 · 决策卡 K3）**：优先 `uuid`（落盘行有、live 事件没有，留给第二阶段），
  否则 `(parent_tool_use_id, message.id, 内容指纹)`。指纹 = 各 content block 的 `type` + 长度 +
  djb2(文本/thinking/tool id/tool input) 聚合。**理由与实测**：同一 `msg_…` 跨多帧出现（各行 uuid 不同），
  单用 `message.id` 会把同一消息的后续内容当重复吞掉（与 upstream #33651 静默丢消息同类）；
  加内容指纹后，同 id 不同内容 = 不同帧，真正的重复投递指纹一致而折叠。
  逻辑在 `src/lib/subagent-transcript.ts` 的纯函数里（不埋在组件），注释写明了"为什么不能只用 message.id"。

  **自动折叠那处怎么改的**：`agent-capsule.tsx` 新增 `userToggled` state，只有 `CollapsibleTrigger`
  的 `onOpenChange` 会置 true；`prevIsRunning && !isRunning && !isError && !userToggled` 才自动折叠。
  即 caller 用 `defaultOpen` 播种的 / 错误自动展开的仍会被跑完收起（旧纯工具胶囊行为不回归），
  用户亲手点开的不会被当面关掉。既有测试 `auto-collapses once when running transitions to completed`
  相应改为用 `defaultOpen` 播种（语义变了：它守的是"非用户开的仍会收起"），并新增
  `capsule_stays_open_after_manual_expand_when_run_completes` 守新行为。

  **并发抗崩四道闸落实位置**：① 默认全折叠（沿用 `AgentCapsule`，未改初始态）；
  ② running 时每个 SUB 仅 1 行 `truncate` 活动尾（`agent-tool-call.tsx:428`，非滚动区）；
  ③ transcript 只在展开时挂载（`CollapsibleContent` 的 unmount-when-closed 契约已由
  `instant-collapsible.tsx:135` 的 `present` 状态保证，已读源码确认，不需额外 `open &&` 条件）；
  ④ 事件走 rAF 批处理（对齐既有 `scheduleToolCallUpdateFlush`），**非** per-event dispatch；
  另加 `MAX_SUBAGENT_FRAMES=400` / `MAX_TRACKED_SUBAGENTS=64` 两个上界。
  保留胶囊既有 `max-h-72`，未放大（virtua 测量抖动）。

  **不做清单遵守**：无输入框 / 无回复·继续·取消·停止键（连 disabled 都没有）/ 不在标签页打开 /
  不上侧边栏 / 不用 Dialog·Sheet·抽屉 / body 内不套第二层 Card（只用 `border-border/60` 分隔）/
  不显示 `agentId`（pill 上的 `idBadge` 换成 `N msg · M tools` 计数，codex 的 agent_id 作为 fallback 保留）/
  引流用只读徽标 + tooltip，非常显横幅。由 `agent-tool-call-subagent.test.tsx` 的
  `queryByRole("textbox")` + 五个按钮名的否定断言钉住。

  **测试（红 → 绿，真跑）**
  - RED（`.agent-workspace/red1.log`）：`2 failed | 4 failed / 7 passed (11)`，四条均为**断言失败**非编译错误：
    `subagent_message_is_grouped_under_parent_tool_call` → `AssertionError: expected '' to be 'A is working'`；
    `subagent_messages_do_not_enter_parent_message_stream` → `expected '' to be 'secret work'`；
    `dedupe_key_distinguishes_frames_sharing_message_id` → `expected null to be truthy`；
    `capsule_stays_open_after_manual_expand_when_run_completes` → `Unable to find an element with the text: LIVE BODY`。
  - GREEN：上述 4 条全绿；另加 2 条接入测试（`agent-tool-call-subagent.test.tsx`：胶囊内真渲染出
    transcript + 计数徽标 + 活动尾 + 只读徽标 + 无输入框；无 frames 时退化成裸 pill 不出空白盒）。
  - `pnpm test` → **227 文件 / 2844 测试全通过**（`.agent-workspace/full-final.log`），含 i18n 十语 key parity。
  - `npx tsc --noEmit` → **exit 0**。
  - `npx eslint <6 个新文件>` → **exit 0**（零报错）。

  **⚠️ 诚实标注**
  - **E1 未闭环到"实测可见"**：代码链路已闭合且有接入测试覆盖（合成 envelope → 真实 provider →
    真实胶囊 → 断言 DOM），但我**没有**起一个真实 Claude 会话派内置 SUB 跑端到端。
    E1/E2/E5 仍属未实测。E5（并发 5 个不卡）只有结构性论证 + 上界，无实测数字。
  - `pnpm eslint .` 全仓仍报约 3000 条 `Delete ␍`：**既存**，受控验证——未碰过的
    `src/lib/api.ts` 单文件即报 3985 条；`core.autocrlf=true`（索引 LF / 工作区 CRLF）。
    按派单未跑 `--fix`。我改动的既有文件（`agent-tool-call.tsx` / `agent-capsule.tsx` /
    `layout.tsx`）除行尾外无新增真问题（逐文件过滤确认）。
  - **一处方案偏离已自行纠正**：最初直接在 `layout.tsx` 的 provider 栈里插一层
    `SubagentTranscriptProvider`，导致 prettier 要求重缩进内层 35 行 JSX（远超本包范围）。
    改为抽 `LiveObservabilityProviders` 组合组件，layout 只换标签名 —— 顺带把"两个同源
    observability provider"收在一处。
  - **本阶段未做**：§3.2 历史路径（`subagents/*.jsonl` 解析 + tailer）、E-7 嵌套 SUB 的
    "含嵌套"提示（`subagentNestedNotice` key 已加但暂无产出方，K4 未验，形状未知）。
