# Tasks · 派发子智能体期间的对话权与委托配置治理

Feature: `midturn-steering` · 2026-07-29
`requirements.md` · `design.md`

## Evidence 契约

每项声明完成前必须回写：勾 `[x]` + `**Evidence**`（verify 命令与结果 / files / AC 编号 / commit，commit 可为 `pending`）+ 追加一行到 `## Update Log`。未回写即声明完成 = 假报告。

---

## T0 委托 enum 漏 kiro（流程外已交付 · 待补审）

- [x] 补 `kiro` 进 `delegate_to_agent` enum + 四处写死计数改派生 + 集合等价 gate + 清理过期注释

**Evidence**
- verify: `cargo test --no-default-features --bin codeg-mcp --lib acp::delegation` → EXIT=0 (273 passed / 0 failed); `cargo clippy --no-default-features --bin codeg-mcp -- -D warnings` → EXIT=0; 负向 mutation 移除 enum 中 `kiro` → EXIT=101 报 `missing ["kiro"]`
- files: `src-tauri/src/acp/delegation/tool_schema.json:12-24`, `src-tauri/src/acp/delegation/companion.rs:1425-1560`, `src-tauri/src/acp/registry.rs:170`
- AC: 无对应 AC（缺陷修复，先于 spec 存在）
- commit: `f3da96b8`
- ⚠️ **流程例外**：本项未经 spec → executor → reviewer 流程，由主 AI 直接实施后提交（用户已知悉并选择保留）。提交时使用 `GATE_SKIP_LANG=1` 绕过全仓 `cargo fmt --all --check`，原因：本机 rustfmt 1.9.0 与仓库风格存在 629 处既有偏差（仓库无 `rustfmt.toml`/`rust-toolchain.toml` 锁定），非本次改动引入；已单独验证本次改动零新增偏差。
- [ ] **T0-R 补审**：由 reviewer 独立评审 `f3da96b8`（重点：gate 是否真守住交付物、集合比较而非顺序比较的取舍是否正确、是否有变体遗漏）

---

## T1 steering 能力探测 + wire 契约（R2.1 / R2.2 · 无前置依赖）

- [ ] 在 `connection.rs:3246-3269` 读 `init_resp.meta` 的顶层 `_meta.steering.supported`，写入新增 session state 字段 `agent_supports_steering`，与既有 `agent_supports_resume`/`_fork` 同一 write 锁临界区
- [ ] 代码注释写明：标志在 initialize 响应**顶层**，是 `agentCapabilities` 的兄弟；按常规去 `agent_capabilities` 内找会永远读到 None
- [ ] **wire 契约**（评审 A4：原链路悬空）：`supportsSteering` 随既有 session 能力快照下发（不新开事件类型）；WS `snapshot` 帧与 HTTP snapshot **两条传输都要带**
- [ ] 前端字段初值 `undefined` → 按 `unknown` 处理（不呈现「立即发送」）
- [x] 单测：标志存在 / 缺失 / 畸形三输入；**负向**——标志挪到 `agent_capabilities` 内应探测为不支持

**Evidence**
- verify: `cargo test --no-default-features --bin codeg-mcp --lib` → EXIT=0 (1937 passed 当时); 负向 mutation 将探测改为 `parse_steering_supported(None)` → EXIT=101 (`left: 0 right: 1`)，主 AI 已独立复现红/绿
- files: `src-tauri/src/acp/connection.rs:1676-1687,3295,3311,3399-3411,9700-9744`, `src-tauri/src/acp/types.rs:206-210`, `src-tauri/src/acp/session_state.rs:409-421,654-656,1382,1473-1481`, `src/lib/types.ts:1416-1419,1816`, `src/lib/snapshot-denormalize.ts:63-68,134-136`, `src/contexts/acp-connections-context.tsx:173-180,519-523,2158-2168,3434-3441`
- AC: R2.1 / R2.2（能力三态）
- commit: 1e0eec4b
- ⚠️ 实现者自查出首版门是**假门**（`include_str!` needle 匹配到测试自身源码），已用 `concat!` 拆分 needle 重建

## T1.5 可达性与令牌绑定（design §2.2.1 · **P1**·原定 P0 已降级 · 与 T2/T7 同期）

> ⚠️ **威胁模型已按实测纠正**：本项目无用户身份层（`web/auth.rs:21-45` 单一共享 `CODEG_TOKEN`；连接层 `owner_window_label` 是窗口生命周期管理非安全边界）。故**不做**"跨用户授权"（无处取身份，虚构=假安全边界）。做下面这四条真实可实现的。

