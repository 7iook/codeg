> **[主 AI 下一步]** 读完本 review 修完 spec 后:若本轮已收敛(R3 或 APPROVED / p0=0)→ **调 `post-review-introspection` skill** 做「初稿→评审→最终稿」三阶段复盘,落 `introspection-<slug>.md`。仍需 R+1 → 修完 spec 再跑下轮。

---

# 第 3 轮评审结论

## 真实业务边界清单

| 场景 | 当前方案行为 | 评审判断 |
|---|---|---|
| 单用户、单进程、单个 CLI 账户 | 从进程 HOME 或 Kiro 启动配置选择人格 | 主要目标场景，边界基本明确 |
| 多租户 | 所有持有同一 `CODEG_TOKEN` 的调用方共享进程 HOME 下的人格池 | 明确不支持；投产前必须确认部署确为单主体 |
| 多账户/多配置目录 | Claude/Codex 固定取进程 HOME；Kiro 使用自身配置机制 | 是否符合实际 CLI 账户配置方式需实现方核实 |
| 多店铺、多业务实体 | 本功能没有店铺、订单或业务实体映射 | 不适用，不应为此新增租户或业务实体模型 |
| 多平台 | Kiro 原生；Claude/Codex 文本提示；其他 CLI 忽略 | 支持强度不同，不能宣称三家等价 |
| 多数据源 | Kiro 配置和 Claude/Codex Markdown 文件分别为来源 | 没有统一内容版本，不能追溯某次调用使用的文件版本 |
| 历史数据迁移 | 老记录没有 `applied_persona`，按无标签展示 | 可接受，但新增错误响应字段的兼容性未定义 |
| 并发请求 | `LaunchOption`、preamble 按调用局部持有 | 基础隔离合理；同名文件并发修改时结果可能不同 |
| 重复请求 | 每次重新解析并产生独立子会话 | 未定义去重，符合现有“一次调用一次委托”语义，不建议额外加幂等层 |
| 消息乱序 | 未定义 task report、最终 outcome 到达顺序下 UI 状态合并规则 | 需沿用并核实现有事件链路 |
| 超时、部分成功 | 可能出现进程已启动但首轮 prompt 发送失败 | 当前 `applied_persona` 的生成时机不足以准确表达结果 |
| 服务重启/冷恢复 | 不重新传人格，依赖各 wrapper 自行恢复 | 当前既没有持久化状态，也没有运行时检测，无法兑现恢复后的准确标签 |
| 外部 CLI 异常 | Kiro 归为 `spawn_failed`；resolver 错误归为 `invalid_persona` | 分类可用，但实际错误映射需核实 |
| 文件缺失、损坏、被修改 | 缺失/非法硬失败；每次重新读取 | 合理，但缺少内容版本或摘要，历史行为不可复现 |
| 人工修改与自动执行冲突 | 修改后的下一次 delegation 立即读取新内容 | 可接受；必须明确“按调用时快照生效”，不能暗示同名人格恒稳 |

## 业务现实判决表（反 Solution-Jumping）

