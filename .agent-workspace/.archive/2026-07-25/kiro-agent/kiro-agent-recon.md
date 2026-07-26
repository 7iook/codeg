# Kiro Agent 接入 codeg — 现状勘察报告 (RECON)

> 勘察者：plan-reality-recon (只读，零代码改动)。日期 2026-07-26。
> 基线：`F:\codeg-research` @ `00bc59bc` (分支 `feat/kiro-agent`)，代码内容 == 上游 `2b017446`，**仓内零 Kiro 实现代码**。
> 所有 file:line 均为本轮实测（`git grep -n` / `read_file`），未验证项一律标 `unverified:`。

---

## 0 · 勘察方法与已跑命令

| 动作 | 命令 | 结果 |
|---|---|---|
| 仓状态 | `git log --oneline -3` | `00bc59bc` docs(kiro) → `2b017446` → `c181c56b` |
| 工作区 | `git status --porcelain` | `R docs/specs/kiro-agent-rebuild-spec.md -> docs/specs/kiro-agent-integration/background.md`；未跟踪 `docs/specs/README.md` + 一个 `.txt` |
| 后端测试 | `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib` | **EXIT=101**，1648 passed / **8 failed** / 1 ignored（详见 §4） |
| 定位 | `git grep -n "AgentType::Cursor" / "AgentType::KimiCode" -- src-tauri/src` | 见 §1 表 |

---

## 1 · 新增一个 agent 的完整注册点清单

参照样本：`Cursor`（最近新增，Binary dir-tree）、`KimiCode`（Npx，前端有专属配置面板）。

### 1.1 后端 · 编译强制（不改则 `cargo build` 直接失败）

这些都是**无 `_ =>` 兜底的穷尽 match / 定长数组**，加变体必然报错。

| 文件:行 | 构造 | 该 arm 决定什么 |
|---|---|---|
| `src-tauri/src/models/agent.rs:6` | `enum AgentType`（12 变体，`snake_case` serde） | 变体本体；serde 名 `kiro` |
| `src-tauri/src/models/agent.rs:23-37` | `impl Display` 穷尽 match（`:35` = Cursor arm） | 日志/DB 里的人类可读名 |
| `src-tauri/src/acp/registry.rs:163` | `registry_id_for` 穷尽 match | agent → ACP registry id 字符串（DB `agent_setting.registry_id` 的真源） |
| `src-tauri/src/acp/registry.rs:180` | `from_registry_id`（`_ => None` 有兜底 → **非**编译强制，但 `get_agent_meta:185` 的 `debug_assert_eq!` 会在 debug 下 panic）| 反向解析；漏了 = debug 断言炸 |
| `src-tauri/src/acp/registry.rs:189` | `get_agent_meta` 穷尽 match（Cursor arm `:452`） | 名称/描述/`supports_mcp`/distribution —— agent 的全部静态元数据 |
| `src-tauri/src/acp/connection.rs:396` | `build_agent` 的 `match meta.distribution`（Npx `:397` / Binary `:500` / Uvx `:687`） | 只在**新增 distribution 变体**时强制；复用既有变体则不强制 |
| `src-tauri/src/acp/file_system_runtime.rs:~460-520` | `agent_data_roots` 的 `match agent_type`（KimiCode `:486`、Cursor `:493`） | 该 agent 允许 `fs/*` 写的自有数据根（Kiro → `~/.kiro`）；**穷尽，编译强制** |
| `src-tauri/src/commands/conversations.rs:280` | `get_conversation` 的 parser 分派 | 会话详情用哪个 parser |
| `src-tauri/src/commands/conversations.rs:938` | 第二处 parser 分派（导出/批量路径） | 同上，独立的第二个 match |
| `src-tauri/src/db/service/import_service.rs:25` | `const ALL_PARSER_AGENTS: [AgentType; 12]` | **定长数组，长度写死 12** → 加变体必须改成 13 |
| `src-tauri/src/db/service/import_service.rs:41` | `build_parser` 穷尽 match | 导入时用哪个 parser |
| `src-tauri/src/commands/acp.rs:6780/6793` 附近 | `parse_provider_model` 的 `(base_url_env, api_key_env, model_env)` 三元组 match | 模型 provider 的 env 键名映射（KimiCode `:6780`、Cursor `:6793`）；**需核实是否有 `_ =>` 兜底** `unverified: 未逐字读该 match 的兜底 arm` |
| `src-tauri/src/commands/mcp.rs:2447` | `read_servers_for_agent_type` 穷尽 match（KimiCode `:2456`、Cursor `:2458`、Pi `:2461` 返空） | 该 agent 的原生 MCP 配置从哪读 |
| `src-tauri/src/commands/mcp.rs:50` | `enum McpAppType`（**11 变体，比 AgentType 少 Pi**） | MCP 面板的 app 维度。**加 Kiro 到这里会连带 4 处穷尽 match**：`:2427 upsert_server_for_app`、`:3365 remove_server_for_app`、`:2333-2409 scan_local_servers`（11 段手写 for 循环）、`:404-414` 与 `:479-489` 两处手写全量 `vec![]` 默认列表 |

**`McpAppType` 的实际语义**（实测，纠正旧规格「11 处穷尽 match 无兜底」的粗略说法）：`git grep -c McpAppType -- commands/mcp.rs` = **74 处引用**；其中真正的穷尽 match 是 `upsert_server_for_app` / `remove_server_for_app` 两处（编译强制），另有两处**手写全量列表**（`:404-414` `mcp_add_server` 默认 apps、`:479-489` `mcp_remove_server` 的 `None` → 全量）和一处**手写 11 段循环**（`scan_local_servers`）—— 这三处**不改也能编译**，属静默降级（见 1.2）。

### 1.2 后端 · 非编译强制（不改则静默降级，风险更高）

| 文件:行 | 构造 | 漏改后果 |
|---|---|---|
| `src-tauri/src/acp/registry.rs:131` `all_acp_agents()` | 手写 `vec![]` 12 项 | **Kiro 完全不出现在 agent 列表/设置页**，前端拿不到它。最致命的静默漏项 |
| `src-tauri/src/db/service/agent_setting_service.rs:28` `default_enabled()` | `matches!` 12 项，无兜底 arm 但 `matches!` 对未列变体返 **false** | Kiro 的 `agent_setting.enabled` 默认 **false** → 界面上灰着不能用，却零报错 |
| `src-tauri/src/commands/experts.rs:780` `const ALL: &[AgentType]` | 切片字面量（**非定长数组**）12 项 | Kiro 不出现在 expert/skill 关联列表。注意后面 `.filter(skill_storage_spec().is_some())` → 若 Kiro 无 skill spec 则本就被过滤，此项**影响为零**（可不改） |
| `src-tauri/src/commands/office_tools.rs:1050` 同构 `const ALL` | 同上 | 同上（同样被 skill_storage_spec 过滤） |
| `src-tauri/src/commands/science.rs:610` 同构 `const ALL` | **只有 10 项**（缺 Grok / Cursor）—— 上游自己就漏登记了 | 证据：science.rs 的列表止于 `AgentType::Pi`。说明这类 `const ALL` 是已知会漏的模式，**不是必改项** |
| `src-tauri/src/acp/connection.rs:2099-2104` `load_mcp_servers_for_agent` skip 名单 | `matches!(Hermes\|KimiCode\|Grok\|Cursor)` | 漏加 Kiro → codeg 会把用户 MCP 服务器再经 ACP 线缆转发一次，而 Kiro 已从 `~/.kiro` 原生加载 → **双重注册** |
| `src-tauri/src/commands/acp.rs:5952/5988` `skill_storage_spec` | `Option` 返回，有兜底 | 不加 = Kiro 无 skill 能力（可接受，Pi 同样如此） |
| `src-tauri/src/acp/types.rs:681,686` | 注释里写死「Only populated for `AgentType::Cursor`」的字段 | 说明专属面板字段走 `Option` 扩展，不是穷尽结构 |
| `src-tauri/src/commands/acp.rs:5752` `AgentType::KimiCode => Some(kimi_code_config_toml_path())` | 配置文件路径 match | 有兜底；不加 = 无「原生配置文件」编辑入口 |

