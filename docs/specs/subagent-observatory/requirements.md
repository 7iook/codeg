# Requirements · 常驻子智能体观察面板

## Introduction

用户在主会话派发子智能体（外部委托的 codex/claude CLI，或 Claude 内置 Task 派出的内部 SUB）后，想查看某个子智能体的消息，必须把消息流往上滚回到当初那张内联卡片。现有的左上悬浮面板 `SubAgentOverlay` 绑定在"最后一条 assistant 回复"上，一条新的非委托回复就会把它清空，因此不具备常驻观察能力。

本需求新增一条常驻指示条与一个清单面板，**统一观察委托子智能体与内部 SUB 两类对象**，让用户随时知道"现在有哪些子智能体在跑、跑到哪、要不要停掉"，并能就地查看详情或跳转到完整子会话。两类对象的可操作能力并不对等（内部 SUB 不可取消、不可跳转），面板显式呈现这一边界而非假装一致。

## Success State (§0.16 · MANDATORY · sourced, NEVER self-invented)

NOT 「两个 Provider 暴露了 `list()` 投影且单元测试全绿」，
BUT 「用户在一个跑着 2 个子智能体的会话里，不滚动消息流就能看到这 2 条带 agent 类型与任务预览的行；点其中一条的取消，该子智能体在数秒内真的停止，且该行移入已完成分区」。

Must NOT happen: 用户点了取消、UI 无任何反应、而 broker 实际返回 `unknown`（即 `cancel_task_by_id` 归属校验缺陷未修时的症状）。

Source: 用户原话「我想看这个 sub 的消息就得拉到上面去才能看到」+「它们是点不动的」；消费方前置条件 `src-tauri/src/acp/delegation/broker.rs:4884`（归属校验）与 `src-tauri/src/acp/session_state.rs:1118`（completed 即 remove，故已完成分区必须前端自留）。

Verified once by: 起一个真实委托子智能体 → 面板列出该行 → 点取消 → 确认 broker 返回 `Canceled` 且子连接被 teardown（非单元测试）。

## Glossary

- **委托子智能体（Delegated Sub-Agent）**: 经 codeg 的 delegation broker 派发的独立 agent CLI 会话，由 `task_id` 与 `child_conversation_id` 标识。运行态真源为 `SessionState.active_delegations`（`src-tauri/src/acp/session_state.rs:293`），前端绑定为 `DelegationBinding`（`src/contexts/delegation-context.tsx:39-53`）。
- **内部 SUB（Built-in Sub-Agent）**: 宿主 agent（Claude）用内置 Task/Agent 工具派出的子智能体，仅由 `parent_tool_use_id` 标识，无独立会话 id、无 ACP 寻址。数据为 `SubagentFrame[]`（`src/lib/subagent-transcript.ts:21-27`），存于 `SubagentTranscriptProvider` 内存 map。
- **Claude 原生后台任务（Native Background Work）**: Claude CLI 自身 transcript 中记录的 async agent（`agentId`）与后台 shell（`backgroundTaskId`），由 `BackgroundWatcher` 统计（`src-tauri/src/acp/background_watch.rs:673`）。**与前两类是独立任务池，不属于本面板的观察对象。**
- **观察面板（Observatory Panel）**: 本需求新建的清单载体，展示委托子智能体与内部 SUB 的运行态行模型。
- **子智能体常驻条（Sub-Agent Chip）**: 本需求新建的常驻指示条，是观察面板的入口。其**观察集合 = 当前会话的委托子智能体与内部 SUB 的并集**（R5.2），显示的数字是该集合中运行中条目数（无运行中时显示已完成数，R5.3-R5.4）。**不**取自单一委托池 —— 初稿曾如此定义，与「覆盖内部 SUB」矛盾，已于 R1 A1 / R2 B3 修正。
- **后台任务横幅（BackgroundTasksChip）**: 既有组件 `src/components/chat/background-tasks-chip.tsx`，计数取自 Claude 原生后台任务池（**与本面板的观察集合无交集**）。本需求按 R5A 让其分类呈现内置异步 sub 与后台 shell 两类计数，不改其数据来源所属的任务池。
- **行模型（Observed Sub-Agent Row）**: 归一化后的清单行，容纳上述两类观察对象的字段差异。
- **归属校验（Ownership Check）**: broker 判定调用方是否有权操作某任务的检查。权威口径为 `parent_conversation_id` 优先、无会话上下文时回退 `parent_connection_id`（样板 `broker.rs:5019-5026`）。

## Requirements

### Requirement 1: 修复用户侧取消的归属校验（前置阻塞项）

**User Story:** As a codeg 用户, I want 取消按钮对 LLM 派发的子智能体真实生效, so that 我不必等一个跑错方向的子智能体烧完 token。

#### Acceptance Criteria (EARS)

