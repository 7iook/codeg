# Task Tracker · 常驻子智能体观察面板

> **What this is** — 本工作的 LIVING 执行清单。执行者读它、实时勾选、在条目下记录改了什么。「已完成 / 剩余 / 阻塞」的唯一真源。保持当前；禁止批量补勾。

| 字段 | 值 |
|---|---|
| 来源 Source | `docs/specs/subagent-observatory/design.md`（status: converged · 3 轮 codex 评审 P0 6→3→2→0） |
| 类型 Type | feature |
| 创建 Created | 2026-08-03 |
| 状态 Status | in-progress — **实现已全部接线并对用户可见**（常驻条 → 面板 → 行 → 取消全链路通；见 6.6 接线硬门证据）。剩余：7.1 端到端人工验收 + 修复实现复审的 Critical 1（续聊终态误报） |

**图例 Legend**: `- [ ]` 待办 · `- [x]` 完成（必须带证据） · 行尾 `— ⛔ BLOCKED:<原因>` / `— ⏭ SKIPPED:<理由>` / `— ⏳ PENDING:<原因>`

## Overview

四层递进：**P0 broker 归属修复**（不修则取消恒不可用，且 `get_delegation_status` 对账也走同一口径）→ **P1 数据层**（两 Provider 投影 + 事件带会话 id + 纯 selector）→ **P2 取消全链路**（依赖 P0）→ **P3 UI**（依赖 P1/P2）。

P0 与 P1 无交叉文件，可并行。

## Tasks

### 1. broker 归属口径统一（P0 · 全局前置 · §5.3 同根三处）

- [x] 1.1 读 git history 确认原意图
  - `git log -S"Ownership (D5)" -- src-tauri/src/acp/delegation/broker.rs` → 确认 `2505e164` 为唯一引入点，cancel 分支为遗漏非设计
  - _Requirements: 1.1_
  - **Evidence**: `commit a07792198d2f04125b1de897113fc881c2b13174` · `verify: git log -S"Ownership (D5)" --oneline -- src-tauri/src/acp/delegation/broker.rs → 1 行输出（2505e164）· EXIT=0` · `files: src-tauri/src/acp/delegation/broker.rs:5099-5108（既有 D5 判定，只读）` · `AC: R1.1`
  - ✅ 2026-08-03: 史料确证同一 commit 内为 `continue_delegation` 写了 D5 判定、给 cancel 加了 `parent_conversation_id` 参数、也加了两个 cancel 测试（但都传真实连接 id，从未覆盖用户侧路径）→ 参数在、用法漏，遗漏而非设计取舍。
- [x]* 1.2 写失败测试（red）
  - `broker.rs` mod tests，改造基点既有 `cancel_task_by_id` 用例（`:6443` / `:7152` 现均传真实 `"parent-conn"`）
  - 新用例：以 `USER_ENTRY_CONNECTION_ID` + 匹配的 `parent_conversation_id` 取消一个运行中任务 → 当前必返 `unknown`
  - 第二用例：`get_tasks_status` 同凭据 → 当前必返 `unknown`
  - **Property 4: 归属校验的单调性** · **Property 5: 跨入口口径一致性** _Validates: Requirements 1.1, 1.2, 1.4, 1.5, 1.6, 1.7_
  - _Requirements: 1.1-1.7_
  - **Evidence**: `commit a07792198d2f04125b1de897113fc881c2b13174` · `verify: cd src-tauri; cargo test --no-default-features --bin codeg-server --lib user_entry_ → 2 failed, 1 passed · EXIT=101`（失败断言原文 `left: Unknown / right: Canceled` 与 `left: Unknown / right: Running`）· `files: src-tauri/src/acp/delegation/broker.rs:6394-6402 / :6438-6446 / :6478-6486（3 个新测试的断言处）` · `AC: R1.1-R1.7`
  - ✅ 2026-08-03: 红灯确认失败原因是缺陷本身（非编译/断言错）。第三条「外来 conversation_id 必须被拒」一开始就通过 → 证明测试没把门开太大。
- [x] 1.3 最小实现（green）
  - `cancel_task_by_id` 两处 + `classify_locked` 两处归属判定改为 D5 口径（`classify_locked` 经新增的 `owned_by`；cancel 内联同规则 —— 完整收敛见 1.5）
  - `classify_locked` 加 `parent_conversation_id: Option<i32>` 形参；`get_tasks_status` 唯一调用点透传
  - 保留「判定不通过 → `unknown_report` 不泄露存在性」语义
  - _Requirements: 1.1-1.7_
  - **Evidence**: `commit a07792198d2f04125b1de897113fc881c2b13174` · `verify: cd src-tauri; cargo test --no-default-features --bin codeg-server --lib user_entry_ → 3 passed; 0 failed · EXIT=0` · `files: src-tauri/src/acp/delegation/broker.rs:1938-1952（owned_by）· :1966-1995（classify_locked 两分支）· :4953-4972（cancel 路径内联同规则）· :4804-4806（get_tasks_status 透传）` · `AC: R1.1-R1.7`
  - ✅ 2026-08-03: **归属源修正**——初始实现假设 `CompletedTask` / `RunningTask` 持有 `parent_conversation_id`，实测二者都没有（`grep struct CompletedTask` 确证），真正持有它的是 `SessionEntry`（`sessions` map，`continue_delegation` 亦从此读）。改为从 session 注册表查，与既有 D5 样板同源。cancel 路径另因借用检查（`owned_by` 借 `inner` 而 `completed.get()` 已持不可变借用）改为先取快照值再判定。
  - ⚠️ **审查驳回了本条的初版措辞（Important 1）**：初版写「统一收敛进共享 `owned_by`」不准确 —— 当时 `owned_by` 只被 `classify_locked` 调用，cancel / continue 仍各自内联。**已由 1.5 真正收敛**（并额外发现第四处 `close_delegation_session`）。
- [x] 1.4 Checkpoint — Rust 全绿
  - _Requirements: 1.1-1.7_
  - **Evidence**: `commit a07792198d2f04125b1de897113fc881c2b13174` · `verify: cd src-tauri; $env:NO_PROXY='127.0.0.1,localhost'; cargo test --no-default-features --bin codeg-server --lib → 2236 passed; 0 failed; 1 ignored · EXIT=0` · `files: 同 1.3` · `AC: R1.1-R1.7`
  - ✅ 2026-08-03: 全量回归零失败 —— 归属口径放宽未破坏任何既有 delegation/cancel 测试。
  - ⚠️ **`NO_PROXY` 不是可省的（审查复跑与本轮出现 2235 vs 2236 的差异，根因已定位）**：不设该变量时 `chat_channel::webhook::tests::post_one_reports_non_2xx` 会失败——它自起一个 `127.0.0.1` 随机端口监听并断言错误含 `500`，而 `make_webhook_client()`（`src-tauri/src/chat_channel/webhook.rs`）用 `reqwest::Client::builder()` 默认配置、**继承系统代理环境变量**，于是请求被本机代理（7897）截走返 502。与 delegation 无关的环境依赖既有 flaky。**同一份代码在两种环境下给出两个数字**，故 Evidence 必须连同环境变量一起记，否则复现者会误判。
  - ⚠️ **两处环境约束（非本次改动引入，已核实）**：① 桌面 feature（`--features test-utils`）在新建 worktree 里构建失败，因缺 `../out` 前端产物与 sidecar 占位，与代码无关；已改用 `--no-default-features` 服务器目标作为等价门。② `cargo clippy --no-default-features -- -D warnings` 报 3 个 `dead_code` 错误，全在 `src-tauri/src/acp/connection.rs:2300/2321/2333` 的 steer 函数——该文件在本工作树零改动（`git diff --stat` 空），且 `git grep` 确证这三个函数只被测试引用、无生产 caller，属基线既有债，不在本需求范围。

