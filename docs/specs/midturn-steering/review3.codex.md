> **[主 AI 下一步]** 读完本 review 修完 spec 后:若本轮已收敛(R3 或 APPROVED / p0=0)→ **调 `post-review-introspection` skill** 做「初稿→评审→最终稿」三阶段复盘,落 `introspection-<slug>.md`。仍需 R+1 → 修完 spec 再跑下轮。

---

# 第 3 轮评审结论

## 真实业务边界清单

1. **主会话 mid-turn 对话权**  
   用户在主 AI 派发多个 SUB、主轮仍处于执行状态时，需要补充指令；该消息应进入同一轮，并且不取消 SUB。

2. **不支持 steering 的 agent 降级**  
   不同 agent 能力不一致时，消息不能丢失，应明确回到既有轮末队列行为。

3. **传输结果未知的写操作风险**  
   steering 消息可能触发文件修改、外部 API 写入或再次派发 SUB；响应丢失时不能自动重试，否则存在重复执行。

4. **停止操作的破坏性授权边界**  
   用户确认的应是当时明确展示的委托集合，而不是确认期间新产生的委托。

5. **多租户、多账户、多窗口安全边界**  
   当前文档未明确 `conn_id`、session、parent turn、delegation id 和预览令牌之间的租户、账户、权限归属；这是生产上线前的阻断项。

6. **服务重启、断线、刷新恢复**  
   文档声明队列项携带持久化 `message_id`，但未定义队列内容、`in_flight`、`unknown` 和 `detached_turn_pending` 在刷新、重连、进程重启后的恢复方式。

7. **R5 配置文案**  
   目前只有技术性文案修正，尚未证明错误文案会导致哪类真实误操作或业务损失。

## 业务现实判决表（反 Solution-Jumping）

| 新建能力/字段 | 真实场景 | 缺失影响 | 是否已有机制覆盖 | 分类与结论 |
|---|---|---|---|---|
| `ConnectionCommand::Steer` / `_session/steering` 通路 | 主 AI 派发 SUB 后，用户需要在当前轮补充约束或纠偏 | 只能等待整轮结束，无法及时纠正主 AI | 现有普通 prompt 受 `TurnInProgress` 阻断，未覆盖 | **A 业务刚需；本期必须实现** |
| `agent_supports_steering` / `supportsSteering` | 不同 agent 对私有 steering 扩展支持不同 | 不支持时若仍展示立即发送，会造成失败或误操作 | 现有能力快照可复用，但 steering 字段尚未接线 | **B 稳定性保护；本期必须实现** |
| 队列项 `message_id` | 用户快速点击、自动 flush 与手动立即发送同时发生 | 同一条消息可能本地重复出队或重复记录 | 现有队列没有文档化的消息身份约束 | **B 稳定性保护；本期必须实现** |
| `unknown` 投递状态 | 连接中断或进程重启时，agent 可能已接受消息但客户端未收到响应 | 自动重试可能重复执行写操作 | 客户端标识不能让 agent 端去重 | **B 稳定性保护；本期必须实现，但必须统一队列语义** |
| `detached_turn_pending` | idle 竞态下 agent 已启动客户端无法观测终态的 turn | 错误标记普通 `turn_in_flight` 会污染 flush、取消和 UI 状态 | 当前 turn 状态机无可靠 detached turn 生命周期 | **B 稳定性保护；本期必须明确是否暴露该路径** |
| 取消作用域查询与预览令牌 | 用户点击停止前需要知道会杀掉哪些 SUB | 可能把未获授权的新委托一并终止 | `cancel_by_parent_turn` 有执行逻辑，但没有授权预览契约 | **B 稳定性保护；本期必须实现** |
| R5 配置文案调整 | 具体用户在设置委托模型时理解配置作用域 | 文档未证明会造成真实误配置或业务损失 | 可通过现有配置隔离和界面结构降低风险 | 当前只能判为**未证明的 UX 改进**；补真实场景，否则“不建议阻塞核心发布” |
| R6 resume 手动入口 | 文档未给出真实用户操作 | 未证明存在任何用户损失 | requirements 已说明会话列表和既有 resume 链路覆盖 | **D 技术洁癖；不建议实现** |

## 当前方案继续实施的风险

### A1 · P0 · 缺少生产级授权与租户边界

