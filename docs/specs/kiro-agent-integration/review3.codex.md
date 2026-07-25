> **[主 AI 下一步]** 读完本 review 修完 spec 后:若本轮已收敛(R3 或 APPROVED / p0=0)→ **调 `post-review-introspection` skill** 做「初稿→评审→最终稿」三阶段复盘,落 `introspection-<slug>.md`。评审器只报问题 · 主 AI 才能复盘(sub 与评审器都拿不到主 AI 原始思考)。仍需 R+1 → 忽略本条 · 修完 spec 再跑下轮。

---

# 第 3 轮评审结论

## 总体判断

R1/R2 的主要架构争议已基本收敛：SystemBinary、只读会话解析、MCP CAS/原子写、ACP 路径收窄和非桌面门禁方向可以继续。

但本轮仍发现一个阻塞性问题：**三份 spec 对 MCP 第三方凭据到底是明文还是脱敏存在直接冲突**。此外，`KIRO_HOME`、项目作用域、自定义 agent 和会话路径没有形成统一运行时 profile；并发启动、进程重启、超时、认证失效等生产行为也缺少可验收契约。因此不建议直接开工全部波次。

---

## 真实业务边界清单

### 1. 多租户、多账户、多店铺、多平台

当前文档实际上只描述：

- 一个 codeg 实例；
- 一个本机用户；
- 一个 Kiro 配置根；
- 一个全局 API key / 登录态；
- 一个当前工作区；
- 多个 Kiro 自定义 agent。

没有描述：

- 租户 ID；
- 用户 ID 到 Kiro profile 的映射；
- 多账户凭据隔离；
- 多店铺、多平台数据源；
- 租户级 MCP 配置或会话目录。

因此本期只能明确限定为：**单实例、单本机用户、单 KIRO_HOME、单 Kiro 认证上下文**。如果服务器模式要服务多个互不信任的用户，当前方案不具备足够的租户隔离模型。

### 2. 多作用域 MCP

文档承认 Agent > Project > Global 三层合并，但只冻结了 Global 为读写目标：

- Global：可读写；
- Agent：只读展示；
- Project：只读展示。

仍需明确当前工作区如何确定 Project 根目录，尤其是：

- 多工作区；
- 工作区切换；
- 当前会话目录与当前前端工作区不一致；
- 项目配置不存在或损坏；
- project root 位于 KIRO_HOME 之外。

### 3. 历史会话

会话读取是只读路径，适合处理历史数据；但生产上还包括：

- 正在追加写入的 JSONL；
- 尾部半行；
- 会话文件被删除或重命名；
- `.json` 元数据缺失；
- 同一会话被两个进程同时读取；
- 900+ 会话首次扫描耗时过长；
- KIRO_HOME 改变后旧会话是否仍可见。

当前文档覆盖了部分解析容错，但未冻结 profile 切换和索引缓存语义。

### 4. 启动与并发

需要覆盖：

- 快速连续点击连接；
- 同一 agent 重复启动；
- 旧进程尚未退出时重新启动；
- ACP 握手超时；
- `session/new` 成功但后续进程退出；
- 用户取消启动；
- codeg 重启后遗留 Kiro 进程；
- Kiro 进程异常退出后重连；
- 外部 CLI 升级或 PATH 指向变化。

当前需求仅定义“启动并完成 ACP 握手”，没有定义幂等、互斥、取消、超时、重试或恢复行为。

### 5. 认证与凭据

需要区分：

- 浏览器登录态；
- `KIRO_API_KEY`；
- codeg DB 中保存的 API key；
- 子进程继承环境中的旧 `KIRO_API_KEY`；
- MCP server 的第三方 token；
- HTTP 请求者与本机用户。

当前文档只说明登录态优先和 HTTP 默认拒绝，但没有定义“数据库 key 为空时是否清除继承环境变量”“认证失效后是否重试/提示”“局域网启用开关由谁有权限修改”。

---

## 当前方案继续实施的风险

### R3-A1 · 三份文档对 MCP 第三方凭据的安全契约互相矛盾（架构级）

