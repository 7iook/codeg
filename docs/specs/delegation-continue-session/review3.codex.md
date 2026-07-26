> **[主 AI 下一步]** 读完本 review 修完 spec 后:若本轮已收敛(R3 或 APPROVED / p0=0)→ **调 `post-review-introspection` skill** 做「初稿→评审→最终稿」三阶段复盘,落 `introspection-<slug>.md`。评审器只报问题 · 主 AI 才能复盘(sub 与评审器都拿不到主 AI 原始思考)。仍需 R+1 → 忽略本条 · 修完 spec 再跑下轮。

---

# 【第 3 轮评审结论】

## 一、真实业务边界清单

### 1. 多租户、多账户、多店铺、多平台

- 文档明确把 codeg 定义为“单用户单租户”，并以全局 `CODEG_TOKEN` 作为服务器鉴权边界。
- 因此当前方案**不能直接推导出多租户或多账户安全性**。若未来一个服务实例承载多个用户、店铺、平台账户或工作区，`task_id`、`child_conversation_id`、`external_id`、`working_dir` 之间的归属和授权都不够。
- 需产品和技术负责人确认：单租户是否是本期不可变部署约束；若不是，当前用户侧按 ID 查询和续聊的设计不能开工。

### 2. 历史数据迁移与数据完整性

- 方案依赖既有 `Child_Session.external_id`、`parent_id`、`folder_id`、`working_dir`。
- 未定义历史行中以下情况的处理：`external_id` 缺失、重复、过期、属于其他 agent、对应旧版本 session、与当前 folder/working directory 不匹配。
- “按 DB 兜底恢复”只描述了加载路径，没有给出数据画像、冲突处理和不可恢复数量。

### 3. 并发、乱序和重复请求

- `continuation_id` 的幂等模型比前两轮完整，但仅规定了 ledger 的阶段，没有明确 ledger 与 session 状态更新的原子提交边界。
- session-scoped update event 携带 `Turn_Id`，却没有事件版本、序列号或乱序丢失后的重拉机制。
- 需要覆盖用户续聊、主 AI 续聊、close、cancel、服务重启同时发生的场景。

### 4. 超时、部分成功、服务重启

- 续聊阶段矩阵覆盖了连接创建和 prompt 发送失败，但没有完整定义以下情况：
  - prompt 已被外部 agent 接受，响应却在本地超时；
  - disconnect 成功但状态落盘失败；
  - 服务重启时 broker 内存索引与 DB 状态不一致；
  - `session/resume` 成功但 `session/load` 或首个事件丢失。
- 文档声称运行态索引可重建，但没有定义启动时扫描、重建、去重和失败隔离流程。

### 5. 关闭、取消和人工修改冲突

- 当前设计将 `close_session` 解释为资源释放，requirements 仍使用“closed / mark task closed / session_closed”。
- 人工删除会话、软删除、close、父会话删除和自动淘汰之间的优先级未完全定义。
- 用户人工修改或删除子会话后，broker 中残留的 `SessionEntry`、连接和 operation ledger 如何失效，尚无明确规则。

---

## 二、当前方案继续实施的风险

### A1｜服务重启后的续聊路径没有闭环，核心恢复承诺可能落空（架构级）

**定位锚点**：`运行态索引（broker PendingInner · 仅当前进程生命周期）`；`load_settled_from_db`；Requirement 3

- **问题**：文档一方面说明 broker 运行态会在进程退出后失效，另一方面又要求子进程被回收后可按 `external_id` 恢复，但没有规定服务重启后的 SessionEntry 重建、operation ledger 失效边界、重复恢复裁决或启动期间的并发请求处理。
- **问题根因**：把“子连接死亡后的恢复”和“broker 进程重启后的领域索引恢复”视为同一问题，但两者的状态来源和竞态不同。
- **业务影响**：服务重启后用户或主 AI 可能得到 `Unknown`、重复创建恢复连接，或在恢复尚未完成时误报 `not_continuable`。
- **架构影响**：DB 是持久身份来源，但没有明确的启动重建协议；“可重建”停留在设计声明，无法形成可验证契约。
- **修改建议**：在开工前明确是否承诺“服务重启后可续聊”。若承诺，应补充启动重建流程：扫描条件、父子归属校验、旧 operation 的处理、恢复并发锁、重建失败状态及可观测性。若不承诺，应将边界明确降为本进程有效，并修改 Requirement 3 和用户文案。
- **优先级**：**P0**

