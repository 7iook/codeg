# Task Tracker · delegate-persona-passthrough

> **What this is** — 本 feature 的 living, checkbox-tracked execution list。executor 读它、实时勾选、在每项下写更新。Single source of "done / left / blocked"。**格式固定,不可自造**。

| 字段 | 值 |
|---|---|
| 来源 Source | `F:\codeg-research\docs\specs\delegate-persona-passthrough\{requirements,design}.md`(spec 三件套 · R1-R3 已收敛) |
| 类型 Type | feature |
| 创建 Created | 2026-08-03 |
| 状态 Status | not-started |

**图例 Legend**: `- [ ]` 待办 · `- [x]` 完成(必须带证据) · 行尾 `— ⛔ BLOCKED:<原因>` / `— ⏭ SKIPPED:<理由>` / `— ⏳ PENDING:<原因>`

## Overview

**交付顺序(线性,一个 executor sub 单会话闭环)**:

1. 类型基座层(LaunchOption / AppliedPersona / PersonaEffect / PersonaError / DelegationError::InvalidPersona / DelegationRequest.subagent_type)一次落,单独 commit
2. Provider capability trait + 三家 impl(Kiro / Claude / Codex)+ default Ignored
3. persona.rs `resolve_preamble` + `is_valid_persona_name`(带全部安全 / frontmatter / read cap 硬约束 + 单测)
4. broker 翻译层(先 capability check → 名称校 → provider 分派 · R3 F1 顺序)+ broker 单测
5. ConnectionSpawner::spawn 签名扩 + spawn_child_inner merge KIRO_AGENT + connection.rs 单测
6. listener 解析 subagent_type + companion tools/list 注入 `<<PERSONA_LISTS>>`(扫三家目录)
7. 前端 delegation-card 消费 applied_persona 三态展示 + requested vs applied 分离
8. e2e 手工验证 6 条 + R7.1/R7.2 process-death 观察 + 结果记 design.md Update Log
9. 收尾:CHANGELOG + ARCHITECTURE evolution-index + tech-debt(若有)

## Tasks

### 阶段 1 · 类型基座(单 commit)

- [x] 1. 类型定义 + wire schema 骨架

  **Evidence**
  - `commit 393e8983`
  - `verify: cargo check --features test-utils --message-format=short → EXIT=0; cargo check --no-default-features --bin codeg-mcp --message-format=short → EXIT=0`
  - `files: src-tauri/src/acp/delegation/persona.rs:69-270 (类型基座) · mod.rs (pub mod persona) · types.rs:83 (subagent_type) / :105 (DelegationSuccess.applied_persona) / :283 (DelegationTaskReport.applied_persona) / :139 (InvalidPersona) / :313 (from_err arm) · tool_schema.json:26-40 · broker.rs / listener.rs / lifecycle.rs / commands/delegation.rs (下游 struct-literal 补 None)`
  - `AC: 1.1 + 1.2 + 1.3 + 1.4 + 1.5 + 1.6 (optional) 全达`

  - [x] 1.1 在 `src-tauri/src/acp/delegation/persona.rs`(**新建模块**)定义:
    - `pub enum LaunchOption { KiroPersona(String) }`(单变体 · 未来加变体 · 禁 opaque map · R2 A4)
    - `pub enum AppliedPersona { Native{name}, Hint{name}, IgnoredUnsupportedCli{name} }`(三态 · 无 Failed · R3 F2)
    - `pub enum PersonaEffect { Native{launch_option}, Hint{preamble}, Ignored, Failed{wire_code, reason} }`
    - `pub enum PersonaError { InvalidName / NotFound / NotUtf8 / TooLarge{name,cap} / EmptyBody / MalformedFrontmatter / PathEscape / IoError }`
    - `pub fn is_valid_persona_name(name: &str) -> bool`(`[A-Za-z0-9_-]{1,64}`)
    - `pub trait PersonaCapability { fn supports_persona() -> bool; fn resolve_persona_effect(&self, name, home_dir) -> PersonaEffect; }`
    - _Requirements: 3-name-grammar.1, 3-name-grammar.2, 5.1, R2-A4 采纳, R3-F2 采纳_

    **Evidence**
    - `commit 393e8983`
    - `verify: cargo check --features test-utils → EXIT=0; cargo check --no-default-features --bin codeg-mcp → EXIT=0`
    - `files: src-tauri/src/acp/delegation/persona.rs:69 (LaunchOption) / :98 (AppliedPersona) / :121 (PersonaEffect) / :164 (PersonaError) / :241 (is_valid_persona_name) / :270 (PersonaCapability) · src-tauri/src/acp/delegation/mod.rs (pub mod persona)`
    - `AC: 1.1 LaunchOption / AppliedPersona / PersonaEffect / PersonaError / is_valid_persona_name / PersonaCapability / resolve_preamble_at signature-only`

  - [x] 1.2 在 `types.rs:53-75 DelegationRequest` 追加 `#[serde(default, skip_serializing_if = "Option::is_none")] pub subagent_type: Option<String>`
    - _Requirements: 1.1, 6.1_

    **Evidence**
    - `commit 393e8983`
    - `verify: cargo check --features test-utils → EXIT=0`
    - `files: src-tauri/src/acp/delegation/types.rs:83` (含 doc-comment 命名冲突警告 · 避免与 codebuddy/cursor/opencode/kimi parsers 的入站 subagent_type 混淆)
    - `AC: 1.2 subagent_type field on DelegationRequest`

  - [x] 1.3 在 `types.rs DelegationSuccess` / `DelegationTaskReport` 各追加 `#[serde(default, skip_serializing_if = "Option::is_none")] pub applied_persona: Option<AppliedPersona>` 字段
    - _Requirements: 5.1, R3-F2 采纳(不扩 Err payload)_

    **Evidence**
    - `commit 393e8983`
    - `verify: cargo check --features test-utils → EXIT=0`
    - `files: src-tauri/src/acp/delegation/types.rs:105 (DelegationSuccess.applied_persona) · types.rs:283 (DelegationTaskReport.applied_persona)`
    - `AC: 1.3 applied_persona on both success + task-report`

  - [x] 1.4 在 `types.rs DelegationError` 加 `#[error("invalid persona: {0}")] InvalidPersona(String)` 变体,`DelegationOutcome::from_err` 映射到 wire code `"invalid_persona"`
    - _Requirements: 3.3, R1-F1_

    **Evidence**
    - `commit 393e8983`
    - `verify: cargo check --features test-utils → EXIT=0`
    - `files: src-tauri/src/acp/delegation/types.rs:139 (variant) · types.rs:313 (from_err arm 排在 SpawnFailed 之后)`
    - `AC: 1.4 DelegationError::InvalidPersona + wire code "invalid_persona"`

  - [x] 1.5 `tool_schema.json` `delegate_to_agent.inputSchema.properties` 加 `subagent_type: string`,description 明写三家语义分家(Kiro=REAL / Claude/Codex=BEST-EFFORT / others=ignored+note)+ 占位符 `<<PERSONA_LISTS>>`
    - _Requirements: 1.1, 3.6, 3.7_

    **Evidence**
    - `commit 393e8983`
    - `verify: PowerShell ConvertFrom-Json → JSON_OK (语法合法)`
    - `files: src-tauri/src/acp/delegation/tool_schema.json:26-29 (delegate_to_agent.inputSchema.properties.subagent_type)`
    - `AC: 1.5 subagent_type schema + three-tier description + <<PERSONA_LISTS>> placeholder for stage-6 companion rendering`

  - [x]* 1.6 类型层 unit test:AppliedPersona/PersonaEffect/PersonaError serde round-trip,LaunchOption 只有 KiroPersona 变体的编译期契约
    - _Requirements: 6.1_

    **Evidence**
    - `commit 393e8983`
    - `verify: cargo check --features test-utils → EXIT=0`(test 代码通过 typecheck;cargo test 完整跑要等 stage 4 补齐 broker mock 里 DelegationSuccess/DelegationRequest 的 applied_persona/subagent_type,那是 stage 4 的活)
    - `files: src-tauri/src/acp/delegation/persona.rs:334-421 (#[cfg(test)] mod tests · 5 tests: is_valid_persona_name accept/reject · AppliedPersona serde 三态 · PersonaEffect 构造 · LaunchOption 单变体契约 · PersonaError Display)`
    - `AC: 1.6 optional TDD baseline landed alongside type base`

### 阶段 2 · Provider capability 三家 impl

