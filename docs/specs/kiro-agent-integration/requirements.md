---
slug: kiro-agent-integration
title: Kiro CLI 作为 ACP agent 接入 codeg
status: converged
review_rounds_done: 3
last_review_status: NEEDS_CHANGES→resolved
last_review_p0: 0
created: 2026-07-26
last_updated: 2026-07-26
shipped_commit: null
related_adrs: [ADR-0001]
related_specs: []
supersedes: []
superseded_by: null
rca: null
tags: [acp, agent-integration, kiro, mcp]
domain: agent-runtime
one_line: 把系统安装的 Kiro CLI 接入 codeg 的 ACP agent 注册表，支持会话浏览、MCP 接管、模型/effort/权限/自定义 agent 选择。
---

# Requirements · Kiro CLI 接入 codeg

## 背景与范围

codeg 已有 12 个 ACP agent。本规格把 **Kiro CLI**（系统安装的 `kiro-cli.exe`，实测
`kiro-cli-chat 2.14.2`）接为第 13 个。

勘察事实基线：`.agent-workspace/.archive/2026-07-25/kiro-agent/kiro-agent-recon.md`
（565 行，所有 file:line 以该报告为准；上一轮丢失的规格残件见 `background.md`，其行号已全部漂移）。

**不在范围内**：Kiro IDE/spec 会话格式（`~/.kiro/sessions/<hash>/sess_<uuid>/`）的解析；
Kiro 账号登录流程的代理；`kiro-cli` 子命令输出的解析（实测 `mcp list` 的输出与 stderr 日志混排，
不作为数据通路）。

## 术语

- **`<KIRO_HOME>`**：Kiro 的数据根。取 `KIRO_HOME` 环境变量的值；未设置时为用户主目录下的
  `.kiro`。**全规格所有 Kiro 数据路径均以它为前缀**，且四个消费方（会话读取 / agent 扫描 /
  MCP 读写 / ACP 写权限边界）共用同一解析结果（见 R4.1.6–4.1.8）。
- **CLI 会话**：`<KIRO_HOME>/sessions/cli/<uuid>.jsonl`，每行 `{"version":"v1","kind":...,"data":{...}}`。
- **Kiro 自定义 agent**：`<KIRO_HOME>/agents/<name>.json`，含 `name`/`description`/`prompt`/`tools`/
  `allowedTools`/`toolsSettings`/`mcpServers`/`includeMcpJson` 等字段，由
  `kiro-cli acp --agent <name>` 选用。（`includeMcpJson` 在上游 Amazon Q Developer CLI 中
  旧名为 `useLegacyMcpJson`；本机现有 agent 定义仍写旧名。）
- **SystemBinary**：本规格新增的 `AgentDistribution` 变体，表示「二进制由用户自行安装、codeg 不提供下载」。
- **凭据准入门禁**：对 Kiro MCP 配置与 API key 的读写准入判断，位于 `commands/mcp.rs`
  函数族层，桌面入口与 HTTP 入口共用（见 Requirement 5）。

---

## Requirement 1 · Kiro 出现在 agent 列表并可连接

**User Story**：作为 codeg 用户，我要在 agent 选择器里看到 Kiro 并直接对话，因为我已经在系统里装了 Kiro CLI。

### Acceptance Criteria

1.1 THE 系统 SHALL 在 `all_acp_agents()` 的返回值中包含 `AgentType::Kiro`。

1.2 THE 系统 SHALL 以 `kiro` 作为 `AgentType::Kiro` 的 serde 名，以 `kiro` 作为其 `registry_id`。

1.3 WHEN 用户首次安装本版本 THE 系统 SHALL 使 `AgentType::Kiro` 的 `agent_setting.enabled`
默认为 `true`。

1.4 WHERE `kiro-cli` 可在 PATH 上解析到 WHEN 用户请求连接 Kiro THE 系统 SHALL 以
`kiro-cli acp` 启动进程并完成 ACP 握手。

1.4.1 WHILE 一个 Kiro 连接已存在 WHEN 用户重复请求连接 THE 系统 SHALL 复用既有连接，
且 SHALL NOT 启动第二个进程。