### A2｜设计接口、错误契约和验收矩阵仍有直接矛盾（功能级）

**定位锚点**：`### 错误码（wire-stable，types.rs）`；`continue_delegation(...)`；`| 3 resume 恢复 |`

- **问题**：
  1. 接口签名没有 `continuation_id`，但三条入口被规定为必须携带；
  2. 错误码列表没有 `resume_unavailable`，错误处理和 Requirement 3 又要求该错误；
  3. 错误处理仍写“用户侧 command 沿用 `client_message_id`”，与独立 operation ledger 冲突；
  4. 验收矩阵仍写“降级 `session/new` → `context_lost: true`”，与 Requirement 3.3 的“发送前返回 `resume_unavailable`”冲突；
  5. `CompletedTask.closed` 与内部状态名 `Released` 并存，无法确定实现应采用哪一个。
- **问题根因**：R2 修改了局部契约，但没有对接口、错误表、数据模型和验收矩阵做一次全局一致性收口。
- **业务影响**：不同实现者会产生不同的请求参数、错误码和恢复行为，测试无法判断哪一种是正确结果。
- **架构影响**：MCP、Tauri、Web、broker 之间可能形成平行幂等和状态真源。
- **修改建议**：以 `continuation_id`、`resume_unavailable`、`Released` 为最终 SSOT，逐段清除旧术语和旧 fallback；补齐所有函数签名、wire schema、错误映射和验收条目。
- **优先级**：**P1**

### A3｜外部会话身份的稳定性和冲突处理不足（架构级）

**定位锚点**：`Child_Session DB 兜底`；`external_id`；`spawn_for_resume(...)`

- **问题**：没有定义 `external_id` 是否全局唯一、是否必须与 agent 类型和工作目录绑定、旧版本 session ID 如何识别、同一外部 ID 被多个子会话引用时如何处理。
- **问题根因**：把 `external_id` 当作天然稳定的恢复凭据，却没有写出其来源、完整性和唯一性约束。
- **业务影响**：错误关联会话、恢复到错误账户或错误工作目录，历史数据迁移时尤其危险。
- **架构影响**：恢复链缺少防串联边界，`task_id` 的正确性不能替代外部 session 身份校验。
- **修改建议**：开工前核验数据库实际约束和生产数据画像；定义 agent、folder、working directory、账户配置的绑定校验，以及重复/过期/无法确认时的拒绝策略。
- **优先级**：**P1**

### A4｜事件乱序和“最新轮次”判定缺少可验证机制（功能级）

**定位锚点**：`WHEN a continued turn completes ... session-scoped update event`；`Requirement 2.8b`

- **问题**：事件仅携带 `Turn_Id` 和 origin，没有规定单调版本、排序规则、重复事件处理或前端补偿查询。
- **问题根因**：假设事件传输顺序等同于业务完成顺序。
- **业务影响**：延迟或乱序时，前端可能展示旧结果覆盖新结果，主 AI 查询到的“最新轮次”与事件状态不一致。
- **架构影响**：事件成为非可靠状态同步通道，却没有明确的查询回源和版本裁决。
- **修改建议**：为 session 增加单调 `turn_version`/sequence；事件处理按版本丢弃旧事件，并在检测到缺口时通过 `get_delegation_status` 回源。
- **优先级**：**P1**

### A5｜close/cancel 的部分失败和孤儿进程处理仍不完整（功能级）

**定位锚点**：`WHEN close_session is called`；`finalize_delegation` 的 `disconnect best-effort`

