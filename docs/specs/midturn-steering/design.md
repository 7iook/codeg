# Design · 派发子智能体期间的对话权与委托配置治理

Feature: `midturn-steering` · 2026-07-29
需求：`requirements.md` · 决策卡：`.agent-workspace/.archive/2026-07-29/midturn-steering/midturn-steering-decision-card.md`

## 1. 方案总览

核心洞察：**能力已经存在，缺的是接线。** `claude-agent-acp` 已实现 `_session/steering` 扩展方法，项目已有一条同形状的 mid-turn ext request 在生产运行（`send_goal_control`）。本设计不发明新机制，而是把已有的两半接起来。

四条链路，互相独立可分别交付：

```
R1/R2 注入   前端发送(时机选择) → ConnectionCommand::Steer → send_steering() → _session/steering
R3 可见性    纯前端：键区并列 + 队列时机文案
R4 破坏性告知 前端读 active_delegations 快照 → 取消确认框
R5 文案      纯 i18n
R6 resume    判定 → (若缺)前端入口
```

## 2. R1/R2 注入通路设计

### 2.1 能力探测（R2.1）

**落点**：`connection.rs:3246-3269`，与既有 `supports_fork`/`supports_resume` 完全同构。

steering 标志**不在** `agent_capabilities` 内，而在 initialize 响应**顶层** `_meta`：

```
init_resp.meta → { "steering": { "supported": true } }
```

`.meta` 已是可读字段（先例：`resume_resp.meta`、`new_resp.meta`、`fork_resp.meta`）。

新增 session state 字段 `agent_supports_steering: bool`，与 `agent_supports_resume` 并列持久化在同一 write 锁临界区内。

> **反直觉点（必须写进代码注释）**：按常规去 `agent_capabilities` 找会永远读到 `None`。这是 agent 私有扩展的位置约定，不是规范字段。

### 2.2 命令通路

照抄 `send_goal_control`（`connection.rs:4503-4517`）的骨架，四处对应改动：

| 位置 | 既有（GoalControl） | 新增（Steer） |
|---|---|---|
| 枚举 | `connection.rs:374` `ConnectionCommand::GoalControl{action}` | `ConnectionCommand::Steer{blocks, message_id, reply}` |
| 发送函数 | `:4503` `send_goal_control` | `send_steering(cx, session_id, blocks)` |
| turn 在飞分支 | `:6021` select arm | 同处新增 arm（**这是关键——必须在 prompting 态可达**） |
| 空闲分支 | `:6228` | 同处新增 arm |
| manager 入口 | `:1219` `goal_control` | `steer(conn_id, blocks, message_id) -> SteerOutcome` |

与 `goal_control` 的一处关键差异：`goal_control` 是 fire-and-forget（响应值刻意丢弃），而 **`steer` 必须把 outcome 回传给调用方** —— `injected` / `startedNewTurn` / `failed` 三态直接决定队列项的状态迁移（§2.5.1）。因此命令携带一个 oneshot `reply` 通道，不能照抄"丢弃响应"那一段。

### 2.2.1 授权边界（补评审 R3-A1 · P0）

**评审 A1 的动机成立，但其隐含前提在本项目不成立 —— 已实测纠正。**

评审要求"服务端身份 / 租户 / 账户"级授权绑定。实测本项目**不存在用户身份概念**：

- `web/auth.rs:21-45` `require_token` 是**单一共享 token**（一个 `CODEG_TOKEN` 覆盖整个服务）。持 token 者即拥有全部权限，无 per-user / 租户维度。
- 连接层只有 `owner_window_label`（`manager.rs:396`、`:1828-1834` `disconnect_by_owner_window`），用于**窗口生命周期管理**（关窗时断开该窗口的连接），**不是安全边界**。
- 全仓 `git grep user_id|tenant|principal` 在 web / manager 层零命中。

**因此"跨用户越权"在当前架构下不是可实现的威胁模型** —— 所有持 token 的客户端本就等价。虚构一个身份层来"满足评审"会造出与系统其余部分不一致的假安全边界（且无处取身份，只能伪造），那是更坏的结果。

**本轮实际要防的（真实且可实现）**：

| 风险 | 处置 |
|---|---|
| **`conn_id` 不存在 / 已断开 / 属于已关闭窗口** | 复用既有 `get_state_and_emitter` 的 `ConnectionNotFound` 路径（`manager.rs:1945`）。这是三入口都必须先过的一道，不得跳过直接操作 |
| **令牌被跨连接复用**（拿 conn A 的预览令牌去杀 conn B 的委托） | 令牌**绑定 `conn_id`**（身份层不存在，但 conn_id 绑定是实的且必要）。不匹配即拒绝 |
| **令牌重复提交导致二次取消** | 一次性消费 + 原子提交（§4 令牌契约） |
| **无鉴权旁路** | 新增端点必须挂在既有 `require_token` 中间件之后，**不得**开免鉴权路由。这是 Web 模式唯一的实际防线 |