- **定位锚点**：`4.7 THE 系统 SHALL 以明文显示与编辑 Kiro MCP 配置中的 env 值与 args 元素。`
- **关联定位**：`background.md` 中 `W2 · MCP 三类型脱敏 + 门禁`、`KiroMcpRaw`、`KiroMcpQueryDto`、`KiroMcpPatch`、`KiroMcpRaw 不实现 Serialize`
- **问题**：`requirements.md`/`design.md` 当前要求 MCP `env` 和 `args` 明文读写；`background.md` 的实施方案仍要求脱敏展示、三态 Patch 和 Raw/Query/Patch 分层。两者不是实现细节差异，而是互斥的外部契约。
- **问题根因**：历史决策已更新了需求正文，但没有同步清理背景文档中的旧实施方案。
- **业务影响**：实现方可能按脱敏实现而无法满足明文需求，也可能按明文实现而违反背景文档既定的安全边界；用户保存配置时还可能出现占位符覆盖 token 或前端拿到明文的风险。
- **架构影响**：安全域、DTO 边界、通用 MCP 面板和专属面板的责任无法确定，后续测试无法判断哪一种行为正确。
- **修改建议**：在开工前对三份文档做单一裁决。若保留“桌面明文、HTTP 拒绝”，必须删除或标废 background 中的脱敏架构、三态 Patch 和 `Raw/QueryDto/Patch` 方案；若保留脱敏，则必须反向修改 Requirement 4.7/4.13，并补齐新增 server、更新和删除的 Keep 语义。
- **优先级**：**P0**

### R3-A2 · `KIRO_HOME`、会话路径和自定义 agent 扫描路径不是同一个运行时 profile

- **定位锚点**：`4.1.6 THE 系统 SHALL 在解析 ~/.kiro 的位置时优先采用 KIRO_HOME 环境变量的值`
- **关联定位**：`3.1 THE 系统 SHALL 从 ~/.kiro/sessions/cli/<uuid>.jsonl 读取 Kiro CLI 会话`、`6.5 THE 系统 SHALL 扫描 ~/.kiro/agents/ 下的 *.json 文件`
- **问题**：MCP 明确支持 `KIRO_HOME`，但会话读取和自定义 agent 扫描仍写死 `~/.kiro`。同一连接可以使用重定向后的 MCP 配置，却展示默认目录下的会话和 agent。
- **问题根因**：只对 MCP 路径做了重定位抽象，没有把 Kiro 数据根提升为统一 profile。
- **业务影响**：用户看到的会话、agent 与实际启动所使用的配置不一致；切换环境变量后可能误读另一账户的数据，甚至把 agent 选项传给错误的 Kiro profile。
- **架构影响**：数据来源、启动参数和配置所有权出现多个真源，历史数据迁移和故障排查困难。
- **修改建议**：冻结 `KiroRuntimeProfile` 或等价的单一数据根解析契约，统一决定 MCP、sessions、agents、认证相关路径；若本期不支持重定位会话/agent，应明确禁止并在 UI 中显示不支持，而不是只对 MCP 支持。
- **优先级**：**P1**

### R3-F1 · Project 作用域展示没有定义项目根来源

- **定位锚点**：`4.1.2 THE 系统 SHALL 在读取用于展示的 server 列表时，标注每个条目的来源作用域`
- **问题**：需求要求展示 Project 条目，但没有定义 project root 从哪里来，也没有定义工作区切换、会话 cwd、多项目并存和项目配置不存在时的行为。
- **问题根因**：三层合并语义已写清，但 Project 层的输入上下文未进入接口契约。
- **业务影响**：同一用户可能在不同项目间看到错误的 MCP 列表，或把全局 server 误认为项目 server。
- **修改建议**：明确项目根输入、优先级和空态；至少定义“当前工作区 root / 会话 cwd”的选取规则、切换后的刷新行为以及不存在/损坏时的错误状态。
- **优先级**：**P1**

### R3-F2 · 启动生命周期缺少生产级并发、超时和恢复契约

