# Kiro 三作用域 MCP 面板 UI 消费 · 边界决策卡

> **卡先于码**（§6.0.1）：本卡落盘时业务代码零行。开发中若假设被推翻，回来改本卡再继续。
> 上游任务状态见同目录 `kiro-integration-execution-log.md`（接管入口）。

- 仓库 `F:\codeg-research` · 分支 `feat/kiro-agent` · 基线 `b798a513`
- 覆盖 AC：R4.1.2 / R4.1.3 / R4.1.4 / R4.1.5 / R4.1.12
- 用户已裁决：**方案 A（Kiro 专属区块）**，不抽跨 agent 通用作用域抽象

## 🏗️ 1. 边界决策

**Bounded context**：前端设置层的展示消费端。后端零改动 —— payload 已端到端可达
（`mcp.rs:3623-3750` 结构+合并 → `mcp.rs:295` command → `web/handlers/mcp.rs:67/95` HTTP
→ `types.ts:2360-2383` 镜像 → `api.ts:1329` 封装），缺的只有渲染它的组件。

**为什么是 Kiro 专属而非通用抽象（用户裁决 A，证据支撑）**：
`git log --all --grep=scope -- commands/mcp.rs src/components/settings` 只命中本轮 `d6582782`
（另一命中 `a6f80088` 是 folder-scoped **skills**，语义不同）；Cursor 单文件
（`~/.cursor/mcp.json`，`mcp.rs:3199`）、Claude Code / CodeBuddy 只有 `@user`
marketplace 后缀（`mcp.rs:857/1806`，是激活门不是文件层作用域）。
→ **Kiro 是全仓唯一多作用域 agent**，通用抽象会是只有一个实现者、且无第二形状可对照的错误抽象。
仓内既有先例同向：Cursor 面板也是独立文件（`cursor-config-panel.tsx`）。

**状态机**：无（纯只读展示）。

**不变量**：
- 只有 `scope === "global"` 的行可编辑（后端 `editable` 已算好，前端**不重算**，直接用）
- 面板永不写 agent / project 作用域文件（后端 R8 写边界已结构性保证，前端不提供入口）
- secret 类字段（`env` 值 / `headers` / `oauth.clientSecret`）**不显示值**，只显示键名与「已设置」

**ADR admission**：**不需要**。理由：纯展示端消费一个已定型的 payload，无跨 agent 契约、
无依赖方向变化、可逆（删组件即回到现状）。作用域读取语义本身的决策已在 ADR-0001 相关波次定过。

## 🔍 2. 既有实现检索（§2.2）

**内部（防重复造轮）**：
- `git grep -n "mcpKiroScopedView\|KiroScopedView" -- src` → 仅 `api.ts:1329` 定义 + `types.ts:2382`，
  **零组件消费**（确认缺口真实存在，非我误判）
- workspace 选择器 → **命中既有实现，复用不自创**：`skills-settings.tsx:189-203` 已解过同一问题
  （全局设置页需要按文件夹作用域），用 `scope: "global" | "folder"` + `loadFolderHistory()`
  + 把路径作为 `workspacePath` 透后端；其注释还记录了性能取舍
  （`loadFolderHistory()` 直查 `folder` 表 = O(folders)；`listFolders()` 从每个会话聚合，历史大时慢）。
  → Kiro 面板照抄此结构，`api.ts:1414 loadFolderHistory()` / `types.ts:262 FolderHistoryEntry`
- 面板结构先例：`kiro-config-panel.tsx`(504 行独立文件) / `cursor-config-panel.tsx`
- 挂载点：`mcp-settings.tsx` `LeftTab = "local" | "market"`(`:62`)；`kiro` 已在
  `APP_OPTIONS`(`:100`) 与勾选态(`:267`)

**外部**：
- 官方 `https://kiro.dev/docs/cli/mcp/configuration/`（本轮实读，非记忆）证实：
  优先级 `1. Agent Config → 2. Workspace .kiro/settings/mcp.json → 3. Global ~/.kiro/settings/mcp.json`；
  三个官方场景（完全覆盖 / 异名叠加 / 靠覆盖 disable）与后端合并语义一致
- **官方新事实（推翻代码注释）**：Kiro **支持热重载** —— 文件监视器盯 `.kiro/agents` 与 `mcp.json`，
  保存后在下一个 idle 边界（轮次之间）生效，不重启 session、不丢上下文；只重启变更的 server；
  键序变化不算变更。而 `mcp.rs:3352` 注释写的是 "loads these files natively **at launch**"。
  → 跳过名单的**结论仍正确**（避免 double-register），**理由需改**；面板文案应告诉用户不必重启
- 官方 troubleshooting 把 **JSON 语法错误**列为「配置的 server 没出现」的头号原因
  → R4.1.12（损坏作用域标示失败）不是可选装饰，是官方认定头号故障的唯一可见性
- 未搜到可套用的现成实现：上游 60 个 PR（全状态）零 Kiro；25 个 upstream 远端分支无一相关
  （`gh pr list --repo xintaofei/codeg --state all --limit 60` + `git log --all --grep=kiro`）
  → 必须自建，无先例可抄

## 📐 3. 接口契约

**后端零改动**。消费契约（已存在，本卡不改）：

