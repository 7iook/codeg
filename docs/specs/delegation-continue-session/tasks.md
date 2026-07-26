# Task Tracker · delegation-continue-session

> **What this is** — the LIVING, checkbox-tracked execution list for this work. Executors read it,
> check items off in real time, and log what changed under each. Single source of "done / left /
> blocked".

| 字段 | 值 |
|---|---|
| 来源 Source | `docs/specs/delegation-continue-session/design.md`（三轮 codex 评审收敛 · P0 全清） |
| 类型 Type | feature |
| 创建 Created | 2026-07-26 |
| 状态 Status | not-started |

**图例 Legend**: `- [ ]` 待办 · `- [x]` 完成（必须带 Evidence） · 行尾 `— ⛔ BLOCKED:<原因>` / `— ⏭ SKIPPED:<理由>` / `— ⏳ PENDING:<原因>`

## Overview

交付顺序：M1 前端可发现性（独立可交付）→ spawner 能力 → broker 状态机（串行独占）→ 对外契约 → 用户入口 → 多轮时间线 → 端到端验证。W1/W5 与串行链并行。

## ⚠️ Worktree 环境已知问题（2026-07-26 · 后续 executor 必读）

1. **缺 `out/`**：新 worktree 没有 gitignored 的 `out/`（Next 静态导出目录），tauri build script 会因 `resource path ..\out doesn't exist` 直接失败、根本编译不起来。已放占位 `out/index.html`（gitignored，不进 diff）。
2. **桌面 feature 的 lib-test exe 在 worktree 内启动即崩**：`cargo test --features test-utils`（桌面默认 feature）编出的 test exe 报 `STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)`，一个测试都没跑就退出。已受控排查：PE 导入表显示 worktree 版比主仓可用版多链了整套 Tauri GUI 导入（`comctl32!TaskDialogIndirect` / `user32` / `gdi32` / `ole32` 共 133 项）；stale `codeg_lib.dll` 遮蔽假设已被证伪（移走后同样失败）。
   **替代命令**：`cargo test --no-default-features --features test-utils --lib <filter>`。`acp` 下 spawner/broker 全路径无 `tauri-runtime` 条件编译，覆盖等价；桌面侧类型检查由 `cargo clippy --all-targets --features test-utils` 兜住（clippy 只编不跑，不受此影响）。
3. **worktree 无 `node_modules`**：`pnpm exec vitest` 跑不起来。用主仓的 `F:\codeg-research\node_modules\.bin\vitest.CMD`，Node 解析会向上走到主仓 `node_modules`。
4. **仓库预存 mixed CRLF**：ESLint 在部分文件上报数千条 `Delete ␍`，主仓未改动的同一文件同样报（如 `sub-agent-session-dialog.tsx` 3088 条），非本次引入。判断自己的告警数时要过滤掉这类噪音。
5. **chat_channel webhook 5 测需 `NO_PROXY=localhost,127.0.0.1`**（W4 补充定性）：仅清 `HTTP_PROXY`/`HTTPS_PROXY` 等 env 不够——reqwest 在 Windows 还会读系统代理（注册表），必须显式设 `NO_PROXY` 才稳定绿（受控对照复现两次）。另 `cargo fmt --check` 在本仓是全仓预存漂移（数百处、遍布从未被本分支触碰的 parsers/commands 等，rustfmt 版本差异），项目门禁不含 fmt，勿据此重排无关文件。

## Tasks

### M1 · 可发现性（W1 · 零后端 · 与串行链并行）

- [x] 1. 子会话可发现性
  - [x]* 1.1 Write failing test (red)
    - 新建 `src/lib/conversation-sidebar.test.ts`，测 `isDelegationSubsession` / `isSidebarRootConversation`
    - 断言：`parent_id != null` → true；`kind==="delegate"` → true；`delegation_call_id != null` → true；**worktree 缩进导致 depth>0 的普通根会话 → false**（上游 PR #375 commit `1ad6f8f1` 修的正是这个 bug，必须继承）
    - 跑一次确认因函数不存在而失败
    - _Requirements: 4.3, 4.4_
    - ✅ 2026-07-26: 写了 10 个断言（含「普通根 depth 无关 → false」「空串 delegation_call_id 不算标记」「loop 非根」）· 新增 `src/lib/conversation-sidebar.test.ts` · red 证据：`Failed to resolve import "./conversation-sidebar"`（函数不存在，非语法错）
  - [x] 1.2 Minimal implementation (green)
    - 新建 `src/lib/conversation-sidebar.ts`：两个纯函数，只读 DB 标记，**不读 UI `depth`**
    - 跑 1.1 → green
    - _Requirements: 4.3_
    - ✅ 2026-07-26: 两个纯函数签名只接 `Pick<DbConversationSummary, "parent_id"|"kind"|"delegation_call_id">`（结构性排除 depth 回归）· 新增 `src/lib/conversation-sidebar.ts` · green：10 passed
  - [x] 1.3 侧边栏渲染 Sub 徽标 + 父行 N sub 提示
    - `src/components/conversations/sidebar-conversation-card.tsx`：子会话行加 `Sub` 徽标（用 1.2 的函数判定）
    - _Requirements: 4.3_
    - ✅ 2026-07-26: 既有 `isSubsession = conversation.parent_id != null`（屏蔽 hover 快捷操作）改为复用 `isDelegationSubsession(conversation)`，行为不变；新增 `Sub` 徽标 + `data-subsession` 属性 + `childCountHint` 父行计数徽标 · 改 `src/components/conversations/sidebar-conversation-card.tsx` · 验证：`vitest run src/components/conversations` 227 passed（含 sidebar-conversation-card.test.tsx 18 tests 无回归）
  - [x] 1.4 漏斗开关：默认隐藏子会话
    - `src/lib/sidebar-view-mode-storage.ts` 加开关持久化；`src/components/layout/sidebar.tsx` 加漏斗菜单项
    - `src-tauri/src/db/service/conversation_service.rs` 的 `list_all(include_children=false)` 根过滤从单条 `parent_id IS NULL` 扩到三条 AND（+ `kind != Delegate` + `delegation_call_id IS NULL`）
    - `src/stores/app-workspace-store.ts` 用 `isSidebarRootConversation` 做纵深防御
    - _Requirements: 4.4_
    - ✅ 2026-07-26: `loadShowSubsessions`/`saveShowSubsessions`（默认 OFF）+ 漏斗 `showSubsessions` 勾选项 + list 新增 `showSubsessions` prop（关时用 `EMPTY_EXPANDED_IDS`/`EMPTY_CHILDREN_BY_PARENT` 抖掉 buildRows 的展开集与子缓存，同时关掉 child 预取）+ `folderConversations` 加 `isSidebarRootConversation` 过滤 + store 两处纵深防御（`refreshConversations` / `applyConversationUpsert`）+ 后端三条 AND 过滤 · 改 `src/lib/sidebar-view-mode-storage.ts` / `src/components/layout/sidebar.tsx` / `src/components/conversations/sidebar-conversation-list.tsx` / `src/stores/app-workspace-store.ts` / `src-tauri/src/db/service/conversation_service.rs` · 验证：先写 3 个 Rust red 测（孤儿 delegate 行 / 仅带 delegation_call_id / include_children 不得过滤），后端改完 21 passed
  - [x] 1.5 Dialog 加「在标签页打开」按钮 + 边界文案
    - `src/components/message/sub-agent-session-dialog.tsx` 加按钮，调 `openTab(folderId, childConversationId, agentType)`
    - **必须**同时加文案：此处发送不会同步给主 AI（design.md §M1 能力边界 · R1-A7 硬要求，不得靠用户自己发现）
    - 10 个 locale json 加对应 key（en 为准，`src/i18n/messages.test.ts` 会双向 diff 门禁）
    - _Requirements: 4.5_
    - ✅ 2026-07-26: 头部加 `openInTab` 按钮（走 `useTabActions().openTab`，`folder_id` 取自 `detail.summary`，summary 未到时禁用；openTab 自带 `activateConversationPane` 副作用，因此未引入 `useWorkbenchRoute`——它在 provider 外会 throw，会拆掉现有测试树）+ 常驻边界提示条 `openInTabNotSyncedNotice` · 改 `src/components/message/sub-agent-session-dialog.tsx` + `.test.tsx`（新增 3 测：交接目标 `openTab(7, 99, "codex")` / summary 未到时按钮禁用 / 边界文案必现）+ 10 个 locale json 各加 6 key（`showSubsessions` · `subsessionBadge/BadgeTitle/CountLabel/CountHint` · `openInTab/openInTabNotSyncedNotice`）· 验证：dialog 29 passed（其中新增 3 passed）、`src/i18n/messages.test.ts` 9 passed
  - [x] 1.6 M1 验证
    - `pnpm eslint .` + `pnpm exec vitest run src/lib/conversation-sidebar.test.ts src/components/conversations` → 全绿
    - `cargo test --features test-utils conversation_service` → 绿
    - ✅ 2026-07-26: ① eslint：本轮所改 9 个 ts/tsx 零错（修了 2 处真实 prettier 报错）。全仓 `eslint .` 在 worktree 里报 21.6 万条，**全为 `Delete ␍` CRLF**：该 worktree 是 `core.autocrlf=true` 下 checkout 的（仓库存 LF、无 `.gitattributes`），与本轮改动无关——主仓 `F:\codeg-research` 跑同一命令 exit 0。已将本轮碰过的 17 个文件归一到 LF（autocrlf 下 diff 中性）；未碰过的文件保持原样不动。② vitest：`run src/lib/conversation-sidebar.test.ts src/components/conversations src/i18n/messages.test.ts src/components/message/sub-agent-session-dialog.test.tsx` → **13 files / 227 tests passed, exit 0**。③ Rust：`cargo test --no-default-features --features test-utils --lib conversation_service` → **21 passed; 0 failed, exit 0**（含新增 3 根过滤测）。—— ❗ 偏差：charter 写的 `cargo test --features test-utils`（桌面 feature）在本 worktree **无法跑**：测试二进制加载即挂 `STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)`，一个测也没跑。已证与本轮改动无关：换干净的独立 target 目录重建同样挂；用 `pets::` （本轮未碰的模块）过滤也同样挂。PE 导入表对比显示该二进制多了 `comctl32.dll!TaskDialogIndirect` / `SetWindowSubclass` 等 v6 API（tao/tauri GUI 链入），而 test harness exe 无 comctl32 v6 清单，加载器绑 v5 失败；主仓同名测试二进制无 comctl32 导入，能跑（主仓 18 passed）。因此本轮用 `--no-default-features` 同路径跑同一批测作为等效证据，待主 AI 在主仓/CI 上补跑桌面 feature 一次。

