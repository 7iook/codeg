---
# ═══ CORE IDENTITY ═══
slug: delegation-continue-session
title: 委托子代理从一次性改为可续聊 + 用户侧交互入口 · 设计
# ═══ LIFECYCLE ═══
status: converged
review_rounds_done: 3
last_review_status: NEEDS_CHANGES
last_review_p0: 1
created: 2026-07-26
last_updated: 2026-07-26
shipped_commit: null
# ═══ RELATIONSHIPS ═══
related_adrs: []
related_specs: [kiro-agent-integration]
supersedes: null
superseded_by: null
rca: null
# ═══ DISCOVERY ═══
tags: [delegation, subagent, acp, lifecycle, broker]
domain: agent-runtime
one_line: 拆掉 broker 的 one-shot 销毁让终态子会话保留可复用，对齐上游 PR #375 的 continue_with_session/close_session 契约，并补上该 PR 缺失的用户侧入口与三个资源/竞态漏项。
---

# Design · 委托子代理续聊

## Overview

三层交付，按依赖递进：**保活**（broker 不再无条件销毁终态子连接）→ **续聊契约**（`continue_with_session` / `close_session` 走 MCP 与用户侧双入口）→ **多轮渲染**（前端时间线不再假设单回复）。

核心权衡摆在前面：**保活是有代价的**——每个保留的子代理是一个常驻 agent CLI 进程，而仓库没有任何并发上限（侦察未找到 `max_children` / `max_concurrent`）。本设计**不**给保活连接加 idle sweep 豁免，接受「180 秒内续聊走活连接、之后走 `session/resume`/`session/load` 重开」的降级行为，用可控的续聊延迟换取「不留僵尸进程」。这是有意决策，不是漏项（见 Decision D3）。

三个上游 PR #375 的漏项必须一并修（R1/R2/R3，见 §Risks），否则照搬即引入进程泄漏与取消竞态。

## Current-State Inventory (from recon — 侦察报告 §A/§B)

> 基线 `feat/kiro-agent` @ `655ad67a`，代码内容 == 上游 `e540a4fa`（v0.21.9）。
> 完整锚点见 `.agent-workspace/.archive/2026-07-26/delegation-continue-session/delegation-continue-recon.md`。
> 行号取自侦察实测；后续 rebase 会漂移，按符号名定位。

### ✅ 存在且可直接复用

| 能力 | 位置 | 复用方式 |
|---|---|---|
| broker 状态机 | `delegation/broker.rs:265-330` `PendingInner`（单 Mutex，`seq` 到达时钟 first-terminal-wins） | 扩字段，不重构 |
| 终态分流 | `broker.rs:603-620` `terminal_fields()`（靠 wire code 字符串 `"canceled"` 分 Failed/Canceled） | 直接复用同一判据决定 keep/disconnect |
| 子会话 DB 行 | `conversation_service.rs:60-119` `create_with_delegation`（不变量 `parent_id 有值 ⟺ kind=Delegate ⟺ delegation_call_id 有值`） | 续聊复用现有行，不新建 |
| `external_id` 落库 | `conversation_service.rs:254-262` `update_external_id`；写入点 `manager.rs:997`（同步）+ lifecycle 补写 | 直接读，作为 resume 凭据 |
| resume 链 | `connection.rs:3122-3414` `session/resume` → `session/load` → `session/new`；入口 `manager.rs:405+` `spawn_agent(session_id)` | 透传 `session_id` 即可 |
| 连接复用 | `manager.rs:642-671` `find_connection_for_reuse`（`external_id`+agent+working_dir 匹配且状态非 Disconnected/Error） | 免费获得「进程还活着但 broker 丢了 id」的复用 |
| adopt 现有会话行发 prompt | `manager.rs:887-901` `send_prompt_linked` Branch A（传 `conversation_id`+`folder_id`、link 传 None） | 续聊走这条，**不**走 Branch B（会重复建行） |
| 前端 prompt 双模式 | `api.ts:184-202` `acpPrompt` → Transport 抽象；Web handler `web/handlers/acp.rs:139-194` | 用户入口无需新 transport 通道 |
| 子会话可打开 | `sidebar-conversation-list.tsx:1645-1657` `handleSelect` → `openTab`（子行与根行同一路径，零特判） | 「在标签页打开」按钮直接调它 |
| detach 可取消 | `delegation-context.tsx:129-137` 再次 `delegation_started` 会 `cancelDetachTimer` + re-attach | 续聊重发 started 即自动复用，detach 策略基本不改 |
| 子会话已能收 3 类阻塞卡 | `sub-agent-session-dialog.tsx:330-364`（permission / ask_user_question / plan approval，全走 `childConnectionId`） | 输入框与它们并列 |

### ❌ 不存在（须新建）

| 项 | 位置 | 说明 |
|---|---|---|
| `spawn_for_resume` / `send_followup_prompt` / `is_alive` | `delegation/spawner.rs:59-104` trait | 现有 4 方法无一可复用于「给已有子连接再发一轮」 |
| `CompletedTask` 的保活字段 | `broker.rs:213-224` | 本地版不存 `child_connection_id` / `parent_tool_use_id`，无 `closed` / `external_id` / `folder_id` / `working_dir` |
| `continue_delegation` / `close_delegation_session` | `broker.rs` | broker 公开方法 |
| `Continue` / `CloseSession` 传输层 | `transport.rs` / `listener.rs` / `companion.rs` | 请求类型 + dispatch + 参数校验 |
| **用户侧 command / handler / route / api** | `commands/delegation.rs`（现仅 settings get/set @203/@218）、`web/handlers/delegation.rs`（同）、`web/router.rs`、`api.ts`、`tauri.ts` | **PR #375 完全没做这层**，是本次净新增面 |
| 子会话可发现性 | 新 `src/lib/conversation-sidebar.ts` + 徽标 + 漏斗开关 | 能力已通，缺指引 |
| 多轮时间线投影 | `conversation-runtime-store.ts:2380-2404` `computeTimelinePrefix` | 现版注释自陈 "SINGLE-REPLY one-shot"，会砍掉首个 assistant turn 之后全部历史 |

## Corrected Goal (draft-vs-reality — from recon)