**校验点在 `_core` 层**（Tauri 命令与 Web handler 共用，不得只在一侧加）—— 这一条评审说得对，与身份层是否存在无关。

**失败语义**：`conn_id` 无效返回既有 `ConnectionNotFound` 同形错误，不额外区分原因（与既有行为一致，无需为本功能特殊处理）。

**测试要求**（按真实威胁模型，非虚构身份）：
- 不存在 / 已断开的 `conn_id` → 三入口各一条，断言返回 `ConnectionNotFound` 且无副作用；
- conn A 的令牌 + conn B 的提交 → 拒绝；
- 同一令牌提交两次 → 第二次拒绝且**不产生第二次取消**；
- 新增端点未挂 `require_token` → 应被路由层测试或 grep gate 抓出。

**登记为架构债（不在本轮解决）**：codeg 的 Web 模式是单 token 全权模型。若将来要支持多用户，`steer` / 取消 / 委托管理全都需要真正的身份层 —— 那是全局架构改动，不属本 spec。此处明确记录，避免后人误以为本功能"已做过多用户授权"。

`send_steering` 用 `UntypedMessage::new("_session/steering", params)` + `block_task()`，与 goal_control 一致（`_session/…` 同样无 sacp 类型变体）。

**params 形状**（锚 `acp-agent.js:913-947` 的 `parseSteerRequest`）：
```json
{ "sessionId": "<sid>", "prompt": [<ContentBlock>...] }
```

### 2.3 单一注入语义：默认排队 + 逐条「立即发送」（R1.1–R1.3 / C6）

**只做协议原生能力。** `_session/steering` 唯一语义是 `priority=now`（pre-empt 当前 generation）。**不实现**"等当前工具调用结束再插入"。

原方案（前端观测工具边界后延迟注入）**已废弃**，理由：前端事件观察无法保证在下一步开始前投递，且刷新 / 重连 / 多窗口下不可靠（评审 R1-A1 · P0）。调度责任若不在持有 turn 生命周期的一侧，就无法保证时序。

事实：SDK 定义 `priority?: 'now' | 'next' | 'later'`（`sdk.d.ts:4550`），但 ACP 包装层硬编码 `now`（`acp-agent.js:63` 常量 → `:948` 赋值），请求参数无该字段。→ `next` 从 ACP 这条路取不到。

**交互形态锚 Zed**（`zed.dev/docs/ai/agent-panel`）：

```
输入框始终可用 → Enter → 入队（默认，不打断任何东西）
                              ↓
              每条排队消息上有「立即发送」→ _session/steering (now)
                              ↓
                    打断当前生成，本轮内响应
```

- 默认路径 = 现有行为（入队、轮末发出），零风险、零改动。
- 「立即发送」是**逐条消息上的显式动作**，不是发送键的模式开关 —— 误触面积小，且与 Zed 的 "Send Now" 语义一致。
- 按钮语义必须让用户预期到"会打断"（R1.3）。

### 2.3.1 队列与注入的关系（避免双通道竞争）

队列是**唯一入口**，注入是队列项的**一种出队方式**：

| 出队方式 | 触发 | 通路 |
|---|---|---|
| 自动 flush | 轮末（`syncState→idle`） | 普通 prompt（现有，不改） |
| **「立即发送」** | 用户点击 | `_session/steering`（新增） |

同一队列项**只能被出队一次**。实现上出队即从队列移除并置 `in_flight`，两条路径共用该状态位；`in_flight` 项不重复呈现「立即发送」。这消除了"自动 flush 与手动注入同时取走同一条"的竞态。

### 2.4 `startedNewTurn` 竞态处理

`steer()` 在 session 已 idle 时会 detach 一个新 `prompt()` 并返回 `{outcome:"startedNewTurn"}`。此时 **codeg 的 `turn_in_flight` 与 user_message 广播完全不知情**，且上游 issue #903 承认 client 拿不到该 turn 的终态（修复 PR #919 未合并）。

**关键认识（修正评审 A2 · P0）**：`startedNewTurn` 意味着**消息已被 agent 接受且已在执行**。此前设计写的"按普通 prompt 通路重发"是**错的** —— 那会让同一条用户指令执行两次（agent 侧 detached turn 已在跑它，本端再发一遍）。**禁止补发。**

**处理策略：原子选择通路 + 承认已接受 + 本地重同步。**

