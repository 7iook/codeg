# delegation 续聊改造 · 侦察报告

- 仓库：`F:\codeg-research`，分支 `feat/kiro-agent`（HEAD `655ad67a`），upstream `xintaofei/codeg` @ `e540a4fa`
- 上游参考 PR：#375 `feat/delegation-continue-session-clean`（3 commits：`bf792dc0` / `1ad6f8f1` / `4d6e4099`），patch 落盘 `F:\codeg-research\.agent-workspace\pr375.patch`
- 检索工具：`git grep`（精确串）+ `codebase-context-engine`（语义）+ `desktop-commander read_file`；`gh pr diff 375 --repo xintaofei/codeg --patch`
- 纪律：只读侦察，未改任何代码

## A. 现状测绘

### A1 broker 状态结构 + TaskStatus 五态写入点

`src-tauri/src/acp/delegation/broker.rs`：

- `PendingInner`（`broker.rs:265-330`，单 `Mutex` 保护，`PendingCalls.inner`，`broker.rs:225-228`）字段：
  - `running: HashMap<String, RunningTask>` —— key = broker `call_id`（= LLM 看到的 `task_id`）
  - `completed: HashMap<String, CompletedTask>` + `completed_order`（每 parent FIFO 队列）+ `completed_bytes`（每 parent 字节数）+ `completed_cap_bytes`（`insert_completed` `broker.rs:490-506`，`evict_completed_over_cap` `broker.rs:508-537`）
  - `setups: HashMap<call_id, child_connection_id>`（`reserve` `broker.rs:355`）—— spawn→park 窗口的子终态缓冲门闸
  - `early_completes: HashMap<call_id, (seq, outcome)>`、`early_cancels: HashMap<child_conn_id, (seq, reason)>`
  - `inflight: HashMap<u64, InflightSetup{parent_connection_id, canceled_at}>`（`register_inflight` `broker.rs:434`）—— 父取消能触达"还没 park"的 setup
  - `seq: u64` 单调到达时钟（`tick` `broker.rs:417`），用于 first-terminal-wins
- `RunningTask`（`broker.rs:180-209`）：`child_connection_id / child_conversation_id / parent_connection_id / parent_tool_use_id / agent_type / task_preview / task_id / external_handle / started_at`
- `CompletedTask`（`broker.rs:213-224`）：`parent_connection_id / child_conversation_id / agent_type / status / text / error_code / message / duration_ms`
  —— **注意：本地版 `CompletedTask` 不存 `child_connection_id`、不存 `parent_tool_use_id`、无 `closed`/`folder_id`/`external_id`/`working_dir`**，这正是 PR #375 要补的字段（见 C 节）。

`TaskStatus`（`types.rs:153-168`）五态写入点：

| 状态 | 写入位置 | 说明 |
|---|---|---|
| `Running` | `running_ack()` `broker.rs:746-771`（`status: TaskStatus::Running` @761）；`report_from_outcome` 的 running 分支 @798 | `delegate_to_agent` ack；`get_delegation_status` 命中 `running` map |
| `Completed` | `terminal_fields()` `broker.rs:603-620`（@608）由 `DelegationOutcome::Ok` 推出，落进 `build_completed`（@625-644） | 也来自 DB 兜底 `DbChildStatusLookup` `broker.rs:3482`（`pending_review`/`completed`） |
| `Failed` | `terminal_fields` @617（非 `canceled` code 的所有 Err） | |
| `Canceled` | `terminal_fields` @615（code == `"canceled"`）；`drain_and_record_canceled` `broker.rs:666-700`；DB 兜底 @3483 | |
| `Unknown` | `unknown_report()` `broker.rs:826-833`；DB 兜底 @3484 | 不属本 parent / 无行 |

`Failed`/`Canceled` 的分流唯一依据是 wire code 字符串 `"canceled"`（`terminal_fields` `broker.rs:610-618`），PR #375 全部 keep/disconnect 判定也复用同一个字符串匹配。

### A2 one-shot 销毁：`spawner.disconnect` 全部调用点

生产路径共 7 处（其余命中都在 `mod tests`）：

| # | 位置 | 触发条件 | 是否 cancel+disconnect | 改造后是否应保留 |
|---|---|---|---|---|
| 1 | `broker.rs:2249` | setup checkpoint#2：spawn 成功但 prompt 未发时父取消 | disconnect-only | **必须仍销毁**（子还没任何上下文，留着无意义） |
| 2 | `broker.rs:2312` | `send_prompt_linked_for_delegation` 失败 | disconnect-only | **必须仍销毁**（连接未 link，无 conversation 行） |
| 3 | `broker.rs:2548` | `Disposition::ParentCanceled`（prompt 已发、未 park 时父取消） | cancel + disconnect（2547+2548） | 必须仍销毁（父已放弃该轮） |
| 4 | `broker.rs:2622` | 第二道 pre-cancel（MCP `notifications/cancelled` 抢在 running 注册前） | cancel + disconnect（2621+2622） | 必须仍销毁 |
| 5 | **`broker.rs:2759`** —— `finalize_delegation()` 尾部，注释 `// v1 one-shot: always tear down the child.`（@2758） | **正常完成 / 失败**（`complete_call` @2793 与 `start_delegation` 早终态 pickup @2495 共用） | disconnect-only | **★ 这就是要改成保留的唯一点**（PR #375 改为仅 `code == "canceled"` 时 disconnect） |
| 6 | `broker.rs:3092` —— `teardown_canceled_child()` 尾部 | 被 4 条路径共用：`cancel_task_by_id`（@3304，cancel_turn=true）、`cancel_by_external_handle`（@2871，true）、`cancel_by_child_connection`（@2921，false —— 子已自己断，disconnect-only）、`finalize_parent_cancel`（@3040，true，服务 `cancel_by_parent` + `cancel_by_parent_turn`） | `cancel_turn` 为真时 cancel+disconnect，否则 disconnect-only | **保留销毁**。但 `cancel_by_parent_turn` 这条需要区分对待（见 A3） |
| 7 | 无 timeout 路径 | `git grep -n "timeout" broker.rs` 生产代码里只有 `get_tasks_status` 的长轮询 `tokio::time::timeout`（@3936/@3957），**delegation 早已无超时销毁**（commit `a110d4cf` "replace timeout with MCP-native cancellation" / `ddd862ea` "support unlimited delegation timeouts`） | — | 不存在 |

结论：**改造只需动 #5 一处的语义**（+ 为 `cancel_by_parent` 增加"清理已保活的 settled 子连接"，见 A3）。#1/#2/#3/#4/#6 全部保持销毁。

### A3 `cancel_by_parent` vs `cancel_by_parent_turn`

| | `cancel_by_parent`（`broker.rs:2933-2938`） | `cancel_by_parent_turn`（`broker.rs:2958-2968`） |
|---|---|---|
| 语义 | 父**连接**拆除（disconnect / `run_connection` 退出），父不会再查询 | 父**轮次**取消（非 `end_turn` 结束，或用户 Cancel），**父连接仍活着** |
| `keep_consumed` | `false` → `drop_tool_calls_for_parent(.., false)` 丢整个 tool_call 桶 + `drop_completed_for_parent`（`broker.rs:3020`）丢该 parent 全部 completed 缓存 | `true` → 保留 `consumed` tool_call 记忆（防 host 重发 tool_call_id 误绑下一轮）+ `drain_and_record_canceled` 把每个 drained task 记为 `Canceled` 供 LLM 继续查询 |
| 执行方式 | 全程 inline | 快路径（tracker + running drain）inline，慢路径（meta/emit + spawner cancel/disconnect）`tokio::spawn` 后台 |
| 调用点 | `connection.rs:1161`（`run_connection` 清理守卫，同处还 revoke token / cancel questions / plan approvals） | `connection.rs:5514`、`5573`、`5740`、`5914` —— 前两处是 `reason_str != "end_turn"` 的 TurnComplete 分支，后两处是用户 Cancel（inner mid-prompt + outer between-prompt） |

