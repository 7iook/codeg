> **[主 AI 下一步]** 读完本 review 修完 spec 后:若本轮已收敛(R3 或 APPROVED / p0=0)→ **调 `post-review-introspection` skill** 做「初稿→评审→最终稿」三阶段复盘,落 `introspection-<slug>.md`。评审器只报问题 · 主 AI 才能复盘(sub 与评审器都拿不到主 AI 原始思考)。仍需 R+1 → 忽略本条 · 修完 spec 再跑下轮。

---

# 第 2 轮评审结论

## 一、架构级问题

### B1｜把恢复失败后的冷启动包装成“成功续聊”，违背需求根目标

**定位锚点**：`| resume 降级到 session/new | broker → 用户 |`

- **问题**：`session/resume` / `session/load` 失败后，方案仍发送消息到 `session/new`，返回 `Running + context_lost: true`，并覆盖原 `Child_Session.external_id`。
- **问题根因**：为了维持同一 `task_id` 和 DB 行，把“继续原上下文”与“创建无上下文的新会话”强行视为同一操作；`context_lost` 字段是在掩盖领域语义已经改变。
- **业务影响**：消息发送后用户才得知上下文已经丢失，无法撤回；子代理可能基于缺失背景执行错误任务。旧 `external_id` 被覆盖后，原会话恢复凭据也可能丢失。
- **架构影响**：同一个 `Child_Session` 同时代表原会话与冷启动会话，身份不再可信；状态报告称“续聊成功”，实际发生的是隐式分叉。
- **修改建议**：停止自动降级并发送。恢复失败应在产生 prompt 副作用前返回结构化的 `resume_unavailable/context_lost`；若产品确实需要冷启动，应由调用方明确确认，并创建可识别的新 session incarnation 或新子会话，保留与原会话的关联及旧恢复凭据。
- **优先级**：**P0**

### B2｜复用已完成的 `parent_tool_use_id` 不能正确表达用户发起的新轮次

**定位锚点**：`WHEN a continued turn completes, THE Delegation Broker SHALL emit a completion event carrying the original parent_tool_use_id.`

- **问题**：用户或主 AI 发起的第 N 次续聊，仍作为原始父工具调用的又一次完成事件发出；文档同时把“主 AI 可主动查询”与“主 AI 知道用户追问”混为一谈。
- **问题根因**：缺少独立的 session update / turn completion 语义，只能复用旧 tool-call correlation 承载新事件。
- **业务影响**：接收方可能把重复完成事件去重、覆盖或误归属；即使事件进入前端，也不代表主 AI 会被唤醒或会再次调用 `get_delegation_status`。
- **架构影响**：工具调用的一次性完成契约被破坏，事件来源也无法区分 `User`、`ParentAgent` 和系统恢复。后续审计、排序和并发裁决都缺少可靠依据。
- **修改建议**：先明确产品契约是“主 AI 下次查询时可见”还是“用户续聊完成后主动通知主 AI”。前者不应重复发旧工具完成事件；后者应定义 session-scoped 更新事件或父会话 inbox，至少携带 `session_id`、独立 `turn_id`、origin 和结果版本。旧 `parent_tool_use_id` 只能作为初始委托关联信息。
- **优先级**：**P0**

### B3｜以上游 PR 的字段布局约束内部领域模型，是错误的架构优先级

**定位锚点**：`### D2 · 对齐上游 PR #375 契约而非自研`

- **问题**：设计已识别 Session 与 Turn 是两个概念，却因为减少上游合并冲突，拒绝建立明确聚合和轮次身份，转而让 `CompletedTask`、`RunningTask`、缓存顺序及同一 `task_id` 共同承担生命周期。
- **问题根因**：把上游实现布局当成领域边界，而不是放在兼容适配层。所谓“`RunningTask` 实例 + ACP prompt 就是 turn 身份”既不稳定，也不可查询或持久关联。
- **业务影响**：状态查询只能表达“最新结果”，无法可靠区分、追踪或审计各次续聊；幂等、关闭、取消和事件关联会继续围绕缓存对象增加条件分支。
- **架构影响**：`Completed_Cache` 从结果缓存膨胀为事实上的 session registry。容量淘汰、父连接拆除和进程重启都会影响领域行为，后续每增加一个生命周期能力都要修改缓存状态机。
- **修改建议**：保留上游 wire 兼容，但在内部引入最小的 Session/Turn 分离：`task_id` 可继续作为兼容 session id，每次 dispatch 必须有独立 turn/operation id；结果缓存只负责缓存，不负责定义 session 是否存在或关闭。通过 facade 映射回 PR #375 的报告结构，无需把内部正确模型暴露到 wire。
- **优先级**：**P0**