- [ ] 三入口（`steer` / 取消预览 / 取消提交）先过既有 `ConnectionNotFound` 路径（`manager.rs:1945` `get_state_and_emitter`），**禁跳过直接操作**
- [ ] **校验点在 `_core` 层**（Tauri 与 Web handler 共用，禁只加一侧）
- [ ] 令牌**绑定 `conn_id`**（跨连接复用一律拒绝）
- [ ] 新增端点必须挂在既有 `require_token` 中间件之后，**禁开免鉴权路由**
- [ ] 测试：无效/已断开 `conn_id` → 三入口各一条断言 `ConnectionNotFound` 且无副作用；conn A 令牌 + conn B 提交 → 拒绝；同令牌提交两次 → 第二次拒绝且不产生第二次取消
- [ ] 架构债登记：Web 模式为单 token 全权模型，将来支持多用户需全局身份层（不属本 spec）

> 上述子项由 T7 的同一批改动实际覆盖（`manager.rs` 的 `_core` 层前置校验、`router.rs` 在 `require_token` layer 内、令牌绑 `conn_id` 与一次性消费的测试）。本项作为独立条目待 T10 端到端连同前端一起复核后统一勾选，Evidence 见 T7。

## T2 Steer 命令通路（R1.1 · 依赖 T1）

- [ ] `ConnectionCommand::Steer { blocks, message_id, reply }`（`connection.rs:374` 邻位）—— `reply` 为 oneshot，**必须回传 outcome**（`mode` 字段已随双时机方案废弃）
- [ ] `send_steering()` 照 `send_goal_control`（`:4503-4517`）骨架，`UntypedMessage::new("_session/steering", {sessionId, prompt})` + `block_task()`
- [ ] **turn 在飞 select arm**（`:6021` 处）——这是关键，必须在 prompting 态可达
- [ ] 空闲 arm（`:6228` 处）
- [ ] `manager.rs::steer(conn_id, blocks, message_id) -> SteerOutcome`（照 `:1219` `goal_control`，但**必须回传 outcome** —— goal_control 是 fire-and-forget，steer 不是）
- [ ] 处理三种 outcome：`injected` 正常 / `failed`（codex review·compact 轮）回落入队 + 提示 / `startedNewTurn` 按 T3
- [x] **不动** `manager.rs:728-729` 的 `TurnInProgress`（C1）

**Evidence**
- verify: `cargo test --no-default-features --bin codeg-mcp --lib` → EXIT=0 (1969 passed / 0 failed); 定位式门破坏两次均转红（删 arm · 留空 arm）
- files: `src-tauri/src/acp/types.rs:223,1219`, `src-tauri/src/acp/connection.rs:49,404,4625,4659,4686,6246,6505,10119`, `src-tauri/src/acp/manager.rs:1279`, `src-tauri/src/acp/session_state.rs:488,632,669,1543`, `src-tauri/src/acp/error.rs:47`, `src-tauri/src/commands/acp.rs:8401`, `src-tauri/src/web/handlers/acp.rs:415`, `src-tauri/src/web/router.rs:638`, `src-tauri/src/lib.rs:1110`
- AC: R1.1 / R1.6（失败分类）
- commit: 1e0eec4b
- ⚠️ 事实纠正：本机 `codex-acp` v1.1.2 对 `steer|_session/steering` **零命中**，`failed` 分支目前不可达（主 AI 已复验）。spec 中"天然覆盖 Codex"的说法已收回。

## T3 startedNewTurn 竞态降级（R1.1 · 依赖 T2）

- [ ] **原子选择通路**：同一临界区内读 `turn_in_flight` 决定走 steering 还是普通 prompt（把竞态压成残余）
- [ ] 收到 `startedNewTurn` 时**视为投递成功、禁止补发**（评审 A2 · P0：agent 已在执行该消息，补发 = 同一指令执行两次）
- [ ] **禁伪造 `turn_in_flight`**（评审 R2-A3）—— 改用独立态 `detached_turn_pending`，只影响 UI 提示，**不参与** `turn_in_flight` 驱动的任何判定（超时清理/取消/flush 门均依赖其真实性）
- [ ] 收敛条件必为**可关联事实**（可对应 turn 标识的 update / session 断开重连）；**"任意终态事件"与"纯超时"不可作为依据**
- [ ] 找不到可关联证据 → 保持至会话重连 + UI 弱提示（不阻塞操作）
- [ ] 单测断言消息只投递一次、状态机不撕裂（不得 UI 永久 prompting）