1. WHEN `cancel_task_by_id` 收到非空的 `parent_conversation_id`, THE DelegationBroker SHALL 以 `parent_conversation_id` 相等作为归属判定依据。
2. WHERE `parent_conversation_id` 为 `None`, THE DelegationBroker SHALL 以 `parent_connection_id` 相等作为归属判定依据。
3. WHEN 用户侧入口以 `USER_ENTRY_CONNECTION_ID` 与匹配的 `parent_conversation_id` 请求取消一个运行中任务, THE DelegationBroker SHALL 将该任务转入 `Canceled` 并 teardown 其子连接。
4. IF 归属判定不通过, THEN THE DelegationBroker SHALL 返回 `unknown_report` 且不泄露该任务的存在性。
5. THE DelegationBroker SHALL 对 `completed` 缓存中的任务应用与 `running` 分支相同的归属判定口径。
6. THE `classify_locked` SHALL 以与 R1.1 和 R1.2 相同的归属判定口径分类任务状态。
7. WHEN `get_tasks_status` 收到非空的 `parent_conversation_id`, THE DelegationBroker SHALL 将其透传至 `classify_locked` 作为归属判定依据。

> **同根变体说明（§5.3）**：缺陷指纹 = 「用户侧合成连接 id 遇上只比 `parent_connection_id` 的归属判定」。全仓扫描 `parent_connection_id ==` 命中三个用户侧可达点：`continue_delegation`（`broker.rs:5030`，**已治**，D5 口径）、`cancel_task_by_id`（`:4890` / `:4896`，**未治**，R1.1-R1.5）、`classify_locked`（`:1933` / `:1939`，**未治**，R1.6-R1.7）。后两处的签名均已携带 `parent_conversation_id` 却未使用 —— 参数在、用法漏。按 §4.8 在同一交付内根治，避免面板扩展到「显示权威状态」时再次踩同一坑。

### Requirement 2: 委托子智能体的全量只读投影

**User Story:** As a codeg 用户, I want 系统能列出当前所有委托子智能体, so that 面板有数据可展示。

#### Acceptance Criteria (EARS)

1. THE DelegationProvider SHALL 暴露一个只读投影，返回其全部 `DelegationBinding` 条目。
2. THE DelegationProvider SHALL 在该投影中保留 `status` 为 `ok` 或 `err` 的已完成条目，直到其因条目上限被淘汰或该工作区卸载。
3. WHEN 一个 `delegation_started` 事件到达, THE DelegationProvider SHALL 使新条目在该投影中可见。
4. WHEN 一个 `delegation_completed` 事件到达, THE DelegationProvider SHALL 更新该条目的 `status` 而不将其从投影中移除。
5. THE DelegationBroker SHALL 在 `delegation_started` 事件中携带该委托的 `parent_conversation_id`。
6. THE 快照 seed 回放 SHALL 以快照自身的 `conversation_id` 作为其合成 `delegation_started` 事件的 `parent_conversation_id`。
7. THE DelegationProvider SHALL 将 `parent_conversation_id` 保留在其绑定条目中，且不区分该条目来自实时事件还是快照回放。
8. IF 一条绑定的来源快照没有 `conversation_id`, THEN THE 快照 seed 回放 SHALL 令该条目的 `parent_conversation_id` 缺失而不是猜测取值。
9. THE 行模型 selector SHALL 以绑定条目的 `parentConversationId` 与传入的当前会话 id 的相等性判定委托行的会话归属。
10. THE 行模型 selector SHALL NOT 为判定会话归属发起数据库查询、异步请求或读取模块外的全局状态。
11. IF 一个绑定条目的 `parentConversationId` 缺失, THEN THE 行模型 selector SHALL 将该行的会话归属取值为未归属。
12. WHILE 条目数达到委托绑定上限, THE DelegationProvider SHALL 按终态到达时间淘汰最旧的已终态条目。
13. THE DelegationProvider SHALL NOT 淘汰状态为运行中的条目。
14. THE 观察面板 SHALL 对已完成分区施加每会话显示上限，超出时按终态到达时间隐去最旧条目。

> **C1 处置（R3 评审 P0 · 采纳，且无需新增 wire 字段）**：评审指出实时事件与快照 seed 回放没有形成统一归属契约 —— 我 R2 只约束了实时路径，而 design 同时声明 `ActiveDelegationState` 沿用不改，重连后同一任务可能突然变成未归属。**指认成立**。
>
> 核实结论：`ActiveDelegationState`（`session_state.rs:211-224`）确实无 `parent_conversation_id`，但**不需要给它加**。它挂在 `SessionState` 上，而 `SessionState.conversation_id`（`:245`）就是该会话 id，且快照出墙时两者同在一份快照里（`:1449` 带 `conversation_id`、`:1459` 带 `active_delegations`）。故 seed 回放（`delegation-seed.ts:22`）直接用快照自身的 `conversation_id` 填充即可 —— 与它现在用快照 `connectionId` 填 `parent_connection_id` 是同一手法（`:31`）。
>
> 两条路径因此同源同构（实时由 broker 从 `SessionState.conversation_id` 取，回放由 seed 从同一字段取），**零新增 wire 字段**（R2.6）。缺失时明确不猜（R2.8）。

