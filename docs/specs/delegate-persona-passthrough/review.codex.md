> **[主 AI 下一步]** 读完本 review 修完 spec 后:若本轮已收敛(R3 或 APPROVED / p0=0)→ **调 `post-review-introspection` skill** 做「初稿→评审→最终稿」三阶段复盘,落 `introspection-<slug>.md`。仍需 R+1 → 修完 spec 再跑下轮。

---

# 第 1 轮评审结论

整体方向回应了“按人格委托子任务”的真实需求，但当前 spec 存在三个阻塞性问题：Claude/Codex 的降级语义尚未获得可信产品授权、服务器/多租户下的人格文件访问没有安全边界、resume 契约与数据模型直接矛盾。当前不宜进入实现。

## 一、架构级问题

### A1｜Claude/Codex 的“人格透传”与成功状态不等价

- **定位锚点**：`Claude Code / Codex 的 wrapper`
- **问题**：需求声称子智能体会“以指定人格运行”，实际设计只是把 markdown body 拼进普通首轮 `task`；权限、工具白名单、模型、hook 等人格元数据全部丢失，也没有 system/developer 级指令优先级。
- **问题根因**：把“文本被拼入 prompt”当成“人格被选择”的可替代实现，混淆了 transport 成功与业务结果成功。设计称用户“明确接受”，但括号中的“declined 时按此决策自定”与此矛盾；requirements 的用户原话也只证明用户需要自定义人格，没有证明接受语义降级。
- **业务影响**：`executor`、`reviewer` 等依赖工具权限或行为约束的人格可能表现错误，界面却仍显示已经选择该人格，形成误导。
- **架构影响**：同一个 `subagent_type` 对 Kiro 表示原生人格，对 Claude/Codex 表示普通用户消息，契约语义随供应商改变。
- **修改建议**：
  1. 先补充可信的产品决策来源，确认用户是否接受“仅提示词模拟”。
  2. 若接受，wire contract、UI 和验收标准都应明确为 `persona_hint`/best-effort 语义，不能声称等价于原生人格。
  3. 若不能接受，v1 应只承诺 Kiro 原生能力，Claude/Codex 保持明确的 unsupported 状态，等待 wrapper 提供原生通道。
- **业务分类**：Kiro 原生透传为 **A 业务刚需**；Claude/Codex preamble 目前是对刚需的降级实现，但缺少产品授权，不能据此判定业务验收成立。
- **优先级**：**P0**

### A2｜缺少服务器模式、多租户和权限隔离边界

- **定位锚点**：`Persona resolver 新模块`
- **问题**：任意能调用 delegation 的主体都可按名称读取进程账户 home 下的人格文件；spec 未定义调用者是否有权使用该人格、人格属于哪个租户/工作区/账户，也未限制服务端是否允许读取 service account 的全局人格目录。
- **问题根因**：将桌面单用户假设直接扩展到同时支持服务器部署的架构，没有建立“请求主体 → persona 所有者 → 文件根目录”的授权关系。
- **业务影响**：不同用户或租户可能调用彼此的人格；人格正文还会被写入子会话，可能间接暴露内部指令或敏感配置内容。
- **架构影响**：领域请求只携带自由字符串 `name`，缺少 persona identity、ownership 和 authorization policy，后续无法可靠演进到多账户。
- **修改建议**：
  1. 明确 v1 支持边界：仅桌面单用户，还是服务器模式也支持。
  2. 若支持服务器模式，必须定义 persona 所属账户/租户、授权检查、租户化根目录和错误脱敏。
  3. 若暂不支持，应在 schema 和运行时明确拒绝，而不是隐式读取服务账户 home。
- **业务分类**：**B 稳定性与安全保护**。
- **优先级**：**P0**

### A3｜resume 契约与数据模型互相否定，缺少 SSOT