1. **原子选择**：注入前在同一临界区内读 `turn_in_flight` 并决定通路 —— 在飞则走 steering，空闲则走普通 prompt。避免"以为在飞、实际已空闲"的窗口。这把 `startedNewTurn` 压缩为罕见残余竞态，而非常规路径。
2. **收到 `startedNewTurn` 时**（残余竞态）：
   - 该消息**视为已投递成功**（`injected` 与 `startedNewTurn` 都是成功语义），队列项按已出队处理，**不重发**；
   - **不得伪造 `turn_in_flight`**（修正评审 R2-A3 · P1）。`turn_in_flight` 的语义是"本端发起的 turn 在飞"，而 detached turn 由 agent 自行发起、本端既无 request 也拿不到终态（issue #903）。把它塞进同一个字段会污染既有状态机（超时清理、取消路径、队列 flush 门全部依赖该字段的真实性）。
   - 改用**独立的不可观测态** `detached_turn_pending: bool`（或计数），语义明确写作"agent 侧有一个我们看不见终态的 turn"。它**只影响 UI 提示**，不参与 `turn_in_flight` 驱动的任何判定。
   - **收敛条件必须是可关联事实**：仅当收到能关联到该 turn 的证据（该 session 后续 `session/update` 中携带可对应的 turn 标识、或该 session 断开/重连）才清除；**"任意终态事件"与"纯超时"都不能证明 detached turn 已结束**，不可作为收敛依据。
   - 若在当前 agent/版本上找不到任何可关联证据，则**该竞态路径不可靠** → 退化处理：`detached_turn_pending` 保持直到会话重连，且 UI 只做弱提示（不阻塞任何操作）。宁可提示多留一会儿，也不产生假状态。
3. **客户端记账规则**：队列项携带 `message_id`；投递成功（含 `startedNewTurn`）即标记该 id 已投递，后续路径见到已投递的 id 一律跳过。**这只是本端去重，不构成端到端幂等** —— 边界见 §2.5.1「幂等的真实边界」。

**取舍**：宁可承担"UI 多留一个弱提示"，也不承担"用户指令被执行两次"或"状态机被污染"。前者只是显示不精确，后两者会造成不可逆后果或连带故障。

### 2.5 降级矩阵（R2.2 / R2.3 / C4）

| 能力态 | 「立即发送」 | 行为 |
|---|---|---|
| **supported** + turn 在飞 | 呈现 | `_session/steering` → `injected`，本轮内响应 |
| **supported** + 已空闲（原子选择判定） | 呈现 | 走普通 prompt 新起一轮（不走 steering） |
| **supported** 但返回 `failed`（**当前无生产 producer · dormant**） | 呈现 | 消息**留在队列**、置回 `queued`，提示"当前阶段不可插入" |
| **unsupported** | **不呈现** | 入队，轮末发出（现有行为，不报错） |
| **unknown**（探测未落定） | **不呈现** | 同 unsupported（保守默认） |

### 2.5.1 队列项状态机（补评审 A3：证明不丢不重且可恢复）

```
queued ──「立即发送」/自动flush──→ in_flight ──成功(injected|startedNewTurn)──→ delivered(终态)
  ↑                                    │
  ├──────明确拒绝(outcome=failed)───────┤   (置回 queued，保留原位次，可再点)
  │                                    │
  └── 用户显式重发 ── unknown ←─────────┘   (无响应/超时/重启 · 结果未知 · 禁自动重试)
```

- **合法迁移仅上述四条**。`delivered` 是终态，不可回退。
- `unknown` **不是失败态也不是成功态**，是"我们不知道"。只能由用户显式操作离开该态。
- **消息身份**：`message_id`（客户端生成，随队列项持久化）。去重凭它，不凭内容。
- **不丢**：`in_flight` 失败必回 `queued` 且保留位次（复用现有队头/队尾回退语义 —— 手动注入的项属"队头回退"，因为它本就是用户指定的那一条）。
- **不重**：`delivered` 的 `message_id` 一律跳过。
- **唯一权威层**：队列状态由前端 store 单一持有并串行迁移；后端不维护第二份队列。理由：队列本就是客户端概念（agent 侧只知道收到的 prompt），引入第二份必然出现双真源。

#### 持久化与多窗口（补评审 R3-A5 · P1）

**⚠️ 两处前提已被实测推翻，本节大幅收缩。**

**① 队列零持久化。** `use-message-queue.ts:40` 是纯 `useState`，全文无任何 localStorage / sessionStorage / DB 写入。刷新后**连 `queued` 项都丢**，不存在"恢复 `in_flight`"的场景。

**② 多窗口本就是协同控制，不是单写者。** `connectAsViewer` 的文档（`acp-connections-context.tsx:4021-4029`）明确 viewer 是 "NON-OWNING, **co-controlling** client... sendPrompt/cancel go to the owner's connection"，`sendPrompt`（`:4592`）对 `isViewer` **零拦截**。且队列是 **per-panel** 的（`:568`），两个窗口各持独立队列 —— 原设计想防的"两窗口对同一队列项重复出队"在架构上不可能发生。

**因此本节的实际内容**：

| 情形 | 行为 |
|---|---|
| **页面刷新 / 应用重启** | 队列本就清空（无持久化）。**无需任何恢复逻辑** —— 原"`in_flight` → `unknown`"规则删除，它是空操作 |
| **多窗口同一会话** | **不加限制**，保持既有协同控制语义。两窗口各自的队列独立，各自的「立即发送」都有效（都发到 owner 的连接），与既有 `sendPrompt` 行为一致 |