| 新能力/字段/模块 | 真实场景 | 缺失影响 | 已有机制覆盖 | 分类与判决 |
|---|---|---|---|---|
| `subagent_type` | 主 AI 派 reviewer、debugger、executor 时点名既有人格 | 可能使用错误的默认人格 | panel 默认只能全局配置，不能表达逐次选择 | **A 刚需，立即保留** |
| `LaunchOption::KiroPersona` | 把逐次选择安全传至 Kiro 启动参数 | Kiro 无法逐次覆盖默认人格 | 无等价的类型化 per-call 通道 | **A 的必要内部机制，保留** |
| Claude/Codex resolver + preamble | 复用已有 Markdown 人格说明执行文本型角色 | 需要重复把人格正文写进每个 task | 普通 task 能携带文本，但不能自动复用既有文件 | **A，但仅限“文本提示复用”**；依赖权限、工具或模型的人格不属于本能力 |
| `PersonaCapability` / `PersonaEffect` | 隔离三家不同实现并给 broker 标准结果 | provider 分支会进入通用 broker | 直接 `match` 可实现，但会持续耦合 | **B 稳定性边界，当前规模下可保留最小枚举，不扩成服务** |
| `AppliedPersona::Native/Hint/Ignored` | 用户查看时间线时区分实际支持强度 | UI 可能把 unsupported 请求显示为已生效 | 原始输入只能说明 requested，不能说明 effect | **A/B，保留，但必须在真实 sink 后生成** |
| `AppliedPersona::Failed` 写入错误 outcome | 在失败卡片上重复表达人格失败 | 外层错误已经提供失败状态和 wire code | 已有错误状态基本覆盖 | **D 技术洁癖，不建议实现**，除非确认现有错误卡无法关联 requested persona |
| `invalid_persona` | 主 AI区分“修名”与“重试启动” | 自动恢复策略不稳定 | 通用 `spawn_failed` 无法区分输入错误 | **B，保留** |
| unsupported success note | 主 AI误把忽略当成功应用 | 认知错误 | schema 声明不能覆盖运行时选择 | **B，保留**；必须与 outcome 状态由同一结果生成 |
| UI 请求指标与生效标签 | 展示 requested 与 applied 的差异 | 排障时无法判断调用意图 | 原始输入已有 requested 数据 | **A，保留，避免再建第二份请求真源** |
| `<<PERSONA_LISTS>>` 动态占位符 | 文档未说明谁需要动态发现、谁生成、何时刷新 | 尚未证明真实用户损失 | 主 AI可从既有配置或显式名称调用 | **D/未论证，不建议实现**；删除占位符或另补真实发现需求 |

## 当前方案继续实施的风险

### A1｜P0｜架构级：冷恢复状态既不持久化也不可检测，却要求恢复后准确报告人格状态

- **定位锚点**：`**Persona SSOT (Single Source of Truth)**`
- **问题**：文档明确不保存 `subagent_type`，`spawn_for_resume` 也不接人格参数；但又要求恢复后在 wrapper 丢失人格时生成 `resume_dropped_persona` 或 `wrapper_dropped_first_turn_on_resume`。
- **问题根因**：把一次性 e2e 观察结果当成每次恢复时都可获得的运行时信号。进程重启后，系统没有明确的 requested persona 来源、内容版本或“wrapper 是否仍持有人格”的检测协议。
- **业务影响**：重启后的子会话可能已经丢失人格，UI 仍显示旧的 Native/Hint；也可能无法构造文档要求的 Failed 状态。
- **架构影响**：producer、持久化载体和恢复 consumer 之间缺一跳，严格按文档无法实现。
- **修改建议**：二选一：  
  1. 持久化最小人格描述符及保证等级，并定义恢复检测/重放；或  
  2. 明确 v1 的 `applied_persona` 只描述首次启动，恢复后状态为 unknown，不承诺自动判定丢失。  
  不建议仅靠测试结果把运行时状态写死。
- **优先级**：**P0**

### A2｜P1｜架构级：`applied_persona` 在解析阶段生成，早于真正的应用 sink

- **定位锚点**：`// 3. 将 effect 翻译为 spawner 入参 + applied_persona (R2 A4)`
- **问题**：代码骨架在调用 `spawn` 前生成 `Native`，在调用 `send_prompt_linked_for_delegation` 前生成 `Hint`。此时 Kiro 进程尚未成功启动，Claude/Codex prompt 也尚未被 wrapper 接受。
- **问题根因**：将“已解析/准备应用”当成“实际生效”。
- **业务影响**：spawn 成功但首轮发送超时、ACP 断开或进程立即退出时，卡片可能显示人格已生效。
- **架构影响**：outcome 字段不再是 outcome-level 真源，而是计划状态；与 Requirement 5 的定义冲突。
- **修改建议**：明确状态生成点：Native 至少在 Kiro 启动成功后产生；Hint 至少在带 preamble 的首轮 prompt 被发送链路接受后产生。超时、发送失败和进程启动失败必须复用外层任务失败状态，不提前标 applied。
- **优先级**：**P1**