- **定位锚点**：`design.md` → `manager.rs::steer`、`作用域预览 + 令牌`
- **问题**：方案定义了 `steer(conn_id, blocks, message_id)`、委托集合预览令牌和按 id 取消，但没有规定后端必须校验调用者对 `conn_id`、session、parent turn 和 delegation 的所有权。
- **问题根因**：把连接标识和委托 id 当成足够的作用域，没有把租户、账户、权限绑定纳入契约。
- **业务影响**：多租户或多账户部署中可能跨会话注入消息，或取消其他用户的 SUB。
- **架构影响**：破坏性操作和消息写入缺少服务端权威授权边界；前端隐藏按钮不能替代鉴权。
- **修改建议**：在 requirements/design 中明确：服务端按 authenticated principal → tenant → account → connection/session → parent turn 校验；预览令牌绑定租户、账户、连接、父轮、目标 delegation 集合、过期时间，并执行一次性消费和权限复核。无法由现有认证中间件保证的部分标为“需实现方核实”。
- **优先级**：**P0**

### A2 · P1 · 取消预览令牌缺少原子提交与生命周期契约

- **定位锚点**：`design.md` → `取消执行以预览令牌携带的 id 集合为界`
- **问题**：文档要求短时效令牌，但未定义令牌是否一次性、执行时如何原子校验目标仍属于当前 parent turn、并发停止请求如何处理、已完成或已重建的 delegation id 如何返回。
- **问题根因**：解决了“集合扩大”问题，却未完整定义 prepare/commit 的状态和并发语义。
- **业务影响**：重复点击可能重复取消；旧令牌、重连后的令牌或已复用 id 可能产生错误反馈。
- **架构影响**：预览结果与破坏性提交仍可能不是同一事务边界。
- **修改建议**：明确 `preview → confirm/commit` 的原子协议：令牌一次性消费、绑定作用域和版本；提交返回 `terminated / already_completed / unauthorized / expired` 的稳定结果；并发提交必须幂等。
- **优先级**：**P1**

### A3 · P1 · `unknown` 状态与 R1.6 的队列契约矛盾

- **定位锚点**：`requirements.md` → `R1.6`；`design.md` → `### 2.5.1 队列项状态机`
- **问题**：R1.6 要求传输错误时消息“必须留在队列中”，但设计将无响应消息迁移到 `unknown`，且 T4 初始状态枚举只列 `queued | in_flight | delivered`，后文才追加 `unknown`。
- **问题根因**：没有统一“队列中”的定义：`unknown` 是队列项的可见状态，还是脱离队列的投递记录。
- **业务影响**：实现方可能在未知结果时删除消息，违反不丢要求；或把 unknown 自动重新纳入 flush，造成重复执行。
- **架构影响**：需求、状态机、UI 和恢复逻辑存在多个真源。
- **修改建议**：统一状态机和需求契约，明确 `unknown` 是否仍属于持久化队列；规定它不得自动 flush、不得自动重试、只能由用户显式确认重发或放弃，并补充刷新/重启后的行为。
- **优先级**：**P1**

### A4 · P1 · 测试策略重新引入已禁止的 `turn_in_flight` 伪状态

- **定位锚点**：`design.md` → `## 8. 测试策略` 中的 `startedNewTurn` 测试项
- **问题**：§2.4 和 T3 明确要求不得伪造 `turn_in_flight`，但测试要求“`turn_in_flight` 被置 true、兜底条件能收敛回 idle”。
- **问题根因**：修复设计后未同步测试断言，残留上一轮错误状态模型。
- **业务影响**：实现方可能为了通过测试重新污染真实 turn 状态。
- **架构影响**：测试成为错误契约的第二真源，直接否定本轮对 `startedNewTurn` 的修正。
- **修改建议**：改测 `detached_turn_pending` 的设置、弱提示、可关联事实收敛和“不补发”；不得断言 `turn_in_flight` 被置 true，也不得以任意终态或超时作为收敛依据。
- **优先级**：**P1**

### A5 · P1 · 刷新、重连、进程重启后的队列恢复未闭合

- **定位锚点**：`design.md` → `消息身份：message_id（客户端生成，随队列项持久化）`
- **问题**：只声明 `message_id` 持久化，没有说明存储介质、跨窗口是否共享、恢复时如何处理 `in_flight`、`unknown`、`delivered` 和 `detached_turn_pending`。
- **问题根因**：把“字段持久化”当成“投递状态可恢复”。
- **业务影响**：刷新后消息可能消失、自动重复发送，或永久显示未知；多窗口可能各自对同一消息执行立即发送。
- **架构影响**：前端单一 store 在多窗口/重启场景下不再是单一权威。
- **修改建议**：本期必须明确支持范围：若不支持跨窗口/重启恢复，则显式降级并禁止宣称可恢复；若支持，则定义共享持久化、单写者/租约、恢复扫描和未知态人工处理。不要仅凭客户端 `message_id` 宣称幂等。
- **优先级**：**P1**

### A6 · P1 · 方案总览与 R4 详细设计互相矛盾