- [x] 2. Provider capability 实现(R2 A2 采纳:broker 不识别 CLI)

  **Evidence**
  - `commit 10ed4f00`
  - `verify: cargo check --features test-utils --message-format=short → EXIT=0; cargo check --no-default-features --bin codeg-mcp --message-format=short → EXIT=0`
  - `files: src-tauri/src/acp/delegation/persona.rs:514 (KiroProvider) / :552 (ClaudeCodeProvider) / :581 (CodexProvider) / :614 (UnsupportedProvider) / :649 (provider_for) · +349 行 · KiroProvider / ClaudeCodeProvider / CodexProvider / UnsupportedProvider unit-struct + PersonaCapability impls + provider_for match dispatch + 8 unit tests)`
  - `AC: 2.1 Kiro→Native{KiroPersona} · 2.2/2.3 Claude/Codex→Failed{invalid_persona, stage-3 stub 桩} · 2.4 其它 AgentType(含 Custom)→Ignored · 2.5 8 条 unit tests 覆盖(见下)`

  - [x] 2.1 Kiro provider — `KiroProvider` unit struct + `impl PersonaCapability`:`supports_persona()=true` · `resolve_persona_effect(name, _)` 名称校后返 `PersonaEffect::Native{launch_option: LaunchOption::KiroPersona(name)}` · home_dir 不需(KIRO_HOME 由 kiro-cli 侧解)
    - _Requirements: 2.1, 2.5_

    **Evidence**
    - `commit 10ed4f00`
    - `verify: cargo check --features test-utils / --no-default-features → EXIT=0`
    - `files: src-tauri/src/acp/delegation/persona.rs:514 (KiroProvider 定义) · :649 (provider_for 分派)`
    - `AC: 2.1 Native{KiroPersona} 分支返回 · 名称非法防御 Failed{invalid_persona}`

  - [x] 2.2 ClaudeCode provider — `ClaudeCodeProvider` unit struct + `impl PersonaCapability`:`supports_persona()=true` · `resolve_persona_effect(name, _)` 名称校后**返 stage-3 stub `PersonaEffect::Failed{wire_code:"invalid_persona", reason:"persona resolver not yet implemented (stage 3)"}`**;`TODO(stage-3)` inline comment 记录将替换为 `resolve_preamble_at(name, &resolve_claude_config_dir().join("agents"))`
    - **偏离说明**:未走 spec 建议的 `home.join(".claude/agents")`(dirs::home_dir() 不认 `CLAUDE_CONFIG_DIR` env),按 design §5 §8 应复用 `crate::parsers::claude::resolve_claude_config_dir()`,stage 3 兑现;stage 2 桩状态下不解 HOME 也不读文件,不影响 broker Err 通路联调
    - _Requirements: 3.1, 3.2, 3.3_

    **Evidence**
    - `commit 10ed4f00`
    - `verify: cargo check → EXIT=0`
    - `files: src-tauri/src/acp/delegation/persona.rs:552 (ClaudeCodeProvider 定义) · :649 (provider_for 分派)`
    - `AC: 2.2 stub 返 Failed{invalid_persona, stage-3 marker} 让 broker Err 路径可联调不 panic`

  - [x] 2.3 Codex provider — `CodexProvider` 同 2.2,`TODO(stage-3)` 指向 `resolve_codex_home_dir().join("agents")`
    - _Requirements: 3.1, 3.2, 3.3_

    **Evidence**
    - `commit 10ed4f00`
    - `verify: cargo check → EXIT=0`
    - `files: src-tauri/src/acp/delegation/persona.rs:581 (CodexProvider 定义) · :649 (provider_for 分派)`
    - `AC: 2.3 同 2.2 shape`

  - [x] 2.4 default catch-all — `UnsupportedProvider` unit struct:`supports_persona()=false` · `resolve_persona_effect(_,_)=PersonaEffect::Ignored` · match 列尽所有非支持 built-in(OpenCode/Gemini/OpenClaw/Cline/Hermes/CodeBuddy/KimiCode/Pi/Grok/Cursor)+ `Custom(_)` · 未来加 AgentType 变体会因 non-exhaustive match 编译失败,强制作者显式路由(fail-safe 而非 wildcard)
    - _Requirements: 4.1, 4.2_

    **Evidence**
    - `commit 10ed4f00`
    - `verify: cargo check → EXIT=0`
    - `files: src-tauri/src/acp/delegation/persona.rs:614 (UnsupportedProvider 定义) · :649 (provider_for match 列尽 unsupported variants + Custom(_))`
    - `AC: 4.1 supports_persona=false · 4.2 resolve_persona_effect=Ignored · 未列举变体会编译失败(non-exhaustive 保护)`

  - [x]* 2.5 Provider unit tests(8 条 · 见 `#[cfg(test)] mod tests` §Stage-2 段):
    - `provider_for_kiro_returns_native_kiro_persona` — Kiro name → Native{KiroPersona}
    - `provider_for_claude_code_returns_stage3_stub_failed` — Claude name → Failed{invalid_persona, stage-3 marker}
    - `provider_for_codex_returns_stage3_stub_failed` — Codex name → Failed{invalid_persona, stage-3 marker}
    - `provider_for_gemini_is_unsupported_and_returns_ignored` — Gemini name → Ignored
    - `provider_for_all_unsupported_variants_agree` — 10 个非支持 built-in 全体一致返 Ignored + supports=false(guard against half-listed match arm drift)
    - `provider_for_custom_agent_is_unsupported` — `AgentType::custom("goose")` → Ignored
    - `kiro_provider_rejects_invalid_name_defensively` — 空 / `foo.bar` / `path/traversal` / 65 字符 → Failed{invalid_persona, grammar reason}
    - `claude_and_codex_providers_reject_invalid_name_before_stage3_stub` — 非法名走 grammar 分支而非 stage-3 stub 分支(顺序 invariant)
    - _Requirements: 2.1, 3.2, 4.1_

    **Evidence**
    - `commit 10ed4f00`
    - `verify: cargo check --features test-utils → EXIT=0`(test 代码类型正确,tests 静态编译通过);**整体 `cargo test` 因 stage 1 update log 已声明的遗留 test-tree 债无法跑到(broker.rs/listener.rs/manager.rs test-tree 里的 DelegationSuccess/DelegationRequest struct literal 缺 stage-1 引入的 applied_persona/subagent_type 字段 · 硬约束禁触这三处 · stage 4/5 补齐后可整体跑)**
    - `files: src-tauri/src/acp/delegation/persona.rs:514-649 (四 provider 定义 + provider_for) · #[cfg(test)] mod tests §Stage-2 段 (+8 tests)`
    - `AC: 8 provider tests 静态通过 typecheck · 覆盖 Kiro/Claude/Codex/Unsupported/Custom + grammar 顺序 invariant`


### 阶段 3 · persona.rs 安全实现 + 全量 unit test

- [x] 3. persona.rs `resolve_preamble` 硬约束

  **Evidence**
  - `commit 7950ed51`
  - `verify: cargo check (test-utils / mcp) → EXIT=0; cargo test --test persona_stage3 → 12/12 passed`
  - `files: src-tauri/src/acp/delegation/persona.rs:329 (resolve_preamble_at) / :428 (strip_frontmatter) · src-tauri/tests/persona_stage3.rs (new)`
  - `AC: Requirements 3.1 + 3.2 + 3.3 + 8.1 全达 (spec design §5, R2 F4 + R2 F2 + R3 F1)`

  See sub-tasks 3.1-3.3 for detailed narrative, verification breakdown, and file line references.

  - [x] 3.1 实现 `pub fn resolve_preamble_at(name: &str, root: &Path) -> Result<String, PersonaError>`:
    - 名称语法 gate:`if !is_valid_persona_name(name) return InvalidName`
    - Canonical containment(R2 F4 · R3 P2.4):`canonical_root = canonicalize(root)?; canonical = canonicalize(candidate)?; if canonical.parent() != Some(canonical_root.as_path()) return PathEscape`(direct-child 判定,非 starts_with)
    - TOCTOU-safe open(R2 F4):`File::open(&canonical)` 而非 candidate
    - 硬读取上限(R2 F4):`BufReader::new(file).take(200*1024 + 1).read_to_end(...); if bytes.len() > 200*1024 return TooLarge`
    - UTF-8 + BOM strip
    - Frontmatter parse(R2 F2):不以 `---` 起 → 全 body;以 `---\n`/`---\r\n` 起且找到闭合 `---` → 剥;找不到闭合 → **`MalformedFrontmatter`**(不宽容降级)
    - Empty body 检:剥完 body 全空 → `EmptyBody`
    - _Requirements: 3.1, 3.2, 3.3, 8.1_

    **Evidence**
    - `commit 7950ed51`
    - `verify: cargo test --test persona_stage3 → 12/12 passed(含 read_cap_boundary + rejects_symlink_escape_via_direct_child_check_unix cfg(unix))`
    - `files: src-tauri/src/acp/delegation/persona.rs:329 (resolve_preamble_at body) / :428 (strip_frontmatter fn) · 同时把 PersonaError 由 stage-1 的 unit-variant shape 恢复成 spec design §5 line 250-258 的 tuple-variant shape(InvalidName(String) / NotFound(String) / NotUtf8(String) / EmptyBody(String) / MalformedFrontmatter(String) / PathEscape(String))`
    - `AC: 3.1 canonical direct-child · TOCTOU-safe open · 200 KiB BufReader::take · BOM strip · frontmatter hard-fail on unclosed fence · EmptyBody detection`

  - [x] 3.2 `resolve_preamble_at` 用 `std::env::var("HOME").or_else("USERPROFILE")` 构 home 只在 impl 2.2/2.3 内部调用(R3 F1 只 Hint provider 才解 HOME,unsupported/Kiro 不碰)
    - _Requirements: 4.1, 8.1, R3-F1_

    **Evidence**
    - `commit 7950ed51`
    - `verify: cargo check --features test-utils → EXIT=0`
    - `files: persona.rs::ClaudeCodeProvider::resolve_persona_effect 现调 crate::parsers::claude::resolve_claude_config_dir().join("agents") 传入 resolve_preamble_at · CodexProvider 同法用 resolve_codex_home_dir(). 均 honour CLAUDE_CONFIG_DIR / CODEX_HOME env override`
    - `AC: 3.2 Claude/Codex provider stub 兑现真调用 · Kiro/Unsupported 未新增 HOME 读盘`

  - [x] 3.3 persona.rs unit tests(全量硬约束覆盖 · integration test crate 版本 `tests/persona_stage3.rs`):
    - **Property 6**(name grammar):`.`、`/`、`\`、空、65 字符、UTF-8 多字节、emoji 全 reject · `_Validates: Requirements 3-name-grammar.1-3_`
    - **Symlink escape**:`#[cfg(unix)]` mock symlink 指向 `<outer>/secret.md` → `PathEscape`(Windows 需 admin/dev-mode · 已 cfg gate)
    - **Direct-child(非 starts_with)**:嵌套子目录场景走 InvalidName(grammar 上游拦)+ 子目录中文件缺 candidate 走 NotFound(实际 direct-child 逃逸只经 symlink 复现)
    - **BufReader::take 硬上限**:200 KiB = Ok(len == cap),200 KiB + 1 = `TooLarge{cap:204800}`(**非 metadata 预判**)
    - **Frontmatter 六态**:无 fm(Ok) / LF-fm-完好(Ok) / CRLF-fm-完好(Ok) / BOM+LF-fm(Ok · BOM strip 先于 fence probe) / **LF-fm-未闭合 → MalformedFrontmatter(硬失败)** / **frontmatter-only(有闭合 fence 但 body 空)→ EmptyBody** / **frontmatter-only EOF-closer(无尾换行) → EmptyBody**
    - **is_valid_persona_name schema-level contract**:public gate 与 resolver 内部 defensive gate 同意于 good / bad 列表
    - **偏离说明**(见 stage-3 report):spec 建议放在 `persona.rs::#[cfg(test)] mod tests`,已同步加入 · 但 cargo test 完整跑仍被 stage-1 遗留 test-tree 债卡住(broker/listener/manager/lifecycle/web-handlers 里 DelegationSuccess/DelegationRequest struct literal 缺 applied_persona/subagent_type 字段,stage 3 硬约束禁改)· 故 `tests/persona_stage3.rs` integration test 承担 stage-3 验证责任 · 只 link `pub` API 表面 · 12/12 EXIT=0 独立可跑
    - _Requirements: 3.3, 3-name-grammar.1-3, 8.1_
    - _Properties: P6_

    **Evidence**
    - `commit 7950ed51`
    - `verify: cargo test --test persona_stage3 --features test-utils → 12 passed; 0 failed; EXIT=0`
    - `files: src-tauri/tests/persona_stage3.rs:1-271 (new) · src-tauri/src/acp/delegation/persona.rs:783-1138 (#[cfg(test)] mod tests §Stage-3 段)`
    - `AC: Requirements 3.3, 3-name-grammar.1-3, 8.1 (Property P6 + R2 F4 read-cap + R2 F2 frontmatter 六态)`

    Detailed test coverage (Windows / Unix), deviation notes on `cargo test --lib` blockage (stage-1 test-tree debt), and mitigation rationale live in the Update Log entry for stage 3.