### 1.3 前端注册点（TypeScript，全部**非编译强制**除 `Record<AgentType,…>`）

| 文件:行 | 构造 | 性质 |
|---|---|---|
| `src/lib/types.ts:1-13` | `type AgentType` union | 加 `"kiro"`；这是下面所有 `Record<AgentType,…>` 的驱动源 |
| `src/lib/types.ts:887` `AGENT_LABELS: Record<AgentType,string>` | **Record → tsc 强制** | 不加 = `tsc` 报错 |
| `src/lib/types.ts:902` `AGENT_COLORS: Record<AgentType,string>` | **Record → tsc 强制** | 同上 |
| `src/lib/types.ts:570` `AGENT_DISPLAY_ORDER: AgentType[]` | 数组，**非强制** | 漏 = 排序落到 `MAX_SAFE_INTEGER`，排最后（静默） |
| `src/lib/types.ts:595` `ALL_AGENT_TYPES: AgentType[]` | 数组，**非强制** | 漏 = 多处「遍历所有 agent」的 UI 不含 Kiro（静默，高危） |
| `src/lib/types.ts:610` `MODEL_PROVIDER_AGENT_TYPES` | 只含 claude/codex/gemini | 不需改 |
| `src/lib/types.ts:2235` `type McpAppType` union（11 项） | 与后端 `McpAppType` 对偶 | 若后端加 Kiro 必须同改 |
| `src/components/agent-icon.tsx:392` `COLOR_ICONS` map | 若为 `Record<AgentType,…>` 则强制，否则静默无图标 `unverified: 未读该 map 的类型标注` |
| `src/components/settings/mcp-settings.tsx:97` `{ value:"kimi_code", label:"Kimi Code" }` | **手写 APP_OPTIONS 数组** = MCP 面板 app 复选框的唯一驱动 | 漏 = Kiro 不出现在 MCP 面板 |
| `src/components/settings/mcp-settings.tsx:263` `kimi_code: appSet.has("kimi_code")` | 手写勾选状态对象 | 漏 = 勾选态恒 false |
| `src/components/settings/delegation-agent-defaults.tsx:66` | 手写 agent 白名单数组 | 漏 = Kiro 不能被委派 |
| `src/components/settings/acp-agent-settings.tsx:9887` | `selectedAgent.agent_type === "kimi_code" ? <KimiCodeConfigPanel/> : …` 长三元链 | 专属配置面板挂载点；不加 = 无 Kiro 面板 |
| `src/lib/api.ts:569` | `acp_update_kimi_code_config` 之类的 per-agent command 封装 | 只有做专属面板才需要 |

### 1.4 穷尽性以外的注册表

- **i18n（有硬门禁，必须同步 10 个 locale）**：`src/i18n/messages/{ar,de,en,es,fr,ja,ko,pt,zh-CN,zh-TW}.json` 共 **10 个文件**。`src/i18n/messages.test.ts` 以 `en.json` 为 SSOT 做**全 key 集合双向 diff**（`missing` + `extra` 都必须为空）→ 只加 `en.json` 会让 9 个 locale 测试**全红**。Kiro 面板需要的 key 路径按 KimiCode 样本推断为 `kiro.*`（面板文案）+ `actions.saveKiroConfig` + `toasts.kiroSaved/saveKiroFailed`；具体条目取决于面板做多少控件。
- **图标资源**：无独立资源文件，图标是 `src/components/agent-icon.tsx` 内联的 React memo 组件（`KimiCodeColorIcon:288`），加变体 = 在该文件加一个组件 + 一行 map。
- **feature flag**：未发现 agent 维度的 feature flag 表。`unverified: 仅按 grep "feature_flag|featureFlag" 无命中做的判断，未穷尽搜索`
- **web handler 对偶层（旧规格未提及，本轮新发现）**：`src-tauri/src/web/handlers/mcp.rs:8,36,48,55,62` 复用了 `McpAppType`（HTTP 侧 DTO）。这是 `codeg-server` 二进制的路由层，与 Tauri command 并列的**第二个入口**——旧规格 §W2 列的「5 个 MCP 入口」是 Tauri 侧的；HTTP 侧同样能触达 upsert/remove/set_apps，**做安全门禁时必须一并覆盖**，否则从浏览器走 3080 端口即可绕过。

---

## 2 · `SystemBinary` 落点评估

### 2.1 distribution 被 match 的全部位置（实测 `git grep -n "AgentDistribution::"`）

**生产代码穷尽 match（新增第四变体全部编译报错，共 8 处）：**

| 文件:行 | 函数 | 该 arm 的语义 |
|---|---|---|
| `acp/connection.rs:397` | `build_agent` | 构造 argv + env → 启动进程。**动态 argv 的唯一收口点** |
| `acp/preflight.rs:60` | `run_preflight` | 装前环境检查（Npx→node、Binary→平台+缓存、Uvx→uv） |
| `commands/acp.rs:467` | `verify_agent_installed` | **连接闸门**。Npx→`is_cmd_available`；Binary→平台+缓存(+dir_entry 时 PATH 回退)；Uvx→`uvx_agent_launchable` |
| `commands/acp.rs:589` | `detect_local_version` | 列表页版本探测 |
| `commands/acp.rs:865` | `build_agent_diag`（诊断报告） | 诊断页 launchable/distribution 字符串 |
| `commands/acp.rs:1245` | `launch_label` | UI 上「怎么启动的」标签 |
| `commands/acp.rs:7891` | `(available, installed_version)` | 设置页 agent 列表状态 |
| `commands/acp.rs:7967` | `(available, dist_type, local_installed_version)` | 第二处列表/状态投影 |
| `acp/registry.rs:98` | `registry_version()` | 三变体 or-pattern 取 `version` 字段 —— **新变体没有 `version` 字段就得单独 arm** |

**非穷尽（`match ... => x, _ => ...` 或只关心 Binary，加变体不报错）：**
- `acp/binary_cache.rs:274`、`acp/preflight.rs:408` —— 都是 `match ... { Binary{dir_entry} => dir_entry, _ => None }` 形态（`unverified: 未逐字读兜底 arm，但两处均只取 dir_entry，形态上必有兜底`）。
- `commands/acp.rs:5111` —— `if let Uvx{..} = meta.distribution`，非 match。
- `acp/registry.rs:519/545/571/603/621` —— 测试内的 match，加变体不影响（除非新增测试）。

### 2.2 `Uvx.system_cmd` 这条 PATH 回退能否直接复用

**不能直接复用，但它是最贴近的现成语义。** 实测 `build_agent` 的 Uvx 分支（`connection.rs:688-750`）逻辑是：

1. `resolve_uvx_command()` 命中 → 走 `uvx --from <package> <cmd>`（**主路径，Kiro 完全不需要**）
2. 否则 `system_cmd` → `resolve_command_on_path(c)` → 直接跑 PATH 上的 `<cmd> <args>`（**这正是 Kiro 需要的**）
3. 都没有 → `SdkNotInstalled`

复用 `Uvx` 的代价：必须给 Kiro 编一个假的 `package`（`--from` 规格）+ 假 `uv_required`；且**如果机器上装了 `uv`，第 1 条会优先命中**，codeg 会去 `uvx --from <假包名> kiro-cli acp` —— 直接失败。这不是「多一点脏」，是**功能性错误**。同理 `preflight.rs:72 check_uv_environment` 会去检查 uv 版本，`detect_local_version:613` 会走 `binary_cache::uvx_prepared_version`（查 codeg 自己的缓存目录，Kiro 永远为空 → 列表恒显示未安装）。

### 2.3 `binary_cache` / `preflight` / `remote_registry` 是否假定「所有 agent 都有可下载产物」

- **`binary_cache.rs`**：只被 `Binary` / `Uvx` 分支调用（`:274` 只取 `Binary.dir_entry`；`uvx_prepared_version` 查缓存目录）。它不遍历全部 agent，**没有「人人都有产物」的隐含假设**；新变体只要不调用它即可。
- **`preflight.rs:60`** 是穷尽 match，新变体必须给一个 arm。Kiro 的 arm 应当只做「PATH 上能否 resolve 到 `kiro-cli`」这一项检查（可复用 `check_binary_environment` 的部分，但那个函数签名要 `platforms`）。`preflight.rs:408` 同 `binary_cache`，只关心 dir_entry。
- **`remote_registry.rs`**：`unverified: 该文件在本次 grep 的 AgentDistribution:: 命中列表中零出现`，说明它不按 distribution 分派；是否遍历 `all_acp_agents()` 去拉远端清单未核实。

