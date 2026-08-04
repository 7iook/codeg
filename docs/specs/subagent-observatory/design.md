---
# ═══ CORE IDENTITY ═══
slug: subagent-observatory
title: 常驻子智能体观察面板（委托 + 内部 SUB 统一观察） · 设计
# ═══ LIFECYCLE ═══
status: implemented
review_rounds_done: 3
last_review_status: APPROVED
last_review_p0: 0
implementation_review_rounds: 2
implementation_review_status: NEEDS_CHANGES_ADDRESSED
shipped_branch: feat/obs-p3-panel
created: 2026-08-03
last_updated: 2026-08-03
shipped_commit: null
# ═══ RELATIONSHIPS ═══
related_adrs: []
related_specs: [delegation-continue-session, delegate-persona-passthrough]
supersedes: null
superseded_by: null
rca: null
# ═══ DISCOVERY ═══
tags: [delegation, subagent, observability, ui, broker, cancel]
domain: agent-runtime
one_line: 给委托子智能体与 Claude 内置 SUB 加一条常驻指示条与清单面板，让用户不滚消息流就能看到谁在跑并能就地取消；顺带修掉 cancel_task_by_id 对用户侧恒返 unknown 的归属校验缺陷。
---

# Design · 常驻子智能体观察面板

## Overview

四层交付，按依赖递进：**归属修复**（`cancel_task_by_id` 补 D5 回退，否则取消恒不可用）→ **只读投影**（两个 Provider 开 `list()` 读口 + 内部 SUB 补会话归属）→ **取消全链路**（`_core` / Tauri command / HTTP 路由 / api.ts）→ **入口与载体**（子智能体常驻条 + 清单面板 + 就地详情 + 行操作 + i18n）。

核心权衡摆在前面：**本面板观察的两类对象，字段能力天然不对等，设计不掩盖这一点**。委托子智能体有 agent 类型、独立会话、可取消、可跳转；Claude 内置 SUB 只有帧流，没有独立会话 id、不可取消、不可跳转。行模型为此显式携带「可执行操作集合」，UI 把不可用项呈现为禁用并说明原因，而不是假装两类一致（见 Decision D2）。

第二个权衡：**不追求让常驻条与既有后台任务横幅的数字对齐**。二者是两个独立任务池（委托 broker vs Claude CLI 自身 transcript），语义上本就不该相等（见 Decision D4）。

> ⚠️ **本段初稿写的「零后端契约改动」已不成立**（用户 2026-08-03 拍板保留后端分类上报后）。实际交付含**两处向后兼容的 wire 扩展**：`AcpEvent::DelegationStarted` / `DelegationCompleted` 增 `parent_conversation_id`，`AcpEvent::BackgroundActivity` 增两个分类计数（均 `serde(default)`，旧消费方退化为原语义）；另新增两条用户侧命令通道（cancel / status）。准确表述见下方 Data Models 段末。

## Current-State Inventory (from recon — 侦察报告 §2/§5/§6)

> 基线 `feat/kiro-agent` @ `b857f78d`。完整锚点见
> `.agent-workspace/.archive/2026-08-03/subagent-observatory/subagent-observatory-recon.md`。
> 行号取自侦察实测；后续 rebase 会漂移，按符号名定位。

### ✅ 存在且可直接复用

| 能力 | 位置 | 复用方式 |
|---|---|---|
| 后端 running 委托集 | `acp/session_state.rs:293` `active_delegations: BTreeMap<String, ActiveDelegationState>`；`:1096` insert、`:1118` remove、`:974` TurnComplete 故意不清空 | 直接读，**无需新建后端能力** |
| 该集合已出墙 | `session_state.rs:1459` 进快照、`:1535` wire 字段 | 已在线上 |
| 前端已消费该快照 | `src/lib/delegation-seed.ts:22-41` `buildDelegationSeedEnvelopes` 回放成 `delegation_started` 事件；三处调用 `acp-connections-context.tsx:3916 / 4289 / 4613` | DelegationProvider 的 map 本就被 seed 填满 |
| 委托绑定全量 map | `contexts/delegation-context.tsx:76-78` `byToolUseId: Map<string, DelegationBinding>` | 加只读投影是纯增量 |
| 绑定字段齐备 | `delegation-context.tsx:39-53`：`agentType` / `task` / `taskId` / `status`(running\|ok\|err) / `errorCode` / `childConversationId` / `childConnectionId` / `parentConnectionId` | 行模型所需字段基本齐备 |
| 完成后绑定不删 | `delegation-context.tsx:192-226` `delegation_completed` 只翻 `status`，条目保留 | 「已完成分区」的数据基础 |
| 内部 SUB 帧 map | `contexts/subagent-transcript-context.tsx:108` `framesRef`；上限 `:100` `MAX_TRACKED_SUBAGENTS = 64` oldest-first | 加只读投影 |
| 内部 SUB 帧视图 | `lib/subagent-transcript.ts:29-40` `buildSubagentTranscriptView`（`messageCount` / `toolCount` / `tailText`） | 就地详情直接复用 |
| 内部 SUB 渲染组件 | `components/message/subagent-transcript.tsx` | 就地详情直接复用 |
| external id → conversationId | `stores/conversation-runtime-store.ts:3163` `getConversationIdByExternalIdFromStore`；先例 `acp-connections-context.tsx:3283`（含「解析失败 = 该会话在本客户端从未打开过」语义） | 内部 SUB 会话归属照此调用 |
| 归属校验正确样板 | `acp/delegation/broker.rs:5019-5026` `continue_delegation` 的 D5 `owned` 判定 | R1 照抄此模式 |
| 取消实现主体 | `broker.rs:4881-4918` `cancel_task_by_id` + `drain_and_record_canceled` + `:4906` `teardown_canceled_child` | 逻辑可用，仅归属判定要修 |
| 目标解析 | `commands/delegation.rs:235-253` `resolve_delegation_target`（入参 `child_conversation_id` → `task_id` + `parent_conversation_id`） | 用户侧取消复用，D5 口径统一 |
| 用户侧通道三分支样板 | `commands/delegation.rs:307-334` `continue_delegation_core`；`:257-275` `unknown_target_report`、`:279-301` `not_a_subsession_report` | `cancel_delegation_core` 照抄 |
| 行样式语汇 | `components/chat/sub-agent-overlay.tsx:136-164`（AgentIcon 圆底 + 粗体名 + `#taskId` 前 8 位 + StatusBadge + 灰色截断任务文本） | 清单行沿用 |
| 状态徽标 | `components/message/delegation-status-badge.tsx` `StatusBadge(status, errorCode)` | 直接复用 |
| 子会话查看器 | `components/message/sub-agent-session-dialog.tsx`（含 Open in Tab `:397-411`、续聊、三类阻塞卡） | 「放大」入口复用 |
| 常驻条挂载位 | `components/conversations/conversation-detail-panel.tsx:1727-1737` `ConversationShell` 的 `topBanner`，`contextKey={tabId}` | 子智能体常驻条同位挂载 |

### ❌ 不存在（须新建）

| 项 | 位置 | 说明 |
|---|---|---|
| 委托绑定 `list()` 投影 | `contexts/delegation-context.tsx:56-59` | 现仅 `findByParentToolUseId` / `findByChildConversationId` 两个点查 |
| 内部 SUB `list()` 投影 | `subagent-transcript-context.tsx:50-53` | 现仅 `getFrames(id)` / `subscribe(id)` |
| 内部 SUB 的 `session_id` 保留 | `subagent-transcript-context.tsx:169-188` `handleEnvelope` | 事件带 `session_id`（`acp/types.rs:102-106`，测试 fixture `subagent-transcript-context.test.tsx:46-53` 可见），当前只取 `parent_tool_use_id` + `message`，**`session_id` 被丢弃** |
| 行模型归一 selector | 新 `src/lib/observed-sub-agents.ts` | 无现存聚合 selector（侦察 §3.3 已确证）。近亲 `extractDelegationSources`（`message-list-view.tsx:215`）作用域是单条回复，不移动 |
| 子智能体常驻条 | 新组件 | 委托池计数 + 可点 |
| 清单载体 + 四分区 | 新组件 | 当前会话 / 其他会话折叠 / 已完成 / 未归属 |
| 用户侧 cancel 全链路 | `commands/delegation.rs`（`_core` + Tauri 包装）、`lib.rs:1122-1126` 注册、`web/router.rs:59-79`、`web/handlers/delegation.rs`、`src/lib/api.ts` | 现有四条用户侧通道为 settings/continue/close/availability，**无 cancel** |
| `cancel_task_by_id` 的 D5 归属回退 | `broker.rs:4884` + `:4893` | **前置阻塞项**，详见 Corrected Goal |