- **定位锚点**：`1.4 WHERE kiro-cli 可在 PATH 上解析到 WHEN 用户请求连接 Kiro THE 系统 SHALL 以 kiro-cli acp 启动进程并完成 ACP 握手。`
- **问题**：没有规定重复请求、已有进程、握手超时、取消、异常退出、服务重启、部分成功和重连行为。
- **问题根因**：验收只覆盖 happy path ACP 握手，没有覆盖进程状态机。
- **业务影响**：快速点击可能产生多个 Kiro 进程；握手超时后可能留下孤儿进程；服务重启后可能出现“界面无连接但进程仍在运行”。
- **修改建议**：本期至少增加最小状态机：`Starting/Connected/Stopping/Failed`，定义同一 agent 的并发请求处理、超时后的 kill/回收、取消语义、异常退出后的 UI 状态和重连策略。复杂持久化任务队列可延后。
- **优先级**：**P1**

### R3-F3 · API key 继承环境与认证失效行为未闭合

- **定位锚点**：`7.3 WHEN 启动 Kiro 进程 THE 系统 SHALL 把已存储的 key 作为环境变量注入子进程。`
- **问题**：没有定义 DB 中 key 被清空时是否移除父进程继承的 `KIRO_API_KEY`；也没有定义登录态失效、API key 过期、认证失败后的错误映射和重试策略。
- **问题根因**：只规定“注入 key”，没有规定环境变量的完整生命周期和失败状态。
- **业务影响**：用户删除 key 后，子进程仍可能使用旧 key；用户选择 API key 但实际使用浏览器登录态时，失败原因可能不可解释。
- **修改建议**：明确环境构造是替换而非只追加：未配置 key 时清除继承值；认证失败返回稳定错误并停止自动重试或规定有限重试；若不实现 `whoami`，应删除“检测实际认证来源”的隐含承诺，只保留明确提示。
- **优先级**：**P1**

### R3-F4 · 单机单用户边界与局域网入口的关系仍不够可执行

- **定位锚点**：`background.md` 的 `D5 单机单用户 fork 自用，服务器/多租户 out-of-scope`；`5.2 THE 系统 SHALL 提供一个配置项控制是否允许非桌面入口访问 Kiro 的凭据`
- **问题**：文档同时支持局域网网页端和“服务器/多租户 out-of-scope”，但未明确该 HTTP 入口是否只允许一个受信任操作者、已有认证如何绑定到本机用户，以及谁能修改 5.2 的开关。
- **问题根因**：把“非桌面入口默认拒绝”当成完整身份边界，但开关一旦开启仍缺少主体授权契约。
- **业务影响**：局域网中多个用户可能共享同一 Kiro API key、MCP 配置和会话；错误配置会把单机凭据能力暴露给所有可访问 HTTP 的请求者。
- **修改建议**：本期明确二选一：禁止 HTTP 开放凭据能力并只支持桌面；或明确已有认证、单用户假设和开关管理权限。不要声称支持多用户/多租户。
- **优先级**：**P1**

---

## 推荐的更优实现方向

### 本期必须实现

1. **先统一凭据契约**
   - 明确桌面端 MCP 第三方凭据究竟是明文还是脱敏；
   - 同步清理 `background.md` 的旧路线；
   - 将 API key 与 MCP 第三方凭据分别定义为两个安全域；
   - HTTP 非桌面入口默认拒绝，并验证拒绝发生在任何读写之前。

2. **建立统一 Kiro runtime profile**
   - 统一解析 `KIRO_HOME`；
   - 统一决定 sessions、agents、MCP 和认证相关路径；
   - 明确项目 root 的来源；
   - 不支持的 profile 场景必须显式禁用，而不是静默读默认目录。

3. **按纵向能力分阶段落地**
   - 第一阶段：SystemBinary 发现、连接、版本探测；
   - 第二阶段：只读会话浏览；
   - 第三阶段：模型、effort、权限、自定义 agent；
   - 第四阶段：MCP 读写与门禁；
   - ACP `<KIRO_HOME>/sessions/` 写权限仅在实机证据证明必要后实现。

4. **补最小进程状态机**
   - 同一 agent 防重复启动；
   - 握手超时和进程回收；
   - 取消、异常退出、服务重启后的状态恢复；
   - 新配置只对新会话生效。

### 可延后