**冲突点（关键）**：

1. `cancel_by_parent_turn` 目前只 drain `running`，对 `completed` 只做"记录 canceled"，**不会碰已 settled 的子进程** —— 因为现状 settled 的子进程已经在 `finalize_delegation` 里被销毁了。改成保留后，`cancel_by_parent_turn` 天然不会误杀保活子代理（PR #375 在 @3117 只加了一句注释说明这点，代码没改）。**但**"父轮次非 end_turn 结束"本来是 v1 收尾语义，改造后 settled 子代理会跨父轮次存活 —— 这是有意的语义变更，需要产品确认（保活是资源代价的来源，见 D2）。
2. `cancel_by_parent` 会 `drop_completed_for_parent` 把整个 completed 缓存扔掉。**若 completed 里持有保活的 `child_connection_id`，扔缓存就等于泄漏子进程**（缓存是唯一持有者）。PR #375 因此新增 `take_settled_child_connections()`（先取出并 `closed=true`，再 disconnect，再 drain）—— 这是改造必须一起做的配套，漏了就是进程泄漏。
3. `completed` 缓存还有**字节上限 FIFO 淘汰**（`evict_completed_over_cap` `broker.rs:508-537`，按 `text` 字节，默认见 `DEFAULT_COMPLETED_CACHE_CAP_BYTES`）。被淘汰的 entry 若持有保活连接，同样泄漏；PR #375 **没有处理这条淘汰路径**（它只在 `close_delegation_session` / `take_settled_child_connections` 里 take 连接 id）→ 见 D 节风险 R2。

### A4 `ConnectionSpawner` trait：能复用什么、缺什么

`src-tauri/src/acp/delegation/spawner.rs:59-104`，四个方法：

- `spawn(parent_connection_id, agent_type, working_dir, preferred_mode_id, preferred_config_values) -> conn_id`（@70-77）；生产实现 `ConnectionManagerSpawner::spawn`（`manager.rs:2523+`）内部调 `ConnectionManager::spawn_agent(.., session_id = None, ..)`（`manager.rs:2575` 传 `None`）
- `send_prompt_linked_for_delegation(conn_id, task, link) -> child_conversation_id`（@86-91）；生产实现 `manager.rs:2588+`，内部 `send_prompt_linked(.., folder_id, conversation_id=None, Some(link))` —— **它带 `DelegationLink`，会在 DB 建新 child 行**
- `cancel(conn_id)`（@95）
- `disconnect(conn_id)`（@100）

"给已有子连接再发一轮 prompt" 现状：**没有可直接复用的方法**。
- `send_prompt_linked_for_delegation` 不能复用：它必然带 `DelegationLink`，而 `send_prompt_linked` 的 link 分支（`manager.rs:887+` Branch B）只在 `!already_linked` 时建行；已 link 的活连接会走 "已 link 路径" 直接发，但**新 spawn 的 resume 连接是未 link 的**，此时传 link 会再建一个 child 行（重复行）。正确姿势是传 `conversation_id + folder_id`（Branch A，`manager.rs:887-901`，adopt 现有行、无 DB 写）。
- 缺 3 个能力（PR #375 正是补这 3 个，`spawner.rs` +117 行）：
  1. `spawn_for_resume(.., session_id: Option<String>, ..)` —— 把 `external_id` 透给 `spawn_agent`，触发 `find_connection_for_reuse` 或 `session/load`
  2. `send_followup_prompt(conn_id, message, conversation_id, folder_id)` —— 走 `send_prompt_linked(.., Some(folder_id), Some(conversation_id), None)` Branch A adopt
  3. `is_alive(conn_id) -> bool` —— 读 `manager.get_state(conn_id)`（`manager.rs:1901`），`!matches!(status, Disconnected | Error)`
- `MockSpawner`（`spawner.rs:107-250`）同步要加 `followup_results / resume_args / followups / dead_connections / queue_followup / mark_dead`，且 `disconnect` 要顺手把 conn 标记为 dead（PR #375 `spawner.rs` @346）。**这是纯加法，对现有 4 方法零破坏**，但 trait 加方法 = 所有实现者（生产 1 + mock 1）必须同步实现。

### A5 子会话在 DB 里的表示

`conversation` 表 delegation 相关列写入点：

- 唯一写入点 `conversation_service::create_with_delegation`（`conversation_service.rs:60-74`）→ `create_inner`（@76-119）：`kind = Delegate` iff `delegation.is_some()`，`(parent_id, parent_tool_use_id, delegation_call_id)` 三元组同时从 `DelegationLink` 展开（@90-97），`external_id: Set(None)`（@108）。不变量：**`parent_id 有值 ⟺ kind=delegate ⟺ delegation_call_id 有值`**（`conversation_service.rs:57-58` 注释）。
- 调用方：`manager.rs:925-940`（`send_prompt_linked` Branch B，delegation 非空时还用 `delegation_child_title_seed` 给标题种子）；另有 `commands/conversations.rs:1964` 与 `import_service.rs:536` 也会写 `kind=Delegate`。
- 用途：`parent_id` → 侧边栏子树（`list_children` `conversation_service.rs:535`）+ `child_count` 聚合（`models/conversation.rs:44-50`）+ depth 计算（`depth.rs` 走 `parent_of`）；`parent_tool_use_id` → 前端 `DelegationContext` 按 tool_use_id 重建绑定（快照恢复）；`delegation_call_id` → 生命周期订阅者反查 broker task（`lifecycle.rs:307`）+ DB 兜底 `get_by_delegation_call_id`（`conversation_service.rs:384`）。
- **`external_id`（agent 侧 session id）写入时机**：`update_external_id`（`conversation_service.rs:254-262`，带 `deleted_at IS NULL` 守卫）。两条路径：
  1. `manager.rs:997`：`send_prompt_linked` 在 link 之后同一 `prompt_lock` 临界区内，若 `SessionStarted` 已到（state 上有 `external_id`）则**同步**写入；
  2. 否则由 lifecycle 订阅者在 `SessionStarted` 到达时补写（`manager.rs:1008-1013` 的日志说明）。
  → 结论：**子会话的 `external_id` 会被持久化，可用于 resume**。风险：极短命的子（spawn 后立刻失败）可能 `external_id` 仍为 NULL，此时无法 resume，只能冷启动（PR #375 的 `spawn_for_resume(session_id=None)` 兜底）。

### A6 进程已死如何 resume