| 初始假设 | 代码现实 | 修正 |
|---|---|---|
| codeg 用户完全无法给子代理发消息，需要新建入口 | 侧边栏子行与根行共用 `onSelect → openTab`，打开是完整可交互面板并自动按 `external_id` resume，后端零阻挡（侦察 §B10） | 能力已存在。真正缺的是**可发现性**与**父 AI 感知**，不是发送能力 |
| 需要透传 Claude 内部 SUB 能力 | codeg 跑 `claude-agent-acp` 适配器而非 `claude` CLI；Claude 的 `CoordinatorTaskPanel` / `viewingAgentTaskId` 是 REPL 进程内 UI 状态，不经 SDK 输出流、不在 ACP 线上；ACP v1.2 无 subagent 概念 | 放弃透传，改造自家委托通路 |
| one-shot 是设计疏漏 | `eeb01202` commit body 明写 "complete_call disconnects the child (v1 one-shot)"，`mod.rs` 原文 "v2 will introduce continue_with_session / close_session tools without protocol breakage" | 是有意的 v1 简化，作者本就规划了 v2。方向与原意图一致 |
| 照搬 PR #375 后端即可 | 该 PR 有三个漏项：idle sweep 会静默杀掉保活连接后降级丢上下文（R1）、`evict_completed_over_cap` FIFO 淘汰不回收连接致进程泄漏（R2）、`continue_delegation` 的注册窗口无取消覆盖（R3） | 对齐契约但必须补修三处 |
| `TaskStatus` 要加 `Closed` 态 | PR #375 把 `closed: bool` 放在 broker 私有 `CompletedTask` 上，不上 wire；`TaskStatus` 与 `DelegationTaskReport` 字段均未变 | 沿用其契约（避免合并冲突），但前端因此无法区分「可续聊」与「已关闭」→ 需补一条可续聊性查询（见 Decision D4） |
| 本地分支会与 PR #375 冲突 | `git log upstream/main..HEAD -- src-tauri/src/acp/delegation` 空输出；`connection.rs` 本地 4 处 hunk 与 #375 的 `@@ -6136` 不重叠 | 零内容冲突，可安全对齐 |

## Decision Record

| 字段 | 值 |
|---|---|
| Reviewer | codex（默认） |
| 决策日期 | 2026-07-26 |
| 侦察报告 | `.agent-workspace/.archive/2026-07-26/delegation-continue-session/delegation-continue-recon.md` |
| 上游参考 | `xintaofei/codeg` PR #375（OPEN，`feat/delegation-continue-session-clean`，patch 落盘 `.agent-workspace/pr375.patch`） |

### D1 · 改造自家委托通路，不透传 Claude 内部 SUB

**选择**：扩展 codeg 的 `delegate_to_agent` 通路。**否决**：① 透传 Claude 的 `CoordinatorTaskPanel`——那些状态不经 SDK 输出流，要拿到得反向 patch Claude CLI，升级脆性不可接受；② 等 `claude-agent-acp` PR #881（`subagent-transcript` capability）——未合，且只解决「看」不解决「发」。

### D2 · 上游 PR #375 只约束 wire，不约束内部领域模型

**选择（R2-B3 修正后）**：对外 wire 契约（MCP 工具名 / `task_id` 语义 / 错误码 / `DelegationTaskReport` 形状）严格对齐 PR #375；**但内部领域模型不受它的字段布局约束**。合并便利是代码层的目标，不能作为压缩领域模型的理由。

**内部最小三层分离（局部重构 · R2 推荐路径）**：

| 概念 | 身份 | 存放 | 职责 |
|---|---|---|---|
| **Session** | `task_id`（= 上游兼容 id，对外唯一可见标识） | broker `sessions: HashMap<task_id, SessionEntry>` | 子会话是否存在 / 归属（parent **conversation** id）/ 最新 turn 指针 / 恢复元数据 |
| **Turn** | 独立 `turn_id`（UUID，broker 内部） | `SessionEntry.turns`（有界队列） | 单次执行的状态单调迁移 + origin（`User` / `ParentAgent`）+ 结果 |
| **Operation** | 调用方生成的 `continuation_id` | 独立 `operations: HashMap<continuation_id, OperationRecord>` | 幂等去重，跨 dispatching/running/settled 全期有效 |

**`Completed_Cache` 职责收窄（R2-B3 核心）**：它**只缓存结果文本**，不再决定 session 是否存在、是否已关闭、是否可续聊。字节淘汰只丢文本，不影响领域行为——这直接消掉了 R1-A2/R2-B3 担心的「缓存膨胀成 session registry」，也让 R2 风险 R2 的连接回收与领域状态解耦。

**facade 映射**：对外的 `DelegationTaskReport` 由 `SessionEntry` + 最新 turn 映射得出，内部 `turn_id` / `origin` 不上 wire。上游合并时只需对齐 facade 层。

**与 R1-A1 的关系**：R1 我拒绍了 Session/Turn 分离，理由是避免与 #375 分叉——**这个理由不成立**：#375 约束的是 wire，而 Session/Turn 分离可以完全局限在 broker 内部。R2-B3 指出的是真问题，接受并推翻 R1-A1 的处置。

### D3 · 不给保活连接加 idle sweep 豁免，但加硬数量上限

**选择**：保活连接照常被 `sweep_idle`（默认 180s）回收，续聊时靠 `is_alive()` 检测后走 `Resume_Path`。**否决**：给保活连接打豁免标记——那会让 fan-out 十个子代理变成十个永久常驻 CLI。

**补正（R1-A4 采纳）**：仅靠 idle sweep 延迟回收**不构成容量上限**——180 秒窗口内连续 fan-out 仍可耗尽进程/句柄，而 `completed_cache_cap_bytes` 只管结果文本字节、管不住进程数（大量短结果任务就能绕过）。因此新增一个**可配置的保活连接数量上限** `kept_alive_cap`（默认值实施时定，建议 8），作用域为**全局 + 每父会话**两层；超限时按 settled 时间 FIFO 淘汰最老的保活连接（disconnect 后仍保留 `CompletedTask` 的结果文本与 `external_id`，下次续聊走 `Resume_Path`）。与 R2 的字节淘汰路径共用同一个「取出连接 id → 释锁后 disconnect」机制。

**必须配套**：`session/load` 失败降级到 `session/new` 时向用户显式报「上下文已丢失」（R1），否则用户以为在续聊、子代理实际失忆。

### D3.1 · 续聊能力按 agent 建模（R1-A5 采纳）

`external_id` 恢复**不是所有 agent 共有的能力**：`session/resume` 是 Claude 专属（带 raw SDK meta），`session/load` 靠 agent 自报能力，`classify_session_load_failure`（`connection.rs:5077`）失败后退化 `session/new`。本地分支新增的 `AgentType::Kiro` 尚未实测 resume 能力。