## Corrected Goal (draft-vs-reality — from recon)

| 初始假设 | 代码现实 | 修正 |
|---|---|---|
| 顶部横幅「N 个后台任务运行中」可作为子智能体入口，其计数即子智能体数 | 该计数 = `background_watch.rs:673` 的 `self.tasks.len()`，统计 Claude CLI **自身 transcript** 里的 async agent（`agentId`）+ 后台 shell（`backgroundTaskId`），模块头 `:14-16` 明写这些字段 "exist ONLY on disk, never on the wire"；而 codeg 委托走 delegation broker（`task_id`/`child_conversation_id`）。**两个独立任务池** | 放弃复用该横幅作入口。**另起一条属于委托子智能体的常驻条**，计数取自委托池；原横幅保留、仅改文案明确口径（用户 2026-08-03 拍板） |
| 混算两类只是显示瑕疵，改后端加 `kind` 分类即可对齐 | `kind` 字段存在于后端 `TaskEntry`（`background_watch.rs:325-328`）但**从不出墙**；`AcpEvent::BackgroundActivity`（`acp/types.rs:307-319`）只带 `outstanding: u32`。要分辨须改 6 处契约传播，且对齐后语义上仍不该相等 | 判为 D 类技术整洁，**本轮不做**。改为两条各自措辞明确口径（Decision D4） |
| 侧边栏会话行旁的数字是「运行中子会话数」，可复用作运行态指标 | `fill_child_counts`（`db/service/conversation_service.rs:437-472`）过滤条件仅 `ParentId.is_in(ids)` + `DeletedAt.is_null()`，**无任何 status 过滤**；`models/conversation.rs:46-51` 明写其用途是侧边栏 chevron | 不复用。本面板自建运行态口径（`active_delegations` / binding status）。侧边栏本轮不动（用户拍板） |
| 「已完成分区」可复用 `active_delegations` | 该集合 running-only，`session_state.rs:1118` 完成即 remove | 已完成态**前端自留**（DelegationProvider binding 完成后仍保留，`delegation-context.tsx:192-226`） |
| 「已完成分区」可复用 `task-context` | `contexts/task-context.tsx:92-103` 的 `updateTask` 在 `completed`/`failed` 时 dispatch `remove` —— **完成即删除**，与「保留到会话关闭」直接冲突；其 4 个 `addTask` 调用点均为短命进度条语义（导出图片/切分支/连接生命周期） | 不复用，避免造第二真源并改坏既有 4 个调用点 |
| upstream v0.23.0 的 Task Board 可能已覆盖本需求 | `src/components/tasks/`（10 文件）+ `commands/work_task.rs` 是 DB 持久化工单看板，四列 `todo/inProgress/attention/done`（`board-columns.ts:1-11`），动作为 merge/return/abandon/worktree 合并，独立页面非常驻 | 另一个域（人给 agent 派工单并验收），不构成重复。已查 upstream 全部 remote 分支与 PR 两页，**无人做过本需求** |
| `cancel_task_by_id` 可直接接到用户侧 | 两处归属判定（`broker.rs:4884`、`:4893`）**只做 `parent_connection_id` 字符串相等**，`parent_conversation_id` 参数仅用于最后 DB 兜底；而用户侧一律传合成常量 `USER_ENTRY_CONNECTION_ID = "user-entry"`（`commands/delegation.rs:215`），broker 自身注释 `:4161` / `:13394` 明写该 id "never resolves" | **前置阻塞项**：先补 D5 归属回退（照抄 `:5019-5026`）。不补则取消对所有 LLM 派发任务恒返 `unknown`，而 mock 掉 broker 的单测会全绿（E-052 形状） |
| 载体选 AuxPanel 新 tab 即可 | 需改 11 处（侦察 §5.1），其中 `resolveAuxTabView`（`aux-panel.tsx:107-114`）在非 folder 场景**无条件塌成 `session_details`**，而本面板在 chat 模式必须可用；绕法需把 folder 门控从二值改为按 tab 分类并重写 `aux-panel.test.tsx` 五个断言 | 载体决策见 Decision D5（待 UI 设计卡返回后定稿） |

## Decision Record

| 字段 | 值 |
|---|---|
| Reviewer | codex（默认） |
| 决策日期 | 2026-08-03 |
| 侦察报告 | `.agent-workspace/.archive/2026-08-03/subagent-observatory/subagent-observatory-recon.md` |
| UI 设计卡 | `.agent-workspace/.archive/2026-08-03/subagent-observatory/subagent-observatory-ui-design-card.md`（生成中） |
| 用户拍板记录 | 范围（当前会话优先+其他折叠）/ 生命周期（跑完保留至会话关闭）/ 交付一次做全 / 入口=另起子智能体常驻条、侧边栏不动 |

### D1 · 先修 `cancel_task_by_id` 的归属校验，再接用户侧通道

**选择**：把 `cancel_task_by_id`（`broker.rs:4890` / `:4896`）与 `classify_locked`（`:1933` / `:1939`）四处 `parent_connection_id` 严格相等，统一改为 `continue_delegation`（`:5030`）已有的 D5 口径：`parent_conversation_id` 有值则比它，否则回退比 `parent_connection_id`。`classify_locked` 需增加一个 `parent_conversation_id: Option<i32>` 形参，由唯一调用点 `get_tasks_status`（`:4765`）透传其既有同名参数。

**同根变体扫描（§5.3 · 本轮一并根治）**：缺陷指纹 =「用户侧合成连接 id 遇上只比 `parent_connection_id` 的归属判定」。全仓 `git grep "parent_connection_id =="` 命中 11 处，其中用户侧可达的三处：

| 位置 | 状态 | 处置 |
|---|---|---|
| `continue_delegation` `:5030` | ✅ 已治（D5 口径的来源） | 不动，作为照抄样板 |
| `cancel_task_by_id` `:4890` / `:4896` | ⛔ 未治 · 写操作 · 用户点取消恒 `unknown` | R1.1-R1.5 |
| `classify_locked` `:1933` / `:1939` | ⛔ 未治 · 读操作 · 经 `get_tasks_status`（`:4733`）/ `get_task_status`（`:4705`）暴露 | R1.6-R1.7 |

其余 8 处（`:943` / `:963` / `:1168` / `:1203` / `:1213` / `:4572` 等）位于 setup 登记与父连接批量清理路径，调用方持有真实连接 id、不经用户侧合成常量，**不在指纹半径内**，本轮不动。

**为何 `classify_locked` 也必须本轮修**：它与 cancel 同为「签名已携带 `parent_conversation_id` 却未使用」的形状（`get_tasks_status` 有该参数但 `:4765` 调用 `classify_locked` 时未透传）。目前只有 LLM 通道消费它（传真实连接 id 故未暴露），但本面板一旦扩展到「显示某任务的权威状态」就会踩同一坑。§4.8 要求同根变体同一交付内清掉，而非等下次踩到。

**理由**：用户侧四条既有通道全部传合成常量 `USER_ENTRY_CONNECTION_ID`，broker 自身注释两处（`:4161`、`:13394`）明写该 id "never resolves"。仓库已在 `emit_session_update`（`:13390-13396` 测试注释）与 `continue_delegation` 两处治过同一病根，**cancel 分支是遗漏而非故意**。