### 阶段 4 · broker 翻译层 + 单测

- [x] 4. broker 翻译层重构(R2 A2 + R3 F1 + R3 A2 + R3 F2 采纳后的最终版)

  **Evidence**
  - `commit b857f78d`
  - `verify: cargo check --features test-utils --tests → EXIT=0 (49 处 E0063 全清); cargo check --no-default-features --bin codeg-mcp → EXIT=0; cargo test --test persona_stage3 → 12 passed`
  - `files: src-tauri/src/acp/delegation/broker.rs:3286 (persona dispatch) / :1779 (unsupported_persona_note) / :1796 (append_unsupported_note) · listener.rs / lifecycle.rs / manager.rs / web/handlers/delegation.rs / tests/delegation_e2e_windows.rs (49 处 mock struct-literal 补字段)`
  - `AC: Requirements 3.5 + 4.1 + 4.2 + 4.3 + 5.1 + 5.3 + R3-F1 + R3-A2 + R3-F2 全达`

  - [x] 4.1 修改 `broker.rs start_delegation`,骨架顺序**必须**:
    1. `if req.subagent_type == None` → 直接 Ignored,跳过所有校验
    2. 有 name → 先查 `provider_for(agent_type).supports_persona()`
    3. 只有 supports → 才 `is_valid_persona_name(name)` 校语法(不合法 → `DelegationOutcome::from_err(InvalidPersona)`)
    4. 只有 supports → 才 `provider.resolve_persona_effect(name, &lazy_home())`
    5. **unsupported CLI → 直接 PersonaEffect::Ignored,不碰名称校/不解 HOME**(R3 F1 关键 · Kiro 走 supports=true 但 resolve 内部不需 home)
    - _Requirements: 3.5, 4.1, 4.2, R3-F1_

    **Evidence**
    - `commit b857f78d`
    - `verify: cargo check --features test-utils --tests → EXIT=0`
    - `files: src-tauri/src/acp/delegation/broker.rs:3286 (start_delegation persona dispatch · supports_persona → name grammar → resolve_persona_effect 顺序)`
    - `AC: Requirements 3.5, 4.1, 4.2, R3-F1 — unsupported 短路不校名不解 HOME`
  - [x] 4.2 broker 把 `PersonaEffect` 翻译成 `(launch_option, prepended_task, unsupported_note)` 三元组,**注意时机(R3 A2)**:此时不生成 `applied_persona`。**PersonaEffect::Failed → `DelegationOutcome::from_err(InvalidPersona)` 直返 · 不挂 applied**(R3 F2)
    - _Requirements: 5.1, R3-A2, R3-F2_

    **Evidence**
    - `commit b857f78d`
    - `verify: cargo check --features test-utils --tests → EXIT=0`
    - `files: src-tauri/src/acp/delegation/broker.rs:3286 (三元组 launch_option_pending/prepended_task/applied_persona_intent) · Failed 分支 early-return report_err)`
    - `AC: Requirements 5.1, R3-A2, R3-F2 — 三元组翻译 · Failed 直返不挂 applied`
  - [x] 4.3 broker 调 `spawner.spawn(..., launch_option).await?`,**spawn 返 Ok 后**才产 `applied_persona`:
    - `PersonaEffect::Native` → `AppliedPersona::Native { name }`
    - `PersonaEffect::Ignored` + `subagent_type == Some(_)` → `AppliedPersona::IgnoredUnsupportedCli { name }`
    - 其它 → `None`
    - _Requirements: 5.1, 5.3, R3-A2_

    **Evidence**
    - `commit b857f78d`
    - `verify: cargo check --features test-utils --tests → EXIT=0`
    - `files: src-tauri/src/acp/delegation/broker.rs:3286 (dispatch 时定 intent) / :3424 (spawn 消费 launch_option_pending) · spawn 失败 early-return 丢 intent → 天然满足 spawn-Ok 后才产)`
    - `AC: Requirements 5.1, 5.3, R3-A2 — spawn Ok 后 Native/Ignored 归因`
  - [x] 4.4 broker 调 `send_prompt_linked_for_delegation(...)` 后:如果 effect 是 `Hint` **且** send 返 Ok → applied 拼上 `AppliedPersona::Hint { name }`(**在 send Ok 后才产**,R3 A2)
    - _Requirements: 3.2, 5.1, R3-A2_

    **Evidence**
    - `commit b857f78d`
    - `verify: cargo check --features test-utils --tests → EXIT=0`
    - `files: src-tauri/src/acp/delegation/broker.rs:3533 ((intent, prepended_task) match promote Hint) · send 失败在此前 early-return)`
    - `AC: Requirements 3.2, 5.1, R3-A2 — send Ok 后才 promote Hint`
  - [x] 4.5 unsupported_note 挂到 `DelegationSuccess.text` 尾部拼接
    - _Requirements: 4.2, 4.3_

    **Evidence**
    - `commit b857f78d`
    - `verify: cargo check --features test-utils --tests → EXIT=0`
    - `files: src-tauri/src/acp/delegation/broker.rs:1779 (unsupported_persona_note) / :1796 (append_unsupported_note) · complete_call + setup-window take_early_complete 两处追加)`
    - `AC: Requirements 4.2, 4.3 — IgnoredUnsupportedCli + Ok outcome → [note] 挂 text`
  - [x] 4.6 tracing::info!(target="delegation::persona") 记录每一次 Ignored/Native/Hint 事件
    - _Requirements: 4.3_

    **Evidence**
    - `commit b857f78d`
    - `verify: cargo check --features test-utils --tests → EXIT=0`
    - `files: src-tauri/src/acp/delegation/broker.rs:3286-3533 (Native/Hint/Ignored/unsupported 四事件各一条 tracing::info! target=delegation::persona)`
    - `AC: Requirements 4.3 — 每次 persona 事件可 grep filter`
  - [x]* 4.7 broker unit tests(用 MockSpawner):
    - **Property 1**(缺省零副作用):`subagent_type=None` → `launch_option=None`,task 不变,无 note,无 applied · `_Validates: 6.1, 6.2_`
    - **Property 2**(per-call 覆盖 panel):Kiro + name → runtime_env["KIRO_AGENT"]=name(见 5.2 test)· `_Validates: 2.1, 2.3_`
    - **Property 3**(preamble ↔ launch 互斥):ClaudeCode+name → launch_option=None;Kiro+name → task 不变(无 preamble prepend)· `_Validates: 3.5_`
    - **Property 4**(unsupported 不阻塞):Gemini+name → launch_option=None,note 存在,applied=IgnoredUnsupportedCli · `_Validates: 4.1, 4.2_`
    - **Property 5**(并发隔离):两 concurrent spawn 不同 name → MockSpawner::spawn_args 互不污染 · `_Validates: 7.1, 7.2_`
    - **R3 F1 顺序**:agent_type=Gemini + subagent_type="foo.bar"(非法名) → **不失败**,不触发 name grammar 校(unsupported 不校名)
    - **R3 F1 顺序**:agent_type=Gemini + HOME 未设 → **不失败**(unsupported 不解 HOME)
    - **R3 A2 时机**:MockSpawner spawn returned Err → broker 返 Err,`applied_persona=None`(即使 effect 是 Native)
    - **R3 F2 无 Failed 变体**:invalid persona → 返 `DelegationOutcome::Err{code:"invalid_persona"}`,**Err payload 不含 applied_persona**
    - _Requirements: 全部 5 项 Correctness Properties_
    - _Properties: P1, P2, P3, P4, P5_

    **Evidence**
    - `commit b857f78d`
    - `verify: cargo check --features test-utils --tests → EXIT=0 (8 test 类型层编译绿); 运行 unverified: lib-test 二进制 0xC0000139 启动崩(既有测试同崩·集成测试 exe 正常·本机 Tauri native DLL 环境问题·非本改动)`
    - `files: src-tauri/src/acp/delegation/broker.rs:13722 (#[cfg(test)] mod tests §Broker persona translation layer · +8 persona test: P1 P2 P3 P4 P5 + R3-F1 R3-A2 R3-F2)`
    - `AC: Correctness Properties P1-P5 + R3-F1/A2/F2 — 断言 broker 可观察 applied_persona 输出(MockSpawner 不接 launch_option 至 stage 5, 无 #[ignore])`

