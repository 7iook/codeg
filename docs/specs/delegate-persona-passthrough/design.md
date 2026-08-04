---
# ═══ CORE IDENTITY(必填 · 3 段)═══
slug: delegate-persona-passthrough
title: delegate_to_agent 支持透传自定义 subagent 人格(Kiro / Claude / Codex) · 设计
# ═══ LIFECYCLE(spec-cross-review 只回写 last_review_* / review_rounds_done / last_updated)═══
status: drafting
review_rounds_done: 3
last_review_status: NEEDS_CHANGES
last_review_p0: 1
created: 2026-08-03
last_updated: 2026-08-02
shipped_commit: null
# ═══ RELATIONSHIPS ═══
related_adrs: []
related_specs: [delegation-continue-session, kiro-agent-integration]
supersedes: null
superseded_by: null
rca: null
# ═══ DISCOVERY ═══
tags: [delegation, subagent, persona, acp, kiro, claude-code, codex, broker]
domain: agent-runtime
one_line: 给 delegate_to_agent 加可选 subagent_type,让主 AI 派任务时能点名 Kiro/Claude/Codex 里的自定义人格;Kiro 走 --agent 原生真人格,Claude/Codex 走首轮 preamble best-effort 变通。
---

# Design · delegate_to_agent 人格透传

## Overview

三家 CLI 的支持面天然不对称,一份 design 要同时讲清 Kiro 的**原生真人格通道**、Claude/Codex 的**preamble best-effort 变通**、以及未知 CLI 的**静默忽略**。核心权衡摆在前面:

**Kiro 是唯一原生支持 per-launch 人格的 CLI**(`kiro-cli acp --agent <name>`,`kiro_launch_args` 已就位),整个下游链路免费。Claude Code / Codex 的 wrapper(`claude-agent-acp` / `codex-acp`)都是 stdio ACP server,**不透传** `claude --agent` / `codex` 的 CLI 层参数,codeg 侧短期唯一路径是**读人格文件 body 拼到首轮 prompt 前**——**这不是「真人格」,wire 契约层需将其命名为 `best-effort` 并与 Kiro 的真人格区开**,避免主 AI 与用户误读成等价。权限模式 / 工具白名单 / 模型 / hook 等 frontmatter 高阶字段全丢,只有 markdown body 的文字提示能生效。本方案不声称补齐,上游 wrapper 合入 `CLAUDE_ACP_AGENT` / `CODEX_AGENT` env 后可升级(见 Decision Record)。

**per-call launch 选项**被提升为一等参数(扩 `ConnectionSpawner::spawn` trait 签名),但**不沿用「任意 `BTreeMap<String,String>` env 覆盖」那种获取无限基础设施控制面的 D 类泛化**,而是类型化为一个小枚举 `LaunchOption`,v1 只有一个变体 `KiroPersona(String)`。将来又一个 CLI 需要 launch-arg 翻译时加一个新变体即可(如 `ClaudePersonaEnv(String)` 待上游合入后启用)。这样主要主体仍是类型,命名与意图能被静态审计,不会被滥用成一个 env 池。

## Current-State Inventory (from recon — MANDATORY)

> 侦察报告基线:`feat/kiro-agent` @ 本会话起点,codegraph/fast-context 实测。完整锚点见 `.agent-workspace/.archive/2026-08-03/delegate-persona-passthrough/recon-a97db1c2f0f970176.md`。行号按符号名定位,后续 rebase 会漂移。

### ✅ 存在且可直接复用

| 能力 | 位置 | 复用方式 |
|---|---|---|
| MCP schema 定义 | `src-tauri/src/acp/delegation/tool_schema.json` `delegate_to_agent.inputSchema` | 追加 `subagent_type` optional string 字段 |
| companion 参数透传 | `src-tauri/src/acp/delegation/companion.rs:499-505` | `arguments: Value` 整个 JSON 透传给 `BrokerRequest.input`;新字段自动带过去,无需改 |
| BrokerRequest 载荷类型 | `src-tauri/src/acp/delegation/transport.rs:63-86` `input: serde_json::Value` | 无需改 |
| listener 解析 | `src-tauri/src/acp/delegation/listener.rs:604-633` `process(BrokerRequest)` | 追加 `subagent_type` 解析(trim + 空串过滤),塞入 `DelegationRequest` |
| runtime_env 构造 | `src-tauri/src/commands/acp.rs:8239-8281` `build_session_runtime_env` | 无需改,输出的 BTreeMap 供 per-call override merge |
| Kiro launch args 翻译 | `src-tauri/src/acp/connection.rs:213 kiro_launch_args` | 无需改,已消费 `runtime_env["KIRO_AGENT"]` → `--agent <val>` |
| Kiro launch args 装配点 | `src-tauri/src/acp/connection.rs:1237` `cmd_args.extend(kiro_launch_args(runtime_env))` | 无需改 |
| Kiro 人格存在性校验 | `src-tauri/src/acp/connection.rs:1234` `verify_kiro_selected_agent_exists` | 无需改,天然在 merge 之后跑 |
| Kiro env policy | `src-tauri/src/acp/connection.rs:~281 apply_kiro_env_policy` | 无需改,merge 完再剥 codeg 私有 key |
| DelegationRequest 结构 | `src-tauri/src/acp/delegation/types.rs:53-75` | 追加 `subagent_type: Option<String>` 字段 |
| ConnectionSpawner trait | `src-tauri/src/acp/delegation/spawner.rs:85-138` | 扩 `spawn` 签名加 `launch_option: Option<LaunchOption>`(`spawn_for_resume` 签名不变) |
| Production spawner | `src-tauri/src/acp/manager.rs:2960-3010 ConnectionManagerSpawner::spawn_child_inner` | 在 `build_session_runtime_env` 后 merge per-call launch option,再调 `manager.spawn_agent` |
| MockSpawner 测试脚手架 | `src-tauri/src/acp/delegation/spawner.rs:315+ mod mock` | 扩 `SpawnCallArgs` 记录 launch_option,broker 测试沿用范式断言 |
| Delegation card parseInput | `src/lib/delegation-card.ts:199-241 parseInput` | 追加从 `raw_input` 抽 `subagent_type`,返回给渲染层 |
| Agent label 显示层 | `src/lib/custom-agents.ts getAgentLabel` | 无需改,复用 |

### ❌ 不存在(须新建)

| 项 | 建议位置 | 说明 |
|---|---|---|
| `subagent_type` MCP schema 字段 | `tool_schema.json` `delegate_to_agent.inputSchema.properties` | optional string · description 明写 supported CLIs + best-effort 声明 |
| `subagent_type` in DelegationRequest | `types.rs:53-75` | `#[serde(default, skip_serializing_if = "Option::is_none")] pub subagent_type: Option<String>` |
| `LaunchOption` 枚举 + `is_valid_persona_name` fn | 新建 `src-tauri/src/acp/delegation/persona.rs` 或复用 `types.rs` | 类型化 launch 选项,v1 只有 `KiroPersona(String)`;name grammar 校验函数三家共用 |
| Persona resolver 模块 | 新建 `src-tauri/src/acp/delegation/persona.rs` | `resolve_preamble(agent_type, name, home_dir) -> Result<String, PersonaError>` · 读 Claude/Codex 人格文件 · frontmatter 剥 · symlink escape 检 · 200 KiB 上限 |
| broker 翻译层 | `broker.rs start_delegation` 里 `spawner.spawn(...)` 之前 | (agent_type, subagent_type) → `(launch_option, prepended_task, unsupported_note)` |
| Non-support note 挂到 outcome | `broker.rs` DelegationSuccess 构造点 | 静默忽略 CLI 时 append `[note] subagent_type='<name>' ignored for <agent>` 到 text |
| `DelegationError::InvalidPersona` wire code | `types.rs DelegationError` | 与既有 `SpawnFailed / InvalidWorkingDir` 同级;wire code `invalid_persona` |
| Frontend label 渲染 | `src/lib/delegation-card.ts` render 段 或 `delegation-card.tsx` | display `<Agent Label> · @<subagent_type>`;Claude/Codex 附 `(best-effort)` |