- [x] 1.5 归属规则完整收敛（审查 Important 1 的兑现点）
  - 四处（而非三处）内联实现全部收敛进纯函数 `owned_by`：`classify_locked` / `cancel_task_by_id` / `continue_delegation` / **`close_delegation_session`**
  - _Requirements: 1.1-1.7_
  - **Evidence**: `commit b369b14c0242cb3edba6d105fe5771f80f99a9b9` · `verify: git grep "let owned = match parent_conversation_id" → 零命中`；`git grep "owned_by(" → 1 定义 + 6 调用点（:1977 / :1989 / :4961 / :4978 / :5117 / :5641）`；`cd src-tauri; $env:NO_PROXY='127.0.0.1,localhost'; cargo test --no-default-features --bin codeg-server --lib → 2236 passed; 0 failed; 1 ignored · EXIT=0` · `files: src-tauri/src/acp/delegation/broker.rs:1948-1957（owned_by）+ 6 个调用点` · `AC: R1.1-R1.7`
  - ✅ 2026-08-03: **我漏数了一处** —— 除 review 指出的 cancel / continue 两处，`close_delegation_session`（原 `:5626`）是第四份内联副本，同样有漂移风险，已一并折入。
  - ⚠️ **`None` 分支在四处并非同一规则（已亲验，故未按 review 建议实现）**：review 建议「helper 内部读取 session 的连接 id」，但实测 `classify_locked` / `cancel` 比的是**任务记录**上的连接（`CompletedTask` / `RunningTask` 的 `parent_connection_id`），而 `continue` / `close` 比的是**会话运行租约**（`SessionEntry.parent_connection_id`，且 `continue` 在派发时会重新赋值，见 `:5157`）。二者是不同事实；若让 helper 读单一「规范」连接 id，会静默改变其中两处的行为。最终实现把两个输入都做成参数，只共享真正共享的那部分（先会话 id、无会话上下文才回退连接 id 的判定），把「比哪个连接」的选择留在调用点并加注释说明。

### 2. 委托侧数据层（P1 · 可与 1 并行）

- [x]* 2.1 写失败测试（red）
  - `src/contexts/delegation-projection.test.tsx`（新文件，未复用既有 test 以免与其断言纠缠）：投影列全部条目 / 完成后不移除 / 上限只淘汰终态
  - **Property 6: 已完成条目在存续期内不丢失** _Validates: Requirements 2.2, 2.4_
  - _Requirements: 2.1-2.4, 2.12-2.13_
  - **Evidence**: `commit 3db02b48e80e32650ad5e3229b5603512b0b0ef9` · `verify: npx vitest run 四个新测试文件 → 38 passed (38)`（先确认红灯 `13 failed`，失败原因为 `listBindings is not a function`）· `files: src/contexts/delegation-projection.test.tsx（7 tests）` · `AC: R2.1-R2.4, R2.12-R2.13`
  - ✅ 2026-08-03: 上限测试特意让条目「结算顺序 ≠ 插入顺序」，故能真正区分「按终态到达时间淘汰」与「按插入序淘汰」。
- [x] 2.2 事件携带 `parent_conversation_id`（双 producer 同构 · BS-025 补偿动作）
  - 后端：`AcpEvent::DelegationStarted`（`acp/types.rs`）加 `parent_conversation_id: i32`；`emit_started_if_real` + 两调用点 + `DispatchPlan` + `event_emitter.rs` trait 与 3 个 impl
  - 前端 seed：`delegation-seed.ts` 增第 4 参；**并补 `SnapshotPatch` 的 `conversationId` 投影**（见下方修正）
  - _Requirements: 2.5-2.8_
  - **Evidence**: `commit 3db02b48e80e32650ad5e3229b5603512b0b0ef9` · `verify: cargo test --no-default-features --bin codeg-server --lib acp::delegation → 325 passed; 0 failed`（含 DelegationStarted wire 断言）+ `npx tsc --noEmit → 0 errors` · `files: src-tauri/src/acp/types.rs · acp/delegation/{event_emitter.rs,broker.rs} · src/lib/{types.ts,delegation-seed.ts,snapshot-denormalize.ts} · src/contexts/acp-connections-context.tsx` · `AC: R2.5-R2.8`
  - ⚠️ **spec 的 C1 处置写错了一处链路，已在实现中修正（BS-025 第三次实证）**：spec 称「seed 直接用快照自身 `conversation_id` 填充，与它现在填 `parent_connection_id` 同一手法」——**后半句对、前半句错**。实测 `SnapshotPatch`（`src/lib/snapshot-denormalize.ts:33-95`）**根本不投影 `conversation_id`**，而三个 seed 消费点吃的是 `patch` 而非原始 wire 快照；`parent_connection_id` 能工作只因 `connectionId` 被投影了（`:111`）。不补这一跳，回放 producer 会给每个条目静默塞 `null`，每次重连都把活跃委托变成「未归属」——正是本任务要防的「只有一个 producer 拿到值」。已补 `conversationId` 到 `SnapshotPatch`（`:46` / `:119`）。
  - ⚠️ 另两处 spec 轻微失准（已按实际实现）：① `DelegationRequest.parent_conversation_id` 是 `i32` 非 `Option<i32>`，故 wire 字段为平坦 `i32`（仅旧后端缺省）；② spec 写的「三个 seed 调用点」实为**同一个包装器的三个调用点**，`buildDelegationSeedEnvelopes` 真实调用点只有 `acp-connections-context.tsx:3824` 一处（已 `git grep` 复核）。
- [x] 2.3 投影 + 条目上限
  - `delegation-context.tsx`：加只读投影；`byToolUseId` 加上限 **256**，仅淘汰终态
  - _Requirements: 2.1-2.4, 2.12-2.13_
  - **Evidence**: `commit 3db02b48e80e32650ad5e3229b5603512b0b0ef9` · `verify: delegation-projection.test.tsx → 7 passed` · `files: src/contexts/delegation-context.tsx（+107 行）` · `AC: R2.1-R2.4, R2.12-R2.13`
  - ✅ 2026-08-03: 当全部条目均为 running 时，容许 map 超过 256 而**不**淘汰活跃委托（R2.13 明令禁止淘汰运行中条目）——该行为已被测试锁定，是有意取舍不是漏洞。

### 3. 内部 SUB 数据层（P1）

