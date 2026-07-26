# Kiro 接入 · 执行日志（接管入口）

> 本文件是**当前真实状态**的单一记录。新会话接管先读这里，再读
> `docs/specs/kiro-agent-integration/{requirements,design}.md`（契约）。
> `tasks.md` 的 file:line 与验收基线**已部分过期**，见下方「已推翻的 spec 条目」。

- 仓库：`F:\codeg-research`，分支 `feat/kiro-agent`
- 基线：已 rebase 到 upstream `e540a4fa`（v0.21.9）
- 最新提交：`287d4720`（**六个需求波次全部落地 + 独立审查 Critical 已修**）

## ✅ 独立审查结论（reviewer · 第三轮干净上下文 · 已完成）

`VERDICT: NEEDS_CHANGES · critical=1 · important=3 · minor=2` → **Critical 已修（`287d4720`）**

### Critical（已修）· Kiro API key 可经 HTTP 写入，绕过凭据门禁
`acp_update_agent_preferences_core` 是写 `agent_setting.env_json` 的**第二条独立路由路径**
（与 `acp_update_agent_env_core` 平行），此前**只有后者有门禁**，且其 handler 也未标记 HTTP 入口点：
```
POST /acp_update_agent_preferences
{"agentType":"kiro","enabled":true,"env":{"KIRO_API_KEY":"..."}}
```
在 `CODEG_KIRO_HTTP_CREDENTIAL_ACCESS` 未设（默认拒绝）时**写入成功**。
R5.3 四项操作的第四项（写 API key）未满足；R5.4 因为什么都没拒而失去意义。
**读侧是对的**（`acp_list_agents_core` 会摘掉 key）→ 让写侧看起来已覆盖，实则敞开。
**根因是形状不是遗漏**：我把门禁手抄进了一个 writer，而 R5.1 要求的正是「函数族层收口」。
修法：两个 writer 均经 `ensure_agent_env_write_allowed` 收口 + handler 包 `with_http_entry_point`
+ 新增 `every_env_json_writer_goes_through_the_admission_point`（对**源码**断言每个 writer 都调
收口点且调用先于首次落库）—— 既有测试全部直接调门禁函数，**那种测试抓不到未接门的调用者**，
这正是它能 ship 的原因。非空转已验：移除门禁 → 转红 → 已还原。

### Important 项（未修 · 见上方待裁决缺陷）
- **CAS TOCTOU**：reviewer 确认机制判断正确，但**不同意我的严重度**，判为「登记为已知债，不要本轮加锁」。
  理由：整个 `write_kiro_root_checked` 体内**无 `.await`**（纯阻塞 I/O），窗口是几百微秒；
  且需两个同时的特权 writer（HTTP 默认拒绝，需操作者显式开 flag）；
  真实碰撞是 codeg vs `kiro-cli mcp add`，**而那个人类尺度的间隔指纹校验抓得住**。
  且 P-2b 字面只承诺「读-改-写粒度」的冲突检测，未承诺「校验-到-rename 粒度」→ **不是未满足的 AC，是未陈述的**。
  若日后要关：`AppState` 里一把 `tokio::sync::Mutex` 跨读-改-写持有，**不是重试循环**。
- **三作用域无 UI 消费**：确认。`git grep mcpKiroScopedView -- src` **只有 api.ts 定义**，无组件 import。
  未满足 R4.1.2 / 4.1.3 / 4.1.4（展示语义；**安全半边已独立满足**——`scan_local_servers` 只列 global 作用域，
  codeg 不可能被驱动去写 agent/project 条目）/ 4.1.5，**外加我漏掉的 R4.1.12**
  （`scope_failures` 已构建并通到 TS 但无渲染 → 损坏的作用域文件静默不可见）。
  用户可见故障：同名 server 同时存在于 global 与 project → 面板只显示一行，用户改了 global，
  运行时 Kiro 用 project 那份 → **改动看起来保存了却无效果，屏幕上没有任何解释**。
- **`tasks.md` 无 Evidence 块且勾选状态与代码矛盾**：`- [x]` 只在 `:88`（ADR 行）；
  W0 验收框 `:165-168` 仍未勾选（W0 已 ship 于 `4edb8f0d`）；`:166`/`:418` 仍写「失败集合 ⊆ 已知 8 项」
  （`e7e02c6c` 已作废该判据）。reviewer 判 Important 而非 Critical，理由是 **commit message 里的证据
  比 tasks.md 好得多**（`655ad67a` 写明了用于证明非空转的变异）→ 轨迹存在，只是在 git 里不在制品里。

