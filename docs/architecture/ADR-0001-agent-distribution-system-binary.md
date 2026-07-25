# ADR-0001 · Agent 分布类型：SystemBinary

- **状态**：Proposed
- **日期**：2026-07-26
- **关联规格**：`docs/specs/kiro-agent-integration/`
- **决策者**：项目所有者

## Context

codeg 通过 `AgentDistribution`（`src-tauri/src/acp/registry.rs:4`）描述「如何获得某个 ACP agent
的可执行体」。截至 `2b017446`，它有三个变体，共同前提是 **codeg 负责获取产物**：

- `Npx { package, cmd, args, env, node_required }` —— 经 npx 拉取 npm 包。
- `Binary { platforms: &[PlatformBinary], dir_entry: Option<BinaryDirEntry>, ... }` —— 按平台
  从 URL 下载归档，解包进 codeg 自己的版本化缓存目录。
- `Uvx { package, cmd, uv_required, python, system_cmd: Option<(&str, &[&str])>, ... }` ——
  经 `uvx --from <package>` 拉取 Python 包；`system_cmd` 是 uvx 不可用时的 PATH 回退。

接入 Kiro CLI 时出现一类**现有三者都无法正确表达**的情形：`kiro-cli` 由用户自行安装
（实测 `C:\Users\7\AppData\Local\Kiro-Cli\kiro-cli.exe`，`kiro-cli-chat 2.14.2`），
codeg 既不提供下载，也不 pin 版本，只需在 PATH 上解析并启动。

## Decision

新增第四变体 `AgentDistribution::SystemBinary`，语义为
**「可执行体由用户自行安装，codeg 只做 PATH 解析与版本探测，不获取、不缓存、不 pin」**。

配套约定：

- `registry_version()` 对该变体返回 `None`（版本由系统安装决定，注册表无权威版本）。
- 安装校验仅检查命令能否在 PATH 上解析。
- 版本探测运行 `<cmd> --version`，不查询 codeg 的二进制缓存。
- 不提供安装/升级按钮，不执行任何下载、解包或缓存写入。

## Alternatives Considered

### 备选 A · 复用 `Binary`，用特殊 `platforms` 表达

需为 6 个平台各填一个 URL，并设 `dir_entry: Some(...)` 才能触发 PATH 回退分支
（`connection.rs:551` 的回退是 `dir_entry.and_then(|_| resolve_system_agent_binary(cmd))`，
被 `dir_entry` gate 住）。

**否决理由（功能性错误，非风格问题）**：`platforms` 的 URL 会进入安装/升级通路 ——
用户点「安装」即触发下载一个不存在的 URL。同时 `dir_entry: Some` 会让 `binary_cache`
把它当成需保持目录树完整的归档。**编译器一处不报错**，全靠人记住这是伪造值。

### 备选 B · 复用 `Uvx.system_cmd` 的 PATH 回退

`Uvx` 分支（`connection.rs:688-750`）的顺序是：① `resolve_uvx_command()` 命中 → 走
`uvx --from <package> <cmd>`；② 否则 `system_cmd` → PATH 直启；③ 都无 → `SdkNotInstalled`。
第 ② 条正是所需语义。

**否决理由（功能性错误）**：需伪造 `package` 与 `uv_required`；且**装了 `uv` 的机器上
第 ① 条会优先命中**，codeg 会去执行 `uvx --from <伪造包名> kiro-cli acp` —— 必然失败。
连带 `preflight.rs:72 check_uv_environment` 会检查 uv 版本（误报），
`detect_local_version` 会走 `binary_cache::uvx_prepared_version` 查 codeg 缓存
（对 Kiro 永远为空 → agent 列表恒显示「未安装」）。

### 选定方案的代价

新增变体使 9 处 `match` 编译失败，须逐个补 arm：

| 位置 | 函数 |
|---|---|
| `acp/registry.rs:98` | `registry_version()` |
| `acp/connection.rs:397` | `build_agent` |
| `acp/preflight.rs:60` | `run_preflight` |
| `commands/acp.rs:467` | `verify_agent_installed` |
| `commands/acp.rs:589` | `detect_local_version` |
| `commands/acp.rs:865` | `build_agent_diag` |
| `commands/acp.rs:1245` | `launch_label` |
| `commands/acp.rs:7891` | `(available, installed_version)` |
| `commands/acp.rs:7967` | `(available, dist_type, local_installed_version)` |

**这 9 处全部由 `cargo build` 强制暴露，不存在静默漏项** —— 相比备选 A/B 的「编译通过但
运行时错误」，改动面更大但安全性更高。这是选定本方案的核心论据。

## Consequences

- **正面**：语义与现实一致；后续任何系统安装型 agent（系统装的 gemini-cli / claude-code 等）
  可直接复用该变体；「为什么不复用 Binary/Uvx」的答案固化在此。
- **负面**：`AgentDistribution` 从 3 变体增至 4，每个按 distribution 分派的新函数都多一个 arm。
- **可逆性**：删除变体即回到备选 A 的状态，无数据迁移。本 ADR 的存在理由是**边界定义**
  （分布模型的语义边界）而非不可逆性。

## Verification

- `cargo build` EXIT=0，9 处 arm 全部补齐。
- `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib` 的失败测试
  标识集合 ⊆ 规格「验证基线」列出的 8 项（集合比较，非数量比较）。
- Kiro 在 agent 列表中显示为已安装、版本为剥除 `kiro-cli-chat ` 前缀后的值，且**无安装按钮**。