### B4｜`close_session` 同时表示资源释放和领域关闭，语义无法成立

**定位锚点**：`closed 标记不持久化——进程重启后一个曾被 close_session 关闭的子会话会重新变为「可续聊」。`

- **问题**：接口和 UI 将操作称为“关闭/退役”，但其效果只在当前进程有效；重启后会话自动重新开放。
- **问题根因**：资源治理操作“断开空闲 CLI 连接”与领域操作“禁止后续续聊”被压缩为同一个 `closed` 布尔值。
- **业务影响**：用户明确关闭的会话可能在重启后被再次续聊；调用方无法判断关闭是暂时释放资源还是永久结束协作。
- **架构影响**：关闭状态被放进可淘汰内存缓存，生命周期语义取决于进程存活时间。
- **修改建议**：二选一并保持命名一致：若只是回收连接，改为 release/disconnect，不阻止未来 resume；若是领域关闭，则持久化 session 状态。不要继续保留“名为 close、实为当前进程临时锁”的折中语义。
- **优先级**：**P1**

### B5｜幂等设计在三条入口和状态迁移间没有形成可实现的闭环

**定位锚点**：`**幂等键（R1-A6，全链路统一）**`

- **问题**：
  1. MCP 允许省略 `continuation_id`，listener 每次重试生成新 UUID，无法识别跨请求重试；
  2. 去重记录声称随 `CompletedTask` 生存，但 dispatch 后任务迁入 `running`；
  3. 重复请求可能先命中 `session_still_running`，而不是返回首次报告；
  4. Error Handling 又写成 command 层沿用 `client_message_id`，与统一 `continuation_id` 冲突；
  5. 用户 API 签名仍未展示该参数。
- **问题根因**：把幂等当成 transport 参数补丁，没有定义独立 operation ledger 的状态和生命周期。
- **业务影响**：MCP 超时重试、Web 重发或双击仍可能重复执行，或者相同请求得到不一致结果。
- **架构影响**：去重语义依赖任务当前位于 `completed` 还是 `running`，入口之间也存在平行真源。
- **修改建议**：所有可重试入口强制携带调用方稳定生成的 operation id；去重记录应独立覆盖 dispatching、running 和 settled，并存储首次接受结果。明确保留期限、重启边界以及相同 id 不同 payload 的冲突响应。
- **优先级**：**P1**

### B6｜父连接被错误地当作共享子会话的生命周期所有者

**定位锚点**：`WHERE a parent connection is torn down, THE Delegation Broker SHALL disconnect every Kept_Alive_Connection belonging to that parent`

- **问题**：产品把 `Child_Session` 同时暴露给用户和主 AI，并强调父会话重连后仍可定位，但资源归属仍绑定易失的 `parent_connection_id`。
- **问题根因**：沿用 one-shot 执行模型中的连接所有权，没有把持久父会话关系与当前父连接租约分开。
- **业务影响**：父连接重连或拆除会无条件打断本可由用户继续使用的活连接，增加不必要的 resume 延迟；与用户侧正在发起的 continuation 还可能形成竞态。
- **架构影响**：同一资源同时受 parent connection、parent conversation、completed cache 和 idle sweep 四套生命周期控制。
- **修改建议**：父连接拆除只能释放属于该连接的运行租约和订阅，不应决定 `Child_Session` 生命周期。保活连接应由 session/connection pool 的空闲与容量策略统一回收；父子归属使用 parent conversation 身份。
- **优先级**：**P1**

---

## 二、三种实施路径对比

| 路径 | 收益 | 成本 | 主要风险与技术债 | 结论 |
|---|---|---|---|---|
| 沿用当前方案 | 最接近 PR #375，初期代码合并成本较低 | 需要继续扩充 `CompletedTask`、缓存淘汰、恢复补偿和条件分支 | 冷启动伪装续聊、旧 tool-call 重复完成、close 重启失效、幂等依赖缓存状态 | **不建议继续** |
| 局部重构 | 保留 `task_id` 和外部 wire；内部拆分 session、turn、operation，并将活连接复用降为优化 | 中等，需要调整 broker 内部职责和事件契约 | 与上游实现存在内部差异，但可由兼容 facade 隔离 | **推荐路径** |
| 领域重构 | 持久 Session/Turn、关闭状态、事件 inbox/outbox，可完整支持跨重启与多来源协作 | 最高，涉及 schema、迁移和更完整的事件模型 | 若产品只要求当前进程内续聊，可能过度工程 | **仅在必须主动通知、永久关闭或完整轮次审计时采用** |