### Minor
- **symlink 在 Windows 上是「测试覆盖洞」不是「暴露」**：reviewer **实测**建了目录 junction，
  `GetFinalPathNameByHandleW`（`std::fs::canonicalize` 用的就是它）完全解析 → **junction 不能绕过门禁**；
  `\\?\` verbatim 输入两侧都被归一化，前缀比对仍同基准。我补的 `..` 测试被判「sound，且理由正确」。
- **`list_conversations_sync` 漏了 Kiro**（`conversations.rs`）→ **已修（`b798a513`）**。
  手写 12 项 tuple 表，有 Cursor 无 Kiro，**无编译错误**；`get_conversation` 自己有正确 arm，
  所以按 id 打开正常、却永不出现在侧边栏 / 统计 / 文件夹 / 导入扫描。
  `806042ae` 落地真解析器后**即为活 bug**（此前 `list_conversations` 返空使其不可见）。
  **我的变体扫描漏了它** —— 我扫了 `const ALL` 切片和 registry 列表，漏在它是 tuple 表不是纯 agent 列表。
  修法不止补一行：表抽成 `build_parser_table()`，新增
  `every_registered_agent_has_a_parser_in_the_listing_table` 对齐 `all_acp_agents()`，
  且**读真表而非另一份手抄副本**（防漂移）。非空转已验：移除 Kiro 行 → 转红且错误消息点明后果。

### reviewer 复核并判定「没问题」的点
`skill_storage_spec(Kiro)=None` 故四处 `const ALL` 无需加（确认）· `remote_registry.rs` **全仓不存在**
（我的结论对但理由不同）· `all_acp_agents()` 四个消费点都是遍历非手抄 · R4.5 跳过名单的 `return` 在
`read_servers_for_agent_type` **之前** → 门禁被拒也永不影响 agent 启动（R5.6 结构性成立）·
P-4 三处写命令的前置位置均正确 · P-5 不外溢（测试覆盖 11 个非 Kiro app 含真实 Kimi 往返）·
task-local 无 spawn 丢失 · 五个 `KIRO_*_ENV` 面板写↔启动读双向齐全无孤儿 · P-2/P-2b 测试非空转

## ⚠️ 待裁决的已知缺陷（本轮有意未修 · 新会话接管必读）

### 1. CAS 的 TOCTOU 窗口 → lost update（需用户裁决）
`write_kiro_root_checked`（`commands/mcp.rs`）先 `read_kiro_fingerprint` 比对、再 `fs::rename` 落盘，
两步之间**无锁**；`git grep "Mutex\|RwLock\|lock()" -- src-tauri/src/commands/mcp.rs` **零命中**，
外层也无兜底。交错：A/B 同读指纹 F → 两边校验均通过 → A rename → B rename 覆盖，A 的条目静默丢失。
**后果 = lost update，不是文件损坏**（原子 rename 仍保证不会写出半个文件）。CAS 只**收窄**了窗口。
未修理由：进程内 `Mutex` 只防同进程并发（对用户手改 / 其他工具无效），真解决需文件锁，
而那是跨 13 个 agent 共享契约层的决策 → 属用户裁决范围，不在 SUB 交付上顺手扩大。

### 2. `canonicalize_spec` 丢弃 remote 条目的 `env`（上游缺陷 · 已 narrow 绕过）
其 passthrough 循环无条件跳过 `env`，只有 stdio 分支重新加回 → `http`/`sse` 条目每次往返丢 `env`，
违反 R4.2/R4.4.5。当前仅在 Kiro 函数族内用 `kiro_restore_remote_env` 还原。
根治要改 `canonicalize_spec` 本身 —— 那是 13 agent 共享契约，会改变其余 12 个的行为。

### 3. 三作用域 payload 已可达但**无 UI 消费**
`mcp_kiro_scoped_view` 已有 Tauri command + HTTP 路由 + `api.ts` 封装 + TS 类型，
但**没有任何组件渲染它** → R4.1.2/4.1.3/4.1.4/4.1.5（作用域标注 / 覆盖展示 /
agent+project 只读 / 显示绝对路径）**尚未满足**。

### 4. symlink 边界在 Windows 上仍未验证
模块既有的 symlink 逃逸测试是 `#[cfg(unix)]`；我补的 `655ad67a` 只覆盖了 `..` 半边。
Windows 目录 junction / `\\?\` verbatim 路径是否能绕过未测。

### 5. `legacy_import_shares_the_guard_with_batch_import` 既有 flaky
`conversations.rs:4116`/`:4138` 两处 `IMPORT_GUARD.try_lock().expect()` 抢进程全局锁，
而生产 `import_*_core` 也取同一把 → 并发时必有一侧 panic。SUB 实测 **6 跑 1 中**。
非本轮引入（改动 stash 后在基线上同样复现），但会间歇咬 CI。

## 🧨 next-intl ICU 尖括号陷阱（新发现 · 实测复现 · 写任何 i18n 文案前必读）

消息值里出现 `<KIRO_HOME>` 这类尖括号占位符 → next-intl 按 ICU 解析，视为**未闭合 XML 标签**
→ **整条消息渲染成 key 名本身**（不是显示成占位符文本，是整句话消失）。

独立实测证据（主 AI 亲自跑探针，非采信 SUB 自述）：
```
messages: { P: { angled: "path is <KIRO_HOME>/agents", ticked: "path is `KIRO_HOME`/agents" } }
→ ANGLED_RESULT=P.angled          ← 整条丢失
→ TICKED_RESULT=path is `KIRO_HOME`/agents   ← 正常
```
**修法**：用反引号 `` `KIRO_HOME` `` 而非 `<KIRO_HOME>`。
**谁会踩**：R4.1.5 要求 MCP 面板显示「当前读写目标的绝对路径」——写该文案时同样命中。
全仓既有 i18n 零 `&lt;` 命中 → 这是本轮新踩到的坑，无既有先例可循。

## 🔧 本机环境坑（影响验收判据 · 必读）

**`pnpm eslint` 在本机不能当验收门。** `core.autocrlf=true` → checkout 出来全是 CRLF，
而 prettier 要求 LF → 全仓报 **~215063 个 `Delete ␍`**。已实测证明与 Kiro 改动无关：
主仓未改动的 `src/lib/types.ts` 单文件就报 3068 个。
**替代门（有真实判别力）**：`npx tsc --noEmit -p tsconfig.json` + `pnpm test`。
`Record<AgentType,_>` 的漏项靠 tsc 拦，i18n 漏项靠 `messages.test.ts` 拦。

**`git checkout <branch> -- <path>` 取不到 SUB 的产物**：SUB 被禁止 commit，改动只在工作区，
分支上没有 → 该命令**静默成功但什么都没取到**。合并 SUB 成果必须**按文件 `copy`**。（E-077 同型）

**前端测试基线（实测）**：`pnpm test` → 220 files / 2760 tests 全绿（spec 记的 218/2728 已过期）。
**当前前端基线**：221 files / 2776 tests 全绿（含 W3 面板的 16 个测试）。
⚠️ **worktree 里 `pnpm test` 跑不了**（worktree 无自己的 `node_modules` install，pnpm shim 报
`'vitest' is not recognized`）→ worktree 内用 `npx vitest run`（从父仓 `node_modules` 解析，
执行的是同一条 `vitest run`）。主仓两种都行。

## ⚠️ 已推翻的 spec 条目（实测为准，勿照 tasks.md 执行）

| tasks.md 写的 | 实测真相 | 证据 |
|---|---|---|
| 后端测试基线红的，**允许 8 个失败**，按集合比较 | **基线全绿 1673 passed / EXIT=0**。上游 `df5ee401` 已修掉那 8 个（Windows `/tmp` fixture），并引入 `absolute_path()` 平台安全 helper | 本地实跑；`git show df5ee401` |
| Kiro 元数据 `supports_mcp: false` | **必须 `true`**。该字段 ≠「codeg 是否转发 MCP」——Cursor/Grok/KimiCode 都是 `true` 且都在转发跳过名单里。设 false 会**连带丢掉 codeg 自己的 `codeg-mcp` 伴生进程**（委派 / ask_user_question 全废）。用 `connection.rs::load_mcp_servers_for_agent` 的跳过名单实现「不双重注册」 | `registry.rs` 的 `only_openclaw_opts_out_of_mcp` 不变式测试直接拦住 |
| distribution 编译强制点 **9 处** | **17 处**（含 spec 未列的 `commands/acp.rs` 两处 AgentType match、download/uninstall/install 三处） | `cargo check` 逐个报出 |
| `acp` flags 四维 | 确认四维全在，另有 spec 未提的 `--agent-engine <v1\|v2\|v3>`（默认 v2），当前**未接线**（无需求覆盖） | `kiro-cli acp --help` 实跑 |
| 所有 file:line | 已漂移（上游 9 个 commit）。**按符号名定位，不要按行号** | — |
| W3「必须串行独占 `acp-agent-settings.tsx`(9900 行)」 | **不成立** → `CursorConfigPanel` 是**独立文件** `cursor-config-panel.tsx` + 独立测试文件；主文件里只有 1 行 import + 1 个三元分支。Kiro 面板照此结构 → 对大文件仅改 15 行，**无需独占，可与其他波次并行**（本轮即与 P1/P2 并行完成） | `findstr CursorConfigPanel src\components\settings\*.tsx` |
| 前端基线 218 files / 2728 tests | 实测 **220 / 2760**（现 221 / 2776） | 本地实跑 |

## 实测环境事实

- `kiro-cli` 在 `C:\Users\7\AppData\Local\Kiro-Cli\kiro-cli.exe`，`--version` → `kiro-cli-chat 2.14.2`
- `~/.kiro/sessions/cli/` 有 **921** 个 `.jsonl` 会话
- `~/.kiro/agents/`：debugger / executor / main / plan-reality-recon / reviewer / ui-designer（6 个）
  - `main.json` 用**旧名 `useLegacyMcpJson: true`** 且**无内嵌 mcpServers**；其余若干有内嵌 → 本机同时存在两种拼写
- `~/.kiro/settings/`：`mcp.json`(2569B) + `permissions.yaml` + 两个 `.bak` → 写入器必须保留同目录无关文件，且**不得把 `.bak` 当配置源**

## 验收命令（每阶段都跑）

```
cd F:\codeg-research
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --no-default-features --bin codeg-server --lib -- -D warnings
pnpm eslint . && pnpm test && pnpm build
```

- **当前后端基线：1732 passed / 0 failed**（原始基线 1673 + 本轮新增 59）
- **当前前端基线：221 files / 2776 tests 全绿** + `tsc --noEmit` 干净
- clippy 必须零警告（CI 用 `-D warnings`）
- **严禁 `cargo fmt` 任何形式**：仓内无 `rustfmt.toml`，会重排 ~90 个无关文件
- 桌面 feature 的 `cargo check` 需要先有前端 `out/` 产物，否则 build script 报
  `resource path ..\out doesn't exist` —— 这是既有构建顺序依赖，不是回归
