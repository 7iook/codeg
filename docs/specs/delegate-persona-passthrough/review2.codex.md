> **[主 AI 下一步]** 读完本 review 修完 spec 后:若本轮已收敛(R3 或 APPROVED / p0=0)→ **调 `post-review-introspection` skill** 做「初稿→评审→最终稿」三阶段复盘,落 `introspection-<slug>.md`。仍需 R+1 → 修完 spec 再跑下轮。

---

# 第 2 轮评审结论

当前方案对 Kiro 的原生透传基本成立，但 Claude/Codex 路径仍在用“应用层读取供应商人格文件并拼入普通用户消息”修补 wrapper 能力缺失。这不是同一能力的弱实现，而是另一种产品语义、数据生命周期和安全边界。

本轮建议：**保留 Kiro 路径；暂停 Claude/Codex 文件读取式 preamble 实现，先决定是否把它作为独立的 `persona_hint` 能力；不要继续按当前三家统一字段、统一成功表象落地。**

## 一、架构级问题

### A1｜P0｜Claude/Codex 方案仍是对 wrapper 缺口的应用层补丁，而非用户所需能力

- **定位锚点**：`### Requirement 3: Claude Code / Codex 走首轮 Preamble 注入(best-effort · 非真人格)`
- **问题**：用户需要的是“点名已有自定义 subagent”，当前实现却自行读取文件、丢弃 frontmatter，再把正文放进普通首轮用户消息。即使标注 `best-effort`，也没有兑现原人格的指令层级、权限、工具、模型和 hook。
- **问题根因**：把“wrapper 没有原生入口”这个技术缺口直接转换成了新的文本模拟能力。文档唯一的产品授权是 AskUserQuestion 被 declined 后由主 AI自行选择，不能证明用户接受这一替代产品。
- **业务影响**：`reviewer`、`executor` 等人格可能依赖工具权限和高优先级指令；文字看似注入成功，实际行为可能与用户选中的人格明显不同。
- **架构影响**：同一个 `subagent_type` 同时表示“原生人格标识”和“普通文本提示”，形成不可替换的双重领域语义。
- **修改建议**：
  1. Kiro 原生路径可继续。
  2. Claude/Codex 在获得明确产品接受前，应保持 unsupported，不能用 `subagent_type` 宣称已支持。
  3. 若用户确实需要提示词模拟，应将其建模为独立、明确的 `persona_hint`/prompt-profile 能力，而不是复用原生 persona selection 契约。
  4. 上游 wrapper 原生支持出现后，再接入 `subagent_type`。
- **业务分类**：Kiro 为 **A 业务刚需**；当前 Claude/Codex resolver+preamble 答不出“用户是否接受此损失”，按规则属于 **D 技术替代方案，暂不应做**。
- **优先级**：**P0**

### A2｜P1｜Broker 承担了供应商配置解析，跨越领域边界

- **定位锚点**：`### 6. broker 翻译层`
- **问题**：broker 不仅编排 delegation，还识别三家 CLI、定位各家 home、读取供应商私有文件格式、解释 frontmatter，并决定提示词降级语义。
- **问题根因**：为维持“一条通道支持三家”的表面统一，把 provider adapter 的职责塞进了通用 delegation broker。
- **业务影响**：供应商目录、格式或原生支持变化时，通用委托链路也要跟着修改；失败会影响所有 delegation。
- **架构影响**：broker 逐渐成为供应商条件分支中心；未来从 preamble 升级原生通道并非文档声称的“只加一个枚举变体”，还涉及解析、存储、错误和 UI 语义迁移。
- **修改建议**：由 provider capability/adapter 返回 `NativePersona`、`PromptHint` 或 `Unsupported`；broker 只消费标准化结果。当前只有 Kiro 一条真实路径时，不必建设独立服务或事件总线。
- **优先级**：**P1**

### A3｜P1｜Requirements 仍要求通用 runtime_env override，与已选 LaunchOption 架构冲突

- **定位锚点**：`THE broker SHALL derive a per-call effect map`
- **问题**：Requirement 1.4、2.1、2.2、4.1 仍使用 `effect map`、`runtime_env override map`，design 则明确否决任意 Map，要求 `Option<LaunchOption>`。
- **问题根因**：R1 只修改了 design，需求契约没有同步，两个文档仍提供不同实现方向。
- **业务影响**：执行者可能按 requirements 重新引入已经否决的通用环境变量覆盖。
- **架构影响**：类型化领域参数与无类型基础设施控制面同时成为“规范”。
- **修改建议**：全局统一为类型化 `LaunchOption`；只有 production adapter 内部允许把 `KiroPersona` 翻译为 `KIRO_AGENT`。
- **优先级**：**P1**

