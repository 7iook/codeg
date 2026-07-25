> **[主 AI 下一步]** 读完本 review 修完 spec 后:若本轮已收敛(R3 或 APPROVED / p0=0)→ **调 `post-review-introspection` skill** 做「初稿→评审→最终稿」三阶段复盘,落 `introspection-<slug>.md`。评审器只报问题 · 主 AI 才能复盘(sub 与评审器都拿不到主 AI 原始思考)。仍需 R+1 → 忽略本条 · 修完 spec 再跑下轮。

---

# 第 2 轮评审结论

## 总体判断

当前方案中的 **Kiro 连接、版本探测、只读会话浏览**具备明确用户价值，可以保留；但“MCP 全局接管”“开放整个 `.kiro` ACP 写权限”“局域网下继续明文返回凭据”依赖了互相冲突的隐含前提。

建议采用**局部重构路径**：先交付最小运行时接入与只读会话能力，把 MCP 配置归属、ACP 写权限和远程凭据边界关闭后再继续对应波次。暂不需要全仓领域重构，但也不应沿现有分支扩散模式直接实现全部功能。

---

## 一、架构级问题

### R2-A1 · MCP 配置被错误地归属于全局 `AgentType::Kiro`

- **定位锚点**：`4.1 THE 系统 SHALL 以 ~/.kiro/settings/mcp.json 作为 Kiro 的 MCP 配置文件。`；`6.5 THE 系统 SHALL 扫描 ~/.kiro/agents/`
- **问题**：文档同时允许用户选择任意自定义 agent，并说明 agent 定义含有 `useLegacyMcpJson`；但 MCP 设计仍把 `settings/mcp.json` 固定为整个 Kiro agent 类型的唯一配置。当前结论只由 `agents/main.json` 的取值推导，不能证明其他被选中的自定义 agent 使用同一文件。
- **问题根因**：把“运行时配置 profile”错误降维成了全局 `AgentType`，没有识别“所选自定义 agent”可能参与决定 MCP 配置来源。
- **业务影响**：用户可能在 codeg 中成功编辑一个 MCP 文件，但实际启动的自定义 agent 读取另一个文件，形成“保存成功但不生效”；解除绑定也可能删错配置。
- **架构影响**：MCP 配置所有权错误，CAS 和原子写只能保证“安全地写错文件”，无法保证业务正确性。
- **修改建议**：先核实 `useLegacyMcpJson` 对每个自定义 agent 的真实路由语义。随后二选一：
  1. 将本期 MCP 管理明确限定为 main/legacy profile，选择其他 profile 时禁用并解释；
  2. 引入最小 `KiroRuntimeProfile`，由所选 agent descriptor 决定 MCP 配置来源，MCP adapter 按 profile 读写。
  
  在该归属冻结前，停止 W1-P2 的 MCP 写入实现。
- **优先级**：**P0**
- **诚实边界**：`useLegacyMcpJson` 是否直接决定目标文件，需实现方结合 Kiro 行为核实。

### R2-A2 · `.kiro` ACP 整根写权限并不是所述用户故事的必要条件

- **定位锚点**：`> 主体澄清：本需求约束的是 Kiro 通过 ACP fs/* 请求宿主代写文件`
- **问题**：用户故事要求“Kiro 进程维护自己的会话与设置”，但文档已经确认进程原生文件访问不经过 codeg；因此给 ACP `fs/*` 开放整个 `.kiro` 根目录并不能由该用户故事推出。
- **问题根因**：将进程自身持久化能力与 agent/模型发起的宿主文件操作授权混为同一需求。
- **业务影响**：ACP 请求可能修改或删除历史会话、自定义 agent、MCP 凭据及设置，而正常启动并不一定需要这项授权。
- **架构影响**：权限不是从具体能力推导，而是从目录归属推导，形成远大于实际需要的授权面。
- **修改建议**：默认不新增 `.kiro` ACP 可写根。只有在证明某个真实 ACP 操作必须写入后，再按具体子路径和操作类型授权；若没有必要写操作，Requirement 8 应删除，而不是继续补路径穿越规则。
- **优先级**：**P0**
- **诚实边界**：Kiro 是否实际发出必须落到 `.kiro` 的 ACP `fs/*` 请求，需实现方用运行时证据核实。

### R2-A3 · “本地明文凭据”与“局域网页端”是互斥的信任前提