**史料确证**（§2.6② 改既有功能先读史）：`git log -S"Ownership (D5)"` 定位到唯一引入 commit `2505e164`（"feat(delegation): continuable sub-agent sessions with user entry point"，即 `delegation-continue-session` spec 的交付）。同一 commit 内：① 为 `continue_delegation` 写了 D5 `owned` 判定；② 新增两个 `cancel_task_by_id` 测试且都传 `Some(1)` 作 `parent_conversation_id`（证明该参数当时已加进 cancel 签名）；③ 但未在 cancel 的归属判定里使用它。**参数加了、用法漏了** —— 典型 §5.3 同根变体漏扫，非设计取舍。因此照抄 `:5019-5026` 无违背原意图之虞。

**否决的替代**：
- 让用户侧传真实 `parent_connection_id` —— 用户侧没有连接上下文，这正是 `USER_ENTRY_CONNECTION_ID` 存在的原因；
- 在 `cancel_delegation_core` 里绕过归属校验直接调 broker 内部 —— 破坏封装且失去越权保护。

**风险**：这是改既有功能，须先读 git history 确认原意图（§2.6②）。归属判定放宽后必须保留「判定不通过 → `unknown_report` 不泄露存在性」的语义（R1.4）。

### D2 · 行模型显式携带「可执行操作集合」，不假装两类对等

**选择**：`ObservedSubAgentRow` 带一个能力标记（可取消 / 可跳转 / 可查看详情），由来源类型决定取值；UI 以**肯定性的只读标识**说明能力边界，且上下文菜单中直接不列出不可用项（R7.5-R7.6）。

**为何不用 disabled 灰按钮**（UI 设计卡指出）：`disabled` 的语义是「稍后可用」，用户会反复点击并当作 bug —— 那正是本需求要治的病（「它们是点不动的」），不能在新面板里换个形式复现。菜单的可用项集合本身即能力披露。

**理由**：内部 SUB 只有 `parent_tool_use_id`，没有 `child_conversation_id`、没有 ACP 寻址，**物理上无法取消也无法 Open in Tab**。若 UI 不加区分，用户会把「点了没反应」当成 bug（正是本需求要治的病，不能在新面板里复现）。

**否决的替代**：只列委托子智能体、不列内部 SUB —— 用户痛点明确包含内部 SUB（他截图里跑的就是内部 SUB），排除等于不解决问题。

### D3 · 已完成态由前端自留，不新增后端持久化

**选择**：已完成分区的数据来自两个 Provider 的内存条目（委托侧完成后 `status` 翻为 `ok`/`err` 但条目保留），**由 selector 按会话归属过滤出「当前会话」那部分**；对已完成分区施加每会话显示上限，并给委托绑定加全局条目上限。

**理由**：后端 `active_delegations` 是 running-only（`session_state.rs:1118` 完成即 remove），已完成态只能前端自留。冷加载（刷新后回看历史）已有独立路径：子会话 DB 行 + `inject_delegation_meta`，故不需要后端新增持久化。

**⚠️ 初稿前提已被推翻（2026-08-03 · 我的判断错误，非评审误判 · 对应 R1 评审 A7）**：初稿曾写「会话关闭即随 Provider 卸载而清空 —— 生命周期与前端 Provider 天然一致」，经核实**不成立**：

| 事实 | 锚点 |
|---|---|
| 两个 Provider 挂在**工作区级**，不是会话级 | `src/app/workspace/layout.tsx:1224` `<LiveObservabilityProviders>` 位于 `WorkspaceLayoutInner`，在 `ConversationRuntimeProvider` / `TabProvider` **之外** |
| 故切换会话、关闭会话 tab **都不卸载** Provider | 同上（Provider 在 tab 树上游） |
| 真正的卸载时机是整个工作区卸载（刷新 / 关窗） | 同上 |
| `MAX_TRACKED_SUBAGENTS = 64` 是**全局**上限，非每会话 | `subagent-transcript-context.tsx:101` + `:156` 的 `while (framesRef.current.size > MAX)` 对整个 map 生效 |
| 委托绑定侧**完全无上限** | `delegation-context.tsx:76-78` `byToolUseId` 只增不减；`delegation_completed` 后的 2 秒定时器只 detach 子连接（`:235-239`），binding 保留 |

所以「保留到会话关闭」**不能**靠 Provider 生命周期自动满足 —— 它既保留过久（关了会话 tab 记录仍在内存），又在长工作区会话下无界增长（委托侧）。

**修正后的机制**（三层，各司其职）：

1. **保留边界由 selector 的会话归属表达，不由 Provider 生命周期表达**：面板只展示归属为「当前会话」的条目（R2.5-R2.7 / R3.3-R3.4 已提供判定）。Provider 内残留条目是无害的内存副本，不是 UI 真源。
2. **已完成分区的每会话显示上限**：超出按完成时间淘汰最旧，避免长会话下该分区无界增长。属显示层裁剪，不改 Provider。
3. **委托绑定的条目上限**：给前端 `byToolUseId` 加上限，**仅淘汰已终态条目、永不淘汰运行中条目**。现状是真实的无界增长。

**与后端既有容量治理的关系（开工前核验 · 避免造重复机制）**：后端已有三层上限，本轮新增的是**它们都未覆盖的第四层**：

| 机制 | 治什么对象 | 作用域 | 默认值 | 锚点 |
|---|---|---|---|---|
| `kept_alive_cap` | 保活的**子连接** | 全局 + per-parent 双层 FIFO | 8 | `broker.rs:254` / `:1351` `enforce_kept_alive_caps` |
| `completed_cache_cap_bytes` | 已完成任务的**结果文本** | per-parent 字节预算 | 512 MB | `broker.rs:248` / `:79` |
| `MAX_TRACKED_SUBAGENTS` | 前端**内部 SUB 帧** | 全局条目数 | 64 | `subagent-transcript-context.tsx:101` |
| **本轮新增** | 前端**委托绑定元数据**（`byToolUseId`） | 全局条目数 | **256** | `delegation-context.tsx:76-78`（现无上限） |
| **本轮新增** | 已完成分区的**每会话显示行数** | 每会话 | **20** | 显示层裁剪，不改 Provider |

前三者治的对象各不相同（连接 / 文本 / 帧），**都不覆盖前端绑定元数据**，故本轮两项是真空而非重复。

**取值依据（C5 处置 · R3 评审要求给出而非留「待定」）**：

- **绑定条目 256**：后端 `kept_alive_cap` 默认 8 是**保活连接**数（重资源）；绑定条目只是几个字符串加枚举的元数据（每条约 200-400 字节），量级差两个数量级，故取更宽的 256（≈ 100 KB 上限）。它要挡的是「长工作区会话累积上千条」的内存增长，不是限制并发派发 —— 取太小会误删用户仍想回看的记录（用户明确要求跑完保留），256 足以覆盖一个工作日的典型派发量而仍有硬边界。
- **每会话已完成 20 行**：Popover 载体的可视高度约容纳 8-12 行，20 行给了滚动余量又不至于让用户在面板里翻页找东西。超出部分不是丢失（绑定仍在，直到 256 上限），只是不在面板里列出 —— 回看更早的走侧边栏子会话或历史。
- 两个数值都是**代码常量**（见下），实现后如与实测手感不符，调常量即可，不涉及契约。

**淘汰计数的重置作用域（C5 处置）**：内部 SUB 的淘汰累计计数（R3.7）随 `SubagentTranscriptProvider` 生命周期，即**工作区级**，刷新页面归零。requirements 原文写「自会话开始以来」是措辞不准（Provider 是工作区级，见 D3 前提修正），应理解为「自本工作区加载以来」。面板呈现该提示时不得暗示它只反映当前会话。

**上限值的暴露方式（定为代码常量，不进设置页）**：核实设置页 `src/components/settings/delegation-settings.tsx` 当前只暴露 `depth_limit`（`:167`）与 `completed_cache_max_mb`（`:191`）两项，**后端的 `kept_alive_cap` 本身也未接入 UI**。故本轮的前端绑定上限跟随 `MAX_TRACKED_SUBAGENTS` 的既有做法定为**代码常量**（与内部 SUB 侧对称、零设置页改动），不新增设置项 —— 给一个用户无从判断合理取值的旋钮属 D 类。若日后确有调参需求，与 `kept_alive_cap` 一并接入设置页更合适。

