> **[主 AI 下一步]** 读完本 review 修完 spec 后:若本轮已收敛(R3 或 APPROVED / p0=0)→ **调 `post-review-introspection` skill** 做「初稿→评审→最终稿」三阶段复盘,落 `introspection-<slug>.md`。评审器只报问题 · 主 AI 才能复盘(sub 与评审器都拿不到主 AI 原始思考)。仍需 R+1 → 忽略本条 · 修完 spec 再跑下轮。

---

# 第 1 轮评审结论

## 一、架构级问题

### A1 · Kiro MCP 的安全模型存在两套互斥契约

- **定位锚点**：`Requirement 4 · MCP 配置接管`；`### W2 · MCP 三类型脱敏 + 门禁`
- **问题**：`requirements.md` 4.6/4.7 要求 Kiro 进入通用 MCP 面板，并明文展示、编辑 `env` 与 `args`；`background.md` 则要求 Kiro 脱离通用面板，使用 `Raw / QueryDto / Patch` 三类型、脱敏展示和 `Keep` 语义。`design.md` 的实施波次仍把 Kiro加入 `mcp-settings.tsx`，没有冻结唯一方案。
- **问题根因**：API key 的“本机明文可见”决策被错误推广到第三方 MCP 凭据；通用 CRUD 与专属配置面板的职责未分清。
- **业务影响**：可能泄露第三方 token，或把脱敏占位符写回配置、覆盖真实凭据。
- **架构影响**：同一配置同时受通用 CRUD 和专属读写函数控制，形成双入口、双契约和旁路。
- **修改建议**：冻结唯一 MCP 契约；明确 API key 与 MCP 第三方凭据是两个不同安全域。若采用背景文档方案，应明确 Kiro 从哪些通用扫描/绑定/删除入口排除，以及专属 DTO、三态 Patch、未知字段保真的责任边界。
- **优先级**：**P0**

### A2 · “单机单用户”边界与局域网运行能力没有形成一致的可执行信任模型

- **定位锚点**：`## Requirement 5 · MCP 写入门禁（局域网场景）`
- **问题**：当前需求只限制 HTTP 入口读写 MCP；但 `background.md` 要求同时保护 `read_servers / conversations / build_agent`，`design.md` 又将方案降级为仅位于 `commands/mcp.rs`。对于可绑定局域网的运行模式，会话读取、启动本机 Kiro 进程及其文件能力没有准入契约。
- **问题根因**：以“入口是桌面还是 HTTP”代替了调用者身份、部署信任级别和能力授权。
- **业务影响**：远程网页用户可能读取本机会话或触发本机进程；反之，过度封禁又可能使宣称支持的局域网场景不可用。
- **架构影响**：安全策略散落到功能函数，无法证明所有敏感能力都经过同一边界。
- **修改建议**：先定义部署模式与能力矩阵：谁可以浏览会话、启动 agent、读写 MCP、修改凭据；默认拒绝哪些能力，显式开启后由什么身份授权。策略应在共享应用服务边界统一执行，而不只保护一个文件写入口。
- **优先级**：**P0**

### A3 · 架构以文件、枚举和 UI 挂载点为中心，缺少最小领域边界

- **定位锚点**：`## 架构`
- **问题**：设计主要罗列 match、文件和行号，没有说明 Agent Catalog、Agent Runtime、Conversation Import、MCP Configuration、Credential Settings 各自的职责及依赖方向。
- **问题根因**：从现有代码扩展点直接推导架构，未先建立集成领域的稳定概念。
- **业务影响**：连接、会话浏览、配置管理任一变化都可能牵连多个超大文件；错误归属和用户反馈难以保持一致。
- **架构影响**：Kiro 外部 JSON、CLI 参数和文件路径容易直接泄漏到核心编排层，缺少反腐层。
- **修改建议**：补充轻量限界上下文和依赖图，不必引入复杂 DDD 框架。至少定义 Kiro adapter 负责外部格式转换，Runtime 负责启动生命周期，Conversation Import 只读解析，MCP Configuration 负责配置 revision/写入，Credential Settings 负责启动环境策略。
- **优先级**：**P1**

### A4 · MCP 写入缺少并发、一致性和崩溃恢复契约

- **定位锚点**：`4.8 THE 系统 SHALL 在写入前校验目标文件可解析`
- **问题**：当前设计只有“写前 JSON 可解析”和“门禁必须前置”，未规定读取后外部文件发生变化时如何处理，也未规定临时文件、原子替换和写失败恢复。`background.md` 已提出内容 revision CAS，但核心需求和设计未采纳。
- **问题根因**：把单次函数调用的保真误当成完整文件一致性。
- **业务影响**：Kiro CLI、用户和 codeg 并发修改时可能丢更新；进程中断可能留下截断配置。
- **架构影响**：P-2 无法覆盖真实读—改—写竞态，配置文件缺少明确的一致性边界。
- **修改建议**：明确内容 revision/CAS 冲突语义、同目录临时文件加原子替换、冲突时不覆盖并返回可操作错误；定义哪些字段允许局部合并。
- **优先级**：**P1**