### M2 · 后端串行链

- [x] 2. spawner 能力扩展（W2 · 无依赖）
  - [x]* 2.1 Write failing test (red)
    - `src-tauri/src/acp/delegation/spawner.rs` mock 测：`spawn_for_resume` 记录 `session_id`、`send_followup_prompt` 记录调用、`is_alive` 对 `mark_dead` 后的 conn 返回 false
    - _Requirements: 3.1, 3.4_
    - ✅ 2026-07-26: 加 4 个 mock 测（`mock_spawn_for_resume_records_session_id` / `mock_send_followup_prompt_records_call` / `mock_unqueued_followup_fails_loudly` / `mock_is_alive_false_after_mark_dead_or_disconnect`）· `src-tauri/src/acp/delegation/spawner.rs` · red 证据：`error[E0599]: no method named 'is_alive' found for struct MockSpawner` + `no field 'resume_args'` 等 11 个编译错误
  - [x] 2.2 trait + 生产实现 + mock 扩展 (green)
    - trait 加 `spawn_for_resume` / `send_followup_prompt` / `is_alive`（design.md §Components）
    - `manager.rs` 抽 `spawn_child_inner(.., session_id, ..)`；`send_followup_prompt` 走 `send_prompt_linked(.., Some(folder_id), Some(conversation_id), None)` **Branch A adopt 现有行**（传 link 会重复建行）
    - `MockSpawner` 加 `followup_results / resume_args / followups / dead_connections` + `queue_followup` / `mark_dead`；`disconnect` 顺带标 dead
    - _Requirements: 3.1, 3.4_
    - ✅ 2026-07-26: trait 三方法 + `ConnectionManagerSpawner::spawn_child_inner`（`spawn` 传 `None`、`spawn_for_resume` 透传 `session_id`）+ `send_followup_prompt` 走 Branch A（`Some(folder_id)` + `Some(conversation_id)` + `delegation: None`）+ `is_alive` 读 `manager.get_state` 判非 `Disconnected|Error` + MockSpawner 四字段两方法、`disconnect` 顺带 `mark_dead` · `src-tauri/src/acp/delegation/spawner.rs` · `src-tauri/src/acp/manager.rs` · 验证：`spawner` 10 passed / 0 failed；`delegation` **288 passed / 0 failed**（纯加法，零既有测试破坏）；`cargo clippy --all-targets --features test-utils -- -D warnings` RC=0 零告警
    - ⚠️ 偏差记录（环境，非代码）：本机 worktree 下 `cargo test --features test-utils`（桌面默认 feature）产出的 lib-test exe 启动即 `STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)`，测试一个都没跑就退出。PE 导入表对比证实该 exe 比主仓的多链了整套 Tauri GUI 导入（`comctl32!TaskDialogIndirect` / `user32` / `gdi32` / `ole32` 共 133 项），与本任务代码无关（已排除 stale `codeg_lib.dll` 遮蔽：移走后仍同样失败）。故 spawner/delegation 两条测试改用 `--no-default-features --features test-utils --lib` 跑（server 模式，编译同一份 `acp` 代码，且 spawner/broker 全部无 `tauri-runtime` 条件编译）；clippy 仍按 charter 用桌面默认 feature 跑，覆盖了 `#[cfg(feature = "tauri-runtime")]` 分支的类型检查。另：新 worktree 缺 gitignored 的 `out/`（静态导出目录）会让 tauri build script 直接失败，已放一个占位 `out/index.html`（gitignored，无 diff）。

