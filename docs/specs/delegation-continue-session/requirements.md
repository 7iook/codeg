# Requirements · delegation-continue-session

## Introduction

codeg 的委托子代理（`delegate_to_agent`）当前是一次性的：子代理跑完一轮就被断开销毁（`broker.rs:2758` `// v1 one-shot`）。用户想在子代理停止后继续跟它对话，并让主 AI 也知道这些追问。侦察确认（`.agent-workspace/.archive/2026-07-26/delegation-continue-session/delegation-continue-recon.md` §B10）用户从侧边栏点开子会话已能给子代理发消息，但这条通路绕过 broker，父 AI 与父卡片都不知情。

本需求让委托子会话在终态后保留可复用，并把「续聊」同时暴露给主 AI（MCP 工具）与用户（界面入口），二者共享同一个 `task_id` 视图。成功标准：用户在子代理会话里追问后，主 AI 通过 `get_delegation_status` 能看到该轮的结果。

## Glossary

- **Delegation Broker**: `src-tauri/src/acp/delegation/broker.rs` 的 `DelegationBroker`，持有 `PendingInner` 状态机，是委托任务的唯一权威。
- **Task_Id**: broker 铸造的 `call_id`（UUID），LLM 与用户共用的任务标识。
- **Child_Session**: 委托产生的子会话，DB 中 `kind=Delegate` 且 `parent_id` 非空的 `conversation` 行。
- **Settled_Task**: 已达终态（`Completed`/`Failed`）并进入 `PendingInner.completed` 缓存的任务。
- **Kept_Alive_Connection**: `Settled_Task` 保留的 ACP 子连接 id，可直接续聊无需重启进程。
- **Resume_Path**: 子进程已死时的恢复链，`spawn_agent(session_id)` → `session/resume` → `session/load` → `session/new`（`connection.rs:3122-3414`）。
- **Idle_Sweep**: `ConnectionManager::sweep_idle`（`manager.rs:527-573`），默认 180 秒回收空闲连接。
- **Continue_Entry_Point**: 用户侧续聊入口，含 `SubAgentSessionDialog` 输入框与其后的 Tauri command / Web handler。
- **Completed_Cache**: `PendingInner.completed` + `completed_order` + `completed_bytes`，带字节上限 FIFO 淘汰。**只缓存结果文本**，不决定会话是否存在或可续聊（R2-B3）。
- **Turn_Id**: broker 内部为每次续聊分配的唯一轮次标识，不上 wire。
- **Continuation_Id**: 调用方生成的稳定操作标识，用于跨重试去重，三条入口均为必需参数。
- **Released**: 子会话经 `close_session` 释放后的内部状态——释放子进程且本进程内不再续聊，非永久关闭（R2-B4）。

## Requirements

### Requirement 1: 终态子会话保留可复用

**User Story:** As a codeg 用户, I want 子代理跑完后它的会话不被立即销毁, so that 我和主 AI 都能在同一个会话里继续追问而不丢上下文。

#### Acceptance Criteria (EARS)

1. WHEN a `Settled_Task` reaches status `Completed`, THE Delegation Broker SHALL retain the child ACP connection id in the `Completed_Cache`.
2. WHEN a `Settled_Task` reaches status `Failed`, THE Delegation Broker SHALL retain the child ACP connection id in the `Completed_Cache`.
3. WHEN a delegation task reaches status `Canceled`, THE Delegation Broker SHALL disconnect the child connection.
4. WHERE a parent connection is torn down, THE Delegation Broker SHALL release only that connection's run lease and event subscriptions, and SHALL NOT disconnect `Kept_Alive_Connection` instances on that basis alone.
4a. WHEN a parent conversation is deleted, THE Delegation Broker SHALL release every `Kept_Alive_Connection` belonging to that parent conversation.
5. WHEN the `Completed_Cache` evicts an entry that holds a `Kept_Alive_Connection`, THE Delegation Broker SHALL disconnect that connection.
6. WHILE a delegation setup has not yet sent its first prompt, THE Delegation Broker SHALL disconnect the child connection on cancellation.