### 2.4 三条路的改动面对比（结论）

| 方案 | 编译强制改动处 | 副作用 / 风险 |
|---|---|---|
| **A · 新增 `SystemBinary` 变体**（旧规格 D1） | **9 处**（§2.1 上表 8 处 + `registry.rs:98 registry_version`） | 语义干净：每处 arm 都能写「PATH resolve + `--version`」的正确逻辑。风险=改动面最大，且 `registry_version()` 的 or-pattern 需要决定 Kiro 有没有「registry 版本」概念（Kiro 版本由系统安装决定，codeg 不 pin → 建议 `None`，但那会让「有版本 pin」的 UI 分支需要处理 `None`）。**这是 9 处编译错误，`cargo build` 逐个报，不会漏。** |
| **B · 复用 `Binary` + 特殊 platforms** | **0 处**编译强制 | 需要伪造 `platforms`（6 个平台都填一个假 URL）+ `dir_entry: Some(...)` 才能触发 PATH 回退。**致命副作用**：`platforms` 的假 URL 会进「安装/升级」按钮通路（`commands/acp.rs` 的 install 流程按 platform URL 下载）→ 用户点安装 = 下载一个不存在的 URL；`dir_entry` 会让 `binary_cache` 认为它是 dir-tree 归档。属于「静默塞进错语义」，编译器一处不报，全靠人记住。 |
| **C · 复用 `Uvx.system_cmd`** | **0 处**编译强制 | 见 §2.2：装了 `uv` 的机器会走错主路径 → 连接必失败；`detect_local_version` 走 uvx 缓存 → 列表恒「未安装」；preflight 检查 uv 版本 → 误报。**功能性错误，不只是脏。** |

**勘察结论**：旧规格 D1（新增 `SystemBinary`）经本轮独立核实**成立**，理由比旧规格写的更硬 —— 不是「硬塞语义不清」而是 B/C 两条都会产生**可复现的功能性错误**（B 的假下载 URL、C 的 uv 抢路）。代价是 9 处编译错误，全部由 `cargo build` 强制暴露，**不存在静默漏项风险**，反而比 B/C 安全。

---

## 3 · MCP 配置读写通路

### 3.1 codeg 侧完整函数族（`src-tauri/src/commands/mcp.rs`，本轮实测行号）

**分派入口（3 个，都是穷尽 match）**

| 行 | 函数 | 分派维度 |
|---|---|---|
| `:2443` | `read_servers_for_agent_type(AgentType)` | **`AgentType`**（12 项，Pi 返空 map） |
| `:2427` | `upsert_server_for_app(McpAppType, id, spec)` | **`McpAppType`**（11 项） |
| `:3365` | `remove_server_for_app(McpAppType, id)` | **`McpAppType`**（11 项） |

**per-agent 读函数（`fn read_*_servers() -> Result<BTreeMap<String,Value>>`）**

| agent | 读函数 | 路径函数 / `_at` 变体 |
|---|---|---|
| Claude | `:1546` | — |
| CodeBuddy | `:1703` | — |
| Codex | `:1832` | — (TOML) |
| OpenCode | `:1962` | — |
| Gemini | `:2069` | — |
| OpenClaw | `:2144` | — |
| Cline | `:2239` | — |
| KimiCode | `:2484` | 路径 `:2480 kimi_code_mcp_json_path()`，可测变体 `:2536 read_kimi_code_servers_at(&Path)` |
| Grok | `:2907` | 可测变体 `:2911 read_grok_servers_at` |
| Cursor | `:3015` | 路径 `:3007 cursor_mcp_json_path()`，可测变体 `:3019 read_cursor_servers_at` |
| Hermes | `:3238` | — (YAML) |

**模式**：新 agent 需要一组 `<agent>_mcp_json_path()` / `read_<agent>_servers()` / `read_<agent>_servers_at(&Path)` / `upsert_<agent>_server(id,spec)` / `remove_<agent>_server(id)` —— 后两个由 `:2427` / `:3365` 的 match 编译强制。**`_at(&Path)` 变体是 KimiCode/Grok/Cursor 三家的既有约定**（便于测试注入临时路径），Kiro 应沿用。

**聚合与全量入口（非穷尽，静默漏项高危）**

| 行 | 名称 | 性质 |
|---|---|---|
| `:2332` `scan_local_servers()` | **11 段手写 for 循环**（`:2335` Claude … `:2409` Cursor），每段 `read_X_servers()? → merged.entry().apps.insert(McpAppType::X)` | 通用 MCP 面板「本机已有服务器」列表的唯一数据源。漏加 = Kiro 的服务器不出现（也就天然不外泄明文 —— 对 Kiro 反而是想要的） |
| `:404-414` | `mcp_add_server` 的默认 apps 全量 `vec![]` 11 项 | 手写列表 |
| `:479-489` | `mcp_remove_server(apps=None)` 的「删所有 app」全量 11 项 | 手写列表 |
| `:433` `mcp_set_server_apps(server_id, apps: Vec<McpAppType>)` | 见下 | |
| `:472` `mcp_remove_server(server_id, apps: Option<Vec>)` | | |
| `:504` `normalize_apps(Vec<McpAppType>) -> Vec<McpAppType>` | 去重/排序 | |
| `:518` `app_can_host_spec(app, spec) -> bool` | **唯一的「该 app 能否承载此 transport」校验**：`:520` 只有一条规则 `!(app == Codex && is_sse)` | 新 agent 若有 transport 限制在此加 |

### 3.2 `mcp_set_server_apps(:433)` 的 app key 枚举/校验实测

`apps: Vec<McpAppType>` 由 **serde 反序列化**（`McpAppType` 是 `snake_case` 枚举）→ 前端传的字符串不在枚举内则**反序列化失败**，不需要额外白名单。流程（`:437-468`）：

1. `normalize_apps(apps)` 去重
2. `app_can_host_spec` 过滤掉不能承载该 transport 的 app
3. 若显式选了 app 但**全被过滤空** → `:454` 提前 `Err`（防止「静默删空」）
4. `current_set.difference(&target_set)` → 逐个 `remove_server_for_app` （**先删**）
5. `target_set.difference(&current_set)` → 逐个 `upsert_server_for_app` （**后写**）

**旧规格 §W2 的「非原子数据损失」指控经本轮核实成立**：`:460-466` 是「先删旧 app 再写新 app」，中间任一 `?` 早退（例如 Kiro 分支返 `Err`）会留下「旧配置已删、新配置未写」的状态。这不是 Kiro 引入的，是**上游既有性质**；但若为 Kiro 加「拒绝」门禁，就必须**前置拒绝**（在 `:437` 之前），否则真会踩。

### 3.3 前端 app 列表如何驱动

`src/components/settings/mcp-settings.tsx:97` 一个**手写常量数组** `{ value: "kimi_code", label: "Kimi Code" }`（每个 app 一行），`:263` 一个手写的 `{ kimi_code: appSet.has("kimi_code"), ... }` 勾选状态对象。它消费的是 `McpAppType`（`src/lib/types.ts:2235` 的 11 项 union）**而不是 `AgentType`** —— 与旧规格 §5 #6 所记 executor 的判断一致。

### 3.4 Kiro 自己的 MCP 配置文件（本机实测，**有两个**）

旧规格只写了 `~/.kiro/settings/mcp.json`。实测**存在两个 MCP 配置文件，格式相同、内容不同**：

**A · `C:\Users\7\.kiro\settings\mcp.json`**（2569 字节，8 个 server，含 `.bak-20260704-reqable` / `.bak.20260524` 两个备份）

