> **[主 AI 下一步]** 读完本 review 修完 spec 后:若本轮已收敛(R3 或 APPROVED / p0=0)→ **调 `post-review-introspection` skill** 做「初稿→评审→最终稿」三阶段复盘,落 `introspection-<slug>.md`。评审器只报问题 · 主 AI 才能复盘(sub 与评审器都拿不到主 AI 原始思考)。仍需 R+1 → 忽略本条 · 修完 spec 再跑下轮。

---

# 第 1 轮评审结论

## 一、架构级问题

### A1｜会话与执行轮次被错误建模为同一个 `Task_Id`

**定位锚点**：`Property 4: task_id 稳定性`

- **问题**：设计要求同一 `Task_Id` 在多次续聊中反复从 `Completed` 迁回 `Running`，并复用原 `parent_tool_use_id` 发出新的完成事件。
- **问题根因**：稳定存在的 `Child_Session` 与一次性的委托执行轮次没有分离。当前模型把“会话身份”“本轮执行”“父工具调用”压缩成一个实体。
- **业务影响**：主 AI 难以区分首次委托与第 N 次追问；历史轮次可能被覆盖，取消、关闭、状态查询容易作用到错误轮次。
- **架构影响**：终态不再终态，破坏状态单调性；还要求复活 tombstone 和复用已完成的 tool-call correlation，使已有生命周期约束持续复杂化。
- **修改建议**：引入稳定的 `DelegationSession` 聚合标识，下面持有每次唯一的 `DelegationTurn/Run`。Session 使用 `Open/Closed` 生命周期；Turn 使用 `Dispatching/Running/Completed/Failed/Canceled`。若必须兼容上游 `task_id`，应明确它到底是 session id 还是 turn id，并通过兼容映射暴露“最新轮次”，不要让同一个终态任务复活。
- **优先级**：**P0**

### A2｜声明 broker 内存状态为 SSOT，但核心生命周期需要跨缓存、重连和重启恢复

**定位锚点**：`**唯一权威**：broker 的 PendingInner 是任务状态的 SSOT。`

- **问题**：`Completed_Cache` 会被 FIFO 淘汰、父连接拆除时会被丢弃，`closed` 又只存在于私有 `CompletedTask`；同时设计还承诺依赖 DB 恢复 settled task。
- **问题根因**：没有区分运行时协调状态与持久领域状态。内存 broker 被同时当成短期状态机和会话生命周期真源。
- **业务影响**：缓存淘汰、服务重启或父连接重建后，已关闭会话可能重新变成可续聊；也可能出现同一子会话在不同入口下状态不一致。
- **架构影响**：`close_session`、任务归属、最新轮次、恢复元数据缺乏持久一致性，无法形成可靠的恢复模型。
- **修改建议**：明确持久化边界。至少持久化 session 标识、父子归属、open/closed 状态、最近轮次标识和恢复元数据；broker 只保存可重建的运行态索引。若产品明确只保证当前进程生命周期，则必须删除跨重启暗示，并把该限制写进需求和验收。
- **优先级**：**P0**

### A3｜用户入口缺少账户、租户和对象级授权模型

**定位锚点**：`### Requirement 4: 用户侧续聊入口`

- **问题**：用户 API 仅以 `child_conversation_id` 定位任务，文档没有定义调用者身份、workspace/tenant 范围、父会话访问权、关闭权限和审计要求。
- **问题根因**：设计只处理了 MCP 父连接的任务归属，没有把用户入口视为独立安全边界。
- **业务影响**：在多账户或共享部署中，可能通过可枚举的 conversation id 续聊、关闭或探测他人的子会话。
- **架构影响**：授权逻辑容易散落到 command、Web handler 和 broker，多入口产生不一致策略。
- **修改建议**：在边界层定义统一调用主体，并校验 `tenant/workspace → parent conversation → child conversation` 的完整归属链；继续、关闭、查询使用相同策略，对无权对象统一返回不泄漏存在性的结果，并纳入负向验收。
- **优先级**：**P0**

### A4｜“Idle Sweep 仍可回收”不构成可验证的资源上限

**定位锚点**：`### Requirement 5: 保活连接的资源边界`