1.4.2 IF ACP 握手在超时时限内未完成 THEN THE 系统 SHALL 终止该子进程、释放其资源，
并以超时原因告知用户。

1.4.3 WHEN 用户取消一个正在进行的连接请求 THE 系统 SHALL 终止该子进程，
使其不残留为孤儿进程。

1.4.4 WHEN Kiro 进程非预期退出 THE 系统 SHALL 把该 agent 的状态置为未连接，
并保留其退出码与 stderr 尾部供诊断查看。

1.4.5 THE 系统 SHALL 使 Kiro 的连接生命周期（启动 / 就绪 / 断开 / 重连）遵循与其余 12 个
agent 相同的状态机，且 SHALL NOT 为 Kiro 引入专属的连接状态。

1.5 IF `kiro-cli` 无法在 PATH 上解析到 THEN THE 系统 SHALL 返回 `SdkNotInstalled` 错误并在
agent 列表中显示为未安装。

1.6 THE 系统 SHALL 从 `kiro-cli --version` 的输出中剥除 `kiro-cli-chat ` 前缀后作为版本号显示。

1.7 THE 系统 SHALL NOT 为 Kiro 提供下载或安装按钮。

## Requirement 2 · SystemBinary 分布类型

**User Story**：作为维护者，我要有一个表示「用户自行安装的二进制」的分布类型，因为现有三种都假定 codeg 负责获取产物。

### Acceptance Criteria

2.1 THE 系统 SHALL 提供 `AgentDistribution::SystemBinary` 变体，其字段为 PATH 上的命令名与固定参数。

2.2 THE 系统 SHALL 对 `SystemBinary` 的 `registry_version()` 返回 `None`。

2.3 WHEN 分布类型为 `SystemBinary` THE 系统 SHALL 在安装校验中仅检查命令能否在 PATH 上解析。

2.4 WHEN 分布类型为 `SystemBinary` THE 系统 SHALL 通过运行 `<cmd> --version` 探测本地版本，
而不查询 codeg 的二进制缓存。

2.5 THE 系统 SHALL NOT 为 `SystemBinary` 执行任何下载、解包或缓存写入。

## Requirement 3 · CLI 会话浏览

**User Story**：作为 codeg 用户，我要在 codeg 里翻我的 Kiro 历史会话，因为我已经积累了 900 多个。

### Acceptance Criteria

3.1 THE 系统 SHALL 从 `<KIRO_HOME>/sessions/cli/<uuid>.jsonl` 读取 Kiro CLI 会话。

3.2 THE 系统 SHALL 解析顶层 `kind` 的五种取值：`Prompt`、`AssistantMessage`、`ToolResults`、
`Clear`、`Compaction`。

3.3 THE 系统 SHALL 解析 `data.content[].kind` 的内层取值：`text`、`thinking`、`toolUse`、
`toolResult`、`image`。

3.4 THE 系统 SHALL 把 `kind == "Prompt"` 视为一个新用户轮次的起点。

3.4.1 WHEN 遇到 `kind == "Clear"` THE 系统 SHALL 结束当前轮次并丢弃其之前的上下文关联，
使后续事件不与之前的轮次配对。

3.4.2 THE 系统 SHALL 把每个 `toolResult` 归属到同一轮次内产生对应 `toolUse` 的
`AssistantMessage`；THE 系统 SHALL NOT 跨轮次配对 `toolUse` 与 `toolResult`。

3.4.3 IF 某个 `toolResult` 在其所在轮次内找不到对应的 `toolUse` THEN THE 系统 SHALL 将其
渲染为一条孤立工具结果，且 SHALL NOT 将其移动到相邻轮次。

3.5 WHEN 遇到 `kind == "Compaction"` THE 系统 SHALL 将其渲染为一条上下文压缩记录，
并且 SHALL NOT 将其视为轮次边界。

3.5.1 THE 系统 SHALL 对 `Compaction` 的 `summary` 与 `messages_snapshot` 的渲染长度施加上限，
并在超限处标记截断。

3.6 IF 某一行不是合法 JSON THEN THE 系统 SHALL 跳过该行并继续解析后续行。