- **定位锚点**：`design.md` → `R4 破坏性告知 前端读 active_delegations 快照 → 取消确认框`
- **问题**：总览仍写前端直接读取 `active_delegations` 快照，§4 又明确要求后端权威作用域查询和预览令牌。
- **问题根因**：上一轮修订只更新了详细章节，未同步总览链路。
- **业务影响**：executor 可能按总览实现错误的数据来源，重新出现展示数量与实际终止集合不一致。
- **架构影响**：文档存在两个取消作用域真源。
- **修改建议**：将总览链路改为“前端请求后端作用域预览 → 确认后提交带令牌取消”，并与 §7 链路表一致。
- **优先级**：**P1**

### A7 · P1 · R5 仍缺少真实业务论证

- **定位锚点**：`requirements.md` → `### R5 委托配置的语义澄清`
- **问题**：只定义了禁用词和文案目标，没有回答具体角色、具体操作、错误理解会造成什么实际损失，也未说明现有界面或隔离机制是否已经覆盖。
- **问题根因**：把文案清理直接视为需求，没有经过业务现实门。
- **业务影响**：当前无法判断该改动是防止真实误配置，还是纯技术/UX 偏好。
- **架构影响**：若纳入核心验收，会扩大发布面并增加无业务价值的阻塞。
- **修改建议**：补至少一个真实误操作场景及损失；若无法证明，保留为独立低风险 UX 任务，不得阻塞 R1–R3。
- **优先级**：**P1**

## 推荐的更优实现方向

1. **先收紧安全边界，再实现 steering**  
   所有 steer、预览和取消提交都由后端按租户/账户/session/parent-turn 鉴权；前端能力态只负责展示。

2. **统一投递状态契约**  
   明确 `queued → in_flight → delivered` 与 `unknown` 的关系。未知结果必须持久可见、禁止自动重试或自动 flush；用户显式重发时给出重复执行风险提示。

3. **谨慎处理 `startedNewTurn`**  
   保持独立 `detached_turn_pending`。若无法获得可关联 turn 证据，建议暂不对 idle 竞态开放“立即发送”，而不是依靠弱状态长期漂移。

4. **取消采用后端 prepare/commit**  
   预览令牌固定授权集合，短时效、一次性、绑定调用者和 parent turn；提交按令牌集合执行并返回实际结果。

5. **先定义恢复边界**  
   在本期明确是否支持刷新、重连、服务重启和多窗口。若不支持，需求应写成“会话生命周期内保证”，不要在 tasks 中暗示持久可恢复。

6. **按发布层级拆分**  
   - 本期必须：R1–R3、能力探测、未知态、端到端验证、安全授权。  
   - 可延后：R4（若无法在本期完成令牌原子性）、R5。  
   - 不建议：R6；任何没有真实业务场景支撑的新入口或新抽象。

## 开工前代码核验清单（可直接给实现方跑）

- `ConnectionCommand::Steer` 是否只能由已认证且拥有目标 tenant/account/session 的调用方构造？
- `manager.rs::steer` 是否校验连接、session、parent turn 与当前用户身份的一致性？
- `supportsSteering` 是否在 Tauri、HTTP snapshot、WS snapshot 三条链路中都存在且字段语义一致？
- `_meta.steering.supported` 缺失、`null`、非布尔值时是否稳定落为 `unknown/unsupported`，而不是误判 supported？
- 当前领域模型中 queue item 的持久化位置、唯一键和状态迁移约束是什么？
- `message_id` 是否跨刷新、多窗口、重连保持唯一？是否存在客户端时钟或随机源冲突？
- `unknown` 在刷新、断线恢复、进程重启后是否仍可见，并且不会被自动 flush？
- 自动 flush 与立即发送是否通过同一原子 claim/lease 防止双重出队？
- `startedNewTurn` 是否有可关联的 turn 标识、session/update 证据或状态查询？
- 若没有可靠关联证据，是否禁用 idle 竞态路径或保持明确弱提示而不改变 turn 状态机？
- transcript 是否按时间戳/序列号排序？是否能保证注入用户消息先于对应 agent update？
- 注入成功后是否只写一条 UserMessage/transcript，且重复回调不会重复落库？
- 传输超时、连接断开和 agent 进程重启时，消息是否进入 `unknown` 而非自动重试？
- 取消预览令牌是否绑定 tenant/account/connection/parent turn，是否一次性消费、短时效且不可跨用户重放？
- 取消提交是否只终止令牌内 delegation id，并返回已完成、未授权、过期等稳定结果？
- 父轮、delegation、continuation_id 的映射是否支持多店铺、多账户、多平台场景，是否存在跨租户串联风险？
- 外部 agent 凭证过期、账户失效、错误配置时，能力探测、steer 和普通 flush 是否分别降级？
- 现有取消、幂等、失败恢复、重连恢复机制是否已覆盖本方案，避免新增第二套状态机？
- 前后端是否已经存在队列可见性、Send Now、取消预览或配置文案的类似能力？
- 历史 Git、旧实现、废弃逻辑是否已确认没有第二套 steering/取消路径？（需实现方核实）
- 生产典型队列长度、并发委托数量、steer 频率和 transcript 增长规模是多少？
- 端到端测试是否能用 barrier、delegation_id、message_id、turn_id 证明真实装配，而不是测试内自建链路？
- 是否执行了生产装配点 mutation：移除 `connection.rs:6021` Steer arm 后 AC1 必须失败？