### F1｜P1｜普通功能缺陷：未知 CLI 在进入 ignore 分支前会被名称校验或 HOME 解析阻断

- **定位锚点**：`// 1. 名称语法预校 (Requirement 3-name-grammar · 三家共用 · provider 之前先拦)`
- **问题**：骨架先对所有 `agent_type` 校验名称，随后无条件调用 `current_process_home_dir()`，最后才由 provider 返回 `Ignored`。
- **问题根因**：支持能力判断晚于仅受支持 provider 才需要的前置条件。
- **业务影响**：unsupported CLI 传入 `foo.bar`，或进程 HOME 缺失时，可能直接失败，违反“不支持 CLI 不因该字段失败”的核心负向条件。Kiro 本身不需要 Claude/Codex HOME，也可能被无关错误阻断。
- **架构影响**：Ignored 路径不再是真正零副作用，provider 隔离形同虚设。
- **修改建议**：先判 capability；只有 Kiro/Claude/Codex 执行名称校验，只有文件型 Hint provider 解析 HOME。unsupported 分支直接生成 Ignored，不访问文件系统或环境目录。
- **优先级**：**P1**

### F2｜P1｜普通契约缺陷：扩展错误 wire shape 未给兼容策略，且 `Failed` 状态缺少必要业务场景

- **定位锚点**：`DelegationOutcome::from_err 需新增重载`
- **问题**：设计要求扩展现有 Err 分支以携带 `applied_persona`，但 Requirement 6 只验证请求兼容，没有给旧客户端解析新 Err JSON 的兼容矩阵。同时，当前三家人格失败都会阻断 delegation，外层错误已能表达失败。
- **问题根因**：为了让 UI 显示 `Failed`，把展示需求下推成公共错误契约变化，没有先证明现有错误事件无法满足。
- **业务影响**：严格反序列化的旧客户端可能无法解析错误响应；失败信息出现两个来源后可能不一致。
- **架构影响**：增加第二个失败真源，并扩大本期 wire 变更面。
- **修改建议**：优先复用 requested indicator + 现有 outer error 渲染失败；只有经核实确实缺少关联信息时，才以向后兼容的 optional 字段扩展，并补旧客户端/新服务端及新客户端/旧服务端矩阵测试。
- **优先级**：**P1**

### P2 观察项

1. `Verified once by(五条...)` 实际列了六条，需机械修正。
2. `created: 2026-08-03` 晚于 `last_updated: 2026-08-02`，生命周期元数据矛盾。
3. `<<PERSONA_LISTS>>` 只在 design 数据模型中出现，没有生成者、刷新策略或对应 requirement，建议删除而非扩功能。
4. “打开 canonical path 即 TOCTOU-safe”表述过强；路径解析后目标仍可能被同一主机用户替换。当前单主体边界下不值得引入重型安全抽象，但应改为“降低 symlink 换链风险”，不要宣称完全消除竞态。
5. 200 KiB 只限制文件 IO，不限制模型 token、延迟和成本。该风险上一轮已讨论，本轮不重复要求新增预算模块，但上线监控必须能区分 prompt/context 超限与 persona 文件错误。

## 推荐的更优实现方向

### 本期必须实现

1. 保留 `subagent_type`、Kiro 类型化 `LaunchOption` 和三家明确不对称的能力声明。
2. 将 persona resolution 结果与 persona application 结果分开：resolver 只返回 Native/Hint/Ignored 的执行计划，最终 outcome 在实际 sink 后生成。
3. 先判断 provider capability，再执行名称、HOME 和文件校验，保证 unsupported 路径零副作用。
4. 对恢复契约作出明确取舍：持久化并检测，或诚实降级为首次启动状态；不能保留当前不可实现的自动 Failed 承诺。
5. 验证新增错误响应结构的双向兼容性；无明确必要时删除 `AppliedPersona::Failed` 和 Err payload 扩展。
6. 覆盖并发、首轮发送超时、子进程启动后立即退出、服务冷重启、persona 文件在两次调用间修改等生产场景。

### 可延后

- persona 内容 hash/version，用于历史审计和同名文件变更定位。
- Claude/Codex wrapper 原生 persona 支持。
- 多租户 persona owner/schema。
- 动态 persona 列表发现与热刷新。