- `build_resume_session_request`（`connection.rs:2195`）+ `send_resume_session`（`connection.rs:2221`）只在 `connection.rs:3122-3238` 的连接建立流程里被调用：**当 `spawn_agent` 带了 `session_id` 时**，先试 `session/resume`（Claude 专属 raw meta，见测试 `connection.rs:8471`），失败则 fall through 到 `session/load`（@3240-3414），`session/load` 也失败再退化 `session/new`（@3414）。
- 上游入口：`ConnectionManager::spawn_agent(.., session_id, ..)`（`manager.rs:405+`）。带 `session_id` 时先取 per-`(agent, working_dir, session_id)` dedup 锁（@419-435），再 `find_connection_for_reuse`（@438，条件：`external_id` 相等 + agent 相等 + working_dir 相等 + status 非 `Disconnected`/`Error`，实现 `manager.rs:642-671`）；命中直接复用现有连接，否则新 spawn 并走上面的 resume/load 链。
- **目前谁在调这条路径**：① 前端 `conversation-detail-panel.tsx` 打开已持久化会话时把 `detail.summary.external_id` 传给 `useConnectionLifecycle({ sessionId })`（`conversation-detail-panel.tsx:485-526`）→ `acp_connect`；② chat_channel 的 topic resume（`session_commands.rs:876-890` 显式传 `conv.external_id.clone()`，`resume_topic_binding_and_send_followup` @1194+）。
- **delegation 目前完全不用**：`ConnectionManagerSpawner::spawn` 硬编码 `None`（`manager.rs:2575`）。所以 resume 能力**已经存在且被两个非 delegation 调用方验证过**，改造只需把 `session_id` 透传进去（PR #375 抽 `spawn_child_inner` 共用，@2523-2588）。
- 额外好处：`find_connection_for_reuse` 意味着"子进程还在但 broker 丢了 conn_id"也能复用同一进程，不会重复起 CLI。

## B. 前端现状

### B10（最高优先）侧边栏子会话能否直接当普通会话用 → **能，且已是一条完整的"用户给子代理发消息"通路**

证据链（无任何 delegation 特判）：

1. 侧边栏子树行与根行用**同一个组件、同一个 onSelect**：`sidebar-conversation-list.tsx:2272-2296` 对每个 `row.kind === "conversation"` 渲染 `SidebarConversationCard`，`onSelect={handleSelect}`，`depth={row.depth}`；子行只是 `depth > 0`。
2. `SidebarConversationCard` 的点击回调 `onSelect(conversation.id, conversation.agent_type, conversation.folder_id)`（`sidebar-conversation-card.tsx:153`）**对子会话没有任何屏蔽**；本地版仅屏蔽了 hover 快捷操作（pin / 状态切换，`sidebar-conversation-card.tsx:210-215` `isSubsession = conversation.parent_id != null`）。
3. `handleSelect`（`sidebar-conversation-list.tsx:1645-1657`）= `openConversations() + openTab(folderId, id, agentType, false)` —— 与打开普通会话完全一致。
4. 打开后的 `ConversationDetailPanel` 是**完整可交互面板**（输入框 / send / cancel / mode 选择），且它自动 resume：`sessionId = dbConversationId != null && agent !== "cline" ? externalId : undefined`（`conversation-detail-panel.tsx:520-526`），`externalId` 两源解析 = `detail.summary.external_id`（DB）或运行时 `SessionStarted`（`conversation-detail-panel.tsx:429-466`）；`workingDirForConnection = workingDir ?? folder?.path`（@504）。子行的 `folder_id` 与 broker spawn 时的 `effective_working_dir`（`manager.rs:2556`，= 请求 working_dir 或父连接 working_dir）通常同一 folder。
5. 后端不阻止：`list_children`（`conversation_service.rs:535`）返回子行完整 summary（含 `external_id`）；`acp_connect` 带 `session_id` → `find_connection_for_reuse`（`manager.rs:438/642`）→ 命中则**直接复用 broker 保活的那条子连接**，否则 `session/resume` → `session/load` → `session/new` 逐级降级（`connection.rs:3122-3414`）。

→ **结论：不需要任何后端改动，用户今天就能"侧边栏展开父会话 → 点子会话 → 在完整面板里给子代理发消息"**（前提：子行的 `external_id` 已落库，A5 已确认会落库）。

这条通路缺什么（与"给子代理发消息"目标的差距）：

- **broker 不知情**：从面板发的新轮次不经过 broker，`task_id` 在 broker 里仍是 `Completed`；父卡片不会更新、父 LLM `get_delegation_status` 看不到新轮次。若需求只是"用户自己追问子代理"，这不是问题；若需求是"用户的追问也要回到父代理的任务视图里"，则必须走 broker（即 PR #375 的 `continue_delegation`）。
- **可发现性**：`list_all(include_children=false)` 会过滤 `parent_id IS NOT NULL`（`conversation_service.rs:472-474`），子会话只在父行展开时可见；本地分支**尚无** PR #375 的漏斗开关 / `Sub` 徽标 / `isSidebarRootConversation` 防御（那些是 UI 可发现性增强，不是能力开关）。
- **并发**：面板连接与 broker 保活连接若被 `find_connection_for_reuse` 判为同一条，用户发 prompt 时若 broker 侧仍有 in-flight 轮次会拿到 `AcpError::TurnInProgress`（`manager.rs:884`），前端转成排队（`api.ts:200` → `TurnBusyError`）。这是既有机制，可接受。

### B7 Dialog 现有交互 + 加输入框需要什么

`src/components/message/sub-agent-session-dialog.tsx`（425 行）当前承载 3 类"**不驱动新轮次**"的阻塞卡（文件头注释 @3-27 明确写了这条设计边界）：

| 交互 | 数据源 | action | 位置 |
|---|---|---|---|
| 权限请求 | `childConn.pendingPermission` | `useAcpActions().respondPermission(childConnectionId, requestId, optionId)` | @330-337 / 渲染 @383-390 |
| `ask_user_question` 多选卡 | `childConn.pendingAskQuestion` | `answerQuestion(childConnectionId, questionId, answer)` | @346-352 / 渲染 @391-400 |
| plan approval（Grok `exit_plan_mode`） | `childConn.pendingPlanApproval` | `answerPlanApproval(childConnectionId, approvalId, answer)` | @358-364 / 渲染 @401-409 |

`MessageListView` 显式以只读方式挂载：不传 `onReload` / `onNewSession` / `sendSignal`、`isActive={false}`（@412-422，测试 `sub-agent-session-dialog.test.tsx:391-402` 断言了这些 prop 为 false）。文件头还特意说明"legacy 自由文本 `pendingQuestion` 路径故意不挂在这里 —— 它要靠发 prompt 才能回答，而这个只读 viewer 刻意不能发 prompt"。

加输入框有两条路，transport 都已存在，**不需要新 transport 通道**：

- **路 A（不经 broker，最省）**：复用 `useAcpActions().sendPrompt(contextKey, blocks, { folderId, conversationId })`（`acp-connections-context.tsx:4468-4489`）→ `acpPrompt`（`api.ts:184-202` 走 `getTransport().call("acp_prompt", …)`；Tauri 侧 `tauri.ts:115`；Web 侧 handler `web/handlers/acp.rs:139-194` 已接受 `folder_id`/`conversation_id`/`client_message_id`）。**双模式天然覆盖**（Transport 抽象层统一）。障碍：dialog 里的子连接是 `attachDelegationChild` 造出的 synthetic entry，`isDelegationChild: true`（`acp-connections-context.tsx:1219`），生命周期归 broker；`sendPrompt` 本身不检查这个 flag（只有 `reapplyConfig` @4426 检查），所以技术上能发，但语义上是"往别人拥有的连接里插一轮"，且子进程完成后已被销毁（现状）→ 需要 A6 的 resume 能力配合。
- **路 B（经 broker，与 PR #375 契约对齐）**：新增一个"用户侧 continue"命令 → 调 `broker.continue_delegation(...)`。**本地目前没有任何 delegation 的前端可调命令**：`commands/delegation.rs` 只有 settings 的 get/set（@203/@218），`web/handlers/delegation.rs` 同样只有 settings（@19/@30）；PR #375 也**没有**加用户侧入口（它只加 MCP 工具）。所以路 B 需要新增：`commands/delegation.rs` 一个 `#[tauri::command]` + `_core`、`web/handlers/delegation.rs` 一个 handler + `web/router.rs` 一条路由、`src/lib/api.ts` + `src/lib/tauri.ts` 一个 `continueDelegation()`。这是**本次改造相对 PR #375 的净新增面**。