- **定位锚点**：`4.7 THE 系统 SHALL 以明文显示与编辑 Kiro MCP 配置中的 env 值与 args 元素。`；`7.2 THE 系统 SHALL 以明文显示已存储的 API key。`
- **问题**：明文方案以“单机本地自用、没有前后端信任边界”为依据，但 Requirement 5 又明确支持局域网页端。MCP 另有默认拒绝门禁，API key 所在的通用 agent 设置则没有对应准入契约。
- **问题根因**：使用产品部署标签代替能力授权；“HTTP/桌面入口”被当成了用户身份和信任边界。
- **业务影响**：局域网页端可能读取或覆盖 API key；一旦打开 MCP 布尔开关，第三方 token 也可能从“全部拒绝”直接变为“全部明文开放”。
- **架构影响**：安全策略散落在单项功能上，同一个设置页面中的凭据具有不同且无法解释的访问规则。
- **修改建议**：不必建设多租户体系，但必须冻结最小模式契约：
  - 桌面本地模式可保留明文 WYSIWYG；
  - 非桌面模式不得返回明文 secret，或整个凭据设置能力必须不可访问；
  - 若局域网确需管理凭据，应依赖已有认证主体进行能力授权，而不是只用开关放行。
- **优先级**：**P0**
- **诚实边界**：通用 `agent_setting.env_json` 是否暴露给 HTTP 路由，需实现方核实；spec 当前没有证明它被隔离。

### R2-A4 · `SystemBinary` 仍在延续“分布类型承担全部行为”的错误模型

- **定位锚点**：`### SystemBinary 的 9 处编译强制落点`
- **问题**：设计把新增变体触发 9 处 match 修改视为安全优势，同时启动参数仍需 `agent_type == Kiro` 特判。这说明“产物获取方式、安装能力、版本探测、启动构造、诊断展示”被压在一个分布枚举里，并未形成真正可复用的系统二进制抽象。
- **问题根因**：现有 `AgentDistribution` 同时表达来源、安装策略、探测策略和启动策略；新增枚举变体只是把耦合显式扩散。
- **业务影响**：本次容易漏点；未来接入另一个系统安装型 agent 时仍需重复修改大量 match，并继续添加 agent 特判。
- **架构影响**：形成典型 shotgun change，且 ADR 当前只比较 Binary/Uvx/SystemBinary，没有比较职责拆分方案。
- **修改建议**：ADR 至少加入局部拆分方案作为正式备选：将“可执行文件来源/是否可安装/版本探针”集中到注册元数据或策略对象，将动态 argv 交给 agent launch builder。无需立即做全仓 trait 化，但不能把 9 处分支当成目标架构。
- **优先级**：**P1**

### R2-A5 · 五类独立能力被绑定成一次全量交付

- **定位锚点**：`## 实施波次`
- **问题**：agent 连接、会话导入、MCP 编辑、启动偏好、ACP 文件授权具有不同价值、风险和失败模式，却被组织成一个“第 13 个一等 agent”的全量交付。
- **问题根因**：按共享文件和并行冲突划分实施波次，而不是按可独立验收的用户能力切片。
- **业务影响**：MCP 或权限问题会阻塞已经可用的连接与会话浏览；一次发布同时引入过大的回归面。
- **架构影响**：各能力缺少独立启用、回滚和验收边界，迫使实现者为一次性集成接受更多耦合。
- **修改建议**：改为纵向交付：
  1. 系统二进制发现、连接、版本探测；
  2. 只读会话浏览；
  3. 启动参数与自定义 agent；
  4. MCP 管理；
  5. 只有证据成立时才增加 ACP 数据目录写权限。
  
  前三项不应等待后两项。
- **优先级**：**P1**

---

## 二、普通功能与验收问题

### R2-F1 · 硬编码模型集合仍依赖“模型目录全局稳定”的隐含前提

- **定位锚点**：`**F5** 模型列表须定义 CLI 来源 / 手动触发 / 超时 / 缓存`
- **问题**：设计驳回 CLI 模型发现后宣称采用硬编码集合，但 Requirement 6.1 没有定义集合、更新来源或未知模型行为。Kiro 版本、账户或订阅差异可能使固定列表过期。
- **问题根因**：在“自动拉取可能阻塞”和“硬编码为权威目录”之间做了错误二选一。
- **业务影响**：新增模型无法选择，已下线或账户不可用的模型仍可选择，错误只会在启动时暴露。
- **架构影响**：外部平台的动态能力被固化成 codeg 发布周期内的数据。
- **修改建议**：采用可编辑组合框：内置列表只是便捷预设，允许用户输入模型 ID；不自动调用 CLI，也不把预设宣称为完整权威目录。这样同时避开认证阻塞和硬编码漂移。
- **优先级**：**P1**

---

## 三、三种路径对比