- [x]* 3.1 写失败测试（red）
  - `src/contexts/subagent-projection.test.tsx`（新文件）
  - 断言：投影列全部 / `session_id` 被保留 / 淘汰计数递增 / **`conversationId` 不在条目上**（锁定 B8：Provider 不得缓存派生归属）
  - _Requirements: 3.1, 3.2, 3.6-3.9_
  - **Evidence**: `commit 3db02b48e80e32650ad5e3229b5603512b0b0ef9` · `verify: subagent-projection.test.tsx → 6 passed` · `files: src/contexts/subagent-projection.test.tsx` · `AC: R3.1, R3.2, R3.6-R3.9`
- [x] 3.2 保留 `session_id` + 淘汰计数
  - `handleEnvelope` 读取并保留 `envelope.session_id`（原先丢弃）；每条目记最后一帧时刻；暴露只读投影 + 累计淘汰计数（作用域 = 工作区）
  - **不在 Provider 内解析归属**（B8）
  - _Requirements: 3.1, 3.2, 3.6-3.10_
  - **Evidence**: `commit 3db02b48e80e32650ad5e3229b5603512b0b0ef9` · `verify: subagent-projection.test.tsx → 6 passed`（含 `evicted_count_is_cumulative_across_the_provider_lifetime`）· `files: src/contexts/subagent-transcript-context.tsx（+72 行）· src/lib/subagent-transcript.ts（新增 SubagentTrackedEntry）` · `AC: R3.1, R3.2, R3.6-R3.10`
  - ✅ 2026-08-03: 淘汰计数用 ref 承载、**不触发 re-render** —— 与该 Provider 既有设计注释一致（provider 级 state 会导致每帧重渲染消息子树）。面板通过 R6.5-R6.7 的定时重算读取它。

### 4. 行模型 selector（P1）

- [x]* 4.1 写失败测试（red · 属性测试为主）
  - _Requirements: 3.3-3.5, 4.1-4.9_
  - **Evidence**: `commit 3db02b48e80e32650ad5e3229b5603512b0b0ef9` · `verify: observed-sub-agents.test.ts → 19 passed` · `files: src/lib/observed-sub-agents.test.ts` · `AC: R3.3-R3.5, R4.1-R4.9`
  - ✅ 2026-08-03: 项目无 `fast-check`，改用 mulberry32 播种的确定性属性扫描（可复现）。Property 7 断言映射「缺→有→缺」往返，证明未缓存；Property 8 含未来时间戳帧。
- [x] 4.2 实现纯 selector（green）
  - _Requirements: 3.3-3.5, 4.1-4.9_
  - **Evidence**: `commit 3db02b48e80e32650ad5e3229b5603512b0b0ef9` · `verify: observed-sub-agents.test.ts → 19 passed` + `npx tsc --noEmit → 0 errors` · `files: src/lib/observed-sub-agents.ts（新）` · `AC: R3.3-R3.5, R4.1-R4.9`
  - ⚠️ `UNKNOWN_AGENT_LABEL` 目前是内部占位字符串 `"sub-agent"`，**P3 必须替换为 i18n 文案**，不得原样上线。

> ⚠️ **P1（第 2/3/4 组）的集成状态 — 审查 Critical 3 处置（部分采纳）**
>
> 审查指出：`listBindings()` / `listEntries()` / `getEvictedCount()` / `buildObservedSubAgentRows()` 全仓**无生产 caller**，仅定义与测试命中（已复核成立）。其结论是「P1 不得标 `[x]`」。
>
> **事实采纳，结论按分层交付调整**：本 spec 的依赖图（见文末 waves）自始把消费者定在第 6 组（P3 UI，wave 5-6），P1 是纯数据层，**按设计就不该有 caller**。若因此不许勾选，则任何分层交付的下层都无法标完成。故：
> - 第 2/3/4 组保持 `[x]` = 「本层实现与验证完成」，**不代表用户可见**；
> - 交付层面的「真接入」由 **7.1 端到端** 与下方新增的 **6.6 接线硬门** 承担；
> - 在 P3 完成前，本功能对用户不可见 —— 这一点记入 Status 行，不靠读者推断。
>
> **E-052 防线**：6.6 要求 `git grep` 证明四个 API 各有非测试 caller，且 7.1 必须真跑一次端到端，否则第 6 组不得标完成。

> **第 4 组涉及的 Property 全表**（实现已覆盖，见上方 4.1/4.2 Evidence）：
> **Property 1** 两维度归类完备 + 投影确定 _Validates: R4.5-R4.9, R6.1-R6.3_ · **Property 2** 内部 SUB 操作能力恒受限 _Validates: R4.3, R7.4_ · **Property 3** 字段缺失全域封闭 _Validates: R4.4, R3.4_ · **Property 7** 归属对映射到达时序无关 _Validates: R3.3-R3.5_ · **Property 8** 内部 SUB 永不获得终态 _Validates: R3.11-R3.13_
>
> selector 入参（单一对象）：`{ delegations, subagents, currentConversationId, conversationIdByExternalId, now, silenceThresholdMs }` —— 归属与生命周期判定所需的一切从入参进，不读模块外全局状态。

### 5. 用户侧取消全链路（P2 · ⛔ 依赖 1 完成）

- [x]* 5.1 写失败测试（red · **必须有一条不 mock broker**）
  - _Requirements: 8.1-8.3_
  - **Evidence**: `commit 31f0daae` · `verify: cd src-tauri; $env:NO_PROXY='127.0.0.1,localhost'; cargo test --no-default-features --bin codeg-server --lib delegation → 420 passed; 0 failed · EXIT=0` · `files: src-tauri/src/commands/delegation.rs:835（NotFound 分支）· :854（NotASubsession）· :909（真 broker happy path）` · `AC: R8.1-R8.3`
  - ✅ 2026-08-03: 那条真 broker 用例是**真 spawn + 真 DB 子行 + 断言子连接被 teardown**（`mock.disconnects` 含 `child-conn-cancel`），并显式注释「此处若得到 `Unknown` 即归属校验回退」。mock 掉 broker 的写法会在 `a0779219` 之前的缺陷下全绿 —— 这条用例正是那个形态的反面。
- [x] 5.2 `cancel_delegation_core` + 双模包装 + **对账查询（R7.11-R7.13）**
  - _Requirements: 8.1-8.8, 7.11-7.13_
  - **Evidence**: `commit 31f0daae` · `verify: 同 5.1（420 passed）`；`npx prettier --check src/lib/api.ts → 通过` · `files: src-tauri/src/commands/delegation.rs:389（cancel_core）· :546（Tauri command）· :421+（get_delegation_task_status_core）· src-tauri/src/lib.rs:1127-1128（注册 ×2）· src-tauri/src/web/router.rs:81-86（路由 ×2）· src-tauri/src/web/handlers/delegation.rs · src/lib/api.ts:4094 / :4107` · `AC: R8.1-R8.8, R7.11-R7.13`
  - ✅ 2026-08-03: SUB 除 cancel 外**一并做了读侧对账查询**（`StatusWait::Immediate` 不阻塞 —— UI 驱动的对账须即答，long-poll 模式是给等结果的 LLM 通道用的）。两条通道各自的 command 注册 / HTTP 路由 / 前端客户端均已落齐，transport 层零改动。
  - ⚠️ **两个前端函数用了钩子逃生口 `gate:allow-unwired`（附理由）**：`cancelDelegation` / `getDelegationTaskStatus` 目前零生产调用点，消费者是 6.3（行操作 + 对账触发），而 **6.3 依赖 6.2 的行渲染** —— 这是真实前序依赖，不像 6.1 那样可以提前。Rust 侧（`commands/` / `handlers/` / `router.rs`）被钩子的 `$entryPath` 白名单正常放行（框架/路由表调用，call-graph 结构上看不到 caller），只有这两个普通导出函数被揪住。**释放阻塞项仍是 6.6 接线硬门 + 7.1 端到端**，标记不构成豁免。