```jsonc
{
  "mcpServers": {
    "ace-local": {
      "command": "E:\\code-search-tools-bundle\\ace-tool-rs\\target\\release\\ace-tool-rs.exe",
      "args": ["--base-url", "http://127.0.0.1:8000", "--token", "<REDACTED>", "--no-webbrowser-enhance-prompt"],
      "env": { "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost" },
      "disabled": false,
      "autoApprove": ["*"]
    },
    "mcphub": { "command": "cmd", "args": ["/c","npx","-y","mcp-remote","http://localhost:3799/mcp"],
                "autoApprove": ["*","desktop-commander-start_process"], "disabled": false },
    "desktop-commander": { "command": "node", "args": ["…\\dist\\index.js"], "disabled": true,
                "autoApprove": ["*"], "disabledTools": ["get_prompts", "…"] }
    // 另有 playwright / chrome-devtools / ida / x64dbg / reqable
  }
}
```

**B · `C:\Users\7\.kiro\mcp_config.json`**（278 字节，1 个 server：`ida-pro-mcp`，仅 `command` + `args`）

**两者的关系（关键，影响 codeg 该写哪个）**：`C:\Users\7\.kiro\agents\main.json` 里有 `"useLegacyMcpJson": true` 字段 —— 说明 Kiro CLI 有「legacy mcp.json」与「新 mcp_config.json」两套，**由 agent 配置逐个决定读哪个**。这意味着：codeg 若只写一个文件，对开了/没开 `useLegacyMcpJson` 的 agent 效果不同。`unverified: 未确认 useLegacyMcpJson=true 对应的是 settings/mcp.json 还是 mcp_config.json`（未做写入实验，避免污染用户真实配置）。

**字段 schema（两文件共有）**：`command`(string) / `args`(string[]) / `env`(object) / `disabled`(bool) / `autoApprove`(string[]) / `disabledTools`(string[])。与 Claude-shaped 一致但**多出 `autoApprove` / `disabledTools` / `disabled` 三个 Kiro 特有字段** → codeg 的读写必须保留未知字段（旧规格 §W2 的这条要求成立且有实证）。**`args` 里可以藏 token**（本机 `ace-local` 的 `--token <REDACTED>` 就是），所以脱敏**不能只看 `env`** —— 旧规格只提「含明文 env」，**本轮发现 `args` 同样是 secret 载体，这是旧规格的实质漏洞**。

**Kiro CLI 自己的 MCP 管理命令（实测 `kiro-cli mcp --help`, EXIT=0）**：
```text
kiro-cli mcp add | remove | list | import | status
  add --name --scope <default|workspace|global> --command --url --args --agent --env
      --timeout --disabled --force
```
`--scope` 帮助原文：「This parameter is only meaningful in the absence of agent name」；`--agent` 帮助原文：「If an agent name is not supplied, the changes shall be made to the global mcp.json」。→ **存在 agent 级 MCP 配置**（`~/.kiro/agents/*.json` 内）与 global 两层。`kiro-cli mcp list` 实测 **可用**（主 AI 复核更正：本报告初稿记 EXIT=-1 无输出，实为 stdout 被 stderr 的
`INFO chat_cli::util::paths` 日志淹没导致误判）。实测输出为 `• ida / • mcphub / • reqable` 三条 ——
**正是 `settings/mcp.json` 的内容**（`mcp_config.json` 只有 `ida-pro-mcp` 一条，不匹配）。
→ **`useLegacyMcpJson: true` 对应 `~/.kiro/settings/mcp.json`，该文件即 codeg 的写入目标**，
旧规格 D3 路径判定成立，此项不再是开放问题。
但该命令输出与 stderr 混排，作为**解析通路**仍然脆弱 → codeg 仍应直接读文件，结论不变。

---

## 4 · 验证基线（真跑，带 exit code）

### 4.1 后端 · `cargo test --no-default-features --lib` → **EXIT=101（基线就是红的）**

```text
cd F:\codeg-research
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib
→ test result: FAILED. 1648 passed; 8 failed; 1 ignored; finished in 20.07s
  EXIT=101
```

失败的 8 个全在 `src-tauri/src/acp/file_system_runtime.rs`：
```text
agent_data_roots_honor_runtime_env_relocation
blank_runtime_value_falls_through_to_the_next_candidate
cursor_relocation_respects_resolver_precedence
pi_session_dir_relocation_is_honored
relative_extra_roots_are_dropped
relocation_excludes_the_inactive_default_root
relocation_suffixes_match_the_agents_own_resolvers
whitespace_padded_extra_root_is_not_trimmed_into_filesystem_root
```

**根因已定位（不是 flaky、不是环境脏、与 Kiro 无关）**：这 8 个测试全部用 `/tmp/...` 形态的硬编码 Unix 路径做输入（例：`:1735` 断言 `["/tmp/codeg-abs-extra"]`，`:1291` `let relocated = PathBuf::from("/tmp/codeg-relocated-agent-home")`）。生产代码 `extra_write_roots():211` 与 `agent_data_roots` 用 `path.is_absolute()` 过滤非绝对路径。实测（`rustc` 现编现跑）：

```text
Path::new("/tmp/x").is_absolute()  →  Windows: false
```

→ 所有输入被过滤成 `[]`，断言失败。这些测试来自 `2b017446`（2026-07-25，上游最新提交，`file_system_runtime.rs` 一次加了 1576 行），**是上游作者在 Unix 上写的、从未在 Windows 上跑过的测试**。

**对 charter 的影响（重要）**：
- 「1590 / 1648 全绿」这个基线在 Windows 上**不存在**。后续任何「测试全绿」的验收标准必须改成「**8 个已知失败之外全绿**」，否则每个 executor 都会以为自己弄坏了东西并去乱修。
- 反过来：Kiro 需要在 `agent_data_roots` 加一个 arm（§1.1），而该函数的测试**当前就是红的** → 给 Kiro 写的新测试若也用 `/tmp` 就会立刻红。**Kiro 的测试必须用 `std::env::temp_dir()` 或 `cfg!(windows)` 分支**。
- 旧规格 §6 记「W0 1590 → … → 权限模式 1701」：数字量级与本轮 1648 一致（上游又长了些），但**它没提 8 个 Windows 失败** → 说明上一轮或没在 Windows 跑、或跑在 `2b017446` 之前（该提交是 7-25 的，上一轮基线是 `692d6eb`/`c181c56b`，确实更早）。**该字段判定为「已失效」**。

### 4.2 前端 · `pnpm test`（= `vitest run`）→ **EXIT=0，全绿**

```text
cd F:\codeg-research
Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue   # §3 坑③ 预防
pnpm test
→ Test Files  218 passed (218)
       Tests  2728 passed (2728)
    Duration  31.53s
  EXIT=0
```
（旧规格记 2683 → 现 2728，正常增长。）

### 4.3 `cargo fmt --all` 的真实影响 → **旧规格 §3① 成立，且比它说的更严重**

```text
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
→ EXIT=-1（PowerShell 对 exit 1 的呈现）
   UNIQUE_FILES=90    HUNKS=700
```

即：`--all` 会重排 **90 个文件、700 个 hunk**。旧规格写「一跑重排 90 文件」—— **数字精确命中**。仓内**无 `rustfmt.toml`**（`src-tauri/` 与仓根都没有），所以用的是 rustfmt 默认风格，而代码是手写风格 → 差异是结构性的，不会自己收敛。

**结论**：`cargo fmt` 在这个仓**任何形式都不能用**（不只是 `--all`；`cargo fmt` 默认就是整个 workspace）。唯一安全用法是 `rustfmt --check <单文件>` 之类的手动限定，或者干脆只手写规范格式。

### 4.4 pre-commit hook → **不存在**

```text
git config core.hooksPath  →  (空)
Test-Path F:\codeg-research\tools  →  False
.git\hooks\  →  只有 14 个 *.sample，零启用 hook
```

**旧规格与主 AI 提示中的 `tools/git-pre-commit.ps1` 在这个仓不存在**（那是 `ecom-copilot` / `license-platform` 的设施）。→ **codeg-research 无任何提交门禁**：格式、大文件、swallow、layering 全无检查，提交前的验证完全靠人/AI 自觉。charter 若想要门禁，属于**新建**而非复用。

---

## 5 · 工作包切分建议（按共享文件冲突面）

### 5.1 冲突面矩阵（哪些文件被多个逻辑关注点同时改）