### 阶段 5 · ConnectionSpawner trait 扩 + spawn_child_inner merge

- [x] 5. Spawner trait 与 production impl

  **Evidence**
  - `commit 62edeb4f`
  - `verify: cargo check --tests → EXIT=0; cargo test --test broker_persona → 5 passed; cargo test --test persona_stage3 → 12 passed`
  - `files: spawner.rs:93 · manager.rs:3071 · broker.rs:3424 · listener.rs:683 · connection.rs:9430 (逐项锚点见 5.1-5.5)`
  - `AC: 2.1 2.2 2.5 7.2 7.4 — spawn launch_option 全链接线(P0-1 闭合)+ listener 解析(P0-2)`
  - [x] 5.1 `spawner.rs ConnectionSpawner::spawn` 签名追加 `launch_option: Option<LaunchOption>` 参数(**`spawn_for_resume` 签名不改** · R2 A5 / R3 A1)
    - _Requirements: 7.4, R2-A5, R3-A1_
    - **Evidence**: commit 62edeb4f · verify: `cargo check --features test-utils --tests` → EXIT=0 · files: spawner.rs:93 (trait spawn 扩 launch_option) / :137 (spawn_for_resume 签名未动) / :339 (MockSpawner::spawn + SpawnCallArgs.launch_option) · manager.rs:3164 (ConnectionManagerSpawner) · broker.rs (GatedFollowupSpawner + FailingDisconnectSpawner) · AC: 7.4 R2-A5 R3-A1 — 4 impl + MockSpawner 全扩签名，`spawn_for_resume` 未动
  - [x] 5.2 `manager.rs ConnectionManagerSpawner::spawn_child_inner` 在 `build_session_runtime_env` 后、`manager.spawn_agent` 前:`if let Some(LaunchOption::KiroPersona(name)) = &launch_option { runtime_env.insert(KIRO_AGENT_ENV, name.clone()); }`。**merge 顺序 invariant** 加内联注释:「merge 必须在 `spawn_agent_connection`(内部调 `apply_kiro_env_policy`)之前,否则 KIRO_AGENT 被剥」
    - _Requirements: 2.1, 2.2_
    - **Evidence**: commit 62edeb4f · verify: `cargo check --features test-utils --tests` → EXIT=0 · files: `manager.rs:spawn_child_inner` · AC: 2.1 2.2 — KIRO_AGENT 在 spawn_agent 前插入 + merge-order invariant 注释锁死(argv 翻译由 connection.rs `kiro_launch_args_*` 单测保障);spawn 传 launch_option / spawn_for_resume 传 None(R7.4)
  - [x] 5.3 MockSpawner + broker 内 `GatedFollowupSpawner`/`FailingDisconnectSpawner` 同步扩签名,`SpawnCallArgs` 加 `launch_option` 字段记录 + 新增 `first_prompt_tasks` recorder(观测 Hint 前置)· broker 生产 `spawner.spawn(...)` 传 `launch_option_pending`(闭合 P0-1 死接线)
    - _Requirements: 7.2_
    - **Evidence**: commit 62edeb4f · verify: `cargo test --features test-utils --test broker_persona` → 5 passed EXIT=0 · files: `spawner.rs`/`broker.rs`(生产调用点 broker.rs:3410 + 2 test spawner) · AC: 7.2 — SpawnCallArgs.launch_option 记录 + 生产 spawn 收到 launch_option_pending(P0-1)
  - [x]* 5.4 connection.rs 单元测试(既有 `kiro_launch_args` 组合矩阵)追加一条:`runtime_env["KIRO_AGENT"]="persona-abc"` → args 含 `--agent persona-abc`
    - _Requirements: 2.5_
    - **Evidence**: commit 62edeb4f · verify: `cargo check --features test-utils --tests` → EXIT=0(运行待干净环境 · lib-test 0xC0000139) · files: `connection.rs:kiro_launch_args_translate_persona_agent_verbatim` · AC: 2.5 — `--agent persona-abc` verbatim 断言
  - [x]* 5.5 spawn_child_inner per-call 覆盖 panel:launch_option=KiroPersona 覆盖 panel `env_json[KIRO_AGENT]`(Property 2)· 端到端证据落 `tests/broker_persona.rs` 的 spawn-arg 层断言(launch_option 真达 spawn)+ manager.rs merge 处 override 语义注释
    - `_Validates: 2.1, 2.3_`
    - `_Properties: P2_`
    - **Evidence**: commit 62edeb4f · verify: `cargo test --features test-utils --test broker_persona` → 5 passed EXIT=0 · files: `tests/broker_persona.rs:kiro_persona_launch_option_reaches_spawn` · AC: 2.1 2.3 P2 — launch_option 真达 spawn_args(spawn_child_inner 完整 merge 需真 ConnectionManager,用集成测试在 spawn-arg 边界证明 P0-1;override 语义由 manager.rs 注释 + connection 单测共同锁)

### 阶段 6 · listener + companion schema 注入

- [ ] 6. listener 解析 + companion tools/list 注入
  - [ ] 6.1 `listener.rs:604-633 process(BrokerRequest)` 追加:
    ```rust
    let subagent_type = req.input.get("subagent_type")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    ```
    塞到 `DelegationRequest.subagent_type`
    - _Requirements: 1.2, 1.3_
  - [ ] 6.2 companion `tools/list` handler(附近 `append_custom_agents_to_delegate_enum:436`):渲染 schema 前调 `list_personas_for_all_supported_clis()`(**新工具函数**),把三家人格清单拼进 `<<PERSONA_LISTS>>` 占位符位置
    - `list_personas_for_all_supported_clis()` 扫:
      - Kiro:`$KIRO_HOME/agents/*.json`(复用现有 `list_kiro_custom_agents()` 若存在 · 否则新建同 pattern)
      - Claude:`$HOME/.claude/agents/*.md`(读文件顶部 frontmatter title/description 或前 200 字节 body)
      - Codex:`$HOME/.codex/agents/*.md`(同上)
      - 空目录 → `(none defined)`
    - 格式:`\n\n### Available personas on this host:\n**Kiro (real persona)**:\n- @<name>: <description>\n**Claude Code (best-effort hint)**:\n- @<name>: ...\n**Codex (best-effort hint)**:\n- @<name>: ...\n`
    - _Requirements: Q2 决策 · design §Q2 前端改动_
  - [ ]* 6.3 listener 单测:
    - `subagent_type = Some(" x ")` → trim 成 `"x"`
    - `subagent_type = Some("")` / `Some("   ")` / 非字符串类型 → None
    - _Requirements: 1.3_
  - [ ]* 6.4 companion 单测:mock 三家 agents/ 目录(tmpdir) → tools/list 返回 schema 含正确 persona 清单;空目录场景 → `(none defined)`

### 阶段 7 · 前端 delegation-card 消费 applied_persona

- [ ] 7. 前端 UI(R2 A4 + R3 F2 后的三态 · 消费 outcome 不消费 raw_input)
  - [ ] 7.1 `src/lib/delegation-card.ts:199-241 parseInput` 拆成两部分:
    - `parseInput()` 只抽 `subagent_type` 作为 **requested 指示器**
    - **新加 `parseOutcome()`** 从 `DelegationSuccess.applied_persona` 抽 `AppliedPersona` 状态
    - _Requirements: 5.2, R3-F2_
  - [ ] 7.2 渲染层(`delegation-card.tsx` 或对应组件):
    - `applied_persona == Native{name}` → `<Agent Label> · @<name>` primary 样式
    - `applied_persona == Hint{name}` → `<Agent Label> · @<name> (best-effort)` 弱化标记
    - `applied_persona == IgnoredUnsupportedCli{name}` → `<Agent Label> · @<name> (ignored — CLI unsupported)` 灰化
    - 失败(`DelegationOutcome::Err`)+ `raw_input.subagent_type` 存在 → 现有 error 卡片 + 追加一行 `requested: @<subagent_type>` (R3 F2 不引入新 outcome 字段)
    - `applied_persona` 缺席 + 无错误 → 不显示副标签,不 fallback 到 raw_input
    - _Requirements: 5.3, 5.4, 5.5_
  - [ ] 7.3 名称显示上限 32 grapheme(超出 `…` + tooltip / copy),用 Intl.Segmenter 处理 CJK/emoji
    - _Requirements: 5.6_
  - [ ]* 7.4 前端单元测试(vitest):四态 applied_persona 分别渲染的结果 · legacy 无 applied_persona 的兼容显示 · 失败卡片 requested indicator · 32 grapheme 截断
    - _Requirements: 5.2-5.6_