因此在 spawner 边界暂露一个可查询的 continuation capability，四档：`LiveOnly`（仅活连接可续，进程死即不可续）· `Resumable`（持久恢复，走 resume/load）· `ColdOnly`（只能冷启动，上下文丢失）· `NotContinuable`。broker 据此判定可续聊性，前端查询用同一结果（与 D4 共用一个接口）。能力判定的实现方式已核实（**不靠静态表、不靠失败探测**）：agent 在 `initialize` 响应里**自报**三项能力，`connection.rs:3004-3018` 已经取到并 log：`init_resp.agent_capabilities.load_session`（bool）· `session_capabilities.resume`（Option）· `session_capabilities.fork`（Option）。四档映射：`resume` 有值 → `Resumable`；仅 `load_session` 为 true → `Resumable`（走 load）；两者都无 → `LiveOnly`；连接不可建 → `NotContinuable`。实施时把这三个字段落入 `SessionState`（现在只 log 不存）供 broker 查。

> **Kiro 的 resume 能力（R3 开工核验项 · 已部分回答）**：本地分支新增的 `AgentType::Kiro` 无需事先硬编码判定——上述自报机制对所有 agent 统一生效。仍需实测确认 kiro-cli 的 `initialize` 真的上报了这些字段（而非全部缺省），但即使它不报，降级结果也是 `LiveOnly` 而非静默丢上下文。

### D4 · 可续聊性要暴露到前端

**选择**：在用户侧查询接口里返回一个可续聊状态（不改 `DelegationTaskReport` 的 wire 形状，避免与 #375 冲突）。理由：#375 的 `closed` 只在 broker 私有结构里，用户点了输入框才拿到 `session_closed` 错误——对 LLM 可接受（它会读错误码重试），对用户是坏体验。

**接口契约（R1-F3 采纳 · 不再是悬空决策）**：新增一个用户侧查询 `get_continuation_availability(child_conversation_id) -> ContinuationAvailability`，返回五档枚举：

| 枚举值 | 含义 | 前端表现 |
|---|---|---|
| `Running` | 当前有轮次在跑 | 输入框禁用 + 提示「子代理正在工作」 |
| `ContinuableLive` | 保活连接在，直发 | 输入框可用 |
| `ContinuableResume` | 连接已回收，需 resume | 输入框可用 + 提示「首轮会稍慢」 |
| `Closed` | 已被 `close_session` 退役 | 输入框禁用 + 说明原因 |
| `NotContinuable` | 无 `external_id` 或 agent 能力不支持（D3.1） | 输入框禁用 + 说明原因 |

刷新时机：Dialog 挂载时查一次；每次收到该子会话的 `delegation_completed` 事件后重查；发送失败时重查。前端**不自行推断**这五档（防平行真源）。

### D5 · 归属用 parent conversation id，父连接只是临时租约

**选择（R2-B6 强化后）**：`SessionEntry` 的归属键是 **parent conversation id**（持久），不是 `parent_connection_id`（易失）。理由两层：

1. 原理由：`CompletedTask.parent_connection_id` 严格相等校验在父会话重连后会让 `task_id` 判 `Unknown`（侦察 §D15-3）。
2. **R2-B6 补充**：子会话同时暴露给用户和主 AI，它的生命周期**不应由父连接决定**。父连接拆除时只释放属于该连接的**运行租约**（in-flight 轮次 + 事件订阅），**不**无条件 disconnect 保活连接。保活连接的回收统一由资源策略负责：`kept_alive_cap` FIFO（D3）+ idle sweep（180s）。

这修正了 Requirement 1.4 的原表述（父拆除就 disconnect 全部保活连接）——那会让用户正在用的子会话因为父会话重连而无必要地断开，还可能与用户侧正在发起的 continuation 形成竞态。

> 仍需保留的回收路径：若父 conversation 被删除（非仅连接拆除），则其名下子会话的保活连接全部释放。

### ADR admission

**需要：否**。理由：本变更是既有作者已规划的 v2 演进（`mod.rs` 原文写明），契约由上游 PR #375 定义，codeg 侧属实施细节；无新的不可逆边界决策。D3（不加 sweep 豁免）是唯一有争议的取舍，已在本文档留下 rationale 与撤销路径（若将来引入并发上限，可重议豁免）。

## Architecture & Layering

依赖方向单向：`companion`（MCP 进程）→ `transport`（UDS/named pipe 请求类型）→ `listener`（token 校验 + 解析）→ `broker`（状态机权威）→ `spawner`（trait）→ `manager`（ConnectionManager 实现）。用户侧入口平行接入同一个 broker：`Dialog` → `api.ts` → Tauri command / Web handler → `broker`。

### 状态权威的两层划分（R1-A2）

**持久领域状态（DB `conversation` 行 · 跨重启存活）**：会话身份（`delegation_call_id`）· 父子归属（`parent_id`）· 恢复凭据（`external_id`）· 所属 folder。这些已经在库里，续聊不新增列。

**运行态索引（broker `PendingInner` · 仅当前进程生命周期）**：哪一轮在跑、终态结果缓存、保活连接 id、`closed` 标记。**可重建、可淘汰、进程退出即失效。**

**唯一权威的准确表述**：broker 是「当前进程内、活跃轮次调度」的 SSOT——所有续聊写入都必须经过它，这是「父 AI 能感知用户追问」的全部实现机制。但 broker **不是**跨重启的会话生命周期真源；跨重启的可续聊性由 DB 行（`external_id` 是否存在）决定。

**明确的能力边界（R2-B4 重命名）**：原设计把「回收连接」与「禁止后续续聊」压成一个 `closed` 布尔值，而它只在本进程有效——名为 close 实为临时锁，语义不成立。**采纳 R2-B4 的第一个选项：改名为资源释放**。

- MCP 工具名对外仍叫 `close_session`（wire 兼容 PR #375，不可改），但**语义定义为「释放子代理进程 + 本进程内不再续聊」**，内部状态名为 `Released`而非 `Closed`。
- 工具描述、错误码文案、UI 文案三处统一表述为「释放」而非「永久关闭」，避免用户误以为不可逆。
- 不持久化该状态（不给 `conversation` 加列）。进程重启后会话重新可续聊——在「释放」语义下这是**正确行为**（进程没了，租约自然到期），不再是 R1 里那个需要辩解的例外。
- 用户想永久停用子会话的路径是**删除该会话行**（`deleted_at`，已持久化且 `update_external_id` 已对软删除行做守卫）。

**反腐层**：`ConnectionSpawner` trait 隔开 broker 与 `ConnectionManager`；新增三方法后 broker 仍不直接触碰 ACP 连接。

## Components & Interfaces

### spawner trait 新增（`delegation/spawner.rs`）