| 文件 | 被谁改 | 冲突级别 |
|---|---|---|
| `acp/registry.rs` | 基座（枚举+meta+3 处 id match） | **单点独占**，必须最先做 |
| `models/agent.rs` | 基座 | 单点独占 |
| `acp/connection.rs` | ① `build_agent` 新 distribution 分支 ② `load_mcp_servers_for_agent:2099` skip 名单 ③ 启动参数（model/effort/权限）④ `apply_kiro_env_policy` | **最热点，4 个关注点全在一个文件** |
| `commands/acp.rs`（13149 行） | `verify_agent_installed:467` / `detect_local_version:589` / `build_agent_diag:865` / `launch_label:1245` / `:7891` / `:7967` / 可能的 `acp_kiro_list_models` 新 command | **第二热点，6+ 处** |
| `commands/mcp.rs`（5500+ 行） | 读写函数族 + 3 处分派 match + 门禁 | 独立关注点，与上面两个不重叠 |
| `acp/file_system_runtime.rs` | `agent_data_roots` 一个 arm | 独立，改动极小 |
| `parsers/kiro.rs`（新建） | 会话解析 | **全新文件，零冲突** |
| `commands/conversations.rs` + `db/service/import_service.rs` | 挂 parser（4 处） | 依赖 parser 存在 |
| `src/lib/types.ts` | 前端基座（6 处） | 前端热点 |
| `src/components/settings/acp-agent-settings.tsx`（9900+ 行） | 专属面板 | **超大文件，若面板拆多包必冲突** |
| `src/i18n/messages/*.json` × 10 | 任何加文案的包 | **10 文件 × N 包 = 必冲突**，且有 key 集合门禁测试 |

### 5.2 波次建议

```text
W0 【串行头 · 单包独占】基座
    registry.rs + models/agent.rs + 新 SystemBinary 变体
    + 因新变体产生的 9 处编译错误全补（先用 Err/占位，不实现业务）
    + file_system_runtime.rs 的 agent_data_roots arm
    验收：cargo build EXIT=0；cargo test 仍然只有已知 8 红
    ↓ 其余全部依赖 W0（新枚举变体不存在时其他包无法编译）

W1 【三路可真并行 —— 零共享文件】
  P1 会话解析      parsers/kiro.rs(新建) + parsers/mod.rs 一行
                   → 完成后再由 W1.5 挂载
  P2 MCP 读写      commands/mcp.rs 全部（函数族 + 3 处 match + 门禁）
                   + web/handlers/mcp.rs（HTTP 侧对偶入口）
  P3 前端登记      src/lib/types.ts + agent-icon.tsx + mcp-settings.tsx
                   + delegation-agent-defaults.tsx
                   ⚠️ 不含 i18n 新增（见下）
    冲突面：P1/P2/P3 三者零共享文件。P2 与 P3 都碰 McpAppType 的两侧
            （后端 enum vs 前端 union）→ **契约先定死再并行**，
            否则前后端 serde 名不一致 = 静默 400

W1.5【串行 · 极小】parser 挂载
    commands/conversations.rs(2 处) + db/service/import_service.rs(2 处 + 数组长度 12→13)
    必须在 P1 之后（要 KiroParser 类型存在）

W2 【必须串行 —— 都改 connection.rs】
  S1 启动链       connection.rs build_agent 的 Kiro 分支
                  + commands/acp.rs 的 6 处 distribution match 实装
  S2 MCP skip     connection.rs:2099 skip 名单加 Kiro
  S3 env policy   connection.rs apply_kiro_env_policy + 启动参数收口
    → S1/S2/S3 全在 connection.rs，**同一波必须由同一个 executor 串行做**，
      或拆成 3 次顺序提交。切给 3 个 AI 并行 = 必然 merge 冲突

W3 【串行尾 · 单包独占】前端专属面板 + i18n
    acp-agent-settings.tsx 面板 + api.ts + 10 个 locale JSON
    ⚠️ i18n 必须最后一次性做完：messages.test.ts 做 en↔9 locale
       全 key 双向 diff，任何中途状态都是红的 → 不可拆包、不可并行
```

**关键约束（给主 AI 派发时的硬规则）**：
1. **`connection.rs` 全程只允许一个 executor 持有**。它是 9929 行的单文件，4 个关注点都落在里面。
2. **`commands/acp.rs`（13149 行）同理**，6 处 distribution match 分散在 `:467 / :589 / :865 / :1245 / :7891 / :7967`，跨度 7000 行，但同文件。
3. **`src/i18n/messages/*.json` 是原子包**，因 key 集合门禁测试不容许部分状态。
4. **W1 三路并行前必须先冻结 `McpAppType` 契约**（后端 enum 变体名 ↔ 前端 union 字符串 ↔ `mcp-settings.tsx` 的 `value`），三处都是手写、无编译器保护。

---

## 5.5 · 会话格式：两套并存（**修正主 AI 简报中的一处关键误判**）

主 AI 简报断言「旧规格记的 `Prompt/AssistantMessage/ToolResults/Clear` 已完全失效」。**本轮实测：该结论不成立 —— 那套格式活着，而且正是 CLI 会话的格式。** 简报描述的 `sessions/<hash>/sess_<uuid>/{session.json,messages.jsonl}` 是**另一套格式（IDE/spec 会话）**，两者并存于同一 `~/.kiro/sessions` 树下。

**实测结构（`C:\Users\7\.kiro\sessions`）**：

```text
~/.kiro/sessions/
├── cli/                          ← CLI 会话（kiro-cli），扁平
│   ├── <uuid>.jsonl              921 个   ← 旧规格格式，仍在写
│   ├── <uuid>.json               920 个   （元数据）
│   ├── <uuid>.history            389 个
│   ├── <uuid>.lock               485 个
│   ├── <uuid>                    157 个（无扩展名目录）
│   └── <uuid>.tmp                1 个
└── <16位hex workspace hash>/     13 个    ← IDE / spec 会话
    └── sess_<uuid>/  或  <uuid>/           （163 个会话目录）
        ├── session.json          99 个（schemaVersion 1.0.0，字段见简报）
        ├── messages.jsonl                  ← payload.type 形态（简报所述）
        ├── publish.cursor / publish-sub.cursor
        └── sub-executions/<uuid>.jsonl     ← 子 agent 轨迹，独立文件
```

**活跃度对比（决定 codeg 该解析哪套）**：

| | CLI 格式 | IDE 格式 |
|---|---|---|
| 最新写入 | **2026-07-26 00:26**（正在用） | 2026-07-25 19:25 |
| 最早 | 2026-05-12 | — |
| 会话数 | **921** | 163（99 个有 session.json） |
| 单文件最大 | **33.4 MB** | 4.76 MB |

**CLI `.jsonl` 顶层 kind 实测分布（regex 扫最大 40 个文件，共 33055 行）**：
```text
16504 AssistantMessage
14681 ToolResults
 1823 Prompt
   38 Compaction     ← 旧规格未记载的第 5 种 kind
    9 Clear          （40 个文件中只有 7 个含 Clear）
```
行首形态固定 `{"version":"v1","kind":"...","data":{...}}` —— **与旧规格 §2 W1-P2 记载逐字一致**。

**`data.content[].kind` 内层实测（单文件 1500 行）**：`text` 408 / `thinking` 195 / `toolUse` 364 / `toolResult` 363 —— 也与旧规格一致（`image` 该样本未出现）。

**`.json` 元数据**：`session_id` / `cwd` / … 与旧规格一致（首字段实测命中）。

**对 charter 的三点影响**：
1. **旧规格 D2 的格式判定成立**，`~/.kiro/sessions/cli/<uuid>.jsonl` 就是目标，**不要按简报改去解析 `payload.type`**。旧规格路径写 `cli/<uuid>.jsonl` 正确。
2. **新增第 5 种顶层 kind `Compaction`**（38 次，出现在 3/3 抽样大文件里）—— 旧规格的 4-kind 清单**不完整**。
**主 AI 已复核其结构**：`data = {summary, strategy, messages_snapshot}` —— 是**上下文压缩检查点**，
`summary` 内含压缩后的正文（实测单条 43KB，可能含用户 steering 全文），`messages_snapshot` 是压缩前快照。
→ **判定：不是轮次边界**（`Clear` 才是），parser 应渲染为一条独立的压缩记录并做长度截断。此项不再是开放问题。
3. 若同时想支持 IDE 会话（简报描述的那套），那是**第二个 parser**，旧规格 D2 已明确 out-of-scope，本轮无理由推翻。