3.6.1 IF 某一行的顶层 `kind` 取值不在 3.2 的五种之内 THEN THE 系统 SHALL 渲染一条标注该
`kind` 名称的未知事件占位记录，且 SHALL NOT 中止解析。

3.6.2 IF 某个 `data.content[]` 元素的内层 `kind` 不在 3.3 的五种之内 THEN THE 系统 SHALL
保留该元素的占位记录，且 SHALL NOT 丢弃同一事件内的其余元素。

3.7 THE 系统 SHALL 以只读方式访问会话文件。

3.8 WHEN 用户在会话列表中选择一个 Kiro 会话 THE 系统 SHALL 渲染其消息、思考内容与工具调用。

## Requirement 4 · MCP 配置接管

**User Story**：作为 codeg 用户，我要在 codeg 的 MCP 面板里管理 Kiro 的 MCP 服务器，因为我不想手改 JSON。

### Acceptance Criteria

### MCP 配置的三层合并语义

> **官方文档核实**（`kiro.dev/docs/cli/mcp/configuration` · `/cli/chat/configuration`，
> 页面更新 2026-05-27 / 2026-07-09）：Kiro 的 MCP server 来自**三个作用域的合并**，
> 优先级 `Agent > Project > Global`：
>
> | 作用域 | 位置 |
> |---|---|
> | Agent | `~/.kiro/agents/<name>.json` 或 `<project>/.kiro/agents/<name>.json` 的 `mcpServers` |
> | Project | `<project-root>/.kiro/settings/mcp.json` |
> | Global | `~/.kiro/settings/mcp.json` |
>
> **同名 server 才发生覆盖；不同名的全部叠加生效**（官方示例：agent 有 `fetch`、
> workspace 有 `git`、global 有 `aws` → 三者同时可用）。因此**自定义 agent 内嵌 `mcpServers`
> 并不排斥全局配置** —— 它是叠加/覆盖，不是替代。
>
> 是否叠加由 agent 的 **`includeMcpJson`**（boolean）字段控制。注意：该字段在上游
> Amazon Q Developer CLI 中旧名为 `useLegacyMcpJson`（本机 6 个 agent 定义写的仍是旧名，
> 当前版本可能不识别而走默认值 —— 见 4.1.6）。

4.1 THE 系统 SHALL 以 `<KIRO_HOME>/settings/mcp.json`（全局作用域）作为 codeg MCP 面板对 Kiro
的**读写目标**。

4.1.1 THE 系统 SHALL NOT 写入 agent 定义文件（`<KIRO_HOME>/agents/*.json`）的 `mcpServers` 字段。

> **理由**：agent 定义文件同时承载 `prompt` / `tools` / `allowedTools` / `hooks` 等与 MCP 无关
> 的内容，写入它会把「管理 MCP server」与「修改 agent 人格」两件事耦合在一个文件上；
> 且 agent 作用域的语义是「为该 agent 覆盖或补充」，不是「该 agent 的 MCP 清单」。
> 全局作用域是唯一对所有 agent 都生效的层，也是 `kiro-cli mcp add --scope global` 的默认目标。

4.1.2 THE 系统 SHALL 在读取用于**展示**的 server 列表时，标注每个条目的来源作用域
（Agent / Project / Global）。

4.1.3 WHERE 某个 server 名在多个作用域中同时存在 THE 系统 SHALL 标示其被更高优先级作用域覆盖，
并以生效的那一份作为展示内容。

4.1.4 THE 系统 SHALL 对来自 Agent 与 Project 作用域的条目提供只读展示，
且 SHALL NOT 允许经 codeg 面板编辑它们。

4.1.5 THE 系统 SHALL 在面板中显示当前读写目标的绝对路径。

4.1.6 THE 系统 SHALL 在解析 `~/.kiro` 的位置时优先采用 `KIRO_HOME` 环境变量的值；
WHERE 该变量未设置 THE 系统 SHALL 使用用户主目录下的 `.kiro`。

4.1.7 THE 系统 SHALL 以单一的数据根解析结果（下称 `<KIRO_HOME>`）同时服务于会话读取
（Requirement 3.1）、自定义 agent 扫描（Requirement 6.5）、MCP 配置读写（本需求）
与 ACP 写权限边界（Requirement 8），使四者不会指向不同的数据根。