**否决的替代**：
- 后端加「已完成委托」持久集合 —— 新增持久化面与淘汰策略，收益仅「刷新后仍可见」，已被既有冷加载路径（子会话 DB 行 + `inject_delegation_meta`）覆盖；
- 把 Provider 下移到会话级 —— 破坏其现有职责（消息列表深处的渲染器跨会话读取它，`live-observability-providers.tsx` 注释明确说明这是它挂在上游的原因），且与「其他会话折叠段」直接冲突（那正需要跨会话可见性）。

**已知边界**（显式写入而非默认）：
- 刷新页面清空两个 Provider 的内存条目；面板**不承诺**刷新后仍列出已完成条目（回看走既有冷加载路径）。
- 内部 SUB 的 64 条上限是全局的：多会话并行大量派 SUB 时较早会话的条目可能先被淘汰，由 R3.6-R3.7 的淘汰计数提示。

### D4 · 不对齐两条常驻条的数字，改为各自措辞明确口径

**选择**：两条常驻条各自服务不同任务池，**不追求数字相等**。子智能体常驻条的观察集合 = 当前会话的委托子智能体 ∪ 内部 SUB（R5.2，**非**初稿所写的「仅委托池」—— 那与覆盖内部 SUB 矛盾，已于 R1 A1 / R2 B3 修正）；后台任务横幅继续服务 Claude 原生后台任务池，并按 D6 分类呈现。两者可同时可见，垂直排列顺序固定（R5.8）。

**理由**：二者是两个独立任务池（`background_watch` 的 `agentId`/`backgroundTaskId` vs broker 的 `task_id`/`child_conversation_id`），标识体系与生命周期管理都不同。让数字对齐需要把 `kind` 分类推上 wire —— 跨 `types.rs` → `session_state.rs` → snapshot → `types.ts` → `snapshot-denormalize.ts` → 消费方六处契约传播（E-060 形状），而对齐后语义上仍不该相等。

**否决的替代**：合并成一个数字 —— 见上，成本高且语义错。

**验收警戒**：任何形如「横幅数字与清单条数一致」的验收条件都是把技术差异误当业务需求，不得写入 AC。R5.5 只要求「文案标明计数对象」。

### D5 · 清单载体 = 常驻条下拉 Popover（已定稿）

**候选与已知成本**：

| 载体 | 成本 | 关键约束 |
|---|---|---|
| 触发点下拉 Popover | 最低，零注册表改动 | 空间有限，「就地详情」可能需二级或配合 Sheet |
| Sheet | 低，零注册表改动 | 空间充裕适合列表+详情双栏；模态感与「常驻观察」意图略有张力 |
| AuxPanel 新 tab | 高，11 处改点 | `resolveAuxTabView`（`aux-panel.tsx:107-114`）在非 folder 场景无条件塌成 `session_details`，需把 folder 门控改为按 tab 分类并重写 `aux-panel.test.tsx` 五个断言；且触发点在会话面板顶部而面板在窗口右侧，眼动跨度大、面板可能被用户关着 |

**定稿：常驻条下拉 Popover**（2026-08-03，UI 设计卡返回后定）。

**三条理由，按权重**：
1. **零注意力断裂** —— 点击点与结果点垂直相邻。AuxPanel 在窗口右侧，点会话面板顶部却在右侧远端亮起面板，眼动跨度大。
2. **不给既有 tab 引入回归** —— `SEGMENTED_TABS_WIDTH = 130` 的注释明写按 4 个 icon trigger 计算（`aux-panel.tsx:65-73`）；加第 5 个 tab 会让现有 4 个 tab 在更宽的面板宽度下就退化成 dropdown，是对既有交互的净损。
3. **可达性反而更好** —— AuxPanel 默认关闭（`aux-panel-context.tsx:31` `DEFAULT_IS_OPEN = false`）且 chat 模式下被 `resolveAuxTabView` 折叠掉，而本面板在 chat 模式必须可用。

**升级留口**：清单主体抽成容器无关组件（不感知 Popover / Sheet / Panel），日后若要钉到侧栏或升级为 AuxPanel tab 是纯接线，不重写。这样本轮避开 11 处注册表改动与 `resolveAuxTabView` 的 folder 门控重构，又不锁死未来形态。

**就地详情的深度**：Popover 内空间有限，故详情按来源分深度（R6.4-R6.8）—— 内部 SUB 渲染已缓存帧，委托行只显示最近一条助手消息摘要 + 跳转入口，完整历史仍由 `SubAgentSessionDialog` / Open in Tab 承担。面板不做第二个会话查看器。

### D6 · 横幅计数分类上报（用户 2026-08-03 拍板）

**选择**：让 `BackgroundActivity` 事件按 `TaskEntry.kind` 分类上报，横幅分别呈现「内置异步子智能体数」与「后台 shell 任务数」。

**理由**：初稿 D4 判定「不对齐两条常驻条的数字」是对的，但据此推出「横幅完全不动」是错的 —— UI 设计卡核实后指出更严重的事实：横幅计数**完全不含外部委托**（委托走 broker 事件，与 transcript watcher 是两套独立机制）。于是出现「派 2 个 codex 委托 → 横幅显示 0」「跑 1 个 `pnpm build` → 横幅显示 1 而子智能体清单为空」。这不是「两个数字不该相等」的问题，而是横幅自身的数字无法被正确解读。

`TaskEntry.kind`（`background_watch.rs:325-328`）已存在，只是不出墙 —— 分类上报是小改动（`AcpEvent::BackgroundActivity` 增字段 + 前端反规范化 + 横幅文案），远小于让两池对齐所需的 6 处契约传播。

**与 D4 的关系**：D4 的结论「不追求两条常驻条数字相等」**不变**（二者是不同任务池，语义上本就不该相等）。D6 只解决「横幅自身可被正确解读」，两者不冲突。

### D7 · 内部 SUB 状态降级为「运行中 / 已静默」（用户 2026-08-03 拍板）

**选择**：内部 SUB 只有两个生命周期取值 —— 自最后一帧起未超阈值为「运行中」，超阈值为「已静默」（当前取 15 秒）。永不进入已完成分区。

**理由**：`ClaudeSubagentMessage` 不携带任何终止信号，无帧既可能是完成、也可能是模型思考 / 等待阻塞 / 连接中断。把「近期活动证据」当「权威生命周期状态」会两头出错：运行中的被提前判完成，已结束的长期显示在跑。降级后不假装知道成败，用户仍能区分「还在动」与「不动了」。

**否决的替代**：① 一直显示运行中 —— 早已结束的 SUB 永远转圈，用户无法判断是否需要干预；② 只显示最后活动时间戳 —— 最诚实但把判断成本转嫁给用户，每次都要心算。

### ADR admission

**ADR needed: no** —— 本需求不新增架构边界，也不改依赖方向。看似边界性的决定都落在既有契约内或属可逆实现选择：

- **D1**（归属口径）是把 `continue_delegation` 已确立的 D5 口径补齐到漏掉的两个分支，不新立口径；
- **D3**（已完成态前端自留）复用前端 Provider 既有生命周期，不新增持久化面；
- **D6**（横幅分类上报）确实**新增一个事件字段**，但它是同一事件的向后兼容扩展（消费方缺字段时退化为原有合计语义），不改事件语义边界、不改依赖方向；
- **D5**（载体 Popover）与 **D7**（静默阈值）是 UI 实现选择，可逆，且 D5 已按容器无关组件设计留出升级口。

判据是「以后是否会有人问『当初为什么这么定』且切换有成本」：以上各项切换成本均低（换载体是接线、改阈值是常量、事件字段可扩展），故不立 ADR。R1 评审提出的授权主体议题（A5）**若未来要做多租户则需要 ADR**，但那是覆盖全部四条用户侧 delegation 通道的独立议题，不在本需求范围（见 requirements.md R8 的 A5 处置说明）。

## Architecture & Layering

依赖单向：`两个 Context（数据源）→ src/lib/observed-sub-agents.ts（纯 selector）→ 常驻条 / 清单载体（展示）`。