- **问题**：close 需要取消运行中的 turn、断开连接并标记 Released，但没有定义取消超时、disconnect 失败、状态写入失败或服务重启后的补偿。
- **问题根因**：只定义了理想路径和串行锁，没有定义外部副作用失败后的最终状态。
- **业务影响**：UI 显示已释放，但子进程仍运行；或 close 返回失败后调用方无法判断是否可安全重试。
- **架构影响**：资源状态和领域状态可能分裂，形成无人管理的后台任务。
- **修改建议**：补充 close 的阶段状态和最终一致性策略：取消确认超时、disconnect 重试/后台回收、失败可观测标记、重启后的孤儿扫描。
- **优先级**：**P1**

### A6｜单租户假设尚未成为明确的产品与部署门禁（需负责人确认）

**定位锚点**：`未采纳 R1-A3 的租户授权模型`；`授权验收（R1-A3 的实际范围）`

- **问题**：文档以当前实现推断“单用户单租户”，但本轮要求的多账户、多店铺、多平台场景没有被明确标为“不支持”或“本期禁止部署”。
- **问题根因**：把现状事实当成产品边界，没有定义部署拓扑和未来多账户的隔离承诺。
- **业务影响**：若 server 实例实际承载多个账户，单个全局 token 下的 child ID 查询可能造成越权或数据串联。
- **架构影响**：授权边界建立在部署假设上，而不是稳定的领域归属键上。
- **修改建议**：产品/技术负责人明确本期是否强制“一实例一用户”；若不是，暂停实现用户侧入口，先补 workspace/account scope、授权检查和存在性不泄漏契约。
- **优先级**：**P1**

---

## 三、推荐的更优实现方向

1. **先锁定部署边界**  
   明确本期只支持“一实例一用户一全局 token”，并在配置校验、部署文档和 UI 中显式声明；若要支持多账户，先建立 account/workspace scope，不要继续依赖全局 token。

2. **以 Session / Turn / Operation 为内部唯一模型**  
   - `Session`：稳定的 `task_id`、父子归属、恢复元数据和 Released 状态。
   - `Turn`：每次委托或续聊的独立生命周期、origin、版本和结果。
   - `Operation`：跨 MCP/Web/Tauri 重试的幂等记录。
   - wire 层继续通过 facade 映射为上游 `DelegationTaskReport`。

3. **把恢复分为两种明确路径**  
   - 活连接续聊：仅作为性能优化。
   - 外部 session 恢复：必须经过 agent capability、agent/folder/working directory 校验。  
   恢复失败在 prompt 产生副作用前返回 `resume_unavailable`，不得隐式冷启动。

4. **补充服务重启重建协议**  
   启动时从 DB 重建可续聊 Session 索引；operation ledger 默认不跨重启复用，旧请求返回明确的 retry/unknown 语义；重建失败的会话进入可观测的不可续聊状态。

5. **事件只做增量通知，查询作为状态真源**  
   事件携带单调版本；前端和主 AI 收到乱序或版本缺口时回查 status，不用旧 `parent_tool_use_id` 伪造新的工具完成事件。

6. **close 使用“资源释放”语义并彻底统一**  
   内部状态、错误码、UI 文案和验收全部使用 `Released`；若未来需要永久关闭，再另建持久状态，不复用本期 release 操作。

7. **分阶段交付，但收紧 M1 边界**  
   - 本期必须实现：broker 统一续聊、operation 幂等、恢复失败前置拒绝、事件版本、close/cancel 补偿、用户入口授权和端到端闭环。
   - 可延后：永久关闭、跨重启 operation 去重、完整事件 inbox/outbox、跨租户模型（前提是单实例单用户被正式确认）。
   - 不建议实现：继续保留裸 `acpPrompt` 的子会话写入旁路、自动 context-lost 冷启动、复用旧 tool-call completion 事件。

---

## 四、开工前代码核验清单

以下问题必须由实现方按项目约定的检索、结构分析和测试基线逐项回答：