4.1.8 THE 系统 SHALL 以启动 Kiro 子进程时实际生效的 `KIRO_HOME` 值作为 `<KIRO_HOME>`
的解析依据，包括 codeg 自身注入的环境变量对它的影响。

4.1.9 THE 系统 SHALL 以当前工作区目录作为 Project 作用域的根，
即 `<workspace>/.kiro/settings/mcp.json`。

4.1.10 WHEN 工作区切换 THE 系统 SHALL 重新解析 Project 作用域并刷新展示内容。

4.1.11 WHERE Project 作用域的配置文件不存在 THE 系统 SHALL 视其为空集合，
且 SHALL NOT 报错。

4.1.12 IF 任一作用域的配置文件存在但不是合法 JSON THEN THE 系统 SHALL 标示该作用域解析失败
并继续展示其余作用域的条目，而 SHALL NOT 使整个面板不可用。

4.2 THE 系统 SHALL 在读写时保留 Kiro 特有字段 `disabled`、`autoApprove`、`disabledTools`
以及任何未识别的字段。

4.3 WHEN 用户在 MCP 面板中把某个服务器绑定到 Kiro THE 系统 SHALL 将该服务器写入
4.1 所解析出的配置源的 `mcpServers` 对象。

4.4 WHEN 用户在 MCP 面板中解除某个服务器与 Kiro 的绑定 THE 系统 SHALL 从该配置源中移除
对应条目且 SHALL NOT 影响其余条目。

4.4.1 THE 系统 SHALL 逐字保留读写目标文件内 `mcpServers` 之外的所有顶层键。

### 工具级禁用（server 条目内）

4.4.2 THE 系统 SHALL 允许在面板中编辑某个 server 条目的 `disabledTools` 数组，
使指定工具在调用 agent 时被省略。

4.4.3 THE 系统 SHALL 允许在面板中切换某个 server 条目的 `disabled` 布尔值，
使整个 server 停用而不删除其配置。

4.4.4 THE 系统 SHALL 允许在面板中编辑某个 server 条目的 `autoApprove` 数组。

4.4.5 THE 系统 SHALL 保留 server 条目的其余可选字段（`timeout` / `url` / `headers` /
`oauth` / `oauthScopes`）；WHERE 面板不提供其编辑界面 THE 系统 SHALL 在读写往返中逐字保留它们。

4.5 THE 系统 SHALL 在 `load_mcp_servers_for_agent` 的转发跳过名单中包含 `AgentType::Kiro`。

> **实装澄清（2026-07-26，实测纠正）**：跳过名单是实现本条的**唯一**机制。
> `AcpAgentMeta::supports_mcp` **不是**「codeg 是否转发 MCP」的开关 —— Cursor / Grok /
> Kimi Code 三者都是 `supports_mcp: true` 且同时在跳过名单里。该字段的真实语义是
> 「该 agent 的 `session/new` 是否容忍 `mcpServers` 字段」，OpenClaw 是唯一容忍不了的。
> 把 Kiro 设成 `supports_mcp: false` 会**连带丢掉 codeg 自己注入的 `codeg-mcp` 伴生进程**
> （委派 / ask_user_question / feedback / session_info 全部失效），因为
> `connection.rs` 用同一个标志同时门控用户 server 与伴生进程。
> `registry.rs::only_openclaw_opts_out_of_mcp` 不变式测试会拦住这个错误。
> 故 Kiro 的元数据是 `supports_mcp: true`。

4.6 THE 系统 SHALL 使 Kiro 出现在 MCP 面板的 app 维度选项中。

4.7 THE 系统 SHALL 以明文显示与编辑 Kiro MCP 配置中的 `env` 值与 `args` 元素。

4.8 THE 系统 SHALL 在写入前校验目标文件可解析；IF 文件存在但不是合法 JSON THEN THE 系统
SHALL 拒绝写入并返回配置无效错误。

4.9 THE 系统 SHALL 在读取时记录目标文件内容的指纹，并在写入时校验该指纹仍然成立；
IF 指纹已变化 THEN THE 系统 SHALL 拒绝写入并返回冲突错误，且 SHALL NOT 覆盖文件。