- **纯函数隔离**：行模型归一、分区归类、能力标记全部落在 `src/lib/observed-sub-agents.ts`，不含 React。这样它可被 property test 直接覆盖，且两个 Context 无需互相认识。
- **Context 只加读口，不加逻辑**：两个 Provider 的投影只暴露自己已有的 map，不做跨 Provider 聚合（聚合是 selector 的职责）。避免 Provider 互相依赖。
- **归属解析的位置**（**已按 R2 B8 修正**）：`SubagentTranscriptProvider` **只保留原始 `session_id`，不解析归属**；解析由 selector 在每次求值时基于传入的映射快照进行（R3.3-R3.5）。初稿写「在 Provider 内完成解析、结果随条目暴露」，那会把派生归属固化 —— 映射迟到时条目将**永久**停在未归属分区。**下一位维护者请勿把解析搬回 Provider。**
- **取消的反腐层**：前端只认 `child_conversation_id`，`task_id` 的解析由后端 `resolve_delegation_target` 负责（与既有三条通道口径一致），前端不持有也不构造 `task_id`。
- **双模对称**：`cancel_delegation_core` 接受普通引用参数，Tauri command 与 HTTP handler 各自包装（项目既有 `_core` 约定，见 `CLAUDE.md` 条件编译约定）。

## Components & Interfaces

### 后端

- `DelegationBroker::cancel_task_by_id(parent_connection_id: &str, parent_conversation_id: Option<i32>, task_id: &str) -> DelegationTaskReport` —— 签名不变，仅两处归属判定改为 D5 口径。
- `cancel_delegation_core(db, broker, child_conversation_id: i32) -> DelegationTaskReport` —— 新增，三分支：`NotFound → unknown_target_report()` / `NotASubsession → not_a_subsession_report()` / `Target { task_id, parent_conversation_id } → broker.cancel_task_by_id(USER_ENTRY_CONNECTION_ID, parent_conversation_id, task_id)`。
- Tauri command `cancel_delegation`（照 `commands/delegation.rs:411-435` 包装模式）+ `lib.rs:1122-1126` 注册。
- HTTP `POST /cancel_delegation`（照 `web/router.rs:68-71`）+ handler（照 `web/handlers/delegation.rs:63-75`），参数结构 `#[serde(rename_all = "camelCase")]`。

### 前端

- `DelegationContextValue` 新增只读投影：返回全部 binding 的稳定引用集合。
- `SubagentTranscriptContextValue` 新增只读投影：返回全部受跟踪条目（含 `parentToolUseId` / `sessionId` / 解析出的 `conversationId` / 帧视图统计）。
- `src/lib/observed-sub-agents.ts`（新）：见下节 Key Functions。
- `cancelDelegation(childConversationId: number): Promise<DelegationTaskReport>` —— `src/lib/api.ts`，照 `:4051-4060` 模式经 transport 抽象调用，**transport 层零改动**（已确证 `src/lib/transport/` 内无既有 delegation 方法名登记）。
- 子智能体常驻条组件 + 清单载体组件（载体形态待 D5 定稿）。

### 错误码

复用既有 `DelegationError` 与既有报告构造器（`unknown_report` / `unknown_target_report` / `not_a_subsession_report`），**不新增错误码**。

## Key Functions — Formal Specifications

### `observedSubAgents.buildRows(input) -> ObservedSubAgentRow[]`  (待建：`src/lib/observed-sub-agents.ts`)

**入参（单一对象，B1/B4/B8 收敛后的完整输入契约）**：`{ delegations, subagents, currentConversationId, conversationIdByExternalId, now, silenceThresholdMs }`

> 三次修正的来由：R2 B1 指出 selector 拿不到归属判定所需的标识（原签名只有 `currentConversationId`）；B8 指出映射后到时归属需可重算，故映射表必须是入参而非模块内读取；B4 指出静默判定隐式依赖系统时间，故 `now` 与阈值也必须显式传入。**归属与状态判定所需的一切都从入参进来，函数保持纯 —— 这是三条评审意见共同指向的同一个结论。**

- **Preconditions**: `delegations` / `subagents` 是两个 Provider 投影的快照；`conversationIdByExternalId` 是当次求值时的映射快照；`currentConversationId` 可为 `null`（覆盖冷启动）；`now` 由调用方提供（测试可注入固定时钟）。所有输入均不可变，函数不修改它们。
- **Postconditions**: 返回的每一行恰好归入四个分区之一；每行携带的能力标记与其来源类型一致（内部 SUB 的取消与跳转恒为不可用）；输出顺序在相同输入下确定（稳定排序，便于 UI diff 与测试断言）；输入为空则返回空数组，不返回 `null`。
- **Loop invariants**: 遍历过程中每处理一条输入，输出集合中恰好增加 0 或 1 行（不重复、不合并两条不同来源）。
- **Errors**: 无异常路径。字段缺失（无 agent 类型 / 无任务文本 / 无会话归属）走既定退化取值，不抛错、不丢行。

### `broker.cancel_task_by_id(...)` 的归属判定  (既有：`src-tauri/src/acp/delegation/broker.rs:4881`)

- **Preconditions**: `task_id` 非空；`parent_conversation_id` 为调用方已核实的归属会话 id，或 `None` 表示调用方无会话上下文。
- **Postconditions**: 归属通过且任务运行中 → 任务转 `Canceled` 且子连接被 teardown，返回的报告与 completed-cache、teardown meta 三者时长一致（既有 `duration_ms` 复用逻辑不变）；归属通过且任务已完成 → 返回其终态报告，不改状态；归属不通过 → 返回 `unknown_report`，不改任何状态、不泄露存在性。
- **Loop invariants**: N/A。
- **Errors**: 归属不通过统一走 `unknown_report`（与既有 `continue_delegation` 一致，不区分「不存在」与「无权」）。

## Data Models

`ObservedSubAgentRow`（新，前端内部类型，不上 wire）需容纳的维度：

| 维度 | 委托子智能体取值来源 | 内部 SUB 取值来源 |
|---|---|---|
| 稳定行标识 | `taskId` 或 `parentToolUseId` | `parentToolUseId` |
| 来源类型 | delegated | builtin |
| agent 类型 | `binding.agentType` | 无（中性占位） |
| 任务文本 | `binding.task` | `taskPrompt`（可能缺） |
| 状态附加信息 | `errorCode` + 等待批准派生态 | —— |
| 活动证据 | —— | `messageCount` / `toolCount` / `tailText` / 最后一帧时刻 |
| 会话归属维度 | `binding.parentConversationId` 与传入的当前会话 id 比对（R2.9-R2.11，**不查 DB、不读模块外全局状态**） | 由 selector 用传入的映射快照把 `sessionId` 解析为 `conversationId`，解析不到 → 未归属（R3.3-R3.5） |
| 生命周期维度 | `binding.status` 映射：running / ok→已完成 / err→失败；取消后→已取消 | 仅 运行中 / 已静默（按最后一帧时刻与阈值比较，R3.11-R3.12） |
| 可取消 | 是（运行中时） | 恒否 |
| 可 Open in Tab | 是 | 恒否 |
| 展示分区 | 由两维度投影（R4.7-R4.9：生命周期优先） | 同左，且永不落入「已完成」 |

**两个维度是正交的**（A2 修正）：会话归属 ∈ {当前会话, 其他会话, 未归属}，生命周期 ∈ {运行中, 已静默, 已完成, 已取消, 失败}。展示分区是二者的投影，投影规则由 R4.7-R4.9 固定（生命周期优先：任一终态一律进「已完成」分区，非终态才按会话归属分流）。初稿把两者压成单值枚举导致「已完成的当前会话任务该进哪个分区」无解。

**面板级状态**（非行级）：
- 内部 SUB 的累计淘汰计数（R3.6-R3.7），用于面板级容量提示；
- 委托绑定的条目上限与「仅淘汰终态」约束（R2.12-R2.13），以及已完成分区的每会话显示上限（R2.14）—— 均为 D3 修正后新增。

**既有类型改动范围**：`DelegationBinding`、`DelegationTaskReport`、`ActiveDelegationState` 沿用不改。两处新增：