- **定位锚点**：`WHEN spawn_for_resume is invoked`
- **问题**：Requirement 7.3 要求 resume 重新应用相同 `subagent_type`，但 design 明确规定不入 DB，并承认 `spawn_for_resume` 拿不到原值；“Kiro 自己会保存”“Claude/Codex 不需要重放”没有形成统一且可验证的契约。
- **问题根因**：没有明确人格选择的生命周期和单一真源：究竟属于 delegation request、child conversation metadata、CLI session metadata，还是仅属于首轮 prompt。
- **业务影响**：进程崩溃、应用重启或会话恢复后，人格可能丢失、变回默认值，或不同 CLI 表现不一致。
- **架构影响**：trait 被扩展了 resume 参数，但上游没有可靠 producer；属于接口存在而数据链路断裂。
- **修改建议**：
  1. 先定义 persona selection 的生命周期和权威存储。
  2. 分别明确 Kiro 原生 session、Claude/Codex captured preamble 在冷恢复时的行为。
  3. 若 resume 不需要重放，应删除 R7.3 和无来源的 `spawn_for_resume` override；若需要，则必须定义持久化字段、写入时点、读取链路和兼容迁移。
- **优先级**：**P0**

### A4｜通用环境变量 Map 是超出业务需求的基础设施泄漏

- **定位锚点**：`per-call runtime_env 覆盖`
- **问题**：为一个 Kiro 人格参数，把任意 `BTreeMap<String,String>` 暴露到通用 `ConnectionSpawner` 和 resume 接口；“未来给别的 CLI 使用”不是当前业务场景。
- **问题根因**：Solution-Jumping：把“代码缺少通用 launch override 扩展点”误当成本次业务需求。
- **业务影响**：无直接用户价值，却扩大了错误覆盖密钥、代理、认证或其它进程环境的风险。
- **架构影响**：领域层通过无类型字符串 Map 控制基础设施，约束仅靠注释，破坏封装和可审计性。
- **修改建议**：改用最小、类型化的 launch selection，例如 persona/agent launch option，由 CLI adapter 翻译成 `KIRO_AGENT` 或 argv；除非补出独立真实场景，否则不要引入任意 env override。
- **业务分类**：当前表述属于 **D 技术洁癖/预留扩展点**，建议不做。
- **优先级**：**P1**

### A5｜Persona 文件解析器的边界与约束自相矛盾

- **定位锚点**：`Persona resolver 路径注入拒绝`
- **问题**：
  - 名称允许 `.`，但同时禁止 `..`；Property 6 仅检查是否超出字符集，无法拒绝 `..`。
  - “canonical path 不得越界”与简单字符正则不是同一保证，未定义符号链接、junction、检查后替换等情况。
  - 路径固定为 `user_home`，未说明自定义 home、portable 配置或多账户 profile 如何解析。
- **问题根因**：把词法校验、文件系统边界和账户配置解析混为一个正则规则。
- **业务影响**：合法 persona 可能找不到；恶意或错误配置可能越过预期目录；不同安装模式行为不一致。
- **架构影响**：resolver 同时承担名称校验、账户目录定位、文件读取和格式解析，缺少明确 adapter 契约。
- **修改建议**：分别定义 persona name grammar、配置根目录来源、规范化后的 containment 校验、符号链接政策和安全读取次序；账户根目录事实需实现方核实。
- **优先级**：**P1**

## 二、普通功能与验收问题

### F1｜人格错误码定义直接冲突

- **定位锚点**：`IF the persona file is missing`
- **问题**：requirements 要求 `invalid_working_dir`-family，design 则新增稳定码 `invalid_persona`；Kiro 缺失又返回 `spawn_failed`。
- **问题根因**：错误领域尚未统一：persona 输入错误、文件系统错误和进程启动错误被不同章节各自分类。
- **业务影响**：主 AI 无法稳定判断应修改人格名、修改工作目录还是重试启动。
- **架构影响**：同一用户错误随 CLI 返回不同机器码，阻碍统一重试和观测。
- **修改建议**：确定统一的错误分类矩阵，至少区分无效名称、无权限、文件不存在、文件格式错误、启动失败；同步 requirements、design、测试及 tool result。
- **优先级**：**P1**

### F2｜200 KiB 文件上限没有对应模型上下文和成本预算

- **定位锚点**：`exceeds a 200 KiB size cap`
- **问题**：字节上限不能保证 prompt 可被下游模型接受；也未定义人格正文为空、只有 frontmatter、正文加 task 后超上下文时的行为。
- **问题根因**：限制依据是文件 IO，而真实业务约束是模型上下文、请求成本和任务可用空间。
- **业务影响**：合法文件仍可能导致上下文溢出、截断实际任务、显著增加延迟与成本。
- **架构影响**：broker 在不知道下游上下文预算的情况下直接组装最终 prompt。
- **修改建议**：说明 200 KiB 的依据，并增加组合后预算策略；定义空正文及预算超限的稳定错误，避免静默截断。
- **业务分类**：**B 稳定性保护**。
- **优先级**：**P1**