4.10 THE 系统 SHALL 以「写同目录临时文件后原子替换」的方式落盘；IF 落盘的任一步骤失败
THEN 目标文件 SHALL 保持其写入前的字节内容。

4.11 THE 系统 SHALL 仅替换 `mcpServers` 下被操作的那一个条目，并逐字保留其余条目
及文件顶层的其他键。

### 凭据安全域（本需求与 Requirement 7 的边界）

4.12 THE 系统 SHALL 把 Kiro 的 API key（Requirement 7）与 Kiro MCP 配置中第三方服务的凭据
视为两个独立的安全域。

4.13 THE 系统 SHALL 以明文显示与编辑 Kiro MCP 配置中的 `env` 值与 `args` 元素（与 4.7 一致），
并且 SHALL NOT 引入占位符回写机制。

> **决策依据**：本工具为单机本地自用，用户已明确不需要脱敏。`background.md` 提出的
> `Raw / QueryDto / Patch` 三类型 + 脱敏 + `Keep` 三态方案**不予采用** —— 该方案的动机是
> 「避免占位符回写覆盖真实凭据」，而不引入占位符即从根上消除该风险（更少的机制、
> 更少的失败模式）。本条与 4.7 共同构成唯一契约，通用面板与专属读写不存在双契约。

## Requirement 5 · 凭据访问的模式差异（局域网场景）

**User Story**：作为在局域网里使用 codeg 网页端的用户，我要让 Kiro 的凭据不被网页端读到，
因为「本机明文可见」这个决定只针对坐在这台机器前的我。

> **前提澄清**：「明文不脱敏」（R4.7 / R4.13 / R7.2）的适用范围是**桌面入口**——
> 即操作者已经拥有该机器的文件系统访问权，脱敏毫无意义。局域网网页入口不满足该前提：
> 请求者未必是本机用户。因此本需求区分入口，而非区分数据。

### Acceptance Criteria

5.1 THE 系统 SHALL 在 `commands/mcp.rs` 的读写函数族层实施 Kiro 凭据准入判断，使桌面入口与
HTTP 入口共用同一判断。

5.2 THE 系统 SHALL 提供一个配置项控制是否允许非桌面入口访问 Kiro 的凭据，其默认值为不允许。

5.3 WHILE 该配置项为不允许 WHEN 请求经 HTTP 入口到达 THE 系统 SHALL 拒绝以下全部操作
并返回明确的拒绝原因：读取 Kiro MCP 配置、写入 Kiro MCP 配置、读取已存储的 Kiro API key、
写入 Kiro API key。

5.3.1 WHILE 该配置项为不允许 WHEN 请求经 HTTP 入口到达 THE 系统 SHALL NOT 在任何响应体、
错误信息或日志中包含 Kiro MCP 配置的 `env` 值、`args` 元素或 API key 的明文。

5.4 WHEN 准入判断为拒绝 THE 系统 SHALL 在执行任何删除或写入之前拒绝，使配置文件保持原状。

5.5 THE 系统 SHALL NOT 因该门禁影响其余 12 个 agent 的 MCP 读写。

5.6 THE 系统 SHALL NOT 因该门禁影响经 HTTP 入口的会话浏览与 agent 启动
（用户裁决：局域网场景须可用）。

## Requirement 6 · 启动参数：模型、effort、权限、自定义 agent

**User Story**：作为 codeg 用户，我要选模型、effort、授权模式和自定义 agent，因为我要控制花费并复用已经写好的 agent 人格。

### Acceptance Criteria

6.1 THE 系统 SHALL 在 Kiro 的设置面板中提供模型选择，并将所选值作为 `--model <MODEL>` 传给
`kiro-cli acp`。

6.1.1 THE 系统 SHALL 把内置模型取值集合视为**非权威预设**，并允许用户输入预设之外的任意
模型 ID。

6.1.2 THE 系统 SHALL 把用户输入的自定义模型 ID 原样传给 `--model`，
且 SHALL NOT 以预设集合为由拒绝它。

6.1.3 WHERE 用户未选择任何模型 THE 系统 SHALL 省略 `--model` 参数，交由 Kiro 使用其自身默认。