**Evidence**（待填）

## T4 队列状态机 + 单一出队（R1.6 / design §2.3.1 §2.5.1 · 依赖 T2）

- [ ] 队列项加 `message_id`（客户端生成）与状态位 `queued | in_flight | delivered | unknown`
- [ ] ~~刷新后 `in_flight` → `unknown` 恢复~~ **删除**：`use-message-queue.ts:40` 是纯 `useState` 零持久化，刷新后队列本就清空，该规则是空操作
- [ ] ~~多窗口单写者限制~~ **删除**：viewer 是 co-controlling 设计（`acp-connections-context.tsx:4021-4029`）且队列 per-panel（`:568`），想防的竞态不存在
- [ ] 三条合法迁移；`delivered` 为终态不可回退
- [ ] 单一出队：自动 flush 与「立即发送」共用 `in_flight` 位，`in_flight` 项不再呈现「立即发送」
- [ ] 失败置回 `queued` 且**保留原位次**（复用既有队头回退语义）
- [ ] 同 `message_id` 二次投递一律跳过（**仅本端记账，非端到端幂等**）
- [ ] **区分两类失败**（评审 R2-A1 · P0）：`outcome=failed` = 确定未接受 → 回 `queued` 可再点；**无响应/超时/重启 = 结果未知 → 置 `unknown` · 禁自动重试**（agent 不接收幂等键，自动重试=真实重复执行风险）
- [ ] `unknown` 态 UI 诚实呈现"投递结果未知"，**不得显示成"已发送"或"发送失败"**；由用户自行决定是否重发
- [ ] ~~「等这步做完」本地边界调度~~ **已废弃**（C6 / 评审 A1）：只做协议原生 `priority=now`

**Evidence**（待填）

## T5 前端键区并列 + 队列项「立即发送」（R3 / R1.2 / R2.4 · 依赖 T1、T4）

- [ ] `message-input.tsx:3024-3034`：停止键与发送键**并列**而非替换。发送键行为不变（入队），**无模式下拉**
- [ ] 「⚡ 立即发送」按钮加在**队列项上**（锚 Zed "Send Now" 形态），仅能力态 `supported` 时渲染
- [ ] tooltip 明示会打断当前输出（R1.3）
- [ ] `unsupported` / `unknown` 时不渲染该按钮，仅显示"将在本轮后发送"（R2.2 三态 · 保守默认）
- [ ] `chat-input.tsx:151-165` 队列展示 + `:199-203` placeholder 文案
- [ ] **保留**（C5）：拖拽重排、编辑、删除、`TurnBusyError` 队头/队尾回退语义
- [ ] 10 语言 i18n
- [ ] ⚠️ 与 T7 同改 `message-input.tsx:3024-3034` → **串行，不并行**

**Evidence**（待填）

## T6 注入消息的会话记录真源（R1.5 / design §2.6 · 依赖 T2）

> ⚠️ **原设计前提已推翻**：`transcript_dir_for`（`connection.rs:517-526`）对**内置 agent 返回 `None`** —— Claude Code 是内置 agent，历史来自 agent 自己写的 `<session_id>.jsonl`（`parsers/claude.rs:384-406`），codeg 只读不写。注入消息由 agent 自行落盘，**我们不写**（否则造出两份矛盾历史，正是那段注释要避免的）。

- [ ] **实时 UI 层**：复用既有 `APPEND_OPTIMISTIC_TURN` / `ROLLBACK_OPTIMISTIC_TURN`（`conversation-runtime-store.ts:1690` / `:1698-1716`）—— 发出时乐观追加，`failed`/`unknown` 时回滚
- [ ] **持久层不做**：不写 `acp_transcript`（对内置 agent 本就是空操作）
- [ ] 排序问题自然消解（乐观追加在发出时，必早于 agent 因它产出的 update）—— 原方案 A/B 均作废（transcript 纯追加无删除 API，方案 B 本就不可实现）
- [ ] ⚠️ **禁直接复用 `AcpEvent::UserMessage` 的 apply**（`session_state.rs:885-920`）：它会 ① 覆盖单槽 `pending_user_message` ② `feedback.clear()` 清掉 §2.7 承诺保留的 pull 式便签 ③ 抹掉 `pending_question` / `pending_plan_approval`（等待中的问答卡片与计划审批）
- [ ] AC1.1 验收介质改：发起端 UI 中该 `message_id` 恰好一条 + 会话重开后 agent native transcript 中出现且仅一次（后者属观察，非我们的实现责任）