- [x] 5.3 Checkpoint — 双模编译 + 测试全绿
  - **Evidence**: `commit 31f0daae` · `verify: cargo test ... --lib delegation → 420 passed; 0 failed · EXIT=0`（服务器目标；桌面 feature 在新 worktree 因缺 `../out` 与 sidecar 无法构建，见 1.4 注）· `files: src-tauri/src/commands/delegation.rs:389,546 · src-tauri/src/lib.rs:1127-1128 · src-tauri/src/web/router.rs:81-86 · src/lib/api.ts:4094,4107` · `AC: R8.1-R8.8`

### 6. UI 层（P3 · 依赖 4 / 5）

- [x] 6.1 子智能体常驻条（**P1 的第一个生产消费者 · 与数据层同批提交以满足接线硬门**）
  - 挂 `ConversationShell` 的 `topBanner`（`conversation-detail-panel.tsx:1741`，紧随 `BackgroundTasksChip`）
  - **工作区级观察集合**；无运行中时显示可观察条目总数（不把静默计为完成）
  - _Requirements: 5.1-5.9_
  - **Evidence**: `commit 3db02b48` · `verify: npx vitest run（chip + wiring + selector + 两投影 + i18n parity）→ 53 passed (53) · EXIT=0`；`npx tsc --noEmit → 0 errors`；`git commit → [unwired] findings 归零（提交前该门明确拒绝过：buildObservedSubAgentRows 只有 1 个非生产调用点）` · `files: src/components/chat/sub-agent-observatory-chip.tsx（新）· src/hooks/use-observed-sub-agents.ts（新）· src/components/conversations/conversation-detail-panel.tsx:48,1741（挂载）· src/i18n/messages/*.json ×10` · `AC: R5.1-R5.9`
  - ✅ 2026-08-03: 双向 mutation 校验 —— 删掉生产挂载则 3 个 wiring 测试转红而 9 个组件测试仍绿（证明门对准接线而非组件内部）；反向改坏空集守卫则 R5.3 转红（证明该测试非空过）。
  - ⚠️ **我 brief 里的前提写错了一处，SUB 靠实测发现**：我只说 `getEvictedCount` 是 ref-backed、消费者需自带 tick；实际 **`listEntries` 同样是 ref-backed**（整个 Provider 用 `useRef` 存状态），故内部 SUB 到达**不触发任何重渲染** —— 而「有可观察条目才启动 tick」的守卫只能靠重渲染变真，构成死锁（4 个内部 SUB 测试因此恒红，委托测试全绿）。已加 `subscribeEntries`（仅集合增删时触发，非每帧，保留 frames 用 ref 存的初衷）+ 引用稳定的 `listEntries` 快照（每次返回新数组会在 `useSyncExternalStore` 下无限重渲染）。
  - ⚠️ 视觉判断（非 spec 要求，待你过目）：常驻条用紫色以区别于 `BackgroundTasksChip` 的天蓝 —— 两者统计互不相交的任务池，同色会诱使读者当成一个数字。
- [x] 6.2 清单 Popover + 分区 + 就地详情
  - 载体 = 常驻条下拉 **PopoverAnchor**（非 `PopoverTrigger asChild`，见下）；清单主体抽为容器无关组件
  - 四分区 + 其他会话/已完成行显示所属会话；已完成每会话上限 **20**（**per-conversation 而非全局** —— 工作区级面板上全局上限会让一个繁忙会话挤掉另一个的历史）
  - 详情按来源分深度：内部 SUB 渲染已缓存帧；委托行经既有 `getFolderConversation` 取最近一条助手消息摘要（选中时才请求 / 切换丢弃在途）
  - 双档节拍：同一个 interval 按 `panelOpen` 选周期（关 5s / 开 2s，且快档还要求存在内部 SUB —— 只有它们有时间派生的生命周期）
  - _Requirements: 6.1-6.17_
  - **Evidence**: `commit 97fab926` · `verify: npx vitest run（panel + integration + wiring + chip + i18n parity）→ 50 passed (50) · EXIT=0`；SUB 侧含 selector 与两投影共 `84 passed (9 files)`；`npx tsc --noEmit → 0 errors`；`git commit → 零 [unwired]，production_callers=8` · `files: src/components/chat/sub-agent-observatory-list.tsx（新）· sub-agent-observatory-panel.tsx（新）· src/hooks/use-observed-sub-agents.ts（双档节拍）· src/components/conversations/conversation-detail-panel.tsx:47,1742（挂载从 chip 换为 panel）· src/i18n/messages/*.json ×10（18 keys）` · `AC: R6.1-R6.17`
  - ✅ 2026-08-03: **停表是结构性的而非标志位** —— 面板体是 `PopoverContent` 内的独立组件，关闭即卸载、其 hook 实例带走 interval；chip 自己的实例是永不卸载的兄弟节点，故关闭后计数仍按慢档跳动（R6.7），有一个「从不打开面板、用假时钟看运行数自行下降」的测试锁定它。
  - ✅ 2026-08-03: 摘要抓取带**两道**防护，因为二者失败方式不同 —— per-run `cancelled` 标志管卸载，单调 `seqRef` 管 R6.14 真正的危险（两个回调都属于启动时仍存活的 effect，无序号则较早行的较慢响应会覆盖较晚行）。测试让 A 行的 promise 在 B 行之后 resolve 并断言 A 的文本从不出现。
  - ✅ 2026-08-03: 双向 mutation 校验 —— 注掉生产挂载则 3 个 wiring 测试转红而 29 个组件测试仍绿。
  - ⚠️ **SUB 发现 spec 的 design.md 有一处过期内容（我的错，已修）**：`design.md` Data Models 表仍写「`binding.parentConnectionId` 与当前会话连接标识比对」—— 那是 R2 B1 提出、R3 C1 又最终改掉的**旧方案**；requirements R2.9 与实际 selector（`observed-sub-agents.ts:216`）都是比 `parentConversationId`。我在 R2/R3 改 requirements 时漏改了 design 的这张表，同段引用的静默阈值 AC 编号也已漂移。已一并更正为 R2.9-R2.11 / R3.3-R3.5 / R3.11-R3.12 与 R2.12-R2.14。
  - ⚠️ **`PopoverTrigger asChild` 会静默产出死触发器（实现陷阱，非 spec 问题）**：`SubAgentObservatoryChip` 是普通函数组件，既不 forwardRef 也不透传未知 props，故 Radix 注入的 `onClick` / `ref` / `aria-expanded` 会被全部丢弃 —— 面板永不打开，**且没有类型错误**。改用 `PopoverAnchor` 并保留 chip 自己的 `onActivate` 作为唯一开启路径。
  - ⚠️ 内部 SUB 的工具调用在面板内渲染为单行等宽标记，未复用完整卡片：`subagent-transcript.tsx` 需要注入 `renderToolCall`，而其唯一生产实现位于 `content-parts-renderer.tsx:2531`（面板的下游），导入会反转依赖方向。完整卡片仍留在消息流里。