- **`unknown` 态仍然保留**，但其真实触发场景是**超时 / agent 进程退出 / 传输中断**（§幂等的真实边界），**不是**刷新。这一点原设计写错了触发源。
- **不新建持久化层**：本轮不给队列加持久化。若将来要加，`unknown` 的跨会话恢复才成为真问题 —— 登记为架构债，不属本 spec。

#### 幂等的真实边界（修正评审 R2-A1 · P0）

**`message_id` 只是客户端记账，端到端幂等并不成立。** `_session/steering` 的请求参数只有 `{sessionId, prompt}`（`acp-agent.js` 的 `parseSteerRequest`）—— **agent 侧不接收、不识别任何幂等键**。因此必须区分两类失败：

| 失败类型 | 判据 | 消息是否已被 agent 接受 | 处理 |
|---|---|---|---|
| **明确拒绝** | 收到响应且 `outcome == failed` | **否**，确定未接受 | 置回 `queued`，**允许再次点击**「立即发送」 |
| **结果未知** | 无响应：传输中断 / 超时 / 进程重启 | **无法判定** | 置 `unknown`，**不自动重试** |

`unknown` 态的处理（本 spec 的明确取舍）：

- **禁止自动重试。** 客户端记账无法防住"消息已被接受但响应丢失"这一情形，自动重试就是真实的重复执行风险。
- 队列项标记为「投递结果未知」，**由用户决定**是否再次发送。理由：「立即发送」的内容是用户亲手点的，重复执行的代价（可能重复写操作）高于让用户自己确认一次的成本。
- UI 必须诚实呈现"未知"，不得显示成"已发送"或"发送失败"——这两者都是在陈述我们并不掌握的事实。

**契约收缩声明**：本 spec **不提供**"注入恰好一次"的端到端保证，只提供"不自动产生重复投递"。真正的 exactly-once 需要 `_session/steering` 接受幂等键（如 `_meta.messageId`）并在 agent 侧去重 —— 那是上游改动，本轮范围外（同 C6 的处理方式）。AC1.1 的"恰好一条记录"因此限定在**正常路径与明确拒绝路径**，不覆盖 `unknown`。

**⚠️ `failed` 分支当前无生产 producer（已实测纠正）。** 本文曾写"`codex-acp` 用同名方法、outcome 多一个 `failed`" —— **该事实不成立**：本机 `codex-acp` v1.1.2 的 dist（`D:\Devtool\npm-global\node_modules\@agentclientprotocol\codex-acp\dist\index.js`）对 `steer` / `_session/steering` **零命中**（实现者与主 AI 各自验过，审查员第三方复核）。即：**目前没有任何 agent 会返回 `failed`**。

保留该分支的理由仅是向前兼容（一个 match arm 的成本，而静默丢消息更糟），**不得当作已验证的行为**：它无法用真实 agent 测试，T10 的验收也不得拿它当真实场景。若将来某 agent 实现了同名方法并返回 `failed`，需重新实测其 outcome 枚举后才能声称支持。

前端据能力三态呈现差异（R2.4）：supported 时排队项带「立即发送」；unsupported / unknown 时不呈现该动作 + 明示"将在本轮后发送"。

### 2.6 注入消息的会话记录真源（补评审 F2 · R1.5）

**问题**：普通 prompt 走 `send_prompt`，其路径上有既有的 `UserMessage` 广播（`connection.rs` 里 prompt 前先 broadcast + 写 transcript）。而 steering 走的是独立 ext request，**不经过那条路径** —— 若不显式处理，注入的消息不会出现在会话记录里。

**⚠️ 前提已被实测推翻，本节按实际架构重写。**

原设计写"真源 = `acp_transcript::record_entry`"，但 `transcript_dir_for`（`connection.rs:517-526`）**对内置 agent 返回 `None`** —— 注释写明："Only custom ACP agents are recorded: every built-in has a dedicated parser reading the agent's native transcript, and recording those too would double the storage while risking two disagreeing histories."

Claude Code 是内置 agent，其历史来自 **agent 自己写的 `~/.claude/projects/**/<session_id>.jsonl`**（`parsers/claude.rs:384-406`），codeg 只读不写。

**因此持久化记录不需要我们做，而且不该我们做**：注入的消息经 `session.input.push` 进入 agent 的输入流，**agent 自己会把它写进那个 jsonl**。我们额外写一份就正是上述注释要避免的"两份互相矛盾的历史"。

**设计（分两层，各有其真源）**：

| 层 | 真源 | 我们的动作 |
|---|---|---|
| **持久化历史**（重开会话后仍在） | agent 自己的 native transcript（Claude 的 `<session_id>.jsonl`） | **不写**。由 agent 负责，我们只读 |
| **实时 UI**（当前会话进行中可见） | 前端 runtime store 的 optimistic turn | **复用既有 `APPEND_OPTIMISTIC_TURN` / `ROLLBACK_OPTIMISTIC_TURN`**（`conversation-runtime-store.ts:1690` / `:1698-1716`） |