### F3｜YAML frontmatter 剥离规则过窄且缺少验收边界

- **定位锚点**：`frontmatter 提取用简单正则`
- **问题**：规则只描述 LF 格式，没有覆盖 BOM、CRLF、未闭合 frontmatter、空 body；也没有说明 `---` 在正文中的处理。
- **问题根因**：用正则实现格式解析，却没有先定义接受的文件语法。
- **业务影响**：Windows 创建的人格文件可能无法正确剥离，导致 YAML 元数据被注入 prompt 或正文被错误截断。
- **架构影响**：同一 persona 文件在原 CLI 与 codeg fallback 中可能产生不同语义。
- **修改建议**：先定义最小可接受语法和异常行为，再据此补 CRLF/BOM/未闭合/空 body 测试；是否复用现有 parser 需实现方核实。
- **优先级**：**P1**

### F4｜前端显示防护没有限制合法字符组成的超长输入

- **定位锚点**：`IF subagent_type contains characters outside`
- **问题**：只在遇到非法字符时截断；全部由合法字符组成的超长字符串不会被限制。“never inject layout”因此不可由现有验收条件保证。
- **问题根因**：将字符安全与布局长度混为同一个 allowlist。
- **业务影响**：时间线卡片可能溢出、挤压或降低大规模并行委托的可扫描性。
- **架构影响**：后端名称长度、wire 长度与 UI 展示长度没有统一边界。
- **修改建议**：分别规定请求名称最大长度、展示最大 grapheme 数和完整值的可访问方式；不要以“首个非法字符截断”代替长度控制。
- **优先级**：**P1**

### F5｜验收链路没有覆盖三家目标及关键失败恢复

- **定位锚点**：`Verified once by`
- **问题**：手工 e2e 只覆盖 Kiro 和 Claude，没有覆盖 Codex、unsupported CLI note、persona 不存在、并发隔离和冷 resume；但这些都属于成功状态或核心 requirements。
- **问题根因**：测试策略主要验证内部派生 Map 和 MockSpawner 参数，没有完整验证最终 sink。
- **业务影响**：单测通过后仍可能出现 Codex 未注入、note 未返回、恢复丢人格等用户可见失败。
- **架构影响**：producer 到最终 child process/session 的链路缺少闭环证据。
- **修改建议**：建立 requirement-to-test 追踪表，并补最小真实链路矩阵：三家成功、unsupported 降级、无效 persona、并发和冷恢复；无法自动化的项目明确手工步骤与观测点。
- **优先级**：**P1**

### F6｜文档生命周期元数据内部不一致

- **定位锚点**：`review_rounds_done: 1`
- **问题**：frontmatter 写明已完成一轮且已有 `NEEDS_CHANGES/P0=2`，Update Log 却称“待跑 R1”；`last_updated` 还早于 `created`。
- **问题根因**：生命周期字段与实际评审事件未由同一流程更新。
- **业务影响**：后续工具和修订者无法判断这是首次评审还是上一轮遗留结果。
- **架构影响**：不影响运行时架构，但削弱 spec 审计与自动化收敛判断。
- **修改建议**：按真实历史统一创建日期、最近更新时间、已完成轮次和上一轮结论。
- **优先级**：**P2**

## 三、业务现实校验汇总

| 新能力 | 真实场景与缺失影响 | 现有覆盖 | 分类 | 结论 |
|---|---|---|---|---|
| `subagent_type` | 主 AI 并行派发 reviewer/executor 等不同职责；缺失会导致选错工作方式 | 仅能选择 CLI，未覆盖人格 | A | 应做 |
| Kiro `--agent` 映射 | 原生加载人格；缺失时只能使用默认人格 | panel 默认不能表达每次调用选择 | A | 应做 |
| Claude/Codex preamble | 尝试模拟人格；缺失影响取决于用户是否接受降级 | 普通 task 已能携带文字指令 | 待确认 | 需先完成 A1 产品决策 |
| unsupported CLI note | 防止调用者误判人格已生效 | 无明确现有反馈机制 | B | 可做，但必须保持“不生效”可见 |
| Delegation Card 标签 | 用户区分并行人格 | 普通 agent label 无法区分同 CLI 多人格 | A | 应做 |
| 通用 `per_call_env_overrides` | 文档只给未来扩展理由 | 可由类型化 Kiro launch option 完成 | D | 删除或收窄 |
| Persona resolver | 支撑 Claude/Codex 降级方案 | 原 CLI 原生加载不适用于当前 wrapper | B/待确认 | 取决于 A1，并须补 A2/A5 边界 |
| `invalid_persona` | 让主 AI区分输入错误和启动失败 | 当前错误码是否可扩展需实现方核实 | B | 应统一后再做 |