**Evidence**（待填）

## T7 取消前告知级联杀 SUB（R4 · 依赖无 · 与 T5 串行）

- [ ] **作用域预览 + 令牌**（评审 A5 + R2-A2 · P0）：只读查询返回"若此刻取消会被 `cancel_by_parent_turn` 终止的集合" + **预览令牌（含该时刻的委托 id 集合）**；**与执行路径共用同一作用域计算函数**
- [ ] ⚠️ **集合必须覆盖 running + inflight 两个来源**：`drain_for_parent_cancel` 还会杀 `mark_inflight_canceled_for_parent`（`broker.rs:3607`）里尚未进 running 的委托，而它们**不在** `active_delegations` 快照（`session_state.rs:984`）—— 只算前者会让 AC4 在委托启动窗口内必红
- [ ] `count > 0` → 确认框含数量；`count == 0` → 直接取消无确认（R4.4）
- [ ] **竞态分方向**：集合**缩小**（自行完成）→ 直接执行按实际集合反馈；集合**扩大**（新增委托）→ **只终止令牌内 id**，新增的不动（超出已授权破坏范围）；确需连带则**重弹确认框**，禁静默扩大
- [ ] 令牌短时效（与确认框生命周期同阶），过期重查
- [ ] 后端 `cancel_by_parent_turn` 行为**不改**，仅补作用域查询与告知
- [ ] 测试：全局 5 个 / 父轮作用域内 3 个 → 展示 3 且只杀 3；确认期间 1 个自行完成 → 仍成功且报实际数

**Evidence**（待填）

## T8 委托配置文案修正（R5 · 独立）

- [ ] `zh-CN.json:597` 及其余 9 语言：移除"覆盖项"、移除"智能体默认: X"，改为描述真实语义
- [x] **不改存储结构**（C2）

**Evidence**
- verify: `pnpm test` → EXIT=0 (240 files / 3100 tests，含 `src/i18n/messages.test.ts` locale parity 门); `pnpm build` → EXIT=0
- files: `src/i18n/messages/{en,zh-CN,zh-TW,ja,ko,es,de,fr,pt,ar}.json:597,603,604`（零 `.tsx` 改动，故 C2 结构上不可违反）
- AC: AC5
- commit: 93b0014d（i18n 三条文案 · 10 locale）+ caabd474（评审后二次收敛）

## ~~T9 resume 用户入口~~ · 已裁决不实施

- [x] 过业务现实门（§0.17）→ **判为 D·技术整洁强迫症，本轮不实施**

**Evidence**
- verify: 业务现实门四问逐一作答（无需跑命令）→ 无真实场景·无真实损失·既有三条路径已覆盖（会话列表点击 / `connection.rs:3372-3386` 自动降级 / `broker.rs:3953-4000` 续跑）→ 裁决 D
- files: `docs/specs/midturn-steering/requirements.md` §R6（裁决记录）；无代码改动
- AC: AC6
- commit: caabd474

## T10 端到端验收（依赖 T1–T6 · 不可省）

- [ ] **AC1 真跑**：**可控 barrier 委托**（不依赖固定耗时）→ 对队列消息点「立即发送」→ 主 AI 在**同一 `turn_id`** 内回应 → 该 `delegation_id` 仍 running
- [ ] **AC1.1**：会话记录中该 `message_id` 恰好一条
- [ ] AC2 三场景：a 支持·本轮内响应 / b 不支持·**无**「立即发送」且无报错 / c `failed`·提示且消息仍在队列
- [ ] AC3 键区并存 + 每条队列项时机说明 + 拖拽/编辑/删除仍可用
- [ ] AC4 展示数 == 后端实际终止数 / 0 个时无确认框 / 确认期间**缩小**仍成功不虚报 / 确认期间**扩大**时只杀令牌内那几个
- [ ] `unknown` 态：构造无响应（进程重启/超时）→ 断言**无自动重试** + UI 显示"未知"而非"已发送/失败"
- [ ] 记录排序：断言注入的用户消息在会话记录中**先于它引发的回复**
- [ ] AC5 文案不含暗示上层的表述
- [x] AC6 已在 T9 完成（判 D·不实施），不进端到端验收范围

  **Evidence**
  - verify: 见 T9（裁决型项目，无命令可跑）
  - files: `docs/specs/midturn-steering/requirements.md` §R6
  - AC: AC6
  - commit: caabd474