- 多租户、多账户、多店铺、多平台统一模型；
- 分布式锁或跨进程协调；
- 完整会话索引数据库；
- 自动迁移历史数据；
- CLI 动态模型目录；
- 高级重试队列和离线补偿。

### 不建议实现

- 在 profile 未统一前继续扩展多个固定 `~/.kiro` 路径；
- 同时保留“明文 WYSIWYG”和“脱敏三态 Patch”两套契约；
- 为满足“可能需要”而直接开放整个 `<KIRO_HOME>`；
- 把局域网开关当作身份认证替代品；
- 为单个 Kiro 接入立即进行全仓 AgentDefinition/trait 化重构。

---

## 开工前代码核验清单

以下问题应由实现方在开工前逐项用仓库规定的三件套核实：

### 领域模型和数据库

- 当前 `AgentType`、`AgentDistribution`、`McpAppType` 是否分别承担了 agent 身份、可执行体来源和 MCP 应用归属？
- `agent_setting.env_json` 是否允许区分“未配置 key”“明确清空 key”和“继承环境变量”？
- 当前数据库是否已有 Kiro profile、工作区 root 或会话来源字段？
- `enabled`、`installed_version` 的现有语义是否适用于 SystemBinary？

### 接口、任务和事件链路

- Kiro 的连接、委派、重连、停止和进程清理是否经过同一生命周期入口？
- HTTP 与 Tauri 是否最终共用同一 MCP 读写函数族？
- 通用 MCP scan/upsert/remove/set-apps 是否存在绕过 Kiro 专属门禁的入口？
- 会话列表是否有缓存、分页、并发读取或后台任务机制？

### 数据来源和字段完整性

- `KIRO_HOME` 是否会影响 sessions、agents、MCP、锁文件和其他 Kiro 数据目录？
- `~/.kiro/agents/*.json` 的 `description`、文件名和 JSON 结构是否恒稳？
- Project root 的真实来源是什么：当前工作区、会话 cwd，还是 HTTP 请求上下文？
- MCP 的 `env`、`args`、`oauth`、未知字段是否在真实配置中同时存在？
- API key 是否可能通过父进程环境、旧 DB 值或其他配置来源进入子进程？

### 账户、租户和业务实体映射

- 一个 codeg 实例是否只对应一个 Kiro 登录态和一个 `KIRO_HOME`？
- HTTP 请求身份是否能映射到本机用户或某个 Kiro profile？
- 开启非桌面凭据访问的配置项由谁修改、谁有权限读取？
- 多账户场景是否明确禁止，还是已有 profile 隔离机制可复用？

### 状态机、幂等和失败恢复

- 同一个 Kiro agent 的重复连接请求是否幂等？
- ACP 握手超时后是否一定终止并回收子进程？
- 服务重启后如何识别遗留进程和失效锁？
- API key、MCP 文件和会话文件被外部修改时，各自的冲突/重试/刷新规则是什么？
- MCP CAS 失败后前端是否重新读取并提示用户，而不是自动覆盖？

### 历史实现和废弃逻辑

- 是否存在旧的 `useLegacyMcpJson`、`includeMcpJson` 兼容逻辑？
- 是否存在旧的脱敏 DTO、三态 Patch 或明文 CRUD 实现残留？
- 旧 Kiro/代理集成是否留下废弃配置、旧路径或兼容分支？
- 是否存在与本次能力重复的模型选择、API key 设置或 agent 扫描能力？

### 前后端重复能力

- 前端是否已经有通用“预设 + 自定义输入”的模型选择器？
- 是否已有统一的凭据输入、显示、清空和错误提示组件？
- 是否已有进程启动状态、超时、取消和重连 UI？
- 是否已有文件配置 CAS/冲突提示能力？

### 测试、规模和性能

- 真实生产会话数量、单文件最大字节数、平均消息数和扫描耗时是多少？
- 真实 Kiro CLI 启动、ACP 握手和退出的 P50/P95 延迟是多少？
- 是否有真实测试覆盖重复连接、超时、重启、外部修改、损坏 JSON 和权限拒绝？
- 是否有多项目/多工作区切换测试？
- 是否有验证“HTTP 门禁开启/关闭时 API key 与 MCP secret 不泄露”的请求级测试？

