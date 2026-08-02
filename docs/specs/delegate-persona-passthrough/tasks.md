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
  - `files: src-tauri/src/acp/delegation/persona.rs (新增) · mod.rs · types.rs · tool_schema.json · broker.rs · listener.rs · lifecycle.rs · commands/delegation.rs (下游 struct-literal 补 None)`
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
    - `files: src-tauri/src/acp/delegation/persona.rs (新增) · src-tauri/src/acp/delegation/mod.rs (挂 pub mod persona;)`
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

- [ ] 2. Provider capability 实现(R2 A2 采纳:broker 不识别 CLI)
  - [ ] 2.1 在 `registry.rs` 或 `AcpAgentMeta` 上加 `impl PersonaCapability for AgentType::Kiro`,`supports_persona() = true`,`resolve_persona_effect(name, _) = PersonaEffect::Native { launch_option: LaunchOption::KiroPersona(name.to_string()) }`(Kiro 不需 home_dir)
    - _Requirements: 2.1, 2.5_
  - [ ] 2.2 `impl PersonaCapability for AgentType::ClaudeCode`,`supports_persona() = true`,`resolve_persona_effect(name, home) = { let p = home.join(".claude/agents"); persona::resolve_preamble_at(name, &p).map_or_else(err_to_failed, |body| PersonaEffect::Hint{preamble: body}) }`
    - _Requirements: 3.1, 3.2, 3.3_
  - [ ] 2.3 `impl PersonaCapability for AgentType::Codex`,同 2.2 但路径 `.codex/agents`
    - _Requirements: 3.1, 3.2, 3.3_
  - [ ] 2.4 default impl / other AgentType variant → `supports_persona() = false`,`resolve_persona_effect(_, _) = PersonaEffect::Ignored`(default trait 方法或 catch-all)
    - _Requirements: 4.1, 4.2_
  - [ ]* 2.5 Provider unit tests:每家 provider 用 tmp home_dir + fixture persona 文件断言返回 Native/Hint/Ignored/Failed 各分支
    - _Requirements: 2.1, 3.2, 4.1_

### 阶段 3 · persona.rs 安全实现 + 全量 unit test