### B8 `useChildLiveBridge` 在多轮下的问题

桥接实现 `sub-agent-session-dialog.tsx:123-238`，四个 effect：

1. `connStatus` 离开 `"prompting"` 的边沿 → `completeTurn(childConversationId, liveMessage)` + `startMetadataSync()`（@165-181）
2. 镜像 `liveMessage` → `setLiveMessage(cid, liveMessage, connStatus === "prompting")`，cleanup 里只在非 prompting 时清空（@183-196）
3. **adopt-settled-reply**：`adoptedRef` + `everPromptingRef` 双 latch，**"最多执行一次、且从未观察到 prompting 才执行"**（@198-224）
4. 卸载时 `removeConversation(childConversationId)`（@226-238）

多轮续聊下的具体故障点：

- **effect 3 的 `adoptedRef` 是"一次性"的**：dialog 不卸载的情况下用户发第二轮，第二轮结束后若走的是 adopt 路径（例如 dialog 在第二轮已 settled 后才收到 liveMessage），`adoptedRef.current === true` 会直接 return → 第二轮回复丢失。而且 `everPromptingRef` 一旦为 true 就永远为 true，adopt 路径对后续所有轮次永久失效。
- **`liveOwnsActiveTurn` 的时间线投影是"单回复"假设**：`conversation-runtime-store.ts:2380-2404`（本地版）在 `hasLiveOrLocalReply` 时 `findIndex(t => t.role === "assistant")` 并 `slice(0, firstAssistantIdx)` —— **把第一个 assistant turn 之后的所有持久化 turn 全砍掉**。注释自己写明："Delegation children are SINGLE-REPLY (one-shot)… A hypothetical multi-turn child would have earlier replies hidden during the live/grace window — not a case the viewer supports."（@2389-2393）。→ 续聊后第二轮流式期间，**第一轮的历史会整段消失**。这正是 PR #375 在 `conversation-runtime-store.ts` 改的那 65 行：改为按 `in_flight_user_turn_id`（`models/conversation.rs:115` 已有该字段）或"最后一个持久化 user turn"为切点，只砍该 user turn 之后的 assistant（保留历史）。
- `kickoffTask` 语义也是单轮：`setLiveOwnsActiveTurn(cid, true, kickoffTask)`（@296-298）合成的是**第一条** user turn；续聊的第二条 user prompt 需要走 optimistic turn（`addOptimisticTurn`）而不是 kickoff 合成。
- effect 4 的 `removeConversation` 在关闭时整体丢弃 runtime session —— 多轮下这仍是对的（下次开重新 fetch），但若用户发完 prompt 立刻关闭 dialog，第 1 条注释的"close-mid-stream"问题会重演（@94-114 已有说明：靠 `removeConversation` 兜底）。

### B9 `CHILD_DETACH_GRACE_MS` detach 策略

`src/contexts/delegation-context.tsx`：`CHILD_DETACH_GRACE_MS = 2_000`（@74），`delegation_completed` 到达后 `setTimeout(() => detachDelegationChild(childConnectionId), 2000)`（@183-190）；`delegation_started` 再次到达同一 `parent_tool_use_id` 时 `cancelDetachTimer` 取消挂起的 detach（@129-133，注释说明是为 reconnect / 快照重放准备的）。`detachDelegationChild` 只删前端 synthetic ConnectionState（reducer `DELEGATION_CHILD_DETACH` `acp-connections-context.tsx:1232-1239`），**不会 `acpDisconnect`**（`disconnectAll` @4455 也只对非 viewer 调 disconnect；delegation child 的 detach 路径 @4688 仅删 entry）。

改成可续聊后要调整的点：

- 2s 后 detach → dialog 里 `useChildConnectionState(childConnectionId)` 拿不到连接 → 权限卡 / ask / plan 卡全部失去 `childConnectionId` 守卫（@391 `childConnectionId && …`），**用户输入框也会失去发送目标**。若走"路 B（broker continue）"，前端只需 `task_id`，不依赖 childConnectionId，detach 反而无害；若走"路 A（直发子连接）"，则必须延长/取消 detach 或在发送时重新 attach。
- 已有的"再次 `delegation_started` 会取消 detach 并 re-attach"机制（@129-137）**天然适配 continue**：PR #375 的 `continue_delegation` 在成功后重新 `emit_started_if_real`（用同一 `parent_tool_use_id` + 新 `child_connection_id`），前端会 `cancelDetachTimer` + `attachDelegationChild` 覆盖旧绑定 —— 也就是 detach 策略**基本不用改**，前提是 continue 走 broker 并重发 started 事件。
- 唯一要留意：`attachDelegationChild` 用 `childConnectionId` 作 contextKey（@4628-4650，已 attach 则 early-return）。resume 后 conn id 变了（新 uuid），旧 entry 会残留到其 detach timer 触发 —— 需要确认不会双份 liveMessage 镜像（dialog 只订阅 binding 里当前的 childConnectionId，binding 已被新 started 覆盖，风险低但要测）。

## C. 契约对齐（PR #375 结构性改动清单）

来源：`gh pr diff 375 --repo xintaofei/codeg --patch` → `F:\codeg-research\.agent-workspace\pr375.patch`（3442 行，37 文件，+1848/-154）。

### C11 逐文件结构性改动

**`types.rs`（+24）**
- `DelegationError` 新增 3 个变体：`SessionStillRunning` / `SessionClosed` / `NotContinuable(String)`
- 新错误码（`DelegationOutcome::from_err` 映射，wire-stable）：`session_still_running` / `session_closed` / `not_continuable`
- `DelegationTaskReport` **未加字段**，只加了一个 `impl`：`with_task_id(mut self, &str) -> Self`（仅在 `task_id.is_none()` 时填充）。→ 回答"`DelegationTaskReport` 加了什么字段"：**没有加字段，只加了一个便利方法**。
- `TaskStatus` **未加 `Closed` 变体**。

**`closed` 状态放在哪里 —— 关键答案**：放在 broker 私有结构 `CompletedTask` 上（新增 `closed: bool` 字段），**不在 `TaskStatus`、不在 `DelegationTaskReport`、不上 wire**。也就是"已关闭"对外只表现为 `continue_with_session` 返回 `error_code = "session_closed"`；`get_delegation_status` 仍报原终态（`Completed`/`Failed`）。前端因此无法直接区分"可续聊"与"已关闭"—— 这是本次要加用户入口时需要补的信息（见 E 节）。