1. `SubagentFrame` 的承载结构需补 `session_id` 与最后一帧时刻（R3.2 / R3.8）—— 前端内部结构，不上 wire。
2. `AcpEvent::BackgroundActivity` 增加分类计数字段（D6 / R5A.1）—— **这是一次 wire 契约扩展**，向后兼容（消费方缺字段时退化为原有合计语义），传播路径 `acp/types.rs` → `session_state.rs` → snapshot → `src/lib/types.ts` → `snapshot-denormalize.ts` → 横幅。

> 初稿此处写「wire 契约零改动」，在 D6 采纳后已不成立（R1 评审 F3 亦指出「新增 HTTP / Tauri 接口本身即传输契约变化」）。准确表述：**既有事件与快照的现有字段语义零改动**；新增的是一个向后兼容的事件字段（D6）与一条新的用户侧命令通道（R8），二者都不改动既有字段含义。

## Error Handling

| 场景 | 层 | 处理 |
|---|---|---|
| 取消目标不存在 | `cancel_delegation_core` | `unknown_target_report()`（既有构造器） |
| 取消目标不是子会话 | `cancel_delegation_core` | `not_a_subsession_report()`（既有构造器） |
| 归属校验不通过 | broker | `unknown_report()`，不泄露存在性 |
| 取消一个已完成任务 | broker | 返回其终态报告（既有语义，不可取消） |
| 取消请求传输失败 | 前端行状态 | 该行标记取消失败并保留原状态（R7.3），不乐观更新 |
| `session_id` 解析不出 `conversationId` | `SubagentTranscriptProvider` | 标记未归属（R3.4），不丢弃、不误归当前会话 |
| 内部 SUB 超 64 条被淘汰 | Provider → UI | Provider 累加淘汰计数（R3.6），UI 据此在面板级提示「较早条目已不再保留」（R3.7）。**不**为每个被淘汰条目留墓碑 —— 那会让容量上限形同虚设 |
| 内部 SUB 长时间无新帧 | 行模型 selector | 转「已静默」（R3.10），文案标明是「无最近活动」而非「已成功结束」（R3.12） |
| 同一行的第二个取消请求 | UI | 在途期间阻止（R7.7） |
| 取消返回「已完成 / 已取消」 | UI | 视为成功而非失败（R7.8） |
| 取消响应晚于已到达终态 | UI | 保留已到达终态，不被覆盖（R7.9） |
| 委托行详情摘要加载失败 | UI | 错误态 + 重试入口（R6.7） |
| 行无可展示内容 | UI | 说明性提示文本（R6.5） |
| 清单为空 | UI | 空态文本（R6.6） |

## Testing Strategy

**TDD 红→绿目标（按交付层）**：

- **P0 归属修复**：红灯先写 —— 以 `USER_ENTRY_CONNECTION_ID` + 匹配的 `parent_conversation_id` 取消一个真实运行任务，当前必然返回 `unknown`。改造基点 `broker.rs:6438` 既有 `cancel_task_by_id` 用例（现有两个用例 `:6443`、`:7152` 都传真实 `"parent-conn"`，从未覆盖用户侧路径 —— 这正是缺陷至今未被发现的原因）。
- **P1 投影与归属**：照 `subagent-transcript-context.test.tsx` 样板（`:13-22` mock `useAcpEvent` 捕获 handler、`:24-29` `act()` 注入合成事件、`:31-38` 等一帧、`:40-53` 造 envelope —— 该 fixture 已含 `session_id: "sess-1"`，可直接用于归属断言、`:63-70` Probe 组件断言）。
- **P1 selector**：`observed-sub-agents.ts` 是纯函数，属性测试直接覆盖（见 Correctness Properties）。
- **P2 取消链路**：`commands/delegation.rs:478` 同文件 `mod tests`。**必须有一条不 mock broker 的用例**，否则重现 E-052（mock 掉 broker 则归属缺陷下单测仍全绿）。
- **P3 UI**：行渲染的能力标记退化（内部 SUB 的取消/跳转呈禁用）、四分区归类、空态。

**i18n 门禁**：`src/i18n/messages.test.ts:28-48` 以 `en.json` 为基准断言其余 9 个 locale 的 key 集合**完全相等**（`missing` 与 `extra` 都须为空）。新增 key 只加 `en.json` 会直接红灯，10 个文件必须同步。

**检查命令**（项目既有约定）：
- 前端 `pnpm eslint .` / `pnpm test`
- Rust 桌面 `cd src-tauri; cargo clippy --all-targets --features test-utils -- -D warnings` / `cargo test --features test-utils`
- Rust 服务器 `cargo clippy --no-default-features --bin codeg-server --lib -- -D warnings` / `cargo test --no-default-features --bin codeg-server --lib`

**端到端（非单测，Success State 的验收姿势）**：起一个真实委托 → 常驻条计数出现 → 打开面板看到该行 → 点取消 → 确认 broker 返回 `Canceled` 且子连接 teardown → 该行移入已完成分区。

## Correctness Properties

### Property 1: 两维度归类的完备性与投影的确定性

For any 委托绑定集合与内部 SUB 集合的组合, THE 行模型 selector SHALL 使每条输入恰好产出一行，该行同时持有一个会话归属取值与一个生命周期取值，且其展示分区由这两个取值唯一确定。

**Validates: Requirements 4.5, 4.6, 4.7, 4.8, 4.9, 6.1, 6.2, 6.3**

### Property 2: 内部 SUB 的操作能力恒为受限

For any 内部 SUB 条目, THE 行模型 selector SHALL 将该行的可取消与可 Open in Tab 标记为不可用。

**Validates: Requirements 4.3, 7.5**

### Property 3: 行模型对字段缺失的全域封闭性

For any 缺少 agent 类型、任务文本或会话归属的输入条目, THE 行模型 selector SHALL 产出一行且不抛出异常，缺失字段取既定退化值。

**Validates: Requirements 4.4, 3.4**

### Property 4: 归属校验的单调性

For any 任务与任意调用方凭据组合, THE DelegationBroker SHALL 仅在「`parent_conversation_id` 有值且相等」或「`parent_conversation_id` 为 `None` 且 `parent_connection_id` 相等」时判定归属通过，其余一律返回 `unknown_report`。

**Validates: Requirements 1.1, 1.2, 1.4, 1.5**

### Property 5: 归属判定口径的跨入口一致性

For any 任务与任意调用方凭据组合, THE `cancel_task_by_id`、`classify_locked` 与 `continue_delegation` SHALL 就该组合是否通过归属判定给出相同结论。

**Validates: Requirements 1.6, 1.7**

### Property 6: 已完成条目在会话存续期内不丢失

For any 已转入 `ok` 或 `err` 的委托绑定, THE DelegationProvider SHALL 在该 Provider 存续期间使其保持在投影中可见。

**Validates: Requirements 2.2, 2.4**

### Property 7: 会话归属对映射到达时序的无关性

For any 内部 SUB 条目, THE 行模型 selector SHALL 使其会话归属仅取决于当次求值传入的映射快照，而与该映射相对于帧事件的到达先后无关。

**Validates: Requirements 3.3, 3.4, 3.5**

### Property 8: 内部 SUB 永不获得终态

For any 内部 SUB 条目与任意帧到达时序, THE 行模型 selector SHALL 使其生命周期取值仅为运行中或已静默，且其展示分区不为「已完成」。

**Validates: Requirements 3.9, 3.10, 3.11**

### Property 9: 行生命周期与取消响应的解耦

For any 取消请求响应与委托生命周期事件的任意到达顺序, THE 观察面板 SHALL 使该行的生命周期取值仅由事件流决定，与响应到达顺序无关。

**Validates: Requirements 7.7, 7.8, 7.9, 7.10**

## Update Log