- `spawn_for_resume(parent_connection_id, agent_type, working_dir, session_id: Option<String>, mode_id, config) -> Result<String, SpawnerError>`
- `send_followup_prompt(conn_id, message, conversation_id: i32, folder_id: i32) -> Result<(), SpawnerError>` — 走 `send_prompt_linked` Branch A（link=None）adopt 现有行
- `is_alive(conn_id) -> bool` — 读 `manager.get_state`，判 `!matches!(status, Disconnected | Error)`

### broker 新增（`delegation/broker.rs`）

- `continue_delegation(parent_conversation_id, child_conversation_id, message, continuation_id, origin) -> DelegationTaskReport`
- `close_delegation_session(parent_conversation_id, child_conversation_id, continuation_id) -> DelegationTaskReport` · `get_continuation_availability(child_conversation_id) -> ContinuationAvailability`
- `take_settled_child_connections(parent_conversation_id) -> Vec<String>` — 取出并标 `released`，仅用于父 conversation 删除时回收（非父连接拆除，R2-B6）
- `rebuild_sessions_from_db()` — 启动重建协议入口（R3-A1）/ `resolve_resume_meta` / `reinsert_completed`

### 错误码（wire-stable，`types.rs`）

`session_still_running` · `session_released` · `not_continuable` · `resume_unavailable` · `continuation_conflict` · `rebuilding`（启动重建期间的可重试状态，Requirement 7.2——T4 收口时补入本行，W3 落地 R7.2 时已是 wire 码而正文漏列）—— 新增 6 个 `DelegationError` 变体 + `from_err` 映射。`DelegationTaskReport` 不加字段，仅加 `with_task_id()`。上游叫 `session_closed`，本设计因 R2-B4 改用 `session_released`，facade 接受前者作历史别名。**术语 SSOT（R3-A2）**：内部状态统一 `Released`（不再有 `CompletedTask.closed`，改为 `SessionEntry.released`）· 幂等键统一 `continuation_id`（全文不再以 `client_message_id` 做续聊幂等）· resume 失败统一 `resume_unavailable`（全文不再有 `context_lost` 与自动 `session/new` 降级）。

### 用户侧（本次净新增，PR #375 无）

- `commands/delegation.rs`：`continue_delegation_core` + `#[cfg_attr(feature = "tauri-runtime", tauri::command)]` 包装；`close_delegation_session_core` 同构
- `web/handlers/delegation.rs` + `web/router.rs`：对应 HTTP 端点
- `src/lib/api.ts` + `src/lib/tauri.ts`：`continueDelegation(childConversationId, message)` / `closeDelegationSession(...)`
- **幂等（R1-A6 提出 · R2-B5 修正后的终稿）**：独立的 **operation ledger**，不依附任何任务缓存。

  | 项 | 规定 |
  |---|---|
  | 键 | `continuation_id`（UUID），**必需参数，三条入口全部强制携带** |
  | 生成方 | 可重试的调用方（前端一次提交生一个并在重试时复用；MCP 由 LLM 生成）。**listener 不得代生**——那使跳过重试无法识别（R2-B5 第 1 条） |
  | 存放 | 独立 `operations: HashMap<continuation_id, OperationRecord>`，**与 `completed` / `running` 完全解耦** |
  | 覆盖阶段 | `Dispatching` / `Running` / `Settled` 全期有效（R2-B5 第 2-3 条） |
  | 重复请求 | 命中 ledger 即返回首次接受的报告，**不返回 `session_still_running`**——后者只用于「不同 `continuation_id` 撞上在跑的轮次」 |
  | 同 id 不同 payload | 返回冲突错误，不静默采用任一者 |
  | 保留期 | 跟随 `SessionEntry` 生存；session 释放或进程重启后失效（与释放语义一致） |

  三条入口的参数签名均显式包含它：MCP `continue_with_session(task_id, message, continuation_id)` · `continueDelegation(childConversationId, message, continuationId)`（Tauri + Web 同签名）。**Error Handling 表里不再提 `client_message_id`**（那是 prompt 通道的机制，与本 ledger 无关，R2-B5 第 4 条）。

## Key Functions — Formal Specifications

### `DelegationBroker::continue_delegation(...) -> DelegationTaskReport`  (新建于 `broker.rs`)

- **Preconditions**: `task_id` 非空；`message` trim 后非空；调用方持有 `parent_connection_id` 或 `parent_conversation_id` 之一可定位任务。
- **Postconditions**: 成功时返回 `status == Running` 且 `task_id` 等于入参；该 `task_id` 从 `completed` 迁回 `running`；子会话行未新增（`conversation` 表行数不变）。失败时 `completed` 缓存不被破坏性修改（`reinsert_completed` 复原）。
- **Loop invariants**: N/A（无迭代）。
- **Errors**: `session_still_running`（任务在 `running` 中）· `session_closed`（`CompletedTask.closed == true`）· `not_continuable`（无 `external_id` 且连接已死，或 agent 能力不支持）· `Unknown`（不属本 parent 且 DB 兜底也查不到）。

#### 阶段化补偿矩阵（R1-F2 采纳）

续聊不是单次状态迁移，而是五阶段编排。每个失败点的补偿动作必须明确，仅靠 `reinsert_completed` 不够：

| 阶段 | 动作 | 失败时的补偿 |
|---|---|---|
| S1 取出 | 从 `completed` 取出 entry，校验 `closed` / 归属 / `continuation_id` 去重 | 直接返回错误，entry 未动 |
| S2 选/建连接 | `is_alive` 命中则用活连接；否则 `spawn_for_resume(external_id)` | `reinsert_completed` 复原；**若新连接已创建则必须 disconnect 它**（防孤儿连接） |
| S3 登记可取消 | `register_inflight` + 检查 `take_inflight_cancel`（R3） | 同 S2；若已有取消到达则直接转 `Canceled` 并 disconnect 新连接 |
| S4 发送 | `send_followup_prompt` | `reinsert_completed` **且** disconnect 新建连接（若本轮新建）；若用的是保活连接则保留它（下次还能用） |
| S5 进入 running | `running.insert` + 从 `completed` 移除 | 不存在失败（纯内存操作，持锁） |

**活性检查后连接立即死亡**（S2 到 S4 之间）：`send_followup_prompt` 会返回错误，走 S4 补偿；不重试 resume（避免无限递归），返回可重试失败让调用方决定。

**永远停在 running 的防护**：S5 成功后轮次的终态仍由既有的 `complete_call` / `cancel_by_*` / `cancel_by_child_connection` 路径兼容（子连接死亡会触发 `f2a15698` 的 terminal error drain）——续聊轮次与首轮在这些路径上无区别。