**`broker.rs`（+807）**
- `ChildStatusRecord` 新增 4 字段：`folder_id: i32` / `external_id: Option<String>` / `parent_tool_use_id: Option<String>` / `working_dir: Option<String>`；`DbChildStatusLookup` 同步填充，`working_dir` 由 `folder_service::get_folder_by_id(folder_id).path` 解析
- `CompletedTask` 新增 7 字段：`child_connection_id: Option<String>` / `parent_tool_use_id: String` / `task_preview: String`(#[allow(dead_code)]) / `closed: bool` / `folder_id: Option<i32>` / `external_id: Option<String>` / `working_dir: Option<String>`
- `build_completed()` 签名从 5 参 → **12 参**（加 `#[allow(clippy::too_many_arguments)]`），4 个调用点全部改（`drain_and_record_canceled` / setup-window record / 第二道 pre-cancel / `complete_call`）
- `build_completed` 内部还会**改写 `message`**：Failed 追加 "Use continue_with_session(task_id, message) to resume…"，Completed 空 message 填 "Completed. Use continue_with_session…"
- `running_ack()` 的 message 文案扩写（提 continue/close）
- `finalize_delegation()`：`// v1 one-shot: always tear down the child` + 无条件 `disconnect` → 改为 `should_disconnect = matches!(outcome, Err{code} if code=="canceled")` 才 disconnect
- `complete_call()`：新增 `is_canceled` 前置判定 + `keep_conn = (!is_canceled).then(|| task.child_connection_id.clone())`；成功后调 `enrich_completed_resume_meta(call_id)`
- 新增 6 个方法：`enrich_completed_resume_meta` / `take_settled_child_connections` / `continue_delegation`(pub, ~230 行) / `close_delegation_session`(pub) / `reinsert_completed` / `load_settled_from_db` / `resolve_resume_meta`
- `cancel_by_parent()`：先 `take_settled_child_connections` 逐个 disconnect，再原有 drain
- `cancel_by_parent_turn()`：**只加注释**（settled 子代理跨轮存活），代码不变
- 测试：3 个新测试（`continue_reuses_live_child_connection` / `close_session_blocks_continue` / `continue_respawns_when_child_dead`）；**3 处旧断言反转**：原先断言 `disconnects == ["child-conn-1"]` / `["c-fast-ok"]` / `["c1"]` 改为断言 `disconnects.is_empty()`（第 3 commit `4d6e4099` 就是补修一处漏改的断言）

**`spawner.rs`（+117）** —— trait 加 3 方法：`spawn_for_resume(parent_conn, agent_type, working_dir, session_id: Option<String>, mode, config) -> String`、`send_followup_prompt(conn_id, message, conversation_id, folder_id) -> ()`、`is_alive(conn_id) -> bool`；`disconnect` 文档从"always called…v1 one-shot"改为"cancel / close_session / parent teardown"。Mock 加 `followup_results / resume_args / followups / dead_connections` + `queue_followup` / `mark_dead`，`disconnect` 顺带标 dead。

**`listener.rs`（+81）** —— `BrokerMessage::Continue` / `CloseSession` 两个 dispatch 分支 + `process_continue` / `process_close_session`（token 校验 → `rewrite_identityless_tool_call`（Cursor 身份恢复）→ `parent_lookup.current_conversation_id` → 调 broker）。注意 `process_continue` 额外校验 `entry.parent_connection_id == req.parent_connection_id`，`process_close_session` 不校验。

**`companion.rs`（+100）** —— 工具数 6 → 8；`CompanionFeatures::enabled` 的 delegation 组加 `continue_with_session` / `close_session`；`build_tools_call_spawn` 两个新 arm（参数校验：task_id 非空、message trim 后非空，否则 JSON-RPC `-32602`），复用 `render_task_report`；从 `_meta.tool_use_id` 取 parent_tool_use_id。

**`transport.rs`（+39）** —— 新增 `BrokerContinueRequest { token, parent_connection_id, parent_tool_use_id: Option<String>, task_id, message }` / `BrokerCloseSessionRequest { token, task_id }`；`BrokerMessage` 加 `Continue` / `CloseSession` 变体；新增 `client_continue_round_trip` / `client_close_session_round_trip`。

**`mod.rs`（+12）** —— 新常量 `CONTINUE_TOOL_REWRITE_TITLE = "codeg-mcp__continue_with_session"` / `CLOSE_TOOL_REWRITE_TITLE = "codeg-mcp__close_session"`；模块文档改写（去掉 "v1 is one-shot"）。

**`manager.rs`（+92）** —— 抽出 `ConnectionManagerSpawner::spawn_child_inner(.., session_id: Option<String>, ..)`，`spawn` 传 `None` / `spawn_for_resume` 透传；`send_followup_prompt` = `send_prompt_linked(db, conn_id, [Text], Some(folder_id), Some(conversation_id), None)`（**link 传 None，走 Branch A adopt 现有行**）；`is_alive` 读 `get_state` 判 `!matches!(status, Disconnected|Error)`。

**`connection.rs`（+3）** —— `cursor_companion_title_from_content` 加 `"Continue successful. task_id="` 前缀识别。

**`tool_schema.json`（+38）** —— `delegate_to_agent` / `get_delegation_status` / `cancel_delegation` 三段 description 改写（引导 LLM 优先 continue）；新增 `continue_with_session`（required `task_id`+`message`）与 `close_session`（required `task_id`）两个工具。

**`conversation_service.rs`（+9）** —— `list_all(include_children=false)` 的根过滤从单条 `parent_id IS NULL` 扩到三条 AND：`parent_id IS NULL` + `kind != Delegate` + `delegation_call_id IS NULL`。

**前端（与后端契约无关，属侧边栏可发现性）** —— 新文件 `src/lib/conversation-sidebar.ts`（`isDelegationSubsession` / `isSidebarRootConversation`）+ `.test.ts`；`sidebar-view-mode-storage.ts` 加子会话显示开关；`sidebar-conversation-card.tsx` 加 `Sub` 徽标 + `childCountHint`；`sidebar.tsx` 漏斗开关；`content-parts-renderer.tsx` / `delegation-status-card.tsx` / `delegation-status-row.tsx` 支持 `kind: "continue" | "close"`；`tool-kind-classifier.ts` + `tool-call-normalization.ts` 认新工具名；`app-workspace-store.ts` 用 `isSidebarRootConversation` 做纵深防御；**`conversation-runtime-store.ts`（+65/-…）改 `computeTimelinePrefix` 多轮切点**（见 B8）；10 个 locale json 各加 continue/close/subsession 文案。

第 2 commit `1ad6f8f1` 是修 bug：`isSubsession` 曾用 `parent_id != null || depth > 0`，但 worktree 布局也会把普通根会话缩进到 depth 1 → 改为纯 DB 标记判定 `isDelegationSubsession()`。**这是必须继承的教训**（我们本地 `sidebar-conversation-card.tsx:215` 目前是 `conversation.parent_id != null`，已是安全版本，不要抄第 1 commit 的中间态）。

### C12 本地分支与 PR #375 的冲突面

命令与结果：
- `git log --oneline upstream/main..HEAD -- src-tauri/src/acp/delegation src/components/message/sub-agent-session-dialog.tsx src/contexts/delegation-context.tsx src/stores/conversation-runtime-store.ts src/lib/conversation-sidebar.ts` → **空输出**（本地 kiro 分支未碰任何 delegation 文件）
- `git diff --stat upstream/main...HEAD -- src-tauri/src/acp src/components/message src/contexts src/stores src/lib` →
  ```
  src-tauri/src/acp/connection.rs          | 364 ++++-  (+359/-5)
  src-tauri/src/acp/file_system_runtime.rs | 120 ++++
  src-tauri/src/acp/preflight.rs           |  27 ++
  src-tauri/src/acp/registry.rs            |  84 ++
  src/lib/api.ts                           |  30 ++
  src/lib/types.ts                         |  50 ++
  ```
- 本地 `connection.rs` 改动 hunk 位置：`@@ -129,+133`（Kiro env policy 附近）、`@@ -751/878`（`build_agent`）、`@@ -2086/2281`（`agent_delivers_wire_mcp`）、`@@ -7295/7495`（tests）

**冲突判定**：
- `connection.rs`：PR #375 只改一处 `@@ -6136`（`cursor_companion_title_from_content`），与本地 4 处 hunk **不重叠** → 纯行偏移，git 自动合并。
- `src/lib/api.ts` / `src/lib/types.ts`：本地是**追加**（Kiro registry / preflight 相关），PR #375 不碰这两个文件 → 无冲突。
- 其余 PR #375 触及的 12 个后端文件 + ~20 个前端文件，本地一个都没改 → **零内容冲突**。
- 唯一"逻辑冲突"风险：本地 `feat/kiro-agent` 把 Kiro 注册成新 agent（`AgentType::Kiro`，`SystemBinary` 分发），若 Kiro CLI 不支持 `session/load`/`session/resume`，则 `spawn_for_resume` 对 Kiro 子代理会退化到 `session/new`（冷启动，丢上下文）。需要在改造时确认 Kiro 的 resume 能力，并在 continue 失败时给出可读错误（`not_continuable`）。

## D. 陷阱与风险

### D13 one-shot 语义的原始意图 + 历史修过的生命周期 bug（`git log --oneline --follow broker.rs`，35 个 commit）

**原始意图**（`eeb01202` "feat(acp): DelegationBroker with depth check, timeout, parent-cancel cascade" commit body 原文）："handle_request → depth pre-check → spawn → send_prompt_linked → park oneshot → race timeout vs complete_call. **complete_call disconnects the child (v1 one-shot)**"，`mod.rs` 原文再补一句 "v2 will introduce `continue_with_session` / `close_session` tools without protocol breakage"。→ **one-shot 是有意的 v1 简化（函数调用语义），不是疏漏；作者本来就规划了 v2 续聊**。故 PR #375 的方向与原作者意图一致，不属于"推翻既有设计"。

**历史修过的、改造时不能破坏的既有修复**（按风险从高到低）：

1. `44415f56` "bind parallel sub-agent delegations to their own tool calls" + `2c57170e` + `9761ee19` —— **tool_call_id 关联机制**：并行 delegation 靠 `(agent_type, task, requested_working_dir)` 精确 key 认领 tool_call_id。续聊会用**同一个 `parent_tool_use_id`** 重写 meta / 重发 started（PR #375 `continue_delegation` 尾部），若不慎触发新一轮 claim 逻辑，可能误绑。PR #375 用的是 `write_meta_if_real` + `emit_started_if_real`（直接指名 tool_use_id，不走 claim 队列）—— **必须保持这个做法，不要让 continue 走 claim 路径**。
2. `b4569899` "tombstone stale keyed tool-call entries on terminal ACP status" —— keyed entry 永不老化（Claude Code 串行化 delegate 观测到 77s 延迟），只在 tool_call 终态时 tombstone。续聊会让"同一 tool_use_id 从终态回到 running"，**要确认 tombstone 不会把复活的 entry 当死 id**（本地 `drop_tool_calls_for_parent` 语义见 `broker.rs:2958-2968` 注释）。
3. `99657a5a` "preserve tool_call correlation across turn cancels" —— `cancel_by_parent_turn` 必须保留 `consumed` 记忆，否则 host 重发已处理的 tool_call_id 会误绑下一轮。改造**不得**把 `keep_consumed` 语义简化掉。
4. `6cd1f952` "resolve setup-window cancel races by arrival order" + `2a8f3211` "tear down mid-setup child agents on parent cancel" —— `seq` 到达时钟 + `inflight` 注册表 + `setups` 预留 + `early_completes/early_cancels` 缓冲，实现 first-terminal-wins。这是 broker 里最脆弱的机器；`continue_delegation` **完全不参与这套机制**（它在 settled 之后才跑，没有 spawn→park 窗口）。但要注意：PR #375 的 continue 直接 `inner.running.insert(task_id, running)`（**不 reserve、不 register_inflight**）→ 续聊轮次期间的父取消只能靠 `running` drain 捕获，若在 `send_followup_prompt` 之后、`running.insert` 之前发生父取消，**这一轮子代理会漏掉取消**（窗口很小但存在）。→ 风险 R3。
5. `f2a15698` "surface child terminal error and skip non-terminal cancels" —— `AcpEvent::Error` 非终态不再被当终态；worker 缓冲最后的 terminal error，只在 `StatusChanged::Disconnected` 时 drain 给 broker。保活子进程后，`cancel_by_child_connection`（`broker.rs:2894`）在 `running` 里找不到 entry 时会 `buffer_child_failure`（`broker.rs:390`，仅当 child 仍 reserved 时才写）→ **保活期间子进程自己死掉（用户手动 kill / agent 崩溃）时，broker 的 `completed` 里那个 `child_connection_id` 变成幽灵**，只有 continue 时 `is_alive()` 才发现。这正是 `is_alive` 存在的理由 —— 不能省。
6. `3780e86e` "emit completion on every terminal path" —— 每条终态路径都必须 emit `DelegationCompleted`，否则前端 binding 卡在 running。续聊后"第二轮完成"会再次 emit completed（同一 tool_use_id）→ 前端 `delegation-context.tsx` 会重新起 detach timer（@183-190），语义正确。
7. `01d3696b` "lower default max delegation depth to 1" + `df1af125` "default multi-agent collaboration to off" —— 默认关闭 + depth_limit=1（`DelegationConfig::default` `broker.rs:170-178`）。续聊不改这些默认值。

### D14 保活的资源问题

现有回收机制：
- **无连接数上限**：`git grep` 未找到 delegation 的 max-children / 并发上限配置（`DelegationConfig` `broker.rs:135-160` 只有 `enabled` / `depth_limit` / `agent_defaults` / `completed_cache_cap_bytes`）。**未找到：`git grep -n "max_children\|max_concurrent" src-tauri/src`（0 命中）**。fan-out 10 个子代理 = 10 个 agent CLI 进程，v1 靠 one-shot 立即回收。
- **idle sweep**：`ConnectionManager::sweep_idle(idle_timeout)`（`manager.rs:527-573`），由 `idle_sweep_task`（`acp/idle_sweep.rs:39-60`）按 `SWEEP_INTERVAL_SECS` 周期跑，默认 `DEFAULT_IDLE_TIMEOUT_SECS = 180`（`idle_sweep.rs:19`，`CODEG_ACP_IDLE_TIMEOUT_SECS` 可覆盖，`0` 关闭）；桌面在 `lib.rs:646-655` 启动、server 在 `bin/codeg_server.rs:438-445` 启动。
- sweep 的豁免条件（`manager.rs:544-563`）：`status != Connected` 跳过（含 `Prompting`）、`pending_permission.is_some()` 跳过、`has_active_background_work(now)` 跳过（`session_state.rs:1008-1017`，需 `background_outstanding > 0` **且** 最近一次 `BackgroundActivity` 在 `background_keepalive_max_age()`（`session_state.rs:1291`）内）、`last_activity_at` 未超时跳过。

→ **保活的 settled 子连接会被 idle sweep 在 180 秒后杀掉**：它 status = `Connected`、无 pending permission、`background_outstanding = 0`（子代理自己没起后台任务）、`last_activity_at` 停在最后一次事件。sweep 调 `disconnect` 会真的终止 agent CLI 进程。

后果不是灾难（PR #375 的 `is_alive()` + `spawn_for_resume(external_id)` 正是为此设计的降级路径：进程没了就 `session/load` 重开），但代价是：
- 续聊延迟从"直接发 prompt"变成"重启 CLI + session/load 重放历史"（Claude 的 `session/resume`、其他 agent 的 `session/load`，`connection.rs:3122-3414`）；
- **`session/load` 会重放历史通知**（`connection.rs:3263` "Drain historical replay notifications"），前端 timeline 可能出现重复/抖动；
- 有 agent 根本不支持 load（`classify_session_load_failure` `connection.rs:5077`，失败退化 `session/new` = **静默丢上下文**，这是最坏情况：用户以为在续聊，实际子代理已失忆）。

PR #375 **没有**碰 idle sweep、也没有给保活连接打豁免标记 → 实际行为是"3 分钟内续聊走活连接，之后走 resume"。这是可接受的设计（避免僵尸进程常驻），但**必须在设计文档里写明**，否则会被当 bug。同时注意 `sweep_idle` 与 broker 的 `completed.child_connection_id` 之间没有任何通信 —— broker 不会知道连接被 sweep 掉，只能靠 `is_alive` 事后发现。

另一条泄漏路径（PR #375 未处理）：`evict_completed_over_cap`（`broker.rs:508-537`）按 text 字节 FIFO 淘汰 completed entry 时，**直接 `self.completed.remove()`，不 take `child_connection_id`** → 若淘汰的 entry 持有保活连接，该进程再无人持有引用，只能等 idle sweep（180s）回收。→ 风险 R2。

### D15 `depth.rs` 嵌套深度对续聊的额外约束

- `compute_depth(start, parent_resolver, cap)`（`depth.rs:15-36`）：沿 `conversation.parent_id` 向上走，`cap` 饱和防环。broker 在 `handle_request` 里做 depth 预检，`depth_limit` 默认 1（`broker.rs:172`），即"root → child 允许，child 再委托被拒"。
- **续聊本身不改变 depth**：`continue_delegation` 复用现有 child conversation 行（`parent_id` 不变），PR #375 的 continue 路径**完全不做 depth 检查** —— 正确，因为没有新建行。
- 额外约束（需要注意的两点）：
  1. **孙代理的父是子代理的连接**。`depth_limit > 1` 时，子代理 A 委托出孙代理 B；用户/父 LLM 对 A 续聊时，A 的 `cancel_by_parent_turn`（若 A 的新轮次非 end_turn 结束）会级联取消 A 名下的 running 孙代理 —— 这是既有语义，续聊后会更频繁触发。
  2. **A 被 `close_session` 时，B 怎么办**？PR #375 的 `close_delegation_session` 只 disconnect A 的连接；A 的连接消失会走 `connection.rs:1161` 的 `cancel_by_parent(&A_conn_id)` 清理守卫，级联取消 B（含 PR #375 新加的 `take_settled_child_connections`）—— 链条是通的，但**依赖 A 的 `run_connection` 真的退出**。若 A 是被 broker `disconnect` 而非进程自然退出，需要确认清理守卫仍触发（`disconnect` → 连接循环退出 → 守卫，路径上看是通的，但**未实测**）。
  3. `spawn_for_resume` 传的 `parent_connection_id` 是**父的**连接 id（用于继承 emitter / owner_window / working_dir 兜底，`manager.rs:2530-2556`）。续聊时父连接可能已经换了一条（用户重连过父会话）→ `continue_delegation` 用的是调用时的 `parent_connection_id`，而 `CompletedTask.parent_connection_id` 是当初的那条；PR #375 的所有权校验是 `c.parent_connection_id == parent_connection_id`（严格相等），**父重连后 task_id 会直接判 `Unknown`**，只能靠 `load_settled_from_db` 兜底（它用 `rec.parent_id == parent_conversation_id` 按 conversation id 校验，能救回来）。→ 用户侧入口若按 conversation id 而非 connection id 设计，天然更稳。

## E. 工作包拆分与路径建议

### E17 有没有比"照搬 PR #375 后端 + 加输入框"更省的路径 —— 有，明确答复

**答复：有，且省一大截。B10 已证明"用户给子代理发消息"今天就跑得通**（侧边栏展开父会话 → 点子会话 → 完整面板输入框，自动按 `external_id` resume，零后端改动）。因此存在三档方案，按代价递增：

**方案 0（零后端 · 半天）**：只做可发现性。抄 PR #375 的前端子集：`src/lib/conversation-sidebar.ts`（`isDelegationSubsession` / `isSidebarRootConversation`）+ `Sub` 徽标 + `childCountHint` + 漏斗开关，再在 `SubAgentSessionDialog` 里加一个"在标签页中打开"按钮（调 `openTab(folderId, childConversationId, agentType)`，`sidebar-conversation-list.tsx:1645` 同一路径）。
- 得到：用户能给任意子代理发消息、恢复已停止的子代理（走 `session/load`）。
- 得不到：父 LLM 不知道这轮追问；父卡片状态不更新；`task_id` 语义不变。
- 契约风险：**零**（不碰 broker/spawner/types）。

**方案 1（对齐契约的后端 + 用户入口 · 推荐）**：照搬 PR #375 的后端（12 个文件的结构性改动，C11 已列全），**额外**补它缺的用户侧入口（`commands/delegation.rs` + `web/handlers/delegation.rs` + router + `api.ts`/`tauri.ts`），Dialog 输入框调 `continueDelegation(taskId, message)`。
- 得到：父 LLM 与用户共享同一个 `task_id` 视图；父卡片跟着变 running；close_session 可回收。
- 代价：broker 状态机改动（`build_completed` 12 参、7 个新字段、3 处旧断言反转）+ trait 加 3 方法 + 多轮 timeline 投影改造。
- 契约收益：将来合并 upstream #375 时**零冲突**（C12 已确认本地未碰任何相关文件）。

**方案 2（自研续聊）**：不推荐 —— 会与 #375 结构性冲突，未来合并要重写。

**推荐：方案 1，但把方案 0 的前端子集作为 W1 先落地**（它独立可交付、可独立验证、且是方案 1 的 UI 底座）。若产品只需要"用户能追问子代理"而不需要"父 LLM 感知"，则**停在方案 0 即可**，这需要产品决策（§0.12 层面的问题，不由我裁决）。

### E16 工作包拆分

| 包 | 范围 / 目标 | 涉及文件 | 依赖 | 可并行 | 独立可测 |
|---|---|---|---|---|---|
| **W1 侧边栏可发现性（方案 0）** | 子会话可见性 + `Sub` 徽标 + 漏斗开关 + "在标签页打开"按钮；根列表三条过滤 | 新 `src/lib/conversation-sidebar.ts` + `.test.ts`；`sidebar-conversation-card.tsx`；`sidebar-conversation-list.tsx`；`sidebar.tsx`；`sidebar-view-mode-storage.ts`；`app-workspace-store.ts`；`conversation_service.rs:472`（三条过滤）；10 个 locale json | 无 | ✅ 与所有包并行 | ✅ vitest（`conversation-sidebar.test.ts`）+ Rust `list_all` 单测 |
| **W2 spawner 能力扩展** | trait 加 `spawn_for_resume` / `send_followup_prompt` / `is_alive`；生产实现抽 `spawn_child_inner`；Mock 扩展 | `delegation/spawner.rs`；`acp/manager.rs:2519-2720` | 无 | ✅ 与 W1/W5 并行 | ✅ `spawner.rs` mock 单测 + `manager.rs` 单测（`is_alive` 可用现有 `get_state` 测试骨架） |
| **W3 broker 保活状态机** ★串行核心 | `CompletedTask` +7 字段、`ChildStatusRecord` +4 字段、`build_completed` 12 参、`finalize_delegation` 条件 disconnect、`complete_call` keep_conn、`enrich_completed_resume_meta`、`take_settled_child_connections`、`cancel_by_parent` 配套、**修 `evict_completed_over_cap` 泄漏（PR #375 漏项）**、3 处旧断言反转 | `delegation/broker.rs` | **W2**（要调新 trait 方法） | ❌ 必须串行（独占 `PendingInner` 状态机） | ✅ broker 单测（168 个既有测试必须全绿 + 3 个新测试） |
| **W4 continue/close 对外契约** | `types.rs` 3 错误变体 + `with_task_id`；`transport.rs` 2 请求 + 2 变体 + 2 round_trip；`listener.rs` 2 dispatch + 2 process；`companion.rs` 2 arm + features；`tool_schema.json` 2 工具 + 3 段描述；`mod.rs` 2 常量；`connection.rs` cursor 标题 | `types.rs` / `transport.rs` / `listener.rs` / `companion.rs` / `tool_schema.json` / `mod.rs` / `connection.rs:6136` | **W3**（`continue_delegation`/`close_delegation_session` 必须先存在） | ❌ 串行于 W3 | ✅ listener/companion 单测 + `tests/delegation_e2e_uds.rs` / `_windows.rs` |
| **W5 多轮 timeline 投影** | `computeTimelinePrefix` 按 `in_flight_user_turn_id`/最后 user turn 切点，保留历史；`useChildLiveBridge` 的 `adoptedRef`/`everPromptingRef` 改为可重入（每轮 reset） | `src/stores/conversation-runtime-store.ts:2380-2404`；`src/components/message/sub-agent-session-dialog.tsx:123-238` | 无（纯前端，可先做） | ✅ 与 W1/W2/W3 并行 | ✅ vitest（`conversation-runtime-context.test.tsx` / `runtime-timeline-prefix-cache.test.ts` / `sub-agent-session-dialog.test.tsx` 已有骨架） |
| **W6 用户侧入口（#375 缺口）** | `continue_delegation` / `close_delegation_session` 的 Tauri command + `_core` + Web handler + router + `api.ts`/`tauri.ts`；Dialog 输入框；continue/close 卡片渲染（`kind: "continue"｜"close"`） | `commands/delegation.rs`；`web/handlers/delegation.rs`；`web/router.rs`；`src/lib/api.ts` + `tauri.ts`；`sub-agent-session-dialog.tsx`；`content-parts-renderer.tsx`；`delegation-status-card.tsx` / `-row.tsx`；`tool-kind-classifier.ts`；`tool-call-normalization.ts`；locale json | **W3 + W4** | ❌ 串行于 W4 | ✅ Web handler 单测 + vitest 组件测 |

**串行链**：`W2 → W3 → W4 → W6`（都动 broker 状态机或其对外面）。
**可并行**：`W1`、`W5` 全程与串行链并行（零文件重叠）。

**风险交叉区（多包碰同一文件）**：
- `sidebar-conversation-card.tsx` / `sidebar-conversation-list.tsx`：只有 W1 碰 → 无冲突。
- `sub-agent-session-dialog.tsx`：**W5（桥接逻辑）+ W6（输入框）都碰** → 建议 W5 先合、W6 后合，或明确切分（W5 只改 `useChildLiveBridge` 函数体 @123-238，W6 只改 `SubAgentSessionBody` 渲染部分 @270-425）。
- `broker.rs`：W3 独占，8056 行单文件 + 168 个测试，**绝对不能并行**。
- locale json（10 个）：W1（subsession 文案）+ W6（continue/close 文案）都碰 → 同一 key 命名空间不同（`Sidebar.*` vs `Folder.chat.delegation.*`），冲突概率低但按 json 行合并易冲突 → 建议 W1 与 W6 的 locale 改动由后合的那个包一次性补齐。
- `manager.rs`：W2 独占（新增 `spawn_child_inner` / `send_followup_prompt` / `is_alive`，都在 `ConnectionManagerSpawner` impl 块内 @2519+）。

**建议派发**：3 个执行 AI —— A 跑串行链 `W2→W3→W4→W6`（最重，独占 broker），B 跑 `W1`，C 跑 `W5`；A 的 W6 阶段前需等 C 的 W5 合入以避免 dialog 文件冲突。

### Top-3 风险

- **R1（最高）· 保活子进程会被 idle sweep 在 180s 后杀掉，续聊静默降级到 `session/new` 丢上下文**。`sweep_idle`（`manager.rs:527-573`）对 settled 子连接的所有豁免条件都不满足；`session/load` 失败会退化 `session/new`（`connection.rs:3414`），此时用户以为在续聊、子代理实际失忆，且**没有任何 UI 提示**。PR #375 未处理。缓解：给保活连接打豁免标记，或在 resume 降级到 `session/new` 时向用户显式报"上下文已丢失"。
- **R2 · `evict_completed_over_cap` 淘汰持有保活连接的 entry → 进程泄漏**（`broker.rs:508-537` 直接 `remove` 不 take `child_connection_id`）。PR #375 只在 `take_settled_child_connections` / `close_delegation_session` 处理了连接回收，漏了 FIFO 淘汰这条。fan-out 场景（大量子代理 + 大结果文本）最容易触发。缓解：淘汰时 take 出连接 id 并 disconnect（需要把淘汰从同步 `&mut self` 提到能做 async I/O 的层）。
- **R3 · continue 的注册窗口无取消覆盖**。PR #375 的 `continue_delegation` 在 `send_followup_prompt` 成功后才 `inner.running.insert(task_id, running)`，中间**不 reserve / 不 register_inflight** → 这个窗口内发生父取消（`cancel_by_parent*` 只扫 `running` 和 `inflight`）会漏掉这一轮，子代理成为脱管的运行中进程。窗口小但正是历史上 `2a8f3211` / `6cd1f952` 两次修复的同类 bug。缓解：continue 复用 `register_inflight` + 在 insert 前做一次 `take_inflight_cancel` 检查。

次级风险（不入 Top-3 但需记录）：`closed` 只存在 broker 私有结构、不上 wire（C11），前端无法区分"可续聊"与"已关闭"，用户点了输入框才拿到 `session_closed` 错误 —— 加用户入口时应把可续聊性暴露到 `DelegationTaskReport` 或另开查询；父连接重连后 `parent_connection_id` 严格相等校验会让 task 判 `Unknown`（D15-3），用户侧入口应按 conversation id 设计。

## 检索纪律记录

- `git grep`：`disconnect` / `cancel_by_parent*` / `external_id` / `sweep_idle` / `list_children` / `session/load` / `TaskStatus::` / `acpPrompt` / `isDelegationChild` 等
- `codebase-context-engine`：sub-agent dialog 只读交互、侧边栏子会话打开、resume 已有会话、transport send prompt
- `gh pr diff 375 --repo xintaofei/codeg --patch`（154981 字节，落盘后分段 read_file）
- `git log --oneline --follow broker.rs`（35 commit）+ 8 个关键 commit 的 body
- 未找到项：delegation 并发/子代理数量上限（`max_children` / `max_concurrent`，0 命中）；本地分支的 delegation 相关改动（`git log upstream/main..HEAD -- src-tauri/src/acp/delegation`，空）