### 不建议实现

- 任意 `BTreeMap<String,String>` per-call 环境覆盖。
- 独立 persona 微服务、事件总线或通用配置平台。
- 为读类 persona 查询额外增加幂等、状态机或限流。
- 未有业务论证的 `<<PERSONA_LISTS>>` 动态注入。
- 仅为重复表达外层错误而扩展 `AppliedPersona::Failed` 公共契约。

## 开工前代码核验清单

### 当前领域模型和数据库

- `DelegationOutcome::Err` 当前 wire JSON 形状是否允许新增 optional 字段而不破坏旧客户端？
- `DelegationSuccess`、`DelegationTaskReport` 是否都被持久化，还是仅作为瞬时事件发送？
- 冷恢复时是否仍能从 task、conversation 或事件记录定位原始 `subagent_type`？
- 老记录缺少 `applied_persona` 时，前端是否稳定按 legacy 路径展示？

### 现有接口、任务和事件链路

- `spawn` 返回成功是否仅代表进程创建成功，而不代表 ACP 初始化或首轮 prompt 成功？
- `send_prompt_linked_for_delegation` 是否提供可用于判定 prompt 已接受的成功结果？
- 子进程已启动但首轮发送失败时，现有逻辑是否关闭子进程并落任务失败？
- Task report、最终 outcome 和 WebSocket 事件是否可能乱序到达？
- UI 是否已有统一的 requested/running/failed 状态合并机制可复用？

### 数据来源及字段完整性

- Claude/Codex 人格目录是否恒定使用进程 HOME，还是还支持 CLI 专用配置目录？
- Windows 上 HOME 与 USERPROFILE 同时存在但不一致时，当前项目使用哪个为权威来源？
- Kiro 的实际人格根目录是否受 `KIRO_HOME` 影响，而不是进程 HOME？
- 人格文件是否可能由编辑器以临时文件替换方式更新？
- 文件读取后到 prompt 发送前，内容是否会被再次读取或转换？
- persona 名称是否在三家现有实现中都满足 `[A-Za-z0-9_-]{1,64}`？

### 账户、租户和业务实体映射

- 生产 `codeg-server` 是否确实是一枚 token 对应一个可信主体，而不是多人共享部署？
- 所有已认证 caller 是否都被允许探测并使用服务器 HOME 下的全部人格名称？
- 多个 CLI 账户或 profile 是否共享相同 HOME，人格文件是否可能选错账户配置？
- 桌面模式与服务器模式是否需要不同的人格根目录策略？

### 状态机、幂等和恢复

- 当前 delegation 是否已有 Requested、Spawned、PromptSent、Completed、Failed 等状态可复用？
- 重复调用同一参数是否按产品语义创建两个独立子会话？
- Kiro 冷恢复时是否由 session metadata 自动恢复 `--agent` 的效果？
- Claude/Codex wrapper 冷恢复时是否重放带 preamble 的首轮用户消息？
- 系统是否有可靠办法检测“恢复成功但人格已丢失”，而不是根据行为猜测？
- 首轮 prompt 超时后重试是否可能重复发送 persona 与 task？
- 服务重启后在途 delegation 是否会重复 spawn 或留下孤儿进程？

### 历史 Git、旧实现和废弃逻辑

- `ConnectionSpawner::spawn` 是否存在文档清单之外的实现或测试替身？
- 历史上是否曾有 persona、agent profile 或 per-call launch option 的废弃实现？
- `subagent-transcript` 是否曾被用于 persona selection，是否存在容易误复用的旧分支？
- 上游最近是否调整过 delegation tool schema、错误 wire shape或 resume 路径？

### 前后端类似能力

- 前端是否已有 outcome-level badge、错误标签和 tooltip/copy 组件可直接复用？
- 后端是否已有 provider capability 或 agent metadata 扩展点可承载 `PersonaEffect`？
- 是否已有安全的 bounded file reader、frontmatter stripper 或配置目录解析 helper？
- 是否已有动态 schema placeholder 机制负责替换 `<<PERSONA_LISTS>>`？
- 主 AI当前是否已经通过其它字段或系统提示获得可用 persona 名称？