**Kiro CLI 版本**：实测 `kiro-cli-chat 2.14.2`（EXIT=0），旧规格记 2.12.1 → **已漂移**；但「`--version` 输出带 `kiro-cli-chat ` 前缀」这个结构成立，`strip_version_prefix` 的设计仍然对。

---

## 6 · 旧规格可信度评估（逐节）

> 旧规格 = `F:\codeg-research\docs\specs\kiro-agent-integration\background.md`（356 行）。

### 6.1 §1 七项决策

| # | 判定 | 依据 |
|---|---|---|
| **D1** 新增 `SystemBinary` | ✅ **成立，且理由更硬** | §2.4：复用 Binary 会产生假下载 URL、复用 Uvx 会被 `uv` 抢主路径。代价 9 处编译错误，全部由编译器暴露 |
| **D2** 只做 CLI 会话格式 `~/.kiro/sessions/cli/<uuid>.jsonl` | ✅ **成立，路径逐字正确** | §5.5：CLI 格式 921 会话、最新写入 2026-07-26，仍是主力 |
| **D3** MCP 完整接管 `~/.kiro/settings/mcp.json` + 专属面板 | ⚠️ **方向成立，路径不完整** | §3.4：实测**两个**配置文件（`settings/mcp.json` + `mcp_config.json`），且 `agents/*.json` 的 `useLegacyMcpJson` 决定读哪个；还有 agent 级 scope。旧规格只认一个文件 → **charter 必须先定「写哪个」** |
| **D4** 委派沿用泛型 `DelegationBroker` | ⚠️ **未复核** | `unverified: 本轮未读 acp/delegation/broker.rs 验证其泛型性`。但 `src/components/settings/delegation-agent-defaults.tsx:66` 确实是一个手写 agent 白名单数组 → 至少前端侧需登记 |
| **D5** 单机单用户，`runtime_mode` 门禁 | ⚠️ **前提有变** | 实测存在 `src-tauri/src/web/handlers/mcp.rs` + `codeg_server.rs:147` 默认端口 3080 的**完整 HTTP 服务端**。所以「单机自用」不是代码事实，是使用约定 → 门禁若只做 Tauri 侧，HTTP 侧照样能读写 MCP（§1.4 末条） |
| **D6** API key 明文不脱敏 | ✅ 成立（用户偏好类决策，无需代码验证） | 但见下 §6.4 #3 |
| **D7** 模型/effort/权限 = 启动参数 | ✅ **旁证成立** | `kiro-cli acp --help` 实测确有 `--model` / `--effort`(low\|medium\|high\|xhigh\|max) / `--trust-all-tools` / `--trust-tools` / `--agent` / `--agent-engine`(v1\|v2\|v3)。**旧规格漏了 `--agent` 与 `--agent-engine` 两个 flag** —— `--agent <AGENT>` 直指 `~/.kiro/agents/*.json`（本机有 main/executor/reviewer/debugger/plan-reality-recon/ui-designer 6 个自定义 agent + agent 级 MCP scope），这是旧规格完全没覆盖的一个配置维度 |

### 6.2 §3 七个项目级坑（重点复核 4 项）

| # | 坑 | 判定 |
|---|---|---|
| **①** `cargo fmt --all` 污染全仓「重排 90 文件」 | ✅ **实测精确命中**：90 个文件 / 700 hunk，`cargo fmt --all -- --check` EXIT≠0。补充：仓内**无 rustfmt.toml**，且 `cargo fmt` 不带 `--all` 也覆盖整个 workspace → **任何形式的 cargo fmt 都不能用** |
| **②** 验证命令 `cargo test --no-default-features --lib` | ✅ 命令正确 | 但**基线不是绿的**：EXIT=101，8 个 Windows 相关失败（§4.1）。旧规格 §6 的「1590 全绿」判定**已失效** |
| **③** `NODE_ENV=development` 污染 pnpm build | ⚠️ **本轮未验证 build**，但 `pnpm test` 前主动 `Remove-Item Env:NODE_ENV` 后 EXIT=0。`unverified: 未跑 pnpm build，无法证实/推翻 prerender 报错` |
| **④** `PORT=3799` 冲突 | ✅ **前提成立**：本 shell 实测 `$env:PORT` = **3799**（mcphub 注入的）。`codeg_server.rs:147` 的默认端口是 3080（`.unwrap_or(3080)`）。所以「Next.js dev 会抢 3799」的机制合理；`unverified: 未实跑 next dev 复现 EADDRINUSE` |
| **⑤** 浏览器访问走 3080 | ✅ 与 `codeg_server.rs:147 .unwrap_or(3080)` 一致 |
| **⑥** `chat_channel::webhook` 测试 flaky | ❌ **本轮无法证实，且证据指向不成立**：本轮 1648 测试跑完，8 个失败全在 `acp::file_system_runtime`，**零个 chat_channel 失败**。`chat_channel` 下确有测试（`backends/lark.rs:696` / `telegram.rs:871` / `command_dispatcher.rs:469`），但没有名为 `webhook` 的测试模块。判定：**该条要么已被上游修掉，要么当时是别的原因** → charter 不应把它列为已知噪声（会掩盖真失败） |
| **⑦** Tailwind v4 需 `@source not` 排除 | ❌ **已失效**：`git grep "@source" -- src/` **零命中**。当前仓内没有任何 `@source` 指令 → 要么上游改了扫描策略，要么该修复随 14 commit 一起丢了。若丢了，则一旦仓内出现 `.worktrees` 目录，Turbopack panic 会**复现**。charter 需列为待验证风险 |

### 6.3 §4 七条死路

| # | 判定 |
|---|---|
| #1 `/model` 只回文本，不能替代选择器 | ⚠️ **无法复核**（需真跑 ACP 会话）。但 `--model` flag 存在（实测），所以「走启动参数」这条路本身可行 → 结论可用 |
| #2 脱敏占位符写回会损坏数据 | ✅ **机制成立且有新证据**：`mcp-settings.tsx` 是双向编辑面板；`mcp_set_server_apps:460-466` 是「先删后写」非原子。**新发现**：Kiro 的 secret 不只在 `env`，本机 `ace-local` 把 token 放在 `args` 数组里 → 脱敏范围必须含 `args`，旧规格只说 `env`（§3.4） |
| #3 非 dir-tree Binary agent 不该回退实时探测 | ✅ **代码实证成立**：`connection.rs:551` 的 PATH 回退是 `dir_entry.and_then(|_| resolve_system_agent_binary(cmd))` —— 确实 gate 在 `dir_entry` 上；`verify_agent_installed:501` 与 `detect_local_version:606` 三处一致 |
| #4 不建 KiroMonoIcon | ⚠️ **未复核 COLOR/MONO 优先级**。`agent-icon.tsx:392` 是 `COLOR_ICONS` map，`kimi_code` 只在此出现一次 → 与「只进 COLOR」一致，但「MONO 会成死代码」的因果未验证。`unverified: 未读 agent-icon.tsx 的 map 选择逻辑` |
| #5 模型列表不能自动拉（未登录时挂在 auth portal） | ⚠️ **无法复核**（不能在勘察中触发浏览器登录）。但 `kiro-cli mcp list` 实测 **EXIT=-1 且只吐 12 行 config 日志无内容** —— 说明 Kiro 的子命令在本机环境下确有「跑不出结果」的现实，该条谨慎信任是合理的 |
| #6 不改枚举支持动态 argv（`args` 是 `&'static`） | ✅ **实证成立**：`registry.rs` 三个变体的 `args` 全是 `&'static [&'static str]`；`build_agent` 里 Cursor 的动态 `--model` 正是用 `cmd_args.insert(0, ...)` 在分支内做的（`connection.rs:576-591`），**Kiro 照抄这个模式即可**，有现成范本 |
| #7 不回写 `installed_version` 到 DB | ⚠️ **部分证实**：`commands/acp.rs:855 db_version` 确实从 DB 读 `installed_version`，与实时探测并列。「已有专责写入口」`unverified: 未定位写入点` |