### 关键锚点速查(供 executor 引用)

| 主题 | 文件:行 | 复用度 |
|------|---------|--------|
| Kiro --agent 翻译 | `connection.rs:213 kiro_launch_args` | ✅ 已就位 |
| Kiro launch 装配 | `connection.rs:1237` | ✅ 已就位 |
| Kiro 人格校验 | `connection.rs:1234 verify_kiro_selected_agent_exists` | ✅ 已就位 |
| Kiro 私有 env 剥离 | `connection.rs:~281 apply_kiro_env_policy` | ✅ 已就位 |
| tool schema | `tool_schema.json` | ❌ 加字段 |
| DelegationRequest | `types.rs:53-75` | ❌ 加字段 |
| listener 解析 | `listener.rs:604-633` | ❌ 加一行解析 |
| ConnectionSpawner::spawn | `spawner.rs:85-138` | ❌ 扩签名 |
| spawn_child_inner | `manager.rs:2960-3010` | ❌ 加 merge |
| MockSpawner | `spawner.rs:~315` | ❌ 扩记录 |
| Claude registry | `registry.rs:~234 AgentType::ClaudeCode` | ✅ 定位用 |
| Codex registry | `registry.rs:~264 AgentType::Codex` | ✅ 定位用 |
| Persona resolver | 新建 `persona.rs` | ❌ 新模块 |

## Corrected Goal (draft-vs-reality — from recon)

| 初始假设 | 代码现实 | 修正 |
|---|---|---|
| Claude Code 有 `claude --agent` 原生 CLI 参数,codeg 应能直接透传 | codeg 走 `claude-agent-acp@0.63.0` npx wrapper,该 wrapper 用 `@anthropic-ai/claude-agent-sdk` `query({options})` API,**不 shell out 到 `claude` 二进制**,CLI 层参数完全屏蔽 | Claude Code 侧短期只能走 preamble prepend;wire 契约明写 best-effort;真人格通道等上游 wrapper 加 env |
| Codex 有 `~/.codex/agents/` 目录 → codex-acp 应支持选人格 env | codex-acp 只支持 `CODEX_API_KEY / CODEX_CONFIG / INITIAL_AGENT_MODE / ...` 一批 env,**无 subagent 相关键**;`INITIAL_AGENT_MODE` 是「权限沙箱等级」,不是人格 | Codex 侧同 Claude 走 preamble;`CODEX_CONFIG` 理论可注 codex-agent 自身 default-agent,但 codex config schema 目前无此字段 |
| broker 现有 `AgentDelegationDefaults { mode_id, config_values }` 可承载 per-call 覆盖 | `preferred_mode_id` 走 ACP `session/set_mode` API,`preferred_config_values` 走 `session/set_config_option`——**都不是进程 launch 通道**,承载不了 `--agent` CLI 标 | 必须新开 launch 选项作为一等 spawn 参数,扩 `ConnectionSpawner::spawn` trait 签名 |
| 用任意 `BTreeMap<String,String> per_call_env_overrides` 做参数即可通用化 | 那把「延伸未来 CLI 需求」当成了当前业务,typeless 泄漏基础设施控制面,后续被滥用风险高(R1 A4) | 改为类型化 `enum LaunchOption` + `Option<LaunchOption>` 参数,v1 只有 `KiroPersona(String)` 一个变体 |
| 「subagent-transcript」capability 就是选人格 | `registry.rs:237` 注释明说:该 capability 是「透出子会话文本」——ACP 侧用来显示 Claude 内部 spawn 的子人格 transcript,**不是 codeg 侧反向指定人格**。语义完全不同,别复用 | Preamble 变通与该 capability 正交,不冲突,不复用 |
| Kiro 人格失败会静默用 panel 默认 | `verify_kiro_selected_agent_exists` 在 launch args 装配前跑,若 runtime_env 里的 `KIRO_AGENT` 指向不存在的文件,直接 fail spawn | 保留该行为——per-call 覆盖后校验会看到新名字,人格不存在会硬 fail,主 AI 拿到 `spawn_failed` 能重试,不会静默 |
| Requirement 7.3 要求 resume 重放 `subagent_type`,但 design 又不入 DB → 内部矛盾(R1 A3) | 事实:Kiro 靠 kiro-cli session 元数据自己 resume;Claude/Codex preamble 落在 conversation 表首轮 message 里,wrapper 自然 replay | 删 R7.3 契约冲突,`spawn_for_resume` 签名不接 `LaunchOption`,SSOT 写清 |
| 服务器模式需要多租户 persona 隔离(R1 A2) | codeg-server 本身是单主体信任模型(CLAUDE.md:`CODEG_TOKEN` + 单 data dir);persona 文件应从**当前进程 `$HOME`** 读,与 codeg-server 已有信任面对齐 | R8 明写单主体信任边界,不承诺多租户 |

## Decision Record

- **Chosen approach**: 单条通道扩展 + 三家分派路径。schema/types/listener/spawner/broker/manager 六处改动是**不可拆的串行原子块**(trait 签名一变全下游依赖同步);broker 里的翻译层按 `agent_type` 分派——Kiro 走 `LaunchOption::KiroPersona`(下游 `kiro_launch_args` 已消费,真人格),Claude/Codex 走首轮 preamble prepend(新建 `persona.rs` 模块,best-effort 而非真人格),其它 CLI 静默忽略挂 note。**Alternatives rejected**:(A) 只做 Kiro,Claude/Codex 挂等待中——用户 2026-08-03 原话「主要需要支持的是 claude kiro codex」明确要三家都做,不接受留白;(B) 立刻改上游 wrapper 加 env——周期不可控,阻塞本次交付,作为独立追加任务并行推进,不阻塞本 spec 落地;(C) 用 typeless `BTreeMap<String,String>` 做 per-call env override——R1 A4 已否,泄漏基础设施控制面,改为类型化 `LaunchOption` 枚举。
- **Reviewer**: codex(用户未指定,采用 spec-cross-review 默认)。
- **ADR needed?** No。理由:本改动是 delegation 通路上加一个可选字段与一段翻译层,不定义新的架构层、不改变既有 SSOT 边界、不引入新的跨服务契约。属于 impl 细节演进。**LaunchOption 类型化决策虽是「加类型」层面的判断,但仅在 delegation 内部展开,不产生跨模块的架构约束,依然不构成 ADR 触发条件**。
- **Upstream PR follow-up(非本 spec 范围但登记)**: 向 `@agentclientprotocol/claude-agent-acp` 与 `@agentclientprotocol/codex-acp` 提 PR 加 `CLAUDE_ACP_AGENT` / `CODEX_AGENT` env,合入后 codeg 侧从「preamble 变通」升级到「真人格」只需 `LaunchOption` 加一个变体 + broker 翻译层加一条分支,是最小改动。

## Architecture & Layering

单向依赖(从主 AI 到子进程 argv):