### 测试、规模和性能

- 生产人格文件的 P50、P95、最大字节数与 token 数是否已取样？
- 200 KiB preamble 加 task 是否会超过三家 wrapper 的请求或模型上下文限制？
- 并发读取同一人格文件时是否有共享缓存或锁，是否需要直接保持无缓存？
- 单测是否覆盖 unsupported CLI + 非法名称 + HOME 缺失仍正常 ignore？
- 集成测试是否覆盖 spawn 成功但 prompt 发送失败？
- 兼容测试是否覆盖旧客户端解析新增成功与错误响应？
- process-death e2e 是否能精确终止本次测试创建的子进程，而不会误杀同名其他进程？
- 是否已有生产指标区分 persona 解析失败、spawn 失败、prompt 超时和 resume 丢失？

## 必须由产品/业务/技术负责人确认的问题

1. Claude/Codex 的成功定义是否明确限定为“复用 Markdown 文本提示”，而不承诺权限、模型、工具和 hook？
2. 恢复后是否必须保证人格仍然生效？若必须，是否接受持久化最小 persona 描述符；若不必须，UI 是否可以显示“首次启动已应用，恢复状态未知”？
3. 生产服务器是否严格禁止多主体共享同一 token 和 HOME？
4. 是否需要支持 CLI 专用配置目录或多账户 profile，而不是固定使用进程 HOME？
5. `AppliedPersona::Failed` 是否存在独立于现有错误卡片的真实用户价值，足以承担错误 wire 兼容成本？
6. persona 文件被修改后，同名 persona 的历史执行是否需要可审计、可复现？
7. 其他 CLI 收到非法 `subagent_type` 时，产品语义是否仍是无条件忽略？当前 Success State 指向“是”。

## 落地决定

**调整方案后开发**：Kiro 和文本型 Claude/Codex 路径可以启动实现，但必须先修正恢复状态不可实现、applied 状态生成过早、unsupported 前置校验以及错误 wire 兼容四项契约。

```yaml
patch_plan:
  - issue_id: A1
    severity: P0
    target_file: requirements.md
    anchor: "**Persona SSOT (Single Source of Truth)**"
    action: replace_section
    intent: 在持久化与运行时检测方案、或恢复后状态降级为unknown之间作出明确选择，删除无法观测却要求自动报告persona丢失的契约
    rationale_short: 当前不保存人格描述符也不重新提名，冷恢复后无法判断或构造准确的生效状态
  - issue_id: A2
    severity: P1
    target_file: design.md
    anchor: "// 3. 将 effect 翻译为 spawner 入参 + applied_persona (R2 A4)"
    action: replace_section
    intent: 将resolution计划与application结果分离，在进程启动和首轮prompt真实成功后再生成Native或Hint outcome
    rationale_short: 当前在最终sink之前标记applied会在spawn或发送失败时形成假成功
  - issue_id: F1
    severity: P1
    target_file: design.md
    anchor: "// 1. 名称语法预校 (Requirement 3-name-grammar · 三家共用 · provider 之前先拦)"
    action: replace_section
    intent: 先判provider capability，再仅对支持的CLI执行名称校验，并仅对文件型Hint路径解析HOME和读取文件
    rationale_short: 全局预校与无条件HOME解析会让unsupported或Kiro路径因无关条件失败
  - issue_id: F2
    severity: P1
    target_file: design.md
    anchor: "DelegationOutcome::from_err 需新增重载"
    action: replace_section
    intent: 先核实错误wire兼容性与现有错误卡能力，无独立业务必要时删除Failed状态和Err分支扩展
    rationale_short: 当前方案为重复展示失败而扩大公共错误契约，并缺少新旧客户端兼容矩阵
```

## VERDICT
status: NEEDS_CHANGES
p0_count: 1
p1_count: 3
one_line: 方案主体已接近可实施，但恢复状态不可观测及生效状态生成时机错误仍会在生产中制造假状态，需修正后开工。