## 必须由产品/业务/技术负责人确认的问题

1. **P0 安全确认**：steer 和取消操作的授权主体是用户、账户还是 tenant？是否允许同账户多窗口共享同一连接？
2. **未知结果策略**：用户在 `unknown` 状态点击重发前，是否必须二次确认“可能已执行，重发可能重复”？
3. **恢复范围**：本期是否承诺刷新、重连、服务重启后保留队列？多窗口是否属于支持范围？
4. **detached turn**：当前 agent 是否提供可关联的 turn 标识或状态查询？如果没有，是否接受 idle 竞态只做弱提示，或直接关闭该路径？
5. **取消授权语义**：确认框授权的是预览集合，还是“父轮当前全部委托”？若是前者，预览令牌是否必须一次性消费？
6. **R5 业务价值**：是否存在真实因“覆盖项/智能体默认”误解而修改错误配置的案例？若无，是否降为独立 UX 微改？
7. **发布顺序**：R4 是否必须与 R1–R3 同批发布，还是允许独立上线和独立回滚？

## 落地决定

**调整方案后开发**：核心 steering 方向已收敛，但安全授权、未知态契约、重启/多窗口恢复和取消令牌原子性仍未达到生产开工条件。

```yaml
patch_plan:
  - issue_id: A1
    severity: P0
    target_file: design.md
    anchor: "manager.rs::steer"
    action: append_after
    intent: 明确 steer 与取消预览/提交的服务端身份、租户、账户、session 和 parent-turn 授权边界
    rationale_short: 缺少权限绑定可能导致跨租户注入或越权取消委托
  - issue_id: A2
    severity: P1
    target_file: design.md
    anchor: "取消执行以预览令牌携带的 id 集合为界"
    action: replace_section
    intent: 定义预览令牌的一次性消费、原子提交、作用域绑定、过期和并发结果契约
    rationale_short: 仅固定 id 集合仍不足以保证生产级 prepare/commit 语义
  - issue_id: A3
    severity: P1
    target_file: requirements.md
    anchor: "消息**必须留在队列中**且状态可见"
    action: replace_section
    intent: 统一 unknown 是否属于队列、是否持久化、是否允许自动 flush 及用户重发语义
    rationale_short: R1.6 与 design 的 unknown 状态定义不一致
  - issue_id: A4
    severity: P1
    target_file: design.md
    anchor: "断言不补发"
    action: replace_section
    intent: 删除 turn_in_flight 被置 true 的残留测试断言，改测 detached_turn_pending 与可关联事实收敛
    rationale_short: 测试仍要求被设计明确禁止的伪造状态
  - issue_id: A5
    severity: P1
    target_file: design.md
    anchor: "消息身份：`message_id`（客户端生成，随队列项持久化）"
    action: append_after
    intent: 明确刷新、重连、重启、多窗口下队列状态的持久化、单写者和恢复策略
    rationale_short: 字段持久化不等于投递状态可恢复或跨窗口不重复
  - issue_id: A6
    severity: P1
    target_file: design.md
    anchor: "R4 破坏性告知 前端读 active_delegations 快照"
    action: replace_section
    intent: 将总览中的取消链路同步为后端作用域预览、令牌确认和按令牌提交
    rationale_short: 总览与详细设计存在两个互相冲突的取消作用域来源
  - issue_id: A7
    severity: P1
    target_file: requirements.md
    anchor: "### R5 委托配置的语义澄清"
    action: append_after
    intent: 补充真实误配置场景、缺失影响和现有覆盖；无法证明则降为独立 UX 项
    rationale_short: 当前 R5 只有文案目标，没有业务刚需或稳定性收益证据
```

## VERDICT
status: NEEDS_CHANGES
p0_count: 1
p1_count: 6
one_line: 核心 steering 方向基本收敛，但生产级授权、取消提交原子性、未知态契约、恢复边界和测试残留矛盾仍阻断直接开工。