- **问题**：设计接受每个完成子代理继续常驻最多 180 秒，却没有全局、每父会话或每用户的保活数量上限。字节缓存上限也不能限制大量短结果对应的进程数。
- **问题根因**：用延迟回收机制替代了资源配额模型。
- **业务影响**：短时间 fan-out 大量任务仍可耗尽进程、内存或文件句柄，“十个子代理后机器仍可用”没有可测试保证。
- **架构影响**：资源治理依赖偶然的结果大小和定时器，后续很难做容量规划。
- **修改建议**：增加明确且可配置的保活连接上限和淘汰策略，至少覆盖全局与单父会话；说明被淘汰后进入 Resume Path。运行中任务是否需要并发上限可由实现方结合现有配置核实。
- **优先级**：**P1**

### A5｜恢复能力被当成统一能力，但实际依赖不同代理协议

**定位锚点**：`### D3 · 不给保活连接加 idle sweep 豁免`

- **问题**：需求普遍承诺通过 `external_id` 恢复，但设计最后才说明 Kiro 可能不支持 resume；其他 agent 类型的能力差异也未建模。
- **问题根因**：将某个 ACP adapter 的恢复链当成所有代理共有的领域能力。
- **业务影响**：相同 UI 操作在不同 agent 上可能恢复、冷启动或失败，用户无法预知。
- **架构影响**：broker 被迫通过失败探测能力，容易产生静默 `session/new` 和代理特例。
- **修改建议**：在 adapter/spawner 边界暴露可查询的 continuation capability，例如活连接续聊、持久恢复、仅冷启动、不可续聊；broker 根据能力决定可续聊性，前端查询使用同一结果。
- **优先级**：**P1**

### A6｜幂等契约没有真正贯穿用户与 MCP 两个入口

**定位锚点**：`幂等键：沿用 acpPrompt 既有的 client_message_id 机制`

- **问题**：列出的用户 API 签名不包含 `client_message_id`，MCP `continue_with_session` 也只有 `task_id/message`。重试可能重复发送同一追问。
- **问题根因**：把下游现有机制视为端到端契约，但没有定义幂等键的生成、传递、存储范围和结果复用。
- **业务影响**：网络重试、用户双击、MCP 超时重试会产生重复执行和重复成本。
- **架构影响**：去重若仅发生在某个 transport，会造成 Tauri、Web、MCP 三条路径语义不同。
- **修改建议**：为每次 continuation 定义稳定 operation/turn id，所有入口都必须携带；在状态机权威层原子登记并返回第一次执行结果，明确幂等范围和保留时长。
- **优先级**：**P1**

### A7｜M1 继续推广绕过 broker 的通路，与核心目标相冲突

**定位锚点**：`**M1（方案 0 · 零后端）**`

- **问题**：M1 鼓励用户通过现有完整标签页给子代理发消息，但文档已经确认该路径绕过 broker；Requirement 4.5 又长期保留“在标签页打开”入口。
- **问题根因**：把“可发现性立即交付”与“所有续聊必须进入同一状态机”作为两个独立目标，却没有定义迁移边界。
- **业务影响**：M1 用户追问仍无法被主 AI 感知；M2 后从完整标签页发送是否进入 broker 也不明确。
- **架构影响**：形成两个长期并存的写入口，直接破坏所声明的 SSOT。
- **修改建议**：明确 M1 只能提供浏览/打开能力而不宣称实现共享续聊，或者将所有 Child Session 发送统一路由到 broker 后再开放入口；补充 M2 后 Dialog 与完整标签页的统一发送规则。
- **优先级**：**P1**

---

## 二、普通功能与契约问题

### F1｜`close_session` 对不同状态的行为没有定义

**定位锚点**：`WHEN close_session is called, THE Delegation Broker SHALL disconnect the child connection and mark the task closed.`

- **问题**：没有说明任务处于 dispatching、running、completed、failed、already closed、连接已被 sweep 时分别如何处理。
- **问题根因**：缺少 Session 与 Turn 的完整状态迁移表。
- **业务影响**：关闭可能等同取消，也可能留下运行中的 prompt；重复关闭可能返回不稳定结果。
- **架构影响**：continue、close、cancel 三种操作存在竞态，但没有确定原子胜者和最终状态。
- **修改建议**：定义完整状态表及并发裁决：关闭是否取消当前轮次、重复关闭是否幂等、close 与 continue 并发谁胜、无活连接时是否仍持久标记 closed。
- **优先级**：**P1**