- [x] 6.3 行操作 + 取消竞态
  - 右键菜单仅列可用项；不可用项用肯定性只读标识（**不用 disabled**）
  - 生命周期只由事件流决定；两个对账触发点（取消返终态但事件未到 / 断线恢复）
  - **Property 9: 行生命周期与取消响应解耦** _Validates: Requirements 7.7-7.10_
  - _Requirements: 7.1-7.13_
  - **Evidence**: `commit 2635c05b` · `verify: npx vitest run（actions + row-actions + wiring + panel + i18n parity）→ 67 passed (67) · EXIT=0`；SUB 侧 11 个观察面板文件共 `128 passed`；`npx tsc --noEmit → 0 errors`；`git commit → 零 [unwired]，production_callers=11`（两个 `gate:allow-unwired` 标记已清，`git grep` 零命中） · `files: src/contexts/observatory-actions-context.tsx（新）· src/components/chat/sub-agent-observatory-list.tsx（菜单/确认框/只读徽标/在途标记）· src/contexts/delegation-context.tsx:402（applyAuthoritativeStatus）· src/contexts/live-observability-providers.tsx:39（挂载）· src/lib/api.ts（标记移除）· i18n ×10（11 键）` · `AC: R7.1-R7.13`
  - ✅ 2026-08-03: **SUB 驳回了我 brief 里的一个设计，且它对**。我写「reconciledLifecycles 作为独立状态供消费者叠加」—— 那是把 **R2 B2 刚移除的双真源问题请了回来**（并行生命周期存储需要另一套与事件的排序规则）。它改为对账结果经 `applyAuthoritativeStatus` **写进 events 写的同一个 binding map**：对账是第二条**到达路径**，不是第二个**写入者**。Property 9 因此**结构性成立** —— 取消响应根本不写生命周期，无物可与事件竞态。
  - ✅ 2026-08-03: `applyAuthoritativeStatus` 刻意收窄：只把 binding 移出 `running`、忽略 `running`/`unknown` 判决、不能复活终态。`unknown` 是 broker 无法为该任务背书时的回答，当成「已完成」会报告一个无人观测到的结果。
  - ✅ 2026-08-03: **确认步骤：做了**。理由三条 —— 触发点是密集近似行上的右键菜单，误点容易；代价真实但有界（在途回合的 token 与部分成果，只能重新派发挽回）；R7.1 原文写「WHEN 用户**确认**取消」本身预设了该步骤。复用了 `cancel-scope-dialog.tsx` 的 AlertDialog 形状（它为父连接把同一类动作设了闸）。
  - ✅ 2026-08-03: **重连每个仍在跑的行恰好读一次**。三条保障：Provider 挂**工作区级**（每面板一个实例会在分屏下按打开的会话窗格数成倍发读，有 wiring 测试钉住这个位置，因为它是承重的而非风格问题）；effect **只绑一次**（`listBindings` 经 ref 读取 —— 订阅若随每个委托事件重建，可能错过它本该捕获的那次重连）；已被事件流结算的行跳过，其余按 `childConversationId` 去重（binding map 以 parent tool-use id 为键，重播的 start 会留下两个条目指向同一个子会话）。测试：3 行其中 1 已终态 → 恰好 2 次读取。
  - ✅ 2026-08-03: **Property 9 用五种到达顺序覆盖**，断言的是 **selector 产出的生命周期**而非 setter 调用：响应先/事件后 · 事件先/响应后 · 只有响应无事件 · 事件先且响应被扣住（**不触发对账读取**）· 响应说 canceled 而流说 ok（**流胜**）。第四条需**强制**顺序 —— 初版让取消立即 resolve，读取就正确触发了，因为那一刻流确实还没送来终态。
  - ⚠️ **能力不对称是真实的**：cancel 在行进入终态后消失，但 **Open in Tab 永不消失**（`observed-sub-agents.ts:250` 对所有委托恒为 true 且有注释说明）—— 读一个已完成子智能体的产出，正是终态行仍留在列表里的理由。两半都有测试钉住。
  - ⚠️ **SUB 对我 brief 中重连锚点的反驳有误，但不影响交付**：它称 `use-subsession-sync.ts` 未引用 `onTransportReconnect`，实测**该文件确实在用**（`:9` import、`:188` 调用）—— 它的 `git grep` 结果不完整。不过它照的 `task-detail-sheet.tsx:222` 形状同类，且它抓到的真实要点是对的且重要：`onTransportReconnect` 返回 `UnsubscribeFn | null`，桌面 IPC 下为 `null`（`src/lib/platform.ts:46-51`，无断连窗口），故清理必须可选链。
  - ⚠️ `openTab` 需要 `folderId` 而行模型不带它，改为按需经 `getFolderConversation` 解析（与 `sub-agent-session-dialog.tsx:397-411` 同法），未为一次罕见的有意点击去加宽行模型。
  - ⚠️ `sub-agent-observatory-list.tsx` 现 852 行，越过 800 行提示阈值（非阻塞）。拆分是另一次有自身爆炸半径的重构，本轮只上报不动手。