> **R2.10 处置（R2 评审 B9 · 采纳）**：初稿有一条「投影引用在无变更时保持稳定」的 AC，原因写「以便消费方 memo 命中」。评审指出这是把性能实现建议提升为强制验收要求，且无法陈述用户损失 —— 成立，**已删除该 AC**（连带删除其 Property）。引用稳定仍是合理的实现取向，但归入实现建议（design.md Architecture 段），不锁定为验收条件，以免测试锁死等价实现。

> **A7 处置说明（R1 评审 P1 · 采纳，且推翻了初稿的一处前提）**：初稿把「保留到会话关闭」寄托于 Provider 生命周期，但两个 Provider 实际挂在**工作区级**（`src/app/workspace/layout.tsx:1224`，位于 `TabProvider` / `ConversationRuntimeProvider` 之外），切会话与关 tab 都不卸载它们；且委托绑定侧 `byToolUseId`（`delegation-context.tsx:76-78`）**完全无上限**，只增不减。
>
> 即初稿既保留过久（关了会话 tab 记录仍在内存），又在长工作区会话下无界增长。修正为三层机制：保留边界由 selector 的会话归属表达（R2.9-R2.11）、已完成分区加每会话显示上限（R2.14）、委托绑定加全局条目上限且只淘汰终态（R2.12-R2.13）。详见 design.md D3。

> **会话归属的三轮收敛（R1 A4 → R2 B1 → R3 C1）**：
>
> **R1 A4 指出**：初稿把归属写成「`childConversationId` 的父会话」需要 DB 查询，但 selector 声明为纯函数且输入无此字段 —— 链路断一跳。核实成立（`DelegationBinding` `delegation-context.tsx:39-53` 与 `DelegationStarted` 事件 `acp/types.rs:334-348` 均不含 `parent_conversation_id`）。
>
> **R1 后我的第一版修法用 `parentConnectionId` 比对，R2 B1 指出它同样不闭合**，且这次指认也成立：前端的 `contextKey` 实际是 **`tabId`**（`conversation-detail-panel.tsx:564`），与 `connectionId` 是不同标识体系；selector 既拿不到「当前连接标识」，也没有「已知会话集合」。我第一版修法只换了数据来源、没重建输入契约。
>
> **R2 定的解法**：让 `delegation_started` 事件直接携带 `parent_conversation_id`（R2.5）。依据：`SessionState.conversation_id`（`session_state.rs:245`）本就是后端持有的权威会话 id，且 `ConnectionManagerParentLookup::current_conversation_id`（`manager.rs:3353`）已在用它把 `parent_connection_id` 解析成会话 id —— broker 判归属用的就是同一个源。selector 只需比对两个会话 id（R2.9），既不查 DB、不依赖连接标识、也不需要「已知会话集合」。
>
> **R3 C1 补齐了它漏掉的一半**：R2 只约束了实时事件路径，快照 seed 回放没同步 → 重连后同一任务可能突变为未归属。处置见上方 C1 说明（回放用快照自身 `conversation_id`，零新增 wire 字段）。
>
> **三轮的教训**：同一个归属问题改了三次（DB 查询 → 连接标识 → 会话 id + 双路径同构），每次都是**只修了正在看的那一条路径**。第三次才补上「所有 producer 必须产出同构值」这个视角。

### Requirement 3: 内部 SUB 的全量只读投影与会话归属

**User Story:** As a codeg 用户, I want 内部 SUB 也出现在面板里并归到正确的会话下, so that 我不必区分它是哪种派发方式。

#### Acceptance Criteria (EARS)

1. THE SubagentTranscriptProvider SHALL 暴露一个只读投影，返回其全部受跟踪的内部 SUB 条目。
2. WHEN 一个 `claude_subagent_message` 事件到达, THE SubagentTranscriptProvider SHALL 读取该事件的 `session_id` 并随帧一同保留。
3. THE 行模型 selector SHALL 通过传入的「外部会话 id → 会话 id」映射快照将内部 SUB 的 `session_id` 解析为 `conversation_id`。
4. IF `session_id` 在当前映射快照中无法解析, THEN THE 行模型 selector SHALL 将该条目的会话归属取值为未归属，而不丢弃该条目、也不归入当前会话。
5. WHEN 映射快照更新后使一个先前未归属的 `session_id` 可解析, THE 行模型 selector SHALL 在下一次求值时将该条目归入其所属会话。

6. WHILE 受跟踪条目数达到 `MAX_TRACKED_SUBAGENTS` 上限, THE SubagentTranscriptProvider SHALL 按插入序淘汰最旧条目。
7. THE SubagentTranscriptProvider SHALL 暴露一个自本工作区加载以来因容量上限而被淘汰的条目累计计数。
8. WHILE 该淘汰计数大于零, THE 观察面板 SHALL 在面板级呈现一条容量提示，说明有较早条目已不再保留。
9. THE 观察面板 SHALL NOT 将该淘汰计数呈现为仅反映当前会话的数量。
10. THE SubagentTranscriptProvider SHALL 为每个受跟踪条目记录其最后一帧到达时刻。
11. WHILE 一个内部 SUB 自最后一帧起未超过静默判定阈值, THE 行模型 selector SHALL 将其生命周期取值为运行中。
12. WHILE 一个内部 SUB 自最后一帧起已超过静默判定阈值, THE 行模型 selector SHALL 将其生命周期取值为已静默。
13. THE 行模型 selector SHALL NOT 为内部 SUB 赋予已完成、已取消或失败的生命周期取值。
14. THE 观察面板 SHALL 在呈现已静默状态时标明该状态表示「无最近活动」而非「已成功结束」。