- 2026-08-03 · 初稿落盘。基于侦察报告 `.archive/2026-08-03/subagent-observatory/subagent-observatory-recon.md` 与用户四项拍板决定。D5（载体）待 UI 设计卡返回后定稿，`tasks.md` 按硬门等 3 轮 spec 评审通过后再创建。
- 2026-08-03 · **§5.3 同根变体扫描补入 R1**。`git grep "parent_connection_id =="` 全仓 11 处命中中，除已知的 `cancel_task_by_id` 外，另发现 `classify_locked`（`broker.rs:1933` / `:1939`）为同一指纹的第三处：`get_tasks_status`（`:4733`）签名已携带 `parent_conversation_id`，但 `:4765` 调用 `classify_locked` 时未透传，判归属仍只比 `parent_connection_id`。它经 `get_task_status` / `get_tasks_status` 暴露（读路径），目前仅 LLM 通道消费故未暴露症状，但面板扩展到「显示权威状态」即会踩同一坑。按 §4.8 在同一交付内根治 → 新增 R1.6 / R1.7 + Property 5（跨入口口径一致性），Property 编号顺移。余下 8 处经核为 setup 登记与父连接批量清理路径（调用方持真实连接 id），不在指纹半径内，本轮不动。
- 2026-08-03 · **R1 评审处置（codex · NEEDS_CHANGES · P0=6 P1=6 · `review.codex.md`）**。逐条过筛结果：

  | 编号 | 评审判级 | 处置 | 依据 |
  |---|---|---|---|
  | A1 入口生命周期矛盾 | P0 | 🟢**采纳** | 真问题且是自相矛盾：初稿 R5.1「仅当存在未完成委托才显示」与「永不消失 / 已完成分区 / 覆盖内部 SUB」互斥，内部 SUB-only（正是用户截图场景）与「跑完回看」两种情形入口都不出现。重写为「观察集合非空即可见」（R5.1-R5.8） |
  | A2 四分区不互斥 | P0 | 🟢**采纳** | 真问题：会话归属与生命周期正交，初稿压成单值枚举致「已完成的当前会话任务」无归属解。拆为两维度 + 显式投影优先级（R4.5-R4.9 · Property 1 重写） |
  | A3 内部 SUB 无权威终态 | P0 | 🟢**采纳** | 真问题：`ClaudeSubagentMessage` 无终止信号，初稿仍承诺已完成分区对其成立。降级为「运行中 / 已静默」两态（R3.9-R3.12 · D7 · Property 8） |
  | A4 归属数据链断跳 | P0 | 🟡**采纳，改法不同** | 缺陷成立（`DelegationBinding` 与 `DelegationStarted` 事件均无 `parent_conversation_id`，已用 `delegation-context.tsx:39-53` + `acp/types.rs:334-348` 核实）。但**不采纳**其「补 DB 查询 + 缓存 / 失效 / 失败语义」的建议 —— 已有的 `parentConnectionId` 足以判定归属（实时事件由 broker 携带，快照 seed 由 `delegation-seed.ts:31` 用快照自身 connectionId 填充），改为收紧输入契约让 selector 保持纯函数（R2.5-R2.7），缺陷同样消除且少一次失败面 |
  | A5 授权主体缺失 | P0 → **P1** | 🟡**降级 + 记为已知边界** | 命题成立（「目标数据自洽 ≠ 调用方拥有目标」），但影响面高估：`web/auth.rs:22-30` 是单一全局 Bearer token，全仓无 principal / account / tenant 概念，桌面模式为本机进程 —— 当前是单用户信任域，不存在「另一个用户」主体。且该信任域假设由既有三条用户侧 delegation 通道共同确立，本需求沿用同一口径、未引入新弱点。多租户改造需覆盖全部四条通道，属独立议题（若做则需 ADR） |
  | A6 载体未定稿 + 委托消息无来源 | P0 | 🟡**部分采纳** | 「委托行没有消息数据来源」**成立** → 详情按来源分深度（R6.4-R6.8：内部 SUB 渲染已缓存帧，委托行只给最近一条助手消息摘要 + 跳转，完整历史仍归 Dialog / Open in Tab）。「载体未定稿导致不可实施」**驳回** —— spec 流程明确要求 tasks.md 在评审通过后才创建，D5 待设计卡是流程内正常待定态，非设计缺失；载体已于本轮定稿（D5 = 常驻条下拉 Popover） |
  | F1 淘汰无可观察信号 | P1 | 🟡**采纳，改法不同** | 缺陷成立（生产者删条目后消费方无凭据说明）。不用逐条 tombstone（会让容量上限形同虚设），改为聚合淘汰计数 + 面板级容量提示（R3.6-R3.7），并相应**撤回**初稿「逐项说明」的承诺 |
  | F2 取消并发 / 竞态契约缺失 | P1 | 🟢**采纳** | 真问题：初稿只覆盖单次顺序取消。补幂等与竞态契约（R7.7-R7.10 · Property 9），核心是「broker 报告为唯一真源」+「已到达终态不被更晚响应覆盖」 |
  | F3 新增 API 契约不完整 + 与「wire 零改动」冲突 | P1 | 🟡**部分采纳** | 「表述冲突」**成立** → 改为「既有事件与快照的现有字段语义零改动」，并显式列出两处新增（D6 事件字段扩展 + R8 新命令通道）。完整 HTTP 契约细节（状态码 / 超时 / 审计字段）**降为实现细节** —— 本需求要求与既有 delegation 路由同构（R8.7-R8.8），逐字段重述既有通道已有的约定属冗余 |
  | A7 会话关闭语义不明确 | P1 | ⏭ **R2 处理** | 真问题（「会话关闭」= 关 tab / 切会话 / 刷新 / 断线重连未定义，委托完成记录无上限）。本轮 A1-A6 改动已触及 R5 / D3，为避免同一轮多次重写同段，留 R2 与其反向验证意见一并处理 |
  | A8 缺业务现实分类 | P1 | 🔴**驳回** | 该分类（§0.17 A/B/C/D）已在侦察报告 §4.2 逐项完成并据此判掉「横幅分类计数」为 D 类；spec 的 Corrected Goal 表也逐条记录了「不复用 task-context / 不复用 childCountHint / upstream Task Board 非重复」的裁剪依据。评审因只读 spec 两文件、未见侦察报告而误判为缺失。**唯一采纳的子项**：「投影引用稳定」原写「以便 memo 命中」确属实现理由 → 已删去该从句（R2.8） |

  **新增决策**：D5（载体定稿 = 常驻条下拉 Popover）· D6（横幅按 `TaskEntry.kind` 分类上报）· D7（内部 SUB 两态降级）。后两项为用户 2026-08-03 拍板。

  **UI 设计卡独立证实**（`.archive/2026-08-03/subagent-observatory/subagent-observatory-ui-design-card.md`）：横幅计数**完全不含**外部委托（比初稿判断的「混算」更严重）；`disabled` 语义误导（改为肯定性只读标识 + 菜单项直接不存在，R7.5-R7.6）；横幅 30 秒结算尾巴短于面板内容生命周期（与 A1 同源，已由 R5.4 解决）。