- **实时呈现**：注入发出时 `APPEND_OPTIMISTIC_TURN`（乐观追加，用户立即看到自己的消息）；`failed` / `unknown` 时 `ROLLBACK_OPTIMISTIC_TURN`。这是既有机制，语义正好匹配"先显示、可能撤回"。
- **排序问题自然消解**：乐观追加发生在**发出请求时**，必然早于 agent 因该消息产出的任何 update，所以"AI 先答后问"不会出现。原方案 A/B 都不需要（且 transcript 是纯追加、无删除 API，方案 B 本就不可实现）。
- **不得直接复用 `AcpEvent::UserMessage` 的 apply**（`session_state.rs:885-920`）：它有三个副作用会造成损坏 —— ① `pending_user_message` 是**单槽**，注入会覆盖当前在飞的用户消息；② `feedback.clear()` 会清掉 §2.7 承诺保留的 pull 式便签；③ `pending_question = None` / `pending_plan_approval = None` 会抹掉正在等待用户的问答卡片与计划审批。**注入不是"新一轮用户消息"，不应触发这些轮次重置语义。** 若需要 mid-turn attach 也能看到注入消息，须另设不清理其他状态的路径，或明确接受"注入消息仅在发起端的 UI 可见"。
- **AC1.1 验收介质随之调整**：从"会话记录中恰好一条"改为 ——「① 发起端 UI 中该 `message_id` 恰好一条（乐观追加不重复）；② 会话重开后，agent 的 native transcript 中该消息出现且仅一次」。后者验证的是 agent 侧行为，属**观察**而非我们的实现责任。

### 2.7 不碰的东西（C1）

- **不动** `manager.rs:728-729` 的 `TurnInProgress` 硬拒。注入走独立入口，不经 prompt 通路。
- **不动** `conversation-detail-panel.tsx:745` 的 flush 门。它管的是"队列何时按普通 prompt 发出"，与注入正交。
- **保留** pull 式 `check_user_feedback`。它是不支持 steering 的 agent 的唯一兜底，且与 push 互补（pull 依赖 LLM 自愿调用，恰在派 SUB 后最不可靠）。

## 3. R3 可见性设计

纯前端，落点 `message-input.tsx:3024-3034`。

现状是 `isPrompting && onCancel` 时**整体替换**为红色 Square。改为并列，且「立即发送」在**队列项上**而非发送键上（锚 Zed 形态）：

```
┌ 队列（可见 · 可拖拽重排/编辑/删除）
│  ① "先看 auth 模块"        将在本轮后发送   [⚡ 立即发送] [✎] [✕]
│  ② "再补个测试"            将在本轮后发送   [⚡ 立即发送] [✎] [✕]
└
[输入框] 发消息...                              [■ 停止]  [发送]
```

- 发送键与停止键**并列**（R3.1）。停止键保持 destructive 样式（它仍是破坏性操作，且会级联杀 SUB）。
- 发送键行为不变：入队。**没有模式下拉**。
- 「⚡ 立即发送」只在能力态 `supported` 时出现在队列项上；`unsupported`/`unknown` 时该按钮不渲染，仅显示"将在本轮后发送"（R2.2 三态）。
- 按钮 tooltip 明示会打断（R1.3），例如"立即发送（会打断当前输出）"。
- `in_flight` 项不显示「立即发送」（§2.3.1 防重复出队）。
- 队列展示（`chat-input.tsx:151-165`）与 placeholder 文案（`:199-203`）同步调整。
- **保留**（C5）：拖拽重排、编辑、删除、`TurnBusyError` 队头/队尾回退语义。

10 语言 i18n 收口，新增键值集中一处定义。

## 4. R4 破坏性告知设计

**设计：作用域由后端权威给出，前端只展示。**

> 前端直接读 `active_delegations` 快照自行计数的做法**已废弃**（修订理由见文末 Update Log）。本节以下内容即现行设计。

- 新增一个只读查询（或复用既有 manager 查询），返回**"若此刻取消，会被 `cancel_by_parent_turn` 终止的委托集合"** —— 与执行路径**共用同一个作用域计算函数**，而非各算一遍。这是本项的核心：数量与执行集合同源，否则必然漂移。

**⚠️ 集合必须覆盖两个来源（实测发现的结构性漏计）**：`drain_for_parent_cancel` 除了 `running` 委托，还会杀 `mark_inflight_canceled_for_parent`（`broker.rs:3607`）里**尚未进入 running 的在途委托**，而这些**不在** `active_delegations` 快照中（`session_state.rs:984`）。