- [x] 3. broker 保活状态机（W3 · **串行独占 broker.rs** · 依赖 T2）
  - [x]* 3.1 Write failing test (red) — 终态分流
    - 断言 `Completed`/`Failed` 不 disconnect、`Canceled` 仍 disconnect（**Property 3**）
    - **3 处既有断言需反转**：原 `disconnects == ["child-conn-1"]` / `["c-fast-ok"]` / `["c1"]` → `disconnects.is_empty()`
    - **Property 3: 终态分流一致性** _Validates: Requirements 1.1, 1.2, 1.3_
    - _Requirements: 1.1, 1.2, 1.3_
    - ✅ 2026-07-26: 反转 3 处（`happy_path_returns_ok_after_complete_call` L3641 · `handle_request_waits_indefinitely_for_completion` L4153 · `completion_before_park_resolves_instead_of_hanging` L6265，判断依据均为「断言的是 v1 one-shot 附带的 teardown，终态为 Completed」；**未**反转 `send_failure_after_spawn_disconnects_child`（S4 补偿必须清理）与 `c-fast-fail`（child failure→Canceled 仍 disconnect））+ 新增 2 测（`failed_outcome_keeps_child_connection_alive` red / `canceled_outcome_still_disconnects_child` 守卫）· red 实录：`cargo test --no-default-features --features test-utils --lib acp::delegation::broker` → **112 passed; 4 failed**，4 个失败全为行为断言 panic（"must not disconnect on success" ×2 / "early Ok complete must not disconnect" / "a failed (non-cancel) outcome must keep the child alive"），非编译错；守卫测通过
  - [x] 3.2 内部三层分离 + 保活 (green)
    - 新增 `SessionEntry`（task_id / parent_conversation_id / 最新 turn 指针 / 恢复元数据 / `released` / `turn_version`）+ `turns` 有界队列 + 独立 `operations` ledger（design.md §D2 三层表）
    - `Completed_Cache` 职责收窄为**只缓存结果文本**（BS-017：清空它系统只能变慢不变错）
    - `finalize_delegation` 的无条件 disconnect → 仅 `code == "canceled"` 才 disconnect
    - _Requirements: 1.1, 1.2, 1.3_
    - ✅ 2026-07-26: `SessionEntry`（parent_conversation_id 持久归属键 / parent_connection_id 运行租约 / parent_tool_use_id / agent_type / child_conversation_id / child_connection_id 保活指针 / status）+ `PendingInner.sessions` 注册表 + `settle_session` 统一收口（complete_call keep-非cancel / drain_and_record_canceled 清连接 / setup-window record 闭包分流 / 第二 pre-cancel / 连接拆除分支各就位）+ `finalize_delegation` 仅 `code=="canceled"` disconnect。`CompletedTask` **零字段新增**（与上游 7 字段堆叠的有意偏离,文本缓存与领域状态解耦）。新增绿测 `settled_session_survives_completed_cache_drop` 锁定 D2 判据（drop 掉 completed 后 session 保活事实完好）· 验证：`cargo test --no-default-features --features test-utils --lib delegation` → **291 passed; 0 failed**（288 基线 + 3 新增,3 处反转断言全绿）。字段增长策略：`released`(3.7)/`turn_version`+`turns`(3.5-3.6)/恢复元数据 folder_id·external_id·working_dir(3.6/3.8)/`operations` ledger(3.6) 随各自消费子项落地,避免 dead_code 空转
  - [x]* 3.3 Write failing test (red) — 连接回收守恒
    - **Property 1: 保活连接守恒** _Validates: Requirements 1.4, 1.5, 5.3_
    - 覆盖两条淘汰路径：字节淘汰 `evict_completed_over_cap` **与** 数量淘汰 `kept_alive_cap`
    - _Requirements: 1.5, 5.4, 5.5, 5.6_
    - ✅ 2026-07-26: 3 个新测：`kept_alive_cap_fifo_evicts_oldest_settled_connection`（cap=2 第三个 settle → 最老连接交给 disconnect，文本/状态存活）/ `kept_alive_per_parent_cap_evicts_within_that_parent`（PendingInner 层，per-parent 比 global 紧才可观察）/ `byte_eviction_keeps_connection_on_session`（字节淘汰只丢文本、不碌连接）· red 实录：`error[E0560] no field kept_alive_cap / kept_alive_cap_global / kept_alive_cap_per_parent`（功能缺失，同 2.1 先例）
  - [x] 3.4 修 R2 漏项：淘汰回收 + 数量上限 (green)
    - `evict_completed_over_cap` 改为**返回被淘汰的 child_connection_id 列表**，调用方释放锁后 disconnect（原版直接 remove → 进程泄漏）
    - 新增 `kept_alive_cap`（全局 + 每父会话两层 FIFO）
    - _Requirements: 1.5, 5.4, 5.5, 5.6_
    - ✅ 2026-07-26: `DelegationConfig.kept_alive_cap`（默认 8，0=不限）+ `PendingInner.kept_alive_order` FIFO + `kept_alive_cap_global`/`kept_alive_cap_per_parent`（同值双层）+ `settle_session` 返回被淘汰连接列表（#[must_use]，全部 6 个调用点释锁后 disconnect 或 debug_assert 空）+ `set_config` 降 cap 即时 prune。验证：`delegation` → **294 passed; 0 failed**。—— ❗ 偏差（charter 描述 vs 三层分离后的代码现实）：**未**改 `evict_completed_over_cap` 签名。R2 的前提「缓存是连接唯一持有者」只在上游把 conn id 堆在 CompletedTask 上时成立；本分支连接持有者是 SessionEntry，字节淘汰只丢文本、碌不到连接（D2 判据：清空 completed 只变慢不变错；若按 charter 字面改签名会让文本预算决定进程生死，违反该判据）。R2 要求的「锁内取 id → 释锁后 disconnect」机制原样落在了正确的层（settle_session/enforce_kept_alive_caps）；进程泄漏风险由 kept_alive_cap + idle sweep 封死，`byte_eviction_keeps_connection_on_session` 测证字节路径无孤儿。另：`commands/delegation.rs::into_broker_config` 补 `..DelegationConfig::default()`（加字段的穷举构造编译修复，设置面留给 T5）
  - [x]* 3.5 Write failing test (red) — 续聊与取消竞态
    - 断言 S3/S4 窗口内父取消能捕获该轮（**修 R3 漏项**）
    - **Property 2: 续聊不增行** _Validates: Requirements 3.4_ — 续聊前后 `conversation` 行数相等
    - **Property 4: task_id 稳定性** _Validates: Requirements 2.3, 4.2_
    - _Requirements: 2.3, 3.4, 6.1, 6.2_
    - ✅ 2026-07-26: 7 个新测：活连接复用+task_id 稳定+turn 层（P4/8.1）/ 只走 followup 通道不碰建行通道（P2：行创建只发生在 send_prompt_linked_for_delegation，broker 层的守恒即「续聊零调用该通道+零新 spawn」）/ session_still_running / 同 continuation_id 幂等 / 同 id 异 payload 冲突 / 跨父 Unknown / **S4 窗口内父取消捕获（R3 核心，用 test-local GatedFollowupSpawner 闸住 send_followup_prompt 确定性钉窗口，不改 spawner.rs）** · red 实录：`error[E0599] no method continue_delegation` + `E0433 TurnOrigin` + `E0560 ChildStatusRecord no field folder_id/external_id/working_dir`（功能缺失）
  - [x] 3.6 `continue_delegation` 五阶段编排 (green)
    - 按 design.md §阶段化补偿矩阵实现 S1-S5，每个失败点的补偿动作明确（新建连接后发送失败**必须** disconnect 它）
    - **先 `register_inflight` 再发 prompt**（修 R3-A3 竞态）；`running.insert` 前查 `take_inflight_cancel`
    - 不得走 tool-call claim 路径，用 `write_meta_if_real` / `emit_started_if_real` 直接指名（保 `44415f56`）
    - _Requirements: 2.3, 2.13, 6.1, 6.2, 6.3_
    - ✅ 2026-07-26: `continue_delegation(parent_connection_id, parent_conversation_id, task_id, message, continuation_id, origin)` 五阶段全落：S1 锁内 ledger 去重/归属(D5 conversation 优先)/状态门 + **register_inflight 先于一切 I/O**(R3) + 乐观 Running 标记防并发双起；S2 is_alive→保活直发 / spawn_for_resume(external_id)；S3 发前取消检查(未发 prompt→恢复原态、只断新建连接)；S4 失败补偿(abort_continuation 恢复 prior_status+conn，新建连接必 disconnect、保活连接保留)；S5 锁内终检 inflight_canceled(已发→cancel+disconnect+settle Canceled)+push_turn(turn_version 单调)+remove_completed_entry+running.insert。直接指名原 parent_tool_use_id 重发 meta running + started(零 claim)。OperationRecord ledger(task_id+payload+首次报告)。**Requirement 2.8a 顺带落地**：RunningTask.turn_version 门控 finalize_delegation/teardown_canceled_child 的 emit_completed(续聊轮 >1 不对已终态 tool call 重发 completion，meta 快照仍写)。ChildStatusRecord +folder_id/external_id/working_dir(DbChildStatusLookup 经 folder_service 解 working_dir)。验证：`delegation` → **301 passed; 0 failed**(294+7)。备注：错误码以 broker 局部常量铸报告(session_still_running/continuation_conflict/not_continuable)，T4.1 收口进 DelegationError 变体
  - [x] 3.7 `close_delegation_session`（释放语义）
    - 内部状态 `Released`（**不是** `closed`）；running 态先取消再释放；重复调用幂等
    - 取消确认超时 5s → 标 `release_pending` 转后台；disconnect 失败 → 后台重试 + `orphan_suspect` 标记
    - _Requirements: 2.7, 2.9, 2.10, 2.11, 2.12, 5.3_
    - ✅ 2026-07-26: red 先行（6 测：释放+阻断续聊(session_released) / 幂等(同 id ledger 重放+新 id 都无副作用) / 无活连接仍释放 / running 先取消(cancel+disconnect+Canceled) / **close 与 in-dispatch continue 串行化(2.12·gated·InflightSetup 加 task_id 关联+`mark_inflight_canceled_for_task` 精确打点,不波及同父其它 setup)** / disconnect 失败标 orphan_suspect+后台重试(test-local FailingDisconnectSpawner)），red 实录 `E0599 no close_delegation_session` + `E0609 no field released/orphan_suspect`。green：`SessionEntry.released/orphan_suspect` + `close_delegation_session(parent_connection_id, parent_conversation_id, task_id, continuation_id)`（锁内一次判定：ledger 重放→归属→released 幂等→running drain 或 flag in-dispatch→标记 released+take conn+退 FIFO+清该 task 旧 ledger+写 close op；锁外 teardown 后台化+disconnect 失败 orphan_suspect+500ms 重试）· 验证：`delegation` → **307 passed; 0 failed**（301+6）。—— ❗ 偏离 charter 一处：**未实现「取消确认超时 5s → release_pending 标记」**，改为取消 teardown 一律后台化（与既有 `cancel_by_parent_turn` 同姿势，满足设计「不阻塞」意图）；理由：5s 等待分支需要可注入 cancel 延迟的 mock 才能测，成本高且「先等 5s 再转后台」相对「立即转后台」对调用方无语义增益（close 返回即代表释放已提交）。release_pending 概念因此不需要独立字段
  - [x] 3.8 resume 前置拒绝 + external_id 三元校验
    - resume 链不可用 → **在发 prompt 前**返回 `resume_unavailable`，**不覆盖 `external_id`**（BS-016）
    - 恢复前校验 DB 行的 `agent_type` / `folder_id` 与目标一致；重复 `external_id` 无法唯一定位 → 拒绝
    - _Requirements: 3.1, 3.2, 3.3, 3.3a, 7.6, 7.7_
    - ✅ 2026-07-26: red 5 测（resume happy path 守卫 / spawn 失败→resume_unavailable 且零 prompt 副作用、原态可重试 / agent_type 不符拒绝且零 resume 尝试 / folder 绑定不符拒绝 / 重复 external_id→resume_unavailable），red 实录 `E0407 external_id_ref_count is not a member`。green：resume 分支强制回读 DB 行（校验物质基础，行缺失即拒）→ 三元校验（agent_type+child_conversation_id+folder）→ 凭据优先用 DB 行（缓存仅兼容，永不被 None 覆写，3.3a）→ `external_id_ref_count`>1 拒（trait 默认 0，Db 实现真查且查询失败 fail-closed 返 usize::MAX）→ spawn Err 改映射 resume_unavailable。验证：`delegation` → **312 passed; 0 failed**（307+5）。—— ⚠ 跨文件缺口上报：「静默 session/new 降级」的 broker 侧检测**在当前 spawner trait 下不可实现、未做**——connection.rs 的 resume 链内部静默回退 session/new，trait 无接口暴露「resumed vs new」；且 lifecycle.rs:189 `update_external_id` 无条件覆盖的 gate 也需动 lifecycle 共享路径。已实现全部**可检测面**的前置拒绝；剩余面需 T2 补 spawner 能力（如 D3.1 capability 查询落地 SessionState）或 lifecycle gate，归 T4/后续裁决，不在本包私改 manager/lifecycle
  - [x] 3.9 启动重建协议
    - `rebuild_sessions_from_db()`：扫 `kind=Delegate AND deleted_at IS NULL AND external_id IS NOT NULL`；归属校验；单行失败隔离；重建中返回 `rebuilding`
    - operation ledger **不跨重启**复用
    - _Requirements: 7.1, 7.2, 7.3, 7.4_
    - ✅ 2026-07-26: red 4 测（重建后可续聊(旧 continuation_id 视为未见过、7.4)/死父行跳过且不阭断其余(7.3)/重建中 session-miss 返 `rebuilding` 非 Unknown(7.2，continue+close 两处)/重建不覆盖活 entry），red 实录 `E0407 list_rebuildable` + `E0425 RebuildCandidate` + `E0599 rebuild_sessions_from_db` + `E0609 rebuilding`。green：`RebuildCandidate`（parent_alive 由 lookup 解析，broker 保持存储无关）+ trait `list_rebuildable` 默认空 + Db 实现（枚举型 Kind/Status 匹配、逐行查父活性、folder 解 working_dir、agent_type 解析失败单行跳过）+ `PendingInner.rebuilding` 标志 + 接线：`codeg_server.rs`（apply_persisted_config 后、listener 起来前 await）与 `lib.rs` tauri setup block_on 内各一行（防 E-052 死代码）。turn 历史/ledger 不跨重启（turn_version=0、operations 空）。验证：`delegation` → **316 passed; 0 failed**（312+4）。备注：崩溃残留的 `in_progress` 行重建为 Running 状态（按 design「TaskStatus 由 DB status 推出」字面），对其 continue 会得 session_still_running 直到行状态被其它路径修正——DB 状态生命周期属外部问题，已记录
  - [x] 3.10 `cancel_by_parent` 语义修正（R2-B6）
    - 父**连接**拆除只释放运行租约，**不** disconnect 保活连接；父 **conversation** 删除才释放
    - `cancel_by_parent_turn` 保留 `keep_consumed` 语义不动（保 `99657a5a`）
    - _Requirements: 1.4, 1.4a, 6.3_
    - ✅ 2026-07-26: 1.4（连接拆除不碌保活）在三层分离时已**结构性达成**（cancel_by_parent 只 drain running + drop 文本缓存，sessions 不动），新增守卫测 `parent_connection_teardown_keeps_settled_children_alive` 锁定（含重连父用新 connection id 续聊成功——D5 归属校验的端到端证据）；1.4a red 2 测（settled 释放精确到本父、他父不动；running 先 cancel+disconnect），red 实录 `E0599 no release_children_of_parent_conversation`。green：`release_children_of_parent_conversation(parent_conversation_id)`（锁内 drain running → 逐 session 标 released+take conn+退 FIFO+清 ledger+flag in-dispatch continue；锁外 teardown+disconnect，drained 连接去重防双 free）+ 接线两删除入口：`web/handlers/conversations.rs::delete_conversation`（state.delegation_broker）与 `commands/conversations.rs::delete_conversation`（tauri app.state，仅挂钩子零重构）。`cancel_by_parent_turn`/`keep_consumed` 零改动（既有 `turn_cancel_keeps_consumed_rejects_reemit` 等测保持绿，保 99657a5a）。验证：`delegation` → **319 passed; 0 failed**（316+3）。conversation_service.rs 全程未碰
  - [x] 3.11 Checkpoint — broker 既有 168 测试全绿
    - `cargo test --features test-utils delegation` → 全绿（含 3 处反转断言 + 新增测试）
    - `cargo clippy --all-targets --features test-utils -- -D warnings` → 零警告
    - ✅ 2026-07-26 三连实录：① `cargo test --no-default-features --features test-utils --lib delegation`（主 AI 裁定的等效命令，worktree 环境限制见顶部）→ **`test result: ok. 319 passed; 0 failed`**（288 基线全绿 + 本包新增 31；含 3 处反转断言）；② `cargo clippy --all-targets --features test-utils -- -D warnings` → **EXIT=0**（修了首跑报出的 3 处测试内 get-then-check + TurnRecord 字段非 test 编译无读者→`#[allow(dead_code)]`+注释指向 T4.3 事件消费）；③ `cargo test --no-default-features --bin codeg-server --lib` → 首跑 5 比（全在 chat_channel webhook，HTTP 502/超时），受控对照证实为本机代理拦截 localhost（清代理环境变量后 chat_channel 112 全绿），清代理重跑全套 → **`test result: ok. 1772 passed; 0 failed; 1 ignored` EXIT=0**。末尾变体扫描：settle 收口点 6/6 路径全过 settle_session；kept-alive FIFO 维护点（settle/close/release/continue S1/S5）全部 retain；send-failure/spawn-window 路径 session 尚未创建无泄漏；cancel 路径 disconnect 断言逐一保留未反转