---

## 必须由产品/业务/技术负责人确认的问题

1. **MCP 第三方凭据最终采用哪一种契约：桌面明文，还是所有入口脱敏？**
2. 局域网模式是否明确承诺“单一受信任操作者”，还是未来需要多用户隔离？
3. `KIRO_HOME` 是否必须同时影响会话、agent、MCP 和认证数据，还是只支持 MCP？
4. Project MCP 的 project root 由当前工作区、会话 cwd，还是其他上下文决定？
5. 用户删除 DB 中 API key 后，是否必须清除继承环境中的同名变量？
6. 同一 Kiro agent 重复点击连接时，产品期望复用现有进程、拒绝第二次请求，还是启动多个会话？
7. ACP 文件写权限是否有真实业务场景必须写入 `<KIRO_HOME>/sessions/`？若无，应删除该能力。
8. 本期是否正式声明“不支持多账户、多租户、多店铺、多平台数据隔离”？
9. 模型、effort、权限和自定义 agent 的设置是否只对新会话生效？
10. 历史会话扫描是否允许首次打开设置/会话页出现秒级延迟，还是必须后台索引？

---

## 落地决定

**调整方案后开发**：先统一 MCP 凭据安全契约和 Kiro runtime profile，再补齐最小进程生命周期与 HTTP 信任边界；连接、版本探测和只读会话能力可在这些契约冻结后优先分阶段实现。

```yaml
patch_plan:
  - issue_id: R3-A1
    severity: P0
    target_file: requirements.md
    anchor: "4.7 THE 系统 SHALL 以明文显示与编辑 Kiro MCP 配置中的 env 值与 args 元素。"
    action: replace_section
    intent: 统一 requirements、design、background 对 MCP 第三方凭据明文或脱敏的唯一安全契约
    rationale_short: 三份文档当前存在互斥的外部行为和 DTO 设计
  - issue_id: R3-A2
    severity: P1
    target_file: requirements.md
    anchor: "4.1.6 THE 系统 SHALL 在解析 ~/.kiro 的位置时优先采用 KIRO_HOME 环境变量的值"
    action: append_after
    intent: 建立统一 runtime profile，使 sessions、agents、MCP 和认证路径共享同一数据根
    rationale_short: 当前会话和 agent 仍写死 ~/.kiro，可能与实际启动配置错位
  - issue_id: R3-F1
    severity: P1
    target_file: requirements.md
    anchor: "4.1.2 THE 系统 SHALL 在读取用于展示的 server 列表时，标注每个条目的来源作用域"
    action: append_after
    intent: 明确 Project root 的来源、切换、缺失和损坏语义
    rationale_short: Project 作用域没有输入上下文，可能展示或编辑错误项目配置
  - issue_id: R3-F2
    severity: P1
    target_file: requirements.md
    anchor: "1.4 WHERE `kiro-cli` 可在 PATH 上解析到"
    action: append_after
    intent: 增加连接状态机、重复请求、超时、取消、异常退出和服务重启恢复契约
    rationale_short: 当前只覆盖 ACP 握手成功路径，无法约束生产进程行为
  - issue_id: R3-F3
    severity: P1
    target_file: requirements.md
    anchor: "7.3 WHEN 启动 Kiro 进程"
    action: append_after
    intent: 定义 API key 清空、环境变量继承、认证失效和错误恢复语义
    rationale_short: 仅规定注入 key，未规定旧 key 清除和认证失败行为
  - issue_id: R3-F4
    severity: P1
    target_file: background.md
    anchor: "D5 | **单机单用户 fork 自用**"
    action: append_after
    intent: 将单机单用户边界与局域网 HTTP 入口的认证主体和开关权限写成可执行约束
    rationale_short: out-of-scope 声明不能替代 HTTP 身份和凭据访问授权
```

## VERDICT
status: NEEDS_CHANGES
p0_count: 1
p1_count: 5
one_line: R1/R2 方向基本收敛，但 MCP 凭据契约仍有文档级 P0 冲突，且运行时 profile、项目作用域和进程生命周期需在开工前补齐。
