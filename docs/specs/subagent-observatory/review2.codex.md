> **[主 AI 下一步]** 读完本 review 修完 spec 后:若本轮已收敛(R3 或 APPROVED / p0=0)→ **调 `post-review-introspection` skill** 做「初稿→评审→最终稿」三阶段复盘,落 `introspection-<slug>.md`。仍需 R+1 → 修完 spec 再跑下轮。

---

# 第 2 轮评审结论

评审范围仅限 `design.md`、`requirements.md`、`review.codex.md`。文档引用的源码、侦察报告及 UI 设计卡均未核验，相关事实视为实现方提供的前提。

## 一、架构级问题

### B1 · 会话归属方案换了方向，但 selector 输入契约仍未闭合

- **定位锚点**：`observedSubAgents.buildRows(delegations, subagents, currentConversationId)`
- **问题**：正式函数签名只接收 `currentConversationId`，Requirement 2.5 却要求比较 `parentConnectionId` 与“当前会话所属连接标识”，Requirement 2.7 还要求判断是否匹配“任何已知会话”的连接标识。函数既没有当前连接标识，也没有已知会话集合。
- **问题根因**：R1 后把归属来源从数据库父会话改为连接标识，但只替换了数据来源，没有同步重建 selector 的完整输入契约。
- **业务影响**：“当前会话 / 其他会话 / 未归属”仍可能被实现成猜测或退化逻辑，清单核心分区不可信。
- **架构影响**：所谓纯 selector 无法从声明的参数确定输出；实现方只能偷偷读取全局 store，或再次引入隐式依赖。
- **修改建议**：明确选择一种模型：
  1. selector 显式接收 `currentConnectionId + knownConnectionIds`；
  2. 上游先生成稳定的 `conversationScope`，selector 不再负责解析；
  3. 若一个 connection 可能承载多个 conversation，则连接标识不能作为会话归属真源，需重新选择权威键。该唯一性需实现方核实。
- **业务分类**：**A 业务刚需**。
- **优先级**：**P0**

### B2 · 取消后的权威状态没有回写到行模型真源

- **定位锚点**：`THE 观察面板 SHALL 以 broker 报告的状态作为该行终态的唯一真源。`
- **问题**：行生命周期由 `DelegationBinding.status` 派生；取消命令则直接返回 `DelegationTaskReport`。文档没有定义报告如何进入 DelegationProvider、是否产生统一完成事件、以及响应与事件冲突时谁覆盖谁。
- **问题根因**：把“取消命令响应”和“观察投影事件”都称为 broker 真源，却没有为两条传播路径建立单一版本化状态流。
- **业务影响**：取消已成功但行仍显示运行中，或行先收到完成事件、后被取消响应改成另一终态。
- **架构影响**：命令响应、本地取消中状态、Binding 事件形成多真源；R7.9 的“保留已到达终态”也无法解决两个不同终态冲突。
- **修改建议**：在领域层确定一次终态迁移，再通过唯一观察通道更新 Binding。命令响应可以确认请求结果，但不应另建一套行终态。若必须合并两条流，需携带单调版本或权威排序键，并定义 `Completed/Canceled/Failed` 冲突规则。
- **业务分类**：**B 稳定性保护**。
- **优先级**：**P0**

### B3 · 常驻条的观察集合和计数口径仍有三套互相冲突的定义

- **定位锚点**：`- **子智能体常驻条（Sub-Agent Chip）**:`
- **问题**：
  - Glossary 说计数取自委托池；
  - D4 说常驻条计数取自委托池；
  - Requirement 5.2、5.3、5.5 则要求取委托与内部 SUB 的并集；
  - Introduction 又称这是“属于委托子智能体”的常驻条。
- **问题根因**：R1 修复了入口生命周期，却没有把旧的委托池口径从设计总览、决策和术语定义中统一清理。
- **业务影响**：同一场景可能显示 0、只显示委托数或显示两类合计；验收方无法判断哪个结果正确。
- **架构影响**：入口、selector、计数测试和文案没有统一消费契约。
- **修改建议**：选定一个权威口径并全局统一。按当前用户痛点，入口观察集合应包含两类对象；若数字只表示“可取消的委托”，必须明确命名为委托运行数，并另行呈现内部 SUB 活动，而不能称作面板总数。
- **业务分类**：**A 业务刚需**。
- **优先级**：**P0**