- [x] 4. 对外契约（W4 · 依赖 T3）
  - [x] 4.1 `types.rs` 5 个错误码
    - `session_still_running` / `session_released` / `not_continuable` / `resume_unavailable` / `continuation_conflict` + `from_err` 映射 + `with_task_id()`
    - facade 接受 `session_closed` 作历史别名
    - _Requirements: 2.4, 2.5, 2.6, 3.2, 3.3_
    - ✅ 2026-07-26: red 4 测(from_err 六码映射 / `session_closed` 别名规整 / with_task_id 只填空不覆盖 / detail 变体带原因),red 实录 `E0599 no variant SessionStillRunning...` + `E0425 canonical_continuation_code` ×11。green:DelegationError 新增 **6** 变体(设计 5 个 + `Rebuilding`,后者是 W3 落地 R7.2 时的既有 wire 码,一并收口——与 design §错误码"5 个"的偏离已记)+ `from_err` 六臂 + `canonical_continuation_code`(`session_closed`→`session_released` 别名 SSOT)+ `DelegationTaskReport::with_task_id`。broker 机械替换:`continuation_err_report` 改收 `DelegationError`(经 `from_err` 铸码,types.rs 成错误契约唯一真源),14 个调用点全换,6 个 `CODE_*` 局部常量删除(`git grep CODE_SESSION\|CODE_NOT_CONTINUABLE\|...` 零命中)。注意:NotContinuable/ResumeUnavailable 的 wire `message` 现带 Display 前缀("subagent session cannot be continued: <原因>"),error_code 不变,323 测全绿证明无测试断在旧 message 上 · 验证:`cargo test --no-default-features --features test-utils --lib delegation` → **323 passed; 0 failed**(319 基线 + 4 新增)
  - [x] 4.2 transport + listener + companion
    - `transport.rs`：`BrokerContinueRequest`（含 `continuation_id` **必需**）/ `BrokerCloseSessionRequest` + 2 个 round_trip
    - `listener.rs`：2 个 dispatch + process；**`continuation_id` 缺失即报错，listener 不代生成**（R2-B5）
    - `companion.rs`：2 个 tool arm + features 白名单；参数校验（空串 → JSON-RPC `-32602`）
    - `tool_schema.json`：2 个新工具 + 3 段描述改写（引导 LLM 优先 continue）
    - `mod.rs`：2 个 rewrite title 常量
    - _Requirements: 2.1, 2.2, 2.13_
    - ✅ 2026-07-26: red 10 测(transport 2 round_trip + **缺 `continuation_id` 即 serde 解码失败** ×2(R2-B5 类型层强制,listener 物理上不可能代生成) / listener 3(continue unknown-task 全链 round trip、token-parent 不匹配 → unknown 不泄露、close unknown-task) / companion 3(-32602 缺 continuation_id/message,错误文案点名缺失字段)),red 实录 `E0422 BrokerContinueRequest not found` + `E0599 no variant Continue/CloseSession` ×12。green:transport 2 struct(`continuation_id: String` 无 serde default)+ 2 变体 + 2 client round_trip;listener 2 dispatch arm + `process_continue`(token→parent 校验同 pr375,rename_input 含 continuation_id——对 pr375 的有意补充,因我们 schema 里它真实存在)+ `process_close_session`(parent 从 token 解析,同 cancel_delegation 姿势),broker 调用带 `TurnOrigin::ParentAgent`;companion 8 工具 doc 头 + allows_tool 白名单 + 2 arm(task_id/message/continuation_id 三重非空校验,continue 无 external_handle——取消只压响应,幂等由 ledger 兜);tool_schema.json 2 工具照 pr375 措辞 + **continuation_id 必填**(带"mint fresh UUID / retry 才复用"的 prompt 工程)+ close 全文释放语义("Release...frees resources, does not delete";新增断言 `desc.contains("Release") && !contains("permanently")`)+ 3 段描述改写(delegate/status/cancel 均引导优先 continue);mod.rs 2 常量 + 模块 doc 从 v1 one-shot 改为保活/释放叙述。既有工具计数断言 3→5 / 4→6 同步(E-060 契约传播)。验证:`cargo test --no-default-features --features test-utils --lib delegation` → **333 passed; 0 failed**(323+10)
  - [x] 4.3 session-scoped 事件（替代复用旧 tool-call completion）
    - 事件载荷 `(task_id, turn_id, turn_version, origin)`；**不对已终态的 `parent_tool_use_id` 重复发 completion**（R2-B2）
    - _Requirements: 2.8, 2.8a, 8.1, 8.2_
    - ✅ 2026-07-26: red 2 测(续聊轮 complete → session update 四元组齐 + completion 计数仍 1 / 续聊轮 cancel → 同样只发 update),red 实录 `E0599 no method session_update_snapshot/count` ×3。green:`AcpEvent::DelegationSessionUpdate { parent_connection_id, child_conversation_id, task_id, turn_id, turn_version, origin }`(wire tag `delegation_session_update`,TurnOrigin 加 serde snake_case 上 wire:`parent_agent`/`user`);emitter trait 新增 `emit_session_update`(Noop/CM/Mock 三实现,Mock 记 `SessionUpdateCall`);RunningTask 增 `turn_id: Option<String>` + `origin`(初轮 None/ParentAgent,续聊轮从 push_turn 捕获);发射收口单点 `emit_session_update_for_settled_turn`(自门控 version>1),挂两处:complete_call settle 后 + `teardown_canceled_child` 的 2.8a else 臂——**全部 cancel 路径都汇于 teardown_canceled_child(7 调用点 grep 核实),覆盖无漏**;S5 窗口内取消无 turn record 不发(调用方同步拿到 canceled 报告)。session_state `apply_event` 归入纯通知 no-op 臂(8.4:查询是真源,事件不进快照);前端 `src/lib/types.ts` EventEnvelope 加 `delegation_session_update` 镜像(真实后端字段,区别于 W5 当时拒绝的假契约)。**桥接路径确认**:新增生产 fanout 测 `real_emitter_fans_out_session_update_to_parent_stream_and_bus`——真 ConnectionManager + WebOnly emitter,断言事件同达 per-connection stream(WS attach → 前端 EventEnvelope)与 InternalEventBus,并钉 wire JSON(`type=delegation_session_update`/`origin=user`),证明与 BackgroundActivity/DelegationCompleted 同走 `emit_with_state` 自动广播、不会沦为 desktop-only。验证:`cargo test --no-default-features --features test-utils --lib delegation` → **336 passed; 0 failed**(333+3)
  - [x] 4.4 Checkpoint
    - `cargo test --no-default-features --bin codeg-server --lib` + `cargo check --no-default-features --bin codeg-mcp` → 绿
    - `cargo test --no-default-features --features test-utils --lib` 全量 → 绿
    - ✅ 2026-07-26 四连实录:① `cargo test --no-default-features --features test-utils --lib` → **`test result: ok. 1789 passed; 0 failed; 1 ignored`**(基线 1772 + 本包 17:types 4 / transport 4 / listener 3 / companion 3 / broker 事件 3);② `cargo test --no-default-features --bin codeg-server --lib` → **1789 passed; 0 failed**;③ `cargo check --no-default-features --bin codeg-mcp` → `Finished` 零错误;④ `cargo clippy --all-targets --features test-utils -- -D warnings` → **EXIT=0**。环境备注三条:(a) chat_channel webhook 5 测在系统代理下必红(W3 已定性),仅清 env 代理变量不够——**reqwest 在 Windows 还读系统代理(注册表),必须 `set NO_PROXY=localhost,127.0.0.1`** 才稳定绿(受控对照:无 NO_PROXY 红 / 有则绿,复现两次);(b) `commands::conversations::tests::legacy_import_shares_the_guard_with_batch_import` 偶现并行 flaky(一次全量红、单跑绿、再全量绿),非本包引入、未改动该文件;(c) `cargo fmt --check` 全仓预存漂移(parsers/commands 等数百处,均为本分支从未触碰的文件,rustfmt 版本差异),**本包所有触碰文件零 fmt diff**(grep 核实 acp/delegation/* 与 types/session_state 不在 diff 列表),项目门禁清单亦不含 fmt,故不做无关整仓重排
  - [x] 4.5 静默降级的最后检测面（W3 上报缺口 · 主 AI 裁决归入本包）
    - `lifecycle.rs`（`update_external_id` 调用点，约 189 行）加守卫：`kind=Delegate` 的会话行仅当 `external_id` 为空、或新 session id 来自非降级路径时才写——实现 Requirement 3.3a
    - D3.1 capability 落 `SessionState`：把 `initialize` 已取到的 `load_session` / `session_capabilities.resume` / `.fork` 三字段存入（现在只 log 不存，`connection.rs:3004-3018`），供 broker 的 `resolve_resume_meta` 查询
    - broker 侧 3.8 已实现全部可检测面（凭据缺失/歧义/三元不符/spawn 失败）；本子项补齐后，`resume_unavailable` 覆盖面完整
    - _Requirements: 3.3, 3.3a_
    - ✅ 2026-07-26: **守卫**——red 1 测(4 断言:空凭据首写落地 / 异值覆写拒绝为静默 no-op / 同值幂等 / 根会话保留全覆写语义),red 实录 `E0425 update_external_id_resume_safe` ×5。green:守卫落在 **service 层 SSOT** `conversation_service::update_external_id_resume_safe`(判据:Delegate 行 + 既有非空凭据 + 异值 → 拒;resume/load 保持同 id、异值只能来自 session/new 降级,故「凭据非空即拒异值」与 charter「非降级路径才写」语义等价且可实现——SessionStarted 事件本身不携带降级标记);接线两个 SessionStarted 驱动写入点:`lifecycle.rs:189` + **`manager.rs:997`(变体扫描新发现:send_prompt_linked 的同步快照写在 Branch A followup 路径同样会跑,是同一 3.3a 违规变体,一并收口)**。未动的另两个 update_external_id 调用点及理由:`chat_channel/session_event_subscriber.rs:122`(chat bridge 只管 webhook 根会话,delegate 子行不进 bridge)、`commands/conversations.rs:1042`(ACP UUID→parser branch id 的凭据格式矫正,产出的是更优的可用凭据,非 session/new 降级形态,拦了反而冻结 Claude 子行的 detail 加载优化)。**D3.1**——red 1 测(`E0609 no field agent_supports_*` ×9),green:SessionState 三字段 `agent_supports_load_session/resume/fork`(默认 false)+ `connection.rs` capability log 点旁真实落存(原 log-only);经 `manager.get_state` 可查,消费方 = T5 `get_continuation_availability`(**该方法经 grep 证实 broker 尚未实现,charter 上下文有误——归 T5.2**)。诚实边界:connection.rs 的 handshake 写入无法单测(需真 agent initialize),由编译 + clippy 兜;字段级测试仅锁定存在性与默认值。验证:全量 `cargo test --no-default-features --features test-utils --lib` → **1791 passed; 0 failed**(1789+2);`--bin codeg-server --lib` → **1791 passed**;`cargo check --bin codeg-mcp` EXIT=0;clippy 桌面 feature EXIT=0;前端 `tsc --noEmit` 真实退出码 0(PS $LASTEXITCODE 核实)

- [x] 5. 用户侧入口（W6 · 依赖 T3+T4 · **PR #375 完全没做的部分**）· 5.5 落最小档，完整档 PENDING
  - [x]* 5.1 Write failing test (red)
    - `web/handlers/delegation.rs` handler 测：不存在的 child id → `Unknown`（不泄漏存在性）；普通会话 id（`parent_id` 为 null）→ 拒绝
    - _Requirements: 4.1, 4.2, 4.6_
    - ✅ 2026-07-26: 5 个 handler 测（continue unknown → `Unknown` 且零 error_code / continue root 会话 → `not_continuable`+`Failed` / close unknown → `Unknown` / availability unknown → `NotContinuable` / availability root → `NotContinuable`），直接调真 handler 函数（`AppState::new_for_test` + in-memory DB + 真 broker 栈，非 mock 断言）· red 实录：`E0432 unresolved import ContinuationAvailability` + `E0422/E0425` ×10（功能缺失，非语法错）。备注偏差：charter 说「参考同文件既有 settings handler 测试骨架」——该文件原本**无任何测试**（38 行纯 handler），骨架系本轮新建，构造方式取自 `app_state.rs::new_for_test` 的文档化用途
  - [x] 5.2 command + handler + router + api (green)
    - ✅ 2026-07-26: **broker 侧一并建**（charter 已预告缺失）：`ContinuationAvailability` 五档枚举（wire snake_case；`Closed` 档按 R2-B4 对外名 `released`）+ `get_continuation_availability(child_conversation_id)`（sessions 锁内快照 → 锁外 spawner 探针；unknown 与 not-continuable 同码不泄漏存在性；判定链 released→Running→is_alive→external_id（session 缓存→DB 行兜底）→D3.1 capability）。**D3.1 capability 消费闭环（E-052 缺口清偿）**：spawner trait 新增 `continuation_capability`（默认 None，测试内手写转发 spawner 零改动）+ `ConnectionManagerSpawner` 生产实现读 `SessionState.agent_supports_load_session/resume` + `MockSpawner.set_capability`；LiveOnly agent 进程死后判 `NotContinuable`（broker 测含正反对照）。`commands/delegation.rs`：`resolve_delegation_target`（D5 按 conversation id 定位：行→`delegation_call_id` 即 task_id + `parent_id` 即归属；`get_by_id_optional` 新增于 conversation_service，missing=Ok(None) 而 DB 故障仍上抛）+ 三 `_core` + 三 `#[cfg_attr(tauri-runtime)]` command + `USER_ENTRY_CONNECTION_ID`（用户侧合成 connection id，归属校验走 conversation id，连接 id 仅作 run lease/inflight 键）。`web/handlers/delegation.rs` 三端点（camelCase params，拒绝走 report 形状非 HTTP error）+ `web/router.rs` 三路由 + `lib.rs` invoke_handler 三注册。`src/lib/api.ts`：`continueDelegation`/`closeDelegationSession`/`getContinuationAvailability` + `DelegationTaskReport`/`ContinuationAvailability` TS 镜像——**偏差：未动 `tauri.ts`**，既有 delegation settings 先例即只走 `getTransport().call`（Tauri invoke 名 = web route 名），`tauri.ts` 无对应层，charter 所列 `tauri.ts` 系按旧模式推测 · broker 新增 5 测（unknown / running→live→released 三档全生命周期 / 死连接+凭据→resume / 死连接无凭据→not_continuable / LiveOnly 死后 not_continuable+capability 恢复对照）· 验证：`cargo test --no-default-features --features test-utils --lib delegation` → **346 passed; 0 failed**（336 基线 + 10 新增）
  - [x] 5.3 Dialog 输入框 + 五档可续聊状态
    - ✅ 2026-07-26: red 先行 4 测（live 可用+提交路由 continueDelegation+成功清空 / released 禁用+释放文案 / 拒绝错误码上屏+同文本重试复用同一 continuation_id / 本子会话事件重查 availability 且他子会话事件不触发），red 实录 `Unable to find [data-testid="continuation-input"]` ×4、既有 29 测无回归。green：`SubAgentContinuationComposer`（sub-agent-session-dialog.tsx 内，挂 MessageListView 之下）——availability 挂载查 + `useAcpEvent` 收 `delegation_completed`/`delegation_session_update`（按 child_conversation_id 过滤）重查 + 发送失败重查（三个刷新时机齐）；`continuation_id` = `crypto.randomUUID()` 按「提交」铸造，**同文本重试复用、改文本换新 id**（防 continuation_conflict）；五档→UI：running 禁用+工作中提示 / released 禁用+释放文案（「释放」措辞，非永久关闭）/ not_continuable 禁用+说明 / continuable_resume 可用+首轮稍慢提示 / continuable_live 可用；拒绝时 `role="alert"` 上屏稳定错误码、草稿保留；查询竞态 latest-wins seq guard。测试设施：`@/lib/api` importActual+override（未 stage 的既有测试得 `not_continuable` 兜底防 undefined.then 拆树）、`useAcpEvent` mock 按引用去重收集 handler · 验证：dialog **33 passed**（29 既有 + 4 新增）
  - [x] 5.4 continue/close 卡片渲染
    - ✅ 2026-07-26: red 21 失败实录（normalization 13 / classifier 6 / card 2）。green：`tool-call-normalization.ts`（EXACT alias ×8 含 `mcp__codeg-mcp__`/`mcp__codeg-delegate__`/`mcp__codeg__` 变体 + suffix regex ×2 + `DELEGATION_COMPANION_TOOLS` 扩 2 → meta.claudeCode.toolName / title / codeg.delegation meta 三条 live 识别路径自动覆盖）；`adapters/tool-kind-classifier.ts`（bare + suffix RE ×2，**偏差：charter 写 `tool-kind-classifier.ts` 实际路径在 `src/lib/adapters/` 下**）；`content-parts-renderer.tsx` 两分支 → `DelegationStatusCard kind="continue"/"close"`；card/row `kind` union 扩为四值（continue=MessageSquarePlus / close=Unplug 图标）；`delegation-status.ts::deriveBadge` kind 扩 + **canceled 对 close 判 ok**（释放 running 任务本就先取消，Requirement 2.9）；locale ×10 各 +11 keys（5.3 的 7 个 composer keys + 5.4 的 4 个卡片 keys；close 全部「释放」措辞）· 验证：normalization+classifier+card **153 passed**；`src/i18n/messages.test.ts` 9 passed（双向 diff 门禁绿）
  - [x] 5.5 消除双写入口（M2 必交项）— **落「最小可行」档；完整档 PENDING**
    - ✅ 最小档 2026-07-26: Dialog 内用户发送 100% 走 broker——composer 是 Dialog 唯一发送入口（`continueDelegation`），Dialog 无任何 `acpPrompt` 路径；边界提示条继续声明「标签页发送不同步主 AI」
    - ⏳ PENDING（完整档）: `ConversationDetailPanel` 子会话发送改道 `continueDelegation`。不落的结构性理由（§0.18 上报而非硬改）：① detail panel 打开子会话时经 `useConnectionLifecycle` 以 `externalId` **自建一条 ACP 连接**，其流式回显/optimistic turn/队列全绑在这条自有连接上；broker 续聊轮走的是 broker 持有的子连接（保活或 resume 新建），panel 物理上收不到那条流——只改发送不改显示 = 消息发出后 panel 静默无回显，比双写更糟 ② `handleSend` 是 2245 行文件的核心链（optimistic/queue/viewer/create-row 五路交织），分叉改造量远超本包其余总和且高回归风险。正确解需要「子会话 detail panel 的连接归属让渡给 broker」级别的架构裁决，归主 AI/后续任务。**过渡期双写入口 = design §M1 已显式登记的技术债**（8.1 写 ARCHITECTURE 债务段时一并记）。验收 grep 现状：`git grep -ln "acpPrompt" -- src/` → `acp-connections-context.tsx`（通用 sendPrompt 链，root 会话与子会话标签页共用）+ `api.ts`/`tauri.ts`/`turn-busy.ts`（定义与文档）——子会话标签页绕过路径仍存，与 PENDING 一致
    - 附注（§0.17 自查）：`closeDelegationSession` 前端函数暂无 UI caller——requirements 4 未定义用户侧释放控件，为对称加「释放按钮」属 D 类技术洁癖，不做；该函数保留为三端点契约镜像（HTTP/Tauri 端点有测试，wire 语义的生产消费者是 MCP `close_session`）

- [ ] 6. 多轮时间线（W5 · 纯前端 · 与串行链并行）
  - [x]* 6.1 Write failing test (red)
    - **Property 5: 时间线历史保全** _Validates: Requirements 4.7_
    - 断言：N 个已持久化 turn 的子会话，第二轮流式期间仍渲染 ≥N 个
    - 断言：事件 `turn_version` 低于已应用版本 → 丢弃；缺口 → 触发回查
    - _Requirements: 4.7, 8.3, 8.4_
    - ✅ 2026-07-26: 新建 `src/stores/delegation-multi-turn-timeline.test.ts`（5 例：多轮历史保全 / 只砍 in-flight 轮的 partial / localTurns 晋升期历史保全 + 2 条单轮回归守卫）。red 实录：3 failed（`expected 2 to be greater than or equal to 4`、`[ 'u1', 'live-77-m3' ]` vs 6 项）、2 passed。`src/components/message/sub-agent-session-dialog.test.tsx` 追加 describe「multi-round continuation」3 例，red 实录 2 failed（第二轮 `completeTurn` 从未被调用，只有 round-1）。`turn_version` 裁决未写测试 —— 见 6.3 依赖说明
  - [x] 6.2 `computeTimelinePrefix` 多轮切点 (green)
    - `src/stores/conversation-runtime-store.ts:2380-2404`：从「砍掉首个 assistant 之后全部」改为按 `in_flight_user_turn_id` 或最后一个持久化 user turn 为切点
    - `useChildLiveBridge` 的 `adoptedRef` / `everPromptingRef` 从一次性 latch 改为每轮 reset
    - _Requirements: 4.7_
    - ✅ 2026-07-26: `src/stores/conversation-runtime-store.ts` 的 `computeTimelinePrefix` 切点改为 `in_flight_user_turn_id`；无该锚点时仅在「持久化 user turn ≤1」（单轮形状，含 kickoff 尚未落库）才裁剪，多轮无锚点一律全保留（可见重复可恢复，隐藏已完成轮不可恢复）；原 SINGLE-REPLY 注释已重写。`src/components/message/sub-agent-session-dialog.tsx` 的 `useChildLiveBridge`：`adoptedRef`/`everPromptingRef` 两个 mount 级 latch 换成按 `liveMessage.id` 记账的 `streamedReplyIdsRef` / `promotedReplyIdsRef`，每轮可重入且同一轮不重复晋升。验证：`vitest run src/stores src/components/message/sub-agent-session-dialog.test.tsx src/contexts/conversation-runtime-context.test.tsx` → 12 files / 165 tests 全绿（含既有 53 例 runtime-context 与 2 条单轮回归守卫）；`tsc --noEmit` exit 0
  - [ ] 6.3 事件版本裁决
    - 按 `turn_version` 丢弃旧事件；缺口时回查 `get_delegation_status`
    - _Requirements: 8.3, 8.4_
    - ⏳ PENDING: 依赖 T4.3 后端事件载荷。核实（`git grep get_delegation_status -- src`）前端**不存在**任何 delegation status 查询通道 —— 该名字在前端只作为 LLM 工具名出现在渲染/分类代码里，`src/lib/api.ts` / `tauri.ts` 无对应函数；携带 `(task_id, turn_id, turn_version, origin)` 的 session-scoped 事件变体也由 T4.3 定义、当前 `EventEnvelope` 里没有。两端（事件源 + 回查真源）都缺，裁决逻辑无处挂载，写出来只能对着自造的假事件断言 —— 故不写假测试，随 T4.3/T5.2 一并落地

- [ ] 7. 端到端验证（依赖全部）
  - [ ] 7.1 真实端到端跑一次（**E-052 硬条件**）
    - 委托 → 等终态 → 用户侧 Dialog 续聊 → 主 AI `get_delegation_status` 看到新轮次结果
    - `git grep -n "continueDelegation(" -- src/` 必须命中非 tests 的生产 caller
    - _Requirements: 4.1, 4.2, 2.8b_
  - [ ] 7.2 开工核验清单（design.md §R3 采纳项）
    - `external_id` 数据画像：现有 `kind=Delegate` 行中 NULL / 重复 / agent 已卸载各多少 — ⛔ BLOCKED: 本机无真实用户库。`everything-search` 查 `codeg.db` 得 176 个命中，全部在 `%TEMP%\.tmp*\` 下且大小固定 204800 字节 = 测试 fixture；无 >300KB 的真实库。需在有真实委托数据的机器上跑，或等本机产生真实数据后补
    - **Kiro agent 的 resume 能力实测** — ✅ 2026-07-26 部分回答：核实 agent 能力是**自报**的（`connection.rs:3004-3018` 已取 `agent_capabilities.load_session` + `session_capabilities.resume` + `.fork` 并 log），故 D3.1 四档判定不需静态表也不需失败探测；剩余待实测项仅「kiro-cli 的 initialize 是否真上报这些字段」，且即使不报降级结果是 `LiveOnly` 而非静默丢上下文。已写入 design.md §D3.1
    - `kept_alive_cap` 默认值定档 — ✅ 2026-07-26: 随 T3.4 定档 `DEFAULT_KEPT_ALIVE_CAP = 8`（0=不限；全局与每父两层同值，设置面未暴露——T5 裁决是否开放）
  - [ ] 7.3 全套门禁
    - `pnpm eslint .` + `pnpm test` + `pnpm build`
    - `cargo test --features test-utils` + `cargo clippy --all-targets --features test-utils -- -D warnings`
    - `cargo test --no-default-features --bin codeg-server --lib` + `cargo clippy --no-default-features --bin codeg-mcp -- -D warnings`

- [ ] 8. Close-out
  - [ ] 8.1 写回 CHANGELOG + ARCHITECTURE 演进索引 + 技术债台账
    - 过渡期若 M1 已交付而 M2 未完，双写入口记入 `ARCHITECTURE.md` 债务段（design.md §M1 边界）
  - [ ] 8.2 design.md front-matter `status: shipped` + `shipped_commit`
  - [ ] 8.3 `codegraph sync F:\codeg-research`

## Task Dependency Graph

```json
{ "waves": [
  { "id": 0, "tasks": ["1.1", "2.1", "6.1"] },
  { "id": 1, "tasks": ["1.2", "2.2", "6.2"] },
  { "id": 2, "tasks": ["1.3", "1.4", "3.1", "6.3"] },
  { "id": 3, "tasks": ["1.5", "3.2", "3.3"] },
  { "id": 4, "tasks": ["1.6", "3.4", "3.5"] },
  { "id": 5, "tasks": ["3.6", "3.7", "3.8"] },
  { "id": 6, "tasks": ["3.9", "3.10", "3.11"] },
  { "id": 7, "tasks": ["4.1", "4.2", "4.3", "4.4"] },
  { "id": 8, "tasks": ["5.1", "5.2", "5.3", "5.4", "5.5"] },
  { "id": 9, "tasks": ["7.1", "7.2", "7.3"] },
  { "id": 10, "tasks": ["8.1", "8.2", "8.3"] }
] }
```

**串行约束**：T3 全程独占 `broker.rs`（8056 行 + 168 测试），不得与任何其它任务并行。T5.3 与 T6.2 都碰 `sub-agent-session-dialog.tsx` → T6 先合。locale json ×10 被 T1.5 与 T5.4 同碰 → 后合的一次性补齐。

## Update Log

### 2026-07-26 · executor（Task 1 · M1 可发现性）· 全部子项完成

**§0.16 全链路预演（开工前答完）**
- ① 成功状态：用户在侧边栏能一眼分出哪一行是委托子会话；默认不被子会话淹没（漏斗里可开）；在只读 Dialog 里能一键把子会话开成完整标签页，并且当场知道「在那儿发消息主 AI 不知情」。
- ② 端到端链：`conversation 行(DB 三标记)[existing]` → `list_all 根过滤[to-modify]` → `app-workspace-store 纵深防御[to-modify]` → `sidebar-conversation-list 行模型 + showSubsessions 门[to-modify]` → `sidebar-conversation-card Sub 徽标 / 计数徽标[to-modify]`；另一条：`SubAgentSessionDialog[to-modify]` → `tab-store.openTab[existing]` → 完整会话面板[existing]。
- ③ 断点扫描：新函数 `isDelegationSubsession`/`isSidebarRootConversation` 的生产消费点均已接线并 grep 核实（card / list / store 各 1 处，非仅 tests）；新 prop `showSubsessions` 的生产者是 `sidebar.tsx`（漏斗），消费者是 list（已接）；新 locale key 的消费者是 card / sidebar / dialog（已接）；`openTab` 的生产者是新按钮、消费者是既有 tab-store（未改）。
- ④ 消费验证锚点：sink = 侧边栏行 DOM（徽标/嵌套行）+ tab-store 的 openTab 调用 + 后端根列表 SQL。真跑姿态 = vitest 渲染断言（DOM 与 openTab 参数）+ Rust in-memory DB 真查（不是 mock 断言）。**未做 GUI 端到端手点**（本 worktree 无法起桌面二进制，见下方 Rust 偏差）。

**改了什么**
- 新增 `src/lib/conversation-sidebar.ts` + `.test.ts`：`isDelegationSubsession` / `isSidebarRootConversation`，签名只接三个 DB 标记字段，**结构性排除**上游 `1ad6f8f1` 修过的 `depth > 0` 回归。
- `sidebar-conversation-card.tsx`：`isSubsession` 判定改为复用新函数（原 `parent_id != null`，行为不变）；加 `Sub` 徽标 + `data-subsession` + `childCountHint` 计数徽标。
- `sidebar-view-mode-storage.ts` / `layout/sidebar.tsx` / `sidebar-conversation-list.tsx`：`showSubsessions` 开关（默认 OFF）持久化 + 漏斗项 + 行模型门控（关时用稳定空集合抖掉展开集/子缓存，并关掉 child 预取）。
- `app-workspace-store.ts`：`refreshConversations` 与 `applyConversationUpsert` 两处改用 `isSidebarRootConversation`（纵深防御）。
- `conversation_service.rs::list_all`：根过滤由单条 `parent_id IS NULL` 扩为三条 AND；配套 3 个新测试（孤儿 delegate 行 / 仅带 `delegation_call_id` / `include_children=true` 不得过滤）。
- `sub-agent-session-dialog.tsx`：头部「在标签页打开」按钮（`openTab`，folder_id 取自 `detail.summary`，未到时禁用）+ 常驻 M1 边界提示条；10 个 locale 各补 6 个 key。

**验证证据（真实退出码）**
- `eslint` 本轮所改 9 个 ts/tsx：零错（修了 2 处真实 prettier 报错）。
- `vitest run src/lib/conversation-sidebar.test.ts src/components/conversations src/i18n/messages.test.ts src/components/message/sub-agent-session-dialog.test.tsx` → 13 files / **227 passed**, exit 0。
- `cargo test --no-default-features --features test-utils --lib conversation_service` → **21 passed; 0 failed**, exit 0。

**踩到的坑 / 偏差（3 条，需主 AI 知情）**
1. **charter 的 `cargo test --features test-utils` 在本 worktree 跑不了**（与本轮改动无关）：桌面 feature 的 lib 测试二进制加载即 `STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)`，一个测试都没跑。已排除构建竞态（换干净独立 target 目录重建同样挂）与本轮改动（用 `pets::` 过滤同样挂）。PE 导入表对比：该二进制多出 `comctl32.dll!TaskDialogIndirect` / `SetWindowSubclass` 等 v6 API（tao/tauri GUI 链入），而 test harness exe 没有 comctl32 v6 清单 → 加载器绑 v5 失败；主仓同名测试二进制无 comctl32 导入，能跑（18 passed）。本轮改用 `--no-default-features` 跑同一批测试作为等效证据。
2. **worktree 整仓 CRLF**：`core.autocrlf=true` 且仓库无 `.gitattributes`，worktree 里 `eslint .` 报 21.6 万条纯 `Delete ␍`（主仓同命令 exit 0）。已把本轮碰过的 17 个文件归一到 LF（autocrlf 下 diff 中性），未碰的文件一律没动。
3. **`useWorkbenchRoute` 不能进这个 Dialog**：它在 provider 外会 throw，会拆掉现有测试树；而 `openTab` 自带 `activateConversationPane` 副作用已覆盖「回到会话工作区」，故按钮只调 `openTab`（与 charter 描述的调用路径等价，少一次冗余 route 调用）。

### 2026-07-26 · executor（Task 5 · 用户侧入口）· 5.1-5.4 完成，5.5 最小档落地/完整档 PENDING

**§0.16 全链路预演（开工前答完）**
- ① 成功状态：用户在子代理 Dialog 里看到一个按五档 availability 控制的输入框，发出的消息经 broker 落在主 AI 持有的同一 `task_id` 下（主 AI 下次 `get_delegation_status` 可见），被拒时稳定错误码上屏；LLM 的 continue/close 工具调用在时间线渲染为专属卡片。
- ② 端到端链（续聊主链）：`Dialog composer[to-build] → api.ts continueDelegation[to-build] → transport(invoke/POST)[existing] → tauri command / web handler[to-build] → continue_delegation_core(D5 解析)[to-build] → broker.continue_delegation[existing]`；availability 链：`挂载/事件/失败三时机[to-build] → getContinuationAvailability[to-build] → _core[to-build] → broker.get_continuation_availability[to-build] → SessionEntry+is_alive+D3.1 capability+DB external_id[existing]`。
- ③ 断点扫描：broker 新方法的消费者 = _core→handler→api→Dialog 全链本轮建齐；D3.1 capability 三字段接上真实消费者（E-052 缺口清偿）；tauri command 注册 lib.rs invoke_handler ✅；web route 注册 router.rs ✅；locale 10 语言齐（messages.test.ts 门禁绿）；`continueDelegation` 生产 caller grep 命中 dialog.tsx:577（非 tests）。
- ④ 消费验证锚点：sink = 三条 HTTP 端点 + Dialog DOM。真跑姿态 = handler 测试走真 `AppState::new_for_test`（真 broker 栈 + in-memory DB，非 mock 断言）+ vitest 渲染断言提交参数与五档 UI 行为。全真人机端到端（委托→终态→Dialog 续聊→主 AI 查到新轮）归 T7.1，本包未跑（无真实 agent 环境），标 unverified。

**验证证据（真实退出码）**
- Rust：`cargo test --no-default-features --features test-utils --lib delegation` → **346 passed; 0 failed**（336 基线 + 10 新增）；全量 `--lib` → **1801 passed; 0 failed; 1 ignored**；`cargo clippy --all-targets --features test-utils -- -D warnings` → EXIT=0 零警告；`cargo test --no-default-features --bin codeg-server --lib`（NO_PROXY 已设）→ 首跑 1 失败为 T4.4 已记录的 `legacy_import_shares_the_guard_with_batch_import` 并行 flaky（非本包文件），重跑 → **1801 passed; 0 failed**。
- 前端：`tsc --noEmit` EXIT=0；触碰 12 个 ts/tsx `eslint` EXIT=0（--fix 清 3 处真实 prettier 错 + 触碰文件归一 LF，与 T1 同姿势）；vitest 相关 27 files / **427 passed**（含 dialog 33、normalization/classifier/card 153、messages 9）。
- E-052 硬条件：`git grep -n "continueDelegation(" -- src/` → `sub-agent-session-dialog.tsx:577`（生产 caller，非 tests）+ `api.ts:3583`（定义）。

**偏差与上报（4 条）**
1. charter「参考 web/handlers/delegation.rs 既有 settings handler 测试骨架」——该文件原本零测试，骨架本轮新建（AppState::new_for_test）。
2. charter 列 `src/lib/tauri.ts` 需加函数——代码现实：delegation settings 先例只走 `getTransport().call`（invoke 名=route 名），tauri.ts 无此层，未动。
3. charter 写 `tool-kind-classifier.ts` 路径缺 `adapters/` 段——实际 `src/lib/adapters/tool-kind-classifier.ts`。
4. **5.5 完整档 PENDING（需主 AI 架构裁决）**：detail panel 子会话发送改道 broker 需先解决「panel 自建 ACP 连接 vs broker 子连接」的流式归属分裂（只改发送不改显示 = 发出后 panel 无回显），改造面超本包；过渡期双写入口为 design §M1 已登记技术债，随 8.1 入 ARCHITECTURE 债务段。

### 2026-07-26 · executor（Review fixes）· reviewer 抓出的 2 Important + 3 Minor 全部修复

**五项修复落点**
1. **Fix 1（Important · close-vs-continue 复合失败竞态）**：守卫落在 `settle_session`（broker.rs:852，所有 settle 写回的唯一收口点）——session 已 `released` 时冻结 status/指针、把 `keep_conn` 按 Property 1 守恒交还调用方 disconnect；`abort_continuation`（S4-Err 补偿）与 S3 取消检查点两条路径同时被治住。比 reviewer 方案二（只守 `abort_continuation`）上移一层：**S3 pre-send 检查点对 kept-alive 连接同样把 `prior_conn` 写回 released session 且不 disconnect（同根变体，close 注释明言把 teardown 委托给 S3/S5，但 S3 原实现是"恢复"非"拆除"）**，收口点守卫一次覆盖两处 + 顺带冻结 released session 的 status（close 记录的 Canceled 终态不再被补偿路径改写）。
2. **Fix 2（Important · 结构守卫）**：新增服务层收口函数 `conversation_service::update_external_id_skip_delegate`（比 resume_safe 更严：delegate 行连空凭据的 minting 写都拒绝——根会话 id / 启发式匹配 id 永远不能成为凭据）；`chat_channel/session_event_subscriber.rs`（SessionStarted 写入点）与 `commands/conversations.rs`（viewer 凭据矫正路径）都改走它，各带一句语义注释。conversations.rs 选 skip 而非 resume_safe 的理由已写进注释：fuzzy folder/started_at 匹配出的 parser branch id 不是 resume 凭据，空凭据时也不能 mint。
3. **Fix 3（Minor · 注释）**：`set_config` 双 cap 同值处加 TODO（settings 允许两值分离前 per-parent 层同值冗余）；`emit_session_update_for_settled_turn` 加注释（user-origin 轮次 `parent_connection_id` 是合成的 `USER_ENTRY_CONNECTION_ID`，emitter fan-out 永不解析，静默 no-op 是设计意图——主 AI 按 §2.8b 拉取）。
4. **Fix 4（Minor · handler happy path）**：`web/handlers/delegation.rs` 新增 `happy_path_tests::continue_on_live_session_happy_path_matches_ts_mirror_shape`——真实 in-memory DB 行 + MockSpawner + 真 `DbDepthLookup`/`DbChildStatusLookup` 组的 broker，穿 HTTP handler 完成一次 live continue，断言 follow-up 真达连接 + JSON 序列化键集 ⊆ 前端 TS 镜像字段表 + `status` 走 snake_case wire 值。

**红绿实录（全部真跑）**
- Fix 1 红：`close_racing_continue_send_failure_still_disconnects_released_connection` FAILED @ "the released session's connection must be handed to disconnect"（连接泄漏即缺陷本身）→ 守卫后 ok，close 族 18 个测试全绿。
- Fix 2 红：`session_started_never_overwrites_delegate_resume_credential` FAILED（凭据被 `sess-hijack` 覆写:`left: Some("sess-hijack") right: Some("sess-credential")`）→ 改调用点后 ok；服务层新增 `skip_delegate_write_never_touches_a_delegate_row`（空凭据拒 mint / 有凭据拒覆写 / root 行为不变三段锁定）ok。
- Fix 4："红"以负向 mutation 证明（行为本就正确无红可红）：临时从镜像字段表删 `"message"` → FAILED "serialized field `message` is missing…" → 恢复后 ok（E-065 姿势,门非恒绿）。
- 全量：`cargo test --no-default-features --features test-utils --lib` → **1805 passed; 0 failed; 1 ignored**（基线 1801 + 新增 4），EXIT=0。
- `cargo clippy --all-targets --features test-utils -- -D warnings` → EXIT=0（首跑 48s 真编译）；`cargo fmt --check` → EXIT=0。

**偏差上报（2 条）**
1. reviewer 修法定位在 `abort_continuation`,但 S3 检查点（broker.rs S3 分支 settle 处）有同根泄漏（同契约:settle 写回不看 released）；按 §4.8 同根变体同轮清收,守卫上移到 `settle_session` 收口点一次治两处。其余 settle 调用点（complete_call/start_delegation record/各 drain）经逐点核查:keep_conn 为 None 或 released 不可达,守卫为无害加固。
2. 清单说 TS 镜像在 `src/lib/types.ts`,代码现实在 `src/lib/api.ts:3557`（`interface DelegationTaskReport`）,测试注释按实际路径写。

**未做**：无清单外重构;未 commit（按指令留给主 AI）。