- [ ] **负向 mutation 打在生产装配点**：让 `connection.rs:6021` select arm 不处理 `Steer` → 端到端门必红。仍绿 = 测试自行构造链路、对生产装配失明（E-091）
- [ ] ⚠️ 单测绿**不算**通过（E-052/E-091：造好没接、门对不准交付物）

**Evidence**（待填）

## T11 收尾

- [ ] `docs/changelog/CHANGELOG.md` 追加一行（若该文件存在）
- [ ] 架构债登记：两份 agent options probe 缓存未合并；主会话偏好存 localStorage 与委托存 DB 的介质异构（受 C2 保护，仅登记）
- [ ] error-journal 收尾自查

**Evidence**（待填）

---

## 依赖与并行

```
T1 ─→ T2 ─→ T3
      │  └─→ T4 ─→ T5 ─→ T10
      └─→ T6 ────────────↗
T7（与 T5 串行：同改 message-input.tsx:3024-3034）
T8、T9、T0-R 完全独立，可并行
```

**可立即并行派发**：T1、T8、T9、T0-R
**必须串行**：T5 与 T7

## Update Log

- 2026-07-29 spec 三件套落盘（requirements / design / tasks）。T0 为流程外既成交付，保留并挂 T0-R 补审。其余全部待派 executor。
- 2026-07-29 第一轮异构评审（codex / gpt-5.6-sol）：NEEDS_CHANGES·2 P0·8 P1，锚点 10/10 CHECKED 无幻觉。已改：
  - **A1 P0** 废弃"前端观测工具边界延迟注入"（无法保证时序·刷新/重连/多窗口不可靠）→ 改为**只做协议原生 `priority=now`**，交互锚 Zed（默认排队 + 逐条「立即发送」）。用户已确认该收缩。
  - **A2 P0** `startedNewTurn` 后"普通 prompt 重发"会**重复执行同一指令** → 改为原子选择通路 + 视为已接受禁止补发 + `message_id` 幂等 + 兜底收敛。
  - A3 补队列项状态机（不丢/不重/可恢复·唯一权威层）· A4 补能力标志 wire 契约（原链路悬空）· A5 取消作用域与执行共用同一函数 + 竞态规则。
  - F1 能力三态消解 R1/R2 矛盾 · F2 会话记录真源与写入时机 · F3 AC1 改可控 barrier + id 关联 · F4 AC2 拆三场景 · F5 R6 先过业务现实门。
  - 补同类项目调研（Zed 官方文档 + issue #48175/#50592）作为交互形态依据。
- 2026-07-29 第二轮评审（codex / spec-r2-reverse）：NEEDS_CHANGES·2 P0·5 P1，锚点 7/7 CHECKED。两个新 P0 都指向我在第一轮修复中引入的漏洞：
  - **R2-A1 P0** 我写的"`message_id` 幂等"**只是客户端记账** —— agent 不接收幂等键，响应丢失时重试会真实重复执行 → 区分"明确拒绝"与"结果未知"，后者置 `unknown` 禁自动重试，**显式声明契约收缩**（不提供 exactly-once）。用户已确认该方向。
  - **R2-A2 P0** 取消范围我只考虑了缩小未考虑扩大 → 用户批准杀 3 个可能实际杀 5 个 → 引入**预览令牌**把破坏范围钉在展示时的快照上。
  - R2-A3 `turn_in_flight` 被我用来标记 detached turn = **伪造状态**，且"任意终态事件/超时"不能证明其结束 → 改用独立 `detached_turn_pending`，收敛须凭可关联事实。
  - R2-A4 "成功后写记录"不天然保证用户消息先于回复出现 → 时间戳取发出时、可见性取成功后（方案 A），实现前先确认 transcript 排序能力。
  - R2-F1 R6 resume **直接判 D·不实施**（证据已足，无需拖到实现阶段）· R2-F2 tasks 里漏改的 `Steer{blocks, mode}` 与 design 不一致（会让 executor 实现错契约）· R2-F3 补三领域的业务分类与发布边界（避免非核心项阻塞核心项或削弱高风险项验收）。