- [x] 6.4 横幅分类上报（D6）
  - 后端 `background_watch.rs` 按 `TaskEntry.kind` 分类（`&'static str` 提升为 `TaskKind` 枚举）；`AcpEvent::BackgroundActivity` 加两个字段（`serde(default)` + skip-zero，向后兼容）
  - 传播 **7 跳**（brief 只列了 6）：`acp/types.rs` → `session_state.rs` → snapshot → `src/lib/types.ts` → `snapshot-denormalize.ts` → `acp-connections-context.tsx` → **`use-connection.ts` 的 `UseConnectionReturn`** → 横幅
  - _Requirements: 5A.1-5A.4_
  - **Evidence**: `commit 8bbb0d87` · `AC: R5A.1-R5A.4` · `verify: cd src-tauri; $env:NO_PROXY='127.0.0.1,localhost'; cargo test --no-default-features --bin codeg-server --lib → 2237 passed; 0 failed; 1 ignored · EXIT=0`（4 个新测试：per-kind 分别上报 / 单类归零转换 / max-age 过期 / snapshot skip-zero）；`npx vitest run（banner + resolver + i18n parity）→ 22 passed (22)`；`npx tsc --noEmit → 0 errors` · `files: src-tauri/src/acp/background_watch.rs:325-347,704-722 · acp/types.rs:331-340,948-954 · acp/session_state.rs:318-322,1153-1171,1481-1485,1576-1584 · src/lib/types.ts · snapshot-denormalize.ts:86-94,166-169 · src/contexts/acp-connections-context.tsx（7 处）· src/hooks/use-connection.ts:93-99,268-272,394-395,439-440 · src/lib/background-task-kinds.ts（新）· src/components/chat/background-tasks-chip.tsx · i18n ×10（3 键）`
  - ✅ 2026-08-03: **红灯是真的** —— 首轮 Rust 跑出 `E0063 missing fields` 命中每一个构造点，这也正是枚举爆炸半径的方式；随后在 producer 落地前先出现行为性失败。
  - ✅ 2026-08-03: **per-kind 计数由「与聚合同一次 map 读」派生，而非增量累加** —— max-age 过期（`background_watch.rs:557`）会移除没有 settle 记录的条目，增量累加会漏掉它、使各部分之和漂移到高于总数。
  - ✅ 2026-08-03: **skip-zero 带来的歧义已妥善处理**：零计数被省略 ⇒ 缺字段反规范化为 `0`，与「该类确实为 0」逐字段无法区分。用**两数之和**消歧 —— `agents + shells !== outstanding` 即回退聚合措辞（`background-task-kinds.ts`）。旧后端报 2 时仍显示「2 background tasks running」，而非宣称两类皆 0；部分分类同样保守回退（只报 1 个 shell 而实有 3 个待定会漏掉 2 个）。该回退路径在当前系统中**不可能被触发**，故单独成模块 + 2 个直测，否则是无法验证的死逻辑。
  - ✅ 2026-08-03: 分类**同时**镜像到 `SessionState` 与快照（非仅事件）—— 否则 web 重连或新开窗口会一直显示旧聚合措辞直到下一个事件到达，正是 R5A 要消除的那种不可解读。
  - ⚠️ **brief 漏列了一跳（SUB 靠 `tsc` 发现）**：`use-connection.ts:36` 的 `UseConnectionReturn` 是连接上下文与横幅之间的真实一跳，且需改**两处**（返回对象 + `useMemo` 依赖数组）。漏改依赖数组会让横幅冻结在过期计数上，**而所有测试仍会通过**（测试每次都是全新渲染）。
  - ⚠️ `u32_is_zero` 原为 `session_state.rs` 私有，已提升为 `types.rs` 的 `pub(crate)` 并被前者引用 —— 复制一份会造成同一条 wire 规则的第二处定义。
  - ⚠️ 本任务**不追求**与观察面板计数一致（D4）：二者描述不同任务池，强行相等已被否决；目标是各自的数字能被单独正确解读。这也是那个 chip 用紫色、本横幅保持天蓝的原因。
- [x] 6.5 i18n × 10 locale
  - ⚠️ `src/i18n/messages.test.ts:47` 断言 key 集合全等，只改 `en.json` 必红
  - ⚠️ ~~selector 的 `UNKNOWN_AGENT_LABEL` 必须在此替换为 i18n 文案~~ → **这条指令是我写错的，SUB 驳回且它对**：实测 `row.agentLabel` **零生产消费者**（`git grep "row\.agentLabel"` 无命中；面板在 `sub-agent-observatory-list.tsx:587-588` 自建标签 —— 有 agent 类型走 `getAgentLabel(row.agentType)`，否则 `t("unknownAgent")`）。要替换就得把 `next-intl` 或 locale 参数注入 `buildObservedSubAgentRows`，**摧毁该模块「无 React、无 store、无时钟」的纯度**（属性测试正依赖这一点），换来一个没人渲染的字段；删除也要改必填接口 + 三文件四处 fixture，超出 i18n 收尾范围。已处置为**非 UI 内部默认值 + 注释说明**（`observed-sub-agents.ts:146`），避免后来人误认作用户可见文案。
  - _Requirements: 9.1, 9.2_
  - **Evidence**: `commit pending`（随收尾提交） · `AC: R9.1-R9.2` · `verify: npx vitest run（messages.test.ts + observed-sub-agents + observatory 面板/chip/行操作 + actions-context + background-tasks-chip + background-task-kinds）→ 99 passed (8 files) · EXIT=0`；`npx tsc --noEmit → 0 errors`；`npx prettier --end-of-line crlf --check` 三个改动文件 → 全部通过 · `files: src/i18n/messages/ko.json（3 键）· src/i18n/messages/zh-TW.json（6 键）· src/lib/observed-sub-agents.ts（注释，无行为改动）`
  - ✅ 2026-08-03: **key 集合完整性本就已达标，本轮是「语义与术语审计」而非补键** —— 三阶段共 32 键（obs 29 + bg 11 中的 3 新键）在 10 个 locale 全部存在，`messages.test.ts` 9 passed 证实 `missing`/`extra` 皆空。用 `@formatjs/icu-messageformat-parser` 实解析 32×10=320 条：**ICU 全部可解析，阿语四型（one/two/few/other）在本需求全部键上齐备**，故 spec 担心的「三阶段各写一套复数」在结构层面未发生。
  - ✅ 2026-08-03: **`UNKNOWN_AGENT_LABEL` 的处置推翻了本任务原文的指令**。原文写「必须替换为 i18n 文案」，但核实后该动作**不该做**：`row.agentLabel` **零生产消费者**（`git grep "{row\.agentLabel"` 零命中；面板在 `sub-agent-observatory-list.tsx:586` 自行 `getAgentLabel(row.agentType)` / `t("unknownAgent")`）。若把 i18n 文案灌进该常量，需给纯函数 selector 注入 `next-intl`（毁掉它「无 React / 无 store / 无时钟」的纯度，320 条属性测试的可测性依赖此纯度），换来一个没人渲染的字段。**处置：保留为内部非 UI 默认值 + 注释显式声明不可渲染**（三处：类型字段、常量定义、两个赋值点），并写明「若未来有人渲染它，英文串会漏进全部 locale —— 请在渲染点本地化」。这正是任务原文要求的「不留下让后人误以为面向用户的歧义占位符」，只是结论是「留而定性」而非「删或换」。删除亦不可取：`agentLabel: string` 非可选，删常量需改类型 + 4 个测试 fixture，属行为面之外的扩散。
  - ✅ 2026-08-03: **两个语义红线逐语种复核通过（10/10）**。① 静默态**无一语种读作「已完成」**：`silent` 全部译为「无最近活动」义（zh-CN 近期无活动 / ja 最近の活動なし / ko 최근 활동 없음 / de Keine kürzliche Aktivität / ar لا يوجد نشاط حديث …），且 `silentTooltip` 在 10 个语种都保留了「这不代表它已结束 + 内置子智能体不上报完成信号」两句（R3.14 的文案载体）。注意 `sectionCompleted`（Finished/已结束/終了）是**已完成分区**标题，内部 SUB 永不进入该分区（`observed-sub-agents.ts:196` 结构性保证），故不构成冲突。② 容量提示**无一语种把范围写成「当前会话」**：10 个语种全部出现工作区级限定（zh 本工作区 / ja このワークスペース全体で / ko 이 워크스페이스 전체에서 / es de este espacio de trabajo / ar في مساحة العمل هذه），R3.9 未被译丢。
  - ✅ 2026-08-03: **两个 chip 的措辞不会让读者把两个数字合并**：观察面板侧一律「子智能体 / sub-agent」，横幅侧一律带「后台 / background / 背景」限定词且区分「后台子智能体 vs 后台命令」（`runningAgents` / `runningShells` / `runningBoth`），10 语种一致。二者本是不同任务池（D4），措辞上靠「后台」限定词与紫/天蓝配色双重区分。
  - ⚠️ **修掉 3 处真实缺陷（`messages.test.ts` 结构断言看不见的那一类）**：① **ko 错字** `서부 에이전트` → `서브 에이전트`（`bg.runningAgents` / `bg.runningBoth`；该文件其余处用正确写法 38 次，错字仅 2 处，属本需求引入）；② **ko 助词粘连** `"{name} 에서"` → `"{name}에서"`（`obs.inConversation`；韩语助词须紧贴前词，同文件另 7 处 `}에서` 全部紧贴，`}개` 量词 93 处亦全部紧贴）；③ **zh-TW 术语三分裂** —— 同一批 32 键内并存 `子智能體`(7 键) / `子智慧代理`(4 键) / `子智慧體`(2 键)，三阶段各写一套。统一为 **`子智慧體`**，依据是相邻既有委托 UI 对**同一对象**已用该词（`zh-TW.json:2799 unknownAgent`、`:2801 detailTitle`、`:2804` 同段）。
  - ⚠️ **主动不改（越界，须独立立项）**：① `ko.json` `Folder.chat.delegation.openInTabNotSyncedNotice` 带**同一个 `서부` 错字**，但来自 `2505e164`（另一功能的 block），非本需求引入 —— 同根变体已上报，不搭本次车；② **`ar.json` 全仓 26 处复数缺 `two`/`few`**（`sidebar.toasts.*` / `branchDropdown.*` / `gitLogTab.time.*` 等），且 `Folder.chat.feedbackCheckResult.count` 在 **en/es/de/fr/pt 五个语种缺 `one`` 分支` —— 本需求的键全部合规，这 27 处是既有基线。**因此本轮未加「全仓复数分类闸门」**：那种闸门会立刻对 27 处既有键报红，需 baseline 豁免 + 独立立项（同 7.5 的 `.gitattributes` 情形）。
  - ⚠️ **未验证的语言不擅自重写**：de 全文 `Sie`(90) 与 `du`(78) 混用、es `usted`(50) 与 `tú`(31) 混用，属**全仓既有敬语不统一**，非本需求键的缺陷（本需求键内部各自自洽）；未动。ja/fr/pt 未发现问题。