> **为何不自动拉取模型列表**：`background.md` §4 已实测 `--list-models` 在未登录时挂在
> auth portal。改为「预设 + 可自定义输入」既避免该阻塞，又不假设预设永久完整。

6.2 THE 系统 SHALL 提供 effort 选择，其取值集合为 `low`、`medium`、`high`、`xhigh`、`max`，
并将所选值作为 `--effort <EFFORT>` 传递。

> **实测确认（`kiro-cli acp --help`，v2.14.2）**：四个维度的参数全部存在且拼写如本规格所记。
> 另有本规格未覆盖的第五个参数 `--agent-engine <v1|v2|v3>`（默认 `v2`）——
> 当前**有意不接线**：无需求覆盖，且默认值已是较新引擎。若将来要暴露，须新增 AC。

6.3 THE 系统 SHALL 提供授权模式选择；WHEN 用户选择全部信任 THE 系统 SHALL 传递
`--trust-all-tools`。

6.4 WHEN 用户选择按工具信任并给出工具名集合 THE 系统 SHALL 传递
`--trust-tools <TOOL_NAMES>`。

6.5 THE 系统 SHALL 扫描 `<KIRO_HOME>/agents/` 下的 `*.json` 文件以发现可选的自定义 agent。

6.5.1 THE 系统 SHALL 以文件名（去扩展名）作为自定义 agent 的稳定标识，该标识即传给
`--agent` 的值。

6.5.2 IF 某个 `*.json` 无法读取或不是合法 JSON THEN THE 系统 SHALL 将其从列表中排除，
且 SHALL NOT 阻止其余项的列出。

6.5.3 THE 系统 SHALL 以文件内的 `description` 作为列表项的说明文字；WHERE 该字段缺失
THE 系统 SHALL 仅显示标识本身。

6.5.4 WHEN 用户已选定的自定义 agent 在启动时已不存在于扫描结果中 THE 系统 SHALL 以明确的
错误说明该 agent 不可用，且 SHALL NOT 静默回退到默认 agent。

6.6 WHEN 用户选择了一个自定义 agent THE 系统 SHALL 传递 `--agent <AGENT>`。

6.7 WHERE 用户未选择任何自定义 agent THE 系统 SHALL 省略 `--agent` 参数。

6.8 THE 系统 SHALL 在同一次启动中按固定顺序组合上述参数，使参数之间不相互覆盖。

6.9 IF `<KIRO_HOME>/agents/` 不存在或为空 THEN THE 系统 SHALL 呈现空的自定义 agent 列表且
SHALL NOT 阻止连接。

## Requirement 7 · API key 认证

**User Story**：作为 codeg 用户，我要用 API key 连 Kiro，因为我不想每次都开浏览器登录。

### Acceptance Criteria

7.1 THE 系统 SHALL 允许用户在 Kiro 设置面板中录入 API key，并将其存入
`agent_setting.env_json`。

7.2 THE 系统 SHALL 以明文显示已存储的 API key。

7.3 WHEN 启动 Kiro 进程 THE 系统 SHALL 把已存储的 key 作为环境变量注入子进程。

7.3.1 WHEN 用户清空 API key 输入框并保存 THE 系统 SHALL 从 `agent_setting.env_json` 中移除
该键，且后续启动 SHALL NOT 再注入它（包括不注入空字符串）。

7.3.2 WHERE 未存储 API key THE 系统 SHALL 不注入该环境变量，
使 Kiro 回落到它自身的认证方式。

7.3.3 THE 系统 SHALL 使 codeg 显式设置的环境变量优先于从宿主进程继承的同名变量，
使面板中的值可预期地生效。

7.3.4 IF Kiro 因认证失败而无法建立会话 THEN THE 系统 SHALL 呈现 Kiro 返回的原始错误，
并提示用户检查 key 与登录态的优先级（见 7.4），而 SHALL NOT 静默重试或清除已存储的 key。

7.4 THE 系统 SHALL 在 Kiro 设置面板中说明「若已执行过 `kiro-cli login`，登录态优先于 API key」。

7.5 THE 系统 SHALL NOT 把 API key 写入日志、诊断报告或会话记录。