### `DelegationBroker::finalize_delegation(...)`  (改造 `broker.rs:2740-2760`)

- **Preconditions**: 传入 outcome 已是终态。
- **Postconditions**: `outcome` 为 `Err{code == "canceled"}` 时子连接被 disconnect；其余终态子连接被保留并记入 `CompletedTask.child_connection_id`。无论哪条路径，完成事件都被 emit（保持 `3780e86e` 的既有修复）。
- **Loop invariants**: N/A。
- **Errors**: 不返回错误；`spawner.disconnect` 失败被忽略（best-effort，与现状一致）。

### `PendingInner::evict_completed_over_cap(...) -> Vec<String>`  (改造 `broker.rs:508-537`)

- **Preconditions**: 持有 `PendingInner` 锁。
- **Postconditions**: 返回被淘汰 entry 所持有的全部 `child_connection_id`（调用方在释放锁后 disconnect）；`completed_bytes` 与 `completed` / `completed_order` 三者一致。
- **Loop invariants**: 每次弹出后 `completed_bytes == Σ(completed[k].text.len())`。
- **Errors**: 无。

## Data Models

`CompletedTask`（broker 私有，`broker.rs:213-224`）新增 7 字段：`child_connection_id: Option<String>` · `parent_tool_use_id: String` · `task_preview: String` · `closed: bool` · `folder_id: Option<i32>` · `external_id: Option<String>` · `working_dir: Option<String>`。

`ChildStatusRecord`（DB 兜底）新增 4 字段：`folder_id: i32` · `external_id: Option<String>` · `parent_tool_use_id: Option<String>` · `working_dir: Option<String>`。

`conversation` 表**无 schema 变更**——续聊复用现有 `Child_Session` 行。

## Error Handling

| 场景 | 层 | 处理（稳定错误码） |
|---|---|---|
| 续聊仍在运行的任务 | broker | `session_still_running`，提示先等待或取消 |
| 续聊已关闭的会话 | broker | `session_closed` |
| 子会话无 `external_id` 且连接已死 | broker | `not_continuable` |
| `task_id` 不属本 parent | broker | `TaskStatus::Unknown`（不泄漏他人任务存在性） |
| resume 失败（`session/resume` 与 `session/load` 都不可用） | broker | **在产生任何 prompt 副作用之前**返回 `resume_unavailable`（R2-B1）。**不**自动降级到 `session/new`、**不**覆写原 `external_id` |
| MCP 参数缺失/空串 | companion | JSON-RPC `-32602` |
| 用户侧 command 幂等重放 | broker operation ledger | 命中 `continuation_id` 则返回首次报告；同 id 不同 payload 返回 `continuation_conflict` |

## Testing Strategy

TDD 红绿：broker 的保活/续聊/关闭走单元测试（`MockSpawner` 扩 `queue_followup` / `mark_dead`），**168 个既有 broker 测试必须全绿**，其中 3 处旧断言需从 `disconnects == [...]` 反转为 `disconnects.is_empty()`。前端多轮时间线走 vitest（既有骨架 `conversation-runtime-context.test.tsx` / `sub-agent-session-dialog.test.tsx`）。

属性测试目标：`evict_completed_over_cap` 的连接回收守恒（P1）与 `continue_delegation` 的行数守恒（P2）。端到端：`tests/delegation_e2e_uds.rs` / `_windows.rs` 覆盖 continue/close 往返。

**验收硬条件**（E-052）：`git grep -n "continueDelegation(" -- src/` 必须命中非 tests 的生产 caller；且真实跑一次「委托 → 等终态 → 用户侧续聊 → 主 AI `get_delegation_status` 看到新结果」的端到端。

## Correctness Properties

### Property 1: 保活连接守恒

For any sequence of delegation lifecycle operations, THE Delegation Broker SHALL ensure every child connection id that leaves the `Completed_Cache` is either handed to a disconnect call or re-registered in `running`.

**Validates: Requirements 1.4, 1.5, 5.3**

### Property 2: 续聊不增行

For any successful `continue_with_session` on an existing `Settled_Task`, THE Delegation Broker SHALL leave the count of `conversation` rows unchanged.

**Validates: Requirements 3.4**

### Property 3: 终态分流一致性

For any delegation outcome, THE Delegation Broker SHALL disconnect the child connection if and only if the outcome's wire error code equals `canceled` or the task is retired by `close_session`.

**Validates: Requirements 1.1, 1.2, 1.3**

### Property 4: task_id 稳定性

For any number of successive continuations of one `Child_Session`, THE Delegation Broker SHALL report the same `Task_Id` that the original `delegate_to_agent` call returned.

**Validates: Requirements 2.3, 4.2**

> **Session 与 Turn 的身份分离（R1-A1 提出 · R2-B3 修正后的终稿）**：`Task_Id` 是 **session 标识**，在整个 `Child_Session` 生命周期内稳定（与上游 PR #375、与父 AI 持续追踪的契约）。每次续聊产生一个**拥有独立 `turn_id` 的 turn**，记录在 `SessionEntry.turns` 里，带 origin（`User` / `ParentAgent`）。详见 §D2 的内部三层分离表。
>
> **状态单调性**：单调的是 **turn**（`Dispatching → Running → Completed|Failed|Canceled`，一个 turn 永不复活）；**session** 是 `Open ⇄ Running` 循环 + 终局 `Released`。`TaskStatus` 报告的是 session 当前状态（= 最新 turn 的结果），不是某个 turn 的墓碑。
>
> **turn_id 不上 wire**：对外仍只暴露 `task_id`，`turn_id` 仅用于 broker 内部的事件关联、幂等裁决与审计。因此内部模型正确与上游 wire 兼容不矛盾——R1 里我以「会与 #375 分叉」为由拒绍分离，那个理由不成立（R2-B3）。
>
> **既有约束的兼容验证点**（实施时必测）：① tool-call correlation 复用同一 `parent_tool_use_id` 时不得走 claim 路径（`44415f56`）；② tombstone 不得把复活的 keyed entry 当死 id（`b4569899`）。

### Property 5: 时间线历史保全

For any `Child_Session` holding N persisted turns, WHILE a continued turn is streaming, THE Sub Agent Session Dialog SHALL render at least those N turns.

**Validates: Requirements 4.7**

## Risks（三条均为上游 PR #375 漏项，必须一并修）

### R1 · 保活连接被 idle sweep 回收后静默丢上下文（最高）