- 本仓**无 pre-commit hook**（`core.hooksPath` 空），门禁全靠自查

### `d6582782` P2 MCP 接管 + 三作用域 + 凭据门禁（已合并 · SUB 产出 + 主 AI 补接线）
- 读写函数族（全局 `<KIRO_HOME>/settings/mcp.json`）/ 三作用域合并展示 / 往返保真
  / 指纹 CAS + 同目录临时文件原子替换 / `McpAppType::Kiro`（含 3 处静默点，两个手写列表合并为
  `all_mcp_app_types()`）/ 凭据门禁（`tokio::task_local` 入口标记 + 纯判定函数，默认 DENY，
  flag `CODEG_KIRO_HTTP_CREDENTIAL_ACCESS`）
- **SUB 主动披露两处「造好没接」，主 AI 当场修掉**（非记 TODO）：
  ① `read_kiro_scoped_view` 零生产 caller → 补 `mcp_kiro_scoped_view` command + HTTP 路由
     + `api.ts` `mcpKiroScopedView` + TS 类型镜像
  ② `KiroCredentialOp::{ReadApiKey,WriteApiKey}` 定义但从未调用 → 接进 `commands/acp.rs`；
     **并发现 `acp_list_agents` / `acp_update_agent_env` 两个 HTTP handler 未标记入口点**
     （门禁会在 HTTP 上静默放行）→ 已包 `with_http_entry_point`
  - 读路径的处理是**只摘掉 Kiro 的 key 而非整请求失败**：该 payload 一次带 13 个 agent，
    整体拒绝会为了满足 R5.3 而违反 R5.6（局域网须可用）