- [x] 6.6 接线硬门（E-052 防线 · 审查 Critical 3 的兑现点）
  - _Requirements: 5.1-5.9, 6.1-6.17_
  - **Evidence**: `commit 2635c05b` · `verify: git grep "listBindings|listEntries|getEvictedCount|buildObservedSubAgentRows" -- src`（排除 `.test.`）→ 每个 API 均有生产 caller。`git grep "gate:allow-unwired" -- src/lib/api.ts` → **零命中**（两个标记已随真实 caller 到位而清除）。pre-commit 门 `production_callers=11`，零 `[unwired]` · `files: src/hooks/use-observed-sub-agents.ts:107,115-116,143,166（四个 API 的生产 caller）· src/contexts/observatory-actions-context.tsx:137,179,204 · src/components/conversations/conversation-detail-panel.tsx:1743（面板挂载）` · `AC: R5.1-R5.9, R6.1-R6.17`
  - ✅ 2026-08-03: **判据已由三次 mutation 校验兑现**（每次都是「注掉生产接线 → wiring 测试转红、组件测试仍绿」）：6.1 的 3 红/9 绿、6.2 的 3 红/29 绿、6.3 的 3 条新 wiring 断言。证明门对准接线而非组件内部。
  - ⚠️ 这一门在本轮**真实拦截过两次**（非空跑）：`buildObservedSubAgentRows` 只有测试调用点时拒绝提交（处置：把 6.1 常驻条提前，与数据层同批交付，**未用逃生口**）；`cancelDelegation` / `getDelegationTaskStatus` 零调用点时再次拒绝（处置：因 6.3 消费者硬依赖 6.2 行渲染，**用了逃生口并写明理由**，6.3 完成后已清除）。

### 7. 收尾

- [ ] 7.1 端到端真跑一次（Success State 验收姿势 · 非单测）
  - 起真实委托 → 常驻条出现 → 打开面板见该行 → 点取消 → 确认 broker 返 `Canceled` 且子连接 teardown → 行入已完成分区
- [x] 7.2 变体再扫（§5.3）+ 汇聚后全量回归
  - **Evidence**: `commit ec2af07a` · `AC: R1.1-R1.7` · `files: src-tauri/src/acp/delegation/broker.rs:1954-2004（owned_by 定义 + 6 调用点）· src-tauri/src/acp/background_watch.rs:325-347（TaskKind）· src/lib/api.ts:4094,4107（标记已清）` · `verify: git grep "let owned = match parent_conversation_id" → 零命中`；`git grep -c "owned_by(" → 7`；`git grep -c "TaskKind::" → 4`；`git grep "gate:allow-unwired" -- src/lib/api.ts → 零命中`；`cargo test --no-default-features --bin codeg-server --lib → 2249 passed; 0 failed · EXIT=0`；`npx vitest run → 3564 passed / 5 failed`
  - ✅ 2026-08-03: **前端那 5 个失败是全程记录的基线既有项**，且已在未改动主仓复现：`message-input.test.tsx` ×3 · `conversation-detail-panel-steering.test.ts` ×1 · `src/stores/delegation-multi-turn-timeline.test.ts` ×1 —— 全部落在 steer 相关的未接线代码上（同一批债还导致 `cargo clippy` 的 3 个 `dead_code`，见 7.5）。本需求涉及的文件全部通过。
  - ✅ 2026-08-03: 余 6 处 `parent_connection_id ==` 经核仍在指纹半径外（setup 登记与父连接批量清理路径，调用方持真实连接 id，不经用户侧合成常量）。
  - ⚠️ **本项已提前跑过一轮，并因此抓到一次真实回退（2026-08-03）**：在 `obs-p3-panel` 树上扫出**四处内联 `let owned = match parent_conversation_id` 副本复活**，`owned_by` 只剩 `classify_locked` 两个调用点。根因是合并方向：`feat/obs-p2-cancel` 基于 `a0779219`（收敛**前**），`git merge-base --is-ancestor b369b14c feat/obs-p2-cancel` 返回 1 证实它不含收敛，合并时以旧版覆盖了新版。**这类回退不会有任何测试变红**（四处内联与共享函数行为等价），只有变体扫描能发现。已在面板树上补 `git merge b369b14c`，复核后内联零命中、6 个调用点全走 `owned_by`。**教训：分支基点早于某次重构时，合并会静默回退该重构，且行为等价的重构回退无测试信号。**