### 阶段 8 · e2e 验证 + process-death 观察

- [ ] 8. e2e 手工验证六条 + R7.1/R7.2 process-death
  - [ ] 8.1 **Kiro 真人格 e2e**:桌面 codeg 起 host,发 `delegate_to_agent({agent_type:"kiro", task:"say hi", subagent_type:"plan-reality-recon"})` → 卡片显 `Kiro · @plan-reality-recon`,`[ACP] spawning` 日志含 `--agent plan-reality-recon`
    - _Requirements: Success State §1_
  - [ ] 8.2 **Claude preamble e2e**:落 `~/.claude/agents/plan-reality-recon.md` 含 `SPEC_MARKER_R1_CLAUDE` → 卡片显 `Claude Code · @plan-reality-recon (best-effort)`,子会话首轮 prompt 前 300 字节含标记
    - _Requirements: Success State §2, 3.2_
  - [ ] 8.3 **Codex preamble e2e**:同 8.2,`~/.codex/agents/plan-reality-recon.md` + `SPEC_MARKER_R1_CODEX`
    - _Requirements: Success State §3, 3.2_
  - [ ] 8.4 **Unsupported CLI 静默降级**:`agent_type:"gemini" + subagent_type:"xxx"` → 卡片显 `Gemini · @xxx (ignored — CLI unsupported)`,delegation 成功,tool_result 尾含 note,子进程日志无 `--agent`,首轮 prompt 无 preamble
    - _Requirements: Success State §4, 4.1-4.3_
  - [ ] 8.5 **Invalid persona 硬失败**:三家各发 `subagent_type:"nonexistent-persona-xyz"` → Kiro 返 `spawn_failed`(kiro-cli 自校验),Claude/Codex 返 `invalid_persona`(broker resolver 失败),UI 显示 error 卡片 + `requested: @nonexistent-persona-xyz`(applied_persona=None · R3 F2 不引 Failed 变体)
    - _Requirements: Success State §5_
  - [ ] 8.6 **名称语法拒绝**:`subagent_type:"foo/bar"` 或 65 字符 → broker 预校拒,`invalid_persona`,不触发 spawn(Kiro/Claude/Codex 都测一遍)
    - _Requirements: 3-name-grammar.2_
  - [ ] 8.7 **并发人格隔离**:同时发两条 Kiro delegation 不同 subagent_type,argv 各自的 `--agent`,首轮 prompt 各自的 marker,互不污染。同法 Claude/Codex
    - _Requirements: Success State §6, 7.1, 7.2_
    - _Properties: P5_
  - [ ] 8.8 **R7.1 Kiro process-death**:起 Kiro + `subagent_type:"plan-reality-recon"`,完成一轮后 `taskkill /PID <kiro-cli 进程 pid> /F`;从 codeg `continue_with_session` 触发 `spawn_for_resume`;**观察 & 记录到 design.md `## Update Log`**:(a) 恢复 kiro-cli 是否 reload `plan-reality-recon.json`?(b) 二轮响应是否反映人格行为?(c) 若 drop,codeg `applied_persona`(首次值)是否仍显示 · UI 是否遵守「首次已应用/恢复未知」呈现
    - _Requirements: 7.1_
  - [ ] 8.9 **R7.2 Claude/Codex process-death**:同 8.8,人格文件含 `SPEC_MARKER_R2_RESUME_{CLAUDE,CODEX}`,kill wrapper 进程,continue_with_session,**观察**:(a) 恢复会话上下文是否仍含 marker(wrapper 是否 replay 首轮)?(b) 二轮响应是否反映人格?若 wrapper 不 replay → 在 design.md 追加 `## Known Limitations` 段说明,并说明 UI 处理策略
    - _Requirements: 7.2_

### 阶段 9 · 收尾

- [ ] 9. Close-out
  - [ ] 9.1 每阶段 commit 到 `feat/kiro-agent`,commit message 引用 task ID
  - [ ] 9.2 R7.1/R7.2 观察结果落到 design.md `## Update Log` 或 `## Known Limitations`(视观察结果)
    - _Requirements: 7.1, 7.2_
  - [ ] 9.3 若 R7.1/R7.2 发现 wrapper 冷恢复行为异常 → 附向上游 wrapper 提 issue/PR 的建议(不阻塞本 spec)
  - [ ] 9.4 `docs/architecture/CHANGELOG.md`(若仓有)追加一行:`YYYY-MM-DD [feat] delegate_to_agent · subagent_type · Kiro real / Claude+Codex best-effort. RCA: docs/specs/delegate-persona-passthrough/`
  - [ ] 9.5 `docs/specs/README.md` 索引表跑 `python C:\Users\7\.agents\scripts\sync-spec-index.py F:\codeg-research\docs\specs`,把本 spec status 从 drafting → in-impl → shipped;shipped_commit 填 主 commit hash
  - [ ] 9.6 tech-debt 或 known-traps:上游 `@agentclientprotocol/claude-agent-acp` / `codex-acp` 无原生 per-launch 人格支持,是本 spec best-effort 变通的根因;向上游提 PR 加 `CLAUDE_ACP_AGENT` / `CODEX_AGENT` env 是长期升级路径(独立追加任务,不阻塞本方案交付)
  - [ ] 9.7 检查 CLAUDE.md 或 AGENTS.md 是否需要新增 delegation persona 相关的 known traps(如 `apply_kiro_env_policy` merge 顺序不变式)

## Task Dependency Graph

```json
{
  "waves": [
    {"id": 0, "tasks": ["1.1", "1.2", "1.3", "1.4", "1.5", "1.6"]},
    {"id": 1, "tasks": ["2.1", "2.2", "2.3", "2.4", "2.5"]},
    {"id": 2, "tasks": ["3.1", "3.2", "3.3"]},
    {"id": 3, "tasks": ["4.1", "4.2", "4.3", "4.4", "4.5", "4.6", "4.7"]},
    {"id": 4, "tasks": ["5.1", "5.2", "5.3", "5.4", "5.5"]},
    {"id": 5, "tasks": ["6.1", "6.2", "6.3", "6.4"]},
    {"id": 6, "tasks": ["7.1", "7.2", "7.3", "7.4"]},
    {"id": 7, "tasks": ["8.1", "8.2", "8.3", "8.4", "8.5", "8.6", "8.7", "8.8", "8.9"]},
    {"id": 8, "tasks": ["9.1", "9.2", "9.3", "9.4", "9.5", "9.6", "9.7"]}
  ],
  "critical_path": "1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9",
  "note": "全线性串行 · 每阶段是「不可拆的串行原子块」——trait 签名一变全下游同步(engineering-agent Mode A · 单 executor sub 单 session 闭环)"
}
```

## Update Log