> **B8 处置（R2 评审 P1 · 采纳）**：初稿让 Provider 在事件到达时调 `getConversationIdByExternalIdFromStore` 一次性解析并把结果存成稳定归属。评审指出这隐含「映射一定早于帧事件建立」的时序假设 —— 启动 / 重连 / 事件乱序时，本属当前会话的 SUB 会**永久**停在未归属分区。成立。
>
> 修正为：Provider **只保留原始 `session_id`**（R3.2），不缓存派生的归属；解析改由 selector 在每次求值时基于传入的映射快照进行（R3.3-R3.5）。这样映射后到也能自然纠正，且解析不再是被固化的一次性副作用。代价是 selector 多一个输入参数（映射快照），与 B1 修法方向一致 —— 归属所需的一切都从入参进来，函数保持纯。

> **F1 补充说明（R1 评审 P1 · 采纳，改法不同）**：初稿要求 UI 在条目被淘汰时「显示说明文本、不静默消失」，但 Provider 删除条目后消费方已无任何证据可据以说明 —— 生产者销毁了消费者所需的唯一凭据。
>
> 评审建议 tombstone 或一次性事件；改为**聚合淘汰计数**（R3.7-R3.8）：不为每个被淘汰条目保留墓碑（那会让上限形同虚设），只维护一个单调递增的计数，UI 据此在面板级提示「有较早条目已不再保留」。逐条说明的承诺相应撤回 —— 逐条说明本就需要保留被删条目的身份，与容量上限的目的自相矛盾。

> **A3 修正说明（R1 评审）**：内部 SUB 的事件源（`ClaudeSubagentMessage`）不携带任何终止信号 —— 无帧既可能是完成，也可能是模型思考、等待阻塞或连接中断。初稿仍承诺「已完成分区」对内部 SUB 成立，属于把「近期活动证据」误当「权威生命周期状态」。修正为内部 SUB 只有「运行中 / 已静默」两态，永不进入已完成分区。用户 2026-08-03 拍板：15 秒无新帧转「已静默」，不假装知道成败。
>
> 静默判定阈值的具体取值属实现细节（当前取 15 秒），不写入 AC 以免绑死；AC 只约束「存在阈值」与「跨越阈值的状态迁移方向」。

### Requirement 4: 行模型归一

**User Story:** As a codeg 用户, I want 两类子智能体在同一份清单里可读, so that 我能一眼比较它们的状态。

#### Acceptance Criteria (EARS)

1. THE 行模型 selector SHALL 将委托子智能体与内部 SUB 归一为同一行结构。
2. THE 行模型 selector SHALL 为每行标记其可执行的操作集合。
3. WHERE 一行来源于内部 SUB, THE 行模型 selector SHALL 将取消与 Open in Tab 标记为不可用。
4. WHERE 一行缺少 agent 类型, THE 行模型 selector SHALL 提供一个中性的占位标识而不是空白。
5. THE 行模型 selector SHALL 为每行独立赋予一个会话归属维度取值，取值域为：当前会话、其他会话、未归属。
6. THE 行模型 selector SHALL 为每行独立赋予一个生命周期维度取值，取值域为：运行中、已静默、已完成、已取消、失败。
7. THE 行模型 selector SHALL 按「生命周期优先于会话归属」的固定优先级将两个维度投影为唯一展示分区。
8. WHERE 一行的生命周期为运行中或已静默, THE 行模型 selector SHALL 按其会话归属投影至「当前会话」或「其他会话」或「未归属」分区。
9. WHERE 一行的生命周期为已完成、已取消或失败, THE 行模型 selector SHALL 无论其会话归属一律投影至「已完成」分区。

> **A2 修正说明（R1 评审）**：初稿把「会话归属」（当前/其他/未归属）与「生命周期」（已完成）压进单值四分区枚举，而二者正交 —— 一个已完成任务同时属于某个会话，初稿未定义它该进哪个分区，导致 selector、排序、计数与属性测试都无唯一正确解。修正为两个独立维度 + 一条显式投影优先级（生命周期优先）。

### Requirement 5: 常驻入口

**User Story:** As a codeg 用户, I want 一个不随子智能体跑完而消失的入口, so that 我随时能打开面板而不必滚动消息流。

#### Acceptance Criteria (EARS)