```yaml
patch_plan:
  - issue_id: A1
    severity: P0
    target_file: design.md
    anchor: "Claude Code / Codex 的 wrapper"
    action: replace_section
    intent: 重新界定原生人格与首轮提示词模拟的产品语义，并补充用户接受降级方案的可信来源或收窄支持范围
    rationale_short: 文本拼接不等价于人格选择，当前接受结论与文档证据矛盾
  - issue_id: A2
    severity: P0
    target_file: design.md
    anchor: "### 4. Persona resolver 新模块 `delegation/persona.rs`"
    action: append_after
    intent: 明确桌面与服务器模式的人格所有权、租户隔离、授权检查、目录根和错误脱敏边界
    rationale_short: 当前可按名称读取服务进程账户的人格文件，缺少多租户信任边界
  - issue_id: A3
    severity: P0
    target_file: requirements.md
    anchor: "WHEN `spawn_for_resume` is invoked"
    action: replace_section
    intent: 统一人格选择的生命周期和单一真源，并使冷恢复要求与持久化及读取链路一致
    rationale_short: 要求恢复时重放人格，但设计明确不存储且恢复入口拿不到原值
  - issue_id: A4
    severity: P1
    target_file: design.md
    anchor: "**per-call `runtime_env` 覆盖**"
    action: replace_section
    intent: 将任意环境变量 Map 收窄为满足本次人格选择需求的类型化 CLI launch option
    rationale_short: 通用环境覆盖没有独立业务场景并扩大基础设施控制面
  - issue_id: A5
    severity: P1
    target_file: design.md
    anchor: "### Property 6: Persona resolver 路径注入拒绝"
    action: replace_section
    intent: 分离并明确名称语法、配置根来源、规范化 containment、符号链接政策和安全读取顺序
    rationale_short: 允许点字符却要求拒绝双点，字符正则也不能证明规范路径未越界
  - issue_id: F1
    severity: P1
    target_file: requirements.md
    anchor: "IF the persona file is missing OR is not valid UTF-8 OR exceeds a 200 KiB size cap"
    action: replace_section
    intent: 统一 persona 输入错误、文件错误和进程启动错误的稳定 wire code 及重试语义
    rationale_short: requirements 的 invalid_working_dir-family 与 design 的 invalid_persona 直接冲突
  - issue_id: F2
    severity: P1
    target_file: requirements.md
    anchor: "exceeds a 200 KiB size cap"
    action: append_after
    intent: 补充人格正文与任务组合后的上下文预算、空正文和超限处理契约
    rationale_short: 文件字节上限不能保证下游模型上下文、延迟和成本可接受
  - issue_id: F3
    severity: P1
    target_file: design.md
    anchor: "frontmatter 提取用简单正则"
    action: replace_section
    intent: 定义可接受的 frontmatter 语法及 BOM、CRLF、未闭合和空 body 的处理与测试
    rationale_short: 当前正则规则不能稳定覆盖 Windows 人格文件和异常格式
  - issue_id: F4
    severity: P1
    target_file: requirements.md
    anchor: "IF `subagent_type` contains characters outside a safe display allowlist"
    action: replace_section
    intent: 分别规定请求名称长度、UI grapheme 截断和完整值展示策略
    rationale_short: 合法字符组成的超长名称不会触发现有截断，无法保证布局安全
  - issue_id: F5
    severity: P1
    target_file: requirements.md
    anchor: "Verified once by:"
    action: replace_section
    intent: 扩充真实链路验收矩阵以覆盖三家成功、unsupported 降级、无效人格、并发和冷恢复
    rationale_short: 当前只手工验证 Kiro 与 Claude，未覆盖多个核心需求及最终 sink
```

## VERDICT
status: NEEDS_CHANGES
p0_count: 3
p1_count: 7
one_line: 人格透传方向有真实价值，但降级语义、租户安全边界和恢复期 SSOT 尚未成立，需先修正架构契约再进入实现。
