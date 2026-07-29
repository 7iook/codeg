# Requirements · 派发子智能体期间的对话权与委托配置治理

Feature: `midturn-steering`
分支 `feat/kiro-agent` · 创建 2026-07-29
决策卡：`.agent-workspace/.archive/2026-07-29/midturn-steering/midturn-steering-decision-card.md`

## 1. 背景与真实场景

用户的实际用法是**同时协同多个子智能体并行工作**。当前一旦主 AI 派发子智能体，用户就被完全挡在门外：发送键变成红色停止键，输入框虽仍可打字但消息只进队列、要等整轮结束才发出；唯一拿回对话权的办法是点停止，而那会**连带杀掉所有在跑的子智能体**且界面毫无提示。

原生 Claude Code 不是这样：用户消息在 tool-use 边界注入当前轮次，主 agent 在同一轮内就能响应。

## 2. 成功状态（§0.16 · 来源标注）

**NOT**「队列/注入代码写好了、单测绿」，**BUT**：

> 用户在主 AI 派发子智能体后，仍能向主 AI 发消息并在**本轮内**得到回应，且**不必为此杀掉任何正在跑的子智能体**。

- **负向条件**：不得通过"取消当前 turn"换取对话权。
- **来源**：用户原话「他派发了一个 SUB 之后，我就无法中断了……只能等待 SUB 返回」+「我想让主 AI 发消息给 SUB，或者让他调查其他东西」+「任务是协同很多个 sub 并行的」。

### 2.1 业务分类与发布边界（补评审 R2-F3）

三个领域不共用一套完成门 —— 否则非核心项会阻塞核心项，或反过来削弱高风险项的验收标准。

| 需求 | 分类（§0.17） | 发布边界 |
|---|---|---|
| **R1–R3** mid-turn 对话权 + 可见性 | **A 业务必需** | 核心交付。必须过端到端实测（AC1/AC1.1），不得以单测绿收尾。**三者捆绑发布**：只有 R1 而无 R3 会重演 Zed #48175（队列不可见 → 用户判定"消息丢了"）。 |
| **R4** 取消前告知级联杀 SUB | **B 稳定性防护** | 独立可发。**验收标准不因它"是小改动"而放松** —— 它是破坏性操作的授权边界，作用域算错 = 用户批准杀 3 个实际杀 5 个。 |
| **R5** 委托配置文案 | **独立 UX 项** | 独立可发，纯 i18n 零风险。**不得阻塞 R1–R3**，也不得被打包进核心项的验收门。 |
| **R6** resume 用户入口 | **D 技术整洁强迫症** | **已裁决不实施**（见下）。不进实现、不进验收。 |

**阻塞关系**：R1–R3 之间互相阻塞（同一交付）；R4、R5 与核心项**互不阻塞**，可任意顺序发布。唯一的实现层串行约束是 R3 与 R4 都改 `message-input.tsx` 键区（见 tasks 依赖图）。

## 3. 需求条目

### R1 mid-turn 注入（核心）

**交互形态锚定 Zed Agent Panel**（`zed.dev/docs/ai/agent-panel`「Queueing Messages」）：默认排队，**逐条消息**提供提前送达动作。不是"发送键带时机下拉"。理由见 §7 调研。

**R1.1** 输入框在主 AI 忙碌时保持可用，消息**默认进入队列**（保持现有行为）。这是安全默认：不打断任何进行中的动作。

**R1.2** 每条排队消息提供**「立即发送」**动作，触发后消息投递进**当前正在运行的那一轮**，主 AI 在本轮内响应。语义等同 Zed 的 "Send Now"。

**R1.3** 「立即发送」**会打断主 AI 当前正在生成的内容**（协议原生 `priority=now`，见约束 C6）。该后果必须在触发前对用户可见（提示或按钮语义明示"会打断"）。

**R1.4** 注入不得杀掉、不得中断任何正在运行的子智能体委托。

**R1.5** 注入的用户消息必须落入会话记录（与普通用户消息同等可见）。**写入责任、时机与失败表现见 design §2.6**——不得延到实现阶段再决定走广播还是落库。

**R1.6** 「立即发送」失败时（agent 不支持 / 返回 `failed` / 传输错误），消息**必须留在队列中**且状态可见，不得静默丢失、不得重复投递。

**AC1**：用**可控 barrier 委托**（子智能体阻塞在一个由测试释放的信号上，不依赖固定耗时）→ 对排队消息点「立即发送」→ 主 AI 在**同一 turn 内**响应。验收凭 `turn_id` 关联（响应所属 turn == 注入前在飞的 turn），并凭 `delegation_id` 确认该委托仍处 running。禁用"耗时 ≥60s"这类时间假设作为判据。