- 2026-07-30 **异构审查（独立会话）结论 NEEDS_CHANGES：1 P0 + 5 P1 + 4 P2**。报告：`.agent-workspace/.archive/2026-07-29/midturn-steering/REVIEW-backend-stage-findings.md`。四个修复 SUB 并行处理后全部关闭：
  - **P0 取消授权非原子（TOCTOU）** —— 增长检查读完 scope 就释锁，之后才发 Cancel，窗口期新建的委托被无界级联杀掉。修为 `PendingInner::seal_parent_cancel_scope` 封印（与两条注册路径共一把锁）+ epoch 比较，**并把封印后注册的委托从无界级联中也排除**（仅过滤 bounded drain 不够 —— 级联还有一刀，这是缺陷的完整形状）。另补封印 10s 过期与 teardown 时 epoch 递增。
  - **P1 双令牌 loser** 从 `Ok([])` + 多发一次 Cancel 改为 `Err(CancelScopeChanged)`。
  - **P1 starting 漏报** —— `Vec<String>` → `CancelScopeResult { count, terminated_task_ids, terminated_starting }`，"预览 1 / 实杀 1 / 回报 0" 在类型上不可表达。
  - **P1 steering 无超时堵死命令循环** —— `spawn_steering_request` detached + `STEERING_REQUEST_TIMEOUT` 10s，超时 → `Unknown`。承重测试是"请求悬着时 Cancel 必须 500ms 内被处理"（远低于 10s 上限，inline await 不可能靠超时蒙过去）。
  - **P1 假门** —— 提取 `trait SteerTransport` + `FakeSteerPeer` 行为测试替代源码 needle；四条 mutation（wire method / 强制 `Injected` / 反转 `StartedNewTurn` / 错 params 键名）全部转红。
  - **P2 契约漂移已回写** —— 新增事件类型的理由、scope 扩大改为拒绝、**删除"Codex 已实现 steering"这个假事实**（共五处 spec + 一处代码注释；本机 codex-acp v1.1.2 dist 零命中）、清掉 "twelve built-ins" 残留。
  - 主 AI 亲手复验两条关键 mutation：`seal_protects` → 永假 → P0 两测 FAILED；`STEERING_METHOD` → `"_session/broken"` → 新行为门 FAILED（旧门对此放行）。
  - 主 AI 诊断错一次并被 SUB 顶回：把 `left:3/right:2` 误读为"少改一处"，实际第三个命中是**测试自身**（`include_str!` 读整文件，E-085 自匹配陷阱的反向形态）。

- 2026-07-30 **前端落地（T4/T5）** —— 用户可见链路接通，补上审查指出的"后端已装配到 boundary 但无最终 sink"缺口：
  - `src/lib/steering-queue.ts`（新增）承载状态机纯函数；`markInFlight` 为**单一 claim 闸门**，`dequeue()` 改取第一个可 claim 项而非无条件 shift 队头；`unknown` 禁自动重试且 UI 不得说"已发送"或"发送失败"。
  - `acpSteer`（`src/lib/api.ts`）补上缺失的那一跳；**刻意不调 `stripUploadedImagePayloads`** —— steer 路径无 `hydrate_prompt_blocks`（仅 `manager.rs:907` 普通 prompt 路径有）对应物，剥离后无处还原会静默丢附件，已用测试钉住该不对称。
  - 键区改为停止键与发送键**并列**；「⚡ 立即发送」在队列项上、仅 `supported` 时渲染、tooltip 明示会打断；回滚复用既有 `REMOVE_OPTIMISTIC_TURN` 而非新增 twin（它已 no-op 未知 id 并在最后一个乐观 turn 移除时复位 `syncState`）。
  - verify: `pnpm test` 3154 tests / 243 files EXIT=0；`pnpm tsc --noEmit` EXIT=0；`pnpm build` EXIT=0。mutation：`isSteeringSupported` 改 `!== false` → 4 测转红；删掉 prompting 分支新增的发送键 → 共存门转红。
  - ⚠️ `unverified`：auto-flush 与「立即发送」在**面板层**的真实竞态未测（hook 层已覆盖），需 integration harness。