```
主 AI (LLM)
    │ MCP tools/call { agent_type, task, subagent_type? }
    ▼
codeg-mcp 伴生进程 (companion.rs)
    │ BrokerRequest.input: Value  ← 全 JSON 透传,无需感知新字段
    ▼
DelegationBroker (listener.rs → process → DelegationRequest)
    │ ① Requirement 3-name-grammar 预校验(broker)
    │
    ├─ agent_type == Kiro
    │     │ launch_option = Some(LaunchOption::KiroPersona(name))
    │     ▼
    │  ConnectionSpawner::spawn(..., launch_option)
    │     │
    │     ▼
    │  spawn_child_inner (manager.rs)
    │     │ runtime_env = build_session_runtime_env(db, ...)
    │     │ 按 launch_option 变体注入:runtime_env.insert("KIRO_AGENT", name)  ← 覆盖 DB 层
    │     ▼
    │  manager.spawn_agent(runtime_env)
    │     │
    │     ▼
    │  connection.rs kiro_launch_args → child argv: kiro-cli acp --agent <name>
    │
    ├─ agent_type ∈ {ClaudeCode, Codex}
    │     │ preamble = persona::resolve_preamble(agent_type, name, current_process_home_dir())?
    │     │ task = preamble + "\n\n---\n\n" + task
    │     ▼
    │  ConnectionSpawner::spawn(..., launch_option=None)
    │     │
    │     ▼
    │  ConnectionSpawner::send_prompt_linked_for_delegation(conn_id, task, link)
    │     │
    │     ▼
    │  子会话首轮 prompt 前段 = 人格 markdown body(best-effort)
    │  → 首轮 message 已在 conversation 表落库
    │  → session/resume 时 wrapper 自然 replay 该首轮,preamble 无需 codeg 重放
    │
    └─ other agent_type
          │ tracing::info + note attached to DelegationSuccess.text
          │ launch_option=None, no preamble
          ▼
          正常 spawn 路径,无 subagent 语义
```

**关键 anti-corruption**:persona 文件读取只在 broker 层发生,不下沉到 spawner 或 manager;spawner trait 只知道「`launch_option` + 已 prepend 的 task」,不知道 persona 文件从哪来。这保证 mock spawner 和其它非 production impl 不需要文件系统访问权。

**层级归属**:
- `types.rs` / `tool_schema.json` — wire contract 层(codeg-mcp ↔ broker)
- `listener.rs` — 请求解析层
- `broker.rs` — 语义翻译层(agent_type 分派 + persona 解析 + name grammar 预校验)
- `persona.rs`(新)— 文件 IO 层,与 delegation 语义解耦;同时承载 `LaunchOption` 类型与 `is_valid_persona_name` 函数
- `spawner.rs` trait — spawn 抽象边界(扩 `spawn` 签名,`spawn_for_resume` 不变)
- `manager.rs` `spawn_child_inner` — production 实现
- `connection.rs` `kiro_launch_args` — 单 CLI 家的 launch-arg 翻译,已就位,不改

## Components & Interfaces

### 1. Tool schema field(wire contract · listener 解析)

```json
"subagent_type": {
  "type": "string",
  "description": "Optional persona/sub-agent name inside the target CLI. Naming grammar: 1-64 chars matching [A-Za-z0-9_-]. Supported CLIs (differ by semantic strength): `kiro` — REAL persona: translated to `kiro-cli acp --agent <name>`, kiro-cli loads full definition from <KIRO_HOME>/agents/<name>.json (permissions, tools, prompt all take effect). `claude_code` / `codex` — BEST-EFFORT ONLY: reads `~/.claude/agents/<name>.md` or `~/.codex/agents/<name>.md`, prepends its markdown BODY (frontmatter is stripped) as a text hint to the first turn. Frontmatter high-order fields (permission mode, tool allowlist, model, hook) DO NOT take effect on this leg. Ignored — with a `[note]` in tool_result — for any other agent_type. Not to be confused with `agent_type` — that picks the CLI, this picks the persona INSIDE it."
}
```

### 2. `DelegationRequest.subagent_type: Option<String>`

追加到 `types.rs:53-75`,`#[serde(default, skip_serializing_if = "Option::is_none")]` 保 wire 兼容。

### 3. `LaunchOption` 枚举 + `is_valid_persona_name` 校验

放在 `delegation/persona.rs`(新模块)或 `types.rs`,由 executor 定,以 SSOT 与访问面为准:

```rust
/// Type-safe per-call CLI launch option. v1 only carries the Kiro persona nomination;
/// future CLIs get a NEW enum variant (e.g. ClaudePersonaEnv(String) once upstream
/// wrapper support lands). NEVER extend by adding an opaque BTreeMap<String,String>
/// override — that widens infra control surface without business need (R1 A4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchOption {
    /// Injects KIRO_AGENT=<name> into runtime_env before it reaches
    /// manager.spawn_agent. Consumed downstream by kiro_launch_args
    /// (already existing) which translates it to `--agent <name>` argv.
    KiroPersona(String),
    // Future: ClaudePersonaEnv(String) — pending upstream claude-agent-acp PR
    // Future: CodexPersonaEnv(String)  — pending upstream codex-acp PR
}

/// Persona name grammar shared across all three CLIs (Requirement 3-name-grammar).
/// Enforced at broker layer BEFORE any filesystem access.
pub fn is_valid_persona_name(name: &str) -> bool {
    let len = name.chars().count();
    (1..=64).contains(&len)
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}
```

### 4. `ConnectionSpawner::spawn` 签名扩展(仅 spawn · resume 不改 · Requirement 7.4)

```rust
async fn spawn(
    &self,
    parent_connection_id: &str,
    agent_type: AgentType,
    working_dir: Option<String>,
    preferred_mode_id: Option<String>,
    preferred_config_values: BTreeMap<String, String>,
    launch_option: Option<LaunchOption>,   // ← 新增 · 类型化 · 默认 None
) -> Result<String, SpawnerError>;

// spawn_for_resume 签名不变 — resume 不重新提名人格(Requirement 7.4)
async fn spawn_for_resume(
    &self,
    parent_connection_id: &str,
    agent_type: AgentType,
    working_dir: Option<String>,
    session_id: Option<String>,
    preferred_mode_id: Option<String>,
    preferred_config_values: BTreeMap<String, String>,
) -> Result<String, SpawnerError>;
```

**Preconditions**: `LaunchOption::KiroPersona(name)` 只在 `agent_type == Kiro` 下传(broker 侧保证);`name` 已过 Requirement 3-name-grammar 校验(1-64 字符 `[A-Za-z0-9_-]`)。

**Postconditions**: production impl `spawn_child_inner` 将 `Some(LaunchOption::KiroPersona(name))` 翻译为 `runtime_env.insert("KIRO_AGENT", name)`,在 `build_session_runtime_env` 后、`manager.spawn_agent` 前 merge。merge 顺序必须在 `apply_kiro_env_policy`(在 `spawn_agent_connection` 内部)之前,否则 policy 会剥 `KIRO_*` 私有键。

**Loop invariants**: N/A(one-shot)。

**Errors**: SpawnerError::Spawn 承载 upstream 错误;broker 侧不从这里翻译 persona 错误(persona 错误在进 `spawn` 前就由 broker 翻译层直接抛 `DelegationError::InvalidPersona`)。

### 5. Persona resolver 新模块 `delegation/persona.rs`(R2 F4 / F2 采纳后的安全与确定性)

```rust
pub enum PersonaError {
    InvalidName(String),               // 名称未过语法(Requirement 3-name-grammar)
    NotFound(String),                  // 文件不存在
    NotUtf8(String),                   // 文件非 UTF-8
    TooLarge { name: String, cap: usize },  // 读取途中命中硬上限(BufReader::take)
    EmptyBody(String),                 // frontmatter 剥后 body 为空
    MalformedFrontmatter(String),      // frontmatter 未闭合 / 格式错 — R2 F2 硬失败
    PathEscape(String),                // canonical 化后 path 非 expected_root 直属子
    IoError(String),
}

/// Resolves persona file for ClaudeCode / Codex.
/// - agent_type 必须 ∈ {ClaudeCode, Codex};Kiro 不走本链路。
/// - name 已过 Requirement 3-name-grammar 校验(broker 层预校,重复防御在此)。
/// - home_dir 从 本进程 $HOME (POSIX) 或 %USERPROFILE% (Windows) 解析(Requirement 8.1)。
pub fn resolve_preamble(
    agent_type: AgentType,
    name: &str,
    home_dir: &Path,
) -> Result<String, PersonaError>;
```