1. THE 子智能体常驻条 SHALL 以**整个工作区**的委托子智能体与内部 SUB 的并集作为其观察集合。
2. WHILE 工作区观察集合非空, THE 子智能体常驻条 SHALL 保持可见。
3. WHILE 工作区观察集合为空, THE 子智能体常驻条 SHALL 不渲染。
4. WHILE 观察集合中存在运行中条目, THE 子智能体常驻条 SHALL 显示运行中条目数并呈现活动指示。
5. WHILE 观察集合非空且无运行中条目, THE 子智能体常驻条 SHALL 保持可见、停止活动指示、并显示可观察条目总数。
6. THE 子智能体常驻条 SHALL NOT 将已静默的内部 SUB 计入已完成数。
7. WHERE 工作区内仅有内部 SUB 而无委托子智能体, THE 子智能体常驻条 SHALL 保持可见并计入这些内部 SUB。
8. WHEN 用户激活子智能体常驻条, THE 观察面板 SHALL 打开。
9. WHERE 子智能体常驻条与后台任务横幅同时可见, THE ConversationShell SHALL 以固定顺序垂直排列两者。

> **C2 处置（R3 评审 P0 · 采纳评审推荐的方案二）**：评审指出「其他会话折叠段」与「入口仅当前会话非空才出现」直接冲突 —— 当前会话为空而其他会话在跑时，那个折叠段永远不可达；且 design D3 的「只展示当前会话条目」与 R6.2 也矛盾。**指认成立**。
>
> 用户 2026-08-03 拍板：**面板是工作区级观察面板**。入口存在条件改为「工作区观察集合非空」（R5.1-R5.3），当前会话不再是入口的存在条件，只作为清单内的排序与默认展开优先级（R6.1）。这也与底层一致 —— 两个 Provider 本就挂在工作区级（见 A7 处置），此前的「会话级入口」是我给工作区级数据强加的会话级边界。
>
> **C3 的计数悖论一并解决**：R5.5 原写「无运行中时显示已完成数」，但内部 SUB 只有「运行中 / 已静默」两态、永不进入已完成，故仅有静默 SUB 时会出现「入口可见但数字为 0」。改为显示**可观察条目总数**，并显式禁止把已静默计入已完成（R5.6）。

> **A1 修正说明（R1 评审）**：初稿的 R5.1「WHILE 存在未完成的委托子智能体才显示」与「永不消失」「已完成分区」「覆盖内部 SUB」三项承诺互相矛盾 —— 内部 SUB-only（正是用户截图场景）与「全部跑完后回看」两种情形下入口都不出现，面板不可达。修正为「观察集合非空即可见」，把入口可见性与运行态解耦。用户 2026-08-03 拍板：跑完后入口变安静但保留。

## 能力分类（§0.17 · 逐项业务现实判定）

> **B9 处置（R2 评审 P1 · 采纳）**：分类原先只落在侦察报告里，spec 自身缺论证。评审指出「外部侦察报告不能替代被审 spec 自身的业务现实论证」——成立，补于此。

| 能力 | 真实场景 | 缺失的用户损失 | 分类 |
|---|---|---|---|
| 两个 Provider 只读投影 + 行模型 selector | 用户想知道当前有哪些子智能体在跑 | 无法列表，只能靠会被新回复清空的悬浮层 | **A** |
| 常驻条（含跑完后保留） | 用户跑完想回看刚才那几个子智能体做了什么 | 入口消失，回到「往上滚消息流」的原始痛点 | **A** |
| 清单载体 + 四分区 | 同上 | 无 | **A** |
| 用户侧取消（含 broker 归属修复） | 发现子智能体跑错方向要停掉，不想等它烧完 token | 真实 token 与时间损失；且不修归属则按钮恒定无效 | **A** |
| 委托消息摘要就地展示 | 用户想瞄一眼在做什么而不开弹窗 | 每次判断都要开一次完整查看器 | **A**（用户 2026-08-03 明确选择保留） |
| 内部 SUB 会话归属 + 未归属分区 | 多会话并行时不把别的会话的 SUB 混进当前列表 | 列表不可信 | **A** |
| 横幅分类上报 | 用户看到横幅数字时能判断它数的是什么 | 数字无法解读（派 2 个委托显示 0、跑 1 个构建显示 1） | **B**（用户 2026-08-03 明确选择保留细分） |
| 取消幂等与竞态契约 | 双击、取消与自然完成交错 | 状态错乱、误报失败 | **B** |
| 内部 SUB 淘汰计数提示 | 条目静默消失时用户知道原因 | 误以为任务结束或数据损坏 | **B** |
| 委托绑定条目上限 | 长工作区会话下不无界增长 | 内存持续增长 | **B** |
| 投影引用稳定 | —— | **无法陈述用户损失** | **D → 已从 AC 删除**（见 R2.10 处置） |
| 让横幅数字与面板条数相等 | —— | 语义上本不该相等 | **D → 不做**（D4） |
| 载体的容器无关抽象 | —— | 属实现建议 | **D → 不写入 AC**（仅记于 design.md D5 作为实现指引） |

### Requirement 5A: 后台任务横幅的口径分离

**User Story:** As a codeg 用户, I want 横幅的数字能被我正确解读, so that 我不会把它误当成我派出的子智能体数。

> **B6 处置（R2 评审 P1 · User Story 修正 + 范围保留）**：评审指出原 User Story「与点开清单对得上」与 AC「横幅不统计委托」自相矛盾 —— **成立**，已改为「数字能被正确解读」（横幅与面板本就是两套账，不追求相等，见 D4）。
>
> 评审同时建议「本轮停止分类 wire 改造、只改文案」。此建议**不采纳**：用户 2026-08-03 在明确知晓「要动 5 处、且数字仍永远不等于面板条数」的前提下，仍选择保留后端分类上报，理由是需要「内置子智能体 / 后台命令」的细分信息。故该项按 **B 类**（口径可解读性）保留，而非评审判定的 D 类。分类依据见上方能力分类表。