- [ ] 7.3 异构 reviewer 评审（模型 ≠ 实现者）
- [x] 7.4 收尾文档 —— **按本仓实际惯例，不按模板**
  - **Evidence**: `commit ec2af07a` · `verify: Get-ChildItem *.md → AGENTS.md / CLAUDE.md / README.md（无 CHANGELOG.md）`；`Get-ChildItem docs/architecture → 仅 ADR-0001（无 ARCHITECTURE.md）`；`git log --name-only 2505e164 -- docs/` → 前一个同类 spec（delegation-continue-session）交付时只动 spec 三件套 + docs/specs/README.md 索引` · `files: docs/specs/README.md（索引，由 sync-spec-index.py 维护）· docs/specs/subagent-observatory/{requirements,design,tasks}.md` · `AC: R9.1-R9.2`
  - ⚠️ **我在创建 tasks.md 时把「CHANGELOG + ARCHITECTURE 演进索引」照模板写进了本项，但这两个文件在本仓不存在**。核实后按实际惯例执行：spec 三件套已随各阶段更新，`docs/specs/README.md` 索引已由 `sync-spec-index.py` 维护（4 个 spec 已收录）。ADR 方面本需求的 design.md `ADR admission` 段已判定 **no**（不新增架构边界、不改依赖方向），故不新增 ADR-000x。
  - ⏭ SKIPPED: `codegraph sync` —— 各工作树已在提交时由 pre-commit 门自动同步（本轮多次见 `state=synced` 输出，如 6.3 的 `exact_hits=38; production_callers=11`），无需另跑。主仓索引在合并回 `feat/kiro-agent` 后再同步。
- [x] 7.6 分支汇聚（**合并方向不可随意**，本轮已踩两次）
  - **Evidence**: `commit ec2af07a` · `verify: git log --oneline --graph --all --not feat/kiro-agent` → 汇聚点含全部四条线（`b369b14c` 收敛 / `31f0daae` P2 / `97fab926` 面板 / `8bbb0d87` 横幅 / `2635c05b` 行操作）；合并后变体再扫与全量回归见 7.2 · `files: src-tauri/src/acp/delegation/broker.rs（三次合并的唯一冲突面，末次确认 owned_by 7 处）· docs/specs/subagent-observatory/tasks.md:207（变体再扫证据）` · `AC: R1.1-R1.7`
  - ✅ 2026-08-03: 三次合并全部无冲突（`ort` 策略）：P2 → 面板树、`b369b14c` 补合（修回退）、banner → 面板树。每次合并后均跑变体再扫，末次确认内联零命中、`owned_by` 7 处、`TaskKind` 枚举在位、逃生口标记清空。
  - 各分支基点不同，**必须让「已含全部前序」的分支去吸收落后分支**，反向合并会用旧文件覆盖新重构且无测试信号（见 7.2 记录的那次 `owned_by` 回退）
  - 实测基点：`feat/obs-p2-cancel` 基于 `a0779219`（缺 `b369b14c` 收敛）；`feat/obs-p3-banner` 基于 `3db02b48`（缺收敛、缺 P2、缺面板）；`feat/obs-p3-panel` 经两次补合后**已含全部**
  - 汇聚顺序：以 `feat/obs-p3-panel` 为汇聚点，依次吸收 banner → 其余；每次合并后**必跑变体再扫**（`git grep "let owned = match parent_conversation_id"` 须零命中）+ delegation 测试
  - ⚠️ **合并前必查目标树是否有 SUB 在工作**（`git status --short`）：本轮尝试合 banner 时因 6.3 SUB 正在该树改 11 个文件而被 git 安全拒绝（`local changes would be overwritten`），HEAD 未动、SUB 工作完好。**并行 SUB 与主 AI 合并操作必须互斥**。
- [ ] 7.5 技术债上报（本轮发现、不在范围内、需独立立项）
  - **仓库缺 `.gitattributes` 而 `core.autocrlf=true`**（已亲验：`git config core.autocrlf` → `true`；`.gitattributes` 不存在）→ 所有 tracked 文件为 CRLF 而 prettier 期望 LF，导致任意 Windows 贡献者在未改动的文件上看到约 10k 个 `Delete ␍` 幻影错误（实测 `src/lib/types.ts` 单文件 3441 个），且任何 `prettier --write` 都会产出数千行换行 diff 掩盖真实改动。一行 `.gitattributes`（`* text=auto eol=lf`）+ 一次规范化提交即可根治，但那是触及每个 tracked 文件的全仓改动，**须单独立项并经用户批准**，不得搭本需求的车。
  - **`acp/connection.rs` 的三个 steer 函数无生产 caller**（`send_steer_request` / `build_steer_params` / `parse_steer_outcome`，`:2300` / `:2321` / `:2333`）→ 使 `cargo clippy -- -D warnings` 在本仓恒定失败（基线既有，已在未改动主仓复现）。属 upstream 合并遗留的未接线代码，与本需求无关。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "2.1", "3.1"] },
    { "id": 1, "tasks": ["1.3", "2.2", "2.3", "3.2"] },
    { "id": 2, "tasks": ["1.4", "4.1"] },
    { "id": 3, "tasks": ["4.2", "5.1"] },
    { "id": 4, "tasks": ["5.2"] },
    { "id": 5, "tasks": ["5.3", "6.1", "6.4"] },
    { "id": 6, "tasks": ["6.2", "6.3", "6.5"] },
    { "id": 7, "tasks": ["7.1", "7.2", "7.3", "7.4"] }
  ]
}
```

> ⚠️ **5.x 硬依赖 1.x**：跳过 broker 归属修复直接做取消链路，则取消对所有 LLM 派发任务恒返 `unknown`，而 mock broker 的单测会全绿。

## Update Log

- 2026-08-03 · 清单创建。3 轮 codex 评审收敛（P0 6→3→2→0）+ 认知复盘（`introspection-subagent-observatory.md` · lint PASS · BS-025/BS-026 入全局盲区库）后落盘。

- 2026-08-03 · 执行者（i18n SUB）· 完成 6.5 Requirement 9 收口。**结论：key 集合本就完整（32 键 × 10 locale 全在，`messages.test.ts` 9 passed），本轮实际是语义与术语审计** —— 用 `@formatjs/icu-messageformat-parser` 实解析 320 条确认 ICU 全部合法、阿语四型齐备；修掉 3 处结构断言看不见的真实缺陷（ko `서부`→`서브` 错字 2 键、ko `{name} 에서`→`{name}에서` 助词粘连 1 键、zh-TW 同批键内术语三分裂统一为 `子智慧體` 6 键）。**推翻了任务原文一条指令**：`UNKNOWN_AGENT_LABEL` 不应替换为 i18n 文案（`row.agentLabel` 零生产消费者，灌 i18n 需毁掉纯函数 selector 的纯度换一个没人渲染的字段），改为保留 + 注释定性为「内部非 UI 默认值、不可渲染」。两条语义红线逐语种复核 10/10 通过（静默态无一语种读作已完成；容量提示无一语种缩成当前会话）。证据：`vitest → 99 passed (8 files)`、`tsc → 0 errors`、`prettier --end-of-line crlf → clean`、pre-commit 闸门 `EXIT=0`。**按指令 commit 后 `git reset --soft HEAD~1`，未留提交**。上报越界项：ko 另一 block 同款错字（来自 `2505e164`）、ar 全仓 26 处复数缺 two/few + 5 语种 `feedbackCheckResult.count` 缺 one（既有基线，故未加全仓复数闸门）。