### 领域模型与数据库

- `Child_Session` 是否确实由 `parent_id`、`kind=Delegate`、`delegation_call_id` 三者共同约束？
- `external_id` 是否允许为空、重复或被更新覆盖？
- `external_id` 是否有全局唯一约束，还是只在 agent/folder/working directory 范围内有效？
- `folder_id`、`working_dir` 和 agent 类型是否能从 DB 稳定恢复？
- 软删除的 conversation 是否会被所有续聊查询和恢复路径排除？
- 服务重启后是否存在从 DB 重建 SessionEntry 的现有机制？

### 接口、任务和事件链路

- MCP、Tauri、Web 三条入口是否最终调用同一个 broker/application service？
- `continuation_id` 是否贯穿请求解析、鉴权、broker ledger、响应和重试？
- 是否仍有生产路径把用户子会话消息直接发送到裸 `acpPrompt`？
- 现有 `delegation_completed` 是否支持 session-scoped、带 turn 版本的更新，而不是重复完成旧 tool call？
- 事件乱序、重复、丢失时，前端和主 AI 是否会回查 status？

### 数据来源与字段完整性

- `external_id` 的真实写入来源是否恒稳，是否可能被 `session/new` 或旧生命周期事件覆盖？
- `parent_tool_use_id` 是否只表示首轮委托关联，而不是续聊轮次身份？
- `task_id`、`turn_id`、`continuation_id` 是否分别由唯一且稳定的责任方生成？
- agent capability 是否有真实声明来源，还是只能通过失败探测推断？
- `session/resume` / `session/load` 成功后，返回的外部 session 身份是否可验证？

### 账户、租户和实体映射

- 当前部署是否强制一实例一用户一全局 token？
- 一个服务实例是否可能承载多个账户、店铺、平台或工作区？
- 用户侧传入的 `child_conversation_id` 是否能稳定验证其父会话归属？
- MCP 调用是否能验证调用方 parent conversation，而非只验证易失的 parent connection？
- 不存在的 child ID、普通 conversation ID 和其他作用域 ID 是否返回同一非泄漏结果？

### 状态机、幂等和失败恢复

- Session、Turn、Operation 是否分别有明确状态和合法迁移？
- close 与 continue/cancel 的锁内裁决是否覆盖 dispatching、running、settled 全阶段？
- cancel 或 close 超时后，如何确认子进程不会继续运行？
- `send_followup_prompt` 已被外部接受但本地超时，重试是否会重复执行？
- operation ledger 与状态迁移是否原子，服务重启后旧 operation 如何处理？
- idle sweep、全局 cap、每父会话 cap 和 close 是否共用同一连接回收路径？
- 被淘汰或重启后的会话是否能明确区分 `ContinuableResume` 与 `NotContinuable`？

### 历史实现与废弃逻辑

- 旧的 `CompletedTask.closed`、`session_closed`、`context_lost`、`client_message_id` 语义是否已全部清除或明确兼容边界？
- 旧的 one-shot disconnect、父连接 teardown 回收和裸标签页发送路径是否仍可绕过新状态机？
- 旧事件消费者是否会把新的 session update 当作重复 completion？
- 历史版本产生的重复或失效 `external_id` 是否有迁移/隔离方案？

### 前后端能力与测试基线

- 前端是否已有 `get_continuation_availability` 或等价能力，避免再造 API？
- 子会话 Dialog、完整标签页和侧边栏是否共用同一发送服务？
- 是否已有多轮时间线、事件乱序、重连和错误码展示测试？
- 是否有真实生产数据规模下的连接数、句柄数、resume 延迟和 idle sweep 基线？
- 是否有多子代理 fan-out、服务重启、断网、agent 崩溃、重复点击和跨入口重试的集成测试？
- 端到端测试是否真正验证“用户续聊完成后，主 AI 下一次 status 查询可见新结果”？

---

## 五、必须由产品/业务/技术负责人确认的问题