#### Acceptance Criteria (EARS)

1. THE BackgroundWatcher SHALL 在 `BackgroundActivity` 事件中按 `TaskEntry.kind` 分别报告内置异步子智能体数与后台 shell 任务数。
2. THE 后台任务横幅 SHALL 分别呈现内置异步子智能体数与后台 shell 任务数。
3. THE 后台任务横幅 SHALL NOT 将委托子智能体计入其任一计数。
4. WHERE 分类计数的某一类为零, THE 后台任务横幅 SHALL 省略该类的表述。

> **口径事实（侦察 + UI 设计卡双向确证）**：`background_watch.rs:673` 的 `self.tasks.len()` 统计 Claude CLI 自身 transcript 的内置异步 sub（`agentId`）与后台 shell（`backgroundTaskId`）；委托子智能体走 broker 事件，**完全不在此计数内**。故派 2 个 codex 委托时横幅显示 0，跑 1 个 `pnpm build` 时横幅显示 1 而子智能体清单为空。`TaskEntry.kind`（`background_watch.rs:325-328`）已存在但不出墙。用户 2026-08-03 拍板：让后端分类上报，横幅分开说明。
>
> 这**不是**要求横幅数字与观察面板条数相等（二者是不同任务池，语义上本就不该相等），而是要求横幅自身的数字可被正确解读。

### Requirement 6: 清单与就地详情

**User Story:** As a codeg 用户, I want 在面板里直接看到每个子智能体在做什么, so that 我不必逐个打开会话。

#### Acceptance Criteria (EARS)

1. THE 观察面板 SHALL 将当前会话的行直接展开列出并置于清单顶部。
2. THE 观察面板 SHALL 将其他会话的行收进一个可展开的折叠段并显示其计数。
3. THE 观察面板 SHALL 将已完成的行置于独立分区。
4. THE 观察面板 SHALL 为「其他会话」与「已完成」分区中的每一行呈现其所属会话标识。
5. WHILE 观察面板处于打开状态且存在内部 SUB 条目, THE 观察面板 SHALL 按固定间隔重新求值行模型以推进静默判定。
6. WHILE 观察面板关闭或无内部 SUB 条目, THE 观察面板 SHALL 停止该重新求值。
7. THE 子智能体常驻条 SHALL 在面板关闭时仍按同一间隔更新其运行中计数。
8. WHEN 用户选中一个内部 SUB 行, THE 观察面板 SHALL 就地展示该条目已缓存的帧内容。
9. WHEN 用户选中一个委托行, THE 观察面板 SHALL 就地展示该子会话最近一条助手消息的摘要。
10. THE 观察面板 SHALL 经既有的会话详情读取接口获取该摘要，且不新增后端端点。
11. THE 观察面板 SHALL 仅在用户选中某行时才为该行发起摘要请求。
12. WHILE 一个委托行的子会话摘要正在加载, THE 观察面板 SHALL 显示加载态。
13. IF 一个委托行的子会话摘要加载失败, THEN THE 观察面板 SHALL 显示错误态并提供重试入口。
14. WHEN 用户在一个摘要请求在途期间切换选中行, THE 观察面板 SHALL 丢弃该在途请求的结果。
15. THE 观察面板 SHALL 为委托行提供跳转至完整子会话的入口，而不在面板内加载完整历史。
16. IF 一行没有可展示的消息内容, THEN THE 观察面板 SHALL 显示一条说明该状态的提示文本。
17. WHERE 清单中没有任何行, THE 观察面板 SHALL 显示空态文本。

> **C3 处置（R3 评审 P1 · 采纳）**：评审指出 `now` 作为显式入参只解决了纯函数可测性，**没有定义无新帧时由谁触发重算** —— 若页面无其他渲染，内部 SUB 永远不会转「已静默」。**指认成立**。
>
> 补 R6.5-R6.7 定唯一调度者与停表条件：面板打开且有内部 SUB 时按固定间隔重算；面板关闭或无内部 SUB 时停表（避免空转）；常驻条的运行中计数在面板关闭时仍需更新（否则数字会僵住）。间隔取值属实现细节，与静默阈值同量级即可。
>
> 计数悖论部分见 R5 的 C2/C3 合并处置。

> **B7 处置（R2 评审 P1 · 保留能力 + 补齐评审指出的接口缺口）**：评审指出摘要新增了第二条读取路径却未定义接口、也未说明为何不直接开既有 Dialog，且判为 D 类。
>
> **能力保留**：用户 2026-08-03 在知晓「要多一条读取通道 + 三态、且完整查看器仍需保留」的前提下，明确选择「面板内先显示一条摘要」，理由是不想为瞄一眼就开弹窗。故按 **A 类**保留。
>
> **但评审的接口缺口指认成立**，本轮补齐：摘要走**既有**会话详情读取接口（`getFolderConversation`，即 `useDelegatedSubSession` 已在用的那条，`use-delegated-sub-session.ts:83`），**不新增后端端点**（R6.10）；改为选中时才请求而非列表渲染即请求（R6.11），避免为每行预取；并定义切换选中行时丢弃在途结果（R6.14），避免竞态写入错行。
>
> 这样「第二条读取路径」实际是既有接口的一个更浅的消费方式，不引入新的后端契约，缓存一致性问题也随之消失（每次选中重新取，不做跨选中缓存）。