**AC1.1**：注入的消息在会话记录中出现且仅出现一次（凭 `message_id` 去重校验）。

### R2 能力探测与降级

**R2.1** 系统必须在连接建立时探测目标 agent 是否支持 mid-turn 注入，探测结果按连接持有。**能力标志到前端的 wire 契约、刷新时机与默认未知态见 design §2.1 / §7**。

**R2.2** 能力三态，「立即发送」动作的可用性据此决定（消解 R1 与 R2 的表面矛盾——R1.2 的"投递进当前轮"以本条为前置）：

| 状态 | 含义 | 「立即发送」 |
|---|---|---|
| **supported** | agent 报 `_meta.steering.supported` | 可用 |
| **unsupported** | 明确未报 | **不呈现**该动作，消息按队列轮末发出 |
| **unknown** | 尚未 initialize / 探测未完成 | 默认按 unsupported 处理（保守），探测落定后再启用 |

**R2.3** 不支持时必须优雅降级到现有行为（入队、轮末发出），**不得报错、不得静默丢消息**。

**R2.4** 用户必须能看出当前会话属于哪种模式。理由：两者对"我这条消息什么时候被处理"的预期完全不同，误判会导致重复发送或长时间干等（Zed issue #48175 的实证：队列不可见导致用户以为消息丢失）。

**R2.5** 支持 steering 但当前阶段拒绝插入时（Codex 的 review/compact 轮返回 `failed`），必须提示"当前阶段不可插入"且消息留在队列，不得静默丢弃。

**AC2**：三个场景分别验收 ——
- **a** 支持 steering：排队消息有「立即发送」，点击后本轮内响应；
- **b** 不支持：**无**「立即发送」动作，UI 明示"将在本轮后发送"，无错误提示；
- **c** 支持但返回 `failed`：提示当前阶段不可插入，消息仍在队列中且未被投递。

### R3 排队状态可见性

**这不是锦上添花，是功能成立的前提。** 实证：Zed issue **#48175** —— 引入队列后队列**不可见**，用户以为消息丢失、以为 agent 完全无视输入；issue **#50592** —— 发送键变成 loading spinner 且无停止键，用户被完全锁死（与本项目用户当前处境同形）。

**R3.1** 主 AI 忙碌时，发送键**不得**被停止键取代，两者并存。

**R3.2** 已排队的消息必须可见，并明示其投递时机（"将在本轮后发送" / 支持 steering 时另提供「立即发送」）。

**R3.3** 保留现有能力，不得回退：排队项拖拽重排、编辑、删除；`TurnBusyError` 的队头/队尾回退语义（直接发送→队尾，自动刷新→队头）。

**AC3**：主 AI 忙碌时发送键与停止键并存；每条排队消息可见且带时机说明；拖拽重排/编辑/删除仍可用。

### R4 取消操作的破坏性告知

**R4.1** 用户点停止时，若存在会被本次取消**实际终止**的子智能体委托，必须先告知数量并需用户确认。

**R4.2** 告知的**作用域必须与后端实际终止的集合一致** —— 即 `cancel_by_parent_turn` 真正会杀的那一批（父轮作用域内的在跑委托），不是"所有在跑委托"。数量与执行集合须由**同一后端权威计算**得出，前端不得自行按快照推算（否则展示 3 个却杀了 5 个）。

**R4.3** 数量与实际终止之间存在竞态（确认框弹出期间委托可能自行完成或新增）。**竞态处理见 design §4**；最低要求：不得因数量已变而拒绝取消，也不得声称终止了实际未终止的委托。

**R4.4** 无在跑委托时不得增加多余确认步骤（避免为常见路径添噪）。

**AC4**：3 个子智能体并行时点停止 → 确认框数量 == 后端实际终止数；无委托时点停止 → 直接取消无确认框；确认框停留期间有委托自行完成 → 取消仍成功且不虚报终止数。

### R5 委托配置的语义澄清

**R5.1** "子智能体配置"面板的文案不得暗示存在被它覆盖的上层配置。它是委托作用域的**唯一来源**，不是对主会话选择的覆盖。

**R5.2** 不得合并委托配置与主会话选择的存储（见约束 C2）。

**AC5**：面板文案中不出现"覆盖项"及"智能体默认: X"这类暗示上层的表述；用户读完能明白这是"派发子智能体时用什么"。

### R6 resume 用户入口