`sweep_idle`（`manager.rs:527-573`）的豁免条件——status 非 Connected / 有 pending permission / 有活跃后台工作 / 未超时——保活的终态子连接**一条都不满足**，180 秒后被真实终止。续聊时 `session/load` 若失败会退化 `session/new`（`connection.rs:3414`），此时子代理失忆而用户以为在续聊，**且无任何提示**。

缓解：接受回收（D3），但在 resume 降级到 `session/new` 时必须向调用方报告上下文丢失（Requirement 3.3）。

### R2 · `evict_completed_over_cap` 淘汰致进程泄漏

`broker.rs:508-537` 直接 `completed.remove()`，不取出 `child_connection_id`。缓存是该连接的唯一持有者，淘汰后无人能回收，只能等 180 秒 idle sweep。fan-out + 大结果文本最易触发。PR #375 只在 `take_settled_child_connections` / `close_delegation_session` 处理了回收，漏了这条 FIFO 路径。

缓解：改 `evict_completed_over_cap` 返回被淘汰连接 id 列表，调用方释放锁后 disconnect（见 Key Functions 规格）。

### R3 · 续聊的注册窗口无取消覆盖

PR #375 的 `continue_delegation` 在 `send_followup_prompt` 成功**之后**才 `running.insert`，中间不 `reserve` 不 `register_inflight`。而 `cancel_by_parent*` 只扫 `running` 与 `inflight`——该窗口内的父取消会漏掉这一轮，留下脱管的运行中子进程。这正是历史上 `2a8f3211` / `6cd1f952` 两次修复的同类竞态。

缓解：续聊复用 `register_inflight`，并在 `running.insert` 前做一次 `take_inflight_cancel` 检查（Requirement 6.1/6.2）。

### 不可破坏的既有修复（侦察 §D13）

| commit | 修的是什么 | 续聊时的约束 |
|---|---|---|
| `44415f56` | tool_call_id 按 `(agent_type, task, requested_working_dir)` 精确认领，支持并行委托 | 续聊必须用 `write_meta_if_real` / `emit_started_if_real` 直接指名 tool_use_id，**不得走 claim 路径** |
| `b4569899` | 终态时 tombstone keyed tool-call entry | 续聊让同一 tool_use_id 从终态回到 running，需确认 tombstone 不把复活 entry 当死 id |
| `99657a5a` | `cancel_by_parent_turn` 保留 `consumed` 记忆 | 不得简化 `keep_consumed` 语义（Requirement 6.3） |
| `6cd1f952` / `2a8f3211` | setup 窗口取消竞态（`seq` 时钟 + `inflight` + `setups`） | 续聊不参与 spawn→park 窗口，但必须自己注册可取消（R3） |
| `f2a15698` | 非终态 `Error` 不当终态 | 保活期间子进程自死时 `completed` 里的连接 id 变幽灵，靠 `is_alive` 事后发现——不能省这个检查 |
| `3780e86e` | 每条终态路径都 emit 完成事件 | 首轮委托的完成事件保持不变；**续聊轮次不再对同一 `parent_tool_use_id` 重发 completion**（R2-B2 · Requirement 2.8a），改为 T4.3 的 session-scoped 更新事件。（本行原文"续聊完成需再次 emit"为 R1 时代表述，R3 后由 W3 executor 发现矛盾，2026-07-26 修正——H-006 实例）|

### 本地分支特有风险

`feat/kiro-agent` 引入 `AgentType::Kiro`（`SystemBinary` 分发）。若 kiro-cli 不支持 `session/load` / `session/resume`，对 Kiro 子代理续聊会退化冷启动。需在实施时实测 Kiro 的 resume 能力，不支持则续聊返回 `not_continuable`（而非静默丢上下文）。

## 交付分层与里程碑

**M1（方案 0 · 零后端）**：子会话可发现性——`isDelegationSubsession` / `Sub` 徽标 / 漏斗开关 / Dialog「在标签页打开」按钮。

> **M1 的能力边界（R1-A7 采纳）**：M1 **只提供浏览与打开能力，不宣称实现共享续聊**。从完整标签页发出的消息绕过 broker，主 AI 感知不到——这个限制必须写进 M1 的 UI 文案（在标签页打开时提示「此处发送不会同步给主 AI」），不得靠用户自己发现。
>
> **M2 后的统一路由**：M2 交付后，**子会话标签页的发送也路由到 broker**（`ConversationDetailPanel` 检到 `parent_id != null` 且该会话属于一个已知 `task_id` 时，改走 `continueDelegation` 而非裸 `acpPrompt`），消除双写入口。这是 M2 的**必交项**而非可选项——否则两个写入口长期并存，直接破坏声明的 SSOT。
> 过渡期（M1 已交付、M2 未完）的双写入口是**显式登记的技术债**，记入 `ARCHITECTURE.md` 债务段，随 M2 清除。

**M2（方案 1 · 完整）**：保活状态机 + 续聊契约 + 用户侧入口 + 多轮时间线。父 AI 与用户共享同一 `task_id` 视图。

M1 的价值不依赖 M2 落地；M2 若中途受阻，M1 已交付的部分仍然有用。

## 验收追踪矩阵（R1-F4 采纳）

每条需求必须有可回归证据，不能只靠 broker 既有 168 测试全绿。

| Requirement | 验收方式 | 关键负向用例 |
|---|---|---|
| 1 保活与销毁分流 | broker 单测（3 处旧断言反转 + Property 3） | 取消态仍 disconnect；父拆除回收全部保活连接 |
| 1.5 淘汰回收 | broker 单测（Property 1） | 字节淘汰与数量淘汰两条路径都 take 连接 id |
| 2 MCP 续聊/关闭 | listener/companion 单测 + `tests/delegation_e2e_uds.rs` | `session_still_running` / `session_closed` / 空 message |
| 2.13 幂等 | broker 单测 | 同 `continuation_id` 重放只发一轮 |
| 2.9-2.12 close 状态表 | broker 单测 | running 态 close 先取消；重复 close 幂等；close 与 continue 并发 |
| 3 resume 恢复 | broker 单测（MockSpawner `mark_dead`）+ 手工端到端 | 无 `external_id` → `not_continuable`；resume 链不可用 → `resume_unavailable` **且无 prompt 副作用、`external_id` 未被覆写** |
| 3.4 不增行 | broker 单测（Property 2） | 续聊前后 `conversation` 行数相等 |
| 4 用户入口 | Web handler 单测 + vitest 组件测 + **一次真实端到端** | 拒绝时错误码上屏；`get_continuation_availability` 五档 |
| 4.7 历史保全 | vitest（Property 5） | 第二轮流式时第一轮历史仍在 |
| 5 资源边界 | broker 单测 | 超 `kept_alive_cap` 时 FIFO 淘汰；淘汰后仍可 resume |
| 6 取消覆盖 | broker 单测（R3） | S3/S4 窗口内父取消能捕获该轮 |