> **A6 修正说明（R1 评审 · 部分采纳）**：评审指出「就地展示消息内容」对委托行没有数据来源 —— 委托绑定只有元数据，帧流只存在于内部 SUB。此指认成立。
>
> 修正为按来源区分详情深度：内部 SUB 有现成帧缓存（`buildSubagentTranscriptView`），可直接就地渲染；委托行的完整历史在子会话 DB 里，面板**不**加载完整历史（那是 `SubAgentSessionDialog` 与 Open in Tab 的职责），只展示一条最近助手消息摘要，并显式定义加载/失败/重试三态。这样「就地详情」对两类都有确定的数据来源，且不把面板做成第二个会话查看器。
>
> 评审同一条目下关于「载体未定稿」的部分不采纳：spec 流程要求 tasks.md 在评审通过后才创建，D5 待设计卡属于流程内的正常待定状态，非设计缺失。载体已于本轮定稿（见 design.md D5）。

### Requirement 7: 行操作

**User Story:** As a codeg 用户, I want 对子智能体执行取消或跳转, so that 我能干预它而不只是旁观。

#### Acceptance Criteria (EARS)

1. WHEN 用户对一个运行中的委托子智能体确认取消, THE 系统 SHALL 以其 `child_conversation_id` 请求后端取消。
2. WHILE 一个取消请求在途, THE 观察面板 SHALL 在该行显示取消进行中的状态。
3. WHEN 用户对一个委托子智能体请求 Open in Tab, THE 系统 SHALL 打开其子会话标签页。
4. WHERE 一行的操作集合中某项不可用, THE 观察面板 SHALL 以肯定性的只读标识说明该行的能力边界。
5. THE 观察面板 SHALL 在上下文菜单中仅列出该行操作集合内的可用项。
6. WHILE 一个取消请求在途, THE 观察面板 SHALL 阻止对同一行发起第二个取消请求。
7. THE 观察面板 SHALL 以 `delegation_completed` 与 `delegation_session_update` 事件流作为委托行生命周期的唯一真源。
8. THE 观察面板 SHALL NOT 以取消请求的响应体更新该行的生命周期取值。
9. WHEN 取消请求返回的报告状态为已取消、已完成或失败, THE 观察面板 SHALL 清除该行的取消在途标记并将该请求视为已受理。
10. IF 取消请求以传输错误结束, THEN THE 观察面板 SHALL 清除该行的取消在途标记、显示请求失败提示、并保留该行由事件流决定的生命周期取值。
11. WHEN 一个取消请求返回终态报告而该行的事件流尚未到达对应终态, THE 观察面板 SHALL 触发一次该任务的权威状态查询以对账。
12. WHEN 传输层从断线恢复, THE 观察面板 SHALL 对其仍显示为运行中的委托行触发一次权威状态查询。
13. THE 观察面板 SHALL 以该权威状态查询的结果更新行的生命周期取值。

> **C4 处置（R3 评审 P1 · 采纳最小恢复路径）**：评审指出把「单一真源」等同于「单一瞬时推送通道」的缺陷 —— 若服务端已取消而终态事件在断线期间丢失，前端会清掉在途标记后**长期显示运行中**，且重连快照（`active_delegations`）只含运行中任务，无法为旧行补终态。**指认成立，这是我 B2 修法的漏洞**。
>
> 采纳评审明确建议的最小方案，**不引入事件溯源**：两个对账触发点 —— ① 取消返回终态但事件未到时查一次（R7.11）；② 断线恢复后对仍显示运行中的行查一次（R7.12）。查询复用既有 `get_delegation_status`（该通道正是 R1 要修 `classify_locked` 归属口径的那条，两处改动因此互相支撑）。
>
> 这保持了「事件流是常态真源」，只在**事件可能丢失的两个已知窗口**补一次拉取，符合 broker 自身注释所述「查询才是状态真源」（`acp/types.rs` DelegationSessionUpdate 段）。

> **B2 处置说明（R2 评审 · 采纳，但比评审建议更简单）**：评审指出「取消命令响应」与「观察投影事件」被同时称为 broker 真源，却未定义二者冲突时谁覆盖谁，可能形成双真源。
>
> 代码核查后结论是**取消响应本就不该参与行终态**：`teardown_canceled_child`（`broker.rs:4655`）在取消时会经 `:4681` 的 `emit_completed_if_real` 发出 `DelegationCompleted{ result: Err{ error_code: "canceled" } }`（`turn_version <= 1` 时；续聊轮改发 `emit_session_update_for_settled_turn`）。故事件通道**已经是**单一权威状态流，`DelegationProvider` 收到即翻终态（`delegation-context.tsx:192-226`）。
>
> 因此不采纳评审建议的「为两条流引入单调版本或权威排序键」—— 那是为不存在的第二个状态源做仲裁。改为显式规定：响应只负责「清除在途标记 + 报告请求是否被受理」，生命周期一律由事件流决定（R7.7-R7.10）。
>
> **R3 C4 指出此修法的漏洞**：事件丢失时无恢复路径。已按其建议补两个对账触发点（R7.11-R7.13），见上方 C4 处置。