**实现要点(R2 F4 / F2 采纳后的安全与确定性修正)**:

1. **路径定位**:`expected_root = home_dir / (".claude" | ".codex") / "agents"`;`candidate = expected_root / format!("{name}.md")`。
2. **Direct-child 安全判定(R2 F4)** — `let canonical_root = std::fs::canonicalize(&expected_root)?; let canonical = std::fs::canonicalize(&candidate)?; if canonical.parent() != Some(canonical_root.as_path()) { return Err(PathEscape(...)); }`。**用 `canonical.parent() == Some(canonical_root)` 而不是 `starts_with`** —— `starts_with` 只能证明在根下,不能证明直属子(子目录里的文件也会通过)。expected_root 自己也 canonicalize,避免根目录本身是 symlink 时相等判断失败。
3. **TOCTOU-safe 文件打开(R2 F4)** — `let file = std::fs::File::open(&canonical)?;` **打开 canonical path 本身,不重新 open candidate**。canonicalize 与 open 之间 symlink 被换掉 → open canonical 仍能命中原实体。
4. **硬读取上限(R2 F4)** — `let mut reader = std::io::BufReader::new(file).take(200 * 1024 + 1); let mut bytes = Vec::new(); reader.read_to_end(&mut bytes)?; if bytes.len() > 200 * 1024 { return Err(TooLarge{...}); }`。**不用 `metadata().len()` 预判**(metadata 可能与实际内容不同步,尤其是 sparse file 或 special file)。BufReader::take 硬封顶。
5. **UTF-8** — `let text = String::from_utf8(bytes).map_err(|e| NotUtf8(e.to_string()))?;`(包含 BOM 处理:若 `text.starts_with('\u{FEFF}')` 先 strip)。
6. **Frontmatter 剥离(R2 F2 硬失败采纳)**:
   - 不以 `---` 起 → 无 frontmatter 分支,整个 text 作为 body(宽容 Windows 手写人格)。
   - 以 `---\n` 或 `---\r\n` 起 → **必须**寻下一个孤行 `---`(LF 或 CRLF)作为结束。未找到结束 → **`Err(MalformedFrontmatter(...))`**,**不宽容降级**(R2 F2 防 YAML 元数据注入 prompt)。
   - 找到结束后,body = text 去除 frontmatter 区间。body 全空(只有 frontmatter) → `Err(EmptyBody(...))`。
   - 单测循环入参:无 frontmatter / BOM-无-fm / LF-fm-完好 / CRLF-fm-完好 / BOM-fm / LF-fm-未闭合(⚠ 硬失败) / 空 body(⚠ 硬失败) / frontmatter-only(⚠ 硬失败)。
7. **不引入 markdown parser 库** — 只看 fence,不解析 body 内 markdown。不引入 `serde_yaml`(只需 fence 匹配,不需 YAML 解析——frontmatter 内容本身已被剥去,不下发)。手写 state machine 即可,自包含无外部依赖。
8. **home_dir 解析**(R3 recon 修正)— **必须复用项目 canonical config-root helper**:Claude 用 `crate::parsers::claude::resolve_claude_config_dir()`(读 `CLAUDE_CONFIG_DIR` env);Codex 用 `crate::parsers::codex::resolve_codex_home_dir()`(读 `CODEX_HOME` env);二者内部均 fallback `dirs::home_dir()`。broker 层 canonicalize 一次得 `expected_root: &Path` 传下,persona.rs 保持文件 IO 层职责纯净。**禁写死 `dirs::home_dir()/.claude/agents`——export 了 env 的用户会读错**。

### 6. broker 翻译层(R2 A2 采纳:broker 只编排,CLI-specific 解析下沉到 provider)

在 `broker.rs start_delegation` 里,取完 `agent_defaults`(mode_id + config_values)之后、调 `spawn.spawn(...)` 之前:

**分层后的职责**:
- broker 只知道三件事:名称语法预校 / 调 `provider.resolve_persona_effect()` / 拼接结果 `(launch_option, prepended_task, applied_persona)` 传下去。不识别具体 CLI、不定位 home、不读文件。
- provider(挂在 `AcpAgentMeta` 上的方法或 `registry.rs` 里按 `AgentType` 分派)返回标准化结果 `PersonaEffect`:

```rust
/// Provider-standardized outcome for a persona nomination on a specific CLI.
/// broker consumes this uniformly; each CLI's provider decides how to produce it.
pub enum PersonaEffect {
    /// Real persona: launch_option carried to spawn, no preamble prepend.
    Native { launch_option: LaunchOption },
    /// Best-effort hint: preamble prepended to first turn, no launch_option.
    Hint { preamble: String },
    /// This CLI does not support per-launch personas; broker attaches [note].
    Ignored,
    /// Persona resolution failed (file / grammar / IO); broker fails the delegation.
    Failed { wire_code: &'static str, reason: String },
}

/// Provider capability. Default impl returns Ignored so any AgentType without an
/// explicit override silently degrades.
pub trait PersonaCapability {
    fn resolve_persona_effect(&self, name: &str, home_dir: &Path) -> PersonaEffect;
}

// impl PersonaCapability for AgentType::Kiro       -> Native{KiroPersona(name)}
// impl PersonaCapability for AgentType::ClaudeCode -> reads ~/.claude/agents/, Hint{preamble} or Failed{...}
// impl PersonaCapability for AgentType::Codex      -> reads ~/.codex/agents/,  Hint{preamble} or Failed{...}
// default (other AgentType variants)                -> Ignored
```

**broker 代码骨架(R3 F1 / A2 修正)**:

**顺序修正(R3 F1)**:先 provider capability check → 支持的 CLI 才名称校验 → 只有 Hint provider 才解 HOME/读文件。unsupported CLI 与 Kiro 都不走文件系统。
**时机修正(R3 A2)**:`applied_persona::Native` 在 `spawner.spawn` 返回 Ok 后才产;`applied_persona::Hint` 在 `send_prompt_linked_for_delegation` 返回 Ok 后才产。spawn/send 失败 → 走既有 Err 通路,不挂 applied。**Failed 变体已删除(R3 F2)**,失败信息完全依赖既有 `DelegationOutcome::Err.wire_code`。