## ❌ 已裁决：不实施（判为 D · 技术整洁强迫症）

**裁决依据（§0.17 业务现实门 · 四问逐一作答）**：

- **真实场景**：**答不出**。无任何用户提出过"我需要手动输入会话 ID 来恢复"。原始需求（"是否支持恢复指定会话 ID"）是在排查 mid-turn 阻塞时顺带产生的**技术疑问**，不是业务诉求。
- **缺失影响**：**无真实损失**。用户从不手工接触会话 ID —— 恢复会话的实际入口是点会话列表。
- **既有覆盖**：**已完全覆盖**。会话列表点击进入既有恢复链路；后端 `resume → load → new` 自动降级（`connection.rs:3372-3386`）；委托侧 `continuation_id` 续跑（`broker.rs:3953-4000`）。三条路径覆盖了"回到之前的工作"这一业务问题。
- **分类裁决**：**D**。"技术上有能力但没有 UI 入口"是技术缺口，不是业务需求；补一个手输 ID 的框只会让界面多一个几乎无人使用的控件。

**结论：本轮不实施，移出实现与验收范围。** 后端能力已完整、无需改动，故也不存在"能力缺失"风险。

**重新进入的条件**：出现具体用户场景（例如"会话列表丢失后需凭 ID 找回"或"跨设备凭 ID 接续"）时，再按 A/B/C 重新分类并单开需求。

## 4. 约束（不可协商）

**C1 注入走独立通路。** 不得放宽 `manager.rs:728-729` 的 `TurnInProgress` 硬拒，不得让第二个 prompt 并入当前轮。该拒绝的理由仍然成立；注入是另一条语义不同的通路。

**C2 委托配置隔离不变量。** 委托配置的保存**不得**调用 `acpSetConfigOption`、**不得**写 `selector-prefs-storage.ts` 的 localStorage。来源：`delegation-agent-defaults.tsx:5-18` 三条隔离承诺。违反后果：用户在设置里为委托改模型会顺手改掉正在跑的主会话。

**C3 内置清单单一真源。** 内置 agent 清单只认 `registry.rs::builtin_acp_agents()`，wire slug 只认 `models/agent.rs::as_wire()`。任何第二份手写清单必须由 gate 派生校验（W0 已为委托 schema 建立此 gate）。

**C4 不锚规范，只锚实现。** mid-turn 注入能力来自 agent 实现而非 ACP 规范（规范侧至最新版无相关 feature），且属**未公告能力**。必须版本探测 + 降级，不得假定其存在。

**C5 不得回退既有能力。** 拖拽重排、队头/队尾回退语义、pull 式 `check_user_feedback` 兜底通路全部保留。

**C6 只做协议原生能力，不自造调度。** 注入只用 `_session/steering` 提供的 `priority=now`（打断当前生成）。**明确不做**"等当前工具调用结束再插入"——那需要前端观测工具边界，而前端事件无法保证在下一步开始前投递，且刷新/重连/多窗口下不可靠（评审 R1-A1）。

事实依据：Claude Agent SDK 定义了三档 `priority?: 'now' | 'next' | 'later'`（`sdk.d.ts:4550`），`next` 正是"等这步做完"的语义；但 `claude-agent-acp` 的 ACP 包装层把它**硬编码为 `now`**（`acp-agent.js:63` 常量、`:948` 直接赋值），请求参数无 priority 字段可透传。这也是 Zed 文档说"Steering 仅对 Zed Agent 可用，因为无法为外部 agent 检测 turn 边界"的同一根因。

将来若需 `next`，正确路径是**向上游提 PR 让 `_session/steering` 接受 priority 透传**，不在本端猜边界。本轮不做。

## 5. 范围外

- 改动 ACP 规范或等待 `session/inject`（PR #1261 至 2026-07-25 仍 open、无 champion）。
- 合并两份 agent options probe 缓存（仅登记架构债）。
- 把主会话偏好从 localStorage 迁到 DB（独立议题，需先确认多设备使用场景）。
- 给 `delegate_to_agent` 增加 per-call 模型/档位参数（会把模型选择权交给 LLM，需单独裁决）。
- 合并 `origin/feat/delegation-continue-sessions`（当前 HEAD 已有等价且更完整的提交）。
- 清理用户磁盘上的第三方 agent 定义（属用户侧操作，已单独处理完毕）。

## 6. 已亲验的关键事实（供 design 阶段直接使用，勿重复验证）