**授权验收（R1-A3 的实际范围）**：codeg 是单用户单租户（全仓 `tenant` 零命中，`conversation` 表无 `user_id`/`workspace_id`，server 模式为单个全局 `CODEG_TOKEN`）。故不引入租户模型，但仍需两条负向用例：① 传入不存在的 `child_conversation_id` → 返回 `Unknown`（不泄漏存在性）；② 传入一个 `parent_id` 为 null 的普通会话 id → 拒绝（不能把普通会话当子代理续聊）。

## Update Log

### R1 · 2026-07-26 · codex 第一轮评审（NEEDS_CHANGES · P0=3 / P1=8）

评审产物 `review.codex.md`。逐条处置：

| Issue | 处置 | 依据 |
|---|---|---|
| A1 Session/Turn 身份未分离 | 🟡 **改法不同** | 结论成立（同一 `task_id` 反复复活确实压缩了两个概念），但**不引入新 `DelegationSession` 聚合类型**——那会与 PR #375 的 `task_id` 契约分叉，违背 D2 的零冲突目标。改为在 Property 4 下明确「`task_id` = session id，`RunningTask` 承担 turn 身份」，并写清单调的是 turn 而非 session |
| A2 broker 内存态不能当跨重启真源 | 🟡 **改法不同** | 前半成立，已加「持久领域状态 vs 可重建运行态索引」两层划分。但**拒绝持久化 `closed`**（deferred）：要给 `conversation` 加列，而收益只覆盖「重启后误续聊一个已关闭会话」这一低危场景（后果是多起一个子代理，非数据损坏）。改为显式声明能力边界，删掉跨重启暗示 |
| A3 缺租户/对象级授权 | 🔴 **部分驳回** | 核实：codeg 单用户单租户，`git grep tenant` 全仓零命中（仅 lark 后端无关用法），`conversation` 表无 `user_id`/`workspace_id`，server 鉴权是单个全局 `CODEG_TOKEN`（持有即全权）。引入 tenant→parent→child 归属链是为不存在的多租户场景加防御（§0.17 D 类）。**采纳其可落地的部分**：不泄漏存在性 + 拒绝把普通会话当子代理，已写入验收矩阵 |
| A4 idle sweep 不构成容量上限 | 🟢 **采纳** | 结论正确且我原设计有洞：`completed_cache_cap_bytes` 只管文本字节，大量短结果任务能绕过。已加 `kept_alive_cap`（全局 + 每父会话两层 FIFO） |
| A5 恢复能力按 agent 差异建模 | 🟢 **采纳** | 已加 D3.1：四档 continuation capability，禁止靠失败探测 |
| A6 幂等键未贯穿 | 🟢 **采纳**（修正其一处事实） | `client_message_id` 确实存在于 `web/handlers/acp.rs:160/176`，但只覆盖 prompt 通道、未贯通 MCP，不能充当续聊幂等键——A6 结论成立。已定义 `continuation_id` 三入口统一 |
| A7 M1 双写入口破坏 SSOT | 🟢 **采纳** | 已明确 M1 只提供浏览/打开、UI 文案须写明「此处发送不同步给主 AI」，并把「M2 后标签页发送统一路由到 broker」列为 M2 必交项 + 过渡期债务登记 |
| F1 close 状态表缺失 | 🟢 **采纳** | requirements 2.9-2.12 补齐五态行为 + 并发裁决 |
| F2 续聊失败回滚不完整 | 🟢 **采纳** | 已加五阶段补偿矩阵，明确「新建连接后发送失败必须 disconnect 它」 |
| F3 可续聊性查询悬空 | 🟢 **采纳** | D4 落成 `get_continuation_availability` 五档枚举 + 刷新时机 |
| F4 验收追踪不足 | 🟢 **采纳** | 本节验收矩阵 |
| F5 「上下文丢失」无机器契约 | 🟢 **采纳** | 已定为结构化 `context_lost: true` + 明确副作用（消息已发送、复用原行、更新 external_id） |
| F6 场景偏抽象 | 🟡 **部分采纳** | 单用户前提下「谁可以关闭」不是问题。已在 A7 处置里补「主 AI 如何获知用户续聊结果」= 复用既有 `delegation_completed` 事件 + `get_delegation_status`，不新建通知通道 |

### R2 · 2026-07-26 · codex 第二轮评审（NEEDS_CHANGES · P0=3 / P1=3 · 反向验证）

评审产物 `review2.codex.md`。**本轮推翻了 R1 的两处处置**，采纳其推荐的「局部重构」路径。逐条处置：

| Issue | 处置 | 依据 |
|---|---|---|
| B1 冷启动伪装成功续聊 | 🟢 **采纳 · 推翻 R1-F5 的处置** | 核实 `update_external_id`（`lifecycle.rs:189`）是 `SessionStarted` 到达时的**无条件覆盖**——原设计的 `context_lost: true` 会真的覆盖掉原 `external_id`，恢复凭据永久丢失。且「消息已发出才告知上下文没了」用户无法撤回。改为 resume 失败时**在产生 prompt 副作用前**返回 `resume_unavailable`，不自动降级、不覆盖 `external_id` |
| B2 复用已完成 `parent_tool_use_id` 发新完成事件 | 🟢 **采纳** | 核实 PR #375 的 continue 只调 `emit_started_if_real`（`pr375.patch:647`），**没有** `emit_completed_if_real`——但我的 Requirement 2.8 原文写的是「emit 完成事件携带原 `parent_tool_use_id`」，比上游更激进且破坏 tool-call 一次性完成契约（`b4569899` tombstone 的前提）。改为 session-scoped 更新事件带 `Turn_Id` + origin；明确产品契约是「主 AI 下次查询时可见」而非「主动通知」 |
| B3 用上游字段布局约束内部领域模型 | 🟢 **采纳 · 推翻 R1-A1 的处置** | R1 我以「会与 #375 分叉」为由拒绝 Session/Turn 分离——**这个理由不成立**：#375 约束的是 wire，Session/Turn 分离可完全局限在 broker 内部，用 facade 映射回上游报告结构。已加内部三层分离（Session / Turn / Operation）并把 `Completed_Cache` 职责收窄为「只缓存结果文本」，不再决定 session 是否存在或可续聊 |
| B4 `close_session` 语义不成立 | 🟢 **采纳（选「资源释放」一档）** | R1 我把「重启后重新可续聊」辩解为可接受限制，但工具名和 UI 都叫「关闭/退役」，名实不符。改为统一表述为**释放**（内部状态 `Released`），wire 工具名因兼容保留 `close_session` 但描述/文案三处统一改。永久停用的路径是删除会话行 |
| B5 幂等未形成闭环 | 🟢 **采纳** | 它列的 5 条子问题全部成立，尤其「listener 代生成 UUID 使跨请求重试无法识别」和「去重记录随 `CompletedTask` 生存但 dispatch 后任务已迁入 `running`」。改为独立 operation ledger，`continuation_id` 变必需参数、禁止 listener 代生，覆盖 dispatching/running/settled 全期 |
| B6 父连接被当作子会话所有者 | 🟢 **采纳** | 与 D5 同源但更彻底。父连接拆除只释放运行租约，不再无条件 disconnect 保活连接；回收统一交给 `kept_alive_cap` + idle sweep。已改 Requirement 1.4 并新增 1.4a（父 conversation 删除才释放） |