只统计 `active_delegations` 会导致 AC4「展示数 == 实际终止数」**在委托启动窗口内必然为红**（刚派发、还没 running 的那几百毫秒）。作用域计算函数必须同时统计 running + inflight 两个集合。
- 点停止 → 调该查询 → 返回**预览令牌**（含该时刻的委托 id 集合 + 令牌标识）→ `count > 0` 弹确认框（文案含数量）；`count == 0` 直接取消无确认（R4.4）。

**竞态处理（R4.3 · 修正评审 R2-A2 · P0）**：原设计只写"不因数量变化拒绝取消"，那**只对集合缩小成立**。必须区分两个方向 —— 用户授权的是"杀这 3 个"，不是"杀届时所有的"：

| 确认期间的变化 | 判定 | 处理 |
|---|---|---|
| **集合缩小**（委托自行完成） | 仍在已授权范围内 | 直接执行，按**实际终止集合**反馈（不虚报） |
| **集合扩大**（新委托产生） | **超出已授权破坏范围** | **拒绝提交**，报 `CancelScopeChanged`，什么都不杀，要求重新预览 |

> ⚠️ **契约修正（用户可见）**：原计划是"扩大时只终止令牌内的 id"。实现时发现**不可实现**：`ConnectionCommand::Cancel` 走无界的 `cancel_by_parent_turn`（`connection.rs` 四处调用点），而本 spec 又明令不改该级联 —— 只要提交停止 turn，新出现的委托照样被杀，令牌里的界是装饰性的。改为拒绝提交 + 重预览。该变更改变了用户可见的失败/重试契约，已回写至此（评审指出仅用实现注释覆盖不够）。broker 层保留真限界的 `cancel_by_parent_turn_within` 备用，若将来级联改成作用域感知，可将拒绝放宽为部分终止。
>
> ⚠️ **尚未修复（P0）**：审查证实"扩大即拒绝"本身**不是原子的** —— 检查后释锁、Cancel 落地前新建的委托仍会被无界 Cancel 杀掉（TOCTOU）。修复中：需在 broker 层建单一原子 prepare/commit/stop primitive。

- 取消执行**以预览令牌携带的 id 集合为界**，而非"执行时刻重新计算的集合"。这把用户看到的数字与实际破坏范围钉死在同一份快照上。
- 若因业务需要必须连带新增的（例如父轮确已结束、留着也无人消费），则**必须重新弹确认框告知新数量**，不得静默扩大。

**预览令牌契约（补评审 R3-A2 · P1 —— 仅"固定 id 集合"不足以构成生产级 prepare/commit）**：

| 属性 | 规定 |
|---|---|
| **一次性消费** | 令牌提交后立即失效。重复提交同一令牌 → 拒绝（返回"令牌已使用"），**不再执行第二次取消** |
| **原子提交** | 校验令牌 + 取走令牌 + 执行取消，在同一临界区内完成。禁"先校验后执行"留出窗口让第二个提交并发通过 |
| **作用域绑定** | 令牌绑定签发时的 `conn_id` + 调用者身份（§2.2.1）+ 委托 id 集合。任一不匹配即拒绝 |
| **过期** | 短时效（与确认框生命周期同阶，建议 ≤60s）。过期提交 → 拒绝并要求重新预览，**不得回落成"按当前集合取消"** |
| **并发预览** | 允许多次预览（只读，无副作用）；每次签发独立令牌。先提交者胜，其余令牌因集合已变/已失效而被拒 |
| **结果契约** | 提交返回**实际终止的 id 集合**（可能是令牌集合的子集，因期间有委托自行完成）。前端据此反馈，不据令牌原始数量反馈 |

存储：令牌可为内存态（进程内 map + TTL），无需落库 —— 它的生命周期短于一次用户交互，且重启后本就该重新预览。
- 后端 `connection.rs:5929-5933` 的 `cancel_by_parent_turn` 行为**不改** —— 其级联语义是正确的（父轮结束后子任务结果无人消费）。本项只补"作用域查询"与告知。

## 5. R5 文案设计

纯 i18n。`zh-CN.json:597` 及其余 9 语言。

- 移除"覆盖项"表述 → 改为描述其真实语义："派发子智能体时使用的配置"。
- 移除每行的"智能体默认: X" → 该值实际就是唯一来源，改为直接展示当前值，或标注"未设置时由智能体自行决定"。

**不改存储结构**（C2）。两套配置的介质异构（主会话 localStorage / 委托 DB `app_metadata`）是隔离不变量的产物，合并会导致"设置里为委托改模型顺手改掉正在跑的主会话"。

## 6. R6 resume 设计

先判定后动手。能力已完整（`connection.rs:2367/2393/3372-3386` + `broker.rs:3953-4000`），只需确认前端是否缺"手动指定会话 ID"入口。若缺，补前端入口调既有通路；**不改后端**。

## 7. 链路表与消费验证锚（§0.16）

**能力标志到前端的 wire 契约（补评审 A4 —— 原设计此链路悬空）**：