| 事实 | 锚点 |
|---|---|
| `_session/steering` 扩展方法已存在于本机 claude-agent-acp dist | `acp-agent.js:56/63/636/5888/913-947` |
| turn 在飞 → 直接 push 进同一 streaming input，`{outcome:"injected"}` | `acp-agent.js:913-947` |
| 能力标志在 initialize 响应**顶层** `_meta.steering.supported`，是 `agentCapabilities` 的兄弟 | `acp-agent.js:636` |
| `startedNewTurn` 竞态下 client 拿不到该 turn 终态 | 上游 issue #903，修复 PR #919 未合并 |
| codex-acp 用**同名方法**，outcome 多 `failed` | `codex-acp/src/AcpExtensions.ts` |
| 项目已有同形状 mid-turn ext request 在生产跑 | `connection.rs:4503` `send_goal_control` + `ConnectionCommand::GoalControl` + `:6021` select 分支 |
| 队列 flush 门控要求整轮结束 | `conversation-detail-panel.tsx:745` |
| 后端串行硬拒第二个 prompt | `manager.rs:728-729` |
| turn 内命令集无 Prompt arm | `connection.rs:5949-6129` |
| 取消非 end_turn 时级联杀委托 | `connection.rs:5929-5933` `cancel_by_parent_turn` |
| 在跑委托快照可读（TurnComplete 故意不清） | `session_state.rs:868-874` |
| Enter 在 isPrompting 时走入队 | `message-input.tsx:2641` |
| 发送键被 Square 替换 | `message-input.tsx:3024-3034` |
| 派 SUB 后 turn 被上游 held open | `background_watch.rs:1755`（claude-agent-acp 0.63.0） |
| pull 式 feedback 通路存在但默认关闭 | `manager.rs:1972` `submit_feedback` + `commands/feedback.rs:29` |
| resume 能力完整，降级链 resume→load→new | `connection.rs:2367/2393/3372-3386` |
| 委托续跑带 continuation_id 幂等台账 | `broker.rs:3953-4000` |

## 7. 同类项目调研（交互形态依据）

### Zed Agent Panel —— 本 spec 的交互原型

来源 `zed.dev/docs/ai/agent-panel`「Queueing Messages」，原文要点：

- 生成中发出的消息**默认排队**，排队消息在 agent 结束生成后发出。
- 想让某条消息**更早**送达（"interrupting it at its next step (usually between a tool call and a response)"），对**那条消息**打开 "Steer" 开关。
- 排队消息可编辑、可单条或全部删除。
- 仍可立刻打断：点停止键，**或对某条排队消息点 "Send Now"（双击 Enter）**。
- 明确限制：**"Steering is only available for the Zed Agent, since Zed can't detect turn boundaries for external agents."**

**可迁移结论**：形态是"一个输入框 + 每条消息上的动作"，不是"发送键带时机下拉"。默认排队、显式提速，误触代价低。我们的「立即发送」= Zed 的 "Send Now"（`now` 语义）；Zed 的 "Steer" 开关 = SDK 的 `next`，外部 agent 拿不到（同 C6 根因）。

### 反面证据（对风险评估最有价值）

- **Zed issue #48175**「Agent Panel: Uncontrollable Agent - Ignores Messages During Execution (Regression)」：引入队列后**队列不可见**，用户报告"消息丢失、agent 完全无视输入、连 stop 指令也不响应、只有 Stop 按钮能打断、轮末也不处理排队消息"。且相比更早的行为（消息作为纠正被吸收、不重启 agent）是退步。
  → **直接支撑 R3**：队列可见性不是体验优化，缺了它整个功能会被用户判定为"坏了"。
- **Zed issue #50592**「No way to stop or interrupt the agent while it is generating a response」：发送键被 loading spinner 取代且无停止键，"user is locked out until the agent finishes its turn completely"。
  → **与本项目用户当前处境同形**，支撑 R3.1（两键并存）。
- **Cursor 对比**（#48175 描述）：发消息会**完全打断并重启** agent 的思考；Zed 早期是"纠正而不丢进度"。
  → 说明「打断」的代价在业界是被认真对待的差异点，支撑 R1.3（打断后果必须对用户可见）。

### 未做的调研（诚实声明）

本节仅覆盖 Zed 官方文档 + 两个 issue 的一手材料。Cline / Roo Code / Continue / OpenHands / Goose 的具体实现未逐一核实；Cursor 的行为来自 Zed issue 中第三方描述，非 Cursor 官方文档。这些不影响本 spec 的交互决策（Zed 是唯一同为 ACP 客户端的直接可比对象），但若后续要做 `next` 语义或多 agent 差异化，需补充调研。