- 假门验证：移除 `read_kiro_scoped_view` 的门禁调用 → 测试立即转红 → 已还原

### `655ad67a` R8 边界补强（主 AI 自查 · 源自 reviewer 中断前的提示）
- 原 R8 测试只比对 root 集合，未验 P-2c 的「`..`/symlink 不可绕过」；且模块既有 symlink
  逃逸测试是 `#[cfg(unix)]` → 在 Windows（本机=实际运行平台）从不运行
- 新增 `kiro_write_gate_rejects_dotdot_escape_into_settings`：驱动真实写入门禁 + 真实目录树，
  断言 `sessions/../settings/mcp.json` 与 `../agents/main.json` 均被拒且文件未落盘，含正向对照
- 非空转已验：门禁的规范化比对换成裸路径 → 转红 → 已还原

### `806042ae` P1 会话解析（已合并 · SUB 产出 · 主 AI 亲验）
- `parsers/kiro.rs` 1397 行 / 15 测试；轮次状态机（`Prompt` 开、`Clear` 关、`tool_result_idx`
  在每个边界清空 → 跨轮配对**结构上不可能**而非仅未测）
- **有意不用 `relocate_orphaned_tool_results`**：该 helper 跨全部轮次映射 `tool_use_id → turn index`
  并把结果搬到持有 call 的那一轮 —— 正是 R3.4.2 禁止的跨轮配对。复用共享 helper 会静默破坏不变式