### Requirement 2: 主 AI 可续聊与关闭子会话

**User Story:** As a 主 AI, I want 一个续聊已完成子代理的工具, so that 我不必重新委托、重做已完成的探索。

#### Acceptance Criteria (EARS)

1. WHERE the delegation feature group is enabled, THE codeg-mcp Companion SHALL expose a `continue_with_session` tool accepting `task_id` and `message`.
2. WHERE the delegation feature group is enabled, THE codeg-mcp Companion SHALL expose a `close_session` tool accepting `task_id`.
3. WHEN `continue_with_session` is called on a `Settled_Task`, THE Delegation Broker SHALL send the message into that `Child_Session` and return a `Running` report carrying the original `Task_Id`.
4. IF `continue_with_session` is called on a task whose status is `Running`, THEN THE Delegation Broker SHALL return error code `session_still_running`.
5. IF `continue_with_session` is called on a task closed by `close_session`, THEN THE Delegation Broker SHALL return error code `session_closed`.
6. IF `continue_with_session` is called with a `task_id` unknown to the calling parent, THEN THE Delegation Broker SHALL return status `Unknown`.
7. WHEN `close_session` is called, THE Delegation Broker SHALL disconnect the child connection and mark the task closed.
9. WHERE the target task is in status `Running`, THE `close_session` operation SHALL cancel the in-flight turn before marking the task closed.
10. WHEN `close_session` is called on an already-closed task, THE Delegation Broker SHALL return the last known status without side effects.
11. WHERE the target task holds no live child connection, THE `close_session` operation SHALL still mark the task closed.
12. IF `close_session` and `continue_with_session` target the same task concurrently, THEN THE Delegation Broker SHALL serialize them under the pending-state lock and the later arrival SHALL observe the earlier one's result.
13. WHEN two continuations carrying the same continuation identifier target one task, THE Delegation Broker SHALL execute the follow-up once and return the first execution's report to both callers.
8. WHEN a continued turn completes, THE Delegation Broker SHALL emit a session-scoped update event carrying the `Task_Id`, the `Turn_Id`, and the turn origin.
8a. THE Delegation Broker SHALL NOT emit a second completion event against a `parent_tool_use_id` whose tool call already reached a terminal state.
8b. WHEN the parent AI queries `get_delegation_status`, THE Delegation Broker SHALL report the latest turn's result regardless of which origin dispatched it.

### Requirement 3: 子进程已死时按 external_id 恢复

**User Story:** As a codeg 用户, I want 即使子代理进程已被回收也能继续对话, so that 我不必因为等太久而丢失整段工作。

#### Acceptance Criteria (EARS)

1. WHEN `continue_with_session` targets a task whose child connection is no longer alive, THE Delegation Broker SHALL spawn a replacement connection passing the `Child_Session` `external_id`.
2. WHERE the `Child_Session` row carries no `external_id`, THE Delegation Broker SHALL return error code `not_continuable`.
3. IF the `Resume_Path` cannot restore the prior context, THEN THE Delegation Broker SHALL return error code `resume_unavailable` before dispatching the follow-up prompt.
3a. THE Delegation Broker SHALL NOT overwrite a `Child_Session` `external_id` with a session identifier obtained from a context-losing `session/new` fallback.
4. WHEN a replacement connection is spawned for continuation, THE Delegation Broker SHALL reuse the existing `Child_Session` row instead of creating a new one.

### Requirement 4: 用户侧续聊入口

**User Story:** As a codeg 用户, I want 直接在子代理会话界面里发消息, so that 我不必先找到侧边栏子树再猜哪一行是子代理。

#### Acceptance Criteria (EARS)

1. THE Sub Agent Session Dialog SHALL provide a message input that submits a continuation through the Delegation Broker.
2. WHEN the user submits a continuation from the Sub Agent Session Dialog, THE Delegation Broker SHALL record it under the same `Task_Id` the parent AI holds.
3. WHERE a conversation row is a `Child_Session`, THE Sidebar SHALL render a marker distinguishing it from a root conversation.
4. WHERE the sidebar sub-session display toggle is off, THE Sidebar SHALL omit `Child_Session` rows from the root list.
5. THE Sub Agent Session Dialog SHALL provide a control that opens the `Child_Session` as a full workspace tab.
6. IF a continuation submitted from the Sub Agent Session Dialog is rejected, THEN THE Sub Agent Session Dialog SHALL display the returned error code to the user.
7. WHILE a continued turn is streaming, THE Sub Agent Session Dialog SHALL keep every previously persisted turn visible.