```rust
// 1. 先判 provider capability (R3 F1) — unsupported / Kiro 不读文件不解 HOME
let effect = match req.subagent_type.as_deref() {
    None => PersonaEffect::Ignored,
    Some(name) => {
        let provider = provider_for(req.agent_type);
        // 2. 名称语法校 (Requirement 3-name-grammar) — 只对支持的 CLI 执行
        if provider.supports_persona() && !persona::is_valid_persona_name(name) {
            // 名称不合法 → 走 Err 通路(R3 F2 不挂 applied::Failed)
            return DelegationOutcome::from_err(
                DelegationError::InvalidPersona(format!(
                    "persona name '{}' violates grammar", name)),
                None);
        }
        // 3. 已支持+已校名 → 才调 provider (只有 Hint provider 内部解 HOME)
        if provider.supports_persona() {
            provider.resolve_persona_effect(name, &lazy_home())
        } else {
            // unsupported CLI → 直接 Ignored,不碰名称校/不解 HOME
            PersonaEffect::Ignored
        }
    }
};

// 4. 把 effect 翻译为 spawner 入参 (applied_persona 暂不产 · R3 A2)
let (launch_option, prepended_task, unsupported_note) = match (&effect, req.subagent_type.as_deref()) {
    (PersonaEffect::Native { launch_option }, Some(_)) => {
        (Some(launch_option.clone()), req.task.clone(), None)
    }
    (PersonaEffect::Hint { preamble }, Some(_)) => {
        (None, format!("{preamble}\n\n---\n\n{}", req.task), None)
    }
    (PersonaEffect::Ignored, Some(name)) => {
        tracing::info!(target = "delegation::persona",
            "subagent_type='{}' ignored for {:?}", name, req.agent_type);
        (None, req.task.clone(),
         Some(format!("[note] subagent_type='{}' ignored for {:?} (persona not supported)",
                      name, req.agent_type)))
    }
    (PersonaEffect::Failed { wire_code: _, reason }, _) => {
        // 失败直走 Err 通路,不挂 applied (R3 F2)
        return DelegationOutcome::from_err(
            DelegationError::InvalidPersona(reason.clone()), None);
    }
    (PersonaEffect::Ignored, None) => (None, req.task.clone(), None),
    (PersonaEffect::Native { .. } | PersonaEffect::Hint { .. }, None) => {
        unreachable!("subagent==None only ever produces Ignored effect")
    }
};

// 5. 真实 spawn — 返 Ok 后才能产 Native applied (R3 A2)
let conn_id = spawner.spawn(
    parent_connection_id,
    req.agent_type,
    Some(working_dir),
    preferred_mode_id,
    preferred_config_values,
    launch_option,
).await?;  // 失败 → SpawnerError → Err 通路,不挂 applied

// 6. Native applied 在此产 (spawn 真成功后)
let applied_persona_at_spawn: Option<AppliedPersona> = match (&effect, req.subagent_type.as_deref()) {
    (PersonaEffect::Native { .. }, Some(name)) => Some(AppliedPersona::Native { name: name.into() }),
    (PersonaEffect::Ignored, Some(name)) => Some(AppliedPersona::IgnoredUnsupportedCli { name: name.into() }),
    _ => None,
};

// 7. 首轮 prompt 发送 — 返 Ok 后才能产 Hint applied (R3 A2)
//    send_prompt_linked_for_delegation 在外层作处调用;它返 Ok 后,才基于 effect 产 Hint。
//    完整链见 broker.rs::start_delegation。
//    applied_persona 总体规则:
//      spawn Ok 后:  Native | IgnoredUnsupportedCli | None
//      send  Ok 后:  拼上 Hint | 不变
//      任一步 Err:   applied = None, DelegationOutcome::Err 抛到上层
```

**关键变化**:broker 不再按 `match (agent_type, subagent)` 展开 CLI 内部参数(home / 文件名 / frontmatter 规则),仅消费 `PersonaEffect` 枚举。未来上游 wrapper 合入真人格 env 时,**只改 Claude/Codex 的 provider impl**(返回 `Native{ClaudePersonaEnv(name)}` 而不是 `Hint{preamble}`),broker 一行不改。

## Data Models

**Wire changes**:
- `delegate_to_agent.inputSchema.properties` 加 `subagent_type: string`(optional)。description 里嵌入占位符 `<<PERSONA_LISTS>>`。
- `DelegationRequest` 加 `subagent_type: Option<String>`(`#[serde(default, skip_serializing_if = "Option::is_none")]`)。
- `DelegationSuccess` / `DelegationTaskReport` 加 `applied_persona: Option<AppliedPersona>` 字段(R2 A4):

```rust
/// Outcome-level effective state of persona nomination. UI SHALL consume this
/// (NOT raw_input.subagent_type) for its primary persona label so unsupported
/// CLIs don't display as "applied". **Three variants only (R3 F2 删除 Failed)**:
/// 人格解析/spawn/send 失败均走既有 `DelegationOutcome::Err.wire_code` 通道,
/// UI 拼接 wire_code + raw_input.subagent_type 展示,不扩 Err payload。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AppliedPersona {
    /// Kiro real-persona path: `--agent <name>` reached kiro-cli argv
    /// **AND `spawner.spawn` returned Ok** (R3 A2 时机修正).
    Native { name: String },
    /// Claude/Codex best-effort text hint: preamble prepended
    /// **AND `send_prompt_linked_for_delegation` returned Ok** (R3 A2 时机修正).
    Hint { name: String },
    /// Unsupported CLI silently dropped the request; delegation succeeded without persona.
    IgnoredUnsupportedCli { name: String },
    // No Failed variant — R3 F2 删除。失败信息完全依赖外层 DelegationOutcome::Err。
}
```

- 新 error variant `DelegationError::InvalidPersona(String)` → wire code `invalid_persona`。
- **Err payload 不扩**(R3 F2 采纳):无需新增 `DelegationOutcome::from_err_with_applied`;现有 `from_err(err, child_conversation_id)` 即可。UI 将 `Err.code` 与 `raw_input.subagent_type` 在前端层拼接展示为 `requested: @<name> → <error>`,旧客户端完全兼容(旧客户端已知 raw_input,已知 error 字段)。

**DB 变化**:**无**。人格名不入 DB。SSOT 分家:
- **Kiro**:`--agent <name>` 一次性 argv,kiro-cli 内部 session 元数据自行 resume(codeg 不代管;kiro-cli resume 后是否保持人格是 Kiro 侧责任,codeg 不承诺——executor 必跑 Requirement 7.1 process-death e2e 验行为并记 Update Log)。
- **Claude/Codex**:preamble 已 prepend 到首轮 task,首轮 message 在 conversation 表里落库。**包装层 `session/resume` 时是否自然 replay 首轮 — `unverified: to be confirmed by executor via Requirement 7.2`**。若 wrapper 不 replay 首轮,恢复后子会话上下文就不含 preamble;这属于 wrapper 内部行为,codeg 不代管、不承诺自动检测/修复(R3 A1 降级方案):`applied_persona` 只描述**首次启动**的状态,resume 后不重新计算;UI 若在 resume 后重渲染须以「首次已应用/恢复未知」形式表达,不得暗示仍在生效。

这也意味着 `spawn_for_resume` 不需要重新拿 `subagent_type`,签名无需扩,这是 Requirement 7 的实现方案。

## Error Handling

**错误码矩阵**(四种输入错误归入同一稳定 wire code,重试语义唯一):