- 行级容错 / 未知 kind 占位 / `Compaction` 不分段 + 截断
- 实测 65/921 会话（1.48GB，含 62/33/32MB 三个最大的，11652 envelope），零矛盾。三条值得记：
  - `Compaction` 后接 `ToolResults` 8× vs `Prompt` 1× → 确实处于轮次中段（R3.5 的证据）
  - 最大 `messages_snapshot` 2313058 字符 vs 4000 上限 → 截断是承重的
  - `image.source.data` 在 60/60 样本里是 JSON 数字数组，**不是 base64**
  - 全语料配对：6493 同轮 / **0 跨轮 / 0 孤立** → 同轮不变式守的是「原理上可能但本语料没出现」
    的形状，是正确性守卫，不是按实测频率修的问题
- 15 测试零平台门、零 `/tmp` 字面量、6 处 `temp_dir()` → 实测在 Windows 上全部真跑
- ⚠️ **踩到 E-067**：拷入文件后 `cargo test` 仍报 1720 且只有 3 个骨架测试（陈旧增量缓存），
  `touch` 源文件重编译后才是 1732 / 15 个全在。**陈旧缓存读起来和「交付没落地」一模一样**

## 已完成（已提交 · 已验证）

### `4edb8f0d` W0 基座
- `AgentType::Kiro`（serde/registry id 均 `kiro`）+ Display
- `AgentDistribution::SystemBinary { cmd, args, env }`（无 version/platforms/dir_entry）
- registry：meta / id 双向映射 / `all_acp_agents` / `default_enabled`
- 17 处编译强制点全部**真实装**（非占位）：
  - `build_agent` SystemBinary 分支（PATH 解析 + argv 组装 + env policy）
  - `run_preflight` → `check_system_binary_environment`（PATH 可解析）
  - `verify_agent_installed`、`detect_local_version`（`--version` 剥 `kiro-cli-chat ` 前缀）
  - diagnostics `distribution="system-binary"`、status/list 两处、download/install/uninstall 三处拒绝
- `kiro_launch_args`（model/effort/trust/agent · 固定序 · 纯函数）+ `apply_kiro_env_policy`
- MCP 转发跳过名单加 Kiro（S2）
- **R8 写边界**：root = `<KIRO_HOME>/sessions`（**比数据根窄一层**），`settings/`+`agents/` 靠"不在任何 root 内"天然拒绝
- `parsers/kiro.rs` 骨架（`<KIRO_HOME>` 单一解析点）+ **已接线**到 conversations 两处 + import_service（防死代码）
- 新增测试：registry id 往返(P-6) / all_acp_agents 数量 / SystemBinary 无版本 / argv 全组合(P-3) / env policy 三例 / R8 边界 / KIRO_HOME 三例