### 6.4 §5 六条打转记录

| # | 判定 |
|---|---|
| #1 「列表说未安装、诊断说已安装」是上游既有 UX 缺陷 | ✅ **代码注释直接实证**：`commands/acp.rs:863-864` 原文「mirror the exact gates `verify_agent_installed` uses so the report agrees with connect」+ `:917-923` 大段注释解释为什么诊断必须与 connect 对齐 —— 上游确实在处理这个不一致。旧规格说的「修法：DB 无版本时回退实时探测」在当前基线**已部分存在**（`detect_local_version` 就是这个回退），charter 不必重做 |
| #2 `Session is active in another process (PID N)` 是误报（陈旧 lock + PID 复用） | ✅ **旁证成立**：实测 `~/.kiro/sessions/cli/` 有 **485 个 `.lock` 文件**、921 个会话 —— 陈旧 lock 大量堆积是事实 |
| #3 API key 脱敏是过度设计，已推翻 | ✅ 成立（用户偏好，无需代码验证）。**但注意边界**：本轮发现 Kiro 的 MCP 配置在 `args` 里也放 token → 「MCP 第三方 token 脱敏保留」这条的实现范围要比旧规格写的宽 |
| #4 评审器会把单机项目推成企业级 | ✅ 成立（流程经验）。**但 D5 的前提要修正**：codeg 有完整 HTTP 服务端（`web/handlers/` + 3080 端口），「没有前后端信任边界」这个论断只在 Tauri 桌面模式下成立 |
| #5 E-060 双真源（改 spec 用就地覆写） | ✅ 成立（流程经验，无需代码验证） |
| #6 executor 的 4 次纠偏都对 | ✅ **本轮独立复核 3/4 条成立**：`mcp-settings.tsx` 消费 `McpAppType` 而非 `AgentType`（§3.3 实证）、脱敏占位符有数据损坏风险（§6.3 #2）、Binary 不该全回退（§6.3 #3）。第 4 条 MonoIcon 未复核。反向那条「`kiro-cli --version` 正常」本轮**再次实测确认**：EXIT=0，输出 `kiro-cli-chat 2.14.2` |

### 6.5 §2 / §6 / §7 的锚点可信度总评

- **符号名与结构：高可信**。本轮逐一命中 `build_agent` / `detect_local_version` / `load_mcp_servers_for_agent` / `apply_grok_env_policy` / `grok_launch_permission_mode` / `merge_agent_env` / `resolve_system_agent_binary` / `binary_cache` / `preflight` 等全部存在。
- **行号：全部漂移**，必须以本报告 §1–§3 的实测行号为准。
- **§2 声称的「15 处编译强制 match」**：本轮实测口径不同 —— 编译强制的是 §1.1 的 14 项（含 4 处因 `McpAppType` 连带）+ §2.1 的 9 处 distribution match（若走 D1）。两者有交集（`connection.rs:397` / `commands/acp.rs` 数处）。**「约 15 处」量级正确**，但**§1.2 的 8 处静默降级点旧规格完全没提**，那才是真正的风险源。
- **§6 的测试数字（1590/2683）**：前端量级对（现 2728）；后端**判定失效**（现基线红，8 失败）。
- **§7 「勿造轮子」清单：高可信**，Cursor/Grok 的现成模式经本轮实证可照抄（尤其 `connection.rs:576-591` Cursor 的 `cmd_args.insert` 动态 argv 范本）。

---

## 7 · 业务现实核查 + 架构质疑（§0.17 / §0.18）

对旧规格提出的每个新建能力做四问分类。**只标注，不代替用户裁决。**

| 新建项 | ① 真实场景 | ② 缺失影响 | ③ 既有覆盖 | 分类 |
|---|---|---|---|---|
| `SystemBinary` 分布类型 | 用户在 codeg 里选 Kiro 对话，Kiro 是系统装的 | 无此类型则只能伪造 Binary/Uvx → 假下载 URL / uv 抢路（可复现故障） | 无（三变体都假定 codeg provision） | **A** |
| KiroParser 会话浏览 | 用户有 **921 个** CLI 会话想在 codeg 里翻 | 会话页 Kiro 一片空白 | 无 | **A** |
| MCP 读写 + 专属脱敏面板 | 用户在 codeg 统一管 8 个 MCP server | 不做则 Kiro 的 MCP 只能手改 JSON | 通用面板存在但会明文外泄 + 写回损坏 | **B**（保护型） |
| API key 免登录 | 用户不想每次开浏览器登录 | 每次连接弹浏览器 | Grok/Cursor 的 `env_json` 通路可复用，**零新增存储代码** | **C** |
| 模型 / effort 选择器 | 用户想选便宜模型/低 effort 省 credit | 只能用默认模型 | 无 | **C** |
| 授权模式选择器（`--trust-all-tools` / `--trust-tools`） | 用户不想每个工具都点同意 | 每次弹授权 | codeg 自己的 ACP 授权 UI 已存在（默认路径） | **C** |
| `runtime_mode.rs` 门禁（新建文件） | ⚠️ 见下 | — | — | **B/D 待裁决** |
| **whoami 解析 + 一键 logout** | ⚠️ 见下 | — | — | **C/D 待裁决** |

**🛑『业务现实质疑』两项**：

1. **`runtime_mode.rs` 三入口门禁**：旧规格 §5 #4 自己记载「这条是评审器 R2-A1 从『完整多租户身份模型』收窄来的」。四问检验：①真实场景 = 「用户把 codeg-server 暴露到非 loopback 后，别人读到他的 MCP token」—— 这是**假设的部署方式**，不是用户说过的场景；②缺失影响 = 单机自用下**为零**；③既有覆盖 = 未核实 `codeg_server.rs` 是否已有绑定地址限制（`unverified`）。**倾向 D（技术洁癖）或最多 B**。但本轮发现一个**真的**问题让它可能升级为 B：`web/handlers/mcp.rs` 是完整的 HTTP MCP 读写入口，若做了 Kiro 脱敏而只堵 Tauri 侧，则脱敏形同虚设（那不是「多租户」问题，是「同一能力两个入口只堵一个」的一致性问题）。**建议改写为：不做 runtime_mode 抽象，而是把 Kiro 门禁做在 `commands/mcp.rs` 的函数族层（HTTP 与 Tauri 共用）** —— 这样一处生效两个入口，代价远小于新建门禁文件。

2. **whoami 解析 + logout 按钮**：旧规格 §W3② 要求跑 `kiro-cli whoami -f json` 解析实际生效认证 + 两段式确认 logout。①真实场景 = 「用户选了 api_key 但实际走登录态，看到 `bearer token invalid` 完全不懂」—— 这个场景**真实且旧规格声称实测过**；但②的缺失影响可以用**一行 UI 提示文案**覆盖（「若已 `kiro-cli login`，登录态优先于 API key」），不必新建命令 + 解析器 + logout 通路。**倾向：提示文案 = A/B（该做，成本一行）；whoami 解析 + logout 按钮 = C（可延后）**。理由补强：实测 `kiro-cli mcp list` EXIT=-1 → **Kiro 子命令的输出稳定性不可靠**，把 UI 建立在解析其自由文本输出（旧规格自己记载「JSON 后面紧跟裸文本 `Profile:` 块」）上是脆弱依赖。

**架构层面无质疑**：本任务是往一个已有 12 个 agent 的成熟注册表里加第 13 个，路径由上游架构确定，不存在「在错的架构上继续贴瓷砖」。唯一的架构性新增就是 `SystemBinary`（§2.4 已论证必要）。

---

## 8 · 链路完整性扫描（§0.16 · CCV 断点）