```ts
mcpKiroScopedView({ workspacePath?: string | null }): Promise<KiroMcpView>
KiroMcpView { write_target: string; servers: KiroMcpScopedServer[]; scope_failures: KiroMcpScopeFailure[] }
KiroMcpScopedServer { id; spec; scope; shadowed_scopes[]; editable; agent_name? }
KiroMcpScopeFailure { scope; path; reason }
```

- `workspacePath = null` → 后端跳过 project 作用域（不是错误）
- 错误路径：HTTP 入口默认被凭据门禁拒（`errors.kiroCredentialsDesktopOnly`）→ 面板必须把这个
  拒绝渲染成一句可读说明，而不是空列表（空列表会被读成「没有 server」，是静默故障）
- 空 `servers` 且无 failure = 合法的「一个都没配」，与上面那条必须**视觉可区分**

## 🧪 4. 测试边界（TDD Red）

新建 `kiro-mcp-scope-panel.test.tsx`，先红后绿。用真实业务场景命名：

1. `同名 server 同时存在于 global 与 project 时，标出 project 生效、global 被遮蔽`（R4.1.3 核心
   —— 这就是「用户改了 global 却没效果」那个故障）
2. `agent 与 project 作用域的行不提供编辑入口`（R4.1.4，断言 `editable=false` 真的无按钮）
3. `面板显示 codeg 实际读写的那个文件的绝对路径`（R4.1.5）
4. `某个作用域文件损坏时，标出该作用域失败且其余作用域照常显示`（R4.1.12）
5. `env / headers / oauth.clientSecret 的值不出现在 DOM 里`（本卡新增的安全约束，只显示键名）
6. `HTTP 入口被凭据门禁拒绝时给出说明，而不是渲染成空列表`（边界：拒绝 ≠ 无数据）
7. `没有任何 server 时显示空态，与被拒绝态可区分`（边界对照）

## 🛡️ 5. 防腐层与登记检查

- 无第三方 SDK，不涉及防腐层
- 登记检查清单：
  - [ ] 组件真被 `mcp-settings.tsx` **生产路径** import（非仅 test）—— ⚡E-052/E-072 母题，
        判据 `git grep -n "KiroMcpScopePanel" -- src/` 有非 test 命中
  - [ ] 十语 i18n 全部补齐（`messages.test.ts` 9 测试拦漏项）
  - [ ] **i18n 文案禁用 `<KIRO_HOME>` 尖括号** —— next-intl 按 ICU 解析成未闭合 XML 标签，
        整条消息渲染成 key 名（本轮已实测复现）；用反引号 `` `KIRO_HOME` ``。R4.1.5 要显示路径，必踩
  - [ ] 文案说明热重载（保存即在轮次边界生效，不必重启 Kiro）
  - [ ] 顺手修 `mcp.rs:3352` "at launch" 注释为热重载真实语义（注释错会误导下一个人）
  - [ ] 路由/权限/feature flag：本项无新增（复用既有 command 与路由）

## 🛠️ 6. 操作约束（本仓实测，非通用）

- **`edit_block` 用单行短 `old_string`**：本仓 `core.autocrlf=true` → mixed CRLF/LF，
  多行 `old_string` 会报 "IDENTICAL except line endings"；`edit_block_multiple` 是 per-file atomic，
  一处 fail 全 rollback（E-042）
- **`pnpm eslint` 不能当验收门**：CRLF vs prettier LF → 全仓 ~215063 个 `Delete ␍`，与本改动无关
  （未改动的 `src/lib/types.ts` 单文件就 3068 个）。替代门：`npx tsc --noEmit` + `pnpm test`
- 验收命令：`npx tsc --noEmit -p tsconfig.json` + `pnpm test`（基线 221 files / 2776 tests 全绿）
- **严禁 `cargo fmt`**（仓内无 `rustfmt.toml`，会重排 ~90 个无关文件）

## 📋 7. 同批收尾（本轮一并做完）

1. `tasks.md:166` / `:418` 陈旧判据「失败集合 ⊆ 已知 8 项」→ 改为全绿 / EXIT=0。
   **依据 E-082 Evidence#2**（该条 evidence 记的就是这两行）：基线红 N 个时把验收写成
   「这 N 个之外全绿」→ 新回归可顶替旧失败而总数不变 → 门禁不可证伪。
   而 `df5ee401` 已修掉那 8 个（Windows `/tmp` fixture）、基线本就全绿 → 正解是直接改成全绿，
   不是改成集合比较
2. 补勾 W0 验收框 `tasks.md:165-168`（W0 已 ship 于 `4edb8f0d`）
3. `codegraph init` + `sync`（实测本仓未 init，`codegraph_node` 报 "not initialized"）
4. 删 `.worktrees/kiro-p1..p4`（成果均已按文件 copy 合入并提交）
   ⚠️ **`cmd /c rmdir /s /q` 独占一次工具调用，command 内不得有任何 `;`/`&&`/换行**；
   禁 `git worktree remove`（E-003/E-004 跟随 junction 删主仓）；
   删后单独一次调用验「目标已消失 **且** 主仓 `.git` 仍在」（C-010）

## 更新日志

- 2026-07-26 卡落盘，业务代码零行。用户裁决方案 A。官方文档实读推翻「at launch」注释；
  确认全网无可套用实现；workspace 选择器复用 `skills-settings.tsx` 既有模式。