### `74f6a3e8` W2-S3 自定义 agent
- `list_kiro_custom_agents{,_at}` 扫 `<KIRO_HOME>/agents/*.json`，**文件名去扩展名 = 标识**（非内部 `name`）
- 坏 JSON 只跳自己 / 目录缺失 = 空列表 / description 截断 300 字
- `acp_list_kiro_custom_agents` 已注册 Tauri(`lib.rs`) + HTTP(`router.rs`+`handlers/acp.rs`)
- `verify_kiro_selected_agent_exists`：选中的 agent 消失 → **明确报错，禁静默回落**（改的是提示词+工具白名单两件事），已在 `build_agent` 调用

### `0186fd7d` W1-P3 前端登记（已合并 · SUB 产出 · 主 AI 亲验）
- `types.ts`：`AgentType` union + `AGENT_LABELS` + `AGENT_COLORS`（tsc 强制）
  + `AGENT_DISPLAY_ORDER` + `ALL_AGENT_TYPES`（两个静默数组）+ `McpAppType` union
- `MODEL_PROVIDER_AGENT_TYPES` **有意未改**（Kiro 无第三方 provider 端点）
- `agent-icon.tsx` KiroColorIcon + `COLOR_ICONS`；颜色 `#9046FF`（官方 Kiro Purple）
- `mcp-settings.tsx` `APP_OPTIONS` + 勾选态 key；`delegation-agent-defaults.tsx` 白名单
- **i18n 未碰**（`messages.test.ts` 9 测试全绿即证明）
- 验收：`tsc --noEmit` 干净 + `pnpm test` 220 files / 2760 tests 全绿

### `a2332993` W3 配置面板 + 十语 i18n（已合并 · SUB 产出 · 主 AI 亲验含独立复现）
- 新建 `kiro-config-panel.tsx`（504 行 · 独立文件，照 `cursor-config-panel.tsx` 结构）
  + `kiro-config-panel.test.tsx`（16 测试）
- `acp-agent-settings.tsx` 仅 +15 行（1 import + 1 三元分支，紧邻 cursor 分支）
- `api.ts` `acpListKiroCustomAgents()`；`types.ts` `KiroCustomAgent` 接口
- 五个启动 knob 全接：`KIRO_API_KEY`(明文·清空即移除) / `KIRO_MODEL`(datalist·可任意输入)
  / `KIRO_EFFORT` / `KIRO_TRUST_MODE`+`KIRO_TRUST_TOOLS`(互斥) / `KIRO_AGENT`(下拉+重载)
- i18n：`AcpAgentSettings.kiro.*` 34 key + 2 个 toast key，**10 locale 一次改完**（各 +38 行）
- 三处有意偏离 spec 字面（均为遵从既有约定 + 需求原意）：
  ① 模型控件用 `Input`+`datalist` 而非 Cursor 的 `Combobox`（后者需已拉取目录且不接受未列值，
     直接违背 R6.1.1/6.1.2；datalist 在本仓 Kimi 模型字段已有先例）
  ② API key 用 `type="text"` 无遮罩无 eye toggle（R7.2 + tasks.md T4.1 明示的用户裁决）
  ③ 未识别的 trust mode 推断为**未设置**而非 `all`（猜 `all` 等于给用户一个他没选的
     `--trust-all-tools`；后端 `kiro_launch_args` 同样忽略未知值 → 两端一致 fail-closed）
- 验收：主仓 `tsc --noEmit` 干净 + `npx vitest run` 221 files / 2776 tests 全绿
- **测试非空转已验**：SUB 变异 `buildKiroEnv` 的 delete 分支改写 `""` → 7 个测试转红，已还原
- 模型预设清单本机实证：`~/.kiro/settings/cli.json` 含 `claude-opus-5` / `claude-opus-4.8`
  / `claude-opus-4.7` / `gpt-5.6-sol` → 格式与清单一致（其余项无法本机证实，但预设按 R6.1.1
  本就是**非权威**、可任意输入覆盖，可接受）

## 未开始 / 剩余

**六个需求波次的实现已全部落地**（W0 / W1-P1 / W1-P2 / W1-P3 / W2 / W3）。剩余项：

1. **三作用域 UI 消费**（见上方待裁决缺陷 #3）—— payload 已可达，缺渲染它的组件。
   这是唯一还有 AC 未满足的功能项（R4.1.2/4.1.3/4.1.4/4.1.5）。
   ⚠️ 写该面板文案时必踩 ICU 尖括号陷阱（见下方），R4.1.5 要显示绝对路径。