- [ ] 3. persona.rs `resolve_preamble` 硬约束
  - [ ] 3.1 实现 `pub fn resolve_preamble_at(name: &str, root: &Path) -> Result<String, PersonaError>`:
    - 名称语法 gate:`if !is_valid_persona_name(name) return InvalidName`
    - Canonical containment(R2 F4 · R3 P2.4):`canonical_root = canonicalize(root)?; canonical = canonicalize(candidate)?; if canonical.parent() != Some(canonical_root.as_path()) return PathEscape`(direct-child 判定,非 starts_with)
    - TOCTOU-safe open(R2 F4):`File::open(&canonical)` 而非 candidate
    - 硬读取上限(R2 F4):`BufReader::new(file).take(200*1024 + 1).read_to_end(...); if bytes.len() > 200*1024 return TooLarge`
    - UTF-8 + BOM strip
    - Frontmatter parse(R2 F2):不以 `---` 起 → 全 body;以 `---\n`/`---\r\n` 起且找到闭合 `---` → 剥;找不到闭合 → **`MalformedFrontmatter`**(不宽容降级)
    - Empty body 检:剥完 body 全空 → `EmptyBody`
    - _Requirements: 3.1, 3.2, 3.3, 8.1_
  - [ ] 3.2 `resolve_preamble_at` 用 `std::env::var("HOME").or_else("USERPROFILE")` 构 home 只在 impl 2.2/2.3 内部调用(R3 F1 只 Hint provider 才解 HOME,unsupported/Kiro 不碰)
    - _Requirements: 4.1, 8.1, R3-F1_
  - [ ]* 3.3 persona.rs unit tests(全量硬约束覆盖):
    - **Property 6**(name grammar):`.`、`/`、`\`、空、65 字符、UTF-8 多字节全 reject · `_Validates: Requirements 3-name-grammar.1-3_`
    - **Symlink escape**:mock symlink 指向 `<root>/../secret.md` → `PathEscape`
    - **Direct-child(非 starts_with)**:`<root>/subdir/foo.md` → `PathEscape`(**关键 · 用 `canonical.parent()==Some(root)`**)
    - **BufReader::take 硬上限**:200 KiB - 1 = Ok,200 KiB + 1 = `TooLarge`(**非 metadata 预判**)
    - **Frontmatter 六态**:无 fm / LF-fm-完好 / CRLF-fm-完好 / BOM-fm / **LF-fm-未闭合 → MalformedFrontmatter(硬失败)** / **frontmatter-only → EmptyBody**
    - `_Requirements: 3.3, 3-name-grammar.1-3, 8.1_`
    - `_Properties: P6_`

### 阶段 4 · broker 翻译层 + 单测

- [ ] 4. broker 翻译层重构(R2 A2 + R3 F1 + R3 A2 + R3 F2 采纳后的最终版)
  - [ ] 4.1 修改 `broker.rs start_delegation`,骨架顺序**必须**:
    1. `if req.subagent_type == None` → 直接 Ignored,跳过所有校验
    2. 有 name → 先查 `provider_for(agent_type).supports_persona()`
    3. 只有 supports → 才 `is_valid_persona_name(name)` 校语法(不合法 → `DelegationOutcome::from_err(InvalidPersona)`)
    4. 只有 supports → 才 `provider.resolve_persona_effect(name, &lazy_home())`
    5. **unsupported CLI → 直接 PersonaEffect::Ignored,不碰名称校/不解 HOME**(R3 F1 关键 · Kiro 走 supports=true 但 resolve 内部不需 home)
    - _Requirements: 3.5, 4.1, 4.2, R3-F1_
  - [ ] 4.2 broker 把 `PersonaEffect` 翻译成 `(launch_option, prepended_task, unsupported_note)` 三元组,**注意时机(R3 A2)**:此时不生成 `applied_persona`。**PersonaEffect::Failed → `DelegationOutcome::from_err(InvalidPersona)` 直返 · 不挂 applied**(R3 F2)
    - _Requirements: 5.1, R3-A2, R3-F2_
  - [ ] 4.3 broker 调 `spawner.spawn(..., launch_option).await?`,**spawn 返 Ok 后**才产 `applied_persona`:
    - `PersonaEffect::Native` → `AppliedPersona::Native { name }`
    - `PersonaEffect::Ignored` + `subagent_type == Some(_)` → `AppliedPersona::IgnoredUnsupportedCli { name }`
    - 其它 → `None`
    - _Requirements: 5.1, 5.3, R3-A2_
  - [ ] 4.4 broker 调 `send_prompt_linked_for_delegation(...)` 后:如果 effect 是 `Hint` **且** send 返 Ok → applied 拼上 `AppliedPersona::Hint { name }`(**在 send Ok 后才产**,R3 A2)
    - _Requirements: 3.2, 5.1, R3-A2_
  - [ ] 4.5 unsupported_note 挂到 `DelegationSuccess.text` 尾部拼接
    - _Requirements: 4.2, 4.3_
  - [ ] 4.6 tracing::info!(target="delegation::persona") 记录每一次 Ignored/Native/Hint 事件
    - _Requirements: 4.3_
  - [ ]* 4.7 broker unit tests(用 MockSpawner):
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

### 阶段 5 · ConnectionSpawner trait 扩 + spawn_child_inner merge

- [ ] 5. Spawner trait 与 production impl
  - [ ] 5.1 `spawner.rs:85-138 ConnectionSpawner::spawn` 签名追加 `launch_option: Option<LaunchOption>` 参数(**`spawn_for_resume` 签名不改** · R2 A5 / R3 A1)
    - _Requirements: 7.4, R2-A5, R3-A1_
  - [ ] 5.2 `manager.rs:2960-3010 ConnectionManagerSpawner::spawn_child_inner` 在 `build_session_runtime_env` 后、`manager.spawn_agent` 前:`if let Some(LaunchOption::KiroPersona(name)) = launch_option { runtime_env.insert("KIRO_AGENT".into(), name); }`。**merge 顺序 invariant** 加内联注释:「merge 必须在 `spawn_agent_connection`(内部调 `apply_kiro_env_policy`)之前,否则 KIRO_AGENT 被剥」
    - _Requirements: 2.1, 2.2_
  - [ ] 5.3 MockSpawner + broker 内 `GatedFollowupSpawner` 同步扩签名,`SpawnCallArgs` 加 `launch_option` 字段记录
    - _Requirements: 7.2_
  - [ ]* 5.4 connection.rs 单元测试(既有 `kiro_launch_args` 组合矩阵)追加一条:`runtime_env["KIRO_AGENT"]="persona-abc"` → args 含 `--agent persona-abc`
    - _Requirements: 2.5_
  - [ ]* 5.5 spawn_child_inner 单测:panel `env_json[KIRO_AGENT]="A"` + `launch_option=KiroPersona("B")` → post-merge `runtime_env["KIRO_AGENT"] == "B"`(per-call 覆盖 panel · Property 2 端到端证据)
    - `_Validates: 2.1, 2.3_`
    - `_Properties: P2_`

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