### A4｜P1｜系统只记录“请求了什么”，没有可信表达“实际生效了什么”

- **定位锚点**：`### Requirement 5: 前端 Delegation Card 显示所派人格`
- **问题**：卡片从 `raw_input.subagent_type` 直接显示 `@persona`；unsupported CLI 即使实际忽略仍会显示所派人格。Claude/Codex 也只显示请求名，无法证明文件解析、注入或模型行为生效。
- **问题根因**：把 command/request 当成 outcome/effective state，缺少“requested、resolved、applied、ignored、failed”的区分。
- **业务影响**：用户查看时间线时可能误以为人格已经运行；`[note]` 只存在于成功结果尾部，不能修复历史卡片的错误表象。
- **架构影响**：展示层以输入 JSON 为真源，而不是执行结果；后续审计、恢复和故障定位都无法回答实际采用了什么。
- **修改建议**：UI 必须区分“请求人格”和“有效人格状态”。若不新增结果状态，unsupported 至少不得显示成已应用；Claude/Codex 只能显示明确的 hint 状态。
- **业务分类**：显示有效人格为 **A**；仅显示请求参数属于技术表象，不能作为业务验收。
- **优先级**：**P1**

### A5｜P1｜Resume 结论依赖未证实的持久化与 replay 前提

- **定位锚点**：`**Persona SSOT (Single Source of Truth)**`
- **问题**：文档断言首轮 preamble 会进入 `conversation` 表且 wrapper 冷恢复时自然 replay，但没有说明谁写入、谁读取、恢复入口如何关联该行，也没有冷恢复验收项。
- **问题根因**：用“应该自然 replay”替代 producer→storage→consumer 契约；同时把 Kiro 冷恢复丢人格定义成“非 codeg 违约”，却又要求会话人格保持不变。
- **业务影响**：热 follow-up 正常但进程死亡后人格消失，用户仍可能看到原人格标签。
- **架构影响**：所谓 SSOT 实际分散在 argv、外部 CLI session 和普通消息行中，没有统一的可观测状态。
- **修改建议**：逐家写明冷恢复保证等级及真实链路；增加 process-death e2e。关于 conversation 与 wrapper replay 的事实均标记为**需实现方核实**，核实前不能作为完成前提。
- **优先级**：**P1**

## 二、普通契约与实现缺陷

### F1｜P1｜Kiro 错误码仍与 Success State 的“统一错误码”矛盾

- **定位锚点**：`Kiro / Claude / Codex 派人格失败`
- **问题**：Success State 要求三家文件错误统一为 `invalid_persona`，下一条、验收矩阵、Requirement 2 和 design 错误矩阵又规定 Kiro 不存在时返回 `spawn_failed`。
- **问题根因**：按现有层级沿用错误码，而非先统一“无效名称、人格不存在、启动失败”的领域分类。
- **业务影响**：主 AI 无法跨 CLI 采用一致的“修名还是重试”策略。
- **架构影响**：同一业务失败因 provider 实现位置不同而暴露不同 wire code。
- **修改建议**：明确唯一错误矩阵；若 Kiro 现有层无法区分文件不存在和启动失败，标注**需实现方核实**并诚实声明差异，不得再写“统一”。
- **优先级**：**P1**

### F2｜P1｜未闭合 frontmatter 被当正文注入，违反“frontmatter 不生效”契约

- **定位锚点**：`**Frontmatter 剥离**(替代原来的简单正则,支持 BOM/CRLF/未闭合/空 body):`
- **问题**：未找到 closing fence 时，设计把整个文件当正文；这会把 `model`、permissions、hooks 等 YAML 原文一起注入 prompt。
- **问题根因**：为了宽容异常文件，牺牲了“元数据不进入提示词”的核心边界。
- **业务影响**：格式损坏的人格文件可能产生与正常文件完全不同的提示，且用户难以定位。
- **架构影响**：解析失败被静默转换成另一种语义，`invalid_persona` 的格式错误分支实际缺失。
- **修改建议**：未闭合 frontmatter 应确定性失败，或先证明该文件不属于 frontmatter；不能无提示地把疑似元数据降级为正文。
- **优先级**：**P1**

### F3｜P1｜200 KiB 限制没有保护真正受影响的 prompt 预算