1. 本期是否正式承诺“服务重启后仍可续聊”，还是只承诺当前 broker 进程存活期间可续聊？
2. 单实例单用户是否是不可突破的部署约束？未来是否需要多账户、多店铺、多平台或多工作区隔离？
3. `close_session` 的产品语义是否确定为“释放资源、未来允许再次续聊”，而非永久关闭？
4. resume 失败时是否绝对禁止自动冷启动？若允许冷启动，是否必须由用户明确确认并创建新的 session incarnation？
5. 主 AI 对用户续聊结果的契约是“下次查询可见”，还是需要主动通知？若需主动通知，是否接受引入持久 inbox/outbox？
6. 外部 agent 的 resume/load 能力是否需要按版本、账户配置和 agent 类型进行能力声明？
7. `external_id` 冲突、缺失、过期或无法验证时，产品希望拒绝续聊、提示用户新建，还是进入人工修复流程？
8. close/cancel 的 disconnect 失败是否允许异步补偿？UI 应显示“已释放”“释放中”还是“释放失败”？
9. M1 是否允许用户打开子会话但暂时发送到绕过 broker 的旧通路？若不允许，应取消该阶段；若允许，必须接受主 AI 不可见的明确限制。
10. 是否要求保留每一轮续聊的完整审计记录，还是只保留最新结果即可？

---

## 六、落地决定

**暂停并重新设计**：当前仍存在服务重启恢复闭环缺失、接口与验收契约互相矛盾，以及外部会话身份完整性未定义等开工阻断项；先完成上述核验和契约收口，再进入实现。

```yaml
patch_plan:
  - issue_id: A1
    severity: P0
    target_file: design.md
    anchor: "运行态索引（broker `PendingInner` · 仅当前进程生命周期）"
    action: append_after
    intent: 明确服务重启后的续聊承诺、SessionEntry 重建、旧 operation 处理和恢复失败状态
    rationale_short: 当前 DB 持久身份与 broker 重启后索引之间没有可执行恢复协议
  - issue_id: A2
    severity: P1
    target_file: design.md
    anchor: "### 错误码（wire-stable，`types.rs`）"
    action: replace_section
    intent: 统一 continuation_id、resume_unavailable、Released、接口签名和验收矩阵中的最终契约
    rationale_short: 当前设计、错误表、数据模型和测试仍保留互相冲突的旧语义
  - issue_id: A3
    severity: P1
    target_file: design.md
    anchor: "`external_id` 落库"
    action: append_after
    intent: 补充 external_id 的来源、唯一性、agent/folder/working_dir 绑定和历史数据冲突处理
    rationale_short: 恢复凭据的完整性与实体归属尚未成为可验证约束
  - issue_id: A4
    severity: P1
    target_file: requirements.md
    anchor: "WHEN a continued turn completes, THE Delegation Broker SHALL emit a session-scoped update event"
    action: append_after
    intent: 增加单调版本、乱序重复处理和 status 回源规则
    rationale_short: 仅携带 Turn_Id 不能保证最新结果不会被延迟事件覆盖
  - issue_id: A5
    severity: P1
    target_file: design.md
    anchor: "`disconnect` 失败被忽略（best-effort，与现状一致）"
    action: append_after
    intent: 定义 close/cancel/disconnect 部分失败、超时、异步补偿和孤儿进程回收
    rationale_short: 资源释放与领域状态可能在外部副作用失败时分裂
  - issue_id: A6
    severity: P1
    target_file: requirements.md
    anchor: "授权验收（R1-A3 的实际范围）"
    action: append_after
    intent: 将单实例单用户假设提升为明确部署门禁，或补充账户/工作区授权边界
    rationale_short: 当前安全边界依赖未经负责人确认的部署假设
```

## VERDICT
status: NEEDS_CHANGES
p0_count: 1
p1_count: 5
one_line: 方案已吸收前两轮主要架构意见，但服务重启恢复、契约一致性、外部会话身份和部分失败处理仍未达到生产开工条件。