> **F2 补充说明（R1 评审 P1 · 采纳）**：初稿只定义单次顺序取消，未覆盖双击、取消与自然完成交错、响应乱序。R7.6-R7.10 补齐幂等与竞态契约；其中「谁是终态真源」这一核心问题由上方 B2 处置最终定为「事件流唯一」。
>
> **R7.4 改法说明**：初稿写「呈现为禁用并说明原因」，但 disabled 的语义是「稍后可用」，用户会反复尝试并当作 bug（UI 设计卡指出这一点）。改为肯定性的只读标识 + 菜单里该项直接不存在（R7.5）——菜单的可用项集合本身即能力披露。

### Requirement 8: 用户侧取消的传输通道

**User Story:** As a codeg 用户, I want 取消能力在桌面模式与服务器模式下都可用, so that 我在任一部署形态下体验一致。

#### Acceptance Criteria (EARS)

1. THE `cancel_delegation_core` SHALL 接受 `child_conversation_id` 并经 `resolve_delegation_target` 解析出 `task_id` 与 `parent_conversation_id`。
2. IF `resolve_delegation_target` 判定目标不存在, THEN THE `cancel_delegation_core` SHALL 返回 `unknown_target_report`。
3. IF `resolve_delegation_target` 判定目标不是子会话, THEN THE `cancel_delegation_core` SHALL 返回 `not_a_subsession_report`。
4. WHERE `tauri-runtime` feature 启用, THE 系统 SHALL 将取消暴露为一个已注册的 Tauri command。
5. WHERE `tauri-runtime` feature 未启用, THE 系统 SHALL 将取消暴露为一条 HTTP 路由。
6. THE 前端 API 客户端 SHALL 通过既有 transport 抽象调用取消，且不新增 transport 层登记。
7. THE 取消 HTTP 路由 SHALL 与既有 delegation 路由使用同一认证中间件。
8. THE 取消 HTTP 路由 SHALL 返回与既有 delegation 路由同构的 `DelegationTaskReport` 响应体。

> **C6 处置（R3 评审 P1 · 部署边界已由产品确认）**：评审要求把「仅单一可信操作者」写成明确的上线边界，而非由「当前无租户模型」推导。**要求合理**。
>
> 用户 2026-08-03 确认：**服务器模式按单人使用支持**，访问令牌等同于「该实例的钥匙」。据此：
>
> **支持的部署边界**：单一可信操作者持有 `CODEG_TOKEN` 的桌面模式与服务器模式。
> **明确不支持**：多名操作者共享同一 `CODEG_TOKEN`。该形态下任一操作者可取消他人派出的子智能体 —— 这是既有架构的信任域属性（`web/auth.rs:22-30` 单一全局 Bearer 比对，无 principal / account / tenant），由既有三条用户侧 delegation 通道共同确立，本需求沿用同一口径而未引入新弱点。
> **未来若要支持多操作者**：需一次独立的授权主体改造，覆盖全部四条用户侧 delegation 通道（continue / close / availability / cancel），不能只改取消这一条；届时应立 ADR。

> **A5 处置说明（R1 评审 · P0 降级为已知边界）**：评审指出「用目标自身的 `parent_conversation_id` 与 broker 记录比对」证明的是「目标数据自洽」而非「调用方拥有目标」，这个命题**成立**。
>
> 但影响面经代码核查后判定被高估：认证是**单一全局 Bearer token**（`web/auth.rs:22-30` 比对一个 `CODEG_TOKEN`），全仓无 principal / account / tenant 概念，桌面模式是本机进程。即当前部署形态是**单用户信任域**，不存在「另一个用户」这一主体，故不存在跨用户越权路径。
>
> 且此信任域假设是既有架构的，由 `continue_delegation` / `close_delegation_session` / `get_continuation_availability` 三条既有用户侧通道共同确立 —— 本需求的取消通道沿用同一口径，**未引入新的授权弱点**。
>
> 处置：不在本需求内引入 principal 传递（那是跨越三条既有通道的架构变更，属独立议题）。明确记录为已知边界：**多租户部署需要一次独立的授权主体改造，覆盖全部四条用户侧 delegation 通道**。本需求只保证与既有通道口径一致（R8.7）。

### Requirement 9: 国际化完整性

**User Story:** As a 非英语用户, I want 面板文案在我的语言下完整, so that 我能正常使用。

#### Acceptance Criteria (EARS)

1. THE 系统 SHALL 为本需求新增的每个文案 key 在全部 10 个 locale 文件中提供取值。
2. THE 系统 SHALL 使各 locale 文件的 key 集合保持完全相等。