- **定位锚点**：`Claude/Codex persona 文件超 200 KiB`
- **问题**：设计明确把上下文预算交给下游模型处理，但 broker 正是组合 preamble 与 task 的责任层。200 KiB 文本可能占用数万 token，挤掉任务或导致请求拒绝。
- **问题根因**：用文件 IO 上限替代组合后 prompt 的业务约束，再把本层制造的超限风险下推给 consumer。
- **业务影响**：委托失败、任务被截断、延迟与费用异常；即使 marker 出现，也不能证明实际任务被完整执行。
- **架构影响**：producer 不遵守 consumer 前置条件，形成末端失败。
- **修改建议**：若保留 preamble 路径，必须给人格文本单独的小预算或组合预算，并定义超限错误；不能依赖模型自行处理。具体模型预算来源**需实现方核实**。
- **优先级**：**P1**

### F4｜P1｜“direct child”和 TOCTOU 安全声明没有被所述算法保证

- **定位锚点**：`**Symlink safety (Requirement 3.3 + Requirement 8)**`
- **问题**：
  - `canonical.starts_with(canonical_root)`只证明位于根目录下，不能证明是 direct child。
  - 文档称 canonicalize 后打开文件即可避免 TOCTOU，但没有明确是打开 canonical path 还是重新打开 candidate；若后者，symlink 可在两步间变化。
  - `metadata()` 后再无上限读取也不能保证实际读取量仍 ≤200 KiB。
- **问题根因**：把路径前缀检查、目录层级检查和无竞态文件打开混成一个断言。
- **业务影响**：实际可读文件范围可能宽于需求声明，或读取发生在检查后的不同对象上。
- **架构影响**：安全性质无法由测试中的单个 symlink escape case证明。
- **修改建议**：分别规定 direct-child 判定、打开哪个已规范化路径、读取时如何硬限制字节数；平台可实现性**需实现方核实**。
- **优先级**：**P1**

## 三、三种路径对比

| 路径 | 收益 | 成本 | 风险与技术债 | 结论 |
|---|---|---:|---|---|
| 沿用当前方案 | 一次字段覆盖三家，短期可见效果快 | 中 | 双重语义、broker 供应商耦合、prompt 持久化、UI 假成功、未来原生迁移 | **停止继续开发 Claude/Codex 部分** |
| 局部重构 | Kiro 先交付；Claude/Codex 明确 unsupported，或另设经产品接受的 `persona_hint` | 低至中 | 暂时不能宣称三家真人格，但契约诚实且迁移简单 | **本轮推荐** |
| 领域重构 | provider capability/adapter 统一返回 native/hint/unsupported 和 effective status | 高 | 对当前仅三家可能偏重；若近期会接更多 provider 或多种启动能力则值得 | **暂不单独立服务；只抽最小 adapter 边界** |

不建议引入事件总线、异步任务或独立 persona 服务：本需求是一轮本地 spawn 决策，没有证据表明这些重型结构能产生业务收益。

## 四、保留、调整、停止清单

### 可以保留

- Kiro 的类型化 `LaunchOption::KiroPersona`。
- per-call 优先于 panel 默认、无共享可变状态的并发隔离。
- 名称 grammar 与 canonical containment 分层校验的方向。
- 对原生人格与提示词模拟进行可见区分的原则。
- 不引入任意环境变量 Map。

### 必须调整

- requirements 中残留的 runtime_env override/effect map。
- 请求状态与实际生效状态的展示模型。
- 三家错误码矩阵。
- 冷恢复链路及验证。
- frontmatter 异常语义、prompt 预算和文件读取安全性质。
- Broker 与 provider-specific 逻辑的责任边界。

### 应停止继续开发

- 在未经明确产品接受前，通过 `subagent_type` 为 Claude/Codex 自动读取人格文件并模拟真人格。
- unsupported CLI 仍显示为“已派 @persona”的 UI。
- “下游模型自行 handling”式上下文预算下推。
- 继续以“一条字段覆盖三家”作为成功标准。

## 五、业务现实校验

| 新能力 | 真实场景 | 缺失影响 | 现有覆盖 | 分类 | 结论 |
|---|---|---|---|---|---|
| `subagent_type` + Kiro 原生选择 | 主 AI 点名 Kiro reviewer/executor | 使用错误人格 | panel 默认不能表达 per-call 选择 | A | 保留 |
| `LaunchOption::KiroPersona` | 将 per-call 选择安全传至启动层 | 无法覆盖默认人格 | 无同等 typed 通道 | A 的内部机制 | 保留 |
| Claude/Codex persona resolver | 尝试绕过 wrapper 不支持 | 真实人格需求仍未满足 | 普通 task 已能携带文字指令 | D/待产品确认 | 暂停 |
| Preamble 注入 | 用文本提示模拟人格 | 仅行为可能接近，权限等仍缺失 | host AI 可直接写任务指令 | D/待产品确认 | 不得复用原生 persona 契约 |
| Unsupported success note | 防止未知 CLI 因字段失败 | 少量认知偏差 | schema 可声明 capability | B | 可保留，但不能与“已应用”UI并存 |
| Delegation Card 人格标签 | 用户区分并行执行者 | 时间线不可审计 | 现有 agent label 只到 CLI | A | 改为显示 effective state |
| `invalid_persona` | 主 AI判断修名或重试 | 自动恢复策略不稳定 | 现有 `spawn_failed` 部分覆盖 | B | 统一契约后保留 |
| Persona 文件持久化进首轮消息 | 文档未给独立业务场景 | 不做不会损害 Kiro 原生能力 | 外部 CLI session 已负责人格 | D/隐式副作用 | 不应作为无说明的存储机制 |