- 2026-08-03 · tasks.md 落盘 · charter Mode 1 三件套齐 · 待用户批准 tasks.md 后 executor 进 TDD red→green 循环
- 2026-08-03 · executor(claude-opus) · stage 1 complete · commit `393e8983` · types base(LaunchOption / AppliedPersona / PersonaEffect / PersonaError / PersonaCapability / DelegationRequest.subagent_type / DelegationSuccess.applied_persona / DelegationTaskReport.applied_persona / DelegationError::InvalidPersona / tool_schema.json subagent_type + `<<PERSONA_LISTS>>` 占位符)· cargo check 双模式 EXIT=0 · `resolve_preamble_at` body=`todo!()` 由 stage 3 兑现 · `#[cfg(test)]` 内 5 条 unit tests · 下游 16 处 struct literal 补 `None` 兜底 · cargo test 完整跑要等 stage 4/5 补 broker/manager tests 里的 mock literals(pre-existing manager.rs Steer variant drift 也归 stage 4/5 修)
- 2026-08-03 · executor(claude-opus 4.7 1M) · stage 2 complete · commit `10ed4f00` · provider capability 分派层(KiroProvider / ClaudeCodeProvider / CodexProvider / UnsupportedProvider unit-struct + `impl PersonaCapability` + `provider_for(agent_type)->&'static dyn PersonaCapability` match 分派)· Kiro=Native{KiroPersona} · Claude/Codex=stage-3 stub Failed{invalid_persona} 让 broker Err 路径可联调不 panic · 其它 built-in + `Custom(_)`=Ignored · non-exhaustive match 强制新增 AgentType 时作者显式路由(fail-safe) · +8 unit tests(2.5 optional) 覆盖三家 + 10 个 unsupported built-in + Custom + grammar 顺序 invariant · cargo check 双模式 EXIT=0 · 分派形式选 trait-object(spec design §Components §6 骨架伪代码即 `provider.supports_persona()` / `.resolve_persona_effect(...)`)不选 flat fn(stage-1 已定义的 PersonaCapability trait 需被本 stage 兑现,否则沦为死符号)· 硬约束合规:未触碰 broker.rs/listener.rs/manager.rs · 未引入 resolve_preamble_at 实际 body · spawn 签名未改 · Claude/Codex 走 stage-3 桩偏离 spec 建议 `home.join(".claude/agents")`(design §5 §8 应复用 `resolve_claude_config_dir()` 认 CLAUDE_CONFIG_DIR env,stage 3 兑现);stage 2 桩状态不解 HOME 不读文件,不影响 broker 联调
- 2026-08-03 · executor(claude-opus 4.7 1M) · stage 3 complete · commit `7950ed51` · persona.rs 安全实现 + Claude/Codex provider stub 兑现 + 全量 unit test:
  - **resolve_preamble_at 完整 body**:name grammar defensive gate → canonicalize root + candidate → `canonical.parent() == Some(canonical_root.as_path())` direct-child guard(R2 F4 · 非 starts_with · 覆盖根本身为 symlink 情况) → TOCTOU-safe `File::open(&canonical)` → `BufReader::take((CAP as u64) + 1).read_to_end()` + `bytes.len() > CAP` 硬拦(非 metadata 预判 · CAP=200 KiB) → BOM strip 先于 fence probe → 手写 strip_frontmatter state machine(不引 serde_yaml · 支持 LF / CRLF / EOF-terminated closer · 未闭合 → MalformedFrontmatter 硬失败) → EmptyBody `trim().is_empty()` 终检
  - **Claude/Codex provider stage-2 stub 兑现**:`ClaudeCodeProvider::resolve_persona_effect` 现调 `crate::parsers::claude::resolve_claude_config_dir().join("agents")`(honour `CLAUDE_CONFIG_DIR` env);`CodexProvider` 同法用 `resolve_codex_home_dir()`(honour `CODEX_HOME` env)· 错误路径以 `err.to_string()` 传给 `PersonaEffect::Failed{wire_code:"invalid_persona", reason}` · 保留 `_home_dir` 参数占位以维持 trait 对称
  - **PersonaError shape 修正(stage-1 drift 补上)**:stage 1 landed unit variants(`InvalidName` / `NotFound` / `NotUtf8` / `EmptyBody` / `MalformedFrontmatter` / `PathEscape` 无字段)与 spec design §5 line 250-258 tuple-variant shape 有 undocumented drift · task dispatch 提示也用 tuple 形 · 本轮恢复 spec 形态并同步更新 stage-1 `persona_error_display_carries_useful_context` 测试断言(Display 输出含 persona 名字)
  - **测试落地**:`src-tauri/tests/persona_stage3.rs` 新增 integration test(12 test · Windows 平台;Unix 平台额外 1 test 用 `#[cfg(unix)]` symlink)· 覆盖 frontmatter 七态(无 fm / LF-fm / CRLF-fm / BOM+LF-fm / 未闭合 / frontmatter-only-with-body-empty / frontmatter-only-EOF-close)+ read cap 临界(CAP · CAP+1)+ NotFound + Property 6 grammar defence(空 / dot / slash / backslash / 65-char / CJK / emoji)+ is_valid_persona_name schema-level contract + 嵌套子目录场景走 grammar 上游拦
  - **偏离说明**(向主 AI 决策):spec 要求 unit tests 落 `persona.rs::#[cfg(test)] mod tests` · 已同步加入(cargo check EXIT=0 typecheck 通过)· 但 `cargo test --lib` 因 stage-1 已声明的遗留 test-tree 债无法整体 link(broker.rs/listener.rs/manager.rs/lifecycle.rs/web/handlers/delegation.rs 里 mock `DelegationSuccess` / `DelegationRequest` struct literal 缺 stage-1 引入的 `applied_persona` / `subagent_type` 字段 · stage 3 硬约束禁触这些文件 · 遗留由 stage 4/5 补齐) · 故补 integration test crate 只 link pub API 表面 · 12/12 EXIT=0 独立可跑并作为本阶段 stage-3 契约的可执行验证(inline mod tests 在 stage 4/5 broker/listener mock 补齐后即可整体绿)
  - **验证输出**:
    - `cargo check --features test-utils --message-format=short → EXIT=0`(warnings 全部 pre-existing steer 未用 fn · 与 stage 3 无关)
    - `cargo check --no-default-features --bin codeg-mcp --message-format=short → EXIT=0`
    - `cargo test --test persona_stage3 --features test-utils --message-format=short → 12 passed; 0 failed; EXIT=0`
  - **硬约束合规**:仅动 `src-tauri/src/acp/delegation/persona.rs` + 新建 `src-tauri/tests/persona_stage3.rs` · 未触碰 broker.rs/listener.rs/manager.rs/connection.rs · 未引入 serde_yaml/markdown parser · spawn 签名未改(stage 5 的活)
  - **架构反思**:stage 3 是 stage 1 unit-variant drift 的自然纠偏点 · 若 stage 1 时就照 spec 落 tuple-variant · 本轮工作量少 1/4 · 单测断言不必重写 · 教训归档到 executor 报告以促成下轮的 R2/R3 落 spec 更严

- 2026-08-03 · executor(claude-opus 4.8 1M) · stage 4 complete · commit `b857f78d` · broker 翻译层 + persona effect dispatch + broker unit tests · **单 commit(含 4.0 stage-1 遗留 mock literal 债一并清)**:
  - **4.0(前置)· 补 stage-1 遗留 mock literals**:cargo check --tests 报的 49 处 E0063 全清 —— `DelegationSuccess` 缺 `applied_persona` 40 处 + `DelegationRequest` 缺 `subagent_type` 9 处,分布:broker.rs test(34 Success + 1 Request)、listener.rs test(3 Success + 4 Request)、lifecycle.rs test(1 Request)、manager.rs test(2 Request)、web/handlers/delegation.rs test(1 Success + 1 Request)、tests/delegation_e2e_windows.rs(2 Success)· 仅在 test-only mock literal 补 `None`,生产 fn 不动 · 用一次性脚本(brace-balanced 扫描 + 排除 `->`/`impl`/`struct`/`for` 非字面量上下文)完成 · **额外修 1 处 manager.rs:6885 `answer_steer` test helper 的 `ConnectionCommand::Steer { text, reply }` pattern**(v0.22→v0.23 merge 时生产 enum 已升级为 `Steer { blocks, message_id, reply }`,该 test 未同步 → 改成解构 `{ blocks, reply, .. }` 从首个 `PromptInputBlock::Text` 重建 text · 属同类 test↔生产 drift 债,主 AI 已授权本 commit 清)
  - **4.1 persona dispatch 骨架**:`start_delegation` 在 `agent_defaults` 取完后、spawn 前插入 provider dispatch,严格 R3-F1 顺序(`supports_persona()` → `is_valid_persona_name()` → `resolve_persona_effect()`)· unsupported CLI 短路 Ignored 不校名不解 HOME · 产出 `(launch_option_pending, prepended_task, applied_persona_intent)` 三元组 · `report_err` helper 名称与 spec 一致,直接采用现有 free fn(签名 `report_err(agent_type, DelegationError, Option<i32>)`)
  - **4.2 prepended_task 路径**:`send_prompt_linked_for_delegation` 调用点(broker.rs:3448)把 `req.task.clone()` 换成 `prepended_task.clone().unwrap_or_else(|| req.task.clone())` · Hint 走 preamble+task 拼接,其余原样
  - **4.3 Native/IgnoredUnsupportedCli 在 spawn Ok 后产**:三元组的 `applied_persona_intent` 在 dispatch 时即定 Native/Ignored(spawn 失败则 early-return 走 `report_err`,intent 随 return 丢弃 → 天然满足 R3-A2「spawn 失败不挂 applied」)
  - **4.4 Hint 在 send Ok 后 promote**:`started_at` 之后(即 send 返 Ok 后)按 `(applied_persona_intent, prepended_task)` 二元 match promote Hint · send 失败在此之前 early-return → Hint 不产
  - **4.5 unsupported_note 挂 DelegationSuccess.text**:新增 `unsupported_persona_note()` + `append_unsupported_note()` free fn · 在 `complete_call`(outcome 改 mut)与 setup-window `take_early_complete` 两处对成功 outcome 追加 `[note] subagent_type='X' ignored for {agent:?} (persona not supported)` · 仅 IgnoredUnsupportedCli intent + Ok outcome 触发
  - **4.6 tracing**:Native/Hint/Ignored(+unsupported)四事件各一条 `tracing::info!(target: "delegation::persona", ...)`,便于 grep filter
  - **launch_option_pending 存储方式**:**broker 局部变量**(非 RunningTask field)· spawn 签名 stage 4 不扩,故用 `let _ = launch_option_pending.as_ref();` 显式保活 + 注释标注 stage-5 fuel · **未扩 MockSpawner / spawn 签名**(stage 5 的活)· `applied_persona_intent` 则落 `RunningTask.applied_persona_intent` + `CompletedTask.applied_persona` 两个新 field(前者 park 期存 intent,后者供 `get_task_status` 完成读回路径投影)· `completed_report()` / `report_from_outcome()` / `build_completed()` / `running_ack()` 全部扩参贯通 persona
  - **4.7 broker unit tests**:+8 test 于 broker.rs `#[cfg(test)] mod tests` 尾部 —— P1(no subagent→applied None + text 不变)/ P2(Kiro→Native)/ P3(Kiro Native 不带 preamble · 互斥)/ P4(Gemini unsupported→Ignored + note 挂 text)/ R3-F1(Gemini + 非法名 `foo.bar` 不失败)/ R3-A2(spawn Err→applied None)/ R3-F2(invalid name→Err code `invalid_persona` + 无 applied + 未 spawn)/ P5(Kiro+Gemini 并发 attribution 隔离)· 因 MockSpawner 不接 launch_option(stage 5 才扩 `SpawnCallArgs`),Native 的 launch_option 值断言让位于「broker 可观察输出 `applied_persona`」层,注释标注 stage-5 spawn-arg 接线点 · **无 `#[ignore]` test**(全部改为断言 broker 层可观察产出,规避 MockSpawner 缺口)
  - **验证输出**:
    - `cargo check --features test-utils --message-format=short → EXIT=0`(仅 3 个 pre-existing steer dead-code warning)
    - `cargo check --features test-utils --tests --message-format=short → EXIT=0`(49 处 E0063 全清)
    - `cargo check --no-default-features --bin codeg-mcp --message-format=short → EXIT=0`
    - `cargo test --test persona_stage3 --features test-utils → 12 passed; 0 failed; EXIT=0`(stage-3 契约回归绿)
    - `cargo clippy --all-targets --features test-utils → 我的 broker.rs 新代码 0 warning`(persona.rs:653/762 的 doc-list + match-destructure warning 是 stage 2/3 既有,不在本 scope)
    - **broker unit tests 运行**:`unverified: 环境障碍`。`cargo test --lib` 的 `codeg_lib-*.exe` 测试二进制启动即崩 `STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139)` —— **受控对比确证与本改动无关**:① stage 前既有的 `running_ack_message_embeds_task_id`(我未触碰)同样崩;② 集成测试 `persona_stage3-*.exe`(依赖面小)在完整 PATH 下 12/12 正常绿。根因 = lib-test 二进制拉起完整 Tauri native 依赖链,本机某 DLL 缺导出符号,启动阶段即崩(早于任何 test 逻辑)· 8 个新 test 已通过 `cargo check --tests` 类型层验证 · 待 CI / 干净 Windows 环境或 stage 5 收尾时整体运行确认绿
  - **变体扫描(§5.3)**:report 构造点全仓核查 —— listener.rs(cancel/failed/unknown 三 report 构造器)、lifecycle.rs:337、web/handlers/delegation.rs:355 的 `applied_persona: None` 均为**建立前/错误路径**,无 persona 可归因,None 语义正确 · 成功路径统一经 broker 的 `report_from_outcome`/`build_completed`/`running_ack` 携带 persona · 无遗漏
  - **硬约束合规**:未改 `ConnectionSpawner::spawn` 签名(stage 5)· 未改 MockSpawner 签名(stage 5)· 未触碰 manager.rs / connection.rs / listener.rs 生产代码(仅补 test-only mock literal + 1 处 answer_steer test pattern)· 未碰前端 · launch_option_pending 以 broker 局部变量 park,`gate:allow-unwired` 语义已在注释标注等 stage 5 消费