### Requirement 5: 保活连接的资源边界

**User Story:** As a codeg 用户, I want 保留的子代理不悄悄堆积成一堆常驻进程, so that 我 fan-out 十个子代理后机器仍然可用。

#### Acceptance Criteria (EARS)

1. WHILE a `Kept_Alive_Connection` has no in-flight turn, THE Idle Sweep SHALL remain able to reclaim it.
2. WHEN the Idle Sweep reclaims a `Kept_Alive_Connection`, THE Delegation Broker SHALL treat the subsequent continuation as a `Resume_Path` case rather than reporting a broker error.
3. THE Delegation Broker SHALL disconnect the child connection of any task retired by `close_session`.
4. WHERE the count of `Kept_Alive_Connection` reaches the configured cap, THE Delegation Broker SHALL disconnect the oldest settled connection before retaining a new one.
5. THE Delegation Broker SHALL apply the `Kept_Alive_Connection` cap at both global scope and per-parent-conversation scope.
6. WHEN a `Kept_Alive_Connection` is disconnected by the cap, THE Delegation Broker SHALL retain that task's result text and `external_id` so a later continuation can use the `Resume_Path`.

### Requirement 6: 续聊轮次的取消覆盖

**User Story:** As a codeg 用户, I want 取消父轮次时续聊出去的那一轮也停下, so that 不会留下一个没人管的子进程继续跑。

#### Acceptance Criteria (EARS)

1. WHEN a continuation is dispatched, THE Delegation Broker SHALL register it as cancellable before the follow-up prompt is sent.
2. IF a parent cancellation arrives while a continuation is being dispatched, THEN THE Delegation Broker SHALL cancel that continuation turn.
3. WHEN a parent turn ends without `end_turn`, THE Delegation Broker SHALL preserve the `consumed` tool-call correlation records.

## Update Log

### R1 · 2026-07-26 · codex 第一轮评审

- **Requirement 2** 新增 AC 9-13：`close_session` 在 running / already-closed / 无活连接三态的行为，close 与 continue 的并发裁决，以及续聊幂等（同 `continuation_id` 只执行一次）。依据 R1-F1、R1-A6。
- **Requirement 5** 新增 AC 4-6：`Kept_Alive_Connection` 的可配置数量上限（全局 + 每父会话两层作用域）、FIFO 淘汰顺序、淘汰后保留 `external_id` 以走 `Resume_Path`。依据 R1-A4——原文仅靠 idle sweep 延迟回收，不构成可验证的容量上限。
- **未采纳 R1-A3 的租户授权模型**：核实 codeg 为单用户单租户（全仓 `tenant` 零命中，`conversation` 表无 `user_id`/`workspace_id`，server 模式单个全局 `CODEG_TOKEN`），tenant→parent→child 归属链属为不存在场景加防御。仅采纳其可落地部分（不泄漏存在性 + 拒绝把普通会话当子代理），落在 design.md 验收矩阵。
- 完整逐条处置见 `design.md` §Update Log · R1。

### R2 · 2026-07-26 · codex 第二轮评审（反向验证）