## Requirement 8 · 文件系统写权限

**User Story**：作为 codeg 用户，我要让 Kiro 经 ACP 请求的文件写入被限制在必要范围，
因为那条通路是模型可驱动的。

> **主体澄清**：本需求约束的是 **Kiro 通过 ACP `fs/*` 请求宿主代写文件**这一条通路
> （即 `agent_data_roots` 的语义），而**不是** Kiro 进程自己用操作系统 API 读写磁盘
> —— 后者不经 codeg，codeg 也无从限制。
>
> **必要性论证（R2-A2）**：Kiro 进程自身维护 `~/.kiro`（会话落盘、settings、agents）
> 走的是它自己的文件 API，**不需要 codeg 经 ACP 代写**。因此把整个 `.kiro` 根开放给
> ACP 写入，其实是把「模型可驱动的写入面」扩大到了会话记录、agent 定义与 MCP 凭据 ——
> 而这三者都不是 agent 在对话中应当改写的东西。本需求据此**收窄为工作区 + 必要子路径**。

### Acceptance Criteria

8.1 THE 系统 SHALL 允许 Kiro 经 ACP 写入当前工作区目录之内的路径（与其余 12 个 agent 一致）。

8.2 THE 系统 SHALL 允许 Kiro 经 ACP 写入 `<KIRO_HOME>/sessions/` 之内的路径。

8.3 THE 系统 SHALL 拒绝 Kiro 经 ACP 写入 `<KIRO_HOME>/settings/`、`<KIRO_HOME>/agents/`
以及 `<KIRO_HOME>` 下 8.2 未列出的其余子目录。

8.4 WHEN 请求路径在规范化后落到允许范围之外 THE 系统 SHALL 拒绝该写入，
包括以 `..` 段构造的路径。

8.5 THE 系统 SHALL 在判定路径归属时对符号链接按其解析后的目标路径进行判定。

8.6 THE 系统 SHALL 对数据根解析遵循与其他 agent 相同的运行时重定位规则；
WHERE 运行时重定位生效 THE 系统 SHALL 以重定位后的根作为唯一边界，
且 SHALL NOT 同时保留重定位前的默认根为可写。

8.7 IF Kiro 在实机验证中因 8.3 的拒绝而无法正常工作 THEN 实现方 SHALL 记录被拒绝的具体路径
与操作，并将该路径按最小范围加入 8.2 的允许清单，而 SHALL NOT 直接放开整个 `<KIRO_HOME>`。

---

## Correctness Properties

**P-1 · 会话解析的事件映射与行级隔离**
For any 由合法行与非法行任意交错组成的 `.jsonl` 输入：(a) 解析不返回错误、不 panic；
(b) 输出的领域事件序列与输入中「合法 JSON 行」的顺序一一对应且保序（已知 `kind` 映射为对应事件，
未知 `kind` 映射为占位事件，非法 JSON 行不产生事件）；(c) 任一行的解析失败不影响其余行的输出。
_Validates: Requirements 3.2, 3.3, 3.6, 3.6.1, 3.6.2_

**P-1b · 工具结果的同轮不变式**
For any 事件序列，每个 `toolResult` 所归属的 `toolUse` 必与其处于同一轮次（轮次由 `Prompt` 起始、
由 `Clear` 终止）；不存在任何 `toolResult` 被归属到其所在轮次之外的 `toolUse`。
_Validates: Requirements 3.4, 3.4.1, 3.4.2, 3.4.3_

**P-2 · MCP 读写往返保真**
For any 合法的 Kiro MCP 配置对象 c，`read(write(c)) == c`；且 For any 配置 c 与任意服务器
条目 s，`remove(upsert(c, s), s.id)` 与 c 在除 s 以外的所有条目上逐字段相等，未识别字段一并保留。
_Validates: Requirements 4.2, 4.3, 4.4, 4.11_

**P-2b · 写入的原子性与冲突安全**
For any 配置 c 与任意写操作 w：若 w 在指纹校验或落盘的任一阶段失败，则目标文件的字节内容
与 w 开始前完全相同。且 For any 在读取与写入之间被外部修改过的文件，w 必返回冲突错误
且不改变文件内容。
_Validates: Requirements 4.9, 4.10_