### A5 · 已识别大量静默注册点，却仍只依赖人工清单

- **定位锚点**：`### 注册点：编译强制 vs 静默降级`
- **问题**：文档列出了多处不会触发编译错误的手写列表，但完成条件仍以逐项修改和 grep 数量为主。
- **问题根因**：Agent 元数据没有单一权威注册源，完整性约束也没有自动化表达。
- **业务影响**：Kiro 可能局部可用、局部不可见，例如能连接但不能委派或不能管理 MCP。
- **架构影响**：每增加一个 agent 都重复承担相同的 shotgun-change 风险。
- **修改建议**：本次至少定义跨后端注册表、前端集合、MCP app 和委派 schema 的一致性测试；长期注册表重构可另立任务，不必阻塞本次接入。
- **优先级**：**P1**

### A6 · ADR 准入结论自相矛盾

- **定位锚点**：`## ADR admission`
- **问题**：`design.md` 判定 `needed: no`，而 `background.md` 的 W4 与 checklist 明确要求为 `SystemBinary` 建 ADR。
- **问题根因**：重建背景与当前设计没有完成裁决收口。
- **业务影响**：执行者无法判断 ADR 是交付门槛还是禁止新增的冗余工作。
- **架构影响**：通用分布类型这一跨 agent 概念缺少唯一决策记录。
- **修改建议**：明确裁决为“需要”或“不需要”，并同步所有文档；不要保留互斥指令。
- **优先级**：**P1**

## 二、普通功能与验收问题

### F1 · 会话轮次边界遗漏 `Prompt`，可能跨轮错误配对工具结果

- **定位锚点**：`3.4 WHEN 遇到 kind == "Clear"`
- **问题**：requirements/design 只把 `Clear` 定义为轮次边界；`background.md` 明确指出 `Prompt` 同样是边界，否则 toolResult 可能被跨轮移动。
- **问题根因**：把清空上下文事件与用户轮次起点混为同一种分段机制。
- **业务影响**：历史会话会把工具结果归给错误的工具调用或用户轮次，展示内容失真。
- **架构影响**：解析器产出的内部会话模型破坏“工具结果只属于同轮调用”的不变式。
- **修改建议**：冻结轮次状态机，明确 `Prompt`、`Clear`、`Compaction` 的不同状态作用，并把 toolUse/toolResult 同轮配对写成可测试不变式。
- **优先级**：**P0**

### F2 · 未知事件策略互相矛盾，P-1 的计数性质也不成立

- **定位锚点**：`3.6 IF 某一行不是合法 JSON 或 kind 取值未知`
- **问题**：requirements/design 要跳过未知 `kind`，`background.md` 要保留占位；同时 P-1 假设“一条合法已知行等于一条消息”，但一行可含多个 content 项，`Clear` 也未必生成消息。
- **问题根因**：混淆物理 JSONL 行、领域事件和最终渲染消息。
- **业务影响**：升级后新事件可能静默消失；错误的性质测试可能恒绿或误报。
- **架构影响**：解析器没有明确的输入事件到领域事件映射契约。
- **修改建议**：统一未知事件策略；将性质改为按领域事件映射、顺序保持、行级故障隔离和不崩溃验证，而不是按行数断言消息数。
- **优先级**：**P1**

### F3 · 900+ 会话场景缺少资源预算和错误三态验收

- **定位锚点**：`## Requirement 3 · CLI 会话浏览`
- **问题**：核心需求没有限制单文件字节数、事件数、解析期限、Compaction 渲染长度，也没有区分元数据文件缺失、空文件和损坏文件；这些约束只零散存在于 background。
- **问题根因**：把样本可解析等同于生产规模可浏览。
- **业务影响**：13.4MB 会话、超长快照或正在写入的尾部半行可能造成卡顿、误报损坏或内存放大。
- **架构影响**：解析器和列表查询没有明确的资源边界及降级协议。
- **修改建议**：把字节/事件/deadline、截断标记、有界标题回退、尾部半行暂态、缺失/空/损坏三态提升为正式验收标准。
- **优先级**：**P1**

### F4 · “可被委派”属于目标产物，却没有需求和验收标准

- **定位锚点**：`D4 委派沿用泛型 broker`
- **问题**：background 将“能被委派”列为目标，design 只提一个未复核的前端登记点，requirements 完全没有对应 Requirement。
- **问题根因**：把“复用泛型 broker”误当成端到端能力已成立。
- **业务影响**：最终可能只能人工选择 Kiro，委派列表、启动、状态回传或取消链路仍不可用。
- **架构影响**：关键链路没有可追踪的入口—编排—启动—结果契约。
- **修改建议**：增加委派成功、不可用、启动失败、取消/终止及结果回传的最小验收；既有 broker 内部细节无需重复设计。
- **优先级**：**P1**