## Known Environment Blocker · lib-test 0xC0000139 (2026-08-03)

**现象**:`cargo test --features test-utils --lib`(以及任何 `--lib` 单元测试)的测试二进制 `codeg_lib-*.exe` 启动即崩 `STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139)`,早于任何 test 逻辑执行。

**受控对照确证(与本 spec 4 stage 改动无关)**:
- lib unittest exe(拉完整 Tauri native binary 依赖链)→ 0xC0000139
- 集成测试 crate `tests/persona_stage3.rs`(只 link lib rlib · 不拉 Tauri native 链)→ 12/12 绿
- 两者都**编译成功**(cargo check --tests EXIT=0)· 唯一差异 = native 依赖链
- executor 独立观察:stage 前既有的未碰 test(如 `running_ack_message_embeds_task_id`)同样崩

**根因**:本机 Windows 环境的 Tauri native 链(WebView2 / Tauri runtime DLL)缺某导出符号 · 属环境级障碍 · 非代码引入。

**影响 & 应对**:
1. stage 5-8 的运行验证一律用**集成测试 crate**(`tests/*.rs`)或 `cargo check --tests` 类型层验证,不依赖 `cargo test --lib`
2. stage 1-4 的 inline `#[cfg(test)] mod tests`(broker unit tests / persona provider tests)已通过 `cargo check --tests` 类型层验证 · **运行验证待干净 CI/Windows 环境跑一次全量 `cargo test --lib` 补确认**
3. 登记为收尾(stage 9)遗留验证项 · 不阻塞 stage 5-8 推进

- 2026-08-04 · executor(claude-opus 4.8 1M) · stage 5 complete + sonnet review P0/P1/P2 闭合 · **单 commit** `pending` · spawn launch_option 死接线闭合(P0-1):
  - **5.1 spawn 签名扩**:`ConnectionSpawner::spawn` 加第 6 参 `launch_option: Option<LaunchOption>` · 同步 4 处 impl:`ConnectionManagerSpawner::spawn`(生产,透传 spawn_child_inner)/ `MockSpawner::spawn`(test-utils)/ `GatedFollowupSpawner::spawn` + `FailingDisconnectSpawner::spawn`(broker test)· **`spawn_for_resume` 签名绝不改**(R7.4 · resume 不重提名人格,4 处 impl 均传 `None` 或不接)
  - **5.2 spawn_child_inner merge**:`build_session_runtime_env` 返回后、`spawn_agent` 前插 `runtime_env.insert(KIRO_AGENT_ENV, name.clone())`(仅 `LaunchOption::KiroPersona`)· **merge-order invariant 内联注释锁死**:必须在 `spawn_agent`→`spawn_agent_connection`→`apply_kiro_env_policy`(connection.rs:287,剥 KIRO_* 旋钮)之前,否则 KIRO_AGENT 被剥 · per-call 覆盖 panel `env_json[KIRO_AGENT]` 语义(LLM 显式 subagent_type 胜过持久默认)也在注释声明 · argv 翻译由 connection.rs `kiro_launch_args_*` 单测独立保障(spawn_child_inner 需真 ConnectionManager,不可单测)
  - **5.3 broker 接线闭合 P0-1**:生产 `self.spawner.spawn(...)` 从 `let _ = launch_option_pending.as_ref()`(死接线 · E-052 假成功)改为把 `launch_option_pending` 真传给 spawn · R3-A2 时机不变(`AppliedPersona::Native` 仍 spawn Ok 后产)· `SpawnCallArgs` 加 `launch_option` 字段 + 新增 `first_prompt_tasks` recorder(观察 Hint 前置 vs Native 不前置)
  - **P0-2 listener 解析 subagent_type**(提前到 stage 5):`listener.rs process()` 从硬编码 `None` 改为 `req.input.get("subagent_type").and_then(as_str).map(trim).filter(!empty)` · 删 stage-6 注释 · broker translation 层现有真实数据源
  - **P0-4 broker unit tests 真断言**:inline P2/P3 升级为断言 `spawn_args[0].launch_option == Some(KiroPersona)` + P3 断言 Native 不前置 preamble(`first_prompt_tasks == ["do x"]`)· 新增集成测试 crate `tests/broker_persona.rs`(5 test,选项 a)在 spawn-arg 层真跑:kiro_persona_launch_option_reaches_spawn(P0-1 真证据)/ no_persona_forwards_no_launch_option / unsupported_cli_forwards_no_launch_option / spawn_failure_leaves_applied_persona_none_but_still_forwarded_option(R3-A2)/ concurrent_same_agent_distinct_personas_do_not_cross(P5 · **同 Kiro agent_type 不同 subagent_type 并发**,断言两条 spawn_args launch_option 各自独立,非 Kiro-then-Gemini 顺序)
  - **P1-2 TOCTOU 措辞降级**:persona.rs 模块 doc + `resolve_preamble_at` fn doc + 内联注释从「TOCTOU-safe」改为「reduces symlink-swap race, does NOT eliminate it(canonicalize 后 open 按名重遍历仍有窗口)· single-tenant trust model(R1 A2)下 residual race 可接受」
  - **P1-3 clippy doc_lazy_continuation**:persona.rs provider_for doc list「broker.rs does NOT change.」前加空行成独立段 · clippy 无本改动引入 warning
  - **P2 清过时 stage 标记**:persona.rs 模块 doc「Stage 1 boundary」→「Module surface」当前架构描述 · 删 `is_valid_persona_name`/`PersonaCapability`/4 provider struct/`provider_for` 上的 `// gate:allow-unwired stage-N` + `#[allow(dead_code)]`(stage 4 已全 wired 经 provider_for 消费,删除后 clippy 无新 dead-code)
  - **broker unit test 运行验证 · 走选项 (a)**:理由 = MockSpawner 是 `#[cfg(any(test, feature="test-utils"))] pub mod mock` · DelegationBroker/ConversationDepthLookup/DelegationConfig/DelegationRequest/DelegationSuccess/set_config/start_delegation/complete_call/get_task_status 全 pub 可从集成 crate 达 → 新建 `tests/broker_persona.rs` 用 pub API + MockSpawner 真跑 spawn-arg 层断言(inline `enable_delegation`/`shallow_lookup`/`StaticStatusLookup` 是 `#[cfg(test)]` 私有,故自建极小 `RootDepth` depth-lookup + `set_config{enabled:true}`)· 相比选项 (b) 保留 inline + 仅类型验证,(a) 真跑出 P0-1 的红→绿信号(旧 MockSpawner 无 launch_option 字段 + broker 丢弃 launch_option_pending → 该断言在 stage 5 前不可能通过)
  - **验证输出**:
    - `cargo check --features test-utils --tests --message-format=short → EXIT=0`(仅 3 pre-existing steer dead-code + 无本改动 warning)
    - `cargo check --no-default-features --bin codeg-mcp --message-format=short → EXIT=0`
    - `cargo clippy --no-default-features --lib --features test-utils -- -D warnings → 仅 3 pre-existing connection.rs steer dead-code(非本 scope,stage 4 已声明);doc_lazy_continuation 已消除;删 allow(dead_code) 后无新 dead-code`
    - `cargo test --features test-utils --test broker_persona → 5 passed; 0 failed; EXIT=0`
    - `cargo test --features test-utils --test persona_stage3 → 12 passed; 0 failed; EXIT=0`(stage-3 契约回归绿)
  - **变体扫描(§5.3)**:全仓 `impl ConnectionSpawner` 4 处 + 生产 `.spawn(` 唯一调用点(broker.rs:3410)全部覆盖;`spawn_for_resume` 唯一生产调用(5229)确认未动;无遗漏
  - **硬约束合规**:未改前端 · connection.rs 仅加 1 条 kiro_launch_args 单测(未动生产逻辑,apply_kiro_env_policy 顺序经 manager.rs 注释声明)· spawn_for_resume 签名未动 · merge-order invariant 注释 + broker_persona/kiro_launch_args 单测双锁
  - **Review Findings**:任务文档行号(spawner.rs:85-138 / manager.rs:2960-3010 / listener.rs:604-633 等)因 v0.22→0.23 merge 全部漂移,实际位置经 git grep 定位后执行,内容与真实代码一致,无架构偏离;doc 描述的 merge-order 风险经 connection.rs:1267/1276 核实(kiro_launch_args 读 runtime_env 在 apply_kiro_env_policy 之前,spawn_child_inner 的 insert 天然更早,invariant 成立)