- **载体**：随既有 session 能力快照下发，**另加一个专用事件** `AcpEvent::SteeringSupported`。字段名 `supportsSteering: boolean`。

  > ⚠️ **契约修正**：本节原写"不新开事件类型"，实现时发现必须新增。理由（实现者发现并经审查员确认）：新会话（`session_id = None`）时 `spawn_agent` 在 initialize 握手**之前**就返回，连接时的快照抓取可能早于探测完成 —— 只靠快照会造出一个永远读不到真值的字段。既有 `fork_supported` 正是因同一原因同时具备事件与快照，本项跟随该先例而非发明第三种形状。
- **刷新时机**：连接建立（initialize 后）一次即定；重连/换 agent 时随新快照重发。**不轮询**。
- **默认未知态**：前端字段初值为 `undefined` → 按 `unknown` 处理 → 不呈现「立即发送」（R2.2 保守默认）。收到快照后转 `supported`/`unsupported`。
- **Web 模式**：经 WS `snapshot` 帧与 HTTP snapshot 同样携带该字段（两种传输不得只改一边）。

| 节点 | producer | consumer |
|---|---|---|
| steering 能力标志 | `init_resp.meta`（agent 侧，已有） | `connection.rs:3246-3269` 写入 session state（**待建**） |
| 能力标志 → 前端 | session 能力快照 + WS/HTTP snapshot（**待建**） | 队列项「立即发送」渲染（**待建**） |
| 「立即发送」点击 | 队列项按钮（**待建**） | `manager.rs::steer`（**待建**） |
| Steer 命令 | `manager.rs::steer`（待建） | `connection.rs:6021` select arm（**待建**） |
| ext request | `send_steering`（待建） | agent `acp-agent.js:5888` handler（已有） |
| steer outcome | agent 响应（已有） | oneshot reply → 队列项状态迁移（**待建** · §2.5.1） |
| 注入后的用户消息 | steer 成功回调（**待建**） | `UserMessage` 广播 + `acp_transcript`（已有通路，**待接**） |
| 取消作用域集合 | 后端作用域计算函数（**待建** · 与执行共用） | 确认框数量 + `cancel_by_parent_turn`（已有） |

**最终消费锚（必须真跑一次，不接受单测代替）**：用**可控 barrier 委托**（不依赖固定耗时）→ 对排队消息点「立即发送」→ 主 AI 在**同一 `turn_id`** 内回应 → 该 `delegation_id` 仍为 running → 会话记录中该 `message_id` 恰好一条。这是 AC1 + AC1.1，也是整个 spec 的成败判据。

## 8. 测试策略

- **授权边界（§2.2.1）**：持 A 身份凭据 + B 的 `conn_id` → steer / 预览 / 提交三入口各一条，断言均被拒且错误不泄露 B 的存在。
- **令牌契约（§4）**：重复提交同一令牌 → 第二次被拒且**不产生第二次取消**；过期令牌 → 拒绝而非回落按当前集合；并发两个提交 → 只有一个生效。
- **刷新/多窗口（§2.5.1）**：`in_flight` 项经刷新后恢复为 `unknown` 且无自动重试；非单写者窗口的「立即发送」不可用。
- **能力探测**：`_meta.steering.supported` 存在 / 缺失 / 畸形三输入；**必含负向** —— 把标志挪到 `agent_capabilities` 内（常规但错误的位置）必须探测为不支持。
- **能力三态 → UI**：`supported`/`unsupported`/`unknown` 各断言「立即发送」的呈现与否（`unknown` 必须不呈现）。
- **队列状态机（§2.5.1）**：三条合法迁移各一条；断言 `delivered` 不可回退；断言同 `message_id` 二次投递被跳过。
- **降级矩阵（§2.5）**：5 行各一条，含 `failed` → 置回 `queued` 且保留位次（只能用 fake peer 验，无真实 agent 会产生该 outcome）。
- **`startedNewTurn`**：**断言不补发**（A2 核心）—— 构造 idle 竞态，断言消息只投递一次；断言 **`turn_in_flight` 未被修改**（禁伪造 · R3-A4）而是 `detached_turn_pending` 被置；断言仅**可关联事实**能清除它，纯超时/任意终态事件**不能**清除。
- **会话记录（§2.6）**：成功→恰好一条记录；失败→无记录且队列项回 `queued`。
- **R4 作用域同源**：断言"确认框数量"与"实际终止集合"由同一函数得出 —— 构造"全局在跑 5 个、父轮作用域内 3 个"，断言展示 3 且只杀 3。竞态：确认期间 1 个自行完成 → 取消仍成功且报实际数。
- **端到端（不可省）**：AC1 + AC1.1 真跑。单测绿不证明接线成功（本仓 E-052 / E-091 母题：造好没接、门对不准交付物）。
- **负向 mutation 判据**：改**生产装配点**而非模块内部 —— 让 `connection.rs:6021` 的 select arm 不处理 `Steer`（即注入永不到达 agent），端到端门必须转红。若此时仍绿，说明测试自行构造了链路、对生产装配失明。