| Scenario | Layer | wire code | 处理 & 主 AI 应对方式 |
|---|---|---|---|
| `subagent_type` 字段类型错(number / array) | listener | 无 (视为 absent) | tracing::warn,`DelegationRequest.subagent_type = None`,不失败 |
| 名称语法不合(含 `.` `/` `\` 或非 allowlist、长度超 64) | broker 预校 | `invalid_persona` | 主 AI 修名重试 |
| Claude/Codex persona 文件不存在 | persona::resolve_preamble | `invalid_persona` | 同上 |
| Claude/Codex persona 文件非 UTF-8 | persona::resolve_preamble | `invalid_persona` | 同上 |
| Claude/Codex persona 文件超 200 KiB | persona::resolve_preamble | `invalid_persona` | 同上(不做上下文预算,交下游模型自行 handling) |
| Claude/Codex persona canonical path 逃出预期根(symlink escape) | persona::resolve_preamble | `invalid_persona` | 同上 |
| Claude/Codex persona body 为空(frontmatter-only) | persona::resolve_preamble | `invalid_persona` | 同上 |
| Kiro persona 文件不存在 | connection.rs `verify_kiro_selected_agent_exists`(既有) | `spawn_failed` | 保留现行行为(kiro-cli 自校验 → codeg 相信它) |
| Kiro persona 名称合语法但 kiro-cli 自己抛错 | connection.rs launch 层 | `spawn_failed` | 同上 |
| 未识别 CLI 传了 subagent_type | broker | 无 (success + note) | 静默忽略 + tracing::info + note 挂 `DelegationSuccess.text` |
| Concurrent fan-out 不同人格互相污染 | 天然由 per-call `LaunchOption` 与 resolve_preamble 无共享可变态保证 | — | R7 单元测试断言 |

**统一重试语义**:persona 输入错误(名称/文件/内容)均为 `invalid_persona`,主 AI 看到就一件事:修名重试;kiro-cli 自身启动失败才是 `spawn_failed`(主 AI 看到:重试或换一家)。两类错误码区分清楚。

## Testing Strategy

- **TDD red → green**:每个 requirement 一条 red 测试先走。
- **broker 单元测试**(用 MockSpawner,不起真进程):
  - R2.1: `agent_type=Kiro + subagent_type=Some("x")` → `MockSpawner::spawn_args.last().launch_option == Some(LaunchOption::KiroPersona("x"))`
  - R2.3: panel `env_json[KIRO_AGENT]=A` + `subagent_type=B` → merge 后 `runtime_env["KIRO_AGENT"] == B`
  - R3.2: `agent_type=ClaudeCode + subagent_type=Some(name)` + 人格文件存在 → send_prompt_linked_for_delegation 的 `task` 首段匹配 preamble 特征字符串
  - R3.3: 人格文件不存在 / 非 UTF-8 / 超上限 / body 空 → 均返回 `DelegationError::InvalidPersona` + wire code `invalid_persona`
  - R3.5: `agent_type=ClaudeCode` 分支 `launch_option` 必须 None(互斥)
  - R3-name-grammar: 传 `..`、`foo/bar`、`a.b`、64+ 字符名称 → 全 reject,`invalid_persona`,不触碰文件系统
  - R4.1-4.3: `agent_type=Gemini + subagent_type=Some("x")` → launch_option=None,preamble 未读,`DelegationSuccess.text` 尾行有 note
  - R6.1-6.2: legacy 请求(无 subagent_type)→ 与本 spec 前的调用行为字节级一致(MockSpawner 记录对比)
  - R7.2: 两条并发 spawn,不同 name,`MockSpawner::spawn_args` 两条记录的 launch_option 互不污染
  - R7.4: `spawn_for_resume` 签名无 launch_option 参数(编译期契约)
  - R8.1: mock `$HOME` 到某目录,persona 读取指向该目录下 `.claude/agents/`,与其它 env 无关
- **connection.rs 单元测试**(既有 `kiro_launch_args` 组合矩阵)追加一条:runtime_env 里 KIRO_AGENT=`persona-abc` → args 含 `--agent persona-abc`(既有覆盖率 87%,补一条 per-call 语义证据即可)。
- **persona.rs 单元测试**:
  - frontmatter 剥离 round-trip:BOM / CRLF / LF-only / 未闭合 / 空 body / frontmatter-only 六种输入
  - 200 KiB 上限:临界值 + 1 字节 = TooLarge;边界 - 1 字节 = Ok
  - Symlink escape:mock 一个 symlink 指向 `<home>/.claude/agents/../../secret` → PathEscape
  - Name grammar:`is_valid_persona_name` 单跑,覆盖 `.`、`/`、`\`、空、65 字符、UTF-8 多字节
- **e2e 手工验证**(不入 CI,与 requirements.md "Verified once by" 五条对应):详见该文件。

## Correctness Properties

### Property 1: `subagent_type` 缺省时零副作用

For any `DelegationRequest` r where `r.subagent_type.is_none()`, THE broker SHALL invoke `ConnectionSpawner::spawn` with `launch_option == None` AND SHALL forward `r.task` verbatim(no preamble prepended)AND SHALL NOT emit any `[note]` line into `DelegationSuccess.text`.

**Validates: Requirements 6.1, 6.2**

### Property 2: per-call 覆盖 panel 默认(Kiro path)

For any `agent_type == Kiro` and any `subagent_type == Some(name)` where `is_valid_persona_name(name) == true`, the post-merge `runtime_env["KIRO_AGENT"]` value SHALL equal `name`, regardless of what `agent_setting.env_json[KIRO_AGENT]` contains.

**Validates: Requirements 2.1, 2.3**

### Property 3: Preamble 与 launch 路径互斥

For any `DelegationRequest` r with `r.subagent_type == Some(_)`, IF `r.agent_type ∈ {ClaudeCode, Codex}`, THEN the broker's derived `launch_option` SHALL be `None`; IF `r.agent_type == Kiro`, THEN the broker's derived `prepended_task` SHALL equal `r.task`(no preamble prepend).

**Validates: Requirements 3.5**

### Property 4: 未支持 CLI 静默不阻塞

For any `agent_type ∉ {Kiro, ClaudeCode, Codex}` and any `subagent_type == Some(name)`, the delegation SHALL follow the same success/failure path it would have taken with `subagent_type = None`, with at most a `[note]` appended to `DelegationSuccess.text` on the success branch.

**Validates: Requirements 4.1, 4.2**

### Property 5: 并发 fan-out 人格隔离

For any two concurrent `delegate_to_agent` calls with `(agent_type_a, subagent_type_a)` and `(agent_type_b, subagent_type_b)`, the per-call `launch_option`(if applicable)and prepended task(if applicable)of each child SHALL depend ONLY on that child's own `(agent_type, subagent_type)` — no cross-child mutation.

**Validates: Requirements 7.1, 7.2**

### Property 6: Persona name grammar & canonical containment

For any `name` where `is_valid_persona_name(name) == true`(即 `name ∈ [A-Za-z0-9_-]{1,64}`), `persona::resolve_preamble(ct, name, home)` returns either `Ok(_)` or a `PersonaError` variant OTHER than `InvalidName`. For any `name` failing that grammar, it returns `Err(InvalidName(_))` and SHALL NOT open any file. For any `Ok(body)` returned, the underlying file's canonical path (after symlink resolution) SHALL be a direct child of the canonical `<home>/.<agent>/agents/` directory (verified before body is read).

**Validates: Requirements 3.3, 3-name-grammar.1-3, 8.1**

### Property 7: Config-root canonical resolution (honors CLAUDE_CONFIG_DIR / CODEX_HOME)

For any `DelegationRequest` and any concurrent delegation state, `persona::resolve_preamble_at` SHALL accept an already-canonicalized `expected_root: &Path` provided by the broker layer, which the broker SHALL derive by calling `crate::parsers::claude::resolve_claude_config_dir().join("agents")` for ClaudeCode and `crate::parsers::codex::resolve_codex_home_dir().join("agents")` for Codex — both helpers honor the project's canonical env conventions (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) with fallback to `dirs::home_dir()`. No request-level, session-level, or conversation-level identity SHALL influence the resolution.

**Validates: Requirements 8.1, 8.2**

## Risks & Trade-offs

- **⚠️ Preamble 不是真人格**:Claude/Codex 走的路径丢 frontmatter 高阶字段(权限模式 / 工具白名单)。已在 wire 契约、UI 标签、文档三处明写 best-effort,不主张等价于 Kiro 真人格。上游 PR 合入后升级到真人格(不在本 spec 范围)。
- **⚠️ merge 顺序不变式**:`launch_option` 翻译成 `runtime_env["KIRO_AGENT"]` 必须在 `apply_kiro_env_policy` 之前,否则 policy 会剥掉 `KIRO_AGENT`。当前 `spawn_child_inner` merge 天然在 `spawn_agent_connection`(内部调 policy)之前,顺序自然满足,但 executor 落地时必须显式声明这个顺序不变式,加一条注释+单测。
- **⚠️ Kiro 人格存在性校验在 merge 之后**:`verify_kiro_selected_agent_exists` 已在 kiro_launch_args 之前跑,天然在 merge 之后。executor 必须验证:若 per-call 覆盖后校验拿到新 name,而 panel 里配的是老 name,校验读的是**新 name**(post-merge runtime_env),不是老 name——单元测试断言。
- **⚠️ codex-acp `DISABLE_MCP_CONFIG_FILTERING`**:codex-acp 有过默默过滤 codeg 注入 env 的历史(`apply_codex_env_policy` 已修)。本 spec 短期不给 Codex 侧加新 env(走 preamble),没这个风险。长期上游 PR 加 `CODEX_AGENT` 时必须重跑该 filter gate 测试。
- **⚠️ subagent-transcript capability 混淆**:见 Glossary(requirements.md) — 二者语义不同,不复用,不冲突。executor 若发现自己在动 `subagent-transcript` 相关代码,一定是走错方向。
- **⚠️ 上游 0.22.x 合并**:`git status` 显示 `M src-tauri/Cargo.toml`,近期 commit `Merge upstream/main 0.22.2 into feat/kiro-agent`。落地前 executor 必须先 `git fetch upstream && git log HEAD..upstream/main -- src-tauri/src/acp/delegation` 确认 spawner trait / tool_schema 无上游并发改动。
- **⚠️ `serde_yaml` 依赖 — R3 recon 确认存在**:`src-tauri/Cargo.toml:100 serde_yaml = "0.9"`。但 spec 仍选择手写 fence state machine(不调 serde_yaml),因为只需匹配 fence 不需解 YAML。依赖 gate 退休,手写 parser 决策保留。
- **⚠️ Server-mode 单主体信任**:codeg-server 模式共享一个 `CODEG_TOKEN`,persona 文件从进程 `$HOME` 读——所有已认证 caller 共享同一 persona 池。这与 codeg-server 其它能力对齐,不是本 spec 引入的新问题。多租户 persona 隔离若未来需要,是独立 spec。

## Update Log

- 2026-08-03 · 初稿落盘 · 等跑 spec-cross-review R1 / R2 / R3
- 2026-08-03 · R1(codex)采纳修订:详见 requirements.md 尾部 Update Log。design 侧同步重写:
  - §Overview:Claude/Codex 明写 best-effort;`per_call_env_overrides` → 类型化 `LaunchOption` 枚举
  - §Corrected Goal:新增 typeless→typed 收窄条 + R7.3 SSOT 修正条 + R8 服务器边界条
  - §Decision Record:补上 Alternatives (C) 拒绝 typeless env override 的理由
  - §Components §3-6:LaunchOption 类型定义 + is_valid_persona_name 校验 + `spawn` 签名(只扩 spawn,resume 不变) + persona.rs 重写包含 symlink safety / BOM / CRLF / 未闭合 / 空 body handling
  - §Error Handling:错误码矩阵重写,wire code 统一 `invalid_persona`
  - §Correctness Properties:P6 重写为 name grammar + canonical containment;新增 P7 single-tenant home resolution
  - §Risks:补 `serde_yaml` 依赖未验证 + server-mode 单主体信任
- 2026-08-03 · R1 自动回写了 4 个 review 字段(review_rounds_done=1 / last_review_status=NEEDS_CHANGES / last_review_p0=3 / last_updated)

- 2026-08-03 · R2(codex)三步过筛后采纳落 design 正文:
  - **R2 A1 方向问题 → 驳回**(用户 2026-08-04 明确要求三家都做),仅采纳其中 R3.7 disclaimer(已在 requirements.md)。
  - **R2 A2 broker 承担 provider 解析 → 采纳**:§6 broker 翻译层重写。引入 `PersonaEffect` 枚举 + `PersonaCapability` trait;broker 只调 provider,不识别 CLI 差异。未来上游 wrapper 合入真人格 env 时只改 provider 一处。
  - **R2 A3 requirements 残留 effect map → 采纳**(已在 requirements.md)。
  - **R2 A4 UI 消费 outcome-level `applied_persona` → 采纳**:§Data Models 加 `AppliedPersona` tagged enum(四态 Native/Hint/IgnoredUnsupportedCli/Failed);broker 每分支产 applied 一起随 DelegationSuccess/Err 落。UI 不消费 raw_input.subagent_type。
  - **R2 A5 Resume 断言未证实 → 采纳**:§Data Models 里 Claude/Codex resume 语义改为 `unverified: to be confirmed by executor via Requirement 7.2`;若不 replay,applied_persona 报 Failed 而非 Hint(已在 requirements.md AC7.2)。
  - **R2 F1 错误码矛盾 → 采纳**(已在 requirements.md · Success State 里语义分家)。
  - **R2 F2 未闭合 frontmatter 硬失败 → 采纳**:§5 Persona resolver 加 `PersonaError::MalformedFrontmatter` 变体,未闭合确定性失败,不宽容降级为 body。
  - **R2 F3 200 KiB vs prompt 预算 → 改法保留**:硬 IO 上限,不承诺 prompt 预算,不做组合检查。
  - **R2 F4 symlink safety 算法 → 采纳**:§5 §2-4 重写。用 `canonical.parent() == Some(canonical_root)` direct-child 判定(替 starts_with);open canonical path 而非 candidate(TOCTOU);`BufReader::take(200*1024+1)` 硬读取上限(替 metadata 预判)。

- 2026-08-03 · R3(codex)三步过筛后采纳落 design 正文:
  - **R3 A1 → 采纳降级方案**:R7.3 已改(见 requirements.md)。design DataModels §DB变化 一段的 Claude/Codex 「wrapper 自然 replay」乐观断言在 R2 A5 时已改为 unverified,现在 R7.3 进一步明写「不承诺自动检测/修复,applied_persona 只描述首次启动」——与 design 一致,无需再改 design 正文。
  - **R3 A2 → 采纳**:§6 broker 代码骨架重写。applied_persona::Native 在 spawn Ok 后产,Hint 在 send Ok 后产,任一步 Err 都走 Err 通路不挂 applied。AppliedPersona 定义在 Data Models 段也同步更新 doc-comment 时机说明。
  - **R3 F1 → 采纳**:§6 骨架顺序改为「先 provider capability → 再名称校 → 再 provider 内部解 HOME 读文件」。unsupported CLI 与 Kiro 都不碰文件系统,无关条件不会阻断。骨架伪代码里显式 `provider.supports_persona()` gate。
  - **R3 F2 → 采纳大幅收窄**:AppliedPersona 从四态变三态,删 Failed 变体。design Data Models 段的 Err payload 扩展描述改为「不扩」,`DelegationOutcome::from_err_with_applied` 无需新增。失败完全依赖外层 Err.wire_code。
  - **R3 P2.1「五条→六条」**:已在 requirements.md 修正。
  - **R3 P2.3 `<<PERSONA_LISTS>>` 无生成方**:**驳回**——生成方是 companion tools/list handler 里 append_custom_agents_to_delegate_enum 附近的注入点(Q2 决策明确),评审误读。
  - **R3 P2.4 TOCTOU-safe 完全消除的表述过强 → 采纳**:§5 §2 断言符号安全性质的措辞,在 direct-child 段末补充「本方法只能降低 symlink 换链风险,不能完全消除同主体并发竞态」的免责,与 R1 A2 单主体前提对齐。


- 2026-08-04 · executor SUB(stage 8 e2e 收尾)· wire e2e 4 条 + 手工用例 5 条(观察记录):
  - **A 部分自动化落地**:`src-tauri/tests/delegation_e2e_windows.rs` 追加 stage-8 段(4 条 test · 439 行)· 覆盖 wire → listener 解析 → broker 分派 → spawn args + status/outcome 完整闭环:
    - `stage8_wire_kiro_native_persona_reaches_spawn_and_status`(Kiro Native · wire 半段)
    - `stage8_wire_unsupported_cli_silently_downgrades_with_note`(Gemini + `subagent_type` 静默降级 · `[note]` 挂 text)
    - `stage8_wire_invalid_persona_fails_before_spawn`(Claude Code + 缺席 persona · `invalid_persona` · spawn_args 空 · R3-F3)
    - `stage8_wire_persona_name_grammar_rejected`(`foo/bar` / `a.b` / 65-char 三 case · 每 case fresh listener + mock · spawn_args 空 · R3-F1)
  - **既有 e2e 2 条零回归**:`end_to_end_named_pipe_happy_path` + `end_to_end_named_pipe_back_to_back_requests` 仍绿(6/6 total)
  - **4 次负向 mutation 逐条验红 · 均已还原并复验绿**:
    - Mutation A(unsupported CLI 分支 `IgnoredUnsupportedCli` intent 改 `None`)→ #4 转红(`applied_persona.kind == "ignored_unsupported_cli"` 变 Null)
    - Mutation B(注掉 grammar `return report_err` short-circuit)→ #6 转红(wire code 变 `spawn_failed`,证 fall-through)
    - Mutation C(`spawner.spawn(...launch_option_pending)` → `None`)→ #1 转红(`SpawnCallArgs.launch_option` 变 None)
    - Mutation D(`PersonaEffect::Failed` 分支静默降级为 `(None,None,None)` 不 return)→ #5 转红(证 R3-F3「必须硬失败,不许 silent-degrade」)
    - 每次 mutation 只改 1 处、跑相关 test 转红后立刻编辑还原,末次全绿(6 passed / 0 failed)· 证据锚点:变更 tag `MUTATION-{A,B,C,D} stage-8`(还原后 grep 应零命中)
  - **B 部分手工用例 5 条**:`.agent-workspace/.archive/2026-08-04/delegate-persona-passthrough/e2e-manual-2026-08-04.md`
    - 全部 unverified · 原因:SUB 环境无桌面 Tauri host / 无 GUI 观察卡片渲染 / 无法安全 kill 用户机器上的真进程
    - 环境侦察显示 kiro-cli / claude-agent-acp / codex-acp 三家 wrapper 均在 PATH,`~/.kiro/agents`, `~/.claude/agents`, `~/.codex/agents` 均存在且含用户实用人格(**探针名统一 `codeg-e2e-probe` 隔离,不覆盖用户 `plan-reality-recon`**)
    - 手工报告为每条用例记录了完整可复用剧本(fixture 落盘命令 + delegation 操作步骤 + 观察点 + 清理)
    - R7.1/R7.2 观察策略基于代码级分析预写入:R7.1(a) 大概率 no(`spawn_for_resume` 签名不带 `LaunchOption` · argv 只带 `--session` 无 `--agent`)· (c) UI 卡首次值应保留(spawn-Ok 定并存入 running_task,不因 resume 清)· R7.2 官方 wrapper stateless,恢复后大概率丢 marker
  - **A 层补强 B 层证据链**:每条手工用例都对应 A 层单元/集成 test 的 broker 侧证据(broker_persona P5 concurrent · broker_persona_hint claude/codex hint · persona_merge_order argv 翻译)。真进程观察等于把已锁的链再多一步验证到 OS 层,若发生偏离先看 A 层是否被破坏
  - **验证输出(全部真跑)**:
    - `cargo check --features test-utils --tests --message-format=short → EXIT=0`
    - `cargo check --no-default-features --bin codeg-mcp --message-format=short → EXIT=0`
    - `cargo test --features test-utils --test delegation_e2e_windows → 6 passed; 0 failed; EXIT=0`
    - `cargo test --features test-utils --test broker_persona → 5 passed`
    - `cargo test --features test-utils --test broker_persona_hint → 3 passed`
    - `cargo test --features test-utils --test listener_subagent_type_wire → 5 passed`
    - `cargo test --features test-utils --test persona_merge_order → 7 passed`
    - `cargo test --features test-utils --test persona_stage3 → 12 passed`
    - `cargo test --features test-utils --test persona_lists_injection → 21 passed`
    - 6 集成 crate 共 **59 passed / 0 failed / 0 ignored**(既有 53 + 新加 4 = 57 相关 + 既有 e2e 2 = 59;无回归)
  - **硬约束合规**:未改后端生产代码(broker.rs/manager.rs/listener.rs/persona.rs 零生产改动 · mutation 只在验证窗口存在)· 未改前端 · 未改 requirements.md/design.md 契约段(仅 Update Log + Known Limitations 追加)· UDS 侧未加同源 test(dispatch 建议只加 Windows;若 Unix 侧需要可原封移植 harness)· 未覆盖用户真实人格
  - **Review Findings**:任务书 dispatch draft 关于「若 SUB 环境不便真跑 → unverified」的建议在本机部分不成立(CLI 都可用),但**「需真起 Tauri GUI + 真进程 kill + 人眼观察卡片」这个组合本 SUB 环境无法自动化**,故 B 部分整体 unverified 是唯一诚实结论。手工报告已为用户下轮真跑准备好完整剧本 · 三条预期观察基于代码级分析给出,可作为真跑时的对照 hypothesis

## Known Limitations

以下项属于「codeg 不控制的下游行为」或「本 spec 不承诺范围」,受影响的 UI 语义/文档需据此设计,不作为 spec 失败判据。

### R7.1 · Kiro 子进程死亡后恢复的人格状态(kiro-cli 内部行为)

- **codeg 侧机制**:`ConnectionSpawner::spawn_for_resume` 签名**不接** `LaunchOption`(R7.4),恢复 argv 仅带 `--session <id>`,**不重传** `--agent <name>`。
- **kiro-cli 侧行为(codeg 不承诺)**:kiro-cli 是否把首次的 `--agent` 状态写进 session state 决定恢复后是否仍表现原人格。**若不写(自然行为)** → 恢复回退默认人格。这是上游实现细节,codeg 无法探测更无法控制。
- **UI 呈现策略**:codeg 前端 `applied_persona` 是 spawn-Ok 时定并存进 running_task,恢复回合不清空 → **UI 卡片仍显示首次值**(不因 resume 改标签)。用户看到的是"首次已应用 `@X`",不是"恢复后仍在 `@X`"。若需精细区分"首次应用" vs "恢复后未知",需上游 wrapper 提供探测能力,当前不做。
- **验收状态**:已由 stage-8 手工报告(`e2e-manual-2026-08-04.md`)记录观察剧本 · 待用户 GUI 环境真跑复核 · 若观察到与本节预期不一致,追加一行说明,不改架构。

### R7.2 · Claude Code / Codex wrapper 冷恢复行为(wrapper 内部行为)

- **codeg 侧机制**:Claude Code / Codex 走 Hint 路径,codeg 在**首轮 send** 时把 preamble 前置到 prompt · wrapper 侧 session state 由 wrapper 全权掌管。
- **wrapper 侧行为(codeg 不承诺)**:`@agentclientprotocol/claude-agent-acp` / `codex-acp` 是 stateless wrapper,不持久化会话历史 · 恢复后**大概率丢首轮 marker / preamble**(wrapper 不 replay 首轮)。
- **UI 呈现策略**:同 R7.1 · `applied_persona.kind == "hint"` 是 send-Ok 时定的首次值,恢复回合不清空 · UI 卡片仍标 `best-effort · @X`。**若真跑观察到 wrapper 不 replay 首轮** → 属预期内的 wrapper 限制,不修改 codeg 侧。
- **长期升级路径**:待上游 wrapper 提供 `CLAUDE_ACP_AGENT` / `CODEX_AGENT` env 变量原生承载人格,则本 spec Hint tier 升级为 Native tier(见 `LaunchOption` 变体注释)。这是 tasks.md 9.6 记录的 tech-debt 追加任务,不阻塞本 spec 交付。