### F2｜续聊失败后的回滚和资源清理不完整

**定位锚点**：`### DelegationBroker::continue_delegation(...) -> DelegationTaskReport`

- **问题**：只规定失败时把 `completed` 重新插回，没有覆盖 replacement connection 已创建但发送失败、活性检查后连接立即死亡、注册成功后取消到达等部分失败。
- **问题根因**：续聊被描述成单次状态迁移，实际是“取出状态—选择/创建连接—注册—发送—进入 running”的多阶段编排。
- **业务影响**：可能产生孤儿连接、重复 prompt、错误恢复元数据或永远停在 running 的任务。
- **架构影响**：缺少事务边界与补偿规则，难以证明异常路径守恒。
- **修改建议**：定义阶段化状态和补偿矩阵，明确每个失败点应断开新连接、恢复 completed、保留 closed、还是转入可重试失败；发送失败后不得仅依靠 `reinsert_completed`。
- **优先级**：**P1**

### F3｜D4 的“可续聊性查询”是悬空接口

**定位锚点**：`### D4 · 可续聊性要暴露到前端`

- **问题**：决策要求返回可续聊布尔值，但 Components、接口签名、需求验收和错误处理表都未定义该查询的请求、响应、刷新时机及原因信息。
- **问题根因**：设计决策没有下沉到接口契约与需求追踪。
- **业务影响**：前端可能只能在点击后才发现 closed、不可恢复或能力不支持，D4 的体验目标无法验收。
- **架构影响**：前端可能自行推断状态，再次产生平行真源。
- **修改建议**：定义 broker 派生的结构化 continuation availability，至少区分 running、continuable-live、continuable-resume、closed、not-supported/not-continuable，并规定查询入口和状态失效策略。
- **优先级**：**P1**

### F4｜验收覆盖与需求追踪不足以证明核心承诺

**定位锚点**：`## Testing Strategy`

- **问题**：五条 Property 只覆盖部分需求；测试计划没有形成 Requirement 1–6 到测试的完整映射，也缺少授权失败、重试去重、并发 continue/close、缓存淘汰后恢复、进程重启等验收。
- **问题根因**：测试策略主要围绕已知上游三个漏项，而不是围绕完整业务契约构建。
- **业务影响**：即使 broker 既有测试全绿，用户侧入口、隔离性和恢复一致性仍可能不可用。
- **架构影响**：关键状态机和跨入口一致性缺乏可回归证据。
- **修改建议**：建立逐条验收矩阵；至少加入用户入口与 MCP 并发、同幂等键重放、关闭后重连、无权 child id、cache eviction、idle sweep、恢复降级和完整标签页发送路径。
- **优先级**：**P1**

### F5｜“报告上下文丢失”没有稳定的机器可判定契约

**定位锚点**：`IF the Resume_Path degrades to session/new`

- **问题**：未说明这是成功附带 warning、失败错误码，还是发送前需用户确认；现有错误码中也没有对应类型。
- **问题根因**：把关键业务语义写成自然语言提示，而非接口结果。
- **业务影响**：主 AI 和 UI 无法稳定判断新消息是否已经发送、是否需要重试或是否应提示用户。
- **架构影响**：不同 transport 可能各自映射成不同返回形式。
- **修改建议**：定义结构化结果以及是否已经产生副作用；特别明确 `session/new` 后是否复用原 DB 行、是否更新 external id、是否仍算原 Child Session。
- **优先级**：**P2**

### F6｜用户角色和实际工作流仍偏抽象

**定位锚点**：`## Introduction`

- **问题**：只描述“codeg 用户”和“主 AI”，未说明谁可以发现、续聊、关闭子会话，以及用户追问后主 AI在何时、通过何种触发获知新结果。
- **问题根因**：成功标准停留在“主 AI 调用 status 时能看到”，没有形成端到端操作场景。
- **业务影响**：产品可能实现了可查询但实际上主 AI从不查询的能力，用户仍感知不到协作闭环。
- **架构影响**：事件通知、轮询和 UI 状态更新之间的责任边界不清。
- **修改建议**：补充少量真实场景：用户在 Dialog 续聊、主 AI主动续聊、双方并发操作，以及用户续聊完成后主 AI如何获得可见信号。
- **优先级**：**P2**