### B4 · “运行中 / 已静默”仍以启发式状态掩盖领域事件缺失

- **定位锚点**：`### D7 · 内部 SUB 状态降级为「运行中 / 已静默」`
- **问题**：15 秒阈值虽然不再宣称“完成”，但仍将无权威信号的数据推断为“运行中”，并驱动常驻条活动指示和运行计数。正式 selector 签名也没有 `now`，文档未定义无新帧时由谁触发状态重算。
- **问题根因**：为了保持统一生命周期 UI，继续把活动证据包装成任务状态，并隐含引入定时刷新机制。
- **业务影响**：正常思考超过阈值会突然“静默”；已结束对象在阈值内仍显示运行中。用户可能据此作出错误干预判断。
- **架构影响**：纯 selector 实际依赖系统时间和周期调度，确定性测试、引用稳定性及 memo 约束互相冲突。
- **修改建议**：将内部 SUB 建模为“最近活动证据”，显示最后活动时间或“最近有活动/暂无近期活动”，不要进入权威运行计数。若坚持阈值，必须让 `now` 成为显式输入，并定义唯一调度者、刷新频率与测试时钟。
- **业务分类**：活动可见性是 **A**；伪生命周期推断是 **D 技术整洁/视觉对称**。
- **优先级**：**P1**

### B5 · 已完成记录仍由实现对象生命周期代替业务生命周期

- **定位锚点**：`### D3 · 已完成态由前端自留，不新增后端持久化`
- **问题**：“会话关闭”仍未定义为关闭 tab、关闭会话、Provider 卸载、刷新页面还是断线；委托完成记录也没有容量策略。文档称冷加载已有独立路径，但没有说明该路径如何重新进入观察面板投影。
- **问题根因**：直接把 Provider 存续期当成用户会话存续期，并用一个未接入本面板的数据路径解释刷新恢复。
- **业务影响**：完成记录可能切 tab 即消失、刷新后丢失，或长会话无限增长。
- **架构影响**：实时投影、冷加载数据与多会话展示边界不清，后续容易形成第二套历史聚合逻辑。
- **修改建议**：定义业务生命周期事件及容量边界。若产品只承诺“当前页面存续期”，应直说并删除刷新恢复暗示；若承诺刷新后可回看，则必须把冷加载 producer 到观察面板 consumer 的链路写完整。
- **业务分类**：**B 稳定性保护**。
- **优先级**：**P1**

### B6 · 后台任务横幅分类属于跨领域扩围，业务收益不足以支撑 wire 改造

- **定位锚点**：`### Requirement 5A: 后台任务横幅的口径分离`
- **问题**：本需求的核心是子智能体观察与取消，却额外修改另一个任务池的后端事件、快照、前端类型和横幅。其 User Story 声称数字要与“点开清单”对上，AC 又明确横幅不统计委托，而观察面板包含委托，因此目标本身无法成立。
- **问题根因**：把既有横幅文案不清晰的问题升级为跨层分类协议，而不是先用局部文案澄清其总体口径。
- **业务影响**：用户仍面对两个不会相等的数字，却承担额外协议变更和版本兼容风险。
- **架构影响**：观察面板 spec 开始拥有 BackgroundWatcher 域的事件设计，扩大 bounded context 和回归面。
- **修改建议**：本轮停止分类 wire 改造，先把既有横幅统一命名为“Claude 原生后台活动”或同等清晰口径。只有用户确实需要分别管理 async agent 与 shell、且两类有不同操作时，再作为独立需求设计分类协议。
- **业务分类**：当前形态为 **D 技术洁癖/展示细分**；口径不误导本身属于 **B**，可由文案解决。
- **优先级**：**P1**

### B7 · 委托消息摘要新增了第二条读取路径，但没有证明值得建设