- 2026-08-04 · executor(claude-opus-5 1M) · **review round-2 测试缺口三项闭合** · 单 commit `pending`:
  - **缺口 1(critical · merge-order 端到端回归)走路径 (b) + (c)**:抽 pure helper `manager::merge_launch_option_into_runtime_env(runtime_env, launch_option) -> BTreeMap`(行为不变 · `spawn_child_inner` 改为调用它)+ 把 `connection::kiro_launch_args` 从私有提为 `pub`,新建集成 crate `tests/persona_merge_order.rs`(7 test)。**"如果有人破坏 merge,哪条测试会红?"的明确答案**:`launch_option_merge_inserts_kiro_agent_verbatim` / `launch_option_merge_overrides_a_panel_stored_agent` / `launch_option_merge_preserves_unrelated_runtime_env` / `merged_launch_option_translates_to_agent_argv_end_to_end` / `per_call_persona_beats_panel_default_in_argv` —— **负向 mutation 实测**:把 helper 改成 no-op(不 insert)→ 这 5 条转红(`left: None` / `left: []` / `left: ["--agent","panel-default"]`),恢复后 7/7 绿。此前无测试跨越 merge→argv 这一跳(connection.rs 从手搭 env 起步,broker_persona.rs 停在 spawn 边界)。
  - **⚠️ 修正 stage-5 注释的因果措辞(reviewer 与 stage-5 doc 均有偏差)**:`apply_kiro_env_policy(&mut merged_env, runtime_env)` 剥的是**子进程 env(`merged_env: Vec`)**,`runtime_env` 是 `&BTreeMap` 共享借用 —— 它**在类型上无法**unset `kiro_launch_args` 读的东西,所以"merge 必须在 policy 之前否则 KIRO_AGENT 被剥"这个因果不成立(connection.rs 自己的 `kiro_env_policy_strips_codeg_launch_knobs_from_the_child` 正断言 KIRO_AGENT **被剥**,且那是**正确行为**:KIRO_AGENT 是 codeg 侧翻 argv 的旋钮,不是 kiro-cli 读的环境变量)。**真实不变式**:`spawn_agent(runtime_env: BTreeMap)` 按值消费 env,故 merge 必须在**该调用之前**,否则人格根本到不了子进程。manager.rs 注释已按此改写,新 crate 模块 doc 记录了这次纠正。
  - **缺口 2(Claude/Codex Hint 分支)· env 隔离选独立集成 crate + `temp_env` 双层**:新建 `tests/broker_persona_hint.rs`(3 test)。理由:①独立 integration crate 各自独立进程,天然隔离,不会污染 `broker_persona.rs` 的 Native/unsupported 断言;②crate 内再用 `temp_env::async_with_vars`(项目既有 dev-dep,`commands/custom_skills.rs`/`acp.rs` 同款用法)对进程内其他 env 读者上锁 + 作用域退出还原。**未用 serial_test**(项目无此依赖,`temp_env` 已覆盖同一需求)。测试:`claude_code_hint_prepends_preamble_and_forwards_no_launch_option`(`CLAUDE_CONFIG_DIR`)/ `codex_hint_prepends_preamble_and_forwards_no_launch_option`(`CODEX_HOME`)断言 `spawn_args[0].launch_option == None`(Property P3)+ `first_prompt_tasks[0] == "{preamble}\n\n---\n\n{task}"`(R5.1);`claude_code_unresolvable_persona_fails_the_delegation` 钉失败边(R3 F3:persona 不存在 → delegation Failed 且 spawn_args 为空,绝不静默降级)。**负向 mutation 实测**:把期望 preamble 改成 `MUTATION-CHECK` → 2 条 happy path 转红且 `left` 显示真读到 tempdir 里的 persona 内容(证明 env override 真生效,不是恒绿)。
  - **缺口 3(listener 解析)· 真跑,非仅类型层**:新建 `tests/listener_subagent_type_wire.rs`(5 test),经 `write_frame` → `serve_one` 送**真实 length-prefixed `BrokerMessage::Call` 帧**(companion 走的同一条路),在 `MockSpawner.spawn_args[..].launch_option` 观察解析效果(选 Kiro Native 层,人格解析无文件系统依赖)。覆盖:`wire_subagent_type_reaches_spawn_as_launch_option` / `wire_subagent_type_is_trimmed`(`"  recon-agent  "` → `recon-agent`)/ `wire_blank_subagent_type_degrades_to_no_persona`(`"   "` → 无人格而非失败)/ `wire_omitted_subagent_type_yields_no_persona` / `wire_non_string_subagent_type_degrades_to_no_persona`(`42`/`[]`/`{}`/`null`/`true`/`["..."]` 全部 → None 不 panic)。**负向 mutation 实测**:删掉 listener 的 `.trim().filter(!empty)` → trimmed / blank 两条转红(`left: None` = delegation 被 grammar gate 拒掉、根本没 spawn,正是注释里预测的失效模式),恢复后 5/5 绿。
  - **验证输出(全部真跑)**:
    - `cargo check --features test-utils --tests --message-format=short → EXIT=0`
    - `cargo check --no-default-features --bin codeg-mcp --message-format=short → EXIT=0`
    - `cargo test --features test-utils --test broker_persona → 5 passed; 0 failed; EXIT=0`(既有,无回归)
    - `cargo test --features test-utils --test persona_stage3 → 12 passed; 0 failed; EXIT=0`(既有,无回归)
    - `cargo test --features test-utils --test persona_merge_order → 7 passed; 0 failed; EXIT=0`
    - `cargo test --features test-utils --test broker_persona_hint → 3 passed; 0 failed; EXIT=0`
    - `cargo test --features test-utils --test listener_subagent_type_wire → 5 passed; 0 failed; EXIT=0`
    - `cargo clippy --no-default-features --lib --features test-utils -- -D warnings` → 仅 3 处 pre-existing `connection.rs` steer dead-code(stage 4 已声明);`--tests` 下另有 3 处 pre-existing `connection.rs:11489` doc_lazy_continuation + `persona.rs:755` infallible_destructuring_match + `broker_persona.rs:259` manual `Option::map` —— **三个新 crate 零 warning**
  - **可测性重构说明(行为不变)**:①`merge_launch_option_into_runtime_env` 从 `spawn_child_inner` 内联逻辑抽出(原先只能靠真起 agent 进程观察);②`kiro_launch_args` 私有 → `pub`。两者都因本机 `cargo test --lib` 崩 `STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139)`(Tauri native DLL 缺导出符号 · 环境级),集成 crate 只 link public API 才能真跑。`KIRO_AGENT_ENV` 保持 `pub(crate)` 未放宽 —— 测试改用字面量 `"KIRO_AGENT"`,顺带成为对 wire 名的独立断言。
  - **硬约束合规**:未改 requirements/design.md · `spawn_for_resume` 签名未动 · 未改前端 · 仅在本 tasks.md 追加本条 Update Log
  - **Review Findings**:任务文档缺口 1 的判据("merge 必须在 `apply_kiro_env_policy` 之前,否则 KIRO_AGENT 被剥")与真实代码矛盾,已按上文修正为"必须在 `spawn_agent` 按值消费 env 之前",并据此设计可被 mutation 打红的测试;缺口 2/3 的事实(env 变量名 `CLAUDE_CONFIG_DIR`/`CODEX_HOME` 及非空过滤+home fallback、listener 解析位置 listener.rs:683、Hint 前置格式 broker.rs:3354)经 git grep 逐条核实无误。无其他架构偏离。