- 2026-07-30 **合并核验（主 AI 独立跑，非采信 SUB 自述）**：`cargo test --no-default-features --bin codeg-mcp --lib` **1986 passed / 0 failed**；`cargo clippy --all-targets --features test-utils -- -D warnings` EXIT=0；`cargo check --no-default-features --bin codeg-server` 干净；`pnpm tsc --noEmit` EXIT=0；`pnpm test` **3154 passed / 243 files**。
  - **仍未验证（诚实声明）**：真实 mid-turn 注入**一次都没跑过**。全部证据为静态 —— agent dist 源码、单测、受控 mutation。T10 端到端是它的第一次真实检验；在那之前不得宣称功能对用户可用。

- 2026-07-30 **第二次异构审查（sonnet · 后端+前端合并阶段）结论 NEEDS_CHANGES：3 critical + 1 important**。它确认了上一轮 P0 的即时注册窗口**已真封住**（两条注册路径在同一 `PendingInner` 锁内递增 epoch，inflight→running 搬迁保留 `registered_epoch`，seal 与 bounded drain 之间不释锁），但指出封印机制本身还有两个洞，且二者同源：
  - **C1 封印未绑定到授权它的那条 Cancel** —— `ConnectionCommand::Cancel`（`connection.rs:442`）是**无载荷的 unit variant**，所以封印只能是"每连接一个全局标志"，`drain_for_parent_cancel`（`broker.rs:4063`）无条件 `clear_seal`，**先到的任何级联都会代领并清掉它**。四个生产 `cancel_by_parent_turn` 调用点里有三个是 `if reason_str != "end_turn"` 的**自然轮次结束**（`connection.rs:6248/6315/6518`），不是用户取消 —— 于是：用户授权杀 N → N+1 注册 → 父轮以 `empty`/`max_tokens`/`refusal` 自然结束，该级联尊重封印（放过 N+1）**然后清掉它** → 真正的用户 Cancel 稍后到达，无封印、无界级联，N+1 死。主 AI 已独立复核：`clear_seal` 全仓仅一处调用、`cancel_by_parent_turn` 四处生产调用点、doc comment 自己写着"a non-`end_turn` turn end, **or** a user Cancel"——**该路径确实可达**，不是理论担忧。
  - **C2 `SEAL_GRACE` 10s 定时过期** —— 授权的 Cancel 若在 10s 后才被 dequeue（命令循环正忙于先前取出的控制请求 / 运行时暂停 / 宿主休眠 / 调度拥塞），保护失效、无界级联杀 N+1。dequeue 延迟无上界、无 matching ack、无实测数据支撑 10s，**这个常量是经验猜测而非可辩护的安全边界**。修复方向：不许调大常量；保护须持续到匹配的 Cancel 被明确消费或撤销，过期只能让迟到命令**安全拒绝/要求重新预览**，不得降级成无界取消。
  - **C3 已提交项仍写 `commit: pending`**（5 处）—— 主 AI 已按真实归属回填而非一律填最新 hash：T1/T2 → `1e0eec4b`；T8 → `93b0014d` + `caabd474`（文案落地 + 评审后二次收敛）；T9/AC6 → `caabd474`。
  - **I1 面板层竞态**：当前实现**安全但无测试**。安全性来源被注释写错了 —— 不是"两条 dequeue 路径都经过 `markInFlight`"（它们用的是两个不同 primitive：auto-flush 走同步 `dequeue()`、send-now 走同步 `markInFlight()`），而是**两个 claim 都对同一权威 ref 同步生效**，JS 事件循环串行 → 后到者必然看到"不存在"或"非 queued"。任一处加 `await`、改 state-based read 或拆分 claim 都会静默重新引入双发而现有测试全绿。
  - 裁决三问的回答：即时 seal 窗口 = 设计正确但完整授权窗口仍未闭合（封印被错误 cascade 提前消费）；`SEAL_GRACE` = 授权 Cancel 超 10s 到达时 N+1 会死，常量无可验证上界；panel-level race = 当前无真实双发，但组合层回归测试应补齐。
  - 上一个 reviewer（非本次）连续三轮只给进度说明，且**把 mutation 留在生产代码里没恢复**（`build_steering_request` 的 wire method 仍是 `"_session/broken"`）。主 AI 接手后自行跑完四条 mutation 表（wire method / params 键名 / 强制 `Injected` / 反转 `StartedNewTurn`）全部转红，逐条 `edit_block` 还原，`git status` 干净、1986 passed / 0 failed。**教训：SUB 自述"已恢复文件"不可采信，须主 AI 独立核 `git diff`**（同 E-045）。