**P-2c · 路径边界的封闭性**
For any 请求路径 p，若 p 规范化并解析符号链接后不在数据根之内，则写入被拒绝；
不存在任何以 `..` 段或符号链接构造的 p 能绕过该判定。
_Validates: Requirements 8.4, 8.5, 8.6_

**P-3 · 启动参数组合的完备性**
For all 模型、effort、授权模式、自定义 agent 四个维度的取值组合（含各自的「未设置」），
生成的 argv 中每个已设置维度恰好出现一次对应参数，未设置维度不出现，且 argv 首元素恒为
`acp`。
_Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.6, 6.7, 6.8_

**P-4 · 门禁的前置性**
For any 入口与配置项取值的组合，若准入判断为拒绝，则配置文件的字节内容在调用前后完全相同。
_Validates: Requirements 5.3, 5.4_

**P-5 · 门禁不外溢**
For all 非 Kiro 的 `McpAppType` 取值，门禁配置项的任意取值都不改变其读写结果。
_Validates: Requirement 5.5_

**P-6 · 注册完备性**
For all `all_acp_agents()` 返回的 agent，`registry_id_for` 与 `from_registry_id` 互为逆映射，
且 `get_agent_meta` 不 panic。
_Validates: Requirements 1.1, 1.2_

---

## 开放问题

- 无阻塞项。勘察阶段的三个开放问题已关闭（MCP 语义经官方文档核实为三层合并、
  `Compaction` 经实测为压缩检查点非轮边界、门禁降级为函数族层且支持局域网）。
- **实现前须实测确认（不阻塞 charter 定稿）**：`includeMcpJson` 的默认值 —— 官方文档只说明
  「设为 `true` 时额外包含 mcp.json 的 server」，未写默认值。这决定「agent 内嵌 `mcpServers`
  且未显式声明该字段」时全局配置是否仍生效，影响 R4.1.2/4.1.3 的展示标注是否准确。
  验证方式：临时建一个测试 agent，分别在声明/不声明该字段时观察 `/mcp` 的加载结果。

## 验证基线（executor 必读 · 2026-07-26 rebase 后实测重写）

- 仓库已 rebase 到上游 `e540a4fa`（v0.21.9）。
- 后端：`cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib`
  → **基线全绿：`1673 passed; 0 failed`，EXIT=0**。

  > **原「允许失败 8 项」waiver 已作废。** 上游 `df5ee401`
  > (`fix(acp): correct the fs write policy for Windows builds and tests`)
  > 修掉了那 8 个 `acp::file_system_runtime` 失败：根因确如本规格所记（测试 fixture 用
  > `/tmp/...` 字面量，Windows 下 `Path::is_absolute()` 返 false 被 fail-closed 守卫过滤成 `[]`），
  > 上游的修法是引入平台前缀 helper `absolute_path()`。**为 Requirement 8 新增的测试必须复用
  > 该 helper**，不要自己拼 `/tmp`，也不要照抄邻近旧写法。

  **验收判据（三条同时成立）**：
  1. `cargo test` EXIT=0，**零失败**（不再是集合比较——基线已无既有失败可豁免）。
  2. 本规格新增的所有测试全绿。
  3. 新增测试数量 > 0 且能指名对应的 AC / Property。

- 前端：`pnpm test` → EXIT=0 全绿；`pnpm build` → EXIT=0。跑测试前先清 `NODE_ENV`。
- 桌面 feature 的 `cargo check`（默认 feature）需要前端 `out/` 产物已存在，否则 build script 报
  `resource path ..\out doesn't exist`。这是既有构建顺序依赖，不是回归。
- **禁用 `cargo fmt` 的任何形式**：仓内无 `rustfmt.toml`，`cargo fmt --all -- --check` 实测重排
  90 文件 / 700 hunk；不带 `--all` 也覆盖整个 workspace。
- 本仓无 pre-commit hook（`core.hooksPath` 为空，`.git/hooks` 只有 sample），门禁全靠自查。
- **所有 file:line 已因上游 9 个 commit 漂移**：按符号名定位，不要按行号。