## 9. 风险与未知

| 风险 | 应对 |
|---|---|
| steering 是**未公告能力**（CHANGELOG 零命中），上游可能改名/移除 | 能力探测 + 三态降级已覆盖；版本升级时需复验（C4） |
| 打断会截断主 AI 正在输出的内容 | 这是 `now` 的固有语义（C6 已接受）。按钮语义 + tooltip 明示；默认路径是排队不打断（§2.3） |
| `startedNewTurn` 竞态 → 重复执行用户指令 | **不补发**；原子选择通路 + `message_id` 幂等 + 兜底收敛（§2.4）。这是 A2 的修正，风险从"重复执行"降为"UI 状态短暂不准" |
| 队列与自动 flush 争抢同一项 | `in_flight` 状态位 + 单一出队（§2.3.1） |
| 取消告知数量与实际终止集合漂移 | 作用域计算与执行共用同一函数（§4） |
| 注入内容与 tool_result 交错触发 API 报错 | agent 侧 `steer()` 已处理（push 进 streaming input 而非构造独立 message），本端不重复实现 |
| 前端键区改动与 W2/W4 都触碰同一处 | 两项串行交付，不并行改 `message-input.tsx:3024-3034` |

**未验证项（诚实声明）**：`_session/steering` 的实际注入效果**尚未在本项目内真跑过**——证据来自本机 agent dist 源码与上游 PR，属静态证据。AC1 的端到端实测是第一次真实验证，若届时行为与源码推断不符，需回到 design 修正。

## 10. Update Log

- **2026-07-29 初稿**。
- **2026-07-29 R1 修订**（codex/spec-r1-req-arch · 2 P0 / 8 P1 · 锚点 10/10）：
  - **A1 P0** 废弃"前端观测工具边界后延迟注入"（前端事件无法保证下一步开始前投递；刷新/重连/多窗口不可靠）→ 改为只做协议原生 `priority=now`，交互锚 Zed（默认排队 + 逐条「立即发送」）。
  - **A2 P0** `startedNewTurn` 后"普通 prompt 重发"会重复执行同一指令 → 改原子选择通路 + 视为已接受禁补发。
  - A3/A4/A5 + F1–F5：队列状态机、能力标志 wire 契约、取消作用域同源、能力三态、会话记录真源、AC 可控 barrier 化。
- **2026-07-29 R2 修订**（spec-r2-reverse · 2 P0 / 5 P1 · 锚点 7/7）：
  - **A1 P0** `message_id` 只是客户端记账，agent 不接收幂等键 → 区分"明确拒绝"与"结果未知"，后者置 `unknown` 禁自动重试 + 显式声明契约收缩（不提供 exactly-once）。
  - **A2 P0** 取消范围只考虑缩小未考虑扩大 → 引入预览令牌把破坏范围钉在展示时的快照上。
  - A3 禁伪造 `turn_in_flight`（改独立 `detached_turn_pending`，收敛须凭可关联事实）· A4 记录排序须显式保证 · F1 R6 判 D 不实施 · F2 tasks 契约对齐 · F3 三领域业务分类与发布边界。
- **2026-07-29 R3 处置**（spec-r3-production · 1 P0 / 6 P1 · **锚点 2 失败 1 歧义 → validation.ok=false**）。三轮已用尽，按纪律逐条处置而非再跑一轮：
  - **A1 P0 已采纳** → 新增 §2.2.1 授权边界。理由成立：`steer` 可注入正在运行的会话、取消可终止他人委托，Web 多用户部署下缺授权绑定即越权。
  - **A2 P1 已采纳实质**（锚点未命中，未按其锚点改）→ §4 补预览令牌契约（一次性消费 / 原子提交 / 作用域绑定 / 过期 / 并发 / 结果契约）。
  - **A5 P1 已采纳实质**（锚点未命中）→ §2.5.1 补持久化与多窗口（刷新后 `in_flight` → `unknown`；单写者 = 持有连接的窗口）。
  - **A4 P1 已采纳** → 测试策略中残留的"断言 `turn_in_flight` 被置 true"与 A3 的禁令冲突，已改为断言其**未被修改**、改测 `detached_turn_pending`。
  - **A3 P1 已采纳** → `unknown` 的归属/持久化/是否可自动 flush 已在 §2.5.1 与 requirements R1.6 统一（不属自动 flush 范围，仅用户显式操作可离开该态）。
  - **A6 P1 判为误读，不改架构**：其锚点定位到 §4 中**引述旧方案的修订说明**，评审误当作现行设计的第二个真源。已把该段修订痕迹压缩为一行指针并移入本 Update Log，消除歧义来源。
  - **A7 P1 判为已满足**：R5 在 R2 修订时已标为"独立 UX 项 · 纯 i18n · 不阻塞核心"（requirements §2.1），即评审所要求的降级处置。