**路径决策**：采纳 R2 推荐的**局部重构**——保留 `task_id` 与外部 wire 兼容，内部拆分 session/turn/operation，活连接复用降级为纯优化。拒绝完整领域重构（持久 Session/Turn + 事件 inbox/outbox）：需要 schema 迁移，而当前产品契约只要求「主 AI 下次查询可见」，不要求主动通知与跨重启审计。

**R2 明确的停止项，已全部执行**：不再自动 `session/new` 后按成功处理 · 不再对已完成 `parent_tool_use_id` 重复发 completion · `Completed_Cache` 不再承担 session 生命周期 · 三项换路完成前不铺更多 UI/transport 分支（M1 因此只保留浏览+打开，不含输入框）。

## R3 采纳项：生产边界补充

### 部署边界（R3-A1 / A6 · 本期硬约束）

**本期强制「一实例一用户一全局 token」**。这不是从现状推断出的默认，而是显式的部署门禁：

- 配置校验：server 启动时若检测到多账户配置意图（未来引入 account/workspace 概念时），拒绝启动并提示本功能不支持。
- 部署文档与 UI 显式声明：`CODEG_TOKEN` 持有者即全权用户，不要把一个实例共享给多人。
- 归属校验仍按稳定领域键做（parent conversation id），不依赖部署假设——这样将来引入 account scope 时，只需在边界层加一层 scope 检查，不必重做归属链。

**若未来该约束被打破，用户侧入口必须先补 account/workspace scope 才能继续开放**（R3-A6 的裁决点，已记入 §Risks）。

### 服务重启后的续聊（R3-A1 · P0 唯一项）

**承诺范围**：重启后**仍可续聊**，但走 `Resume_Path`（不可能保住活连接）。因此必须有启动重建协议：

| 阶段 | 规则 |
|---|---|
| 扫描条件 | 启动时扫 `conversation WHERE kind=Delegate AND deleted_at IS NULL AND external_id IS NOT NULL`，按 `parent_id` 分组重建 `SessionEntry` |
| 归属校验 | 逐行校验 `parent_id` 指向的父会话仍存在且未软删除；不满足则该行不进索引（标记 `not_continuable`，可观测） |
| Turn 历史 | **不重建**——重启后 `turns` 队列为空，`TaskStatus` 由 DB 行的 `status` 列推出。轮次级审计不跨重启（明确不承诺） |
| operation ledger | **不跨重启复用**。重启后旧 `continuation_id` 一律视为未见过；重复的旧请求会真的执行第二次。这是接受的限制——跨重启幂等需要持久化 ledger，属 deferred |
| 重建期间的并发请求 | 重建未完成时到达的续聊请求返回 `rebuilding`（新增可重试状态），而非 `Unknown`——避免用户误以为会话丢了 |
| 重建失败隔离 | 单行重建失败只影响该行（进入可观测的 `not_continuable`），不阻塞整个 broker 启动 |
| 恢复并发锁 | 复用 `spawn_agent` 已有的 per-`(agent, working_dir, session_id)` dedup 锁（`manager.rs:419-435`），防同一子会话被并发恢复出两条连接 |

### external_id 的完整性约束（R3-A3）

**核实结论**：`conversation.external_id` **无唯一约束、可为 NULL、可被 `update_external_id` 无条件覆盖**（`conversation.rs:55`，migration 中无 UNIQUE 索引）。因此它**不是**天然可信的恢复凭据，resume 前必须做绑定校验：

- 三元校验：恢复时要求 DB 行的 `agent_type` / `folder_id`（→ working_dir）与待恢复目标一致；任一不匹配 → `not_continuable`，不尝试恢复。
- 重复 `external_id`：若同一 `external_id` 被多行引用（历史数据可能存在），按 `parent_id` + `delegation_call_id` 精确定位；仍无法唯一确定 → 拒绝恢复而非猜测。
- 过期/旧版本 session id：`session/resume` 与 `session/load` 都失败即视为过期 → `resume_unavailable`（不静默冷启动）。
- **开工前必做数据画像**：统计现有 `kind=Delegate` 行中 `external_id` 为 NULL / 重复 / 对应 agent 已卸载的数量，写入 tasks.md 的开工核验项。

### 事件版本与乱序（R3-A4）

`SessionEntry` 增加单调 `turn_version: u64`（每次 dispatch +1）。session-scoped 更新事件携带 `(task_id, turn_id, turn_version, origin)`：

- 前端与主 AI 按 `turn_version` 丢弃旧事件（防旧结果覆盖新结果）。
- 检测到版本缺口（收到 v5 但上次是 v3）→ 回查 `get_delegation_status` 回源，**查询是状态真源，事件只做增量通知**。
- 重复事件（同 `turn_version`）幂等忽略。

### close/cancel 的部分失败（R3-A5）

`close_delegation_session` 的阶段与最终一致性：

| 阶段 | 失败处理 |
|---|---|
| 取消运行中的 turn | 取消确认超时（建议 5s）→ 不阻塞，标记 `release_pending` 并转后台回收 |
| disconnect 子连接 | 失败 → 后台重试（复用既有 best-effort 语义），标记可观测的 `orphan_suspect` |
| 标记 `released` | 纯内存操作，不会失败 |
| 重启后的孤儿 | 启动重建时扫描：DB 有 `kind=Delegate` 行但无对应活连接的，不做任何事（进程已随重启消失）；真正的孤儿是「重启前 disconnect 失败且进程仍活」，由 `parent_watcher` 的 `--parent-pid` 看门狗兜底（子进程随 codeg 主进程消失） |

调用方拿到 close 失败时**可安全重试**（幂等：已 `released` 的会话再 close 返回同一结果）。