| 链路 | 完整性 |
|---|---|
| 用户选 Kiro → `all_acp_agents()` → 前端 agent 列表 | ⛔ **断点候选**：`registry.rs:131` 是手写 `vec![]`，漏加 = 整条链无输出且零报错。**必须进工作包** |
| Kiro 在列表里 → `agent_setting_service::default_enabled():28` → DB `enabled` | ⛔ **断点候选**：`matches!` 未列 = false = UI 灰掉。**必须进工作包** |
| 点连接 → `verify_agent_installed:467` → `build_agent:397` → 进程 | ✅ 走 distribution match，编译强制，不会漏 |
| 版本探测 → `detect_local_version:589` → 列表版本徽标 | ✅ 编译强制 |
| Kiro 会话文件 → `KiroParser` → `conversations.rs:280/938` → 会话页 | ⛔ **断点候选**：parser 写了但两处 match 漏挂 = 死代码。旧规格 §W4 的「grep 生产 caller」正是防这个 |
| 导入 → `import_service.rs:25` 数组（长度写死 12） | ✅ 定长数组，编译强制 |
| MCP 面板勾选 Kiro → `mcp-settings.tsx:97` APP_OPTIONS → `mcp_set_server_apps:433` → `upsert_server_for_app:2427` → `~/.kiro/*.json` | ⛔ **双向断点**：前端 `:97`/`:263` 两处手写、后端 `McpAppType` enum、`scan_local_servers:2332` 的 11 段循环 —— **四处都无编译器保护**。契约必须先冻结 |
| HTTP 侧 `web/handlers/mcp.rs` → 同一批 `upsert/remove` | ⛔ **旧规格完全未覆盖的第二入口**。做门禁/脱敏必须同时覆盖，否则浏览器走 3080 绕过 |
| `agent_data_roots():~460` → `fs/*` 写权限 → Kiro 写 `~/.kiro/*` | ✅ 编译强制，但该函数的测试**当前是红的**（§4.1）→ 新 arm 的测试不能用 `/tmp` |
| 启动参数（model/effort/权限）→ `build_agent` Kiro 分支 → argv | ⚠️ 单点收口，有 Cursor 范本（`connection.rs:576-591`）。风险是「写了 env_json 但 build_agent 没读」= 典型 built-but-not-wired，需 argv 顺序组合测试 |
| i18n key → 10 个 locale JSON → `messages.test.ts` 门禁 | ✅ 有硬门禁，漏了必红（这是唯一自带守卫的登记点） |

---

## 9 · 风险交叉区 & 派发建议

**冲突热点（多包同改，必须串行或独占）**
1. `src-tauri/src/acp/connection.rs`（9929 行）—— 4 个关注点。**单 executor 独占。**
2. `src-tauri/src/commands/acp.rs`（13149 行）—— 6 处 distribution match 跨 7000 行。**单 executor 独占。**
3. `src/components/settings/acp-agent-settings.tsx`（9900+ 行）—— 专属面板。**单 executor 独占。**
4. `src/i18n/messages/*.json` × 10 —— 有 key 集合门禁，**原子包，最后做**。

**先冻结再并行的契约（三处手写、无编译器保护）**
- `McpAppType`：后端 enum 变体名 ↔ 前端 union 字符串 ↔ `mcp-settings.tsx:97` 的 `value` ↔ `:263` 的 key。
- `AgentType` serde 名 `kiro` ↔ 前端 union `"kiro"` ↔ `registry_id_for` 的 id 字符串（三者不同层，别混）。

**给主 AI 的派发建议**
- 波次按 §5.2：**W0 串行头（独占）→ W1 三路并行（P1 parser / P2 MCP / P3 前端登记）→ W1.5 挂载 → W2 串行（connection.rs 全部）→ W3 面板+i18n**。
- **验收基线必须写死「8 个 `acp::file_system_runtime` 已知失败之外全绿」**，否则每个 executor 都会以为自己弄坏了东西（§4.1）。
- **禁用 `cargo fmt` 任何形式**（90 文件 / 700 hunk，§4.3）。
- **本仓无 pre-commit hook**（§4.4）→ 门禁全靠 executor 自查，charter 里的验证步骤要显式写命令。
- **charter 需先裁决的 3 个开放问题**：① Kiro MCP 写哪个文件（`settings/mcp.json` vs `mcp_config.json` vs agent 级 scope，§3.4）；② `runtime_mode` 是否降级为「函数族层门禁」（§7 质疑 1）；③ `Compaction` kind 是否轮边界（§5.5，影响 parser 分段正确性）。

---

## 10 · 交付级产物

**本轮只出勘察报告**（`docs/specs/` spec 三件套 + `docs/domain/` 领域模型由主派发者按模板产出）。

**给主派发者的 spec 依据**：
- requirements 的功能项来源 = §7 的 A/B/C 分类表（D 类不入）。
- design 的接口契约来源 = §1（注册点）+ §2.1（distribution match 语义）+ §3.1（MCP 函数族签名）。
- tasks.md 的波次与依赖来源 = §5.2 + §9。
- **domain-model：判定不需要**。codeg 的 agent 接入不是「跨功能中间层碎裂」型问题 —— `AgentType` / `AgentDistribution` / `McpAppType` 三个枚举本身就是现成的横切维度表，且 `docs/domain/` 目录在本仓**实测不存在**（`Test-Path docs\domain` → False；`docs/` 下只有 chat-channels / images / readme / releasing / specs）。真正的横切风险已由 §8 链路扫描覆盖。

---

## 11 · 主 AI 复核与用户裁决（2026-07-26 · 报告落盘后追加）

### 11.1 主 AI 独立复核结果

| 项 | 复核 | 结论 |
|---|---|---|
| 后端基线 8 失败 | 独立跑 `cargo test --no-default-features --lib` | **一致**：`1648 passed; 8 failed`，EXIT=101，全在 `acp::file_system_runtime` |
| 会话格式两套并存（§5.5） | 实测 `sessions/cli/` = 921 个 `.jsonl`，`kind=Prompt`/`AssistantMessage`，最新写入 07-26 00:30 | **sub 正确，主 AI 初判错误**。主 AI 先前只扫到 `sessions/<hex>/sess_<uuid>/` 那套（IDE 格式）便宣布旧规格失效，属用错样本 → 已更正，目标为 `sessions/cli/<uuid>.jsonl` |
| `Compaction` 结构 | 实测 `data = {summary, strategy, messages_snapshot}` | **非轮次边界**，见 §5.5 更正 |
| MCP 目标文件 | `kiro-cli mcp list` 实测可用，输出匹配 `settings/mcp.json` | **定为 `~/.kiro/settings/mcp.json`**，见 §3.4 更正 |
| `args` 藏 token | 实测 `ace-local` 的 `--token` 后为 20 字符非空值 | 载体成立，但**该 token 指向 `127.0.0.1:8000` 的本机自建服务**，泄露后外部无法利用 → 见 11.2 |
| HTTP 侧可绑非 loopback | `web/mod.rs` 的 `is_advertisable_ipv4` / `addresses_for_bind` | **第二入口成立**，门禁必要性确认 |

### 11.2 用户裁决（业务决策，非技术推导）

1. **局域网**：需要支持（手机 / 另一台电脑经 3080 访问）。
   → MCP 门禁**做在 `commands/mcp.rs` 函数族层**（桌面 + HTTP 一处生效），**做成可配开关**，
   默认拒绝非桌面入口读写 Kiro MCP。**不新建 `runtime_mode.rs`** —— §7 质疑 1 的降级建议被采纳。
2. **`args` 里的 token**：用户指出「那就是个空的、根本没配过」。实测非空（20 字符），
   但**它是本机自建 ace-tool-rs 检索后端的 token，指向 `127.0.0.1:8000`**，
   → 结论与用户一致：**不构成需要处理的风险**。真正的风险是「局域网开着 + 以后往 Kiro 加带真 key 的
   云服务 MCP」这个组合，由 11.2#1 的门禁覆盖。
3. **Kiro 自定义 agent**：要能选。
   → 新增配置维度：扫 `~/.kiro/agents/*.json` → 下拉 → `--agent <name>` 启动参数。
   本机现有 6 个（main / executor / reviewer / debugger / plan-reality-recon / ui-designer）。
   **这一层旧规格完全未覆盖**，已进 requirements（R6.5–6.9）。

### 11.3 charter 产出

- `docs/specs/kiro-agent-integration/requirements.md`（8 需求 / 51 AC / 6 Correctness Property）
- `docs/specs/kiro-agent-integration/design.md`（Current-State Inventory 三分类 + Corrected Goal +
  9 处 SystemBinary 落点 + 编译强制 vs 静默降级两表 + 波次 + CCV 链路表）
- 三个开放问题**全部关闭**，design 无待裁决项。