| 路径 | 收益 | 成本 | 主要风险/技术债 | 结论 |
|---|---|---:|---|---|
| 沿用现有方案 | 最快开始编码，最大程度照搬既有扩展点 | 短期低 | MCP 可能写错 profile；整根写权限缺乏必要性；局域网凭据边界矛盾；持续增加 match 和特判 | **不建议** |
| 局部重构 | 保留现有注册体系，只修正配置所有权、权限边界和 launch 构造；可分批交付 | 中 | 需要重新排列波次并补一轮契约验证 | **推荐** |
| 领域重构 | 可统一 AgentDefinition、运行时 profile、配置 adapter 和能力授权 | 高 | 对单个 Kiro 接入而言范围过大，交付周期和迁移风险明显增加 | **暂不采用；出现第二个同类 agent 时再启动** |

## 四、保留、调整与停止项

### 可以保留

- 用户自行安装二进制、codeg 不负责下载的业务语义。
- PATH 探测、版本展示和 ACP 连接目标。
- CLI 会话只读解析及 Prompt/Clear 同轮不变式。
- MCP 的 CAS、原子替换、未知字段保真机制——前提是先确定正确配置所有者。
- 沿用泛型委派 broker——但应在宣称交付前完成最小链路验证。

### 必须调整

- `SystemBinary` ADR 应比较职责拆分方案，而非只比较三个枚举变体。
- 实施波次改成独立纵向能力切片。
- MCP 配置来源从全局 Kiro 类型提升为明确 runtime profile，或明确收窄为 main/legacy。
- 局域网模式下凭据读取、修改的能力契约。
- 模型选择改成“预设 + 可输入”，避免固定目录成为伪 SSOT。

### 应停止继续开发

- 在 MCP 配置归属未核实前，停止 W1-P2 的写入和绑定功能。
- 在证明实际必要性前，停止为 `agent_data_roots` 增加整个 `.kiro` 可写根。
- 在局域网凭据访问规则冻结前，停止实现 Web 侧明文 API key/MCP secret 展示。
- 在 ADR 补入局部职责拆分备选前，不应把 9 处 match 扩散作为最终架构固化。

```yaml
patch_plan:
  - issue_id: R2-A1
    severity: P0
    target_file: requirements.md
    anchor: "4.1 THE 系统 SHALL 以 `~/.kiro/settings/mcp.json` 作为 Kiro 的 MCP 配置文件。"
    action: replace_section
    intent: 按所选自定义 agent/runtime profile 冻结 MCP 配置所有权，或明确限定为 main/legacy profile
    rationale_short: 全局固定文件可能不是当前所选 agent 的实际配置来源
  - issue_id: R2-A2
    severity: P0
    target_file: requirements.md
    anchor: "> **主体澄清**：本需求约束的是 **Kiro 通过 ACP `fs/*` 请求宿主代写文件**这一条通路"
    action: replace_section
    intent: 以真实 ACP 写入需求证明授权必要性，并按最小子路径和操作授权；无必要性则移除该能力
    rationale_short: 进程原生持久化不能推出 ACP 获得整个 .kiro 根写权限
  - issue_id: R2-A3
    severity: P0
    target_file: requirements.md
    anchor: "## Requirement 5 · MCP 写入门禁（局域网场景）"
    action: replace_section
    intent: 统一桌面与非桌面模式的凭据访问契约，覆盖 MCP secret 和 API key 的读取与修改
    rationale_short: 本地明文假设与局域网页端能力互相冲突
  - issue_id: R2-A4
    severity: P1
    target_file: design.md
    anchor: "### SystemBinary 的 9 处编译强制落点"
    action: replace_section
    intent: 在 ADR 中比较枚举扩展与来源、安装、探测、启动职责局部拆分，并收口分支扩散
    rationale_short: 九处 match 加 Kiro 特判表明分布模型承担了过多职责
  - issue_id: R2-A5
    severity: P1
    target_file: design.md
    anchor: "## 实施波次"
    action: replace_section
    intent: 按连接、会话、启动设置、MCP、文件授权拆成可独立验收和回滚的纵向交付
    rationale_short: 当前按共享文件分波次导致低风险能力被高风险能力绑定阻塞
  - issue_id: R2-F1
    severity: P1
    target_file: requirements.md
    anchor: "6.1 THE 系统 SHALL 在 Kiro 的设置面板中提供模型选择"
    action: append_after
    intent: 将模型集合定义为非权威预设并允许输入自定义模型 ID
    rationale_short: 避免 CLI 自动发现阻塞的同时不能假设固定模型目录永久完整
```

## VERDICT
status: NEEDS_CHANGES
p0_count: 3
p1_count: 3
one_line: 连接与会话能力值得保留，但 MCP 配置所有权、ACP 整根写权限和局域网明文凭据边界必须先刹车换路。