- 2026-08-03 · **A7 处置（原判「留 R2」，实际提前处理且推翻了 D3 前提）**。查 Provider 挂载层级后发现初稿 D3 的核心前提是错的，不是边界补充：`<LiveObservabilityProviders>` 挂在 `src/app/workspace/layout.tsx:1224` 的**工作区级**（位于 `ConversationRuntimeProvider` / `TabProvider` 之外），故切会话、关会话 tab 都不卸载它；`MAX_TRACKED_SUBAGENTS = 64`（`subagent-transcript-context.tsx:101` + `:156`）是**全局**上限而非每会话；委托侧 `byToolUseId`（`delegation-context.tsx:76-78`）**完全无上限**，`delegation_completed` 后的 2 秒定时器（`:235-239`）只 detach 子连接、binding 保留。即初稿既保留过久又无界增长。改为三层机制：保留边界由 selector 的会话归属表达 / 已完成分区每会话显示上限（R2.11）/ 委托绑定全局上限且仅淘汰终态（R2.9-R2.10）。R2.2 的「直到该会话关闭」措辞同步更正为「直到因上限被淘汰或工作区卸载」，并显式写入「刷新后不承诺列出已完成条目」这一边界。
- 2026-08-03 · **R2 评审处置（codex · NEEDS_CHANGES · P0=3 P1=6 · `review2.codex.md`）**。R2 确认「核心方向可保留」，P0 由 6 降至 3。逐条过筛：

  | 编号 | 判级 | 处置 | 依据 |
  |---|---|---|---|
  | B1 selector 输入契约仍不闭合 | P0 | 🟢**采纳（第二次修法）** | 我 R1 后用 `parentConnectionId` 比对的修法**同样错了**：前端 `contextKey` 实际是 `tabId`（`conversation-detail-panel.tsx:564`），与 connectionId 不同体系，selector 拿不到连接标识也没有「已知会话集合」。最终解法 = 让 `delegation_started` 直接带 `parent_conversation_id`（后端 `SessionState.conversation_id` `session_state.rs:245` 本就是权威源，`manager.rs:3353` 已在用它做同样解析）。selector 只比两个会话 id（R2.5-R2.9） |
  | B2 取消终态双真源 | P0 | 🟡**采纳，比评审建议更简单** | 核实 `teardown_canceled_child`（`broker.rs:4655`）取消时经 `:4681` 会发 `DelegationCompleted{Err{canceled}}` —— 事件通道**已是**唯一权威流。故不采纳「为两条流引入单调版本 / 排序键」（为不存在的第二真源做仲裁），改为显式规定响应只清在途标记、生命周期一律由事件流决定（R7.7-R7.10 · Property 9 重写） |
  | B3 常驻条口径三套定义冲突 | P0 | 🟢**采纳** | 真问题，是我改 A1 时的清理残留：Glossary / D4 / Introduction 仍写「取自委托池」而 R5.2 已改为并集。三处全部统一为「委托 ∪ 内部 SUB」 |
  | B4 静默判定隐式依赖系统时间 | P1 | 🟢**采纳（结构部分）** | 「纯 selector 实际依赖系统时间与周期调度」成立 → `now` 与 `silenceThresholdMs` 改为显式入参（见 Key Functions）。但**不采纳**「取消阈值、只显示最后活动时间」—— 用户 2026-08-03 明确选择 15 秒转「已静默」，理由是不想每次心算 |
  | B5 会话关闭语义 / 容量 | P1 | 🟢**已在本轮前处理** | 即 R1 A7，我提前处理并推翻了 D3 前提（Provider 挂工作区级、委托侧无上限）。R2 复述同一问题，处置见上一条 Update Log |
  | B6 横幅分类属跨域扩围 | P1 | 🟡**User Story 修正 + 范围保留** | 「原 User Story『与清单对得上』与 AC『不统计委托』自相矛盾」**成立** → 改为「数字能被正确解读」。但「本轮停止 wire 改造只改文案」**不采纳**：用户在知晓「动 5 处 + 数字仍永不相等」后仍选择保留分类上报（需要细分信息），按 B 类保留 |
  | B7 摘要是第二条读取路径 | P1 | 🟡**保留能力 + 补齐接口缺口** | 「未定义接口」**成立** → 明确走既有 `getFolderConversation`（`use-delegated-sub-session.ts:83`）、不新增后端端点、选中时才请求、切换选中丢弃在途（R6.6-R6.10）。「判为 D 类应删」**不采纳**：用户在知晓代价后明确选择保留面板内摘要 |
  | B8 归属依赖「映射先存在」的时序 | P1 | 🟢**采纳** | 真问题：初稿在事件到达时一次性解析并固化，映射后到则**永久**停在未归属。改为 Provider 只存原始 `session_id`、解析由 selector 每次求值基于入参映射快照进行（R3.3-R3.5 · Property 7 重写） |
  | B9 技术支撑项未做业务分类 | P1 | 🟢**采纳** | 「侦察报告的分类不能替代 spec 自身论证」成立 → requirements.md 新增「能力分类」表逐项判 A/B/D。据此**删除**「投影引用稳定」AC 及其 Property（无法陈述用户损失 = D 类），引用稳定降为实现建议 |

  **两个横向观察**：
  1. B1 / B4 / B8 三条指向同一结论 —— **归属与状态判定所需的一切都必须从入参进来**。selector 入参因此从 3 个收敛为一个显式对象（含映射快照、`now`、阈值）。
  2. 我在 R1 后的两处修法（`parentConnectionId` 归属、事件流与响应并称真源）都被 R2 验出问题，说明**只换数据来源而不重建契约**是本轮的主要失误模式。
- 2026-08-03 · **R3 评审处置（codex · NEEDS_CHANGES · P0=2 P1=4 · `review3.codex.md`）**。R3 判「核心方向已收敛」，P0 由 3 降至 2。逐条过筛：

  | 编号 | 判级 | 处置 | 依据 |
  |---|---|---|---|
  | C1 实时事件与快照回放归属不同构 | P0 | 🟢**采纳，且无需新增 wire 字段** | 我 R2 只约束了实时路径，快照 seed 回放未同步 → 重连后同一任务可能突变未归属。核实 `ActiveDelegationState`（`session_state.rs:211-224`）确无该字段，但**不必加**：它挂在 `SessionState` 上，`conversation_id`（`:245`）与 `active_delegations` 同在一份快照（`:1449` / `:1459`），seed 直接取即可 —— 与它现在填 `parent_connection_id` 同一手法（`delegation-seed.ts:31`）。R2.6 / R2.8 |
  | C2 多会话入口与分区无法共同成立 | P0 | 🟢**采纳评审推荐方案二** | 「其他会话折叠段」与「入口仅当前会话非空才现」直接冲突（当前会话空时折叠段永远不可达），且 D3「只展示当前会话」与 R6.2 矛盾。用户拍板改为**工作区级观察面板**：入口条件 = 工作区集合非空，当前会话降为排序/默认展开优先级。这也与底层一致 —— Provider 本就是工作区级，此前是我给工作区级数据强加了会话级边界。R5.1-R5.9 / R6.1-R6.4 |
  | C3 静默判定无调度者 + 计数零值悖论 | P1 | 🟢**采纳** | `now` 显式入参只解决可测性，未定义无新帧时谁触发重算 → 页面静止时永不转静默。补唯一调度者与停表条件（R6.5-R6.7）。计数悖论（仅有静默 SUB 时显示「已完成 0」）随 C2 一并解决：改显示可观察条目总数 + 禁止把静默计入已完成（R5.5-R5.6） |
  | C4 事件流为唯一真源但无丢失恢复 | P1 | 🟢**采纳最小恢复路径** | **这是我 B2 修法的漏洞**：服务端已取消而终态事件在断线期间丢失时，前端清掉在途标记后长期显示运行中，而重连快照只含运行中任务。按评审建议补两个对账触发点（取消返回终态但事件未到 / 断线恢复后仍显示运行中），复用既有 `get_delegation_status`，**不引入事件溯源**。R7.11-R7.13 |
  | C5 容量数值与重置作用域未定 | P1 | 🟢**采纳** | 「待定」不达开工标准。定 256（绑定条目）/ 20（每会话已完成显示行），并给出取值依据（绑定元数据比保活连接轻两个数量级；20 行匹配 Popover 可视高度 + 滚动余量）。淘汰计数作用域更正为「自本工作区加载以来」（原写「自会话开始」与 Provider 工作区级不符），并禁止呈现为仅反映当前会话（R3.9） |
  | C6 取消接口信任边界是条件性前提 | P1 | 🟢**采纳，边界已由用户确认** | 评审要求把「仅单一可信操作者」写成明确上线边界而非由「当前无租户模型」推导。用户 2026-08-03 确认服务器模式按单人使用支持 → 明确写入支持边界（单一操作者持 `CODEG_TOKEN`）与不支持形态（多人共享同一 token），并注明未来多操作者需覆盖全部四条 delegation 通道的独立改造 + 立 ADR |

  **本轮暴露的我的失误模式（两次同型）**：
  1. **只修正在看的那一条路径** —— 归属问题改了三轮（DB 查询 → 连接标识 → 会话 id），第三轮才补上「所有 producer 必须产出同构值」；
  2. **把「单一真源」等同于「单一推送通道」** —— B2 修法在结构上消除了双真源，却没想到通道本身会丢消息。

  两者的共同点是**只在我当时聚焦的那个切面上验证了自洽性**，没有横向问「还有谁产出这个值 / 这条通道失效时会怎样」。

  **三轮 P0 收敛曲线**：6 → 3 → 2 → 0（本轮处置后）。R3 无遗留 P0，可进 tasks.md。