- **定位锚点**：`WHEN 用户选中一个委托行, THE 观察面板 SHALL 就地展示该子会话最近一条助手消息的摘要。`
- **问题**：现有完整子会话查看器已被列为可复用能力，当前方案仍新建“最近一条助手消息”的加载、缓存、错误和重试路径，却没有定义接口或说明为何现有 Dialog 不能从行直接打开。
- **问题根因**：为了让两类对象在 Popover 中视觉对称，把既有会话读取能力拆出第二种轻量读取模型。
- **业务影响**：摘要可能陈旧或缺少上下文；用户仍需打开完整会话，而新增加载失败态反而增加摩擦。
- **架构影响**：形成完整会话读取与摘要读取两条消费路径，后续需处理缓存一致性、请求取消和会话更新。
- **修改建议**：保留内部 SUB 的缓存帧就地展示；委托行优先直接复用既有 Dialog/Open in Tab。只有经过交互验证证明“跳转成本”仍是主要痛点，再补统一的会话摘要投影，而不是在 Popover 内临时发起专用查询。
- **业务分类**：查看消息是 **A**；专门的单条摘要 loader 目前为 **D**。
- **优先级**：**P1**

### B8 · 内部 SUB 归属依赖“映射先存在”的隐含时序

- **定位锚点**：`THE SubagentTranscriptProvider SHALL 通过 getConversationIdByExternalIdFromStore`
- **问题**：事件到达时解析失败就标为未归属，但没有规定 store 后续出现映射时是否重新解析。
- **问题根因**：把一次查询结果存成稳定归属，默认会话映射一定早于帧事件建立。
- **业务影响**：启动、重连或事件乱序时，本应属于当前会话的 SUB 可能永久留在未归属分区。
- **架构影响**：Provider 缓存派生值而不跟踪其依赖变化，产生状态污染。
- **修改建议**：让归属成为对当前映射表的响应式派生结果，或明确订阅映射变化后重算未归属条目。不要把首次解析失败固化为终态。
- **业务分类**：**B 稳定性保护**。
- **优先级**：**P1**

### B9 · 技术支撑项仍未完成业务现实分类

- **定位锚点**：`THE DelegationProvider SHALL 使该投影的引用在无变更时保持稳定。`
- **问题**：spec 以外的侦察报告曾做过分类，不能替代本文件自身对新增能力的业务论证。稳定引用、容器无关升级留口、后台分类字段、专用摘要 loader 等仍主要由 memo、未来升级或结构整洁驱动。
- **问题根因**：将性能实现建议和未来扩展点提升为强制验收要求。
- **业务影响**：核心观察与取消被非核心工程任务拖慢。
- **架构影响**：测试开始锁定引用相等、容器抽象等实现细节，限制后续等价实现。
- **修改建议**：在 spec 内对新增能力做最小分类：核心面板/取消为 A，竞态及淘汰提示为 B；删除或降级无法说明用户损失的 D 类要求。稳定引用只有在已有性能证据或明确消费契约时才应成为 AC。
- **优先级**：**P1**

## 二、三种路径反向比较

| 路径 | 收益 | 成本与风险 | 技术债判断 |
|---|---|---|---|
| 沿用当前方案 | 一次性交付内容多，UI 表面统一 | 同时修改 broker、两个 Provider、selector、消息读取、后台 wire、横幅和 Popover；状态与计数口径仍冲突 | **不建议**，会把观察需求扩成跨任务池平台改造 |
| 局部重构 | 聚焦“可见、可打开、可取消”；复用现有会话查看器；内部 SUB 只展示活动证据 | 需先统一入口计数、会话归属输入和取消状态流 | **推荐**，最小闭环且债务可控 |
| 领域重构 | 建立统一 Work Item/Agent Activity 领域事件，覆盖委托、内部 SUB、原生 async 与 shell | 成本高，需统一身份、生命周期、权限、终态及历史存储 | 仅当产品明确要统一任务中心时立项，不应夹带在本需求中 |

## 三、保留、调整与停止项

### 可以保留

- 两类观察对象显式声明不同能力，不强行提供相同操作。
- Context 只提供来源投影，跨来源归一集中在 selector。
- 前端只传 `child_conversation_id`，后端负责解析 broker 目标。
- 桌面与服务器共用 `_core` 业务入口。
- 不要求不同任务池的数字相等。