- **Requirement 2.8** 重写：从「emit 完成事件携带原 `parent_tool_use_id`」改为 session-scoped 更新事件（带 `Turn_Id` + origin），并新增 2.8a 禁止对已终态的 tool call 重复发完成事件、2.8b 明确主 AI 的可见性契约是「下次查询时可见」。依据 R2-B2——原文破坏 tool-call 一次性完成契约，且比上游 PR #375 更激进（后者只 emit started）。
- **Requirement 3.3** 重写为 `resume_unavailable`：resume 失败时在产生 prompt 副作用**之前**返回错误，不自动降级到 `session/new`；新增 3.3a 禁止用冷启动得到的 session id 覆盖原 `external_id`。依据 R2-B1——核实 `update_external_id`（`lifecycle.rs:189`）是无条件覆盖，原设计会永久丢失恢复凭据。
- **Requirement 1.4** 重写：父连接拆除只释放该连接的运行租约与事件订阅，**不**据此 disconnect 保活连接；新增 1.4a（父 conversation 被删除才释放其名下保活连接）。依据 R2-B6——子会话同时服务用户与主 AI，生命周期不应由易失的父连接决定。
- **Glossary** 新增 `Turn_Id` / `Continuation_Id` / `Released`，并收窄 `Completed_Cache` 定义为「只缓存结果文本」。
- 完整逐条处置与路径决策（采纳「局部重构」）见 `design.md` §Update Log · R2。

### Requirement 7: 服务重启后的续聊与部署边界

**User Story:** As a codeg 用户, I want 重启 codeg 后仍能继续跟之前的子代理对话, so that 我不必因为一次重启就丢掉半天的委托上下文。

#### Acceptance Criteria (EARS)

1. WHEN the Delegation Broker starts, THE Delegation Broker SHALL rebuild its continuable session index from `conversation` rows where `kind` is `Delegate`, `deleted_at` is null, and `external_id` is present.
2. WHILE the startup rebuild is in progress, THE Delegation Broker SHALL return the retryable status `rebuilding` for continuation requests rather than status `Unknown`.
3. IF a single row fails to rebuild, THEN THE Delegation Broker SHALL mark that session `not_continuable` and SHALL continue rebuilding the remaining rows.
4. THE Delegation Broker SHALL treat every `Continuation_Id` recorded before a restart as unseen after the restart.
5. THE codeg Server SHALL document that one instance serves exactly one user authenticated by one global `CODEG_TOKEN`.
6. WHERE a continuation targets a `Child_Session` whose stored agent type or folder differs from the resume target, THE Delegation Broker SHALL return error code `not_continuable`.
7. IF one `external_id` value is referenced by more than one `Child_Session` row and the target cannot be uniquely resolved, THEN THE Delegation Broker SHALL refuse the resume.

### Requirement 8: 事件版本与状态回源

**User Story:** As a codeg 用户, I want 界面上显示的子代理结果永远是最新那一条, so that 我不会照着一条被延迟事件覆盖回来的旧结果做判断。

#### Acceptance Criteria (EARS)

1. THE Delegation Broker SHALL assign a monotonically increasing `Turn_Version` to each dispatched turn of a session.
2. WHEN the Delegation Broker emits a session-scoped update event, THE event SHALL carry the `Task_Id`, `Turn_Id`, `Turn_Version`, and turn origin.
3. WHERE a received event's `Turn_Version` is lower than the last applied version, THE Sub Agent Session Dialog SHALL discard that event.
4. IF a gap is detected in the received `Turn_Version` sequence, THEN THE Sub Agent Session Dialog SHALL re-query the delegation status as the authoritative source.

## Update Log

### R3 · 2026-07-26 · codex 第三轮评审（生产场景推演 · P0=1 / P1=5）

- **新增 Requirement 7**（服务重启与部署边界）：启动重建协议、`rebuilding` 可重试状态、单行失败隔离、operation ledger 不跨重启、一实例一用户的显式声明、agent/folder 绑定校验、重复 `external_id` 拒绝恢复。依据 R3-A1（唯一 P0）+ A3 + A6。
- **新增 Requirement 8**（事件版本与回源）：单调 `Turn_Version`、事件携带版本、按版本丢弃旧事件、缺口时回查 status。依据 R3-A4——原设计假设事件顺序等于业务完成顺序。
- **核实 R3-A3 的事实基础**：`conversation.external_id` 无唯一约束、可为 NULL、可被 `update_external_id` 无条件覆盖（`conversation.rs:55`，migration 无 UNIQUE 索引）。故它不是天然可信的恢复凭据，已加三元绑定校验。
- 完整逐条处置见 `design.md` §Update Log · R3 与 §R3 采纳项。