### F5 · 模型选择器没有模型来源、失败与缓存契约

- **定位锚点**：`6.1 THE 系统 SHALL 在 Kiro 的设置面板中提供模型选择`
- **问题**：需求只要求“提供模型选择”，没有说明列表来自固定值还是 CLI；背景要求按钮触发 `--list-models`、15 秒超时及仅缓存成功结果，但范围又笼统排除了 `kiro-cli` 子命令输出解析。
- **问题根因**：UI 能力与数据来源契约脱节。
- **业务影响**：实现方可能硬编码易过期列表，或自动调用导致未登录时设置页阻塞。
- **架构影响**：模型目录的缓存、错误映射和认证依赖没有归属。
- **修改建议**：明确模型来源、手动触发、超时、缓存、空结果和解析失败行为，并收窄“子命令输出不作为数据通路”的例外范围。
- **优先级**：**P1**

### F6 · API key 用户故事与实际认证优先级之间缺少可验证结果

- **定位锚点**：`## Requirement 7 · API key 认证`
- **问题**：用户故事承诺用 API key 避免浏览器登录，但文档同时说明已有登录态优先；当前验收仅要求显示静态说明，design 又明确放弃 whoami 检测。
- **问题根因**：没有定义“配置了 key 但实际未生效”是否属于成功。
- **业务影响**：用户可能认为正在使用 API key，实际仍使用浏览器登录身份，出现账户或计费预期偏差。
- **架构影响**：设置状态与运行时实际认证状态可能长期分离。
- **修改建议**：明确产品承诺：仅提示优先级，还是必须检测实际认证来源；若不检测，应调整用户故事和验收口径，避免声称可保证切换。
- **优先级**：**P1**

### F7 · 自定义 agent 只扫描文件名，缺少有效性与失败反馈

- **定位锚点**：`6.5 THE 系统 SHALL 扫描 ~/.kiro/agents/ 下的 *.json`
- **问题**：术语定义了 JSON 内的 `name/description/...`，验收却仅按文件名列出，没有规定损坏 JSON、缺少 name、重复名称、不可读文件或所选文件被删除时的行为。
- **问题根因**：把文件发现当成了有效领域对象发现。
- **业务影响**：用户可能选择一个必然启动失败的 agent，且无法判断失败来源。
- **架构影响**：外部文件格式未经 adapter 校验便进入启动参数。
- **修改建议**：定义最小 AgentDescriptor、稳定选择标识、无效项处理和启动前再验证；无需为未来格式构建复杂 schema。
- **优先级**：**P1**

### F8 · `.kiro` 整根写权限没有区分进程原生访问与 ACP 文件操作授权

- **定位锚点**：`## Requirement 8 · 文件系统写权限`
- **问题**：需求直接允许 ACP 请求写整个 `.kiro`，其中同时可能包含会话、agent 定义、MCP 凭据和设置；未说明这是 Kiro 进程自身访问，还是向模型暴露的宿主文件工具权限。
- **问题根因**：进程运行所需目录权限与 ACP 工具授权被合并。
- **业务影响**：若是模型可调用的文件操作，授权面可能显著超过“维护会话与设置”的业务目的。
- **架构影响**：文件系统安全边界不清，无法设计可靠负例测试。
- **修改建议**：明确调用主体和允许操作；若属于 ACP 宿主文件能力，按必要子路径/操作定义边界，并覆盖路径穿越、符号链接和重定位后的根目录约束。具体既有机制需实现方核实。
- **优先级**：**P1**

### F9 · 以“已知 8 个失败之外全绿”作为验收不可稳定判定

- **定位锚点**：`## 验证基线（executor 必读）`
- **问题**：验收允许测试套件保持红色，仅按失败数量判断；新的回归可能替换某个旧失败而总数仍为 8。
- **问题根因**：把历史环境缺陷数量当成测试身份。
- **业务影响**：新增回归可能被误认为基线噪声。
- **架构影响**：交付门禁不具备可证伪性。
- **修改建议**：固定允许失败的测试标识和错误指纹，或先修复/隔离基线失败；至少要求新增及相关模块测试全绿，并比较失败集合而非数量。
- **优先级**：**P1**