2. **独立 reviewer 审查**未完成：两轮 reviewer 均因环境侧原因中断
   （第一轮 400 INVALID_MODEL_ID —— 我指定 `sonnet` 在此环境无效；
   第二轮 CONTENT_LENGTH_EXCEEDS_THRESHOLD —— 多次恢复累积上下文超长）。
   第三轮已用干净上下文重派，四项待办已作为**结论**转交而非让它重新发现。
3. `codegraph sync F:\codeg-research`
4. 清理 worktree：`.worktrees/kiro-p1..p4`（成果均已按文件 copy 回主仓并提交）
   ⚠️ **删除 worktree 用 `cmd /c rmdir /s /q` 独占一次调用**，禁 `git worktree remove`
   （E-003/E-004：Windows 下会跟随 junction 删主仓源码）

- SUB 类型用**项目自定义 agent**（`executor`/`reviewer`/`debugger`/`plan-reality-recon`），不用 `general-purpose`
- SUB 均禁 `git commit`；主 AI 负责按文件 `copy` 取回 + 亲验 + 提交
- SUB 多次因环境侧原因中断（402 配额 / ConnectionRefused / 模型 ID / 上下文超长），
  用 `SendMessage` 从 transcript 恢复有效；但**上下文超长那次无法恢复**，只能干净重派

## 变体再扫描结论（已完成）

对照 `AgentType::Cursor` 的 13 文件分布，Kiro 少 4 个文件 —— `acp/types.rs`
    （仅注释提及，非登记点）、`experts.rs` / `office_tools.rs` / `science.rs` / `custom_skills.rs`
    的 `const ALL` 切片（**已实测确认四处都有 `skill_storage_spec(*a).is_some()` 过滤**，
    Kiro 返 `None` → 自动排除，无需加）、`parsers/cursor.rs`（parser 自有文件，不适用）。
    另：`remote_registry.rs` **不**遍历 `all_acp_agents()` → spec 标的该风险已关闭。
    `chat_channel/session_commands.rs` 是 agent 选择器，加入 `all_acp_agents()` 后自动含 Kiro（符合预期）。
  - ✅ ADR-0001 已翻 `Accepted`（`e7e02c6c`）

## 独占约束（多 SUB 并行时）

`connection.rs`(9929→10284 行) · `commands/acp.rs`(13149→14301 行) · `acp-agent-settings.tsx`(9900+ 行)
三者**全程只允许一个 owner**。i18n 10 个 JSON 是原子包。

## 待留意的风险

- Tailwind v4 `@source not` 修复可能随丢失的 14 commit 消失（`git grep "@source" -- src/` 当前零命中）。
  仓内已出现 `.worktrees/` → 若 `pnpm build` 报 Turbopack panic 提及该目录，即为复现，**先报不要绕**
- `remote_registry.rs` 是否遍历 `all_acp_agents()` 拉远端清单未核实
- `Compaction` 是否还有 `messages_snapshot` 之外的分段语义未穷尽（仅抽样 1 条）
- 上游 PR #286「detect externally installed ACP agents」与本任务 SystemBinary 域重叠：
  它给 `AcpAgentInfo`/`AcpAgentStatus` 加了 `base_cli_version/command/package` 三字段做「上游 CLI 已装但 ACP 适配器未装」提示。
  当前**未合入**；若上游合并，需检查是否与 SystemBinary 的 available/installed_version 语义冲突

## ✅ 三作用域 UI 消费（已完成 · 本轮）

**唯一还有 AC 未满足的功能项已关闭。** 用户裁决方案 A（Kiro 专属区块，不抽跨 agent 通用抽象）。
决策卡：`kiro-mcp-scope-ui-decision.md`（卡先于码，业务代码零行时落盘）。

- 新建 `src/components/settings/kiro-mcp-scope-panel.tsx`（300 行）+ `.test.tsx`（8 测试）
- 接线：`mcp-settings.tsx:16` import + `:1703` 渲染，挂在**右栏空态分支**
  （未选中 server 时展示整体作用域视图；它是全局视图不是选中项详情）
- workspace 来源**复用既有先例不自创**：`skills-settings.tsx:189-203` 已解过同一问题
  （全局设置页需要按文件夹作用域），照抄 `loadFolderHistory()` + `workspacePath` 透传结构