```yaml
patch_plan:
  - issue_id: A1
    severity: P0
    target_file: design.md
    anchor: "### Property 4: task_id 稳定性"
    action: replace_section
    intent: 分离稳定 DelegationSession 与单次 DelegationTurn 的身份及生命周期，明确兼容 task_id 的映射
    rationale_short: 复活同一终态任务会破坏状态单调性和轮次关联
  - issue_id: A2
    severity: P0
    target_file: design.md
    anchor: "**唯一权威**：broker 的 `PendingInner` 是任务状态的 SSOT。"
    action: replace_section
    intent: 划分持久领域状态与可重建运行态索引，并明确关闭、归属及恢复元数据的持久化边界
    rationale_short: 内存缓存会淘汰和丢失，不能承载跨重连生命周期真源
  - issue_id: A3
    severity: P0
    target_file: requirements.md
    anchor: "### Requirement 4: 用户侧续聊入口"
    action: append_after
    intent: 补充账户租户作用域、父子会话对象级授权、关闭权限及不泄漏存在性的验收
    rationale_short: child conversation id 入口缺少统一授权边界
  - issue_id: A4
    severity: P1
    target_file: requirements.md
    anchor: "### Requirement 5: 保活连接的资源边界"
    action: append_after
    intent: 定义可配置的保活连接数量上限、作用域、淘汰顺序及恢复行为
    rationale_short: idle sweep 延迟回收不能提供容量上限
  - issue_id: A5
    severity: P1
    target_file: design.md
    anchor: "### D3 · 不给保活连接加 idle sweep 豁免"
    action: append_after
    intent: 将不同 agent adapter 的续聊与持久恢复能力显式建模并接入可续聊性判定
    rationale_short: external_id 恢复不是所有代理共有能力
  - issue_id: A6
    severity: P1
    target_file: design.md
    anchor: "幂等键：沿用 `acpPrompt` 既有的 `client_message_id` 机制"
    action: replace_section
    intent: 定义用户、Web、Tauri、MCP 全链路统一的 continuation operation id 与原子去重语义
    rationale_short: 当前接口未携带所声称的幂等键
  - issue_id: A7
    severity: P1
    target_file: design.md
    anchor: "**M1（方案 0 · 零后端）**"
    action: replace_section
    intent: 消除 M1 和完整标签页绕过 broker 的写入路径，明确阶段能力边界及 M2 后统一路由
    rationale_short: 双写入口直接破坏 broker SSOT 和父 AI 可见性
  - issue_id: F1
    severity: P1
    target_file: requirements.md
    anchor: "WHEN `close_session` is called, THE Delegation Broker SHALL disconnect the child connection and mark the task closed."
    action: append_after
    intent: 补充 close 在各生命周期状态及与 continue/cancel 并发时的原子迁移和幂等规则
    rationale_short: 当前关闭语义只覆盖单一理想路径
  - issue_id: F2
    severity: P1
    target_file: design.md
    anchor: "### `DelegationBroker::continue_delegation(...) -> DelegationTaskReport`  (新建于 `broker.rs`)"
    action: append_after
    intent: 定义续聊多阶段编排各失败点的状态回滚、连接回收和补偿规则
    rationale_short: reinsert completed 无法覆盖创建连接或发送后的部分失败
  - issue_id: F3
    severity: P1
    target_file: design.md
    anchor: "### D4 · 可续聊性要暴露到前端"
    action: append_after
    intent: 落实结构化可续聊状态的查询接口、状态枚举、刷新时机及前端消费规则
    rationale_short: 决策未进入组件接口和验收契约
  - issue_id: F4
    severity: P1
    target_file: design.md
    anchor: "## Testing Strategy"
    action: append_after
    intent: 建立 Requirement 1 至 6 的验收追踪矩阵并覆盖授权、幂等、并发、淘汰、重启和多入口一致性
    rationale_short: 现有测试重点不足以证明完整业务闭环
```

## VERDICT
status: NEEDS_CHANGES
p0_count: 3
p1_count: 8
one_line: 当前方案的核心阻塞是会话与执行轮次建模混淆、持久状态真源缺失以及用户入口无对象级授权，需先修正领域边界再细化实现。