```yaml
patch_plan:
  - issue_id: A1
    severity: P0
    target_file: requirements.md
    anchor: "## Requirement 4 · MCP 配置接管"
    action: replace_section
    intent: 冻结 Kiro MCP 的唯一安全与编辑契约，区分 API key 明文策略和第三方 MCP 凭据策略
    rationale_short: 通用明文 CRUD 与专属脱敏 Patch 方案互斥
  - issue_id: A2
    severity: P0
    target_file: requirements.md
    anchor: "## Requirement 5 · MCP 写入门禁（局域网场景）"
    action: replace_section
    intent: 定义部署模式、调用者和敏感能力矩阵，覆盖会话读取、agent 启动及 MCP 读写
    rationale_short: 仅按 HTTP 入口封禁 MCP 不能形成完整信任边界
  - issue_id: A3
    severity: P1
    target_file: design.md
    anchor: "## 架构"
    action: append_after
    intent: 补充 Agent Runtime、Conversation Import、MCP Configuration、Credential Settings 的职责和依赖方向
    rationale_short: 当前设计由文件与 match 驱动，缺少稳定领域边界
  - issue_id: A4
    severity: P1
    target_file: requirements.md
    anchor: "4.8 THE 系统 SHALL 在写入前校验目标文件可解析"
    action: append_after
    intent: 增加内容 revision 冲突检测、原子替换、失败恢复和局部合并规则
    rationale_short: 写前可解析不能防止并发丢更新或截断文件
  - issue_id: A5
    severity: P1
    target_file: design.md
    anchor: "### 注册点：编译强制 vs 静默降级"
    action: append_after
    intent: 定义跨注册表、前端集合、MCP app 和委派 schema 的自动一致性门禁
    rationale_short: 手工清单无法防止已识别的静默漏注册
  - issue_id: A6
    severity: P1
    target_file: design.md
    anchor: "## ADR admission"
    action: replace_section
    intent: 对 SystemBinary 是否需要 ADR 作出唯一裁决并同步背景文档
    rationale_short: 当前文档同时要求和否定 ADR
  - issue_id: F1
    severity: P0
    target_file: requirements.md
    anchor: "3.4 WHEN 遇到 `kind == \"Clear\"`"
    action: replace_section
    intent: 冻结 Prompt、Clear、Compaction 的轮次状态语义和 toolUse/toolResult 同轮不变式
    rationale_short: 遗漏 Prompt 边界会造成跨轮工具结果错误配对
  - issue_id: F2
    severity: P1
    target_file: requirements.md
    anchor: "**P-1 · 会话解析的行级隔离**"
    action: replace_section
    intent: 统一未知事件策略，并按领域事件映射、顺序和故障隔离定义性质
    rationale_short: JSONL 行数不等于渲染消息数
  - issue_id: F3
    severity: P1
    target_file: requirements.md
    anchor: "## Requirement 3 · CLI 会话浏览"
    action: append_after
    intent: 增加字节、事件、时间和渲染长度预算以及缺失空损坏暂态语义
    rationale_short: 现有验收未覆盖大文件和正在写入的真实会话
  - issue_id: F4
    severity: P1
    target_file: requirements.md
    anchor: "## Correctness Properties"
    action: insert_before
    intent: 增加 Kiro 委派的启动、状态、失败、取消和结果回传验收
    rationale_short: 目标包含可委派能力但需求完全不可追踪
  - issue_id: F5
    severity: P1
    target_file: requirements.md
    anchor: "6.1 THE 系统 SHALL 在 Kiro 的设置面板中提供模型选择"
    action: append_after
    intent: 明确模型列表来源、手动触发、超时、缓存和失败行为
    rationale_short: 选择器缺少数据来源与可用性契约
  - issue_id: F6
    severity: P1
    target_file: requirements.md
    anchor: "## Requirement 7 · API key 认证"
    action: replace_section
    intent: 明确 API key 配置与实际认证来源之间的产品承诺及可测试结果
    rationale_short: 静态提示无法证明 API key 实际生效
  - issue_id: F7
    severity: P1
    target_file: requirements.md
    anchor: "6.5 THE 系统 SHALL 扫描 `~/.kiro/agents/`"
    action: append_after
    intent: 定义自定义 agent 的最小有效性、稳定标识和失效反馈
    rationale_short: 文件存在不等于可启动的 agent
  - issue_id: F8
    severity: P1
    target_file: requirements.md
    anchor: "## Requirement 8 · 文件系统写权限"
    action: replace_section
    intent: 区分 Kiro 进程原生文件访问与 ACP 文件工具授权，并限定主体、路径和操作
    rationale_short: 整个 .kiro 根写权限的安全主体不明确
  - issue_id: F9
    severity: P1
    target_file: requirements.md
    anchor: "## 验证基线（executor 必读）"
    action: replace_section
    intent: 以失败测试标识和错误指纹冻结基线，并要求相关新增测试全绿
    rationale_short: 仅比较失败数量会掩盖等量的新回归
```

## VERDICT
status: NEEDS_CHANGES
p0_count: 3
p1_count: 12
one_line: MCP 安全契约、局域网信任边界和会话轮次模型存在阻塞性冲突，需先统一核心契约再实施。