推荐选择“局部重构”：它可以解决本轮根因，同时避免为尚未明确需要的永久审计和跨重启事件系统投入完整领域重构。

## 三、保留、调整与停止项

### 可以保留

- D1：不反向 patch Claude 内部 SUB，继续改造自家委托通路。
- adapter/spawner 边界的 continuation capability 建模。
- 保活数量上限、idle sweep 和连接淘汰后的资源回收。
- 续聊 dispatch 的阶段化补偿矩阵。
- 多轮时间线历史保全。
- 用户、MCP 统一经过同一应用服务入口的方向。

### 必须调整

- 在兼容 wire 之下真正分离 Session、Turn 和 Operation。
- 明确主 AI“可查询”与“主动获知”两种不同产品契约。
- 将 close 拆分为资源释放或持久领域关闭之一。
- 重建贯穿 dispatching/running/settled 的幂等记录。
- 将父连接降为临时租约，而不是子会话所有者。

### 应停止继续开发

- 自动 `session/new` 后仍按成功续聊处理并覆盖原 `external_id`。
- 对同一个已完成 `parent_tool_use_id` 重复发出 completion。
- 继续把 `Completed_Cache` 扩展成会话生命周期真源。
- 在上述三项未换路前继续铺设更多 UI、状态字段和 transport 分支。

```yaml
patch_plan:
  - issue_id: B1
    severity: P0
    target_file: design.md
    anchor: "| resume 降级到 `session/new` | broker → 用户 |"
    action: replace_section
    intent: 停止将冷启动包装为成功续聊，改为发送前失败或经显式确认创建可识别的新会话分支
    rationale_short: 上下文丢失后已不再是原会话续聊，覆盖 external_id 会破坏身份与恢复凭据
  - issue_id: B2
    severity: P0
    target_file: requirements.md
    anchor: "WHEN a continued turn completes, THE Delegation Broker SHALL emit a completion event carrying the original `parent_tool_use_id`."
    action: replace_section
    intent: 区分被动可查询与主动通知，使用独立 turn/session 更新关联而非重复完成原工具调用
    rationale_short: 新轮次复用已完成 tool-call 无法可靠表达来源、排序和父 AI 感知
  - issue_id: B3
    severity: P0
    target_file: design.md
    anchor: "### D2 · 对齐上游 PR #375 契约而非自研"
    action: replace_section
    intent: 将上游 wire 兼容限制在 facade，内部最小分离 session、turn、operation 与结果缓存职责
    rationale_short: 合并便利不能作为压缩领域模型和扩张 Completed_Cache 职责的理由
  - issue_id: B4
    severity: P1
    target_file: design.md
    anchor: "`closed` 标记**不持久化**——进程重启后一个曾被 `close_session` 关闭的子会话会重新变为「可续聊」。"
    action: replace_section
    intent: 明确 close 是可恢复的资源释放还是持久领域关闭，并让名称、存储和验收一致
    rationale_short: 当前 close 语义随进程重启反转
  - issue_id: B5
    severity: P1
    target_file: design.md
    anchor: "**幂等键（R1-A6，全链路统一）**"
    action: replace_section
    intent: 建立覆盖 dispatching、running、settled 的统一 operation 去重契约并强制所有可重试入口携带稳定标识
    rationale_short: listener 生成新 UUID 和随 CompletedTask 生存的记录无法处理真实重试
  - issue_id: B6
    severity: P1
    target_file: requirements.md
    anchor: "WHERE a parent connection is torn down, THE Delegation Broker SHALL disconnect every `Kept_Alive_Connection` belonging to that parent before dropping the `Completed_Cache`."
    action: replace_section
    intent: 将父连接降为临时运行租约，按父会话与统一连接资源策略管理子会话连接
    rationale_short: 用户共享的持久子会话不应由易失父连接决定生命周期
```

## VERDICT
status: NEEDS_CHANGES
p0_count: 3
p1_count: 3
one_line: 当前方案仍以缓存和上游实现布局替代领域模型，并把冷启动、旧工具关联和临时关闭包装成续聊语义，建议暂停铺设功能面并转向兼容 facade 下的局部领域重构。