### 必须调整

- selector 的会话归属输入。
- 常驻条唯一计数口径。
- 取消终态的唯一传播路径。
- 内部 SUB 从“生命周期状态”降为“活动证据”。
- 完成记录的业务生命周期、容量与刷新语义。
- session 映射迟到时的重新归属。

### 应停止继续开发

- 本 spec 内的 BackgroundActivity 分类 wire 改造。
- 未证明必要的委托专用摘要加载器。
- 仅为 memo 或未来换容器而设置的强制验收约束。

```yaml
patch_plan:
  - issue_id: B1
    severity: P0
    target_file: design.md
    anchor: "observedSubAgents.buildRows(delegations, subagents, currentConversationId)"
    action: replace_section
    intent: 闭合会话归属所需的当前连接与已知连接输入，或将归属解析完全前移到上游
    rationale_short: 当前函数参数无法满足自身声明的会话分区契约
  - issue_id: B2
    severity: P0
    target_file: requirements.md
    anchor: "THE 观察面板 SHALL 以 broker 报告的状态作为该行终态的唯一真源。"
    action: replace_section
    intent: 建立取消结果到 DelegationBinding 的唯一终态传播路径并定义冲突排序
    rationale_short: 命令响应与事件投影目前形成两个未协调的状态源
  - issue_id: B3
    severity: P0
    target_file: requirements.md
    anchor: "- **子智能体常驻条（Sub-Agent Chip）**:"
    action: pattern_rewrite
    intent: 统一 Introduction、Glossary、D4 与 Requirement 5 的观察集合及计数口径
    rationale_short: 同一常驻条同时被定义为委托池计数和两类对象并集计数
  - issue_id: B4
    severity: P1
    target_file: design.md
    anchor: "### D7 · 内部 SUB 状态降级为「运行中 / 已静默」"
    action: replace_section
    intent: 将内部 SUB 改为活动证据模型，或显式补齐时钟输入和状态重算调度
    rationale_short: 静默阈值不是权威生命周期且隐含定时刷新机制
  - issue_id: B5
    severity: P1
    target_file: design.md
    anchor: "### D3 · 已完成态由前端自留，不新增后端持久化"
    action: replace_section
    intent: 定义业务会话关闭事件、容量、刷新重连及冷加载接入面板的完整链路
    rationale_short: Provider 生命周期不能替代用户可理解的记录生命周期
  - issue_id: B6
    severity: P1
    target_file: requirements.md
    anchor: "### Requirement 5A: 后台任务横幅的口径分离"
    action: replace_section
    intent: 移除本轮后台分类 wire 扩围，收敛为不误导的总体口径文案或拆为独立需求
    rationale_short: 分类计数不解决面板数字对齐且跨越了观察面板领域边界
  - issue_id: B7
    severity: P1
    target_file: requirements.md
    anchor: "WHEN 用户选中一个委托行, THE 观察面板 SHALL 就地展示该子会话最近一条助手消息的摘要。"
    action: replace_section
    intent: 优先复用既有完整会话查看器，仅在业务验证后引入统一摘要投影
    rationale_short: 当前专用摘要读取路径缺少接口且与既有查看能力重复
  - issue_id: B8
    severity: P1
    target_file: requirements.md
    anchor: "THE SubagentTranscriptProvider SHALL 通过 `getConversationIdByExternalIdFromStore`"
    action: append_after
    intent: 补充映射迟到或变化时对未归属条目的响应式重算契约
    rationale_short: 一次解析失败目前会把事件乱序固化为错误归属
  - issue_id: B9
    severity: P1
    target_file: requirements.md
    anchor: "THE DelegationProvider SHALL 使该投影的引用在无变更时保持稳定。"
    action: replace_section
    intent: 将稳定引用等纯实现要求降级，并在文档内补齐新增能力的A/B/C/D分类
    rationale_short: 外部侦察报告不能替代被审spec自身的业务现实论证
```

## VERDICT
status: NEEDS_CHANGES
p0_count: 3
p1_count: 6
one_line: 核心方向可保留，但会话归属、常驻条计数和取消终态仍未闭环，且后台分类与摘要加载已出现跨域过度实现。