- i18n 十语一次改完（`McpSettings.kiroScopes.*`，各 +21 行），用脚本插入避免手改 10 个 JSON 的
  EOL/编码坑；**路径占位符全部用反引号**，无 `<KIRO_HOME>` 尖括号
- 满足 R4.1.2（作用域标注）/ 4.1.3（遮蔽展示）/ 4.1.4（agent+project 只读）/ 4.1.5（绝对路径）
  / 4.1.12（损坏作用域标示失败）

**本轮新增的安全约束（决策卡里定的，不在原 spec）**：secret 类字段
（`env` / `headers` / `oauth`）**只显示键名不显示值**。起因是核实 `oauth.clientSecret` 时确认
读路径整体在凭据门后（非缺口），但「读被允许」不等于「可以把密钥画进 DOM」。
`entrySummary` 只取 `command`/`args`/`url`（Kiro 用来区分 local/remote 的字段）。

**两条测试非空转已验（移除→转红→还原）**：
- 遮蔽标注去掉 → 「project 生效 global 被遮蔽」立即红
- `entrySummary` 换成 `JSON.stringify(spec)`（最可能的天真写法）→ secret 遮蔽测试立即红

**顺手修掉一处被官方文档推翻的注释**（`mcp.rs:3352`）：原写 "loads these files natively
**at launch**"。官方 `kiro.dev/docs/cli/mcp/configuration` 明确 Kiro **热重载** —— 文件监视器盯
`mcp.json` 与 `.kiro/agents`，保存后在下一个 idle 边界（轮次之间）生效，不重启 session、
不丢上下文，且只重启变更的 server。跳过名单的**结论仍正确**（避免 double-register）但**理由错了**；
注释错会误导下一个人。面板文案同步告诉用户不必重启。

**验收（全部实跑）**：后端 1734 passed / 0 failed · EXIT=0 · clippy 零警告；
前端 222 files / 2784 tests 全绿（基线 221/2776，+1 file/+8 tests）；`tsc --noEmit` EXIT=0；
`messages.test.ts` 9 测试绿证明十语无漏项。

### ⚠️ 本轮踩到的工具口径坑（新文件 + `git grep`）

`git grep` **默认跳过 untracked 文件** → 对本轮新建的 `kiro-mcp-scope-panel.tsx` 一律假阴性。
表现极像「造好没接」：我用 `git grep "mcpKiroScopedView" -- src/` 复查变体时得到「仅 api.ts 定义」，
与我刚接线的事实矛盾。加 `--untracked` 后 12 处命中全见（组件 `:13` import + `:99` 调用）。
**新增文件的一切 grep 核实必须带 `--untracked`**，否则「新组件没消费某函数」的结论必然是假的。
（对 `mcp-settings.tsx` 那次接入核实是有效的 —— 它是已跟踪文件。）

同时记一条**变体指纹抽错**：我曾用「api.ts 有导出但组件无引用」当指纹扫全仓，报出 46 个
"orphan"，里面含 `acpPrompt` / `gitDiff` / `listConversations` 这些明显在用的核心函数
→ 指纹太宽（间接消费/re-export 全被算成孤儿），自证失效。真指纹是本任务独有的形状：
「后端有完整链路（command+路由+类型镜像）且为本轮新增，但无渲染端」，不是全仓通病。
按此重扫，Kiro 相关 TS 类型均已有消费端（`KiroMcpScopeFailure` 未被显式 import 是结构化访问，
渲染确实存在且已验非空转，非缺口）。

### 剩余（收尾，非功能项）

1. `codegraph init` + `sync`（实测本仓**未 init**，`codegraph_node` 报 "not initialized"，
   所以不是 sync 而是先 init）
2. 删 `.worktrees/kiro-p1..p4`（成果均已合入）
   ⚠️ `cmd /c rmdir /s /q` **独占一次工具调用**，command 内不得有任何 `;`/`&&`/换行；
   禁 `git worktree remove`（E-003/E-004 跟随 junction 删主仓）；删后**单独一次调用**验
   「目标已消失 **且** 主仓 `.git` 仍在」（C-010）
3. 两个已登记债仍待用户裁决：CAS TOCTOU（reviewer 判「登记债、本轮不加锁」，我已改判接受）、
   `canonicalize_spec` 丢 remote 条目 `env`（上游缺陷，当前仅 Kiro 函数族内 narrow 还原）