```yaml
patch_plan:
  - issue_id: A1
    severity: P0
    target_file: requirements.md
    anchor: "### Requirement 3: Claude Code / Codex 走首轮 Preamble 注入(best-effort · 非真人格)"
    action: replace_section
    intent: 重新进行产品语义决策，将原生人格选择与提示词模拟拆开；未获明确接受前暂停 Claude/Codex 模拟路径
    rationale_short: wrapper 缺少原生入口是技术缺口，不能自动推导出用户需要文件读取式文本模拟
  - issue_id: A2
    severity: P1
    target_file: design.md
    anchor: "### 6. broker 翻译层"
    action: replace_section
    intent: 将供应商能力判断、文件格式解析和原生启动翻译收口到 provider capability或adapter，broker 只编排标准化结果
    rationale_short: 通用 broker 当前承担供应商配置解析并形成持续增长的条件分支中心
  - issue_id: A3
    severity: P1
    target_file: requirements.md
    anchor: "THE broker SHALL derive a per-call effect map"
    action: pattern_rewrite
    intent: 删除 effect map与runtime_env override map 契约，统一为类型化 LaunchOption，并限制环境变量翻译只发生在 production adapter 内
    rationale_short: requirements 仍要求已被 design 否决的无类型基础设施覆盖面
  - issue_id: A4
    severity: P1
    target_file: requirements.md
    anchor: "### Requirement 5: 前端 Delegation Card 显示所派人格"
    action: replace_section
    intent: 区分 requested persona 与 resolved/applied/ignored/failed 状态，禁止从 raw_input 直接渲染为已生效人格
    rationale_short: 当前卡片展示请求参数而非执行结果，unsupported CLI 也会形成假成功表象
  - issue_id: A5
    severity: P1
    target_file: requirements.md
    anchor: "**Persona SSOT (Single Source of Truth)**"
    action: replace_section
    intent: 明确各 CLI 冷恢复的 producer、持久化载体、consumer和保证等级，并加入 process-death e2e
    rationale_short: conversation replay 与 Kiro persona 保持均依赖未验证的隐含前提
  - issue_id: F1
    severity: P1
    target_file: requirements.md
    anchor: "Kiro / Claude / Codex 派人格失败"
    action: replace_section
    intent: 统一无效名称、人格不存在、文件错误与启动失败的错误码矩阵，删除统一 invalid_persona 与 Kiro spawn_failed 的矛盾表述
    rationale_short: 同一文档同时要求三家统一错误码并规定 Kiro 返回不同错误码
  - issue_id: F2
    severity: P1
    target_file: design.md
    anchor: "**Frontmatter 剥离**(替代原来的简单正则,支持 BOM/CRLF/未闭合/空 body):"
    action: replace_section
    intent: 将未闭合 frontmatter 定义为确定性格式错误，禁止把疑似元数据整体降级为 prompt 正文
    rationale_short: 当前宽容策略会注入本应被剥离的权限、模型和hook元数据
  - issue_id: F3
    severity: P1
    target_file: design.md
    anchor: "Claude/Codex persona 文件超 200 KiB"
    action: replace_section
    intent: 定义人格正文与任务组合后的 prompt 预算、超限错误和任务保留规则
    rationale_short: 文件字节上限不能保护模型上下文，且 broker 不能把自身组合造成的超限下推给模型
  - issue_id: F4
    severity: P1
    target_file: design.md
    anchor: "**Symlink safety (Requirement 3.3 + Requirement 8)**"
    action: replace_section
    intent: 分别明确 direct-child 判定、规范化后打开对象、竞态边界及带硬上限的文件读取方式
    rationale_short: starts_with与先metadata后读取不足以证明文档声明的路径和大小安全性质
```

## VERDICT
status: NEEDS_CHANGES
p0_count: 1
p1_count: 8
one_line: Kiro 原生透传可以保留，但 Claude/Codex 当前是在 broker 层用提示词模拟修补 wrapper 缺口，必须先拆分产品语义与领域边界再继续实现。
